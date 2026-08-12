import {
  SHAPE_CATALOG,
  getShapeMetadata,
  normalizeShapeParameters,
  type ShapeKey,
  type ShapeParameters
} from "../shapes";

export interface ShapeMenuSelection {
  readonly key: ShapeKey;
  readonly parameters: ShapeParameters;
}

export interface ShapeMenuOptions {
  readonly initialKey: ShapeKey;
  readonly initialParameters: Readonly<Partial<Record<ShapeKey, ShapeParameters>>>;
  readonly onSelect: (selection: ShapeMenuSelection) => void;
  readonly onParametersInput: (selection: ShapeMenuSelection) => void;
  readonly onDraw: () => void;
}

export class ShapeMenu {
  private readonly toggle: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly optionsHost: HTMLElement;
  private readonly parametersHost: HTMLElement;
  private readonly drawButton: HTMLButtonElement;
  private readonly callbacks: ShapeMenuOptions;
  private readonly buttons = new Map<ShapeKey, HTMLButtonElement>();
  private readonly values = new Map<ShapeKey, ShapeParameters>();
  private selectedKey: ShapeKey;
  private destroyed = false;
  private readonly cleanup: Array<() => void> = [];

  constructor(options: ShapeMenuOptions) {
    this.callbacks = options;
    this.selectedKey = options.initialKey;
    this.toggle = getElement("shape-menu-toggle");
    this.panel = getElement("shape-menu");
    this.closeButton = getElement("shape-menu-close");
    this.optionsHost = getElement("shape-options");
    this.parametersHost = getElement("shape-parameters");
    this.drawButton = getElement("draw-shape");

    for (const metadata of SHAPE_CATALOG) {
      this.values.set(
        metadata.key,
        normalizeShapeParameters(metadata.key, options.initialParameters[metadata.key])
      );
      if (metadata.key === "custom") continue;
      const button = createShapeButton(metadata.key, metadata.label);
      this.buttons.set(metadata.key, button);
      this.optionsHost.append(button);
      this.listen(button, "click", () => this.select(metadata.key));
      this.listen(button, "keydown", (event) => this.handleOptionKeydown(event, metadata.key));
    }

    this.listen(this.toggle, "click", () => this.setOpen(this.panel.hidden));
    this.listen(this.closeButton, "click", () => this.setOpen(false));
    this.listen(this.drawButton, "click", () => {
      this.setOpen(false);
      this.callbacks.onDraw();
    });
    this.listen(document, "pointerdown", (event) => {
      const target = event.target;
      if (
        !this.panel.hidden &&
        target instanceof Node &&
        !this.panel.contains(target) &&
        !this.toggle.contains(target)
      ) {
        this.setOpen(false);
      }
    });
    this.listen(document, "keydown", (event) => {
      if (event instanceof KeyboardEvent && event.key === "Escape" && !this.panel.hidden) {
        event.preventDefault();
        this.setOpen(false);
        this.toggle.focus();
      }
    });
    this.renderSelection();
  }

  setOpen(open: boolean): void {
    if (this.destroyed) return;
    this.panel.hidden = !open;
    this.toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      const activeKey = this.buttons.has(this.selectedKey)
        ? this.selectedKey
        : this.optionKeys()[0];
      if (activeKey) window.requestAnimationFrame(() => this.focusOption(activeKey));
    }
  }

  setSelection(key: ShapeKey, parameters: ShapeParameters): void {
    if (this.destroyed) return;
    this.selectedKey = key;
    this.values.set(key, normalizeShapeParameters(key, parameters));
    this.renderSelection();
  }

  getSelection(): ShapeMenuSelection {
    return {
      key: this.selectedKey,
      parameters: this.values.get(this.selectedKey) ?? {}
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const dispose of this.cleanup.splice(0)) dispose();
  }

  private select(key: ShapeKey): void {
    if (key === "custom") return;
    const changed = this.selectedKey !== key;
    this.selectedKey = key;
    this.renderSelection();
    if (changed) this.callbacks.onSelect(this.getSelection());
    this.setOpen(false);
  }

  private renderSelection(): void {
    const rovingKey = this.buttons.has(this.selectedKey)
      ? this.selectedKey
      : this.optionKeys()[0];
    for (const [key, button] of this.buttons) {
      button.setAttribute("aria-selected", String(key === this.selectedKey));
      button.tabIndex = key === rovingKey ? 0 : -1;
    }
    this.parametersHost.replaceChildren();
    const metadata = getShapeMetadata(this.selectedKey);
    const parameters = this.values.get(this.selectedKey) ?? metadata.defaultParameters;
    for (const parameter of metadata.parameters) {
      const wrapper = document.createElement("div");
      wrapper.className = "parameter-control";
      const inputId = `shape-parameter-${parameter.key}`;
      const label = document.createElement("label");
      label.htmlFor = inputId;
      label.textContent = parameter.label;
      const output = document.createElement("output");
      output.htmlFor = inputId;
      const input = document.createElement("input");
      input.id = inputId;
      input.type = "range";
      input.min = String(parameter.min);
      input.max = String(parameter.max);
      input.step = String(parameter.step);
      input.value = String(parameters[parameter.key] ?? parameter.defaultValue);
      const update = (): void => {
        const next = normalizeShapeParameters(this.selectedKey, {
          ...parameters,
          [parameter.key]: Number(input.value)
        });
        this.values.set(this.selectedKey, next);
        output.textContent = formatParameter(Number(input.value), parameter.unit);
        input.setAttribute("aria-valuetext", output.textContent);
        this.callbacks.onParametersInput({ key: this.selectedKey, parameters: next });
      };
      output.textContent = formatParameter(Number(input.value), parameter.unit);
      input.setAttribute("aria-valuetext", output.textContent);
      input.addEventListener("input", update);
      this.cleanup.push(() => input.removeEventListener("input", update));
      wrapper.append(label, output, input);
      this.parametersHost.append(wrapper);
    }
  }

  private handleOptionKeydown(event: KeyboardEvent, key: ShapeKey): void {
    const keys = this.optionKeys();
    const currentIndex = keys.indexOf(key);
    if (currentIndex < 0) return;

    let targetIndex: number | null = null;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        targetIndex = Math.min(keys.length - 1, currentIndex + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        targetIndex = Math.max(0, currentIndex - 1);
        break;
      case "Home":
        targetIndex = 0;
        break;
      case "End":
        targetIndex = keys.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        this.select(key);
        return;
      default:
        return;
    }

    event.preventDefault();
    const targetKey = keys[targetIndex];
    if (targetKey) this.focusOption(targetKey);
  }

  private focusOption(key: ShapeKey): void {
    const target = this.buttons.get(key);
    if (!target) return;
    for (const [candidateKey, button] of this.buttons) {
      button.tabIndex = candidateKey === key ? 0 : -1;
    }
    target.focus();
  }

  private optionKeys(): ShapeKey[] {
    return Array.from(this.buttons.keys());
  }

  private listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void
  ): void;
  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void
  ): void;
  private listen(
    target: Document | HTMLElement,
    type: string,
    listener: EventListener
  ): void {
    target.addEventListener(type, listener);
    this.cleanup.push(() => target.removeEventListener(type, listener));
  }
}

function createShapeButton(key: ShapeKey, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "shape-option";
  button.type = "button";
  button.role = "option";
  button.dataset.shape = key;
  button.setAttribute("aria-label", label);
  button.append(createShapeIcon(key));
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  return button;
}

function createShapeIcon(key: ShapeKey): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const paths: Record<Exclude<ShapeKey, "custom">, string> = {
    circle: "M16 4.5a11.5 11.5 0 1 1 0 23 11.5 11.5 0 0 1 0-23Z",
    rectangle: "M4.5 8h23v16h-23V8Z",
    triangle: "M16 4.5 28 26H4L16 4.5Z",
    pentagon: "M16 3.5 28 12.2 23.4 27H8.6L4 12.2 16 3.5Z",
    hexagon: "m9 4.5 14 0 7 11.5-7 11.5H9L2 16 9 4.5Z",
    spiral: "M16 16c0-3.5 5.8-3.6 6.8.2 1.3 5-4.4 9.7-10 8.1C5.4 22.5 4.2 14.6 8.4 9.1c4.5-5.8 13.4-5.7 18 .1",
    annulus: "M16 3.5a12.5 12.5 0 1 1 0 25 12.5 12.5 0 0 1 0-25Zm0 7a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"
  };
  if (key !== "custom") path.setAttribute("d", paths[key]);
  if (key === "annulus") path.setAttribute("fill-rule", "evenodd");
  svg.append(path);
  return svg;
}

function formatParameter(value: number, unit: string | undefined): string {
  if (unit === "degrees") return `${Math.round(value)}°`;
  if (unit === "ratio") return value.toFixed(2);
  return value.toFixed(2);
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}.`);
  return element as T;
}

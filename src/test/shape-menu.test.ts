import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ShapeMenu } from "../ui/shape-menu";

describe("shape menu keyboard navigation", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <button id="shape-menu-toggle" aria-expanded="false"></button>
      <section id="shape-menu" hidden>
        <button id="shape-menu-close"></button>
        <div id="shape-options"></div>
        <div id="shape-parameters"></div>
        <button id="draw-shape"></button>
      </section>
    `;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("moves roving focus with every supported arrow key and Home or End", () => {
    const menu = createMenu();
    menu.setOpen(true);

    const rectangle = option("rectangle");
    const triangle = option("triangle");
    const circle = option("circle");
    const annulus = option("annulus");
    expect(document.activeElement).toBe(rectangle);

    press(rectangle, "ArrowDown");
    expect(document.activeElement).toBe(triangle);
    expect(triangle.tabIndex).toBe(0);
    expect(rectangle.tabIndex).toBe(-1);

    press(triangle, "ArrowUp");
    expect(document.activeElement).toBe(rectangle);
    press(rectangle, "ArrowRight");
    expect(document.activeElement).toBe(triangle);
    press(triangle, "ArrowLeft");
    expect(document.activeElement).toBe(rectangle);

    press(rectangle, "End");
    expect(document.activeElement).toBe(annulus);
    press(annulus, "Home");
    expect(document.activeElement).toBe(circle);
    expect(rectangle.getAttribute("aria-selected")).toBe("true");
    expect(circle.getAttribute("aria-selected")).toBe("false");

    menu.destroy();
  });

  it("commits the focused option with Enter or Space and remains reachable after custom", () => {
    const onSelect = vi.fn();
    const menu = createMenu(onSelect);
    menu.setOpen(true);

    const rectangle = option("rectangle");
    press(rectangle, "End");
    const annulus = option("annulus");
    press(annulus, "Enter");
    expect(onSelect).toHaveBeenLastCalledWith({
      key: "annulus",
      parameters: { innerRadius: 0.38 }
    });
    expect(getPanel().hidden).toBe(true);

    menu.setOpen(true);
    press(annulus, "Home");
    const circle = option("circle");
    press(circle, " ");
    expect(onSelect).toHaveBeenLastCalledWith({
      key: "circle",
      parameters: { radius: 0.8 }
    });

    menu.setSelection("custom", {});
    menu.setOpen(true);
    expect(document.activeElement).toBe(circle);
    expect(circle.tabIndex).toBe(0);

    menu.destroy();
  });
});

function createMenu(onSelect = vi.fn()): ShapeMenu {
  return new ShapeMenu({
    initialKey: "rectangle",
    initialParameters: {},
    onSelect,
    onParametersInput: vi.fn(),
    onDraw: vi.fn()
  });
}

function option(key: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`[data-shape="${key}"]`);
  if (!element) throw new Error(`Missing option ${key}.`);
  return element;
}

function getPanel(): HTMLElement {
  const panel = document.getElementById("shape-menu");
  if (!panel) throw new Error("Missing shape menu panel.");
  return panel;
}

function press(element: HTMLElement, key: string): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  );
}

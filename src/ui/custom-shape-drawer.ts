import {
  CUSTOM_GRID_SIZE,
  CUSTOM_MIN_ACTIVE_CELLS,
  DEFAULT_GRID_SIZE,
  createMaskFromPolygon,
  retainLargestFourConnectedComponent,
  validateMask,
  type Point2D,
  type ShapeMask
} from "../shapes";

export interface CustomShapeDrawerOptions {
  readonly onApply: (mask: ShapeMask) => void;
  readonly onOpenChange?: (open: boolean) => void;
}

interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

const MIN_POINT_DISTANCE_SQUARED = 9;
const MIN_POLYGON_AREA = 500;
const KEYBOARD_GRID_MIN = 1;
// Keep the drawing interaction at the established 49-step granularity. The
// released polygon is rasterized separately onto the denser custom solver
// grid, so pointer and keyboard use stay manageable without limiting fidelity.
const KEYBOARD_GRID_MAX = DEFAULT_GRID_SIZE;
const KEYBOARD_GRID_DIVISIONS = DEFAULT_GRID_SIZE + 1;
const KEYBOARD_GRID_MIDPOINT = Math.ceil(DEFAULT_GRID_SIZE / 2);

export class CustomShapeDrawer {
  private readonly overlay: HTMLElement;
  private readonly dialog: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly status: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly options: CustomShapeDrawerOptions;
  private readonly cleanup: Array<() => void> = [];
  private points: CanvasPoint[] = [];
  private completedMask: ShapeMask | null = null;
  private drawingPointer: number | null = null;
  private keyboardColumn = KEYBOARD_GRID_MIDPOINT;
  private keyboardRow = KEYBOARD_GRID_MIDPOINT;
  private keyboardTracing = false;
  private returnFocus: HTMLElement | null = null;
  private destroyed = false;

  constructor(options: CustomShapeDrawerOptions) {
    this.options = options;
    this.overlay = getElement("drawing-overlay");
    this.dialog = this.overlay.querySelector<HTMLElement>(".drawing-dialog") ?? this.overlay;
    this.canvas = getElement("drawing-canvas");
    this.status = getElement("drawing-status");
    this.closeButton = getElement("drawing-close");
    this.clearButton = getElement("drawing-clear");
    this.applyButton = getElement("drawing-apply");
    const context = this.canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot create the custom-shape drawing canvas.");
    this.context = context;

    this.listen(this.canvas, "pointerdown", this.handlePointerDown);
    this.listen(this.canvas, "pointermove", this.handlePointerMove);
    this.listen(this.canvas, "pointerup", this.handlePointerUp);
    this.listen(this.canvas, "pointercancel", this.handlePointerCancel);
    this.listen(this.canvas, "keydown", this.handleKeyboard);
    this.listen(this.canvas, "focus", () => {
      if (
        this.canvas.matches(":focus-visible") &&
        !this.completedMask &&
        !this.keyboardTracing
      ) {
        this.renderKeyboardStatus();
      }
      this.render();
    });
    this.listen(this.canvas, "blur", () => this.render());
    this.listen(this.closeButton, "click", () => this.close());
    this.listen(this.clearButton, "click", () => this.clear());
    this.listen(this.applyButton, "click", () => this.apply());
    this.listen(this.overlay, "pointerdown", (event) => {
      if (event.target === this.overlay) this.close();
    });
    this.listen(document, "keydown", (event) => {
      if (!(event instanceof KeyboardEvent) || this.overlay.hidden) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (this.keyboardTracing || this.drawingPointer !== null) {
          this.resetOutline("Outline cleared. Press Space on the grid to start again.");
          this.canvas.focus();
        } else {
          this.close();
        }
      } else if (event.key === "Tab") {
        this.keepFocusInside(event);
      }
    });
    this.render();
  }

  open(): void {
    if (this.destroyed) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.overlay.hidden = false;
    this.options.onOpenChange?.(true);
    this.render();
    window.requestAnimationFrame(() => this.closeButton.focus());
  }

  close(): void {
    if (this.destroyed || this.overlay.hidden) return;
    if (this.drawingPointer !== null) {
      this.canvas.releasePointerCapture(this.drawingPointer);
      this.drawingPointer = null;
    }
    this.overlay.hidden = true;
    this.options.onOpenChange?.(false);
    this.returnFocus?.focus();
    this.returnFocus = null;
  }

  clear(): void {
    this.resetOutline("Draw an outline to begin, or focus the grid for keyboard drawing.");
  }

  private resetOutline(message: string): void {
    if (
      this.drawingPointer !== null &&
      typeof this.canvas.hasPointerCapture === "function" &&
      this.canvas.hasPointerCapture(this.drawingPointer)
    ) {
      this.canvas.releasePointerCapture(this.drawingPointer);
    }
    this.points = [];
    this.completedMask = null;
    this.drawingPointer = null;
    this.keyboardTracing = false;
    this.applyButton.disabled = true;
    this.status.textContent = message;
    this.render();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const dispose of this.cleanup.splice(0)) dispose();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || this.drawingPointer !== null) return;
    event.preventDefault();
    this.keyboardTracing = false;
    this.points = [this.canvasPoint(event)];
    this.completedMask = null;
    this.drawingPointer = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
    this.applyButton.disabled = true;
    this.status.textContent = "Keep dragging around the boundary; release to close it.";
    this.render();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.drawingPointer !== event.pointerId) return;
    event.preventDefault();
    const point = this.canvasPoint(event);
    const previous = this.points[this.points.length - 1];
    if (!previous || squaredDistance(previous, point) >= MIN_POINT_DISTANCE_SQUARED) {
      this.points.push(point);
      this.render();
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.drawingPointer !== event.pointerId) return;
    event.preventDefault();
    this.canvas.releasePointerCapture(event.pointerId);
    this.drawingPointer = null;
    const point = this.canvasPoint(event);
    const previous = this.points[this.points.length - 1];
    if (!previous || squaredDistance(previous, point) >= MIN_POINT_DISTANCE_SQUARED) {
      this.points.push(point);
    }
    this.finishOutline();
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    if (this.drawingPointer !== event.pointerId) return;
    this.drawingPointer = null;
    this.keyboardTracing = false;
    this.points = [];
    this.completedMask = null;
    this.applyButton.disabled = true;
    this.status.textContent = "Drawing cancelled. Try the outline again.";
    this.render();
  };

  private readonly handleKeyboard = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        this.moveKeyboardCursor(-1, 0);
        break;
      case "ArrowRight":
        event.preventDefault();
        this.moveKeyboardCursor(1, 0);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.moveKeyboardCursor(0, -1);
        break;
      case "ArrowDown":
        event.preventDefault();
        this.moveKeyboardCursor(0, 1);
        break;
      case " ":
        event.preventDefault();
        this.placeKeyboardVertex();
        break;
      case "Enter":
        if (!this.keyboardTracing) return;
        event.preventDefault();
        this.closeKeyboardOutline();
        break;
    }
  };

  private moveKeyboardCursor(deltaColumn: number, deltaRow: number): void {
    this.keyboardColumn = clampInteger(
      this.keyboardColumn + deltaColumn,
      KEYBOARD_GRID_MIN,
      KEYBOARD_GRID_MAX
    );
    this.keyboardRow = clampInteger(
      this.keyboardRow + deltaRow,
      KEYBOARD_GRID_MIN,
      KEYBOARD_GRID_MAX
    );
    this.renderKeyboardStatus();
    this.render();
  }

  private placeKeyboardVertex(): void {
    const point = this.keyboardCanvasPoint();
    if (!this.keyboardTracing) {
      this.points = [point];
      this.completedMask = null;
      this.keyboardTracing = true;
      this.applyButton.disabled = true;
      this.renderKeyboardStatus();
      this.render();
      return;
    }

    const previous = this.points[this.points.length - 1];
    if (!previous || squaredDistance(previous, point) >= MIN_POINT_DISTANCE_SQUARED) {
      this.points.push(point);
    }
    this.renderKeyboardStatus();
    this.render();
  }

  private closeKeyboardOutline(): void {
    const point = this.keyboardCanvasPoint();
    const previous = this.points[this.points.length - 1];
    if (!previous || squaredDistance(previous, point) >= MIN_POINT_DISTANCE_SQUARED) {
      this.points.push(point);
    }
    this.keyboardTracing = false;
    this.finishOutline();
  }

  private keyboardCanvasPoint(): CanvasPoint {
    return {
      x: (this.keyboardColumn / KEYBOARD_GRID_DIVISIONS) * this.canvas.width,
      y: (this.keyboardRow / KEYBOARD_GRID_DIVISIONS) * this.canvas.height
    };
  }

  private renderKeyboardStatus(): void {
    const position =
      `Cursor column ${this.keyboardColumn} of ${KEYBOARD_GRID_MAX}, ` +
      `row ${this.keyboardRow} of ${KEYBOARD_GRID_MAX} from the top.`;
    this.status.textContent = this.keyboardTracing
      ? `${position} ${this.points.length} corners placed. ` +
        "Press Space to place this corner, Enter to close, or Escape to clear."
      : `${position} Press Space to start the boundary.`;
  }

  private finishOutline(): void {
    const area = Math.abs(polygonArea(this.points));
    if (this.points.length < 3 || area < MIN_POLYGON_AREA) {
      this.completedMask = null;
      this.applyButton.disabled = true;
      this.status.textContent = "That outline is too small. Draw a larger closed region.";
      this.render();
      return;
    }

    const polygon = this.points.map((point) => canvasPointToDomain(point, this.canvas));
    const rasterized = createMaskFromPolygon(polygon, CUSTOM_GRID_SIZE);
    const mask = retainLargestFourConnectedComponent(rasterized);
    const validation = validateMask(mask, {
      minActiveCells: CUSTOM_MIN_ACTIVE_CELLS,
      requireSingleComponent: true,
      warnWhenTouchingGridEdge: true
    });
    if (!validation.valid) {
      this.completedMask = null;
      this.applyButton.disabled = true;
      this.status.textContent = validation.errors[0]?.message ?? "The shape could not be filled.";
      this.render();
      return;
    }

    this.completedMask = mask;
    this.applyButton.disabled = false;
    this.status.textContent = `${validation.activeCellCount.toLocaleString()} grid points inside · outline closed`;
    this.render();
  }

  private apply(): void {
    if (!this.completedMask) return;
    const mask: ShapeMask = {
      width: this.completedMask.width,
      height: this.completedMask.height,
      data: this.completedMask.data.slice()
    };
    this.options.onApply(mask);
    this.close();
  }

  private canvasPoint(event: PointerEvent): CanvasPoint {
    const bounds = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / Math.max(1, bounds.width);
    const scaleY = this.canvas.height / Math.max(1, bounds.height);
    return {
      x: clamp((event.clientX - bounds.left) * scaleX, 0, this.canvas.width),
      y: clamp((event.clientY - bounds.top) * scaleY, 0, this.canvas.height)
    };
  }

  private render(): void {
    const { context, canvas } = this;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#03070c";
    context.fillRect(0, 0, canvas.width, canvas.height);

    const divisions = DEFAULT_GRID_SIZE + 1;
    context.save();
    context.strokeStyle = "rgba(113, 128, 142, 0.13)";
    context.lineWidth = 1;
    for (let index = 1; index < divisions; index += 1) {
      const coordinate = (index / divisions) * canvas.width;
      context.beginPath();
      context.moveTo(coordinate, 0);
      context.lineTo(coordinate, canvas.height);
      context.stroke();
      context.beginPath();
      context.moveTo(0, coordinate);
      context.lineTo(canvas.width, coordinate);
      context.stroke();
    }
    context.restore();

    if (this.completedMask) this.renderMask(this.completedMask);
    if (this.points.length > 0) {
      context.save();
      context.beginPath();
      const first = this.points[0];
      if (first) context.moveTo(first.x, first.y);
      for (let index = 1; index < this.points.length; index += 1) {
        const point = this.points[index];
        if (point) context.lineTo(point.x, point.y);
      }
      if (this.completedMask !== null && this.drawingPointer === null) context.closePath();
      context.strokeStyle = "#d8e0ff";
      context.lineWidth = 3;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.shadowColor = "rgba(158, 176, 255, 0.5)";
      context.shadowBlur = 10;
      context.stroke();
      context.restore();
    }
    if (this.keyboardTracing) this.renderKeyboardPreview();
    this.renderKeyboardCursor();
    this.updateCanvasLabel();
  }

  private renderKeyboardPreview(): void {
    const previous = this.points[this.points.length - 1];
    if (!previous) return;
    const cursor = this.keyboardCanvasPoint();
    this.context.save();
    this.context.beginPath();
    this.context.moveTo(previous.x, previous.y);
    this.context.lineTo(cursor.x, cursor.y);
    this.context.setLineDash([7, 6]);
    this.context.strokeStyle = "rgba(185, 200, 255, 0.72)";
    this.context.lineWidth = 2;
    this.context.stroke();
    this.context.restore();
  }

  private renderKeyboardCursor(): void {
    const cursor = this.keyboardCanvasPoint();
    const focused = this.canvas.matches(":focus-visible");
    if (!focused && !this.keyboardTracing) return;
    this.context.save();
    this.context.beginPath();
    this.context.arc(cursor.x, cursor.y, focused ? 7 : 5, 0, Math.PI * 2);
    this.context.fillStyle = focused ? "#b9c8ff" : "#71808e";
    this.context.shadowColor = focused ? "rgba(158, 176, 255, 0.7)" : "transparent";
    this.context.shadowBlur = focused ? 9 : 0;
    this.context.fill();
    this.context.restore();
  }

  private updateCanvasLabel(): void {
    this.canvas.setAttribute(
      "aria-label",
      `Interactive ${KEYBOARD_GRID_MAX} by ${KEYBOARD_GRID_MAX} custom membrane grid. ` +
        `Keyboard cursor column ${this.keyboardColumn}, row ${this.keyboardRow} from the top. ` +
        (this.keyboardTracing ? "Boundary tracing active." : "Boundary tracing not active.")
    );
  }

  private renderMask(mask: ShapeMask): void {
    const cellWidth = this.canvas.width / (mask.width + 1);
    const cellHeight = this.canvas.height / (mask.height + 1);
    this.context.save();
    this.context.fillStyle = "rgba(40, 104, 134, 0.42)";
    for (let row = 0; row < mask.height; row += 1) {
      for (let column = 0; column < mask.width; column += 1) {
        if ((mask.data[row * mask.width + column] ?? 0) === 0) continue;
        this.context.fillRect(
          (column + 0.5) * cellWidth,
          this.canvas.height - (row + 1.5) * cellHeight,
          cellWidth + 0.6,
          cellHeight + 0.6
        );
      }
    }
    this.context.restore();
  }

  private keepFocusInside(event: KeyboardEvent): void {
    const focusable = Array.from(
      this.dialog.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])')
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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
  private listen(target: Document | HTMLElement, type: string, listener: EventListener): void {
    target.addEventListener(type, listener);
    this.cleanup.push(() => target.removeEventListener(type, listener));
  }
}

export function canvasPointToDomain(
  point: CanvasPoint,
  canvas: Pick<HTMLCanvasElement, "width" | "height">
): Point2D {
  return {
    x: (point.x / canvas.width) * 2 - 1,
    y: 1 - (point.y / canvas.height) * 2
  };
}

function polygonArea(points: readonly CanvasPoint[]): number {
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    if (!current || !next) continue;
    twiceArea += current.x * next.y - next.x * current.y;
  }
  return twiceArea * 0.5;
}

function squaredDistance(a: CanvasPoint, b: CanvasPoint): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.round(clamp(value, minimum, maximum));
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}.`);
  return element as T;
}

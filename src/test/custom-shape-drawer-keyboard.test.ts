import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CUSTOM_GRID_SIZE } from "../shapes";
import { CustomShapeDrawer } from "../ui/custom-shape-drawer";

describe("custom shape drawer keyboard controls", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="drawing-overlay" hidden>
        <section class="drawing-dialog">
          <button id="drawing-close">Close</button>
          <p id="drawing-instructions">Keyboard drawing instructions</p>
          <canvas
            id="drawing-canvas"
            width="588"
            height="588"
            tabindex="0"
            aria-describedby="drawing-instructions drawing-status"
          ></canvas>
          <p id="drawing-status" role="status"></p>
          <button id="drawing-clear">Clear</button>
          <button id="drawing-apply" disabled>Animate this shape</button>
        </section>
      </div>
    `;

    const context = createCanvasContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ x: 0, y: 0, width: 588, height: 588 })
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("places keyboard vertices and closes them into an applicable mask", () => {
    const onApply = vi.fn();
    const drawer = new CustomShapeDrawer({ onApply });
    const canvas = getCanvas();
    drawer.open();
    canvas.focus();

    press(canvas, "ArrowRight");
    expect(canvas.getAttribute("aria-label")).toMatch(/column 26, row 25/);
    press(canvas, "ArrowLeft");
    press(canvas, " ");
    move(canvas, "ArrowRight", 10);
    press(canvas, " ");
    move(canvas, "ArrowDown", 10);
    press(canvas, " ");
    move(canvas, "ArrowLeft", 10);
    press(canvas, "Enter");

    const status = getElement("drawing-status");
    const apply = getButton("drawing-apply");
    expect(status.textContent).toMatch(/grid points inside.*outline closed/);
    expect(apply.disabled).toBe(false);
    apply.click();
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]?.[0]).toMatchObject({
      width: CUSTOM_GRID_SIZE,
      height: CUSTOM_GRID_SIZE
    });
    expect(getElement("drawing-overlay").hidden).toBe(true);

    drawer.destroy();
  });

  it("uses Escape to clear an active trace before closing the dialog", () => {
    const drawer = new CustomShapeDrawer({ onApply: vi.fn() });
    const canvas = getCanvas();
    drawer.open();
    canvas.focus();
    press(canvas, " ");
    move(canvas, "ArrowRight", 4);
    press(canvas, " ");

    press(canvas, "Escape");
    expect(getElement("drawing-overlay").hidden).toBe(false);
    expect(getElement("drawing-status").textContent).toMatch(/Outline cleared/);
    expect(getButton("drawing-apply").disabled).toBe(true);

    press(canvas, "Escape");
    expect(getElement("drawing-overlay").hidden).toBe(true);

    drawer.destroy();
  });
});

function createCanvasContext(): CanvasRenderingContext2D {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setLineDash: vi.fn(),
    stroke: vi.fn()
  } as unknown as CanvasRenderingContext2D;
}

function move(canvas: HTMLCanvasElement, key: string, count: number): void {
  for (let step = 0; step < count; step += 1) press(canvas, key);
}

function press(element: HTMLElement, key: string): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })
  );
}

function getCanvas(): HTMLCanvasElement {
  const canvas = document.getElementById("drawing-canvas");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Missing drawing canvas.");
  return canvas;
}

function getButton(id: string): HTMLButtonElement {
  const button = document.getElementById(id);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button #${id}.`);
  return button;
}

function getElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}.`);
  return element;
}

import { describe, expect, it } from "vitest";

import {
  createCustomVisualBoundary,
  createEmptyMask,
  getFourConnectedComponents,
  interiorGridCoordinate,
  isPointInsideContourBoundary,
  setMaskCell,
  traceMaskContourLoops,
  type ShapeMask,
} from "../shapes";

function createMask(
  width: number,
  height: number,
  active: (column: number, row: number) => boolean,
): ShapeMask {
  const mask = createEmptyMask({ width, height });
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      setMaskCell(mask, column, row, active(column, row));
    }
  }
  return mask;
}

function expectSampleClassificationPreserved(mask: ShapeMask): void {
  const boundary = createCustomVisualBoundary(mask);
  for (let row = 0; row < mask.height; row += 1) {
    for (let column = 0; column < mask.width; column += 1) {
      const point = {
        x: interiorGridCoordinate(column, mask.width),
        y: interiorGridCoordinate(row, mask.height),
      };
      expect(isPointInsideContourBoundary(boundary, point)).toBe(
        (mask.data[row * mask.width + column] ?? 0) !== 0,
      );
    }
  }
}

describe("topology-safe custom visual contours", () => {
  it("smooths a concave accepted domain without changing solver samples", () => {
    const concave = createMask(
      17,
      17,
      (column, row) =>
        column >= 3 && column <= 13 && row >= 3 && row <= 13 &&
        !(column >= 8 && row >= 8),
    );
    const raw = traceMaskContourLoops(concave);
    const smooth = createCustomVisualBoundary(concave);

    expect(getFourConnectedComponents(concave)).toHaveLength(1);
    expect(raw).toHaveLength(1);
    expect(smooth.loops).toHaveLength(1);
    expect(smooth.loops[0]!.length).toBeGreaterThanOrEqual(3);
    expect(smooth.loops[0]).not.toEqual(raw[0]);
    expectSampleClassificationPreserved(concave);
  });

  it("preserves a one-sample-wide neck between two lobes", () => {
    const thinNeck = createMask(
      19,
      13,
      (column, row) =>
        (column >= 2 && column <= 6 && row >= 3 && row <= 9) ||
        (column >= 12 && column <= 16 && row >= 3 && row <= 9) ||
        (row === 6 && column >= 6 && column <= 12),
    );

    expect(getFourConnectedComponents(thinNeck)).toHaveLength(1);
    expect(createCustomVisualBoundary(thinNeck).loops).toHaveLength(1);
    expectSampleClassificationPreserved(thinNeck);
  });

  it("retains a hole as a nested even-odd loop", () => {
    const ring = createMask(
      19,
      19,
      (column, row) => {
        const outer = column >= 2 && column <= 16 && row >= 2 && row <= 16;
        const hole = column >= 7 && column <= 11 && row >= 7 && row <= 11;
        return outer && !hole;
      },
    );
    const boundary = createCustomVisualBoundary(ring);

    expect(getFourConnectedComponents(ring)).toHaveLength(1);
    expect(boundary.loops).toHaveLength(2);
    expect(isPointInsideContourBoundary(boundary, { x: 0, y: 0 })).toBe(false);
    expect(isPointInsideContourBoundary(boundary, { x: 0.6, y: 0 })).toBe(true);
    expectSampleClassificationPreserved(ring);
  });

  it("keeps an edge-touching domain within the existing exterior support", () => {
    const edgeTouch = createMask(
      15,
      15,
      (column, row) => column <= 7 && row >= 3 && row <= 11,
    );
    const boundary = createCustomVisualBoundary(edgeTouch);
    const supportMargin = 1 / (edgeTouch.width + 1);

    expect(boundary.loops).toHaveLength(1);
    for (const point of boundary.loops[0]!) {
      expect(point.x).toBeGreaterThanOrEqual(-1 + supportMargin - 1e-10);
      expect(point.x).toBeLessThanOrEqual(1 - supportMargin + 1e-10);
      expect(point.y).toBeGreaterThanOrEqual(-1 + supportMargin - 1e-10);
      expect(point.y).toBeLessThanOrEqual(1 - supportMargin + 1e-10);
    }
    expectSampleClassificationPreserved(edgeTouch);
  });

  it("preserves multiple components when asked to contour a general mask", () => {
    const disconnected = createMask(
      17,
      11,
      (column, row) =>
        (column >= 2 && column <= 5 && row >= 3 && row <= 7) ||
        (column >= 11 && column <= 14 && row >= 3 && row <= 7),
    );
    const boundary = createCustomVisualBoundary(disconnected);

    expect(getFourConnectedComponents(disconnected)).toHaveLength(2);
    expect(boundary.loops).toHaveLength(2);
    expectSampleClassificationPreserved(disconnected);
  });

  it("rejects empty and malformed masks", () => {
    expect(() => createCustomVisualBoundary(createEmptyMask(7))).toThrow(/active sample/i);
    expect(() =>
      createCustomVisualBoundary({ width: 3, height: 3, data: new Uint8Array(8) }),
    ).toThrow(/storage/i);
  });
});

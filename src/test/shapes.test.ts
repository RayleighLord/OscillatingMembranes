import { describe, expect, it } from "vitest";

import {
  DEFAULT_GRID_SIZE,
  SHAPE_KEYS,
  countActiveCells,
  createEmptyMask,
  generateShapeMask,
  getFourConnectedComponents,
  getMaskBounds,
  getShapeInstanceKey,
  getShapeVisualBoundary,
  isInsideMitSpiral,
  isMaskCellActive,
  normalizeShapeParameters,
  retainLargestFourConnectedComponent,
  setMaskCell,
  triangleVertices,
  validateMask,
  type ShapeKey,
  type ShapeMask
} from "../shapes";

const PREDEFINED_SHAPE_KEYS: readonly Exclude<ShapeKey, "custom">[] =
  SHAPE_KEYS.filter(
    (key): key is Exclude<ShapeKey, "custom"> => key !== "custom"
  );

function sumMaskStorage(mask: ShapeMask): number {
  return mask.data.reduce((sum, value) => sum + value, 0);
}

describe("predefined shape masks", () => {
  it.each(PREDEFINED_SHAPE_KEYS)(
    "generates a nonempty, binary, four-connected %s mask",
    (key) => {
      const mask = generateShapeMask(key);
      const validation = validateMask(mask, {
        minActiveCells: 45,
        requireSingleComponent: true,
        warnWhenTouchingGridEdge: true
      });

      expect(mask.width).toBe(DEFAULT_GRID_SIZE);
      expect(mask.height).toBe(DEFAULT_GRID_SIZE);
      expect(mask.data).toHaveLength(DEFAULT_GRID_SIZE ** 2);
      expect(validation.valid).toBe(true);
      expect(validation.activeCellCount).toBeGreaterThanOrEqual(45);
      expect(validation.componentCount).toBe(1);
      expect(validation.largestComponentSize).toBe(
        validation.activeCellCount
      );
      expect(sumMaskStorage(mask)).toBe(validation.activeCellCount);
      expect(Array.from(mask.data).every((value) => value === 0 || value === 1)).toBe(
        true
      );
    }
  );

  it("uses the exact MIT 18.06 spiral level set on the 400 by 400 grid", () => {
    const spiral = generateShapeMask("spiral", {
      grid: 400,
      retainLargestComponent: false
    });

    expect(countActiveCells(spiral)).toBe(59_779);
    expect(getFourConnectedComponents(spiral)).toHaveLength(1);
    expect(isInsideMitSpiral(0.5, 0)).toBe(true);
    expect(isInsideMitSpiral(0, 0)).toBe(false);
  });

  it("represents custom shapes as an empty grid until the user draws", () => {
    const custom = generateShapeMask("custom", {
      grid: { width: 31, height: 27 }
    });
    const validation = validateMask(custom);

    expect(custom.width).toBe(31);
    expect(custom.height).toBe(27);
    expect(countActiveCells(custom)).toBe(0);
    expect(validation.valid).toBe(false);
    expect(validation.errors.map((issue) => issue.code)).toContain("empty");
  });
});

describe("shape parameters", () => {
  it("clamps known values, replaces non-finite values, and drops unknown keys", () => {
    expect(normalizeShapeParameters("circle", { radius: -10 })).toEqual({
      radius: 0.55
    });
    expect(normalizeShapeParameters("circle", { radius: 10 })).toEqual({
      radius: 0.88
    });
    expect(normalizeShapeParameters("circle", { radius: Number.NaN })).toEqual({
      radius: 0.8
    });
    const normalized = normalizeShapeParameters("rectangle", {
      aspectRatio: 1.2,
      ignored: 99
    });
    expect(normalized).toEqual({ aspectRatio: 1.2 });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it("makes circle radius and annulus opening change occupied area monotonically", () => {
    const smallCircle = generateShapeMask("circle", {
      parameters: { radius: 0.55 }
    });
    const largeCircle = generateShapeMask("circle", {
      parameters: { radius: 0.88 }
    });
    expect(countActiveCells(largeCircle)).toBeGreaterThan(
      countActiveCells(smallCircle)
    );

    const narrowOpening = generateShapeMask("annulus", {
      parameters: { innerRadius: 0.18 }
    });
    const wideOpening = generateShapeMask("annulus", {
      parameters: { innerRadius: 0.65 }
    });
    expect(countActiveCells(wideOpening)).toBeLessThan(
      countActiveCells(narrowOpening)
    );
    const center = Math.floor(DEFAULT_GRID_SIZE / 2);
    expect(isMaskCellActive(narrowOpening, center, center)).toBe(false);
    expect(isMaskCellActive(wideOpening, center, center)).toBe(false);
  });

  it("turns rectangle aspect ratio into the expected wide and tall bounds", () => {
    const wide = generateShapeMask("rectangle", {
      parameters: { aspectRatio: 1.8 }
    });
    const tall = generateShapeMask("rectangle", {
      parameters: { aspectRatio: 0.55 }
    });
    const wideBounds = getMaskBounds(wide)!;
    const tallBounds = getMaskBounds(tall)!;

    expect(wideBounds.width).toBeGreaterThan(wideBounds.height);
    expect(tallBounds.height).toBeGreaterThan(tallBounds.width);
    expect(wideBounds.width).toBe(tallBounds.height);
    expect(wideBounds.height).toBe(tallBounds.width);
  });

  it("moves the triangle apex and rotates polygon rasterizations", () => {
    expect(triangleVertices(-0.5)[2]!.x).toBe(-0.5);
    expect(triangleVertices(0.5)[2]!.x).toBe(0.5);

    const leftTriangle = generateShapeMask("triangle", {
      parameters: { skew: -0.5 }
    });
    const rightTriangle = generateShapeMask("triangle", {
      parameters: { skew: 0.5 }
    });
    expect(Array.from(leftTriangle.data)).not.toEqual(
      Array.from(rightTriangle.data)
    );

    const pentagonA = generateShapeMask("pentagon", {
      parameters: { rotationDeg: 90 }
    });
    const pentagonB = generateShapeMask("pentagon", {
      parameters: { rotationDeg: 0 }
    });
    const hexagonA = generateShapeMask("hexagon", {
      parameters: { rotationDeg: 0 }
    });
    const hexagonB = generateShapeMask("hexagon", {
      parameters: { rotationDeg: 30 }
    });
    expect(Array.from(pentagonA.data)).not.toEqual(Array.from(pentagonB.data));
    expect(Array.from(hexagonA.data)).not.toEqual(Array.from(hexagonB.data));
  });

  it("describes smooth visual edges independently of the solver masks", () => {
    expect(getShapeVisualBoundary("circle", { radius: 0.71 })).toEqual({
      kind: "radial",
      outerRadius: 0.71
    });
    expect(getShapeVisualBoundary("annulus", { innerRadius: 0.42 })).toEqual({
      kind: "radial",
      outerRadius: 0.82,
      innerRadius: 0.42
    });
    const triangle = getShapeVisualBoundary("triangle", { skew: 0.25 });
    expect(triangle?.kind).toBe("polygon");
    if (triangle?.kind === "polygon") {
      expect(triangle.vertices).toHaveLength(3);
      expect(triangle.vertices[2]).toEqual({ x: 0.25, y: 0.82 });
    }
    const rectangle = getShapeVisualBoundary("rectangle", { aspectRatio: 1.6 });
    expect(rectangle?.kind).toBe("polygon");
    if (rectangle?.kind === "polygon") expect(rectangle.vertices).toHaveLength(4);
    expect(getShapeVisualBoundary("pentagon")?.kind).toBe("polygon");
    expect(getShapeVisualBoundary("hexagon")?.kind).toBe("polygon");
    expect(getShapeVisualBoundary("spiral")).toEqual({ kind: "mit-spiral" });
    expect(getShapeVisualBoundary("custom")).toBeUndefined();
  });

  it("builds stable cache keys from normalized, metadata-ordered parameters", () => {
    expect(
      getShapeInstanceKey(
        "rectangle",
        { ignored: 2, aspectRatio: 99 },
        { width: 31, height: 27 }
      )
    ).toBe("rectangle@31x27?aspectRatio=1.8");
    expect(
      getShapeInstanceKey("custom", { ignored: 2 }, { width: 31, height: 27 })
    ).toBe("custom@31x27");
  });
});

describe("custom-mask connectivity and validation", () => {
  function disconnectedCustomMask(): ShapeMask {
    const mask = createEmptyMask({ width: 8, height: 6 });
    setMaskCell(mask, 1, 1, true);
    setMaskCell(mask, 2, 1, true);
    setMaskCell(mask, 1, 2, true);
    setMaskCell(mask, 2, 2, true);
    setMaskCell(mask, 6, 4, true);
    setMaskCell(mask, 7, 4, true);
    return mask;
  }

  it("finds all four-connected components and retains the largest one", () => {
    const custom = disconnectedCustomMask();
    const components = getFourConnectedComponents(custom);
    expect(components.map((component) => component.length)).toEqual([4, 2]);

    const cleaned = retainLargestFourConnectedComponent(custom);
    expect(countActiveCells(cleaned)).toBe(4);
    expect(isMaskCellActive(cleaned, 1, 1)).toBe(true);
    expect(isMaskCellActive(cleaned, 6, 4)).toBe(false);
    expect(countActiveCells(custom)).toBe(6);
  });

  it("reports disconnected custom input and accepts its cleaned component", () => {
    const custom = disconnectedCustomMask();
    const rejected = validateMask(custom, { minActiveCells: 4 });
    expect(rejected.valid).toBe(false);
    expect(rejected.componentCount).toBe(2);
    expect(rejected.largestComponentSize).toBe(4);
    expect(rejected.errors.map((issue) => issue.code)).toContain(
      "disconnected"
    );
    expect(rejected.warnings.map((issue) => issue.code)).toContain(
      "touches-grid-edge"
    );

    const cleaned = retainLargestFourConnectedComponent(custom);
    const accepted = validateMask(cleaned, { minActiveCells: 4 });
    expect(accepted.valid).toBe(true);
    expect(accepted.componentCount).toBe(1);
    expect(accepted.bounds).toEqual({
      minColumn: 1,
      maxColumn: 2,
      minRow: 1,
      maxRow: 2,
      width: 2,
      height: 2
    });
  });

  it("validates storage, binary entries, minimum area, and edge contact", () => {
    const wrongStorage: ShapeMask = {
      width: 3,
      height: 3,
      data: new Uint8Array(8)
    };
    expect(validateMask(wrongStorage).errors[0]?.code).toBe(
      "invalid-data-length"
    );

    const nonBinary: ShapeMask = {
      width: 3,
      height: 3,
      data: Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 0])
    };
    expect(validateMask(nonBinary, { minActiveCells: 1 }).errors.map(
      (issue) => issue.code
    )).toContain("non-binary-data");

    const tooSmall = createEmptyMask(5);
    setMaskCell(tooSmall, 2, 2, true);
    expect(validateMask(tooSmall, { minActiveCells: 2 }).errors.map(
      (issue) => issue.code
    )).toContain("too-few-cells");

    const touchesEdge = createEmptyMask(5);
    setMaskCell(touchesEdge, 0, 2, true);
    setMaskCell(touchesEdge, 1, 2, true);
    expect(validateMask(touchesEdge, { minActiveCells: 1 }).warnings.map(
      (issue) => issue.code
    )).toContain("touches-grid-edge");
    expect(
      validateMask(touchesEdge, {
        minActiveCells: 1,
        warnWhenTouchingGridEdge: false
      }).warnings
    ).toHaveLength(0);
  });
});

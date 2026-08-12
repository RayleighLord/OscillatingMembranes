import { describe, expect, it } from "vitest";

import {
  FUNDAMENTAL_CYCLE_SECONDS,
  animationCycleSeconds,
  frequencyRatioToFundamental
} from "../membrane/timing";
import { canvasPointToDomain } from "../ui/custom-shape-drawer";

describe("modal animation timing", () => {
  it("assigns ten seconds to the fundamental mode", () => {
    expect(FUNDAMENTAL_CYCLE_SECONDS).toBe(10);
    expect(frequencyRatioToFundamental(2.75, 2.75)).toBe(1);
    expect(animationCycleSeconds(2.75, 2.75)).toBe(10);
  });

  it("preserves square-root eigenfrequency ratios across every mode", () => {
    const fundamentalEigenvalue = 3;
    const multiples = [1, 4, 9, 16, 25];
    for (const multiple of multiples) {
      const eigenvalue = fundamentalEigenvalue * multiple;
      const expectedRatio = Math.sqrt(multiple);
      const ratio = frequencyRatioToFundamental(
        eigenvalue,
        fundamentalEigenvalue
      );
      const cycleSeconds = animationCycleSeconds(
        eigenvalue,
        fundamentalEigenvalue
      );

      expect(ratio).toBeCloseTo(expectedRatio, 12);
      expect(cycleSeconds).toBeCloseTo(10 / expectedRatio, 12);
      expect(cycleSeconds * ratio).toBeCloseTo(10, 12);
    }
  });

  it("rejects non-positive and non-finite eigenvalues", () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => frequencyRatioToFundamental(invalid, 1)).toThrow(
        RangeError
      );
      expect(() => frequencyRatioToFundamental(1, invalid)).toThrow(
        RangeError
      );
      expect(() => animationCycleSeconds(invalid, 1)).toThrow(RangeError);
      expect(() => animationCycleSeconds(1, invalid)).toThrow(RangeError);
    }
  });
});

describe("canvasPointToDomain", () => {
  const canvas = { width: 400, height: 200 };

  it("maps every canvas corner to the matching normalized-domain corner", () => {
    expect(canvasPointToDomain({ x: 0, y: 0 }, canvas)).toEqual({
      x: -1,
      y: 1
    });
    expect(canvasPointToDomain({ x: 400, y: 0 }, canvas)).toEqual({
      x: 1,
      y: 1
    });
    expect(canvasPointToDomain({ x: 0, y: 200 }, canvas)).toEqual({
      x: -1,
      y: -1
    });
    expect(canvasPointToDomain({ x: 400, y: 200 }, canvas)).toEqual({
      x: 1,
      y: -1
    });
  });

  it("maps the center and independent rectangular-canvas fractions exactly", () => {
    expect(canvasPointToDomain({ x: 200, y: 100 }, canvas)).toEqual({
      x: 0,
      y: 0
    });
    expect(canvasPointToDomain({ x: 100, y: 50 }, canvas)).toEqual({
      x: -0.5,
      y: 0.5
    });
    expect(canvasPointToDomain({ x: 300, y: 150 }, canvas)).toEqual({
      x: 0.5,
      y: -0.5
    });
  });
});

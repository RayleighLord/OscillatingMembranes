import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { DOMAIN_Y_TO_WORLD_Z_SCALE } from "../membrane/renderer";
import {
  FUNDAMENTAL_CYCLE_SECONDS,
  animationCycleSeconds,
  frequencyRatioToFundamental
} from "../membrane/timing";
import { createMaskFromPolygon } from "../shapes";
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

  it("keeps an asymmetric canvas-top protrusion in the high-domain mask rows", () => {
    const canvasPolygon = [
      { x: 70, y: 170 },
      { x: 330, y: 170 },
      { x: 330, y: 110 },
      { x: 235, y: 110 },
      { x: 200, y: 20 },
      { x: 165, y: 110 },
      { x: 70, y: 110 }
    ];
    const domainPolygon = canvasPolygon.map((point) => canvasPointToDomain(point, canvas));
    const mask = createMaskFromPolygon(domainPolygon, { width: 41, height: 21 });
    const rowCounts = Array.from({ length: mask.height }, (_, row) =>
      mask.data
        .slice(row * mask.width, (row + 1) * mask.width)
        .reduce((count, active) => count + active, 0)
    );
    const activeRows = rowCounts.flatMap((count, row) => count > 0 ? [row] : []);
    const bottomActiveRow = activeRows[0];
    const topActiveRow = activeRows.at(-1);

    expect(bottomActiveRow).toBeDefined();
    expect(topActiveRow).toBeDefined();
    expect(rowCounts[topActiveRow ?? 0] ?? 0).toBeLessThan(
      rowCounts[bottomActiveRow ?? 0] ?? 0
    );
  });
});

describe("domain-to-screen orientation", () => {
  it("keeps domain right and top on the matching sides of the reset view", () => {
    const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 20);
    camera.position.copy(new THREE.Vector3(1.28, 1.02, 1.38).normalize().multiplyScalar(2.15));
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();

    const domainPlane = new THREE.Matrix4().makeScale(1, 1, DOMAIN_Y_TO_WORLD_Z_SCALE);
    const project = (x: number, y: number): THREE.Vector3 =>
      new THREE.Vector3(x, 0, y).applyMatrix4(domainPlane).project(camera);
    const center = project(0, 0);
    const right = project(0.5, 0);
    const top = project(0, 0.5);
    const bottom = project(0, -0.5);
    const projectedOrientation =
      (right.x - center.x) * (top.y - center.y) -
      (right.y - center.y) * (top.x - center.x);

    expect(top.y).toBeGreaterThan(bottom.y);
    expect(projectedOrientation).toBeGreaterThan(0);
  });
});

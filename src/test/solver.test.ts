import { beforeAll, describe, expect, it } from "vitest";

import {
  EigenmodeSolverError,
  solveMembraneModes,
  type MembraneEigenSolution,
  type MembraneEigenmode,
  type SolverProgress
} from "../solver";
import { generateShapeMask, getMaskBounds, type ShapeKey } from "../shapes";

const FULL_WIDTH = 9;
const FULL_HEIGHT = 8;
const RECTANGLE_WIDTH = 7;
const RECTANGLE_HEIGHT = 6;
const RECTANGLE_COLUMN_OFFSET = 1;
const RECTANGLE_ROW_OFFSET = 1;
const UNIQUE_FREQUENCY_TOLERANCE = 1e-9;

function embeddedRectangleMask(): Uint8Array {
  const mask = new Uint8Array(FULL_WIDTH * FULL_HEIGHT);
  for (let row = 0; row < RECTANGLE_HEIGHT; row += 1) {
    for (let column = 0; column < RECTANGLE_WIDTH; column += 1) {
      const fullRow = row + RECTANGLE_ROW_OFFSET;
      const fullColumn = column + RECTANGLE_COLUMN_OFFSET;
      mask[fullRow * FULL_WIDTH + fullColumn] = 1;
    }
  }
  return mask;
}

function exactRectangleEigenvalues(width: number, height: number): number[] {
  const eigenvalues: number[] = [];
  for (let horizontalIndex = 1; horizontalIndex <= width; horizontalIndex += 1) {
    for (let verticalIndex = 1; verticalIndex <= height; verticalIndex += 1) {
      eigenvalues.push(
        4 -
          2 * Math.cos((horizontalIndex * Math.PI) / (width + 1)) -
          2 * Math.cos((verticalIndex * Math.PI) / (height + 1))
      );
    }
  }
  return eigenvalues.sort((left, right) => left - right);
}

function uniqueByFrequency(
  sortedEigenvalues: readonly number[],
  tolerance: number
): number[] {
  const unique: number[] = [];
  for (const candidate of sortedEigenvalues) {
    const previous = unique.at(-1);
    if (previous === undefined) {
      unique.push(candidate);
      continue;
    }
    const previousFrequency = Math.sqrt(previous);
    const candidateFrequency = Math.sqrt(candidate);
    const relativeGap =
      Math.abs(candidateFrequency - previousFrequency) /
      Math.max(previousFrequency, candidateFrequency);
    if (relativeGap > tolerance) unique.push(candidate);
  }
  return unique;
}

function dot(left: ArrayLike<number>, right: ArrayLike<number>): number {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) {
    result += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return result;
}

function independentlyComputedResidual(
  mode: MembraneEigenmode,
  mask: Uint8Array,
  width: number,
  height: number
): number {
  let residualSquared = 0;
  let normSquared = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) continue;
    const row = Math.floor(index / width);
    const column = index - row * width;
    const value = mode.values[index] ?? 0;
    let laplacianValue = 4 * value;
    if (column > 0 && mask[index - 1] !== 0) {
      laplacianValue -= mode.values[index - 1] ?? 0;
    }
    if (column + 1 < width && mask[index + 1] !== 0) {
      laplacianValue -= mode.values[index + 1] ?? 0;
    }
    if (row > 0 && mask[index - width] !== 0) {
      laplacianValue -= mode.values[index - width] ?? 0;
    }
    if (row + 1 < height && mask[index + width] !== 0) {
      laplacianValue -= mode.values[index + width] ?? 0;
    }
    const residual = laplacianValue - mode.discreteEigenvalue * value;
    residualSquared += residual * residual;
    normSquared += value * value;
  }
  return (
    Math.sqrt(residualSquared) /
    (mode.discreteEigenvalue * Math.sqrt(normSquared))
  );
}

function expectSolverError(
  operation: () => unknown,
  code: EigenmodeSolverError["code"]
): void {
  try {
    operation();
    throw new Error("Expected solveMembraneModes to throw.");
  } catch (error) {
    expect(error).toBeInstanceOf(EigenmodeSolverError);
    expect((error as EigenmodeSolverError).code).toBe(code);
  }
}

describe("solveMembraneModes", () => {
  let solution: MembraneEigenSolution;
  let progress: SolverProgress[];

  beforeAll(() => {
    progress = [];
    solution = solveMembraneModes(
      embeddedRectangleMask(),
      FULL_WIDTH,
      FULL_HEIGHT,
      {
        modeCount: 20,
        gridSpacing: 0.25,
        waveSpeed: 3,
        degeneracyTolerance: UNIQUE_FREQUENCY_TOLERANCE,
        residualTolerance: 1e-8,
        initialBasisSize: RECTANGLE_WIDTH * RECTANGLE_HEIGHT,
        basisStep: 1,
        maxBasisSize: RECTANGLE_WIDTH * RECTANGLE_HEIGHT,
        randomSeed: 0x1234abcd,
        onProgress: (update) => progress.push(update)
      }
    );
  });

  it("returns 20 distinct modes in strictly increasing frequency order", () => {
    expect(solution.modes).toHaveLength(20);
    expect(solution.activeNodeCount).toBe(
      RECTANGLE_WIDTH * RECTANGLE_HEIGHT
    );
    expect(solution.removedNodeCount).toBe(0);

    for (let index = 0; index < solution.modes.length; index += 1) {
      const mode = solution.modes[index]!;
      expect(mode.modeNumber).toBe(index + 1);
      if (index === 0) {
        expect(mode.frequencyRatio).toBeCloseTo(1, 12);
        continue;
      }
      const previous = solution.modes[index - 1]!;
      expect(mode.discreteEigenvalue).toBeGreaterThan(
        previous.discreteEigenvalue
      );
      const frequencyGap =
        (Math.sqrt(mode.discreteEigenvalue) -
          Math.sqrt(previous.discreteEigenvalue)) /
        Math.sqrt(mode.discreteEigenvalue);
      expect(frequencyGap).toBeGreaterThan(UNIQUE_FREQUENCY_TOLERANCE);
    }
  });

  it("matches the exact five-point Dirichlet spectrum of a rectangle", () => {
    const exact = uniqueByFrequency(
      exactRectangleEigenvalues(RECTANGLE_WIDTH, RECTANGLE_HEIGHT),
      UNIQUE_FREQUENCY_TOLERANCE
    ).slice(0, 20);

    expect(exact).toHaveLength(20);
    solution.modes.forEach((mode, index) => {
      expect(mode.discreteEigenvalue).toBeCloseTo(exact[index]!, 10);
      expect(mode.eigenvalue).toBeCloseTo(
        mode.discreteEigenvalue / 0.25 ** 2,
        10
      );
      expect(mode.angularFrequency).toBeCloseTo(
        3 * Math.sqrt(mode.eigenvalue),
        10
      );
      expect(mode.frequencyRatio).toBeCloseTo(
        Math.sqrt(
          mode.discreteEigenvalue /
            solution.modes[0]!.discreteEigenvalue
        ),
        10
      );
    });
  });

  it("returns low-residual, max-absolute-normalized fields with zero exterior", () => {
    for (const mode of solution.modes) {
      let maximumMagnitude = 0;
      for (let index = 0; index < mode.values.length; index += 1) {
        const value = mode.values[index] ?? 0;
        maximumMagnitude = Math.max(maximumMagnitude, Math.abs(value));
        if (solution.mask[index] === 0) expect(value).toBe(0);
      }
      expect(maximumMagnitude).toBeCloseTo(1, 6);
      expect(mode.relativeResidual).toBeLessThan(1e-8);
      expect(
        independentlyComputedResidual(
          mode,
          solution.mask,
          solution.width,
          solution.height
        )
      ).toBeLessThan(2e-7);
    }
  });

  it("returns mutually orthogonal mode fields", () => {
    for (let leftIndex = 0; leftIndex < solution.modes.length; leftIndex += 1) {
      const left = solution.modes[leftIndex]!.values;
      const leftNorm = Math.sqrt(dot(left, left));
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < solution.modes.length;
        rightIndex += 1
      ) {
        const right = solution.modes[rightIndex]!.values;
        const normalizedDot =
          Math.abs(dot(left, right)) /
          (leftNorm * Math.sqrt(dot(right, right)));
        expect(normalizedDot).toBeLessThan(2e-6);
      }
    }
  });

  it("reports bounded, monotone progress through every solver stage", () => {
    expect(progress.length).toBeGreaterThan(5);
    expect(new Set(progress.map((update) => update.stage))).toEqual(
      new Set(["preparing", "factorizing", "iterating", "finalizing"])
    );
    progress.forEach((update, index) => {
      expect(update.fraction).toBeGreaterThanOrEqual(0);
      expect(update.fraction).toBeLessThanOrEqual(1);
      if (index > 0) {
        expect(update.fraction).toBeGreaterThanOrEqual(
          progress[index - 1]!.fraction
        );
      }
    });
    expect(progress.at(-1)).toMatchObject({
      stage: "finalizing",
      fraction: 1,
      convergedModes: 20
    });
  });

  it("collapses exact square-domain degeneracies", () => {
    const side = 6;
    const square = new Uint8Array(side * side).fill(1);
    const squareSolution = solveMembraneModes(square, side, side, {
      modeCount: 10,
      degeneracyTolerance: UNIQUE_FREQUENCY_TOLERANCE,
      residualTolerance: 1e-8,
      initialBasisSize: side * side,
      basisStep: 1,
      maxBasisSize: side * side
    });
    const exactUnique = uniqueByFrequency(
      exactRectangleEigenvalues(side, side),
      UNIQUE_FREQUENCY_TOLERANCE
    );

    expect(exactUnique.length).toBeLessThan(side * side);
    squareSolution.modes.forEach((mode, index) => {
      expect(mode.discreteEigenvalue).toBeCloseTo(exactUnique[index]!, 10);
    });
  });

  it("keeps a close but analytically distinct pair in the default rectangle", () => {
    const rectangle = generateShapeMask("rectangle");
    const bounds = getMaskBounds(rectangle);
    expect(bounds).not.toBeNull();
    const exact = exactRectangleEigenvalues(
      bounds?.width ?? 0,
      bounds?.height ?? 0
    );
    const rectangleSolution = solveMembraneModes(
      rectangle.data,
      rectangle.width,
      rectangle.height,
      { modeCount: 12 }
    );

    rectangleSolution.modes.forEach((mode, index) => {
      expect(mode.discreteEigenvalue).toBeCloseTo(exact[index]!, 10);
    });
    const closeGap =
      Math.sqrt(exact[11]!) / Math.sqrt(exact[10]!) - 1;
    expect(closeGap).toBeGreaterThan(1e-8);
    expect(closeGap).toBeLessThan(7.5e-3);
  });

  it.each<{
    key: ShapeKey;
    symmetry: number | "continuous";
    splitStart: number;
    afterPair: number;
  }>([
    { key: "circle", symmetry: "continuous", splitStart: 2, afterPair: 4 },
    { key: "annulus", symmetry: "continuous", splitStart: 2, afterPair: 4 },
    { key: "pentagon", symmetry: 5, splitStart: 1, afterPair: 3 },
    { key: "hexagon", symmetry: 6, splitStart: 1, afterPair: 3 }
  ])(
    "collapses a raster-split $key rotational doublet from its fields",
    ({ key, symmetry, splitStart, afterPair }) => {
      const shape = generateShapeMask(key);
      const raw = solveMembraneModes(shape.data, shape.width, shape.height, {
        modeCount: 6,
        degeneracyTolerance: 1e-10
      });
      const filtered = solveMembraneModes(
        shape.data,
        shape.width,
        shape.height,
        {
          modeCount: 4,
          degeneracyTolerance: 1e-10,
          rotationalSymmetry: symmetry
        }
      );
      const splitGap =
        Math.sqrt(raw.modes[splitStart + 1]!.discreteEigenvalue) /
          Math.sqrt(raw.modes[splitStart]!.discreteEigenvalue) -
        1;

      expect(splitGap).toBeGreaterThan(1e-10);
      expect(splitGap).toBeLessThan(3e-2);
      expect(filtered.modes[splitStart]!.discreteEigenvalue).toBeCloseTo(
        raw.modes[splitStart]!.discreteEigenvalue,
        10
      );
      expect(filtered.modes[splitStart + 1]!.discreteEigenvalue).toBeCloseTo(
        raw.modes[afterPair]!.discreteEigenvalue,
        10
      );
    }
  );

  it("cleans disconnected custom masks deterministically unless opted out", () => {
    const width = 8;
    const height = 6;
    const customMask = new Uint8Array(width * height);
    for (let row = 1; row <= 4; row += 1) {
      for (let column = 1; column <= 4; column += 1) {
        customMask[row * width + column] = 1;
      }
    }
    customMask[5 * width + 6] = 1;
    customMask[5 * width + 7] = 1;

    const cleaned = solveMembraneModes(customMask, width, height, {
      modeCount: 5,
      initialBasisSize: 16,
      maxBasisSize: 16
    });
    expect(cleaned.activeNodeCount).toBe(16);
    expect(cleaned.removedNodeCount).toBe(2);
    expect(cleaned.mask[5 * width + 6]).toBe(0);
    expect(cleaned.mask[5 * width + 7]).toBe(0);

    const preserved = solveMembraneModes(customMask, width, height, {
      modeCount: 1,
      keepLargestComponent: false,
      initialBasisSize: 18,
      maxBasisSize: 18
    });
    expect(preserved.activeNodeCount).toBe(18);
    expect(preserved.removedNodeCount).toBe(0);
    expect(preserved.mask[5 * width + 6]).toBe(1);
    expect(preserved.mask[5 * width + 7]).toBe(1);
  });

  it("rejects malformed grids, impossible domains, and invalid options", () => {
    expectSolverError(
      () => solveMembraneModes(new Uint8Array(8), 3, 3, { modeCount: 1 }),
      "INVALID_INPUT"
    );
    expectSolverError(
      () => solveMembraneModes(new Uint8Array(9), 3, 3, { modeCount: 1 }),
      "DOMAIN_TOO_SMALL"
    );
    expectSolverError(
      () =>
        solveMembraneModes(new Uint8Array(9).fill(1), 3, 3, {
          modeCount: 0
        }),
      "INVALID_INPUT"
    );
    expectSolverError(
      () =>
        solveMembraneModes(new Uint8Array(9).fill(1), 3, 3, {
          modeCount: 1,
          gridSpacing: 0
        }),
      "INVALID_INPUT"
    );
    expectSolverError(
      () =>
        solveMembraneModes(new Uint8Array(9).fill(1), 3, 3, {
          modeCount: 1,
          initialBasisSize: 4,
          maxBasisSize: 3
        }),
      "INVALID_INPUT"
    );
  });
});

import { DEFAULT_GRID_SIZE } from "./types";
import type {
  GridDimensions,
  MaskBounds,
  MaskValidationIssue,
  MaskValidationOptions,
  MaskValidationResult,
  Point2D,
  ShapeMask,
  ShapePredicate,
} from "./types";
import { pointInPolygon } from "./geometry";

const DEFAULT_MIN_ACTIVE_CELLS = 9;

function assertDimension(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function assertMaskStorage(mask: ShapeMask): void {
  assertDimension(mask.width, "Mask width");
  assertDimension(mask.height, "Mask height");
  if (mask.data.length !== mask.width * mask.height) {
    throw new RangeError("Mask data length does not match its dimensions.");
  }
}

export function normalizeGridDimensions(
  grid: number | GridDimensions = DEFAULT_GRID_SIZE,
): GridDimensions {
  const width = typeof grid === "number" ? grid : grid.width;
  const height = typeof grid === "number" ? grid : grid.height;
  assertDimension(width, "Grid width");
  assertDimension(height, "Grid height");
  return { width, height };
}

export function createEmptyMask(
  grid: number | GridDimensions = DEFAULT_GRID_SIZE,
): ShapeMask {
  const { width, height } = normalizeGridDimensions(grid);
  return { width, height, data: new Uint8Array(width * height) };
}

export function createFilledMask(
  grid: number | GridDimensions = DEFAULT_GRID_SIZE,
): ShapeMask {
  const mask = createEmptyMask(grid);
  mask.data.fill(1);
  return mask;
}

export function cloneMask(mask: ShapeMask): ShapeMask {
  assertMaskStorage(mask);
  return { width: mask.width, height: mask.height, data: mask.data.slice() };
}

export function maskIndex(
  mask: Pick<ShapeMask, "width" | "height">,
  column: number,
  row: number,
): number {
  if (
    !Number.isInteger(column) ||
    !Number.isInteger(row) ||
    column < 0 ||
    column >= mask.width ||
    row < 0 ||
    row >= mask.height
  ) {
    return -1;
  }
  return row * mask.width + column;
}

export function isMaskCellActive(
  mask: ShapeMask,
  column: number,
  row: number,
): boolean {
  const index = maskIndex(mask, column, row);
  return index >= 0 && (mask.data[index] ?? 0) !== 0;
}

/** Mutates a mask cell in place; useful for pointer-driven custom drawing. */
export function setMaskCell(
  mask: ShapeMask,
  column: number,
  row: number,
  active: boolean,
): boolean {
  const index = maskIndex(mask, column, row);
  if (index < 0 || index >= mask.data.length) {
    return false;
  }
  mask.data[index] = active ? 1 : 0;
  return true;
}

/**
 * Grid points are the interior points of a uniform partition of [-1, 1],
 * matching the MIT notebook's endpoint-excluding finite-difference grid.
 */
export function interiorGridCoordinate(index: number, count: number): number {
  assertDimension(count, "Grid coordinate count");
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError("Grid coordinate index is out of range.");
  }
  return -1 + (2 * (index + 1)) / (count + 1);
}

export function createMaskFromPredicate(
  predicate: ShapePredicate,
  grid: number | GridDimensions = DEFAULT_GRID_SIZE,
): ShapeMask {
  const mask = createEmptyMask(grid);
  for (let row = 0; row < mask.height; row += 1) {
    const y = interiorGridCoordinate(row, mask.height);
    for (let column = 0; column < mask.width; column += 1) {
      const x = interiorGridCoordinate(column, mask.width);
      if (predicate(x, y)) {
        mask.data[row * mask.width + column] = 1;
      }
    }
  }
  return mask;
}

export function createMaskFromPolygon(
  polygon: readonly Point2D[],
  grid: number | GridDimensions = DEFAULT_GRID_SIZE,
): ShapeMask {
  return createMaskFromPredicate(
    (x, y) => pointInPolygon({ x, y }, polygon),
    grid,
  );
}

export function normalizeBinaryMask(mask: ShapeMask): ShapeMask {
  assertMaskStorage(mask);
  const normalized = new Uint8Array(mask.data.length);
  for (let index = 0; index < mask.data.length; index += 1) {
    normalized[index] = (mask.data[index] ?? 0) === 0 ? 0 : 1;
  }
  return { width: mask.width, height: mask.height, data: normalized };
}

export function countActiveCells(mask: ShapeMask): number {
  assertMaskStorage(mask);
  let count = 0;
  for (const value of mask.data) {
    count += value === 0 ? 0 : 1;
  }
  return count;
}

export function getMaskBounds(mask: ShapeMask): MaskBounds | null {
  assertMaskStorage(mask);
  let minColumn = mask.width;
  let maxColumn = -1;
  let minRow = mask.height;
  let maxRow = -1;

  for (let row = 0; row < mask.height; row += 1) {
    for (let column = 0; column < mask.width; column += 1) {
      if ((mask.data[row * mask.width + column] ?? 0) === 0) {
        continue;
      }
      minColumn = Math.min(minColumn, column);
      maxColumn = Math.max(maxColumn, column);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
    }
  }

  if (maxColumn < 0) {
    return null;
  }
  return {
    minColumn,
    maxColumn,
    minRow,
    maxRow,
    width: maxColumn - minColumn + 1,
    height: maxRow - minRow + 1,
  };
}

export function getFourConnectedComponents(
  mask: ShapeMask,
): readonly Int32Array[] {
  assertMaskStorage(mask);
  const visited = new Uint8Array(mask.data.length);
  const queue = new Int32Array(mask.data.length);
  const components: Int32Array[] = [];

  for (let seed = 0; seed < mask.data.length; seed += 1) {
    if ((mask.data[seed] ?? 0) === 0 || (visited[seed] ?? 0) !== 0) {
      continue;
    }

    let queueStart = 0;
    let queueEnd = 0;
    const component: number[] = [];
    queue[queueEnd] = seed;
    queueEnd += 1;
    visited[seed] = 1;

    while (queueStart < queueEnd) {
      const index = queue[queueStart];
      queueStart += 1;
      if (index === undefined) {
        continue;
      }
      component.push(index);

      const row = Math.floor(index / mask.width);
      const column = index - row * mask.width;
      const neighbors = [
        column > 0 ? index - 1 : -1,
        column + 1 < mask.width ? index + 1 : -1,
        row > 0 ? index - mask.width : -1,
        row + 1 < mask.height ? index + mask.width : -1,
      ];

      for (const neighbor of neighbors) {
        if (
          neighbor >= 0 &&
          (mask.data[neighbor] ?? 0) !== 0 &&
          (visited[neighbor] ?? 0) === 0
        ) {
          visited[neighbor] = 1;
          queue[queueEnd] = neighbor;
          queueEnd += 1;
        }
      }
    }

    components.push(Int32Array.from(component));
  }

  return components;
}

/**
 * Returns a new mask containing only the largest four-connected component.
 * Ties are stable: the component with the lowest row-major cell index wins.
 */
export function retainLargestFourConnectedComponent(mask: ShapeMask): ShapeMask {
  assertMaskStorage(mask);
  const components = getFourConnectedComponents(mask);
  let largest: Int32Array | undefined;

  for (const component of components) {
    if (largest === undefined || component.length > largest.length) {
      largest = component;
    }
  }

  const result = createEmptyMask({ width: mask.width, height: mask.height });
  if (largest === undefined) {
    return result;
  }
  for (const index of largest) {
    result.data[index] = 1;
  }
  return result;
}

export function validateMask(
  mask: ShapeMask,
  options: MaskValidationOptions = {},
): MaskValidationResult {
  const errors: MaskValidationIssue[] = [];
  const warnings: MaskValidationIssue[] = [];
  const requestedMinActiveCells =
    options.minActiveCells ?? DEFAULT_MIN_ACTIVE_CELLS;
  const minActiveCells = Math.max(
    1,
    Number.isFinite(requestedMinActiveCells)
      ? Math.floor(requestedMinActiveCells)
      : DEFAULT_MIN_ACTIVE_CELLS,
  );
  const requireSingleComponent = options.requireSingleComponent ?? true;
  const warnWhenTouchingGridEdge = options.warnWhenTouchingGridEdge ?? true;

  if (
    !Number.isInteger(mask.width) ||
    !Number.isInteger(mask.height) ||
    mask.width < 1 ||
    mask.height < 1
  ) {
    errors.push({
      code: "invalid-dimensions",
      message: "The mask must have positive integer dimensions.",
    });
    return {
      valid: false,
      errors,
      warnings,
      activeCellCount: 0,
      componentCount: 0,
      largestComponentSize: 0,
      bounds: null,
    };
  }

  if (mask.data.length !== mask.width * mask.height) {
    errors.push({
      code: "invalid-data-length",
      message: "The mask storage does not match its width and height.",
    });
    return {
      valid: false,
      errors,
      warnings,
      activeCellCount: 0,
      componentCount: 0,
      largestComponentSize: 0,
      bounds: null,
    };
  }

  let hasNonBinaryValue = false;
  for (const value of mask.data) {
    if (value !== 0 && value !== 1) {
      hasNonBinaryValue = true;
      break;
    }
  }
  if (hasNonBinaryValue) {
    errors.push({
      code: "non-binary-data",
      message: "Mask entries must be either zero or one.",
    });
  }

  const activeCellCount = countActiveCells(mask);
  const bounds = getMaskBounds(mask);
  const components = getFourConnectedComponents(mask);
  let largestComponentSize = 0;
  for (const component of components) {
    largestComponentSize = Math.max(largestComponentSize, component.length);
  }

  if (activeCellCount === 0) {
    errors.push({
      code: "empty",
      message: "Draw a closed membrane region before solving.",
    });
  } else if (activeCellCount < minActiveCells) {
    errors.push({
      code: "too-few-cells",
      message: `The membrane needs at least ${minActiveCells} active grid cells.`,
    });
  }

  if (requireSingleComponent && components.length > 1) {
    errors.push({
      code: "disconnected",
      message: "The membrane must be one four-connected region.",
    });
  }

  if (
    warnWhenTouchingGridEdge &&
    bounds !== null &&
    (bounds.minColumn === 0 ||
      bounds.maxColumn === mask.width - 1 ||
      bounds.minRow === 0 ||
      bounds.maxRow === mask.height - 1)
  ) {
    warnings.push({
      code: "touches-grid-edge",
      message: "The membrane touches the drawing boundary and will be clamped there.",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    activeCellCount,
    componentCount: components.length,
    largestComponentSize,
    bounds,
  };
}

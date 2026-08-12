import { pointInPolygon } from "./geometry";
import { interiorGridCoordinate } from "./mask";
import type { Point2D, ShapeMask, ShapeVisualBoundary } from "./types";

const DEFAULT_SMOOTHING_PASSES = 3;
const MAX_SMOOTHING_PASSES = 4;
const GEOMETRY_EPSILON = 1e-10;
const DEFAULT_SIMPLIFICATION_TOLERANCE_IN_GRID_STEPS = 0.62;

type ContourBoundary = Extract<ShapeVisualBoundary, { readonly kind: "contours" }>;

interface LatticePoint {
  readonly x: number;
  readonly y: number;
}

type CellEdge = 0 | 1 | 2 | 3;
type EdgePair = readonly [CellEdge, CellEdge];

/**
 * Marching-squares segments for binary corners ordered lower-left,
 * lower-right, upper-right, upper-left. Ambiguous diagonal cases keep active
 * samples four-disconnected, matching the solver's connectivity convention.
 */
const CELL_SEGMENTS: readonly (readonly EdgePair[])[] = [
  [],
  [[3, 0]],
  [[0, 1]],
  [[3, 1]],
  [[1, 2]],
  [[3, 0], [1, 2]],
  [[0, 2]],
  [[3, 2]],
  [[2, 3]],
  [[2, 0]],
  [[0, 1], [2, 3]],
  [[2, 1]],
  [[1, 3]],
  [[1, 0]],
  [[0, 3]],
  [],
];

export interface CustomVisualBoundaryOptions {
  /** Maximum topology-checked Chaikin passes. Defaults to three. */
  readonly maxSmoothingPasses?: number;
}

/**
 * Build a smooth render-only contour from an accepted numerical mask.
 *
 * The original mask is never modified. Every smoothing candidate must retain
 * the inside/outside classification of every solver sample, remain within the
 * inactive exterior support, keep simple nonintersecting loops, and preserve
 * loop nesting. If a requested smoothing pass is unsafe, the function backs
 * off deterministically; the unsmoothed marching contour is always the final
 * fallback.
 */
export function createCustomVisualBoundary(
  mask: ShapeMask,
  options: CustomVisualBoundaryOptions = {},
): ContourBoundary {
  assertBinaryMask(mask);
  const rawLoops = traceMaskContourLoops(mask);
  if (rawLoops.length === 0) {
    throw new RangeError("A custom visual boundary needs at least one active sample.");
  }

  const requestedPasses = options.maxSmoothingPasses ?? DEFAULT_SMOOTHING_PASSES;
  const maxPasses = Number.isFinite(requestedPasses)
    ? Math.min(MAX_SMOOTHING_PASSES, Math.max(0, Math.floor(requestedPasses)))
    : DEFAULT_SMOOTHING_PASSES;
  const rawNesting = contourNestingDepths(rawLoops);

  for (let passCount = maxPasses; passCount >= 0; passCount -= 1) {
    const simplifiedLoops = rawLoops.map((loop) =>
      simplifyLoopWithinTolerance(
        loop,
        mask,
        DEFAULT_SIMPLIFICATION_TOLERANCE_IN_GRID_STEPS,
      ),
    );
    for (const sourceLoops of [simplifiedLoops, rawLoops]) {
      const candidate = sourceLoops.map((loop) => smoothClosedLoop(loop, passCount));
      if (isTopologySafeCandidate(mask, candidate, rawNesting)) {
        return Object.freeze({
          kind: "contours",
          loops: Object.freeze(
            candidate.map((loop) =>
              Object.freeze(loop.map((point) => Object.freeze({ ...point }))),
            ),
          ),
        });
      }
    }
  }

  // The raw marching-squares contour should satisfy these invariants. Reaching
  // this branch signals corrupt input or an internal topology error.
  throw new Error("The accepted custom mask could not produce a safe visual contour.");
}

/** Trace exact 0.5 isolines of a padded binary mask in normalized coordinates. */
export function traceMaskContourLoops(mask: ShapeMask): readonly (readonly Point2D[])[] {
  assertBinaryMask(mask);
  const adjacency = new Map<string, Set<string>>();
  const points = new Map<string, LatticePoint>();

  const addSegment = (first: LatticePoint, second: LatticePoint): void => {
    const firstKey = latticeKey(first);
    const secondKey = latticeKey(second);
    if (firstKey === secondKey) return;
    points.set(firstKey, first);
    points.set(secondKey, second);
    addNeighbor(adjacency, firstKey, secondKey);
    addNeighbor(adjacency, secondKey, firstKey);
  };

  for (let row = 0; row <= mask.height; row += 1) {
    for (let column = 0; column <= mask.width; column += 1) {
      const code =
        paddedMaskValue(mask, column, row) |
        (paddedMaskValue(mask, column + 1, row) << 1) |
        (paddedMaskValue(mask, column + 1, row + 1) << 2) |
        (paddedMaskValue(mask, column, row + 1) << 3);
      const segments = CELL_SEGMENTS[code] ?? [];
      for (const [firstEdge, secondEdge] of segments) {
        addSegment(
          cellEdgePoint(column, row, firstEdge),
          cellEdgePoint(column, row, secondEdge),
        );
      }
    }
  }

  for (const [key, neighbors] of adjacency) {
    if (neighbors.size !== 2) {
      throw new Error(
        `Custom contour topology is not two-regular at ${key}; found ${neighbors.size} incident edges.`,
      );
    }
  }

  const visitedEdges = new Set<string>();
  const loops: Point2D[][] = [];
  const orderedKeys = [...adjacency.keys()].sort(compareLatticeKeys);
  for (const startKey of orderedKeys) {
    const neighbors = [...(adjacency.get(startKey) ?? [])].sort(compareLatticeKeys);
    for (const firstNeighbor of neighbors) {
      if (visitedEdges.has(undirectedEdgeKey(startKey, firstNeighbor))) continue;
      const latticeLoop: LatticePoint[] = [];
      let previousKey = startKey;
      let currentKey = firstNeighbor;
      latticeLoop.push(requirePoint(points, startKey));
      visitedEdges.add(undirectedEdgeKey(startKey, firstNeighbor));

      while (currentKey !== startKey) {
        latticeLoop.push(requirePoint(points, currentKey));
        const currentNeighbors = [...(adjacency.get(currentKey) ?? [])].sort(compareLatticeKeys);
        const nextKey = currentNeighbors.find((key) => key !== previousKey);
        if (!nextKey) throw new Error("Custom contour ended before closing its loop.");
        const edgeKey = undirectedEdgeKey(currentKey, nextKey);
        if (visitedEdges.has(edgeKey) && nextKey !== startKey) {
          throw new Error("Custom contour revisited an edge before closing its loop.");
        }
        visitedEdges.add(edgeKey);
        previousKey = currentKey;
        currentKey = nextKey;
      }

      const normalized = simplifyClosedLoop(
        latticeLoop.map((point) => ({
          x: -1 + point.x / (mask.width + 1),
          y: -1 + point.y / (mask.height + 1),
        })),
      );
      if (normalized.length < 3) {
        throw new Error("Custom contour contains fewer than three distinct vertices.");
      }
      loops.push(normalized);
    }
  }

  return loops;
}

/** Even-odd classification used by tests and topology validation. */
export function isPointInsideContourBoundary(
  boundary: ContourBoundary,
  point: Point2D,
): boolean {
  let inside = false;
  for (const loop of boundary.loops) {
    if (pointInPolygon(point, loop, false)) inside = !inside;
  }
  return inside;
}

function isTopologySafeCandidate(
  mask: ShapeMask,
  loops: readonly (readonly Point2D[])[],
  rawNesting: readonly number[],
): boolean {
  if (loops.length === 0 || loops.length !== rawNesting.length) return false;
  const horizontalMargin = 1 / (mask.width + 1);
  const verticalMargin = 1 / (mask.height + 1);

  for (const loop of loops) {
    if (loop.length < 3 || Math.abs(signedArea(loop)) <= GEOMETRY_EPSILON) return false;
    for (const point of loop) {
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < -1 + horizontalMargin - GEOMETRY_EPSILON ||
        point.x > 1 - horizontalMargin + GEOMETRY_EPSILON ||
        point.y < -1 + verticalMargin - GEOMETRY_EPSILON ||
        point.y > 1 - verticalMargin + GEOMETRY_EPSILON
      ) {
        return false;
      }
    }
    if (loopSelfIntersects(loop)) return false;
  }

  for (let first = 0; first < loops.length; first += 1) {
    for (let second = first + 1; second < loops.length; second += 1) {
      if (loopsIntersect(loops[first]!, loops[second]!)) return false;
    }
  }
  const candidateNesting = contourNestingDepths(loops);
  if (candidateNesting.some((depth, index) => depth !== rawNesting[index])) return false;

  const boundary: ContourBoundary = { kind: "contours", loops };
  for (let row = 0; row < mask.height; row += 1) {
    const y = interiorGridCoordinate(row, mask.height);
    for (let column = 0; column < mask.width; column += 1) {
      const x = interiorGridCoordinate(column, mask.width);
      const point = { x, y };
      if (minimumBoundaryDistanceSquared(loops, point) <= GEOMETRY_EPSILON ** 2) {
        return false;
      }
      const expectedInside = (mask.data[row * mask.width + column] ?? 0) !== 0;
      if (isPointInsideContourBoundary(boundary, point) !== expectedInside) return false;
    }
  }
  return true;
}

function paddedMaskValue(mask: ShapeMask, paddedColumn: number, paddedRow: number): number {
  const column = paddedColumn - 1;
  const row = paddedRow - 1;
  if (column < 0 || column >= mask.width || row < 0 || row >= mask.height) return 0;
  return (mask.data[row * mask.width + column] ?? 0) === 0 ? 0 : 1;
}

function cellEdgePoint(column: number, row: number, edge: CellEdge): LatticePoint {
  switch (edge) {
    case 0: return { x: 2 * column + 1, y: 2 * row };
    case 1: return { x: 2 * column + 2, y: 2 * row + 1 };
    case 2: return { x: 2 * column + 1, y: 2 * row + 2 };
    case 3: return { x: 2 * column, y: 2 * row + 1 };
  }
}

function addNeighbor(adjacency: Map<string, Set<string>>, key: string, neighbor: string): void {
  const neighbors = adjacency.get(key) ?? new Set<string>();
  neighbors.add(neighbor);
  adjacency.set(key, neighbors);
}

function latticeKey(point: LatticePoint): string {
  return `${point.x},${point.y}`;
}

function parseLatticeKey(key: string): readonly [number, number] {
  const [x = "0", y = "0"] = key.split(",");
  return [Number(x), Number(y)];
}

function compareLatticeKeys(first: string, second: string): number {
  const [firstX, firstY] = parseLatticeKey(first);
  const [secondX, secondY] = parseLatticeKey(second);
  return firstY - secondY || firstX - secondX;
}

function undirectedEdgeKey(first: string, second: string): string {
  return compareLatticeKeys(first, second) <= 0 ? `${first}|${second}` : `${second}|${first}`;
}

function requirePoint(points: ReadonlyMap<string, LatticePoint>, key: string): LatticePoint {
  const point = points.get(key);
  if (!point) throw new Error(`Missing custom-contour point ${key}.`);
  return point;
}

function simplifyClosedLoop(loop: readonly Point2D[]): Point2D[] {
  let simplified = loop.map((point) => ({ ...point }));
  let changed = true;
  while (changed && simplified.length > 3) {
    changed = false;
    const next: Point2D[] = [];
    for (let index = 0; index < simplified.length; index += 1) {
      const previous = simplified[(index - 1 + simplified.length) % simplified.length]!;
      const current = simplified[index]!;
      const following = simplified[(index + 1) % simplified.length]!;
      const cross =
        (current.x - previous.x) * (following.y - current.y) -
        (current.y - previous.y) * (following.x - current.x);
      const forwardDot =
        (current.x - previous.x) * (following.x - current.x) +
        (current.y - previous.y) * (following.y - current.y);
      if (Math.abs(cross) <= GEOMETRY_EPSILON && forwardDot >= 0) {
        changed = true;
      } else {
        next.push(current);
      }
    }
    simplified = next;
  }
  return simplified;
}

function smoothClosedLoop(loop: readonly Point2D[], passCount: number): Point2D[] {
  let smoothed = loop.map((point) => ({ ...point }));
  for (let pass = 0; pass < passCount; pass += 1) {
    const next: Point2D[] = [];
    for (let index = 0; index < smoothed.length; index += 1) {
      const start = smoothed[index]!;
      const end = smoothed[(index + 1) % smoothed.length]!;
      next.push(
        { x: 0.75 * start.x + 0.25 * end.x, y: 0.75 * start.y + 0.25 * end.y },
        { x: 0.25 * start.x + 0.75 * end.x, y: 0.25 * start.y + 0.75 * end.y },
      );
    }
    smoothed = next;
  }
  return smoothed;
}

/**
 * Circular Douglas-Peucker simplification removes the tiny alternating
 * half-cell steps introduced by rasterization before corner cutting. The full
 * topology and solver-node classification checks still gate the result.
 */
function simplifyLoopWithinTolerance(
  loop: readonly Point2D[],
  mask: Pick<ShapeMask, "width" | "height">,
  toleranceInGridSteps: number,
): Point2D[] {
  if (loop.length < 5 || toleranceInGridSteps <= 0) return loop.map((point) => ({ ...point }));
  const anchor = canonicalLoopAnchor(loop);
  const ordered = [
    ...loop.slice(anchor),
    ...loop.slice(0, anchor),
  ].map((point) => ({ ...point }));
  ordered.push({ ...ordered[0]! });
  const tolerance =
    toleranceInGridSteps * Math.min(2 / (mask.width + 1), 2 / (mask.height + 1));
  const simplified = simplifyOpenPolyline(ordered, tolerance * tolerance);
  if (
    simplified.length > 1 &&
    squaredPointDistance(simplified[0]!, simplified[simplified.length - 1]!) <=
      GEOMETRY_EPSILON ** 2
  ) {
    simplified.pop();
  }
  return simplified.length >= 3 ? simplified : loop.map((point) => ({ ...point }));
}

function canonicalLoopAnchor(loop: readonly Point2D[]): number {
  let anchor = 0;
  for (let index = 1; index < loop.length; index += 1) {
    const point = loop[index]!;
    const current = loop[anchor]!;
    if (point.y < current.y || (point.y === current.y && point.x < current.x)) anchor = index;
  }
  return anchor;
}

function simplifyOpenPolyline(
  points: readonly Point2D[],
  toleranceSquared: number,
): Point2D[] {
  if (points.length <= 2) return points.map((point) => ({ ...point }));
  let furthestIndex = -1;
  let furthestDistance = toleranceSquared;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (let index = 1; index < points.length - 1; index += 1) {
    const distance = pointToSegmentDistanceSquared(points[index]!, first, last);
    if (distance > furthestDistance) {
      furthestDistance = distance;
      furthestIndex = index;
    }
  }
  if (furthestIndex < 0) return [{ ...first }, { ...last }];
  const before = simplifyOpenPolyline(points.slice(0, furthestIndex + 1), toleranceSquared);
  const after = simplifyOpenPolyline(points.slice(furthestIndex), toleranceSquared);
  return [...before.slice(0, -1), ...after];
}

function squaredPointDistance(first: Point2D, second: Point2D): number {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2;
}

function contourNestingDepths(loops: readonly (readonly Point2D[])[]): readonly number[] {
  return loops.map((loop, index) => {
    const probe = findInteriorProbe(loop);
    let depth = 0;
    for (let other = 0; other < loops.length; other += 1) {
      if (other !== index && pointInPolygon(probe, loops[other]!, false)) depth += 1;
    }
    return depth;
  });
}

function findInteriorProbe(loop: readonly Point2D[]): Point2D {
  const orientation = Math.sign(signedArea(loop)) || 1;
  for (let index = 0; index < loop.length; index += 1) {
    const start = loop[index]!;
    const end = loop[(index + 1) % loop.length]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length <= GEOMETRY_EPSILON) continue;
    const midpoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    for (const scale of [1e-7, 1e-6, 1e-5, 1e-4]) {
      const probe = {
        x: midpoint.x + (orientation * -dy * scale) / length,
        y: midpoint.y + (orientation * dx * scale) / length,
      };
      if (pointInPolygon(probe, loop, false)) return probe;
    }
  }
  throw new Error("Could not locate an interior probe for a custom contour loop.");
}

function signedArea(loop: readonly Point2D[]): number {
  let twiceArea = 0;
  for (let index = 0; index < loop.length; index += 1) {
    const current = loop[index]!;
    const next = loop[(index + 1) % loop.length]!;
    twiceArea += current.x * next.y - current.y * next.x;
  }
  return twiceArea / 2;
}

function loopSelfIntersects(loop: readonly Point2D[]): boolean {
  for (let first = 0; first < loop.length; first += 1) {
    const firstEnd = (first + 1) % loop.length;
    for (let second = first + 1; second < loop.length; second += 1) {
      const secondEnd = (second + 1) % loop.length;
      if (first === second || firstEnd === second || secondEnd === first) continue;
      if (segmentsIntersect(loop[first]!, loop[firstEnd]!, loop[second]!, loop[secondEnd]!)) {
        return true;
      }
    }
  }
  return false;
}

function loopsIntersect(first: readonly Point2D[], second: readonly Point2D[]): boolean {
  for (let left = 0; left < first.length; left += 1) {
    for (let right = 0; right < second.length; right += 1) {
      if (
        segmentsIntersect(
          first[left]!,
          first[(left + 1) % first.length]!,
          second[right]!,
          second[(right + 1) % second.length]!,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function segmentsIntersect(a: Point2D, b: Point2D, c: Point2D, d: Point2D): boolean {
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);
  if (abC * abD < -GEOMETRY_EPSILON && cdA * cdB < -GEOMETRY_EPSILON) return true;
  return (
    (Math.abs(abC) <= GEOMETRY_EPSILON && pointOnClosedSegment(c, a, b)) ||
    (Math.abs(abD) <= GEOMETRY_EPSILON && pointOnClosedSegment(d, a, b)) ||
    (Math.abs(cdA) <= GEOMETRY_EPSILON && pointOnClosedSegment(a, c, d)) ||
    (Math.abs(cdB) <= GEOMETRY_EPSILON && pointOnClosedSegment(b, c, d))
  );
}

function orientation(a: Point2D, b: Point2D, c: Point2D): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnClosedSegment(point: Point2D, start: Point2D, end: Point2D): boolean {
  return (
    point.x >= Math.min(start.x, end.x) - GEOMETRY_EPSILON &&
    point.x <= Math.max(start.x, end.x) + GEOMETRY_EPSILON &&
    point.y >= Math.min(start.y, end.y) - GEOMETRY_EPSILON &&
    point.y <= Math.max(start.y, end.y) + GEOMETRY_EPSILON
  );
}

function minimumBoundaryDistanceSquared(
  loops: readonly (readonly Point2D[])[],
  point: Point2D,
): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const loop of loops) {
    for (let index = 0; index < loop.length; index += 1) {
      minimum = Math.min(
        minimum,
        pointToSegmentDistanceSquared(point, loop[index]!, loop[(index + 1) % loop.length]!),
      );
    }
  }
  return minimum;
}

function pointToSegmentDistanceSquared(point: Point2D, start: Point2D, end: Point2D): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= Number.EPSILON) {
    return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  }
  const fraction = Math.min(
    1,
    Math.max(0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared),
  );
  const offsetX = point.x - (start.x + fraction * dx);
  const offsetY = point.y - (start.y + fraction * dy);
  return offsetX * offsetX + offsetY * offsetY;
}

function assertBinaryMask(mask: ShapeMask): void {
  if (!Number.isInteger(mask.width) || !Number.isInteger(mask.height) || mask.width < 1 || mask.height < 1) {
    throw new RangeError("Custom mask dimensions must be positive integers.");
  }
  if (mask.data.length !== mask.width * mask.height) {
    throw new RangeError("Custom mask storage does not match its dimensions.");
  }
  for (const value of mask.data) {
    if (value !== 0 && value !== 1 && value !== 255) {
      throw new RangeError("Custom mask entries must be binary.");
    }
  }
}

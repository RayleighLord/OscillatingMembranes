import { getShapeMetadata, normalizeShapeParameters } from "./catalog";
import { pointInPolygon, regularPolygonVertices } from "./geometry";
import {
  createEmptyMask,
  createMaskFromPredicate,
  normalizeGridDimensions,
  retainLargestFourConnectedComponent,
} from "./mask";
import type {
  GridDimensions,
  Point2D,
  ShapeGenerationOptions,
  ShapeKey,
  ShapeMask,
  ShapeParameters,
  ShapePredicate,
  ShapeVisualBoundary,
} from "./types";
import { DEFAULT_GRID_SIZE } from "./types";

const DEFAULT_POLYGON_RADIUS = 0.8;
const DEFAULT_RECTANGLE_HALF_SPAN = 0.8;
const ANNULUS_OUTER_RADIUS = 0.82;

function parameterValue(
  parameters: ShapeParameters,
  key: string,
  fallback: number,
): number {
  const value = parameters[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function circlePredicate(radius: number): ShapePredicate {
  const radiusSquared = radius * radius;
  return (x, y) => x * x + y * y <= radiusSquared;
}

export function rectanglePredicate(aspectRatio: number): ShapePredicate {
  const { halfWidth, halfHeight } = rectangleHalfSpans(aspectRatio);
  return (x, y) => Math.abs(x) <= halfWidth && Math.abs(y) <= halfHeight;
}

function rectangleHalfSpans(aspectRatio: number): {
  readonly halfWidth: number;
  readonly halfHeight: number;
} {
  const safeAspectRatio = Math.max(Number.EPSILON, aspectRatio);
  const halfWidth =
    safeAspectRatio >= 1
      ? DEFAULT_RECTANGLE_HALF_SPAN
      : DEFAULT_RECTANGLE_HALF_SPAN * safeAspectRatio;
  const halfHeight =
    safeAspectRatio >= 1
      ? DEFAULT_RECTANGLE_HALF_SPAN / safeAspectRatio
      : DEFAULT_RECTANGLE_HALF_SPAN;
  return { halfWidth, halfHeight };
}

export function triangleVertices(skew: number): readonly Point2D[] {
  return [
    { x: -0.8, y: -0.7 },
    { x: 0.8, y: -0.7 },
    { x: skew, y: 0.82 },
  ];
}

export function polygonPredicate(
  polygon: readonly Point2D[],
): ShapePredicate {
  return (x, y) => pointInPolygon({ x, y }, polygon);
}

/**
 * Exact level-set predicate used by MIT 18.06's Dense-and-Sparse notebook:
 * exp(-(r - theta*0.5/pi - 0.5)^2 / 0.3^2) - 0.5 > 0.
 */
export function isInsideMitSpiral(x: number, y: number): boolean {
  const radius = Math.hypot(x, y);
  const theta = Math.atan2(y, x);
  const radialOffset = radius - (theta * 0.5) / Math.PI - 0.5;
  const levelSet =
    Math.exp(-(radialOffset * radialOffset) / (0.3 * 0.3)) - 0.5;
  return levelSet > 0;
}

export function annulusPredicate(innerRadius: number): ShapePredicate {
  const innerSquared = innerRadius * innerRadius;
  const outerSquared = ANNULUS_OUTER_RADIUS * ANNULUS_OUTER_RADIUS;
  return (x, y) => {
    const radiusSquared = x * x + y * y;
    return radiusSquared >= innerSquared && radiusSquared <= outerSquared;
  };
}

export function getShapePredicate(
  key: Exclude<ShapeKey, "custom">,
  values: ShapeParameters = {},
): ShapePredicate {
  const parameters = normalizeShapeParameters(key, values);
  const defaults = getShapeMetadata(key).defaultParameters;

  switch (key) {
    case "circle":
      return circlePredicate(
        parameterValue(parameters, "radius", defaults.radius ?? 0.8),
      );
    case "rectangle":
      return rectanglePredicate(
        parameterValue(
          parameters,
          "aspectRatio",
          defaults.aspectRatio ?? 1.35,
        ),
      );
    case "triangle":
      return polygonPredicate(
        triangleVertices(
          parameterValue(parameters, "skew", defaults.skew ?? 0),
        ),
      );
    case "pentagon":
      return polygonPredicate(
        regularPolygonVertices(
          5,
          DEFAULT_POLYGON_RADIUS,
          parameterValue(
            parameters,
            "rotationDeg",
            defaults.rotationDeg ?? 90,
          ),
        ),
      );
    case "hexagon":
      return polygonPredicate(
        regularPolygonVertices(
          6,
          DEFAULT_POLYGON_RADIUS,
          parameterValue(
            parameters,
            "rotationDeg",
            defaults.rotationDeg ?? 0,
          ),
        ),
      );
    case "spiral":
      return isInsideMitSpiral;
    case "annulus":
      return annulusPredicate(
        parameterValue(
          parameters,
          "innerRadius",
          defaults.innerRadius ?? 0.38,
        ),
      );
  }
}

/**
 * Return the smooth visual edge corresponding to a predefined shape. This is
 * deliberately separate from generateShapeMask: changing it never changes
 * the finite-difference matrix or its eigenvalues.
 */
export function getShapeVisualBoundary(
  key: ShapeKey,
  values: ShapeParameters = {},
): ShapeVisualBoundary | undefined {
  if (key === "custom") return undefined;
  if (key === "spiral") return { kind: "mit-spiral" };

  const parameters = normalizeShapeParameters(key, values);
  const defaults = getShapeMetadata(key).defaultParameters;
  switch (key) {
    case "circle":
      return {
        kind: "radial",
        outerRadius: parameterValue(parameters, "radius", defaults.radius ?? 0.8),
      };
    case "annulus":
      return {
        kind: "radial",
        outerRadius: ANNULUS_OUTER_RADIUS,
        innerRadius: parameterValue(
          parameters,
          "innerRadius",
          defaults.innerRadius ?? 0.38,
        ),
      };
    case "rectangle": {
      const { halfWidth, halfHeight } = rectangleHalfSpans(
        parameterValue(parameters, "aspectRatio", defaults.aspectRatio ?? 1.35),
      );
      return {
        kind: "polygon",
        vertices: [
          { x: -halfWidth, y: -halfHeight },
          { x: halfWidth, y: -halfHeight },
          { x: halfWidth, y: halfHeight },
          { x: -halfWidth, y: halfHeight },
        ],
      };
    }
    case "triangle":
      return {
        kind: "polygon",
        vertices: triangleVertices(
          parameterValue(parameters, "skew", defaults.skew ?? 0),
        ),
      };
    case "pentagon":
      return {
        kind: "polygon",
        vertices: regularPolygonVertices(
          5,
          DEFAULT_POLYGON_RADIUS,
          parameterValue(parameters, "rotationDeg", defaults.rotationDeg ?? 90),
        ),
      };
    case "hexagon":
      return {
        kind: "polygon",
        vertices: regularPolygonVertices(
          6,
          DEFAULT_POLYGON_RADIUS,
          parameterValue(parameters, "rotationDeg", defaults.rotationDeg ?? 0),
        ),
      };
  }
}

export function generateShapeMask(
  key: ShapeKey,
  options: ShapeGenerationOptions = {},
): ShapeMask {
  const grid = normalizeGridDimensions(options.grid ?? DEFAULT_GRID_SIZE);
  if (key === "custom") {
    return createEmptyMask(grid);
  }

  const generated = createMaskFromPredicate(
    getShapePredicate(key, options.parameters),
    grid,
  );
  return options.retainLargestComponent === false
    ? generated
    : retainLargestFourConnectedComponent(generated);
}

/** Stable, parameter-order-independent identifier for memoized eigenmodes. */
export function getShapeInstanceKey(
  key: ShapeKey,
  values: ShapeParameters = {},
  grid: number | GridDimensions = DEFAULT_GRID_SIZE,
): string {
  const dimensions = normalizeGridDimensions(grid);
  const parameters = normalizeShapeParameters(key, values);
  const serializedParameters = getShapeMetadata(key).parameters
    .map((item) => `${item.key}=${String(parameters[item.key])}`)
    .join("&");
  return `${key}@${dimensions.width}x${dimensions.height}${
    serializedParameters.length > 0 ? `?${serializedParameters}` : ""
  }`;
}

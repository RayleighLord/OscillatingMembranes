import type {
  ShapeKey,
  ShapeMetadata,
  ShapeParameterMetadata,
  ShapeParameters,
} from "./types";

function parameter(
  metadata: ShapeParameterMetadata,
): ShapeParameterMetadata {
  return Object.freeze({ ...metadata });
}

const RADIUS = parameter({
  key: "radius",
  label: "Radius",
  min: 0.55,
  max: 0.88,
  step: 0.01,
  defaultValue: 0.8,
  unit: "normalized",
});

const ASPECT_RATIO = parameter({
  key: "aspectRatio",
  label: "Width / height",
  min: 0.55,
  max: 1.8,
  step: 0.05,
  defaultValue: 1.35,
  unit: "ratio",
});

const TRIANGLE_SKEW = parameter({
  key: "skew",
  label: "Apex offset",
  min: -0.5,
  max: 0.5,
  step: 0.05,
  defaultValue: 0,
  unit: "normalized",
});

const PENTAGON_ROTATION = parameter({
  key: "rotationDeg",
  label: "Rotation",
  min: -180,
  max: 180,
  step: 5,
  defaultValue: 90,
  unit: "degrees",
});

const HEXAGON_ROTATION = parameter({
  key: "rotationDeg",
  label: "Rotation",
  min: -180,
  max: 180,
  step: 5,
  defaultValue: 0,
  unit: "degrees",
});

const ANNULUS_INNER_RADIUS = parameter({
  key: "innerRadius",
  label: "Inner radius",
  min: 0.18,
  max: 0.65,
  step: 0.01,
  defaultValue: 0.38,
  unit: "normalized",
});

function defineShape(
  key: ShapeKey,
  label: string,
  description: string,
  category: ShapeMetadata["category"],
  parameters: readonly ShapeParameterMetadata[],
): ShapeMetadata {
  const frozenParameters = Object.freeze([...parameters]);
  const defaultParameters = Object.freeze(
    Object.fromEntries(
      frozenParameters.map((item) => [item.key, item.defaultValue]),
    ) as Record<string, number>,
  );
  return Object.freeze({
    key,
    label,
    description,
    category,
    parameters: frozenParameters,
    defaultParameters,
  });
}

const CIRCLE = defineShape(
  "circle",
  "Circle",
  "A circular fixed-edge membrane.",
  "classic",
  [RADIUS],
);

const RECTANGLE = defineShape(
  "rectangle",
  "Rectangle",
  "A rectangle with an adjustable width-to-height ratio.",
  "classic",
  [ASPECT_RATIO],
);

const TRIANGLE = defineShape(
  "triangle",
  "Triangle",
  "A triangular membrane with an adjustable apex skew.",
  "classic",
  [TRIANGLE_SKEW],
);

const PENTAGON = defineShape(
  "pentagon",
  "Pentagon",
  "A rotatable regular pentagonal membrane.",
  "classic",
  [PENTAGON_ROTATION],
);

const HEXAGON = defineShape(
  "hexagon",
  "Hexagon",
  "A rotatable regular hexagonal membrane.",
  "classic",
  [HEXAGON_ROTATION],
);

const SPIRAL = defineShape(
  "spiral",
  "Spiral",
  "The one-turn spiral domain from MIT 18.06's sparse-eigenproblem notebook.",
  "special",
  [],
);

const ANNULUS = defineShape(
  "annulus",
  "Annulus",
  "A ring-shaped membrane with an adjustable central opening.",
  "special",
  [ANNULUS_INNER_RADIUS],
);

const CUSTOM = defineShape(
  "custom",
  "Draw your own",
  "Paint a connected membrane directly on the grid.",
  "custom",
  [],
);

export const SHAPE_CATALOG: readonly ShapeMetadata[] = Object.freeze([
  CIRCLE,
  RECTANGLE,
  TRIANGLE,
  PENTAGON,
  HEXAGON,
  SPIRAL,
  ANNULUS,
  CUSTOM,
]);

export const SHAPE_METADATA: Readonly<Record<ShapeKey, ShapeMetadata>> =
  Object.freeze({
    circle: CIRCLE,
    rectangle: RECTANGLE,
    triangle: TRIANGLE,
    pentagon: PENTAGON,
    hexagon: HEXAGON,
    spiral: SPIRAL,
    annulus: ANNULUS,
    custom: CUSTOM,
  });

export function isShapeKey(value: string): value is ShapeKey {
  return Object.prototype.hasOwnProperty.call(SHAPE_METADATA, value);
}

export function getShapeMetadata(key: ShapeKey): ShapeMetadata {
  return SHAPE_METADATA[key];
}

export function getDefaultShapeParameters(key: ShapeKey): ShapeParameters {
  return SHAPE_METADATA[key].defaultParameters;
}

/** Drops unknown values, replaces non-finite values, and clamps known values. */
export function normalizeShapeParameters(
  key: ShapeKey,
  values: ShapeParameters = {},
): ShapeParameters {
  const normalized: Record<string, number> = {};
  for (const item of SHAPE_METADATA[key].parameters) {
    const candidate = values[item.key];
    const finiteValue =
      typeof candidate === "number" && Number.isFinite(candidate)
        ? candidate
        : item.defaultValue;
    normalized[item.key] = Math.min(item.max, Math.max(item.min, finiteValue));
  }
  return Object.freeze(normalized);
}

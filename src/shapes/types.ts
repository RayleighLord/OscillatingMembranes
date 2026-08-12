export const DEFAULT_GRID_SIZE = 49;
/** Higher-resolution numerical grid reserved for hand-drawn domains. */
export const CUSTOM_GRID_SIZE = 81;
/** Same minimum physical drawing area as 45 cells on the 49-point grid. */
export const CUSTOM_MIN_ACTIVE_CELLS = 123;

export const SHAPE_KEYS = [
  "circle",
  "rectangle",
  "triangle",
  "pentagon",
  "hexagon",
  "spiral",
  "annulus",
  "custom",
] as const;

export type ShapeKey = (typeof SHAPE_KEYS)[number];

export const DEFAULT_SHAPE_KEY: ShapeKey = "circle";

export type ShapeCategory = "classic" | "special" | "custom";

export type ShapeParameterKey =
  | "radius"
  | "aspectRatio"
  | "skew"
  | "rotationDeg"
  | "innerRadius";

export type ShapeParameters = Readonly<Record<string, number>>;

export interface ShapeParameterMetadata {
  readonly key: ShapeParameterKey;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
  readonly unit?: "normalized" | "ratio" | "degrees";
}

export interface ShapeMetadata {
  readonly key: ShapeKey;
  readonly label: string;
  readonly description: string;
  readonly category: ShapeCategory;
  readonly parameters: readonly ShapeParameterMetadata[];
  readonly defaultParameters: ShapeParameters;
}

export interface GridDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * A row-major binary mask. `data[row * width + column] !== 0` means that the
 * corresponding membrane degree of freedom is active.
 */
export interface ShapeMask extends GridDimensions {
  readonly data: Uint8Array;
}

export interface Point2D {
  readonly x: number;
  readonly y: number;
}

/**
 * Analytic boundary used only to draw a smooth fixed edge. Coordinates use
 * the same normalized [-1, 1] plane as shape predicates and rasterization.
 * The numerical eigenproblem continues to use the binary ShapeMask.
 */
export type ShapeVisualBoundary =
  | {
      readonly kind: "mit-spiral";
    }
  | {
      /**
       * Simple, implicitly closed loops filled with the even-odd rule. The
       * loops are a render-only contour; the finite-difference mask remains
       * the accepted numerical domain.
       */
      readonly kind: "contours";
      readonly loops: readonly (readonly Point2D[])[];
    }
  | {
      readonly kind: "polygon";
      readonly vertices: readonly Point2D[];
    }
  | {
      readonly kind: "radial";
      readonly outerRadius: number;
      readonly innerRadius?: number;
    };

export type ShapePredicate = (x: number, y: number) => boolean;

export interface MaskBounds {
  readonly minColumn: number;
  readonly maxColumn: number;
  readonly minRow: number;
  readonly maxRow: number;
  readonly width: number;
  readonly height: number;
}

export type MaskValidationIssueCode =
  | "invalid-dimensions"
  | "invalid-data-length"
  | "non-binary-data"
  | "empty"
  | "too-few-cells"
  | "disconnected"
  | "touches-grid-edge";

export interface MaskValidationIssue {
  readonly code: MaskValidationIssueCode;
  readonly message: string;
}

export interface MaskValidationOptions {
  /** Minimum number of active cells needed for a useful eigenproblem. */
  readonly minActiveCells?: number;
  /** Treat multiple four-connected components as an error. Defaults to true. */
  readonly requireSingleComponent?: boolean;
  /** Report contact with the outermost grid cells as a warning. */
  readonly warnWhenTouchingGridEdge?: boolean;
}

export interface MaskValidationResult {
  readonly valid: boolean;
  readonly errors: readonly MaskValidationIssue[];
  readonly warnings: readonly MaskValidationIssue[];
  readonly activeCellCount: number;
  readonly componentCount: number;
  readonly largestComponentSize: number;
  readonly bounds: MaskBounds | null;
}

export interface ShapeGenerationOptions {
  readonly grid?: number | GridDimensions;
  readonly parameters?: ShapeParameters;
  /** Remove raster islands, retaining the deterministic largest component. */
  readonly retainLargestComponent?: boolean;
}

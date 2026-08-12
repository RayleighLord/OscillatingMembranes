export {
  CUSTOM_GRID_SIZE,
  CUSTOM_MIN_ACTIVE_CELLS,
  DEFAULT_GRID_SIZE,
  DEFAULT_SHAPE_KEY,
  SHAPE_KEYS,
} from "./types";
export type {
  GridDimensions,
  MaskBounds,
  MaskValidationIssue,
  MaskValidationIssueCode,
  MaskValidationOptions,
  MaskValidationResult,
  Point2D,
  ShapeCategory,
  ShapeGenerationOptions,
  ShapeKey,
  ShapeMask,
  ShapeMetadata,
  ShapeParameterKey,
  ShapeParameterMetadata,
  ShapeParameters,
  ShapePredicate,
  ShapeVisualBoundary,
} from "./types";

export {
  degreesToRadians,
  pointInPolygon,
  pointOnSegment,
  regularPolygonVertices,
} from "./geometry";

export {
  cloneMask,
  countActiveCells,
  createEmptyMask,
  createFilledMask,
  createMaskFromPolygon,
  createMaskFromPredicate,
  getFourConnectedComponents,
  getMaskBounds,
  interiorGridCoordinate,
  isMaskCellActive,
  maskIndex,
  normalizeBinaryMask,
  normalizeGridDimensions,
  retainLargestFourConnectedComponent,
  setMaskCell,
  validateMask,
} from "./mask";

export {
  createCustomVisualBoundary,
  isPointInsideContourBoundary,
  traceMaskContourLoops,
} from "./custom-boundary";
export type { CustomVisualBoundaryOptions } from "./custom-boundary";

export {
  SHAPE_CATALOG,
  SHAPE_METADATA,
  getDefaultShapeParameters,
  getShapeMetadata,
  isShapeKey,
  normalizeShapeParameters,
} from "./catalog";

export {
  annulusPredicate,
  circlePredicate,
  generateShapeMask,
  getShapeInstanceKey,
  getShapePredicate,
  getShapeVisualBoundary,
  isInsideMitSpiral,
  polygonPredicate,
  rectanglePredicate,
  triangleVertices,
} from "./generators";

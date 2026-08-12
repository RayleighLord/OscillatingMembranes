export type BinaryMask = ArrayLike<number | boolean>;

export type SolverProgressStage =
  | "preparing"
  | "factorizing"
  | "iterating"
  | "finalizing";

export interface SolverProgress {
  readonly stage: SolverProgressStage;
  /** Overall progress in the closed interval [0, 1]. */
  readonly fraction: number;
  readonly basisSize: number;
  readonly convergedModes: number;
}

export type SolverProgressCallback = (progress: SolverProgress) => void;

export interface MembraneSolverOptions {
  /** Number of distinct-frequency modes to return. Defaults to 20. */
  readonly modeCount?: number;
  /** Physical distance between adjacent grid nodes. Defaults to 1. */
  readonly gridSpacing?: number;
  /** Membrane wave speed used for angular frequencies. Defaults to 1. */
  readonly waveSpeed?: number;
  /** Keep only the largest four-connected component. Defaults to true. */
  readonly keepLargestComponent?: boolean;
  /**
   * Relative angular-frequency tolerance used only for numerically equal
   * eigenvalues. Defaults to 1e-8; close frequencies are not degeneracies.
   */
  readonly degeneracyTolerance?: number;
  /**
   * Optional rotational symmetry used to recognize raster-split continuum
   * doublets. A number is the exact finite rotation order; "continuous" is
   * appropriate for circles and annuli.
   */
  readonly rotationalSymmetry?: number | "continuous";
  /** Relative eigenpair residual required for convergence. */
  readonly residualTolerance?: number;
  /** Lanczos dimension at the first convergence check. */
  readonly initialBasisSize?: number;
  /** Additional Lanczos vectors generated after an unsuccessful check. */
  readonly basisStep?: number;
  /** Hard cap on the Lanczos basis dimension. */
  readonly maxBasisSize?: number;
  /** Deterministic nonzero seed for the starting vector. */
  readonly randomSeed?: number;
  readonly onProgress?: SolverProgressCallback;
}

export type SerializableMembraneSolverOptions = Omit<
  MembraneSolverOptions,
  "onProgress"
>;

export interface MembraneEigenmode {
  /** One-based index after degeneracy filtering. */
  readonly modeNumber: number;
  /** Eigenvalue of the unscaled five-point stencil. */
  readonly discreteEigenvalue: number;
  /** Eigenvalue of -Delta, equal to discreteEigenvalue / gridSpacing^2. */
  readonly eigenvalue: number;
  /** c * sqrt(eigenvalue). */
  readonly angularFrequency: number;
  /** angularFrequency / fundamentalAngularFrequency. */
  readonly frequencyRatio: number;
  /** ||Lv - mu v||_2 / (mu ||v||_2). */
  readonly relativeResidual: number;
  /** Row-major max-absolute-one field; values outside the domain are zero. */
  readonly values: Float32Array;
}

export interface MembraneEigenSolution {
  readonly width: number;
  readonly height: number;
  readonly gridSpacing: number;
  readonly waveSpeed: number;
  readonly activeNodeCount: number;
  readonly removedNodeCount: number;
  /** Cleaned row-major binary mask actually used by the solver. */
  readonly mask: Uint8Array;
  readonly modes: readonly MembraneEigenmode[];
  readonly basisSize: number;
  readonly convergedRawModeCount: number;
}

export type EigenmodeSolverErrorCode =
  | "INVALID_INPUT"
  | "DOMAIN_TOO_SMALL"
  | "FACTORIZATION_FAILED"
  | "NO_CONVERGENCE";

export interface EigenWorkerSolveRequest {
  readonly type: "solve";
  readonly requestId: number;
  readonly width: number;
  readonly height: number;
  readonly mask: Uint8Array;
  readonly options?: SerializableMembraneSolverOptions;
}

export interface EigenWorkerProgressResponse {
  readonly type: "progress";
  readonly requestId: number;
  readonly progress: SolverProgress;
}

export interface EigenWorkerResultResponse {
  readonly type: "result";
  readonly requestId: number;
  readonly solution: MembraneEigenSolution;
}

export interface EigenWorkerErrorResponse {
  readonly type: "error";
  readonly requestId: number;
  readonly code: EigenmodeSolverErrorCode | "UNKNOWN";
  readonly message: string;
}

export type EigenWorkerResponse =
  | EigenWorkerProgressResponse
  | EigenWorkerResultResponse
  | EigenWorkerErrorResponse;

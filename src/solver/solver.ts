import type {
  BinaryMask,
  EigenmodeSolverErrorCode,
  MembraneEigenSolution,
  MembraneEigenmode,
  MembraneSolverOptions,
  SolverProgress,
  SolverProgressCallback
} from "./types";

const DEFAULT_MODE_COUNT = 20;
const DEFAULT_GRID_SPACING = 1;
const DEFAULT_WAVE_SPEED = 1;
const DEFAULT_DEGENERACY_TOLERANCE = 1e-8;
const DEFAULT_RESIDUAL_TOLERANCE = 2e-6;
const DEFAULT_INITIAL_BASIS_SIZE = 96;
const DEFAULT_BASIS_STEP = 32;
const DEFAULT_MAX_BASIS_SIZE = 224;
const DEFAULT_RANDOM_SEED = 0x6d2b79f5;
const EXTRA_UNIQUE_MODE_GUARD = 4;
const MAX_QL_ITERATIONS = 80;
const MAX_SYMMETRY_DOUBLET_GAP = 3e-2;
const MIN_SYMMETRY_SUBSPACE_CAPTURE = 0.8;
const MIN_SYMMETRY_PARTNER_CAPTURE = 0.5;

interface ResolvedSolverOptions {
  readonly modeCount: number;
  readonly gridSpacing: number;
  readonly waveSpeed: number;
  readonly keepLargestComponent: boolean;
  readonly degeneracyTolerance: number;
  readonly rotationalSymmetry: number | "continuous" | undefined;
  readonly residualTolerance: number;
  readonly initialBasisSize: number;
  readonly basisStep: number;
  readonly maxBasisSize: number;
  readonly randomSeed: number;
  readonly onProgress: SolverProgressCallback | undefined;
}

interface CleanMaskResult {
  readonly mask: Uint8Array;
  readonly activeNodeCount: number;
  readonly removedNodeCount: number;
}

interface DiscreteSystem {
  readonly width: number;
  readonly height: number;
  readonly nodeCount: number;
  readonly mask: Uint8Array;
  readonly idByGridIndex: Int32Array;
  readonly gridIndexById: Int32Array;
  readonly neighbors: Int32Array;
  readonly bandwidth: number;
  readonly lowerBand: Float64Array;
}

interface BandedCholesky {
  readonly nodeCount: number;
  readonly bandwidth: number;
  readonly stride: number;
  readonly values: Float64Array;
}

interface RawEigenmode {
  readonly discreteEigenvalue: number;
  readonly relativeResidual: number;
  readonly vector: Float64Array;
}

interface LanczosAnalysis {
  readonly basisSize: number;
  readonly convergedRawModeCount: number;
  readonly uniqueModes: readonly RawEigenmode[];
}

interface TridiagonalEigenResult {
  readonly values: Float64Array;
  /** Row-major matrix whose columns are normalized eigenvectors. */
  readonly vectors: Float64Array;
}

export class EigenmodeSolverError extends Error {
  readonly code: EigenmodeSolverErrorCode;

  constructor(code: EigenmodeSolverErrorCode, message: string) {
    super(message);
    this.name = "EigenmodeSolverError";
    this.code = code;
  }
}

/**
 * Solve the fixed-edge membrane eigenproblem on an arbitrary row-major mask.
 *
 * Active mask entries are unknowns. Inactive neighbors are zero-valued
 * Dirichlet points, so every active node retains a stencil diagonal of four.
 * All numerical work is Float64; only the returned full-grid fields are
 * converted to Float32 for efficient rendering and worker transfer.
 */
export function solveMembraneModes(
  mask: BinaryMask,
  width: number,
  height: number,
  options: MembraneSolverOptions = {}
): MembraneEigenSolution {
  const resolved = resolveOptions(options);
  validateGridDimensions(width, height, mask.length);
  emitProgress(resolved.onProgress, "preparing", 0, 0, 0);

  const cleaned = cleanMask(
    mask,
    width,
    height,
    resolved.keepLargestComponent
  );
  if (cleaned.activeNodeCount < resolved.modeCount) {
    throw new EigenmodeSolverError(
      "DOMAIN_TOO_SMALL",
      `The domain has ${cleaned.activeNodeCount} active nodes, but ${resolved.modeCount} modes were requested.`
    );
  }

  const system = buildDiscreteSystem(cleaned.mask, width, height);
  emitProgress(resolved.onProgress, "preparing", 0.1, 0, 0);

  const factor = factorBandedCholesky(system, (completedRows) => {
    const fraction = 0.1 + 0.2 * (completedRows / system.nodeCount);
    emitProgress(resolved.onProgress, "factorizing", fraction, 0, 0);
  });

  const analysis = runShiftInvertLanczos(system, factor, resolved);
  emitProgress(
    resolved.onProgress,
    "finalizing",
    0.94,
    analysis.basisSize,
    analysis.uniqueModes.length
  );

  const selected = analysis.uniqueModes.slice(0, resolved.modeCount);
  if (selected.length < resolved.modeCount) {
    throw new EigenmodeSolverError(
      "NO_CONVERGENCE",
      `Only ${selected.length} distinct modes converged after a ${analysis.basisSize}-vector Lanczos basis.`
    );
  }

  const fundamental = selected[0];
  if (fundamental === undefined || !(fundamental.discreteEigenvalue > 0)) {
    throw new EigenmodeSolverError(
      "NO_CONVERGENCE",
      "The solver did not produce a positive fundamental eigenvalue."
    );
  }
  const fundamentalAngularFrequency =
    (resolved.waveSpeed * Math.sqrt(fundamental.discreteEigenvalue)) /
    resolved.gridSpacing;

  const modes: MembraneEigenmode[] = selected.map((raw, index) => {
    const eigenvalue =
      raw.discreteEigenvalue / (resolved.gridSpacing * resolved.gridSpacing);
    const angularFrequency = resolved.waveSpeed * Math.sqrt(eigenvalue);
    return {
      modeNumber: index + 1,
      discreteEigenvalue: raw.discreteEigenvalue,
      eigenvalue,
      angularFrequency,
      frequencyRatio: angularFrequency / fundamentalAngularFrequency,
      relativeResidual: raw.relativeResidual,
      values: expandToFullGrid(raw.vector, system)
    };
  });

  emitProgress(
    resolved.onProgress,
    "finalizing",
    1,
    analysis.basisSize,
    modes.length
  );

  return {
    width,
    height,
    gridSpacing: resolved.gridSpacing,
    waveSpeed: resolved.waveSpeed,
    activeNodeCount: cleaned.activeNodeCount,
    removedNodeCount: cleaned.removedNodeCount,
    mask: cleaned.mask,
    modes,
    basisSize: analysis.basisSize,
    convergedRawModeCount: analysis.convergedRawModeCount
  };
}

function resolveOptions(options: MembraneSolverOptions): ResolvedSolverOptions {
  const modeCount = options.modeCount ?? DEFAULT_MODE_COUNT;
  const gridSpacing = options.gridSpacing ?? DEFAULT_GRID_SPACING;
  const waveSpeed = options.waveSpeed ?? DEFAULT_WAVE_SPEED;
  const keepLargestComponent = options.keepLargestComponent ?? true;
  const degeneracyTolerance =
    options.degeneracyTolerance ?? DEFAULT_DEGENERACY_TOLERANCE;
  const rotationalSymmetry = options.rotationalSymmetry;
  const residualTolerance =
    options.residualTolerance ?? DEFAULT_RESIDUAL_TOLERANCE;
  const initialBasisSize =
    options.initialBasisSize ?? DEFAULT_INITIAL_BASIS_SIZE;
  const basisStep = options.basisStep ?? DEFAULT_BASIS_STEP;
  const maxBasisSize = options.maxBasisSize ?? DEFAULT_MAX_BASIS_SIZE;
  const randomSeed = options.randomSeed ?? DEFAULT_RANDOM_SEED;

  assertPositiveInteger(modeCount, "modeCount");
  assertPositiveFinite(gridSpacing, "gridSpacing");
  assertPositiveFinite(waveSpeed, "waveSpeed");
  assertFiniteInRange(
    degeneracyTolerance,
    0,
    0.25,
    "degeneracyTolerance"
  );
  if (
    rotationalSymmetry !== undefined &&
    rotationalSymmetry !== "continuous" &&
    (!Number.isSafeInteger(rotationalSymmetry) || rotationalSymmetry < 3)
  ) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      'rotationalSymmetry must be "continuous" or an integer of at least 3.'
    );
  }
  assertPositiveFinite(residualTolerance, "residualTolerance");
  assertPositiveInteger(initialBasisSize, "initialBasisSize");
  assertPositiveInteger(basisStep, "basisStep");
  assertPositiveInteger(maxBasisSize, "maxBasisSize");
  if (maxBasisSize < initialBasisSize) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      "maxBasisSize must be greater than or equal to initialBasisSize."
    );
  }
  if (modeCount > maxBasisSize) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      "modeCount cannot exceed maxBasisSize."
    );
  }
  if (!Number.isSafeInteger(randomSeed)) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      "randomSeed must be a safe integer."
    );
  }

  return {
    modeCount,
    gridSpacing,
    waveSpeed,
    keepLargestComponent,
    degeneracyTolerance,
    rotationalSymmetry,
    residualTolerance,
    initialBasisSize,
    basisStep,
    maxBasisSize,
    randomSeed,
    onProgress: options.onProgress
  };
}

function validateGridDimensions(
  width: number,
  height: number,
  maskLength: number
): void {
  if (!Number.isSafeInteger(width) || width < 1) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      "width must be a positive safe integer."
    );
  }
  if (!Number.isSafeInteger(height) || height < 1) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      "height must be a positive safe integer."
    );
  }
  const gridSize = width * height;
  if (!Number.isSafeInteger(gridSize) || maskLength !== gridSize) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      `The mask length must equal width * height (${gridSize}).`
    );
  }
}

function cleanMask(
  input: BinaryMask,
  width: number,
  height: number,
  keepLargestComponent: boolean
): CleanMaskResult {
  const gridSize = width * height;
  const mask = new Uint8Array(gridSize);
  let originalActiveCount = 0;
  for (let index = 0; index < gridSize; index += 1) {
    if (Boolean(input[index])) {
      mask[index] = 1;
      originalActiveCount += 1;
    }
  }

  if (!keepLargestComponent || originalActiveCount === 0) {
    return {
      mask,
      activeNodeCount: originalActiveCount,
      removedNodeCount: 0
    };
  }

  const labels = new Int32Array(gridSize);
  labels.fill(-1);
  const queue = new Int32Array(gridSize);
  const componentSizes: number[] = [];
  let label = 0;

  for (let start = 0; start < gridSize; start += 1) {
    if (mask[start] === 0 || labels[start] !== -1) continue;

    let head = 0;
    let tail = 0;
    let size = 0;
    queue[tail] = start;
    tail += 1;
    labels[start] = label;

    while (head < tail) {
      const gridIndex = queue[head];
      head += 1;
      if (gridIndex === undefined) continue;
      size += 1;
      const x = gridIndex % width;
      const y = Math.floor(gridIndex / width);

      if (x > 0) enqueueGridNeighbor(gridIndex - 1);
      if (x + 1 < width) enqueueGridNeighbor(gridIndex + 1);
      if (y > 0) enqueueGridNeighbor(gridIndex - width);
      if (y + 1 < height) enqueueGridNeighbor(gridIndex + width);
    }

    componentSizes.push(size);
    label += 1;

    function enqueueGridNeighbor(neighbor: number): void {
      if (mask[neighbor] === 0 || labels[neighbor] !== -1) return;
      labels[neighbor] = label;
      queue[tail] = neighbor;
      tail += 1;
    }
  }

  let largestLabel = -1;
  let largestSize = 0;
  for (let component = 0; component < componentSizes.length; component += 1) {
    const size = componentSizes[component] ?? 0;
    if (size > largestSize) {
      largestSize = size;
      largestLabel = component;
    }
  }

  if (largestSize === originalActiveCount) {
    return {
      mask,
      activeNodeCount: originalActiveCount,
      removedNodeCount: 0
    };
  }

  const cleaned = new Uint8Array(gridSize);
  for (let index = 0; index < gridSize; index += 1) {
    if (labels[index] === largestLabel) cleaned[index] = 1;
  }
  return {
    mask: cleaned,
    activeNodeCount: largestSize,
    removedNodeCount: originalActiveCount - largestSize
  };
}

function buildDiscreteSystem(
  mask: Uint8Array,
  width: number,
  height: number
): DiscreteSystem {
  const gridSize = width * height;
  const idByGridIndex = new Int32Array(gridSize);
  idByGridIndex.fill(-1);
  let nodeCount = 0;
  for (let gridIndex = 0; gridIndex < gridSize; gridIndex += 1) {
    if (mask[gridIndex] !== 0) {
      idByGridIndex[gridIndex] = nodeCount;
      nodeCount += 1;
    }
  }

  const gridIndexById = new Int32Array(nodeCount);
  for (let gridIndex = 0; gridIndex < gridSize; gridIndex += 1) {
    const id = idByGridIndex[gridIndex] ?? -1;
    if (id >= 0) gridIndexById[id] = gridIndex;
  }

  const neighbors = new Int32Array(nodeCount * 4);
  neighbors.fill(-1);
  let bandwidth = 0;
  for (let id = 0; id < nodeCount; id += 1) {
    const gridIndex = gridIndexById[id] ?? -1;
    const x = gridIndex % width;
    const y = Math.floor(gridIndex / width);
    let slot = id * 4;

    if (x > 0) setNeighbor(gridIndex - 1);
    if (x + 1 < width) setNeighbor(gridIndex + 1);
    if (y > 0) setNeighbor(gridIndex - width);
    if (y + 1 < height) setNeighbor(gridIndex + width);

    function setNeighbor(neighborGridIndex: number): void {
      const neighborId = idByGridIndex[neighborGridIndex] ?? -1;
      if (neighborId >= 0) {
        neighbors[slot] = neighborId;
        slot += 1;
        bandwidth = Math.max(bandwidth, Math.abs(id - neighborId));
      }
    }
  }

  const stride = bandwidth + 1;
  const lowerBand = new Float64Array(nodeCount * stride);
  for (let id = 0; id < nodeCount; id += 1) {
    const rowOffset = id * stride;
    lowerBand[rowOffset] = 4;
    const neighborOffset = id * 4;
    for (let slot = 0; slot < 4; slot += 1) {
      const neighbor = neighbors[neighborOffset + slot] ?? -1;
      if (neighbor >= 0 && neighbor < id) {
        lowerBand[rowOffset + (id - neighbor)] = -1;
      }
    }
  }

  return {
    width,
    height,
    nodeCount,
    mask,
    idByGridIndex,
    gridIndexById,
    neighbors,
    bandwidth,
    lowerBand
  };
}

function factorBandedCholesky(
  system: DiscreteSystem,
  onRowsCompleted: (completedRows: number) => void
): BandedCholesky {
  const { nodeCount, bandwidth } = system;
  const stride = bandwidth + 1;
  const values = system.lowerBand.slice();
  const pivotFloor = 64 * Number.EPSILON * 4;
  const progressStride = Math.max(1, Math.floor(nodeCount / 32));

  for (let row = 0; row < nodeCount; row += 1) {
    const rowOffset = row * stride;
    const firstColumn = Math.max(0, row - bandwidth);

    for (let column = firstColumn; column < row; column += 1) {
      let sum = values[rowOffset + (row - column)] ?? 0;
      const firstProductColumn = Math.max(
        0,
        row - bandwidth,
        column - bandwidth
      );
      const columnOffset = column * stride;
      for (
        let productColumn = firstProductColumn;
        productColumn < column;
        productColumn += 1
      ) {
        sum -=
          (values[rowOffset + (row - productColumn)] ?? 0) *
          (values[columnOffset + (column - productColumn)] ?? 0);
      }
      const diagonal = values[columnOffset] ?? 0;
      if (!(diagonal > 0) || !Number.isFinite(diagonal)) {
        throw new EigenmodeSolverError(
          "FACTORIZATION_FAILED",
          `Invalid Cholesky diagonal at row ${column}.`
        );
      }
      values[rowOffset + (row - column)] = sum / diagonal;
    }

    let pivot = values[rowOffset] ?? 0;
    for (let column = firstColumn; column < row; column += 1) {
      const entry = values[rowOffset + (row - column)] ?? 0;
      pivot -= entry * entry;
    }
    if (!(pivot > pivotFloor) || !Number.isFinite(pivot)) {
      throw new EigenmodeSolverError(
        "FACTORIZATION_FAILED",
        `The masked Dirichlet matrix is not numerically positive definite at row ${row}.`
      );
    }
    values[rowOffset] = Math.sqrt(pivot);

    if ((row + 1) % progressStride === 0 || row + 1 === nodeCount) {
      onRowsCompleted(row + 1);
    }
  }

  return { nodeCount, bandwidth, stride, values };
}

function runShiftInvertLanczos(
  system: DiscreteSystem,
  factor: BandedCholesky,
  options: ResolvedSolverOptions
): LanczosAnalysis {
  const nodeCount = system.nodeCount;
  const maxBasisSize = Math.min(nodeCount, options.maxBasisSize);
  const initialBasisSize = Math.min(
    maxBasisSize,
    Math.max(options.initialBasisSize, options.modeCount + EXTRA_UNIQUE_MODE_GUARD)
  );
  const basis = new Float64Array(nodeCount * maxBasisSize);
  const diagonal = new Float64Array(maxBasisSize);
  const offDiagonal = new Float64Array(maxBasisSize);
  const work = new Float64Array(nodeCount);
  const forward = new Float64Array(nodeCount);

  fillDeterministicRandomUnitVector(
    basis,
    0,
    nodeCount,
    options.randomSeed
  );

  let nextCheck = initialBasisSize;
  let bestAnalysis: LanczosAnalysis = {
    basisSize: 0,
    convergedRawModeCount: 0,
    uniqueModes: []
  };

  for (let column = 0; column < maxBasisSize; column += 1) {
    const columnOffset = column * nodeCount;
    solveInverseFromBasisColumn(factor, basis, columnOffset, work, forward);

    const alpha = dotColumnWithVector(
      basis,
      columnOffset,
      work,
      nodeCount
    );
    diagonal[column] = alpha;
    addScaledColumn(work, basis, columnOffset, -alpha, nodeCount);
    if (column > 0) {
      const previousBeta = offDiagonal[column - 1] ?? 0;
      addScaledColumn(
        work,
        basis,
        (column - 1) * nodeCount,
        -previousBeta,
        nodeCount
      );
    }

    const normBeforeReorthogonalization = vectorNorm(work);
    reorthogonalize(work, basis, nodeCount, column + 1);
    let beta = vectorNorm(work);
    if (
      beta > 0 &&
      beta < 0.717 * normBeforeReorthogonalization
    ) {
      reorthogonalize(work, basis, nodeCount, column + 1);
      beta = vectorNorm(work);
    }
    offDiagonal[column] = beta;

    const basisSize = column + 1;
    const breakdownThreshold =
      128 * Number.EPSILON * Math.max(1, Math.abs(alpha));
    const brokeDown = !(beta > breakdownThreshold) || !Number.isFinite(beta);
    const atMaximum = basisSize === maxBasisSize;
    const atCheckpoint = basisSize >= nextCheck || brokeDown || atMaximum;

    if (basisSize % 4 === 0 || atCheckpoint) {
      const fraction = 0.3 + 0.6 * (basisSize / maxBasisSize);
      emitProgress(
        options.onProgress,
        "iterating",
        fraction,
        basisSize,
        bestAnalysis.uniqueModes.length
      );
    }

    if (atCheckpoint) {
      const analysis = analyzeLanczosBasis(
        system,
        basis,
        diagonal,
        offDiagonal,
        basisSize,
        options
      );
      if (analysis.uniqueModes.length > bestAnalysis.uniqueModes.length) {
        bestAnalysis = analysis;
      }
      emitProgress(
        options.onProgress,
        "iterating",
        0.3 + 0.6 * (basisSize / maxBasisSize),
        basisSize,
        analysis.uniqueModes.length
      );

      const guardedTarget = options.modeCount + EXTRA_UNIQUE_MODE_GUARD;
      if (
        analysis.uniqueModes.length >= guardedTarget ||
        ((brokeDown || atMaximum) &&
          analysis.uniqueModes.length >= options.modeCount)
      ) {
        return analysis;
      }
      if (brokeDown) break;
      nextCheck = Math.min(maxBasisSize, basisSize + options.basisStep);
    }

    if (column + 1 < maxBasisSize) {
      if (!(beta > 0) || !Number.isFinite(beta)) break;
      const nextOffset = (column + 1) * nodeCount;
      for (let row = 0; row < nodeCount; row += 1) {
        basis[nextOffset + row] = (work[row] ?? 0) / beta;
      }
    }
  }

  if (bestAnalysis.uniqueModes.length >= options.modeCount) {
    return bestAnalysis;
  }
  throw new EigenmodeSolverError(
    "NO_CONVERGENCE",
    `Only ${bestAnalysis.uniqueModes.length} distinct modes converged within the ${maxBasisSize}-vector Lanczos limit.`
  );
}

function analyzeLanczosBasis(
  system: DiscreteSystem,
  basis: Float64Array,
  diagonal: Float64Array,
  offDiagonal: Float64Array,
  basisSize: number,
  options: ResolvedSolverOptions
): LanczosAnalysis {
  const tridiagonal = symmetricTridiagonalEigen(
    diagonal.slice(0, basisSize),
    offDiagonal.slice(0, Math.max(0, basisSize - 1))
  );
  const candidateLimit = Math.min(
    basisSize,
    Math.max(options.modeCount * 3 + 12, options.modeCount + 8)
  );
  const rawModes: RawEigenmode[] = [];
  const matrixVector = new Float64Array(system.nodeCount);

  for (
    let eigenIndex = basisSize - 1;
    eigenIndex >= 0 && rawModes.length < candidateLimit;
    eigenIndex -= 1
  ) {
    const inverseEigenvalue = tridiagonal.values[eigenIndex] ?? 0;
    if (!(inverseEigenvalue > 0) || !Number.isFinite(inverseEigenvalue)) {
      continue;
    }

    const vector = reconstructRitzVector(
      basis,
      system.nodeCount,
      basisSize,
      tridiagonal.vectors,
      eigenIndex
    );
    applyDiscreteLaplacian(system, vector, matrixVector);
    const discreteEigenvalue = dotVectors(vector, matrixVector);
    if (!(discreteEigenvalue > 0) || !Number.isFinite(discreteEigenvalue)) {
      continue;
    }

    let residualSquared = 0;
    for (let row = 0; row < system.nodeCount; row += 1) {
      const residual =
        (matrixVector[row] ?? 0) -
        discreteEigenvalue * (vector[row] ?? 0);
      residualSquared += residual * residual;
    }
    const relativeResidual = Math.sqrt(residualSquared) / discreteEigenvalue;
    canonicalizeVectorSign(vector);
    rawModes.push({
      discreteEigenvalue,
      relativeResidual,
      vector
    });
  }

  rawModes.sort(
    (left, right) => left.discreteEigenvalue - right.discreteEigenvalue
  );

  const convergedPrefix: RawEigenmode[] = [];
  for (const mode of rawModes) {
    if (
      !Number.isFinite(mode.relativeResidual) ||
      mode.relativeResidual > options.residualTolerance
    ) {
      break;
    }
    convergedPrefix.push(mode);
  }

  const uniqueModes = filterDegenerateModes(
    convergedPrefix,
    options.degeneracyTolerance,
    options.rotationalSymmetry,
    system
  );
  return {
    basisSize,
    convergedRawModeCount: convergedPrefix.length,
    uniqueModes
  };
}

function filterDegenerateModes(
  sortedModes: readonly RawEigenmode[],
  degeneracyTolerance: number,
  rotationalSymmetry: number | "continuous" | undefined,
  system: DiscreteSystem
): readonly RawEigenmode[] {
  const numericallyUnique: RawEigenmode[] = [];
  for (const candidate of sortedModes) {
    const previous = numericallyUnique.at(-1);
    if (previous === undefined) {
      numericallyUnique.push(candidate);
      continue;
    }

    const previousFrequency = Math.sqrt(previous.discreteEigenvalue);
    const candidateFrequency = Math.sqrt(candidate.discreteEigenvalue);
    const relativeGap =
      Math.abs(candidateFrequency - previousFrequency) /
      Math.max(candidateFrequency, previousFrequency);
    const residualUncertainty =
      4 *
      Math.max(previous.relativeResidual, candidate.relativeResidual);
    if (relativeGap > Math.max(degeneracyTolerance, residualUncertainty)) {
      numericallyUnique.push(candidate);
    }
  }

  if (rotationalSymmetry === undefined || numericallyUnique.length < 2) {
    return numericallyUnique;
  }
  if (system.width !== system.height) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      "Rotational degeneracy classification requires a square sample grid."
    );
  }

  return filterRotationalDoublets(
    numericallyUnique,
    rotationalSymmetry,
    system
  );
}

/**
 * Collapse only pairs whose fields transform as one two-dimensional
 * rotational eigenspace. This distinguishes a raster-split symmetry doublet
 * from an unrelated close crossing by testing the rotated field itself.
 */
function filterRotationalDoublets(
  modes: readonly RawEigenmode[],
  symmetry: number | "continuous",
  system: DiscreteSystem
): readonly RawEigenmode[] {
  const edgeWeights = new Float64Array(Math.max(0, modes.length - 1));
  for (let leftIndex = 0; leftIndex + 1 < modes.length; leftIndex += 1) {
    const left = modes[leftIndex];
    const right = modes[leftIndex + 1];
    if (left === undefined || right === undefined) continue;
    const leftFrequency = Math.sqrt(left.discreteEigenvalue);
    const rightFrequency = Math.sqrt(right.discreteEigenvalue);
    const relativeGap =
      (rightFrequency - leftFrequency) /
      Math.max(leftFrequency, rightFrequency);
    if (
      !Number.isFinite(relativeGap) ||
      relativeGap < 0 ||
      relativeGap > MAX_SYMMETRY_DOUBLET_GAP
    ) {
      continue;
    }

    const score = rotationalDoubletScore(
      left.vector,
      right.vector,
      symmetry,
      system
    );
    if (
      score.subspaceCapture >= MIN_SYMMETRY_SUBSPACE_CAPTURE &&
      score.partnerCapture >= MIN_SYMMETRY_PARTNER_CAPTURE
    ) {
      edgeWeights[leftIndex] =
        score.subspaceCapture * score.partnerCapture;
    }
  }

  // Maximum-weight matching on the path of adjacent eigenvalues. It resolves
  // a close three-mode cluster without allowing one mode into two doublets.
  const bestWeights = new Float64Array(modes.length + 1);
  const takeEdge = new Uint8Array(modes.length + 1);
  for (let count = 2; count <= modes.length; count += 1) {
    const skipWeight = bestWeights[count - 1] ?? 0;
    const pairWeight =
      (bestWeights[count - 2] ?? 0) + (edgeWeights[count - 2] ?? 0);
    if ((edgeWeights[count - 2] ?? 0) > 0 && pairWeight > skipWeight) {
      bestWeights[count] = pairWeight;
      takeEdge[count] = 1;
    } else {
      bestWeights[count] = skipWeight;
    }
  }

  const discard = new Uint8Array(modes.length);
  let count = modes.length;
  while (count >= 2) {
    if (takeEdge[count] !== 0) {
      discard[count - 1] = 1;
      count -= 2;
    } else {
      count -= 1;
    }
  }
  return modes.filter((_, index) => discard[index] === 0);
}

interface RotationalDoubletScore {
  readonly subspaceCapture: number;
  readonly partnerCapture: number;
}

function rotationalDoubletScore(
  left: Float64Array,
  right: Float64Array,
  symmetry: number | "continuous",
  system: DiscreteSystem
): RotationalDoubletScore {
  const angles =
    symmetry === "continuous"
      ? [Math.PI / 7, Math.PI / 11]
      : [(2 * Math.PI) / symmetry];
  let best: RotationalDoubletScore = {
    subspaceCapture: 0,
    partnerCapture: 0
  };
  const rotated = new Float64Array(system.nodeCount);

  for (const angle of angles) {
    rotateGridMode(left, angle, system, rotated);
    const rotatedNorm = vectorNorm(rotated);
    if (!(rotatedNorm > 0) || !Number.isFinite(rotatedNorm)) continue;
    const leftProjection = dotVectors(rotated, left) / rotatedNorm;
    const rightProjection = dotVectors(rotated, right) / rotatedNorm;
    const score: RotationalDoubletScore = {
      subspaceCapture: Math.hypot(leftProjection, rightProjection),
      partnerCapture: Math.abs(rightProjection)
    };
    if (score.partnerCapture > best.partnerCapture) best = score;
  }
  return best;
}

function rotateGridMode(
  source: Float64Array,
  angle: number,
  system: DiscreteSystem,
  output: Float64Array
): void {
  const centerX = (system.width - 1) / 2;
  const centerY = (system.height - 1) / 2;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);

  for (let id = 0; id < system.nodeCount; id += 1) {
    const gridIndex = system.gridIndexById[id] ?? -1;
    const x = gridIndex % system.width;
    const y = Math.floor(gridIndex / system.width);
    const relativeX = x - centerX;
    const relativeY = y - centerY;
    // (R u)(x) = u(R^-1 x).
    const sourceX = centerX + cosine * relativeX + sine * relativeY;
    const sourceY = centerY - sine * relativeX + cosine * relativeY;
    output[id] = bilinearGridModeSample(source, sourceX, sourceY, system);
  }
}

function bilinearGridModeSample(
  source: Float64Array,
  x: number,
  y: number,
  system: DiscreteSystem
): number {
  if (x < 0 || y < 0 || x > system.width - 1 || y > system.height - 1) {
    return 0;
  }
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(system.width - 1, x0 + 1);
  const y1 = Math.min(system.height - 1, y0 + 1);
  const fractionX = x - x0;
  const fractionY = y - y0;
  return (
    gridModeValue(source, x0, y0, system) *
      (1 - fractionX) *
      (1 - fractionY) +
    gridModeValue(source, x1, y0, system) *
      fractionX *
      (1 - fractionY) +
    gridModeValue(source, x0, y1, system) *
      (1 - fractionX) *
      fractionY +
    gridModeValue(source, x1, y1, system) * fractionX * fractionY
  );
}

function gridModeValue(
  source: Float64Array,
  x: number,
  y: number,
  system: DiscreteSystem
): number {
  const gridIndex = y * system.width + x;
  const id = system.idByGridIndex[gridIndex] ?? -1;
  return id >= 0 ? source[id] ?? 0 : 0;
}

function reconstructRitzVector(
  basis: Float64Array,
  nodeCount: number,
  basisSize: number,
  projectedEigenvectors: Float64Array,
  eigenIndex: number
): Float64Array {
  const vector = new Float64Array(nodeCount);
  for (let column = 0; column < basisSize; column += 1) {
    const coefficient =
      projectedEigenvectors[column * basisSize + eigenIndex] ?? 0;
    if (coefficient === 0) continue;
    const columnOffset = column * nodeCount;
    for (let row = 0; row < nodeCount; row += 1) {
      vector[row] =
        (vector[row] ?? 0) + coefficient * (basis[columnOffset + row] ?? 0);
    }
  }
  const norm = vectorNorm(vector);
  if (!(norm > 0) || !Number.isFinite(norm)) {
    throw new EigenmodeSolverError(
      "NO_CONVERGENCE",
      "A projected Lanczos eigenvector had zero or non-finite norm."
    );
  }
  scaleVector(vector, 1 / norm);
  return vector;
}

function applyDiscreteLaplacian(
  system: DiscreteSystem,
  input: Float64Array,
  output: Float64Array
): void {
  for (let id = 0; id < system.nodeCount; id += 1) {
    let value = 4 * (input[id] ?? 0);
    const neighborOffset = id * 4;
    for (let slot = 0; slot < 4; slot += 1) {
      const neighbor = system.neighbors[neighborOffset + slot] ?? -1;
      if (neighbor >= 0) value -= input[neighbor] ?? 0;
    }
    output[id] = value;
  }
}

function solveInverseFromBasisColumn(
  factor: BandedCholesky,
  basis: Float64Array,
  basisOffset: number,
  output: Float64Array,
  forward: Float64Array
): void {
  const { nodeCount, bandwidth, stride, values } = factor;

  for (let row = 0; row < nodeCount; row += 1) {
    const rowOffset = row * stride;
    let sum = basis[basisOffset + row] ?? 0;
    const firstColumn = Math.max(0, row - bandwidth);
    for (let column = firstColumn; column < row; column += 1) {
      sum -=
        (values[rowOffset + (row - column)] ?? 0) *
        (forward[column] ?? 0);
    }
    forward[row] = sum / (values[rowOffset] ?? 1);
  }

  for (let row = nodeCount - 1; row >= 0; row -= 1) {
    let sum = forward[row] ?? 0;
    const lastRow = Math.min(nodeCount - 1, row + bandwidth);
    for (let lowerRow = row + 1; lowerRow <= lastRow; lowerRow += 1) {
      sum -=
        (values[lowerRow * stride + (lowerRow - row)] ?? 0) *
        (output[lowerRow] ?? 0);
    }
    output[row] = sum / (values[row * stride] ?? 1);
  }
}

function reorthogonalize(
  vector: Float64Array,
  basis: Float64Array,
  nodeCount: number,
  columnCount: number
): void {
  for (let column = 0; column < columnCount; column += 1) {
    const offset = column * nodeCount;
    const projection = dotColumnWithVector(
      basis,
      offset,
      vector,
      nodeCount
    );
    if (projection !== 0) {
      addScaledColumn(vector, basis, offset, -projection, nodeCount);
    }
  }
}

function symmetricTridiagonalEigen(
  diagonal: Float64Array,
  offDiagonal: Float64Array
): TridiagonalEigenResult {
  const size = diagonal.length;
  if (offDiagonal.length !== Math.max(0, size - 1)) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      "The tridiagonal eigensolver received incompatible arrays."
    );
  }
  const values = diagonal.slice();
  const subdiagonal = new Float64Array(size);
  subdiagonal.set(offDiagonal);
  const vectors = new Float64Array(size * size);
  for (let index = 0; index < size; index += 1) {
    vectors[index * size + index] = 1;
  }

  let accumulatedShift = 0;
  let runningScale = 0;
  const epsilon = Number.EPSILON;

  for (let left = 0; left < size; left += 1) {
    runningScale = Math.max(
      runningScale,
      Math.abs(values[left] ?? 0) + Math.abs(subdiagonal[left] ?? 0)
    );
    let right = left;
    while (
      right < size - 1 &&
      Math.abs(subdiagonal[right] ?? 0) > epsilon * runningScale
    ) {
      right += 1;
    }

    if (right > left) {
      let iteration = 0;
      do {
        iteration += 1;
        if (iteration > MAX_QL_ITERATIONS) {
          throw new EigenmodeSolverError(
            "NO_CONVERGENCE",
            `The projected tridiagonal eigensolver did not converge at index ${left}.`
          );
        }

        let g = values[left] ?? 0;
        let p =
          ((values[left + 1] ?? 0) - g) /
          (2 * (subdiagonal[left] ?? 0));
        let radius = Math.hypot(p, 1);
        if (p < 0) radius = -radius;
        const denominator = p + radius;
        values[left] = (subdiagonal[left] ?? 0) / denominator;
        values[left + 1] = (subdiagonal[left] ?? 0) * denominator;
        const nextDiagonal = values[left + 1] ?? 0;
        const shift = g - (values[left] ?? 0);
        for (let index = left + 2; index < size; index += 1) {
          values[index] = (values[index] ?? 0) - shift;
        }
        accumulatedShift += shift;

        p = values[right] ?? 0;
        let cosine = 1;
        let previousCosine = 1;
        let twoBackCosine = 1;
        const nextSubdiagonal = subdiagonal[left + 1] ?? 0;
        let sine = 0;
        let previousSine = 0;

        for (let index = right - 1; index >= left; index -= 1) {
          twoBackCosine = previousCosine;
          previousCosine = cosine;
          previousSine = sine;
          g = cosine * (subdiagonal[index] ?? 0);
          const diagonalProduct = cosine * p;
          radius = Math.hypot(p, subdiagonal[index] ?? 0);
          subdiagonal[index + 1] = sine * radius;
          if (radius === 0) {
            sine = 0;
            cosine = 1;
          } else {
            sine = (subdiagonal[index] ?? 0) / radius;
            cosine = p / radius;
          }
          p = cosine * (values[index] ?? 0) - sine * g;
          values[index + 1] =
            diagonalProduct +
            sine * (cosine * g + sine * (values[index] ?? 0));

          for (let row = 0; row < size; row += 1) {
            const upper = vectors[row * size + index + 1] ?? 0;
            const lower = vectors[row * size + index] ?? 0;
            vectors[row * size + index + 1] = sine * lower + cosine * upper;
            vectors[row * size + index] = cosine * lower - sine * upper;
          }
        }

        p =
          (-sine *
            previousSine *
            twoBackCosine *
            nextSubdiagonal *
            (subdiagonal[left] ?? 0)) /
          nextDiagonal;
        subdiagonal[left] = sine * p;
        values[left] = cosine * p;
      } while (
        Math.abs(subdiagonal[left] ?? 0) > epsilon * runningScale
      );
    }

    values[left] = (values[left] ?? 0) + accumulatedShift;
    subdiagonal[left] = 0;
  }

  for (let left = 0; left < size - 1; left += 1) {
    let smallest = left;
    for (let right = left + 1; right < size; right += 1) {
      if ((values[right] ?? 0) < (values[smallest] ?? 0)) smallest = right;
    }
    if (smallest === left) continue;
    const value = values[left] ?? 0;
    values[left] = values[smallest] ?? 0;
    values[smallest] = value;
    for (let row = 0; row < size; row += 1) {
      const entry = vectors[row * size + left] ?? 0;
      vectors[row * size + left] = vectors[row * size + smallest] ?? 0;
      vectors[row * size + smallest] = entry;
    }
  }

  return { values, vectors };
}

function expandToFullGrid(
  vector: Float64Array,
  system: DiscreteSystem
): Float32Array {
  const values = new Float32Array(system.width * system.height);
  let maximumMagnitude = 0;
  for (let id = 0; id < system.nodeCount; id += 1) {
    maximumMagnitude = Math.max(
      maximumMagnitude,
      Math.abs(vector[id] ?? 0)
    );
  }
  const outputScale = maximumMagnitude > 0 ? 1 / maximumMagnitude : 1;
  for (let id = 0; id < system.nodeCount; id += 1) {
    const gridIndex = system.gridIndexById[id] ?? -1;
    if (gridIndex >= 0) {
      values[gridIndex] = (vector[id] ?? 0) * outputScale;
    }
  }
  return values;
}

function fillDeterministicRandomUnitVector(
  target: Float64Array,
  offset: number,
  length: number,
  seed: number
): void {
  let state = seed >>> 0;
  if (state === 0) state = DEFAULT_RANDOM_SEED;
  let normSquared = 0;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const value = (state >>> 0) / 0x1_0000_0000 - 0.5;
    target[offset + index] = value;
    normSquared += value * value;
  }
  const norm = Math.sqrt(normSquared);
  if (!(norm > 0)) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      "The deterministic Lanczos starting vector had zero norm."
    );
  }
  for (let index = 0; index < length; index += 1) {
    target[offset + index] = (target[offset + index] ?? 0) / norm;
  }
}

function canonicalizeVectorSign(vector: Float64Array): void {
  let maximumIndex = 0;
  let maximumMagnitude = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const magnitude = Math.abs(vector[index] ?? 0);
    if (magnitude > maximumMagnitude) {
      maximumMagnitude = magnitude;
      maximumIndex = index;
    }
  }
  if ((vector[maximumIndex] ?? 0) < 0) scaleVector(vector, -1);
}

function dotColumnWithVector(
  matrix: Float64Array,
  columnOffset: number,
  vector: Float64Array,
  length: number
): number {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += (matrix[columnOffset + index] ?? 0) * (vector[index] ?? 0);
  }
  return sum;
}

function dotVectors(left: Float64Array, right: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return sum;
}

function addScaledColumn(
  target: Float64Array,
  matrix: Float64Array,
  columnOffset: number,
  scale: number,
  length: number
): void {
  for (let index = 0; index < length; index += 1) {
    target[index] =
      (target[index] ?? 0) + scale * (matrix[columnOffset + index] ?? 0);
  }
}

function vectorNorm(vector: Float64Array): number {
  let normSquared = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index] ?? 0;
    normSquared += value * value;
  }
  return Math.sqrt(normSquared);
}

function scaleVector(vector: Float64Array, scale: number): void {
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) * scale;
  }
}

function emitProgress(
  callback: SolverProgressCallback | undefined,
  stage: SolverProgress["stage"],
  fraction: number,
  basisSize: number,
  convergedModes: number
): void {
  if (callback === undefined) return;
  callback({
    stage,
    fraction: Math.min(1, Math.max(0, fraction)),
    basisSize,
    convergedModes
  });
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      `${name} must be a positive safe integer.`
    );
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      `${name} must be a positive finite number.`
    );
  }
}

function assertFiniteInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new EigenmodeSolverError(
      "INVALID_INPUT",
      `${name} must be between ${minimum} and ${maximum}.`
    );
  }
}

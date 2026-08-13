import {
  DomainMembraneRenderer,
  animationCycleSeconds,
  type DomainModeSet
} from "./membrane";
import {
  CUSTOM_MIN_ACTIVE_CELLS,
  DEFAULT_GRID_SIZE,
  SHAPE_CATALOG,
  createCustomVisualBoundary,
  generateShapeMask,
  getDefaultShapeParameters,
  getShapeInstanceKey,
  getShapeMetadata,
  getShapeVisualBoundary,
  validateMask,
  type ShapeKey,
  type ShapeMask,
  type ShapeParameters
} from "./shapes";
import type { MembraneEigenSolution, SolverProgress } from "./solver";
import { CustomShapeDrawer } from "./ui/custom-shape-drawer";
import { renderMath } from "./ui/math";
import { ShapeMenu, type ShapeMenuSelection } from "./ui/shape-menu";
import { SolverClient } from "./ui/solver-client";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const DEFAULT_SHAPE: ShapeKey = "rectangle";
const MODE_COUNT = 20;
const PARAMETER_SOLVE_DELAY_MS = 180;
const MAX_CACHED_SOLUTIONS = 8;

interface RequestedDomain {
  readonly key: ShapeKey;
  readonly parameters: ShapeParameters;
  readonly mask: ShapeMask;
  readonly cacheKey: string;
}

interface AppState {
  selectedShape: ShapeKey;
  selectedParameters: ShapeParameters;
  solution: MembraneEigenSolution | null;
  modeIndex: number;
  isPlaying: boolean;
  isUiVisible: boolean;
  isSolving: boolean;
}

export function startApp(): void {
  const shell = getElement<HTMLElement>("app-shell");
  const stage = getElement<HTMLElement>("membrane-stage");
  const description = getElement<HTMLElement>("membrane-description");
  const loading = getElement<HTMLElement>("solver-loading");
  const loadingTitle = getElement<HTMLElement>("solver-loading-title");
  const loadingDetail = getElement<HTMLElement>("solver-loading-detail");
  const fallback = getElement<HTMLElement>("renderer-fallback");
  const fallbackMessage = getElement<HTMLElement>("renderer-fallback-message");
  const retryButton = getElement<HTMLButtonElement>("retry-renderer");
  const shapeMenuToggle = getElement<HTMLButtonElement>("shape-menu-toggle");
  const activeShapeName = getElement<HTMLElement>("active-shape-name");
  const modeSlider = getElement<HTMLInputElement>("mode-slider");
  const modeValue = getElement<HTMLOutputElement>("mode-value");
  const animationToggle = getElement<HTMLButtonElement>("animation-toggle");
  const animationLabel = animationToggle.querySelector<HTMLElement>("[data-animation-label]");
  const resetButton = getElement<HTMLButtonElement>("reset-camera");
  const uiToggle = getElement<HTMLButtonElement>("ui-visibility-toggle");
  const uiLabel = uiToggle.querySelector<HTMLElement>("[data-ui-label]");
  const interactionStatus = getElement<HTMLElement>("interaction-status");
  const reducedMotionMedia = window.matchMedia(REDUCED_MOTION_QUERY);
  const solver = new SolverClient();
  const solutionCache = new Map<string, MembraneEigenSolution>();
  const parameterValues = new Map<ShapeKey, ShapeParameters>();
  for (const metadata of SHAPE_CATALOG) {
    parameterValues.set(metadata.key, getDefaultShapeParameters(metadata.key));
  }

  const initialParameters = parameterValues.get(DEFAULT_SHAPE) ?? {};
  const state: AppState = {
    selectedShape: DEFAULT_SHAPE,
    selectedParameters: initialParameters,
    solution: null,
    modeIndex: 0,
    isPlaying: !reducedMotionMedia.matches,
    isUiVisible: true,
    isSolving: false
  };
  let renderer: DomainMembraneRenderer | null = null;
  let destroyed = false;
  let requestSequence = 0;
  let parameterTimer = 0;
  let uiScrollPosition = 0;
  let shapeMenuOpen = false;
  let drawerOpen = false;
  let requestedDomain = createRequestedDomain(DEFAULT_SHAPE, initialParameters);
  let fallbackKind: "renderer" | "solver" = "renderer";

  renderMath(getElement("mode-label"), String.raw`\omega_n`);
  for (const tick of document.querySelectorAll<HTMLElement>("[data-mode-tick]")) {
    renderMath(tick, tick.dataset.modeTick ?? "");
  }
  renderActiveShape(DEFAULT_SHAPE);

  const shapeMenu = new ShapeMenu({
    initialKey: DEFAULT_SHAPE,
    initialParameters: Object.fromEntries(parameterValues),
    onSelect: (selection) => {
      window.clearTimeout(parameterTimer);
      selectPredefinedShape(selection);
    },
    onParametersInput: (selection) => {
      parameterValues.set(selection.key, selection.parameters);
      state.selectedShape = selection.key;
      state.selectedParameters = selection.parameters;
      renderActiveShape(selection.key);
      window.clearTimeout(parameterTimer);
      parameterTimer = window.setTimeout(() => {
        selectPredefinedShape(selection);
      }, PARAMETER_SOLVE_DELAY_MS);
    },
    onDraw: () => drawer.open(),
    onOpenChange: (open) => {
      shapeMenuOpen = open;
      syncRendererPlaying();
    }
  });

  const drawer = new CustomShapeDrawer({
    onApply: (mask) => selectCustomShape(mask),
    onOpenChange: (open) => {
      drawerOpen = open;
      syncRendererPlaying();
    }
  });

  function syncRendererPlaying(): void {
    renderer?.setPlaying(state.isPlaying && !shapeMenuOpen && !drawerOpen);
  }

  function initializeRenderer(): boolean {
    renderer?.destroy();
    renderer = null;
    fallback.hidden = true;
    try {
      renderer = new DomainMembraneRenderer(stage, {
        initialModeIndex: state.modeIndex,
        onContextLost: () => {
          fallbackKind = "renderer";
          fallbackMessage.textContent = "The 3D view paused because its graphics context was lost.";
          fallback.hidden = false;
        },
        onContextRestored: () => {
          fallback.hidden = true;
          syncRendererPlaying();
          announce(interactionStatus, "The three-dimensional membrane view was restored.");
        }
      });
      if (state.solution) {
        renderer.setDomain(
          rendererData(state.solution, state.selectedShape, state.selectedParameters)
        );
      }
      syncRendererPlaying();
      renderer.setPageVisible(!document.hidden);
      stage.setAttribute("aria-busy", String(state.isSolving));
      return true;
    } catch (error) {
      fallbackKind = "renderer";
      fallbackMessage.textContent = readableError(error, "This browser could not start the 3D view.");
      fallback.hidden = false;
      stage.setAttribute("aria-busy", "false");
      return false;
    }
  }

  function selectPredefinedShape(selection: ShapeMenuSelection): void {
    const parameters = selection.parameters;
    parameterValues.set(selection.key, parameters);
    state.selectedShape = selection.key;
    state.selectedParameters = parameters;
    shapeMenu.setSelection(selection.key, parameters);
    requestedDomain = createRequestedDomain(selection.key, parameters);
    void solveRequestedDomain(requestedDomain);
  }

  function selectCustomShape(mask: ShapeMask): void {
    const validation = validateMask(mask, {
      minActiveCells: CUSTOM_MIN_ACTIVE_CELLS,
      requireSingleComponent: true,
      warnWhenTouchingGridEdge: true
    });
    if (!validation.valid) {
      announce(
        interactionStatus,
        validation.errors[0]?.message ?? "The custom membrane is not a valid connected domain."
      );
      return;
    }
    state.selectedShape = "custom";
    state.selectedParameters = {};
    shapeMenu.setSelection("custom", {});
    requestedDomain = {
      key: "custom",
      parameters: {},
      mask,
      cacheKey: `custom@${mask.width}x${mask.height}:${hashMask(mask.data)}`
    };
    void solveRequestedDomain(requestedDomain);
  }

  async function solveRequestedDomain(request: RequestedDomain): Promise<void> {
    const sequence = ++requestSequence;
    const metadata = getShapeMetadata(request.key);
    renderActiveShape(request.key);
    shell.dataset.pendingShape = request.key;
    setSolving(true, "Solving membrane…", `Preparing ${metadata.label.toLowerCase()} domain`);
    fallback.hidden = true;

    const cached = solutionCache.get(request.cacheKey);
    if (cached) {
      await nextAnimationFrame();
      if (sequence !== requestSequence || destroyed) return;
      acceptSolution(request, cached, true);
      return;
    }

    try {
      const rotationalSymmetry = rotationalSymmetryForShape(request.key);
      const solution = await solver.solve(
        request.mask.data,
        request.mask.width,
        request.mask.height,
        {
          modeCount: MODE_COUNT,
          gridSpacing: 2 / (request.mask.width + 1),
          waveSpeed: 1,
          keepLargestComponent: true,
          degeneracyTolerance: 1e-8,
          ...(rotationalSymmetry === undefined
            ? {}
            : { rotationalSymmetry }),
          residualTolerance: 2e-6,
          initialBasisSize: 96,
          basisStep: 32,
          maxBasisSize: 224
        },
        {
          onProgress: (progress) => {
            if (sequence === requestSequence) renderProgress(progress);
          }
        }
      );
      if (sequence !== requestSequence || destroyed) return;
      rememberSolution(request.cacheKey, solution, solutionCache);
      acceptSolution(request, solution, false);
    } catch (error) {
      if (sequence !== requestSequence || destroyed) return;
      state.isSolving = false;
      loading.hidden = true;
      modeSlider.disabled = state.solution === null;
      stage.setAttribute("aria-busy", "false");
      delete shell.dataset.pendingShape;
      fallbackKind = "solver";
      fallbackMessage.textContent = readableError(
        error,
        "The eigenmode solver could not resolve this domain. Try a broader shape."
      );
      fallback.hidden = false;
      announce(interactionStatus, fallbackMessage.textContent ?? "The numerical solve failed.");
    }
  }

  function acceptSolution(
    request: RequestedDomain,
    solution: MembraneEigenSolution,
    fromCache: boolean
  ): void {
    if (solution.modes.length !== MODE_COUNT) {
      throw new Error(`Expected ${MODE_COUNT} distinct modes; received ${solution.modes.length}.`);
    }
    state.selectedShape = request.key;
    state.selectedParameters = request.parameters;
    state.solution = solution;
    state.isSolving = false;
    renderer?.setDomain(rendererData(solution, request.key, request.parameters));
    renderer?.setModeIndex(state.modeIndex);
    syncRendererPlaying();
    setSolving(false);
    fallback.hidden = true;
    stage.dataset.shape = request.key;
    stage.dataset.solverBasisSize = String(solution.basisSize);
    stage.dataset.solverActiveNodes = String(solution.activeNodeCount);
    stage.dataset.solverRemovedNodes = String(solution.removedNodeCount);
    stage.dataset.solverCache = String(fromCache);
    stage.dataset.modeCount = String(solution.modes.length);
    delete shell.dataset.pendingShape;
    renderMode();
    announce(
      interactionStatus,
      `${getShapeMetadata(request.key).label} ready with 20 distinct vibration modes. ` +
        `Selected mode ${state.modeIndex + 1}.`
    );
  }

  function renderProgress(progress: SolverProgress): void {
    const stageNames: Record<SolverProgress["stage"], string> = {
      preparing: "Building the discrete domain",
      factorizing: "Factoring the Dirichlet Laplacian",
      iterating: "Resolving the lowest frequencies",
      finalizing: "Preparing the surface"
    };
    const percent = Math.round(progress.fraction * 100);
    loadingDetail.textContent =
      progress.stage === "iterating"
        ? `${stageNames[progress.stage]} · ${progress.convergedModes}/${MODE_COUNT} modes · ${percent}%`
        : `${stageNames[progress.stage]} · ${percent}%`;
  }

  function setSolving(solving: boolean, title = "Solving membrane…", detail = ""): void {
    state.isSolving = solving;
    loading.hidden = !solving;
    loadingTitle.textContent = title;
    if (detail) loadingDetail.textContent = detail;
    modeSlider.disabled = solving || state.solution === null;
    stage.setAttribute("aria-busy", String(solving));
    shell.dataset.solving = String(solving);
  }

  function renderMode(): void {
    const modeNumber = state.modeIndex + 1;
    const mode = state.solution?.modes[state.modeIndex];
    renderMath(modeValue, String(modeNumber));
    modeSlider.value = String(modeNumber);
    modeSlider.style.setProperty("--mode-progress", `${(state.modeIndex / (MODE_COUNT - 1)) * 100}%`);
    modeSlider.setAttribute("aria-valuetext", `Mode ${modeNumber} of ${MODE_COUNT}`);
    if (!mode || !state.solution) return;
    const cycleSeconds = animationCycleSeconds(mode.eigenvalue, state.solution.modes[0]?.eigenvalue ?? 1);
    const label = getShapeMetadata(state.selectedShape).label;
    description.textContent =
      `Animated ${label.toLowerCase()} fixed-edge membrane, numerical mode ${modeNumber} of 20. ` +
      `It has a ${cycleSeconds.toFixed(2)}-second illustrative cycle. ` +
      "Height and the Berlin blue-to-coral color scale show instantaneous signed displacement. " +
      "The pale outline is fixed at zero, and the fine grid deforms with the surface. " +
      "Repeated eigenfrequencies are represented once.";
    stage.setAttribute(
      "aria-label",
      `${label} membrane, vibration mode ${modeNumber} of 20`
    );
  }

  function renderPlayback(): void {
    animationToggle.setAttribute("aria-pressed", String(state.isPlaying));
    animationToggle.setAttribute("aria-label", state.isPlaying ? "Pause vibration" : "Play vibration");
    animationToggle.title = state.isPlaying ? "Pause vibration (Space)" : "Play vibration (Space)";
    if (animationLabel) animationLabel.textContent = state.isPlaying ? "Pause" : "Play";
  }

  function setPlaying(playing: boolean, announceChange = true): void {
    state.isPlaying = playing;
    syncRendererPlaying();
    renderPlayback();
    if (announceChange) {
      announce(interactionStatus, playing ? "Vibration playing." : "Vibration paused.");
    }
  }

  function setUiVisible(visible: boolean): void {
    const visibilityChanged = state.isUiVisible !== visible;
    if (visibilityChanged && !visible) {
      shapeMenu.setOpen(false);
      drawer.close();
    }
    if (visibilityChanged && !visible) {
      const mobileBreakpoint = window.matchMedia("(max-width: 800px)");
      uiScrollPosition = mobileBreakpoint.matches ? window.scrollY : 0;
    }
    state.isUiVisible = visible;
    document.documentElement.dataset.uiHidden = String(!visible);
    shell.dataset.uiHidden = String(!visible);
    uiToggle.setAttribute("aria-expanded", String(visible));
    uiToggle.setAttribute("aria-pressed", String(!visible));
    uiToggle.setAttribute("aria-label", visible ? "Hide interface" : "Show interface");
    uiToggle.title = visible ? "Hide interface (H)" : "Show interface (H)";
    if (uiLabel) uiLabel.textContent = visible ? "Hide UI" : "Show UI";
    window.requestAnimationFrame(() => {
      if (visibilityChanged && (uiScrollPosition > 0 || window.scrollY > 0)) {
        window.scrollTo({
          top: visible ? uiScrollPosition : 0,
          left: 0,
          behavior: "auto"
        });
      }
      renderer?.resize();
    });
  }

  modeSlider.addEventListener("input", () => {
    const next = clampInteger(Number(modeSlider.value), 1, MODE_COUNT) - 1;
    if (next === state.modeIndex) return;
    state.modeIndex = next;
    renderer?.setModeIndex(next);
    renderMode();
  });
  modeSlider.addEventListener("change", () => {
    announce(interactionStatus, `Selected mode ${state.modeIndex + 1}.`);
  });
  animationToggle.addEventListener("click", () => setPlaying(!state.isPlaying));
  resetButton.addEventListener("click", () => {
    renderer?.resetView();
    stage.focus({ preventScroll: true });
    announce(interactionStatus, "Membrane camera reset.");
  });
  uiToggle.addEventListener("click", () => {
    setUiVisible(!state.isUiVisible);
    announce(interactionStatus, state.isUiVisible ? "Interface shown." : "Interface hidden. Press H to restore it.");
  });
  retryButton.addEventListener("click", () => {
    fallback.hidden = true;
    if (fallbackKind === "renderer") initializeRenderer();
    else void solveRequestedDomain(requestedDomain);
  });
  stage.addEventListener("pointerdown", () => stage.focus({ preventScroll: true }));
  stage.addEventListener("keydown", (event) => renderer?.handleKeyboard(event));

  const handleGlobalShortcut = (event: KeyboardEvent): void => {
    if (
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isEditing(event.target) ||
      !getElement<HTMLElement>("drawing-overlay").hidden
    ) {
      return;
    }
    if (event.key.toLowerCase() === "h") {
      event.preventDefault();
      setUiVisible(!state.isUiVisible);
    } else if (event.code === "Space" && !isInteractive(event.target)) {
      event.preventDefault();
      setPlaying(!state.isPlaying);
    }
  };
  document.addEventListener("keydown", handleGlobalShortcut);

  const handleReducedMotionChange = (): void => {
    if (reducedMotionMedia.matches) {
      setPlaying(false, false);
      announce(interactionStatus, "Reduced motion enabled. Vibration paused.");
    }
  };
  reducedMotionMedia.addEventListener("change", handleReducedMotionChange);
  const handleVisibility = (): void => renderer?.setPageVisible(!document.hidden);
  document.addEventListener("visibilitychange", handleVisibility);

  const cleanup = (): void => {
    if (destroyed) return;
    destroyed = true;
    requestSequence += 1;
    window.clearTimeout(parameterTimer);
    document.removeEventListener("keydown", handleGlobalShortcut);
    document.removeEventListener("visibilitychange", handleVisibility);
    reducedMotionMedia.removeEventListener("change", handleReducedMotionChange);
    window.removeEventListener("pagehide", handlePageHide);
    window.removeEventListener("pageshow", handlePageShow);
    shapeMenu.destroy();
    drawer.destroy();
    solver.destroy();
    renderer?.destroy();
    renderer = null;
  };
  const handlePageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      renderer?.setPageVisible(false);
      return;
    }
    cleanup();
  };
  const handlePageShow = (event: PageTransitionEvent): void => {
    if (!event.persisted || destroyed) return;
    renderer?.setPageVisible(!document.hidden);
    renderer?.resize();
  };
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);

  renderMode();
  renderPlayback();
  setUiVisible(true);
  initializeRenderer();
  void solveRequestedDomain(requestedDomain);

  function renderActiveShape(key: ShapeKey): void {
    const label = getShapeMetadata(key).label;
    activeShapeName.textContent = label;
    shapeMenuToggle.setAttribute(
      "aria-label",
      `Choose membrane shape; current shape ${label}`
    );
  }
}

function createRequestedDomain(key: ShapeKey, parameters: ShapeParameters): RequestedDomain {
  const mask = generateShapeMask(key, {
    grid: DEFAULT_GRID_SIZE,
    parameters,
    retainLargestComponent: true
  });
  return {
    key,
    parameters,
    mask,
    cacheKey: getShapeInstanceKey(key, parameters, DEFAULT_GRID_SIZE)
  };
}

function rendererData(
  solution: MembraneEigenSolution,
  shape: ShapeKey,
  parameters: ShapeParameters
): DomainModeSet {
  const visualBoundary =
    shape === "custom"
      ? createCustomVisualBoundary({
          width: solution.width,
          height: solution.height,
          data: solution.mask,
        })
      : getShapeVisualBoundary(shape, parameters);
  return {
    width: solution.width,
    height: solution.height,
    mask: solution.mask,
    modes: solution.modes.map((mode) => mode.values),
    eigenvalues: solution.modes.map((mode) => mode.eigenvalue),
    aspectRatio: 1,
    ...(visualBoundary ? { visualBoundary } : {})
  };
}

function rotationalSymmetryForShape(
  key: ShapeKey
): number | "continuous" | undefined {
  switch (key) {
    case "circle":
    case "annulus":
      return "continuous";
    case "pentagon":
      return 5;
    case "hexagon":
      return 6;
    case "rectangle":
    case "triangle":
    case "spiral":
    case "custom":
      return undefined;
  }
}

function rememberSolution(
  key: string,
  solution: MembraneEigenSolution,
  cache: Map<string, MembraneEigenSolution>
): void {
  cache.set(key, solution);
  while (cache.size > MAX_CACHED_SOLUTIONS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function hashMask(mask: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const value of mask) {
    hash ^= value;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function isEditing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isInteractive(target: EventTarget | null): boolean {
  return (
    isEditing(target) ||
    target instanceof HTMLButtonElement ||
    target instanceof HTMLAnchorElement ||
    (target instanceof HTMLElement && target.matches('[role="button"], [role="link"], [role="slider"]'))
  );
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function announce(element: HTMLElement, message: string): void {
  element.textContent = "";
  window.setTimeout(() => {
    element.textContent = message;
  }, 0);
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}.`);
  return element as T;
}

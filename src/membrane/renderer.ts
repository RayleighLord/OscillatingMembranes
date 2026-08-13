import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { Point2D, ShapeVisualBoundary } from "../shapes";
import { createBerlinTexture } from "./berlin";
import {
  animationCycleSeconds,
  frequencyRatioToFundamental
} from "./timing";

const MAX_PIXEL_RATIO = 2;
const MAX_DRAWING_BUFFER_PIXELS = 2_500_000;
const MAX_GRID_SAMPLES = 512 * 512;
const TWO_PI = 2 * Math.PI;
const DEFAULT_CAMERA_FOV = 34;
const DEFAULT_CAMERA_DIRECTION = new THREE.Vector3(1.28, 1.02, 1.38).normalize();
const DEFAULT_CAMERA_DISTANCE = 2.15;
const DEFAULT_ROTATE_SPEED = 0.68;
const COMPACT_ROTATE_SPEED = 0.46;
const COMPACT_LAYOUT_MAX_WIDTH = 800;
const COMPACT_LANDSCAPE_MAX_WIDTH = 1024;
const COMPACT_LANDSCAPE_MAX_HEIGHT = 520;
/**
 * Domain +y is "up" in the drawing and mask coordinate system. The default
 * camera looks toward the origin from +z, where an unreflected +z axis would
 * project downward on screen and mirror every asymmetric domain. Reflect the
 * complete retained meshes so positions, modes, normals, and the fixed outline
 * keep one shared orientation.
 */
export const DOMAIN_Y_TO_WORLD_Z_SCALE = -1;
const OUTLINE_COLOR = 0xdde8f5;
const OUTLINE_WIDTH = 0.008;
const OUTLINE_HEIGHT = 0.008;
const OUTLINE_MITER_LIMIT = 2.5;
const PREDEFINED_ANALYTIC_RENDER_SUBDIVISIONS = 4;
const CUSTOM_ANALYTIC_RENDER_SUBDIVISIONS = 3;

export const MEMBRANE_MODE_COUNT = 20;
export const MEMBRANE_AMPLITUDE = 0.09;

/**
 * A fixed Cartesian sample grid. Mask values may be 0/1 or 0/255. Rows are
 * ordered from the domain's lower edge to its upper edge. Each eigenmode uses
 * the same row-major layout and is copied by the renderer on acceptance.
 *
 * Eigenvalues are those of the spatial Laplacian problem. Consequently the
 * modal angular frequencies are proportional to sqrt(eigenvalue).
 */
export interface DomainModeSet {
  readonly width: number;
  readonly height: number;
  readonly mask: Uint8Array;
  readonly modes: readonly ArrayLike<number>[];
  readonly eigenvalues: ArrayLike<number>;
  /** Physical width / height. Defaults to the sample-grid aspect ratio. */
  readonly aspectRatio?: number;
  /** Optional analytic edge for smooth rendering; never changes the solver mask. */
  readonly visualBoundary?: ShapeVisualBoundary;
}

export interface DomainMembraneRendererOptions {
  readonly data?: DomainModeSet;
  /** Zero-based index into the 20 retained modes. */
  readonly initialModeIndex?: number;
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
}

interface PreparedDomain {
  readonly width: number;
  readonly height: number;
  readonly maskPixels: Uint8Array;
  readonly normalizedModes: readonly Float32Array[];
  readonly eigenvalues: Float64Array;
  readonly worldWidth: number;
  readonly worldHeight: number;
  readonly activeSampleCount: number;
  readonly visualBoundary: ShapeVisualBoundary | null;
}

interface DomainGeometry {
  readonly surface: THREE.BufferGeometry;
  readonly outline: THREE.BufferGeometry;
  readonly activeCellCount: number;
  readonly boundarySegmentCount: number;
  readonly outlineLoopCount: number;
  readonly outlineMiterJoinCount: number;
  readonly outlineBevelJoinCount: number;
  readonly outlineJoinStyle: "joined-ribbon" | "segment-boxes";
  readonly renderWidth: number;
  readonly renderHeight: number;
  readonly renderSubdivisions: number;
}

interface MembraneUniforms {
  readonly [name: string]: THREE.IUniform;
  readonly uAmplitude: THREE.IUniform<number>;
  readonly uBerlin: THREE.IUniform<THREE.DataTexture>;
  readonly uMode: THREE.IUniform<THREE.DataTexture>;
  readonly uPhase: THREE.IUniform<number>;
  readonly uTexel: THREE.IUniform<THREE.Vector2>;
  readonly uWorldSize: THREE.IUniform<THREE.Vector2>;
}

/**
 * Retained Three.js renderer for numerically sampled Dirichlet eigenmodes.
 *
 * Accepted domain data are copied and normalized once. Mode changes reuse the
 * same mesh, materials, scalar texture, camera and animation loop; only the
 * selected normalized mode is uploaded to the existing scalar texture.
 */
export class DomainMembraneRenderer {
  private readonly host: HTMLElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(DEFAULT_CAMERA_FOV, 1, 0.05, 20);
  private readonly controls: OrbitControls;
  private readonly berlinTexture: THREE.DataTexture;
  private modeTexture: THREE.DataTexture;
  private modePixels = new Float32Array(1);
  private readonly uniforms: MembraneUniforms;
  private readonly material: THREE.ShaderMaterial;
  private readonly outlineMaterial: THREE.MeshBasicMaterial;
  private surface: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
  private outline: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> | null = null;
  private surfaceGeometry: THREE.BufferGeometry | null = null;
  private outlineGeometry: THREE.BufferGeometry | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly onContextLostCallback: (() => void) | undefined;
  private readonly onContextRestoredCallback: (() => void) | undefined;

  private domain: PreparedDomain | null = null;
  private modeIndex = 0;
  private phase = 0;
  private playing = false;
  private pageVisible = true;
  private contextLost = false;
  private destroyed = false;
  private rafId = 0;
  private previousFrameTime: number | null = null;
  private frameSequence = 0;

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    if (this.destroyed) return;
    this.contextLost = true;
    this.previousFrameTime = null;
    this.cancelFrame();
    this.host.dataset.membraneStatus = "context-lost";
    this.host.dispatchEvent(new CustomEvent("membrane-context-lost", { bubbles: true }));
    this.onContextLostCallback?.();
  };

  private readonly handleContextRestored = (): void => {
    if (this.destroyed) return;
    this.contextLost = false;
    this.previousFrameTime = null;
    this.berlinTexture.needsUpdate = true;
    this.modeTexture.needsUpdate = true;
    this.host.dataset.membraneStatus = this.domain ? "ready" : "empty";
    this.host.dispatchEvent(new CustomEvent("membrane-context-restored", { bubbles: true }));
    this.onContextRestoredCallback?.();
    this.requestFrame();
  };

  constructor(host: HTMLElement, options: DomainMembraneRendererOptions = {}) {
    this.host = host;
    this.onContextLostCallback = options.onContextLost;
    this.onContextRestoredCallback = options.onContextRestored;
    if (options.initialModeIndex !== undefined) {
      assertModeIndex(options.initialModeIndex);
      this.modeIndex = options.initialModeIndex;
    }

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.dataset.membraneCanvas = "true";
    this.renderer.domElement.setAttribute("aria-hidden", "true");
    host.replaceChildren(this.renderer.domElement);

    this.berlinTexture = createBerlinTexture();
    this.modeTexture = createModeTexture(this.modePixels, 1, 1);
    this.uniforms = {
      uAmplitude: { value: MEMBRANE_AMPLITUDE },
      uBerlin: { value: this.berlinTexture },
      uMode: { value: this.modeTexture },
      uPhase: { value: 0 },
      uTexel: { value: new THREE.Vector2(1, 1) },
      uWorldSize: { value: new THREE.Vector2(1, 1) }
    };
    this.material = new THREE.ShaderMaterial({
      name: "numerical-membrane-berlin",
      uniforms: this.uniforms,
      vertexShader: MEMBRANE_VERTEX_SHADER,
      fragmentShader: MEMBRANE_FRAGMENT_SHADER,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    this.outlineMaterial = new THREE.MeshBasicMaterial({
      color: OUTLINE_COLOR,
      side: THREE.DoubleSide,
      toneMapped: false
    });

    this.camera.position.copy(DEFAULT_CAMERA_DIRECTION).multiplyScalar(DEFAULT_CAMERA_DISTANCE);
    this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.95;
    this.controls.maxDistance = 5;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI;
    this.controls.rotateSpeed = DEFAULT_ROTATE_SPEED;
    this.controls.zoomSpeed = 0.8;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener("change", this.requestFrame);
    this.controls.addEventListener("change", this.updateCameraData);
    this.controls.update();

    this.renderer.domElement.addEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.addEventListener("webglcontextrestored", this.handleContextRestored);
    if (typeof ResizeObserver === "undefined") {
      this.resizeObserver = null;
    } else {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    }

    this.host.dataset.rendererReady = "true";
    this.host.dataset.membraneStatus = "empty";
    this.host.dataset.modeCount = `${MEMBRANE_MODE_COUNT}`;
    this.host.dataset.frame = "0";
    this.host.dataset.playing = "false";
    this.host.dataset.pageVisible = "true";
    this.host.dataset.amplitude = `${MEMBRANE_AMPLITUDE}`;
    this.host.dataset.gridVisible = "true";
    this.host.dataset.outlineVisible = "true";
    this.host.dataset.axisMarkers = "false";
    this.host.dataset.cameraFullRotation = "true";
    this.host.dataset.animationTiming = "modal";
    this.host.dataset.modeNormalization = "max-abs";
    this.host.dataset.boundaryPassOrder = "surface-outline";
    this.host.setAttribute("aria-busy", "false");
    this.updateSelectionData();
    this.updatePhaseData();
    this.updateCameraData();
    this.resize();

    if (options.data !== undefined) {
      this.setDomain(options.data);
    }
  }

  /** Transactionally replace the accepted mask, modes and eigenvalues. */
  setDomain(data: DomainModeSet): void {
    if (this.destroyed) return;
    const prepared = prepareDomain(data);
    const geometry = buildDomainGeometry(prepared);
    const selectedMode = prepared.normalizedModes[this.modeIndex];
    if (!selectedMode) {
      geometry.surface.dispose();
      geometry.outline.dispose();
      throw new RangeError(`Mode index ${this.modeIndex} is unavailable.`);
    }
    const nextModePixels = new Float32Array(selectedMode);
    const nextModeTexture = createModeTexture(
      nextModePixels,
      prepared.width,
      prepared.height
    );
    const nextSurface = new THREE.Mesh(geometry.surface, this.material);
    nextSurface.name = "numerical-membrane";
    nextSurface.frustumCulled = false;
    nextSurface.scale.z = DOMAIN_Y_TO_WORLD_Z_SCALE;
    const nextOutline = new THREE.Mesh(geometry.outline, this.outlineMaterial);
    nextOutline.name = "fixed-boundary-outline";
    nextOutline.frustumCulled = false;
    nextOutline.scale.z = DOMAIN_Y_TO_WORLD_Z_SCALE;
    // Match the reference square renderer: submit the frame after the surface,
    // while retaining ordinary depth testing. Equal-depth fixed-edge samples
    // are therefore pale, but a genuinely nearer displaced lobe can still
    // occlude the far frame and keep its low-angle 3D silhouette.
    nextOutline.renderOrder = 2;

    this.removeDomainMeshes();
    this.modeTexture.dispose();

    this.domain = prepared;
    this.modePixels = nextModePixels;
    this.modeTexture = nextModeTexture;
    this.surfaceGeometry = geometry.surface;
    this.outlineGeometry = geometry.outline;
    this.surface = nextSurface;
    this.outline = nextOutline;
    this.uniforms.uMode.value = nextModeTexture;
    this.uniforms.uTexel.value.set(1 / prepared.width, 1 / prepared.height);
    this.uniforms.uWorldSize.value.set(prepared.worldWidth, prepared.worldHeight);
    this.scene.add(nextSurface, nextOutline);

    this.host.dataset.membraneStatus = "ready";
    this.host.dataset.gridWidth = `${prepared.width}`;
    this.host.dataset.gridHeight = `${prepared.height}`;
    this.host.dataset.solverGridWidth = `${prepared.width}`;
    this.host.dataset.solverGridHeight = `${prepared.height}`;
    this.host.dataset.activeSampleCount = `${prepared.activeSampleCount}`;
    this.host.dataset.activeCellCount = `${geometry.activeCellCount}`;
    this.host.dataset.boundarySegmentCount = `${geometry.boundarySegmentCount}`;
    this.host.dataset.outlineLoopCount = `${geometry.outlineLoopCount}`;
    this.host.dataset.outlineMiterJoinCount = `${geometry.outlineMiterJoinCount}`;
    this.host.dataset.outlineBevelJoinCount = `${geometry.outlineBevelJoinCount}`;
    this.host.dataset.outlineJoinStyle = geometry.outlineJoinStyle;
    this.host.dataset.renderGridWidth = `${geometry.renderWidth}`;
    this.host.dataset.renderGridHeight = `${geometry.renderHeight}`;
    this.host.dataset.analyticRenderSubdivisions = `${geometry.renderSubdivisions}`;
    this.host.dataset.surfacePositionCount = `${geometry.surface.getAttribute("position").count}`;
    this.host.dataset.surfaceTriangleCount = `${surfaceTriangleCount(geometry.surface)}`;
    this.host.dataset.outlinePositionCount = `${geometry.outline.getAttribute("position").count}`;
    this.host.dataset.outlineTriangleCount = `${surfaceTriangleCount(geometry.outline)}`;
    this.host.dataset.surfaceIndexed = `${geometry.surface.index !== null}`;
    this.host.dataset.worldWidth = `${prepared.worldWidth}`;
    this.host.dataset.worldHeight = `${prepared.worldHeight}`;
    this.host.dataset.domainYWorldZScale = `${nextSurface.scale.z}`;
    this.host.dataset.boundaryGeometry = prepared.visualBoundary ? "analytic" : "raster";
    this.host.dataset.boundaryOcclusion = "depth-tested-exterior-frame";
    this.updateSelectionData();
    this.resetPhase();
    this.host.dispatchEvent(new CustomEvent("membrane-domain-ready", { bubbles: true }));
  }

  /** Select a mode by its zero-based position in the accepted 20-mode set. */
  setModeIndex(index: number): void {
    if (this.destroyed) return;
    assertModeIndex(index);
    if (index === this.modeIndex) return;
    this.modeIndex = index;
    const selectedMode = this.domain?.normalizedModes[index];
    if (selectedMode) {
      this.modePixels.set(selectedMode);
      this.modeTexture.needsUpdate = true;
    }
    this.updateSelectionData();
    this.resetPhase();
  }

  /** Select a user-facing mode number from 1 through 20. */
  setModeNumber(modeNumber: number): void {
    if (!Number.isInteger(modeNumber) || modeNumber < 1 || modeNumber > MEMBRANE_MODE_COUNT) {
      throw new RangeError(
        `Mode number must be an integer from 1 through ${MEMBRANE_MODE_COUNT}; received ${String(modeNumber)}.`
      );
    }
    this.setModeIndex(modeNumber - 1);
  }

  getModeIndex(): number {
    return this.modeIndex;
  }

  setPlaying(playing: boolean): void {
    if (this.destroyed || playing === this.playing) return;
    this.playing = playing;
    this.previousFrameTime = null;
    this.host.dataset.playing = `${playing}`;
    if (playing && this.domain && this.pageVisible && !this.contextLost) {
      this.requestFrame();
    }
  }

  setPageVisible(visible: boolean): void {
    if (this.destroyed || visible === this.pageVisible) return;
    this.pageVisible = visible;
    this.previousFrameTime = null;
    this.host.dataset.pageVisible = `${visible}`;
    if (visible) {
      this.requestFrame();
    } else {
      this.cancelFrame();
    }
  }

  resetPhase(): void {
    if (this.destroyed) return;
    this.phase = 0;
    this.previousFrameTime = null;
    this.uniforms.uPhase.value = 0;
    this.updatePhaseData();
    this.requestFrame();
  }

  /** Set an exact animation phase for a paused renderer. */
  setPhase(phase: number): void {
    if (this.destroyed) return;
    if (this.playing) {
      throw new Error("Pause the membrane before setting an exact phase.");
    }
    if (!Number.isFinite(phase)) {
      throw new RangeError(`Phase must be finite; received ${String(phase)}.`);
    }
    this.phase = ((phase % TWO_PI) + TWO_PI) % TWO_PI;
    this.previousFrameTime = null;
    this.uniforms.uPhase.value = this.phase;
    this.updatePhaseData();
    this.requestFrame();
  }

  resetView(): void {
    if (this.destroyed) return;
    const dampingWasEnabled = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(DEFAULT_CAMERA_DIRECTION).multiplyScalar(DEFAULT_CAMERA_DISTANCE);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.controls.enableDamping = dampingWasEnabled;
    this.updateCameraData();
    this.requestFrame();
  }

  rotateBy(deltaAzimuth: number, deltaPolar: number): void {
    if (this.destroyed || !Number.isFinite(deltaAzimuth) || !Number.isFinite(deltaPolar)) return;
    this.controls.rotateLeft(deltaAzimuth);
    this.controls.rotateUp(deltaPolar);
    this.controls.update();
    this.requestFrame();
  }

  zoomBy(scale: number): void {
    if (this.destroyed || !Number.isFinite(scale) || scale <= 0) return;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = THREE.MathUtils.clamp(
      offset.length() * scale,
      this.controls.minDistance,
      this.controls.maxDistance
    );
    offset.setLength(distance);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
    this.requestFrame();
  }

  /** Handle camera-only keyboard shortcuts when the stage owns focus. */
  handleKeyboard(event: KeyboardEvent): boolean {
    if (this.destroyed || event.altKey || event.ctrlKey || event.metaKey) return false;
    let handled = true;
    switch (event.key) {
      case "ArrowLeft":
        this.rotateBy(0.1, 0);
        break;
      case "ArrowRight":
        this.rotateBy(-0.1, 0);
        break;
      case "ArrowUp":
        this.rotateBy(0, 0.075);
        break;
      case "ArrowDown":
        this.rotateBy(0, -0.075);
        break;
      case "+":
      case "=":
        this.zoomBy(0.88);
        break;
      case "-":
      case "_":
        this.zoomBy(1.14);
        break;
      case "0":
      case "Home":
        this.resetView();
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
    return handled;
  }

  resize(): void {
    if (this.destroyed) return;
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    const requestedRatio = Math.max(1, window.devicePixelRatio || 1);
    const bufferLimitedRatio = Math.sqrt(MAX_DRAWING_BUFFER_PIXELS / (width * height));
    const pixelRatio = Math.min(requestedRatio, MAX_PIXEL_RATIO, bufferLimitedRatio);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    const usesCompactControls =
      width <= COMPACT_LAYOUT_MAX_WIDTH ||
      (width <= COMPACT_LANDSCAPE_MAX_WIDTH && height <= COMPACT_LANDSCAPE_MAX_HEIGHT);
    this.controls.rotateSpeed = usesCompactControls ? COMPACT_ROTATE_SPEED : DEFAULT_ROTATE_SPEED;
    // Preserve the reference framing on wide screens, while keeping the
    // horizontal field of view equally generous in a narrow portrait stage.
    this.camera.fov =
      this.camera.aspect < 1
        ? THREE.MathUtils.radToDeg(
            2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(DEFAULT_CAMERA_FOV) / 2) / this.camera.aspect)
          )
        : DEFAULT_CAMERA_FOV;
    this.camera.updateProjectionMatrix();
    this.host.dataset.pixelRatio = pixelRatio.toFixed(3);
    this.host.dataset.cameraVerticalFov = this.camera.fov.toFixed(3);
    this.host.dataset.cameraRotateSpeed = this.controls.rotateSpeed.toFixed(2);
    this.requestFrame();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelFrame();
    this.resizeObserver?.disconnect();
    this.controls.removeEventListener("change", this.requestFrame);
    this.controls.removeEventListener("change", this.updateCameraData);
    this.controls.dispose();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.handleContextLost);
    this.renderer.domElement.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.removeDomainMeshes();
    this.modeTexture.dispose();
    this.berlinTexture.dispose();
    this.material.dispose();
    this.outlineMaterial.dispose();
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    delete this.host.dataset.rendererReady;
    this.host.dataset.membraneStatus = "destroyed";
  }

  private readonly requestFrame = (): void => {
    if (this.destroyed || this.contextLost || !this.pageVisible || this.rafId !== 0) return;
    this.rafId = window.requestAnimationFrame(this.renderFrame);
  };

  private readonly renderFrame = (time: number): void => {
    this.rafId = 0;
    if (this.destroyed || this.contextLost || !this.pageVisible) return;

    if (this.playing && this.domain) {
      if (this.previousFrameTime !== null) {
        const elapsedSeconds = Math.min(0.1, Math.max(0, (time - this.previousFrameTime) / 1000));
        const cycleSeconds = animationCycleSeconds(
          this.domain.eigenvalues[this.modeIndex] ?? Number.NaN,
          this.domain.eigenvalues[0] ?? Number.NaN
        );
        this.phase = (this.phase + (elapsedSeconds * TWO_PI) / cycleSeconds) % TWO_PI;
        this.uniforms.uPhase.value = this.phase;
        this.updatePhaseData();
      }
      this.previousFrameTime = time;
    } else {
      this.previousFrameTime = null;
    }

    const cameraMoving = this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.frameSequence += 1;
    this.host.dataset.frame = `${this.frameSequence}`;
    const memory = this.renderer.info.memory;
    this.host.dataset.geometryCount = `${memory.geometries}`;
    this.host.dataset.textureCount = `${memory.textures}`;
    this.host.dataset.programCount = `${this.renderer.info.programs?.length ?? 0}`;
    if ((this.playing && this.domain) || cameraMoving) this.requestFrame();
  };

  private readonly updateCameraData = (): void => {
    if (this.destroyed) return;
    const { x, y, z } = this.camera.position;
    this.host.dataset.camera = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
    const offsetX = x - this.controls.target.x;
    const offsetY = y - this.controls.target.y;
    const offsetZ = z - this.controls.target.z;
    const distance = Math.hypot(offsetX, offsetY, offsetZ);
    const verticalFraction = distance > Number.EPSILON ? Math.abs(offsetY) / distance : 1;
    this.host.dataset.cameraVerticalFraction = verticalFraction.toFixed(4);
  };

  private updateSelectionData(): void {
    this.host.dataset.modeIndex = `${this.modeIndex}`;
    this.host.dataset.modeNumber = `${this.modeIndex + 1}`;
    if (!this.domain) {
      delete this.host.dataset.eigenvalue;
      delete this.host.dataset.angularFrequency;
      delete this.host.dataset.frequencyRatio;
      delete this.host.dataset.cycleSeconds;
      return;
    }
    const eigenvalue = this.domain.eigenvalues[this.modeIndex];
    const fundamental = this.domain.eigenvalues[0];
    if (eigenvalue === undefined || fundamental === undefined) return;
    this.host.dataset.eigenvalue = `${eigenvalue}`;
    this.host.dataset.angularFrequency = `${Math.sqrt(eigenvalue)}`;
    this.host.dataset.frequencyRatio = `${frequencyRatioToFundamental(eigenvalue, fundamental)}`;
    this.host.dataset.cycleSeconds = `${animationCycleSeconds(eigenvalue, fundamental)}`;
  }

  private updatePhaseData(): void {
    this.host.dataset.phase = this.phase.toFixed(6);
  }

  private removeDomainMeshes(): void {
    if (this.surface) this.scene.remove(this.surface);
    if (this.outline) this.scene.remove(this.outline);
    this.surfaceGeometry?.dispose();
    this.outlineGeometry?.dispose();
    this.surface = null;
    this.outline = null;
    this.surfaceGeometry = null;
    this.outlineGeometry = null;
  }

  private cancelFrame(): void {
    if (this.rafId === 0) return;
    window.cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }
}

/** Compatibility names matching the square reference application's renderer. */
export { DomainMembraneRenderer as MembraneRenderer };
export { DomainMembraneRenderer as ThreeMembraneRenderer };

function prepareDomain(data: DomainModeSet): PreparedDomain {
  assertGridDimension(data.width, "width");
  assertGridDimension(data.height, "height");
  const sampleCount = data.width * data.height;
  if (!Number.isSafeInteger(sampleCount) || sampleCount > MAX_GRID_SAMPLES) {
    throw new RangeError(
      `The grid may contain at most ${MAX_GRID_SAMPLES} samples; received ${String(sampleCount)}.`
    );
  }
  if (data.mask.length !== sampleCount) {
    throw new RangeError(`Mask length must be ${sampleCount}; received ${data.mask.length}.`);
  }
  if (data.modes.length !== MEMBRANE_MODE_COUNT) {
    throw new RangeError(
      `Exactly ${MEMBRANE_MODE_COUNT} eigenmodes are required; received ${data.modes.length}.`
    );
  }
  if (data.eigenvalues.length !== MEMBRANE_MODE_COUNT) {
    throw new RangeError(
      `Exactly ${MEMBRANE_MODE_COUNT} eigenvalues are required; received ${data.eigenvalues.length}.`
    );
  }

  const maskPixels = new Uint8Array(sampleCount);
  let activeSampleCount = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const value = data.mask[index];
    if (value !== 0 && value !== 1 && value !== 255) {
      throw new RangeError(`Mask values must be binary (0/1 or 0/255); found ${String(value)}.`);
    }
    if (value !== 0) {
      maskPixels[index] = 255;
      activeSampleCount += 1;
    }
  }
  if (activeSampleCount < 4) {
    throw new RangeError("The domain mask must contain at least four active samples.");
  }

  const eigenvalues = new Float64Array(MEMBRANE_MODE_COUNT);
  for (let index = 0; index < MEMBRANE_MODE_COUNT; index += 1) {
    const value = Number(data.eigenvalues[index]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`Eigenvalue ${index + 1} must be positive and finite.`);
    }
    const previous = eigenvalues[index - 1];
    if (previous !== undefined && value < previous) {
      throw new RangeError("Eigenvalues must be ordered from lowest to highest.");
    }
    eigenvalues[index] = value;
  }

  const normalizedModes: Float32Array[] = [];
  for (let modeIndex = 0; modeIndex < MEMBRANE_MODE_COUNT; modeIndex += 1) {
    const source = data.modes[modeIndex];
    if (!source || source.length !== sampleCount) {
      throw new RangeError(
        `Eigenmode ${modeIndex + 1} must contain ${sampleCount} samples; received ${source?.length ?? 0}.`
      );
    }
    let maxAbsoluteValue = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      if (maskPixels[sampleIndex] === 0) continue;
      const value = Number(source[sampleIndex]);
      if (!Number.isFinite(value)) {
        throw new RangeError(
          `Eigenmode ${modeIndex + 1} contains a non-finite active sample at index ${sampleIndex}.`
        );
      }
      maxAbsoluteValue = Math.max(maxAbsoluteValue, Math.abs(value));
    }
    if (maxAbsoluteValue <= Number.EPSILON) {
      throw new RangeError(`Eigenmode ${modeIndex + 1} is zero throughout the active domain.`);
    }
    const normalized = new Float32Array(sampleCount);
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      if (maskPixels[sampleIndex] !== 0) {
        normalized[sampleIndex] = Number(source[sampleIndex]) / maxAbsoluteValue;
      }
    }
    normalizedModes.push(normalized);
  }

  const aspectRatio = data.aspectRatio ?? (data.width - 1) / (data.height - 1);
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new RangeError(`aspectRatio must be positive and finite; received ${String(aspectRatio)}.`);
  }
  const worldWidth = aspectRatio >= 1 ? 1 : aspectRatio;
  const worldHeight = aspectRatio >= 1 ? 1 / aspectRatio : 1;
  const visualBoundary = prepareVisualBoundary(data.visualBoundary);

  return {
    width: data.width,
    height: data.height,
    maskPixels,
    normalizedModes: Object.freeze(normalizedModes),
    eigenvalues,
    worldWidth,
    worldHeight,
    activeSampleCount,
    visualBoundary
  };
}

function prepareVisualBoundary(
  boundary: ShapeVisualBoundary | undefined
): ShapeVisualBoundary | null {
  if (!boundary) return null;
  if (boundary.kind === "mit-spiral") return Object.freeze({ kind: "mit-spiral" });
  if (boundary.kind === "contours") {
    if (boundary.loops.length === 0) {
      throw new RangeError("A contour visual boundary needs at least one loop.");
    }
    const loops = boundary.loops.map((loop) => {
      if (loop.length < 3) {
        throw new RangeError("Every visual-boundary contour needs at least three vertices.");
      }
      const vertices = loop.map((vertex) => {
        if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) {
          throw new RangeError("Visual-boundary contour vertices must be finite.");
        }
        return Object.freeze({ x: vertex.x, y: vertex.y });
      });
      if (Math.abs(polygonTwiceArea(vertices)) <= 1e-12) {
        throw new RangeError("Every visual-boundary contour must enclose a nonzero area.");
      }
      return Object.freeze(vertices);
    });
    return Object.freeze({ kind: "contours", loops: Object.freeze(loops) });
  }
  if (boundary.kind === "radial") {
    if (!Number.isFinite(boundary.outerRadius) || boundary.outerRadius <= 0) {
      throw new RangeError("A radial visual boundary needs a positive outer radius.");
    }
    if (boundary.innerRadius !== undefined) {
      if (
        !Number.isFinite(boundary.innerRadius) ||
        boundary.innerRadius <= 0 ||
        boundary.innerRadius >= boundary.outerRadius
      ) {
        throw new RangeError("A radial inner radius must be positive and below its outer radius.");
      }
      return Object.freeze({
        kind: "radial",
        outerRadius: boundary.outerRadius,
        innerRadius: boundary.innerRadius
      });
    }
    return Object.freeze({ kind: "radial", outerRadius: boundary.outerRadius });
  }

  if (boundary.vertices.length < 3) {
    throw new RangeError("A polygon visual boundary needs at least three vertices.");
  }
  const vertices = boundary.vertices.map((vertex) => {
    if (!Number.isFinite(vertex.x) || !Number.isFinite(vertex.y)) {
      throw new RangeError("Visual-boundary vertices must be finite.");
    }
    return Object.freeze({ x: vertex.x, y: vertex.y });
  });
  if (Math.abs(polygonTwiceArea(vertices)) <= 1e-12) {
    throw new RangeError("A polygon visual boundary must enclose a nonzero area.");
  }
  return Object.freeze({ kind: "polygon", vertices: Object.freeze(vertices) });
}

function buildDomainGeometry(domain: PreparedDomain): DomainGeometry {
  return domain.visualBoundary
    ? buildAnalyticDomainGeometry(domain, domain.visualBoundary)
    : buildRasterDomainGeometry(domain);
}

interface AnalyticSurfaceVertex {
  readonly normalizedX: number;
  readonly normalizedY: number;
  readonly worldX: number;
  readonly worldZ: number;
  readonly sampleU: number;
  readonly sampleV: number;
  readonly gridU: number;
  readonly gridV: number;
  readonly inside: boolean;
  readonly fixed: boolean;
}

interface OutlinePoint {
  readonly x: number;
  readonly z: number;
}

interface AnalyticBoundarySegment {
  readonly start: AnalyticSurfaceVertex;
  readonly end: AnalyticSurfaceVertex;
  readonly outward: OutlinePoint;
}

interface AnalyticTriangleEdge {
  readonly start: AnalyticSurfaceVertex;
  readonly end: AnalyticSurfaceVertex;
  readonly interiorWitness: AnalyticSurfaceVertex;
  incidence: number;
}

interface OrderedBoundarySegment {
  readonly start: OutlinePoint;
  readonly end: OutlinePoint;
  readonly outward: OutlinePoint;
}

interface OutlineJoin {
  readonly inner: OutlinePoint;
  readonly previousOuter: OutlinePoint;
  readonly nextOuter: OutlinePoint;
  readonly bevel: boolean;
}

interface JoinedOutlineStats {
  readonly loopCount: number;
  readonly miterJoinCount: number;
  readonly bevelJoinCount: number;
}

function buildAnalyticDomainGeometry(
  domain: PreparedDomain,
  visualBoundary: ShapeVisualBoundary
): DomainGeometry {
  const { width, height, worldWidth, worldHeight } = domain;
  // Custom contours carry a denser 81-point solver field, so three render
  // intervals per numerical cell already produce a 241-point lattice. The
  // predefined 49-point fields retain four intervals and their 193-point
  // lattice. This keeps comparable geometric density while custom modes gain
  // genuine numerical detail instead of merely tessellating the same field.
  const renderSubdivisions =
    visualBoundary.kind === "contours"
      ? CUSTOM_ANALYTIC_RENDER_SUBDIVISIONS
      : PREDEFINED_ANALYTIC_RENDER_SUBDIVISIONS;
  const renderWidth = (width - 1) * renderSubdivisions + 1;
  const renderHeight = (height - 1) * renderSubdivisions + 1;
  const sampleVertices: AnalyticSurfaceVertex[] = new Array(renderWidth * renderHeight);
  const surfacePositions: number[] = [];
  const sampleUvs: number[] = [];
  const gridUvs: number[] = [];
  const fixedAttributes: number[] = [];
  const outlinePositions: number[] = [];
  const outlineSegments: AnalyticBoundarySegment[] = [];
  const surfaceTriangles: Array<readonly [
    AnalyticSurfaceVertex,
    AnalyticSurfaceVertex,
    AnalyticSurfaceVertex
  ]> = [];
  const triangleEdges = new Map<string, AnalyticTriangleEdge>();
  const dx = worldWidth / (width - 1);
  const dz = worldHeight / (height - 1);
  const outlineWidth = Math.min(OUTLINE_WIDTH, Math.min(dx, dz) * 0.8);

  for (let y = 0; y < renderHeight; y += 1) {
    const sampleY = y / renderSubdivisions;
    for (let x = 0; x < renderWidth; x += 1) {
      const sampleX = x / renderSubdivisions;
      const index = y * renderWidth + x;
      const normalizedX = -1 + (2 * (sampleX + 1)) / (width + 1);
      const normalizedY = -1 + (2 * (sampleY + 1)) / (height + 1);
      const level = boundaryLevel(visualBoundary, normalizedX, normalizedY);
      const onRenderBox =
        x === 0 || x === renderWidth - 1 || y === 0 || y === renderHeight - 1;
      sampleVertices[index] = {
        normalizedX,
        normalizedY,
        worldX: -worldWidth / 2 + sampleX * dx,
        worldZ: -worldHeight / 2 + sampleY * dz,
        sampleU: (sampleX + 0.5) / width,
        sampleV: (sampleY + 0.5) / height,
        gridU: sampleX / (width - 1),
        gridV: sampleY / (height - 1),
        inside: level >= 0,
        fixed: Math.abs(level) <= 1e-10 || onRenderBox
      };
    }
  }

  let activeCellCount = 0;
  for (let y = 0; y < renderHeight - 1; y += 1) {
    for (let x = 0; x < renderWidth - 1; x += 1) {
      const lowerLeft = y * renderWidth + x;
      const lowerRight = lowerLeft + 1;
      const upperLeft = lowerLeft + renderWidth;
      const upperRight = upperLeft + 1;
      const cellTriangles: readonly (readonly [number, number, number])[] = [
        [lowerLeft, upperLeft, lowerRight],
        [lowerRight, upperLeft, upperRight]
      ];
      let cellHasArea = false;

      for (const triangle of cellTriangles) {
        const first = sampleVertices[triangle[0]];
        const second = sampleVertices[triangle[1]];
        const third = sampleVertices[triangle[2]];
        if (!first || !second || !third) {
          throw new Error("Invalid analytic surface topology.");
        }
        const clipped = clipTriangleToBoundary(
          [first, second, third],
          visualBoundary
        );
        if (clipped.length < 3) continue;

        const anchor = clipped[0];
        if (!anchor) continue;
        for (let index = 1; index < clipped.length - 1; index += 1) {
          const secondVertex = clipped[index];
          const thirdVertex = clipped[index + 1];
          if (!secondVertex || !thirdVertex) continue;
          if (triangleArea(anchor, secondVertex, thirdVertex) <= 1e-14) continue;
          recordAnalyticTriangleEdges(
            triangleEdges,
            anchor,
            secondVertex,
            thirdVertex
          );
          surfaceTriangles.push([anchor, secondVertex, thirdVertex]);
          cellHasArea = true;
        }
      }
      if (cellHasArea) activeCellCount += 1;
    }
  }

  const fixedVertexKeys = new Set<string>();
  for (const edge of triangleEdges.values()) {
    if (edge.incidence !== 1) continue;
    fixedVertexKeys.add(analyticVertexKey(edge.start));
    fixedVertexKeys.add(analyticVertexKey(edge.end));
    const outward = analyticSegmentOutward(
      edge.start,
      edge.end,
      [edge.start, edge.end, edge.interiorWitness],
      visualBoundary,
      width,
      height,
      worldWidth,
      worldHeight,
      outlineWidth
    );
    outlineSegments.push({ start: edge.start, end: edge.end, outward });
  }
  const boundarySegmentCount = outlineSegments.length;

  // Incidence-one edges are the exact footprint of the triangles sent to the
  // GPU. Clamp every duplicate occurrence of their endpoints so the moving
  // surface and the joined frame share one boundary, including discontinuous
  // implicit seams such as the MIT spiral's atan2 branch.
  for (const triangle of surfaceTriangles) {
    for (const vertex of triangle) {
      appendAnalyticVertex(
        vertex,
        fixedVertexKeys.has(analyticVertexKey(vertex)),
        surfacePositions,
        sampleUvs,
        gridUvs,
        fixedAttributes
      );
    }
  }

  if (activeCellCount === 0 || surfacePositions.length === 0) {
    throw new RangeError("The analytic boundary does not contain an active grid cell.");
  }
  if (boundarySegmentCount < 3) {
    throw new RangeError("The analytic boundary did not produce a closed visual edge.");
  }
  const joinedOutline = addJoinedAnalyticOutline(
    outlinePositions,
    outlineSegments,
    outlineWidth,
    OUTLINE_HEIGHT
  );

  const surface = new THREE.BufferGeometry();
  surface.setAttribute("position", new THREE.Float32BufferAttribute(surfacePositions, 3));
  surface.setAttribute("uv", new THREE.Float32BufferAttribute(sampleUvs, 2));
  surface.setAttribute("gridUv", new THREE.Float32BufferAttribute(gridUvs, 2));
  surface.setAttribute("boundary", new THREE.Float32BufferAttribute(fixedAttributes, 1));
  surface.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.78);
  surface.computeBoundingBox();

  const outline = new THREE.BufferGeometry();
  outline.setAttribute("position", new THREE.Float32BufferAttribute(outlinePositions, 3));
  outline.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.78);
  outline.computeBoundingBox();

  return {
    surface,
    outline,
    activeCellCount,
    boundarySegmentCount,
    outlineLoopCount: joinedOutline.loopCount,
    outlineMiterJoinCount: joinedOutline.miterJoinCount,
    outlineBevelJoinCount: joinedOutline.bevelJoinCount,
    outlineJoinStyle: "joined-ribbon",
    renderWidth,
    renderHeight,
    renderSubdivisions
  };
}

function clipTriangleToBoundary(
  triangle: readonly AnalyticSurfaceVertex[],
  boundary: ShapeVisualBoundary
): readonly AnalyticSurfaceVertex[] {
  const clipped: AnalyticSurfaceVertex[] = [];
  let previous = triangle[triangle.length - 1];
  if (!previous) return clipped;

  for (const current of triangle) {
    if (current.inside) {
      if (!previous.inside) clipped.push(boundaryIntersection(previous, current, boundary));
      clipped.push(current);
    } else if (previous.inside) {
      clipped.push(boundaryIntersection(previous, current, boundary));
    }
    previous = current;
  }
  return removeAdjacentDuplicateVertices(clipped);
}

function boundaryIntersection(
  start: AnalyticSurfaceVertex,
  end: AnalyticSurfaceVertex,
  boundary: ShapeVisualBoundary
): AnalyticSurfaceVertex {
  const startLevel = boundaryLevel(boundary, start.normalizedX, start.normalizedY);
  const endLevel = boundaryLevel(boundary, end.normalizedX, end.normalizedY);
  if (Math.abs(startLevel) <= 1e-12) return { ...start, inside: true, fixed: true };
  if (Math.abs(endLevel) <= 1e-12) return { ...end, inside: true, fixed: true };

  let lower = 0;
  let upper = 1;
  let lowerInside = start.inside;
  for (let iteration = 0; iteration < 44; iteration += 1) {
    const fraction = (lower + upper) / 2;
    const normalizedX = interpolate(start.normalizedX, end.normalizedX, fraction);
    const normalizedY = interpolate(start.normalizedY, end.normalizedY, fraction);
    const midpointInside = boundaryLevel(boundary, normalizedX, normalizedY) >= 0;
    if (midpointInside === lowerInside) lower = fraction;
    else upper = fraction;
  }
  const fraction = (lower + upper) / 2;
  return {
    normalizedX: interpolate(start.normalizedX, end.normalizedX, fraction),
    normalizedY: interpolate(start.normalizedY, end.normalizedY, fraction),
    worldX: interpolate(start.worldX, end.worldX, fraction),
    worldZ: interpolate(start.worldZ, end.worldZ, fraction),
    sampleU: interpolate(start.sampleU, end.sampleU, fraction),
    sampleV: interpolate(start.sampleV, end.sampleV, fraction),
    gridU: interpolate(start.gridU, end.gridU, fraction),
    gridV: interpolate(start.gridV, end.gridV, fraction),
    inside: true,
    fixed: true
  };
}

function boundaryLevel(boundary: ShapeVisualBoundary, x: number, y: number): number {
  if (boundary.kind === "mit-spiral") {
    const radius = Math.hypot(x, y);
    const theta = Math.atan2(y, x);
    const radialOffset = radius - theta / (2 * Math.PI) - 0.5;
    return Math.exp(-(radialOffset * radialOffset) / (0.3 * 0.3)) - 0.5;
  }
  if (boundary.kind === "radial") {
    const radius = Math.hypot(x, y);
    const outerClearance = boundary.outerRadius - radius;
    return boundary.innerRadius === undefined
      ? outerClearance
      : Math.min(outerClearance, radius - boundary.innerRadius);
  }

  if (boundary.kind === "contours") {
    let inside = false;
    let minimumDistanceSquared = Number.POSITIVE_INFINITY;
    for (const loop of boundary.loops) {
      const evaluation = evaluatePolygonLoop(loop, x, y);
      if (evaluation.inside) inside = !inside;
      minimumDistanceSquared = Math.min(
        minimumDistanceSquared,
        evaluation.minimumDistanceSquared
      );
    }
    const distance = Math.sqrt(minimumDistanceSquared);
    if (distance <= 1e-12) return 0;
    return inside ? distance : -distance;
  }

  const evaluation = evaluatePolygonLoop(boundary.vertices, x, y);
  const distance = Math.sqrt(evaluation.minimumDistanceSquared);
  if (distance <= 1e-12) return 0;
  return evaluation.inside ? distance : -distance;
}

function evaluatePolygonLoop(
  vertices: readonly Point2D[],
  x: number,
  y: number
): { readonly inside: boolean; readonly minimumDistanceSquared: number } {
  let inside = false;
  let minimumDistanceSquared = Number.POSITIVE_INFINITY;
  let previous = vertices[vertices.length - 1];
  if (!previous) return { inside: false, minimumDistanceSquared };
  for (const current of vertices) {
    minimumDistanceSquared = Math.min(
      minimumDistanceSquared,
      pointToSegmentDistanceSquared(x, y, previous, current)
    );
    const crosses = (current.y > y) !== (previous.y > y);
    if (
      crosses &&
      x < ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x
    ) {
      inside = !inside;
    }
    previous = current;
  }
  return { inside, minimumDistanceSquared };
}

function polygonTwiceArea(vertices: readonly Point2D[]): number {
  let twiceArea = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    if (!current || !next) continue;
    twiceArea += current.x * next.y - current.y * next.x;
  }
  return twiceArea;
}

function pointToSegmentDistanceSquared(
  x: number,
  y: number,
  start: Point2D,
  end: Point2D
): number {
  const segmentX = end.x - start.x;
  const segmentY = end.y - start.y;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  if (lengthSquared <= Number.EPSILON) {
    return (x - start.x) ** 2 + (y - start.y) ** 2;
  }
  const fraction = THREE.MathUtils.clamp(
    ((x - start.x) * segmentX + (y - start.y) * segmentY) / lengthSquared,
    0,
    1
  );
  const offsetX = x - interpolate(start.x, end.x, fraction);
  const offsetY = y - interpolate(start.y, end.y, fraction);
  return offsetX * offsetX + offsetY * offsetY;
}

function removeAdjacentDuplicateVertices(
  vertices: readonly AnalyticSurfaceVertex[]
): readonly AnalyticSurfaceVertex[] {
  const unique: AnalyticSurfaceVertex[] = [];
  for (const vertex of vertices) {
    const previous = unique[unique.length - 1];
    if (previous && squaredWorldDistance(previous, vertex) <= 1e-20) {
      if (vertex.fixed && !previous.fixed) unique[unique.length - 1] = { ...previous, fixed: true };
      continue;
    }
    unique.push(vertex);
  }
  if (
    unique.length > 1 &&
    squaredWorldDistance(unique[0]!, unique[unique.length - 1]!) <= 1e-20
  ) {
    unique.pop();
  }
  return unique;
}

function appendAnalyticVertex(
  vertex: AnalyticSurfaceVertex,
  fixed: boolean,
  positions: number[],
  sampleUvs: number[],
  gridUvs: number[],
  fixedAttributes: number[]
): void {
  positions.push(vertex.worldX, 0, vertex.worldZ);
  sampleUvs.push(vertex.sampleU, vertex.sampleV);
  gridUvs.push(vertex.gridU, vertex.gridV);
  fixedAttributes.push(fixed ? 1 : 0);
}

function triangleArea(
  first: AnalyticSurfaceVertex,
  second: AnalyticSurfaceVertex,
  third: AnalyticSurfaceVertex
): number {
  return Math.abs(
    (second.worldX - first.worldX) * (third.worldZ - first.worldZ) -
      (second.worldZ - first.worldZ) * (third.worldX - first.worldX)
  ) / 2;
}

function recordAnalyticTriangleEdges(
  edges: Map<string, AnalyticTriangleEdge>,
  first: AnalyticSurfaceVertex,
  second: AnalyticSurfaceVertex,
  third: AnalyticSurfaceVertex
): void {
  recordAnalyticTriangleEdge(edges, first, second, third);
  recordAnalyticTriangleEdge(edges, second, third, first);
  recordAnalyticTriangleEdge(edges, third, first, second);
}

function recordAnalyticTriangleEdge(
  edges: Map<string, AnalyticTriangleEdge>,
  start: AnalyticSurfaceVertex,
  end: AnalyticSurfaceVertex,
  interiorWitness: AnalyticSurfaceVertex
): void {
  const key = undirectedSegmentKey(start, end);
  const existing = edges.get(key);
  if (!existing) {
    edges.set(key, { start, end, interiorWitness, incidence: 1 });
    return;
  }
  existing.incidence += 1;
  if (existing.incidence > 2) {
    throw new Error(
      `Rendered analytic surface is non-manifold at edge ${key}; ` +
        `found ${existing.incidence} incident triangles.`
    );
  }
}

function squaredWorldDistance(
  first: AnalyticSurfaceVertex,
  second: AnalyticSurfaceVertex
): number {
  return (first.worldX - second.worldX) ** 2 + (first.worldZ - second.worldZ) ** 2;
}

function undirectedSegmentKey(
  first: AnalyticSurfaceVertex,
  second: AnalyticSurfaceVertex
): string {
  const firstKey = analyticVertexKey(first);
  const secondKey = analyticVertexKey(second);
  return firstKey < secondKey ? `${firstKey}|${secondKey}` : `${secondKey}|${firstKey}`;
}

function analyticVertexKey(vertex: AnalyticSurfaceVertex): string {
  return `${Math.round(vertex.worldX * 1e9)},${Math.round(vertex.worldZ * 1e9)}`;
}

function interpolate(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction;
}

function buildRasterDomainGeometry(domain: PreparedDomain): DomainGeometry {
  const { width, height, maskPixels, worldWidth, worldHeight } = domain;
  const sampleCount = width * height;
  const basePositions = new Float32Array(sampleCount * 3);
  const baseSampleUvs = new Float32Array(sampleCount * 2);
  const baseGridUvs = new Float32Array(sampleCount * 2);
  const boundary = new Float32Array(sampleCount);
  const indices: number[] = [];
  const activeCells = new Uint8Array((height - 1) * (width - 1));
  const horizontalCounts = new Uint8Array(height * (width - 1));
  const verticalCounts = new Uint8Array((height - 1) * width);
  const dx = worldWidth / (width - 1);
  const dz = worldHeight / (height - 1);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const positionOffset = index * 3;
      const uvOffset = index * 2;
      basePositions[positionOffset] = -worldWidth / 2 + x * dx;
      basePositions[positionOffset + 1] = 0;
      basePositions[positionOffset + 2] = -worldHeight / 2 + y * dz;
      baseSampleUvs[uvOffset] = (x + 0.5) / width;
      baseSampleUvs[uvOffset + 1] = (y + 0.5) / height;
      baseGridUvs[uvOffset] = x / (width - 1);
      baseGridUvs[uvOffset + 1] = y / (height - 1);
      // Inactive samples are the zero-valued exterior nodes of the Dirichlet
      // scheme. A custom mask may also reach the raster edge, where there is
      // no exterior sample available, so clamp that outermost ring explicitly.
      boundary[index] =
        maskPixels[index] === 0 || x === 0 || x === width - 1 || y === 0 || y === height - 1
          ? 1
          : 0;
    }
  }

  let activeCellCount = 0;
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const lowerLeft = y * width + x;
      const lowerRight = lowerLeft + 1;
      const upperLeft = lowerLeft + width;
      const upperRight = upperLeft + 1;
      // Render the piecewise-linear extension of the discrete mode through
      // its first ring of zero exterior samples. Requiring four active corners
      // made the mesh stop at moving boundary-adjacent unknowns; the synthetic
      // vertical drop from there could then draw across the fixed outline.
      if (
        maskPixels[lowerLeft] === 0 &&
        maskPixels[lowerRight] === 0 &&
        maskPixels[upperLeft] === 0 &&
        maskPixels[upperRight] === 0
      ) {
        continue;
      }
      indices.push(lowerLeft, upperLeft, lowerRight, lowerRight, upperLeft, upperRight);
      activeCells[y * (width - 1) + x] = 1;
      incrementEdgeCount(horizontalCounts, y * (width - 1) + x);
      incrementEdgeCount(horizontalCounts, (y + 1) * (width - 1) + x);
      incrementEdgeCount(verticalCounts, y * width + x);
      incrementEdgeCount(verticalCounts, y * width + x + 1);
      activeCellCount += 1;
    }
  }
  if (activeCellCount === 0) {
    throw new RangeError("The mask does not contain an active grid cell.");
  }

  const outlinePositions: number[] = [];
  const outlineWidth = Math.min(OUTLINE_WIDTH, Math.min(dx, dz) * 0.8);
  let boundarySegmentCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      if (horizontalCounts[y * (width - 1) + x] !== 1) continue;
      const x0 = -worldWidth / 2 + x * dx;
      const x1 = x0 + dx;
      const z = -worldHeight / 2 + y * dz;
      const activeAbove =
        y < height - 1 && activeCells[y * (width - 1) + x] !== 0;
      const outwardZ = activeAbove ? -1 : 1;
      addBox(
        outlinePositions,
        x0 - outlineWidth / 2,
        x1 + outlineWidth / 2,
        -OUTLINE_HEIGHT / 2,
        OUTLINE_HEIGHT / 2,
        Math.min(z, z + outwardZ * outlineWidth),
        Math.max(z, z + outwardZ * outlineWidth)
      );
      boundarySegmentCount += 1;
    }
  }
  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (verticalCounts[y * width + x] !== 1) continue;
      const xPosition = -worldWidth / 2 + x * dx;
      const z0 = -worldHeight / 2 + y * dz;
      const z1 = z0 + dz;
      const activeRight =
        x < width - 1 && activeCells[y * (width - 1) + x] !== 0;
      const outwardX = activeRight ? -1 : 1;
      addBox(
        outlinePositions,
        Math.min(xPosition, xPosition + outwardX * outlineWidth),
        Math.max(xPosition, xPosition + outwardX * outlineWidth),
        -OUTLINE_HEIGHT / 2,
        OUTLINE_HEIGHT / 2,
        z0 - outlineWidth / 2,
        z1 + outlineWidth / 2
      );
      boundarySegmentCount += 1;
    }
  }

  const surface = new THREE.BufferGeometry();
  surface.setAttribute("position", new THREE.Float32BufferAttribute(basePositions, 3));
  surface.setAttribute("uv", new THREE.Float32BufferAttribute(baseSampleUvs, 2));
  surface.setAttribute("gridUv", new THREE.Float32BufferAttribute(baseGridUvs, 2));
  surface.setAttribute("boundary", new THREE.Float32BufferAttribute(boundary, 1));
  surface.setIndex(indices);
  surface.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.78);
  surface.computeBoundingBox();

  const outline = new THREE.BufferGeometry();
  outline.setAttribute("position", new THREE.Float32BufferAttribute(outlinePositions, 3));
  outline.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0.78);
  outline.computeBoundingBox();

  return {
    surface,
    outline,
    activeCellCount,
    boundarySegmentCount,
    outlineLoopCount: 0,
    outlineMiterJoinCount: 0,
    outlineBevelJoinCount: 0,
    outlineJoinStyle: "segment-boxes",
    renderWidth: width,
    renderHeight: height,
    renderSubdivisions: 1
  };
}

function surfaceTriangleCount(geometry: THREE.BufferGeometry): number {
  const elementCount =
    geometry.index?.count ?? geometry.getAttribute("position").count;
  return elementCount / 3;
}

function addBox(
  positions: number[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number
): void {
  const corners: readonly [number, number, number][] = [
    [minX, minY, minZ],
    [maxX, minY, minZ],
    [maxX, maxY, minZ],
    [minX, maxY, minZ],
    [minX, minY, maxZ],
    [maxX, minY, maxZ],
    [maxX, maxY, maxZ],
    [minX, maxY, maxZ]
  ];
  const triangles: readonly [number, number, number][] = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3],
    [1, 2, 6], [1, 6, 5]
  ];
  for (const [first, second, third] of triangles) {
    const a = corners[first];
    const b = corners[second];
    const c = corners[third];
    if (!a || !b || !c) throw new Error("Invalid outline box topology.");
    positions.push(...a, ...b, ...c);
  }
}

function analyticSegmentOutward(
  start: AnalyticSurfaceVertex,
  end: AnalyticSurfaceVertex,
  interiorPolygon: readonly AnalyticSurfaceVertex[],
  boundary: ShapeVisualBoundary,
  sampleWidth: number,
  sampleHeight: number,
  worldWidth: number,
  worldHeight: number,
  outlineWidth: number
): { readonly x: number; readonly z: number } {
  const deltaX = end.worldX - start.worldX;
  const deltaZ = end.worldZ - start.worldZ;
  const length = Math.hypot(deltaX, deltaZ);
  if (length <= Number.EPSILON) return { x: 0, z: 0 };

  // The clipped polygon is a piece of the accepted surface, so its non-edge
  // vertices provide a topology-local and level-set-independent interior
  // witness. This remains reliable for even-odd holes and where the MIT
  // spiral closes against the finite render box.
  const candidateX = -deltaZ / length;
  const candidateZ = deltaX / length;
  const midpointWorldX = (start.worldX + end.worldX) / 2;
  const midpointWorldZ = (start.worldZ + end.worldZ) / 2;
  let interiorProjection = 0;
  for (const vertex of interiorPolygon) {
    const projection =
      (vertex.worldX - midpointWorldX) * candidateX +
      (vertex.worldZ - midpointWorldZ) * candidateZ;
    if (Math.abs(projection) > Math.abs(interiorProjection)) {
      interiorProjection = projection;
    }
  }
  if (Math.abs(interiorProjection) > 1e-12) {
    const direction = interiorProjection > 0 ? -1 : 1;
    return { x: candidateX * direction, z: candidateZ * direction };
  }

  // Degenerate numerical fallback: the clipped MIT spiral can meet the finite
  // render box while its implicit level remains positive beyond that box.
  const boxTolerance = 1e-9;
  if (
    Math.abs(start.worldX + worldWidth / 2) <= boxTolerance &&
    Math.abs(end.worldX + worldWidth / 2) <= boxTolerance
  ) {
    return { x: -1, z: 0 };
  }
  if (
    Math.abs(start.worldX - worldWidth / 2) <= boxTolerance &&
    Math.abs(end.worldX - worldWidth / 2) <= boxTolerance
  ) {
    return { x: 1, z: 0 };
  }
  if (
    Math.abs(start.worldZ + worldHeight / 2) <= boxTolerance &&
    Math.abs(end.worldZ + worldHeight / 2) <= boxTolerance
  ) {
    return { x: 0, z: -1 };
  }
  if (
    Math.abs(start.worldZ - worldHeight / 2) <= boxTolerance &&
    Math.abs(end.worldZ - worldHeight / 2) <= boxTolerance
  ) {
    return { x: 0, z: 1 };
  }

  // Either perpendicular can be outward because contour winding is not part
  // of ShapeVisualBoundary's contract (and holes necessarily reverse the
  // intuitive choice). Probe the signed level set on both sides instead:
  // positive is interior, so the side with the smaller value is exterior.
  const normalizedPerWorldX = (2 * (sampleWidth - 1)) / ((sampleWidth + 1) * worldWidth);
  const normalizedPerWorldZ =
    (2 * (sampleHeight - 1)) / ((sampleHeight + 1) * worldHeight);
  const probeDistance = Math.max(outlineWidth * 0.75, 1e-5);
  const midpointX = (start.normalizedX + end.normalizedX) / 2;
  const midpointY = (start.normalizedY + end.normalizedY) / 2;
  const offsetX = candidateX * probeDistance * normalizedPerWorldX;
  const offsetY = candidateZ * probeDistance * normalizedPerWorldZ;
  const positiveSide = boundaryLevel(boundary, midpointX + offsetX, midpointY + offsetY);
  const negativeSide = boundaryLevel(boundary, midpointX - offsetX, midpointY - offsetY);
  const direction = positiveSide <= negativeSide ? 1 : -1;
  return { x: candidateX * direction, z: candidateZ * direction };
}

function addJoinedAnalyticOutline(
  positions: number[],
  segments: readonly AnalyticBoundarySegment[],
  width: number,
  height: number
): JoinedOutlineStats {
  const loops = orderBoundarySegmentLoops(segments);
  let miterJoinCount = 0;
  let bevelJoinCount = 0;
  for (const loop of loops) {
    const joins: OutlineJoin[] = loop.map((segment, index) => {
      const previous = loop[(index - 1 + loop.length) % loop.length];
      if (!previous) throw new Error("Joined outline loop is missing its previous segment.");
      const join = createOutlineJoin(
        segment.start,
        previous.outward,
        segment.outward,
        width
      );
      if (join.bevel) bevelJoinCount += 1;
      else miterJoinCount += 1;
      return join;
    });

    for (let index = 0; index < loop.length; index += 1) {
      const startJoin = joins[index];
      const endJoin = joins[(index + 1) % joins.length];
      if (!startJoin || !endJoin) {
        throw new Error("Joined outline loop is missing a segment join.");
      }
      addRibbonSegment(
        positions,
        startJoin.inner,
        endJoin.inner,
        startJoin.nextOuter,
        endJoin.previousOuter,
        height
      );
    }
    for (const join of joins) {
      if (join.bevel) addRibbonBevel(positions, join, height);
    }
  }
  return { loopCount: loops.length, miterJoinCount, bevelJoinCount };
}

function orderBoundarySegmentLoops(
  segments: readonly AnalyticBoundarySegment[]
): readonly (readonly OrderedBoundarySegment[])[] {
  interface BoundaryNode {
    readonly point: OutlinePoint;
    readonly segmentIndices: number[];
  }

  const nodes = new Map<string, BoundaryNode>();
  const appendEndpoint = (
    key: string,
    vertex: AnalyticSurfaceVertex,
    segmentIndex: number
  ): void => {
    const existing = nodes.get(key);
    if (existing) {
      existing.segmentIndices.push(segmentIndex);
      return;
    }
    nodes.set(key, {
      point: { x: vertex.worldX, z: vertex.worldZ },
      segmentIndices: [segmentIndex]
    });
  };

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) throw new Error("Joined outline is missing a boundary segment.");
    const startKey = analyticVertexKey(segment.start);
    const endKey = analyticVertexKey(segment.end);
    if (startKey === endKey) {
      throw new Error("Joined outline contains a zero-length boundary segment.");
    }
    appendEndpoint(startKey, segment.start, index);
    appendEndpoint(endKey, segment.end, index);
  }
  for (const [key, node] of nodes) {
    if (node.segmentIndices.length !== 2) {
      throw new Error(
        `Analytic boundary is not a closed two-regular contour at ${key}; ` +
          `found ${node.segmentIndices.length} incident segments.`
      );
    }
  }

  const visited = new Uint8Array(segments.length);
  const loops: OrderedBoundarySegment[][] = [];
  for (let seedIndex = 0; seedIndex < segments.length; seedIndex += 1) {
    if (visited[seedIndex] !== 0) continue;
    const seed = segments[seedIndex];
    if (!seed) throw new Error("Joined outline is missing its seed segment.");
    const firstKey = analyticVertexKey(seed.start);
    let currentStartKey = firstKey;
    let currentSegmentIndex = seedIndex;
    const loop: OrderedBoundarySegment[] = [];
    let closed = false;

    for (let step = 0; step <= segments.length; step += 1) {
      if (visited[currentSegmentIndex] !== 0) {
        throw new Error("Analytic boundary revisited a segment before closing its contour.");
      }
      const segment = segments[currentSegmentIndex];
      if (!segment) throw new Error("Joined outline is missing an ordered segment.");
      const storedStartKey = analyticVertexKey(segment.start);
      const storedEndKey = analyticVertexKey(segment.end);
      const currentEndKey =
        currentStartKey === storedStartKey
          ? storedEndKey
          : currentStartKey === storedEndKey
            ? storedStartKey
            : null;
      if (currentEndKey === null) {
        throw new Error("Analytic boundary segment does not meet the preceding contour vertex.");
      }
      const startNode = nodes.get(currentStartKey);
      const endNode = nodes.get(currentEndKey);
      if (!startNode || !endNode) throw new Error("Analytic boundary endpoint is unavailable.");
      const outwardLength = Math.hypot(segment.outward.x, segment.outward.z);
      if (!(outwardLength > Number.EPSILON)) {
        throw new Error("Analytic boundary segment has no exterior direction.");
      }
      loop.push({
        start: startNode.point,
        end: endNode.point,
        outward: {
          x: segment.outward.x / outwardLength,
          z: segment.outward.z / outwardLength
        }
      });
      visited[currentSegmentIndex] = 1;
      if (currentEndKey === firstKey) {
        closed = true;
        break;
      }

      const incident = endNode.segmentIndices;
      const nextSegmentIndex =
        incident[0] === currentSegmentIndex ? incident[1] : incident[0];
      if (nextSegmentIndex === undefined) {
        throw new Error("Analytic boundary contour ended before closing.");
      }
      currentStartKey = currentEndKey;
      currentSegmentIndex = nextSegmentIndex;
    }
    if (!closed || loop.length < 3) {
      throw new Error("Analytic boundary did not form a closed contour with at least three edges.");
    }
    loops.push(loop);
  }
  return loops;
}

function createOutlineJoin(
  inner: OutlinePoint,
  previousOutward: OutlinePoint,
  nextOutward: OutlinePoint,
  width: number
): OutlineJoin {
  const previousOuter = offsetOutlinePoint(inner, previousOutward, width);
  const nextOuter = offsetOutlinePoint(inner, nextOutward, width);
  const bisectorX = previousOutward.x + nextOutward.x;
  const bisectorZ = previousOutward.z + nextOutward.z;
  const bisectorLength = Math.hypot(bisectorX, bisectorZ);
  if (bisectorLength > 1e-8) {
    const directionX = bisectorX / bisectorLength;
    const directionZ = bisectorZ / bisectorLength;
    const previousProjection =
      directionX * previousOutward.x + directionZ * previousOutward.z;
    const nextProjection = directionX * nextOutward.x + directionZ * nextOutward.z;
    const projection = Math.min(previousProjection, nextProjection);
    const miterLength = width / projection;
    if (
      projection > 1e-6 &&
      Number.isFinite(miterLength) &&
      miterLength <= width * OUTLINE_MITER_LIMIT
    ) {
      const miter = {
        x: inner.x + directionX * miterLength,
        z: inner.z + directionZ * miterLength
      };
      return {
        inner,
        previousOuter: miter,
        nextOuter: miter,
        bevel: false
      };
    }
  }
  return { inner, previousOuter, nextOuter, bevel: true };
}

function offsetOutlinePoint(
  point: OutlinePoint,
  outward: OutlinePoint,
  distance: number
): OutlinePoint {
  return {
    x: point.x + outward.x * distance,
    z: point.z + outward.z * distance
  };
}

function addRibbonSegment(
  positions: number[],
  innerStart: OutlinePoint,
  innerEnd: OutlinePoint,
  outerStart: OutlinePoint,
  outerEnd: OutlinePoint,
  height: number
): void {
  const minY = -height / 2;
  const maxY = height / 2;
  addHorizontalQuad(positions, innerStart, innerEnd, outerEnd, outerStart, minY);
  addHorizontalQuad(positions, innerStart, innerEnd, outerEnd, outerStart, maxY);
  addVerticalQuad(positions, innerStart, innerEnd, minY, maxY);
  addVerticalQuad(positions, outerStart, outerEnd, minY, maxY);
}

function addRibbonBevel(
  positions: number[],
  join: OutlineJoin,
  height: number
): void {
  const minY = -height / 2;
  const maxY = height / 2;
  addHorizontalTriangle(
    positions,
    join.inner,
    join.previousOuter,
    join.nextOuter,
    minY
  );
  addHorizontalTriangle(
    positions,
    join.inner,
    join.previousOuter,
    join.nextOuter,
    maxY
  );
  addVerticalQuad(positions, join.previousOuter, join.nextOuter, minY, maxY);
}

function addHorizontalQuad(
  positions: number[],
  first: OutlinePoint,
  second: OutlinePoint,
  third: OutlinePoint,
  fourth: OutlinePoint,
  y: number
): void {
  addHorizontalTriangle(positions, first, second, third, y);
  addHorizontalTriangle(positions, first, third, fourth, y);
}

function addHorizontalTriangle(
  positions: number[],
  first: OutlinePoint,
  second: OutlinePoint,
  third: OutlinePoint,
  y: number
): void {
  positions.push(
    first.x, y, first.z,
    second.x, y, second.z,
    third.x, y, third.z
  );
}

function addVerticalQuad(
  positions: number[],
  start: OutlinePoint,
  end: OutlinePoint,
  minY: number,
  maxY: number
): void {
  positions.push(
    start.x, minY, start.z,
    end.x, minY, end.z,
    end.x, maxY, end.z,
    start.x, minY, start.z,
    end.x, maxY, end.z,
    start.x, maxY, start.z
  );
}

function incrementEdgeCount(counts: Uint8Array, index: number): void {
  const current = counts[index];
  if (current === undefined) throw new RangeError("Invalid domain-edge index.");
  counts[index] = current + 1;
}

function createModeTexture(pixels: Float32Array, width: number, height: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(
    pixels,
    width,
    height,
    THREE.RedFormat,
    THREE.FloatType
  );
  texture.name = "selected-eigenmode";
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.unpackAlignment = 1;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function assertGridDimension(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 2) {
    throw new RangeError(`${label} must be an integer of at least 2; received ${String(value)}.`);
  }
}

function assertModeIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= MEMBRANE_MODE_COUNT) {
    throw new RangeError(
      `Mode index must be an integer from 0 through ${MEMBRANE_MODE_COUNT - 1}; received ${String(index)}.`
    );
  }
}

const MEMBRANE_VERTEX_SHADER = /* glsl */ `
  uniform sampler2D uMode;
  uniform float uAmplitude;
  uniform float uPhase;
  uniform vec2 uTexel;
  uniform vec2 uWorldSize;

  attribute float boundary;
  attribute vec2 gridUv;

  varying vec2 vGridUv;
  varying float vBoundary;
  varying float vDisplacement;
  varying vec3 vViewNormal;

  void main() {
    // Exterior samples form the fixed zero-valued ring. Interior active
    // samples remain genuine finite-difference unknowns and are free to move.
    float spatial = texture2D(uMode, uv).r * (1.0 - boundary);
    float temporal = cos(uPhase);
    float displacement = spatial * temporal;

    vec3 displaced = position;
    displaced.y = uAmplitude * displacement;

    float left = texture2D(uMode, vec2(max(uTexel.x * 0.5, uv.x - uTexel.x), uv.y)).r;
    float right = texture2D(uMode, vec2(min(1.0 - uTexel.x * 0.5, uv.x + uTexel.x), uv.y)).r;
    float lower = texture2D(uMode, vec2(uv.x, max(uTexel.y * 0.5, uv.y - uTexel.y))).r;
    float upper = texture2D(uMode, vec2(uv.x, min(1.0 - uTexel.y * 0.5, uv.y + uTexel.y))).r;
    float xNumerator = right - left;
    float zNumerator = upper - lower;
    float xDenominator = 2.0 * uTexel.x * uWorldSize.x;
    float zDenominator = 2.0 * uTexel.y * uWorldSize.y;
    if (boundary > 0.5) {
      // The rendered fixed edge overrides the sampled mode to exactly zero.
      // Use the stronger inward one-sided slope there, also measured from
      // zero, rather than differentiating the unclamped texture through it.
      xNumerator = abs(left) >= abs(right) ? -left : right;
      zNumerator = abs(lower) >= abs(upper) ? -lower : upper;
      xDenominator = uTexel.x * uWorldSize.x;
      zDenominator = uTexel.y * uWorldSize.y;
    }
    float dydx = uAmplitude * temporal * xNumerator / max(xDenominator, 0.00001);
    float dydz = uAmplitude * temporal * zNumerator / max(zDenominator, 0.00001);
    vec3 objectNormal = normalize(vec3(-dydx, 1.0, -dydz));

    vGridUv = gridUv;
    vBoundary = boundary;
    vDisplacement = displacement;
    vViewNormal = normalize(normalMatrix * objectNormal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

const MEMBRANE_FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uBerlin;
  varying vec2 vGridUv;
  varying float vBoundary;
  varying float vDisplacement;
  varying vec3 vViewNormal;

  const float GRID_DIVISIONS = 16.0;

  float surfaceGrid(float coordinate) {
    float gridCoordinate = coordinate * GRID_DIVISIONS;
    float cellPosition = fract(gridCoordinate);
    float lineDistance = min(cellPosition, 1.0 - cellPosition);
    float pixelWidth = max(fwidth(gridCoordinate), 0.00001);
    return 1.0 - smoothstep(0.25 * pixelWidth, 0.9 * pixelWidth, lineDistance);
  }

  void main() {
    float paletteCoordinate = clamp(vDisplacement * 0.5 + 0.5, 0.0, 1.0);
    vec3 baseColor = texture2D(uBerlin, vec2(paletteCoordinate, 0.5)).rgb;

    vec3 normal = normalize(vViewNormal);
    if (!gl_FrontFacing) normal = -normal;
    float diffuse = 0.5 + 0.5 * max(0.0, dot(normal, normalize(vec3(0.28, 0.78, 0.56))));
    baseColor *= 0.88 + 0.12 * diffuse;

    float xGrid = surfaceGrid(vGridUv.x);
    float yGrid = surfaceGrid(vGridUv.y);
    float grid = max(xGrid, yGrid) * (1.0 - smoothstep(0.35, 1.0, vBoundary));
    vec3 gridColor = sRGBTransferEOTF(vec4(0.72, 0.78, 0.85, 1.0)).rgb;
    vec3 color = mix(baseColor, gridColor, grid * 0.28);

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

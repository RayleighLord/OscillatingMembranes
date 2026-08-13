import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  measureFlatOutlineContinuity,
  measureOutlineJoinContinuity,
  measureOutlineRetention,
  measureSurfaceSilhouetteExcursion
} from "./outline-visual-regression.mjs";

const host = "127.0.0.1";
const port = Number(process.env.BROWSER_SMOKE_PORT ?? 31_000 + (process.pid % 20_000));
const repositoryPath = "/OscillatingMembranes/";
const baseUrl = `http://${host}:${port}${repositoryPath}`;
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const artifactDir = new URL("../output/playwright/", import.meta.url);
const viteBin = fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url));
const deployedNotices = new URL("../dist/THIRD_PARTY_NOTICES.txt", import.meta.url);
const requestedChromePath = process.env.CHROME_PATH;
const systemChromePath = "/usr/bin/google-chrome";
const executablePath = requestedChromePath ?? (existsSync(systemChromePath) ? systemChromePath : undefined);

assert.ok(existsSync(deployedNotices), "The Pages artifact is missing third-party notices");
await mkdir(artifactDir, { recursive: true });

const preview = spawn(
  process.execPath,
  [viteBin, "preview", "--base", repositoryPath, "--host", host, "--port", `${port}`, "--strictPort"],
  { cwd: projectRoot, stdio: ["ignore", "inherit", "inherit"] }
);

let browser;
try {
  await waitForServer(baseUrl, preview);
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {})
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = collectBrowserErrors(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await waitForShape(page, "rectangle");

  await assertInitialState(page);
  await assertAllModesAndTiming(page);
  await assertShapeSelectionAndCache(page);
  await assertCustomDrawing(page);
  await assertBoundaryFrameContinuity(page);
  await assertPlaybackCameraAndCleanView(page);
  await assertMobileLayouts(browser, baseUrl);
  await assertReducedMotion(browser, baseUrl);

  assert.deepEqual(errors, [], `Browser errors:\n${errors.join("\n")}`);
  console.log("Browser smoke checks passed for numerical shapes, all 20 modes, and custom drawing.");
} finally {
  await browser?.close();
  preview.kill("SIGTERM");
  await waitForExit(preview);
}

async function assertInitialState(page) {
  const stage = page.locator("#membrane-stage");
  assert.equal(await page.title(), "Oscillating Membranes");
  assert.equal(await page.locator('[data-membrane-canvas="true"]').count(), 1);
  assert.equal(await page.locator("#mode-slider").getAttribute("min"), "1");
  assert.equal(await page.locator("#mode-slider").getAttribute("max"), "20");
  assert.equal(await page.locator("#mode-slider").inputValue(), "1");
  assert.equal(await stage.getAttribute("data-mode-count"), "20");
  assert.equal(await stage.getAttribute("data-amplitude"), "0.09");
  assert.equal(await stage.getAttribute("data-grid-visible"), "true");
  assert.equal(await stage.getAttribute("data-nodal-lines-visible"), null);
  assert.equal(await stage.getAttribute("data-outline-visible"), "true");
  assert.equal(await stage.getAttribute("data-domain-y-world-z-scale"), "-1");
  assert.equal(
    await stage.getAttribute("data-boundary-occlusion"),
    "depth-tested-exterior-frame"
  );
  assert.equal(await stage.getAttribute("data-boundary-pass-order"), "surface-outline");
  assert.equal(await stage.getAttribute("data-boundary-geometry"), "analytic");
  assert.equal(await stage.getAttribute("data-animation-timing"), "modal");
  assert.equal(await stage.getAttribute("data-frequency-ratio"), "1");
  assert.equal(await stage.getAttribute("data-cycle-seconds"), "10");
  assertRenderGeometry(await readRenderGeometry(stage), {
    label: "predefined rectangle",
    solverGridSize: 49,
    renderGridSize: 193,
    subdivisions: 4,
    minimumTriangles: 20_000,
    expectedOutlineLoops: 1
  });
  assert.ok(Number(await stage.getAttribute("data-active-sample-count")) > 500);
  assert.ok(Number(await stage.getAttribute("data-boundary-segment-count")) > 20);
  assert.equal(await page.locator("#formula-card").count(), 0);
  assert.equal(await page.locator("#frequency-ratio").count(), 0);
  assert.equal(await page.locator("#shape-menu-toggle strong").count(), 0);
  assert.match(
    await page.locator('[data-mode-tick="20"] annotation').textContent(),
    /^20$/
  );
  assert.equal(await page.locator("[data-mode-mark]").count(), 20);
  assert.deepEqual(
    await page.locator(".mode-tick-mark--major").evaluateAll((marks) =>
      marks.map((mark) => Number(mark.getAttribute("data-mode-mark")))
    ),
    [20, 15, 10, 5, 1]
  );
  const tickGeometry = await page.evaluate(() => {
    const majorValues = [20, 15, 10, 5, 1];
    const centerY = (selector) => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return (rect?.top ?? 0) + (rect?.height ?? 0) / 2;
    };
    return {
      labelCenters: majorValues.map((value) => centerY(`[data-mode-tick="${value}"]`)),
      majorMarkCenters: majorValues.map((value) => centerY(`[data-mode-mark="${value}"]`)),
      allMarkCenters: [...document.querySelectorAll("[data-mode-mark]")].map((mark) => {
        const rect = mark.getBoundingClientRect();
        return rect.top + rect.height / 2;
      }),
      controlLeft: document.querySelector("#mode-control")?.getBoundingClientRect().left ?? 0
    };
  });
  tickGeometry.labelCenters.forEach((labelCenter, index) => {
    assert.ok(
      Math.abs(labelCenter - tickGeometry.majorMarkCenters[index]) <= 1,
      `Major mode tick ${[20, 15, 10, 5, 1][index]} is not aligned with its label`
    );
  });
  for (let index = 1; index < tickGeometry.allMarkCenters.length; index += 1) {
    assert.ok(
      tickGeometry.allMarkCenters[index] > tickGeometry.allMarkCenters[index - 1],
      "Mode tick marks are not ordered from 20 down to 1"
    );
  }
  assert.ok(
    tickGeometry.controlLeft >= 30,
    `Mode control is too close to the viewport edge: ${tickGeometry.controlLeft}px`
  );
  const tickFontSize = await page
    .locator('[data-mode-tick="20"]')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const selectedModeFontSize = await page
    .locator("#mode-value")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  assert.ok(tickFontSize >= 12, `Mode tick font is too small: ${tickFontSize}px`);
  assert.ok(selectedModeFontSize >= 16, `Selected mode font is too small: ${selectedModeFontSize}px`);
  assert.match(await page.locator("#membrane-description").textContent(), /Repeated eigenfrequencies are represented once/);

  const targets = await page
    .locator("#shape-menu-toggle, #mode-slider, #reset-camera, #ui-visibility-toggle, #animation-toggle")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { id: element.id, tag: element.tagName, width: rect.width, height: rect.height };
      })
    );
  for (const target of targets) {
    assert.ok(target.width >= 44, `${target.id} is narrower than 44px`);
    if (target.tag === "BUTTON") assert.ok(target.height >= 44, `${target.id} is shorter than 44px`);
  }

  await page.locator("#animation-toggle").click();
  await page.screenshot({ path: new URL("browser-smoke-desktop.png", artifactDir).pathname });
}

async function assertAllModesAndTiming(page) {
  const slider = page.locator("#mode-slider");
  const stage = page.locator("#membrane-stage");
  let previousRatio = 0;
  for (let mode = 1; mode <= 20; mode += 1) {
    await slider.fill(String(mode));
    await page.waitForFunction(
      (number) => document.querySelector("#membrane-stage")?.getAttribute("data-mode-number") === String(number),
      mode
    );
    const ratio = Number(await stage.getAttribute("data-frequency-ratio"));
    const cycle = Number(await stage.getAttribute("data-cycle-seconds"));
    assert.ok(ratio > previousRatio, `Mode ${mode} is not strictly above the previous retained frequency`);
    assert.ok(Math.abs(cycle * ratio - 10) < 1e-10, `Mode ${mode} does not preserve modal timing`);
    previousRatio = ratio;
  }
  assert.equal(await page.locator("#mode-value annotation").textContent(), "20");

  await slider.fill("1");
  const fundamentalAdvance = await measurePhaseAdvance(page, 420);
  await slider.fill("20");
  const highestAdvance = await measurePhaseAdvance(page, 420);
  assert.ok(
    highestAdvance > fundamentalAdvance * 1.8,
    `Expected mode 20 to animate substantially faster; got ${highestAdvance} vs ${fundamentalAdvance}`
  );
  await slider.fill("1");
}

async function assertShapeSelectionAndCache(page) {
  const stage = page.locator("#membrane-stage");
  await chooseShape(page, "Circle", "circle");
  assert.equal(await stage.getAttribute("data-boundary-geometry"), "analytic");
  const circleNodes = Number(await stage.getAttribute("data-solver-active-nodes"));
  assert.ok(circleNodes > 900);
  assert.equal(await stage.getAttribute("data-solver-cache"), "false");

  await page.locator("#shape-menu-toggle").click();
  const circleOption = page.getByRole("option", { name: "Circle" });
  await circleOption.press("ArrowDown");
  await page.getByRole("option", { name: "Rectangle" }).press("ArrowDown");
  const triangleOption = page.getByRole("option", { name: "Triangle" });
  await triangleOption.press("Enter");
  await waitForShape(page, "triangle");
  assert.equal(await page.locator("#shape-menu").isVisible(), false);
  assert.equal(await stage.getAttribute("data-boundary-geometry"), "analytic");
  assert.equal(await stage.getAttribute("data-mode-count"), "20");
  assert.ok(Number(await stage.getAttribute("data-solver-active-nodes")) > 400);

  for (const [name, key] of [
    ["Pentagon", "pentagon"],
    ["Hexagon", "hexagon"],
    ["Annulus", "annulus"]
  ]) {
    await chooseShape(page, name, key);
    assert.equal(await stage.getAttribute("data-boundary-geometry"), "analytic");
    assert.equal(await stage.getAttribute("data-mode-count"), "20");
    assert.ok(Number(await stage.getAttribute("data-solver-active-nodes")) > 400);
  }

  await chooseShape(page, "Spiral", "spiral");
  assert.equal(await stage.getAttribute("data-boundary-geometry"), "analytic");
  assert.ok(Number(await stage.getAttribute("data-solver-active-nodes")) > 700);
  assert.match(await page.locator("#membrane-description").textContent(), /spiral/i);

  await chooseShape(page, "Circle", "circle");
  assert.equal(await stage.getAttribute("data-solver-cache"), "true");
  assert.equal(Number(await stage.getAttribute("data-solver-active-nodes")), circleNodes);

  await page.locator("#shape-menu-toggle").click();
  await page.getByRole("option", { name: "Rectangle" }).click();
  await waitForShape(page, "rectangle");
  assert.equal(await stage.getAttribute("data-boundary-geometry"), "analytic");
  const defaultRectangleNodes = Number(await stage.getAttribute("data-solver-active-nodes"));
  await page.locator("#shape-menu-toggle").click();
  const aspect = page.getByRole("slider", { name: "Width / height" });
  await aspect.fill("0.75");
  await page.waitForFunction(
    ({ key, previousNodes }) => {
      const stage = document.querySelector("#membrane-stage");
      return (
        stage?.getAttribute("data-shape") === key &&
        stage.getAttribute("data-membrane-status") === "ready" &&
        Number(stage.getAttribute("data-solver-active-nodes")) !== previousNodes &&
        document.querySelector("#app-shell")?.getAttribute("data-solving") === "false"
      );
    },
    { key: "rectangle", previousNodes: defaultRectangleNodes },
    { timeout: 20_000 }
  );
  assert.equal(await aspect.inputValue(), "0.75");
  await page.locator("#shape-menu-close").click();
}

async function assertCustomDrawing(page) {
  await page.locator("#shape-menu-toggle").click();
  await page.locator("#draw-shape").click();
  const canvas = page.locator("#drawing-canvas");
  assert.match(
    await canvas.getAttribute("aria-label"),
    /Interactive 49 by 49 .*grid/,
    "The keyboard drawing interaction should retain its established 49-step grid"
  );
  const bounds = await canvas.boundingBox();
  assert.ok(bounds, "Drawing canvas has no pointer bounds");
  const points = [
    [0.18, 0.4],
    [0.25, 0.18],
    [0.48, 0.28],
    [0.66, 0.14],
    [0.84, 0.32],
    [0.7, 0.5],
    [0.86, 0.7],
    [0.58, 0.82],
    [0.42, 0.66],
    [0.23, 0.84],
    [0.12, 0.62],
    [0.18, 0.4]
  ];
  await page.mouse.move(bounds.x + bounds.width * points[0][0], bounds.y + bounds.height * points[0][1]);
  await page.mouse.down();
  for (const [x, y] of points.slice(1)) {
    await page.mouse.move(bounds.x + bounds.width * x, bounds.y + bounds.height * y, { steps: 5 });
  }
  await page.mouse.up();
  assert.match(await page.locator("#drawing-status").textContent(), /grid points inside/);
  assert.equal(await page.locator("#drawing-apply").isEnabled(), true);
  await page.locator("#drawing-apply").click();
  await waitForShape(page, "custom");
  assert.equal(await page.locator("#membrane-stage").getAttribute("data-boundary-geometry"), "analytic");
  assert.ok(
    Number(await page.locator("#membrane-stage").getAttribute("data-boundary-segment-count")) > 20
  );
  const pointerGeometry = await readRenderGeometry(page.locator("#membrane-stage"));
  assertRenderGeometry(pointerGeometry, {
    label: "pointer-drawn custom shape",
    solverGridSize: 81,
    renderGridSize: 241,
    subdivisions: 3,
    minimumTriangles: 40_000,
    minimumActiveSamples: 1_800,
    expectedOutlineLoops: 1
  });
  console.log("Pointer custom geometry:", formatRenderGeometry(pointerGeometry));
  await page.screenshot({ path: new URL("browser-smoke-custom-pointer.png", artifactDir).pathname });

  const slider = page.locator("#mode-slider");
  await slider.fill("20");
  await setBoundaryCamera(page, "grazing");
  await resetPeakMode(page, slider, 20);
  await captureMembraneCanvas(page, "browser-smoke-custom-irregular-mode20-grazing");
  await slider.fill("1");
  await setBoundaryCamera(page, "oblique");

  await page.locator("#shape-menu-toggle").click();
  await page.locator("#draw-shape").click();
  await page.locator("#drawing-clear").click();

  await canvas.focus();
  assert.equal(await canvas.getAttribute("tabindex"), "0");
  await canvas.press("Space");
  await canvas.press("ArrowRight");
  await canvas.press("Escape");
  assert.equal(await page.locator("#drawing-overlay").isVisible(), true);
  assert.match(await page.locator("#drawing-status").textContent(), /Outline cleared/);

  await canvas.press("Space");
  await pressRepeated(canvas, "ArrowRight", 20);
  await canvas.press("Space");
  await pressRepeated(canvas, "ArrowDown", 20);
  await canvas.press("Space");
  await pressRepeated(canvas, "ArrowLeft", 20);
  await canvas.press("Enter");
  assert.match(await page.locator("#drawing-status").textContent(), /grid points inside/);
  assert.equal(await page.locator("#drawing-apply").isEnabled(), true);
  await page.locator("#drawing-apply").click();
  await waitForShape(page, "custom");
  assert.equal(await page.locator("#membrane-stage").getAttribute("data-boundary-geometry"), "analytic");
  assert.ok(
    Number(await page.locator("#membrane-stage").getAttribute("data-boundary-segment-count")) > 20
  );
  assert.match(await page.locator("#active-shape-name").textContent(), /Draw your own/);
  assert.ok(Number(await page.locator("#membrane-stage").getAttribute("data-solver-active-nodes")) > 900);
  const keyboardGeometry = await readRenderGeometry(page.locator("#membrane-stage"));
  assertRenderGeometry(keyboardGeometry, {
    label: "keyboard-drawn custom shape",
    solverGridSize: 81,
    renderGridSize: 241,
    subdivisions: 3,
    minimumTriangles: 15_000,
    minimumActiveSamples: 900,
    expectedOutlineLoops: 1
  });
  console.log("Keyboard custom geometry:", formatRenderGeometry(keyboardGeometry));
  await page.screenshot({ path: new URL("browser-smoke-custom-keyboard.png", artifactDir).pathname });
}

async function readRenderGeometry(stage) {
  return {
    solverWidth: Number(await stage.getAttribute("data-solver-grid-width")),
    solverHeight: Number(await stage.getAttribute("data-solver-grid-height")),
    renderWidth: Number(await stage.getAttribute("data-render-grid-width")),
    renderHeight: Number(await stage.getAttribute("data-render-grid-height")),
    subdivisions: Number(await stage.getAttribute("data-analytic-render-subdivisions")),
    surfacePositions: Number(await stage.getAttribute("data-surface-position-count")),
    surfaceTriangles: Number(await stage.getAttribute("data-surface-triangle-count")),
    outlinePositions: Number(await stage.getAttribute("data-outline-position-count")),
    outlineTriangles: Number(await stage.getAttribute("data-outline-triangle-count")),
    boundarySegments: Number(await stage.getAttribute("data-boundary-segment-count")),
    outlineLoops: Number(await stage.getAttribute("data-outline-loop-count")),
    miterJoins: Number(await stage.getAttribute("data-outline-miter-join-count")),
    bevelJoins: Number(await stage.getAttribute("data-outline-bevel-join-count")),
    outlineJoinStyle: await stage.getAttribute("data-outline-join-style"),
    activeSamples: Number(await stage.getAttribute("data-active-sample-count")),
    indexed: await stage.getAttribute("data-surface-indexed")
  };
}

function assertRenderGeometry(geometry, expected) {
  assert.equal(geometry.solverWidth, expected.solverGridSize, `${expected.label} solver width`);
  assert.equal(geometry.solverHeight, expected.solverGridSize, `${expected.label} solver height`);
  assert.equal(geometry.renderWidth, expected.renderGridSize, `${expected.label} render width`);
  assert.equal(geometry.renderHeight, expected.renderGridSize, `${expected.label} render height`);
  assert.equal(geometry.subdivisions, expected.subdivisions, `${expected.label} subdivisions`);
  assert.equal(geometry.indexed, "false", `${expected.label} surface should be non-indexed`);
  assert.equal(
    geometry.surfacePositions,
    geometry.surfaceTriangles * 3,
    `${expected.label} must expose three surface positions per triangle`
  );
  assert.equal(
    geometry.outlinePositions,
    geometry.outlineTriangles * 3,
    `${expected.label} must expose three outline positions per triangle`
  );
  assert.equal(
    geometry.outlineJoinStyle,
    "joined-ribbon",
    `${expected.label} must use a shared joined outline ribbon`
  );
  assert.equal(
    geometry.miterJoins + geometry.bevelJoins,
    geometry.boundarySegments,
    `${expected.label} must close every boundary-segment endpoint with one shared join`
  );
  assert.equal(
    geometry.outlineTriangles,
    geometry.boundarySegments * 8 + geometry.bevelJoins * 4,
    `${expected.label} joined-ribbon triangle count`
  );
  assert.equal(
    geometry.outlineLoops,
    expected.expectedOutlineLoops,
    `${expected.label} closed outline loop count`
  );
  assert.ok(
    geometry.surfaceTriangles >= expected.minimumTriangles,
    `${expected.label} has only ${geometry.surfaceTriangles} surface triangles`
  );
  if (expected.minimumActiveSamples !== undefined) {
    assert.ok(
      geometry.activeSamples >= expected.minimumActiveSamples,
      `${expected.label} has only ${geometry.activeSamples} active solver samples`
    );
  }
}

function formatRenderGeometry(geometry) {
  return (
    `${geometry.solverWidth}x${geometry.solverHeight} solver, ` +
    `${geometry.renderWidth}x${geometry.renderHeight} render, ` +
    `${geometry.surfaceTriangles} surface triangles, ${geometry.outlineTriangles} outline triangles, ` +
    `${geometry.boundarySegments} frame segments / ${geometry.miterJoins} miter + ` +
    `${geometry.bevelJoins} bevel joins in ${geometry.outlineLoops} loop(s), ` +
    `${geometry.activeSamples} active samples ` +
    `(${(100 * geometry.activeSamples / (geometry.solverWidth * geometry.solverHeight)).toFixed(1)}%)`
  );
}

async function pressRepeated(locator, key, count) {
  for (let index = 0; index < count; index += 1) await locator.press(key);
}

async function assertBoundaryFrameContinuity(page) {
  const cases = [
    { label: "custom", expectedFrameComponents: 1 },
    { label: "circle", accessibleName: "Circle", expectedFrameComponents: 1 },
    { label: "rectangle", accessibleName: "Rectangle", expectedFrameComponents: 1 },
    { label: "triangle", accessibleName: "Triangle", expectedFrameComponents: 1 },
    { label: "pentagon", accessibleName: "Pentagon", expectedFrameComponents: 1 },
    { label: "hexagon", accessibleName: "Hexagon", expectedFrameComponents: 1 },
    { label: "annulus", accessibleName: "Annulus", expectedFrameComponents: 2 },
    { label: "spiral", accessibleName: "Spiral", expectedFrameComponents: 1 }
  ];
  const continuityMetrics = [];
  for (const testCase of cases) {
    if (testCase.accessibleName) {
      await chooseShape(page, testCase.accessibleName, testCase.key ?? testCase.label);
    } else {
      assert.equal(await page.locator("#membrane-stage").getAttribute("data-shape"), "custom");
    }
    continuityMetrics.push(
      await auditFlatBoundaryContinuity(page, testCase.label, testCase.expectedFrameComponents)
    );
  }
  console.log(
    "Flat boundary components:",
    continuityMetrics
      .map(
        (metric) =>
          `${metric.label} ${metric.componentCount} ` +
          `(peaks ${(metric.positivePeak.worstComponentRetention * 100).toFixed(1)}%/` +
          `${(metric.negativePeak.worstComponentRetention * 100).toFixed(1)}%)`
      )
      .join(", ")
  );

  await chooseShape(page, "Rectangle", "rectangle");
  const obliqueOcclusion = await auditObliqueDepthOcclusion(page);
  assert.ok(
    obliqueOcclusion.retention >= 0.65,
    `Only ${(obliqueOcclusion.retention * 100).toFixed(2)}% of the fixed frame remains ` +
      "visible in the default oblique view"
  );
  assert.ok(
    obliqueOcclusion.retention <= 0.95,
    `${(obliqueOcclusion.retention * 100).toFixed(2)}% of the flat frame survives at ` +
      "peak displacement; nearer mode lobes should occlude the rear frame"
  );
  assert.ok(
    obliqueOcclusion.largestMissingFraction >= 0.025,
    "The default oblique peak has no substantial depth-occluded rear-frame segment"
  );
  console.log(
    "Default oblique frame depth:",
    `${(obliqueOcclusion.retention * 100).toFixed(1)}% visible, ` +
      `${(obliqueOcclusion.largestMissingFraction * 100).toFixed(1)}% largest occluded segment`
  );

  const silhouette = await auditGrazingSurfaceSilhouette(page);
  assert.ok(
    silhouette.maxExcursionPixels >= 20,
    `A peak membrane rises only ${silhouette.maxExcursionPixels}px beyond its flat frame`
  );
  assert.ok(
    silhouette.excursionRows >= 24,
    `A peak membrane occupies only ${silhouette.excursionRows} rows beyond its flat frame`
  );
  assert.ok(
    silhouette.excursionPixels >= 5_000,
    `Only ${silhouette.excursionPixels} displaced pixels are visible beyond the flat frame`
  );
  assert.ok(
    silhouette.abovePixels >= 500 && silhouette.belowPixels >= 500,
    "The grazing peak does not expose both positive and negative mode lobes"
  );
  console.log(
    "Grazing mode-20 silhouette:",
    `${silhouette.excursionPixels} pixels across ${silhouette.excursionRows} rows, ` +
      `${silhouette.maxExcursionPixels}px maximum excursion`
  );

  await page.locator("#mode-slider").fill("1");
  const stage = page.locator("#membrane-stage");
  await stage.focus();
  await stage.press("Home");
  await page.waitForTimeout(100);
}

async function auditFlatBoundaryContinuity(page, label, expectedFrameComponents) {
  const stage = page.locator("#membrane-stage");
  const slider = page.locator("#mode-slider");
  assert.equal(await stage.getAttribute("data-boundary-geometry"), "analytic");
  assert.equal(
    await stage.getAttribute("data-boundary-occlusion"),
    "depth-tested-exterior-frame"
  );
  assert.equal(await stage.getAttribute("data-boundary-pass-order"), "surface-outline");
  assert.equal(await stage.getAttribute("data-outline-join-style"), "joined-ribbon");
  const boundarySegments = Number(await stage.getAttribute("data-boundary-segment-count"));
  const miterJoins = Number(await stage.getAttribute("data-outline-miter-join-count"));
  const bevelJoins = Number(await stage.getAttribute("data-outline-bevel-join-count"));
  assert.equal(
    Number(await stage.getAttribute("data-outline-loop-count")),
    expectedFrameComponents,
    `${label} outline geometry has the wrong number of closed loops`
  );
  assert.equal(
    miterJoins + bevelJoins,
    boundarySegments,
    `${label} outline geometry has an open or duplicated join`
  );
  assert.equal(await stage.getAttribute("data-playing"), "false");

  await resetPeakMode(page, slider, 1);
  const flatPhase = await pauseAtFlatReference(page);
  assert.ok(
    Math.abs(Math.cos(flatPhase)) <= 0.12,
    `${label} flat reference stopped too far from the zero crossing: phase ${flatPhase}`
  );
  await setBoundaryCamera(page, "top-down");
  const topDownFlat = await captureMembraneCanvas(page, `${label}-top-down-flat`);
  const continuity = measureFlatOutlineContinuity(topDownFlat);
  const joins = measureOutlineJoinContinuity(topDownFlat);
  assert.equal(
    continuity.componentCount,
    expectedFrameComponents,
    `${label} flat frame is split into ${continuity.componentCount} visible components`
  );
  assert.ok(
    continuity.smallestComponentPixels >= 150,
    `${label} has an undersized ${continuity.smallestComponentPixels}px frame component`
  );
  assert.ok(
    joins.endpointCount <= expectedFrameComponents * 2,
    `${label} frame centreline has ${joins.endpointCount} open/spur endpoints`
  );

  await resetPeakMode(page, slider, 20);
  const topDownPositivePeak = await captureMembraneCanvas(
    page,
    `${label}-top-down-positive-peak`
  );
  const positivePeak = measureOutlineRetention(topDownFlat, topDownPositivePeak);
  const negativePeakPhase = await pauseAtPhase(page, Math.PI, 0.04);
  assert.ok(
    Math.abs(negativePeakPhase - Math.PI) <= 0.1,
    `${label} negative peak stopped too far from pi: phase ${negativePeakPhase}`
  );
  const topDownNegativePeak = await captureMembraneCanvas(
    page,
    `${label}-top-down-negative-peak`
  );
  const negativePeak = measureOutlineRetention(topDownFlat, topDownNegativePeak);
  for (const [peakLabel, retention] of [
    ["positive", positivePeak],
    ["negative", negativePeak]
  ]) {
    assert.ok(
      retention.worstComponentRetention >= 0.965,
      `${label} ${peakLabel} peak retained only ` +
        `${(retention.worstComponentRetention * 100).toFixed(2)}% of its top-down frame`
    );
    assert.ok(
      retention.largestMissingFraction <= 0.04,
      `${label} ${peakLabel} peak has a contiguous frame gap covering ` +
        `${(retention.largestMissingFraction * 100).toFixed(2)}% of a frame loop`
    );
  }
  return { label, ...continuity, positivePeak, negativePeak };
}

async function auditObliqueDepthOcclusion(page) {
  const stage = page.locator("#membrane-stage");
  const slider = page.locator("#mode-slider");
  await setBoundaryCamera(page, "oblique");
  await resetPeakMode(page, slider, 1);
  const flatPhase = await pauseAtFlatReference(page);
  assert.ok(
    Math.abs(Math.cos(flatPhase)) <= 0.12,
    `Oblique flat reference stopped too far from the zero crossing: phase ${flatPhase}`
  );
  const obliqueFlat = await captureMembraneCanvas(page, "rectangle-oblique-depth-flat");
  await resetPeakMode(page, slider, 20);
  const obliquePeak = await captureMembraneCanvas(page, "rectangle-oblique-depth-peak");
  return measureOutlineRetention(obliqueFlat, obliquePeak);
}

async function auditGrazingSurfaceSilhouette(page) {
  const stage = page.locator("#membrane-stage");
  const slider = page.locator("#mode-slider");
  await setBoundaryCamera(page, "grazing");
  await resetPeakMode(page, slider, 1);
  const flatPhase = await pauseAtFlatReference(page);
  assert.ok(
    Math.abs(Math.cos(flatPhase)) <= 0.12,
    `Grazing flat reference stopped too far from the zero crossing: phase ${flatPhase}`
  );
  const grazingFlat = await captureMembraneCanvas(page, "rectangle-grazing-flat");
  await resetPeakMode(page, slider, 20);
  const grazingPeak = await captureMembraneCanvas(page, "rectangle-grazing-peak");
  return measureSurfaceSilhouetteExcursion(grazingFlat, grazingPeak);
}

async function pauseAtFlatReference(page) {
  return pauseAtPhase(page, Math.PI / 2, 0.02);
}

async function pauseAtPhase(page, targetPhase, lead) {
  return page.evaluate(
    ({ targetPhase, lead }) =>
      new Promise((resolve, reject) => {
        const stage = document.querySelector("#membrane-stage");
        const toggle = document.querySelector("#animation-toggle");
        if (!(stage instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) {
          reject(new Error("The membrane stage or animation toggle is unavailable"));
          return;
        }

        const timeout = window.setTimeout(() => {
          observer.disconnect();
          reject(new Error("Timed out while staging a flat membrane reference"));
        }, 4_000);
        const stopAtTargetPhase = () => {
          const phase = Number(stage.getAttribute("data-phase"));
          if (phase < targetPhase - lead) return;
          toggle.click();
          observer.disconnect();
          window.clearTimeout(timeout);
          resolve(Number(stage.getAttribute("data-phase")));
        };
        const observer = new MutationObserver(stopAtTargetPhase);
        observer.observe(stage, { attributes: true, attributeFilter: ["data-phase"] });
        toggle.click();
        stopAtTargetPhase();
      }),
    { targetPhase, lead }
  );
}

async function resetPeakMode(page, slider, modeNumber) {
  const stage = page.locator("#membrane-stage");
  const previousFrame = Number(await stage.getAttribute("data-frame"));
  const adjacentMode = modeNumber === 1 ? 2 : modeNumber - 1;
  await slider.fill(String(adjacentMode));
  await slider.fill(String(modeNumber));
  await page.waitForFunction(
    ({ mode, frame }) => {
      const stage = document.querySelector("#membrane-stage");
      return (
        stage?.getAttribute("data-mode-number") === String(mode) &&
        stage.getAttribute("data-phase") === "0.000000" &&
        Number(stage.getAttribute("data-frame")) > frame
      );
    },
    { mode: modeNumber, frame: previousFrame }
  );
}

async function setBoundaryCamera(page, pose) {
  const stage = page.locator("#membrane-stage");
  await stage.focus();
  await stage.press("Home");
  if (pose === "top-down") await pressRepeated(stage, "ArrowUp", 16);
  if (pose === "grazing") {
    await pressRepeated(stage, "ArrowDown", 6);
    await pressRepeated(stage, "=", 3);
  }
  // OrbitControls applies keyboard rotations through damping. Dense analytic
  // meshes can render slowly enough that 400 ms does not finish the grazing
  // rotation, so leave enough time for the pose to settle before reading and
  // capturing it.
  await page.waitForTimeout(pose === "grazing" ? 1_200 : pose === "top-down" ? 400 : 100);
  const camera = (await stage.getAttribute("data-camera")).split(",").map(Number);
  const distance = Math.hypot(...camera);
  const verticalFraction = camera[1] / distance;
  if (pose === "top-down") {
    assert.ok(
      verticalFraction >= 0.999,
      `Top-down boundary continuity requires an exact overhead camera: ${camera.join(",")}`
    );
  } else if (pose === "oblique") {
    assert.ok(
      verticalFraction >= 0.35 && verticalFraction <= 0.65,
      `Default oblique camera left its expected range: ${camera.join(",")}`
    );
  } else if (pose === "grazing") {
    assert.ok(
      verticalFraction >= 0.035 && verticalFraction <= 0.06,
      `Grazing camera left its expected range: ${camera.join(",")}`
    );
  }
}

async function captureMembraneCanvas(page, artifactName) {
  const style = await page.addStyleTag({
    content:
      ".ui-chrome, .solver-loading, .renderer-fallback, .drawing-overlay { visibility: hidden !important; }"
  });
  try {
    const buffer = await page.locator('[data-membrane-canvas="true"]').screenshot({ type: "png" });
    await writeFile(new URL(`${artifactName}.png`, artifactDir), buffer);
    return buffer;
  } finally {
    await style.evaluate((element) => element.remove());
  }
}

async function assertPlaybackCameraAndCleanView(page) {
  const stage = page.locator("#membrane-stage");
  const toggle = page.locator("#animation-toggle");
  assert.equal(await stage.getAttribute("data-playing"), "false");
  await toggle.click();
  await page.waitForTimeout(150);
  assert.equal(await stage.getAttribute("data-playing"), "true");
  const phase = Number(await stage.getAttribute("data-phase"));
  assert.ok(phase > 0);
  await toggle.click();
  const frozen = Number(await stage.getAttribute("data-phase"));
  await page.waitForTimeout(120);
  assert.ok(Math.abs(Number(await stage.getAttribute("data-phase")) - frozen) < 1e-5);

  const initialCamera = await stage.getAttribute("data-camera");
  await stage.focus();
  await stage.press("ArrowLeft");
  await page.waitForTimeout(80);
  assert.notEqual(await stage.getAttribute("data-camera"), initialCamera);
  await page.locator("#reset-camera").click();
  await page.waitForTimeout(80);
  assert.equal(await stage.getAttribute("data-camera"), initialCamera);

  await page.locator("#ui-visibility-toggle").click();
  assert.equal(await page.locator("#app-shell").getAttribute("data-ui-hidden"), "true");
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".ui-chrome")].filter(
        (element) => getComputedStyle(element).visibility !== "hidden"
      ).length === 1,
    undefined,
    { timeout: 2_000 }
  );
  assert.equal(await page.locator(".ui-chrome:visible").count(), 1);
  await page.keyboard.press("h");
  assert.equal(await page.locator("#app-shell").getAttribute("data-ui-hidden"), "false");
}

async function assertMobileLayouts(browser, baseUrl) {
  // One touch-capable context covers all responsive viewports without repeating
  // the numerical shape suite. Resizing this page preserves its accepted
  // rectangle spectrum while still exercising the real mobile media features.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true
  });
  const page = await context.newPage();
  const errors = collectBrowserErrors(page);
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await waitForShape(page, "rectangle");

    for (const viewport of [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 430, height: 932 }
    ]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(120);
      await assertPortraitMobileLayout(page, `${viewport.width}x${viewport.height}`);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(120);
    await assertMobileMenuAndDrawer(page);
    await assertMobileCleanView(page);
    await page.screenshot({ path: new URL("browser-smoke-mobile.png", artifactDir).pathname });

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(120);
    await assertShortLandscapeLayout(page);
    await assertLandscapeDrawingBounds(page);
    await page.screenshot({ path: new URL("browser-smoke-mobile-landscape.png", artifactDir).pathname });

    assert.deepEqual(errors, [], `Mobile browser errors:\n${errors.join("\n")}`);
  } finally {
    await context.close();
  }
}

async function assertPortraitMobileLayout(page, label) {
  const layout = await readResponsiveGeometry(page);
  assert.equal(layout.scrollWidth, layout.viewportWidth, `${label} has horizontal overflow`);
  assert.ok(
    layout.scrollHeight <= layout.viewportHeight + 1,
    `${label} unexpectedly scrolls to ${layout.scrollHeight}px`
  );
  assert.ok(Math.abs(layout.stage.left) <= 1, `${label} stage is inset from the left`);
  assert.ok(
    Math.abs(layout.stage.width - layout.viewportWidth) <= 1,
    `${label} stage does not span the viewport`
  );
  assert.ok(
    Math.abs(layout.stage.bottom - layout.modeControl.top) <= 1,
    `${label} mode dock does not begin after the stage: ` +
      `${layout.stage.bottom}px vs ${layout.modeControl.top}px`
  );
  assertHorizontalModeSlider(layout, label);
  assertTopControlsDoNotOverlap(layout, label);
  assert.ok(
    layout.animationToggle.bottom <= layout.stage.bottom + 1,
    `${label} playback control extends into the mode dock`
  );
  assert.ok(layout.touchHintVisible, `${label} does not expose the touch camera hint`);
  assert.equal(layout.desktopHintVisible, false, `${label} still exposes the desktop camera hint`);
  assert.ok(layout.activeShapeName.width > 20, `${label} hides the active shape name`);
  await assertMinimumTouchTargets(
    page,
    ["#shape-menu-toggle", "#mode-slider", "#reset-camera", "#ui-visibility-toggle", "#animation-toggle"],
    label
  );
  assert.ok(
    Number(await page.locator("#membrane-stage").getAttribute("data-camera-vertical-fov")) > 34,
    `${label} does not use portrait camera framing`
  );
}

async function assertMobileMenuAndDrawer(page) {
  const stage = page.locator("#membrane-stage");
  const menuToggle = page.locator("#shape-menu-toggle");
  const menu = page.locator("#shape-menu");
  await ensurePlaying(page);

  await menuToggle.tap();
  await page.waitForFunction(() => document.activeElement?.matches('[role="option"]'));
  assert.equal(await stage.getAttribute("data-playing"), "false");
  assert.equal(await menuToggle.getAttribute("aria-expanded"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-shape")), "rectangle");
  assertBoundsInsideViewport(await elementBounds(menu), await pageViewport(page), "portrait shape menu");

  await page.locator("#shape-menu-close").tap();
  assert.equal(await menu.isHidden(), true);
  assert.equal(await stage.getAttribute("data-playing"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "shape-menu-toggle");

  await menuToggle.tap();
  await page.locator("#draw-shape").tap();
  await page.waitForFunction(() => document.activeElement?.id === "drawing-close");
  assert.equal(await page.locator("#drawing-overlay").isVisible(), true);
  assert.equal(await stage.getAttribute("data-playing"), "false");
  const drawing = await readDrawingGeometry(page);
  assertBoundsInsideViewport(drawing.dialog, drawing.viewport, "portrait drawing dialog");
  assertBoundsInsideViewport(drawing.canvas, drawing.viewport, "portrait drawing canvas");
  assertBoundsInsideViewport(drawing.actions, drawing.viewport, "portrait drawing actions");
  assert.ok(drawing.canvas.width >= 280, `Portrait drawing canvas is only ${drawing.canvas.width}px wide`);
  assert.ok(
    Math.abs(drawing.canvas.width - drawing.canvas.height) <= 1,
    "Portrait drawing canvas is not square"
  );
  assert.ok(
    drawing.viewport.height - drawing.actions.bottom <= 24,
    "Portrait drawing actions are not anchored near the safe-area bottom"
  );
  await assertMinimumTouchTargets(
    page,
    ["#drawing-close", "#drawing-clear", "#drawing-apply"],
    "portrait drawing dialog"
  );

  await page.locator("#drawing-close").tap();
  assert.equal(await page.locator("#drawing-overlay").isHidden(), true);
  assert.equal(await stage.getAttribute("data-playing"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "shape-menu-toggle");
}

async function assertMobileCleanView(page) {
  const uiToggle = page.locator("#ui-visibility-toggle");
  const stage = page.locator("#membrane-stage");
  await ensurePlaying(page);
  await page.locator("#shape-menu-toggle").tap();
  assert.equal(await stage.getAttribute("data-playing"), "false");
  await page.keyboard.press("h");
  await page.waitForFunction(
    () => document.querySelector("#app-shell")?.getAttribute("data-ui-hidden") === "true"
  );
  assert.equal(await page.locator("#shape-menu").isHidden(), true);
  assert.equal(await stage.getAttribute("data-playing"), "true");
  const hidden = await readResponsiveGeometry(page);
  assert.ok(
    Math.abs(hidden.stage.height - hidden.viewportHeight) <= 1,
    `Clean view stage is ${hidden.stage.height}px instead of ${hidden.viewportHeight}px high`
  );
  assert.equal(hidden.modeControlDisplay, "none");
  assert.ok(
    hidden.scrollHeight <= hidden.viewportHeight + 1,
    `Clean view still scrolls to ${hidden.scrollHeight}px`
  );

  await uiToggle.tap();
  await page.waitForFunction(
    () => document.querySelector("#app-shell")?.getAttribute("data-ui-hidden") === "false"
  );
  const restored = await readResponsiveGeometry(page);
  assert.ok(
    Math.abs(restored.stage.bottom - restored.modeControl.top) <= 1,
    "Restoring the interface did not return the mode dock below the stage"
  );
  assert.notEqual(restored.modeControlDisplay, "none");
}

async function assertShortLandscapeLayout(page) {
  const layout = await readResponsiveGeometry(page);
  assert.equal(layout.scrollWidth, layout.viewportWidth, "Short landscape has horizontal overflow");
  assert.ok(
    layout.scrollHeight <= layout.viewportHeight + 1,
    `Short landscape scrolls to ${layout.scrollHeight}px`
  );
  assert.ok(
    Math.abs(layout.stage.width - layout.viewportWidth) <= 1 &&
      Math.abs(layout.stage.height - layout.viewportHeight) <= 1,
    "Short-landscape stage does not fill the viewport"
  );
  assertHorizontalModeSlider(layout, "short landscape");
  assertTopControlsDoNotOverlap(layout, "short landscape");
  assertBoundsInsideViewport(layout.modeControl, layout, "short-landscape mode dock");
  assert.ok(
    layout.animationToggle.right + 8 <= layout.modeControl.left,
    "Short-landscape play button overlaps the mode dock"
  );
  await assertMinimumTouchTargets(
    page,
    ["#shape-menu-toggle", "#mode-slider", "#reset-camera", "#ui-visibility-toggle", "#animation-toggle"],
    "short landscape"
  );
}

async function assertLandscapeDrawingBounds(page) {
  const stage = page.locator("#membrane-stage");
  await ensurePlaying(page);
  await page.locator("#shape-menu-toggle").tap();
  assert.equal(await stage.getAttribute("data-playing"), "false");
  await page.locator("#draw-shape").tap();
  await page.waitForFunction(() => document.activeElement?.id === "drawing-close");
  assert.equal(await stage.getAttribute("data-playing"), "false");

  const drawing = await readDrawingGeometry(page);
  assert.equal(drawing.dialogScrollHeight, drawing.dialogClientHeight);
  assertBoundsInsideViewport(drawing.dialog, drawing.viewport, "landscape drawing dialog");
  assertBoundsInsideViewport(drawing.canvas, drawing.viewport, "landscape drawing canvas");
  assertBoundsInsideViewport(drawing.header, drawing.viewport, "landscape drawing header");
  assertBoundsInsideViewport(drawing.actions, drawing.viewport, "landscape drawing actions");
  assert.ok(drawing.canvas.width >= 300, `Landscape drawing canvas is only ${drawing.canvas.width}px wide`);
  assert.ok(
    Math.abs(drawing.canvas.width - drawing.canvas.height) <= 1,
    "Landscape drawing canvas is not square"
  );
  assert.ok(
    drawing.canvas.right + 8 <= drawing.header.left,
    "Landscape drawing canvas overlaps the instruction column"
  );
  await assertMinimumTouchTargets(
    page,
    ["#drawing-close", "#drawing-clear", "#drawing-apply"],
    "landscape drawing dialog"
  );

  await page.locator("#drawing-close").tap();
  assert.equal(await page.locator("#drawing-overlay").isHidden(), true);
  assert.equal(await stage.getAttribute("data-playing"), "true");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "shape-menu-toggle");
}

async function ensurePlaying(page) {
  const stage = page.locator("#membrane-stage");
  if ((await stage.getAttribute("data-playing")) !== "true") {
    await page.locator("#animation-toggle").tap();
  }
  assert.equal(await stage.getAttribute("data-playing"), "true");
}

async function assertMinimumTouchTargets(page, selectors, label) {
  for (const selector of selectors) {
    const target = page.locator(selector);
    const bounds = await elementBounds(target);
    assert.ok(bounds.width >= 44, `${label} ${selector} is only ${bounds.width}px wide`);
    assert.ok(bounds.height >= 44, `${label} ${selector} is only ${bounds.height}px high`);
  }
}

function assertHorizontalModeSlider(layout, label) {
  assert.ok(layout.slider.width >= 44, `${label} mode slider is narrower than 44px`);
  assert.ok(layout.slider.height >= 44, `${label} mode slider is shorter than 44px`);
  assert.ok(
    layout.slider.width >= layout.slider.height * 3,
    `${label} mode slider is not horizontal: ${layout.slider.width}x${layout.slider.height}`
  );
  assert.equal(layout.sliderWritingMode, "horizontal-tb");
  for (let index = 1; index < layout.majorMarkCenters.length; index += 1) {
    assert.ok(
      layout.majorMarkCenters[index] > layout.majorMarkCenters[index - 1],
      `${label} mode marks are not ordered horizontally from 1 to 20`
    );
  }
}

function assertTopControlsDoNotOverlap(layout, label) {
  assert.ok(layout.shapeToggle.left >= -1, `${label} shape control is outside the viewport`);
  assert.ok(
    layout.viewControls.right <= layout.viewportWidth + 1,
    `${label} view controls are outside the viewport`
  );
  assert.ok(
    layout.shapeToggle.right + 8 <= layout.viewControls.left,
    `${label} top controls overlap: ${layout.shapeToggle.right}px vs ${layout.viewControls.left}px`
  );
}

function assertBoundsInsideViewport(bounds, viewport, label) {
  assert.ok(bounds.left >= -1, `${label} extends left to ${bounds.left}px`);
  assert.ok(bounds.top >= -1, `${label} extends above the viewport to ${bounds.top}px`);
  assert.ok(bounds.right <= viewport.width + 1, `${label} extends right to ${bounds.right}px`);
  assert.ok(bounds.bottom <= viewport.height + 1, `${label} extends below to ${bounds.bottom}px`);
}

async function readResponsiveGeometry(page) {
  return page.evaluate(() => {
    const bounds = (selector) => {
      const rectangle = document.querySelector(selector)?.getBoundingClientRect();
      if (!rectangle) throw new Error(`Missing responsive element ${selector}`);
      return {
        left: rectangle.left,
        top: rectangle.top,
        right: rectangle.right,
        bottom: rectangle.bottom,
        width: rectangle.width,
        height: rectangle.height
      };
    };
    const isVisible = (selector) => {
      const element = document.querySelector(selector);
      return element instanceof HTMLElement && getComputedStyle(element).display !== "none";
    };
    const majorValues = [1, 5, 10, 15, 20];
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
      stage: bounds("#membrane-stage"),
      modeControl: bounds("#mode-control"),
      slider: bounds("#mode-slider"),
      shapeToggle: bounds("#shape-menu-toggle"),
      activeShapeName: bounds("#active-shape-name"),
      viewControls: bounds(".view-controls"),
      animationToggle: bounds("#animation-toggle"),
      modeControlDisplay: getComputedStyle(document.querySelector("#mode-control")).display,
      sliderWritingMode: getComputedStyle(document.querySelector("#mode-slider")).writingMode,
      majorMarkCenters: majorValues.map((value) => {
        const rectangle = document
          .querySelector(`[data-mode-mark="${value}"]`)
          ?.getBoundingClientRect();
        return (rectangle?.left ?? 0) + (rectangle?.width ?? 0) / 2;
      }),
      touchHintVisible: isVisible(".camera-hint__touch"),
      desktopHintVisible: isVisible(".camera-hint__desktop")
    };
  });
}

async function readDrawingGeometry(page) {
  return page.evaluate(() => {
    const bounds = (selector) => {
      const rectangle = document.querySelector(selector)?.getBoundingClientRect();
      if (!rectangle) throw new Error(`Missing drawing element ${selector}`);
      return {
        left: rectangle.left,
        top: rectangle.top,
        right: rectangle.right,
        bottom: rectangle.bottom,
        width: rectangle.width,
        height: rectangle.height
      };
    };
    const dialog = document.querySelector(".drawing-dialog");
    if (!(dialog instanceof HTMLElement)) throw new Error("Missing drawing dialog");
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dialog: bounds(".drawing-dialog"),
      canvas: bounds(".drawing-canvas-wrap"),
      header: bounds(".drawing-header"),
      actions: bounds(".drawing-actions"),
      dialogScrollHeight: dialog.scrollHeight,
      dialogClientHeight: dialog.clientHeight
    };
  });
}

async function elementBounds(locator) {
  return locator.evaluate((element) => {
    const rectangle = element.getBoundingClientRect();
    return {
      left: rectangle.left,
      top: rectangle.top,
      right: rectangle.right,
      bottom: rectangle.bottom,
      width: rectangle.width,
      height: rectangle.height
    };
  });
}

async function pageViewport(page) {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

async function assertReducedMotion(browser, baseUrl) {
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 960, height: 720 } });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await waitForShape(page, "rectangle");
  assert.equal(await page.locator("#membrane-stage").getAttribute("data-playing"), "false");
  assert.equal(await page.locator("#animation-toggle").getAttribute("aria-pressed"), "false");
  await context.close();
}

async function chooseShape(page, accessibleName, key) {
  await page.locator("#shape-menu-toggle").click();
  await page.getByRole("option", { name: accessibleName }).click();
  await waitForShape(page, key);
  assert.equal(await page.locator("#shape-menu").isHidden(), true);
}

async function waitForShape(page, key) {
  await page.waitForFunction(
    (shape) => {
      const stage = document.querySelector("#membrane-stage");
      return (
        stage?.getAttribute("data-shape") === shape &&
        stage.getAttribute("data-membrane-status") === "ready" &&
        document.querySelector("#app-shell")?.getAttribute("data-solving") === "false"
      );
    },
    key,
    { timeout: 20_000 }
  );
}

async function waitForSettledSolve(page, key) {
  await page.waitForFunction(
    (shape) =>
      document.querySelector("#membrane-stage")?.getAttribute("data-shape") === shape &&
      document.querySelector("#app-shell")?.getAttribute("data-solving") === "false",
    key,
    { timeout: 20_000 }
  );
  await page.waitForTimeout(250);
}

async function measurePhaseAdvance(page, durationMs) {
  const stage = page.locator("#membrane-stage");
  const toggle = page.locator("#animation-toggle");
  assert.equal(await stage.getAttribute("data-playing"), "false");
  const initial = Number(await stage.getAttribute("data-phase"));
  await toggle.click();
  await page.waitForTimeout(durationMs);
  await toggle.click();
  const final = Number(await stage.getAttribute("data-phase"));
  return (final - initial + 2 * Math.PI) % (2 * Math.PI);
}

function collectBrowserErrors(page) {
  const messages = [];
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      messages.push(`${message.type()}: ${message.text()}`);
    }
  });
  return messages;
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Preview exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000))
  ]);
}

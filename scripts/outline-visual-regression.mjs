import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode the non-interlaced 8-bit RGB/RGBA PNGs emitted by Playwright. */
export function decodePlaywrightPng(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("Expected a PNG Buffer");
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (buffer[index] !== PNG_SIGNATURE[index]) throw new Error("Invalid PNG signature");
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const compressedParts = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("Truncated PNG chunk");
    if (type === "IHDR") {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8] ?? 0;
      colorType = buffer[dataStart + 9] ?? -1;
      interlace = buffer[dataStart + 12] ?? -1;
    } else if (type === "IDAT") {
      compressedParts.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width < 1 || height < 1 || bitDepth !== 8 || interlace !== 0) {
    throw new Error(
      `Unsupported Playwright PNG format: ${width}x${height}, depth ${bitDepth}, interlace ${interlace}`,
    );
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (channels === 0) throw new Error(`Unsupported Playwright PNG color type ${colorType}`);

  const packed = inflateSync(Buffer.concat(compressedParts));
  const stride = width * channels;
  if (packed.length !== (stride + 1) * height) {
    throw new Error("Unexpected decompressed PNG size");
  }
  const scanlines = new Uint8Array(stride * height);
  for (let row = 0; row < height; row += 1) {
    const packedStart = row * (stride + 1);
    const filter = packed[packedStart] ?? -1;
    for (let columnByte = 0; columnByte < stride; columnByte += 1) {
      const raw = packed[packedStart + columnByte + 1] ?? 0;
      const outputIndex = row * stride + columnByte;
      const left = columnByte >= channels ? scanlines[outputIndex - channels] ?? 0 : 0;
      const up = row > 0 ? scanlines[outputIndex - stride] ?? 0 : 0;
      const upperLeft =
        row > 0 && columnByte >= channels
          ? scanlines[outputIndex - stride - channels] ?? 0
          : 0;
      let reconstructed;
      switch (filter) {
        case 0:
          reconstructed = raw;
          break;
        case 1:
          reconstructed = raw + left;
          break;
        case 2:
          reconstructed = raw + up;
          break;
        case 3:
          reconstructed = raw + Math.floor((left + up) / 2);
          break;
        case 4:
          reconstructed = raw + paethPredictor(left, up, upperLeft);
          break;
        default:
          throw new Error(`Unsupported PNG row filter ${filter}`);
      }
      scanlines[outputIndex] = reconstructed & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    rgba[target] = scanlines[source] ?? 0;
    rgba[target + 1] = scanlines[source + 1] ?? 0;
    rgba[target + 2] = scanlines[source + 2] ?? 0;
    rgba[target + 3] = channels === 4 ? scanlines[source + 3] ?? 255 : 255;
  }
  return { width, height, rgba };
}

/**
 * Compare fixed-frame pixels in a flat reference with a displaced capture at
 * the same camera. At an exact overhead view the depth-tested fixed edge
 * remains uninterrupted; at oblique views, missing frame segments quantify
 * the physically correct occlusion by nearer displaced lobes.
 */
export function measureOutlineRetention(referencePng, displacedPng, options = {}) {
  const reference = decodePlaywrightPng(referencePng);
  const displaced = decodePlaywrightPng(displacedPng);
  if (reference.width !== displaced.width || reference.height !== displaced.height) {
    throw new Error("Boundary-regression screenshots must have identical dimensions");
  }

  const searchRadius = options.searchRadius ?? 2;
  const referenceMask = createOutlineMask(reference);
  const displacedMask = createOutlineMask(displaced);
  const components = centralOutlineComponents(reference, options.minimumComponentPixels ?? 36);
  const componentMetrics = components.map((component) => {
    const retained = new Uint8Array(referenceMask.length);
    let retainedPixels = 0;
    for (const index of component) {
      if (hasMarkedNeighbor(displacedMask, reference.width, reference.height, index, searchRadius)) {
        retained[index] = 1;
        retainedPixels += 1;
      }
    }
    const missing = new Set(component.filter((index) => retained[index] === 0));
    const largestMissingCluster = largestSubsetComponent(missing, reference.width, reference.height);
    return {
      referencePixels: component.length,
      retainedPixels,
      retention: retainedPixels / component.length,
      largestMissingCluster,
      largestMissingFraction: largestMissingCluster / component.length,
    };
  });

  const referencePixels = componentMetrics.reduce((sum, metric) => sum + metric.referencePixels, 0);
  const retainedPixels = componentMetrics.reduce((sum, metric) => sum + metric.retainedPixels, 0);
  return {
    width: reference.width,
    height: reference.height,
    componentCount: componentMetrics.length,
    referencePixels,
    retainedPixels,
    retention: retainedPixels / referencePixels,
    worstComponentRetention: Math.min(...componentMetrics.map((metric) => metric.retention)),
    largestMissingFraction: Math.max(
      ...componentMetrics.map((metric) => metric.largestMissingFraction),
    ),
    components: componentMetrics,
  };
}

/**
 * Measure the part of a displaced membrane that becomes visible beyond the
 * projected fixed frame at a grazing camera angle. Comparing identical pixels
 * in the flat and peak captures rejects the page vignette and other static
 * background detail without assuming one particular Berlin-map colour.
 */
export function measureSurfaceSilhouetteExcursion(flatPng, peakPng, options = {}) {
  const flat = decodePlaywrightPng(flatPng);
  const peak = decodePlaywrightPng(peakPng);
  if (flat.width !== peak.width || flat.height !== peak.height) {
    throw new Error("Silhouette-regression screenshots must have identical dimensions");
  }

  const components = centralOutlineComponents(flat, options.minimumComponentPixels ?? 36);
  const frameBounds = boundsForIndices(components.flat(), flat.width);
  const frameMarginPixels = options.frameMarginPixels ?? 3;
  const minimumColorDifference = options.minimumColorDifference ?? 12;
  const changedRows = new Set();
  let excursionPixels = 0;
  let abovePixels = 0;
  let belowPixels = 0;
  let maxExcursionPixels = 0;

  for (let y = 0; y < peak.height; y += 1) {
    const aboveFrame = y < frameBounds.minimumY - frameMarginPixels;
    const belowFrame = y > frameBounds.maximumY + frameMarginPixels;
    if (!aboveFrame && !belowFrame) continue;
    for (let x = frameBounds.minimumX; x <= frameBounds.maximumX; x += 1) {
      const pixel = y * peak.width + x;
      if (isOutlinePixel(peak, pixel)) continue;
      if (pixelColorDifference(flat, peak, pixel) < minimumColorDifference) continue;

      excursionPixels += 1;
      changedRows.add(y);
      if (aboveFrame) {
        abovePixels += 1;
        maxExcursionPixels = Math.max(maxExcursionPixels, frameBounds.minimumY - y);
      } else {
        belowPixels += 1;
        maxExcursionPixels = Math.max(maxExcursionPixels, y - frameBounds.maximumY);
      }
    }
  }

  return {
    width: flat.width,
    height: flat.height,
    frameBounds,
    excursionPixels,
    excursionRows: changedRows.size,
    maxExcursionPixels,
    abovePixels,
    belowPixels,
  };
}

/** Report connected fixed-frame components in a top-down flat capture. */
export function measureFlatOutlineContinuity(png, options = {}) {
  const image = decodePlaywrightPng(png);
  const components = centralOutlineComponents(image, options.minimumComponentPixels ?? 36);
  const componentMetrics = components.map((component) => ({
    pixels: component.length,
    bounds: boundsForIndices(component, image.width),
  }));
  return {
    width: image.width,
    height: image.height,
    componentCount: components.length,
    totalPixels: componentMetrics.reduce((sum, component) => sum + component.pixels, 0),
    smallestComponentPixels: Math.min(...componentMetrics.map((component) => component.pixels)),
    components: componentMetrics,
  };
}

/**
 * Audit a closed fixed frame after reducing its pale pixel ribbon to a
 * one-pixel centreline. Open caps/notches leave degree-one endpoints even
 * when antialiasing makes the wider frame look loosely connected. Raster
 * thinning can leave one or two residual endpoints at a tight valid corner,
 * so this intentionally reports rather than enforces a threshold; callers
 * should calibrate the final tolerance against all supported shapes.
 */
export function measureOutlineJoinContinuity(png, options = {}) {
  const image = decodePlaywrightPng(png);
  const components = centralOutlineComponents(image, options.minimumComponentPixels ?? 36);
  const componentMetrics = components.map((component) => {
    const bounds = boundsForIndices(component, image.width);
    const padding = 3;
    const width = bounds.maximumX - bounds.minimumX + 1 + padding * 2;
    const height = bounds.maximumY - bounds.minimumY + 1 + padding * 2;
    const mask = new Uint8Array(width * height);
    for (const pixel of component) {
      const sourceX = pixel % image.width;
      const sourceY = Math.floor(pixel / image.width);
      const x = sourceX - bounds.minimumX + padding;
      const y = sourceY - bounds.minimumY + padding;
      mask[y * width + x] = 1;
    }
    thinBinaryMask(mask, width, height);
    let skeletonPixels = 0;
    let endpointCount = 0;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const pixel = y * width + x;
        if (mask[pixel] === 0) continue;
        skeletonPixels += 1;
        if (countMarkedNeighbors(mask, width, pixel) === 1) endpointCount += 1;
      }
    }
    return { pixels: component.length, skeletonPixels, endpointCount, bounds };
  });
  return {
    width: image.width,
    height: image.height,
    componentCount: componentMetrics.length,
    endpointCount: componentMetrics.reduce((sum, component) => sum + component.endpointCount, 0),
    components: componentMetrics,
  };
}

function createOutlineMask(image) {
  const mask = new Uint8Array(image.width * image.height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 4;
    const red = image.rgba[offset] ?? 0;
    const green = image.rgba[offset + 1] ?? 0;
    const blue = image.rgba[offset + 2] ?? 0;
    const alpha = image.rgba[offset + 3] ?? 0;
    if (
      alpha >= 220 &&
      red >= 182 &&
      green >= 194 &&
      blue >= 208 &&
      green >= red - 2 &&
      blue >= green
    ) {
      mask[pixel] = 1;
    }
  }
  return mask;
}

function centralOutlineComponents(image, minimumComponentPixels) {
  const outlineMask = createOutlineMask(image);
  const components = connectedComponents(outlineMask, image.width, image.height)
    .filter((component) => component.length >= minimumComponentPixels)
    .filter((component) => componentIntersectsCentralRegion(component, image.width, image.height));
  if (components.length === 0) {
    throw new Error("No central fixed-frame component was detected in the flat reference");
  }
  return components;
}

function boundsForIndices(indices, width) {
  let minimumX = width;
  let minimumY = Number.POSITIVE_INFINITY;
  let maximumX = -1;
  let maximumY = -1;
  for (const index of indices) {
    const x = index % width;
    const y = Math.floor(index / width);
    minimumX = Math.min(minimumX, x);
    minimumY = Math.min(minimumY, y);
    maximumX = Math.max(maximumX, x);
    maximumY = Math.max(maximumY, y);
  }
  return { minimumX, minimumY, maximumX, maximumY };
}

function isOutlinePixel(image, pixel) {
  const offset = pixel * 4;
  const red = image.rgba[offset] ?? 0;
  const green = image.rgba[offset + 1] ?? 0;
  const blue = image.rgba[offset + 2] ?? 0;
  const alpha = image.rgba[offset + 3] ?? 0;
  return (
    alpha >= 220 &&
    red >= 182 &&
    green >= 194 &&
    blue >= 208 &&
    green >= red - 2 &&
    blue >= green
  );
}

function pixelColorDifference(first, second, pixel) {
  const offset = pixel * 4;
  return Math.max(
    Math.abs((first.rgba[offset] ?? 0) - (second.rgba[offset] ?? 0)),
    Math.abs((first.rgba[offset + 1] ?? 0) - (second.rgba[offset + 1] ?? 0)),
    Math.abs((first.rgba[offset + 2] ?? 0) - (second.rgba[offset + 2] ?? 0)),
  );
}

function connectedComponents(mask, width, height) {
  const visited = new Uint8Array(mask.length);
  const components = [];
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (mask[seed] === 0 || visited[seed] !== 0) continue;
    const queue = [seed];
    const component = [];
    visited[seed] = 1;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      component.push(index);
      forEachNeighbor(index, width, height, (neighbor) => {
        if (mask[neighbor] !== 0 && visited[neighbor] === 0) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      });
    }
    components.push(component);
  }
  return components;
}

function componentIntersectsCentralRegion(component, width, height) {
  const minimumX = width * 0.1;
  const maximumX = width * 0.9;
  const minimumY = height * 0.08;
  const maximumY = height * 0.92;
  return component.some((index) => {
    const x = index % width;
    const y = Math.floor(index / width);
    return x >= minimumX && x <= maximumX && y >= minimumY && y <= maximumY;
  });
}

function hasMarkedNeighbor(mask, width, height, index, radius) {
  const centerX = index % width;
  const centerY = Math.floor(index / width);
  for (let y = Math.max(0, centerY - radius); y <= Math.min(height - 1, centerY + radius); y += 1) {
    for (let x = Math.max(0, centerX - radius); x <= Math.min(width - 1, centerX + radius); x += 1) {
      if (mask[y * width + x] !== 0) return true;
    }
  }
  return false;
}

function largestSubsetComponent(indices, width, height) {
  let largest = 0;
  while (indices.size > 0) {
    const seed = indices.values().next().value;
    indices.delete(seed);
    const queue = [seed];
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      forEachNeighbor(queue[cursor], width, height, (neighbor) => {
        if (indices.delete(neighbor)) queue.push(neighbor);
      });
    }
    largest = Math.max(largest, queue.length);
  }
  return largest;
}

function forEachNeighbor(index, width, height, callback) {
  const x = index % width;
  const y = Math.floor(index / width);
  for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
    for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
      if (deltaX === 0 && deltaY === 0) continue;
      const nextX = x + deltaX;
      const nextY = y + deltaY;
      if (nextX >= 0 && nextX < width && nextY >= 0 && nextY < height) {
        callback(nextY * width + nextX);
      }
    }
  }
}

function thinBinaryMask(mask, width, height) {
  let changed = true;
  while (changed) {
    changed = false;
    for (const secondPass of [false, true]) {
      const removals = [];
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const pixel = y * width + x;
          if (mask[pixel] === 0) continue;
          const neighbors = orderedNeighbors(mask, width, pixel);
          const count = neighbors.reduce((sum, value) => sum + value, 0);
          if (count < 2 || count > 6 || zeroToOneTransitions(neighbors) !== 1) continue;
          const [north, northEast, east, southEast, south, southWest, west] = neighbors;
          if (
            (!secondPass && (north * east * south !== 0 || east * south * west !== 0)) ||
            (secondPass && (north * east * west !== 0 || north * south * west !== 0))
          ) {
            continue;
          }
          // Keep the unused south-west destructure explicit: the ordered
          // neighborhood matches the standard Zhang-Suen notation.
          void northEast;
          void southEast;
          void southWest;
          removals.push(pixel);
        }
      }
      if (removals.length > 0) {
        changed = true;
        for (const pixel of removals) mask[pixel] = 0;
      }
    }
  }
}

function orderedNeighbors(mask, width, pixel) {
  return [
    mask[pixel - width] ?? 0,
    mask[pixel - width + 1] ?? 0,
    mask[pixel + 1] ?? 0,
    mask[pixel + width + 1] ?? 0,
    mask[pixel + width] ?? 0,
    mask[pixel + width - 1] ?? 0,
    mask[pixel - 1] ?? 0,
    mask[pixel - width - 1] ?? 0,
  ];
}

function zeroToOneTransitions(neighbors) {
  let transitions = 0;
  for (let index = 0; index < neighbors.length; index += 1) {
    if (neighbors[index] === 0 && neighbors[(index + 1) % neighbors.length] !== 0) {
      transitions += 1;
    }
  }
  return transitions;
}

function countMarkedNeighbors(mask, width, pixel) {
  return orderedNeighbors(mask, width, pixel).reduce((sum, value) => sum + value, 0);
}

function paethPredictor(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const diagonalDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upperLeft;
}

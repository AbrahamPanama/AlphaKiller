const SQRT_TWO = Math.SQRT2;
const INF_DISTANCE = 1e20;
const CANCEL_CHECK_ROWS = 16;

export const DEFAULT_SMART_EDGE_OPTIONS = Object.freeze({
  alpha: Object.freeze({
    lowAlpha: 5,
    highAlpha: 250,
    radius: 5,
    iterations: 2,
    strength: 0.72,
    lumaSigma: 0.09,
    detailProtection: 0.88,
    thinFeatureWidth: 6,
    thicknessProbeRadius: 10,
    foregroundThreshold: 128,
    suppressBroadResiduals: true,
    residualAlphaMax: 96,
    edgeSupportDistance: 2,
    residualSuppression: 1
  }),
  rim: Object.freeze({
    enabled: true,
    sourceAlpha: 180,
    targetAlphaMax: 254,
    maxDistance: 10,
    directionWeight: 2.25,
    colorTolerance: 58,
    colorWeight: 1.4,
    targetColorWeight: 0.2,
    distancePower: 1.35,
    blend: 1,
    includeTransparent: true
  })
});

export class SmartEdgeCancelledError extends Error {
  constructor(message = "Smart edge processing was cancelled") {
    super(message);
    this.name = "SmartEdgeCancelledError";
    this.code = "SMART_EDGE_CANCELLED";
  }
}

/**
 * Optional runtime adapter contract:
 * {
 *   guidedFilter({ guideRgba, source, width, height, radius, epsilon,
 *                  isCancelled }): Float32Array | Uint8Array,
 *   distanceTransformLabels({ seedMask, width, height, includeLabels,
 *                             isCancelled }): { distance, labels? }
 * }
 *
 * distanceTransformLabels must normalize OpenCV DIST_LABEL_PIXEL output so
 * every label is a zero-based pixel index into seedMask (or -1 when absent).
 * Adapter methods must be synchronous. Failures use the pure-JS fallback unless
 * runtime.adapterFailure is "throw".
 */

export function validateSmartEdgeImageData(imageData) {
  if (!imageData || typeof imageData !== "object") {
    throw new TypeError("Expected an ImageData-like object");
  }

  const width = Number(imageData.width);
  const height = Number(imageData.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("Image dimensions must be positive integers");
  }

  if (!ArrayBuffer.isView(imageData.data) || imageData.data.BYTES_PER_ELEMENT !== 1) {
    throw new TypeError("Image data must be an 8-bit typed array");
  }

  const requiredLength = width * height * 4;
  if (!Number.isSafeInteger(requiredLength) || imageData.data.length < requiredLength) {
    throw new RangeError("Image data is smaller than its declared dimensions");
  }

  return { width, height, pixelCount: width * height };
}

export function buildUncertainAlphaBand(imageData, options = {}, runtime = {}) {
  const { pixelCount } = validateSmartEdgeImageData(imageData);
  const lowAlpha = byteOption(options.lowAlpha, DEFAULT_SMART_EDGE_OPTIONS.alpha.lowAlpha);
  const highAlpha = byteOption(options.highAlpha, DEFAULT_SMART_EDGE_OPTIONS.alpha.highAlpha);
  if (lowAlpha >= highAlpha) {
    throw new RangeError("lowAlpha must be smaller than highAlpha");
  }

  const band = new Uint8Array(pixelCount);
  for (let pixel = 0, index = 3; pixel < pixelCount; pixel += 1, index += 4) {
    if ((pixel & 65535) === 0) throwIfCancelled(runtime);
    const alpha = imageData.data[index];
    band[pixel] = alpha > lowAlpha && alpha < highAlpha ? 1 : 0;
  }
  return band;
}

export function distanceTransformWithLabelsFallback(
  seedMask,
  width,
  height,
  options = {},
  runtime = {}
) {
  validateMask(seedMask, width, height, "seed mask");
  const includeLabels = options.includeLabels !== false;
  const pixelCount = width * height;
  const distance = new Float32Array(pixelCount);
  const labels = includeLabels ? new Int32Array(pixelCount) : null;

  for (let i = 0; i < pixelCount; i += 1) {
    if (seedMask[i]) {
      distance[i] = 0;
      if (labels) labels[i] = i;
    } else {
      distance[i] = INF_DISTANCE;
      if (labels) labels[i] = -1;
    }
  }

  for (let y = 0; y < height; y += 1) {
    checkRowCancellation(runtime, y);
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      if (x > 0) updateDistance(distance, labels, index, index - 1, 1);
      if (y > 0) {
        updateDistance(distance, labels, index, index - width, 1);
        if (x > 0) updateDistance(distance, labels, index, index - width - 1, SQRT_TWO);
        if (x + 1 < width) updateDistance(distance, labels, index, index - width + 1, SQRT_TWO);
      }
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    checkRowCancellation(runtime, y);
    const row = y * width;
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = row + x;
      if (x + 1 < width) updateDistance(distance, labels, index, index + 1, 1);
      if (y + 1 < height) {
        updateDistance(distance, labels, index, index + width, 1);
        if (x > 0) updateDistance(distance, labels, index, index + width - 1, SQRT_TWO);
        if (x + 1 < width) updateDistance(distance, labels, index, index + width + 1, SQRT_TWO);
      }
    }
  }

  return labels ? { distance, labels } : { distance };
}

export function guidedAlphaFilterFallback(imageData, options = {}, runtime = {}) {
  const { width, height, pixelCount } = validateSmartEdgeImageData(imageData);
  const radius = integerOption(options.radius, DEFAULT_SMART_EDGE_OPTIONS.alpha.radius, 1, 64);
  const iterations = integerOption(
    options.iterations,
    DEFAULT_SMART_EDGE_OPTIONS.alpha.iterations,
    1,
    4
  );
  const lumaSigma = numberOption(
    options.lumaSigma,
    DEFAULT_SMART_EDGE_OPTIONS.alpha.lumaSigma,
    0.005,
    1
  );
  const source = options.source
    ? normalizeAlphaSource(options.source, pixelCount)
    : alphaToFloat(imageData.data, pixelCount);
  const filtered = new Float32Array(source);
  const luma = buildLuma(imageData.data, pixelCount);
  const spatialSigma = Math.max(0.75, radius * 0.62);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    throwIfCancelled(runtime);
    const iterationScale = Math.sqrt(3) * Math.pow(2, iterations - iteration - 1)
      / Math.sqrt(Math.pow(4, iterations) - 1);
    const sigma = Math.max(0.5, spatialSigma * iterationScale);
    recursiveHorizontal(filtered, imageData.data, luma, width, height, sigma, lumaSigma, runtime);
    recursiveVertical(filtered, imageData.data, luma, width, height, sigma, lumaSigma, runtime);
    reportProgress(runtime, "guided-filter", (iteration + 1) / iterations);
  }

  return filtered;
}

export function computeLocalFeatureThickness(alphaSource, width, height, options = {}, runtime = {}) {
  const pixelCount = validateMask(alphaSource, width, height, "alpha source");
  const threshold = byteOption(
    options.foregroundThreshold,
    DEFAULT_SMART_EDGE_OPTIONS.alpha.foregroundThreshold
  );
  const probeRadius = integerOption(
    options.thicknessProbeRadius,
    DEFAULT_SMART_EDGE_OPTIONS.alpha.thicknessProbeRadius,
    1,
    64
  );
  const foreground = new Uint8Array(pixelCount);
  const backgroundSeeds = new Uint8Array(pixelCount);
  let foregroundCount = 0;

  for (let i = 0; i < pixelCount; i += 1) {
    const value = alphaValueAt(alphaSource, i, pixelCount);
    const inside = value >= threshold;
    foreground[i] = inside ? 1 : 0;
    backgroundSeeds[i] = inside ? 0 : 1;
    if (inside) foregroundCount += 1;
  }

  if (foregroundCount === 0) return new Float32Array(pixelCount);

  let insideDistance;
  if (!backgroundSeeds.some(Boolean)) {
    insideDistance = distanceToImageBoundary(width, height);
  } else {
    insideDistance = runDistanceTransform(
      backgroundSeeds,
      width,
      height,
      false,
      runtime
    ).distance;
  }

  for (let i = 0; i < pixelCount; i += 1) {
    if (!foreground[i]) insideDistance[i] = 0;
  }

  const localRadius = geodesicMaxFilter(
    insideDistance,
    foreground,
    width,
    height,
    probeRadius,
    runtime
  );
  const nearestForeground = foregroundCount === pixelCount
    ? null
    : runDistanceTransform(foreground, width, height, true, runtime);
  const thickness = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i += 1) {
    const source = foreground[i] ? i : nearestForeground?.labels?.[i] ?? -1;
    thickness[i] = source >= 0
      ? Math.min(2 * localRadius[source], probeRadius * 2)
      : 0;
  }
  return thickness;
}

function computeVisibleSupportThickness(alphaSource, width, height, options, runtime) {
  const pixelCount = validateMask(alphaSource, width, height, "alpha source");
  const supportThreshold = byteOption(options.lowAlpha, DEFAULT_SMART_EDGE_OPTIONS.alpha.lowAlpha) + 1;
  const support = new Uint8Array(pixelCount);
  const backgroundSeeds = new Uint8Array(pixelCount);
  let supportCount = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const visible = alphaValueAt(alphaSource, pixel, pixelCount) >= supportThreshold;
    support[pixel] = visible ? 1 : 0;
    backgroundSeeds[pixel] = visible ? 0 : 1;
    if (visible) supportCount += 1;
  }

  if (supportCount === 0) return new Float32Array(pixelCount);
  const interiorDistance = supportCount === pixelCount
    ? distanceToImageBoundary(width, height)
    : runDistanceTransform(backgroundSeeds, width, height, false, runtime).distance;
  const spreadRadius = Math.max(
    1,
    Math.min(8, Math.round(options.thinFeatureWidth * 0.55))
  );
  const localRadius = geodesicMaxFilter(
    interiorDistance,
    support,
    width,
    height,
    spreadRadius,
    runtime
  );
  const thickness = new Float32Array(pixelCount);

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (support[pixel]) thickness[pixel] = localRadius[pixel] * 2;
  }
  return thickness;
}

function computeDistanceToStrongForeground(alphaSource, width, height, options, runtime) {
  const pixelCount = validateMask(alphaSource, width, height, "alpha source");
  const foreground = new Uint8Array(pixelCount);
  let foregroundCount = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (alphaValueAt(alphaSource, pixel, pixelCount) >= options.foregroundThreshold) {
      foreground[pixel] = 1;
      foregroundCount += 1;
    }
  }

  if (foregroundCount === 0) return null;
  return runDistanceTransform(foreground, width, height, false, runtime).distance;
}

export function refineUncertainAlpha(imageData, options = {}, runtime = {}) {
  const { width, height, pixelCount } = validateSmartEdgeImageData(imageData);
  const normalized = normalizeAlphaOptions(options);
  const output = copyImageData(imageData);
  const sourceAlpha = alphaBytes(imageData.data, pixelCount);
  const band = buildUncertainAlphaBand(imageData, normalized, runtime);
  const thickness = options.thicknessMap
    ? validateFloatMap(options.thicknessMap, pixelCount, "thickness map")
    : computeLocalFeatureThickness(sourceAlpha, width, height, normalized, runtime);
  const visibleThickness = normalized.suppressBroadResiduals
    ? computeVisibleSupportThickness(sourceAlpha, width, height, normalized, runtime)
    : null;
  const strongForegroundDistance = normalized.suppressBroadResiduals
    ? computeDistanceToStrongForeground(sourceAlpha, width, height, normalized, runtime)
    : null;
  const filtered = runGuidedFilter(imageData, sourceAlpha, normalized, runtime);
  const suppressionStrength = smoothstep(0, 1, normalized.residualSuppression);
  const broadStart = normalized.thinFeatureWidth * 0.75;
  const broadEnd = normalized.thinFeatureWidth * 1.5;
  const supportFadeEnd = normalized.edgeSupportDistance + Math.max(1.5, normalized.radius * 0.5);

  for (let pixel = 0, index = 3; pixel < pixelCount; pixel += 1, index += 4) {
    if ((pixel & 65535) === 0) throwIfCancelled(runtime);
    if (!band[pixel]) continue;

    const thinRatio = smoothstep(
      normalized.thinFeatureWidth * 0.5,
      normalized.thinFeatureWidth * 1.5,
      thickness[pixel]
    );
    const protection = 1 - normalized.detailProtection * (1 - thinRatio);
    const effectiveStrength = normalized.strength * protection;
    const original = sourceAlpha[pixel];
    const filteredCandidate = original + (filtered[pixel] * 255 - original) * effectiveStrength;
    let candidate = Math.min(original, filteredCandidate);

    if (
      visibleThickness &&
      strongForegroundDistance &&
      original <= normalized.residualAlphaMax
    ) {
      const broadness = smoothstep(broadStart, broadEnd, visibleThickness[pixel]);
      const unsupported = smoothstep(
        normalized.edgeSupportDistance,
        supportFadeEnd,
        strongForegroundDistance[pixel]
      );
      const suppression = suppressionStrength * broadness * unsupported;
      candidate *= 1 - suppression;
    }

    output.data[index] = clampByte(candidate);
  }

  reportProgress(runtime, "alpha-refinement", 1);
  return createImageDataResult(output.data, width, height);
}

export function reconstructRimRgb(imageData, options = {}, runtime = {}) {
  const { width, height, pixelCount } = validateSmartEdgeImageData(imageData);
  const normalized = normalizeRimOptions(options);
  const output = copyImageData(imageData);
  const alpha = alphaBytes(imageData.data, pixelCount);
  const sourceMask = new Uint8Array(pixelCount);
  let sourceCount = 0;

  for (let i = 0; i < pixelCount; i += 1) {
    if (alpha[i] >= normalized.sourceAlpha) {
      sourceMask[i] = 1;
      sourceCount += 1;
    }
  }
  if (sourceCount === 0) return createImageDataResult(output.data, width, height);

  const nearest = runDistanceTransform(sourceMask, width, height, true, runtime);
  const thickness = options.thicknessMap
    ? validateFloatMap(options.thicknessMap, pixelCount, "thickness map")
    : computeLocalFeatureThickness(alpha, width, height, options, runtime);
  const directions = buildDirections(16);

  for (let y = 0; y < height; y += 1) {
    checkRowCancellation(runtime, y);
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + x;
      const targetAlpha = alpha[pixel];
      if (targetAlpha > normalized.targetAlphaMax) continue;
      if (targetAlpha === 0 && !normalized.includeTransparent) continue;
      if (nearest.distance[pixel] > normalized.maxDistance) continue;

      const primary = nearest.labels?.[pixel] ?? -1;
      if (primary < 0 || primary >= pixelCount) continue;
      const adaptiveRadius = Math.max(
        1,
        Math.min(
          normalized.maxDistance,
          Math.ceil(Math.max(2, thickness[pixel] * 0.9))
        )
      );
      const gradient = alphaGradient(alpha, width, height, x, y);
      const candidates = gatherRimCandidates(
        sourceMask,
        width,
        height,
        x,
        y,
        primary,
        adaptiveRadius,
        directions
      );
      if (candidates.length === 0) continue;

      const color = chooseRimColor(
        imageData.data,
        alpha,
        width,
        x,
        y,
        pixel,
        candidates,
        gradient,
        normalized
      );
      if (!color) continue;

      const index = pixel * 4;
      output.data[index] = clampByte(lerp(imageData.data[index], color[0], normalized.blend));
      output.data[index + 1] = clampByte(lerp(imageData.data[index + 1], color[1], normalized.blend));
      output.data[index + 2] = clampByte(lerp(imageData.data[index + 2], color[2], normalized.blend));
      // Alpha is intentionally never touched by rim reconstruction.
    }
    reportProgress(runtime, "rim-reconstruction", (y + 1) / height);
  }

  return createImageDataResult(output.data, width, height);
}

export function smartEdgePolish(imageData, options = {}, runtime = {}) {
  validateSmartEdgeImageData(imageData);
  const alphaOptions = { ...DEFAULT_SMART_EDGE_OPTIONS.alpha, ...(options.alpha || {}) };
  const rimOptions = { ...DEFAULT_SMART_EDGE_OPTIONS.rim, ...(options.rim || {}) };
  const alphaBytesSource = alphaBytes(imageData.data, imageData.width * imageData.height);
  const thicknessMap = computeLocalFeatureThickness(
    alphaBytesSource,
    imageData.width,
    imageData.height,
    alphaOptions,
    runtime
  );
  const refined = refineUncertainAlpha(
    imageData,
    { ...alphaOptions, thicknessMap },
    scopedRuntime(runtime, 0, rimOptions.enabled === false ? 1 : 0.58)
  );
  if (rimOptions.enabled === false) return refined;
  return reconstructRimRgb(
    refined,
    { ...rimOptions, ...alphaOptions, thicknessMap },
    scopedRuntime(runtime, 0.58, 1)
  );
}

function runGuidedFilter(imageData, sourceAlpha, options, runtime) {
  const adapter = runtime.adapter;
  if (adapter?.guidedFilter) {
    try {
      const source = normalizeAlphaSource(sourceAlpha, imageData.width * imageData.height);
      const result = adapter.guidedFilter({
        guideRgba: imageData.data,
        source,
        width: imageData.width,
        height: imageData.height,
        radius: options.radius,
        epsilon: options.lumaSigma * options.lumaSigma,
        isCancelled: runtime.isCancelled
      });
      rejectAsyncAdapter(result, "guidedFilter");
      return normalizeFilterResult(result, source.length, "guidedFilter");
    } catch (error) {
      handleAdapterError(runtime, "guidedFilter", error);
    }
  }

  return guidedAlphaFilterFallback(
    imageData,
    { ...options, source: sourceAlpha },
    runtime
  );
}

function runDistanceTransform(seedMask, width, height, includeLabels, runtime) {
  const adapter = runtime.adapter;
  if (adapter?.distanceTransformLabels) {
    try {
      const result = adapter.distanceTransformLabels({
        seedMask,
        width,
        height,
        includeLabels,
        isCancelled: runtime.isCancelled
      });
      rejectAsyncAdapter(result, "distanceTransformLabels");
      return validateDistanceResult(result, width * height, includeLabels);
    } catch (error) {
      handleAdapterError(runtime, "distanceTransformLabels", error);
    }
  }
  return distanceTransformWithLabelsFallback(
    seedMask,
    width,
    height,
    { includeLabels },
    runtime
  );
}

function recursiveHorizontal(values, rgba, luma, width, height, sigma, rangeSigma, runtime) {
  for (let y = 0; y < height; y += 1) {
    checkRowCancellation(runtime, y);
    const row = y * width;
    for (let x = 1; x < width; x += 1) {
      const i = row + x;
      const a = edgeCoefficient(rgba, luma, i, i - 1, sigma, rangeSigma);
      values[i] = values[i] + a * (values[i - 1] - values[i]);
    }
    for (let x = width - 2; x >= 0; x -= 1) {
      const i = row + x;
      const a = edgeCoefficient(rgba, luma, i, i + 1, sigma, rangeSigma);
      values[i] = values[i] + a * (values[i + 1] - values[i]);
    }
  }
}

function recursiveVertical(values, rgba, luma, width, height, sigma, rangeSigma, runtime) {
  for (let x = 0; x < width; x += 1) {
    if ((x & 31) === 0) throwIfCancelled(runtime);
    for (let y = 1; y < height; y += 1) {
      const i = y * width + x;
      const a = edgeCoefficient(rgba, luma, i, i - width, sigma, rangeSigma);
      values[i] = values[i] + a * (values[i - width] - values[i]);
    }
    for (let y = height - 2; y >= 0; y -= 1) {
      const i = y * width + x;
      const a = edgeCoefficient(rgba, luma, i, i + width, sigma, rangeSigma);
      values[i] = values[i] + a * (values[i + width] - values[i]);
    }
  }
}

function edgeCoefficient(rgba, luma, current, neighbor, sigma, rangeSigma) {
  const ci = current * 4;
  const ni = neighbor * 4;
  const lumaDelta = Math.abs(luma[current] - luma[neighbor]) / 255;
  const dr = rgba[ci] - rgba[ni];
  const dg = rgba[ci + 1] - rgba[ni + 1];
  const db = rgba[ci + 2] - rgba[ni + 2];
  const rgbDelta = Math.sqrt(dr * dr + dg * dg + db * db) / 441.673;
  const guideDelta = lumaDelta * 0.65 + rgbDelta * 0.35;
  const domainDistance = 1 + (sigma / rangeSigma) * guideDelta;
  return Math.exp((-SQRT_TWO * domainDistance) / sigma);
}

function gatherRimCandidates(
  sourceMask,
  width,
  height,
  x,
  y,
  primary,
  radius,
  directions
) {
  const candidates = [primary];
  const seen = new Set(candidates);
  for (const direction of directions) {
    let previous = -1;
    for (let step = 1; step <= radius; step += 1) {
      const sx = Math.round(x + direction[0] * step);
      const sy = Math.round(y + direction[1] * step);
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) break;
      const candidate = sy * width + sx;
      if (candidate === previous) continue;
      previous = candidate;
      if (!sourceMask[candidate]) continue;
      if (!seen.has(candidate)) {
        candidates.push(candidate);
        seen.add(candidate);
      }
      break;
    }
  }
  return candidates;
}

function chooseRimColor(data, alpha, width, x, y, target, candidates, gradient, options) {
  const geometric = [];
  let anchor = null;
  let anchorWeight = -1;

  for (const candidate of candidates) {
    const cx = candidate % width;
    const cy = Math.floor(candidate / width);
    const dx = cx - x;
    const dy = cy - y;
    const distance = Math.max(0.001, Math.hypot(dx, dy));
    const alignment = gradient.magnitude > 0.001
      ? Math.max(0, (dx * gradient.x + dy * gradient.y) / (distance * gradient.magnitude))
      : 0.5;
    const weight = (1 + options.directionWeight * alignment)
      / Math.pow(0.6 + distance, options.distancePower);
    const item = { candidate, distance, alignment, weight };
    geometric.push(item);
    if (weight > anchorWeight) {
      anchor = item;
      anchorWeight = weight;
    }
  }
  if (!anchor) return null;

  const anchorIndex = anchor.candidate * 4;
  const targetIndex = target * 4;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumWeight = 0;
  for (const item of geometric) {
    const index = item.candidate * 4;
    const anchorDelta = perceptualRgbDistance(data, index, data, anchorIndex);
    if (anchorDelta > options.colorTolerance && item !== anchor) continue;

    const colorAffinity = Math.exp(
      -(anchorDelta * anchorDelta)
      / (2 * options.colorTolerance * options.colorTolerance)
    );
    let weight = item.weight * Math.pow(colorAffinity, options.colorWeight);
    if (alpha[target] > 0 && options.targetColorWeight > 0) {
      const targetDelta = perceptualRgbDistance(data, index, data, targetIndex);
      const targetTrust = (alpha[target] / 255) * options.targetColorWeight;
      weight *= Math.exp(
        -targetTrust * targetDelta * targetDelta
        / (2 * options.colorTolerance * options.colorTolerance)
      );
    }
    sumR += data[index] * weight;
    sumG += data[index + 1] * weight;
    sumB += data[index + 2] * weight;
    sumWeight += weight;
  }

  if (sumWeight <= 0) {
    return [data[anchorIndex], data[anchorIndex + 1], data[anchorIndex + 2]];
  }
  return [sumR / sumWeight, sumG / sumWeight, sumB / sumWeight];
}

function perceptualRgbDistance(a, ai, b, bi) {
  const dr = a[ai] - b[bi];
  const dg = a[ai + 1] - b[bi + 1];
  const db = a[ai + 2] - b[bi + 2];
  return Math.sqrt(0.25 * dr * dr + 0.5 * dg * dg + 0.25 * db * db);
}

function alphaGradient(alpha, width, height, x, y) {
  const left = alpha[y * width + Math.max(0, x - 1)];
  const right = alpha[y * width + Math.min(width - 1, x + 1)];
  const top = alpha[Math.max(0, y - 1) * width + x];
  const bottom = alpha[Math.min(height - 1, y + 1) * width + x];
  const gx = right - left;
  const gy = bottom - top;
  return { x: gx, y: gy, magnitude: Math.hypot(gx, gy) };
}

function geodesicMaxFilter(source, foreground, width, height, radius, runtime) {
  let current = new Float32Array(source);
  let next = new Float32Array(source.length);
  for (let step = 0; step < radius; step += 1) {
    throwIfCancelled(runtime);
    for (let y = 0; y < height; y += 1) {
      checkRowCancellation(runtime, y);
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (!foreground[index]) {
          next[index] = 0;
          continue;
        }
        let maximum = current[index];
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(width - 1, x + 1);
        for (let ny = y0; ny <= y1; ny += 1) {
          const row = ny * width;
          for (let nx = x0; nx <= x1; nx += 1) {
            const neighbor = row + nx;
            if (foreground[neighbor] && current[neighbor] > maximum) {
              maximum = current[neighbor];
            }
          }
        }
        next[index] = maximum;
      }
    }
    const swap = current;
    current = next;
    next = swap;
  }
  return current;
}

function distanceToImageBoundary(width, height) {
  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      result[y * width + x] = Math.min(x + 1, y + 1, width - x, height - y);
    }
  }
  return result;
}

function updateDistance(distance, labels, target, source, cost) {
  const candidate = distance[source] + cost;
  if (candidate < distance[target]) {
    distance[target] = candidate;
    if (labels) labels[target] = labels[source];
  }
}

function buildLuma(data, pixelCount) {
  const luma = new Uint8Array(pixelCount);
  for (let pixel = 0, index = 0; pixel < pixelCount; pixel += 1, index += 4) {
    luma[pixel] = clampByte(data[index] * 0.2126 + data[index + 1] * 0.7152 + data[index + 2] * 0.0722);
  }
  return luma;
}

function alphaBytes(data, pixelCount) {
  const output = new Uint8Array(pixelCount);
  for (let pixel = 0, index = 3; pixel < pixelCount; pixel += 1, index += 4) {
    output[pixel] = data[index];
  }
  return output;
}

function alphaToFloat(data, pixelCount) {
  const output = new Float32Array(pixelCount);
  for (let pixel = 0, index = 3; pixel < pixelCount; pixel += 1, index += 4) {
    output[pixel] = data[index] / 255;
  }
  return output;
}

function normalizeAlphaSource(source, pixelCount) {
  if (!ArrayBuffer.isView(source) || source.length < pixelCount) {
    throw new RangeError("Alpha source is smaller than the image");
  }
  const output = new Float32Array(pixelCount);
  const byteScale = source instanceof Uint8Array || source instanceof Uint8ClampedArray;
  for (let i = 0; i < pixelCount; i += 1) {
    output[i] = clamp01(byteScale ? source[i] / 255 : source[i]);
  }
  return output;
}

function normalizeFilterResult(result, pixelCount, name) {
  if (!ArrayBuffer.isView(result) || result.length < pixelCount) {
    throw new RangeError(`${name} returned an invalid alpha buffer`);
  }
  return normalizeAlphaSource(result, pixelCount);
}

function validateDistanceResult(result, pixelCount, includeLabels) {
  if (!result || !ArrayBuffer.isView(result.distance) || result.distance.length < pixelCount) {
    throw new RangeError("distanceTransformLabels returned an invalid distance map");
  }
  if (includeLabels && (!ArrayBuffer.isView(result.labels) || result.labels.length < pixelCount)) {
    throw new RangeError("distanceTransformLabels returned an invalid label map");
  }
  return result;
}

function validateFloatMap(map, pixelCount, name) {
  if (!ArrayBuffer.isView(map) || map.length < pixelCount) {
    throw new RangeError(`${name} is smaller than the image`);
  }
  return map;
}

function validateMask(mask, width, height, name) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new RangeError("Mask dimensions must be positive integers");
  }
  const pixelCount = width * height;
  if (!ArrayBuffer.isView(mask) || mask.length < pixelCount) {
    throw new RangeError(`${name} is smaller than its declared dimensions`);
  }
  return pixelCount;
}

function alphaValueAt(source, index, pixelCount) {
  if (source.length >= pixelCount * 4) return source[index * 4 + 3];
  const value = source[index];
  return source instanceof Float32Array || source instanceof Float64Array
    ? clampByte(value * 255)
    : value;
}

function normalizeAlphaOptions(options) {
  const defaults = DEFAULT_SMART_EDGE_OPTIONS.alpha;
  const lowAlpha = byteOption(options.lowAlpha, defaults.lowAlpha);
  const highAlpha = byteOption(options.highAlpha, defaults.highAlpha);
  if (lowAlpha >= highAlpha) throw new RangeError("lowAlpha must be smaller than highAlpha");
  return {
    lowAlpha,
    highAlpha,
    radius: integerOption(options.radius, defaults.radius, 1, 64),
    iterations: integerOption(options.iterations, defaults.iterations, 1, 4),
    strength: numberOption(options.strength, defaults.strength, 0, 1),
    lumaSigma: numberOption(options.lumaSigma, defaults.lumaSigma, 0.005, 1),
    detailProtection: numberOption(options.detailProtection, defaults.detailProtection, 0, 1),
    thinFeatureWidth: numberOption(options.thinFeatureWidth, defaults.thinFeatureWidth, 0.5, 128),
    thicknessProbeRadius: integerOption(
      options.thicknessProbeRadius,
      defaults.thicknessProbeRadius,
      1,
      64
    ),
    foregroundThreshold: byteOption(options.foregroundThreshold, defaults.foregroundThreshold),
    suppressBroadResiduals: Boolean(
      options.suppressBroadResiduals ?? defaults.suppressBroadResiduals
    ),
    residualAlphaMax: byteOption(options.residualAlphaMax, defaults.residualAlphaMax),
    edgeSupportDistance: numberOption(
      options.edgeSupportDistance,
      defaults.edgeSupportDistance,
      0,
      64
    ),
    residualSuppression: numberOption(
      options.residualSuppression,
      defaults.residualSuppression,
      0,
      1
    )
  };
}

function normalizeRimOptions(options) {
  const defaults = DEFAULT_SMART_EDGE_OPTIONS.rim;
  return {
    sourceAlpha: byteOption(options.sourceAlpha, defaults.sourceAlpha),
    targetAlphaMax: byteOption(options.targetAlphaMax, defaults.targetAlphaMax),
    maxDistance: integerOption(options.maxDistance, defaults.maxDistance, 1, 64),
    directionWeight: numberOption(options.directionWeight, defaults.directionWeight, 0, 12),
    colorTolerance: numberOption(options.colorTolerance, defaults.colorTolerance, 1, 255),
    colorWeight: numberOption(options.colorWeight, defaults.colorWeight, 0, 8),
    targetColorWeight: numberOption(options.targetColorWeight, defaults.targetColorWeight, 0, 2),
    distancePower: numberOption(options.distancePower, defaults.distancePower, 0.1, 4),
    blend: numberOption(options.blend, defaults.blend, 0, 1),
    includeTransparent: options.includeTransparent ?? defaults.includeTransparent
  };
}

function byteOption(value, fallback) {
  return clampByte(numberOption(value, fallback, 0, 255));
}

function integerOption(value, fallback, minimum, maximum) {
  return Math.round(numberOption(value, fallback, minimum, maximum));
}

function numberOption(value, fallback, minimum, maximum) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number)) throw new TypeError("Smart edge options must be finite numbers");
  return Math.min(maximum, Math.max(minimum, number));
}

function buildDirections(count) {
  const directions = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    directions.push([Math.cos(angle), Math.sin(angle)]);
  }
  return directions;
}

function copyImageData(imageData) {
  const length = imageData.width * imageData.height * 4;
  return {
    width: imageData.width,
    height: imageData.height,
    data: new Uint8ClampedArray(imageData.data.slice(0, length))
  };
}

function createImageDataResult(data, width, height) {
  if (typeof ImageData === "function") return new ImageData(data, width, height);
  return { data, width, height };
}

function rejectAsyncAdapter(result, name) {
  if (result && typeof result.then === "function") {
    throw new TypeError(`${name} adapter must be synchronous`);
  }
}

function handleAdapterError(runtime, operation, error) {
  runtime.onAdapterError?.({ operation, error });
  if (runtime.adapterFailure === "throw") throw error;
}

function throwIfCancelled(runtime) {
  if (runtime.isCancelled?.()) throw new SmartEdgeCancelledError();
}

function checkRowCancellation(runtime, row) {
  if (row % CANCEL_CHECK_ROWS === 0) throwIfCancelled(runtime);
}

function reportProgress(runtime, stage, progress) {
  runtime.onProgress?.({ stage, progress: clamp01(progress) });
}

function scopedRuntime(runtime, start, end) {
  return {
    ...runtime,
    onProgress: runtime.onProgress
      ? ({ stage, progress }) => runtime.onProgress({
          stage,
          progress: start + (end - start) * clamp01(progress)
        })
      : undefined
  };
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function clampByte(value) {
  return Math.min(255, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

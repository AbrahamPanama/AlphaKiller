export const SMART_BRUSH_LABELS = Object.freeze({
  SURE_BACKGROUND: 0,
  SURE_FOREGROUND: 1,
  PROBABLE_BACKGROUND: 2,
  PROBABLE_FOREGROUND: 3
});

const DEFAULT_THRESHOLDS = Object.freeze({
  sureBackground: 8,
  probableBackground: 96,
  probableForeground: 160,
  sureForeground: 247
});

const DEFAULT_MAX_ROI_PIXELS = 2048 * 2048;
const EPSILON = 1e-6;

export class SmartBrushCancelledError extends Error {
  constructor(message = "Smart brush edit cancelled") {
    super(message);
    this.name = "SmartBrushCancelledError";
    this.code = "SMART_BRUSH_CANCELLED";
  }
}

export function isSmartBrushCancelledError(error) {
  return error?.code === "SMART_BRUSH_CANCELLED" || error?.name === "AbortError";
}

export function normalizeSmartBrushStrokes(strokes, options = {}) {
  const defaultRadius = positiveNumber(options.radius, positiveNumber(options.brushSize, 18) / 2);
  const input = Array.isArray(strokes) ? strokes : strokes ? [strokes] : [];
  const looksLikePointList = input.length > 0 && input.every(isPointLike);
  const entries = looksLikePointList ? [{ points: input }] : input;
  const normalized = [];

  for (const entry of entries) {
    if (!entry) continue;
    const pointsInput = Array.isArray(entry) ? entry : entry.points || entry.path || [];
    const points = pointsInput
      .filter(isPointLike)
      .map((point) => ({ x: Number(point.x), y: Number(point.y) }));
    if (points.length === 0 && isPointLike(entry)) {
      points.push({ x: Number(entry.x), y: Number(entry.y) });
    }
    if (points.length === 0) continue;

    normalized.push({
      points,
      radius: positiveNumber(entry.radius, positiveNumber(entry.brushSize, defaultRadius * 2) / 2)
    });
  }

  return normalized;
}

export function calculateSmartBrushRoi(strokes, width, height, options = {}) {
  const safeWidth = positiveInteger(width, "width");
  const safeHeight = positiveInteger(height, "height");
  const normalized = normalizeSmartBrushStrokes(strokes, options);
  if (normalized.length === 0) return null;

  let minX = safeWidth;
  let minY = safeHeight;
  let maxX = -1;
  let maxY = -1;
  let largestRadius = 0;

  for (const stroke of normalized) {
    largestRadius = Math.max(largestRadius, stroke.radius);
    for (const point of stroke.points) {
      minX = Math.min(minX, point.x - stroke.radius);
      minY = Math.min(minY, point.y - stroke.radius);
      maxX = Math.max(maxX, point.x + stroke.radius);
      maxY = Math.max(maxY, point.y + stroke.radius);
    }
  }

  const padding = Math.max(
    2,
    Math.ceil(nonNegativeNumber(options.padding, Math.max(12, largestRadius * 2)))
  );
  const x0 = clamp(Math.floor(minX) - padding, 0, safeWidth - 1);
  const y0 = clamp(Math.floor(minY) - padding, 0, safeHeight - 1);
  const x1 = clamp(Math.ceil(maxX) + padding, 0, safeWidth - 1);
  const y1 = clamp(Math.ceil(maxY) + padding, 0, safeHeight - 1);

  return {
    x: x0,
    y: y0,
    width: x1 - x0 + 1,
    height: y1 - y0 + 1,
    padding,
    pixelCount: (x1 - x0 + 1) * (y1 - y0 + 1),
    strokes: normalized
  };
}

export function buildSmartBrushSeeds(currentImage, roi, mode, options = {}) {
  const current = validateImageLike(currentImage, "currentImage");
  const safeRoi = validateRoi(roi, current.width, current.height);
  const safeMode = normalizeMode(mode);
  const thresholds = normalizeThresholds(options.thresholds);
  const labels = new Uint8Array(safeRoi.width * safeRoi.height);
  const hardSeeds = new Uint8Array(labels.length);
  const borderSize = Math.max(1, Math.floor(nonNegativeNumber(options.anchorBorder, 2)));

  for (let y = 0; y < safeRoi.height; y += 1) {
    throwIfCancelled(options, y);
    for (let x = 0; x < safeRoi.width; x += 1) {
      const pixel = y * safeRoi.width + x;
      const sourceIndex = ((safeRoi.y + y) * current.width + safeRoi.x + x) * 4;
      const alpha = current.data[sourceIndex + 3];
      labels[pixel] = labelFromAlpha(alpha, thresholds);

      const onBorder = x < borderSize || y < borderSize ||
        x >= safeRoi.width - borderSize || y >= safeRoi.height - borderSize;
      const stableOpposite = safeMode === "restore"
        ? labels[pixel] === SMART_BRUSH_LABELS.SURE_FOREGROUND
        : labels[pixel] === SMART_BRUSH_LABELS.SURE_BACKGROUND;
      hardSeeds[pixel] = onBorder || stableOpposite ? 1 : 0;
    }
  }

  return { labels, hardSeeds, thresholds, roi: safeRoi };
}

export function rasterizeStrokeSeeds(seedState, strokes, mode, options = {}) {
  const safeMode = normalizeMode(mode);
  const { roi } = seedState || {};
  if (!roi || !(seedState.labels instanceof Uint8Array) || !(seedState.hardSeeds instanceof Uint8Array)) {
    throw new TypeError("seedState must be returned by buildSmartBrushSeeds");
  }

  const normalized = normalizeSmartBrushStrokes(strokes, options);
  const strokeMask = new Uint8Array(roi.width * roi.height);
  const label = safeMode === "restore"
    ? SMART_BRUSH_LABELS.SURE_FOREGROUND
    : SMART_BRUSH_LABELS.SURE_BACKGROUND;

  for (let strokeIndex = 0; strokeIndex < normalized.length; strokeIndex += 1) {
    throwIfCancelled(options, strokeIndex);
    const stroke = normalized[strokeIndex];
    if (stroke.points.length === 1) {
      paintSeedCircle(seedState, strokeMask, stroke.points[0], stroke.radius, label);
      continue;
    }
    for (let pointIndex = 1; pointIndex < stroke.points.length; pointIndex += 1) {
      rasterizeSeedSegment(
        seedState,
        strokeMask,
        stroke.points[pointIndex - 1],
        stroke.points[pointIndex],
        stroke.radius,
        label
      );
    }
  }

  return { ...seedState, strokeMask };
}

export function runLocalSmartSegmentation(rgba, width, height, seedState, options = {}) {
  const data = validateRgbaBuffer(rgba, width, height, "rgba");
  const labels = new Uint8Array(seedState.labels);
  const hardSeeds = new Uint8Array(seedState.hardSeeds);
  const iterations = clamp(Math.floor(positiveNumber(options.iterations, 6)), 1, 20);
  const neighborhoodWeight = nonNegativeNumber(options.neighborhoodWeight, 2.4);
  const alphaPriorWeight = nonNegativeNumber(options.alphaPriorWeight, 1.15);
  const edgeSigma = positiveNumber(options.edgeSigma, 28);
  const alpha = options.alpha instanceof Uint8Array
    ? options.alpha
    : extractAlpha(data, width, height);
  const expectedLength = width * height;
  if (labels.length !== expectedLength || hardSeeds.length !== expectedLength || alpha.length !== expectedLength) {
    throw new RangeError("Segmentation buffers do not match the ROI dimensions");
  }

  let completedIterations = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    throwIfCancelled(options, iteration);
    const foregroundModel = estimateColorModel(data, labels, true);
    const backgroundModel = estimateColorModel(data, labels, false);
    let changes = 0;

    // Checkerboard updates avoid directional bias while remaining deterministic.
    for (let parity = 0; parity < 2; parity += 1) {
      for (let y = 0; y < height; y += 1) {
        throwIfCancelled(options, y + iteration * height);
        for (let x = (y + parity) & 1; x < width; x += 2) {
          const pixel = y * width + x;
          if (hardSeeds[pixel]) continue;
          const energies = calculatePixelEnergies({
            data,
            alpha,
            labels,
            width,
            height,
            x,
            y,
            foregroundModel,
            backgroundModel,
            neighborhoodWeight,
            alphaPriorWeight,
            edgeSigma
          });
          const foreground = energies.foreground <= energies.background;
          const wasForeground = isForegroundLabel(labels[pixel]);
          labels[pixel] = foreground
            ? SMART_BRUSH_LABELS.PROBABLE_FOREGROUND
            : SMART_BRUSH_LABELS.PROBABLE_BACKGROUND;
          if (foreground !== wasForeground) changes += 1;
        }
      }
    }

    completedIterations = iteration + 1;
    if (changes === 0) break;
  }

  const foregroundModel = estimateColorModel(data, labels, true);
  const backgroundModel = estimateColorModel(data, labels, false);
  const probability = new Float32Array(expectedLength);
  for (let y = 0; y < height; y += 1) {
    throwIfCancelled(options, y);
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (hardSeeds[pixel]) {
        probability[pixel] = labels[pixel] === SMART_BRUSH_LABELS.SURE_FOREGROUND ? 1 : 0;
        continue;
      }
      const energies = calculatePixelEnergies({
        data,
        alpha,
        labels,
        width,
        height,
        x,
        y,
        foregroundModel,
        backgroundModel,
        neighborhoodWeight,
        alphaPriorWeight,
        edgeSigma
      });
      const difference = clamp(energies.background - energies.foreground, -16, 16);
      probability[pixel] = 1 / (1 + Math.exp(-difference));
    }
  }

  return { labels, probability, iterations: completedIterations, engine: "local" };
}

export function runOpenCvGrabCut(opencv, rgba, width, height, seedState, options = {}) {
  if (!hasOpenCvGrabCut(opencv)) return null;
  throwIfCancelled(options, 0);
  const data = validateRgbaBuffer(rgba, width, height, "rgba");
  const resources = [];

  try {
    const image = new opencv.Mat(height, width, opencv.CV_8UC3);
    const mask = new opencv.Mat(height, width, opencv.CV_8UC1);
    const backgroundModel = new opencv.Mat();
    const foregroundModel = new opencv.Mat();
    resources.push(image, mask, backgroundModel, foregroundModel);

    const rgb = image.data;
    for (let pixel = 0, sourceIndex = 0, targetIndex = 0; pixel < width * height; pixel += 1) {
      rgb[targetIndex++] = data[sourceIndex++];
      rgb[targetIndex++] = data[sourceIndex++];
      rgb[targetIndex++] = data[sourceIndex++];
      sourceIndex += 1;
    }
    mask.data.set(seedState.labels);

    opencv.grabCut(
      image,
      mask,
      new opencv.Rect(0, 0, width, height),
      backgroundModel,
      foregroundModel,
      clamp(Math.floor(positiveNumber(options.openCvIterations, options.iterations ?? 5)), 1, 20),
      opencv.GC_INIT_WITH_MASK
    );
    throwIfCancelled(options, 1);

    const labels = new Uint8Array(mask.data);
    const probability = new Float32Array(width * height);
    for (let pixel = 0; pixel < probability.length; pixel += 1) {
      const foreground = labels[pixel] === opencv.GC_FGD || labels[pixel] === opencv.GC_PR_FGD;
      probability[pixel] = foreground ? 1 : 0;
    }
    return { labels, probability, iterations: options.openCvIterations ?? options.iterations ?? 5, engine: "opencv" };
  } finally {
    for (let index = resources.length - 1; index >= 0; index -= 1) {
      resources[index]?.delete?.();
    }
  }
}

export function applyExactBrushEdit(currentImage, sourceImage, strokes, mode, options = {}) {
  const current = validateImageLike(currentImage, "currentImage");
  const safeMode = normalizeMode(mode);
  const source = safeMode === "restore"
    ? validateCompatibleSource(sourceImage, current)
    : sourceImage ? validateCompatibleSource(sourceImage, current) : current;
  const roi = calculateSmartBrushRoi(strokes, current.width, current.height, {
    ...options,
    padding: options.exactPadding ?? 1
  });
  if (!roi) return emptyResult(current, safeMode, "exact");

  const seedState = rasterizeStrokeSeeds(
    buildSmartBrushSeeds(current, roi, safeMode, options),
    roi.strokes,
    safeMode,
    options
  );
  const currentRoi = extractRgbaRoi(current, roi);
  const sourceRoi = source === current ? currentRoi : extractRgbaRoi(source, roi);
  const output = new Uint8ClampedArray(currentRoi);

  for (let pixel = 0, index = 0; pixel < seedState.strokeMask.length; pixel += 1, index += 4) {
    throwIfCancelled(options, pixel);
    if (!seedState.strokeMask[pixel]) continue;
    if (safeMode === "delete") {
      output[index + 3] = 0;
    } else {
      output[index] = sourceRoi[index];
      output[index + 1] = sourceRoi[index + 1];
      output[index + 2] = sourceRoi[index + 2];
      output[index + 3] = sourceRoi[index + 3];
    }
  }

  return buildEditResult(current, roi, output, safeMode, "exact", seedState.strokeMask, null, options);
}

export function applySmartBrushEdit(params = {}) {
  const {
    currentImage,
    sourceImage,
    strokes,
    mode = "delete",
    opencv = null,
    exact = false
  } = params;
  const options = params.options ? {
    ...params.options,
    signal: params.signal ?? params.options.signal,
    shouldCancel: params.shouldCancel ?? params.options.shouldCancel
  } : params;
  const current = validateImageLike(currentImage, "currentImage");
  const safeMode = normalizeMode(mode);
  const source = safeMode === "restore"
    ? validateCompatibleSource(sourceImage, current)
    : sourceImage ? validateCompatibleSource(sourceImage, current) : current;
  throwIfCancelled(options, 0);

  if (exact) {
    return applyExactBrushEdit(current, source, strokes, safeMode, options);
  }

  const roi = calculateSmartBrushRoi(strokes, current.width, current.height, options);
  if (!roi) return emptyResult(current, safeMode, "local");
  const maxRoiPixels = positiveIntegerOr(options.maxRoiPixels, DEFAULT_MAX_ROI_PIXELS);
  if (roi.pixelCount > maxRoiPixels) {
    const fallback = applyExactBrushEdit(current, source, strokes, safeMode, options);
    return { ...fallback, fallbackReason: "roi-too-large" };
  }

  try {
    const currentRoi = extractRgbaRoi(current, roi);
    const sourceRoi = source === current ? currentRoi : extractRgbaRoi(source, roi);
    const colorRoi = safeMode === "restore" ? sourceRoi : currentRoi;
    const seedState = rasterizeStrokeSeeds(
      buildSmartBrushSeeds(current, roi, safeMode, options),
      roi.strokes,
      safeMode,
      options
    );
    const alpha = extractAlpha(currentRoi, roi.width, roi.height);

    let segmentation = null;
    let openCvError = null;
    if (opencv && options.preferOpenCv !== false) {
      try {
        segmentation = runOpenCvGrabCut(opencv, colorRoi, roi.width, roi.height, seedState, options);
      } catch (error) {
        if (isSmartBrushCancelledError(error)) throw error;
        openCvError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!segmentation) {
      segmentation = runLocalSmartSegmentation(colorRoi, roi.width, roi.height, seedState, {
        ...options,
        alpha
      });
    }

    const output = composeSmartRoi({
      currentRoi,
      sourceRoi,
      probability: segmentation.probability,
      strokeMask: seedState.strokeMask,
      mode: safeMode,
      options
    });
    const result = buildEditResult(
      current,
      roi,
      output,
      safeMode,
      segmentation.engine,
      seedState.strokeMask,
      segmentation,
      options
    );
    if (openCvError) result.openCvError = openCvError;
    return result;
  } catch (error) {
    if (isSmartBrushCancelledError(error) || options.fallbackExact === false) throw error;
    const fallback = applyExactBrushEdit(current, source, strokes, safeMode, options);
    return {
      ...fallback,
      fallbackReason: error instanceof Error ? error.message : "smart-segmentation-failed"
    };
  }
}

export function applyRgbaRoiPatch(image, roi, rgba) {
  const current = validateImageLike(image, "image");
  const safeRoi = validateRoi(roi, current.width, current.height);
  const patch = validateRgbaBuffer(rgba, safeRoi.width, safeRoi.height, "rgba");
  const output = new Uint8ClampedArray(current.data);

  for (let row = 0; row < safeRoi.height; row += 1) {
    const sourceStart = row * safeRoi.width * 4;
    const targetStart = ((safeRoi.y + row) * current.width + safeRoi.x) * 4;
    output.set(patch.subarray(sourceStart, sourceStart + safeRoi.width * 4), targetStart);
  }

  return { data: output, width: current.width, height: current.height };
}

function composeSmartRoi({ currentRoi, sourceRoi, probability, strokeMask, mode, options }) {
  const output = new Uint8ClampedArray(currentRoi);
  const low = clamp(Number(options.softLow ?? 0.28), 0, 1);
  const high = clamp(Number(options.softHigh ?? 0.72), low + EPSILON, 1);

  for (let pixel = 0, index = 0; pixel < probability.length; pixel += 1, index += 4) {
    throwIfCancelled(options, pixel);
    const hard = strokeMask[pixel] === 1;
    const weight = hard
      ? mode === "restore" ? 1 : 0
      : smoothstep(low, high, probability[pixel]);

    if (mode === "delete") {
      // Delete is monotonic: it cannot create alpha or modify hidden RGB.
      output[index + 3] = hard ? 0 : Math.min(currentRoi[index + 3], Math.round(currentRoi[index + 3] * weight));
      continue;
    }

    // Restore is bounded by the pre-segmentation source alpha and never decreases current alpha.
    const sourceAlpha = sourceRoi[index + 3];
    const restoredAlpha = hard ? sourceAlpha : Math.round(sourceAlpha * weight);
    const nextAlpha = Math.max(currentRoi[index + 3], restoredAlpha);
    if (nextAlpha > currentRoi[index + 3]) {
      output[index] = sourceRoi[index];
      output[index + 1] = sourceRoi[index + 1];
      output[index + 2] = sourceRoi[index + 2];
      output[index + 3] = nextAlpha;
    }
  }

  return output;
}

function buildEditResult(current, roi, rgba, mode, engine, strokeMask, segmentation, options) {
  const result = {
    mode,
    engine,
    roi: { x: roi.x, y: roi.y, width: roi.width, height: roi.height },
    rgba,
    strokeMask,
    labels: segmentation?.labels || null,
    probability: segmentation?.probability || null,
    iterations: segmentation?.iterations || 0
  };
  if (options.returnFullImage !== false) {
    result.image = applyRgbaRoiPatch(current, roi, rgba);
  }
  return result;
}

function emptyResult(current, mode, engine) {
  return {
    mode,
    engine,
    roi: null,
    rgba: new Uint8ClampedArray(0),
    strokeMask: new Uint8Array(0),
    labels: null,
    probability: null,
    iterations: 0,
    image: { data: new Uint8ClampedArray(current.data), width: current.width, height: current.height }
  };
}

function calculatePixelEnergies(context) {
  const {
    data,
    alpha,
    labels,
    width,
    height,
    x,
    y,
    foregroundModel,
    backgroundModel,
    neighborhoodWeight,
    alphaPriorWeight,
    edgeSigma
  } = context;
  const pixel = y * width + x;
  const index = pixel * 4;
  let foreground = colorEnergy(data, index, foregroundModel);
  let background = colorEnergy(data, index, backgroundModel);
  const alphaProbability = clamp((alpha[pixel] + 0.5) / 256, 0.002, 0.998);
  foreground += -Math.log(alphaProbability) * alphaPriorWeight;
  background += -Math.log(1 - alphaProbability) * alphaPriorWeight;

  const neighbors = [
    x > 0 ? pixel - 1 : -1,
    x + 1 < width ? pixel + 1 : -1,
    y > 0 ? pixel - width : -1,
    y + 1 < height ? pixel + width : -1
  ];
  const sigmaDenominator = 2 * edgeSigma * edgeSigma;
  for (const neighbor of neighbors) {
    if (neighbor < 0) continue;
    const neighborIndex = neighbor * 4;
    const dr = data[index] - data[neighborIndex];
    const dg = data[index + 1] - data[neighborIndex + 1];
    const db = data[index + 2] - data[neighborIndex + 2];
    const weight = neighborhoodWeight * Math.exp(-(dr * dr + dg * dg + db * db) / sigmaDenominator);
    if (isForegroundLabel(labels[neighbor])) background += weight;
    else foreground += weight;
  }

  return { foreground, background };
}

function estimateColorModel(data, labels, foreground) {
  const mean = [0, 0, 0];
  const variance = [0, 0, 0];
  let count = 0;

  for (let pixel = 0, index = 0; pixel < labels.length; pixel += 1, index += 4) {
    if (isForegroundLabel(labels[pixel]) !== foreground) continue;
    mean[0] += data[index];
    mean[1] += data[index + 1];
    mean[2] += data[index + 2];
    count += 1;
  }
  if (count === 0) return { mean: [127.5, 127.5, 127.5], variance: [65025, 65025, 65025], count: 0 };
  for (let channel = 0; channel < 3; channel += 1) mean[channel] /= count;

  for (let pixel = 0, index = 0; pixel < labels.length; pixel += 1, index += 4) {
    if (isForegroundLabel(labels[pixel]) !== foreground) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = data[index + channel] - mean[channel];
      variance[channel] += difference * difference;
    }
  }
  for (let channel = 0; channel < 3; channel += 1) {
    variance[channel] = clamp(variance[channel] / count, 36, 65025);
  }
  return { mean, variance, count };
}

function colorEnergy(data, index, model) {
  let energy = 0;
  for (let channel = 0; channel < 3; channel += 1) {
    const difference = data[index + channel] - model.mean[channel];
    energy += (difference * difference) / model.variance[channel] + 0.12 * Math.log(model.variance[channel]);
  }
  return energy;
}

function labelFromAlpha(alpha, thresholds) {
  if (alpha <= thresholds.sureBackground) return SMART_BRUSH_LABELS.SURE_BACKGROUND;
  if (alpha <= thresholds.probableBackground) return SMART_BRUSH_LABELS.PROBABLE_BACKGROUND;
  if (alpha >= thresholds.sureForeground) return SMART_BRUSH_LABELS.SURE_FOREGROUND;
  if (alpha >= thresholds.probableForeground) return SMART_BRUSH_LABELS.PROBABLE_FOREGROUND;
  return alpha >= 128 ? SMART_BRUSH_LABELS.PROBABLE_FOREGROUND : SMART_BRUSH_LABELS.PROBABLE_BACKGROUND;
}

function normalizeThresholds(value = {}) {
  const thresholds = {
    sureBackground: clampByte(value.sureBackground ?? DEFAULT_THRESHOLDS.sureBackground),
    probableBackground: clampByte(value.probableBackground ?? DEFAULT_THRESHOLDS.probableBackground),
    probableForeground: clampByte(value.probableForeground ?? DEFAULT_THRESHOLDS.probableForeground),
    sureForeground: clampByte(value.sureForeground ?? DEFAULT_THRESHOLDS.sureForeground)
  };
  if (!(thresholds.sureBackground <= thresholds.probableBackground &&
    thresholds.probableBackground < thresholds.probableForeground &&
    thresholds.probableForeground <= thresholds.sureForeground)) {
    throw new RangeError("Alpha seed thresholds must be ordered from background to foreground");
  }
  return thresholds;
}

function paintSeedCircle(seedState, strokeMask, point, radius, label) {
  const { roi, labels, hardSeeds } = seedState;
  const localX = point.x - roi.x;
  const localY = point.y - roi.y;
  const radiusSq = radius * radius;
  const minX = clamp(Math.floor(localX - radius), 0, roi.width - 1);
  const maxX = clamp(Math.ceil(localX + radius), 0, roi.width - 1);
  const minY = clamp(Math.floor(localY - radius), 0, roi.height - 1);
  const maxY = clamp(Math.ceil(localY + radius), 0, roi.height - 1);

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - localX;
      const dy = y - localY;
      if (dx * dx + dy * dy > radiusSq) continue;
      const pixel = y * roi.width + x;
      labels[pixel] = label;
      hardSeeds[pixel] = 1;
      strokeMask[pixel] = 1;
    }
  }
}

function rasterizeSeedSegment(seedState, strokeMask, from, to, radius, label) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(0.75, radius * 0.5)));
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    paintSeedCircle(seedState, strokeMask, {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t
    }, radius, label);
  }
}

function extractRgbaRoi(image, roi) {
  const output = new Uint8ClampedArray(roi.width * roi.height * 4);
  for (let row = 0; row < roi.height; row += 1) {
    const sourceStart = ((roi.y + row) * image.width + roi.x) * 4;
    output.set(image.data.subarray(sourceStart, sourceStart + roi.width * 4), row * roi.width * 4);
  }
  return output;
}

function extractAlpha(rgba, width, height) {
  const alpha = new Uint8Array(width * height);
  for (let pixel = 0, index = 3; pixel < alpha.length; pixel += 1, index += 4) alpha[pixel] = rgba[index];
  return alpha;
}

function validateImageLike(image, name) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0) {
    throw new TypeError(`${name} must have positive integer width and height`);
  }
  if (!ArrayBuffer.isView(image.data) || image.data.length < image.width * image.height * 4) {
    throw new TypeError(`${name}.data must be an RGBA typed array`);
  }
  return image;
}

function validateCompatibleSource(source, current) {
  const validated = validateImageLike(source, "sourceImage");
  if (validated.width !== current.width || validated.height !== current.height) {
    throw new RangeError("sourceImage dimensions must match currentImage dimensions");
  }
  return validated;
}

function validateRgbaBuffer(rgba, width, height, name) {
  if (!ArrayBuffer.isView(rgba) || rgba.length < width * height * 4) {
    throw new TypeError(`${name} must be an RGBA typed array matching the dimensions`);
  }
  return rgba;
}

function validateRoi(roi, width, height) {
  if (!roi || !Number.isInteger(roi.x) || !Number.isInteger(roi.y) ||
    !Number.isInteger(roi.width) || !Number.isInteger(roi.height) ||
    roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0 ||
    roi.x + roi.width > width || roi.y + roi.height > height) {
    throw new RangeError("ROI is outside the image dimensions");
  }
  return roi;
}

function hasOpenCvGrabCut(opencv) {
  return Boolean(
    opencv &&
    typeof opencv.Mat === "function" &&
    typeof opencv.Rect === "function" &&
    typeof opencv.grabCut === "function" &&
    opencv.CV_8UC3 !== undefined &&
    opencv.CV_8UC1 !== undefined &&
    opencv.GC_INIT_WITH_MASK !== undefined
  );
}

function isForegroundLabel(label) {
  return label === SMART_BRUSH_LABELS.SURE_FOREGROUND || label === SMART_BRUSH_LABELS.PROBABLE_FOREGROUND;
}

function throwIfCancelled(options, checkpoint) {
  if (options?.signal?.aborted || options?.shouldCancel?.(checkpoint)) {
    throw new SmartBrushCancelledError();
  }
}

function normalizeMode(mode) {
  if (mode === "restore" || mode === "reconstruct") return "restore";
  if (mode === "delete" || mode === "erase") return "delete";
  throw new TypeError(`Unsupported smart brush mode: ${mode}`);
}

function isPointLike(value) {
  return value && Number.isFinite(Number(value.x)) && Number.isFinite(Number(value.y));
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new TypeError(`${name} must be a positive integer`);
  return parsed;
}

function positiveIntegerOr(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function clampByte(value) {
  return Math.round(clamp(Number(value) || 0, 0, 255));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(low, high, value) {
  const t = clamp((value - low) / (high - low), 0, 1);
  return t * t * (3 - 2 * t);
}

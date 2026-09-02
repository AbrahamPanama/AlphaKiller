import { distanceTransformWithLabelsFallback } from "./smartEdge.js";

const DEFAULT_BACKGROUND_THRESHOLD = 13;
const DEFAULT_FOREGROUND_THRESHOLD = 242;
const DEFAULT_STRUCTURE_THRESHOLD = 128;

export function deriveSamPrompts(maskBuffer, width, height, options = {}) {
  const mask = normalizeMask(maskBuffer, width, height, "Stage 1 mask");
  const supportThreshold = byteOption(options.supportThreshold, 32);
  const positiveThreshold = byteOption(options.positiveThreshold, 180);
  const maxPoints = integerOption(options.maxPoints, 12, 1, 32);
  const bounds = visibleBounds(mask, width, height, supportThreshold);
  if (!bounds) return null;

  const padding = Math.max(2, Math.round(Math.max(width, height) * 0.01));
  const box = [
    Math.max(0, bounds.minX - padding),
    Math.max(0, bounds.minY - padding),
    Math.min(width, bounds.maxX + 1 + padding),
    Math.min(height, bounds.maxY + 1 + padding)
  ];

  const backgroundSeeds = new Uint8Array(mask.length);
  let backgroundCount = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (mask[pixel] < positiveThreshold) {
      backgroundSeeds[pixel] = 1;
      backgroundCount += 1;
    }
  }

  const distance = backgroundCount > 0
    ? distanceTransformWithLabelsFallback(
        backgroundSeeds,
        width,
        height,
        { includeLabels: false }
      ).distance
    : distanceToImageBoundary(width, height);
  const boxWidth = Math.max(1, box[2] - box[0]);
  const boxHeight = Math.max(1, box[3] - box[1]);
  const aspect = boxWidth / boxHeight;
  const columns = Math.max(1, Math.ceil(Math.sqrt(maxPoints * aspect)));
  const rows = Math.max(1, Math.ceil(maxPoints / columns));
  const candidates = [];

  for (let row = 0; row < rows; row += 1) {
    const y0 = Math.floor(box[1] + (row * boxHeight) / rows);
    const y1 = Math.max(y0 + 1, Math.ceil(box[1] + ((row + 1) * boxHeight) / rows));
    for (let column = 0; column < columns; column += 1) {
      const x0 = Math.floor(box[0] + (column * boxWidth) / columns);
      const x1 = Math.max(x0 + 1, Math.ceil(box[0] + ((column + 1) * boxWidth) / columns));
      let best = null;

      for (let y = y0; y < Math.min(height, y1); y += 1) {
        for (let x = x0; x < Math.min(width, x1); x += 1) {
          const pixel = y * width + x;
          if (mask[pixel] < positiveThreshold) continue;
          const score = distance[pixel] + mask[pixel] / 255;
          if (!best || score > best.score) best = { x, y, score };
        }
      }

      if (best) candidates.push(best);
    }
  }

  if (candidates.length === 0) {
    let bestPixel = -1;
    for (let pixel = 0; pixel < mask.length; pixel += 1) {
      if (bestPixel < 0 || mask[pixel] > mask[bestPixel]) bestPixel = pixel;
    }
    if (bestPixel < 0 || mask[bestPixel] <= supportThreshold) return null;
    candidates.push({
      x: bestPixel % width,
      y: Math.floor(bestPixel / width),
      score: mask[bestPixel] / 255
    });
  }

  candidates.sort((first, second) => second.score - first.score);
  const minSpacing = Math.max(2, Math.min(boxWidth, boxHeight) / 20);
  const minSpacingSquared = minSpacing * minSpacing;
  const points = [];
  for (const candidate of candidates) {
    if (points.every((point) => squaredDistance(point, candidate) >= minSpacingSquared)) {
      points.push({ x: candidate.x, y: candidate.y });
      if (points.length >= maxPoints) break;
    }
  }

  return {
    box,
    points,
    labels: points.map(() => 1),
    bounds
  };
}

export function selectSamStructuralMask(maskTensor, scoreTensor, baseMaskBuffer, width, height, options = {}) {
  const baseMask = normalizeMask(baseMaskBuffer, width, height, "Stage 1 mask");
  const data = maskTensor?.data;
  const dims = maskTensor?.dims;
  if (!ArrayBuffer.isView(data) || !Array.isArray(dims) || dims.length < 3) {
    throw new TypeError("SAM mask tensor is invalid");
  }
  if (dims.at(-1) !== width || dims.at(-2) !== height) {
    throw new RangeError(`Expected SAM mask ${width}x${height}, got ${dims.at(-1)}x${dims.at(-2)}`);
  }

  const pixelCount = width * height;
  const candidateCount = Math.max(1, dims.at(-3));
  const scores = ArrayBuffer.isView(scoreTensor?.data) ? scoreTensor.data : scoreTensor;
  const baseThreshold = byteOption(options.baseThreshold, 32);
  const maskThreshold = numberOption(options.maskThreshold, 0);
  let baseArea = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (baseMask[pixel] > baseThreshold) baseArea += 1;
  }
  if (baseArea === 0) return null;

  let best = null;
  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    const offset = candidate * pixelCount;
    let area = 0;
    let intersection = 0;
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if ((data[offset + pixel] ?? -Infinity) <= maskThreshold) continue;
      area += 1;
      if (baseMask[pixel] > baseThreshold) intersection += 1;
    }
    if (area === 0) continue;

    const recall = intersection / baseArea;
    const precision = intersection / area;
    const overlap = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    const modelScore = Number(scores?.[candidate] ?? 0);
    const areaRatio = area / baseArea;
    const inflationPenalty = areaRatio > 1.8 ? Math.min(0.45, (areaRatio - 1.8) * 0.16) : 0;
    const collapsePenalty = areaRatio < 0.45 ? Math.min(0.45, (0.45 - areaRatio) * 0.8) : 0;
    const combinedScore = modelScore * 0.55 + overlap * 0.3 + recall * 0.15 - inflationPenalty - collapsePenalty;
    if (!best || combinedScore > best.combinedScore) {
      best = { candidate, offset, area, areaRatio, recall, precision, modelScore, combinedScore };
    }
  }

  const minRecall = numberOption(options.minRecall, 0.5);
  if (!best || best.recall < minRecall || best.areaRatio < 0.2 || best.areaRatio > 4) return null;

  const mask = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    mask[pixel] = (data[best.offset + pixel] ?? -Infinity) > maskThreshold ? 255 : 0;
  }
  return {
    mask,
    candidate: best.candidate,
    score: best.modelScore,
    recall: best.recall,
    precision: best.precision,
    areaRatio: best.areaRatio
  };
}

export function buildAdaptiveStructureTrimap(
  baseMaskBuffer,
  structuralMaskBuffer,
  width,
  height,
  options = {}
) {
  const baseMask = normalizeMask(baseMaskBuffer, width, height, "Stage 1 mask");
  const structuralMask = normalizeMask(structuralMaskBuffer, width, height, "Structural mask");
  const backgroundThreshold = byteOption(options.backgroundThreshold, DEFAULT_BACKGROUND_THRESHOLD);
  const foregroundThreshold = byteOption(options.foregroundThreshold, DEFAULT_FOREGROUND_THRESHOLD);
  const structureThreshold = byteOption(options.structureThreshold, DEFAULT_STRUCTURE_THRESHOLD);
  const scale = Math.max(width, height) / 1024;
  const innerRadius = numberOption(options.innerRadius, Math.max(2, Math.min(7, 3 * scale)));
  const outerRadius = numberOption(options.outerRadius, Math.max(2, Math.min(8, 4 * scale)));
  const structuralForeground = new Uint8Array(baseMask.length);
  const structuralBackground = new Uint8Array(baseMask.length);
  let foregroundCount = 0;

  for (let pixel = 0; pixel < baseMask.length; pixel += 1) {
    const inside = structuralMask[pixel] >= structureThreshold;
    structuralForeground[pixel] = inside ? 1 : 0;
    structuralBackground[pixel] = inside ? 0 : 1;
    if (inside) foregroundCount += 1;
  }
  if (foregroundCount === 0) throw new Error("SAM returned an empty structural mask");

  const insideDistance = foregroundCount === baseMask.length
    ? distanceToImageBoundary(width, height)
    : distanceTransformWithLabelsFallback(
        structuralBackground,
        width,
        height,
        { includeLabels: false }
      ).distance;
  const outsideDistance = distanceTransformWithLabelsFallback(
    structuralForeground,
    width,
    height,
    { includeLabels: false }
  ).distance;
  const trimap = new Uint8Array(baseMask.length);
  let definiteForeground = 0;
  let definiteBackground = 0;
  let unknown = 0;
  let protectedThinCores = 0;
  let recoveredInterior = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const inside = structuralForeground[pixel] === 1;
      const baseAlpha = baseMask[pixel];
      const ridge = inside && isLocalDistanceRidge(insideDistance, x, y, width, height);
      const deepInterior = insideDistance[pixel] >= innerRadius;
      const baseConfirmsForeground = baseAlpha >= foregroundThreshold;

      if (inside && (baseConfirmsForeground || deepInterior || ridge)) {
        trimap[pixel] = 255;
        definiteForeground += 1;
        if (ridge && !deepInterior) protectedThinCores += 1;
        if (deepInterior && baseAlpha <= backgroundThreshold) recoveredInterior += 1;
      } else if (
        !inside &&
        baseAlpha <= backgroundThreshold &&
        outsideDistance[pixel] > outerRadius
      ) {
        trimap[pixel] = 0;
        definiteBackground += 1;
      } else {
        trimap[pixel] = 128;
        unknown += 1;
      }
    }
  }

  return {
    trimap,
    stats: {
      definiteForeground,
      definiteBackground,
      unknown,
      protectedThinCores,
      recoveredInterior
    }
  };
}

export function applyAdaptiveTrimapLocks(refinedMaskBuffer, trimapBuffer, width, height) {
  const refinedMask = normalizeMask(refinedMaskBuffer, width, height, "Refined mask");
  const trimap = normalizeMask(trimapBuffer, width, height, "Trimap");
  const output = new Uint8Array(refinedMask);
  for (let pixel = 0; pixel < output.length; pixel += 1) {
    if (trimap[pixel] === 255) output[pixel] = 255;
    else if (trimap[pixel] === 0) output[pixel] = 0;
  }
  return output;
}

export function buildCertainBackgroundMask(
  sourceBuffer,
  baseMaskBuffer,
  width,
  height,
  options = {}
) {
  const pixelCount = width * height;
  const source = ArrayBuffer.isView(sourceBuffer)
    ? sourceBuffer
    : new Uint8ClampedArray(sourceBuffer);
  const baseMask = normalizeMask(baseMaskBuffer, width, height, "Stage 1 mask");
  const channels = integerOption(
    options.channels,
    source.length >= pixelCount * 4 ? 4 : 3,
    3,
    4
  );
  if (source.length < pixelCount * channels) {
    throw new RangeError("Source pixels are smaller than their declared dimensions");
  }

  const borderSamples = sampleOpaqueBorder(source, width, height, channels);
  const emptyMask = new Uint8Array(pixelCount);
  if (borderSamples.length < 8) {
    return {
      mask: emptyMask,
      stats: { applied: false, reason: "insufficient-border-samples" }
    };
  }

  const backgroundColor = [0, 1, 2].map((channel) => median(
    borderSamples.map((sample) => sample[channel])
  ));
  const borderDistances = borderSamples
    .map((sample) => colorDistance(sample, backgroundColor))
    .sort((first, second) => first - second);
  const measuredSpread = percentile(borderDistances, 0.7);
  const tolerance = numberOption(
    options.tolerance,
    Math.max(6, Math.min(24, Math.ceil(measuredSpread + 8)))
  );
  const coherenceTolerance = Math.min(32, tolerance + 4);
  const borderCoherence = borderDistances.reduce(
    (count, distance) => count + (distance <= coherenceTolerance ? 1 : 0),
    0
  ) / borderDistances.length;
  const minBorderCoherence = numberOption(options.minBorderCoherence, 0.6);
  if (borderCoherence < minBorderCoherence) {
    return {
      mask: emptyMask,
      stats: {
        applied: false,
        reason: "nonuniform-border",
        backgroundColor,
        tolerance,
        borderCoherence
      }
    };
  }

  const candidates = new Uint8Array(pixelCount);
  let candidatePixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const index = pixel * channels;
    const alpha = channels === 4 ? source[index + 3] : 255;
    const matches = alpha <= 8 || colorDistanceAt(source, index, backgroundColor) <= tolerance;
    if (matches) {
      candidates[pixel] = 1;
      candidatePixels += 1;
    }
  }

  const certainBackground = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const minEnclosedArea = integerOption(
    options.minEnclosedArea,
    Math.max(64, Math.round(pixelCount * 0.00025)),
    1,
    pixelCount
  );
  const maxEnclosedMeanAlpha = byteOption(options.maxEnclosedMeanAlpha, 32);
  const strongAlphaThreshold = byteOption(options.strongAlphaThreshold, 128);
  const maxStrongFraction = numberOption(options.maxStrongFraction, 0.02);
  let vetoPixels = 0;
  let borderComponents = 0;
  let enclosedComponents = 0;

  for (let start = 0; start < pixelCount; start += 1) {
    if (candidates[start] !== 1) continue;
    let head = 0;
    let tail = 0;
    let touchesBorder = false;
    let baseAlphaSum = 0;
    let strongPixels = 0;
    candidates[start] = 2;
    queue[tail++] = start;

    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      touchesBorder ||= x === 0 || y === 0 || x === width - 1 || y === height - 1;
      baseAlphaSum += baseMask[pixel];
      if (baseMask[pixel] >= strongAlphaThreshold) strongPixels += 1;

      visitCandidate(pixel - 1, x > 0);
      visitCandidate(pixel + 1, x + 1 < width);
      visitCandidate(pixel - width, y > 0);
      visitCandidate(pixel + width, y + 1 < height);
    }

    const meanBaseAlpha = baseAlphaSum / tail;
    const strongFraction = strongPixels / tail;
    const isConfidentEnclosedBackground = !touchesBorder &&
      tail >= minEnclosedArea &&
      meanBaseAlpha <= maxEnclosedMeanAlpha &&
      strongFraction <= maxStrongFraction;
    if (!touchesBorder && !isConfidentEnclosedBackground) continue;

    if (touchesBorder) borderComponents += 1;
    else enclosedComponents += 1;
    for (let index = 0; index < tail; index += 1) {
      certainBackground[queue[index]] = 1;
    }
    vetoPixels += tail;

    function visitCandidate(pixel, inBounds) {
      if (!inBounds || candidates[pixel] !== 1) return;
      candidates[pixel] = 2;
      queue[tail++] = pixel;
    }
  }

  return {
    mask: certainBackground,
    stats: {
      applied: vetoPixels > 0,
      backgroundColor,
      tolerance,
      borderCoherence,
      candidatePixels,
      vetoPixels,
      borderComponents,
      enclosedComponents,
      minEnclosedArea
    }
  };
}

export function applyCertainBackgroundVeto(maskBuffer, certainBackgroundBuffer, width, height) {
  const mask = normalizeMask(maskBuffer, width, height, "Mask");
  const certainBackground = normalizeMask(
    certainBackgroundBuffer,
    width,
    height,
    "Certain background mask"
  );
  const output = new Uint8Array(mask);
  for (let pixel = 0; pixel < output.length; pixel += 1) {
    if (certainBackground[pixel]) output[pixel] = 0;
  }
  return output;
}

function isLocalDistanceRidge(distance, x, y, width, height) {
  const pixel = y * width + x;
  const value = distance[pixel];
  if (!Number.isFinite(value) || value < 0.9) return false;
  const opposingPairs = [
    [[-1, 0], [1, 0]],
    [[0, -1], [0, 1]],
    [[-1, -1], [1, 1]],
    [[1, -1], [-1, 1]]
  ];

  // A medial ridge only has to be maximal across the local feature, not
  // along it. This retains the centerline of a one-pixel stem even when the
  // distance field rises toward a thicker flower or body.
  for (const [[firstX, firstY], [secondX, secondY]] of opposingPairs) {
    const first = sampleDistance(distance, x + firstX, y + firstY, width, height);
    const second = sampleDistance(distance, x + secondX, y + secondY, width, height);
    if (first <= value + 0.2 && second <= value + 0.2 && (first < value - 0.2 || second < value - 0.2)) {
      return true;
    }
  }
  return false;
}

function sampleDistance(distance, x, y, width, height) {
  if (x < 0 || y < 0 || x >= width || y >= height) return 0;
  return distance[y * width + x];
}

function sampleOpaqueBorder(source, width, height, channels) {
  const samples = [];
  const stride = Math.max(1, Math.floor((width + height) / 2048));
  const add = (x, y) => {
    const index = (y * width + x) * channels;
    if (channels === 4 && source[index + 3] < 128) return;
    samples.push([source[index], source[index + 1], source[index + 2]]);
  };
  for (let x = 0; x < width; x += stride) {
    add(x, 0);
    if (height > 1) add(x, height - 1);
  }
  for (let y = stride; y + 1 < height; y += stride) {
    add(0, y);
    if (width > 1) add(width - 1, y);
  }
  return samples;
}

function colorDistance(first, second) {
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2]
  );
}

function colorDistanceAt(source, index, color) {
  return Math.hypot(
    source[index] - color[0],
    source[index + 1] - color[1],
    source[index + 2] - color[2]
  );
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(sortedValues, quantile) {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.min(
    sortedValues.length - 1,
    Math.floor((sortedValues.length - 1) * quantile)
  ));
  return sortedValues[index];
}

function visibleBounds(mask, width, height, threshold) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (mask[y * width + x] <= threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return maxX >= minX ? { minX, minY, maxX, maxY } : null;
}

function distanceToImageBoundary(width, height) {
  const distance = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      distance[y * width + x] = Math.min(x + 1, y + 1, width - x, height - y);
    }
  }
  return distance;
}

function normalizeMask(buffer, width, height, label) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new RangeError("Mask dimensions must be positive integers");
  }
  const mask = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (mask.length < width * height) throw new RangeError(`${label} is smaller than its declared dimensions`);
  return mask.length === width * height ? mask : mask.subarray(0, width * height);
}

function squaredDistance(first, second) {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return dx * dx + dy * dy;
}

function byteOption(value, fallback) {
  const parsed = Number(value);
  return Math.max(0, Math.min(255, Math.round(Number.isFinite(parsed) ? parsed : fallback)));
}

function integerOption(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(parsed) ? parsed : fallback)));
}

function numberOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

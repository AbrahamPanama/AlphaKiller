const DEFAULT_TILE_OVERLAP = 192;

export function createSegmentationTiles(width, height, tileSize, overlap = DEFAULT_TILE_OVERLAP) {
  validateDimensions(width, height);
  const normalizedTileSize = positiveInteger(tileSize, "Tile size");
  const normalizedOverlap = Math.max(0, Math.min(
    normalizedTileSize - 1,
    Math.round(Number(overlap) || 0)
  ));
  const xs = tileStarts(width, normalizedTileSize, normalizedOverlap);
  const ys = tileStarts(height, normalizedTileSize, normalizedOverlap);
  const tiles = [];

  for (const y of ys) {
    for (const x of xs) {
      tiles.push({
        x,
        y,
        width: Math.min(normalizedTileSize, width - x),
        height: Math.min(normalizedTileSize, height - y)
      });
    }
  }
  return tiles;
}

export function tileHasMaskSupport(
  maskBuffer,
  fullWidth,
  fullHeight,
  tile,
  threshold = 24
) {
  const mask = normalizeMask(maskBuffer, fullWidth, fullHeight, "Guide mask");
  const supportThreshold = byteOption(threshold, 24);
  for (let y = tile.y; y < tile.y + tile.height; y += 1) {
    const rowStart = y * fullWidth + tile.x;
    const rowEnd = rowStart + tile.width;
    for (let pixel = rowStart; pixel < rowEnd; pixel += 1) {
      if (mask[pixel] >= supportThreshold) return true;
    }
  }
  return false;
}

export function scoreMaskBoundary(
  maskBuffer,
  fullWidth,
  fullHeight,
  tile,
  options = {}
) {
  const mask = normalizeMask(maskBuffer, fullWidth, fullHeight, "Guide mask");
  const softLow = byteOption(options.softLow, 24);
  const softHigh = Math.max(softLow + 1, byteOption(options.softHigh, 232));
  const supportThreshold = byteOption(options.supportThreshold, 32);
  let score = 0;

  for (let y = tile.y; y < tile.y + tile.height; y += 1) {
    for (let x = tile.x; x < tile.x + tile.width; x += 1) {
      const pixel = y * fullWidth + x;
      const alpha = mask[pixel];
      if (alpha > softLow && alpha < softHigh) score += 2;

      const supported = alpha >= supportThreshold;
      if (x > 0 && (mask[pixel - 1] >= supportThreshold) !== supported) score += 3;
      if (y > 0 && (mask[pixel - fullWidth] >= supportThreshold) !== supported) score += 3;
    }
  }

  return score;
}

export function tileHasMaskBoundary(
  maskBuffer,
  fullWidth,
  fullHeight,
  tile,
  options = {}
) {
  const minScore = Math.max(1, Math.round(Number(options.minScore) || 8));
  return scoreMaskBoundary(maskBuffer, fullWidth, fullHeight, tile, options) >= minScore;
}

export function estimateBorderMatteColor(sourceBuffer, width, height, options = {}) {
  validateDimensions(width, height);
  const channels = Math.max(3, Math.round(Number(options.channels) || 4));
  const source = sourceBuffer instanceof Uint8Array || sourceBuffer instanceof Uint8ClampedArray
    ? sourceBuffer
    : new Uint8Array(sourceBuffer);
  if (source.length < width * height * channels) {
    throw new RangeError("Source pixels are smaller than their declared dimensions");
  }

  const perimeter = Math.max(1, width * 2 + height * 2 - 4);
  const stride = Math.max(1, Math.ceil(perimeter / Math.max(64, Number(options.maxSamples) || 4096)));
  const red = [];
  const green = [];
  const blue = [];
  const samples = [];
  const addPixel = (x, y) => {
    const offset = (y * width + x) * channels;
    if (channels >= 4 && source[offset + 3] < 32) return;
    const sample = [source[offset], source[offset + 1], source[offset + 2]];
    samples.push(sample);
    red.push(sample[0]);
    green.push(sample[1]);
    blue.push(sample[2]);
  };

  for (let x = 0; x < width; x += stride) {
    addPixel(x, 0);
    if (height > 1) addPixel(x, height - 1);
  }
  for (let y = stride; y < height - 1; y += stride) {
    addPixel(0, y);
    if (width > 1) addPixel(width - 1, y);
  }

  if (red.length === 0) return null;
  red.sort((a, b) => a - b);
  green.sort((a, b) => a - b);
  blue.sort((a, b) => a - b);
  const color = {
    r: percentile(red, 0.5),
    g: percentile(green, 0.5),
    b: percentile(blue, 0.5)
  };
  const deviations = samples.map((sample) => Math.max(
    Math.abs(sample[0] - color.r),
    Math.abs(sample[1] - color.g),
    Math.abs(sample[2] - color.b)
  )).sort((a, b) => a - b);

  return {
    ...color,
    spread: percentile(deviations, 0.8),
    samples: red.length
  };
}

export function accumulateSegmentationTile(
  tileMaskBuffer,
  tile,
  fullWidth,
  fullHeight,
  accum,
  weights,
  overlap = DEFAULT_TILE_OVERLAP
) {
  validateDimensions(fullWidth, fullHeight);
  const tileMask = normalizeMask(tileMaskBuffer, tile.width, tile.height, "Tile mask");
  const pixelCount = fullWidth * fullHeight;
  if (!(accum instanceof Float32Array) || accum.length !== pixelCount) {
    throw new RangeError("Tile accumulator dimensions do not match the image");
  }
  if (!(weights instanceof Float32Array) || weights.length !== pixelCount) {
    throw new RangeError("Tile weight dimensions do not match the image");
  }

  for (let y = 0; y < tile.height; y += 1) {
    for (let x = 0; x < tile.width; x += 1) {
      const outputIndex = (tile.y + y) * fullWidth + tile.x + x;
      const weight = tileWeight(x, y, tile, fullWidth, fullHeight, overlap);
      accum[outputIndex] += tileMask[y * tile.width + x] * weight;
      weights[outputIndex] += weight;
    }
  }
}

export function finishSegmentationTiles(accum, weights) {
  if (!(accum instanceof Float32Array) || !(weights instanceof Float32Array)) {
    throw new TypeError("Tile accumulators must be Float32Array values");
  }
  if (accum.length !== weights.length) {
    throw new RangeError("Tile accumulator lengths do not match");
  }

  const output = new Uint8Array(accum.length);
  for (let pixel = 0; pixel < output.length; pixel += 1) {
    output[pixel] = Math.round(weights[pixel] > 0 ? accum[pixel] / weights[pixel] : 0);
  }
  return output;
}

export function fuseGuidedSegmentationMasks(
  globalMaskBuffer,
  detailMaskBuffer,
  width,
  height,
  options = {}
) {
  const globalMask = normalizeMask(globalMaskBuffer, width, height, "Global mask");
  const detailMask = normalizeMask(detailMaskBuffer, width, height, "Detail mask");
  const seedThreshold = byteOption(options.seedThreshold, 32);
  const detailThreshold = byteOption(options.detailThreshold, 48);
  const preserveThreshold = Math.max(
    seedThreshold + 1,
    byteOption(options.preserveThreshold, 224)
  );
  const edgeBlend = numberOption(options.edgeBlend, 0.78, 0, 1);
  const matteAwareProtection = options.matteAwareProtection === true;
  const matteTolerance = byteOption(options.matteTolerance, 32);
  const matteBoundaryRadius = integerOption(options.matteBoundaryRadius, 6, 1, 64);
  const detailWeights = options.detailWeights;
  const estimatedMatte = matteAwareProtection && options.sourcePixels
    ? estimateBorderMatteColor(options.sourcePixels, width, height, {
        channels: options.sourceChannels,
        maxSamples: options.maxMatteSamples
      })
    : null;
  const matteColor = options.matteColor || estimatedMatte;
  const matteIsReliable = Boolean(
    matteColor &&
    (!estimatedMatte || estimatedMatte.spread <= numberOption(options.maxMatteSpread, 48, 0, 255))
  );
  const scale = Math.max(width, height) / 1024;
  const recoveryRadius = integerOption(
    options.recoveryRadius,
    Math.max(12, Math.min(64, Math.round(24 * scale))),
    1,
    Math.max(width, height)
  );
  const pixelCount = width * height;
  const accepted = new Uint8Array(pixelCount);
  const distance = new Int16Array(pixelCount);
  distance.fill(-1);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    if (globalMask[pixel] < seedThreshold) continue;
    accepted[pixel] = 1;
    distance[pixel] = 0;
    queue[tail++] = pixel;
  }

  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const nextDistance = distance[pixel] + 1;
    if (nextDistance > recoveryRadius) continue;

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const nextY = y + offsetY;
      if (nextY < 0 || nextY >= height) continue;
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue;
        const nextX = x + offsetX;
        if (nextX < 0 || nextX >= width) continue;
        const nextPixel = nextY * width + nextX;
        if (accepted[nextPixel] || detailMask[nextPixel] < detailThreshold) continue;
        accepted[nextPixel] = 1;
        distance[nextPixel] = nextDistance;
        queue[tail++] = nextPixel;
      }
    }
  }

  const backgroundDistance = matteIsReliable
    ? distanceFromBackground(globalMask, width, height, seedThreshold, matteBoundaryRadius, queue)
    : null;

  const output = new Uint8Array(globalMask);
  let recoveredPixels = 0;
  let contractedPixels = 0;
  let rejectedDetailPixels = 0;
  let protectedForegroundPixels = 0;
  let matteAwareContractions = 0;
  const fadeStart = recoveryRadius * 0.7;

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const globalAlpha = globalMask[pixel];
    const detailAlpha = detailMask[pixel];
    const hasDetail = !detailWeights || detailWeights[pixel] > 0;
    if (!hasDetail) continue;

    if (globalAlpha >= preserveThreshold) {
      const relaxProtection = detailAlpha < globalAlpha &&
        backgroundDistance &&
        backgroundDistance[pixel] > 0 &&
        backgroundDistance[pixel] <= matteBoundaryRadius &&
        sourceMatchesMatte(
          options.sourcePixels,
          pixel,
          options.sourceChannels,
          matteColor,
          matteTolerance
        );
      if (!relaxProtection) {
        if (detailAlpha < globalAlpha) protectedForegroundPixels += 1;
        continue;
      }

      const match = sourceMatteMatch(
        options.sourcePixels,
        pixel,
        options.sourceChannels,
        matteColor,
        matteTolerance
      );
      output[pixel] = clampByte(globalAlpha + (detailAlpha - globalAlpha) * edgeBlend * match);
      if (output[pixel] < globalAlpha) {
        contractedPixels += 1;
        matteAwareContractions += 1;
      }
      continue;
    }
    if (!accepted[pixel]) {
      if (detailAlpha >= detailThreshold && globalAlpha < seedThreshold) {
        rejectedDetailPixels += 1;
      }
      continue;
    }

    if (globalAlpha >= seedThreshold) {
      const confidenceRange = Math.max(1, preserveThreshold - seedThreshold);
      const uncertainty = (preserveThreshold - globalAlpha) / confidenceRange;
      const influence = edgeBlend * Math.max(0, Math.min(1, uncertainty));
      output[pixel] = clampByte(globalAlpha + (detailAlpha - globalAlpha) * influence);
      if (output[pixel] < globalAlpha) contractedPixels += 1;
      else if (output[pixel] > globalAlpha) recoveredPixels += 1;
      continue;
    }

    const recoveryDistance = distance[pixel];
    const fade = recoveryDistance <= fadeStart
      ? 1
      : Math.max(0, (recoveryRadius - recoveryDistance) / Math.max(1, recoveryRadius - fadeStart));
    const recoveredAlpha = clampByte(detailAlpha * fade);
    if (recoveredAlpha > output[pixel]) {
      output[pixel] = recoveredAlpha;
      recoveredPixels += 1;
    }
  }

  return {
    mask: output,
    stats: {
      recoveryRadius,
      recoveredPixels,
      contractedPixels,
      rejectedDetailPixels,
      protectedForegroundPixels,
      matteAwareContractions,
      matteColor: matteIsReliable ? {
        r: matteColor.r,
        g: matteColor.g,
        b: matteColor.b,
        spread: estimatedMatte?.spread ?? 0
      } : null
    }
  };
}

function distanceFromBackground(mask, width, height, threshold, maxDistance, scratchQueue) {
  const connected = new Uint8Array(mask.length);
  const floodQueue = scratchQueue instanceof Int32Array && scratchQueue.length >= mask.length
    ? scratchQueue
    : new Int32Array(mask.length);
  let floodHead = 0;
  let floodTail = 0;
  const seed = (pixel) => {
    if (connected[pixel] || mask[pixel] >= threshold) return;
    connected[pixel] = 1;
    floodQueue[floodTail++] = pixel;
  };

  for (let x = 0; x < width; x += 1) {
    seed(x);
    if (height > 1) seed((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    seed(y * width);
    if (width > 1) seed(y * width + width - 1);
  }

  while (floodHead < floodTail) {
    const pixel = floodQueue[floodHead++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const neighbors = [
      x > 0 ? pixel - 1 : -1,
      x + 1 < width ? pixel + 1 : -1,
      y > 0 ? pixel - width : -1,
      y + 1 < height ? pixel + width : -1
    ];
    for (const nextPixel of neighbors) {
      if (nextPixel >= 0) seed(nextPixel);
    }
  }

  const distance = new Int16Array(mask.length);
  distance.fill(-1);
  const queue = floodQueue;
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!connected[pixel]) continue;
    distance[pixel] = 0;
    queue[tail++] = pixel;
  }

  while (head < tail) {
    const pixel = queue[head++];
    const nextDistance = distance[pixel] + 1;
    if (nextDistance > maxDistance) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const nextY = y + offsetY;
      if (nextY < 0 || nextY >= height) continue;
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue;
        const nextX = x + offsetX;
        if (nextX < 0 || nextX >= width) continue;
        const nextPixel = nextY * width + nextX;
        if (distance[nextPixel] >= 0) continue;
        distance[nextPixel] = nextDistance;
        queue[tail++] = nextPixel;
      }
    }
  }
  return distance;
}

function sourceMatchesMatte(source, pixel, channels, matte, tolerance) {
  return sourceMatteMatch(source, pixel, channels, matte, tolerance) > 0;
}

function sourceMatteMatch(source, pixel, channels, matte, tolerance) {
  if (!source || !matte || tolerance <= 0) return 0;
  const normalizedChannels = Math.max(3, Math.round(Number(channels) || 4));
  const offset = pixel * normalizedChannels;
  const distance = Math.max(
    Math.abs(source[offset] - matte.r),
    Math.abs(source[offset + 1] - matte.g),
    Math.abs(source[offset + 2] - matte.b)
  );
  if (distance >= tolerance) return 0;
  return 1 - smoothstep(distance / tolerance);
}

function tileStarts(size, tileSize, overlap) {
  if (size <= tileSize) return [0];
  const step = Math.max(1, tileSize - overlap);
  const starts = [];
  for (let start = 0; start < size; start += step) {
    starts.push(Math.min(start, size - tileSize));
    if (starts.at(-1) === size - tileSize) break;
  }
  return [...new Set(starts)];
}

function tileWeight(x, y, tile, fullWidth, fullHeight, overlap) {
  return axisWeight(x, tile.x, tile.width, fullWidth, overlap) *
    axisWeight(y, tile.y, tile.height, fullHeight, overlap);
}

function axisWeight(local, tileStart, tileSize, fullSize, overlap) {
  if (overlap <= 0) return 1;
  let weight = 1;
  if (tileStart > 0 && local < overlap) {
    weight *= raisedCosine(local / overlap);
  }
  if (tileStart + tileSize < fullSize && tileSize - 1 - local < overlap) {
    weight *= raisedCosine((tileSize - 1 - local) / overlap);
  }
  return Math.max(0.001, weight);
}

function raisedCosine(value) {
  const normalized = Math.max(0, Math.min(1, value));
  return 0.5 - 0.5 * Math.cos(Math.PI * normalized);
}

function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.min(
    sortedValues.length - 1,
    Math.round((sortedValues.length - 1) * fraction)
  ));
  return sortedValues[index];
}

function smoothstep(value) {
  const normalized = Math.max(0, Math.min(1, value));
  return normalized * normalized * (3 - 2 * normalized);
}

function normalizeMask(buffer, width, height, label) {
  validateDimensions(width, height);
  const mask = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const pixelCount = width * height;
  if (mask.length < pixelCount) {
    throw new RangeError(`${label} is smaller than its declared dimensions`);
  }
  return mask.length === pixelCount ? mask : mask.subarray(0, pixelCount);
}

function validateDimensions(width, height) {
  positiveInteger(width, "Width");
  positiveInteger(height, "Height");
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return parsed;
}

function byteOption(value, fallback) {
  return clampByte(Number.isFinite(Number(value)) ? Number(value) : fallback);
}

function integerOption(value, fallback, min, max) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.round(parsed) : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function numberOption(value, fallback, min, max) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

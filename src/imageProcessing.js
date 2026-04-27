export function applyProcessing(sourceImageData, settings) {
  const working = cloneImageData(sourceImageData);

  if (settings.defringe.enabled) {
    defringe(working, settings.defringe);
  }

  if (settings.bleed.enabled) {
    colorBleed(working, settings.bleed);
  }

  if (settings.threshold.enabled) {
    alphaThreshold(working, settings.threshold);
  }

  if (settings.hardening.enabled) {
    alphaHarden(working, settings.hardening);
  }

  return working;
}

export function affectedPixelStats(original, processed) {
  let changed = 0;
  let semiAlpha = 0;
  const total = original.data.length / 4;

  for (let i = 0; i < original.data.length; i += 4) {
    const a = original.data[i + 3];
    if (a > 0 && a < 255) semiAlpha++;
    if (
      original.data[i] !== processed.data[i] ||
      original.data[i + 1] !== processed.data[i + 1] ||
      original.data[i + 2] !== processed.data[i + 2] ||
      original.data[i + 3] !== processed.data[i + 3]
    ) {
      changed++;
    }
  }

  return {
    total,
    changed,
    semiAlpha,
    changedPct: total ? changed / total : 0,
    semiAlphaPct: total ? semiAlpha / total : 0
  };
}

export function applyMaskToImage(originalImageData, maskBuffer, options = {}) {
  const output = cloneImageData(originalImageData);
  const mask = maskBuffer instanceof Uint8Array ? maskBuffer : new Uint8Array(maskBuffer);
  const pixelCount = originalImageData.width * originalImageData.height;
  const threshold = options.threshold ?? 0;

  if (mask.length < pixelCount) {
    throw new Error("Mask is smaller than the source image");
  }

  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    const maskValue = mask[pixel] < threshold ? 0 : mask[pixel];
    output.data[index + 3] = clampByte((originalImageData.data[index + 3] * maskValue) / 255);
  }

  return output;
}

export function buildTrimap(maskBuffer, width, height, options = {}) {
  const mask = maskBuffer instanceof Uint8Array ? maskBuffer : new Uint8Array(maskBuffer);
  const pixelCount = width * height;
  const bgThresh = options.bgThresh ?? Math.round(0.05 * 255);
  const fgThresh = options.fgThresh ?? Math.round(0.95 * 255);
  const dilateRadius = options.dilateRadius ?? 8;
  const trimap = new Uint8Array(pixelCount);

  if (mask.length < pixelCount) {
    throw new Error("Mask is smaller than the requested trimap dimensions");
  }

  for (let i = 0; i < pixelCount; i++) {
    const value = mask[i];
    trimap[i] = value < bgThresh ? 0 : value >= fgThresh ? 255 : 128;
  }

  return dilateBand(trimap, width, height, 128, dilateRadius);
}

export function dilateBand(buffer, width, height, value, radius) {
  const source = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const pixelCount = width * height;
  const safeRadius = Math.max(0, Math.floor(radius));

  if (source.length < pixelCount) {
    throw new Error("Buffer is smaller than the requested dilation dimensions");
  }

  if (safeRadius === 0) {
    return new Uint8Array(source.slice(0, pixelCount));
  }

  const horizontal = new Uint8Array(pixelCount);
  const output = new Uint8Array(pixelCount);

  for (let y = 0; y < height; y++) {
    let count = 0;
    const row = y * width;

    for (let x = -safeRadius; x <= safeRadius && x < width; x++) {
      if (x >= 0 && source[row + x] === value) count++;
    }

    for (let x = 0; x < width; x++) {
      const index = row + x;
      horizontal[index] = count > 0 ? value : source[index];

      const leaving = x - safeRadius;
      const entering = x + safeRadius + 1;
      if (leaving >= 0 && source[row + leaving] === value) count--;
      if (entering < width && source[row + entering] === value) count++;
    }
  }

  for (let x = 0; x < width; x++) {
    let count = 0;

    for (let y = -safeRadius; y <= safeRadius && y < height; y++) {
      if (y >= 0 && horizontal[y * width + x] === value) count++;
    }

    for (let y = 0; y < height; y++) {
      const index = y * width + x;
      output[index] = count > 0 ? value : horizontal[index];

      const leaving = y - safeRadius;
      const entering = y + safeRadius + 1;
      if (leaving >= 0 && horizontal[leaving * width + x] === value) count--;
      if (entering < height && horizontal[entering * width + x] === value) count++;
    }
  }

  return output;
}

const BLEED_SOURCE_ALPHA = 180;
const BLEED_DISTANCE_INF = 65535;
const BLEED_ORTHOGONAL_WEIGHT = 10;
const BLEED_DIAGONAL_WEIGHT = 14;
const BLEED_DISTANCE_SCALE = 10;
const BLEED_REACH_POTENCY = 3;
const DEFRINGE_STRENGTH_POTENCY = 2;
const MATTE_TOLERANCE_POTENCY = 6;

function cloneImageData(imageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function alphaThreshold(imageData, { threshold, softness }) {
  const data = imageData.data;
  const soft = Math.max(0, softness);
  const low = threshold - soft;
  const high = threshold + soft;

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (soft === 0) {
      data[i + 3] = a >= threshold ? 255 : 0;
    } else if (a <= low) {
      data[i + 3] = 0;
    } else if (a >= high) {
      data[i + 3] = 255;
    } else {
      const t = smoothstep((a - low) / Math.max(1, high - low));
      data[i + 3] = Math.round(t * 255);
    }
  }
}

function alphaHarden(imageData, { strength, midpoint }) {
  const data = imageData.data;
  const amount = strength / 100;
  const mid = midpoint / 100;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha === 0 || alpha === 1) continue;
    const hardened = alpha < mid
      ? alpha * (1 - amount)
      : alpha + (1 - alpha) * amount;
    data[i + 3] = clampByte(hardened * 255);
  }
}

function defringe(imageData, { matteColor, strength, radius, tolerance }) {
  const data = imageData.data;
  const matte = hexToRgb(matteColor);
  const amount = (Math.max(0, strength) / 100) * DEFRINGE_STRENGTH_POTENCY;
  const matteTolerance = Math.max(0, tolerance ?? 255) * MATTE_TOLERANCE_POTENCY;
  const alphaLimit = Math.min(254, 80 + radius * 45);

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0 || a === 255 || a > alphaLimit) continue;

    const alpha = Math.max(1 / 255, a / 255);
    const match = getMatteMatch(data[i], data[i + 1], data[i + 2], matte, matteTolerance);
    if (match <= 0) continue;

    const correction = (1 - alpha) * amount * match;
    data[i] = clampByte(data[i] + ((data[i] - matte.r) * correction));
    data[i + 1] = clampByte(data[i + 1] + ((data[i + 1] - matte.g) * correction));
    data[i + 2] = clampByte(data[i + 2] + ((data[i + 2] - matte.b) * correction));
  }
}

function getMatteMatch(r, g, b, matte, tolerance) {
  const distance = Math.max(
    Math.abs(r - matte.r),
    Math.abs(g - matte.g),
    Math.abs(b - matte.b)
  );
  if (distance === 0) return 1;
  if (tolerance <= 0 || distance >= tolerance) return 0;
  return 1 - smoothstep(distance / tolerance);
}

function colorBleed(imageData, { radius, iterations, affectSemiTransparent, useCustomColor, color }) {
  const { width, height } = imageData;
  const data = imageData.data;
  const pixelCount = width * height;
  const bleedColor = useCustomColor ? hexToRgb(color || "#ffffff") : null;
  const maxDistance = Math.min(
    BLEED_DISTANCE_INF - 1,
    Math.max(1, radius) * Math.max(1, iterations) * BLEED_DISTANCE_SCALE * BLEED_REACH_POTENCY
  );
  const distances = new Uint16Array(pixelCount);
  distances.fill(BLEED_DISTANCE_INF);

  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    if (data[index + 3] >= BLEED_SOURCE_ALPHA) {
      distances[pixel] = 0;
    }
  }

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      relaxBleedPixel(data, distances, row + x, x, y, width, height, maxDistance, affectSemiTransparent, bleedColor, -1);
    }
  }

  for (let y = height - 1; y >= 0; y--) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x--) {
      relaxBleedPixel(data, distances, row + x, x, y, width, height, maxDistance, affectSemiTransparent, bleedColor, 1);
    }
  }
}

function relaxBleedPixel(data, distances, pixel, x, y, width, height, maxDistance, affectSemiTransparent, bleedColor, direction) {
  const index = pixel * 4;
  if (!shouldBleedPixel(data[index + 3], affectSemiTransparent)) return;

  let bestDistance = distances[pixel];
  let sourcePixel = -1;

  if (direction < 0) {
    if (x > 0) {
      const candidate = distances[pixel - 1] + BLEED_ORTHOGONAL_WEIGHT;
      if (candidate < bestDistance && candidate <= maxDistance) {
        bestDistance = candidate;
        sourcePixel = pixel - 1;
      }
    }
    if (y > 0) {
      const top = pixel - width;
      const candidate = distances[top] + BLEED_ORTHOGONAL_WEIGHT;
      if (candidate < bestDistance && candidate <= maxDistance) {
        bestDistance = candidate;
        sourcePixel = top;
      }
      if (x > 0) {
        const diagonal = top - 1;
        const diagonalCandidate = distances[diagonal] + BLEED_DIAGONAL_WEIGHT;
        if (diagonalCandidate < bestDistance && diagonalCandidate <= maxDistance) {
          bestDistance = diagonalCandidate;
          sourcePixel = diagonal;
        }
      }
      if (x + 1 < width) {
        const diagonal = top + 1;
        const diagonalCandidate = distances[diagonal] + BLEED_DIAGONAL_WEIGHT;
        if (diagonalCandidate < bestDistance && diagonalCandidate <= maxDistance) {
          bestDistance = diagonalCandidate;
          sourcePixel = diagonal;
        }
      }
    }
  } else {
    if (x + 1 < width) {
      const candidate = distances[pixel + 1] + BLEED_ORTHOGONAL_WEIGHT;
      if (candidate < bestDistance && candidate <= maxDistance) {
        bestDistance = candidate;
        sourcePixel = pixel + 1;
      }
    }
    if (y + 1 < height) {
      const bottom = pixel + width;
      const candidate = distances[bottom] + BLEED_ORTHOGONAL_WEIGHT;
      if (candidate < bestDistance && candidate <= maxDistance) {
        bestDistance = candidate;
        sourcePixel = bottom;
      }
      if (x + 1 < width) {
        const diagonal = bottom + 1;
        const diagonalCandidate = distances[diagonal] + BLEED_DIAGONAL_WEIGHT;
        if (diagonalCandidate < bestDistance && diagonalCandidate <= maxDistance) {
          bestDistance = diagonalCandidate;
          sourcePixel = diagonal;
        }
      }
      if (x > 0) {
        const diagonal = bottom - 1;
        const diagonalCandidate = distances[diagonal] + BLEED_DIAGONAL_WEIGHT;
        if (diagonalCandidate < bestDistance && diagonalCandidate <= maxDistance) {
          bestDistance = diagonalCandidate;
          sourcePixel = diagonal;
        }
      }
    }
  }

  if (sourcePixel === -1) return;

  const sourceIndex = sourcePixel * 4;
  distances[pixel] = bestDistance;
  data[index] = bleedColor ? bleedColor.r : data[sourceIndex];
  data[index + 1] = bleedColor ? bleedColor.g : data[sourceIndex + 1];
  data[index + 2] = bleedColor ? bleedColor.b : data[sourceIndex + 2];
}

function shouldBleedPixel(alpha, affectSemiTransparent) {
  return alpha === 0 || (affectSemiTransparent && alpha < 128);
}

function smoothstep(value) {
  const x = Math.max(0, Math.min(1, value));
  return x * x * (3 - 2 * x);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255
  };
}

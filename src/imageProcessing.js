export function applyProcessing(sourceImageData, settings) {
  const working = cloneImageData(sourceImageData);

  if (settings.defringe.enabled) {
    defringe(working, settings.defringe);
  }

  if (settings.bleed.enabled) {
    colorBleed(working, settings.bleed);
  }

  if (settings.edgeFinish?.enabled) {
    edgeFinish(working, settings.edgeFinish);
  }

  return working;
}

// Nudge pure white (RGB 255,255,255 — the CMYK 0,0,0,0 paper-white) on visible pixels down to a
// near-white `limit` so RIP software does not read it as a knockout / no-ink (alpha) value.
// Returns a new ImageData; the alpha channel is left untouched.
export function protectPureWhite(imageData, options = {}) {
  const limit = clampByte(options.limit ?? 254);
  const requireVisible = options.requireVisible ?? true;
  const output = cloneImageData(imageData);
  const data = output.data;

  for (let i = 0; i < data.length; i += 4) {
    if (requireVisible && data[i + 3] === 0) continue;
    if (data[i] === 255 && data[i + 1] === 255 && data[i + 2] === 255) {
      data[i] = limit;
      data[i + 1] = limit;
      data[i + 2] = limit;
    }
  }

  return output;
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

export function findVisibleAlphaBounds(imageData, options = {}) {
  const threshold = Math.max(0, Math.min(255, Number(options.threshold ?? 0)));
  const padding = Math.max(0, Math.floor(Number(options.padding ?? 0)));
  let minX = imageData.width;
  let minY = imageData.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < imageData.height; y += 1) {
    for (let x = 0; x < imageData.width; x += 1) {
      const alpha = imageData.data[(y * imageData.width + x) * 4 + 3];
      if (alpha <= threshold) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) return null;

  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(imageData.width - 1, maxX + padding);
  maxY = Math.min(imageData.height - 1, maxY + padding);

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

export function cropImageDataToBounds(imageData, bounds) {
  const x = Math.max(0, Math.floor(Number(bounds?.x ?? 0)));
  const y = Math.max(0, Math.floor(Number(bounds?.y ?? 0)));
  const width = Math.min(imageData.width - x, Math.max(1, Math.floor(Number(bounds?.width ?? imageData.width))));
  const height = Math.min(imageData.height - y, Math.max(1, Math.floor(Number(bounds?.height ?? imageData.height))));
  const output = new ImageData(new Uint8ClampedArray(width * height * 4), width, height);

  for (let row = 0; row < height; row += 1) {
    const sourceStart = ((y + row) * imageData.width + x) * 4;
    const sourceEnd = sourceStart + width * 4;
    output.data.set(imageData.data.slice(sourceStart, sourceEnd), row * width * 4);
  }

  return output;
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
const DEFRINGE_STRENGTH_POTENCY = 2;

function cloneImageData(imageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

// Edge Finishing: binarize alpha at `cutoff` for crisp, print-ready (1-bit) edges, and
// optionally recolor the edge band to a chosen color. With edgeWidth = 0 only the existing
// anti-aliased rim is recolored (silhouette unchanged); edgeWidth > 0 dilates an opaque
// colored keyline outward by that many pixels.
function edgeFinish(imageData, { cutoff, edgeColorEnabled, edgeColor, edgeWidth }) {
  const { width, height, data } = imageData;
  const pixelCount = width * height;
  const cut = clampByte(cutoff ?? 128);

  // Binarized inside-mask of the hard shape.
  const inside = new Uint8Array(pixelCount);
  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    inside[pixel] = data[index + 3] >= cut ? 1 : 0;
  }

  if (!edgeColorEnabled) {
    for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
      data[index + 3] = inside[pixel] ? 255 : 0;
    }
    return;
  }

  const color = hexToRgb(edgeColor || "#000000");
  const grow = Math.max(0, Math.floor(edgeWidth ?? 0));
  // Final opaque shape grows outward by `grow`; the core that keeps art color is eroded 1px.
  const finalMask = grow > 0 ? dilateBand(inside, width, height, 1, grow) : inside;
  const core = erodeMask(inside, width, height, 1);

  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    if (finalMask[pixel]) {
      data[index + 3] = 255;
      if (!core[pixel]) {
        data[index] = color.r;
        data[index + 1] = color.g;
        data[index + 2] = color.b;
      }
    } else {
      data[index + 3] = 0;
    }
  }
}

// Binary erosion via dilation of the complement (erode(M) = ¬dilate(¬M)).
function erodeMask(mask, width, height, radius) {
  const inverted = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inverted[i] = mask[i] ? 0 : 1;
  const dilated = dilateBand(inverted, width, height, 1, radius);
  const output = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) output[i] = dilated[i] ? 0 : 1;
  return output;
}

function defringe(imageData, { matteColor, strength, radius, tolerance }) {
  const data = imageData.data;
  const matte = hexToRgb(matteColor);
  const amount = (Math.max(0, strength) / 100) * DEFRINGE_STRENGTH_POTENCY;
  const matteTolerance = Math.max(0, tolerance ?? 255);
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

function colorBleed(imageData, { reach, affectSemiTransparent, useCustomColor, color }) {
  const { width, height } = imageData;
  const data = imageData.data;
  const pixelCount = width * height;
  const bleedColor = useCustomColor ? hexToRgb(color || "#ffffff") : null;
  // reach is the bleed distance in pixels; one orthogonal pixel step costs BLEED_ORTHOGONAL_WEIGHT.
  const maxDistance = Math.min(
    BLEED_DISTANCE_INF - 1,
    Math.max(1, reach) * BLEED_ORTHOGONAL_WEIGHT
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

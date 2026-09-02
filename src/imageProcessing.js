import { smartEdgePolish } from "./smartEdge.js";

export function applyProcessing(sourceImageData, settings, runtime = {}) {
  let working = cloneImageData(sourceImageData);

  if (
    settings.edgeFinish?.enabled &&
    settings.edgeFinish.treatment === "smart" &&
    runtime.segmentationStages
  ) {
    working = applySegmentationCleanupBalance(
      working,
      runtime.segmentationStages.conservativeAlpha,
      runtime.segmentationStages.aggressiveAlpha,
      settings.edgeFinish.cleanupBalance
    );
  }

  if (settings.defringe.enabled) {
    defringe(working, settings.defringe);
  }

  if (settings.edgeFinish?.enabled) {
    if (settings.edgeFinish.treatment === "smart") {
      working = applySmartEdgeFinish(working, settings.edgeFinish, runtime);
    } else {
      edgeFinish(working, settings.edgeFinish);
    }
  }

  return working;
}

function applySmartEdgeFinish(imageData, settings, runtime) {
  const strength = clampUnit((Number(settings.smartStrength) || 0) / 100);
  const detailProtection = clampUnit((Number(settings.detailProtection) || 0) / 100);
  const cleanupBalance = clampUnit((Number(settings.cleanupBalance) || 0) / 100);
  const rimColorMode = normalizeRimColorMode(settings);
  const rimReach = Math.max(2, normalizeRimWidth(settings.edgeWidth) || 8);
  const polished = smartEdgePolish(imageData, {
    alpha: {
      radius: Math.max(2, Math.round(2 + strength * 6)),
      iterations: strength > 0.72 ? 2 : 1,
      strength,
      detailProtection,
      thinFeatureWidth: Math.max(3, Math.round(4 + detailProtection * 5)),
      thicknessProbeRadius: Math.max(6, rimReach + 2),
      residualSuppression: cleanupBalance
    },
    rim: {
      enabled: rimColorMode === "auto",
      maxDistance: rimReach,
      blend: strength
    }
  }, runtime);

  if (rimColorMode === "solid") {
    applySolidSoftRim(polished, settings.edgeColor, settings.cutoff, rimReach, strength);
  }
  return polished;
}

function applySolidSoftRim(imageData, edgeColor, cutoff, rimReach, strength) {
  const color = hexToRgb(edgeColor || "#000000");
  const maxAlpha = Math.min(254, Math.max(1, clampByte(cutoff ?? 128) + rimReach * 8));
  for (let index = 0; index < imageData.data.length; index += 4) {
    const alpha = imageData.data[index + 3];
    if (alpha <= 0 || alpha > maxAlpha) continue;
    const edgeWeight = (1 - alpha / (maxAlpha + 1)) * strength;
    imageData.data[index] = clampByte(imageData.data[index] + (color.r - imageData.data[index]) * edgeWeight);
    imageData.data[index + 1] = clampByte(imageData.data[index + 1] + (color.g - imageData.data[index + 1]) * edgeWeight);
    imageData.data[index + 2] = clampByte(imageData.data[index + 2] + (color.b - imageData.data[index + 2]) * edgeWeight);
  }
}

function clampUnit(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
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

export function extractAlphaChannel(imageData) {
  if (!imageData || !Number.isInteger(imageData.width) || !Number.isInteger(imageData.height)) {
    throw new TypeError("Expected an ImageData-like object");
  }
  const pixelCount = imageData.width * imageData.height;
  if (!imageData?.data || imageData.data.length < pixelCount * 4) {
    throw new RangeError("Image data is smaller than its declared dimensions");
  }

  const alpha = new Uint8Array(pixelCount);
  for (let pixel = 0, index = 3; pixel < pixelCount; pixel += 1, index += 4) {
    alpha[pixel] = imageData.data[index];
  }
  return alpha;
}

export function applySegmentationCleanupBalance(
  imageData,
  conservativeAlphaBuffer,
  aggressiveAlphaBuffer,
  cleanupBalance = 0
) {
  const output = cloneImageData(imageData);
  const conservativeAlpha = conservativeAlphaBuffer instanceof Uint8Array
    ? conservativeAlphaBuffer
    : new Uint8Array(conservativeAlphaBuffer);
  const aggressiveAlpha = aggressiveAlphaBuffer instanceof Uint8Array
    ? aggressiveAlphaBuffer
    : new Uint8Array(aggressiveAlphaBuffer);
  const pixelCount = imageData.width * imageData.height;

  if (conservativeAlpha.length < pixelCount || aggressiveAlpha.length < pixelCount) {
    throw new RangeError("Segmentation stage alpha is smaller than the image");
  }

  const amount = clampUnit((Number(cleanupBalance) || 0) / 100);
  for (let pixel = 0, index = 3; pixel < pixelCount; pixel += 1, index += 4) {
    const conservative = conservativeAlpha[pixel];
    const aggressive = aggressiveAlpha[pixel];
    const current = imageData.data[index];
    const stageAlpha = clampByte(conservative + (aggressive - conservative) * amount);

    // Manual edits override the generated stage blend in either direction.
    // Delete strokes remain deleted; reconstruct strokes remain restored.
    if (current < conservative) {
      output.data[index] = Math.min(current, stageAlpha);
    } else if (current > conservative) {
      output.data[index] = Math.max(current, stageAlpha);
    } else {
      output.data[index] = stageAlpha;
    }
  }

  return output;
}

export function constrainRefinedMask(baseMaskBuffer, refinedMaskBuffer, options = {}) {
  const baseMask = baseMaskBuffer instanceof Uint8Array
    ? baseMaskBuffer
    : new Uint8Array(baseMaskBuffer);
  const refinedMask = refinedMaskBuffer instanceof Uint8Array
    ? refinedMaskBuffer
    : new Uint8Array(refinedMaskBuffer);

  if (baseMask.length !== refinedMask.length) {
    throw new Error("Base and refined masks must have matching dimensions");
  }

  const backgroundLimit = clampByte(options.backgroundLimit ?? 13);
  const maxAlphaBoost = clampByte(options.maxAlphaBoost ?? 0);
  const output = new Uint8Array(baseMask.length);

  for (let pixel = 0; pixel < output.length; pixel += 1) {
    const baseAlpha = baseMask[pixel];
    if (baseAlpha <= backgroundLimit) {
      output[pixel] = 0;
      continue;
    }

    // Matting may remove uncertain background, but it must not turn the
    // trimap's expanded background band into a new silhouette. A non-zero
    // boost is reserved for explicitly-tested future models.
    const boostScale = 1 - baseAlpha / 255;
    const maxAllowed = Math.min(255, baseAlpha + Math.round(maxAlphaBoost * boostScale));
    output[pixel] = Math.min(refinedMask[pixel], maxAllowed);
  }

  return output;
}

export function cropPaddedMask(maskBuffer, paddedWidth, paddedHeight, contentWidth, contentHeight) {
  const mask = maskBuffer instanceof Uint8Array ? maskBuffer : new Uint8Array(maskBuffer);
  const dimensions = [paddedWidth, paddedHeight, contentWidth, contentHeight];
  if (dimensions.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new RangeError("Mask dimensions must be positive integers");
  }
  if (mask.length < paddedWidth * paddedHeight) {
    throw new RangeError("Padded mask is smaller than its declared dimensions");
  }
  if (contentWidth > paddedWidth || contentHeight > paddedHeight) {
    throw new RangeError("Mask content dimensions exceed the padded mask");
  }

  if (contentWidth === paddedWidth && contentHeight === paddedHeight) {
    return {
      data: new Uint8Array(mask.slice(0, contentWidth * contentHeight)),
      width: contentWidth,
      height: contentHeight
    };
  }

  // ViTMatte pads to its size divisor on the bottom and right. Crop that
  // padding before resizing, otherwise every edge is compressed toward 0,0.
  const output = new Uint8Array(contentWidth * contentHeight);
  for (let y = 0; y < contentHeight; y += 1) {
    const sourceStart = y * paddedWidth;
    output.set(mask.subarray(sourceStart, sourceStart + contentWidth), y * contentWidth);
  }
  return { data: output, width: contentWidth, height: contentHeight };
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

const RIM_DISTANCE_INF = 65535;
const RIM_ORTHOGONAL_WEIGHT = 10;
const RIM_DIAGONAL_WEIGHT = 14;
const AUTO_RIM_STRONG_ALPHA = 180;
const AUTO_RIM_STRONG_EDGE_SOURCE_PENALTY = 16;
const AUTO_RIM_WEAK_SOURCE_PENALTY = 80;
const DEFRINGE_STRENGTH_POTENCY = 2;

function cloneImageData(imageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

// Edge Finishing: binarize alpha at `cutoff` for crisp, print-ready (1-bit) edges,
// then optionally finish the rim with nearby artwork color or a solid swatch.
function edgeFinish(imageData, settings = {}) {
  const { cutoff, edgeColor, edgeWidth } = settings;
  const { width, height, data } = imageData;
  const pixelCount = width * height;
  const cut = Math.min(254, Math.max(1, clampByte(cutoff ?? 128)));
  const rimColorMode = normalizeRimColorMode(settings);

  // Binarized inside-mask of the hard shape.
  const inside = new Uint8Array(pixelCount);
  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    inside[pixel] = data[index + 3] >= cut ? 1 : 0;
  }

  if (rimColorMode === "off") {
    for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
      data[index + 3] = inside[pixel] ? 255 : 0;
    }
    return;
  }

  const grow = normalizeRimWidth(edgeWidth);
  // Final opaque shape grows outward by `grow`; the core that keeps art color is eroded 1px.
  const finalMask = grow > 0 ? dilateBand(inside, width, height, 1, grow) : inside;
  const core = erodeMask(inside, width, height, 1);
  const sourceData = rimColorMode === "auto" ? new Uint8ClampedArray(data) : null;
  const autoSources = sourceData
    ? buildAutoRimSourcePixels(sourceData, width, height, inside, core, finalMask, cut)
    : null;
  const color = rimColorMode === "solid" ? hexToRgb(edgeColor || "#000000") : null;

  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    if (finalMask[pixel]) {
      data[index + 3] = 255;
      if (!core[pixel]) {
        if (color) {
          data[index] = color.r;
          data[index + 1] = color.g;
          data[index + 2] = color.b;
        } else {
          const sourcePixel = autoSources[pixel];
          if (sourcePixel >= 0) {
            const sourceIndex = sourcePixel * 4;
            data[index] = sourceData[sourceIndex];
            data[index + 1] = sourceData[sourceIndex + 1];
            data[index + 2] = sourceData[sourceIndex + 2];
          }
        }
      }
    } else {
      data[index + 3] = 0;
    }
  }
}

function normalizeRimColorMode({ rimColorMode, edgeColorEnabled }) {
  if (rimColorMode === "auto" || rimColorMode === "solid" || rimColorMode === "off") {
    return rimColorMode;
  }
  return edgeColorEnabled ? "solid" : "off";
}

function normalizeRimWidth(edgeWidth) {
  const value = Number(edgeWidth);
  if (!Number.isFinite(value)) return 0;
  return Math.min(16, Math.max(0, Math.floor(value)));
}

function buildAutoRimSourcePixels(sourceData, width, height, inside, core, finalMask, cutoff) {
  const pixelCount = width * height;
  const distances = new Uint16Array(pixelCount);
  const sourcePixels = new Int32Array(pixelCount);
  const minSourceAlpha = Math.max(1, cutoff);
  const strongAlpha = Math.max(minSourceAlpha, AUTO_RIM_STRONG_ALPHA);

  distances.fill(RIM_DISTANCE_INF);
  sourcePixels.fill(-1);

  for (let pixel = 0, index = 0; pixel < pixelCount; pixel++, index += 4) {
    if (!inside[pixel]) continue;

    const alpha = sourceData[index + 3];
    if (alpha < minSourceAlpha) continue;

    let seedDistance = AUTO_RIM_WEAK_SOURCE_PENALTY;
    if (alpha >= strongAlpha) {
      seedDistance = core[pixel] ? 0 : AUTO_RIM_STRONG_EDGE_SOURCE_PENALTY;
    }

    distances[pixel] = seedDistance;
    sourcePixels[pixel] = pixel;
  }

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      relaxAutoRimPixel(distances, sourcePixels, finalMask, row + x, x, y, width, height, -1);
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    const row = y * width;
    for (let x = width - 1; x >= 0; x -= 1) {
      relaxAutoRimPixel(distances, sourcePixels, finalMask, row + x, x, y, width, height, 1);
    }
  }

  return sourcePixels;
}

function relaxAutoRimPixel(distances, sourcePixels, finalMask, pixel, x, y, width, height, direction) {
  if (!finalMask[pixel]) return;

  let bestDistance = distances[pixel];
  let sourcePixel = sourcePixels[pixel];

  if (direction < 0) {
    if (x > 0) {
      const candidatePixel = pixel - 1;
      const candidate = distances[candidatePixel] + RIM_ORTHOGONAL_WEIGHT;
      if (sourcePixels[candidatePixel] >= 0 && candidate < bestDistance) {
        bestDistance = candidate;
        sourcePixel = sourcePixels[candidatePixel];
      }
    }
    if (y > 0) {
      const top = pixel - width;
      const candidate = distances[top] + RIM_ORTHOGONAL_WEIGHT;
      if (sourcePixels[top] >= 0 && candidate < bestDistance) {
        bestDistance = candidate;
        sourcePixel = sourcePixels[top];
      }
      if (x > 0) {
        const diagonal = top - 1;
        const diagonalCandidate = distances[diagonal] + RIM_DIAGONAL_WEIGHT;
        if (sourcePixels[diagonal] >= 0 && diagonalCandidate < bestDistance) {
          bestDistance = diagonalCandidate;
          sourcePixel = sourcePixels[diagonal];
        }
      }
      if (x + 1 < width) {
        const diagonal = top + 1;
        const diagonalCandidate = distances[diagonal] + RIM_DIAGONAL_WEIGHT;
        if (sourcePixels[diagonal] >= 0 && diagonalCandidate < bestDistance) {
          bestDistance = diagonalCandidate;
          sourcePixel = sourcePixels[diagonal];
        }
      }
    }
  } else {
    if (x + 1 < width) {
      const candidatePixel = pixel + 1;
      const candidate = distances[candidatePixel] + RIM_ORTHOGONAL_WEIGHT;
      if (sourcePixels[candidatePixel] >= 0 && candidate < bestDistance) {
        bestDistance = candidate;
        sourcePixel = sourcePixels[candidatePixel];
      }
    }
    if (y + 1 < height) {
      const bottom = pixel + width;
      const candidate = distances[bottom] + RIM_ORTHOGONAL_WEIGHT;
      if (sourcePixels[bottom] >= 0 && candidate < bestDistance) {
        bestDistance = candidate;
        sourcePixel = sourcePixels[bottom];
      }
      if (x + 1 < width) {
        const diagonal = bottom + 1;
        const diagonalCandidate = distances[diagonal] + RIM_DIAGONAL_WEIGHT;
        if (sourcePixels[diagonal] >= 0 && diagonalCandidate < bestDistance) {
          bestDistance = diagonalCandidate;
          sourcePixel = sourcePixels[diagonal];
        }
      }
      if (x > 0) {
        const diagonal = bottom - 1;
        const diagonalCandidate = distances[diagonal] + RIM_DIAGONAL_WEIGHT;
        if (sourcePixels[diagonal] >= 0 && diagonalCandidate < bestDistance) {
          bestDistance = diagonalCandidate;
          sourcePixel = sourcePixels[diagonal];
        }
      }
    }
  }

  distances[pixel] = bestDistance;
  sourcePixels[pixel] = sourcePixel;
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

function defringe(imageData, { matteColor, strength, radius, tolerance, passes, unmix, alphaReach }) {
  const data = imageData.data;
  const matte = hexToRgb(matteColor);
  const amount = (Math.max(0, strength) / 100) * DEFRINGE_STRENGTH_POTENCY;
  const matteTolerance = Math.max(0, tolerance ?? 255);
  const legacyAlphaLimit = Math.min(254, 80 + radius * 45);
  const alphaLimit = Math.min(254, Math.max(1, Number.isFinite(Number(alphaReach))
    ? Math.round(Number(alphaReach))
    : legacyAlphaLimit));
  const physicalUnmix = unmix === true;
  // Each pass recomputes the matte match from the already-corrected colors, so extra passes push
  // stubborn matte residue further out — equivalent to exporting and defringing the file again.
  const passCount = Math.min(5, Math.max(1, Math.round(Number(passes) || 1)));

  for (let pass = 0; pass < passCount; pass += 1) {
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3];
      if (a === 0 || a === 255 || a > alphaLimit) continue;

      const alpha = Math.max(1 / 255, a / 255);
      const match = getMatteMatch(data[i], data[i + 1], data[i + 2], matte, matteTolerance);
      if (match <= 0) continue;

      const correction = physicalUnmix
        ? Math.min(4, (1 - alpha) / alpha) * Math.min(2, Math.max(0, strength) / 100) * match
        : (1 - alpha) * amount * match;
      data[i] = clampByte(data[i] + ((data[i] - matte.r) * correction));
      data[i + 1] = clampByte(data[i + 1] + ((data[i + 1] - matte.g) * correction));
      data[i + 2] = clampByte(data[i + 2] + ((data[i + 2] - matte.b) * correction));
    }
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

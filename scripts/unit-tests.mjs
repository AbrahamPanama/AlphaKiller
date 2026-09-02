import assert from "node:assert/strict";
import UTIF from "utif";

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const {
  applyMaskToImage,
  applySegmentationCleanupBalance,
  buildTrimap,
  constrainRefinedMask,
  cropImageDataToBounds,
  cropPaddedMask,
  dilateBand,
  extractAlphaChannel,
  findVisibleAlphaBounds,
  applyProcessing,
  protectPureWhite
} = await import("../src/imageProcessing.js");
const {
  applyJpegResolution,
  applyPngResolution,
  encodePdfImageData,
  encodeTiffImageData,
  readJpegResolution,
  readPngResolution,
  readTiffResolution
} = await import("../src/imageIO.js");
const {
  contourToSvg,
  traceVectorContour
} = await import("../src/vectorTrace.js");
const {
  applyAdaptiveTrimapLocks,
  applyCertainBackgroundVeto,
  buildAdaptiveStructureTrimap,
  buildCertainBackgroundMask,
  deriveSamPrompts,
  selectSamStructuralMask
} = await import("../src/structureMatting.js");
const {
  accumulateSegmentationTile,
  createSegmentationTiles,
  estimateBorderMatteColor,
  finishSegmentationTiles,
  fuseGuidedSegmentationMasks,
  scoreMaskBoundary,
  tileHasMaskBoundary,
  tileHasMaskSupport
} = await import("../src/tiledSegmentation.js");

function makeImageData(width, height, pixels) {
  return new ImageData(new Uint8ClampedArray(pixels), width, height);
}

function processingSettings(overrides = {}) {
  return {
    defringe: {
      enabled: false,
      matteColor: "#ffffff",
      strength: 0,
      radius: 1,
      tolerance: 255,
      ...(overrides.defringe || {})
    },
    edgeFinish: {
      enabled: false,
      cutoff: 128,
      rimColorMode: "off",
      edgeColor: "#000000",
      edgeWidth: 0,
      ...(overrides.edgeFinish || {})
    }
  };
}

function testApplyMaskToImage() {
  const image = makeImageData(2, 2, [
    10, 20, 30, 255,
    40, 50, 60, 128,
    70, 80, 90, 64,
    1, 2, 3, 200
  ]);
  const mask = new Uint8Array([255, 128, 0, 20]);
  const output = applyMaskToImage(image, mask, { threshold: 16 });

  assert.deepEqual(Array.from(output.data), [
    10, 20, 30, 255,
    40, 50, 60, 64,
    70, 80, 90, 0,
    1, 2, 3, 16
  ]);
}

function testSegmentationCleanupBalanceIsReversibleAndRespectsManualEdits() {
  const image = makeImageData(4, 1, [
    10, 20, 30, 200,
    40, 50, 60, 0,
    70, 80, 90, 255,
    100, 110, 120, 100
  ]);
  const conservative = new Uint8Array([200, 200, 100, 100]);
  const aggressive = new Uint8Array([40, 40, 0, 100]);
  const balanced = applySegmentationCleanupBalance(image, conservative, aggressive, 50);

  assert.deepEqual(Array.from(extractAlphaChannel(balanced)), [120, 0, 255, 100]);
  assert.deepEqual(Array.from(balanced.data.filter((_, index) => index % 4 !== 3)), [
    10, 20, 30,
    40, 50, 60,
    70, 80, 90,
    100, 110, 120
  ]);

  const detail = applySegmentationCleanupBalance(image, conservative, aggressive, 0);
  const clean = applySegmentationCleanupBalance(image, conservative, aggressive, 100);
  assert.deepEqual(Array.from(extractAlphaChannel(detail)), [200, 0, 255, 100]);
  assert.deepEqual(Array.from(extractAlphaChannel(clean)), [40, 0, 255, 100]);
}

function testBuildTrimap() {
  const mask = new Uint8Array([
    0, 12, 13, 128,
    241, 242, 255, 30,
    0, 0, 0, 0,
    255, 255, 255, 255
  ]);
  const trimap = buildTrimap(mask, 4, 4, {
    bgThresh: 13,
    fgThresh: 242,
    dilateRadius: 0
  });

  assert.deepEqual(Array.from(trimap), [
    0, 0, 128, 128,
    128, 255, 255, 128,
    0, 0, 0, 0,
    255, 255, 255, 255
  ]);
}

function testConstrainRefinedMaskPreventsMattingHaloGrowth() {
  const base = new Uint8Array([0, 13, 14, 64, 128, 242, 255]);
  const refined = new Uint8Array([255, 255, 255, 255, 255, 255, 220]);
  const output = constrainRefinedMask(base, refined, {
    backgroundLimit: 13,
    maxAlphaBoost: 0
  });

  assert.deepEqual(Array.from(output), [0, 0, 14, 64, 128, 242, 220]);
  assert.equal(output[0], 0, "refinement must not create alpha outside Stage 1 support");
  assert.equal(output[1], 0, "definite Stage 1 background must remain transparent");
  assert.equal(output[3], base[3], "refinement must not strengthen a soft edge");
  assert.equal(output[6], refined[6], "opaque foreground may still be refined downward");
}

function testCropPaddedMaskRemovesBottomRightPadding() {
  const paddedWidth = 352;
  const paddedHeight = 544;
  const contentWidth = 333;
  const contentHeight = 517;
  const padded = new Uint8Array(paddedWidth * paddedHeight).fill(239);

  for (let y = 0; y < contentHeight; y += 1) {
    for (let x = 0; x < contentWidth; x += 1) {
      padded[y * paddedWidth + x] = (x * 3 + y * 5) % 229;
    }
  }

  const cropped = cropPaddedMask(
    padded,
    paddedWidth,
    paddedHeight,
    contentWidth,
    contentHeight
  );

  assert.equal(cropped.width, contentWidth);
  assert.equal(cropped.height, contentHeight);
  assert.equal(cropped.data.length, contentWidth * contentHeight);
  assert.equal(cropped.data[0], 0);
  assert.equal(
    cropped.data[cropped.data.length - 1],
    ((contentWidth - 1) * 3 + (contentHeight - 1) * 5) % 229
  );
  assert(!cropped.data.includes(239), "ViTMatte padding leaked into the cropped matte");
}

function testDilateBand() {
  const source = new Uint8Array([
    0, 0, 0,
    0, 128, 0,
    0, 0, 0
  ]);
  const output = dilateBand(source, 3, 3, 128, 1);

  assert.deepEqual(Array.from(output), [
    128, 128, 128,
    128, 128, 128,
    128, 128, 128
  ]);
}

function testSamPromptsCoverDistributedForeground() {
  const width = 12;
  const height = 8;
  const mask = new Uint8Array(width * height);
  for (let y = 1; y <= 5; y += 1) {
    for (let x = 1; x <= 4; x += 1) mask[y * width + x] = 255;
  }
  for (let y = 2; y <= 6; y += 1) {
    for (let x = 8; x <= 10; x += 1) mask[y * width + x] = 230;
  }

  const prompts = deriveSamPrompts(mask, width, height, { maxPoints: 8 });
  assert(prompts, "SAM prompts were not generated");
  assert(prompts.points.some((point) => point.x <= 4), "left foreground received no SAM prompt");
  assert(prompts.points.some((point) => point.x >= 8), "right foreground received no SAM prompt");
  assert(prompts.box[0] <= 1 && prompts.box[1] <= 1);
  assert(prompts.box[2] >= 11 && prompts.box[3] >= 7);
}

function testSamStructuralCandidateUsesModelAndStage1Agreement() {
  const width = 5;
  const height = 5;
  const pixelCount = width * height;
  const base = new Uint8Array(pixelCount);
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) base[y * width + x] = 255;
  }
  const logits = new Float32Array(pixelCount * 3).fill(-4);
  // Candidate 0 is an implausibly broad mask despite its acceptable model score.
  logits.fill(2, 0, pixelCount);
  // Candidate 1 agrees with Stage 1.
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) logits[pixelCount + y * width + x] = 3;
  }
  // Candidate 2 collapses to one pixel.
  logits[pixelCount * 2 + 2 * width + 2] = 4;

  const selected = selectSamStructuralMask(
    { data: logits, dims: [1, 1, 3, height, width] },
    { data: new Float32Array([0.72, 0.9, 0.95]) },
    base,
    width,
    height
  );
  assert(selected, "no plausible SAM candidate was selected");
  assert.equal(selected.candidate, 1);
  assert.equal(selected.mask[2 * width + 2], 255);
  assert.equal(selected.mask[0], 0);
}

function testAdaptiveTrimapProtectsHighlightsAndThinStructure() {
  const width = 9;
  const height = 9;
  const base = new Uint8Array(width * height);
  const structure = new Uint8Array(width * height);
  for (let y = 1; y <= 7; y += 1) {
    for (let x = 1; x <= 7; x += 1) {
      base[y * width + x] = 255;
      structure[y * width + x] = 255;
    }
  }

  const highlight = 4 * width + 4;
  const thinTip = 4;
  const baseOnlyDetail = 4 * width;
  const farBackground = 8;
  base[highlight] = 0;
  structure[thinTip] = 255;
  base[thinTip] = 0;
  base[baseOnlyDetail] = 255;

  const { trimap, stats } = buildAdaptiveStructureTrimap(base, structure, width, height, {
    innerRadius: 2,
    outerRadius: 1
  });
  assert.equal(trimap[highlight], 255, "deep structural highlight was not protected");
  assert.equal(trimap[thinTip], 255, "thin structural centerline was eroded");
  assert.equal(trimap[baseOnlyDetail], 128, "model disagreement must remain unknown");
  assert.equal(trimap[farBackground], 0, "distant agreed background was not locked");
  assert(stats.recoveredInterior > 0);
  assert(stats.protectedThinCores > 0);

  const refined = new Uint8Array(width * height).fill(80);
  const locked = applyAdaptiveTrimapLocks(refined, trimap, width, height);
  assert.equal(locked[highlight], 255);
  assert.equal(locked[thinTip], 255);
  assert.equal(locked[baseOnlyDetail], 80);
  assert.equal(locked[farBackground], 0);
}

function testCertainBackgroundVetoUsesColorTopologyAndStage1Confidence() {
  const width = 12;
  const height = 10;
  const source = new Uint8ClampedArray(width * height * 4);
  const base = new Uint8Array(width * height);
  const refined = new Uint8Array(width * height).fill(255);
  const setSource = (x, y, color) => {
    const index = (y * width + x) * 4;
    source[index] = color[0];
    source[index + 1] = color[1];
    source[index + 2] = color[2];
    source[index + 3] = 255;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setSource(x, y, [254, 254, 254]);
  }
  // Colored subject enclosing both a legitimate white highlight and a blank hole.
  for (let y = 2; y <= 8; y += 1) {
    for (let x = 3; x <= 9; x += 1) {
      setSource(x, y, [20, 170, 190]);
      base[y * width + x] = 255;
    }
  }
  const highlight = 4 * width + 4;
  setSource(4, 4, [254, 254, 254]);
  base[highlight] = 255;

  const enclosedHole = [
    4 * width + 7,
    4 * width + 8,
    5 * width + 7,
    5 * width + 8
  ];
  for (const pixel of enclosedHole) {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    setSource(x, y, [254, 254, 254]);
    base[pixel] = 0;
  }

  const petal = 6 * width + 1;
  setSource(1, 6, [245, 105, 170]);
  base[petal] = 255;
  const borderArtifact = width + 10;

  const evidence = buildCertainBackgroundMask(source, base, width, height, {
    channels: 4,
    tolerance: 10,
    minEnclosedArea: 4
  });
  assert.equal(evidence.stats.applied, true);
  assert.equal(evidence.mask[borderArtifact], 1, "border-connected blank field was not vetoed");
  assert.equal(evidence.mask[enclosedHole[0]], 1, "low-confidence enclosed background was not vetoed");
  assert.equal(evidence.mask[highlight], 0, "high-confidence interior highlight was mistaken for background");
  assert.equal(evidence.mask[petal], 0, "detached colored detail was mistaken for background");
  assert.equal(evidence.stats.enclosedComponents, 1);

  const cleaned = applyCertainBackgroundVeto(refined, evidence.mask, width, height);
  assert.equal(cleaned[borderArtifact], 0);
  assert.equal(cleaned[enclosedHole[0]], 0);
  assert.equal(cleaned[highlight], 255);
  assert.equal(cleaned[petal], 255);
}

function testGuidedTileFusionRecoversConnectedDetailWithoutBackgroundIslands() {
  const width = 12;
  const height = 7;
  const globalMask = new Uint8Array(width * height);
  const detailMask = new Uint8Array(width * height);

  for (let y = 2; y <= 4; y += 1) {
    for (let x = 2; x <= 5; x += 1) {
      globalMask[y * width + x] = 255;
      detailMask[y * width + x] = 255;
    }
    globalMask[y * width + 6] = 120;
    detailMask[y * width + 6] = 20;
    detailMask[y * width + 7] = 220;
    detailMask[y * width + 8] = 220;
  }

  const protectedHighlight = 3 * width + 4;
  const uncertainBoundary = 3 * width + 6;
  const connectedExtension = 3 * width + 8;
  const disconnectedArtifact = width + 10;
  detailMask[protectedHighlight] = 0;
  detailMask[disconnectedArtifact] = 255;

  const { mask, stats } = fuseGuidedSegmentationMasks(
    globalMask,
    detailMask,
    width,
    height,
    { recoveryRadius: 3 }
  );

  assert.equal(mask[protectedHighlight], 255, "tile pass erased confident foreground");
  assert(mask[uncertainBoundary] < globalMask[uncertainBoundary], "tile pass did not tighten an uncertain edge");
  assert(mask[connectedExtension] > 180, "connected tile detail was not recovered");
  assert.equal(mask[disconnectedArtifact], 0, "disconnected tile artifact leaked into the subject");
  assert(stats.recoveredPixels > 0);
  assert(stats.contractedPixels > 0);
  assert(stats.rejectedDetailPixels > 0);
  assert(stats.protectedForegroundPixels > 0);
}

function testTileCreationSupportFilteringAndCosineBlend() {
  const width = 5;
  const height = 1;
  const tiles = createSegmentationTiles(width, height, 4, 3);
  assert.deepEqual(tiles, [
    { x: 0, y: 0, width: 4, height: 1 },
    { x: 1, y: 0, width: 4, height: 1 }
  ]);

  const guide = new Uint8Array([0, 0, 0, 200, 0]);
  assert.equal(tileHasMaskSupport(guide, width, height, tiles[0], 24), true);
  assert.equal(tileHasMaskSupport(new Uint8Array(width), width, height, tiles[1], 24), false);

  const accum = new Float32Array(width);
  const weights = new Float32Array(width);
  accumulateSegmentationTile(new Uint8Array(4).fill(100), tiles[0], width, height, accum, weights, 3);
  accumulateSegmentationTile(new Uint8Array(4).fill(200), tiles[1], width, height, accum, weights, 3);
  const blended = finishSegmentationTiles(accum, weights);

  assert.equal(blended[0], 100);
  assert.equal(blended[4], 200);
  assert(blended[1] < blended[2] && blended[2] < blended[3], "tile overlap was not blended smoothly");
  assert(Math.abs(blended[2] - 150) <= 1, "overlap midpoint is not evenly blended");
}

function testBoundaryTileSelectionTargetsOnlySilhouetteDetail() {
  const width = 8;
  const height = 8;
  const guide = new Uint8Array(width * height);
  for (let y = 2; y <= 5; y += 1) {
    for (let x = 2; x <= 5; x += 1) guide[y * width + x] = 255;
  }

  const blank = { x: 0, y: 0, width: 2, height: 2 };
  const interior = { x: 3, y: 3, width: 2, height: 2 };
  const boundary = { x: 1, y: 1, width: 3, height: 3 };
  assert.equal(scoreMaskBoundary(guide, width, height, blank), 0);
  assert.equal(scoreMaskBoundary(guide, width, height, interior), 0);
  assert(scoreMaskBoundary(guide, width, height, boundary) > 0);
  assert.equal(tileHasMaskBoundary(guide, width, height, boundary), true);
  assert.equal(tileHasMaskBoundary(guide, width, height, interior), false);
}

function testMatteAwareProtectionOnlyRelaxesBorderFringe() {
  const width = 7;
  const height = 5;
  const globalMask = new Uint8Array(width * height);
  const detailMask = new Uint8Array(width * height);
  const source = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 2; x <= 4; x += 1) {
      const pixel = y * width + x;
      globalMask[pixel] = 255;
      detailMask[pixel] = 255;
      source[pixel * 4] = 170;
      source[pixel * 4 + 1] = 80;
      source[pixel * 4 + 2] = 120;
    }
  }

  const fringe = 2 * width + 5;
  const interiorWhite = 2 * width + 3;
  const darkEdge = 2 * width + 2;
  globalMask[fringe] = 240;
  detailMask[fringe] = 0;
  source[fringe * 4] = 252;
  source[fringe * 4 + 1] = 252;
  source[fringe * 4 + 2] = 252;
  source[interiorWhite * 4] = 253;
  source[interiorWhite * 4 + 1] = 253;
  source[interiorWhite * 4 + 2] = 253;
  detailMask[interiorWhite] = 0;
  source[darkEdge * 4] = 20;
  source[darkEdge * 4 + 1] = 18;
  source[darkEdge * 4 + 2] = 16;
  detailMask[darkEdge] = 0;

  const matte = estimateBorderMatteColor(source, width, height, { channels: 4 });
  assert.deepEqual([matte.r, matte.g, matte.b], [255, 255, 255]);

  const baseline = fuseGuidedSegmentationMasks(globalMask, detailMask, width, height, {
    recoveryRadius: 3
  });
  const aware = fuseGuidedSegmentationMasks(globalMask, detailMask, width, height, {
    recoveryRadius: 3,
    matteAwareProtection: true,
    matteTolerance: 32,
    matteBoundaryRadius: 1,
    sourcePixels: source,
    sourceChannels: 4
  });

  assert.equal(baseline.mask[fringe], 240, "legacy protection should retain confident fringe");
  assert(aware.mask[fringe] < 240, "matte-aware protection did not contract border fringe");
  assert.equal(aware.mask[interiorWhite], 255, "interior white highlight lost protection");
  assert.equal(aware.mask[darkEdge], 255, "dark subject edge lost protection");
  assert(aware.stats.matteAwareContractions > 0);
}

function testFindVisibleAlphaBoundsAndCrop() {
  const image = makeImageData(4, 3, [
    0, 0, 0, 0,      0, 0, 0, 0,      0, 0, 0, 0,      0, 0, 0, 0,
    0, 0, 0, 0,      10, 20, 30, 255, 40, 50, 60, 128, 0, 0, 0, 0,
    0, 0, 0, 0,      70, 80, 90, 64,  1, 2, 3, 0,      0, 0, 0, 0
  ]);

  const bounds = findVisibleAlphaBounds(image);
  assert.deepEqual(bounds, { x: 1, y: 1, width: 2, height: 2 });

  const cropped = cropImageDataToBounds(image, bounds);
  assert.equal(cropped.width, 2);
  assert.equal(cropped.height, 2);
  assert.deepEqual(Array.from(cropped.data), [
    10, 20, 30, 255,
    40, 50, 60, 128,
    70, 80, 90, 64,
    1, 2, 3, 0
  ]);
}

function testEdgeFinishOffRimColorBinarizesWithoutRecoloring() {
  const image = makeImageData(2, 1, [
    10, 20, 30, 127,
    240, 250, 255, 128
  ]);
  const output = applyProcessing(image, processingSettings({
    edgeFinish: { enabled: true, cutoff: 128, rimColorMode: "off" }
  }));

  // Alpha below cutoff -> 0, at/above cutoff -> 255; colors untouched.
  assert.equal(output.data[3], 0);
  assert.equal(output.data[7], 255);
  assert.deepEqual(Array.from(output.data.slice(4, 7)), [240, 250, 255]);
}

function testEdgeFinishSolidRimColorUsesConfiguredColor() {
  // 5x1: transparent, outer rim, solid core, retained rim, dropped.
  const image = makeImageData(5, 1, [
    200, 100, 50, 0,
    200, 100, 50, 255,
    200, 100, 50, 255,
    200, 100, 50, 200,
    200, 100, 50, 0
  ]);
  const output = applyProcessing(image, processingSettings({
    edgeFinish: { enabled: true, cutoff: 128, rimColorMode: "solid", edgeColor: "#336699", edgeWidth: 0 }
  }));

  // No semi-alpha survives.
  for (let i = 3; i < output.data.length; i += 4) {
    assert.ok(output.data[i] === 0 || output.data[i] === 255);
  }
  // The core keeps its art color, while the retained rim pixel uses the solid rim color.
  assert.deepEqual(Array.from(output.data.slice(8, 12)), [200, 100, 50, 255]);
  assert.deepEqual(Array.from(output.data.slice(12, 16)), [51, 102, 153, 255]);
  // Transparent pixels outside the finished edge stay cut.
  assert.equal(output.data[3], 0);
  assert.equal(output.data[19], 0);
}

function testEdgeFinishAutoRimColorUsesAdjacentVisiblePixel() {
  const image = makeImageData(3, 1, [
    255, 0, 0, 0,       // hidden transparent RGB must not color the rim
    240, 240, 240, 200, // retained rim pixel with dirty matte color
    20, 140, 220, 255   // adjacent visible art color
  ]);
  const output = applyProcessing(image, processingSettings({
    edgeFinish: { enabled: true, cutoff: 128, rimColorMode: "auto", edgeWidth: 0 }
  }));

  assert.equal(output.data[3], 0);
  assert.deepEqual(Array.from(output.data.slice(4, 8)), [20, 140, 220, 255]);
  assert.deepEqual(Array.from(output.data.slice(8, 12)), [20, 140, 220, 255]);
}

function testProtectPureWhite() {
  const image = makeImageData(4, 1, [
    255, 255, 255, 255, // pure white, opaque -> nudged
    255, 255, 255, 0,   // pure white, transparent -> left alone
    255, 255, 254, 255, // not pure white -> untouched
    10, 20, 30, 255     // arbitrary -> untouched
  ]);
  const output = protectPureWhite(image);

  // Source is not mutated.
  assert.equal(image.data[0], 255);
  // Visible pure white becomes 254,254,254; alpha preserved.
  assert.deepEqual(Array.from(output.data.slice(0, 4)), [254, 254, 254, 255]);
  // Transparent pure white is left as-is.
  assert.deepEqual(Array.from(output.data.slice(4, 8)), [255, 255, 255, 0]);
  // Near-white and other colors are untouched.
  assert.deepEqual(Array.from(output.data.slice(8, 12)), [255, 255, 254, 255]);
  assert.deepEqual(Array.from(output.data.slice(12, 16)), [10, 20, 30, 255]);

  // Custom limit.
  const custom = protectPureWhite(makeImageData(1, 1, [255, 255, 255, 255]), { limit: 250 });
  assert.deepEqual(Array.from(custom.data), [250, 250, 250, 255]);
}

function testVectorContourExpandsPastBorder() {
  // 4x4 fully-opaque image: the subject is borderless (touches every edge).
  const size = 4;
  const pixels = [];
  for (let i = 0; i < size * size; i += 1) pixels.push(120, 130, 140, 255);
  const image = makeImageData(size, size, pixels);

  const noOffset = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0, offsetPixels: 0 });
  assert.ok(noOffset.bounds.minX >= 0 && noOffset.bounds.maxX <= size, "no-offset contour should hug the image rect");

  const offset = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0, offsetPixels: 5 });
  // A positive offset must push the contour OUTSIDE the original image bounds.
  assert.ok(offset.bounds.minX < 0, `expected minX < 0, got ${offset.bounds.minX}`);
  assert.ok(offset.bounds.minY < 0, `expected minY < 0, got ${offset.bounds.minY}`);
  assert.ok(offset.bounds.maxX > size, `expected maxX > ${size}, got ${offset.bounds.maxX}`);
  assert.ok(offset.bounds.maxY > size, `expected maxY > ${size}, got ${offset.bounds.maxY}`);
  // width/height stay equal to the image so staleness/identity checks keep working.
  assert.equal(offset.width, size);
  assert.equal(offset.height, size);

  // The exported SVG sizes to the expanded contour with a negative-origin viewBox.
  const svg = contourToSvg(offset, { strokeWidth: 1 });
  const viewBox = svg.match(/viewBox="([^"]+)"/)[1].split(" ").map(Number);
  assert.ok(viewBox[0] < 0 && viewBox[1] < 0, `expected negative viewBox origin, got ${viewBox}`);
  assert.ok(viewBox[2] > size && viewBox[3] > size, `expected expanded viewBox size, got ${viewBox}`);
}

function testDefringeTolerance() {
  const image = makeImageData(2, 1, [
    240, 240, 240, 128,
    20, 90, 180, 128
  ]);
  const output = applyProcessing(image, processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 100, radius: 3, tolerance: 32 }
  }));

  assert.ok(output.data[0] < 240);
  assert.equal(output.data[4], 20);
  assert.equal(output.data[5], 90);
  assert.equal(output.data[6], 180);
}

function testDefringeTolerancePotency() {
  const image = makeImageData(1, 1, [
    0, 0, 0, 128
  ]);
  const output = applyProcessing(image, processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 100, radius: 3, tolerance: 180 }
  }));

  assert.equal(output.data[0], 0);
  assert.equal(output.data[1], 0);
  assert.equal(output.data[2], 0);
}

function testDefringeStrengthPotency() {
  const image = makeImageData(1, 1, [
    200, 200, 200, 128
  ]);
  const output = applyProcessing(image, processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 50, radius: 3, tolerance: 255 }
  }));

  assert.equal(output.data[0], 176);
}

function testDefringePasses() {
  const pixels = [220, 220, 220, 128];
  const run = (passes) => applyProcessing(makeImageData(1, 1, [...pixels]), processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 60, radius: 3, tolerance: 255, passes }
  })).data[0];

  const onePass = run(1);
  const twoPasses = run(2);
  const fivePasses = run(5);

  // Each extra pass pushes the color further from the white matte (darker here).
  assert.ok(onePass < 220, `one pass should correct, got ${onePass}`);
  assert.ok(twoPasses < onePass, `two passes should correct more (${twoPasses} !< ${onePass})`);
  assert.ok(fivePasses < twoPasses, `five passes should correct even more (${fivePasses} !< ${twoPasses})`);

  // Two passes must equal manually defringing an already-defringed image (the export/reimport trick).
  const first = applyProcessing(makeImageData(1, 1, [...pixels]), processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 60, radius: 3, tolerance: 255, passes: 1 }
  }));
  const roundTripped = applyProcessing(first, processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 60, radius: 3, tolerance: 255, passes: 1 }
  }));
  assert.equal(twoPasses, roundTripped.data[0]);

  // Out-of-range values clamp to the 1-5 range.
  assert.equal(run(99), fivePasses);
  assert.equal(run(0), onePass);
}

function testPhysicalMatteUnmixAndOpaqueReach() {
  const pixel = [240, 240, 240, 64];
  const legacy = applyProcessing(makeImageData(1, 1, pixel), processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 100, radius: 4, tolerance: 255, alphaReach: 254, unmix: false }
  }));
  const unmixed = applyProcessing(makeImageData(1, 1, pixel), processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 100, radius: 4, tolerance: 255, alphaReach: 254, unmix: true }
  }));
  assert(unmixed.data[0] < legacy.data[0], "physical unmix should remove more matte from low-alpha color");

  const highAlpha = makeImageData(1, 1, [240, 240, 240, 230]);
  const limited = applyProcessing(highAlpha, processingSettings({
    defringe: { enabled: true, matteColor: "#ffffff", strength: 100, radius: 4, tolerance: 255, alphaReach: 220, unmix: true }
  }));
  assert.deepEqual(Array.from(limited.data), [240, 240, 240, 230]);
}

function testPngResolutionMetadata() {
  const png = minimalPng();
  const output = applyPngResolution(png, { xDpi: 300, yDpi: 150 });
  const resolution = readPngResolution(output);

  assert.equal(Math.round(resolution.xDpi), 300);
  assert.equal(Math.round(resolution.yDpi), 150);
}

function testJpegResolutionMetadata() {
  const jpeg = minimalJpeg();
  const output = applyJpegResolution(jpeg, { xDpi: 300, yDpi: 150 });
  const resolution = readJpegResolution(output);

  assert.equal(Math.round(resolution.xDpi), 300);
  assert.equal(Math.round(resolution.yDpi), 150);
}

function testTiffExportPreservesAlphaAndResolution() {
  const image = makeImageData(2, 1, [
    10, 20, 30, 255,
    40, 50, 60, 64
  ]);
  const tiff = encodeTiffImageData(image, { xDpi: 300, yDpi: 150 });
  const ifds = UTIF.decode(tiff);
  assert.equal(ifds.length, 1);
  assert.equal(ifds[0].t296[0], 2);
  assert.equal(ifds[0].t338[0], 2);

  const resolution = readTiffResolution(ifds[0]);
  assert.equal(Math.round(resolution.xDpi), 300);
  assert.equal(Math.round(resolution.yDpi), 150);

  UTIF.decodeImage(tiff, ifds[0]);
  const rgba = UTIF.toRGBA8(ifds[0]);
  assert.deepEqual(Array.from(rgba), [
    10, 20, 30, 255,
    40, 50, 60, 64
  ]);
}

function testPdfExportUsesWorkingResolutionAndAlpha() {
  const image = makeImageData(2, 1, [
    10, 20, 30, 255,
    40, 50, 60, 64
  ]);
  const pdf = encodePdfImageData(image, {
    resolution: { xDpi: 300, yDpi: 150 }
  });
  const text = new TextDecoder("latin1").decode(pdf);

  assert.ok(text.startsWith("%PDF-1.4"));
  assert.ok(text.includes("/SMask"));
  assert.ok(text.includes("/Width 2 /Height 1"));
  assert.ok(text.includes("/MediaBox [0 0 0.48 0.48]"));
}

function testPdfExportCanIncludeVectorContour() {
  const image = makeImageData(1, 1, [255, 255, 255, 255]);
  const contour = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0 });
  const pdf = encodePdfImageData(image, {
    resolution: { xDpi: 72, yDpi: 72 },
    contour,
    contourStroke: "#112233"
  });
  const text = new TextDecoder("latin1").decode(pdf);

  assert.ok(text.includes("0.06667 0.13333 0.2 RG"));
  assert.ok(text.includes(" m\n"));
  assert.ok(text.includes(" l\n"));
  assert.ok(text.includes("\nh\nS\nQ"));
}

function testPdfExportCanIncludeCurvedVectorContour() {
  const image = makeImageData(2, 2, [
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255
  ]);
  const contour = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 6 });
  const pdf = encodePdfImageData(image, {
    resolution: { xDpi: 72, yDpi: 72 },
    contour,
    contourStroke: "#112233"
  });
  const text = new TextDecoder("latin1").decode(pdf);

  assert.ok(contour.paths[0].curves.length > 0);
  assert.ok(contour.paths[0].d.includes(" C "));
  assert.ok(text.includes(" c\n"));
}

function testVectorContourSinglePixel() {
  const image = makeImageData(3, 3, [
    0, 0, 0, 0,    0, 0, 0, 0,      0, 0, 0, 0,
    0, 0, 0, 0,    255, 255, 255, 255, 0, 0, 0, 0,
    0, 0, 0, 0,    0, 0, 0, 0,      0, 0, 0, 0
  ]);

  const contour = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0 });
  assert.equal(contour.pathCount, 1);
  assert.equal(contour.paths[0].area, 1);
  assert.deepEqual(boundsForPoints(contour.paths[0].points), { minX: 1, minY: 1, maxX: 2, maxY: 2 });
}

function testVectorContourUsesThreshold() {
  const image = makeImageData(2, 1, [
    255, 255, 255, 16,
    255, 255, 255, 17
  ]);

  const contour = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0 });
  assert.equal(contour.pathCount, 1);
  assert.deepEqual(boundsForPoints(contour.paths[0].points), { minX: 1, minY: 0, maxX: 2, maxY: 1 });
}

function testVectorContourSvg() {
  const image = makeImageData(1, 1, [255, 255, 255, 255]);
  const contour = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0 });
  const svg = contourToSvg(contour, { stroke: "#112233", title: "Test contour" });
  assert.ok(svg.includes('viewBox="0 0 1 1"'));
  assert.ok(svg.includes('stroke="#112233"'));
  assert.ok(svg.includes("<path"));
}

function testVectorContourSvgUsesCurvesWhenSmoothed() {
  const image = makeImageData(2, 2, [
    255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255, 255, 255, 255, 255, 255
  ]);
  const contour = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 6 });
  const svg = contourToSvg(contour, { stroke: "#112233", title: "Curved contour" });

  assert.ok(contour.paths[0].curves.length > 0);
  assert.ok(svg.includes(" C "));
}

function testVectorContourOffset() {
  const image = makeImageData(5, 5, [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0,
    0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0,
    0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ]);

  const base = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0 });
  const expanded = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0, offsetPixels: 1 });
  const contracted = traceVectorContour(image, { alphaThreshold: 16, simplifyTolerance: 0, offsetPixels: -1 });

  assert.ok(expanded.paths[0].area > base.paths[0].area);
  assert.ok(contracted.paths[0].area < base.paths[0].area);
}

function minimalPng() {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01,
    0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44,
    0x00, 0x00, 0x00, 0x00
  ]);
}

function boundsForPoints(points) {
  return points.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y)
  }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
}

function minimalJpeg() {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xd9
  ]);
}

testApplyMaskToImage();
testSegmentationCleanupBalanceIsReversibleAndRespectsManualEdits();
testBuildTrimap();
testConstrainRefinedMaskPreventsMattingHaloGrowth();
testCropPaddedMaskRemovesBottomRightPadding();
testDilateBand();
testSamPromptsCoverDistributedForeground();
testSamStructuralCandidateUsesModelAndStage1Agreement();
testAdaptiveTrimapProtectsHighlightsAndThinStructure();
testCertainBackgroundVetoUsesColorTopologyAndStage1Confidence();
testGuidedTileFusionRecoversConnectedDetailWithoutBackgroundIslands();
testTileCreationSupportFilteringAndCosineBlend();
testBoundaryTileSelectionTargetsOnlySilhouetteDetail();
testMatteAwareProtectionOnlyRelaxesBorderFringe();
testFindVisibleAlphaBoundsAndCrop();
testEdgeFinishOffRimColorBinarizesWithoutRecoloring();
testEdgeFinishSolidRimColorUsesConfiguredColor();
testEdgeFinishAutoRimColorUsesAdjacentVisiblePixel();
testProtectPureWhite();
testDefringeTolerance();
testDefringeTolerancePotency();
testDefringeStrengthPotency();
testDefringePasses();
testPhysicalMatteUnmixAndOpaqueReach();
testPngResolutionMetadata();
testJpegResolutionMetadata();
testTiffExportPreservesAlphaAndResolution();
testPdfExportUsesWorkingResolutionAndAlpha();
testPdfExportCanIncludeVectorContour();
testPdfExportCanIncludeCurvedVectorContour();
testVectorContourSinglePixel();
testVectorContourUsesThreshold();
testVectorContourSvg();
testVectorContourSvgUsesCurvesWhenSmoothed();
testVectorContourOffset();
testVectorContourExpandsPastBorder();

console.log("Unit tests passed.");

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
  buildTrimap,
  cropImageDataToBounds,
  dilateBand,
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
testBuildTrimap();
testDilateBand();
testFindVisibleAlphaBoundsAndCrop();
testEdgeFinishOffRimColorBinarizesWithoutRecoloring();
testEdgeFinishSolidRimColorUsesConfiguredColor();
testEdgeFinishAutoRimColorUsesAdjacentVisiblePixel();
testProtectPureWhite();
testDefringeTolerance();
testDefringeTolerancePotency();
testDefringeStrengthPotency();
testDefringePasses();
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

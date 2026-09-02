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
  dilateBand,
  applyProcessing
} = await import("../src/imageProcessing.js");
const {
  applyPngResolution,
  encodeTiffImageData,
  readPngResolution,
  readTiffResolution
} = await import("../src/imageIO.js");
const {
  removeBackgroundWithPhotoroomApi
} = await import("../electron/backgroundRemoval/photoroomApiProvider.js");

function makeImageData(width, height, pixels) {
  return new ImageData(new Uint8ClampedArray(pixels), width, height);
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

function testAlphaThresholdProcessing() {
  const image = makeImageData(2, 1, [
    0, 0, 0, 127,
    255, 255, 255, 128
  ]);
  const output = applyProcessing(image, {
    defringe: { enabled: false, matteColor: "#ffffff", strength: 0, radius: 1 },
    bleed: { enabled: false, radius: 1, iterations: 1, affectSemiTransparent: false },
    threshold: { enabled: true, threshold: 128, softness: 0 },
    hardening: { enabled: false, strength: 0, midpoint: 50 }
  });

  assert.equal(output.data[3], 0);
  assert.equal(output.data[7], 255);
}

function testDefringeTolerance() {
  const image = makeImageData(2, 1, [
    240, 240, 240, 128,
    20, 90, 180, 128
  ]);
  const output = applyProcessing(image, {
    defringe: { enabled: true, matteColor: "#ffffff", strength: 100, radius: 3, tolerance: 32 },
    bleed: { enabled: false, radius: 1, iterations: 1, affectSemiTransparent: false },
    threshold: { enabled: false, threshold: 128, softness: 0 },
    hardening: { enabled: false, strength: 0, midpoint: 50 }
  });

  assert.ok(output.data[0] < 240);
  assert.equal(output.data[4], 20);
  assert.equal(output.data[5], 90);
  assert.equal(output.data[6], 180);
}

function testDefringeTolerancePotency() {
  const image = makeImageData(1, 1, [
    0, 0, 0, 128
  ]);
  const output = applyProcessing(image, {
    defringe: { enabled: true, matteColor: "#ffffff", strength: 100, radius: 3, tolerance: 180 },
    bleed: { enabled: false, radius: 1, iterations: 1, affectSemiTransparent: false },
    threshold: { enabled: false, threshold: 128, softness: 0 },
    hardening: { enabled: false, strength: 0, midpoint: 50 }
  });

  assert.equal(output.data[0], 0);
  assert.equal(output.data[1], 0);
  assert.equal(output.data[2], 0);
}

function testDefringeStrengthPotency() {
  const image = makeImageData(1, 1, [
    200, 200, 200, 128
  ]);
  const output = applyProcessing(image, {
    defringe: { enabled: true, matteColor: "#ffffff", strength: 50, radius: 3, tolerance: 255 },
    bleed: { enabled: false, radius: 1, iterations: 1, affectSemiTransparent: false },
    threshold: { enabled: false, threshold: 128, softness: 0 },
    hardening: { enabled: false, strength: 0, midpoint: 50 }
  });

  assert.equal(output.data[0], 173);
}

function testColorBleedReachPotency() {
  const image = makeImageData(5, 1, [
    10, 20, 30, 255,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0
  ]);
  const output = applyProcessing(image, {
    defringe: { enabled: false, matteColor: "#ffffff", strength: 0, radius: 1, tolerance: 255 },
    bleed: { enabled: true, radius: 1, iterations: 1, affectSemiTransparent: false, useCustomColor: false, color: "#ffffff" },
    threshold: { enabled: false, threshold: 128, softness: 0 },
    hardening: { enabled: false, strength: 0, midpoint: 50 }
  });

  assert.deepEqual(Array.from(output.data.slice(12, 15)), [10, 20, 30]);
  assert.deepEqual(Array.from(output.data.slice(16, 19)), [0, 0, 0]);
}

function testColorBleedCustomColor() {
  const image = makeImageData(2, 1, [
    10, 20, 30, 255,
    0, 0, 0, 0
  ]);
  const output = applyProcessing(image, {
    defringe: { enabled: false, matteColor: "#ffffff", strength: 0, radius: 1, tolerance: 255 },
    bleed: { enabled: true, radius: 1, iterations: 1, affectSemiTransparent: false, useCustomColor: true, color: "#336699" },
    threshold: { enabled: false, threshold: 128, softness: 0 },
    hardening: { enabled: false, strength: 0, midpoint: 50 }
  });

  assert.deepEqual(Array.from(output.data.slice(4, 8)), [51, 102, 153, 0]);
}

function testPngResolutionMetadata() {
  const png = minimalPng();
  const output = applyPngResolution(png, { xDpi: 300, yDpi: 150 });
  const resolution = readPngResolution(output);

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

async function testPhotoroomProviderRequest() {
  const source = minimalPng(2, 3);
  let capturedUrl = "";
  let capturedOptions = null;

  const result = await removeBackgroundWithPhotoroomApi({
    pngBytes: source,
    apiToken: "test-photoroom-key",
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return new Response(minimalPng(2, 3), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-request-id": "request-123"
        }
      });
    }
  });

  assert.equal(capturedUrl, "https://sdk.photoroom.com/v1/segment");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers["x-api-key"], "test-photoroom-key");
  assert.equal(capturedOptions.body.get("format"), "png");
  assert.equal(capturedOptions.body.get("channels"), "rgba");
  assert.equal(capturedOptions.body.get("size"), "full");
  assert.equal(capturedOptions.body.get("crop"), "false");

  const uploadedImage = capturedOptions.body.get("image_file");
  assert.ok(uploadedImage instanceof Blob);
  assert.equal(uploadedImage.type, "image/png");
  assert.equal(uploadedImage.size, source.byteLength);
  assert.equal(result.provider, "photoroom-api");
  assert.equal(result.width, 2);
  assert.equal(result.height, 3);
  assert.equal(result.requestId, "request-123");
}

async function testPhotoroomProviderRejectsDimensionChanges() {
  await assert.rejects(
    removeBackgroundWithPhotoroomApi({
      pngBytes: minimalPng(2, 3),
      apiToken: "test-photoroom-key",
      fetchImpl: async () => new Response(minimalPng(3, 2), { status: 200 })
    }),
    /returned 3 x 2, but AlphaKiller sent 2 x 3/
  );
}

function minimalPng(width = 1, height = 1) {
  const bytes = new Uint8Array([
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
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

testApplyMaskToImage();
testBuildTrimap();
testDilateBand();
testAlphaThresholdProcessing();
testDefringeTolerance();
testDefringeTolerancePotency();
testDefringeStrengthPotency();
testColorBleedReachPotency();
testColorBleedCustomColor();
testPngResolutionMetadata();
testTiffExportPreservesAlphaAndResolution();
await testPhotoroomProviderRequest();
await testPhotoroomProviderRejectsDimensionChanges();

console.log("Unit tests passed.");

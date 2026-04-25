import assert from "node:assert/strict";

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

testApplyMaskToImage();
testBuildTrimap();
testDilateBand();
testAlphaThresholdProcessing();

console.log("Unit tests passed.");

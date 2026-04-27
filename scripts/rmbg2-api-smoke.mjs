import assert from "node:assert/strict";
import zlib from "node:zlib";
import { removeBackgroundWithBriaApi } from "../electron/backgroundRemoval/briaApiProvider.js";

if (!process.env.BRIA_API_TOKEN && !process.env.ALPHAKILLER_BRIA_API_TOKEN) {
  throw new Error("Set BRIA_API_TOKEN before running this diagnostic.");
}

const size = Number(process.env.RMBG2_API_SMOKE_SIZE || 192);
const inputPng = makeSmokePng(size, size);
const startedAt = performance.now();

const result = await removeBackgroundWithBriaApi({
  pngBytes: inputPng.buffer.slice(inputPng.byteOffset, inputPng.byteOffset + inputPng.byteLength),
  preserveAlpha: process.env.BRIA_PRESERVE_ALPHA !== "false"
});

const output = Buffer.from(result.pngBytes);
assertPng(output);
assertHasAlpha(output);

console.log("BRIA RMBG-2.0 API smoke passed.");
console.log(`Request: ${result.requestId || "n/a"}`);
console.log(`Duration: ${result.durationMs || Math.round(performance.now() - startedAt)}ms`);
console.log(`Preserve alpha: ${process.env.BRIA_PRESERVE_ALPHA === "false" ? "false" : "true"}`);
console.log(`Input: ${size}x${size}, ${inputPng.byteLength} bytes`);
console.log(`Output: ${result.width}x${result.height}, ${output.byteLength} bytes`);

function makeSmokePng(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const grid = ((Math.floor(x / 18) + Math.floor(y / 18)) % 2) * 28;
      rgba[i] = 204 + grid;
      rgba[i + 1] = 218 + grid;
      rgba[i + 2] = 232 + grid;
      rgba[i + 3] = 255;

      if (ellipse(x, y, cx, cy + 28, 44, 58)) {
        rgba[i] = 26;
        rgba[i + 1] = 126;
        rgba[i + 2] = 168;
      }

      if (ellipse(x, y, cx, cy - 24, 34, 38)) {
        rgba[i] = 223;
        rgba[i + 1] = 149;
        rgba[i + 2] = 104;
      }

      if (ellipse(x, y, cx - 2, cy - 40, 38, 20) && y < cy - 18) {
        rgba[i] = 56;
        rgba[i + 1] = 38;
        rgba[i + 2] = 34;
      }
    }
  }

  return encodePng(width, height, rgba);
}

function ellipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    scanlines[rowStart] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(scanlines, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk("IDAT", zlib.deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function assertPng(bytes) {
  assert.deepEqual(Array.from(bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
}

function assertHasAlpha(bytes) {
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6 || hasChunk(bytes, "tRNS")) return;
  throw new Error(`Expected PNG with alpha, got color type ${colorType}.`);
}

function hasChunk(bytes, chunkType) {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === chunkType) return true;
    offset += 12 + length;
  }
  return false;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data])))
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

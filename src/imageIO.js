import UTIF from "utif";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const INCHES_PER_METER = 39.37007874015748;

let crcTable = null;

export function readPngResolution(buffer) {
  const data = toUint8Array(buffer);
  if (!hasPngSignature(data)) return null;

  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = readUint32(data, offset);
    const type = readAscii(data, offset + 4, 4);
    const chunkDataOffset = offset + 8;
    const nextOffset = chunkDataOffset + length + 4;
    if (nextOffset > data.length) return null;

    if (type === "pHYs" && length === 9) {
      const unit = data[chunkDataOffset + 8];
      if (unit !== 1) return null;
      const xPixelsPerMeter = readUint32(data, chunkDataOffset);
      const yPixelsPerMeter = readUint32(data, chunkDataOffset + 4);
      return normalizeResolution({
        xDpi: xPixelsPerMeter / INCHES_PER_METER,
        yDpi: yPixelsPerMeter / INCHES_PER_METER,
        source: "PNG pHYs"
      });
    }

    offset = nextOffset;
  }

  return null;
}

export function readTiffResolution(ifd) {
  const xResolution = ifd?.t282?.[0];
  const yResolution = ifd?.t283?.[0];
  if (!Number.isFinite(xResolution) || !Number.isFinite(yResolution) || xResolution <= 0 || yResolution <= 0) {
    return null;
  }

  const unit = ifd?.t296?.[0] ?? 2;
  if (unit === 2) {
    return normalizeResolution({ xDpi: xResolution, yDpi: yResolution, source: "TIFF" });
  }

  if (unit === 3) {
    return normalizeResolution({ xDpi: xResolution * 2.54, yDpi: yResolution * 2.54, source: "TIFF" });
  }

  return null;
}

export function applyPngResolution(buffer, resolution) {
  const data = toUint8Array(buffer);
  if (!hasPngSignature(data)) {
    throw new Error("Expected PNG bytes.");
  }

  const chunks = [data.slice(0, 8)];
  const resolutionChunk = resolution ? createPhysChunk(resolution) : null;
  let insertedResolution = false;
  let offset = 8;

  while (offset + 12 <= data.length) {
    const length = readUint32(data, offset);
    const type = readAscii(data, offset + 4, 4);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > data.length) break;

    if (type !== "pHYs") {
      chunks.push(data.slice(offset, chunkEnd));
    }

    if (type === "IHDR" && resolutionChunk) {
      chunks.push(resolutionChunk);
      insertedResolution = true;
    }

    offset = chunkEnd;
  }

  if (resolutionChunk && !insertedResolution) {
    chunks.splice(1, 0, resolutionChunk);
  }

  return concatUint8Arrays(chunks).buffer;
}

export function encodeTiffImageData(imageData, resolution) {
  const rgba = new Uint8Array(
    imageData.data.buffer.slice(
      imageData.data.byteOffset,
      imageData.data.byteOffset + imageData.data.byteLength
    )
  );
  const metadata = {
    t305: ["AlphaKiller"],
    // Canvas ImageData stores straight alpha. TIFF tag 338 value 2 means unassociated alpha.
    t338: [2]
  };

  if (resolution) {
    metadata.t282 = [resolution.xDpi];
    metadata.t283 = [resolution.yDpi];
    metadata.t296 = [2];
  } else {
    metadata.t282 = [1];
    metadata.t283 = [1];
    metadata.t296 = [1];
  }

  return UTIF.encodeImage(rgba.buffer, imageData.width, imageData.height, metadata);
}

export function formatResolution(resolution) {
  if (!resolution) return "-";
  const x = formatDpiValue(resolution.xDpi);
  const y = formatDpiValue(resolution.yDpi);
  return x === y ? `${x} DPI` : `${x} x ${y} DPI`;
}

function normalizeResolution(resolution) {
  const xDpi = Number(resolution.xDpi);
  const yDpi = Number(resolution.yDpi);
  if (!Number.isFinite(xDpi) || !Number.isFinite(yDpi) || xDpi <= 0 || yDpi <= 0) {
    return null;
  }
  return {
    xDpi,
    yDpi,
    source: resolution.source || "metadata"
  };
}

function createPhysChunk(resolution) {
  const xPixelsPerMeter = Math.max(1, Math.round(resolution.xDpi * INCHES_PER_METER));
  const yPixelsPerMeter = Math.max(1, Math.round(resolution.yDpi * INCHES_PER_METER));
  const data = new Uint8Array(9);
  writeUint32(data, 0, xPixelsPerMeter);
  writeUint32(data, 4, yPixelsPerMeter);
  data[8] = 1;
  return createPngChunk("pHYs", data);
}

function createPngChunk(type, payload) {
  const typeBytes = asciiBytes(type);
  const chunk = new Uint8Array(12 + payload.length);
  writeUint32(chunk, 0, payload.length);
  chunk.set(typeBytes, 4);
  chunk.set(payload, 8);
  writeUint32(chunk, 8 + payload.length, crc32(chunk, 4, 4 + payload.length));
  return chunk;
}

function crc32(data, offset, length) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }

  let c = 0xffffffff;
  for (let i = offset; i < offset + length; i += 1) {
    c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function concatUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function hasPngSignature(data) {
  if (data.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => data[index] === byte);
}

function toUint8Array(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) {
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }
  throw new Error("Expected ArrayBuffer or typed array bytes.");
}

function readAscii(data, offset, length) {
  let value = "";
  for (let i = 0; i < length; i += 1) {
    value += String.fromCharCode(data[offset + i]);
  }
  return value;
}

function asciiBytes(text) {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[i] = text.charCodeAt(i);
  }
  return bytes;
}

function readUint32(data, offset) {
  return (
    data[offset] * 0x1000000 +
    ((data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3])
  ) >>> 0;
}

function writeUint32(data, offset, value) {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

function formatDpiValue(value) {
  return Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
}

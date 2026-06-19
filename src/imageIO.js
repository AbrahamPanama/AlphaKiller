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

export function readJpegResolution(buffer) {
  const data = toUint8Array(buffer);
  if (!hasJpegSignature(data)) return null;

  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) break;
    while (data[offset] === 0xff) offset += 1;
    const marker = data[offset];
    offset += 1;

    if (marker === 0xda || marker === 0xd9) break;
    if (isStandaloneJpegMarker(marker)) continue;
    if (offset + 2 > data.length) break;

    const length = readUint16(data, offset);
    const payloadOffset = offset + 2;
    const nextOffset = offset + length;
    if (length < 2 || nextOffset > data.length) break;

    if (marker === 0xe0) {
      const jfif = readJfifResolution(data, payloadOffset, length - 2);
      if (jfif) return jfif;
    }

    if (marker === 0xe1) {
      const exif = readExifResolution(data, payloadOffset, length - 2);
      if (exif) return exif;
    }

    offset = nextOffset;
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

export function applyJpegResolution(buffer, resolution) {
  const data = toUint8Array(buffer);
  if (!hasJpegSignature(data)) {
    throw new Error("Expected JPEG bytes.");
  }

  if (!resolution) {
    return data.slice().buffer;
  }

  const jfifChunk = createJfifChunk(resolution);
  let restOffset = 2;
  if (data[2] === 0xff && data[3] === 0xe0 && data.length >= 6) {
    const length = readUint16(data, 4);
    const segmentEnd = 4 + length;
    if (segmentEnd <= data.length && isJfifSegment(data, 6, length - 2)) {
      restOffset = segmentEnd;
    }
  }

  return concatUint8Arrays([
    data.slice(0, 2),
    jfifChunk,
    data.slice(restOffset)
  ]).buffer;
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

export function encodePdfImageData(imageData, options = {}) {
  const fallbackDpi = Math.max(1, Number(options.fallbackDpi || options.dpi || 300));
  const resolution = normalizePdfResolution(options.resolution, fallbackDpi);
  const pageWidth = imageData.width * 72 / resolution.xDpi;
  const pageHeight = imageData.height * 72 / resolution.yDpi;
  const vectorContent = pdfContourContent(options.contour, {
    pageWidth,
    pageHeight,
    imageWidth: imageData.width,
    imageHeight: imageData.height,
    stroke: options.contourStroke,
    strokeWidth: options.contourStrokeWidth
  });
  const rgb = new Uint8Array(imageData.width * imageData.height * 3);
  const alpha = new Uint8Array(imageData.width * imageData.height);

  for (let sourceIndex = 0, rgbIndex = 0, alphaIndex = 0; sourceIndex < imageData.data.length; sourceIndex += 4) {
    rgb[rgbIndex] = imageData.data[sourceIndex];
    rgb[rgbIndex + 1] = imageData.data[sourceIndex + 1];
    rgb[rgbIndex + 2] = imageData.data[sourceIndex + 2];
    alpha[alphaIndex] = imageData.data[sourceIndex + 3];
    rgbIndex += 3;
    alphaIndex += 1;
  }

  const content = asciiBytes([
    "q",
    `${formatPdfNumber(pageWidth)} 0 0 ${formatPdfNumber(pageHeight)} 0 0 cm`,
    "/Im0 Do",
    "Q",
    vectorContent,
    ""
  ].filter(Boolean).join("\n"));

  const objects = [
    asciiBytes("<< /Type /Catalog /Pages 2 0 R >>"),
    asciiBytes("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    asciiBytes(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${formatPdfNumber(pageWidth)} ${formatPdfNumber(pageHeight)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 6 0 R >>`),
    pdfStreamObject(`<< /Type /XObject /Subtype /Image /Width ${imageData.width} /Height ${imageData.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 5 0 R /Length ${rgb.length} >>`, rgb),
    pdfStreamObject(`<< /Type /XObject /Subtype /Image /Width ${imageData.width} /Height ${imageData.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${alpha.length} >>`, alpha),
    pdfStreamObject(`<< /Length ${content.length} >>`, content)
  ];

  const chunks = [asciiBytes("%PDF-1.4\n% AlphaKiller\n")];
  const offsets = [0];
  let byteOffset = chunks[0].length;

  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(byteOffset);
    const object = concatUint8Arrays([
      asciiBytes(`${index + 1} 0 obj\n`),
      objects[index],
      asciiBytes("\nendobj\n")
    ]);
    chunks.push(object);
    byteOffset += object.length;
  }

  const xrefOffset = byteOffset;
  const xref = [
    "xref",
    `0 ${objects.length + 1}`,
    "0000000000 65535 f ",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n `),
    "trailer",
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    "startxref",
    String(xrefOffset),
    "%%EOF",
    ""
  ].join("\n");
  chunks.push(asciiBytes(xref));

  return concatUint8Arrays(chunks).buffer;
}

export function formatResolution(resolution) {
  if (!resolution) return "-";
  const x = formatDpiValue(resolution.xDpi);
  const y = formatDpiValue(resolution.yDpi);
  return x === y ? `${x} DPI` : `${x} x ${y} DPI`;
}

function pdfStreamObject(dictionary, bytes) {
  return concatUint8Arrays([
    asciiBytes(dictionary),
    asciiBytes("\nstream\n"),
    bytes,
    asciiBytes("\nendstream")
  ]);
}

function formatPdfNumber(value) {
  return Number(value.toFixed(5)).toString();
}

function normalizePdfResolution(resolution, fallbackDpi) {
  const xDpi = Number(resolution?.xDpi);
  const yDpi = Number(resolution?.yDpi);
  if (Number.isFinite(xDpi) && Number.isFinite(yDpi) && xDpi > 0 && yDpi > 0) {
    return { xDpi, yDpi };
  }
  return { xDpi: fallbackDpi, yDpi: fallbackDpi };
}

function pdfContourContent(contour, options) {
  const paths = contour?.paths || [];
  if (!paths.length) return "";

  const scaleX = options.pageWidth / options.imageWidth;
  const scaleY = options.pageHeight / options.imageHeight;
  const color = parsePdfColor(options.stroke);
  const strokeWidthPx = Math.max(0.1, Number(options.strokeWidth ?? 1));
  const strokeWidth = strokeWidthPx * Math.min(scaleX, scaleY);
  const lines = [
    "q",
    `${formatPdfNumber(color.r)} ${formatPdfNumber(color.g)} ${formatPdfNumber(color.b)} RG`,
    `${formatPdfNumber(strokeWidth)} w`,
    "1 j",
    "1 J"
  ];

  for (const path of paths) {
    const points = path.points || [];
    if (points.length < 2) continue;
    const first = pdfPoint(points[0], scaleX, scaleY, options.pageHeight);
    lines.push(`${first.x} ${first.y} m`);
    if (path.curves?.length) {
      for (const curve of path.curves) {
        const c1 = pdfPoint(curve.c1, scaleX, scaleY, options.pageHeight);
        const c2 = pdfPoint(curve.c2, scaleX, scaleY, options.pageHeight);
        const to = pdfPoint(curve.to, scaleX, scaleY, options.pageHeight);
        lines.push(`${c1.x} ${c1.y} ${c2.x} ${c2.y} ${to.x} ${to.y} c`);
      }
    } else {
      for (let index = 1; index < points.length; index += 1) {
        const point = pdfPoint(points[index], scaleX, scaleY, options.pageHeight);
        lines.push(`${point.x} ${point.y} l`);
      }
    }
    lines.push("h");
  }

  lines.push("S", "Q");
  return lines.join("\n");
}

function pdfPoint(point, scaleX, scaleY, pageHeight) {
  return {
    x: formatPdfNumber(point.x * scaleX),
    y: formatPdfNumber(pageHeight - point.y * scaleY)
  };
}

function parsePdfColor(color) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color || ""));
  if (!match) return { r: 1, g: 0.3098, b: 0.84706 };
  const value = match[1];
  return {
    r: Number((parseInt(value.slice(0, 2), 16) / 255).toFixed(5)),
    g: Number((parseInt(value.slice(2, 4), 16) / 255).toFixed(5)),
    b: Number((parseInt(value.slice(4, 6), 16) / 255).toFixed(5))
  };
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

function createJfifChunk(resolution) {
  const xDensity = Math.max(1, Math.min(65535, Math.round(resolution.xDpi)));
  const yDensity = Math.max(1, Math.min(65535, Math.round(resolution.yDpi)));
  const chunk = new Uint8Array(18);
  chunk[0] = 0xff;
  chunk[1] = 0xe0;
  writeUint16(chunk, 2, 16);
  chunk.set(asciiBytes("JFIF"), 4);
  chunk[8] = 0;
  chunk[9] = 1;
  chunk[10] = 1;
  chunk[11] = 1;
  writeUint16(chunk, 12, xDensity);
  writeUint16(chunk, 14, yDensity);
  chunk[16] = 0;
  chunk[17] = 0;
  return chunk;
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

function hasJpegSignature(data) {
  return data.length >= 2 && data[0] === 0xff && data[1] === 0xd8;
}

function isStandaloneJpegMarker(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function readJfifResolution(data, offset, length) {
  if (!isJfifSegment(data, offset, length)) return null;
  const unit = data[offset + 7];
  const xDensity = readUint16(data, offset + 8);
  const yDensity = readUint16(data, offset + 10);
  if (xDensity <= 0 || yDensity <= 0) return null;

  if (unit === 1) {
    return normalizeResolution({ xDpi: xDensity, yDpi: yDensity, source: "JPEG JFIF" });
  }

  if (unit === 2) {
    return normalizeResolution({ xDpi: xDensity * 2.54, yDpi: yDensity * 2.54, source: "JPEG JFIF" });
  }

  return null;
}

function isJfifSegment(data, offset, length) {
  return length >= 14 &&
    data[offset] === 0x4a &&
    data[offset + 1] === 0x46 &&
    data[offset + 2] === 0x49 &&
    data[offset + 3] === 0x46 &&
    data[offset + 4] === 0;
}

function readExifResolution(data, offset, length) {
  if (length < 14 || readAscii(data, offset, 6) !== "Exif\u0000\u0000") return null;
  const tiffOffset = offset + 6;
  const littleEndian = data[tiffOffset] === 0x49 && data[tiffOffset + 1] === 0x49;
  const bigEndian = data[tiffOffset] === 0x4d && data[tiffOffset + 1] === 0x4d;
  if (!littleEndian && !bigEndian) return null;
  const read16 = littleEndian ? readUint16LE : readUint16;
  const read32 = littleEndian ? readUint32LE : readUint32;
  if (read16(data, tiffOffset + 2) !== 42) return null;

  const ifdOffset = tiffOffset + read32(data, tiffOffset + 4);
  if (ifdOffset + 2 > offset + length) return null;
  const entryCount = read16(data, ifdOffset);
  let xDpi = null;
  let yDpi = null;
  let unit = 2;

  for (let i = 0; i < entryCount; i += 1) {
    const entryOffset = ifdOffset + 2 + i * 12;
    if (entryOffset + 12 > offset + length) break;
    const tag = read16(data, entryOffset);
    const type = read16(data, entryOffset + 2);
    const count = read32(data, entryOffset + 4);
    const valueOffset = entryOffset + 8;

    if ((tag === 0x011a || tag === 0x011b) && type === 5 && count === 1) {
      const rationalOffset = tiffOffset + read32(data, valueOffset);
      const value = readRational(data, rationalOffset, offset + length, read32);
      if (tag === 0x011a) xDpi = value;
      if (tag === 0x011b) yDpi = value;
    }

    if (tag === 0x0128 && type === 3 && count >= 1) {
      unit = read16(data, valueOffset);
    }
  }

  if (!Number.isFinite(xDpi) || !Number.isFinite(yDpi) || xDpi <= 0 || yDpi <= 0) {
    return null;
  }

  if (unit === 3) {
    return normalizeResolution({ xDpi: xDpi * 2.54, yDpi: yDpi * 2.54, source: "JPEG EXIF" });
  }

  return normalizeResolution({ xDpi, yDpi, source: "JPEG EXIF" });
}

function readRational(data, offset, limit, read32) {
  if (offset + 8 > limit) return null;
  const numerator = read32(data, offset);
  const denominator = read32(data, offset + 4);
  if (!denominator) return null;
  return numerator / denominator;
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

function readUint32LE(data, offset) {
  return (
    data[offset] |
    (data[offset + 1] << 8) |
    (data[offset + 2] << 16) |
    (data[offset + 3] * 0x1000000)
  ) >>> 0;
}

function readUint16(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint16LE(data, offset) {
  return data[offset] | (data[offset + 1] << 8);
}

function writeUint32(data, offset, value) {
  data[offset] = (value >>> 24) & 0xff;
  data[offset + 1] = (value >>> 16) & 0xff;
  data[offset + 2] = (value >>> 8) & 0xff;
  data[offset + 3] = value & 0xff;
}

function writeUint16(data, offset, value) {
  data[offset] = (value >>> 8) & 0xff;
  data[offset + 1] = value & 0xff;
}

function formatDpiValue(value) {
  return Math.abs(value - Math.round(value)) < 0.05 ? String(Math.round(value)) : value.toFixed(1);
}

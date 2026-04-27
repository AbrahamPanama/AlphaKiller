const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export function bufferFromPngPayload(pngBytes) {
  let bytes;

  if (pngBytes instanceof ArrayBuffer) {
    bytes = Buffer.from(pngBytes);
  } else if (ArrayBuffer.isView(pngBytes)) {
    bytes = Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  } else {
    throw new Error("Expected PNG bytes as an ArrayBuffer.");
  }

  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Input image size is out of bounds.");
  }

  assertPng(bytes);
  return bytes;
}

export function assertPng(bytes) {
  if (!bytes || bytes.byteLength < 24) {
    throw new Error("Expected normalized PNG input.");
  }

  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) {
      throw new Error("Expected normalized PNG input.");
    }
  }
}

export function readPngDimensions(bytes) {
  assertPng(bytes);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

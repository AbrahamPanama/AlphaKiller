export const PHOTOROOM_LIMITS = Object.freeze({
  maxEdge: 6000,
  maxPixels: 36_000_000,
  maxBytes: 50 * 1024 * 1024
});

export const LOCAL_BG_PROCESSING_LIMITS = Object.freeze({
  maxEdge: 3072,
  maxPixels: 8_000_000
});

export function getPhotoroomResizePlan(width, height, byteLength = 0) {
  return getResizePlan(width, height, PHOTOROOM_LIMITS, byteLength);
}

export function getLocalBgResizePlan(width, height) {
  return getResizePlan(width, height, LOCAL_BG_PROCESSING_LIMITS);
}

function getResizePlan(width, height, limits, byteLength = 0) {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 0));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 0));
  const pixels = sourceWidth * sourceHeight;
  const reasons = [];
  let scale = 1;

  if (Math.max(sourceWidth, sourceHeight) > limits.maxEdge) {
    scale = Math.min(scale, limits.maxEdge / Math.max(sourceWidth, sourceHeight));
    reasons.push("longest side");
  }
  if (pixels > limits.maxPixels) {
    scale = Math.min(scale, Math.sqrt(limits.maxPixels / pixels));
    reasons.push("pixel count");
  }
  if (limits.maxBytes && byteLength > limits.maxBytes) {
    const byteScale = Math.sqrt((limits.maxBytes * 0.92) / byteLength);
    scale = Math.min(scale, byteScale);
    reasons.push("encoded file size");
  }

  if (scale >= 1) return null;

  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
    scale,
    reasons
  };
}

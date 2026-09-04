export const CROP_ASPECT_OPTIONS = Object.freeze([
  { id: "free", label: "Free" },
  { id: "original", label: "Original" },
  { id: "1:1", label: "1:1" },
  { id: "4:5", label: "4:5" },
  { id: "5:4", label: "5:4" },
  { id: "3:2", label: "3:2" },
  { id: "2:3", label: "2:3" },
  { id: "16:9", label: "16:9" },
  { id: "9:16", label: "9:16" }
]);

export function resolveCropAspect(aspectId, sourceWidth, sourceHeight) {
  if (aspectId === "free") return null;
  if (aspectId === "original") return sourceWidth / sourceHeight;
  const match = String(aspectId).match(/^(\d+):(\d+)$/);
  if (!match) return null;
  return Number(match[1]) / Number(match[2]);
}

export function createInitialCropBounds(width, height, aspectId = "free") {
  const insetX = Math.min(width * 0.05, 48);
  const insetY = Math.min(height * 0.05, 48);
  const available = {
    x: insetX,
    y: insetY,
    width: Math.max(1, width - insetX * 2),
    height: Math.max(1, height - insetY * 2)
  };
  const ratio = resolveCropAspect(aspectId, width, height);
  return ratio ? fitCropBoundsToAspect(available, ratio, width, height) : available;
}

export function fitCropBoundsToAspect(bounds, ratio, sourceWidth, sourceHeight) {
  if (!ratio || ratio <= 0) return constrainCropBounds(bounds, sourceWidth, sourceHeight);
  const constrained = constrainCropBounds(bounds, sourceWidth, sourceHeight);
  let width = constrained.width;
  let height = width / ratio;
  if (height > constrained.height) {
    height = constrained.height;
    width = height * ratio;
  }
  return constrainCropBounds({
    x: constrained.x + (constrained.width - width) / 2,
    y: constrained.y + (constrained.height - height) / 2,
    width,
    height
  }, sourceWidth, sourceHeight);
}

export function normalizeCropBounds(bounds, sourceWidth, sourceHeight) {
  const constrained = constrainCropBounds(bounds, sourceWidth, sourceHeight);
  const x = clamp(Math.floor(constrained.x), 0, Math.max(0, sourceWidth - 1));
  const y = clamp(Math.floor(constrained.y), 0, Math.max(0, sourceHeight - 1));
  const right = clamp(Math.ceil(constrained.x + constrained.width), x + 1, sourceWidth);
  const bottom = clamp(Math.ceil(constrained.y + constrained.height), y + 1, sourceHeight);
  return { x, y, width: right - x, height: bottom - y };
}

export function hitTestCropBounds(bounds, point, tolerance) {
  const corners = {
    nw: { x: bounds.x, y: bounds.y },
    ne: { x: bounds.x + bounds.width, y: bounds.y },
    se: { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    sw: { x: bounds.x, y: bounds.y + bounds.height }
  };

  for (const [handle, corner] of Object.entries(corners)) {
    if (Math.hypot(point.x - corner.x, point.y - corner.y) <= tolerance) return handle;
  }

  if (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  ) {
    return "move";
  }
  return "new";
}

export function getCropAnchor(bounds, handle, point) {
  if (handle === "nw") return { x: bounds.x + bounds.width, y: bounds.y + bounds.height };
  if (handle === "ne") return { x: bounds.x, y: bounds.y + bounds.height };
  if (handle === "se") return { x: bounds.x, y: bounds.y };
  if (handle === "sw") return { x: bounds.x + bounds.width, y: bounds.y };
  return { x: point.x, y: point.y };
}

export function resizeCropFromAnchor(anchor, point, ratio, sourceWidth, sourceHeight) {
  const target = {
    x: clamp(point.x, 0, sourceWidth),
    y: clamp(point.y, 0, sourceHeight)
  };
  const directionX = target.x >= anchor.x ? 1 : -1;
  const directionY = target.y >= anchor.y ? 1 : -1;

  if (!ratio || ratio <= 0) {
    return constrainCropBounds({
      x: Math.min(anchor.x, target.x),
      y: Math.min(anchor.y, target.y),
      width: Math.max(1, Math.abs(target.x - anchor.x)),
      height: Math.max(1, Math.abs(target.y - anchor.y))
    }, sourceWidth, sourceHeight);
  }

  const availableWidth = directionX > 0 ? sourceWidth - anchor.x : anchor.x;
  const availableHeight = directionY > 0 ? sourceHeight - anchor.y : anchor.y;
  const requestedWidth = Math.max(Math.abs(target.x - anchor.x), Math.abs(target.y - anchor.y) * ratio);
  const width = Math.max(1, Math.min(requestedWidth, availableWidth, availableHeight * ratio));
  const height = Math.max(1, width / ratio);
  return constrainCropBounds({
    x: directionX > 0 ? anchor.x : anchor.x - width,
    y: directionY > 0 ? anchor.y : anchor.y - height,
    width,
    height
  }, sourceWidth, sourceHeight);
}

export function moveCropBounds(bounds, deltaX, deltaY, sourceWidth, sourceHeight) {
  return {
    ...bounds,
    x: clamp(bounds.x + deltaX, 0, Math.max(0, sourceWidth - bounds.width)),
    y: clamp(bounds.y + deltaY, 0, Math.max(0, sourceHeight - bounds.height))
  };
}

function constrainCropBounds(bounds, sourceWidth, sourceHeight) {
  const width = clamp(Number(bounds.width) || 1, 1, sourceWidth);
  const height = clamp(Number(bounds.height) || 1, 1, sourceHeight);
  return {
    x: clamp(Number(bounds.x) || 0, 0, Math.max(0, sourceWidth - width)),
    y: clamp(Number(bounds.y) || 0, 0, Math.max(0, sourceHeight - height)),
    width,
    height
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

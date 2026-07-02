export function traceVectorContour(imageData, options = {}) {
  const width = imageData?.width ?? 0;
  const height = imageData?.height ?? 0;
  if (!width || !height || !imageData?.data) {
    return emptyContour(width, height, options);
  }

  const alphaThreshold = clampByte(options.alphaThreshold ?? 16);
  const smoothing = Math.max(0, Number(options.simplifyTolerance ?? 1));
  const simplifyTolerance = smoothingToSimplifyTolerance(smoothing);
  const offsetPixels = clampOffset(options.offsetPixels ?? 0);
  const minArea = Math.max(0, Number(options.minArea ?? 1));
  const maxPaths = Math.max(1, Number(options.maxPaths ?? 256));

  // A positive (outward) offset must be able to expand past the image edge for borderless
  // subjects that touch the boundary. Trace inside a grid padded by the offset distance (plus a
  // 1px background ring so the contour can close around the dilated mask); points are mapped back
  // into image coordinate space afterwards, so they may be negative or exceed width/height.
  const pad = offsetPixels > 0 ? offsetPixels + 1 : 0;
  const gridWidth = width + pad * 2;
  const gridHeight = height + pad * 2;

  let foreground = new Uint8Array(gridWidth * gridHeight);
  let foregroundCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (imageData.data[(y * width + x) * 4 + 3] > alphaThreshold) {
        foreground[(y + pad) * gridWidth + (x + pad)] = 1;
        foregroundCount += 1;
      }
    }
  }

  if (foregroundCount && offsetPixels !== 0) {
    foreground = offsetMask(foreground, gridWidth, gridHeight, offsetPixels);
    foregroundCount = countMaskPixels(foreground);
  }

  if (!foregroundCount) {
    return emptyContour(width, height, options);
  }

  const segments = [];
  const starts = new Map();
  const isForeground = (x, y) => x >= 0 && y >= 0 && x < gridWidth && y < gridHeight && foreground[y * gridWidth + x] === 1;
  const addSegment = (sx, sy, ex, ey) => {
    const index = segments.length;
    segments.push({ sx, sy, ex, ey });
    const key = vertexKey(sx, sy, gridWidth);
    const bucket = starts.get(key);
    if (bucket) {
      bucket.push(index);
    } else {
      starts.set(key, [index]);
    }
  };

  for (let y = 0; y < gridHeight; y += 1) {
    for (let x = 0; x < gridWidth; x += 1) {
      if (!isForeground(x, y)) continue;
      if (!isForeground(x, y - 1)) addSegment(x + 1, y, x, y);
      if (!isForeground(x - 1, y)) addSegment(x, y, x, y + 1);
      if (!isForeground(x, y + 1)) addSegment(x, y + 1, x + 1, y + 1);
      if (!isForeground(x + 1, y)) addSegment(x + 1, y + 1, x + 1, y);
    }
  }

  const used = new Uint8Array(segments.length);
  const paths = [];

  for (let index = 0; index < segments.length; index += 1) {
    if (used[index]) continue;
    const rawPath = stitchPath(index, segments, starts, used, gridWidth);
    if (rawPath.length < 3) continue;
    const path = pad ? rawPath.map((point) => ({ x: point.x - pad, y: point.y - pad })) : rawPath;

    const simplified = simplifyClosedPath(path, simplifyTolerance);
    if (simplified.length < 3) continue;

    const area = Math.abs(polygonArea(simplified));
    if (area < minArea) continue;
    const curves = pointsToBezierCurves(simplified, smoothing);

    paths.push({
      points: simplified,
      curves,
      area,
      d: pointsToSvgPath(simplified, curves)
    });
  }

  paths.sort((a, b) => b.area - a.area);
  const limitedPaths = paths.slice(0, maxPaths);

  return {
    width,
    height,
    alphaThreshold,
    simplifyTolerance: smoothing,
    offsetPixels,
    bounds: computeContourBounds(limitedPaths, width, height),
    paths: limitedPaths,
    pathCount: limitedPaths.length,
    pointCount: limitedPaths.reduce((sum, path) => sum + path.points.length, 0),
    svgPath: limitedPaths.map((path) => path.d).join(" ")
  };
}

// Bounding box of the traced contour in image coordinate space, including bezier control points
// (which can bow slightly beyond the path points). May extend outside [0, width] x [0, height].
function computeContourBounds(paths, width, height) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const path of paths) {
    for (const point of path.points) include(point.x, point.y);
    for (const curve of path.curves || []) {
      include(curve.c1.x, curve.c1.y);
      include(curve.c2.x, curve.c2.y);
    }
  }

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: width, maxY: height };
  }
  return { minX, minY, maxX, maxY };
}

export function contourToSvg(contour, options = {}) {
  const stroke = sanitizeSvgColor(options.stroke || "#ff4fd8");
  const strokeWidth = Math.max(0.1, Number(options.strokeWidth ?? 1));
  const title = escapeXml(options.title || "AlphaKiller vector contour");
  const paths = contour?.paths || [];
  const view = contourViewBox(contour);
  const body = paths.length
    ? paths.map((path) => `  <path d="${path.d}" />`).join("\n")
    : "  <!-- No visible alpha contour was detected. -->";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${view.width}" height="${view.height}" viewBox="${view.minX} ${view.minY} ${view.width} ${view.height}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round">`,
    `  <title>${title}</title>`,
    body,
    `</svg>`,
    ``
  ].join("\n");
}

// viewBox = the original image rectangle unioned with the contour extent, so it stays image-sized
// in the normal case and only grows when an outward offset pushes the contour past the edge.
export function contourViewBox(contour) {
  const imageWidth = Math.max(1, contour?.width ?? 1);
  const imageHeight = Math.max(1, contour?.height ?? 1);
  let minX = 0;
  let minY = 0;
  let maxX = imageWidth;
  let maxY = imageHeight;
  const bounds = contour?.bounds;
  if (bounds && Number.isFinite(bounds.minX)) {
    minX = Math.min(minX, Math.floor(bounds.minX));
    minY = Math.min(minY, Math.floor(bounds.minY));
    maxX = Math.max(maxX, Math.ceil(bounds.maxX));
    maxY = Math.max(maxY, Math.ceil(bounds.maxY));
  }
  return { minX, minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function emptyContour(width, height, options) {
  return {
    width,
    height,
    alphaThreshold: clampByte(options.alphaThreshold ?? 16),
    simplifyTolerance: Math.max(0, Number(options.simplifyTolerance ?? 1)),
    offsetPixels: clampOffset(options.offsetPixels ?? 0),
    bounds: { minX: 0, minY: 0, maxX: width, maxY: height },
    paths: [],
    pathCount: 0,
    pointCount: 0,
    svgPath: ""
  };
}

function offsetMask(foreground, width, height, offsetPixels) {
  const radius = Math.abs(offsetPixels);
  if (!radius) return foreground;

  if (offsetPixels > 0) {
    const distanceToForeground = chamferDistance(foreground, width, height, 1, false);
    const limit = radius * 10;
    const output = new Uint8Array(foreground.length);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = distanceToForeground[index] <= limit ? 1 : 0;
    }
    return output;
  }

  const distanceToBackground = chamferDistance(foreground, width, height, 0, true);
  const limit = radius * 10;
  const output = new Uint8Array(foreground.length);
  for (let index = 0; index < output.length; index += 1) {
    output[index] = foreground[index] && distanceToBackground[index] > limit ? 1 : 0;
  }
  return output;
}

function chamferDistance(mask, width, height, targetValue, outsideIsTarget) {
  const infinity = 0x3fffffff;
  const distance = new Int32Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const onOutsideEdge = outsideIsTarget && (x === 0 || y === 0 || x === width - 1 || y === height - 1);
      distance[index] = mask[index] === targetValue ? 0 : onOutsideEdge ? 10 : infinity;
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let best = distance[index];
      if (x > 0) best = Math.min(best, distance[index - 1] + 10);
      if (y > 0) best = Math.min(best, distance[index - width] + 10);
      if (x > 0 && y > 0) best = Math.min(best, distance[index - width - 1] + 14);
      if (x < width - 1 && y > 0) best = Math.min(best, distance[index - width + 1] + 14);
      distance[index] = best;
    }
  }

  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      let best = distance[index];
      if (x < width - 1) best = Math.min(best, distance[index + 1] + 10);
      if (y < height - 1) best = Math.min(best, distance[index + width] + 10);
      if (x < width - 1 && y < height - 1) best = Math.min(best, distance[index + width + 1] + 14);
      if (x > 0 && y < height - 1) best = Math.min(best, distance[index + width - 1] + 14);
      distance[index] = best;
    }
  }

  return distance;
}

function countMaskPixels(mask) {
  let count = 0;
  for (let index = 0; index < mask.length; index += 1) {
    count += mask[index];
  }
  return count;
}

function stitchPath(firstIndex, segments, starts, used, width) {
  const first = segments[firstIndex];
  const startKey = vertexKey(first.sx, first.sy, width);
  let currentKey = vertexKey(first.ex, first.ey, width);
  used[firstIndex] = 1;

  const path = [
    { x: first.sx, y: first.sy },
    { x: first.ex, y: first.ey }
  ];

  let guard = 0;
  while (currentKey !== startKey && guard < segments.length) {
    guard += 1;
    const bucket = starts.get(currentKey);
    const nextIndex = bucket?.find((candidate) => !used[candidate]);
    if (nextIndex === undefined) break;

    const next = segments[nextIndex];
    used[nextIndex] = 1;
    path.push({ x: next.ex, y: next.ey });
    currentKey = vertexKey(next.ex, next.ey, width);
  }

  const last = path[path.length - 1];
  if (last && vertexKey(last.x, last.y, width) === startKey) {
    path.pop();
  }

  return path;
}

function simplifyClosedPath(points, tolerance) {
  if (tolerance <= 0 || points.length <= 4) return points;
  const open = [...points, points[0]];
  const simplified = simplifyPolyline(open, tolerance);
  if (simplified.length > 1) {
    const first = simplified[0];
    const last = simplified[simplified.length - 1];
    if (first.x === last.x && first.y === last.y) {
      simplified.pop();
    }
  }
  return simplified.length >= 3 ? simplified : points;
}

function smoothingToSimplifyTolerance(smoothing) {
  if (!Number.isFinite(smoothing) || smoothing <= 0) return 0;
  return Math.min(4, smoothing * 0.35);
}

function simplifyPolyline(points, tolerance) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  simplifySection(points, 0, points.length - 1, tolerance * tolerance, keep);
  return points.filter((_, index) => keep[index]);
}

function simplifySection(points, start, end, toleranceSq, keep) {
  let maxDistanceSq = -1;
  let maxIndex = -1;
  for (let index = start + 1; index < end; index += 1) {
    const distanceSq = pointLineDistanceSq(points[index], points[start], points[end]);
    if (distanceSq > maxDistanceSq) {
      maxDistanceSq = distanceSq;
      maxIndex = index;
    }
  }

  if (maxDistanceSq <= toleranceSq || maxIndex < 0) return;
  keep[maxIndex] = 1;
  simplifySection(points, start, maxIndex, toleranceSq, keep);
  simplifySection(points, maxIndex, end, toleranceSq, keep);
}

function pointLineDistanceSq(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    return squaredDistance(point, start);
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  return squaredDistance(point, {
    x: start.x + dx * t,
    y: start.y + dy * t
  });
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function pointsToBezierCurves(points, smoothing) {
  if (points.length < 3 || smoothing <= 0) return [];
  const curveStrength = Math.min(1, 0.35 + (smoothing / 12) * 0.65);
  const curves = [];

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const afterNext = points[(index + 2) % points.length];
    const segmentLength = Math.sqrt(squaredDistance(current, next));
    if (segmentLength === 0) continue;

    const outgoing = scaledControlVector(previous, next, curveStrength, segmentLength);
    const incoming = scaledControlVector(afterNext, current, curveStrength, segmentLength);
    curves.push({
      c1: {
        x: current.x + outgoing.x,
        y: current.y + outgoing.y
      },
      c2: {
        x: next.x + incoming.x,
        y: next.y + incoming.y
      },
      to: next
    });
  }

  return curves;
}

function scaledControlVector(before, after, curveStrength, segmentLength) {
  const scale = curveStrength / 6;
  let x = (after.x - before.x) * scale;
  let y = (after.y - before.y) * scale;
  const length = Math.hypot(x, y);
  const limit = segmentLength * 0.45;
  if (length > limit && length > 0) {
    const ratio = limit / length;
    x *= ratio;
    y *= ratio;
  }
  return { x, y };
}

function pointsToSvgPath(points, curves = []) {
  if (!points.length) return "";
  const first = points[0];
  if (curves.length) {
    const commands = curves.map((curve) => [
      "C",
      formatNumber(curve.c1.x),
      formatNumber(curve.c1.y),
      formatNumber(curve.c2.x),
      formatNumber(curve.c2.y),
      formatNumber(curve.to.x),
      formatNumber(curve.to.y)
    ].join(" "));
    return `M ${formatNumber(first.x)} ${formatNumber(first.y)} ${commands.join(" ")} Z`;
  }

  const rest = points.slice(1);
  return `M ${formatNumber(first.x)} ${formatNumber(first.y)} ${rest.map((point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`).join(" ")} Z`;
}

function vertexKey(x, y, width) {
  return y * (width + 1) + x;
}

function clampByte(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(255, Math.round(number)));
}

function clampOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-128, Math.min(128, Math.round(number)));
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function sanitizeSvgColor(color) {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#ff4fd8";
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

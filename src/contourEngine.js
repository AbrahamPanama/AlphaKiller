const DEFAULT_THRESHOLD = 16;
const DEFAULT_MAX_PATHS = 256;
const MAX_OFFSET = 128;
const KEY_SCALE = 1e6;
const DISTANCE_INFINITY = 1e20;

let registeredLegacyFallback = null;

export class ContourCancelledError extends Error {
  constructor(message = "Contour tracing cancelled") {
    super(message);
    this.name = "ContourCancelledError";
  }
}

export function registerLegacyContourFallback(handler) {
  registeredLegacyFallback = typeof handler === "function" ? handler : null;
}

export function traceContourWithFallback(imageData, options = {}, fallback = registeredLegacyFallback) {
  try {
    return traceContourEngine(imageData, options);
  } catch (error) {
    if (error instanceof ContourCancelledError || options.legacyFallback === false || typeof fallback !== "function") {
      throw error;
    }
    return fallback(imageData, options);
  }
}

export function traceContourEngine(imageData, options = {}) {
  const width = positiveInteger(imageData?.width);
  const height = positiveInteger(imageData?.height);
  const alpha = readAlphaPlane(imageData, width, height);
  if (!width || !height || !alpha) {
    return emptyContour(width, height, options);
  }

  const alphaThreshold = clampByte(options.alphaThreshold ?? DEFAULT_THRESHOLD);
  const smoothing = clampNumber(options.simplifyTolerance ?? 1, 0, 64);
  const geometricTolerance = clampNumber(
    options.maxError ?? smoothingToGeometricTolerance(smoothing),
    0,
    16
  );
  const offsetPixels = clampNumber(options.offsetPixels ?? 0, -MAX_OFFSET, MAX_OFFSET);
  const minArea = Math.max(0, finiteNumber(options.minArea, 1));
  const maxPaths = Math.max(1, Math.floor(finiteNumber(options.maxPaths, DEFAULT_MAX_PATHS)));
  const shouldCancel = typeof options.shouldCancel === "function" ? options.shouldCancel : null;
  const checkCancelled = createCancellationCheck(shouldCancel);

  checkCancelled(true);
  let foregroundCount = 0;
  for (let index = 0; index < alpha.length; index += 1) {
    if (alpha[index] > alphaThreshold) foregroundCount += 1;
  }
  if (!foregroundCount) return emptyContour(width, height, options);

  const pad = Math.max(2, offsetPixels > 0 ? Math.ceil(offsetPixels) + 2 : 2);
  const fieldWidth = width + pad * 2;
  const fieldHeight = height + pad * 2;
  const { field } = buildScalarField({
    alpha,
    width,
    height,
    fieldWidth,
    fieldHeight,
    pad,
    alphaThreshold,
    offsetPixels,
    checkCancelled
  });

  const segments = extractMarchingSquares(field, fieldWidth, fieldHeight, pad, checkCancelled);
  const rawLoops = stitchSegments(segments, checkCancelled);
  const candidates = [];

  for (let index = 0; index < rawLoops.length; index += 1) {
    checkCancelled();
    const raw = removeDegeneratePoints(rawLoops[index]);
    if (raw.length < 3) continue;
    const rawArea = Math.abs(polygonArea(raw));
    if (rawArea < minArea) continue;
    const points = simplifyClosedRing(raw, geometricTolerance);
    if (points.length < 3) continue;
    const area = Math.abs(polygonArea(points));
    if (area < minArea) continue;
    candidates.push({ raw, points, area });
  }

  candidates.sort((a, b) => b.area - a.area);
  assignTopology(candidates);
  const limited = candidates.slice(0, maxPaths);
  const paths = limited.map((candidate) => {
    checkCancelled();
    const expectedAreaSign = candidate.isHole ? 1 : -1;
    if (Math.sign(polygonArea(candidate.raw)) !== expectedAreaSign) {
      candidate.raw.reverse();
      candidate.points = simplifyClosedRing(candidate.raw, geometricTolerance);
    }
    const points = candidate.points.map(({ x, y }) => ({ x, y }));
    const curves = fitSmoothClosedCurves(candidate.raw, candidate.points, smoothing, geometricTolerance);
    const signedArea = polygonArea(points);
    return {
      points,
      curves,
      area: Math.abs(signedArea),
      signedArea,
      isHole: candidate.isHole,
      depth: candidate.depth,
      parentPath: candidate.parentPath,
      d: pointsToSvgPath(points, curves)
    };
  });

  checkCancelled(true);
  return {
    width,
    height,
    alphaThreshold,
    simplifyTolerance: smoothing,
    geometricTolerance,
    offsetPixels,
    engine: "subpixel-v2",
    bounds: computeContourBounds(paths, width, height),
    paths,
    pathCount: paths.length,
    pointCount: paths.reduce((sum, path) => sum + path.points.length, 0),
    svgPath: paths.map((path) => path.d).join(" "),
    topology: {
      outerCount: paths.reduce((sum, path) => sum + (path.isHole ? 0 : 1), 0),
      holeCount: paths.reduce((sum, path) => sum + (path.isHole ? 1 : 0), 0)
    },
    sourceForegroundPixels: foregroundCount,
    offsetField: offsetPixels === 0 ? "alpha" : "euclidean-sdf"
  };
}

export const traceVectorContourV2 = traceContourEngine;

function buildScalarField({
  alpha,
  width,
  height,
  fieldWidth,
  fieldHeight,
  pad,
  alphaThreshold,
  offsetPixels,
  checkCancelled
}) {
  const sampleCount = fieldWidth * fieldHeight;
  const field = new Float32Array(sampleCount);
  const mask = new Uint8Array(sampleCount);
  const isoValue = alphaThreshold + 0.5;

  for (let y = 0; y < height; y += 1) {
    const sourceRow = y * width;
    const fieldRow = (y + pad) * fieldWidth + pad;
    for (let x = 0; x < width; x += 1) {
      const value = alpha[sourceRow + x];
      const index = fieldRow + x;
      field[index] = value - isoValue;
      mask[index] = value > alphaThreshold ? 1 : 0;
    }
    checkCancelled();
  }

  if (offsetPixels === 0) {
    for (let y = 0; y < fieldHeight; y += 1) {
      if (y >= pad && y < pad + height) continue;
      field.fill(-isoValue, y * fieldWidth, (y + 1) * fieldWidth);
    }
    for (let y = pad; y < pad + height; y += 1) {
      const row = y * fieldWidth;
      field.fill(-isoValue, row, row + pad);
      field.fill(-isoValue, row + pad + width, row + fieldWidth);
    }
    return { field, mask };
  }

  const boundary = markBoundarySamples(mask, fieldWidth, fieldHeight, checkCancelled);
  const squaredDistance = squaredEuclideanDistance(boundary, fieldWidth, fieldHeight, checkCancelled);
  for (let index = 0; index < sampleCount; index += 1) {
    const signedDistance = (Math.sqrt(squaredDistance[index]) + 0.5) * (mask[index] ? 1 : -1);
    field[index] = signedDistance + offsetPixels;
    if ((index & 0x3ffff) === 0) checkCancelled();
  }
  return { field, mask };
}

function markBoundarySamples(mask, width, height, checkCancelled) {
  const boundary = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const value = mask[index];
      if (
        (x > 0 && mask[index - 1] !== value) ||
        (x + 1 < width && mask[index + 1] !== value) ||
        (y > 0 && mask[index - width] !== value) ||
        (y + 1 < height && mask[index + width] !== value)
      ) {
        boundary[index] = 1;
      }
    }
    checkCancelled();
  }
  return boundary;
}

// Felzenszwalb-Huttenlocher exact squared Euclidean distance transform.
function squaredEuclideanDistance(features, width, height, checkCancelled) {
  const temporary = new Float32Array(width * height);
  const output = new Float32Array(width * height);
  const longest = Math.max(width, height);
  const values = new Float64Array(longest);
  const distances = new Float64Array(longest);
  const sites = new Int32Array(longest);
  const intersections = new Float64Array(longest + 1);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      values[x] = features[row + x] ? 0 : DISTANCE_INFINITY;
    }
    distanceTransform1d(values, width, distances, sites, intersections);
    for (let x = 0; x < width; x += 1) temporary[row + x] = distances[x];
    checkCancelled();
  }

  for (let x = 0; x < width; x += 1) {
    for (let y = 0; y < height; y += 1) values[y] = temporary[y * width + x];
    distanceTransform1d(values, height, distances, sites, intersections);
    for (let y = 0; y < height; y += 1) output[y * width + x] = distances[y];
    checkCancelled();
  }
  return output;
}

function distanceTransform1d(values, length, output, sites, intersections) {
  let hullSize = -1;
  for (let q = 0; q < length; q += 1) {
    if (values[q] >= DISTANCE_INFINITY) continue;
    let crossing = -Infinity;
    while (hullSize >= 0) {
      const previous = sites[hullSize];
      crossing = ((values[q] + q * q) - (values[previous] + previous * previous)) / (2 * (q - previous));
      if (crossing > intersections[hullSize]) break;
      hullSize -= 1;
    }
    hullSize += 1;
    sites[hullSize] = q;
    intersections[hullSize] = hullSize === 0 ? -Infinity : crossing;
    intersections[hullSize + 1] = Infinity;
  }

  if (hullSize < 0) {
    output.fill(DISTANCE_INFINITY, 0, length);
    return;
  }

  let hullIndex = 0;
  for (let q = 0; q < length; q += 1) {
    while (intersections[hullIndex + 1] < q) hullIndex += 1;
    const site = sites[hullIndex];
    const delta = q - site;
    output[q] = delta * delta + values[site];
  }
}

function extractMarchingSquares(field, width, height, pad, checkCancelled) {
  const segments = [];
  for (let y = 0; y < height - 1; y += 1) {
    const row = y * width;
    const nextRow = row + width;
    for (let x = 0; x < width - 1; x += 1) {
      const tl = field[row + x];
      const tr = field[row + x + 1];
      const br = field[nextRow + x + 1];
      const bl = field[nextRow + x];
      const cellCase = (tl >= 0 ? 1 : 0) | (tr >= 0 ? 2 : 0) | (br >= 0 ? 4 : 0) | (bl >= 0 ? 8 : 0);
      if (cellCase === 0 || cellCase === 15) continue;

      const pairs = marchingPairs(cellCase, tl, tr, br, bl);
      const gradientX = ((tr + br) - (tl + bl)) * 0.5;
      const gradientY = ((bl + br) - (tl + tr)) * 0.5;
      for (const [firstEdge, secondEdge] of pairs) {
        let start = edgeIntersection(firstEdge, x, y, tl, tr, br, bl, pad);
        let end = edgeIntersection(secondEdge, x, y, tl, tr, br, bl, pad);
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        if (dy * gradientX - dx * gradientY < 0) {
          [start, end] = [end, start];
        }
        if (squaredDistance(start, end) > 1e-16) segments.push({ start, end, used: false });
      }
    }
    checkCancelled();
  }
  return segments;
}

function marchingPairs(cellCase, tl, tr, br, bl) {
  switch (cellCase) {
    case 1: return [[3, 0]];
    case 2: return [[0, 1]];
    case 3: return [[3, 1]];
    case 4: return [[1, 2]];
    case 5: {
      const diagonal = tl * br - tr * bl;
      return diagonal >= 0 ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
    }
    case 6: return [[0, 2]];
    case 7: return [[3, 2]];
    case 8: return [[2, 3]];
    case 9: return [[0, 2]];
    case 10: {
      const diagonal = tl * br - tr * bl;
      return diagonal <= 0 ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]];
    }
    case 11: return [[1, 2]];
    case 12: return [[3, 1]];
    case 13: return [[0, 1]];
    case 14: return [[3, 0]];
    default: return [];
  }
}

function edgeIntersection(edge, x, y, tl, tr, br, bl, pad) {
  let ax;
  let ay;
  let bx;
  let by;
  let a;
  let b;
  if (edge === 0) {
    [ax, ay, bx, by, a, b] = [x, y, x + 1, y, tl, tr];
  } else if (edge === 1) {
    [ax, ay, bx, by, a, b] = [x + 1, y, x + 1, y + 1, tr, br];
  } else if (edge === 2) {
    [ax, ay, bx, by, a, b] = [x + 1, y + 1, x, y + 1, br, bl];
  } else {
    [ax, ay, bx, by, a, b] = [x, y + 1, x, y, bl, tl];
  }
  const denominator = a - b;
  const ratio = Math.abs(denominator) < 1e-12 ? 0.5 : clampNumber(a / denominator, 0, 1);
  return {
    x: ax + (bx - ax) * ratio - pad + 0.5,
    y: ay + (by - ay) * ratio - pad + 0.5
  };
}

function stitchSegments(segments, checkCancelled) {
  const starts = new Map();
  for (let index = 0; index < segments.length; index += 1) {
    const key = pointKey(segments[index].start);
    const bucket = starts.get(key);
    if (bucket) bucket.push(index);
    else starts.set(key, [index]);
  }

  const loops = [];
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].used) continue;
    const first = segments[index];
    first.used = true;
    const startKey = pointKey(first.start);
    let current = first.end;
    let previous = first.start;
    const points = [first.start, first.end];
    let guard = 0;

    while (pointKey(current) !== startKey && guard < segments.length) {
      guard += 1;
      const bucket = starts.get(pointKey(current));
      const nextIndex = chooseContinuation(bucket, segments, previous, current);
      if (nextIndex < 0) break;
      const next = segments[nextIndex];
      next.used = true;
      previous = current;
      current = next.end;
      points.push(current);
    }

    if (pointKey(current) === startKey) {
      points.pop();
      if (points.length >= 3) loops.push(points);
    }
    if ((index & 0x3fff) === 0) checkCancelled();
  }
  return loops;
}

function chooseContinuation(bucket, segments, previous, current) {
  if (!bucket) return -1;
  let bestIndex = -1;
  let bestAlignment = -Infinity;
  const incomingX = current.x - previous.x;
  const incomingY = current.y - previous.y;
  const incomingLength = Math.hypot(incomingX, incomingY) || 1;
  for (const index of bucket) {
    const candidate = segments[index];
    if (candidate.used) continue;
    const dx = candidate.end.x - candidate.start.x;
    const dy = candidate.end.y - candidate.start.y;
    const length = Math.hypot(dx, dy) || 1;
    const alignment = (incomingX * dx + incomingY * dy) / (incomingLength * length);
    if (alignment > bestAlignment) {
      bestAlignment = alignment;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function simplifyClosedRing(raw, tolerance) {
  if (tolerance <= 0 || raw.length <= 4) {
    return raw.map((point, rawIndex) => ({ ...point, rawIndex }));
  }

  let first = leftmostIndex(raw);
  let second = farthestPointIndex(raw, raw[first]);
  first = farthestPointIndex(raw, raw[second]);
  if (first === second) return raw.map((point, rawIndex) => ({ ...point, rawIndex }));

  const firstArc = circularIndexRange(first, second, raw.length);
  const secondArc = circularIndexRange(second, first, raw.length);
  const keepFirst = simplifyOpenIndices(raw, firstArc, tolerance);
  const keepSecond = simplifyOpenIndices(raw, secondArc, tolerance);
  const combined = [...keepFirst, ...keepSecond.slice(1, -1)];
  const unique = [];
  const seen = new Set();
  for (const rawIndex of combined) {
    if (seen.has(rawIndex)) continue;
    seen.add(rawIndex);
    unique.push({ ...raw[rawIndex], rawIndex });
  }
  return unique.length >= 3 ? unique : raw.map((point, rawIndex) => ({ ...point, rawIndex }));
}

function simplifyOpenIndices(points, indices, tolerance) {
  if (indices.length <= 2) return indices;
  const keep = new Uint8Array(indices.length);
  keep[0] = 1;
  keep[indices.length - 1] = 1;
  const stack = [[0, indices.length - 1]];
  const toleranceSq = tolerance * tolerance;
  while (stack.length) {
    const [start, end] = stack.pop();
    let farthest = -1;
    let maxDistanceSq = toleranceSq;
    for (let index = start + 1; index < end; index += 1) {
      const distanceSq = pointLineDistanceSq(points[indices[index]], points[indices[start]], points[indices[end]]);
      if (distanceSq > maxDistanceSq) {
        maxDistanceSq = distanceSq;
        farthest = index;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([start, farthest], [farthest, end]);
    }
  }
  return indices.filter((_, index) => keep[index]);
}

function fitSmoothClosedCurves(raw, anchors, smoothing, geometricTolerance) {
  if (anchors.length < 3 || smoothing <= 0) return [];
  const strength = clampNumber(smoothing / 12, 0.08, 1);
  const allowedError = Math.max(0.35, geometricTolerance * 1.2);
  const curves = [];

  for (let index = 0; index < anchors.length; index += 1) {
    const previous = anchors[(index - 1 + anchors.length) % anchors.length];
    const current = anchors[index];
    const next = anchors[(index + 1) % anchors.length];
    const after = anchors[(index + 2) % anchors.length];
    const segmentLength = Math.hypot(next.x - current.x, next.y - current.y);
    if (segmentLength < 1e-8) continue;

    const currentTangent = normalizedVector(previous, next);
    const nextTangent = normalizedVector(current, after);
    const currentCorner = cornerRoundness(previous, current, next);
    const nextCorner = cornerRoundness(current, next, after);
    let firstHandle = Math.min(
      segmentLength * 0.34 * strength * currentCorner,
      Math.hypot(current.x - previous.x, current.y - previous.y) * 0.42
    );
    let secondHandle = Math.min(
      segmentLength * 0.34 * strength * nextCorner,
      Math.hypot(after.x - next.x, after.y - next.y) * 0.42
    );
    const rawSpan = circularPointRange(raw, current.rawIndex, next.rawIndex);
    let curve;
    for (let attempt = 0; attempt < 9; attempt += 1) {
      curve = {
        c1: { x: current.x + currentTangent.x * firstHandle, y: current.y + currentTangent.y * firstHandle },
        c2: { x: next.x - nextTangent.x * secondHandle, y: next.y - nextTangent.y * secondHandle },
        to: { x: next.x, y: next.y }
      };
      if (curveFitsRawSpan(current, curve, rawSpan, allowedError)) break;
      firstHandle *= 0.68;
      secondHandle *= 0.68;
    }
    curves.push(curve);
  }
  return curves;
}

function curveFitsRawSpan(start, curve, rawSpan, tolerance) {
  const sampled = [start];
  for (let step = 1; step <= 16; step += 1) {
    sampled.push(cubicPoint(start, curve.c1, curve.c2, curve.to, step / 16));
  }
  const toleranceSq = tolerance * tolerance;
  for (const point of sampled) {
    if (polylineDistanceSq(point, rawSpan) > toleranceSq) return false;
  }
  for (const point of rawSpan) {
    if (polylineDistanceSq(point, sampled) > toleranceSq) return false;
  }
  return true;
}

function assignTopology(candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const probe = interiorProbe(candidate.points);
    let parentPath = -1;
    for (let parent = 0; parent < index; parent += 1) {
      if (pointInPolygon(probe, candidates[parent].points)) parentPath = parent;
    }
    candidate.parentPath = parentPath;
    candidate.depth = parentPath < 0 ? 0 : candidates[parentPath].depth + 1;
    candidate.isHole = candidate.depth % 2 === 1;
  }
}

function interiorProbe(points) {
  const area = polygonArea(points);
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-8) continue;
    const side = area < 0 ? 1 : -1;
    return {
      x: (start.x + end.x) * 0.5 + (dy / length) * side * 0.05,
      y: (start.y + end.y) * 0.5 - (dx / length) * side * 0.05
    };
  }
  return points[0];
}

function pointInPolygon(point, points) {
  let inside = false;
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const a = points[current];
    const b = points[previous];
    if (
      (a.y > point.y) !== (b.y > point.y) &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function computeContourBounds(paths, width, height) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point) => {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  for (const path of paths) {
    path.points.forEach(include);
    for (const curve of path.curves || []) {
      include(curve.c1);
      include(curve.c2);
    }
  }
  return Number.isFinite(minX)
    ? { minX, minY, maxX, maxY }
    : { minX: 0, minY: 0, maxX: width, maxY: height };
}

function pointsToSvgPath(points, curves) {
  if (!points.length) return "";
  const first = points[0];
  if (curves.length) {
    const commands = curves.map((curve) => `C ${formatNumber(curve.c1.x)} ${formatNumber(curve.c1.y)} ${formatNumber(curve.c2.x)} ${formatNumber(curve.c2.y)} ${formatNumber(curve.to.x)} ${formatNumber(curve.to.y)}`);
    return `M ${formatNumber(first.x)} ${formatNumber(first.y)} ${commands.join(" ")} Z`;
  }
  return `M ${formatNumber(first.x)} ${formatNumber(first.y)} ${points.slice(1).map((point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`).join(" ")} Z`;
}

function emptyContour(width, height, options) {
  const smoothing = clampNumber(options?.simplifyTolerance ?? 1, 0, 64);
  return {
    width,
    height,
    alphaThreshold: clampByte(options?.alphaThreshold ?? DEFAULT_THRESHOLD),
    simplifyTolerance: smoothing,
    geometricTolerance: clampNumber(options?.maxError ?? smoothingToGeometricTolerance(smoothing), 0, 16),
    offsetPixels: clampNumber(options?.offsetPixels ?? 0, -MAX_OFFSET, MAX_OFFSET),
    engine: "subpixel-v2",
    bounds: { minX: 0, minY: 0, maxX: width, maxY: height },
    paths: [],
    pathCount: 0,
    pointCount: 0,
    svgPath: "",
    topology: { outerCount: 0, holeCount: 0 },
    sourceForegroundPixels: 0,
    offsetField: Number(options?.offsetPixels) === 0 ? "alpha" : "euclidean-sdf"
  };
}

function readAlphaPlane(imageData, width, height) {
  const pixelCount = width * height;
  const source = imageData?.alpha ?? imageData?.data;
  if (!source || !pixelCount) return null;
  if (source.length === pixelCount) return source;
  if (source.length < pixelCount * 4) return null;
  const alpha = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) alpha[index] = source[index * 4 + 3];
  return alpha;
}

function createCancellationCheck(shouldCancel) {
  let checks = 0;
  return (force = false) => {
    checks += 1;
    if ((force || (checks & 15) === 0) && shouldCancel?.()) throw new ContourCancelledError();
  };
}

function removeDegeneratePoints(points) {
  const output = [];
  for (const point of points) {
    if (!output.length || squaredDistance(output[output.length - 1], point) > 1e-14) output.push(point);
  }
  if (output.length > 1 && squaredDistance(output[0], output[output.length - 1]) <= 1e-14) output.pop();
  return output;
}

function pointKey(point) {
  return `${Math.round(point.x * KEY_SCALE)},${Math.round(point.y * KEY_SCALE)}`;
}

function circularIndexRange(start, end, length) {
  const indices = [start];
  let current = start;
  while (current !== end && indices.length <= length) {
    current = (current + 1) % length;
    indices.push(current);
  }
  return indices;
}

function circularPointRange(points, start, end) {
  return circularIndexRange(start, end, points.length).map((index) => points[index]);
}

function leftmostIndex(points) {
  let best = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (points[index].x < points[best].x || (points[index].x === points[best].x && points[index].y < points[best].y)) best = index;
  }
  return best;
}

function farthestPointIndex(points, origin) {
  let best = 0;
  let bestDistance = -1;
  for (let index = 0; index < points.length; index += 1) {
    const distance = squaredDistance(points[index], origin);
    if (distance > bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function normalizedVector(start, end) {
  const x = end.x - start.x;
  const y = end.y - start.y;
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

function cornerRoundness(previous, current, next) {
  const incoming = normalizedVector(previous, current);
  const outgoing = normalizedVector(current, next);
  const alignment = clampNumber(incoming.x * outgoing.x + incoming.y * outgoing.y, -1, 1);
  return 0.12 + 0.88 * Math.pow((alignment + 1) * 0.5, 0.75);
}

function cubicPoint(p0, p1, p2, p3, t) {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  };
}

function polylineDistanceSq(point, points) {
  if (!points.length) return Infinity;
  if (points.length === 1) return squaredDistance(point, points[0]);
  let best = Infinity;
  for (let index = 1; index < points.length; index += 1) {
    best = Math.min(best, pointLineDistanceSq(point, points[index - 1], points[index]));
  }
  return best;
}

function pointLineDistanceSq(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return squaredDistance(point, start);
  const ratio = clampNumber(((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy), 0, 1);
  return squaredDistance(point, { x: start.x + dx * ratio, y: start.y + dy * ratio });
}

function squaredDistance(first, second) {
  const dx = first.x - second.x;
  const dy = first.y - second.y;
  return dx * dx + dy * dy;
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area * 0.5;
}

function smoothingToGeometricTolerance(smoothing) {
  return smoothing <= 0 ? 0 : Math.min(6, smoothing * 0.35);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampByte(value) {
  return Math.round(clampNumber(value, 0, 255));
}

function clampNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function formatNumber(value) {
  const rounded = Math.abs(value) < 5e-7 ? 0 : value;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/\.?0+$/, "");
}

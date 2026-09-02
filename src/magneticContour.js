const DEFAULT_MINIMUM_COST = 0.025;
const SQRT2 = Math.SQRT2;
const NEIGHBORS = [
  [-1, 0, 1],
  [1, 0, 1],
  [0, -1, 1],
  [0, 1, 1],
  [-1, -1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [1, 1, SQRT2]
];

/**
 * Build a low-is-good path cost map from RGB and alpha gradients.
 * The returned object contains typed arrays only and can be transferred to a worker.
 */
export function buildGradientCostMap(imageData, options = {}) {
  const width = Math.max(0, Math.trunc(imageData?.width ?? 0));
  const height = Math.max(0, Math.trunc(imageData?.height ?? 0));
  const source = imageData?.data;
  if (!width || !height || !source || source.length < width * height * 4) {
    throw new TypeError("buildGradientCostMap requires RGBA image data with valid dimensions.");
  }

  const pixelCount = width * height;
  const magnitude = new Float32Array(pixelCount);
  const normalX = new Float32Array(pixelCount);
  const normalY = new Float32Array(pixelCount);
  const colorWeight = clamp01(options.colorWeight ?? 0.72);
  const alphaWeight = clamp01(options.alphaWeight ?? 0.28);
  const weightTotal = Math.max(Number.EPSILON, colorWeight + alphaWeight);
  const cancellation = cancellationFrom(options);

  for (let y = 0; y < height; y += 1) {
    if ((y & 15) === 0) throwIfCancelled(cancellation);
    for (let x = 0; x < width; x += 1) {
      const gradients = sobelRgba(source, width, height, x, y);
      const colorMagnitude = Math.hypot(
        gradients.rx,
        gradients.ry,
        gradients.gx,
        gradients.gy,
        gradients.bx,
        gradients.by
      ) / Math.sqrt(3);
      const alphaMagnitude = Math.hypot(gradients.ax, gradients.ay);
      const combined = (colorMagnitude * colorWeight + alphaMagnitude * alphaWeight) / weightTotal;
      const index = y * width + x;
      magnitude[index] = combined;

      const colorDirection = strongestGradient(gradients);
      const directionX = colorDirection.x * colorWeight + gradients.ax * alphaWeight;
      const directionY = colorDirection.y * colorWeight + gradients.ay * alphaWeight;
      const directionLength = Math.hypot(directionX, directionY);
      if (directionLength > Number.EPSILON) {
        normalX[index] = directionX / directionLength;
        normalY[index] = directionY / directionLength;
      }
    }
  }

  const gradientScale = positiveNumber(options.gradientScale, robustGradientScale(magnitude));
  const minimumCost = clamp(Number(options.minimumCost ?? DEFAULT_MINIMUM_COST), 0.0001, 1);
  const edgeExponent = clamp(Number(options.edgeExponent ?? 1.65), 0.1, 8);
  const cost = new Float32Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const edgeStrength = clamp01(magnitude[index] / gradientScale);
    cost[index] = minimumCost + (1 - minimumCost) * Math.pow(1 - edgeStrength, edgeExponent);
  }

  return {
    width,
    height,
    cost,
    magnitude,
    normalX,
    normalY,
    minimumCost,
    gradientScale
  };
}

/**
 * Find a deterministic 8-connected minimum-cost path. Search is bounded to an ROI and can
 * optionally be limited to a radius around a line or polyline corridor.
 */
export function findMagneticPath(costMap, startPoint, endPoint, options = {}) {
  validateCostMap(costMap);
  const cancellation = cancellationFrom(options);
  throwIfCancelled(cancellation);

  const start = clampPixel(startPoint, costMap.width, costMap.height);
  const end = clampPixel(endPoint, costMap.width, costMap.height);
  const defaultPadding = Math.max(8, Math.trunc(options.roiPadding ?? 48));
  const roi = normalizeRoi(
    options.roi ?? boundsAroundPoints([start, end], defaultPadding),
    costMap.width,
    costMap.height
  );
  if (!pointInRoi(start, roi) || !pointInRoi(end, roi)) {
    throw new RangeError("Magnetic path endpoints must be inside the search ROI.");
  }

  const localWidth = roi.maxX - roi.minX + 1;
  const localHeight = roi.maxY - roi.minY + 1;
  const nodeCount = localWidth * localHeight;
  const maxNodes = Math.max(1, Math.trunc(options.maxNodes ?? 600000));
  if (nodeCount > maxNodes) {
    throw new RangeError(`Magnetic path ROI contains ${nodeCount} nodes; limit is ${maxNodes}.`);
  }

  const corridor = normalizeCorridor(options.corridor, start, end);
  const startLocal = localIndex(start.x, start.y, roi, localWidth);
  const endLocal = localIndex(end.x, end.y, roi, localWidth);
  const distances = new Float64Array(nodeCount);
  distances.fill(Infinity);
  distances[startLocal] = 0;
  const parents = new Int32Array(nodeCount);
  parents.fill(-1);
  const settled = new Uint8Array(nodeCount);
  const heap = new MinHeap();
  const heuristicWeight = clamp(Number(options.heuristicWeight ?? 1), 0, 1);
  const directionWeight = clamp(Number(options.directionWeight ?? 0.32), 0, 4);
  const minCost = Math.max(0.0001, Number(costMap.minimumCost ?? minArrayValue(costMap.cost)));
  heap.push(startLocal, heuristic(start, end, minCost, heuristicWeight));

  let visited = 0;
  while (heap.size) {
    if ((visited & 2047) === 0) throwIfCancelled(cancellation);
    const entry = heap.pop();
    const current = entry.node;
    if (settled[current]) continue;
    settled[current] = 1;
    visited += 1;
    if (current === endLocal) break;

    const currentPoint = localPoint(current, roi, localWidth);
    for (let neighborIndex = 0; neighborIndex < NEIGHBORS.length; neighborIndex += 1) {
      const [dx, dy, stepLength] = NEIGHBORS[neighborIndex];
      const x = currentPoint.x + dx;
      const y = currentPoint.y + dy;
      if (x < roi.minX || x > roi.maxX || y < roi.minY || y > roi.maxY) continue;
      if (corridor && !pointInCorridor(x, y, corridor) && !(x === end.x && y === end.y)) continue;

      const neighbor = localIndex(x, y, roi, localWidth);
      if (settled[neighbor]) continue;
      const imageIndex = y * costMap.width + x;
      const currentImageIndex = currentPoint.y * costMap.width + currentPoint.x;
      const baseCost = (costMap.cost[currentImageIndex] + costMap.cost[imageIndex]) * 0.5;
      const tangentPenalty = edgeDirectionPenalty(costMap, imageIndex, dx, dy);
      const stepCost = stepLength * (baseCost + directionWeight * tangentPenalty * baseCost);
      const nextDistance = distances[current] + stepCost;
      if (nextDistance + 1e-12 >= distances[neighbor]) continue;

      distances[neighbor] = nextDistance;
      parents[neighbor] = current;
      const estimate = nextDistance + heuristic({ x, y }, end, minCost, heuristicWeight);
      heap.push(neighbor, estimate);
    }
  }

  if (!Number.isFinite(distances[endLocal])) {
    return { points: [], cost: Infinity, visited, roi, found: false };
  }

  const points = [];
  let cursor = endLocal;
  while (cursor >= 0) {
    points.push(localPoint(cursor, roi, localWidth));
    if (cursor === startLocal) break;
    cursor = parents[cursor];
  }
  points.reverse();
  if (points.length) {
    points[0] = finitePoint(startPoint, start);
    points[points.length - 1] = finitePoint(endPoint, end);
  }

  return {
    points: options.simplifyTolerance > 0
      ? simplifyOpenPath(points, Number(options.simplifyTolerance))
      : points,
    cost: distances[endLocal],
    visited,
    roi,
    found: true
  };
}

/** Find the strongest nearby edge, balancing edge cost against pointer distance. */
export function snapPointToEdge(costMap, point, options = {}) {
  validateCostMap(costMap);
  const center = clampPixel(point, costMap.width, costMap.height);
  const radius = Math.max(0, Math.trunc(options.radius ?? 12));
  const distanceWeight = Math.max(0, Number(options.distanceWeight ?? 0.035));
  const cancellation = cancellationFrom(options);
  let best = center;
  let bestScore = Infinity;

  for (let y = Math.max(0, center.y - radius); y <= Math.min(costMap.height - 1, center.y + radius); y += 1) {
    throwIfCancelled(cancellation);
    for (let x = Math.max(0, center.x - radius); x <= Math.min(costMap.width - 1, center.x + radius); x += 1) {
      const distance = Math.hypot(x - center.x, y - center.y);
      if (distance > radius) continue;
      const score = costMap.cost[y * costMap.width + x] + distance * distanceWeight;
      if (score < bestScore - 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && comparePoint({ x, y }, best) < 0)) {
        bestScore = score;
        best = { x, y };
      }
    }
  }

  return { ...best, score: bestScore, sourcePoint: finitePoint(point, center) };
}

/** Return the closest projected point on any closed contour segment. */
export function hitTestContour(contour, point, options = {}) {
  const target = finitePoint(point, { x: 0, y: 0 });
  const pathFilter = Number.isInteger(options.pathIndex) ? options.pathIndex : null;
  const maxDistance = Math.max(0, Number(options.maxDistance ?? Infinity));
  let best = null;

  for (let pathIndex = 0; pathIndex < (contour?.paths?.length ?? 0); pathIndex += 1) {
    if (pathFilter !== null && pathIndex !== pathFilter) continue;
    const points = contour.paths[pathIndex]?.points ?? [];
    if (points.length < 2) continue;
    for (let segmentIndex = 0; segmentIndex < points.length; segmentIndex += 1) {
      const projection = projectPointToSegment(
        target,
        points[segmentIndex],
        points[(segmentIndex + 1) % points.length]
      );
      if (!best || projection.distanceSq < best.distanceSq - 1e-12 || (
        Math.abs(projection.distanceSq - best.distanceSq) <= 1e-12 &&
        (pathIndex < best.pathIndex || (pathIndex === best.pathIndex && segmentIndex < best.segmentIndex))
      )) {
        best = {
          pathIndex,
          segmentIndex,
          t: projection.t,
          point: projection.point,
          distanceSq: projection.distanceSq,
          distance: Math.sqrt(projection.distanceSq),
          arcPosition: segmentIndex + projection.t
        };
      }
    }
  }

  return best && best.distance <= maxDistance ? best : null;
}

/** Create a stable anchor record from a pointer position and nearest contour hit. */
export function createContourAnchor(contour, point, options = {}) {
  const hit = hitTestContour(contour, point, options);
  if (!hit) return null;
  return {
    id: options.id ?? null,
    pathIndex: hit.pathIndex,
    segmentIndex: hit.segmentIndex,
    t: hit.t,
    point: hit.point,
    inputPoint: finitePoint(point, hit.point),
    distance: hit.distance,
    arcPosition: hit.arcPosition
  };
}

/**
 * Replace one arc between two anchors with a magnetic path and rebuild vectorTrace-compatible
 * path/contour derivatives. `replaceArc` may be "shorter" (default), "forward", or "backward".
 */
export function replaceContourSegment(contour, startAnchor, endAnchor, replacementPoints, options = {}) {
  if (!contour?.paths?.length) throw new TypeError("A traced contour is required.");
  if (startAnchor?.pathIndex !== endAnchor?.pathIndex) {
    throw new RangeError("Magnetic contour anchors must belong to the same path.");
  }
  const pathIndex = Math.trunc(startAnchor.pathIndex);
  const originalPath = contour.paths[pathIndex];
  if (!originalPath?.points?.length) throw new RangeError("Anchor path does not exist.");
  const points = originalPath.points;
  const start = normalizeAnchor(startAnchor, points);
  const end = normalizeAnchor(endAnchor, points);
  let replacement = normalizeReplacement(replacementPoints, start.point, end.point);
  if (replacement.length < 2) throw new RangeError("Replacement segment requires at least two points.");

  const forwardLength = arcLengthForward(points, start, end);
  const backwardLength = arcLengthForward(points, end, start);
  const replaceArc = options.replaceArc ?? "shorter";
  const replaceForward = replaceArc === "forward" || (replaceArc === "shorter" && forwardLength <= backwardLength);

  let rebuilt;
  if (replaceForward) {
    rebuilt = replacement.concat(extractForwardArc(points, end, start).slice(1, -1));
  } else {
    replacement = replacement.slice().reverse();
    rebuilt = replacement.concat(extractForwardArc(points, start, end).slice(1, -1));
  }

  rebuilt = removeConsecutiveDuplicates(rebuilt);
  if (rebuilt.length < 3) throw new RangeError("Contour repair would collapse the path below three points.");
  const smoothing = Math.max(0, Number(options.smoothing ?? contour.simplifyTolerance ?? 0));
  const updatedPath = rebuildPath(originalPath, rebuilt, smoothing);
  const paths = contour.paths.map((path, index) => index === pathIndex ? updatedPath : path);
  return rebuildContour(contour, paths, {
    pathIndex,
    replaceArc: replaceForward ? "forward" : "backward",
    startAnchor: start,
    endAnchor: end
  });
}

/**
 * End-to-end magnetic repair. An OpenCV adapter may provide `findPath`; otherwise bounded A* is
 * used. The image/cost map and contour remain immutable.
 */
export async function repairMagneticContour({ imageData, costMap, contour, startAnchor, endAnchor, options = {} }) {
  const cancellation = cancellationFrom(options);
  throwIfCancelled(cancellation);
  const map = costMap ?? buildGradientCostMap(imageData, options);
  const startSnap = options.snapToEdge === false
    ? startAnchor.point
    : snapPointToEdge(map, startAnchor.point, options.snapOptions);
  const endSnap = options.snapToEdge === false
    ? endAnchor.point
    : snapPointToEdge(map, endAnchor.point, options.snapOptions);
  const start = { x: startSnap.x, y: startSnap.y };
  const end = { x: endSnap.x, y: endSnap.y };
  const adapter = options.openCvAdapter;
  let result;

  if (adapter?.isAvailable?.() !== false && typeof adapter?.findPath === "function") {
    result = await adapter.findPath({ imageData, costMap: map, start, end, options, cancellation });
  }
  throwIfCancelled(cancellation);
  if (!result?.points?.length) {
    result = findMagneticPath(map, start, end, options);
  }
  if (!result?.points?.length) {
    throw new Error("No magnetic contour path was found inside the selected corridor.");
  }

  return {
    contour: replaceContourSegment(contour, startAnchor, endAnchor, result.points, options),
    points: result.points,
    costMap: map,
    solver: result.solver ?? (adapter ? "fallback-a-star" : "a-star"),
    diagnostics: {
      cost: result.cost ?? null,
      visited: result.visited ?? null,
      roi: result.roi ?? options.roi ?? null
    }
  };
}

/**
 * Wrap an injected OpenCV IntelligentScissors backend without coupling this module to a specific
 * OpenCV.js build. The backend implements `createSession({ imageData, options })`; a session
 * implements `findPath({ start, end, roi, corridor, cancellation })` and optional `dispose()`.
 */
export function createOpenCvIntelligentScissorsAdapter(backend) {
  let session = null;
  let sessionImage = null;
  return {
    isAvailable() {
      return typeof backend?.createSession === "function";
    },
    async findPath({ imageData, start, end, options = {}, cancellation }) {
      if (typeof backend?.createSession !== "function" || !imageData) return null;
      throwIfCancelled(cancellation);
      if (!session || sessionImage !== imageData) {
        session?.dispose?.();
        session = await backend.createSession({ imageData, options });
        sessionImage = imageData;
      }
      const path = await session.findPath({
        start,
        end,
        roi: options.roi,
        corridor: options.corridor,
        cancellation
      });
      throwIfCancelled(cancellation);
      const points = Array.isArray(path) ? path : path?.points;
      return points?.length ? { ...(Array.isArray(path) ? {} : path), points, solver: "opencv-intelligent-scissors" } : null;
    },
    dispose() {
      session?.dispose?.();
      session = null;
      sessionImage = null;
    }
  };
}

/** Lightweight cancellation source for non-AbortSignal worker jobs. */
export function createCancellationSource() {
  const state = { cancelled: false, reason: null };
  return {
    token: state,
    cancel(reason = "Magnetic contour operation cancelled.") {
      state.cancelled = true;
      state.reason = reason;
    }
  };
}

export function isCancellationError(error) {
  return error?.name === "AbortError";
}

function sobelRgba(data, width, height, x, y) {
  const channels = [0, 1, 2, 3];
  const values = [];
  for (const channel of channels) {
    const tl = channelAt(data, width, height, x - 1, y - 1, channel);
    const tc = channelAt(data, width, height, x, y - 1, channel);
    const tr = channelAt(data, width, height, x + 1, y - 1, channel);
    const ml = channelAt(data, width, height, x - 1, y, channel);
    const mr = channelAt(data, width, height, x + 1, y, channel);
    const bl = channelAt(data, width, height, x - 1, y + 1, channel);
    const bc = channelAt(data, width, height, x, y + 1, channel);
    const br = channelAt(data, width, height, x + 1, y + 1, channel);
    values.push({
      x: -tl + tr - 2 * ml + 2 * mr - bl + br,
      y: -tl - 2 * tc - tr + bl + 2 * bc + br
    });
  }
  return {
    rx: values[0].x, ry: values[0].y,
    gx: values[1].x, gy: values[1].y,
    bx: values[2].x, by: values[2].y,
    ax: values[3].x, ay: values[3].y
  };
}

function channelAt(data, width, height, x, y, channel) {
  const px = clamp(Math.trunc(x), 0, width - 1);
  const py = clamp(Math.trunc(y), 0, height - 1);
  return data[(py * width + px) * 4 + channel];
}

function strongestGradient(gradient) {
  const candidates = [
    { x: gradient.rx, y: gradient.ry },
    { x: gradient.gx, y: gradient.gy },
    { x: gradient.bx, y: gradient.by }
  ];
  let best = candidates[0];
  let bestMagnitude = -1;
  for (const candidate of candidates) {
    const magnitude = candidate.x * candidate.x + candidate.y * candidate.y;
    if (magnitude > bestMagnitude) {
      best = candidate;
      bestMagnitude = magnitude;
    }
  }
  return best;
}

function robustGradientScale(magnitude) {
  let max = 0;
  for (let index = 0; index < magnitude.length; index += 1) max = Math.max(max, magnitude[index]);
  if (max <= Number.EPSILON) return 1;
  const histogram = new Uint32Array(256);
  for (let index = 0; index < magnitude.length; index += 1) {
    histogram[Math.min(255, Math.floor(magnitude[index] / max * 255))] += 1;
  }
  const target = Math.max(1, Math.ceil(magnitude.length * 0.96));
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin += 1) {
    cumulative += histogram[bin];
    if (cumulative >= target) return Math.max(1, max * bin / 255);
  }
  return max;
}

function edgeDirectionPenalty(costMap, index, dx, dy) {
  if (!costMap.normalX || !costMap.normalY) return 0;
  const length = Math.hypot(dx, dy);
  return Math.abs((dx / length) * costMap.normalX[index] + (dy / length) * costMap.normalY[index]);
}

function normalizeCorridor(corridor, start, end) {
  if (!corridor) return null;
  const points = (corridor.points?.length ? corridor.points : [start, end]).map((point) => finitePoint(point, start));
  return {
    points,
    radius: Math.max(0.5, Number(corridor.radius ?? 48))
  };
}

function pointInCorridor(x, y, corridor) {
  const radiusSq = corridor.radius * corridor.radius;
  for (let index = 0; index < corridor.points.length - 1; index += 1) {
    if (pointSegmentDistanceSq({ x, y }, corridor.points[index], corridor.points[index + 1]) <= radiusSq) return true;
  }
  return corridor.points.length === 1 && squaredDistance({ x, y }, corridor.points[0]) <= radiusSq;
}

function normalizeAnchor(anchor, points) {
  const segmentIndex = mod(Math.trunc(anchor.segmentIndex ?? Math.floor(anchor.arcPosition ?? 0)), points.length);
  const t = clamp(Number(anchor.t ?? ((anchor.arcPosition ?? segmentIndex) - Math.floor(anchor.arcPosition ?? segmentIndex))), 0, 1);
  const point = anchor.point
    ? finitePoint(anchor.point, points[segmentIndex])
    : interpolate(points[segmentIndex], points[(segmentIndex + 1) % points.length], t);
  return { ...anchor, segmentIndex, t, point, arcPosition: segmentIndex + t };
}

function normalizeReplacement(points, start, end) {
  const replacement = (points ?? []).map((point) => finitePoint(point, start));
  if (!replacement.length) return [];
  replacement[0] = start;
  if (replacement.length === 1) replacement.push(end);
  else replacement[replacement.length - 1] = end;
  return removeConsecutiveDuplicates(replacement);
}

function extractForwardArc(points, start, end) {
  const output = [start.point];
  const startPosition = start.segmentIndex + start.t;
  let endPosition = end.segmentIndex + end.t;
  if (endPosition < startPosition - 1e-12) endPosition += points.length;
  if (Math.abs(endPosition - startPosition) <= 1e-12 && squaredDistance(start.point, end.point) > 1e-12) {
    endPosition += points.length;
  }
  for (let boundary = Math.floor(startPosition) + 1; boundary < endPosition - 1e-12; boundary += 1) {
    output.push(points[mod(boundary, points.length)]);
  }
  output.push(end.point);
  return removeConsecutiveDuplicates(output);
}

function arcLengthForward(points, start, end) {
  return polylineLength(extractForwardArc(points, start, end));
}

function rebuildPath(originalPath, points, smoothing) {
  const curves = pointsToBezierCurves(points, smoothing);
  return {
    ...originalPath,
    points,
    curves,
    area: Math.abs(polygonArea(points)),
    d: pointsToSvgPath(points, curves)
  };
}

function rebuildContour(contour, paths, edit) {
  const bounds = contourBounds(paths, contour.width, contour.height);
  return {
    ...contour,
    paths,
    bounds,
    pathCount: paths.length,
    pointCount: paths.reduce((sum, path) => sum + (path.points?.length ?? 0), 0),
    svgPath: paths.map((path) => path.d || "").filter(Boolean).join(" "),
    lastMagneticEdit: edit
  };
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
      c1: { x: current.x + outgoing.x, y: current.y + outgoing.y },
      c2: { x: next.x + incoming.x, y: next.y + incoming.y },
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
    x *= limit / length;
    y *= limit / length;
  }
  return { x, y };
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

function contourBounds(paths, width, height) {
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
    for (const point of path.points ?? []) include(point);
    for (const curve of path.curves ?? []) {
      include(curve.c1);
      include(curve.c2);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: width, maxY: height };
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return area / 2;
}

function simplifyOpenPath(points, tolerance) {
  if (points.length <= 2 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;
  while (stack.length) {
    const [start, end] = stack.pop();
    let bestIndex = -1;
    let bestDistance = toleranceSq;
    for (let index = start + 1; index < end; index += 1) {
      const distance = pointSegmentDistanceSq(points[index], points[start], points[end]);
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0) {
      keep[bestIndex] = 1;
      stack.push([start, bestIndex], [bestIndex, end]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function projectPointToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const denominator = dx * dx + dy * dy;
  const t = denominator > 0 ? clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator, 0, 1) : 0;
  const projected = { x: start.x + dx * t, y: start.y + dy * t };
  return { point: projected, t, distanceSq: squaredDistance(point, projected) };
}

function pointSegmentDistanceSq(point, start, end) {
  return projectPointToSegment(point, start, end).distanceSq;
}

function removeConsecutiveDuplicates(points) {
  const output = [];
  for (const point of points) {
    if (!output.length || squaredDistance(output[output.length - 1], point) > 1e-12) output.push(point);
  }
  if (output.length > 1 && squaredDistance(output[0], output[output.length - 1]) <= 1e-12) output.pop();
  return output;
}

function polylineLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) length += Math.sqrt(squaredDistance(points[index - 1], points[index]));
  return length;
}

function interpolate(start, end, t) {
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}

function boundsAroundPoints(points, padding) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    minX: Math.floor(Math.min(...xs) - padding),
    minY: Math.floor(Math.min(...ys) - padding),
    maxX: Math.ceil(Math.max(...xs) + padding),
    maxY: Math.ceil(Math.max(...ys) + padding)
  };
}

function normalizeRoi(roi, width, height) {
  const x = Math.trunc(roi.x ?? roi.minX ?? 0);
  const y = Math.trunc(roi.y ?? roi.minY ?? 0);
  const maxX = roi.maxX ?? (Number.isFinite(roi.width) ? x + roi.width - 1 : width - 1);
  const maxY = roi.maxY ?? (Number.isFinite(roi.height) ? y + roi.height - 1 : height - 1);
  return {
    minX: clamp(x, 0, width - 1),
    minY: clamp(y, 0, height - 1),
    maxX: clamp(Math.trunc(maxX), 0, width - 1),
    maxY: clamp(Math.trunc(maxY), 0, height - 1)
  };
}

function pointInRoi(point, roi) {
  return point.x >= roi.minX && point.x <= roi.maxX && point.y >= roi.minY && point.y <= roi.maxY;
}

function localIndex(x, y, roi, width) {
  return (y - roi.minY) * width + x - roi.minX;
}

function localPoint(index, roi, width) {
  return { x: roi.minX + index % width, y: roi.minY + Math.floor(index / width) };
}

function heuristic(point, end, minCost, weight) {
  return Math.hypot(end.x - point.x, end.y - point.y) * minCost * weight;
}

function validateCostMap(costMap) {
  if (!costMap?.width || !costMap?.height || !costMap?.cost || costMap.cost.length < costMap.width * costMap.height) {
    throw new TypeError("A valid magnetic gradient cost map is required.");
  }
}

function cancellationFrom(options = {}) {
  return options.cancellation ?? options.cancelToken ?? options.signal ?? null;
}

function throwIfCancelled(cancellation) {
  const cancelled = cancellation?.aborted || cancellation?.cancelled || cancellation?.isCancelled?.();
  if (!cancelled) return;
  const error = new Error(cancellation.reason || "Magnetic contour operation cancelled.");
  error.name = "AbortError";
  throw error;
}

function clampPixel(point, width, height) {
  return {
    x: clamp(Math.round(Number(point?.x) || 0), 0, width - 1),
    y: clamp(Math.round(Number(point?.y) || 0), 0, height - 1)
  };
}

function finitePoint(point, fallback) {
  return {
    x: Number.isFinite(Number(point?.x)) ? Number(point.x) : fallback.x,
    y: Number.isFinite(Number(point?.y)) ? Number(point.y) : fallback.y
  };
}

function minArrayValue(array) {
  let minimum = Infinity;
  for (let index = 0; index < array.length; index += 1) minimum = Math.min(minimum, array[index]);
  return Number.isFinite(minimum) ? minimum : DEFAULT_MINIMUM_COST;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function comparePoint(a, b) {
  return a.y === b.y ? a.x - b.x : a.y - b.y;
}

function squaredDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

function clamp01(value) {
  return clamp(Number(value), 0, 1);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

class MinHeap {
  constructor() {
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  push(node, priority) {
    const entry = { node, priority };
    let index = this.entries.length;
    this.entries.push(entry);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareHeapEntries(this.entries[parent], entry) <= 0) break;
      this.entries[index] = this.entries[parent];
      index = parent;
    }
    this.entries[index] = entry;
  }

  pop() {
    const root = this.entries[0];
    const last = this.entries.pop();
    if (this.entries.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        if (left >= this.entries.length) break;
        const right = left + 1;
        let child = left;
        if (right < this.entries.length && compareHeapEntries(this.entries[right], this.entries[left]) < 0) child = right;
        if (compareHeapEntries(last, this.entries[child]) <= 0) break;
        this.entries[index] = this.entries[child];
        index = child;
      }
      this.entries[index] = last;
    }
    return root;
  }
}

function compareHeapEntries(a, b) {
  return a.priority === b.priority ? a.node - b.node : a.priority - b.priority;
}

const EPSILON = 1e-9;

export function hitTestContourNode(contour, point, options = {}) {
  const target = finitePoint(point);
  const maxDistance = Math.max(0, finiteNumber(options.maxDistance, Infinity));
  const pathFilter = Number.isInteger(options.pathIndex) ? options.pathIndex : null;
  let best = null;

  for (let pathIndex = 0; pathIndex < (contour?.paths?.length ?? 0); pathIndex += 1) {
    if (pathFilter !== null && pathIndex !== pathFilter) continue;
    const points = contour.paths[pathIndex]?.points ?? [];
    for (let nodeIndex = 0; nodeIndex < points.length; nodeIndex += 1) {
      const distance = Math.hypot(points[nodeIndex].x - target.x, points[nodeIndex].y - target.y);
      if (!best || distance < best.distance - EPSILON || (
        Math.abs(distance - best.distance) <= EPSILON &&
        (pathIndex < best.pathIndex || (pathIndex === best.pathIndex && nodeIndex < best.nodeIndex))
      )) {
        best = { pathIndex, nodeIndex, point: { ...points[nodeIndex] }, distance };
      }
    }
  }

  return best && best.distance <= maxDistance ? best : null;
}

export function getContourNodeHandles(contour, selection) {
  const path = contour?.paths?.[selection?.pathIndex];
  const points = path?.points ?? [];
  const nodeIndex = normalizeNodeIndex(selection?.nodeIndex, points.length);
  if (nodeIndex < 0 || path?.curves?.length !== points.length) return null;
  const previousCurve = path.curves[mod(nodeIndex - 1, points.length)];
  const outgoingCurve = path.curves[nodeIndex];
  return {
    anchor: { ...points[nodeIndex] },
    in: previousCurve?.c2 ? { ...previousCurve.c2 } : null,
    out: outgoingCurve?.c1 ? { ...outgoingCurve.c1 } : null
  };
}

export function hitTestContourHandle(contour, selection, point, options = {}) {
  const handles = getContourNodeHandles(contour, selection);
  if (!handles) return null;
  const target = finitePoint(point);
  const maxDistance = Math.max(0, finiteNumber(options.maxDistance, Infinity));
  let best = null;
  for (const kind of ["in", "out"]) {
    const handle = handles[kind];
    if (!handle) continue;
    const distance = Math.hypot(handle.x - target.x, handle.y - target.y);
    if (!best || distance < best.distance) best = { kind, point: handle, distance };
  }
  return best && best.distance <= maxDistance ? best : null;
}

export function moveContourNode(contour, selection, nextPoint) {
  const resolved = resolveSelection(contour, selection);
  if (!resolved) return contour;
  const { pathIndex, nodeIndex, path } = resolved;
  const point = clampToContour(finitePoint(nextPoint), contour);
  const previous = path.points[nodeIndex];
  const delta = { x: point.x - previous.x, y: point.y - previous.y };
  if (Math.abs(delta.x) < EPSILON && Math.abs(delta.y) < EPSILON) return contour;

  const points = path.points.map((item, index) => index === nodeIndex ? point : { ...item });
  const curves = cloneCurves(path.curves);
  if (curves.length === points.length) {
    const incoming = mod(nodeIndex - 1, points.length);
    curves[incoming].c2 = translatePoint(curves[incoming].c2, delta);
    curves[incoming].to = { ...point };
    curves[nodeIndex].c1 = translatePoint(curves[nodeIndex].c1, delta);
  }
  return replaceEditedPath(contour, pathIndex, points, curves, {
    type: "move-node",
    pathIndex,
    nodeIndex
  });
}

export function moveContourHandle(contour, selection, kind, nextPoint) {
  const resolved = resolveSelection(contour, selection);
  if (!resolved || (kind !== "in" && kind !== "out")) return contour;
  const { pathIndex, nodeIndex, path } = resolved;
  const points = path.points.map((point) => ({ ...point }));
  let curves = cloneCurves(path.curves);
  if (curves.length !== points.length) {
    curves = buildAutomaticCurves(points, contour.simplifyTolerance ?? 2);
  }
  if (curves.length !== points.length) return contour;

  const point = clampToContour(finitePoint(nextPoint), contour);
  if (kind === "in") curves[mod(nodeIndex - 1, points.length)].c2 = point;
  else curves[nodeIndex].c1 = point;
  return replaceEditedPath(contour, pathIndex, points, curves, {
    type: "move-handle",
    handle: kind,
    pathIndex,
    nodeIndex
  });
}

export function insertContourNode(contour, segmentHit) {
  const pathIndex = Math.trunc(segmentHit?.pathIndex);
  const path = contour?.paths?.[pathIndex];
  const count = path?.points?.length ?? 0;
  if (count < 2) return { contour, selection: null };
  const segmentIndex = mod(Math.trunc(segmentHit.segmentIndex), count);
  const t = clamp(finiteNumber(segmentHit.t, 0.5), 0.001, 0.999);
  const points = path.points.map((point) => ({ ...point }));
  let curves = cloneCurves(path.curves);
  let inserted;

  if (curves.length === count) {
    const start = points[segmentIndex];
    const curve = curves[segmentIndex];
    const split = splitCubic(start, curve.c1, curve.c2, curve.to, t);
    inserted = split.point;
    points.splice(segmentIndex + 1, 0, inserted);
    curves.splice(segmentIndex, 1, split.left, split.right);
  } else {
    const start = points[segmentIndex];
    const end = points[(segmentIndex + 1) % count];
    inserted = segmentHit.point ? finitePoint(segmentHit.point) : lerpPoint(start, end, t);
    points.splice(segmentIndex + 1, 0, inserted);
    curves = [];
  }

  const selection = { pathIndex, nodeIndex: segmentIndex + 1 };
  return {
    contour: replaceEditedPath(contour, pathIndex, points, curves, {
      type: "insert-node",
      ...selection
    }),
    selection
  };
}

export function deleteContourNode(contour, selection) {
  const resolved = resolveSelection(contour, selection);
  if (!resolved || resolved.path.points.length <= 3) {
    return { contour, selection, deleted: false };
  }
  const { pathIndex, nodeIndex, path } = resolved;
  const oldPoints = path.points;
  const count = oldPoints.length;
  const oldCurves = cloneCurves(path.curves);
  const keptIndices = Array.from({ length: count }, (_, index) => index).filter((index) => index !== nodeIndex);
  const points = keptIndices.map((index) => ({ ...oldPoints[index] }));
  let curves = [];

  if (oldCurves.length === count) {
    const previousIndex = mod(nodeIndex - 1, count);
    const nextIndex = mod(nodeIndex + 1, count);
    curves = keptIndices.map((oldStart, index) => {
      const oldEnd = keptIndices[(index + 1) % keptIndices.length];
      const target = points[(index + 1) % points.length];
      if (oldStart === previousIndex && oldEnd === nextIndex) {
        return {
          c1: { ...oldCurves[previousIndex].c1 },
          c2: { ...oldCurves[nodeIndex].c2 },
          to: { ...target }
        };
      }
      return {
        c1: { ...oldCurves[oldStart].c1 },
        c2: { ...oldCurves[oldStart].c2 },
        to: { ...target }
      };
    });
  }

  const nextSelection = {
    pathIndex,
    nodeIndex: Math.min(nodeIndex, points.length - 1)
  };
  return {
    contour: replaceEditedPath(contour, pathIndex, points, curves, {
      type: "delete-node",
      pathIndex,
      nodeIndex
    }),
    selection: nextSelection,
    deleted: true
  };
}

function replaceEditedPath(contour, pathIndex, points, curves, edit) {
  const originalPath = contour.paths[pathIndex];
  const signedArea = polygonArea(points);
  const path = {
    ...originalPath,
    points,
    curves,
    area: Math.abs(signedArea),
    signedArea,
    d: pointsToSvgPath(points, curves)
  };
  const paths = contour.paths.map((item, index) => index === pathIndex ? path : item);
  return {
    ...contour,
    paths,
    bounds: contourBounds(paths, contour.width, contour.height),
    pathCount: paths.length,
    pointCount: paths.reduce((sum, item) => sum + (item.points?.length ?? 0), 0),
    svgPath: paths.map((item) => item.d || "").filter(Boolean).join(" "),
    lastNodeEdit: edit,
    editRevision: (contour.editRevision ?? 0) + 1
  };
}

function resolveSelection(contour, selection) {
  const pathIndex = Math.trunc(selection?.pathIndex);
  const path = contour?.paths?.[pathIndex];
  const nodeIndex = normalizeNodeIndex(selection?.nodeIndex, path?.points?.length ?? 0);
  return path && nodeIndex >= 0 ? { pathIndex, nodeIndex, path } : null;
}

function normalizeNodeIndex(value, length) {
  const index = Math.trunc(value);
  return Number.isInteger(index) && index >= 0 && index < length ? index : -1;
}

function cloneCurves(curves) {
  return Array.isArray(curves)
    ? curves.map((curve) => ({ c1: { ...curve.c1 }, c2: { ...curve.c2 }, to: { ...curve.to } }))
    : [];
}

function splitCubic(p0, p1, p2, p3, t) {
  const a = lerpPoint(p0, p1, t);
  const b = lerpPoint(p1, p2, t);
  const c = lerpPoint(p2, p3, t);
  const d = lerpPoint(a, b, t);
  const e = lerpPoint(b, c, t);
  const point = lerpPoint(d, e, t);
  return {
    point,
    left: { c1: a, c2: d, to: point },
    right: { c1: e, c2: c, to: { ...p3 } }
  };
}

function buildAutomaticCurves(points, smoothing) {
  if (points.length < 3 || smoothing <= 0) return [];
  const strength = Math.min(1, 0.35 + (smoothing / 12) * 0.65);
  return points.map((current, index) => {
    const previous = points[mod(index - 1, points.length)];
    const next = points[(index + 1) % points.length];
    const after = points[(index + 2) % points.length];
    const segmentLength = Math.hypot(next.x - current.x, next.y - current.y);
    return {
      c1: addLimitedVector(current, previous, next, strength, segmentLength),
      c2: addLimitedVector(next, after, current, strength, segmentLength),
      to: { ...next }
    };
  });
}

function addLimitedVector(origin, before, after, strength, segmentLength) {
  let x = (after.x - before.x) * strength / 6;
  let y = (after.y - before.y) * strength / 6;
  const length = Math.hypot(x, y);
  const limit = segmentLength * 0.45;
  if (length > limit && length > 0) {
    x *= limit / length;
    y *= limit / length;
  }
  return { x: origin.x + x, y: origin.y + y };
}

function contourBounds(paths, width, height) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (point) => {
    if (!point) return;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  };
  for (const path of paths) {
    path.points?.forEach(include);
    path.curves?.forEach((curve) => {
      include(curve.c1);
      include(curve.c2);
    });
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : { minX: 0, minY: 0, maxX: width, maxY: height };
}

function pointsToSvgPath(points, curves) {
  if (!points.length) return "";
  const first = points[0];
  if (curves.length === points.length) {
    const commands = curves.map((curve) => `C ${formatNumber(curve.c1.x)} ${formatNumber(curve.c1.y)} ${formatNumber(curve.c2.x)} ${formatNumber(curve.c2.y)} ${formatNumber(curve.to.x)} ${formatNumber(curve.to.y)}`);
    return `M ${formatNumber(first.x)} ${formatNumber(first.y)} ${commands.join(" ")} Z`;
  }
  return `M ${formatNumber(first.x)} ${formatNumber(first.y)} ${points.slice(1).map((point) => `L ${formatNumber(point.x)} ${formatNumber(point.y)}`).join(" ")} Z`;
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

function clampToContour(point, contour) {
  return {
    x: clamp(point.x, 0, Math.max(0, contour.width)),
    y: clamp(point.y, 0, Math.max(0, contour.height))
  };
}

function translatePoint(point, delta) {
  return { x: point.x + delta.x, y: point.y + delta.y };
}

function lerpPoint(start, end, t) {
  return { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
}

function finitePoint(point) {
  return { x: finiteNumber(point?.x, 0), y: finiteNumber(point?.y, 0) };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function mod(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function formatNumber(value) {
  const rounded = Math.abs(value) < 5e-7 ? 0 : value;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/\.?0+$/, "");
}

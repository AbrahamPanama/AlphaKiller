import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  deleteContourNode,
  getContourNodeHandles,
  hitTestContourHandle,
  hitTestContourNode,
  insertContourNode,
  moveContourHandle,
  moveContourNode
} from "../src/contourEditing.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");

if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const { applyProcessing: applyVisionProcessing } = await import("../src/imageProcessing.js");

const FEATURE_SPECS = {
  smartEdge: {
    label: "Smart Edge Polish",
    paths: [
      "src/vision/smartEdge.js",
      "src/vision/smartEdgePolish.js",
      "src/vision/edgePolish.js",
      "src/opencv/smartEdge.js",
      "src/cv/smartEdge.js",
      "src/visionProcessing.js",
      "src/smartEdge.js",
      "src/imageProcessing.js"
    ],
    exports: [
      "applySmartEdgePolish",
      "smartEdgePolish",
      "refineAlphaEdges",
      "refineAlphaMatte",
      "applyGuidedAlphaRefinement"
    ]
  },
  autoRim: {
    label: "Auto Edge Color 2",
    paths: [
      "src/vision/autoRimColor.js",
      "src/vision/edgeColor.js",
      "src/vision/edgeFinisher.js",
      "src/opencv/autoRimColor.js",
      "src/cv/autoRimColor.js",
      "src/visionProcessing.js",
      "src/smartEdge.js",
      "src/imageProcessing.js"
    ],
    exports: [
      "applyAutoRimColor",
      "reconstructEdgeColors",
      "finishAutoEdgeColor",
      "applySmartEdgeColor",
      "reconstructRimRgb",
      "autoRimColor"
    ]
  },
  contour: {
    label: "Contour Engine 2",
    paths: [
      "src/vision/contourEngine.js",
      "src/vision/subpixelContour.js",
      "src/opencv/contourEngine.js",
      "src/cv/contourEngine.js",
      "src/contourEngine.js",
      "src/vectorTrace.js"
    ],
    exports: [
      "traceSubpixelContour",
      "traceContourEngine",
      "traceVectorContourV2",
      "traceContour",
      "traceVectorContour"
    ]
  },
  smartBrush: {
    label: "Smart Brush",
    paths: [
      "src/vision/smartBrush.js",
      "src/vision/smartPen.js",
      "src/opencv/smartBrush.js",
      "src/cv/smartBrush.js",
      "src/smartBrush.js",
      "src/brushProcessing.js",
      "src/imageProcessing.js"
    ],
    exports: [
      "applySmartBrushStroke",
      "applySmartBrush",
      "applySmartBrushEdit",
      "runSmartBrush",
      "refineBrushRoi",
      "applySmartCorrection"
    ]
  }
};

const featureCache = new Map();
const results = [];

await acceptance("one-pixel branch preservation", "smartEdge", testOnePixelBranch);
await acceptance("soft hair-like alpha preservation", "smartEdge", testSoftHairAlpha);
await acceptance("broad residual cavity rejection", "smartEdge", testBroadResidualCavity);
await directAcceptance("reversible detail-to-clean mask balance", testCleanupBalanceRange);
await acceptance("no cross-color rim leakage", "autoRim", testNoCrossColorRimLeakage);
await acceptance("subpixel circle contour accuracy", "contour", testSubpixelCircleAccuracy);
await acceptance("contour topology and holes", "contour", testContourTopology);
await acceptance("contour positive and negative offsets", "contour", testContourOffsets);
await acceptance("smart brush deterministic ROI behavior", "smartBrush", testSmartBrushRoi);
await directAcceptance("editable contour anchors and handles", testEditableContourAnchors);
await directAcceptance("editable contour insertion and deletion", testEditableContourTopology);

const passed = results.filter((result) => result.status === "PASS").length;
const skipped = results.filter((result) => result.status === "SKIP").length;
const failed = results.filter((result) => result.status === "FAIL").length;

console.log(`\nVision acceptance: ${passed} passed, ${skipped} skipped, ${failed} failed.`);
if (skipped) {
  console.log("Skipped checks become active automatically when a matching feature module/export is added.");
}
if (failed) process.exitCode = 1;

async function acceptance(name, featureName, run) {
  const feature = await loadFeature(featureName);
  if (!feature.available) {
    const status = feature.error ? "FAIL" : "SKIP";
    const message = feature.error?.message || feature.reason;
    results.push({ name, status, message });
    console.log(`${status.padEnd(4)} ${name} — ${message}`);
    return;
  }

  try {
    const detail = await run(feature);
    results.push({ name, status: "PASS", detail });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, status: "FAIL", message: error.message });
    console.error(`FAIL ${name} — ${error.message}`);
  }
}

async function directAcceptance(name, run) {
  try {
    const detail = await run();
    results.push({ name, status: "PASS", detail });
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, status: "FAIL", message: error.message });
    console.error(`FAIL ${name} — ${error.message}`);
  }
}

async function loadFeature(name) {
  if (featureCache.has(name)) return featureCache.get(name);
  const spec = FEATURE_SPECS[name];
  const seenModules = [];

  for (const relativePath of spec.paths) {
    const absolutePath = path.join(PROJECT_ROOT, relativePath);
    if (!existsSync(absolutePath)) continue;
    seenModules.push(relativePath);

    let module;
    try {
      const cacheKey = statSync(absolutePath).mtimeMs;
      module = await import(`${pathToFileURL(absolutePath).href}?vision-acceptance=${cacheKey}`);
    } catch (error) {
      const result = {
        available: false,
        error: new Error(`${spec.label} module ${relativePath} failed to import: ${error.message}`)
      };
      featureCache.set(name, result);
      return result;
    }

    for (const exportName of spec.exports) {
      if (typeof module[exportName] === "function") {
        const result = {
          available: true,
          label: spec.label,
          exportName,
          modulePath: relativePath,
          fn: module[exportName]
        };
        featureCache.set(name, result);
        return result;
      }
    }
  }

  const reason = seenModules.length
    ? `${spec.label} is not exposed yet; checked ${seenModules.join(", ")} for ${spec.exports.join(", ")}`
    : `${spec.label} module is not available; searched ${spec.paths.join(", ")}`;
  const result = { available: false, reason };
  featureCache.set(name, result);
  return result;
}

async function testOnePixelBranch(feature) {
  const width = 96;
  const height = 72;
  const branch = [];
  const image = makeImageData(width, height, (x, y) => {
    const inBody = x >= 12 && x <= 43 && y >= 30 && y <= 58;
    const onBranch = x >= 42 && x <= 85 && y === 38;
    const besideBranch = x >= 42 && x <= 85 && (y === 37 || y === 39);
    if (onBranch) branch.push({ x, y });
    if (inBody || onBranch) return [28, 132, 76, 255];
    if (besideBranch) return [28, 132, 76, 64];
    return [0, 0, 0, 0];
  });

  const output = await invokeImageFeature(feature, image, smartEdgeOptions());
  const retained = branch.filter(({ x, y }) => alphaAt(output, x, y) >= 96).length;
  const ratio = retained / branch.length;
  assert(ratio >= 0.9, `only ${(ratio * 100).toFixed(1)}% of the one-pixel branch survived`);
  assert(alphaAt(output, 85, 38) >= 64, "the branch tip was removed");
  return `${retained}/${branch.length} center pixels retained via ${feature.modulePath}:${feature.exportName}`;
}

function testCleanupBalanceRange() {
  const width = 12;
  const height = 6;
  const conservativeAlpha = new Uint8Array(width * height);
  const aggressiveAlpha = new Uint8Array(width * height);
  const image = makeImageData(width, height, (x, y) => {
    const inside = x >= 1 && x <= 10 && y >= 1 && y <= 4;
    const highlight = x >= 3 && x <= 5 && y >= 2 && y <= 3;
    const residue = x >= 7 && x <= 9 && y >= 2 && y <= 3;
    const pixel = y * width + x;
    const alpha = !inside ? 0 : highlight ? 220 : residue ? 64 : 255;
    conservativeAlpha[pixel] = alpha;
    aggressiveAlpha[pixel] = !inside ? 0 : highlight ? 20 : residue ? 0 : 255;
    return highlight
      ? [250, 244, 232, alpha]
      : residue
        ? [42, 46, 51, alpha]
        : [154, 78, 126, alpha];
  });
  const runtime = { segmentationStages: { conservativeAlpha, aggressiveAlpha } };
  const settings = (cleanupBalance) => ({
    defringe: { enabled: false, matteColor: "#ffffff", strength: 0, radius: 1, tolerance: 0, passes: 1 },
    edgeFinish: {
      enabled: true,
      treatment: "smart",
      smartStrength: 0,
      cleanupBalance,
      detailProtection: 100,
      rimColorMode: "off",
      edgeColor: "#000000",
      edgeWidth: 0,
      cutoff: 128
    }
  });

  const detail = applyVisionProcessing(image, settings(0), runtime);
  const balanced = applyVisionProcessing(image, settings(45), runtime);
  const clean = applyVisionProcessing(image, settings(100), runtime);
  const highlightIndex = (2 * width + 4) * 4 + 3;
  const residueIndex = (2 * width + 8) * 4 + 3;

  assert(detail.data[highlightIndex] === 220, "detail endpoint did not restore the highlight matte");
  assert(detail.data[residueIndex] === 64, "detail endpoint changed the conservative residue matte");
  assert(balanced.data[highlightIndex] === 130, "balanced endpoint did not interpolate highlight confidence");
  assert(balanced.data[residueIndex] === 35, "balanced endpoint did not interpolate residue confidence");
  assert(clean.data[highlightIndex] === 20, "clean endpoint did not use the aggressive highlight matte");
  assert(clean.data[residueIndex] === 0, "clean endpoint did not remove weak residue");
  return "highlight alpha 220/130/20; residue alpha 64/35/0";
}

async function testSoftHairAlpha(feature) {
  const width = 96;
  const height = 72;
  const hairPixels = [];
  const alphaLevels = [48, 80, 112, 144, 176, 208];
  const image = makeImageData(width, height, (x, y) => {
    if (x >= 18 && x <= 77 && y >= 48 && y <= 66) return [92, 52, 28, 255];
    for (let strand = 0; strand < 9; strand += 1) {
      const rootX = 24 + strand * 6;
      const strandY = 47 - Math.abs(x - rootX) * 2;
      if (y === strandY && y >= 8 && y < 48) {
        const alpha = alphaLevels[(x + strand) % alphaLevels.length];
        hairPixels.push({ x, y, alpha });
        return [116, 72, 38, alpha];
      }
    }
    return [8, 14, 18, 0];
  });

  const output = await invokeImageFeature(feature, image, smartEdgeOptions());
  const values = hairPixels.map(({ x, y }) => alphaAt(output, x, y));
  const semiAlpha = values.filter((alpha) => alpha > 0 && alpha < 255);
  const distinct = new Set(semiAlpha.map((alpha) => Math.round(alpha / 16))).size;
  assert(semiAlpha.length >= hairPixels.length * 0.6,
    `only ${semiAlpha.length}/${hairPixels.length} hair samples kept soft alpha`);
  assert(distinct >= 3, `hair alpha collapsed to ${distinct} effective level(s)`);
  return `${semiAlpha.length}/${hairPixels.length} samples remain semi-transparent across ${distinct} levels`;
}

async function testBroadResidualCavity(feature) {
  const width = 120;
  const height = 96;
  const cavityPixels = [];
  const branchPixels = [];
  const image = makeImageData(width, height, (x, y) => {
    const inLeftArm = x >= 20 && x <= 35 && y >= 12 && y <= 80;
    const inRightArm = x >= 84 && x <= 99 && y >= 12 && y <= 80;
    const inBase = x >= 20 && x <= 99 && y >= 70 && y <= 88;
    if (inLeftArm || inRightArm || inBase) return [210, 112, 88, 255];

    const inCavity = x >= 36 && x <= 83 && y >= 22 && y <= 69;
    if (inCavity) {
      cavityPixels.push({ x, y });
      return [126, 138, 150, 48];
    }

    const onBranch = x >= 100 && x <= 115 && y === 40;
    if (onBranch) {
      branchPixels.push({ x, y });
      return [210, 112, 88, 64];
    }
    return [0, 0, 0, 0];
  });

  const output = await invokeImageFeature(feature, image, {
    alpha: {
      radius: 6,
      iterations: 1,
      strength: 0.65,
      detailProtection: 0.75,
      thinFeatureWidth: 7,
      thicknessProbeRadius: 10,
      suppressBroadResiduals: true
    },
    rim: { enabled: false }
  });

  let grownPixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    if (output.data[pixel * 4 + 3] > image.data[pixel * 4 + 3]) grownPixels += 1;
  }
  assert(grownPixels === 0, `${grownPixels} alpha samples grew during Smart Edge refinement`);

  const deepCavity = cavityPixels.filter(({ x, y }) => x >= 44 && x <= 75 && y >= 32 && y <= 61);
  const cleared = deepCavity.filter(({ x, y }) => alphaAt(output, x, y) <= 5).length;
  const retainedBranches = branchPixels.filter(({ x, y }) => alphaAt(output, x, y) > 0).length;
  assert(cleared >= deepCavity.length * 0.9,
    `only ${cleared}/${deepCavity.length} broad cavity pixels were cleared`);
  assert(retainedBranches >= branchPixels.length * 0.8,
    `only ${retainedBranches}/${branchPixels.length} thin branch pixels survived`);
  return `${cleared}/${deepCavity.length} cavity pixels cleared; ${retainedBranches}/${branchPixels.length} branch pixels retained`;
}

async function testNoCrossColorRimLeakage(feature) {
  const width = 72;
  const height = 40;
  const image = makeImageData(width, height, (x, y) => {
    const vertical = y >= 7 && y <= 32;
    if (vertical && x >= 7 && x <= 28) {
      return [232, 34, 38, x === 28 ? 180 : 255];
    }
    if (vertical && x >= 33 && x <= 54) {
      return [30, 78, 232, x === 33 ? 180 : 255];
    }
    return [128, 128, 128, 0];
  });

  const output = await invokeImageFeature(feature, image, {
    mode: "auto",
    rimColorMode: "auto",
    cutoff: 128,
    edgeWidth: 2,
    radius: 2,
    detailProtection: 1
  });

  const leftSamples = [[28, 12], [29, 18], [30, 25]];
  const rightSamples = [[33, 12], [32, 18], [31, 25]];
  for (const [x, y] of leftSamples) {
    if (alphaAt(output, x, y) === 0) continue;
    const [r, , b] = rgbAt(output, x, y);
    assert(r >= b + 48, `blue leaked into the red rim at ${x},${y}: rgb(${rgbAt(output, x, y)})`);
  }
  for (const [x, y] of rightSamples) {
    if (alphaAt(output, x, y) === 0) continue;
    const [r, , b] = rgbAt(output, x, y);
    assert(b >= r + 48, `red leaked into the blue rim at ${x},${y}: rgb(${rgbAt(output, x, y)})`);
  }
  assert(alphaAt(output, 28, 20) > 0 && alphaAt(output, 33, 20) > 0,
    "the test rims disappeared instead of being color reconstructed");
  return `opposing red/blue rims remained locally colored via ${feature.modulePath}:${feature.exportName}`;
}

async function testSubpixelCircleAccuracy(feature) {
  const width = 129;
  const height = 129;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 36.35;
  const image = softCircleImage(width, height, cx, cy, radius);
  const contour = await invokeContour(feature, image, contourOptions({ smoothing: 2 }));
  const path = largestPath(contour);
  const samples = samplePath(path, 10);
  assert(samples.length >= 16, `contour exposed only ${samples.length} measurable points`);

  const errors = samples.map((point) => Math.abs(Math.hypot(point.x - cx, point.y - cy) - radius));
  const meanError = mean(errors);
  const p95Error = percentile(errors, 0.95);
  assert(meanError <= 0.5, `mean radial error ${meanError.toFixed(3)}px exceeds 0.5px`);
  assert(p95Error <= 1.0, `95th-percentile radial error ${p95Error.toFixed(3)}px exceeds 1px`);
  return `mean ${meanError.toFixed(3)}px, p95 ${p95Error.toFixed(3)}px, ${samples.length} samples`;
}

async function testContourTopology(feature) {
  const width = 144;
  const height = 112;
  const image = makeImageData(width, height, (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    const donutDistance = Math.hypot(px - 51, py - 56);
    const islandDistance = Math.hypot(px - 113, py - 56);
    const inDonut = donutDistance <= 35 && donutDistance >= 14;
    const inIsland = islandDistance <= 15;
    return inDonut || inIsland ? [210, 220, 230, 255] : [0, 0, 0, 0];
  });

  const contour = await invokeContour(feature, image, contourOptions({ smoothing: 1 }));
  const paths = contourPaths(contour);
  assert(paths.length === 3,
    `expected outer donut, donut hole, and island paths; received ${paths.length}`);

  const areas = paths.map(pathArea).sort((a, b) => b - a);
  assert(areas[0] > areas[1] * 2, "the outer donut was not preserved as the dominant component");
  assert(areas[2] > 300, "the hole or disconnected island collapsed below its expected area");
  return `three boundaries retained with areas ${areas.map((area) => area.toFixed(1)).join(", ")}`;
}

async function testContourOffsets(feature) {
  const width = 128;
  const height = 128;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 30.2;
  const image = softCircleImage(width, height, cx, cy, radius);
  const base = await invokeContour(feature, image, contourOptions({ offset: 0, smoothing: 1 }));
  const expanded = await invokeContour(feature, image, contourOptions({ offset: 4, smoothing: 1 }));
  const contracted = await invokeContour(feature, image, contourOptions({ offset: -4, smoothing: 1 }));

  const baseRadius = meanRadius(samplePath(largestPath(base), 8), cx, cy);
  const expandedRadius = meanRadius(samplePath(largestPath(expanded), 8), cx, cy);
  const contractedRadius = meanRadius(samplePath(largestPath(contracted), 8), cx, cy);

  assert(expandedRadius > baseRadius, "positive offset did not expand the contour");
  assert(contractedRadius < baseRadius, "negative offset did not contract the contour");
  assert(Math.abs((expandedRadius - baseRadius) - 4) <= 1.25,
    `positive offset moved ${(expandedRadius - baseRadius).toFixed(2)}px instead of 4px`);
  assert(Math.abs((baseRadius - contractedRadius) - 4) <= 1.25,
    `negative offset moved ${(baseRadius - contractedRadius).toFixed(2)}px instead of 4px`);
  return `radii ${contractedRadius.toFixed(2)} / ${baseRadius.toFixed(2)} / ${expandedRadius.toFixed(2)}px`;
}

async function testSmartBrushRoi(feature) {
  const width = 80;
  const height = 64;
  const source = makeImageData(width, height, (x, y) => {
    const inside = Math.hypot(x + 0.5 - 40, y + 0.5 - 32) <= 24;
    return inside ? [60 + x, 90 + Math.floor(y / 2), 170, 255] : [14, 18, 24, 0];
  });
  const current = cloneImageData(source);
  for (let y = 27; y <= 36; y += 1) {
    for (let x = 34; x <= 45; x += 1) {
      current.data[(y * width + x) * 4 + 3] = 0;
    }
  }

  const roi = { x: 28, y: 21, width: 24, height: 24 };
  const stroke = {
    points: [{ x: 35, y: 32 }, { x: 45, y: 32 }],
    from: { x: 35, y: 32 },
    to: { x: 45, y: 32 },
    size: 7,
    radius: 3.5
  };
  const options = { mode: "restore", action: "foreground", roi, roiPadding: 8, deterministic: true };
  const first = await invokeSmartBrush(feature, current, source, stroke, options);
  const second = await invokeSmartBrush(feature, current, source, stroke, options);

  assert(equalBytes(first.imageData.data, second.imageData.data), "identical smart-brush inputs produced different bytes");
  const effectiveRoi = normalizeRoi(first.meta?.roi || first.meta?.bounds || roi, width, height);
  let changedInside = 0;
  let changedOutside = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (!pixelDiffers(current.data, first.imageData.data, pixel)) continue;
      if (pointInRoi(x, y, effectiveRoi)) changedInside += 1;
      else changedOutside += 1;
    }
  }

  assert(changedInside > 0, "smart brush did not modify any pixel in its ROI");
  assert(changedOutside === 0, `${changedOutside} pixels changed outside the declared ROI`);
  assert(alphaAt(first.imageData, 40, 32) > alphaAt(current, 40, 32), "restore stroke did not recover its target alpha");
  return `${changedInside} deterministic changed pixels inside [${effectiveRoi.x},${effectiveRoi.y},${effectiveRoi.width},${effectiveRoi.height}]`;
}

function testEditableContourAnchors() {
  const contour = editableContourFixture();
  const selection = { pathIndex: 0, nodeIndex: 1 };
  const originalHandles = getContourNodeHandles(contour, selection);
  const moved = moveContourNode(contour, selection, { x: 45, y: 14 });
  const movedHandles = getContourNodeHandles(moved, selection);
  assert(contour.paths[0].points[1].x === 40, "node move mutated the source contour");
  assert(moved.paths[0].points[1].x === 45 && moved.paths[0].points[1].y === 14,
    "anchor did not move to the requested coordinate");
  assert(Math.abs((movedHandles.out.x - originalHandles.out.x) - 5) < 1e-6,
    "outgoing handle did not follow the moved anchor");
  assert(Math.abs((movedHandles.in.y - originalHandles.in.y) - 4) < 1e-6,
    "incoming handle did not follow the moved anchor");

  const handleMoved = moveContourHandle(moved, selection, "out", { x: 51.5, y: 20.25 });
  const handleHit = hitTestContourHandle(handleMoved, selection, { x: 51.5, y: 20.25 }, { maxDistance: 0.01 });
  const nodeHit = hitTestContourNode(handleMoved, { x: 45, y: 14 }, { maxDistance: 0.01 });
  assert(handleHit?.kind === "out", "the edited outgoing handle is not hit-testable");
  assert(nodeHit?.nodeIndex === 1, "the moved node is not hit-testable");
  assert(handleMoved.svgPath.includes("C "), "edited handles were not serialized as Bezier SVG commands");
  return "anchors preserve adjacent handles; independent handles remain exportable";
}

function testEditableContourTopology() {
  const contour = editableContourFixture();
  const originalCurve = contour.paths[0].curves[0];
  const inserted = insertContourNode(contour, { pathIndex: 0, segmentIndex: 0, t: 0.5 });
  const expected = editableCubicPoint(contour.paths[0].points[0], originalCurve.c1, originalCurve.c2, originalCurve.to, 0.5);
  const actual = inserted.contour.paths[0].points[inserted.selection.nodeIndex];
  assert(inserted.contour.pointCount === contour.pointCount + 1, "Bezier split did not add exactly one node");
  assert(Math.hypot(actual.x - expected.x, actual.y - expected.y) < 1e-6,
    "inserted node does not lie on the original Bezier segment");
  assert(inserted.contour.paths[0].curves.length === inserted.contour.paths[0].points.length,
    "Bezier split broke the closed curve contract");

  const deleted = deleteContourNode(inserted.contour, inserted.selection);
  assert(deleted.deleted, "inserted node could not be deleted");
  assert(deleted.contour.pointCount === contour.pointCount, "delete did not restore the original node count");
  assert(deleted.contour.paths[0].curves.length === deleted.contour.paths[0].points.length,
    "node deletion broke the closed curve contract");
  return "exact cubic split and closed-path merge preserve topology";
}

function editableContourFixture() {
  const points = [
    { x: 10, y: 10 },
    { x: 40, y: 10 },
    { x: 40, y: 40 },
    { x: 10, y: 40 }
  ];
  const curves = [
    { c1: { x: 20, y: 4 }, c2: { x: 30, y: 4 }, to: { ...points[1] } },
    { c1: { x: 46, y: 20 }, c2: { x: 46, y: 30 }, to: { ...points[2] } },
    { c1: { x: 30, y: 46 }, c2: { x: 20, y: 46 }, to: { ...points[3] } },
    { c1: { x: 4, y: 30 }, c2: { x: 4, y: 20 }, to: { ...points[0] } }
  ];
  return {
    width: 64,
    height: 64,
    simplifyTolerance: 2,
    bounds: { minX: 4, minY: 4, maxX: 46, maxY: 46 },
    paths: [{ points, curves, area: 900, signedArea: 900, d: "" }],
    pathCount: 1,
    pointCount: 4,
    svgPath: ""
  };
}

function editableCubicPoint(p0, p1, p2, p3, t) {
  const inverse = 1 - t;
  return {
    x: inverse ** 3 * p0.x + 3 * inverse ** 2 * t * p1.x + 3 * inverse * t ** 2 * p2.x + t ** 3 * p3.x,
    y: inverse ** 3 * p0.y + 3 * inverse ** 2 * t * p1.y + 3 * inverse * t ** 2 * p2.y + t ** 3 * p3.y
  };
}

async function invokeImageFeature(feature, imageData, options) {
  const errors = [];
  const attempts = [
    (input) => feature.fn(input, options),
    (input) => feature.fn({ imageData: input, sourceImageData: cloneImageData(input), options, ...options })
  ];

  for (const attempt of attempts) {
    const input = cloneImageData(imageData);
    const before = new Uint8ClampedArray(input.data);
    try {
      const result = await attempt(input);
      const normalized = normalizeImageResult(result, input, before);
      if (normalized) return normalized.imageData;
      errors.push("returned no ImageData, RGBA buffer, or alpha mask");
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${feature.exportName} could not be invoked: ${errors.join(" | ")}`);
}

async function invokeContour(feature, imageData, options) {
  const attempts = [
    () => feature.fn(cloneImageData(imageData), options),
    () => feature.fn({ imageData: cloneImageData(imageData), options, ...options })
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      const result = await attempt();
      const contour = result?.contour || result;
      if (contour && contourPaths(contour).length >= 0) return contour;
      errors.push("returned no contour result");
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${feature.exportName} could not be invoked: ${errors.join(" | ")}`);
}

async function invokeSmartBrush(feature, current, source, stroke, options) {
  const errors = [];
  const attempts = [
    (input, original) => feature.fn({
      imageData: input,
      currentImageData: input,
      currentImage: input,
      sourceImageData: original,
      sourceImage: original,
      stroke,
      strokes: [stroke],
      ...options,
      options
    }),
    (input, original) => feature.fn(input, { sourceImageData: original, stroke, ...options }),
    (input, original) => feature.fn(input, original, stroke, options)
  ];

  for (const attempt of attempts) {
    const input = cloneImageData(current);
    const original = cloneImageData(source);
    const before = new Uint8ClampedArray(input.data);
    try {
      const result = await attempt(input, original);
      const normalized = normalizeImageResult(result, input, before);
      if (normalized) return normalized;
      errors.push("returned no changed ImageData or pixel buffer");
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${feature.exportName} could not be invoked: ${errors.join(" | ")}`);
}

function normalizeImageResult(result, fallback, before) {
  const candidates = [
    result,
    result?.imageData,
    result?.image,
    result?.output,
    result?.result,
    result?.processedImageData,
    result?.mask,
    result?.alpha,
    result?.data
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isImageDataLike(candidate)) {
      return { imageData: ensureImageData(candidate), meta: result };
    }
    if (ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer) {
      const view = candidate instanceof ArrayBuffer ? new Uint8Array(candidate) : candidate;
      if (view.length === fallback.width * fallback.height * 4) {
        return {
          imageData: new ImageData(new Uint8ClampedArray(view), fallback.width, fallback.height),
          meta: result
        };
      }
      if (view.length === fallback.width * fallback.height) {
        const output = cloneImageData(fallback);
        for (let pixel = 0; pixel < view.length; pixel += 1) output.data[pixel * 4 + 3] = view[pixel];
        return { imageData: output, meta: result };
      }
    }
  }

  if (!equalBytes(before, fallback.data)) return { imageData: fallback, meta: result };
  return null;
}

function makeImageData(width, height, pixelAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgba = pixelAt(x, y);
      data.set(rgba, (y * width + x) * 4);
    }
  }
  return new ImageData(data, width, height);
}

function softCircleImage(width, height, cx, cy, radius) {
  return makeImageData(width, height, (x, y) => {
    const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const alpha = clampByte(128 + (radius - distance) * 255);
    return [124, 176, 214, alpha];
  });
}

function smartEdgeOptions() {
  return {
    mode: "smart",
    treatment: "smart",
    strength: 0.8,
    strengthPercent: 80,
    radius: 4,
    detailProtection: 1,
    detailProtectionPixels: 1,
    preserveSoftAlpha: true
  };
}

function contourOptions(overrides = {}) {
  const smoothing = overrides.smoothing ?? 1;
  const offset = overrides.offset ?? 0;
  return {
    alphaThreshold: 128,
    threshold: 128,
    simplifyTolerance: smoothing,
    smoothing,
    curveSmoothing: smoothing,
    offsetPixels: offset,
    offset,
    minArea: 1,
    ...overrides
  };
}

function contourPaths(contour) {
  if (Array.isArray(contour?.paths)) return contour.paths;
  if (Array.isArray(contour?.contours)) return contour.contours;
  if (Array.isArray(contour)) return contour;
  return [];
}

function largestPath(contour) {
  const paths = contourPaths(contour);
  assert(paths.length > 0, "no contour paths were returned");
  return paths.reduce((largest, candidate) => pathArea(candidate) > pathArea(largest) ? candidate : largest);
}

function pathArea(pathValue) {
  if (Number.isFinite(pathValue?.area)) return Math.abs(pathValue.area);
  const points = rawPathPoints(pathValue);
  if (points.length < 3) return 0;
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    area += point.x * next.y - next.x * point.y;
  }
  return Math.abs(area / 2);
}

function samplePath(pathValue, samplesPerCurve = 8) {
  const points = rawPathPoints(pathValue);
  const curves = pathValue?.curves || pathValue?.beziers || pathValue?.segments;
  if (!Array.isArray(curves) || curves.length === 0 || points.length === 0) return points;

  const samples = [];
  let from = points[0];
  for (const curve of curves) {
    const p0 = curve.p0 || curve.from || from;
    const p1 = curve.p1 || curve.c1 || curve.control1;
    const p2 = curve.p2 || curve.c2 || curve.control2;
    const p3 = curve.p3 || curve.to || curve.end;
    if (!isPoint(p0) || !isPoint(p1) || !isPoint(p2) || !isPoint(p3)) continue;
    for (let step = 0; step < samplesPerCurve; step += 1) {
      const t = step / samplesPerCurve;
      samples.push(cubicPoint(p0, p1, p2, p3, t));
    }
    from = p3;
  }
  return samples.length ? samples : points;
}

function rawPathPoints(pathValue) {
  const points = pathValue?.points || pathValue?.samples || pathValue?.vertices || [];
  return Array.isArray(points) ? points.filter(isPoint) : [];
}

function cubicPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  };
}

function cloneImageData(imageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function ensureImageData(value) {
  if (value instanceof ImageData) return value;
  return new ImageData(new Uint8ClampedArray(value.data), value.width, value.height);
}

function isImageDataLike(value) {
  return Number.isInteger(value?.width) && Number.isInteger(value?.height) && value?.data?.length === value.width * value.height * 4;
}

function isPoint(value) {
  return Number.isFinite(value?.x) && Number.isFinite(value?.y);
}

function alphaAt(imageData, x, y) {
  return imageData.data[(y * imageData.width + x) * 4 + 3];
}

function rgbAt(imageData, x, y) {
  const index = (y * imageData.width + x) * 4;
  return Array.from(imageData.data.slice(index, index + 3));
}

function meanRadius(points, cx, cy) {
  assert(points.length > 0, "contour path has no measurable points");
  return mean(points.map((point) => Math.hypot(point.x - cx, point.y - cy)));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

function normalizeRoi(roi, width, height) {
  const x = Math.max(0, Math.floor(Number(roi?.x ?? roi?.left ?? 0)));
  const y = Math.max(0, Math.floor(Number(roi?.y ?? roi?.top ?? 0)));
  const right = Number(roi?.right);
  const bottom = Number(roi?.bottom);
  const roiWidth = Number.isFinite(Number(roi?.width)) ? Number(roi.width) : right - x + 1;
  const roiHeight = Number.isFinite(Number(roi?.height)) ? Number(roi.height) : bottom - y + 1;
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.ceil(roiWidth))),
    height: Math.max(1, Math.min(height - y, Math.ceil(roiHeight)))
  };
}

function pointInRoi(x, y, roi) {
  return x >= roi.x && y >= roi.y && x < roi.x + roi.width && y < roi.y + roi.height;
}

function pixelDiffers(a, b, pixel) {
  const index = pixel * 4;
  return a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3];
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

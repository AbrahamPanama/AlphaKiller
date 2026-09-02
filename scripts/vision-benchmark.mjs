import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const MAX_SIZE = 2048;

if (typeof globalThis.ImageData === "undefined") {
  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
}

const args = parseArgs(process.argv.slice(2));
const sizes = normalizeSizes(args.sizes || process.env.VISION_BENCH_SIZES || "256,512,1024");
const runs = clampInteger(args.runs || process.env.VISION_BENCH_RUNS || 3, 1, 20);
const json = args.json === true;

const FEATURE_SPECS = {
  smartEdge: {
    label: "Smart Edge",
    paths: [
      "src/vision/smartEdge.js", "src/vision/smartEdgePolish.js", "src/vision/edgePolish.js",
      "src/opencv/smartEdge.js", "src/cv/smartEdge.js", "src/visionProcessing.js", "src/smartEdge.js", "src/imageProcessing.js"
    ],
    exports: [
      "applySmartEdgePolish", "smartEdgePolish", "refineAlphaEdges",
      "refineAlphaMatte", "applyGuidedAlphaRefinement"
    ]
  },
  autoRim: {
    label: "Auto Edge Color",
    paths: [
      "src/vision/autoRimColor.js", "src/vision/edgeColor.js", "src/vision/edgeFinisher.js",
      "src/opencv/autoRimColor.js", "src/cv/autoRimColor.js", "src/visionProcessing.js", "src/smartEdge.js", "src/imageProcessing.js"
    ],
    exports: [
      "applyAutoRimColor", "reconstructEdgeColors", "finishAutoEdgeColor",
      "applySmartEdgeColor", "reconstructRimRgb", "autoRimColor"
    ]
  },
  contour: {
    label: "Contour",
    paths: [
      "src/vision/contourEngine.js", "src/vision/subpixelContour.js", "src/opencv/contourEngine.js",
      "src/cv/contourEngine.js", "src/contourEngine.js", "src/vectorTrace.js"
    ],
    exports: ["traceSubpixelContour", "traceContourEngine", "traceVectorContourV2", "traceContour", "traceVectorContour"]
  },
  smartBrush: {
    label: "Smart Brush",
    paths: [
      "src/vision/smartBrush.js", "src/vision/smartPen.js", "src/opencv/smartBrush.js",
      "src/cv/smartBrush.js", "src/smartBrush.js", "src/brushProcessing.js", "src/imageProcessing.js"
    ],
    exports: [
      "applySmartBrushStroke", "applySmartBrush", "applySmartBrushEdit",
      "runSmartBrush", "refineBrushRoi", "applySmartCorrection"
    ]
  }
};

const operations = [
  { feature: "smartEdge", run: benchmarkSmartEdge },
  { feature: "autoRim", run: benchmarkAutoRim },
  { feature: "contour", run: benchmarkContour },
  { feature: "smartBrush", run: benchmarkSmartBrush }
];
const rows = [];
let benchmarkSink = 0;

for (const operation of operations) {
  const feature = await loadFeature(operation.feature);
  if (!feature.available) {
    rows.push({ feature: FEATURE_SPECS[operation.feature].label, status: feature.error ? "ERROR" : "SKIP", reason: feature.error?.message || feature.reason });
    continue;
  }

  for (const size of sizes) {
    try {
      const fixture = makeBenchmarkFixture(size);
      const coldStart = performance.now();
      await operation.run(feature, fixture);
      const coldMs = performance.now() - coldStart;
      const timings = [];
      for (let iteration = 0; iteration < runs; iteration += 1) {
        const started = performance.now();
        await operation.run(feature, fixture);
        timings.push(performance.now() - started);
      }
      const medianMs = percentile(timings, 0.5);
      const p95Ms = percentile(timings, 0.95);
      const megapixels = size * size / 1_000_000;
      rows.push({
        feature: feature.label,
        implementation: `${feature.modulePath}:${feature.exportName}`,
        status: "OK",
        size,
        pixels: size * size,
        coldMs,
        medianMs,
        p95Ms,
        megapixelsPerSecond: medianMs > 0 ? megapixels / (medianMs / 1000) : Infinity
      });
    } catch (error) {
      rows.push({
        feature: feature.label,
        implementation: `${feature.modulePath}:${feature.exportName}`,
        status: "ERROR",
        size,
        reason: error.message
      });
    }
  }
}

if (json) {
  console.log(JSON.stringify({ sizes, runs, maxSize: MAX_SIZE, rows }, null, 2));
} else {
  printTable(rows, sizes, runs);
}

if (rows.some((row) => row.status === "ERROR")) process.exitCode = 1;

async function benchmarkSmartEdge(feature, fixture) {
  const result = await invokeImageFeature(feature, fixture.image, {
    mode: "smart",
    treatment: "smart",
    strength: 0.8,
    strengthPercent: 80,
    radius: 4,
    detailProtection: 1,
    preserveSoftAlpha: true
  });
  consume(result.data);
}

async function benchmarkAutoRim(feature, fixture) {
  const result = await invokeImageFeature(feature, fixture.image, {
    mode: "auto",
    rimColorMode: "auto",
    cutoff: 128,
    edgeWidth: 2,
    radius: 2,
    detailProtection: 1
  });
  consume(result.data);
}

async function benchmarkContour(feature, fixture) {
  const options = {
    alphaThreshold: 128,
    threshold: 128,
    simplifyTolerance: 2,
    smoothing: 2,
    curveSmoothing: 2,
    offsetPixels: 2,
    offset: 2,
    minArea: 2
  };
  const result = await invokeContour(feature, fixture.image, options);
  consume(result?.pointCount ?? result?.paths?.length ?? result?.contours?.length ?? 0);
}

async function benchmarkSmartBrush(feature, fixture) {
  const radius = Math.max(3, Math.round(fixture.size / 96));
  const stroke = {
    points: [
      { x: fixture.size * 0.43, y: fixture.size * 0.5 },
      { x: fixture.size * 0.57, y: fixture.size * 0.5 }
    ],
    radius,
    size: radius * 2
  };
  const result = await invokeSmartBrush(feature, fixture.current, fixture.image, stroke, {
    mode: "restore",
    action: "foreground",
    padding: Math.max(8, radius * 2),
    roiPadding: Math.max(8, radius * 2),
    iterations: 4,
    deterministic: true,
    returnFullImage: true
  });
  consume(result.imageData.data);
}

async function loadFeature(name) {
  const spec = FEATURE_SPECS[name];
  const seenModules = [];
  for (const relativePath of spec.paths) {
    const absolutePath = path.join(PROJECT_ROOT, relativePath);
    if (!existsSync(absolutePath)) continue;
    seenModules.push(relativePath);
    let module;
    try {
      module = await import(`${pathToFileURL(absolutePath).href}?vision-benchmark=${statSync(absolutePath).mtimeMs}`);
    } catch (error) {
      return { available: false, error: new Error(`${relativePath} failed to import: ${error.message}`) };
    }
    for (const exportName of spec.exports) {
      if (typeof module[exportName] === "function") {
        return { available: true, label: spec.label, modulePath: relativePath, exportName, fn: module[exportName] };
      }
    }
  }
  return {
    available: false,
    reason: seenModules.length
      ? `no supported export in ${seenModules.join(", ")} (expected ${spec.exports.join(", ")})`
      : `module not available (searched ${spec.paths.join(", ")})`
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
      errors.push("no image result");
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${feature.exportName} invocation failed: ${errors.join(" | ")}`);
}

async function invokeContour(feature, imageData, options) {
  const errors = [];
  for (const attempt of [
    () => feature.fn(cloneImageData(imageData), options),
    () => feature.fn({ imageData: cloneImageData(imageData), options, ...options })
  ]) {
    try {
      const result = await attempt();
      const contour = result?.contour || result;
      if (contour) return contour;
      errors.push("no contour result");
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${feature.exportName} invocation failed: ${errors.join(" | ")}`);
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
      errors.push("no image result");
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error(`${feature.exportName} invocation failed: ${errors.join(" | ")}`);
}

function normalizeImageResult(result, fallback, before) {
  const candidates = [
    result, result?.imageData, result?.image, result?.output, result?.result,
    result?.processedImageData, result?.mask, result?.alpha, result?.data
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isImageDataLike(candidate)) {
      return { imageData: ensureImageData(candidate), meta: result };
    }
    if (ArrayBuffer.isView(candidate) || candidate instanceof ArrayBuffer) {
      const view = candidate instanceof ArrayBuffer ? new Uint8Array(candidate) : candidate;
      if (view.length === fallback.width * fallback.height * 4) {
        return { imageData: new ImageData(new Uint8ClampedArray(view), fallback.width, fallback.height), meta: result };
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

function makeBenchmarkFixture(size) {
  const center = size / 2;
  const radius = size * 0.31;
  const image = makeImageData(size, size, (x, y) => {
    const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
    let alpha = clampByte(128 + (radius - distance) * 192);
    const branchY = Math.round(size * 0.36);
    if (x >= Math.round(center) && x < size * 0.9 && Math.abs(y - branchY) <= 1) alpha = Math.max(alpha, y === branchY ? 255 : 72);
    const redSide = x < center;
    const stripe = ((x >> 4) + (y >> 4)) & 1;
    return redSide
      ? [210, 48 + stripe * 24, 60, alpha]
      : [38, 84 + stripe * 20, 220, alpha];
  });
  const current = cloneImageData(image);
  const patchRadius = Math.max(4, Math.round(size * 0.045));
  for (let y = Math.floor(center - patchRadius); y <= Math.ceil(center + patchRadius); y += 1) {
    for (let x = Math.floor(center - patchRadius); x <= Math.ceil(center + patchRadius); x += 1) {
      if (x >= 0 && y >= 0 && x < size && y < size) current.data[(y * size + x) * 4 + 3] = 0;
    }
  }
  return { size, image, current };
}

function makeImageData(width, height, pixelAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixelAt(x, y), (y * width + x) * 4);
  }
  return new ImageData(data, width, height);
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

function parseArgs(values) {
  const output = {};
  for (const value of values) {
    if (value === "--json") output.json = true;
    else if (value.startsWith("--sizes=")) output.sizes = value.slice("--sizes=".length);
    else if (value.startsWith("--runs=")) output.runs = value.slice("--runs=".length);
  }
  return output;
}

function normalizeSizes(value) {
  const parsed = String(value)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((size) => Number.isInteger(size) && size >= 32)
    .map((size) => Math.min(size, MAX_SIZE));
  return [...new Set(parsed.length ? parsed : [256, 512, 1024])].sort((a, b) => a - b);
}

function clampInteger(value, min, max) {
  const parsed = Math.round(Number(value));
  return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : min));
}

function percentile(values, quantile) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))] ?? 0;
}

function printTable(outputRows, benchmarkSizes, benchmarkRuns) {
  console.log(`Vision benchmark: sizes ${benchmarkSizes.join(", ")}; ${benchmarkRuns} warm run(s); maximum ${MAX_SIZE}px`);
  console.log("FEATURE          SIZE    COLD MS  MEDIAN MS  P95 MS   MP/S     IMPLEMENTATION");
  for (const row of outputRows) {
    if (row.status !== "OK") {
      console.log(`${row.status.padEnd(16)} ${row.feature}: ${row.reason}`);
      continue;
    }
    console.log([
      row.feature.padEnd(16),
      `${row.size}²`.padStart(7),
      row.coldMs.toFixed(1).padStart(8),
      row.medianMs.toFixed(1).padStart(10),
      row.p95Ms.toFixed(1).padStart(8),
      row.megapixelsPerSecond.toFixed(2).padStart(8),
      `  ${row.implementation}`
    ].join(" "));
  }
  console.log("\nUse --sizes=256,512 --runs=5 or --json. Sizes above 2048 are clamped.");
}

function consume(value) {
  if (typeof value === "number") benchmarkSink ^= value | 0;
  else if (value?.length) benchmarkSink ^= value[0] | 0;
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

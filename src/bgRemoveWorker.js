import { buildTrimap } from "./imageProcessing.js";

const STAGE1_MODEL = "briaai/RMBG-1.4";
const STAGE2_MODEL = "hustvl/ViTMatte-base";
const STAGE1_CONFIG = { model_type: "segformer" };
const DEFAULT_TILE_THRESHOLD = 2048;
const SMALL_TILE_SIZE = 1536;
const LARGE_TILE_SIZE = 1024;
const TILE_OVERLAP = 128;

let transformersPromise = null;
let stage1Promise = null;
let stage2Promise = null;
let stage1AccessPromise = null;
let hfToken = "";
const cancelledJobs = new Set();

self.onmessage = async (event) => {
  const { type, id, buffer, width, height, options = {} } = event.data || {};

  if (type === "cancel") {
    cancelledJobs.add(id);
    return;
  }

  if (type !== "run") return;

  const startedAt = performance.now();
  const stagesRun = ["stage1"];
  let currentStage = "warming";

  try {
    setHuggingFaceToken(options.hfToken);
    postProgress(id, "warming", 0);
    const { RawImage } = await getTransformers();
    if (isCancelled(id)) return;

    const source = new RawImage(new Uint8ClampedArray(buffer), width, height, 4);
    const stage1 = await getStage1(id);
    if (isCancelled(id)) return;

    currentStage = "infer-stage1";
    const mask = await runStage1(source, {
      id,
      segmenter: stage1.segmenter,
      tta: options.tta !== false,
      tileThreshold: options.tileThreshold ?? DEFAULT_TILE_THRESHOLD,
      refine: options.refine === true,
      device: stage1.device
    });
    if (isCancelled(id)) return;

    let finalMask = mask;
    if (options.refine === true) {
      stagesRun.push("stage2");
      currentStage = "infer-stage2";
      finalMask = await refineMask(source, mask, id, stage1.device);
      if (isCancelled(id)) return;
    }

    currentStage = "compose";
    postProgress(id, "compose", 0.96, { device: stage1.device });
    const maskMean = meanMask(finalMask);
    const maskBuffer = finalMask.buffer;
    self.postMessage({
      type: "result",
      id,
      width,
      height,
      buffer: maskBuffer,
      maskBuffer,
      durationMs: performance.now() - startedAt,
      device: stage1.device,
      maskMean,
      stagesRun
    }, [maskBuffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      stage: currentStage,
      error: normalizeError(error)
    });
  } finally {
    cancelledJobs.delete(id);
  }
};

async function getTransformers() {
  if (!transformersPromise) {
    transformersPromise = import("@huggingface/transformers").then((module) => {
      module.env.allowRemoteModels = true;
      module.env.allowLocalModels = false;
      module.env.useBrowserCache = true;
      module.env.fetch = fetchWithAuth;
      return module;
    });
  }
  return transformersPromise;
}

function setHuggingFaceToken(token) {
  const nextToken = typeof token === "string" ? token.trim() : "";
  if (nextToken === hfToken) return;
  hfToken = nextToken;
  stage1AccessPromise = null;
}

async function getStage1(id) {
  if (stage1Promise) return stage1Promise;

  stage1Promise = loadStage1(id).catch((error) => {
    stage1Promise = null;
    throw error;
  });
  return stage1Promise;
}

async function loadStage1(id) {
  const { pipeline } = await getTransformers();
  const wantsGpu = Boolean(self.navigator?.gpu);
  await assertStage1Accessible();

  const attempts = [];
  if (wantsGpu) {
    attempts.push({ runtime: "webgpu", dtype: "fp16", label: "gpu" });
  }
  attempts.push(
    { runtime: "wasm", dtype: "uint8", label: "cpu" },
    { runtime: "wasm", dtype: "q4", label: "cpu" },
    { runtime: "wasm", dtype: "q8", label: "cpu" },
    { runtime: "wasm", dtype: "fp32", label: "cpu" }
  );

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const segmenter = await pipeline("image-segmentation", STAGE1_MODEL, {
        ...(STAGE1_CONFIG ? { config: STAGE1_CONFIG } : {}),
        device: attempt.runtime,
        dtype: attempt.dtype,
        session_options: { graphOptimizationLevel: "disabled" },
        progress_callback: (progress) => postModelProgress(id, progress)
      });
      postProgress(id, "warming", 1, { device: attempt.label });
      return { segmenter, device: attempt.label };
    } catch (error) {
      lastError = error;
      if (isModelAccessError(error)) throw error;
    }
  }

  if (lastError) {
    if (isModelAccessError(lastError)) throw lastError;
    throw lastError;
  }
  throw new Error("No background-removal runtime was available.");
}

async function assertStage1Accessible() {
  if (stage1AccessPromise) return stage1AccessPromise;

  stage1AccessPromise = fetchWithAuth(`https://huggingface.co/${STAGE1_MODEL}/resolve/main/config.json`)
    .then(async (response) => {
      if (response.ok) return;
      const errorCode = response.headers.get("x-error-code") || "";
      const message = await response.text().catch(() => "");
      if (response.status === 401 || errorCode.toLowerCase() === "gatedrepo" || isModelAccessError(message)) {
        throw new Error(`The Hugging Face model request was rejected for ${STAGE1_MODEL}. Confirm the token has read permission if this repository becomes gated.`);
      }
      throw new Error(`Could not download the background removal model (${response.status} ${response.statusText}).`);
    })
    .catch((error) => {
      stage1AccessPromise = null;
      throw error;
    });

  return stage1AccessPromise;
}

function fetchWithAuth(input, init = {}) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  const headers = new Headers(init.headers || input?.headers || {});
  if (hfToken && shouldAuthenticate(url)) {
    headers.set("Authorization", `Bearer ${hfToken}`);
  }
  return fetch(input, { ...init, headers });
}

function shouldAuthenticate(url) {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === "huggingface.co" || hostname.endsWith(".huggingface.co");
  } catch {
    return false;
  }
}

async function getStage2(id, device) {
  if (stage2Promise) return stage2Promise;

  stage2Promise = loadStage2(id, device).catch((error) => {
    stage2Promise = null;
    throw error;
  });
  return stage2Promise;
}

async function loadStage2(id, device) {
  const { AutoProcessor, VitMatteForImageMatting } = await getTransformers();
  const modelOptions = {
    device: device === "gpu" ? "webgpu" : "wasm",
    dtype: device === "gpu" ? "fp16" : "q8",
    progress_callback: (progress) => postModelProgress(id, progress)
  };
  try {
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(STAGE2_MODEL, modelOptions),
      VitMatteForImageMatting.from_pretrained(STAGE2_MODEL, modelOptions)
    ]);
    return { processor, model };
  } catch (error) {
    if (device !== "gpu" || isModelAccessError(error)) throw error;
    const fallbackOptions = {
      device: "wasm",
      dtype: "q8",
      progress_callback: (progress) => postModelProgress(id, progress)
    };
    const [processor, model] = await Promise.all([
      AutoProcessor.from_pretrained(STAGE2_MODEL, fallbackOptions),
      VitMatteForImageMatting.from_pretrained(STAGE2_MODEL, fallbackOptions)
    ]);
    return { processor, model };
  }
}

async function runStage1(source, options) {
  const maxEdge = Math.max(source.width, source.height);
  if (maxEdge <= options.tileThreshold) {
    const passes = getAugmentations(options.tta, 4);
    return segmentWithTta(source, source.width, source.height, passes, options, (done, total) => {
      postProgress(options.id, "infer-stage1", scaledProgress(done / total, options.refine), { device: options.device });
    });
  }

  const huge = maxEdge > 4096;
  const tileSize = huge ? LARGE_TILE_SIZE : SMALL_TILE_SIZE;
  const passes = getAugmentations(options.tta, huge ? 2 : 4);
  const tiles = createTiles(source.width, source.height, tileSize, TILE_OVERLAP);
  const accum = new Float32Array(source.width * source.height);
  const weights = new Float32Array(source.width * source.height);
  let completed = 0;
  const total = tiles.length * passes.length;

  for (const tile of tiles) {
    if (isCancelled(options.id)) return new Uint8Array(source.width * source.height);
    const tileImage = cropRawImage(source, tile.x, tile.y, tile.width, tile.height);
    const tileMask = await segmentWithTta(tileImage, tile.width, tile.height, passes, options, (done) => {
      postProgress(options.id, "infer-stage1", scaledProgress((completed + done) / total, options.refine), { device: options.device });
    });
    completed += passes.length;
    blendTileMask(tileMask, tile, source.width, source.height, accum, weights);
  }

  const output = new Uint8Array(source.width * source.height);
  for (let i = 0; i < output.length; i++) {
    output[i] = Math.round(weights[i] > 0 ? accum[i] / weights[i] : 0);
  }
  return output;
}

async function segmentWithTta(source, width, height, passes, options, onProgress) {
  const sum = new Float32Array(width * height);

  for (let i = 0; i < passes.length; i++) {
    if (isCancelled(options.id)) return new Uint8Array(width * height);
    const pass = passes[i];
    const augmented = pass === "identity" ? source : augmentRawImage(source, pass);
    const mask = await segmentOnce(options.segmenter, augmented, width, height);
    const restored = pass === "identity" ? mask : unaugmentMask(mask, width, height, pass);
    for (let pixel = 0; pixel < sum.length; pixel++) {
      sum[pixel] += restored[pixel];
    }
    onProgress?.(i + 1, passes.length);
  }

  const output = new Uint8Array(width * height);
  for (let pixel = 0; pixel < output.length; pixel++) {
    output[pixel] = Math.round(sum[pixel] / passes.length);
  }
  return output;
}

async function segmentOnce(segmenter, image, width, height) {
  const result = await segmenter(image);
  const first = Array.isArray(result) ? result[0] : result;
  if (!first?.mask) {
    throw new Error("Background model did not return a segmentation mask");
  }
  return rawMaskToUint8(first.mask, width, height);
}

async function refineMask(source, mask, id, device) {
  postProgress(id, "infer-stage2", 0.78, { device });
  const { RawImage } = await getTransformers();
  const trimap = buildTrimap(mask, source.width, source.height, { dilateRadius: 8 });
  const trimapImage = new RawImage(trimap, source.width, source.height, 1);
  const { processor, model } = await getStage2(id, device);
  const inputs = await processor(source, trimapImage);
  const { alphas } = await model(inputs);
  const alpha = tensorAlphaToMask(alphas);
  const output = alpha.width === source.width && alpha.height === source.height
    ? alpha.data
    : (await new RawImage(alpha.data, alpha.width, alpha.height, 1).resize(source.width, source.height)).data;
  postProgress(id, "infer-stage2", 0.94, { device });
  return new Uint8Array(output);
}

function tensorAlphaToMask(tensor) {
  const dims = tensor.dims;
  const width = dims[dims.length - 1];
  const height = dims[dims.length - 2];
  const data = new Uint8Array(width * height);

  for (let i = 0; i < data.length; i++) {
    data[i] = Math.max(0, Math.min(255, Math.round(tensor.data[i] * 255)));
  }

  return { data, width, height };
}

function rawMaskToUint8(mask, width, height) {
  if (mask.width !== width || mask.height !== height) {
    throw new Error(`Expected mask size ${width}x${height}, got ${mask.width}x${mask.height}`);
  }

  const output = new Uint8Array(width * height);
  if (mask.channels === 1) {
    output.set(mask.data.slice(0, output.length));
    return output;
  }

  for (let pixel = 0, index = 0; pixel < output.length; pixel++, index += mask.channels) {
    output[pixel] = mask.channels >= 4
      ? mask.data[index + 3]
      : Math.round((mask.data[index] + mask.data[index + 1] + mask.data[index + 2]) / 3);
  }
  return output;
}

function getAugmentations(tta, maxPasses) {
  if (!tta) return ["identity"];
  return ["identity", "hflip", "rot180", "hflipRot180"].slice(0, maxPasses);
}

function augmentRawImage(image, pass) {
  const data = new Uint8ClampedArray(image.data.length);
  const channels = image.channels;

  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const { x: sourceX, y: sourceY } = transformPoint(x, y, image.width, image.height, pass);
      const sourceIndex = (sourceY * image.width + sourceX) * channels;
      const targetIndex = (y * image.width + x) * channels;
      for (let channel = 0; channel < channels; channel++) {
        data[targetIndex + channel] = image.data[sourceIndex + channel];
      }
    }
  }

  return new image.constructor(data, image.width, image.height, channels);
}

function unaugmentMask(mask, width, height, pass) {
  const output = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const { x: sourceX, y: sourceY } = transformPoint(x, y, width, height, pass);
      output[y * width + x] = mask[sourceY * width + sourceX];
    }
  }
  return output;
}

function transformPoint(x, y, width, height, pass) {
  if (pass === "hflip") return { x: width - 1 - x, y };
  if (pass === "rot180") return { x: width - 1 - x, y: height - 1 - y };
  if (pass === "hflipRot180") return { x, y: height - 1 - y };
  return { x, y };
}

function cropRawImage(source, x, y, width, height) {
  const data = new Uint8ClampedArray(width * height * source.channels);
  for (let row = 0; row < height; row++) {
    const sourceStart = ((y + row) * source.width + x) * source.channels;
    const targetStart = row * width * source.channels;
    data.set(source.data.subarray(sourceStart, sourceStart + width * source.channels), targetStart);
  }
  return new source.constructor(data, width, height, source.channels);
}

function createTiles(width, height, tileSize, overlap) {
  const xs = tileStarts(width, tileSize, overlap);
  const ys = tileStarts(height, tileSize, overlap);
  const tiles = [];
  for (const y of ys) {
    for (const x of xs) {
      tiles.push({
        x,
        y,
        width: Math.min(tileSize, width - x),
        height: Math.min(tileSize, height - y)
      });
    }
  }
  return tiles;
}

function tileStarts(size, tileSize, overlap) {
  if (size <= tileSize) return [0];
  const step = Math.max(1, tileSize - overlap);
  const starts = [];
  for (let start = 0; start < size; start += step) {
    starts.push(Math.min(start, size - tileSize));
    if (starts.at(-1) === size - tileSize) break;
  }
  return [...new Set(starts)];
}

function blendTileMask(mask, tile, fullWidth, fullHeight, accum, weights) {
  for (let y = 0; y < tile.height; y++) {
    for (let x = 0; x < tile.width; x++) {
      const fullX = tile.x + x;
      const fullY = tile.y + y;
      const outputIndex = fullY * fullWidth + fullX;
      const weight = tileWeight(x, y, tile, fullWidth, fullHeight);
      accum[outputIndex] += mask[y * tile.width + x] * weight;
      weights[outputIndex] += weight;
    }
  }
}

function tileWeight(x, y, tile, fullWidth, fullHeight) {
  return axisWeight(x, tile.x, tile.width, fullWidth) * axisWeight(y, tile.y, tile.height, fullHeight);
}

function axisWeight(local, tileStart, tileSize, fullSize) {
  let weight = 1;
  if (tileStart > 0 && local < TILE_OVERLAP) {
    weight *= raisedCosine(local / TILE_OVERLAP);
  }
  if (tileStart + tileSize < fullSize && tileSize - 1 - local < TILE_OVERLAP) {
    weight *= raisedCosine((tileSize - 1 - local) / TILE_OVERLAP);
  }
  return Math.max(0.001, weight);
}

function raisedCosine(t) {
  const x = Math.max(0, Math.min(1, t));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

function scaledProgress(value, refine) {
  return value * (refine ? 0.74 : 0.9);
}

function postModelProgress(id, progress) {
  if (progress?.status === "progress") {
    postProgress(id, "download", progress.progress ? progress.progress / 100 : 0);
  } else if (progress?.status === "download" || progress?.status === "initiate") {
    postProgress(id, "download", 0);
  } else if (progress?.status === "done") {
    postProgress(id, "download", 1);
  } else if (progress?.status === "ready") {
    postProgress(id, "warming", 1);
  }
}

function postProgress(id, stage, progress, extra = {}) {
  self.postMessage({
    type: "progress",
    id,
    stage,
    progress: Math.max(0, Math.min(1, progress)),
    ...extra
  });
}

function meanMask(mask) {
  let sum = 0;
  for (let i = 0; i < mask.length; i++) {
    sum += mask[i];
  }
  return mask.length ? sum / (mask.length * 255) : 0;
}

function isCancelled(id) {
  return cancelledJobs.has(id);
}

function isModelAccessError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("unauthorized") ||
    message.includes("authorization") ||
    message.includes("gatedrepo") ||
    message.includes("restricted") ||
    message.includes("access to model") ||
    message.includes("401") ||
    message.includes("rmbg-2.0") && (message.includes("restricted") || message.includes("gated") || message.includes("unauthorized"));
}

function normalizeError(error) {
  const message = String(error?.message || error || "Background removal failed");
  const lower = message.toLowerCase();
  if (lower.includes("no hugging face token") || lower.includes("token was rejected")) {
    return message;
  }
  if (isModelAccessError(message)) {
    return `The background-removal model ${STAGE1_MODEL} is restricted on Hugging Face. Accept the model license and authenticate before retrying.`;
  }
  return message;
}

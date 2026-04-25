import { buildTrimap } from "./imageProcessing.js";

const STAGE2_MODEL = "hustvl/vitmatte-base-distinctions-646";
const DEFAULT_TILE_THRESHOLD = 2048;
const SMALL_TILE_SIZE = 1536;
const LARGE_TILE_SIZE = 1024;
const TILE_OVERLAP = 128;
const DEFAULT_STAGE1_MODEL_ID = "rmbg-1.4";
const STAGE1_MODELS = {
  "rmbg-1.4": {
    repoId: "briaai/RMBG-1.4",
    runtime: "pipeline",
    task: "image-segmentation",
    config: { model_type: "segformer" },
    nativeResolution: DEFAULT_TILE_THRESHOLD,
    tileSize: SMALL_TILE_SIZE,
    largeTileSize: LARGE_TILE_SIZE
  },
  ben2: {
    repoId: "onnx-community/BEN2-ONNX",
    runtime: "pipeline",
    task: "background-removal",
    nativeResolution: 1024,
    tileSize: 1024,
    largeTileSize: 1024,
    preferGpu: true,
    requiresGpu: true
  }
};

let transformersPromise = null;
const stage1Promises = new Map();
let stage2Promise = null;
const stage1AccessPromises = new Map();
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

    const modelId = normalizeStage1ModelId(options.modelId);
    const source = new RawImage(new Uint8ClampedArray(buffer), width, height, 4);
    const stage1 = await getStage1(id, modelId);
    if (isCancelled(id)) return;

    currentStage = "infer-stage1";
    const mask = await runStage1(source, {
      id,
      stage1,
      modelId,
      tta: options.tta !== false,
      tileThreshold: options.tileThreshold ?? DEFAULT_TILE_THRESHOLD,
      refine: options.refine === true,
      device: stage1.device
    });
    if (isCancelled(id)) return;

    let finalMask = mask;
    if (options.refine === true) {
      currentStage = "infer-stage2";
      try {
        finalMask = await refineMask(source, mask, id, stage1.device);
        stagesRun.push("stage2");
      } catch (error) {
        postProgress(id, "compose", 0.9, { device: stage1.device });
      }
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
      modelId,
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
  stage1AccessPromises.clear();
}

async function getStage1(id, modelId) {
  if (stage1Promises.has(modelId)) return stage1Promises.get(modelId);

  const promise = loadStage1(id, modelId).catch((error) => {
    stage1Promises.delete(modelId);
    throw error;
  });
  stage1Promises.set(modelId, promise);
  return promise;
}

async function loadStage1(id, modelId) {
  const descriptor = STAGE1_MODELS[modelId] || STAGE1_MODELS[DEFAULT_STAGE1_MODEL_ID];
  if (descriptor.runtime === "automodel") {
    return loadAutoModelStage1(id, modelId, descriptor);
  }
  return loadPipelineStage1(id, modelId, descriptor);
}

async function loadPipelineStage1(id, modelId, descriptor) {
  const { pipeline } = await getTransformers();
  const wantsGpu = Boolean(self.navigator?.gpu);
  if (descriptor.requiresGpu && !wantsGpu) {
    throw new Error(`${descriptor.repoId} requires WebGPU in AlphaKiller.`);
  }
  await assertStage1Accessible(descriptor);

  const attempts = [];
  if (wantsGpu && descriptor.preferGpu !== false) {
    attempts.push({ runtime: "webgpu", dtype: descriptor.gpuDtype || "fp16", label: "gpu" });
  }
  const cpuDtypes = descriptor.cpuDtypes || ["uint8", "q4", "q8", "fp32"];
  if (!descriptor.requiresGpu) {
    attempts.push(...cpuDtypes.map((dtype) => ({ runtime: "wasm", dtype, label: "cpu" })));
  }

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const segmenter = await pipeline(descriptor.task, descriptor.repoId, {
        ...(descriptor.config ? { config: descriptor.config } : {}),
        device: attempt.runtime,
        dtype: attempt.dtype,
        session_options: { graphOptimizationLevel: "disabled" },
        progress_callback: (progress) => postModelProgress(id, progress)
      });
      postProgress(id, "warming", 1, { device: attempt.label });
      return { runtime: "pipeline", segmenter, device: attempt.label, modelId, descriptor };
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

async function loadAutoModelStage1(id, modelId, descriptor, options = {}) {
  const { AutoModel, AutoProcessor } = await getTransformers();
  const wantsGpu = Boolean(self.navigator?.gpu);
  await assertStage1Accessible(descriptor);

  const attempts = [];
  if (wantsGpu && descriptor.preferGpu !== false && !options.cpuOnly) {
    attempts.push({ runtime: "webgpu", dtype: "fp16", label: "gpu" });
  }
  attempts.push(
    { runtime: "wasm", dtype: "fp16", label: "cpu" },
    { runtime: "wasm", dtype: "fp32", label: "cpu" }
  );

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const modelOptions = {
        device: attempt.runtime,
        dtype: attempt.dtype,
        progress_callback: (progress) => postModelProgress(id, progress)
      };
      const [model, processor] = await Promise.all([
        AutoModel.from_pretrained(descriptor.repoId, modelOptions),
        AutoProcessor.from_pretrained(descriptor.repoId, {
          progress_callback: (progress) => postModelProgress(id, progress)
        })
      ]);
      postProgress(id, "warming", 1, { device: attempt.label });
      return { runtime: "automodel", model, processor, device: attempt.label, modelId, descriptor, cpuOnly: options.cpuOnly === true };
    } catch (error) {
      lastError = error;
      if (isModelAccessError(error)) throw error;
    }
  }

  if (lastError) throw lastError;
  throw new Error("No background-removal runtime was available.");
}

async function assertStage1Accessible(descriptor) {
  if (stage1AccessPromises.has(descriptor.repoId)) {
    return stage1AccessPromises.get(descriptor.repoId);
  }

  const promise = fetchWithAuth(`https://huggingface.co/${descriptor.repoId}/resolve/main/config.json`)
    .then(async (response) => {
      if (response.ok) return;
      const errorCode = response.headers.get("x-error-code") || "";
      const message = await response.text().catch(() => "");
      if (response.status === 401 || errorCode.toLowerCase() === "gatedrepo" || isModelAccessError(message)) {
        throw new Error(`The Hugging Face model request was rejected for ${descriptor.repoId}. Confirm the token has read permission if this repository becomes gated.`);
      }
      throw new Error(`Could not download the background removal model (${response.status} ${response.statusText}).`);
    })
    .catch((error) => {
      stage1AccessPromises.delete(descriptor.repoId);
      throw error;
    });

  stage1AccessPromises.set(descriptor.repoId, promise);
  return promise;
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
  const strategy = chooseTileStrategy(source.width, source.height, options.stage1.descriptor, options);
  if (strategy.mode === "native") {
    const passes = getAugmentations(options.tta, 4);
    return segmentWithTta(source, source.width, source.height, passes, options, (done, total) => {
      postProgress(options.id, "infer-stage1", scaledProgress(done / total, options.refine), { device: options.device });
    });
  }

  const passes = getAugmentations(options.tta, strategy.maxPasses);
  const tiles = createTiles(source.width, source.height, strategy.tileSize, TILE_OVERLAP);
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

function chooseTileStrategy(width, height, descriptor, options) {
  const maxEdge = Math.max(width, height);
  const native = descriptor.nativeResolution || options.tileThreshold || DEFAULT_TILE_THRESHOLD;

  if (maxEdge <= native) {
    return { mode: "native" };
  }

  if (maxEdge <= native * 2) {
    return {
      mode: "tile",
      tileSize: descriptor.tileSize || native,
      maxPasses: descriptor.runtime === "automodel" ? 4 : 4
    };
  }

  return {
    mode: "tile",
    tileSize: descriptor.largeTileSize || Math.max(1024, Math.floor(native / 2)),
    maxPasses: 2
  };
}

async function segmentWithTta(source, width, height, passes, options, onProgress) {
  const sum = new Float32Array(width * height);

  for (let i = 0; i < passes.length; i++) {
    if (isCancelled(options.id)) return new Uint8Array(width * height);
    const pass = passes[i];
    const augmented = pass === "identity" ? source : augmentRawImage(source, pass);
    const mask = await segmentOnce(options.stage1, augmented, width, height, options);
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

async function segmentOnce(stage1, image, width, height, options) {
  if (stage1.runtime === "automodel") {
    return segmentOnceAutoModel(stage1, image, width, height, options);
  }

  const result = await stage1.segmenter(image);
  if (stage1.descriptor.task === "background-removal") {
    const removed = Array.isArray(result) ? result[0] : result;
    if (!removed) {
      throw new Error("Background model did not return a removal mask");
    }
    return rawMaskToUint8(removed, width, height);
  }

  const first = Array.isArray(result) ? result[0] : result;
  if (!first?.mask) {
    throw new Error("Background model did not return a segmentation mask");
  }
  return rawMaskToUint8(first.mask, width, height);
}

async function segmentOnceAutoModel(stage1, image, width, height, options) {
  const { RawImage } = await getTransformers();
  const inputImage = image.channels === 4 ? toCompositedRgbRawImage(image, RawImage) : image;

  try {
    const { pixel_values } = await stage1.processor(inputImage);
    const result = await stage1.model({ [stage1.descriptor.inputName]: pixel_values });
    const tensor = result?.[stage1.descriptor.outputName] || Object.values(result || {})[0];

    if (!tensor) {
      throw new Error("BiRefNet did not return an output mask tensor");
    }

    const maskImage = await tensorToMaskImage(tensor, stage1.descriptor, RawImage);
    const resized = maskImage.width === width && maskImage.height === height
      ? maskImage
      : await maskImage.resize(width, height);
    return rawMaskToUint8(resized, width, height);
  } catch (error) {
    if (!stage1.cpuOnly && isRecoverableGpuError(error)) {
      stage1.model?.dispose?.();
      const cpuStage1 = await loadAutoModelStage1(options.id, stage1.modelId, stage1.descriptor, { cpuOnly: true });
      stage1Promises.set(stage1.modelId, Promise.resolve(cpuStage1));
      options.stage1 = cpuStage1;
      postProgress(options.id, "infer-stage1", 0.02, { device: "cpu" });
      return segmentOnceAutoModel(cpuStage1, image, width, height, options);
    }
    throw error;
  }
}

async function tensorToMaskImage(tensor, descriptor, RawImage) {
  const imageTensor = tensor[0] || tensor;
  if (imageTensor.sigmoid && imageTensor.mul && imageTensor.to && RawImage.fromTensor) {
    const activated = descriptor.outputActivation === "sigmoid" ? imageTensor.sigmoid() : imageTensor;
    return RawImage.fromTensor(activated.mul(255).to("uint8"));
  }

  const dims = imageTensor.dims || tensor.dims;
  const data = imageTensor.data || tensor.data;
  const width = dims[dims.length - 1];
  const height = dims[dims.length - 2];
  const output = new Uint8Array(width * height);
  const offset = data.length >= output.length ? data.length - output.length : 0;

  for (let i = 0; i < output.length; i++) {
    const value = data[offset + i] ?? 0;
    const normalized = descriptor.outputActivation === "sigmoid" ? sigmoid(value) : value;
    output[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
  }

  return new RawImage(output, width, height, 1);
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

function toCompositedRgbRawImage(image, RawImage) {
  const output = new Uint8ClampedArray(image.width * image.height * 3);
  for (let pixel = 0, sourceIndex = 0, targetIndex = 0; pixel < image.width * image.height; pixel++, sourceIndex += image.channels, targetIndex += 3) {
    const alpha = image.channels >= 4 ? image.data[sourceIndex + 3] / 255 : 1;
    output[targetIndex] = Math.round(image.data[sourceIndex] * alpha + 255 * (1 - alpha));
    output[targetIndex + 1] = Math.round(image.data[sourceIndex + 1] * alpha + 255 * (1 - alpha));
    output[targetIndex + 2] = Math.round(image.data[sourceIndex + 2] * alpha + 255 * (1 - alpha));
  }
  return new RawImage(output, image.width, image.height, 3);
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

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function normalizeStage1ModelId(modelId) {
  return STAGE1_MODELS[modelId] ? modelId : DEFAULT_STAGE1_MODEL_ID;
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

function isRecoverableGpuError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("webgpu") ||
    message.includes("storage buffers") ||
    message.includes("shader") ||
    message.includes("ort_run") ||
    message.includes("ortrun") ||
    message.includes("failed to call");
}

function normalizeError(error) {
  const message = String(error?.message || error || "Background removal failed");
  const lower = message.toLowerCase();
  if (lower.includes("no hugging face token") || lower.includes("token was rejected")) {
    return message;
  }
  if (isModelAccessError(message)) {
    return "The background-removal model is restricted on Hugging Face. Accept the model license and authenticate before retrying.";
  }
  return message;
}

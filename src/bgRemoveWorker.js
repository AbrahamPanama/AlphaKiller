import { buildTrimap, constrainRefinedMask, cropPaddedMask } from "./imageProcessing.js";
import {
  applyAdaptiveTrimapLocks,
  applyCertainBackgroundVeto,
  buildAdaptiveStructureTrimap,
  buildCertainBackgroundMask,
  deriveSamPrompts,
  selectSamStructuralMask
} from "./structureMatting.js";
import {
  accumulateSegmentationTile,
  createSegmentationTiles,
  finishSegmentationTiles,
  fuseGuidedSegmentationMasks,
  scoreMaskBoundary
} from "./tiledSegmentation.js";

// Xenova conversion ships browser-ready ONNX (fp32 + q8); the upstream hustvl repos do not.
const STAGE2_MODEL = "Xenova/vitmatte-small-distinctions-646";
const STRUCTURE_MODEL = "onnx-community/sam3-tracker-ONNX";
const DEFAULT_TILE_THRESHOLD = 1024;
const DEFAULT_TILE_SIZE = 512;
const DEFAULT_STAGE1_MODEL_ID = "rmbg-1.4";
const STAGE1_MODELS = {
  "rmbg-1.4": {
    repoId: "briaai/RMBG-1.4",
    runtime: "pipeline",
    task: "image-segmentation",
    config: { model_type: "segformer" },
    nativeResolution: 1024,
    tileSize: 1024
  },
  ben2: {
    repoId: "onnx-community/BEN2-ONNX",
    runtime: "pipeline",
    task: "background-removal",
    nativeResolution: 1024,
    tileSize: 1024,
    preferGpu: true,
    requiresGpu: true
  }
};

let transformersPromise = null;
const stage1Promises = new Map();
let stage2Promise = null;
let structurePromise = null;
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
  const warnings = [];
  let structureMetrics = null;
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
    const stage1Result = await runStage1(source, {
      id,
      stage1,
      modelId,
      tta: options.tta !== false,
      tileThreshold: options.tileThreshold ?? DEFAULT_TILE_THRESHOLD,
      refine: options.refine === true,
      safeguards: normalizeSegmentationSafeguards(options.safeguards),
      device: stage1.device
    });
    if (isCancelled(id)) return;
    const mask = stage1Result.mask;
    const tileMetrics = stage1Result.metrics;
    if (tileMetrics.tiled) stagesRun.push("stage1-tiles");

    let conservativeMask = new Uint8Array(mask);
    let aggressiveMask = new Uint8Array(mask);
    if (options.refine === true) {
      currentStage = "infer-stage2";
      try {
        const refinedStages = await refineMask(source, mask, id, stage1.device, {
          structure: options.structure !== false
        });
        conservativeMask = refinedStages.conservativeMask;
        aggressiveMask = refinedStages.aggressiveMask;
        if (refinedStages.structureApplied) stagesRun.push("structure");
        stagesRun.push("stage2");
        structureMetrics = refinedStages.structureMetrics;
        if (refinedStages.warning) warnings.push(refinedStages.warning);
      } catch (error) {
        warnings.push(`Edge refinement fell back to Stage 1: ${normalizeError(error)}`);
        postProgress(id, "compose", 0.9, { device: stage1.device });
      }
      if (isCancelled(id)) return;
    }

    currentStage = "compose";
    postProgress(id, "compose", 0.96, { device: stage1.device });
    const stage1Mask = new Uint8Array(mask);
    const detailMask = new Uint8Array(conservativeMask);
    const cleanMask = new Uint8Array(aggressiveMask);
    const maskMean = meanMask(stage1Mask);
    const maskBuffer = detailMask.buffer;
    const aggressiveMaskBuffer = cleanMask.buffer;
    const stage1MaskBuffer = stage1Mask.buffer;
    self.postMessage({
      type: "result",
      id,
      width,
      height,
      buffer: maskBuffer,
      maskBuffer,
      aggressiveMaskBuffer,
      stage1MaskBuffer,
      durationMs: performance.now() - startedAt,
      device: stage1.device,
      maskMean,
      modelId,
      stagesRun,
      warnings,
      structureMetrics,
      tileMetrics
    }, [maskBuffer, aggressiveMaskBuffer, stage1MaskBuffer]);
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
    // The repo publishes model.onnx (fp32) and model_quantized.onnx (q8) only — no fp16.
    dtype: device === "gpu" ? "fp32" : "q8",
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

async function getStructureStage(id) {
  if (structurePromise) return structurePromise;

  structurePromise = loadStructureStage(id).catch((error) => {
    structurePromise = null;
    throw error;
  });
  return structurePromise;
}

async function loadStructureStage(id) {
  if (!self.navigator?.gpu) {
    throw new Error("SAM 3 structure locking requires WebGPU");
  }

  const { AutoProcessor, Sam3TrackerModel } = await getTransformers();
  await assertStage1Accessible({ repoId: STRUCTURE_MODEL });
  let lastError = null;
  for (const dtype of ["q4f16", "q4"]) {
    try {
      const modelOptions = {
        device: "webgpu",
        dtype,
        progress_callback: (progress) => postModelProgress(id, progress)
      };
      const [model, processor] = await Promise.all([
        Sam3TrackerModel.from_pretrained(STRUCTURE_MODEL, modelOptions),
        AutoProcessor.from_pretrained(STRUCTURE_MODEL, {
          progress_callback: (progress) => postModelProgress(id, progress)
        })
      ]);
      return { model, processor, device: "gpu", dtype };
    } catch (error) {
      lastError = error;
      if (isModelAccessError(error)) throw error;
    }
  }
  throw lastError || new Error("SAM 3 structure locking could not start");
}

async function runStructureStage(source, baseMask, id) {
  const prompts = deriveSamPrompts(baseMask, source.width, source.height, {
    maxPoints: 12
  });
  if (!prompts) throw new Error("Stage 1 did not produce a usable SAM prompt");

  postProgress(id, "infer-structure", 0.56, { device: "gpu" });
  const { RawImage } = await getTransformers();
  const { model, processor } = await getStructureStage(id);
  if (isCancelled(id)) return null;

  const inputImage = source.channels === 4 ? toCompositedRgbRawImage(source, RawImage) : source;
  const inputPoints = [[prompts.points.map((point) => [point.x, point.y])]];
  const inputLabels = [[prompts.labels]];
  const inputBoxes = [[prompts.box]];
  const inputs = await processor(inputImage, {
    input_points: inputPoints,
    input_labels: inputLabels,
    input_boxes: inputBoxes
  });
  const outputs = await model(inputs);
  if (isCancelled(id)) return null;

  const masks = await processor.post_process_masks(
    outputs.pred_masks,
    inputs.original_sizes,
    inputs.reshaped_input_sizes,
    { binarize: false }
  );
  const selected = selectSamStructuralMask(
    masks[0],
    outputs.iou_scores,
    baseMask,
    source.width,
    source.height
  );
  if (!selected) throw new Error("SAM 3 did not return a structurally plausible subject mask");

  postProgress(id, "infer-structure", 0.72, { device: "gpu" });
  return {
    mask: selected.mask,
    metrics: {
      promptCount: prompts.points.length,
      candidate: selected.candidate,
      score: selected.score,
      recall: selected.recall,
      precision: selected.precision,
      areaRatio: selected.areaRatio
    }
  };
}

async function runStage1(source, options) {
  const strategy = chooseTileStrategy(source.width, source.height, options.stage1.descriptor, options);
  const globalPasses = getAugmentations(options.tta, strategy.globalPasses);
  const globalMask = await segmentWithTta(
    source,
    source.width,
    source.height,
    globalPasses,
    options,
    (done, total) => {
      const progress = strategy.mode === "native"
        ? done / total
        : 0.35 * (done / total);
      postProgress(options.id, "infer-stage1", scaledProgress(progress, options.refine), {
        device: options.device
      });
    }
  );

  if (strategy.mode === "native") {
    return {
      mask: globalMask,
      metrics: {
        tiled: false,
        globalPasses: globalPasses.length,
        activeTiles: 0,
        skippedTiles: 0
      }
    };
  }

  const detailPasses = getAugmentations(options.tta, strategy.tilePasses);
  const tiles = createSegmentationTiles(
    source.width,
    source.height,
    strategy.tileSize,
    strategy.overlap
  );
  const activeTiles = tiles
    .map((tile) => ({
      tile,
      score: scoreMaskBoundary(globalMask, source.width, source.height, tile, {
        softLow: options.safeguards.seedThreshold,
        softHigh: options.safeguards.preserveThreshold,
        supportThreshold: options.safeguards.seedThreshold
      })
    }))
    .filter((entry) => entry.score >= 8)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.safeguards.maxDetailTiles)
    .map((entry) => entry.tile);
  const accum = new Float32Array(source.width * source.height);
  const weights = new Float32Array(source.width * source.height);
  let completed = 0;
  const total = Math.max(1, activeTiles.length * detailPasses.length);

  for (const tile of activeTiles) {
    if (isCancelled(options.id)) {
      return { mask: globalMask, metrics: { tiled: false, cancelled: true } };
    }
    const tileImage = cropRawImage(source, tile.x, tile.y, tile.width, tile.height);
    const tileMask = await segmentWithTta(tileImage, tile.width, tile.height, detailPasses, options, (done) => {
      const tileProgress = (completed + done) / total;
      postProgress(
        options.id,
        "infer-stage1",
        scaledProgress(0.35 + 0.65 * tileProgress, options.refine),
        { device: options.device }
      );
    });
    completed += detailPasses.length;
    accumulateSegmentationTile(
      tileMask,
      tile,
      source.width,
      source.height,
      accum,
      weights,
      strategy.overlap
    );
  }

  if (activeTiles.length === 0) {
    return {
      mask: globalMask,
      metrics: {
        tiled: false,
        globalPasses: globalPasses.length,
        activeTiles: 0,
        skippedTiles: tiles.length
      }
    };
  }

  const detailMask = finishSegmentationTiles(accum, weights);
  const fused = fuseGuidedSegmentationMasks(
    globalMask,
    detailMask,
    source.width,
    source.height,
    {
      seedThreshold: options.safeguards.seedThreshold,
      detailThreshold: options.safeguards.detailThreshold,
      preserveThreshold: options.safeguards.preserveThreshold,
      edgeBlend: options.safeguards.edgeBlend / 100,
      recoveryRadius: options.safeguards.recoveryRadius,
      matteAwareProtection: options.safeguards.matteAwareProtection,
      matteTolerance: options.safeguards.matteTolerance,
      matteBoundaryRadius: options.safeguards.matteBoundaryRadius,
      detailWeights: weights,
      sourcePixels: source.data,
      sourceChannels: source.channels
    }
  );
  return {
    mask: fused.mask,
    metrics: {
      tiled: true,
      tileSize: strategy.tileSize,
      overlap: strategy.overlap,
      globalPasses: globalPasses.length,
      tilePasses: detailPasses.length,
      activeTiles: activeTiles.length,
      skippedTiles: tiles.length - activeTiles.length,
      ...fused.stats
    }
  };
}

function chooseTileStrategy(width, height, descriptor, options) {
  const maxEdge = Math.max(width, height);
  const safeguards = options.safeguards || normalizeSegmentationSafeguards();
  const native = descriptor.nativeResolution || options.tileThreshold || DEFAULT_TILE_THRESHOLD;
  const tileSize = safeguards.detailTileSize || DEFAULT_TILE_SIZE;
  const tileTrigger = Math.max(640, Math.round(tileSize * 1.15));

  if (!safeguards.detailAnalysis || maxEdge <= tileTrigger) {
    return {
      mode: "native",
      globalPasses: maxEdge > 4096 ? 2 : 4
    };
  }

  return {
    mode: "guided-tile",
    tileSize,
    overlap: Math.max(64, Math.min(tileSize - 1, Math.round(tileSize * 0.25))),
    nativeResolution: native,
    globalPasses: maxEdge > 4096 ? 2 : 4,
    tilePasses: 1
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

async function refineMask(source, mask, id, device, options = {}) {
  let trimap = buildTrimap(mask, source.width, source.height, { dilateRadius: 4 });
  let structureApplied = false;
  let structureMetrics = null;
  let certainBackground = null;
  let warning = null;

  if (options.structure !== false) {
    if (device !== "gpu" || !self.navigator?.gpu) {
      warning = "SAM 3 structure locking requires WebGPU; ViTMatte ran from the Stage 1 trimap.";
    } else {
      try {
        const structure = await runStructureStage(source, mask, id);
        if (structure && !isCancelled(id)) {
          const backgroundEvidence = buildCertainBackgroundMask(
            source.data,
            mask,
            source.width,
            source.height,
            { channels: source.channels }
          );
          const structuralMask = backgroundEvidence.stats.applied
            ? applyCertainBackgroundVeto(
                structure.mask,
                backgroundEvidence.mask,
                source.width,
                source.height
              )
            : structure.mask;
          const adaptive = buildAdaptiveStructureTrimap(
            mask,
            structuralMask,
            source.width,
            source.height
          );
          trimap = backgroundEvidence.stats.applied
            ? applyCertainBackgroundVeto(
                adaptive.trimap,
                backgroundEvidence.mask,
                source.width,
                source.height
              )
            : adaptive.trimap;
          certainBackground = backgroundEvidence.stats.applied
            ? backgroundEvidence.mask
            : null;
          structureApplied = true;
          structureMetrics = {
            ...structure.metrics,
            ...adaptive.stats,
            backgroundVetoPixels: backgroundEvidence.stats.vetoPixels || 0,
            backgroundVetoBorderComponents: backgroundEvidence.stats.borderComponents || 0,
            backgroundVetoEnclosedComponents: backgroundEvidence.stats.enclosedComponents || 0,
            backgroundBorderCoherence: backgroundEvidence.stats.borderCoherence || 0,
            backgroundTolerance: backgroundEvidence.stats.tolerance || 0
          };
        }
      } catch (error) {
        warning = `SAM 3 structure locking was skipped: ${normalizeError(error)}`;
      }
    }
  }

  postProgress(id, "infer-stage2", 0.78, { device });
  const { RawImage } = await getTransformers();
  const trimapImage = new RawImage(trimap, source.width, source.height, 1);
  const { processor, model } = await getStage2(id, device);
  const inputs = await processor(source, trimapImage);
  const { alphas } = await model(inputs);
  const alpha = tensorAlphaToMask(alphas);
  const [contentHeight, contentWidth] = inputs.reshaped_input_sizes?.[0]
    ?? [source.height, source.width];
  const unpadded = cropPaddedMask(
    alpha.data,
    alpha.width,
    alpha.height,
    contentWidth,
    contentHeight
  );
  const output = unpadded.width === source.width && unpadded.height === source.height
    ? unpadded.data
    : (await new RawImage(
        unpadded.data,
        unpadded.width,
        unpadded.height,
        1
      ).resize(source.width, source.height)).data;
  postProgress(id, "infer-stage2", 0.94, { device });
  let conservativeMask = structureApplied
    ? applyAdaptiveTrimapLocks(output, trimap, source.width, source.height)
    : new Uint8Array(output);
  if (certainBackground) {
    conservativeMask = applyCertainBackgroundVeto(
      conservativeMask,
      certainBackground,
      source.width,
      source.height
    );
  }
  return {
    conservativeMask,
    aggressiveMask: constrainRefinedMask(mask, conservativeMask, { maxAlphaBoost: 0 }),
    structureApplied,
    structureMetrics,
    warning
  };
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

function scaledProgress(value, refine) {
  return value * (refine ? 0.52 : 0.9);
}

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

function normalizeSegmentationSafeguards(value = {}) {
  const seedThreshold = boundedInteger(value.seedThreshold, 32, 4, 128);
  return {
    detailAnalysis: value.detailAnalysis !== false,
    detailTileSize: Math.round(boundedInteger(value.detailTileSize, 512, 384, 768) / 64) * 64,
    maxDetailTiles: boundedInteger(value.maxDetailTiles, 24, 4, 48),
    seedThreshold,
    detailThreshold: boundedInteger(value.detailThreshold, 48, 4, 192),
    preserveThreshold: boundedInteger(value.preserveThreshold, 224, seedThreshold + 1, 255),
    edgeBlend: boundedInteger(value.edgeBlend, 78, 0, 100),
    recoveryRadius: boundedInteger(value.recoveryRadius, 24, 1, 96),
    matteAwareProtection: value.matteAwareProtection !== false,
    matteTolerance: boundedInteger(value.matteTolerance, 32, 0, 128),
    matteBoundaryRadius: boundedInteger(value.matteBoundaryRadius, 6, 1, 24)
  };
}

function boundedInteger(value, fallback, min, max) {
  const numeric = Number(value);
  const normalized = Number.isFinite(numeric) ? Math.round(numeric) : fallback;
  return Math.max(min, Math.min(max, normalized));
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

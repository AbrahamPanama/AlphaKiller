import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  Blend,
  Check,
  ChevronDown,
  Download,
  Eraser,
  Eye,
  FileImage,
  FolderOpen,
  Grid3X3,
  Hand,
  ImageDown,
  Layers,
  Maximize,
  Moon,
  Paintbrush,
  Pipette,
  RefreshCcw,
  Save,
  Scissors,
  Settings,
  SlidersHorizontal,
  Sparkles,
  SplitSquareHorizontal,
  Upload,
  Redo2,
  Undo2,
  Wand2,
  X,
  ZoomIn,
  ZoomOut
} from "lucide-react";
import UTIF from "utif";
import { applyMaskToImage } from "./imageProcessing.js";
import {
  applyPngResolution,
  encodeTiffImageData,
  formatResolution,
  readPngResolution,
  readTiffResolution
} from "./imageIO.js";
import { SettingsPanel } from "./SettingsPanel.jsx";

const DEFAULT_SETTINGS = {
  threshold: { enabled: false, threshold: 128, softness: 8 },
  defringe: { enabled: true, matteColor: "#ffffff", strength: 68, radius: 2, tolerance: 180 },
  bleed: { enabled: true, radius: 2, iterations: 2, affectSemiTransparent: true, useCustomColor: false, color: "#ffffff" },
  hardening: { enabled: false, strength: 55, midpoint: 50 }
};

const APP_VERSION_LABEL = "0.1 beta 1";

const PRESETS = [
  {
    id: "gentle",
    name: "Gentle Edge Cleanup",
    description: "Light defringe and subtle color bleed for icons.",
    settings: DEFAULT_SETTINGS
  },
  {
    id: "hard-cutout",
    name: "Hard Alpha Cutout",
    description: "Binary transparency for masks and pixel art.",
    settings: {
      ...DEFAULT_SETTINGS,
      threshold: { enabled: true, threshold: 128, softness: 0 },
      defringe: { ...DEFAULT_SETTINGS.defringe, enabled: false },
      bleed: { ...DEFAULT_SETTINGS.bleed, enabled: false }
    }
  },
  {
    id: "white-matte",
    name: "White Matte Defringe",
    description: "Strong white halo removal for exported artwork.",
    settings: {
      ...DEFAULT_SETTINGS,
      defringe: { enabled: true, matteColor: "#ffffff", strength: 120, radius: 4, tolerance: 230 }
    }
  },
  {
    id: "sprite-padding",
    name: "Sprite Edge Padding",
    description: "Bleeds edge colors into hidden transparent RGB.",
    settings: {
      ...DEFAULT_SETTINGS,
      defringe: { ...DEFAULT_SETTINGS.defringe, enabled: false },
      bleed: { ...DEFAULT_SETTINGS.bleed, enabled: true, radius: 4, iterations: 4, affectSemiTransparent: true }
    }
  }
];

const BACKGROUNDS = [
  { id: "checker", label: "Checker" },
  { id: "black", label: "Black" },
  { id: "white", label: "White" },
  { id: "gray", label: "Gray" },
  { id: "custom", label: "Custom" }
];

const SUPPORTED_IMAGE_EXTENSIONS = [".png", ".webp", ".tif", ".tiff"];
const RASTER_MIME_RE = /^image\/(png|webp|tiff|x-tiff)$/;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 32;
const ZOOM_FACTOR = 1.14;
const SPLIT_HIT_RADIUS = 14;
const MIN_BRUSH_SIZE = 1;
const MAX_BRUSH_SIZE = 128;
const HISTORY_LIMIT = 30;
const PROCESSING_DEBOUNCE_MS = 80;
const BG_REMOVE_TIMEOUT_MS = 180000;
const SUPER_SCALE_TIMEOUT_MS = 180000;
const BG_REMOVE_EMPTY_MASK_LIMIT = 0.02;
const BG_REMOVE_MODEL_KEY = "alphakiller:bg-remove-model";
const BG_REMOVE_REFINE_KEY = "alphakiller:bg-remove-refine-default";
const BRIA_PRESERVE_ALPHA_KEY = "alphakiller:bria-preserve-alpha";
const BRIA_TOKEN_KEY = "alphakiller:bria-token";
const PHOTOROOM_TOKEN_KEY = "alphakiller:photoroom-token";
const HF_TOKEN_KEY = "alphakiller:hf-token";
const CUSTOM_PRESETS_KEY = "alphakiller:custom-presets";
const BG_REMOVE_REFINE_AVAILABLE = false;
const checkerPatternCache = new WeakMap();

const DEFAULT_COMPARE_BEFORE = {
  bgr: false,
  alpha: false,
  manual: false,
  ss: false
};

const DEFAULT_COMPARE_AFTER = {
  bgr: true,
  alpha: true,
  manual: true,
  ss: false
};

const COMPARE_FEATURES = [
  { id: "bgr", label: "BGR", title: "Background removal" },
  { id: "alpha", label: "Alpha", title: "Defringe, color bleed, threshold, and hardening" },
  { id: "manual", label: "Manual", title: "Delete and Reconstruct pen edits" },
  { id: "ss", label: "SS", title: "Super Scale" }
];

const BG_REMOVE_MODELS = {
  "rmbg-1.4": {
    label: "Fast (RMBG-1.4)",
    shortLabel: "RMBG 1.4",
    badge: "Recommended",
    description: "Fast, reliable, and currently the best edge quality in AlphaKiller.",
    notice: "Local Transformers.js model. No Hugging Face token required."
  },
  ben2: {
    label: "Second Best (BEN2)",
    shortLabel: "BEN2",
    description: "A useful local fallback for difficult subjects and comparison runs.",
    notice: "Requires WebGPU. MIT-licensed and commercial-safe.",
    requiresWebGpu: true
  },
  "photoroom-api": {
    label: "PhotoRoom API",
    shortLabel: "PhotoRoom",
    badge: "New",
    description: "Hosted full-resolution background removal with PhotoRoom edge matting.",
    notice: "Uploads the image to PhotoRoom. Requires Electron and a PhotoRoom API key.",
    providerName: "PhotoRoom",
    requiresElectron: true,
    remote: true
  },
  "bria-api": {
    label: "Experimental (BRIA RMBG-2.0)",
    shortLabel: "BRIA 2.0",
    badge: "Experimental",
    description: "Hosted RMBG-2.0. Available for comparison, but current artwork edges are inconsistent.",
    notice: "Uploads image to BRIA. Requires Electron and a BRIA API token.",
    providerName: "BRIA",
    requiresElectron: true,
    remote: true
  }
};

const BG_REMOVE_LABELS = {
  idle: "",
  downloading: "Downloading background-removal model",
  warming: "Preparing model",
  inferring: "Removing background",
  error: "Background removal failed"
};

const BRUSH_TOOLS = new Set(["delete", "restore"]);

export function App() {
  const fileInputRef = useRef(null);
  const canvasRef = useRef(null);
  const originalCanvasRef = useRef(null);
  const processedCanvasRef = useRef(null);
  const maskCanvasRef = useRef(null);
  const diffCanvasRef = useRef(null);
  const originalCanvasCacheRef = useRef(null);
  const processedCanvasCacheRef = useRef(null);
  const maskCanvasCacheRef = useRef(null);
  const diffCanvasCacheRef = useRef(null);
  const interactionRef = useRef(null);
  const brushPointRef = useRef(null);
  const renderRafRef = useRef(null);
  const renderCanvasRef = useRef(null);
  const wheelZoomRef = useRef(null);
  const dragDepthRef = useRef(0);
  const sourceObjectUrlRef = useRef(null);
  const processingWorkerRef = useRef(null);
  const processingJobIdRef = useRef(0);
  const latestProcessingRequestRef = useRef(0);
  const activeProcessingJobRef = useRef(null);
  const queuedProcessingJobRef = useRef(null);
  const processingDebounceRef = useRef(null);
  const bgRemoveWorkerRef = useRef(null);
  const bgRemoveJobIdRef = useRef(0);
  const latestBgRemoveRequestRef = useRef(0);
  const activeBgRemoveJobRef = useRef(null);
  const pendingBgRemoveJobRef = useRef(null);
  const bgRemoveTimeoutRef = useRef(null);
  const superScaleTimeoutRef = useRef(null);
  const superScaleJobIdRef = useRef(0);
  const latestSuperScaleRequestRef = useRef(0);
  const preSegmentationOriginalRef = useRef(null);
  const importedOriginalImageRef = useRef(null);
  const backgroundRemovedImageRef = useRef(null);
  const preSuperScaleOriginalRef = useRef(null);
  const preSuperScaleProcessedRef = useRef(null);
  const superScaledImageRef = useRef(null);
  const bgRemoveNoticeShownRef = useRef(new Set());
  const historyRef = useRef({ undo: [], redo: [] });
  const settingsUndoGroupRef = useRef(null);
  const [source, setSource] = useState(null);
  const [originalImageData, setOriginalImageData] = useState(null);
  const [processedImageData, setProcessedImageData] = useState(null);
  const [stats, setStats] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [preset, setPreset] = useState("gentle");
  const [customPresets, setCustomPresets] = useState(loadCustomPresets);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState("");
  const [activePage, setActivePage] = useState("editor");
  const [background, setBackground] = useState("checker");
  const [customBackground, setCustomBackground] = useState("#6f5cff");
  const [compareMode, setCompareMode] = useState("split");
  const [split, setSplit] = useState(50);
  const [zoom, setZoom] = useState(2);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [canvasTool, setCanvasTool] = useState("pan");
  const [brushSize, setBrushSize] = useState(18);
  const [status, setStatus] = useState("Ready");
  const [cursor, setCursor] = useState(null);
  const [toast, setToast] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [canvasMode, setCanvasMode] = useState("idle");
  const [bgRemoveStatus, setBgRemoveStatus] = useState("idle");
  const [bgRemoveProgress, setBgRemoveProgress] = useState(0);
  const [bgRemoveDevice, setBgRemoveDevice] = useState(null);
  const [bgRemoveModel, setBgRemoveModel] = useState(loadPersistedBgRemoveModel);
  const [bgRemoveRefine, setBgRemoveRefine] = useState(loadPersistedBgRemoveRefine);
  const [briaPreserveAlpha, setBriaPreserveAlpha] = useState(loadPersistedBriaPreserveAlpha);
  const [superScaleDialogOpen, setSuperScaleDialogOpen] = useState(false);
  const [superScaleFactor, setSuperScaleFactor] = useState(2);
  const [superScaleKeepPrintSize, setSuperScaleKeepPrintSize] = useState(true);
  const [superScaleStatus, setSuperScaleStatus] = useState("idle");
  const [superScaleProgress, setSuperScaleProgress] = useState(0);
  const [hasBackgroundRemovedStage, setHasBackgroundRemovedStage] = useState(false);
  const [hasSuperScaleStage, setHasSuperScaleStage] = useState(false);
  const [compareBeforeLayers, setCompareBeforeLayers] = useState(DEFAULT_COMPARE_BEFORE);
  const [compareAfterLayers, setCompareAfterLayers] = useState(DEFAULT_COMPARE_AFTER);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [hasWebGpu] = useState(() => Boolean(window.navigator?.gpu));
  const [hasElectronBackgroundRemoval] = useState(() => Boolean(window.alphaKiller?.removeBackground));
  const [hasElectronSuperScale] = useState(() => Boolean(window.alphaKiller?.superScale));
  const [hasPreSegmentationOriginal, setHasPreSegmentationOriginal] = useState(false);
  const [hfTokenDialogOpen, setHfTokenDialogOpen] = useState(false);
  const [hfTokenDraft, setHfTokenDraft] = useState("");
  const [historyVersion, setHistoryVersion] = useState(0);

  const isBackgroundRemoving = bgRemoveStatus === "downloading" || bgRemoveStatus === "warming" || bgRemoveStatus === "inferring";
  const isSuperScaling = superScaleStatus === "running";
  const canUndo = historyVersion >= 0 && historyRef.current.undo.length > 0;
  const canRedo = historyVersion >= 0 && historyRef.current.redo.length > 0;
  const reconstructionSource = preSegmentationOriginalRef.current;
  const canReconstruct = Boolean(
    hasPreSegmentationOriginal &&
    reconstructionSource &&
    originalImageData &&
    reconstructionSource.width === originalImageData.width &&
    reconstructionSource.height === originalImageData.height
  );
  const isBrushTool = BRUSH_TOOLS.has(canvasTool);
  const compareFeatureAvailability = {
    bgr: hasBackgroundRemovedStage,
    alpha: Boolean(processedImageData),
    manual: Boolean(originalImageData),
    ss: hasSuperScaleStage
  };
  const superScaleOutputWidth = source ? source.width * superScaleFactor : 0;
  const superScaleOutputHeight = source ? source.height * superScaleFactor : 0;
  const superScaleOutputResolution = superScaleKeepPrintSize
    ? scaleResolution(source?.resolution, superScaleFactor)
    : source?.resolution;
  const allPresets = [...PRESETS, ...customPresets];
  const selectedPreset = allPresets.find((item) => item.id === preset);
  const selectedCustomPreset = customPresets.find((item) => item.id === preset);

  const loadFile = useCallback(async (file) => {
    if (!file || !isSupportedImageFile(file)) {
      setToast({ type: "error", title: "Unsupported file", message: "AlphaKiller currently accepts PNG, WebP, TIFF, and TIF images." });
      return;
    }

    setStatus("Loading image");
    cancelBackgroundRemoval();
    resetImageHistory();
    preSegmentationOriginalRef.current = null;
    importedOriginalImageRef.current = null;
    backgroundRemovedImageRef.current = null;
    preSuperScaleOriginalRef.current = null;
    preSuperScaleProcessedRef.current = null;
    superScaledImageRef.current = null;
    setHasPreSegmentationOriginal(false);
    setHasBackgroundRemovedStage(false);
    setHasSuperScaleStage(false);
    setCompareBeforeLayers(DEFAULT_COMPARE_BEFORE);
    setCompareAfterLayers(DEFAULT_COMPARE_AFTER);
    if (isTiffFile(file)) {
      try {
        const { imageData, previewUrl, resolution } = await decodeTiffFile(file);
        setSource({
          name: file.name,
          size: file.size,
          type: file.type || "image/tiff",
          format: "TIFF",
          width: imageData.width,
          height: imageData.height,
          resolution,
          url: previewUrl
        });
        if (sourceObjectUrlRef.current) {
          URL.revokeObjectURL(sourceObjectUrlRef.current);
          sourceObjectUrlRef.current = null;
        }
        setOriginalImageData(imageData);
        setProcessedImageData(imageData);
        importedOriginalImageRef.current = cloneImageData(imageData);
        setStats(null);
        setZoom(imageData.width < 300 ? 3 : 1);
        setPan({ x: 0, y: 0 });
        brushPointRef.current = null;
        setStatus("Image loaded");
      } catch (error) {
        console.error(error);
        setToast({
          type: "error",
          title: "Could not read TIFF",
          message: "This TIFF may use a compression, color mode, or bit depth that is not supported yet."
        });
        setStatus("Ready");
      }
      return;
    }

    const resolution = await readFileResolution(file);
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      if (sourceObjectUrlRef.current) {
        URL.revokeObjectURL(sourceObjectUrlRef.current);
      }
      sourceObjectUrlRef.current = url;
      setSource({
        name: file.name,
        size: file.size,
        type: file.type,
        format: file.type.replace("image/", "").toUpperCase(),
        width: canvas.width,
        height: canvas.height,
        resolution,
        url
      });
      setOriginalImageData(imageData);
      setProcessedImageData(imageData);
      importedOriginalImageRef.current = cloneImageData(imageData);
      setStats(null);
      setZoom(canvas.width < 300 ? 3 : 1);
      setPan({ x: 0, y: 0 });
      brushPointRef.current = null;
      setStatus("Image loaded");
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      setToast({ type: "error", title: "Could not read image", message: "The selected file could not be decoded." });
      setStatus("Ready");
    };
    image.src = url;
  }, []);

  function ensureProcessingWorker() {
    if (processingWorkerRef.current) {
      return processingWorkerRef.current;
    }

    const worker = new Worker(new URL("./processingWorker.js", import.meta.url), { type: "module" });

    worker.onmessage = (event) => {
      const { id, width, height, buffer, stats: nextStats, error } = event.data;
      const activeJob = activeProcessingJobRef.current;
      if (!activeJob || activeJob.id !== id) return;

      activeProcessingJobRef.current = null;
      const queuedJob = queuedProcessingJobRef.current;

      if (queuedJob) {
        queuedProcessingJobRef.current = null;
        startProcessingJob(queuedJob);
        return;
      }

      if (activeJob.requestId !== latestProcessingRequestRef.current) {
        return;
      }

      if (error) {
        setStatus("Processing error");
        setToast({
          type: "error",
          title: "Preview processing failed",
          message: error
        });
        return;
      }

      setProcessedImageData(new ImageData(new Uint8ClampedArray(buffer), width, height));
      setStats(nextStats);
      setStatus("Ready");
    };

    worker.onerror = (error) => {
      console.error(error);
      worker.terminate();
      if (processingWorkerRef.current === worker) {
        processingWorkerRef.current = null;
      }
      activeProcessingJobRef.current = null;
      queuedProcessingJobRef.current = null;
      setStatus("Processing error");
      setToast({
        type: "error",
        title: "Preview processing failed",
        message: "AlphaKiller could not finish the current preview pass."
      });
    };

    processingWorkerRef.current = worker;
    return worker;
  }

  function startProcessingJob(job) {
    const worker = ensureProcessingWorker();
    const id = ++processingJobIdRef.current;
    activeProcessingJobRef.current = { id, requestId: job.requestId };
    setStatus("Processing preview");

    const buffer = new Uint8ClampedArray(job.imageData.data).buffer;
    worker.postMessage({
      id,
      buffer,
      width: job.imageData.width,
      height: job.imageData.height,
      settings: job.settings
    }, [buffer]);
  }

  function enqueueProcessingJob(job) {
    if (activeProcessingJobRef.current) {
      queuedProcessingJobRef.current = job;
      return;
    }

    startProcessingJob(job);
  }

  function scheduleProcessing(imageData, nextSettings) {
    const requestId = ++latestProcessingRequestRef.current;
    const job = {
      requestId,
      imageData,
      settings: structuredClone(nextSettings)
    };

    if (processingDebounceRef.current) {
      window.clearTimeout(processingDebounceRef.current);
    }

    processingDebounceRef.current = window.setTimeout(() => {
      processingDebounceRef.current = null;
      enqueueProcessingJob(job);
    }, PROCESSING_DEBOUNCE_MS);
  }

  function ensureBgRemoveWorker() {
    if (bgRemoveWorkerRef.current) {
      return bgRemoveWorkerRef.current;
    }

    const worker = new Worker(new URL("./bgRemoveWorker.js", import.meta.url), { type: "module" });

    worker.onmessage = (event) => {
      const message = event.data;
      const activeJob = activeBgRemoveJobRef.current;
      if (!activeJob || activeJob.id !== message.id) return;

      if (activeJob.requestId !== latestBgRemoveRequestRef.current) {
        return;
      }

      if (message.type === "progress") {
        const nextStatus = bgRemoveStageToStatus(message.stage);
        setBgRemoveStatus(nextStatus);
        setBgRemoveProgress(message.progress);
        if (message.device) setBgRemoveDevice(message.device);
        setStatus(BG_REMOVE_LABELS[nextStatus] || "Removing background");
        return;
      }

      clearBgRemoveTimeout();
      activeBgRemoveJobRef.current = null;

      if (message.type === "error") {
        finishBgRemoveError(message.error);
        return;
      }

      if (message.type !== "result") return;

      if (message.maskMean < BG_REMOVE_EMPTY_MASK_LIMIT) {
        setBgRemoveStatus("idle");
        setBgRemoveProgress(0);
        setStatus("Ready");
        setToast({
          type: "warning",
          title: "No clear subject detected",
          message: "Background removal did not find a strong foreground subject."
        });
        return;
      }

      const maskBuffer = message.maskBuffer || message.buffer;
      const nextImageData = applyMaskToImage(activeJob.imageData, maskBuffer);
      if (!preSegmentationOriginalRef.current) {
        preSegmentationOriginalRef.current = cloneImageData(activeJob.imageData);
        setHasPreSegmentationOriginal(true);
      }
      backgroundRemovedImageRef.current = cloneImageData(nextImageData);
      setHasBackgroundRemovedStage(true);

      commitDocumentImageEdit(nextImageData, {
        undoFrom: activeJob.visibleBefore,
        statusText: "Background removed"
      });
      setBgRemoveStatus("idle");
      setBgRemoveProgress(0);
      setBgRemoveDevice(message.device);
      const completedModel = message.modelId || activeJob.modelId || bgRemoveModel;
      const completedModelLabel = BG_REMOVE_MODELS[completedModel]?.shortLabel || "AI";
      setToast({
        type: "success",
        title: "Background removed",
        message: `${completedModelLabel} mask applied in ${(message.durationMs / 1000).toFixed(1)}s${message.device === "cpu" ? " using CPU" : ""}${message.stagesRun?.includes("stage2") ? " with edge refinement" : ""}.`
      });
    };

    worker.onerror = (error) => {
      console.error(error);
      worker.terminate();
      if (bgRemoveWorkerRef.current === worker) {
        bgRemoveWorkerRef.current = null;
      }
      activeBgRemoveJobRef.current = null;
      clearBgRemoveTimeout();
      finishBgRemoveError("Background removal worker crashed.");
    };

    bgRemoveWorkerRef.current = worker;
    return worker;
  }

  function startBgRemoveJob(job) {
    const worker = ensureBgRemoveWorker();
    const id = ++bgRemoveJobIdRef.current;
    activeBgRemoveJobRef.current = {
      id,
      requestId: job.requestId,
      imageData: job.imageData,
      modelId: job.modelId,
      visibleBefore: job.visibleBefore
    };
    setBgRemoveStatus("warming");
    setBgRemoveProgress(0);
    setBgRemoveDevice(null);
    setStatus("Preparing model");

    clearBgRemoveTimeout();
    bgRemoveTimeoutRef.current = window.setTimeout(() => {
      if (activeBgRemoveJobRef.current?.id !== id) return;
      worker.postMessage({ type: "cancel", id });
      worker.terminate();
      if (bgRemoveWorkerRef.current === worker) {
        bgRemoveWorkerRef.current = null;
      }
      activeBgRemoveJobRef.current = null;
      finishBgRemoveError("Background removal took too long. Try a smaller image.");
    }, BG_REMOVE_TIMEOUT_MS);

    const buffer = new Uint8ClampedArray(job.imageData.data).buffer;
    worker.postMessage({
      type: "run",
      id,
      buffer,
      width: job.imageData.width,
      height: job.imageData.height,
      options: {
        tta: true,
        refine: job.refine && BG_REMOVE_REFINE_AVAILABLE,
        modelId: job.modelId,
        tileThreshold: 2048,
        hfToken: job.hfToken
      }
    }, [buffer]);
  }

  async function runBackgroundRemoval() {
    if (!originalImageData || isBackgroundRemoving) return;

    const requestId = ++latestBgRemoveRequestRef.current;
    const inputImageData = preSegmentationOriginalRef.current
      ? cloneImageData(preSegmentationOriginalRef.current)
      : originalImageData;
    const model = BG_REMOVE_MODELS[bgRemoveModel] || BG_REMOVE_MODELS["rmbg-1.4"];
    if (model.requiresElectron && !hasElectronBackgroundRemoval) {
      setToast({
        type: "warning",
        title: "Electron required",
        message: `${model.label} runs through the Electron main process so the API token stays out of the browser.`
      });
      return;
    }

    if (!bgRemoveNoticeShownRef.current.has(bgRemoveModel)) {
      bgRemoveNoticeShownRef.current.add(bgRemoveModel);
      if (model.remote) {
        setToast({
          type: "info",
          title: `${model.providerName || "Remote"} API background removal`,
          message: `AlphaKiller sends a normalized PNG to ${model.providerName || "the selected provider"} and applies the returned matte to the cleanup pipeline.`
        });
      } else {
        setToast({
          type: "info",
          title: "First-time download may be large",
          message: `${model.label || "Background removal"} model assets are cached locally after the first successful download.`
        });
      }
    }

    if (model.remote) {
      runRemoteApiBackgroundRemoval({
        requestId,
        imageData: inputImageData,
        visibleBefore: originalImageData,
        provider: bgRemoveModel
      });
      return;
    }

    const hfToken = await getHuggingFaceToken();
    if (requestId !== latestBgRemoveRequestRef.current) return;
    startBgRemoveJob({
      requestId,
      imageData: inputImageData,
      visibleBefore: originalImageData,
      refine: bgRemoveRefine,
      modelId: bgRemoveModel,
      hfToken
    });
  }

  async function runRemoteApiBackgroundRemoval(job) {
    const id = ++bgRemoveJobIdRef.current;
    const providerModel = BG_REMOVE_MODELS[job.provider];
    const providerName = providerModel?.providerName || "Remote provider";
    activeBgRemoveJobRef.current = { id, requestId: job.requestId, imageData: job.imageData, modelId: job.provider };
    setBgRemoveStatus("inferring");
    setBgRemoveProgress(0.08);
    setBgRemoveDevice("api");
    setStatus("Removing background");

    clearBgRemoveTimeout();
    bgRemoveTimeoutRef.current = window.setTimeout(() => {
      if (activeBgRemoveJobRef.current?.id !== id) return;
      latestBgRemoveRequestRef.current += 1;
      activeBgRemoveJobRef.current = null;
      finishBgRemoveError("Background removal took too long. Try a smaller image.");
    }, BG_REMOVE_TIMEOUT_MS);

    try {
      const pngBytes = await imageDataToPngArrayBuffer(job.imageData);
      if (!isActiveBgRemoveJob(id, job.requestId)) return;
      setBgRemoveProgress(0.28);

      const result = await window.alphaKiller.removeBackground({
        provider: job.provider,
        pngBytes,
        preserveAlpha: job.provider === "bria-api" ? briaPreserveAlpha : false,
        apiToken: job.provider === "photoroom-api"
          ? loadStoredPhotoroomToken()
          : loadStoredBriaToken()
      });
      if (!isActiveBgRemoveJob(id, job.requestId)) return;
      setBgRemoveProgress(0.82);

      const nextImageData = await pngArrayBufferToImageData(result.pngBytes);
      if (!isActiveBgRemoveJob(id, job.requestId)) return;

      clearBgRemoveTimeout();
      activeBgRemoveJobRef.current = null;

      if (!preSegmentationOriginalRef.current) {
        preSegmentationOriginalRef.current = cloneImageData(job.imageData);
        setHasPreSegmentationOriginal(true);
      }
      backgroundRemovedImageRef.current = cloneImageData(nextImageData);
      setHasBackgroundRemovedStage(true);

      if (sourceObjectUrlRef.current) {
        URL.revokeObjectURL(sourceObjectUrlRef.current);
        sourceObjectUrlRef.current = null;
      }

      commitDocumentImageEdit(nextImageData, {
        undoFrom: job.visibleBefore,
        statusText: "Background removed"
      });
      setBgRemoveStatus("idle");
      setBgRemoveProgress(0);
      setBgRemoveDevice("api");
      const resultWidth = result.width || nextImageData.width;
      const resultHeight = result.height || nextImageData.height;
      setStatus(`Background removed (${job.imageData.width} x ${job.imageData.height} -> ${resultWidth} x ${resultHeight})`);
      setToast({
        type: "success",
        title: "Background removed",
        message: `${providerName} sent ${job.imageData.width} x ${job.imageData.height} (${formatBytes(pngBytes.byteLength)}) and returned ${resultWidth} x ${resultHeight} in ${((result.durationMs || 0) / 1000).toFixed(1)}s${result.requestId ? ` (request ${result.requestId})` : ""}.`
      });
    } catch (error) {
      if (!isActiveBgRemoveJob(id, job.requestId)) return;
      clearBgRemoveTimeout();
      activeBgRemoveJobRef.current = null;
      finishBgRemoveError(error?.message || `${providerName} API background removal failed.`);
    }
  }

  async function runBriaSuperScale() {
    if (!originalImageData || isSuperScaling) return;
    if (!hasElectronSuperScale) {
      setToast({
        type: "warning",
        title: "Electron required",
        message: "BRIA Super Scale runs through Electron so the API token stays out of the browser."
      });
      return;
    }

    const requestId = ++latestSuperScaleRequestRef.current;
    const id = ++superScaleJobIdRef.current;
    const inputImageData = cloneImageData(originalImageData);
    const beforeProcessed = processedImageData ? cloneImageData(processedImageData) : cloneImageData(originalImageData);
    const nextResolution = superScaleKeepPrintSize
      ? scaleResolution(source?.resolution, superScaleFactor)
      : cloneResolution(source?.resolution);

    setSuperScaleDialogOpen(false);
    setSuperScaleStatus("running");
    setSuperScaleProgress(0.08);
    setStatus("Super scaling");
    clearSuperScaleTimeout();
    superScaleTimeoutRef.current = window.setTimeout(() => {
      if (requestId !== latestSuperScaleRequestRef.current) return;
      latestSuperScaleRequestRef.current += 1;
      setSuperScaleStatus("idle");
      setSuperScaleProgress(0);
      setStatus("Ready");
      setToast({
        type: "error",
        title: "Super Scale failed",
        message: "BRIA Super Scale took too long. Try a smaller image or 2x."
      });
    }, SUPER_SCALE_TIMEOUT_MS);

    try {
      const pngBytes = await imageDataToPngArrayBuffer(inputImageData, source?.resolution);
      if (requestId !== latestSuperScaleRequestRef.current) return;
      setSuperScaleProgress(0.3);

      const result = await window.alphaKiller.superScale({
        provider: "bria-api",
        pngBytes,
        scale: superScaleFactor,
        preserveAlpha: true,
        apiToken: loadStoredBriaToken()
      });
      if (requestId !== latestSuperScaleRequestRef.current) return;
      setSuperScaleProgress(0.82);

      const nextImageData = await pngArrayBufferToImageData(result.pngBytes);
      if (requestId !== latestSuperScaleRequestRef.current) return;

      clearSuperScaleTimeout();
      preSuperScaleOriginalRef.current = inputImageData;
      preSuperScaleProcessedRef.current = beforeProcessed;
      superScaledImageRef.current = cloneImageData(nextImageData);
      setHasSuperScaleStage(true);
      setCompareBeforeLayers({ ...DEFAULT_COMPARE_AFTER, ss: false });
      setCompareAfterLayers({ ...DEFAULT_COMPARE_AFTER, ss: true });

      commitDocumentImageEdit(nextImageData, {
        undoFrom: inputImageData,
        statusText: "Super scaled",
        resolution: nextResolution
      });
      setSuperScaleStatus("idle");
      setSuperScaleProgress(0);
      const dpiLabel = nextResolution ? `, ${formatResolution(nextResolution)}` : "";
      setToast({
        type: "success",
        title: "Super Scale complete",
        message: `BRIA ${result.scale || superScaleFactor}x returned ${nextImageData.width} x ${nextImageData.height}${dpiLabel} in ${((result.durationMs || 0) / 1000).toFixed(1)}s${result.requestId ? ` (request ${result.requestId})` : ""}.`
      });
    } catch (error) {
      if (requestId !== latestSuperScaleRequestRef.current) return;
      clearSuperScaleTimeout();
      setSuperScaleStatus("idle");
      setSuperScaleProgress(0);
      setStatus("Ready");
      setToast({
        type: "error",
        title: "Super Scale failed",
        message: getSuperScaleErrorMessage(error?.message)
      });
    }
  }

  function isActiveBgRemoveJob(id, requestId) {
    const activeJob = activeBgRemoveJobRef.current;
    return Boolean(activeJob && activeJob.id === id && activeJob.requestId === requestId && requestId === latestBgRemoveRequestRef.current);
  }

  function restoreOriginal() {
    const snapshot = preSegmentationOriginalRef.current;
    if (!snapshot) return;

    const restored = cloneImageData(snapshot);
    preSegmentationOriginalRef.current = null;
    setHasPreSegmentationOriginal(false);
    commitDocumentImageEdit(restored, {
      undoFrom: originalImageData,
      statusText: "Original restored"
    });
    setBgRemoveStatus("idle");
    setBgRemoveProgress(0);
    setToast(null);
  }

  function cancelBackgroundRemoval() {
    const activeJob = activeBgRemoveJobRef.current;
    latestBgRemoveRequestRef.current += 1;
    clearBgRemoveTimeout();
    if (activeJob && bgRemoveWorkerRef.current) {
      bgRemoveWorkerRef.current.postMessage({ type: "cancel", id: activeJob.id });
      bgRemoveWorkerRef.current.terminate();
      bgRemoveWorkerRef.current = null;
    }
    activeBgRemoveJobRef.current = null;
    setBgRemoveStatus("idle");
    setBgRemoveProgress(0);
    setBgRemoveDevice(null);
  }

  function finishBgRemoveError(message) {
    setBgRemoveStatus("error");
    setBgRemoveProgress(0);
    setStatus("Ready");
    setToast({
      type: "error",
      title: "Background removal failed",
      message: getBgRemoveErrorMessage(message)
    });
  }

  function submitHfToken(event) {
    event.preventDefault();
    const token = sanitizeToken(hfTokenDraft);
    if (!token) return;

    try {
      window.localStorage?.setItem(HF_TOKEN_KEY, token);
    } catch {
      setToast({
        type: "error",
        title: "Token not saved",
        message: "The browser preview could not store the Hugging Face token."
      });
      return;
    }

    const pendingJob = pendingBgRemoveJobRef.current;
    pendingBgRemoveJobRef.current = null;
    setHfTokenDialogOpen(false);
    setHfTokenDraft("");

    if (pendingJob && pendingJob.requestId === latestBgRemoveRequestRef.current) {
      startBgRemoveJob({ ...pendingJob, hfToken: token });
    }
  }

  function cancelHfTokenDialog() {
    pendingBgRemoveJobRef.current = null;
    setHfTokenDialogOpen(false);
    setHfTokenDraft("");
    setStatus("Ready");
  }

  function updateBgRemoveModel(modelId) {
    if (!BG_REMOVE_MODELS[modelId]) return;
    if (BG_REMOVE_MODELS[modelId].requiresWebGpu && !hasWebGpu) {
      setToast({
        type: "warning",
        title: "WebGPU required",
        message: `${BG_REMOVE_MODELS[modelId].label} needs WebGPU. Use Fast on this machine.`
      });
      return;
    }
    if (BG_REMOVE_MODELS[modelId].requiresElectron && !hasElectronBackgroundRemoval) {
      setToast({
        type: "warning",
        title: "Electron required",
        message: `${BG_REMOVE_MODELS[modelId].label} is available in the Electron app, not the browser preview.`
      });
      return;
    }
    setBgRemoveModel(modelId);
    persistLocalStorage(BG_REMOVE_MODEL_KEY, modelId);
  }

  function updateBgRemoveRefine(value) {
    if (value && !BG_REMOVE_REFINE_AVAILABLE) {
      setToast({
        type: "warning",
        title: "Edge refinement unavailable",
        message: "The ViTMatte refinement model does not ship browser-ready ONNX assets yet."
      });
      return;
    }
    setBgRemoveRefine(value);
    persistLocalStorage(BG_REMOVE_REFINE_KEY, value ? "true" : "false");
  }

  function updateBriaPreserveAlpha(value) {
    setBriaPreserveAlpha(value);
    persistLocalStorage(BRIA_PRESERVE_ALPHA_KEY, value ? "true" : "false");
  }

  function saveBriaSettingsToken(token) {
    const clean = sanitizeToken(token);
    if (clean) {
      persistLocalStorage(BRIA_TOKEN_KEY, clean);
      setToast({ type: "success", title: "Token saved", message: "BRIA API token stored for this browser profile." });
    } else {
      removeLocalStorage(BRIA_TOKEN_KEY);
      setToast({ type: "success", title: "Token cleared", message: "Stored BRIA API token removed from this browser profile." });
    }
  }

  function savePhotoroomSettingsToken(token) {
    const clean = sanitizeToken(token);
    if (clean) {
      persistLocalStorage(PHOTOROOM_TOKEN_KEY, clean);
      setToast({ type: "success", title: "Key saved", message: "PhotoRoom API key stored for this browser profile." });
    } else {
      removeLocalStorage(PHOTOROOM_TOKEN_KEY);
      setToast({ type: "success", title: "Key cleared", message: "Stored PhotoRoom API key removed from this browser profile." });
    }
  }

  function openPresetDialog() {
    setPresetNameDraft(selectedCustomPreset?.name || "");
    setPresetDialogOpen(true);
  }

  function closePresetDialog() {
    setPresetDialogOpen(false);
    setPresetNameDraft("");
  }

  function saveCurrentPreset(event) {
    event.preventDefault();
    const name = sanitizePresetName(presetNameDraft);
    if (!name) return;

    const existingByName = customPresets.find((item) => item.name.toLowerCase() === name.toLowerCase());
    const id = selectedCustomPreset?.id || existingByName?.id || `custom:${Date.now().toString(36)}`;
    const nextPreset = {
      id,
      name,
      description: "Saved cleanup settings.",
      custom: true,
      settings: structuredClone(settings)
    };
    const nextCustomPresets = [
      ...customPresets.filter((item) => item.id !== id),
      nextPreset
    ].sort((a, b) => a.name.localeCompare(b.name));

    setCustomPresets(nextCustomPresets);
    persistCustomPresets(nextCustomPresets);
    setPreset(id);
    closePresetDialog();
    setToast({
      type: "success",
      title: "Preset saved",
      message: `${name} is available in the Preset dropdown.`
    });
  }

  function deleteSelectedCustomPreset() {
    if (!selectedCustomPreset) return;
    const nextCustomPresets = customPresets.filter((item) => item.id !== selectedCustomPreset.id);
    setCustomPresets(nextCustomPresets);
    persistCustomPresets(nextCustomPresets);
    setPreset("gentle");
    setToast({
      type: "success",
      title: "Preset deleted",
      message: `${selectedCustomPreset.name} was removed.`
    });
  }

  function clearBgRemoveTimeout() {
    if (!bgRemoveTimeoutRef.current) return;
    window.clearTimeout(bgRemoveTimeoutRef.current);
    bgRemoveTimeoutRef.current = null;
  }

  function clearSuperScaleTimeout() {
    if (!superScaleTimeoutRef.current) return;
    window.clearTimeout(superScaleTimeoutRef.current);
    superScaleTimeoutRef.current = null;
  }

  function resetImageHistory() {
    clearSettingsUndoGroup();
    historyRef.current = { undo: [], redo: [] };
    setHistoryVersion((version) => version + 1);
  }

  function makeHistorySnapshot({ imageData = originalImageData, includeImage = false } = {}) {
    return {
      imageData: includeImage && imageData ? cloneImageData(imageData) : null,
      resolution: cloneResolution(source?.resolution),
      settings: structuredClone(settings),
      preset
    };
  }

  function pushUndoSnapshot(snapshot) {
    if (!snapshot) return;
    const history = historyRef.current;
    history.undo.push(snapshot);
    if (history.undo.length > HISTORY_LIMIT) {
      history.undo.shift();
    }
    history.redo = [];
    setHistoryVersion((version) => version + 1);
  }

  function clearSettingsUndoGroup() {
    const group = settingsUndoGroupRef.current;
    if (group?.timer) {
      window.clearTimeout(group.timer);
    }
    settingsUndoGroupRef.current = null;
  }

  function pushSettingsUndoSnapshot({ forceNew = false } = {}) {
    if (!originalImageData) return;
    if (forceNew) {
      clearSettingsUndoGroup();
    }

    if (!settingsUndoGroupRef.current) {
      pushUndoSnapshot(makeHistorySnapshot({ includeImage: false }));
      settingsUndoGroupRef.current = { timer: null };
    }

    if (settingsUndoGroupRef.current.timer) {
      window.clearTimeout(settingsUndoGroupRef.current.timer);
    }

    settingsUndoGroupRef.current.timer = window.setTimeout(() => {
      settingsUndoGroupRef.current = null;
    }, 700);
  }

  function replaceDocumentImage(imageData, statusText = "Ready", options = {}) {
    const nextResolution = options.resolution === undefined ? source?.resolution : options.resolution;
    if (sourceObjectUrlRef.current) {
      URL.revokeObjectURL(sourceObjectUrlRef.current);
      sourceObjectUrlRef.current = null;
    }

    setOriginalImageData(imageData);
    setProcessedImageData(imageData);
    setStats(null);
    setSource((current) => current ? {
      ...current,
      width: imageData.width,
      height: imageData.height,
      resolution: cloneResolution(nextResolution),
      url: imageDataToObjectUrl(imageData)
    } : current);
    setStatus(statusText);
  }

  function commitDocumentImageEdit(imageData, { undoFrom = originalImageData, statusText = "Ready", resolution } = {}) {
    clearSettingsUndoGroup();
    pushUndoSnapshot(makeHistorySnapshot({ imageData: undoFrom, includeImage: true }));
    replaceDocumentImage(imageData, statusText, { resolution });
  }

  function applyHistorySnapshot(snapshot, statusText) {
    if (snapshot.imageData) {
      replaceDocumentImage(cloneImageData(snapshot.imageData), statusText, { resolution: snapshot.resolution });
    } else {
      setStatus(statusText);
    }

    setSettings(structuredClone(snapshot.settings));
    setPreset(snapshot.preset);
  }

  function undoImageEdit() {
    clearSettingsUndoGroup();
    const history = historyRef.current;
    const previous = history.undo.pop();
    if (!previous) return;

    history.redo.push(makeHistorySnapshot({ includeImage: Boolean(previous.imageData) }));
    if (history.redo.length > HISTORY_LIMIT) {
      history.redo.shift();
    }
    applyHistorySnapshot(previous, "Undo");
    setHistoryVersion((version) => version + 1);
  }

  function redoImageEdit() {
    clearSettingsUndoGroup();
    const history = historyRef.current;
    const next = history.redo.pop();
    if (!next) return;

    history.undo.push(makeHistorySnapshot({ includeImage: Boolean(next.imageData) }));
    if (history.undo.length > HISTORY_LIMIT) {
      history.undo.shift();
    }
    applyHistorySnapshot(next, "Redo");
    setHistoryVersion((version) => version + 1);
  }

  useEffect(() => {
    if (!originalImageData) {
      setProcessedImageData(null);
      setStats(null);
      return;
    }

    setStatus("Processing preview");
    scheduleProcessing(originalImageData, settings);
  }, [originalImageData, settings]);

  useEffect(() => () => {
    if (processingDebounceRef.current) {
      window.clearTimeout(processingDebounceRef.current);
    }
    if (sourceObjectUrlRef.current) {
      URL.revokeObjectURL(sourceObjectUrlRef.current);
      sourceObjectUrlRef.current = null;
    }
    clearBgRemoveTimeout();
    clearSuperScaleTimeout();
    processingWorkerRef.current?.terminate();
    bgRemoveWorkerRef.current?.terminate();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (canvasTool === "restore" && !canReconstruct) {
      setCanvasTool("pan");
    }
  }, [canvasTool, canReconstruct]);

  function updateCompareLayer(side, feature, value) {
    const setter = side === "before" ? setCompareBeforeLayers : setCompareAfterLayers;
    setter((current) => ({
      ...current,
      [feature]: value
    }));
  }

  function resolveComparisonImage(layers) {
    if (!originalImageData || !processedImageData) return null;

    const usePreSuperScale = hasSuperScaleStage && !layers.ss;
    const currentOriginal = usePreSuperScale && preSuperScaleOriginalRef.current
      ? preSuperScaleOriginalRef.current
      : originalImageData;
    const currentProcessed = usePreSuperScale && preSuperScaleProcessedRef.current
      ? preSuperScaleProcessedRef.current
      : processedImageData;

    if (layers.alpha) return currentProcessed;
    if (layers.manual) return currentOriginal;
    if (layers.bgr && backgroundRemovedImageRef.current) return backgroundRemovedImageRef.current;
    if (layers.ss && superScaledImageRef.current) return superScaledImageRef.current;
    return importedOriginalImageRef.current || preSegmentationOriginalRef.current || currentOriginal;
  }

  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const rect = canvas.parentElement.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.floor(rect.width * window.devicePixelRatio));
    const nextHeight = Math.max(1, Math.floor(rect.height * window.devicePixelRatio));

    if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
      canvas.width = nextWidth;
      canvas.height = nextHeight;
    }

    ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    drawBackground(ctx, rect.width, rect.height, background, customBackground);

    if (!source || !originalImageData || !processedImageData) {
      drawEmptyMark(ctx, rect.width, rect.height);
      return;
    }

    const beforeImageData = resolveComparisonImage(compareBeforeLayers) || originalImageData;
    const afterImageData = resolveComparisonImage(compareAfterLayers) || processedImageData;
    const frameImageData = afterImageData || processedImageData;
    const frame = getImageFrame(frameImageData, zoom, pan, rect.width, rect.height);
    const { x, y, width: displayWidth, height: displayHeight } = frame;

    const beforeCanvas = imageDataToCachedCanvas(beforeImageData, originalCanvasCacheRef, originalCanvasRef);
    const afterCanvas = imageDataToCachedCanvas(afterImageData, processedCanvasCacheRef, processedCanvasRef);

    ctx.imageSmoothingEnabled = zoom < 3;
    if (compareMode === "before") {
      ctx.drawImage(beforeCanvas, x, y, displayWidth, displayHeight);
    } else if (compareMode === "mask") {
      drawAlphaMask(ctx, afterImageData, x, y, displayWidth, displayHeight, maskCanvasCacheRef, maskCanvasRef);
    } else if (compareMode === "diff") {
      drawDifference(ctx, beforeImageData, afterImageData, x, y, displayWidth, displayHeight, diffCanvasCacheRef, diffCanvasRef);
    } else if (compareMode === "split") {
      const cut = x + displayWidth * (split / 100);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cut - x, displayHeight);
      ctx.clip();
      ctx.drawImage(beforeCanvas, x, y, displayWidth, displayHeight);
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(cut, y, x + displayWidth - cut, displayHeight);
      ctx.clip();
      ctx.drawImage(afterCanvas, x, y, displayWidth, displayHeight);
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,.85)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cut, y - 14);
      ctx.lineTo(cut, y + displayHeight + 14);
      ctx.stroke();
      drawSplitHandle(ctx, cut, y, displayHeight);
      drawBadge(ctx, "BEFORE", x + 10, y + 12);
      drawBadge(ctx, "AFTER", x + displayWidth - 66, y + 12);
    } else {
      ctx.drawImage(afterCanvas, x, y, displayWidth, displayHeight);
    }

    if (zoom >= 6) drawPixelGrid(ctx, x, y, displayWidth, displayHeight, zoom);

    const brushPoint = brushPointRef.current;
    if (isBrushTool && brushPoint) {
      drawBrushCursor(
        ctx,
        brushPoint.x,
        brushPoint.y,
        Math.max(3, (brushSize * zoom) / 2),
        canvasMode === "delete" || canvasMode === "restore",
        canvasTool
      );
    }
  }, [source, originalImageData, processedImageData, compareMode, compareBeforeLayers, compareAfterLayers, split, zoom, pan, background, customBackground, canvasTool, brushSize, canvasMode, isBrushTool, hasSuperScaleStage]);

  useEffect(() => {
    renderCanvasRef.current = renderCanvas;
  }, [renderCanvas]);

  useEffect(() => {
    const onKeyDown = (event) => {
      const key = event.key.toLowerCase();
      const isUndoRedoKey = (event.metaKey || event.ctrlKey) && (key === "z" || key === "y");
      if (!isUndoRedoKey) return;

      const target = event.target;
      const isTyping = target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isTyping) return;

      if (key === "z" && event.shiftKey) {
        event.preventDefault();
        redoImageEdit();
        return;
      }

      if (key === "z") {
        event.preventDefault();
        undoImageEdit();
        return;
      }

      if (key === "y") {
        event.preventDefault();
        redoImageEdit();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  const scheduleCanvasRender = useCallback(() => {
    if (renderRafRef.current) return;
    renderRafRef.current = window.requestAnimationFrame(() => {
      renderRafRef.current = null;
      renderCanvas();
    });
  }, [renderCanvas]);

  useEffect(() => () => {
    if (renderRafRef.current) {
      window.cancelAnimationFrame(renderRafRef.current);
    }
    if (wheelZoomRef.current?.raf) {
      window.cancelAnimationFrame(wheelZoomRef.current.raf);
    }
  }, []);

  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => renderCanvasRef.current?.());
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const updateSetting = (group, key, value) => {
    if (settings[group]?.[key] === value) return;

    pushSettingsUndoSnapshot();
    setSettings((current) => ({
      ...current,
      [group]: {
        ...current[group],
        [key]: value
      }
    }));
  };

  const choosePreset = (id) => {
    if (id === preset) return;

    const next = allPresets.find((item) => item.id === id);
    if (!next) return;
    pushSettingsUndoSnapshot({ forceNew: true });
    setPreset(id);
    setSettings(structuredClone(next.settings));
  };

  const handleExport = async () => {
    if (!processedImageData || !source) return;
    if (!window.alphaKiller?.chooseExportTarget || !window.alphaKiller?.writeExport) {
      setToast({
        type: "warning",
        title: "Open Electron to export",
        message: "Native PNG and TIFF export uses Electron's save dialog."
      });
      return;
    }

    const baseName = source.name.replace(/\.[^.]+$/, "");
    const defaultFormat = source.format === "TIFF" ? "tiff" : "png";
    try {
      const target = await window.alphaKiller.chooseExportTarget({
        defaultPath: `${baseName}-cleaned.${defaultFormat === "tiff" ? "tiff" : "png"}`,
        defaultFormat
      });

      if (target?.canceled || !target?.exportId) return;

      const bytes = target.format === "tiff"
        ? encodeTiffImageData(processedImageData, source.resolution)
        : await imageDataToPngArrayBuffer(processedImageData, source.resolution);

      const result = await window.alphaKiller.writeExport({
        exportId: target.exportId,
        bytes
      });

      if (result?.canceled) return;
      const formatLabel = target.format === "tiff" ? "TIFF" : "PNG";
      const dpiLabel = source.resolution ? `, ${formatResolution(source.resolution)}` : "";
      setToast({
        type: "success",
        title: "Export complete",
        message: `${formatLabel} saved at ${processedImageData.width} x ${processedImageData.height}${dpiLabel}.`
      });
    } catch (error) {
      console.error(error);
      setToast({
        type: "error",
        title: "Export failed",
        message: error?.message || "AlphaKiller could not save the image."
      });
    }
  };

  const onDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragging(false);
    loadFile(event.dataTransfer.files?.[0]);
  };

  const updateCursorFromPoint = (point) => {
    if (!source || !processedImageData) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const frame = getImageFrame(source, zoom, pan, rect.width, rect.height);
    const imagePoint = getImagePoint(point, frame, zoom);
    if (!imagePoint) {
      setCursor(null);
      return;
    }
    const { x, y } = imagePoint;
    const index = (y * source.width + x) * 4;
    const data = processedImageData.data;
    setCursor({ x, y, r: data[index], g: data[index + 1], b: data[index + 2], a: data[index + 3] });
  };

  const eraseAtCanvasPoint = (point, interaction) => {
    const imagePoint = getImagePoint(point, interaction.frame, zoom);
    if (!imagePoint) {
      interaction.lastImagePoint = null;
      return;
    }

    eraseLinePixels(
      interaction.draftData,
      interaction.width,
      interaction.height,
      interaction.lastImagePoint || imagePoint,
      imagePoint,
      interaction.brushSize
    );
    eraseLineOnCanvas(
      originalCanvasCacheRef.current?.canvas,
      interaction.lastImagePoint || imagePoint,
      imagePoint,
      interaction.brushSize
    );
    eraseLineOnCanvas(
      processedCanvasCacheRef.current?.canvas,
      interaction.lastImagePoint || imagePoint,
      imagePoint,
      interaction.brushSize
    );
    interaction.lastImagePoint = imagePoint;
    interaction.changed = true;
    scheduleCanvasRender();
  };

  const reconstructAtCanvasPoint = (point, interaction) => {
    const imagePoint = getImagePoint(point, interaction.frame, zoom);
    if (!imagePoint) {
      interaction.lastImagePoint = null;
      return;
    }

    const from = interaction.lastImagePoint || imagePoint;
    reconstructLinePixels(
      interaction.draftData,
      interaction.restoreSourceData,
      interaction.width,
      interaction.height,
      from,
      imagePoint,
      interaction.brushSize
    );
    reconstructLineOnCanvas(
      originalCanvasCacheRef.current?.canvas,
      interaction.restoreSourceCanvas,
      from,
      imagePoint,
      interaction.brushSize
    );
    reconstructLineOnCanvas(
      processedCanvasCacheRef.current?.canvas,
      interaction.restoreSourceCanvas,
      from,
      imagePoint,
      interaction.brushSize
    );
    interaction.lastImagePoint = imagePoint;
    interaction.changed = true;
    scheduleCanvasRender();
  };

  const zoomAtPoint = (nextZoom, point) => {
    const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);

    if (!source || !canvasRef.current) {
      setZoom(clampedZoom);
      return;
    }

    const rect = canvasRef.current.getBoundingClientRect();
    const oldFrame = getImageFrame(source, zoom, pan, rect.width, rect.height);
    const imageX = (point.x - oldFrame.x) / zoom;
    const imageY = (point.y - oldFrame.y) / zoom;
    const centeredX = (rect.width - source.width * clampedZoom) / 2;
    const centeredY = (rect.height - source.height * clampedZoom) / 2;

    setZoom(clampedZoom);
    setPan({
      x: point.x - imageX * clampedZoom - centeredX,
      y: point.y - imageY * clampedZoom - centeredY
    });
  };

  const zoomAroundCanvasCenter = (nextZoom) => {
    const canvas = canvasRef.current;
    if (!canvas) {
      setZoom(clamp(nextZoom, MIN_ZOOM, MAX_ZOOM));
      return;
    }
    const rect = canvas.getBoundingClientRect();
    zoomAtPoint(nextZoom, { x: rect.width / 2, y: rect.height / 2 });
  };

  const fitImageToCanvas = () => {
    if (!source || !canvasRef.current) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const rect = canvasRef.current.getBoundingClientRect();
    const nextZoom = clamp(Math.min((rect.width * 0.82) / source.width, (rect.height * 0.82) / source.height), MIN_ZOOM, MAX_ZOOM);
    setZoom(nextZoom);
    setPan({ x: 0, y: 0 });
  };

  const setSplitFromCanvasX = (canvasX, frame) => {
    if (!frame.width) return;
    setSplit(clamp(((canvasX - frame.x) / frame.width) * 100, 0, 100));
  };

  const onCanvasWheel = (event) => {
    if (!source || !canvasRef.current) return;
    event.preventDefault();
    const point = getCanvasPoint(event, canvasRef.current);
    if (!wheelZoomRef.current) {
      wheelZoomRef.current = { delta: 0, point, raf: null };
    }

    const pending = wheelZoomRef.current;
    pending.delta += event.deltaY;
    pending.point = point;

    if (pending.raf) return;
    pending.raf = window.requestAnimationFrame(() => {
      const next = wheelZoomRef.current;
      wheelZoomRef.current = null;
      if (!next) return;
      const steps = clamp(-next.delta / 100, -6, 6);
      zoomAtPoint(zoom * Math.pow(ZOOM_FACTOR, steps), next.point);
    });
  };

  const onCanvasPointerDown = (event) => {
    if (!source || !processedImageData || !canvasRef.current) return;
    if (event.button !== 0 && event.button !== 1) return;

    const rect = canvasRef.current.getBoundingClientRect();
    const point = getCanvasPoint(event, canvasRef.current);
    const frame = getImageFrame(source, zoom, pan, rect.width, rect.height);
    const splitX = frame.x + frame.width * (split / 100);
    const overSplit = compareMode === "split" &&
      point.y >= frame.y - SPLIT_HIT_RADIUS &&
      point.y <= frame.y + frame.height + SPLIT_HIT_RADIUS &&
      Math.abs(point.x - splitX) <= SPLIT_HIT_RADIUS;
    const requestedBrushTool = canvasTool === "restore" && !canReconstruct ? "pan" : canvasTool;
    const kind = overSplit ? "split" : event.button === 1 || requestedBrushTool === "pan" ? "pan" : requestedBrushTool;
    const isBrushInteraction = BRUSH_TOOLS.has(kind);
    const restoreSourceImageData = kind === "restore" ? preSegmentationOriginalRef.current : null;

    interactionRef.current = {
      kind,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPan: pan,
      rect,
      frame,
      width: originalImageData.width,
      height: originalImageData.height,
      undoImageData: isBrushInteraction ? cloneImageData(originalImageData) : null,
      draftData: isBrushInteraction ? new Uint8ClampedArray(originalImageData.data) : null,
      restoreSourceData: restoreSourceImageData?.data || null,
      restoreSourceCanvas: restoreSourceImageData ? imageDataToCanvas(restoreSourceImageData) : null,
      lastImagePoint: null,
      changed: false,
      brushSize
    };
    canvasRef.current.setPointerCapture(event.pointerId);
    setCanvasMode(kind);
    brushPointRef.current = point;

    if (kind === "split") {
      setSplitFromCanvasX(point.x, frame);
    } else if (kind === "delete") {
      eraseAtCanvasPoint(point, interactionRef.current);
      updateCursorFromPoint(point);
      setStatus("Deleting pixels");
    } else if (kind === "restore") {
      reconstructAtCanvasPoint(point, interactionRef.current);
      updateCursorFromPoint(point);
      setStatus("Reconstructing pixels");
    }

    event.preventDefault();
  };

  const onCanvasPointerMove = (event) => {
    if (!canvasRef.current) return;
    const point = getCanvasPoint(event, canvasRef.current);
    const interaction = interactionRef.current;

    if (interaction?.kind === "pan") {
      setPan({
        x: interaction.startPan.x + event.clientX - interaction.startClientX,
        y: interaction.startPan.y + event.clientY - interaction.startClientY
      });
      return;
    }

    if (interaction?.kind === "split") {
      setSplitFromCanvasX(event.clientX - interaction.rect.left, interaction.frame);
      updateCursorFromPoint(point);
      return;
    }

    if (interaction?.kind === "delete") {
      brushPointRef.current = point;
      eraseAtCanvasPoint(point, interaction);
      updateCursorFromPoint(point);
      return;
    }

    if (interaction?.kind === "restore") {
      brushPointRef.current = point;
      reconstructAtCanvasPoint(point, interaction);
      updateCursorFromPoint(point);
      return;
    }

    if (source) {
      const rect = canvasRef.current.getBoundingClientRect();
      const frame = getImageFrame(source, zoom, pan, rect.width, rect.height);
      const splitX = frame.x + frame.width * (split / 100);
      const overSplit = compareMode === "split" &&
        point.y >= frame.y - SPLIT_HIT_RADIUS &&
        point.y <= frame.y + frame.height + SPLIT_HIT_RADIUS &&
        Math.abs(point.x - splitX) <= SPLIT_HIT_RADIUS;
      setCanvasMode(overSplit ? "hover-split" : "idle");
    }

    brushPointRef.current = point;
    if (isBrushTool) {
      scheduleCanvasRender();
    }
    updateCursorFromPoint(point);
  };

  const endCanvasInteraction = (event) => {
    const interaction = interactionRef.current;

    if (interactionRef.current && canvasRef.current?.hasPointerCapture?.(event.pointerId)) {
      canvasRef.current.releasePointerCapture(event.pointerId);
    }
    if (interaction?.kind === "delete" || interaction?.kind === "restore") {
      if (interaction.changed) {
        commitDocumentImageEdit(
          new ImageData(new Uint8ClampedArray(interaction.draftData), interaction.width, interaction.height),
          {
            undoFrom: interaction.undoImageData,
            statusText: interaction.kind === "restore" ? "Reconstruct Pen applied" : "Delete Pen applied"
          }
        );
      } else {
        setStatus("Ready");
      }
    }
    interactionRef.current = null;
    setCanvasMode("idle");
  };

  const showPage = (page) => {
    setActivePage(page);
    setSettingsPanelOpen(false);
  };

  return (
    <div
      className={`app ${dragging ? "is-dragging" : ""} ${activePage === "about" ? "is-about-page" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        dragDepthRef.current += 1;
        if (!dragging) setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/webp,image/tiff,.tif,.tiff"
        hidden
        onChange={(event) => loadFile(event.target.files?.[0])}
      />

      <header className="titlebar">
        <div className="brand">
          <Scissors size={15} />
          <strong>AlphaKiller</strong>
          <small>{APP_VERSION_LABEL}</small>
          <span>{source ? source.name : "No image loaded"}</span>
        </div>
        <nav>
          <button className={activePage === "editor" ? "nav-active" : ""} onClick={() => showPage("editor")}>Editor</button>
          <button className={activePage === "about" ? "nav-active" : ""} onClick={() => showPage("about")}>About</button>
        </nav>
      </header>

      {activePage === "editor" && (
      <div className="toolbar">
        <button className="icon-button" title="Open image" onClick={() => fileInputRef.current?.click()}>
          <FolderOpen size={16} />
        </button>
        <button className="icon-button" title="Save preset" aria-label="Save preset" onClick={openPresetDialog}>
          <Save size={16} />
        </button>
        <span className="divider" />
        <button className="icon-button" title="Undo" aria-label="Undo" disabled={!canUndo || isBackgroundRemoving || isSuperScaling} onClick={undoImageEdit}>
          <Undo2 size={16} />
        </button>
        <button className="icon-button" title="Redo" aria-label="Redo" disabled={!canRedo || isBackgroundRemoving || isSuperScaling} onClick={redoImageEdit}>
          <Redo2 size={16} />
        </button>
        <span className="divider" />
        <button className="icon-button" title="Zoom out" onClick={() => zoomAroundCanvasCenter(zoom / ZOOM_FACTOR)}>
          <ZoomOut size={16} />
        </button>
        <button className="toolbar-value" onClick={() => {
          setZoom(1);
          setPan({ x: 0, y: 0 });
        }}>{Math.round(zoom * 100)}%</button>
        <button className="icon-button" title="Zoom in" onClick={() => zoomAroundCanvasCenter(zoom * ZOOM_FACTOR)}>
          <ZoomIn size={16} />
        </button>
        <button className="icon-button" title="Fit" onClick={fitImageToCanvas}>
          <Maximize size={15} />
        </button>
        <span className="divider" />
        <button className={`icon-button ${canvasTool === "pan" ? "active" : ""}`} title="Pan tool" onClick={() => setCanvasTool("pan")}>
          <Hand size={16} />
        </button>
        <button className={`icon-button ${canvasTool === "delete" ? "active" : ""}`} title="Delete Pen" onClick={() => setCanvasTool("delete")}>
          <Eraser size={16} />
        </button>
        <button
          className={`icon-button ${canvasTool === "restore" ? "active" : ""}`}
          title={canReconstruct ? "Reconstruct Pen: paint back pixels from the original image" : "Run background removal before using Reconstruct Pen"}
          aria-label="Reconstruct Pen"
          disabled={!canReconstruct}
          onClick={() => setCanvasTool("restore")}
        >
          <Paintbrush size={16} />
        </button>
        <label className={`toolbar-slider ${isBrushTool ? "enabled" : ""}`}>
          <span>Size</span>
          <input
            type="range"
            min={MIN_BRUSH_SIZE}
            max={MAX_BRUSH_SIZE}
            value={brushSize}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            disabled={!isBrushTool}
          />
          <output>{brushSize}px</output>
        </label>
        <button
          className="icon-button bg-remove-button"
          title="Remove Background"
          aria-label="Remove Background"
          disabled={!originalImageData || isBackgroundRemoving || isSuperScaling}
          onClick={runBackgroundRemoval}
        >
          <Sparkles size={16} />
        </button>
        <button
          className="icon-button super-scale-button"
          title="Super Scale"
          aria-label="Super Scale"
          disabled={!originalImageData || isBackgroundRemoving || isSuperScaling}
          onClick={() => setSuperScaleDialogOpen(true)}
        >
          <Layers size={16} />
        </button>
        <label className={`hq-toggle ${bgRemoveRefine ? "enabled" : ""}`} title={BG_REMOVE_REFINE_AVAILABLE ? "High-quality edges" : "Edge refinement unavailable in the browser build"}>
          <input
            type="checkbox"
            checked={bgRemoveRefine}
            disabled={!originalImageData || isBackgroundRemoving || !BG_REMOVE_REFINE_AVAILABLE}
            onChange={(event) => updateBgRemoveRefine(event.target.checked)}
          />
          <span>High-quality edges</span>
        </label>
        <span className="divider" />
        <Segmented
          value={compareMode}
          onChange={setCompareMode}
          options={[
            ["after", "After"],
            ["before", "Before"],
            ["split", "Split"],
            ["mask", "Mask"],
            ["diff", "Diff"]
          ]}
        />
        <div className="spacer" />
        <button
          className={`icon-button ${settingsPanelOpen ? "active" : ""}`}
          title="Settings"
          aria-label="Settings"
          onClick={() => setSettingsPanelOpen((open) => !open)}
        >
          <Settings size={16} />
        </button>
        <button className="primary-button" disabled={!processedImageData || isSuperScaling} onClick={handleExport}>
          <Download size={15} />
          Export
        </button>
      </div>
      )}

      {activePage === "about" ? (
        <AboutPage version={APP_VERSION_LABEL} />
      ) : (
      <main className="workspace">
        <aside className="sidebar left">
          <PanelTitle title="Source" action={<Upload size={14} />} />
          {source ? (
            <div className="source-card">
              <div className="thumb">
                <img src={source.url} alt="" />
              </div>
              <strong>{source.name}</strong>
              <dl>
                <dt>Size</dt><dd>{source.width} x {source.height}</dd>
                <dt>DPI</dt><dd>{formatResolution(source.resolution)}</dd>
                <dt>Bytes</dt><dd>{formatBytes(source.size)}</dd>
                <dt>Type</dt><dd>{source.format || source.type.replace("image/", "").toUpperCase()}</dd>
                <dt>Alpha</dt><dd><span className="pill good">Detected</span></dd>
              </dl>
              {hasPreSegmentationOriginal && (
                <button className="restore-button" onClick={restoreOriginal}>
                  <RefreshCcw size={13} />
                  Restore Original
                </button>
              )}
            </div>
          ) : (
            <div className="empty-panel">
              <FileImage size={32} />
              <strong>Drop a PNG, WebP, or TIFF</strong>
              <span>The first import stays local and previews immediately.</span>
              <button onClick={() => fileInputRef.current?.click()}>Open Image</button>
            </div>
          )}

          <PanelTitle title="Inspection" />
          <div className="metric-list">
            <Metric label="Semi-alpha" value={stats ? percent(stats.semiAlphaPct) : "-"} />
            <Metric label="Changed pixels" value={stats ? percent(stats.changedPct) : "-"} />
            <Metric label="Cursor" value={cursor ? `${cursor.x}, ${cursor.y}` : "-"} />
            <Metric label="RGBA" value={cursor ? `${cursor.r} ${cursor.g} ${cursor.b} ${cursor.a}` : "-"} />
          </div>
        </aside>

        <section className={`canvas-shell ${source ? "has-image" : ""} ${canvasTool === "delete" ? "is-eraser" : ""} ${canvasTool === "restore" ? "is-reconstruct" : ""} ${canvasMode === "pan" ? "is-panning" : ""} ${canvasMode === "split" ? "is-splitting" : ""} ${canvasMode === "delete" ? "is-deleting" : ""} ${canvasMode === "restore" ? "is-restoring" : ""} ${canvasMode === "hover-split" ? "can-split" : ""}`}>
          {isBackgroundRemoving && (
            <div className="bg-remove-progress">
              <span>{BG_REMOVE_LABELS[bgRemoveStatus]}</span>
              <strong>{Math.round(bgRemoveProgress * 100)}%</strong>
              <div><i style={{ width: `${Math.round(bgRemoveProgress * 100)}%` }} /></div>
            </div>
          )}
          {isSuperScaling && (
            <div className="bg-remove-progress">
              <span>Super scaling with BRIA</span>
              <strong>{Math.round(superScaleProgress * 100)}%</strong>
              <div><i style={{ width: `${Math.round(superScaleProgress * 100)}%` }} /></div>
            </div>
          )}
          <div className="canvas-tools">
            <div className="canvas-tools-left">
              <div className="swatches" role="group" aria-label="Preview background">
                {BACKGROUNDS.map((item) => (
                  <button
                    key={item.id}
                    className={`swatch ${item.id} ${background === item.id ? "active" : ""}`}
                    title={item.label}
                    onClick={() => setBackground(item.id)}
                  />
                ))}
                <input
                  type="color"
                  value={customBackground}
                  onChange={(event) => {
                    setCustomBackground(event.target.value);
                    setBackground("custom");
                  }}
                  aria-label="Custom preview color"
                />
              </div>
              {compareMode === "split" && (
                <label className="split-control">
                  <SplitSquareHorizontal size={14} />
                  <input type="range" min="0" max="100" value={split} onChange={(event) => setSplit(Number(event.target.value))} />
                </label>
              )}
            </div>
            <div className="compare-layers" aria-label="Comparison feature layers">
              <CompareLayerRow
                label="Before"
                layers={compareBeforeLayers}
                availability={compareFeatureAvailability}
                onChange={(feature, value) => updateCompareLayer("before", feature, value)}
              />
              <CompareLayerRow
                label="After"
                layers={compareAfterLayers}
                availability={compareFeatureAvailability}
                onChange={(feature, value) => updateCompareLayer("after", feature, value)}
              />
            </div>
          </div>
          <canvas
            ref={canvasRef}
            onWheel={onCanvasWheel}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={endCanvasInteraction}
            onPointerCancel={endCanvasInteraction}
            onMouseLeave={() => {
              if (!interactionRef.current) {
                setCursor(null);
                brushPointRef.current = null;
                setCanvasMode("idle");
                scheduleCanvasRender();
              }
            }}
          />
          <div className="drop-overlay">
            <ImageDown size={44} />
            <strong>Drop image to inspect</strong>
          </div>
        </section>

        <aside className="sidebar right">
          <PanelTitle title="Inspector" action={<SlidersHorizontal size={14} />} />
          <section className="control-section">
            <label className="field-label">Preset</label>
            <div className="select-wrap">
              <select value={preset} onChange={(event) => choosePreset(event.target.value)}>
                <optgroup label="Built-in">
                  {PRESETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </optgroup>
                {customPresets.length > 0 && (
                  <optgroup label="Saved">
                    {customPresets.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </optgroup>
                )}
              </select>
              <ChevronDown size={14} />
            </div>
            <p>{selectedPreset?.description || "Unsaved cleanup settings."}</p>
            {selectedCustomPreset && (
              <button className="text-button preset-delete" onClick={deleteSelectedCustomPreset}>
                Delete saved preset
              </button>
            )}
          </section>

          <ToolSection
            icon={<Wand2 size={15} />}
            title="Defringe"
            enabled={settings.defringe.enabled}
            onToggle={(value) => updateSetting("defringe", "enabled", value)}
          >
            <ColorControl label="Matte" value={settings.defringe.matteColor} onChange={(value) => updateSetting("defringe", "matteColor", value)} />
            <RangeControl label="Strength" value={settings.defringe.strength} min={0} max={200} unit="%" onChange={(value) => updateSetting("defringe", "strength", value)} />
            <RangeControl label="Matte tolerance" value={settings.defringe.tolerance ?? 255} min={0} max={255} onChange={(value) => updateSetting("defringe", "tolerance", value)} />
            <RangeControl label="Edge radius" value={settings.defringe.radius} min={1} max={6} unit="px" onChange={(value) => updateSetting("defringe", "radius", value)} />
          </ToolSection>

          <ToolSection
            icon={<Blend size={15} />}
            title="Color Bleed"
            enabled={settings.bleed.enabled}
            onToggle={(value) => updateSetting("bleed", "enabled", value)}
          >
            <RangeControl label="Radius" value={settings.bleed.radius} min={1} max={8} unit="px" onChange={(value) => updateSetting("bleed", "radius", value)} />
            <RangeControl label="Iterations" value={settings.bleed.iterations} min={1} max={6} onChange={(value) => updateSetting("bleed", "iterations", value)} />
            <ToggleRow label="Use bleed color" checked={settings.bleed.useCustomColor ?? false} onChange={(value) => updateSetting("bleed", "useCustomColor", value)} />
            <ColorControl label="Bleed color" value={settings.bleed.color ?? "#ffffff"} onChange={(value) => updateSetting("bleed", "color", value)} />
            <ToggleRow label="Affect semi-alpha" checked={settings.bleed.affectSemiTransparent} onChange={(value) => updateSetting("bleed", "affectSemiTransparent", value)} />
          </ToolSection>

          <ToolSection
            icon={<Activity size={15} />}
            title="Alpha Threshold"
            enabled={settings.threshold.enabled}
            onToggle={(value) => updateSetting("threshold", "enabled", value)}
          >
            <RangeControl label="Threshold" value={settings.threshold.threshold} min={0} max={255} onChange={(value) => updateSetting("threshold", "threshold", value)} />
            <RangeControl label="Softness" value={settings.threshold.softness} min={0} max={64} onChange={(value) => updateSetting("threshold", "softness", value)} />
          </ToolSection>

          <ToolSection
            icon={<Sparkles size={15} />}
            title="Alpha Hardening"
            enabled={settings.hardening.enabled}
            onToggle={(value) => updateSetting("hardening", "enabled", value)}
          >
            <RangeControl label="Strength" value={settings.hardening.strength} min={0} max={100} unit="%" onChange={(value) => updateSetting("hardening", "strength", value)} />
            <RangeControl label="Midpoint" value={settings.hardening.midpoint} min={1} max={99} unit="%" onChange={(value) => updateSetting("hardening", "midpoint", value)} />
          </ToolSection>
        </aside>
      </main>
      )}

      <footer className="statusbar">
        <span><Check size={12} /> {status}</span>
        <span>Zoom {Math.round(zoom * 100)}%</span>
        <span>{source ? `${source.width} x ${source.height}` : "No image"}</span>
        <span>{cursor ? `Alpha ${cursor.a}` : "Alpha -"}</span>
        <span>{canvasTool === "delete" ? `Delete Pen ${brushSize}px` : canvasTool === "restore" ? `Reconstruct Pen ${brushSize}px` : "Pan tool"}</span>
        <span>{isSuperScaling ? `SS BRIA ${Math.round(superScaleProgress * 100)}%` : isBackgroundRemoving ? `AI ${BG_REMOVE_LABELS[bgRemoveStatus]}${bgRemoveDevice === "cpu" ? " (CPU)" : bgRemoveDevice === "api" ? " (API)" : ""}` : `AI ${BG_REMOVE_MODELS[bgRemoveModel]?.shortLabel || "-"}`}</span>
        <span>Bg {background}</span>
      </footer>

      {settingsPanelOpen && (
        <SettingsPanel
          models={BG_REMOVE_MODELS}
          selectedModel={bgRemoveModel}
          refineDefault={bgRemoveRefine}
          briaPreserveAlpha={briaPreserveAlpha}
          disabled={isBackgroundRemoving}
          refineAvailable={BG_REMOVE_REFINE_AVAILABLE}
          hasWebGpu={hasWebGpu}
          hasElectronBackgroundRemoval={hasElectronBackgroundRemoval}
          photoroomTokenValue={loadStoredPhotoroomToken()}
          briaTokenValue={loadStoredBriaToken()}
          onModelChange={updateBgRemoveModel}
          onRefineDefaultChange={updateBgRemoveRefine}
          onBriaPreserveAlphaChange={updateBriaPreserveAlpha}
          onPhotoroomTokenSave={savePhotoroomSettingsToken}
          onBriaTokenSave={saveBriaSettingsToken}
          onClose={() => setSettingsPanelOpen(false)}
        />
      )}

      {superScaleDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="super-scale-dialog" onSubmit={(event) => {
            event.preventDefault();
            runBriaSuperScale();
          }}>
            <div className="dialog-title-row">
              <strong>Super Scale</strong>
              <button className="icon-button" type="button" aria-label="Close Super Scale" onClick={() => setSuperScaleDialogOpen(false)}>
                <X size={15} />
              </button>
            </div>
            <span>Upscale through BRIA Increase Resolution while keeping transparency. Print size stays unchanged when DPI is scaled with the pixels.</span>
            <fieldset className="scale-options">
              <legend>Scale</legend>
              {[2, 4].map((factor) => (
                <label key={factor} className={superScaleFactor === factor ? "selected" : ""}>
                  <input
                    type="radio"
                    name="super-scale-factor"
                    value={factor}
                    checked={superScaleFactor === factor}
                    onChange={() => setSuperScaleFactor(factor)}
                  />
                  <b>{factor}x</b>
                  <small>{source ? `${source.width} x ${source.height} -> ${source.width * factor} x ${source.height * factor}` : "No image loaded"}</small>
                </label>
              ))}
            </fieldset>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={superScaleKeepPrintSize}
                onChange={(event) => setSuperScaleKeepPrintSize(event.target.checked)}
              />
              <span>
                <strong>Keep same print size</strong>
                <small>Increase DPI by the same factor so the physical dimensions stay unchanged.</small>
              </span>
            </label>
            <div className="scale-summary">
              <span>Output</span>
              <strong>{superScaleOutputWidth} x {superScaleOutputHeight}</strong>
              <span>DPI</span>
              <strong>{formatResolution(superScaleOutputResolution)}</strong>
            </div>
            {!hasElectronSuperScale && (
              <p className="dialog-warning">Open the Electron app or restart it so the Super Scale IPC handler is available.</p>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={() => setSuperScaleDialogOpen(false)}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!source || isSuperScaling || !hasElectronSuperScale}>Run BRIA Super Scale</button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.type}`}>
          <strong>{toast.title}</strong>
          <span>{toast.message}</span>
        </div>
      )}

      {presetDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="preset-dialog" onSubmit={saveCurrentPreset}>
            <strong>Save Slider Settings</strong>
            <span>Store the current cleanup controls as a reusable preset on this computer.</span>
            <input
              autoFocus
              type="text"
              value={presetNameDraft}
              onChange={(event) => setPresetNameDraft(event.target.value)}
              placeholder="Preset name"
              maxLength={48}
            />
            <div className="dialog-actions">
              <button type="button" onClick={closePresetDialog}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!sanitizePresetName(presetNameDraft)}>Save preset</button>
            </div>
          </form>
        </div>
      )}

      {hfTokenDialogOpen && (
        <div className="modal-backdrop" role="presentation">
          <form className="hf-token-dialog" onSubmit={submitHfToken}>
            <strong>Hugging Face token</strong>
            <span>Paste a Hugging Face read token for gated background-removal models.</span>
            <input
              autoFocus
              type="password"
              value={hfTokenDraft}
              onChange={(event) => setHfTokenDraft(event.target.value)}
              placeholder="hf_..."
              spellCheck={false}
            />
            <div className="dialog-actions">
              <button type="button" onClick={cancelHfTokenDialog}>Cancel</button>
              <button type="submit" className="primary-button" disabled={!sanitizeToken(hfTokenDraft)}>Save token</button>
            </div>
          </form>
        </div>
      )}

      <canvas ref={originalCanvasRef} hidden />
      <canvas ref={processedCanvasRef} hidden />
      <canvas ref={maskCanvasRef} hidden />
      <canvas ref={diffCanvasRef} hidden />
    </div>
  );
}

function PanelTitle({ title, action }) {
  return (
    <div className="panel-title">
      <span>{title}</span>
      {action}
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="segmented">
      {options.map(([id, label]) => (
        <button key={id} className={value === id ? "active" : ""} onClick={() => onChange(id)}>{label}</button>
      ))}
    </div>
  );
}

function CompareLayerRow({ label, layers, availability, onChange }) {
  return (
    <div className="compare-layer-row">
      <span>{label}</span>
      {COMPARE_FEATURES.map((feature) => {
        const disabled = !availability[feature.id] && feature.id !== "alpha" && feature.id !== "manual";
        return (
          <label key={feature.id} title={feature.title} className={disabled ? "disabled" : ""}>
            <input
              type="checkbox"
              checked={Boolean(layers[feature.id])}
              disabled={disabled}
              onChange={(event) => onChange(feature.id, event.target.checked)}
            />
            <b>{feature.label}</b>
          </label>
        );
      })}
    </div>
  );
}

function ToolSection({ icon, title, enabled, onToggle, children }) {
  return (
    <section className={`tool-section ${enabled ? "enabled" : ""}`}>
      <header>
        <span>{icon}{title}</span>
        <Switch checked={enabled} onChange={onToggle} />
      </header>
      <div className="tool-body">{children}</div>
    </section>
  );
}

function RangeControl({ label, value, min, max, unit = "", onChange }) {
  return (
    <label className="range-control">
      <span>{label}<output>{value}{unit}</output></span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function ColorControl({ label, value, onChange }) {
  return (
    <label className="color-control">
      <span>{label}</span>
      <input type="color" value={value} onChange={(event) => onChange(event.target.value)} />
      <code>{value.toUpperCase()}</code>
    </label>
  );
}

function ToggleRow({ label, checked, onChange }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <Switch checked={checked} onChange={onChange} />
    </label>
  );
}

function Switch({ checked, onChange }) {
  return (
    <button className={`switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

function AboutPage({ version }) {
  return (
    <main className="about-page">
      <section className="about-hero">
        <div className="about-mark">
          <Scissors size={30} />
        </div>
        <div>
          <p className="eyebrow">Desktop alpha cleanup</p>
          <h1>AlphaKiller</h1>
          <span>{version}</span>
        </div>
      </section>

      <section className="about-grid">
        <article className="about-panel">
          <h2>What It Does</h2>
          <p>
            AlphaKiller prepares transparent artwork for production by removing matte halos,
            cleaning hidden RGB, refining semi-transparent edges, and exporting clean PNG or TIFF files.
          </p>
        </article>

        <article className="about-panel">
          <h2>Current Beta</h2>
          <ul>
            <li>PNG, WebP, TIFF import</li>
            <li>Transparent PNG and TIFF export</li>
            <li>DPI preservation for PNG and TIFF sources</li>
            <li>Undo/redo and locally saved cleanup presets</li>
          </ul>
        </article>

        <article className="about-panel">
          <h2>Background Removal</h2>
          <p>
            Fast mode uses local RMBG-1.4. BEN2 is available as a WebGPU quality fallback.
            BRIA RMBG-2.0 remains experimental for comparison.
          </p>
        </article>

        <article className="about-panel">
          <h2>Notes</h2>
          <p>
            This beta is built for local review and iteration. Packaging, signing,
            batch workflows, and advanced model management are still future work.
          </p>
        </article>
      </section>
    </main>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function imageDataToCachedCanvas(imageData, cacheRef, fallbackRef) {
  if (!cacheRef.current) {
    cacheRef.current = {
      canvas: fallbackRef?.current || document.createElement("canvas"),
      imageData: null
    };
  }

  const cache = cacheRef.current;
  const canvas = cache.canvas;

  if (cache.imageData !== imageData) {
    if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
      canvas.width = imageData.width;
      canvas.height = imageData.height;
    }
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    cache.imageData = imageData;
  }

  return canvas;
}

function imageDataToCanvas(imageData) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  return canvas;
}

function drawBackground(ctx, width, height, background, customBackground) {
  if (background === "checker") {
    ctx.fillStyle = getCheckerPattern(ctx);
    ctx.fillRect(0, 0, width, height);
    return;
  }
  ctx.fillStyle = background === "black" ? "#000" : background === "white" ? "#fff" : background === "gray" ? "#858b94" : customBackground;
  ctx.fillRect(0, 0, width, height);
}

function getCheckerPattern(ctx) {
  const cached = checkerPatternCache.get(ctx);
  if (cached) return cached;

  const size = 18;
  const tile = document.createElement("canvas");
  tile.width = size * 2;
  tile.height = size * 2;
  const tileCtx = tile.getContext("2d");
  tileCtx.fillStyle = "#202327";
  tileCtx.fillRect(0, 0, tile.width, tile.height);
  tileCtx.fillStyle = "#181b1f";
  tileCtx.fillRect(0, 0, size, size);
  tileCtx.fillRect(size, size, size, size);

  const pattern = ctx.createPattern(tile, "repeat");
  if (!pattern) return "#202327";
  checkerPatternCache.set(ctx, pattern);
  return pattern;
}

function drawEmptyMark(ctx, width, height) {
  ctx.save();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = "rgba(255,255,255,.14)";
  ctx.setLineDash([8, 8]);
  roundRect(ctx, width / 2 - 150, height / 2 - 110, 300, 220, 12);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.72)";
  ctx.font = "600 16px system-ui";
  ctx.textAlign = "center";
  ctx.fillText("Drop a PNG, WebP, or TIFF", width / 2, height / 2 - 4);
  ctx.font = "12px system-ui";
  ctx.fillStyle = "rgba(255,255,255,.42)";
  ctx.fillText("Alpha cleanup preview appears here", width / 2, height / 2 + 22);
  ctx.restore();
}

function drawAlphaMask(ctx, imageData, x, y, width, height, cacheRef, fallbackRef) {
  const canvas = alphaMaskToCachedCanvas(imageData, cacheRef, fallbackRef);
  ctx.drawImage(canvas, x, y, width, height);
}

function drawDifference(ctx, original, processed, x, y, width, height, cacheRef, fallbackRef) {
  const canvas = differenceToCachedCanvas(original, processed, cacheRef, fallbackRef);
  ctx.drawImage(canvas, x, y, width, height);
}

function alphaMaskToCachedCanvas(imageData, cacheRef, fallbackRef) {
  if (!cacheRef.current) {
    cacheRef.current = {
      canvas: fallbackRef?.current || document.createElement("canvas"),
      imageData: null
    };
  }

  const cache = cacheRef.current;
  const canvas = cache.canvas;

  if (cache.imageData !== imageData) {
    if (canvas.width !== imageData.width || canvas.height !== imageData.height) {
      canvas.width = imageData.width;
      canvas.height = imageData.height;
    }
    const mask = new ImageData(imageData.width, imageData.height);
    for (let i = 0; i < imageData.data.length; i += 4) {
      const alpha = imageData.data[i + 3];
      mask.data[i] = alpha;
      mask.data[i + 1] = alpha;
      mask.data[i + 2] = alpha;
      mask.data[i + 3] = 255;
    }
    canvas.getContext("2d").putImageData(mask, 0, 0);
    cache.imageData = imageData;
  }

  return canvas;
}

function differenceToCachedCanvas(original, processed, cacheRef, fallbackRef) {
  if (!cacheRef.current) {
    cacheRef.current = {
      canvas: fallbackRef?.current || document.createElement("canvas"),
      original: null,
      processed: null
    };
  }

  const cache = cacheRef.current;
  const canvas = cache.canvas;

  if (cache.original !== original || cache.processed !== processed) {
    const width = processed.width;
    const height = processed.height;
    const originalData = original.width === width && original.height === height
      ? original
      : resizeImageDataForComparison(original, width, height);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const diff = new ImageData(width, height);
    for (let i = 0; i < processed.data.length; i += 4) {
      const delta = Math.abs(originalData.data[i] - processed.data[i]) +
        Math.abs(originalData.data[i + 1] - processed.data[i + 1]) +
        Math.abs(originalData.data[i + 2] - processed.data[i + 2]) +
        Math.abs(originalData.data[i + 3] - processed.data[i + 3]);
      diff.data[i] = Math.min(255, delta * 2);
      diff.data[i + 1] = delta > 0 ? 76 : 0;
      diff.data[i + 2] = delta > 0 ? 140 : 0;
      diff.data[i + 3] = delta > 0 ? 255 : 28;
    }
    canvas.getContext("2d").putImageData(diff, 0, 0);
    cache.original = original;
    cache.processed = processed;
  }

  return canvas;
}

function resizeImageDataForComparison(imageData, width, height) {
  const sourceCanvas = imageDataToCachedCanvas(imageData, { current: null });
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(sourceCanvas, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

function drawBadge(ctx, text, x, y) {
  ctx.save();
  ctx.font = "700 10px system-ui";
  ctx.fillStyle = "rgba(0,0,0,.58)";
  roundRect(ctx, x, y, 56, 22, 5);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.82)";
  ctx.fillText(text, x + 9, y + 15);
  ctx.restore();
}

function drawSplitHandle(ctx, x, y, height) {
  const handleY = y + height / 2 - 20;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.42)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "rgba(10, 11, 13, .82)";
  ctx.strokeStyle = "rgba(255,255,255,.72)";
  ctx.lineWidth = 1;
  roundRect(ctx, x - 12, handleY, 24, 40, 12);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = "rgba(255,255,255,.74)";
  ctx.beginPath();
  ctx.moveTo(x - 4, handleY + 13);
  ctx.lineTo(x - 8, handleY + 20);
  ctx.lineTo(x - 4, handleY + 27);
  ctx.moveTo(x + 4, handleY + 13);
  ctx.lineTo(x + 8, handleY + 20);
  ctx.lineTo(x + 4, handleY + 27);
  ctx.stroke();
  ctx.restore();
}

function drawBrushCursor(ctx, x, y, radius, active, tool = "delete") {
  const restoring = tool === "restore";
  ctx.save();
  ctx.strokeStyle = active
    ? restoring ? "rgba(95, 227, 142, .96)" : "rgba(255, 107, 95, .96)"
    : "rgba(255, 255, 255, .9)";
  ctx.fillStyle = active
    ? restoring ? "rgba(95, 227, 142, .16)" : "rgba(255, 107, 95, .16)"
    : "rgba(10, 11, 13, .2)";
  ctx.lineWidth = 1.5;
  ctx.setLineDash(active ? [] : [4, 4]);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(0, 0, 0, .55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - 5, y);
  ctx.lineTo(x + 5, y);
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 5);
  ctx.stroke();
  ctx.restore();
}

function drawPixelGrid(ctx, x, y, width, height, zoom) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.lineWidth = 1;
  for (let gx = x; gx <= x + width; gx += zoom) {
    ctx.beginPath();
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + height);
    ctx.stroke();
  }
  for (let gy = y; gy <= y + height; gy += zoom) {
    ctx.beginPath();
    ctx.moveTo(x, gy);
    ctx.lineTo(x + width, gy);
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function bgRemoveStageToStatus(stage) {
  if (stage === "download") return "downloading";
  if (stage === "warming") return "warming";
  if (stage === "infer" || stage === "infer-stage1" || stage === "infer-stage2" || stage === "compose") return "inferring";
  return "inferring";
}

function getBgRemoveErrorMessage(message = "") {
  const lower = message.toLowerCase();
  if (lower.includes("no handler registered") || lower.includes("background-removal:run")) {
    return "Electron needs to be restarted so the background-removal IPC handler is registered.";
  }
  if (lower.includes("photoroom")) {
    if (lower.includes("missing photoroom_api_key")) {
      return "Missing PhotoRoom API key. Add it in Settings or launch Electron with PHOTOROOM_API_KEY set.";
    }
    if (lower.includes("key") && (lower.includes("rejected") || lower.includes("access"))) {
      return "The PhotoRoom API key was rejected. Check the key and the account's API access.";
    }
    if (lower.includes("6,000") || lower.includes("36 megapixels")) {
      return "PhotoRoom supports images up to 6,000 pixels on either side and 36 megapixels.";
    }
    if (lower.includes("format") || lower.includes("png")) {
      return "PhotoRoom rejected the input or output format. AlphaKiller requires a full-resolution PNG response.";
    }
  }
  if (lower.includes("bria")) {
    if (lower.includes("missing bria_api_token")) {
      return "Missing BRIA_API_TOKEN. Launch the Electron app with BRIA_API_TOKEN set in the main-process environment.";
    }
    if (lower.includes("token") || lower.includes("401") || lower.includes("403")) {
      return "The BRIA API token was rejected. Check BRIA_API_TOKEN and the account's API access.";
    }
    if (lower.includes("415") || lower.includes("png")) {
      return "BRIA rejected the input image format. AlphaKiller expected a normalized PNG upload.";
    }
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "The background-removal provider is rate limited. Wait a moment and try again.";
  }
  if (lower.includes("no hugging face token")) {
    return "No Hugging Face token is available to AlphaKiller. In Electron, launch with HF_TOKEN set. In the browser preview, set localStorage key alphakiller:hf-token.";
  }
  if (lower.includes("token was rejected")) {
    return "The Hugging Face token was rejected for the background-removal model. Make sure the token was created by the account that has model access and includes read permission.";
  }
  if (
    lower.includes("restricted") ||
    lower.includes("unauthorized") ||
    lower.includes("authorization") ||
    lower.includes("authenticate") ||
    lower.includes("gated") ||
    lower.includes("access to model") ||
    lower.includes("401") ||
    lower.includes("rmbg-2.0")
  ) {
    return "The background-removal model is restricted on Hugging Face. Accept the model license and authenticate before retrying.";
  }
  if (lower.includes("fetch") || lower.includes("network") || lower.includes("download")) {
    return "Could not download the background removal model. Check your connection and try again.";
  }
  if (lower.includes("memory") || lower.includes("allocation") || lower.includes("out of")) {
    return "Image too large for background removal at full resolution.";
  }
  if (lower.includes("corrupt") || lower.includes("invalid model")) {
    return "The cached background removal model appears to be invalid. Try clearing the app cache and retrying.";
  }
  return message || "Background removal failed.";
}

function getSuperScaleErrorMessage(message = "") {
  const lower = String(message || "").toLowerCase();
  if (lower.includes("no handler registered") || lower.includes("super-scale:run")) {
    return "Electron needs to be restarted so the Super Scale IPC handler is registered.";
  }
  if (lower.includes("missing bria")) {
    return "Missing BRIA_API_TOKEN. Add a BRIA token in Settings or launch Electron with BRIA_API_TOKEN set.";
  }
  if (lower.includes("401") || lower.includes("403") || lower.includes("token")) {
    return "The BRIA API token was rejected. Check the token and account access.";
  }
  if (lower.includes("8192")) {
    return "BRIA Super Scale supports output up to 8192 x 8192 pixels. Try 2x or start from a smaller image.";
  }
  if (lower.includes("rate limit") || lower.includes("429")) {
    return "The BRIA API is rate limited. Wait a moment and try again.";
  }
  if (lower.includes("format") || lower.includes("415")) {
    return "BRIA rejected the input image format. AlphaKiller expected a normalized PNG upload.";
  }
  return message || "Super Scale failed.";
}

async function getHuggingFaceToken() {
  try {
    const electronToken = await window.alphaKiller?.getHuggingFaceToken?.();
    const token = sanitizeToken(electronToken);
    if (token) return token;
  } catch {
    // Browser-only previews do not expose Electron's preload bridge.
  }

  try {
    return sanitizeToken(window.localStorage?.getItem(HF_TOKEN_KEY));
  } catch {
    return "";
  }
}

function sanitizeToken(token) {
  return typeof token === "string" ? token.trim() : "";
}

function sanitizePresetName(name) {
  return typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 48) : "";
}

function loadPersistedBgRemoveModel() {
  try {
    const value = window.localStorage?.getItem(BG_REMOVE_MODEL_KEY);
    const model = BG_REMOVE_MODELS[value];
    if (!model) return "rmbg-1.4";
    if (model.requiresWebGpu && !window.navigator?.gpu) return "rmbg-1.4";
    if (model.requiresElectron && !window.alphaKiller?.removeBackground) return "rmbg-1.4";
    return value;
  } catch {
    return "rmbg-1.4";
  }
}

function loadPersistedBgRemoveRefine() {
  if (!BG_REMOVE_REFINE_AVAILABLE) return false;
  try {
    return window.localStorage?.getItem(BG_REMOVE_REFINE_KEY) === "true";
  } catch {
    return false;
  }
}

function loadPersistedBriaPreserveAlpha() {
  try {
    const value = window.localStorage?.getItem(BRIA_PRESERVE_ALPHA_KEY);
    return value === null ? true : value === "true";
  } catch {
    return true;
  }
}

function loadCustomPresets() {
  try {
    const raw = window.localStorage?.getItem(CUSTOM_PRESETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeCustomPreset)
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function persistCustomPresets(presets) {
  persistLocalStorage(CUSTOM_PRESETS_KEY, JSON.stringify(presets.map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    settings: item.settings
  }))));
}

function normalizeCustomPreset(preset) {
  const name = sanitizePresetName(preset?.name);
  if (!name || !preset?.settings) return null;
  return {
    id: typeof preset.id === "string" && preset.id.startsWith("custom:") ? preset.id : `custom:${Date.now().toString(36)}:${name}`,
    name,
    description: "Saved cleanup settings.",
    custom: true,
    settings: normalizePresetSettings(preset.settings)
  };
}

function normalizePresetSettings(settings) {
  return {
    threshold: {
      ...DEFAULT_SETTINGS.threshold,
      ...(settings?.threshold || {})
    },
    defringe: {
      ...DEFAULT_SETTINGS.defringe,
      ...(settings?.defringe || {})
    },
    bleed: {
      ...DEFAULT_SETTINGS.bleed,
      ...(settings?.bleed || {})
    },
    hardening: {
      ...DEFAULT_SETTINGS.hardening,
      ...(settings?.hardening || {})
    }
  };
}

function loadStoredHfToken() {
  try {
    return sanitizeToken(window.localStorage?.getItem(HF_TOKEN_KEY));
  } catch {
    return "";
  }
}

function loadStoredBriaToken() {
  try {
    return sanitizeToken(window.localStorage?.getItem(BRIA_TOKEN_KEY));
  } catch {
    return "";
  }
}

function loadStoredPhotoroomToken() {
  try {
    return sanitizeToken(window.localStorage?.getItem(PHOTOROOM_TOKEN_KEY));
  } catch {
    return "";
  }
}

function persistLocalStorage(key, value) {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    // Settings remain in memory when browser storage is unavailable.
  }
}

function removeLocalStorage(key) {
  try {
    window.localStorage?.removeItem(key);
  } catch {
    // Settings remain in memory when browser storage is unavailable.
  }
}

function cloneImageData(imageData) {
  return new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
}

function cloneResolution(resolution) {
  return resolution ? { ...resolution } : null;
}

function scaleResolution(resolution, factor) {
  if (!resolution) return null;
  return {
    ...resolution,
    xDpi: resolution.xDpi * factor,
    yDpi: resolution.yDpi * factor,
    source: resolution.source || "metadata"
  };
}

function getCanvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function getImageFrame(source, zoom, pan, canvasWidth, canvasHeight) {
  const width = source.width * zoom;
  const height = source.height * zoom;
  return {
    x: Math.round((canvasWidth - width) / 2 + pan.x),
    y: Math.round((canvasHeight - height) / 2 + pan.y),
    width,
    height
  };
}

function getImagePoint(point, frame, zoom) {
  const x = Math.floor((point.x - frame.x) / zoom);
  const y = Math.floor((point.y - frame.y) / zoom);
  const sourceWidth = Math.round(frame.width / zoom);
  const sourceHeight = Math.round(frame.height / zoom);

  if (x < 0 || y < 0 || x >= sourceWidth || y >= sourceHeight) {
    return null;
  }

  return { x, y };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function eraseLinePixels(data, width, height, from, to, brushSize) {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, brushSize / 3)));

  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    eraseCirclePixels(data, width, height, {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t
    }, brushSize / 2);
  }
}

function reconstructLinePixels(data, sourceData, width, height, from, to, brushSize) {
  if (!sourceData || sourceData.length !== data.length) return;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, brushSize / 3)));

  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    reconstructCirclePixels(data, sourceData, width, height, {
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t
    }, brushSize / 2);
  }
}

function eraseLineOnCanvas(canvas, from, to, brushSize) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const radius = brushSize / 2;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, brushSize / 3)));

  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function reconstructLineOnCanvas(canvas, sourceCanvas, from, to, brushSize) {
  if (!canvas || !sourceCanvas || canvas.width !== sourceCanvas.width || canvas.height !== sourceCanvas.height) return;
  const ctx = canvas.getContext("2d");
  const radius = brushSize / 2;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(1, Math.ceil(distance / Math.max(1, brushSize / 3)));

  ctx.save();
  ctx.beginPath();
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }
  ctx.clip();
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.restore();
}

function eraseCirclePixels(data, width, height, center, radius) {
  const minX = Math.max(0, Math.floor(center.x - radius));
  const maxX = Math.min(width - 1, Math.ceil(center.x + radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxY = Math.min(height - 1, Math.ceil(center.y + radius));
  const radiusSq = radius * radius;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - center.x;
      const dy = y - center.y;
      if (dx * dx + dy * dy > radiusSq) continue;
      const index = (y * width + x) * 4;
      data[index + 3] = 0;
    }
  }
}

function reconstructCirclePixels(data, sourceData, width, height, center, radius) {
  const minX = Math.max(0, Math.floor(center.x - radius));
  const maxX = Math.min(width - 1, Math.ceil(center.x + radius));
  const minY = Math.max(0, Math.floor(center.y - radius));
  const maxY = Math.min(height - 1, Math.ceil(center.y + radius));
  const radiusSq = radius * radius;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - center.x;
      const dy = y - center.y;
      if (dx * dx + dy * dy > radiusSq) continue;
      const index = (y * width + x) * 4;
      data[index] = sourceData[index];
      data[index + 1] = sourceData[index + 1];
      data[index + 2] = sourceData[index + 2];
      data[index + 3] = sourceData[index + 3];
    }
  }
}

function isSupportedImageFile(file) {
  const name = file.name.toLowerCase();
  return RASTER_MIME_RE.test(file.type) || SUPPORTED_IMAGE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function isTiffFile(file) {
  const name = file.name.toLowerCase();
  return file.type === "image/tiff" || file.type === "image/x-tiff" || name.endsWith(".tif") || name.endsWith(".tiff");
}

async function decodeTiffFile(file) {
  const buffer = await file.arrayBuffer();
  const ifds = UTIF.decode(buffer);
  if (!ifds.length) {
    throw new Error("TIFF did not contain a decodable image");
  }

  const image = ifds[0];
  UTIF.decodeImage(buffer, image);
  const rgba = UTIF.toRGBA8(image);
  const imageData = new ImageData(new Uint8ClampedArray(rgba), image.width, image.height);
  const previewUrl = imageDataToObjectUrl(imageData);
  return { imageData, previewUrl, resolution: readTiffResolution(image) };
}

async function readFileResolution(file) {
  if (!isPngFile(file)) return null;
  try {
    return readPngResolution(await file.arrayBuffer());
  } catch {
    return null;
  }
}

function isPngFile(file) {
  const name = file.name.toLowerCase();
  return file.type === "image/png" || name.endsWith(".png");
}

function imageDataToObjectUrl(imageData) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

async function imageDataToPngArrayBuffer(imageData, resolution = null) {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext("2d").putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((nextBlob) => {
      if (nextBlob) {
        resolve(nextBlob);
      } else {
        reject(new Error("Could not encode source image as PNG."));
      }
    }, "image/png");
  });
  return applyPngResolution(await blob.arrayBuffer(), resolution);
}

async function pngArrayBufferToImageData(pngBytes) {
  const bytes = pngBytes instanceof ArrayBuffer
    ? pngBytes
    : pngBytes?.buffer?.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);

  if (!(bytes instanceof ArrayBuffer)) {
    throw new Error("Background-removal result did not include PNG bytes.");
  }

  const blob = new Blob([bytes], { type: "image/png" });
  if (window.createImageBitmap) {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
      bitmap.close?.();
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode background-removal PNG result."));
      image.src = objectUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

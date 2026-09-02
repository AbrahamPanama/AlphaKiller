import runtimeManifest from "../third_party/opencv/5.0.0/runtime-manifest.json" with { type: "json" };

const DEFAULT_MODULE_URL = new URL(
  "../third_party/opencv/5.0.0/opencv.mjs",
  import.meta.url
).href;
const DEFAULT_WASM_URL = new URL(
  "../third_party/opencv/5.0.0/opencv.wasm",
  import.meta.url
).href;
const DEFAULT_TIMEOUT_MS = 45_000;
const runtimeRecords = new Map();

export const OPENCV_RUNTIME_BUILD = Object.freeze({
  version: runtimeManifest.opencv.version,
  commit: runtimeManifest.opencv.commit,
  artifactStatus: runtimeManifest.status,
  profile: runtimeManifest.build.profile,
  simd: runtimeManifest.build.simd,
  threads: runtimeManifest.build.threads,
  modules: Object.freeze([...runtimeManifest.build.modules]),
  moduleUrl: DEFAULT_MODULE_URL,
  wasmUrl: DEFAULT_WASM_URL
});

export class OpenCvRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "OpenCvRuntimeError";
    this.code = code;
  }
}

function detectSimdSupport() {
  if (typeof WebAssembly?.validate !== "function") {
    return false;
  }

  try {
    // A minimal module returning a v128. Validation is enough; it is not run.
    return WebAssembly.validate(new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
      0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00,
      0x0a, 0x0a, 0x01, 0x08, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x62, 0x0b
    ]));
  } catch {
    return false;
  }
}

export function getOpenCvHostCapabilities() {
  const worker = typeof WorkerGlobalScope !== "undefined"
    && typeof self !== "undefined"
    && self instanceof WorkerGlobalScope;
  const renderer = typeof window !== "undefined" && typeof document !== "undefined";
  const crossOriginIsolatedValue = globalThis.crossOriginIsolated === true;

  return {
    environment: worker ? "worker" : renderer ? "renderer" : "node-or-unknown",
    webAssembly: typeof WebAssembly === "object",
    simd: detectSimdSupport(),
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    crossOriginIsolated: crossOriginIsolatedValue,
    threads: typeof SharedArrayBuffer === "function" && crossOriginIsolatedValue
  };
}

function hasFunction(value, name) {
  return typeof value?.[name] === "function";
}

function inspectRuntime(cv, host = getOpenCvHostCapabilities()) {
  const findContours = hasFunction(cv, "findContours") && typeof cv?.MatVector === "function";
  const intelligentScissors = typeof cv?.segmentation_IntelligentScissorsMB === "function"
    || typeof cv?.IntelligentScissorsMB === "function";
  const guidedFilter = hasFunction(cv, "guidedFilter")
    || hasFunction(cv, "ximgproc_guidedFilter");

  const features = {
    matrix: typeof cv?.Mat === "function",
    findContours,
    trucoContourExtraction: findContours
      ? "automatic-when-opencv-selects-it"
      : "unavailable",
    distanceTransform: hasFunction(cv, "distanceTransform"),
    distanceTransformWithLabels: hasFunction(cv, "distanceTransformWithLabels"),
    grabCut: hasFunction(cv, "grabCut"),
    inpaint: hasFunction(cv, "inpaint"),
    intelligentScissors,
    guidedFilter,
    dnn: Boolean(cv?.dnn_Net) || hasFunction(cv, "readNetFromONNX")
  };

  const baselineReady = features.matrix
    && features.findContours
    && features.distanceTransform
    && features.grabCut
    && features.inpaint;

  return {
    available: baselineReady,
    version: runtimeManifest.opencv.version,
    commit: runtimeManifest.opencv.commit,
    profile: runtimeManifest.build.profile,
    host,
    build: {
      simd: runtimeManifest.build.simd,
      threads: runtimeManifest.build.threads,
      modules: [...runtimeManifest.build.modules]
    },
    features,
    limitations: [
      "This foundation build is single-threaded; it does not require cross-origin isolation.",
      "ximgproc/guidedFilter is intentionally absent until its OpenCV 5 JS binding is verified.",
      "The DNN module is intentionally absent from the renderer runtime."
    ]
  };
}

function emptyCapabilities(host = getOpenCvHostCapabilities()) {
  return {
    available: false,
    version: runtimeManifest.opencv.version,
    commit: runtimeManifest.opencv.commit,
    profile: runtimeManifest.build.profile,
    host,
    build: {
      simd: runtimeManifest.build.simd,
      threads: runtimeManifest.build.threads,
      modules: [...runtimeManifest.build.modules]
    },
    features: {
      matrix: false,
      findContours: false,
      trucoContourExtraction: "unavailable",
      distanceTransform: false,
      distanceTransformWithLabels: false,
      grabCut: false,
      inpaint: false,
      intelligentScissors: false,
      guidedFilter: false,
      dnn: false
    },
    limitations: []
  };
}

function serializeFailure(error, fallbackCode = "OPENCV_LOAD_FAILED") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : "Error"
  };
}

function unavailableResult(error, host) {
  return {
    available: false,
    cv: null,
    capabilities: emptyCapabilities(host),
    error: serializeFailure(error)
  };
}

function resolveRequest(options) {
  const customModule = typeof options.moduleUrl === "string" && options.moduleUrl.length > 0;
  const customWasm = typeof options.wasmUrl === "string" && options.wasmUrl.length > 0;
  return {
    moduleUrl: customModule ? options.moduleUrl : DEFAULT_MODULE_URL,
    wasmUrl: customWasm ? options.wasmUrl : DEFAULT_WASM_URL,
    usesDefaultArtifacts: !customModule && !customWasm
  };
}

async function instantiateRuntime(request) {
  const imported = await import(/* @vite-ignore */ request.moduleUrl);
  const factory = imported?.default;
  if (typeof factory !== "function") {
    throw new OpenCvRuntimeError(
      "OPENCV_INVALID_MODULE",
      "The OpenCV runtime module does not export an Emscripten factory."
    );
  }

  const cv = await factory({
    locateFile(fileName) {
      if (fileName.endsWith(".wasm")) {
        return request.wasmUrl;
      }
      return new URL(fileName, request.moduleUrl).href;
    }
  });

  if (cv?.ready && typeof cv.ready.then === "function") {
    await cv.ready;
  }

  return cv;
}

async function instantiatePackagedRuntime() {
  const imported = await import("@techstark/opencv-js");
  const value = imported?.default || imported;
  return Promise.resolve(value);
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new OpenCvRuntimeError(
        "OPENCV_LOAD_TIMEOUT",
        `OpenCV did not initialize within ${timeoutMs} ms.`
      ));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function throwForResult(result) {
  if (result.available) {
    return;
  }
  throw new OpenCvRuntimeError(result.error.code, result.error.message);
}

/**
 * Lazily loads the pinned OpenCV runtime. It is DOM-free and safe to call from
 * renderer code or an ES-module worker. Failures resolve to an unavailable
 * result by default so optional CV features cannot take down the editor.
 */
export async function loadOpenCvRuntime(options = {}) {
  const host = getOpenCvHostCapabilities();
  const request = resolveRequest(options);
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, options.timeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const cacheKey = `${request.moduleUrl}\n${request.wasmUrl}`;

  if (!host.webAssembly) {
    const result = unavailableResult(new OpenCvRuntimeError(
      "OPENCV_WASM_UNSUPPORTED",
      "WebAssembly is unavailable in this environment."
    ), host);
    if (options.throwOnError) throwForResult(result);
    return result;
  }

  if (runtimeManifest.build.simd && !host.simd) {
    const result = unavailableResult(new OpenCvRuntimeError(
      "OPENCV_SIMD_UNSUPPORTED",
      "This OpenCV build requires WebAssembly SIMD, which is unavailable."
    ), host);
    if (options.throwOnError) throwForResult(result);
    return result;
  }

  if (options.retry) {
    runtimeRecords.delete(cacheKey);
  }

  const cached = runtimeRecords.get(cacheKey);
  if (cached) {
    const result = await cached;
    if (options.throwOnError) throwForResult(result);
    return result;
  }

  const usePackagedFallback = request.usesDefaultArtifacts && runtimeManifest.status !== "ready";
  const pending = withTimeout(
    usePackagedFallback ? instantiatePackagedRuntime() : instantiateRuntime(request),
    timeoutMs
  )
    .then((cv) => {
      const capabilities = inspectRuntime(cv, host);
      if (!capabilities.available) {
        throw new OpenCvRuntimeError(
          "OPENCV_BASELINE_CAPABILITIES_MISSING",
          "OpenCV loaded, but the required AlphaKiller bindings are incomplete."
        );
      }
      return {
        available: true,
        cv,
        capabilities: {
          ...capabilities,
          source: usePackagedFallback ? "official-opencv-js-npm-mirror" : "custom-pinned-wasm"
        },
        error: null
      };
    })
    .catch((error) => unavailableResult(error, host));

  runtimeRecords.set(cacheKey, pending);
  const result = await pending;
  if (options.throwOnError) throwForResult(result);
  return result;
}

export async function requireOpenCvRuntime(options = {}) {
  const result = await loadOpenCvRuntime({ ...options, throwOnError: true });
  return result.cv;
}

export function getOpenCvRuntimeState() {
  const key = `${DEFAULT_MODULE_URL}\n${DEFAULT_WASM_URL}`;
  return {
    artifactStatus: runtimeManifest.status,
    cached: runtimeRecords.has(key),
    build: OPENCV_RUNTIME_BUILD,
    host: getOpenCvHostCapabilities()
  };
}

export function clearOpenCvRuntimeCache() {
  runtimeRecords.clear();
}

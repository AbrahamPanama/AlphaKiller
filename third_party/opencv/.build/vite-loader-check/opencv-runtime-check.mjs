const status = "not-built";
const opencv = { "version": "5.0.0", "commit": "40738fb16ceddb5fb3fea747585f7ce6abb0605b" };
const build = { "profile": "wasm-simd-single-thread", "simd": true, "threads": false, "modules": ["core", "imgproc", "photo", "js"] };
const runtimeManifest = {
  status,
  opencv,
  build
};
const DEFAULT_MODULE_URL = new URL("data:text/javascript;base64,Ly8gQ2xlYW4tY2xvbmUgcGxhY2Vob2xkZXIuIHNjcmlwdHMvb3BlbmN2L2J1aWxkLW9wZW5jdjUuc2ggcmVwbGFjZXMgdGhpcyBmaWxlCi8vIHdpdGggdGhlIHBpbm5lZCBFbXNjcmlwdGVuIG91dHB1dC4gVGhlIHJ1bnRpbWUgbWFuaWZlc3QgcHJldmVudHMgbm9ybWFsIGNvZGUKLy8gZnJvbSBpbXBvcnRpbmcgdGhpcyBwbGFjZWhvbGRlci4KZXhwb3J0IGRlZmF1bHQgYXN5bmMgZnVuY3Rpb24gY3JlYXRlTWlzc2luZ09wZW5Ddk1vZHVsZSgpIHsKICBjb25zdCBlcnJvciA9IG5ldyBFcnJvcigKICAgICJUaGUgcGlubmVkIE9wZW5DViA1IHJ1bnRpbWUgaGFzIG5vdCBiZWVuIGJ1aWx0LiBSdW4gc2NyaXB0cy9vcGVuY3YvYnVpbGQtb3BlbmN2NS5zaC4iCiAgKTsKICBlcnJvci5jb2RlID0gIk9QRU5DVl9BUlRJRkFDVFNfTUlTU0lORyI7CiAgdGhyb3cgZXJyb3I7Cn0K", import.meta.url).href;
const DEFAULT_WASM_URL = new URL("data:application/wasm;base64,QWxwaGFLaWxsZXIgT3BlbkNWIDUgcGxhY2Vob2xkZXIuIFJ1biBzY3JpcHRzL29wZW5jdi9idWlsZC1vcGVuY3Y1LnNoLgo=", import.meta.url).href;
const DEFAULT_TIMEOUT_MS = 45e3;
const runtimeRecords = /* @__PURE__ */ new Map();
const OPENCV_RUNTIME_BUILD = Object.freeze({
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
class OpenCvRuntimeError extends Error {
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
    return WebAssembly.validate(new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      5,
      1,
      96,
      0,
      1,
      123,
      3,
      2,
      1,
      0,
      10,
      10,
      1,
      8,
      0,
      65,
      0,
      253,
      15,
      253,
      98,
      11
    ]));
  } catch {
    return false;
  }
}
function getOpenCvHostCapabilities() {
  const worker = typeof WorkerGlobalScope !== "undefined" && typeof self !== "undefined" && self instanceof WorkerGlobalScope;
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
  const intelligentScissors = typeof cv?.segmentation_IntelligentScissorsMB === "function" || typeof cv?.IntelligentScissorsMB === "function";
  const guidedFilter = hasFunction(cv, "guidedFilter") || hasFunction(cv, "ximgproc_guidedFilter");
  const features = {
    matrix: typeof cv?.Mat === "function",
    findContours,
    trucoContourExtraction: findContours ? "automatic-when-opencv-selects-it" : "unavailable",
    distanceTransform: hasFunction(cv, "distanceTransform"),
    distanceTransformWithLabels: hasFunction(cv, "distanceTransformWithLabels"),
    grabCut: hasFunction(cv, "grabCut"),
    inpaint: hasFunction(cv, "inpaint"),
    intelligentScissors,
    guidedFilter,
    dnn: Boolean(cv?.dnn_Net) || hasFunction(cv, "readNetFromONNX")
  };
  const baselineReady = features.matrix && features.findContours && features.distanceTransform && features.grabCut && features.inpaint;
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
  const imported = await import(
    /* @vite-ignore */
    request.moduleUrl
  );
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
async function loadOpenCvRuntime(options = {}) {
  const host = getOpenCvHostCapabilities();
  const request = resolveRequest(options);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const cacheKey = `${request.moduleUrl}
${request.wasmUrl}`;
  if (!host.webAssembly) {
    const result2 = unavailableResult(new OpenCvRuntimeError(
      "OPENCV_WASM_UNSUPPORTED",
      "WebAssembly is unavailable in this environment."
    ), host);
    if (options.throwOnError) throwForResult(result2);
    return result2;
  }
  if (!host.simd) {
    const result2 = unavailableResult(new OpenCvRuntimeError(
      "OPENCV_SIMD_UNSUPPORTED",
      "This OpenCV build requires WebAssembly SIMD, which is unavailable."
    ), host);
    if (options.throwOnError) throwForResult(result2);
    return result2;
  }
  if (request.usesDefaultArtifacts && runtimeManifest.status !== "ready") {
    const result2 = unavailableResult(new OpenCvRuntimeError(
      "OPENCV_ARTIFACTS_MISSING",
      "The pinned OpenCV 5 runtime has not been built. Run scripts/opencv/build-opencv5.sh."
    ), host);
    if (options.throwOnError) throwForResult(result2);
    return result2;
  }
  if (options.retry) {
    runtimeRecords.delete(cacheKey);
  }
  const cached = runtimeRecords.get(cacheKey);
  if (cached) {
    const result2 = await cached;
    if (options.throwOnError) throwForResult(result2);
    return result2;
  }
  const pending = withTimeout(instantiateRuntime(request), timeoutMs).then((cv) => {
    const capabilities = inspectRuntime(cv, host);
    if (!capabilities.available) {
      throw new OpenCvRuntimeError(
        "OPENCV_BASELINE_CAPABILITIES_MISSING",
        "OpenCV loaded, but the required AlphaKiller bindings are incomplete."
      );
    }
    return { available: true, cv, capabilities, error: null };
  }).catch((error) => unavailableResult(error, host));
  runtimeRecords.set(cacheKey, pending);
  const result = await pending;
  if (options.throwOnError) throwForResult(result);
  return result;
}
async function requireOpenCvRuntime(options = {}) {
  const result = await loadOpenCvRuntime({ ...options, throwOnError: true });
  return result.cv;
}
function getOpenCvRuntimeState() {
  const key = `${DEFAULT_MODULE_URL}
${DEFAULT_WASM_URL}`;
  return {
    artifactStatus: runtimeManifest.status,
    cached: runtimeRecords.has(key),
    build: OPENCV_RUNTIME_BUILD,
    host: getOpenCvHostCapabilities()
  };
}
function clearOpenCvRuntimeCache() {
  runtimeRecords.clear();
}
export {
  OPENCV_RUNTIME_BUILD,
  OpenCvRuntimeError,
  clearOpenCvRuntimeCache,
  getOpenCvHostCapabilities,
  getOpenCvRuntimeState,
  loadOpenCvRuntime,
  requireOpenCvRuntime
};

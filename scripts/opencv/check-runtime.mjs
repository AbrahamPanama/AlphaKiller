import assert from "node:assert/strict";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import {
  OPENCV_RUNTIME_BUILD,
  clearOpenCvRuntimeCache,
  getOpenCvHostCapabilities,
  getOpenCvRuntimeState,
  loadOpenCvRuntime
} from "../../src/opencvRuntime.js";

const fakeModule = `data:text/javascript,${encodeURIComponent(`
  export default async function createOpenCv() {
    return {
      Mat: class Mat {},
      MatVector: class MatVector {},
      findContours() {},
      distanceTransform() {},
      distanceTransformWithLabels() {},
      grabCut() {},
      inpaint() {},
      segmentation_IntelligentScissorsMB: class IntelligentScissorsMB {}
    };
  }
`)}`;

assert.equal(OPENCV_RUNTIME_BUILD.version, "5.0.0");
assert.equal(OPENCV_RUNTIME_BUILD.commit, "40738fb16ceddb5fb3fea747585f7ce6abb0605b");

const host = getOpenCvHostCapabilities();
assert.equal(host.webAssembly, true, "Node must expose WebAssembly for this check");

const fakeResult = await loadOpenCvRuntime({
  moduleUrl: fakeModule,
  wasmUrl: "data:application/wasm;base64,AGFzbQEAAAA=",
  timeoutMs: 1_000
});
assert.equal(fakeResult.available, true);
assert.equal(fakeResult.capabilities.features.findContours, true);
assert.equal(fakeResult.capabilities.features.distanceTransformWithLabels, true);
assert.equal(fakeResult.capabilities.features.grabCut, true);
assert.equal(fakeResult.capabilities.features.inpaint, true);
assert.equal(fakeResult.capabilities.features.intelligentScissors, true);
assert.equal(fakeResult.capabilities.features.guidedFilter, false);
assert.equal(fakeResult.capabilities.features.dnn, false);

const failingModule = `data:text/javascript,${encodeURIComponent(`
  export default async function fail() {
    const error = new Error("synthetic OpenCV load failure");
    error.code = "SYNTHETIC_FAILURE";
    throw error;
  }
`)}`;
const failedResult = await loadOpenCvRuntime({
  moduleUrl: failingModule,
  wasmUrl: "data:application/wasm;base64,AGFzbQEAAAA=",
  timeoutMs: 1_000
});
assert.equal(failedResult.available, false);
assert.equal(failedResult.error.code, "SYNTHETIC_FAILURE");

const timeoutModule = `data:text/javascript,${encodeURIComponent(`
  export default function neverFinishes() {
    return new Promise(() => {});
  }
`)}`;
const timeoutResult = await loadOpenCvRuntime({
  moduleUrl: timeoutModule,
  wasmUrl: "data:application/wasm;base64,AGFzbQEAAAA=",
  timeoutMs: 10
});
assert.equal(timeoutResult.available, false);
assert.equal(timeoutResult.error.code, "OPENCV_LOAD_TIMEOUT");

const worker = new Worker(new URL("./check-runtime-worker.mjs", import.meta.url));
const [workerResult] = await once(worker, "message");
assert.equal(workerResult.available, true, workerResult.error?.message);
assert.equal(workerResult.features.findContours, true);
assert.equal(workerResult.features.grabCut, true);

let defaultResult = { available: null, error: null };
if (OPENCV_RUNTIME_BUILD.artifactStatus === "ready") {
  defaultResult = await loadOpenCvRuntime({ timeoutMs: 60_000 });
  assert.equal(defaultResult.available, true, defaultResult.error?.message);
} else {
  defaultResult = await loadOpenCvRuntime();
  assert.equal(defaultResult.available, true, defaultResult.error?.message);
  assert.equal(defaultResult.capabilities.source, "official-opencv-js-npm-mirror");
}

const state = getOpenCvRuntimeState();
assert.equal(state.artifactStatus, OPENCV_RUNTIME_BUILD.artifactStatus);

clearOpenCvRuntimeCache();

console.log(JSON.stringify({
  ok: true,
  build: OPENCV_RUNTIME_BUILD,
  host,
  defaultRuntime: {
    available: defaultResult.available,
    error: defaultResult.error
  },
  workerRuntime: {
    available: workerResult.available,
    findContours: workerResult.features.findContours,
    grabCut: workerResult.features.grabCut
  },
  fakeRuntimeFeatures: fakeResult.capabilities.features
}, null, 2));

import { parentPort } from "node:worker_threads";
import { loadOpenCvRuntime } from "../../src/opencvRuntime.js";

const fakeModule = `data:text/javascript,${encodeURIComponent(`
  export default async function createOpenCv() {
    return {
      Mat: class Mat {},
      MatVector: class MatVector {},
      findContours() {},
      distanceTransform() {},
      distanceTransformWithLabels() {},
      grabCut() {},
      inpaint() {}
    };
  }
`)}`;

const result = await loadOpenCvRuntime({
  moduleUrl: fakeModule,
  wasmUrl: "data:application/wasm;base64,AGFzbQEAAAA=",
  timeoutMs: 1_000
});

parentPort.postMessage({
  available: result.available,
  features: result.capabilities.features,
  error: result.error
});

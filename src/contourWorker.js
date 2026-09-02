import { ContourCancelledError, traceContourEngine } from "./contourEngine.js";
import { repairMagneticContour } from "./magneticContour.js";
import { traceVectorContour as traceLegacyContour } from "./vectorTrace.js";

const cancelledRequests = new Set();
let pendingJob = null;
let activeJob = null;
let latestRequestId = null;
let disposed = false;

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type === "cancel") {
    cancelRequest(message.id);
    return;
  }
  if (message.type === "dispose") {
    disposed = true;
    pendingJob = null;
    if (activeJob) cancelledRequests.add(activeJob.id);
    return;
  }
  if (message.type === "repair") {
    void runMagneticRepair(message);
    return;
  }
  if (message.type && message.type !== "trace" && message.type !== "run") return;

  if (pendingJob) {
    postCancelled(pendingJob);
    cancelledRequests.delete(pendingJob.id);
  }
  try {
    pendingJob = normalizeJob(message);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message.id,
      revision: message.revision ?? null,
      error: error instanceof Error ? error.message : "Invalid contour worker request"
    });
    pendingJob = null;
    return;
  }
  latestRequestId = pendingJob.id;
  void drainQueue();
};

async function runMagneticRepair(message) {
  try {
    const bytes = new Uint8ClampedArray(message.buffer);
    const imageData = { data: bytes, width: message.width, height: message.height };
    const result = await repairMagneticContour({
      imageData,
      contour: message.contour,
      startAnchor: message.startAnchor,
      endAnchor: message.endAnchor,
      options: {
        roiPadding: message.options?.roiPadding ?? 64,
        simplifyTolerance: message.options?.simplifyTolerance ?? 0.7,
        smoothing: message.options?.smoothing ?? message.contour?.simplifyTolerance ?? 2,
        replaceArc: message.options?.replaceArc ?? "shorter",
        maxNodes: message.options?.maxNodes ?? 800000
      }
    });
    self.postMessage({
      type: "repair-result",
      id: message.id,
      contour: result.contour,
      solver: result.solver,
      points: result.points,
      diagnostics: result.diagnostics
    });
  } catch (error) {
    self.postMessage({
      type: "repair-error",
      id: message.id,
      error: error instanceof Error ? error.message : "Magnetic contour repair failed"
    });
  }
}

async function drainQueue() {
  if (activeJob || disposed) return;
  while (pendingJob && !disposed) {
    const job = pendingJob;
    pendingJob = null;
    activeJob = job;
    postStatus(job, "tracing");

    try {
      const imageData = decodeImageData(job);
      const contour = runTrace(job, imageData);

      // Let queued run/cancel messages update staleness before publishing a completed trace.
      await yieldToWorkerQueue();
      if (isCancelledOrStale(job)) {
        postCancelled(job);
      } else {
        self.postMessage({
          type: "result",
          id: job.id,
          revision: job.revision,
          engine: contour.engine || (job.engine === "legacy" ? "legacy" : "subpixel-v2"),
          contour
        });
      }
    } catch (error) {
      await yieldToWorkerQueue();
      if (error instanceof ContourCancelledError || isCancelledOrStale(job)) {
        postCancelled(job);
      } else {
        self.postMessage({
          type: "error",
          id: job.id,
          revision: job.revision,
          error: error instanceof Error ? error.message : "Unknown contour tracing error"
        });
      }
    } finally {
      cancelledRequests.delete(job.id);
      activeJob = null;
    }
  }
}

function runTrace(job, imageData) {
  if (job.engine === "legacy") return markLegacy(traceLegacyContour(toLegacyImageData(imageData), job.options));
  try {
    return traceContourEngine(imageData, {
      ...job.options,
      shouldCancel: () => isCancelledOrStale(job) || sharedCancellationRequested(job.cancelView)
    });
  } catch (error) {
    if (
      error instanceof ContourCancelledError ||
      job.legacyFallback === false ||
      isCancelledOrStale(job) ||
      sharedCancellationRequested(job.cancelView)
    ) {
      throw error;
    }
    const contour = markLegacy(traceLegacyContour(toLegacyImageData(imageData), job.options));
    contour.fallbackReason = error instanceof Error ? error.message : "Subpixel contour engine failed";
    return contour;
  }
}

function decodeImageData(job) {
  const pixelCount = job.width * job.height;
  const bytes = new Uint8ClampedArray(job.buffer);
  if (bytes.length === pixelCount) {
    return { width: job.width, height: job.height, alpha: bytes };
  }
  if (bytes.length < pixelCount * 4) throw new Error("Contour worker received an incomplete RGBA/alpha buffer.");
  return { width: job.width, height: job.height, data: bytes };
}

function normalizeJob(message) {
  if (message.id == null) throw new Error("Contour worker requires a request id.");
  const width = Math.max(0, Math.floor(Number(message.width) || 0));
  const height = Math.max(0, Math.floor(Number(message.height) || 0));
  if (!(message.buffer instanceof ArrayBuffer)) throw new Error("Contour worker requires an ArrayBuffer.");
  let cancelView = null;
  if (typeof SharedArrayBuffer !== "undefined" && message.cancelBuffer instanceof SharedArrayBuffer) {
    cancelView = new Int32Array(message.cancelBuffer, 0, 1);
  }
  return {
    id: message.id,
    revision: message.revision ?? null,
    width,
    height,
    buffer: message.buffer,
    options: message.options || {},
    engine: message.engine || "subpixel-v2",
    legacyFallback: message.legacyFallback !== false,
    cancelView
  };
}

function cancelRequest(id) {
  if (id == null) {
    if (pendingJob) postCancelled(pendingJob);
    if (activeJob) cancelledRequests.add(activeJob.id);
    pendingJob = null;
    latestRequestId = null;
    return;
  }
  cancelledRequests.add(id);
  if (pendingJob?.id === id) {
    postCancelled(pendingJob);
    pendingJob = null;
    cancelledRequests.delete(id);
  }
  if (latestRequestId === id) latestRequestId = null;
}

function isCancelledOrStale(job) {
  return disposed || cancelledRequests.has(job.id) || latestRequestId !== job.id;
}

function sharedCancellationRequested(cancelView) {
  return cancelView ? Atomics.load(cancelView, 0) !== 0 : false;
}

function postStatus(job, stage) {
  self.postMessage({ type: "status", id: job.id, revision: job.revision, stage });
}

function postCancelled(job) {
  self.postMessage({ type: "cancelled", id: job.id, revision: job.revision });
}

function markLegacy(contour) {
  return { ...contour, engine: "legacy" };
}

function toLegacyImageData(imageData) {
  if (imageData.data) return imageData;
  const alpha = imageData.alpha;
  const rgba = new Uint8ClampedArray(imageData.width * imageData.height * 4);
  for (let index = 0; index < alpha.length; index += 1) {
    const rgbaIndex = index * 4;
    rgba[rgbaIndex] = 255;
    rgba[rgbaIndex + 1] = 255;
    rgba[rgbaIndex + 2] = 255;
    rgba[rgbaIndex + 3] = alpha[index];
  }
  return { width: imageData.width, height: imageData.height, data: rgba };
}

function yieldToWorkerQueue() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

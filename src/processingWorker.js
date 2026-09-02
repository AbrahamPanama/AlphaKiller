import { affectedPixelStats, applyProcessing } from "./imageProcessing.js";
import { createSmartEdgeOpenCvAdapter, getOpenCvCapabilities } from "./opencvAdapters.js";
import { loadOpenCvRuntime } from "./opencvRuntime.js";

let segmentationStages = null;

self.onmessage = async (event) => {
  try {
    const {
      type,
      id,
      buffer,
      width,
      height,
      settings,
      revision,
      segmentationRevision,
      conservativeAlphaBuffer,
      aggressiveAlphaBuffer
    } = event.data;

    if (type === "set-segmentation-stages") {
      const conservativeAlpha = new Uint8Array(conservativeAlphaBuffer);
      const aggressiveAlpha = new Uint8Array(aggressiveAlphaBuffer);
      const pixelCount = width * height;
      if (conservativeAlpha.length < pixelCount || aggressiveAlpha.length < pixelCount) {
        throw new Error("Segmentation stage alpha is smaller than its declared dimensions");
      }
      segmentationStages = {
        revision,
        width,
        height,
        conservativeAlpha,
        aggressiveAlpha
      };
      return;
    }

    if (type === "clear-segmentation-stages") {
      segmentationStages = null;
      return;
    }

    const original = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const useSmartEdge = settings?.edgeFinish?.enabled && settings.edgeFinish.treatment === "smart";
    const runtimeResult = useSmartEdge ? await loadOpenCvRuntime() : null;
    const cv = runtimeResult?.available ? runtimeResult.cv : null;
    const adapter = cv ? createSmartEdgeOpenCvAdapter(cv) : null;
    const activeSegmentationStages = segmentationStages &&
      segmentationStages.revision === segmentationRevision &&
      segmentationStages.width === width &&
      segmentationStages.height === height
      ? segmentationStages
      : null;
    const processed = applyProcessing(original, settings, {
      adapter,
      segmentationStages: activeSegmentationStages
    });
    const stats = affectedPixelStats(original, processed);

    self.postMessage({
      id,
      width,
      height,
      buffer: processed.data.buffer,
      stats,
      vision: cv ? getOpenCvCapabilities(cv) : null
    }, [processed.data.buffer]);
  } catch (error) {
    self.postMessage({
      id: event.data?.id,
      error: error instanceof Error ? error.message : "Unknown processing error"
    });
  }
};

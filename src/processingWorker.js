import { affectedPixelStats, applyProcessing } from "./imageProcessing.js";

self.onmessage = (event) => {
  try {
    const { id, buffer, width, height, settings } = event.data;
    const original = new ImageData(new Uint8ClampedArray(buffer), width, height);
    const processed = applyProcessing(original, settings);
    const stats = affectedPixelStats(original, processed);

    self.postMessage({
      id,
      width,
      height,
      buffer: processed.data.buffer,
      stats
    }, [processed.data.buffer]);
  } catch (error) {
    self.postMessage({
      id: event.data?.id,
      error: error instanceof Error ? error.message : "Unknown processing error"
    });
  }
};

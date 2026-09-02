import { applySmartBrushEdit } from "./smartBrush.js";
import { loadOpenCvRuntime } from "./opencvRuntime.js";

self.onmessage = async (event) => {
  const message = event.data;
  if (message?.type !== "run") return;

  try {
    const runtime = message.preferOpenCv === false ? null : await loadOpenCvRuntime();
    const opencv = runtime?.available ? runtime.cv : null;
    const currentData = new Uint8ClampedArray(message.currentBuffer);
    const sourceData = message.sourceBuffer
      ? new Uint8ClampedArray(message.sourceBuffer)
      : currentData;
    const result = applySmartBrushEdit({
      currentImage: { data: currentData, width: message.width, height: message.height },
      sourceImage: { data: sourceData, width: message.width, height: message.height },
      strokes: message.strokes,
      mode: message.mode,
      opencv,
      options: {
        brushSize: message.brushSize,
        iterations: 5,
        openCvIterations: 5,
        returnFullImage: true,
        fallbackExact: true
      }
    });
    const output = result.image.data;
    self.postMessage({
      type: "result",
      id: message.id,
      width: result.image.width,
      height: result.image.height,
      buffer: output.buffer,
      engine: result.engine,
      fallbackReason: result.fallbackReason || result.openCvError || null,
      roi: result.roi
    }, [output.buffer]);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: message?.id,
      error: error instanceof Error ? error.message : "Smart brush correction failed"
    });
  }
};

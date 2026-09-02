export function createSmartEdgeOpenCvAdapter(cv) {
  if (!cv || typeof cv.distanceTransformWithLabels !== "function") return null;

  return {
    distanceTransformLabels({ seedMask, width, height, includeLabels = true, isCancelled }) {
      if (isCancelled?.()) throw new Error("OpenCV distance transform cancelled");
      const inverted = new Uint8Array(seedMask.length);
      for (let index = 0; index < seedMask.length; index += 1) {
        inverted[index] = seedMask[index] ? 0 : 255;
      }

      const source = cv.matFromArray(height, width, cv.CV_8UC1, inverted);
      const distanceMat = new cv.Mat();
      const labelsMat = new cv.Mat();
      try {
        if (includeLabels) {
          cv.distanceTransformWithLabels(
            source,
            distanceMat,
            labelsMat,
            cv.DIST_L2,
            cv.DIST_MASK_3,
            cv.DIST_LABEL_PIXEL
          );
        } else {
          cv.distanceTransform(source, distanceMat, cv.DIST_L2, cv.DIST_MASK_PRECISE, cv.CV_32F);
        }

        const distance = new Float32Array(distanceMat.data32F);
        if (!includeLabels) return { distance };

        const rawLabels = labelsMat.data32S;
        const labelToPixel = new Map();
        for (let pixel = 0; pixel < seedMask.length; pixel += 1) {
          if (!seedMask[pixel]) continue;
          const label = rawLabels[pixel];
          if (label > 0 && !labelToPixel.has(label)) labelToPixel.set(label, pixel);
        }
        const labels = new Int32Array(seedMask.length);
        labels.fill(-1);
        for (let pixel = 0; pixel < labels.length; pixel += 1) {
          labels[pixel] = labelToPixel.get(rawLabels[pixel]) ?? -1;
        }
        return { distance, labels };
      } finally {
        source.delete();
        distanceMat.delete();
        labelsMat.delete();
      }
    }
  };
}

export function getOpenCvCapabilities(cv) {
  return {
    version: parseOpenCvVersion(cv),
    contours: typeof cv?.findContours === "function",
    distanceLabels: typeof cv?.distanceTransformWithLabels === "function",
    grabCut: typeof cv?.grabCut === "function",
    inpaint: typeof cv?.inpaint === "function",
    intelligentScissors: typeof cv?.segmentation_IntelligentScissorsMB === "function"
  };
}

function parseOpenCvVersion(cv) {
  try {
    return cv.getBuildInformation?.().match(/OpenCV\s+([0-9.]+)/)?.[1] || "unknown";
  } catch {
    return "unknown";
  }
}

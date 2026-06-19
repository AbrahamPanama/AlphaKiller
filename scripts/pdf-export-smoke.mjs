import fs from "node:fs/promises";
import path from "node:path";
import { encodePdfImageData } from "../src/imageIO.js";
import { traceVectorContour } from "../src/vectorTrace.js";

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const outputPath = path.resolve(process.argv[2] || ".tmp/alphakiller-pdf-smoke.pdf");
const imageData = makeSmokeImageData();
const contour = traceVectorContour(imageData, {
  alphaThreshold: 16,
  simplifyTolerance: 0,
  offsetPixels: 0
});
const bytes = encodePdfImageData(imageData, {
  resolution: { xDpi: 300, yDpi: 300 },
  contour,
  contourStroke: "#ff4fd8",
  contourStrokeWidth: 1
});

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, Buffer.from(bytes));

const written = await fs.readFile(outputPath);
if (!written.subarray(0, 8).equals(Buffer.from("%PDF-1.4"))) {
  throw new Error("PDF smoke export did not write a PDF header.");
}
if (!written.includes(Buffer.from("/SMask"))) {
  throw new Error("PDF smoke export did not include an alpha soft mask.");
}

console.log(`PDF smoke export written: ${outputPath} (${written.byteLength} bytes)`);

function makeSmokeImageData() {
  const width = 32;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const alpha = Math.max(0, Math.min(255, Math.round((12 - distance) * 40)));
      data[index] = 95;
      data[index + 1] = 227;
      data[index + 2] = 142;
      data[index + 3] = alpha;
    }
  }

  return new ImageData(data, width, height);
}

globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const { applyProcessing } = await import("../src/imageProcessing.js");

const settings = {
  threshold: { enabled: false, threshold: 128, softness: 8 },
  defringe: { enabled: true, matteColor: "#ffffff", strength: 68, radius: 2 },
  bleed: { enabled: true, radius: 4, iterations: 4, affectSemiTransparent: true },
  hardening: { enabled: false, strength: 55, midpoint: 50 }
};

function makeMostlyTransparent(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const opaqueRadius = Math.min(width, height) * 0.12;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = 80;
      data[i + 1] = 180;
      data[i + 2] = 120;
      data[i + 3] = Math.hypot(x - cx, y - cy) < opaqueRadius ? 255 : 0;
    }
  }

  return new ImageData(data, width, height);
}

for (const [width, height] of [[512, 512], [1024, 1024], [2048, 2048]]) {
  const image = makeMostlyTransparent(width, height);
  const runs = [];

  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    applyProcessing(image, settings);
    runs.push(performance.now() - start);
  }

  console.log(`${width}x${height}: ${runs.map((run) => `${run.toFixed(1)}ms`).join(", ")}`);
}

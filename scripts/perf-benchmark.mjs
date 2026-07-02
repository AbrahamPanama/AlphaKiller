globalThis.ImageData = class ImageData {
  constructor(data, width, height) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
};

const { affectedPixelStats, applyProcessing } = await import("../src/imageProcessing.js");

const settings = {
  defringe: { enabled: true, matteColor: "#ffffff", strength: 120, radius: 4, tolerance: 230 },
  edgeFinish: { enabled: true, cutoff: 128, rimColorMode: "auto", edgeColor: "#111111", edgeWidth: 2 }
};

function makeSoftFringeCutout(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.24;
  const feather = Math.max(8, Math.min(width, height) * 0.025);
  const matte = { r: 255, g: 255, b: 255 };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const coverage = clamp01((radius + feather - distance) / (feather * 2));
      const art = {
        r: 70 + Math.round((x / width) * 80),
        g: 140 + Math.round((y / height) * 70),
        b: 120 + Math.round(((x + y) / (width + height)) * 90)
      };

      data[i] = mix(matte.r, art.r, coverage);
      data[i + 1] = mix(matte.g, art.g, coverage);
      data[i + 2] = mix(matte.b, art.b, coverage);
      data[i + 3] = Math.round(coverage * 255);
    }
  }

  return new ImageData(data, width, height);
}

for (const [width, height] of [[512, 512], [1024, 1024], [2048, 2048]]) {
  const image = makeSoftFringeCutout(width, height);
  const runs = [];
  let changedPct = 0;

  for (let i = 0; i < 3; i += 1) {
    const start = performance.now();
    const processed = applyProcessing(image, settings);
    runs.push(performance.now() - start);

    if (i === 0) {
      const stats = affectedPixelStats(image, processed);
      changedPct = stats.changedPct;
      if (stats.changed === 0) {
        throw new Error("Benchmark fixture did not exercise cleanup changes.");
      }
    }
  }

  console.log(`${width}x${height}: ${runs.map((run) => `${run.toFixed(1)}ms`).join(", ")}; changed ${(changedPct * 100).toFixed(2)}%`);
}

function mix(from, to, amount) {
  return Math.round(from + (to - from) * amount);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

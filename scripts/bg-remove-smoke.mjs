import { _electron as electron } from "playwright-core";
import electronPath from "electron";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARTIFACT_DIR = path.join(ROOT, ".tmp");
const TEST_IMAGE = path.join(ARTIFACT_DIR, "alphakiller-bg-smoke.png");
const FAILURE_SCREENSHOT = path.join(ARTIFACT_DIR, "alphakiller-bg-smoke-failure.png");
const APP_PORT = Number(process.env.ALPHAKILLER_SMOKE_PORT || 5174);
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const BG_REMOVE_TIMEOUT_MS = Number(process.env.BG_REMOVE_SMOKE_TIMEOUT_MS || 180_000);
const TEST_IMAGE_SIZE = Number(process.env.BG_REMOVE_SMOKE_SIZE || 320);
const BG_REMOVE_MODEL = process.env.ALPHAKILLER_BG_MODEL || "";

let viteProcess = null;

await mkdir(ARTIFACT_DIR, { recursive: true });
await writeFile(TEST_IMAGE, makeSmokePng(TEST_IMAGE_SIZE, TEST_IMAGE_SIZE));

try {
  await ensureDevServer();
  const result = await runElectronSmoke();
  console.log(`Background removal smoke passed in ${(result.elapsedMs / 1000).toFixed(1)}s`);
  console.log(`Status: ${result.statusText}`);
} finally {
  if (viteProcess) {
    viteProcess.kill();
  }
}

async function ensureDevServer() {
  if (await canReachApp()) return;

  const viteBin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");
  viteProcess = spawn(viteBin, ["--host", "127.0.0.1", "--port", String(APP_PORT), "--strictPort"], {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  viteProcess.stdout.on("data", (chunk) => process.stdout.write(`[vite] ${chunk}`));
  viteProcess.stderr.on("data", (chunk) => process.stderr.write(`[vite] ${chunk}`));

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (await canReachApp()) return;
    await delay(250);
  }

  throw new Error(`Vite dev server did not become reachable on ${APP_URL}`);
}

async function canReachApp() {
  try {
    const response = await fetch(APP_URL);
    return response.ok;
  } catch {
    return false;
  }
}

async function runElectronSmoke() {
  const consoleIssues = [];
  const startedAt = performance.now();
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: [ROOT],
    cwd: ROOT,
    env: {
      ...process.env,
      ALPHAKILLER_DEV_URL: APP_URL
    }
  });

  try {
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(BG_REMOVE_TIMEOUT_MS);

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleIssues.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      consoleIssues.push(`pageerror: ${error.message}`);
    });

    await page.waitForLoadState("domcontentloaded");
    await applyModelPreference(page);
    await settleViteDevReload(page);
    await uploadTestImage(page);

    await page.getByRole("button", { name: "Remove Background" }).click();
    try {
      await page.waitForFunction(() => {
        const toast = document.querySelector(".toast")?.textContent || "";
        return document.querySelector(".restore-button") ||
          toast.includes("No clear subject detected") ||
          toast.includes("Background removal failed");
      }, null, { timeout: BG_REMOVE_TIMEOUT_MS });
    } catch (error) {
      const state = await collectPageState(page);
      await page.screenshot({ path: FAILURE_SCREENSHOT, fullPage: true });
      throw new Error([
        error.message,
        `State: ${JSON.stringify(state, null, 2)}`,
        `Console: ${consoleIssues.join("\n") || "none"}`,
        `Screenshot: ${FAILURE_SCREENSHOT}`
      ].join("\n"));
    }

    const state = await collectPageState(page);

    if (!state.hasRestore) {
      throw new Error(`Background removal did not produce a restorable result. Toast: ${state.toastText || "none"}`);
    }

    await page.locator(".restore-button").click();
    await page.waitForFunction(() => !document.querySelector(".restore-button"));

    if (consoleIssues.length) {
      throw new Error(`Console issues during smoke test:\n${consoleIssues.join("\n")}`);
    }

    return {
      elapsedMs: performance.now() - startedAt,
      statusText: state.statusText
    };
  } finally {
    await electronApp.close();
  }
}

async function uploadTestImage(page) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.locator('input[type="file"]').setInputFiles(TEST_IMAGE);
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="Remove Background"]');
        return button && !button.disabled && document.querySelector(".source-card");
      }, null, { timeout: 15_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForLoadState("domcontentloaded").catch(() => {});
    }
  }
  throw lastError;
}

async function applyModelPreference(page) {
  if (!BG_REMOVE_MODEL) return;
  await page.evaluate((model) => {
    window.localStorage.setItem("alphakiller:bg-remove-model", model);
  }, BG_REMOVE_MODEL);
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function settleViteDevReload(page) {
  const settleMs = Number(process.env.ALPHAKILLER_SMOKE_SETTLE_MS || 2000);
  await delay(settleMs);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
}

async function collectPageState(page) {
  return page.evaluate(() => ({
    hasRestore: Boolean(document.querySelector(".restore-button")),
    removeButtonDisabled: Boolean(document.querySelector('button[aria-label="Remove Background"]')?.disabled),
    progressText: document.querySelector(".bg-remove-progress")?.textContent?.replace(/\s+/g, " ").trim() || "",
    statusText: document.querySelector(".statusbar")?.textContent?.replace(/\s+/g, " ").trim() || "",
    toastText: document.querySelector(".toast")?.textContent?.replace(/\s+/g, " ").trim() || "",
    sourceTitle: document.querySelector(".source-card strong")?.textContent || "",
    bodyClass: document.body.className
  }));
}

function makeSmokePng(width, height) {
  const rgba = new Uint8Array(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const paper = 224 + Math.round(16 * Math.sin((x + y) / 28));
      rgba[i] = paper - 26;
      rgba[i + 1] = paper + 4;
      rgba[i + 2] = paper + 12;
      rgba[i + 3] = 255;

      const body = ellipse(x, y, cx, cy + 62, 70, 96);
      const head = ellipse(x, y, cx, cy - 44, 50, 54);
      const hair = ellipse(x, y, cx - 3, cy - 65, 54, 30);
      const shoulder = ellipse(x, y, cx, cy + 76, 104, 34);

      if (shoulder) {
        rgba[i] = 31;
        rgba[i + 1] = 93;
        rgba[i + 2] = 144;
      }

      if (body) {
        rgba[i] = 37;
        rgba[i + 1] = 129;
        rgba[i + 2] = 170;
      }

      if (head) {
        rgba[i] = 224;
        rgba[i + 1] = 153;
        rgba[i + 2] = 107;
      }

      if (hair && y < cy - 36) {
        rgba[i] = 68;
        rgba[i + 1] = 42;
        rgba[i + 2] = 34;
      }

      if (ellipse(x, y, cx - 18, cy - 43, 5, 4) || ellipse(x, y, cx + 18, cy - 43, 5, 4)) {
        rgba[i] = 38;
        rgba[i + 1] = 33;
        rgba[i + 2] = 32;
      }

      if (ellipse(x, y, cx, cy - 23, 17, 6)) {
        rgba[i] = 148;
        rgba[i + 1] = 68;
        rgba[i + 2] = 62;
      }
    }
  }

  return encodePng(width, height, rgba);
}

function ellipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    scanlines[rowStart] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(scanlines, rowStart + 1);
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", Buffer.concat([
      uint32(width),
      uint32(height),
      Buffer.from([8, 6, 0, 0, 0])
    ])),
    pngChunk("IDAT", zlib.deflateSync(scanlines)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data])))
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

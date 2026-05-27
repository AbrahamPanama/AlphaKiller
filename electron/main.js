import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { removeBackground } from "./backgroundRemoval/index.js";
import { superScaleImage } from "./imageEnhancement/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const devServerUrl = process.env.ALPHAKILLER_DEV_URL || "http://127.0.0.1:5173";
const windowsIconPath = path.join(__dirname, "../build/icon.ico");

let mainWindow;
const pendingExportTargets = new Map();

app.commandLine.appendSwitch("enable-features", "Vulkan,WebGPU");
app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "win32") {
  app.setAppUserModelId("com.alphakiller.app");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: "AlphaKiller 0.1 beta 1",
    icon: process.platform === "win32" ? windowsIconPath : undefined,
    backgroundColor: "#0d0e10",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 14, y: 13 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  if (isDev) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || "";
  const isTrusted = isDev
    ? senderUrl.startsWith(devServerUrl)
    : senderUrl.startsWith("file://");

  if (!isTrusted) {
    throw new Error("Rejected IPC call from an untrusted frame");
  }
}

ipcMain.handle("app:get-theme", (event) => {
  assertTrustedSender(event);
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
});

ipcMain.handle("app:get-huggingface-token", (event) => {
  assertTrustedSender(event);
  return process.env.ALPHAKILLER_HF_TOKEN ||
    process.env.HF_TOKEN ||
    process.env.HF_ACCESS_TOKEN ||
    "";
});

ipcMain.handle("app:choose-export-target", async (event, payload) => {
  assertTrustedSender(event);
  const defaultFormat = normalizeExportFormat(payload?.defaultFormat);
  const fallbackName = `image-cleaned.${defaultFormat === "tiff" ? "tiff" : "png"}`;
  const defaultPath = typeof payload?.defaultPath === "string" && payload.defaultPath.trim()
    ? payload.defaultPath.trim()
    : fallbackName;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export cleaned image",
    defaultPath,
    filters: [
      { name: "PNG Image", extensions: ["png"] },
      { name: "TIFF Image", extensions: ["tif", "tiff"] }
    ]
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  const { filePath, format } = normalizeExportPath(result.filePath, defaultFormat);
  const exportId = randomUUID();
  pendingExportTargets.set(exportId, { filePath, format });
  return { canceled: false, exportId, filePath, format };
});

ipcMain.handle("app:write-export", async (event, payload) => {
  assertTrustedSender(event);
  const exportId = typeof payload?.exportId === "string" ? payload.exportId : "";
  const target = pendingExportTargets.get(exportId);
  if (!target) {
    throw new Error("Export target is no longer available.");
  }

  pendingExportTargets.delete(exportId);
  if (!isBytePayload(payload.bytes)) {
    throw new Error("Invalid image export payload.");
  }

  await fs.writeFile(target.filePath, bufferFromBytePayload(payload.bytes));
  return { canceled: false, filePath: target.filePath, format: target.format };
});

ipcMain.handle("background-removal:run", async (event, payload) => {
  assertTrustedSender(event);

  const { provider, pngBytes, preserveAlpha, apiToken } = payload || {};
  if (!(pngBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(pngBytes)) {
    throw new Error("background-removal:run expected pngBytes ArrayBuffer.");
  }

  return removeBackground({
    provider,
    pngBytes,
    preserveAlpha: preserveAlpha !== false,
    apiToken: typeof apiToken === "string" ? apiToken.trim() : ""
  });
});

ipcMain.handle("super-scale:run", async (event, payload) => {
  assertTrustedSender(event);

  const { provider, pngBytes, scale, preserveAlpha, apiToken } = payload || {};
  if (!(pngBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(pngBytes)) {
    throw new Error("super-scale:run expected pngBytes ArrayBuffer.");
  }

  return superScaleImage({
    provider,
    pngBytes,
    scale,
    preserveAlpha: preserveAlpha !== false,
    apiToken: typeof apiToken === "string" ? apiToken.trim() : ""
  });
});

function normalizeExportFormat(format) {
  return format === "tiff" ? "tiff" : "png";
}

function normalizeExportPath(filePath, defaultFormat) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".tif" || extension === ".tiff") {
    return { filePath, format: "tiff" };
  }
  if (extension === ".png") {
    return { filePath, format: "png" };
  }

  const format = normalizeExportFormat(defaultFormat);
  return {
    filePath: `${filePath}.${format === "tiff" ? "tiff" : "png"}`,
    format
  };
}

function isBytePayload(bytes) {
  return bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes) || Array.isArray(bytes);
}

function bufferFromBytePayload(bytes) {
  if (bytes instanceof ArrayBuffer) {
    return Buffer.from(bytes);
  }
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (Array.isArray(bytes)) {
    return Buffer.from(bytes);
  }
  throw new Error("Expected image bytes.");
}

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme } from "electron";
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
const LOCKED_WEB_ZOOM_FACTOR = 1;
const BROWSER_ZOOM_KEYS = new Set(["+", "=", "-", "_", "0"]);

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
    title: "AlphaKiller 0.1 beta 2",
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

  lockWindowZoom(mainWindow);

  if (isDev) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

function lockWindowZoom(window) {
  const { webContents } = window;

  const resetZoom = () => {
    webContents.setZoomFactor(LOCKED_WEB_ZOOM_FACTOR);
  };
  const lockVisualZoom = () => {
    webContents.setVisualZoomLevelLimits(1, 1).catch(() => {
      // Older Electron builds may reject while the renderer is initializing.
    });
  };

  webContents.on("did-finish-load", () => {
    lockVisualZoom();
    resetZoom();
  });
  webContents.on("zoom-changed", (event) => {
    event.preventDefault();
    resetZoom();
  });
  webContents.on("before-input-event", (event, input) => {
    const key = normalizeShortcutKey(input);
    const isBrowserZoomShortcut = input.type === "keyDown" &&
      (input.control || input.meta) &&
      BROWSER_ZOOM_KEYS.has(key);

    if (isBrowserZoomShortcut) {
      event.preventDefault();
      resetZoom();
    }
  });

  lockVisualZoom();
  resetZoom();
}

app.whenReady().then(() => {
  installApplicationMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function installApplicationMenu() {
  const template = [
    ...(process.platform === "darwin"
      ? [{
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" }
        ]
      }]
      : []),
    {
      label: "File",
      submenu: [
        process.platform === "darwin" ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

function normalizeShortcutKey(input) {
  const key = String(input.key || "").toLowerCase();
  if (key === "plus") return "+";
  if (key === "minus") return "-";
  if (key === "equal") return "=";
  if (key === "digit0" || key === "numpad0") return "0";
  return key;
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
  const fallbackName = `image-cleaned.${extensionForExportFormat(defaultFormat)}`;
  const defaultPath = typeof payload?.defaultPath === "string" && payload.defaultPath.trim()
    ? payload.defaultPath.trim()
    : fallbackName;

  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export cleaned image",
    defaultPath,
    filters: [filterForExportFormat(defaultFormat)]
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
  return format === "tiff" || format === "jpeg" || format === "pdf" || format === "svg" ? format : "png";
}

function normalizeExportPath(filePath, defaultFormat) {
  const format = normalizeExportFormat(defaultFormat);
  const extension = extensionForExportFormat(format);
  const parsed = path.parse(filePath);
  if (parsed.ext.toLowerCase() === `.${extension}`) {
    return { filePath, format };
  }

  return {
    filePath: path.join(parsed.dir, `${parsed.name}.${extension}`),
    format
  };
}

function filterForExportFormat(format) {
  if (format === "jpeg") return { name: "JPEG Image", extensions: ["jpg", "jpeg"] };
  if (format === "tiff") return { name: "TIFF Image", extensions: ["tif", "tiff"] };
  if (format === "pdf") return { name: "PDF File", extensions: ["pdf"] };
  if (format === "svg") return { name: "SVG Vector Contour", extensions: ["svg"] };
  return { name: "PNG Image", extensions: ["png"] };
}

function extensionForExportFormat(format) {
  if (format === "tiff") return "tiff";
  if (format === "jpeg") return "jpg";
  if (format === "pdf") return "pdf";
  if (format === "svg") return "svg";
  return "png";
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

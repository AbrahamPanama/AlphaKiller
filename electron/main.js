import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
const devServerUrl = process.env.ALPHAKILLER_DEV_URL || "http://127.0.0.1:5173";

let mainWindow;

app.commandLine.appendSwitch("enable-features", "Vulkan,WebGPU");
app.commandLine.appendSwitch("enable-unsafe-webgpu");

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    title: "AlphaKiller",
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

ipcMain.handle("image:save-png", async (event, payload) => {
  assertTrustedSender(event);
  if (!payload || !Array.isArray(payload.bytes)) {
    throw new Error("Invalid PNG export payload");
  }

  const { bytes, defaultPath } = payload;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export cleaned PNG",
    defaultPath: typeof defaultPath === "string" ? defaultPath : "image-cleaned.png",
    filters: [{ name: "PNG Image", extensions: ["png"] }]
  });

  if (result.canceled || !result.filePath) {
    return { canceled: true };
  }

  await fs.writeFile(result.filePath, Buffer.from(bytes));
  return { canceled: false, filePath: result.filePath };
});

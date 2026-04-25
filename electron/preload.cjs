const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alphaKiller", {
  getTheme: () => ipcRenderer.invoke("app:get-theme"),
  getHuggingFaceToken: () => ipcRenderer.invoke("app:get-huggingface-token"),
  savePng: (payload) => ipcRenderer.invoke("image:save-png", payload)
});

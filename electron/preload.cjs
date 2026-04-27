const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alphaKiller", {
  getTheme: () => ipcRenderer.invoke("app:get-theme"),
  getHuggingFaceToken: () => ipcRenderer.invoke("app:get-huggingface-token"),
  removeBackground: (payload) => ipcRenderer.invoke("background-removal:run", payload),
  chooseExportTarget: (payload) => ipcRenderer.invoke("image:choose-export-target", payload),
  writeExport: (payload) => ipcRenderer.invoke("image:write-export", payload),
  savePng: (payload) => ipcRenderer.invoke("image:save-png", payload)
});

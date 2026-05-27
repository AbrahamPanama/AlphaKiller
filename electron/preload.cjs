const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("alphaKiller", {
  getTheme: () => ipcRenderer.invoke("app:get-theme"),
  getHuggingFaceToken: () => ipcRenderer.invoke("app:get-huggingface-token"),
  removeBackground: (payload) => ipcRenderer.invoke("background-removal:run", payload),
  superScale: (payload) => ipcRenderer.invoke("super-scale:run", payload),
  chooseExportTarget: (payload) => ipcRenderer.invoke("app:choose-export-target", payload),
  writeExport: (payload) => ipcRenderer.invoke("app:write-export", payload)
});

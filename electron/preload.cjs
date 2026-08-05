const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("branchline", {
  selectProject: () => ipcRenderer.invoke("project:select"),
  getSnapshot: (path) => ipcRenderer.invoke("repo:snapshot", path),
  planAction: (path, request) => ipcRenderer.invoke("action:plan", path, request),
  prepareOperation: (path, operation, args) => ipcRenderer.invoke("action:prepare", path, operation, args),
  executePlan: (path, planId) => ipcRenderer.invoke("action:execute", path, planId),
  getLlmConfig: () => ipcRenderer.invoke("llm:get-config"),
  saveLlmConfig: (config) => ipcRenderer.invoke("llm:save-config", config)
});

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gitcat", {
  platform: process.platform,
  selectProject: () => ipcRenderer.invoke("project:select"),
  restoreWorkspace: () => ipcRenderer.invoke("workspace:restore"),
  saveWorkspace: (paths, activePath) => ipcRenderer.invoke("workspace:save", paths, activePath),
  getSnapshot: (path) => ipcRenderer.invoke("repo:snapshot", path),
  fetchRemotes: (path) => ipcRenderer.invoke("repo:fetch", path),
  loadHistory: (path, request) => ipcRenderer.invoke("history:load", path, request),
  getCommitDetail: (path, hash) => ipcRenderer.invoke("commit:detail", path, hash),
  getCommitFileDiff: (path, hash, file) => ipcRenderer.invoke("commit:file-detail", path, hash, file),
  proposeConflictResolution: (path, locale) => ipcRenderer.invoke("conflicts:propose", path, locale),
  applyConflictResolution: (path, proposalId, accepted, locale) => ipcRenderer.invoke("conflicts:apply", path, proposalId, accepted, locale),
  planRecovery: (path, failure, context, locale) => ipcRenderer.invoke("action:recover", path, failure, context, locale),
  getWorkingFileDiff: (path, file) => ipcRenderer.invoke("commit:file-diff", path, file),
  planAction: (path, request, context, locale) => ipcRenderer.invoke("action:plan", path, request, context, locale),
  prepareOperation: (path, operation, args, locale) => ipcRenderer.invoke("action:prepare", path, operation, args, locale),
  prepareBranchDelivery: (path, request, locale) => ipcRenderer.invoke("action:prepare-delivery", path, request, locale),
  prepareMergeToDefault: (path, branch, locale) => ipcRenderer.invoke("action:prepare-merge-to-default", path, branch, locale),
  generateCommitDescription: (path, locale) => ipcRenderer.invoke("commit:generate-description", path, locale),
  executePlan: (path, planId, locale) => ipcRenderer.invoke("action:execute", path, planId, locale),
  getLlmConfig: () => ipcRenderer.invoke("llm:get-config"),
  saveLlmConfig: (config) => ipcRenderer.invoke("llm:save-config", config)
});

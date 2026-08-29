import { contextBridge, ipcRenderer } from "electron";
import type { HammerCodeApi, RendererEvent } from "../shared/contracts";

const api: HammerCodeApi = {
  bootstrap: () => ipcRenderer.invoke("hammercode:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("hammercode:choose-workspace"),
  selectWorkspace: (workspaceRoot) =>
    ipcRenderer.invoke("hammercode:select-workspace", workspaceRoot),
  newChat: () => ipcRenderer.invoke("hammercode:new-chat"),
  selectSession: (sessionId) => ipcRenderer.invoke("hammercode:select-session", sessionId),
  updateSessionSettings: (settings) =>
    ipcRenderer.invoke("hammercode:update-session-settings", settings),
  testModelConnection: (input) =>
    ipcRenderer.invoke("hammercode:test-model-connection", input),
  saveModelConnection: (input) =>
    ipcRenderer.invoke("hammercode:save-model-connection", input),
  renameModelConnection: (connectionId, name) =>
    ipcRenderer.invoke("hammercode:rename-model-connection", connectionId, name),
  deleteModelConnection: (connectionId) =>
    ipcRenderer.invoke("hammercode:delete-model-connection", connectionId),
  compressContext: () => ipcRenderer.invoke("hammercode:compress-context"),
  openSideChat: () => ipcRenderer.invoke("hammercode:open-side-chat"),
  sendSideChat: (sideChatId, content) =>
    ipcRenderer.invoke("hammercode:send-side-chat", sideChatId, content),
  cancelSideChat: (sideChatId) =>
    ipcRenderer.invoke("hammercode:cancel-side-chat", sideChatId),
  closeSideChat: (sideChatId) =>
    ipcRenderer.invoke("hammercode:close-side-chat", sideChatId),
  searchWorkspaceEntries: (query) =>
    ipcRenderer.invoke("hammercode:search-workspace-entries", query),
  listProjectMemory: () => ipcRenderer.invoke("hammercode:list-project-memory"),
  updateProjectMemorySettings: (settings) =>
    ipcRenderer.invoke("hammercode:update-project-memory-settings", settings),
  exportProjectMemory: () => ipcRenderer.invoke("hammercode:export-project-memory"),
  importProjectMemory: () => ipcRenderer.invoke("hammercode:import-project-memory"),
  deleteProjectMemory: (memoryId) => ipcRenderer.invoke("hammercode:delete-project-memory", memoryId),
  startTask: (request) => ipcRenderer.invoke("hammercode:start-task", request),
  requestUndo: (changeId) => ipcRenderer.invoke("hammercode:request-undo", changeId),
  cancelTask: () => ipcRenderer.invoke("hammercode:cancel-task"),
  resolveApproval: (approvalId, approved) =>
    ipcRenderer.invoke("hammercode:resolve-approval", approvalId, approved),
  clearSession: () => ipcRenderer.invoke("hammercode:clear-session"),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: RendererEvent) => listener(payload);
    ipcRenderer.on("hammercode:event", handler);
    return () => ipcRenderer.removeListener("hammercode:event", handler);
  },
};

contextBridge.exposeInMainWorld("hammerCode", api);

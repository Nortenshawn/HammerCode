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
  testApiConnection: (input) =>
    ipcRenderer.invoke("hammercode:test-api-connection", input),
  saveApiConnection: (input) =>
    ipcRenderer.invoke("hammercode:save-api-connection", input),
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

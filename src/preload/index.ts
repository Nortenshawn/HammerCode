import { contextBridge, ipcRenderer } from "electron";
import type { HammerCodeApi, RendererEvent } from "../shared/contracts";

const api: HammerCodeApi = {
  bootstrap: () => ipcRenderer.invoke("hammercode:bootstrap"),
  chooseWorkspace: () => ipcRenderer.invoke("hammercode:choose-workspace"),
  startTask: (task) => ipcRenderer.invoke("hammercode:start-task", task),
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

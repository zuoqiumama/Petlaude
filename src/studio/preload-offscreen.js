"use strict";

// Preload for the hidden offscreen image-processing window. Bridges IPC jobs
// from main to the page and results back. Trusted internal window (processes
// only our own generated image bytes).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("offscreenAPI", {
  onJob: (cb) => ipcRenderer.on("studio-offscreen-job", (_e, job) => cb(job)),
  result: (id, data) => ipcRenderer.send("studio-offscreen-result", { id, data }),
  error: (id, message) => ipcRenderer.send("studio-offscreen-result", { id, error: String(message || "error") }),
});

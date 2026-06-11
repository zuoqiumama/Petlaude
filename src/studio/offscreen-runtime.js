"use strict";

// ── Offscreen runtime (main) ─────────────────────────────────────────────────
// Lazily owns the hidden image-processing BrowserWindow and exposes a small
// promise API to run jobs in it. Keeping this out of main.js keeps the studio
// self-contained.

const path = require("path");

function createOffscreenRuntime(deps = {}) {
  const { BrowserWindow, ipcMain } = deps.electron || require("electron");
  const pending = new Map();
  let win = null;
  let ready = null;
  let seq = 0;

  function onResult(_event, msg) {
    const { id, data, error } = msg || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(data);
  }

  ipcMain.on("studio-offscreen-result", onResult);

  function ensureWindow() {
    if (win && !win.isDestroyed()) return ready;
    win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: {
        preload: path.join(__dirname, "preload-offscreen.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.on("closed", () => { win = null; ready = null; });
    ready = win.loadFile(path.join(__dirname, "offscreen-processor.html"));
    return ready;
  }

  async function run(channel, payload, timeoutMs = 60000) {
    await ensureWindow();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`offscreen ${channel} timed out`));
        }
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      win.webContents.send("studio-offscreen-job", { id, channel, payload });
    });
  }

  return {
    processStrip: (payload) => run("processStrip", payload),
    makeGuide: (payload) => run("makeGuide", payload),
    prepareReference: (payload) => run("prepareReference", payload),
    chooseChroma: (payload) => run("chooseChroma", payload),
    dispose() {
      ipcMain.removeListener("studio-offscreen-result", onResult);
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      ready = null;
      pending.clear();
    },
  };
}

module.exports = { createOffscreenRuntime };

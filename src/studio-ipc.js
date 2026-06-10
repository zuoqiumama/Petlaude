"use strict";

// ── Studio IPC (main) ────────────────────────────────────────────────────────
// Bridges the Settings window's Studio tab to the studio pipeline:
// config store (encrypted key), reference picking, and generation with
// progress streaming. The API key never leaves the main process — get-config
// only reports whether a key exists.

const fs = require("fs");
const path = require("path");
const https = require("https");

const { ACTIONS } = require("./companion/action-manifest");
const { createStudioRuntime } = require("./studio/studio-runtime");
const { ensurePetTheme } = require("./studio/pet-theme");

const REFERENCE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerStudioIpc requires ${name}`);
  return value;
}

function defaultHttpGet(url, headers, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      res.resume(); // body unused — status only
      resolve({ status: res.statusCode });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("request timed out"));
    });
  });
}

function registerStudioIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const dialog = requiredDependency(options.dialog, "dialog");
  const studioConfig = requiredDependency(options.studioConfig, "studioConfig");
  const getProcessor = requiredDependency(options.getProcessor, "getProcessor");
  const userThemesDir = requiredDependency(options.userThemesDir, "userThemesDir");
  const templateDir = requiredDependency(options.templateDir, "templateDir");
  const getSettingsWindow = options.getSettingsWindow || (() => null);
  const onThemesChanged = options.onThemesChanged || (() => {});
  const httpGet = options.httpGet || defaultHttpGet;
  const runtimeDeps = options.runtimeDeps || {};

  let generating = false;
  const disposers = [];

  function handle(channel, fn) {
    ipcMain.handle(channel, fn);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function sendProgress(evt) {
    const win = getSettingsWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send("studio:progress", evt);
    }
  }

  handle("studio:get-actions", () => ACTIONS.map((a) => ({
    id: a.id,
    category: a.category,
    frames: a.frames,
    durationMs: a.anim.totalMs,
  })));

  handle("studio:get-config", () => {
    const { baseUrl, model, apiKey } = studioConfig.loadConfig();
    return { baseUrl, model, hasKey: !!apiKey };
  });

  handle("studio:save-config", (_event, cfg) => {
    try {
      const input = cfg && typeof cfg === "object" ? cfg : {};
      const res = studioConfig.saveConfig({
        baseUrl: String(input.baseUrl || ""),
        model: String(input.model || ""),
        apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
      });
      return { status: "ok", keyPersisted: res.keyPersisted };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "save failed" };
    }
  });

  handle("studio:test-config", async () => {
    const { baseUrl, apiKey } = studioConfig.loadConfig();
    if (!baseUrl) return { status: "error", message: "baseUrl not configured" };
    if (!apiKey) return { status: "error", message: "API key not configured" };
    try {
      const res = await httpGet(
        `${baseUrl.replace(/\/+$/, "")}/v1/models`,
        { Authorization: `Bearer ${apiKey}` },
      );
      if (res.status && res.status >= 200 && res.status < 300) return { status: "ok" };
      if (res.status === 401 || res.status === 403) return { status: "error", message: `auth rejected (HTTP ${res.status})` };
      // Some providers don't expose /v1/models — a non-auth error still proves
      // the endpoint is reachable, so report it as reachable-with-note.
      return { status: "ok", note: `endpoint reachable (HTTP ${res.status})` };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "request failed" };
    }
  });

  handle("studio:pick-reference", async () => {
    const win = getSettingsWindow();
    const result = await dialog.showOpenDialog(win || undefined, {
      title: "Choose a reference image",
      properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (!result || result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { status: "cancelled" };
    }
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).toLowerCase();
    if (!REFERENCE_EXTS.has(ext)) {
      return { status: "error", message: "unsupported image type" };
    }
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return { status: "error", message: "file not readable" };
    }
    if (stat.size > MAX_REFERENCE_BYTES) {
      return { status: "error", message: "image larger than 10MB" };
    }
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : `image/${ext.slice(1)}`;
    const dataUrl = `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
    return { status: "ok", path: filePath, dataUrl };
  });

  handle("studio:generate", async (_event, payload) => {
    const input = payload && typeof payload === "object" ? payload : {};
    if (generating) return { status: "error", message: "generation already running" };

    const config = studioConfig.loadConfig();
    if (!config.baseUrl || !config.apiKey || !config.model) {
      return { status: "error", message: "API config incomplete" };
    }
    const referencePath = String(input.referencePath || "");
    if (!referencePath || !fs.existsSync(referencePath)) {
      return { status: "error", message: "reference image missing" };
    }
    const petName = String(input.petName || "").trim() || path.basename(referencePath, path.extname(referencePath));

    generating = true;
    try {
      const { themeDir, themeId } = ensurePetTheme({
        name: petName,
        referencePath,
        userThemesDir,
        templateDir,
      });
      const runtime = createStudioRuntime({
        themeDir,
        referencePath,
        config,
        deps: { processor: getProcessor(), ...runtimeDeps },
        onProgress: sendProgress,
      });

      if (input.mode === "all") {
        const summary = await runtime.generateAll();
        onThemesChanged({ themeId });
        return { status: "ok", themeId, summary };
      }
      const actionId = String(input.actionId || "");
      const result = await runtime.generateAction(actionId);
      onThemesChanged({ themeId });
      return { status: "ok", themeId, result };
    } catch (err) {
      return { status: "error", message: (err && err.message) || "generation failed" };
    } finally {
      generating = false;
    }
  });

  return {
    dispose() {
      for (const d of disposers.splice(0)) {
        try { d(); } catch { /* already removed */ }
      }
    },
  };
}

module.exports = { registerStudioIpc };

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
const { normalizeBaseUrl } = require("./studio/imagegen-client");

const REFERENCE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

// Theme asset types we can turn into a generation reference. APNG carries the
// PNG magic, so image/png is the correct data-URL mime for it.
const THEME_ASSET_MIME = Object.freeze({
  ".png": "image/png",
  ".apng": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
});

function decodePngDataUrl(dataUrl) {
  const match = /^data:image\/png;base64,([a-z0-9+/=\r\n]+)$/i.exec(String(dataUrl || ""));
  if (!match) return null;
  const bytes = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  return bytes.length > 0 ? bytes : null;
}

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
  // Optional active-theme hooks for "use the current pet as reference".
  const getActiveTheme = typeof options.getActiveTheme === "function" ? options.getActiveTheme : null;
  const resolveThemeAsset = typeof options.resolveThemeAsset === "function" ? options.resolveThemeAsset : null;
  const studioRefsDir = options.studioRefsDir || path.join(path.dirname(userThemesDir), "studio-refs");

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
      // Use the same baseUrl normalization as generateImage so a "test
      // passed" result actually predicts the generation URL (no /v1 doubling).
      const res = await httpGet(
        `${normalizeBaseUrl(baseUrl)}/v1/models`,
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

  // Snapshot the active pet's look into a PNG reference so the Studio can
  // derive a complete AI pet (core states + companion actions) in the same
  // visual identity — including from the built-in pets.
  async function captureCurrentPetReference() {
    const theme = getActiveTheme ? getActiveTheme() : null;
    if (!theme || !theme.states) {
      return { status: "error", message: "no active pet theme" };
    }

    // Studio-generated themes keep their original raster reference on disk;
    // prefer it over the idle SVG, whose stacked animation frames rasterize
    // blank at time zero.
    let sourcePath = null;
    if (theme._themeDir) {
      for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
        const candidate = path.join(theme._themeDir, "assets", `reference${ext}`);
        if (fs.existsSync(candidate)) {
          sourcePath = candidate;
          break;
        }
      }
    }
    if (!sourcePath) {
      const idleFiles = Array.isArray(theme.states.idle) ? theme.states.idle : [];
      const filename = idleFiles[0];
      if (!filename) return { status: "error", message: "active theme has no idle visual" };
      const resolved = resolveThemeAsset ? resolveThemeAsset(theme, filename) : null;
      if (!resolved || !fs.existsSync(resolved)) {
        return { status: "error", message: "active theme asset not found" };
      }
      sourcePath = resolved;
    }

    const ext = path.extname(sourcePath).toLowerCase();
    const mime = THEME_ASSET_MIME[ext];
    if (!mime) {
      return { status: "error", message: `unsupported theme asset type: ${ext || "unknown"}` };
    }
    const sourceDataUrl = `data:${mime};base64,${fs.readFileSync(sourcePath).toString("base64")}`;

    // Rasterize + downscale in the offscreen window (SVG/GIF/APNG → PNG).
    const prepared = await getProcessor().prepareReference({ dataUrl: sourceDataUrl, maxSize: 768 });
    const png = decodePngDataUrl(prepared && prepared.dataUrl);
    if (!png) return { status: "error", message: "could not rasterize the current pet" };

    fs.mkdirSync(studioRefsDir, { recursive: true });
    const safeId = String(theme._id || "pet").replace(/[^a-z0-9_-]/gi, "_");
    const outPath = path.join(studioRefsDir, `${safeId}.png`);
    fs.writeFileSync(outPath, png);

    const baseName = typeof theme.name === "string" && theme.name.trim() ? theme.name.trim() : "Pet";
    return {
      status: "ok",
      path: outPath,
      dataUrl: prepared.dataUrl,
      suggestedName: /\bai\b/i.test(baseName) ? baseName : `${baseName} AI`,
    };
  }

  handle("studio:use-current-pet", async () => {
    if (!getActiveTheme) return { status: "error", message: "active theme unavailable" };
    try {
      return await captureCurrentPetReference();
    } catch (err) {
      return { status: "error", message: (err && err.message) || "capture failed" };
    }
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

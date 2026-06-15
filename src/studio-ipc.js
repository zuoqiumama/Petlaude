"use strict";

// ── Studio IPC (main) ────────────────────────────────────────────────────────
// Bridges the Settings window's Studio tab to the studio pipeline:
// config store (encrypted key), reference picking, and generation with
// progress streaming. The API key never leaves the main process — get-config
// only reports whether a key exists.

const fs = require("fs");
const path = require("path");
const https = require("https");
const { pathToFileURL } = require("url");

const { ACTIONS } = require("./companion/action-manifest");
const { createStudioRuntime } = require("./studio/studio-runtime");
const { ensurePetTheme } = require("./studio/pet-theme");
const { normalizeBaseUrl } = require("./studio/imagegen-client");
const { buildSequence, boundaries } = require("./studio/svg-assemble");
const { getThemeReferenceFingerprint, hasCompleteActionAssets } = require("./studio/generation-contract");

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

function buildPreviewFileUrl(assetPath) {
  const stat = fs.statSync(assetPath);
  if (!stat.isFile()) return null;
  const url = pathToFileURL(assetPath);
  url.searchParams.set("_studioPreview", String(Math.floor(stat.mtimeMs)));
  return url.href;
}

function buildActionPreview(themeDir, actionId, referenceSha256 = null) {
  const action = ACTIONS.find((entry) => entry.id === actionId);
  if (!action || !hasCompleteActionAssets(themeDir, action, referenceSha256)) return null;
  try {
    const previewFrameUrls = Array.from({ length: action.frames }, (_, index) => (
      buildPreviewFileUrl(path.join(themeDir, "assets", `${actionId}-frame-${index + 1}.png`))
    ));
    if (previewFrameUrls.some((url) => !url)) return null;
    return { previewUrl: previewFrameUrls[0], previewFrameUrls };
  } catch {
    return null;
  }
}

function findStudioThemeDirByName(userThemesDir, petName) {
  const wanted = String(petName || "").trim();
  let matches = [];
  try {
    matches = fs.readdirSync(userThemesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(userThemesDir, entry.name))
      .filter((themeDir) => {
        try {
          const theme = JSON.parse(fs.readFileSync(path.join(themeDir, "theme.json"), "utf8"));
          return theme.author === "Clawd AI Studio" && (!wanted || theme.name === wanted);
        } catch {
          return false;
        }
      });
  } catch {
    return null;
  }
  matches.sort((a, b) => {
    try { return fs.statSync(path.join(b, "theme.json")).mtimeMs - fs.statSync(path.join(a, "theme.json")).mtimeMs; }
    catch { return 0; }
  });
  return matches[0] || null;
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
    previewSequence: buildSequence(a.frames, a.anim.loop || "once"),
    previewKeyTimes: boundaries(
      buildSequence(a.frames, a.anim.loop || "once"),
      a.anim.hold || {},
    ).map((value) => value / 100),
  })));

  handle("studio:get-action-statuses", (_event, payload) => {
    const themeDir = findStudioThemeDirByName(userThemesDir, payload && payload.petName);
    if (!themeDir) return [];
    const referenceSha256 = getThemeReferenceFingerprint(themeDir);
    let petName = "";
    try { petName = JSON.parse(fs.readFileSync(path.join(themeDir, "theme.json"), "utf8")).name || ""; }
    catch { /* status list can still be returned */ }
    return ACTIONS.flatMap((action) => {
      const preview = buildActionPreview(themeDir, action.id, referenceSha256);
      return preview ? [{ actionId: action.id, stage: "written", ...preview, petName }] : [];
    });
  });

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

  handle("studio:test-config", async (_event, cfg) => {
    const saved = studioConfig.loadConfig();
    const input = cfg && typeof cfg === "object" ? cfg : {};
    const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : saved.baseUrl;
    const draftKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const apiKey = draftKey || saved.apiKey;
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
      return { status: "error", message: `connection test failed (HTTP ${res.status || "unknown"})` };
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
    return {
      status: "ok",
      path: filePath,
      dataUrl,
      suggestedName: path.basename(filePath, path.extname(filePath)),
    };
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
      const referenceSha256 = getThemeReferenceFingerprint(themeDir);
      const runtime = createStudioRuntime({
        themeDir,
        referencePath,
        config,
        deps: { processor: getProcessor(), ...runtimeDeps },
        onProgress: (evt) => {
          // The renderer only flashes a transient toast, so log the real
          // failure/retry reason to the main process too — otherwise a failed
          // run is undiagnosable ("Failed" with no cause, no record).
          if (evt && (evt.stage === "error" || evt.stage === "retry") && evt.error) {
            console.warn(`Clawd Studio: ${evt.actionId} ${evt.stage}: ${evt.error}`);
          }
          const preview = evt && evt.stage === "written"
            ? buildActionPreview(themeDir, evt.actionId, referenceSha256)
            : null;
          sendProgress(preview ? { ...evt, ...preview } : evt);
        },
      });

      if (input.mode === "all") {
        const summary = await runtime.generateAll();
        onThemesChanged({ themeId });
        return {
          status: "ok",
          themeId,
          summary: {
            ...summary,
            results: summary.results.map((result) => ({
              ...result,
              ...buildActionPreview(themeDir, result.actionId, referenceSha256),
            })),
          },
        };
      }
      const actionId = String(input.actionId || "");
      const result = await runtime.generateAction(actionId);
      onThemesChanged({ themeId });
      return {
        status: "ok",
        themeId,
        result: { ...result, ...buildActionPreview(themeDir, actionId, referenceSha256) },
      };
    } catch (err) {
      const message = (err && err.message) || "generation failed";
      console.warn(`Clawd Studio: generation failed: ${message}`);
      return { status: "error", message };
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

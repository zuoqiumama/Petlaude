"use strict";

// ── Studio orchestration (main) ──────────────────────────────────────────────
// Drives one action's full generation pipeline, and generate-all across the
// manifest:
//
//   manifest prompt + layout guide ──▶ image-gen API ──▶ download strip
//     ──▶ offscreen canvas extract (chroma-key + fitToCell)
//     ──▶ assemble animated SVG ──▶ write theme asset + patch theme.json
//
// All side effects are injected (client, downloader, processor) so the
// pipeline is unit-testable; writes are atomic (tmp + rename) so a failing
// step never leaves a partial theme.

const fs = require("fs");
const path = require("path");

const {
  ACTIONS,
  getAction,
  buildPrompt,
  CHROMA,
} = require("../companion/action-manifest");
const { assembleAnimatedSvg } = require("./svg-assemble");
const { GEN_VIEWBOX } = require("./pet-theme");

const CELL_SIZE = 512;
const CHROMA_THRESHOLD = 100; // validated against gpt-image-2 output in _imggen-test
const GUIDE_SAFE_MARGIN = 26;
const CHROMA_CANDIDATES = Object.freeze([
  Object.freeze([0, 255, 0]),
  Object.freeze([255, 0, 255]),
  Object.freeze([0, 255, 255]),
  Object.freeze([0, 0, 255]),
]);

function hexToRgb(hex) {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function rgbToHex(rgb) {
  return `#${rgb.map((value) => Number(value).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

// Image APIs accept a small set of sizes; pick the one closest to the grid's
// aspect so each cell stays roughly square for the model.
function pickGenerationSize(grid) {
  const ratio = grid.cols / grid.rows;
  if (ratio >= 1.4) return "1536x1024";
  if (ratio <= 0.72) return "1024x1536";
  return "1024x1024";
}

function atomicWrite(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).replace(".", "").toLowerCase() || "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

function validateExtraction(action, extracted) {
  const frames = Array.isArray(extracted && extracted.frames) ? extracted.frames.slice(0, action.frames) : [];
  if (frames.length < action.frames) {
    throw new Error(`extraction produced ${frames.length}/${action.frames} frames for ${action.id}`);
  }
  const report = Array.isArray(extracted && extracted.report) ? extracted.report : [];
  for (let i = 0; i < Math.min(report.length, action.frames); i += 1) {
    const frame = report[i] || {};
    const blank = !(Number(frame.rawW) > 0) || !(Number(frame.rawH) > 0);
    const sparse = Number.isFinite(Number(frame.opaquePct)) && Number(frame.opaquePct) < 0.2;
    if (blank || sparse) {
      throw new Error(`extracted frame ${i + 1} is blank or too sparse for ${action.id}`);
    }
  }
  return frames;
}

function decodePngFrame(frame, actionId, index) {
  const match = /^data:image\/png;base64,([a-z0-9+/=\r\n]+)$/i.exec(String(frame || ""));
  if (!match) {
    throw new Error(`extracted frame ${index + 1} is not a PNG data URL for ${actionId}`);
  }
  const bytes = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) {
    throw new Error(`extracted frame ${index + 1} is empty for ${actionId}`);
  }
  return bytes;
}

// Merge one generated action into the theme config (pure: returns a new object).
function patchThemeWithAction(theme, action, assetFile) {
  const next = { ...theme };
  const duration = action.anim.totalMs;

  if (action.category === "idle-life") {
    const idleLife = { enabled: true, cooldownMs: 30000, ...(next.idleLife || {}) };
    const behaviors = Array.isArray(idleLife.behaviors) ? [...idleLife.behaviors] : [];
    const entry = {
      id: action.id,
      file: assetFile,
      duration,
      trigger: { ...action.trigger },
    };
    if (action.anim.windowMove) entry.windowMove = { ...action.anim.windowMove };
    const existing = behaviors.findIndex((b) => b && b.id === action.id);
    if (existing >= 0) behaviors[existing] = entry;
    else behaviors.push(entry);
    next.idleLife = { ...idleLife, behaviors };
    return next;
  }

  if (action.category === "context") {
    const key = action.trigger && action.trigger.type;
    if (!key) throw new Error(`context action ${action.id} has no trigger.type`);
    next.contextReactions = {
      ...(next.contextReactions || {}),
      [key]: { file: assetFile, duration },
    };
    return next;
  }

  if (action.category === "touch") {
    const key = action.trigger && action.trigger.reaction;
    if (!key) throw new Error(`touch action ${action.id} has no trigger.reaction`);
    const entry = { file: assetFile, duration };
    if (Number.isFinite(action.trigger.threshold)) entry.threshold = action.trigger.threshold;
    next.touchReactions = { ...(next.touchReactions || {}), [key]: entry };
    // Mirror into `reactions` so hit-renderer's existing reaction map sees it.
    next.reactions = { ...(next.reactions || {}), [key]: entry };
    return next;
  }

  throw new Error(`unknown action category: ${action.category}`);
}

function createStudioRuntime(options = {}) {
  const { themeDir, referencePath, config } = options;
  const deps = options.deps || {};
  const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  if (!themeDir) throw new Error("createStudioRuntime requires themeDir");
  if (!referencePath) throw new Error("createStudioRuntime requires referencePath");

  const generate = deps.generateImage || require("./imagegen-client").generateImage;
  const download = deps.downloadImage || defaultDownloadImage;
  const processor = deps.processor;
  if (!processor) throw new Error("createStudioRuntime requires deps.processor");

  const explicitChroma = options.chroma || null;

  function emit(actionId, stage, extra) {
    try {
      onProgress({ actionId, stage, ...(extra || {}) });
    } catch { /* progress must never break the pipeline */ }
  }

  // Reference downscale: a raw reference can be up to 10MB; embedding that as
  // base64 bloats the API payload and adds nothing at 512-cell scale. When the
  // processor supports prepareReference, shrink it to <=768px first.
  let _refDataUrlCache = null;
  async function getReferenceDataUrl() {
    if (_refDataUrlCache) return _refDataUrlCache;
    const raw = fileToDataUrl(referencePath);
    if (typeof processor.prepareReference === "function") {
      try {
        const prepared = await processor.prepareReference({ dataUrl: raw, maxSize: 768 });
        if (prepared && prepared.dataUrl) {
          _refDataUrlCache = prepared.dataUrl;
          return _refDataUrlCache;
        }
      } catch { /* fall back to the raw reference */ }
    }
    _refDataUrlCache = raw;
    return raw;
  }

  let _chromaPromise = null;
  function getChroma() {
    if (_chromaPromise) return _chromaPromise;
    _chromaPromise = (async () => {
      if (explicitChroma) return { hex: explicitChroma, rgb: hexToRgb(explicitChroma) };
      if (typeof processor.chooseChroma === "function") {
        try {
          const selected = await processor.chooseChroma({
            dataUrl: await getReferenceDataUrl(),
            candidates: CHROMA_CANDIDATES.map((rgb) => [...rgb]),
            threshold: CHROMA_THRESHOLD,
          });
          if (selected && Array.isArray(selected.rgb) && selected.rgb.length === 3) {
            return { rgb: selected.rgb.map(Number), hex: selected.hex || rgbToHex(selected.rgb) };
          }
        } catch { /* fall back to the default green key */ }
      }
      return { hex: CHROMA, rgb: hexToRgb(CHROMA) };
    })();
    return _chromaPromise;
  }

  async function generateAction(actionId) {
    const action = getAction(actionId);
    if (!action) throw new Error(`unknown action: ${actionId}`);
    emit(actionId, "start");
    const chroma = await getChroma();

    // 1. Layout guide for this action's grid (rasterized in the offscreen
    // window). Guide cells must share the OUTPUT size's aspect — a square
    // guide for a 1536x1024 output would teach the model the wrong slots.
    const size = pickGenerationSize(action.grid);
    const [outW, outH] = size.split("x").map(Number);
    const guide = await processor.makeGuide({
      cols: action.grid.cols,
      rows: action.grid.rows,
      cell: CELL_SIZE,
      cellW: Math.round(outW / action.grid.cols),
      cellH: Math.round(outH / action.grid.rows),
      safe: GUIDE_SAFE_MARGIN,
      _actionId: actionId,
    });

    // 2. Generate the grid strip: reference anchors identity+size, guide anchors layout.
    const stripUrl = await generate({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      prompt: buildPrompt(action, chroma.hex),
      images: [await getReferenceDataUrl(), guide.dataUrl],
      size,
      _actionId: actionId,
    });
    emit(actionId, "generated");

    // 3. Download + extract normalized frames.
    const stripBytes = await download(stripUrl);
    const stripDataUrl = `data:image/png;base64,${Buffer.from(stripBytes).toString("base64")}`;
    const extracted = await processor.processStrip({
      stripDataUrl,
      cols: action.grid.cols,
      rows: action.grid.rows,
      key: chroma.rgb,
      threshold: CHROMA_THRESHOLD,
      cell: CELL_SIZE,
      _actionId: actionId,
    });
    const frames = validateExtraction(action, extracted);
    emit(actionId, "extracted", { report: extracted.report });

    // 4. Store frames beside the SVG. User-theme sanitization intentionally
    // strips data: URLs, so embedding frames would make the animation blank.
    const assetFile = `${action.id}.svg`;
    const frameFiles = frames.map((_, index) => `${action.id}-frame-${index + 1}.png`);
    const frameBytes = frames.map((frame, index) => decodePngFrame(frame, action.id, index));
    const svg = assembleAnimatedSvg({
      frames: frameFiles,
      anim: action.anim,
      viewBox: GEN_VIEWBOX,
    });
    emit(actionId, "assembled");

    // 5. Atomic writes: frame assets and SVG first, then the theme.json patch.
    const assetsDir = path.join(themeDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    for (let index = 0; index < frameFiles.length; index += 1) {
      atomicWrite(path.join(assetsDir, frameFiles[index]), frameBytes[index]);
    }
    atomicWrite(path.join(assetsDir, assetFile), svg);

    const themeJsonPath = path.join(themeDir, "theme.json");
    const theme = JSON.parse(fs.readFileSync(themeJsonPath, "utf8"));
    const patched = patchThemeWithAction(theme, action, assetFile);
    atomicWrite(themeJsonPath, `${JSON.stringify(patched, null, 2)}\n`);
    emit(actionId, "written");

    return { actionId, assetFile, frames: frames.length, report: extracted.report };
  }

  async function generateAll() {
    const failed = [];
    let ok = 0;
    for (const action of ACTIONS) {
      try {
        await generateAction(action.id);
        ok += 1;
      } catch (err) {
        failed.push({ actionId: action.id, error: (err && err.message) || "unknown error" });
        emit(action.id, "error", { error: (err && err.message) || "unknown error" });
      }
    }
    return { total: ACTIONS.length, ok, failed };
  }

  return { generateAction, generateAll };
}

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

function defaultDownloadImage(url, timeoutMs = 120000) {
  const dataMatch = /^data:image\/(?:png|jpeg|jpg|webp);base64,([a-z0-9+/=\r\n]+)$/i.exec(String(url || ""));
  if (dataMatch) {
    const data = Buffer.from(dataMatch[1].replace(/\s+/g, ""), "base64");
    if (data.length > MAX_IMAGE_BYTES) return Promise.reject(new Error("downloaded image too large"));
    if (data.length === 0) return Promise.reject(new Error("generated image was empty"));
    return Promise.resolve(data);
  }
  const https = require("https");
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "clawd-on-desk-studio" } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`image download failed (HTTP ${res.statusCode})`));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on("data", (c) => {
        total += c.length;
        if (total > MAX_IMAGE_BYTES) {
          req.destroy();
          reject(new Error("downloaded image too large"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error("image download timed out"));
    });
  });
}

module.exports = { createStudioRuntime, patchThemeWithAction, pickGenerationSize };

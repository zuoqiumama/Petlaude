"use strict";

// ── Studio orchestration (main) ──────────────────────────────────────────────
// Drives one action's full generation pipeline, and generate-all across the
// manifest:
//
//   manifest prompt + layout guide ──▶ image-gen API ──▶ download strip
//     ──▶ offscreen canvas extract (adaptive chroma + stable body anchors)
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
const {
  GEN_VIEWBOX,
  GEN_LAYOUT,
  sleepSequenceForStates,
  buildGeneratedMiniMode,
} = require("./pet-theme");
const { STUDIO_IMAGE_MODEL } = require("./studio-config");
const {
  STUDIO_QUALITY_VERSION,
  actionQualityFileName,
  actionFrameFileNames,
  getThemeReferenceFingerprint,
  hasCompleteActionAssets,
} = require("./generation-contract");

const CELL_SIZE = 512;
const STUDIO_IMAGE_QUALITY = "medium";
const STUDIO_IMAGE_BACKGROUND = "opaque";
const CHROMA_THRESHOLD = 100; // validated against gpt-image-2 output in _imggen-test
const GUIDE_SAFE_MARGIN = 26;
const MAX_GENERATION_ATTEMPTS = 3;
// Wallet guard for generate-all: if this many actions fail back-to-back before
// any has successfully generated, the provider almost certainly cannot satisfy
// the pipeline (over-compressed output, no clean chroma sheet, ignores the grid
// instructions, …). Abort the batch instead of paying for every remaining
// action — a doomed "generate all" otherwise bills ~33 images for nothing.
const GENERATE_ALL_ABORT_STREAK = 3;
// Linear backoff between retries (× attempt). Transient overload responds best
// to a brief pause rather than an immediate hammer on an already-busy server.
const RETRY_BACKOFF_MS = 2000;
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

// GPT Image 2 itself accepts flexible dimensions, but many OpenAI-compatible
// gateways still validate against the long-standing popular size set. Use the
// broadest-compatible canvas and derive rectangular guide cells from it; frame
// extraction normalizes every slot back to the Studio's square output cell.
function pickGenerationSize(grid) {
  const cols = Number(grid && grid.cols);
  const rows = Number(grid && grid.rows);
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new Error("generation grid must use positive integer dimensions");
  }

  const ratio = cols / rows;
  if (ratio >= 1.4) return "1536x1024";
  if (ratio <= 0.72) return "1024x1536";
  return "1024x1024";
}

// Only retry failures that happen BEFORE the provider produced (and billed) an
// image — i.e. genuine transient transport errors: a dropped connection, or a
// server-side 429/5xx that is not charged. Every other failure reaches us AFTER
// a 2xx image response, which means an image was already generated and BILLED:
// a parse miss (no-image/bad-json), a download error, a failed frame
// extraction, or a quality-validation rejection. Auto-retrying those just pays
// the provider again for the same non-conforming output, so they must NOT
// retry. This is the wallet guard — one click costs one image, not three. To
// re-roll a quality failure the user clicks Generate again, explicitly.
// Some providers signal transient congestion as "overloaded" / "excessive
// system load" / a rate limit — and a few mislabel it as HTTP 400. Such
// rejections happen before any image is produced, so they cost nothing and are
// worth a backed-off retry, whatever status code the provider chose.
const TRANSIENT_LOAD_PATTERN = /excessive system load|overload|server (?:is )?busy|too many requests|rate.?limit|temporarily (?:unavailable|busy)|try again|capacity/i;

function shouldRetryGenerationError(error) {
  const code = error && error.code;
  const message = String((error && error.message) || "");
  if (code === "IMAGEGEN_NETWORK") return true;
  if (code === "IMAGEGEN_HTTP_ERROR") {
    if (/HTTP (?:429|5\d\d)\b/i.test(message)) return true;
    if (TRANSIENT_LOAD_PATTERN.test(message)) return true;
  }
  return false;
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
    const qualityFailure = frame.lineArtifact
      ? "copied a guide line"
      : (Number(frame.edgeTouchPct) > 1
        ? "touches the frame edge"
        : (Number(frame.discardedPct) > 12
          ? "contains detached artifacts"
          : (Number(frame.backgroundResidualPct) > 1
            ? "retains chroma background"
            : (Number(frame.opaquePct) > 70 ? "is mostly opaque background" : null))));
    if (qualityFailure) {
      const error = new Error(`quality validation failed: frame ${i + 1} ${qualityFailure} for ${action.id}`);
      error.code = "STUDIO_QUALITY_ERROR";
      throw error;
    }
  }

  const checked = report.slice(0, action.frames);
  for (const [field, locked] of [["anchorX", action.anchor && action.anchor.lockX], ["anchorY", action.anchor && action.anchor.lockY]]) {
    if (!locked) continue;
    const values = checked.map((frame) => Number(frame && frame[field])).filter(Number.isFinite);
    if (values.length === action.frames && Math.max(...values) - Math.min(...values) > 2) {
      const error = new Error(`quality validation failed: unstable body anchor for ${action.id}`);
      error.code = "STUDIO_QUALITY_ERROR";
      throw error;
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

  if (action.category === "core") {
    const stateKeys = action.trigger && Array.isArray(action.trigger.states)
      ? action.trigger.states
      : null;
    if (!stateKeys || stateKeys.length === 0) {
      throw new Error(`core action ${action.id} has no trigger.states`);
    }
    // Replace the static-reference placeholder (and sleeping's fallbackTo
    // binding) with the generated looping animation for every bound state.
    const states = { ...(next.states || {}) };
    for (const key of stateKeys) {
      states[key] = [assetFile];
    }
    next.states = states;
    return next;
  }

  if (action.category === "sleep") {
    const stateKeys = action.trigger && Array.isArray(action.trigger.states)
      ? action.trigger.states
      : null;
    if (!stateKeys || stateKeys.length === 0) {
      throw new Error(`sleep action ${action.id} has no trigger.states`);
    }
    const states = { ...(next.states || {}) };
    for (const key of stateKeys) {
      states[key] = [assetFile];
    }
    next.states = states;
    // Enable the full wind-down only once every transitional state exists.
    next.sleepSequence = sleepSequenceForStates(states);
    return next;
  }

  if (action.category === "mini") {
    const key = action.trigger && action.trigger.miniState;
    if (!key) throw new Error(`mini action ${action.id} has no trigger.miniState`);
    const prevStates = next.miniMode && typeof next.miniMode.states === "object"
      ? next.miniMode.states
      : {};
    const states = { ...prevStates, [key]: [assetFile] };
    // buildGeneratedMiniMode recomputes `supported` from the required set, so a
    // partial run stays valid (supported:false) until mini mode is complete.
    next.miniMode = buildGeneratedMiniMode(states);
    return next;
  }

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
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const processor = deps.processor;
  if (!processor) throw new Error("createStudioRuntime requires deps.processor");
  const referenceSha256 = getThemeReferenceFingerprint(themeDir);
  if (!referenceSha256) throw new Error("createStudioRuntime requires a copied canonical reference");

  const explicitChroma = options.chroma || null;

  function emit(actionId, stage, extra) {
    try {
      onProgress({ actionId, stage, ...(extra || {}) });
    } catch { /* progress must never break the pipeline */ }
  }

  // Reference downscale: a raw reference can be up to 10MB; embedding that as
  // base64 bloats the API payload and adds nothing at 512-cell scale. When the
  // processor supports prepareReference, shrink it to <=1024px first so small
  // identity details and markings remain useful to the edit model.
  let _refDataUrlCache = null;
  async function getReferenceDataUrl() {
    if (_refDataUrlCache) return _refDataUrlCache;
    const raw = fileToDataUrl(referencePath);
    if (typeof processor.prepareReference === "function") {
      try {
        const prepared = await processor.prepareReference({ dataUrl: raw, maxSize: 1024 });
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

  async function generateActionAttempt(action, attempt) {
    const actionId = action.id;
    emit(actionId, "start", { attempt, maxAttempts: MAX_GENERATION_ATTEMPTS });
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
      key: chroma.rgb,
      threshold: CHROMA_THRESHOLD,
      _actionId: actionId,
    });

    // 2. Generate the grid strip: reference anchors identity+size, guide anchors layout.
    const stripUrl = await generate({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: STUDIO_IMAGE_MODEL,
      prompt: buildPrompt(action, chroma.hex, { attempt }),
      images: [await getReferenceDataUrl(), guide.dataUrl],
      size,
      quality: STUDIO_IMAGE_QUALITY,
      background: STUDIO_IMAGE_BACKGROUND,
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
      stabilize: true,
      anchor: {
        ...(action.anchor || {}),
        targetX: GEN_LAYOUT.centerX,
        targetY: GEN_LAYOUT.baselineY - 1,
        safeBox: { ...GEN_LAYOUT.contentBox },
      },
      _actionId: actionId,
    });
    const frames = validateExtraction(action, extracted);
    emit(actionId, "extracted", { report: extracted.report });

    // 4. Store frames beside the SVG. User-theme sanitization intentionally
    // strips data: URLs, so embedding frames would make the animation blank.
    const assetFile = `${action.id}.svg`;
    const frameFiles = actionFrameFileNames(action);
    const frameBytes = frames.map((frame, index) => decodePngFrame(frame, action.id, index));
    const svg = assembleAnimatedSvg({
      frames: frameFiles,
      anim: action.anim,
      viewBox: GEN_VIEWBOX,
      bob: false,
    });
    emit(actionId, "assembled");

    // 5. Atomic writes: frame assets and SVG first, then the theme.json patch.
    const assetsDir = path.join(themeDir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    const qualityPath = path.join(assetsDir, actionQualityFileName(action.id));
    // Remove the old completion marker before replacing any asset. If the app
    // exits during writeback, a mixed old/new frame set must not look complete.
    fs.rmSync(qualityPath, { force: true });
    for (let index = 0; index < frameFiles.length; index += 1) {
      atomicWrite(path.join(assetsDir, frameFiles[index]), frameBytes[index]);
    }
    atomicWrite(path.join(assetsDir, assetFile), svg);

    const themeJsonPath = path.join(themeDir, "theme.json");
    const theme = JSON.parse(fs.readFileSync(themeJsonPath, "utf8"));
    const patched = patchThemeWithAction(theme, action, assetFile);
    atomicWrite(themeJsonPath, `${JSON.stringify(patched, null, 2)}\n`);
    atomicWrite(qualityPath, `${JSON.stringify({
      qualityVersion: STUDIO_QUALITY_VERSION,
      actionId,
      frames: action.frames,
      referenceSha256,
    }, null, 2)}\n`);
    emit(actionId, "written");

    return { actionId, assetFile, frames: frames.length, report: extracted.report };
  }

  async function generateAction(actionId) {
    const action = getAction(actionId);
    if (!action) throw new Error(`unknown action: ${actionId}`);
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
      try {
        return await generateActionAttempt(action, attempt);
      } catch (err) {
        lastError = err;
        if (attempt < MAX_GENERATION_ATTEMPTS && shouldRetryGenerationError(err)) {
          emit(actionId, "retry", {
            attempt: attempt + 1,
            maxAttempts: MAX_GENERATION_ATTEMPTS,
            error: (err && err.message) || "generation failed",
          });
          await sleep(RETRY_BACKOFF_MS * attempt);
        } else {
          break;
        }
      }
    }
    throw lastError || new Error(`generation failed for ${actionId}`);
  }

  async function generateAll() {
    const failed = [];
    const results = [];
    let ok = 0;
    let okGenerated = 0; // successful PAID generations (reused assets don't count)
    let failureStreak = 0;
    let aborted = false;
    let nextActionIndex = ACTIONS.length;
    for (let actionIndex = 0; actionIndex < ACTIONS.length; actionIndex += 1) {
      const action = ACTIONS[actionIndex];
      if (hasCompleteActionAssets(themeDir, action, referenceSha256)) {
        results.push({
          actionId: action.id,
          assetFile: `${action.id}.svg`,
          frames: action.frames,
          report: [],
          reused: true,
        });
        ok += 1;
        continue;
      }
      try {
        results.push(await generateAction(action.id));
        ok += 1;
        okGenerated += 1;
        failureStreak = 0;
      } catch (err) {
        failed.push({ actionId: action.id, error: (err && err.message) || "unknown error" });
        emit(action.id, "error", { error: (err && err.message) || "unknown error" });
        failureStreak += 1;
        // Nothing has generated yet and several actions failed in a row: stop
        // paying for a batch that is almost certainly doomed.
        if (okGenerated === 0 && failureStreak >= GENERATE_ALL_ABORT_STREAK) {
          aborted = true;
          nextActionIndex = actionIndex + 1;
          break;
        }
      }
    }
    const remaining = aborted
      ? ACTIONS.slice(nextActionIndex).map((action) => action.id)
      : [];
    return { total: ACTIONS.length, ok, failed, results, aborted, remaining };
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

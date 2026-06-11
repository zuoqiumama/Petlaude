"use strict";

// ── Offscreen processor (renderer) ───────────────────────────────────────────
// Runs in the hidden processing window. Decodes the generated strip PNG to
// ImageData via Canvas, runs the (already unit-tested) ClawdFrameExtract
// pipeline, and returns normalized frame PNG data URLs. Also rasterizes layout
// guides. All heavy image math is the shared pure code; this file is glue.

const cv = document.getElementById("cv");
const ctx = cv.getContext("2d", { willReadFrequently: true });

function decode(dataUrl) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error("image decode failed"));
    im.src = dataUrl;
  });
}

function cellToDataUrl(cell) {
  cv.width = cell.width;
  cv.height = cell.height;
  ctx.clearRect(0, 0, cell.width, cell.height);
  const id = ctx.createImageData(cell.width, cell.height);
  id.data.set(cell.data);
  ctx.putImageData(id, 0, 0);
  return cv.toDataURL("image/png");
}

async function processStrip(payload) {
  const { stripDataUrl, cols, rows, key, threshold, cell } = payload;
  const im = await decode(stripDataUrl);
  cv.width = im.naturalWidth;
  cv.height = im.naturalHeight;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(im, 0, 0);
  const raw = ctx.getImageData(0, 0, cv.width, cv.height);
  const cells = window.ClawdFrameExtract.extractGrid(
    { data: raw.data, width: raw.width, height: raw.height },
    cols, rows, key, threshold, cell, cell,
  );
  const frames = cells.map((c) => cellToDataUrl(c.cell));
  const report = cells.map((c) => ({ row: c.row, col: c.col, rawW: c.rawW, rawH: c.rawH, opaquePct: c.opaquePct }));
  return { frames, report };
}

function makeGuide(payload) {
  const { cols, rows, cell, safe = 26 } = payload;
  // Guide cells may be non-square (cellW/cellH) so they match the output
  // size's aspect; `cell` remains the square fallback.
  const cellW = payload.cellW || cell;
  const cellH = payload.cellH || cell;
  cv.width = cols * cellW;
  cv.height = rows * cellH;
  window.ClawdLayoutGuide.drawLayoutGuide(ctx, { cols, rows, cellW, cellH, safeX: safe, safeY: safe });
  return { dataUrl: cv.toDataURL("image/png") };
}

// Downscale a reference image so the API payload stays small (longest side
// <= maxSize). Bilinear smoothing is fine here — this is the model's identity
// reference, not a pixel-perfect asset.
async function prepareReference(payload) {
  const { dataUrl, maxSize = 768 } = payload;
  const im = await decode(dataUrl);
  const scale = Math.min(1, maxSize / Math.max(im.naturalWidth, im.naturalHeight));
  const w = Math.max(1, Math.round(im.naturalWidth * scale));
  const h = Math.max(1, Math.round(im.naturalHeight * scale));
  cv.width = w;
  cv.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(im, 0, 0, w, h);
  return { dataUrl: cv.toDataURL("image/png"), width: w, height: h };
}

async function chooseChroma(payload) {
  const im = await decode(payload.dataUrl);
  cv.width = im.naturalWidth;
  cv.height = im.naturalHeight;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(im, 0, 0);
  const raw = ctx.getImageData(0, 0, cv.width, cv.height);
  const rgb = window.ClawdFrameExtract.chooseChromaKey(
    { data: raw.data, width: raw.width, height: raw.height },
    payload.candidates,
    payload.threshold,
  );
  const hex = `#${rgb.map((v) => Number(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
  return { rgb, hex };
}

window.offscreenAPI.onJob(async (job) => {
  const { id, channel, payload } = job || {};
  try {
    let data;
    if (channel === "processStrip") data = await processStrip(payload);
    else if (channel === "makeGuide") data = makeGuide(payload);
    else if (channel === "prepareReference") data = await prepareReference(payload);
    else if (channel === "chooseChroma") data = await chooseChroma(payload);
    else throw new Error(`unknown channel: ${channel}`);
    window.offscreenAPI.result(id, data);
  } catch (err) {
    window.offscreenAPI.error(id, err && err.message);
  }
});

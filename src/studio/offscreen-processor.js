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
  cv.width = cols * cell;
  cv.height = rows * cell;
  window.ClawdLayoutGuide.drawLayoutGuide(ctx, { cols, rows, cellW: cell, cellH: cell, safeX: safe, safeY: safe });
  return { dataUrl: cv.toDataURL("image/png") };
}

window.offscreenAPI.onJob(async (job) => {
  const { id, channel, payload } = job || {};
  try {
    let data;
    if (channel === "processStrip") data = await processStrip(payload);
    else if (channel === "makeGuide") data = makeGuide(payload);
    else throw new Error(`unknown channel: ${channel}`);
    window.offscreenAPI.result(id, data);
  } catch (err) {
    window.offscreenAPI.error(id, err && err.message);
  }
});

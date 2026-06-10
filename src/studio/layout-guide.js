"use strict";

// ── Layout guide ─────────────────────────────────────────────────────────────
// Adapted from the hatch-real-pet skill's create_layout_guide. Generates the
// guide image that is fed to the image model so every frame lands in its own
// equal cell at a consistent scale (this is the key to subject-size
// consistency). computeGuideRects is pure (unit-tested); drawLayoutGuide paints
// onto a Canvas 2D context inside the offscreen renderer. UMD so it works in
// both the renderer (ClawdLayoutGuide global) and the test suite (require).

(function initLayoutGuide(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawdLayoutGuide = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  function computeGuideRects(cols, rows, cellW, cellH, safeX, safeY) {
    const rects = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const x = c * cellW;
        const y = r * cellH;
        rects.push({
          cell: { x, y, w: cellW, h: cellH },
          safe: { x: x + safeX, y: y + safeY, w: cellW - 2 * safeX, h: cellH - 2 * safeY },
          center: { x: x + Math.floor(cellW / 2), y: y + Math.floor(cellH / 2) },
        });
      }
    }
    return rects;
  }

  function dashedLine(ctx, x1, y1, x2, y2) {
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = "#c0c0c0";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  // Paint the guide onto a 2D context of size (cols*cellW) x (rows*cellH).
  function drawLayoutGuide(ctx, spec) {
    const { cols, rows, cellW, cellH, safeX = 26, safeY = 26 } = spec;
    const width = cols * cellW;
    const height = rows * cellH;
    ctx.fillStyle = "#f7f7f7";
    ctx.fillRect(0, 0, width, height);
    const rects = computeGuideRects(cols, rows, cellW, cellH, safeX, safeY);
    for (const r of rects) {
      ctx.strokeStyle = "#111111";
      ctx.lineWidth = 3;
      ctx.strokeRect(r.cell.x + 1.5, r.cell.y + 1.5, r.cell.w - 3, r.cell.h - 3);
      ctx.strokeStyle = "#2f80ed";
      ctx.lineWidth = 2;
      ctx.strokeRect(r.safe.x, r.safe.y, r.safe.w, r.safe.h);
      dashedLine(ctx, r.center.x, r.safe.y, r.center.x, r.safe.y + r.safe.h);
      dashedLine(ctx, r.safe.x, r.center.y, r.safe.x + r.safe.w, r.center.y);
    }
    return { width, height };
  }

  return { computeGuideRects, drawLayoutGuide };
});

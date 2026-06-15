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

  function buildGuidePalette(key, threshold = 100) {
    const source = Array.isArray(key) && key.length === 3 ? key.map(Number) : [247, 247, 247];
    const maxOffset = Math.max(1, Math.floor((threshold - 1) / Math.sqrt(3)));
    function shade(requested) {
      const amount = Math.min(requested, maxOffset);
      return source.map((value) => (value <= 127 ? Math.min(255, value + amount) : Math.max(0, value - amount)));
    }
    return {
      background: [...source],
      border: shade(18),
      safe: shade(32),
      center: shade(48),
    };
  }

  function cssRgb(rgb) {
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function dashedLine(ctx, x1, y1, x2, y2, strokeStyle) {
    ctx.save();
    ctx.setLineDash([10, 8]);
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.restore();
  }

  // Paint the guide onto a 2D context of size (cols*cellW) x (rows*cellH).
  function drawLayoutGuide(ctx, spec) {
    const { cols, rows, cellW, cellH, safeX = 26, safeY = 26, key, threshold = 100 } = spec;
    const width = cols * cellW;
    const height = rows * cellH;
    const palette = buildGuidePalette(key, threshold);
    ctx.fillStyle = cssRgb(palette.background);
    ctx.fillRect(0, 0, width, height);
    const rects = computeGuideRects(cols, rows, cellW, cellH, safeX, safeY);
    for (const r of rects) {
      ctx.strokeStyle = cssRgb(palette.border);
      ctx.lineWidth = 3;
      ctx.strokeRect(r.cell.x + 1.5, r.cell.y + 1.5, r.cell.w - 3, r.cell.h - 3);
      ctx.strokeStyle = cssRgb(palette.safe);
      ctx.lineWidth = 2;
      ctx.strokeRect(r.safe.x, r.safe.y, r.safe.w, r.safe.h);
      dashedLine(ctx, r.center.x, r.safe.y, r.center.x, r.safe.y + r.safe.h, cssRgb(palette.center));
      dashedLine(ctx, r.safe.x, r.center.y, r.safe.x + r.safe.w, r.center.y, cssRgb(palette.center));
    }
    return { width, height };
  }

  return { computeGuideRects, buildGuidePalette, drawLayoutGuide };
});

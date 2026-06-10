"use strict";

// ── Frame extraction ─────────────────────────────────────────────────────────
// Canvas/JS port of the validated _imggen-test/petgrid.py pipeline. Operates on
// plain ImageData-like objects ({ data: Uint8ClampedArray RGBA, width, height })
// so every step is unit-testable in Node without a DOM. The offscreen renderer
// supplies real ImageData decoded from the generated strip PNG.
//
//   removeChroma         flat chroma-key removal (color distance threshold)
//   connectedComponents  4-connected alpha blobs
//   fitToCell            crop-to-content → scale-to-fit → center in a cell
//   extractGrid          chroma-key → order frames row-major → fit each
//
// UMD: ClawdFrameExtract global (renderer) + module.exports (tests).

(function initFrameExtract(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ClawdFrameExtract = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  function blank(width, height) {
    return { data: new Uint8ClampedArray(width * height * 4), width, height };
  }

  function removeChroma(image, key, threshold) {
    const { width, height } = image;
    const out = { data: new Uint8ClampedArray(image.data), width, height };
    const t2 = threshold * threshold;
    for (let i = 0; i < out.data.length; i += 4) {
      const dr = out.data[i] - key[0];
      const dg = out.data[i + 1] - key[1];
      const db = out.data[i + 2] - key[2];
      if (dr * dr + dg * dg + db * db <= t2) out.data[i + 3] = 0;
    }
    return out;
  }

  function connectedComponents(image, alphaMin = 16) {
    const { width: w, height: h, data } = image;
    const visited = new Uint8Array(w * h);
    const comps = [];
    for (let start = 0; start < w * h; start += 1) {
      if (visited[start] || data[start * 4 + 3] <= alphaMin) continue;
      const stack = [start];
      visited[start] = 1;
      const pixels = [];
      let minx = w; let miny = h; let maxx = 0; let maxy = 0;
      while (stack.length) {
        const cur = stack.pop();
        pixels.push(cur);
        const x = cur % w;
        const y = (cur - x) / w;
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
        const nb = [];
        if (x > 0) nb.push(cur - 1);
        if (x + 1 < w) nb.push(cur + 1);
        if (y > 0) nb.push(cur - w);
        if (y + 1 < h) nb.push(cur + w);
        for (const n of nb) {
          if (!visited[n] && data[n * 4 + 3] > alphaMin) { visited[n] = 1; stack.push(n); }
        }
      }
      comps.push({
        area: pixels.length,
        pixels,
        bbox: [minx, miny, maxx + 1, maxy + 1],
        cx: (minx + maxx + 1) / 2,
        cy: (miny + maxy + 1) / 2,
      });
    }
    return comps;
  }

  function contentBBox(image) {
    const { width: w, height: h, data } = image;
    let minx = w; let miny = h; let maxx = -1; let maxy = -1;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        if (data[(y * w + x) * 4 + 3] > 0) {
          if (x < minx) minx = x;
          if (y < miny) miny = y;
          if (x > maxx) maxx = x;
          if (y > maxy) maxy = y;
        }
      }
    }
    if (maxx < minx) return null;
    return [minx, miny, maxx + 1, maxy + 1];
  }

  function crop(image, [x0, y0, x1, y1]) {
    const cw = x1 - x0;
    const ch = y1 - y0;
    const out = blank(cw, ch);
    for (let y = 0; y < ch; y += 1) {
      for (let x = 0; x < cw; x += 1) {
        const si = ((y + y0) * image.width + (x + x0)) * 4;
        const di = (y * cw + x) * 4;
        out.data[di] = image.data[si];
        out.data[di + 1] = image.data[si + 1];
        out.data[di + 2] = image.data[si + 2];
        out.data[di + 3] = image.data[si + 3];
      }
    }
    return out;
  }

  // Nearest-neighbor resample (keeps pixel-art crisp).
  function resizeNearest(image, newW, newH) {
    const out = blank(newW, newH);
    for (let y = 0; y < newH; y += 1) {
      const sy = Math.min(image.height - 1, Math.floor((y * image.height) / newH));
      for (let x = 0; x < newW; x += 1) {
        const sx = Math.min(image.width - 1, Math.floor((x * image.width) / newW));
        const si = (sy * image.width + sx) * 4;
        const di = (y * newW + x) * 4;
        out.data[di] = image.data[si];
        out.data[di + 1] = image.data[si + 1];
        out.data[di + 2] = image.data[si + 2];
        out.data[di + 3] = image.data[si + 3];
      }
    }
    return out;
  }

  function paste(dst, src, ox, oy) {
    for (let y = 0; y < src.height; y += 1) {
      const dy = y + oy;
      if (dy < 0 || dy >= dst.height) continue;
      for (let x = 0; x < src.width; x += 1) {
        const dx = x + ox;
        if (dx < 0 || dx >= dst.width) continue;
        const si = (y * src.width + x) * 4;
        if (src.data[si + 3] === 0) continue; // keep transparent dst
        const di = (dy * dst.width + dx) * 4;
        dst.data[di] = src.data[si];
        dst.data[di + 1] = src.data[si + 1];
        dst.data[di + 2] = src.data[si + 2];
        dst.data[di + 3] = src.data[si + 3];
      }
    }
  }

  function fitToCell(image, cellW, cellH, margin = 10) {
    const cell = blank(cellW, cellH);
    const bbox = contentBBox(image);
    if (!bbox) return { cell, rawW: 0, rawH: 0 };
    const sprite = crop(image, bbox);
    const rawW = sprite.width;
    const rawH = sprite.height;
    const scale = Math.min((cellW - margin) / rawW, (cellH - margin) / rawH, 1);
    const drawW = Math.max(1, Math.round(rawW * scale));
    const drawH = Math.max(1, Math.round(rawH * scale));
    const scaled = scale === 1 ? sprite : resizeNearest(sprite, drawW, drawH);
    paste(cell, scaled, Math.floor((cellW - drawW) / 2), Math.floor((cellH - drawH) / 2));
    return { cell, rawW, rawH };
  }

  function opaquePct(image) {
    let opaque = 0;
    const total = image.width * image.height;
    for (let i = 3; i < image.data.length; i += 4) {
      if (image.data[i] > 200) opaque += 1;
    }
    return total ? Math.round((opaque * 1000) / total) / 10 : 0;
  }

  function extractSlots(keyed, cols, rows, cellW, cellH) {
    const out = [];
    const sw = keyed.width / cols;
    const sh = keyed.height / rows;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const region = crop(keyed, [Math.round(c * sw), Math.round(r * sh), Math.round((c + 1) * sw), Math.round((r + 1) * sh)]);
        const fit = fitToCell(region, cellW, cellH);
        out.push({ row: r, col: c, cell: fit.cell, rawW: fit.rawW, rawH: fit.rawH, opaquePct: opaquePct(fit.cell) });
      }
    }
    return out;
  }

  function extractGrid(image, cols, rows, key, threshold, cellW, cellH) {
    const keyed = removeChroma(image, key, threshold);
    const n = cols * rows;
    let comps = connectedComponents(keyed).filter((c) => c.area >= 1);
    comps.sort((a, b) => b.area - a.area);
    const seeds = comps.slice(0, n);
    if (seeds.length < n) return extractSlots(keyed, cols, rows, cellW, cellH);

    // Order row-major: split by cy into `rows` bands, sort each band by cx.
    seeds.sort((a, b) => a.cy - b.cy);
    const out = [];
    for (let r = 0; r < rows; r += 1) {
      const band = seeds.slice(r * cols, (r + 1) * cols).sort((a, b) => a.cx - b.cx);
      for (let c = 0; c < band.length; c += 1) {
        const region = crop(keyed, band[c].bbox);
        const fit = fitToCell(region, cellW, cellH);
        out.push({ row: r, col: c, cell: fit.cell, rawW: fit.rawW, rawH: fit.rawH, opaquePct: opaquePct(fit.cell) });
      }
    }
    return out;
  }

  return {
    removeChroma,
    connectedComponents,
    contentBBox,
    crop,
    resizeNearest,
    fitToCell,
    opaquePct,
    extractGrid,
  };
});

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
//   extractGridPreservingScale
//                        keep valid slots intact; recover complete poses when
//                        the image model crosses a guide boundary
//   extractGridStabilized
//                        adaptive background removal → isolate subject → align
//                        stable body anchors while preserving source scale
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

  function colorDistanceSq(a, b) {
    const dr = a[0] - b[0];
    const dg = a[1] - b[1];
    const db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  }

  function estimateBackgroundColor(image, intendedKey) {
    const { width, height, data } = image;
    const band = Math.max(1, Math.min(8, Math.floor(Math.min(width, height) * 0.04)));
    const buckets = new Map();

    function sample(x, y) {
      const index = (y * width + x) * 4;
      if (data[index + 3] <= 16) return;
      const red = data[index];
      const green = data[index + 1];
      const blue = data[index + 2];
      const key = `${red >> 4},${green >> 4},${blue >> 4}`;
      const entry = buckets.get(key) || { count: 0, red: 0, green: 0, blue: 0 };
      entry.count += 1;
      entry.red += red;
      entry.green += green;
      entry.blue += blue;
      buckets.set(key, entry);
    }

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (x < band || x >= width - band || y < band || y >= height - band) sample(x, y);
      }
    }

    let best = null;
    for (const entry of buckets.values()) {
      const rgb = [entry.red / entry.count, entry.green / entry.count, entry.blue / entry.count];
      const distance = colorDistanceSq(rgb, intendedKey || rgb);
      const candidate = { ...entry, rgb, distance };
      if (!best
        || candidate.count > best.count
        || (candidate.count === best.count && candidate.distance < best.distance)) {
        best = candidate;
      }
    }
    if (!best) return [...intendedKey];
    return best.rgb.map((value) => Math.round(value));
  }

  function removeAdaptiveChroma(image, key, threshold) {
    const backgroundRgb = estimateBackgroundColor(image, key);
    const out = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
    const hard = threshold * threshold;
    const softThreshold = threshold + 48;
    const soft = softThreshold * softThreshold;
    for (let index = 0; index < out.data.length; index += 4) {
      if (out.data[index + 3] === 0) continue;
      const rgb = [out.data[index], out.data[index + 1], out.data[index + 2]];
      const distance = Math.min(colorDistanceSq(rgb, key), colorDistanceSq(rgb, backgroundRgb));
      if (distance <= hard) {
        out.data[index + 3] = 0;
      } else if (distance < soft) {
        const ratio = (Math.sqrt(distance) - threshold) / (softThreshold - threshold);
        out.data[index + 3] = Math.max(0, Math.min(255, Math.round(out.data[index + 3] * ratio)));
      }
    }
    return { image: out, backgroundRgb };
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

  function chooseChromaKey(image, candidates, threshold = 100) {
    const keys = Array.isArray(candidates) && candidates.length
      ? candidates
      : [[0, 255, 0], [255, 0, 255], [0, 255, 255]];
    const t2 = threshold * threshold;
    let best = keys[0];
    let bestConflicts = Infinity;
    for (const key of keys) {
      if (!Array.isArray(key) || key.length !== 3) continue;
      let conflicts = 0;
      for (let i = 0; i < image.data.length; i += 4) {
        if (image.data[i + 3] <= 16) continue;
        const dr = image.data[i] - key[0];
        const dg = image.data[i + 1] - key[1];
        const db = image.data[i + 2] - key[2];
        if (dr * dr + dg * dg + db * db <= t2) conflicts += 1;
      }
      if (conflicts < bestConflicts) {
        best = key;
        bestConflicts = conflicts;
      }
    }
    return [...best];
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

  function translate(image, dx, dy) {
    const out = blank(image.width, image.height);
    paste(out, image, dx, dy);
    return out;
  }

  function detectLineArtifact(image, alphaMin = 16) {
    const { width, height, data } = image;
    const rowThreshold = Math.max(4, Math.floor(width * 0.6));
    const colThreshold = Math.max(4, Math.floor(height * 0.6));
    const rows = new Uint16Array(height);
    const cols = new Uint16Array(width);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (data[index + 3] <= alphaMin) continue;
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        if (Math.max(red, green, blue) > 80 || Math.max(red, green, blue) - Math.min(red, green, blue) > 24) continue;
        rows[y] += 1;
        cols[x] += 1;
      }
    }
    return rows.some((count) => count >= rowThreshold) || cols.some((count) => count >= colThreshold);
  }

  function isolateLargestComponent(image, alphaMin = 16) {
    const components = connectedComponents(image, alphaMin).sort((a, b) => b.area - a.area);
    if (!components.length) return { image: blank(image.width, image.height), discardedPct: 0 };
    const kept = components[0];
    const total = components.reduce((sum, component) => sum + component.area, 0);
    const out = blank(image.width, image.height);
    for (const pixel of kept.pixels) {
      const source = pixel * 4;
      out.data[source] = image.data[source];
      out.data[source + 1] = image.data[source + 1];
      out.data[source + 2] = image.data[source + 2];
      out.data[source + 3] = image.data[source + 3];
    }
    return {
      image: out,
      discardedPct: total ? Math.round(((total - kept.area) * 1000) / total) / 10 : 0,
    };
  }

  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function estimateAnchor(image) {
    const bbox = contentBBox(image);
    if (!bbox) return null;
    const [x0, y0, x1, y1] = bbox;
    const bandTop = y0 + Math.floor((y1 - y0) * 0.25);
    const bandBottom = y0 + Math.ceil((y1 - y0) * 0.78);
    const xs = [];
    for (let y = bandTop; y < bandBottom; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (image.data[(y * image.width + x) * 4 + 3] > 16) xs.push(x);
      }
    }
    return {
      x: Math.round(median(xs.length ? xs : [(x0 + x1 - 1) / 2])),
      y: y1 - 1,
    };
  }

  function edgeTouchPct(image, alphaMin = 16) {
    const margin = Math.max(1, Math.min(3, Math.floor(Math.min(image.width, image.height) * 0.02)));
    let opaque = 0;
    let edge = 0;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (image.data[(y * image.width + x) * 4 + 3] <= alphaMin) continue;
        opaque += 1;
        if (x < margin || x >= image.width - margin || y < margin || y >= image.height - margin) edge += 1;
      }
    }
    return opaque ? Math.round((edge * 1000) / opaque) / 10 : 0;
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

  // Keep fixed slots when the model follows the guide because that preserves
  // the shared body scale, ground line, and intentional movement. If a pose
  // crosses a guide boundary, recover whole connected poses from the full sheet
  // and apply one common scale so adjacent cells never become animation frames.
  function extractGridPreservingScale(image, cols, rows, key, threshold, cellW, cellH) {
    const keyed = removeChroma(image, key, threshold);
    const count = cols * rows;
    let components = connectedComponents(keyed).filter((component) => component.area >= 1);
    components.sort((a, b) => b.area - a.area);
    components = components.slice(0, count);

    if (components.length === count) {
      components.sort((a, b) => a.cy - b.cy);
      const ordered = [];
      for (let r = 0; r < rows; r += 1) {
        ordered.push(...components.slice(r * cols, (r + 1) * cols).sort((a, b) => a.cx - b.cx));
      }

      const sourceW = keyed.width / cols;
      const sourceH = keyed.height / rows;
      const staysInsideGuide = ordered.every((component, index) => {
        const row = Math.floor(index / cols);
        const col = index % cols;
        const [x0, y0, x1, y1] = component.bbox;
        return x0 >= Math.round(col * sourceW)
          && x1 <= Math.round((col + 1) * sourceW)
          && y0 >= Math.round(row * sourceH)
          && y1 <= Math.round((row + 1) * sourceH);
      });

      if (!staysInsideGuide) {
        const padding = Math.min(10, Math.max(0, Math.floor(Math.min(cellW, cellH) / 4)));
        const maxW = Math.max(...ordered.map((component) => component.bbox[2] - component.bbox[0]));
        const maxH = Math.max(...ordered.map((component) => component.bbox[3] - component.bbox[1]));
        const scale = Math.min((cellW - padding) / maxW, (cellH - padding) / maxH, 1);
        return ordered.map((component, index) => {
          const sprite = crop(keyed, component.bbox);
          const rawW = sprite.width;
          const rawH = sprite.height;
          const drawW = Math.max(1, Math.round(rawW * scale));
          const drawH = Math.max(1, Math.round(rawH * scale));
          const resized = drawW === rawW && drawH === rawH ? sprite : resizeNearest(sprite, drawW, drawH);
          const cell = blank(cellW, cellH);
          paste(cell, resized, Math.floor((cellW - drawW) / 2), Math.floor((cellH - drawH) / 2));
          return {
            row: Math.floor(index / cols),
            col: index % cols,
            cell,
            rawW,
            rawH,
            opaquePct: opaquePct(cell),
          };
        });
      }
    }

    const out = [];
    const sourceW = keyed.width / cols;
    const sourceH = keyed.height / rows;
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const region = crop(keyed, [
          Math.round(c * sourceW),
          Math.round(r * sourceH),
          Math.round((c + 1) * sourceW),
          Math.round((r + 1) * sourceH),
        ]);
        const bbox = contentBBox(region);
        const rawW = bbox ? bbox[2] - bbox[0] : 0;
        const rawH = bbox ? bbox[3] - bbox[1] : 0;
        const scale = Math.min(cellW / region.width, cellH / region.height);
        const drawW = Math.max(1, Math.round(region.width * scale));
        const drawH = Math.max(1, Math.round(region.height * scale));
        const resized = drawW === region.width && drawH === region.height
          ? region
          : resizeNearest(region, drawW, drawH);
        const cell = blank(cellW, cellH);
        paste(cell, resized, Math.floor((cellW - drawW) / 2), Math.floor((cellH - drawH) / 2));
        out.push({ row: r, col: c, cell, rawW, rawH, opaquePct: opaquePct(cell) });
      }
    }
    return out;
  }

  function backgroundResidualPct(image, backgroundRgb, threshold) {
    const limit = (threshold + 24) * (threshold + 24);
    let opaque = 0;
    let residual = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      if (image.data[index + 3] <= 16) continue;
      opaque += 1;
      if (colorDistanceSq(
        [image.data[index], image.data[index + 1], image.data[index + 2]],
        backgroundRgb,
      ) <= limit) residual += 1;
    }
    return opaque ? Math.round((residual * 1000) / opaque) / 10 : 0;
  }

  function componentImage(image, component) {
    const [x0, y0, x1, y1] = component.bbox;
    const out = blank(x1 - x0, y1 - y0);
    for (const pixel of component.pixels) {
      const sourceX = pixel % image.width;
      const sourceY = (pixel - sourceX) / image.width;
      const source = pixel * 4;
      const target = ((sourceY - y0) * out.width + (sourceX - x0)) * 4;
      out.data[target] = image.data[source];
      out.data[target + 1] = image.data[source + 1];
      out.data[target + 2] = image.data[source + 2];
      out.data[target + 3] = image.data[source + 3];
    }
    return out;
  }

  function gridSlots(cols, rows, sourceW, sourceH) {
    const slots = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        slots.push({
          row,
          col,
          centerX: (col + 0.5) * sourceW,
          centerY: (row + 0.5) * sourceH,
        });
      }
    }
    return slots;
  }

  function slotDistance(component, slot, sourceW, sourceH) {
    const dx = (component.cx - slot.centerX) / sourceW;
    const dy = (component.cy - slot.centerY) / sourceH;
    return dx * dx + dy * dy;
  }

  function assignComponentsToGrid(components, cols, rows, sourceW, sourceH) {
    const count = cols * rows;
    const primary = [...components].sort((a, b) => b.area - a.area).slice(0, count);
    if (primary.length < count) return null;

    const slots = gridSlots(cols, rows, sourceW, sourceH);
    const pairs = [];
    for (let componentIndex = 0; componentIndex < primary.length; componentIndex += 1) {
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        pairs.push({
          componentIndex,
          slotIndex,
          distance: slotDistance(primary[componentIndex], slots[slotIndex], sourceW, sourceH),
        });
      }
    }
    pairs.sort((a, b) => a.distance - b.distance);

    const bySlot = new Array(count).fill(null);
    const usedComponents = new Set();
    for (const pair of pairs) {
      if (bySlot[pair.slotIndex] || usedComponents.has(pair.componentIndex)) continue;
      bySlot[pair.slotIndex] = primary[pair.componentIndex];
      usedComponents.add(pair.componentIndex);
    }
    if (bySlot.some((component) => !component)) return null;

    const primarySet = new Set(primary);
    const extraAreaBySlot = new Array(count).fill(0);
    for (const component of components) {
      if (primarySet.has(component)) continue;
      let nearest = 0;
      let nearestDistance = Infinity;
      for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
        const distance = slotDistance(component, slots[slotIndex], sourceW, sourceH);
        if (distance < nearestDistance) {
          nearest = slotIndex;
          nearestDistance = distance;
        }
      }
      extraAreaBySlot[nearest] += component.area;
    }
    return { slots, bySlot, extraAreaBySlot };
  }

  function normalizeSafeBox(value, cellW, cellH) {
    const input = value && typeof value === "object" ? value : {};
    const x = Math.max(0, Math.min(cellW - 1, Number(input.x) || 0));
    const y = Math.max(0, Math.min(cellH - 1, Number(input.y) || 0));
    const width = Math.max(1, Math.min(cellW - x, Number(input.width) || cellW));
    const height = Math.max(1, Math.min(cellH - y, Number(input.height) || cellH));
    return { x, y, right: x + width, bottom: y + height };
  }

  function fitScaleAroundAnchor(sprite, anchor, desiredX, desiredY, initialScale, safeBox) {
    const limits = [initialScale];
    const extents = [
      [anchor.x, desiredX - safeBox.x],
      [sprite.width - 1 - anchor.x, safeBox.right - 1 - desiredX],
      [anchor.y, desiredY - safeBox.y],
      [sprite.height - 1 - anchor.y, safeBox.bottom - 1 - desiredY],
    ];
    for (const [extent, available] of extents) {
      if (extent > 0) limits.push(Math.max(0, available) / extent);
    }
    return Math.max(0.01, Math.min(...limits.filter(Number.isFinite)));
  }

  function extractGridStabilized(image, cols, rows, key, threshold, cellW, cellH, options = {}) {
    const adaptive = removeAdaptiveChroma(image, key, threshold);
    const sourceW = adaptive.image.width / cols;
    const sourceH = adaptive.image.height / rows;
    const allComponents = connectedComponents(adaptive.image).filter((component) => component.area >= 1);
    const assignment = assignComponentsToGrid(allComponents, cols, rows, sourceW, sourceH);
    const slots = gridSlots(cols, rows, sourceW, sourceH);
    const subjects = [];

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex];
      const region = crop(adaptive.image, [
        Math.round(slot.col * sourceW),
        Math.round(slot.row * sourceH),
        Math.round((slot.col + 1) * sourceW),
        Math.round((slot.row + 1) * sourceH),
      ]);
      const lineArtifact = detectLineArtifact(region);

      if (assignment) {
        const component = assignment.bySlot[slotIndex];
        const sprite = componentImage(adaptive.image, component);
        const localAnchor = estimateAnchor(sprite);
        const extraArea = assignment.extraAreaBySlot[slotIndex];
        subjects.push({
          ...slot,
          sprite,
          localAnchor,
          slotAnchor: localAnchor ? {
            x: component.bbox[0] + localAnchor.x - slot.col * sourceW,
            y: component.bbox[1] + localAnchor.y - slot.row * sourceH,
          } : null,
          rawW: sprite.width,
          rawH: sprite.height,
          lineArtifact,
          discardedPct: component.area + extraArea > 0
            ? Math.round((extraArea * 1000) / (component.area + extraArea)) / 10
            : 0,
        });
        continue;
      }

      const isolated = isolateLargestComponent(region);
      const bbox = contentBBox(isolated.image);
      const sprite = bbox ? crop(isolated.image, bbox) : blank(1, 1);
      const localAnchor = bbox ? estimateAnchor(sprite) : null;
      subjects.push({
        ...slot,
        sprite,
        localAnchor,
        slotAnchor: localAnchor ? { x: bbox[0] + localAnchor.x, y: bbox[1] + localAnchor.y } : null,
        rawW: bbox ? sprite.width : 0,
        rawH: bbox ? sprite.height : 0,
        lineArtifact,
        discardedPct: isolated.discardedPct,
      });
    }

    const validSlotAnchors = subjects.map((subject) => subject.slotAnchor).filter(Boolean);
    const medianX = median(validSlotAnchors.map((anchor) => anchor.x));
    const medianY = median(validSlotAnchors.map((anchor) => anchor.y));
    const targetX = Number.isFinite(Number(options.targetX))
      ? Number(options.targetX)
      : Math.round(cellW / 2);
    const targetY = Number.isFinite(Number(options.targetY))
      ? Number(options.targetY)
      : cellH - 1;
    const lockX = options.lockX !== false;
    const lockY = options.lockY !== false;
    const safeBox = normalizeSafeBox(options.safeBox, cellW, cellH);
    const sourceScale = Math.min(cellW / sourceW, cellH / sourceH);

    return subjects.map((subject) => {
      if (!subject.localAnchor || !subject.slotAnchor || subject.rawW <= 0 || subject.rawH <= 0) {
        const cell = blank(cellW, cellH);
        return {
          ...subject,
          cell,
          shiftX: 0,
          shiftY: 0,
          anchorX: null,
          anchorY: null,
          opaquePct: 0,
          edgeTouchPct: 0,
          backgroundResidualPct: 0,
          backgroundRgb: [...adaptive.backgroundRgb],
        };
      }

      const desiredX = Math.round(targetX + (lockX ? 0 : (subject.slotAnchor.x - medianX) * sourceScale));
      const desiredY = Math.round(targetY + (lockY ? 0 : (subject.slotAnchor.y - medianY) * sourceScale));
      const scale = fitScaleAroundAnchor(
        subject.sprite,
        subject.localAnchor,
        desiredX,
        desiredY,
        sourceScale,
        safeBox,
      );
      const drawW = Math.max(1, Math.round(subject.sprite.width * scale));
      const drawH = Math.max(1, Math.round(subject.sprite.height * scale));
      const resized = drawW === subject.sprite.width && drawH === subject.sprite.height
        ? subject.sprite
        : resizeNearest(subject.sprite, drawW, drawH);
      const resizedAnchor = estimateAnchor(resized);
      const shiftX = desiredX - resizedAnchor.x;
      const shiftY = desiredY - resizedAnchor.y;
      const cell = blank(cellW, cellH);
      paste(cell, resized, shiftX, shiftY);
      const stableAnchor = estimateAnchor(cell);
      return {
        row: subject.row,
        col: subject.col,
        cell,
        rawW: subject.rawW,
        rawH: subject.rawH,
        lineArtifact: subject.lineArtifact,
        discardedPct: subject.discardedPct,
        backgroundRgb: [...adaptive.backgroundRgb],
        shiftX,
        shiftY,
        anchorX: stableAnchor ? stableAnchor.x : null,
        anchorY: stableAnchor ? stableAnchor.y : null,
        opaquePct: opaquePct(cell),
        edgeTouchPct: edgeTouchPct(cell),
        backgroundResidualPct: backgroundResidualPct(cell, adaptive.backgroundRgb, threshold),
      };
    });
  }

  return {
    removeChroma,
    estimateBackgroundColor,
    chooseChromaKey,
    connectedComponents,
    contentBBox,
    crop,
    resizeNearest,
    fitToCell,
    opaquePct,
    extractGrid,
    extractGridPreservingScale,
    extractGridStabilized,
  };
});

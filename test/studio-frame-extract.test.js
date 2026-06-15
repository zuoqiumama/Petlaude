"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  removeChroma,
  connectedComponents,
  fitToCell,
  extractGrid,
  extractGridPreservingScale,
  extractGridStabilized,
  opaquePct,
  chooseChromaKey,
  estimateBackgroundColor,
} = require("../src/studio/frame-extract");

// Build an ImageData-like object from a w*h array of [r,g,b,a] pixels.
function img(width, height, fill = [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = fill[3];
  }
  return { data, width, height };
}
function setPx(im, x, y, [r, g, b, a]) {
  const i = (y * im.width + x) * 4;
  im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b; im.data[i + 3] = a;
}
function getA(im, x, y) { return im.data[(y * im.width + x) * 4 + 3]; }

function alphaBBox(im) {
  const xs = [];
  const ys = [];
  for (let y = 0; y < im.height; y += 1) {
    for (let x = 0; x < im.width; x += 1) {
      if (getA(im, x, y) > 16) { xs.push(x); ys.push(y); }
    }
  }
  if (!xs.length) return null;
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) + 1, Math.max(...ys) + 1];
}

describe("removeChroma", () => {
  it("zeroes alpha on pixels near the chroma key, keeps others", () => {
    const im = img(2, 1, [0, 255, 0, 255]); // both green opaque
    setPx(im, 1, 0, [220, 100, 90, 255]);   // pink
    const out = removeChroma(im, [0, 255, 0], 100);
    assert.strictEqual(getA(out, 0, 0), 0, "green removed");
    assert.strictEqual(getA(out, 1, 0), 255, "pink kept");
    // original untouched (immutability)
    assert.strictEqual(getA(im, 0, 0), 255);
  });
});

describe("chooseChromaKey", () => {
  it("avoids a key color already used heavily by the reference pet", () => {
    const im = img(4, 4, [0, 255, 0, 255]);
    const selected = chooseChromaKey(im, [
      [0, 255, 0],
      [255, 0, 255],
      [0, 255, 255],
    ], 100);
    assert.deepStrictEqual(selected, [255, 0, 255]);
  });
});

describe("connectedComponents", () => {
  it("finds separate blobs", () => {
    const im = img(5, 1);
    setPx(im, 0, 0, [255, 0, 0, 255]);
    setPx(im, 1, 0, [255, 0, 0, 255]);
    setPx(im, 4, 0, [255, 0, 0, 255]);
    const comps = connectedComponents(im);
    assert.strictEqual(comps.length, 2);
    const areas = comps.map((c) => c.area).sort();
    assert.deepStrictEqual(areas, [1, 2]);
  });
});

describe("fitToCell", () => {
  it("crops to content, centers in the cell, reports raw size", () => {
    const im = img(10, 10);
    // 2x2 opaque block at (4,4)
    for (const [x, y] of [[4, 4], [5, 4], [4, 5], [5, 5]]) setPx(im, x, y, [10, 20, 30, 255]);
    const { cell, rawW, rawH } = fitToCell(im, 8, 8, 2);
    assert.strictEqual(rawW, 2);
    assert.strictEqual(rawH, 2);
    assert.strictEqual(cell.width, 8);
    assert.strictEqual(cell.height, 8);
    // content should be centered (some opaque pixels near the middle)
    assert.ok(opaquePct(cell) > 0, "cell has content");
  });

  it("returns a blank cell when the image is empty", () => {
    const { cell, rawW, rawH } = fitToCell(img(6, 6), 8, 8);
    assert.strictEqual(rawW, 0);
    assert.strictEqual(rawH, 0);
    assert.strictEqual(opaquePct(cell), 0);
  });
});

describe("extractGrid", () => {
  it("extracts cols*rows cells row-major from a chroma strip", () => {
    // 8x4 image, green background, a colored blob in each of 2 horizontal slots
    const im = img(8, 4, [0, 255, 0, 255]);
    setPx(im, 1, 1, [200, 50, 50, 255]); setPx(im, 2, 1, [200, 50, 50, 255]);
    setPx(im, 5, 2, [50, 50, 200, 255]); setPx(im, 6, 2, [50, 50, 200, 255]);
    const cells = extractGrid(im, 2, 1, [0, 255, 0], 100, 16, 16);
    assert.strictEqual(cells.length, 2);
    assert.strictEqual(cells[0].col, 0);
    assert.strictEqual(cells[1].col, 1);
    assert.ok(cells[0].rawW >= 1 && cells[0].rawH >= 1);
    assert.ok(opaquePct(cells[0].cell) > 0 && opaquePct(cells[1].cell) > 0);
  });

  it("preserves each pose's position and common source scale inside grid slots", () => {
    const im = img(8, 4, [0, 255, 0, 255]);
    setPx(im, 1, 1, [200, 50, 50, 255]);
    setPx(im, 6, 2, [50, 50, 200, 255]);

    const cells = extractGridPreservingScale(im, 2, 1, [0, 255, 0], 100, 4, 4);

    assert.strictEqual(getA(cells[0].cell, 1, 1), 255, "first pose keeps its slot-local anchor");
    assert.strictEqual(getA(cells[1].cell, 2, 2), 255, "second pose keeps its slot-local anchor");
  });

  it("extracts complete poses when the model crosses a guide boundary", () => {
    const im = img(12, 6, [0, 255, 0, 255]);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) setPx(im, x, y, [200, 50, 50, 255]);
      for (let x = 5; x <= 9; x += 1) setPx(im, x, y, [50, 50, 200, 255]);
    }

    const cells = extractGridPreservingScale(im, 2, 1, [0, 255, 0], 100, 12, 6);

    assert.deepStrictEqual(cells.map((cell) => cell.rawW), [3, 5]);
    assert.strictEqual(connectedComponents(cells[0].cell).length, 1, "frame 1 contains only its complete pose");
    assert.strictEqual(connectedComponents(cells[1].cell).length, 1, "frame 2 contains only its complete pose");
  });
});

describe("extractGridStabilized", () => {
  it("removes a shifted green background that fixed-distance keying leaves behind", () => {
    const bg = [112, 226, 12, 255];
    const im = img(8, 8, bg);
    for (let y = 2; y <= 5; y += 1) {
      for (let x = 2; x <= 5; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
    }

    const [frame] = extractGridStabilized(im, 1, 1, [0, 255, 0], 100, 8, 8);

    assert.strictEqual(getA(frame.cell, 0, 0), 0, "detected background becomes transparent");
    assert.ok(opaquePct(frame.cell) > 0, "subject remains visible");
    assert.deepStrictEqual(frame.backgroundRgb, [112, 226, 12]);
  });

  it("isolates the largest subject and reports copied guide lines for quality rejection", () => {
    const im = img(12, 12, [0, 255, 0, 255]);
    for (let y = 3; y <= 9; y += 1) {
      for (let x = 4; x <= 8; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
    }
    for (let x = 0; x < 12; x += 1) setPx(im, x, 1, [10, 10, 10, 255]);

    const [frame] = extractGridStabilized(im, 1, 1, [0, 255, 0], 100, 12, 12);

    assert.strictEqual(frame.lineArtifact, true);
    assert.deepStrictEqual(alphaBBox(frame.cell), [4, 5, 9, 12]);
    assert.ok(frame.discardedPct > 0, "detached guide component was discarded");
  });

  it("normalizes subject anchors across frames without rescaling them", () => {
    const im = img(16, 8, [0, 255, 0, 255]);
    for (let y = 2; y <= 6; y += 1) {
      for (let x = 1; x <= 3; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
      for (let x = 12; x <= 14; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
    }

    const frames = extractGridStabilized(
      im, 2, 1, [0, 255, 0], 100, 8, 8,
      { lockX: true, lockY: true },
    );

    assert.strictEqual(frames.length, 2);
    assert.deepStrictEqual(alphaBBox(frames[0].cell), alphaBBox(frames[1].cell));
    assert.strictEqual(frames[0].anchorX, frames[1].anchorX);
    assert.strictEqual(frames[0].anchorY, frames[1].anchorY);
  });

  it("places the stabilized group on the requested output center and baseline", () => {
    const im = img(16, 8, [0, 255, 0, 255]);
    for (let y = 2; y <= 6; y += 1) {
      for (let x = 1; x <= 3; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
      for (let x = 12; x <= 14; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
    }

    const frames = extractGridStabilized(
      im, 2, 1, [0, 255, 0], 100, 8, 8,
      { lockX: true, lockY: true, targetX: 5, targetY: 7 },
    );

    assert.deepStrictEqual(frames.map((frame) => frame.anchorX), [5, 5]);
    assert.deepStrictEqual(frames.map((frame) => frame.anchorY), [7, 7]);
  });

  it("recovers a complete subject that crosses a horizontal grid boundary", () => {
    const im = img(10, 10, [0, 255, 0, 255]);
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
    }
    for (let y = 4; y <= 9; y += 1) {
      for (let x = 6; x <= 8; x += 1) setPx(im, x, y, [50, 50, 220, 255]);
    }

    const frames = extractGridStabilized(
      im, 1, 2, [0, 255, 0], 100, 10, 10,
      { lockX: true, lockY: true, targetX: 5, targetY: 9 },
    );

    assert.deepStrictEqual(frames.map((frame) => frame.rawH), [3, 6]);
    const bottomBox = alphaBBox(frames[1].cell);
    assert.strictEqual(bottomBox[3] - bottomBox[1], 6, "the crossed head remains attached");
  });

  it("preserves subject proportions when generated grid cells are rectangular", () => {
    const im = img(12, 8, [0, 255, 0, 255]);
    for (let y = 2; y <= 5; y += 1) {
      for (let x = 2; x <= 3; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
      for (let x = 8; x <= 9; x += 1) setPx(im, x, y, [50, 50, 220, 255]);
    }

    const frames = extractGridStabilized(
      im, 2, 1, [0, 255, 0], 100, 8, 8,
      { lockX: true, lockY: true, targetX: 4, targetY: 7 },
    );

    for (const frame of frames) {
      const box = alphaBBox(frame.cell);
      assert.strictEqual(box[2] - box[0], 2, "the 6px source slot is not stretched to 8px");
      assert.strictEqual(box[3] - box[1], 4);
    }
  });
});

describe("estimateBackgroundColor", () => {
  it("detects the model's actual near-chroma border color", () => {
    const im = img(8, 8, [112, 226, 12, 255]);
    for (let y = 2; y <= 5; y += 1) {
      for (let x = 2; x <= 5; x += 1) setPx(im, x, y, [220, 90, 40, 255]);
    }
    const detected = estimateBackgroundColor(im, [0, 255, 0]);
    assert.ok(Math.abs(detected[0] - 112) <= 8);
    assert.ok(Math.abs(detected[1] - 226) <= 8);
    assert.ok(Math.abs(detected[2] - 12) <= 8);
  });
});

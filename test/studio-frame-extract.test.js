"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  removeChroma,
  connectedComponents,
  fitToCell,
  extractGrid,
  opaquePct,
  chooseChromaKey,
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
});

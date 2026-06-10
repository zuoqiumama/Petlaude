"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { computeGuideRects } = require("../src/studio/layout-guide");

describe("computeGuideRects", () => {
  it("produces cols*rows row-major cells with safe areas and centers", () => {
    const rects = computeGuideRects(2, 2, 512, 512, 26, 26);
    assert.strictEqual(rects.length, 4);

    assert.deepStrictEqual(rects[0].cell, { x: 0, y: 0, w: 512, h: 512 });
    assert.deepStrictEqual(rects[0].safe, { x: 26, y: 26, w: 460, h: 460 });
    assert.deepStrictEqual(rects[0].center, { x: 256, y: 256 });

    // row-major: index 1 is top-right
    assert.strictEqual(rects[1].cell.x, 512);
    assert.strictEqual(rects[1].cell.y, 0);
    // index 2 bottom-left, index 3 bottom-right
    assert.strictEqual(rects[2].cell.x, 0);
    assert.strictEqual(rects[2].cell.y, 512);
    assert.strictEqual(rects[3].cell.x, 512);
    assert.strictEqual(rects[3].cell.y, 512);
  });

  it("supports single-row strips", () => {
    const rects = computeGuideRects(3, 1, 400, 400, 20, 20);
    assert.strictEqual(rects.length, 3);
    assert.strictEqual(rects[2].cell.x, 800);
    assert.strictEqual(rects[2].center.x, 800 + 200);
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { assembleAnimatedSvg, buildSequence } = require("../src/studio/svg-assemble");

const frames = [
  "data:image/png;base64,AAAA",
  "data:image/png;base64,BBBB",
  "data:image/png;base64,CCCC",
];

function styleBlock(svg) {
  const m = svg.match(/<style>([\s\S]*?)<\/style>/);
  return m ? m[1] : "";
}

describe("buildSequence", () => {
  it("once/loop is linear", () => {
    assert.deepStrictEqual(buildSequence(3, "once"), [0, 1, 2]);
    assert.deepStrictEqual(buildSequence(3, "loop"), [0, 1, 2]);
  });
  it("pingpong reflects without repeating endpoints", () => {
    assert.deepStrictEqual(buildSequence(3, "pingpong"), [0, 1, 2, 1]);
    assert.deepStrictEqual(buildSequence(2, "pingpong"), [0, 1]);
  });
});

describe("assembleAnimatedSvg", () => {
  const svg = assembleAnimatedSvg({
    frames,
    anim: { totalMs: 3200, loop: "once", hold: { 2: 1.6 } },
    viewBox: { x: 0, y: 0, width: 512, height: 512 },
  });

  it("has exactly one <image> per frame", () => {
    assert.strictEqual((svg.match(/<image\b/g) || []).length, frames.length);
  });

  it("has exactly one @keyframes per frame layer", () => {
    assert.strictEqual((svg.match(/@keyframes f\d/g) || []).length, frames.length);
  });

  it("never emits a double closing brace (regression guard for the }} bug)", () => {
    assert.ok(!/}}/.test(styleBlock(svg)), "style block must not contain }}");
  });

  it("references every frame data URL", () => {
    for (const f of frames) assert.ok(svg.includes(f), `missing ${f}`);
  });

  it("encodes the total duration", () => {
    assert.ok(svg.includes("3200ms"), "totalMs not encoded");
  });

  it("uses step-end for discrete frames and pixelated rendering", () => {
    assert.ok(/step-end/.test(svg));
    assert.ok(/pixelated/.test(svg));
  });

  it("sets the viewBox", () => {
    assert.ok(svg.includes('viewBox="0 0 512 512"'));
  });
});

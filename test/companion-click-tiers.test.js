"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { resolveClickReaction, resolveDragEndReaction } = require("../src/companion/click-tiers");

const reactions = {
  clickLeft: { file: "left.svg", duration: 2500 },
  clickRight: { file: "right.svg", duration: 2500 },
  annoyed: { file: "annoyed.svg", duration: 3500 },
  double: { files: ["d1.svg", "d2.svg"], duration: 3500 },
  rapidClick: { file: "dizzy.svg", duration: 2500 },
  dragRelease: { file: "shake.svg", duration: 2000 },
};

describe("resolveClickReaction tiers", () => {
  it("returns null below 2 clicks", () => {
    assert.strictEqual(resolveClickReaction(1, reactions), null);
    assert.strictEqual(resolveClickReaction(0, reactions), null);
  });

  it("2 clicks → annoyed (rng<0.5) or side by direction", () => {
    assert.strictEqual(resolveClickReaction(2, reactions, () => 0.1).file, "annoyed.svg");
    assert.strictEqual(resolveClickReaction(2, reactions, () => 0.9, "left").file, "left.svg");
    assert.strictEqual(resolveClickReaction(2, reactions, () => 0.9, "right").file, "right.svg");
  });

  it("4 clicks → double (from files)", () => {
    const r = resolveClickReaction(4, reactions, () => 0.0);
    assert.strictEqual(r.file, "d1.svg");
    assert.strictEqual(r.duration, 3500);
  });

  it("6 clicks → rapidClick (dizzy)", () => {
    const r = resolveClickReaction(6, reactions, () => 0.0);
    assert.strictEqual(r.file, "dizzy.svg");
    assert.strictEqual(r.duration, 2500);
  });

  it("6 clicks falls back to double when rapidClick absent", () => {
    const noRapid = { ...reactions, rapidClick: undefined };
    assert.strictEqual(resolveClickReaction(6, noRapid, () => 0.0).file, "d1.svg");
  });

  it("returns null when no reaction is configured for the tier", () => {
    assert.strictEqual(resolveClickReaction(2, { clickLeft: undefined }, () => 0.9), null);
  });
});

describe("resolveDragEndReaction", () => {
  it("returns the dragRelease descriptor when present", () => {
    assert.deepStrictEqual(resolveDragEndReaction(reactions), { file: "shake.svg", duration: 2000 });
  });
  it("returns null when absent", () => {
    assert.strictEqual(resolveDragEndReaction({}), null);
    assert.strictEqual(resolveDragEndReaction(null), null);
  });
});

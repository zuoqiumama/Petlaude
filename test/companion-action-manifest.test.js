"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  ACTIONS,
  CATEGORIES,
  CHROMA,
  getAction,
  listByCategory,
  buildPrompt,
} = require("../src/companion/action-manifest");

describe("action-manifest contract", () => {
  it("every action has the required contract fields", () => {
    for (const a of ACTIONS) {
      assert.ok(a.id && typeof a.id === "string", `id for ${JSON.stringify(a)}`);
      assert.ok(CATEGORIES.includes(a.category), `category for ${a.id}`);
      assert.ok(
        Number.isInteger(a.frames) && a.frames >= 2 && a.frames <= 9,
        `frames for ${a.id}`,
      );
      assert.ok(a.grid && a.grid.cols >= 1 && a.grid.rows >= 1, `grid for ${a.id}`);
      assert.ok(
        a.grid.cols * a.grid.rows >= a.frames,
        `grid fits frames for ${a.id}`,
      );
      assert.ok(
        Array.isArray(a.posePrompts) && a.posePrompts.length === a.frames,
        `posePrompts length for ${a.id}`,
      );
      assert.ok(a.anim && a.anim.totalMs > 0, `anim.totalMs for ${a.id}`);
    }
  });

  it("ids are unique", () => {
    assert.strictEqual(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length);
  });

  it("covers all three categories with the expected actions", () => {
    assert.ok(listByCategory("idle-life").length >= 6, "idle-life count");
    assert.ok(listByCategory("context").length >= 6, "context count");
    assert.ok(listByCategory("touch").length >= 2, "touch count");
  });

  it("getAction looks up by id and returns null for unknown", () => {
    assert.strictEqual(getAction("yawn").category, "idle-life");
    assert.strictEqual(getAction("error-comfort").category, "context");
    assert.strictEqual(getAction("nope-not-real"), null);
  });

  it("idle-life behaviors carry trigger weight/idleMinMs (except hover ones)", () => {
    for (const a of listByCategory("idle-life")) {
      assert.ok(a.trigger, `trigger for ${a.id}`);
      if (!a.trigger.hover) {
        assert.ok(
          Number.isFinite(a.trigger.idleMinMs) && a.trigger.idleMinMs >= 0,
          `idleMinMs for ${a.id}`,
        );
        assert.ok(a.trigger.weight > 0, `weight for ${a.id}`);
      }
    }
  });

  it("context actions carry a typed trigger", () => {
    const types = new Set(listByCategory("context").map((a) => a.trigger && a.trigger.type));
    for (const t of ["errorStreak", "smoothWork", "sessionEnd", "firstSession", "breakReminder", "tokenMilestone"]) {
      assert.ok(types.has(t), `context trigger type ${t} present`);
    }
  });

  it("touch actions map to a reaction key", () => {
    const reactions = new Set(listByCategory("touch").map((a) => a.trigger && a.trigger.reaction));
    assert.ok(reactions.has("rapidClick"), "rapidClick");
    assert.ok(reactions.has("dragRelease"), "dragRelease");
  });
});

describe("buildPrompt", () => {
  it("fills the scaffold with grid, chroma, poses, and the size-lock sentence", () => {
    const prompt = buildPrompt(getAction("yawn"));
    assert.match(prompt, /2x2/, "grid shape");
    assert.ok(prompt.includes(CHROMA), "chroma hex");
    assert.match(prompt, /SAME SIZE/, "size-lock language");
    for (const pose of getAction("yawn").posePrompts) {
      assert.ok(prompt.includes(pose), `includes pose: ${pose.slice(0, 20)}`);
    }
  });

  it("accepts a chroma override", () => {
    const prompt = buildPrompt(getAction("yawn"), "#FF00FF");
    assert.ok(prompt.includes("#FF00FF"), "override chroma");
    assert.ok(!prompt.includes("#00FF00"), "no default chroma when overridden");
  });

  it("keeps props attached and explicitly leaves unused grid cells blank", () => {
    const prompt = buildPrompt(getAction("smooth-thumbsup"));
    assert.match(prompt, /remaining grid cell/i);
    assert.match(prompt, /single connected silhouette/i);
    assert.doesNotMatch(prompt, /sparkle near/i);
    assert.deepStrictEqual(getAction("smooth-thumbsup").grid, { cols: 2, rows: 2 });
  });
});

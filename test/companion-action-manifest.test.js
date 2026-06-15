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
  expandPosePrompts,
} = require("../src/companion/action-manifest");

describe("action-manifest contract", () => {
  it("every action has the required contract fields", () => {
    assert.strictEqual(ACTIONS.length, 33, "audited Studio action count");
    for (const a of ACTIONS) {
      assert.ok(a.id && typeof a.id === "string", `id for ${JSON.stringify(a)}`);
      assert.ok(CATEGORIES.includes(a.category), `category for ${a.id}`);
      assert.ok(
        Number.isInteger(a.frames) && a.frames >= 6 && a.frames <= 8,
        `frames for ${a.id}`,
      );
      assert.ok(a.grid && a.grid.cols >= 1 && a.grid.rows >= 1, `grid for ${a.id}`);
      assert.ok(
        a.grid.cols * a.grid.rows === a.frames,
        `grid fits frames for ${a.id}`,
      );
      assert.ok(
        Array.isArray(a.keyPosePrompts) && a.keyPosePrompts.length >= 2,
        `authored key poses for ${a.id}`,
      );
      assert.ok(
        Array.isArray(a.posePrompts) && a.posePrompts.length === a.frames,
        `posePrompts length for ${a.id}`,
      );
      assert.ok(
        a.posePrompts.every((pose) => typeof pose === "string" && pose.trim().length >= 12),
        `non-empty detailed pose prompts for ${a.id}`,
      );
      for (const keyPose of a.keyPosePrompts) {
        assert.ok(a.posePrompts.includes(keyPose), `generated frames preserve key pose for ${a.id}`);
      }
      assert.ok(a.anim && a.anim.totalMs > 0, `anim.totalMs for ${a.id}`);
    }
  });

  it("ids are unique", () => {
    assert.strictEqual(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length);
  });

  it("covers every category with the expected actions", () => {
    assert.ok(listByCategory("core").length >= 6, "core count");
    assert.ok(listByCategory("sleep").length >= 4, "sleep count");
    assert.ok(listByCategory("mini").length >= 8, "mini count");
    assert.ok(listByCategory("idle-life").length >= 6, "idle-life count");
    assert.ok(listByCategory("context").length >= 6, "context count");
    assert.ok(listByCategory("touch").length >= 2, "touch count");
  });

  it("sleep actions cover the full wind-down sequence and bind theme states", () => {
    const boundStates = new Set();
    for (const a of listByCategory("sleep")) {
      assert.ok(a.trigger && Array.isArray(a.trigger.states) && a.trigger.states.length > 0,
        `trigger.states for ${a.id}`);
      for (const s of a.trigger.states) boundStates.add(s);
    }
    for (const s of ["yawning", "dozing", "collapsing", "waking"]) {
      assert.ok(boundStates.has(s), `sleep actions bind states.${s}`);
    }
  });

  it("mini actions bind a miniMode state and cover the required peek set", () => {
    const boundMini = new Set();
    for (const a of listByCategory("mini")) {
      assert.ok(a.trigger && typeof a.trigger.miniState === "string" && a.trigger.miniState,
        `trigger.miniState for ${a.id}`);
      assert.strictEqual(a.id, a.trigger.miniState, `mini id matches its state slot for ${a.id}`);
      boundMini.add(a.trigger.miniState);
    }
    // The eight states the validator requires before miniMode.supported may turn on.
    for (const s of [
      "mini-idle", "mini-enter", "mini-enter-sleep", "mini-crabwalk",
      "mini-peek", "mini-alert", "mini-happy", "mini-sleep",
    ]) {
      assert.ok(boundMini.has(s), `mini actions cover ${s}`);
    }
  });

  it("core actions cover the pet's everyday states and loop forever", () => {
    const boundStates = new Set();
    for (const a of listByCategory("core")) {
      assert.ok(a.trigger && Array.isArray(a.trigger.states) && a.trigger.states.length > 0,
        `trigger.states for ${a.id}`);
      assert.strictEqual(a.anim.loop, "loop", `core action ${a.id} must loop`);
      for (const s of a.trigger.states) boundStates.add(s);
    }
    // Required theme states plus the high-traffic optional ones a Studio pet
    // must animate to be a complete replacement for a built-in pet.
    for (const s of ["idle", "working", "thinking", "sleeping", "error", "notification"]) {
      assert.ok(boundStates.has(s), `core actions bind states.${s}`);
    }
  });

  it("core actions are listed first so generate-all yields a usable pet early", () => {
    const firstNonCore = ACTIONS.findIndex((a) => a.category !== "core");
    const lastCore = ACTIONS.map((a) => a.category).lastIndexOf("core");
    assert.ok(lastCore < firstNonCore, "all core actions precede other categories");
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
    assert.match(prompt, /4x2/, "grid shape");
    assert.ok(prompt.includes(CHROMA), "chroma hex");
    assert.match(prompt, /SAME SIZE/, "size-lock language");
    for (const pose of getAction("yawn").posePrompts) {
      assert.ok(prompt.includes(pose), `includes pose: ${pose.slice(0, 20)}`);
    }
  });

  it("builds a complete fixed prompt for every audited action", () => {
    for (const action of ACTIONS) {
      const prompt = buildPrompt(action);
      assert.match(prompt, new RegExp(`exactly ${action.frames} animation frames`, "i"), action.id);
      assert.match(prompt, /authoritative character identity reference/i, action.id);
      assert.match(prompt, /distinctive markings/i, action.id);
      assert.match(prompt, /head-to-body ratio/i, action.id);
      assert.match(prompt, /do not zoom, rescale, enlarge, or shrink/i, action.id);
      assert.match(prompt, /natural pose changes may change the outer silhouette/i, action.id);
      for (const pose of action.posePrompts) {
        assert.ok(prompt.includes(pose), `${action.id} prompt includes every pose`);
      }
    }
  });

  it("avoids effect-like wording that conflicts with the no-floating-effects contract", () => {
    assert.doesNotMatch(getAction("thinking").posePrompts.join(" "), /\bspark\b/i);
    assert.match(getAction("shake-off").posePrompts[0], /same character|preserving/i);
  });

  it("keeps mini-enter as an upright whole-character slide instead of a frog-like jump", () => {
    const action = getAction("mini-enter");
    const prompt = buildPrompt(action);
    assert.strictEqual(action.anim.loop, "once");
    assert.strictEqual(action.keyPosePrompts.length, 3);
    assert.match(prompt, /entire unchanged character.*horizontal/i);
    assert.match(prompt, /feet.*below the torso.*same ground line/i);
    assert.match(prompt, /do not crouch, crawl, lie belly-down, hop, jump, flatten, elongate, or stretch/i);
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
    assert.deepStrictEqual(getAction("smooth-thumbsup").grid, { cols: 3, rows: 2 });
  });

  it("expands authored key poses into explicit smooth in-between frames", () => {
    const yawn = getAction("yawn");
    assert.strictEqual(yawn.frames, 8);
    assert.deepStrictEqual(yawn.grid, { cols: 4, rows: 2 });
    assert.strictEqual(yawn.keyPosePrompts.length, 4);
    assert.ok(yawn.posePrompts.some((pose) => /in-between/i.test(pose)));
    const heldFrame = Number(Object.keys(yawn.anim.hold)[0]);
    assert.strictEqual(yawn.posePrompts[heldFrame], yawn.keyPosePrompts[2]);

    const wave = getAction("bye-wave");
    assert.strictEqual(wave.frames, 6);
    assert.deepStrictEqual(wave.grid, { cols: 3, rows: 2 });
    assert.strictEqual(wave.keyPosePrompts.length, 2);
  });

  it("samples loop transitions cyclically and once transitions through the final key pose", () => {
    const looped = expandPosePrompts(["pose alpha", "pose beta"], 6, "loop");
    assert.strictEqual(looped.length, 6);
    assert.match(looped[5], /pose beta.*pose alpha/i);

    const once = expandPosePrompts(["pose alpha", "pose beta"], 6, "once");
    assert.strictEqual(once[0], "pose alpha");
    assert.strictEqual(once[5], "pose beta");
  });

  it("adds a stricter correction block for automatic retries", () => {
    const prompt = buildPrompt(getAction("yawn"), CHROMA, { attempt: 2 });
    assert.match(prompt, /automatic quality validation/i);
    assert.match(prompt, /body anchor/i);
    assert.match(prompt, /no guide lines/i);
  });
});

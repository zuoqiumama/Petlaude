"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createIdleLifeScheduler,
  normalizeBehaviors,
  computeWanderTarget,
  maybePlayIdleLife,
  cancelIdleLife,
} = require("../src/companion/idle-life");

function fakeCtx(overrides = {}) {
  const sends = [];
  const timers = [];
  return {
    currentState: "idle",
    doNotDisturb: false,
    miniMode: false,
    svgIdleFollow: "idle-follow.svg",
    forceEyeResend: false,
    sends,
    timers,
    sendToRenderer: (...a) => sends.push(a),
    sendToHitWin: () => {},
    setTimeout: (fn, ms) => { const id = { fn, ms }; timers.push(id); return id; },
    clearTimeout: (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
    ...overrides,
  };
}

function oneShotScheduler(behavior) {
  let used = false;
  return { pick: () => (used ? null : ((used = true), behavior)), reset: () => { used = false; } };
}

describe("idle-life scheduler", () => {
  function fixture() {
    let t = 0;
    const sched = createIdleLifeScheduler({
      behaviors: [
        { id: "yawn", file: "yawn.svg", idleMinMs: 120000, weight: 1, durationMs: 3200 },
        { id: "nap", file: "nap.svg", idleMinMs: 120000, weight: 1, durationMs: 4000, hourRange: [23, 6] },
      ],
      now: () => t,
      random: () => 0.1,
      hour: () => 2,
      cooldownMs: 30000,
    });
    return { sched, setT: (v) => { t = v; } };
  }

  it("returns null before the smallest idleMinMs", () => {
    const { sched } = fixture();
    assert.strictEqual(sched.pick(60000), null);
  });

  it("returns an eligible behavior once idleMinMs is met", () => {
    const { sched } = fixture();
    const p = sched.pick(130000);
    assert.ok(p && p.id, "expected a behavior");
    assert.ok(["yawn", "nap"].includes(p.id));
  });

  it("respects cooldown after a pick", () => {
    const { sched, setT } = fixture();
    assert.ok(sched.pick(130000), "first pick");
    assert.strictEqual(sched.pick(130000), null, "blocked by cooldown");
    setT(200000);
    assert.ok(sched.pick(330000), "cooldown expired");
  });

  it("respects hourRange wrap [23,6] — nap eligible at 2am, not at noon", () => {
    let t = 0;
    const atHour = (h) => createIdleLifeScheduler({
      behaviors: [{ id: "nap", file: "nap.svg", idleMinMs: 1000, weight: 1, durationMs: 4000, hourRange: [23, 6] }],
      now: () => t, random: () => 0.1, hour: () => h, cooldownMs: 0,
    });
    assert.ok(atHour(2).pick(2000), "2am eligible");
    assert.ok(atHour(23).pick(2000), "23 eligible");
    assert.strictEqual(atHour(12).pick(2000), null, "noon not eligible");
  });

  it("excludes hover-only behaviors from the random picker", () => {
    let t = 0;
    const sched = createIdleLifeScheduler({
      behaviors: [{ id: "curious", file: "c.svg", idleMinMs: 0, weight: 1, hover: true }],
      now: () => t, random: () => 0.1, hour: () => 12, cooldownMs: 0,
    });
    assert.strictEqual(sched.pick(999999), null, "hover-only never picked randomly");
  });
});

describe("normalizeBehaviors", () => {
  it("flattens theme idleLife behaviors (trigger nested) to scheduler shape", () => {
    const out = normalizeBehaviors([
      { id: "yawn", file: "yawn.svg", duration: 3200, trigger: { idleMinMs: 120000, weight: 0.3, hourRange: [23, 6] } },
      { id: "curious", file: "c.svg", duration: 2000, trigger: { hover: true } },
    ]);
    assert.strictEqual(out[0].idleMinMs, 120000);
    assert.strictEqual(out[0].weight, 0.3);
    assert.deepStrictEqual(out[0].hourRange, [23, 6]);
    assert.strictEqual(out[0].durationMs, 3200);
    assert.strictEqual(out[1].hover, true);
  });

  it("carries windowMove from the behavior or its anim", () => {
    const out = normalizeBehaviors([
      { id: "wander", file: "w.svg", duration: 2500, windowMove: { dxRange: [50, 80] }, trigger: {} },
      { id: "wander2", file: "w2.svg", duration: 2500, anim: { windowMove: { dxRange: [10, 20] } }, trigger: {} },
    ]);
    assert.deepStrictEqual(out[0].windowMove, { dxRange: [50, 80] });
    assert.deepStrictEqual(out[1].windowMove, { dxRange: [10, 20] });
  });
});

describe("maybePlayIdleLife windowMove", () => {
  it("calls ctx.moveWindowBy with a signed magnitude inside dxRange", () => {
    const moves = [];
    const ctx = fakeCtx({ moveWindowBy: (dx) => moves.push(dx), random: () => 0.5 });
    const behavior = { id: "wander", file: "w.svg", durationMs: 2500, windowMove: { dxRange: [50, 80] } };
    maybePlayIdleLife(ctx, 130000, { pick: () => behavior });
    assert.strictEqual(moves.length, 1);
    assert.strictEqual(Math.abs(moves[0]), 65); // 50 + (80-50)*0.5
  });
});

describe("maybePlayIdleLife", () => {
  const behavior = { id: "yawn", file: "yawn.svg", durationMs: 3200 };

  it("plays the behavior svg via the idle state-change path and arms a return", () => {
    const ctx = fakeCtx();
    const played = maybePlayIdleLife(ctx, 130000, oneShotScheduler(behavior));
    assert.strictEqual(played.id, "yawn");
    assert.deepStrictEqual(ctx.sends[0], ["state-change", "idle", "yawn.svg"]);
    assert.strictEqual(ctx.timers.length, 1, "return timer armed");
    assert.strictEqual(ctx.timers[0].ms, 3200);
    // fire the return timer
    ctx.timers[0].fn();
    assert.deepStrictEqual(ctx.sends.at(-1), ["state-change", "idle", "idle-follow.svg"]);
    assert.strictEqual(ctx.forceEyeResend, true);
  });

  it("does nothing when DND, mini, or not idle", () => {
    assert.strictEqual(maybePlayIdleLife(fakeCtx({ doNotDisturb: true }), 130000, oneShotScheduler(behavior)), null);
    assert.strictEqual(maybePlayIdleLife(fakeCtx({ miniMode: true }), 130000, oneShotScheduler(behavior)), null);
    assert.strictEqual(maybePlayIdleLife(fakeCtx({ currentState: "working" }), 130000, oneShotScheduler(behavior)), null);
  });

  it("will not start a second behavior while one is active", () => {
    const ctx = fakeCtx();
    assert.ok(maybePlayIdleLife(ctx, 130000, { pick: () => behavior }));
    assert.strictEqual(maybePlayIdleLife(ctx, 130000, { pick: () => behavior }), null);
  });

  it("cancelIdleLife clears the timer and restores idle-follow", () => {
    const ctx = fakeCtx();
    maybePlayIdleLife(ctx, 130000, oneShotScheduler(behavior));
    cancelIdleLife(ctx);
    assert.strictEqual(ctx._idleLifeActive, false);
    assert.strictEqual(ctx.timers.length, 0, "timer cleared");
    assert.deepStrictEqual(ctx.sends.at(-1), ["state-change", "idle", "idle-follow.svg"]);
  });
});

describe("computeWanderTarget", () => {
  const wa = { x: 0, y: 0, width: 1000, height: 800 };
  it("clamps within the work area", () => {
    assert.strictEqual(computeWanderTarget({ x: 980, y: 100, width: 60, height: 60 }, wa, 80).x, 940);
    assert.strictEqual(computeWanderTarget({ x: 5, y: 100, width: 60, height: 60 }, wa, -80).x, 0);
  });
  it("moves by dx when within bounds", () => {
    assert.strictEqual(computeWanderTarget({ x: 400, y: 100, width: 60, height: 60 }, wa, 70).x, 470);
  });
});

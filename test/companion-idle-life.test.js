"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createIdleLifeScheduler,
  normalizeBehaviors,
  computeWanderTarget,
} = require("../src/companion/idle-life");

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

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createContextReactionEngine } = require("../src/companion/context-reactions");

const MIN = 60000;

function makeEngine(startAt = 0) {
  let t = startAt;
  const engine = createContextReactionEngine({ now: () => t });
  return { engine, advance: (ms) => { t += ms; }, setT: (v) => { t = v; } };
}

// Feed a transition into `state` (preceded by a different state so it counts
// as a distinct entry, mirroring how the runtime feeds dominant-state changes).
function enterState(engine, state) {
  engine.onSessionEvent({ type: "state", state: "idle" });
  engine.onSessionEvent({ type: "state", state });
}

describe("context-reactions: error streak", () => {
  it("fires error-comfort after 3 errors within the window, then respects cooldown", () => {
    const { engine, advance } = makeEngine(10 * 24 * 60 * 60 * 1000); // arbitrary day
    enterState(engine, "error");
    advance(MIN); enterState(engine, "error");
    advance(MIN); enterState(engine, "error");
    engine.onSessionEvent({ type: "state", state: "idle" });
    assert.deepStrictEqual(engine.takePending(), { actionId: "error-comfort" });
    // more errors immediately ⇒ blocked by cooldown
    advance(MIN); enterState(engine, "error");
    advance(MIN); enterState(engine, "error");
    advance(MIN); enterState(engine, "error");
    engine.onSessionEvent({ type: "state", state: "idle" });
    assert.strictEqual(engine.takePending(), null);
  });

  it("does not fire with only 2 errors in the window", () => {
    const { engine, advance } = makeEngine();
    enterState(engine, "error");
    advance(MIN); enterState(engine, "error");
    engine.onSessionEvent({ type: "state", state: "idle" });
    assert.strictEqual(engine.takePending(), null);
  });
});

describe("context-reactions: smooth work", () => {
  it("fires smooth-thumbsup after 30min continuous work with no errors", () => {
    const { engine, advance } = makeEngine();
    engine.onSessionEvent({ type: "state", state: "working" });
    advance(30 * MIN);
    assert.deepStrictEqual(engine.takePending(), { actionId: "smooth-thumbsup" });
  });

  it("an error resets the smooth-work streak", () => {
    const { engine, advance } = makeEngine();
    engine.onSessionEvent({ type: "state", state: "working" });
    advance(20 * MIN);
    engine.onSessionEvent({ type: "state", state: "error" });
    engine.onSessionEvent({ type: "state", state: "working" });
    advance(15 * MIN); // only 15min since reset
    // error streak (1) not enough; smooth not yet 30min
    const r = engine.takePending();
    assert.strictEqual(r, null);
  });
});

describe("context-reactions: session lifecycle", () => {
  it("fires bye-wave on session end", () => {
    const { engine } = makeEngine();
    engine.onSessionEvent({ type: "sessionStart", id: "s1" });
    engine.takePending(); // consume good-morning
    engine.onSessionEvent({ type: "sessionEnd", id: "s1" });
    assert.deepStrictEqual(engine.takePending(), { actionId: "bye-wave" });
  });

  it("fires good-morning only for the first session of the day", () => {
    const { engine, advance } = makeEngine(5 * 24 * 60 * 60 * 1000);
    engine.onSessionEvent({ type: "sessionStart", id: "s1" });
    assert.deepStrictEqual(engine.takePending(), { actionId: "good-morning" });
    advance(MIN);
    engine.onSessionEvent({ type: "sessionStart", id: "s2" });
    assert.strictEqual(engine.takePending(), null);
  });

  it("fires break-reminder after 1h continuous session", () => {
    const { engine, advance } = makeEngine();
    engine.onSessionEvent({ type: "sessionStart", id: "s1" });
    engine.takePending(); // consume good-morning
    advance(60 * MIN);
    assert.deepStrictEqual(engine.takePending(), { actionId: "break-reminder" });
  });
});

describe("context-reactions: token milestone", () => {
  it("fires celebration once per 100k boundary", () => {
    const { engine } = makeEngine();
    engine.onSessionEvent({ type: "usage", dailyTokens: 100000 });
    assert.deepStrictEqual(engine.takePending(), { actionId: "celebration" });
    engine.onSessionEvent({ type: "usage", dailyTokens: 150000 });
    assert.strictEqual(engine.takePending(), null); // same boundary
    engine.onSessionEvent({ type: "usage", dailyTokens: 200000 });
    assert.deepStrictEqual(engine.takePending(), { actionId: "celebration" });
  });
});

describe("context-reactions: priority", () => {
  it("returns the highest-priority pending first", () => {
    const { engine, advance } = makeEngine();
    // make several conditions true at once
    engine.onSessionEvent({ type: "sessionStart", id: "s1" }); // good-morning + (later) break
    advance(60 * MIN); // break-reminder eligible
    enterState(engine, "error");
    advance(MIN); enterState(engine, "error");
    advance(MIN); enterState(engine, "error"); // error streak
    engine.onSessionEvent({ type: "usage", dailyTokens: 100000 }); // milestone
    engine.onSessionEvent({ type: "state", state: "idle" });
    // priority: errorStreak > breakReminder > smoothWork > tokenMilestone > sessionEnd > firstSession
    assert.deepStrictEqual(engine.takePending(), { actionId: "error-comfort" });
    assert.deepStrictEqual(engine.takePending(), { actionId: "break-reminder" });
    assert.deepStrictEqual(engine.takePending(), { actionId: "celebration" });
    assert.deepStrictEqual(engine.takePending(), { actionId: "good-morning" });
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createContextReactionEngine,
  feedEngineFromSnapshot,
} = require("../src/companion/context-reactions");

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

describe("feedEngineFromSnapshot adapter", () => {
  function recordingEngine() {
    const events = [];
    return { events, onSessionEvent: (e) => events.push(e) };
  }

  it("emits sessionStart for new ids and sessionEnd for removed ids", () => {
    const eng = recordingEngine();
    let prev = feedEngineFromSnapshot(eng, { snapshot: { sessions: [{ id: "a" }, { id: "b" }] } });
    assert.deepStrictEqual(
      eng.events.filter((e) => e.type === "sessionStart").map((e) => e.id).sort(),
      ["a", "b"],
    );
    eng.events.length = 0;
    prev = feedEngineFromSnapshot(eng, { snapshot: { sessions: [{ id: "b" }] } }, prev);
    assert.deepStrictEqual(eng.events, [{ type: "sessionEnd", id: "a" }]);
  });

  it("forwards dominant state and daily tokens", () => {
    const eng = recordingEngine();
    feedEngineFromSnapshot(eng, { snapshot: { sessions: [] }, dominantState: "working", dailyTokens: 12345 });
    assert.ok(eng.events.some((e) => e.type === "state" && e.state === "working"));
    assert.ok(eng.events.some((e) => e.type === "usage" && e.dailyTokens === 12345));
  });

  it("end-to-end: a session ending makes bye-wave available to the real engine", () => {
    let t = 0;
    const engine = createContextReactionEngine({ now: () => t });
    let prev = feedEngineFromSnapshot(engine, { snapshot: { sessions: [{ id: "s1" }] }, dominantState: "working" }, undefined);
    engine.takePending(); // consume good-morning
    t += 1000;
    feedEngineFromSnapshot(engine, { snapshot: { sessions: [] }, dominantState: "idle" }, prev);
    assert.deepStrictEqual(engine.takePending(), { actionId: "bye-wave" });
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

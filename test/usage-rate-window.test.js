"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  computeRateLimitWindows,
  DEFAULT_WINDOW_MS,
} = require("../src/usage-rate-window");
const {
  createUsageAnalytics,
} = require("../src/usage-analytics");

const HOUR = 60 * 60 * 1000;
// Fixed UTC base on a whole hour: 2026-06-11T08:00:00Z.
const BASE = Date.UTC(2026, 5, 11, 8, 0, 0);

function row(offsetMs, overrides = {}) {
  return {
    at: BASE + offsetMs,
    source: "claude-code",
    tokens: 1000,
    costUsd: 0.5,
    ...overrides,
  };
}

describe("computeRateLimitWindows", () => {
  it("opens the window at the floored hour of the first activity", () => {
    const windows = computeRateLimitWindows(
      [row(25 * 60 * 1000)],
      { now: BASE + HOUR }
    );
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(windows[0].start, BASE);
    assert.strictEqual(windows[0].end, BASE + DEFAULT_WINDOW_MS);
    assert.strictEqual(windows[0].remainingMs, DEFAULT_WINDOW_MS - HOUR);
    assert.strictEqual(windows[0].tokens, 1000);
  });

  it("accumulates activity within one window and reports totals", () => {
    const windows = computeRateLimitWindows(
      [row(0), row(HOUR, { tokens: 2000, costUsd: 1 }), row(4 * HOUR)],
      { now: BASE + 4.5 * HOUR }
    );
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(windows[0].tokens, 4000);
    assert.strictEqual(windows[0].costUsd, 2);
  });

  it("starts a fresh window when activity lands after the previous window ends", () => {
    const windows = computeRateLimitWindows(
      [row(0, { tokens: 9000 }), row(6 * HOUR + 10 * 60 * 1000, { tokens: 500 })],
      { now: BASE + 7 * HOUR }
    );
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(windows[0].start, BASE + 6 * HOUR);
    assert.strictEqual(windows[0].tokens, 500);
    // Historical peak still remembers the bigger previous window.
    assert.strictEqual(windows[0].peakTokens, 9000);
    assert.strictEqual(windows[0].peakRatio, Math.round(500 / 9000 * 1000) / 1000);
  });

  it("omits sources whose last window already expired", () => {
    const windows = computeRateLimitWindows(
      [row(0)],
      { now: BASE + DEFAULT_WINDOW_MS + 1 }
    );
    assert.deepStrictEqual(windows, []);
  });

  it("tracks windows per source and sorts by tokens", () => {
    const windows = computeRateLimitWindows(
      [
        row(0, { source: "codex", tokens: 100 }),
        row(30 * 60 * 1000),
        row(HOUR, { source: "codex", tokens: 50 }),
      ],
      { now: BASE + 2 * HOUR }
    );
    assert.deepStrictEqual(
      windows.map((window) => window.source),
      ["claude-code", "codex"]
    );
    assert.strictEqual(windows[1].tokens, 150);
  });

  it("ignores malformed rows and future timestamps", () => {
    const windows = computeRateLimitWindows(
      [null, {}, row(0), row(3 * HOUR, { at: BASE + 24 * HOUR })],
      { now: BASE + HOUR }
    );
    assert.strictEqual(windows.length, 1);
    assert.strictEqual(windows[0].tokens, 1000);
  });
});

describe("usage analytics rateWindows integration", () => {
  function recordTokenEvent(analytics, at, overrides = {}) {
    analytics.recordToken({
      at,
      agentId: "claude-code",
      source: "claude-code",
      sessionId: `session-${at}`,
      model: "claude-opus-4-5",
      tokenUsage: {
        input_tokens: 100,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
        reasoning_output_tokens: 0,
        total_tokens: 150,
        schema: "clawd-usage-v2",
      },
      ...overrides,
    });
  }

  it("exposes the active window in the snapshot", () => {
    const now = BASE + 2 * HOUR;
    const analytics = createUsageAnalytics({ now: () => now });
    recordTokenEvent(analytics, BASE + 10 * 60 * 1000);
    recordTokenEvent(analytics, BASE + HOUR, { sessionId: "session-b" });

    const snapshot = analytics.getSnapshot({ days: 30, now });
    assert.ok(Array.isArray(snapshot.rateWindows));
    assert.strictEqual(snapshot.rateWindows.length, 1);
    const window = snapshot.rateWindows[0];
    assert.strictEqual(window.source, "claude-code");
    assert.strictEqual(window.start, BASE);
    assert.strictEqual(window.end, BASE + DEFAULT_WINDOW_MS);
    assert.strictEqual(window.tokens, 300);
    assert.ok(window.costUsd > 0);
  });

  it("reports no window when the last activity is older than 5 hours", () => {
    const now = BASE + 12 * HOUR;
    const analytics = createUsageAnalytics({ now: () => now });
    recordTokenEvent(analytics, BASE);

    const snapshot = analytics.getSnapshot({ days: 30, now });
    assert.deepStrictEqual(snapshot.rateWindows, []);
  });
});

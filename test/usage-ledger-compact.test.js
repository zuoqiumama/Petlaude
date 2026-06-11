"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  compactLedgerLines,
  computeCutoffMs,
  COMPACT_ID_PREFIX,
} = require("../src/usage-ledger-compact");
const {
  createUsageAnalytics,
  encodeLedgerEntry,
} = require("../src/usage-analytics");

const NOW = new Date(2026, 5, 11, 10, 30).getTime();
const KEEP_DAYS = 370;
const RECENT_AT = new Date(2026, 5, 10, 9).getTime();
const OLD_JAN_AT = new Date(2025, 0, 15, 14).getTime();
const OLD_JAN_LATER_AT = new Date(2025, 0, 20, 16).getTime();
const OLD_FEB_AT = new Date(2025, 1, 2, 8).getTime();

function tokenLine(overrides = {}) {
  return encodeLedgerEntry({
    type: "state",
    at: RECENT_AT,
    agentId: "claude-code",
    source: "claude-code",
    sessionId: "session-1",
    model: "claude-opus-4-5",
    cwd: "F:/projects/alpha",
    state: "working",
    tokenUsage: {
      input_tokens: 100,
      cached_input_tokens: 400,
      cache_creation_input_tokens: 50,
      output_tokens: 30,
      reasoning_output_tokens: 0,
      total_tokens: 580,
      schema: "clawd-usage-v2",
    },
    ...overrides,
  }).trimEnd();
}

function stateLine(overrides = {}) {
  return encodeLedgerEntry({
    type: "state",
    at: RECENT_AT,
    agentId: "claude-code",
    source: "claude-code",
    sessionId: "session-1",
    state: "working",
    ...overrides,
  }).trimEnd();
}

describe("computeCutoffMs", () => {
  it("keeps exactly the most recent keepDays calendar days", () => {
    const cutoff = computeCutoffMs(NOW, KEEP_DAYS);
    const cutoffDate = new Date(cutoff);
    assert.strictEqual(cutoffDate.getHours(), 0);
    const daysBetween = Math.round(
      (new Date(2026, 5, 11).getTime() - cutoff) / (24 * 60 * 60 * 1000)
    );
    assert.strictEqual(daysBetween, KEEP_DAYS - 1);
  });
});

describe("compactLedgerLines", () => {
  it("keeps recent entries verbatim and reports no change", () => {
    const lines = [tokenLine(), stateLine({ sessionId: "session-2" }), ""];
    const result = compactLedgerLines(lines, { now: NOW, keepDays: KEEP_DAYS });
    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(result.lines, lines.slice(0, 2));
    assert.strictEqual(result.stats.kept, 2);
    assert.strictEqual(result.stats.folded, 0);
  });

  it("folds old token entries into one summary per month/agent/model/project", () => {
    const lines = [
      tokenLine({ at: OLD_JAN_AT, sessionId: "old-1" }),
      tokenLine({ at: OLD_JAN_LATER_AT, sessionId: "old-2" }),
      tokenLine({ at: OLD_FEB_AT, sessionId: "old-3" }),
      tokenLine({ at: OLD_JAN_AT, sessionId: "old-4", model: "claude-haiku-4-5" }),
      tokenLine(),
    ];
    const result = compactLedgerLines(lines, { now: NOW, keepDays: KEEP_DAYS });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.stats.summaries, 3);
    assert.strictEqual(result.stats.folded, 4);
    assert.strictEqual(result.stats.kept, 1);

    const summaries = result.lines.slice(0, 3).map((line) => JSON.parse(line));
    const janOpus = summaries.find(
      (entry) => entry.usageEventId.includes("2025-01") && entry.model === "claude-opus-4-5"
    );
    assert.ok(janOpus, "expected a January opus summary");
    assert.strictEqual(janOpus.type, "token");
    assert.strictEqual(janOpus.tokenUsage.total_tokens, 1160);
    assert.strictEqual(janOpus.tokenUsage.input_tokens, 200);
    assert.strictEqual(janOpus.tokenUsage.cached_input_tokens, 800);
    assert.strictEqual(janOpus.tokenUsage.schema, "clawd-usage-v2");
    assert.strictEqual(janOpus.cwd, "F:/projects/alpha");
    assert.ok(janOpus.usageEventId.startsWith(COMPACT_ID_PREFIX));
    const anchor = new Date(janOpus.at);
    assert.deepStrictEqual(
      [anchor.getFullYear(), anchor.getMonth(), anchor.getDate(), anchor.getHours()],
      [2025, 0, 1, 12]
    );

    // Recent line rides along untouched at the end.
    assert.strictEqual(result.lines[3], lines[4]);
  });

  it("drops old pure-state entries and malformed lines", () => {
    const lines = [
      stateLine({ at: OLD_JAN_AT }),
      "{not json",
      tokenLine(),
    ];
    const result = compactLedgerLines(lines, { now: NOW, keepDays: KEEP_DAYS });
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.stats.dropped, 1);
    assert.strictEqual(result.stats.malformed, 1);
    assert.deepStrictEqual(result.lines, [lines[2]]);
  });

  it("is idempotent: recompacting compacted output is a no-op", () => {
    const lines = [
      tokenLine({ at: OLD_JAN_AT, sessionId: "old-1" }),
      tokenLine({ at: OLD_FEB_AT, sessionId: "old-2" }),
      tokenLine(),
      stateLine(),
    ];
    const first = compactLedgerLines(lines, { now: NOW, keepDays: KEEP_DAYS });
    assert.strictEqual(first.changed, true);
    const second = compactLedgerLines(first.lines, { now: NOW, keepDays: KEEP_DAYS });
    assert.strictEqual(second.changed, false);
    assert.deepStrictEqual(second.lines, first.lines);
  });

  it("preserves monthly trend token and cost totals through compaction", () => {
    const lines = [
      tokenLine({ at: OLD_JAN_AT, sessionId: "old-1" }),
      tokenLine({ at: OLD_JAN_LATER_AT, sessionId: "old-2", model: "claude-haiku-4-5" }),
      tokenLine({ at: OLD_FEB_AT, sessionId: "old-3", cwd: "F:/projects/beta" }),
      stateLine({ at: OLD_JAN_AT, sessionId: "old-1" }),
      tokenLine(),
      stateLine(),
    ];
    const compacted = compactLedgerLines(lines, { now: NOW, keepDays: KEEP_DAYS });

    const rawAnalytics = createUsageAnalytics({ now: () => NOW });
    rawAnalytics.loadLedgerLines(lines, { keepOpenSessions: false });
    const compactedAnalytics = createUsageAnalytics({ now: () => NOW });
    compactedAnalytics.loadLedgerLines(compacted.lines, { keepOpenSessions: false });

    const rawSnapshot = rawAnalytics.getSnapshot({ days: KEEP_DAYS, now: NOW });
    const compactedSnapshot = compactedAnalytics.getSnapshot({ days: KEEP_DAYS, now: NOW });

    const monthTotals = (snapshot) => snapshot.months.map((month) => ({
      month: month.month,
      tokens: month.totals.tokens,
      input: month.totals.input,
      cachedInput: month.totals.cachedInput,
      output: month.totals.output,
      costUsd: Math.round((month.totals.costUsd || 0) * 1e9) / 1e9,
    }));
    assert.deepStrictEqual(monthTotals(compactedSnapshot), monthTotals(rawSnapshot));

    // Project attribution survives folding into the monthly aggregates.
    const febCompacted = compactedSnapshot.months.find((month) => month.month === "2025-02");
    assert.ok(febCompacted.projects.some((project) => project.projectRef === "F:/projects/beta"));

    // Recent data is byte-identical, so today's view must match too.
    assert.deepStrictEqual(compactedSnapshot.today, rawSnapshot.today);
  });
});

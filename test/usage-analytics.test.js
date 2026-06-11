"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  createUsageAnalytics,
  localDayKey,
  normalizeTokenUsage,
} = require("../src/usage-analytics");
const pricing = require("../src/usage-pricing");

describe("normalizeTokenUsage", () => {
  it("accepts explicit input and output token fields", () => {
    const direct = normalizeTokenUsage({ input: 10, output: 5 });
    assert.strictEqual(direct.input_tokens, 10);
    assert.strictEqual(direct.output_tokens, 5);
    assert.strictEqual(direct.total_tokens, 15);
    assert.strictEqual(direct.hasInputOutput, true);

    assert.strictEqual(normalizeTokenUsage({ prompt_tokens: 7, completion_tokens: 8 }).total_tokens, 15);
    assert.strictEqual(normalizeTokenUsage({ tokens: { input: 3, output: 4 } }).total_tokens, 7);
    assert.strictEqual(normalizeTokenUsage({ usage: { input_tokens: 12, output_tokens: 9 } }).total_tokens, 21);
  });

  it("accepts total-only usage without inventing input and output", () => {
    const usage = normalizeTokenUsage({ total: 99 });
    assert.strictEqual(usage.input, null);
    assert.strictEqual(usage.output, null);
    assert.strictEqual(usage.total_tokens, 99);
    assert.strictEqual(usage.unattributed_tokens, 99);
    assert.strictEqual(normalizeTokenUsage({ usage: { total_tokens: 40 } }).total_tokens, 40);
  });

  it("rejects malformed, negative, fractional, and text-only values", () => {
    assert.strictEqual(normalizeTokenUsage(null), null);
    assert.strictEqual(normalizeTokenUsage({ text: "hello world" }), null);
    assert.strictEqual(normalizeTokenUsage({ input: 1.5, output: 2 }), null);
    assert.strictEqual(normalizeTokenUsage({ input: -1, output: 2 }), null);
    assert.strictEqual(normalizeTokenUsage({ total: Number.MAX_SAFE_INTEGER + 1 }), null);
  });

  it("uses a valid explicit total when provided beside input and output", () => {
    const usage = normalizeTokenUsage({ input: 3, output: 4, total: 10 });
    assert.strictEqual(usage.input_tokens, 3);
    assert.strictEqual(usage.output_tokens, 4);
    assert.strictEqual(usage.total_tokens, 10);
    assert.strictEqual(usage.unattributed_tokens, 3);
  });

  it("keeps cache and reasoning token classes separate", () => {
    const usage = normalizeTokenUsage({
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_creation_input_tokens: 10,
      output_tokens: 30,
      reasoning_output_tokens: 5,
    }, { source: "claude" });
    assert.strictEqual(usage.input_tokens, 100);
    assert.strictEqual(usage.cached_input_tokens, 40);
    assert.strictEqual(usage.cache_creation_input_tokens, 10);
    assert.strictEqual(usage.output_tokens, 30);
    assert.strictEqual(usage.reasoning_output_tokens, 5);
    assert.strictEqual(usage.total_tokens, 185);
  });

  it("subtracts Codex cached input from inclusive input totals", () => {
    const usage = normalizeTokenUsage({
      input_tokens: 3658,
      cached_input_tokens: 3072,
      output_tokens: 209,
      total_tokens: 3867,
    }, { source: "codex" });
    assert.strictEqual(usage.input_tokens, 586);
    assert.strictEqual(usage.cached_input_tokens, 3072);
    assert.strictEqual(usage.output_tokens, 209);
    assert.strictEqual(usage.total_tokens, 3867);
  });
});

describe("localDayKey", () => {
  it("formats local calendar days", () => {
    assert.match(localDayKey(Date.parse("2026-05-28T10:00:00")), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("createUsageAnalytics", () => {
  it("deduplicates token usage by usageEventId", () => {
    const usage = createUsageAnalytics({ now: () => Date.parse("2026-05-28T10:00:00") });
    usage.recordToken({
      at: Date.parse("2026-05-28T10:00:00"),
      agentId: "codex",
      sessionId: "s1",
      usageEventId: "u1",
      tokenUsage: { input: 10, output: 5 },
    });
    usage.recordToken({
      at: Date.parse("2026-05-28T10:00:01"),
      agentId: "codex",
      sessionId: "s1",
      usageEventId: "u1",
      tokenUsage: { input: 10, output: 5 },
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:00:02"), days: 1 });

    assert.strictEqual(snap.today.totals.tokens, 15);
    assert.strictEqual(snap.today.totals.input, 10);
    assert.strictEqual(snap.today.totals.output, 5);
    assert.strictEqual(snap.today.agents[0].agentId, "codex");
    assert.strictEqual(snap.today.agents[0].tokens, 15);
  });

  it("aggregates model, source, cache, and estimated cost", () => {
    const usage = createUsageAnalytics({ now: () => Date.parse("2026-05-28T10:00:00") });
    usage.recordToken({
      at: Date.parse("2026-05-28T10:00:00"),
      agentId: "codex",
      source: "codex",
      model: "gpt-5-codex",
      sessionId: "s1",
      usageEventId: "u-cost",
      tokenUsage: {
        input_tokens: 2000000,
        cached_input_tokens: 1000000,
        output_tokens: 1000000,
        total_tokens: 3000000,
      },
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:00:02"), days: 1 });
    assert.strictEqual(snap.today.totals.input, 1000000);
    assert.strictEqual(snap.today.totals.cachedInput, 1000000);
    assert.strictEqual(snap.today.models[0].model, "gpt-5-codex");
    assert.strictEqual(snap.today.sources[0].source, "codex");
    assert.ok(snap.today.totals.costUsd > 0);
    assert.strictEqual(snap.today.totals.unpricedTokens, 0);
  });

  it("exports TokenTracker-style trends, heatmap, projects, cost, and context totals", () => {
    const usage = createUsageAnalytics({ now: () => Date.parse("2026-05-28T11:00:00Z") });
    const projectCwd = "F:\\agentic\\clawd-on-desk";
    usage.recordToken({
      at: Date.parse("2026-05-20T10:10:00Z"),
      agentId: "codex",
      source: "codex",
      model: "gpt-5-codex",
      sessionId: "codex-session",
      cwd: projectCwd,
      usageEventId: "u-align-codex",
      tokenUsage: {
        input_tokens: 1000,
        cached_input_tokens: 200,
        output_tokens: 300,
        reasoning_output_tokens: 50,
      },
    });
    usage.recordToken({
      at: Date.parse("2026-05-28T10:35:00Z"),
      agentId: "claude-code",
      source: "claude",
      model: "claude-sonnet-4",
      sessionId: "claude-session",
      cwd: projectCwd,
      usageEventId: "u-align-claude",
      tokenUsage: {
        input_tokens: 400,
        cache_creation_input_tokens: 100,
        output_tokens: 200,
      },
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T11:00:00Z"), days: 370 });

    assert.strictEqual(snap.rolling.last7d.totals.tokens, 700);
    assert.strictEqual(snap.rolling.last30d.totals.tokens, 2050);
    assert.strictEqual(snap.rolling.last30d.activeDays, 2);
    assert.strictEqual(snap.rolling.last30d.avgTokensPerActiveDay, 1025);
    assert.strictEqual(snap.rolling.last30d.totals.conversationCount, 2);
    assert.ok(snap.trends.hourly.some((row) => row.bucket === "2026-05-28T10:30:00.000Z" && row.totals.tokens === 700));
    assert.ok(snap.trends.daily.some((row) => row.day === localDayKey(Date.parse("2026-05-20T10:10:00Z")) && row.totals.tokens === 1350));
    assert.ok(snap.trends.monthly.some((row) => row.month === "2026-05" && row.totals.tokens === 2050));
    assert.ok(Array.isArray(snap.heatmap.weeks));
    assert.ok(snap.heatmap.weeks.length >= 52);
    assert.strictEqual(snap.heatmap.activeDays, 2);
    assert.strictEqual(snap.heatmap.peakDay.totals.tokens, 1350);
    assert.strictEqual(snap.projects[0].name, "clawd-on-desk");
    assert.strictEqual(snap.projects[0].totals.tokens, 2050);
    assert.strictEqual(snap.contextBreakdown.totals.input.tokens, 1200);
    assert.strictEqual(snap.contextBreakdown.totals.cacheRead.tokens, 200);
    assert.strictEqual(snap.contextBreakdown.totals.cacheWrite.tokens, 100);
    assert.strictEqual(snap.contextBreakdown.totals.output.tokens, 500);
    assert.strictEqual(snap.contextBreakdown.totals.reasoning.tokens, 50);
    assert.strictEqual(snap.costAnalysis.totalCostUsd, snap.rolling.last30d.totals.costUsd);
  });

  it("tracks session and active time for live sessions", () => {
    const usage = createUsageAnalytics();
    usage.recordState({
      at: Date.parse("2026-05-28T10:00:00"),
      agentId: "claude-code",
      sessionId: "s1",
      state: "thinking",
    });
    usage.recordState({
      at: Date.parse("2026-05-28T10:10:00"),
      agentId: "claude-code",
      sessionId: "s1",
      state: "idle",
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:20:00"), days: 1 });

    assert.strictEqual(snap.today.totals.sessionMs, 20 * 60 * 1000);
    assert.strictEqual(snap.today.totals.activeMs, 10 * 60 * 1000);
  });

  it("splits session and active time across local days", () => {
    const usage = createUsageAnalytics();
    usage.recordState({
      at: Date.parse("2026-05-28T23:50:00"),
      agentId: "codex",
      sessionId: "s1",
      state: "working",
    });
    usage.recordState({
      at: Date.parse("2026-05-29T00:10:00"),
      agentId: "codex",
      sessionId: "s1",
      state: "sleeping",
      event: "SessionEnd",
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-29T00:10:00"), days: 2 });
    const first = snap.days[0];
    const second = snap.days[1];

    assert.strictEqual(first.totals.sessionMs, 10 * 60 * 1000);
    assert.strictEqual(second.totals.sessionMs, 10 * 60 * 1000);
    assert.strictEqual(first.totals.activeMs, 10 * 60 * 1000);
    assert.strictEqual(second.totals.activeMs, 10 * 60 * 1000);
  });

  it("rebuilds daily aggregates from ledger entries", () => {
    const usage = createUsageAnalytics();
    usage.loadLedgerLines([
      JSON.stringify({
        type: "token",
        at: Date.parse("2026-05-28T10:00:00"),
        agentId: "codex",
        sessionId: "s1",
        usageEventId: "u1",
        tokenUsage: { input: 2, output: 3 },
      }),
      JSON.stringify({
        type: "state",
        at: Date.parse("2026-05-28T10:00:00"),
        agentId: "codex",
        sessionId: "s1",
        state: "working",
      }),
      JSON.stringify({
        type: "state",
        at: Date.parse("2026-05-28T10:05:00"),
        agentId: "codex",
        sessionId: "s1",
        state: "sleeping",
        event: "SessionEnd",
      }),
    ]);

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:05:00"), days: 1 });

    assert.strictEqual(snap.today.totals.tokens, 5);
    assert.strictEqual(snap.today.totals.sessionMs, 5 * 60 * 1000);
  });

  it("inherits session model metadata for token ledger entries that omit model", () => {
    const usage = createUsageAnalytics();
    usage.loadLedgerLines([
      JSON.stringify({
        type: "state",
        at: Date.parse("2026-05-28T10:00:00"),
        agentId: "codex",
        source: "codex",
        sessionId: "s1",
        state: "thinking",
        model: "gpt-5-codex",
      }),
      JSON.stringify({
        type: "state",
        at: Date.parse("2026-05-28T10:01:00"),
        agentId: "codex",
        source: "codex",
        sessionId: "s1",
        state: "idle",
        event: "event_msg:token_count",
        usageEventId: "u-with-inherited-model",
        tokenUsage: { input: 2, output: 3 },
      }),
    ]);

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:05:00"), days: 1 });

    assert.strictEqual(snap.today.models[0].model, "gpt-5-codex");
    assert.strictEqual(snap.today.models[0].tokens, 5);
    assert.strictEqual(snap.today.models.some((row) => row.model === "unknown"), false);
  });

  it("uses an external model resolver when ledger metadata cannot identify the model", () => {
    const usage = createUsageAnalytics({
      resolveModelForEvent: (event) => event.sessionId === "s1" ? "gpt-5-codex" : null,
    });
    usage.recordToken({
      at: Date.parse("2026-05-28T10:00:00"),
      agentId: "codex",
      source: "codex",
      sessionId: "s1",
      usageEventId: "u-resolved-model",
      tokenUsage: { input: 2, output: 3 },
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:05:00"), days: 1 });

    assert.strictEqual(snap.today.models[0].model, "gpt-5-codex");
    assert.strictEqual(snap.today.models[0].tokens, 5);
  });

  it("ignores synthetic test usage events from ad hoc smoke checks", () => {
    const usage = createUsageAnalytics();
    usage.recordToken({
      at: Date.parse("2026-05-28T10:00:00"),
      agentId: "claude-code",
      sessionId: "test-session-1",
      usageEventId: "claude-code:test-session-1:PostToolUse:payload:test-1",
      tokenUsage: { input: 100, output: 50 },
    });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T10:05:00"), days: 1 });

    assert.strictEqual(snap.today.totals.tokens, 0);
    assert.strictEqual(snap.today.models.length, 0);
  });

  it("can rebuild ledger history without projecting restored open sessions", () => {
    const usage = createUsageAnalytics();
    usage.loadLedgerLines([
      JSON.stringify({
        type: "state",
        at: Date.parse("2026-05-28T10:00:00"),
        agentId: "codex",
        sessionId: "s1",
        state: "working",
      }),
    ], { keepOpenSessions: false });

    const snap = usage.getSnapshot({ now: Date.parse("2026-05-28T11:00:00"), days: 1 });

    assert.strictEqual(snap.today.totals.sessionMs, 0);
    assert.strictEqual(snap.today.totals.activeMs, 0);
  });

  it("reprices previously recorded token events after the pricing index changes", () => {
    const now = Date.parse("2026-05-28T11:00:00Z");
    const model = "pricing-reload-regression-model";
    const usage = createUsageAnalytics({ now: () => now });
    usage.recordToken({
      at: Date.parse("2026-05-28T10:00:00Z"),
      agentId: "codex",
      source: "codex",
      model,
      sessionId: "s1",
      usageEventId: "pricing-reload-u1",
      tokenUsage: { input_tokens: 1_000_000, total_tokens: 1_000_000 },
    });
    assert.strictEqual(usage.getSnapshot({ now, days: 1 }).today.totals.costUsd, 0);

    pricing.reloadPricing({ [model]: { input: 2, output: 4 } });
    usage.reprice();

    const totals = usage.getSnapshot({ now, days: 1 }).today.totals;
    assert.strictEqual(totals.costUsd, 2);
    assert.strictEqual(totals.pricedTokens, 1_000_000);
    assert.strictEqual(totals.unpricedTokens, 0);
  });
});

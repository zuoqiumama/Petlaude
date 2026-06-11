"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const {
  buildWeeklyReport,
  drawWeeklyCard,
  CARD_WIDTH,
  CARD_HEIGHT,
} = require("../src/usage-weekly-report");

function dayEntry(day, tokens, overrides = {}) {
  return {
    day,
    totals: {
      tokens,
      costUsd: tokens / 1000,
      activeMs: tokens > 0 ? 30 * 60 * 1000 : 0,
      conversationCount: tokens > 0 ? 2 : 0,
    },
    models: tokens > 0
      ? [{ model: "claude-opus-4-5", source: "claude-code", tokens, totals: { tokens } }]
      : [],
    projects: tokens > 0
      ? [{ projectRef: "F:/projects/alpha", name: "alpha", tokens, totals: { tokens } }]
      : [],
    ...overrides,
  };
}

function sampleSnapshot() {
  return {
    days: [
      dayEntry("2026-06-01", 999999), // older than the week, must be ignored
      dayEntry("2026-06-05", 0),
      dayEntry("2026-06-06", 1000),
      dayEntry("2026-06-07", 0),
      dayEntry("2026-06-08", 3000, {
        models: [
          { model: "claude-opus-4-5", source: "claude-code", tokens: 1000, totals: { tokens: 1000 } },
          { model: "gpt-6", source: "codex", tokens: 2000, totals: { tokens: 2000 } },
        ],
        projects: [
          { projectRef: "F:/projects/beta", name: "beta", tokens: 3000, totals: { tokens: 3000 } },
        ],
      }),
      dayEntry("2026-06-09", 0),
      dayEntry("2026-06-10", 2000),
      dayEntry("2026-06-11", 500),
    ],
    heatmap: { streakDays: 4 },
  };
}

describe("buildWeeklyReport", () => {
  it("aggregates the last seven day entries only", () => {
    const report = buildWeeklyReport(sampleSnapshot());
    assert.strictEqual(report.days.length, 7);
    assert.strictEqual(report.range.startDay, "2026-06-05");
    assert.strictEqual(report.range.endDay, "2026-06-11");
    assert.strictEqual(report.totals.tokens, 6500);
    assert.ok(Math.abs(report.totals.costUsd - 6.5) < 1e-9);
    assert.strictEqual(report.activeDays, 4);
    assert.strictEqual(report.streakDays, 4);
    assert.strictEqual(report.hasUsage, true);
  });

  it("picks top model and project across the week", () => {
    const report = buildWeeklyReport(sampleSnapshot());
    // opus: 1000 + 1000 + 2000 + 500 = 4500 vs gpt-6: 2000
    assert.strictEqual(report.topModel.model, "claude-opus-4-5");
    assert.strictEqual(report.topModel.tokens, 4500);
    // alpha: 1000 + 2000 + 500 = 3500 vs beta: 3000
    assert.strictEqual(report.topProject.name, "alpha");
    assert.strictEqual(report.topProject.tokens, 3500);
  });

  it("handles empty snapshots", () => {
    const report = buildWeeklyReport({ days: [] });
    assert.strictEqual(report.hasUsage, false);
    assert.strictEqual(report.days.length, 0);
    assert.strictEqual(report.topModel, null);
    assert.strictEqual(report.topProject, null);
    assert.strictEqual(report.activeDays, 0);
  });

  it("reads snake_case aliases when camelCase totals are absent", () => {
    const report = buildWeeklyReport({
      days: [{
        day: "2026-06-11",
        totals: { total_tokens: 700, total_cost_usd: 0.7, active_ms: 60000, conversation_count: 1 },
      }],
    });
    assert.strictEqual(report.totals.tokens, 700);
    assert.ok(Math.abs(report.totals.costUsd - 0.7) < 1e-9);
    assert.strictEqual(report.totals.activeMs, 60000);
    assert.strictEqual(report.totals.conversations, 1);
  });
});

describe("drawWeeklyCard", () => {
  function createStubCanvas() {
    const calls = [];
    const texts = [];
    const ctx = new Proxy({
      measureText: (text) => ({ width: String(text).length * 6 }),
      fillText: (text, x, y) => { texts.push({ text: String(text), x, y }); },
    }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (prop === "canvas") return canvas;
        return (...args) => { calls.push({ op: prop, args }); };
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
    };
    return { canvas, calls, texts };
  }

  it("paints hero numbers, stats, and footer using the provided translator", () => {
    const { canvas, texts } = createStubCanvas();
    const report = buildWeeklyReport(sampleSnapshot());
    drawWeeklyCard(canvas, report, {
      t: (key) => `[${key}]`,
      lang: "en",
      formatters: {
        tokens: (value) => `${value}T`,
        cost: (value) => `$${value.toFixed(2)}`,
        duration: () => "2h",
      },
    });
    assert.strictEqual(canvas.width, CARD_WIDTH * 2);
    assert.strictEqual(canvas.height, CARD_HEIGHT * 2);
    const drawn = texts.map((entry) => entry.text);
    assert.ok(drawn.includes("[usageWeeklyCardTitle]"));
    assert.ok(drawn.includes("6500T"));
    assert.ok(drawn.includes("$6.50"));
    assert.ok(drawn.includes("4/7"));
    assert.ok(drawn.includes("claude-opus-4-5"));
    assert.ok(drawn.includes("alpha"));
    assert.ok(drawn.includes("Petlaude"));
  });

  it("paints the empty state when there is no usage", () => {
    const { canvas, texts } = createStubCanvas();
    drawWeeklyCard(canvas, buildWeeklyReport({ days: [] }), { t: (key) => key });
    const drawn = texts.map((entry) => entry.text);
    assert.ok(drawn.includes("usageWeeklyEmpty"));
    assert.ok(drawn.includes("Petlaude"));
  });
});

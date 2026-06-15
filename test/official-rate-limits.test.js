"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");

const {
  createOfficialRateLimitStore,
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
} = require("../src/official-rate-limits");

describe("official rate-limit normalization", () => {
  it("normalizes Claude Code five-hour and weekly statusLine fields", () => {
    const observedAt = 1_800_000_000_000;
    const result = normalizeClaudeRateLimits({
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1_738_425_600 },
        seven_day: { used_percentage: 41.2, resets_at: 1_738_857_600 },
      },
    }, { observedAt });

    assert.deepStrictEqual(result, {
      agentId: "claude-code",
      source: "claude-statusline",
      observedAt,
      windows: [
        {
          kind: "fiveHour",
          durationMinutes: 300,
          usedPercent: 23.5,
          resetsAt: 1_738_425_600_000,
        },
        {
          kind: "sevenDay",
          durationMinutes: 10_080,
          usedPercent: 41.2,
          resetsAt: 1_738_857_600_000,
        },
      ],
    });
  });

  it("normalizes Codex primary and secondary windows by duration", () => {
    const observedAt = 1_800_000_000_000;
    const result = normalizeCodexRateLimits({
      rateLimits: {
        primary: {
          usedPercent: 67,
          windowDurationMins: 300,
          resetsAt: 1_781_272_733,
        },
        secondary: {
          usedPercent: 18,
          windowDurationMins: 10_080,
          resetsAt: 1_781_747_119,
        },
        planType: "plus",
      },
    }, { observedAt });

    assert.deepStrictEqual(result, {
      agentId: "codex",
      source: "codex-app-server",
      observedAt,
      planType: "plus",
      windows: [
        {
          kind: "fiveHour",
          durationMinutes: 300,
          usedPercent: 67,
          resetsAt: 1_781_272_733_000,
        },
        {
          kind: "sevenDay",
          durationMinutes: 10_080,
          usedPercent: 18,
          resetsAt: 1_781_747_119_000,
        },
      ],
    });
  });

  it("drops invalid windows and clamps provider percentages", () => {
    const result = normalizeClaudeRateLimits({
      rate_limits: {
        five_hour: { used_percentage: 140, resets_at: 1_738_425_600 },
        seven_day: { used_percentage: "bad", resets_at: 1_738_857_600 },
      },
    }, { observedAt: 123 });

    assert.strictEqual(result.windows.length, 1);
    assert.strictEqual(result.windows[0].usedPercent, 100);
  });
});

describe("official rate-limit store", () => {
  it("persists the last good provider snapshot and ignores empty updates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-rate-limits-"));
    const filePath = path.join(dir, "official-rate-limits.json");
    try {
      const store = createOfficialRateLimitStore({ filePath });
      const snapshot = normalizeClaudeRateLimits({
        rate_limits: {
          five_hour: { used_percentage: 12, resets_at: 1_738_425_600 },
        },
      }, { observedAt: 456 });

      assert.strictEqual(store.set(snapshot), true);
      assert.strictEqual(store.set({ ...snapshot, observedAt: 999, windows: [] }), false);
      assert.deepStrictEqual(store.getSnapshot(), {
        "claude-code": snapshot,
      });

      const reloaded = createOfficialRateLimitStore({ filePath });
      assert.deepStrictEqual(reloaded.getSnapshot(), {
        "claude-code": snapshot,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

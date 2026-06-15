"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");

const { runStatusLine } = require("../hooks/claude-statusline");

describe("Claude statusLine relay", () => {
  it("posts official limits and preserves the original command input and output", async () => {
    const input = JSON.stringify({
      cwd: "C:\\repo",
      rate_limits: {
        five_hour: { used_percentage: 12, resets_at: 1_738_425_600 },
        seven_day: { used_percentage: 34, resets_at: 1_738_857_600 },
      },
    });
    const calls = [];

    const output = await runStatusLine(input, {
      loadState: () => ({
        hadStatusLine: true,
        original: { type: "command", command: "claude-hud" },
      }),
      postRateLimits: async (payload) => calls.push({ type: "post", payload }),
      executeCommand: async (command, stdin, options) => {
        calls.push({ type: "exec", command, stdin, options });
        return "HUD OUTPUT\n";
      },
    });

    assert.strictEqual(output, "HUD OUTPUT\n");
    assert.deepStrictEqual(calls, [
      {
        type: "post",
        payload: {
          agent_id: "claude-code",
          rate_limits: JSON.parse(input).rate_limits,
        },
      },
      {
        type: "exec",
        command: "claude-hud",
        stdin: input,
        options: { cwd: "C:\\repo" },
      },
    ]);
  });

  it("still runs the original command when the statusLine payload is not JSON", async () => {
    let posted = false;
    const output = await runStatusLine("not-json", {
      loadState: () => ({ original: { type: "command", command: "existing-status" } }),
      postRateLimits: async () => { posted = true; },
      executeCommand: async (_command, stdin) => `seen:${stdin}`,
    });

    assert.strictEqual(output, "seen:not-json");
    assert.strictEqual(posted, false);
  });
});

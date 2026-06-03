"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const permission = require("../src/permission");

describe("permission bubble agent labels", () => {
  it("uses the requesting agent name in permission bubble titles", () => {
    const {
      getPermissionAgentDisplayName,
      buildPermissionBubbleTitle,
    } = permission.__test;

    assert.strictEqual(getPermissionAgentDisplayName("codex"), "Codex");
    assert.strictEqual(getPermissionAgentDisplayName("claude-code"), "Claude Code");
    assert.strictEqual(getPermissionAgentDisplayName("unknown-agent"), "unknown-agent");

    assert.strictEqual(
      buildPermissionBubbleTitle({ agentId: "codex" }),
      "Codex Permission Request"
    );
    assert.strictEqual(
      buildPermissionBubbleTitle({ agentId: "claude-code" }),
      "Claude Code Permission Request"
    );
    assert.strictEqual(
      buildPermissionBubbleTitle({}),
      "Claude Code Permission Request"
    );
  });
});

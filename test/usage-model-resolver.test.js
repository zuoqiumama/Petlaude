"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createUsageModelResolver } = require("../src/usage-model-resolver");

describe("usage model resolver", () => {
  it("resolves Codex models from the raw session JSONL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-model-"));
    const uuid = "019e8b55-9927-7c33-b255-3dd9989fcf19";
    const dayDir = path.join(root, "sessions", "2026", "06", "03");
    fs.mkdirSync(dayDir, { recursive: true });
    fs.writeFileSync(path.join(dayDir, `rollout-2026-06-03T10-35-08-${uuid}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd: "F:\\repo" } }),
      JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex" } }),
    ].join("\n") + "\n");

    const resolver = createUsageModelResolver({
      codexHome: root,
      claudeProjectsDir: path.join(root, "missing-claude"),
    });

    assert.equal(resolver.resolveModelForEvent({
      agentId: "codex",
      source: "codex",
      sessionId: `codex:${uuid}`,
    }), "gpt-5-codex");
  });

  it("resolves Claude models from the raw transcript JSONL", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-claude-model-"));
    const sessionId = "010ed968-966f-4b94-ae32-f42fedb4bf3c";
    const projectDir = path.join(root, "projects", "F--repo");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    ].join("\n") + "\n");

    const resolver = createUsageModelResolver({
      codexHome: path.join(root, "missing-codex"),
      claudeProjectsDir: path.join(root, "projects"),
    });

    assert.equal(resolver.resolveModelForEvent({
      agentId: "claude-code",
      source: "claude-code",
      sessionId,
    }), "claude-sonnet-4-5");
  });
});

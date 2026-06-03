"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  launchPetClickAction,
  quoteForCmd,
  quoteForPosixShellArg,
} = require("../src/pet-click-launcher");

function makeSpawnRecorder({ failBins = new Set() } = {}) {
  const calls = [];
  function spawn(bin, args, opts) {
    calls.push({ bin, args, opts });
    if (failBins.has(bin)) {
      const err = new Error(`spawn ${bin} ENOENT`);
      err.code = "ENOENT";
      throw err;
    }
    return {
      unref() {
        calls.push({ op: "unref", bin });
      },
      on() {},
    };
  }
  return { calls, spawn };
}

test("pet click launcher skips empty or disabled config", () => {
  const { calls, spawn } = makeSpawnRecorder();

  assert.deepStrictEqual(launchPetClickAction(null, { spawn }), { status: "skipped", reason: "disabled" });
  assert.deepStrictEqual(launchPetClickAction({ enabled: false }, { spawn }), { status: "skipped", reason: "disabled" });
  assert.deepStrictEqual(launchPetClickAction({ enabled: true, executablePath: "" }, { spawn }), {
    status: "skipped",
    reason: "missing-executable",
  });
  assert.deepStrictEqual(calls, []);
});

test("pet click launcher starts direct executable with optional workspace cwd", () => {
  const { calls, spawn } = makeSpawnRecorder();
  const result = launchPetClickAction({
    enabled: true,
    executablePath: "C:\\Tools\\Codex\\codex.exe",
    workspacePath: "F:\\agentic\\clawd-on-desk",
    launchMode: "direct",
  }, { spawn, platform: "win32" });

  assert.deepStrictEqual(result, { status: "ok", terminal: null });
  assert.strictEqual(calls[0].bin, "C:\\Tools\\Codex\\codex.exe");
  assert.deepStrictEqual(calls[0].args, []);
  assert.strictEqual(calls[0].opts.cwd, "F:\\agentic\\clawd-on-desk");
  assert.strictEqual(calls[0].opts.detached, true);
  assert.strictEqual(calls[0].opts.stdio, "ignore");
  assert.strictEqual(calls[0].opts.windowsHide, false);
  assert.deepStrictEqual(calls[1], { op: "unref", bin: "C:\\Tools\\Codex\\codex.exe" });
});

test("pet click launcher opens Windows CLI agents through cmd", () => {
  const { calls, spawn } = makeSpawnRecorder();
  const result = launchPetClickAction({
    enabled: true,
    executablePath: "C:\\Tools\\codex.cmd",
    workspacePath: "F:\\agentic\\clawd-on-desk",
    launchMode: "terminal",
  }, { spawn, platform: "win32" });

  assert.deepStrictEqual(result, { status: "ok", terminal: "cmd" });
  assert.strictEqual(calls[0].bin, "cmd.exe");
  assert.deepStrictEqual(calls[0].args, [
    "/d",
    "/v:off",
    "/s",
    "/k",
    `"C:\\Tools\\codex.cmd"`,
  ]);
  assert.strictEqual(calls[0].opts.cwd, "F:\\agentic\\clawd-on-desk");
});

test("pet click launcher quotes terminal commands for shell hosts", () => {
  assert.strictEqual(quoteForCmd("C:\\Program Files\\Codex\\codex.cmd"), `"C:\\Program Files\\Codex\\codex.cmd"`);
  assert.strictEqual(quoteForCmd("plain"), "plain");
  assert.strictEqual(
    quoteForPosixShellArg("/Applications/Claude Code.app/Contents/MacOS/Claude Code"),
    "'/Applications/Claude Code.app/Contents/MacOS/Claude Code'"
  );
  assert.strictEqual(quoteForPosixShellArg("it's"), "'it'\\''s'");
});

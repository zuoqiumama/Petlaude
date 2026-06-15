"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { PassThrough, Writable } = require("node:stream");
const { describe, it } = require("node:test");

const {
  createCodexRateLimitRuntime,
  getCodexLaunchCandidates,
  resolveCodexHome,
} = require("../src/codex-rate-limits");

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.writes = [];
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      child.writes.push(String(chunk));
      callback();
    },
  });
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; };
  return child;
}

function writtenMessages(child) {
  return child.writes
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("Codex official rate-limit runtime", () => {
  it("selects the active Codex home instead of an empty default directory", () => {
    const authFiles = new Map([
      ["C:\\Users\\Tester\\.codex\\auth.json", "{}"],
      ["F:\\AIData\\.codex\\auth.json", JSON.stringify({ tokens: { access_token: "redacted" } })],
    ]);
    const mtimes = new Map([
      ["C:\\Users\\Tester\\.codex\\auth.json", 100],
      ["F:\\AIData\\.codex\\auth.json", 200],
    ]);
    const result = resolveCodexHome({
      candidates: ["C:\\Users\\Tester\\.codex", "F:\\AIData\\.codex"],
      fs: {
        existsSync: (filePath) => authFiles.has(filePath),
        readFileSync: (filePath) => authFiles.get(filePath),
        statSync: (filePath) => ({ mtimeMs: mtimes.get(filePath) }),
      },
      path: require("node:path").win32,
    });

    assert.strictEqual(result, "F:\\AIData\\.codex");
  });

  it("initializes app-server, reads limits, and refreshes on update notifications", () => {
    const child = createFakeChild();
    const snapshots = [];
    const runtime = createCodexRateLimitRuntime({
      spawn: () => child,
      getLaunchCandidates: () => [{ command: "codex", shell: false }],
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      now: () => 1_800_000_000_000,
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
    });

    assert.strictEqual(runtime.start(), true);
    let messages = writtenMessages(child);
    assert.strictEqual(messages[0].method, "initialize");
    const initializeId = messages[0].id;

    child.stdout.write(`${JSON.stringify({ id: initializeId, result: { codexHome: "F:\\AIData\\.codex" } })}\n`);
    messages = writtenMessages(child);
    assert.ok(messages.some((message) => message.method === "initialized" && message.id === undefined));
    const readRequest = messages.find((message) => message.method === "account/rateLimits/read");
    assert.ok(readRequest);

    child.stdout.write(`${JSON.stringify({
      id: readRequest.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1_781_272_733 },
          secondary: { usedPercent: 22, windowDurationMins: 10_080, resetsAt: 1_781_747_119 },
          planType: "plus",
        },
      },
    })}\n`);

    assert.strictEqual(snapshots.length, 1);
    assert.strictEqual(snapshots[0].windows[0].kind, "fiveHour");
    assert.strictEqual(snapshots[0].windows[1].kind, "sevenDay");

    const beforeUpdate = writtenMessages(child).filter(
      (message) => message.method === "account/rateLimits/read"
    ).length;
    child.stdout.write(`${JSON.stringify({ method: "account/rateLimits/updated", params: {} })}\n`);
    const afterUpdate = writtenMessages(child).filter(
      (message) => message.method === "account/rateLimits/read"
    ).length;
    assert.strictEqual(afterUpdate, beforeUpdate + 1);

    runtime.stop();
    assert.strictEqual(child.killCalls, 1);
  });

  it("prefers a real Windows Codex executable over shell shims", () => {
    const native = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
    const candidates = getCodexLaunchCandidates({
      platform: "win32",
      arch: "x64",
      env: { APPDATA: "C:\\Users\\Tester\\AppData\\Roaming", PATH: "" },
      existsSync: (candidate) => candidate === native,
      execFileSync: () => "C:\\broken\\codex.cmd\n",
    });

    assert.strictEqual(candidates[0].command, native);
    assert.strictEqual(candidates[0].shell, false);
  });

  it("prefers the Codex Desktop native binary over an older npm binary", () => {
    const desktop = "C:\\Users\\Tester\\AppData\\Local\\OpenAI\\Codex\\bin\\current\\codex.exe";
    const npm = "C:\\Users\\Tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
    const candidates = getCodexLaunchCandidates({
      platform: "win32",
      arch: "x64",
      env: {
        APPDATA: "C:\\Users\\Tester\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\Tester\\AppData\\Local",
        PATH: "",
      },
      readdirSync: () => ["current"],
      existsSync: (candidate) => candidate === desktop || candidate === npm,
      execFileSync: () => "",
    });

    assert.strictEqual(candidates[0].command, desktop);
    assert.strictEqual(candidates[1].command, npm);
  });

  it("completes initialization after the runtime is restarted", () => {
    const children = [createFakeChild(), createFakeChild()];
    let spawnIndex = 0;
    const runtime = createCodexRateLimitRuntime({
      spawn: () => children[spawnIndex++],
      getLaunchCandidates: () => [{ command: "codex", shell: false }],
      setInterval: () => 1,
      clearInterval: () => {},
      setTimeout: () => 1,
      clearTimeout: () => {},
    });

    runtime.start();
    runtime.stop();
    runtime.start();
    const secondInitialize = writtenMessages(children[1])[0];
    assert.ok(secondInitialize.id > 1);
    children[1].stdout.write(`${JSON.stringify({ id: secondInitialize.id, result: {} })}\n`);

    assert.ok(writtenMessages(children[1]).some(
      (message) => message.method === "account/rateLimits/read"
    ));
    runtime.stop();
  });

  it("abandons a candidate that never completes initialization", () => {
    const children = [createFakeChild(), createFakeChild()];
    const timers = [];
    let spawnIndex = 0;
    const runtime = createCodexRateLimitRuntime({
      spawn: () => children[spawnIndex++],
      getLaunchCandidates: () => [
        { command: "broken-codex", shell: false },
        { command: "working-codex", shell: false },
      ],
      initializeTimeoutMs: 100,
      setTimeout(fn, delay) {
        const token = { fn, delay, cleared: false };
        timers.push(token);
        return token;
      },
      clearTimeout(token) {
        token.cleared = true;
      },
      setInterval: () => 1,
      clearInterval: () => {},
    });

    runtime.start();
    assert.strictEqual(spawnIndex, 1);
    const initializeTimeout = timers.shift();
    assert.strictEqual(initializeTimeout.delay, 100);
    initializeTimeout.fn();
    assert.strictEqual(children[0].killCalls, 1);

    const reconnect = timers.find((timer) => !timer.cleared);
    assert.ok(reconnect);
    reconnect.fn();
    assert.strictEqual(spawnIndex, 2);
    assert.strictEqual(writtenMessages(children[1])[0].method, "initialize");

    runtime.stop();
  });
});

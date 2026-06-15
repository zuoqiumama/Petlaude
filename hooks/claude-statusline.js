#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const STATE_NAME = "clawd-statusline.json";
const MARKER = "claude-statusline.js";

function defaultStatePath() {
  return process.env.CLAWD_CLAUDE_STATUSLINE_STATE
    || path.join(os.homedir(), ".claude", STATE_NAME);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(defaultStatePath(), "utf8"));
  } catch {
    return null;
  }
}

function executeCommand(command, stdin, options = {}) {
  return new Promise((resolve) => {
    if (typeof command !== "string" || !command.trim() || command.includes(MARKER)) {
      resolve("");
      return;
    }
    const spawnOptions = {
      shell: true,
      windowsHide: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    };
    if (typeof options.cwd === "string" && options.cwd) spawnOptions.cwd = options.cwd;
    let child;
    try {
      child = spawn(command, spawnOptions);
    } catch {
      resolve("");
      return;
    }
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(stdout));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

function postRateLimits(payload) {
  return new Promise((resolve) => {
    try {
      const { postRateLimitsToRunningServer } = require("./server-config");
      if (typeof postRateLimitsToRunningServer !== "function") {
        resolve(false);
        return;
      }
      postRateLimitsToRunningServer(payload, { timeoutMs: 250 }, (ok) => resolve(ok));
    } catch {
      resolve(false);
    }
  });
}

async function runStatusLine(stdin, options = {}) {
  const loadStateFn = options.loadState || loadState;
  const executeCommandFn = options.executeCommand || executeCommand;
  const postRateLimitsFn = options.postRateLimits || postRateLimits;
  let parsed = null;
  try { parsed = JSON.parse(stdin); } catch {}

  const state = loadStateFn() || {};
  const original = state.original && typeof state.original === "object" ? state.original : null;
  const command = original && typeof original.command === "string" ? original.command : "";
  const cwd = parsed && typeof parsed.cwd === "string" && parsed.cwd ? parsed.cwd : undefined;

  const postPromise = parsed && parsed.rate_limits && typeof parsed.rate_limits === "object"
    ? Promise.resolve(postRateLimitsFn({
        agent_id: "claude-code",
        rate_limits: parsed.rate_limits,
      })).catch(() => false)
    : Promise.resolve(false);
  const outputPromise = Promise.resolve(
    executeCommandFn(command, stdin, cwd ? { cwd } : {})
  ).catch(() => "");
  const [, output] = await Promise.all([postPromise, outputPromise]);
  return typeof output === "string" ? output : "";
}

function readAllStdin() {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
}

module.exports = { runStatusLine };

if (require.main === module) {
  readAllStdin()
    .then((input) => runStatusLine(input))
    .then((output) => {
      if (output) process.stdout.write(output);
    })
    .catch(() => {});
}

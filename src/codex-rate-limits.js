"use strict";

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { normalizeCodexRateLimits } = require("./official-rate-limits");

const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const DEFAULT_RECONNECT_MS = 30 * 1000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10 * 1000;

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveCodexHome(options = {}) {
  const fsApi = options.fs || fs;
  const pathApi = options.path || path;
  const osApi = options.os || require("node:os");
  const explicit = nonEmptyString(options.codexHome)
    || nonEmptyString((options.env || process.env).CODEX_HOME);
  if (explicit) return explicit;

  const cwd = nonEmptyString(options.cwd) || process.cwd();
  const cwdRoot = pathApi.parse(cwd).root;
  const candidates = Array.isArray(options.candidates) ? options.candidates : [
    cwdRoot ? pathApi.join(cwdRoot, "AIData", ".codex") : null,
    pathApi.join(osApi.homedir(), ".codex"),
  ];
  const scored = [];
  const seen = new Set();
  candidates.forEach((candidate, index) => {
    const dir = nonEmptyString(candidate);
    if (!dir) return;
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) return;
    seen.add(key);
    const authPath = pathApi.join(dir, "auth.json");
    let validAuth = false;
    let activityMs = 0;
    try {
      const auth = JSON.parse(fsApi.readFileSync(authPath, "utf8"));
      validAuth = !!auth && typeof auth === "object" && Object.keys(auth).length > 0;
      activityMs = Number(fsApi.statSync(authPath).mtimeMs) || 0;
    } catch {}
    try {
      const statePath = pathApi.join(dir, ".codex-global-state.json");
      activityMs = Math.max(activityMs, Number(fsApi.statSync(statePath).mtimeMs) || 0);
    } catch {}
    let exists = validAuth;
    try { exists = exists || fsApi.existsSync(dir); } catch {}
    if (exists) scored.push({ dir, validAuth, activityMs, index });
  });
  scored.sort((a, b) => (
    Number(b.validAuth) - Number(a.validAuth)
    || b.activityMs - a.activityMs
    || a.index - b.index
  ));
  return scored.length > 0 ? scored[0].dir : pathApi.join(osApi.homedir(), ".codex");
}

function addCandidate(list, seen, command, shell, existsSync, requireExisting = true) {
  if (typeof command !== "string" || !command.trim()) return;
  const value = command.trim();
  if (requireExisting && !existsSync(value)) return;
  const key = process.platform === "win32" ? value.toLowerCase() : value;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({ command: value, shell: !!shell });
}

function getCodexLaunchCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const env = options.env || process.env;
  const existsSync = options.existsSync || fs.existsSync;
  const execFileSync = options.execFileSync || childProcess.execFileSync;
  const candidates = [];
  const seen = new Set();

  const explicit = options.command || env.CLAWD_CODEX_BIN;
  addCandidate(candidates, seen, explicit, platform === "win32" && /\.(cmd|bat)$/i.test(explicit || ""), existsSync);

  if (platform === "win32") {
    const packageArch = arch === "arm64" ? "arm64" : "x64";
    const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
    if (env.LOCALAPPDATA) {
      const binRoot = path.win32.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      try {
        const versions = (options.readdirSync || fs.readdirSync)(binRoot).slice().reverse();
        for (const version of versions) {
          addCandidate(
            candidates,
            seen,
            path.win32.join(binRoot, version, "codex.exe"),
            false,
            existsSync
          );
        }
      } catch {}
    }

    if (env.APPDATA) {
      addCandidate(
        candidates,
        seen,
        path.win32.join(
          env.APPDATA,
          "npm",
          "node_modules",
          "@openai",
          "codex",
          "node_modules",
          `@openai/codex-win32-${packageArch}`,
          "vendor",
          target,
          "bin",
          "codex.exe"
        ),
        false,
        existsSync
      );
    }

    try {
      const whereExe = env.SystemRoot
        ? path.win32.join(env.SystemRoot, "System32", "where.exe")
        : "where.exe";
      const output = execFileSync(whereExe, ["codex"], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      });
      const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines.filter((value) => /\.exe$/i.test(value))) {
        addCandidate(candidates, seen, line, false, existsSync);
      }
      for (const line of lines.filter((value) => /\.(cmd|bat)$/i.test(value))) {
        addCandidate(candidates, seen, line, true, existsSync);
      }
    } catch {}
  }

  addCandidate(candidates, seen, "codex", platform === "win32", existsSync, false);
  return candidates;
}

function createCodexRateLimitRuntime(options = {}) {
  const spawn = options.spawn || childProcess.spawn;
  const getLaunchCandidates = options.getLaunchCandidates || getCodexLaunchCandidates;
  const onSnapshot = typeof options.onSnapshot === "function" ? options.onSnapshot : () => {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const refreshMs = Number.isFinite(options.refreshMs) ? options.refreshMs : DEFAULT_REFRESH_MS;
  const reconnectMs = Number.isFinite(options.reconnectMs) ? options.reconnectMs : DEFAULT_RECONNECT_MS;
  const initializeTimeoutMs = Number.isFinite(options.initializeTimeoutMs)
    ? options.initializeTimeoutMs
    : DEFAULT_INITIALIZE_TIMEOUT_MS;

  let wanted = false;
  let child = null;
  let initialized = false;
  let nextId = 1;
  let initializeRequestId = null;
  let initializeTimer = null;
  let readRequestId = null;
  let reconnectTimer = null;
  let refreshTimer = null;
  let launchCandidates = [];
  let candidateIndex = 0;
  let stdoutBuffer = "";

  function write(message) {
    if (!child || !child.stdin || child.stdin.destroyed) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  function requestRateLimits() {
    if (!initialized || readRequestId !== null) return false;
    readRequestId = nextId++;
    return write({ method: "account/rateLimits/read", id: readRequestId, params: {} });
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;
    if (initializeRequestId !== null && message.id === initializeRequestId && !initialized) {
      if (message.error) {
        abandonChild(child, 0);
        return;
      }
      if (initializeTimer) {
        clearTimeoutFn(initializeTimer);
        initializeTimer = null;
      }
      initializeRequestId = null;
      initialized = true;
      write({ method: "initialized", params: {} });
      requestRateLimits();
      if (!refreshTimer && refreshMs > 0) {
        refreshTimer = setIntervalFn(requestRateLimits, refreshMs);
      }
      return;
    }
    if (readRequestId !== null && message.id === readRequestId) {
      readRequestId = null;
      if (message.error) return;
      const snapshot = normalizeCodexRateLimits(message.result, { observedAt: now() });
      if (snapshot.windows.length > 0) onSnapshot(snapshot);
      return;
    }
    if (message.method === "account/rateLimits/updated") {
      requestRateLimits();
    }
  }

  function handleStdout(chunk) {
    stdoutBuffer += String(chunk);
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      try { handleMessage(JSON.parse(line)); } catch {}
    }
  }

  function clearChildState() {
    child = null;
    initialized = false;
    initializeRequestId = null;
    readRequestId = null;
    stdoutBuffer = "";
    if (initializeTimer) {
      clearTimeoutFn(initializeTimer);
      initializeTimer = null;
    }
    if (refreshTimer) {
      clearIntervalFn(refreshTimer);
      refreshTimer = null;
    }
  }

  function abandonChild(active, reconnectDelay) {
    if (!active || child !== active) return;
    clearChildState();
    if (typeof active.kill === "function") {
      try { active.kill(); } catch {}
    }
    if (wanted) scheduleReconnect(reconnectDelay);
  }

  function scheduleReconnect(delay = reconnectMs) {
    if (!wanted || reconnectTimer) return;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!wanted || child) return false;
    if (candidateIndex >= launchCandidates.length) {
      launchCandidates = getLaunchCandidates(options);
      candidateIndex = 0;
    }
    const launch = launchCandidates[candidateIndex++];
    if (!launch) {
      scheduleReconnect();
      return false;
    }
    let spawned;
    try {
      spawned = spawn(
        launch.command,
        ["-s", "read-only", "-a", "untrusted", "app-server"],
        {
          shell: launch.shell,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            ...(options.codexHome ? { CODEX_HOME: options.codexHome } : {}),
          },
        }
      );
    } catch {
      scheduleReconnect(0);
      return false;
    }
    child = spawned;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", handleStdout);
    child.stderr.resume();
    child.on("error", () => {});
    child.on("close", () => {
      if (child !== spawned) return;
      const wasInitialized = initialized;
      clearChildState();
      if (wanted) scheduleReconnect(wasInitialized ? reconnectMs : 0);
    });
    const initializeId = nextId++;
    initializeRequestId = initializeId;
    write({
      method: "initialize",
      id: initializeId,
      params: {
        clientInfo: {
          name: "clawd_on_desk",
          title: "Clawd on Desk",
          version: options.version || "unknown",
        },
      },
    });
    if (initializeTimeoutMs > 0) {
      initializeTimer = setTimeoutFn(() => {
        if (child === spawned && !initialized) abandonChild(spawned, 0);
      }, initializeTimeoutMs);
    }
    return true;
  }

  function start() {
    wanted = true;
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    launchCandidates = getLaunchCandidates(options);
    candidateIndex = 0;
    return connect();
  }

  function stop() {
    wanted = false;
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    if (refreshTimer) {
      clearIntervalFn(refreshTimer);
      refreshTimer = null;
    }
    const active = child;
    clearChildState();
    if (active && typeof active.kill === "function") {
      try { active.kill(); } catch {}
    }
  }

  function refresh() {
    if (child) return requestRateLimits();
    if (!wanted) return start();
    return connect();
  }

  return { start, stop, refresh };
}

module.exports = {
  DEFAULT_INITIALIZE_TIMEOUT_MS,
  DEFAULT_RECONNECT_MS,
  DEFAULT_REFRESH_MS,
  createCodexRateLimitRuntime,
  getCodexLaunchCandidates,
  resolveCodexHome,
};

"use strict";

const childProcess = require("child_process");

function quoteForCmd(value) {
  const text = String(value || "");
  if (!text) return '""';
  if (!/[\s"&<>|^:\\/]/.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

function quoteForPosixShellArg(value) {
  const text = String(value || "");
  if (!text) return "''";
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function escapeAppleScriptString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object" || config.enabled !== true) {
    return { enabled: false };
  }
  return {
    enabled: true,
    executablePath: typeof config.executablePath === "string" ? config.executablePath.trim() : "",
    workspacePath: typeof config.workspacePath === "string" ? config.workspacePath.trim() : "",
    launchMode: config.launchMode === "direct" ? "direct" : "terminal",
  };
}

function spawnDetached(spawn, bin, args, opts) {
  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    ...opts,
  });
  if (child && typeof child.on === "function") child.on("error", () => {});
  if (child && typeof child.unref === "function") child.unref();
  return child;
}

function launchDirect(config, deps) {
  spawnDetached(deps.spawn, config.executablePath, [], {
    cwd: config.workspacePath || undefined,
  });
  return { status: "ok", terminal: null };
}

function launchWindowsTerminal(config, deps) {
  const command = quoteForCmd(config.executablePath);
  spawnDetached(deps.spawn, "cmd.exe", ["/d", "/v:off", "/s", "/k", command], {
    cwd: config.workspacePath || undefined,
    shell: false,
    windowsVerbatimArguments: true,
  });
  return { status: "ok", terminal: "cmd" };
}

function launchMacTerminal(config, deps) {
  const parts = [];
  if (config.workspacePath) parts.push(`cd ${quoteForPosixShellArg(config.workspacePath)}`);
  parts.push(quoteForPosixShellArg(config.executablePath));
  const script = `tell application "Terminal" to do script "${escapeAppleScriptString(parts.join(" && "))}"`;
  spawnDetached(deps.spawn, "osascript", ["-e", script], {});
  return { status: "ok", terminal: "Terminal.app" };
}

function launchLinuxTerminal(config, deps) {
  const parts = [];
  if (config.workspacePath) parts.push(`cd ${quoteForPosixShellArg(config.workspacePath)}`);
  parts.push(quoteForPosixShellArg(config.executablePath));
  const command = parts.join(" && ");
  const candidates = [
    deps.env && deps.env.TERMINAL ? [deps.env.TERMINAL, "-e", "sh", "-lc", command] : null,
    ["gnome-terminal", "--", "sh", "-lc", command],
    ["konsole", "-e", "sh", "-lc", command],
    ["xterm", "-e", "sh", "-lc", command],
    ["x-terminal-emulator", "-e", "sh", "-lc", command],
  ].filter(Boolean);
  let lastError = null;
  for (const [bin, ...args] of candidates) {
    try {
      spawnDetached(deps.spawn, bin, args, {});
      return { status: "ok", terminal: bin };
    } catch (err) {
      lastError = err;
    }
  }
  return { status: "error", message: (lastError && lastError.message) || "no supported terminal emulator found" };
}

function launchTerminal(config, deps) {
  if (deps.platform === "win32") return launchWindowsTerminal(config, deps);
  if (deps.platform === "darwin") return launchMacTerminal(config, deps);
  return launchLinuxTerminal(config, deps);
}

function launchPetClickAction(config, deps = {}) {
  const normalized = normalizeConfig(config);
  if (!normalized.enabled) return { status: "skipped", reason: "disabled" };
  if (!normalized.executablePath) return { status: "skipped", reason: "missing-executable" };
  const resolvedDeps = {
    spawn: deps.spawn || childProcess.spawn,
    platform: deps.platform || process.platform,
    env: deps.env || process.env,
  };
  try {
    if (normalized.launchMode === "direct") return launchDirect(normalized, resolvedDeps);
    return launchTerminal(normalized, resolvedDeps);
  } catch (err) {
    return { status: "error", message: (err && err.message) || String(err) };
  }
}

module.exports = {
  launchPetClickAction,
  quoteForCmd,
  quoteForPosixShellArg,
};

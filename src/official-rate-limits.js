"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FIVE_HOUR_MINUTES = 5 * 60;
const SEVEN_DAY_MINUTES = 7 * 24 * 60;

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePercent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.min(100, Math.max(0, number));
}

function normalizeEpochMs(value) {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  return number < 10_000_000_000 ? Math.round(number * 1000) : Math.round(number);
}

function kindForDuration(durationMinutes) {
  if (durationMinutes === FIVE_HOUR_MINUTES) return "fiveHour";
  if (durationMinutes === SEVEN_DAY_MINUTES) return "sevenDay";
  return "custom";
}

function normalizeWindow(input, durationMinutes) {
  if (!input || typeof input !== "object") return null;
  const usedPercent = normalizePercent(input.usedPercent ?? input.used_percentage);
  const resetsAt = normalizeEpochMs(input.resetsAt ?? input.resets_at);
  const duration = finiteNumber(
    input.windowDurationMins ?? input.window_duration_mins ?? durationMinutes
  );
  if (usedPercent === null || resetsAt === null || duration === null || duration <= 0) return null;
  const normalizedDuration = Math.round(duration);
  return {
    kind: kindForDuration(normalizedDuration),
    durationMinutes: normalizedDuration,
    usedPercent,
    resetsAt,
  };
}

function observedAtFrom(options) {
  return Number.isFinite(options && options.observedAt)
    ? options.observedAt
    : Date.now();
}

function normalizeClaudeRateLimits(input, options = {}) {
  const rateLimits = input && typeof input === "object"
    ? (input.rate_limits || input.rateLimits || input)
    : {};
  const windows = [
    normalizeWindow(rateLimits.five_hour || rateLimits.fiveHour, FIVE_HOUR_MINUTES),
    normalizeWindow(rateLimits.seven_day || rateLimits.sevenDay, SEVEN_DAY_MINUTES),
  ].filter(Boolean);
  return {
    agentId: "claude-code",
    source: "claude-statusline",
    observedAt: observedAtFrom(options),
    windows,
  };
}

function normalizeCodexRateLimits(input, options = {}) {
  const result = input && typeof input === "object" && input.result && typeof input.result === "object"
    ? input.result
    : input;
  const rateLimits = result && typeof result === "object"
    ? (result.rateLimits || result.rate_limits || result)
    : {};
  const windows = [rateLimits.primary, rateLimits.secondary]
    .map((window) => normalizeWindow(window))
    .filter(Boolean)
    .sort((a, b) => a.durationMinutes - b.durationMinutes);
  const planType = typeof rateLimits.planType === "string" && rateLimits.planType
    ? rateLimits.planType
    : (typeof result?.planType === "string" && result.planType ? result.planType : null);
  const normalized = {
    agentId: "codex",
    source: "codex-app-server",
    observedAt: observedAtFrom(options),
  };
  if (planType) normalized.planType = planType;
  normalized.windows = windows;
  return normalized;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isUsableSnapshot(snapshot) {
  return !!snapshot
    && typeof snapshot === "object"
    && typeof snapshot.agentId === "string"
    && snapshot.agentId.length > 0
    && typeof snapshot.source === "string"
    && snapshot.source.length > 0
    && Number.isFinite(snapshot.observedAt)
    && Array.isArray(snapshot.windows)
    && snapshot.windows.length > 0;
}

function readStoredAgents(filePath, fsApi) {
  if (!filePath) return {};
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, "utf8"));
    const agents = parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object"
      ? parsed.agents
      : parsed;
    const usable = {};
    for (const [agentId, snapshot] of Object.entries(agents || {})) {
      if (!isUsableSnapshot(snapshot) || snapshot.agentId !== agentId) continue;
      usable[agentId] = cloneJson(snapshot);
    }
    return usable;
  } catch {
    return {};
  }
}

function createOfficialRateLimitStore(options = {}) {
  const fsApi = options.fs || fs;
  const filePath = options.filePath || null;
  const agents = readStoredAgents(filePath, fsApi);

  function persist() {
    if (!filePath) return;
    const dir = path.dirname(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fsApi.mkdirSync(dir, { recursive: true });
    try {
      fsApi.writeFileSync(tempPath, JSON.stringify({ version: 1, agents }, null, 2), "utf8");
      fsApi.renameSync(tempPath, filePath);
    } catch (err) {
      try { fsApi.unlinkSync(tempPath); } catch {}
      throw err;
    }
  }

  function set(snapshot) {
    if (!isUsableSnapshot(snapshot)) return false;
    agents[snapshot.agentId] = cloneJson(snapshot);
    persist();
    return true;
  }

  function clear(agentId) {
    if (!Object.prototype.hasOwnProperty.call(agents, agentId)) return false;
    delete agents[agentId];
    persist();
    return true;
  }

  function getSnapshot() {
    return cloneJson(agents);
  }

  return { set, clear, getSnapshot };
}

module.exports = {
  FIVE_HOUR_MINUTES,
  SEVEN_DAY_MINUTES,
  createOfficialRateLimitStore,
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
};

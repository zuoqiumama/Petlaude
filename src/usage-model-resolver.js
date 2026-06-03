"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

function safeString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function safeModel(value) {
  const model = safeString(value);
  if (!model || model.toLowerCase() === "unknown" || model === "<synthetic>") return null;
  return model;
}

function normalizeCodexSessionId(sessionId) {
  const text = safeString(sessionId);
  if (!text) return null;
  return text.startsWith("codex:") ? text.slice("codex:".length) : text;
}

function isCodexEvent(event) {
  const agentId = safeString(event && event.agentId);
  const source = safeString(event && event.source);
  return agentId === "codex" || source === "codex";
}

function isClaudeEvent(event) {
  const agentId = safeString(event && event.agentId);
  const source = safeString(event && event.source);
  return agentId === "claude-code" || source === "claude-code" || source === "claude";
}

function existingDir(fsApi, dir) {
  try {
    return dir && fsApi.existsSync(dir) && fsApi.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

function uniqueExistingDirs(fsApi, dirs) {
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    const existing = existingDir(fsApi, dir);
    if (!existing) continue;
    const key = existing.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(existing);
  }
  return out;
}

function defaultCodexHomes(options) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const osApi = options.osApi || os;
  const configured = safeString(options.codexHome) || safeString(process.env.CODEX_HOME);
  const cwdRoot = pathApi.parse(process.cwd()).root;
  return uniqueExistingDirs(fsApi, [
    configured,
    pathApi.join(osApi.homedir(), ".codex"),
    cwdRoot ? pathApi.join(cwdRoot, "AIData", ".codex") : null,
  ]);
}

function defaultClaudeProjectsDirs(options) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const osApi = options.osApi || os;
  return uniqueExistingDirs(fsApi, [
    safeString(options.claudeProjectsDir),
    pathApi.join(osApi.homedir(), ".claude", "projects"),
  ]);
}

function uuidV7DateDirs(pathApi, root, uuid) {
  const compact = String(uuid || "").replace(/-/g, "");
  const timestampHex = compact.slice(0, 12);
  if (!/^[0-9a-fA-F]{12}$/.test(timestampHex)) return [];
  const ms = Number.parseInt(timestampHex, 16);
  if (!Number.isFinite(ms) || ms <= 0) return [];
  const dates = [];
  for (const d of [new Date(ms), new Date(ms + new Date(ms).getTimezoneOffset() * -60000)]) {
    if (Number.isNaN(d.getTime())) continue;
    const yyyy = String(d.getFullYear());
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    dates.push(pathApi.join(root, yyyy, mm, dd));
  }
  return Array.from(new Set(dates));
}

function findFileByName(fsApi, pathApi, root, predicate, options = {}) {
  const maxDirs = Number.isFinite(options.maxDirs) ? options.maxDirs : 20000;
  const stack = [root];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop();
    if (++visited > maxDirs) return null;
    let entries;
    try {
      entries = fsApi.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = pathApi.join(dir, entry.name);
      if (entry.isFile() && predicate(entry.name, full)) return full;
      if (entry.isDirectory()) stack.push(full);
    }
  }
  return null;
}

function readJsonlModels(fsApi, filePath, pickModel, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 2 * 1024 * 1024;
  let text;
  try {
    const stat = fsApi.statSync(filePath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fsApi.openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - start);
    fsApi.readSync(fd, buf, 0, buf.length, start);
    fsApi.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] && lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const model = pickModel(obj);
    if (model) return model;
  }
  return null;
}

function pickCodexModel(obj) {
  const payload = obj && obj.payload && typeof obj.payload === "object" ? obj.payload : null;
  return safeModel(payload && payload.model) ||
    safeModel(payload && payload.model_id) ||
    safeModel(payload && payload.model_slug) ||
    safeModel(obj && obj.model);
}

function pickClaudeModel(obj) {
  if (!obj || obj.type !== "assistant" || obj.isApiErrorMessage) return null;
  const message = obj.message && typeof obj.message === "object" ? obj.message : null;
  const hasUsage = Boolean(
    (message && message.usage && typeof message.usage === "object") ||
    (obj.usage && typeof obj.usage === "object")
  );
  if (!hasUsage) return null;
  return safeModel(message && message.model) || safeModel(obj.model);
}

function createUsageModelResolver(options = {}) {
  const fsApi = options.fsApi || fs;
  const pathApi = options.pathApi || path;
  const codexHomes = defaultCodexHomes({ ...options, fsApi, pathApi });
  const claudeProjectsDirs = defaultClaudeProjectsDirs({ ...options, fsApi, pathApi });
  const cache = new Map();

  function cacheKey(prefix, sessionId) {
    return `${prefix}:${sessionId}`;
  }

  function resolveCodexModel(sessionId) {
    const uuid = normalizeCodexSessionId(sessionId);
    if (!uuid) return null;
    const key = cacheKey("codex", uuid);
    if (cache.has(key)) return cache.get(key);
    let model = null;
    for (const home of codexHomes) {
      const sessionsRoot = pathApi.join(home, "sessions");
      const candidates = uuidV7DateDirs(pathApi, sessionsRoot, uuid);
      let file = null;
      for (const dir of candidates) {
        file = findFileByName(fsApi, pathApi, dir, (name) => name.endsWith(`${uuid}.jsonl`), { maxDirs: 4 });
        if (file) break;
      }
      if (!file) {
        file = findFileByName(fsApi, pathApi, sessionsRoot, (name) => name.endsWith(`${uuid}.jsonl`));
      }
      if (!file) continue;
      model = readJsonlModels(fsApi, file, pickCodexModel);
      if (model) break;
    }
    cache.set(key, model);
    return model;
  }

  function resolveClaudeModel(sessionId) {
    const id = safeString(sessionId);
    if (!id) return null;
    const key = cacheKey("claude", id);
    if (cache.has(key)) return cache.get(key);
    let model = null;
    for (const root of claudeProjectsDirs) {
      const file = findFileByName(fsApi, pathApi, root, (name) => name === `${id}.jsonl`);
      if (!file) continue;
      model = readJsonlModels(fsApi, file, pickClaudeModel);
      if (model) break;
    }
    cache.set(key, model);
    return model;
  }

  function resolveModelForEvent(event = {}) {
    if (safeModel(event.model)) return safeModel(event.model);
    if (isCodexEvent(event)) return resolveCodexModel(event.sessionId);
    if (isClaudeEvent(event)) return resolveClaudeModel(event.sessionId);
    return null;
  }

  return {
    resolveModelForEvent,
  };
}

module.exports = {
  createUsageModelResolver,
};

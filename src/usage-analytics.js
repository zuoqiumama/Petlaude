"use strict";

const { computeUsageCost } = require("./usage-pricing");

const CANONICAL_USAGE_SCHEMA = "clawd-usage-v2";

const ACTIVE_STATES = new Set([
  "thinking",
  "working",
  "juggling",
  "sweeping",
  "attention",
  "notification",
  "error",
  "carrying",
  "codex-permission",
]);

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_HOUR_MS = 30 * 60 * 1000;
const INVALID_TOKEN = Symbol("invalid-token");

const TOKEN_KEYS = {
  input: [
    "input",
    "input_tokens",
    "prompt_tokens",
    "promptTokenCount",
    "prompt_token_count",
    "tokensIn",
    "inputTokens",
  ],
  cachedInput: [
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cacheReadTokens",
    "cache_read",
    "cacheRead",
    "cached",
  ],
  cacheCreationInput: [
    "cache_creation_input_tokens",
    "cache_write_input_tokens",
    "cacheWriteTokens",
    "cacheCreationTokens",
    "cache_creation",
    "cacheCreation",
    "cache_write",
    "cacheWrite",
  ],
  output: [
    "output",
    "output_tokens",
    "completion_tokens",
    "candidatesTokenCount",
    "candidates_token_count",
    "tokensOut",
    "outputTokens",
  ],
  reasoningOutput: [
    "reasoning_output_tokens",
    "reasoning_tokens",
    "reasoningTokens",
    "thoughts_tokens",
    "thinking_tokens",
    "thoughtsTokenCount",
  ],
  total: [
    "total",
    "total_tokens",
    "totalTokenCount",
    "total_token_count",
    "totalTokens",
  ],
};

function finiteToken(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstToken(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = finiteToken(source[key]);
    if (value !== null) return value;
    return INVALID_TOKEN;
  }
  return null;
}

function candidateTokenSources(input) {
  const sources = [];
  if (!input || typeof input !== "object") return sources;
  sources.push(input);
  for (const key of [
    "token_usage",
    "tokenUsage",
    "usage",
    "tokens",
    "last_token_usage",
    "lastTokenUsage",
    "total_token_usage",
    "totalTokenUsage",
  ]) {
    if (input[key] && typeof input[key] === "object") sources.push(input[key]);
  }
  if (input.info && typeof input.info === "object") {
    for (const key of ["last_token_usage", "lastTokenUsage", "total_token_usage", "totalTokenUsage"]) {
      if (input.info[key] && typeof input.info[key] === "object") sources.push(input.info[key]);
    }
  }
  return sources;
}

function normalizeSource(value) {
  const source = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!source) return "";
  if (source === "copilot-cli") return "copilot";
  return source;
}

function shouldSubtractCachedInput(source) {
  return source === "codex" || source === "every-code" || source === "copilot";
}

function isCanonicalUsage(input, source) {
  return Boolean(
    (input && input.schema === CANONICAL_USAGE_SCHEMA) ||
    (source && source.schema === CANONICAL_USAGE_SCHEMA)
  );
}

function normalizeTokenUsage(input, options = {}) {
  const sourceName = normalizeSource(options.source || options.agentId);
  for (const source of candidateTokenSources(input)) {
    const inputTokens = firstToken(source, TOKEN_KEYS.input);
    const cachedInputTokens = firstToken(source, TOKEN_KEYS.cachedInput);
    const cacheCreationInputTokens = firstToken(source, TOKEN_KEYS.cacheCreationInput);
    const outputTokens = firstToken(source, TOKEN_KEYS.output);
    const reasoningOutputTokens = firstToken(source, TOKEN_KEYS.reasoningOutput);
    const totalTokens = firstToken(source, TOKEN_KEYS.total);
    if (
      inputTokens === INVALID_TOKEN ||
      cachedInputTokens === INVALID_TOKEN ||
      cacheCreationInputTokens === INVALID_TOKEN ||
      outputTokens === INVALID_TOKEN ||
      reasoningOutputTokens === INVALID_TOKEN ||
      totalTokens === INVALID_TOKEN
    ) {
      return null;
    }

    const hasBreakdown =
      inputTokens !== null ||
      cachedInputTokens !== null ||
      cacheCreationInputTokens !== null ||
      outputTokens !== null ||
      reasoningOutputTokens !== null;

    if (hasBreakdown) {
      let inputValue = inputTokens ?? 0;
      const cachedValue = cachedInputTokens ?? 0;
      const cacheCreationValue = cacheCreationInputTokens ?? 0;
      const outputValue = outputTokens ?? 0;
      const reasoningValue = reasoningOutputTokens ?? 0;
      const canonical = isCanonicalUsage(input, source);
      if (
        !canonical &&
        cachedValue > 0 &&
        inputValue >= cachedValue &&
        shouldSubtractCachedInput(sourceName)
      ) {
        inputValue -= cachedValue;
      }

      const computedTotal =
        inputValue +
        cachedValue +
        cacheCreationValue +
        outputValue +
        reasoningValue;
      const totalValue = totalTokens !== null && totalTokens >= computedTotal
        ? totalTokens
        : computedTotal;
      return {
        schema: CANONICAL_USAGE_SCHEMA,
        input: inputTokens !== null ? inputValue : null,
        output: outputTokens !== null ? outputValue : null,
        total: totalValue,
        hasInputOutput: inputTokens !== null || outputTokens !== null,
        input_tokens: inputValue,
        cached_input_tokens: cachedValue,
        cache_creation_input_tokens: cacheCreationValue,
        output_tokens: outputValue,
        reasoning_output_tokens: reasoningValue,
        total_tokens: totalValue,
        billable_total_tokens: totalValue,
        unattributed_tokens: Math.max(0, totalValue - computedTotal),
        hasTokenBreakdown: true,
      };
    }

    if (totalTokens !== null) {
      return {
        schema: CANONICAL_USAGE_SCHEMA,
        input: null,
        output: null,
        total: totalTokens,
        hasInputOutput: false,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: totalTokens,
        billable_total_tokens: totalTokens,
        unattributed_tokens: totalTokens,
        hasTokenBreakdown: false,
      };
    }
  }
  return null;
}

function localDayKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localMonthKey(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function localStartOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dayKeyToMs(day) {
  if (typeof day !== "string") return NaN;
  const parts = day.split("-").map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return NaN;
  return new Date(parts[0], parts[1] - 1, parts[2]).getTime();
}

function utcHalfHourBucketKey(ms) {
  return new Date(Math.floor(ms / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

function makeTotals() {
  return {
    tokens: 0,
    billableTokens: 0,
    input: 0,
    output: 0,
    cachedInput: 0,
    cacheCreationInput: 0,
    reasoningOutput: 0,
    unattributed: 0,
    costUsd: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    tokenEvents: 0,
    sessionMs: 0,
    activeMs: 0,
    conversationCount: 0,
    _sessionIds: new Set(),
  };
}

function makeAgent(agentId) {
  return {
    agentId,
    ...makeTotals(),
  };
}

function makeModel(model, source) {
  return {
    model,
    source,
    ...makeTotals(),
  };
}

function makeSource(source) {
  return {
    source,
    ...makeTotals(),
  };
}

function projectNameFromRef(projectRef) {
  const value = typeof projectRef === "string" ? projectRef.trim() : "";
  if (!value || value === "unknown") return "Unknown";
  const normalized = value.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normalized;
}

function makeProject(projectRef) {
  const ref = projectRef || "unknown";
  return {
    projectRef: ref,
    name: projectNameFromRef(ref),
    ...makeTotals(),
  };
}

function makeUsageEntry(keyName, keyValue) {
  return {
    [keyName]: keyValue,
    totals: makeTotals(),
    agents: new Map(),
    models: new Map(),
    sources: new Map(),
    projects: new Map(),
  };
}

function ensureEntry(map, keyName, keyValue) {
  if (!map.has(keyValue)) {
    map.set(keyValue, makeUsageEntry(keyName, keyValue));
  }
  return map.get(keyValue);
}

function ensureDay(days, day) {
  return ensureEntry(days, "day", day);
}

function ensureBucket(buckets, bucket) {
  return ensureEntry(buckets, "bucket", bucket);
}

function ensureMonth(months, month) {
  return ensureEntry(months, "month", month);
}

function ensureAgent(entry, agentId) {
  const id = agentId || "unknown";
  if (!entry.agents.has(id)) entry.agents.set(id, makeAgent(id));
  return entry.agents.get(id);
}

function ensureModel(entry, model, source) {
  const modelId = model || "unknown";
  const sourceId = source || "unknown";
  const key = `${sourceId}|${modelId}`;
  if (!entry.models.has(key)) entry.models.set(key, makeModel(modelId, sourceId));
  return entry.models.get(key);
}

function ensureSource(entry, source) {
  const id = source || "unknown";
  if (!entry.sources.has(id)) entry.sources.set(id, makeSource(id));
  return entry.sources.get(id);
}

function ensureProject(entry, projectRef) {
  const ref = projectRef || "unknown";
  if (!entry.projects.has(ref)) entry.projects.set(ref, makeProject(ref));
  return entry.projects.get(ref);
}

function addUsageTotals(target, usage, costInfo, sessionId) {
  const tokens = Number(usage.total_tokens) || 0;
  target.tokens += tokens;
  target.billableTokens += Number(usage.billable_total_tokens) || tokens;
  target.input += Number(usage.input_tokens) || 0;
  target.output += Number(usage.output_tokens) || 0;
  target.cachedInput += Number(usage.cached_input_tokens) || 0;
  target.cacheCreationInput += Number(usage.cache_creation_input_tokens) || 0;
  target.reasoningOutput += Number(usage.reasoning_output_tokens) || 0;
  target.unattributed += Number(usage.unattributed_tokens) || 0;
  target.costUsd += Number(costInfo.costUsd) || 0;
  if (costInfo.pricingKnown) target.pricedTokens += tokens;
  else target.unpricedTokens += tokens;
  target.tokenEvents += 1;
  const conversationId = safeString(sessionId);
  if (conversationId && target._sessionIds instanceof Set) {
    target._sessionIds.add(conversationId);
    target.conversationCount = target._sessionIds.size;
  }
}

function dimensionsForUsage(event) {
  const agentId = event.agentId || "unknown";
  const source = normalizeSource(event.source || event.agentId) || agentId;
  const model = typeof event.model === "string" && event.model.trim()
    ? event.model.trim()
    : "unknown";
  const projectRef = safeString(event.cwd) ||
    safeString(event.projectRef) ||
    safeString(event.project) ||
    "unknown";
  return {
    agentId,
    source,
    model,
    projectRef,
    sessionId: event.sessionId || "default",
  };
}

function addTokenToEntry(entry, dimensions, usage, costInfo) {
  addUsageTotals(entry.totals, usage, costInfo, dimensions.sessionId);
  addUsageTotals(ensureAgent(entry, dimensions.agentId), usage, costInfo, dimensions.sessionId);
  addUsageTotals(ensureSource(entry, dimensions.source), usage, costInfo, dimensions.sessionId);
  addUsageTotals(ensureModel(entry, dimensions.model, dimensions.source), usage, costInfo, dimensions.sessionId);
  addUsageTotals(ensureProject(entry, dimensions.projectRef), usage, costInfo, dimensions.sessionId);
}

function addToken(aggregates, at, event, usage) {
  const dimensions = dimensionsForUsage(event);
  const costInfo = computeUsageCost(usage, { model: dimensions.model, source: dimensions.source });
  addTokenToEntry(ensureDay(aggregates.days, localDayKey(at)), dimensions, usage, costInfo);
  addTokenToEntry(ensureBucket(aggregates.buckets, utcHalfHourBucketKey(at)), dimensions, usage, costInfo);
  addTokenToEntry(ensureMonth(aggregates.months, localMonthKey(at)), dimensions, usage, costInfo);
}

function nextLocalMidnight(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function addDuration(days, start, end, agentId, field) {
  let cursor = start;
  while (cursor < end) {
    const next = Math.min(end, nextLocalMidnight(cursor));
    const delta = Math.max(0, next - cursor);
    const dayEntry = ensureDay(days, localDayKey(cursor));
    const agent = ensureAgent(dayEntry, agentId);
    dayEntry.totals[field] += delta;
    agent[field] += delta;
    cursor = next;
  }
}

const TOTAL_COPY_FIELDS = [
  "tokens",
  "billableTokens",
  "input",
  "output",
  "cachedInput",
  "cacheCreationInput",
  "reasoningOutput",
  "unattributed",
  "costUsd",
  "pricedTokens",
  "unpricedTokens",
  "tokenEvents",
  "sessionMs",
  "activeMs",
  "conversationCount",
];

function copyTotals(target, source) {
  TOTAL_COPY_FIELDS.forEach((field) => {
    target[field] = Number(source && source[field]) || 0;
  });
  target._sessionIds = source && source._sessionIds instanceof Set
    ? new Set(source._sessionIds)
    : new Set();
  target.conversationCount = target._sessionIds.size || target.conversationCount;
}

function mergeTotals(target, source) {
  TOTAL_COPY_FIELDS.forEach((field) => {
    if (field === "conversationCount") return;
    target[field] += Number(source && source[field]) || 0;
  });
  if (source && source._sessionIds instanceof Set) {
    for (const sessionId of source._sessionIds) target._sessionIds.add(sessionId);
    target.conversationCount = target._sessionIds.size;
  } else {
    target.conversationCount += Number(source && source.conversationCount) || 0;
  }
}

function mergeEntryMap(targetMap, sourceMap, ensureTarget) {
  for (const row of sourceMap ? sourceMap.values() : []) {
    mergeTotals(ensureTarget(row), row);
  }
}

function mergeUsageEntry(target, source) {
  if (!source) return;
  mergeTotals(target.totals, source.totals);
  mergeEntryMap(target.agents, source.agents, (row) => ensureAgent(target, row.agentId));
  mergeEntryMap(target.sources, source.sources, (row) => ensureSource(target, row.source));
  mergeEntryMap(target.models, source.models, (row) => ensureModel(target, row.model, row.source));
  mergeEntryMap(target.projects, source.projects, (row) => ensureProject(target, row.projectRef));
}

function aggregateUsageEntries(entries) {
  const aggregate = makeUsageEntry("period", "aggregate");
  for (const entry of entries || []) mergeUsageEntry(aggregate, entry);
  return aggregate;
}

function cloneDays(days) {
  const cloned = new Map();
  for (const [day, entry] of days.entries()) {
    const out = ensureDay(cloned, day);
    copyTotals(out.totals, entry.totals);
    for (const [agentId, agent] of entry.agents.entries()) {
      copyTotals(ensureAgent(out, agentId), agent);
    }
    for (const [sourceId, source] of entry.sources.entries()) {
      copyTotals(ensureSource(out, sourceId), source);
    }
    for (const [, model] of entry.models.entries()) {
      copyTotals(ensureModel(out, model.model, model.source), model);
    }
    for (const [, project] of entry.projects.entries()) {
      copyTotals(ensureProject(out, project.projectRef), project);
    }
  }
  return cloned;
}

function sortUsageRows(a, b) {
  return (
    b.tokens - a.tokens ||
    b.costUsd - a.costUsd ||
    b.sessionMs - a.sessionMs ||
    b.activeMs - a.activeMs ||
    String(a.agentId || a.source || a.model || a.projectRef).localeCompare(String(b.agentId || b.source || b.model || b.projectRef))
  );
}

function roundCost(value) {
  return Math.round((Number(value) || 0) * 1_000_000) / 1_000_000;
}

function normalizeTotalsForOutput(totals) {
  const conversationCount = totals && totals._sessionIds instanceof Set
    ? totals._sessionIds.size
    : Number(totals && totals.conversationCount) || 0;
  const costUsd = roundCost(totals && totals.costUsd);
  return {
    tokens: Number(totals && totals.tokens) || 0,
    billableTokens: Number(totals && totals.billableTokens) || 0,
    input: Number(totals && totals.input) || 0,
    output: Number(totals && totals.output) || 0,
    cachedInput: Number(totals && totals.cachedInput) || 0,
    cacheCreationInput: Number(totals && totals.cacheCreationInput) || 0,
    reasoningOutput: Number(totals && totals.reasoningOutput) || 0,
    unattributed: Number(totals && totals.unattributed) || 0,
    costUsd,
    pricedTokens: Number(totals && totals.pricedTokens) || 0,
    unpricedTokens: Number(totals && totals.unpricedTokens) || 0,
    tokenEvents: Number(totals && totals.tokenEvents) || 0,
    sessionMs: Number(totals && totals.sessionMs) || 0,
    activeMs: Number(totals && totals.activeMs) || 0,
    conversationCount,
    total_tokens: Number(totals && totals.tokens) || 0,
    billable_total_tokens: Number(totals && totals.billableTokens) || 0,
    input_tokens: Number(totals && totals.input) || 0,
    output_tokens: Number(totals && totals.output) || 0,
    cached_input_tokens: Number(totals && totals.cachedInput) || 0,
    cache_creation_input_tokens: Number(totals && totals.cacheCreationInput) || 0,
    reasoning_output_tokens: Number(totals && totals.reasoningOutput) || 0,
    unattributed_tokens: Number(totals && totals.unattributed) || 0,
    total_cost_usd: costUsd,
    estimated_cost_usd: costUsd,
    conversation_count: conversationCount,
  };
}

function addRowAliases(row) {
  return {
    ...row,
    total_tokens: row.totals.total_tokens,
    billable_total_tokens: row.totals.billable_total_tokens,
    input_tokens: row.totals.input_tokens,
    output_tokens: row.totals.output_tokens,
    cached_input_tokens: row.totals.cached_input_tokens,
    cache_creation_input_tokens: row.totals.cache_creation_input_tokens,
    reasoning_output_tokens: row.totals.reasoning_output_tokens,
    total_cost_usd: row.totals.total_cost_usd,
    estimated_cost_usd: row.totals.estimated_cost_usd,
    conversation_count: row.totals.conversation_count,
  };
}

function serializeUsageEntry(entry, keyName) {
  function rowWithTotals(meta, value) {
    const totals = normalizeTotalsForOutput(value);
    return { ...meta, ...totals, totals };
  }
  const row = {
    [keyName]: entry[keyName],
    totals: normalizeTotalsForOutput(entry.totals),
    agents: Array.from(entry.agents.values())
      .map((agent) => rowWithTotals({ agentId: agent.agentId }, agent))
      .sort(sortUsageRows),
    sources: Array.from(entry.sources.values())
      .map((source) => rowWithTotals({ source: source.source }, source))
      .sort(sortUsageRows),
    models: Array.from(entry.models.values())
      .map((model) => rowWithTotals({ model: model.model, source: model.source }, model))
      .sort(sortUsageRows),
    projects: Array.from(entry.projects.values())
      .map((project) => rowWithTotals({ projectRef: project.projectRef, name: project.name }, project))
      .sort(sortUsageRows),
  };
  return addRowAliases(row);
}

function serializeAggregateEntry(entry) {
  return serializeUsageEntry({ ...entry, period: entry.period || "aggregate" }, "period");
}

function serializeDay(dayEntry) {
  return {
    ...serializeUsageEntry(dayEntry, "day"),
  };
}

function dayKeyForOffset(now, offset) {
  const d = new Date(now);
  d.setDate(d.getDate() - offset);
  return localDayKey(d.getTime());
}

function getProjectedEntry(projected, key) {
  return projected.get(key) || makeUsageEntry("day", key);
}

function rollingWindow(projected, at, days, label) {
  const entries = [];
  for (let i = days - 1; i >= 0; i--) {
    entries.push(getProjectedEntry(projected, dayKeyForOffset(at, i)));
  }
  const aggregate = aggregateUsageEntries(entries);
  aggregate.period = label;
  const serialized = serializeAggregateEntry(aggregate);
  const activeDays = entries.filter((entry) => Number(entry.totals.tokens) > 0).length;
  return {
    ...serialized,
    days,
    activeDays,
    active_days: activeDays,
    avgTokensPerActiveDay: activeDays > 0
      ? Math.round(serialized.totals.tokens / activeDays)
      : 0,
    avg_tokens_per_active_day: activeDays > 0
      ? Math.round(serialized.totals.tokens / activeDays)
      : 0,
  };
}

function serializeBucketEntry(entry) {
  return serializeUsageEntry(entry, "bucket");
}

function serializeMonthEntry(entry) {
  return serializeUsageEntry(entry, "month");
}

function buildHourlyTrend(buckets, at) {
  const currentBucket = Math.floor(at / HALF_HOUR_MS) * HALF_HOUR_MS;
  const rows = [];
  for (let i = 47; i >= 0; i--) {
    const key = new Date(currentBucket - i * HALF_HOUR_MS).toISOString();
    rows.push(serializeBucketEntry(buckets.get(key) || makeUsageEntry("bucket", key)));
  }
  return rows;
}

function buildMonthlyTrend(months) {
  return Array.from(months.values())
    .map(serializeMonthEntry)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
}

function contextItem(label, tokens, totalTokens) {
  const value = Number(tokens) || 0;
  return {
    label,
    tokens: value,
    total_tokens: value,
    percent: totalTokens > 0 ? Math.round(value / totalTokens * 1000) / 10 : 0,
  };
}

function contextBreakdownForTotals(totals) {
  const totalTokens = Number(totals && totals.tokens) || 0;
  return {
    input: contextItem("Messages / input", totals && totals.input, totalTokens),
    cacheRead: contextItem("Cached input", totals && totals.cachedInput, totalTokens),
    cacheWrite: contextItem("Cache creation", totals && totals.cacheCreationInput, totalTokens),
    output: contextItem("Output", totals && totals.output, totalTokens),
    reasoning: contextItem("Reasoning output", totals && totals.reasoningOutput, totalTokens),
    unattributed: contextItem("Unattributed", totals && totals.unattributed, totalTokens),
  };
}

function buildContextBreakdown(aggregate) {
  const serialized = serializeAggregateEntry(aggregate);
  return {
    totals: contextBreakdownForTotals(serialized.totals),
    sources: serialized.sources.map((source) => ({
      source: source.source,
      totals: contextBreakdownForTotals(source),
    })),
  };
}

function buildCostAnalysis(aggregate) {
  const serialized = serializeAggregateEntry(aggregate);
  return {
    totalCostUsd: serialized.totals.costUsd,
    total_cost_usd: serialized.totals.costUsd,
    pricedTokens: serialized.totals.pricedTokens,
    unpricedTokens: serialized.totals.unpricedTokens,
    sources: serialized.sources.map((source) => ({
      source: source.source,
      tokens: source.tokens,
      costUsd: source.costUsd,
      total_cost_usd: source.costUsd,
      unpricedTokens: source.unpricedTokens,
    })),
    models: serialized.models.map((model) => ({
      source: model.source,
      model: model.model,
      tokens: model.tokens,
      costUsd: model.costUsd,
      total_cost_usd: model.costUsd,
      unpricedTokens: model.unpricedTokens,
    })),
  };
}

function heatmapLevel(value, maxValue) {
  if (value <= 0) return 0;
  const ratio = value / Math.max(1, maxValue);
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function buildHeatmap(projected, at) {
  const todayStart = localStartOfDay(at);
  const rangeStart = todayStart - 364 * DAY_MS;
  const startDate = new Date(rangeStart);
  const alignedStart = rangeStart - startDate.getDay() * DAY_MS;
  const cells = [];
  for (let i = 0; i < 53 * 7; i++) {
    const ms = alignedStart + i * DAY_MS;
    const day = localDayKey(ms);
    const future = ms > todayStart;
    const inRange = ms >= rangeStart && ms <= todayStart;
    const entry = getProjectedEntry(projected, day);
    const serialized = serializeDay(entry);
    cells.push({
      day,
      future,
      inRange,
      totals: serialized.totals,
      models: serialized.models,
      sources: serialized.sources,
      level: 0,
    });
  }

  const activeCells = cells.filter((cell) => cell.inRange && !cell.future);
  const maxTokens = Math.max(0, ...activeCells.map((cell) => Number(cell.totals.tokens) || 0));
  let activeDays = 0;
  let peakDay = null;
  for (const cell of cells) {
    const value = Number(cell.totals.tokens) || 0;
    cell.level = cell.inRange && !cell.future ? heatmapLevel(value, maxTokens) : 0;
    if (!cell.inRange || cell.future || value <= 0) continue;
    activeDays += 1;
    if (!peakDay || value > peakDay.totals.tokens) peakDay = cell;
  }

  let currentStreak = 0;
  for (let cursor = todayStart; cursor >= rangeStart; cursor -= DAY_MS) {
    const entry = getProjectedEntry(projected, localDayKey(cursor));
    if ((Number(entry.totals.tokens) || 0) <= 0) break;
    currentStreak += 1;
  }

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  return {
    from: localDayKey(rangeStart),
    to: localDayKey(todayStart),
    weekStartsOn: "sun",
    weeks,
    cells,
    activeDays,
    active_days: activeDays,
    activeRate: Math.round(activeDays / 365 * 1000) / 10,
    active_rate: Math.round(activeDays / 365 * 1000) / 10,
    streakDays: currentStreak,
    streak_days: currentStreak,
    maxTokens,
    max_tokens: maxTokens,
    peakDay: peakDay || {
      day: localDayKey(todayStart),
      future: false,
      inRange: true,
      totals: normalizeTotalsForOutput(makeTotals()),
      models: [],
      sources: [],
      level: 0,
    },
  };
}

function safeAt(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function sessionKey(event) {
  return [
    event.host || "",
    event.agentId || "unknown",
    event.sessionId || "default",
  ].join("|");
}

function inheritUsageMetadata(event, session) {
  if (!session) return event;
  return {
    ...event,
    agentId: safeString(event.agentId) || session.agentId || null,
    host: safeString(event.host) || session.host || null,
    cwd: safeString(event.cwd) || safeString(event.projectRef) || safeString(event.project) || session.cwd || null,
    model: safeString(event.model) || session.model || null,
    provider: safeString(event.provider) || session.provider || null,
    source: normalizeSource(event.source || event.agentId) || session.source || session.agentId || null,
  };
}

function sessionRecordFromEvent(event, existing, at) {
  const agentId = safeString(event.agentId) || (existing && existing.agentId) || "unknown";
  return {
    at,
    state: event.state || (existing && existing.state) || "idle",
    agentId,
    host: safeString(event.host) || (existing && existing.host) || null,
    cwd: safeString(event.cwd) ||
      safeString(event.projectRef) ||
      safeString(event.project) ||
      (existing && existing.cwd) ||
      null,
    model: safeString(event.model) || (existing && existing.model) || null,
    provider: safeString(event.provider) || (existing && existing.provider) || null,
    source: normalizeSource(event.source || event.agentId) ||
      (existing && existing.source) ||
      agentId,
  };
}

function modelFromResolver(resolveModelForEvent, event) {
  if (typeof resolveModelForEvent !== "function") return null;
  try {
    return safeString(resolveModelForEvent(event));
  } catch {
    return null;
  }
}

function isSyntheticTestUsageEvent(event) {
  const sessionId = safeString(event && event.sessionId) || "";
  const usageEventId = safeString(event && event.usageEventId) || "";
  return /^test-session(?:-|$)/.test(sessionId) || /:payload:test(?:-|:|$)/.test(usageEventId);
}

function isEndState(event) {
  return event.event === "SessionEnd" ||
    event.event === "stale-cleanup" ||
    event.state === "sleeping";
}

function safeString(value, fallback = null) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function safeLedgerPayload(entry) {
  const at = safeAt(entry.at, Date.now());
  const agentId = safeString(entry.agentId, "unknown");
  const source = normalizeSource(entry.source || agentId) || "unknown";
  const payload = {
    type: entry.type === "token" ? "token" : "state",
    at,
    agentId,
    sessionId: safeString(entry.sessionId, "default"),
    source,
  };
  const model = safeString(entry.model);
  if (model) payload.model = model;
  const provider = safeString(entry.provider);
  if (provider) payload.provider = provider;
  const cwd = safeString(entry.cwd);
  if (cwd) payload.cwd = cwd;
  const projectRef = safeString(entry.projectRef);
  if (projectRef) payload.projectRef = projectRef;
  const host = safeString(entry.host);
  if (host) payload.host = host;
  const state = safeString(entry.state);
  if (state) payload.state = state;
  const event = safeString(entry.event);
  if (event) payload.event = event;
  const usageEventId = safeString(entry.usageEventId);
  if (usageEventId) payload.usageEventId = usageEventId;
  const tokenUsage = normalizeTokenUsage(entry.tokenUsage || entry, {
    agentId,
    source,
  });
  if (tokenUsage) payload.tokenUsage = tokenUsage;
  return payload;
}

function encodeLedgerEntry(entry) {
  return `${JSON.stringify(safeLedgerPayload(entry))}\n`;
}

function createUsageAnalytics(options = {}) {
  const days = new Map();
  const buckets = new Map();
  const months = new Map();
  const sessions = new Map();
  const seenTokenEvents = new Set();
  const replayOperations = [];
  let replaying = false;

  function now() {
    return typeof options.now === "function" ? options.now() : Date.now();
  }

  function tokenEventKey(event, usage, at) {
    if (typeof event.usageEventId === "string" && event.usageEventId) {
      const id = event.usageEventId;
      const txMarker = ":transcript:";
      const txIdx = id.indexOf(txMarker);
      if (txIdx >= 0) {
        const lastColon = id.lastIndexOf(":", txIdx - 1);
        if (lastColon > 0) return id.substring(0, lastColon) + id.substring(txIdx);
      }
      return id;
    }
    return [
      event.host || "",
      event.agentId || "unknown",
      event.sessionId || "default",
      event.model || "unknown",
      at,
      usage.total_tokens,
      usage.input_tokens,
      usage.cached_input_tokens,
      usage.cache_creation_input_tokens,
      usage.output_tokens,
      usage.reasoning_output_tokens,
    ].join("|");
  }

  function cloneReplayEvent(event, at) {
    const cloned = { ...event, at };
    for (const key of ["tokenUsage", "usage", "tokens"]) {
      if (event[key] && typeof event[key] === "object") {
        cloned[key] = { ...event[key] };
      }
    }
    return cloned;
  }

  function recordToken(event = {}, { journal = true } = {}) {
    const session = sessions.get(sessionKey(event));
    let enrichedEvent = inheritUsageMetadata(event, session);
    if (!safeString(enrichedEvent.model) || enrichedEvent.model === "unknown") {
      const resolvedModel = modelFromResolver(options.resolveModelForEvent, enrichedEvent);
      if (resolvedModel) enrichedEvent = { ...enrichedEvent, model: resolvedModel };
    }
    if (isSyntheticTestUsageEvent(enrichedEvent)) return false;
    const source = normalizeSource(enrichedEvent.source || enrichedEvent.agentId) || "unknown";
    const tokenUsage = normalizeTokenUsage(enrichedEvent.tokenUsage || enrichedEvent, {
      agentId: enrichedEvent.agentId,
      source,
    });
    if (!tokenUsage) return false;
    const at = safeAt(enrichedEvent.at, now());
    const key = tokenEventKey(enrichedEvent, tokenUsage, at);
    if (seenTokenEvents.has(key)) return false;
    seenTokenEvents.add(key);
    addToken({ days, buckets, months }, at, { ...enrichedEvent, source }, tokenUsage);
    if (journal && !replaying) {
      replayOperations.push({
        type: "token",
        event: cloneReplayEvent({ ...enrichedEvent, source }, at),
      });
    }
    return true;
  }

  function recordState(event = {}, { journal = true } = {}) {
    const at = safeAt(event.at, now());
    const key = sessionKey(event);
    const existing = sessions.get(key);
    const usageEvent = event.tokenUsage ? inheritUsageMetadata(event, existing) : null;
    if (journal && !replaying) {
      replayOperations.push({ type: "state", event: cloneReplayEvent(event, at) });
    }
    if (existing && at >= existing.at) {
      addDuration(days, existing.at, at, existing.agentId, "sessionMs");
      if (ACTIVE_STATES.has(existing.state)) {
        addDuration(days, existing.at, at, existing.agentId, "activeMs");
      }
    }
    if (isEndState(event)) {
      sessions.delete(key);
    } else {
      sessions.set(key, sessionRecordFromEvent(event, existing, at));
    }
    if (usageEvent) recordToken(usageEvent, { journal: false });
    return true;
  }

  function loadLedgerLines(lines, options = {}) {
    for (const line of lines || []) {
      if (!line || !String(line).trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry && entry.type === "token") recordToken(entry);
      else if (entry && entry.type === "state") recordState(entry);
    }
    if (options.keepOpenSessions === false) {
      sessions.clear();
      if (!replaying) replayOperations.push({ type: "clear-sessions" });
    }
  }

  function reprice() {
    const operations = replayOperations.slice();
    days.clear();
    buckets.clear();
    months.clear();
    sessions.clear();
    seenTokenEvents.clear();
    replaying = true;
    try {
      for (const operation of operations) {
        if (operation.type === "clear-sessions") {
          sessions.clear();
        } else if (operation.type === "token") {
          recordToken(operation.event, { journal: false });
        } else if (operation.type === "state") {
          recordState(operation.event, { journal: false });
        }
      }
    } finally {
      replaying = false;
    }
  }

  function projectedDays(at) {
    const projected = cloneDays(days);
    for (const session of sessions.values()) {
      if (at <= session.at) continue;
      addDuration(projected, session.at, at, session.agentId, "sessionMs");
      if (ACTIVE_STATES.has(session.state)) {
        addDuration(projected, session.at, at, session.agentId, "activeMs");
      }
    }
    return projected;
  }

  function getSnapshot(input = {}) {
    const at = safeAt(input.now, now());
    const count = Math.max(1, Math.floor(input.days || 30));
    const projected = projectedDays(at);
    const todayKey = localDayKey(at);
    const outDays = [];
    for (let i = count - 1; i >= 0; i--) {
      const key = dayKeyForOffset(at, i);
      outDays.push(serializeDay(projected.get(key) || ensureDay(new Map(), key)));
    }
    const last30Entries = [];
    for (let i = 29; i >= 0; i--) {
      last30Entries.push(getProjectedEntry(projected, dayKeyForOffset(at, i)));
    }
    const last30Aggregate = aggregateUsageEntries(last30Entries);
    last30Aggregate.period = "last30d";
    const hourlyTrend = buildHourlyTrend(buckets, at);
    const monthlyTrend = buildMonthlyTrend(months);
    const currentMonthKey = localMonthKey(at);
    const currentMonthEntry = months.get(currentMonthKey) || makeUsageEntry("month", currentMonthKey);
    return {
      generatedAt: at,
      today: serializeDay(projected.get(todayKey) || ensureDay(new Map(), todayKey)),
      days: outDays,
      buckets: hourlyTrend,
      months: monthlyTrend,
      currentMonth: serializeUsageEntry(currentMonthEntry, "month"),
      trends: {
        hourly: hourlyTrend,
        daily: outDays,
        monthly: monthlyTrend,
      },
      rolling: {
        last7d: rollingWindow(projected, at, 7, "last7d"),
        last30d: rollingWindow(projected, at, 30, "last30d"),
      },
      heatmap: buildHeatmap(projected, at),
      projects: serializeAggregateEntry(last30Aggregate).projects,
      costAnalysis: buildCostAnalysis(last30Aggregate),
      contextBreakdown: buildContextBreakdown(last30Aggregate),
    };
  }

  return {
    recordState,
    recordToken,
    loadLedgerLines,
    reprice,
    getSnapshot,
  };
}

module.exports = {
  ACTIVE_STATES,
  CANONICAL_USAGE_SCHEMA,
  createUsageAnalytics,
  encodeLedgerEntry,
  localDayKey,
  normalizeTokenUsage,
};

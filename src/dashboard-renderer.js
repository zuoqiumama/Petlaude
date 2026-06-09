"use strict";

// Bind window control buttons (CSP-safe)
function bindWindowControls() {
  const ctrl = window.windowControls;
  if (!ctrl) return;
  const lights = document.querySelector(".traffic-lights");
  if (!lights) return;
  const frame = document.querySelector(".window-frame");
  lights.querySelector(".traffic-light.close")?.addEventListener("click", () => ctrl.close());
  lights.querySelector(".traffic-light.minimize")?.addEventListener("click", () => ctrl.minimize());
  lights.querySelector(".traffic-light.maximize")?.addEventListener("click", () => {
    ctrl.maximize();
    if (frame) frame.classList.toggle("maximized");
  });
}
bindWindowControls();

// Double-click title bar to maximize/restore
{
  const titleBar = document.querySelector(".title-bar");
  if (titleBar && window.windowControls) {
    titleBar.addEventListener("dblclick", () => window.windowControls.maximize());
  }
}

const AGENT_LABELS = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "copilot-cli": "Copilot",
  "cursor-agent": "Cursor Agent",
  "gemini-cli": "Gemini",
  "antigravity-cli": "Antigravity",
  "kiro-cli": "Kiro",
  "kimi-cli": "Kimi",
  opencode: "opencode",
  codebuddy: "CodeBuddy",
  pi: "Pi",
  openclaw: "OpenClaw",
};

let snapshot = { sessions: [], groups: [], orderedIds: [] };
let usageSnapshot = null;
let usagePeriod = "today";
let i18nPayload = { lang: "en", translations: {} };
let activeEdit = null;
let quotaLimits = {};
let quotaEditAgent = null;

const titleEl = document.getElementById("title");
const countEl = document.getElementById("count");
const contentEl = document.getElementById("content");

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return t("sessionJustNow");
  if (sec < 60) return t("sessionHudElapsedSec").replace("{n}", sec);
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  const hr = Math.floor(min / 60);
  return t("sessionHrAgo").replace("{n}", hr);
}

function badgeLabel(badge) {
  const key = {
    running: "sessionBadgeRunning",
    done: "sessionBadgeDone",
    interrupted: "sessionBadgeInterrupted",
    idle: "sessionBadgeIdle",
  }[badge] || "sessionBadgeIdle";
  return t(key);
}

function agentLabel(agentId) {
  return AGENT_LABELS[agentId] || agentId || t("dashboardUnknownAgent");
}

function agentFallback(agentId) {
  const label = agentLabel(agentId).trim();
  return label ? label.slice(0, 2).toUpperCase() : "?";
}

function sourceLabel(source) {
  const value = String(source || "").toLowerCase();
  if (value === "claude") return "Claude";
  if (value === "codex") return "Codex";
  if (value === "gemini") return "Gemini";
  if (value === "qwen") return "Qwen";
  if (value === "copilot") return "Copilot";
  return agentLabel(source);
}

function trimFixed(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
}

function formatCompactNumber(value) {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n >= 1000000000) return `${trimFixed(n / 1000000000)}B`;
  if (n >= 1000000) return `${trimFixed(n / 1000000)}M`;
  if (n >= 1000) return `${trimFixed(n / 1000)}K`;
  return String(Math.round(n));
}

function niceTickStep(max) {
  if (max <= 0) return 1;
  const rough = max / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  const residual = rough / magnitude;
  if (residual <= 1.5) return magnitude;
  if (residual <= 3) return 2 * magnitude;
  if (residual <= 7) return 5 * magnitude;
  return 10 * magnitude;
}

function formatUsageDuration(ms) {
  const minutes = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 60000));
  if (minutes <= 0) return "0m";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0 && mins > 0) return `${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

const AGENT_COLORS = {
  "claude-code": "#d4945c",
  codex: "#6b7fff",
  "copilot-cli": "#3eb8a4",
  "cursor-agent": "#8b5cf6",
  "gemini-cli": "#4d94ff",
  "antigravity-cli": "#f2853a",
  "kiro-cli": "#e8648c",
  "kimi-cli": "#4da8e0",
  opencode: "#8499b2",
  codebuddy: "#e8a817",
  pi: "#4ec98b",
  openclaw: "#6e7ff0",
};

const FALLBACK_COLORS = ["#d4945c", "#6b7fff", "#3eb8a4", "#f2853a", "#e8648c", "#4d94ff"];

function agentColor(agentId, index = 0) {
  return AGENT_COLORS[agentId] || FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

function createText(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.textContent = text || "";
  return el;
}

function createMetric(label, value, subtext) {
  const card = document.createElement("div");
  card.className = "usage-metric";
  card.appendChild(createText("span", "usage-label", label));
  card.appendChild(createText("strong", "usage-value", value));
  if (subtext) card.appendChild(createText("span", "usage-subtext", subtext));
  return card;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

const USAGE_PERIODS = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "all", label: "Total", days: null },
];

const USAGE_TOTAL_FIELDS = [
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

function emptyUsageTotals() {
  const out = {};
  USAGE_TOTAL_FIELDS.forEach((field) => { out[field] = 0; });
  return out;
}

function emptyUsageDay(day = "") {
  return { day, totals: emptyUsageTotals(), agents: [], sources: [], models: [], projects: [] };
}

function addUsageTotals(target, source = {}) {
  USAGE_TOTAL_FIELDS.forEach((field) => {
    target[field] = (Number(target[field]) || 0) + (Number(source[field]) || 0);
  });
}

function mergeUsageRows(map, rows, keyFor, defaultsFor) {
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const key = keyFor(row);
    if (!key) return;
    if (!map.has(key)) map.set(key, { ...defaultsFor(row), ...emptyUsageTotals() });
    addUsageTotals(map.get(key), row);
  });
}

function sortUsageRows(a, b) {
  return (Number(b.tokens) || 0) - (Number(a.tokens) || 0) ||
    (Number(b.costUsd) || 0) - (Number(a.costUsd) || 0) ||
    String(a.agentId || a.source || a.model || a.projectRef || a.name || "")
      .localeCompare(String(b.agentId || b.source || b.model || b.projectRef || b.name || ""));
}

function aggregateUsageDays(days) {
  const safeDays = Array.isArray(days) ? days : [];
  const out = emptyUsageDay(safeDays.length ? safeDays[safeDays.length - 1].day : "");
  const agentMap = new Map();
  const sourceMap = new Map();
  const modelMap = new Map();
  const projectMap = new Map();
  safeDays.forEach((day) => {
    addUsageTotals(out.totals, day && day.totals);
    mergeUsageRows(
      agentMap,
      day && day.agents,
      (row) => row.agentId || "unknown",
      (row) => ({ agentId: row.agentId || "unknown" })
    );
    mergeUsageRows(
      sourceMap,
      day && day.sources,
      (row) => row.source || "unknown",
      (row) => ({ source: row.source || "unknown" })
    );
    mergeUsageRows(
      modelMap,
      day && day.models,
      (row) => `${row.source || "unknown"}|${row.model || "unknown"}`,
      (row) => ({ source: row.source || "unknown", model: row.model || "unknown" })
    );
    mergeUsageRows(
      projectMap,
      day && day.projects,
      (row) => row.projectRef || row.name || "unknown",
      (row) => ({ projectRef: row.projectRef || "unknown", name: row.name || "Unknown" })
    );
  });
  out.agents = Array.from(agentMap.values()).sort(sortUsageRows);
  out.sources = Array.from(sourceMap.values()).sort(sortUsageRows);
  out.models = Array.from(modelMap.values()).sort(sortUsageRows);
  out.projects = Array.from(projectMap.values()).sort(sortUsageRows);
  return out;
}

function usagePeriodConfig() {
  return USAGE_PERIODS.find((period) => period.key === usagePeriod) || USAGE_PERIODS[0];
}

function usageDaysForCurrentPeriod() {
  const days = Array.isArray(usageSnapshot && usageSnapshot.days) ? usageSnapshot.days : [];
  const config = usagePeriodConfig();
  if (config.key === "today") {
    return usageSnapshot && usageSnapshot.today ? [usageSnapshot.today] : [emptyUsageDay()];
  }
  if (!config.days) return days;
  return days.slice(-config.days);
}

function getUsageView() {
  const config = usagePeriodConfig();
  const days = usageDaysForCurrentPeriod();
  const usage = config.key === "today"
    ? (usageSnapshot && usageSnapshot.today ? usageSnapshot.today : emptyUsageDay())
    : aggregateUsageDays(days);
  return { config, days, usage };
}

function formatCost(value) {
  const n = Number(value) || 0;
  if (n <= 0) return "$0";
  if (n < 0.01) return "<$0.01";
  if (n < 10) return `$${n.toFixed(2)}`;
  if (n < 1000) return `$${n.toFixed(1)}`;
  return `$${formatCompactNumber(n)}`;
}

function formatCostAxis(value) {
  const n = Number(value) || 0;
  if (n <= 0) return "$0";
  if (n < 0.01) {
    return `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return formatCost(n);
}

function formatUsageTokenTypes(totals = {}) {
  const parts = [
    `${formatCompactNumber(Number(totals.input) || 0)} in`,
    `${formatCompactNumber(Number(totals.cachedInput) || 0)} cache`,
    `${formatCompactNumber(Number(totals.output) || 0)} out`,
  ];
  const cacheCreation = Number(totals.cacheCreationInput) || 0;
  if (cacheCreation > 0) parts.splice(2, 0, `${formatCompactNumber(cacheCreation)} write`);
  const reasoning = Number(totals.reasoningOutput) || 0;
  if (reasoning > 0) parts.push(`${formatCompactNumber(reasoning)} reasoning`);
  const unattributed = Number(totals.unattributed) || 0;
  if (unattributed > 0) parts.push(`${formatCompactNumber(unattributed)} unknown`);
  return parts.join(" / ");
}

function createPeriodTabs() {
  const tabs = document.createElement("div");
  tabs.className = "usage-period-tabs";
  tabs.setAttribute("role", "tablist");
  USAGE_PERIODS.forEach((period) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `usage-period-button${usagePeriod === period.key ? " active" : ""}`;
    button.textContent = period.label;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", usagePeriod === period.key ? "true" : "false");
    button.addEventListener("click", () => {
      usagePeriod = period.key;
      render({ force: true });
    });
    tabs.appendChild(button);
  });
  return tabs;
}

function metricTokens(totals = {}) {
  return Number(totals.tokens) || Number(totals.total_tokens) || 0;
}

function metricCost(totals = {}) {
  return Number(totals.costUsd) || Number(totals.total_cost_usd) || 0;
}

function metricConversations(totals = {}) {
  return Number(totals.conversationCount) || Number(totals.conversation_count) || 0;
}

function createMiniStat(label, value, subtext) {
  const item = document.createElement("div");
  item.className = "usage-mini-stat";
  item.appendChild(createText("span", "usage-label", label));
  item.appendChild(createText("strong", "usage-mini-value", value));
  if (subtext) item.appendChild(createText("span", "usage-subtext", subtext));
  return item;
}

function createStatsPanel(usage) {
  const panel = document.createElement("div");
  panel.className = "usage-panel usage-stats-panel";
  panel.appendChild(createText("h3", "usage-panel-title", "Stats"));
  const grid = document.createElement("div");
  grid.className = "usage-mini-grid";
  const rolling = usageSnapshot && usageSnapshot.rolling ? usageSnapshot.rolling : {};
  const last7 = rolling.last7d || { totals: emptyUsageTotals(), activeDays: 0 };
  const last30 = rolling.last30d || { totals: emptyUsageTotals(), activeDays: 0 };
  const topModel = Array.isArray(usage.models) && usage.models.length ? usage.models[0] : null;
  grid.appendChild(createMiniStat("7 days", formatCompactNumber(metricTokens(last7.totals)), `${last7.activeDays || 0} active days`));
  grid.appendChild(createMiniStat("30 days", formatCompactNumber(metricTokens(last30.totals)), `${last30.activeDays || 0} active days`));
  grid.appendChild(createMiniStat("Avg active day", formatCompactNumber(last30.avgTokensPerActiveDay || 0), "last 30 days"));
  grid.appendChild(createMiniStat("Conversations", formatCompactNumber(metricConversations(usage.totals)), usagePeriodConfig().label));
  grid.appendChild(createMiniStat(
    "Top model",
    topModel ? formatCompactNumber(topModel.tokens) : "0",
    topModel ? `${topModel.model} · ${sourceLabel(topModel.source)}` : "no model usage"
  ));
  panel.appendChild(grid);
  return panel;
}

function createProviderOverview(usage) {
  const panel = document.createElement("div");
  panel.className = "usage-panel usage-provider-overview";
  panel.appendChild(createText("h3", "usage-panel-title", "Usage Overview"));
  const sources = Array.isArray(usage.sources) ? usage.sources : [];
  if (!sources.length) {
    panel.appendChild(createText("div", "usage-empty", "No provider usage yet"));
    return panel;
  }

  const totalTokens = Math.max(1, metricTokens(usage.totals));
  const bar = document.createElement("div");
  bar.className = "usage-provider-bar";
  sources.slice(0, 8).forEach((source, index) => {
    const segment = document.createElement("span");
    segment.style.width = `${Math.max(1, metricTokens(source) / totalTokens * 100)}%`;
    segment.style.background = agentColor(source.source, index);
    segment.title = `${sourceLabel(source.source)}: ${formatCompactNumber(metricTokens(source))}`;
    bar.appendChild(segment);
  });
  panel.appendChild(bar);

  const cards = document.createElement("div");
  cards.className = "usage-provider-cards";
  sources.slice(0, 6).forEach((source, index) => {
    const card = document.createElement("div");
    card.className = "usage-provider-card";
    const head = document.createElement("div");
    head.className = "usage-provider-head";
    const swatch = document.createElement("span");
    swatch.className = "usage-swatch";
    swatch.style.background = agentColor(source.source, index);
    head.appendChild(swatch);
    head.appendChild(createText("span", "usage-provider-name", sourceLabel(source.source)));
    head.appendChild(createText("span", "usage-provider-share", `${Math.round(metricTokens(source) / totalTokens * 100)}%`));
    card.appendChild(head);
    card.appendChild(createText("div", "usage-provider-tokens", formatCompactNumber(metricTokens(source))));
    card.appendChild(createText("div", "usage-subtext", `${formatCost(metricCost(source))} · ${metricConversations(source)} conversations`));
    const sourceModels = (Array.isArray(usage.models) ? usage.models : [])
      .filter((model) => model.source === source.source)
      .slice(0, 3);
    sourceModels.forEach((model) => {
      const modelRow = document.createElement("div");
      modelRow.className = "usage-provider-model";
      modelRow.appendChild(createText("span", "", model.model || "unknown"));
      modelRow.appendChild(createText("span", "muted", formatCompactNumber(model.tokens)));
      card.appendChild(modelRow);
    });
    cards.appendChild(card);
  });
  panel.appendChild(cards);
  return panel;
}

function createAgentUsageList(usage) {
  const list = document.createElement("div");
  list.className = "usage-agent-list";
  const header = document.createElement("div");
  header.className = "usage-agent-row usage-agent-head";
  header.appendChild(createText("span", "", ""));
  header.appendChild(createText("span", "usage-agent-name", "Agent"));
  header.appendChild(createText("span", "usage-agent-value muted", "Tokens"));
  header.appendChild(createText("span", "usage-agent-value muted", "Cost"));
  header.appendChild(createText("span", "usage-agent-value muted", "Active"));
  list.appendChild(header);

  const agents = Array.isArray(usage.agents) ? usage.agents : [];
  if (!agents.length) {
    list.appendChild(createText("div", "usage-empty", "No usage yet"));
    return list;
  }

  agents.forEach((agent, index) => {
    const row = document.createElement("div");
    row.className = "usage-agent-row";
    const swatch = document.createElement("span");
    swatch.className = "usage-swatch";
    swatch.style.background = agentColor(agent.agentId, index);
    row.appendChild(swatch);
    row.appendChild(createText("span", "usage-agent-name", agentLabel(agent.agentId)));
    row.appendChild(createText("span", "usage-agent-value", formatCompactNumber(agent.tokens)));
    row.appendChild(createText("span", "usage-agent-value muted", formatCost(agent.costUsd)));
    row.appendChild(createText("span", "usage-agent-value muted", formatUsageDuration(agent.activeMs)));
    list.appendChild(row);
  });
  return list;
}

function monotoneCubicPath(points) {
  if (points.length < 2) return "";
  if (points.length === 2) {
    return `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)} L ${points[1].x.toFixed(1)},${points[1].y.toFixed(1)}`;
  }
  const n = points.length;
  const dx = [];
  const dy = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x);
    dy.push(points[i + 1].y - points[i].y);
    m.push(dy[i] / dx[i]);
  }
  const tangent = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangent.push(0);
    } else {
      tangent.push((m[i - 1] + m[i]) / 2);
    }
  }
  tangent.push(m[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(m[i]) < 1e-9) { tangent[i] = 0; tangent[i + 1] = 0; continue; }
    const alpha = tangent[i] / m[i];
    const beta = tangent[i + 1] / m[i];
    const mag = alpha * alpha + beta * beta;
    if (mag > 9) {
      const tau = 3 / Math.sqrt(mag);
      tangent[i] = tau * alpha * m[i];
      tangent[i + 1] = tau * beta * m[i];
    }
  }
  let d = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const seg = dx[i] / 3;
    const cp1x = points[i].x + seg;
    const cp1y = points[i].y + tangent[i] * seg;
    const cp2x = points[i + 1].x - seg;
    const cp2y = points[i + 1].y - tangent[i + 1] * seg;
    d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${points[i + 1].x.toFixed(1)},${points[i + 1].y.toFixed(1)}`;
  }
  return d;
}

function trendRowsForView(config, days) {
  const trends = usageSnapshot && usageSnapshot.trends ? usageSnapshot.trends : {};
  if (config.key === "today" && Array.isArray(trends.hourly)) return trends.hourly;
  if (config.key === "all" && Array.isArray(trends.monthly) && trends.monthly.length) return trends.monthly;
  return Array.isArray(days) ? days : [];
}

function trendLabel(row) {
  if (row && row.bucket) {
    const d = new Date(row.bucket);
    if (!Number.isNaN(d.getTime())) {
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
  }
  if (row && row.month) return row.month;
  return String(row && row.day || "").slice(5).replace("-", "/");
}

function modelSegmentCatalog(rows) {
  const totals = new Map();
  (rows || []).forEach((row) => {
    (Array.isArray(row.models) ? row.models : []).forEach((model) => {
      const key = `${model.source || "unknown"}|${model.model || "unknown"}`;
      if (!totals.has(key)) {
        totals.set(key, {
          key,
          source: model.source || "unknown",
          model: model.model || "unknown",
          tokens: 0,
        });
      }
      totals.get(key).tokens += metricTokens(model);
    });
  });
  return Array.from(totals.values())
    .filter((model) => model.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 6);
}

function segmentValueForRow(row, segment) {
  if (segment.kind === "model") {
    const models = Array.isArray(row.models) ? row.models : [];
    const found = models.find((model) => `${model.source || "unknown"}|${model.model || "unknown"}` === segment.key);
    return found ? metricTokens(found) : 0;
  }
  return Number(row.totals && row.totals[segment.key]) || 0;
}

function renderUsageChart(rows, config = usagePeriodConfig()) {
  const chart = document.createElement("div");
  chart.className = "usage-chart";
  const safeRows = Array.isArray(rows) && rows.length ? rows : [];
  if (!safeRows.length) {
    chart.appendChild(createText("div", "usage-empty", "No trend yet"));
    return chart;
  }

  const width = 620;
  const height = 210;
  const pad = { left: 50, right: 48, top: 16, bottom: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxTokens = Math.max(1, ...safeRows.map((row) => metricTokens(row.totals)));
  const maxCost = Math.max(0, ...safeRows.map((row) => metricCost(row.totals)));
  const costScaleMax = maxCost > 0 ? maxCost : 1;
  const step = plotW / safeRows.length;
  const barW = Math.max(5, Math.min(26, step * 0.58));
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Trend Monitor" });

  svg.appendChild(svgEl("line", {
    x1: pad.left,
    y1: pad.top + plotH,
    x2: width - pad.right,
    y2: pad.top + plotH,
    class: "chart-axis",
  }));

  const tokenStep = niceTickStep(maxTokens);
  for (let tick = 0; tick <= maxTokens + 1e-9; tick += tokenStep) {
    const y = pad.top + plotH - (tick / maxTokens) * plotH;
    svg.appendChild(svgEl("line", {
      x1: pad.left,
      y1: y,
      x2: width - pad.right,
      y2: y,
      class: "chart-grid",
    }));
    const label = svgEl("text", { x: pad.left - 6, y: y + 4, class: "chart-y-label", "text-anchor": "end" });
    label.textContent = formatCompactNumber(tick);
    svg.appendChild(label);
  }

  if (maxCost > 0) {
    const costStep = niceTickStep(maxCost);
    for (let tick = 0; tick <= maxCost + 1e-9; tick += costStep) {
      const y = pad.top + plotH - (tick / costScaleMax) * plotH;
      const label = svgEl("text", { x: width - pad.right + 6, y: y + 4, class: "chart-y-label chart-y-label-right", "text-anchor": "start" });
      label.textContent = formatCostAxis(tick);
      svg.appendChild(label);
    }
  }

  svg.appendChild(svgEl("line", {
    x1: pad.left,
    y1: pad.top,
    x2: pad.left,
    y2: pad.top + plotH,
    class: "chart-axis",
  }));

  const tokenSegments = [
    { key: "input", label: "Input", color: "#38bdf8" },
    { key: "cachedInput", label: "Cache read", color: "#14b8a6" },
    { key: "cacheCreationInput", label: "Cache write", color: "#f59e0b" },
    { key: "output", label: "Output", color: "#a78bfa" },
    { key: "reasoningOutput", label: "Reasoning", color: "#fb7185" },
    { key: "unattributed", label: "Unknown", color: "#94a3b8" },
  ];
  const modelSegments = modelSegmentCatalog(safeRows).map((model, index) => ({
    kind: "model",
    key: model.key,
    label: model.model,
    color: agentColor(model.source, index),
  }));
  const segments = modelSegments.length ? modelSegments : tokenSegments.map((segment) => ({ ...segment, kind: "token" }));

  safeRows.forEach((row, rowIndex) => {
    const x = pad.left + step * rowIndex + step / 2 - barW / 2;
    let yCursor = pad.top + plotH;
    segments.forEach((segment) => {
      const tokens = segmentValueForRow(row, segment);
      if (tokens <= 0) return;
      const segmentH = Math.max(1, tokens / maxTokens * plotH);
      yCursor -= segmentH;
      svg.appendChild(svgEl("rect", {
        x,
        y: yCursor,
        width: barW,
        height: segmentH,
        rx: 3,
        fill: segment.color,
        opacity: 0.92,
      }));
    });

    const label = trendLabel(row);
    const text = svgEl("text", {
      x: pad.left + step * rowIndex + step / 2,
      y: height - 9,
      class: "chart-day",
      "text-anchor": "middle",
    });
    const every = config.key === "today" ? 6 : Math.ceil(safeRows.length / 12);
    if (rowIndex % Math.max(1, every) === 0 || rowIndex === safeRows.length - 1) {
      text.textContent = label;
      svg.appendChild(text);
    }
  });

  const costPoints = safeRows.map((row, rowIndex) => {
    const value = metricCost(row.totals);
    return {
      x: pad.left + step * rowIndex + step / 2,
      y: pad.top + plotH - value / costScaleMax * plotH,
    };
  });
  if (maxCost > 0 && costPoints.length > 1) {
    const d = monotoneCubicPath(costPoints);
    svg.appendChild(svgEl("path", { d, class: "chart-line cost-line", fill: "none" }));
  }

  // Hover tooltip overlay
  const overlay = svgEl("rect", {
    x: pad.left, y: pad.top, width: plotW, height: plotH,
    fill: "transparent", style: "cursor:crosshair",
  });
  const vLine = svgEl("line", {
    x1: 0, y1: pad.top, x2: 0, y2: pad.top + plotH,
    class: "chart-hover-line", style: "display:none",
  });
  svg.appendChild(vLine);
  svg.appendChild(overlay);

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.style.display = "none";

  overlay.addEventListener("mousemove", (e) => {
    const svgRect = svg.getBoundingClientRect();
    const svgX = (e.clientX - svgRect.left) / svgRect.width * width;
    const rowIdx = Math.round((svgX - pad.left - step / 2) / step);
    if (rowIdx < 0 || rowIdx >= safeRows.length) { tooltip.style.display = "none"; vLine.style.display = "none"; return; }
    const row = safeRows[rowIdx];
    const cx = pad.left + step * rowIdx + step / 2;
    vLine.setAttribute("x1", cx);
    vLine.setAttribute("x2", cx);
    vLine.style.display = "";
    const tokens = metricTokens(row.totals);
    const cost = metricCost(row.totals);
    const label = trendLabel(row);
    let html = `<strong>${label}</strong>`;
    segments.forEach((seg) => {
      const val = segmentValueForRow(row, seg);
      if (val > 0) html += `<br><span style="color:${seg.color}">●</span> ${seg.label}: ${formatCompactNumber(val)}`;
    });
    if (cost > 0) html += `<br><span style="color:#10b981">—</span> Cost: ${formatCost(cost)}`;
    html += `<br>Total: ${formatCompactNumber(tokens)}`;
    tooltip.innerHTML = html;
    tooltip.style.display = "";
    const pctX = (e.clientX - svgRect.left) / svgRect.width;
    tooltip.style.left = pctX > 0.65 ? `${(e.clientX - svgRect.left) - tooltip.offsetWidth - 12}px` : `${(e.clientX - svgRect.left) + 12}px`;
    tooltip.style.top = `${(e.clientY - svgRect.top) - 20}px`;
  });
  overlay.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    vLine.style.display = "none";
  });

  chart.style.position = "relative";
  chart.appendChild(svg);
  chart.appendChild(tooltip);

  const legend = document.createElement("div");
  legend.className = "usage-legend";
  segments.forEach((segment) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = segment.color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(segment.label));
    legend.appendChild(item);
  });
  if (maxCost > 0) {
    const costItem = document.createElement("span");
    costItem.className = "legend-item";
    costItem.appendChild(createText("span", "legend-line cost-line", ""));
    costItem.appendChild(document.createTextNode("Cost"));
    legend.appendChild(costItem);
  }
  chart.appendChild(legend);
  return chart;
}

function createModelBreakdown(usage) {
  const panel = document.createElement("div");
  panel.className = "usage-model-list";
  const models = Array.isArray(usage.models) ? usage.models : [];
  const maxTokens = Math.max(1, ...models.map((model) => Number(model.tokens) || 0));
  if (!models.length) {
    panel.appendChild(createText("div", "usage-empty", "No model usage yet"));
    return panel;
  }
  models.slice(0, 10).forEach((model, index) => {
    const row = document.createElement("div");
    row.className = "usage-model-row";
    const main = document.createElement("div");
    main.className = "usage-model-main";
    main.appendChild(createText("span", "usage-model-name", model.model || "unknown"));
    main.appendChild(createText("span", "usage-model-source", model.source || "unknown"));
    const bar = document.createElement("span");
    bar.className = "usage-model-bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(2, (Number(model.tokens) || 0) / maxTokens * 100)}%`;
    fill.style.background = agentColor(model.source, index);
    bar.appendChild(fill);
    main.appendChild(bar);
    row.appendChild(main);
    const stats = document.createElement("div");
    stats.className = "usage-model-stats";
    stats.appendChild(createText("span", "", formatCompactNumber(model.tokens)));
    stats.appendChild(createText("span", "muted", formatCost(model.costUsd)));
    row.appendChild(stats);
    panel.appendChild(row);
  });
  return panel;
}

function createProjectUsagePanel(usage) {
  const panel = document.createElement("div");
  panel.className = "usage-panel usage-project-panel";
  panel.appendChild(createText("h3", "usage-panel-title", "Project Usage"));
  const projects = Array.isArray(usage.projects) ? usage.projects : [];
  if (!projects.length) {
    panel.appendChild(createText("div", "usage-empty", "No project attribution yet"));
    return panel;
  }
  const maxTokens = Math.max(1, ...projects.map((project) => metricTokens(project)));
  const list = document.createElement("div");
  list.className = "usage-project-list";
  projects.slice(0, 8).forEach((project, index) => {
    const row = document.createElement("div");
    row.className = "usage-project-row";
    const main = document.createElement("div");
    main.className = "usage-project-main";
    main.appendChild(createText("span", "usage-project-name", project.name || "Unknown"));
    const ref = project.projectRef && project.projectRef !== "unknown" ? project.projectRef : "";
    main.appendChild(createText("span", "usage-project-ref", ref));
    const bar = document.createElement("span");
    bar.className = "usage-model-bar";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(2, metricTokens(project) / maxTokens * 100)}%`;
    fill.style.background = FALLBACK_COLORS[index % FALLBACK_COLORS.length];
    bar.appendChild(fill);
    main.appendChild(bar);
    row.appendChild(main);
    const stats = document.createElement("div");
    stats.className = "usage-model-stats";
    stats.appendChild(createText("span", "", formatCompactNumber(metricTokens(project))));
    stats.appendChild(createText("span", "muted", formatCost(metricCost(project))));
    row.appendChild(stats);
    list.appendChild(row);
  });
  panel.appendChild(list);
  return panel;
}

function createCostAnalysisPanel(usage) {
  const panel = document.createElement("div");
  panel.className = "usage-panel usage-cost-panel";
  panel.appendChild(createText("h3", "usage-panel-title", "Cost Analysis"));
  const rows = (Array.isArray(usage.models) ? usage.models.slice(0, 12).map((model) => ({
    label: model.model && model.model !== "unknown" ? model.model : "Unknown model",
    detail: sourceLabel(model.source),
    tokens: metricTokens(model),
    cost: metricCost(model),
    unpriced: Number(model.unpricedTokens) || 0,
  })) : []).filter((row) => row.tokens > 0 || row.cost > 0);
  if (!rows.length) {
    panel.appendChild(createText("div", "usage-empty", "No model usage yet"));
    return panel;
  }
  const table = document.createElement("div");
  table.className = "usage-cost-table";
  const header = document.createElement("div");
  header.className = "usage-cost-row usage-cost-head";
  header.appendChild(createText("span", "", "Model"));
  header.appendChild(createText("span", "", "Tokens"));
  header.appendChild(createText("span", "", "Cost"));
  table.appendChild(header);
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "usage-cost-row";
    const name = document.createElement("span");
    name.className = "usage-cost-name";
    name.appendChild(createText("strong", "", row.label));
    name.appendChild(createText("small", "", row.unpriced > 0 ? `${row.detail} · ${formatCompactNumber(row.unpriced)} unpriced` : row.detail));
    item.appendChild(name);
    item.appendChild(createText("span", "usage-agent-value", formatCompactNumber(row.tokens)));
    item.appendChild(createText("span", "usage-agent-value", formatCost(row.cost)));
    table.appendChild(item);
  });
  panel.appendChild(table);
  return panel;
}

function contextRowsFromUsage(usage) {
  const totals = usage.totals || {};
  return [
    { label: "Messages / input", value: Number(totals.input) || 0, color: "#38bdf8" },
    { label: "Cached input", value: Number(totals.cachedInput) || 0, color: "#14b8a6" },
    { label: "Cache creation", value: Number(totals.cacheCreationInput) || 0, color: "#f59e0b" },
    { label: "Output", value: Number(totals.output) || 0, color: "#a78bfa" },
    { label: "Reasoning output", value: Number(totals.reasoningOutput) || 0, color: "#fb7185" },
    { label: "Unattributed", value: Number(totals.unattributed) || 0, color: "#94a3b8" },
  ];
}

function createContextBreakdownPanel(usage) {
  const panel = document.createElement("div");
  panel.className = "usage-panel usage-context-panel";
  panel.appendChild(createText("h3", "usage-panel-title", "Context Breakdown"));
  const rows = contextRowsFromUsage(usage);
  const maxTokens = Math.max(1, ...rows.map((row) => row.value));
  const list = document.createElement("div");
  list.className = "usage-context-list";
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "usage-context-row";
    item.appendChild(createText("span", "usage-context-label", row.label));
    const bar = document.createElement("span");
    bar.className = "usage-context-bar";
    const fill = document.createElement("span");
    fill.style.width = `${row.value <= 0 ? 0 : Math.max(2, row.value / maxTokens * 100)}%`;
    fill.style.background = row.color;
    bar.appendChild(fill);
    item.appendChild(bar);
    item.appendChild(createText("span", "usage-agent-value", formatCompactNumber(row.value)));
    list.appendChild(item);
  });
  panel.appendChild(list);
  return panel;
}

function createUsageDetailsPanel(days) {
  const panel = document.createElement("div");
  panel.className = "usage-panel usage-details-panel";
  panel.appendChild(createText("h3", "usage-panel-title", "Data Details"));
  const safeDays = (Array.isArray(days) ? days : []).filter((day) => metricTokens(day && day.totals) > 0);
  if (!safeDays.length) {
    panel.appendChild(createText("div", "usage-empty", "No daily usage details yet"));
    return panel;
  }
  const table = document.createElement("div");
  table.className = "usage-detail-table";
  const header = document.createElement("div");
  header.className = "usage-detail-row usage-cost-head";
  header.appendChild(createText("span", "", "Date"));
  header.appendChild(createText("span", "", "Top source"));
  header.appendChild(createText("span", "", "Tokens"));
  header.appendChild(createText("span", "", "Cost"));
  table.appendChild(header);
  safeDays.slice(-14).reverse().forEach((day) => {
    const source = Array.isArray(day.sources) && day.sources.length ? sourceLabel(day.sources[0].source) : "Unknown";
    const row = document.createElement("div");
    row.className = "usage-detail-row";
    row.appendChild(createText("span", "usage-detail-date", day.day || ""));
    row.appendChild(createText("span", "usage-detail-source", source));
    row.appendChild(createText("span", "usage-agent-value", formatCompactNumber(metricTokens(day.totals))));
    row.appendChild(createText("span", "usage-agent-value", formatCost(metricCost(day.totals))));
    table.appendChild(row);
  });
  panel.appendChild(table);
  return panel;
}

function createActivityDepth(heatmap) {
  const wrap = document.createElement("div");
  wrap.className = "usage-depth";
  wrap.appendChild(createText("div", "usage-depth-title", "Activity Depth"));
  const chart = document.createElement("div");
  chart.className = "usage-depth-chart";
  const cells = Array.isArray(heatmap && heatmap.cells) ? heatmap.cells.filter((cell) => cell.inRange && !cell.future).slice(-56) : [];
  const maxTokens = Math.max(1, ...cells.map((cell) => metricTokens(cell.totals)));
  cells.forEach((cell) => {
    const column = document.createElement("span");
    column.style.height = `${Math.max(3, metricTokens(cell.totals) / maxTokens * 44)}px`;
    column.className = `level-${cell.level || 0}`;
    column.title = `${cell.day}: ${formatCompactNumber(metricTokens(cell.totals))} tokens`;
    chart.appendChild(column);
  });
  wrap.appendChild(chart);
  return wrap;
}

function createUsageHeatmap(source) {
  const panel = document.createElement("div");
  panel.className = "usage-heatmap";
  const weeks = Array.isArray(source && source.weeks) ? source.weeks : [];
  if (!weeks.length) return panel;
  weeks.forEach((week) => {
    const col = document.createElement("div");
    col.className = "usage-heat-week";
    week.forEach((cellData) => {
      const value = metricTokens(cellData && cellData.totals);
      const cell = document.createElement("span");
      cell.className = `usage-heat-cell level-${cellData && cellData.level || 0}${cellData && cellData.future ? " future" : ""}`;
      cell.title = `${cellData.day}: ${formatCompactNumber(value)} tokens, ${formatCost(metricCost(cellData && cellData.totals))}`;
      col.appendChild(cell);
    });
    panel.appendChild(col);
  });
  return panel;
}

function getCurrentMonthAgentCosts() {
  if (!usageSnapshot || !usageSnapshot.currentMonth) return new Map();
  const agents = Array.isArray(usageSnapshot.currentMonth.agents) ? usageSnapshot.currentMonth.agents : [];
  const map = new Map();
  agents.forEach((agent) => {
    map.set(agent.agentId, {
      costUsd: Number(agent.costUsd) || Number(agent.total_cost_usd) || 0,
      tokens: Number(agent.tokens) || Number(agent.total_tokens) || 0,
    });
  });
  return map;
}

const PLAN_PRESETS = {
  "claude-code": [
    { id: "free", label: "Free", monthlyUsd: 0 },
    { id: "pro", label: "Pro", monthlyUsd: 20 },
    { id: "max5x", label: "Max 5×", monthlyUsd: 100 },
    { id: "max20x", label: "Max 20×", monthlyUsd: 200 },
  ],
  codex: [
    { id: "plus", label: "Plus", monthlyUsd: 20 },
    { id: "pro", label: "Pro", monthlyUsd: 200 },
  ],
  "cursor-agent": [
    { id: "hobby", label: "Hobby", monthlyUsd: 0 },
    { id: "pro", label: "Pro", monthlyUsd: 20 },
    { id: "business", label: "Business", monthlyUsd: 40 },
  ],
  "copilot-cli": [
    { id: "free", label: "Free", monthlyUsd: 0 },
    { id: "individual", label: "Individual", monthlyUsd: 10 },
    { id: "business", label: "Business", monthlyUsd: 19 },
    { id: "enterprise", label: "Enterprise", monthlyUsd: 39 },
  ],
  "gemini-cli": [
    { id: "free", label: "Free", monthlyUsd: 0 },
  ],
  "kiro-cli": [
    { id: "free", label: "Free", monthlyUsd: 0 },
  ],
};

const SUBSCRIPTION_TYPE_MAP = {
  free: "free",
  pro: "pro",
  max_5x: "max5x",
  max5x: "max5x",
  max_20x: "max20x",
  max20x: "max20x",
};

let detectedPlans = {};

function detectPlanId(agentId) {
  const info = detectedPlans[agentId];
  if (!info || !info.subscriptionType) return null;
  return SUBSCRIPTION_TYPE_MAP[info.subscriptionType] || info.subscriptionType;
}

function getPresetsForAgent(agentId) {
  return PLAN_PRESETS[agentId] || [];
}

// "×2.5" style value multiplier. One decimal under 10×, whole numbers above
// (a "×23.4" reads as false precision once you're that far past break-even).
function quotaMultiplierText(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return "×0";
  return ratio >= 10 ? `×${Math.round(ratio)}` : `×${ratio.toFixed(1)}`;
}

function beginQuotaEdit(agentId) {
  const existing = quotaLimits[agentId];
  const presets = getPresetsForAgent(agentId);
  const detected = detectPlanId(agentId);
  let defaultPlanId = "custom";
  let defaultDraft = existing ? String(existing.monthlyLimitUsd) : "";

  if (!existing && detected) {
    const match = presets.find((p) => p.id === detected);
    if (match) {
      defaultPlanId = match.id;
      defaultDraft = String(match.monthlyUsd);
    }
  } else if (!existing && presets.length > 0) {
    defaultPlanId = presets[0].id;
    defaultDraft = String(presets[0].monthlyUsd);
  } else if (existing) {
    const match = presets.find((p) => p.monthlyUsd === existing.monthlyLimitUsd);
    if (match) defaultPlanId = match.id;
  }

  quotaEditAgent = {
    agentId,
    planId: defaultPlanId,
    draft: defaultDraft,
    saving: false,
  };
  render({ force: true });
}

function cancelQuotaEdit() {
  quotaEditAgent = null;
  render({ force: true });
}

async function commitQuotaEdit() {
  if (!quotaEditAgent || quotaEditAgent.saving) return;
  const limit = parseFloat(quotaEditAgent.draft);
  if (!Number.isFinite(limit) || limit < 0) {
    cancelQuotaEdit();
    return;
  }
  quotaEditAgent.saving = true;
  try {
    const result = await window.dashboardAPI.setQuotaLimit({
      agentId: quotaEditAgent.agentId,
      monthlyLimitUsd: limit,
      enabled: true,
    });
    if (result && result.status === "ok") {
      quotaLimits = { ...quotaLimits, [quotaEditAgent.agentId]: { monthlyLimitUsd: limit, enabled: true } };
    }
  } catch (err) {
    console.warn("quota save failed:", err);
  }
  quotaEditAgent = null;
  render({ force: true });
}

async function removeQuotaLimit(agentId) {
  try {
    const result = await window.dashboardAPI.setQuotaLimit({ agentId, remove: true });
    if (result && result.status === "ok") {
      const next = { ...quotaLimits };
      delete next[agentId];
      quotaLimits = next;
      render({ force: true });
    }
  } catch (err) {
    console.warn("quota remove failed:", err);
  }
}

function createQuotaCard(agentId, limit, agentCost) {
  const card = document.createElement("div");
  card.className = "quota-card";

  const head = document.createElement("div");
  head.className = "quota-card-head";
  const isNewEntry = quotaEditAgent && quotaEditAgent.agentId === agentId && !quotaLimits[agentId];
  if (isNewEntry) {
    const configured = new Set(Object.keys(quotaLimits));
    const unconfigured = Object.keys(AGENT_LABELS).filter((id) => !configured.has(id));
    if (unconfigured.length > 1) {
      const agentPicker = document.createElement("select");
      agentPicker.className = "quota-agent-picker";
      unconfigured.forEach((id) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = agentLabel(id);
        agentPicker.appendChild(opt);
      });
      agentPicker.value = agentId;
      agentPicker.addEventListener("change", () => {
        beginQuotaEdit(agentPicker.value);
      });
      head.appendChild(agentPicker);
    } else {
      head.appendChild(createText("span", "quota-agent-fallback", agentFallback(agentId)));
      head.appendChild(createText("span", "quota-agent-name", agentLabel(agentId)));
    }
  } else {
    head.appendChild(createText("span", "quota-agent-fallback", agentFallback(agentId)));
    head.appendChild(createText("span", "quota-agent-name", agentLabel(agentId)));
  }

  const detected = detectPlanId(agentId);
  if (detected && !isNewEntry) {
    const presets = getPresetsForAgent(agentId);
    const match = presets.find((p) => p.id === detected);
    if (match) {
      head.appendChild(createText("span", "quota-detected-badge", `${match.label} · ${t("quotaDetected")}`));
    }
  }

  if (!isNewEntry) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "quota-remove-btn";
    removeBtn.textContent = "×";
    removeBtn.title = t("quotaRemoveLimit");
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeQuotaLimit(agentId);
    });
    head.appendChild(removeBtn);
  }
  card.appendChild(head);

  // Subscription value model: `costUsd` is the cache-discounted API-equivalent
  // value of tokens consumed this month; `planUsd` is the flat price the user
  // actually pays. A subscription is a good deal precisely *because* the value
  // consumed can far exceed the price — so we frame crossing the plan price as
  // "broke even / surplus value", never as an over-budget error.
  const costUsd = agentCost ? agentCost.costUsd : 0;
  const planUsd = limit.monthlyLimitUsd;
  const hasPlan = planUsd > 0;
  const ratio = hasPlan ? costUsd / planUsd : 0;
  const brokeEven = hasPlan && costUsd >= planUsd;
  const fillPercent = hasPlan ? Math.min(100, ratio * 100) : (costUsd > 0 ? 100 : 0);

  // Headline: API-equivalent value consumed this month, with a value-multiplier
  // pill once the subscription has paid for itself.
  const valueRow = document.createElement("div");
  valueRow.className = "quota-value-row";
  const valueLeft = document.createElement("div");
  valueLeft.className = "quota-value-left";
  valueLeft.appendChild(createText("span", "quota-value-amount", formatCost(costUsd)));
  if (brokeEven) {
    valueLeft.appendChild(createText("span", "quota-mult-badge", quotaMultiplierText(ratio)));
  }
  valueRow.appendChild(valueLeft);
  valueRow.appendChild(createText("span", "quota-value-label", t("quotaApiValue")));
  card.appendChild(valueRow);

  const barWrap = document.createElement("div");
  barWrap.className = "quota-bar-wrap";
  const barFill = document.createElement("div");
  barFill.className = `quota-bar-fill ${brokeEven || !hasPlan ? "quota-bar-value" : "quota-bar-building"}`;
  barFill.style.width = `${fillPercent}%`;
  barWrap.appendChild(barFill);
  card.appendChild(barWrap);

  const stats = document.createElement("div");
  stats.className = "quota-stats";
  if (hasPlan) {
    stats.appendChild(createText("span", "quota-plan-price",
      t("quotaPlanPrice").replace("{price}", formatCost(planUsd))));
    if (brokeEven) {
      stats.appendChild(createText("span", "quota-status-good",
        t("quotaSaved").replace("{amount}", formatCost(costUsd - planUsd))));
    } else {
      stats.appendChild(createText("span", "quota-status-pending",
        t("quotaToBreakeven").replace("{amount}", formatCost(planUsd - costUsd))));
    }
  } else {
    stats.appendChild(createText("span", "quota-plan-price", t("quotaFreePlan")));
    if (costUsd > 0) {
      stats.appendChild(createText("span", "quota-status-good",
        t("quotaSavedFree").replace("{amount}", formatCost(costUsd))));
    }
  }
  card.appendChild(stats);

  if (quotaEditAgent && quotaEditAgent.agentId === agentId) {
    const editRow = document.createElement("div");
    editRow.className = "quota-edit-row";

    const presets = getPresetsForAgent(agentId);
    if (presets.length > 0) {
      const planSelect = document.createElement("select");
      planSelect.className = "quota-plan-select";
      presets.forEach((preset) => {
        const opt = document.createElement("option");
        opt.value = preset.id;
        opt.textContent = `${preset.label} ($${preset.monthlyUsd}/mo)`;
        planSelect.appendChild(opt);
      });
      const customOpt = document.createElement("option");
      customOpt.value = "custom";
      customOpt.textContent = t("quotaCustom");
      planSelect.appendChild(customOpt);
      planSelect.value = quotaEditAgent.planId || "custom";
      planSelect.addEventListener("change", () => {
        if (!quotaEditAgent || quotaEditAgent.agentId !== agentId) return;
        const selected = planSelect.value;
        quotaEditAgent.planId = selected;
        const match = presets.find((p) => p.id === selected);
        if (match) {
          quotaEditAgent.draft = String(match.monthlyUsd);
        }
        render({ force: true });
      });
      editRow.appendChild(planSelect);
    }

    if (!presets.length || quotaEditAgent.planId === "custom") {
      const input = document.createElement("input");
      input.className = "quota-edit-input";
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.placeholder = "$";
      input.value = quotaEditAgent.draft;
      input.addEventListener("input", () => {
        if (quotaEditAgent && quotaEditAgent.agentId === agentId) {
          quotaEditAgent.draft = input.value;
        }
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); commitQuotaEdit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancelQuotaEdit(); }
      });
      editRow.appendChild(input);
      requestAnimationFrame(() => {
        if (quotaEditAgent && quotaEditAgent.agentId === agentId && document.contains(input)) {
          input.focus();
          input.select();
        }
      });
    }

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "quota-edit-save";
    saveBtn.textContent = "OK";
    saveBtn.addEventListener("click", () => commitQuotaEdit());
    editRow.appendChild(saveBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "quota-edit-cancel";
    cancelBtn.textContent = "×";
    cancelBtn.addEventListener("click", () => cancelQuotaEdit());
    editRow.appendChild(cancelBtn);

    card.appendChild(editRow);
  }

  card.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    beginQuotaEdit(agentId);
  });

  return card;
}

function createQuotaSection() {
  const section = document.createElement("section");
  section.className = "quota-section";

  const header = document.createElement("div");
  header.className = "quota-header";
  header.appendChild(createText("h2", "quota-title", t("quotaTitle")));

  const addWrap = document.createElement("div");
  addWrap.style.cssText = "display:flex;align-items:center;gap:6px;-webkit-app-region:no-drag";

  const configured = new Set(Object.keys(quotaLimits));
  const unconfigured = Object.keys(AGENT_LABELS).filter((id) => !configured.has(id));

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "quota-add-btn";
  addBtn.textContent = `+ ${t("quotaSetLimit")}`;
  if (unconfigured.length === 0) {
    addBtn.disabled = true;
    addBtn.style.opacity = "0.4";
    addBtn.style.cursor = "default";
  }
  addBtn.addEventListener("click", () => {
    if (unconfigured.length === 0) return;
    beginQuotaEdit(unconfigured[0]);
  });
  addWrap.appendChild(addBtn);
  header.appendChild(addWrap);
  section.appendChild(header);

  const agentIds = Object.keys(quotaLimits).filter((id) => quotaLimits[id] && quotaLimits[id].enabled);
  const agentCosts = getCurrentMonthAgentCosts();

  if (agentIds.length === 0 && !quotaEditAgent) {
    section.appendChild(createText("div", "quota-empty", t("quotaNoLimits")));
    return section;
  }

  const grid = document.createElement("div");
  grid.className = "quota-grid";

  agentIds.forEach((agentId) => {
    grid.appendChild(createQuotaCard(agentId, quotaLimits[agentId], agentCosts.get(agentId)));
  });

  if (quotaEditAgent && !agentIds.includes(quotaEditAgent.agentId)) {
    const newLimit = { monthlyLimitUsd: 0, enabled: true };
    grid.appendChild(createQuotaCard(quotaEditAgent.agentId, newLimit, agentCosts.get(quotaEditAgent.agentId)));
  }

  section.appendChild(grid);
  return section;
}

function createUsageSection() {
  const { config, days, usage } = getUsageView();
  const totals = usage.totals || {};
  const section = document.createElement("section");
  section.className = "usage-section";

  const header = document.createElement("div");
  header.className = "usage-header";
  header.appendChild(createText("h2", "usage-title", "Usage"));
  header.appendChild(createPeriodTabs());
  section.appendChild(header);

  const summary = document.createElement("div");
  summary.className = "usage-summary";
  summary.appendChild(createMetric("Tokens", formatCompactNumber(totals.tokens), formatUsageTokenTypes(totals)));
  summary.appendChild(createMetric("Cost", formatCost(totals.costUsd), totals.unpricedTokens > 0 ? `${formatCompactNumber(totals.unpricedTokens)} unpriced` : "priced by model"));
  summary.appendChild(createMetric("Active", formatUsageDuration(totals.activeMs), `${formatUsageDuration(totals.sessionMs)} session`));
  summary.appendChild(createMetric("Conversations", formatCompactNumber(metricConversations(totals)), `${formatCompactNumber(totals.tokenEvents)} events`));
  section.appendChild(summary);

  section.appendChild(createProviderOverview(usage));
  section.appendChild(createStatsPanel(usage));

  const chartPanel = document.createElement("div");
  chartPanel.className = "usage-panel chart-panel";
  chartPanel.appendChild(createText("h3", "usage-panel-title", "Trend Monitor"));
  chartPanel.appendChild(renderUsageChart(trendRowsForView(config, days), config));
  section.appendChild(chartPanel);

  const heatPanel = document.createElement("div");
  heatPanel.className = "usage-panel heatmap-panel";
  heatPanel.appendChild(createText("h3", "usage-panel-title", "Activity"));
  const heatmap = usageSnapshot && usageSnapshot.heatmap ? usageSnapshot.heatmap : null;
  heatPanel.appendChild(createUsageHeatmap(heatmap));
  const heatStats = document.createElement("div");
  heatStats.className = "usage-heat-stats";
  heatStats.appendChild(createMiniStat("Active days", formatCompactNumber(heatmap && heatmap.activeDays), `${heatmap && heatmap.activeRate || 0}% of year`));
  heatStats.appendChild(createMiniStat("Streak", formatCompactNumber(heatmap && heatmap.streakDays), "current"));
  heatStats.appendChild(createMiniStat("Peak day", heatmap && heatmap.peakDay ? formatCompactNumber(metricTokens(heatmap.peakDay.totals)) : "0", heatmap && heatmap.peakDay ? heatmap.peakDay.day : ""));
  heatPanel.appendChild(heatStats);
  heatPanel.appendChild(createActivityDepth(heatmap));
  section.appendChild(heatPanel);

  const agentsPanel = document.createElement("div");
  agentsPanel.className = "usage-panel";
  agentsPanel.appendChild(createText("h3", "usage-panel-title", "Agents"));
  agentsPanel.appendChild(createAgentUsageList(usage));
  section.appendChild(agentsPanel);

  const modelsPanel = document.createElement("div");
  modelsPanel.className = "usage-panel";
  modelsPanel.appendChild(createText("h3", "usage-panel-title", "Models"));
  modelsPanel.appendChild(createModelBreakdown(usage));
  section.appendChild(modelsPanel);

  section.appendChild(createProjectUsagePanel(usage));
  section.appendChild(createCostAnalysisPanel(usage));
  section.appendChild(createContextBreakdownPanel(usage));
  section.appendChild(createUsageDetailsPanel(days));
  return section;
}

function sessionTitleText(session) {
  return session.displayTitle || session.sessionTitle || session.id || "";
}

function snapshotHasSession(currentSnapshot, sessionId) {
  const sessions = Array.isArray(currentSnapshot && currentSnapshot.sessions)
    ? currentSnapshot.sessions
    : [];
  return sessions.some((session) => session && session.id === sessionId);
}

function beginTitleEdit(session) {
  if (!session || !session.id) return;
  activeEdit = {
    sessionId: session.id,
    agentId: session.agentId || null,
    host: session.host || null,
    cwd: session.cwd || "",
    initialDraft: sessionTitleText(session),
    draft: sessionTitleText(session),
    committing: false,
  };
  render({ force: true });
}

function cancelTitleEdit() {
  if (!activeEdit) return;
  activeEdit = null;
  render({ force: true });
}

async function commitTitleEdit() {
  if (!activeEdit || activeEdit.committing) return;
  const edit = activeEdit;
  if (edit.draft === edit.initialDraft) {
    activeEdit = null;
    render({ force: true });
    return;
  }
  edit.committing = true;
  try {
    const result = await window.dashboardAPI.setSessionAlias({
      host: edit.host,
      agentId: edit.agentId,
      sessionId: edit.sessionId,
      cwd: edit.cwd,
      alias: edit.draft,
    });
    if (!result || result.status !== "ok") {
      edit.committing = false;
      console.warn("session alias update failed:", result && result.message);
      render({ force: true });
      return;
    }
    if (activeEdit === edit) activeEdit = null;
    render({ force: true });
  } catch (err) {
    if (activeEdit === edit) {
      edit.committing = false;
      render({ force: true });
    }
    console.warn("session alias update threw:", err);
  }
}

function createTitle(session) {
  const text = sessionTitleText(session);
  if (activeEdit && activeEdit.sessionId === session.id) {
    const input = document.createElement("input");
    input.className = "session-title-input";
    input.type = "text";
    input.value = activeEdit.draft;
    input.addEventListener("input", () => {
      if (activeEdit && activeEdit.sessionId === session.id) {
        activeEdit.draft = input.value;
      }
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitTitleEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelTitleEdit();
      }
    });
    input.addEventListener("blur", () => {
      commitTitleEdit();
    });
    requestAnimationFrame(() => {
      if (activeEdit && activeEdit.sessionId === session.id && document.contains(input)) {
        input.focus();
        input.select();
      }
    });
    return input;
  }

  const title = createText("div", "session-title", text);
  title.title = text;
  title.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    beginTitleEdit(session);
  });
  return title;
}

function appendMeta(main, session, now) {
  const meta = createText("div", "meta", "");
  const badge = document.createElement("span");
  badge.className = `badge badge-${session.badge || "idle"}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  badge.appendChild(dot);
  badge.appendChild(document.createTextNode(badgeLabel(session.badge)));

  meta.appendChild(document.createTextNode(agentLabel(session.agentId)));
  meta.appendChild(document.createTextNode(" · "));
  meta.appendChild(badge);
  meta.appendChild(document.createTextNode(` · ${formatElapsed(now - session.updatedAt)}`));
  if (session.headless) {
    meta.appendChild(document.createTextNode(` · ${t("dashboardHeadless")}`));
  }
  main.appendChild(meta);
}

function appendPath(main, session) {
  const pathText = session.cwd || t("dashboardNoPath");
  const pathEl = createText("div", "path", pathText);
  if (session.cwd) pathEl.title = session.cwd;
  main.appendChild(pathEl);
}

function appendEvent(main, session, now) {
  if (!session.lastEvent) return;
  const eventLabel = session.lastEvent.labelKey
    ? t(session.lastEvent.labelKey)
    : (session.lastEvent.rawEvent || "");
  if (!eventLabel) return;
  const eventAt = Number(session.lastEvent.at) || session.updatedAt;
  main.appendChild(createText(
    "div",
    "event-row",
    `${t("dashboardLastEventPrefix")}: ${eventLabel} · ${formatElapsed(now - eventAt)}`
  ));
}

function createIcon(session) {
  if (session.iconUrl) {
    const img = document.createElement("img");
    img.className = "agent-icon";
    img.alt = "";
    img.src = session.iconUrl;
    img.addEventListener("error", () => {
      const fallback = createText("span", "agent-fallback", agentFallback(session.agentId));
      img.replaceWith(fallback);
    }, { once: true });
    return img;
  }
  return createText("span", "agent-fallback", agentFallback(session.agentId));
}

function createHideButton(session) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "hide-session-button";
  button.textContent = "\u00d7";
  button.title = t("dashboardHideSessionTitle");
  button.setAttribute("aria-label", t("dashboardHideSessionTitle"));
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!session || !session.id || !window.dashboardAPI.hideSession) return;
    button.disabled = true;
    try {
      const result = await window.dashboardAPI.hideSession(session.id);
      if (!result || (result.status !== "ok" && result.status !== "not-found")) {
        button.disabled = false;
        console.warn("hide session failed:", result && result.message);
      }
    } catch (err) {
      button.disabled = false;
      console.warn("hide session threw:", err);
    }
  });
  return button;
}

function createCard(session, now) {
  const card = document.createElement("article");
  card.className = "card";

  if (session.id) {
    const idTail = String(session.id).slice(-3);
    card.appendChild(createText("span", "session-id-badge", `#${idTail}`));
    card.appendChild(createHideButton(session));
  }

  card.appendChild(createIcon(session));

  const main = document.createElement("div");
  main.className = "main";
  main.appendChild(createTitle(session));
  appendMeta(main, session, now);
  appendPath(main, session);
  appendEvent(main, session, now);
  card.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "actions";
  const button = document.createElement("button");
  button.type = "button";
  const focusTargetType = session.focusTarget && session.focusTarget.type;
  button.textContent = focusTargetType === "codex-thread"
    ? t("dashboardOpenCodexSession")
    : t("dashboardJumpTerminal");
  button.disabled = session.canFocus !== true;
  button.addEventListener("click", async () => {
    window.dashboardAPI.focusSession(session.id);
    // Best-effort ack alongside focus. Most remote-Codex sessions have
    // canFocus=false (no terminal-jump target) and reach ack through the
    // Mark-read button instead, but local Codex Stop sessions can land
    // here so we ack on focus too.
    if (window.dashboardAPI && typeof window.dashboardAPI.ackCompletion === "function") {
      try { await window.dashboardAPI.ackCompletion(session.id); }
      catch (err) { console.warn("ack completion threw:", err); }
    }
  });
  actions.appendChild(button);

  if (session.requiresCompletionAck === true) {
    actions.appendChild(createMarkReadButton(session));
  }

  card.appendChild(actions);

  return card;
}

function createMarkReadButton(session) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "mark-read-button";
  button.textContent = t("dashboardMarkRead");
  button.title = t("dashboardMarkReadTitle");
  button.setAttribute("aria-label", t("dashboardMarkReadTitle"));
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!session || !session.id || !window.dashboardAPI || typeof window.dashboardAPI.ackCompletion !== "function") return;
    button.disabled = true;
    try {
      const result = await window.dashboardAPI.ackCompletion(session.id);
      if (!result || (result.status !== "ok" && result.status !== "noop")) {
        // Failure path: re-enable so the user can try again. Successful
        // ack keeps the button disabled — the next forced snapshot will
        // strip requiresCompletionAck and the button disappears on
        // re-render.
        button.disabled = false;
        console.warn("ack completion failed:", result && result.message);
      }
    } catch (err) {
      button.disabled = false;
      console.warn("ack completion threw:", err);
    }
  });
  return button;
}

function deriveGroups(currentSnapshot) {
  return Array.isArray(currentSnapshot.groups) ? currentSnapshot.groups : [];
}

function createEmptyState() {
  const empty = document.createElement("div");
  empty.className = "empty";
  empty.appendChild(createText("div", "empty-title", t("dashboardEmpty")));
  empty.appendChild(createText("div", "empty-hint", t("dashboardEmptyHint")));
  return empty;
}

// ── Section hosts ──────────────────────────────────────────────────────────
// The dashboard is split into three persistent host containers so the live
// 1-second tick (session timers) only rebuilds the session list. Quota and
// usage subtrees are left untouched between data refreshes — that's what keeps
// a hovered quota card from being destroyed/recreated mid-hover (the old
// "card jumps on hover" bug came from replaceChildren() wiping everything every
// second while the pointer was over a card).
let quotaContainer = null;
let usageContainer = null;
let sessionsContainer = null;

function ensureContainers() {
  if (sessionsContainer && sessionsContainer.isConnected) return;
  quotaContainer = document.createElement("div");
  quotaContainer.className = "section-host";
  usageContainer = document.createElement("div");
  usageContainer.className = "section-host";
  sessionsContainer = document.createElement("div");
  sessionsContainer.className = "section-host";
  contentEl.replaceChildren(quotaContainer, usageContainer, sessionsContainer);
}

// Quota cards only rebuild on data change / user action — never on the 1s tick.
function renderQuota(options = {}) {
  if (quotaEditAgent && !options.force) return;
  ensureContainers();
  quotaContainer.replaceChildren(createQuotaSection());
}

function renderUsage() {
  ensureContainers();
  usageContainer.replaceChildren(createUsageSection());
}

function renderSessions(options = {}) {
  if (activeEdit && !options.force) return;
  ensureContainers();
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const count = sessions.length;
  titleEl.textContent = t("dashboardWindowTitle");
  countEl.textContent = t("dashboardCount").replace("{n}", count);
  document.title = t("dashboardWindowTitle");

  const now = Date.now();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const fragment = document.createDocumentFragment();

  if (count === 0) {
    fragment.appendChild(createEmptyState());
    sessionsContainer.replaceChildren(fragment);
    return;
  }

  for (const group of deriveGroups(snapshot)) {
    const ids = Array.isArray(group.ids) ? group.ids : [];
    const groupSessions = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!groupSessions.length) continue;

    const section = document.createElement("section");
    section.className = "group";
    const host = group.host || "";
    section.appendChild(createText("h2", "group-title", host || t("sessionLocal")));

    const cards = document.createElement("div");
    cards.className = "cards";
    for (const session of groupSessions) {
      cards.appendChild(createCard(session, now));
    }
    section.appendChild(cards);
    fragment.appendChild(section);
  }

  sessionsContainer.replaceChildren(fragment);
}

function render(options = {}) {
  renderQuota(options);
  renderUsage();
  renderSessions(options);
}

async function init() {
  window.dashboardAPI.onLangChange((payload) => {
    i18nPayload = payload || i18nPayload;
    render();
  });
  window.dashboardAPI.onSessionSnapshot((nextSnapshot) => {
    snapshot = nextSnapshot || snapshot;
    // Session pushes are frequent (state changes during active work). Only
    // touch the session list so quota/usage cards stay stable under the pointer.
    if (activeEdit && !snapshotHasSession(snapshot, activeEdit.sessionId)) {
      activeEdit = null;
      renderSessions({ force: true });
      return;
    }
    renderSessions();
  });
  if (typeof window.dashboardAPI.onUsageSnapshot === "function") {
    window.dashboardAPI.onUsageSnapshot((nextUsageSnapshot) => {
      usageSnapshot = nextUsageSnapshot || usageSnapshot;
      // Costs feed the quota cards, so refresh both — but not the session list.
      renderUsage();
      renderQuota();
    });
  }

  const [nextI18n, nextSnapshot, nextUsageSnapshot, nextQuotaLimits, nextDetected] = await Promise.all([
    window.dashboardAPI.getI18n(),
    window.dashboardAPI.getSnapshot(),
    window.dashboardAPI.getUsageSnapshot ? window.dashboardAPI.getUsageSnapshot() : Promise.resolve(null),
    window.dashboardAPI.getQuotaLimits ? window.dashboardAPI.getQuotaLimits() : Promise.resolve({}),
    window.dashboardAPI.detectAgentPlans ? window.dashboardAPI.detectAgentPlans() : Promise.resolve({}),
  ]);
  i18nPayload = nextI18n || i18nPayload;
  snapshot = nextSnapshot || snapshot;
  usageSnapshot = nextUsageSnapshot || usageSnapshot;
  quotaLimits = nextQuotaLimits || quotaLimits;
  if (nextDetected) detectedPlans = nextDetected;

  const autoCreated = [];
  for (const agentId of Object.keys(detectedPlans)) {
    if (quotaLimits[agentId]) continue;
    const planId = detectPlanId(agentId);
    if (!planId) continue;
    const presets = getPresetsForAgent(agentId);
    const match = presets.find((p) => p.id === planId);
    if (match && match.monthlyUsd > 0) {
      autoCreated.push({ agentId, monthlyLimitUsd: match.monthlyUsd });
    }
  }
  for (const entry of autoCreated) {
    try {
      const result = await window.dashboardAPI.setQuotaLimit({
        agentId: entry.agentId,
        monthlyLimitUsd: entry.monthlyLimitUsd,
        enabled: true,
      });
      if (result && result.status === "ok") {
        quotaLimits = { ...quotaLimits, [entry.agentId]: { monthlyLimitUsd: entry.monthlyLimitUsd, enabled: true } };
      }
    } catch (_) { /* ignore auto-create failures */ }
  }

  render();

  // Live tick: only the session list needs per-second updates (elapsed timers).
  // Quota + usage stay put so hovering their cards/charts is never interrupted.
  setInterval(renderSessions, 1000);
  if (window.dashboardAPI.getUsageSnapshot) {
    setInterval(async () => {
      try {
        const [nextUsage, nextQuota] = await Promise.all([
          window.dashboardAPI.getUsageSnapshot(),
          window.dashboardAPI.getQuotaLimits ? window.dashboardAPI.getQuotaLimits() : Promise.resolve(null),
        ]);
        usageSnapshot = nextUsage || usageSnapshot;
        if (nextQuota) quotaLimits = nextQuota;
        // Data-only refresh: rebuild usage + quota, leave the session list alone.
        renderUsage();
        renderQuota();
      } catch (err) {
        console.warn("usage snapshot refresh threw:", err);
      }
    }, 15000);
  }
}

init().catch((err) => {
  contentEl.textContent = err && err.message ? err.message : String(err);
});

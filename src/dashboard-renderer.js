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
let i18nPayload = { lang: "en", translations: {} };
let activeEdit = null;

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

function formatTokenBreakdown(totals = {}) {
  const tokens = Number(totals.tokens) || 0;
  const input = Number(totals.input) || 0;
  const output = Number(totals.output) || 0;
  if (tokens > 0 && input + output === 0) return "-- in / -- out";
  return `${formatCompactNumber(input)} in / ${formatCompactNumber(output)} out`;
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

function getTodayUsage() {
  return usageSnapshot && usageSnapshot.today
    ? usageSnapshot.today
    : { totals: { tokens: 0, input: 0, output: 0, sessionMs: 0, activeMs: 0 }, agents: [] };
}

function createAgentUsageList(today) {
  const list = document.createElement("div");
  list.className = "usage-agent-list";
  const header = document.createElement("div");
  header.className = "usage-agent-row usage-agent-head";
  header.appendChild(createText("span", "", ""));
  header.appendChild(createText("span", "usage-agent-name", "Agent"));
  header.appendChild(createText("span", "usage-agent-value muted", "Tokens"));
  header.appendChild(createText("span", "usage-agent-value muted", "Session"));
  header.appendChild(createText("span", "usage-agent-value muted", "Active"));
  list.appendChild(header);

  const agents = Array.isArray(today.agents) ? today.agents : [];
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

    const name = createText("span", "usage-agent-name", agentLabel(agent.agentId));
    row.appendChild(name);

    row.appendChild(createText("span", "usage-agent-value", formatCompactNumber(agent.tokens)));
    row.appendChild(createText("span", "usage-agent-value muted", formatUsageDuration(agent.sessionMs)));
    row.appendChild(createText("span", "usage-agent-value muted", formatUsageDuration(agent.activeMs)));
    list.appendChild(row);
  });
  return list;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

function collectChartAgents(days) {
  const ids = new Set();
  for (const day of days) {
    for (const agent of (Array.isArray(day.agents) ? day.agents : [])) {
      if (agent.tokens > 0) ids.add(agent.agentId || "unknown");
    }
  }
  return Array.from(ids);
}

function renderUsageChart(days) {
  const chart = document.createElement("div");
  chart.className = "usage-chart";
  const safeDays = Array.isArray(days) && days.length ? days : [];
  if (!safeDays.length) {
    chart.appendChild(createText("div", "usage-empty", "No trend yet"));
    return chart;
  }

  const width = 620;
  const height = 210;
  const pad = { left: 50, right: 44, top: 16, bottom: 30 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxTokens = Math.max(1, ...safeDays.map((day) => Number(day.totals && day.totals.tokens) || 0));
  const maxTime = Math.max(1, ...safeDays.map((day) =>
    Math.max(
      Number(day.totals && day.totals.sessionMs) || 0,
      Number(day.totals && day.totals.activeMs) || 0
    )
  ));
  const agents = collectChartAgents(safeDays);
  const step = plotW / safeDays.length;
  const barW = Math.max(14, Math.min(34, step * 0.48));
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": "Trend" });

  // --- x-axis ---
  svg.appendChild(svgEl("line", {
    x1: pad.left,
    y1: pad.top + plotH,
    x2: width - pad.right,
    y2: pad.top + plotH,
    class: "chart-axis",
  }));

  // --- left y-axis: token grid lines + labels ---
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

  // --- right y-axis: time labels ---
  const timeStep = niceTickStep(maxTime);
  for (let tick = 0; tick <= maxTime + 1e-9; tick += timeStep) {
    const y = pad.top + plotH - (tick / maxTime) * plotH;
    const label = svgEl("text", { x: width - pad.right + 6, y: y + 4, class: "chart-y-label chart-y-label-right", "text-anchor": "start" });
    label.textContent = formatUsageDuration(tick);
    svg.appendChild(label);
  }

  // --- left y-axis line ---
  svg.appendChild(svgEl("line", {
    x1: pad.left,
    y1: pad.top,
    x2: pad.left,
    y2: pad.top + plotH,
    class: "chart-axis",
  }));

  safeDays.forEach((day, dayIndex) => {
    const x = pad.left + step * dayIndex + step / 2 - barW / 2;
    let yCursor = pad.top + plotH;
    agents.forEach((agentId, agentIndex) => {
      const agent = (day.agents || []).find((entry) => (entry.agentId || "unknown") === agentId);
      const tokens = agent ? Number(agent.tokens) || 0 : 0;
      if (tokens <= 0) return;
      const segmentH = Math.max(1, tokens / maxTokens * plotH);
      yCursor -= segmentH;
      svg.appendChild(svgEl("rect", {
        x,
        y: yCursor,
        width: barW,
        height: segmentH,
        rx: 3,
        fill: agentColor(agentId, agentIndex),
        opacity: 0.92,
      }));
    });

    const label = String(day.day || "").slice(5).replace("-", "/");
    const text = svgEl("text", {
      x: pad.left + step * dayIndex + step / 2,
      y: height - 9,
      class: "chart-day",
      "text-anchor": "middle",
    });
    text.textContent = label;
    svg.appendChild(text);
  });

  // Monotone cubic interpolation (Fritsch-Carlson).
  // Guarantees the curve stays within the data range — no overshoot below 0.
  function smoothLinePath(pts) {
    const n = pts.length;
    if (n < 2) return "";
    if (n === 2) {
      return `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)} L ${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;
    }

    // Uniform x spacing
    const dx = pts[1].x - pts[0].x;

    // Secant slopes for each segment
    const segSlopes = new Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      segSlopes[i] = dx > 0 ? (pts[i + 1].y - pts[i].y) / dx : 0;
    }

    // Tangents at each point (central-difference weighted harmonic mean)
    const m = new Array(n);
    m[0] = segSlopes[0];
    m[n - 1] = segSlopes[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (segSlopes[i - 1] * segSlopes[i] <= 0) {
        m[i] = 0; // sign change → flat
      } else {
        // Harmonic mean of the two adjacent secant slopes
        m[i] = 2 / (1 / segSlopes[i - 1] + 1 / segSlopes[i]);
      }
    }

    // Fritsch-Carlson monotonicity constraint
    for (let i = 0; i < n - 1; i++) {
      const dy = pts[i + 1].y - pts[i].y;
      if (Math.abs(dy) < 1e-9) {
        m[i] = 0;
        m[i + 1] = 0;
        continue;
      }
      const segM = dy / dx;
      const alpha = m[i] / segM;
      const beta = m[i + 1] / segM;
      if (alpha < 0 || beta < 0) {
        m[i] = 0;
        m[i + 1] = 0;
      }
      const mag = alpha * alpha + beta * beta;
      if (mag > 9) {
        const tau = 3 / Math.sqrt(mag);
        m[i] = tau * alpha * segM;
        m[i + 1] = tau * beta * segM;
      }
    }

    // Build cubic Bezier path
    const d3 = dx / 3;
    let d = `M ${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < n - 1; i++) {
      const cp1x = pts[i].x + d3;
      const cp1y = pts[i].y + m[i] * d3;
      const cp2x = pts[i + 1].x - d3;
      const cp2y = pts[i + 1].y - m[i + 1] * d3;
      d += ` C ${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
    }
    return d;
  }

  function buildLine(field, className, fillClass) {
    const points = safeDays.map((day, dayIndex) => {
      const value = Number(day.totals && day.totals[field]) || 0;
      const x = pad.left + step * dayIndex + step / 2;
      const y = pad.top + plotH - value / maxTime * plotH;
      return { x, y };
    });
    if (points.length < 2) return;
    const d = smoothLinePath(points);
    svg.appendChild(svgEl("path", {
      d,
      class: className,
      fill: "none",
    }));
    // Gradient fill beneath the line
    if (fillClass) {
      const bottomY = pad.top + plotH;
      const firstX = points[0].x;
      const lastX = points[points.length - 1].x;
      const areaD = `${d} L ${lastX.toFixed(1)},${bottomY} L ${firstX.toFixed(1)},${bottomY} Z`;
      svg.appendChild(svgEl("path", {
        d: areaD,
        class: fillClass,
      }));
    }
  }

  buildLine("sessionMs", "chart-line session-line", "chart-fill-session");
  buildLine("activeMs", "chart-line active-line", "chart-fill-active");
  chart.appendChild(svg);

  const legend = document.createElement("div");
  legend.className = "usage-legend";
  agents.slice(0, 8).forEach((agentId, index) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = agentColor(agentId, index);
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(agentLabel(agentId)));
    legend.appendChild(item);
  });
  for (const [label, className] of [["Session", "legend-line session-line"], ["Active", "legend-line active-line"]]) {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.appendChild(createText("span", className, ""));
    item.appendChild(document.createTextNode(label));
    legend.appendChild(item);
  }
  chart.appendChild(legend);
  return chart;
}

function createUsageSection() {
  const today = getTodayUsage();
  const totals = today.totals || {};
  const section = document.createElement("section");
  section.className = "usage-section";

  const header = document.createElement("div");
  header.className = "usage-header";
  header.appendChild(createText("h2", "usage-title", "Usage"));
  header.appendChild(createText("span", "usage-range", "Today"));
  section.appendChild(header);

  const summary = document.createElement("div");
  summary.className = "usage-summary";
  summary.appendChild(createMetric("Tokens", formatCompactNumber(totals.tokens), formatTokenBreakdown(totals)));
  summary.appendChild(createMetric("Session", formatUsageDuration(totals.sessionMs), "wall clock"));
  summary.appendChild(createMetric("Active", formatUsageDuration(totals.activeMs), "agent busy"));
  section.appendChild(summary);

  const agentsPanel = document.createElement("div");
  agentsPanel.className = "usage-panel";
  agentsPanel.appendChild(createText("h3", "usage-panel-title", "Agents"));
  agentsPanel.appendChild(createAgentUsageList(today));
  section.appendChild(agentsPanel);

  const chartPanel = document.createElement("div");
  chartPanel.className = "usage-panel chart-panel";
  chartPanel.appendChild(createText("h3", "usage-panel-title", "Trend"));
  chartPanel.appendChild(renderUsageChart(usageSnapshot && usageSnapshot.days));
  section.appendChild(chartPanel);
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

function render(options = {}) {
  if (activeEdit && !options.force) return;
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const count = sessions.length;
  titleEl.textContent = t("dashboardWindowTitle");
  countEl.textContent = t("dashboardCount").replace("{n}", count);
  document.title = t("dashboardWindowTitle");

  const now = Date.now();
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const fragment = document.createDocumentFragment();
  fragment.appendChild(createUsageSection());

  if (count === 0) {
    fragment.appendChild(createEmptyState());
    contentEl.replaceChildren(fragment);
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

  contentEl.replaceChildren(fragment);
}

async function init() {
  window.dashboardAPI.onLangChange((payload) => {
    i18nPayload = payload || i18nPayload;
    render();
  });
  window.dashboardAPI.onSessionSnapshot((nextSnapshot) => {
    snapshot = nextSnapshot || snapshot;
    if (activeEdit && !snapshotHasSession(snapshot, activeEdit.sessionId)) {
      activeEdit = null;
      render({ force: true });
      return;
    }
    render();
  });
  if (typeof window.dashboardAPI.onUsageSnapshot === "function") {
    window.dashboardAPI.onUsageSnapshot((nextUsageSnapshot) => {
      usageSnapshot = nextUsageSnapshot || usageSnapshot;
      render();
    });
  }

  const [nextI18n, nextSnapshot, nextUsageSnapshot] = await Promise.all([
    window.dashboardAPI.getI18n(),
    window.dashboardAPI.getSnapshot(),
    window.dashboardAPI.getUsageSnapshot ? window.dashboardAPI.getUsageSnapshot() : Promise.resolve(null),
  ]);
  i18nPayload = nextI18n || i18nPayload;
  snapshot = nextSnapshot || snapshot;
  usageSnapshot = nextUsageSnapshot || usageSnapshot;
  render();

  setInterval(render, 1000);
  if (window.dashboardAPI.getUsageSnapshot) {
    setInterval(async () => {
      try {
        usageSnapshot = await window.dashboardAPI.getUsageSnapshot() || usageSnapshot;
        render();
      } catch (err) {
        console.warn("usage snapshot refresh threw:", err);
      }
    }, 15000);
  }
}

init().catch((err) => {
  contentEl.textContent = err && err.message ? err.message : String(err);
});

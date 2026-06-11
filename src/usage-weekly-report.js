"use strict";

// ── Weekly usage report ──────────────────────────────────────────────────────
// Builds a shareable "my AI coding week" summary from a usage snapshot and
// paints it onto a canvas for PNG export. Dual-environment module: loaded as a
// plain <script> by dashboard.html (window.UsageWeeklyReport) and via require
// in tests / main. No DOM access at load time; the painter only touches the
// canvas it is given.

(function () {

  function metricNumber(totals, camel, snake) {
    if (!totals || typeof totals !== "object") return 0;
    const value = Number(totals[camel]);
    if (Number.isFinite(value)) return value;
    const alias = Number(totals[snake]);
    return Number.isFinite(alias) ? alias : 0;
  }

  function rowTokens(row) {
    return metricNumber(row && (row.totals || row), "tokens", "total_tokens");
  }

  function mergeTop(map, rows, keyOf) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row) continue;
      const key = keyOf(row);
      const tokens = rowTokens(row);
      if (!map.has(key)) map.set(key, { ...row, tokens });
      else map.get(key).tokens += tokens;
    }
  }

  function topOf(map) {
    let best = null;
    for (const row of map.values()) {
      if (row.tokens <= 0) continue;
      if (!best || row.tokens > best.tokens) best = row;
    }
    return best;
  }

  // buildWeeklyReport(snapshot) → pure data for the card. Uses the last 7
  // day entries of the snapshot (the dashboard always requests ≥7 days).
  function buildWeeklyReport(snapshot) {
    const allDays = Array.isArray(snapshot && snapshot.days) ? snapshot.days : [];
    const days = allDays.slice(-7);
    const totals = { tokens: 0, costUsd: 0, activeMs: 0, conversations: 0 };
    const models = new Map();
    const projects = new Map();
    const dayRows = [];

    for (const day of days) {
      const dayTotals = day && day.totals ? day.totals : {};
      const tokens = metricNumber(dayTotals, "tokens", "total_tokens");
      const costUsd = metricNumber(dayTotals, "costUsd", "total_cost_usd");
      totals.tokens += tokens;
      totals.costUsd += costUsd;
      totals.activeMs += metricNumber(dayTotals, "activeMs", "active_ms");
      totals.conversations += metricNumber(dayTotals, "conversationCount", "conversation_count");
      mergeTop(models, day && day.models, (row) => `${row.source || "unknown"}|${row.model || "unknown"}`);
      mergeTop(projects, day && day.projects, (row) => row.projectRef || row.name || "unknown");
      dayRows.push({ day: (day && day.day) || "", tokens, costUsd });
    }

    const topModel = topOf(models);
    const topProject = topOf(projects);
    const heatmap = snapshot && snapshot.heatmap ? snapshot.heatmap : null;

    return {
      range: {
        startDay: dayRows.length ? dayRows[0].day : "",
        endDay: dayRows.length ? dayRows[dayRows.length - 1].day : "",
      },
      totals,
      activeDays: dayRows.filter((row) => row.tokens > 0).length,
      streakDays: heatmap && Number.isFinite(Number(heatmap.streakDays))
        ? Number(heatmap.streakDays)
        : 0,
      topModel: topModel
        ? { model: topModel.model || "unknown", source: topModel.source || "", tokens: topModel.tokens }
        : null,
      topProject: topProject
        ? { name: topProject.name || "Unknown", projectRef: topProject.projectRef || "", tokens: topProject.tokens }
        : null,
      days: dayRows,
      hasUsage: totals.tokens > 0,
    };
  }

  function dayKeyToDate(dayKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ""));
    if (!match) return null;
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }

  function localeFor(lang) {
    if (lang === "zh") return "zh-CN";
    return lang || "en";
  }

  function formatRange(report, lang) {
    const start = dayKeyToDate(report.range.startDay);
    const end = dayKeyToDate(report.range.endDay);
    if (!start || !end) return "";
    const locale = localeFor(lang);
    try {
      const opts = { month: "short", day: "numeric" };
      return `${start.toLocaleDateString(locale, opts)} – ${end.toLocaleDateString(locale, opts)}`;
    } catch {
      return `${report.range.startDay} – ${report.range.endDay}`;
    }
  }

  function weekdayLabel(dayKey, lang) {
    const date = dayKeyToDate(dayKey);
    if (!date) return "";
    try {
      return date.toLocaleDateString(localeFor(lang), { weekday: "short" });
    } catch {
      return String(date.getDay());
    }
  }

  function truncateText(ctx, text, maxWidth) {
    let value = String(text || "");
    if (ctx.measureText(value).width <= maxWidth) return value;
    while (value.length > 1 && ctx.measureText(`${value}…`).width > maxWidth) {
      value = value.slice(0, -1);
    }
    return `${value}…`;
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  const CARD_WIDTH = 480;
  const CARD_HEIGHT = 640;

  // drawWeeklyCard(canvas, report, { t, lang, colors, formatters, scale })
  // Pure painter: everything it needs is passed in. `formatters` supplies the
  // dashboard's number/cost/duration formatting so the card matches the UI.
  function drawWeeklyCard(canvas, report, options = {}) {
    const t = typeof options.t === "function" ? options.t : (key) => key;
    const lang = options.lang || "en";
    const scale = Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 2;
    const colors = {
      bg: "#161a22",
      surface: "#1f2531",
      text: "#f3f5f9",
      muted: "#8b93a7",
      accent: "#d4945c",
      bar: "#6b7fff",
      ...options.colors,
    };
    const formatters = {
      tokens: (value) => String(Math.round(value)),
      cost: (value) => `$${(Number(value) || 0).toFixed(2)}`,
      duration: (ms) => `${Math.round((Number(ms) || 0) / 60000)}m`,
      ...options.formatters,
    };

    canvas.width = CARD_WIDTH * scale;
    canvas.height = CARD_HEIGHT * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    roundedRectPath(ctx, 0, 0, CARD_WIDTH, CARD_HEIGHT, 24);
    ctx.fillStyle = colors.bg;
    ctx.fill();

    const pad = 36;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    ctx.fillStyle = colors.text;
    ctx.font = "600 22px system-ui, sans-serif";
    ctx.fillText(t("usageWeeklyCardTitle"), pad, 60);
    ctx.fillStyle = colors.muted;
    ctx.font = "400 13px system-ui, sans-serif";
    ctx.fillText(formatRange(report, lang), pad, 84);

    if (!report.hasUsage) {
      ctx.fillStyle = colors.muted;
      ctx.font = "400 15px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(t("usageWeeklyEmpty"), CARD_WIDTH / 2, CARD_HEIGHT / 2);
      ctx.textAlign = "left";
      drawFooter(ctx, colors, pad);
      return;
    }

    // Hero numbers: tokens + API-equivalent value.
    ctx.fillStyle = colors.text;
    ctx.font = "700 36px system-ui, sans-serif";
    ctx.fillText(formatters.tokens(report.totals.tokens), pad, 152);
    ctx.fillStyle = colors.muted;
    ctx.font = "400 12px system-ui, sans-serif";
    ctx.fillText(t("usageWeeklyTokens"), pad, 172);

    ctx.fillStyle = colors.accent;
    ctx.font = "700 36px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(formatters.cost(report.totals.costUsd), CARD_WIDTH - pad, 152);
    ctx.fillStyle = colors.muted;
    ctx.font = "400 12px system-ui, sans-serif";
    ctx.fillText(t("usageWeeklyCostLabel"), CARD_WIDTH - pad, 172);
    ctx.textAlign = "left";

    // 2×2 stat grid.
    const stats = [
      { label: t("usageWeeklyActiveTime"), value: formatters.duration(report.totals.activeMs) },
      { label: t("usageWeeklyConversations"), value: formatters.tokens(report.totals.conversations) },
      { label: t("usageWeeklyActiveDays"), value: `${report.activeDays}/7` },
      { label: t("usageWeeklyStreak"), value: String(report.streakDays) },
    ];
    const cellWidth = (CARD_WIDTH - pad * 2) / 2;
    stats.forEach((stat, index) => {
      const x = pad + (index % 2) * cellWidth;
      const y = 220 + Math.floor(index / 2) * 64;
      ctx.fillStyle = colors.muted;
      ctx.font = "400 11px system-ui, sans-serif";
      ctx.fillText(stat.label, x, y);
      ctx.fillStyle = colors.text;
      ctx.font = "600 19px system-ui, sans-serif";
      ctx.fillText(stat.value, x, y + 24);
    });

    // Seven daily bars.
    const chartTop = 372;
    const chartHeight = 110;
    const slot = (CARD_WIDTH - pad * 2) / 7;
    const barWidth = Math.min(40, slot - 12);
    const maxTokens = Math.max(1, ...report.days.map((day) => day.tokens));
    report.days.forEach((day, index) => {
      const height = Math.max(day.tokens > 0 ? 4 : 2, Math.round(day.tokens / maxTokens * chartHeight));
      const x = pad + index * slot + (slot - barWidth) / 2;
      const y = chartTop + chartHeight - height;
      roundedRectPath(ctx, x, y, barWidth, height, 4);
      ctx.fillStyle = day.tokens > 0 ? colors.bar : colors.surface;
      ctx.fill();
      ctx.fillStyle = colors.muted;
      ctx.font = "400 10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(weekdayLabel(day.day, lang), x + barWidth / 2, chartTop + chartHeight + 18);
      ctx.textAlign = "left";
    });

    // Top model / top project.
    const listTop = 540;
    const rows = [
      { label: t("usageWeeklyTopModel"), value: report.topModel ? report.topModel.model : "—" },
      { label: t("usageWeeklyTopProject"), value: report.topProject ? report.topProject.name : "—" },
    ];
    rows.forEach((row, index) => {
      const y = listTop + index * 28;
      ctx.fillStyle = colors.muted;
      ctx.font = "400 12px system-ui, sans-serif";
      ctx.fillText(row.label, pad, y);
      ctx.fillStyle = colors.text;
      ctx.font = "600 13px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.fillText(truncateText(ctx, row.value, CARD_WIDTH - pad * 2 - 120), CARD_WIDTH - pad, y);
      ctx.textAlign = "left";
    });

    drawFooter(ctx, colors, pad);
  }

  function drawFooter(ctx, colors, pad) {
    ctx.fillStyle = colors.accent;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText("Petlaude", pad, CARD_HEIGHT - 24);
  }

  const api = { buildWeeklyReport, drawWeeklyCard, CARD_WIDTH, CARD_HEIGHT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.UsageWeeklyReport = api;
})();

"use strict";

// ── Rate-limit window estimation ─────────────────────────────────────────────
// Claude (and Codex) subscriptions meter usage in rolling 5-hour windows: the
// window opens with the first request and closes 5 hours later; the next
// request after that opens a fresh window. Following the ccusage convention,
// the window start is floored to the hour (UTC), which makes the boundary
// reconstructable from half-hour usage buckets: windows always start and end
// on whole hours, so no half-hour bucket ever straddles a boundary and the
// bucket-based chaining is exactly equivalent to per-event chaining.
//
// Inputs are plain rows: { at, source, tokens, costUsd }. Pure module — no
// Electron, no clock access (caller passes `now`).

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 5 * HOUR_MS;

function floorToHour(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Chains activity rows for one source into consecutive windows and returns
// the last window plus the historical peak token count across all windows.
function chainWindows(rows, windowMs) {
  let start = null;
  let end = null;
  let tokens = 0;
  let costUsd = 0;
  let peakTokens = 0;

  for (const row of rows) {
    if (start === null || row.at >= end) {
      peakTokens = Math.max(peakTokens, tokens);
      start = floorToHour(row.at);
      end = start + windowMs;
      tokens = 0;
      costUsd = 0;
    }
    tokens += finiteNumber(row.tokens);
    costUsd += finiteNumber(row.costUsd);
  }
  peakTokens = Math.max(peakTokens, tokens);
  return { start, end, tokens, costUsd, peakTokens };
}

// computeRateLimitWindows(activities, { now, windowMs }) → array of active
// windows, one per source, sorted by tokens desc:
//   { source, start, end, remainingMs, elapsedRatio, tokens, costUsd,
//     peakTokens, peakRatio }
// Sources whose last window already expired are omitted.
function computeRateLimitWindows(activities, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : DEFAULT_WINDOW_MS;

  const bySource = new Map();
  for (const activity of Array.isArray(activities) ? activities : []) {
    if (!activity || typeof activity !== "object") continue;
    const at = Number(activity.at);
    if (!Number.isFinite(at) || at > now) continue;
    const source = typeof activity.source === "string" && activity.source.trim()
      ? activity.source.trim()
      : "unknown";
    if (!bySource.has(source)) bySource.set(source, []);
    bySource.get(source).push({ ...activity, at });
  }

  const windows = [];
  for (const [source, rows] of bySource.entries()) {
    rows.sort((a, b) => a.at - b.at);
    const last = chainWindows(rows, windowMs);
    if (last.start === null || now >= last.end) continue;
    const elapsedRatio = Math.min(1, Math.max(0, (now - last.start) / windowMs));
    windows.push({
      source,
      start: last.start,
      end: last.end,
      remainingMs: last.end - now,
      elapsedRatio,
      tokens: last.tokens,
      costUsd: last.costUsd,
      peakTokens: last.peakTokens,
      peakRatio: last.peakTokens > 0
        ? Math.round(last.tokens / last.peakTokens * 1000) / 1000
        : null,
    });
  }
  windows.sort((a, b) => b.tokens - a.tokens || a.source.localeCompare(b.source));
  return windows;
}

module.exports = {
  computeRateLimitWindows,
  DEFAULT_WINDOW_MS,
};

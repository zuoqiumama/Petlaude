"use strict";

// ── Context-Aware reaction engine ────────────────────────────────────────────
// Pure, in-memory rolling-counter engine that decides which context reaction
// (if any) the pet should play based on the stream of session/usage events.
// No persistence, no Electron. The HOST (main.js) feeds events and only calls
// takePending() while the pet is idle (not DND/mini) — gating is the caller's
// job; this engine just tracks rules and holds pendings until consumed.
//
// Events (onSessionEvent):
//   { type: "state", state }                  dominant pet state changed
//   { type: "sessionStart", id }              an agent session began
//   { type: "sessionEnd", id }                an agent session ended
//   { type: "usage", dailyTokens }            cumulative tokens for the day
//
// takePending() returns the single highest-priority pending reaction
// ({ actionId }) and clears it (applying that rule's cooldown), or null.

const { getAction } = require("./action-manifest");

const DAY_MS = 24 * 60 * 60 * 1000;

// "busy" states that continue a smooth-work streak. Anything else (idle,
// sleeping, error, …) breaks it.
const BUSY_STATES = new Set(["working", "thinking", "juggling", "sweeping", "carrying"]);

// Highest number = highest priority when multiple reactions are pending.
const PRIORITY = {
  errorStreak: 6,
  breakReminder: 5,
  smoothWork: 4,
  tokenMilestone: 3,
  sessionEnd: 2,
  firstSession: 1,
};

// Default thresholds derived from the manifest so runtime + generation stay in
// sync. Each rule maps to its manifest action id.
function defaultConfigs() {
  const t = (id) => (getAction(id) && getAction(id).trigger) || {};
  return {
    errorStreak: { actionId: "error-comfort", count: t("error-comfort").count || 3, windowMs: t("error-comfort").windowMs || 600000, cooldownMs: t("error-comfort").cooldownMs || 600000 },
    smoothWork: { actionId: "smooth-thumbsup", workingMinMs: t("smooth-thumbsup").workingMinMs || 1800000, cooldownMs: t("smooth-thumbsup").cooldownMs || 1800000 },
    sessionEnd: { actionId: "bye-wave", cooldownMs: t("bye-wave").cooldownMs || 0 },
    firstSession: { actionId: "good-morning", cooldownMs: t("good-morning").cooldownMs || 0 },
    breakReminder: { actionId: "break-reminder", continuousWorkMs: t("break-reminder").continuousWorkMs || 3600000, cooldownMs: t("break-reminder").cooldownMs || 3600000 },
    tokenMilestone: { actionId: "celebration", stepTokens: t("celebration").stepTokens || 100000 },
  };
}

function createContextReactionEngine(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const cfg = { ...defaultConfigs(), ...(options.configs || {}) };

  let lastState = "idle";
  let errorTimes = [];
  const lastFired = Object.create(null);
  const pending = new Set();

  // smooth-work: start of the current uninterrupted busy run (no errors)
  let busyStart = null;
  // break-reminder: when sessions first became active (>=1 open session)
  let sessionActiveStart = null;
  const activeSessions = new Set();
  let lastSessionDay = null;
  let lastMilestoneIndex = 0;

  function cooldownOk(type) {
    const last = lastFired[type];
    const cd = (cfg[type] && cfg[type].cooldownMs) || 0;
    return last == null || (now() - last) >= cd;
  }

  function pruneErrors() {
    const cutoff = now() - cfg.errorStreak.windowMs;
    errorTimes = errorTimes.filter((ts) => ts >= cutoff);
  }

  // Recompute the continuously-evaluated rules (error streak, smooth work,
  // break reminder) and set pendings when their thresholds are met.
  function evaluate() {
    pruneErrors();
    if (errorTimes.length >= cfg.errorStreak.count && cooldownOk("errorStreak")) {
      pending.add("errorStreak");
    }
    if (busyStart != null && (now() - busyStart) >= cfg.smoothWork.workingMinMs && cooldownOk("smoothWork")) {
      pending.add("smoothWork");
    }
    if (sessionActiveStart != null && (now() - sessionActiveStart) >= cfg.breakReminder.continuousWorkMs && cooldownOk("breakReminder")) {
      pending.add("breakReminder");
    }
  }

  function onState(state) {
    if (state === "error" && lastState !== "error") {
      errorTimes.push(now());
      busyStart = null; // an error breaks the smooth-work streak
    }
    if (BUSY_STATES.has(state)) {
      if (busyStart == null) busyStart = now();
    } else {
      busyStart = null; // non-busy (idle/sleeping/error) breaks the streak
    }
    lastState = state;
    evaluate();
  }

  function onSessionStart(id) {
    if (activeSessions.size === 0) sessionActiveStart = now();
    if (id != null) activeSessions.add(id);
    const day = Math.floor(now() / DAY_MS);
    if (lastSessionDay !== day) {
      lastSessionDay = day;
      if (cooldownOk("firstSession")) pending.add("firstSession");
    }
    evaluate();
  }

  function onSessionEnd(id) {
    if (id != null) activeSessions.delete(id);
    if (cooldownOk("sessionEnd")) pending.add("sessionEnd");
    if (activeSessions.size === 0) {
      sessionActiveStart = null;
      busyStart = null;
    }
    evaluate();
  }

  function onUsage(dailyTokens) {
    const step = cfg.tokenMilestone.stepTokens;
    if (!(step > 0) || !Number.isFinite(dailyTokens)) return;
    const idx = Math.floor(dailyTokens / step);
    if (idx > lastMilestoneIndex) {
      lastMilestoneIndex = idx;
      pending.add("tokenMilestone");
    }
    evaluate();
  }

  function onSessionEvent(evt) {
    if (!evt || typeof evt !== "object") return;
    switch (evt.type) {
      case "state": onState(evt.state); break;
      case "sessionStart": onSessionStart(evt.id); break;
      case "sessionEnd": onSessionEnd(evt.id); break;
      case "usage": onUsage(evt.dailyTokens); break;
      default: break;
    }
  }

  function takePending() {
    evaluate();
    if (pending.size === 0) return null;
    let best = null;
    let bestP = -Infinity;
    for (const type of pending) {
      const p = PRIORITY[type] || 0;
      if (p > bestP) { bestP = p; best = type; }
    }
    if (!best) return null;
    pending.delete(best);
    lastFired[best] = now();
    return { actionId: cfg[best].actionId };
  }

  return { onSessionEvent, takePending };
}

module.exports = { createContextReactionEngine, defaultConfigs, PRIORITY, BUSY_STATES };

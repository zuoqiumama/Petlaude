"use strict";

// ── Idle-life scheduler ──────────────────────────────────────────────────────
// Pure logic that decides which idle-life behavior (if any) to play while the
// pet is idle. Driven by tick.js inside the existing 20s–60s idle window. It
// NEVER changes currentState — picks are rendered through the same
// "state-change → idle → <svg>" path the built-in idleAnimations use, so any
// mouse move / agent state change cancels them via the existing cleanup.
//
// Behavior shape (flat, scheduler-facing):
//   { id, file, durationMs, weight, idleMinMs, hourRange?, hover? }
// Theme `idleLife.behaviors[]` (trigger nested) is flattened via normalizeBehaviors.

function hourInRange(range, hour) {
  if (!Array.isArray(range) || range.length !== 2) return true;
  const [start, end] = range;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
  // Inclusive; supports wrap-around windows like [23, 6] (11pm–6am).
  return start <= end ? hour >= start && hour <= end : hour >= start || hour <= end;
}

function weightedPick(candidates, random) {
  const total = candidates.reduce((sum, b) => sum + (b.weight > 0 ? b.weight : 0), 0);
  if (total <= 0) return candidates[0] || null;
  let r = random() * total;
  for (const b of candidates) {
    r -= b.weight > 0 ? b.weight : 0;
    if (r <= 0) return b;
  }
  return candidates[candidates.length - 1];
}

function createIdleLifeScheduler(options = {}) {
  const behaviors = Array.isArray(options.behaviors) ? options.behaviors : [];
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const random = typeof options.random === "function" ? options.random : Math.random;
  const hour = typeof options.hour === "function" ? options.hour : () => new Date().getHours();
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : 30000;

  let lastPickAt = -Infinity;

  function eligible(idleElapsedMs) {
    const h = hour();
    return behaviors.filter((b) =>
      b
      && !b.hover
      && b.file
      && (Number.isFinite(b.idleMinMs) ? b.idleMinMs : 0) <= idleElapsedMs
      && hourInRange(b.hourRange, h));
  }

  function pick(idleElapsedMs) {
    if (now() - lastPickAt < cooldownMs) return null;
    const candidates = eligible(idleElapsedMs);
    if (candidates.length === 0) return null;
    const chosen = weightedPick(candidates, random);
    if (!chosen) return null;
    lastPickAt = now();
    return chosen;
  }

  function reset() {
    lastPickAt = -Infinity;
  }

  return { pick, reset };
}

// Flatten theme `idleLife.behaviors` (with nested `trigger`) into the flat
// scheduler shape. Pure; immutable (returns new objects).
function normalizeBehaviors(behaviors) {
  if (!Array.isArray(behaviors)) return [];
  return behaviors.map((b) => {
    const t = (b && b.trigger) || {};
    return {
      id: b.id,
      file: b.file,
      durationMs: Number.isFinite(b.duration) ? b.duration : (b.durationMs || 0),
      weight: Number.isFinite(t.weight) ? t.weight : (b.weight || 0),
      idleMinMs: Number.isFinite(t.idleMinMs) ? t.idleMinMs : (b.idleMinMs || 0),
      hourRange: Array.isArray(t.hourRange) ? [...t.hourRange] : (Array.isArray(b.hourRange) ? [...b.hourRange] : null),
      hover: !!(t.hover || b.hover),
    };
  });
}

// Clamp a sideways wander target so the pet stays fully inside the work area.
// Pure. dx may be negative.
function computeWanderTarget(bounds, workArea, dx) {
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - bounds.width;
  const targetX = Math.round(bounds.x + dx);
  return {
    x: Math.max(minX, Math.min(maxX, targetX)),
    y: bounds.y,
  };
}

// ── tick.js integration helper ───────────────────────────────────────────────
// Decides + triggers an idle-life behavior. Returns the played behavior or null.
// Conflict-safety: bails unless idle, not DND, not mini. Renders via the idle
// state-change path and arms a return-to-idle timer (caller owns the timer ref
// through ctx so a state change can clear it).
function maybePlayIdleLife(ctx, idleElapsedMs, scheduler) {
  if (!ctx || !scheduler) return null;
  if (ctx.doNotDisturb || ctx.miniMode || ctx.currentState !== "idle") return null;
  const behavior = scheduler.pick(idleElapsedMs);
  if (!behavior) return null;

  if (typeof ctx.sendToRenderer === "function") {
    ctx.sendToRenderer("state-change", "idle", behavior.file);
  }
  if (typeof ctx.sendToHitWin === "function") {
    ctx.sendToHitWin("hit-state-sync", { currentSvg: behavior.file });
  }
  // Optional wander window move.
  if (behavior.windowMove && typeof ctx.moveWindowBy === "function") {
    const [lo, hi] = behavior.windowMove.dxRange || [0, 0];
    const mag = lo + (hi - lo) * (typeof ctx.random === "function" ? ctx.random() : Math.random());
    const dir = (typeof ctx.random === "function" ? ctx.random() : Math.random()) < 0.5 ? -1 : 1;
    ctx.moveWindowBy(Math.round(mag) * dir);
  }
  return behavior;
}

module.exports = {
  createIdleLifeScheduler,
  normalizeBehaviors,
  computeWanderTarget,
  maybePlayIdleLife,
  hourInRange,
};

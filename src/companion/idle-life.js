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

// ── tick.js integration helpers ──────────────────────────────────────────────
// Decides + triggers an idle-life behavior. Returns the played behavior or null.
// Conflict-safety: bails unless idle, not DND, not mini. Renders via the idle
// state-change path (currentState stays "idle"; only the SVG changes, so eye
// tracking naturally pauses because currentSvg !== idle-follow). Arms a
// self-managed return timer stored on ctx so cancelIdleLife() can clear it.
function maybePlayIdleLife(ctx, idleElapsedMs, scheduler) {
  if (!ctx || !scheduler) return null;
  if (ctx.doNotDisturb || ctx.miniMode || ctx.currentState !== "idle") return null;
  if (ctx._idleLifeActive) return null; // one at a time
  const behavior = scheduler.pick(idleElapsedMs);
  if (!behavior) return null;

  const setTimer = typeof ctx.setTimeout === "function" ? ctx.setTimeout : setTimeout;

  if (typeof ctx.sendToRenderer === "function") {
    ctx.sendToRenderer("state-change", "idle", behavior.file);
  }
  if (typeof ctx.sendToHitWin === "function") {
    ctx.sendToHitWin("hit-state-sync", { currentSvg: behavior.file });
  }
  // Optional wander window move (Task 2.3 supplies ctx.moveWindowBy).
  if (behavior.windowMove && typeof ctx.moveWindowBy === "function") {
    const [lo, hi] = behavior.windowMove.dxRange || [0, 0];
    const rng = typeof ctx.random === "function" ? ctx.random : Math.random;
    const mag = lo + (hi - lo) * rng();
    const dir = rng() < 0.5 ? -1 : 1;
    ctx.moveWindowBy(Math.round(mag) * dir);
  }

  ctx._idleLifeActive = true;
  const dur = Number.isFinite(behavior.durationMs) && behavior.durationMs > 0 ? behavior.durationMs : 3000;
  ctx._idleLifeReturnTimer = setTimer(() => {
    ctx._idleLifeReturnTimer = null;
    ctx._idleLifeActive = false;
    // Only restore if we're still idle and not mid-state-change.
    if (ctx.currentState === "idle") {
      const follow = ctx.svgIdleFollow;
      if (follow && typeof ctx.sendToRenderer === "function") {
        ctx.sendToRenderer("state-change", "idle", follow);
        if (typeof ctx.sendToHitWin === "function") {
          ctx.sendToHitWin("hit-state-sync", { currentSvg: follow });
        }
      }
      ctx.forceEyeResend = true;
    }
  }, dur);
  return behavior;
}

// Cancel an in-flight idle-life behavior and restore the idle-follow SVG.
// Called by tick.js when the mouse moves, the state changes, or idle exits.
function cancelIdleLife(ctx, options = {}) {
  if (!ctx) return;
  const clearTimer = typeof ctx.clearTimeout === "function" ? ctx.clearTimeout : clearTimeout;
  if (ctx._idleLifeReturnTimer) {
    clearTimer(ctx._idleLifeReturnTimer);
    ctx._idleLifeReturnTimer = null;
  }
  const wasActive = ctx._idleLifeActive;
  ctx._idleLifeActive = false;
  if (wasActive && options.restore !== false && ctx.currentState === "idle") {
    const follow = ctx.svgIdleFollow;
    if (follow && typeof ctx.sendToRenderer === "function") {
      ctx.sendToRenderer("state-change", "idle", follow);
      if (typeof ctx.sendToHitWin === "function") {
        ctx.sendToHitWin("hit-state-sync", { currentSvg: follow });
      }
    }
  }
}

module.exports = {
  createIdleLifeScheduler,
  normalizeBehaviors,
  computeWanderTarget,
  maybePlayIdleLife,
  cancelIdleLife,
  hourInRange,
};

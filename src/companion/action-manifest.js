"use strict";

// ── Action manifest ─────────────────────────────────────────────────────────
// Single source of truth shared by the Companion runtime (which plays actions)
// and the AI Studio (which generates their frames). Pure data + helpers; no
// Electron dependencies so it is trivially unit-testable and importable from
// both main and renderer.
//
// Each action declares:
//   id          unique slug, also the generated asset basename (<id>.svg)
//   category    "idle-life" | "context" | "touch"
//   frames      number of distinct key poses (2..9)
//   grid        { cols, rows } layout used for single-image grid-strip
//               generation (size consistency comes from one generation + a
//               layout guide; cols*rows must be >= frames)
//   posePrompts per-frame pose description (length === frames), read
//               left-to-right, top row then bottom row
//   anim        playback timing { totalMs, loop, hold?, windowMove?, overlayText? }
//   trigger     when/how the Companion plays it (category-specific shape)

const CATEGORIES = Object.freeze(["idle-life", "context", "touch"]);

// Default chroma-key background color for generation. The character is keyed
// out against this; never use this color (or near it) in the character. Studio
// may override per-pet if the reference contains green.
const CHROMA = "#00FF00";

// Generation scaffold — embeds the validated size-lock + chroma-key recipe
// (proven in _imggen-test: 4 yawn frames at ~2% size spread, clean alpha).
// Placeholders: {N} {COLS} {ROWS} {ACTION} {POSES} {CHROMA}.
const BASE_SCAFFOLD = [
  "Create ONE image containing exactly {N} animation frames of the SAME character in the FIRST {N} cells of a {COLS}x{ROWS} grid, for a {ACTION} animation. Read cells left-to-right, top-to-bottom. Leave every remaining grid cell completely empty with only the chroma background.",
  "INPUTS: the first attached image is the BASE CHARACTER — the authoritative design, identity, and SUBJECT SIZE reference. The second attached image is a LAYOUT GUIDE showing the cell boxes with inner safe areas; use it ONLY for cell count, spacing, centering, and padding. Do NOT copy any guide lines, boxes, or colors into the output.",
  "IDENTITY & SIZE LOCK: every frame must be the EXACT same character as the base — same colors, proportions, and art style. The character must occupy the SAME SIZE in all cells, matching the base image's subject scale. Do not zoom in or out between frames. Center one complete character in each cell with safe padding; no frame may crop, clip, or cross into a neighboring cell. Keep the character and every prop as one single connected silhouette: props must be held or touch the body. No detached particles, crumbs, sweat drops, stars, sparkles, clocks, confetti, motion marks, or floating effects.",
  "ANIMATION (read cells left-to-right, top row then bottom row):\n{POSES}",
  "BACKGROUND: a perfectly flat, uniform, pure {CHROMA} chroma-key background filling the WHOLE image. Do NOT use {CHROMA} or near-{CHROMA} anywhere on the character, its edges, or highlights. No shadows, glows, scenery, text, numbers, grid lines, borders, or checkerboard.",
].join("\n\n");

function action(id, category, frames, grid, posePrompts, anim, trigger) {
  return Object.freeze({
    id,
    category,
    frames,
    grid: Object.freeze({ ...grid }),
    posePrompts: Object.freeze([...posePrompts]),
    anim: Object.freeze({ ...anim }),
    trigger: trigger ? Object.freeze({ ...trigger }) : null,
  });
}

const ACTIONS = Object.freeze([
  // ── idle-life ──────────────────────────────────────────────────────────
  action("yawn", "idle-life", 4, { cols: 2, rows: 2 },
    [
      "calm, mouth closed in a small content smile, arms relaxed at sides",
      "starting to yawn, mouth a small open oval, eyes half-closed, arms beginning to lift",
      "full yawn, mouth wide open, eyes squeezed shut, both arms stretched up above the head",
      "settling, mouth closing, eyes relaxed, arms lowering toward sides",
    ],
    { totalMs: 3200, loop: "once", hold: { 2: 1.6 } },
    // idleMinMs values are seconds-scale on purpose: idle-life plays inside the
    // existing mouse-still idle window (≈20s..mouseSleepTimeout) BEFORE the pet
    // dozes off, so the sleep sequence is never touched. Staggered so deeper
    // idle unlocks more behaviors.
    { idleMinMs: 22000, weight: 0.30 }),

  action("snack", "idle-life", 4, { cols: 2, rows: 2 },
    [
      "holding a small cookie in both hands near the mouth, eyes open and curious",
      "biting the cookie, eyes closed happily, cheeks puffed",
      "chewing with a content closed-eye smile, both hands still touching the cookie",
      "patting its belly, satisfied, the cookie now gone",
    ],
    { totalMs: 4000, loop: "once" },
    { idleMinMs: 30000, weight: 0.20 }),

  action("wander", "idle-life", 4, { cols: 2, rows: 2 },
    [
      "walking contact pose, left foot forward and right arm forward, looking ahead",
      "walking passing pose, feet close together, body centered",
      "walking contact pose, right foot forward and left arm forward",
      "walking passing pose returning toward the first pose, feet close together",
    ],
    { totalMs: 2500, loop: "loop", windowMove: { dxRange: [50, 80] } },
    { idleMinMs: 38000, weight: 0.15 }),

  action("bored", "idle-life", 4, { cols: 2, rows: 2 },
    [
      "sitting, one hand propping up its chin, half-lidded bored eyes",
      "same bored pose, glancing the other way",
      "lazily kicking one foot out, still bored",
      "sighing, shoulders dropped",
    ],
    { totalMs: 5000, loop: "loop" },
    { idleMinMs: 46000, weight: 0.25 }),

  action("nap-hint", "idle-life", 4, { cols: 2, rows: 2 },
    [
      "standing, head drooping forward, eyes closing",
      "head fully drooped, asleep on its feet",
      "startled awake, eyes wide open, body upright",
      "rubbing one eye, sleepy",
    ],
    { totalMs: 4000, loop: "once" },
    { idleMinMs: 52000, weight: 0.20, hourRange: [23, 6] }),

  action("curious", "idle-life", 3, { cols: 2, rows: 2 },
    [
      "head tilted to the left, wide curious eyes, leaning slightly forward",
      "head upright, blinking, attentive",
      "head tilted to the right, wide curious eyes",
    ],
    { totalMs: 2000, loop: "loop" },
    { hover: true }), // hover-triggered, excluded from the random idle picker

  // ── context ───────────────────────────────────────────────────────────
  action("error-comfort", "context", 4, { cols: 2, rows: 2 },
    [
      "worried face, eyebrows angled up, hands clasped nervously",
      "reaching forward, offering a small white tissue",
      "holding out the tissue with a gentle encouraging half-smile",
      "a small supportive nod",
    ],
    { totalMs: 4000, loop: "once" },
    { type: "errorStreak", count: 3, windowMs: 600000, cooldownMs: 600000 }),

  action("smooth-thumbsup", "context", 3, { cols: 2, rows: 2 },
    [
      "proud stance, beginning to raise one hand",
      "enthusiastic thumbs up, happy crescent eyes, big smile",
      "thumbs up held, proud upright posture and warm smile",
    ],
    { totalMs: 3000, loop: "once" },
    { type: "smoothWork", workingMinMs: 1800000, maxErrors: 0, cooldownMs: 1800000 }),

  action("bye-wave", "context", 2, { cols: 2, rows: 1 },
    [
      "waving, raised hand tilted to the left, a bittersweet smile",
      "waving, raised hand tilted to the right",
    ],
    { totalMs: 2500, loop: "pingpong" },
    { type: "sessionEnd", cooldownMs: 0 }),

  action("good-morning", "context", 3, { cols: 2, rows: 2 },
    [
      "a big morning stretch, both arms up, mouth open in a yawn",
      "waving hello, bright wide-awake eyes, a big smile",
      "an energetic ready pose, both hands confidently at its sides",
    ],
    { totalMs: 3000, loop: "once" },
    { type: "firstSession", cooldownMs: 0 }),

  action("break-reminder", "context", 2, { cols: 2, rows: 1 },
    [
      "holding a small alarm clock against its chest with both hands, a caring concerned face",
      "pointing gently at the alarm clock while the other hand keeps it touching the body",
    ],
    { totalMs: 5000, loop: "pingpong" },
    { type: "breakReminder", continuousWorkMs: 3600000, cooldownMs: 3600000 }),

  action("celebration", "context", 3, { cols: 2, rows: 2 },
    [
      "crouching slightly, about to jump, excited",
      "jumping up, both arms raised, eyes shut with joy, feet off the ground",
      "landing happily, arms wide and feet planted",
    ],
    { totalMs: 3500, loop: "once" },
    { type: "tokenMilestone", stepTokens: 100000, cooldownMs: 0 }),

  // ── touch ─────────────────────────────────────────────────────────────
  action("dizzy", "touch", 3, { cols: 2, rows: 2 },
    [
      "dazed, spiral eyes, one hand on its head, tilted to the left",
      "wobbling upright with spiral eyes and both arms spread for balance",
      "dazed, tilted to the right, one hand on its head",
    ],
    { totalMs: 2500, loop: "once" },
    { reaction: "rapidClick", threshold: 6 }),

  action("shake-off", "touch", 2, { cols: 2, rows: 1 },
    [
      "ruffled and messy, eyes wide and startled, body mid-shake",
      "composed and neat again, a satisfied dignified nod",
    ],
    { totalMs: 2000, loop: "once" },
    { reaction: "dragRelease" }),
]);

const _byId = new Map(ACTIONS.map((a) => [a.id, a]));

function getAction(id) {
  return _byId.get(id) || null;
}

function listByCategory(category) {
  return ACTIONS.filter((a) => a.category === category);
}

function buildPrompt(action, chroma = CHROMA) {
  if (!action) throw new Error("buildPrompt requires an action");
  const poses = action.posePrompts
    .map((pose, i) => `${i + 1}. ${pose}`)
    .join("\n");
  return BASE_SCAFFOLD
    .replace(/\{N\}/g, String(action.frames))
    .replace(/\{COLS\}/g, String(action.grid.cols))
    .replace(/\{ROWS\}/g, String(action.grid.rows))
    .replace(/\{ACTION\}/g, action.id.replace(/-/g, " "))
    .replace(/\{POSES\}/g, poses)
    .replace(/\{CHROMA\}/g, chroma);
}

module.exports = {
  CATEGORIES,
  CHROMA,
  ACTIONS,
  getAction,
  listByCategory,
  buildPrompt,
};

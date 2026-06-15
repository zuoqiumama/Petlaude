"use strict";

// ── Action manifest ─────────────────────────────────────────────────────────
// Single source of truth shared by the Companion runtime (which plays actions)
// and the AI Studio (which generates their frames). Pure data + helpers; no
// Electron dependencies so it is trivially unit-testable and importable from
// both main and renderer.
//
// Each action declares:
//   id          unique slug, also the generated asset basename (<id>.svg)
//   category    "core" | "sleep" | "mini" | "idle-life" | "context" | "touch"
//   keyPosePrompts
//               concise authored key poses that define the action
//   frames      generated frame count (6..8); authored key poses are expanded
//               into explicit in-betweens so playback is not a 2-4 frame flipbook
//   grid        { cols, rows } layout used for single-image grid-strip
//               generation (size consistency comes from one generation + a
//               layout guide; cols*rows exactly equals frames)
//   posePrompts per-frame pose description (length === frames), read
//               left-to-right, top row then bottom row
//   anim        playback timing { totalMs, loop, hold?, windowMove?, overlayText? }
//   trigger     when/how the Companion plays it (category-specific shape)
//
// Categories:
//   core        the pet's base state animations. trigger.states lists the
//               theme `states.<key>` bindings the generated asset fills, so a
//               Studio pet animates in the same slots built-in pets do
//               (idle/working/thinking/sleeping/error/notification) instead of
//               showing a static reference image.
//   sleep       the full wind-down sequence (yawning → dozing → collapsing →
//               waking). trigger.states binds theme `states.<key>`; once all
//               four exist the Studio flips sleepSequence.mode to "full" so the
//               generated pet drifts off the way built-in pets do instead of
//               cutting straight to the static sleeping pose.
//   mini        the edge-snap "peek" behaviors a pet plays when it tucks half
//               off the screen border. trigger.miniState binds
//               `miniMode.states.<key>`; once the required set exists the Studio
//               flips miniMode.supported on so mini mode actually works.
//   idle-life / context / touch   companion extras layered on top.

const CATEGORIES = Object.freeze(["core", "sleep", "mini", "idle-life", "context", "touch"]);

// Default chroma-key background color for generation. The character is keyed
// out against this; never use this color (or near it) in the character. Studio
// may override per-pet if the reference contains green.
const CHROMA = "#00FF00";

// Generation scaffold — embeds the validated size-lock + chroma-key recipe;
// authored key poses are expanded above into 6-8 explicit output frames.
// Placeholders: {N} {COLS} {ROWS} {ACTION} {POSES} {CHROMA}.
const BASE_SCAFFOLD = [
  "DELIVERABLE: Create ONE production-ready sprite sheet image containing exactly {N} animation frames for the {ACTION} animation. Place them in the FIRST {N} cells of a {COLS}x{ROWS} grid, read left-to-right then top-to-bottom. Leave every remaining grid cell completely empty with only the chroma background.",
  "REFERENCE ROLES: Image 1 is the BASE CHARACTER and the authoritative character identity reference. Image 2 is a LAYOUT GUIDE ONLY. Use it only for grid arrangement, frame order, safe margins, and subject scale. Do not copy its character design, colors, guide lines, or boxes.",
  "IDENTITY LOCK: Preserve the exact species and character identity, face and eye shape, eye colors, distinctive markings and their placement, asymmetry, silhouette, head-to-body ratio, limb lengths and thickness, outfit, accessories, palette, line weight, texture, shading, and art medium from Image 1. Do not redesign, simplify, age, recolor, change costume, add or remove body features, or mirror asymmetrical details.",
  "SCALE AND CAMERA LOCK: SAME SIZE means the same anatomical body scale in every frame. Keep head diameter, torso width, and limb thickness consistent. Use a canonical neutral standing body height of about 72% of the safe cell height. Natural pose changes may change the outer silhouette or bounding box. Do not zoom, rescale, enlarge, or shrink the character to fill an individual cell. Use one fixed camera, perspective, coordinate system, ground line, and body anchor across the sheet. Change position only when a pose explicitly requires movement. Keep one complete character inside each safe area; do not crop, overlap cells, or cross a cell boundary.",
  "ANIMATION POSES (read cells left-to-right, top row then bottom row):\n{POSES}",
  "PROPS AND EFFECTS: Include only props explicitly named in the pose list. Keep the character and every named prop as one single connected silhouette; the prop must be held by or physically touch the character. No detached particles, crumbs, sweat drops, stars, sparkles, confetti, motion marks, floating symbols, or floating props.",
  "BACKGROUND: Use a perfectly flat, uniform, opaque, pure {CHROMA} chroma-key background across the whole image. Do not use {CHROMA} or near-{CHROMA} anywhere on the character, its edges, or highlights. No shadows, glows, scenery, text, numbers, labels, grid lines, borders, checkerboard, haze, or transparency. Use crisp clean edges and an opaque character.",
].join("\n\n");

const RETRY_CORRECTION = [
  "RETRY CORRECTION: A previous attempt failed automatic quality validation.",
  "Keep the same body anchor and ground line in every stationary frame; only the limbs, face, and explicitly described pose may change.",
  "Use only the flat chroma background. No guide lines, boxes, crosshairs, borders, panels, labels, or background gradients may appear in the delivered sprite sheet.",
].join(" ");

function generatedFrameCount(keyPoseCount) {
  return keyPoseCount >= 4 ? 8 : 6;
}

function gridForFrames(frames) {
  return Object.freeze({ cols: frames / 2, rows: 2 });
}

function inBetweenPrompt(from, to, amount) {
  const pct = Math.round(amount * 100);
  return `smooth in-between pose ${pct}% from this pose: ${from}; toward this pose: ${to}; keep identity, body scale, camera, ground line, and body anchor unchanged`;
}

function expandPosePrompts(keyPosePrompts, frameCount, loop) {
  const keys = Array.isArray(keyPosePrompts) ? keyPosePrompts : [];
  if (keys.length < 2) throw new Error("expandPosePrompts requires at least two key poses");
  if (!Number.isInteger(frameCount) || frameCount < keys.length) {
    throw new Error("expandPosePrompts requires a valid output frame count");
  }

  const cyclic = loop === "loop";
  const segmentCount = cyclic ? keys.length : keys.length - 1;
  const extraFrames = frameCount - keys.length;
  const baseExtras = Math.floor(extraFrames / segmentCount);
  const remainder = extraFrames % segmentCount;
  const prompts = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const fromIndex = segment;
    const toIndex = cyclic ? (segment + 1) % keys.length : segment + 1;
    const tweenCount = baseExtras + (segment < remainder ? 1 : 0);
    prompts.push(keys[fromIndex]);
    for (let tween = 1; tween <= tweenCount; tween += 1) {
      prompts.push(inBetweenPrompt(keys[fromIndex], keys[toIndex], tween / (tweenCount + 1)));
    }
  }
  if (!cyclic) prompts.push(keys[keys.length - 1]);
  return prompts;
}

function expandAnim(anim, keyPosePrompts, posePrompts) {
  const next = { ...anim };
  if (anim.hold && typeof anim.hold === "object") {
    const hold = {};
    for (const [keyIndexText, weight] of Object.entries(anim.hold)) {
      const keyIndex = Number(keyIndexText);
      if (!Number.isInteger(keyIndex) || !keyPosePrompts[keyIndex]) continue;
      const generatedIndex = posePrompts.indexOf(keyPosePrompts[keyIndex]);
      if (generatedIndex >= 0) hold[generatedIndex] = weight;
    }
    next.hold = Object.freeze(hold);
  }
  return Object.freeze(next);
}

function anchorPolicyFor(id) {
  return Object.freeze({
    lockX: id !== "mini-enter" && id !== "mini-enter-sleep",
    lockY: id !== "celebration",
  });
}

function action(id, category, authoredFrames, _authoredGrid, keyPosePrompts, anim, trigger) {
  if (authoredFrames !== keyPosePrompts.length) {
    throw new Error(`authored frame count does not match key poses for ${id}`);
  }
  const frames = generatedFrameCount(keyPosePrompts.length);
  const posePrompts = expandPosePrompts(keyPosePrompts, frames, anim.loop);
  return Object.freeze({
    id,
    category,
    frames,
    grid: gridForFrames(frames),
    keyPosePrompts: Object.freeze([...keyPosePrompts]),
    posePrompts: Object.freeze(posePrompts),
    anchor: anchorPolicyFor(id),
    anim: expandAnim(anim, keyPosePrompts, posePrompts),
    trigger: trigger ? Object.freeze({ ...trigger }) : null,
  });
}

const ACTIONS = Object.freeze([
  // ── core ──────────────────────────────────────────────────────────────
  // Generated first by generateAll so a partial run still yields a pet that
  // animates in its everyday states. All loop forever; the runtime keeps the
  // SVG on screen for as long as the state lasts.
  action("idle", "core", 4, { cols: 2, rows: 2 },
    [
      "standing relaxed, arms at sides, eyes open, gentle neutral smile",
      "breathing in, body and shoulders rising slightly taller, chest a little fuller",
      "blinking, eyes closed, body still at the relaxed standing height",
      "breathing out, body settling slightly lower, content expression",
    ],
    { totalMs: 3200, loop: "loop" },
    { states: ["idle"] }),

  action("working", "core", 4, { cols: 2, rows: 2 },
    [
      "sitting with a small laptop resting on its lap, both hands touching the keyboard, looking at the screen",
      "typing, left hand lifted just above the keyboard, right hand pressing the keys, focused eyes",
      "typing, right hand lifted just above the keyboard, left hand pressing the keys, leaning slightly toward the screen",
      "both hands pressing the keyboard at once, concentrated expression with determined eyes",
    ],
    { totalMs: 2400, loop: "loop" },
    // One busy-loop covers the whole working family until dedicated
    // juggling/sweeping/carrying actions exist.
    { states: ["working", "juggling", "sweeping", "carrying"] }),

  action("thinking", "core", 4, { cols: 2, rows: 2 },
    [
      "standing, one hand touching its chin, eyes looking up thoughtfully",
      "head tilted slightly to the left, hand still touching the chin, eyes narrowed in thought",
      "eyes closed, hand resting on the chin, deep in concentration",
      "eyes open wide with a sudden inspired expression, hand lowering slightly from the chin",
    ],
    { totalMs: 3600, loop: "loop" },
    { states: ["thinking"] }),

  action("sleeping", "core", 4, { cols: 2, rows: 2 },
    [
      "curled up on the ground, eyes closed, sleeping peacefully",
      "still curled up asleep, body rising slightly with a slow inhale",
      "curled up asleep, body at its roundest with the breath held",
      "curled up asleep, body sinking back down with a slow exhale",
    ],
    { totalMs: 4800, loop: "loop" },
    { states: ["sleeping"] }),

  action("error", "core", 3, { cols: 2, rows: 2 },
    [
      "startled, eyes wide open, both hands raised touching its cheeks",
      "drooping, eyebrows angled up sadly, hands sliding down its cheeks",
      "slumped shoulders, looking down with an apologetic frown, hands at its sides",
    ],
    { totalMs: 2800, loop: "loop" },
    { states: ["error"] }),

  action("notification", "core", 3, { cols: 2, rows: 2 },
    [
      "standing upright and alert, eyes wide, one arm raised straight up",
      "waving the raised arm toward the left, mouth open as if calling out",
      "waving the raised arm toward the right, eager hopeful expression",
    ],
    { totalMs: 2000, loop: "loop" },
    { states: ["notification", "attention"] }),

  // ── sleep ────────────────────────────────────────────────────────────────
  // The full wind-down sequence. The runtime advances these on timers
  // (yawnDuration → deepSleepTimeout → wakeDuration), so each loops gently
  // while it is held. trigger.states binds the theme `states.<key>` slot; the
  // Studio flips sleepSequence.mode to "full" once all four exist.
  action("yawning", "sleep", 4, { cols: 2, rows: 2 },
    [
      "standing relaxed but visibly tired, eyes half-closed, one hand beginning to rise toward the mouth",
      "mid-yawn, mouth opening into a wide oval, eyes squeezed shut, the raised hand near the open mouth",
      "the yawn at its peak, mouth wide open, head tipped back a little, both shoulders lifted",
      "the yawn fading, mouth closing, eyes droopy and sleepy, hand lowering back to the side",
    ],
    { totalMs: 3000, loop: "loop" },
    { states: ["yawning"] }),

  action("dozing", "sleep", 4, { cols: 2, rows: 2 },
    [
      "sitting down, eyes closed, head still upright, nodding off with a calm face",
      "head drooping slowly forward, body leaning, almost asleep",
      "head bobbing back up with a tiny startle, eyes briefly half-open",
      "head drooping forward again, settling deeper toward sleep",
    ],
    { totalMs: 4000, loop: "loop" },
    { states: ["dozing"] }),

  action("collapsing", "sleep", 4, { cols: 2, rows: 2 },
    [
      "kneeling down, eyes closed, sinking toward the ground, fully sleepy",
      "lowering further, body curling inward, one hand touching the ground for balance",
      "lying down on its side, knees tucked up, giving in to sleep",
      "settled curled up on the ground, eyes closed, completely at rest",
    ],
    { totalMs: 2400, loop: "loop" },
    { states: ["collapsing"] }),

  action("waking", "sleep", 3, { cols: 2, rows: 2 },
    [
      "curled up on the ground, just beginning to stir, one eye cracking open",
      "sitting up partway, stretching both arms out wide, mouth open in a small wake-up yawn",
      "upright and awake, eyes open and bright, a refreshed ready posture",
    ],
    { totalMs: 1500, loop: "loop" },
    { states: ["waking"] }),

  // ── mini ───────────────────────────────────────────────────────────────
  // Edge-snap "peek" poses for when the pet tucks half off the screen border.
  // All are drawn as ONE complete character shown side-on and leaning toward
  // the LEFT (the on-screen side when snapped to the right edge); the runtime
  // clips the off-screen half and mirrors the asset for the left edge via
  // miniMode.flipAssets. trigger.miniState binds `miniMode.states.<key>`.
  action("mini-idle", "mini", 3, { cols: 2, rows: 2 },
    [
      "shown in left side-profile, leaning out to the left to peek, calm watchful eyes looking left",
      "the same side-on peeking pose, breathing in, leaning a touch further to the left",
      "the same peeking pose, settling back slightly, relaxed and content, still looking left",
    ],
    { totalMs: 3200, loop: "loop" },
    { miniState: "mini-idle" }),

  action("mini-enter", "mini", 3, { cols: 3, rows: 1 },
    [
      "shown in left side-profile in the same natural standing posture as Image 1, belly held clear of the ground; the entire unchanged character is positioned toward the right side of the cell, beginning a quick horizontal slide in from the screen edge",
      "the exact same standing side-profile pose shifted horizontally to the left as a small slide-in overshoot; all feet remain below the torso on the same ground line and the body proportions stay unchanged",
      "the exact same standing side-profile pose shifted slightly right into the final tucked position near the screen edge, settled and ready to peek; move the entire unchanged character only by horizontal translation; do not crouch, crawl, lie belly-down, hop, jump, flatten, elongate, or stretch the body",
    ],
    { totalMs: 1600, loop: "once" },
    { miniState: "mini-enter" }),

  action("mini-enter-sleep", "mini", 2, { cols: 2, rows: 1 },
    [
      "shown in left side-profile, tucked compactly to the side, head beginning to droop, eyes closing, settling in to rest",
      "curled small and still on its side facing left, eyes shut, almost asleep",
    ],
    { totalMs: 1600, loop: "loop" },
    { miniState: "mini-enter-sleep" }),

  action("mini-crabwalk", "mini", 4, { cols: 2, rows: 2 },
    [
      "shown side-on facing left, side-stepping with both feet together, weight centered",
      "side-stepping, the leading foot reaching out to the left, body tilting that way",
      "side-stepping, the trailing foot catching up, feet together again",
      "side-stepping, leaning left again mid-step, a brisk sideways scuttle",
    ],
    { totalMs: 1200, loop: "loop" },
    { miniState: "mini-crabwalk" }),

  action("mini-peek", "mini", 3, { cols: 2, rows: 2 },
    [
      "leaning only slightly to the left, just starting to peek out, curious eyes",
      "leaning further out to the left, peeking wide with bright interested eyes",
      "leaning back in a little, still peeking left, an inquisitive expression",
    ],
    { totalMs: 1500, loop: "loop" },
    { miniState: "mini-peek" }),

  action("mini-working", "mini", 3, { cols: 2, rows: 2 },
    [
      "tucked side-on facing left, a small laptop held against its body, both hands on the keys",
      "typing, the left hand lifted just above the keys, focused eyes on the screen, still leaning left",
      "typing, the right hand lifted just above the keys, leaning a touch toward the screen",
    ],
    { totalMs: 2400, loop: "loop" },
    { miniState: "mini-working" }),

  action("mini-alert", "mini", 3, { cols: 2, rows: 2 },
    [
      "side-on facing left, suddenly startled, eyes wide, body leaning back a little",
      "alert and upright, both eyes wide open, one hand raised by the face in surprise",
      "still alert, leaning in to look left intently, eyebrows raised",
    ],
    { totalMs: 1200, loop: "loop" },
    { miniState: "mini-alert" }),

  action("mini-happy", "mini", 3, { cols: 2, rows: 2 },
    [
      "side-on facing left, a happy crescent-eyed smile, leaning out cheerfully",
      "bouncing up a little with joy, one hand raised in a small wave to the left",
      "settling back with a warm content smile, still looking left",
    ],
    { totalMs: 1600, loop: "loop" },
    { miniState: "mini-happy" }),

  action("mini-sleep", "mini", 2, { cols: 2, rows: 1 },
    [
      "curled up small on its side facing left, eyes closed, breathing in slowly",
      "still curled up asleep, body sinking a little lower with a slow exhale",
    ],
    { totalMs: 4000, loop: "loop" },
    { miniState: "mini-sleep" }),

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
      "the same character mid-shake, with fur, ears, or clothing temporarily displaced by motion while preserving the exact colors, distinctive markings, outfit, and body proportions; eyes wide and startled",
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

function buildPrompt(action, chroma = CHROMA, options = {}) {
  if (!action) throw new Error("buildPrompt requires an action");
  const poses = action.posePrompts
    .map((pose, i) => `${i + 1}. ${pose}`)
    .join("\n");
  const prompt = BASE_SCAFFOLD
    .replace(/\{N\}/g, String(action.frames))
    .replace(/\{COLS\}/g, String(action.grid.cols))
    .replace(/\{ROWS\}/g, String(action.grid.rows))
    .replace(/\{ACTION\}/g, action.id.replace(/-/g, " "))
    .replace(/\{POSES\}/g, poses)
    .replace(/\{CHROMA\}/g, chroma);
  return Number(options.attempt) > 1 ? `${prompt}\n\n${RETRY_CORRECTION}` : prompt;
}

module.exports = {
  CATEGORIES,
  CHROMA,
  ACTIONS,
  getAction,
  listByCategory,
  buildPrompt,
  expandPosePrompts,
};

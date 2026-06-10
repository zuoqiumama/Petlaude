"use strict";

// ── Touch reaction tier resolution ───────────────────────────────────────────
// Pure helpers shared by hit-renderer.js (renderer, via the ClawdClickTiers
// global) and the test suite (via module.exports). UMD-style so the same file
// works in both the CommonJS and plain-<script> worlds, mirroring
// shortcut-actions.js.
//
// Tiers (highest first):
//   >= 6 clicks → rapidClick (e.g. dizzy)        [new]
//   >= 4 clicks → double / flail                 [existing]
//   >= 2 clicks → annoyed (50%) or clickLeft/Right by first-click side [existing]

(function initClickTiers(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ClawdClickTiers = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function factory() {
  function pickFile(entry, rng) {
    const files = entry.files && Array.isArray(entry.files) && entry.files.length
      ? entry.files
      : (entry.file ? [entry.file] : []);
    if (!files.length) return null;
    const r = typeof rng === "function" ? rng() : Math.random();
    return files[Math.floor(r * files.length)];
  }

  function resolveClickReaction(count, reactions, rng, dir) {
    const random = typeof rng === "function" ? rng : Math.random;
    const side = dir || "left";
    if (!reactions || count < 2) return null;

    if (count >= 6 && reactions.rapidClick && (reactions.rapidClick.file || reactions.rapidClick.files)) {
      return { file: pickFile(reactions.rapidClick, random), duration: reactions.rapidClick.duration || 2500 };
    }
    if (count >= 4 && reactions.double && (reactions.double.file || reactions.double.files)) {
      return { file: pickFile(reactions.double, random), duration: reactions.double.duration || 3500 };
    }
    if (count >= 2) {
      if (reactions.annoyed && reactions.annoyed.file && random() < 0.5) {
        return { file: reactions.annoyed.file, duration: reactions.annoyed.duration || 3500 };
      }
      const r = side === "left" ? reactions.clickLeft : reactions.clickRight;
      if (r && r.file) return { file: r.file, duration: r.duration || 2500 };
    }
    return null;
  }

  function resolveDragEndReaction(reactions) {
    const entry = reactions && reactions.dragRelease;
    if (!entry || !entry.file) return null;
    return { file: entry.file, duration: entry.duration || 2000 };
  }

  return { resolveClickReaction, resolveDragEndReaction };
});

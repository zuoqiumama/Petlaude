"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  validateTheme,
  mergeDefaults,
  buildCapabilities,
  collectRequiredAssetFiles,
} = require("../src/theme-schema");

// Minimal valid base theme (sleepSequence "direct" avoids full-sleep state reqs).
function baseTheme() {
  return {
    schemaVersion: 1,
    name: "t",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 10, height: 10 },
    sleepSequence: { mode: "direct" },
    states: {
      idle: ["i.svg"],
      working: ["w.svg"],
      thinking: ["t.svg"],
      sleeping: ["s.svg"],
    },
  };
}

function companionFields() {
  return {
    idleLife: {
      enabled: true,
      cooldownMs: 30000,
      behaviors: [
        { id: "yawn", file: "yawn.svg", duration: 3200, trigger: { idleMinMs: 120000, weight: 0.3 } },
      ],
    },
    contextReactions: {
      errorStreak: { file: "err.svg", duration: 4000, threshold: { count: 3, windowMs: 600000 } },
    },
    touchReactions: {
      rapidClick: { file: "dizzy.svg", duration: 2500, threshold: 6 },
    },
  };
}

describe("theme schema — companion fields are optional & valid", () => {
  it("base theme without companion fields validates with no errors", () => {
    assert.deepStrictEqual(validateTheme(baseTheme()), []);
  });

  it("theme WITH companion fields validates with no errors", () => {
    const cfg = { ...baseTheme(), ...companionFields() };
    assert.deepStrictEqual(validateTheme(cfg), []);
  });

  it("rejects malformed idleLife.behaviors (not an array)", () => {
    const cfg = { ...baseTheme(), idleLife: { behaviors: "nope" } };
    assert.ok(validateTheme(cfg).some((e) => /idleLife/.test(e)), "expected idleLife error");
  });

  it("rejects a contextReactions entry missing a file", () => {
    const cfg = { ...baseTheme(), contextReactions: { errorStreak: { duration: 4000 } } };
    assert.ok(validateTheme(cfg).some((e) => /contextReactions/.test(e)), "expected contextReactions error");
  });
});

describe("theme schema — capabilities", () => {
  it("reports companion capabilities true when present", () => {
    const caps = buildCapabilities({ ...baseTheme(), ...companionFields() });
    assert.strictEqual(caps.idleLife, true);
    assert.strictEqual(caps.contextReactions, true);
    assert.strictEqual(caps.touchReactions, true);
  });

  it("reports companion capabilities false when absent", () => {
    const caps = buildCapabilities(baseTheme());
    assert.strictEqual(caps.idleLife, false);
    assert.strictEqual(caps.contextReactions, false);
    assert.strictEqual(caps.touchReactions, false);
  });
});

describe("theme schema — asset collection & normalization", () => {
  it("collectRequiredAssetFiles includes companion asset files", () => {
    const theme = mergeDefaults({ ...baseTheme(), ...companionFields() });
    const files = collectRequiredAssetFiles(theme);
    assert.ok(files.includes("yawn.svg"), "idleLife file");
    assert.ok(files.includes("err.svg"), "contextReactions file");
    assert.ok(files.includes("dizzy.svg"), "touchReactions file");
  });

  it("mergeDefaults basenames companion file paths (no traversal)", () => {
    const cfg = { ...baseTheme(), ...companionFields() };
    cfg.idleLife.behaviors[0].file = "../../evil/yawn.svg";
    cfg.contextReactions.errorStreak.file = "../err.svg";
    cfg.touchReactions.rapidClick.file = "sub/dizzy.svg";
    const theme = mergeDefaults(cfg);
    assert.strictEqual(theme.idleLife.behaviors[0].file, "yawn.svg");
    assert.strictEqual(theme.contextReactions.errorStreak.file, "err.svg");
    assert.strictEqual(theme.touchReactions.rapidClick.file, "dizzy.svg");
  });
});

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { slugify, ensurePetTheme } = require("../src/studio/pet-theme");
const themeLoader = require("../src/theme-loader");

const TEMPLATE_DIR = path.join(__dirname, "..", "themes", "template");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-studio-test-"));
}

function tmpReference() {
  const p = path.join(tmpDir(), "ref.png");
  // 1x1 transparent PNG
  fs.writeFileSync(p, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ));
  return p;
}

describe("slugify", () => {
  it("normalizes to a filesystem-safe slug", () => {
    assert.strictEqual(slugify("My Cool Pet!"), "my-cool-pet");
    assert.strictEqual(slugify("  Foo__Bar  "), "foo-bar");
  });

  it("keeps non-Latin pet names stable and distinct", () => {
    assert.match(slugify("小白"), /^pet-[a-z0-9]+$/);
    assert.notStrictEqual(slugify("小白"), slugify("小黑"));
  });
});

describe("ensurePetTheme", () => {
  it("clones the template, patches metadata, copies the reference as idle", () => {
    const userDataDir = tmpDir();
    const userThemesDir = path.join(userDataDir, "themes");
    const referencePath = tmpReference();
    const { themeDir, themeId } = ensurePetTheme({
      name: "Pixel Buddy",
      referencePath,
      userThemesDir,
      templateDir: TEMPLATE_DIR,
    });
    assert.strictEqual(themeId, "pixel-buddy");
    assert.ok(fs.existsSync(path.join(themeDir, "theme.json")));
    const theme = JSON.parse(fs.readFileSync(path.join(themeDir, "theme.json"), "utf8"));
    assert.strictEqual(theme.name, "Pixel Buddy");
    assert.strictEqual(theme.version, "1.0.0");
    assert.deepStrictEqual(theme.viewBox, { x: 0, y: 0, width: 512, height: 512 });
    // reference copied into assets and wired as idle
    assert.ok(fs.existsSync(path.join(themeDir, "assets", "reference.png")));
    assert.deepStrictEqual(theme.states.idle, ["reference.png"]);
    assert.deepStrictEqual(theme.states.working, ["reference.png"]);
    assert.deepStrictEqual(theme.states.thinking, ["reference.png"]);
    assert.strictEqual(theme.eyeTracking.enabled, false);
    assert.ok(!theme.workingTiers, "template-only tiers removed");
    assert.ok(!theme.reactions, "template-only reactions removed");

    themeLoader.init(path.join(__dirname, "..", "src"), userDataDir);
    const validation = themeLoader.validateThemeShape(themeId);
    assert.deepStrictEqual(validation.errors, []);
    assert.strictEqual(validation.ok, true);
  });

  it("preserves a supported reference extension instead of relabeling bytes as PNG", () => {
    const userThemesDir = tmpDir();
    const referencePath = path.join(tmpDir(), "ref.webp");
    fs.writeFileSync(referencePath, Buffer.from("webp-bytes"));
    const { themeDir } = ensurePetTheme({
      name: "Web Pet", referencePath, userThemesDir, templateDir: TEMPLATE_DIR,
    });
    const theme = JSON.parse(fs.readFileSync(path.join(themeDir, "theme.json"), "utf8"));
    assert.deepStrictEqual(theme.states.idle, ["reference.webp"]);
    assert.ok(fs.existsSync(path.join(themeDir, "assets", "reference.webp")));
  });

  it("avoids built-in theme ids", () => {
    const result = ensurePetTheme({
      name: "Clawd", referencePath: tmpReference(), userThemesDir: tmpDir(), templateDir: TEMPLATE_DIR,
    });
    assert.strictEqual(result.themeId, "clawd-custom");
  });

  it("does not overwrite an unrelated user theme with the same slug", () => {
    const userThemesDir = tmpDir();
    const existingDir = path.join(userThemesDir, "my-pet");
    fs.mkdirSync(path.join(existingDir, "assets"), { recursive: true });
    const original = { schemaVersion: 1, name: "Existing Theme", author: "Someone Else" };
    fs.writeFileSync(path.join(existingDir, "theme.json"), JSON.stringify(original));

    const result = ensurePetTheme({
      name: "My Pet", referencePath: tmpReference(), userThemesDir, templateDir: TEMPLATE_DIR,
    });

    assert.strictEqual(result.themeId, "my-pet-studio");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(existingDir, "theme.json"), "utf8")), original);
  });

  it("is idempotent (second call returns the same dir without error)", () => {
    const userThemesDir = tmpDir();
    const referencePath = tmpReference();
    const a = ensurePetTheme({ name: "Dup", referencePath, userThemesDir, templateDir: TEMPLATE_DIR });
    const b = ensurePetTheme({ name: "Dup", referencePath, userThemesDir, templateDir: TEMPLATE_DIR });
    assert.strictEqual(a.themeDir, b.themeDir);
  });

  it("preserves generated core-state animations across re-entry, resetting only placeholders", () => {
    const userThemesDir = tmpDir();
    const referencePath = tmpReference();
    const first = ensurePetTheme({ name: "Core Pet", referencePath, userThemesDir, templateDir: TEMPLATE_DIR });
    const themePath = path.join(first.themeDir, "theme.json");
    const theme = JSON.parse(fs.readFileSync(themePath, "utf8"));
    theme.states.idle = ["idle.svg"];
    theme.states.sleeping = ["sleeping.svg"];
    theme.states.juggling = ["working.svg"]; // a key the scaffold doesn't define
    fs.writeFileSync(themePath, JSON.stringify(theme));

    ensurePetTheme({ name: "Core Pet", referencePath, userThemesDir, templateDir: TEMPLATE_DIR });
    const repaired = JSON.parse(fs.readFileSync(themePath, "utf8"));
    assert.deepStrictEqual(repaired.states.idle, ["idle.svg"]);
    assert.deepStrictEqual(repaired.states.sleeping, ["sleeping.svg"]);
    assert.deepStrictEqual(repaired.states.juggling, ["working.svg"]);
    // Never-generated states reset to the fresh reference placeholder.
    assert.deepStrictEqual(repaired.states.working, ["reference.png"]);
    assert.deepStrictEqual(repaired.states.thinking, ["reference.png"]);
  });

  it("drops old template reaction placeholders while preserving generated touch reactions", () => {
    const userThemesDir = tmpDir();
    const referencePath = tmpReference();
    const first = ensurePetTheme({ name: "Repair", referencePath, userThemesDir, templateDir: TEMPLATE_DIR });
    const themePath = path.join(first.themeDir, "theme.json");
    const theme = JSON.parse(fs.readFileSync(themePath, "utf8"));
    theme.reactions = {
      drag: { file: "missing-template.gif" },
      rapidClick: { file: "dizzy.svg", duration: 2500 },
    };
    fs.writeFileSync(themePath, JSON.stringify(theme));

    ensurePetTheme({ name: "Repair", referencePath, userThemesDir, templateDir: TEMPLATE_DIR });
    const repaired = JSON.parse(fs.readFileSync(themePath, "utf8"));
    assert.deepStrictEqual(repaired.reactions, {
      rapidClick: { file: "dizzy.svg", duration: 2500 },
    });
  });
});

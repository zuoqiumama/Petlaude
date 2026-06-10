"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { slugify, ensurePetTheme } = require("../src/studio/pet-theme");

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
});

describe("ensurePetTheme", () => {
  it("clones the template, patches metadata, copies the reference as idle", () => {
    const userThemesDir = tmpDir();
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
  });

  it("is idempotent (second call returns the same dir without error)", () => {
    const userThemesDir = tmpDir();
    const referencePath = tmpReference();
    const a = ensurePetTheme({ name: "Dup", referencePath, userThemesDir, templateDir: TEMPLATE_DIR });
    const b = ensurePetTheme({ name: "Dup", referencePath, userThemesDir, templateDir: TEMPLATE_DIR });
    assert.strictEqual(a.themeDir, b.themeDir);
  });
});

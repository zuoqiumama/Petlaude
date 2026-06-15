"use strict";

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ACTIONS } = require("../src/companion/action-manifest");
const {
  STUDIO_QUALITY_VERSION,
  actionQualityFileName,
  actionFrameFileNames,
} = require("../src/studio/generation-contract");

const {
  getThemeMetadata,
  listThemesWithMetadata,
  buildPreviewUrl,
  buildVariantMetadata,
  computePreviewContentRatio,
  computePreviewContentOffsetPct,
} = require("../src/theme-metadata");

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeTempRoot() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-theme-metadata-"));
  tempDirs.push(tmp);
  const builtinThemesDir = path.join(tmp, "themes");
  const userThemesDir = path.join(tmp, "userThemes");
  const assetsSvgDir = path.join(tmp, "assets", "svg");
  fs.mkdirSync(builtinThemesDir, { recursive: true });
  fs.mkdirSync(userThemesDir, { recursive: true });
  fs.mkdirSync(assetsSvgDir, { recursive: true });
  return { tmp, builtinThemesDir, userThemesDir, assetsSvgDir };
}

function validThemeJson(overrides = {}) {
  return {
    schemaVersion: 1,
    name: "Test",
    version: "1.0.0",
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
    states: {
      idle: ["idle.svg"],
      yawning: ["yawning.svg"],
      dozing: ["dozing.svg"],
      collapsing: ["collapsing.svg"],
      thinking: ["thinking.svg"],
      working: ["working.svg"],
      sleeping: ["sleeping.svg"],
      waking: ["waking.svg"],
    },
    ...overrides,
  };
}

function writeTheme(baseDir, id, json, assets = {}) {
  const themeDir = path.join(baseDir, id);
  fs.mkdirSync(path.join(themeDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(themeDir, "theme.json"), JSON.stringify(json), "utf8");
  for (const [filename, content] of Object.entries(assets)) {
    const absPath = path.join(themeDir, "assets", filename);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf8");
  }
  return themeDir;
}

function addStudioActionAssets(assets, action) {
  if (!assets["reference.png"]) assets["reference.png"] = "canonical-reference";
  assets[`${action.id}.svg`] = "<svg/>";
  for (const filename of actionFrameFileNames(action)) assets[filename] = "png";
  assets[actionQualityFileName(action.id)] = JSON.stringify({
    qualityVersion: STUDIO_QUALITY_VERSION,
    actionId: action.id,
    frames: action.frames,
    referenceSha256: crypto.createHash("sha256").update(assets["reference.png"]).digest("hex"),
  });
}

describe("theme metadata preview helpers", () => {
  it("uses basename-only preview fallback and built-in central assets", () => {
    const { builtinThemesDir, assetsSvgDir } = makeTempRoot();
    const themeDir = writeTheme(
      builtinThemesDir,
      "builtin",
      validThemeJson({ name: "Builtin", preview: "../central-preview.svg" })
    );
    fs.writeFileSync(path.join(assetsSvgDir, "central-preview.svg"), "<svg/>", "utf8");

    const url = buildPreviewUrl(validThemeJson({ preview: "../central-preview.svg" }), themeDir, true, {
      assetsSvgDir,
    });

    assert.ok(url && url.includes("central-preview.svg"));
    assert.ok(!url.includes(".."));
  });

  it("falls back from preview to states.idle[0] for theme-local assets", () => {
    const { userThemesDir } = makeTempRoot();
    const raw = validThemeJson({ preview: null, states: { ...validThemeJson().states, idle: ["fallback.svg"] } });
    const themeDir = writeTheme(userThemesDir, "user", raw, { "fallback.svg": "<svg/>" });

    const url = buildPreviewUrl(raw, themeDir, false);

    assert.ok(url && url.includes("fallback.svg"));
  });

  it("computes preview content ratio and offset from layout.contentBox", () => {
    const raw = validThemeJson({
      viewBox: { x: 0, y: 0, width: 100, height: 200 },
      layout: { contentBox: { x: 10, y: 120, width: 50, height: 40 } },
    });

    assert.strictEqual(computePreviewContentRatio(raw), 0.5);
    assert.deepStrictEqual(computePreviewContentOffsetPct(raw), { x: 15, y: -20 });
    assert.strictEqual(computePreviewContentRatio(validThemeJson()), null);
  });
});

describe("theme metadata variants", () => {
  it("synthesizes default metadata and resolves variant preview fallback order", () => {
    const { userThemesDir } = makeTempRoot();
    const raw = validThemeJson({
      preview: "root.svg",
      variants: {
        cozy: {
          name: { en: "Cozy", zh: "舒适" },
          description: { en: "Softer" },
          preview: "cozy.svg",
        },
        night: {
          idleAnimations: [{ file: "night.svg" }],
        },
        plain: {},
      },
    });
    const themeDir = writeTheme(userThemesDir, "varianted", raw, {
      "root.svg": "<svg/>",
      "cozy.svg": "<svg/>",
      "night.svg": "<svg/>",
    });

    const variants = buildVariantMetadata(raw, themeDir, false);

    assert.deepStrictEqual(variants[0].name, { en: "Standard", zh: "标准", "zh-TW": "標準" });
    assert.ok(variants.find((v) => v.id === "cozy").previewFileUrl.includes("cozy.svg"));
    assert.deepStrictEqual(variants.find((v) => v.id === "cozy").name, { en: "Cozy", zh: "舒适" });
    assert.deepStrictEqual(variants.find((v) => v.id === "cozy").description, { en: "Softer" });
    assert.ok(variants.find((v) => v.id === "night").previewFileUrl.includes("night.svg"));
    assert.ok(variants.find((v) => v.id === "plain").previewFileUrl.includes("root.svg"));
  });

  it("does not synthesize default metadata when an explicit default variant exists", () => {
    const { userThemesDir } = makeTempRoot();
    const raw = validThemeJson({
      variants: {
        default: { name: "Default Variant" },
      },
    });
    const themeDir = writeTheme(userThemesDir, "explicit-default", raw);

    const variants = buildVariantMetadata(raw, themeDir, false);

    assert.deepStrictEqual(variants.map((v) => v.id), ["default"]);
    assert.strictEqual(variants[0].name, "Default Variant");
  });
});

describe("theme metadata facade helpers", () => {
  it("returns null for missing themes through the injected readThemeJson callback", () => {
    const meta = getThemeMetadata("missing", {
      readThemeJson: () => ({ raw: null, isBuiltin: false, themeDir: null }),
    });

    assert.strictEqual(meta, null);
  });

  it("builds metadata without activating a theme", () => {
    const { userThemesDir } = makeTempRoot();
    const raw = validThemeJson({
      name: "Meta Theme",
      preview: "preview.svg",
      layout: { contentBox: { x: 0, y: 10, width: 50, height: 50 } },
    });
    const themeDir = writeTheme(userThemesDir, "meta-theme", raw, { "preview.svg": "<svg/>" });

    const meta = getThemeMetadata("meta-theme", {
      readThemeJson: () => ({ raw, isBuiltin: false, themeDir }),
    });

    assert.strictEqual(meta.id, "meta-theme");
    assert.strictEqual(meta.name, "Meta Theme");
    assert.strictEqual(meta.builtin, false);
    assert.ok(meta.previewFileUrl.includes("preview.svg"));
    assert.strictEqual(meta.previewContentRatio, 0.5);
    assert.ok(meta.capabilities);
  });

  it("does not count a legacy bound SVG without the current quality marker and frame set", () => {
    const { userThemesDir } = makeTempRoot();
    const raw = validThemeJson({
      name: "Partial Studio Pet",
      author: "Clawd AI Studio",
      states: {
        ...validThemeJson().states,
        idle: ["idle.svg"],
      },
    });
    const themeDir = writeTheme(userThemesDir, "partial-studio-pet", raw, {
      "idle.svg": "<svg/>",
    });

    const meta = getThemeMetadata("partial-studio-pet", {
      readThemeJson: () => ({ raw, isBuiltin: false, themeDir }),
    });

    assert.deepStrictEqual(meta.studioPet, {
      complete: false,
      generatedActionCount: 0,
      totalActionCount: ACTIONS.length,
      missingActionIds: ACTIONS.map((action) => action.id),
    });
  });

  it("counts generated sleep-sequence and mini-mode assets as bound", () => {
    const { userThemesDir } = makeTempRoot();
    const sleepActions = ACTIONS.filter((a) => a.category === "sleep");
    const miniActions = ACTIONS.filter((a) => a.category === "mini");

    const miniStates = {};
    for (const a of miniActions) miniStates[a.id] = [`${a.id}.svg`];
    // validThemeJson already binds the sleep states (yawning…waking) to <id>.svg.
    const raw = validThemeJson({
      name: "Sleepy Peeker",
      author: "Clawd AI Studio",
      sleepSequence: { mode: "full" },
      miniMode: { supported: true, flipAssets: true, offsetRatio: 0.4, states: miniStates },
    });

    const assets = {};
    addStudioActionAssets(assets, ACTIONS.find((action) => action.id === "idle"));
    for (const action of [...sleepActions, ...miniActions]) addStudioActionAssets(assets, action);
    const themeDir = writeTheme(userThemesDir, "sleepy-peeker", raw, assets);

    const meta = getThemeMetadata("sleepy-peeker", {
      readThemeJson: () => ({ raw, isBuiltin: false, themeDir }),
    });

    const missing = new Set(meta.studioPet.missingActionIds);
    for (const a of [...sleepActions, ...miniActions]) {
      assert.ok(!missing.has(a.id), `${a.id} should be recognized as a generated asset`);
    }
    assert.strictEqual(
      meta.studioPet.generatedActionCount,
      1 + sleepActions.length + miniActions.length,
      "idle + every sleep + every mini asset is counted",
    );
  });

  it("scans built-in and user metadata while skipping scaffold, malformed, and duplicate user themes", () => {
    const { builtinThemesDir, userThemesDir } = makeTempRoot();
    writeTheme(builtinThemesDir, "clawd", validThemeJson({ name: "Builtin Clawd" }));
    writeTheme(builtinThemesDir, "template", validThemeJson({ name: "Template", _scaffoldOnly: true }));
    writeTheme(userThemesDir, "clawd", validThemeJson({ name: "User Clawd" }));
    writeTheme(userThemesDir, "user-cat", validThemeJson({ name: "User Cat" }));
    const malformedDir = path.join(userThemesDir, "broken");
    fs.mkdirSync(malformedDir, { recursive: true });
    fs.writeFileSync(path.join(malformedDir, "theme.json"), "{not json", "utf8");

    const themes = listThemesWithMetadata({ builtinThemesDir, userThemesDir });

    assert.deepStrictEqual(themes.map((theme) => theme.id), ["clawd", "user-cat"]);
    assert.strictEqual(themes.find((theme) => theme.id === "clawd").name, "Builtin Clawd");
  });
});

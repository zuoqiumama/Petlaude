"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStudioRuntime } = require("../src/studio/studio-runtime");
const { ensurePetTheme } = require("../src/studio/pet-theme");
const { getAction } = require("../src/companion/action-manifest");
const themeLoader = require("../src/theme-loader");

const TEMPLATE_DIR = path.join(__dirname, "..", "themes", "template");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-studio-rt-"));
}

function writeRef(dir) {
  const p = path.join(dir, "ref.png");
  fs.writeFileSync(p, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ));
  return p;
}

function fakeFrames(n) {
  const frames = [];
  for (let i = 0; i < n; i += 1) frames.push(`data:image/png;base64,FRAME${i}`);
  return frames;
}

function makeHarness({ failClient = false, failActions = [] } = {}) {
  const userDataDir = tmpDir();
  const userThemesDir = path.join(userDataDir, "themes");
  const refPath = writeRef(tmpDir());
  const { themeDir, themeId } = ensurePetTheme({
    name: "Test Pet", referencePath: refPath, userThemesDir, templateDir: TEMPLATE_DIR,
  });

  const calls = { client: [], guides: [], strips: [], downloads: [] };
  const progress = [];

  const runtime = createStudioRuntime({
    themeDir,
    referencePath: refPath,
    config: { baseUrl: "https://api.example.com", apiKey: "sk-test", model: "gpt-image-2" },
    deps: {
      generateImage: async (params) => {
        calls.client.push(params);
        const actionId = params._actionId || "?";
        if (failClient || failActions.includes(actionId)) {
          const e = new Error("boom");
          e.code = "IMAGEGEN_HTTP_ERROR";
          throw e;
        }
        return "https://img.example/strip.png";
      },
      downloadImage: async (url) => {
        calls.downloads.push(url);
        return Buffer.from("fake-png-bytes");
      },
      processor: {
        makeGuide: async (payload) => {
          calls.guides.push(payload);
          return { dataUrl: "data:image/png;base64,GUIDE" };
        },
        processStrip: async (payload) => {
          calls.strips.push(payload);
          const action = getAction(payload._actionId);
          const n = payload.cols * payload.rows;
          return {
            frames: fakeFrames(n),
            report: fakeFrames(n).map((_, i) => ({ row: 0, col: i, rawW: 100, rawH: 100, opaquePct: 40 })),
          };
        },
      },
    },
    onProgress: (e) => progress.push(e),
  });

  return { runtime, themeDir, themeId, userDataDir, refPath, calls, progress };
}

function readTheme(themeDir) {
  return JSON.parse(fs.readFileSync(path.join(themeDir, "theme.json"), "utf8"));
}

describe("studio-runtime generateAction", () => {
  let h;
  beforeEach(() => { h = makeHarness(); });

  it("runs guide → client → process → assemble → write for an idle-life action", async () => {
    const result = await h.runtime.generateAction("yawn");
    assert.strictEqual(result.actionId, "yawn");

    // guide built with the manifest grid
    assert.strictEqual(h.calls.guides.length, 1);
    assert.strictEqual(h.calls.guides[0].cols, 2);
    assert.strictEqual(h.calls.guides[0].rows, 2);

    // client got the prompt + [reference, guide]
    assert.strictEqual(h.calls.client.length, 1);
    const params = h.calls.client[0];
    assert.match(params.prompt, /2x2/);
    assert.strictEqual(params.images.length, 2);
    assert.ok(params.images[0].startsWith("data:image/png;base64,"), "reference data url");
    assert.strictEqual(params.images[1], "data:image/png;base64,GUIDE");

    // svg written with the frames
    const svgPath = path.join(h.themeDir, "assets", "yawn.svg");
    assert.ok(fs.existsSync(svgPath), "svg asset written");
    const svg = fs.readFileSync(svgPath, "utf8");
    assert.match(svg, /href="yawn-frame-1\.png"/);
    assert.match(svg, /href="yawn-frame-4\.png"/);
    assert.doesNotMatch(svg, /data:image/, "external-theme sanitizer strips data URLs");
    assert.ok(fs.existsSync(path.join(h.themeDir, "assets", "yawn-frame-1.png")));
    assert.ok(fs.existsSync(path.join(h.themeDir, "assets", "yawn-frame-4.png")));

    themeLoader.init(path.join(__dirname, "..", "src"), h.userDataDir);
    const loaded = themeLoader.loadTheme(h.themeId, { strict: true });
    const cachedSvg = path.join(loaded._assetsDir, "yawn.svg");
    assert.ok(fs.existsSync(cachedSvg), "generated SVG survives external-theme loading");
    assert.ok(fs.existsSync(path.join(loaded._assetsDir, "yawn-frame-1.png")), "frame dependency copied to cache");

    // theme.json patched into idleLife with the manifest trigger
    const theme = readTheme(h.themeDir);
    const entry = (theme.idleLife.behaviors || []).find((b) => b.id === "yawn");
    assert.ok(entry, "idleLife behavior added");
    assert.strictEqual(entry.file, "yawn.svg");
    assert.strictEqual(entry.duration, getAction("yawn").anim.totalMs);
    assert.strictEqual(entry.trigger.idleMinMs, getAction("yawn").trigger.idleMinMs);

    // progress order
    const stages = h.progress.filter((p) => p.actionId === "yawn").map((p) => p.stage);
    assert.deepStrictEqual(stages, ["start", "generated", "extracted", "assembled", "written"]);
  });

  it("writes context actions into contextReactions keyed by trigger type", async () => {
    await h.runtime.generateAction("error-comfort");
    const theme = readTheme(h.themeDir);
    assert.ok(theme.contextReactions, "contextReactions created");
    const entry = theme.contextReactions.errorStreak;
    assert.ok(entry, "errorStreak entry");
    assert.strictEqual(entry.file, "error-comfort.svg");
    assert.strictEqual(entry.duration, getAction("error-comfort").anim.totalMs);
  });

  it("writes touch actions into touchReactions AND mirrors into reactions", async () => {
    await h.runtime.generateAction("dizzy");
    const theme = readTheme(h.themeDir);
    assert.strictEqual(theme.touchReactions.rapidClick.file, "dizzy.svg");
    assert.strictEqual(theme.reactions.rapidClick.file, "dizzy.svg");
  });

  it("writes core actions into theme.states replacing the static reference", async () => {
    await h.runtime.generateAction("working");
    const theme = readTheme(h.themeDir);
    // The busy family all binds to the one generated working loop.
    assert.deepStrictEqual(theme.states.working, ["working.svg"]);
    assert.deepStrictEqual(theme.states.juggling, ["working.svg"]);
    assert.deepStrictEqual(theme.states.sweeping, ["working.svg"]);
    assert.deepStrictEqual(theme.states.carrying, ["working.svg"]);
    // Untouched states keep the static reference placeholder.
    assert.match(theme.states.idle[0], /^reference\./);
    assert.ok(fs.existsSync(path.join(h.themeDir, "assets", "working.svg")));
  });

  it("generated sleeping replaces the fallbackTo binding with a real animation", async () => {
    const before = readTheme(h.themeDir);
    assert.deepStrictEqual(before.states.sleeping, { fallbackTo: "idle" });
    await h.runtime.generateAction("sleeping");
    const theme = readTheme(h.themeDir);
    assert.deepStrictEqual(theme.states.sleeping, ["sleeping.svg"]);
  });

  it("core states survive ensurePetTheme re-entry between per-action runs", async () => {
    await h.runtime.generateAction("idle");
    await h.runtime.generateAction("error");
    // studio-ipc re-enters ensurePetTheme before every generation.
    ensurePetTheme({
      name: "Test Pet",
      referencePath: h.refPath,
      userThemesDir: path.join(h.userDataDir, "themes"),
      templateDir: TEMPLATE_DIR,
    });
    const theme = readTheme(h.themeDir);
    assert.deepStrictEqual(theme.states.idle, ["idle.svg"]);
    assert.deepStrictEqual(theme.states.error, ["error.svg"]);
    // Never-generated states still fall back to the reference placeholder.
    assert.match(theme.states.thinking[0], /^reference\./);
  });

  it("re-generating the same action replaces its entry (no duplicates)", async () => {
    await h.runtime.generateAction("yawn");
    await h.runtime.generateAction("yawn");
    const theme = readTheme(h.themeDir);
    const entries = theme.idleLife.behaviors.filter((b) => b.id === "yawn");
    assert.strictEqual(entries.length, 1);
  });

  it("a failing client surfaces a typed error and leaves no partial writes", async () => {
    const bad = makeHarness({ failClient: true });
    const before = fs.readFileSync(path.join(bad.themeDir, "theme.json"), "utf8");
    await assert.rejects(() => bad.runtime.generateAction("yawn"), (e) => e.code === "IMAGEGEN_HTTP_ERROR");
    assert.ok(!fs.existsSync(path.join(bad.themeDir, "assets", "yawn.svg")), "no svg written");
    assert.strictEqual(fs.readFileSync(path.join(bad.themeDir, "theme.json"), "utf8"), before, "theme.json untouched");
  });

  it("rejects unknown action ids", async () => {
    await assert.rejects(() => h.runtime.generateAction("nope"), /unknown action/);
  });

  it("rejects blank extracted frames instead of writing a broken animation", async () => {
    const bad = makeHarness();
    const runtime = createStudioRuntime({
      themeDir: bad.themeDir,
      referencePath: bad.refPath,
      config: { baseUrl: "https://x", apiKey: "k", model: "m" },
      deps: {
        generateImage: async () => "https://img/s.png",
        downloadImage: async () => Buffer.from("png"),
        processor: {
          makeGuide: async () => ({ dataUrl: "data:image/png;base64,G" }),
          processStrip: async (p) => ({
            frames: fakeFrames(p.cols * p.rows),
            report: Array.from({ length: p.cols * p.rows }, (_, i) => ({
              rawW: i === 1 ? 0 : 100,
              rawH: i === 1 ? 0 : 100,
              opaquePct: i === 1 ? 0 : 20,
            })),
          }),
        },
      },
    });
    await assert.rejects(() => runtime.generateAction("yawn"), /frame 2.*blank|sparse/i);
    assert.ok(!fs.existsSync(path.join(bad.themeDir, "assets", "yawn.svg")));
  });

  it("accepts a base64 data URL returned by GPT Image", async () => {
    const good = makeHarness();
    let stripDataUrl = "";
    const runtime = createStudioRuntime({
      themeDir: good.themeDir,
      referencePath: good.refPath,
      config: { baseUrl: "https://x", apiKey: "k", model: "m" },
      deps: {
        generateImage: async () => "data:image/png;base64,UE5H",
        processor: {
          makeGuide: async () => ({ dataUrl: "data:image/png;base64,G" }),
          processStrip: async (p) => {
            stripDataUrl = p.stripDataUrl;
            return {
              frames: fakeFrames(p.cols * p.rows),
              report: Array.from({ length: p.cols * p.rows }, () => ({ rawW: 100, rawH: 100, opaquePct: 20 })),
            };
          },
        },
      },
    });
    await runtime.generateAction("yawn");
    assert.strictEqual(stripDataUrl, "data:image/png;base64,UE5H");
  });
});

describe("studio-runtime reference + guide geometry", () => {
  it("uses processor.prepareReference (downscaled) when available", async () => {
    const h = makeHarness(); // base harness lacks prepareReference — build a runtime that has it
    const prepared = [];
    const { createStudioRuntime } = require("../src/studio/studio-runtime");
    const runtime = createStudioRuntime({
      themeDir: h.themeDir,
      referencePath: h.refPath,
      config: { baseUrl: "https://x", apiKey: "k", model: "m" },
      deps: {
        generateImage: async (params) => { prepared.push(params.images[0]); return "https://img/s.png"; },
        downloadImage: async () => Buffer.from("png"),
        processor: {
          prepareReference: async () => ({ dataUrl: "data:image/png;base64,SMALLREF" }),
          makeGuide: async () => ({ dataUrl: "data:image/png;base64,G" }),
          processStrip: async (p) => ({
            frames: fakeFrames(p.cols * p.rows),
            report: [],
          }),
        },
      },
    });
    await runtime.generateAction("yawn");
    assert.strictEqual(prepared[0], "data:image/png;base64,SMALLREF");
  });

  it("uses a square 2x2 guide for three-frame actions", async () => {
    const h = makeHarness();
    await h.runtime.generateAction("curious");
    const guide = h.calls.guides[0];
    assert.strictEqual(guide.cellW, 512);
    assert.strictEqual(guide.cellH, 512);
    const params = h.calls.client[0];
    assert.strictEqual(params.size, "1024x1024");
  });

  it("uses the reference-aware chroma choice for both prompting and extraction", async () => {
    const h = makeHarness();
    const generated = [];
    const strips = [];
    const runtime = createStudioRuntime({
      themeDir: h.themeDir,
      referencePath: h.refPath,
      config: { baseUrl: "https://x", apiKey: "k", model: "m" },
      deps: {
        generateImage: async (params) => { generated.push(params); return "https://img/s.png"; },
        downloadImage: async () => Buffer.from("png"),
        processor: {
          prepareReference: async () => ({ dataUrl: "data:image/png;base64,REF" }),
          chooseChroma: async () => ({ rgb: [255, 0, 255], hex: "#FF00FF" }),
          makeGuide: async () => ({ dataUrl: "data:image/png;base64,G" }),
          processStrip: async (p) => {
            strips.push(p);
            return {
              frames: fakeFrames(p.cols * p.rows),
              report: Array.from({ length: p.cols * p.rows }, () => ({ rawW: 100, rawH: 100, opaquePct: 20 })),
            };
          },
        },
      },
    });
    await runtime.generateAction("yawn");
    assert.match(generated[0].prompt, /#FF00FF/);
    assert.deepStrictEqual(strips[0].key, [255, 0, 255]);
  });
});

describe("studio-runtime generateAll", () => {
  it("continues past failures and returns a summary", async () => {
    const h = makeHarness({ failActions: ["snack", "dizzy"] });
    const summary = await h.runtime.generateAll();
    assert.strictEqual(summary.total, summary.ok + summary.failed.length);
    assert.deepStrictEqual(summary.failed.map((f) => f.actionId).sort(), ["dizzy", "snack"]);
    // succeeded ones actually wrote assets
    assert.ok(fs.existsSync(path.join(h.themeDir, "assets", "yawn.svg")));
    assert.ok(!fs.existsSync(path.join(h.themeDir, "assets", "snack.svg")));
  });
});

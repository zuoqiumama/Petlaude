"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createStudioRuntime } = require("../src/studio/studio-runtime");
const { ensurePetTheme } = require("../src/studio/pet-theme");
const { getAction } = require("../src/companion/action-manifest");

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
  const userThemesDir = tmpDir();
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

  return { runtime, themeDir, themeId, refPath, calls, progress };
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
    assert.ok(svg.includes("FRAME0") && svg.includes("FRAME3"), "frames embedded");

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

  it("guide cells match the output size aspect (3x1 grid → 512x1024 cells)", async () => {
    const h = makeHarness();
    await h.runtime.generateAction("curious"); // 3x1 grid → 1536x1024 output
    const guide = h.calls.guides[0];
    assert.strictEqual(guide.cellW, 512);
    assert.strictEqual(guide.cellH, 1024);
    const params = h.calls.client[0];
    assert.strictEqual(params.size, "1536x1024");
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

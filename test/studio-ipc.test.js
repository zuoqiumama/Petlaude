"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { registerStudioIpc } = require("../src/studio-ipc");

const TEMPLATE_DIR = path.join(__dirname, "..", "themes", "template");

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle: (ch, fn) => handlers.set(ch, fn),
    removeHandler: (ch) => handlers.delete(ch),
    invoke: (ch, ...args) => handlers.get(ch)(null, ...args),
  };
}

function fakeConfig(cfg = {}) {
  let stored = { baseUrl: "", model: "", apiKey: "", ...cfg };
  return {
    loadConfig: () => ({ ...stored }),
    saveConfig: (next) => {
      if (!/^https:/.test(next.baseUrl || "")) throw new Error("baseUrl must use https");
      stored = { ...stored, ...next };
      return { keyPersisted: true };
    },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-studio-ipc-"));
}

function writeRef(dir) {
  const p = path.join(dir, "buddy.png");
  fs.writeFileSync(p, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ));
  return p;
}

function register(overrides = {}) {
  const ipcMain = fakeIpcMain();
  const deps = {
    ipcMain,
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    studioConfig: fakeConfig({ baseUrl: "https://api.example.com", model: "gpt-image-2", apiKey: "sk-x" }),
    getProcessor: () => ({
      makeGuide: async () => ({ dataUrl: "data:image/png;base64,G" }),
      processStrip: async (p) => ({
        frames: Array.from({ length: p.cols * p.rows }, (_, i) => `data:image/png;base64,F${i}`),
        report: [],
      }),
    }),
    userThemesDir: tmpDir(),
    templateDir: TEMPLATE_DIR,
    getSettingsWindow: () => null,
    runtimeDeps: {
      generateImage: async () => "https://img.example/s.png",
      downloadImage: async () => Buffer.from("png"),
    },
    ...overrides,
  };
  registerStudioIpc(deps);
  return { ipcMain, deps };
}

describe("studio-ipc", () => {
  it("get-config reports hasKey but never the key itself", async () => {
    const { ipcMain } = register();
    const cfg = await ipcMain.invoke("studio:get-config");
    assert.deepStrictEqual(cfg, { baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true });
    assert.ok(!("apiKey" in cfg));
  });

  it("get-actions returns the manifest summary", async () => {
    const { ipcMain } = register();
    const actions = await ipcMain.invoke("studio:get-actions");
    assert.ok(actions.length >= 14);
    assert.ok(actions.every((a) => a.id && a.category && a.frames > 0));
  });

  it("generate runs a single action end-to-end and writes the theme", async () => {
    const { ipcMain, deps } = register();
    const ref = writeRef(tmpDir());
    const res = await ipcMain.invoke("studio:generate", { actionId: "yawn", petName: "Buddy", referencePath: ref });
    assert.strictEqual(res.status, "ok");
    assert.strictEqual(res.themeId, "buddy");
    assert.ok(fs.existsSync(path.join(deps.userThemesDir, "buddy", "assets", "yawn.svg")));
  });

  it("uses a renderable frame as the written preview and keeps all animation frames", async () => {
    const sent = [];
    const settingsWindow = {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
    };
    const { ipcMain } = register({ getSettingsWindow: () => settingsWindow });
    const ref = writeRef(tmpDir());

    const res = await ipcMain.invoke("studio:generate", {
      actionId: "yawn",
      petName: "Buddy",
      referencePath: ref,
    });

    assert.strictEqual(res.status, "ok");
    const written = sent.find((entry) => (
      entry.channel === "studio:progress"
      && entry.payload.actionId === "yawn"
      && entry.payload.stage === "written"
    ));
    assert.ok(written, "written progress should be sent to Settings");
    assert.match(written.payload.previewUrl, /^file:\/\//);
    assert.match(written.payload.previewUrl, /yawn-frame-1\.png/);
    assert.match(written.payload.previewUrl, /[?&]_studioPreview=/);
    assert.ok(written.payload.previewFrameUrls.length > 1);
    assert.ok(written.payload.previewFrameUrls.every((url) => /yawn-frame-\d+\.png/.test(url)));
    assert.ok(written.payload.previewFrameUrls.every((url) => /[?&]_studioPreview=/.test(url)));
  });

  it("returns preview URLs for successful generate-all results", async () => {
    const { ipcMain } = register();
    const ref = writeRef(tmpDir());
    const res = await ipcMain.invoke("studio:generate", {
      mode: "all",
      petName: "Buddy",
      referencePath: ref,
    });

    assert.strictEqual(res.status, "ok");
    assert.strictEqual(res.summary.results.length, res.summary.ok);
    assert.ok(res.summary.results.every((result) => result.previewUrl));
    assert.ok(res.summary.results.every((result) => result.previewFrameUrls.length > 1));
  });

  it("restores completed action previews from an existing Studio theme", async () => {
    const { ipcMain } = register();
    const ref = writeRef(tmpDir());
    await ipcMain.invoke("studio:generate", {
      actionId: "yawn",
      petName: "Buddy",
      referencePath: ref,
    });

    const statuses = await ipcMain.invoke("studio:get-action-statuses", { petName: "Buddy" });
    assert.deepStrictEqual(statuses.map((status) => status.actionId), ["yawn"]);
    assert.strictEqual(statuses[0].stage, "written");
    assert.match(statuses[0].previewUrl, /yawn-frame-1\.png/);
    assert.ok(statuses[0].previewFrameUrls.length > 1);
    const latest = await ipcMain.invoke("studio:get-action-statuses", {});
    assert.strictEqual(latest[0].petName, "Buddy");
  });

  it("does not restore actions generated from a different reference image", async () => {
    const { ipcMain, deps } = register();
    const ref = writeRef(tmpDir());
    await ipcMain.invoke("studio:generate", {
      actionId: "yawn",
      petName: "Buddy",
      referencePath: ref,
    });

    fs.writeFileSync(
      path.join(deps.userThemesDir, "buddy", "assets", "reference.png"),
      Buffer.from("different-pet-reference"),
    );

    const statuses = await ipcMain.invoke("studio:get-action-statuses", { petName: "Buddy" });
    assert.deepStrictEqual(statuses, []);
  });

  it("generate rejects concurrent runs", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { ipcMain } = register({
      runtimeDeps: {
        generateImage: async () => { await gate; return "https://img.example/s.png"; },
        downloadImage: async () => Buffer.from("png"),
      },
    });
    const ref = writeRef(tmpDir());
    const first = ipcMain.invoke("studio:generate", { actionId: "yawn", petName: "A", referencePath: ref });
    const second = await ipcMain.invoke("studio:generate", { actionId: "snack", petName: "A", referencePath: ref });
    assert.strictEqual(second.status, "error");
    assert.match(second.message, /already running/);
    release();
    const firstRes = await first;
    assert.strictEqual(firstRes.status, "ok");
  });

  it("generate validates config and reference", async () => {
    const { ipcMain } = register({ studioConfig: fakeConfig() });
    const res = await ipcMain.invoke("studio:generate", { actionId: "yawn", referencePath: "C:/nope.png" });
    assert.strictEqual(res.status, "error");
    assert.match(res.message, /config incomplete/);
  });

  it("test-config treats 2xx as ok and 401 as error", async () => {
    const { ipcMain } = register({ httpGet: async () => ({ status: 200 }) });
    assert.deepStrictEqual(await ipcMain.invoke("studio:test-config"), { status: "ok" });
    const bad = register({ httpGet: async () => ({ status: 401 }) });
    const res = await bad.ipcMain.invoke("studio:test-config");
    assert.strictEqual(res.status, "error");
  });

  it("test-config does not report arbitrary HTTP failures as connected", async () => {
    const { ipcMain } = register({ httpGet: async () => ({ status: 500 }) });
    const res = await ipcMain.invoke("studio:test-config");
    assert.deepStrictEqual(res, {
      status: "error",
      message: "connection test failed (HTTP 500)",
    });
  });

  it("test-config sends the current draft URL and key without saving them", async () => {
    const requests = [];
    const { ipcMain } = register({
      httpGet: async (url, headers) => {
        requests.push({ url, headers });
        return { status: 200 };
      },
    });

    const res = await ipcMain.invoke("studio:test-config", {
      baseUrl: "https://draft.example.com/v1/",
      model: "draft-image-model",
      apiKey: "sk-draft",
    });

    assert.deepStrictEqual(res, { status: "ok" });
    assert.deepStrictEqual(requests, [{
      url: "https://draft.example.com/v1/models",
      headers: { Authorization: "Bearer sk-draft" },
    }]);
  });

  it("test-config keeps the saved key when the draft key is blank", async () => {
    const requests = [];
    const { ipcMain } = register({
      httpGet: async (url, headers) => {
        requests.push({ url, headers });
        return { status: 200 };
      },
    });

    await ipcMain.invoke("studio:test-config", {
      baseUrl: "https://draft.example.com",
      model: "draft-image-model",
      apiKey: "",
    });

    assert.strictEqual(requests[0].headers.Authorization, "Bearer sk-x");
  });

  it("use-current-pet errors when no active-theme hook is wired", async () => {
    const { ipcMain } = register();
    const res = await ipcMain.invoke("studio:use-current-pet");
    assert.strictEqual(res.status, "error");
  });

  it("use-current-pet rasterizes the active theme's idle visual into a PNG reference", async () => {
    const themeDir = tmpDir();
    const assetAbs = path.join(themeDir, "pet-idle.svg");
    fs.writeFileSync(assetAbs, "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const prepareCalls = [];
    const refsDir = path.join(tmpDir(), "studio-refs");
    const { ipcMain } = register({
      studioRefsDir: refsDir,
      getActiveTheme: () => ({
        _id: "clawd",
        name: "Clawd",
        states: { idle: ["pet-idle.svg"] },
      }),
      resolveThemeAsset: (_theme, filename) => path.join(themeDir, filename),
      getProcessor: () => ({
        prepareReference: async (payload) => {
          prepareCalls.push(payload);
          return { dataUrl: `data:image/png;base64,${pngBytes.toString("base64")}` };
        },
      }),
    });

    const res = await ipcMain.invoke("studio:use-current-pet");
    assert.strictEqual(res.status, "ok");
    assert.strictEqual(res.suggestedName, "Clawd AI");
    assert.ok(prepareCalls[0].dataUrl.startsWith("data:image/svg+xml;base64,"), "svg passed for rasterizing");
    assert.ok(fs.existsSync(res.path), "png reference written");
    assert.ok(res.path.startsWith(refsDir), "written under studio-refs");
    assert.ok(pngBytes.equals(fs.readFileSync(res.path)), "decoded png persisted");
  });

  it("use-current-pet prefers a Studio theme's original raster reference", async () => {
    const themeDir = tmpDir();
    fs.mkdirSync(path.join(themeDir, "assets"), { recursive: true });
    const refAbs = path.join(themeDir, "assets", "reference.png");
    fs.writeFileSync(refAbs, Buffer.from("raster-reference"));
    const seen = [];
    const { ipcMain } = register({
      studioRefsDir: path.join(tmpDir(), "studio-refs"),
      getActiveTheme: () => ({
        _id: "my-pet",
        name: "My Pet AI",
        _themeDir: themeDir,
        states: { idle: ["idle.svg"] },
      }),
      resolveThemeAsset: () => { throw new Error("must not resolve idle when reference exists"); },
      getProcessor: () => ({
        prepareReference: async (payload) => {
          seen.push(payload.dataUrl);
          return {
            dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          };
        },
      }),
    });

    const res = await ipcMain.invoke("studio:use-current-pet");
    assert.strictEqual(res.status, "ok");
    assert.ok(seen[0].startsWith("data:image/png;base64,"), "raster reference used as source");
    // Name already ends in AI — no double suffix.
    assert.strictEqual(res.suggestedName, "My Pet AI");
  });
});

"use strict";

const assert = require("node:assert");
const Module = require("node:module");
const { describe, it, afterEach } = require("node:test");

const FILE_DROP_BUBBLE_MODULE_PATH = require.resolve("../src/file-drop-bubble");

class FakeBrowserWindow {
  static instances = [];

  static fromWebContents(contents) {
    return FakeBrowserWindow.instances.find((win) => win.webContents === contents) || null;
  }

  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.visible = false;
    this.bounds = null;
    this.listeners = new Map();
    this.sent = [];
    this.webContents = {
      isDestroyed: () => false,
      isLoading: () => false,
      once: () => {},
      send: (...args) => this.sent.push(args),
    };
    FakeBrowserWindow.instances.push(this);
  }

  loadFile(file) { this.loadedFile = file; }
  on(event, handler) { this.listeners.set(event, handler); }
  setAlwaysOnTop() {}
  setBounds(bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; }
  hide() { this.visible = false; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() {
    this.destroyed = true;
    const handler = this.listeners.get("closed");
    if (typeof handler === "function") handler();
  }
}

function loadFileDropBubbleWithElectron(fakeElectron) {
  delete require.cache[FILE_DROP_BUBBLE_MODULE_PATH];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require("../src/file-drop-bubble");
  } finally {
    Module._load = originalLoad;
  }
}

function createHarness() {
  FakeBrowserWindow.instances = [];
  const initFileDropBubble = loadFileDropBubbleWithElectron({ BrowserWindow: FakeBrowserWindow });
  const api = initFileDropBubble({
    win: { isDestroyed: () => false },
    petHidden: false,
    getPetWindowBounds: () => ({ x: 100, y: 200, width: 120, height: 100 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    getHitRectScreen: () => ({ left: 120, right: 220, top: 220, bottom: 280 }),
    getHudReservedOffset: () => 0,
    guardAlwaysOnTop: () => {},
    reapplyMacVisibility: () => {},
  });
  return { api };
}

describe("file drop bubble", () => {
  afterEach(() => {
    FakeBrowserWindow.instances = [];
    delete require.cache[FILE_DROP_BUBBLE_MODULE_PATH];
  });

  it("shows a non-focus-stealing bubble and resolves the chosen action", async () => {
    const { api } = createHarness();
    const resultPromise = api.showFileDropBubble({
      title: "Caught",
      message: "1 file",
      actions: [{ id: "copy-prompt", label: "Copy", variant: "primary" }],
      defaultAction: "cancel",
    });

    const bubble = api.getBubbleWindow();
    assert.strictEqual(bubble.options.focusable, false);
    assert.strictEqual(bubble.visible, true);
    assert.deepStrictEqual(bubble.sent[0], [
      "file-drop-bubble-show",
      {
        title: "Caught",
        message: "1 file",
        actions: [{ id: "copy-prompt", label: "Copy", variant: "primary" }],
        defaultAction: "cancel",
      },
    ]);

    api.handleFileDropBubbleAction({ sender: bubble.webContents }, "copy-prompt");
    assert.deepStrictEqual(await resultPromise, { action: "copy-prompt", source: "user" });
  });

  it("positions the bubble beside the pet hit rect", () => {
    const { api } = createHarness();
    api.showFileDropBubble({
      title: "Caught",
      message: "1 file",
      actions: [],
      defaultAction: "cancel",
    });

    const bubble = api.getBubbleWindow();
    assert.ok(bubble.bounds.x >= 0);
    assert.ok(bubble.bounds.y >= 0);
    assert.strictEqual(bubble.bounds.width, 340);
  });
});

"use strict";

// Lazy usage-snapshot broadcasting: recordUsageEvent passes thunks instead of
// precomputed snapshots, and the dashboard / usage-hover receivers must only
// resolve a thunk when a window can actually display the result. These tests
// pin that contract so high-frequency hook events stay cheap while the
// windows are closed.

const assert = require("node:assert");
const EventEmitter = require("node:events");
const Module = require("node:module");
const { describe, it } = require("node:test");

const DASHBOARD_MODULE_PATH = require.resolve("../src/dashboard");
const USAGE_HOVER_MODULE_PATH = require.resolve("../src/usage-hover");

function loadWithFakeElectron(modulePath, fakeElectron) {
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

function createFakeBrowserWindowClass() {
  let createdWindow = null;

  class FakeBrowserWindow {
    constructor(opts) {
      this.opts = opts;
      this.destroyed = false;
      this.visible = true;
      this.onceCallbacks = new Map();
      this.sentMessages = [];
      const self = this;
      this.webContents = {
        isDestroyed: () => false,
        once: (eventName, callback) => {
          self.onceCallbacks.set(`webContents:${eventName}`, callback);
        },
        send: (channel, payload) => {
          self.sentMessages.push({ channel, payload });
        },
        setWindowOpenHandler: () => {},
      };
      createdWindow = this;
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return false; }
    destroy() { this.destroyed = true; }
    restore() {}
    show() {}
    showInactive() {}
    hide() { this.visible = false; }
    focus() {}
    setMenuBarVisibility() {}
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    loadFile() {}
    setBounds() {}
    getBounds() { return { x: 0, y: 0, width: 200, height: 100 }; }
    setParentWindow() {}
    once(eventName, callback) { this.onceCallbacks.set(eventName, callback); }
    on() {}
    emitOnce(eventName) {
      const callback = this.onceCallbacks.get(eventName);
      if (callback) callback();
    }
  }

  return { FakeBrowserWindow, getCreatedWindow: () => createdWindow };
}

function createDashboardHarness() {
  const { FakeBrowserWindow, getCreatedWindow } = createFakeBrowserWindowClass();
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  const initDashboard = loadWithFakeElectron(DASHBOARD_MODULE_PATH, {
    BrowserWindow: FakeBrowserWindow,
    nativeTheme,
  });
  const dashboard = initDashboard({
    getPetWindowBounds: () => ({ x: 100, y: 100, width: 120, height: 120 }),
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    setTimeout: () => 0,
    getSessionSnapshot: () => ({ sessions: [], groups: [] }),
    getI18n: () => ({ lang: "en", translations: {} }),
  });
  return { dashboard, getCreatedWindow };
}

describe("lazy usage snapshot broadcast (dashboard)", () => {
  it("does not resolve the thunk while the dashboard window is closed", () => {
    const { dashboard } = createDashboardHarness();
    let computeCalls = 0;
    dashboard.broadcastUsageSnapshot(() => {
      computeCalls += 1;
      return { generatedAt: 1 };
    });
    assert.strictEqual(computeCalls, 0);
  });

  it("resolves the thunk and sends the snapshot once the window exists", () => {
    const { dashboard, getCreatedWindow } = createDashboardHarness();
    dashboard.showDashboard();
    const window = getCreatedWindow();
    assert.ok(window, "showDashboard should create a window");

    let computeCalls = 0;
    dashboard.broadcastUsageSnapshot(() => {
      computeCalls += 1;
      return { generatedAt: 42 };
    });
    assert.strictEqual(computeCalls, 1);
    const usageMessages = window.sentMessages.filter(
      (message) => message.channel === "dashboard:usage-snapshot"
    );
    assert.strictEqual(usageMessages.length, 1);
    assert.deepStrictEqual(usageMessages[0].payload, { generatedAt: 42 });
  });

  it("still accepts precomputed snapshots", () => {
    const { dashboard, getCreatedWindow } = createDashboardHarness();
    dashboard.showDashboard();
    dashboard.broadcastUsageSnapshot({ generatedAt: 7 });
    const window = getCreatedWindow();
    const usageMessages = window.sentMessages.filter(
      (message) => message.channel === "dashboard:usage-snapshot"
    );
    assert.strictEqual(usageMessages.length, 1);
    assert.deepStrictEqual(usageMessages[0].payload, { generatedAt: 7 });
  });
});

describe("lazy usage snapshot broadcast (usage hover)", () => {
  function createHoverHarness() {
    const { FakeBrowserWindow, getCreatedWindow } = createFakeBrowserWindowClass();
    const initUsageHover = loadWithFakeElectron(USAGE_HOVER_MODULE_PATH, {
      BrowserWindow: FakeBrowserWindow,
    });
    let snapshotComputeCalls = 0;
    const usageHover = initUsageHover({
      getUsageSnapshot: () => {
        snapshotComputeCalls += 1;
        return { generatedAt: 99 };
      },
      win: null,
    });
    return {
      usageHover,
      getCreatedWindow,
      getSnapshotComputeCalls: () => snapshotComputeCalls,
    };
  }

  it("does not resolve the thunk while the hover window is hidden", () => {
    const { usageHover } = createHoverHarness();
    let computeCalls = 0;
    usageHover.broadcastUsageSnapshot(() => {
      computeCalls += 1;
      return { generatedAt: 1 };
    });
    assert.strictEqual(computeCalls, 0);
  });

  it("does not crash when a precomputed snapshot arrives while hidden", () => {
    const { usageHover } = createHoverHarness();
    usageHover.broadcastUsageSnapshot({ generatedAt: 3 });
  });
});

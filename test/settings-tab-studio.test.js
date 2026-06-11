"use strict";

// ── Settings tab: AI Pet Studio (renderer behavior) ──────────────────────────
// These tests mount the studio tab against a tiny DOM stub and the same
// render-on-request contract the real renderer uses (renderContent wipes
// #content and re-runs the active tab's render()). They guard against the tab
// driving itself into an unbounded re-render loop — which destroys the API-config
// inputs on every keystroke so they "cannot be filled in".

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

// ── minimal DOM stub ──
function makeClassList() {
  const set = new Set();
  return {
    _set: set,
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => {
      const want = on === undefined ? !set.has(c) : !!on;
      if (want) set.add(c); else set.delete(c);
      return want;
    },
  };
}

function matchesSelector(el, sel) {
  if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
  return el.tagName === sel.toUpperCase();
}

function queryDeep(root, sel, all, out) {
  for (const child of root.children) {
    if (matchesSelector(child, sel)) {
      if (all) out.push(child); else return child;
    }
    const found = queryDeep(child, sel, all, out);
    if (!all && found) return found;
  }
  return all ? out : null;
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    parentNode: null,
    _handlers: {},
    _className: "",
    classList: makeClassList(),
    textContent: "",
    value: "",
    type: "",
    placeholder: "",
    spellcheck: false,
    autocomplete: "",
    src: "",
    alt: "",
    disabled: false,
    isConnected: true,
    dataset: {},
    style: {},
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() {
      if (el.parentNode) el.parentNode.removeChild(el);
    },
    addEventListener(type, fn) {
      (el._handlers[type] = el._handlers[type] || []).push(fn);
    },
    dispatch(type, ev) {
      for (const fn of el._handlers[type] || []) fn(ev || {});
    },
    querySelector(sel) {
      return queryDeep(el, sel, false, null);
    },
    querySelectorAll(sel) {
      return queryDeep(el, sel, true, []);
    },
  };
  Object.defineProperty(el, "className", {
    get() { return el._className; },
    set(v) {
      el._className = v;
      el.classList._set.clear();
      for (const c of String(v).split(/\s+/).filter(Boolean)) el.classList._set.add(c);
    },
  });
  return el;
}

const MODULE_PATH = path.join(__dirname, "..", "src", "settings-tab-studio.js");

function loadStudioTab() {
  delete require.cache[require.resolve(MODULE_PATH)];
  delete globalThis.ClawdSettingsTabStudio;
  require(MODULE_PATH);
  return globalThis.ClawdSettingsTabStudio;
}

const FAKE_ACTIONS = [
  { id: "yawn", category: "idle-life", frames: 6, durationMs: 1200 },
  { id: "smooth-thumbsup", category: "context", frames: 8, durationMs: 1600 },
];

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findByText(root, tag, text) {
  return root.querySelectorAll(tag).find((el) => el.textContent === text) || null;
}

describe("settings-tab-studio render stability", () => {
  beforeEach(() => {
    globalThis.document = { createElement: makeEl };
  });
  afterEach(() => {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.ClawdSettingsTabStudio;
  });

  it("does not loop forever when getConfig resolves before getActions", async () => {
    let getConfigCalls = 0;
    let getActionsCalls = 0;
    // getConfig resolves on a microtask (fast); getActions on a macrotask (slow).
    // This ordering is what the real IPC produces (getConfig is invoked first),
    // and it is exactly what the seq-bumping bug needs to discard the actions.
    globalThis.window = {
      studioAPI: {
        getConfig() {
          getConfigCalls += 1;
          return Promise.resolve({ baseUrl: "", model: "", hasKey: false });
        },
        getActions() {
          getActionsCalls += 1;
          return new Promise((resolve) => setTimeout(() => resolve(FAKE_ACTIONS), 0));
        },
        onProgress() { return () => {}; },
      },
    };

    const parent = makeEl("div");
    const MAX_RENDERS = 20;
    let renderCount = 0;
    let looped = false;

    const core = {
      helpers: { t: (k) => k, escapeHtml: (s) => s },
      ops: {
        requestRender: ({ content } = {}) => { if (content) doRender(); },
        showToast: () => {},
      },
      tabs: {},
    };

    function doRender() {
      if (looped) return;
      renderCount += 1;
      if (renderCount > MAX_RENDERS) { looped = true; return; }
      parent.children.length = 0; // simulate renderContent's innerHTML = ""
      core.tabs.studio.render(parent, core);
    }

    loadStudioTab().init(core);
    doRender(); // initial mount

    await tick(40); // let microtasks drain and the getActions macrotask fire

    assert.ok(!looped, `studio tab entered a runaway re-render loop (renders=${renderCount}, getConfig=${getConfigCalls})`);
    assert.ok(getConfigCalls <= 3, `getConfig called too many times: ${getConfigCalls}`);
    assert.ok(getActionsCalls <= 3, `getActions called too many times: ${getActionsCalls}`);

    const cards = parent.querySelectorAll(".studio-action-card");
    assert.strictEqual(cards.length, FAKE_ACTIONS.length, "action cards should render once actions load");
  });

  it("refreshes saved config so generation becomes available without reopening Settings", async () => {
    let getConfigCalls = 0;
    globalThis.window = {
      studioAPI: {
        getConfig() {
          getConfigCalls += 1;
          return Promise.resolve(getConfigCalls === 1
            ? { baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: false }
            : { baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true });
        },
        getActions: async () => FAKE_ACTIONS,
        saveConfig: async () => ({ status: "ok", keyPersisted: true }),
        pickReference: async () => ({ status: "ok", path: "C:/pet.png", dataUrl: "data:image/png;base64,AA==" }),
        onProgress() { return () => {}; },
      },
    };

    const parent = makeEl("div");
    const core = {
      helpers: { t: (k) => k },
      ops: {
        requestRender: ({ content } = {}) => { if (content) doRender(); },
        showToast: () => {},
      },
      tabs: {},
    };
    function doRender() {
      parent.children.length = 0;
      core.tabs.studio.render(parent, core);
    }

    loadStudioTab().init(core);
    doRender();
    await tick(10);

    const password = parent.querySelectorAll("input").find((el) => el.type === "password");
    password.value = "sk-test";
    password.dispatch("input");
    findByText(parent, "button", "studioSave").dispatch("click");
    await tick(10);
    findByText(parent, "button", "studioPickImage").dispatch("click");
    await tick(10);

    assert.strictEqual(getConfigCalls, 2, "successful save should reload the redacted config snapshot");
    const generate = parent.querySelectorAll(".studio-action-btn")[0];
    assert.strictEqual(generate.disabled, false);
  });

  it("marks a single action failed when main returns an error result", async () => {
    const toasts = [];
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => [FAKE_ACTIONS[0]],
        pickReference: async () => ({ status: "ok", path: "C:/pet.png", dataUrl: "data:image/png;base64,AA==" }),
        generate: async () => ({ status: "error", message: "API boom" }),
        onProgress() { return () => {}; },
      },
    };

    const parent = makeEl("div");
    const core = {
      helpers: { t: (k) => k },
      ops: {
        requestRender: ({ content } = {}) => { if (content) doRender(); },
        showToast: (message) => toasts.push(message),
      },
      tabs: {},
    };
    function doRender() {
      parent.children.length = 0;
      core.tabs.studio.render(parent, core);
    }

    loadStudioTab().init(core);
    doRender();
    await tick(10);
    findByText(parent, "button", "studioPickImage").dispatch("click");
    await tick(10);
    parent.querySelectorAll(".studio-action-btn")[0].dispatch("click");
    await tick(10);

    const badge = parent.querySelector(".studio-badge");
    assert.strictEqual(badge.textContent, "studioStatusFailed");
    assert.ok(badge.classList.contains("studio-badge-error"));
    assert.deepStrictEqual(toasts, ["API boom"]);
  });
});

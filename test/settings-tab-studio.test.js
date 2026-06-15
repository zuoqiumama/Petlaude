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

function setConnected(el, connected) {
  el.isConnected = connected;
  for (const child of el.children) setConnected(child, connected);
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
    isConnected: false,
    dataset: {},
    style: {},
    attributes: {},
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      if (el.isConnected) setConnected(child, true);
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
    setAttribute(name, value) {
      el.attributes[name] = String(value);
      if (name === "class") el.className = value;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(el.attributes, name) ? el.attributes[name] : null;
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

function makeRoot() {
  const el = makeEl("div");
  el.isConnected = true;
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
  {
    id: "yawn",
    category: "idle-life",
    frames: 6,
    durationMs: 1200,
    previewSequence: [0, 1],
    previewKeyTimes: [0, 0.5, 1],
  },
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
    globalThis.document = {
      createElement: makeEl,
      createElementNS: (_namespace, tag) => makeEl(tag),
    };
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

    const parent = makeRoot();
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

  it("fills the form with saved config after the async config load", async () => {
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({
          baseUrl: "https://api.example.com/v1",
          model: "gpt-image-2",
          hasKey: true,
        }),
        getActions: async () => FAKE_ACTIONS,
        onProgress() { return () => {}; },
      },
    };

    const parent = makeRoot();
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

    const inputs = parent.querySelectorAll("input");
    assert.strictEqual(inputs[0].value, "https://api.example.com/v1");
    assert.strictEqual(inputs[1].value, "gpt-image-2");
    assert.strictEqual(inputs[1].disabled, true, "Studio model is fixed, not user-editable");
  });

  it("tests the current form values instead of silently using saved config", async () => {
    const testCalls = [];
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://saved.example.com", model: "saved-model", hasKey: true }),
        getActions: async () => FAKE_ACTIONS,
        testConfig: async (cfg) => {
          testCalls.push(cfg);
          return { status: "ok" };
        },
        onProgress() { return () => {}; },
      },
    };

    const parent = makeRoot();
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

    const inputs = parent.querySelectorAll("input");
    inputs[0].value = "https://draft.example.com/v1";
    inputs[0].dispatch("input");
    inputs[2].value = "sk-draft";
    inputs[2].dispatch("input");
    findByText(parent, "button", "studioTest").dispatch("click");
    await tick(10);

    assert.deepStrictEqual(testCalls, [{
      baseUrl: "https://draft.example.com/v1",
      model: "gpt-image-2",
      apiKey: "sk-draft",
    }]);
  });

  it("clears a stale connection result when the form changes", async () => {
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => FAKE_ACTIONS,
        testConfig: async () => ({ status: "ok" }),
        onProgress() { return () => {}; },
      },
    };

    const parent = makeRoot();
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
    findByText(parent, "button", "studioTest").dispatch("click");
    await tick(10);
    assert.ok(findByText(parent, "span", "studioTestOk"));

    const urlInput = parent.querySelectorAll("input")[0];
    urlInput.value = "";
    urlInput.dispatch("input");

    assert.strictEqual(findByText(parent, "span", "studioTestOk"), null);
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

    const parent = makeRoot();
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

  it("shows a spinner and generating label only on the action currently being generated", async () => {
    let finishGeneration;
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => FAKE_ACTIONS,
        pickReference: async () => ({ status: "ok", path: "C:/pet.png", dataUrl: "data:image/png;base64,AA==" }),
        generate: () => new Promise((resolve) => { finishGeneration = resolve; }),
        onProgress() { return () => {}; },
      },
    };

    const parent = makeRoot();
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
    findByText(parent, "button", "studioPickImage").dispatch("click");
    await tick(10);

    parent.querySelectorAll(".studio-action-btn")[0].dispatch("click");
    await tick(0);

    let buttons = parent.querySelectorAll(".studio-action-btn");
    assert.strictEqual(buttons[0].textContent, "studioGenerating");
    assert.strictEqual(buttons[0].disabled, true);
    assert.ok(buttons[0].classList.contains("studio-action-btn-loading"));
    assert.ok(buttons[0].querySelector(".studio-btn-spinner"));
    assert.strictEqual(buttons[1].textContent, "studioGenerate");
    assert.strictEqual(buttons[1].querySelector(".studio-btn-spinner"), null);

    finishGeneration({ status: "ok" });
    await tick(10);

    buttons = parent.querySelectorAll(".studio-action-btn");
    assert.strictEqual(buttons[0].textContent, "studioGenerate");
    assert.strictEqual(buttons[0].querySelector(".studio-btn-spinner"), null);
  });

  it("shows the generated action preview and clears the loading label on written progress", async () => {
    let finishGeneration;
    let onProgress;
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => FAKE_ACTIONS,
        pickReference: async () => ({ status: "ok", path: "C:/pet.png", dataUrl: "data:image/png;base64,AA==" }),
        generate: () => new Promise((resolve) => { finishGeneration = resolve; }),
        onProgress(cb) { onProgress = cb; return () => {}; },
      },
    };

    const parent = makeRoot();
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
    findByText(parent, "button", "studioPickImage").dispatch("click");
    await tick(10);

    parent.querySelectorAll(".studio-action-btn")[0].dispatch("click");
    await tick(0);
    assert.strictEqual(parent.querySelectorAll(".studio-action-btn")[0].textContent, "studioGenerating");

    const previewUrl = "file:///C:/themes/buddy/assets/yawn-frame-1.png?_studioPreview=1";
    const previewFrameUrls = [
      previewUrl,
      "file:///C:/themes/buddy/assets/yawn-frame-2.png?_studioPreview=1",
    ];
    onProgress({ actionId: "yawn", stage: "written", previewUrl, previewFrameUrls });
    await tick(0);

    const firstCard = parent.querySelectorAll(".studio-action-card")[0];
    const button = firstCard.querySelector(".studio-action-btn");
    const badge = firstCard.querySelector(".studio-badge");
    const preview = firstCard.querySelector(".studio-action-preview-animation");
    assert.strictEqual(badge.textContent, "studioStatusDone");
    assert.ok(badge.classList.contains("studio-badge-done"));
    assert.strictEqual(button.textContent, "studioRegenerate");
    assert.strictEqual(button.querySelector(".studio-btn-spinner"), null);
    assert.ok(preview, "completed action should render an animated preview");
    assert.strictEqual(preview.tagName, "SVG");
    assert.strictEqual(preview.querySelectorAll("image").length, previewFrameUrls.length);
    assert.strictEqual(preview.querySelectorAll("animate").length, previewFrameUrls.length);
    assert.strictEqual(preview.querySelector("animate").getAttribute("dur"), "1200ms");
    assert.strictEqual(preview.querySelector("animate").getAttribute("repeatCount"), "indefinite");

    finishGeneration({ status: "ok" });
    await tick(10);
  });

  it("uses the final IPC result when the written progress event is missed", async () => {
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => FAKE_ACTIONS,
        pickReference: async () => ({ status: "ok", path: "C:/pet.png", dataUrl: "data:image/png;base64,AA==" }),
        generate: async () => ({
          status: "ok",
          result: {
            actionId: "yawn",
            previewUrl: "file:///C:/themes/buddy/assets/yawn-frame-1.png?_studioPreview=2",
            previewFrameUrls: [
              "file:///C:/themes/buddy/assets/yawn-frame-1.png?_studioPreview=2",
              "file:///C:/themes/buddy/assets/yawn-frame-2.png?_studioPreview=2",
            ],
          },
        }),
        onProgress() { return () => {}; },
      },
    };

    const parent = makeRoot();
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
    findByText(parent, "button", "studioPickImage").dispatch("click");
    await tick(10);
    parent.querySelectorAll(".studio-action-btn")[0].dispatch("click");
    await tick(10);

    const firstCard = parent.querySelectorAll(".studio-action-card")[0];
    const badge = firstCard.querySelector(".studio-badge");
    assert.strictEqual(badge.textContent, "studioStatusDone");
    assert.ok(badge.classList.contains("studio-badge-done"));
    assert.strictEqual(firstCard.querySelector(".studio-action-btn").textContent, "studioRegenerate");
    assert.strictEqual(firstCard.querySelector(".studio-action-preview-animation").tagName, "SVG");
  });

  it("restores generated cards after selecting the same pet reference again", async () => {
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => FAKE_ACTIONS,
        getActionStatuses: async () => ([{
          actionId: "yawn",
          stage: "written",
          previewUrl: "file:///C:/themes/buddy/assets/yawn-frame-1.png?_studioPreview=3",
          previewFrameUrls: [
            "file:///C:/themes/buddy/assets/yawn-frame-1.png?_studioPreview=3",
            "file:///C:/themes/buddy/assets/yawn-frame-2.png?_studioPreview=3",
          ],
        }]),
        pickReference: async () => ({
          status: "ok",
          path: "C:/Buddy.png",
          dataUrl: "data:image/png;base64,AA==",
          suggestedName: "Buddy",
        }),
        onProgress() { return () => {}; },
      },
    };

    const parent = makeRoot();
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
    findByText(parent, "button", "studioPickImage").dispatch("click");
    await tick(10);

    const firstCard = parent.querySelectorAll(".studio-action-card")[0];
    assert.strictEqual(firstCard.querySelector(".studio-badge").textContent, "studioStatusDone");
    assert.strictEqual(firstCard.querySelector(".studio-action-btn").textContent, "studioRegenerate");
    assert.strictEqual(firstCard.querySelector(".studio-action-preview-animation").tagName, "SVG");
  });

  it("activates only the action reported by generate-all progress", async () => {
    let finishGeneration;
    let onProgress;
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => FAKE_ACTIONS,
        pickReference: async () => ({ status: "ok", path: "C:/pet.png", dataUrl: "data:image/png;base64,AA==" }),
        generate: () => new Promise((resolve) => { finishGeneration = resolve; }),
        onProgress(cb) { onProgress = cb; return () => {}; },
      },
    };

    const parent = makeRoot();
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
    findByText(parent, "button", "studioPickImage").dispatch("click");
    await tick(10);
    findByText(parent, "button", "studioGenerateAll").dispatch("click");
    await tick(0);

    let buttons = parent.querySelectorAll(".studio-action-btn");
    assert.strictEqual(buttons[0].textContent, "studioGenerate");
    assert.strictEqual(buttons[1].textContent, "studioGenerate");

    onProgress({ actionId: "yawn", stage: "start" });
    await tick(0);
    buttons = parent.querySelectorAll(".studio-action-btn");
    assert.strictEqual(buttons[0].textContent, "studioGenerating");
    assert.strictEqual(buttons[1].textContent, "studioGenerate");

    finishGeneration({
      status: "ok",
      summary: { total: 2, ok: 0, failed: [{ actionId: "yawn", error: "boom" }], results: [], aborted: true, remaining: ["smooth-thumbsup"] },
    });
    await tick(10);
  });

  it("keeps the last valid preview when a single-action regeneration fails", async () => {
    const previewUrl = "file:///C:/themes/buddy/assets/yawn-frame-1.png?_studioPreview=4";
    const previewFrameUrls = [
      previewUrl,
      "file:///C:/themes/buddy/assets/yawn-frame-2.png?_studioPreview=4",
    ];
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => [FAKE_ACTIONS[0]],
        getActionStatuses: async () => ([{
          actionId: "yawn",
          stage: "written",
          previewUrl,
          previewFrameUrls,
        }]),
        pickReference: async () => ({ status: "ok", path: "C:/pet.png", dataUrl: "data:image/png;base64,AA==" }),
        generate: async () => ({ status: "error", message: "provider rejected the retry" }),
        onProgress() { return () => {}; },
      },
    };

    const parent = makeRoot();
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
    findByText(parent, "button", "studioPickImage").dispatch("click");
    await tick(10);
    parent.querySelector(".studio-action-btn").dispatch("click");
    await tick(10);

    const card = parent.querySelector(".studio-action-card");
    assert.strictEqual(card.querySelector(".studio-badge").textContent, "studioStatusFailed");
    assert.strictEqual(card.querySelector(".studio-action-btn").textContent, "studioRegenerate");
    assert.ok(card.querySelector(".studio-action-preview-animation"));
    assert.strictEqual(card.querySelector(".studio-action-error").textContent, "provider rejected the retry");
  });

  it("shows completed action count beside one-click generation", async () => {
    globalThis.window = {
      studioAPI: {
        getConfig: async () => ({ baseUrl: "https://api.example.com", model: "gpt-image-2", hasKey: true }),
        getActions: async () => FAKE_ACTIONS,
        getActionStatuses: async () => ([{
          actionId: "yawn",
          stage: "written",
          previewUrl: "file:///C:/yawn.png",
          previewFrameUrls: ["file:///C:/yawn.png"],
        }]),
        onProgress() { return () => {}; },
      },
    };

    const parent = makeRoot();
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

    assert.ok(findByText(parent, "span", "1/2 studioStatusDone"));
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

    const parent = makeRoot();
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

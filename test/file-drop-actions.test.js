"use strict";

const test = require("node:test");
const assert = require("node:assert");

const {
  buildFileDropPrompt,
  buildFileDropState,
  executeFileDropAction,
  normalizeDroppedFiles,
} = require("../src/file-drop-actions");

function fakeFs(kinds) {
  return {
    statSync(filePath) {
      if (!Object.prototype.hasOwnProperty.call(kinds, filePath)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      const kind = kinds[filePath];
      return {
        isDirectory: () => kind === "folder",
        isFile: () => kind === "file",
      };
    },
  };
}

test("normalizes dropped file and folder paths with bounded, existing entries", () => {
  const files = normalizeDroppedFiles({
    paths: [
      "F:\\agentic\\repo\\src\\app.js",
      "F:\\agentic\\repo",
      "F:\\agentic\\repo\\src\\app.js",
      "",
      "F:\\missing.txt",
    ],
  }, {
    fs: fakeFs({
      "F:\\agentic\\repo\\src\\app.js": "file",
      "F:\\agentic\\repo": "folder",
    }),
  });

  assert.deepStrictEqual(files, [
    { path: "F:\\agentic\\repo\\src\\app.js", name: "app.js", kind: "file" },
    { path: "F:\\agentic\\repo", name: "repo", kind: "folder" },
  ]);
});

test("builds a safe prompt that references paths instead of copying file contents", () => {
  const prompt = buildFileDropPrompt([
    { path: "F:\\agentic\\repo\\src\\app.js", name: "app.js", kind: "file" },
    { path: "F:\\agentic\\repo", name: "repo", kind: "folder" },
  ], { lang: "zh" });

  assert.match(prompt, /请把下面路径作为上下文/);
  assert.match(prompt, /F:\\agentic\\repo\\src\\app\.js/);
  assert.match(prompt, /F:\\agentic\\repo/);
  assert.match(prompt, /不要假设已经读取了完整目录内容/);
});

test("builds action bubble state for current session and default-agent folder launch", () => {
  const state = buildFileDropState({
    paths: ["F:\\agentic\\repo\\src\\app.js", "F:\\agentic\\repo"],
  }, {
    fs: fakeFs({
      "F:\\agentic\\repo\\src\\app.js": "file",
      "F:\\agentic\\repo": "folder",
    }),
    lang: "zh",
    focusableSessionIds: ["session-1"],
    petClickActionEnabled: true,
  });

  assert.strictEqual(state.items.length, 2);
  assert.strictEqual(state.primaryFolderPath, "F:\\agentic\\repo");
  assert.deepStrictEqual(
    state.bubble.actions.map((action) => action.id),
    ["copy-focus-session", "open-folder-agent", "copy-prompt", "cancel"]
  );
  assert.match(state.bubble.title, /接住/);
  assert.match(state.bubble.message, /2 个项目/);
});

test("executes file drop actions through clipboard, focus, dashboard, and default launcher", () => {
  const calls = [];
  const dropState = {
    prompt: "PROMPT",
    focusableSessionIds: ["session-1"],
    primaryFolderPath: "F:\\agentic\\repo",
  };

  assert.deepStrictEqual(executeFileDropAction("copy-focus-session", dropState, {
    clipboard: { writeText: (text) => calls.push(["clipboard", text]) },
    focusSession: (id, options) => calls.push(["focusSession", id, options]),
    showDashboard: () => calls.push(["showDashboard"]),
    launchPetClickAction: (workspacePath) => calls.push(["launchPetClickAction", workspacePath]),
  }), { status: "ok", action: "copy-focus-session" });

  assert.deepStrictEqual(executeFileDropAction("open-folder-agent", dropState, {
    clipboard: { writeText: (text) => calls.push(["clipboard", text]) },
    focusSession: (id, options) => calls.push(["focusSession", id, options]),
    showDashboard: () => calls.push(["showDashboard"]),
    launchPetClickAction: (workspacePath) => calls.push(["launchPetClickAction", workspacePath]),
  }), { status: "ok", action: "open-folder-agent" });

  assert.deepStrictEqual(calls, [
    ["clipboard", "PROMPT"],
    ["focusSession", "session-1", { requestSource: "file-drop" }],
    ["launchPetClickAction", "F:\\agentic\\repo"],
  ]);
});

test("copy-focus-session opens the dashboard when multiple sessions are focusable", () => {
  const calls = [];
  executeFileDropAction("copy-focus-session", {
    prompt: "PROMPT",
    focusableSessionIds: ["s1", "s2"],
  }, {
    clipboard: { writeText: (text) => calls.push(["clipboard", text]) },
    focusSession: (id) => calls.push(["focusSession", id]),
    showDashboard: () => calls.push(["showDashboard"]),
    launchPetClickAction: () => calls.push(["launchPetClickAction"]),
  });

  assert.deepStrictEqual(calls, [
    ["clipboard", "PROMPT"],
    ["showDashboard"],
  ]);
});

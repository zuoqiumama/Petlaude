"use strict";

const defaultFs = require("node:fs");
const defaultPath = require("node:path");

const MAX_DROPPED_ITEMS = 20;
const MAX_PATH_LENGTH = 4096;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeLang(lang) {
  const text = typeof lang === "string" ? lang.toLowerCase() : "";
  if (text.startsWith("zh")) return "zh";
  return "en";
}

function sanitizeDroppedPaths(payload) {
  const source = isPlainObject(payload) && Array.isArray(payload.paths) ? payload.paths : [];
  const paths = [];
  const seen = new Set();
  for (const raw of source) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || value.length > MAX_PATH_LENGTH) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    paths.push(value);
    if (paths.length >= MAX_DROPPED_ITEMS) break;
  }
  return paths;
}

function getPathKind(filePath, fs) {
  try {
    const stat = fs.statSync(filePath);
    if (stat && typeof stat.isDirectory === "function" && stat.isDirectory()) return "folder";
    if (stat && typeof stat.isFile === "function" && stat.isFile()) return "file";
  } catch {}
  return null;
}

function normalizeDroppedFiles(payload, options = {}) {
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const files = [];
  for (const filePath of sanitizeDroppedPaths(payload)) {
    const kind = getPathKind(filePath, fs);
    if (!kind) continue;
    files.push({
      path: filePath,
      name: path.basename(filePath) || filePath,
      kind,
    });
  }
  return files;
}

function buildFileDropPrompt(items, options = {}) {
  const lang = normalizeLang(options.lang);
  const list = Array.isArray(items) ? items : [];
  if (lang === "zh") {
    const lines = [
      "请把下面路径作为上下文，先阅读/检查它们，再根据我的下一步要求继续工作。",
      "",
      ...list.map((item) => `- ${item.kind === "folder" ? "目录" : "文件"}：${item.path}`),
    ];
    if (list.some((item) => item.kind === "folder")) {
      lines.push("", "如果是目录，请先查看项目结构，再说明你准备读取哪些关键文件。不要假设已经读取了完整目录内容。");
    }
    return lines.join("\n");
  }

  const lines = [
    "Use the following paths as context. Inspect/read them first, then continue with my next request.",
    "",
    ...list.map((item) => `- ${item.kind === "folder" ? "Folder" : "File"}: ${item.path}`),
  ];
  if (list.some((item) => item.kind === "folder")) {
    lines.push("", "For folders, inspect the project structure first and state which key files you plan to read. Do not assume the full directory has already been read.");
  }
  return lines.join("\n");
}

function summarizeItems(items, lang) {
  const normalizedLang = normalizeLang(lang);
  const list = Array.isArray(items) ? items : [];
  const count = list.length;
  if (count === 0) {
    return normalizedLang === "zh" ? "没有可用的本地路径" : "No usable local paths";
  }
  const firstNames = list.slice(0, 2).map((item) => item.name).join(", ");
  const suffix = count > 2 ? (normalizedLang === "zh" ? ` 等 ${count} 个项目` : ` and ${count - 2} more`) : "";
  if (normalizedLang === "zh") return `${count} 个项目：${firstNames}${suffix}`;
  return `${count} item${count === 1 ? "" : "s"}: ${firstNames}${suffix}`;
}

function buildActions({ focusableSessionIds, primaryFolderPath, petClickActionEnabled, lang }) {
  const zh = normalizeLang(lang) === "zh";
  const sessionCount = Array.isArray(focusableSessionIds) ? focusableSessionIds.length : 0;
  const actions = [];

  if (sessionCount > 0) {
    actions.push({
      id: "copy-focus-session",
      label: sessionCount === 1
        ? (zh ? "复制并聚焦会话" : "Copy and focus")
        : (zh ? "复制并选择会话" : "Copy and choose"),
      variant: "primary",
    });
  } else {
    actions.push({
      id: "copy-prompt",
      label: zh ? "复制 prompt" : "Copy prompt",
      variant: "primary",
    });
  }

  if (primaryFolderPath && petClickActionEnabled) {
    actions.push({
      id: "open-folder-agent",
      label: zh ? "用默认 agent 打开" : "Open with agent",
      variant: "secondary",
    });
  }

  if (actions[0] && actions[0].id !== "copy-prompt") {
    actions.push({
      id: "copy-prompt",
      label: zh ? "只复制 prompt" : "Copy only",
      variant: "secondary",
    });
  }

  actions.push({ id: "cancel", label: zh ? "取消" : "Cancel", variant: "secondary" });
  return actions;
}

function buildFileDropState(payload, options = {}) {
  const lang = normalizeLang(options.lang);
  const items = normalizeDroppedFiles(payload, options);
  const focusableSessionIds = Array.isArray(options.focusableSessionIds)
    ? options.focusableSessionIds.map(String).filter(Boolean)
    : [];
  const primaryFolder = items.find((item) => item.kind === "folder");
  const primaryFolderPath = primaryFolder ? primaryFolder.path : null;
  const prompt = buildFileDropPrompt(items, { lang });
  const title = lang === "zh" ? "Clawd 接住了文件" : "Clawd caught your drop";
  const message = summarizeItems(items, lang);
  return {
    items,
    focusableSessionIds,
    primaryFolderPath,
    prompt,
    bubble: {
      mode: items.length ? "file-drop" : "error",
      title,
      message,
      detail: prompt,
      actions: items.length
        ? buildActions({
          focusableSessionIds,
          primaryFolderPath,
          petClickActionEnabled: !!options.petClickActionEnabled,
          lang,
        })
        : [{ id: "cancel", label: lang === "zh" ? "关闭" : "Close", variant: "primary" }],
      defaultAction: "cancel",
      requireAction: true,
    },
  };
}

function executeFileDropAction(actionId, dropState, ctx = {}) {
  const action = typeof actionId === "string" ? actionId : "cancel";
  const state = isPlainObject(dropState) ? dropState : {};
  const prompt = typeof state.prompt === "string" ? state.prompt : "";
  const focusableIds = Array.isArray(state.focusableSessionIds) ? state.focusableSessionIds : [];

  if (action === "cancel") return { status: "ok", action };

  if (action === "copy-prompt" || action === "copy-focus-session") {
    if (ctx.clipboard && typeof ctx.clipboard.writeText === "function") {
      ctx.clipboard.writeText(prompt);
    }
    if (action === "copy-focus-session") {
      if (focusableIds.length === 1 && typeof ctx.focusSession === "function") {
        ctx.focusSession(focusableIds[0], { requestSource: "file-drop" });
      } else if (focusableIds.length > 1 && typeof ctx.showDashboard === "function") {
        ctx.showDashboard();
      }
    }
    return { status: "ok", action };
  }

  if (action === "open-folder-agent") {
    if (!state.primaryFolderPath) return { status: "skipped", action, reason: "missing-folder" };
    if (typeof ctx.launchPetClickAction !== "function") {
      return { status: "skipped", action, reason: "missing-launcher" };
    }
    ctx.launchPetClickAction(state.primaryFolderPath);
    return { status: "ok", action };
  }

  return { status: "skipped", action, reason: "unknown-action" };
}

module.exports = {
  buildFileDropPrompt,
  buildFileDropState,
  executeFileDropAction,
  normalizeDroppedFiles,
  sanitizeDroppedPaths,
};

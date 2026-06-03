"use strict";

const { BrowserWindow } = require("electron");
const path = require("node:path");
const { keepOutOfTaskbar } = require("./taskbar");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
const WIDTH = 340;
const EDGE_MARGIN = 8;
const GAP = 6;
const DEFAULT_HEIGHT = 188;

function requiredDependency(value, name, owner) {
  if (!value) throw new Error(`${owner} requires ${name}`);
  return value;
}

function registerFileDropBubbleIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain", "registerFileDropBubbleIpc");
  const fileDropBubble = requiredDependency(options.fileDropBubble, "fileDropBubble", "registerFileDropBubbleIpc");
  requiredDependency(fileDropBubble.handleFileDropBubbleHeight, "fileDropBubble.handleFileDropBubbleHeight", "registerFileDropBubbleIpc");
  requiredDependency(fileDropBubble.handleFileDropBubbleAction, "fileDropBubble.handleFileDropBubbleAction", "registerFileDropBubbleIpc");
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("file-drop-bubble-height", (event, height) => fileDropBubble.handleFileDropBubbleHeight(event, height));
  on("file-drop-bubble-action", (event, actionId) => fileDropBubble.handleFileDropBubbleAction(event, actionId));

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

function computeFileDropBubbleBounds({
  width = WIDTH,
  edgeMargin = EDGE_MARGIN,
  gap = GAP,
  height = DEFAULT_HEIGHT,
  hudReservedOffset = 0,
  workArea,
  hitRect,
}) {
  const wa = workArea || { x: 0, y: 0, width: 1280, height: 800 };
  const rect = hitRect || {
    left: wa.x + wa.width - width - edgeMargin,
    right: wa.x + wa.width - edgeMargin,
    top: wa.y + wa.height - height - edgeMargin,
    bottom: wa.y + wa.height - edgeMargin,
  };
  const maxX = wa.x + wa.width - width - edgeMargin;
  const maxY = wa.y + wa.height - height - edgeMargin;
  const spaceRight = wa.x + wa.width - rect.right;
  const spaceLeft = rect.left - wa.x;
  let x;
  if (spaceRight >= width || spaceRight >= spaceLeft) {
    x = Math.min(rect.right + gap, maxX);
  } else {
    x = Math.max(wa.x + edgeMargin, rect.left - gap - width);
  }
  const centerY = Math.round((rect.top + rect.bottom) / 2);
  const reserve = Math.max(0, Number(hudReservedOffset) || 0);
  const y = Math.max(wa.y + edgeMargin, Math.min(centerY - Math.round(height / 2) + reserve, maxY));
  return { x, y, width, height };
}

function initFileDropBubble(ctx) {
  let bubble = null;
  let measuredHeight = 0;
  let activePayload = null;
  let resolveAction = null;

  function ensureBubble() {
    if (bubble && !bubble.isDestroyed()) return bubble;

    bubble = new BrowserWindow({
      width: WIDTH,
      height: measuredHeight || DEFAULT_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: !isMac,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-file-drop-bubble.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (isWin) bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(bubble);

    bubble.loadFile(path.join(__dirname, "file-drop-bubble.html"));
    bubble.on("closed", () => {
      bubble = null;
      measuredHeight = 0;
      settle(activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : "cancel", "closed");
    });
    bubble.webContents.once("did-finish-load", () => {
      if (activePayload) bubble.webContents.send("file-drop-bubble-show", activePayload);
    });
    return bubble;
  }

  function settle(action, source = "user") {
    if (!resolveAction) return;
    const resolver = resolveAction;
    resolveAction = null;
    resolver({ action, source });
  }

  function computeBounds() {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = ctx.getPetWindowBounds();
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = ctx.getNearestWorkArea(cx, cy);
    const hitRect = typeof ctx.getHitRectScreen === "function" ? ctx.getHitRectScreen(petBounds) : null;
    return computeFileDropBubbleBounds({
      width: WIDTH,
      height: measuredHeight || DEFAULT_HEIGHT,
      workArea,
      hitRect,
      hudReservedOffset: typeof ctx.getHudReservedOffset === "function" ? ctx.getHudReservedOffset() : 0,
    });
  }

  function repositionFileDropBubble() {
    if (!bubble || bubble.isDestroyed()) return;
    const bounds = computeBounds();
    if (bounds) bubble.setBounds(bounds);
  }

  function syncVisibility() {
    if (!bubble || bubble.isDestroyed()) return;
    if (ctx.petHidden) {
      bubble.hide();
      return;
    }
    bubble.showInactive();
    keepOutOfTaskbar(bubble);
    if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }

  function showFileDropBubble(payload) {
    if (resolveAction) settle(activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : "cancel", "closed");
    activePayload = payload || {};
    const win = ensureBubble();

    const send = () => {
      measuredHeight = 0;
      repositionFileDropBubble();
      if (!win.isDestroyed()) {
        win.webContents.send("file-drop-bubble-show", activePayload);
        syncVisibility();
      }
    };

    if (win.webContents.isLoading()) {
      win.webContents.once("did-finish-load", send);
    } else {
      send();
    }

    return new Promise((resolve) => {
      resolveAction = resolve;
    });
  }

  function hideFileDropBubble() {
    if (!bubble || bubble.isDestroyed()) return;
    bubble.webContents.send("file-drop-bubble-hide");
    setTimeout(() => {
      if (bubble && !bubble.isDestroyed()) bubble.hide();
    }, 180);
  }

  function handleFileDropBubbleAction(event, actionId) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return;
    hideFileDropBubble();
    settle(actionId || "cancel", "user");
  }

  function handleFileDropBubbleHeight(event, height) {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!bubble || senderWin !== bubble) return;
    const next = Math.ceil(Number(height));
    if (Number.isFinite(next) && next > 0) {
      measuredHeight = next;
      repositionFileDropBubble();
    }
  }

  function cleanup() {
    settle(activePayload && activePayload.defaultAction != null ? activePayload.defaultAction : "cancel", "closed");
    if (bubble && !bubble.isDestroyed()) bubble.destroy();
    bubble = null;
  }

  return {
    showFileDropBubble,
    hideFileDropBubble,
    repositionFileDropBubble,
    syncVisibility,
    handleFileDropBubbleAction,
    handleFileDropBubbleHeight,
    cleanup,
    getBubbleWindow: () => bubble,
  };
}

module.exports = initFileDropBubble;
module.exports.registerFileDropBubbleIpc = registerFileDropBubbleIpc;
module.exports.__test = {
  computeFileDropBubbleBounds,
};

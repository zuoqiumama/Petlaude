"use strict";

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerPetInteractionIpc requires ${name}`);
  return value;
}

function clampUnit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function sanitizeFileDragDirection(value) {
  return value === "left" || value === "right" || value === "center" ? value : "center";
}

function sanitizeFileDragPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  return {
    x: clampUnit(source.x),
    y: clampUnit(source.y),
    direction: sanitizeFileDragDirection(source.direction),
  };
}

function sanitizeFileDragEndReason(reason) {
  return reason === "drop" || reason === "leave" || reason === "cancel" ? reason : "cancel";
}

function sanitizeDroppedFilesPayload(payload) {
  const source = payload && typeof payload === "object" && Array.isArray(payload.paths) ? payload.paths : [];
  const paths = [];
  for (const raw of source) {
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (!value || value.length > 4096) continue;
    paths.push(value);
    if (paths.length >= 20) break;
  }
  return { paths };
}

function registerPetInteractionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const showContextMenu = requiredDependency(options.showContextMenu, "showContextMenu");
  const moveWindowForDrag = requiredDependency(options.moveWindowForDrag, "moveWindowForDrag");
  const setIdlePaused = requiredDependency(options.setIdlePaused, "setIdlePaused");
  const isMiniTransitioning = requiredDependency(options.isMiniTransitioning, "isMiniTransitioning");
  const getCurrentState = requiredDependency(options.getCurrentState, "getCurrentState");
  const getCurrentSvg = requiredDependency(options.getCurrentSvg, "getCurrentSvg");
  const sendToRenderer = requiredDependency(options.sendToRenderer, "sendToRenderer");
  const setDragLocked = requiredDependency(options.setDragLocked, "setDragLocked");
  const setMouseOverPet = requiredDependency(options.setMouseOverPet, "setMouseOverPet");
  const setPetHover = requiredDependency(options.setPetHover, "setPetHover");
  const beginDragSnapshot = requiredDependency(options.beginDragSnapshot, "beginDragSnapshot");
  const clearDragSnapshot = requiredDependency(options.clearDragSnapshot, "clearDragSnapshot");
  const syncHitWin = requiredDependency(options.syncHitWin, "syncHitWin");
  const isMiniMode = requiredDependency(options.isMiniMode, "isMiniMode");
  const checkMiniModeSnap = requiredDependency(options.checkMiniModeSnap, "checkMiniModeSnap");
  const hasPetWindow = requiredDependency(options.hasPetWindow, "hasPetWindow");
  const getPetWindowBounds = requiredDependency(options.getPetWindowBounds, "getPetWindowBounds");
  const getKeepSizeAcrossDisplays = requiredDependency(
    options.getKeepSizeAcrossDisplays,
    "getKeepSizeAcrossDisplays"
  );
  const getCurrentPixelSize = requiredDependency(options.getCurrentPixelSize, "getCurrentPixelSize");
  const computeDragEndBounds = requiredDependency(options.computeDragEndBounds, "computeDragEndBounds");
  const applyPetWindowBounds = requiredDependency(options.applyPetWindowBounds, "applyPetWindowBounds");
  const reassertWinTopmost = requiredDependency(options.reassertWinTopmost, "reassertWinTopmost");
  const scheduleHwndRecovery = requiredDependency(options.scheduleHwndRecovery, "scheduleHwndRecovery");
  const repositionFloatingBubbles = requiredDependency(
    options.repositionFloatingBubbles,
    "repositionFloatingBubbles"
  );
  const exitMiniMode = requiredDependency(options.exitMiniMode, "exitMiniMode");
  const getFocusableLocalHudSessionIds = requiredDependency(
    options.getFocusableLocalHudSessionIds,
    "getFocusableLocalHudSessionIds"
  );
  const focusLog = requiredDependency(options.focusLog, "focusLog");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const revealSessionHud = requiredDependency(options.revealSessionHud, "revealSessionHud");
  const launchPetClickAction = requiredDependency(options.launchPetClickAction, "launchPetClickAction");
  const handleDroppedFiles = requiredDependency(options.handleDroppedFiles, "handleDroppedFiles");
  const setLowPowerIdlePaused = requiredDependency(
    options.setLowPowerIdlePaused,
    "setLowPowerIdlePaused"
  );
  const disposers = [];

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  on("show-context-menu", showContextMenu);
  on("drag-move", () => moveWindowForDrag());

  on("pause-cursor-polling", () => {
    setIdlePaused(true);
  });
  on("resume-from-reaction", () => {
    setIdlePaused(false);
    if (isMiniTransitioning()) return;
    sendToRenderer("state-change", getCurrentState(), getCurrentSvg());
  });
  on("low-power-idle-paused", (_event, paused) => {
    setLowPowerIdlePaused(!!paused);
  });

  on("pet-hover", (_event, hovered) => {
    setPetHover(!!hovered);
  });

  on("drag-lock", (_event, locked) => {
    setDragLocked(!!locked);
    if (locked) {
      setMouseOverPet(true);
      setPetHover(false);
      beginDragSnapshot();
    } else {
      clearDragSnapshot();
      syncHitWin();
    }
  });

  on("start-drag-reaction", () => sendToRenderer("start-drag-reaction"));
  on("end-drag-reaction", () => sendToRenderer("end-drag-reaction"));
  on("play-click-reaction", (_event, svg, duration) => {
    sendToRenderer("play-click-reaction", svg, duration);
  });
  on("file-drag-catch-start", (_event, payload) => {
    sendToRenderer("file-drag-catch-start", sanitizeFileDragPayload(payload));
  });
  on("file-drag-catch-update", (_event, payload) => {
    sendToRenderer("file-drag-catch-update", sanitizeFileDragPayload(payload));
  });
  on("file-drag-catch-end", (_event, reason) => {
    sendToRenderer("file-drag-catch-end", sanitizeFileDragEndReason(reason));
  });
  on("file-drop", (_event, payload) => {
    handleDroppedFiles(sanitizeDroppedFilesPayload(payload));
  });

  on("drag-end", () => {
    try {
      if (!isMiniMode() && !isMiniTransitioning()) {
        checkMiniModeSnap();
        if (isMiniMode() || isMiniTransitioning()) return;
        if (hasPetWindow()) {
          const virtualBounds = getPetWindowBounds();
          const size = getKeepSizeAcrossDisplays()
            ? { width: virtualBounds.width, height: virtualBounds.height }
            : getCurrentPixelSize();
          const clamped = computeDragEndBounds(virtualBounds, size);
          if (clamped) applyPetWindowBounds(clamped);
          reassertWinTopmost();
          scheduleHwndRecovery();
          syncHitWin();
          repositionFloatingBubbles();
        }
      }
    } finally {
      setDragLocked(false);
      clearDragSnapshot();
    }
  });

  on("exit-mini-mode", () => {
    if (isMiniMode()) exitMiniMode();
  });

  on("pet-interaction:reveal-session-hud", () => {
    revealSessionHud();
  });

  on("pet-interaction:launch-click-action", () => {
    launchPetClickAction();
  });

  on("focus-terminal", () => {
    const focusableIds = getFocusableLocalHudSessionIds();
    focusLog(`focus request source=pet-body sid=- focusableCount=${focusableIds.length}`);
    if (focusableIds.length > 1) {
      focusLog(`focus result branch=none reason=multi-session-open-dashboard count=${focusableIds.length}`);
      showDashboard();
      return;
    }
    if (focusableIds.length === 1) {
      focusSession(focusableIds[0], { requestSource: "pet-body" });
      return;
    }
    focusLog("focus result branch=none reason=no-focusable-session source=pet-body");
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  registerPetInteractionIpc,
  sanitizeDroppedFilesPayload,
};

"use strict";

const noop = () => {};

function isLiveWindow(win) {
  return !!(win && (typeof win.isDestroyed !== "function" || !win.isDestroyed()));
}

function getPendingList(getPendingPermissions) {
  const pending = getPendingPermissions();
  return Array.isArray(pending) ? pending : [];
}

function createFloatingWindowRuntime(options = {}) {
  const getPendingPermissions = options.getPendingPermissions || (() => []);
  const keepOutOfTaskbar = options.keepOutOfTaskbar || noop;
  const repositionPermissionBubbles = options.repositionPermissionBubbles || noop;
  const repositionUpdateBubble = options.repositionUpdateBubble || noop;
  const repositionFileDropBubble = options.repositionFileDropBubble || noop;
  const repositionSessionHud = options.repositionSessionHud || noop;
  const repositionUsageHover = options.repositionUsageHover || noop;
  const syncSessionHudVisibility = options.syncSessionHudVisibility || noop;
  const syncUsageHoverVisibility = options.syncUsageHoverVisibility || noop;
  const syncUpdateBubbleVisibility = options.syncUpdateBubbleVisibility || noop;
  const syncFileDropBubbleVisibility = options.syncFileDropBubbleVisibility || noop;
  const hideUpdateBubble = options.hideUpdateBubble || noop;
  const hideFileDropBubble = options.hideFileDropBubble || noop;
  const hideUsageHover = options.hideUsageHover || noop;

  function repositionFloatingBubbles() {
    if (getPendingList(getPendingPermissions).length) repositionPermissionBubbles();
    repositionUpdateBubble();
    repositionFileDropBubble();
  }

  function repositionAnchoredSurfaces() {
    repositionSessionHud();
    repositionUsageHover();
    repositionFloatingBubbles();
  }

  function syncSessionHudVisibilityAndBubbles() {
    syncSessionHudVisibility();
    syncUsageHoverVisibility();
    repositionFloatingBubbles();
  }

  function showFloatingSurfacesForPet() {
    for (const perm of getPendingList(getPendingPermissions)) {
      const bubble = perm && perm.bubble;
      if (isLiveWindow(bubble) && typeof bubble.showInactive === "function") {
        bubble.showInactive();
        keepOutOfTaskbar(bubble);
      }
    }
    syncUsageHoverVisibility();
    syncUpdateBubbleVisibility();
    syncFileDropBubbleVisibility();
  }

  function hideFloatingSurfacesForPet() {
    for (const perm of getPendingList(getPendingPermissions)) {
      const bubble = perm && perm.bubble;
      if (isLiveWindow(bubble) && typeof bubble.hide === "function") {
        bubble.hide();
      }
    }
    hideUsageHover();
    hideUpdateBubble();
    hideFileDropBubble();
  }

  return {
    repositionFloatingBubbles,
    repositionAnchoredSurfaces,
    syncSessionHudVisibilityAndBubbles,
    showFloatingSurfacesForPet,
    hideFloatingSurfacesForPet,
  };
}

module.exports = createFloatingWindowRuntime;

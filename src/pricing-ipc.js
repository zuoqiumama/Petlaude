"use strict";

// Thin IPC bridge for the pricing auto-fetch Settings UI. Pure wiring: pulls
// status from the updater and triggers a manual refresh. The on/off toggle goes
// through the standard settings:update path (settings-controller is the sole
// pref writer), so there is no enable/disable channel here.
function registerPricingIpc({ ipcMain, updater }) {
  ipcMain.handle("pricing:get-status", () => updater.getStatus());
  ipcMain.handle("pricing:refresh-now", () => updater.refreshNow());
}

module.exports = { registerPricingIpc };

"use strict";

// Thin IPC bridge for the pricing auto-fetch Settings UI. Pure wiring: pulls
// status from the updater, triggers manual refresh, and routes enable/disable
// through the settings controller (the sole pref writer).
function registerPricingIpc({ ipcMain, updater, setEnabled }) {
  ipcMain.handle("pricing:get-status", () => updater.getStatus());
  ipcMain.handle("pricing:refresh-now", () => updater.refreshNow());
  ipcMain.handle("pricing:set-enabled", (_evt, enabled) => {
    setEnabled(Boolean(enabled));
    return updater.getStatus();
  });
}

module.exports = { registerPricingIpc };

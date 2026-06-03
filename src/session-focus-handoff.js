"use strict";

function sanitizeFocusError(err) {
  return err && err.message ? err.message.replace(/[\r\n\t]+/g, " ") : "unknown";
}

function focusCodexThreadTarget({
  shell,
  focusEntry,
  sessionId,
  requestSource = "dashboard",
  url,
  platform = process.platform,
  focusLog = () => {},
  focusTerminalSession = () => false,
}) {
  if (!url) return null;
  const id = String(sessionId || (focusEntry && focusEntry.id) || "");
  focusLog(`focus request source=${requestSource} sid=${id} agent=${(focusEntry && focusEntry.agentId) || "-"} target=codex-thread`);
  if (platform === "win32") {
    if (focusTerminalSession(focusEntry, id, requestSource)) {
      focusLog(`focus result branch=codex-thread reason=windows-terminal-fallback source=${requestSource} sid=${id}`);
    } else {
      focusLog(`focus result branch=none reason=windows-deeplink-disabled-no-source-pid source=${requestSource} sid=${id}`);
    }
    return Promise.resolve();
  }
  if (!shell || typeof shell.openExternal !== "function") return null;
  return shell.openExternal(url)
    .then(() => {
      focusLog(`focus result branch=codex-thread reason=opened source=${requestSource} sid=${id}`);
    })
    .catch((err) => {
      focusLog(`focus result branch=codex-thread reason=open-failed source=${requestSource} sid=${id} error=${sanitizeFocusError(err)}`);
      if (!focusTerminalSession(focusEntry, id, requestSource)) {
        focusLog(`focus result branch=none reason=codex-thread-fallback-no-source-pid source=${requestSource} sid=${id}`);
      }
    });
}

module.exports = {
  focusCodexThreadTarget,
  sanitizeFocusError,
};

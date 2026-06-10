// --- Input window: pointer capture, drag, click detection ---
// This is the "controller" — all input decisions happen here.
// Render window is pure "view" — receives reaction commands via IPC relay.

const area = document.getElementById("hit-area");

// ── Theme config (injected via preload-hit.js additionalArguments) ──
let tc = window.hitThemeConfig || {};
let _reactions = (tc && tc.reactions) || {};

// ── Platform (injected via preload-hit.js additionalArguments) ──
const isMac = !!(window.hitPlatform && window.hitPlatform.isMac);

// Theme switch: IPC push overrides additionalArguments
if (window.hitAPI && window.hitAPI.onThemeConfig) {
  window.hitAPI.onThemeConfig((cfg) => {
    tc = cfg || {};
    _reactions = (tc && tc.reactions) || {};
  });
}

// --- State synced from main ---
let currentSvg = null;
let currentState = null;
let miniMode = false;
let dndEnabled = false;
let petClickActionEnabled = false;

window.hitAPI.onStateSync((data) => {
  if (data.currentSvg !== undefined) currentSvg = data.currentSvg;
  if (data.currentState !== undefined) currentState = data.currentState;
  if (data.miniMode !== undefined) {
    miniMode = data.miniMode;
    area.style.cursor = miniMode ? "default" : "";
  }
  if (data.dndEnabled !== undefined) dndEnabled = data.dndEnabled;
  if (data.petClickActionEnabled !== undefined) petClickActionEnabled = !!data.petClickActionEnabled;
});

// --- Drag state ---
let isDragging = false;
let didDrag = false;
let mouseDownX, mouseDownY;
let dragMoveRAF = null;
const DRAG_THRESHOLD = 3;
let hoverInside = false;
let fileDragCatchActive = false;

// --- Reaction state (tracked here to gate input) ---
let isReacting = false;
let isDragReacting = false;

// Cancel signal from main (e.g. state change)
window.hitAPI.onCancelReaction(() => {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; clickCount = 0; firstClickDir = null; }
  isReacting = false;
  isDragReacting = false;
});

function queueDragMove() {
  if (dragMoveRAF !== null) return;
  dragMoveRAF = requestAnimationFrame(() => {
    dragMoveRAF = null;
    if (!isDragging) return;
    window.hitAPI.dragMove();
  });
}

function clearQueuedDragMove() {
  if (dragMoveRAF === null) return;
  cancelAnimationFrame(dragMoveRAF);
  dragMoveRAF = null;
}

function setHoverInside(value) {
  const next = !!value;
  if (hoverInside === next) return;
  hoverInside = next;
  if (!isDragging || !next) {
    window.hitAPI.petHover(next);
  }
}

function hasFileDragPayload(e) {
  const dt = e && e.dataTransfer;
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  if (types.includes("Files")) return true;
  const items = Array.from(dt.items || []);
  if (items.some((item) => item && item.kind === "file")) return true;
  return !!(dt.files && dt.files.length > 0);
}

function canPlayFileDragCatch() {
  return !!_getReaction("fileDropCatch") && !miniMode && !dndEnabled && !isDragging;
}

function preventFileDragDefault(e) {
  if (!e) return;
  if (typeof e.preventDefault === "function") e.preventDefault();
  if (typeof e.stopPropagation === "function") e.stopPropagation();
  try {
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  } catch {}
}

function clampUnit(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function roundUnit(value) {
  return Math.round(clampUnit(value) * 100) / 100;
}

function buildFileDragCatchPayload(e) {
  const rect = area.getBoundingClientRect
    ? area.getBoundingClientRect()
    : { left: 0, top: 0, width: area.offsetWidth || 1, height: area.offsetHeight || 1 };
  const width = rect.width || area.offsetWidth || 1;
  const height = rect.height || area.offsetHeight || 1;
  const x = roundUnit((((e.clientX || 0) - rect.left) / width) * 2 - 1);
  const y = roundUnit((((e.clientY || 0) - rect.top) / height) * 2 - 1);
  const direction = x < -0.25 ? "left" : (x > 0.25 ? "right" : "center");
  return { x, y, direction };
}

function handleFileDragStartOrUpdate(e, phase) {
  if (!hasFileDragPayload(e) || !canPlayFileDragCatch()) return;
  preventFileDragDefault(e);
  const payload = buildFileDragCatchPayload(e);
  if (!fileDragCatchActive || phase === "start") {
    fileDragCatchActive = true;
    window.hitAPI.startFileDragCatch(payload);
    return;
  }
  window.hitAPI.updateFileDragCatch(payload);
}

function getDroppedFilePaths(e) {
  const dt = e && e.dataTransfer;
  const files = Array.from((dt && dt.files) || []);
  const paths = [];
  for (const file of files) {
    const filePath = file && typeof file.path === "string" ? file.path.trim() : "";
    if (filePath) paths.push(filePath);
  }
  return paths;
}

function endFileDragCatch(reason, e) {
  if (!fileDragCatchActive) return;
  if (e) preventFileDragDefault(e);
  fileDragCatchActive = false;
  window.hitAPI.endFileDragCatch(reason);
  if (reason === "drop" && typeof window.hitAPI.dropFiles === "function") {
    const paths = getDroppedFilePaths(e);
    if (paths.length) window.hitAPI.dropFiles({ paths });
  }
}

// --- Pointer handlers ---
area.addEventListener("pointerenter", () => setHoverInside(true));
area.addEventListener("pointerleave", () => setHoverInside(false));
area.addEventListener("dragenter", (e) => handleFileDragStartOrUpdate(e, "start"));
area.addEventListener("dragover", (e) => handleFileDragStartOrUpdate(e, "update"));
area.addEventListener("dragleave", (e) => endFileDragCatch("leave", e));
area.addEventListener("drop", (e) => endFileDragCatch("drop", e));

area.addEventListener("pointerdown", (e) => {
  if (e.button === 0) {
    if (miniMode) { didDrag = false; return; }
    area.setPointerCapture(e.pointerId);
    isDragging = true;
    didDrag = false;
    mouseDownX = e.clientX;
    mouseDownY = e.clientY;
    window.hitAPI.dragLock(true);
    window.hitAPI.petHover(false);
    area.classList.add("dragging");
  }
});

document.addEventListener("pointermove", (e) => {
  if (isDragging) {
    if (!didDrag) {
      const totalDx = e.clientX - mouseDownX;
      const totalDy = e.clientY - mouseDownY;
      if (Math.abs(totalDx) > DRAG_THRESHOLD || Math.abs(totalDy) > DRAG_THRESHOLD) {
        didDrag = true;
        startDragReaction();
      }
    }
    queueDragMove();
  }
});

function stopDrag() {
  if (!isDragging) return;
  clearQueuedDragMove();
  isDragging = false;
  window.hitAPI.dragLock(false);
  area.classList.remove("dragging");
  if (didDrag) {
    window.hitAPI.dragEnd();
  }
  endDragReaction();
  if (hoverInside) {
    window.hitAPI.petHover(true);
  }
}

document.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  const wasDrag = didDrag;
  stopDrag();
  if (wasDrag) return;

  // macOS Ctrl-click is the system right-click gesture. Let the OS / our
  // contextmenu handler deal with it; do NOT treat it as the Dashboard
  // shortcut, and do NOT fall through to handleClick (would otherwise
  // leak into the click accumulator).
  if (isMac && e.ctrlKey && !e.metaKey) {
    resetClickAccumulator();
    return;
  }

  // Dashboard shortcut: Cmd-click on mac, Ctrl-click elsewhere.
  const isDashboardShortcut = isMac ? e.metaKey : (e.ctrlKey && !e.metaKey);
  if (isDashboardShortcut) {
    resetClickAccumulator();
    window.hitAPI.showDashboard();
    return;
  }

  handleClick(e.clientX);
});

area.addEventListener("pointercancel", () => stopDrag());
area.addEventListener("lostpointercapture", () => { if (isDragging) stopDrag(); });
window.addEventListener("blur", stopDrag);

// --- Click reaction logic (2-click = poke, 4-click = flail) ---
const CLICK_WINDOW_MS = 400;

let clickCount = 0;
let clickTimer = null;
let firstClickDir = null;

function _getReaction(name) {
  return _reactions[name] || null;
}

function resetClickAccumulator() {
  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
  clickCount = 0;
  firstClickDir = null;
}

// Fresh-read at reaction timer fire time, NOT closured at click time —
// state / DND may change inside the 400 ms accumulator window.
function canPlayReactionNow() {
  return currentState === "idle" && !dndEnabled && !isReacting;
}

function handleClick(clientX) {
  if (miniMode) {
    window.hitAPI.exitMiniMode();
    return;
  }
  if (isDragReacting) return;

  clickCount++;
  if (clickCount === 1) {
    firstClickDir = clientX < area.offsetWidth / 2 ? "left" : "right";
    // First click reveals the session HUD. Lightweight side effect — NOT
    // gated by isReacting (HUD reveal is independent of pet animation).
    window.hitAPI.revealSessionHud();
  }

  if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }

  // Touch reaction (Context-Aware Companion): when the theme defines a
  // rapidClick (6+) tier, resolve ALL multi-click reactions on the debounce
  // window so 6 clicks are reachable. Themes without rapidClick keep the
  // original immediate-at-4 behavior below, byte-for-byte unchanged.
  if (_getReaction("rapidClick") && window.ClawdClickTiers) {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      const count = clickCount;
      const dir = firstClickDir;
      clickCount = 0;
      firstClickDir = null;
      // Match the legacy branch: the double-click action launches for 2-3
      // clicks (the >=4 flail tier never launched it).
      if (count >= 2 && count < 4 && petClickActionEnabled && typeof window.hitAPI.launchClickAction === "function") {
        window.hitAPI.launchClickAction();
      }
      if (!canPlayReactionNow()) return;
      const r = window.ClawdClickTiers.resolveClickReaction(count, _reactions, Math.random, dir);
      if (r && r.file) playReaction(r.file, r.duration);
    }, CLICK_WINDOW_MS);
    return;
  }

  const doubleReact = _getReaction("double");
  const annoyedReact = _getReaction("annoyed");
  const leftReact = _getReaction("clickLeft");
  const rightReact = _getReaction("clickRight");

  if (clickCount >= 4 && doubleReact) {
    clickCount = 0;
    firstClickDir = null;
    if (!canPlayReactionNow()) return;
    const files = doubleReact.files || [doubleReact.file];
    const file = files[Math.floor(Math.random() * files.length)];
    playReaction(file, doubleReact.duration || 3500);
  } else if (clickCount >= 2) {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      const dir = firstClickDir;
      firstClickDir = null;
      if (petClickActionEnabled && typeof window.hitAPI.launchClickAction === "function") {
        window.hitAPI.launchClickAction();
      }
      if (!canPlayReactionNow()) return;
      if (annoyedReact && Math.random() < 0.5) {
        playReaction(annoyedReact.file, annoyedReact.duration || 3500);
      } else if (leftReact && rightReact) {
        const react = dir === "left" ? leftReact : rightReact;
        playReaction(react.file, react.duration || 2500);
      }
    }, CLICK_WINDOW_MS);
  } else {
    clickTimer = setTimeout(() => {
      clickTimer = null;
      clickCount = 0;
      firstClickDir = null;
    }, CLICK_WINDOW_MS);
  }
}

function playReaction(svg, duration) {
  if (!svg) return;
  isReacting = true;
  window.hitAPI.playClickReaction(svg, duration);
  // Local timer to ungate input after duration
  setTimeout(() => { isReacting = false; }, duration);
}

// --- Drag reaction ---
function startDragReaction() {
  if (isDragReacting) return;
  if (dndEnabled) return;

  if (isReacting) {
    isReacting = false;
  }

  isDragReacting = true;
  window.hitAPI.startDragReaction();
}

function endDragReaction() {
  if (!isDragReacting) return;
  isDragReacting = false;
  window.hitAPI.endDragReaction();
  // Touch reaction: play a "shake-off" after being dropped, if the theme
  // defines reactions.dragRelease and the pet is in a state that allows it.
  if (window.ClawdClickTiers) {
    const r = window.ClawdClickTiers.resolveDragEndReaction(_reactions);
    if (r && r.file && canPlayReactionNow()) {
      playReaction(r.file, r.duration);
    }
  }
}

// --- Right-click context menu ---
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  window.hitAPI.showContextMenu();
});

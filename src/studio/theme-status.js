"use strict";

const fs = require("fs");
const path = require("path");

const { ACTIONS } = require("../companion/action-manifest");
const { getStateFiles } = require("../theme-schema");
const { getThemeReferenceFingerprint, hasCompleteActionAssets } = require("./generation-contract");

const STUDIO_AUTHOR = "Clawd AI Studio";

function entryUsesAsset(entry, assetFile) {
  return getStateFiles(entry).some((file) => path.basename(file) === assetFile);
}

function objectEntryUsesAsset(entry, assetFile) {
  return !!(
    entry
    && typeof entry === "object"
    && typeof entry.file === "string"
    && path.basename(entry.file) === assetFile
  );
}

function isActionBound(theme, action, assetFile) {
  if (action.category === "core" || action.category === "sleep") {
    const states = action.trigger && Array.isArray(action.trigger.states)
      ? action.trigger.states
      : [];
    return states.length > 0 && states.every((state) => entryUsesAsset(theme.states && theme.states[state], assetFile));
  }

  if (action.category === "mini") {
    const key = action.trigger && action.trigger.miniState;
    const miniStates = theme.miniMode && theme.miniMode.states;
    return !!key && entryUsesAsset(miniStates && miniStates[key], assetFile);
  }

  if (action.category === "idle-life") {
    const behaviors = theme.idleLife && Array.isArray(theme.idleLife.behaviors)
      ? theme.idleLife.behaviors
      : [];
    return behaviors.some((entry) => entry && entry.id === action.id && objectEntryUsesAsset(entry, assetFile));
  }

  if (action.category === "context") {
    const key = action.trigger && action.trigger.type;
    return !!key && objectEntryUsesAsset(theme.contextReactions && theme.contextReactions[key], assetFile);
  }

  if (action.category === "touch") {
    const key = action.trigger && action.trigger.reaction;
    return !!key && objectEntryUsesAsset(theme.touchReactions && theme.touchReactions[key], assetFile);
  }

  return false;
}

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getStudioThemeActionStatus(theme, themeDir) {
  if (!theme || theme.author !== STUDIO_AUTHOR) return null;

  const generatedActionIds = [];
  const missingActionIds = [];
  const referenceSha256 = getThemeReferenceFingerprint(themeDir);
  for (const action of ACTIONS) {
    const assetFile = `${action.id}.svg`;
    const assetPath = themeDir ? path.join(themeDir, "assets", assetFile) : "";
    if (isActionBound(theme, action, assetFile)
      && isRegularFile(assetPath)
      && hasCompleteActionAssets(themeDir, action, referenceSha256)) {
      generatedActionIds.push(action.id);
    } else {
      missingActionIds.push(action.id);
    }
  }

  return {
    complete: missingActionIds.length === 0,
    generatedActionCount: generatedActionIds.length,
    totalActionCount: ACTIONS.length,
    missingActionIds,
  };
}

module.exports = {
  STUDIO_AUTHOR,
  getStudioThemeActionStatus,
  isActionBound,
};

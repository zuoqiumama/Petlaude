"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const STUDIO_QUALITY_VERSION = 4;
const REFERENCE_FILE_NAMES = Object.freeze([
  "reference.png",
  "reference.jpg",
  "reference.jpeg",
  "reference.webp",
]);

function actionQualityFileName(actionId) {
  return `${actionId}.studio.json`;
}

function actionFrameFileNames(action) {
  return Array.from(
    { length: action.frames },
    (_, index) => `${action.id}-frame-${index + 1}.png`,
  );
}

function getThemeReferenceFingerprint(themeDir) {
  if (!themeDir) return null;
  const assetsDir = path.join(themeDir, "assets");
  for (const filename of REFERENCE_FILE_NAMES) {
    try {
      const bytes = fs.readFileSync(path.join(assetsDir, filename));
      if (bytes.length > 0) return crypto.createHash("sha256").update(bytes).digest("hex");
    } catch { /* try the next supported reference extension */ }
  }
  return null;
}

function hasCompleteActionAssets(themeDir, action, expectedReferenceSha256 = null) {
  if (!themeDir || !action) return false;
  const assetsDir = path.join(themeDir, "assets");
  try {
    const metadata = JSON.parse(fs.readFileSync(
      path.join(assetsDir, actionQualityFileName(action.id)),
      "utf8",
    ));
    const referenceSha256 = expectedReferenceSha256 || getThemeReferenceFingerprint(themeDir);
    if (
      metadata.qualityVersion !== STUDIO_QUALITY_VERSION
      || metadata.actionId !== action.id
      || metadata.frames !== action.frames
      || !referenceSha256
      || metadata.referenceSha256 !== referenceSha256
    ) return false;
    const files = [`${action.id}.svg`, ...actionFrameFileNames(action)];
    return files.every((filename) => {
      const stat = fs.statSync(path.join(assetsDir, filename));
      return stat.isFile() && stat.size > 0;
    });
  } catch {
    return false;
  }
}

module.exports = {
  STUDIO_QUALITY_VERSION,
  actionQualityFileName,
  actionFrameFileNames,
  getThemeReferenceFingerprint,
  hasCompleteActionAssets,
};

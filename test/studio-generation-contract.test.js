"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { getAction } = require("../src/companion/action-manifest");
const {
  STUDIO_QUALITY_VERSION,
  actionFrameFileNames,
  actionQualityFileName,
  hasCompleteActionAssets,
} = require("../src/studio/generation-contract");

function makeTheme(action, { includeFingerprint = true } = {}) {
  const themeDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-studio-contract-"));
  const assetsDir = path.join(themeDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const reference = Buffer.from("canonical-reference");
  fs.writeFileSync(path.join(assetsDir, "reference.png"), reference);
  fs.writeFileSync(path.join(assetsDir, `${action.id}.svg`), "<svg/>");
  for (const filename of actionFrameFileNames(action)) {
    fs.writeFileSync(path.join(assetsDir, filename), "png");
  }
  const metadata = {
    qualityVersion: STUDIO_QUALITY_VERSION,
    actionId: action.id,
    frames: action.frames,
  };
  if (includeFingerprint) {
    metadata.referenceSha256 = crypto.createHash("sha256").update(reference).digest("hex");
  }
  fs.writeFileSync(
    path.join(assetsDir, actionQualityFileName(action.id)),
    JSON.stringify(metadata),
  );
  return { themeDir, assetsDir };
}

describe("studio generation contract", () => {
  it("invalidates completed actions when the canonical reference changes", () => {
    const action = getAction("yawn");
    const { themeDir, assetsDir } = makeTheme(action);
    assert.strictEqual(hasCompleteActionAssets(themeDir, action), true);

    fs.writeFileSync(path.join(assetsDir, "reference.png"), "replacement-reference");

    assert.strictEqual(hasCompleteActionAssets(themeDir, action), false);
  });

  it("rejects legacy quality markers that are not bound to a reference", () => {
    const action = getAction("yawn");
    const { themeDir } = makeTheme(action, { includeFingerprint: false });
    assert.strictEqual(hasCompleteActionAssets(themeDir, action), false);
  });
});

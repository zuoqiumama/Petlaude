"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const {
  APP_ICON_PNG_SIZES,
  applyRoundedSquareAlpha,
  buildIcoPngContainer,
  createFlashBitmap,
  createTemplateBitmap,
  getDefaultExportTargets,
} = require("../scripts/export-app-icons");

describe("export app icons", () => {
  it("targets only app-owned icon assets", () => {
    const root = "D:\\clawd-on-desk";
    const targets = getDefaultExportTargets(root);
    const relativeTargets = targets.map((target) => path.relative(root, target.path));

    assert.deepStrictEqual(relativeTargets, [
      "assets\\icon.png",
      "assets\\tray-icon.png",
      "assets\\tray-icon-flash.png",
      "assets\\tray-iconTemplate.png",
      "assets\\tray-iconTemplate@2x.png",
      "assets\\icons\\16x16.png",
      "assets\\icons\\32x32.png",
      "assets\\icons\\48x48.png",
      "assets\\icons\\64x64.png",
      "assets\\icons\\128x128.png",
      "assets\\icons\\256x256.png",
      "assets\\icons\\512x512.png",
      "assets\\icon.ico",
    ]);
    assert.ok(
      relativeTargets.every((targetPath) => !targetPath.includes("assets\\icons\\agents\\")),
      "app icon export must not touch agent identity icons"
    );
  });

  it("wraps PNG representations in a valid ICO directory", () => {
    const png16 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 16]);
    const png256 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]);
    const ico = buildIcoPngContainer([
      { size: 16, png: png16 },
      { size: 256, png: png256 },
    ]);

    assert.strictEqual(ico.readUInt16LE(0), 0, "reserved field");
    assert.strictEqual(ico.readUInt16LE(2), 1, "ICO image type");
    assert.strictEqual(ico.readUInt16LE(4), 2, "image count");
    assert.strictEqual(ico[6], 16, "16px entry width");
    assert.strictEqual(ico[7], 16, "16px entry height");
    assert.strictEqual(ico[22], 0, "256px entry width is encoded as 0");
    assert.strictEqual(ico[23], 0, "256px entry height is encoded as 0");
    assert.deepStrictEqual(
      ico.subarray(6 + 16 * 2, 6 + 16 * 2 + png16.length),
      png16,
      "first PNG payload starts after the directory"
    );
  });

  it("keeps the expected Linux PNG size set sorted", () => {
    assert.deepStrictEqual(APP_ICON_PNG_SIZES, [16, 32, 48, 64, 128, 256, 512]);
  });

  it("creates raw tray bitmaps without relying on SVG rendering", () => {
    const template = createTemplateBitmap(16);
    const flash = createFlashBitmap(32);

    assert.strictEqual(template.width, 16);
    assert.strictEqual(template.height, 16);
    assert.strictEqual(template.buffer.length, 16 * 16 * 4);
    assert.strictEqual(flash.width, 32);
    assert.strictEqual(flash.height, 32);
    assert.strictEqual(flash.buffer.length, 32 * 32 * 4);
    assert.strictEqual(template.buffer[3], 0, "template corner remains transparent");
    assert.strictEqual(flash.buffer[3], 0, "flash corner remains transparent");
    assert.ok(
      countNonTransparentPixels(template.buffer) > 0,
      "template bitmap should contain a visible mask"
    );
    assert.ok(
      countNonTransparentPixels(flash.buffer) > 0,
      "flash bitmap should contain a visible notification shape"
    );
  });

  it("applies transparent alpha outside the rounded app icon shape", () => {
    const bitmap = {
      width: 16,
      height: 16,
      buffer: Buffer.alloc(16 * 16 * 4, 255),
    };

    applyRoundedSquareAlpha(bitmap, { radiusRatio: 0.25 });

    assert.strictEqual(bitmap.buffer[3], 0, "top-left corner should be transparent");
    assert.strictEqual(bitmap.buffer[((8 * 16 + 8) * 4) + 3], 255, "center should stay opaque");
    assert.strictEqual(bitmap.buffer[((0 * 16 + 8) * 4) + 3], 255, "top edge center should stay opaque");
    assert.strictEqual(bitmap.buffer[((8 * 16 + 0) * 4) + 3], 255, "left edge center should stay opaque");
  });
});

function countNonTransparentPixels(buffer) {
  let count = 0;
  for (let offset = 3; offset < buffer.length; offset += 4) {
    if (buffer[offset] > 0) count += 1;
  }
  return count;
}

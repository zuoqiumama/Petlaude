"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let app;
let nativeImage;
try {
  const electron = require("electron");
  if (electron && typeof electron === "object") {
    ({ app, nativeImage } = electron);
  }
} catch {}

const EXPORTER_ENV = "CLAWD_APP_ICON_EXPORTER";
const APP_ICON_PNG_SIZES = [16, 32, 48, 64, 128, 256, 512];
const ICO_PNG_SIZES = [16, 32, 48, 64, 128, 256];
const REPO_ROOT = path.join(__dirname, "..");
const DEFAULT_SOURCE = path.join(REPO_ROOT, "assets", "source", "app-icon", "app-icon-b2-source.png");
const APP_ICON_SOURCE_CROP_INSET_RATIO = 0.052;
const APP_ICON_CORNER_RADIUS_RATIO = 0.18;

function getDefaultExportTargets(root = REPO_ROOT) {
  return [
    { path: path.join(root, "assets", "icon.png"), kind: "png", size: 1024 },
    { path: path.join(root, "assets", "tray-icon.png"), kind: "png", size: 1024 },
    { path: path.join(root, "assets", "tray-icon-flash.png"), kind: "flash", size: 32 },
    { path: path.join(root, "assets", "tray-iconTemplate.png"), kind: "template", size: 16 },
    { path: path.join(root, "assets", "tray-iconTemplate@2x.png"), kind: "template", size: 32 },
    ...APP_ICON_PNG_SIZES.map((size) => ({
      path: path.join(root, "assets", "icons", `${size}x${size}.png`),
      kind: "png",
      size,
    })),
    { path: path.join(root, "assets", "icon.ico"), kind: "ico" },
  ];
}

function encodeIcoDimension(size) {
  if (!Number.isInteger(size) || size < 1 || size > 256) {
    throw new Error(`Invalid ICO image size: ${size}`);
  }
  return size === 256 ? 0 : size;
}

function buildIcoPngContainer(representations) {
  if (!Array.isArray(representations) || representations.length === 0) {
    throw new Error("ICO requires at least one PNG representation");
  }

  const headerSize = 6;
  const entrySize = 16;
  const directorySize = headerSize + entrySize * representations.length;
  const payloadSize = representations.reduce((sum, entry) => sum + entry.png.length, 0);
  const out = Buffer.alloc(directorySize + payloadSize);

  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(representations.length, 4);

  let payloadOffset = directorySize;
  representations.forEach((entry, index) => {
    const entryOffset = headerSize + entrySize * index;
    out[entryOffset] = encodeIcoDimension(entry.size);
    out[entryOffset + 1] = encodeIcoDimension(entry.size);
    out[entryOffset + 2] = 0;
    out[entryOffset + 3] = 0;
    out.writeUInt16LE(1, entryOffset + 4);
    out.writeUInt16LE(32, entryOffset + 6);
    out.writeUInt32LE(entry.png.length, entryOffset + 8);
    out.writeUInt32LE(payloadOffset, entryOffset + 12);
    entry.png.copy(out, payloadOffset);
    payloadOffset += entry.png.length;
  });

  return out;
}

function getArgValue(name) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function loadSourceImage(sourcePath) {
  if (!nativeImage) {
    throw new Error("App icon export must run inside Electron.");
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing app icon source: ${sourcePath}`);
  }
  const image = nativeImage.createFromPath(sourcePath);
  if (!image || image.isEmpty()) {
    throw new Error(`Unable to load app icon source: ${sourcePath}`);
  }
  return image;
}

function resizeToPng(image, size) {
  const resized = image.resize({ width: size, height: size, quality: "best" });
  if (!resized || resized.isEmpty()) {
    throw new Error(`Unable to resize app icon to ${size}x${size}`);
  }
  return resized.toPNG();
}

function cropAppIconSource(image) {
  const sourceSize = image.getSize();
  const shortSide = Math.min(sourceSize.width, sourceSize.height);
  const inset = Math.round(shortSide * APP_ICON_SOURCE_CROP_INSET_RATIO);
  const cropSide = shortSide - inset * 2;
  const cropRect = {
    x: Math.round((sourceSize.width - cropSide) / 2),
    y: Math.round((sourceSize.height - cropSide) / 2),
    width: cropSide,
    height: cropSide,
  };
  const cropped = image.crop(cropRect);
  if (!cropped || cropped.isEmpty()) {
    throw new Error(`Unable to crop app icon source to ${cropSide}x${cropSide}`);
  }
  return cropped;
}

function resizeToRoundedPng(image, size) {
  const resized = image.resize({ width: size, height: size, quality: "best" });
  if (!resized || resized.isEmpty()) {
    throw new Error(`Unable to resize app icon to ${size}x${size}`);
  }
  const bitmap = {
    width: size,
    height: size,
    buffer: Buffer.from(resized.toBitmap()),
  };
  applyRoundedSquareAlpha(bitmap, { radiusRatio: APP_ICON_CORNER_RADIUS_RATIO });
  return bitmapToPng(bitmap);
}

function bitmapToPng(bitmap) {
  const image = nativeImage.createFromBitmap(bitmap.buffer, {
    width: bitmap.width,
    height: bitmap.height,
    scaleFactor: 1,
  });
  if (!image || image.isEmpty()) {
    throw new Error(`Unable to render generated ${bitmap.width}x${bitmap.height} icon`);
  }
  return image.toPNG();
}

function createBitmap(width, height) {
  return { width, height, buffer: Buffer.alloc(width * height * 4) };
}

function setPixel(bitmap, x, y, color) {
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return;
  const offset = (y * bitmap.width + x) * 4;
  bitmap.buffer[offset] = color.b;
  bitmap.buffer[offset + 1] = color.g;
  bitmap.buffer[offset + 2] = color.r;
  bitmap.buffer[offset + 3] = color.a;
}

function fillRect(bitmap, x, y, width, height, color) {
  for (let py = y; py < y + height; py += 1) {
    for (let px = x; px < x + width; px += 1) {
      setPixel(bitmap, px, py, color);
    }
  }
}

function applyRoundedSquareAlpha(bitmap, options = {}) {
  const radius = Math.min(bitmap.width, bitmap.height) * (options.radiusRatio || APP_ICON_CORNER_RADIUS_RATIO);
  const maxX = bitmap.width - 1;
  const maxY = bitmap.height - 1;

  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const cornerX = px < radius ? radius : px > bitmap.width - radius ? bitmap.width - radius : px;
      const cornerY = py < radius ? radius : py > bitmap.height - radius ? bitmap.height - radius : py;
      const dx = px - cornerX;
      const dy = py - cornerY;
      if (dx * dx + dy * dy > radius * radius) {
        const offset = (y * bitmap.width + x) * 4;
        bitmap.buffer[offset + 3] = 0;
      }
    }
  }

  // Keep the edge midpoints explicit for very small icon sizes.
  bitmap.buffer[((Math.floor(bitmap.height / 2) * bitmap.width + 0) * 4) + 3] = 255;
  bitmap.buffer[((Math.floor(bitmap.height / 2) * bitmap.width + maxX) * 4) + 3] = 255;
  bitmap.buffer[((0 * bitmap.width + Math.floor(bitmap.width / 2)) * 4) + 3] = 255;
  bitmap.buffer[((maxY * bitmap.width + Math.floor(bitmap.width / 2)) * 4) + 3] = 255;
  return bitmap;
}

function createTemplateBitmap(size) {
  const bitmap = createBitmap(size, size);
  const unit = size / 16;
  const rects = [
    [4, 3, 2, 2], [6, 5, 2, 2], [8, 7, 2, 2], [10, 8, 2, 2],
    [8, 9, 2, 2], [6, 11, 2, 2], [4, 13, 2, 2], [9, 13, 5, 2],
  ];
  for (const [x, y, w, h] of rects) {
    fillRect(
      bitmap,
      Math.round(x * unit),
      Math.round(y * unit),
      Math.round(w * unit),
      Math.round(h * unit),
      { r: 0, g: 0, b: 0, a: 255 }
    );
  }
  return bitmap;
}

function createFlashBitmap(size) {
  const bitmap = createBitmap(size, size);
  const center = (size - 1) / 2;
  const radius = size * 0.42;
  const radiusSquared = radius * radius;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - center;
      const dy = y - center;
      if (dx * dx + dy * dy <= radiusSquared) {
        setPixel(bitmap, x, y, { r: 255, g: 127, b: 95, a: 255 });
      }
    }
  }
  const accentSize = Math.max(2, Math.round(size * 0.14));
  fillRect(
    bitmap,
    Math.round(size * 0.58),
    Math.round(size * 0.24),
    accentSize,
    accentSize,
    { r: 75, g: 189, b: 183, a: 255 }
  );
  return bitmap;
}

function writeFileEnsuringDir(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function exportAppIcons(options = {}) {
  const sourcePath = options.sourcePath || DEFAULT_SOURCE;
  const dryRun = Boolean(options.dryRun);
  const source = cropAppIconSource(loadSourceImage(sourcePath));
  const targets = getDefaultExportTargets(REPO_ROOT);

  for (const target of targets) {
    let content = null;
    if (target.kind === "png") {
      content = resizeToRoundedPng(source, target.size);
    } else if (target.kind === "template") {
      content = bitmapToPng(createTemplateBitmap(target.size));
    } else if (target.kind === "flash") {
      content = bitmapToPng(createFlashBitmap(target.size));
    } else if (target.kind === "ico") {
      content = buildIcoPngContainer(
        ICO_PNG_SIZES.map((size) => ({ size, png: resizeToRoundedPng(source, size) }))
      );
    }
    if (!content) continue;
    if (!dryRun) writeFileEnsuringDir(target.path, content);
    console.log(`${dryRun ? "checked" : "exported"} ${path.relative(REPO_ROOT, target.path)}`);
  }
}

function getElectronBinary() {
  try {
    const electronPath = require("electron");
    if (typeof electronPath === "string" && electronPath) return electronPath;
  } catch {}

  if (process.platform === "win32") {
    return path.join(REPO_ROOT, "node_modules", "electron", "dist", "electron.exe");
  }
  return path.join(REPO_ROOT, "node_modules", ".bin", "electron");
}

function runInElectron() {
  const electronBin = getElectronBinary();
  if (!fs.existsSync(electronBin)) {
    throw new Error("Electron is not installed. Run npm install before exporting app icons.");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-app-icons-"));
  const entryPath = path.join(tempDir, "main.js");
  const packagePath = path.join(tempDir, "package.json");

  fs.writeFileSync(packagePath, JSON.stringify({ main: "main.js" }));
  fs.writeFileSync(
    entryPath,
    [
      `"use strict";`,
      `process.env.${EXPORTER_ENV} = "1";`,
      `require(${JSON.stringify(__filename)});`,
      "",
    ].join("\n")
  );

  const result = spawnSync(electronBin, [tempDir, ...process.argv.slice(2)], {
    cwd: REPO_ROOT,
    env: { ...process.env, [EXPORTER_ENV]: "1" },
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
}

if (require.main === module) {
  try {
    runInElectron();
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  }
} else if (process.env[EXPORTER_ENV] === "1") {
  try {
    exportAppIcons({
      sourcePath: getArgValue("--source") || DEFAULT_SOURCE,
      dryRun: process.argv.includes("--dry-run"),
    });
  } catch (error) {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  } finally {
    if (app && typeof app.quit === "function") {
      app.quit();
    }
  }
}

module.exports = {
  APP_ICON_PNG_SIZES,
  ICO_PNG_SIZES,
  applyRoundedSquareAlpha,
  buildIcoPngContainer,
  createFlashBitmap,
  createTemplateBitmap,
  exportAppIcons,
  getDefaultExportTargets,
};

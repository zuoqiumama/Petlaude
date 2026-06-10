"use strict";

// ── Pet theme writer ─────────────────────────────────────────────────────────
// Derives a user pet theme from a reference image by cloning the bundled
// template, and wires generated action assets into the theme's companion
// fields. Built-in themes are never modified — generated pets live under
// {userData}/themes/<slug>/.

const fs = require("fs");
const path = require("path");

const GEN_VIEWBOX = { x: 0, y: 0, width: 512, height: 512 };

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "") || "pet";
}

function ensurePetTheme({ name, referencePath, userThemesDir, templateDir }) {
  if (!name) throw new Error("ensurePetTheme requires a name");
  if (!referencePath || !fs.existsSync(referencePath)) throw new Error("reference image not found");
  if (!userThemesDir || !templateDir) throw new Error("userThemesDir and templateDir are required");

  const themeId = slugify(name);
  const themeDir = path.join(userThemesDir, themeId);
  const assetsDir = path.join(themeDir, "assets");

  if (!fs.existsSync(themeDir)) {
    fs.mkdirSync(themeDir, { recursive: true });
    // Clone the template (theme.json + assets/) without touching the original.
    fs.cpSync(path.join(templateDir, "theme.json"), path.join(themeDir, "theme.json"));
    const templateAssets = path.join(templateDir, "assets");
    if (fs.existsSync(templateAssets)) {
      fs.cpSync(templateAssets, assetsDir, { recursive: true });
    } else {
      fs.mkdirSync(assetsDir, { recursive: true });
    }
  }
  fs.mkdirSync(assetsDir, { recursive: true });

  // Copy the reference as the static idle asset.
  const refBasename = "reference.png";
  fs.copyFileSync(referencePath, path.join(assetsDir, refBasename));

  // Patch metadata: name, version, square viewBox, idle = reference.
  const themeJsonPath = path.join(themeDir, "theme.json");
  const theme = JSON.parse(fs.readFileSync(themeJsonPath, "utf8"));
  theme.name = name;
  theme.version = "1.0.0";
  theme.viewBox = { ...GEN_VIEWBOX };
  theme.states = { ...(theme.states || {}), idle: [refBasename] };
  // Strip scaffold-only markers if present.
  delete theme._scaffoldOnly;
  fs.writeFileSync(themeJsonPath, `${JSON.stringify(theme, null, 2)}\n`, "utf8");

  return { themeDir, themeId, assetsDir };
}

module.exports = { slugify, ensurePetTheme, GEN_VIEWBOX };

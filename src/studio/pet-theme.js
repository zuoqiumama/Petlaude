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
  const source = String(value || "").trim();
  const ascii = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (ascii) return ascii;
  if (!source) return "pet";
  let hash = 2166136261;
  for (const ch of source) {
    hash ^= ch.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `pet-${(hash >>> 0).toString(36)}`;
}

function buildBaseTheme(name, referenceFile, previous) {
  const theme = {
    schemaVersion: 1,
    name,
    author: "Clawd AI Studio",
    version: "1.0.0",
    description: "A custom pet generated from a reference image in Clawd AI Studio",
    viewBox: { ...GEN_VIEWBOX },
    layout: {
      contentBox: { x: 32, y: 24, width: 448, height: 456 },
      centerX: 256,
      baselineY: 480,
      visibleHeightRatio: 0.9,
      baselineBottomRatio: 0.03,
    },
    eyeTracking: { enabled: false, states: [] },
    states: {
      idle: [referenceFile],
      working: [referenceFile],
      thinking: [referenceFile],
      sleeping: { fallbackTo: "idle" },
    },
    sleepSequence: { mode: "direct" },
    timings: { mouseIdleTimeout: 20000, mouseSleepTimeout: 60000 },
    hitBoxes: {
      default: { x: 32, y: 24, w: 448, h: 456 },
      sleeping: { x: 32, y: 24, w: 448, h: 456 },
    },
    miniMode: { supported: false },
    objectScale: {
      widthRatio: 1,
      heightRatio: 1,
      imgWidthRatio: 1,
      offsetX: 0,
      offsetY: 0,
      imgOffsetX: 0,
      objBottom: 0.03,
      imgBottom: 0.03,
    },
  };

  // Generating one action at a time re-enters ensurePetTheme. Preserve only
  // fields that Studio itself writes; never carry template placeholder assets.
  if (previous && previous._scaffoldOnly !== true) {
    for (const key of ["idleLife", "contextReactions", "touchReactions"]) {
      if (previous[key] && typeof previous[key] === "object") theme[key] = previous[key];
    }
    // Core-state animations from earlier runs. Studio writes them as
    // `<actionId>.svg` arrays while the scaffold placeholder is always the
    // raster reference image, so an all-SVG binding can only be generated.
    const states = { ...theme.states };
    let statesChanged = false;
    for (const [key, entry] of Object.entries(previous.states || {})) {
      const generated = Array.isArray(entry)
        && entry.length > 0
        && entry.every((file) => typeof file === "string" && /\.svg$/i.test(file));
      if (generated) {
        states[key] = [...entry];
        statesChanged = true;
      }
    }
    if (statesChanged) theme.states = states;
    const reactions = {};
    for (const key of ["rapidClick", "dragRelease"]) {
      const entry = previous.reactions && previous.reactions[key];
      if (entry && typeof entry === "object" && typeof entry.file === "string") {
        reactions[key] = entry;
      }
    }
    if (Object.keys(reactions).length > 0) theme.reactions = reactions;
  }
  return theme;
}

function isReusableStudioTheme(themeDir, name) {
  try {
    const theme = JSON.parse(fs.readFileSync(path.join(themeDir, "theme.json"), "utf8"));
    return theme.author === "Clawd AI Studio" && theme.name === name;
  } catch {
    return false;
  }
}

function resolveThemeId(name, userThemesDir, templateDir) {
  const baseId = slugify(name);
  let candidate = fs.existsSync(path.join(path.dirname(templateDir), baseId))
    ? `${baseId}-custom`
    : baseId;
  let candidateDir = path.join(userThemesDir, candidate);
  if (!fs.existsSync(candidateDir) || isReusableStudioTheme(candidateDir, name)) return candidate;

  const studioBase = `${baseId}-studio`;
  candidate = studioBase;
  for (let suffix = 2; ; suffix += 1) {
    candidateDir = path.join(userThemesDir, candidate);
    if (!fs.existsSync(candidateDir) || isReusableStudioTheme(candidateDir, name)) return candidate;
    candidate = `${studioBase}-${suffix}`;
  }
}

function ensurePetTheme({ name, referencePath, userThemesDir, templateDir }) {
  if (!name) throw new Error("ensurePetTheme requires a name");
  if (!referencePath || !fs.existsSync(referencePath)) throw new Error("reference image not found");
  if (!userThemesDir || !templateDir) throw new Error("userThemesDir and templateDir are required");

  const themeId = resolveThemeId(name, userThemesDir, templateDir);
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

  const refExt = path.extname(referencePath).toLowerCase();
  const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(refExt) ? refExt : ".png";
  const refBasename = `reference${safeExt}`;
  for (const filename of fs.readdirSync(assetsDir)) {
    if (/^reference\.(?:png|jpe?g|webp)$/i.test(filename) && filename !== refBasename) {
      fs.rmSync(path.join(assetsDir, filename), { force: true });
    }
  }
  fs.copyFileSync(referencePath, path.join(assetsDir, refBasename));

  const themeJsonPath = path.join(themeDir, "theme.json");
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(themeJsonPath, "utf8")); } catch { /* rebuilt below */ }
  const theme = buildBaseTheme(name, refBasename, previous);
  fs.writeFileSync(themeJsonPath, `${JSON.stringify(theme, null, 2)}\n`, "utf8");

  return { themeDir, themeId, assetsDir };
}

module.exports = { slugify, ensurePetTheme, GEN_VIEWBOX };

"use strict";

// Pure remote-source ingestion for pricing auto-fetch. No I/O, no async.
// Converts upstream LiteLLM + OpenRouter payloads into the internal
// per-million USD shape, applies sanity bounds, and merges them with the
// bundled seed.
//
// Produced litellm-style map precedence (high -> low):
//   live LiteLLM  >  bundled seed  >  OpenRouter (gap-fill only)
// (curated overrides are a separate layer and always win in matcher.js)

const { convertLitellmEntry, buildLitellmPerMillionMap } = require("./matcher");

// Reject absurd prices (USD per million tokens). Real top-tier models are
// well under this; anything above is almost certainly a unit/parse error.
const MAX_PER_MILLION = 10000;
const PRICE_FIELDS = ["input", "output", "cache_read", "cache_write"];

function validatePricingEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  let hasOne = false;
  for (const f of PRICE_FIELDS) {
    if (entry[f] === undefined) continue;
    const v = entry[f];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > MAX_PER_MILLION) {
      return false;
    }
    hasOne = true;
  }
  return hasOne;
}

function filterSane(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (validatePricingEntry(v)) out[k] = v;
  }
  return out;
}

// OpenRouter ids look like "{provider}/{slug}-{YYYYMMDD}". Strip the provider
// prefix and an optional trailing date so the key lines up with how Clawd /
// curated name models. The matcher's fuzzy/prefix-strip handles the rest.
function normalizeOpenRouterId(id) {
  if (typeof id !== "string" || !id) return "";
  let slug = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  slug = slug.replace(/-\d{8}$/, "");
  return slug.toLowerCase();
}

// Map OpenRouter's per-token string pricing onto the LiteLLM per-token field
// names, then reuse the existing converter for the per-million math + rounding.
function convertOpenRouterEntry(pricing) {
  if (!pricing || typeof pricing !== "object") return null;
  const num = (s) => {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  const litellmShape = {};
  if (pricing.prompt !== undefined) litellmShape.input_cost_per_token = num(pricing.prompt);
  if (pricing.completion !== undefined) litellmShape.output_cost_per_token = num(pricing.completion);
  if (pricing.input_cache_read !== undefined) litellmShape.cache_read_input_token_cost = num(pricing.input_cache_read);
  if (pricing.input_cache_write !== undefined) litellmShape.cache_creation_input_token_cost = num(pricing.input_cache_write);
  return convertLitellmEntry(litellmShape);
}

function convertOpenRouterPayload(payload) {
  const out = {};
  const data = payload && Array.isArray(payload.data) ? payload.data : [];
  for (const row of data) {
    if (!row || typeof row !== "object") continue;
    const key = normalizeOpenRouterId(row.id);
    if (!key) continue;
    const entry = convertOpenRouterEntry(row.pricing);
    if (entry && validatePricingEntry(entry)) out[key] = entry;
  }
  return out;
}

function normalizeLitellmPayload(raw) {
  // buildLitellmPerMillionMap already skips "_"-prefixed meta keys.
  return filterSane(buildLitellmPerMillionMap(raw));
}

// seed/live are per-million litellm-style maps; openRouter likewise. Precedence:
// live overlays seed (same source family, fresher wins); OpenRouter only fills
// keys that neither seed nor live carry.
function mergePricingLayers({ seed = {}, liveLitellm = {}, openRouter = {} } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(seed)) out[k] = v;
  for (const [k, v] of Object.entries(liveLitellm)) out[k] = v;
  for (const [k, v] of Object.entries(openRouter)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

module.exports = {
  MAX_PER_MILLION,
  validatePricingEntry,
  normalizeOpenRouterId,
  convertOpenRouterEntry,
  convertOpenRouterPayload,
  normalizeLitellmPayload,
  mergePricingLayers,
};

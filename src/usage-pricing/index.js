"use strict";

const curatedOverrides = require("./curated-overrides.json");
const seedSnapshot = require("./seed-snapshot.json");
const {
  lookupPricing,
  buildLitellmPerMillionMap,
} = require("./matcher");

const ZERO_PRICING = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
let activeLitellmMap = buildLitellmPerMillionMap(seedSnapshot);
let negativeCache = new Set();
let pricingMeta = { lastFetchedAt: null, sources: {}, source: "seed" };

function normalizeSource(value) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : "";
}

function getModelPricing(model, opts = {}) {
  if (!model || typeof model !== "string") return ZERO_PRICING;
  const source = normalizeSource(typeof opts === "string" ? opts : opts.source);
  const cacheKey = `${source}\0${model}`;
  if (negativeCache.has(cacheKey)) return ZERO_PRICING;

  const result = lookupPricing(model, {
    curated: curatedOverrides,
    litellm: activeLitellmMap,
    source,
  });
  if (result.hit && result.value) {
    return {
      input: Number(result.value.input) || 0,
      output: Number(result.value.output) || 0,
      cache_read: Number(result.value.cache_read) || 0,
      cache_write: Number(result.value.cache_write) || 0,
    };
  }

  negativeCache.add(cacheKey);
  return ZERO_PRICING;
}

// Swap in a freshly-merged per-million map (built by remote-source) and clear
// the negative cache, since new data may resolve models that previously missed.
function reloadPricing(mergedPerMillionMap, meta = {}) {
  if (mergedPerMillionMap && typeof mergedPerMillionMap === "object") {
    activeLitellmMap = mergedPerMillionMap;
  }
  negativeCache = new Set();
  pricingMeta = {
    lastFetchedAt: meta.lastFetchedAt ?? pricingMeta.lastFetchedAt,
    sources: meta.sources ?? pricingMeta.sources,
    source: meta.source ?? "live",
  };
}

function getPricingMeta() {
  return {
    lastFetchedAt: pricingMeta.lastFetchedAt,
    sources: { ...pricingMeta.sources },
    source: pricingMeta.source,
  };
}

function hasPositivePricing(pricing) {
  return Boolean(
    pricing &&
    (
      (Number(pricing.input) || 0) > 0 ||
      (Number(pricing.output) || 0) > 0 ||
      (Number(pricing.cache_read) || 0) > 0 ||
      (Number(pricing.cache_write) || 0) > 0
    )
  );
}

function computeUsageCost(usage, opts = {}) {
  const pricing = getModelPricing(opts.model, { source: opts.source });
  if (!hasPositivePricing(pricing)) {
    return {
      costUsd: 0,
      pricingKnown: false,
      pricing,
    };
  }

  const input = Number(usage && usage.input_tokens) || 0;
  const output = Number(usage && usage.output_tokens) || 0;
  const cached = Number(usage && usage.cached_input_tokens) || 0;
  const cacheCreation = Number(usage && usage.cache_creation_input_tokens) || 0;
  const reasoning = Number(usage && usage.reasoning_output_tokens) || 0;
  const source = normalizeSource(opts.source);
  const reasoningIncludedInOutput = source === "codex" || source === "every-code";
  const reasoningCost = reasoningIncludedInOutput ? 0 : reasoning * pricing.output;
  const costUsd = (
    input * pricing.input +
    output * pricing.output +
    cached * pricing.cache_read +
    cacheCreation * pricing.cache_write +
    reasoningCost
  ) / 1_000_000;

  return {
    costUsd,
    pricingKnown: true,
    pricing,
  };
}

module.exports = {
  ZERO_PRICING,
  computeUsageCost,
  getModelPricing,
  reloadPricing,
  getPricingMeta,
};

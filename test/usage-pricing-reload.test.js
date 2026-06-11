"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const pricing = require("../src/usage-pricing");

describe("usage-pricing reload", () => {
  it("exposes reloadPricing + getPricingMeta", () => {
    assert.equal(typeof pricing.reloadPricing, "function");
    assert.equal(typeof pricing.getPricingMeta, "function");
  });

  it("a previously-missed model resolves after reload, and meta updates", () => {
    const fake = "totally-made-up-model-zzz";
    // before: unknown -> zero pricing
    assert.equal(pricing.getModelPricing(fake).output, 0);
    // reload with new data containing the model
    pricing.reloadPricing(
      { [fake]: { input: 1, output: 2, cache_read: 0.1 } },
      { lastFetchedAt: "2026-06-11T00:00:00.000Z", sources: { litellm: { ok: true } } }
    );
    const after = pricing.getModelPricing(fake);
    assert.equal(after.input, 1);
    assert.equal(after.output, 2);
    assert.equal(pricing.getPricingMeta().lastFetchedAt, "2026-06-11T00:00:00.000Z");
  });

  it("curated overrides still win after a reload", () => {
    // claude-opus-4-8 is pinned in curated-overrides.json
    pricing.reloadPricing({ "claude-opus-4-8": { input: 999, output: 999 } });
    const p = pricing.getModelPricing("claude-opus-4-8");
    assert.equal(p.input, 5);   // curated value, not the reloaded 999
    assert.equal(p.output, 25);
  });
});

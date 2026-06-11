"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeOpenRouterId,
  convertOpenRouterPayload,
  normalizeLitellmPayload,
  validatePricingEntry,
  mergePricingLayers,
} = require("../src/usage-pricing/remote-source");

describe("remote-source: validatePricingEntry", () => {
  it("accepts a normal entry", () => {
    assert.equal(validatePricingEntry({ input: 3, output: 15, cache_read: 0.3 }), true);
  });
  it("rejects negative, NaN and absurd ceilings", () => {
    assert.equal(validatePricingEntry({ input: -1 }), false);
    assert.equal(validatePricingEntry({ input: Number.NaN }), false);
    assert.equal(validatePricingEntry({ output: 999999 }), false);
  });
  it("rejects empty/non-object", () => {
    assert.equal(validatePricingEntry(null), false);
    assert.equal(validatePricingEntry({}), false);
  });
});

describe("remote-source: normalizeOpenRouterId", () => {
  it("strips provider prefix and trailing YYYYMMDD date", () => {
    assert.equal(normalizeOpenRouterId("deepseek/deepseek-v4-pro-20260423"), "deepseek-v4-pro");
    assert.equal(normalizeOpenRouterId("z-ai/glm-5.1-20260406"), "glm-5.1");
  });
  it("leaves bare ids without date intact", () => {
    assert.equal(normalizeOpenRouterId("openai/gpt-5"), "gpt-5");
  });
});

describe("remote-source: convertOpenRouterPayload", () => {
  it("converts per-token strings to per-million numbers under normalized keys", () => {
    const payload = {
      data: [
        {
          id: "deepseek/deepseek-v4-pro-20260423",
          pricing: {
            prompt: "0.000000435",
            completion: "0.00000087",
            input_cache_read: "0.000000003625",
            input_cache_write: "0.000000435",
          },
        },
      ],
    };
    const map = convertOpenRouterPayload(payload);
    assert.deepEqual(map["deepseek-v4-pro"], {
      input: 0.435,
      output: 0.87,
      cache_read: 0.003625,
      cache_write: 0.435,
    });
  });
  it("skips entries that fail sanity and tolerates a missing data array", () => {
    assert.deepEqual(convertOpenRouterPayload({}), {});
    const bad = { data: [{ id: "x/y-20260101", pricing: { prompt: "999999", completion: "1" } }] };
    assert.deepEqual(convertOpenRouterPayload(bad), {});
  });
});

describe("remote-source: normalizeLitellmPayload", () => {
  it("converts litellm per-token map and drops _meta keys", () => {
    const raw = {
      _meta: { source: "x" },
      "gpt-5": { input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001 },
    };
    const map = normalizeLitellmPayload(raw);
    assert.equal(map._meta, undefined);
    assert.deepEqual(map["gpt-5"], { input: 1.25, output: 10 });
  });
});

describe("remote-source: mergePricingLayers precedence", () => {
  it("live LiteLLM overrides seed for same key", () => {
    const merged = mergePricingLayers({
      seed: { "gpt-5": { input: 1, output: 2 } },
      liveLitellm: { "gpt-5": { input: 1.25, output: 10 } },
      openRouter: {},
    });
    assert.deepEqual(merged["gpt-5"], { input: 1.25, output: 10 });
  });
  it("OpenRouter only fills keys absent from the LiteLLM channel (seed ∪ live)", () => {
    const merged = mergePricingLayers({
      seed: { "gpt-5": { input: 1, output: 2 } },
      liveLitellm: {},
      openRouter: {
        "gpt-5": { input: 99, output: 99 },        // present in seed -> ignored
        "glm-5.1": { input: 1.4, output: 4.4 },    // new -> added
      },
    });
    assert.deepEqual(merged["gpt-5"], { input: 1, output: 2 });
    assert.deepEqual(merged["glm-5.1"], { input: 1.4, output: 4.4 });
  });
});

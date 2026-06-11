"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPricingUpdater } = require("../src/pricing-updater");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-pricing-"));
}

const SEED = { "gpt-5": { input: 1.25, output: 10 } };

function makeDeps(overrides = {}) {
  const reloaded = [];
  return {
    reloaded,
    deps: {
      cacheDir: tmpDir(),
      seed: SEED,
      ttlMs: 24 * 60 * 60 * 1000,
      now: () => new Date("2026-06-11T12:00:00.000Z").getTime(),
      getEnabled: () => true,
      pricingModule: { reloadPricing: (map, meta) => reloaded.push({ map, meta }) },
      fetchJson: async () => ({}),
      logger: { warn() {}, info() {} },
      ...overrides,
    },
  };
}

describe("pricing-updater cache", () => {
  it("writes cache atomically and reloads from it", async () => {
    const { deps, reloaded } = makeDeps();
    const u = createPricingUpdater(deps);
    await u.applyMerged({ "glm-5.1": { input: 1.4, output: 4.4 } }, { litellm: { ok: true } });
    const cachePath = path.join(deps.cacheDir, "pricing-cache.json");
    assert.equal(fs.existsSync(cachePath), true);
    const saved = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    assert.equal(saved.map["glm-5.1"].output, 4.4);
    assert.ok(saved._meta.fetchedAt);
    assert.equal(reloaded.length, 1);
  });

  it("loadCache returns null when absent and parsed object when present", () => {
    const { deps } = makeDeps();
    const u = createPricingUpdater(deps);
    assert.equal(u.loadCache(), null);
    fs.writeFileSync(path.join(deps.cacheDir, "pricing-cache.json"),
      JSON.stringify({ map: {}, _meta: { fetchedAt: "2026-06-10T00:00:00.000Z" } }));
    assert.ok(u.loadCache()._meta.fetchedAt);
  });

  it("isStale respects ttl against now", () => {
    const { deps } = makeDeps();
    const u = createPricingUpdater(deps);
    assert.equal(u.isStale({ fetchedAt: "2026-06-11T11:00:00.000Z" }), false); // 1h ago
    assert.equal(u.isStale({ fetchedAt: "2026-06-09T11:00:00.000Z" }), true);  // >24h
    assert.equal(u.isStale(null), true);
  });
});

describe("pricing-updater refreshNow + scheduling", () => {
  it("merges both sources; one source failing does not abort the other", async () => {
    const { deps, reloaded } = makeDeps({
      fetchJson: async (url) => {
        if (url.includes("litellm")) throw new Error("offline");
        return { data: [{ id: "z-ai/glm-5.1-20260406", pricing: { prompt: "0.0000014", completion: "0.0000044" } }] };
      },
    });
    const u = createPricingUpdater(deps);
    const status = await u.refreshNow();
    assert.equal(status.sources.litellm.ok, false);
    assert.equal(status.sources.openrouter.ok, true);
    assert.equal(reloaded.length, 1);
    // openrouter-only model present; seed gpt-5 preserved
    assert.equal(reloaded[0].map["glm-5.1"].output, 4.4);
    assert.equal(reloaded[0].map["gpt-5"].output, 10);
  });

  it("both sources failing keeps last cache and does not zero out (no reload)", async () => {
    const { deps, reloaded } = makeDeps({ fetchJson: async () => { throw new Error("offline"); } });
    const u = createPricingUpdater(deps);
    const status = await u.refreshNow();
    assert.equal(status.sources.litellm.ok, false);
    assert.equal(status.sources.openrouter.ok, false);
    assert.equal(reloaded.length, 0); // never reloaded with empty data
  });

  it("maybeRefresh skips when disabled", async () => {
    let calls = 0;
    const { deps } = makeDeps({ getEnabled: () => false, fetchJson: async () => { calls++; return {}; } });
    const u = createPricingUpdater(deps);
    await u.maybeRefresh();
    assert.equal(calls, 0); // disabled -> no fetch
  });

  it("maybeRefresh skips when cache is fresh", async () => {
    let calls = 0;
    const { deps } = makeDeps({ fetchJson: async () => { calls++; return {}; } });
    // seed a fresh cache (1h old vs 24h ttl)
    fs.writeFileSync(path.join(deps.cacheDir, "pricing-cache.json"),
      JSON.stringify({ map: SEED, _meta: { fetchedAt: "2026-06-11T11:00:00.000Z" } }));
    const u = createPricingUpdater(deps);
    await u.maybeRefresh();
    assert.equal(calls, 0); // fresh -> no fetch
  });

  it("retains the last-good layer when one source fails on a later refresh", async () => {
    let phase = 1;
    const { deps, reloaded } = makeDeps({
      fetchJson: async (url) => {
        if (url.includes("litellm")) {
          if (phase === 2) throw new Error("temporary outage");
          return {
            "litellm-only": {
              input_cost_per_token: 0.000002,
              output_cost_per_token: 0.000006,
            },
          };
        }
        return {
          data: [{
            id: "vendor/openrouter-only",
            pricing: { prompt: phase === 1 ? "0.000003" : "0.000004" },
          }],
        };
      },
    });
    const u = createPricingUpdater(deps);

    await u.refreshNow();
    phase = 2;
    await u.refreshNow();

    const latest = reloaded.at(-1).map;
    assert.equal(latest["litellm-only"].output, 6);
    assert.equal(latest["openrouter-only"].input, 4);
    const saved = u.loadCache();
    assert.equal(saved.layers.litellm["litellm-only"].output, 6);
  });

  it("does not reprice history when a retry produces the same merged map", async () => {
    let phase = 1;
    let reprices = 0;
    const { deps } = makeDeps({
      onPricingReloaded: () => { reprices += 1; },
      fetchJson: async (url) => {
        if (url.includes("litellm")) {
          if (phase === 2) throw new Error("temporary outage");
          return { "stable-litellm": { input_cost_per_token: 0.000002 } };
        }
        return {
          data: [{ id: "vendor/stable-openrouter", pricing: { prompt: "0.000003" } }],
        };
      },
    });
    const u = createPricingUpdater(deps);

    await u.refreshNow();
    phase = 2;
    await u.refreshNow();

    assert.equal(reprices, 1);
  });

  it("schedules the next check for the remaining TTL instead of a full day", async () => {
    const scheduled = [];
    const nowMs = Date.parse("2026-06-11T12:00:00.000Z");
    const { deps } = makeDeps({
      now: () => nowMs,
      setTimer: (fn, delay) => {
        scheduled.push({ fn, delay });
        return { unref() {} };
      },
      clearTimer() {},
    });
    fs.writeFileSync(path.join(deps.cacheDir, "pricing-cache.json"), JSON.stringify({
      map: SEED,
      _meta: { fetchedAt: "2026-06-10T13:00:00.000Z" },
    }));
    const u = createPricingUpdater(deps);

    await u.init();

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 60 * 60 * 1000);
    u.stop();
  });

  it("retries failed refreshes on a short backoff", async () => {
    const scheduled = [];
    const { deps } = makeDeps({
      failureRetryMs: 5 * 60 * 1000,
      fetchJson: async () => { throw new Error("offline"); },
      setTimer: (fn, delay) => {
        scheduled.push({ fn, delay });
        return { unref() {} };
      },
      clearTimer() {},
    });
    const u = createPricingUpdater(deps);

    await u.init();

    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 5 * 60 * 1000);
    u.stop();
  });
});

"use strict";

// Main-process orchestrator for pricing auto-fetch. All I/O + scheduling lives
// here; pure conversion/merge is delegated to usage-pricing/remote-source.
// Dependencies are injected so the logic is unit-testable without network/fs.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const remoteSource = require("./usage-pricing/remote-source");

const CACHE_FILENAME = "pricing-cache.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

async function defaultFetchJson(url, { timeoutMs = 10000, maxBytes = 8 * 1024 * 1024 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Error("response too large");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function createPricingUpdater(opts = {}) {
  const cacheDir = opts.cacheDir || path.join(os.homedir(), ".clawd");
  const cachePath = path.join(cacheDir, CACHE_FILENAME);
  const seed = opts.seed || {};
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  const now = opts.now || (() => Date.now());
  const getEnabled = opts.getEnabled || (() => true);
  const pricingModule = opts.pricingModule || require("./usage-pricing");
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const logger = opts.logger || console;
  const litellmUrl = opts.litellmUrl || LITELLM_URL;
  const openRouterUrl = opts.openRouterUrl || OPENROUTER_URL;

  let timer = null;
  let lastMeta = null;

  function loadCache() {
    try {
      const text = fs.readFileSync(cachePath, "utf8");
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function writeCacheAtomic(obj) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, cachePath);
  }

  function isStale(meta) {
    if (!meta || !meta.fetchedAt) return true;
    const t = Date.parse(meta.fetchedAt);
    if (!Number.isFinite(t)) return true;
    return now() - t > ttlMs;
  }

  function getStatusBase() {
    return { enabled: getEnabled(), lastFetchedAt: lastMeta && lastMeta.fetchedAt };
  }

  // Apply an already-merged per-million map: persist + reload the live module.
  async function applyMerged(mergedMap, sources) {
    const fetchedAt = new Date(now()).toISOString();
    const meta = { fetchedAt, sources };
    writeCacheAtomic({ map: mergedMap, _meta: meta });
    lastMeta = meta;
    pricingModule.reloadPricing(mergedMap, { lastFetchedAt: fetchedAt, sources, source: "live" });
    return meta;
  }

  async function fetchSource(url, normalizeFn) {
    try {
      const json = await fetchJson(url);
      const map = normalizeFn(json);
      const count = Object.keys(map).length;
      if (count === 0) return { map: {}, status: { ok: false, count: 0, err: "empty" } };
      return { map, status: { ok: true, count } };
    } catch (err) {
      logger.warn(`[pricing] fetch failed ${url}: ${err.message}`);
      return { map: {}, status: { ok: false, count: 0, err: err.message } };
    }
  }

  async function refreshNow() {
    const [litellm, openrouter] = await Promise.all([
      fetchSource(litellmUrl, remoteSource.normalizeLitellmPayload),
      fetchSource(openRouterUrl, remoteSource.convertOpenRouterPayload),
    ]);
    const sources = { litellm: litellm.status, openrouter: openrouter.status };
    if (!litellm.status.ok && !openrouter.status.ok) {
      // Never reload with empty data; keep whatever is already active.
      return { ...getStatusBase(), sources };
    }
    const merged = remoteSource.mergePricingLayers({
      seed,
      liveLitellm: litellm.map,
      openRouter: openrouter.map,
    });
    const meta = await applyMerged(merged, sources);
    return { enabled: getEnabled(), lastFetchedAt: meta.fetchedAt, sources };
  }

  async function maybeRefresh() {
    if (!getEnabled()) return null;
    const cache = loadCache();
    if (cache && !isStale(cache._meta)) return null; // fresh enough
    return refreshNow();
  }

  async function init({ scheduleTimer = true } = {}) {
    // 1. Instant offline-friendly load from cache (if any).
    const cache = loadCache();
    if (cache && cache.map) {
      lastMeta = cache._meta || null;
      pricingModule.reloadPricing(cache.map, {
        lastFetchedAt: cache._meta && cache._meta.fetchedAt,
        sources: cache._meta && cache._meta.sources,
        source: "cache",
      });
    }
    // 2. Background refresh if enabled + stale/missing.
    maybeRefresh().catch((e) => logger.warn(`[pricing] init refresh: ${e.message}`));
    // 3. Daily timer (TTL + enabled guarded inside maybeRefresh).
    if (scheduleTimer) {
      timer = setInterval(() => {
        maybeRefresh().catch((e) => logger.warn(`[pricing] timer refresh: ${e.message}`));
      }, ttlMs);
      if (timer.unref) timer.unref();
    }
  }

  return {
    cachePath,
    loadCache,
    writeCacheAtomic,
    isStale,
    applyMerged,
    refreshNow,
    maybeRefresh,
    init,
    getStatus: () => ({
      enabled: getEnabled(),
      lastFetchedAt: lastMeta && lastMeta.fetchedAt,
      sources: lastMeta && lastMeta.sources,
    }),
    stop: () => { if (timer) { clearInterval(timer); timer = null; } },
  };
}

module.exports = { createPricingUpdater, defaultFetchJson, CACHE_FILENAME, DEFAULT_TTL_MS };

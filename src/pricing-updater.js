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
const DEFAULT_FAILURE_RETRY_MS = 15 * 60 * 1000;
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

function pricingMapsEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    const leftEntry = left[key];
    const rightEntry = right[key];
    if (!leftEntry || !rightEntry || typeof leftEntry !== "object" || typeof rightEntry !== "object") {
      if (leftEntry !== rightEntry) return false;
      continue;
    }
    const fields = Object.keys(leftEntry);
    if (fields.length !== Object.keys(rightEntry).length) return false;
    if (fields.some((field) => leftEntry[field] !== rightEntry[field])) return false;
  }
  return true;
}

function createPricingUpdater(opts = {}) {
  const cacheDir = opts.cacheDir || path.join(os.homedir(), ".clawd");
  const cachePath = path.join(cacheDir, CACHE_FILENAME);
  const seed = opts.seed || {};
  const ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
  const failureRetryMs = opts.failureRetryMs || DEFAULT_FAILURE_RETRY_MS;
  const now = opts.now || (() => Date.now());
  const getEnabled = opts.getEnabled || (() => true);
  const pricingModule = opts.pricingModule || require("./usage-pricing");
  const fetchJson = opts.fetchJson || defaultFetchJson;
  const logger = opts.logger || console;
  const setTimer = opts.setTimer || setTimeout;
  const clearTimer = opts.clearTimer || clearTimeout;
  const onPricingReloaded = opts.onPricingReloaded;
  const litellmUrl = opts.litellmUrl || LITELLM_URL;
  const openRouterUrl = opts.openRouterUrl || OPENROUTER_URL;

  let timer = null;
  let lastMeta = null;
  let lastAttemptMeta = null;
  let refreshPromise = null;
  let schedulingEnabled = false;

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

  function hasFailedSource(meta) {
    return Object.values((meta && meta.sources) || {}).some((status) => status && status.ok === false);
  }

  function getRefreshDelay(meta) {
    if (!meta || !meta.fetchedAt) return 0;
    const t = Date.parse(meta.fetchedAt);
    if (!Number.isFinite(t)) return 0;
    const maxAge = hasFailedSource(meta) ? failureRetryMs : ttlMs;
    const age = Math.max(0, now() - t);
    return Math.max(0, maxAge - age);
  }

  function isStale(meta) {
    return getRefreshDelay(meta) === 0;
  }

  function getStatusBase() {
    return { enabled: getEnabled(), lastFetchedAt: lastMeta && lastMeta.fetchedAt };
  }

  // Apply an already-merged per-million map: persist + reload the live module.
  async function notifyPricingReloaded(mergedMap, meta) {
    if (typeof onPricingReloaded !== "function") return;
    try {
      await onPricingReloaded({ map: mergedMap, meta });
    } catch (err) {
      logger.warn(`[pricing] post-reload callback: ${err.message}`);
    }
  }

  async function applyMerged(mergedMap, sources, cacheDetails = {}) {
    const fetchedAt = new Date(now()).toISOString();
    const meta = { fetchedAt, sources };
    const cache = { map: mergedMap, _meta: meta };
    if (cacheDetails.layers && Object.keys(cacheDetails.layers).length) {
      cache.layers = cacheDetails.layers;
    }
    if (cacheDetails.legacyFallback && Object.keys(cacheDetails.legacyFallback).length) {
      cache.legacyFallback = cacheDetails.legacyFallback;
    }
    writeCacheAtomic(cache);
    lastMeta = meta;
    lastAttemptMeta = meta;
    pricingModule.reloadPricing(mergedMap, { lastFetchedAt: fetchedAt, sources, source: "live" });
    if (cacheDetails.notify !== false) {
      await notifyPricingReloaded(mergedMap, meta);
    }
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

  async function performRefresh() {
    const cache = loadCache();
    const [litellm, openrouter] = await Promise.all([
      fetchSource(litellmUrl, remoteSource.normalizeLitellmPayload),
      fetchSource(openRouterUrl, remoteSource.convertOpenRouterPayload),
    ]);
    const sources = { litellm: litellm.status, openrouter: openrouter.status };
    if (!litellm.status.ok && !openrouter.status.ok) {
      // Never reload with empty data; keep whatever is already active.
      lastAttemptMeta = { fetchedAt: new Date(now()).toISOString(), sources };
      return { ...getStatusBase(), sources };
    }

    const cachedLayers = cache && cache.layers && typeof cache.layers === "object"
      ? cache.layers
      : {};
    const layers = {};
    if (litellm.status.ok) layers.litellm = litellm.map;
    else if (cachedLayers.litellm) layers.litellm = cachedLayers.litellm;
    if (openrouter.status.ok) layers.openrouter = openrouter.map;
    else if (cachedLayers.openrouter) layers.openrouter = cachedLayers.openrouter;

    // Old cache files only contain the final merged map. Keep that map as a
    // conservative fallback until both sources have succeeded once and can be
    // persisted as independently recoverable layers.
    let legacyFallback = cache && cache.legacyFallback;
    if (!cache?.layers && cache?.map) legacyFallback = cache.map;
    if (litellm.status.ok && openrouter.status.ok) legacyFallback = null;

    const merged = { ...seed, ...(legacyFallback || {}) };
    Object.assign(merged, layers.litellm || {});
    for (const [key, value] of Object.entries(layers.openrouter || {})) {
      if (!(key in merged)) merged[key] = value;
    }
    const meta = await applyMerged(merged, sources, {
      layers,
      legacyFallback,
      notify: !pricingMapsEqual(cache && cache.map, merged),
    });
    return { enabled: getEnabled(), lastFetchedAt: meta.fetchedAt, sources };
  }

  function runRefresh() {
    if (!refreshPromise) {
      refreshPromise = performRefresh().finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  async function refreshNow() {
    try {
      return await runRefresh();
    } finally {
      scheduleNext();
    }
  }

  function effectiveRefreshMeta(cache) {
    if (lastAttemptMeta && hasFailedSource(lastAttemptMeta)) return lastAttemptMeta;
    return (cache && cache._meta) || lastMeta;
  }

  async function maybeRefresh() {
    if (!getEnabled()) return null;
    const cache = loadCache();
    if (!isStale(effectiveRefreshMeta(cache))) return null;
    return runRefresh();
  }

  function scheduleNext() {
    if (!schedulingEnabled) return;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    const cache = loadCache();
    const delay = getEnabled()
      ? getRefreshDelay(effectiveRefreshMeta(cache))
      : ttlMs;
    timer = setTimer(() => {
      timer = null;
      maybeRefresh()
        .catch((e) => logger.warn(`[pricing] timer refresh: ${e.message}`))
        .finally(() => scheduleNext());
    }, Math.max(1, delay));
    if (timer && timer.unref) timer.unref();
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
    schedulingEnabled = scheduleTimer;
    try {
      await maybeRefresh();
    } catch (e) {
      logger.warn(`[pricing] init refresh: ${e.message}`);
    } finally {
      scheduleNext();
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
    stop: () => {
      schedulingEnabled = false;
      if (timer) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}

module.exports = {
  createPricingUpdater,
  defaultFetchJson,
  CACHE_FILENAME,
  DEFAULT_TTL_MS,
  DEFAULT_FAILURE_RETRY_MS,
  pricingMapsEqual,
};

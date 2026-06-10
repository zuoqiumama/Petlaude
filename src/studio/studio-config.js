"use strict";

// ── Studio API config store ──────────────────────────────────────────────────
// Persists the image-gen provider config. baseUrl + model are plain prefs; the
// API key is encrypted at rest with Electron safeStorage (OS keychain) and is
// NEVER written to prefs in plaintext, logged, or committed. If OS encryption
// is unavailable, the key is kept in memory for the session only and not
// persisted. `safeStorage` and `store` are injected for testability.

const KEY_BASEURL = "studio.baseUrl";
const KEY_MODEL = "studio.model";
const KEY_APIKEY_ENC = "studio.apiKeyEnc";

function createStudioConfig(deps = {}) {
  const safeStorage = deps.safeStorage || require("electron").safeStorage;
  const store = deps.store;
  if (!store || typeof store.get !== "function" || typeof store.set !== "function") {
    throw new Error("createStudioConfig requires a store with get/set/delete");
  }

  let memKey = ""; // session-only fallback when encryption is unavailable

  function saveConfig({ baseUrl, model, apiKey } = {}) {
    const url = String(baseUrl || "").trim();
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("baseUrl is not a valid URL");
    }
    if (parsed.protocol !== "https:") throw new Error("baseUrl must use https");

    store.set(KEY_BASEURL, url);
    store.set(KEY_MODEL, String(model || "").trim());

    const key = String(apiKey || "");
    if (!key) {
      return { keyPersisted: false };
    }
    if (safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      const enc = safeStorage.encryptString(key);
      store.set(KEY_APIKEY_ENC, Buffer.from(enc).toString("base64"));
      memKey = "";
      return { keyPersisted: true };
    }
    // No OS encryption — keep in memory only, never persist plaintext.
    memKey = key;
    if (typeof store.delete === "function") store.delete(KEY_APIKEY_ENC);
    return { keyPersisted: false };
  }

  function loadConfig() {
    const baseUrl = String(store.get(KEY_BASEURL) || "");
    const model = String(store.get(KEY_MODEL) || "");
    let apiKey = "";
    const enc = store.get(KEY_APIKEY_ENC);
    if (enc && safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()) {
      try {
        apiKey = safeStorage.decryptString(Buffer.from(String(enc), "base64"));
      } catch {
        apiKey = "";
      }
    }
    if (!apiKey && memKey) apiKey = memKey;
    return { baseUrl, model, apiKey };
  }

  function hasKey() {
    return !!(store.get(KEY_APIKEY_ENC) || memKey);
  }

  return { saveConfig, loadConfig, hasKey };
}

// Minimal JSON-file-backed store for the studio config (separate from prefs.js,
// which is schema-driven). Lazy-read, write-through on set/delete.
function createJsonFileStore(filePath, fsModule) {
  const fs = fsModule || require("fs");
  let cache = null;

  function read() {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      cache = {};
    }
    return cache;
  }

  function flush() {
    try {
      fs.mkdirSync(require("path").dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    } catch { /* best-effort persistence */ }
  }

  return {
    get: (k) => read()[k],
    set: (k, v) => { read()[k] = v; flush(); },
    delete: (k) => { delete read()[k]; flush(); },
  };
}

module.exports = { createStudioConfig, createJsonFileStore };

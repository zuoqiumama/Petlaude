"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { createStudioConfig } = require("../src/studio/studio-config");

function fakeStore() {
  const m = new Map();
  return {
    map: m,
    get: (k) => (m.has(k) ? m.get(k) : undefined),
    set: (k, v) => m.set(k, v),
    delete: (k) => m.delete(k),
  };
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`ENC:${s}`, "utf8"),
    decryptString: (buf) => Buffer.from(buf).toString("utf8").replace(/^ENC:/, ""),
  };
}

describe("studio-config with encryption available", () => {
  it("stores baseUrl/model in plain prefs and the key encrypted (never plaintext)", () => {
    const store = fakeStore();
    const cfg = createStudioConfig({ safeStorage: fakeSafeStorage(true), store });
    const res = cfg.saveConfig({ baseUrl: "https://api.example.com/draw", model: "gpt-image-2", apiKey: "sk-secret" });
    assert.strictEqual(res.keyPersisted, true);
    assert.strictEqual(store.get("studio.baseUrl"), "https://api.example.com/draw");
    assert.strictEqual(store.get("studio.model"), "gpt-image-2");
    // encrypted blob present, and the plaintext key is nowhere in the store
    const enc = store.get("studio.apiKeyEnc");
    assert.ok(enc && typeof enc === "string");
    for (const v of store.map.values()) assert.ok(!String(v).includes("sk-secret"), "plaintext key leaked");
  });

  it("loadConfig returns the decrypted key", () => {
    const store = fakeStore();
    const cfg = createStudioConfig({ safeStorage: fakeSafeStorage(true), store });
    cfg.saveConfig({ baseUrl: "https://x.example", model: "m", apiKey: "sk-abc" });
    const loaded = cfg.loadConfig();
    assert.strictEqual(loaded.baseUrl, "https://x.example");
    assert.strictEqual(loaded.model, "m");
    assert.strictEqual(loaded.apiKey, "sk-abc");
  });
});

describe("studio-config without encryption", () => {
  it("refuses to persist the key but keeps it in memory for the session", () => {
    const store = fakeStore();
    const cfg = createStudioConfig({ safeStorage: fakeSafeStorage(false), store });
    const res = cfg.saveConfig({ baseUrl: "https://x.example", model: "m", apiKey: "sk-mem" });
    assert.strictEqual(res.keyPersisted, false);
    assert.strictEqual(store.get("studio.apiKeyEnc"), undefined, "must not persist key");
    assert.strictEqual(cfg.loadConfig().apiKey, "sk-mem", "in-memory key available");
  });
});

describe("studio-config validation", () => {
  it("rejects a non-https baseUrl", () => {
    const cfg = createStudioConfig({ safeStorage: fakeSafeStorage(true), store: fakeStore() });
    assert.throws(() => cfg.saveConfig({ baseUrl: "http://insecure", model: "m", apiKey: "k" }), /https/);
  });

  it("loadConfig tolerates an empty store", () => {
    const cfg = createStudioConfig({ safeStorage: fakeSafeStorage(true), store: fakeStore() });
    const loaded = cfg.loadConfig();
    assert.strictEqual(loaded.baseUrl, "");
    assert.strictEqual(loaded.apiKey, "");
  });
});

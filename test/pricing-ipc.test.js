"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { registerPricingIpc } = require("../src/pricing-ipc");

function fakeIpc() {
  const handlers = {};
  return {
    handle: (ch, fn) => { handlers[ch] = fn; },
    _invoke: (ch, ...a) => handlers[ch](...a),
    _channels: () => Object.keys(handlers),
  };
}

describe("pricing ipc", () => {
  it("registers status + refresh and proxies to the updater", async () => {
    const ipc = fakeIpc();
    const calls = [];
    const updater = {
      getStatus: () => ({ enabled: true, lastFetchedAt: "t", sources: { litellm: { ok: true } } }),
      refreshNow: async () => { calls.push("refresh"); return { enabled: true, lastFetchedAt: "t2", sources: {} }; },
    };
    registerPricingIpc({ ipcMain: ipc, updater });

    assert.deepEqual(ipc._channels().sort(), ["pricing:get-status", "pricing:refresh-now"]);
    assert.equal((await ipc._invoke("pricing:get-status")).enabled, true);
    assert.equal((await ipc._invoke("pricing:refresh-now")).lastFetchedAt, "t2");
    assert.deepEqual(calls, ["refresh"]);
  });
});

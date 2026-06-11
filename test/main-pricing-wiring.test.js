"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

describe("main pricing wiring", () => {
  it("reprices usage aggregates after a live pricing reload", () => {
    assert.match(mainSource, /onPricingReloaded:\s*\(\)\s*=>\s*\{[\s\S]*usageAnalytics\.reprice\(\)/);
  });

  it("loads cached pricing before replaying the usage ledger", () => {
    const initIndex = mainSource.indexOf("pricingUpdater.init();");
    const ledgerIndex = mainSource.indexOf("initUsageLedger();");
    assert.ok(initIndex >= 0);
    assert.ok(ledgerIndex >= 0);
    assert.ok(initIndex < ledgerIndex);
  });
});

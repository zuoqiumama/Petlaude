"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

describe("main official rate-limit wiring", () => {
  it("adds cached official limits to usage snapshots and manages the Codex runtime", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

    assert.match(source, /createOfficialRateLimitStore/);
    assert.match(source, /officialRateLimits:\s*officialRateLimitStore\.getSnapshot\(\)/);
    assert.match(source, /recordOfficialRateLimits/);
    assert.match(source, /createCodexRateLimitRuntime/);
    assert.match(source, /codexRateLimitRuntime\.start\(\)/);
    assert.match(source, /codexRateLimitRuntime\.stop\(\)/);
  });
});

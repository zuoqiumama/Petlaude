"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { describe, it } = require("node:test");

const { handleRateLimitsPost, MAX_RATE_LIMITS_BODY_BYTES } = require("../src/server-route-rate-limits");

function invoke(body, ctx = {}) {
  const req = new EventEmitter();
  const response = { statusCode: null, headers: null, body: "" };
  const res = {
    writeHead(statusCode, headers) {
      response.statusCode = statusCode;
      response.headers = headers || {};
    },
    end(value = "") {
      response.body = value;
    },
  };
  handleRateLimitsPost(req, res, { ctx });
  req.emit("data", Buffer.from(body));
  req.emit("end");
  return response;
}

describe("official rate-limit HTTP route", () => {
  it("accepts Claude statusLine limits for enabled agents", () => {
    const recorded = [];
    const response = invoke(JSON.stringify({
      agent_id: "claude-code",
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 1_738_425_600 },
      },
    }), {
      isAgentEnabled: () => true,
      recordOfficialRateLimits: (payload) => recorded.push(payload),
    });

    assert.strictEqual(response.statusCode, 200);
    assert.deepStrictEqual(recorded, [{
      agent_id: "claude-code",
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 1_738_425_600 },
      },
    }]);
  });

  it("drops updates when Claude Code is disabled", () => {
    let recorded = false;
    const response = invoke(JSON.stringify({
      agent_id: "claude-code",
      rate_limits: { five_hour: { used_percentage: 20, resets_at: 1_738_425_600 } },
    }), {
      isAgentEnabled: () => false,
      recordOfficialRateLimits: () => { recorded = true; },
    });

    assert.strictEqual(response.statusCode, 204);
    assert.strictEqual(recorded, false);
  });

  it("rejects malformed and oversized payloads", () => {
    assert.strictEqual(invoke("not-json").statusCode, 400);
    assert.strictEqual(invoke("x".repeat(MAX_RATE_LIMITS_BODY_BYTES + 1)).statusCode, 413);
  });
});

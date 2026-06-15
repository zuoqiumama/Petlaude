"use strict";

const {
  CLAWD_SERVER_HEADER,
  CLAWD_SERVER_ID,
} = require("../hooks/server-config");

const MAX_RATE_LIMITS_BODY_BYTES = 4096;

function handleRateLimitsPost(req, res, options = {}) {
  const ctx = options.ctx || {};
  let body = "";
  let size = 0;
  let tooLarge = false;
  req.on("data", (chunk) => {
    if (tooLarge) return;
    size += chunk.length;
    if (size > MAX_RATE_LIMITS_BODY_BYTES) {
      tooLarge = true;
      return;
    }
    body += chunk;
  });
  req.on("end", () => {
    if (tooLarge) {
      res.writeHead(413, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
      res.end("rate-limit payload too large");
      return;
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      res.writeHead(400, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
      res.end("bad json");
      return;
    }
    const agentId = data && data.agent_id;
    if (agentId !== "claude-code" || !data.rate_limits || typeof data.rate_limits !== "object") {
      res.writeHead(400, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
      res.end("invalid rate-limit payload");
      return;
    }
    if (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(agentId)) {
      res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
      res.end();
      return;
    }
    if (typeof ctx.recordOfficialRateLimits !== "function") {
      res.writeHead(503, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
      res.end("rate-limit store unavailable");
      return;
    }
    try {
      ctx.recordOfficialRateLimits(data);
      res.writeHead(200, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
      res.end("ok");
    } catch {
      res.writeHead(400, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
      res.end("invalid rate-limit payload");
    }
  });
}

module.exports = {
  MAX_RATE_LIMITS_BODY_BYTES,
  handleRateLimitsPost,
};

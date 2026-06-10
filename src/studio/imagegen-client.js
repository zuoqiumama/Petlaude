"use strict";

// ── Image-gen client ─────────────────────────────────────────────────────────
// Provider-agnostic client for OpenAI-compatible image generation endpoints
// (POST <baseUrl>/v1/images/generations). The API key is sent only in the
// Authorization header and is never logged. `httpPost` is injectable for tests;
// the default uses Node https.
//
// generateImage(params, deps?) → Promise<string imageUrl>

const https = require("https");

const MAX_RESPONSE_BYTES = 256 * 1024; // JSON response (url, not image bytes)
const DEFAULT_TIMEOUT_MS = 240000;

function typedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function defaultHttpPost(url, { headers, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(typedError("IMAGEGEN_BAD_URL", `invalid url: ${url}`));
      return;
    }
    const data = Buffer.from(body || "", "utf8");
    const req = https.request(
      {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        headers: { ...headers, "Content-Length": data.length },
      },
      (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (c) => {
          total += c.length;
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy();
            reject(typedError("IMAGEGEN_RESPONSE_TOO_LARGE", "response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", (e) => reject(typedError("IMAGEGEN_NETWORK", e.message)));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(typedError("IMAGEGEN_TIMEOUT", "request timed out"));
    });
    req.write(data);
    req.end();
  });
}

function requireStr(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw typedError("IMAGEGEN_BAD_PARAM", `${name} is required`);
  }
  return value.trim();
}

function parseImageUrl(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw typedError("IMAGEGEN_BAD_JSON", "response was not valid JSON");
  }
  const entry = json && Array.isArray(json.data) ? json.data[0] : null;
  const url = entry && typeof entry.url === "string" ? entry.url : null;
  if (!url) throw typedError("IMAGEGEN_NO_IMAGE", "response contained no image url");
  return url;
}

async function generateImage(params = {}, deps = {}) {
  const httpPost = typeof deps.httpPost === "function" ? deps.httpPost : defaultHttpPost;
  const baseUrl = requireStr(params.baseUrl, "baseUrl").replace(/\/+$/, "");
  const apiKey = requireStr(params.apiKey, "apiKey");
  const model = requireStr(params.model, "model");
  const prompt = requireStr(params.prompt, "prompt");

  let parsedBase;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw typedError("IMAGEGEN_BAD_URL", "baseUrl is not a valid URL");
  }
  if (parsedBase.protocol !== "https:") {
    throw typedError("IMAGEGEN_INSECURE_URL", "baseUrl must use https");
  }

  const body = JSON.stringify({
    model,
    prompt,
    image: Array.isArray(params.images) ? params.images : [],
    size: params.size || "1024x1024",
    response_format: "url",
  });

  const res = await httpPost(`${baseUrl}/v1/images/generations`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body,
    timeoutMs: params.timeoutMs,
  });

  if (!res || res.status !== 200) {
    const status = res ? res.status : "no response";
    // Note: deliberately does not include the request (which carries the key).
    throw typedError("IMAGEGEN_HTTP_ERROR", `image generation failed (HTTP ${status})`);
  }
  return parseImageUrl(res.text);
}

module.exports = { generateImage };

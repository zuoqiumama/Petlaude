"use strict";

// ── Image-gen client ─────────────────────────────────────────────────────────
// Client for OpenAI-compatible image endpoints. Prompt-only requests use
// /images/generations; reference-image requests use multipart /images/edits.
// GPT Image returns base64 image data by default, while older compatible
// providers may still return a URL, so both response shapes are accepted.
//
// generateImage(params, deps?) → Promise<string imageUrl>

const https = require("https");

// GPT Image returns the generated PNG inside JSON as base64 by default. Keep
// enough headroom for the runtime's 24 MB decoded-image limit plus base64 and
// JSON overhead.
const MAX_RESPONSE_BYTES = 40 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 240000;

function typedError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// The client always appends its own "/v1/images/..." path. OpenAI's documented
// convention, however, is baseURL = "https://api.openai.com/v1", so users
// routinely configure a base that already ends in /v1 — which used to yield
// "/v1/v1/images/..." and a hard HTTP 404. Strip trailing slashes and a single
// trailing /v1 so both "https://host" and "https://host/v1" resolve identically.
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl == null ? "" : baseUrl)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/i, "");
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
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body || "", "utf8");
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

function parseImageSource(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw typedError("IMAGEGEN_BAD_JSON", "response was not valid JSON");
  }
  const entry = json && Array.isArray(json.data) ? json.data[0] : null;
  const url = entry && typeof entry.url === "string" ? entry.url : null;
  if (url) return url;
  const encoded = entry && typeof entry.b64_json === "string" ? entry.b64_json : null;
  if (encoded) {
    const format = String(json.output_format || json.format || "png").toLowerCase();
    const mime = format === "jpg" || format === "jpeg" ? "image/jpeg" : `image/${format}`;
    return `data:${mime};base64,${encoded}`;
  }
  throw typedError("IMAGEGEN_NO_IMAGE", "response contained no image payload");
}

// Pull a short, human-readable reason out of an error response body. The
// response body never carries the API key (only the request's Authorization
// header does, which is never included here), so it is safe to surface — and it
// is usually the actual cause of a 400: moderation, unsupported size, a rejected
// input image, a rate limit, an unknown model, … Handles OpenAI-style
// { error: { message } }, flat { error } / { message }, and raw text.
function summarizeErrorBody(text) {
  const raw = String(text == null ? "" : text).trim();
  if (!raw) return "";
  let message = raw;
  try {
    const json = JSON.parse(raw);
    const err = json && json.error;
    if (err && typeof err === "object" && typeof err.message === "string") message = err.message;
    else if (typeof err === "string") message = err;
    else if (json && typeof json.message === "string") message = json.message;
  } catch { /* not JSON — fall back to the raw text */ }
  message = message.replace(/\s+/g, " ").trim();
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

function parseDataUrl(value, index) {
  const match = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([a-z0-9+/=\r\n]+)$/i.exec(String(value || ""));
  if (!match) throw typedError("IMAGEGEN_BAD_IMAGE", `images[${index}] must be a base64 image data URL`);
  const mime = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  const data = Buffer.from(match[2].replace(/\s+/g, ""), "base64");
  if (data.length === 0) throw typedError("IMAGEGEN_BAD_IMAGE", `images[${index}] is empty`);
  const ext = mime === "image/jpeg" ? "jpg" : mime.slice("image/".length);
  return { mime, data, filename: `reference-${index + 1}.${ext}` };
}

function buildMultipartBody({ model, prompt, size, quality, background, images }) {
  const boundary = `----clawd-studio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const parts = [];
  function push(value) {
    parts.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
  }
  function field(name, value) {
    push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  field("model", model);
  field("prompt", prompt);
  field("size", size);
  field("output_format", "png");
  if (quality) field("quality", quality);
  if (background) field("background", background);
  images.forEach((value, index) => {
    const image = parseDataUrl(value, index);
    push(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="${image.filename}"\r\nContent-Type: ${image.mime}\r\n\r\n`);
    push(image.data);
    push("\r\n");
  });
  push(`--${boundary}--\r\n`);
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function generateImage(params = {}, deps = {}) {
  const httpPost = typeof deps.httpPost === "function" ? deps.httpPost : defaultHttpPost;
  const baseUrl = normalizeBaseUrl(requireStr(params.baseUrl, "baseUrl"));
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

  const images = Array.isArray(params.images) ? params.images.filter(Boolean) : [];
  const size = params.size || "1024x1024";
  const quality = params.quality || null;
  const background = params.background || null;
  let endpoint;
  let body;
  let contentType;
  if (images.length > 0) {
    endpoint = "edits";
    const multipart = buildMultipartBody({ model, prompt, size, quality, background, images });
    body = multipart.body;
    contentType = multipart.contentType;
  } else {
    endpoint = "generations";
    const request = { model, prompt, size, output_format: "png" };
    if (quality) request.quality = quality;
    if (background) request.background = background;
    body = JSON.stringify(request);
    contentType = "application/json";
  }

  const res = await httpPost(`${baseUrl}/v1/images/${endpoint}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": contentType },
    body,
    timeoutMs: params.timeoutMs,
  });

  if (!res || res.status < 200 || res.status >= 300) {
    const status = res ? res.status : "no response";
    // Surface the provider's own error detail (truncated). Note: deliberately
    // never includes the request, which carries the key — only the response body.
    const detail = res ? summarizeErrorBody(res.text) : "";
    if (res && res.status === 404) {
      // Most actionable case: the path resolved but the provider has no image
      // endpoint there (a text-only OpenAI-compatible API), or the model is
      // unknown. baseUrl /v1 doubling is already handled by normalizeBaseUrl.
      throw typedError(
        "IMAGEGEN_HTTP_ERROR",
        `image generation endpoint not found (HTTP 404) — check that the provider supports image generation and the model name is correct${detail ? ` — ${detail}` : ""}`,
      );
    }
    throw typedError("IMAGEGEN_HTTP_ERROR", `image generation failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
  }
  return parseImageSource(res.text);
}

module.exports = { generateImage, MAX_RESPONSE_BYTES, normalizeBaseUrl };

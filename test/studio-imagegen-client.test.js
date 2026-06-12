"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { generateImage, MAX_RESPONSE_BYTES, normalizeBaseUrl } = require("../src/studio/imagegen-client");

function okPost(captured) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return { status: 200, text: JSON.stringify({ data: [{ b64_json: "UE5H" }], usage: { total_tokens: 10 } }) };
  };
}

describe("imagegen-client", () => {
  it("allows multi-megabyte base64 image responses", () => {
    assert.ok(MAX_RESPONSE_BYTES >= 32 * 1024 * 1024);
  });

  it("uses the multipart edits endpoint when reference images are supplied", async () => {
    const cap = {};
    const source = await generateImage({
      baseUrl: "https://api.example.com/draw",
      apiKey: "sk-secret",
      model: "gpt-image-2",
      prompt: "hello",
      images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
      size: "1024x1024",
    }, { httpPost: okPost(cap) });

    assert.strictEqual(source, "data:image/png;base64,UE5H");
    assert.strictEqual(cap.url, "https://api.example.com/draw/v1/images/edits");
    assert.strictEqual(cap.opts.headers.Authorization, "Bearer sk-secret");
    assert.match(cap.opts.headers["Content-Type"], /^multipart\/form-data; boundary=/);
    assert.ok(Buffer.isBuffer(cap.opts.body));
    const body = cap.opts.body.toString("latin1");
    assert.match(body, /name="model"\r\n\r\ngpt-image-2/);
    assert.match(body, /name="prompt"\r\n\r\nhello/);
    assert.match(body, /name="size"\r\n\r\n1024x1024/);
    assert.strictEqual((body.match(/name="image\[\]"/g) || []).length, 2);
    assert.doesNotMatch(body, /response_format/);
  });

  it("uses JSON generations for prompt-only requests and accepts URL responses", async () => {
    const cap = {};
    const httpPost = async (url, opts) => {
      cap.url = url;
      cap.opts = opts;
      return { status: 200, text: JSON.stringify({ data: [{ url: "https://img/out.png" }] }) };
    };
    const source = await generateImage({ baseUrl: "https://api.example.com/draw/", apiKey: "k", model: "m", prompt: "p" }, { httpPost });
    assert.strictEqual(source, "https://img/out.png");
    assert.strictEqual(cap.url, "https://api.example.com/draw/v1/images/generations");
    assert.strictEqual(cap.opts.headers["Content-Type"], "application/json");
    assert.deepStrictEqual(JSON.parse(cap.opts.body), {
      model: "m", prompt: "p", size: "1024x1024", output_format: "png",
    });
  });

  it("throws a typed error on non-200", async () => {
    const httpPost = async () => ({ status: 401, text: '{"error":"bad key"}' });
    await assert.rejects(
      () => generateImage({ baseUrl: "https://x", apiKey: "k", model: "m", prompt: "p" }, { httpPost }),
      (e) => e.code === "IMAGEGEN_HTTP_ERROR" && /401/.test(e.message),
    );
  });

  it("throws when the response has no image payload", async () => {
    const httpPost = async () => ({ status: 200, text: '{"data":[]}' });
    await assert.rejects(
      () => generateImage({ baseUrl: "https://x", apiKey: "k", model: "m", prompt: "p" }, { httpPost }),
      (e) => e.code === "IMAGEGEN_NO_IMAGE",
    );
  });

  it("requires baseUrl, apiKey, model, prompt", async () => {
    await assert.rejects(() => generateImage({ apiKey: "k", model: "m", prompt: "p" }, { httpPost: okPost({}) }));
    await assert.rejects(() => generateImage({ baseUrl: "https://x", model: "m", prompt: "p" }, { httpPost: okPost({}) }));
  });

  it("rejects a non-https baseUrl", async () => {
    await assert.rejects(
      () => generateImage({ baseUrl: "http://insecure", apiKey: "k", model: "m", prompt: "p" }, { httpPost: okPost({}) }),
      (e) => e.code === "IMAGEGEN_INSECURE_URL",
    );
  });

  // OpenAI's own convention is baseURL = "https://api.openai.com/v1", so users
  // routinely paste a base that already ends in /v1. The client appends its own
  // /v1/images/... path, which used to produce /v1/v1/... → HTTP 404. Normalize
  // so both "https://host" and "https://host/v1" resolve to one correct URL.
  it("does not double the /v1 segment when baseUrl already includes it", async () => {
    const cap = {};
    await generateImage(
      { baseUrl: "https://api.openai.com/v1", apiKey: "k", model: "m", prompt: "p" },
      { httpPost: okPost(cap) },
    );
    assert.strictEqual(cap.url, "https://api.openai.com/v1/images/generations");
  });

  it("normalizes a trailing /v1/ with slash for the edits endpoint too", async () => {
    const cap = {};
    await generateImage(
      { baseUrl: "https://api.openai.com/v1/", apiKey: "k", model: "m", prompt: "p", images: ["data:image/png;base64,AAA"] },
      { httpPost: okPost(cap) },
    );
    assert.strictEqual(cap.url, "https://api.openai.com/v1/images/edits");
  });

  it("gives an actionable error when the image endpoint 404s", async () => {
    const httpPost = async () => ({ status: 404, text: '{"error":"not found"}' });
    await assert.rejects(
      () => generateImage({ baseUrl: "https://api.example.com/v1", apiKey: "k", model: "m", prompt: "p" }, { httpPost }),
      (e) => e.code === "IMAGEGEN_HTTP_ERROR"
        && /404/.test(e.message)
        && /(endpoint|not found|support)/i.test(e.message),
    );
  });

  it("never leaks the api key in error messages", async () => {
    const httpPost = async () => ({ status: 404, text: '{"error":"x"}' });
    await assert.rejects(
      () => generateImage({ baseUrl: "https://x/v1", apiKey: "sk-super-secret", model: "m", prompt: "p" }, { httpPost }),
      (e) => !/sk-super-secret/.test(e.message),
    );
  });

  describe("normalizeBaseUrl", () => {
    it("strips trailing slashes and a trailing /v1 segment", () => {
      assert.strictEqual(normalizeBaseUrl("https://api.openai.com"), "https://api.openai.com");
      assert.strictEqual(normalizeBaseUrl("https://api.openai.com/"), "https://api.openai.com");
      assert.strictEqual(normalizeBaseUrl("https://api.openai.com/v1"), "https://api.openai.com");
      assert.strictEqual(normalizeBaseUrl("https://api.openai.com/v1/"), "https://api.openai.com");
      assert.strictEqual(normalizeBaseUrl("https://api.openai.com/V1"), "https://api.openai.com");
      assert.strictEqual(normalizeBaseUrl("  https://host/api/v1  "), "https://host/api");
    });

    it("leaves a non-/v1 path untouched", () => {
      assert.strictEqual(normalizeBaseUrl("https://api.example.com/draw"), "https://api.example.com/draw");
      assert.strictEqual(normalizeBaseUrl("https://host/v1beta"), "https://host/v1beta");
    });
  });
});

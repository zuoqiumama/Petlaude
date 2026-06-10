"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { generateImage } = require("../src/studio/imagegen-client");

function okPost(captured) {
  return async (url, opts) => {
    captured.url = url;
    captured.opts = opts;
    return { status: 200, text: JSON.stringify({ data: [{ url: "https://img/out.png" }], usage: { total_tokens: 10 } }) };
  };
}

describe("imagegen-client", () => {
  it("posts to /v1/images/generations with bearer auth and the expected body", async () => {
    const cap = {};
    const url = await generateImage({
      baseUrl: "https://api.example.com/draw",
      apiKey: "sk-secret",
      model: "gpt-image-2",
      prompt: "hello",
      images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"],
      size: "1024x1024",
    }, { httpPost: okPost(cap) });

    assert.strictEqual(url, "https://img/out.png");
    assert.strictEqual(cap.url, "https://api.example.com/draw/v1/images/generations");
    assert.strictEqual(cap.opts.headers.Authorization, "Bearer sk-secret");
    assert.strictEqual(cap.opts.headers["Content-Type"], "application/json");
    const body = JSON.parse(cap.opts.body);
    assert.strictEqual(body.model, "gpt-image-2");
    assert.strictEqual(body.prompt, "hello");
    assert.strictEqual(body.size, "1024x1024");
    assert.strictEqual(body.response_format, "url");
    assert.deepStrictEqual(body.image, ["data:image/png;base64,AAA", "data:image/png;base64,BBB"]);
  });

  it("trims a trailing slash on baseUrl", async () => {
    const cap = {};
    await generateImage({ baseUrl: "https://api.example.com/draw/", apiKey: "k", model: "m", prompt: "p" }, { httpPost: okPost(cap) });
    assert.strictEqual(cap.url, "https://api.example.com/draw/v1/images/generations");
  });

  it("throws a typed error on non-200", async () => {
    const httpPost = async () => ({ status: 401, text: '{"error":"bad key"}' });
    await assert.rejects(
      () => generateImage({ baseUrl: "https://x", apiKey: "k", model: "m", prompt: "p" }, { httpPost }),
      (e) => e.code === "IMAGEGEN_HTTP_ERROR" && /401/.test(e.message),
    );
  });

  it("throws when the response has no image url", async () => {
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
});

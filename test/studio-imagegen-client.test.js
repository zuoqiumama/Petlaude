"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const { generateImage, MAX_RESPONSE_BYTES } = require("../src/studio/imagegen-client");

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
});

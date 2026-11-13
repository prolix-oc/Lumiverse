import { afterEach, describe, expect, test } from "bun:test";
import type { ImageGenRequest } from "../types";
import { CustomOpenAiImageProvider } from "./custom-openai";
import { TogetherImageProvider } from "./together";
import { XaiImageProvider } from "./xai";
import { VeniceCompatImageProvider } from "./venice-compat";
import { RecraftImageProvider } from "./recraft";
import { DeepInfraImageProvider } from "./deepinfra";

/**
 * Record outgoing fetch calls and reply with a queued script of responses.
 * A response can be JSON, or `{ raw }` for a binary/plain-text body.
 */
function stubFetch(responses: Array<{ json?: any; status?: number; raw?: string; contentType?: string }>) {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    calls.push({
      url: String(input),
      method: init?.method || "GET",
      body,
      headers: (init?.headers as Record<string, string>) || {},
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next.raw !== undefined) {
      return new Response(next.raw, {
        status: next.status ?? 200,
        headers: { "Content-Type": next.contentType || "image/png" },
      });
    }
    return new Response(JSON.stringify(next.json ?? {}), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function req(model: string, parameters: Record<string, any> = {}): ImageGenRequest {
  return { prompt: "a fox", negativePrompt: "blurry", model, parameters };
}

describe("OpenAI-compatible image providers", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("Together posts to /images/generations with steps and downloads url results", async () => {
    fetchStub = stubFetch([
      { json: { data: [{ url: "https://cdn.together/img.png" }] } },
      { raw: "PNGDATA", contentType: "image/png" },
    ]);
    const provider = new TogetherImageProvider();
    const result = await provider.generate("key", "https://api.together.xyz/v1", req("black-forest-labs/FLUX.1-dev", { size: "1024x1024", steps: 4 }));

    expect(fetchStub.calls[0].url).toBe("https://api.together.xyz/v1/images/generations");
    expect(fetchStub.calls[0].headers.Authorization).toBe("Bearer key");
    expect(fetchStub.calls[0].body.model).toBe("black-forest-labs/FLUX.1-dev");
    expect(fetchStub.calls[0].body.steps).toBe(4);
    // Together's inline format is `base64`, not OpenAI's `b64_json`, and the
    // size is sent as width/height rather than a `size` string.
    expect(fetchStub.calls[0].body.response_format).toBe("base64");
    expect(fetchStub.calls[0].body.width).toBe(1024);
    expect(fetchStub.calls[0].body.height).toBe(1024);
    expect(fetchStub.calls[0].body.size).toBeUndefined();
    expect(fetchStub.calls[0].body.negative_prompt).toBe("blurry");
    expect(result.imageDataUrl).toBe(`data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`);
  });

  test.each(["black-forest-labs/FLUX.2-dev", "black-forest-labs/FLUX.1-kontext-pro"])("Together routes a single reference for %s", async (model) => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "QUJD" }] } }]);
    await new TogetherImageProvider().generate("key", "", req(model, { resolvedSourceImages: [{ data: "QUJD", mimeType: "image/png" }] }));
    const body = fetchStub.calls[0].body;
    if (model.includes("kontext")) expect(body.image_url).toBe("data:image/png;base64,QUJD");
    else expect(body.reference_images).toEqual(["data:image/png;base64,QUJD"]);
  });

  test("Together tolerates a pasted /images/generations endpoint", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new TogetherImageProvider();
    await provider.generate("key", "https://api.together.xyz/v1/images/generations", req("x"));
    expect(fetchStub.calls[0].url).toBe("https://api.together.xyz/v1/images/generations");
  });

  test("xAI sends aspect_ratio/resolution (its own shape, not OpenAI `size`)", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new XaiImageProvider();
    await provider.generate("key", "https://api.x.ai/v1", req("grok-imagine-image-2.0", { aspectRatio: "16:9", resolution: "2k" }));

    expect(fetchStub.calls[0].url).toBe("https://api.x.ai/v1/images/generations");
    const body = fetchStub.calls[0].body;
    expect(body.model).toBe("grok-imagine-image-2.0");
    expect(body.aspect_ratio).toBe("16:9");
    expect(body.resolution).toBe("2k");
    expect(body.size).toBeUndefined();
    expect(body.response_format).toBe("b64_json");
  });

  test("xAI posts JSON to /images/edits (not multipart) with a data-URL source", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new XaiImageProvider();
    await provider.generate("key", "https://api.x.ai/v1", req("grok-imagine-image-2.0", { resolvedSourceImages: [{ data: "YWJj", mimeType: "image/png" }] }));

    expect(fetchStub.calls[0].url).toBe("https://api.x.ai/v1/images/edits");
    const body = fetchStub.calls[0].body;
    expect(body.image).toEqual({ url: "data:image/png;base64,YWJj" });
    expect(body.images).toBeUndefined();
  });

  test("xAI uses images[] for multi-reference edits", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new XaiImageProvider();
    await provider.generate("key", "https://api.x.ai/v1", req("grok-imagine-image-2.0", {
      resolvedSourceImages: [{ data: "YWJj", mimeType: "image/png" }, { data: "ZGVm", mimeType: "image/png" }],
    }));
    const body = fetchStub.calls[0].body;
    expect(body.image).toBeUndefined();
    expect(body.images).toHaveLength(2);
    expect(body.images[0].url).toBe("data:image/png;base64,YWJj");
  });

  test("DeepInfra defaults to a static image model and forwards seed", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new DeepInfraImageProvider();
    await provider.generate("key", "https://api.deepinfra.com/v1/openai", { prompt: "a fox", model: "", parameters: { seed: 7 } });
    expect(fetchStub.calls[0].body.model).toBe("black-forest-labs/FLUX-1-schnell");
    expect(fetchStub.calls[0].body.seed).toBe(7);
  });

  test("Recraft forwards style and seed as extra body fields", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new RecraftImageProvider();
    await provider.generate("key", "https://external.api.recraft.ai/v1", req("recraftv4_1", { style: "digital_illustration", seed: 3 }));
    expect(fetchStub.calls[0].body.style).toBe("digital_illustration");
    expect(fetchStub.calls[0].body.seed).toBe(3);
  });

  test("Venice compat posts to the compatibility base and forwards seed", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new VeniceCompatImageProvider();
    await provider.generate("key", "https://api.venice.ai/api/v1", req("venice-sd35", { seed: 9 }));
    expect(fetchStub.calls[0].url).toBe("https://api.venice.ai/api/v1/images/generations");
    expect(fetchStub.calls[0].body.seed).toBe(9);
  });

  test("Venice compat validates the key against an authenticated endpoint, not the public models list", async () => {
    fetchStub = stubFetch([{ json: { data: {} } }]);
    const provider = new VeniceCompatImageProvider();
    await expect(provider.validateKey("key", "https://api.venice.ai/api/v1")).resolves.toBe(true);
    expect(fetchStub.calls[0].url).toBe("https://api.venice.ai/api/v1/api_keys/rate_limits");
  });

  test("Custom OpenAI-compatible forwards steps, seed, and negative_prompt", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new CustomOpenAiImageProvider();
    await provider.generate("key", "https://proxy.example/v1", {
      prompt: "a fox",
      negativePrompt: "blurry",
      model: "flux-1",
      parameters: { steps: 20, seed: 5, negative_prompt: "low quality" },
    });
    const body = fetchStub.calls[0].body;
    expect(body.steps).toBe(20);
    expect(body.seed).toBe(5);
    expect(body.negative_prompt).toBe("low quality");
  });

  test("raw override cannot swap the model on an OpenAI-compatible provider", async () => {
    fetchStub = stubFetch([{ json: { data: [{ b64_json: "aGVsbG8=" }] } }]);
    const provider = new CustomOpenAiImageProvider();
    await provider.generate("key", "https://proxy.example/v1", req("safe-model", { rawRequestOverride: JSON.stringify({ model: "evil", size: "512x512" }) }));
    expect(fetchStub.calls[0].body.model).toBe("safe-model");
    expect(fetchStub.calls[0].body.size).toBe("512x512");
  });
});

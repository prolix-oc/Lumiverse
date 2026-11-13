import { afterEach, describe, expect, test } from "bun:test";
import { NanoGPTImageProvider } from "./nanogpt";
import type { ImageGenRequest } from "../types";

function stubFetch() {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers as Record<string, string>) || {},
    });
    return new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
      status: 200,
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

function req(parameters: Record<string, any> = {}): ImageGenRequest {
  return { prompt: "restyle this image", model: "flux-kontext", parameters };
}

describe("NanoGPTImageProvider", () => {
  const provider = new NanoGPTImageProvider();
  let fetchStub: ReturnType<typeof stubFetch>;

  afterEach(() => fetchStub?.restore());

  test("sends one reference through NanoGPT's single-image field", async () => {
    fetchStub = stubFetch();

    const result = await provider.generate(
      "key",
      "https://nano-gpt.com/v1",
      req({
        referenceImages: [{ data: "QUJD", mimeType: "image/jpeg" }],
        strength: 0.45,
        guidanceScale: 6,
        numInferenceSteps: 24,
        seed: 42,
      }),
    );

    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0];
    expect(call.url).toBe("https://nano-gpt.com/v1/images/generations");
    expect(call.body.imageDataUrl).toBe("data:image/jpeg;base64,QUJD");
    expect(call.body.imageDataUrls).toBeUndefined();
    expect(call.body.strength).toBe(0.45);
    expect(call.body.guidance_scale).toBe(6);
    expect(call.body.num_inference_steps).toBe(24);
    expect(call.body.seed).toBe(42);
    expect(result.imageDataUrl).toBe("data:image/png;base64,aGVsbG8=");
  });

  test("sends multiple references through NanoGPT's multi-image field", async () => {
    fetchStub = stubFetch();

    await provider.generate(
      "key",
      "https://nano-gpt.com/v1",
      req({
        referenceImages: [
          { data: "QUJD", mimeType: "image/png" },
          { data: "data:image/webp;base64,REVG", mimeType: "image/jpeg" },
        ],
      }),
    );

    const body = fetchStub.calls[0].body;
    expect(body.imageDataUrl).toBeUndefined();
    expect(body.imageDataUrls).toEqual([
      "data:image/png;base64,QUJD",
      "data:image/webp;base64,REVG",
    ]);
  });

  test("omits image guidance fields when there is no usable reference", async () => {
    fetchStub = stubFetch();

    await provider.generate(
      "key",
      "https://nano-gpt.com/v1",
      req({ referenceImages: [{ data: "" }, null], strength: 0.8, seed: 7 }),
    );

    const body = fetchStub.calls[0].body;
    expect(body.imageDataUrl).toBeUndefined();
    expect(body.imageDataUrls).toBeUndefined();
    expect(body.strength).toBeUndefined();
    expect(body.seed).toBeUndefined();
  });
});

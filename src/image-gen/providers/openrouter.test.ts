import { afterEach, describe, expect, test } from "bun:test";
import { OpenRouterImageProvider } from "./openrouter";
import type { ImageGenRequest } from "../types";

function stubFetch() {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(input), body, headers: (init?.headers as Record<string, string>) || {} });
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              images: [{ type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } }],
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const BASE = "https://openrouter.ai/api/v1";

function req(model: string, parameters: Record<string, any> = {}): ImageGenRequest {
  return { prompt: "a fox", model, parameters };
}

describe("OpenRouterImageProvider", () => {
  const provider = new OpenRouterImageProvider();
  let fetchStub: ReturnType<typeof stubFetch>;

  afterEach(() => fetchStub?.restore());

  test("uses image-only modalities for Flux and Grok Imagine models", async () => {
    fetchStub = stubFetch();

    await provider.generate("key", BASE, req("black-forest-labs/flux.2-flex"));
    await provider.generate("key", BASE, req("x-ai/grok-imagine-image-quality"));
    await provider.generate("key", BASE, req("x-ai/grok-2-image"));

    expect(fetchStub.calls[0].body.modalities).toEqual(["image"]);
    expect(fetchStub.calls[1].body.modalities).toEqual(["image"]);
    expect(fetchStub.calls[2].body.modalities).toEqual(["image"]);
  });

  test("keeps image and text modalities for multimodal output models", async () => {
    fetchStub = stubFetch();

    await provider.generate("key", BASE, req("google/gemini-2.5-flash-image"));

    expect(fetchStub.calls[0].body.modalities).toEqual(["image", "text"]);
  });

  test("rawRequestOverride can still force modalities", async () => {
    fetchStub = stubFetch();

    await provider.generate(
      "key",
      BASE,
      req("google/gemini-2.5-flash-image", {
        rawRequestOverride: JSON.stringify({ modalities: ["image"] }),
      }),
    );

    expect(fetchStub.calls[0].body.modalities).toEqual(["image"]);
  });
});

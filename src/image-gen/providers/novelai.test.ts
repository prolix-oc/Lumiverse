import { afterEach, describe, expect, test } from "bun:test";
import { encode } from "@msgpack/msgpack";
import { NovelAIImageProvider } from "./novelai";

const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe("NovelAIImageProvider", () => {
  const provider = new NovelAIImageProvider();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("lists the V5 Full and Curated models", async () => {
    const models = await provider.listModels("", "");

    expect(models.slice(0, 2)).toEqual([
      { id: "nai-diffusion-5-full", label: "NAI Diffusion V5 (Full)" },
      { id: "nai-diffusion-5-curated", label: "NAI Diffusion V5 (Curated)" },
    ]);
  });

  test("validates persistent tokens without making a generation request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify({ accountCreatedAt: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(provider.validateKey("pst-test-token", "https://image.novelai.net")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://image.novelai.net/user/information");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer pst-test-token");
  });

  test("uses the structured V4+ prompt payload for both V5 models", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(TINY_PNG, { status: 200 });
    }) as typeof fetch;

    for (const model of ["nai-diffusion-5-full", "nai-diffusion-5-curated"]) {
      await provider.generate("pst-test-token", "https://image.novelai.net", {
        prompt: "two characters, outdoors",
        model,
        parameters: {
          characterTags: [{ tags: "1girl, red hair" }],
          smea: true,
        },
      });
    }

    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.parameters.characterPrompts).toHaveLength(1);
      expect(body.parameters.v4_prompt.caption.base_caption).toBe("two characters, outdoors");
      expect(body.parameters.v4_prompt.caption.char_captions[0].char_caption).toBe("1girl, red hair");
      expect(body.parameters.v4_negative_prompt.caption.char_captions).toHaveLength(1);
      expect(body.parameters.autoSmea).toBe(true);
      expect(body.parameters.sm).toBeUndefined();
      expect(body.parameters.sm_dyn).toBeUndefined();
    }
  });

  test("surfaces HTTP-200 MessagePack error events", async () => {
    globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      encode({ event_type: "error", message: "Invalid request: v4_prompt is required" }),
      { status: 200, headers: { "Content-Type": "application/msgpack" } },
    )) as typeof fetch;

    await expect(provider.generate("pst-test-token", "https://image.novelai.net", {
      prompt: "a fox",
      model: "nai-diffusion-5-full",
      parameters: {},
    })).rejects.toThrow("Invalid request: v4_prompt is required");
  });
});

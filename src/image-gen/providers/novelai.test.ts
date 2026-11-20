import { afterEach, describe, expect, test } from "bun:test";
import { zipSync } from "fflate";
import { encode } from "@msgpack/msgpack";
import sharp from "../../utils/sharp-config";
import { NovelAIImageProvider } from "./novelai";

const TINY_PNG = new Uint8Array(await sharp({
  create: { width: 1, height: 1, channels: 3, background: { r: 20, g: 40, b: 60 } },
}).png().toBuffer());

describe("NovelAIImageProvider", () => {
  const provider = new NovelAIImageProvider();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });


  for (const nonStreaming of [false, true]) {
    for (const raw of [false, true]) {
      for (const seed of [undefined, null, -1, -42, NaN, Infinity, 1.5, "42", 0, 42, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
        test(`final seed ${String(seed)}, raw=${raw}, nonStreaming=${nonStreaming}`, async () => {
          const bodies: any[] = [];
          globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(TINY_PNG);
          }) as typeof fetch;
          await provider.generate("offline-token", "https://example.test", {
            prompt: "synthetic fox", model: "nai-diffusion-5-full",
            parameters: raw
              ? { seed: 77, rawRequestOverride: JSON.stringify({ input: "override", parameters: { seed, steps: 12 } }) }
              : seed === undefined ? {} : { seed },
            connectionOptions: { novelai: { nonStreaming } },
          });
          expect(bodies).toHaveLength(1);
          const actual = bodies[0].parameters.seed;
          if (raw && seed === undefined) expect(actual).toBe(77);
          else if (typeof seed === "number" && Number.isSafeInteger(seed) && seed >= 0) expect(actual).toBe(seed);
          else {
            expect(Number.isSafeInteger(actual)).toBe(true);
            expect(actual).toBeGreaterThanOrEqual(0);
            expect(actual).toBeLessThan(2147483647);
          }
          if (raw) {
            expect(bodies[0].input).toBe("override");
            expect(bodies[0].parameters.steps).toBe(12);
          }
        });
      }
    }
  }

  test("replaces a merged connection-default seed of -1 without touching other defaults", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(TINY_PNG);
    }) as typeof fetch;

    // Mirrors the Spindle image path, where saved connection defaults are merged into
    // the request before the provider runs, so a stored seed of -1 reaches this boundary.
    await provider.generate("offline-token", "https://example.test", {
      prompt: "synthetic fox",
      model: "nai-diffusion-4-5-full",
      parameters: { seed: -1, steps: 19, sampler: "k_euler" },
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].parameters.seed).not.toBe(-1);
    expect(Number.isSafeInteger(bodies[0].parameters.seed)).toBe(true);
    expect(bodies[0].parameters.seed).toBeGreaterThanOrEqual(0);
    expect(bodies[0].parameters.steps).toBe(19);
    expect(bodies[0].parameters.sampler).toBe("k_euler");
  });

  test("lists the V5 Full and Curated models", async () => {
    const models = await provider.listModels("", "");

    expect(models.slice(0, 2)).toEqual([
      { id: "nai-diffusion-5-full", label: "NAI Diffusion V5 (Full)" },
      { id: "nai-diffusion-5-curated", label: "NAI Diffusion V5 (Curated)" },
    ]);
  });

  test("exposes Anime and Furry modes only for V5 models", () => {
    expect(provider.capabilities.parameters.v5Mode).toMatchObject({
      type: "select",
      default: "anime",
      modelPrefixes: ["nai-diffusion-5"],
      options: [
        { id: "anime", label: "Anime" },
        { id: "furry", label: "Furry" },
      ],
    });
  });

  test("applies V5 Furry mode as a dataset tag and omits unsupported references", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(TINY_PNG);
    }) as typeof fetch;

    await provider.generate("token", "", {
      prompt: "1girl, fox ears",
      model: "nai-diffusion-5-full",
      parameters: {
        v5Mode: "furry",
        resolvedReferenceImages: [{
          data: "raw-reference-image",
          strength: 0.7,
          infoExtracted: 0.8,
          refType: "character&style",
        }],
      },
    });

    expect(bodies).toHaveLength(1);
    const body = bodies[0];
    expect(body.input).toBe("fur dataset, 1girl, fox ears");
    expect(body.parameters.params_version).toBe(4);
    expect(body.parameters.prompt).toBe("fur dataset, 1girl, fox ears");
    expect(body.parameters.v4_prompt.caption.base_caption).toBe("fur dataset, 1girl, fox ears");
    expect(body.parameters.v5Mode).toBeUndefined();
    expect(body.parameters.director_reference_images).toBeUndefined();
    expect(body.parameters.reference_image_multiple).toBeUndefined();
  });

  test("does not duplicate an explicit V5 dataset tag or apply V5 mode to V4.5", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(TINY_PNG);
    }) as typeof fetch;

    for (const [model, prompt] of [
      ["nai-diffusion-5-curated", "fur dataset, wolf"],
      ["nai-diffusion-5-full", "background dataset, forest"],
      ["nai-diffusion-4-5-full", "1girl, fox ears"],
    ]) {
      await provider.generate("token", "", {
        prompt,
        model,
        parameters: { v5Mode: "furry" },
      });
    }

    expect(bodies.map((body) => body.input)).toEqual([
      "fur dataset, wolf",
      "background dataset, forest",
      "1girl, fox ears",
    ]);
    expect(bodies.map((body) => body.parameters.params_version)).toEqual([4, 4, 3]);
  });

  test("keeps the existing Precise Reference payload for V4.5", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(TINY_PNG);
    }) as typeof fetch;

    await provider.generate("token", "", {
      prompt: "1girl",
      model: "nai-diffusion-4-5-full",
      parameters: {
        referenceFidelity: 0.75,
        resolvedReferenceImages: [{
          data: Buffer.from(TINY_PNG).toString("base64"),
          strength: 0.7,
          infoExtracted: 0.8,
          refType: "character",
        }],
      },
    });

    const parameters = bodies[0].parameters;
    expect(parameters.director_reference_images).toHaveLength(1);
    expect(parameters.director_reference_strength_values).toEqual([0.7]);
    expect(parameters.director_reference_secondary_strength_values).toEqual([0.25]);
    expect(parameters.director_reference_information_extracted).toEqual([1]);
    expect(parameters.director_reference_descriptions[0].caption.base_caption).toBe("character");
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

    await expect(provider.validateKey("pst-test-token", "")).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://image.novelai.net/user/information");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer pst-test-token");
  });

  for (const [baseUrl, expectedUrl] of [
    ["https://image.novelai.net", "https://image.novelai.net/user/information"],
    [" https://proxy.example/root/ ", "https://proxy.example/root/user/information"],
  ]) {
    test(`validates saved base URL ${baseUrl} without generating`, async () => {
      const calls: string[] = [];
      globalThis.fetch = (async (_input: RequestInfo | URL) => {
        calls.push(String(_input));
        return new Response("{}");
      }) as typeof fetch;
      await expect(provider.validateKey("token", baseUrl)).resolves.toBe(true);
      expect(calls).toEqual([expectedUrl]);
    });
  }

  test("preserves the existing proxy base URL contract", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(TINY_PNG, { status: 200 });
    }) as typeof fetch;

    await provider.generate("pst-test-token", " https://nai-proxy.example/root/ ", {
      prompt: "a fox",
      model: "nai-diffusion-5-full",
      parameters: {},
    });

    expect(calls).toEqual(["https://nai-proxy.example/root/ai/generate-image-stream"]);
  });

  for (const nonStreaming of [undefined, false, true]) {
    for (const baseUrl of ["", "https://image.novelai.net", " https://proxy.example/root/ "]) {
      test(`selects transport from the profile (${nonStreaming}) for ${baseUrl || "the default URL"}`, async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          calls.push({ url: String(input), init });
          return new Response(TINY_PNG);
        }) as typeof fetch;
        await provider.generate("token", baseUrl, {
          prompt: "a fox", model: "nai-diffusion-5-full",
          connectionOptions: nonStreaming === undefined ? undefined : { novelai: { nonStreaming } },
          parameters: {
            // Per-image parameters and raw overrides cannot change connection transport.
            nonStreaming: !nonStreaming,
            rawRequestOverride: JSON.stringify({ parameters: { stream: "override", steps: 12 } }),
          },
        });
        expect(calls).toHaveLength(1);
        const base = baseUrl.includes("proxy") ? "https://proxy.example/root" : "https://image.novelai.net";
        expect(calls[0].url).toBe(`${base}/ai/generate-image${nonStreaming ? "" : "-stream"}`);
        expect(calls[0].init?.method).toBe("POST");
        expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer token");
        const body = JSON.parse(String(calls[0].init?.body));
        expect(body.parameters.stream).toBe(nonStreaming ? undefined : "msgpack");
        expect(body.parameters.steps).toBe(12);
        expect(body.connectionOptions).toBeUndefined();
        expect(body.action).toBe("generate");
      });
    }
  }

  test("uses the structured V4+ prompt payload for both V5 models", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(TINY_PNG, { status: 200 });
    }) as typeof fetch;

    for (const model of ["nai-diffusion-5-full", "nai-diffusion-5-curated"]) {
      await provider.generate("pst-test-token", "", {
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

    await expect(provider.generate("pst-test-token", "", {
      prompt: "a fox",
      model: "nai-diffusion-5-full",
      parameters: {},
    })).rejects.toThrow("Invalid request: v4_prompt is required");
  });

  test("uses the official streaming endpoint when the URL is blank", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(TINY_PNG);
    }) as typeof fetch;
    await provider.generate("token", "  ", { prompt: "a fox", model: "nai-diffusion-5-full", parameters: {} });
    expect(calls).toEqual(["https://image.novelai.net/ai/generate-image-stream"]);
  });

  test("decodes compressed ZIP images from a custom endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(new Uint8Array(zipSync({ "image_0.png": TINY_PNG }, { level: 6 })));
    }) as typeof fetch;
    const result = await provider.generate("proxy-token", "https://proxy.example", {
      prompt: "a fox", model: "nai-diffusion-5-full", parameters: {},
      connectionOptions: { novelai: { nonStreaming: true } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://proxy.example/ai/generate-image");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer proxy-token");
    expect(JSON.parse(String(calls[0].init?.body)).input).toBe("a fox");
    expect(result.imageDataUrl).toBe(`data:image/png;base64,${Buffer.from(TINY_PNG).toString("base64")}`);
  });

  test("decodes real PNGs in ZIPs with multiple DEFLATE stored blocks", async () => {
    let state = 123456789;
    const pixels = Uint8Array.from({ length: 256 * 256 * 3 }, () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state & 255;
    });
    const png = await sharp(pixels, { raw: { width: 256, height: 256, channels: 3 } }).png().toBuffer();
    const archive = zipSync({ "image_0.png": png }, { level: 6 });
    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(new Uint8Array(archive))) as typeof fetch;
    const result = await provider.generate("token", "", {
      prompt: "a fox", model: "nai-diffusion-5-full", parameters: {},
      connectionOptions: { novelai: { nonStreaming: true } },
    });
    const decoded = Buffer.from(result.imageDataUrl.split(",")[1], "base64");
    expect(decoded.equals(png)).toBe(true);
    expect(await sharp(decoded).raw().toBuffer()).toEqual(Buffer.from(pixels));
  });

  test("skips non-image ZIP entries and extracts only the first PNG", async () => {
    const archive = zipSync({ "metadata.json": new TextEncoder().encode("{}"), "image_0.png": TINY_PNG, "image_1.png": TINY_PNG });
    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(new Uint8Array(archive))) as typeof fetch;
    const result = await provider.generate("token", "", {
      prompt: "a fox", model: "nai-diffusion-5-full", parameters: {},
      connectionOptions: { novelai: { nonStreaming: true } },
    });
    expect(result.imageDataUrl).toBe(`data:image/png;base64,${Buffer.from(TINY_PNG).toString("base64")}`);
  });

  test("rejects ZIP entries declared larger than the image limit", async () => {
    const archive = zipSync({ "image_0.png": TINY_PNG });
    const directoryOffset = Buffer.from(archive).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    new DataView(archive.buffer).setUint32(directoryOffset + 24, 64 * 1024 * 1024 + 1, true);
    globalThis.fetch = (async (_input: RequestInfo | URL) => new Response(new Uint8Array(archive))) as typeof fetch;
    await expect(provider.generate("token", "", {
      prompt: "a fox", model: "nai-diffusion-5-full", parameters: {},
    })).rejects.toThrow("NovelAI ZIP response did not contain a supported PNG image");
  });

  for (const nonStreaming of [false, true]) {
    for (const status of [400, 401, 403, 404, 429, 500]) {
      test(`does not retry HTTP ${status} with non-streaming ${nonStreaming}`, async () => {
        let calls = 0;
        globalThis.fetch = (async (_input: RequestInfo | URL) => {
          calls++;
          return new Response("generation rejected", { status });
        }) as typeof fetch;
        await expect(provider.generate("token", "https://proxy.example/custom", {
          prompt: "a fox", model: "nai-diffusion-5-full", parameters: {},
          connectionOptions: { novelai: { nonStreaming } },
        })).rejects.toThrow("generation rejected");
        expect(calls).toBe(1);
      });
    }

    test(`does not send a request after cancellation with non-streaming ${nonStreaming}`, async () => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled by user"));
      let calls = 0;
      globalThis.fetch = (async (_input: RequestInfo | URL) => {
        calls++;
        return new Response(TINY_PNG);
      }) as typeof fetch;
      await expect(provider.generate("token", "https://proxy.example/custom", {
        prompt: "a fox", model: "nai-diffusion-5-full", parameters: {}, signal: controller.signal,
        connectionOptions: { novelai: { nonStreaming } },
      })).rejects.toThrow("cancelled by user");
      expect(calls).toBe(0);
    });
  }
});

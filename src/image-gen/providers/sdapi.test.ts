import { afterEach, describe, expect, test } from "bun:test";
import { SdApiImageProvider } from "./sdapi";
import type { ImageGenRequest } from "../types";

/**
 * Stub global fetch with a recorder so we can assert the outgoing endpoint and
 * request body the SD API provider builds. Returns the captured call.
 */
function stubFetch(responseImages: string[] = ["aGVsbG8="]) {
  const calls: Array<{ url: string; body: any }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify({ images: responseImages }), {
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

const BASE = "http://localhost:7860";

function req(parameters: Record<string, any>): ImageGenRequest {
  return { prompt: "a fox", negativePrompt: "blurry", model: "sd_xl", parameters };
}

describe("SdApiImageProvider — txt2img vs img2img routing", () => {
  const provider = new SdApiImageProvider();
  let fetchStub: ReturnType<typeof stubFetch>;

  afterEach(() => fetchStub?.restore());

  test("routes to /sdapi/v1/txt2img with no source images", async () => {
    fetchStub = stubFetch();
    await provider.generate("", BASE, req({ width: 512, height: 512 }));

    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].url).toBe(`${BASE}/sdapi/v1/txt2img`);
    expect(fetchStub.calls[0].body.init_images).toBeUndefined();
  });

  test("auto-routes to img2img when resolved source images are present", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "",
      BASE,
      req({
        // No explicit mode — presence of a source image is the signal.
        resolvedSourceImages: [{ data: "QUJD", mimeType: "image/jpeg" }],
        denoising_strength: 0.4,
      }),
    );

    const call = fetchStub.calls[0];
    expect(call.url).toBe(`${BASE}/sdapi/v1/img2img`);
    // Raw base64 source is normalised to a data URL carrying its MIME type.
    expect(call.body.init_images).toEqual(["data:image/jpeg;base64,QUJD"]);
    expect(call.body.denoising_strength).toBe(0.4);
  });

  test("passes through data-URL sources unchanged and clamps denoising", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "",
      BASE,
      req({
        mode: "img2img",
        resolvedSourceImages: [{ data: "data:image/png;base64,ZZZ" }],
        denoising_strength: 5, // out of range — must clamp to 1
      }),
    );

    const call = fetchStub.calls[0];
    expect(call.body.init_images).toEqual(["data:image/png;base64,ZZZ"]);
    expect(call.body.denoising_strength).toBe(1);
  });

  test("manual init_images paste field still works as a fallback", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "",
      BASE,
      req({ init_images: "data:image/png;base64,MANUAL" }),
    );

    const call = fetchStub.calls[0];
    expect(call.url).toBe(`${BASE}/sdapi/v1/img2img`);
    expect(call.body.init_images).toEqual(["data:image/png;base64,MANUAL"]);
  });

  test("merges resolved sources and a manual JSON array of init images", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "",
      BASE,
      req({
        resolvedSourceImages: [{ data: "AAA", mimeType: "image/webp" }],
        init_images: JSON.stringify(["data:image/png;base64,BBB"]),
      }),
    );

    expect(fetchStub.calls[0].body.init_images).toEqual([
      "data:image/webp;base64,AAA",
      "data:image/png;base64,BBB",
    ]);
  });

  test("rawRequestOverride cannot smuggle init_images (protected key)", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "",
      BASE,
      req({
        resolvedSourceImages: [{ data: "AAA", mimeType: "image/png" }],
        rawRequestOverride: JSON.stringify({ init_images: ["EVIL"], steps: 33 }),
      }),
    );

    const call = fetchStub.calls[0];
    expect(call.body.init_images).toEqual(["data:image/png;base64,AAA"]);
    expect(call.body.steps).toBe(33); // non-protected override still applies
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { SdApiImageProvider } from "./sdapi";
import { ProviderRequestError } from "../../utils/provider-errors";
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

type ModelFetchCall = {
  url: string;
  method: string;
  authorization: string | null;
};

type ModelFetchStub = {
  calls: ModelFetchCall[];
  restore(): void;
};

function stubModelFetch(
  respond: (call: ModelFetchCall) => Response | Promise<Response>,
): ModelFetchStub {
  const calls: ModelFetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: ModelFetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    return await respond(call);
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

describe("SdApiImageProvider — LoRA discovery", () => {
  let fetchStub: ModelFetchStub;

  afterEach(() => fetchStub?.restore());

  test("uses the canonical endpoint and keeps path as the exact generation identifier", async () => {
    const base = "http://sdapi-lora.example.test";
    const exactPath = "models/LoRA/Artist V2.safetensors";
    fetchStub = stubModelFetch(() => Response.json([
      { name: "Artist V2", path: exactPath },
      { name: "legacy-name-only", path: "" },
    ]));

    const models = await new SdApiImageProvider().listModelsBySubtype("test-key", base, "loras");

    expect(models).toEqual([
      { id: exactPath, label: "Artist V2" },
      { id: "legacy-name-only", label: "legacy-name-only" },
    ]);
    expect(fetchStub.calls).toEqual([{
      url: `${base}/sdapi/v1/loras`,
      method: "GET",
      authorization: "Bearer test-key",
    }]);
  });

  test("accepts an empty canonical LoRA listing", async () => {
    fetchStub = stubModelFetch(() => Response.json([]));

    await expect(
      new SdApiImageProvider().listModelsBySubtype("", "http://sdapi-empty.example.test", "loras"),
    ).resolves.toEqual([]);
  });

  test("surfaces HTTP-200 logical LoRA listing errors", async () => {
    const base = "http://sdapi-logical-error.example.test";
    fetchStub = stubModelFetch(() => Response.json({
      error: "LoRA discovery is disabled",
      error_id: "lora_discovery_disabled",
    }));

    let caught: unknown;
    try {
      await new SdApiImageProvider().listModelsBySubtype("", base, "loras");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect(caught).toMatchObject({
      provider: "SD API (stable-diffusion.cpp / A1111)",
      operation: "LoRA listing",
      code: "lora_discovery_disabled",
      detail: "LoRA discovery is disabled",
    });
    expect(fetchStub.calls).toEqual([{
      url: `${base}/sdapi/v1/loras`,
      method: "GET",
      authorization: null,
    }]);
  });

  test("rejects malformed non-array LoRA listing bodies", async () => {
    const invalidBodies: unknown[] = [null, {}, "not a LoRA list"];
    let responseIndex = 0;
    fetchStub = stubModelFetch(() => Response.json(invalidBodies[responseIndex++]!));

    for (const index of invalidBodies.keys()) {
      let caught: unknown;
      try {
        await new SdApiImageProvider().listModelsBySubtype(
          "",
          `http://sdapi-malformed-${index}.example.test`,
          "loras",
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ProviderRequestError);
      expect(caught).toMatchObject({
        provider: "SD API (stable-diffusion.cpp / A1111)",
        operation: "LoRA listing",
        detail: "SD API returned an invalid LoRA listing response",
      });
    }
    expect(fetchStub.calls).toHaveLength(invalidBodies.length);
  });

  test("rejects malformed entries in a nonempty LoRA listing", async () => {
    const invalidBodies: unknown[] = [[{}], [{ path: " " }], [null], [[]]];
    let responseIndex = 0;
    fetchStub = stubModelFetch(() => Response.json(invalidBodies[responseIndex++]!));

    for (const index of invalidBodies.keys()) {
      let caught: unknown;
      try {
        await new SdApiImageProvider().listModelsBySubtype(
          "",
          `http://sdapi-malformed-entry-${index}.example.test`,
          "loras",
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(ProviderRequestError);
      expect(caught).toMatchObject({
        provider: "SD API (stable-diffusion.cpp / A1111)",
        operation: "LoRA listing",
        detail: "SD API returned an invalid LoRA listing response",
      });
    }
    expect(fetchStub.calls).toHaveLength(invalidBodies.length);
  });

  test("preserves the canonical endpoint's non-2xx provider error", async () => {
    fetchStub = stubModelFetch(() => Response.json(
      { error: "LoRA endpoint unavailable", code: "lora_unavailable" },
      { status: 503, statusText: "Service Unavailable" },
    ));

    let caught: unknown;
    try {
      await new SdApiImageProvider().listModelsBySubtype("", "http://sdapi-error.example.test", "loras");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect(caught).toMatchObject({
      provider: "SD API (stable-diffusion.cpp / A1111)",
      operation: "LoRA listing",
      status: 503,
      code: "lora_unavailable",
      detail: "LoRA endpoint unavailable",
    });
  });

  test("wraps a canonical endpoint transport failure as retryable", async () => {
    fetchStub = stubModelFetch(() => {
      throw new Error("fixture connection refused");
    });

    let caught: unknown;
    try {
      await new SdApiImageProvider().listModelsBySubtype("", "http://sdapi-network.example.test", "loras");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect(caught).toMatchObject({
      provider: "SD API (stable-diffusion.cpp / A1111)",
      operation: "LoRA listing",
      detail: "fixture connection refused",
      retryable: true,
    });
  });

  test("wraps a canonical endpoint response-body transport failure as retryable", async () => {
    fetchStub = stubModelFetch(() => new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("fixture response body lost"));
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    let caught: unknown;
    try {
      await new SdApiImageProvider().listModelsBySubtype("", "http://sdapi-body.example.test", "loras");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderRequestError);
    expect(caught).toMatchObject({
      provider: "SD API (stable-diffusion.cpp / A1111)",
      operation: "LoRA listing",
      detail: "fixture response body lost",
      retryable: true,
    });
  });
});

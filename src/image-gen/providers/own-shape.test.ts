import { afterEach, describe, expect, test } from "bun:test";
import type { ImageGenRequest } from "../types";
import { IdeogramImageProvider } from "./ideogram";
import { FireworksImageProvider } from "./fireworks";
import { StabilityImageProvider } from "./stability";
import { BlackForestLabsImageProvider } from "./bfl";
import { FalImageProvider } from "./fal";
import { ReplicateImageProvider } from "./replicate";
import { LeonardoImageProvider } from "./leonardo";
import { RunwareImageProvider } from "./runware";
import { CivitaiImageProvider } from "./civitai";
import { CivitaiChatImageProvider } from "./civitai-chat";
import { HuggingFaceImageProvider } from "./huggingface";
import { VeniceImageProvider } from "./venice";

interface StubResponse {
  json?: any;
  status?: number;
  raw?: string;
  contentType?: string;
  bytes?: Uint8Array;
}

function stubFetch(responses: StubResponse[]) {
  const calls: Array<{ url: string; method: string; body: any; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: any;
    if (init?.body instanceof FormData) body = init.body;
    else if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(input), method: init?.method || "GET", body, headers: (init?.headers as Record<string, string>) || {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    const status = next.status ?? 200;
    if (next.bytes) {
      return new Response(next.bytes as unknown as BodyInit, { status, headers: { "Content-Type": next.contentType || "image/png" } });
    }
    if (next.raw !== undefined) {
      return new Response(next.raw, { status, headers: { "Content-Type": next.contentType || "text/plain" } });
    }
    return new Response(JSON.stringify(next.json ?? {}), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function req(model: string, parameters: Record<string, any> = {}, extra: Partial<ImageGenRequest> = {}): ImageGenRequest {
  return { prompt: "a fox", negativePrompt: "blurry", model, parameters, ...extra };
}

const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

describe("Ideogram", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("uses the Api-Key header and downloads the result URL", async () => {
    fetchStub = stubFetch([{ json: { data: [{ url: "https://ideogram/img.png" }] } }, { bytes: PNG_BYTES }]);
    const provider = new IdeogramImageProvider();
    const result = await provider.generate("secret", "https://api.ideogram.ai", req("ideogram-4-5", { size: "1024x1024", quality: "high", seed: 4 }));

    expect(fetchStub.calls[0].url).toBe("https://api.ideogram.ai/v2/image/generate/ideogram-4-5");
    expect(fetchStub.calls[0].headers["Api-Key"]).toBe("secret");
    expect(fetchStub.calls[0].headers.Authorization).toBeUndefined();
    const form = fetchStub.calls[0].body as FormData;
    expect(form.get("size")).toBe("1024x1024");
    expect(form.get("quality")).toBe("high");
    expect(result.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("sends aspect_ratio and rendering_speed for Ideogram 2a (JSON body)", async () => {
    fetchStub = stubFetch([{ json: { data: [{ url: "https://ideogram/img.png" }] } }, { bytes: PNG_BYTES }]);
    const provider = new IdeogramImageProvider();
    await provider.generate("secret", "https://api.ideogram.ai", req("ideogram-2a", { aspectRatio: "16x9", renderingSpeed: "TURBO" }));
    expect(fetchStub.calls[0].url).toBe("https://api.ideogram.ai/v2/image/generate/ideogram-2a");
    expect(fetchStub.calls[0].body.aspect_ratio).toBe("16x9");
    expect(fetchStub.calls[0].body.rendering_speed).toBe("turbo");
  });

  test("routes an Ideogram 4.5 source image to precise-edit as the `image` file part", async () => {
    fetchStub = stubFetch([{ json: { data: [{ url: "https://ideogram/img.png" }] } }, { bytes: PNG_BYTES }]);
    const provider = new IdeogramImageProvider();
    await provider.generate("secret", "https://api.ideogram.ai", req("ideogram-4-5", { quality: "high", resolvedSourceImages: [{ data: "YWJj", mimeType: "image/png" }] }));
    expect(fetchStub.calls[0].url).toBe("https://api.ideogram.ai/v2/image/precise-edit/ideogram-4-5");
    const form = fetchStub.calls[0].body as FormData;
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(form.get("quality")).toBe("high");
  });

  test("routes Ideogram 3.0 source images to remix and splits references", async () => {
    fetchStub = stubFetch([{ json: { data: [{ url: "https://ideogram/img.png" }] } }, { bytes: PNG_BYTES }]);
    const provider = new IdeogramImageProvider();
    const sources = [
      { data: "YWJj", mimeType: "image/png" },
      { data: "ZGVm", mimeType: "image/png" },
    ];
    await provider.generate("secret", "https://api.ideogram.ai", req("ideogram-3", { resolvedSourceImages: sources }));
    expect(fetchStub.calls[0].url).toBe("https://api.ideogram.ai/v2/image/remix/ideogram-3");
    const form = fetchStub.calls[0].body as FormData;
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(form.get("style_reference_images")).toBeInstanceOf(Blob);
  });

  test("routes Ideogram 4.0 source images to remix (JSON) and rejects models without an edit path", async () => {
    fetchStub = stubFetch([{ json: { data: [{ url: "https://ideogram/img.png" }] } }, { bytes: PNG_BYTES }]);
    const provider = new IdeogramImageProvider();
    await provider.generate("secret", "https://api.ideogram.ai", req("ideogram-4", { resolvedSourceImages: [{ data: "YWJj", mimeType: "image/png" }] }));
    expect(fetchStub.calls[0].url).toBe("https://api.ideogram.ai/v2/image/remix/ideogram-4");

    await expect(provider.generate("secret", "https://api.ideogram.ai", req("ideogram-2a", { resolvedSourceImages: [{ data: "YWJj", mimeType: "image/png" }] }))).rejects.toThrow(/does not accept a source image/);
  });
});

describe("Fireworks", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("builds the workflow text_to_image URL and returns the base64 image", async () => {
    fetchStub = stubFetch([{ json: { base64: ["data:image/png;base64,aGVsbG8="], finishReason: "SUCCESS", seed: 1 } }]);
    const provider = new FireworksImageProvider();
    const result = await provider.generate("key", "https://api.fireworks.ai/inference/v1", req("stable-diffusion-xl-1024-v1-0", { aspectRatio: "16:9", guidanceScale: 3.5, numInferenceSteps: 30, seed: 0 }));

    expect(fetchStub.calls[0].url).toBe("https://api.fireworks.ai/inference/v1/workflows/accounts/fireworks/models/stable-diffusion-xl-1024-v1-0/text_to_image");
    expect(fetchStub.calls[0].headers.Accept).toBe("application/json");
    expect(fetchStub.calls[0].body.aspect_ratio).toBe("16:9");
    expect(fetchStub.calls[0].body.num_inference_steps).toBe(30);
    expect(result.imageDataUrl).toBe("data:image/png;base64,aGVsbG8=");
  });

  test("raises an error when the prompt is content-filtered", async () => {
    fetchStub = stubFetch([{ json: { finishReason: "CONTENT_FILTERED" } }]);
    const provider = new FireworksImageProvider();
    await expect(provider.generate("key", "https://api.fireworks.ai/inference/v1", req("stable-diffusion-xl-1024-v1-0"))).rejects.toThrow(/CONTENT_FILTERED/);
  });
});

describe("Stability", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("posts multipart form data with Bearer auth and reads the base64 image", async () => {
    fetchStub = stubFetch([{ json: { image: "aGVsbG8=", finish_reason: "SUCCESS" } }]);
    const provider = new StabilityImageProvider();
    const result = await provider.generate("key", "https://api.stability.ai", req("core", { aspectRatio: "1:1", outputFormat: "png" }));

    expect(fetchStub.calls[0].url).toBe("https://api.stability.ai/v2beta/stable-image/generate/core");
    expect(fetchStub.calls[0].headers.Authorization).toBe("Bearer key");
    const form = fetchStub.calls[0].body as FormData;
    expect(form.get("prompt")).toBe("a fox");
    expect(form.get("aspect_ratio")).toBe("1:1");
    expect(form.get("output_format")).toBe("png");
    expect(result.imageDataUrl).toBe("data:image/png;base64,aGVsbG8=");
  });

  test("sends style_preset and cfg_scale/model on the sd3 endpoint", async () => {
    fetchStub = stubFetch([{ json: { image: "aGVsbG8=", finish_reason: "SUCCESS" } }]);
    const provider = new StabilityImageProvider();
    await provider.generate("key", "https://api.stability.ai", req("sd3", { stylePreset: "cinematic", cfgScale: 4.5, model: "sd3.5-medium" }));

    const form = fetchStub.calls[0].body as FormData;
    expect(form.get("style_preset")).toBe("cinematic");
    expect(form.get("cfg_scale")).toBe("4.5");
    expect(form.get("model")).toBe("sd3.5-medium");
  });

  test("sends an image part and strength for image-to-image on sd3", async () => {
    fetchStub = stubFetch([{ json: { image: "aGVsbG8=", finish_reason: "SUCCESS" } }]);
    const provider = new StabilityImageProvider();
    await provider.generate(
      "key",
      "https://api.stability.ai",
      req("sd3", { aspectRatio: "1:1", strength: 0.8, resolvedSourceImages: [{ data: "YWJj", mimeType: "image/png" }] }),
    );

    const form = fetchStub.calls[0].body as FormData;
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect(form.get("strength")).toBe("0.8");
    expect(form.get("mode")).toBe("image-to-image");
    // aspect_ratio is text-to-image only.
    expect(form.get("aspect_ratio")).toBeNull();
  });

  test("rejects a source image on the core endpoint", async () => {
    fetchStub = stubFetch([{ json: { image: "aGVsbG8=" } }]);
    const provider = new StabilityImageProvider();
    await expect(
      provider.generate("key", "https://api.stability.ai", req("core", { resolvedSourceImages: [{ data: "YWJj", mimeType: "image/png" }] })),
    ).rejects.toThrow(/does not accept a source image/);
  });
});

describe("Black Forest Labs", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("submits with the x-key header and polls the returned polling_url", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Pending" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png", seed: 2 } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new BlackForestLabsImageProvider();
    const result = await provider.generate("key", "https://api.bfl.ai/v1", req("flux-pro-1.1", { width: 1024, height: 1024 }));

    expect(fetchStub.calls[0].url).toBe("https://api.bfl.ai/v1/flux-pro-1.1");
    expect(fetchStub.calls[0].headers["x-key"]).toBe("key");
    expect(fetchStub.calls[0].body.width).toBe(1024);
    expect(fetchStub.calls[2].url).toBe("https://api.bfl.ai/v1/get_result?id=job1");
    expect(result.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("surfaces a job error", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Error", result: { error: "moderated" } } },
    ]);
    const provider = new BlackForestLabsImageProvider();
    await expect(provider.generate("key", "https://api.bfl.ai/v1", req("flux-pro-1.1"))).rejects.toThrow(/moderated/);
  });

  test("validates the key against /credits, which distinguishes a bad key", async () => {
    fetchStub = stubFetch([{ json: { credits: 10 } }]);
    const provider = new BlackForestLabsImageProvider();
    await expect(provider.validateKey("key", "https://api.bfl.ai/v1")).resolves.toBe(true);
    expect(fetchStub.calls[0].url).toBe("https://api.bfl.ai/v1/credits");
    expect(fetchStub.calls[0].headers["x-key"]).toBe("key");
  });

  test("uses input_image for FLUX.2 and drops unsupported guidance/steps", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate(
      "key",
      "https://api.bfl.ai/v1",
      req("flux-2-pro", { width: 1024, height: 768, guidance: 3, steps: 20, resolvedSourceImages: [{ data: "AAAA", mimeType: "image/png" }] }),
    );
    expect(fetchStub.calls[0].body.input_image).toContain("data:image/png;base64,");
    expect(fetchStub.calls[0].body.guidance).toBeUndefined();
    expect(fetchStub.calls[0].body.steps).toBeUndefined();
  });

  test("sends aspect_ratio (not width/height) and image_prompt on FLUX 1.1 Ultra", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate(
      "key",
      "https://api.bfl.ai/v1",
      req("flux-pro-1.1-ultra", { width: 1024, height: 1024, aspectRatio: "16:9", resolvedSourceImages: [{ data: "AAAA", mimeType: "image/png" }] }),
    );
    expect(fetchStub.calls[0].body.aspect_ratio).toBe("16:9");
    expect(fetchStub.calls[0].body.width).toBeUndefined();
    expect(fetchStub.calls[0].body.image_prompt).toContain("data:image/png;base64,");
  });

  test("sends images[] and width/height on FLUX 3 Image", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate(
      "key",
      "https://api.bfl.ai/v1",
      req("flux-3-image", { width: 1024, height: 768, resolvedSourceImages: [{ data: "AAAA", mimeType: "image/png" }] }),
    );
    expect(fetchStub.calls[0].url).toBe("https://api.bfl.ai/v1/flux-3-image");
    expect(fetchStub.calls[0].body.width).toBe(1024);
    expect(Array.isArray(fetchStub.calls[0].body.images)).toBe(true);
    expect(fetchStub.calls[0].body.images[0]).toContain("data:image/png;base64,");
    expect(fetchStub.calls[0].body.input_image).toBeUndefined();
  });

  test("uses input_image and aspect_ratio on FLUX.1 Kontext", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate(
      "key",
      "https://api.bfl.ai/v1",
      req("flux-kontext-pro", { width: 1024, height: 1024, aspectRatio: "1:1", resolvedSourceImages: [{ data: "AAAA", mimeType: "image/png" }] }),
    );
    expect(fetchStub.calls[0].body.aspect_ratio).toBe("1:1");
    expect(fetchStub.calls[0].body.width).toBeUndefined();
    expect(fetchStub.calls[0].body.input_image).toContain("data:image/png;base64,");
  });

  test("maps promptUpsampling to disable_pup on FLUX.2 Pro", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate("key", "https://api.bfl.ai/v1", req("flux-2-pro", { promptUpsampling: false }));
    expect(fetchStub.calls[0].body.disable_pup).toBe(true);
    expect(fetchStub.calls[0].body.prompt_upsampling).toBeUndefined();
  });

  test("uses prompt_upsampling on FLUX 1.1 Pro and FLUX 2 Flex", async () => {
    const responses = [
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ];
    fetchStub = stubFetch(responses);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate("key", "https://api.bfl.ai/v1", req("flux-pro-1.1", { promptUpsampling: true }));
    expect(fetchStub.calls[0].body.prompt_upsampling).toBe(true);
    expect(fetchStub.calls[0].body.disable_pup).toBeUndefined();

    fetchStub.restore();
    fetchStub = stubFetch(responses);
    await provider.generate("key", "https://api.bfl.ai/v1", req("flux-2-flex", { promptUpsampling: true }));
    expect(fetchStub.calls[0].body.prompt_upsampling).toBe(true);
    expect(fetchStub.calls[0].body.disable_pup).toBeUndefined();
  });

  test("does not send prompt_upsampling, seed or output_format on flux-3-image", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate(
      "key",
      "https://api.bfl.ai/v1",
      req("flux-3-image", { promptUpsampling: true, seed: 7, outputFormat: "png", resolution: "2k" }),
    );
    const body = fetchStub.calls[0].body;
    expect(body.prompt_upsampling).toBeUndefined();
    expect(body.seed).toBeUndefined();
    expect(body.output_format).toBeUndefined();
    expect(body.resolution).toBe("2k");
  });

  test("sends seed, steps and output_format on flux-3-image-klein", async () => {
    fetchStub = stubFetch([
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate("key", "https://api.bfl.ai/v1", req("flux-3-image-klein", { seed: 7, steps: 20, outputFormat: "jpeg" }));
    const body = fetchStub.calls[0].body;
    expect(body.seed).toBe(7);
    expect(body.steps).toBe(20);
    expect(body.output_format).toBe("jpeg");
  });

  test("sends up to 8 input_image fields on FLUX.2 and caps Kontext at 4", async () => {
    const responses = [
      { json: { id: "job1", polling_url: "https://api.bfl.ai/v1/get_result?id=job1" } },
      { json: { status: "Ready", result: { sample: "https://bfl/img.png" } } },
      { bytes: PNG_BYTES },
    ];
    const many = Array.from({ length: 10 }, (_, i) => ({ data: `AAAA${i}`, mimeType: "image/png" }));
    fetchStub = stubFetch(responses);
    const provider = new BlackForestLabsImageProvider();
    await provider.generate("key", "https://api.bfl.ai/v1", req("flux-2-pro", { resolvedSourceImages: many }));
    const flux2 = fetchStub.calls[0].body;
    expect(flux2.input_image).toBeDefined();
    expect(flux2.input_image_8).toBeDefined();
    expect(flux2.input_image_9).toBeUndefined();

    fetchStub.restore();
    fetchStub = stubFetch(responses);
    await provider.generate("key", "https://api.bfl.ai/v1", req("flux-kontext-pro", { resolvedSourceImages: many }));
    const kontext = fetchStub.calls[0].body;
    expect(kontext.input_image_4).toBeDefined();
    expect(kontext.input_image_5).toBeUndefined();
  });
});

describe("fal.ai", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("submits to the queue, polls status, then fetches the response", async () => {
    fetchStub = stubFetch([
      { json: { request_id: "r1", status_url: "https://queue.fal.run/status", response_url: "https://queue.fal.run/response" } },
      { json: { status: "IN_PROGRESS" } },
      { json: { status: "COMPLETED" } },
      { json: { images: [{ url: "https://fal/img.png" }] } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new FalImageProvider();
    const result = await provider.generate("key", "https://queue.fal.run", req("fal-ai/flux/schnell", { imageSize: "square_hd" }));

    expect(fetchStub.calls[0].url).toBe("https://queue.fal.run/fal-ai/flux/schnell");
    expect(fetchStub.calls[0].headers.Authorization).toBe("Key key");
    expect(fetchStub.calls[0].body.image_size).toBe("square_hd");
    expect(result.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("Replicate", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("uses the official model endpoint and polls when not settled", async () => {
    fetchStub = stubFetch([
      { json: { id: "p1", status: "starting", urls: { get: "https://api.replicate.com/v1/predictions/p1" } } },
      { json: { status: "succeeded", output: ["https://replicate/img.png"] } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new ReplicateImageProvider();
    const result = await provider.generate("key", "https://api.replicate.com/v1", req("black-forest-labs/flux-schnell", { numOutputs: 1 }));

    expect(fetchStub.calls[0].url).toBe("https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions");
    expect(fetchStub.calls[0].headers.Prefer).toBe("wait=60");
    expect(fetchStub.calls[0].body.input.prompt).toBe("a fox");
    expect(result.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("community version hashes post to /predictions with a version field", async () => {
    fetchStub = stubFetch([{ json: { status: "succeeded", output: "https://replicate/img.png" } }, { bytes: PNG_BYTES }]);
    const provider = new ReplicateImageProvider();
    await provider.generate("key", "https://api.replicate.com/v1", req("owner/name:abc123def456", {}));
    expect(fetchStub.calls[0].url).toBe("https://api.replicate.com/v1/predictions");
    expect(fetchStub.calls[0].body.version).toBe("owner/name:abc123def456");
  });
});

describe("Leonardo", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("submits and polls until the generation is complete", async () => {
    fetchStub = stubFetch([
      { json: { sdGenerationJob: { generationId: "gen1" } } },
      { json: { generations_by_pk: { status: "PENDING" } } },
      { json: { generations_by_pk: { status: "COMPLETE", generated_images: [{ url: "https://leonardo/img.png" }] } } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new LeonardoImageProvider();
    const result = await provider.generate("key", "https://cloud.leonardo.ai/api/rest/v1", req("de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3", { width: 1024, height: 1024, numImages: 1 }));

    expect(fetchStub.calls[0].url).toBe("https://cloud.leonardo.ai/api/rest/v1/generations");
    expect(fetchStub.calls[0].body.modelId).toBe("de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3");
    expect(fetchStub.calls[0].body.num_images).toBe(1);
    expect(fetchStub.calls[1].url).toBe("https://cloud.leonardo.ai/api/rest/v1/generations/gen1");
    expect(result.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });
});

describe("Runware", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("posts a task array and reads the image URL from the data array", async () => {
    fetchStub = stubFetch([{ json: { data: [{ taskUUID: "t1", imageURL: "https://runware/img.png" }] } }, { bytes: PNG_BYTES }]);
    const provider = new RunwareImageProvider();
    const result = await provider.generate("key", "https://api.runware.ai/v1", req("runware:100@1", { width: 1024, height: 1024 }));

    expect(fetchStub.calls[0].url).toBe("https://api.runware.ai/v1");
    const tasks = fetchStub.calls[0].body as any[];
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks[0].taskType).toBe("imageInference");
    expect(tasks[0].positivePrompt).toBe("a fox");
    expect(tasks[0].model).toBe("runware:100@1");
    expect(result.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("surfaces a per-task error", async () => {
    fetchStub = stubFetch([{ json: { data: [{ taskUUID: "t1", error: true, errorMessage: "bad model" }] } }]);
    const provider = new RunwareImageProvider();
    await expect(provider.generate("key", "https://api.runware.ai/v1", req("bad"))).rejects.toThrow(/bad model/);
  });

  test("sends a seed image and strength through inputs for image-to-image", async () => {
    fetchStub = stubFetch([{ json: { data: [{ taskUUID: "t1", imageURL: "https://runware/img.png" }] } }, { bytes: PNG_BYTES }]);
    const provider = new RunwareImageProvider();
    await provider.generate(
      "key",
      "https://api.runware.ai/v1",
      req("runware:101@1", { width: 1024, height: 1024, strength: 0.7, resolvedSourceImages: [{ data: "YWJj", mimeType: "image/png" }] }),
    );

    const tasks = fetchStub.calls[0].body as any[];
    expect(tasks[0].inputs.seedImage).toBe("data:image/png;base64,YWJj");
    expect(tasks[0].strength).toBe(0.7);
  });
});

describe("Civitai", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("runs an imageGen workflow and reads the first image URL", async () => {
    fetchStub = stubFetch([
      { json: { steps: [{ output: { images: [{ url: "https://civitai/img.png" }] } }] } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new CivitaiImageProvider();
    const result = await provider.generate("key", "https://orchestration.civitai.com", req("anima", { width: 1024, height: 1024, cfgScale: 4, steps: 30, ecosystem: "anima", engine: "sdcpp" }));

    expect(fetchStub.calls[0].url).toBe("https://orchestration.civitai.com/v2/consumer/workflows?wait=60");
    const body = fetchStub.calls[0].body;
    expect(body.steps[0].$type).toBe("imageGen");
    expect(body.steps[0].input.operation).toBe("createImage");
    expect(body.steps[0].input.ecosystem).toBe("anima");
    expect(body.steps[0].input.cfgScale).toBe(4);
    expect(result.imageDataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("parses a LoRA map and sets the free tier", async () => {
    fetchStub = stubFetch([{ json: { steps: [{ output: { images: [{ url: "https://civitai/img.png" }] } }] } }, { bytes: PNG_BYTES }]);
    const provider = new CivitaiImageProvider();
    await provider.generate("key", "https://orchestration.civitai.com", req("anima", { loras: '{"urn:air:anima:lora:civitai:1@2": 0.8}', tier: "free" }));
    const body = fetchStub.calls[0].body;
    expect(body.tier).toBe("free");
    expect(body.steps[0].input.loras["urn:air:anima:lora:civitai:1@2"]).toBe(0.8);
  });

  test("forwards the selected checkpoint and a reproducible seed", async () => {
    fetchStub = stubFetch([
      { json: { steps: [{ output: { images: [{ url: "https://civitai/img.png" }] } }] } },
      { bytes: PNG_BYTES },
    ]);
    const provider = new CivitaiImageProvider();
    const model = "urn:air:sdxl:checkpoint:civitai:101055@128078";
    await provider.generate("key", "https://orchestration.civitai.com", req(model, { ecosystem: "sdxl", seed: 0 }));
    expect(fetchStub.calls[0].body.steps[0].input).toMatchObject({ model, ecosystem: "sdxl", seed: 0 });
  });

  test("does not mistake an echoed input URL for generated output", async () => {
    fetchStub = stubFetch([{ json: { status: "succeeded", steps: [{ input: { url: "https://input/not-output.png" }, output: { images: [] } }] } }]);
    await expect(new CivitaiImageProvider().generate("key", "", req("anima"))).rejects.toThrow("no image data");
    expect(fetchStub.calls).toHaveLength(1);
  });

  test("rejects an invalid LoRA JSON value", async () => {
    fetchStub = stubFetch([{ json: {} }]);
    const provider = new CivitaiImageProvider();
    await expect(provider.generate("key", "https://orchestration.civitai.com", req("anima", { loras: "not json" }))).rejects.toThrow(/LoRAs/);
  });

  test("sends whatif as a query flag and surfaces the estimated cost", async () => {
    fetchStub = stubFetch([{ json: { cost: { total: 9.6 } } }]);
    const provider = new CivitaiImageProvider();
    await expect(provider.generate("key", "https://orchestration.civitai.com", req("anima", { whatif: true }))).rejects.toThrow(/9.6/);
    expect(fetchStub.calls[0].url).toBe("https://orchestration.civitai.com/v2/consumer/workflows?wait=60&whatif=true");
    expect(fetchStub.calls[0].body.whatif).toBeUndefined();
  });
});

describe("Civitai chat", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("uses chat completions with modalities and reads the data URI", async () => {
    fetchStub = stubFetch([{ json: { choices: [{ message: { images: [{ image_url: { url: "data:image/png;base64,aGVsbG8=" } }] } }] } }]);
    const provider = new CivitaiChatImageProvider();
    const result = await provider.generate("key", "https://orchestration.civitai.com", req("google/gemini-2.5-flash-image", { aspectRatio: "1:1", imageSize: "1K", tier: "free" }));

    expect(fetchStub.calls[0].url).toBe("https://orchestration.civitai.com/v1/chat/completions");
    expect(fetchStub.calls[0].headers["X-Civitai-Tier"]).toBe("free");
    expect(fetchStub.calls[0].body.modalities).toEqual(["image", "text"]);
    expect(fetchStub.calls[0].body.image_config).toEqual({ aspect_ratio: "1:1", image_size: "1K" });
    expect(result.imageDataUrl).toBe("data:image/png;base64,aGVsbG8=");
  });
});

describe("Hugging Face", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("posts to the hf-inference route and inlines the raw image bytes", async () => {
    fetchStub = stubFetch([{ bytes: PNG_BYTES, contentType: "image/png" }]);
    const provider = new HuggingFaceImageProvider();
    const result = await provider.generate("key", "https://router.huggingface.co", req("black-forest-labs/FLUX.1-schnell", { numInferenceSteps: 4, guidanceScale: 0 }));

    expect(fetchStub.calls[0].url).toBe("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell");
    expect(fetchStub.calls[0].body.inputs).toBe("a fox");
    expect(fetchStub.calls[0].body.parameters.num_inference_steps).toBe(4);
    expect(result.imageDataUrl).toBe(`data:image/png;base64,${Buffer.from(PNG_BYTES).toString("base64")}`);
  });

  test("surfaces a JSON error body", async () => {
    fetchStub = stubFetch([{ json: { error: "Model is currently loading" }, status: 503 }]);
    const provider = new HuggingFaceImageProvider();
    await expect(provider.generate("key", "https://router.huggingface.co", req("x"))).rejects.toThrow(/Model is currently loading/);
  });
});

describe("Venice native", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());

  test("posts the native body and reads bare base64 from images[]", async () => {
    fetchStub = stubFetch([{ json: { id: "v1", images: ["aGVsbG8="] } }]);
    const provider = new VeniceImageProvider();
    const result = await provider.generate("key", "https://api.venice.ai/api/v1", req("venice-sd35", { aspectRatio: "1:1", resolution: "2K", stylePreset: "Cinematic", format: "webp" }));

    expect(fetchStub.calls[0].url).toBe("https://api.venice.ai/api/v1/image/generate");
    expect(fetchStub.calls[0].body.aspect_ratio).toBe("1:1");
    expect(fetchStub.calls[0].body.resolution).toBe("2K");
    expect(fetchStub.calls[0].body.style_preset).toBe("Cinematic");
    expect(result.imageDataUrl).toBe("data:image/webp;base64,aGVsbG8=");
  });

  test("validates the key against an authenticated endpoint, not the public styles list", async () => {
    fetchStub = stubFetch([{ json: { data: {} } }]);
    const provider = new VeniceImageProvider();
    await expect(provider.validateKey("key", "https://api.venice.ai/api/v1")).resolves.toBe(true);
    expect(fetchStub.calls[0].url).toBe("https://api.venice.ai/api/v1/api_keys/rate_limits");
  });
});

describe("provider authentication failures", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  afterEach(() => fetchStub?.restore());
  test.each([new FalImageProvider(), new IdeogramImageProvider(), new ReplicateImageProvider()])("%s does not report an upstream outage as successful validation", async (provider) => {
    fetchStub = stubFetch([{ status: 503, json: { error: "unavailable" } }]);
    await expect(provider.validateKey("key", "")).rejects.toThrow(/503/);
  });
  test("fal rejects a source image on a text-only preset before submitting a paid job", async () => {
    fetchStub = stubFetch([{ json: {} }]);
    await expect(new FalImageProvider().generate("key", "", req("fal-ai/flux/dev", { resolvedSourceImages: [{ data: "QUJD" }] }))).rejects.toThrow(/image-to-image/);
    expect(fetchStub.calls).toHaveLength(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { OpenAIImageProvider } from "./openai";
import type { ImageGenRequest } from "../types";

/**
 * Stub global fetch with a recorder so we can assert the outgoing endpoint and
 * request body the OpenAI provider builds. JSON bodies are parsed; multipart
 * bodies are kept as FormData for field-level assertions.
 */
function stubFetch(responseJson: any = { data: [{ b64_json: "aGVsbG8=" }] }) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body =
      init?.body instanceof FormData
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined;
    calls.push({ url: String(input), body, headers: (init?.headers as Record<string, string>) || {} });
    return new Response(JSON.stringify(responseJson), {
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

const BASE = "https://api.openai.com/v1";

function req(model: string, parameters: Record<string, any> = {}): ImageGenRequest {
  return { prompt: "a fox", negativePrompt: "blurry", model, parameters };
}

describe("OpenAIImageProvider — generations endpoint", () => {
  const provider = new OpenAIImageProvider();
  let fetchStub: ReturnType<typeof stubFetch>;

  afterEach(() => fetchStub?.restore());

  test("GPT image models omit response_format and auto params", async () => {
    fetchStub = stubFetch();
    const result = await provider.generate(
      "key",
      BASE,
      req("gpt-image-1", { size: "auto", quality: "auto", background: "auto", moderation: "auto" }),
    );

    expect(fetchStub.calls).toHaveLength(1);
    const call = fetchStub.calls[0];
    expect(call.url).toBe(`${BASE}/images/generations`);
    expect(call.body.model).toBe("gpt-image-1");
    expect(call.body.response_format).toBeUndefined();
    expect(call.body.size).toBeUndefined();
    expect(call.body.quality).toBeUndefined();
    expect(call.body.background).toBeUndefined();
    expect(call.body.moderation).toBeUndefined();
    expect(result.imageDataUrl).toBe("data:image/png;base64,aGVsbG8=");
  });

  test("moderation defaults to low for GPT image models and is never sent to DALL-E", async () => {
    fetchStub = stubFetch();
    await provider.generate("key", BASE, req("gpt-image-1"));
    expect(fetchStub.calls[0].body.moderation).toBe("low");

    await provider.generate("key", BASE, req("dall-e-3"));
    expect(fetchStub.calls[1].body.moderation).toBeUndefined();
  });

  test("GPT image models pass through non-auto family params", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "key",
      BASE,
      req("gpt-image-1-mini", {
        size: "1536x1024",
        quality: "high",
        background: "transparent",
        moderation: "low",
        outputFormat: "webp",
        style: "vivid", // dall-e-3 only — must not leak to GPT image models
      }),
    );

    const body = fetchStub.calls[0].body;
    expect(body.size).toBe("1536x1024");
    expect(body.quality).toBe("high");
    expect(body.background).toBe("transparent");
    expect(body.moderation).toBe("low");
    expect(body.output_format).toBe("webp");
    expect(body.style).toBeUndefined();
  });

  test("DALL-E models request b64_json and dall-e-3 takes style", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "key",
      BASE,
      req("dall-e-3", {
        size: "1792x1024",
        quality: "hd",
        style: "natural",
        background: "transparent", // GPT-image only — must not leak to DALL-E
      }),
    );

    const body = fetchStub.calls[0].body;
    expect(body.response_format).toBe("b64_json");
    expect(body.size).toBe("1792x1024");
    expect(body.quality).toBe("hd");
    expect(body.style).toBe("natural");
    expect(body.background).toBeUndefined();
  });

  test("outputFormat drives the returned data URL MIME for GPT image models", async () => {
    fetchStub = stubFetch();
    const result = await provider.generate("key", BASE, req("gpt-image-1", { outputFormat: "webp" }));
    expect(result.imageDataUrl).toBe("data:image/webp;base64,aGVsbG8=");
  });

  test("rawRequestOverride applies but cannot swap the model", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "key",
      BASE,
      req("gpt-image-1", {
        rawRequestOverride: JSON.stringify({ output_compression: 80, model: "evil-model" }),
      }),
    );

    const body = fetchStub.calls[0].body;
    expect(body.output_compression).toBe(80);
    expect(body.model).toBe("gpt-image-1");
  });

  test("tolerates a pasted full endpoint and trailing slashes in the API URL", async () => {
    fetchStub = stubFetch();
    await provider.generate("key", "https://proxy.example.com/openai/v1/images/generations/", req("gpt-image-1"));
    expect(fetchStub.calls[0].url).toBe("https://proxy.example.com/openai/v1/images/generations");
  });
});

describe("OpenAIImageProvider — edits endpoint (img2img)", () => {
  const provider = new OpenAIImageProvider();
  let fetchStub: ReturnType<typeof stubFetch>;

  afterEach(() => fetchStub?.restore());

  test("routes to /images/edits when resolved source images are present", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "key",
      BASE,
      req("gpt-image-1", {
        resolvedSourceImages: [{ data: "QUJD", mimeType: "image/jpeg" }],
        inputFidelity: "high",
        moderation: "low",
      }),
    );

    const call = fetchStub.calls[0];
    expect(call.url).toBe(`${BASE}/images/edits`);
    const form = call.body as FormData;
    expect(form.get("model")).toBe("gpt-image-1");
    expect(form.get("prompt")).toBe("a fox");
    expect(form.get("input_fidelity")).toBe("high");
    expect(form.get("moderation")).toBe("low");
    const image = form.get("image") as File;
    expect(image).toBeInstanceOf(Blob);
    expect(image.type).toBe("image/jpeg");
  });

  test("multiple sources use the image[] array field", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "key",
      BASE,
      req("gpt-image-1", {
        resolvedSourceImages: [
          { data: "QUJD", mimeType: "image/png" },
          { data: "data:image/webp;base64,REVG" },
        ],
      }),
    );

    const form = fetchStub.calls[0].body as FormData;
    const images = form.getAll("image[]") as File[];
    expect(images).toHaveLength(2);
    expect(images[0].type).toBe("image/png");
    // MIME type embedded in a data URL wins over the default.
    expect(images[1].type).toBe("image/webp");
    expect(form.get("image")).toBeNull();
  });

  test("rawRequestOverride cannot smuggle image fields into the form", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "key",
      BASE,
      req("gpt-image-1", {
        resolvedSourceImages: [{ data: "QUJD", mimeType: "image/png" }],
        rawRequestOverride: JSON.stringify({ image: "EVIL", "image[]": "EVIL", mask: "EVIL", n: 1 }),
      }),
    );

    const form = fetchStub.calls[0].body as FormData;
    expect(form.get("mask")).toBeNull();
    expect(form.getAll("image[]")).toHaveLength(0);
    const image = form.get("image") as File;
    expect(image).toBeInstanceOf(Blob); // real source survives, override string dropped
  });

  test("DALL-E edits still request b64_json", async () => {
    fetchStub = stubFetch();
    await provider.generate(
      "key",
      BASE,
      req("dall-e-2", { resolvedSourceImages: [{ data: "QUJD", mimeType: "image/png" }] }),
    );

    const form = fetchStub.calls[0].body as FormData;
    expect(form.get("response_format")).toBe("b64_json");
    expect(form.get("input_fidelity")).toBeNull();
  });
});

describe("OpenAIImageProvider — URL responses and model listing", () => {
  const provider = new OpenAIImageProvider();
  let fetchStub: ReturnType<typeof stubFetch>;

  afterEach(() => fetchStub?.restore());

  test("inlines a url-style response as a base64 data URL", async () => {
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return new Response(JSON.stringify({ data: [{ url: "https://img.example.com/out.png" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(Buffer.from("hello"), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      });
    }) as typeof fetch;
    fetchStub = { calls: [] as any, restore: () => (globalThis.fetch = original) };

    const result = await provider.generate("key", BASE, req("dall-e-3"));
    expect(calls[1]).toBe("https://img.example.com/out.png");
    expect(result.imageDataUrl).toBe(`data:image/png;base64,${Buffer.from("hello").toString("base64")}`);
  });

  test("listModels filters image models from the mixed /models list", async () => {
    fetchStub = stubFetch({
      data: [{ id: "gpt-4.1" }, { id: "gpt-image-1" }, { id: "dall-e-3" }, { id: "text-embedding-3-small" }],
    });
    const models = await provider.listModels("key", BASE);
    expect(models.map((m) => m.id)).toEqual(["dall-e-3", "gpt-image-1"]);
  });

  test("listModels falls back to the full list when no known image models match (proxies)", async () => {
    fetchStub = stubFetch({ data: [{ id: "my-custom-image-model" }, { id: "another-model" }] });
    const models = await provider.listModels("key", "https://proxy.example.com/v1");
    expect(models.map((m) => m.id)).toEqual(["another-model", "my-custom-image-model"]);
  });
});

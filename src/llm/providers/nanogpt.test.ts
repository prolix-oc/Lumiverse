import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { NanoGPTProvider, buildNanoGptRouting } from "./nanogpt";
import { OpenRouterProvider } from "./openrouter";
import { injectConnectionMetadataFlags } from "../../services/generation/connection-metadata";
import { resolveEffectiveApiUrl } from "../../services/connections.service";
import type { GenerationRequest } from "../types";

const provider = new NanoGPTProvider();
const sent: { url: string; body: any }[] = [];
let fetchSpy: ReturnType<typeof spyOn> | undefined;
afterEach(() => { fetchSpy?.mockRestore(); sent.length = 0; });

function mockGeneration() {
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (url, init) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(url), body });
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ choices: [{ message: { content: "Hello" }, finish_reason: "stop" }] });
  }) as typeof fetch);
}

describe("NanoGPT routing at dispatch", () => {
  for (const stream of [false, true]) {
    test(`${stream ? "streaming" : "JSON"} uses model-specific routing and preserves caching`, async () => {
      mockGeneration();
      const settings = { billing_mode: "paygo", model_overrides: { "z-ai/glm-5": { only: ["novita"], order: ["novita"], allow_fallbacks: false, sort: "price" } } };
      const parameters: Record<string, unknown> = { caching: true, temperature: 0.7, _include_usage: true };
      injectConnectionMetadataFlags({ provider: "nanogpt", metadata: { nanogpt: settings } }, parameters);
      const request: GenerationRequest = { model: "z-ai/glm-5", messages: [{ role: "user", content: "Hi" }], parameters };
      if (stream) { for await (const _chunk of provider.generateStream("placeholder", "", request)) { /* drain */ } }
      else await provider.generate("placeholder", "", request);
      expect(sent[0].url).toBe("https://nano-gpt.com/api/v1/chat/completions");
      expect(sent[0].body).toMatchObject({ model: "z-ai/glm-5", billing_mode: "paygo", caching: true, temperature: 0.7, provider: settings.model_overrides["z-ai/glm-5"], stream });
      expect(sent[0].body._nanogpt).toBeUndefined();
      expect(sent[0].body._include_usage).toBeUndefined();
      if (stream) expect(sent[0].body.stream_options).toEqual({ include_usage: true });
      expect(parameters._nanogpt).toBe(settings);
    });
  }

  test("automatic requests keep the existing billing and routing behavior", async () => {
    mockGeneration();
    await provider.generate("placeholder", "", { model: "model", messages: [] });
    expect(sent[0].body.provider).toBeUndefined();
    expect(sent[0].body.billing_mode).toBeUndefined();
  });

  test("a model switch does not carry another model's provider pin", async () => {
    mockGeneration();
    await provider.generate("placeholder", "", { model: "another-model", messages: [], parameters: { _nanogpt: { model_overrides: { model: { only: ["novita"] } } } } });
    expect(sent[0].body.provider).toBeUndefined();
  });

  test("subscription-only metadata leaves PAYG routing inactive", async () => {
    mockGeneration();
    const connection = { provider: "nanogpt", metadata: { use_subscription_api: true, nanogpt: { billing_mode: "paygo", model_overrides: { model: { only: ["novita"] } } } } };
    const parameters: Record<string, unknown> = {};
    injectConnectionMetadataFlags(connection, parameters);
    await provider.generate("placeholder", resolveEffectiveApiUrl(connection), { model: "model", messages: [], parameters });
    expect(sent[0].url).toBe("https://nano-gpt.com/api/subscription/v1/chat/completions");
    expect(sent[0].body.provider).toBeUndefined();
    expect(sent[0].body.billing_mode).toBeUndefined();
  });

  test("empty preferences do not emit a provider object; custom request fields still work", async () => {
    mockGeneration();
    await provider.generate("placeholder", "", { model: "model", messages: [], parameters: { provider: "novita", _nanogpt: { model_overrides: { model: { only: [], order: [] } } } } });
    expect(sent[0].body.provider).toBe("novita");
  });

  test("internal NanoGPT metadata cannot leak to another compatible provider", async () => {
    mockGeneration();
    await new OpenRouterProvider().generate("placeholder", "", { model: "model", messages: [], parameters: { _nanogpt: { billing_mode: "paygo" } } });
    expect(sent[0].body._nanogpt).toBeUndefined();
    expect(sent[0].body.billing_mode).toBeUndefined();
  });
});

describe("NanoGPT routing constraints", () => {
  test("preserves false and zero caps, normalizes lists, and omits empty controls", () => {
    expect(buildNanoGptRouting({ order: [" novita ", "novita"], only: [], ignore: [], sort: "auto", allow_fallbacks: false, require_parameters: false, quantizations: ["fp8"], min_quantization: "fp8", max_price: { prompt: 0, completion: 2 } })).toEqual({ order: ["novita"], sort: "auto", allow_fallbacks: false, require_parameters: false, quantizations: ["fp8"], min_quantization: "fp8", max_price: { prompt: 0, completion: 2 } });
  });

  test("invalid hard constraints fail before contacting the provider", async () => {
    mockGeneration();
    for (const routing of [{ only: "novita" }, { only: [""] }, { quantizations: ["invalid"] }, { min_quantization: "unknown" }, { max_price: { prompt: -1 } }, { max_price: { completion: Infinity } }]) {
      await expect(provider.generate("placeholder", "", { model: "model", messages: [], parameters: { _nanogpt: { model_overrides: { model: routing } } } })).rejects.toThrow("Invalid NanoGPT");
    }
    expect(sent).toHaveLength(0);
  });
});

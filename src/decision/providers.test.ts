import { afterEach, describe, expect, test } from "bun:test";
import { decisionEvaluationUrl, fetchDecisionModels, evaluateProviderDecision, listProviders, resolveDecisionApiUrl, validateDecisionParameters } from "./providers";
import type { DecisionEvaluationInput, DecisionResult } from "./contract";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
describe("Decision provider adapters", () => {
  test("discovers Inception decisions by endpoint support, not text output modality", async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe("https://api.inceptionlabs.ai/v1/models");
      expect(init.headers.Authorization).toBe("Bearer inception-key");
      return Response.json({ data: [
        { id: "mercury-decide", name: "Inception: Mercury Decide", description: "Typed decisions", supported_endpoints: ["decisions"], input_modalities: ["text"], output_modalities: ["text"], context_length: 65536, pricing: { prompt: "0.00000002", completion: "0" } },
        { id: "mercury-3", supported_endpoints: ["chat.completions"], output_modalities: ["text"] },
        { id: "unknown", output_modalities: ["decisions"] },
      ] });
    }) as unknown as typeof fetch;
    expect(await fetchDecisionModels({ provider: "inception" }, "inception-key")).toEqual([{
      id: "mercury-decide", label: "Inception: Mercury Decide", description: "Typed decisions", input_modalities: ["text"], output_modalities: ["text"],
      context_length: 65536, pricing: { prompt: "0.00000002", completion: "0" }, protocol: "supported",
    }]);
  });
  test("Inception posts typed questions and preserves native answers and usage", async () => {
    const input: DecisionEvaluationInput = { state: { message: "Billing request" }, questions: {
      billing: { type: "noul", instructions: "Is this about billing?" },
      team: { type: "choice", instructions: "Pick a team", criteria: { billing: "Payments", support: "Technical" } },
      urgency: { type: "score", instructions: "Urgency", criteria: ["Routine", "Urgent"] },
    }, userId: "private-owner", connection_id: "private-profile" };
    const answers: DecisionResult["answers"] = {
      billing: { type: "noul", noul: 0.97 },
      team: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.9, support: 0.1 } },
      urgency: { type: "score", score: 0.25, confidence: 0.75, probabilities: { "0": 0.75, "1": 0.25 }, legend: { "0": "Routine", "1": "Urgent" } },
    };
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe("https://api.inceptionlabs.ai/v1/decisions");
      expect(init.method).toBe("POST");
      expect(init.headers.Authorization).toBe("Bearer inception-key");
      expect(init.headers["HTTP-Referer"]).toBeUndefined();
      expect(JSON.parse(init.body)).toEqual({ model: "mercury-decide", state: input.state, questions: input.questions });
      return Response.json({ model: "mercury-decide", answers, usage: { input_tokens: 48, output_tokens: 3 }, arbitrary: "not relayed" });
    }) as unknown as typeof fetch;
    expect(await evaluateProviderDecision({ provider: "inception", model: "mercury-decide", default_parameters: {} }, "inception-key", input)).toEqual({
      model: "mercury-decide", answers, usage: { input_tokens: 48, output_tokens: 3 },
    });
  });
  test("resolves provider endpoints and proxy prefixes without duplicating v1", () => {
    expect(decisionEvaluationUrl({ provider: "inception" })).toBe("https://api.inceptionlabs.ai/v1/decisions");
    expect(decisionEvaluationUrl({ provider: "inception", api_url: "https://proxy.test/root/v1/" })).toBe("https://proxy.test/root/v1/decisions");
    expect(decisionEvaluationUrl({ provider: "typesafe" })).toBe("https://api.typesafe.ai/v1/systemone");
    expect(decisionEvaluationUrl({ provider: "openrouter" })).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(decisionEvaluationUrl({ provider: "openrouter", api_url: "https://proxy.test/root/v1/" })).toBe("https://proxy.test/root/alpha/decisions");
    expect(decisionEvaluationUrl({ provider: "nanogpt" })).toBe("https://nano-gpt.com/api/v1/decisions");
    expect(decisionEvaluationUrl({ provider: "nanogpt", api_url: "https://proxy.test/root/v1/" })).toBe("https://proxy.test/root/v1/decisions");
    expect(decisionEvaluationUrl({ provider: "custom", api_url: "https://proxy.test/root/v1/" })).toBe("https://proxy.test/root/v1/systemone");
    expect(() => decisionEvaluationUrl({ provider: "typesafe", api_url: "https://key@provider.test/v1" })).toThrow();
  });
  test("lists the built-in Decision providers", () => {
    expect(listProviders().map((provider) => provider.id)).toEqual(["openrouter", "typesafe", "nanogpt", "inception", "custom"]);
    expect(listProviders().find((provider) => provider.id === "nanogpt")?.capabilities).toEqual({
      apiKeyRequired: true, defaultUrl: "https://nano-gpt.com/api/v1", suggestedModel: "typesafe/jev-latest", modelListStyle: "dynamic",
    });
    expect(listProviders().find((provider) => provider.id === "custom")?.capabilities).toEqual({
      apiKeyRequired: true, defaultUrl: "", suggestedModel: "", modelListStyle: "dynamic",
    });
  });
  test("requires an explicit endpoint for a custom provider", () => {
    expect(() => resolveDecisionApiUrl({ provider: "custom" })).toThrow("API URL");
    expect(resolveDecisionApiUrl({ provider: "custom", api_url: "https://proxy.test/root" })).toBe("https://proxy.test/root/v1");
    expect(resolveDecisionApiUrl({ provider: "custom", api_url: "https://proxy.test/root/v1" })).toBe("https://proxy.test/root/v1");
  });
  test("reads a TypeSafe-compatible custom model catalog", async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe("https://proxy.test/v1/models");
      expect(init.headers.Authorization).toBe("Bearer custom-key");
      return Response.json({ models: [{ name: "jev-latest" }, { name: "d1-ultra" }] });
    }) as unknown as typeof fetch;
    const models = await fetchDecisionModels({ provider: "custom", api_url: "https://proxy.test/v1" }, "custom-key");
    expect(models.map((m) => m.id)).toEqual(["d1-ultra", "jev-latest"]);
    expect(models.every((m) => m.input_modalities?.includes("image"))).toBe(true);
    expect(models.every((m) => m.protocol === "unverified")).toBe(true);
  });
  test("normalizes TypeSafe model names without synthesizing versioned IDs", async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe("https://api.typesafe.ai/v1/models");
      expect(init.headers.Authorization).toBe("Bearer test-key");
      return Response.json({ models: [{ name: "jev-latest", description: "Alias" }, { name: "jev-preview" }] });
    }) as unknown as typeof fetch;
    const models = await fetchDecisionModels({ provider: "typesafe" }, "test-key");
    expect(models.map((m) => m.id)).toEqual(["jev-latest", "jev-preview"]);
    expect(models[0].input_modalities).toEqual(["text", "image"]);
  });
  test("filters OpenRouter by modality and flags incompatible protocols", async () => {
    globalThis.fetch = (async (url: any) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/models?output_modalities=decisions");
      return Response.json({ data: [
        { id: "~typesafe/jev-latest", name: "Jev Latest", architecture: { output_modalities: ["decisions"] } },
        { id: "togethercomputer/tev1-4b-experimental", name: "Tev1", architecture: { output_modalities: ["decisions"] } },
        { id: "new/decision", name: "New", architecture: { output_modalities: ["decisions"], input_modalities: ["text", "image"] }, pricing: { prompt: "0.01" } },
        { id: "chat/model", architecture: { output_modalities: ["text"] } },
      ] });
    }) as unknown as typeof fetch;
    const models = await fetchDecisionModels({ provider: "openrouter" }, "key");
    expect(models).toHaveLength(3);
    expect(models.find((m) => m.id.startsWith("~"))?.protocol).toBe("supported");
    expect(models.find((m) => m.id.startsWith("together"))?.protocol).toBe("unsupported");
    expect(models.find((m) => m.id === "new/decision")?.protocol).toBe("unverified");
    expect(models.find((m) => m.id === "new/decision")?.output_modalities).toEqual(["decisions"]);
  });
  test("discovers NanoGPT decision models from the detailed catalog", async () => {
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe("https://nano-gpt.com/api/v1/models?detailed=true");
      expect(init.headers.Authorization).toBe("Bearer nano-key");
      return Response.json({ object: "list", data: [
        { id: "typesafe/jev-latest", name: "Jev Latest", architecture: { input_modalities: ["text"], output_modalities: ["decisions"] } },
        { id: "cloudflare/clef", name: "Clef", description: "Cloudflare's decision model", context_length: 1800, architecture: { input_modalities: ["text", "image"], output_modalities: ["decisions"] }, pricing: { prompt: 0.05, completion: 0, currency: "USD" } },
        { id: "llmtech/decider-2b-fp8", name: "Decider 2B", architecture: { output_modalities: ["decisions"] } },
        { id: "openai/gpt-6.1-sol", name: "GPT 6.1 Sol", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
        { id: "no-architecture-model", name: "No Architecture" },
      ] });
    }) as unknown as typeof fetch;
    const models = await fetchDecisionModels({ provider: "nanogpt" }, "nano-key");
    expect(models.map((m) => m.id)).toEqual(["cloudflare/clef", "llmtech/decider-2b-fp8", "typesafe/jev-latest"]);
    expect(models.every((m) => m.protocol === "supported")).toBe(true);
    expect(models.find((m) => m.id === "cloudflare/clef")).toMatchObject({
      label: "Clef", description: "Cloudflare's decision model", context_length: 1800,
      input_modalities: ["text", "image"], output_modalities: ["decisions"], pricing: { prompt: "0.05", completion: "0", currency: "USD" },
    });
  });
  test("posts native JSON and preserves usage, IDs and resolved model", async () => {
    const input: DecisionEvaluationInput = { state: "Lumiverse", questions: { yes: { type: "noul", instructions: "Mentioned?" } }, userId: "must-not-forward" };
    globalThis.fetch = (async (url: any, init: any) => {
      expect(url).toBe("https://openrouter.ai/api/alpha/decisions");
      expect(JSON.parse(init.body)).toEqual({ model: "~typesafe/jev-latest", state: input.state, questions: input.questions });
      expect(init.redirect).toBe("error");
      expect(init.headers).not.toHaveProperty("TypeSafe-Danger-Zone-Images");
      return Response.json({ model: "typesafe/resolved", answers: { yes: { type: "noul", noul: 0.81234 } }, usage: { input_tokens: null, cost: 0.00001 }, id: "request-id", provider: "TypeSafe", secret_extra: "hidden" });
    }) as unknown as typeof fetch;
    const result = await evaluateProviderDecision({ provider: "openrouter", model: "~typesafe/jev-latest", default_parameters: {} }, "key", input);
    expect(result.usage).toEqual({ input_tokens: null, cost: 0.00001 });
    expect(result.id).toBe("request-id");
    expect(result).not.toHaveProperty("secret_extra");
  });
  test("evaluates NanoGPT decisions through the native endpoint", async () => {
    const input: DecisionEvaluationInput = {
      state: { ticket: "I was charged twice." },
      questions: { route: { type: "choice", instructions: "Which team?", criteria: { billing: null, technical: null } } },
    };
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe("https://nano-gpt.com/api/v1/decisions");
      expect(init.headers.Authorization).toBe("Bearer nano-key");
      expect(init.headers).not.toHaveProperty("HTTP-Referer");
      expect(init.headers).not.toHaveProperty("TypeSafe-Danger-Zone-Images");
      expect(JSON.parse(init.body)).toEqual({ model: "typesafe/jev-1.13", state: input.state, questions: input.questions });
      return Response.json({
        id: "decision_1", model: "typesafe/jev-1.13",
        answers: { route: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.9, technical: 0.1 } } },
        usage: { input_tokens: 126, output_tokens: 1, estimated_cost: 0.000005292 },
      });
    }) as unknown as typeof fetch;
    const result = await evaluateProviderDecision({ provider: "nanogpt", model: "typesafe/jev-1.13", default_parameters: {} }, "nano-key", input);
    expect(result.answers).toEqual({ route: { type: "choice", choice: "billing", confidence: 0.9, probabilities: { billing: 0.9, technical: 0.1 } } });
    expect(result.usage).toEqual({ input_tokens: 126, output_tokens: 1, estimated_cost: 0.000005292 });
    expect(result.id).toBe("decision_1");
  });
  test("sends TypeSafe image assets and Box questions with the images header", async () => {
    const input: DecisionEvaluationInput = {
      state: { page: "ref-page" }, assets: { "ref-page": { type: "image", format: "jpg", data_base64: "/9j/" } },
      questions: { face: { type: "box", instructions: "the face in `page`" } },
    };
    globalThis.fetch = (async (url: any, init: any) => {
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect(init.headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
      expect(JSON.parse(init.body)).toEqual({ model: "jev-preview", state: input.state, questions: input.questions, assets: input.assets });
      return Response.json({ model: "jev-1.14.0", answers: { face: { type: "box", box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.4 }, confidence: 0.66 } } });
    }) as unknown as typeof fetch;
    const result = await evaluateProviderDecision({ provider: "typesafe", model: "jev-preview", default_parameters: {}, metadata: { image_understanding: true } }, "key", input);
    expect(result.answers.face).toEqual({ type: "box", box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.4 }, confidence: 0.66 });
    // Vision decision models on OpenRouter take the same assets map without the
    // TypeSafe opt-in header.
    const sent: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    globalThis.fetch = (async (url: any, init: any) => {
      sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(init.body) });
      return Response.json({ model: "liquid/d1", answers: { face: { type: "box", box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.4 }, confidence: 0.66 } } });
    }) as unknown as typeof fetch;
    await evaluateProviderDecision({ provider: "openrouter", model: "liquid/d1-ultra", default_parameters: {} }, "key", input);
    expect(sent[0].url).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(sent[0].headers).not.toHaveProperty("TypeSafe-Danger-Zone-Images");
    expect(sent[0].body.assets).toEqual(input.assets);
    // A TypeSafe-compatible custom endpoint still needs the opt-in header.
    await evaluateProviderDecision({ provider: "custom", api_url: "https://proxy.test/v1", model: "jev-latest", default_parameters: {} }, "key", input);
    expect(sent[1].url).toBe("https://proxy.test/v1/systemone");
    expect(sent[1].headers["TypeSafe-Danger-Zone-Images"]).toBe("true");
    expect(sent[1].body.assets).toEqual(input.assets);
    // TypeSafe image understanding is off by default: no images, no header.
    globalThis.fetch = (async (url: any, init: any) => {
      sent.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(init.body) });
      return Response.json({ model: "jev-preview", answers: { check: { type: "noul", noul: 0.5 } } });
    }) as unknown as typeof fetch;
    const noulInput: DecisionEvaluationInput = { state: { page: "ref-page" }, assets: input.assets, questions: { check: { type: "noul", instructions: "Is it a page?" } } };
    await evaluateProviderDecision({ provider: "typesafe", model: "jev-preview", default_parameters: {} }, "key", noulInput);
    expect(sent[2].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(sent[2].headers).not.toHaveProperty("TypeSafe-Danger-Zone-Images");
    expect(sent[2].body).not.toHaveProperty("assets");
    await expect(evaluateProviderDecision({ provider: "typesafe", model: "jev-preview", default_parameters: {} }, "key", input)).rejects.toThrow("image understanding");
    expect(sent.length).toBe(3);
  });
  test("rejects arbitrary defaults and preserves permitted routing", () => {
    expect(() => validateDecisionParameters("openrouter", { model: "override" })).toThrow();
    expect(() => validateDecisionParameters("typesafe", { temperature: 0 })).toThrow();
    expect(() => validateDecisionParameters("nanogpt", { provider: { only: ["cloudflare"] } })).toThrow("OpenRouter");
    expect(validateDecisionParameters("openrouter", { provider: { only: ["TypeSafe"], allow_fallbacks: false } })).toEqual({ provider: { only: ["TypeSafe"], allow_fallbacks: false } });
  });
  test("invalid provider answers are errors, never fabricated decisions", async () => {
    globalThis.fetch = (async () => Response.json({ model: "x", answers: {} })) as unknown as typeof fetch;
    await expect(evaluateProviderDecision({ provider: "typesafe", model: "jev-latest", default_parameters: {} }, "key", { state: "text", questions: { check: { type: "noul", instructions: "Check?" } } })).rejects.toThrow("invalid Decision answers");
  });
});

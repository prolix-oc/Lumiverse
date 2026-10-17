import { afterEach, describe, expect, test } from "bun:test";
import { decisionEvaluationUrl, fetchDecisionModels, evaluateProviderDecision, validateDecisionParameters } from "./providers";
import type { DecisionEvaluationInput } from "./contract";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
describe("Decision provider adapters", () => {
  test("resolves provider endpoints and proxy prefixes without duplicating v1", () => {
    expect(decisionEvaluationUrl({ provider: "typesafe" })).toBe("https://api.typesafe.ai/v1/systemone");
    expect(decisionEvaluationUrl({ provider: "openrouter" })).toBe("https://openrouter.ai/api/alpha/decisions");
    expect(decisionEvaluationUrl({ provider: "openrouter", api_url: "https://proxy.test/root/v1/" })).toBe("https://proxy.test/root/alpha/decisions");
    expect(() => decisionEvaluationUrl({ provider: "typesafe", api_url: "https://key@provider.test/v1" })).toThrow();
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
    const result = await evaluateProviderDecision({ provider: "typesafe", model: "jev-preview", default_parameters: {} }, "key", input);
    expect(result.answers.face).toEqual({ type: "box", box: { top: 0.1, bottom: 0.5, left: 0.2, right: 0.4 }, confidence: 0.66 });
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as unknown as typeof fetch;
    await expect(evaluateProviderDecision({ provider: "openrouter", model: "~typesafe/jev-latest", default_parameters: {} }, "key", input)).rejects.toThrow("TypeSafe Decision connection");
    expect(calls).toBe(0);
  });
  test("rejects arbitrary defaults and preserves permitted routing", () => {
    expect(() => validateDecisionParameters("openrouter", { model: "override" })).toThrow();
    expect(() => validateDecisionParameters("typesafe", { temperature: 0 })).toThrow();
    expect(validateDecisionParameters("openrouter", { provider: { only: ["TypeSafe"], allow_fallbacks: false } })).toEqual({ provider: { only: ["TypeSafe"], allow_fallbacks: false } });
  });
  test("invalid provider answers are errors, never fabricated decisions", async () => {
    globalThis.fetch = (async () => Response.json({ model: "x", answers: {} })) as unknown as typeof fetch;
    await expect(evaluateProviderDecision({ provider: "typesafe", model: "jev-latest", default_parameters: {} }, "key", { state: "text", questions: { check: { type: "noul", instructions: "Check?" } } })).rejects.toThrow("invalid Decision answers");
  });
});

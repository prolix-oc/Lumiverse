import { describe, expect, test } from "bun:test";
import { JEV_GATEWAY_ADAPTERS, JEV_PRESETS, listJevModels, normalizeJevResponse } from "./jev";
import { validateDecisionRequest, type DecisionRequest, type DecisionResult } from "./types";

const request: DecisionRequest = {
  state: { ticket: { message: "Please refund the duplicate charge", charges: [42, 42] } },
  questions: {
    route: { type: "choice", instructions: { question: "Which team?", policy: ["Refunds go to billing"] }, criteria: { billing: { task: "refund" }, support: null } },
    severity: { type: "score", instructions: ["Rate severity", { age_days: 2 }], criteria: ["Low", { level: "Medium" }, "High"] },
    urgent: { type: "noul", instructions: "Is it urgent?", criteria: { true: { meaning: "yes" }, false: "no" } },
  },
};

const response: DecisionResult = {
  model: "jev-1.13.0",
  answers: {
    route: { type: "choice", choice: "billing", probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.8 },
    severity: { type: "score", score: 1.25, legend: { "0": "Low", "1": "Medium", "2": "High" }, probabilities: { "0": 0, "1": 0.75, "2": 0.25 }, confidence: 0.7 },
    urgent: { type: "noul", noul: 0.95 },
  },
  usage: { input_tokens: 120, output_tokens: 24 },
};

describe("Jev decision adapter", () => {
  test("preserves structured state, instructions, and criteria", () => {
    validateDecisionRequest(request);
    const body = JEV_GATEWAY_ADAPTERS.typesafe.body("jev-1.13.0", request) as any;
    expect(body.state).toEqual(request.state);
    expect(body.questions).toEqual(request.questions);
    expect(JEV_GATEWAY_ADAPTERS.cloudflare.body("typesafe/jev", request)).toEqual({ model: "typesafe/jev", input: { state: request.state, questions: request.questions } });
  });

  test("normalizes all three answer primitives and provider envelopes", () => {
    expect(normalizeJevResponse(response, request)).toEqual(response);
    expect(normalizeJevResponse(JEV_GATEWAY_ADAPTERS.anoman.unwrap({ data: response }), request)).toEqual(response);
    expect(normalizeJevResponse(JEV_GATEWAY_ADAPTERS.cloudflare.unwrap({ result: response }), request)).toEqual(response);
  });

  test("rejects invalid questions and incomplete answers", () => {
    expect(() => validateDecisionRequest({ ...request, questions: { bad: { type: "score", instructions: "x", criteria: ["only one"] } } })).toThrow();
    expect(() => normalizeJevResponse({ ...response, answers: { urgent: response.answers.urgent } }, request)).toThrow();
  });

  test("keeps every gateway in the decision adapter registry", () => {
    expect(JEV_PRESETS).toHaveLength(10);
    for (const preset of JEV_PRESETS) {
      const adapter = JEV_GATEWAY_ADAPTERS[preset.id];
      const body = adapter.body(preset.model, request) as any;
      const payload = preset.id === "cloudflare" ? body.input : body;
      expect(payload.state).toEqual(request.state);
      expect(payload.questions).toEqual(request.questions);
      const raw = preset.id === "anoman" ? { data: response } : preset.id === "cloudflare" ? { result: response } : response;
      expect(normalizeJevResponse(adapter.unwrap(raw), request)).toEqual(response);
    }
  });

  test("offers only decision models for every gateway", async () => {
    for (const preset of JEV_PRESETS) {
      const result = await listJevModels({ protocol: preset.id, api_url: preset.url, account_id: "", apiKey: "" });
      expect(result.models).toContain(preset.model);
      expect(result.models.every((id) => id.toLowerCase().includes("jev"))).toBe(true);
    }
    expect((await listJevModels({ protocol: "openrouter", api_url: "", account_id: "", apiKey: "" })).models).toContain("~typesafe/jev-latest");
  });
});

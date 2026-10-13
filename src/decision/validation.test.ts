import { describe, expect, test } from "bun:test";
import { validateDecisionInput, validateDecisionResult } from "./validation";
import type { DecisionEvaluationInput } from "./contract";

const input: DecisionEvaluationInput = {
  state: { message: "Let's change scenes" }, questions: {
    handling: { type: "choice", instructions: { question: "Which path?" }, criteria: { continue: null, transition: ["Change scenes"] } },
    intensity: { type: "score", instructions: "Intensity?", criteria: ["Low", "High"] },
    change: { type: "noul", instructions: "Change scenes?" },
  },
};
const result = () => ({ model: "model-resolved", answers: {
  handling: { type: "choice", choice: "transition", confidence: 0.62, probabilities: { continue: 0.2, transition: 0.8 } },
  intensity: { type: "score", score: 0.731, confidence: 0.45, probabilities: { "0": 0.269, "1": 0.731 }, legend: { "0": "Low", "1": "High" } },
  change: { type: "noul", noul: 0.915 },
} });
describe("Decision contracts", () => {
  test("accepts mixed questions with structured descriptions and null Choice criteria", () => {
    expect(() => validateDecisionInput(input)).not.toThrow();
    const value = result();
    validateDecisionResult(value, input.questions);
    expect(value.answers.intensity.score).toBe(0.731);
    expect(value.answers.change.noul).toBe(0.915);
    expect(value).not.toHaveProperty("usage");
  });
  test.each([null, [], { state: "x", questions: {} }, { state: null, questions: input.questions }, { ...input, model: 3 }, { ...input, questions: { x: { type: "noul" } } }, { ...input, questions: { x: { type: "noul", instructions: "x", criteria: { true: "yes" } } } }, { ...input, questions: { x: { type: "score", instructions: "x", criteria: ["one"] } } }, { ...input, questions: { x: { type: "choice", instructions: "x", criteria: ["a", "b"] } } }].map((value) => [value]))("rejects malformed input %p", (value) => {
    expect(() => validateDecisionInput(value)).toThrow();
  });
  test("rejects non-JSON/cyclic and excessive state", () => {
    const cycle: any = {}; cycle.self = cycle;
    expect(() => validateDecisionInput({ ...input, state: cycle })).toThrow();
    expect(() => validateDecisionInput({ ...input, state: "x".repeat(1024 * 1024) })).toThrow();
  });
  test.each(["missing", "extra", "type", "range", "option", "distribution", "usage", "score"])("rejects invalid provider answers: %s", (failure) => {
    const value: any = result();
    if (failure === "missing") delete value.answers.change;
    if (failure === "extra") value.answers.other = { type: "noul", noul: 1 };
    if (failure === "type") value.answers.change = { type: "choice" };
    if (failure === "range") value.answers.change.noul = 1.1;
    if (failure === "option") value.answers.handling.choice = "invented";
    if (failure === "distribution") value.answers.handling.probabilities.continue = 0.5;
    if (failure === "usage") value.usage = { input_tokens: -1 };
    if (failure === "score") value.answers.intensity.score = NaN;
    expect(() => validateDecisionResult(value, input.questions)).toThrow();
  });
});

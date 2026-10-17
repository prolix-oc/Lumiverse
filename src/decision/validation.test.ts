import { describe, expect, test } from "bun:test";
import { validateDecisionInput, validateDecisionResult, usesDecisionImages } from "./validation";
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

const imageInput: DecisionEvaluationInput = {
  state: { page: "ref-page" },
  assets: { "ref-page": { type: "image", format: "png", data_base64: "iVBORw0KGgo=" }, "ref-badge": { image_id: "stored-image" } },
  questions: {
    present: { type: "noul", instructions: "Is the person from ref-badge in `page`?" },
    face: { type: "box", instructions: "the face in `page`" },
  },
};
const boxResult = () => ({ model: "jev-1.14.0", answers: {
  present: { type: "noul", noul: 0.9 },
  face: { type: "box", box: { top: 0.1, bottom: 0.4, left: 0.3, right: 0.6 }, confidence: 0.7 },
} });
describe("Decision images and Box", () => {
  test("accepts referenced base64 and image_id assets with Box questions", () => {
    expect(() => validateDecisionInput(imageInput)).not.toThrow();
    expect(usesDecisionImages(imageInput)).toBe(true);
    expect(usesDecisionImages(input)).toBe(false);
    const value = boxResult();
    validateDecisionResult(value, imageInput.questions);
    expect(value.answers.face.box.right).toBe(0.6);
  });
  test.each([
    ["Box criteria", { questions: { ...imageInput.questions, face: { type: "box", instructions: "x", criteria: ["a", "b"] } } }],
    ["Box without image", { assets: undefined, state: "text" }],
    ["unreferenced asset", { assets: { ...imageInput.assets, "ref-unused": { image_id: "other" } } }],
    ["image_id with data", { assets: { ...imageInput.assets, "ref-badge": { image_id: "stored", format: "png", data_base64: "AAAA" } } }],
    ["unknown format", { assets: { ...imageInput.assets, "ref-page": { format: "webp", data_base64: "AAAA" } } }],
    ["data URL", { assets: { ...imageInput.assets, "ref-page": { format: "png", data_base64: "data:image/png;base64,AAAA" } } }],
    ["line breaks", { assets: { ...imageInput.assets, "ref-page": { format: "png", data_base64: "AAAA\nAAAA" } } }],
    ["over 20 MiB", { assets: { ...imageInput.assets, "ref-page": { format: "jpg", data_base64: "A".repeat(28 * 1024 * 1024) } } }],
  ])("rejects %s", (_name, patch) => {
    expect(() => validateDecisionInput({ ...imageInput, ...patch })).toThrow();
  });
  test("image bytes do not count toward the 1 MiB question cap", () => {
    const large = { format: "jpg", data_base64: "A".repeat(4 * 1024 * 1024) };
    expect(() => validateDecisionInput({ ...imageInput, assets: { ...imageInput.assets, "ref-page": large } })).not.toThrow();
  });
  test.each(["range", "order", "keys", "confidence"])("rejects invalid Box answers: %s", (failure) => {
    const value: any = boxResult();
    if (failure === "range") value.answers.face.box.bottom = 1.2;
    if (failure === "order") value.answers.face.box.left = 0.7;
    if (failure === "keys") delete value.answers.face.box.top;
    if (failure === "confidence") delete value.answers.face.confidence;
    expect(() => validateDecisionResult(value, imageInput.questions)).toThrow();
  });
});

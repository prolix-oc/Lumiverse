import type { DecisionEvaluationInput, DecisionQuestion, DecisionResult } from "./contract";

export class DecisionValidationError extends Error {}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fail(message: string): never { throw new DecisionValidationError(message); }
function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.values(value).every((item) => jsonValue(item, depth + 1));
}
function description(value: unknown): boolean {
  return (typeof value === "string" || Array.isArray(value) || isRecord(value)) && jsonValue(value);
}
export function validateDecisionInput(input: unknown): asserts input is DecisionEvaluationInput {
  if (!isRecord(input)) fail("Decision input must be an object");
  if (!description(input.state)) fail("state must be text, a JSON object, or an array");
  for (const key of ["connection_id", "model", "userId"]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || !input[key].trim())) fail(`${key} must be a nonempty string`);
  }
  if (!isRecord(input.questions) || Object.keys(input.questions).length === 0 || Object.keys(input.questions).length > 256) fail("questions must contain 1–256 named questions");
  for (const [id, q] of Object.entries(input.questions)) {
    if (!id.trim() || !isRecord(q) || !description(q.instructions)) fail(`Question ${id} requires valid instructions`);
    if (q.type === "choice") {
      if (!isRecord(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 255
        || Object.entries(q.criteria).some(([key, value]) => !key.trim() || (value !== null && !description(value)))) fail(`Question ${id} requires 2–255 Choice options`);
    } else if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10 || !q.criteria.every(description)) fail(`Question ${id} requires 2–10 Score levels`);
    } else if (q.type === "noul") {
      if (q.criteria !== undefined && (!isRecord(q.criteria) || !description(q.criteria.true) || !description(q.criteria.false)
        || Object.keys(q.criteria).some((key) => key !== "true" && key !== "false"))) fail(`Question ${id} Noul criteria require true and false descriptions`);
    } else fail(`Question ${id} has an unsupported type`);
  }
  if (Buffer.byteLength(JSON.stringify(input)) > 1024 * 1024) fail("Decision input exceeds 1 MiB");
}
const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
function sameKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
/** Validate native values without rounding, filling missing results, or inventing usage. */
export function validateDecisionResult(value: unknown, questions: Record<string, DecisionQuestion>): asserts value is DecisionResult {
  if (!isRecord(value) || typeof value.model !== "string" || !value.model.trim() || !sameKeys(value.answers, Object.keys(questions))) fail("Provider returned invalid Decision answers");
  for (const [id, question] of Object.entries(questions)) {
    const answer = value.answers[id];
    if (!isRecord(answer) || answer.type !== question.type) fail(`Provider returned a mismatched answer for ${id}`);
    if (question.type === "noul") {
      if (!probability(answer.noul)) fail(`Provider returned an invalid Noul probability for ${id}`);
      continue;
    }
    const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    if (!probability(answer.confidence) || !sameKeys(answer.probabilities, keys) || !Object.values(answer.probabilities).every(probability)) fail(`Provider returned invalid probabilities for ${id}`);
    const sum = Object.values(answer.probabilities).reduce<number>((total, p) => total + (p as number), 0);
    if (Math.abs(sum - 1) > 0.01) fail(`Provider probabilities do not sum to 1 for ${id}`);
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !keys.includes(answer.choice)) fail(`Provider returned an unknown Choice option for ${id}`);
    } else {
      if (typeof answer.score !== "number" || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1
        || !sameKeys(answer.legend, keys) || !Object.values(answer.legend).every(description)) fail(`Provider returned an invalid Score for ${id}`);
    }
  }
  if (value.usage !== undefined && !isRecord(value.usage)) fail("Provider returned invalid Decision usage");
  if (isRecord(value.usage)) for (const key of ["input_tokens", "output_tokens", "cost"]) {
    const n = value.usage[key];
    if (n !== undefined && n !== null && (typeof n !== "number" || !Number.isFinite(n) || n < 0)) fail("Provider returned invalid Decision usage");
  }
  for (const key of ["id", "provider"]) if (value[key] !== undefined && typeof value[key] !== "string") fail(`Provider returned an invalid ${key}`);
}

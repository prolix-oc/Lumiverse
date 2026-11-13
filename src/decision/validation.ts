import type { DecisionAnswer, DecisionEvaluationInput, DecisionQuestion, DecisionResult } from "./contract";

/**
 * Decoded image bytes per request. Fits 8 NovelAI 832x1216 PNGs (largest seen: 2.5 MiB) or 8 JPEGs at 1568 px;
 * as base64 (+33%) plus the 1 MiB question cap it stays under TypeSafe's 32 MiB request limit.
 */
export const DECISION_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

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
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value) || isRecord(value)) for (const item of Object.values(value)) strings(item, out);
  return out;
}
/** Images and Box questions need TypeSafe's images header and are only sent to TypeSafe. */
export function usesDecisionImages(input: DecisionEvaluationInput): boolean {
  return Object.keys(input.assets ?? {}).length > 0 || Object.values(input.questions).some((q) => q.type === "box");
}
/** Decoded size of an already validated, padded base64 image. */
export function decisionImageByteLength(data: string): number {
  return data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
function validateAssets(assets: unknown, text: string[]): Record<string, unknown> {
  if (!isRecord(assets)) fail("assets must be an object");
  const metadata: Record<string, unknown> = Object.create(null);
  let bytes = 0;
  for (const [ref, asset] of Object.entries(assets)) {
    if (!ref.trim() || Buffer.byteLength(ref) > 1024) fail("Asset references must be 1–1024 bytes");
    if (!text.some((s) => s.includes(ref))) fail(`Asset ${ref} is not referenced in state, instructions, or criteria`);
    if (!isRecord(asset) || (asset.type !== undefined && asset.type !== "image")) fail(`Asset ${ref} must be an image`);
    if (asset.image_id !== undefined) {
      if (typeof asset.image_id !== "string" || !asset.image_id.trim()) fail(`Asset ${ref} needs a nonempty image_id`);
      if (Object.keys(asset).some((key) => key !== "type" && key !== "image_id")) fail(`Asset ${ref} with image_id only supports type and image_id`);
      metadata[ref] = asset;
      continue;
    }
    if (Object.keys(asset).some((key) => key !== "type" && key !== "format" && key !== "data_base64")) fail(`Asset ${ref} only supports type, format, and data_base64`);
    const data = asset.data_base64;
    if (!["png", "jpg", "jpeg"].includes(asset.format as string) || typeof data !== "string" || !data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      fail(`Asset ${ref} requires an image_id, or a png/jpg format with plain base64 data`);
    }
    bytes += decisionImageByteLength(data);
    metadata[ref] = { ...asset, data_base64: "" };
  }
  if (bytes > DECISION_IMAGE_MAX_BYTES) fail(`Decision images exceed ${DECISION_IMAGE_MAX_BYTES / (1024 * 1024)} MiB`);
  return metadata;
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
    } else if (q.type === "box") {
      if (q.criteria !== undefined) fail(`Question ${id} is a Box question and takes no criteria`);
    } else fail(`Question ${id} has an unsupported type`);
  }
  const { assets, ...rest } = input;
  const questions = Object.values(input.questions) as DecisionQuestion[];
  const metadata = assets === undefined ? rest : {
    ...rest,
    assets: validateAssets(assets, strings([input.state, ...questions.map((q) => [q.instructions, "criteria" in q ? q.criteria : null])])),
  };
  if (questions.some((q) => q.type === "box") && !Object.keys(assets ?? {}).length) fail("Box questions require an image in assets");
  if (Buffer.byteLength(JSON.stringify(metadata)) > 1024 * 1024) fail("Decision input exceeds 1 MiB");
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
    if (question.type === "box") {
      const box = answer.box;
      if (!probability(answer.confidence) || !sameKeys(box, ["top", "bottom", "left", "right"]) || !Object.values(box).every(probability)
        || !((box.left as number) < (box.right as number)) || !((box.top as number) < (box.bottom as number))) fail(`Provider returned an invalid Box for ${id}`);
      continue;
    }
    const keys = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, i) => String(i));
    if (!probability(answer.confidence) || !sameKeys(answer.probabilities, keys) || !Object.values(answer.probabilities).every(probability)) fail(`Provider returned invalid probabilities for ${id}`);
    const sum = Object.values(answer.probabilities).reduce<number>((total, p) => total + (p as number), 0);
    // Decimal totals at the tolerance boundary (e.g. 0.99) must not fail
    // because binary floating-point subtraction lands just above 0.01.
    if (Math.abs(sum - 1) > 0.01 + keys.length * Number.EPSILON) fail(`Provider probabilities do not sum to 1 for ${id} (sum=${Number(sum.toPrecision(12))}, options=${keys.length})`);
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

export interface DecisionAnswerIssue {
  questionId: string;
  message: string;
}

/** Internal partial report; never expose this as a complete DecisionResult. */
export interface DecisionAnswerReport {
  result: Omit<DecisionResult, "answers"> & { answers: Partial<Record<string, DecisionAnswer>> };
  issues: DecisionAnswerIssue[];
}

/** Preserve valid answers for a caller that can retry/defer individual items.
 * Missing/foreign IDs or malformed metadata still invalidate the whole response.
 * Uses the same strict validator; no probabilities are repaired or normalized. */
export function inspectDecisionAnswers(value: unknown, questions: Record<string, DecisionQuestion>): DecisionAnswerReport {
  if (!isRecord(value) || !sameKeys(value.answers, Object.keys(questions))) fail("Provider returned invalid Decision answers");
  const envelope = { ...value, answers: {} };
  validateDecisionResult(envelope, {});
  const answers: Partial<Record<string, DecisionAnswer>> = Object.create(null);
  const issues: DecisionAnswerIssue[] = [];
  for (const [id, question] of Object.entries(questions)) {
    const single = { ...envelope, answers: { [id]: value.answers[id] } };
    try {
      validateDecisionResult(single, { [id]: question });
      answers[id] = single.answers[id];
    } catch (error) {
      if (!(error instanceof DecisionValidationError)) throw error;
      issues.push({ questionId: id, message: error.message });
    }
  }
  return { result: { model: envelope.model, answers,
    ...(envelope.usage !== undefined ? { usage: envelope.usage } : {}),
    ...(envelope.id !== undefined ? { id: envelope.id } : {}),
    ...(envelope.provider !== undefined ? { provider: envelope.provider } : {}),
  }, issues };
}

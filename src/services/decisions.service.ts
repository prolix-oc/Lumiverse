import type { DecisionEvaluationInput, DecisionImageAsset, DecisionQuestion, DecisionResult } from "../decision/contract";
import { validateDecisionInput, decisionImageByteLength, DecisionValidationError, DECISION_IMAGE_MAX_BYTES, type DecisionAnswerReport } from "../decision/validation";
import { ProviderRequestError } from "../utils/provider-errors";
import { evaluateProviderDecision, evaluateProviderDecisionAnswers, redactDecisionError } from "../decision/providers";
import * as connections from "./decision-connections.service";
import * as secrets from "./secrets.service";
import * as images from "./images.service";

export class DecisionConnectionNotFoundError extends Error {}
export class DecisionTimeoutError extends Error {}
/** Resolve stored images without reading or retaining more than the shared image budget. */
async function resolveImageAssets<I extends DecisionEvaluationInput>(userId: string, input: I, signal: AbortSignal): Promise<I> {
  if (!input.assets || !Object.values(input.assets).some((asset) => "image_id" in asset)) return input;
  const assets: Record<string, DecisionImageAsset> = Object.create(null);
  // Count every inline image first, regardless of its position in the asset map.
  let imageBytes = Object.values(input.assets).reduce((total, asset) => total + ("data_base64" in asset ? decisionImageByteLength(asset.data_base64) : 0), 0);
  const sizeLimitError = `Decision images exceed ${DECISION_IMAGE_MAX_BYTES / (1024 * 1024)} MiB`;
  for (const [ref, asset] of Object.entries(input.assets)) {
    signal.throwIfAborted();
    if (!("image_id" in asset)) { assets[ref] = asset; continue; }
    const path = await images.getImageFilePath(userId, asset.image_id);
    signal.throwIfAborted();
    if (!path) throw new DecisionValidationError(`Image ${asset.image_id} not found`);
    const file = Bun.file(path);
    const remainingBytes = DECISION_IMAGE_MAX_BYTES - imageBytes;
    if (file.size > remainingBytes) throw new DecisionValidationError(sizeLimitError);
    // Bound the read as well as checking stat: a file can grow after its size is checked.
    const bytes = Buffer.from(await file.slice(0, remainingBytes + 1).arrayBuffer());
    signal.throwIfAborted();
    imageBytes += bytes.length;
    if (imageBytes > DECISION_IMAGE_MAX_BYTES) throw new DecisionValidationError(sizeLimitError);
    const format = bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === "PNG" ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : null;
    if (!format) throw new DecisionValidationError(`Image ${asset.image_id} must be a PNG or JPEG`);
    assets[ref] = { type: "image", format, data_base64: bytes.toString("base64") };
  }
  const resolved = { ...input, assets };
  validateDecisionInput(resolved);
  return resolved;
}
export async function evaluateDecision<const Q extends Record<string, DecisionQuestion>>(userId: string, input: DecisionEvaluationInput<Q>, signal?: AbortSignal): Promise<DecisionResult<Q>> {
  return evaluateDecisionRequest(userId, input, evaluateProviderDecision, signal) as Promise<DecisionResult<Q>>;
}

/** Internal batch consumer; the public evaluate API continues to require
 * every answer to be valid. Credentials, ownership and deadlines are shared. */
export async function evaluateDecisionAnswers(userId: string, input: DecisionEvaluationInput, signal?: AbortSignal, onDispatch?: () => void): Promise<DecisionAnswerReport> {
  return evaluateDecisionRequest(userId, input, evaluateProviderDecisionAnswers, signal, onDispatch);
}

async function evaluateDecisionRequest<T>(userId: string, input: DecisionEvaluationInput,
  evaluate: (profile: Parameters<typeof evaluateProviderDecision>[0], apiKey: string, input: DecisionEvaluationInput, signal: AbortSignal, onDispatch?: () => void) => Promise<T>,
  signal?: AbortSignal, onDispatch?: () => void): Promise<T> {
  validateDecisionInput(input);
  signal?.throwIfAborted();
  const profile = input.connection_id ? connections.getConnection(userId, input.connection_id) : connections.getDefaultConnection(userId);
  if (!profile) throw new DecisionConnectionNotFoundError(input.connection_id ? "Decision connection not found" : "No default Decision connection configured");
  const apiKey = await secrets.getSecret(userId, connections.decisionConnectionSecretKey(profile.id));
  if (!apiKey) throw new Error(`No readable API key for Decision connection "${profile.name}"`);
  const timeout = AbortSignal.timeout(30_000);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const resolved = await resolveImageAssets(userId, input, effectiveSignal);
    effectiveSignal.throwIfAborted();
    return await evaluate(profile, apiKey, resolved, effectiveSignal, onDispatch);
  } catch (error) {
    if (signal?.aborted) throw new Error("AbortError: Decision evaluation cancelled");
    if (timeout.aborted) throw new DecisionTimeoutError("Decision evaluation timed out after 30 seconds");
    if (error instanceof DecisionValidationError) throw new DecisionValidationError(redactDecisionError(error, apiKey));
    if (error instanceof ProviderRequestError) throw new ProviderRequestError({ provider: error.provider, operation: error.operation, status: error.status, code: error.code, detail: String(redactDecisionError(error.detail || error.message, apiKey)), retryable: error.retryable, retryAfterMs: error.retryAfterMs });
    throw new Error(redactDecisionError(error, apiKey));
  }
}

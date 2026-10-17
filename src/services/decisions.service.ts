import type { DecisionEvaluationInput, DecisionImageAsset, DecisionQuestion, DecisionResult } from "../decision/contract";
import { validateDecisionInput, DecisionValidationError, DECISION_IMAGE_MAX_BYTES } from "../decision/validation";
import { ProviderRequestError } from "../utils/provider-errors";
import { evaluateProviderDecision, redactDecisionError } from "../decision/providers";
import * as connections from "./decision-connections.service";
import * as secrets from "./secrets.service";
import * as images from "./images.service";

export class DecisionConnectionNotFoundError extends Error {}
export class DecisionTimeoutError extends Error {}
/** Replace `image_id` assets with the stored PNG/JPEG bytes, then re-check the image size cap. */
async function resolveImageAssets<I extends DecisionEvaluationInput>(userId: string, input: I): Promise<I> {
  if (!input.assets || !Object.values(input.assets).some((asset) => "image_id" in asset)) return input;
  const assets: Record<string, DecisionImageAsset> = {};
  for (const [ref, asset] of Object.entries(input.assets)) {
    if (!("image_id" in asset)) { assets[ref] = asset; continue; }
    const path = await images.getImageFilePath(userId, asset.image_id);
    if (!path) throw new DecisionValidationError(`Image ${asset.image_id} not found`);
    const file = Bun.file(path);
    if (file.size > DECISION_IMAGE_MAX_BYTES) throw new DecisionValidationError(`Image ${asset.image_id} exceeds ${DECISION_IMAGE_MAX_BYTES / (1024 * 1024)} MiB`);
    const bytes = Buffer.from(await file.arrayBuffer());
    const format = bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === "PNG" ? "png" : bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : null;
    if (!format) throw new DecisionValidationError(`Image ${asset.image_id} must be a PNG or JPEG`);
    assets[ref] = { type: "image", format, data_base64: bytes.toString("base64") };
  }
  const resolved = { ...input, assets };
  validateDecisionInput(resolved);
  return resolved;
}
export async function evaluateDecision<const Q extends Record<string, DecisionQuestion>>(userId: string, input: DecisionEvaluationInput<Q>, signal?: AbortSignal): Promise<DecisionResult<Q>> {
  validateDecisionInput(input);
  signal?.throwIfAborted();
  const profile = input.connection_id ? connections.getConnection(userId, input.connection_id) : connections.getDefaultConnection(userId);
  if (!profile) throw new DecisionConnectionNotFoundError(input.connection_id ? "Decision connection not found" : "No default Decision connection configured");
  const apiKey = await secrets.getSecret(userId, connections.decisionConnectionSecretKey(profile.id));
  if (!apiKey) throw new Error(`No readable API key for Decision connection "${profile.name}"`);
  const timeout = AbortSignal.timeout(30_000);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await evaluateProviderDecision(profile, apiKey, await resolveImageAssets(userId, input), effectiveSignal) as DecisionResult<Q>;
  } catch (error) {
    if (signal?.aborted) throw new Error("AbortError: Decision evaluation cancelled");
    if (timeout.aborted) throw new DecisionTimeoutError("Decision evaluation timed out after 30 seconds");
    if (error instanceof DecisionValidationError) throw new DecisionValidationError(redactDecisionError(error, apiKey));
    if (error instanceof ProviderRequestError) throw new ProviderRequestError({ provider: error.provider, operation: error.operation, status: error.status, detail: String(redactDecisionError(error.detail || error.message, apiKey)), retryable: error.retryable, retryAfterMs: error.retryAfterMs });
    throw new Error(redactDecisionError(error, apiKey));
  }
}

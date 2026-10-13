import type { DecisionEvaluationInput, DecisionQuestion, DecisionResult } from "../decision/contract";
import { validateDecisionInput, DecisionValidationError } from "../decision/validation";
import { ProviderRequestError } from "../utils/provider-errors";
import { evaluateProviderDecision, redactDecisionError } from "../decision/providers";
import * as connections from "./decision-connections.service";
import * as secrets from "./secrets.service";

export class DecisionConnectionNotFoundError extends Error {}
export class DecisionTimeoutError extends Error {}
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
    return await evaluateProviderDecision(profile, apiKey, input, effectiveSignal) as DecisionResult<Q>;
  } catch (error) {
    if (signal?.aborted) throw new Error("AbortError: Decision evaluation cancelled");
    if (timeout.aborted) throw new DecisionTimeoutError("Decision evaluation timed out after 30 seconds");
    if (error instanceof DecisionValidationError) throw new DecisionValidationError(redactDecisionError(error, apiKey));
    if (error instanceof ProviderRequestError) throw new ProviderRequestError({ provider: error.provider, operation: error.operation, status: error.status, detail: String(redactDecisionError(error.detail || error.message, apiKey)), retryable: error.retryable, retryAfterMs: error.retryAfterMs });
    throw new Error(redactDecisionError(error, apiKey));
  }
}

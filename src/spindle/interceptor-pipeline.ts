import { isDeepStrictEqual } from "node:util";
import type {
  DeferredGuidanceDTO,
  LlmMessageDTO,
} from "lumiverse-spindle-types";
import { DEFAULT_INTERCEPTOR_TIMEOUT_MS } from "../services/spindle-settings.service";
import { emitSpindlePreGenerationActivity } from "./pre-generation-activity";
import type {
  InterceptorPipelineAuthority,
  InterceptorTerminalLease,
} from "./lifecycle";
import {
  FINAL_RESPONSE_CARRIER_FIELD,
  materializeInterceptorFinalResponseCarrier,
  refreshInterceptorFinalResponseCarrier,
  retainInterceptorFinalResponse,
  supersedeInterceptorFinalResponse,
  type InterceptorFinalResponseState,
  type ValidInterceptorFinalResponse,
} from "./interceptor-final-response";
export interface InterceptorBreakdownEntry {
  messageIndex: number;
  name: string;
  role: LlmMessageDTO["role"];
  content: string;
  extensionId: string;
  extensionName: string;
}

export interface InterceptorResult {
  messages: LlmMessageDTO[];
  parameters?: Record<string, unknown>;
  breakdown?: InterceptorBreakdownEntry[];
  deferredGuidance?: DeferredGuidanceDTO[];
  /** Opaque host-private normalized state; raw worker FinalResponseDTO never crosses this boundary. */
  finalResponseState?: InterceptorFinalResponseState;
  /** Host-only leases retained in matched registration order. */
  terminalLeases?: readonly InterceptorTerminalLease[];
}

export interface Interceptor {
  extensionId: string;
  extensionName?: string;
  userId?: string | null;
  priority: number; // lower = runs first
  /** Stable worker-owned registration identity, when supplied. */
  registrationId?: string;
  /** Host-compiled provenance filter. */
  matcher?: (context: unknown, authority?: InterceptorPipelineAuthority) => boolean;
  /**
   * Host-only context preparation seam. It may attach callback state through a
   * WeakMap, but must not add privileged values to the public DTO.
   */
  contextPreparer?: (
    context: unknown,
    signal: AbortSignal | undefined,
    authority?: InterceptorPipelineAuthority,
  ) => unknown;
  /**
   * Called immediately before each invocation to determine the wall-clock
   * budget for this interceptor. Resolving per-run (instead of at
   * registration) lets user-level `spindleSettings.interceptorTimeoutMs`
   * changes propagate live without requiring extensions to re-register.
   * Falls back to `DEFAULT_INTERCEPTOR_TIMEOUT_MS` if omitted.
   */
  resolveTimeoutMs?: () => number;
  handler: (
    messages: LlmMessageDTO[],
    context: unknown
  ) => Promise<InterceptorResult | LlmMessageDTO[]>;
}

function getChatId(context: unknown): string | null {
  if (!context || typeof context !== "object") return null;
  const chatId = (context as { chatId?: unknown }).chatId;
  return typeof chatId === "string" && chatId ? chatId : null;
}

type MessageWithFinalResponseCarrier = LlmMessageDTO & Record<string, unknown>;

const FINAL_RESPONSE_RECONCILIATION_WARNING =
  "[Spindle] Interceptor final-response carrier reconciliation failed; preserving prior state";

function carrierMessages(messages: readonly LlmMessageDTO[]): LlmMessageDTO[] {
  return messages.filter((message) => {
    const nonce = (message as MessageWithFinalResponseCarrier)[FINAL_RESPONSE_CARRIER_FIELD];
    return typeof nonce === "string" && nonce.length > 0;
  });
}

function stripCarrierMetadata(message: LlmMessageDTO): Record<string, unknown> {
  const copy = structuredClone(message) as MessageWithFinalResponseCarrier;
  delete copy.cache_control;
  delete copy[FINAL_RESPONSE_CARRIER_FIELD];
  return copy;
}

function hasExactCarrier(
  message: LlmMessageDTO | undefined,
  response: ValidInterceptorFinalResponse,
): boolean {
  if (!message) return false;
  const nonce = (message as MessageWithFinalResponseCarrier)[FINAL_RESPONSE_CARRIER_FIELD];
  return nonce === response.carrierNonce
    && isDeepStrictEqual(stripCarrierMetadata(message), stripCarrierMetadata(response.fallbackMessage));
}

function assertPriorCarrier(
  messages: readonly LlmMessageDTO[],
  response: ValidInterceptorFinalResponse,
  replacementNonce?: string,
): void {
  const carriers = carrierMessages(messages);
  const prior = carriers.filter(
    (message) =>
      (message as MessageWithFinalResponseCarrier)[FINAL_RESPONSE_CARRIER_FIELD]
      === response.carrierNonce,
  );
  if (prior.length !== 1 || !hasExactCarrier(prior[0], response)) {
    throw new Error("Final response fallback carrier is missing, modified, or ambiguous");
  }
  if (replacementNonce === undefined) {
    if (carriers.length !== 1) {
      throw new Error("Final response fallback carrier is missing, modified, or ambiguous");
    }
    return;
  }
  const replacements = carriers.filter(
    (message) =>
      (message as MessageWithFinalResponseCarrier)[FINAL_RESPONSE_CARRIER_FIELD]
      === replacementNonce,
  );
  if (replacementNonce === response.carrierNonce || replacements.length !== 1 || carriers.length !== 2) {
    throw new Error("Replacement final response fallback carrier is missing or ambiguous");
  }
}

function assertSingleCarrier(
  messages: readonly LlmMessageDTO[],
  response: ValidInterceptorFinalResponse,
): void {
  const carriers = carrierMessages(messages);
  if (carriers.length !== 1 || !hasExactCarrier(carriers[0], response)) {
    throw new Error("Final response fallback carrier is missing, modified, or ambiguous");
  }
}

function sameFallbackAttribution(
  entry: InterceptorBreakdownEntry,
  fallback: ValidInterceptorFinalResponse["fallbackBreakdown"],
): boolean {
  return entry.name === fallback.name
    && entry.role === fallback.role
    && entry.content === fallback.content
    && entry.extensionId === fallback.extensionId
    && entry.extensionName === fallback.extensionName;
}

function restoreFallbackBreakdown(
  breakdown: readonly InterceptorBreakdownEntry[],
  previous: ValidInterceptorFinalResponse,
  refreshed: ValidInterceptorFinalResponse,
): InterceptorBreakdownEntry[] {
  const previousIndex = breakdown.findIndex((entry) =>
    sameFallbackAttribution(entry, previous.fallbackBreakdown),
  );
  const retained = breakdown.filter(
    (entry) => !sameFallbackAttribution(entry, previous.fallbackBreakdown),
  );
  const insertionIndex = previousIndex < 0
    ? retained.length
    : Math.min(previousIndex, retained.length);
  retained.splice(insertionIndex, 0, { ...refreshed.fallbackBreakdown });
  return retained;
}

function assertFallbackBreakdown(
  breakdown: readonly InterceptorBreakdownEntry[],
  response: ValidInterceptorFinalResponse,
): void {
  const matches = breakdown.filter((entry) =>
    entry.messageIndex === response.fallbackMessageIndex
    && sameFallbackAttribution(entry, response.fallbackBreakdown),
  );
  if (matches.length !== 1) {
    throw new Error("Final response fallback breakdown is missing or ambiguous");
  }
}

class InterceptorPipeline {
  private interceptors: Interceptor[] = [];

  register(interceptor: Interceptor): () => void {
    this.interceptors.push(interceptor);
    this.interceptors.sort((a, b) => a.priority - b.priority);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const index = this.interceptors.indexOf(interceptor);
      if (index >= 0) this.interceptors.splice(index, 1);
    };
  }

  unregisterByExtension(extensionId: string): void {
    this.interceptors = this.interceptors.filter(
      (interceptor) => interceptor.extensionId !== extensionId,
    );
  }

  async run(
    messages: LlmMessageDTO[],
    context: unknown,
    userId?: string | null,
    signal?: AbortSignal,
    authority?: InterceptorPipelineAuthority,
  ): Promise<InterceptorResult> {
    let result = messages;
    const terminalLeases: InterceptorTerminalLease[] = [];
    let mergedParameters: Record<string, unknown> | undefined;
    let mergedBreakdown: InterceptorBreakdownEntry[] = [];
    const mergedDeferredGuidance: DeferredGuidanceDTO[] = [];
    let finalResponseState: InterceptorFinalResponseState | undefined;
    const chatId = getChatId(context);

    for (const interceptor of this.interceptors) {
      if (interceptor.userId && interceptor.userId !== userId) {
        continue;
      }
      if (interceptor.matcher) {
        let matched = false;
        try {
          matched = interceptor.matcher(context, authority);
        } catch (error) {
          console.warn(
            `[Spindle] Interceptor matcher threw for ${interceptor.extensionId}:`,
            error,
          );
        }
        if (!matched) continue;
      }
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      let timeoutMs = DEFAULT_INTERCEPTOR_TIMEOUT_MS;
      if (interceptor.resolveTimeoutMs) {
        try {
          const resolved = interceptor.resolveTimeoutMs();
          if (Number.isFinite(resolved) && resolved > 0) timeoutMs = resolved;
        } catch (err) {
          console.warn(
            `[Spindle] Interceptor timeout resolver threw for ${interceptor.extensionId}:`,
            err
          );
        }
      }
      emitSpindlePreGenerationActivity({
        chatId,
        userId,
        phase: "interceptor",
        status: "started",
        extensionId: interceptor.extensionId,
        extensionName: interceptor.extensionName,
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      const timeoutResult = Promise.withResolvers<never>();
      try {
        const callbackContext = interceptor.contextPreparer
          ? interceptor.contextPreparer(context, signal, authority)
          : context;
        timeout = setTimeout(
          () =>
            timeoutResult.reject(
              new Error(
                `Interceptor from ${interceptor.extensionId} timed out (${Math.round(timeoutMs / 1000)}s)`,
              ),
            ),
          timeoutMs,
        );
        if (signal) {
          abortHandler = () =>
            timeoutResult.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          signal.addEventListener("abort", abortHandler, { once: true });
        }
        const output = await Promise.race([
          Promise.resolve(interceptor.handler(result, callbackContext)),
          timeoutResult.promise,
        ]);
        const normalized: InterceptorResult = Array.isArray(output)
          ? { messages: output }
          : output;
        const candidateFinalResponseState = normalized.finalResponseState;
        const outputBreakdown = normalized.breakdown ?? [];
        const priorFinalResponseState = finalResponseState;
        const priorValidResponse =
          priorFinalResponseState?.status === "valid" ? priorFinalResponseState : undefined;
        let foldedMessages = normalized.messages;
        let foldedBreakdown: InterceptorBreakdownEntry[] = [
          ...mergedBreakdown,
          ...outputBreakdown,
        ];
        let foldedFinalResponseState = priorFinalResponseState;
        let acceptOutput = true;

        let callbackMessages = normalized.messages;

        try {
          if (priorValidResponse) {
            callbackMessages = materializeInterceptorFinalResponseCarrier(
              normalized.messages,
              priorValidResponse,
            );
            if (candidateFinalResponseState?.status === "valid") {
              assertPriorCarrier(
                callbackMessages,
                priorValidResponse,
                candidateFinalResponseState.carrierNonce,
              );
              const superseded = supersedeInterceptorFinalResponse({
                previous: priorValidResponse,
                next: candidateFinalResponseState,
                messages: callbackMessages,
                acceptedBreakdown: mergedBreakdown,
                outputBreakdown,
              });
              assertSingleCarrier(superseded.messages, superseded.finalResponse);
              foldedMessages = superseded.messages;
              foldedBreakdown = [
                ...superseded.acceptedBreakdown,
                ...superseded.outputBreakdown,
              ];
              assertFallbackBreakdown(foldedBreakdown, superseded.finalResponse);
              foldedFinalResponseState = superseded.finalResponse;
            } else {
              assertPriorCarrier(callbackMessages, priorValidResponse);
              const refreshed = refreshInterceptorFinalResponseCarrier(
                priorValidResponse,
                callbackMessages,
                [...mergedBreakdown, ...outputBreakdown],
              );
              assertSingleCarrier(refreshed.messages, refreshed.finalResponse);
              foldedMessages = refreshed.messages;
              foldedBreakdown = restoreFallbackBreakdown(
                refreshed.breakdown,
                priorValidResponse,
                refreshed.finalResponse,
              );
              assertFallbackBreakdown(foldedBreakdown, refreshed.finalResponse);
              foldedFinalResponseState = refreshed.finalResponse;
            }
          } else if (candidateFinalResponseState?.status === "valid") {
            assertSingleCarrier(normalized.messages, candidateFinalResponseState);
            foldedFinalResponseState = retainInterceptorFinalResponse(
              undefined,
              candidateFinalResponseState,
            );
            assertFallbackBreakdown(foldedBreakdown, candidateFinalResponseState);
          } else if (candidateFinalResponseState !== undefined) {
            foldedFinalResponseState = retainInterceptorFinalResponse(
              undefined,
              candidateFinalResponseState,
            );
          }
        } catch {
          acceptOutput = false;
          console.warn(FINAL_RESPONSE_RECONCILIATION_WARNING);
          for (const lease of normalized.terminalLeases ?? []) {
            try {
              lease.release();
            } catch {
              // The lease may already have been revoked during callback cleanup.
            }
          }
        }

        if (acceptOutput) {
          result = foldedMessages;
          mergedBreakdown = foldedBreakdown;
          finalResponseState = foldedFinalResponseState;
          if (normalized.terminalLeases && normalized.terminalLeases.length > 0) {
            terminalLeases.push(...normalized.terminalLeases);
          }
          if (normalized.parameters && Object.keys(normalized.parameters).length > 0) {
            mergedParameters = { ...mergedParameters, ...normalized.parameters };
          }
          if (normalized.deferredGuidance && normalized.deferredGuidance.length > 0) {
            mergedDeferredGuidance.push(...normalized.deferredGuidance);
          }
        }
        emitSpindlePreGenerationActivity({
          chatId,
          userId,
          phase: "interceptor",
          status: "completed",
          extensionId: interceptor.extensionId,
          extensionName: interceptor.extensionName,
        });
      } catch (err) {
        if (signal?.aborted) {
          emitSpindlePreGenerationActivity({
            chatId,
            userId,
            phase: "interceptor",
            status: "aborted",
            extensionId: interceptor.extensionId,
            extensionName: interceptor.extensionName,
          });
          throw err;
        }
        emitSpindlePreGenerationActivity({
          chatId,
          userId,
          phase: "interceptor",
          status: "error",
          extensionId: interceptor.extensionId,
          extensionName: interceptor.extensionName,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(
          `[Spindle] Interceptor error from ${interceptor.extensionId}:`,
          err
        );
        // Continue with previous result on error
      } finally {
        clearTimeout(timeout);
        if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
      }
    }

    return {
      messages: result,
      parameters: mergedParameters,
      ...(mergedBreakdown.length > 0 ? { breakdown: mergedBreakdown } : {}),
      ...(mergedDeferredGuidance.length > 0 ? { deferredGuidance: mergedDeferredGuidance } : {}),
      ...(finalResponseState === undefined ? {} : { finalResponseState }),
      ...(terminalLeases.length > 0 ? { terminalLeases: Object.freeze([...terminalLeases]) } : {}),
    };
  }

  get count(): number {
    return this.interceptors.length;
  }
}

export const interceptorPipeline = new InterceptorPipeline();

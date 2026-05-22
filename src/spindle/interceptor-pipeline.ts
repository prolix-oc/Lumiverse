import type { LlmMessageDTO } from "lumiverse-spindle-types";
import { DEFAULT_INTERCEPTOR_TIMEOUT_MS } from "../services/spindle-settings.service";
import { emitSpindlePreGenerationActivity } from "./pre-generation-activity";

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
}

export interface Interceptor {
  extensionId: string;
  extensionName?: string;
  userId?: string | null;
  priority: number; // lower = runs first
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
  ) => Promise<InterceptorResult>;
}

function getChatId(context: unknown): string | null {
  if (!context || typeof context !== "object") return null;
  const chatId = (context as { chatId?: unknown }).chatId;
  return typeof chatId === "string" && chatId ? chatId : null;
}

class InterceptorPipeline {
  private interceptors: Interceptor[] = [];

  register(interceptor: Interceptor): () => void {
    this.interceptors.push(interceptor);
    this.interceptors.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = this.interceptors.indexOf(interceptor);
      if (idx !== -1) this.interceptors.splice(idx, 1);
    };
  }

  unregisterByExtension(extensionId: string): void {
    this.interceptors = this.interceptors.filter(
      (i) => i.extensionId !== extensionId
    );
  }

  async run(
    messages: LlmMessageDTO[],
    context: unknown,
    userId?: string | null,
    signal?: AbortSignal,
  ): Promise<InterceptorResult> {
    let result = messages;
    let mergedParameters: Record<string, unknown> | undefined;
    const mergedBreakdown: InterceptorBreakdownEntry[] = [];
    const chatId = getChatId(context);

    for (const interceptor of this.interceptors) {
      if (interceptor.userId && interceptor.userId !== userId) {
        continue;
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
      try {
        const output = await Promise.race([
          interceptor.handler(result, context),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    `Interceptor from ${interceptor.extensionId} timed out (${Math.round(timeoutMs / 1000)}s)`
                  )
                ),
              timeoutMs,
            );
            if (signal) {
              abortHandler = () =>
                reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
              signal.addEventListener("abort", abortHandler, { once: true });
            }
          }),
        ]);
        result = output.messages;
        emitSpindlePreGenerationActivity({
          chatId,
          userId,
          phase: "interceptor",
          status: "completed",
          extensionId: interceptor.extensionId,
          extensionName: interceptor.extensionName,
        });
        if (output.parameters && Object.keys(output.parameters).length > 0) {
          mergedParameters = { ...mergedParameters, ...output.parameters };
        }
        if (output.breakdown && output.breakdown.length > 0) {
          mergedBreakdown.push(...output.breakdown);
        }
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
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
      }
    }

    return {
      messages: result,
      parameters: mergedParameters,
      ...(mergedBreakdown.length > 0 ? { breakdown: mergedBreakdown } : {}),
    };
  }

  get count(): number {
    return this.interceptors.length;
  }
}

export const interceptorPipeline = new InterceptorPipeline();

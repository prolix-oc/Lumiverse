import { emitSpindlePreGenerationActivity } from "./pre-generation-activity";

export interface ContextHandler {
  extensionId: string;
  extensionName?: string;
  userId?: string | null;
  priority: number; // lower = runs first
  handler: (context: unknown) => Promise<unknown>;
}

function getChatId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const chatId = (value as { chatId?: unknown }).chatId;
  return typeof chatId === "string" && chatId ? chatId : null;
}

class ContextHandlerChain {
  private handlers: ContextHandler[] = [];

  register(handler: ContextHandler): () => void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => a.priority - b.priority);

    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx !== -1) this.handlers.splice(idx, 1);
    };
  }

  unregisterByExtension(extensionId: string): void {
    this.handlers = this.handlers.filter(
      (h) => h.extensionId !== extensionId
    );
  }

  async run(
    context: unknown,
    userId?: string | null,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let result = context;

    for (const handler of this.handlers) {
      if (handler.userId && handler.userId !== userId) {
        continue;
      }
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      const chatId = getChatId(result);
      emitSpindlePreGenerationActivity({
        chatId,
        userId,
        phase: "context_handler",
        status: "started",
        extensionId: handler.extensionId,
        extensionName: handler.extensionName,
      });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      try {
        result = await Promise.race([
          handler.handler(result),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    `Context handler from ${handler.extensionId} timed out (10s)`
                  )
                ),
              10_000,
            );
            if (signal) {
              abortHandler = () =>
                reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
              signal.addEventListener("abort", abortHandler, { once: true });
            }
          }),
        ]);
        emitSpindlePreGenerationActivity({
          chatId,
          userId,
          phase: "context_handler",
          status: "completed",
          extensionId: handler.extensionId,
          extensionName: handler.extensionName,
        });
      } catch (err) {
        if (signal?.aborted) {
          emitSpindlePreGenerationActivity({
            chatId,
            userId,
            phase: "context_handler",
            status: "aborted",
            extensionId: handler.extensionId,
            extensionName: handler.extensionName,
          });
          throw err;
        }
        emitSpindlePreGenerationActivity({
          chatId,
          userId,
          phase: "context_handler",
          status: "error",
          extensionId: handler.extensionId,
          extensionName: handler.extensionName,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(
          `[Spindle] Context handler error from ${handler.extensionId}:`,
          err
        );
      } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && abortHandler) {
          signal.removeEventListener("abort", abortHandler);
        }
      }
    }

    return result;
  }

  get count(): number {
    return this.handlers.length;
  }
}

export const contextHandlerChain = new ContextHandlerChain();

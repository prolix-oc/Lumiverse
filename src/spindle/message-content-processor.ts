import { emitSpindlePreGenerationActivity } from "./pre-generation-activity";

export type MessageContentProcessorOrigin =
  | "create"
  | "update"
  | "swipe_add"
  | "swipe_update"
  | "render";

export interface MessageContentProcessorCtx {
  chatId: string;
  messageId?: string;
  content: string;
  extra?: Record<string, unknown>;
  origin: MessageContentProcessorOrigin;
  swipeIndex?: number;
  userId: string;
}

export interface MessageContentProcessorResult {
  content?: string;
  extra?: Record<string, unknown>;
}

export interface MessageContentProcessor {
  extensionId: string;
  extensionName?: string;
  userId?: string | null;
  priority: number;
  handler: (
    ctx: MessageContentProcessorCtx
  ) => Promise<MessageContentProcessorResult | void>;
}

const MESSAGE_CONTENT_PROCESSOR_TIMEOUT_MS = 10_000;

class MessageContentProcessorChain {
  private handlers: MessageContentProcessor[] = [];

  register(handler: MessageContentProcessor): () => void {
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
    ctx: MessageContentProcessorCtx,
    userId?: string | null,
    signal?: AbortSignal,
  ): Promise<MessageContentProcessorCtx> {
    let result = ctx;

    for (const handler of this.handlers) {
      if (handler.userId && handler.userId !== userId) {
        continue;
      }
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }

      emitSpindlePreGenerationActivity({
        chatId: result.chatId,
        userId,
        phase: "message_content_processor",
        status: "started",
        extensionId: handler.extensionId,
        extensionName: handler.extensionName,
      });

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      try {
        const patch = await Promise.race([
          handler.handler(result),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    `Message content processor from ${handler.extensionId} timed out (${Math.round(MESSAGE_CONTENT_PROCESSOR_TIMEOUT_MS / 1000)}s)`
                  )
                ),
              MESSAGE_CONTENT_PROCESSOR_TIMEOUT_MS,
            );
            if (signal) {
              abortHandler = () =>
                reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
              signal.addEventListener("abort", abortHandler, { once: true });
            }
          }),
        ]);
        if (patch) {
          const nextExtra =
            patch.extra !== undefined
              ? { ...(result.extra ?? {}), ...patch.extra }
              : result.extra;
          result = {
            ...result,
            ...(patch.content !== undefined ? { content: patch.content } : {}),
            ...(nextExtra !== result.extra ? { extra: nextExtra } : {}),
          };
        }
        emitSpindlePreGenerationActivity({
          chatId: result.chatId,
          userId,
          phase: "message_content_processor",
          status: "completed",
          extensionId: handler.extensionId,
          extensionName: handler.extensionName,
        });
      } catch (err) {
        if (signal?.aborted) {
          emitSpindlePreGenerationActivity({
            chatId: result.chatId,
            userId,
            phase: "message_content_processor",
            status: "aborted",
            extensionId: handler.extensionId,
            extensionName: handler.extensionName,
          });
          throw err;
        }
        emitSpindlePreGenerationActivity({
          chatId: result.chatId,
          userId,
          phase: "message_content_processor",
          status: "error",
          extensionId: handler.extensionId,
          extensionName: handler.extensionName,
          error: err instanceof Error ? err.message : String(err),
        });
        console.error(
          `[Spindle] Message content processor error from ${handler.extensionId}:`,
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

export const messageContentProcessorChain = new MessageContentProcessorChain();

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
  userId?: string | null;
  priority: number;
  handler: (
    ctx: MessageContentProcessorCtx
  ) => Promise<MessageContentProcessorResult | void>;
}

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
    userId?: string | null
  ): Promise<MessageContentProcessorCtx> {
    let result = ctx;

    for (const handler of this.handlers) {
      if (handler.userId && handler.userId !== userId) {
        continue;
      }
      try {
        const patch = await Promise.race([
          handler.handler(result),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Message content processor from ${handler.extensionId} timed out (10s)`
                  )
                ),
              10_000
            )
          ),
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
      } catch (err) {
        console.error(
          `[Spindle] Message content processor error from ${handler.extensionId}:`,
          err
        );
      }
    }

    return result;
  }

  get count(): number {
    return this.handlers.length;
  }
}

export const messageContentProcessorChain = new MessageContentProcessorChain();

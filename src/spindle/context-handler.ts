export interface ContextHandler {
  extensionId: string;
  userId?: string | null;
  priority: number; // lower = runs first
  handler: (context: unknown) => Promise<unknown>;
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

  async run(context: unknown, userId?: string | null): Promise<unknown> {
    let result = context;

    for (const handler of this.handlers) {
      if (handler.userId && handler.userId !== userId) {
        continue;
      }
      try {
        result = await Promise.race([
          handler.handler(result),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Context handler from ${handler.extensionId} timed out (10s)`
                  )
                ),
              10_000
            )
          ),
        ]);
      } catch (err) {
        console.error(
          `[Spindle] Context handler error from ${handler.extensionId}:`,
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

export const contextHandlerChain = new ContextHandlerChain();

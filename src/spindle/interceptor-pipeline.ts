import type { LlmMessageDTO } from "lumiverse-spindle-types";

export interface Interceptor {
  extensionId: string;
  userId?: string | null;
  priority: number; // lower = runs first
  handler: (
    messages: LlmMessageDTO[],
    context: unknown
  ) => Promise<LlmMessageDTO[]>;
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
    userId?: string | null
  ): Promise<LlmMessageDTO[]> {
    let result = messages;

    for (const interceptor of this.interceptors) {
      if (interceptor.userId && interceptor.userId !== userId) {
        continue;
      }
      try {
        result = await Promise.race([
          interceptor.handler(result, context),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Interceptor from ${interceptor.extensionId} timed out (10s)`
                  )
                ),
              10_000
            )
          ),
        ]);
      } catch (err) {
        console.error(
          `[Spindle] Interceptor error from ${interceptor.extensionId}:`,
          err
        );
        // Continue with previous result on error
      }
    }

    return result;
  }

  get count(): number {
    return this.interceptors.length;
  }
}

export const interceptorPipeline = new InterceptorPipeline();

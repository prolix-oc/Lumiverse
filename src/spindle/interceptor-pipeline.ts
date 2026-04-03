import type { LlmMessageDTO } from "lumiverse-spindle-types";

export interface InterceptorResult {
  messages: LlmMessageDTO[];
  parameters?: Record<string, unknown>;
}

export interface Interceptor {
  extensionId: string;
  userId?: string | null;
  priority: number; // lower = runs first
  handler: (
    messages: LlmMessageDTO[],
    context: unknown
  ) => Promise<InterceptorResult>;
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
  ): Promise<InterceptorResult> {
    let result = messages;
    let mergedParameters: Record<string, unknown> | undefined;

    for (const interceptor of this.interceptors) {
      if (interceptor.userId && interceptor.userId !== userId) {
        continue;
      }
      try {
        const output = await Promise.race([
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
        result = output.messages;
        if (output.parameters && Object.keys(output.parameters).length > 0) {
          mergedParameters = { ...mergedParameters, ...output.parameters };
        }
      } catch (err) {
        console.error(
          `[Spindle] Interceptor error from ${interceptor.extensionId}:`,
          err
        );
        // Continue with previous result on error
      }
    }

    return { messages: result, parameters: mergedParameters };
  }

  get count(): number {
    return this.interceptors.length;
  }
}

export const interceptorPipeline = new InterceptorPipeline();

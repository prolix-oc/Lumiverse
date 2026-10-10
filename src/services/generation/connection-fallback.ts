import type { StreamChunk } from '../../llm/types';

/** Retry once before any provider output; never combine replies or repeat tools. */
export async function* withConnectionFallback(
  primary: AsyncGenerator<StreamChunk, void, unknown>,
  fallback: () => Promise<AsyncGenerator<StreamChunk, void, unknown> | null>,
  signal: AbortSignal,
): AsyncGenerator<StreamChunk, void, unknown> {
  let receivedOutput = false;
  try {
    for await (const chunk of primary) {
      if (chunk.token || chunk.reasoning || chunk.tool_calls?.length
        || chunk.thinking_blocks?.length || chunk.reasoning_details?.length
        || chunk.thought_signature || chunk.finish_reason) receivedOutput = true;
      yield chunk;
    }
  } catch (err) {
    if (receivedOutput || signal.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
    const next = await fallback();
    if (!next) throw err;
    signal.throwIfAborted();
    yield* next;
  }
}

import { PROVIDER_RESPONSE_MAX_BODY_BYTES, type ProviderResponseObserver, type ProviderResponseSnapshot } from "./request-observer";

/** Diagnostics follow the consumer's reads. Never clone/tee a live response or
 * read ahead: doing so can retain an unbounded stream and interfere with Stop. */
export function observeProviderResponse(response: Response, observer: ProviderResponseObserver | void, signal?: AbortSignal): Response {
  if (!observer) return response;
  try {
    if (!observer.isActive()) return response;
    observer.headers(response.status);
  } catch { return response; }

  // Grow one bounded buffer instead of retaining one allocation per network
  // chunk (a stream of tiny chunks must not bypass the byte limit).
  let buffer: Buffer | null = null;
  let bodyBytes = 0;
  let finished = false;
  let abandoned = false;
  const active = () => {
    if (abandoned) return false;
    try { if (observer.isActive()) return true; } catch { /* Stop capturing. */ }
    abandoned = true;
    buffer = null;
    return false;
  };
  const finish = (outcome: ProviderResponseSnapshot["outcome"], error?: unknown) => {
    if (finished) return;
    finished = true;
    try {
      if (!active()) return;
      const tooLarge = bodyBytes > PROVIDER_RESPONSE_MAX_BODY_BYTES;
      observer.complete({
        body: tooLarge ? null : buffer?.toString("utf8", 0, bodyBytes) ?? "", bodyBytes, outcome,
        ...(tooLarge ? { bodyUnavailable: "too_large" as const } : {}),
        ...(error instanceof Error ? { error: error.message } : {}),
      });
    } catch { /* Never let diagnostics change the provider result. */ }
    finally { buffer = null; }
  };
  if (!response.body) {
    finish("complete");
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) {
          finish("complete");
          controller.close();
          reader.releaseLock();
        } else {
          bodyBytes += value.byteLength;
          if (active() && bodyBytes <= PROVIDER_RESPONSE_MAX_BODY_BYTES) {
            if (!buffer || buffer.length < bodyBytes) {
              const capacity = Math.min(PROVIDER_RESPONSE_MAX_BODY_BYTES, Math.max(64 * 1024, bodyBytes, (buffer?.length ?? 0) * 2));
              const next = Buffer.alloc(capacity);
              buffer?.copy(next, 0, 0, bodyBytes - value.byteLength);
              buffer = next;
            }
            buffer.set(value, bodyBytes - value.byteLength);
          } else buffer = null;
          controller.enqueue(value);
        }
      } catch (error) {
        if (!finished) {
          finish(signal?.aborted ? "cancelled" : "failed", error);
          controller.error(error);
          reader.releaseLock();
        }
      }
    },
    async cancel(reason) {
      finish(signal?.aborted ? "cancelled" : "interrupted", reason);
      // Await cancellation before the existing connection-close path runs.
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  const observed = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ["url", "redirected", "type"] as const) {
    Object.defineProperty(observed, key, { value: response[key] });
  }
  return observed;
}

export function observeProviderFailure(observer: ProviderResponseObserver | void, error: unknown, signal?: AbortSignal): void {
  try {
    if (observer?.isActive()) observer.complete({
      body: null, bodyBytes: 0, outcome: signal?.aborted ? "cancelled" : "failed",
      ...(error instanceof Error ? { error: error.message } : {}),
    });
  } catch { /* No raw fallback. */ }
}

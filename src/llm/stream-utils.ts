// Workaround for Bun v1.3.x on Windows: passing the user AbortSignal directly
// to a streaming fetch and letting Bun cancel the resulting ReadableStream
// mid-read can trigger an internal assertion failure on the main thread,
// crashing the process. Streaming providers therefore use a short-lived fetch
// signal only until response headers arrive, then handle mid-stream aborts in
// user-space through readWithAbort() and reader.cancel().
export async function fetchWithPreflightAbort(
  input: RequestInfo | URL,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (!signal) return fetch(input, init);
  if (signal.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const controller = new AbortController();
  const onAbort = () => {
    controller.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
  };

  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function readWithAbort<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal: AbortSignal | undefined
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>> {
  if (!signal) return reader.read();
  if (signal.aborted) return { done: true, value: undefined };
  return new Promise<Awaited<ReturnType<ReadableStreamDefaultReader<T>["read"]>>>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve({ done: true, value: undefined });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (err) => {
        cleanup();
        if (signal.aborted) {
          resolve({ done: true, value: undefined });
        } else {
          reject(err);
        }
      }
    );
  });
}

// Streaming providers can emit a large number of tiny reasoning/text deltas in a
// tight loop. Periodically yielding a macrotask keeps Bun's HTTP/WS queue moving
// so stop requests and health checks do not starve behind an active stream.
export async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export function createCooperativeYielder(every: number, signal?: AbortSignal): () => Promise<void> {
  let count = 0;
  const interval = Math.max(1, Math.floor(every));
  return async () => {
    count++;
    if (count % interval !== 0) return;
    await yieldToEventLoop(signal);
  };
}

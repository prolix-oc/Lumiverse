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

// Hard ceiling on a buffered JSON response. Without this, a misconfigured or
// hostile endpoint (a user-supplied embedding server, or a proxy returning a
// huge chunked error page with no/false Content-Length) could grow the buffer
// unbounded and OOM the single-process server. The cap is generous enough for
// any realistic JSON API response; callers handling smaller payloads can pass
// a tighter limit.
const DEFAULT_MAX_JSON_BYTES = 64 * 1024 * 1024; // 64 MB

// Read a non-streaming JSON response body via the same user-space abort path
// the streaming providers use. The user signal is checked between reads instead
// of being handed to Bun's fetch, and reader.cancel() is awaited so the
// underlying HTTP connection is fully torn down before the response object
// becomes eligible for GC — closing the window where Bun's HTTPThread can
// dispatch a callback into freed memory. A byte cap bounds peak memory and
// cancels the stream the instant it trips.
export async function readJsonWithAbort<T>(
  res: Response,
  signal: AbortSignal | undefined,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
  if (!res.body) {
    return (await res.json()) as T;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new Error(`Response body exceeded ${maxBytes} bytes`);
        }
        buffer += decoder.decode(value, { stream: true });
      }
    }
    buffer += decoder.decode();
    return JSON.parse(buffer) as T;
  } finally {
    await reader.cancel().catch(() => {});
  }
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

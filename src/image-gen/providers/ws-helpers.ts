// Without this, WS error events stringify as "[object ErrorEvent]".
export function formatWsError(e: unknown): string {
  const anyE = e as { message?: unknown; error?: any; code?: unknown; reason?: unknown; type?: unknown }
  if (typeof anyE?.message === "string" && anyE.message) return anyE.message
  if (anyE?.error) {
    if (typeof anyE.error === "string") return anyE.error
    if (typeof anyE.error.message === "string" && anyE.error.message) return anyE.error.message
    if (typeof anyE.error.code === "string" && anyE.error.code) return anyE.error.code
  }
  if (typeof anyE?.reason === "string" && anyE.reason) return anyE.reason
  if (typeof anyE?.code === "string" && anyE.code) return anyE.code
  if (typeof anyE?.code === "number") return `close code ${anyE.code}`
  if (typeof anyE?.type === "string" && anyE.type && anyE.type !== "error") return anyE.type
  return "connection failed (likely refused / DNS / non-WS endpoint)"
}

// Opens a WS with a timeout; cleans up listeners on settle so we don't keep
// the event loop alive or leak handlers after resolution. `headers` uses
// Bun's WebSocket constructor extension (WHATWG WebSocket can't set headers).
export async function openWebSocket(
  url: string,
  opts: {
    label: string;
    timeoutMs?: number;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<WebSocket> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const abortError = (): DOMException => new DOMException("Aborted", "AbortError");
  if (opts.signal?.aborted) throw abortError();

  let ws: WebSocket;
  try {
    ws = opts.headers
      ? new WebSocket(url, { headers: opts.headers } as any)
      : new WebSocket(url);
  } catch (error) {
    if (opts.signal?.aborted) throw abortError();
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const closeSocket = (): void => {
      try {
        ws.close();
      } catch {
        // The socket may already be closed.
      }
    };
    const onOpen = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (event: Event): void => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket();
      reject(new Error(`${opts.label} WebSocket error: ${formatWsError(event)} (url=${url})`));
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${opts.label} WebSocket closed before opening (url=${url})`));
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket();
      reject(abortError());
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket();
      reject(new Error(`${opts.label} WebSocket connection timeout after ${timeoutMs}ms (url=${url})`));
    }, timeoutMs);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
  });
  return ws;
}

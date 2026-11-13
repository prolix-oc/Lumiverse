import { cancelStreamAndCloseConnection, readWithAbort, yieldToEventLoop } from "./stream-utils";
import { parseProviderErrorBody, ProviderRequestError } from "../utils/provider-errors";

export function incompleteStream(provider: string): ProviderRequestError {
  return new ProviderRequestError({
    provider, operation: "stream", code: "incomplete_stream", retryable: true,
    detail: "The provider connection closed before a terminal response was received.",
  });
}

export function throwIfProviderError(data: any, provider: string, operation: string): void {
  if (!data?.error && data?.type !== "error") return;
  const parsed = parseProviderErrorBody(JSON.stringify(data));
  const rawStatus = data.error?.code;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  throw new ProviderRequestError({
    provider, operation, ...parsed, status,
    ...(parsed.code && ["server_error", "api_error", "overloaded_error", "rate_limit_exceeded", "INTERNAL", "UNAVAILABLE", "RESOURCE_EXHAUSTED"].includes(parsed.code)
      ? { retryable: true } : {}),
  });
}

/** Read JSON SSE frames, including CRLF, comments and fragmented data lines.
 * Callers validate their own API's terminal event/reason after this ends. */
export async function* readProviderSse(
  res: Response, provider: string, signal?: AbortSignal,
): AsyncGenerator<any> {
  if (!res.body) throw incompleteStream(provider);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let naturalEnd = false;
  let lineCount = 0;
  const invalidEvent = () => new ProviderRequestError({
    provider, operation: "stream", code: "invalid_stream_event", retryable: true,
    detail: "The provider sent an invalid JSON stream event.",
  });
  try {
    while (true) {
      const { done, value } = await readWithAbort(reader, signal);
      if (signal?.aborted) return;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      // Compatibility with endpoints that close without a trailing blank line.
      if (done) { naturalEnd = true; lines.push(buffer, ""); buffer = ""; }
      for (const rawLine of lines) {
        if (++lineCount % 64 === 0) await yieldToEventLoop();
        if (signal?.aborted) return;
        const line = rawLine.replace(/\r$/, "");
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
          const payload = dataLines.join("\n");
          if (payload.trim() === "[DONE]") return;
          let data: any;
          try { data = JSON.parse(payload); }
          catch { continue; } // A valid JSON value may span multiple data lines.
          if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidEvent();
          dataLines = [];
          // Also support compatible proxies that omit blank frame separators.
          yield data;
        }
        if (line === "" && dataLines.length) throw invalidEvent();
      }
      if (done) return;
    }
  } finally {
    if (!naturalEnd) await cancelStreamAndCloseConnection(reader, res);
    else reader.releaseLock();
  }
}

export interface ParsedProviderErrorBody {
  code?: string;
  detail?: string;
}

export interface ProviderRequestErrorOptions {
  provider: string;
  operation: string;
  status?: number;
  code?: string;
  detail?: string;
  rawBody?: string;
  retryable?: boolean;
  /** Parsed Retry-After hint (ms) the caller may honor before retrying. */
  retryAfterMs?: number;
}

/**
 * Parse an HTTP Retry-After header into milliseconds. Supports the
 * delta-seconds form (the common case for 429/503 from LLM providers); the
 * HTTP-date form is ignored (returns undefined) as it is rare for these APIs.
 */
export function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const secs = Number(value.trim());
  if (Number.isFinite(secs) && secs >= 0) return Math.floor(secs * 1000);
  return undefined;
}

export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly status?: number;
  readonly code?: string;
  readonly detail?: string;
  readonly rawBody?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(options: ProviderRequestErrorOptions) {
    const status = options.status ? ` (${options.status})` : "";
    const detail = options.detail || options.code || "request failed";
    super(`${options.provider} ${options.operation} failed${status}: ${detail}`);
    this.name = "ProviderRequestError";
    this.provider = options.provider;
    this.operation = options.operation;
    this.status = options.status;
    this.code = options.code;
    this.detail = options.detail;
    this.rawBody = options.rawBody;
    this.retryable = options.retryable ?? isRetryableProviderStatus(options.status);
    this.retryAfterMs = options.retryAfterMs;
  }
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message.trim();
  if (typeof err === "string" && err.trim()) return err.trim();
  return "";
}

function getErrorCauseMessage(err: unknown): string {
  if (!(err instanceof Error)) return "";
  const cause = (err as Error & { cause?: unknown }).cause;
  return getErrorMessage(cause);
}

export function describeTransportError(err: unknown, fallback = "Provider request failed"): string {
  const message = getErrorMessage(err);
  const causeMessage = getErrorCauseMessage(err);
  const combined = [message, causeMessage].filter(Boolean).join(": ");
  if (!combined) return fallback;

  if (/socket connection was closed unexpectedly/i.test(combined)) {
    return "The provider connection closed before Lumiverse received the full response. This usually means the upstream service, a local proxy, or the network dropped the stream. Retry the request; if it keeps happening, check the selected connection's provider or proxy logs.";
  }

  if (/^fetch failed$/i.test(message) && causeMessage) return causeMessage;

  return message;
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripHtml(raw: string): string {
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Defense-in-depth sanitizer for any error string about to be surfaced to a
 * user (toast, WS event, HTTP response body). Even if a provider somehow
 * propagates a raw HTML/oversize body (legacy code path, third-party
 * extension, etc.), this keeps the message small enough that it can't wedge
 * a toast layout or blow up a WS frame.
 */
const MAX_USER_FACING_ERROR_LENGTH = 1000;
export function clampErrorMessage(message: string | undefined | null): string {
  if (!message) return "";
  const sanitized = /<\w[^>]*>/.test(message)
    ? stripHtml(message)
    : message;
  return sanitized.length > MAX_USER_FACING_ERROR_LENGTH
    ? `${sanitized.slice(0, MAX_USER_FACING_ERROR_LENGTH - 1)}…`
    : sanitized;
}

function truncateDetail(value: string): string {
  return value.length > 500 ? `${value.slice(0, 497)}...` : value;
}

export function parseProviderErrorBody(raw: string): ParsedProviderErrorBody {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as any;
      const error = data?.error;
      const code = error && typeof error === "object"
        ? normalizeText(error.code) || normalizeText(error.status) || normalizeText(error.type)
        : normalizeText(data?.code) || normalizeText(data?.status) || normalizeText(data?.type) || normalizeText(error);
      const detail = error && typeof error === "object"
        ? normalizeText(error.message) || normalizeText(data?.error_description) || normalizeText(data?.message)
        : normalizeText(data?.error_description) || normalizeText(data?.message) || normalizeText(data?.detail) || normalizeText(error);
      return {
        code: code ? truncateDetail(code) : undefined,
        detail: detail ? truncateDetail(detail) : undefined,
      };
    } catch {
      // Fall through to text normalization.
    }
  }

  return { detail: truncateDetail(stripHtml(trimmed) || trimmed) };
}

/**
 * Read at most `maxBytes` of a Response body as text. Discards anything past
 * the cap and cancels the underlying stream so we don't keep slurping huge
 * upstream error pages (Cloudflare 503s, nginx 502s, etc.) into memory.
 *
 * Important: cancels the reader explicitly to release the HTTP connection —
 * relying on GC alone leaves the socket pinned, which has previously surfaced
 * as Bun HTTPThread misbehaviour on large/slow error responses.
 */
export async function readBoundedText(res: Response, maxBytes = 16 * 1024): Promise<string> {
  if (!res.body) {
    try {
      const text = await res.text();
      return text.length > maxBytes ? `${text.slice(0, maxBytes)}…[truncated]` : text;
    } catch {
      return "";
    }
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let total = 0;
  let truncated = false;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        const overshoot = total - maxBytes;
        const keep = value.byteLength - overshoot;
        buffer += decoder.decode(value.subarray(0, Math.max(0, keep)), { stream: false });
        truncated = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
    }
    if (!truncated) buffer += decoder.decode();
  } catch {
    // Swallow — we only need a best-effort error body. The caller still has
    // res.status / res.statusText for context.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return truncated ? `${buffer}…[truncated]` : buffer;
}

export function isRetryableProviderStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

export async function throwProviderResponseError(provider: string, operation: string, res: Response): Promise<never> {
  const rawBody = await readBoundedText(res);
  const parsed = parseProviderErrorBody(rawBody);
  throw new ProviderRequestError({
    provider,
    operation,
    status: res.status,
    code: parsed.code || res.statusText || undefined,
    detail: parsed.detail || res.statusText || undefined,
    rawBody,
    retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
  });
}

export async function fetchProviderJson<T>(provider: string, operation: string, input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    throw new ProviderRequestError({
      provider,
      operation,
      detail: getErrorMessage(err) || "network request failed",
      retryable: true,
    });
  }

  if (!res.ok) await throwProviderResponseError(provider, operation, res);
  return await res.json() as T;
}

function cleanProviderMessage(message: string): string {
  const payloadMatch = message.match(/^(.*?\(\d+\):)\s*(\{.*\})$/s);
  if (payloadMatch) {
    const parsed = parseProviderErrorBody(payloadMatch[2]);
    if (parsed.detail) return `${payloadMatch[1]} ${parsed.detail}`;
  }

  return message;
}

export function describeProviderError(err: unknown, fallback = "Provider request failed"): string {
  if (err instanceof ProviderRequestError) {
    if (err.provider === "Vertex AI" && /token exchange|authentication/i.test(err.operation)) {
      const detail = err.detail || err.code || "token exchange failed";
      if (/account not found/i.test(detail)) {
        return "Vertex AI authentication failed: the service account was not found. Select a different connection or update this connection with a current service-account JSON key.";
      }
      if (/invalid_grant/i.test(detail) || err.code === "invalid_grant") {
        return `Vertex AI authentication failed: ${detail}. Check that the service account still exists and the saved key is current.`;
      }
      return `Vertex AI authentication failed: ${detail}`;
    }

    const status = err.status ? ` (${err.status})` : "";
    const detail = err.detail || err.code || fallback;
    return `${err.provider} ${err.operation} failed${status}: ${detail}`;
  }

  const message = describeTransportError(err, fallback);
  if (!message) return fallback;

  const cleaned = cleanProviderMessage(message);
  if (/^Vertex AI token exchange failed/i.test(cleaned)) {
    const detail = cleaned.replace(/^Vertex AI token exchange failed \(\d+\):\s*/i, "").trim();
    if (/account not found/i.test(detail)) {
      return "Vertex AI authentication failed: the service account was not found. Select a different connection or update this connection with a current service-account JSON key.";
    }
    if (/invalid_grant/i.test(detail)) {
      return `Vertex AI authentication failed: ${detail}. Check that the service account still exists and the saved key is current.`;
    }
    return `Vertex AI authentication failed: ${detail || "token exchange failed"}`;
  }

  return cleaned;
}

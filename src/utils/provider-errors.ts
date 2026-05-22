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
}

export class ProviderRequestError extends Error {
  readonly provider: string;
  readonly operation: string;
  readonly status?: number;
  readonly code?: string;
  readonly detail?: string;
  readonly rawBody?: string;
  readonly retryable: boolean;

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
      if (error && typeof error === "object") {
        return {
          code: normalizeText(error.code) || normalizeText(error.status) || normalizeText(error.type),
          detail: normalizeText(error.message) || normalizeText(data?.error_description) || normalizeText(data?.message),
        };
      }
      return {
        code: normalizeText(data?.code) || normalizeText(data?.status) || normalizeText(data?.type) || normalizeText(error),
        detail: normalizeText(data?.error_description) || normalizeText(data?.message) || normalizeText(data?.detail) || normalizeText(error),
      };
    } catch {
      // Fall through to text normalization.
    }
  }

  return { detail: truncateDetail(stripHtml(trimmed) || trimmed) };
}

export function isRetryableProviderStatus(status: number | undefined): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500);
}

export async function throwProviderResponseError(provider: string, operation: string, res: Response): Promise<never> {
  const rawBody = await res.text().catch(() => "");
  const parsed = parseProviderErrorBody(rawBody);
  throw new ProviderRequestError({
    provider,
    operation,
    status: res.status,
    code: parsed.code || res.statusText || undefined,
    detail: parsed.detail || res.statusText || undefined,
    rawBody,
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

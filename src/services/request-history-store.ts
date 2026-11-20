import type { ProviderRequestSnapshot, ProviderResponseSnapshot, RequestOrigin } from "../llm/request-observer";
import { redactRequestValue } from "../utils/redact-request";
import { redactResponseBody } from "../utils/redact-response";
import { omitCaptureMedia } from "../utils/omit-capture-media";

export const REQUEST_HISTORY_SETTING = "requestHistoryEnabled";
export const REQUEST_HISTORY_LIMIT = 20;
// Multimodal prompts can contain many megabytes of base64. Keep the row, but
// explicitly mark oversized bodies unavailable instead of truncating JSON.
export const REQUEST_HISTORY_MAX_BODY_BYTES = 8 * 1024 * 1024;
// Capture uploads already contain bounded media. Allow sanitization before the
// history size check, so a large video cannot hide its small textual prompt.
export const REQUEST_HISTORY_MAX_CAPTURE_SNAPSHOT_BYTES = 256 * 1024 * 1024;

export interface RequestHistoryContext {
  origin: RequestOrigin;
  chatId?: string;
  generationId?: string;
  connectionId?: string;
}

export interface RequestHistorySummary extends RequestHistoryContext {
  id: string;
  sentAt: number;
  provider: string;
  model: string;
  bodyBytes: number;
  redacted: boolean;
  bodyUnavailable?: "too_large" | "unavailable";
  response: {
    state: "pending" | "receiving" | ProviderResponseSnapshot["outcome"];
    status?: number;
    completedAt?: number;
    bodyBytes: number;
    format?: "json" | "text";
    redacted: boolean;
    partial?: boolean;
    bodyUnavailable?: "too_large" | "unavailable";
  };
}

export interface RequestHistoryEntry extends RequestHistorySummary {
  bodyJson: string | null;
  responseBody: string | null;
  responseError: string | null;
}

/** Only sanitized snapshots enter this store. No timers, database rows, or raw request references. */
export class RequestHistoryStore {
  private readonly entries = new Map<string, RequestHistoryEntry[]>();

  record(userId: string, context: RequestHistoryContext, snapshot: ProviderRequestSnapshot): string | undefined {
    if (!userId) return;
    const metadata = {
      origin: {
        kind: context.origin.kind,
        name: context.origin.name,
        operation: context.origin.operation,
        extensionId: context.origin.extensionId,
        ...(context.origin.sensitiveMedia ? { sensitiveMedia: true } : {}),
      },
      chatId: context.chatId,
      generationId: context.generationId,
      connectionId: context.connectionId,
      provider: snapshot.provider,
      model: snapshot.model,
    };
    let safeContext = redactRequestValue(metadata, snapshot.credentials) as typeof metadata;
    const bodyBytes = typeof snapshot.body === "string" ? Buffer.byteLength(snapshot.body) : 0;
    let bodyJson: string | null = null;
    let bodyUnavailable: RequestHistorySummary["bodyUnavailable"];
    let redacted = false;
    if (bodyBytes > (context.origin.sensitiveMedia ? REQUEST_HISTORY_MAX_CAPTURE_SNAPSHOT_BYTES : REQUEST_HISTORY_MAX_BODY_BYTES)) {
      bodyUnavailable = "too_large";
    } else {
      try {
        if (typeof snapshot.body !== "string") throw new Error("Non-JSON body");
        const body: unknown = JSON.parse(snapshot.body);
        const sanitized = context.origin.sensitiveMedia ? omitCaptureMedia(body) : body;
        const envelope = redactRequestValue({ metadata, body: sanitized }, snapshot.credentials) as { metadata: typeof metadata; body: unknown };
        safeContext = envelope.metadata;
        const safe = envelope.body;
        bodyJson = JSON.stringify(safe, null, 2);
        redacted = !!context.origin.sensitiveMedia || JSON.stringify(safe) !== JSON.stringify(body);
        if (Buffer.byteLength(bodyJson) > REQUEST_HISTORY_MAX_BODY_BYTES) {
          bodyJson = null;
          bodyUnavailable = "too_large";
        }
      } catch {
        // Never store an error message or fall back to the original body.
        bodyJson = null;
        bodyUnavailable = "unavailable";
      }
    }
    const entry: RequestHistoryEntry = {
      ...safeContext, id: crypto.randomUUID(), sentAt: Date.now(), bodyBytes,
      redacted, ...(bodyUnavailable ? { bodyUnavailable } : {}), bodyJson,
      response: { state: "pending", bodyBytes: 0, redacted: false }, responseBody: null, responseError: null,
    };
    const rows = this.entries.get(userId) ?? [];
    rows.unshift(entry);
    rows.length = Math.min(rows.length, REQUEST_HISTORY_LIMIT);
    this.entries.set(userId, rows);
    return entry.id;
  }

  has(userId: string, id: string): boolean {
    return this.entries.get(userId)?.some((row) => row.id === id) ?? false;
  }

  responseHeaders(userId: string, id: string, status: number): void {
    const entry = this.entries.get(userId)?.find((row) => row.id === id);
    if (entry) entry.response = { ...entry.response, state: "receiving", status };
  }

  completeResponse(userId: string, id: string, snapshot: ProviderResponseSnapshot, credentials: readonly string[]): void {
    const entry = this.entries.get(userId)?.find((row) => row.id === id);
    // Late responses cannot resurrect cleared/disabled/evicted records.
    if (!entry) return;
    const response: RequestHistorySummary["response"] = {
      ...entry.response, state: snapshot.outcome, completedAt: Date.now(),
      bodyBytes: snapshot.bodyBytes, bodyUnavailable: snapshot.bodyUnavailable,
      partial: snapshot.outcome !== "complete",
    };
    let responseBody: string | null = null;
    let responseError: string | null = null;
    try {
      if (snapshot.error && !entry.origin.sensitiveMedia) responseError = (redactRequestValue(snapshot.error, credentials) as string).slice(0, 2000);
    } catch { /* Never display an unsanitized transport error. */ }
    try {
      if (entry.origin.sensitiveMedia && (snapshot.outcome === "failed" || (response.status ?? 0) >= 400)) {
        // Failed providers can echo opaque request fragments in arbitrary text.
        response.bodyUnavailable = "unavailable";
        response.redacted = true;
      } else if (snapshot.body !== null && !snapshot.bodyUnavailable) {
        if (Buffer.byteLength(snapshot.body) > REQUEST_HISTORY_MAX_BODY_BYTES) {
          response.bodyUnavailable = "too_large";
        } else {
          const safe = redactResponseBody(snapshot.body, credentials, entry.origin.sensitiveMedia ? omitCaptureMedia : undefined);
          response.format = safe.format;
          response.redacted = safe.redacted;
          if (safe.terminal && snapshot.outcome === "interrupted") response.partial = false;
          if (safe.partial) {
            response.partial = true;
            if (response.state === "complete") response.state = "interrupted";
          }
          if (safe.failed) response.state = "failed";
          else if (snapshot.outcome === "interrupted" && safe.terminal) response.state = "complete";
          if (safe.failed && entry.origin.sensitiveMedia) {
            // A provider can report an error inside a successful HTTP response.
            response.bodyUnavailable = "unavailable";
            response.redacted = true;
          } else if (Buffer.byteLength(safe.text) > REQUEST_HISTORY_MAX_BODY_BYTES) response.bodyUnavailable = "too_large";
          else responseBody = safe.text;
        }
      }
    } catch {
      response.bodyUnavailable = "unavailable";
      responseBody = null;
    }
    if (response.status && response.status >= 400) response.state = "failed";
    entry.response = response;
    entry.responseBody = responseBody;
    entry.responseError = responseError;
  }

  list(userId: string): RequestHistorySummary[] {
    return (this.entries.get(userId) ?? []).map(({ bodyJson: _body, responseBody: _response, responseError: _error, ...summary }) => structuredClone(summary));
  }

  get(userId: string, id: string): RequestHistoryEntry | null {
    const entry = this.entries.get(userId)?.find((row) => row.id === id);
    return entry ? structuredClone(entry) : null;
  }

  clear(userId: string): void {
    this.entries.delete(userId);
  }
}

export const requestHistoryStore = new RequestHistoryStore();

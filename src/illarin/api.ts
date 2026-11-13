/**
 * Thin HTTP client for the Illarin connected-app protocol (v1).
 *
 * Request and response shapes follow the Illarin app-integration guide.
 *
 * Security posture:
 * - Illarin URLs are user-supplied; safeFetch applies the standard SSRF
 *   policy (public HTTPS hosts only).
 * - Responses are consumed once and never cached; the protocol requires
 *   Cache-Control: no-store on secret-bearing responses and this client
 *   keeps no HTTP cache of its own.
 * - No token, code, verifier, device code, or authorization URL is ever
 *   written into an error message or log line. Error text carries only the
 *   endpoint path and status.
 */

import { safeFetch } from "../utils/safe-fetch";
import {
  ILLARIN_SCOPES,
  type BrowserAuthorizationRequest,
  type BrowserAuthorizationResponse,
  type DeclarationUpdate,
  type DeliveryWorkList,
  type DevicePollResult,
  type DeviceRequestResponse,
  type IllarinDelivery,
  type IllarinDeclaration,
  type LibrarySyncRequest,
  type LibrarySyncResponse,
  type TokenPair,
  type TakedownNotice,
} from "./types";

export const DEFAULT_ILLARIN_BASE_URL = "https://illarin.com";
const DELIVERY_COLLECT_TIMEOUT_MS = 40_000;

export class IllarinApiError extends Error {
  readonly status: number;
  readonly endpoint: string;

  constructor(status: number, endpoint: string, message?: string) {
    super(message ?? `Illarin ${endpoint} failed with ${status}`);
    this.name = "IllarinApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** Terminal 401 — stop all work for the installation and offer to relink. */
export class IllarinUnauthorizedError extends IllarinApiError {}

export class IllarinRateLimitError extends IllarinApiError {
  readonly retryAfterSeconds: number | null;

  constructor(endpoint: string, retryAfterSeconds: number | null) {
    super(429, endpoint, `Illarin ${endpoint} rate limited`);
    this.name = "IllarinRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A saturated Illarin collector. Retry-After is authoritative when present. */
export class IllarinUnavailableError extends IllarinApiError {
  readonly retryAfterSeconds: number | null;

  constructor(endpoint: string, retryAfterSeconds: number | null) {
    super(503, endpoint, `Illarin ${endpoint} temporarily unavailable`);
    this.name = "IllarinUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type IllarinFetch = typeof safeFetch;

export interface IllarinRequestOptions {
  /** Injectable for tests; defaults to the SSRF-guarded safeFetch. */
  fetchImpl?: IllarinFetch;
}

interface RequestJsonOptions extends IllarinRequestOptions {
  accessToken?: string;
  timeoutMs?: number;
}

function normalizeBaseUrl(url: string, allowTestHttp = false): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Illarin URL is not a valid absolute URL");
  }
  if (parsed.protocol !== "https:" && !(allowTestHttp && parsed.protocol === "http:")) {
    throw new Error("Illarin URL must use https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Illarin URL must not contain credentials, a query, or a fragment");
  }
  return trimmed;
}

interface JsonResponse<T> {
  status: number;
  data: T | null;
}
async function requestJson<T>(
  baseUrl: string,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
  options?: RequestJsonOptions,
): Promise<JsonResponse<T>> {
  const doFetch = options?.fetchImpl ?? safeFetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options?.accessToken) {
    // Bearer in the authorization header, never a query parameter.
    headers.Authorization = `Bearer ${options.accessToken}`;
  }

  let response: Response;
  try {
    response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
  } catch {
    // Network failure. For state-changing calls the outcome is unknown;
    // callers preserve durable local state and apply their normal backoff.
    throw new IllarinApiError(0, path, `Illarin ${path} failed: network error`);
  }

  if (response.status === 401) {
    throw new IllarinUnauthorizedError(401, path);
  }
  if (response.status === 429) {
    throw new IllarinRateLimitError(path, parseRetryAfter(response.headers.get("Retry-After")));
  }
  if (response.status === 503) {
    throw new IllarinUnavailableError(path, parseRetryAfter(response.headers.get("Retry-After")));
  }
  if (!response.ok) {
    // Server-provided detail is intentionally discarded: response bodies are
    // untrusted input and must never flow into our logs via error messages.
    throw new IllarinApiError(response.status, path);
  }
  const data = await response.json().catch(() => null) as T | null;
  return { status: response.status, data };
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number.parseInt(header.trim(), 10);
  const until = Date.parse(header);
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : null;
}

function assertTokenPair(data: unknown, endpoint: string): TokenPair {
  const pair = data as Partial<TokenPair> | null;
  if (
    !pair ||
    typeof pair.accessToken !== "string" ||
    typeof pair.accessTokenExpiresAt !== "string" ||
    typeof pair.refreshToken !== "string" ||
    typeof pair.connectedApp?.id !== "string" ||
    !Array.isArray(pair.connectedApp.permissions) ||
    !pair.connectedApp.permissions.every((permission) => ILLARIN_SCOPES.includes(permission))
  ) {
    throw new IllarinApiError(200, endpoint, `Illarin ${endpoint} returned a malformed token payload`);
  }
  return pair as TokenPair;
}

/** Start the same-device browser authorization. */
export async function createBrowserAuthorization(
  baseUrl: string,
  request: BrowserAuthorizationRequest,
  options?: IllarinRequestOptions,
): Promise<BrowserAuthorizationResponse> {
  const path = "/api/v1/connect/authorizations";
  const base = normalizeBaseUrl(baseUrl, Boolean(options?.fetchImpl));
  const { data } = await requestJson<BrowserAuthorizationResponse>(base, "POST", path, request, options);
  if (!data || typeof data.authorizationUrl !== "string" || typeof data.userCode !== "string" || typeof data.expiresAt !== "string") {
    throw new IllarinApiError(200, path, "Illarin returned a malformed authorization response");
  }
  return data;
}

/** Exchange the one-use callback code. Never retry a successful exchange. */
export async function exchangeAuthorizationCode(
  baseUrl: string,
  body: { authorizationCode: string; codeVerifier: string; redirectUri: string },
  options?: IllarinRequestOptions,
): Promise<TokenPair> {
  const path = "/api/v1/connect/token";
  const base = normalizeBaseUrl(baseUrl, Boolean(options?.fetchImpl));
  const { data } = await requestJson<unknown>(base, "POST", path, body, options);
  return assertTokenPair(data, path);
}

export async function createDeviceRequest(
  baseUrl: string,
  declaration: IllarinDeclaration,
  options?: IllarinRequestOptions,
): Promise<DeviceRequestResponse> {
  const path = "/api/v1/connect/requests";
  const base = normalizeBaseUrl(baseUrl, Boolean(options?.fetchImpl));
  const { data } = await requestJson<DeviceRequestResponse>(base, "POST", path, declaration, options);
  if (
    !data ||
    typeof data.deviceCode !== "string" ||
    typeof data.userCode !== "string" ||
    typeof data.verificationUrl !== "string" ||
    typeof data.expiresAt !== "string" ||
    typeof data.interval !== "number"
  ) {
    throw new IllarinApiError(200, path, "Illarin returned a malformed device request response");
  }
  return data;
}

/**
 * One finite poll of the device request state machine. Ordinary request per
 * call — never hold open, never WebSocket. Map the protocol's table:
 * 200 pending | 200 linked | 400 access_denied/expired_token | 404 | 429.
 */
export async function pollDeviceRequest(
  baseUrl: string,
  deviceCode: string,
  options?: IllarinRequestOptions,
): Promise<DevicePollResult> {
  const base = normalizeBaseUrl(baseUrl, Boolean(options?.fetchImpl));
  const doFetch = options?.fetchImpl ?? safeFetch;
  const path = "/api/v1/connect/poll";
  const endpoint = `${base}${path}`;

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
  } catch {
    // Outcome unknown — caller backs off exponentially without polling
    // before the current interval.
    throw new IllarinApiError(0, path, `Illarin ${path} failed: network error`);
  }

  const retryAfterSeconds = parseRetryAfter(response.headers.get("Retry-After"));

  if (response.status === 200) {
    const data = await response.json().catch(() => null) as ({ status?: string } & Partial<TokenPair>) | null;
    if (data?.status === "connected") {
      // The status discriminator is transport framing, not part of the pair.
      const { status: _status, ...payload } = data;
      return { kind: "linked", tokens: assertTokenPair(payload, path) };
    }
    if (data?.status === "pending") return { kind: "pending" };
    throw new IllarinApiError(200, path, "Illarin returned an unknown connection status");
  }
  if (response.status === 400) {
    const code = await errorBodyCode(response);
    if (code === "access_denied") return { kind: "denied" };
    if (code === "expired_token") return { kind: "expired" };
    throw new IllarinApiError(400, path);
  }
  if (response.status === 404) {
    return { kind: "unknown_code" };
  }
  if (response.status === 429) {
    const code = await errorBodyCode(response);
    // A slow_down raises the persistent polling interval; other 429s are a
    // source-wide rate limit. Both honor Retry-After when present.
    return code === "slow_down"
      ? { kind: "slow_down", retryAfterSeconds }
      : { kind: "rate_limited", retryAfterSeconds };
  }
  throw new IllarinApiError(response.status, path);
}

async function errorBodyCode(response: Response): Promise<string | null> {
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : null;
}

/**
 * Rotate credentials. The caller MUST serialize refreshes per installation
 * and durably persist the returned pair before releasing the new access
 * token — a replayed replaced refresh token revokes the whole instance.
 */
export async function refreshTokens(
  baseUrl: string,
  refreshToken: string,
  options?: IllarinRequestOptions,
): Promise<TokenPair> {
  const path = "/api/v1/connect/refresh";
  const base = normalizeBaseUrl(baseUrl, Boolean(options?.fetchImpl));
  const { data } = await requestJson<unknown>(base, "POST", path, { refreshToken }, options);
  return assertTokenPair(data, path);
}

/**
 * Replace the non-authoritative declaration after an upgrade. Complete
 * replacement; names and granted scopes cannot be sent here.
 */
export async function updateInstanceDeclaration(
  baseUrl: string,
  accessToken: string,
  update: DeclarationUpdate,
  options?: IllarinRequestOptions,
): Promise<void> {
  const base = normalizeBaseUrl(baseUrl, Boolean(options?.fetchImpl));
  await requestJson<unknown>(base, "PUT", "/api/v1/connected-apps/me", update, { ...options, accessToken });
}

/** One durable-queue read. A 204 is a successful empty wait. */
export async function collectDeliveries(
  baseUrl: string,
  accessToken: string,
  acknowledge: readonly string[],
  options?: IllarinRequestOptions,
): Promise<DeliveryWorkList> {
  if (!Array.isArray(acknowledge) || acknowledge.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new RangeError("acknowledge must be an array of non-empty delivery ids");
  }
  const path = "/api/v1/sends/collect";
  const base = normalizeBaseUrl(baseUrl, Boolean(options?.fetchImpl));
  const { status, data } = await requestJson<{ sends?: unknown; takedowns?: unknown }>(
    base,
    "POST",
    path,
    { acknowledge: [...acknowledge] },
    { ...options, accessToken, timeoutMs: DELIVERY_COLLECT_TIMEOUT_MS },
  );
  if (status === 204) return { sends: [], takedowns: [] };
  if (!data || !Array.isArray(data.sends) || !data.sends.every(isDelivery)) {
    throw new IllarinApiError(200, path, `Illarin ${path} returned a malformed send payload`);
  }
  return { sends: data.sends, takedowns: takedownNotices(data.takedowns) };
}

function takedownNotices(value: unknown): TakedownNotice[] {
  if (!Array.isArray(value)) return [];
  return value.filter((notice): notice is TakedownNotice =>
    Boolean(notice) &&
    typeof notice.workId === "string" &&
    typeof notice.name === "string" &&
    typeof notice.takenDownAt === "string"
  );
}

function isDelivery(value: unknown): value is IllarinDelivery {
  if (!value || typeof value !== "object") return false;
  const delivery = value as Partial<IllarinDelivery>;
  return (
    typeof delivery.id === "string" &&
    typeof delivery.workId === "string" &&
    Number.isInteger(delivery.versionNumber) &&
    typeof delivery.type === "string" &&
    typeof delivery.name === "string" &&
    typeof delivery.format === "string" &&
    typeof delivery.label === "string" &&
    typeof delivery.queuedAt === "string" &&
    typeof delivery.leaseExpiresAt === "string" &&
    Array.isArray(delivery.files) &&
    delivery.files.every((artifact) =>
      Boolean(artifact) &&
      typeof artifact === "object" &&
      typeof artifact.type === "string" &&
      typeof artifact.url === "string"
    )
  );
}

/** Fetch a short-lived signed artifact URL without forwarding Illarin credentials. */
export async function fetchDeliveryArtifact(
  artifactUrl: string,
  options?: IllarinRequestOptions & { maxBytes?: number },
): Promise<Response> {
  const doFetch = options?.fetchImpl ?? safeFetch;
  let response: Response;
  try {
    response = await doFetch(artifactUrl, {
      method: "GET",
      ...(options?.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    });
  } catch {
    throw new IllarinApiError(0, "delivery artifact", "Illarin delivery artifact fetch failed: network error");
  }
  if (!response.ok) throw new IllarinApiError(response.status, "delivery artifact");
  return response;
}

/** Send an incremental update or a complete replacement of the library mirror. */
export async function syncLibrary(
  baseUrl: string,
  accessToken: string,
  report: LibrarySyncRequest,
  options?: IllarinRequestOptions,
): Promise<LibrarySyncResponse> {
  assertLibrarySyncRequest(report);
  const path = "/api/v1/library/sync";
  const base = normalizeBaseUrl(baseUrl, Boolean(options?.fetchImpl));
  const { data } = await requestJson<Omit<LibrarySyncResponse, "takedowns"> & { takedowns?: unknown }>(
    base,
    "POST",
    path,
    report,
    { ...options, accessToken },
  );
  if (
    !data ||
    !Number.isInteger(data.accepted) ||
    !Number.isInteger(data.removed) ||
    !Number.isInteger(data.ignored)
  ) {
    throw new IllarinApiError(200, path, `Illarin ${path} returned a malformed sync response`);
  }
  return { ...data, takedowns: takedownNotices(data.takedowns) };
}

function assertLibrarySyncRequest(report: LibrarySyncRequest): void {
  if (!report || typeof report.snapshot !== "boolean" || !Array.isArray(report.entries) ||
      (report.removed !== undefined && !Array.isArray(report.removed))) {
    throw new RangeError("invalid Illarin library sync report");
  }
  if (report.entries.length > 2_000 || (report.removed?.length ?? 0) > 2_000) {
    throw new RangeError("Illarin library sync reports allow at most 2000 entries and 2000 removals");
  }
  if (report.snapshot && report.removed !== undefined) {
    throw new RangeError("an Illarin library snapshot cannot include removals");
  }
  if (!report.snapshot && !Array.isArray(report.removed)) {
    throw new RangeError("an Illarin incremental report requires removals, even when empty");
  }
  if (report.entries.some((entry) =>
    !entry ||
    typeof entry.workId !== "string" ||
    entry.workId.length === 0 ||
    (entry.versionNumber !== undefined && !Number.isInteger(entry.versionNumber))
  )) {
    throw new RangeError("invalid Illarin library sync entry");
  }
  if (report.removed?.some((workId) => typeof workId !== "string" || workId.length === 0)) {
    throw new RangeError("invalid Illarin library removal");
  }
  if (typeof report.appVersion !== "string" || !report.appVersion.trim() ||
      report.appVersion.length > 64 || /[\u0000-\u001F\u007F-\u009F]/.test(report.appVersion)) {
    throw new RangeError("Illarin library reports require a printable appVersion of at most 64 characters");
  }
  const bodyBytes = new TextEncoder().encode(JSON.stringify(report)).length;
  if (bodyBytes > 256 * 1024) {
    throw new RangeError("Illarin library sync body exceeds 256 KiB");
  }
}

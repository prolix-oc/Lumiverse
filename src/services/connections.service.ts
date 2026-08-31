import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getProvider } from "../llm/registry";
import type { ProviderCapabilities } from "../llm/param-schema";
import { env } from "../env";
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import type {
  ConnectionProfile, CreateConnectionProfileInput, UpdateConnectionProfileInput,
} from "../types/connection-profile";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import { describeProviderError } from "../utils/provider-errors";
import {
  clearImportedConnectionReview,
  importedConnectionReviewCode,
  isImportedConnectionReviewRequired,
  markImportedConnectionForReview,
  sanitizeConnectionMetadata,
} from "./connection-authority";
const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 15_000;
const ZAI_GENERAL_API_URL = "https://api.z.ai/api/paas/v4";
const ZAI_CODING_PLAN_API_URL = "https://api.z.ai/api/coding/paas/v4";
export const MODEL_ROULETTE_PROVIDER = "model_roulette";
/** Legacy settings key retained solely for one-way encrypted migration. */
export const LEGACY_POLLINATIONS_APP_KEY_SETTING = "pollinations_app_key";
export const POLLINATIONS_APP_KEY_SECRET = "pollinations_app_key";

export interface ConnectionRouletteConfig {
  connection_ids: string[];
}
/**
 * The frozen, internal connection identity consumed by runtime admission.
 *
 * This is deliberately not a public/API DTO: `credentialSecretRef` and
 * `fingerprint` are only for server-side revision and trust-domain checks.
 * No credential value is ever loaded while resolving this descriptor.
 */
export interface FrozenConcreteConnectionV1 {
  readonly logicalId: string;
  readonly concreteId: string;
  readonly label: string;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  /** Alias consumed by runtime decision normalization; same frozen value. */
  readonly effectiveEndpoint: string;
  readonly endpointRevision: string;
  readonly credentialSecretRef: string;
  readonly credentialRevision: string;
  readonly candidateRevision: string;
  readonly fingerprint: string;
  readonly capabilities: Readonly<ProviderCapabilities>;
}

/** Stable name used by runtime services for the frozen descriptor. */
export type ResolvedConcreteConnectionV1 = FrozenConcreteConnectionV1;

function resolveZaiApiUrl(rawUrl: string, useCodingPlanEndpoint: boolean): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return useCodingPlanEndpoint ? ZAI_CODING_PLAN_API_URL : ZAI_GENERAL_API_URL;

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (pathname === "/v1" || pathname === "/api/paas/v4" || pathname === "/api/coding/paas/v4") {
      url.pathname = useCodingPlanEndpoint ? "/api/coding/paas/v4" : "/api/paas/v4";
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // Preserve custom raw URLs we can't safely normalize.
  }

  return trimmed;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  provider: string;
  durationMs: number;
  timedOut: boolean;
  error: string | null;
}

export interface NanoGptUsageWindow {
  used: number;
  remaining: number;
  percentUsed: number;
  resetAt: number | null;
  limit: number | null;
}

export interface NanoGptSubscriptionUsage {
  active: boolean;
  allowOverage: boolean;
  // Typed usage windows mirroring NanoGPT's subscription payload. Each may be
  // null when the plan doesn't meter that dimension.
  dailyInputTokens: NanoGptUsageWindow | null;
  weeklyInputTokens: NanoGptUsageWindow | null;
  dailyImages: NanoGptUsageWindow | null;
  period: {
    currentPeriodEnd: string | null;
  };
  state: string | null;
  graceUntil: string | null;
}

/**
 * Parse a single Nano-GPT usage window from the raw API payload, folding in its
 * matching `limits.<key>` value. The window object and its limit live under
 * separate keys in NanoGPT's response, so callers pass both.
 */
export function parseNanoGptUsageWindow(w: any, limit: any): NanoGptUsageWindow | null {
  if (!w || typeof w !== "object") return null;
  return {
    used: typeof w.used === "number" ? w.used : 0,
    remaining: typeof w.remaining === "number" ? w.remaining : 0,
    percentUsed: typeof w.percentUsed === "number" ? w.percentUsed : 0,
    resetAt: typeof w.resetAt === "number" ? w.resetAt : null,
    limit: typeof limit === "number" ? limit : null,
  };
}

export interface ConnectionModelsPreviewInput {
  connection_id?: string;
  provider: string;
  api_url?: string;
  metadata?: Record<string, any>;
  api_key?: string;
  output_modalities?: string;
}

function describeConnectionTestError(err: unknown): string {
  return describeProviderError(err, "Connection test failed");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise;

  const TIMEOUT = Symbol("connection-test-timeout");
  let timer: ReturnType<typeof setTimeout> | null = null;
  let result: T | typeof TIMEOUT;
  try {
    result = await Promise.race([
      promise,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (result === TIMEOUT) {
    const seconds = (timeoutMs / 1000).toFixed(timeoutMs % 1000 === 0 ? 0 : 1);
    const error = new Error(`${label} timed out after ${seconds}s`);
    error.name = "TimeoutError";
    throw error;
  }

  return result as T;
}

/** Secret key for a connection's API key. */
export function connectionSecretKey(id: string): string {
  return `connection_${id}_api_key`;
}

/** Resolve the canonical endpoint used by readiness, freezing, and dispatch. */
export function resolveEffectiveApiUrl(profile: { provider: string; api_url?: string | null; metadata?: Record<string, any> | null }): string {
  const url = (profile.api_url || "").trim();
  if (profile.provider === "nanogpt" && profile.metadata?.use_subscription_api) {
    if (!url) return "https://nano-gpt.com/api/subscription/v1";
    return url.replace("/api/v1", "/api/subscription/v1");
  }
  if (profile.provider === "zai") {
    return resolveZaiApiUrl(url, profile.metadata?.use_coding_plan_endpoint === true);
  }
  if (profile.provider === "google_vertex") {
    const region = profile.metadata?.vertex_region;
    // Per Google's @google/genai SDK: `global` routes through the
    // un-prefixed host, regional routes through `{region}-aiplatform`.
    if (!region || region === "global") return "https://aiplatform.googleapis.com";
    return `https://${region}-aiplatform.googleapis.com`;
  }
  if (profile.provider === "bedrock") {
    // An explicit api_url wins so power users can pin a GovCloud or VPC
    // PrivateLink host; otherwise derive from region + endpoint toggle.
    if (url) return url;
    const region = (profile.metadata?.region || "us-east-1").trim() || "us-east-1";
    // mantle (default, recommended) vs runtime (cross-region inference profiles).
    return profile.metadata?.bedrock_endpoint === "runtime"
      ? `https://bedrock-runtime.${region}.amazonaws.com/v1`
      : `https://bedrock-mantle.${region}.api.aws/v1`;
  }
  if (url) return url;
  const provider = getProvider(profile.provider);
  return typeof provider?.defaultUrl === "string" ? provider.defaultUrl.trim() : "";
}

export function resolveNanoGptSubscriptionUsageUrl(profile: { api_url?: string | null }): string {
  const fallback = "https://nano-gpt.com/api/subscription/v1/usage";
  const rawUrl = (profile.api_url || "").trim() || "https://nano-gpt.com/api/v1";

  try {
    const url = new URL(rawUrl);
    url.pathname = "/api/subscription/v1/usage";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return fallback;
  }
}

/**
 * Resolve the Pollinations application key and migrate the legacy plaintext
 * settings value before it can be used. The environment override preserves
 * its existing precedence, but does not prevent a legacy user value from
 * being moved into the encrypted store.
 */
export async function resolvePollinationsAppKey(userId: string): Promise<string> {
  const envKey = env.pollinationsAppKey.trim();
  const stored = await secretsSvc.getSecretForStatus(userId, POLLINATIONS_APP_KEY_SECRET);
  const setting = settingsSvc.getSetting(userId, LEGACY_POLLINATIONS_APP_KEY_SETTING);
  const legacy = typeof setting?.value === "string" ? setting.value.trim() : "";

  if (setting) {
    // Do not overwrite an already configured encrypted value. A successful
    // write precedes deletion so a storage failure cannot discard the key.
    if (legacy && !stored) {
      await secretsSvc.putSecret(userId, POLLINATIONS_APP_KEY_SECRET, legacy);
    }
    settingsSvc.deleteSetting(userId, LEGACY_POLLINATIONS_APP_KEY_SETTING);
  }

  return envKey || stored || legacy;
}

/**
 * One-time, startup-safe migration for plaintext Pollinations keys written by
 * older builds. The encrypted write always finishes before the old setting is
 * removed, so a failed write leaves the legacy value recoverable for retry.
 */
export async function migrateLegacyPollinationsAppKeys(): Promise<number> {
  const rows = getDb()
    .query("SELECT user_id, value FROM settings WHERE key = ?")
    .all(LEGACY_POLLINATIONS_APP_KEY_SETTING) as Array<{ user_id: string; value: string }>;
  let migrated = 0;

  for (const row of rows) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(row.value);
    } catch {
      // Invalid settings JSON cannot contain a usable legacy key, but should
      // still be removed so it does not remain a misleading plaintext entry.
    }
    const legacy = typeof raw === "string" ? raw.trim() : "";
    const stored = await secretsSvc.getSecretForStatus(row.user_id, POLLINATIONS_APP_KEY_SECRET);
    if (legacy && !stored) {
      await secretsSvc.putSecret(row.user_id, POLLINATIONS_APP_KEY_SECRET, legacy);
      migrated++;
    }
    settingsSvc.deleteSetting(row.user_id, LEGACY_POLLINATIONS_APP_KEY_SETTING);
  }

  return migrated;
}

export async function buildPollinationsAuthorizeUrl(
  userId: string,
  input: {
    redirect_url: string;
    models?: string;
    budget?: number;
    expiry?: number;
    permissions?: string;
  }
): Promise<string> {
  const params = new URLSearchParams();
  params.set("redirect_url", input.redirect_url);

  const appKey = await resolvePollinationsAppKey(userId);
  if (appKey) params.set("app_key", appKey);
  if (input.models) params.set("models", input.models);
  if (typeof input.budget === "number" && Number.isFinite(input.budget) && input.budget > 0) {
    params.set("budget", String(Math.floor(input.budget)));
  }
  if (typeof input.expiry === "number" && Number.isFinite(input.expiry) && input.expiry > 0) {
    params.set("expiry", String(Math.floor(input.expiry)));
  }
  if (input.permissions) params.set("permissions", input.permissions);

  return `https://enter.pollinations.ai/authorize?${params.toString()}`;
}

function rowToProfile(row: any): ConnectionProfile {
  const metadata = JSON.parse(row.metadata || "{}") as Record<string, unknown>;
  return {
    ...row,
    preset_id: row.preset_id || null,
    is_default: !!row.is_default,
    has_api_key: !!row.has_api_key,
    review_required: isImportedConnectionReviewRequired(metadata),
    review_code: importedConnectionReviewCode(metadata),
    metadata,
  };
}

export function toPublicConnection(profile: ConnectionProfile): ConnectionProfile {
  return { ...profile, metadata: sanitizeConnectionMetadata(profile.metadata) };
}

export function isConnectionUsable(profile: Pick<ConnectionProfile, "review_required"> | null | undefined): boolean {
  return profile?.review_required !== true;
}

export function isModelRouletteProfile(profile: Pick<ConnectionProfile, "provider"> | null | undefined): boolean {
  return profile?.provider === MODEL_ROULETTE_PROVIDER;
}

export function getConnectionRouletteConfig(
  profile: Pick<ConnectionProfile, "metadata"> | null | undefined
): ConnectionRouletteConfig {
  const raw = profile?.metadata?.connection_roulette;
  if (!raw || typeof raw !== "object") return { connection_ids: [] };

  const seen = new Set<string>();
  const connection_ids = Array.isArray(raw.connection_ids)
    ? raw.connection_ids
      .filter((id: unknown): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id: string) => id.trim())
      .filter((id: string) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
    : [];

  return { connection_ids };
}

// Prepared statements for hot-path queries
let _stmtConnById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtConnDefault: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _connStmtsGen = -1;

function getConnStmts() {
  const db = getDb();
  // Invalidate cached statements when the underlying Database is replaced.
  const gen = require("../db/connection").getDbGeneration() as number;
  if (_connStmtsGen !== gen) {
    _stmtConnById = null;
    _stmtConnDefault = null;
    _connStmtsGen = gen;
  }
  if (!_stmtConnById) _stmtConnById = db.query("SELECT * FROM connection_profiles WHERE id = ? AND user_id = ?");
  if (!_stmtConnDefault) _stmtConnDefault = db.query("SELECT * FROM connection_profiles WHERE is_default = 1 AND user_id = ? LIMIT 1");
  return { byId: _stmtConnById, byDefault: _stmtConnDefault };
}

export function listConnections(userId: string, pagination: PaginationParams): PaginatedResult<ConnectionProfile> {
  return paginatedQuery(
    "SELECT * FROM connection_profiles WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM connection_profiles WHERE user_id = ?",
    [userId],
    pagination,
    rowToProfile
  );
}

export function getConnection(userId: string, id: string): ConnectionProfile | null {
  const row = getConnStmts().byId.get(id, userId) as any;
  return row ? rowToProfile(row) : null;
}

export function getUsableConnection(userId: string, id: string): ConnectionProfile | null {
  const profile = getConnection(userId, id);
  return isConnectionUsable(profile) ? profile : null;
}

export function getDefaultConnection(userId: string): ConnectionProfile | null {
  const row = getConnStmts().byDefault.get(userId) as any;
  const profile = row ? rowToProfile(row) : null;
  return isConnectionUsable(profile) ? profile : null;
}


export function resolveConnection(userId: string, id?: string): ConnectionProfile | null {
  const profile = id ? getUsableConnection(userId, id) : getDefaultConnection(userId);
  if (!profile) return null;
  if (!isModelRouletteProfile(profile)) return profile;

  const targetIds = getConnectionRouletteConfig(profile).connection_ids
    .filter((targetId) => targetId !== profile.id);
  const candidates: ConnectionProfile[] = [];
  for (const targetId of targetIds) {
    const candidate = getUsableConnection(userId, targetId);
    if (!candidate || isModelRouletteProfile(candidate)) continue;
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    throw new Error(`Model roulette "${profile.name}" has no available connection profiles.`);
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

function resolveExpectedConcreteConnection(
  userId: string,
  logical: ConnectionProfile,
  expectedConcreteId: string,
): ConnectionProfile | null {
  if (!isModelRouletteProfile(logical)) {
    return logical.id === expectedConcreteId && isConnectionUsable(logical) ? logical : null;
  }
  const allowed = getConnectionRouletteConfig(logical).connection_ids;
  if (!allowed.includes(expectedConcreteId) || expectedConcreteId === logical.id) return null;
  const candidate = getUsableConnection(userId, expectedConcreteId);
  if (!candidate || isModelRouletteProfile(candidate)) return null;
  return candidate;
}

type SecretIdentityRow = {
  updated_at: number | null;
  encrypted_value: string;
  iv: string;
  tag: string;
};

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value) ?? "null";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? (JSON.stringify(value) ?? "null") : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value)) ?? "null";
}

function sha256Canonical(value: unknown): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalJson(value));
  return hasher.digest("hex");
}

export function cloneAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const copy = value.map((entry) => cloneAndFreeze(entry));
    return Object.freeze(copy) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    copy[key] = cloneAndFreeze(entry);
  }
  return Object.freeze(copy) as T;
}

/**
 * Normalize only the endpoint identity. This keeps endpoint revisions stable
 * across host casing, default ports, query ordering, and trailing slashes
 * without changing the existing provider URL resolver used by Response mode.
 */
export function normalizeEffectiveEndpointV1(rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.hash = "";
    if ((url.protocol === "https:" && url.port === "443") ||
        (url.protocol === "http:" && url.port === "80")) {
      url.port = "";
    }
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    const query = [...url.searchParams.entries()]
      .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
        if (leftValue === rightValue) return 0;
        return leftValue < rightValue ? -1 : 1;
      });
    url.search = "";
    for (const [key, value] of query) url.searchParams.append(key, value);

    const rendered = url.toString();
    if (url.pathname === "/" && rendered.startsWith(`${url.origin}/`)) {
      return `${url.origin}${rendered.slice(url.origin.length + 1)}`;
    }
    return rendered;
  } catch {
    // Keep malformed custom endpoints usable for existing Response behavior,
    // but still make equivalent whitespace/trailing-slash values stable.
    return trimmed.replace(/\/+$/, "");
  }
}

function endpointAffectingMetadata(
  profile: Pick<ConnectionProfile, "provider" | "api_url" | "metadata">,
): Record<string, unknown> {
  const metadata = profile.metadata || {};
  switch (profile.provider) {
    case "nanogpt":
      return { use_subscription_api: metadata.use_subscription_api === true };
    case "zai":
      return { use_coding_plan_endpoint: metadata.use_coding_plan_endpoint === true };
    case "google_vertex": {
      const rawRegion = typeof metadata.vertex_region === "string"
        ? metadata.vertex_region.trim().toLowerCase()
        : "";
      return { vertex_region: rawRegion || "global" };
    }
    case "bedrock":
      if (profile.api_url?.trim()) return {};
      return {
        region: typeof metadata.region === "string" && metadata.region.trim()
          ? metadata.region.trim().toLowerCase()
          : "us-east-1",
        bedrock_endpoint: metadata.bedrock_endpoint === "runtime" ? "runtime" : "mantle",
      };
    default:
      return {};
  }
}

function readCredentialIdentity(
  userId: string,
  concreteId: string,
): { secretRef: string; revision: string; fingerprintIdentity: string } {
  const secretRef = connectionSecretKey(concreteId);
  const row = getDb().query(
    "SELECT updated_at, encrypted_value, iv, tag FROM secrets WHERE key = ? AND user_id = ?",
  ).get(secretRef, userId) as SecretIdentityRow | null;
  // Hash encrypted storage metadata only. The resolver never decrypts or
  // handles the credential plaintext, while a same-second rotation still
  // changes identity because AES-GCM writes a fresh IV/ciphertext.
  const encryptedIdentity = row
    ? sha256Canonical({
      encrypted_value: row.encrypted_value,
      iv: row.iv,
      tag: row.tag,
    })
    : null;
  const fingerprintIdentity = sha256Canonical({
    present: !!row,
    updated_at: row?.updated_at ?? null,
    encrypted_identity: encryptedIdentity,
  });
  return {
    secretRef,
    fingerprintIdentity,
    revision: sha256Canonical({
      secret_ref: secretRef,
      present: !!row,
      updated_at: row?.updated_at ?? null,
      encrypted_identity: encryptedIdentity,
    }),
  };
}

/**
 * Resolve a logical connection exactly once into a frozen concrete identity.
 *
 * A model roulette profile is selected by the existing resolver one time; the
 * selected candidate is then used for every revision/fingerprint calculation.
 * The returned descriptor intentionally contains no API-key value.
 */
export function resolveConcreteConnectionV1(
  userId: string,
  logicalId?: string,
  expectedConcreteId?: string | null,
): ResolvedConcreteConnectionV1 | null {
  const logical = logicalId
    ? getUsableConnection(userId, logicalId)
    : getDefaultConnection(userId);
  if (!logical) return null;


  // During decision-token consumption/commit, revalidate the concrete member
  // already admitted instead of rerolling a model-roulette profile.
  const concrete = expectedConcreteId
    ? resolveExpectedConcreteConnection(userId, logical, expectedConcreteId)
    : resolveConnection(userId, logical.id);
  if (!concrete) return null;
  const provider = getProvider(concrete.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${concrete.provider}`);
  }

  const endpointMetadata = endpointAffectingMetadata(concrete);
  const endpoint = normalizeEffectiveEndpointV1(resolveEffectiveApiUrl(concrete));
  const endpointRevision = sha256Canonical({
    provider: concrete.provider,
    endpoint,
    endpoint_metadata: endpointMetadata,
  });
  const credential = readCredentialIdentity(userId, concrete.id);
  const candidateRevision = sha256Canonical({
    user_id: userId,
    id: concrete.id,
    name: concrete.name,
    provider: concrete.provider,
    api_url: concrete.api_url,
    model: concrete.model,
    preset_id: concrete.preset_id,
    is_default: concrete.is_default,
    has_api_key: concrete.has_api_key,
    metadata: concrete.metadata,
    created_at: concrete.created_at,
    updated_at: concrete.updated_at,
    endpoint_revision: endpointRevision,
    credential_revision: credential.revision,
  });
  const fingerprint = sha256Canonical({
    provider: concrete.provider,
    endpoint,
    credential_identity: credential.fingerprintIdentity,
  });
  const capabilities = cloneAndFreeze(provider.capabilities) as Readonly<ProviderCapabilities>;

  return cloneAndFreeze({
    logicalId: logical.id,
    concreteId: concrete.id,
    label: concrete.name,
    provider: concrete.provider,
    model: concrete.model,
    endpoint,
    effectiveEndpoint: endpoint,
    endpointRevision,
    credentialSecretRef: credential.secretRef,
    credentialRevision: credential.revision,
    candidateRevision,
    fingerprint,
    capabilities,
  });
}

/**
 * The user's explicitly selected connection profile — the STRICT first rung of
 * the acting chain: the persisted `activeProfileId` setting, validated with
 * `getConnection`, or `undefined` when it is absent, empty, not a string, or
 * names a profile that no longer exists.
 *
 * Exported separately from `resolveActingConnectionId` on purpose: this is the
 * only rung that expresses an explicit user selection, so it is the only rung
 * permitted to override a chat-scoped `connection_profile_id` pin (the
 * `editAndSendAlwaysUseActiveConnection` opt-in). `resolveActingConnectionId`
 * ends in "any profile you own", and "any profile you own" is a weaker signal
 * than an explicit pin.
 */
export function resolveActiveConnectionId(userId: string): string | undefined {
  const active = settingsSvc.getSetting(userId, "activeProfileId");
  if (
    typeof active?.value === "string" &&
    active.value &&
    getConnection(userId, active.value)
  ) {
    return active.value;
  }
  return undefined;
}

/**
 * Pick the connection profile a generation triggered SERVER-SIDE with no
 * caller-supplied `connection_id` should run on.
 *
 * A user's own sends pass `connection_id: activeProfileId` from the UI, but
 * server-triggered generations (Edit-and-Send outbox dispatch, room peer
 * message / freeform deadline / "End now", spindle sends that forward an
 * `undefined` id) have no such context. `resolveConnection` then falls back to
 * `getDefaultConnection`, which ONLY matches `is_default = 1` — so a user whose
 * active profile is not their default silently runs on a connection they never
 * selected, and a user with several profiles but no explicit default hard-fails
 * with "No connection profile found". Mirror the user's actual selection
 * instead, with safe fallbacks: their active profile → the DB default → any
 * profile they own.
 *
 * Returns `undefined` when the user owns no connections at all, preserving the
 * caller's existing "no connection profile found" error.
 *
 * This is the single owner of that chain; `multiplayer.resolveHostConnectionId`
 * delegates here so the room path and the Edit-and-Send path cannot drift.
 */
export function resolveActingConnectionId(userId: string): string | undefined {
  return resolveActiveConnectionId(userId)
    ?? getDefaultConnection(userId)?.id
    ?? listConnections(userId, { limit: 1, offset: 0 }).data[0]?.id;
}

/**
 * The connection an Edit-and-Send request is COMMITTED against, resolved once at
 * enqueue time and then persisted on `generation_outbox.connection_id`.
 *
 * This exists because connection selection used to be re-read at dispatch time.
 * The outbox is durable and its dispatch is not: the same row can be dispatched
 * from the POST handler, again from the periodic retry tick after a backoff, and
 * again from startup crash recovery — potentially hours apart. Re-reading
 * `activeProfileId` (or the chat's `connection_profile_id` pin) on each of those
 * ticks means switching profiles retargets a request the user already committed.
 * Resolving here and storing the answer makes the choice immutable for the life
 * of the request, which is the whole point of an outbox.
 *
 * Mirrors `generate.service.resolveChatGenerationConnection` rung for rung:
 *   1. the `editAndSendAlwaysUseActiveConnection` opt-in → STRICT active profile
 *   2. a live chat-scoped `connection_profile_id` pin
 *   3. the acting chain (active → `is_default` → any owned profile)
 *
 * Returns `undefined` when nothing resolves — including when the `settings` or
 * `connection_profiles` tables are absent, which is the case in several
 * edit-and-send test fixtures that build a minimal schema by hand. A `NULL`
 * column is a first-class value here: the dispatcher falls back to the existing
 * resolve-at-dispatch ladder, which is also what rows committed before this
 * column existed must do. Never throws: a connection lookup failure must not be
 * able to fail the user's edit.
 */
export function resolveEditAndSendConnectionId(
  userId: string,
  chatMetadata: Record<string, any> | null | undefined,
): string | undefined {
  try {
    if (settingsSvc.readEditAndSendAlwaysUseActiveConnection(userId)) {
      const activeId = resolveActiveConnectionId(userId);
      if (activeId) return activeId;
    }
    const boundId = typeof chatMetadata?.connection_profile_id === "string"
      ? chatMetadata.connection_profile_id.trim()
      : "";
    if (boundId && getConnection(userId, boundId)) return boundId;
    return resolveActingConnectionId(userId);
  } catch {
    return undefined;
  }
}

export async function createConnection(userId: string, input: CreateConnectionProfileInput): Promise<ConnectionProfile> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  if (input.is_default) {
    getDb().query("UPDATE connection_profiles SET is_default = 0 WHERE is_default = 1 AND user_id = ?").run(userId);
  }

  let hasApiKey = 0;
  if (input.api_key) {
    await secretsSvc.putSecret(userId, connectionSecretKey(id), input.api_key);
    hasApiKey = 1;
  }

  try {
    getDb()
      .query(
        "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id, userId, input.name, input.provider,
        input.api_url || "", input.model || "",
        input.preset_id || null,
        input.is_default ? 1 : 0,
        hasApiKey,
        JSON.stringify(clearImportedConnectionReview(input.metadata || {})),
        now, now
      );
  } catch (error) {
    // The secret is written before the profile row; a failed insert must not
    // leave an orphaned credential behind.
    if (hasApiKey) secretsSvc.deleteSecret(userId, connectionSecretKey(id));
    throw error;
  }

  return getConnection(userId, id)!;
}

export async function updateConnection(userId: string, id: string, input: UpdateConnectionProfileInput): Promise<ConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;
  const reviewRequested = input.reviewed === true;
  const wasReviewRequired = existing.review_required;
  const canSetDefault = !wasReviewRequired || reviewRequested;

  if (input.is_default && canSetDefault) {
    getDb().query("UPDATE connection_profiles SET is_default = 0 WHERE is_default = 1 AND user_id = ?").run(userId);
  }

  // Handle api_key: non-empty stores new key, empty string deletes key
  if (input.api_key !== undefined) {
    if (input.api_key) {
      await setConnectionApiKey(userId, id, input.api_key);
    } else {
      await clearConnectionApiKey(userId, id);
    }
  }

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.provider !== undefined) { fields.push("provider = ?"); values.push(input.provider); }
  if (input.api_url !== undefined) { fields.push("api_url = ?"); values.push(input.api_url); }
  if (input.model !== undefined) { fields.push("model = ?"); values.push(input.model); }
  if (input.preset_id !== undefined) { fields.push("preset_id = ?"); values.push(input.preset_id || null); }
  if (input.is_default !== undefined) { fields.push("is_default = ?"); values.push(input.is_default && canSetDefault ? 1 : 0); }
  if (input.metadata !== undefined) {
    fields.push("metadata = ?");
    values.push(JSON.stringify(reviewRequested
      ? clearImportedConnectionReview(input.metadata)
      : wasReviewRequired
        ? markImportedConnectionForReview(input.metadata, existing.review_code || "foreign_import")
        : clearImportedConnectionReview(input.metadata)));
  } else if (reviewRequested) {
    fields.push("metadata = ?");
    values.push(JSON.stringify(clearImportedConnectionReview(existing.metadata)));
  }

  if (fields.length === 0 && input.api_key === undefined) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE connection_profiles SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getConnection(userId, id)!;
  eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, { id, profile: toPublicConnection(updated) }, userId);
  return updated;
}

export async function duplicateConnection(userId: string, id: string): Promise<ConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const cleanMetadata = clearImportedConnectionReview({ ...existing.metadata });
  delete cleanMetadata.reasoningBindings;
  if (existing.review_required) {
    Object.assign(cleanMetadata, markImportedConnectionForReview(cleanMetadata, existing.review_code ?? "foreign_import"));
  }
  let hasApiKey = 0;
  if (!existing.review_required && existing.has_api_key) {
    try {
      const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
      if (apiKey) {
        await secretsSvc.putSecret(userId, connectionSecretKey(newId), apiKey);
        hasApiKey = 1;
      }
    } catch {
      // Duplicate without the key if secret retrieval fails.
    }
  }

  getDb()
    .query(
      "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      newId, userId, `${existing.name} (Copy)`, existing.provider,
      existing.api_url, existing.model,
      existing.preset_id || null,
      0,
      hasApiKey,
      JSON.stringify(cleanMetadata),
      now, now
    );

  const profile = getConnection(userId, newId)!;
  eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, { id: newId, profile: toPublicConnection(profile) }, userId);
  return profile;
}


export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  const deleted = getDb().query("DELETE FROM connection_profiles WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  if (deleted) {
    // Cleanup the connection's secret
    secretsSvc.deleteSecret(userId, connectionSecretKey(id));
    settingsSvc.deleteSetting(userId, `presetProfile:connection:${id}`);
  }
  return deleted;
}

export async function setConnectionApiKey(userId: string, id: string, key: string): Promise<void> {
  await secretsSvc.putSecret(userId, connectionSecretKey(id), key);
  getDb().query("UPDATE connection_profiles SET has_api_key = 1, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
}

export async function clearConnectionApiKey(userId: string, id: string): Promise<void> {
  secretsSvc.deleteSecret(userId, connectionSecretKey(id));
  getDb().query("UPDATE connection_profiles SET has_api_key = 0, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
}

export async function testConnection(
  userId: string,
  id: string,
  options?: { timeoutMs?: number }
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS;
  const profile = getUsableConnection(userId, id);
  if (!profile) {
    return {
      success: false,
      message: "Connection is unavailable until it is reviewed.",
      provider: "",
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: "Connection requires owner review",
    };
  }


  if (isModelRouletteProfile(profile)) {
    const targetIds = getConnectionRouletteConfig(profile).connection_ids;
    const validTargets = targetIds
    // imported/review-required roulette profiles are inert just like ordinary
    // imported connection rows.

      .map((targetId) => getUsableConnection(userId, targetId))
      .filter((target): target is ConnectionProfile => !!target && !isModelRouletteProfile(target));

    if (validTargets.length === 0) {
      return {
        success: false,
        message: `Model roulette "${profile.name}" has no available connection profiles.`,
        provider: MODEL_ROULETTE_PROVIDER,
        durationMs: Date.now() - startedAt,
        timedOut: false,
        error: "No roulette targets configured",
      };
    }

    return {
      success: true,
      message: `Model roulette is ready with ${validTargets.length} connection${validTargets.length === 1 ? "" : "s"}.`,
      provider: MODEL_ROULETTE_PROVIDER,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: null,
    };
  }

  const provider = getProvider(profile.provider);
  if (!provider) {
    return {
      success: false,
      message: `Unknown provider: ${profile.provider}`,
      provider: profile.provider,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: `Unknown provider: ${profile.provider}`,
    };
  }

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return {
      success: false,
      message: `No API key for connection "${profile.name}"`,
      provider: profile.provider,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: `Missing API key for connection "${profile.name}"`,
    };
  }

  try {
    const valid = await withTimeout(
      provider.validateKey(apiKey || "", resolveEffectiveApiUrl(profile)),
      timeoutMs,
      `Connection test for "${profile.name}" (${profile.provider})`
    );
    return {
      success: valid,
      message: valid ? "Connection successful" : "API key validation failed",
      provider: profile.provider,
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: valid ? null : "API key validation failed",
    };
  } catch (err: any) {
    const timedOut = err?.name === "TimeoutError";
    return {
      success: false,
      message: describeConnectionTestError(err),
      provider: profile.provider,
      durationMs: Date.now() - startedAt,
      timedOut,
      error: describeConnectionTestError(err),
    };
  }
}

export async function listConnectionModels(userId: string, id: string): Promise<{ models: string[]; model_labels?: Record<string, string>; provider: string; error?: string }> {
  const profile = getUsableConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection requires owner review" };

  if (isModelRouletteProfile(profile)) {
    return { models: [], provider: MODEL_ROULETTE_PROVIDER, error: "Model roulette uses the selected member profile models." };
  }

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  return listConnectionModelsPreview(userId, {
    connection_id: id,
    provider: profile.provider,
    api_url: profile.api_url,
    metadata: profile.metadata,
    api_key: apiKey || undefined,
  });
}

export async function listConnectionModelsPreview(
  userId: string,
  input: ConnectionModelsPreviewInput
): Promise<{ models: string[]; model_labels?: Record<string, string>; provider: string; error?: string }> {
  const existing = input.connection_id ? getConnection(userId, input.connection_id) : null;
  if (existing && !isConnectionUsable(existing)) {
    return { models: [], provider: input.provider, error: "Connection requires owner review" };
  }
  const providerId = input.provider;

  const metadata = input.metadata ?? existing?.metadata ?? {};
  const apiUrl = resolveEffectiveApiUrl({
    provider: providerId,
    api_url: input.api_url ?? existing?.api_url ?? "",
    metadata,
  });

  let apiKey = input.api_key;
  if (apiKey === undefined && existing && existing.provider === providerId) {
    apiKey = (await secretsSvc.getSecret(userId, connectionSecretKey(existing.id))) || undefined;
  }

  const provider = getProvider(providerId);
  if (!provider) return { models: [], provider: providerId, error: `Unknown provider: ${providerId}` };

  try {
    let model_labels: Record<string, string> | undefined;

    if (providerId === "openrouter") {
      const { OpenRouterProvider } = await import("../llm/providers/openrouter");
      if (provider instanceof OpenRouterProvider) {
        const richModels = await provider.fetchModelsWithMetadata(apiKey || "", apiUrl, {
          outputModalities: input.output_modalities,
        });
        const models = richModels.map((m) => m.id).sort();
        const model_labels: Record<string, string> = {};
        for (const m of richModels) {
          if (m.name && m.name !== m.id) model_labels[m.id] = m.name;
        }
        return { models, model_labels, provider: providerId };
      }
    }

    const models = await provider.listModels(apiKey || "", apiUrl);
    return { models, model_labels, provider: providerId };
  } catch (err: any) {
    return { models: [], provider: providerId, error: describeProviderError(err, "Failed to fetch models") };
  }
}

export async function fetchNanoGptSubscriptionUsage(userId: string, id: string): Promise<NanoGptSubscriptionUsage | null> {
  const profile = getUsableConnection(userId, id);
  if (!profile || profile.provider !== "nanogpt") return null;


  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  if (!apiKey) return null;

  try {
    const res = await fetch(resolveNanoGptSubscriptionUsageUrl(profile), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!res.ok) return null;

    const raw = await res.json() as any;
    return {
      active: !!raw?.active,
      allowOverage: !!raw?.allowOverage,
      dailyInputTokens: parseNanoGptUsageWindow(raw?.dailyInputTokens, raw?.limits?.dailyInputTokens),
      weeklyInputTokens: parseNanoGptUsageWindow(raw?.weeklyInputTokens, raw?.limits?.weeklyInputTokens),
      dailyImages: parseNanoGptUsageWindow(raw?.dailyImages, raw?.limits?.dailyImages),
      period: {
        currentPeriodEnd: typeof raw?.period?.currentPeriodEnd === "string" ? raw.period.currentPeriodEnd : null,
      },
      state: typeof raw?.state === "string" ? raw.state : null,
      graceUntil: typeof raw?.graceUntil === "string" ? raw.graceUntil : null,
    };
  } catch {
    return null;
  }
}

export async function listConnectionRegions(userId: string, id: string): Promise<{ regions: string[]; error?: string }> {
  const profile = getUsableConnection(userId, id);
  if (!profile) return { regions: [], error: "Connection requires owner review" };

  if (profile.provider !== "google_vertex") {
    return { regions: [], error: "Region listing is only supported for Google Vertex AI" };
  }

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  if (!apiKey) return { regions: [], error: "No service account configured" };

  try {
    const { listVertexLocations } = await import("../llm/providers/google-vertex");
    const regions = await listVertexLocations(apiKey);
    return { regions };
  } catch (err: any) {
    return { regions: [], error: describeProviderError(err, "Failed to list regions") };
  }
}

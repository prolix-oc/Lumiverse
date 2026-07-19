import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getProvider } from "../llm/registry";
import { resolveEffectiveApiUrl } from "../llm/resolve-api-url";
import { env } from "../env";
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import type { PreparedSecret } from "./secrets.service";
import type {
  ConnectionProfile, CreateConnectionProfileInput, UpdateConnectionProfileInput,
} from "../types/connection-profile";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import { describeProviderError } from "../utils/provider-errors";
import {
  DispatchStateError,
  withDispatchStateTransactionInExistingTransaction,
  type DispatchStateTransaction,
} from "./dispatch-state.service";

const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 15_000;
export const MODEL_ROULETTE_PROVIDER = "model_roulette";

function finalizeConnectionDispatch(
  transaction: DispatchStateTransaction,
  connectionId?: string,
): void {
  const before = transaction.read();
  try {
    transaction.resolve(connectionId
      ? { source: "slot", connectionId }
      : { source: "main" });
  } catch (error) {
    if (
      error instanceof DispatchStateError
      && (
        error.code === "DISPATCH_CONNECTION_NOT_FOUND"
        || error.code === "DISPATCH_CONNECTION_UNRESOLVED"
        || error.code === "DISPATCH_CONNECTION_ROULETTE_UNSUPPORTED"
        || error.code === "DISPATCH_PRESET_NOT_FOUND"
      )
    ) {
      transaction.mutate({ incrementGeneration: true });
      return;
    }
    throw error;
  }
  if (transaction.read().revision === before.revision) {
    transaction.mutate({ incrementGeneration: true });
  }
}

export interface ConnectionRouletteConfig {
  connection_ids: string[];
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

export function resolvePollinationsAppKey(userId: string): string {
  const envKey = env.pollinationsAppKey.trim();
  if (envKey) return envKey;

  const setting = settingsSvc.getSetting(userId, "pollinations_app_key");
  const settingValue = typeof setting?.value === "string" ? setting.value.trim() : "";
  return settingValue;
}

export function buildPollinationsAuthorizeUrl(
  userId: string,
  input: {
    redirect_url: string;
    models?: string;
    budget?: number;
    expiry?: number;
    permissions?: string;
  }
): string {
  const params = new URLSearchParams();
  params.set("redirect_url", input.redirect_url);

  const appKey = resolvePollinationsAppKey(userId);
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
  return {
    ...row,
    preset_id: row.preset_id || null,
    is_default: !!row.is_default,
    has_api_key: !!row.has_api_key,
    metadata: JSON.parse(row.metadata),
  };
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

export function getDefaultConnection(userId: string): ConnectionProfile | null {
  const row = getConnStmts().byDefault.get(userId) as any;
  return row ? rowToProfile(row) : null;
}

export function resolveConnection(userId: string, id?: string): ConnectionProfile | null {
  const profile = id ? getConnection(userId, id) : getDefaultConnection(userId);
  if (!profile) return null;
  if (!isModelRouletteProfile(profile)) return profile;

  const targetIds = getConnectionRouletteConfig(profile).connection_ids
    .filter((targetId) => targetId !== profile.id);
  const candidates: ConnectionProfile[] = [];
  for (const targetId of targetIds) {
    const candidate = getConnection(userId, targetId);
    if (!candidate || isModelRouletteProfile(candidate)) continue;
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    throw new Error(`Model roulette "${profile.name}" has no available connection profiles.`);
  }

  return candidates[Math.floor(Math.random() * candidates.length)];
}

export async function createConnection(userId: string, input: CreateConnectionProfileInput): Promise<ConnectionProfile> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const preparedApiKey = input.api_key
    ? await secretsSvc.prepareSecret(input.api_key)
    : null;
  const db = getDb();

  db.transaction(() => {
    if (input.is_default) {
      db.query("UPDATE connection_profiles SET is_default = 0 WHERE is_default = 1 AND user_id = ?")
        .run(userId);
    }

    db
      .query(
        "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        userId,
        input.name,
        input.provider,
        input.api_url || "",
        input.model || "",
        input.preset_id || null,
        input.is_default ? 1 : 0,
        preparedApiKey ? 1 : 0,
        JSON.stringify(input.metadata || {}),
        now,
        now,
      );
    if (preparedApiKey) {
      secretsSvc.putPreparedSecret(userId, connectionSecretKey(id), preparedApiKey);
    }
    withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
      finalizeConnectionDispatch(transaction, id);
    });
  })();

  return getConnection(userId, id)!;
}

export async function updateConnection(userId: string, id: string, input: UpdateConnectionProfileInput): Promise<ConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: Array<string | number | null> = [];

  if (input.name !== undefined && input.name !== existing.name) {
    fields.push("name = ?");
    values.push(input.name);
  }
  if (input.provider !== undefined && input.provider !== existing.provider) {
    fields.push("provider = ?");
    values.push(input.provider);
  }
  if (input.api_url !== undefined && input.api_url !== existing.api_url) {
    fields.push("api_url = ?");
    values.push(input.api_url);
  }
  if (input.model !== undefined && input.model !== existing.model) {
    fields.push("model = ?");
    values.push(input.model);
  }
  if (
    input.preset_id !== undefined
    && (input.preset_id || null) !== (existing.preset_id || null)
  ) {
    fields.push("preset_id = ?");
    values.push(input.preset_id || null);
  }
  if (
    input.is_default !== undefined
    && (input.is_default ? 1 : 0) !== (existing.is_default ? 1 : 0)
  ) {
    fields.push("is_default = ?");
    values.push(input.is_default ? 1 : 0);
  }
  if (input.metadata !== undefined) {
    const serialized = JSON.stringify(input.metadata);
    if (serialized !== JSON.stringify(existing.metadata)) {
      fields.push("metadata = ?");
      values.push(serialized);
    }
  }

  let preparedApiKey: PreparedSecret | null = null;
  let secretChanged = false;
  if (input.api_key !== undefined) {
    let currentApiKey: string | null = null;
    try {
      currentApiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
    } catch {
      currentApiKey = null;
    }
    if (input.api_key) {
      secretChanged = currentApiKey !== input.api_key || !existing.has_api_key;
      if (secretChanged) {
        preparedApiKey = await secretsSvc.prepareSecret(input.api_key);
      }
    } else {
      secretChanged = existing.has_api_key || currentApiKey !== null;
    }
    if (secretChanged) {
      fields.push("has_api_key = ?");
      values.push(input.api_key ? 1 : 0);
    }
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000), id, userId);

  const db = getDb();
  let changed = false;
  db.transaction(() => {
    if (input.is_default === true && !existing.is_default) {
      changed = db
        .query("UPDATE connection_profiles SET is_default = 0 WHERE is_default = 1 AND user_id = ? AND id <> ?")
        .run(userId, id)
        .changes > 0;
    }

    changed = db
      .query(`UPDATE connection_profiles SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
      .run(...values)
      .changes > 0 || changed;

    if (!changed) return;
    if (secretChanged) {
      if (preparedApiKey) {
        secretsSvc.putPreparedSecret(userId, connectionSecretKey(id), preparedApiKey);
      } else {
        secretsSvc.deleteSecret(userId, connectionSecretKey(id));
      }
    }
    withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
      finalizeConnectionDispatch(transaction, id);
    });
  })();

  if (!changed) return existing;
  const updated = getConnection(userId, id);
  if (!updated) return null;
  eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, { id, profile: updated }, userId);
  return updated;
}

export async function duplicateConnection(userId: string, id: string): Promise<ConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const cleanMetadata = { ...existing.metadata };
  delete cleanMetadata.reasoningBindings;

  let preparedApiKey: PreparedSecret | null = null;
  if (existing.has_api_key) {
    try {
      const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
      if (apiKey) {
        preparedApiKey = await secretsSvc.prepareSecret(apiKey);
      }
    } catch {
      // If key read or preparation fails, duplicate without the key.
    }
  }

  const db = getDb();
  db.transaction(() => {
    db
      .query(
        "INSERT INTO connection_profiles (id, user_id, name, provider, api_url, model, preset_id, is_default, has_api_key, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        newId,
        userId,
        `${existing.name} (Copy)`,
        existing.provider,
        existing.api_url,
        existing.model,
        existing.preset_id || null,
        0,
        preparedApiKey ? 1 : 0,
        JSON.stringify(cleanMetadata),
        now,
        now,
      );
    if (preparedApiKey) {
      secretsSvc.putPreparedSecret(userId, connectionSecretKey(newId), preparedApiKey);
    }
    withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
      finalizeConnectionDispatch(transaction, newId);
    });
  })();

  const profile = getConnection(userId, newId)!;
  eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, { id: newId, profile }, userId);
  return profile;
}

export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  const db = getDb();
  let deleted = false;
  db.transaction(() => {
    deleted = db
      .query("DELETE FROM connection_profiles WHERE id = ? AND user_id = ?")
      .run(id, userId)
      .changes > 0;
    if (!deleted) return;
    secretsSvc.deleteSecret(userId, connectionSecretKey(id));
    db
      .query("DELETE FROM settings WHERE key = ? AND user_id = ?")
      .run(`presetProfile:connection:${id}`, userId);
    withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
      finalizeConnectionDispatch(transaction);
    });
  })();
  return deleted;
}

export async function setConnectionApiKey(userId: string, id: string, key: string): Promise<void> {
  const existing = getConnection(userId, id);
  if (!existing) return;
  let current: string | null = null;
  try {
    current = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  } catch {
    current = null;
  }
  if (current === key && existing.has_api_key) return;

  const prepared = await secretsSvc.prepareSecret(key);
  const db = getDb();
  db.transaction(() => {
    secretsSvc.putPreparedSecret(userId, connectionSecretKey(id), prepared);
    db
      .query("UPDATE connection_profiles SET has_api_key = 1, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(Math.floor(Date.now() / 1000), id, userId);
    withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
      finalizeConnectionDispatch(transaction, id);
    });
  })();
}

export async function clearConnectionApiKey(userId: string, id: string): Promise<void> {
  const existing = getConnection(userId, id);
  if (!existing) return;
  let current: string | null = null;
  try {
    current = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  } catch {
    current = null;
  }
  if (!existing.has_api_key && current === null) return;

  const db = getDb();
  db.transaction(() => {
    secretsSvc.deleteSecret(userId, connectionSecretKey(id));
    db
      .query("UPDATE connection_profiles SET has_api_key = 0, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(Math.floor(Date.now() / 1000), id, userId);
    withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
      finalizeConnectionDispatch(transaction, id);
    });
  })();
}

export async function testConnection(
  userId: string,
  id: string,
  options?: { timeoutMs?: number }
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CONNECTION_TEST_TIMEOUT_MS;
  const profile = getConnection(userId, id);
  if (!profile) {
    return {
      success: false,
      message: "Connection not found",
      provider: "",
      durationMs: Date.now() - startedAt,
      timedOut: false,
      error: "Connection not found",
    };
  }

  if (isModelRouletteProfile(profile)) {
    const targetIds = getConnectionRouletteConfig(profile).connection_ids;
    const validTargets = targetIds
      .map((targetId) => getConnection(userId, targetId))
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
  const profile = getConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection not found" };
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
  const profile = getConnection(userId, id);
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
  const profile = getConnection(userId, id);
  if (!profile) return { regions: [], error: "Connection not found" };

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

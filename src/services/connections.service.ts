import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getProvider } from "../llm/registry";
import { env } from "../env";
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import type {
  ConnectionProfile, CreateConnectionProfileInput, UpdateConnectionProfileInput,
} from "../types/connection-profile";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

const DEFAULT_CONNECTION_TEST_TIMEOUT_MS = 15_000;

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  provider: string;
  durationMs: number;
  timedOut: boolean;
  error: string | null;
}

function describeConnectionTestError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return "Connection test failed";
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

/** Resolve effective API URL, accounting for provider-specific metadata flags. */
export function resolveEffectiveApiUrl(profile: { provider: string; api_url?: string | null; metadata?: Record<string, any> | null }): string {
  const url = profile.api_url || "";
  if (profile.provider === "nanogpt" && profile.metadata?.use_subscription_api) {
    if (!url) return "https://nano-gpt.com/api/subscription/v1";
    return url.replace("/api/v1", "/api/subscription/v1");
  }
  if (profile.provider === "google_vertex") {
    const region = profile.metadata?.vertex_region;
    // Per Google's @google/genai SDK: `global` routes through the
    // un-prefixed host, regional routes through `{region}-aiplatform`.
    if (!region || region === "global") return "https://aiplatform.googleapis.com";
    // Validate the region value: must be a simple alphanumeric GCP region identifier
    // (e.g. "us-central1", "europe-west4") with no special characters that could be
    // used to inject a different hostname or escape the intended googleapis.com domain.
    if (!/^[a-z0-9-]{1,32}$/.test(region)) {
      throw new Error(`Invalid vertex_region value: "${region}"`);
    }
    return `https://${region}-aiplatform.googleapis.com`;
  }
  return url;
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

// Prepared statements for hot-path queries
let _stmtConnById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtConnDefault: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;

function getConnStmts() {
  const db = getDb();
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
      JSON.stringify(input.metadata || {}),
      now, now
    );

  return getConnection(userId, id)!;
}

export async function updateConnection(userId: string, id: string, input: UpdateConnectionProfileInput): Promise<ConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  if (input.is_default) {
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
  if (input.is_default !== undefined) { fields.push("is_default = ?"); values.push(input.is_default ? 1 : 0); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0 && input.api_key === undefined) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE connection_profiles SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getConnection(userId, id)!;
  eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, { id, profile: updated }, userId);
  return updated;
}

export async function duplicateConnection(userId: string, id: string): Promise<ConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Strip reasoningBindings from metadata copy to avoid bound state conflicts
  const cleanMetadata = { ...existing.metadata };
  delete cleanMetadata.reasoningBindings;

  let hasApiKey = 0;
  if (existing.has_api_key) {
    try {
      const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
      if (apiKey) {
        await secretsSvc.putSecret(userId, connectionSecretKey(newId), apiKey);
        hasApiKey = 1;
      }
    } catch {
      // If key read fails, duplicate without the key
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
      0, // never default
      hasApiKey,
      JSON.stringify(cleanMetadata),
      now, now
    );

  const profile = getConnection(userId, newId)!;
  eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, { id: newId, profile }, userId);
  return profile;
}

export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  const deleted = getDb().query("DELETE FROM connection_profiles WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  if (deleted) {
    // Cleanup the connection's secret
    secretsSvc.deleteSecret(userId, connectionSecretKey(id));
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

  const provider = getProvider(profile.provider);
  if (!provider) return { models: [], provider: profile.provider, error: `Unknown provider: ${profile.provider}` };

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return { models: [], provider: profile.provider, error: "No API key" };
  }

  try {
    const apiUrl = resolveEffectiveApiUrl(profile);
    const models = await provider.listModels(apiKey || "", apiUrl);

    // For providers that expose human-readable names, build a label map
    let model_labels: Record<string, string> | undefined;
    if (profile.provider === "openrouter") {
      const { OpenRouterProvider } = await import("../llm/providers/openrouter");
      if (provider instanceof OpenRouterProvider) {
        const richModels = await provider.fetchModelsWithMetadata(apiKey || "", apiUrl);
        model_labels = {};
        for (const m of richModels) {
          if (m.name && m.name !== m.id) model_labels[m.id] = m.name;
        }
      }
    }

    return { models, model_labels, provider: profile.provider };
  } catch (err: any) {
    return { models: [], provider: profile.provider, error: err.message || "Failed to fetch models" };
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
    return { regions: [], error: err.message || "Failed to list regions" };
  }
}

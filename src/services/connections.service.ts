import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getProvider } from "../llm/registry";
import * as secretsSvc from "./secrets.service";
import type {
  ConnectionProfile, CreateConnectionProfileInput, UpdateConnectionProfileInput,
} from "../types/connection-profile";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

/** Secret key for a connection's API key. */
export function connectionSecretKey(id: string): string {
  return `connection_${id}_api_key`;
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
  const row = getDb().query("SELECT * FROM connection_profiles WHERE id = ? AND user_id = ?").get(id, userId) as any;
  return row ? rowToProfile(row) : null;
}

export function getDefaultConnection(userId: string): ConnectionProfile | null {
  const row = getDb().query("SELECT * FROM connection_profiles WHERE is_default = 1 AND user_id = ? LIMIT 1").get(userId) as any;
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

export async function testConnection(userId: string, id: string): Promise<{ success: boolean; message: string; provider: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { success: false, message: "Connection not found", provider: "" };

  const provider = getProvider(profile.provider);
  if (!provider) return { success: false, message: `Unknown provider: ${profile.provider}`, provider: profile.provider };

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return { success: false, message: `No API key for connection "${profile.name}"`, provider: profile.provider };
  }

  try {
    const valid = await provider.validateKey(apiKey || "", profile.api_url || "");
    return {
      success: valid,
      message: valid ? "Connection successful" : "API key validation failed",
      provider: profile.provider,
    };
  } catch (err: any) {
    return { success: false, message: err.message || "Connection test failed", provider: profile.provider };
  }
}

export async function listConnectionModels(userId: string, id: string): Promise<{ models: string[]; provider: string; error?: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection not found" };

  const provider = getProvider(profile.provider);
  if (!provider) return { models: [], provider: profile.provider, error: `Unknown provider: ${profile.provider}` };

  const apiKey = await secretsSvc.getSecret(userId, connectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return { models: [], provider: profile.provider, error: "No API key" };
  }

  try {
    const models = await provider.listModels(apiKey || "", profile.api_url || "");
    return { models, provider: profile.provider };
  } catch (err: any) {
    return { models: [], provider: profile.provider, error: err.message || "Failed to fetch models" };
  }
}

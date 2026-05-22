import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getTtsProvider } from "../tts/registry";
import * as secretsSvc from "./secrets.service";
import type {
  TtsConnectionProfile,
  CreateTtsConnectionInput,
  UpdateTtsConnectionInput,
} from "../types/tts-connection";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import type { TtsVoice } from "../tts/types";
import { describeProviderError } from "../utils/provider-errors";

/** Secret key for a TTS connection's API key. */
export function ttsConnectionSecretKey(id: string): string {
  return `tts_connection_${id}_api_key`;
}

export interface TtsConnectionVoicesPreviewInput {
  connection_id?: string;
  provider: string;
  api_url?: string;
  api_key?: string;
}

export interface TtsConnectionModelsPreviewInput {
  connection_id?: string;
  provider: string;
  api_url?: string;
  api_key?: string;
}

function rowToProfile(row: any): TtsConnectionProfile {
  return {
    ...row,
    is_default: !!row.is_default,
    has_api_key: !!row.has_api_key,
    default_parameters: JSON.parse(row.default_parameters || "{}"),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

export function listConnections(userId: string, pagination: PaginationParams): PaginatedResult<TtsConnectionProfile> {
  return paginatedQuery(
    "SELECT * FROM tts_connections WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM tts_connections WHERE user_id = ?",
    [userId],
    pagination,
    rowToProfile
  );
}

export function getConnection(userId: string, id: string): TtsConnectionProfile | null {
  const row = getDb()
    .query("SELECT * FROM tts_connections WHERE id = ? AND user_id = ?")
    .get(id, userId) as any;
  return row ? rowToProfile(row) : null;
}

export function getDefaultConnection(userId: string): TtsConnectionProfile | null {
  const row = getDb()
    .query("SELECT * FROM tts_connections WHERE is_default = 1 AND user_id = ? LIMIT 1")
    .get(userId) as any;
  return row ? rowToProfile(row) : null;
}

export async function createConnection(
  userId: string,
  input: CreateTtsConnectionInput
): Promise<TtsConnectionProfile> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  if (input.is_default) {
    getDb()
      .query("UPDATE tts_connections SET is_default = 0 WHERE is_default = 1 AND user_id = ?")
      .run(userId);
  }

  let hasApiKey = 0;
  if (input.api_key) {
    await secretsSvc.putSecret(userId, ttsConnectionSecretKey(id), input.api_key);
    hasApiKey = 1;
  }

  getDb()
    .query(
      `INSERT INTO tts_connections
        (id, user_id, name, provider, api_url, model, voice, is_default, has_api_key, default_parameters, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.name,
      input.provider,
      input.api_url || "",
      input.model || "",
      input.voice || "",
      input.is_default ? 1 : 0,
      hasApiKey,
      JSON.stringify(input.default_parameters || {}),
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

  const profile = getConnection(userId, id)!;
  eventBus.emit(EventType.TTS_CONNECTION_CHANGED, { id, profile }, userId);
  return profile;
}

export async function updateConnection(
  userId: string,
  id: string,
  input: UpdateTtsConnectionInput
): Promise<TtsConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  if (input.is_default) {
    getDb()
      .query("UPDATE tts_connections SET is_default = 0 WHERE is_default = 1 AND user_id = ?")
      .run(userId);
  }

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
  if (input.voice !== undefined) { fields.push("voice = ?"); values.push(input.voice); }
  if (input.is_default !== undefined) { fields.push("is_default = ?"); values.push(input.is_default ? 1 : 0); }
  if (input.default_parameters !== undefined) { fields.push("default_parameters = ?"); values.push(JSON.stringify(input.default_parameters)); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0 && input.api_key === undefined) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb()
    .query(`UPDATE tts_connections SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...values);

  const updated = getConnection(userId, id)!;
  eventBus.emit(EventType.TTS_CONNECTION_CHANGED, { id, profile: updated }, userId);
  return updated;
}

export async function duplicateConnection(userId: string, id: string): Promise<TtsConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  let hasApiKey = 0;
  if (existing.has_api_key) {
    try {
      const apiKey = await secretsSvc.getSecret(userId, ttsConnectionSecretKey(id));
      if (apiKey) {
        await secretsSvc.putSecret(userId, ttsConnectionSecretKey(newId), apiKey);
        hasApiKey = 1;
      }
    } catch {
      // If key read fails, duplicate without the key
    }
  }

  getDb()
    .query(
      `INSERT INTO tts_connections
        (id, user_id, name, provider, api_url, model, voice, is_default, has_api_key, default_parameters, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId, userId, `${existing.name} (Copy)`, existing.provider,
      existing.api_url, existing.model, existing.voice,
      0, // never default
      hasApiKey,
      JSON.stringify(existing.default_parameters),
      JSON.stringify(existing.metadata),
      now, now
    );

  const profile = getConnection(userId, newId)!;
  eventBus.emit(EventType.TTS_CONNECTION_CHANGED, { id: newId, profile }, userId);
  return profile;
}

export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  const deleted =
    getDb()
      .query("DELETE FROM tts_connections WHERE id = ? AND user_id = ?")
      .run(id, userId).changes > 0;
  if (deleted) {
    secretsSvc.deleteSecret(userId, ttsConnectionSecretKey(id));
    eventBus.emit(EventType.TTS_CONNECTION_CHANGED, { id, deleted: true }, userId);
  }
  return deleted;
}

export async function setConnectionApiKey(userId: string, id: string, key: string): Promise<void> {
  await secretsSvc.putSecret(userId, ttsConnectionSecretKey(id), key);
  getDb()
    .query("UPDATE tts_connections SET has_api_key = 1, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
}

export async function clearConnectionApiKey(userId: string, id: string): Promise<void> {
  secretsSvc.deleteSecret(userId, ttsConnectionSecretKey(id));
  getDb()
    .query("UPDATE tts_connections SET has_api_key = 0, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
}

export async function testConnection(
  userId: string,
  id: string
): Promise<{ success: boolean; message: string; provider: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { success: false, message: "Connection not found", provider: "" };

  const provider = getTtsProvider(profile.provider);
  if (!provider) {
    return { success: false, message: `Unknown provider: ${profile.provider}`, provider: profile.provider };
  }

  const apiKey = await secretsSvc.getSecret(userId, ttsConnectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return {
      success: false,
      message: `No API key for connection "${profile.name}"`,
      provider: profile.provider,
    };
  }

  try {
    const valid = await provider.validateKey(apiKey || "", profile.api_url || "");
    return {
      success: valid,
      message: valid ? "Connection successful" : "API key validation failed",
      provider: profile.provider,
    };
  } catch (err: any) {
    return { success: false, message: describeProviderError(err, "Connection test failed"), provider: profile.provider };
  }
}

export async function listConnectionModels(
  userId: string,
  id: string
): Promise<{ models: Array<{ id: string; label: string }>; provider: string; error?: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection not found" };

  const apiKey = await secretsSvc.getSecret(userId, ttsConnectionSecretKey(id));
  return listConnectionModelsPreview(userId, {
    connection_id: id,
    provider: profile.provider,
    api_url: profile.api_url,
    api_key: apiKey || undefined,
  });
}

export async function listConnectionModelsPreview(
  userId: string,
  input: TtsConnectionModelsPreviewInput
): Promise<{ models: Array<{ id: string; label: string }>; provider: string; error?: string }> {
  const existing = input.connection_id ? getConnection(userId, input.connection_id) : null;
  const providerId = input.provider;

  let apiKey = input.api_key;
  if (apiKey === undefined && existing && existing.provider === providerId) {
    apiKey = (await secretsSvc.getSecret(userId, ttsConnectionSecretKey(existing.id))) || undefined;
  }

  const provider = getTtsProvider(providerId);
  if (!provider) {
    return { models: [], provider: providerId, error: `Unknown provider: ${providerId}` };
  }

  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return { models: [], provider: providerId, error: "No API key" };
  }

  try {
    const models = await provider.listModels(apiKey || "", input.api_url ?? existing?.api_url ?? "");
    const error = models.length === 0 && provider.capabilities.modelListStyle === "dynamic"
      ? "Provider model listing did not include any obvious TTS models"
      : undefined;
    return { models, provider: providerId, error };
  } catch (err: any) {
    return { models: [], provider: providerId, error: describeProviderError(err, "Failed to fetch models") };
  }
}

export async function listConnectionVoices(
  userId: string,
  id: string
): Promise<{ voices: TtsVoice[]; provider: string; error?: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { voices: [], provider: "", error: "Connection not found" };

  const apiKey = await secretsSvc.getSecret(userId, ttsConnectionSecretKey(id));
  return listConnectionVoicesPreview(userId, {
    connection_id: id,
    provider: profile.provider,
    api_url: profile.api_url,
    api_key: apiKey || undefined,
  });
}

export async function listConnectionVoicesPreview(
  userId: string,
  input: TtsConnectionVoicesPreviewInput
): Promise<{ voices: TtsVoice[]; provider: string; error?: string }> {
  const existing = input.connection_id ? getConnection(userId, input.connection_id) : null;
  const providerId = input.provider;

  let apiKey = input.api_key;
  if (apiKey === undefined && existing && existing.provider === providerId) {
    apiKey = (await secretsSvc.getSecret(userId, ttsConnectionSecretKey(existing.id))) || undefined;
  }

  const provider = getTtsProvider(providerId);
  if (!provider) {
    return { voices: [], provider: providerId, error: `Unknown provider: ${providerId}` };
  }

  try {
    const voices = await provider.listVoices(apiKey || "", input.api_url ?? existing?.api_url ?? "");
    return { voices, provider: providerId };
  } catch (err: any) {
    return { voices: [], provider: providerId, error: describeProviderError(err, "Failed to fetch voices") };
  }
}

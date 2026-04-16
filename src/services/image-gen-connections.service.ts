import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getImageProvider } from "../image-gen/registry";
import * as secretsSvc from "./secrets.service";
import type {
  ImageGenConnectionProfile,
  CreateImageGenConnectionInput,
  UpdateImageGenConnectionInput,
} from "../types/image-gen-connection";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

/** Secret key for an image gen connection's API key. */
export function imageGenConnectionSecretKey(id: string): string {
  return `image_gen_connection_${id}_api_key`;
}

function rowToProfile(row: any): ImageGenConnectionProfile {
  return {
    ...row,
    is_default: !!row.is_default,
    has_api_key: !!row.has_api_key,
    default_parameters: JSON.parse(row.default_parameters || "{}"),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

export function listConnections(userId: string, pagination: PaginationParams): PaginatedResult<ImageGenConnectionProfile> {
  return paginatedQuery(
    "SELECT * FROM image_gen_connections WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM image_gen_connections WHERE user_id = ?",
    [userId],
    pagination,
    rowToProfile
  );
}

export function getConnection(userId: string, id: string): ImageGenConnectionProfile | null {
  const row = getDb()
    .query("SELECT * FROM image_gen_connections WHERE id = ? AND user_id = ?")
    .get(id, userId) as any;
  return row ? rowToProfile(row) : null;
}

export function getDefaultConnection(userId: string): ImageGenConnectionProfile | null {
  const row = getDb()
    .query("SELECT * FROM image_gen_connections WHERE is_default = 1 AND user_id = ? LIMIT 1")
    .get(userId) as any;
  return row ? rowToProfile(row) : null;
}

export async function createConnection(
  userId: string,
  input: CreateImageGenConnectionInput
): Promise<ImageGenConnectionProfile> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  if (input.is_default) {
    getDb()
      .query("UPDATE image_gen_connections SET is_default = 0 WHERE is_default = 1 AND user_id = ?")
      .run(userId);
  }

  let hasApiKey = 0;
  if (input.api_key) {
    await secretsSvc.putSecret(userId, imageGenConnectionSecretKey(id), input.api_key);
    hasApiKey = 1;
  }

  getDb()
    .query(
      `INSERT INTO image_gen_connections
        (id, user_id, name, provider, api_url, model, is_default, has_api_key, default_parameters, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.name,
      input.provider,
      input.api_url || "",
      input.model || "",
      input.is_default ? 1 : 0,
      hasApiKey,
      JSON.stringify(input.default_parameters || {}),
      JSON.stringify(input.metadata || {}),
      now,
      now
    );

  const profile = getConnection(userId, id)!;
  eventBus.emit(EventType.IMAGE_GEN_CONNECTION_CHANGED, { id, profile }, userId);
  return profile;
}

export async function updateConnection(
  userId: string,
  id: string,
  input: UpdateImageGenConnectionInput
): Promise<ImageGenConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  if (input.is_default) {
    getDb()
      .query("UPDATE image_gen_connections SET is_default = 0 WHERE is_default = 1 AND user_id = ?")
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
  if (input.is_default !== undefined) { fields.push("is_default = ?"); values.push(input.is_default ? 1 : 0); }
  if (input.default_parameters !== undefined) { fields.push("default_parameters = ?"); values.push(JSON.stringify(input.default_parameters)); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0 && input.api_key === undefined) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb()
    .query(`UPDATE image_gen_connections SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...values);

  const updated = getConnection(userId, id)!;
  eventBus.emit(EventType.IMAGE_GEN_CONNECTION_CHANGED, { id, profile: updated }, userId);
  return updated;
}

export async function duplicateConnection(userId: string, id: string): Promise<ImageGenConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  let hasApiKey = 0;
  if (existing.has_api_key) {
    try {
      const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
      if (apiKey) {
        await secretsSvc.putSecret(userId, imageGenConnectionSecretKey(newId), apiKey);
        hasApiKey = 1;
      }
    } catch {
      // If key read fails, duplicate without the key
    }
  }

  getDb()
    .query(
      `INSERT INTO image_gen_connections
        (id, user_id, name, provider, api_url, model, is_default, has_api_key, default_parameters, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId, userId, `${existing.name} (Copy)`, existing.provider,
      existing.api_url, existing.model,
      0, // never default
      hasApiKey,
      JSON.stringify(existing.default_parameters),
      JSON.stringify(existing.metadata),
      now, now
    );

  const profile = getConnection(userId, newId)!;
  eventBus.emit(EventType.IMAGE_GEN_CONNECTION_CHANGED, { id: newId, profile }, userId);
  return profile;
}

export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  const deleted =
    getDb()
      .query("DELETE FROM image_gen_connections WHERE id = ? AND user_id = ?")
      .run(id, userId).changes > 0;
  if (deleted) {
    secretsSvc.deleteSecret(userId, imageGenConnectionSecretKey(id));
    eventBus.emit(EventType.IMAGE_GEN_CONNECTION_CHANGED, { id, deleted: true }, userId);
  }
  return deleted;
}

export async function setConnectionApiKey(userId: string, id: string, key: string): Promise<void> {
  await secretsSvc.putSecret(userId, imageGenConnectionSecretKey(id), key);
  getDb()
    .query("UPDATE image_gen_connections SET has_api_key = 1, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
}

export async function clearConnectionApiKey(userId: string, id: string): Promise<void> {
  secretsSvc.deleteSecret(userId, imageGenConnectionSecretKey(id));
  getDb()
    .query("UPDATE image_gen_connections SET has_api_key = 0, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
}

export async function testConnection(
  userId: string,
  id: string
): Promise<{ success: boolean; message: string; provider: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { success: false, message: "Connection not found", provider: "" };

  const provider = getImageProvider(profile.provider);
  if (!provider) {
    return { success: false, message: `Unknown provider: ${profile.provider}`, provider: profile.provider };
  }

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
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
    return { success: false, message: err.message || "Connection test failed", provider: profile.provider };
  }
}

export async function listConnectionModels(
  userId: string,
  id: string
): Promise<{ models: Array<{ id: string; label: string }>; provider: string; error?: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection not found" };

  const provider = getImageProvider(profile.provider);
  if (!provider) {
    return { models: [], provider: profile.provider, error: `Unknown provider: ${profile.provider}` };
  }

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
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

export async function listConnectionModelsBySubtype(
  userId: string,
  id: string,
  subtype: string,
): Promise<{ models: Array<{ id: string; label: string }>; provider: string; error?: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection not found" };

  const provider = getImageProvider(profile.provider);
  if (!provider) {
    return { models: [], provider: profile.provider, error: `Unknown provider: ${profile.provider}` };
  }

  if (!provider.listModelsBySubtype) {
    return { models: [], provider: profile.provider, error: "Provider does not support subtype model listing" };
  }

  const apiKey = await secretsSvc.getSecret(userId, imageGenConnectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return { models: [], provider: profile.provider, error: "No API key" };
  }

  try {
    const models = await provider.listModelsBySubtype(apiKey || "", profile.api_url || "", subtype);
    return { models, provider: profile.provider };
  } catch (err: any) {
    return { models: [], provider: profile.provider, error: err.message || "Failed to fetch models" };
  }
}

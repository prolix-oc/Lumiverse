import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as secretsSvc from "./secrets.service";
import type {
  SttConnectionProfile,
  CreateSttConnectionInput,
  UpdateSttConnectionInput,
} from "../types/stt-connection";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

export interface SttProviderCapabilities {
  apiKeyRequired: boolean;
  defaultUrl: string;
  modelListStyle: "static";
  staticModels: Array<{ id: string; label: string }>;
}

export interface SttProviderInfo {
  id: string;
  name: string;
  capabilities: SttProviderCapabilities;
}

const STT_PROVIDERS: SttProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI-compatible",
    capabilities: {
      apiKeyRequired: true,
      defaultUrl: "https://api.openai.com/v1",
      modelListStyle: "static",
      staticModels: [
        { id: "gpt-4o-transcribe", label: "GPT-4o Transcribe" },
        { id: "whisper-1", label: "Whisper-1" },
      ],
    },
  },
];

export function sttConnectionSecretKey(id: string): string {
  return `stt_connection_${id}_api_key`;
}

function rowToProfile(row: any): SttConnectionProfile {
  return {
    ...row,
    is_default: !!row.is_default,
    has_api_key: !!row.has_api_key,
    default_parameters: JSON.parse(row.default_parameters || "{}"),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

export function listProviders(): SttProviderInfo[] {
  return STT_PROVIDERS;
}

export function getProvider(providerId: string): SttProviderInfo | null {
  return STT_PROVIDERS.find((provider) => provider.id === providerId) || null;
}

export function resolveSttApiUrl(profile: { provider: string; api_url?: string | null }): string {
  const provider = getProvider(profile.provider);
  const raw = (profile.api_url || "").trim();
  const baseUrl = raw || provider?.capabilities.defaultUrl || "https://api.openai.com/v1";
  return baseUrl.replace(/\/+$/, "");
}

export function listConnections(userId: string, pagination: PaginationParams): PaginatedResult<SttConnectionProfile> {
  return paginatedQuery(
    "SELECT * FROM stt_connections WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM stt_connections WHERE user_id = ?",
    [userId],
    pagination,
    rowToProfile,
  );
}

export function getConnection(userId: string, id: string): SttConnectionProfile | null {
  const row = getDb()
    .query("SELECT * FROM stt_connections WHERE id = ? AND user_id = ?")
    .get(id, userId) as any;
  return row ? rowToProfile(row) : null;
}

export async function createConnection(userId: string, input: CreateSttConnectionInput): Promise<SttConnectionProfile> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  if (input.is_default) {
    getDb()
      .query("UPDATE stt_connections SET is_default = 0 WHERE is_default = 1 AND user_id = ?")
      .run(userId);
  }

  let hasApiKey = 0;
  if (input.api_key) {
    await secretsSvc.putSecret(userId, sttConnectionSecretKey(id), input.api_key);
    hasApiKey = 1;
  }

  getDb()
    .query(
      `INSERT INTO stt_connections
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
      now,
    );

  const profile = getConnection(userId, id)!;
  eventBus.emit(EventType.STT_CONNECTION_CHANGED, { id, profile }, userId);
  return profile;
}

export async function updateConnection(userId: string, id: string, input: UpdateSttConnectionInput): Promise<SttConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  if (input.is_default) {
    getDb()
      .query("UPDATE stt_connections SET is_default = 0 WHERE is_default = 1 AND user_id = ?")
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
    .query(`UPDATE stt_connections SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...values);

  const updated = getConnection(userId, id)!;
  eventBus.emit(EventType.STT_CONNECTION_CHANGED, { id, profile: updated }, userId);
  return updated;
}

export async function duplicateConnection(userId: string, id: string): Promise<SttConnectionProfile | null> {
  const existing = getConnection(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  let hasApiKey = 0;
  if (existing.has_api_key) {
    try {
      const apiKey = await secretsSvc.getSecret(userId, sttConnectionSecretKey(id));
      if (apiKey) {
        await secretsSvc.putSecret(userId, sttConnectionSecretKey(newId), apiKey);
        hasApiKey = 1;
      }
    } catch {
      // Duplicate without key if secret retrieval fails.
    }
  }

  getDb()
    .query(
      `INSERT INTO stt_connections
        (id, user_id, name, provider, api_url, model, is_default, has_api_key, default_parameters, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId,
      userId,
      `${existing.name} (Copy)`,
      existing.provider,
      existing.api_url,
      existing.model,
      0,
      hasApiKey,
      JSON.stringify(existing.default_parameters),
      JSON.stringify(existing.metadata),
      now,
      now,
    );

  const profile = getConnection(userId, newId)!;
  eventBus.emit(EventType.STT_CONNECTION_CHANGED, { id: newId, profile }, userId);
  return profile;
}

export async function deleteConnection(userId: string, id: string): Promise<boolean> {
  const deleted =
    getDb()
      .query("DELETE FROM stt_connections WHERE id = ? AND user_id = ?")
      .run(id, userId).changes > 0;

  if (deleted) {
    secretsSvc.deleteSecret(userId, sttConnectionSecretKey(id));
    eventBus.emit(EventType.STT_CONNECTION_CHANGED, { id, deleted: true }, userId);
  }

  return deleted;
}

export async function setConnectionApiKey(userId: string, id: string, key: string): Promise<void> {
  await secretsSvc.putSecret(userId, sttConnectionSecretKey(id), key);
  getDb()
    .query("UPDATE stt_connections SET has_api_key = 1, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
}

export async function clearConnectionApiKey(userId: string, id: string): Promise<void> {
  secretsSvc.deleteSecret(userId, sttConnectionSecretKey(id));
  getDb()
    .query("UPDATE stt_connections SET has_api_key = 0, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(Math.floor(Date.now() / 1000), id, userId);
}

export async function testConnection(userId: string, id: string): Promise<{ success: boolean; message: string; provider: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { success: false, message: "Connection not found", provider: "" };

  const provider = getProvider(profile.provider);
  if (!provider) {
    return { success: false, message: `Unknown provider: ${profile.provider}`, provider: profile.provider };
  }

  const apiKey = await secretsSvc.getSecret(userId, sttConnectionSecretKey(id));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    return { success: false, message: `No API key for connection \"${profile.name}\"`, provider: profile.provider };
  }

  try {
    const formData = new FormData();
    formData.append("model", profile.model || provider.capabilities.staticModels[0]?.id || "gpt-4o-transcribe");
    formData.append("file", new Blob([new Uint8Array(44)], { type: "audio/wav" }), "test.wav");

    const res = await fetch(`${resolveSttApiUrl(profile)}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (res.ok || res.status === 400) {
      return { success: true, message: "Connection successful", provider: profile.provider };
    }

    const body = await res.text().catch(() => "Unknown error");
    return { success: false, message: `STT test failed: ${body}`, provider: profile.provider };
  } catch (err: any) {
    return { success: false, message: err?.message || "Connection test failed", provider: profile.provider };
  }
}

export async function listConnectionModels(
  userId: string,
  id: string,
): Promise<{ models: Array<{ id: string; label: string }>; provider: string; error?: string }> {
  const profile = getConnection(userId, id);
  if (!profile) return { models: [], provider: "", error: "Connection not found" };

  const provider = getProvider(profile.provider);
  if (!provider) return { models: [], provider: profile.provider, error: `Unknown provider: ${profile.provider}` };

  return { models: provider.capabilities.staticModels, provider: profile.provider };
}

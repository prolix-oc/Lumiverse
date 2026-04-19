import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Preset, CreatePresetInput, UpdatePresetInput } from "../types/preset";
import type { ConnectionProfile } from "../types/connection-profile";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import { deleteRegexScriptsByPresetId } from "./regex-scripts.service";
import * as settingsSvc from "./settings.service";
export interface PresetRegistryRow {
  id: string;
  name: string;
  provider: string;
  block_count: number;
  updated_at: number;
}

function rowToPreset(row: any): Preset {
  const preset: Preset = {
    ...row,
    parameters: JSON.parse(row.parameters),
    prompt_order: JSON.parse(row.prompt_order),
    prompts: JSON.parse(row.prompts),
    metadata: JSON.parse(row.metadata),
  };
  return preset;
}

export function listPresets(userId: string, pagination: PaginationParams): PaginatedResult<Preset> {
  return paginatedQuery(
    "SELECT * FROM presets WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM presets WHERE user_id = ?",
    [userId],
    pagination,
    rowToPreset
  );
}

export function listPresetRegistry(
  userId: string,
  pagination: PaginationParams,
  provider?: string,
  engine?: string
): PaginatedResult<PresetRegistryRow> {
  const filters: string[] = [];
  const params: any[] = [userId];

  if (provider) {
    filters.push("provider = ?");
    params.push(provider);
  }
  if (engine) {
    filters.push("engine = ?");
    params.push(engine);
  }

  const filterSQL = filters.length > 0 ? " AND " + filters.join(" AND ") : "";

  return paginatedQuery<any, PresetRegistryRow>(
    `SELECT id, name, provider, updated_at, COALESCE(json_array_length(prompt_order), 0) as block_count
     FROM presets
     WHERE user_id = ?${filterSQL}
     ORDER BY updated_at DESC`,
    `SELECT COUNT(*) as count FROM presets WHERE user_id = ?${filterSQL}`,
    params,
    pagination,
    (row) => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      updated_at: row.updated_at,
      block_count: row.block_count ?? 0,
    })
  );
}

// Prepared statement for hot-path preset fetch (avoids re-compiling for large JSON blobs)
let _stmtPresetById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;

export function getPreset(userId: string, id: string): Preset | null {
  if (!_stmtPresetById) _stmtPresetById = getDb().query("SELECT * FROM presets WHERE id = ? AND user_id = ?");
  const row = _stmtPresetById.get(id, userId) as any;
  return row ? rowToPreset(row) : null;
}

export function countPresets(userId: string): number {
  const row = getDb().query("SELECT COUNT(*) as count FROM presets WHERE user_id = ?").get(userId) as any;
  return row?.count ?? 0;
}

/**
 * Validate that a usable preset exists for generation. Throws a config error
 * (mapped to HTTP 400 by the route) when the user has no presets at all or
 * when the resolved preset id points at a row that was deleted.
 *
 * `requestedPresetId` is the explicit preset the caller asked for; `connectionPresetId`
 * is the fallback carried by the connection profile. Either pointing at a
 * missing row is a hard error — silently falling back to legacy assembly lets
 * stale state produce working-but-unintended generations.
 */
export function assertUsablePreset(
  userId: string,
  requestedPresetId: string | undefined | null,
  connectionPresetId: string | undefined | null,
): void {
  const resolvedId = requestedPresetId || connectionPresetId || null;
  if (resolvedId) {
    if (!getPreset(userId, resolvedId)) {
      throw new Error("The selected preset was deleted. Pick a different preset before generating.");
    }
    return;
  }
  if (countPresets(userId) === 0) {
    throw new Error("No presets available. Create a preset before generating.");
  }
  throw new Error("No preset selected. Choose a preset before generating.");
}

export function createPreset(userId: string, input: CreatePresetInput): Preset {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      "INSERT INTO presets (id, name, provider, engine, parameters, prompt_order, prompts, metadata, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id, input.name, input.provider, input.engine || "classic",
      JSON.stringify(input.parameters || {}),
      JSON.stringify(input.prompt_order || []),
      JSON.stringify(input.prompts || {}),
      JSON.stringify(input.metadata || {}),
      userId, now, now
    );

  return getPreset(userId, id)!;
}

export function updatePreset(userId: string, id: string, input: UpdatePresetInput): Preset | null {
  const existing = getPreset(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.provider !== undefined) { fields.push("provider = ?"); values.push(input.provider); }
  if (input.engine !== undefined) { fields.push("engine = ?"); values.push(input.engine); }
  if (input.parameters !== undefined) { fields.push("parameters = ?"); values.push(JSON.stringify(input.parameters)); }
  if (input.prompt_order !== undefined) { fields.push("prompt_order = ?"); values.push(JSON.stringify(input.prompt_order)); }
  if (input.prompts !== undefined) { fields.push("prompts = ?"); values.push(JSON.stringify(input.prompts)); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE presets SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getPreset(userId, id)!;
  eventBus.emit(EventType.PRESET_CHANGED, { id, preset: updated }, userId);
  return updated;
}

export function deletePreset(userId: string, id: string): boolean {
  const db = getDb();

  // Capture connection profiles that reference this preset. The FK on
  // connection_profiles.preset_id (ON DELETE SET NULL) will clear the
  // references when the preset row is removed, but we need the list up front
  // so we can broadcast refreshed profiles to subscribers afterwards.
  const affectedConnectionIds = (
    db
      .query("SELECT id FROM connection_profiles WHERE user_id = ? AND preset_id = ?")
      .all(userId, id) as Array<{ id: string }>
  ).map((r) => r.id);

  // Cascade-delete any regex scripts that were imported from this preset so
  // they don't linger as orphaned "preset regexes" in the user's list.
  deleteRegexScriptsByPresetId(userId, id);

  const deleted = db.query("DELETE FROM presets WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  if (!deleted) return false;

  // Clean up preset_profile bindings (setting-keyed, no FK) that referenced
  // the now-deleted preset. Covers defaults, per-character, and per-chat.
  for (const s of settingsSvc.getAllSettings(userId)) {
    if (s.key !== "presetProfileDefaults"
      && !s.key.startsWith("presetProfile:character:")
      && !s.key.startsWith("presetProfile:chat:")) continue;
    if (s.value && typeof s.value === "object" && (s.value as any).preset_id === id) {
      settingsSvc.deleteSetting(userId, s.key);
    }
  }

  // Broadcast refreshed connection profiles so frontends drop stale preset_id
  // references from their in-memory stores.
  for (const connId of affectedConnectionIds) {
    const row = db
      .query("SELECT * FROM connection_profiles WHERE id = ? AND user_id = ?")
      .get(connId, userId) as any;
    if (!row) continue;
    const profile: ConnectionProfile = {
      ...row,
      preset_id: row.preset_id || null,
      is_default: !!row.is_default,
      has_api_key: !!row.has_api_key,
      metadata: JSON.parse(row.metadata),
    };
    eventBus.emit(EventType.CONNECTION_PROFILE_LOADED, { id: connId, profile }, userId);
  }

  eventBus.emit(EventType.PRESET_DELETED, { id }, userId);
  return true;
}

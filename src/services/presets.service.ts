import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Preset, CreatePresetInput, UpdatePresetInput } from "../types/preset";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import { deleteRegexScriptsByPresetId } from "./regex-scripts.service";
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
  // Cascade-delete any regex scripts that were imported from this preset so
  // they don't linger as orphaned "preset regexes" in the user's list.
  deleteRegexScriptsByPresetId(userId, id);
  return getDb().query("DELETE FROM presets WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}

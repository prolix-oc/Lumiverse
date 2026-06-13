import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Preset, CreatePresetInput, UpdatePresetInput, PromptBlock, PromptVariableValue } from "../types/preset";
import type { ConnectionProfile } from "../types/connection-profile";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import { deleteRegexScriptsByPresetId } from "./regex-scripts.service";
import * as settingsSvc from "./settings.service";

/**
 * Drop entries in metadata.promptVariables that no longer correspond to a
 * variable defined on some block in prompt_order. Keeps the JSON tidy and
 * prevents stale overrides from resurfacing if a creator re-adds a variable
 * with the same name later.
 */
function prunePromptVariableOrphans(
  promptOrder: unknown,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") return metadata;
  const raw = (metadata as any).promptVariables;
  if (!raw || typeof raw !== "object") return metadata;

  const blocks = Array.isArray(promptOrder) ? (promptOrder as PromptBlock[]) : [];
  const blockById = new Map<string, PromptBlock>();
  for (const b of blocks) if (b && typeof b === "object" && b.id) blockById.set(b.id, b);

  const cleaned: Record<string, Record<string, PromptVariableValue>> = {};
  for (const [blockId, bucket] of Object.entries(raw as Record<string, Record<string, PromptVariableValue>>)) {
    const block = blockById.get(blockId);
    if (!block || !block.variables?.length) continue;
    const validNames = new Set(block.variables.map((v) => v.name));
    const kept: Record<string, PromptVariableValue> = {};
    for (const [name, value] of Object.entries(bucket || {})) {
      if (validNames.has(name)) kept[name] = value;
    }
    if (Object.keys(kept).length) cleaned[blockId] = kept;
  }

  return { ...(metadata as Record<string, unknown>), promptVariables: cleaned };
}
export interface PresetRegistryRow {
  id: string;
  name: string;
  provider: string;
  block_count: number;
  updated_at: number;
}

export interface PromptBlockCategoryGroup {
  categoryBlock: PromptBlock | null;
  children: PromptBlock[];
}

export interface CreatePromptBlockInput extends Partial<PromptBlock> {
  name?: string;
}

export type UpdatePromptBlockInput = Partial<Omit<PromptBlock, "id">>;

function rowToPreset(row: any): Preset {
  // Construct explicitly from the Preset fields rather than spreading `...row`:
  // the latter ships internal columns (e.g. user_id) to the client and carries
  // the raw JSON-string columns alongside the parsed ones.
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    engine: row.engine,
    parameters: JSON.parse(row.parameters),
    prompt_order: JSON.parse(row.prompt_order),
    prompts: JSON.parse(row.prompts),
    metadata: JSON.parse(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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

/**
 * Cheap signature of the registry result set for ETag generation. Any
 * create/delete changes the count; any edit/rename bumps updated_at (and thus
 * the max), so (count, maxUpdatedAt) over the same filter uniquely identifies
 * the current registry without serializing it.
 */
export function getPresetRegistrySignature(
  userId: string,
  provider?: string,
  engine?: string,
): { count: number; maxUpdatedAt: number } {
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
  const row = getDb()
    .query(
      `SELECT COUNT(*) as count, COALESCE(MAX(updated_at), 0) as maxUpdatedAt
       FROM presets WHERE user_id = ?${filterSQL}`
    )
    .get(...params) as { count: number; maxUpdatedAt: number };
  return { count: row.count, maxUpdatedAt: row.maxUpdatedAt };
}

// Prepared statement for hot-path preset fetch (avoids re-compiling for large JSON blobs)
let _stmtPresetById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtPresetByIdGen = -1;

export function getPreset(userId: string, id: string): Preset | null {
  const gen = require("../db/connection").getDbGeneration() as number;
  if (!_stmtPresetById || _stmtPresetByIdGen !== gen) {
    _stmtPresetById = getDb().query("SELECT * FROM presets WHERE id = ? AND user_id = ?");
    _stmtPresetByIdGen = gen;
  }
  const row = _stmtPresetById.get(id, userId) as any;
  return row ? rowToPreset(row) : null;
}

export function countPresets(userId: string): number {
  const row = getDb().query("SELECT COUNT(*) as count FROM presets WHERE user_id = ?").get(userId) as any;
  return row?.count ?? 0;
}

/**
 * Find a preset previously installed from LumiHub by its hub preset id (stored in
 * metadata._lumiverse_lumihub_id). Used to update-in-place on re-install instead of
 * creating a duplicate.
 */
export function findPresetByLumihubId(userId: string, lumihubId: string): Preset | null {
  const row = getDb()
    .query(
      "SELECT * FROM presets WHERE user_id = ? AND json_extract(metadata, '$._lumiverse_lumihub_id') = ? LIMIT 1"
    )
    .get(userId, lumihubId) as any;
  return row ? rowToPreset(row) : null;
}

export function findPresetBySlug(userId: string, slug: string): Preset | null {
  const row = getDb()
    .query(
      "SELECT * FROM presets WHERE user_id = ? AND json_extract(metadata, '$._lumiverse_preset_slug') = ? LIMIT 1"
    )
    .get(userId, slug) as any;
  return row ? rowToPreset(row) : null;
}

export interface PresetManifestRow {
  name: string;
  created_at: number;
  metadata: Record<string, any>;
}

/** Lightweight preset list for building the LumiHub install manifest. */
export function listPresetsForManifest(userId: string): PresetManifestRow[] {
  const rows = getDb()
    .query("SELECT name, metadata, created_at FROM presets WHERE user_id = ?")
    .all(userId) as Array<{ name: string; metadata: string; created_at: number }>;
  return rows.map((r) => {
    let metadata: Record<string, any> = {};
    try {
      metadata = JSON.parse(r.metadata) || {};
    } catch {
      metadata = {};
    }
    return { name: r.name, created_at: r.created_at, metadata };
  });
}

/**
 * Fetch just the preset's updated_at for ETag generation, avoiding the full
 * row read + JSON parse of the (potentially large) preset on a cache hit.
 * Returns null when the preset doesn't exist for this user.
 */
export function getPresetUpdatedAt(userId: string, id: string): number | null {
  const row = getDb()
    .query("SELECT updated_at FROM presets WHERE id = ? AND user_id = ?")
    .get(id, userId) as { updated_at: number } | null;
  return row ? row.updated_at : null;
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

  const cleanedMetadata = prunePromptVariableOrphans(input.prompt_order, input.metadata) || {};

  getDb()
    .query(
      "INSERT INTO presets (id, name, provider, engine, parameters, prompt_order, prompts, metadata, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      id, input.name, input.provider, input.engine || "classic",
      JSON.stringify(input.parameters || {}),
      JSON.stringify(input.prompt_order || []),
      JSON.stringify(input.prompts || {}),
      JSON.stringify(cleanedMetadata),
      userId, now, now
    );

  return getPreset(userId, id)!;
}

export function updatePreset(userId: string, id: string, input: UpdatePresetInput): Preset | null {
  const existing = getPreset(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  // Orphan-GC: if prompt_order or metadata is being written, re-derive a cleaned
  // metadata.promptVariables so stale values (orphaned by a removed def) don't stick.
  // When prompt_order changes alone, persist the cleaned metadata even if the
  // caller didn't touch it — otherwise the orphans would live forever.
  let writeMetadata: Record<string, any> | undefined;
  if (input.metadata !== undefined) {
    const resolvedOrder = input.prompt_order !== undefined ? input.prompt_order : existing.prompt_order;
    writeMetadata = (prunePromptVariableOrphans(resolvedOrder, input.metadata) as Record<string, any>) ?? input.metadata;
  } else if (input.prompt_order !== undefined) {
    const cleaned = prunePromptVariableOrphans(input.prompt_order, existing.metadata as Record<string, unknown>);
    if (cleaned && JSON.stringify(cleaned) !== JSON.stringify(existing.metadata)) {
      writeMetadata = cleaned as Record<string, any>;
    }
  }

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.provider !== undefined) { fields.push("provider = ?"); values.push(input.provider); }
  if (input.engine !== undefined) { fields.push("engine = ?"); values.push(input.engine); }
  if (input.parameters !== undefined) { fields.push("parameters = ?"); values.push(JSON.stringify(input.parameters)); }
  if (input.prompt_order !== undefined) { fields.push("prompt_order = ?"); values.push(JSON.stringify(input.prompt_order)); }
  if (input.prompts !== undefined) { fields.push("prompts = ?"); values.push(JSON.stringify(input.prompts)); }
  if (writeMetadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(writeMetadata)); }

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
  // the now-deleted preset. Covers defaults, per-character, per-chat, and
  // per-connection profile bindings.
  for (const s of settingsSvc.getAllSettings(userId)) {
    if (s.key !== "presetProfileDefaults"
      && !s.key.startsWith("presetProfileDefaults:")
      && !s.key.startsWith("presetProfile:character:")
      && !s.key.startsWith("presetProfile:chat:")
      && !s.key.startsWith("presetProfile:connection:")) continue;
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

function normalizePromptBlock(input: CreatePromptBlockInput): PromptBlock {
  const marker = typeof input.marker === "string" ? input.marker : null;
  const role = input.role === "system" || input.role === "user" || input.role === "assistant" || input.role === "user_append" || input.role === "assistant_append"
    ? input.role
    : "system";
  const position = input.position === "pre_history" || input.position === "post_history" || input.position === "in_history"
    ? input.position
    : "pre_history";
  return {
    id: typeof input.id === "string" && input.id.trim() ? input.id : crypto.randomUUID(),
    name: typeof input.name === "string" && input.name.trim() ? input.name : "New Chat",
    content: typeof input.content === "string" ? input.content : "",
    role,
    enabled: input.enabled !== undefined ? !!input.enabled : true,
    position,
    depth: typeof input.depth === "number" ? input.depth : 0,
    marker,
    isLocked: input.isLocked !== undefined ? !!input.isLocked : false,
    color: typeof input.color === "string" ? input.color : null,
    injectionTrigger: Array.isArray(input.injectionTrigger) ? input.injectionTrigger.filter((v): v is string => typeof v === "string") : [],
    group: typeof input.group === "string" ? input.group : null,
    categoryMode: marker === "category" && (input.categoryMode === "radio" || input.categoryMode === "checkbox")
      ? input.categoryMode
      : null,
    ...(Array.isArray(input.variables) ? { variables: input.variables } : {}),
  };
}

function normalizePromptBlocks(blocks: PromptBlock[]): PromptBlock[] {
  return blocks.map((block) => normalizePromptBlock(block));
}

export function listPromptBlocks(userId: string, presetId: string): PromptBlock[] | null {
  const preset = getPreset(userId, presetId);
  if (!preset) return null;
  return normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
}

export function getPromptBlock(userId: string, presetId: string, blockId: string): PromptBlock | null {
  const blocks = listPromptBlocks(userId, presetId);
  if (!blocks) return null;
  return blocks.find((block) => block.id === blockId) || null;
}

export function createPromptBlock(
  userId: string,
  presetId: string,
  input: CreatePromptBlockInput,
  index?: number
): PromptBlock | null {
  const preset = getPreset(userId, presetId);
  if (!preset) return null;

  const blocks = normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
  const block = normalizePromptBlock(input || {});
  const insertAt = typeof index === "number" && Number.isFinite(index)
    ? Math.max(0, Math.min(blocks.length, Math.floor(index)))
    : blocks.length;
  blocks.splice(insertAt, 0, block);

  updatePreset(userId, presetId, { prompt_order: blocks });
  return block;
}

export function updatePromptBlock(
  userId: string,
  presetId: string,
  blockId: string,
  input: UpdatePromptBlockInput
): PromptBlock | null {
  const preset = getPreset(userId, presetId);
  if (!preset) return null;

  const blocks = normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index === -1) return null;

  const updated = normalizePromptBlock({ ...blocks[index], ...(input || {}), id: blockId });
  blocks[index] = updated;
  updatePreset(userId, presetId, { prompt_order: blocks });
  return updated;
}

export function deletePromptBlock(userId: string, presetId: string, blockId: string): boolean {
  const preset = getPreset(userId, presetId);
  if (!preset) return false;

  const blocks = normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index === -1) return false;

  blocks.splice(index, 1);
  updatePreset(userId, presetId, { prompt_order: blocks });
  return true;
}

export function listPromptBlockCategories(userId: string, presetId: string): PromptBlockCategoryGroup[] | null {
  const blocks = listPromptBlocks(userId, presetId);
  if (!blocks) return null;

  const groups: PromptBlockCategoryGroup[] = [];
  let current: PromptBlockCategoryGroup = { categoryBlock: null, children: [] };
  for (const block of blocks) {
    if (block.marker === "category") {
      if (current.categoryBlock || current.children.length > 0) groups.push(current);
      current = { categoryBlock: block, children: [] };
    } else {
      current.children.push(block);
    }
  }
  if (current.categoryBlock || current.children.length > 0) groups.push(current);
  return groups;
}

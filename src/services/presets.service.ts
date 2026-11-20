import { readDatabaseRow, readDatabaseRows, runDatabaseStatement } from "../db/queries";
import { executeDatabaseOperation } from "../db/execution";
import { mutatePresetWithDb, type PresetMutationResult } from "../db/preset-operations";
import { createHash } from "node:crypto";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Preset, CreatePresetInput, UpdatePresetInput, PromptBlock, PromptBlockPlacement, PromptVariableValue } from "../types/preset";
import { PresetRevisionConflictError } from "../types/preset";
import type { ConnectionProfile } from "../types/connection-profile";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery, paginatedQueryAsync } from "./pagination";
import { deleteRegexScriptsByPresetId } from "./regex-scripts.service";
import { sanitizePromptBlockCharacterTagTrigger } from "../utils/prompt-block-character-tags";
import { getIllarinPresetWorkId } from "../illarin/preset-metadata";
import * as settingsSvc from "./settings.service";
import {
  reconcileStashedPromptBlocks,
  syncStashedBlocksAcrossPresets,
} from "./prompt-stash.service";

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
  cache_revision: number;
  id: string;
  name: string;
  provider: string;
  block_count: number;
  cover_url: string | null;
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
    cache_revision: row.cache_revision ?? 0,
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
    `SELECT id, name, provider, updated_at, cache_revision,
            COALESCE(json_array_length(prompt_order), 0) as block_count,
            COALESCE(json_extract(metadata, '$.coverUrl'), json_extract(metadata, '$.cover_url')) as cover_url
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
      cache_revision: row.cache_revision ?? 0,
      cover_url: typeof row.cover_url === "string" && row.cover_url.trim() ? row.cover_url : null,
    })
  );
}

/**
 * Stable content signature for registry ETags. The ordered `(id, cache_revision)`
 * stream changes for creates, deletes, and every content update without
 * serializing large JSON columns or distorting user-visible update times.
 */
export function getPresetRegistrySignature(
  userId: string,
  provider?: string,
  engine?: string,
): string {
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
  const rows = getDb()
    .query(`SELECT id, cache_revision FROM presets WHERE user_id = ?${filterSQL} ORDER BY id`)
    .all(...params) as Array<{ id: string; cache_revision: number }>;
  const digest = createHash("sha256");
  digest.update(userId).update("\0").update(provider ?? "").update("\0").update(engine ?? "").update("\0");
  for (const row of rows) {
    digest.update(row.id).update("\0").update(String(row.cache_revision)).update("\0");
  }
  return digest.digest("base64url");
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

export function presetExists(userId: string, id: string): boolean {
  return !!getDb().query("SELECT 1 FROM presets WHERE id = ? AND user_id = ?").get(id, userId);
}

export async function getPresetCapabilitiesAsync(userId: string, id: string) {
  const row = await readDatabaseRow<{ id: string; cache_revision: number; has_prompt_variables: number }>(`
    SELECT id, cache_revision, EXISTS (
      SELECT 1 FROM json_each(CASE WHEN json_valid(prompt_order) THEN prompt_order ELSE '[]' END) block
      WHERE CASE WHEN block.type = 'object' THEN
        json_type(block.value, '$.variables') = 'array' AND json_array_length(block.value, '$.variables') > 0
        ELSE 0 END
    ) AS has_prompt_variables FROM presets WHERE id = ? AND user_id = ?`, [id, userId]);
  return row ? { ...row, has_prompt_variables: !!row.has_prompt_variables } : null;
}

export function countPresets(userId: string): number {
  const row = getDb().query("SELECT COUNT(*) as count FROM presets WHERE user_id = ?").get(userId) as any;
  return row?.count ?? 0;
}

const ACTIVE_LOOM_PRESET_SETTING = "activeLoomPresetId";

/**
 * Return the active Loom preset when it still exists, otherwise replace a
 * stale selection with the most recently updated remaining Loom preset.
 *
 * Presets can be removed in another tab or on another device. Keeping this
 * repair server-side means a refresh cannot restore a deleted id and send it
 * back with the next generation request.
 */
export function reconcileActiveLoomPreset(userId: string): string | null {
  return finishPresetMutation(mutatePresetWithDb(getDb(), { action: "reconcileActiveLoomPreset", args: [userId] }), userId);
}

export async function reconcileActiveLoomPresetAsync(userId: string): Promise<string | null> {
  const result = await executeDatabaseOperation<PresetMutationResult>({ kind: "preset-mutation", mutation: { action: "reconcileActiveLoomPreset", args: [userId] } });
  return finishPresetMutation(result, userId);
}

/**
 * Find a preset previously installed from LumiHub by its hub preset id (stored in
 * metadata._lumiverse_lumihub_id). Used to update-in-place on re-install instead of
 * creating a duplicate.
 */
export function findPresetByLumihubId(userId: string, lumihubId: string): Preset | null {
  const row = getDb()
    .query(
      `SELECT * FROM presets
       WHERE user_id = ?
         AND json_extract(metadata, '$._lumiverse_lumihub_id') = ?
         AND (
           json_extract(metadata, '$._lumiverse_install_source') = 'lumihub'
           OR (
             json_extract(metadata, '$._lumiverse_install_source') IS NULL
             AND json_extract(metadata, '$._lumiverse_preset_version') IS NOT NULL
           )
         )
       LIMIT 1`
    )
    .get(userId, lumihubId) as any;
  return row ? rowToPreset(row) : null;
}

/** Find an Illarin preset by its immutable asset id for in-place updates. */
export function findPresetByIllarinAssetId(userId: string, assetId: string): Preset | null {
  const row = getDb()
    .query(
      `SELECT * FROM presets
       WHERE user_id = ?
         AND json_extract(metadata, '$._lumiverse_install_source') = 'illarin'
         AND COALESCE(
           json_extract(metadata, '$._lumiverse_illarin_asset_id'),
           json_extract(metadata, '$._lumiverse_lumihub_id')
         ) = ?
       LIMIT 1`,
    )
    .get(userId, assetId) as any;
  return row ? rowToPreset(row) : null;
}

/**
 * Resolve an installed LumiHub preset by the canonical slug used by the Hub's
 * install manifest. This is the identity fallback for listings whose Hub row
 * id changed while their creator/name identity stayed the same.
 */
export function findLumihubPresetBySlug(userId: string, slug: string): Preset | null {
  const row = getDb()
    .query(
      `SELECT * FROM presets
       WHERE user_id = ?
         AND json_extract(metadata, '$._lumiverse_install_source') = 'lumihub'
         AND json_extract(metadata, '$._lumiverse_preset_slug') = ?
       LIMIT 1`
    )
    .get(userId, slug) as any;
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

/** Fetch a monotonic row revision for cache validation without reading preset JSON. */
export function getPresetCacheRevision(userId: string, id: string): number | null {
  const row = getDb()
    .query("SELECT cache_revision FROM presets WHERE id = ? AND user_id = ?")
    .get(id, userId) as { cache_revision: number } | null;
  return row ? row.cache_revision : null;
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
  return finishPresetMutation(mutatePresetWithDb(getDb(), { action: "createPreset", args: [userId, input] }), userId);
}

export async function createPresetAsync(userId: string, input: CreatePresetInput): Promise<Preset> {
  const result = await executeDatabaseOperation<PresetMutationResult>({ kind: "preset-mutation", mutation: { action: "createPreset", args: [userId, input] } });
  return finishPresetMutation(result, userId);
}

export function updatePreset(userId: string, id: string, input: UpdatePresetInput): Preset | null {
  return finishPresetMutation(mutatePresetWithDb(getDb(), { action: "updatePreset", args: [userId, id, input] }), userId);
}

export async function updatePresetAsync(userId: string, id: string, input: UpdatePresetInput): Promise<Preset | null> {
  const result = await executeDatabaseOperation<PresetMutationResult>({ kind: "preset-mutation", mutation: { action: "updatePreset", args: [userId, id, input] } });
  return finishPresetMutation(result, userId);
}

export function deletePreset(userId: string, id: string): boolean {
  return finishPresetMutation(mutatePresetWithDb(getDb(), { action: "deletePreset", args: [userId, id] }), userId);
}

export async function deletePresetAsync(userId: string, id: string): Promise<boolean> {
  const result = await executeDatabaseOperation<PresetMutationResult>({ kind: "preset-mutation", mutation: { action: "deletePreset", args: [userId, id] } });
  return finishPresetMutation(result, userId);
}

function normalizePromptBlock(input: CreatePromptBlockInput): PromptBlock {
  const marker = typeof input.marker === "string" ? input.marker : null;
  const role = input.role === "system" || input.role === "user" || input.role === "assistant" || input.role === "user_append" || input.role === "assistant_append"
    ? input.role
    : "system";
  const position = input.position === "pre_history" || input.position === "post_history" || input.position === "in_history"
    ? input.position
    : "pre_history";
  const characterTagTrigger = sanitizePromptBlockCharacterTagTrigger(input.characterTagTrigger);
  const placementBinding = normalizePromptBlockPlacementBinding(input.placementBinding);
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
    ...(characterTagTrigger.length > 0 ? { characterTagTrigger } : {}),
    group: typeof input.group === "string" ? input.group : null,
    categoryMode: marker === "category" && (input.categoryMode === "radio" || input.categoryMode === "checkbox")
      ? input.categoryMode
      : null,
    ...(Array.isArray(input.variables) ? { variables: input.variables } : {}),
    ...(placementBinding ? { placementBinding } : {}),
    ...(typeof input.stashId === "string" && input.stashId.trim() ? { stashId: input.stashId.trim() } : {}),
  };
}

function normalizePromptBlockPlacementBinding(
  value: unknown,
): PromptBlock["placementBinding"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { variableId?: unknown; options?: unknown };
  if (typeof raw.variableId !== "string" || !raw.variableId.trim()) return undefined;
  if (!raw.options || typeof raw.options !== "object" || Array.isArray(raw.options)) return undefined;

  const options: Record<string, PromptBlockPlacement> = {};
  for (const [optionId, candidate] of Object.entries(raw.options as Record<string, unknown>)) {
    if (!optionId.trim() || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const placement = candidate as Partial<PromptBlockPlacement>;
    if (
      (placement.role !== "system" && placement.role !== "user" && placement.role !== "assistant" && placement.role !== "user_append" && placement.role !== "assistant_append") ||
      (placement.position !== "pre_history" && placement.position !== "post_history" && placement.position !== "in_history") ||
      typeof placement.depth !== "number" || !Number.isFinite(placement.depth) || placement.depth < 0
    ) {
      continue;
    }
    options[optionId] = {
      role: placement.role,
      position: placement.position,
      depth: Math.floor(placement.depth),
    };
  }
  if (Object.keys(options).length === 0) return undefined;
  return { variableId: raw.variableId.trim(), options };
}

export function normalizePromptBlocks(blocks: PromptBlock[]): PromptBlock[] {
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

  updatePreset(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
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
  updatePreset(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
  return updated;
}

export function deletePromptBlock(userId: string, presetId: string, blockId: string): boolean {
  const preset = getPreset(userId, presetId);
  if (!preset) return false;

  const blocks = normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index === -1) return false;

  blocks.splice(index, 1);
  updatePreset(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
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

function finishPresetMutation<T>(result: PresetMutationResult, userId: string): T {
  if (result.conflict) throw new PresetRevisionConflictError(result.conflict.id, result.conflict.expected, result.conflict.actual);
  for (const event of result.events) eventBus.emit(event.type, event.payload, userId);
  return result.value as T;
}

export async function listPresetsAsync(userId: string, pagination: PaginationParams): Promise<PaginatedResult<Preset>> {
  return paginatedQueryAsync(
    "SELECT * FROM presets WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM presets WHERE user_id = ?",
    [userId],
    pagination,
    rowToPreset
  );
}

export async function listPresetRegistryAsync(
  userId: string,
  pagination: PaginationParams,
  provider?: string,
  engine?: string
): Promise<PaginatedResult<PresetRegistryRow>> {
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

  return paginatedQueryAsync<any, PresetRegistryRow>(
    `SELECT id, name, provider, updated_at, cache_revision,
            COALESCE(json_array_length(prompt_order), 0) as block_count,
            COALESCE(json_extract(metadata, '$.coverUrl'), json_extract(metadata, '$.cover_url')) as cover_url
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
      cache_revision: row.cache_revision ?? 0,
      cover_url: typeof row.cover_url === "string" && row.cover_url.trim() ? row.cover_url : null,
    })
  );
}

export async function getPresetRegistrySignatureAsync(
  userId: string,
  provider?: string,
  engine?: string,
): Promise<string> {
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
  const rows = await readDatabaseRows<{ id: string; cache_revision: number }>(`SELECT id, cache_revision FROM presets WHERE user_id = ?${filterSQL} ORDER BY id`, params);
  const digest = createHash("sha256");
  digest.update(userId).update("\0").update(provider ?? "").update("\0").update(engine ?? "").update("\0");
  for (const row of rows) {
    digest.update(row.id).update("\0").update(String(row.cache_revision)).update("\0");
  }
  return digest.digest("base64url");
}


export async function getPresetAsync(userId: string, id: string): Promise<Preset | null> {
  const row = await readDatabaseRow<any>("SELECT * FROM presets WHERE id = ? AND user_id = ?", [id, userId]);
  return row ? rowToPreset(row) : null;
}

export async function getPresetsByIdsAsync(userId: string, ids: readonly string[]): Promise<Preset[]> {
  const found = new Map<string, Preset>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const rows = await readDatabaseRows<any>(`SELECT * FROM presets WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(",")})`, [userId, ...chunk]);
    for (const row of rows) found.set(row.id, rowToPreset(row));
  }
  return ids.flatMap((id) => found.has(id) ? [found.get(id)!] : []);
}
export async function getPresetCacheRevisionAsync(userId: string, id: string): Promise<number | null> {
  const row = await readDatabaseRow<{ cache_revision: number }>("SELECT cache_revision FROM presets WHERE id = ? AND user_id = ?", [id, userId]);
  return row?.cache_revision ?? null;
}

export async function countPresetsAsync(userId: string): Promise<number> {
  const row = (await readDatabaseRow<any>("SELECT COUNT(*) as count FROM presets WHERE user_id = ?", [userId])) as any;
  return row?.count ?? 0;
}

export async function findPresetByLumihubIdAsync(userId: string, lumihubId: string): Promise<Preset | null> {
  const row = (await readDatabaseRow<any>(`SELECT * FROM presets
       WHERE user_id = ?
         AND json_extract(metadata, '$._lumiverse_lumihub_id') = ?
         AND (
           json_extract(metadata, '$._lumiverse_install_source') = 'lumihub'
           OR (
             json_extract(metadata, '$._lumiverse_install_source') IS NULL
             AND json_extract(metadata, '$._lumiverse_preset_version') IS NOT NULL
           )
         )
       LIMIT 1`, [userId, lumihubId])) as any;
  return row ? rowToPreset(row) : null;
}

export async function findLumihubPresetBySlugAsync(userId: string, slug: string): Promise<Preset | null> {
  const row = (await readDatabaseRow<any>(`SELECT * FROM presets
       WHERE user_id = ?
         AND json_extract(metadata, '$._lumiverse_install_source') = 'lumihub'
         AND json_extract(metadata, '$._lumiverse_preset_slug') = ?
       LIMIT 1`, [userId, slug])) as any;
  return row ? rowToPreset(row) : null;
}

export async function findPresetBySlugAsync(userId: string, slug: string): Promise<Preset | null> {
  const row = (await readDatabaseRow<any>("SELECT * FROM presets WHERE user_id = ? AND json_extract(metadata, '$._lumiverse_preset_slug') = ? LIMIT 1", [userId, slug])) as any;
  return row ? rowToPreset(row) : null;
}

export async function listPresetsForManifestAsync(userId: string): Promise<PresetManifestRow[]> {
  const rows = (await readDatabaseRows<any>("SELECT name, metadata, created_at FROM presets WHERE user_id = ?", [userId])) as Array<{ name: string; metadata: string; created_at: number }>;
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

export async function assertUsablePresetAsync(
  userId: string,
  requestedPresetId: string | undefined | null,
  connectionPresetId: string | undefined | null,
): Promise<void> {
  const resolvedId = requestedPresetId || connectionPresetId || null;
  if (resolvedId) {
    if (!(await getPresetAsync(userId, resolvedId))) {
      throw new Error("The selected preset was deleted. Pick a different preset before generating.");
    }
    return;
  }
  if ((await countPresetsAsync(userId)) === 0) {
    throw new Error("No presets available. Create a preset before generating.");
  }
  throw new Error("No preset selected. Choose a preset before generating.");
}

export async function listPromptBlocksAsync(userId: string, presetId: string): Promise<PromptBlock[] | null> {
  const preset = await getPresetAsync(userId, presetId);
  if (!preset) return null;
  return normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
}

export async function getPromptBlockAsync(userId: string, presetId: string, blockId: string): Promise<PromptBlock | null> {
  const blocks = await listPromptBlocksAsync(userId, presetId);
  if (!blocks) return null;
  return blocks.find((block) => block.id === blockId) || null;
}

export async function createPromptBlockAsync(
  userId: string,
  presetId: string,
  input: CreatePromptBlockInput,
  index?: number
): Promise<PromptBlock | null> {
  const preset = await getPresetAsync(userId, presetId);
  if (!preset) return null;

  const blocks = normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
  const block = normalizePromptBlock(input || {});
  const insertAt = typeof index === "number" && Number.isFinite(index)
    ? Math.max(0, Math.min(blocks.length, Math.floor(index)))
    : blocks.length;
  blocks.splice(insertAt, 0, block);

  await updatePresetAsync(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
  return block;
}

export async function updatePromptBlockAsync(
  userId: string,
  presetId: string,
  blockId: string,
  input: UpdatePromptBlockInput
): Promise<PromptBlock | null> {
  const preset = await getPresetAsync(userId, presetId);
  if (!preset) return null;

  const blocks = normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index === -1) return null;

  const updated = normalizePromptBlock({ ...blocks[index], ...(input || {}), id: blockId });
  blocks[index] = updated;
  await updatePresetAsync(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
  return updated;
}

export async function deletePromptBlockAsync(userId: string, presetId: string, blockId: string): Promise<boolean> {
  const preset = await getPresetAsync(userId, presetId);
  if (!preset) return false;

  const blocks = normalizePromptBlocks((preset.prompt_order || []) as PromptBlock[]);
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index === -1) return false;

  blocks.splice(index, 1);
  await updatePresetAsync(userId, presetId, { prompt_order: blocks, expected_cache_revision: preset.cache_revision });
  return true;
}

export async function listPromptBlockCategoriesAsync(userId: string, presetId: string): Promise<PromptBlockCategoryGroup[] | null> {
  const blocks = await listPromptBlocksAsync(userId, presetId);
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

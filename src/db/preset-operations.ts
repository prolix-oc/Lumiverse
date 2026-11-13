import type { Database } from "bun:sqlite";
import { EventType } from "../ws/events";
import type { Preset, CreatePresetInput, UpdatePresetInput, PromptBlock, PromptVariableValue } from "../types/preset";
import { PresetRevisionConflictError } from "../types/preset";
import type { ConnectionProfile } from "../types/connection-profile";
import type { StashedPromptBlock, StashReconciliation } from "../services/prompt-stash.service";
import { serializeValueOrThrow, assertValidKey } from "../services/settings-validation";
import { getIllarinPresetWorkId } from "../illarin/preset-metadata";
import { deletePresetRegexScriptsWithDb } from "./regex-operations";
import { putSettingsWithDb } from "./settings-operations";

export interface PresetDatabaseEvent { type: EventType; payload: any }
const ACTIVE_LOOM_PRESET_SETTING = "activeLoomPresetId";
const STASH_SETTING_KEY = "loomPromptStash";
const MAX_STASH_ENTRIES = 500;
type StashBlockPayload = StashedPromptBlock["block"];
function getPresetWithDb(db: Database, userId: string, id: string): Preset | null {
  const row = db.query("SELECT * FROM presets WHERE id = ? AND user_id = ?").get(id, userId);
  return row ? rowToPreset(row) : null;
}
function getSettingWithDb(db: Database, userId: string, key: string): { value: any } | null {
  const row = db.query("SELECT value FROM settings WHERE key = ? AND user_id = ?").get(key, userId) as { value: string } | null;
  return row ? { value: JSON.parse(row.value) } : null;
}
function getAllSettingsWithDb(db: Database, userId: string): Array<{ key: string; value: any }> {
  return (db.query("SELECT key, value FROM settings WHERE user_id = ?").all(userId) as Array<{ key: string; value: string }>).map((row) => ({ ...row, value: JSON.parse(row.value) }));
}
function putSettingWithDb(db: Database, events: PresetDatabaseEvent[], userId: string, key: string, value: any): void {
  assertValidKey(key);
  const json = serializeValueOrThrow(key, value);
  putSettingsWithDb(db, userId, [{ key, json }], Math.floor(Date.now() / 1000));
  events.push({ type: EventType.SETTINGS_UPDATED, payload: { key, value } });
}
function deleteSettingWithDb(db: Database, userId: string, key: string): void {
  db.query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId);
}
function deleteRegexScriptsByPresetIdWithEvents(db: Database, events: PresetDatabaseEvent[], userId: string, presetId: string): void {
  for (const id of deletePresetRegexScriptsWithDb(db, userId, presetId)) events.push({ type: EventType.REGEX_SCRIPT_DELETED, payload: { id } });
}
function createPreset(db: Database, events: PresetDatabaseEvent[], userId: string, input: CreatePresetInput): Preset {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const cleanedMetadata = prunePromptVariableOrphans(input.prompt_order, input.metadata) || {};

  db
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

  return getPresetWithDb(db, userId, id)!;
}

function updatePreset(db: Database, events: PresetDatabaseEvent[], userId: string, id: string, input: UpdatePresetInput): Preset | null {
  const existing = getPresetWithDb(db, userId, id);
  if (!existing) return null;
  // Avoid mutating shared stash state for a request we already know is stale.
  // The conditional UPDATE below remains the authoritative race-safe check.
  if (input.expected_cache_revision !== undefined && input.expected_cache_revision !== (existing.cache_revision ?? 0)) {
    throw new PresetRevisionConflictError(id, input.expected_cache_revision, existing.cache_revision ?? 0);
  }

  // A stashed block has global content/configuration but local visibility and
  // list placement. Reconcile before validating prompt variables so the
  // response and persisted row both contain the canonical stash fields.
  let reconciledPromptOrder = input.prompt_order;
  let changedStashIds: string[] = [];
  let commitStashReconciliation: (() => void) | undefined;
  if (Array.isArray(input.prompt_order) && input.prompt_order.some(
    (block) => block && typeof block === "object" && typeof (block as PromptBlock).stashId === "string",
  )) {
    const reconciliation = reconcileStashedPromptBlocks(db, events,
      userId,
      (existing.prompt_order || []) as PromptBlock[],
      input.prompt_order as PromptBlock[],
    );
    reconciledPromptOrder = reconciliation.blocks;
    changedStashIds = reconciliation.changedStashIds;
    commitStashReconciliation = reconciliation.commit;
  }

  const fields: string[] = [];
  const values: any[] = [];

  // Orphan-GC: if prompt_order or metadata is being written, re-derive a cleaned
  // metadata.promptVariables so stale values (orphaned by a removed def) don't stick.
  // When prompt_order changes alone, persist the cleaned metadata even if the
  // caller didn't touch it — otherwise the orphans would live forever.
  let writeMetadata: Record<string, any> | undefined;
  if (input.metadata !== undefined) {
    const resolvedOrder = reconciledPromptOrder !== undefined ? reconciledPromptOrder : existing.prompt_order;
    writeMetadata = (prunePromptVariableOrphans(resolvedOrder, input.metadata) as Record<string, any>) ?? input.metadata;
  } else if (reconciledPromptOrder !== undefined) {
    const cleaned = prunePromptVariableOrphans(reconciledPromptOrder, existing.metadata as Record<string, unknown>);
    if (cleaned && JSON.stringify(cleaned) !== JSON.stringify(existing.metadata)) {
      writeMetadata = cleaned as Record<string, any>;
    }
  }

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.provider !== undefined) { fields.push("provider = ?"); values.push(input.provider); }
  if (input.engine !== undefined) { fields.push("engine = ?"); values.push(input.engine); }
  if (input.parameters !== undefined) { fields.push("parameters = ?"); values.push(JSON.stringify(input.parameters)); }
  if (reconciledPromptOrder !== undefined) { fields.push("prompt_order = ?"); values.push(JSON.stringify(reconciledPromptOrder)); }
  if (input.prompts !== undefined) { fields.push("prompts = ?"); values.push(JSON.stringify(input.prompts)); }
  if (writeMetadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(writeMetadata)); }

  const expectedCacheRevision = input.expected_cache_revision;
  if (fields.length === 0) {
    if (expectedCacheRevision !== undefined && expectedCacheRevision !== (existing.cache_revision ?? 0)) {
      throw new PresetRevisionConflictError(id, expectedCacheRevision, existing.cache_revision ?? 0);
    }
    return existing;
  }

  fields.push("updated_at = ?", "cache_revision = cache_revision + 1");
  values.push(Math.floor(Date.now() / 1000));

  const where = ["id = ?", "user_id = ?"];
  values.push(id, userId);
  if (expectedCacheRevision !== undefined) {
    where.push("cache_revision = ?");
    values.push(expectedCacheRevision);
  }

  const changes = db
    .query(`UPDATE presets SET ${fields.join(", ")} WHERE ${where.join(" AND ")}`)
    .run(...values)
    .changes;
  if (changes === 0) {
    // A conditional miss is either a deleted row (the normal not-found result)
    // or a stale writer. Read the current revision only after the atomic update
    // has failed so the distinction cannot race the mutation itself.
    const current = getPresetWithDb(db, userId, id);
    if (!current) return null;
    if (expectedCacheRevision !== undefined) {
      throw new PresetRevisionConflictError(id, expectedCacheRevision, current.cache_revision ?? 0);
    }
    return null;
  }

  const updated = getPresetWithDb(db, userId, id);
  if (!updated) return null;
  commitStashReconciliation?.();
  syncStashedBlocksAcrossPresets(db, events, userId, id, changedStashIds);
  events.push({ type: EventType.PRESET_CHANGED, payload: { id, preset: updated } });
  return updated;
}

function deletePreset(db: Database, events: PresetDatabaseEvent[], userId: string, id: string): boolean {
  const existing = getPresetWithDb(db, userId, id);
  if (!existing) return false;
  const illarinWorkId = getIllarinPresetWorkId(existing.metadata);

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
  deleteRegexScriptsByPresetIdWithEvents(db, events, userId, id);

  const deleted = db.query("DELETE FROM presets WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
  if (!deleted) return false;

  // Preserve a usable active selection for the next page load. This also
  // repairs stale selections left behind by older versions that did not
  // update the setting when a preset was removed.
  reconcileActiveLoomPreset(db, events, userId);

  // Clean up preset_profile bindings (setting-keyed, no FK) that referenced
  // the now-deleted preset. Covers defaults, per-character, per-chat, and
  // per-connection profile bindings.
  for (const s of getAllSettingsWithDb(db, userId)) {
    if (s.key !== "presetProfileDefaults"
      && !s.key.startsWith("presetProfileDefaults:")
      && !s.key.startsWith("presetProfile:character:")
      && !s.key.startsWith("presetProfile:chat:")
      && !s.key.startsWith("presetProfile:connection:")) continue;
    if (s.value && typeof s.value === "object" && (s.value as any).preset_id === id) {
      deleteSettingWithDb(db, userId, s.key);
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
    events.push({ type: EventType.CONNECTION_PROFILE_LOADED, payload: { id: connId, profile } });
  }

  events.push({ type: EventType.PRESET_DELETED, payload: { id, ...(illarinWorkId ? { illarinWorkId } : {}) } });
  return true;
}

function reconcileActiveLoomPreset(db: Database, events: PresetDatabaseEvent[], userId: string): string | null {
  const setting = getSettingWithDb(db, userId, ACTIVE_LOOM_PRESET_SETTING);
  const selectedId = typeof setting?.value === "string" && setting.value.trim()
    ? setting.value
    : null;

  if (selectedId && getPresetWithDb(db, userId, selectedId)) return selectedId;
  if (!selectedId) return null;

  const replacement = db
    .query(
      `SELECT id FROM presets
       WHERE user_id = ? AND provider = 'loom'
       ORDER BY updated_at DESC, created_at DESC, id ASC
       LIMIT 1`,
    )
    .get(userId) as { id: string } | null;
  const replacementId = replacement?.id ?? null;
  putSettingWithDb(db, events, userId, ACTIVE_LOOM_PRESET_SETTING, replacementId);
  return replacementId;
}

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

function listPromptStash(db: Database, events: PresetDatabaseEvent[], userId: string): StashedPromptBlock[] {
  return readStash(db, events, userId).sort((a, b) => b.updatedAt - a.updatedAt);
}

function addPromptBlockToStash(db: Database, events: PresetDatabaseEvent[],
  userId: string,
  block: PromptBlock,
  sourcePreset?: { id: string; name: string },
): StashedPromptBlock {
  if (block.marker) throw new Error("Only prompt blocks can be added to the stash");
  const entries = readStash(db, events, userId);
  if (entries.length >= MAX_STASH_ENTRIES) throw new Error(`Prompt stash is limited to ${MAX_STASH_ENTRIES} blocks`);
  const now = Date.now();
  const entry: StashedPromptBlock = {
    id: crypto.randomUUID(),
    block: payloadFromBlock(block),
    ...(sourcePreset ? { sourcePreset } : {}),
    createdAt: now,
    updatedAt: now,
  };
  entries.push(entry);
  putSettingWithDb(db, events, userId, STASH_SETTING_KEY, entries);
  return entry;
}

function removePromptBlockFromStash(db: Database, events: PresetDatabaseEvent[], userId: string, stashId: string): boolean {
  const entries = readStash(db, events, userId);
  if (!entries.some((entry) => entry.id === stashId)) return false;
  const remaining = entries.filter((entry) => entry.id !== stashId);
  const rows = db.query("SELECT id, prompt_order FROM presets WHERE user_id = ?").all(userId) as Array<{ id: string; prompt_order: string }>;
  const changedPresetIds: string[] = [];
  const update = db.query(
    "UPDATE presets SET prompt_order = ?, updated_at = ?, cache_revision = cache_revision + 1 WHERE id = ? AND user_id = ?",
  );
  const now = Math.floor(Date.now() / 1000);
  const transaction = db.transaction(() => {
    for (const row of rows) {
      let blocks: PromptBlock[];
      try { blocks = JSON.parse(row.prompt_order); } catch { continue; }
      if (!Array.isArray(blocks)) continue;
      let didChange = false;
      const next = blocks.map((block) => {
        if (block?.stashId !== stashId) return block;
        didChange = true;
        const { stashId: _stashId, ...unlinked } = block;
        return unlinked;
      });
      if (!didChange) continue;
      update.run(JSON.stringify(next), now, row.id, userId);
      changedPresetIds.push(row.id);
    }
  });
  transaction();
  putSettingWithDb(db, events, userId, STASH_SETTING_KEY, remaining);
  emitPresetChanges(db, events, userId, changedPresetIds);
  return true;
}

function readStash(db: Database, events: PresetDatabaseEvent[], userId: string): StashedPromptBlock[] {
  const raw = getSettingWithDb(db, userId, STASH_SETTING_KEY)?.value;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeStoredEntry).filter((entry): entry is StashedPromptBlock => entry !== null);
}

function reconcileStashedPromptBlocks(db: Database, events: PresetDatabaseEvent[],
  userId: string,
  existingBlocks: PromptBlock[],
  incomingBlocks: PromptBlock[],
): StashReconciliation {
  const entries = readStash(db, events, userId);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const existingByBlockId = new Map(existingBlocks.map((block) => [block.id, block]));
  const changed = new Set<string>();

  for (const block of incomingBlocks) {
    if (!block.stashId || block.marker) continue;
    const entry = byId.get(block.stashId);
    const previous = existingByBlockId.get(block.id);
    if (!entry || !previous || previous.stashId !== block.stashId) continue;
    const nextPayload = payloadFromBlock(block);
    const previousPayload = payloadFromBlock(previous);
    if (!samePayload(nextPayload, previousPayload) && !samePayload(nextPayload, entry.block)) {
      entry.block = nextPayload;
      entry.updatedAt = Date.now();
      changed.add(entry.id);
    }
  }

  return {
    blocks: incomingBlocks.map((block) => {
      const entry = block.stashId ? byId.get(block.stashId) : undefined;
      return entry && !block.marker
        ? { ...entry.block, id: block.id, enabled: block.enabled, group: block.group ?? null, stashId: entry.id }
        : block;
    }),
    changedStashIds: [...changed],
    commit: () => {
      if (changed.size > 0) putSettingWithDb(db, events, userId, STASH_SETTING_KEY, entries);
    },
  };
}

function syncStashedBlocksAcrossPresets(db: Database, events: PresetDatabaseEvent[], userId: string, excludedPresetId: string, stashIds: string[]): void {
  if (stashIds.length === 0) return;
  const entries = new Map(readStash(db, events, userId).map((entry) => [entry.id, entry]));
  const wanted = new Set(stashIds);
  const rows = db.query("SELECT id, prompt_order FROM presets WHERE user_id = ? AND id != ?").all(userId, excludedPresetId) as Array<{ id: string; prompt_order: string }>;
  const changedPresetIds: string[] = [];
  const update = db.query(
    "UPDATE presets SET prompt_order = ?, updated_at = ?, cache_revision = cache_revision + 1 WHERE id = ? AND user_id = ?",
  );
  const now = Math.floor(Date.now() / 1000);

  const transaction = db.transaction(() => {
    for (const row of rows) {
      let blocks: PromptBlock[];
      try { blocks = JSON.parse(row.prompt_order); } catch { continue; }
      if (!Array.isArray(blocks)) continue;
      let didChange = false;
      const next = blocks.map((block) => {
        if (!block?.stashId || !wanted.has(block.stashId)) return block;
        const entry = entries.get(block.stashId);
        if (!entry || block.marker) return block;
        const synced = { ...entry.block, id: block.id, enabled: !!block.enabled, group: block.group ?? null, stashId: entry.id };
        if (!samePayload(payloadFromBlock(block), entry.block)) didChange = true;
        return synced;
      });
      if (!didChange) continue;
      update.run(JSON.stringify(next), now, row.id, userId);
      changedPresetIds.push(row.id);
    }
  });
  transaction();

  emitPresetChanges(db, events, userId, changedPresetIds);
}

function emitPresetChanges(db: Database, events: PresetDatabaseEvent[], userId: string, presetIds: string[]): void {
  for (const presetId of presetIds) {
    const row = db.query("SELECT * FROM presets WHERE id = ? AND user_id = ?").get(presetId, userId) as any;
    if (!row) continue;
    const preset: Preset = {
      id: row.id, name: row.name, provider: row.provider, engine: row.engine,
      parameters: JSON.parse(row.parameters), prompt_order: JSON.parse(row.prompt_order),
      prompts: JSON.parse(row.prompts), metadata: JSON.parse(row.metadata),
      cache_revision: row.cache_revision ?? 0, created_at: row.created_at, updated_at: row.updated_at,
    };
    events.push({ type: EventType.PRESET_CHANGED, payload: { id: presetId, preset } });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeStoredEntry(value: unknown): StashedPromptBlock | null {
  if (!isObject(value) || typeof value.id !== "string" || !value.id.trim() || !isObject(value.block)) return null;
  const block = value.block as StashBlockPayload;
  if (typeof block.name !== "string" || typeof block.content !== "string") return null;
  return {
    id: value.id,
    block: { ...block, marker: null },
    ...(isObject(value.sourcePreset)
      && typeof value.sourcePreset.id === "string"
      && typeof value.sourcePreset.name === "string"
      ? { sourcePreset: { id: value.sourcePreset.id, name: value.sourcePreset.name } }
      : {}),
    createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  };
}

function payloadFromBlock(block: PromptBlock): StashBlockPayload {
  const { id: _id, enabled: _enabled, group: _group, stashId: _stashId, ...payload } = block;
  // Stash holds prompt blocks only. Markers are structural and cannot safely
  // be reused independently in another preset.
  return { ...payload, marker: null };
}

function samePayload(left: StashBlockPayload, right: StashBlockPayload): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
const mutations = { createPreset, updatePreset, deletePreset, reconcileActiveLoomPreset, listPromptStash, addPromptBlockToStash, removePromptBlockFromStash };
type MutationArguments<F> = F extends (db: Database, events: PresetDatabaseEvent[], ...args: infer A) => unknown ? A : never;
export type PresetMutation = { [K in keyof typeof mutations]: { action: K; args: MutationArguments<(typeof mutations)[K]> } }[keyof typeof mutations];
export interface PresetMutationResult { value?: unknown; events: PresetDatabaseEvent[]; conflict?: { id: string; expected: number; actual: number } }
export function mutatePresetWithDb(db: Database, mutation: PresetMutation): PresetMutationResult {
  try {
    return db.transaction(() => {
      const events: PresetDatabaseEvent[] = [];
      let value: unknown;
      switch (mutation.action) {
        case "createPreset": value = createPreset(db, events, ...mutation.args); break;
        case "updatePreset": value = updatePreset(db, events, ...mutation.args); break;
        case "deletePreset": value = deletePreset(db, events, ...mutation.args); break;
        case "reconcileActiveLoomPreset": value = reconcileActiveLoomPreset(db, events, ...mutation.args); break;
        case "listPromptStash": value = listPromptStash(db, events, ...mutation.args); break;
        case "addPromptBlockToStash": value = addPromptBlockToStash(db, events, ...mutation.args); break;
        case "removePromptBlockFromStash": value = removePromptBlockFromStash(db, events, ...mutation.args); break;
      }
      return { value, events };
    }).immediate();
  } catch (error) {
    if (error instanceof PresetRevisionConflictError) return { events: [], conflict: { id: error.presetId, expected: error.expectedCacheRevision, actual: error.actualCacheRevision } };
    throw error;
  }
}

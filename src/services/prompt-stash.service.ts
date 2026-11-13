import { PresetRevisionConflictError } from "../types/preset";
import { executeDatabaseOperation } from "../db/execution";
import { mutatePresetWithDb, type PresetMutationResult } from "../db/preset-operations";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Preset, PromptBlock } from "../types/preset";
import * as settingsSvc from "./settings.service";

const STASH_SETTING_KEY = "loomPromptStash";
const MAX_STASH_ENTRIES = 500;

export interface StashedPromptBlock {
  id: string;
  block: Omit<PromptBlock, "id" | "enabled" | "group" | "stashId">;
  sourcePreset?: { id: string; name: string };
  createdAt: number;
  updatedAt: number;
}

type StashBlockPayload = StashedPromptBlock["block"];

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

function readStash(userId: string): StashedPromptBlock[] {
  const raw = settingsSvc.getSetting(userId, STASH_SETTING_KEY)?.value;
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeStoredEntry).filter((entry): entry is StashedPromptBlock => entry !== null);
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

export function listPromptStash(userId: string): StashedPromptBlock[] {
  return finishPresetMutation(mutatePresetWithDb(getDb(), { action: "listPromptStash", args: [userId] }), userId);
}

export async function listPromptStashAsync(userId: string): Promise<StashedPromptBlock[]> {
  const result = await executeDatabaseOperation<PresetMutationResult>({ kind: "preset-mutation", mutation: { action: "listPromptStash", args: [userId] } });
  return finishPresetMutation(result, userId);
}

export function addPromptBlockToStash(
  userId: string,
  block: PromptBlock,
  sourcePreset?: { id: string; name: string },
): StashedPromptBlock {
  return finishPresetMutation(mutatePresetWithDb(getDb(), { action: "addPromptBlockToStash", args: [userId, block, sourcePreset] }), userId);
}

export async function addPromptBlockToStashAsync(
  userId: string,
  block: PromptBlock,
  sourcePreset?: { id: string; name: string },
): Promise<StashedPromptBlock> {
  const result = await executeDatabaseOperation<PresetMutationResult>({ kind: "preset-mutation", mutation: { action: "addPromptBlockToStash", args: [userId, block, sourcePreset] } });
  return finishPresetMutation(result, userId);
}

/**
 * Remove a stash entry and turn every linked copy back into an independent
 * block. The blocks remain in their presets, retaining their local visibility
 * and placement, so un-stashing never discards prompt content.
 */
export function removePromptBlockFromStash(userId: string, stashId: string): boolean {
  return finishPresetMutation(mutatePresetWithDb(getDb(), { action: "removePromptBlockFromStash", args: [userId, stashId] }), userId);
}

export async function removePromptBlockFromStashAsync(userId: string, stashId: string): Promise<boolean> {
  const result = await executeDatabaseOperation<PresetMutationResult>({ kind: "preset-mutation", mutation: { action: "removePromptBlockFromStash", args: [userId, stashId] } });
  return finishPresetMutation(result, userId);
}

function emitPresetChanges(userId: string, presetIds: string[]): void {
  const db = getDb();
  for (const presetId of presetIds) {
    const row = db.query("SELECT * FROM presets WHERE id = ? AND user_id = ?").get(presetId, userId) as any;
    if (!row) continue;
    const preset: Preset = {
      id: row.id, name: row.name, provider: row.provider, engine: row.engine,
      parameters: JSON.parse(row.parameters), prompt_order: JSON.parse(row.prompt_order),
      prompts: JSON.parse(row.prompts), metadata: JSON.parse(row.metadata),
      cache_revision: row.cache_revision ?? 0, created_at: row.created_at, updated_at: row.updated_at,
    };
    eventBus.emit(EventType.PRESET_CHANGED, { id: presetId, preset }, userId);
  }
}

/** Create a new local block from a stash entry. Visibility and grouping stay local. */
export function blockFromStash(entry: StashedPromptBlock): PromptBlock {
  return {
    ...entry.block,
    id: crypto.randomUUID(),
    enabled: true,
    group: null,
    stashId: entry.id,
  };
}

export interface StashReconciliation {
  blocks: PromptBlock[];
  changedStashIds: string[];
  /** Persist canonical stash edits only after the enclosing preset save succeeds. */
  commit(): void;
}

/**
 * Merge canonical stashed fields into an incoming preset save. An incoming
 * edit only updates its stash entry when it differs from that preset's last
 * persisted copy; toggling visibility/reordering therefore cannot overwrite a
 * newer global edit made in another preset.
 */
export function reconcileStashedPromptBlocks(
  userId: string,
  existingBlocks: PromptBlock[],
  incomingBlocks: PromptBlock[],
): StashReconciliation {
  const entries = readStash(userId);
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
      if (changed.size > 0) settingsSvc.putSetting(userId, STASH_SETTING_KEY, entries);
    },
  };
}

/** Propagate canonical stash fields to all other copies, preserving local visibility and grouping. */
export function syncStashedBlocksAcrossPresets(userId: string, excludedPresetId: string, stashIds: string[]): void {
  if (stashIds.length === 0) return;
  const entries = new Map(readStash(userId).map((entry) => [entry.id, entry]));
  const wanted = new Set(stashIds);
  const db = getDb();
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

  emitPresetChanges(userId, changedPresetIds);
}

function finishPresetMutation<T>(result: PresetMutationResult, userId: string): T {
  if (result.conflict) throw new PresetRevisionConflictError(result.conflict.id, result.conflict.expected, result.conflict.actual);
  for (const event of result.events) eventBus.emit(event.type, event.payload, userId);
  return result.value as T;
}

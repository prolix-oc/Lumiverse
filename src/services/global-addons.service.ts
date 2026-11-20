import { executeDatabaseOperation } from "../db/execution";
import { readDatabaseRow, readDatabaseRows } from "../db/queries";
import { mutateGlobalAddonWithDb, rowToGlobalAddon, type GlobalAddonEvent } from "../db/global-addon-operations";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { GlobalAddon, CreateGlobalAddonInput, UpdateGlobalAddonInput, Persona } from "../types/persona";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery, paginatedQueryAsync } from "./pagination";



export function listGlobalAddons(userId: string, pagination: PaginationParams): PaginatedResult<GlobalAddon> {
  return paginatedQuery(
    "SELECT * FROM global_addons WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC",
    "SELECT COUNT(*) as count FROM global_addons WHERE user_id = ?",
    [userId],
    pagination,
    rowToGlobalAddon
  );
}

export function getGlobalAddon(userId: string, id: string): GlobalAddon | null {
  const row = getDb().query("SELECT * FROM global_addons WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToGlobalAddon(row);
}

export function getGlobalAddonsByIds(userId: string, ids: string[]): GlobalAddon[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .query(`SELECT * FROM global_addons WHERE id IN (${placeholders}) AND user_id = ? ORDER BY sort_order ASC`)
    .all(...ids, userId) as any[];
  return rows.map(rowToGlobalAddon);
}

/**
 * Inject the persona's enabled attached global add-ons into its metadata as
 * `_resolvedGlobalAddons`, which MacroEnv's `buildPersonaWithAddons` reads when
 * expanding the `{{persona}}` macro. Persona-specific (local) add-ons live on
 * the persona row itself and need no resolution, but global add-ons are stored
 * by reference and must be joined in here — so every macro-env construction
 * site (generation, macro preview, display regex, chat-memory, image-gen,
 * Spindle) must run a persona through this before `buildEnv` or `{{persona}}`
 * silently drops global add-ons while still rendering local ones.
 *
 * Apply persona add-on enabled/disabled states (see `applyPersonaAddonStates`)
 * BEFORE calling this so toggled-off globals are excluded. Returns the persona
 * unchanged when nothing is attached/enabled.
 */
export function resolvePersonaGlobalAddons(
  userId: string,
  persona: Persona | null,
): Persona | null {
  if (!persona) return persona;
  const attachedRefs =
    (persona.metadata?.attached_global_addons as Array<{
      id: string;
      enabled: boolean;
    }>) ?? [];
  const enabledIds = attachedRefs.filter((a) => a.enabled).map((a) => a.id);
  if (enabledIds.length === 0) return persona;
  const resolved = getGlobalAddonsByIds(userId, enabledIds);
  return {
    ...persona,
    metadata: { ...persona.metadata, _resolvedGlobalAddons: resolved },
  };
}

export function createGlobalAddon(userId: string, input: CreateGlobalAddonInput): GlobalAddon {
  return finishGlobalAddonMutation(mutateGlobalAddonWithDb(getDb(), { action: "createGlobalAddon", args: [userId, input] }), userId);
}

export async function createGlobalAddonAsync(userId: string, input: CreateGlobalAddonInput): Promise<GlobalAddon> {
  const result = await executeDatabaseOperation<GlobalAddonMutationResult>({ kind: "global-addon-mutation", mutation: { action: "createGlobalAddon", args: [userId, input] } });
  return finishGlobalAddonMutation(result, userId);
}

export function updateGlobalAddon(userId: string, id: string, input: UpdateGlobalAddonInput): GlobalAddon | null {
  return finishGlobalAddonMutation(mutateGlobalAddonWithDb(getDb(), { action: "updateGlobalAddon", args: [userId, id, input] }), userId);
}

export async function updateGlobalAddonAsync(userId: string, id: string, input: UpdateGlobalAddonInput): Promise<GlobalAddon | null> {
  const result = await executeDatabaseOperation<GlobalAddonMutationResult>({ kind: "global-addon-mutation", mutation: { action: "updateGlobalAddon", args: [userId, id, input] } });
  return finishGlobalAddonMutation(result, userId);
}

export function deleteGlobalAddon(userId: string, id: string): boolean {
  return finishGlobalAddonMutation(mutateGlobalAddonWithDb(getDb(), { action: "deleteGlobalAddon", args: [userId, id] }), userId);
}

export async function deleteGlobalAddonAsync(userId: string, id: string): Promise<boolean> {
  const result = await executeDatabaseOperation<GlobalAddonMutationResult>({ kind: "global-addon-mutation", mutation: { action: "deleteGlobalAddon", args: [userId, id] } });
  return finishGlobalAddonMutation(result, userId);
}

export function duplicateGlobalAddon(userId: string, id: string): GlobalAddon | null {
  return finishGlobalAddonMutation(mutateGlobalAddonWithDb(getDb(), { action: "duplicateGlobalAddon", args: [userId, id] }), userId);
}

export async function duplicateGlobalAddonAsync(userId: string, id: string): Promise<GlobalAddon | null> {
  const result = await executeDatabaseOperation<GlobalAddonMutationResult>({ kind: "global-addon-mutation", mutation: { action: "duplicateGlobalAddon", args: [userId, id] } });
  return finishGlobalAddonMutation(result, userId);
}

export function reorderGlobalAddons(userId: string, ids: string[]): void {
  return finishGlobalAddonMutation(mutateGlobalAddonWithDb(getDb(), { action: "reorderGlobalAddons", args: [userId, ids] }), userId);
}

export async function reorderGlobalAddonsAsync(userId: string, ids: string[]): Promise<void> {
  const result = await executeDatabaseOperation<GlobalAddonMutationResult>({ kind: "global-addon-mutation", mutation: { action: "reorderGlobalAddons", args: [userId, ids] } });
  return finishGlobalAddonMutation(result, userId);
}



type GlobalAddonMutationResult = { value: unknown; events: GlobalAddonEvent[] };
function finishGlobalAddonMutation<T>(result: GlobalAddonMutationResult, userId: string): T {
  for (const event of result.events) {
    if (event.type === "addon-changed") eventBus.emit(EventType.GLOBAL_ADDON_CHANGED, { id: event.id, addon: event.addon }, userId);
    else if (event.type === "addon-deleted") eventBus.emit(EventType.GLOBAL_ADDON_DELETED, { id: event.id }, userId);
    else eventBus.emit(EventType.PERSONA_CHANGED, { id: event.id }, userId);
  }
  return result.value as T;
}
export async function listGlobalAddonsAsync(userId: string, pagination: PaginationParams): Promise<PaginatedResult<GlobalAddon>> {
  return paginatedQueryAsync("SELECT * FROM global_addons WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC", "SELECT COUNT(*) as count FROM global_addons WHERE user_id = ?", [userId], pagination, rowToGlobalAddon);
}
export async function getGlobalAddonAsync(userId: string, id: string): Promise<GlobalAddon | null> {
  const row = await readDatabaseRow<any>("SELECT * FROM global_addons WHERE id = ? AND user_id = ?", [id, userId]);
  return row ? rowToGlobalAddon(row) : null;
}
export async function getGlobalAddonsByIdsAsync(userId: string, ids: string[]): Promise<GlobalAddon[]> {
  if (ids.length === 0) return [];
  const rows = await readDatabaseRows<any>(`SELECT * FROM global_addons WHERE id IN (${ids.map(() => "?").join(",")}) AND user_id = ? ORDER BY sort_order ASC`, [...ids, userId]);
  return rows.map(rowToGlobalAddon);
}
export async function resolvePersonaGlobalAddonsAsync(userId: string, persona: Persona | null): Promise<Persona | null> {
  if (!persona) return persona;
  const refs = (persona.metadata?.attached_global_addons as Array<{ id: string; enabled: boolean }>) ?? [];
  const ids = refs.filter((ref) => ref.enabled).map((ref) => ref.id);
  if (ids.length === 0) return persona;
  return { ...persona, metadata: { ...persona.metadata, _resolvedGlobalAddons: await getGlobalAddonsByIdsAsync(userId, ids) } };
}

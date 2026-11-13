import { mutatePersonaWithDb, rowToPersona } from "../db/persona-operations";
import { readDatabaseRow, readDatabaseRows } from "../db/queries";
import { executeDatabaseOperation } from "../db/execution";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Persona, CreatePersonaInput, UpdatePersonaInput } from "../types/persona";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery, paginatedQueryAsync } from "./pagination";
import { getSetting as getUserSetting, getSettingAsync as getUserSettingAsync } from "./settings.service";
import {
  resolvePersonaAvatarInfo,
  type PersonaAddonStateMap,
  type PersonaAddonToggleOrder,
  type PersonaAvatarInfo,
} from "./persona-addon-states";


export function listPersonas(userId: string, pagination: PaginationParams): PaginatedResult<Persona> {
  return paginatedQuery(
    "SELECT * FROM personas WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM personas WHERE user_id = ?",
    [userId],
    pagination,
    rowToPersona
  );
}

export function getPersona(userId: string, id: string): Persona | null {
  const row = getDb().query("SELECT * FROM personas WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToPersona(row);
}

export function getPersonaAvatarInfo(
  userId: string,
  id: string,
  options: {
    addonStates?: PersonaAddonStateMap;
    addonToggleOrder?: PersonaAddonToggleOrder;
  } = {},
): PersonaAvatarInfo | null {
  return resolvePersonaAvatarInfo(
    getPersona(userId, id),
    options.addonStates,
    options.addonToggleOrder,
  );
}

export function createPersona(userId: string, input: CreatePersonaInput): Persona {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "createPersona", args: [userId, input] }), userId);
}

export async function createPersonaAsync(userId: string, input: CreatePersonaInput): Promise<Persona> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "createPersona", args: [userId, input] } });
  return finishPersonaMutation(result, userId);
}

/** Load SillyTavern persona identities once so reruns stay linear. */
export function listPersonaSourceFilenameIds(userId: string): Map<string, { id: string; name: string }> {
  const rows = getDb()
    .query(
      `SELECT id, name, json_extract(metadata, '$._lumiverse_source_filename') AS source_filename
       FROM personas
       WHERE user_id = ?
         AND json_type(metadata, '$._lumiverse_source_filename') = 'text'
       ORDER BY updated_at ASC`,
    )
    .all(userId) as Array<{ id: string; name: string; source_filename: string }>;

  const result = new Map<string, { id: string; name: string }>();
  for (const row of rows) result.set(row.source_filename, { id: row.id, name: row.name });
  return result;
}

export function updatePersona(userId: string, id: string, input: UpdatePersonaInput): Persona | null {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "updatePersona", args: [userId, id, input] }), userId);
}

export async function updatePersonaAsync(userId: string, id: string, input: UpdatePersonaInput): Promise<Persona | null> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "updatePersona", args: [userId, id, input] } });
  return finishPersonaMutation(result, userId);
}

export function renamePersonaFolder(userId: string, oldName: string, newName: string): Persona[] {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "renamePersonaFolder", args: [userId, oldName, newName] }), userId);
}

export async function renamePersonaFolderAsync(userId: string, oldName: string, newName: string): Promise<Persona[]> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "renamePersonaFolder", args: [userId, oldName, newName] } });
  return finishPersonaMutation(result, userId);
}

export function deletePersonaFolder(userId: string, name: string): Persona[] {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "deletePersonaFolder", args: [userId, name] }), userId);
}

export async function deletePersonaFolderAsync(userId: string, name: string): Promise<Persona[]> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "deletePersonaFolder", args: [userId, name] } });
  return finishPersonaMutation(result, userId);
}

export function isPersonaAvatarPathReferenced(userId: string, avatarPath: string): boolean {
  return !!getDb()
    .query("SELECT 1 FROM personas WHERE user_id = ? AND avatar_path = ? LIMIT 1")
    .get(userId, avatarPath);
}

export interface BulkPersonaUpdateInput {
  folder?: string;
  attached_world_book_id?: string | null;
  toggle_narrator?: boolean;
}

export function bulkUpdatePersonas(
  userId: string,
  ids: string[],
  input: BulkPersonaUpdateInput
): Persona[] {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "bulkUpdatePersonas", args: [userId, ids, input] }), userId);
}

export async function bulkUpdatePersonasAsync(
  userId: string,
  ids: string[],
  input: BulkPersonaUpdateInput
): Promise<Persona[]> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "bulkUpdatePersonas", args: [userId, ids, input] } });
  return finishPersonaMutation(result, userId);
}

export function setPersonaAvatar(userId: string, id: string, avatarPath: string): boolean {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "setPersonaAvatar", args: [userId, id, avatarPath] }), userId);
}

export async function setPersonaAvatarAsync(userId: string, id: string, avatarPath: string): Promise<boolean> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "setPersonaAvatar", args: [userId, id, avatarPath] } });
  return finishPersonaMutation(result, userId);
}

export function setPersonaImage(userId: string, id: string, imageId: string): boolean {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "setPersonaImage", args: [userId, id, imageId] }), userId);
}

export async function setPersonaImageAsync(userId: string, id: string, imageId: string): Promise<boolean> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "setPersonaImage", args: [userId, id, imageId] } });
  return finishPersonaMutation(result, userId);
}

/**
 * Attach or clear a persona-specific avatar override for an add-on. The image
 * lives on the persona's add-on reference, including attached global add-ons,
 * so a shared global add-on never dictates another persona's appearance.
 */
export function setPersonaAddonAvatar(
  userId: string,
  personaId: string,
  addonId: string,
  avatar: { image_id: string | null; avatar_crop_image_id?: string | null },
): Persona | null {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "setPersonaAddonAvatar", args: [userId, personaId, addonId, avatar] }), userId);
}

export async function setPersonaAddonAvatarAsync(
  userId: string,
  personaId: string,
  addonId: string,
  avatar: { image_id: string | null; avatar_crop_image_id?: string | null },
): Promise<Persona | null> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "setPersonaAddonAvatar", args: [userId, personaId, addonId, avatar] } });
  return finishPersonaMutation(result, userId);
}

export function duplicatePersona(userId: string, id: string): Persona | null {
  return finishPersonaMutation(mutatePersonaWithDb(getDb(), { action: "duplicatePersona", args: [userId, id] }), userId);
}

export async function duplicatePersonaAsync(userId: string, id: string): Promise<Persona | null> {
  const result = await executeDatabaseOperation<PersonaMutationResult>({ kind: "persona-mutation", mutation: { action: "duplicatePersona", args: [userId, id] } });
  return finishPersonaMutation(result, userId);
}

export function getDefaultPersona(userId: string): Persona | null {
  const row = getDb().query("SELECT * FROM personas WHERE is_default = 1 AND user_id = ? LIMIT 1").get(userId) as any;
  if (!row) return null;
  return rowToPersona(row);
}

export function resolvePersonaOrDefault(userId: string, personaId?: string | null): Persona | null {
  if (personaId) {
    const requested = getPersona(userId, personaId);
    if (requested) return requested;
  }
  try {
    const active = getUserSetting(userId, "activePersonaId");
    if (active && typeof active.value === "string" && active.value.length > 0) {
      const fromSetting = getPersona(userId, active.value);
      if (fromSetting) return fromSetting;
    }
  } catch { /* */ }
  return getDefaultPersona(userId);
}

export function deletePersona(userId: string, id: string): boolean {
  const result = getDb().query("DELETE FROM personas WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.PERSONA_CHANGED, { id, deleted: true }, userId);
  }
  return result.changes > 0;
}

export async function deletePersonaAsync(userId: string, id: string): Promise<boolean> {
  const [result] = await executeDatabaseOperation<[{ changes: number }]>({
    kind: "transaction", statements: [{ sql: "DELETE FROM personas WHERE id = ? AND user_id = ?", bindings: [id, userId] }],
  });
  if (result.changes > 0) eventBus.emit(EventType.PERSONA_CHANGED, { id, deleted: true }, userId);
  return result.changes > 0;
}

type PersonaMutationResult = { value: unknown; changed: Persona[] };
function finishPersonaMutation<T>(result: PersonaMutationResult, userId: string): T {
  for (const persona of result.changed) eventBus.emit(EventType.PERSONA_CHANGED, { id: persona.id, persona }, userId);
  return result.value as T;
}

export async function listPersonasAsync(userId: string, pagination: PaginationParams): Promise<PaginatedResult<Persona>> {
  return paginatedQueryAsync("SELECT * FROM personas WHERE user_id = ? ORDER BY updated_at DESC", "SELECT COUNT(*) as count FROM personas WHERE user_id = ?", [userId], pagination, rowToPersona);
}
export async function getPersonaAsync(userId: string, id: string): Promise<Persona | null> {
  const row = await readDatabaseRow<any>("SELECT * FROM personas WHERE id = ? AND user_id = ?", [id, userId]);
  return row ? rowToPersona(row) : null;
}
export async function getPersonasByIdsAsync(userId: string, ids: string[]): Promise<Persona[]> {
  const rows = new Map<string, Persona>();
  const uniqueIds = [...new Set(ids)];
  for (let i = 0; i < uniqueIds.length; i += 400) {
    const chunk = uniqueIds.slice(i, i + 400);
    const page = await readDatabaseRows<any>(`SELECT * FROM personas WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(",")})`, [userId, ...chunk]);
    for (const row of page) rows.set(row.id, rowToPersona(row));
  }
  return ids.flatMap((id) => rows.has(id) ? [rows.get(id)!] : []);
}
export async function getDefaultPersonaAsync(userId: string): Promise<Persona | null> {
  const row = await readDatabaseRow<any>("SELECT * FROM personas WHERE is_default = 1 AND user_id = ? LIMIT 1", [userId]);
  return row ? rowToPersona(row) : null;
}
export async function isPersonaAvatarPathReferencedAsync(userId: string, avatarPath: string): Promise<boolean> {
  return !!await readDatabaseRow("SELECT 1 FROM personas WHERE user_id = ? AND avatar_path = ? LIMIT 1", [userId, avatarPath]);
}
export async function getPersonaAvatarInfoAsync(userId: string, id: string, options: { addonStates?: PersonaAddonStateMap; addonToggleOrder?: PersonaAddonToggleOrder } = {}): Promise<PersonaAvatarInfo | null> {
  return resolvePersonaAvatarInfo(await getPersonaAsync(userId, id), options.addonStates, options.addonToggleOrder);
}
export async function resolvePersonaOrDefaultAsync(userId: string, personaId?: string | null): Promise<Persona | null> {
  if (personaId) { const requested = await getPersonaAsync(userId, personaId); if (requested) return requested; }
  const active = await getUserSettingAsync(userId, "activePersonaId");
  if (typeof active?.value === "string" && active.value.length > 0) { const persona = await getPersonaAsync(userId, active.value); if (persona) return persona; }
  return getDefaultPersonaAsync(userId);
}

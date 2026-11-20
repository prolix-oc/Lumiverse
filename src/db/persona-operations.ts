import type { Database } from "bun:sqlite";
import type { Persona, CreatePersonaInput, UpdatePersonaInput } from "../types/persona";
import type { BulkPersonaUpdateInput } from "../services/personas.service";
export function rowToPersona(row: any): Persona {
  return {
    ...row,
    title: row.title || '',
    subjective_pronoun: row.subjective_pronoun || '',
    objective_pronoun: row.objective_pronoun || '',
    possessive_pronoun: row.possessive_pronoun || '',
    reflexive_pronoun: row.reflexive_pronoun || '',
    possessive_pronoun_standalone: row.possessive_pronoun_standalone || '',
    folder: row.folder || '',
    avatar_path: row.avatar_path || null,
    image_id: row.image_id || null,
    attached_world_book_id: row.attached_world_book_id || null,
    is_default: !!row.is_default,
    is_narrator: !!row.is_narrator,
    metadata: JSON.parse(row.metadata),
  };
}

function getPersona(db: Database, userId: string, id: string): Persona | null {
  const row = db.query("SELECT * FROM personas WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToPersona(row);
}

function createPersona(db: Database, changed: Persona[], userId: string, input: CreatePersonaInput): Persona {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.transaction(() => {
    if (input.is_default) {
      db.query("UPDATE personas SET is_default = 0 WHERE is_default = 1 AND user_id = ?").run(userId);
    }
    db
      .query(
        `INSERT INTO personas (
           id, user_id, name, title, description,
           subjective_pronoun, objective_pronoun, possessive_pronoun, reflexive_pronoun, possessive_pronoun_standalone,
           folder, is_default, is_narrator, attached_world_book_id, metadata, created_at, updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        userId,
        input.name,
        input.title || "",
        input.description || "",
        input.subjective_pronoun || "",
        input.objective_pronoun || "",
        input.possessive_pronoun || "",
        input.reflexive_pronoun || "",
        input.possessive_pronoun_standalone || "",
        input.folder || "",
        input.is_default ? 1 : 0,
        input.is_narrator ? 1 : 0,
        input.attached_world_book_id || null,
        JSON.stringify(input.metadata || {}),
        now,
        now
      );
  })();

  const persona = getPersona(db, userId, id)!;
  changed.push(persona);
  return persona;
}

function updatePersona(db: Database, changed: Persona[], userId: string, id: string, input: UpdatePersonaInput): Persona | null {
  const existing = getPersona(db, userId, id);
  if (!existing) return null;

  const now = Math.floor(Date.now() / 1000);

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.title !== undefined) { fields.push("title = ?"); values.push(input.title); }
  if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
  if (input.subjective_pronoun !== undefined) { fields.push("subjective_pronoun = ?"); values.push(input.subjective_pronoun); }
  if (input.objective_pronoun !== undefined) { fields.push("objective_pronoun = ?"); values.push(input.objective_pronoun); }
  if (input.possessive_pronoun !== undefined) { fields.push("possessive_pronoun = ?"); values.push(input.possessive_pronoun); }
  if (input.reflexive_pronoun !== undefined) { fields.push("reflexive_pronoun = ?"); values.push(input.reflexive_pronoun); }
  if (input.possessive_pronoun_standalone !== undefined) { fields.push("possessive_pronoun_standalone = ?"); values.push(input.possessive_pronoun_standalone); }
  if (input.folder !== undefined) { fields.push("folder = ?"); values.push(input.folder); }
  if (input.is_default !== undefined) { fields.push("is_default = ?"); values.push(input.is_default ? 1 : 0); }
  if (input.is_narrator !== undefined) { fields.push("is_narrator = ?"); values.push(input.is_narrator ? 1 : 0); }
  if (input.attached_world_book_id !== undefined) { fields.push("attached_world_book_id = ?"); values.push(input.attached_world_book_id || null); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  values.push(userId);

  db.transaction(() => {
    if (input.is_default) {
      db.query("UPDATE personas SET is_default = 0 WHERE is_default = 1 AND user_id = ?").run(userId);
    }
    db.query(`UPDATE personas SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  })();
  const updated = getPersona(db, userId, id)!;
  changed.push(updated);
  return updated;
}

function renamePersonaFolder(db: Database, changed: Persona[], userId: string, oldName: string, newName: string): Persona[] {
  const source = oldName.trim();
  const target = newName.trim();
  if (!source || !target) return [];

  const rows = db
    .query("SELECT * FROM personas WHERE user_id = ? AND folder = ?")
    .all(userId, source) as any[];
  if (rows.length === 0) return [];

  if (source === target) {
    return rows.map(rowToPersona);
  }

  const now = Math.floor(Date.now() / 1000);
  db
    .query("UPDATE personas SET folder = ?, updated_at = ? WHERE user_id = ? AND folder = ?")
    .run(target, now, userId, source);

  const updated = rows.map((row) => rowToPersona({ ...row, folder: target, updated_at: now }));
  for (const persona of updated) {
    changed.push(persona);
  }
  return updated;
}

function deletePersonaFolder(db: Database, changed: Persona[], userId: string, name: string): Persona[] {
  const folder = name.trim();
  if (!folder) return [];

  const rows = db
    .query("SELECT * FROM personas WHERE user_id = ? AND folder = ?")
    .all(userId, folder) as any[];
  if (rows.length === 0) return [];

  const now = Math.floor(Date.now() / 1000);
  db
    .query("UPDATE personas SET folder = '', updated_at = ? WHERE user_id = ? AND folder = ?")
    .run(now, userId, folder);

  const updated = rows.map((row) => rowToPersona({ ...row, folder: '', updated_at: now }));
  for (const persona of updated) {
    changed.push(persona);
  }
  return updated;
}

function bulkUpdatePersonas(db: Database, changed: Persona[],
  userId: string,
  ids: string[],
  input: BulkPersonaUpdateInput
): Persona[] {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const updated: Persona[] = [];

  for (const id of uniqueIds) {
    const existing = getPersona(db, userId, id);
    if (!existing) continue;

    const patch: UpdatePersonaInput = {};
    if (input.folder !== undefined) patch.folder = input.folder.trim();
    if (input.attached_world_book_id !== undefined) {
      patch.attached_world_book_id = input.attached_world_book_id;
    }
    if (input.toggle_narrator) patch.is_narrator = !existing.is_narrator;

    const persona = updatePersona(db, changed, userId, id, patch);
    if (persona) updated.push(persona);
  }

  return updated;
}

function setPersonaAvatar(db: Database, changed: Persona[], userId: string, id: string, avatarPath: string): boolean {
  const result = db
    .query("UPDATE personas SET avatar_path = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(avatarPath, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

function setPersonaImage(db: Database, changed: Persona[], userId: string, id: string, imageId: string): boolean {
  const result = db
    .query("UPDATE personas SET image_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(imageId, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

function setPersonaAddonAvatar(db: Database, changed: Persona[],
  userId: string,
  personaId: string,
  addonId: string,
  avatar: { image_id: string | null; avatar_crop_image_id?: string | null },
): Persona | null {
  const existing = getPersona(db, userId, personaId);
  if (!existing) return null;

  const metadata = existing.metadata ?? {};
  let found = false;
  const updateAddons = (addons: unknown): unknown => {
    if (!Array.isArray(addons)) return addons;
    return addons.map((addon: any) => {
      if (!addon || addon.id !== addonId) return addon;
      found = true;
      const next = { ...addon };
      if (avatar.image_id) next.avatar_image_id = avatar.image_id;
      else delete next.avatar_image_id;
      if (avatar.avatar_crop_image_id) next.avatar_crop_image_id = avatar.avatar_crop_image_id;
      else delete next.avatar_crop_image_id;
      return next;
    });
  };

  const nextMetadata = {
    ...metadata,
    ...(Array.isArray(metadata.addons) ? { addons: updateAddons(metadata.addons) } : {}),
    ...(Array.isArray(metadata.attached_global_addons)
      ? { attached_global_addons: updateAddons(metadata.attached_global_addons) }
      : {}),
  };
  if (!found) return null;
  return updatePersona(db, changed, userId, personaId, { metadata: nextMetadata });
}

function duplicatePersona(db: Database, changed: Persona[], userId: string, id: string): Persona | null {
  const existing = getPersona(db, userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db
    .query(
      `INSERT INTO personas (
         id, user_id, name, title, description,
         subjective_pronoun, objective_pronoun, possessive_pronoun, reflexive_pronoun, possessive_pronoun_standalone,
         folder, avatar_path, image_id, is_default, is_narrator, attached_world_book_id, metadata, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      newId,
      userId,
      `${existing.name} (Copy)`,
      existing.title,
      existing.description,
      existing.subjective_pronoun,
      existing.objective_pronoun,
      existing.possessive_pronoun,
      existing.reflexive_pronoun,
      existing.possessive_pronoun_standalone,
      existing.folder,
      existing.avatar_path,
      existing.image_id,
      existing.is_narrator ? 1 : 0,
      existing.attached_world_book_id,
      JSON.stringify(existing.metadata),
      now,
      now
    );

  const persona = getPersona(db, userId, newId)!;
  changed.push(persona);
  return persona;
}
const mutations = { createPersona, updatePersona, renamePersonaFolder, deletePersonaFolder, bulkUpdatePersonas, setPersonaAvatar, setPersonaImage, setPersonaAddonAvatar, duplicatePersona };
type MutationArguments<F> = F extends (db: Database, changed: Persona[], ...args: infer A) => unknown ? A : never;
export type PersonaMutation = { [K in keyof typeof mutations]: { action: K; args: MutationArguments<(typeof mutations)[K]> } }[keyof typeof mutations];
export function mutatePersonaWithDb(db: Database, mutation: PersonaMutation): { value: unknown; changed: Persona[] } {
  return db.transaction(() => {
    const changed: Persona[] = [];
    let value: unknown;
    switch (mutation.action) {
      case "createPersona": value = createPersona(db, changed, ...mutation.args); break;
      case "updatePersona": value = updatePersona(db, changed, ...mutation.args); break;
      case "renamePersonaFolder": value = renamePersonaFolder(db, changed, ...mutation.args); break;
      case "deletePersonaFolder": value = deletePersonaFolder(db, changed, ...mutation.args); break;
      case "bulkUpdatePersonas": value = bulkUpdatePersonas(db, changed, ...mutation.args); break;
      case "setPersonaAvatar": value = setPersonaAvatar(db, changed, ...mutation.args); break;
      case "setPersonaImage": value = setPersonaImage(db, changed, ...mutation.args); break;
      case "setPersonaAddonAvatar": value = setPersonaAddonAvatar(db, changed, ...mutation.args); break;
      case "duplicatePersona": value = duplicatePersona(db, changed, ...mutation.args); break;
    }
    return { value, changed };
  }).immediate();
}

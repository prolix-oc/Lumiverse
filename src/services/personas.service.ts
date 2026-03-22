import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Persona, CreatePersonaInput, UpdatePersonaInput } from "../types/persona";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

function rowToPersona(row: any): Persona {
  return {
    ...row,
    title: row.title || '',
    folder: row.folder || '',
    avatar_path: row.avatar_path || null,
    image_id: row.image_id || null,
    attached_world_book_id: row.attached_world_book_id || null,
    is_default: !!row.is_default,
    metadata: JSON.parse(row.metadata),
  };
}

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

export function createPersona(userId: string, input: CreatePersonaInput): Persona {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  if (input.is_default) {
    getDb().query("UPDATE personas SET is_default = 0 WHERE is_default = 1 AND user_id = ?").run(userId);
  }

  getDb()
    .query(
      `INSERT INTO personas (id, user_id, name, title, description, folder, is_default, attached_world_book_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, userId, input.name, input.title || "", input.description || "", input.folder || "", input.is_default ? 1 : 0, input.attached_world_book_id || null, JSON.stringify(input.metadata || {}), now, now);

  const persona = getPersona(userId, id)!;
  eventBus.emit(EventType.PERSONA_CHANGED, { id, persona }, userId);
  return persona;
}

export function updatePersona(userId: string, id: string, input: UpdatePersonaInput): Persona | null {
  const existing = getPersona(userId, id);
  if (!existing) return null;

  const now = Math.floor(Date.now() / 1000);

  if (input.is_default) {
    getDb().query("UPDATE personas SET is_default = 0 WHERE is_default = 1 AND user_id = ?").run(userId);
  }

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.title !== undefined) { fields.push("title = ?"); values.push(input.title); }
  if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
  if (input.folder !== undefined) { fields.push("folder = ?"); values.push(input.folder); }
  if (input.is_default !== undefined) { fields.push("is_default = ?"); values.push(input.is_default ? 1 : 0); }
  if (input.attached_world_book_id !== undefined) { fields.push("attached_world_book_id = ?"); values.push(input.attached_world_book_id || null); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE personas SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getPersona(userId, id)!;
  eventBus.emit(EventType.PERSONA_CHANGED, { id, persona: updated }, userId);
  return updated;
}

export function setPersonaAvatar(userId: string, id: string, avatarPath: string): boolean {
  const result = getDb()
    .query("UPDATE personas SET avatar_path = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(avatarPath, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

export function setPersonaImage(userId: string, id: string, imageId: string): boolean {
  const result = getDb()
    .query("UPDATE personas SET image_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(imageId, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

export function duplicatePersona(userId: string, id: string): Persona | null {
  const existing = getPersona(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO personas (id, user_id, name, title, description, folder, avatar_path, image_id, is_default, attached_world_book_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
    )
    .run(
      newId,
      userId,
      `${existing.name} (Copy)`,
      existing.title,
      existing.description,
      existing.folder,
      existing.avatar_path,
      existing.image_id,
      existing.attached_world_book_id,
      JSON.stringify(existing.metadata),
      now,
      now
    );

  const persona = getPersona(userId, newId)!;
  eventBus.emit(EventType.PERSONA_CHANGED, { id: newId, persona }, userId);
  return persona;
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
  return getDefaultPersona(userId);
}

export function deletePersona(userId: string, id: string): boolean {
  const result = getDb().query("DELETE FROM personas WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.PERSONA_CHANGED, { id, deleted: true }, userId);
  }
  return result.changes > 0;
}

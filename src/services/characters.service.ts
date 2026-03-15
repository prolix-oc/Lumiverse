import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Character, CreateCharacterInput, UpdateCharacterInput } from "../types/character";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";

export type CharacterSortMode = "recent" | "discover";

function rowToCharacter(row: any): Character {
  return {
    ...row,
    avatar_path: row.avatar_path || null,
    image_id: row.image_id || null,
    tags: JSON.parse(row.tags),
    alternate_greetings: JSON.parse(row.alternate_greetings),
    extensions: JSON.parse(row.extensions),
  };
}

export function listCharacters(userId: string, pagination: PaginationParams): PaginatedResult<Character> {
  return paginatedQuery(
    "SELECT * FROM characters WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM characters WHERE user_id = ?",
    [userId],
    pagination,
    rowToCharacter
  );
}

/**
 * Discovery sort: surfaces characters the user hasn't interacted with recently.
 *
 * Score components (higher = more discoverable):
 *   - Never chatted bonus:  +1000
 *   - Days since last chat: +0‑365  (capped)
 *   - Rarity bonus:         +0‑100  (fewer chats = higher)
 *   - Deterministic shuffle: +0‑200  (UUID-seeded, changes daily or on demand)
 */
export function listCharactersDiscover(
  userId: string,
  pagination: PaginationParams,
  seed?: number
): PaginatedResult<Character> {
  const db = getDb();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const shuffleSeed = seed ?? Math.floor(Date.now() / 86_400_000); // daily by default

  const countRow = db
    .query("SELECT COUNT(*) as count FROM characters WHERE user_id = ?")
    .get(userId) as { count: number } | null;
  const total = countRow?.count ?? 0;

  const dataSql = `
    SELECT c.*
    FROM characters c
    LEFT JOIN (
      SELECT character_id,
             COUNT(*)        AS chat_count,
             MAX(updated_at) AS last_chat_at
      FROM chats
      WHERE user_id = ?
      GROUP BY character_id
    ) cs ON cs.character_id = c.id
    WHERE c.user_id = ?
    ORDER BY (
      CASE WHEN COALESCE(cs.chat_count, 0) = 0 THEN 1000 ELSE 0 END
      + MIN(COALESCE((? - cs.last_chat_at) / 86400, 365), 365)
      + CASE WHEN COALESCE(cs.chat_count, 0) > 0
          THEN MAX(100 - COALESCE(cs.chat_count, 0) * 2, 0)
          ELSE 0 END
      + ABS(
          (UNICODE(SUBSTR(c.id, 1, 1)) * 31
           + UNICODE(SUBSTR(c.id, 5, 1)) * 17
           + UNICODE(SUBSTR(c.id, 10, 1)) * 13
           + ?) % 200
        )
    ) DESC
    LIMIT ? OFFSET ?
  `;

  const rows = db
    .query(dataSql)
    .all(userId, userId, nowSeconds, shuffleSeed, pagination.limit, pagination.offset) as any[];

  return {
    data: rows.map(rowToCharacter),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

export function getCharacter(userId: string, id: string): Character | null {
  const row = getDb().query("SELECT * FROM characters WHERE id = ? AND user_id = ?").get(id, userId) as any;
  if (!row) return null;
  return rowToCharacter(row);
}

export function createCharacter(userId: string, input: CreateCharacterInput): Character {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO characters (id, user_id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, tags, alternate_greetings, extensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.name,
      input.description || "",
      input.personality || "",
      input.scenario || "",
      input.first_mes || "",
      input.mes_example || "",
      input.creator || "",
      input.creator_notes || "",
      input.system_prompt || "",
      input.post_history_instructions || "",
      JSON.stringify(input.tags || []),
      JSON.stringify(input.alternate_greetings || []),
      JSON.stringify(input.extensions || {}),
      now,
      now
    );

  return getCharacter(userId, id)!;
}

export function updateCharacter(userId: string, id: string, input: UpdateCharacterInput): Character | null {
  const existing = getCharacter(userId, id);
  if (!existing) return null;

  const now = Math.floor(Date.now() / 1000);
  const fields: string[] = [];
  const values: any[] = [];

  const stringFields = [
    "name", "description", "personality", "scenario", "first_mes",
    "mes_example", "creator", "creator_notes", "system_prompt", "post_history_instructions",
  ] as const;

  for (const field of stringFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(input[field]);
    }
  }

  const jsonFields = ["tags", "alternate_greetings", "extensions"] as const;
  for (const field of jsonFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(JSON.stringify(input[field]));
    }
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE characters SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  const updated = getCharacter(userId, id)!;
  eventBus.emit(EventType.CHARACTER_EDITED, { id, character: updated }, userId);
  return updated;
}

export function setCharacterAvatar(userId: string, id: string, avatarPath: string): boolean {
  const result = getDb()
    .query("UPDATE characters SET avatar_path = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(avatarPath, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

export function setCharacterImage(userId: string, id: string, imageId: string): boolean {
  const result = getDb()
    .query("UPDATE characters SET image_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(imageId, Math.floor(Date.now() / 1000), id, userId);
  return result.changes > 0;
}

export function duplicateCharacter(userId: string, id: string): Character | null {
  const existing = getCharacter(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO characters (id, user_id, name, description, personality, scenario, first_mes, mes_example, creator, creator_notes, system_prompt, post_history_instructions, avatar_path, image_id, tags, alternate_greetings, extensions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId,
      userId,
      `${existing.name} (Copy)`,
      existing.description,
      existing.personality,
      existing.scenario,
      existing.first_mes,
      existing.mes_example,
      existing.creator,
      existing.creator_notes,
      existing.system_prompt,
      existing.post_history_instructions,
      existing.avatar_path,
      existing.image_id,
      JSON.stringify(existing.tags),
      JSON.stringify(existing.alternate_greetings),
      JSON.stringify(existing.extensions),
      now,
      now
    );

  const character = getCharacter(userId, newId)!;
  eventBus.emit(EventType.CHARACTER_EDITED, { id: newId, character }, userId);
  return character;
}

export function findCharactersByName(userId: string, name: string): Character[] {
  const rows = getDb()
    .query("SELECT * FROM characters WHERE user_id = ? AND name = ? ORDER BY updated_at DESC")
    .all(userId, name) as any[];
  return rows.map(rowToCharacter);
}

export function characterExistsByName(userId: string, name: string): boolean {
  const row = getDb()
    .query("SELECT 1 FROM characters WHERE user_id = ? AND name = ? LIMIT 1")
    .get(userId, name) as any;
  return !!row;
}

export function findCharacterBySourceFilename(userId: string, sourceFilename: string): Character | null {
  const row = getDb()
    .query(
      "SELECT * FROM characters WHERE user_id = ? AND json_extract(extensions, '$._lumiverse_source_filename') = ? LIMIT 1"
    )
    .get(userId, sourceFilename) as any;
  return row ? rowToCharacter(row) : null;
}

export function setCharacterSourceFilename(userId: string, id: string, sourceFilename: string): void {
  const char = getCharacter(userId, id);
  if (!char) return;
  const extensions = { ...(char.extensions ?? {}), _lumiverse_source_filename: sourceFilename };
  getDb()
    .query("UPDATE characters SET extensions = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(JSON.stringify(extensions), Math.floor(Date.now() / 1000), id, userId);
}

export function deleteCharacter(userId: string, id: string): boolean {
  const result = getDb().query("DELETE FROM characters WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.CHARACTER_DELETED, { id }, userId);
  }
  return result.changes > 0;
}

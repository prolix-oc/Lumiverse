/**
 * Databank Scope Resolver — Determines which databanks are active for a given context.
 *
 * Collects from four sources (mirroring the world books pattern):
 * 1. Scope-based: banks with scope=global, scope=character matching charId, scope=chat matching chatId
 * 2. Character cross-refs: character.extensions.databank_ids[]
 * 3. Chat cross-refs: chat.metadata.chat_databank_ids[]
 * 4. Global setting: settings.globalDatabanks[]
 */

import { getDb } from "../../db/connection";
import { getCharacterDatabankIds } from "../../utils/character-databanks";
import * as settingsSvc from "../settings.service";

export interface DatabankResolutionContext {
  userId: string;
  chatId: string;
  characterIds: string | string[];
  /** IDs from character.extensions.databank_ids (cross-referenced) */
  characterDatabankIds?: string[];
  /** IDs from chat.metadata.chat_databank_ids (cross-referenced) */
  chatDatabankIds?: string[];
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
}

function uniqueIds(ids: Iterable<unknown>): string[] {
  const result = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) result.add(id);
  }
  return [...result];
}

/**
 * Resolve active databank IDs for a generation context.
 *
 * Merges scope-based banks (from the databanks table) with cross-referenced
 * IDs from character extensions, chat metadata, and globalDatabanks setting.
 * Returns a deduplicated list of enabled bank IDs.
 */
export function resolveActiveDatabankIds(
  userId: string,
  chatId: string,
  characterIds: string | string[],
  crossRefs?: {
    characterDatabankIds?: string[];
    chatDatabankIds?: string[];
  },
): string[] {
  const db = getDb();
  const charIds = Array.isArray(characterIds) ? characterIds : characterIds ? [characterIds] : [];
  const allIds = new Set<string>();

  // 1. Scope-based resolution from databanks table
  if (charIds.length === 0) {
    const rows = db
      .query(
        `SELECT id FROM databanks
         WHERE user_id = ? AND enabled = 1
           AND (scope = 'global' OR (scope = 'chat' AND scope_id = ?))`,
      )
      .all(userId, chatId) as Array<{ id: string }>;
    for (const r of rows) allIds.add(r.id);
  } else {
    const charPlaceholders = charIds.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT id FROM databanks
         WHERE user_id = ? AND enabled = 1
           AND (
             scope = 'global'
             OR (scope = 'chat' AND scope_id = ?)
             OR (scope = 'character' AND scope_id IN (${charPlaceholders}))
           )`,
      )
      .all(userId, chatId, ...charIds) as Array<{ id: string }>;
    for (const r of rows) allIds.add(r.id);
  }

  // 2. Global setting: globalDatabanks
  try {
    const globalSetting = settingsSvc.getSetting(userId, "globalDatabanks");
    if (globalSetting?.value && Array.isArray(globalSetting.value)) {
      for (const id of globalSetting.value) {
        if (typeof id === "string" && id) allIds.add(id);
      }
    }
  } catch {
    // non-fatal
  }

  // 3. Character cross-refs: character.extensions.databank_ids
  if (crossRefs?.characterDatabankIds) {
    for (const id of crossRefs.characterDatabankIds) allIds.add(id);
  }

  // 4. Chat cross-refs: chat.metadata.chat_databank_ids
  if (crossRefs?.chatDatabankIds) {
    for (const id of crossRefs.chatDatabankIds) allIds.add(id);
  }

  // Filter out any IDs that don't actually exist or are disabled
  if (allIds.size === 0) return [];
  const idList = [...allIds];
  const placeholders = idList.map(() => "?").join(",");
  const validRows = db
    .query(`SELECT id FROM databanks WHERE id IN (${placeholders}) AND user_id = ? AND enabled = 1`)
    .all(...idList, userId) as Array<{ id: string }>;

  return validRows.map((r) => r.id);
}

/**
 * Resolve active databanks from persisted chat and character attachments.
 *
 * A supplied chat ID must belong to the user. Character IDs are constrained to
 * that chat's persisted participants, then revalidated against character
 * ownership before their extension cross-references are admitted. Memory
 * isolation suppresses every character-derived source while preserving global
 * and chat-scoped sources, including chat metadata attachments.
 */
export function resolvePersistedActiveDatabankIds(
  userId: string,
  chatId: string,
  requestedCharacterIds: string | readonly string[] = [],
): string[] {
  const db = getDb();
  const requestedIds = uniqueIds(
    Array.isArray(requestedCharacterIds) ? requestedCharacterIds : [requestedCharacterIds],
  );
  let characterIds = requestedIds;
  let chatDatabankIds: string[] = [];

  if (chatId) {
    const chat = db.query(
      "SELECT character_id, metadata FROM chats WHERE id = ? AND user_id = ? LIMIT 1",
    ).get(chatId, userId) as { character_id: string; metadata: unknown } | null;
    if (!chat) return [];

    const metadata = parseRecord(chat.metadata);
    chatDatabankIds = stringIds(metadata.chat_databank_ids);
    if (metadata.memory_isolation === true) {
      characterIds = [];
    } else {
      const persistedCharacterIds = uniqueIds([
        chat.character_id,
        ...stringIds(metadata.character_ids),
      ]);
      if (requestedIds.length === 0) {
        characterIds = persistedCharacterIds;
      } else {
        const persistedSet = new Set(persistedCharacterIds);
        characterIds = requestedIds.filter((id) => persistedSet.has(id));
      }
    }
  }

  let characterDatabankIds: string[] = [];
  if (characterIds.length > 0) {
    const placeholders = characterIds.map(() => "?").join(",");
    const rows = db.query(
      `SELECT id, extensions
         FROM characters
        WHERE id IN (${placeholders})
          AND user_id = ?`,
    ).all(...characterIds, userId) as Array<{ id: string; extensions: unknown }>;
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    characterIds = characterIds.filter((id) => rowsById.has(id));
    characterDatabankIds = uniqueIds(characterIds.flatMap((id) =>
      getCharacterDatabankIds(parseRecord(rowsById.get(id)?.extensions))
    ));
  }

  return resolveActiveDatabankIds(userId, chatId, characterIds, {
    characterDatabankIds,
    chatDatabankIds,
  });
}

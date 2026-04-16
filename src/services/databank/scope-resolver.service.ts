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

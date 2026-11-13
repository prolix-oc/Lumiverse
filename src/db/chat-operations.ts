import type { Database } from "bun:sqlite";
import { trackVariableWrite, type VariableWriteSource } from "./swipe-variable-state";
import type { Chat, ConditionalChatMetadataInput, UpdateChatInput } from "../types/chat";
import { isDeepStrictEqual } from "node:util";
import { normalizeSpindleMessageMetadata } from "../utils/message-metadata";
export interface ChatMetadataMergeOptions {
  variableSource?: VariableWriteSource;
  touchUpdatedAt?: boolean;
  /** Merge these object paths with their current values inside the transaction. */
  mergeObjectPaths?: string[][];
}
export type ChatMutation =
  | { action: "update"; userId: string; id: string; input: UpdateChatInput; touchUpdatedAt?: boolean }
  | { action: "compare-metadata"; userId: string; id: string; input: ConditionalChatMetadataInput }
  | ({ action: "merge"; userId: string; id: string; partial: Record<string, any> } & ChatMetadataMergeOptions)
  | { action: "remove-group-member"; userId: string; id: string; characterId: string };
export interface ChatUpdateResult { before: Chat; after: Chat; changed: boolean }
function getChatWithDb(db: Database, userId: string, id: string): Chat | null {
  const row = db.query("SELECT * FROM chats WHERE id = ? AND user_id = ?").get(id, userId);
  return row ? rowToChat(row) : null;
}
function updateChatWithDb(db: Database, userId: string, id: string, input: UpdateChatInput, opts: ChatMetadataMergeOptions = {}, before?: Chat): ChatUpdateResult | null {
  const existing = before ?? getChatWithDb(db, userId, id);
  if (!existing) return null;
  const fields: string[] = [], values: any[] = [];
  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(trackVariableWrite(db, id, existing.metadata, input.metadata, opts.variableSource))); }
  if (fields.length === 0) return { before: existing, after: existing, changed: false };
  if (opts.touchUpdatedAt !== false) { fields.push("updated_at = ?"); values.push(Math.floor(Date.now() / 1000)); }
  db.query(`UPDATE chats SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values, id, userId);
  const after = getChatWithDb(db, userId, id)!;
  return { before: existing, after, changed: true };
}
export function mutateChatWithDb(db: Database, mutation: ChatMutation): ChatUpdateResult | null {
  return db.transaction(() => {
    if (mutation.action === "remove-group-member") return removeGroupMember(db, mutation.userId, mutation.id, mutation.characterId);
    if (mutation.action === "update") return updateChatWithDb(db, mutation.userId, mutation.id, mutation.input, mutation);
    const before = getChatWithDb(db, mutation.userId, mutation.id);
    if (!before) return null;
    if (mutation.action === "compare-metadata") {
      const input = mutation.input;
      if (!isDeepStrictEqual(before.metadata, input.expected_metadata)) return null;
      if (input.expected_last_message_id !== undefined) {
        const last = db.query("SELECT id FROM messages WHERE chat_id = ? ORDER BY index_in_chat DESC LIMIT 1").get(mutation.id) as { id: string } | null;
        if ((last?.id ?? null) !== input.expected_last_message_id) return null;
      }
      if (input.expected_message) {
        const expected = input.expected_message;
        const row = db.query("SELECT swipe_id, swipes, extra, content FROM messages WHERE id = ? AND chat_id = ?").get(expected.id, mutation.id) as { swipe_id: number; swipes: string; extra: string; content: string } | null;
        if (!row || (typeof row.swipe_id === "number" && Number.isFinite(row.swipe_id) ? row.swipe_id : 0) !== expected.swipe_id) return null;
        let swipes: string[];
        try { swipes = JSON.parse(row.swipes); } catch { swipes = [row.content ?? ""]; }
        if (!isDeepStrictEqual(swipes, expected.swipes) ||
            !isDeepStrictEqual(normalizeSpindleMessageMetadata(parseMetadataObject(row.extra).spindle_metadata, swipes.length) ?? {}, expected.metadata)) return null;
      }
      return updateChatWithDb(db, mutation.userId, mutation.id, { metadata: input.metadata }, {}, before);
    }
    const metadata = mergeMetadata(before.metadata, mutation.partial, mutation.mergeObjectPaths ?? []);
    return updateChatWithDb(db, mutation.userId, mutation.id, { metadata }, mutation, before);
  }).immediate();
}

function mergeMetadata(
  current: Record<string, any>,
  partial: Record<string, any>,
  mergePaths: string[][],
  prefix: string[] = [],
): Record<string, any> {
  const merged = { ...current };
  for (const [key, value] of Object.entries(partial)) {
    const path = [...prefix, key];
    if (value === undefined) delete merged[key];
    else if (isPlainObject(value) && mergePaths.some((candidate) =>
      candidate.length >= path.length && path.every((part, index) => candidate[index] === part)
    )) {
      merged[key] = mergeMetadata(isPlainObject(merged[key]) ? merged[key] : {}, value, mergePaths, path);
    } else merged[key] = value;
  }
  return merged;
}

export function parseMetadataObject(value: unknown): Record<string, any> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function rowToChat(row: any): Chat {
  const metadata = parseMetadataObject(row.metadata);
  return { ...row, metadata };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function removeGroupMember(db: Database, userId: string, chatId: string, characterId: string): ChatUpdateResult | null {
  const chat = getChatWithDb(db, userId, chatId);
  if (!chat || !chat.metadata?.group) return null;

  const characterIds: string[] = chat.metadata.character_ids || [];
  if (!characterIds.includes(characterId)) return null;
  if (characterIds.length <= 2) return null;

  const newCharacterIds = characterIds.filter((id) => id !== characterId);

  // Clean up muted list
  const mutedIds: string[] = Array.isArray(chat.metadata.muted_character_ids)
    ? chat.metadata.muted_character_ids.filter((id: string) => id !== characterId)
    : [];

  // Clean up per-character expression state
  const groupExpressions = chat.metadata.group_expressions
    ? { ...chat.metadata.group_expressions }
    : undefined;
  if (groupExpressions && characterId in groupExpressions) {
    delete groupExpressions[characterId];
  }

  // Clean up per-member alternate field selections
  const groupAlternateFieldSelections = isPlainObject(chat.metadata.group_alternate_field_selections)
    ? { ...chat.metadata.group_alternate_field_selections }
    : undefined;
  if (groupAlternateFieldSelections && characterId in groupAlternateFieldSelections) {
    delete groupAlternateFieldSelections[characterId];
  }

  const groupActiveAvatarIds = isPlainObject(chat.metadata.group_active_avatar_ids)
    ? { ...chat.metadata.group_active_avatar_ids }
    : undefined;
  if (groupActiveAvatarIds) delete groupActiveAvatarIds[characterId];
  const groupActiveAvatarEntryIds = isPlainObject(chat.metadata.group_active_avatar_entry_ids)
    ? { ...chat.metadata.group_active_avatar_entry_ids }
    : undefined;
  if (groupActiveAvatarEntryIds) delete groupActiveAvatarEntryIds[characterId];
  const groupActiveGreetingIndices = isPlainObject(chat.metadata.group_active_greeting_indices)
    ? { ...chat.metadata.group_active_greeting_indices }
    : undefined;
  if (groupActiveGreetingIndices) delete groupActiveGreetingIndices[characterId];

  const newMetadata = {
    ...chat.metadata,
    character_ids: newCharacterIds,
    muted_character_ids: mutedIds,
    ...(groupExpressions !== undefined && { group_expressions: groupExpressions }),
    ...(groupAlternateFieldSelections !== undefined && {
      group_alternate_field_selections: groupAlternateFieldSelections,
    }),
    ...(groupActiveAvatarIds !== undefined && { group_active_avatar_ids: groupActiveAvatarIds }),
    ...(groupActiveAvatarEntryIds !== undefined && { group_active_avatar_entry_ids: groupActiveAvatarEntryIds }),
    ...(groupActiveGreetingIndices !== undefined && { group_active_greeting_indices: groupActiveGreetingIndices }),
  };

  if (groupAlternateFieldSelections && Object.keys(groupAlternateFieldSelections).length === 0) {
    delete newMetadata.group_alternate_field_selections;
  }
  if (groupActiveAvatarIds && Object.keys(groupActiveAvatarIds).length === 0) delete newMetadata.group_active_avatar_ids;
  if (groupActiveAvatarEntryIds && Object.keys(groupActiveAvatarEntryIds).length === 0) delete newMetadata.group_active_avatar_entry_ids;
  if (groupActiveGreetingIndices && Object.keys(groupActiveGreetingIndices).length === 0) delete newMetadata.group_active_greeting_indices;

  // If the removed character was the primary character_id on the chat row,
  // reassign to the first remaining member
  if (chat.character_id === characterId) {
    const now = Math.floor(Date.now() / 1000);
    db
      .query("UPDATE chats SET character_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(newCharacterIds[0], now, chatId, userId);
  }

  return updateChatWithDb(db, userId, chatId, { metadata: newMetadata }, {}, chat);
}

export function clearRemovedChatAvatarReferencesWithDb(db: Database, userId: string, removedImageIds: Iterable<string>): any[] {
  const removed = new Set(removedImageIds);
  if (removed.size === 0) return [];
  const updated: any[] = [];
  let rows: any[];
  try {
    rows = db.query("SELECT id, character_id, name, metadata, created_at, updated_at FROM chats WHERE user_id = ?").all(userId) as any[];
  } catch (error) {
    if (!/no such (table|column)/i.test(String((error as Error)?.message ?? error))) throw error;
    return [];
  }
  for (const row of rows) {
    let metadata: Record<string, any>;
    try {
      metadata = JSON.parse(row.metadata || "{}");
    } catch {
      continue;
    }
    let changed = false;
    if (typeof metadata.active_avatar_id === "string" && removed.has(metadata.active_avatar_id)) {
      delete metadata.active_avatar_id;
      delete metadata.active_avatar_entry_id;
      changed = true;
    }
    if (metadata.group_active_avatar_ids && typeof metadata.group_active_avatar_ids === "object") {
      const ids = { ...metadata.group_active_avatar_ids };
      const entries = metadata.group_active_avatar_entry_ids && typeof metadata.group_active_avatar_entry_ids === "object"
        ? { ...metadata.group_active_avatar_entry_ids }
        : {};
      for (const [characterId, imageId] of Object.entries(ids)) {
        if (typeof imageId !== "string" || !removed.has(imageId)) continue;
        delete ids[characterId];
        delete entries[characterId];
        changed = true;
      }
      if (Object.keys(ids).length > 0) metadata.group_active_avatar_ids = ids;
      else delete metadata.group_active_avatar_ids;
      if (Object.keys(entries).length > 0) metadata.group_active_avatar_entry_ids = entries;
      else delete metadata.group_active_avatar_entry_ids;
    }
    if (!changed) continue;
    const partial = Object.fromEntries(["active_avatar_id", "active_avatar_entry_id", "group_active_avatar_ids", "group_active_avatar_entry_ids"].map(key => [key, metadata[key]]));
    const result = mutateChatWithDb(db, { action: "merge", userId, id: row.id, partial });
    if (result) updated.push(result.after);
  }
  return updated;
}

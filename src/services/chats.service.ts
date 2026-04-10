import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getCharacter } from "./characters.service";
import type { Chat, CreateChatInput, CreateGroupChatInput, UpdateChatInput, RecentChat, GroupedRecentChat, ChatSummary } from "../types/chat";
import type { Message, CreateMessageInput, UpdateMessageInput } from "../types/message";
import type { BulkMessageInput } from "../types/migrate";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import * as embeddingsSvc from "./embeddings.service";
import * as memoryCortex from "./memory-cortex";
import { removePoolEntriesForChat } from "./generation-pool.service";
import { invalidateChatMemoryCache, scheduleChatMemoryRefresh } from "./chat-memory-cache.service";
import { sanitizeForVectorization } from "../utils/content-sanitizer";

// --- Chat helpers ---

function rowToChat(row: any): Chat {
  return { ...row, metadata: JSON.parse(row.metadata) };
}

function rowToMessage(row: any): Message {
  return {
    ...row,
    is_user: !!row.is_user,
    swipes: JSON.parse(row.swipes),
    swipe_dates: JSON.parse(row.swipe_dates || '[]'),
    extra: JSON.parse(row.extra),
    parent_message_id: row.parent_message_id || null,
    branch_id: row.branch_id || null,
  };
}

function rowToRecentChat(row: any): RecentChat {
  return {
    ...row,
    metadata: JSON.parse(row.metadata),
    character_name: row.character_name || "",
    character_avatar_path: row.character_avatar_path || null,
    character_image_id: row.character_image_id || null,
  };
}

// --- Chat CRUD ---

export function listChats(userId: string, pagination: PaginationParams, characterId?: string): PaginatedResult<Chat> {
  if (characterId) {
    return paginatedQuery(
      "SELECT * FROM chats WHERE user_id = ? AND character_id = ? AND COALESCE(json_extract(metadata, '$.group'), 0) != 1 ORDER BY updated_at DESC",
      "SELECT COUNT(*) as count FROM chats WHERE user_id = ? AND character_id = ? AND COALESCE(json_extract(metadata, '$.group'), 0) != 1",
      [userId, characterId],
      pagination,
      rowToChat
    );
  }
  return paginatedQuery(
    "SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM chats WHERE user_id = ?",
    [userId],
    pagination,
    rowToChat
  );
}

export function listRecentChats(userId: string, pagination: PaginationParams): PaginatedResult<RecentChat> {
  return paginatedQuery(
    `SELECT c.id, c.character_id, c.name, c.metadata, c.created_at, c.updated_at,
       ch.name AS character_name, ch.avatar_path AS character_avatar_path, ch.image_id AS character_image_id
     FROM chats c LEFT JOIN characters ch ON ch.id = c.character_id
     WHERE c.user_id = ?
     ORDER BY c.updated_at DESC`,
    "SELECT COUNT(*) as count FROM chats WHERE user_id = ?",
    [userId],
    pagination,
    rowToRecentChat
  );
}

export function listRecentChatsGrouped(userId: string, pagination: PaginationParams): PaginatedResult<GroupedRecentChat> {
  const db = getDb();

  // Count: (distinct characters from non-group chats) + (each group chat individually)
  const countRow = db.query(`
    SELECT (
      (SELECT COUNT(DISTINCT character_id) FROM chats
       WHERE user_id = ? AND COALESCE(json_extract(metadata, '$.group'), 0) != 1)
      +
      (SELECT COUNT(*) FROM chats
       WHERE user_id = ? AND json_extract(metadata, '$.group') = 1)
    ) as count
  `).get(userId, userId) as { count: number } | null;
  const total = countRow?.count ?? 0;

  const rows = db.query(`
    WITH solo_ranked AS (
      SELECT
        c.id,
        c.character_id,
        c.name,
        c.metadata,
        c.updated_at,
        ROW_NUMBER() OVER (PARTITION BY c.character_id ORDER BY c.updated_at DESC) as rn,
        COUNT(*) OVER (PARTITION BY c.character_id) as chat_count
      FROM chats c
      WHERE c.user_id = ? AND COALESCE(json_extract(c.metadata, '$.group'), 0) != 1
    ),
    combined AS (
      SELECT id, character_id, name, metadata, updated_at, chat_count
      FROM solo_ranked WHERE rn = 1
      UNION ALL
      SELECT id, character_id, name, metadata, updated_at, 1 as chat_count
      FROM chats
      WHERE user_id = ? AND json_extract(metadata, '$.group') = 1
    )
    SELECT
      combined.id as latest_chat_id,
      combined.character_id,
      combined.name as latest_chat_name,
      combined.metadata,
      combined.updated_at,
      combined.chat_count,
      ch.name AS character_name,
      ch.avatar_path AS character_avatar_path,
      ch.image_id AS character_image_id
    FROM combined
    LEFT JOIN characters ch ON ch.id = combined.character_id
    ORDER BY combined.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, userId, pagination.limit, pagination.offset) as any[];

  return {
    data: rows.map((row: any) => {
      const metadata = JSON.parse(row.metadata || '{}');
      const isGroup = metadata?.group === true;
      return {
        character_id: row.character_id,
        character_name: row.character_name || '',
        character_avatar_path: row.character_avatar_path || null,
        character_image_id: row.character_image_id || null,
        latest_chat_id: row.latest_chat_id,
        latest_chat_name: row.latest_chat_name || '',
        updated_at: row.updated_at,
        chat_count: row.chat_count,
        is_group: isGroup,
        ...(isGroup && metadata.character_ids ? {
          group_character_ids: metadata.character_ids,
          group_name: row.latest_chat_name || undefined,
        } : {}),
      };
    }),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

export function listChatSummaries(userId: string, characterId: string): ChatSummary[] {
  const db = getDb();
  const rows = db.query(`
    SELECT
      c.id,
      c.name,
      c.created_at,
      c.updated_at,
      (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) as message_count
    FROM chats c
    WHERE c.user_id = ? AND c.character_id = ?
      AND COALESCE(json_extract(c.metadata, '$.group'), 0) != 1
    ORDER BY c.updated_at DESC
  `).all(userId, characterId) as any[];

  return rows.map((row: any) => ({
    id: row.id,
    name: row.name || '',
    message_count: row.message_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

// Prepared statement for hot-path chat fetch
let _stmtChatById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;

export function getChat(userId: string, id: string): Chat | null {
  if (!_stmtChatById) _stmtChatById = getDb().query("SELECT * FROM chats WHERE id = ? AND user_id = ?");
  const row = _stmtChatById.get(id, userId) as any;
  if (!row) return null;
  return rowToChat(row);
}

export function createChat(userId: string, input: CreateChatInput): Chat {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Auto-name with character name
  let chatName = input.name || "";
  if (!chatName) {
    const character = getCharacter(userId, input.character_id);
    if (character) chatName = character.name;
  }

  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.character_id, chatName, JSON.stringify(input.metadata || {}), now, now);

  // Insert the character's greeting as the opening message
  const character = getCharacter(userId, input.character_id);
  if (character) {
    let greeting = character.first_mes;
    if (input.greeting_index && input.greeting_index >= 1 && character.alternate_greetings?.length) {
      const altIdx = input.greeting_index - 1;
      if (altIdx < character.alternate_greetings.length) {
        greeting = character.alternate_greetings[altIdx];
      }
    }
    if (greeting) {
      createMessage(id, {
        is_user: false,
        name: character.name,
        content: greeting,
      });
    }
  }

  return getChat(userId, id)!;
}

export function createGroupChat(userId: string, input: CreateGroupChatInput): Chat {
  const greetingCharId = input.greeting_character_id || input.character_ids[0];
  const metadata = { group: true, character_ids: input.character_ids };

  const chat = createChat(userId, {
    character_id: greetingCharId,
    name: input.name || "",
    metadata,
    greeting_index: input.greeting_index,
  });

  return chat;
}

export function deleteChat(userId: string, id: string): boolean {
  const result = getDb().query("DELETE FROM chats WHERE id = ? AND user_id = ?").run(id, userId);
  if (result.changes > 0) {
    invalidateChatMemoryCache(id);
    removePoolEntriesForChat(userId, id);
    eventBus.emit(EventType.CHAT_DELETED, { id }, userId);
  }
  return result.changes > 0;
}

export function updateChat(userId: string, id: string, input: UpdateChatInput): Chat | null {
  const existing = getChat(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  const now = Math.floor(Date.now() / 1000);
  fields.push("updated_at = ?");
  values.push(now);
  values.push(id);

  getDb().query(`UPDATE chats SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const updated = getChat(userId, id)!;
  eventBus.emit(EventType.CHAT_CHANGED, { chat: updated }, userId);

  // Detect avatar switch and emit specific event for theme resampling / extensions
  const oldAvatarId = existing.metadata?.active_avatar_id as string | undefined;
  const newAvatarId = updated.metadata?.active_avatar_id as string | undefined;
  if (oldAvatarId !== newAvatarId) {
    eventBus.emit(EventType.CHARACTER_AVATAR_CHANGED, {
      chatId: id,
      characterId: updated.character_id,
      imageId: newAvatarId || null,
    }, userId);
  }

  return updated;
}

// ---- Group chat muting ----

export function getGroupMutedIds(chat: Chat): string[] {
  if (!chat.metadata?.group) return [];
  return Array.isArray(chat.metadata.muted_character_ids)
    ? chat.metadata.muted_character_ids
    : [];
}

export function setGroupMute(userId: string, chatId: string, characterId: string, muted: boolean): Chat | null {
  const chat = getChat(userId, chatId);
  if (!chat || !chat.metadata?.group) return null;

  const characterIds: string[] = chat.metadata.character_ids || [];
  if (!characterIds.includes(characterId)) return null;

  const currentMuted: string[] = getGroupMutedIds(chat);
  let newMuted: string[];
  if (muted) {
    newMuted = currentMuted.includes(characterId) ? currentMuted : [...currentMuted, characterId];
  } else {
    newMuted = currentMuted.filter((id) => id !== characterId);
  }

  const newMetadata = { ...chat.metadata, muted_character_ids: newMuted };
  return updateChat(userId, chatId, { metadata: newMetadata });
}

// ---- Group chat member management ----

export function addGroupMember(
  userId: string,
  chatId: string,
  characterId: string,
  options?: { skip_greeting?: boolean; greeting_index?: number }
): Chat | null {
  const chat = getChat(userId, chatId);
  if (!chat || !chat.metadata?.group) return null;

  const characterIds: string[] = chat.metadata.character_ids || [];
  if (characterIds.includes(characterId)) return null;

  const character = getCharacter(userId, characterId);
  if (!character) return null;

  const newMetadata = { ...chat.metadata, character_ids: [...characterIds, characterId] };
  const updated = updateChat(userId, chatId, { metadata: newMetadata });

  if (updated && !options?.skip_greeting) {
    let greeting = character.first_mes;
    if (options?.greeting_index !== undefined && options.greeting_index >= 1 && character.alternate_greetings?.length) {
      const altIdx = options.greeting_index - 1;
      if (altIdx < character.alternate_greetings.length) {
        greeting = character.alternate_greetings[altIdx];
      }
    }
    if (greeting) {
      createMessage(chatId, {
        is_user: false,
        name: character.name,
        content: greeting,
      }, userId);
    }
  }

  return updated;
}

export function removeGroupMember(userId: string, chatId: string, characterId: string): Chat | null {
  const chat = getChat(userId, chatId);
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

  const newMetadata = {
    ...chat.metadata,
    character_ids: newCharacterIds,
    muted_character_ids: mutedIds,
    ...(groupExpressions !== undefined && { group_expressions: groupExpressions }),
  };

  // If the removed character was the primary character_id on the chat row,
  // reassign to the first remaining member
  if (chat.character_id === characterId) {
    const now = Math.floor(Date.now() / 1000);
    getDb()
      .query("UPDATE chats SET character_id = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(newCharacterIds[0], now, chatId, userId);
  }

  return updateChat(userId, chatId, { metadata: newMetadata });
}

export function reattributeUserMessages(userId: string, chatId: string, personaId: string, personaName: string): number | null {
  const chat = getChat(userId, chatId);
  if (!chat) return null;

  const rows = getDb()
    .query("SELECT id, extra FROM messages WHERE chat_id = ? AND is_user = 1")
    .all(chatId) as Array<{ id: string; extra: string }>;

  const update = getDb().query("UPDATE messages SET name = ?, extra = ? WHERE id = ?");
  for (const row of rows) {
    let extra: Record<string, any> = {};
    try {
      extra = row.extra ? JSON.parse(row.extra) : {};
    } catch {
      extra = {};
    }
    extra.persona_id = personaId;
    update.run(personaName, JSON.stringify(extra), row.id);
  }

  if (rows.length > 0) {
    eventBus.emit(EventType.CHAT_CHANGED, { chatId, reattributedUserMessages: rows.length }, userId);
  }

  return rows.length;
}

export function bulkReattributeByPersonaName(userId: string, personaMap: Map<string, { id: string; name: string }>): { chats_updated: number; messages_updated: number } {
  const db = getDb();

  // Find all user messages across all user's chats that lack a persona_id
  const rows = db
    .query(
      `SELECT m.id, m.chat_id, m.name, m.extra
       FROM messages m
       JOIN chats c ON m.chat_id = c.id
       WHERE c.user_id = ? AND m.is_user = 1`
    )
    .all(userId) as Array<{ id: string; chat_id: string; name: string; extra: string }>;

  const update = db.query("UPDATE messages SET name = ?, extra = ? WHERE id = ?");
  let messagesUpdated = 0;
  const updatedChatIds = new Set<string>();

  const tx = db.transaction(() => {
    for (const row of rows) {
      let extra: Record<string, any> = {};
      try {
        extra = row.extra ? JSON.parse(row.extra) : {};
      } catch {
        extra = {};
      }

      // Skip if already attributed
      if (extra.persona_id) continue;

      const match = personaMap.get(row.name);
      if (!match) continue;

      extra.persona_id = match.id;
      update.run(match.name, JSON.stringify(extra), row.id);
      messagesUpdated++;
      updatedChatIds.add(row.chat_id);
    }
  });
  tx();

  return { chats_updated: updatedChatIds.size, messages_updated: messagesUpdated };
}

export function getLastAssistantMessage(userId: string, chatId: string): Message | null {
  const row = getDb()
    .query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? AND m.is_user = 0 ORDER BY m.index_in_chat DESC LIMIT 1")
    .get(chatId, userId) as any;
  if (!row) return null;
  return rowToMessage(row);
}

export function getLastMessage(userId: string, chatId: string): Message | null {
  const row = getDb()
    .query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? ORDER BY m.index_in_chat DESC LIMIT 1")
    .get(chatId, userId) as any;
  if (!row) return null;
  return rowToMessage(row);
}

// --- Message CRUD ---

// Prepared statements for hot-path message queries
let _stmtMsgAll: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtMsgCount: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtMsgTail: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;
let _stmtMsgById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;

function getMsgStmts() {
  const db = getDb();
  if (!_stmtMsgAll) _stmtMsgAll = db.query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? ORDER BY m.index_in_chat ASC");
  if (!_stmtMsgCount) _stmtMsgCount = db.query("SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ?");
  if (!_stmtMsgTail) _stmtMsgTail = db.query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? ORDER BY m.index_in_chat DESC LIMIT ?");
  if (!_stmtMsgById) _stmtMsgById = db.query("SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.id = ? AND c.user_id = ?");
  return { all: _stmtMsgAll, count: _stmtMsgCount, tail: _stmtMsgTail, byId: _stmtMsgById };
}

export function getMessages(userId: string, chatId: string): Message[] {
  const rows = getMsgStmts().all.all(chatId, userId) as any[];
  return rows.map(rowToMessage);
}

export function listMessages(userId: string, chatId: string, pagination: PaginationParams): PaginatedResult<Message> {
  return paginatedQuery(
    "SELECT m.* FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ? ORDER BY m.index_in_chat ASC",
    "SELECT COUNT(*) as count FROM messages m JOIN chats c ON m.chat_id = c.id WHERE m.chat_id = ? AND c.user_id = ?",
    [chatId, userId],
    pagination,
    rowToMessage
  );
}

export function listMessagesTail(userId: string, chatId: string, limit: number): PaginatedResult<Message> {
  const stmts = getMsgStmts();
  const countRow = stmts.count.get(chatId, userId) as { count: number } | null;
  const total = countRow?.count ?? 0;

  // Fetch the last N messages by scanning the index in reverse, then reverse in memory
  const rows = stmts.tail.all(chatId, userId, limit) as any[];
  rows.reverse();

  const offset = Math.max(0, total - rows.length);
  return {
    data: rows.map(rowToMessage),
    total,
    limit,
    offset,
  };
}

export function getMessage(userId: string, id: string): Message | null {
  const row = getMsgStmts().byId.get(id, userId) as any;
  if (!row) return null;
  return rowToMessage(row);
}

export function createMessage(chatId: string, input: CreateMessageInput, userId?: string): Message {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const maxIndex = getDb()
    .query("SELECT COALESCE(MAX(index_in_chat), -1) as max_idx FROM messages WHERE chat_id = ?")
    .get(chatId) as any;
  const nextIndex = (maxIndex?.max_idx ?? -1) + 1;

  const swipes = [input.content];
  const swipeDates = [now];

  getDb()
    .query(
      `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, parent_message_id, branch_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, chatId, nextIndex, input.is_user ? 1 : 0, input.name, input.content,
      now, 0, JSON.stringify(swipes), JSON.stringify(swipeDates), JSON.stringify(input.extra || {}),
      input.parent_message_id || null, input.branch_id || null, now
    );

  getDb().query("UPDATE chats SET updated_at = ? WHERE id = ?").run(now, chatId);

  // getMessage without userId — internal use after validated chat
  const row = getDb().query("SELECT * FROM messages WHERE id = ?").get(id) as any;
  const message = rowToMessage(row);
  eventBus.emit(EventType.MESSAGE_SENT, { chatId, message }, userId);

  if (userId) {
    updateChatChunks(userId, chatId, message).catch(err => {
      console.warn("[chats] Failed to update chunks:", err);
    });
  }

  return message;
}

export function updateMessage(userId: string, id: string, input: UpdateMessageInput): Message | null {
  const existing = getMessage(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.content !== undefined) {
    fields.push("content = ?");
    values.push(input.content);

    // Update current swipe content too
    const swipes = [...existing.swipes];
    swipes[existing.swipe_id] = input.content;
    fields.push("swipes = ?");
    values.push(JSON.stringify(swipes));
  }
  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.extra !== undefined) { fields.push("extra = ?"); values.push(JSON.stringify(input.extra)); }

  if (fields.length === 0) return existing;
  values.push(id);

  getDb().query(`UPDATE messages SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const updated = getMessage(userId, id)!;
  eventBus.emit(EventType.MESSAGE_EDITED, { chatId: updated.chat_id, message: updated }, userId);
  invalidateChatMemoryCache(updated.chat_id);

  rebuildChatChunks(userId, updated.chat_id).catch(err => {
    console.warn("[chats] Failed to rebuild chunks after message edit:", err);
  });

  return updated;
}

export function bulkSetHidden(userId: string, chatId: string, messageIds: string[], hidden: boolean): Message[] {
  const chat = getChat(userId, chatId);
  if (!chat) throw new Error("Chat not found");

  if (messageIds.length > 500) throw new Error("Maximum 500 messages per batch");

  const db = getDb();
  const getStmt = db.query("SELECT * FROM messages WHERE id = ? AND chat_id = ?");
  const updateStmt = db.query("UPDATE messages SET extra = ? WHERE id = ?");

  const updated: Message[] = [];

  const transaction = db.transaction(() => {
    for (const msgId of messageIds) {
      const row = getStmt.get(msgId, chatId) as any;
      if (!row) continue;

      const extra = JSON.parse(row.extra || "{}");
      if (hidden) {
        extra.hidden = true;
      } else {
        delete extra.hidden;
      }

      updateStmt.run(JSON.stringify(extra), msgId);
      const updatedRow = { ...row, extra: JSON.stringify(extra) };
      updated.push(rowToMessage(updatedRow));
    }
  });

  transaction();

  // Emit events for WS sync
  for (const msg of updated) {
    eventBus.emit(EventType.MESSAGE_EDITED, { chatId, message: msg }, userId);
  }

  invalidateChatMemoryCache(chatId);

  // Rebuild chunks once after all updates
  rebuildChatChunks(userId, chatId).catch(err => {
    console.warn("[chats] Failed to rebuild chunks after bulk hide:", err);
  });

  return updated;
}

export function bulkDeleteMessages(userId: string, chatId: string, messageIds: string[]): number {
  const chat = getChat(userId, chatId);
  if (!chat) throw new Error("Chat not found");

  if (messageIds.length > 500) throw new Error("Maximum 500 messages per batch");

  const db = getDb();
  const getStmt = db.query("SELECT id FROM messages WHERE id = ? AND chat_id = ?");
  const deleteStmt = db.query("DELETE FROM messages WHERE id = ?");

  let deleted = 0;
  const deletedIds: string[] = [];

  const transaction = db.transaction(() => {
    for (const msgId of messageIds) {
      const row = getStmt.get(msgId, chatId) as any;
      if (!row) continue;

      deleteStmt.run(msgId);
      deleted++;
      deletedIds.push(msgId);
    }
  });

  transaction();

  for (const msgId of deletedIds) {
    eventBus.emit(EventType.MESSAGE_DELETED, { chatId, messageId: msgId }, userId);
  }

  if (deleted > 0) {
    invalidateChatMemoryCache(chatId);

    rebuildChatChunks(userId, chatId).catch(err => {
      console.warn("[chats] Failed to rebuild chunks after bulk delete:", err);
    });
  }

  return deleted;
}

export function deleteMessage(userId: string, id: string): boolean {
  const msg = getMessage(userId, id);
  if (!msg) return false;
  const result = getDb().query("DELETE FROM messages WHERE id = ?").run(id);
  if (result.changes > 0) {
    eventBus.emit(EventType.MESSAGE_DELETED, { chatId: msg.chat_id, messageId: id }, userId);
    invalidateChatMemoryCache(msg.chat_id);

    rebuildChatChunks(userId, msg.chat_id).catch(err => {
      console.warn("[chats] Failed to rebuild chunks after message delete:", err);
    });
  }
  return result.changes > 0;
}

// --- Swipes ---

export function addSwipe(userId: string, messageId: string, content: string): Message | null {
  const msg = getMessage(userId, messageId);
  if (!msg) return null;

  const now = Math.floor(Date.now() / 1000);
  const swipes = [...msg.swipes, content];
  const swipeDates = [...msg.swipe_dates, now];
  const newSwipeId = swipes.length - 1;

  getDb()
    .query("UPDATE messages SET swipes = ?, swipe_dates = ?, swipe_id = ?, content = ? WHERE id = ?")
    .run(JSON.stringify(swipes), JSON.stringify(swipeDates), newSwipeId, content, messageId);

  const updated = getMessage(userId, messageId)!;
  eventBus.emit(
    EventType.MESSAGE_SWIPED,
    {
      chatId: updated.chat_id,
      message: updated,
      action: "added",
      swipeId: newSwipeId,
    },
    userId,
  );
  return updated;
}

export function updateSwipe(userId: string, messageId: string, swipeIdx: number, content: string): Message | null {
  const msg = getMessage(userId, messageId);
  if (!msg || swipeIdx < 0 || swipeIdx >= msg.swipes.length) return null;

  const swipes = [...msg.swipes];
  swipes[swipeIdx] = content;

  const updates = swipeIdx === msg.swipe_id
    ? "swipes = ?, content = ?"
    : "swipes = ?";
  const values = swipeIdx === msg.swipe_id
    ? [JSON.stringify(swipes), content, messageId]
    : [JSON.stringify(swipes), messageId];

  getDb().query(`UPDATE messages SET ${updates} WHERE id = ?`).run(...values);
  const updated = getMessage(userId, messageId)!;
  eventBus.emit(
    EventType.MESSAGE_SWIPED,
    {
      chatId: updated.chat_id,
      message: updated,
      action: "updated",
      swipeId: swipeIdx,
    },
    userId,
  );

  return updated;
}

export function deleteSwipe(userId: string, messageId: string, swipeIdx: number): Message | null {
  const msg = getMessage(userId, messageId);
  if (!msg || msg.swipes.length <= 1) return null; // can't delete last swipe
  if (swipeIdx < 0 || swipeIdx >= msg.swipes.length) return null;

  const previousSwipeId = msg.swipe_id;

  const swipes = [...msg.swipes];
  swipes.splice(swipeIdx, 1);

  const swipeDates = [...msg.swipe_dates];
  swipeDates.splice(swipeIdx, 1);

  // Adjust swipe_id: if deleted swipe was before or at current, shift back (min 0)
  let newSwipeId = msg.swipe_id;
  if (swipeIdx < msg.swipe_id) {
    newSwipeId = msg.swipe_id - 1;
  } else if (swipeIdx === msg.swipe_id) {
    newSwipeId = Math.min(msg.swipe_id, swipes.length - 1);
  }

  const newContent = swipes[newSwipeId] ?? swipes[0];

  getDb()
    .query("UPDATE messages SET swipes = ?, swipe_dates = ?, swipe_id = ?, content = ? WHERE id = ?")
    .run(JSON.stringify(swipes), JSON.stringify(swipeDates), newSwipeId, newContent, messageId);

  const updated = getMessage(userId, messageId)!;
  eventBus.emit(
    EventType.MESSAGE_SWIPED,
    {
      chatId: updated.chat_id,
      message: updated,
      action: "deleted",
      swipeId: swipeIdx,
      previousSwipeId,
    },
    userId,
  );
  return updated;
}

export function cycleSwipe(userId: string, messageId: string, direction: "left" | "right"): Message | null {
  const msg = getMessage(userId, messageId);
  if (!msg || msg.swipes.length <= 1) return msg;

  const nextIdx = direction === "left" ? msg.swipe_id - 1 : msg.swipe_id + 1;
  if (nextIdx < 0 || nextIdx >= msg.swipes.length) return msg;

  const previousSwipeId = msg.swipe_id;
  const nextContent = msg.swipes[nextIdx] ?? msg.content;

  getDb()
    .query("UPDATE messages SET swipe_id = ?, content = ? WHERE id = ?")
    .run(nextIdx, nextContent, messageId);

  const updated = getMessage(userId, messageId)!;
  eventBus.emit(
    EventType.MESSAGE_SWIPED,
    {
      chatId: updated.chat_id,
      message: updated,
      action: "navigated",
      swipeId: nextIdx,
      previousSwipeId,
    },
    userId,
  );
  return updated;
}

// --- Branching ---

export function branchChat(userId: string, chatId: string, atMessageId: string): Chat | null {
  const chat = getChat(userId, chatId);
  if (!chat) return null;

  const msg = getMessage(userId, atMessageId);
  if (!msg || msg.chat_id !== chatId) return null;

  const branchId = crypto.randomUUID();
  const newChatId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  // Branch names: "{baseName} — Branch at #{msgIndex}"
  const character = getCharacter(userId, chat.character_id);
  const baseName = (chat.name || character?.name || "Chat").replace(/\s+—\s+Branch.*$/i, "").replace(/\s+\(branch\s*\d*\)$/i, "");
  const branchLabel = `${baseName} — Branch at #${msg.index_in_chat}`;

  // De-duplicate if multiple branches @ same point
  const existing = getDb()
    .query("SELECT COUNT(*) as count FROM chats WHERE user_id = ? AND name LIKE ?")
    .get(userId, `${branchLabel}%`) as { count: number };
  const newName = existing.count > 0 ? `${branchLabel} (${existing.count + 1})` : branchLabel;

  const metadata = { ...chat.metadata, branched_from: chatId, branch_at_message: atMessageId };

  const db = getDb();
  const tx = db.transaction(() => {
    db.query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(newChatId, userId, chat.character_id, newName, JSON.stringify(metadata), now, now);

    const messages = db
      .query("SELECT * FROM messages WHERE chat_id = ? AND index_in_chat <= ? ORDER BY index_in_chat ASC")
      .all(chatId, msg.index_in_chat) as any[];

    const idMap = new Map<string, string>();

    for (const m of messages) {
      const newMsgId = crypto.randomUUID();
      idMap.set(m.id, newMsgId);
      
      // Relink parent_message_id to the new ID within this branch
      const parentId = m.parent_message_id ? (idMap.get(m.parent_message_id) || null) : null;

      db.query(
        `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, parent_message_id, branch_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        newMsgId,
        newChatId,
        m.index_in_chat,
        m.is_user,
        m.name,
        m.content,
        m.send_date,
        m.swipe_id,
        m.swipes,
        m.swipe_dates,
        m.extra,
        parentId,
        branchId,
        now
      );
    }
  });

  try {
    tx();
  } catch (err) {
    console.error("[chats] Branch failed:", err);
    return null;
  }

  return getChat(userId, newChatId);
}

// Branch tree

export type ChatTreeNode = {
  id: string
  name: string
  created_at: number
  updated_at: number
  message_count: number
  branch_at_message: string | null
  branch_message_index: number | null
  branch_message_preview: string | null
  children: ChatTreeNode[]
}

function buildSubTree(userId: string, chatId: string, visited: Set<string>, depth: number): ChatTreeNode | null {
  if (visited.has(chatId) || depth > 20) return null;
  visited.add(chatId);

  const chat = getChat(userId, chatId);
  if (!chat) return null;

  const db = getDb();
  const countRow = db.query("SELECT COUNT(*) as count FROM messages WHERE chat_id = ?").get(chatId) as { count: number } | null;
  const message_count = countRow?.count ?? 0;

  const childRows = db.query(
    `SELECT * FROM chats WHERE user_id = ? AND json_extract(metadata, '$.branched_from') = ? ORDER BY created_at ASC`
  ).all(userId, chatId) as any[];

  const children: ChatTreeNode[] = [];
  for (const row of childRows) {
    const child = buildSubTree(userId, row.id, visited, depth + 1);
    if (child) children.push(child);
  }

  const branchAtMessage = (chat.metadata.branch_at_message as string) ?? null;
  let branch_message_index: number | null = null;
  let branch_message_preview: string | null = null;

  if (branchAtMessage) {
    const branchMsg = db.query(
      "SELECT index_in_chat, content FROM messages WHERE (id = ? OR (chat_id = ? AND index_in_chat = (SELECT index_in_chat FROM messages WHERE id = ? LIMIT 1))) LIMIT 1"
    ).get(branchAtMessage, chatId, branchAtMessage) as { index_in_chat: number; content: string } | null;

    if (branchMsg) {
      branch_message_index = branchMsg.index_in_chat;
      // Msg preview first 80 chars, stripped of markdown/newlines
      const clean = branchMsg.content.replace(/[#*_~`>\n\r]+/g, ' ').replace(/\s+/g, ' ').trim();
      branch_message_preview = clean.length > 80 ? clean.slice(0, 77) + '...' : clean;
    }
  }

  return {
    id: chat.id,
    name: chat.name,
    created_at: chat.created_at,
    updated_at: chat.updated_at,
    message_count,
    branch_at_message: branchAtMessage,
    branch_message_index,
    branch_message_preview,
    children,
  };
}

export function getChatTree(userId: string, chatId: string): ChatTreeNode | null {
  const chat = getChat(userId, chatId);
  if (!chat) return null;

  const db = getDb();

  // Fast path: if this chat is not branched and has no children, return a simple leaf node
  if (!chat.metadata.branched_from) {
    const childCount = (db.query(
      "SELECT COUNT(*) as count FROM chats WHERE user_id = ? AND json_extract(metadata, '$.branched_from') = ?"
    ).get(userId, chatId) as { count: number })?.count ?? 0;

    if (childCount === 0) {
      const msgCount = (db.query("SELECT COUNT(*) as count FROM messages WHERE chat_id = ?").get(chatId) as { count: number })?.count ?? 0;
      return {
        id: chat.id,
        name: chat.name,
        created_at: chat.created_at,
        updated_at: chat.updated_at,
        message_count: msgCount,
        branch_at_message: null,
        branch_message_index: null,
        branch_message_preview: null,
        children: [],
      };
    }
  }

  // Full tree build: walk up to root, then recurse down
  let rootId = chatId;
  const ancestorVisited = new Set<string>();
  ancestorVisited.add(chatId);
  let current = chat;

  while (current.metadata.branched_from) {
    const parentId = current.metadata.branched_from as string;
    if (ancestorVisited.has(parentId)) break;
    ancestorVisited.add(parentId);
    const parent = getChat(userId, parentId);
    if (!parent) break;
    rootId = parentId;
    current = parent;
  }

  return buildSubTree(userId, rootId, new Set(), 0);
}

// --- Migration helpers ---

export function createChatRaw(userId: string, input: { character_id: string; name?: string; metadata?: Record<string, any>; created_at?: number; updated_at?: number }): Chat {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const createdAt = input.created_at ?? now;
  const updatedAt = input.updated_at ?? createdAt;

  getDb()
    .query("INSERT INTO chats (id, user_id, character_id, name, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.character_id, input.name || "", JSON.stringify(input.metadata || {}), createdAt, updatedAt);

  return getChat(userId, id)!;
}

export function bulkInsertMessages(chatId: string, messages: BulkMessageInput[]): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const insert = db.query(
    `INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, parent_message_id, branch_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const swipes = m.swipes && m.swipes.length > 0 ? m.swipes : [m.content];
      const swipeId = m.swipe_id ?? 0;
      const sendDate = m.send_date ?? now;
      // Use provided swipe_dates or fill all swipes with the message send_date
      const swipeDates = m.swipe_dates && m.swipe_dates.length === swipes.length
        ? m.swipe_dates
        : swipes.map(() => sendDate);

      insert.run(
        crypto.randomUUID(),
        chatId,
        i,
        m.is_user ? 1 : 0,
        m.name,
        m.content,
        sendDate,
        swipeId,
        JSON.stringify(swipes),
        JSON.stringify(swipeDates),
        JSON.stringify(m.extra || {}),
        null,
        null,
        sendDate
      );
    }
  });

  tx();

  // Update chat's updated_at to last message timestamp
  if (messages.length > 0) {
    const lastDate = messages[messages.length - 1].send_date ?? now;
    db.query("UPDATE chats SET updated_at = ? WHERE id = ?").run(lastDate, chatId);
  }

  return messages.length;
}

// --- Export ---

export function exportChat(userId: string, chatId: string): { chat: Chat; messages: Message[] } | null {
  const chat = getChat(userId, chatId);
  if (!chat) return null;
  const messages = getMessages(userId, chatId);
  return { chat, messages };
}

// --- Chat Vectorization (Incremental) ---

import * as vectorizationQueue from "./vectorization-queue.service";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

  export function stripReasoningTags(content: string): string {                                                                                                                       
    // Remove complete (closed) reasoning blocks                                                                                                                               
    let stripped = content.replace(                                                                                                                                            
      /\s*<(think|thinking|reasoning)>[\s\S]*?<\/\1>\s*/gi,                                                                                                                    
      ""                                                                                                                                                                       
    );                                                                                                                                                                         
    // Remove unclosed reasoning tags (interrupted generation)                                                                                                                 
    stripped = stripped.replace(/\s*<(think|thinking|reasoning)>[\s\S]*$/i, "");                                                                                               
    return stripped.trim();                                                                                                                                                    
  } 

interface ChatChunk {
  id: string;
  chat_id: string;
  start_message_id: string;
  end_message_id: string;
  message_ids: string[];
  content: string;
  token_count: number;
  vectorized_at: number | null;
  vector_model: string | null;
  retrieval_count: number;
  last_retrieved_at: number | null;
  message_count: number;
  created_at: number;
  updated_at: number;
}

function rowToChatChunk(row: any): ChatChunk {
  return {
    id: row.id,
    chat_id: row.chat_id,
    start_message_id: row.start_message_id,
    end_message_id: row.end_message_id,
    message_ids: JSON.parse(row.message_ids),
    content: row.content,
    token_count: row.token_count,
    vectorized_at: row.vectorized_at,
    vector_model: row.vector_model,
    retrieval_count: row.retrieval_count,
    last_retrieved_at: row.last_retrieved_at,
    message_count: row.message_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Get the last chunk for a chat, or null if no chunks exist.
 */
function getLastChatChunk(chatId: string): ChatChunk | null {
  const row = getDb()
    .query("SELECT * FROM chat_chunks WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(chatId) as any;
  return row ? rowToChatChunk(row) : null;
}

/**
 * Get all chunks for a chat.
 */
export function getChatChunks(userId: string, chatId: string): ChatChunk[] {
  const chat = getChat(userId, chatId);
  if (!chat) return [];

  const rows = getDb()
    .query("SELECT * FROM chat_chunks WHERE chat_id = ? ORDER BY created_at ASC")
    .all(chatId) as any[];

  return rows.map(rowToChatChunk);
}

/**
 * Determine if we should start a new chunk based on the last chunk and new message.
 */
async function shouldStartNewChunk(lastChunk: ChatChunk, newMessage: Message, userId: string): Promise<boolean> {
  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  const chatMemSettings = embeddingsSvc.resolveEffectiveChatMemorySettings(
    embeddingsSvc.loadChatMemorySettings(userId),
    cfg,
  );

  const newMessageTokens = estimateTokens(`[${newMessage.is_user ? "USER" : "CHARACTER"} | ${newMessage.name}]: ${newMessage.content}`);
  const wouldExceedTarget = lastChunk.token_count + newMessageTokens > chatMemSettings.chunkTargetTokens;

  const lastMessageIds = lastChunk.message_ids;
  const lastMessages = lastMessageIds.map(id => getMessage(userId, id)).filter(Boolean) as Message[];

  // Role boundary: always split when switching between user and character
  if (lastMessages.length > 0) {
    const lastIsUser = lastMessages[0].is_user;
    if (lastIsUser !== newMessage.is_user) return true;
  }

  // Token target: split same-role chunks when exceeding target
  if (wouldExceedTarget) return true;

  // Scene break detection
  if (chatMemSettings.splitOnSceneBreaks) {
    const trimmed = newMessage.content.trimStart();
    if (/^(---|===|\*\*\*|<scene_break\s*\/?>)/i.test(trimmed)) {
      return true;
    }
  }

  // Time gap detection
  if (chatMemSettings.splitOnTimeGapMinutes > 0 && lastMessages.length > 0) {
    const lastMsg = lastMessages[lastMessages.length - 1];
    if (lastMsg.send_date && newMessage.send_date) {
      const gapMs = Math.abs(newMessage.send_date - lastMsg.send_date);
      if (gapMs > chatMemSettings.splitOnTimeGapMinutes * 60 * 1000) {
        return true;
      }
    }
  }

  // Max messages per chunk
  if (chatMemSettings.maxMessagesPerChunk > 0 && lastChunk.message_count >= chatMemSettings.maxMessagesPerChunk) {
    return true;
  }

  return false;
}

/**
 * Create a new chunk from a set of messages.
 */
function createChatChunk(chatId: string, messages: Message[]): ChatChunk {
  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();
  const content = messages.map(m =>
    `[${m.is_user ? "USER" : "CHARACTER"} | ${m.name}]: ${sanitizeForVectorization(m.content)}`
  ).join("\n");
  const tokenCount = estimateTokens(content);
  const messageIds = messages.map(m => m.id);

  getDb()
    .query(
      `INSERT INTO chat_chunks (
        id, chat_id, start_message_id, end_message_id, message_ids, content,
        token_count, message_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      chatId,
      messages[0].id,
      messages[messages.length - 1].id,
      JSON.stringify(messageIds),
      content,
      tokenCount,
      messages.length,
      now,
      now
    );

  return getDb().query("SELECT * FROM chat_chunks WHERE id = ?").get(id) as any;
}

/**
 * Append a message to an existing chunk.
 */
function appendToChunk(chunkId: string, message: Message): void {
  const chunk = getDb().query("SELECT * FROM chat_chunks WHERE id = ?").get(chunkId) as any;
  if (!chunk) return;

  const messageIds = JSON.parse(chunk.message_ids);
  messageIds.push(message.id);

  const newContent = chunk.content + `\n[${message.is_user ? "USER" : "CHARACTER"} | ${message.name}]: ${sanitizeForVectorization(message.content)}`;
  const newTokenCount = estimateTokens(newContent);
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `UPDATE chat_chunks SET
        end_message_id = ?,
        message_ids = ?,
        content = ?,
        token_count = ?,
        message_count = ?,
        updated_at = ?,
        vectorized_at = NULL,
        vector_model = NULL
      WHERE id = ?`
    )
    .run(message.id, JSON.stringify(messageIds), newContent, newTokenCount, messageIds.length, now, chunkId);
}

/**
 * Update chunks incrementally when a new message is added.
 * This is called after message creation and only touches the last chunk.
 */
async function updateChatChunks(userId: string, chatId: string, newMessage: Message): Promise<void> {
  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_chat_messages) return;

  const lastChunk = getLastChatChunk(chatId);
  let chunkId: string;

  if (!lastChunk || (await shouldStartNewChunk(lastChunk, newMessage, userId))) {
    const newChunk = createChatChunk(chatId, [newMessage]);
    chunkId = newChunk.id;
    vectorizationQueue.queueChunkVectorization(userId, chatId, newChunk.id, 5);
  } else {
    appendToChunk(lastChunk.id, newMessage);
    chunkId = lastChunk.id;
    vectorizationQueue.queueChunkVectorization(userId, chatId, lastChunk.id, 5);
  }

  scheduleChatMemoryRefresh(userId, chatId, 8);

  // Memory Cortex: process chunk for entity extraction, salience scoring, etc.
  // Runs async and never blocks the main flow.
  try {
    const chunk = getDb().query("SELECT * FROM chat_chunks WHERE id = ?").get(chunkId) as any;
    if (chunk) {
      const chat = getChat(userId, chatId);
      const characterNames: string[] = [];
      const aliasMaps: Map<string, string>[] = [];
      if (chat) {
        const character = getCharacter(userId, chat.character_id);
        if (character) {
          // Normalize sloppy bot-card names to extract the real character name
          const normalized = memoryCortex.normalizeCharacterName(character.name);
          characterNames.push(normalized);
          aliasMaps.push(memoryCortex.extractDescriptionAliases(
            normalized, character.description, character.personality, character.scenario,
          ));
        }
        // Group chat: add all character names + extract aliases
        if (chat.metadata?.character_ids) {
          for (const cid of chat.metadata.character_ids as string[]) {
            const c = getCharacter(userId, cid);
            if (!c) continue;
            const normalized = memoryCortex.normalizeCharacterName(c.name);
            if (!characterNames.includes(normalized)) {
              characterNames.push(normalized);
              aliasMaps.push(memoryCortex.extractDescriptionAliases(normalized, c.description, c.personality));
            }
          }
        }
        // User's persona
        try {
          const { resolvePersonaOrDefault } = require("./personas.service");
          const persona = resolvePersonaOrDefault(userId);
          if (persona?.name) {
            const normalized = memoryCortex.normalizeCharacterName(persona.name);
            if (!characterNames.includes(normalized)) {
              characterNames.push(normalized);
              aliasMaps.push(memoryCortex.extractDescriptionAliases(normalized, persona.description));
            }
          }
        } catch { /* non-fatal */ }
      }
      // Merge aliases with collision detection (safe for group chats)
      const descriptionAliases = memoryCortex.mergeDescriptionAliases(...aliasMaps);

      // Resolve sidecar connection for Tier 2 features (LLM-assisted extraction).
      const cortexConfig = memoryCortex.getCortexConfig(userId);
      const sidecarConnectionId = cortexConfig.sidecar.connectionProfileId || undefined;

      // Resolve the provider from the connection profile for structured output injection
      let sidecarProvider: string | null = null;
      if (sidecarConnectionId) {
        const { getConnection } = require("./connections.service");
        const conn = getConnection(userId, sidecarConnectionId);
        sidecarProvider = conn?.provider ?? null;
      }

      // Build a generateRaw adapter. Injects structured output params (response_format /
      // responseMimeType + responseSchema) based on the provider so the LLM returns
      // valid JSON natively instead of relying on prompt engineering.
      const generateRawFn = sidecarConnectionId
        ? async (opts: { connectionId: string; messages: Array<{ role: string; content: string }>; parameters: Record<string, any>; tools?: any[]; signal?: AbortSignal }) => {
            const { quietGenerate } = await import("./generate.service");
            // Inject tool_choice to force the model to use tools
            const toolChoiceParams = sidecarProvider
              ? memoryCortex.getToolChoiceParams(sidecarProvider)
              : {};
            const sidecarParams: Record<string, any> = {
              temperature: cortexConfig.sidecar.temperature,
              top_p: cortexConfig.sidecar.topP,
              max_tokens: cortexConfig.sidecar.maxTokens,
              ...toolChoiceParams,
              ...opts.parameters,
            };
            if (cortexConfig.sidecar.model) {
              sidecarParams.model = cortexConfig.sidecar.model;
            }
            const result = await quietGenerate(userId, {
              connection_id: opts.connectionId,
              messages: opts.messages as any,
              parameters: sidecarParams,
              tools: opts.tools,
              signal: opts.signal,
            });
            return {
              content: typeof result.content === "string" ? result.content : "",
              tool_calls: result.tool_calls,
            };
          }
        : undefined;

      memoryCortex.processChunk(
        {
          chunkId: chunk.id,
          chatId,
          userId,
          content: chunk.content,
          messageIds: JSON.parse(chunk.message_ids || "[]"),
          startMessageIndex: 0,
          endMessageIndex: 0,
          createdAt: chunk.created_at,
        },
        characterNames,
        generateRawFn,
        sidecarConnectionId,
        descriptionAliases.size > 0 ? descriptionAliases : undefined,
      ).catch(err => {
        console.warn("[chats] Memory cortex processing failed:", err);
      });
    }
  } catch (err) {
    // Non-fatal: cortex processing should never break chunk creation
    console.warn("[chats] Memory cortex hook error:", err);
  }
}

/**
 * Get vectorization status for a chat.
 */
export function getVectorizationStatus(userId: string, chatId: string): {
  totalChunks: number;
  vectorizedChunks: number;
  pendingChunks: number;
  queueStatus: any;
} {
  const chat = getChat(userId, chatId);
  if (!chat) {
    return { totalChunks: 0, vectorizedChunks: 0, pendingChunks: 0, queueStatus: {} };
  }

  const stats = getDb()
    .query(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN vectorized_at IS NOT NULL THEN 1 ELSE 0 END) as vectorized
      FROM chat_chunks WHERE chat_id = ?`
    )
    .get(chatId) as any;

  return {
    totalChunks: stats?.total || 0,
    vectorizedChunks: stats?.vectorized || 0,
    pendingChunks: (stats?.total || 0) - (stats?.vectorized || 0),
    queueStatus: vectorizationQueue.getQueueStatus(),
  };
}

// ─── LTCM Config Hash — Stale Chunk Detection ────────────────

/**
 * Stamp the current LTCM config hash onto a chat's metadata.
 * Called after chunks are built/rebuilt so we can detect staleness later.
 */
async function stampChatMemoryHash(userId: string, chatId: string): Promise<void> {
  try {
    const cfg = embeddingsSvc.loadChatMemorySettings(userId);
    const embCfg = await embeddingsSvc.getEmbeddingConfig(userId);
    const effective = embeddingsSvc.resolveEffectiveChatMemorySettings(cfg, embCfg);
    const hash = embeddingsSvc.computeChatMemoryHash(effective, embCfg.model);

    const chat = getChat(userId, chatId);
    if (!chat) return;
    const metadata = { ...chat.metadata, ltcm_config_hash: hash };
    getDb().query("UPDATE chats SET metadata = ? WHERE id = ?").run(JSON.stringify(metadata), chatId);
  } catch { /* non-fatal */ }
}

/**
 * Check if a chat's chunks are stale (compiled under different settings or code version).
 * If stale, triggers a synchronous rebuild so the current generation uses fresh data.
 *
 * Returns true if a rebuild was triggered.
 */
export async function ensureChatMemoryFresh(userId: string, chatId: string): Promise<boolean> {
  try {
    const chat = getChat(userId, chatId);
    if (!chat) return false;

    const storedHash = (chat.metadata as any)?.ltcm_config_hash;

    const cfg = embeddingsSvc.loadChatMemorySettings(userId);
    const embCfg = await embeddingsSvc.getEmbeddingConfig(userId);
    if (!embCfg.enabled || !embCfg.vectorize_chat_messages) return false;

    const effective = embeddingsSvc.resolveEffectiveChatMemorySettings(cfg, embCfg);
    const currentHash = embeddingsSvc.computeChatMemoryHash(effective, embCfg.model);

    if (storedHash === currentHash) return false;

    // Hash mismatch — chunks are stale. Rebuild.
    console.info(`[chats] LTCM config hash mismatch for chat ${chatId} (stored: ${storedHash ?? "none"}, current: ${currentHash}). Rebuilding chunks.`);
    await rebuildChatChunks(userId, chatId);
    return true;
  } catch (err) {
    console.warn("[chats] LTCM freshness check failed:", err);
    return false;
  }
}

/**
 * Rebuild all chunks for a chat from scratch.
 * Used for migration or when chunk structure needs to be reset.
 */
export async function rebuildChatChunks(userId: string, chatId: string): Promise<void> {
  invalidateChatMemoryCache(chatId);

  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_chat_messages) return;

  const messages = getMessages(userId, chatId).filter(m => m.extra?.hidden !== true);
  if (messages.length === 0) return;

  getDb().query("DELETE FROM chat_chunks WHERE chat_id = ?").run(chatId);

  const chatMemSettings = embeddingsSvc.resolveEffectiveChatMemorySettings(
    embeddingsSvc.loadChatMemorySettings(userId),
    cfg,
  );
  const targetTokens = chatMemSettings.chunkTargetTokens;

  let currentChunk: Message[] = [];
  let currentTokens = 0;

  for (const msg of messages) {
    const sanitizedContent = sanitizeForVectorization(msg.content);
    const msgTokens = estimateTokens(`[${msg.is_user ? "USER" : "CHARACTER"} | ${msg.name}]: ${sanitizedContent}`);
    const wouldExceedTarget = currentTokens + msgTokens > targetTokens;

    let forceNewChunk = false;

    // Role boundary: split when switching between user and character messages
    if (currentChunk.length > 0 && currentChunk[0].is_user !== msg.is_user) {
      forceNewChunk = true;
    }

    // Token target: split when chunk would exceed target (same-role consecutive messages)
    if (currentChunk.length > 0 && wouldExceedTarget) {
      forceNewChunk = true;
    }

    // Scene break detection
    if (chatMemSettings.splitOnSceneBreaks && currentChunk.length > 0) {
      const trimmed = msg.content.trimStart();
      if (/^(---|===|\*\*\*|<scene_break\s*\/?>)/i.test(trimmed)) {
        forceNewChunk = true;
      }
    }

    // Time gap detection
    if (chatMemSettings.splitOnTimeGapMinutes > 0 && currentChunk.length > 0) {
      const lastMsg = currentChunk[currentChunk.length - 1];
      if (lastMsg.send_date && msg.send_date) {
        const gapMs = Math.abs(msg.send_date - lastMsg.send_date);
        if (gapMs > chatMemSettings.splitOnTimeGapMinutes * 60 * 1000) {
          forceNewChunk = true;
        }
      }
    }

    // Max messages per chunk
    if (chatMemSettings.maxMessagesPerChunk > 0 && currentChunk.length >= chatMemSettings.maxMessagesPerChunk) {
      forceNewChunk = true;
    }

    if (forceNewChunk) {
      const chunk = createChatChunk(chatId, currentChunk);
      vectorizationQueue.queueChunkVectorization(userId, chatId, chunk.id, 3);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(msg);
    currentTokens += msgTokens;
  }

  if (currentChunk.length > 0) {
    const chunk = createChatChunk(chatId, currentChunk);
    vectorizationQueue.queueChunkVectorization(userId, chatId, chunk.id, 3);
  }

  // Stamp the config hash so we can detect staleness later
  stampChatMemoryHash(userId, chatId);
  scheduleChatMemoryRefresh(userId, chatId, 9);

  console.info(`[chats] Rebuilt chunks for chat ${chatId}`);
}

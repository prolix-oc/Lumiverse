import type { Database } from "bun:sqlite";

/** The first revision is intentionally zero; every persisted mutation advances it. */
export const INITIAL_GENERATION_REVISION = 0 as const;

export interface ChatGenerationRevisionV1 {
  readonly chatId: string;
  readonly chatRevision: number;
  readonly messageId: string | null;
  readonly messageRevision: number | null;
}

function hasGenerationRevisionColumn(db: Database, table: "chats" | "messages"): boolean {
  const columns = db.query(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "generation_revision");
}

function readRevision(db: Database, table: "chats" | "messages", id: string, chatId?: string): number {
  if (!hasGenerationRevisionColumn(db, table)) return INITIAL_GENERATION_REVISION;
  const row = table === "chats"
    ? db.query("SELECT generation_revision FROM chats WHERE id = ?").get(id) as { generation_revision: number } | null
    : chatId === undefined
      ? db.query("SELECT generation_revision FROM messages WHERE id = ?").get(id) as { generation_revision: number } | null
      : db.query("SELECT generation_revision FROM messages WHERE id = ? AND chat_id = ?").get(id, chatId) as { generation_revision: number } | null;
  return row ? Number(row.generation_revision) || INITIAL_GENERATION_REVISION : INITIAL_GENERATION_REVISION;
}

/** Read revisions through the caller's connection/transaction. */
export function readChatGenerationRevision(
  db: Database,
  chatId: string,
  messageId?: string,
): ChatGenerationRevisionV1 | null {
  const chat = db
    .query("SELECT id FROM chats WHERE id = ?")
    .get(chatId) as { id: string } | null;
  if (!chat) return null;
  const chatRevision = readRevision(db, "chats", chatId);

  if (messageId === undefined) {
    return {
      chatId,
      chatRevision,
      messageId: null,
      messageRevision: null,
    };
  }

  const message = db
    .query("SELECT id FROM messages WHERE id = ? AND chat_id = ?")
    .get(messageId, chatId) as { id: string } | null;
  return {
    chatId,
    chatRevision,
    messageId: message?.id ?? null,
    messageRevision: message ? readRevision(db, "messages", messageId, chatId) : null,
  };
}

/** Advance a chat revision in the caller's transaction and return the new value. */
export function bumpChatGenerationRevision(
  db: Database,
  chatId: string,
  userId?: string,
): number | null {
  if (!hasGenerationRevisionColumn(db, "chats")) return null;
  const result = userId === undefined
    ? db.query(
      "UPDATE chats SET generation_revision = generation_revision + 1 WHERE id = ?",
    ).run(chatId)
    : db.query(
      "UPDATE chats SET generation_revision = generation_revision + 1 WHERE id = ? AND user_id = ?",
    ).run(chatId, userId);
  if (result.changes === 0) return null;
  return readRevision(db, "chats", chatId);
}

/** Advance a message revision in the caller's transaction and return the new value. */
export function bumpMessageGenerationRevision(
  db: Database,
  messageId: string,
  chatId?: string,
): number | null {
  if (!hasGenerationRevisionColumn(db, "messages")) return null;
  const result = chatId === undefined
    ? db.query(
      "UPDATE messages SET generation_revision = generation_revision + 1 WHERE id = ?",
    ).run(messageId)
    : db.query(
      "UPDATE messages SET generation_revision = generation_revision + 1 WHERE id = ? AND chat_id = ?",
    ).run(messageId, chatId);
  if (result.changes === 0) return null;
  return readRevision(db, "messages", messageId, chatId);
}
/** Atomically advance both sides of a chat/message mutation. The caller may
 * invoke this inside an existing `db.transaction`; no nested transaction is
 * opened, so the same SQLite transaction is reused.
 */
export function bumpChatAndMessageGenerationRevision(
  db: Database,
  chatId: string,
  messageId: string,
  userId?: string,
): ChatGenerationRevisionV1 | null {
  const messageRevision = bumpMessageGenerationRevision(db, messageId, chatId);
  if (messageRevision === null) return null;
  const chatRevision = bumpChatGenerationRevision(db, chatId, userId);
  if (chatRevision === null) return null;
  return {
    chatId,
    chatRevision,
    messageId,
    messageRevision,
  };
}

/**
 * Run one mutation using the caller's database connection. This helper is a
 * convenience for new transactional callers; existing Response callers keep
 * their established transaction boundaries.
 */
export function withChatGenerationRevisionTransaction<T>(
  db: Database,
  operation: () => T,
): T {
  return db.transaction(operation)();
}

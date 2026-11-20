import { getDb } from "../db/connection";

export function storeBreakdown(userId: string, messageId: string, chatId: string, data: any): void {
  const db = getDb();
  const json = typeof data === "string" ? data : JSON.stringify(data);
  db.run(
    `INSERT INTO message_breakdowns (message_id, chat_id, user_id, data)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET data = excluded.data, chat_id = excluded.chat_id, user_id = excluded.user_id`,
    [messageId, chatId, userId, json]
  );
}

export function getBreakdown(userId: string, messageId: string): any | null {
  const db = getDb();
  const row = db.query("SELECT data FROM message_breakdowns WHERE message_id = ? AND user_id = ?").get(messageId, userId) as any;
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export function deleteBreakdownsForChat(userId: string, chatId: string): void {
  const db = getDb();
  db.run("DELETE FROM message_breakdowns WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
}

export function deleteBreakdownForMessage(userId: string, messageId: string): void {
  const db = getDb();
  db.run("DELETE FROM message_breakdowns WHERE message_id = ? AND user_id = ?", [messageId, userId]);
}

/**
 * A breakdown stores the prompt history used to generate its message. Removing
 * an earlier message therefore invalidates every later breakdown in the chat,
 * even when those later messages remain visible.
 */
export function deleteBreakdownsAfterMessage(
  userId: string,
  chatId: string,
  messageIndex: number,
): void {
  const db = getDb();
  db.run(
    `DELETE FROM message_breakdowns
     WHERE user_id = ?
       AND message_id IN (
         SELECT id FROM messages
         WHERE chat_id = ? AND index_in_chat > ?
       )`,
    [userId, chatId, messageIndex],
  );
}

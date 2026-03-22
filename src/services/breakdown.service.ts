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

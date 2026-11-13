import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/connection";
import { parseMetadataObject } from "../db/chat-operations";
import { notificationPlainText } from "../utils/notification-text";

export const widgetIdentifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const lifetime = 90 * 24 * 3600 * 1000;
export interface WidgetCharacter { characterId: string; name: string; chatId: string | null; updatedAt: number }

function savedIds(userId: string, key: string): string[] {
  const row = getDb().query("SELECT value FROM settings WHERE user_id = ? AND key = ?").get(userId, key) as { value: string } | null;
  try { const value: unknown = JSON.parse(row?.value ?? "[]"); return Array.isArray(value) ? [...new Set(value.filter(widgetIdentifier))] : []; }
  catch { return []; }
}

/** Filter and deduplicate before bounding; no full characters or message reads. */
export function widgetSnapshot(userId: string) {
  const db = getDb();
  const hidden = new Set(savedIds(userId, "landingHiddenCharacterIds"));
  const recent: WidgetCharacter[] = [], latest = new Map<string, WidgetCharacter>();
  const rows = db.query(`SELECT c.id, c.character_id, c.metadata, c.updated_at, ch.name
    FROM chats c JOIN characters ch ON ch.id = c.character_id AND ch.user_id = c.user_id
    WHERE c.user_id = ? ORDER BY c.updated_at DESC, c.id ASC`).iterate(userId) as Iterable<{
      id: string; character_id: string; metadata: string; updated_at: number; name: string;
    }>;
  for (const row of rows) {
    const meta = parseMetadataObject(row.metadata);
    if (meta.group === true || meta.group === 1 || meta.temporary === true || meta.hidden_from_recent === true
      || !widgetIdentifier(row.character_id) || !widgetIdentifier(row.id) || latest.has(row.character_id)) continue;
    const item = { characterId: row.character_id, name: notificationPlainText(row.name, 80) || "Character", chatId: row.id, updatedAt: row.updated_at };
    latest.set(row.character_id, item);
    if (!hidden.has(row.character_id) && recent.length < 16) recent.push(item);
  }
  const favorites: WidgetCharacter[] = [];
  const character = db.query("SELECT name, updated_at FROM characters WHERE id = ? AND user_id = ?");
  for (const id of savedIds(userId, "favorites")) {
    const row = character.get(id, userId) as { name: string; updated_at: number } | null;
    if (!row) continue;
    favorites.push(latest.get(id) ?? { characterId: id, name: notificationPlainText(row.name, 80) || "Character", chatId: null, updatedAt: row.updated_at });
    if (favorites.length === 16) break;
  }
  return { version: 1 as const, accountId: userId, generatedAt: Date.now(), recent, favorites };
}

export function prepareWidgets(userId: string, deviceId: unknown) {
  if (!widgetIdentifier(deviceId) || deviceId.length < 16) throw new Error("Invalid widget installation");
  const db = getDb(), registrationId = crypto.randomUUID(), credential = randomBytes(32).toString("base64url"), expiresAt = Date.now() + lifetime;
  db.transaction(() => {
    db.query("DELETE FROM ios_widget_registrations WHERE expires_at <= ?").run(Date.now());
    db.query("DELETE FROM ios_widget_registrations WHERE user_id = ? AND device_id = ?").run(userId, deviceId);
    const row = db.query("SELECT COUNT(*) AS count FROM ios_widget_registrations WHERE user_id = ?").get(userId) as { count: number };
    if (row.count >= 32) throw new Error("Too many widget installations");
    db.query("INSERT INTO ios_widget_registrations VALUES (?, ?, ?, ?, ?)").run(registrationId, userId, deviceId, hash(credential), expiresAt);
  })();
  return { registrationId, credential, accountId: userId, expiresAt };
}
export function widgetOwner(id: string, credential: string) {
  if (!widgetIdentifier(id) || !/^[A-Za-z0-9_-]{43}$/.test(credential)) return null;
  const row = getDb().query(`SELECT r.user_id FROM ios_widget_registrations r JOIN "user" u ON u.id = r.user_id
    WHERE r.id = ? AND r.credential_hash = ? AND r.expires_at > ? AND COALESCE(u.banned, 0) = 0`).get(id, hash(credential), Date.now()) as { user_id: string } | null;
  return row?.user_id ?? null;
}
export function revokeWidgets(id: string, userId: string) {
  getDb().query("DELETE FROM ios_widget_registrations WHERE id = ? AND user_id = ?").run(id, userId);
}

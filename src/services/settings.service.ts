import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

export interface Setting {
  key: string;
  value: any;
  updated_at: number;
}

export function getAllSettings(userId: string): Setting[] {
  const rows = getDb().query("SELECT key, value, updated_at FROM settings WHERE user_id = ?").all(userId) as any[];
  return rows.map((r) => ({ ...r, value: JSON.parse(r.value) }));
}

export function getSetting(userId: string, key: string): Setting | null {
  const row = getDb().query("SELECT key, value, updated_at FROM settings WHERE key = ? AND user_id = ?").get(key, userId) as any;
  if (!row) return null;
  return { ...row, value: JSON.parse(row.value) };
}

export function getSettingsByKeys(userId: string, keys: string[]): Map<string, any> {
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => "?").join(", ");
  const rows = getDb()
    .query(`SELECT key, value FROM settings WHERE user_id = ? AND key IN (${placeholders})`)
    .all(userId, ...keys) as any[];
  const result = new Map<string, any>();
  for (const row of rows) {
    result.set(row.key, JSON.parse(row.value));
  }
  return result;
}

export function putSetting(userId: string, key: string, value: any): Setting {
  const json = JSON.stringify(value);
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(key, json, userId, now);

  const setting = { key, value, updated_at: now };
  eventBus.emit(EventType.SETTINGS_UPDATED, { key, value }, userId);
  return setting;
}

export function putMany(userId: string, settings: Record<string, any>): Setting[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const results: Setting[] = [];

  const upsert = db.query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      const json = JSON.stringify(value);
      upsert.run(key, json, userId, now);
      results.push({ key, value, updated_at: now });
    }
  });
  transaction();

  eventBus.emit(EventType.SETTINGS_UPDATED, { keys: Object.keys(settings) }, userId);
  return results;
}

export function deleteSetting(userId: string, key: string): boolean {
  const result = getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId);
  return result.changes > 0;
}

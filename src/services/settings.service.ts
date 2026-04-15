import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

export interface Setting {
  key: string;
  value: any;
  updated_at: number;
}

const MAX_SETTING_KEY_LENGTH = 200;
const MAX_SETTING_VALUE_BYTES = 2 * 1024 * 1024; // 2 MB serialized JSON
const SETTING_KEY_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export class InvalidSettingError extends Error {
  status = 400 as const;
}

function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_SETTING_KEY_LENGTH) {
    throw new InvalidSettingError(
      `Setting key must be a non-empty string ≤${MAX_SETTING_KEY_LENGTH} chars`,
    );
  }
  if (!SETTING_KEY_PATTERN.test(key)) {
    throw new InvalidSettingError(
      "Setting key may only contain letters, digits, '.', '_', and '-'",
    );
  }
}

function serializeValueOrThrow(key: string, value: unknown): string {
  // Settings storage is opaque JSON; reject payloads that would otherwise
  // bloat the DB or block the event loop on every read.
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch (err: any) {
    throw new InvalidSettingError(`Setting "${key}" value is not JSON-serializable: ${err?.message || "unknown"}`);
  }
  if (json.length > MAX_SETTING_VALUE_BYTES) {
    throw new InvalidSettingError(
      `Setting "${key}" exceeds ${MAX_SETTING_VALUE_BYTES} bytes serialized`,
    );
  }
  return json;
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
  assertValidKey(key);
  const json = serializeValueOrThrow(key, value);
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

const MAX_SETTINGS_PER_BULK_PUT = 200;

export function putMany(userId: string, settings: Record<string, any>): Setting[] {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new InvalidSettingError("settings payload must be an object");
  }
  const entries = Object.entries(settings);
  if (entries.length > MAX_SETTINGS_PER_BULK_PUT) {
    throw new InvalidSettingError(
      `Cannot upsert more than ${MAX_SETTINGS_PER_BULK_PUT} settings in one request`,
    );
  }
  // Validate everything before opening the transaction so an invalid entry
  // doesn't leave us in a partially-applied state.
  const prepared: Array<{ key: string; value: any; json: string }> = [];
  for (const [key, value] of entries) {
    assertValidKey(key);
    prepared.push({ key, value, json: serializeValueOrThrow(key, value) });
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const results: Setting[] = [];

  const upsert = db.query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  );

  const transaction = db.transaction(() => {
    for (const { key, value, json } of prepared) {
      upsert.run(key, json, userId, now);
      results.push({ key, value, updated_at: now });
    }
  });
  transaction();

  eventBus.emit(EventType.SETTINGS_UPDATED, { keys: prepared.map((p) => p.key) }, userId);
  return results;
}

export function deleteSetting(userId: string, key: string): boolean {
  const result = getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId);
  return result.changes > 0;
}

import { putSettingsWithDb } from "../db/settings-operations";
import { assertValidKey, serializeValueOrThrow, InvalidSettingError } from "./settings-validation";
export { InvalidSettingError, MAX_SAVED_THEMES_VALUE_BYTES } from "./settings-validation";
import { getDb } from "../db/connection";
import { executeDatabaseOperation } from "../db/execution";
import { readDatabaseRow, readDatabaseRows, runDatabaseStatement } from "../db/queries";
import { hasEnabledExtensionForUser } from "../spindle/extension-availability";
import { REQUEST_HISTORY_SETTING, requestHistoryStore } from "./request-history-store";
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

export function getSettingAcrossUsers(key: string): Array<{ user_id: string; value: any }> {
  const rows = getDb().query("SELECT user_id, value FROM settings WHERE key = ?").all(key) as any[];
  return rows.map((r) => ({ user_id: r.user_id, value: JSON.parse(r.value) }));
}

/**
 * The `editAndSendAlwaysUseActiveConnection` Productivity setting, read from the
 * persisted per-user `quickToolbarSettings` blob.
 *
 * Lives here rather than in `generate.service` because BOTH ends of the
 * Edit-and-Send flow need the identical answer and must not be able to drift:
 * `chats.service.editAndSend` reads it once at COMMIT time to record the
 * resolved connection on the outbox row, and `generate.service` reads it on the
 * legacy path for rows committed before that column existed. A duplicated
 * predicate is exactly how the two would diverge.
 *
 * Strict `=== true`: an absent row, an absent key, `null`, `undefined`, a
 * non-object or array value, an explicit `false`, and the coercible `"true"` /
 * `0` all mean OFF. No truthiness coercion anywhere, so an explicit `false`
 * cannot be flipped. Frontend defaults are deliberately NOT merged server-side
 * (`DEFAULT_QUICK_TOOLBAR_SETTINGS` is a frontend module) — a default merge is
 * the one way a wrong value could be reintroduced. Only the CANONICAL
 * `quickToolbarSettings` row is read; the namespaced compatibility mirror
 * `spindle:lumiverse_suite:quick_toolbar:quickToolbarSettings` is never
 * authoritative. The opt-in also requires an enabled Suite installation that
 * is visible to the acting user; retained preferences alone cannot enable it.
 */
export function readEditAndSendAlwaysUseActiveConnection(userId: string): boolean {
  const value = getSetting(userId, "quickToolbarSettings")?.value;
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).editAndSendAlwaysUseActiveConnection === true
    && hasEnabledExtensionForUser(userId, "lumiverse_suite");
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

export function putSetting(
  userId: string,
  key: string,
  value: any,
  options: { suppressBroadcast?: boolean } = {},
): Setting {
  assertValidKey(key);
  const json = serializeValueOrThrow(key, value);
  const now = Math.floor(Date.now() / 1000);
  putSettingsWithDb(getDb(), userId, [{ key, json }], now);

  const setting = { key, value, updated_at: now };
  if (key === REQUEST_HISTORY_SETTING && value !== true) requestHistoryStore.clear(userId);
  if (!options.suppressBroadcast) {
    eventBus.emit(EventType.SETTINGS_UPDATED, { key, value }, userId);
  }
  if (!options.suppressBroadcast && key === "activeChatId") {
    eventBus.emit(EventType.CHAT_SWITCHED, { chatId: typeof value === "string" ? value : null }, userId);
  }
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

  const now = Math.floor(Date.now() / 1000);
  putSettingsWithDb(getDb(), userId, prepared, now);
  const results = prepared.map(({ key, value }) => ({ key, value, updated_at: now }));

  if (prepared.some((entry) => entry.key === REQUEST_HISTORY_SETTING && entry.value !== true)) {
    requestHistoryStore.clear(userId);
  }

  eventBus.emit(EventType.SETTINGS_UPDATED, { keys: prepared.map((p) => p.key) }, userId);
  const activeChatEntry = prepared.find((p) => p.key === "activeChatId");
  if (activeChatEntry) {
    eventBus.emit(EventType.CHAT_SWITCHED, { chatId: typeof activeChatEntry.value === "string" ? activeChatEntry.value : null }, userId);
  }
  return results;
}

export function deleteSetting(userId: string, key: string): boolean {
  if (key === REQUEST_HISTORY_SETTING) requestHistoryStore.clear(userId);
  const result = getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId);
  return result.changes > 0;
}

export async function getAllSettingsAsync(userId: string): Promise<Setting[]> {
  const rows = await readDatabaseRows<{ key: string; value: string; updated_at: number }>("SELECT key, value, updated_at FROM settings WHERE user_id = ?", [userId]);
  return rows.map((row) => ({ ...row, value: JSON.parse(row.value) }));
}

export async function getSettingAsync(userId: string, key: string): Promise<Setting | null> {
  const row = await readDatabaseRow<{ key: string; value: string; updated_at: number }>("SELECT key, value, updated_at FROM settings WHERE key = ? AND user_id = ?", [key, userId]);
  return row ? { ...row, value: JSON.parse(row.value) } : null;
}

export async function getSettingsByKeysAsync(userId: string, keys: string[]): Promise<Map<string, any>> {
  if (keys.length === 0) return new Map();
  const rows = await readDatabaseRows<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE user_id = ? AND key IN (${keys.map(() => "?").join(", ")})`, [userId, ...keys]);
  return new Map(rows.map((row) => [row.key, JSON.parse(row.value)]));
}

export async function putSettingAsync(userId: string, key: string, value: any, options: { suppressBroadcast?: boolean } = {}): Promise<Setting> {
  assertValidKey(key);
  const json = serializeValueOrThrow(key, value);
  const now = Math.floor(Date.now() / 1000);
  await executeDatabaseOperation({ kind: "settings-put", userId, entries: [{ key, json }], updatedAt: now });
  if (key === REQUEST_HISTORY_SETTING && value !== true) requestHistoryStore.clear(userId);
  if (!options.suppressBroadcast) {
    eventBus.emit(EventType.SETTINGS_UPDATED, { key, value }, userId);
    if (key === "activeChatId") eventBus.emit(EventType.CHAT_SWITCHED, { chatId: typeof value === "string" ? value : null }, userId);
  }
  return { key, value, updated_at: now };
}

export async function putManyAsync(userId: string, settings: Record<string, any>): Promise<Setting[]> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new InvalidSettingError("settings payload must be an object");
  const entries = Object.entries(settings);
  if (entries.length > MAX_SETTINGS_PER_BULK_PUT) throw new InvalidSettingError(`Cannot upsert more than ${MAX_SETTINGS_PER_BULK_PUT} settings in one request`);
  const prepared = entries.map(([key, value]) => {
    assertValidKey(key);
    return { key, value, json: serializeValueOrThrow(key, value) };
  });
  const now = Math.floor(Date.now() / 1000);
  await executeDatabaseOperation({ kind: "settings-put", userId, entries: prepared.map(({ key, json }) => ({ key, json })), updatedAt: now });
  if (prepared.some((entry) => entry.key === REQUEST_HISTORY_SETTING && entry.value !== true)) requestHistoryStore.clear(userId);
  eventBus.emit(EventType.SETTINGS_UPDATED, { keys: prepared.map((entry) => entry.key) }, userId);
  const activeChat = prepared.find((entry) => entry.key === "activeChatId");
  if (activeChat) eventBus.emit(EventType.CHAT_SWITCHED, { chatId: typeof activeChat.value === "string" ? activeChat.value : null }, userId);
  return prepared.map(({ key, value }) => ({ key, value, updated_at: now }));
}

export async function deleteSettingAsync(userId: string, key: string): Promise<boolean> {
  const result = await runDatabaseStatement("DELETE FROM settings WHERE key = ? AND user_id = ?", [key, userId]);
  if (key === REQUEST_HISTORY_SETTING) requestHistoryStore.clear(userId);
  return result.changes > 0;
}

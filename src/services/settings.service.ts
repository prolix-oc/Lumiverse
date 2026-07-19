import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import {
  worldBookVectorDesiredStatusSql,
} from "./world-book-vector-state";
import { WORLD_BOOK_VECTOR_SETTINGS_KEY } from "./world-book-vector-constants";
import {
  DispatchStateError,
  withDispatchStateTransactionInExistingTransaction,
  stableDispatchJson,
  type DispatchDescriptorResolutionInput,
  type DispatchStateTransaction,
} from "./dispatch-state.service";

export interface Setting {
  key: string;
  value: any;
  updated_at: number;
}

const MAX_SETTING_KEY_LENGTH = 200;
const MAX_SETTING_VALUE_BYTES = 2 * 1024 * 1024; // 2 MB serialized JSON
// Theme packs embed their assets as base64 in savedThemes. A fully supported
// 250 MiB theme archive expands to about 333 MiB when represented as JSON, so
// this leaves room for the manifest and saved-theme metadata.
export const MAX_SAVED_THEMES_VALUE_BYTES = 350 * 1024 * 1024;
const SETTING_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export class InvalidSettingError extends Error {
  status = 400 as const;
}

function markWorldBookVectorStatesStaleForSettingsChange(userId: string): void {
  getDb().query(
    `UPDATE world_book_entries
     SET vector_index_status = ${worldBookVectorDesiredStatusSql()},
         vector_indexed_at = NULL,
         vector_index_error = NULL
     WHERE world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)`
  ).run(userId);
}

function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_SETTING_KEY_LENGTH) {
    throw new InvalidSettingError(
      `Setting key must be a non-empty string ≤${MAX_SETTING_KEY_LENGTH} chars`,
    );
  }
  if (!SETTING_KEY_PATTERN.test(key)) {
    throw new InvalidSettingError(
      "Setting key may only contain letters, digits, '.', '_', '-', and ':'",
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
  const maxBytes = key === "savedThemes"
    ? MAX_SAVED_THEMES_VALUE_BYTES
    : MAX_SETTING_VALUE_BYTES;
  if (json.length > maxBytes) {
    throw new InvalidSettingError(
      `Setting "${key}" exceeds ${maxBytes} bytes serialized`,
    );
  }
  return json;
}

function settingValueChanged(
  existingRaw: string | undefined,
  value: unknown,
  serialized: string,
): boolean {
  if (existingRaw === undefined) return true;
  try {
    return stableDispatchJson(JSON.parse(existingRaw)) !== stableDispatchJson(value);
  } catch {
    return existingRaw !== serialized;
  }
}

export function isDispatchAffectingSettingKey(key: string): boolean {
  return key === "activeLoomPresetId"
    || key === "reasoningSettings"
    || key === "presetProfileDefaults"
    || key.startsWith("presetProfileDefaults:")
    || key.startsWith("presetProfile:character:")
    || key.startsWith("presetProfile:chat:")
    || key.startsWith("presetProfile:connection:");
}

function dispatchInputForSetting(
  key: string,
  value: unknown,
): DispatchDescriptorResolutionInput {
  if (key === "activeLoomPresetId") {
    return {
      source: "main",
      presetId: typeof value === "string" && value.trim() ? value : undefined,
    };
  }
  if (key === "reasoningSettings") {
    return { source: "main", reasoning: value ?? null };
  }
  return { source: "main", settings: { [key]: value ?? null } };
}

function finalizeDispatchMutation(
  transaction: DispatchStateTransaction,
  input: DispatchDescriptorResolutionInput,
): void {
  const before = transaction.read();
  try {
    transaction.resolve(input);
  } catch (error) {
    if (
      error instanceof DispatchStateError
      && (
        error.code === "DISPATCH_CONNECTION_NOT_FOUND"
        || error.code === "DISPATCH_CONNECTION_UNRESOLVED"
        || error.code === "DISPATCH_CONNECTION_ROULETTE_UNSUPPORTED"
        || error.code === "DISPATCH_PRESET_NOT_FOUND"
      )
    ) {
      transaction.mutate({ incrementGeneration: true });
      return;
    }
    throw error;
  }
  if (transaction.read().revision === before.revision) {
    transaction.mutate({ incrementGeneration: true });
  }
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
  const db = getDb();
  const existingRow = db
    .query("SELECT value FROM settings WHERE key = ? AND user_id = ?")
    .get(key, userId) as { value: string } | null;
  const changed = settingValueChanged(existingRow?.value, value, json);
  const write = (): void => {
    db
      .query(
        `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, json, userId, now);
  };

  if (isDispatchAffectingSettingKey(key) && changed) {
    db.transaction(() => {
      write();
      withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
        finalizeDispatchMutation(transaction, dispatchInputForSetting(key, value));
      });
    })();
  } else {
    write();
  }

  if (key === WORLD_BOOK_VECTOR_SETTINGS_KEY && changed) {
    markWorldBookVectorStatesStaleForSettingsChange(userId);
  }

  const setting = { key, value, updated_at: now };
  eventBus.emit(EventType.SETTINGS_UPDATED, { key, value }, userId);
  if (key === "activeChatId") {
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

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const results: Setting[] = [];
  const existingValues = new Map<string, string>();
  if (prepared.length > 0) {
    const rows = db
      .query(`SELECT key, value FROM settings WHERE user_id = ? AND key IN (${prepared.map(() => "?").join(", ")})`)
      .all(userId, ...prepared.map((entry) => entry.key)) as Array<{ key: string; value: string }>;
    for (const row of rows) existingValues.set(row.key, row.value);
  }

  const upsert = db.query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const write = (): void => {
    for (const { key, value, json } of prepared) {
      upsert.run(key, json, userId, now);
      results.push({ key, value, updated_at: now });
    }
  };

  const changedDispatch = prepared.filter(
    (entry) => isDispatchAffectingSettingKey(entry.key)
      && settingValueChanged(existingValues.get(entry.key), entry.value, entry.json),
  );
  if (changedDispatch.length > 0) {
    db.transaction(() => {
      write();

      const activeEntry = changedDispatch.find((entry) => entry.key === "activeLoomPresetId");
      const reasoningEntry = changedDispatch.find((entry) => entry.key === "reasoningSettings");
      let activeValue: unknown = activeEntry?.value;
      let reasoningValue: unknown = reasoningEntry?.value;
      if (activeEntry === undefined) {
        const storedActive = existingValues.get("activeLoomPresetId");
        if (storedActive !== undefined) {
          try {
            activeValue = JSON.parse(storedActive);
          } catch {
            activeValue = undefined;
          }
        }
      }
      if (reasoningEntry === undefined) {
        const storedReasoning = existingValues.get("reasoningSettings");
        if (storedReasoning !== undefined) {
          try {
            reasoningValue = JSON.parse(storedReasoning);
          } catch {
            reasoningValue = undefined;
          }
        }
      }
      const profileSettings = Object.fromEntries(
        changedDispatch
          .filter((entry) => entry.key !== "activeLoomPresetId" && entry.key !== "reasoningSettings")
          .map((entry) => [entry.key, entry.value]),
      );
      withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
        finalizeDispatchMutation(transaction, {
          source: "main",
          presetId: typeof activeValue === "string" && activeValue.trim() ? activeValue : undefined,
          reasoning: reasoningValue,
          settings: Object.keys(profileSettings).length > 0 ? profileSettings : undefined,
        });
      });
    })();
  } else {
    db.transaction(write)();
  }

  const worldBookVectorSettingsChanged = prepared.some(
    (entry) => entry.key === WORLD_BOOK_VECTOR_SETTINGS_KEY
      && settingValueChanged(existingValues.get(entry.key), entry.value, entry.json),
  );
  if (worldBookVectorSettingsChanged) {
    markWorldBookVectorStatesStaleForSettingsChange(userId);
  }

  eventBus.emit(EventType.SETTINGS_UPDATED, { keys: prepared.map((p) => p.key) }, userId);
  const activeChatEntry = prepared.find((p) => p.key === "activeChatId");
  if (activeChatEntry) {
    eventBus.emit(EventType.CHAT_SWITCHED, { chatId: typeof activeChatEntry.value === "string" ? activeChatEntry.value : null }, userId);
  }
  return results;
}

export function deleteSetting(userId: string, key: string): boolean {
  const db = getDb();
  let deleted = false;
  if (isDispatchAffectingSettingKey(key)) {
    db.transaction(() => {
      deleted = db
        .query("DELETE FROM settings WHERE key = ? AND user_id = ?")
        .run(key, userId)
        .changes > 0;
      if (!deleted) return;
      withDispatchStateTransactionInExistingTransaction(userId, (transaction) => {
        finalizeDispatchMutation(transaction, dispatchInputForSetting(key, undefined));
      });
    })();
    return deleted;
  }
  deleted = db.query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(key, userId).changes > 0;
  return deleted;
}

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as profiles from "./preset-profiles.service";
import { deleteConnection } from "./connections.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run("CREATE TABLE settings (key TEXT, user_id TEXT, value TEXT, updated_at INTEGER DEFAULT 0, PRIMARY KEY (key, user_id))");
  getDb().run("CREATE TABLE connection_profiles (id TEXT, user_id TEXT)");
  getDb().run("CREATE TABLE secrets (key TEXT, user_id TEXT)");
});
afterEach(() => closeDatabase());

for (const [key, remove] of [
  ["presetProfileDefaults:id", () => profiles.deleteDefaults("user", "id")],
  ["presetProfile:character:id", () => profiles.deleteCharacterBinding("user", "id")],
  ["presetProfile:persona:id", () => profiles.deletePersonaBinding("user", "id")],
  ["presetProfile:chat:id", () => profiles.deleteChatBinding("user", "id")],
  ["presetProfile:connection:id", () => profiles.deleteConnectionBinding("user", "id")],
  ["connection", () => deleteConnection("user", "id")],
] as const) {
  test(`profile deletion notifies caches only after an owned deletion: ${key}`, async () => {
    getDb().query("INSERT INTO settings (key, user_id, value) VALUES (?, 'user', '{}')").run(key);
    getDb().query("INSERT INTO settings (key, user_id, value) VALUES (?, 'other', '{}')").run(key);
    getDb().run("INSERT INTO connection_profiles VALUES ('id', 'user')");
    getDb().run("INSERT INTO connection_profiles VALUES ('id', 'other')");
    const emit = spyOn(eventBus, "emit").mockImplementation(() => {});
    try {
      expect(await remove()).toBe(true);
      const events = emit.mock.calls.filter(([event]) => event === EventType.PRESET_PROFILE_CHANGED)
        .map(([event, payload, userId, options]) => ({ event, payload, userId, options }));
      expect(events).toEqual([{ event: EventType.PRESET_PROFILE_CHANGED,
        payload: { key: key === "connection" ? "presetProfile:connection:id" : key, binding: null }, userId: "user", options: undefined }]);
      emit.mockClear();
      expect(await remove()).toBe(false);
      expect(emit).not.toHaveBeenCalled();
    } finally { emit.mockRestore(); }
    expect(getDb().query("SELECT * FROM settings WHERE user_id = 'other'").all()).toHaveLength(1);
    expect(getDb().query("SELECT * FROM connection_profiles WHERE user_id = 'other'").all()).toHaveLength(1);
  });
}

test("legacy default deletion also announces invalidation", () => {
  getDb().run(`INSERT INTO settings (key, user_id, value) VALUES ('presetProfileDefaults', 'user', '{"preset_id":"id"}')`);
  const result = eventBus.withBufferedEvents(() => profiles.deleteDefaults("user", "id"));
  expect(result.value).toBe(true);
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.payload).toEqual({ key: "presetProfileDefaults:id", binding: null });
});

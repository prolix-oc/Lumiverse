import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { putSetting } from "./settings.service";
import { STARTUP_SETTINGS_KEYS, getStartupSettings } from "./bootstrap.service";

function initSettingsDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, user_id)
  )`);
}

beforeEach(initSettingsDb);
afterEach(() => closeDatabase());

describe("bootstrap.service activeProfileId serialization", () => {
  test("includes activeProfileId in STARTUP_SETTINGS_KEYS and serializes string or null", () => {
    expect(STARTUP_SETTINGS_KEYS).toContain("activeProfileId");

    putSetting("u1", "activeProfileId", "profile-xyz");
    expect(getStartupSettings("u1").activeProfileId).toBe("profile-xyz");

    putSetting("u1", "activeProfileId", null);
    expect(getStartupSettings("u1").activeProfileId).toBeNull();

    putSetting("u1", "activeProfileId", 42);
    expect(getStartupSettings("u1").activeProfileId).toBeUndefined();
  });
});

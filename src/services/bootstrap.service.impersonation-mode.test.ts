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

describe("bootstrap.service default impersonation mode serialization", () => {
  test("includes and serializes every supported mode", () => {
    expect(STARTUP_SETTINGS_KEYS).toContain("defaultImpersonationMode");

    for (const mode of ["prompts", "preset", "oneliner"] as const) {
      putSetting("u1", "defaultImpersonationMode", mode);
      expect(getStartupSettings("u1").defaultImpersonationMode).toBe(mode);
    }
  });

  test("omits absent or invalid values", () => {
    expect(getStartupSettings("u1").defaultImpersonationMode).toBeUndefined();

    for (const value of ["invalid", "", 42, null, true, ["preset"]]) {
      putSetting("u1", "defaultImpersonationMode", value);
      expect(getStartupSettings("u1").defaultImpersonationMode).toBeUndefined();
    }
  });
});

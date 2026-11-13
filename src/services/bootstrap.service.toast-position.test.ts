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

describe("bootstrap.service toastPosition serialization", () => {
  test("includes toastPosition in STARTUP_SETTINGS_KEYS and serializes only allowed values", () => {
    expect(STARTUP_SETTINGS_KEYS).toContain("toastPosition");

    const allowed = [
      "top-right", "top-left", "bottom-right", "bottom-left", "top", "bottom",
    ] as const;
    for (const position of allowed) {
      putSetting("u1", "toastPosition", position);
      expect(getStartupSettings("u1").toastPosition).toBe(position);
    }

    const invalid = ["bottom-center", "", 42, null, true, ["top"], { position: "top" }];
    for (const value of invalid) {
      putSetting("u1", "toastPosition", value);
      expect(getStartupSettings("u1").toastPosition).toBeUndefined();
    }
  });

  test("omits toastPosition when the row is absent and keeps users isolated", () => {
    expect(getStartupSettings("no-such-user").toastPosition).toBeUndefined();

    putSetting("u2", "toastPosition", "top-left");
    expect(getStartupSettings("u2").toastPosition).toBe("top-left");
    expect(getStartupSettings("u1").toastPosition).toBeUndefined();
  });
});

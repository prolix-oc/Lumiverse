import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { putSetting } from "./settings.service";
import { STARTUP_SETTINGS_KEYS, getStartupSettings } from "./bootstrap.service";

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, user_id)
  )`);
});
afterEach(() => closeDatabase());

describe("bootstrap greeting image preferences", () => {
  test("includes validated visibility and placement before the first chat renders", () => {
    expect(STARTUP_SETTINGS_KEYS).toContain("showGreetingImage");
    expect(STARTUP_SETTINGS_KEYS).toContain("greetingImagePosition");

    for (const enabled of [true, false]) {
      putSetting("u1", "showGreetingImage", enabled);
      expect(getStartupSettings("u1").showGreetingImage).toBe(enabled);
    }
    for (const position of ["top", "bottom"] as const) {
      putSetting("u1", "greetingImagePosition", position);
      expect(getStartupSettings("u1").greetingImagePosition).toBe(position);
    }
  });

  test("omits absent and invalid values", () => {
    expect(getStartupSettings("u1").showGreetingImage).toBeUndefined();
    expect(getStartupSettings("u1").greetingImagePosition).toBeUndefined();
    for (const value of ["true", "false", 1, 0, null, [], { enabled: true }]) {
      putSetting("u1", "showGreetingImage", value);
      expect(getStartupSettings("u1").showGreetingImage).toBeUndefined();
    }
    for (const value of ["middle", "", true, 1, null, ["top"], { position: "bottom" }]) {
      putSetting("u1", "greetingImagePosition", value);
      expect(getStartupSettings("u1").greetingImagePosition).toBeUndefined();
    }
  });

  test("keeps account preferences separate", () => {
    putSetting("u1", "showGreetingImage", true);
    putSetting("u1", "greetingImagePosition", "bottom");
    putSetting("u2", "showGreetingImage", false);
    putSetting("u2", "greetingImagePosition", "top");
    expect(getStartupSettings("u1").showGreetingImage).toBe(true);
    expect(getStartupSettings("u1").greetingImagePosition).toBe("bottom");
    expect(getStartupSettings("u2").showGreetingImage).toBe(false);
    expect(getStartupSettings("u2").greetingImagePosition).toBe("top");
  });
});

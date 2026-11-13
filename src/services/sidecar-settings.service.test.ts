import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as settingsSvc from "./settings.service";
import { getSidecarSettings, putSidecarSettings } from "./sidecar-settings.service";

function initSettingsTable() {
  initDatabase(":memory:");
  getDb().run(`
    CREATE TABLE settings (
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      user_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, user_id)
    )
  `);
}

describe("sidecar settings", () => {
  beforeEach(() => {
    closeDatabase();
    initSettingsTable();
  });

  afterEach(() => {
    closeDatabase();
  });

  test("honors saved parameters even before a connection is selected", () => {
    settingsSvc.putSetting("user-1", "sidecarSettings", {
      connectionProfileId: "",
      model: "",
      temperature: 0.25,
      topP: 0.55,
      maxTokens: 2048,
    });

    expect(getSidecarSettings("user-1")).toMatchObject({
      connectionProfileId: "",
      model: "",
      temperature: 0.25,
      topP: 0.55,
      maxTokens: 2048,
    });
  });

  test("partial updates merge with saved parameter-only rows", () => {
    settingsSvc.putSetting("user-1", "sidecarSettings", {
      connectionProfileId: "",
      model: "",
      temperature: 0.25,
      topP: 0.55,
      maxTokens: 2048,
    });

    expect(putSidecarSettings("user-1", { maxTokens: 1536 })).toMatchObject({
      temperature: 0.25,
      topP: 0.55,
      maxTokens: 1536,
    });
  });
});

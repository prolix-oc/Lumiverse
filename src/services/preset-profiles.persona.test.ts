import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  getPersonaBinding,
  resolveProfile,
  setPersonaBinding,
} from "./preset-profiles.service";
import * as settingsSvc from "./settings.service";

const USER = "persona-profile-user";

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE personas (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`);
  db.run(`CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    parameters TEXT NOT NULL DEFAULT '{}',
    prompt_order TEXT NOT NULL DEFAULT '[]',
    prompts TEXT NOT NULL DEFAULT '{}',
    metadata TEXT NOT NULL DEFAULT '{}',
    engine TEXT NOT NULL DEFAULT 'loom',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
}

beforeEach(initTestDb);
afterEach(() => closeDatabase());

describe("persona preset profiles", () => {
  test("binds a preset state snapshot to a persona", () => {
    const db = getDb();
    db.run("INSERT INTO personas (id, user_id, name, metadata) VALUES (?, ?, ?, '{}')", ["persona-1", USER, "Mode switcher"]);
    db.run(
      "INSERT INTO presets (id, user_id, name, provider) VALUES (?, ?, ?, ?)",
      ["preset-1", USER, "RP", "openai"],
    );

    const binding = setPersonaBinding(USER, "persona-1", "preset-1", { style: true, analysis: false });

    expect(getPersonaBinding(USER, "persona-1")).toEqual(binding);
  });

  test("lets a persona profile override a character profile but not a chat profile", () => {
    const db = getDb();
    db.run("INSERT INTO personas (id, user_id, name, metadata) VALUES (?, ?, ?, '{}')", ["persona-1", USER, "Mode switcher"]);
    for (const id of ["persona-preset", "character-preset", "chat-preset"]) {
      db.run(
        "INSERT INTO presets (id, user_id, name, provider) VALUES (?, ?, ?, ?)",
        [id, USER, id, "openai"],
      );
    }

    setPersonaBinding(USER, "persona-1", "persona-preset", { personaBlock: true });
    settingsSvc.putSetting(USER, "presetProfile:character:character-1", {
      preset_id: "character-preset",
      block_states: { characterBlock: true },
      captured_at: 1,
    });

    expect(
      resolveProfile(USER, "character-preset", "chat-1", "character-1", { personaId: "persona-1" }),
    ).toMatchObject({ preset_id: "persona-preset", source: "persona" });

    settingsSvc.putSetting(USER, "presetProfile:chat:chat-1", {
      preset_id: "chat-preset",
      block_states: { chatBlock: true },
      captured_at: 1,
    });
    expect(
      resolveProfile(USER, "character-preset", "chat-1", "character-1", { personaId: "persona-1" }),
    ).toMatchObject({ preset_id: "chat-preset", source: "chat" });
  });
});

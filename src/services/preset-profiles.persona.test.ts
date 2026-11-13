import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  getPersonaBinding,
  resolveProfile,
  setPersonaBinding,
  setChatBinding,
  updateChatPromptVariables,
  updateCharacterPromptVariables,
  updateConnectionPromptVariables,
  getChatBinding,
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
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    character_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
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

  test("captures prompt-variable selections with the profile snapshot", () => {
    const db = getDb();
    db.run("INSERT INTO personas (id, user_id, name, metadata) VALUES (?, ?, ?, '{}')", ["persona-1", USER, "Mode switcher"]);
    db.run(
      "INSERT INTO presets (id, user_id, name, provider) VALUES (?, ?, ?, ?)",
      ["preset-1", USER, "RP", "openai"],
    );

    const binding = setPersonaBinding(
      USER,
      "persona-1",
      "preset-1",
      { style: true },
      { style: { tone: "warm" } },
    );

    expect(binding.prompt_variables).toEqual({ style: { tone: "warm" } });
    expect(getPersonaBinding(USER, "persona-1")?.prompt_variables).toEqual({ style: { tone: "warm" } });
  });

  test("updates chat variable selections without replacing its block snapshot", () => {
    const db = getDb();
    db.run("INSERT INTO chats (id, user_id, name, metadata) VALUES (?, ?, ?, '{}')", ["chat-1", USER, "Chat"]);
    db.run(
      "INSERT INTO presets (id, user_id, name, provider) VALUES (?, ?, ?, ?)",
      ["preset-1", USER, "RP", "openai"],
    );
    setChatBinding(USER, "chat-1", "preset-1", { style: false }, { style: { tone: "cold" } });

    updateChatPromptVariables(USER, "chat-1", { style: { tone: "warm" } });

    expect(getChatBinding(USER, "chat-1")).toMatchObject({
      block_states: { style: false },
      prompt_variables: { style: { tone: "warm" } },
    });
    expect(settingsSvc.getSetting(USER, "presetProfile:chat:chat-1")?.value).toEqual(expect.objectContaining({
      block_states: { style: false },
    }));
    expect(settingsSvc.getSetting(USER, "presetProfile:chat:chat-1")?.value.prompt_variables).toBeUndefined();
    expect(settingsSvc.getSetting(USER, "presetProfileVariables:chat:chat-1")?.value).toEqual({
      style: { tone: "warm" },
    });
  });

  test("stores character and connection variable updates separately from their bindings", () => {
    const db = getDb();
    db.run(
      "INSERT INTO presets (id, user_id, name, provider) VALUES (?, ?, ?, ?)",
      ["preset-1", USER, "RP", "openai"],
    );
    for (const [key, states] of [
      ["presetProfile:character:character-1", { character: true }],
      ["presetProfile:connection:connection-1", { connection: false }],
    ] as const) {
      settingsSvc.putSetting(USER, key, { preset_id: "preset-1", block_states: states, captured_at: 1 });
    }

    updateCharacterPromptVariables(USER, "character-1", { character: { tone: "warm" } });
    updateConnectionPromptVariables(USER, "connection-1", { connection: { tone: "cold" } });

    expect(settingsSvc.getSetting(USER, "presetProfile:character:character-1")?.value.block_states).toEqual({ character: true });
    expect(settingsSvc.getSetting(USER, "presetProfile:connection:connection-1")?.value.block_states).toEqual({ connection: false });
    expect(settingsSvc.getSetting(USER, "presetProfileVariables:character:character-1")?.value).toEqual({ character: { tone: "warm" } });
    expect(settingsSvc.getSetting(USER, "presetProfileVariables:connection:connection-1")?.value).toEqual({ connection: { tone: "cold" } });
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
    ).toMatchObject({ preset_id: "persona-preset", source: "persona", source_id: "persona-1" });

    settingsSvc.putSetting(USER, "presetProfile:chat:chat-1", {
      preset_id: "chat-preset",
      block_states: { chatBlock: true },
      captured_at: 1,
    });
    expect(
      resolveProfile(USER, "character-preset", "chat-1", "character-1", { personaId: "persona-1" }),
    ).toMatchObject({ preset_id: "chat-preset", source: "chat", source_id: "chat-1" });
  });
});

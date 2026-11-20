import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { captureDefaults, resolveActivePreset, setChatBinding } from "./preset-profiles.service";
import * as settingsSvc from "./settings.service";

const USER = "active-preset-user";

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
    is_default INTEGER NOT NULL DEFAULT 0,
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
  db.run("INSERT INTO presets (id, user_id, name, provider) VALUES (?, ?, ?, ?)", ["preset-1", USER, "Main", "loom"]);
  db.run("INSERT INTO presets (id, user_id, name, provider) VALUES (?, ?, ?, ?)", ["preset-2", USER, "Bound", "loom"]);
  db.run("INSERT INTO chats (id, user_id, character_id) VALUES (?, ?, ?)", ["chat-1", USER, "char-1"]);
  db.run("INSERT INTO chats (id, user_id, character_id, metadata) VALUES (?, ?, ?, ?)", [
    "chat-np", USER, null, JSON.stringify({ temporary: true, no_preset: true }),
  ]);
  settingsSvc.putSetting(USER, "activeLoomPresetId", "preset-1");
}

beforeEach(initTestDb);
afterEach(() => closeDatabase());

describe("resolveActivePreset", () => {
  test("uses the selected preset with no overrides when nothing is bound", async () => {
    expect(await resolveActivePreset(USER, "chat-1")).toEqual({
      preset_id: "preset-1", binding: null, source: "none", source_id: null,
    });
  });

  test("a chat binding selects its preset and block states", async () => {
    setChatBinding(USER, "chat-1", "preset-2", { "block-a": false, "block-b": true });
    const resolved = await resolveActivePreset(USER, "chat-1");
    expect(resolved?.preset_id).toBe("preset-2");
    expect(resolved?.source).toBe("chat");
    expect(resolved?.source_id).toBe("chat-1");
    expect(resolved?.binding?.block_states).toEqual({ "block-a": false, "block-b": true });
  });

  test("a no-preset chat resolves to no preset", async () => {
    expect(await resolveActivePreset(USER, "chat-np")).toEqual({
      preset_id: null, binding: null, source: "none", source_id: null,
    });
  });

  test("an unknown chat resolves to null", async () => {
    expect(await resolveActivePreset(USER, "missing")).toBeNull();
  });

  test("without a chat, the selected preset and its defaults apply", async () => {
    expect((await resolveActivePreset(USER))?.source).toBe("none");
    captureDefaults(USER, "preset-1", { "block-a": true });
    const resolved = await resolveActivePreset(USER);
    expect(resolved?.preset_id).toBe("preset-1");
    expect(resolved?.source).toBe("defaults");
    expect(resolved?.binding?.block_states).toEqual({ "block-a": true });
  });
});

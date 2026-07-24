import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as settingsSvc from "../services/settings.service";
import {
  backfillDefaultPresets,
  BUILTIN_DEFAULT_PRESET_SEED_SETTING_KEY,
  BUILTIN_DEFAULT_PRESET_SLUG,
  seedDefaultPreset,
} from "./default-preset";

function initDefaultPresetTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();

  db.run(`CREATE TABLE "user" (
    id TEXT PRIMARY KEY,
    username TEXT,
    createdAt INTEGER NOT NULL
  )`);

  db.run(`CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    parameters TEXT NOT NULL DEFAULT '{}',
    prompt_order TEXT NOT NULL DEFAULT '[]',
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    prompts TEXT NOT NULL DEFAULT '{}',
    user_id TEXT,
    engine TEXT NOT NULL DEFAULT 'classic',
    cache_revision INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    preset_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    has_api_key INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);

  db.run(`CREATE TABLE dispatch_state (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    base_token TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    descriptor_digest TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (length(base_token) >= 32)
  )`);

  db.run(`CREATE UNIQUE INDEX idx_dispatch_state_base_token
    ON dispatch_state(base_token)`);
  db.run(`CREATE INDEX idx_dispatch_state_updated
    ON dispatch_state(updated_at DESC)`);
}

function insertUser(id: string, createdAt: number, username = id): void {
  getDb().run(
    `INSERT INTO "user" (id, username, createdAt) VALUES (?, ?, ?)`,
    [id, username, createdAt],
  );
}

function insertPreset(input: {
  id: string;
  userId: string;
  name: string;
  provider: string;
  metadata?: unknown;
}): void {
  getDb().run(
    `INSERT INTO presets
      (id, name, provider, parameters, prompt_order, prompts, metadata, user_id, engine, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'classic', ?, ?)`,
    [
      input.id,
      input.name,
      input.provider,
      JSON.stringify({}),
      JSON.stringify([]),
      JSON.stringify({}),
      JSON.stringify(input.metadata ?? {}),
      input.userId,
      0,
      0,
    ],
  );
}

function countPresets(userId: string): number {
  const row = getDb()
    .query("SELECT COUNT(*) as count FROM presets WHERE user_id = ?")
    .get(userId) as { count: number };
  return row.count;
}

function findBuiltInPreset(userId: string): { id: string } | null {
  return getDb()
    .query(
      "SELECT id FROM presets WHERE user_id = ? AND json_extract(metadata, '$._lumiverse_preset_slug') = ? LIMIT 1",
    )
    .get(userId, BUILTIN_DEFAULT_PRESET_SLUG) as { id: string } | null;
}

beforeEach(initDefaultPresetTestDb);
afterEach(() => closeDatabase());

describe("default preset seeding", () => {
  test("seeds the built-in Loom default and activates it for a new user", () => {
    insertUser("u1", 1);

    const result = seedDefaultPreset("u1", { setActive: true });

    expect(result.seeded).toBe(true);
    expect(result.upgradedLegacy).toBe(false);
    expect(result.activated).toBe(true);
    expect(countPresets("u1")).toBe(1);

    const preset = getDb()
      .query(
        `SELECT id, name, provider, engine,
                json_extract(metadata, '$._lumiverse_preset_slug') as slug
           FROM presets
          WHERE user_id = ?`,
      )
      .get("u1") as {
        id: string;
        name: string;
        provider: string;
        engine: string;
        slug: string;
      };

    expect(preset.id).toBe(result.presetId);
    expect(preset.name).toBe("Default");
    expect(preset.provider).toBe("loom");
    expect(preset.engine).toBe("classic");
    expect(preset.slug).toBe(BUILTIN_DEFAULT_PRESET_SLUG);
    expect(settingsSvc.getSetting("u1", "activeLoomPresetId")?.value).toBe(result.presetId);
    expect(settingsSvc.getSetting("u1", BUILTIN_DEFAULT_PRESET_SEED_SETTING_KEY)?.value).toBe(1);
  });

  test("seeds the built-in default alongside unrelated presets without changing the active preset", () => {
    insertUser("u1", 1);
    insertPreset({
      id: "existing-openai-default",
      userId: "u1",
      name: "Default",
      provider: "openai",
      metadata: {},
    });
    settingsSvc.putSetting("u1", "activeLoomPresetId", "existing-openai-default");

    const result = seedDefaultPreset("u1", { setActiveIfNoPresets: true });

    expect(result.seeded).toBe(true);
    expect(result.activated).toBe(false);
    expect(countPresets("u1")).toBe(2);
    expect(findBuiltInPreset("u1")?.id).toBe(result.presetId);
    expect(settingsSvc.getSetting("u1", "activeLoomPresetId")?.value).toBe("existing-openai-default");
  });

  test("upgrades a legacy built-in preset in place instead of duplicating it", () => {
    insertUser("u1", 1);
    insertPreset({
      id: "legacy-built-in",
      userId: "u1",
      name: "Default",
      provider: "loom",
      metadata: {
        isDefault: true,
        source: null,
        description: "",
      },
    });

    const result = seedDefaultPreset("u1", { setActiveIfNoPresets: true });

    expect(result.seeded).toBe(false);
    expect(result.upgradedLegacy).toBe(true);
    expect(result.activated).toBe(false);
    expect(countPresets("u1")).toBe(1);
    expect(findBuiltInPreset("u1")?.id).toBe("legacy-built-in");
    expect(settingsSvc.getSetting("u1", BUILTIN_DEFAULT_PRESET_SEED_SETTING_KEY)?.value).toBe(1);
    expect(getDb().query("SELECT cache_revision FROM presets WHERE id = ?").get("legacy-built-in")).toEqual({
      cache_revision: 1,
    });
  });

  test("startup backfill seeds all unmarked users once and only auto-activates empty accounts", () => {
    insertUser("owner", 1);
    insertUser("u2", 2);

    insertPreset({
      id: "imported-openai",
      userId: "owner",
      name: "Imported",
      provider: "openai",
      metadata: {},
    });
    settingsSvc.putSetting("owner", "activeLoomPresetId", "imported-openai");

    const first = backfillDefaultPresets();

    expect(first.usersScanned).toBe(2);
    expect(first.seeded).toBe(2);
    expect(first.upgradedLegacy).toBe(0);
    expect(first.activated).toBe(1);
    expect(first.markedSeeded).toBe(2);

    expect(countPresets("owner")).toBe(2);
    expect(countPresets("u2")).toBe(1);
    expect(findBuiltInPreset("owner")).not.toBeNull();
    const u2BuiltIn = findBuiltInPreset("u2");
    expect(u2BuiltIn).not.toBeNull();
    expect(settingsSvc.getSetting("owner", "activeLoomPresetId")?.value).toBe("imported-openai");
    expect(settingsSvc.getSetting("u2", "activeLoomPresetId")?.value).toBe(u2BuiltIn?.id);
    expect(settingsSvc.getSetting("owner", BUILTIN_DEFAULT_PRESET_SEED_SETTING_KEY)?.value).toBe(1);
    expect(settingsSvc.getSetting("u2", BUILTIN_DEFAULT_PRESET_SEED_SETTING_KEY)?.value).toBe(1);

    const second = backfillDefaultPresets();
    expect(second.usersScanned).toBe(2);
    expect(second.seeded).toBe(0);
    expect(second.upgradedLegacy).toBe(0);
    expect(second.activated).toBe(0);
    expect(second.markedSeeded).toBe(0);
  });
});

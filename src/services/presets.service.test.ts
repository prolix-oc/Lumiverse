import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getPreset, getPresetCacheRevision, getPresetRegistrySignature, updatePreset } from "./presets.service";
import { PresetRevisionConflictError } from "../types/preset";

function initPresetsTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE presets (
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
  getDb().run(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  getDb().run(`INSERT INTO "user" (id) VALUES ('u1'), ('u2')`);
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, user_id)
  )`);
  getDb().run(`CREATE TABLE connection_profiles (
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
  getDb().run(`CREATE TABLE dispatch_state (
    user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    base_token TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 0),
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    descriptor_digest TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK (length(base_token) >= 32)
  )`);
  getDb().run(`CREATE UNIQUE INDEX idx_dispatch_state_base_token
    ON dispatch_state(base_token)`);
  getDb().run(`CREATE INDEX idx_dispatch_state_updated
    ON dispatch_state(updated_at DESC)`);
}

function insertPreset(o: {
  id: string;
  name: string;
  provider: string;
  user_id: string;
  updated_at?: number;
  parameters?: unknown;
  prompt_order?: unknown;
  prompts?: unknown;
  metadata?: unknown;
  engine?: string;
}): void {
  getDb().run(
    `INSERT INTO presets (id, name, provider, parameters, prompt_order, metadata, created_at, updated_at, prompts, user_id, engine)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      o.id,
      o.name,
      o.provider,
      JSON.stringify(o.parameters ?? {}),
      JSON.stringify(o.prompt_order ?? []),
      JSON.stringify(o.metadata ?? {}),
      0,
      o.updated_at ?? 0,
      JSON.stringify(o.prompts ?? {}),
      o.user_id,
      o.engine ?? "classic",
    ],
  );
}

beforeEach(initPresetsTestDb);
afterEach(() => closeDatabase());

describe("presets.service — ETag sources + row trim", () => {
  test("getPreset parses JSON columns and does NOT leak internal columns (user_id)", () => {
    insertPreset({
      id: "p1",
      name: "A",
      provider: "openai",
      user_id: "u1",
      updated_at: 100,
      parameters: { temperature: 1 },
      prompt_order: [{ id: "b1" }],
      engine: "loom",
    });

    const preset = getPreset("u1", "p1");
    expect(preset).not.toBeNull();
    expect(Object.keys(preset!)).not.toContain("user_id");
    expect(preset!.parameters).toEqual({ temperature: 1 });
    expect(preset!.prompt_order).toEqual([{ id: "b1" }]);
    expect(preset!.engine).toBe("loom");
    expect(preset!.updated_at).toBe(100);
    expect(preset!.cache_revision).toBe(0);
  });

  test("getPreset is scoped to the owning user", () => {
    insertPreset({ id: "p1", name: "A", provider: "openai", user_id: "u1", updated_at: 100 });
    expect(getPreset("u2", "p1")).toBeNull();
  });


  test("registry signatures are scoped by user and filters", () => {
    insertPreset({ id: "p1", name: "A", provider: "openai", user_id: "u1", updated_at: 100 });
    insertPreset({ id: "p2", name: "B", provider: "loom", user_id: "u1", updated_at: 250 });
    insertPreset({ id: "p3", name: "C", provider: "loom", user_id: "u2", updated_at: 999 });

    const all = getPresetRegistrySignature("u1");
    const loom = getPresetRegistrySignature("u1", "loom");
    const empty = getPresetRegistrySignature("u1", "anthropic");
    expect(all).not.toBe(loom);
    expect(loom).not.toBe(empty);
    expect(empty).not.toBe(getPresetRegistrySignature("u2", "anthropic"));
    expect(empty).toBe(getPresetRegistrySignature("u1", "anthropic"));
  });

  test("registry signature changes for a same-second non-maximum edit", () => {
    insertPreset({ id: "p1", name: "A", provider: "loom", user_id: "u1", updated_at: 100 });
    insertPreset({ id: "p2", name: "B", provider: "loom", user_id: "u1", updated_at: 250 });
    const before = getPresetRegistrySignature("u1", "loom");
    getDb().run("UPDATE presets SET cache_revision = ? WHERE id = ?", [1, "p1"]);
    const after = getPresetRegistrySignature("u1", "loom");
    expect(after).not.toBe(before);
  });

  test("registry signature changes for a same-timestamp delete/create replacement", () => {
    insertPreset({ id: "p1", name: "A", provider: "loom", user_id: "u1", updated_at: 250 });
    const before = getPresetRegistrySignature("u1", "loom");
    getDb().run("DELETE FROM presets WHERE id = ?", ["p1"]);
    insertPreset({ id: "p2", name: "B", provider: "loom", user_id: "u1", updated_at: 250 });
    expect(getPresetRegistrySignature("u1", "loom")).not.toBe(before);
  });

  test("updatePreset increments a dedicated cache revision without distorting timestamps", () => {
    insertPreset({ id: "p1", name: "A", provider: "loom", user_id: "u1", updated_at: 2_000_000_000 });
    const first = updatePreset("u1", "p1", { name: "B" });
    const second = updatePreset("u1", "p1", { name: "C" });
    expect(first?.updated_at).toBeLessThan(2_000_000_000);
    expect(getPresetCacheRevision("u1", "p1")).toBe(2);
    expect(second?.name).toBe("C");
    expect(getPresetCacheRevision("u1", "missing")).toBeNull();
  });

  test("rejects a stale conditional writer without changing newer metadata or blocks", () => {
    insertPreset({
      id: "p1",
      name: "A",
      provider: "loom",
      user_id: "u1",
      prompt_order: [{ id: "original" }],
    });

    const first = updatePreset("u1", "p1", {
      name: "newer",
      prompt_order: [{ id: "newer-block" }],
      expected_cache_revision: 0,
    });
    expect(first?.cache_revision).toBe(1);

    expect(() => updatePreset("u1", "p1", {
      metadata: { source: "stale-writer" },
      prompt_order: [{ id: "stale-block" }],
      expected_cache_revision: 0,
    })).toThrow(PresetRevisionConflictError);

    const current = getPreset("u1", "p1");
    expect(current?.name).toBe("newer");
    expect(current?.prompt_order).toEqual([{ id: "newer-block" }]);
    expect(current?.metadata).toEqual({});
    expect(current?.cache_revision).toBe(1);
  });

  test("rejects stale conditional no-op writers", () => {
    insertPreset({ id: "p1", name: "A", provider: "loom", user_id: "u1" });
    const current = updatePreset("u1", "p1", { name: "newer" });
    expect(current?.cache_revision).toBe(1);

    expect(() => updatePreset("u1", "p1", {
      expected_cache_revision: 0,
    })).toThrow(PresetRevisionConflictError);

    expect(getPreset("u1", "p1")?.name).toBe("newer");
    expect(getPreset("u1", "p1")?.cache_revision).toBe(1);
  });
});

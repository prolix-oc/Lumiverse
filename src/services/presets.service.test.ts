import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { getPreset, getPresetCacheRevision, getPresetUpdatedAt, getPresetRegistrySignature, updatePreset } from "./presets.service";

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
  });

  test("getPreset is scoped to the owning user", () => {
    insertPreset({ id: "p1", name: "A", provider: "openai", user_id: "u1", updated_at: 100 });
    expect(getPreset("u2", "p1")).toBeNull();
  });

  test("getPresetUpdatedAt returns updated_at, null for missing or other-user", () => {
    insertPreset({ id: "p1", name: "A", provider: "openai", user_id: "u1", updated_at: 42 });
    expect(getPresetUpdatedAt("u1", "p1")).toBe(42);
    expect(getPresetUpdatedAt("u1", "missing")).toBeNull();
    expect(getPresetUpdatedAt("u2", "p1")).toBeNull();
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
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createPreset, deletePreset, getPreset, getPresetCacheRevision, getPresetRegistrySignature, listPresetRegistry, reconcileActiveLoomPreset, updatePreset } from "./presets.service";
import { PresetRevisionConflictError, type PromptBlock } from "../types/preset";
import { addPromptBlockToStash, removePromptBlockFromStash } from "./prompt-stash.service";
import * as settingsSvc from "./settings.service";

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
  getDb().run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  getDb().run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    preset_id TEXT
  )`);
  getDb().run(`CREATE TABLE regex_scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    preset_id TEXT
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
  test("always generates a fresh id even when an imported payload supplies one", () => {
    const created = createPreset("u1", {
      id: "portable-source-id",
      name: "Imported",
      provider: "loom",
    } as any);

    expect(created.id).not.toBe("portable-source-id");
    expect(created.id).toBeString();
  });

  test("includes normalized cover URLs in the lightweight registry", () => {
    insertPreset({
      id: "covered",
      name: "Covered",
      provider: "loom",
      user_id: "u1",
      metadata: { coverUrl: "https://cdn.example.test/cover.webp" },
    });

    expect(listPresetRegistry("u1", { limit: 20, offset: 0 }, "loom").data[0]?.cover_url)
      .toBe("https://cdn.example.test/cover.webp");
  });

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

describe("presets.service — active preset recovery", () => {
  test("repairs a legacy deleted selection during settings hydration", () => {
    insertPreset({ id: "available", name: "Available", provider: "loom", user_id: "u1", updated_at: 100 });
    settingsSvc.putSetting("u1", "activeLoomPresetId", "already-deleted");

    expect(reconcileActiveLoomPreset("u1")).toBe("available");
    expect(settingsSvc.getSetting("u1", "activeLoomPresetId")?.value).toBe("available");
  });

  test("replaces a deleted active preset with the most recently updated remaining Loom preset", () => {
    insertPreset({ id: "deleted", name: "Deleted", provider: "loom", user_id: "u1", updated_at: 300 });
    insertPreset({ id: "older", name: "Older", provider: "loom", user_id: "u1", updated_at: 100 });
    insertPreset({ id: "recent", name: "Recent", provider: "loom", user_id: "u1", updated_at: 200 });
    settingsSvc.putSetting("u1", "activeLoomPresetId", "deleted");

    expect(deletePreset("u1", "deleted")).toBe(true);
    expect(settingsSvc.getSetting("u1", "activeLoomPresetId")?.value).toBe("recent");
  });

  test("clears the active setting when the deleted preset was the final Loom preset", () => {
    insertPreset({ id: "only", name: "Only", provider: "loom", user_id: "u1" });
    settingsSvc.putSetting("u1", "activeLoomPresetId", "only");

    expect(deletePreset("u1", "only")).toBe(true);
    expect(settingsSvc.getSetting("u1", "activeLoomPresetId")?.value).toBeNull();
  });
});

describe("presets.service — prompt stash", () => {
  test("syncs a stashed block globally while keeping visibility and grouping local", () => {
    const source: PromptBlock = {
      id: "source-block", name: "Shared prompt", content: "original", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
    };
    const stash = addPromptBlockToStash("u1", source);
    insertPreset({
      id: "p1", name: "One", provider: "loom", user_id: "u1",
      prompt_order: [{ ...source, id: "p1-block", stashId: stash.id }],
    });
    insertPreset({
      id: "p2", name: "Two", provider: "loom", user_id: "u1",
      prompt_order: [{ ...source, id: "p2-block", stashId: stash.id, enabled: false, group: "local-category" }],
    });

    updatePreset("u1", "p1", {
      prompt_order: [{ ...source, id: "p1-block", stashId: stash.id, content: "updated everywhere" }],
    });

    const second = getPreset("u1", "p2")!;
    expect(second.prompt_order[0]).toMatchObject({
      content: "updated everywhere",
      enabled: false,
      group: "local-category",
      stashId: stash.id,
    });
    expect(second.cache_revision).toBe(1);
  });

  test("un-stashing keeps linked blocks as independent local copies", () => {
    const source: PromptBlock = {
      id: "source-block", name: "Shared prompt", content: "keep this", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
    };
    const stash = addPromptBlockToStash("u1", source, { id: "origin", name: "Origin preset" });
    insertPreset({
      id: "p1", name: "One", provider: "loom", user_id: "u1",
      prompt_order: [{ ...source, id: "p1-block", stashId: stash.id, enabled: false, group: "local-category" }],
    });

    expect(removePromptBlockFromStash("u1", stash.id)).toBe(true);
    expect(getPreset("u1", "p1")?.prompt_order[0]).toMatchObject({
      content: "keep this", enabled: false, group: "local-category",
    });
    expect(getPreset("u1", "p1")?.prompt_order[0].stashId).toBeUndefined();
  });
});

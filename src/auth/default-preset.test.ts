import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as settingsSvc from "../services/settings.service";
import {
  backfillDefaultPresets,
  BUILTIN_DEFAULT_PRESET_SEED_SETTING_KEY,
  DEFAULT_PRESET_BLOCKS,
  BUILTIN_DEFAULT_PRESET_SLUG,
  seedDefaultPreset,
} from "./default-preset";
import { SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL } from "../services/secrets.service";
import { createDisabledAgentConfigV2 } from "../types/agents";

function initDefaultPresetTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();

  db.run(`CREATE TABLE "user" (
    id TEXT PRIMARY KEY,
    username TEXT,
    email TEXT,
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
  db.run(`CREATE TABLE preset_agent_configs (
    user_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 2,
    agents_enabled INTEGER NOT NULL DEFAULT 0,
    allowed_modes TEXT NOT NULL DEFAULT '["response"]',
    default_mode TEXT NOT NULL DEFAULT 'response',
    max_invocations INTEGER NOT NULL DEFAULT 64,
    max_tool_calls INTEGER NOT NULL DEFAULT 64,
    main_tool_ids TEXT NOT NULL DEFAULT '[]',
    main_lore_scope TEXT NOT NULL DEFAULT 'active',
    phase_policy_json TEXT NOT NULL DEFAULT '{}',
    cognition_policy_json TEXT NOT NULL DEFAULT '{}',
    task_policy_json TEXT NOT NULL DEFAULT '{}',
    workspace_policy_json TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL DEFAULT 'ready',
    review_code TEXT,
    review_acknowledged INTEGER NOT NULL DEFAULT 0,
    config_revision INTEGER NOT NULL DEFAULT 1,
    binding_revision INTEGER NOT NULL DEFAULT 1,
    config_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, preset_id)
  )`);

  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key, user_id)
  )`);
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
function attachFullBuiltInLoomAuthority(userId: string, presetId: string): void {
  const promptOrder = DEFAULT_PRESET_BLOCKS
    .filter((block) => block.marker !== "category")
    .slice(0, 11)
    .map((block) => ({ ...block, revision: 1 }));
  if (promptOrder.length !== 11) throw new Error("Expected eleven built-in content blocks");
  const config = {
    ...createDisabledAgentConfigV2(),
    runtimePolicy: {
      version: 1,
      authority: "loom",
      scope: "preset",
      defaultMode: "response",
      loomPolicy: {
        version: 1,
        workPolicy: promptOrder.map((block, promptOrderIndex) => ({
          version: 1,
          id: `built-in-${promptOrderIndex}`,
          source: {
            kind: "loom_block",
            blockId: block.id,
            presetRevision: 0,
            blockRevision: 1,
            promptOrder: promptOrderIndex,
          },
          destination: "root_work",
          checkpoint: "WORK",
          required: false,
          visibility: "work_only",
        })),
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [],
      },
      phases: [],
    },
  };
  const db = getDb();
  db.query("UPDATE presets SET prompt_order = ? WHERE user_id = ? AND id = ?")
    .run(JSON.stringify(promptOrder), userId, presetId);
  db.query("INSERT INTO preset_agent_configs (user_id, preset_id, config_json) VALUES (?, ?, ?)")
    .run(userId, presetId, JSON.stringify({ config }));
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

  test("quarantines all eleven exact Loom sources during a legacy built-in metadata upgrade", () => {
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
    attachFullBuiltInLoomAuthority("u1", "legacy-built-in");

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
    expect(getDb().query("SELECT state, review_code, review_acknowledged, config_revision FROM preset_agent_configs WHERE preset_id = ?").get("legacy-built-in")).toEqual({
      state: "repair_required",
      review_code: "loom_reference_repair_required",
      review_acknowledged: 0,
      config_revision: 2,
    });
  });
  test("leaves an already-current built-in with eleven exact Loom sources revision-stable", () => {
    insertUser("u1", 1);
    insertPreset({
      id: "current-built-in",
      userId: "u1",
      name: "Default",
      provider: "loom",
      metadata: {
        isDefault: true,
        _lumiverse_preset_slug: BUILTIN_DEFAULT_PRESET_SLUG,
      },
    });
    attachFullBuiltInLoomAuthority("u1", "current-built-in");
    const beforeConfig = getDb().query("SELECT config_json FROM preset_agent_configs WHERE preset_id = ?")
      .get("current-built-in");

    const result = seedDefaultPreset("u1", { setActiveIfNoPresets: true });

    expect(result).toMatchObject({ seeded: false, upgradedLegacy: false, activated: false });
    expect(getDb().query("SELECT cache_revision FROM presets WHERE id = ?").get("current-built-in"))
      .toEqual({ cache_revision: 0 });
    expect(getDb().query("SELECT state, review_code, review_acknowledged, config_revision FROM preset_agent_configs WHERE preset_id = ?").get("current-built-in"))
      .toEqual({ state: "ready", review_code: null, review_acknowledged: 0, config_revision: 1 });
    expect(getDb().query("SELECT config_json FROM preset_agent_configs WHERE preset_id = ?")
      .get("current-built-in")).toEqual(beforeConfig);
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

  test("startup backfill skips the reserved system principal", () => {
    // The synthetic row sorts first (createdAt = 0 legacy shape): the
    // exclusion guard must keep it out of preset seeding regardless.
    getDb().run(
      `INSERT INTO "user" (id, username, email, createdAt) VALUES (?, 'System', ?, 0)`,
      [SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL],
    );
    insertUser("u1", 1);

    const result = backfillDefaultPresets();

    expect(result.usersScanned).toBe(1);
    expect(countPresets(SYSTEM_SECRET_PRINCIPAL)).toBe(0);
    expect(findBuiltInPreset("u1")).not.toBeNull();
  });
});

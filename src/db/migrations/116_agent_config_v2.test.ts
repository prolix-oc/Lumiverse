import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeDatabase, initDatabase } from "../connection";
import { setChatAgentModeOverride, writePresetAgentConfig } from "../../services/agent-config-portability.service";

const migrationSql = await Bun.file(new URL("./116_agent_config_v2.sql", import.meta.url)).text();
const USER_ID = "user-1";

function createParentSchema(db: Database): void {
  db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY)`);
  db.run(`CREATE TABLE presets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user_id, id)
  )`);
  db.run(`CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    UNIQUE (user_id, id)
  )`);
  db.run(`CREATE TABLE connection_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}',
    UNIQUE (user_id, id)
  )`);
  db.run(`INSERT INTO "user" (id) VALUES (?)`, [USER_ID]);
}

function migratePresets(
  presets: readonly { id: string; metadata: Record<string, unknown> | string }[],
  connections: readonly { id: string; userId: string; metadata?: Record<string, unknown> | string }[] = [],
): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  createParentSchema(db);
  for (const preset of presets) {
    const metadata = typeof preset.metadata === "string" ? preset.metadata : JSON.stringify(preset.metadata);
    db.run("INSERT INTO presets (id, user_id, metadata) VALUES (?, ?, ?)", [preset.id, USER_ID, metadata]);
  }
  for (const connection of connections) {
    const metadata = typeof connection.metadata === "string" ? connection.metadata : JSON.stringify(connection.metadata ?? {});
    db.run("INSERT INTO connection_profiles (id, user_id, metadata) VALUES (?, ?, ?)", [connection.id, connection.userId, metadata]);
  }
  db.run(migrationSql);
  return db;
}

function legacyConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    maxInvocations: 4,
    maxToolCalls: 8,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [],
    ...overrides,
  };
}

function legacyProfile(connectionProfileId: string | null): Record<string, unknown> {
  return {
    id: "writer",
    name: "Writer",
    systemPrompt: "Literal system prompt",
    connectionProfileId,
    toolIds: [],
    loreScope: "active",
    allowMainDelegation: false,
    failurePolicy: "required",
    streamActivity: true,
    maxOutputTokens: 128,
    timeoutMs: 5_000,
  };
}

beforeEach(() => closeDatabase());
afterEach(() => closeDatabase());

describe("116_agent_config_v2 migration", () => {
  test("creates an inert normalized row when legacy metadata is absent", () => {
    const db = migratePresets([{ id: "no-config", metadata: { description: "ordinary" } }]);
    const row = db.query("SELECT agents_enabled, allowed_modes, default_mode, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("no-config") as Record<string, unknown>;
    expect(row).toEqual({ agents_enabled: 0, allowed_modes: "[\"response\"]", default_mode: "response", state: "ready", review_code: null });
    expect(db.query("SELECT metadata FROM presets WHERE id = ?").get("no-config")).toEqual({ metadata: JSON.stringify({ description: "ordinary" }) });
    db.close();
  });
  test("treats marker-only metadata as absent authority and strips the markers", () => {
    const db = migratePresets([{
      id: "marker-only",
      metadata: { agentConfigReviewRequired: true, agentConfigReview: { state: "review_required" } },
    }]);
    expect(db.query("SELECT agents_enabled, allowed_modes, default_mode, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("marker-only")).toEqual({
      agents_enabled: 0,
      allowed_modes: "[\"response\"]",
      default_mode: "response",
      state: "ready",
      review_code: null,
    });
    expect(db.query("SELECT metadata FROM presets WHERE id = ?").get("marker-only")).toEqual({ metadata: "{}" });
    db.close();
  });


  test("marks invalid metadata bytes repair-required instead of granting a default authority row", () => {
    const db = migratePresets([{ id: "invalid-metadata", metadata: "{\"agentConfig\":" }]);
    const row = db.query("SELECT agents_enabled, allowed_modes, default_mode, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("invalid-metadata") as Record<string, unknown>;
    expect(row).toEqual({ agents_enabled: 0, allowed_modes: "[\"response\"]", default_mode: "response", state: "repair_required", review_code: "invalid_legacy_config" });
    expect(db.query("SELECT metadata FROM presets WHERE id = ?").get("invalid-metadata")).toEqual({ metadata: "{\"agentConfig\":" });
    db.close();
  });

  test("marks malformed V1 internals repair-required and never projects profiles", () => {
    const db = migratePresets([{
      id: "malformed",
      metadata: { agentConfig: legacyConfig({ enabled: "yes", profiles: [legacyProfile(null)] }) },
    }]);
    const row = db.query("SELECT agents_enabled, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("malformed") as Record<string, unknown>;
    expect(row).toEqual({ agents_enabled: 0, state: "repair_required", review_code: "invalid_legacy_config" });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_profiles WHERE preset_id = ?").get("malformed")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_slot_bindings WHERE preset_id = ?").get("malformed")).toEqual({ count: 0 });
    expect(db.query("SELECT metadata FROM presets WHERE id = ?").get("malformed")).toEqual({ metadata: "{}" });
    db.close();
  });
  test("marks legacy profiles with missing required fields repair-required", () => {
    const profile = legacyProfile(null);
    delete profile.name;
    const db = migratePresets([{ id: "missing-profile-field", metadata: { agentConfig: legacyConfig({ profiles: [profile] }) } }]);
    expect(db.query("SELECT agents_enabled, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("missing-profile-field")).toEqual({
      agents_enabled: 0,
      state: "repair_required",
      review_code: "invalid_legacy_config",
    });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_profiles WHERE preset_id = ?").get("missing-profile-field")).toEqual({ count: 0 });
    db.close();
  });

  test("quarantines duplicate JSON object labels instead of choosing SQLite's first value", () => {
    const config = JSON.stringify(legacyConfig()).replace('"enabled":true', '"enabled":true,"enabled":false');
    const duplicateMetadata = `{"agentConfig":${JSON.stringify(legacyConfig())},"agentConfig":${JSON.stringify(legacyConfig())}}`;
    const db = migratePresets([
      { id: "duplicate-root-label", metadata: duplicateMetadata },
      { id: "duplicate-config-label", metadata: `{"agentConfig":${config}}` },
    ]);
    for (const presetId of ["duplicate-root-label", "duplicate-config-label"]) {
      expect(db.query("SELECT agents_enabled, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get(presetId)).toEqual({
        agents_enabled: 0,
        state: "repair_required",
        review_code: "invalid_legacy_config",
      });
      expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_profiles WHERE preset_id = ?").get(presetId)).toEqual({ count: 0 });
    }
    db.close();
  });

  test("quarantines scalar legacy profiles without aborting migration", () => {
    const db = migratePresets([{ id: "scalar-profile", metadata: { agentConfig: legacyConfig({ profiles: ["broken"] }) } }]);
    expect(db.query("SELECT agents_enabled, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("scalar-profile")).toEqual({
      agents_enabled: 0,
      state: "repair_required",
      review_code: "invalid_legacy_config",
    });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_profiles WHERE preset_id = ?").get("scalar-profile")).toEqual({ count: 0 });
    db.close();
  });

  test("quarantines scalar legacy toolIds without aborting migration", () => {
    const profile = legacyProfile(null);
    profile.toolIds = "lore_search_entries";
    const db = migratePresets([{ id: "scalar-tools", metadata: { agentConfig: legacyConfig({ profiles: [profile] }) } }]);
    expect(db.query("SELECT agents_enabled, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("scalar-tools")).toEqual({
      agents_enabled: 0,
      state: "repair_required",
      review_code: "invalid_legacy_config",
    });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_profiles WHERE preset_id = ?").get("scalar-tools")).toEqual({ count: 0 });
    db.close();
  });

  test("marks a present non-object legacy config as repair-required", () => {
    const db = migratePresets([{ id: "non-object", metadata: { agentConfig: "not-an-object" } }]);
    expect(db.query("SELECT agents_enabled, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("non-object")).toEqual({
      agents_enabled: 0,
      state: "repair_required",
      review_code: "invalid_legacy_config",
    });
    db.close();
  });

  test("uses character limits for profile names and byte limits for prompts", () => {
    const accepted = legacyProfile(null);
    accepted.name = "😀".repeat(80);
    accepted.systemPrompt = "é".repeat(16_384);
    const rejected = legacyProfile(null);
    rejected.name = "😀".repeat(81);
    const db = migratePresets([
      { id: "unicode-ok", metadata: { agentConfig: legacyConfig({ profiles: [accepted] }) } },
      { id: "unicode-bad", metadata: { agentConfig: legacyConfig({ profiles: [rejected] }) } },
    ]);
    expect(db.query("SELECT state FROM preset_agent_configs WHERE preset_id = ?").get("unicode-ok")).toEqual({ state: "ready" });
    expect(db.query("SELECT name FROM preset_agent_profiles WHERE preset_id = ?").get("unicode-ok")).toEqual({ name: accepted.name });
    expect(db.query("SELECT state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("unicode-bad")).toEqual({
      state: "repair_required",
      review_code: "invalid_legacy_config",
    });
    db.close();
  });

  test("does not copy unsafe legacy invocation limits into the normalized row", () => {
    const db = migratePresets([{
      id: "unsafe-limits",
      metadata: { agentConfig: legacyConfig({ maxInvocations: Number.MAX_SAFE_INTEGER + 2, maxToolCalls: Number.MAX_SAFE_INTEGER + 2 }) },
    }]);
    expect(db.query("SELECT max_invocations, max_tool_calls, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("unsafe-limits")).toEqual({
      max_invocations: 64,
      max_tool_calls: 64,
      state: "repair_required",
      review_code: "invalid_legacy_config",
    });
    db.close();
  });


  test("keeps foreign legacy bindings inert and review-required", () => {
    const db = migratePresets(
      [{ id: "foreign", metadata: { agentConfig: legacyConfig({ profiles: [legacyProfile("foreign-connection")] }) } }],
      [{ id: "foreign-connection", userId: "user-2" }],
    );
    const config = db.query("SELECT agents_enabled, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("foreign") as Record<string, unknown>;
    const binding = db.query("SELECT connection_id, binding_revision, state, review_code FROM preset_agent_slot_bindings WHERE preset_id = ?").get("foreign") as Record<string, unknown>;
    expect(config).toEqual({ agents_enabled: 0, state: "review_required", review_code: "foreign_connection" });
    expect(binding).toEqual({ connection_id: null, binding_revision: 1, state: "review_required", review_code: "foreign_connection" });
    expect(db.query("SELECT metadata FROM presets WHERE id = ?").get("foreign")).toEqual({ metadata: "{}" });
    db.close();
  });

  test("retains owned legacy bindings and starts their monotonic revision", () => {
    const db = migratePresets(
      [{ id: "local", metadata: { agentConfig: legacyConfig({ profiles: [legacyProfile("local-connection")] }) } }],
      [{ id: "local-connection", userId: USER_ID }],
    );
    const config = db.query("SELECT agents_enabled, allowed_modes, default_mode, state FROM preset_agent_configs WHERE preset_id = ?").get("local") as Record<string, unknown>;
    const binding = db.query("SELECT connection_id, binding_revision, state, review_code FROM preset_agent_slot_bindings WHERE preset_id = ?").get("local") as Record<string, unknown>;
    expect(config).toEqual({ agents_enabled: 1, allowed_modes: "[\"response\"]", default_mode: "response", state: "ready" });

    expect(binding).toEqual({ connection_id: "local-connection", binding_revision: 1, state: "ready", review_code: null });
    db.close();
  });
  test("quarantines bindings to imported or stale connection rows", () => {
    const db = migratePresets(
      [{ id: "stale", metadata: { agentConfig: legacyConfig({ profiles: [legacyProfile("stale-connection")] }) } }],
      [{
        id: "stale-connection",
        userId: USER_ID,
        metadata: {
          __lumiverse_import_review_required: true,
          __lumiverse_import_review_code: "foreign_import",
        },
      }],
    );
    expect(db.query("SELECT agents_enabled, state, review_code FROM preset_agent_configs WHERE preset_id = ?").get("stale")).toEqual({
      agents_enabled: 0,
      state: "review_required",
      review_code: "foreign_connection",
    });
    expect(db.query("SELECT connection_id, state, review_code FROM preset_agent_slot_bindings WHERE preset_id = ?").get("stale")).toEqual({
      connection_id: null,
      state: "review_required",
      review_code: "foreign_connection",
    });
    db.close();
  });

  test("increments binding revisions across normalized config rewrites", () => {
    const db = initDatabase(":memory:");
    createParentSchema(db);
    db.run("INSERT INTO presets (id, user_id, metadata) VALUES (?, ?, ?)", ["rewrite", USER_ID, "{}"]);
    db.run(migrationSql);
    db.run("INSERT INTO connection_profiles (id, user_id) VALUES (?, ?)", ["owned-connection", USER_ID]);
    const config = {
      version: 2 as const,
      agentsEnabled: true,
      allowedModes: ["response"] as ["response"],
      defaultMode: "response" as const,
      maxInvocations: 4,
      maxToolCalls: 8,
      mainToolIds: [] as [],
      mainLoreScope: "active" as const,
      profiles: [],
      connectionSlots: [{ id: "writer", label: "Writer", requiredCapabilities: ["generation"] as ["generation"] }],
    };
    const first = writePresetAgentConfig(USER_ID, "rewrite", { config, bindings: [{ slotId: "writer", connectionId: "owned-connection" }] });
    expect(first.configRevision).toBe(2);
    expect(first.bindings[0]?.bindingRevision).toBe(2);
    const second = writePresetAgentConfig(USER_ID, "rewrite", { config: { ...config, connectionSlots: [] }, bindings: [], expectedConfigRevision: first.configRevision });
    expect(second.configRevision).toBe(3);
    expect(second.bindings).toEqual([]);
    const third = writePresetAgentConfig(USER_ID, "rewrite", { config, bindings: [{ slotId: "writer", connectionId: "owned-connection" }], expectedConfigRevision: second.configRevision });
    expect(third.configRevision).toBe(4);
    expect(third.bindings[0]?.bindingRevision).toBe(4);
    closeDatabase();
  });

  test("requires revision zero for the first chat mode override write", () => {
    const db = initDatabase(":memory:");
    createParentSchema(db);
    db.run("INSERT INTO chats (id, user_id) VALUES (?, ?)", ["chat-1", USER_ID]);
    db.run(migrationSql);
    expect(() => setChatAgentModeOverride(USER_ID, "chat-1", "agentic")).toThrow("AGENT_CHAT_MODE_REVISION_REQUIRED");
    expect(() => setChatAgentModeOverride(USER_ID, "chat-1", "agentic", 1)).toThrow("AGENT_CHAT_MODE_REVISION_CONFLICT");
    expect(() => setChatAgentModeOverride(USER_ID, "chat-1", "agentic", -1)).toThrow("AGENT_CHAT_MODE_REVISION_REQUIRED");
    const first = setChatAgentModeOverride(USER_ID, "chat-1", "agentic", 0);
    expect(first?.revision).toBe(1);
    expect(() => setChatAgentModeOverride(USER_ID, "chat-1", "response", 0)).toThrow("AGENT_CHAT_MODE_REVISION_CONFLICT");

    db.query("UPDATE chat_agent_mode_overrides SET revision = ? WHERE user_id = ? AND chat_id = ?")
      .run(Number.MAX_SAFE_INTEGER - 1, USER_ID, "chat-1");
    const last = setChatAgentModeOverride(USER_ID, "chat-1", "response", Number.MAX_SAFE_INTEGER - 1);
    expect(last?.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => setChatAgentModeOverride(USER_ID, "chat-1", "agentic", Number.MAX_SAFE_INTEGER))
      .toThrow("AGENT_CHAT_MODE_REVISION_CONFLICT");
    closeDatabase();
  });
});

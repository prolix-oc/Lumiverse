import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { presetsRoutes } from "./presets.routes";
import { AGENT_RUNTIME_HOST_LIMITS } from "../services/agent-runtime-limits";

async function initPresetsTestDb(): Promise<void> {
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
  getDb().run(`CREATE TABLE "user" (
    id TEXT PRIMARY KEY
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
    name TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    api_url TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    preset_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    has_api_key INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().exec(`
    CREATE TABLE preset_agent_configs (
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
    );
    CREATE TABLE preset_agent_connection_slots (
      user_id TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      label TEXT NOT NULL,
      required_capabilities TEXT NOT NULL DEFAULT '[]',
      slot_revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, preset_id, slot_id)
    );
    CREATE TABLE preset_agent_profiles (
      user_id TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      connection_ref_kind TEXT NOT NULL,
      slot_id TEXT,
      tool_ids TEXT NOT NULL DEFAULT '[]',
      workspace_capabilities TEXT NOT NULL DEFAULT '[]',
      lore_scope TEXT NOT NULL,
      allow_main_delegation INTEGER NOT NULL,
      failure_policy TEXT NOT NULL,
      stream_activity INTEGER NOT NULL,
      max_output_tokens INTEGER NOT NULL,
      timeout_ms INTEGER NOT NULL,
      profile_revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, preset_id, profile_id)
    );
    CREATE TABLE preset_agent_slot_bindings (
      user_id TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      connection_id TEXT,
      binding_revision INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'ready',
      review_code TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, preset_id, slot_id)
    );
  `);
  getDb().run(await Bun.file(join(import.meta.dir, "..", "db", "migrations", "127_agent_runtime_repair_acknowledgements.sql")).text());
  getDb().query('INSERT INTO "user" (id) VALUES (?)').run("u1");
  getDb().run(`CREATE TABLE regex_scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    preset_id TEXT
  )`);
}

function insertPreset(id: string, userId: string, cacheRevision = 0): void {
  getDb().run(
    `INSERT INTO presets (id, name, provider, parameters, prompt_order, metadata, created_at, updated_at, prompts, user_id, engine, cache_revision)
     VALUES (?, 'Preset', 'loom', '{}', '[]', '{}', 1, 1, '{}', ?, 'classic', ?)`,
    [id, userId, cacheRevision],
  );
}

const app = new Hono();
app.use("*", async (c, next) => {
  const userId = c.req.header("x-test-user");
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
});
app.route("/", presetsRoutes);

beforeEach(initPresetsTestDb);
afterEach(() => closeDatabase());

describe("preset cache validators", () => {
  test("scopes empty registry ETags to the authenticated user and varies on cookies", async () => {
    const first = await app.request("http://localhost/registry", { headers: { "x-test-user": "u1" } });
    const second = await app.request("http://localhost/registry", { headers: { "x-test-user": "u2" } });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("etag")).not.toBe(second.headers.get("etag"));
    expect(first.headers.get("vary")).toBe("Cookie, Accept-Encoding");
  });

  test("invalidates a full preset ETag when its cache revision changes", async () => {
    insertPreset("preset-1", "u1");
    const first = await app.request("http://localhost/preset-1", { headers: { "x-test-user": "u1" } });
    const etag = first.headers.get("etag");
    expect(first.status).toBe(200);
    expect(etag).not.toBeNull();
    expect(etag).toStartWith('W/"');
    const notModified = await app.request("http://localhost/preset-1", {
      headers: { "x-test-user": "u1", "if-none-match": etag!.slice(2) },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("etag")).toBe(etag);
    expect(notModified.headers.get("vary")).toBe("Cookie, Accept-Encoding");

    getDb().run("UPDATE presets SET cache_revision = 1 WHERE id = ?", ["preset-1"]);
    const second = await app.request("http://localhost/preset-1", {
      headers: { "x-test-user": "u1", "if-none-match": etag! },
    });
    expect(second.status).toBe(200);
    expect(second.headers.get("etag")).not.toBe(etag);
    expect(second.headers.get("vary")).toBe("Cookie, Accept-Encoding");
  });
  test("invalidates a full preset ETag after a config-only Agent Runtime save", async () => {
    insertPreset("preset-1", "u1", 7);
    getDb().query(
      "INSERT INTO preset_agent_configs (user_id, preset_id, config_revision, binding_revision) VALUES (?, ?, ?, ?)",
    ).run("u1", "preset-1", 1, 1);

    const first = await app.request("http://localhost/preset-1", {
      headers: { "x-test-user": "u1" },
    });
    const firstEtag = first.headers.get("etag");
    const firstBody = await first.json();
    expect(first.status).toBe(200);
    expect(firstEtag).not.toBeNull();
    expect(firstBody.cache_revision).toBe(7);
    expect(firstBody.agent_config_revision).toBe(1);

    const editorResponse = await app.request("http://localhost/preset-1/agent-config", {
      headers: { "x-test-user": "u1" },
    });
    const editor = await editorResponse.json();
    expect(editorResponse.status).toBe(200);

    const savedResponse = await app.request("http://localhost/preset-1/agent-config", {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        config: { ...editor.config, maxInvocations: 63 },
        slotBindings: editor.slotBindings,
        taskTemplates: editor.taskTemplates,
        reviewAcknowledgements: editor.reviewAcknowledgements,
        promptOrder: [],
        expectedPresetRevision: 7,
        expectedConfigRevision: 1,
      }),
    });
    const saved = await savedResponse.json();
    expect(savedResponse.status).toBe(200);
    expect(saved.editor.presetRevision).toBe(7);
    expect(saved.editor.configRevision).toBe(2);

    const refreshed = await app.request("http://localhost/preset-1", {
      headers: { "x-test-user": "u1", "if-none-match": firstEtag! },
    });
    const refreshedEtag = refreshed.headers.get("etag");
    const refreshedBody = await refreshed.json();
    expect(refreshed.status).toBe(200);
    expect(refreshedEtag).not.toBe(firstEtag);
    expect(refreshedBody.cache_revision).toBe(7);
    expect(refreshedBody.agent_config_revision).toBe(2);
    expect(refreshedBody.agent_config.maxInvocations).toBe(63);

    const unchanged = await app.request("http://localhost/preset-1", {
      headers: { "x-test-user": "u1", "if-none-match": refreshedEtag! },
    });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(refreshedEtag);
  });
  test("returns a revision conflict without clobbering, then increments on a matching update", async () => {
    insertPreset("preset-1", "u1", 3);

    const stale = await app.request("http://localhost/preset-1", {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        name: "stale",
        metadata: { stale: true },
        expected_cache_revision: 2,
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "Preset preset-1 changed since revision 2; current revision is 3",
      code: "PRESET_REVISION_CONFLICT",
      expected_cache_revision: 2,
      actual_cache_revision: 3,
    });

    const successful = await app.request("http://localhost/preset-1", {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        name: "newer",
        expected_cache_revision: 3,
      }),
    });
    expect(successful.status).toBe(200);
    const updated = await successful.json();
    expect(updated.name).toBe("newer");
    expect(updated.cache_revision).toBe(4);

    const row = getDb().query("SELECT name, metadata, cache_revision FROM presets WHERE id = ?").get("preset-1");
    expect(row).toEqual({ name: "newer", metadata: "{}", cache_revision: 4 });
  });

  test("rejects unconditional updates without a revision precondition", async () => {
    insertPreset("preset-1", "u1", 3);

    const response = await app.request("http://localhost/preset-1", {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({ metadata: { stale: true } }),
    });

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({
      error: "expected_cache_revision is required",
      code: "PRESET_REVISION_REQUIRED",
    });
    const row = getDb().query("SELECT metadata, cache_revision FROM presets WHERE id = ?").get("preset-1");
    expect(row).toEqual({ metadata: "{}", cache_revision: 3 });
  });
});

describe("preset agent config validation", () => {
  test("strips reserved runtime metadata from ordinary create and update DTOs", async () => {
    const response = await app.request("http://localhost/", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Ordinary preset",
        provider: "loom",
        metadata: {
          agentConfig: { version: 1, enabled: true },
          agent_config: { version: 2, agentsEnabled: true },
          portableAgentConfig: { portableVersion: 1 },
          agentRuntime: { version: 1 },
          extensionData: { keep: true },
        },
      }),
    });

    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.metadata).toEqual({ extensionData: { keep: true } });
    expect(created.agent_config).toBeUndefined();

    const updatedResponse = await app.request(`http://localhost/${created.id}`, {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        expected_cache_revision: created.cache_revision,
        metadata: {
          agentConfigReviewRequired: true,
          agent_config_review: { state: "ready" },
          agent_runtime: { version: 1 },
          extensionData: { keep: "updated" },
        },
      }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json();
    expect(updated.metadata).toEqual({ extensionData: { keep: "updated" } });
    expect(updated.agent_config).toBeUndefined();
  });

  test("rejects V1 through the normalized V2 create DTO", async () => {
    const response = await app.request("http://localhost/", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        name: "Legacy authority",
        provider: "loom",
        agent_config: {
          version: 1,
          enabled: true,
          maxInvocations: 64,
          maxToolCalls: 64,
          mainToolIds: [],
          mainLoreScope: "active",
          profiles: [],
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "agentConfig.enabled: unknown key",
      code: "AGENT_CONFIG_INVALID",
      path: "agentConfig.enabled",
    });
    expect(getDb().query("SELECT COUNT(*) AS count FROM presets").get()).toEqual({ count: 0 });
  });

  test("keeps legacy metadata inert on ordinary preset writes", async () => {
    const legacy = {
      version: 1,
      enabled: false,
      maxInvocations: 64,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
    };
    const createdResponse = await app.request("http://localhost/", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({ name: "Legacy", provider: "loom", metadata: { agentConfig: legacy } }),
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(created.metadata.agentConfig).toBeUndefined();
    expect(created.agent_config).toBeUndefined();

    const updatedResponse = await app.request(`http://localhost/${created.id}`, {
      method: "PUT",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        expected_cache_revision: created.cache_revision,
        metadata: {
          agentConfig: { ...legacy, maxToolCalls: Number.MAX_SAFE_INTEGER },
        },
      }),
    });
    expect(updatedResponse.status).toBe(200);
    const updated = await updatedResponse.json();
    expect(updated.metadata.agentConfig).toBeUndefined();
    expect(updated.agent_config).toBeUndefined();
  });

});

describe("agent runtime host limits", () => {
  test("requires authentication", async () => {
    const response = await app.request("http://localhost/agent-runtime-limits");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("returns the exact sanitized canonical numeric limits", async () => {
    const response = await app.request("http://localhost/agent-runtime-limits", {
      headers: { "x-test-user": "u1" },
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(AGENT_RUNTIME_HOST_LIMITS);
    expect(Object.keys(body).sort()).toEqual(Object.keys(AGENT_RUNTIME_HOST_LIMITS).sort());
    for (const value of Object.values(body)) {
      expect(typeof value).toBe("number");
      expect(Number.isSafeInteger(value)).toBe(true);
    }
  });
});
describe("preset runtime repair acknowledgement", () => {
  test("persists an acknowledgement with a preset revision fence and keeps it idempotent", async () => {
    insertPreset("preset-ack", "u1", 5);

    const first = await app.request("http://localhost/preset-ack/agent-runtime/repair-acknowledgement", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        expectedPresetRevision: 5,
        reasonCode: "loom_policy_repair_required",
      }),
    });

    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({
      presetId: "preset-ack",
      presetRevision: 5,
      reasonCode: "loom_policy_repair_required",
      revision: 1,
      scope: "repair/review",
      state: "acknowledged",
    });
    expect(typeof firstBody.acknowledgedAt).toBe("number");

    const repeated = await app.request("http://localhost/preset-ack/agent-runtime/repair-acknowledgement", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        expectedPresetRevision: "5",
        reasonCode: "loom_policy_repair_required",
      }),
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({
      presetId: "preset-ack",
      presetRevision: 5,
      reasonCode: "loom_policy_repair_required",
      revision: 1,
      scope: "repair/review",
      state: "acknowledged",
    });

    const persisted = getDb().query(
      "SELECT preset_revision, reason_code, revision FROM agent_runtime_repair_acknowledgements WHERE user_id = ? AND preset_id = ?",
    ).get("u1", "preset-ack");
    expect(persisted).toEqual({
      preset_revision: "5",
      reason_code: "loom_policy_repair_required",
      revision: 1,
    });
  });

  test("rejects stale or open acknowledgement requests without creating an acknowledgement", async () => {
    insertPreset("preset-ack", "u1", 5);

    const stale = await app.request("http://localhost/preset-ack/agent-runtime/repair-acknowledgement", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        expectedPresetRevision: 4,
        reasonCode: "loom_policy_repair_required",
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "PRESET_REVISION_CONFLICT" });

    const open = await app.request("http://localhost/preset-ack/agent-runtime/repair-acknowledgement", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({
        expectedPresetRevision: 5,
        reasonCode: "loom_policy_repair_required",
        extra: true,
      }),
    });
    expect(open.status).toBe(400);
    expect(await open.json()).toMatchObject({ code: "INVALID_REQUEST" });

    const count = getDb().query(
      "SELECT COUNT(*) AS count FROM agent_runtime_repair_acknowledgements",
    ).get() as { count: number };
    expect(count.count).toBe(0);
  });
});

describe("preset bulk mutations", () => {
  test("deletes only selected presets owned by the authenticated user", async () => {
    insertPreset("one", "u1");
    insertPreset("two", "u1");
    insertPreset("foreign", "u2");

    const response = await app.request("http://localhost/bulk-delete", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({ ids: ["one", "foreign"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: ["one"] });
    expect(getDb().query("SELECT id FROM presets ORDER BY id").all()).toEqual([
      { id: "foreign" },
      { id: "two" },
    ]);
  });

  test("rejects malformed bulk selections", async () => {
    const response = await app.request("http://localhost/bulk-delete", {
      method: "POST",
      headers: { "x-test-user": "u1", "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(response.status).toBe(400);
  });
});

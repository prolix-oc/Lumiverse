import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { createPreset, getPreset, updatePreset } from "../services/presets.service";
import { createRegexScript, getRegexScript, getRegexScriptsByPresetId } from "../services/regex-scripts.service";
import { validateInstallPresetPayload } from "./payload-validation";
import { installPreset as installPresetForUser, type InstallPresetDependencies } from "./installer";
import type { InstallPresetPayload } from "./types";

const USER_ID = "owner-1";
const TENANT_USER_ID = "tenant-1";

function installPreset(
  requestId: string,
  payload: InstallPresetPayload,
  userId = USER_ID,
  dependencies: InstallPresetDependencies = {},
) {
  return installPresetForUser(requestId, userId, payload, dependencies);
}

function initInstallerTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE "user" (
    id TEXT PRIMARY KEY,
    createdAt INTEGER NOT NULL
  )`);
  db.run(`INSERT INTO "user" (id, createdAt) VALUES (?, ?)` , [USER_ID, 1]);
  db.run(`INSERT INTO "user" (id, createdAt) VALUES (?, ?)` , [TENANT_USER_ID, 2]);
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
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
  db.run(`CREATE TABLE regex_scripts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    script_id TEXT NOT NULL DEFAULT '',
    find_regex TEXT NOT NULL,
    replace_string TEXT NOT NULL DEFAULT '',
    actions TEXT NOT NULL DEFAULT '[]',
    flags TEXT NOT NULL DEFAULT 'gi',
    placement TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_id TEXT,
    target TEXT NOT NULL,
    min_depth INTEGER,
    max_depth INTEGER,
    trim_strings TEXT NOT NULL,
    run_on_edit INTEGER NOT NULL DEFAULT 0,
    substitute_macros TEXT NOT NULL DEFAULT 'none',
    disabled INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT '',
    pack_id TEXT,
    preset_id TEXT,
    character_id TEXT,
    owner_extension_identifier TEXT,
    validation_error_code TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`
    CREATE TABLE preset_agent_configs (
      user_id TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      agents_enabled INTEGER NOT NULL,
      allowed_modes TEXT NOT NULL,
      default_mode TEXT NOT NULL,
      max_invocations INTEGER NOT NULL,
      max_tool_calls INTEGER NOT NULL,
      main_tool_ids TEXT NOT NULL,
      main_lore_scope TEXT NOT NULL,
      phase_policy_json TEXT NOT NULL,
      cognition_policy_json TEXT NOT NULL,
      task_policy_json TEXT NOT NULL,
      workspace_policy_json TEXT NOT NULL,
      state TEXT NOT NULL,
      review_code TEXT,
      review_acknowledged INTEGER NOT NULL,
      config_json TEXT NOT NULL,
      config_revision INTEGER NOT NULL,
      binding_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, preset_id)
    );
    CREATE TABLE preset_agent_connection_slots (
      user_id TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      label TEXT NOT NULL,
      required_capabilities TEXT NOT NULL,
      slot_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
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
      tool_ids TEXT NOT NULL,
      workspace_capabilities TEXT NOT NULL,
      lore_scope TEXT NOT NULL,
      allow_main_delegation INTEGER NOT NULL,
      failure_policy TEXT NOT NULL,
      stream_activity INTEGER NOT NULL,
      max_output_tokens INTEGER NOT NULL,
      timeout_ms INTEGER NOT NULL,
      profile_revision INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, preset_id, profile_id)
    );
    CREATE TABLE preset_agent_slot_bindings (
      user_id TEXT NOT NULL,
      preset_id TEXT NOT NULL,
      slot_id TEXT NOT NULL,
      connection_id TEXT,
      binding_revision INTEGER NOT NULL,
      state TEXT NOT NULL,
      review_code TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, preset_id, slot_id)
    );
  `);
  db.run(`CREATE UNIQUE INDEX idx_regex_scripts_script_id
    ON regex_scripts(user_id, script_id)
    WHERE script_id != ''`);
}

function installPayload(
  presetId: string,
  preset: Record<string, unknown>,
): InstallPresetPayload {
  return {
    source: "lumihub",
    presetId,
    presetName: "Hub preset",
    presetVersion: "1.0.0",
    presetCreator: "creator",
    presetSlug: "creator/hub-preset",
    presetData: {
      type: "lumiverse_preset",
      preset,
    },
  };
}
function canonicalPromptBlock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "block-1",
    name: "Block 1",
    content: "ordinary content",
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    color: null,
    isLocked: false,
    injectionTrigger: [],
    ...overrides,
  };
}

function presetCount(userId = USER_ID): number {
  const row = getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(userId) as { count: number };
  return row.count;
}

function portableRuntimeEnvelope(): Record<string, unknown> {
  return {
    version: 1,
    agentConfig: {
      portableVersion: 1,
      agentsEnabled: true,
      allowedModes: ["response", "agentic"],
      defaultMode: "agentic",
      maxInvocations: 4,
      maxToolCalls: 8,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
      connectionSlots: [],
    },
    taskTemplates: [],
  };
}

beforeEach(initInstallerTestDb);
afterEach(() => closeDatabase());

describe("LumiHub preset installer metadata", () => {
  test("routes an embedded portable runtime envelope through the atomic importer", async () => {
    const payload = installPayload("hub-runtime", {
      name: "Runtime Hub",
      blocks: [],
    });
    const runtime = portableRuntimeEnvelope();
    payload.presetData.agentRuntime = runtime;
    const calls: Array<{ userId: string; input: unknown }> = [];
    const result = await installPreset("request-runtime", payload, USER_ID, {
      importPortablePresetRuntime: (userId, input) => {
        calls.push({ userId, input });
        return {
          preset: { id: "imported-runtime", name: "Runtime Hub" },
          agent_config: { version: 2, agentsEnabled: false, allowedModes: ["response"], defaultMode: "response" },
          agent_config_review: { state: "review_required", reasonCode: "foreign_import", unresolvedSlotIds: [], staleSlotIds: [], acknowledged: false },
        } as any;
      },
    });
    expect(result).toEqual({ requestId: "request-runtime", success: true, presetId: "imported-runtime", presetName: "Runtime Hub" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userId).toBe(USER_ID);
    const input = calls[0]?.input;
    const forwardedRuntime = input && typeof input === "object" && "agentRuntime" in input ? input.agentRuntime : undefined;
    expect(forwardedRuntime).toEqual(runtime);
  });

  test("rejects a malformed embedded runtime envelope before importer dispatch", async () => {
    const payload = installPayload("hub-runtime-invalid", {
      name: "Invalid Runtime Hub",
      blocks: [],
    });
    payload.presetData.agentRuntime = { version: 2 };
    let called = false;
    const result = await installPreset("request-runtime-invalid", payload, USER_ID, {
      importPortablePresetRuntime: () => {
        called = true;
        throw new Error("must not dispatch");
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("AGENT_RUNTIME_PORTABLE_INVALID");
    expect(called).toBe(false);
  });

  test("imports a cover URL embedded in the preset payload", async () => {
    const result = await installPreset("request-cover", installPayload("hub-cover", {
      name: "Covered preset",
      blocks: [],
      coverUrl: "https://cdn.example.test/cover.webp",
    }));

    expect(result.success).toBe(true);
    expect(getPreset(USER_ID, result.presetId!)?.metadata.coverUrl).toBe("https://cdn.example.test/cover.webp");
  });

  test("keeps older bundled regexes disabled without touching a same-named local folder", async () => {
    const firstPayload = installPayload("hub-regex-history", {
      name: "Hub preset",
      presetVersion: "1.0.0",
      blocks: [],
    });
    firstPayload.presetData.regex_scripts = [{
      name: "Bundled v1",
      find_regex: "v1",
      disabled: false,
    }];
    const first = await installPreset("request-regex-v1", firstPayload);
    expect(first.success).toBe(true);

    const local = createRegexScript(USER_ID, {
      name: "Local same-folder regex",
      find_regex: "local",
      folder: "Hub preset",
      disabled: false,
    });
    expect(typeof local).not.toBe("string");

    const secondPayload = installPayload("hub-regex-history", {
      name: "Hub preset",
      presetVersion: "2.0.0",
      blocks: [],
    });
    secondPayload.presetVersion = "2.0.0";
    secondPayload.presetData.regex_scripts = [{
      name: "Bundled v2",
      find_regex: "v2",
      folder: "Hub preset",
      disabled: false,
    }];
    const second = await installPreset("request-regex-v2", secondPayload);
    expect(second.success).toBe(true);
    expect(second.presetId).toBe(first.presetId);

    const bundled = getRegexScriptsByPresetId(USER_ID, first.presetId!);
    const v1 = bundled.find((script) => script.metadata._lumiverse_lumihub_preset?.version === "1.0.0");
    const v2 = bundled.find((script) => script.metadata._lumiverse_lumihub_preset?.version === "2.0.0");
    expect(v1).toMatchObject({ disabled: true, folder: "Hub preset · v1.0.0" });
    expect(v2).toMatchObject({ disabled: true, folder: "Hub preset · LumiHub" });
    expect(getRegexScript(USER_ID, (local as { id: string }).id)).toMatchObject({
      disabled: false,
      folder: "Hub preset",
      preset_id: null,
      metadata: {},
    });
  });

  test("imports and versions Illarin-packaged regexes with Illarin provenance", async () => {
    const illarinPayload = (version: string, findRegex: string): InstallPresetPayload => ({
      source: "illarin",
      presetId: "illarin-asset-1",
      presetName: "Illarin preset",
      presetVersion: version,
      presetData: {
        preset: {
          name: "Illarin preset",
          presetVersion: version,
          blocks: [],
          regex_scripts: [{
            name: `Bundled ${version}`,
            find_regex: findRegex,
            folder: "Publisher scripts",
            disabled: false,
          }],
        },
      },
    });

    const first = await installPreset("illarin-v1", illarinPayload("1.0.0", "v1"));
    expect(first.success).toBe(true);
    const local = createRegexScript(USER_ID, {
      name: "Local publisher script",
      find_regex: "local",
      folder: "Publisher scripts",
      disabled: false,
    });
    expect(typeof local).not.toBe("string");

    const second = await installPreset("illarin-v2", illarinPayload("2.0.0", "v2"));
    expect(second.success).toBe(true);
    expect(second.presetId).toBe(first.presetId);

    const preset = getPreset(USER_ID, first.presetId!);
    expect(preset?.metadata).toMatchObject({
      _lumiverse_install_source: "illarin",
      _lumiverse_illarin_asset_id: "illarin-asset-1",
      _lumiverse_preset_version: "2.0.0",
    });
    expect(preset?.metadata._lumiverse_lumihub_id).toBeUndefined();

    const bundled = getRegexScriptsByPresetId(USER_ID, first.presetId!);
    const v1 = bundled.find((script) => script.metadata._lumiverse_illarin_preset?.version === "1.0.0");
    const v2 = bundled.find((script) => script.metadata._lumiverse_illarin_preset?.version === "2.0.0");
    expect(v1).toMatchObject({
      disabled: true,
      folder: "Publisher scripts · v1.0.0",
      metadata: { _lumiverse_illarin_preset: { id: "illarin-asset-1", folderName: "Publisher scripts" } },
    });
    expect(v2).toMatchObject({
      folder: "Publisher scripts · Illarin",
      metadata: { _lumiverse_illarin_preset: { id: "illarin-asset-1", folderName: "Publisher scripts" } },
    });
    expect(getRegexScript(USER_ID, (local as { id: string }).id)).toMatchObject({
      disabled: false,
      folder: "Publisher scripts",
      preset_id: null,
      metadata: {},
    });
  });

  test("fails an Illarin install when its packaged regex set is incomplete", async () => {
    const result = await installPreset("illarin-invalid-regex", {
      source: "illarin",
      presetId: "illarin-asset-invalid",
      presetName: "Broken Illarin preset",
      presetVersion: "1.0.0",
      presetData: {
        preset: {
          name: "Broken Illarin preset",
          presetVersion: "1.0.0",
          blocks: [],
          regex_scripts: [null],
        },
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Illarin preset regex import was incomplete");
  });

  test("preserves internal passthrough metadata on create and serialized metadata on update", async () => {
    const first = await installPreset("request-1", installPayload("hub-1", {
      name: "Hub preset",
      blocks: [],
      source: { kind: "loom" },
      description: "Native description",
      passthroughMetadata: {
        agentic_preset_composer: { mode: "single", revision: 1 },
        unrelated_extension: { enabled: true },
        source: { attempted: "override" },
        description: "attempted override",
        _lumiverse_lumihub_id: "attempted override",
      },
    }));

    expect(first.success).toBe(true);
    expect(first.presetId).toBeString();
    const created = getPreset(USER_ID, first.presetId!);
    expect(created?.metadata).toMatchObject({
      agentic_preset_composer: { mode: "single", revision: 1 },
      unrelated_extension: { enabled: true },
      source: { kind: "loom" },
      description: "Native description",
      _lumiverse_lumihub_id: "hub-1",
      _lumiverse_install_source: "lumihub",
    });

    const second = await installPreset("request-2", installPayload("hub-1", {
      name: "Hub preset updated",
      blocks: [],
      source: { kind: "loom-updated" },
      description: "Native updated description",
      metadata: {
        agentic_preset_composer: { mode: "parallel", revision: 2 },
        unrelated_extension: { enabled: false, revision: 2 },
        _lumiverse_lumihub_id: "attempted override",
        description: "attempted override",
      },
    }));

    expect(second.success).toBe(true);
    expect(second.presetId).toBe(first.presetId);
    const updated = getPreset(USER_ID, first.presetId!);
    expect(updated?.name).toBe("Hub preset updated");
    expect(updated?.metadata).toMatchObject({
      agentic_preset_composer: { mode: "parallel", revision: 2 },
      unrelated_extension: { enabled: false, revision: 2 },
      source: { kind: "loom-updated" },
      description: "Native updated description",
      _lumiverse_lumihub_id: "hub-1",
      _lumiverse_install_source: "lumihub",
    });
  });

  test("validates authored agentConfig but never persists executable metadata without normalized storage", async () => {
    const agentConfig = {
      version: 1,
      enabled: true,
      maxInvocations: 64,
      maxToolCalls: 64,
      mainToolIds: ["chat_search_history"],
      mainLoreScope: "active",
      profiles: [{
        id: "writer",
        name: "Writer",
        systemPrompt: "literal",
        connectionProfileId: null,
        toolIds: ["lore_search_entries"],
        loreScope: "active",
        allowMainDelegation: true,
        failurePolicy: "required",
        streamActivity: true,
        maxOutputTokens: 64,
        timeoutMs: 5_000,
      }],
    };
    const first = await installPreset("request-agent-1", installPayload("hub-agent", {
      name: "Agent Hub",
      blocks: [],
      passthroughMetadata: { agentConfig, untouched: { value: 1 } },
    }));
    expect(first.success).toBe(true);
    const created = getPreset(USER_ID, first.presetId!);
    expect(created?.metadata.agentConfig).toBeUndefined();
    expect(created?.metadata.agentConfigReviewRequired).toBeUndefined();
    expect(created?.metadata.untouched).toEqual({ value: 1 });

    const second = await installPreset("request-agent-2", installPayload("hub-agent", {
      name: "Agent Hub Updated",
      blocks: [],
      metadata: { agentConfig },
    }));
    expect(second.success).toBe(true);
    const updated = getPreset(USER_ID, first.presetId!);
    expect(updated?.metadata.agentConfig).toBeUndefined();

    const alreadyDisabled = await installPreset("request-agent-3", installPayload("hub-agent-disabled", {
      name: "Hub Agent Already Disabled",
      blocks: [],
      metadata: {
        agentConfig: { ...agentConfig, enabled: false },
        untouched: { value: 2 },
      },
    }));
    expect(alreadyDisabled.success).toBe(true);
    const disabledCreated = getPreset(USER_ID, alreadyDisabled.presetId!);
    expect(disabledCreated?.metadata.agentConfig).toBeUndefined();
    expect(disabledCreated?.metadata.agentConfigReviewRequired).toBeUndefined();
    expect(disabledCreated?.metadata.untouched).toEqual({ value: 2 });

    const invalid = await installPreset("request-agent-4", installPayload("hub-agent-invalid", {
      name: "Hub Agent Invalid",
      blocks: [],
      metadata: {
        agentConfig: { ...agentConfig, mainToolIds: ["not_a_tool"] },
      },
    }));
    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain("agentConfig.mainToolIds[0]");
  });

  test("validates legacy limits without persisting executable metadata", async () => {
    const legacyConfig = {
      version: 1,
      enabled: true,
      maxInvocations: 64,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
    };
    const legacy = await installPreset("request-agent-legacy", installPayload("hub-agent-legacy", {
      name: "Legacy Agent",
      blocks: [],
      metadata: { agentConfig: legacyConfig },
    }));
    expect(legacy.success).toBe(true);
    expect(getPreset(USER_ID, legacy.presetId!)?.metadata.agentConfig).toBeUndefined();

    for (const maxToolCalls of [1, 64, Number.MAX_SAFE_INTEGER]) {
      const result = await installPreset(
        `request-agent-${maxToolCalls}`,
        installPayload(`hub-agent-${maxToolCalls}`, {
          name: `Agent ${maxToolCalls}`,
          blocks: [],
          metadata: { agentConfig: { ...legacyConfig, maxToolCalls } },
        }),
      );
      expect(result.success).toBe(true);
      expect(getPreset(USER_ID, result.presetId!)?.metadata.agentConfig).toBeUndefined();
    }
  });

  test("preserves a locally-added passthrough key when an update omits it", async () => {
    const first = await installPreset("request-3", installPayload("hub-3", {
      name: "Hub preset",
      blocks: [],
      passthroughMetadata: {
        agentic_preset_composer: { mode: "parallel", graph: true },
      },
    }));
    expect(first.success).toBe(true);

    const updated = await installPreset("request-4", installPayload("hub-3", {
      name: "Hub preset update",
      blocks: [],
      metadata: {
        unrelated_extension: { retained: true },
      },
    }));
    expect(updated.success).toBe(true);
    const saved = getPreset(USER_ID, first.presetId!);
    expect(saved?.metadata).toMatchObject({
      agentic_preset_composer: { mode: "parallel", graph: true },
      unrelated_extension: { retained: true },
    });
  });

  test("rejects metadata with an arbitrary prototype", () => {
    const metadata = Object.create({ inherited: true }) as Record<string, unknown>;
    metadata.agentic_preset_composer = { mode: "single" };
    const validation = validateInstallPresetPayload(installPayload("hub-2", {
      name: "Malformed",
      blocks: [],
      passthroughMetadata: metadata,
    }));

    expect(validation.ok).toBe(false);
    if (!validation.ok) expect(validation.error).toContain("passthroughMetadata");
  });

  test("rejects accessor-backed metadata before it can execute", async () => {
    const preset = {
      name: "Accessor-backed",
      blocks: [],
    } as Record<string, unknown>;
    Object.defineProperty(preset, "passthroughMetadata", {
      enumerable: true,
      get() {
        throw new Error("metadata getter executed");
      },
    });

    const validation = validateInstallPresetPayload(installPayload("hub-4", preset));
    expect(validation.ok).toBe(false);

    const result = await installPreset("request-5", installPayload("hub-4", preset));
    expect(result.success).toBe(false);
    expect(result.error).toContain("passthroughMetadata");
  });

  test("rejects hidden metadata serialization hooks", () => {
    const metadata = {
      agentic_preset_composer: { mode: "single" },
    };
    Object.defineProperty(metadata, "toJSON", {
      enumerable: false,
      value: () => ({ injected: true }),
    });

    const validation = validateInstallPresetPayload(installPayload("hub-5", {
      name: "Hidden hook",
      blocks: [],
      passthroughMetadata: metadata,
    }));
    expect(validation.ok).toBe(false);
  });

  test("updates the installed row while retaining user configuration", async () => {
    const first = await installPreset("request-config-1", installPayload("hub-config", {
      name: "Configurable preset",
      samplerOverrides: { enabled: true, temperature: 0.2 },
      customBody: { enabled: false, rawJson: "{}" },
      blocks: [
        {
          id: "category-old",
          name: "Old category",
          content: "",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          color: null,
          isLocked: false,
          injectionTrigger: [],
          marker: "category",
          categoryMode: "checkbox",
        },
        {
          id: "block-1",
          name: "Original prompt",
          content: "Original content",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          marker: null,
          color: null,
          isLocked: false,
          injectionTrigger: [],
          group: "category-old",
          variables: [
            { id: "var-text", name: "instruction", label: "Instruction", type: "text", defaultValue: "Default" },
            { id: "var-number", name: "creativity", label: "Creativity", type: "number", defaultValue: 2, min: 0, max: 10 },
            {
              id: "var-select",
              name: "style",
              label: "Style",
              type: "select",
              defaultValue: "warm-old",
              options: [{ id: "warm-old", label: "Warm", value: "Warm style" }],
            },
            {
              id: "var-multi",
              name: "guides",
              label: "Guides",
              type: "multiselect",
              defaultValue: [],
              options: [
                { id: "concise-old", label: "Concise", value: "Be concise" },
                { id: "polite-old", label: "Polite", value: "Be polite" },
              ],
            },
            { id: "var-switch", name: "legacyToggle", label: "Toggle", type: "switch", defaultValue: 0 },
          ],
        },
      ],
      promptVariables: {},
    }));
    expect(first.success).toBe(true);

    const installed = getPreset(USER_ID, first.presetId!)!;
    const userSamplerOverrides = { enabled: true, temperature: 0.83, topP: 0.91 };
    const userCustomBody = { enabled: true, rawJson: "{\"provider_setting\":true}" };
    updatePreset(USER_ID, installed.id, {
      parameters: {
        samplerOverrides: userSamplerOverrides,
        customBody: userCustomBody,
      },
      metadata: {
        ...installed.metadata,
        promptVariables: {
          "block-1": {
            instruction: "User instruction",
            creativity: 8,
            style: "warm-old",
            guides: ["concise-old", "polite-old"],
            legacyToggle: 1,
          },
        },
      },
    });
    const binding = {
      preset_id: installed.id,
      block_states: { "block-1": false },
      captured_at: 123,
    };
    getDb().query(
      "INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)",
    ).run("presetProfileDefaults:" + installed.id, JSON.stringify(binding), USER_ID, 123);

    const second = await installPreset("request-config-2", installPayload("hub-config", {
      name: "Configurable preset v2",
      samplerOverrides: { enabled: true, temperature: 0.4 },
      customBody: { enabled: false, rawJson: "{\"publisher\":true}" },
      blocks: [
        {
          id: "category-new",
          name: "Adjusted category",
          content: "",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          color: null,
          isLocked: false,
          injectionTrigger: [],
          marker: "category",
          categoryMode: "radio",
        },
        {
          id: "block-1",
          name: "Updated prompt",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          marker: null,
          color: null,
          isLocked: false,
          injectionTrigger: [],
          content: "Updated content",
          group: "category-new",
          variables: [
            { id: "var-text", name: "directive", label: "Directive", type: "textarea", defaultValue: "New default" },
            { id: "var-number", name: "creativity", label: "Creativity", type: "slider", defaultValue: 2, min: 0, max: 5 },
            {
              id: "var-select",
              name: "style",
              label: "Style",
              type: "select",
              defaultValue: "warm-new",
              options: [{ id: "warm-new", label: "Warm", value: "Warm style" }],
            },
            {
              id: "var-multi",
              name: "guides",
              label: "Guides",
              type: "multiselect",
              defaultValue: [],
              options: [{ id: "concise-new", label: "Concise", value: "Be concise" }],
            },
            {
              id: "var-switch",
              name: "mode",
              label: "Mode",
              type: "select",
              defaultValue: "publisher-mode",
              options: [{ id: "publisher-mode", label: "Publisher", value: "Publisher" }],
            },
          ],
        },
        {
          id: "block-2",
          name: "New prompt",
          content: "New block content",
          role: "system",
          enabled: true,
          position: "pre_history",
          depth: 0,
          marker: null,
          color: null,
          isLocked: false,
          injectionTrigger: [],
          group: "category-new",
          variables: [
            { id: "var-new", name: "newVariable", label: "New", type: "text", defaultValue: "new" },
          ],
        },
      ],
      promptVariables: {
        "block-1": {
          directive: "Publisher instruction",
          creativity: 2,
          style: "warm-new",
          guides: [],
          mode: "publisher-mode",
        },
        "block-2": { newVariable: "Publisher new value" },
      },
    }));

    expect(second.success).toBe(true);
    expect(second.presetId).toBe(first.presetId);
    const updated = getPreset(USER_ID, first.presetId!)!;
    expect(updated.name).toBe("Configurable preset v2");
    expect(updated.parameters).toEqual({
      samplerOverrides: userSamplerOverrides,
      customBody: userCustomBody,
    });
    expect(updated.prompt_order.map((block) => ({
      id: block.id,
      name: block.name,
      content: block.content,
      group: block.group,
      categoryMode: block.categoryMode,
    }))).toEqual([
      { id: "category-new", name: "Adjusted category", content: "", group: undefined, categoryMode: "radio" },
      { id: "block-1", name: "Updated prompt", content: "Updated content", group: "category-new", categoryMode: undefined },
      { id: "block-2", name: "New prompt", content: "New block content", group: "category-new", categoryMode: undefined },
    ]);
    expect(updated.metadata.promptVariables).toEqual({
      "block-1": {
        directive: "User instruction",
        creativity: 5,
        style: "warm-new",
        guides: ["concise-new"],
        mode: "publisher-mode",
      },
      "block-2": { newVariable: "Publisher new value" },
    });
    const savedBinding = getDb().query(
      "SELECT value FROM settings WHERE key = ? AND user_id = ?",
    ).get("presetProfileDefaults:" + installed.id, USER_ID) as { value: string };
    expect(JSON.parse(savedBinding.value)).toEqual(binding);
  });

  test("uses the manifest slug to update a LumiHub install whose Hub id changed", async () => {
    const first = await installPreset("request-identity-1", installPayload("old-hub-id", {
      name: "Hub preset",
      blocks: [],
    }));
    expect(first.success).toBe(true);

    const second = await installPreset("request-identity-2", installPayload("new-hub-id", {
      name: "Hub preset migrated",
      blocks: [],
    }));

    expect(second.success).toBe(true);
    expect(second.presetId).toBe(first.presetId);
    expect(getPreset(USER_ID, first.presetId!)?.metadata._lumiverse_lumihub_id).toBe("new-hub-id");
    const count = getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID) as { count: number };
    expect(count.count).toBe(1);
  });

  test("does not claim a local preset that happens to share the manifest slug", async () => {
    const local = createPreset(USER_ID, {
      name: "Local lookalike",
      provider: "loom",
      metadata: {
        _lumiverse_install_source: "local",
        _lumiverse_preset_slug: "creator/hub-preset",
      },
    });

    const installed = await installPreset("request-local-lookalike", installPayload("hub-lookalike", {
      name: "Hub preset",
      blocks: [],
    }));

    expect(installed.success).toBe(true);
    expect(installed.presetId).not.toBe(local.id);
    const count = getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID) as { count: number };
    expect(count.count).toBe(2);
  });

  test("does not claim a local import that retains the Hub preset id", async () => {
    const local = createPreset(USER_ID, {
      name: "Imported local copy",
      provider: "loom",
      metadata: {
        _lumiverse_install_source: "local",
        _lumiverse_lumihub_id: "hub-local-copy",
        _lumiverse_preset_version: "1.0.0",
      },
    });

    const installed = await installPreset("request-local-id", installPayload("hub-local-copy", {
      name: "Hub preset",
      blocks: [],
    }));

    expect(installed.success).toBe(true);
    expect(installed.presetId).not.toBe(local.id);
    const count = getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID) as { count: number };
    expect(count.count).toBe(2);
  });

  test("installs into the linked tenant user's library instead of the owner library", async () => {
    const installed = await installPreset("request-tenant", installPayload("hub-tenant", {
      name: "Tenant preset",
      blocks: [],
    }), TENANT_USER_ID);

    expect(installed.success).toBe(true);
    expect(getPreset(TENANT_USER_ID, installed.presetId!)).not.toBeNull();
    expect(getPreset(USER_ID, installed.presetId!)).toBeNull();
  });

  test("smoke-tests an embedded manifest through verified sealed-block materialization", async () => {
    const secret = "Private publisher prompt\nwith exact whitespace.";
    const digest = createHash("sha256").update(secret, "utf8").digest("hex");
    const payload = installPayload("hub-sealed", {
      name: "Sealed preset",
      blocks: [canonicalPromptBlock({
        id: "private",
        name: "Private",
        content: "{{presetBlock::dialogue.frame}}",
        sealed: true,
        sealedKey: "dialogue.frame",
        sealedSource: "lumihub",
        sealedOriginPresetId: "hub-sealed",
        sealedOriginVersion: "1.0.0",
        sealedSha256: digest,
      })],
    });
    payload.presetData.preset.portableSealedPreset = {
      hubPresetId: "hub-sealed",
      hubPresetVersion: "1.0.0",
      blocks: [{ key: "dialogue.frame", sha256: digest }],
    };
    payload.sealedPreset = undefined;
    payload.presetData.compatibility = {
      lumiverse: {
        sealedPreset: {
          version: "1.0.0",
          blocks: [{ key: "dialogue.frame", sha256: digest }],
        },
      },
    };

    const installed = await installPreset("request-sealed", payload, TENANT_USER_ID, {
      resolveSealedBlocks: async (userId, presetId, version, manifest) => {
        expect(userId).toBe(TENANT_USER_ID);
        expect(presetId).toBe("hub-sealed");
        expect(version).toBe("1.0.0");
        expect(manifest.blocks).toEqual([{ key: "dialogue.frame", sha256: digest }]);
        return { "dialogue.frame": secret };
      },
    });

    expect(installed.success).toBe(true);
    const saved = getPreset(TENANT_USER_ID, installed.presetId!);
    expect(saved?.prompt_order).toEqual([expect.objectContaining({
      content: secret,
      sealed: true,
      sealedKey: "dialogue.frame",
      sealedSource: "lumihub",
      sealedSha256: digest,
    })]);
    expect(saved?.metadata.portableSealedPreset).toEqual({
      hubPresetId: "hub-sealed",
      hubPresetVersion: "1.0.0",
      blocks: [{ key: "dialogue.frame", sha256: digest }],
    });
  });
  test("rejects sealed bypasses and preserves create/update rows", async () => {
    const secret = "private content";
    const digest = createHash("sha256").update(secret, "utf8").digest("hex");
    const exactBlock = canonicalPromptBlock({
      content: "{{presetBlock::private}}",
      sealed: true,
      sealedKey: "private",
      sealedSource: "lumihub",
      sealedSha256: digest,
    });

    const failures: Array<{
      label: string;
      block: Record<string, unknown>;
      malformedManifest?: boolean;
      portableDescriptor?: unknown;
      nestedPortableDescriptor?: unknown;
      dependencies?: InstallPresetDependencies;
    }> = [
      {
        label: "sealed-plaintext",
        block: canonicalPromptBlock({ content: secret, sealed: true }),
      },
      {
        label: "sealed-source-plaintext",
        block: canonicalPromptBlock({ content: secret, sealedSource: "lumihub" }),
      },
      {
        label: "malformed-placeholder-key",
        block: canonicalPromptBlock({
          content: "{{presetBlock::private}}",
          sealed: true,
          sealedKey: "foreign",
          sealedSource: "lumihub",
        }),
      },
      {
        label: "foreign-sealed-source",
        block: canonicalPromptBlock({
          content: "{{presetBlock::private}}",
          sealed: true,
          sealedSource: "foreign",
        }),
      },
      {
        label: "foreign-sealed-origin",
        block: canonicalPromptBlock({
          content: "{{presetBlock::private}}",
          sealed: true,
          sealedKey: "private",
          sealedSource: "lumihub",
          sealedOriginPresetId: "foreign-preset",
        }),
      },
      {
        label: "malformed-descriptor",
        block: exactBlock,
        malformedManifest: true,
      },
      {
        label: "portable-descriptor-id-mismatch",
        block: exactBlock,
        portableDescriptor: {
          hubPresetId: "foreign-preset",
          hubPresetVersion: "1.0.0",
          blocks: [{ key: "private", sha256: digest }],
        },
      },
      {
        label: "malformed-portable-descriptor",
        block: exactBlock,
        portableDescriptor: {
          hubPresetId: "hub-sealed-case",
          hubPresetVersion: "1.0.0",
          blocks: [{ key: "private", sha256: digest }],
          extra: true,
        },
      },
      {
        label: "contradictory-descriptor-carriers",
        block: exactBlock,
        portableDescriptor: {
          hubPresetId: "hub-sealed-case",
          hubPresetVersion: "1.0.0",
          blocks: [{ key: "private", sha256: digest }],
        },
        nestedPortableDescriptor: {
          hubPresetId: "foreign-preset",
          hubPresetVersion: "1.0.0",
          blocks: [{ key: "private", sha256: digest }],
        },
      },
      {
        label: "resolver-digest-mismatch",
        block: exactBlock,
        dependencies: {
          resolveSealedBlocks: async () => ({ private: "tampered content" }),
        },
      },
    ];

    const makePayload = (presetId: string, failure: (typeof failures)[number]): InstallPresetPayload => {
      const payload = installPayload(presetId, {
        name: `Failure ${failure.label}`,
        blocks: [failure.block],
      });
      payload.presetSlug = `creator/${presetId}`;
      payload.sealedPreset = failure.malformedManifest
        ? { version: "1.0.0", blocks: [{ key: "private", sha256: "invalid" }] }
        : { version: "1.0.0", blocks: [{ key: "private", sha256: digest }] };
      if (failure.portableDescriptor !== undefined) {
        payload.presetData.preset.portableSealedPreset = failure.portableDescriptor;
      }
      if (failure.nestedPortableDescriptor !== undefined) {
        payload.presetData.preset.metadata = {
          portableSealedPreset: failure.nestedPortableDescriptor,
        };
      }
      return payload;
    };

    for (const [index, failure] of failures.entries()) {
      const existingId = `hub-sealed-update-${index}`;
      const seedPayload = installPayload(existingId, {
        name: "Stable preset",
        blocks: [],
      });
      seedPayload.presetSlug = `creator/${existingId}`;
      const seeded = await installPreset(`seed-${failure.label}`, seedPayload);
      expect(seeded.success).toBe(true);
      const before = getPreset(USER_ID, seeded.presetId!)!;
      const expectedCount = index + 1;

      const created = await installPreset(
        `create-${failure.label}`,
        makePayload(`hub-sealed-create-${index}`, failure),
        USER_ID,
        failure.dependencies,
      );
      expect(created.success).toBe(false);
      expect(presetCount()).toBe(expectedCount);

      const updated = await installPreset(
        `update-${failure.label}`,
        makePayload(existingId, failure),
        USER_ID,
        failure.dependencies,
      );
      expect(updated.success).toBe(false);
      expect(getPreset(USER_ID, before.id)).toEqual(before);
      expect(presetCount()).toBe(expectedCount);
    }
  });
  test("preserves repeated unsealed block IDs as distinct prompt-order occurrences across install and update", async () => {
    const presetId = "hub-unsealed-occurrences";
    const presetSlug = "creator/" + presetId;
    const initialBlocks = [
      canonicalPromptBlock({ id: "repeated", name: "Occurrence zero", content: "zero" }),
      canonicalPromptBlock({ id: "repeated", name: "Occurrence one", content: "one" }),
    ];
    const initialPayload = installPayload(presetId, {
      name: "Repeated occurrences",
      blocks: initialBlocks,
    });
    initialPayload.presetSlug = presetSlug;

    const created = await installPreset("create-unsealed-occurrences", initialPayload);

    expect(created.success).toBe(true);
    const createdPreset = getPreset(USER_ID, created.presetId!)!;
    expect(createdPreset.prompt_order).toEqual(initialBlocks);
    expect(createdPreset.prompt_order.map((entry, promptOrder) => ({ blockId: entry.id, promptOrder }))).toEqual([
      { blockId: "repeated", promptOrder: 0 },
      { blockId: "repeated", promptOrder: 1 },
    ]);

    const updatedBlocks = [
      canonicalPromptBlock({ id: "repeated", name: "Updated occurrence zero", content: "updated zero" }),
      canonicalPromptBlock({ id: "repeated", name: "Updated occurrence one", content: "updated one" }),
    ];
    const updatePayload = installPayload(presetId, {
      name: "Repeated occurrences",
      blocks: updatedBlocks,
    });
    updatePayload.presetSlug = presetSlug;

    const updated = await installPreset("update-unsealed-occurrences", updatePayload);

    expect(updated).toMatchObject({ success: true, presetId: created.presetId });
    expect(presetCount()).toBe(1);
    const updatedPreset = getPreset(USER_ID, created.presetId!)!;
    expect(updatedPreset.prompt_order).toEqual(updatedBlocks);
    expect(updatedPreset.prompt_order.map((entry, promptOrder) => ({ blockId: entry.id, promptOrder }))).toEqual([
      { blockId: "repeated", promptOrder: 0 },
      { blockId: "repeated", promptOrder: 1 },
    ]);
  });
  test("rejects empty and malformed unsealed prompt blocks before mutation", async () => {
    const failures: Array<{ label: string; blocks: Record<string, unknown>[] }> = [
      {
        label: "empty",
        blocks: [canonicalPromptBlock({ id: "" })],
      },
      {
        label: "malformed",
        blocks: [canonicalPromptBlock({ unexpected: true })],
      },
    ];

    for (const [index, failure] of failures.entries()) {
      const existingId = `hub-unsealed-update-${index}`;
      const seedPayload = installPayload(existingId, {
        name: "Stable preset",
        blocks: [],
      });
      seedPayload.presetSlug = `creator/${existingId}`;
      const seeded = await installPreset(`seed-unsealed-${failure.label}`, seedPayload);
      expect(seeded.success).toBe(true);
      const before = getPreset(USER_ID, seeded.presetId!)!;
      const expectedCount = index + 1;

      const makePayload = (presetId: string): InstallPresetPayload => {
        const payload = installPayload(presetId, {
          name: `Malformed ${failure.label}`,
          blocks: failure.blocks,
        });
        payload.presetSlug = `creator/${presetId}`;
        return payload;
      };

      const created = await installPreset(
        `create-unsealed-${failure.label}`,
        makePayload(`hub-unsealed-create-${index}`),
      );
      expect(created.success).toBe(false);
      expect(presetCount()).toBe(expectedCount);

      const updated = await installPreset(
        `update-unsealed-${failure.label}`,
        makePayload(existingId),
      );
      expect(updated.success).toBe(false);
      expect(getPreset(USER_ID, before.id)).toEqual(before);
      expect(presetCount()).toBe(expectedCount);
    }
  });


  test("fails closed instead of saving an unresolved sealed placeholder", async () => {
    const payload = installPayload("hub-broken-sealed", {
      name: "Broken sealed preset",
      blocks: [{ id: "private", content: "{{presetBlock::missing.block}}" }],
    });

    const installed = await installPreset("request-broken-sealed", payload);

    expect(installed.success).toBe(false);
    expect(installed.error).toContain("no sealed manifest");
    const count = getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID) as { count: number };
    expect(count.count).toBe(0);
  });
});

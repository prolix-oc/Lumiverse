import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  createPreset,
  createPromptBlock,
  deletePreset,
  deletePromptBlock,
  getPreset,
  getPromptBlock,
  getPresetCacheRevision,
  getPresetRegistrySignature,
  listPresetRegistry,
  normalizePromptBlocks,
  listPromptBlocks,
  reconcileActiveLoomPreset,
  updatePromptBlock,
  updatePreset,
  validateAgentConfigForExecution,
} from "./presets.service";
import {
  AgentConfigRevisionConflictError,
  decodePortableAgentConfig,
  duplicatePresetWithAgentConfig,
  encodePortableAgentConfig,
  getAgentRuntimeSharedDraft,
  getPortablePresetRuntimeEnvelope,
  getPresetAgentResponseCognitionSourceV1,
  importPortablePresetRuntime,
  importPortablePreset,
  saveAgentRuntimeSharedDraft,
  writePresetAgentConfigWithDb,
} from "./agent-config-portability.service";
import { createDisabledAgentConfigV2, type AgentChildWorkspaceCapabilityV1, type AgentConfigV2, type AgentLoomPolicyV1, type AgentRuntimePolicyV1 } from "../types/agents";
import type { LoomPolicyCheckpointV1, LoomPolicyDestinationV1, LoomPolicyEntryV1 } from "../types/agent-cognition";
import { PresetRevisionConflictError, type Preset, type PromptBlock, type UpdatePresetInput } from "../types/preset";
import { addPromptBlockToStash, listPromptStash, removePromptBlockFromStash } from "./prompt-stash.service";
import * as settingsSvc from "./settings.service";
import {
  createRegexScript,
  deleteRegexScript,
  deleteRegexScripts,
  importRegexScripts,
  reorderRegexScripts,
  toggleRegexScript,
  toggleRegexScriptsByFolder,
  toggleRegexScriptsByIds,
  updateRegexScript,
} from "./regex-scripts.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { UserDataBarrierBusyError, userDataSnapshotBarrier } from "./user-data/snapshot";

function emptyLoomPolicy(): AgentLoomPolicyV1 {
  return {
    version: 1,
    workPolicy: [],
    workspaceUsage: [],
    completionCriteria: [],
    renderPolicy: [],
  };
}

function canonicalRuntimePolicy(
  defaultMode: AgentRuntimePolicyV1["defaultMode"] = "response",
  loomPolicy: AgentLoomPolicyV1 = emptyLoomPolicy(),
): AgentRuntimePolicyV1 {
  return {
    version: 1,
    authority: "loom",
    scope: "preset",
    defaultMode,
    loomPolicy,
    phases: [],
  };
}
function requireLoomPolicy(config: AgentConfigV2): AgentLoomPolicyV1 {
  const loomPolicy = config.runtimePolicy?.loomPolicy;
  if (!loomPolicy) throw new Error("expected full Loom policy");
  return loomPolicy;
}

function requireCacheRevision(preset: Preset): number {
  const cacheRevision = preset.cache_revision;
  if (typeof cacheRevision !== "number"
    || !Number.isSafeInteger(cacheRevision)
    || cacheRevision < 0) {
    throw new Error("expected preset cache_revision to be a non-negative safe integer");
  }
  return cacheRevision;
}

function loomEntry(
  id: string,
  blockId: string,
  destination: LoomPolicyDestinationV1,
  checkpoint: LoomPolicyCheckpointV1,
  promptOrder = 0,
  condition?: LoomPolicyEntryV1["condition"],
): LoomPolicyEntryV1 {
  return {
    version: 1,
    id,
    source: {
      kind: "loom_block",
      blockId,
      presetRevision: 0,
      blockRevision: 1,
      promptOrder,
    },
    destination,
    checkpoint,
    required: false,
    visibility: "work_only",
    ...(condition === undefined ? {} : { condition }),
  };
}

const agentConfig: AgentConfigV2 = {
  version: 2,
  agentsEnabled: true,
  allowedModes: ["response"],
  defaultMode: "response",
  maxInvocations: 64,
  maxToolCalls: 64,
  mainToolIds: ["chat_search_history"],
  mainLoreScope: "active",
  profiles: [{
    id: "writer",
    name: "Writer",
    systemPrompt: "literal",
    connectionRef: { kind: "inherit_main" },
    toolIds: ["lore_search_entries"],
    loreScope: "active",
    allowMainDelegation: true,
    failurePolicy: "required",
    streamActivity: true,
    maxOutputTokens: 64,
    timeoutMs: 5_000,
  }],
  connectionSlots: [],
};

function portableRegexScripts(): Record<string, unknown>[] {
  return [{
    name: "Portable stable",
    script_id: "stable",
    find_regex: "foo",
    replace_string: "bar",
    flags: "g",
    placement: ["ai_output"],
    scope: "global",
    target: ["response"],
    trim_strings: [],
    run_on_edit: false,
    substitute_macros: "none",
    disabled: false,
    sort_order: 0,
    description: "",
    folder: "Portable preset",
    metadata: { nested: { alpha: 1, beta: 2 } },
  }];
}

function fullPromptSources(config: AgentConfigV2) {
  const runtimePolicy = config.runtimePolicy;
  if (!runtimePolicy) throw new Error("expected runtime policy");
  const loomPolicy = requireLoomPolicy(config);
  return [
    ...loomPolicy.workPolicy.map((entry) => entry.source),
    ...loomPolicy.workspaceUsage.map((entry) => entry.source),
    ...loomPolicy.completionCriteria.map((entry) => entry.source),
    ...loomPolicy.renderPolicy.map((entry) => entry.source),
    ...runtimePolicy.phases.flatMap((phase) => [
      ...phase.instructionRefs,
      ...phase.childInstructionSubsets.flatMap((subset) => subset.instructionRefs),
    ]),
  ];
}

function duplicatePortablePromptOrder(includeCategory = false): PromptBlock[] {
  const block = (content: string): PromptBlock => ({
    id: "duplicate-portable",
    name: content,
    content,
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
  });
  const promptOrder = [block("First occurrence"), block("Second occurrence")];
  if (includeCategory) {
    promptOrder.push({ ...block("Category"), id: "category-portable", marker: "category" });
  }
  return promptOrder;
}
function createStrictRevisionPreset(suffix: string, regexScripts?: readonly Record<string, unknown>[]) {
  const source = (index: number) => ({
    kind: "loom_block" as const,
    blockId: "block-" + index,
    presetRevision: 0,
    blockRevision: 1,
    promptOrder: index,
  });
  const promptOrder: PromptBlock[] = Array.from({ length: 11 }, (_, index) => ({
    id: "block-" + index,
    name: "Block " + index,
    content: index === 0 ? "{{var::bank}}" : "Instruction " + index,
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    ...(index === 0 ? { variables: [{ id: "bank", name: "bank", label: "Bank", type: "text" as const, defaultValue: "A" }] } : {}),
  }));
  const runtimePolicy: AgentRuntimePolicyV1 = {
    version: 1,
    authority: "loom",
    scope: "preset",
    defaultMode: "response",
    loomPolicy: {
      version: 1,
      workPolicy: [loomEntry("work-0", "block-0", "root_work", "WORK", 0), loomEntry("work-1", "block-1", "root_work", "WORK", 1)],
      workspaceUsage: [loomEntry("workspace", "block-2", "root_work", "WORK", 2)],
      completionCriteria: [loomEntry("completion", "block-3", "completion_handoff", "PREPARE_COMMIT", 3)],
      renderPolicy: [loomEntry("render", "block-4", "render", "RENDER", 4)],
    },
    phases: [{
      version: 1,
      id: "draft",
      label: "Draft",
      instructionRefs: [source(5), source(6)],
      childInstructionSubsets: [{ profileId: "writer", instructionRefs: [source(5), source(6)] }],
      required: true,
      enter: { kind: "phase", value: "WORK" },
      exit: { kind: "phase", value: "WORK" },
      capabilityRequests: ["core_retrieval"],
      repeatLimit: 1,
      nextPhaseIds: ["commit"],
    }, {
      version: 1,
      id: "commit",
      label: "Commit",
      instructionRefs: [source(9)],
      childInstructionSubsets: [{ profileId: "writer", instructionRefs: [source(9)] }],
      required: true,
      enter: { kind: "phase", value: "PREPARE_COMMIT" },
      exit: { kind: "phase", value: "COMPLETE" },
      capabilityRequests: [],
      repeatLimit: 1,
      nextPhaseIds: [],
    }],
  };
  return createPreset("u1", {
    name: "Strict revision " + suffix,
    provider: "loom",
    engine: "classic",
    parameters: { temperature: 0.7, nested: { alpha: 1, beta: 2 } },
    prompts: { system: "one", nested: { alpha: 1, beta: 2 } },
    prompt_order: promptOrder,
    metadata: { other: { alpha: 1, beta: 2 }, promptVariables: { "block-0": { bank: "A" } } },
    ...(regexScripts === undefined ? {} : { regex_scripts: regexScripts }),
    agent_config: { ...agentConfig, runtimePolicy },
  });
}

function expectFullReferenceQuarantine(before: Preset, after: Preset, label?: string): void {
  expect(after.cache_revision, label).toBe(requireCacheRevision(before) + 1);
  expect(after.agent_config_revision, label).toBe((before.agent_config_revision ?? 0) + 1);
  expect(after.prompt_order, label).toEqual(before.prompt_order);
  expect(after.agent_config_review, label).toMatchObject({
    state: "repair_required",
    reasonCode: "loom_reference_repair_required",
    acknowledged: false,
  });
  const beforeSources = fullPromptSources(before.agent_config!);
  const afterSources = fullPromptSources(after.agent_config!);
  expect(afterSources, label).toHaveLength(11);
  expect(afterSources, label).toEqual(beforeSources);
}
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
  getDb().run(`CREATE TABLE regex_scripts (
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
    validation_error_code TEXT,
    owner_extension_identifier TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  getDb().run(`CREATE UNIQUE INDEX idx_regex_scripts_script_id
    ON regex_scripts(user_id, script_id) WHERE script_id != ''`);
  getDb().run(`CREATE TABLE secrets (
    key TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);

  getDb().run(`CREATE TABLE preset_agent_configs (
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
  getDb().run(`CREATE TABLE preset_agent_connection_slots (
    user_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    label TEXT NOT NULL,
    required_capabilities TEXT NOT NULL DEFAULT '[]',
    slot_revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, preset_id, slot_id)
  )`);
  getDb().run(`CREATE TABLE preset_agent_profiles (
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
  )`);
  getDb().run(`CREATE TABLE preset_agent_slot_bindings (
    user_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    connection_id TEXT,
    binding_revision INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'ready',
    review_code TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, preset_id, slot_id)
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
      metadata: { before: true },
      prompt_order: [{ id: "block", content: "before" }],
    });
    const updated = updatePreset("u1", "p1", {
      metadata: { after: true },
      expected_cache_revision: 0,
    });
    expect(updated?.metadata).toEqual({ after: true });
    expect(() => updatePreset("u1", "p1", {
      metadata: { stale: true },
      expected_cache_revision: 0,
    })).toThrow(PresetRevisionConflictError);
    expect(getPreset("u1", "p1")?.metadata).toEqual({ after: true });
    expect(getPreset("u1", "p1")?.prompt_order).toEqual([{ id: "block", content: "before" }]);
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
  test("does not promote legacy metadata when the normalized authority row is absent", () => {
    insertPreset({
      id: "legacy-only",
      name: "Legacy only",
      provider: "loom",
      user_id: "u1",
      metadata: {
        agentConfig: {
          version: 1,
          enabled: true,
          profiles: [],
          mainToolIds: ["chat_search_history"],
        },
      },
    });

    const preset = getPreset("u1", "legacy-only");

    expect(preset?.agent_config).toBeUndefined();
    expect(preset?.agent_config_review).toBeUndefined();
    expect(preset?.metadata).toEqual({});
  });
  describe("agentConfig boundary", () => {

    test("validates V2 config on create/update and projects it outside metadata", () => {
      const malformedConfig = { ...agentConfig, unknown: true };
      expect(() => createPreset("u1", {
        name: "Agent",
        provider: "loom",
        agent_config: malformedConfig,
      })).toThrow();

      const created = createPreset("u1", {
        name: "Agent",
        provider: "loom",
        agent_config: { ...agentConfig, agentsEnabled: false },
      });
      expect(created.agent_config?.agentsEnabled).toBe(false);
      expect(created.agent_config_revision).toBe(1);
      expect(created.agent_config_review?.state).toBe("ready");
      expect(created.metadata.agentConfig).toBeUndefined();
      const updated = updatePreset("u1", created.id, {
        agent_config: agentConfig,
        expected_cache_revision: created.cache_revision,
        expected_config_revision: created.agent_config_revision,
      });
      expect(updated?.agent_config_revision).toBe((created.agent_config_revision ?? 0) + 1);
      expect(updated?.agent_config?.agentsEnabled).toBe(true);
      expect(updated?.agent_config_review?.state).toBe("ready");
      expect(updated?.metadata.agentConfig).toBeUndefined();
    });

    test("does not advance strict revision authority for a structural full-PUT no-op", () => {
      const regexScripts = portableRegexScripts();
      const created = createStrictRevisionPreset("no-op", regexScripts);
      const reorderedPromptOrder = created.prompt_order.map((block) => (
        Object.fromEntries(Object.entries(block).reverse())
      )) as unknown as PromptBlock[];

      const unchanged = updatePreset("u1", created.id, {
        name: created.name,
        provider: created.provider,
        engine: created.engine,
        parameters: { nested: { beta: 2, alpha: 1 }, temperature: 0.7 },
        prompts: { nested: { beta: 2, alpha: 1 }, system: "one" },
        prompt_order: reorderedPromptOrder,
        metadata: { promptVariables: { "block-0": { bank: "A" } }, other: { beta: 2, alpha: 1 } },
        regex_scripts: regexScripts.map((script) => Object.fromEntries(Object.entries(script).reverse())),
        agent_config: structuredClone(created.agent_config!),
        expected_config_revision: created.agent_config_revision,
        expected_cache_revision: created.cache_revision,
      });

      expect(unchanged?.cache_revision).toBe(created.cache_revision);
      expect(unchanged?.agent_config_revision).toBe(created.agent_config_revision);
      expect(unchanged?.agent_config_review?.state).toBe("ready");
    });

    test("quarantines all eleven exact references for every real preset revision category", () => {
      const cases: Array<[label: string, mutate: (preset: Preset) => UpdatePresetInput, initialRegexScripts?: readonly Record<string, unknown>[]]> = [
        ["name", (preset) => ({ name: preset.name + " changed" })],
        ["provider", () => ({ provider: "openai" })],
        ["engine", () => ({ engine: "next" })],
        ["parameters", () => ({ parameters: { temperature: 0.8, nested: { alpha: 1, beta: 2 } } })],
        ["prompts", () => ({ prompts: { system: "two", nested: { alpha: 1, beta: 2 } } })],
        ["metadata", () => ({ metadata: { other: { alpha: 1, beta: 3 }, promptVariables: { "block-0": { bank: "A" } } } })],
        ["prompt variables", () => ({ metadata: { other: { alpha: 1, beta: 2 }, promptVariables: { "block-0": { bank: "B" } } } })],
        ["prompt order", (preset) => ({ prompt_order: preset.prompt_order.map((block, index) => index === 0 ? { ...block, content: "changed" } : block) })],
        ["regex companions", () => ({ regex_scripts: [] }), portableRegexScripts()],
      ];

      for (const [label, mutate, initialRegexScripts] of cases) {
        const created = createStrictRevisionPreset(label, initialRegexScripts);
        const updated = updatePreset("u1", created.id, {
          ...mutate(created),
          expected_cache_revision: created.cache_revision,
        });

        expect(updated?.cache_revision, label).toBe(requireCacheRevision(created) + 1);
        expect(updated?.agent_config_revision, label).toBe((created.agent_config_revision ?? 0) + 1);
        expect(updated?.agent_config_review, label).toMatchObject({
          state: "repair_required",
          reasonCode: "loom_reference_repair_required",
          acknowledged: false,
        });
        const policy = updated?.agent_config?.runtimePolicy;
        const loom = policy?.loomPolicy;
        expect(policy, label).toBeDefined();
        expect(loom, label).not.toBeNull();
        const exactReferences = [
          ...loom!.workPolicy.map((entry) => entry.source),
          ...loom!.workspaceUsage.map((entry) => entry.source),
          ...loom!.completionCriteria.map((entry) => entry.source),
          ...loom!.renderPolicy.map((entry) => entry.source),
          ...policy!.phases.flatMap((phase) => [
            ...phase.instructionRefs,
            ...phase.childInstructionSubsets.flatMap((subset) => subset.instructionRefs),
          ]),
        ];
        expect(exactReferences, label).toHaveLength(11);
        expect(exactReferences.every((source) => source.presetRevision === created.cache_revision), label).toBe(true);
      }
    });

    test("quarantines all eleven references exactly once for every direct and batch regex mutation path", () => {
      const seeds = (label: string, count = 1) => Array.from({ length: count }, (_, index) => ({
        ...portableRegexScripts()[0],
        name: `${label}-${index}`,
        script_id: `${label}-${index}`,
        folder: label,
        sort_order: index,
      }));
      const rows = (presetId: string) => getDb().query(
        "SELECT id FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY sort_order, id",
      ).all("u1", presetId) as Array<{ id: string }>;
      const cases: Array<[string, number, (owner: Preset, ids: string[]) => void]> = [
        ["create-bound", 0, (owner) => {
          const created = createRegexScript("u1", {
            name: "created",
            find_regex: "x",
            preset_id: owner.id,
          });
          expect(typeof created).not.toBe("string");
          if (typeof created === "string") throw new Error(created);
          expect(created.preset_id).toBe(owner.id);
        }],
        ["update", 1, (_owner, ids) => { updateRegexScript("u1", ids[0]!, { find_regex: "changed" }); }],
        ["delete", 1, (_owner, ids) => { deleteRegexScript("u1", ids[0]!); }],
        ["bulk-delete", 2, (_owner, ids) => { deleteRegexScripts("u1", ids); }],
        ["toggle", 1, (owner, ids) => {
          expect(toggleRegexScript("u1", ids[0]!, false, { activePresetId: owner.id })?.disabled).toBe(false);
        }],
        ["bulk-toggle", 2, (owner, ids) => {
          const result = toggleRegexScriptsByIds("u1", ids, false, { activePresetId: owner.id });
          expect([...result.changedIds].sort()).toEqual([...ids].sort());
          expect(result.skippedIds).toEqual([]);
        }],
        ["folder-toggle", 2, (owner, ids) => {
          const row = getDb().query("SELECT folder FROM regex_scripts WHERE id = ?").get(ids[0]!) as { folder: string };
          const result = toggleRegexScriptsByFolder("u1", row.folder, false, { activePresetId: owner.id });
          expect([...result.changedIds].sort()).toEqual([...ids].sort());
          expect(result.skippedIds).toEqual([]);
        }],
        ["reorder", 2, (_owner, ids) => { reorderRegexScripts("u1", [...ids].reverse()); }],
        ["import", 0, (owner) => { importRegexScripts("u1", { preset_id: owner.id, scripts: seeds(`imported-${owner.id}`, 2) }); }],
      ];

      for (const [label, count, mutate] of cases) {
        const initial = seeds(`${label}-${crypto.randomUUID()}`, count);
        const owner = createStrictRevisionPreset(label, initial);
        const ids = rows(owner.id).map((row) => row.id);
        mutate(owner, ids);
        expectFullReferenceQuarantine(owner, getPreset("u1", owner.id)!, label);
      }

      const source = createStrictRevisionPreset("move-source", seeds(`move-source-${crypto.randomUUID()}`));
      const target = createStrictRevisionPreset("move-target", []);
      const movedId = rows(source.id)[0]!.id;
      updateRegexScript("u1", movedId, { preset_id: target.id });
      expectFullReferenceQuarantine(source, getPreset("u1", source.id)!, "move source");
      expectFullReferenceQuarantine(target, getPreset("u1", target.id)!, "move target");

      const batchA = createStrictRevisionPreset("multi-owner-a", seeds(`multi-a-${crypto.randomUUID()}`));
      const batchB = createStrictRevisionPreset("multi-owner-b", seeds(`multi-b-${crypto.randomUUID()}`));
      deleteRegexScripts("u1", [rows(batchA.id)[0]!.id, rows(batchB.id)[0]!.id]);
      expectFullReferenceQuarantine(batchA, getPreset("u1", batchA.id)!, "multi-owner A");
      expectFullReferenceQuarantine(batchB, getPreset("u1", batchB.id)!, "multi-owner B");
    });

    test("rolls back late batch and import failures without rows, authority, config, or events escaping", () => {
      const script = (name: string) => ({ ...portableRegexScripts()[0], name, script_id: `${name}-${crypto.randomUUID()}` });
      const cases: Array<[string, (owner: Preset, ids: string[]) => void]> = [
        ["batch", (_owner, ids) => { deleteRegexScripts("u1", ids); }],
        ["import", (owner) => { importRegexScripts("u1", { preset_id: owner.id, scripts: [script("late-a"), script("late-b")] }); }],
      ];
      for (const [label, mutate] of cases) {
        const owner = createStrictRevisionPreset(`rollback-${label}`, [script(`seed-${label}-a`), script(`seed-${label}-b`)]);
        const before = getPreset("u1", owner.id)!;
        const beforeRows = getDb().query(
          "SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY id",
        ).all("u1", owner.id);
        getDb().run(`CREATE TRIGGER reject_regex_authority_${label}
          BEFORE UPDATE OF config_revision ON preset_agent_configs
          WHEN NEW.preset_id = '${owner.id}' AND NEW.config_revision > OLD.config_revision
          BEGIN SELECT RAISE(ABORT, 'forced late ${label} failure'); END`);
        const rolledBack = eventBus.withBufferedEvents(() => {
          try {
            mutate(owner, (beforeRows as Array<{ id: string }>).map((row) => row.id));
            return null;
          } catch (error) {
            return error;
          }
        });
        expect((rolledBack.value as Error).message).toContain(`forced late ${label} failure`);
        expect(rolledBack.events).toEqual([]);
        expect(getPreset("u1", owner.id)).toEqual(before);
        expect(getDb().query(
          "SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY id",
        ).all("u1", owner.id)).toEqual(beforeRows);
        getDb().run(`DROP TRIGGER reject_regex_authority_${label}`);
      }
    });

    test("persists workspace capability grants through portable projection and duplicate", () => {
      const workspaceCapabilities: AgentChildWorkspaceCapabilityV1[] = ["read_section", "update_assigned_progress", "submit_child_result"];
      const config = {
        ...agentConfig,
        profiles: [{ ...agentConfig.profiles[0], workspaceCapabilities }],
      };
      const created = createPreset("u1", { name: "Workspace grants", provider: "loom", agent_config: config });
      expect(getDb().query("SELECT workspace_capabilities FROM preset_agent_profiles WHERE user_id = ? AND preset_id = ?").get("u1", created.id)).toEqual({
        workspace_capabilities: JSON.stringify(workspaceCapabilities),
      });
      expect(created.agent_config?.profiles[0]?.workspaceCapabilities).toEqual(workspaceCapabilities);
      expect(decodePortableAgentConfig(encodePortableAgentConfig(created.agent_config!)).profiles[0]?.workspaceCapabilities).toEqual(workspaceCapabilities);
      const duplicate = duplicatePresetWithAgentConfig("u1", created.id, "Workspace grants copy");
      expect(duplicate.agent_config.profiles[0]?.workspaceCapabilities).toEqual(workspaceCapabilities);
      expect(() => createPreset("u1", {
        name: "Invalid workspace grants",
        provider: "loom",
        agent_config: {
          ...config,
          profiles: [{ ...config.profiles[0], workspaceCapabilities: ["submit_child_result", "read_section"] }],
        },
      })).toThrow();
    });

    test("duplicates the validated authored cognition envelope with normalized state and regex companions", () => {
      const task = {
        id: "task_one",
        required: true,
        dependencies: [],
        label: "Verify the rules",
      };
      const cognitionConfig: AgentConfigV2 = {
        ...agentConfig,
        profiles: [{
          ...agentConfig.profiles[0],
          connectionRef: { kind: "slot" as const, slotId: "writer" },
        }],
        connectionSlots: [{ id: "writer", label: "Writer", requiredCapabilities: ["generation" as const] }],
        runtimePolicy: canonicalRuntimePolicy("response", {
          version: 1,
          workPolicy: [loomEntry("cognition-work", "cognition-block", "root_work", "WORK")],
          workspaceUsage: [loomEntry("cognition-workspace", "cognition-block", "root_work", "WORK")],
          completionCriteria: [loomEntry("cognition-completion", "cognition-block", "completion_handoff", "PREPARE_COMMIT")],
          renderPolicy: [loomEntry("cognition-render", "cognition-block", "render", "RENDER")],
        }),
        taskPolicy: { templateIds: ["task_one"] },
      };
      const cognitionPromptOrder = normalizePromptBlocks([{ id: "cognition-block" } as PromptBlock]);
      const created = createPreset("u1", {
        name: "Cognition source",
        provider: "loom",
        prompt_order: cognitionPromptOrder,
        agent_config: { ...cognitionConfig, taskPolicy: { templateIds: [] } },
      });
      getDb().run(
        `INSERT INTO regex_scripts (
          id, user_id, name, find_regex, placement, scope, target, trim_strings,
          preset_id, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "regex-source",
          "u1",
          "Regex source",
          "source",
          JSON.stringify(["ai_output"]),
          "global",
          JSON.stringify(["response"]),
          JSON.stringify([]),
          created.id,
          1,
          1,
          1,
        ],
      );
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      saveAgentRuntimeSharedDraft("u1", created.id, {
        config: cognitionConfig,
        slotBindings: [{ slotId: "writer", connectionId: null }],
        taskTemplates: [task],
        promptOrder: cognitionPromptOrder,
        reviewAcknowledgements: ["slot:writer"],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      const sourceEnvelope = getDb().query(
        "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
      ).get("u1", created.id) as { config_json: string };

      const duplicate = duplicatePresetWithAgentConfig("u1", created.id, "Cognition copy");
      const targetEnvelope = getDb().query(
        "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
      ).get("u1", duplicate.preset.id) as { config_json: string };
      const sourceAuthoredEnvelope = JSON.parse(sourceEnvelope.config_json) as { config: typeof cognitionConfig; reviewAcknowledgements?: unknown };
      const targetAuthoredEnvelope = JSON.parse(targetEnvelope.config_json) as { config: typeof cognitionConfig; reviewAcknowledgements?: unknown };
      const sourceConfig = sourceAuthoredEnvelope.config;
      const targetConfig = targetAuthoredEnvelope.config;
      expect(sourceAuthoredEnvelope.reviewAcknowledgements).toEqual(["slot:writer"]);
      expect(targetAuthoredEnvelope.reviewAcknowledgements).toEqual(sourceAuthoredEnvelope.reviewAcknowledgements);
      const targetPresetRow = getDb().query(
        "SELECT cache_revision FROM presets WHERE user_id = ? AND id = ?",
      ).get("u1", duplicate.preset.id) as { cache_revision: number };
      const targetPresetRevision = targetPresetRow.cache_revision;
      const sourceLoomPolicy = sourceConfig.runtimePolicy?.loomPolicy;
      const targetLoomPolicy = targetConfig.runtimePolicy?.loomPolicy;
      if (!sourceLoomPolicy || !targetLoomPolicy) throw new Error("expected canonical Loom policy");
      const targetReferences = [
        ...targetLoomPolicy.workPolicy,
        ...targetLoomPolicy.workspaceUsage,
        ...targetLoomPolicy.completionCriteria,
        ...targetLoomPolicy.renderPolicy,
      ];
      expect(targetReferences).toHaveLength(4);
      expect(targetReferences.every((entry) => entry.source.presetRevision !== targetPresetRevision)).toBe(true);
      expect(targetReferences.every((entry) => entry.source.blockRevision === 1)).toBe(true);
      expect(sourceLoomPolicy.workPolicy[0]?.source.presetRevision).not.toBe(targetPresetRevision);
      expect(targetLoomPolicy).toEqual(sourceLoomPolicy);
      expect(duplicate.agent_config.taskPolicy).toEqual({ templateIds: ["task_one"] });
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ? AND preset_id = ?",
      ).get("u1", duplicate.preset.id)).toEqual({ count: 1 });
      expect(duplicate.copiedRegexScriptIds).toHaveLength(1);
    });

    test("rejects V1 config on the ordinary preset writer", () => {
      const legacy = {
        version: 1,
        enabled: true,
        maxInvocations: 4,
        maxToolCalls: 8,
        mainToolIds: [],
        mainLoreScope: "active",
        profiles: [],
      };
      // Intentionally bypass the closed DTO to exercise runtime rejection.
      const legacyInput = {
        name: "Legacy",
        provider: "loom",
        agent_config: legacy,
      } as unknown as Parameters<typeof createPreset>[1];
      expect(() => createPreset("u1", legacyInput)).toThrow("agentConfig.enabled: unknown key");
    });

    test("keeps slot binding revisions monotonic across delete-and-recreate rewrites", () => {
      const slotConfig = {
        ...agentConfig,
        profiles: [{ ...agentConfig.profiles[0], connectionRef: { kind: "slot" as const, slotId: "writer" } }],
        connectionSlots: [{ id: "writer", label: "Writer", requiredCapabilities: ["generation" as const] }],
      };
      const created = createPreset("u1", { name: "Binding revisions", provider: "loom", agent_config: slotConfig });
      const first = getDb().query("SELECT config_revision, binding_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get("u1", created.id) as { config_revision: number; binding_revision: number };
      const firstBinding = getDb().query("SELECT binding_revision FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id = ?").get("u1", created.id, "writer") as { binding_revision: number };
      expect(first.binding_revision).toBe(firstBinding.binding_revision);

      const rewritten = writePresetAgentConfigWithDb(getDb(), "u1", created.id, {
        config: slotConfig,
        bindings: [{ slotId: "writer", connectionId: null }],
        expectedConfigRevision: first.config_revision,
      });
      const second = getDb().query("SELECT config_revision, binding_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get("u1", created.id) as { config_revision: number; binding_revision: number };
      const secondBinding = getDb().query("SELECT binding_revision FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id = ?").get("u1", created.id, "writer") as { binding_revision: number };
      expect(rewritten.configRevision).toBe(second.config_revision);
      expect(second.binding_revision).toBe(secondBinding.binding_revision);
      expect(second.binding_revision).toBeGreaterThan(first.binding_revision);
      expect(secondBinding.binding_revision).toBeGreaterThan(firstBinding.binding_revision);
    });

    test("rolls back the preset row when normalized config persistence fails", () => {
      getDb().run(`
        CREATE TRIGGER reject_agent_config_insert
        BEFORE INSERT ON preset_agent_configs
        BEGIN
          SELECT RAISE(ABORT, 'config persistence failed');
        END
      `);

      expect(() => createPreset("u1", {
        name: "Atomic create",
        provider: "loom",
        agent_config: agentConfig,
      })).toThrow();
      expect(getDb().query("SELECT COUNT(*) AS count FROM presets WHERE name = ?").get("Atomic create")).toEqual({ count: 0 });
    });

    test("creates omitted-slot tombstones and rolls back preset fields on config CAS failure", () => {
      const slotConfig = {
        ...agentConfig,
        connectionSlots: [
          { id: "writer", label: "Writer", requiredCapabilities: ["generation" as const] },
          { id: "reviewer", label: "Reviewer", requiredCapabilities: ["generation" as const] },
        ],
      };
      const created = createPreset("u1", {
        name: "Atomic runtime",
        provider: "loom",
        prompt_order: [{ id: "before" }],
        agent_config: slotConfig,
      });
      const bindings = getDb().query(
        "SELECT slot_id, connection_id, state FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? ORDER BY slot_id",
      ).all("u1", created.id);
      expect(bindings).toEqual([
        { slot_id: "reviewer", connection_id: null, state: "review_required" },
        { slot_id: "writer", connection_id: null, state: "review_required" },
      ]);
      expect(() => updatePreset("u1", created.id, {
        prompt_order: [{ id: "after" }],
        agent_config: slotConfig,
        expected_cache_revision: created.cache_revision,
        expected_config_revision: 999,
      } as any)).toThrow("AGENT_CONFIG_REVISION_CONFLICT");
      const after = getPreset("u1", created.id)!;
      expect(after.prompt_order).toEqual([{ id: "before" }]);
      expect(after.cache_revision).toBe(created.cache_revision);
    });

    test("rejects stored V2 configs missing required tool-call limits", () => {
      const { maxToolCalls: _maxToolCalls, ...withoutToolCallLimit } = agentConfig;
      // Intentionally bypass the closed DTO to exercise runtime rejection.
      const incompleteInput = {
        name: "Agent without explicit tool limit",
        provider: "loom",
        agent_config: withoutToolCallLimit,
        metadata: { extensionData: { keep: true } },
      } as unknown as Parameters<typeof createPreset>[1];
      expect(() => createPreset("u1", incompleteInput)).toThrow();
    });

    test("does not execute legacy metadata when normalized authority is absent", () => {
      getDb().run(
        "INSERT INTO presets (id, name, provider, metadata, user_id, engine, cache_revision) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["legacy-only", "Legacy only", "loom", JSON.stringify({ agentConfig: { version: 1, enabled: true, mainToolIds: ["chat_search_history"] } }), "u1", "classic", 1],
      );


      const preset = getPreset("u1", "legacy-only");
      expect(preset?.agent_config).toBeUndefined();
      expect(preset?.agent_config_review).toBeUndefined();
      expect(preset?.metadata.agentConfig).toBeUndefined();
    });
    test("normalizes malformed legacy cognition ingress into repair_required state", () => {
      const legacyIngress = JSON.parse(encodePortableAgentConfig(agentConfig)) as Record<string, unknown>;
      legacyIngress.cognitionPolicy = null;
      const imported = importPortablePreset("u1", {
        name: "Malformed cognition",
        provider: "loom",
        agent_config: legacyIngress,
      });

      expect(imported.agent_config_review).toMatchObject({
        state: "repair_required",
        reasonCode: "cognition_invalid",
        acknowledged: false,
      });
      expect(getDb().query(
        "SELECT state, review_code FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
      ).get("u1", imported.preset.id)).toEqual({
        state: "repair_required",
        review_code: "cognition_invalid",
      });
    });
    test("initializes normalized authority for an existing preset on runtime import", () => {
      insertPreset({ id: "runtime-only", name: "Runtime only", provider: "loom", user_id: "u1" });
      const imported = importPortablePresetRuntime("u1", {
        preset: { name: "Runtime replacement", provider: "loom" },
        agentRuntime: {
          version: 1,
          agentConfig: null,
          taskTemplates: [],
        },
        existingPresetId: "runtime-only",
        expectedPresetRevision: 0,
      });

      expect(imported.preset.id).toBe("runtime-only");
      expect(imported.agent_config?.agentsEnabled).toBe(false);
      expect(imported.preset.agent_config_revision).toBe(1);
      expect(getDb().query("SELECT state, review_code FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?").get("u1", "runtime-only")).toEqual({
        state: "review_required",
        review_code: "foreign_import",
      });
    });
    test("exports imports and re-exports duplicate prompt IDs by exact occurrence without aliasing", () => {
      const promptOrder = duplicatePortablePromptOrder();
      const source = (promptOrderIndex: number) => ({
        kind: "loom_block" as const,
        blockId: "duplicate-portable",
        presetRevision: 0,
        blockRevision: 1,
        promptOrder: promptOrderIndex,
      });
      const runtimePolicy: AgentRuntimePolicyV1 = {
        version: 1,
        authority: "loom",
        scope: "preset",
        defaultMode: "response",
        loomPolicy: {
          version: 1,
          workPolicy: [
            { ...loomEntry("duplicate-first", "duplicate-portable", "root_work", "WORK", 0), source: source(0) },
            { ...loomEntry("duplicate-second", "duplicate-portable", "root_work", "WORK", 1), source: source(1) },
          ],
          workspaceUsage: [],
          completionCriteria: [],
          renderPolicy: [],
        },
        phases: [{
          version: 1,
          id: "duplicate_phase",
          label: "Duplicate phase",
          instructionRefs: [source(0), source(1)],
          childInstructionSubsets: [{ profileId: "writer", instructionRefs: [source(1), source(0)] }],
          required: true,
          enter: { kind: "phase", value: "WORK" },
          exit: { kind: "phase", value: "WORK" },
          capabilityRequests: [],
          repeatLimit: 1,
          nextPhaseIds: ["duplicate_commit"],
        }, {
          version: 1,
          id: "duplicate_commit",
          label: "Duplicate commit",
          instructionRefs: [source(1), source(0)],
          childInstructionSubsets: [{ profileId: "writer", instructionRefs: [source(0), source(1)] }],
          required: true,
          enter: { kind: "phase", value: "PREPARE_COMMIT" },
          exit: { kind: "phase", value: "COMPLETE" },
          capabilityRequests: [],
          repeatLimit: 1,
          nextPhaseIds: [],
        }],
      };
      const created = createPreset("u1", {
        name: "Duplicate portable occurrences",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: { ...agentConfig, runtimePolicy },
      });

      const exported = getPortablePresetRuntimeEnvelope("u1", created.id);
      expect(exported).not.toBeNull();
      const imported = importPortablePresetRuntime("u1", {
        preset: {
          name: "Imported duplicate portable occurrences",
          provider: "loom",
          prompt_order: promptOrder,
        },
        agentRuntime: exported!,
      });
      const importedPolicy = imported.agent_config?.runtimePolicy;
      if (!importedPolicy?.loomPolicy) throw new Error("expected imported duplicate occurrence policy");

      expect(imported.preset.prompt_order.map((block) => block.content)).toEqual([
        "First occurrence",
        "Second occurrence",
      ]);
      expect(importedPolicy.loomPolicy.workPolicy.map((entry) => entry.source.promptOrder)).toEqual([0, 1]);
      expect(importedPolicy.phases[0]?.instructionRefs.map((entry) => entry.promptOrder)).toEqual([0, 1]);
      expect(importedPolicy.phases[0]?.childInstructionSubsets[0]?.instructionRefs.map((entry) => entry.promptOrder)).toEqual([1, 0]);
      expect(importedPolicy.loomPolicy.workPolicy[0]?.source).not.toBe(importedPolicy.loomPolicy.workPolicy[1]?.source);

      const roundTripped = getPortablePresetRuntimeEnvelope("u1", imported.preset.id);
      expect(roundTripped?.agentConfig?.runtimePolicy).toEqual(exported?.agentConfig?.runtimePolicy);
      expect(roundTripped?.agentConfig?.runtimePolicy?.loomPolicy?.workPolicy.map((entry) => entry.source.promptOrder))
        .toEqual([0, 1]);
    });

    test.each([
      { name: "missing duplicate occurrence", blockId: "duplicate-portable", presetRevision: 0, blockRevision: 1, promptOrder: 3 },
      { name: "source id mismatch", blockId: "different-block", presetRevision: 0, blockRevision: 1, promptOrder: 0 },
      { name: "source revision mismatch", blockId: "duplicate-portable", presetRevision: 0, blockRevision: 2, promptOrder: 0 },
      { name: "category source", blockId: "category-portable", presetRevision: 0, blockRevision: 1, promptOrder: 2 },
      { name: "future source pin", blockId: "duplicate-portable", presetRevision: 1, blockRevision: 1, promptOrder: 0 },
    ])("quarantines portable duplicate occurrence $name", ({
      name,
      blockId,
      presetRevision,
      blockRevision,
      promptOrder: sourceOrder,
    }) => {
      const promptOrder = duplicatePortablePromptOrder(true);
      const fixture = createPreset("u1", {
        name: "Portable negative " + name,
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: agentConfig,
      });
      const exported = getPortablePresetRuntimeEnvelope("u1", fixture.id);
      if (!exported?.agentConfig) throw new Error("expected portable runtime fixture");
      const entry = loomEntry("malformed-duplicate", blockId, "root_work", "WORK", sourceOrder);
      const runtimePolicy = canonicalRuntimePolicy("response", {
        ...emptyLoomPolicy(),
        workPolicy: [{
          ...entry,
          source: {
            kind: "loom_block",
            blockId,
            presetRevision,
            blockRevision,
            promptOrder: sourceOrder,
          },
        }],
      });

      const imported = importPortablePresetRuntime("u1", {
        preset: { name: "Imported " + name, provider: "loom", prompt_order: promptOrder },
        agentRuntime: {
          ...exported,
          agentConfig: { ...exported.agentConfig, runtimePolicy },
        },
      });

      expect(imported.preset.prompt_order).toEqual(promptOrder);
      expect(imported.agent_config_review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
      });
    });

    test("fails closed for ambiguous legacy duplicate IDs while retaining exact policy phase and child occurrences", () => {
      const promptOrder = duplicatePortablePromptOrder(true);
      const created = createPreset("u1", {
        name: "Legacy duplicate occurrences",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: agentConfig,
      });
      const legacyPolicy = {
        work: [
          { blockId: "duplicate-portable", expectedPresetRevision: 0, expectedBlockRevision: 1 },
          { blockId: "duplicate-portable", expectedPresetRevision: 0, expectedBlockRevision: 1, promptOrder: 1 },
          { blockId: "different-block", expectedPresetRevision: 0, expectedBlockRevision: 1, promptOrder: 0 },
          { blockId: "duplicate-portable", expectedPresetRevision: 1, expectedBlockRevision: 1, promptOrder: 0 },
          { blockId: "category-portable", expectedPresetRevision: 0, expectedBlockRevision: 1, promptOrder: 2 },
        ],
        phases: [{
          id: "legacy-duplicates",
          label: "Legacy duplicates",
          instructionRefs: [
            { blockId: "duplicate-portable", presetRevision: 0, blockRevision: 1 },
            { blockId: "duplicate-portable", presetRevision: 0, blockRevision: 1, promptOrder: 0 },
            { blockId: "duplicate-portable", presetRevision: 0, blockRevision: 1, promptOrder: 2 },
          ],
          childInstructionSubsets: [{
            profileId: "writer",
            instructionRefs: [
              { blockId: "duplicate-portable", presetRevision: 0, blockRevision: 1, promptOrder: 1 },
              { blockId: "duplicate-portable", presetRevision: 0, blockRevision: 2, promptOrder: 0 },
            ],
          }],
        }],
      };
      getDb().query(
        "UPDATE preset_agent_configs SET phase_policy_json = ?, cognition_policy_json = '{}' WHERE user_id = ? AND preset_id = ?",
      ).run(JSON.stringify(legacyPolicy), "u1", created.id);

      const projected = getPresetAgentResponseCognitionSourceV1("u1", created.id);
      const runtimePolicy = projected?.config.runtimePolicy;
      if (!runtimePolicy?.loomPolicy) throw new Error("expected bounded legacy runtime policy");

      expect(projected?.sourceKind).toBe("legacy");
      expect(runtimePolicy.loomPolicy.workPolicy.map((entry) => entry.source.promptOrder)).toEqual([1]);
      expect(runtimePolicy.phases[0]?.instructionRefs.map((entry) => entry.promptOrder)).toEqual([0]);
      expect(runtimePolicy.phases[0]?.childInstructionSubsets[0]?.instructionRefs.map((entry) => entry.promptOrder)).toEqual([1]);
    });
    test("buffers portable preset and runtime regex events until the full outer transaction commits", () => {
      const fixture = createStrictRevisionPreset("portable-transaction-fixture");
      const companion = (name: string) => ({
        ...portableRegexScripts()[0],
        name,
        script_id: `${name}-${crypto.randomUUID()}`,
      });
      const portableConfig = JSON.parse(encodePortableAgentConfig(fixture.agent_config!));
      const payload = (name: string) => ({
        name,
        provider: "loom",
        prompt_order: fixture.prompt_order,
        agent_config: portableConfig,
        regex_scripts: [companion(`${name}-a`), companion(`${name}-b`)],
      });

      const beforeCounts = getDb().query(`SELECT
        (SELECT COUNT(*) FROM presets) AS presets,
        (SELECT COUNT(*) FROM preset_agent_configs) AS configs,
        (SELECT COUNT(*) FROM regex_scripts) AS regex`).get();
      getDb().run(`CREATE TRIGGER reject_portable_regex_metadata
        BEFORE UPDATE OF metadata ON regex_scripts
        BEGIN SELECT RAISE(ABORT, 'forced portable metadata failure'); END`);
      const failedPortable = eventBus.withBufferedEvents(() => {
        try {
          importPortablePreset("u1", payload("failed-portable") as any);
          return null;
        } catch (error) {
          return error;
        }
      });
      expect((failedPortable.value as Error).message).toContain("forced portable metadata failure");
      expect(failedPortable.events).toEqual([]);
      expect(getDb().query(`SELECT
        (SELECT COUNT(*) FROM presets) AS presets,
        (SELECT COUNT(*) FROM preset_agent_configs) AS configs,
        (SELECT COUNT(*) FROM regex_scripts) AS regex`).get()).toEqual(beforeCounts);
      getDb().run("DROP TRIGGER reject_portable_regex_metadata");

      const committedPortable = eventBus.withBufferedEvents(() => importPortablePreset("u1", payload("committed-portable") as any));
      expect(committedPortable.events.map((event) => event.event)).toEqual([
        EventType.REGEX_SCRIPT_CHANGED,
        EventType.REGEX_SCRIPT_CHANGED,
      ]);
      expect(fullPromptSources(committedPortable.value.agent_config)).toHaveLength(11);

      const existing = createStrictRevisionPreset("runtime-transaction", [companion("runtime-old")]);
      const beforeRuntime = getPreset("u1", existing.id)!;
      const beforeRuntimeRows = getDb().query(
        "SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY id",
      ).all("u1", existing.id);
      const runtimeInput = {
        preset: payload("runtime-replacement"),
        agentRuntime: { version: 1, agentConfig: portableConfig, taskTemplates: [] },
        existingPresetId: existing.id,
        expectedPresetRevision: existing.cache_revision,
      };
      getDb().run(`CREATE TRIGGER reject_runtime_regex_metadata
        BEFORE UPDATE OF metadata ON regex_scripts
        BEGIN SELECT RAISE(ABORT, 'forced runtime metadata failure'); END`);
      const failedRuntime = eventBus.withBufferedEvents(() => {
        try {
          importPortablePresetRuntime("u1", runtimeInput as any);
          return null;
        } catch (error) {
          return error;
        }
      });
      expect((failedRuntime.value as Error).message).toContain("forced runtime metadata failure");
      expect(failedRuntime.events).toEqual([]);
      expect(getPreset("u1", existing.id)).toEqual(beforeRuntime);
      expect(getDb().query(
        "SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY id",
      ).all("u1", existing.id)).toEqual(beforeRuntimeRows);
      getDb().run("DROP TRIGGER reject_runtime_regex_metadata");

      const committedRuntime = eventBus.withBufferedEvents(() => importPortablePresetRuntime("u1", runtimeInput as any));
      expect(committedRuntime.events.map((event) => event.event)).toEqual([
        EventType.REGEX_SCRIPT_DELETED,
        EventType.REGEX_SCRIPT_CHANGED,
        EventType.REGEX_SCRIPT_CHANGED,
      ]);
      expect(fullPromptSources(committedRuntime.value.agent_config)).toHaveLength(11);
    });


    test("rebases every authored prompt reference to the committed preset revision", () => {
      const created = createPreset("u1", {
        name: "Shared runtime draft",
        provider: "loom",
        prompt_order: [
          { id: "work-block" },
          { id: "cognition-work" },
          { id: "workspace" },
          { id: "completion" },
          { id: "cognition-render" },
          { id: "render-block" },
          { id: "unreferenced", content: "old" },
        ],
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id);
      expect(before).not.toBeNull();

      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: {
          ...agentConfig,
          runtimePolicy: canonicalRuntimePolicy("response", {
            version: 1,
            workPolicy: [
              loomEntry("work-policy", "work-block", "root_work", "WORK"),
              loomEntry("cognition-work", "cognition-work", "root_work", "WORK", 1),
            ],
            workspaceUsage: [loomEntry("workspace-policy", "workspace", "root_work", "WORK", 2)],
            completionCriteria: [loomEntry("completion-policy", "completion", "completion_handoff", "PREPARE_COMMIT", 3)],
            renderPolicy: [
              loomEntry("cognition-render", "cognition-render", "render", "RENDER", 4),
              loomEntry("render-policy", "render-block", "render", "RENDER", 5),
            ],
          }),
        },
        slotBindings: [],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: [
          { id: "work-block" },
          { id: "cognition-work" },
          { id: "workspace" },
          { id: "completion" },
          { id: "cognition-render" },
          { id: "render-block" },
          { id: "unreferenced", content: "new" },
        ],
        expectedPresetRevision: before!.presetRevision,
        expectedConfigRevision: before!.configRevision,
      });

      expect(saved.editor.presetRevision).toBe(before!.presetRevision + 1);
      expect(saved.editor.review.state).toBe("ready");
      const loomPolicy = saved.editor.config.runtimePolicy?.loomPolicy;
      if (!loomPolicy) throw new Error("expected canonical Loom policy");
      const refs = [
        ...loomPolicy.workPolicy,
        ...loomPolicy.workspaceUsage,
        ...loomPolicy.completionCriteria,
        ...loomPolicy.renderPolicy,
      ];
      expect(refs).toHaveLength(6);
      expect(refs.every((item) => item.source.presetRevision === saved.editor.presetRevision)).toBe(true);
      expect(refs.every((item) => item.source.blockRevision === 1)).toBe(true);
    });
    test.each([
      {
        name: "new occurrence",
        persisted: [{ id: "anchor", content: "stable" }],
        next: [
          { id: "anchor", content: "stable" },
          { id: "future-target", content: "new" },
        ],
        sourceId: "future-target",
        sourceOrder: 1,
      },
      {
        name: "replaced occurrence",
        persisted: [{ id: "old-target", content: "old" }],
        next: [{ id: "future-target", content: "replacement" }],
        sourceId: "future-target",
        sourceOrder: 0,
      },
      {
        name: "moved occurrence",
        persisted: [
          { id: "future-target", content: "stable" },
          { id: "other", content: "other" },
        ],
        next: [
          { id: "other", content: "other" },
          { id: "future-target", content: "stable" },
        ],
        sourceId: "future-target",
        sourceOrder: 1,
      },
      {
        name: "occurrence-local duplicate replacement",
        persisted: [
          { id: "duplicate-target", content: "A" },
          { id: "duplicate-target", content: "B" },
        ],
        next: [
          { id: "duplicate-target", content: "A" },
          { id: "duplicate-target", content: "replacement" },
        ],
        sourceId: "duplicate-target",
        sourceOrder: 1,
      },
      {
        name: "unchanged exact occurrence when only an unreferenced block changes",
        persisted: [
          { id: "future-target", content: "stable" },
          { id: "unreferenced", content: "old" },
        ],
        next: [
          { id: "future-target", content: "stable" },
          { id: "unreferenced", content: "changed" },
        ],
        sourceId: "future-target",
        sourceOrder: 0,
      },
    ])("quarantines a future-pinned $name instead of accepting predicted committed authority", ({
      name,
      persisted,
      next,
      sourceId,
      sourceOrder,
    }) => {
      const created = createPreset("u1", {
        name: "Future pin " + name,
        provider: "loom",
        prompt_order: normalizePromptBlocks(persisted),
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const futureRevision = before.presetRevision + 1;
      const authoredEntry = loomEntry("future-work", sourceId, "root_work", "WORK", sourceOrder);
      const futurePinnedConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [{
            ...authoredEntry,
            source: { ...authoredEntry.source, presetRevision: futureRevision },
          }],
        }),
      };

      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: futurePinnedConfig,
        slotBindings: before.slotBindings,
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: normalizePromptBlocks(next),
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.presetRevision).toBe(futureRevision);
      expect(saved.editor.review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
        acknowledged: false,
      });
      expect(requireLoomPolicy(saved.editor.config).workPolicy[0]?.source).toEqual({
        ...authoredEntry.source,
        presetRevision: futureRevision,
      });
      expect(saved.preset.prompt_order).toEqual(normalizePromptBlocks(next));
    });
    test("does not rebase a stale source across same-id prompt content replacement", () => {
      const promptOrder = [{ id: "shared-block", content: "old content" }];
      const pinnedConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [loomEntry("shared-work", "shared-block", "root_work", "WORK")],
        }),
      };
      const created = createPreset("u1", {
        name: "Same id replacement",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: pinnedConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;

      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: before.config,
        slotBindings: before.slotBindings,
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: normalizePromptBlocks([{ id: "shared-block", content: "new content" }]),
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.presetRevision).toBe(before.presetRevision + 1);
      expect(saved.editor.review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
        acknowledged: false,
      });
      expect(requireLoomPolicy(saved.editor.config).workPolicy[0]?.source.presetRevision).toBe(before.presetRevision);
      expect(saved.preset.prompt_order[0]).toMatchObject({ content: "new content" });
    });

    test("does not rebase a duplicate-id source across occurrence-local content replacement", () => {
      const promptOrder = [
        { id: "duplicate-block", content: "A" },
        { id: "duplicate-block", content: "B" },
      ];
      const pinnedConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [loomEntry("duplicate-work", "duplicate-block", "root_work", "WORK", 1)],
        }),
      };
      const created = createPreset("u1", {
        name: "Duplicate occurrence replacement",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: pinnedConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(before.review.state).toBe("ready");

      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: before.config,
        slotBindings: before.slotBindings,
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: [
          { id: "duplicate-block", content: "C" },
          { id: "duplicate-block", content: "A" },
        ],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
      });
      expect(requireLoomPolicy(saved.editor.config).workPolicy[0]?.source).toMatchObject({
        presetRevision: before.presetRevision,
        promptOrder: 1,
      });
    });
    test.each([
      {
        name: "new insertion",
        persisted: [{ id: "stable-block" }],
        next: [{ id: "stable-block" }, { id: "new-block" }],
        sourceId: "new-block",
        sourceOrder: 1,
      },
      {
        name: "different-ID replacement",
        persisted: [{ id: "old-block" }],
        next: [{ id: "replacement-block" }],
        sourceId: "replacement-block",
        sourceOrder: 0,
      },
    ])("does not rebase a source across a $name", ({ name, persisted, next, sourceId, sourceOrder }) => {
      const created = createPreset("u1", {
        name: `Unsafe ${name}`,
        provider: "loom",
        prompt_order: normalizePromptBlocks(persisted),
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const configWithSource: AgentConfigV2 = {
        ...before.config,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [loomEntry("introduced-work", sourceId, "root_work", "WORK", sourceOrder)],
        }),
      };

      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: configWithSource,
        slotBindings: before.slotBindings,
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: normalizePromptBlocks(next),
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
      });
      expect(requireLoomPolicy(saved.editor.config).workPolicy[0]?.source.presetRevision)
        .toBe(before.presetRevision);
    });

    test("does not rebase a source whose exact block occurrence moved", () => {
      const pinnedConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [loomEntry("moved-work", "target-block", "root_work", "WORK", 0)],
        }),
      };
      const created = createPreset("u1", {
        name: "Moved source",
        provider: "loom",
        prompt_order: [{ id: "target-block" }, { id: "other-block" }],
        agent_config: pinnedConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(before.review.state).toBe("ready");

      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: before.config,
        slotBindings: before.slotBindings,
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: normalizePromptBlocks([{ id: "other-block" }, { id: "target-block" }]),
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
      });
      expect(requireLoomPolicy(saved.editor.config).workPolicy[0]?.source).toMatchObject({
        presetRevision: before.presetRevision,
        promptOrder: 0,
      });
    });
    test("rebases a semantically identical source while an unreferenced block changes", () => {
      const promptOrder = normalizePromptBlocks([
        { id: "stable-source", content: "stable", name: "Stable" },
        { id: "unreferenced", content: "old" },
      ]);
      const pinnedConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [loomEntry("stable-work", "stable-source", "root_work", "WORK")],
        }),
      };
      const created = createPreset("u1", {
        name: "Equivalent source",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: pinnedConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;

      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: before.config,
        slotBindings: before.slotBindings,
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: normalizePromptBlocks([
          { name: "Stable", content: "stable", id: "stable-source" },
          { id: "unreferenced", content: "new" },
        ]),
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.presetRevision).toBe(before.presetRevision + 1);
      expect(saved.editor.review.state).toBe("ready");
      expect(requireLoomPolicy(saved.editor.config).workPolicy[0]?.source).toMatchObject({
        presetRevision: saved.editor.presetRevision,
        blockRevision: 1,
      });
    });
    test("keeps canonical and reordered-object ready saves exact no-ops", () => {
      const created = createPreset("u1", {
        name: "Ready no-op",
        provider: "loom",
        prompt_order: [{ id: "stable-block", content: "stable" }],
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const exact = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: before.config,
        slotBindings: before.slotBindings.map(({ slotId, connectionId }) => ({ slotId, connectionId })),
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: created.prompt_order,
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      expect(exact.editor.presetRevision).toBe(before.presetRevision);
      expect(exact.editor.configRevision).toBe(before.configRevision);

      const reordered = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: Object.fromEntries(Object.entries(before.config).reverse()) as unknown as AgentConfigV2,
        slotBindings: before.slotBindings.map(({ slotId, connectionId }) => ({ slotId, connectionId })),
        taskTemplates: before.taskTemplates.map((template) => Object.fromEntries(Object.entries(template as Record<string, unknown>).reverse()) as unknown as typeof template),
        reviewAcknowledgements: [...before.reviewAcknowledgements].reverse(),
        promptOrder: created.prompt_order.map((block) => Object.fromEntries(Object.entries(block).reverse())) as unknown as PromptBlock[],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      expect(reordered.editor.presetRevision).toBe(before.presetRevision);
      expect(reordered.editor.configRevision).toBe(before.configRevision);
      expect(getPresetCacheRevision("u1", created.id)).toBe(before.presetRevision);
      expect(getAgentRuntimeSharedDraft("u1", created.id)?.configRevision).toBe(before.configRevision);
    });

    test("quarantines a config-only direct future pin until repaired at current authority", () => {
      const promptOrder = normalizePromptBlocks([{ id: "current-block", content: "stable" }]);
      const created = createPreset("u1", {
        name: "Config-only future pin",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const currentEntry = loomEntry("current-work", "current-block", "root_work", "WORK", 0);
      const futureEntry = {
        ...currentEntry,
        source: { ...currentEntry.source, presetRevision: before.presetRevision + 1 },
      };
      const futureConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [futureEntry],
        }),
      };

      const quarantined = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: futureConfig,
        slotBindings: before.slotBindings,
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder,
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(quarantined.editor.presetRevision).toBe(before.presetRevision);
      expect(quarantined.editor.review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
        acknowledged: false,
      });
      expect(requireLoomPolicy(quarantined.editor.config).workPolicy[0]?.source)
        .toEqual(futureEntry.source);

      const currentConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [currentEntry],
        }),
      };
      const repaired = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: currentConfig,
        slotBindings: quarantined.editor.slotBindings,
        taskTemplates: quarantined.editor.taskTemplates,
        reviewAcknowledgements: [],
        promptOrder,
        expectedPresetRevision: quarantined.editor.presetRevision,
        expectedConfigRevision: quarantined.editor.configRevision,
      });

      expect(repaired.editor.presetRevision).toBe(before.presetRevision);
      expect(repaired.editor.review.state).toBe("ready");
      expect(requireLoomPolicy(repaired.editor.config).workPolicy[0]?.source)
        .toEqual(currentEntry.source);
    });
    test("rejects a config-only category source and accepts a valid current-revision block repair", () => {
      const promptOrder = normalizePromptBlocks([
        { id: "valid-block", content: "usable" },
        { id: "category-block", marker: "category", content: "heading" },
      ]);
      const created = createPreset("u1", {
        name: "Config-only category repair",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const categoryEntry = loomEntry("category-work", "category-block", "root_work", "WORK", 1);
      const categoryConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [categoryEntry],
        }),
      };

      const quarantined = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: categoryConfig,
        slotBindings: before.slotBindings,
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder,
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(quarantined.editor.presetRevision).toBe(before.presetRevision);
      expect(quarantined.editor.review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
        acknowledged: false,
      });
      expect(requireLoomPolicy(quarantined.editor.config).workPolicy[0]?.source)
        .toEqual(categoryEntry.source);

      const validEntry = loomEntry("valid-work", "valid-block", "root_work", "WORK", 0);
      const validConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [validEntry],
        }),
      };
      const repaired = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: validConfig,
        slotBindings: quarantined.editor.slotBindings,
        taskTemplates: quarantined.editor.taskTemplates,
        reviewAcknowledgements: [],
        promptOrder,
        expectedPresetRevision: quarantined.editor.presetRevision,
        expectedConfigRevision: quarantined.editor.configRevision,
      });

      expect(repaired.editor.presetRevision).toBe(before.presetRevision);
      expect(repaired.editor.review.state).toBe("ready");
      expect(requireLoomPolicy(repaired.editor.config).workPolicy[0]?.source)
        .toEqual(validEntry.source);
    });
    test("advances only config authority for config-only changes and repairs", () => {
      const promptOrder = normalizePromptBlocks([{ id: "pinned-block" }]);
      const pinnedConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [loomEntry("pinned-work", "pinned-block", "root_work", "WORK")],
        }),
      };
      const created = createPreset("u1", {
        name: "Config-only authority",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: pinnedConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const changed = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: { ...before.config, maxInvocations: before.config.maxInvocations - 1 },
        slotBindings: [],
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: created.prompt_order,
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      expect(changed.editor.presetRevision).toBe(before.presetRevision);
      expect(changed.editor.configRevision).toBe(before.configRevision + 1);
      expect(requireLoomPolicy(changed.editor.config).workPolicy[0]?.source.presetRevision).toBe(before.presetRevision);

      updatePreset("u1", created.id, {
        metadata: { quarantinedForRepair: true },
        expected_cache_revision: changed.editor.presetRevision,
      });
      const repairBefore = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(repairBefore.review.state).toBe("repair_required");
      expect(repairBefore.review.items).toEqual([]);
      const staleEntry = requireLoomPolicy(repairBefore.config).workPolicy[0];
      if (!staleEntry) throw new Error("expected pinned Loom source");
      const repairedConfig: AgentConfigV2 = {
        ...repairBefore.config,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [{
            ...staleEntry,
            source: { ...staleEntry.source, presetRevision: repairBefore.presetRevision },
          }],
        }),
      };
      const repaired = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: repairedConfig,
        slotBindings: [],
        taskTemplates: repairBefore.taskTemplates,
        reviewAcknowledgements: [],
        promptOrder: created.prompt_order,
        expectedPresetRevision: repairBefore.presetRevision,
        expectedConfigRevision: repairBefore.configRevision,
      });
      expect(repaired.editor.presetRevision).toBe(repairBefore.presetRevision);
      expect(repaired.editor.configRevision).toBe(repairBefore.configRevision + 1);
      expect(repaired.editor.review.state).toBe("ready");
      expect(requireLoomPolicy(repaired.editor.config).workPolicy[0]?.source.presetRevision).toBe(repairBefore.presetRevision);
    });

    test("commits moved prompt occurrence but quarantines its authored exact source", () => {
      const promptOrder = normalizePromptBlocks([{ id: "first-block" }, { id: "second-block" }]);
      const pinnedConfig: AgentConfigV2 = {
        ...agentConfig,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [loomEntry("second-work", "second-block", "root_work", "WORK", 1)],
        }),
      };
      const created = createPreset("u1", {
        name: "Prompt reorder",
        provider: "loom",
        prompt_order: promptOrder,
        agent_config: pinnedConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const source = requireLoomPolicy(before.config).workPolicy[0];
      if (!source) throw new Error("expected pinned Loom source");
      const reorderedConfig: AgentConfigV2 = {
        ...before.config,
        runtimePolicy: canonicalRuntimePolicy("response", {
          ...emptyLoomPolicy(),
          workPolicy: [{ ...source, source: { ...source.source, promptOrder: 0 } }],
        }),
      };
      const reorderedPromptOrder = [created.prompt_order[1]!, created.prompt_order[0]!];
      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: reorderedConfig,
        slotBindings: [],
        taskTemplates: before.taskTemplates,
        reviewAcknowledgements: before.reviewAcknowledgements,
        promptOrder: reorderedPromptOrder,
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      expect(saved.editor.presetRevision).toBe(before.presetRevision + 1);
      expect(saved.preset.cache_revision).toBe(saved.editor.presetRevision);
      expect(saved.editor.configRevision).toBe(before.configRevision + 1);
      expect(saved.editor.review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
        acknowledged: false,
        items: [],
      });
      expect(saved.editor.config).toEqual(reorderedConfig);
      expect(requireLoomPolicy(saved.editor.config).workPolicy[0]?.source).toMatchObject({
        blockId: "second-block",
        presetRevision: before.presetRevision,
        promptOrder: 0,
      });
      expect(getPreset("u1", created.id)?.prompt_order).toEqual(reorderedPromptOrder);
    });

    test("rejects stale config and preset CAS before editor mutations", () => {
      const configStalePreset = createPreset("u1", {
        name: "Stale config draft",
        provider: "loom",
        prompt_order: [{ id: "before" }],
        agent_config: agentConfig,
      });
      const configBefore = getAgentRuntimeSharedDraft("u1", configStalePreset.id)!;
      const externallyWritten = writePresetAgentConfigWithDb(getDb(), "u1", configStalePreset.id, {
        config: configBefore.config,
        expectedConfigRevision: configBefore.configRevision,
      });
      expect(() => saveAgentRuntimeSharedDraft("u1", configStalePreset.id, {
        config: configBefore.config,
        slotBindings: [],
        taskTemplates: configBefore.taskTemplates,
        reviewAcknowledgements: configBefore.reviewAcknowledgements,
        promptOrder: [{ id: "after" }],
        expectedPresetRevision: configBefore.presetRevision,
        expectedConfigRevision: configBefore.configRevision,
      })).toThrow(AgentConfigRevisionConflictError);
      expect(getPresetCacheRevision("u1", configStalePreset.id)).toBe(configBefore.presetRevision);
      expect(getAgentRuntimeSharedDraft("u1", configStalePreset.id)?.configRevision).toBe(externallyWritten.configRevision);
      expect(getPreset("u1", configStalePreset.id)?.prompt_order).toEqual(configStalePreset.prompt_order);

      const presetStale = createPreset("u1", {
        name: "Stale preset draft",
        provider: "loom",
        prompt_order: [{ id: "stable" }],
        agent_config: agentConfig,
      });
      const presetBefore = getAgentRuntimeSharedDraft("u1", presetStale.id)!;
      updatePreset("u1", presetStale.id, {
        name: "Externally changed",
        expected_cache_revision: presetBefore.presetRevision,
      });
      const presetAfterExternalWrite = getAgentRuntimeSharedDraft("u1", presetStale.id)!;
      expect(() => saveAgentRuntimeSharedDraft("u1", presetStale.id, {
        config: { ...presetBefore.config, maxInvocations: presetBefore.config.maxInvocations - 1 },
        slotBindings: [],
        taskTemplates: presetBefore.taskTemplates,
        reviewAcknowledgements: presetBefore.reviewAcknowledgements,
        promptOrder: presetStale.prompt_order,
        expectedPresetRevision: presetBefore.presetRevision,
        expectedConfigRevision: presetAfterExternalWrite.configRevision,
      })).toThrow("PRESET_REVISION_CONFLICT");
      expect(getPresetCacheRevision("u1", presetStale.id)).toBe(presetAfterExternalWrite.presetRevision);
      expect(getAgentRuntimeSharedDraft("u1", presetStale.id)?.configRevision).toBe(presetAfterExternalWrite.configRevision);
    });
    test("keeps unresolved slot reviews inert while recording explicit partial acknowledgement", () => {
      const slotConfig = {
        ...agentConfig,
        profiles: [{
          ...agentConfig.profiles[0],
          connectionRef: { kind: "slot" as const, slotId: "writer" },
        }],
        connectionSlots: [{ id: "writer", label: "Writer", requiredCapabilities: ["generation" as const] }],
      };
      const created = createPreset("u1", {
        name: "Unresolved runtime draft",
        provider: "loom",
        agent_config: slotConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const partial = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: slotConfig,
        slotBindings: [{ slotId: "writer", connectionId: null }],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: [],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      expect(partial.editor.review.state).toBe("review_required");
      expect(partial.editor.review.items).toEqual([
        expect.objectContaining({ id: "slot:writer", acknowledged: false }),
      ]);

      const acknowledged = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: slotConfig,
        slotBindings: [{ slotId: "writer", connectionId: null }],
        taskTemplates: [],
        reviewAcknowledgements: ["slot:writer"],
        promptOrder: [],
        expectedPresetRevision: partial.editor.presetRevision,
        expectedConfigRevision: partial.editor.configRevision,
      });
      expect(acknowledged.editor.review.state).toBe("review_required");
      expect(acknowledged.editor.review.items).toEqual([
        expect.objectContaining({ id: "slot:writer", acknowledged: true }),
      ]);
      expect(acknowledged.editor.config.agentsEnabled).toBe(true);
    });
    test("keeps sticky import review until required items are acknowledged", () => {
      for (const reasonCode of ["cognition_foreign_authority_blocked", "foreign_import"] as const) {
        const localConfig: AgentConfigV2 = {
          ...agentConfig,
          allowedModes: ["response", "agentic"],
          defaultMode: "agentic",
          runtimePolicy: canonicalRuntimePolicy("agentic"),
        };
        const created = createPreset("u1", {
          name: `Imported runtime ${reasonCode}`,
          provider: "loom",
          agent_config: localConfig,
        });
        writePresetAgentConfigWithDb(getDb(), "u1", created.id, {
          config: localConfig,
          review: {
            state: "review_required",
            reasonCode,
            unresolvedSlotIds: [],
            staleSlotIds: [],
            acknowledged: false,
          },
        });
        const before = getAgentRuntimeSharedDraft("u1", created.id)!;
        expect(before.review.state).toBe("review_required");
        const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
          config: localConfig,
          slotBindings: [],
          taskTemplates: [],
          reviewAcknowledgements: [],
          promptOrder: [],
          expectedPresetRevision: before.presetRevision,
          expectedConfigRevision: before.configRevision,
        });
        expect(saved.editor.presetRevision).toBe(before.presetRevision);
        expect(saved.editor.configRevision).toBe(before.configRevision + 1);
        expect(saved.editor.review.state).toBe("review_required");
        expect(saved.editor.review.reasonCode).toBe(reasonCode);
        expect(saved.editor.review.items).toEqual([
          expect.objectContaining({ id: `review:${reasonCode}`, acknowledged: false }),
        ]);
        expect(getDb().query(
          "SELECT state, review_code FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
        ).get("u1", created.id)).toEqual({
          state: "review_required",
          review_code: reasonCode,
        });
      }
    });

    test("clears import review after an acknowledged local authorized pack save", () => {
      const localConfig: AgentConfigV2 = {
        ...agentConfig,
        allowedModes: ["response", "agentic"],
        defaultMode: "agentic",
        runtimePolicy: canonicalRuntimePolicy("agentic"),
      };
      const created = createPreset("u1", {
        name: "Imported runtime",
        provider: "loom",
        agent_config: localConfig,
      });
      writePresetAgentConfigWithDb(getDb(), "u1", created.id, {
        config: localConfig,
        review: {
          state: "review_required",
          reasonCode: "cognition_foreign_authority_blocked",
          unresolvedSlotIds: [],
          staleSlotIds: [],
          acknowledged: false,
        },
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(before.review.state).toBe("review_required");
      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: localConfig,
        slotBindings: [],
        taskTemplates: [],
        reviewAcknowledgements: ["review:cognition_foreign_authority_blocked"],
        promptOrder: [],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });
      expect(saved.editor.review.state).toBe("ready");
      expect(getDb().query(
        "SELECT state, review_code FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
      ).get("u1", created.id)).toEqual({
        state: "ready",
        review_code: null,
      });
    });


    test("marks incompatible concrete slot bindings for review instead of ready", () => {
      getDb().run(
        "INSERT INTO connection_profiles (id, user_id, name, provider, model, metadata) VALUES (?, ?, ?, ?, ?, ?)",
        ["pollinations-no-tools", "u1", "Pollinations", "pollinations_text", "default", "{}"],
      );
      const slotConfig = {
        ...agentConfig,
        profiles: [{
          ...agentConfig.profiles[0],
          connectionRef: { kind: "slot" as const, slotId: "writer" },
        }],
        connectionSlots: [{
          id: "writer",
          label: "Writer",
          requiredCapabilities: ["tools_disabled_finalization" as const],
        }],
      };
      const created = createPreset("u1", {
        name: "Incompatible runtime binding",
        provider: "loom",
        agent_config: slotConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: slotConfig,
        slotBindings: [{ slotId: "writer", connectionId: "pollinations-no-tools" }],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: [],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      });

      expect(saved.editor.review.state).toBe("review_required");
      expect(saved.editor.review.reasonCode).toBe("capability_mismatch");
      expect(saved.editor.review.items).toEqual([
        expect.objectContaining({
          id: "stale-slot:writer",
          kind: "capability_mismatch",
          acknowledged: false,
        }),
      ]);
      expect(getDb().query(
        "SELECT state, review_code FROM preset_agent_slot_bindings WHERE user_id = ? AND preset_id = ? AND slot_id = ?",
      ).get("u1", created.id, "writer")).toEqual({
        state: "review_required",
        review_code: "capability_mismatch",
      });
      expect(saved.editor.config.agentsEnabled).toBe(true);
    });


    test("rolls back the prompt revision when review acknowledgement validation fails", () => {
      const created = createPreset("u1", {
        name: "Atomic review draft",
        provider: "loom",
        prompt_order: [{ id: "before" }],
        agent_config: agentConfig,
      });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(() => saveAgentRuntimeSharedDraft("u1", created.id, {
        config: agentConfig,
        slotBindings: [],
        taskTemplates: [],
        reviewAcknowledgements: ["review:unknown"],
        promptOrder: [{ id: "after" }],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: before.configRevision,
      })).toThrow("AGENT_REVIEW_ACKNOWLEDGEMENT_UNKNOWN");

      const after = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(after.presetRevision).toBe(before.presetRevision);
      expect(getPreset("u1", created.id)?.prompt_order).toEqual([{ id: "before" }]);
    });

    test("rejects unknown slot references without exposing local connection IDs", () => {
      const invalidSlotConfig = {
        ...agentConfig,
        profiles: [{
          ...agentConfig.profiles[0],
          connectionRef: { kind: "slot" as const, slotId: "missing-slot" },
        }],
      };
      expect(() => validateAgentConfigForExecution("u1", invalidSlotConfig)).toThrow("unknown slot id");

      const disabledPreset = createPreset("u1", {
        name: "Imported disabled agent",
        provider: "loom",
        agent_config: { ...agentConfig, agentsEnabled: false },
      });
      expect(disabledPreset.agent_config?.agentsEnabled).toBe(false);
      expect(validateAgentConfigForExecution("u1", {
        ...agentConfig,
        agentsEnabled: false,
      }).agentsEnabled).toBe(false);
    });

    test("projects a dormant editor for an owned preset that has no agent-config row", () => {
      const created = createPreset("u1", { name: "Plain loom", provider: "loom" });
      expect(created.agent_config).toBeUndefined();
      const editor = getAgentRuntimeSharedDraft("u1", created.id);
      expect(editor).not.toBeNull();
      expect(editor?.configRevision).toBe(0);
      expect(editor?.config).toEqual(createDisabledAgentConfigV2());
      expect(editor?.review.state).toBe("ready");
      expect(editor?.review.items).toEqual([]);
    });

    test("rejects invalid authored graph envelopes instead of hydrating an empty graph", () => {
      const invalidCarriers = [
        { name: "invalid JSON", value: "{" },
        { name: "non-object JSON", value: "[]" },
        { name: "unknown envelope key", value: JSON.stringify({ config: agentConfig, unknownGraph: [] }) },
      ];
      for (const [index, invalid] of invalidCarriers.entries()) {
        const created = createPreset("u1", {
          name: `Invalid authored carrier ${index}`,
          provider: "loom",
          agent_config: agentConfig,
        });
        getDb().query("UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?").run(
          invalid.value,
          "u1",
          created.id,
        );
        expect(
          () => getAgentRuntimeSharedDraft("u1", created.id),
          invalid.name,
        ).toThrow("AGENT_RUNTIME_PORTABLE_COGNITION_INVALID");
      }
    });
    test("projects authored task templates with their canonical task policy", () => {
      const created = createPreset("u1", {
        name: "Legacy task carrier",
        provider: "loom",
        agent_config: agentConfig,
      });
      const taskTemplate = {
        id: "legacy_task",
        required: true,
        dependencies: [],
      };
      const authoredCarrier = JSON.stringify({ config: agentConfig, taskTemplates: [taskTemplate] });
      getDb().query("UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?").run(
        authoredCarrier,
        "u1",
        created.id,
      );

      const editor = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(editor.config.taskPolicy).toEqual({ templateIds: [taskTemplate.id] });
      expect(editor.taskTemplates).toEqual([taskTemplate]);
      expect(getDb().query(
        "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
      ).get("u1", created.id)).toEqual({ config_json: authoredCarrier });
    });
    test("creates the first agent-config row from expectedConfigRevision 0", () => {
      const created = createPreset("u1", { name: "First runtime save", provider: "loom" });
      const before = getAgentRuntimeSharedDraft("u1", created.id)!;
      expect(before.configRevision).toBe(0);
      const saved = saveAgentRuntimeSharedDraft("u1", created.id, {
        config: { ...createDisabledAgentConfigV2(), agentsEnabled: true, allowedModes: ["response", "agentic"], defaultMode: "response" },
        slotBindings: [],
        taskTemplates: [],
        reviewAcknowledgements: [],
        promptOrder: created.prompt_order ?? [],
        expectedPresetRevision: before.presetRevision,
        expectedConfigRevision: 0,
      });
      expect(saved.editor.configRevision).toBe(1);
      expect(saved.editor.config.agentsEnabled).toBe(true);
      expect(saved.editor.config.allowedModes).toEqual(["response", "agentic"]);
      expect(getPreset("u1", created.id)?.agent_config?.agentsEnabled).toBe(true);
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

    expect(removePromptBlockFromStash("u1", stash.id)).toMatchObject({ removed: true, presetAuthorityChanged: true });
    expect(getPreset("u1", "p1")?.prompt_order[0]).toMatchObject({
      content: "keep this", enabled: false, group: "local-category",
    });
    expect(getPreset("u1", "p1")?.prompt_order[0].stashId).toBeUndefined();
  });

  test("removes a settings-only stash entry without advancing preset authority", () => {
    const stash = addPromptBlockToStash("u1", {
      id: "settings-only", name: "Settings only", content: "content", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
    });

    const committed = eventBus.withBufferedEvents(() => removePromptBlockFromStash("u1", stash.id));

    expect(committed.value).toEqual({ removed: true, presetAuthorityChanged: false, presetAuthorities: [] });
    expect(committed.events.map((event) => event.event)).toEqual([EventType.SETTINGS_UPDATED]);
  });
  test("keeps the full stash/preset/config graph atomic across the export barrier, rollback, and retry", async () => {
    const stash = addPromptBlockToStash("u1", {
      id: "source-block", name: "Atomic prompt", content: "keep this", role: "system",
      enabled: true, position: "pre_history", depth: 0, marker: null, isLocked: false,
      color: null, injectionTrigger: [], group: null,
    });
    const owners = [
      createStrictRevisionPreset("stash-owner-a"),
      createStrictRevisionPreset("stash-owner-b"),
    ];
    for (const owner of owners) {
      const linked = owner.prompt_order.map((block, index) => index === 0 ? { ...block, stashId: stash.id } : block);
      getDb().query("UPDATE presets SET prompt_order = ? WHERE id = ? AND user_id = ?")
        .run(JSON.stringify(linked), owner.id, "u1");
    }
    const before = new Map(owners.map((owner) => [owner.id, getPreset("u1", owner.id)!]));
    for (const owner of before.values()) {
      expect(owner.agent_config_review?.state).toBe("ready");
      expect(fullPromptSources(owner.agent_config!)).toHaveLength(11);
    }

    const held = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const exportBarrier = userDataSnapshotBarrier.withExclusive("u1", async () => {
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    expect(() => removePromptBlockFromStash("u1", stash.id)).toThrow(UserDataBarrierBusyError);
    expect(listPromptStash("u1").map((entry) => entry.id)).toEqual([stash.id]);
    for (const [id, snapshot] of before) expect(getPreset("u1", id)).toEqual(snapshot);
    held.resolve();
    await exportBarrier;

    getDb().run(`CREATE TRIGGER reject_stash_removal
      BEFORE UPDATE OF value ON settings
      WHEN NEW.key = 'loomPromptStash'
      BEGIN SELECT RAISE(ABORT, 'forced stash failure'); END`);
    const rolledBack = eventBus.withBufferedEvents(() => {
      try {
        removePromptBlockFromStash("u1", stash.id);
        return null;
      } catch (error) {
        return error;
      }
    });
    expect((rolledBack.value as Error).message).toContain("forced stash failure");
    expect(rolledBack.events).toEqual([]);
    expect(listPromptStash("u1").map((entry) => entry.id)).toEqual([stash.id]);
    for (const [id, snapshot] of before) expect(getPreset("u1", id)).toEqual(snapshot);

    getDb().run("DROP TRIGGER reject_stash_removal");
    const committed = eventBus.withBufferedEvents(() => removePromptBlockFromStash("u1", stash.id));
    expect(committed.value).toMatchObject({
      removed: true,
      presetAuthorityChanged: true,
    });
    expect(committed.value.presetAuthorities.map((preset) => preset.id).sort()).toEqual(
      owners.map((owner) => owner.id).sort(),
    );
    expect(committed.events.map((event) => event.event)).toEqual([
      EventType.SETTINGS_UPDATED,
      EventType.PRESET_CHANGED,
      EventType.PRESET_CHANGED,
    ]);
    expect(listPromptStash("u1")).toEqual([]);
    for (const [id, snapshot] of before) {
      const after = getPreset("u1", id)!;
      expect(after.cache_revision).toBe(requireCacheRevision(snapshot) + 1);
      expect(after.agent_config_revision).toBe((snapshot.agent_config_revision ?? 0) + 1);
      expect(after.agent_config_review).toMatchObject({
        state: "repair_required",
        reasonCode: "loom_reference_repair_required",
      });
      expect(after.prompt_order.map((block) => ({ ...block, stashId: undefined })))
        .toEqual(snapshot.prompt_order.map((block) => ({ ...block, stashId: undefined })));
      expect(fullPromptSources(after.agent_config!)).toEqual(fullPromptSources(snapshot.agent_config!));
    }

    const committedSnapshots = new Map(owners.map((owner) => [owner.id, getPreset("u1", owner.id)!]));
    const repeated = eventBus.withBufferedEvents(() => removePromptBlockFromStash("u1", stash.id));
    expect(repeated.value).toEqual({ removed: false, presetAuthorityChanged: false, presetAuthorities: [] });
    expect(repeated.events).toEqual([]);
    for (const [id, snapshot] of committedSnapshots) expect(getPreset("u1", id)).toEqual(snapshot);
  });
});
describe("presets.service — prompt block occurrence identity", () => {
  function duplicateBlock(content: string, variableName?: string): PromptBlock {
    return {
      id: "duplicate",
      name: content,
      content,
      role: "system",
      enabled: true,
      position: "pre_history",
      depth: 0,
      marker: null,
      isLocked: false,
      color: null,
      injectionTrigger: [],
      group: null,
      variables: variableName ? [{
        id: variableName,
        name: variableName,
        label: variableName,
        type: "text",
        defaultValue: "",
      }] : undefined,
    };
  }

  test("gets, updates, and deletes only the verified duplicate occurrence", () => {
    const created = createPreset("u1", {
      name: "Duplicate block CRUD",
      provider: "loom",
      prompt_order: [duplicateBlock("zero"), duplicateBlock("one")],
    });
    const zero = { blockId: "duplicate", promptOrder: 0 } as const;
    const one = { blockId: "duplicate", promptOrder: 1 } as const;

    expect(getPromptBlock("u1", created.id, zero)?.content).toBe("zero");
    expect(getPromptBlock("u1", created.id, one)?.content).toBe("one");
    expect(getPromptBlock("u1", created.id, { blockId: "wrong", promptOrder: 0 })).toBeNull();

    const initialRevision = getPresetCacheRevision("u1", created.id)!;
    expect(updatePromptBlock("u1", created.id, { ...one, expectedCacheRevision: initialRevision }, { content: "one updated" })?.content).toBe("one updated");
    expect(listPromptBlocks("u1", created.id)?.map((block) => block.content)).toEqual(["zero", "one updated"]);

    const revisionBeforeDelete = getPresetCacheRevision("u1", created.id)!;
    const wrongTarget = { blockId: "wrong", promptOrder: 0, expectedCacheRevision: revisionBeforeDelete } as const;
    expect(updatePromptBlock("u1", created.id, wrongTarget, { content: "corrupt" })).toBeNull();
    expect(deletePromptBlock("u1", created.id, wrongTarget)).toBe(false);
    expect(getPresetCacheRevision("u1", created.id)).toBe(revisionBeforeDelete);
    expect(listPromptBlocks("u1", created.id)?.map((block) => block.content)).toEqual(["zero", "one updated"]);

    expect(deletePromptBlock("u1", created.id, { ...zero, expectedCacheRevision: revisionBeforeDelete })).toBe(true);
    const revisionAfterDelete = revisionBeforeDelete + 1;
    expect(getPresetCacheRevision("u1", created.id)).toBe(revisionAfterDelete);
    expect(listPromptBlocks("u1", created.id)?.map((block) => block.content)).toEqual(["one updated"]);

    const staleOne = { ...one, expectedCacheRevision: revisionBeforeDelete } as const;
    expect(() => updatePromptBlock("u1", created.id, staleOne, { content: "stale overwrite" }))
      .toThrow(PresetRevisionConflictError);
    expect(() => deletePromptBlock("u1", created.id, staleOne)).toThrow(PresetRevisionConflictError);
    expect(() => createPromptBlock("u1", created.id, duplicateBlock("stale insert"), {
      index: 0,
      expectedCacheRevision: revisionBeforeDelete,
    })).toThrow(PresetRevisionConflictError);
    expect(() => createPromptBlock("u1", created.id, duplicateBlock("stale append"), {
      expectedCacheRevision: revisionBeforeDelete,
    })).toThrow(PresetRevisionConflictError);
    expect(getPresetCacheRevision("u1", created.id)).toBe(revisionAfterDelete);
    expect(listPromptBlocks("u1", created.id)?.map((block) => block.content)).toEqual(["one updated"]);
    expect(getPromptBlock("u1", created.id, one)).toBeNull();
    expect(getPromptBlock("u1", created.id, zero)?.content).toBe("one updated");
  });

  test("rejects invalid create indexes before consuming preset authority", () => {
    const created = createPreset("u1", {
      name: "Create index boundary",
      provider: "loom",
      prompt_order: [duplicateBlock("zero"), duplicateBlock("one")],
    });
    const initialRevision = getPresetCacheRevision("u1", created.id)!;
    const initialContents = listPromptBlocks("u1", created.id)!.map((block) => block.content);

    for (const index of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 3, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createPromptBlock("u1", created.id, duplicateBlock("invalid"), {
        index,
        expectedCacheRevision: initialRevision,
      })).toThrow(/index/i);
      expect(getPresetCacheRevision("u1", created.id)).toBe(initialRevision);
      expect(listPromptBlocks("u1", created.id)!.map((block) => block.content)).toEqual(initialContents);
    }
    expect(() => createPromptBlock("u1", created.id, duplicateBlock("invalid stale"), {
      index: -1,
      expectedCacheRevision: initialRevision + 100,
    })).toThrow(/index/i);
    expect(getPresetCacheRevision("u1", created.id)).toBe(initialRevision);

    expect(createPromptBlock("u1", created.id, duplicateBlock("front"), {
      index: 0,
      expectedCacheRevision: initialRevision,
    })?.content).toBe("front");
    const afterFrontRevision = getPresetCacheRevision("u1", created.id)!;
    const appendIndex = listPromptBlocks("u1", created.id)!.length;
    expect(createPromptBlock("u1", created.id, duplicateBlock("bounded append"), {
      index: appendIndex,
      expectedCacheRevision: afterFrontRevision,
    })?.content).toBe("bounded append");
    const afterBoundedAppendRevision = getPresetCacheRevision("u1", created.id)!;
    expect(createPromptBlock("u1", created.id, duplicateBlock("omitted append"), {
      expectedCacheRevision: afterBoundedAppendRevision,
    })?.content).toBe("omitted append");
    expect(listPromptBlocks("u1", created.id)!.map((block) => block.content)).toEqual([
      "front",
      "zero",
      "one",
      "bounded append",
      "omitted append",
    ]);
  });

  test("preserves schemas from every same-id occurrence while pruning true orphans", () => {
    const created = createPreset("u1", {
      name: "Duplicate occurrence schemas",
      provider: "loom",
      prompt_order: [duplicateBlock("zero", "zeroValue"), duplicateBlock("one", "oneValue")],
      metadata: {
        promptVariables: {
          duplicate: {
            zeroValue: "zero",
            oneValue: "one",
            orphan: "remove",
          },
        },
      },
    });

    expect(created.metadata?.promptVariables).toEqual({
      duplicate: {
        zeroValue: "zero",
        oneValue: "one",
      },
    });
  });
});

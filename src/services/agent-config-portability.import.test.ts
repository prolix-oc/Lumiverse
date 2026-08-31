import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import type { AgentRuntimePolicyV1, PortableAgentConfigV1 } from "../types/agents";
import { COGNITION_MAX_LIST_ITEMS, COGNITION_MAX_PREDICATE_DEPTH, type LoomPolicyCheckpointV1, type LoomPolicyDestinationV1, type LoomPolicyEntryV1 } from "../types/agent-cognition";
import { REGEX_LIMITS_V1 } from "../utils/regex-limits";
import {
  duplicatePresetWithAgentConfig,
  getPortablePresetRuntimeEnvelope,
  getPresetAgentCognitionSourceV1,
  getPresetAgentConfig,
  importPortablePreset,
  importPortablePresetRuntime,
  parsePortablePresetRuntimeEnvelope,
  portablePresetRegexScriptsMatchStored,
  parsePortablePresetRuntimeImportRequest,
  PORTABLE_PRESET_FIELDS_MAX_BYTES,
  PORTABLE_JSON_MAX_NODES,
  writePresetAgentConfig,
  type PortablePresetRuntimeEnvelopeV1,
} from "./agent-config-portability.service";
import { getPreset, updatePreset } from "./presets.service";
import { updateRegexScript } from "./regex-scripts.service";

const USER_ID = "portable-import-user";

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
    source: { kind: "loom_block", blockId, presetRevision: 0, blockRevision: 2, promptOrder },
    destination,
    checkpoint,
    required: true,
    visibility: "work_only",
    ...(condition === undefined ? {} : { condition }),
  };
}

function authoredRuntimePolicy(): AgentRuntimePolicyV1 {
  return {
    version: 1,
    authority: "loom",
    scope: "preset",
    defaultMode: "agentic",
    loomPolicy: {
      version: 1,
      workPolicy: [loomEntry("work", "work-block", "root_work", "WORK", 0, { kind: "phase", value: "WORK" })],
      workspaceUsage: [loomEntry("workspace", "workspace-block", "root_work", "WORK", 1)],
      completionCriteria: [loomEntry("completion", "completion-block", "completion_handoff", "PREPARE_COMMIT", 2)],
      renderPolicy: [loomEntry("render", "render-block", "render", "RENDER", 3)],
    },
    phases: [{
      version: 1,
      id: "draft",
      label: "Draft",
      instructionRefs: [{
        kind: "loom_block",
        blockId: "phase-instructions",
        presetRevision: 0,
        blockRevision: 3,
        promptOrder: 4,
      }],
      childInstructionSubsets: [],
      required: true,
      enter: { kind: "phase", value: "WORK" },
      exit: { kind: "phase", value: "WORK" },
      skip: { kind: "not", child: { kind: "phase", value: "COMPLETE" } },
      capabilityRequests: ["core_retrieval", "workspace_read"],
      repeatLimit: 2,
      nextPhaseIds: [],
    }],
  };
}

function canonicalRuntimeEnvelope(): PortablePresetRuntimeEnvelopeV1 {
  const runtimePolicy = authoredRuntimePolicy();
  const agentConfig: PortableAgentConfigV1 = {
    portableVersion: 1,
    agentsEnabled: true,
    allowedModes: ["response", "agentic"],
    defaultMode: "agentic",
    maxInvocations: 4,
    maxToolCalls: 4,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [],
    connectionSlots: [],
    workspacePolicy: { retention: "chat_lifetime", sharing: "view_only" },
    runtimePolicy,
  };
  return {
    version: 1,
    agentConfig,
    taskTemplates: [],
  };
}

function runtimeEnvelopeWithProfile(workspaceCapabilities: readonly string[]): unknown {
  const envelope = canonicalRuntimeEnvelope() as unknown as Record<string, unknown>;
  const agentConfig = envelope.agentConfig as Record<string, unknown>;
  agentConfig.profiles = [{
    id: "child",
    name: "Child",
    systemPrompt: "Return bounded evidence.",
    connectionRef: { kind: "inherit_main" },
    toolIds: [],
    workspaceCapabilities: [...workspaceCapabilities],
    loreScope: "active",
    allowMainDelegation: false,
    failurePolicy: "required",
    streamActivity: false,
    maxOutputTokens: 256,
    timeoutMs: 5_000,
  }];
  return envelope;
}

function runtimeEnvelope(withAgentConfig = true): PortablePresetRuntimeEnvelopeV1 {
  const envelope = canonicalRuntimeEnvelope();
  return {
    version: 1,
    agentConfig: withAgentConfig ? envelope.agentConfig : null,
    taskTemplates: [],
  };
}


function taskTemplate(id: string, dependencies: readonly string[] = []): Record<string, unknown> {
  return { id, required: true, dependencies: [...dependencies] };
}

function runtimeEnvelopeWithTasks(
  taskTemplates: readonly Record<string, unknown>[],
  templateIds: readonly string[] = taskTemplates.map((template) => String(template.id)),
): unknown {
  const envelope = canonicalRuntimeEnvelope();
  if (!envelope.agentConfig) throw new Error("portable task fixture did not include an agent config");
  return {
    ...envelope,
    agentConfig: {
      ...envelope.agentConfig,
      taskPolicy: { templateIds: [...templateIds] },
    },
    taskTemplates: [...taskTemplates],
  };
}


function runtimeEnvelopeWithLegacyCognition(payload: unknown, includeRuntimePolicy = false): unknown {
  const envelope = canonicalRuntimeEnvelope();
  if (!envelope.agentConfig) throw new Error("portable cognition fixture did not include an agent config");
  const agentConfig = { ...envelope.agentConfig };
  if (!includeRuntimePolicy) delete agentConfig.runtimePolicy;
  return { ...envelope, agentConfig: { ...agentConfig, cognitionPolicy: payload } };
}
function balancedZeroByteJson(nodeCount: number, objectLeaves: boolean): unknown {
  if (nodeCount < 1) throw new Error("balanced JSON fixture must contain at least one node");
  if (nodeCount === 1) return objectLeaves ? {} : [];
  const remaining = nodeCount - 1;
  const leftCount = Math.max(1, Math.floor(remaining / 2));
  const rightCount = remaining - leftCount;
  const children = [balancedZeroByteJson(leftCount, objectLeaves)];
  if (rightCount > 0) children.push(balancedZeroByteJson(rightCount, objectLeaves));
  return children;
}

function zeroBytePortableGraphTasks(overBudget: boolean): Record<string, unknown>[] {
  const emptyPredicate = { kind: "all", children: [] };
  const fanout = (count: number): Record<string, unknown> => ({
    kind: "all",
    children: new Array(count).fill(emptyPredicate),
  });
  const tasks: Record<string, unknown>[] = Array.from({ length: 21 }, (_, index) => ({
    ...taskTemplate(`task_${index}`),
    activation: fanout(255),
  }));
  tasks.push({
    ...taskTemplate("task_21", overBudget ? ["task_0"] : []),
    activation: fanout(54),
    label: "",
  });
  return tasks;
}


function preset(
  regex_scripts?: readonly Record<string, unknown>[],
  name = "Portable preset",
) {
  return {
    name,
    provider: "loom",
    parameters: {},
    prompt_order: [],
    prompts: {},
    metadata: {},
    ...(regex_scripts === undefined ? {} : { regex_scripts }),
  };
}
function promptBlock(index: number): Record<string, unknown> {
  return {
    id: `block-${index}`,
    name: `Block ${index}`,
    content: `content-${index}`,
    role: "system",
    enabled: true,
    position: "pre_history",
    depth: 0,
    marker: null,
    isLocked: false,
    color: null,
    injectionTrigger: [],
    group: null,
    categoryMode: null,
  };
}
function presetWithAuthoredRuntime() {
  const blocks = [
    ["work-block", 2],
    ["workspace-block", 2],
    ["completion-block", 2],
    ["render-block", 2],
    ["phase-instructions", 3],
  ] as const;
  return {
    ...preset(),
    prompt_order: blocks.map(([id, revision], index) => ({
      ...promptBlock(index),
      id,
      revision,
    })),
  };
}
function nativeLoomPromptBlocks(): Record<string, unknown>[] {
  const options = [
    { id: "concise", label: "Concise", value: "short and direct" },
    { id: "detailed", label: "Detailed", value: "thorough and explanatory" },
  ];
  const selectVariable = {
    id: "style",
    name: "style",
    label: "Style",
    type: "select",
    options,
    defaultValue: "concise",
  };
  return [
    {
      ...promptBlock(0),
      name: "Category",
      marker: "category",
      categoryMode: "checkbox",
      savedChildEnabled: { "block-1": false },
      variables: [
        { id: "plain", name: "plain", label: "Plain", type: "text", defaultValue: "default" },
        { id: "notes", name: "notes", label: "Notes", type: "textarea", rows: 3, defaultValue: "notes" },
        { id: "count", name: "count", label: "Count", type: "number", min: 0, max: 10, step: 1, defaultValue: 5 },
        { id: "ratio", name: "ratio", label: "Ratio", type: "slider", min: 0, max: 1, step: 0.1, defaultValue: 0.5 },
        selectVariable,
        { id: "enabled", name: "enabled", label: "Enabled", type: "switch", defaultValue: 1 },
        {
          id: "tags",
          name: "tags",
          label: "Tags",
          type: "multiselect",
          options,
          defaultValue: ["concise"],
          separator: ", ",
        },
      ],
    },
    {
      ...promptBlock(1),
      group: "block-0",
      characterTagTrigger: ["ordinary"],
      variables: [selectVariable],
      placementBinding: {
        variableId: "style",
        options: {
          concise: { role: "system", position: "pre_history", depth: 0 },
          detailed: { role: "assistant", position: "post_history", depth: 1.5 },
        },
      },
      sealed: true,
      sealedKey: "ordinary-block",
      sealedSource: "lumihub",
      sealedOriginPresetId: "origin-preset",
      sealedOriginVersion: "1.0.0",
      sealedSha256: "a".repeat(64),
      revision: 1,
    },
  ];
}



function validRegex(scriptId: string): Record<string, unknown> {
  return {
    name: `Portable ${scriptId}`,
    script_id: scriptId,
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
    metadata: {},
  };
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await runMigrations(getDb());
  getDb().query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(
    USER_ID,
    "Portable Import User",
    "portable-import@example.test",
  );
});

afterEach(() => closeDatabase());

describe("portable preset runtime import atomicity", () => {
  test("rolls back preset, config, regex, and revisions when a later regex fails", () => {
    const malformed = { name: "Missing pattern" };

    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("first"), malformed]),
      agentRuntime: runtimeEnvelope(),
    })).toThrow("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");

    const db = getDb();
    expect(db.query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_configs WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM settings WHERE user_id = ? AND key LIKE 'presetRegexEnabled:%'").get(USER_ID)).toEqual({ count: 0 });
  });
  test("rejects retired record_question child grants during portable import", () => {
    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: preset(),
      agentRuntime: runtimeEnvelopeWithProfile(["record_question"]),
    })).toThrow("workspace operation is not allowed for child profiles");
    expect(getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
  });

  test("quarantines a persisted retired record_question grant without making the preset unreadable", () => {
    const result = importPortablePresetRuntime(USER_ID, {
      preset: preset(),
      agentRuntime: runtimeEnvelopeWithProfile(["read_section"]),
    });
    const db = getDb();
    db.query(
      "UPDATE preset_agent_profiles SET workspace_capabilities = ? WHERE user_id = ? AND preset_id = ?",
    ).run(JSON.stringify(["record_question"]), USER_ID, result.preset.id);

    expect(getPresetAgentConfig(USER_ID, result.preset.id)).toMatchObject({
      config: {
        agentsEnabled: false,
        allowedModes: ["response"],
        defaultMode: "response",
        profiles: [],
      },
      review: {
        state: "repair_required",
        reasonCode: "AGENT_RUNTIME_CHILD_WORKSPACE_CAPABILITIES_INVALID:profiles[0].workspaceCapabilities[0]",
        acknowledged: false,
      },
    });
  });

  test("does not inject the historical phase policy carrier into live config", () => {
    const envelope = canonicalRuntimeEnvelope();
    if (!envelope.agentConfig) throw new Error("missing agent config fixture");
    const result = importPortablePresetRuntime(USER_ID, {
      preset: presetWithAuthoredRuntime(),
      agentRuntime: envelope,
    });
    getDb().query(
      "UPDATE preset_agent_configs SET phase_policy_json = ? WHERE user_id = ? AND preset_id = ?",
    ).run(JSON.stringify({
      work: [{ blockId: "historical-work", expectedPresetRevision: 0, expectedBlockRevision: 0 }],
      render: [],
    }), USER_ID, result.preset.id);

    const projection = getPresetAgentConfig(USER_ID, result.preset.id);
    expect(projection?.config).toEqual(result.agent_config);
    expect(Object.hasOwn(projection?.config ?? {}, "phasePolicy")).toBe(false);
  });
  test("rolls back an existing preset replacement when a later regex fails", () => {
    const initial = importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("original")], "Original"),
      agentRuntime: runtimeEnvelope(),
    });
    const db = getDb();
    const beforePresetRow = db.query(
      "SELECT name, cache_revision FROM presets WHERE user_id = ? AND id = ?",
    ).get(USER_ID, initial.preset.id) as { name?: unknown; cache_revision?: unknown } | null;
    if (
      !beforePresetRow
      || typeof beforePresetRow.name !== "string"
      || typeof beforePresetRow.cache_revision !== "number"
    ) {
      throw new Error("portable import fixture did not create a preset");
    }
    const beforePreset = {
      name: beforePresetRow.name,
      cache_revision: beforePresetRow.cache_revision,
    };
    const beforeConfig = db.query(
      "SELECT config_json, config_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, initial.preset.id);
    const beforeRegex = db.query(
      "SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY id",
    ).all(USER_ID, initial.preset.id);
    const beforeSettings = db.query(
      "SELECT key, value FROM settings WHERE user_id = ? AND key LIKE 'presetRegexEnabled:%' ORDER BY key",
    ).all(USER_ID);

    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("replacement"), { name: "Missing pattern" }], "Replacement"),
      agentRuntime: runtimeEnvelope(),
      existingPresetId: initial.preset.id,
      expectedPresetRevision: beforePreset.cache_revision,
    })).toThrow("AGENT_RUNTIME_PORTABLE_REGEX_INVALID");

    expect(db.query(
      "SELECT name, cache_revision FROM presets WHERE user_id = ? AND id = ?",
    ).get(USER_ID, initial.preset.id)).toEqual(beforePreset);
    expect(db.query(
      "SELECT config_json, config_revision FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, initial.preset.id)).toEqual(beforeConfig);
    expect(db.query(
      "SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY id",
    ).all(USER_ID, initial.preset.id)).toEqual(beforeRegex);
    expect(db.query(
      "SELECT key, value FROM settings WHERE user_id = ? AND key LIKE 'presetRegexEnabled:%' ORDER BY key",
    ).all(USER_ID)).toEqual(beforeSettings);
  });

  test("commits each portable component once when every embedded regex is valid", () => {
    const result = importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("first"), validRegex("second")]),
      agentRuntime: runtimeEnvelope(),
    });
    const db = getDb();

    expect(result.preset.id).toBeString();
    expect(db.query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM preset_agent_configs WHERE user_id = ?").get(USER_ID)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM settings WHERE user_id = ? AND key LIKE 'presetRegexEnabled:%'").get(USER_ID)).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ? AND preset_id = ?").get(USER_ID, result.preset.id)).toEqual({ count: 2 });
    const authored = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, result.preset.id) as { config_json: string };
    expect(JSON.parse(authored.config_json)).toMatchObject({
      config: {
        workspacePolicy: { retention: "chat_lifetime", sharing: "view_only" },
        runtimePolicy: { loomPolicy: authoredRuntimePolicy().loomPolicy, phases: authoredRuntimePolicy().phases },
      },
      taskTemplates: [],
      reviewAcknowledgements: [],
    });

    const duplicate = duplicatePresetWithAgentConfig(USER_ID, result.preset.id, "Portable copy");
    expect(duplicate.copiedRegexScriptIds).toHaveLength(2);
    expect(db.query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ? AND preset_id = ?").get(USER_ID, duplicate.preset.id)).toEqual({ count: 2 });
  });
  test("replaces a provenance-stamped regex after an opposite direct mutation", () => {
    const source = {
      ...validRegex("provenance"),
      target: ["response", "prompt"],
      metadata: { nested: { alpha: 1, beta: 2 } },
    };
    const initial = importPortablePresetRuntime(USER_ID, {
      preset: preset([source], "Provenance"),
      agentRuntime: runtimeEnvelope(),
    });
    const reordered = {
      ...Object.fromEntries(Object.entries(source).reverse()),
      metadata: { nested: { beta: 2, alpha: 1 } },
    };
    expect(portablePresetRegexScriptsMatchStored(USER_ID, initial.preset.id, [reordered])).toBe(true);
    expect(portablePresetRegexScriptsMatchStored(USER_ID, initial.preset.id, [{
      ...reordered,
      target: ["prompt", "response"],
    }])).toBe(false);

    const stored = getDb().query(
      "SELECT id FROM regex_scripts WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, initial.preset.id) as { id: string };
    const mutated = updateRegexScript(USER_ID, stored.id, { find_regex: "locally-mutated" });
    expect(mutated && typeof mutated !== "string" ? mutated.find_regex : null).toBe("locally-mutated");
    expect(portablePresetRegexScriptsMatchStored(USER_ID, initial.preset.id, [source])).toBe(false);

    const beforeReplace = getPreset(USER_ID, initial.preset.id)!;
    const beforeRevision = beforeReplace.cache_revision ?? 0;
    const replaced = updatePreset(USER_ID, initial.preset.id, {
      regex_scripts: [source],
      expected_cache_revision: beforeRevision,
    })!;
    expect(replaced.cache_revision).toBe(beforeRevision + 1);
    expect(getDb().query(
      "SELECT find_regex FROM regex_scripts WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, initial.preset.id)).toEqual({ find_regex: "foo" });
  });

  test("reimports regex companions as independent local rows and remaps references", () => {
    const source = importPortablePresetRuntime(USER_ID, {
      preset: preset([validRegex("source")], "Source"),
      agentRuntime: runtimeEnvelope(),
    });
    const db = getDb();
    const before = db.query(
      "SELECT id, script_id, preset_id, metadata FROM regex_scripts WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, source.preset.id);
    const copied = importPortablePresetRuntime(USER_ID, {
      preset: preset([
        validRegex("source"),
        { ...validRegex("dependent"), metadata: { script_id: "source" } },
      ], "Copy"),
      agentRuntime: runtimeEnvelope(),
    });
    expect(db.query(
      "SELECT id, script_id, preset_id, metadata FROM regex_scripts WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, source.preset.id)).toEqual(before);
    const rows = db.query(
      "SELECT id, script_id, preset_id, metadata, name FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY name",
    ).all(USER_ID, copied.preset.id) as Array<{ id: string; script_id: string; preset_id: string; metadata: string; name: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.script_id === "")).toBe(true);
    expect(rows.every((row) => row.preset_id === copied.preset.id)).toBe(true);
    const sourceCopy = rows.find((row) => row.name === "Portable source");
    const dependent = rows.find((row) => row.name === "Portable dependent");
    expect(sourceCopy).toBeDefined();
    expect(dependent).toBeDefined();
    const sourceMetadata = JSON.parse(sourceCopy!.metadata) as Record<string, unknown>;
    const dependentMetadata = JSON.parse(dependent!.metadata) as Record<string, unknown>;
    expect(new Set(rows.map((row) => JSON.parse(row.metadata).imported_script_id)).size).toBe(2);
    expect(rows.every((row) => /^portable_[0-9a-f]+$/.test(JSON.parse(row.metadata).imported_script_id))).toBe(true);
    expect(dependentMetadata.script_id).toBe(sourceMetadata.imported_script_id);
  });
  test("quarantines an authored Agentic runtime while preserving canonical Loom policy and phases", () => {
    const agentRuntime = canonicalRuntimeEnvelope();
    const authoredConfig = agentRuntime.agentConfig;
    if (!authoredConfig?.runtimePolicy) throw new Error("portable import fixture did not include runtime policy");
    const authoredRuntime = authoredConfig.runtimePolicy;

    const result = importPortablePresetRuntime(USER_ID, {
      preset: presetWithAuthoredRuntime(),
      agentRuntime,
    });

    expect(result.agent_config).toMatchObject({
      agentsEnabled: false,
      allowedModes: ["response"],
      defaultMode: "response",
      runtimePolicy: { defaultMode: "response" },
    });
    expect(result.agent_config.runtimePolicy?.loomPolicy).toEqual(authoredRuntime.loomPolicy);
    expect(result.agent_config.runtimePolicy?.phases).toEqual(authoredRuntime.phases);
    expect(result.agent_config_review).toMatchObject({
      state: "review_required",
      reasonCode: "foreign_import",
      acknowledged: false,
    });

    const exported = getPortablePresetRuntimeEnvelope(USER_ID, result.preset.id);
    expect(exported?.agentConfig).toMatchObject({
      agentsEnabled: false,
      allowedModes: ["response"],
      defaultMode: "response",
      runtimePolicy: {
        defaultMode: "response",
        loomPolicy: authoredRuntime.loomPolicy,
        phases: authoredRuntime.phases,
      },
    });
  });

  test("loads canonical Loom cognition when an empty task graph was omitted", () => {
    const agentRuntime = canonicalRuntimeEnvelope();
    const result = importPortablePresetRuntime(USER_ID, {
      preset: presetWithAuthoredRuntime(),
      agentRuntime,
    });
    const ready = writePresetAgentConfig(USER_ID, result.preset.id, {
      config: agentRuntime.agentConfig,
      expectedConfigRevision: result.preset.agent_config_revision,
    });
    getDb().query(
      "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
    ).run(
      JSON.stringify({ config: ready.config }),
      USER_ID,
      result.preset.id,
    );

    expect(ready.review.state).toBe("ready");
    const source = getPresetAgentCognitionSourceV1(USER_ID, result.preset.id);
    expect(source?.taskTemplates).toEqual([]);
    expect(source?.config.runtimePolicy).toEqual(ready.config.runtimePolicy);
  });



  test("accepts a legacy runtime envelope with no embedded regex field", () => {
    const result = importPortablePresetRuntime(USER_ID, {
      preset: preset(),
      agentRuntime: runtimeEnvelope(false),
    });

    expect(result.preset.name).toBe("Portable preset");
    expect(getDb().query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
  });
});

describe("portable preset field bounds", () => {
  test("rejects deeply nested preset fields before persistence", () => {
    let nested: unknown = "bounded";
    for (let index = 0; index < COGNITION_MAX_PREDICATE_DEPTH + 1; index += 1) {
      nested = { child: nested };
    }

    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: { ...preset(), parameters: nested as Record<string, unknown> },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow(`JSON nesting must be at most ${COGNITION_MAX_PREDICATE_DEPTH}`);
    expect(getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
  });

  test("rejects oversized aggregate nested strings before persistence", () => {
    const oversized = "🙂".repeat(Math.floor(PORTABLE_PRESET_FIELDS_MAX_BYTES / 4) + 1);

    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: { ...preset(), metadata: { oversized } },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow(`JSON strings must total at most ${PORTABLE_PRESET_FIELDS_MAX_BYTES}`);
    expect(getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
  });

  test("rejects malformed prompt blocks before persistence", () => {
    expect(() => parsePortablePresetRuntimeImportRequest({
      preset: { ...preset(), prompt_order: [{ ...promptBlock(0), content: { nested: true } }] },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow("must be a string");
    expect(() => parsePortablePresetRuntimeImportRequest({
      preset: { ...preset(), prompt_order: [{ ...promptBlock(0), authority: "unexpected" }] },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow("unknown prompt block field");
  });
  test("round-trips repeated Loom block IDs at distinct prompt-order occurrences through both imports", () => {
    const repeatedBlocks = [
      { ...promptBlock(0), id: "repeated", name: "Occurrence zero", content: "zero" },
      { ...promptBlock(1), id: "repeated", name: "Occurrence one", content: "one" },
    ];
    const directPreset = {
      ...preset(undefined, "Direct repeated occurrences"),
      prompt_order: repeatedBlocks,
    };

    const parsed = parsePortablePresetRuntimeImportRequest({
      preset: directPreset,
      agentRuntime: runtimeEnvelope(false),
    });
    expect(parsed.preset.prompt_order).toEqual(repeatedBlocks);

    const direct = importPortablePreset(USER_ID, directPreset);
    expect(direct.preset.prompt_order).toEqual(repeatedBlocks);
    expect(direct.preset.prompt_order.map((entry, promptOrder) => ({ blockId: entry.id, promptOrder }))).toEqual([
      { blockId: "repeated", promptOrder: 0 },
      { blockId: "repeated", promptOrder: 1 },
    ]);

    const runtime = importPortablePresetRuntime(USER_ID, {
      preset: { ...directPreset, name: "Runtime repeated occurrences" },
      agentRuntime: runtimeEnvelope(false),
    });
    expect(runtime.preset.prompt_order).toEqual(repeatedBlocks);
    expect(runtime.preset.prompt_order.map((entry, promptOrder) => ({ blockId: entry.id, promptOrder }))).toEqual([
      { blockId: "repeated", promptOrder: 0 },
      { blockId: "repeated", promptOrder: 1 },
    ]);
    expect(getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 2 });
  });
  test("rejects empty and malformed nested Loom prompt identities before either import persists", () => {
    const textVariable = (id: string, name: string): Record<string, unknown> => ({
      id,
      name,
      label: name,
      type: "text",
      defaultValue: "",
    });
    const firstBlock = promptBlock(0);
    const secondBlock = promptBlock(1);
    const invalidCases: Array<{ blocks: Record<string, unknown>[]; error: string }> = [
      {
        blocks: [{ ...firstBlock, id: "   " }, secondBlock],
        error: "must not be empty",
      },
      {
        blocks: [{
          ...firstBlock,
          variables: [
            textVariable("same-id", "tone"),
            textVariable(" same-id ", "voice"),
          ],
        }, secondBlock],
        error: "duplicate variable id",
      },
      {
        blocks: [{
          ...firstBlock,
          variables: [
            textVariable("tone-id", "same-name"),
            textVariable("voice-id", " same-name "),
          ],
        }, secondBlock],
        error: "duplicate variable name",
      },
    ];

    for (const invalid of invalidCases) {
      const invalidPreset = { ...preset(), prompt_order: invalid.blocks };
      expect(() => importPortablePreset(USER_ID, invalidPreset)).toThrow(invalid.error);
      expect(() => importPortablePresetRuntime(USER_ID, {
        preset: invalidPreset,
        agentRuntime: runtimeEnvelope(false),
      })).toThrow(invalid.error);
      expect(getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });
    }
  });
  test("accepts legacy prompt blocks without a name while validating supplied names", () => {
    const legacyBlock = { ...promptBlock(0) };
    delete legacyBlock.name;

    const parsed = parsePortablePresetRuntimeImportRequest({
      preset: { ...preset(), prompt_order: [legacyBlock] },
      agentRuntime: runtimeEnvelope(false),
    });
    expect(parsed.preset.prompt_order).toEqual([legacyBlock]);

    const imported = importPortablePresetRuntime(USER_ID, {
      preset: { ...preset(), prompt_order: [legacyBlock] },
      agentRuntime: runtimeEnvelope(false),
    });
    expect(imported.preset.prompt_order).toEqual([legacyBlock]);

    expect(() => parsePortablePresetRuntimeImportRequest({
      preset: { ...preset(), prompt_order: [{ ...legacyBlock, name: 42 }] },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow("preset.prompt_order[0].name: must be a string");
  });

  test("accepts ordinary Loom category snapshots with nested prompt definitions", () => {
    const blocks = nativeLoomPromptBlocks();
    const parsed = parsePortablePresetRuntimeImportRequest({
      preset: { ...preset(), prompt_order: blocks },
      agentRuntime: runtimeEnvelope(false),
    });
    expect(parsed.preset.prompt_order).toEqual(blocks);

    const imported = importPortablePresetRuntime(USER_ID, {
      preset: { ...preset(), prompt_order: blocks },
      agentRuntime: runtimeEnvelope(false),
    });
    expect(imported.preset.prompt_order).toEqual(blocks);
  });

  test("rejects malformed nested prompt definitions before persistence", () => {
    const blocks = nativeLoomPromptBlocks();
    const category = blocks[0]!;
    const variables = category.variables as Record<string, unknown>[];
    const malformedVariable = {
      ...category,
      variables: [{ ...variables[0], defaultValue: { forged: true } }],
    };
    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: { ...preset(), prompt_order: [malformedVariable] },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow("defaultValue");
    expect(getDb().query("SELECT COUNT(*) AS count FROM presets WHERE user_id = ?").get(USER_ID)).toEqual({ count: 0 });

    const unknownVariableField = {
      ...category,
      variables: [{ ...variables[0], authority: "unexpected" }],
    };
    expect(() => parsePortablePresetRuntimeImportRequest({
      preset: { ...preset(), prompt_order: [unknownVariableField] },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow("unknown nested prompt field");

    const child = blocks[1]!;
    const binding = child.placementBinding as Record<string, unknown>;
    const placementOptions = binding.options as Record<string, unknown>;
    const unknownPlacementField = {
      ...child,
      placementBinding: {
        ...binding,
        options: {
          ...placementOptions,
          concise: { ...(placementOptions.concise as Record<string, unknown>), authority: "unexpected" },
        },
      },
    };
    expect(() => parsePortablePresetRuntimeImportRequest({
      preset: { ...preset(), prompt_order: [category, unknownPlacementField] },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow("unknown nested prompt field");
  });

  test("bounds nested prompt option counts and JSON depth", () => {
    const blocks = nativeLoomPromptBlocks();
    const category = blocks[0]!;
    const variables = category.variables as Record<string, unknown>[];
    const selectVariable = variables.find((variable) => variable.type === "select")!;
    const overLimit = {
      ...category,
      variables: [{
        ...selectVariable,
        options: Array.from({ length: COGNITION_MAX_LIST_ITEMS + 1 }, (_, index) => ({
          id: `option-${index}`,
          label: `Option ${index}`,
          value: `value-${index}`,
        })),
        defaultValue: "option-0",
      }],
    };
    expect(() => parsePortablePresetRuntimeImportRequest({
      preset: { ...preset(), prompt_order: [overLimit] },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow(`must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);

    const boundedOptions = Array.from({ length: COGNITION_MAX_LIST_ITEMS }, (_, index) => ({
      id: `option-${index}`,
      label: `Option ${index}`,
      value: `value-${index}`,
    }));
    const bounded = parsePortablePresetRuntimeImportRequest({
      preset: {
        ...preset(),
        prompt_order: [{
          ...category,
          variables: [{ ...selectVariable, options: boundedOptions, defaultValue: "option-0" }],
        }],
      },
      agentRuntime: runtimeEnvelope(false),
    });
    const boundedPromptOrder = bounded.preset.prompt_order;
    if (boundedPromptOrder === undefined) throw new Error("bounded prompt order missing");
    expect((boundedPromptOrder[0] as Record<string, unknown>).variables).toHaveLength(1);

    let nested: unknown = "bounded";
    for (let index = 0; index < COGNITION_MAX_PREDICATE_DEPTH + 1; index += 1) nested = { child: nested };
    expect(() => parsePortablePresetRuntimeImportRequest({
      preset: {
        ...preset(),
        prompt_order: [{
          ...category,
          variables: [{ ...variables[0], defaultValue: nested }],
        }],
      },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow(`JSON nesting must be at most ${COGNITION_MAX_PREDICATE_DEPTH}`);
  });

  test("rejects high-cardinality prompt order values while accepting the exact list boundary", () => {
    expect(() => importPortablePresetRuntime(USER_ID, {
      preset: { ...preset(), prompt_order: Array.from({ length: COGNITION_MAX_LIST_ITEMS + 1 }, () => promptBlock(0)) },
      agentRuntime: runtimeEnvelope(false),
    })).toThrow(`must contain at most ${COGNITION_MAX_LIST_ITEMS} items`);

    const boundedOrder = Array.from({ length: COGNITION_MAX_LIST_ITEMS }, (_, index) => promptBlock(index));
    const imported = importPortablePresetRuntime(USER_ID, {
      preset: {
        ...preset(),
        parameters: Object.fromEntries(Array.from({ length: COGNITION_MAX_LIST_ITEMS }, (_, index) => [`key-${index}`, index])),
        prompt_order: boundedOrder,
        prompts: { system: "system" },
        metadata: { source: "bounded" },
      },
      agentRuntime: runtimeEnvelope(false),
    });
    expect(imported.preset.prompt_order).toEqual(boundedOrder);
    expect(imported.preset.parameters).toMatchObject({ "key-0": 0, [`key-${COGNITION_MAX_LIST_ITEMS - 1}`]: COGNITION_MAX_LIST_ITEMS - 1 });
    expect(imported.preset.prompts).toEqual({ system: "system" });
    expect(imported.preset.metadata).toEqual({ source: "bounded" });
  });
  test("bounds preset regex companion cardinality before the importer fan-out loop", () => {
    const overLimit = {
      ...preset(),
      regex_scripts: Array.from({ length: REGEX_LIMITS_V1.maxScripts + 1 }, () => ({})),
    };
    expect(() => parsePortablePresetRuntimeImportRequest({
      preset: overLimit,
      agentRuntime: runtimeEnvelope(false),
    })).toThrow(`must contain at most ${REGEX_LIMITS_V1.maxScripts} items`);

    const atLimit = parsePortablePresetRuntimeImportRequest({
      preset: {
        ...preset(),
        regex_scripts: Array.from({ length: REGEX_LIMITS_V1.maxScripts }, () => ({})),
      },
      agentRuntime: runtimeEnvelope(false),
    });
    expect(atLimit.preset.regex_scripts).toHaveLength(REGEX_LIMITS_V1.maxScripts);
  });

});

describe("portable cognition graph contracts", () => {
  test("quarantines and round-trips malformed legacy cognition without activation", () => {
    const legacyCognition = {
      version: 99,
      unsupported: ["repair", { enabled: false }],
    };
    const first = importPortablePresetRuntime(USER_ID, {
      preset: preset(),
      agentRuntime: runtimeEnvelopeWithLegacyCognition(legacyCognition),
    });

    expect(first.agent_config.runtimePolicy).toBeUndefined();
    expect(first.agent_config_review).toMatchObject({
      state: "repair_required",
      reasonCode: "cognition_invalid",
    });
    const exported = getPortablePresetRuntimeEnvelope(USER_ID, first.preset.id);
    expect(exported?.agentConfig?.cognitionPolicy).toEqual(legacyCognition);
    expect(exported?.agentConfig?.runtimePolicy).toBeUndefined();

    if (!exported) throw new Error("portable cognition fixture did not export");
    const second = importPortablePresetRuntime(USER_ID, {
      preset: preset(undefined, "Portable cognition copy"),
      agentRuntime: exported,
    });
    const reexported = getPortablePresetRuntimeEnvelope(USER_ID, second.preset.id);
    expect(reexported?.agentConfig?.cognitionPolicy).toEqual(legacyCognition);
    expect(reexported?.agentConfig?.runtimePolicy).toBeUndefined();
  });

  test("round-trips scalar and array legacy cognition values", () => {
    for (const legacyCognition of [null, false, 0, "", ["legacy", 1]]) {
      const result = importPortablePresetRuntime(USER_ID, {
        preset: preset(undefined, `Legacy ${String(legacyCognition)}`),
        agentRuntime: runtimeEnvelopeWithLegacyCognition(legacyCognition),
      });
      const exported = getPortablePresetRuntimeEnvelope(USER_ID, result.preset.id);
      expect(exported?.agentConfig?.cognitionPolicy).toEqual(legacyCognition);
    }
  });
  test("bounds zero-byte legacy cognition containers at the aggregate node limit", () => {
    const arrayAtLimit = balancedZeroByteJson(PORTABLE_JSON_MAX_NODES, false);
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithLegacyCognition(arrayAtLimit),
    )).not.toThrow();
    const arrayOverLimit = balancedZeroByteJson(PORTABLE_JSON_MAX_NODES + 1, false);
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithLegacyCognition(arrayOverLimit),
    )).toThrow(`JSON values must total at most ${PORTABLE_JSON_MAX_NODES}`);

    const objectAtLimit = balancedZeroByteJson(PORTABLE_JSON_MAX_NODES, true);
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithLegacyCognition(objectAtLimit),
    )).not.toThrow();
    const objectOverLimit = balancedZeroByteJson(PORTABLE_JSON_MAX_NODES + 1, true);
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithLegacyCognition(objectOverLimit),
    )).toThrow(`JSON values must total at most ${PORTABLE_JSON_MAX_NODES}`);
  });

  test("rejects array and object own properties instead of dropping repair data", () => {
    const cognition: unknown[] = [1];
    Object.defineProperty(cognition, "extra", { value: 2, enumerable: true });
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithLegacyCognition(cognition),
    )).toThrow("arrays must contain only indexed values");

    const hiddenObject = { value: 1 };
    Object.defineProperty(hiddenObject, "hidden", { value: 2, enumerable: false });
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithLegacyCognition(hiddenObject),
    )).toThrow("enumerable data property");

    const symbolObject = { value: 1 };
    Object.defineProperty(symbolObject, Symbol("extra"), { value: 2, enumerable: true });
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithLegacyCognition(symbolObject),
    )).toThrow("symbol keys");
  });

  test("rejects legacy cognition when canonical runtime policy also exists", () => {
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithLegacyCognition({ unsupported: true }, true),
    )).toThrow("AGENT_RUNTIME_PORTABLE_DUPLICATE_POLICY");
  });

  test("rejects duplicate, missing, cyclic, and unauthorized task graph references", () => {
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithTasks([taskTemplate("task_a"), taskTemplate("task_a")], ["task_a"]),
    )).toThrow("duplicate id");
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithTasks([taskTemplate("task_a", ["missing"])], ["task_a"]),
    )).toThrow("missing dependency");
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithTasks([
        taskTemplate("task_a", ["task_b"]),
        taskTemplate("task_b", ["task_a"]),
      ], ["task_a", "task_b"]),
    )).toThrow("dependency cycle");
    expect(() => parsePortablePresetRuntimeEnvelope(
      runtimeEnvelopeWithTasks([taskTemplate("task_a")], ["missing"]),
    )).toThrow("unknown task template");
  });
  test("shares the aggregate node budget across graph roots before parsing nested empties", () => {
    const atLimit = runtimeEnvelopeWithTasks(zeroBytePortableGraphTasks(false));
    expect(() => parsePortablePresetRuntimeEnvelope(atLimit)).not.toThrow();

    const overLimit = runtimeEnvelopeWithTasks(zeroBytePortableGraphTasks(true));
    expect(() => parsePortablePresetRuntimeEnvelope(overLimit))
      .toThrow(`graph values must total at most ${PORTABLE_JSON_MAX_NODES}`);
  });

  test("enforces the 256-item portable cognition graph caps", () => {
    const tasks = Array.from({ length: 257 }, (_, index) => taskTemplate(`task_${index}`));
    expect(() => parsePortablePresetRuntimeEnvelope(runtimeEnvelopeWithTasks(tasks, [])))
      .toThrow("must contain at most 256 items");
  });

  test("preserves explicit task policy subsets and empty selection", () => {
    const tasks = [taskTemplate("task_a"), taskTemplate("task_b")];
    const subset = parsePortablePresetRuntimeEnvelope(runtimeEnvelopeWithTasks(tasks, ["task_a"]));
    expect(subset.agentConfig?.taskPolicy).toEqual({ templateIds: ["task_a"] });
    expect(subset.taskTemplates).toHaveLength(2);

    const empty = parsePortablePresetRuntimeEnvelope(runtimeEnvelopeWithTasks(tasks, []));
    expect(empty.agentConfig?.taskPolicy).toEqual({ templateIds: [] });
    expect(empty.taskTemplates).toHaveLength(2);
  });
  test("fails portable export when persisted authored cognition has an invalid graph", () => {
    const result = importPortablePresetRuntime(USER_ID, {
      preset: preset(),
      agentRuntime: canonicalRuntimeEnvelope(),
    });
    const db = getDb();
    const row = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, result.preset.id) as { config_json: string };
    const authored = JSON.parse(row.config_json) as Record<string, unknown>;
    authored.taskTemplates = [taskTemplate("broken", ["missing"])];
    db.query(
      "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
    ).run(JSON.stringify(authored), USER_ID, result.preset.id);

    expect(() => getPortablePresetRuntimeEnvelope(USER_ID, result.preset.id))
      .toThrow("AGENT_RUNTIME_PORTABLE_COGNITION_INVALID");
  });

  test("exports empty optional cognition when no authored cognition is persisted", () => {
    const result = importPortablePresetRuntime(USER_ID, {
      preset: preset(),
      agentRuntime: runtimeEnvelope(false),
    });
    const db = getDb();
    const row = db.query(
      "SELECT config_json FROM preset_agent_configs WHERE user_id = ? AND preset_id = ?",
    ).get(USER_ID, result.preset.id) as { config_json: string };
    const authored = JSON.parse(row.config_json) as Record<string, unknown>;
    db.query(
      "UPDATE preset_agent_configs SET config_json = ? WHERE user_id = ? AND preset_id = ?",
    ).run(JSON.stringify({ config: authored.config }), USER_ID, result.preset.id);

    const exported = getPortablePresetRuntimeEnvelope(USER_ID, result.preset.id);
    expect(exported?.taskTemplates).toEqual([]);
  });
});

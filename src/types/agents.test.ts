import { describe, expect, test } from "bun:test";
import {
  AGENT_INVOCATION_DEFAULT,
  AGENT_TOOL_CALL_DEFAULT,
  parseLegacyAgentConfigV1,
  parseAgentConfigV2,
  parseAgentRuntimePolicyV1,
  parsePortableAgentConfigV1,
} from "./agents";
import {
  COGNITION_MAX_LIST_BYTES,
  COGNITION_MAX_LIST_ITEMS,
  COGNITION_MAX_PREDICATE_DEPTH,
  type LoomPolicySourceV1,
} from "./agent-cognition";

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    maxInvocations: AGENT_INVOCATION_DEFAULT,
    maxToolCalls: AGENT_TOOL_CALL_DEFAULT,
    mainToolIds: ["chat_search_history"],
    mainLoreScope: "active",
    profiles: [profile()],
    ...overrides,
  };
}
function loomSource(blockId: string, promptOrder = 0, blockRevision = 1): LoomPolicySourceV1 {
  return {
    kind: "loom_block",
    blockId,
    presetRevision: 7,
    blockRevision,
    promptOrder,
  };
}

function customPhase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: "draft",
    label: "Draft",
    instructionRefs: [loomSource("draft-instructions")],
    required: true,
    enter: { kind: "phase", value: "WORK" },
    exit: { kind: "phase", value: "WORK" },
    capabilityRequests: ["core_retrieval", "workspace_read"],
    repeatLimit: 2,
    nextPhaseIds: [],
    ...overrides,
  };
}

function runtimePolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    authority: "loom",
    scope: "preset",
    defaultMode: "agentic",
    loomPolicy: null,
    phases: [customPhase()],
    ...overrides,
  };
}

function v2Config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    agentsEnabled: true,
    allowedModes: ["response", "agentic"],
    defaultMode: "agentic",
    maxInvocations: 4,
    maxToolCalls: 4,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [],
    connectionSlots: [],
    ...overrides,
  };
}

function portableConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { version: _version, ...authored } = v2Config();
  return { portableVersion: 1, ...authored, ...overrides };
}

describe("agentConfig parser", () => {
  test("returns a defensive normalized copy at exact lower bounds", () => {
    const input = config();
    const parsed = parseLegacyAgentConfigV1(input);
    expect(parsed as unknown).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.profiles).not.toBe(input.profiles);
    expect(parsed.profiles[0]).not.toBe((input.profiles as unknown[])[0]);
  });

  test("normalizes legacy version-1 configs without authored limits", () => {
    const legacy = config();
    delete legacy.maxInvocations;
    delete legacy.maxToolCalls;
    expect(parseLegacyAgentConfigV1(legacy)).toMatchObject({
      maxInvocations: AGENT_INVOCATION_DEFAULT,
      maxToolCalls: AGENT_TOOL_CALL_DEFAULT,
    });
  });

  test("accepts whole-second timeouts beyond the prior cap and rejects invalid values", () => {
    expect(parseLegacyAgentConfigV1(config({
      profiles: [profile({ maxOutputTokens: 8_192, timeoutMs: 300_000 })],
    })).profiles[0]).toMatchObject({ maxOutputTokens: 8_192, timeoutMs: 300_000 });
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ maxOutputTokens: 63 })] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ timeoutMs: 4_000 })] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ timeoutMs: 5_500 })] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({
      profiles: [profile({ timeoutMs: Number.MAX_SAFE_INTEGER + 1 })],
    }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ maxOutputTokens: Number.NaN })] }))).toThrow();
  });

  test("measures system prompts in UTF-8 bytes", () => {
    const exact = "é".repeat(16_384);
    expect(new TextEncoder().encode(exact).byteLength).toBe(32 * 1024);
    expect(parseLegacyAgentConfigV1(config({
      profiles: [profile({ systemPrompt: exact })],
    })).profiles[0]?.systemPrompt).toBe(exact);

    const overByteLimit = "😀".repeat(8_193);
    expect(new TextEncoder().encode(overByteLimit).byteLength).toBeGreaterThan(32 * 1024);
    expect(() => parseLegacyAgentConfigV1(config({
      profiles: [profile({ systemPrompt: overByteLimit })],
    }))).toThrow("UTF-8 bytes");
  });

  test("counts profile name characters by Unicode code point", () => {
    expect(parseLegacyAgentConfigV1(config({ profiles: [profile({ name: "😀".repeat(80) })] })).profiles[0]?.name).toBe("😀".repeat(80));
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ name: "😀".repeat(81) })] }))).toThrow("characters");
  });

  test("rejects unknown keys and duplicate profile/tool IDs", () => {
    expect(() => parseLegacyAgentConfigV1({ ...config(), unexpected: true })).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile({ unexpected: true })] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ mainToolIds: ["chat_search_history", "chat_search_history"] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile(), profile({ id: "other" })] }))).not.toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: [profile(), profile()] }))).toThrow();
    expect(() => parseLegacyAgentConfigV1(config({ profiles: Array.from({ length: 17 }, (_, i) => profile({ id: `p_${i}` })) }))).toThrow();
  });
  test("parses only closed V2 config and rejects legacy/prototype-key authority", () => {
    const v2 = {
      version: 2,
      agentsEnabled: true,
      allowedModes: ["response", "agentic"],
      defaultMode: "agentic",
      maxInvocations: 4,
      maxToolCalls: 4,
      mainToolIds: [],
      mainLoreScope: "active",
      profiles: [],
      connectionSlots: [],
    } as const;
    expect(parseAgentConfigV2(v2)).toMatchObject({ version: 2, agentsEnabled: true });
    expect(() => parseAgentConfigV2({ ...v2, enabled: true })).toThrow();
    expect(() => parseAgentConfigV2({ ...v2, unexpected: true })).toThrow();
    const forged = JSON.parse(JSON.stringify({ ...v2, __proto__: { agentsEnabled: false } })) as Record<string, unknown>;
    Object.defineProperty(forged, "__proto__", { value: { agentsEnabled: false }, enumerable: true });
    expect(() => parseAgentConfigV2(forged)).toThrow(/unknown key/i);
  });

  test("accepts only finite safe authored limits at or above the minimum", () => {
    for (const field of ["maxInvocations", "maxToolCalls"] as const) {
      expect(parseLegacyAgentConfigV1(config({ [field]: 1 }))[field]).toBe(1);
      expect(parseLegacyAgentConfigV1(config({ [field]: Number.MAX_SAFE_INTEGER }))[field])
        .toBe(Number.MAX_SAFE_INTEGER);
      for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "64", null]) {
        expect(() => parseLegacyAgentConfigV1(config({ [field]: value }))).toThrow();
      }
    }
  });
});

describe("portable legacy cognition repair carrier", () => {
  test("preserves bounded JSON without projecting it into runtime policy", () => {
    const cognitionPolicy = {
      legacy: ["repair", { enabled: false }],
      scalar: "é",
    };
    const parsed = parsePortableAgentConfigV1(portableConfig({ cognitionPolicy }));
    expect(parsed.cognitionPolicy).toBe(cognitionPolicy);
    expect(parsed.runtimePolicy).toBeUndefined();
  });

  test("rejects canonical runtime coexistence and non-JSON or unbounded values", () => {
    expect(() => parsePortableAgentConfigV1(portableConfig({
      runtimePolicy: runtimePolicy(),
      cognitionPolicy: {},
    }))).toThrow("cannot accompany runtimePolicy");

    for (const cognitionPolicy of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Symbol("unsupported"),
      BigInt(1),
      () => true,
      new Date(),
    ]) {
      expect(() => parsePortableAgentConfigV1(portableConfig({ cognitionPolicy }))).toThrow();
    }

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => parsePortableAgentConfigV1(portableConfig({ cognitionPolicy: cycle }))).toThrow("cycle");

    const sparse = new Array(1);
    expect(() => parsePortableAgentConfigV1(portableConfig({ cognitionPolicy: sparse }))).toThrow();

    let nested: unknown = "leaf";
    for (let index = 0; index <= COGNITION_MAX_PREDICATE_DEPTH; index += 1) nested = { nested };
    expect(() => parsePortableAgentConfigV1(portableConfig({ cognitionPolicy: nested }))).toThrow("levels deep");
    expect(() => parsePortableAgentConfigV1(portableConfig({
      cognitionPolicy: Array.from({ length: COGNITION_MAX_LIST_ITEMS + 1 }, () => null),
    }))).toThrow("at most");
    expect(() => parsePortableAgentConfigV1(portableConfig({
      cognitionPolicy: "x".repeat(COGNITION_MAX_LIST_BYTES),
    }))).toThrow("JSON");
  });
});

describe("canonical custom Phased Instructions policy parser", () => {
  test("preserves ordered, source-pinned phases and keeps the four Loom buckets separate", () => {
    const parsed = parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [
        customPhase({
          id: "first",
          label: "First",
          instructionRefs: [
            loomSource("later", 3, 4),
            loomSource("earlier", 1, 2),
          ],
          nextPhaseIds: ["second"],
        }),
        customPhase({
          id: "second",
          label: "Second",
          instructionRefs: [loomSource("second-instructions", 4, 1)],
          capabilityRequests: ["delegation", "cortex"],
          repeatLimit: 4,
        }),
      ],
    }));
    expect(parsed.phases.map((phase) => phase.id)).toEqual(["first", "second"]);
    expect(parsed.phases[0]).toMatchObject({
      version: 1,
      label: "First",
      required: true,
      repeatLimit: 2,
      capabilityRequests: ["core_retrieval", "workspace_read"],
      nextPhaseIds: ["second"],
    });
    expect(parsed.phases[0]?.instructionRefs ?? []).toEqual([
      loomSource("later", 3, 4),
      loomSource("earlier", 1, 2),
    ]);
    expect(parsed.phases[1]?.capabilityRequests).toEqual(["delegation", "cortex"]);
    expect(parsed.loomPolicy).toBeNull();
    expect(Object.hasOwn(parsed as object, "phasePolicy")).toBe(false);
  });

  test("rejects duplicate or invalid phase IDs, closed-capability violations, and repeat widening", () => {
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase(), customPhase({ id: "draft" })],
    }))).toThrow(/duplicate|unique/i);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ id: "Draft" })],
    }))).toThrow();
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ capabilityRequests: ["network"] })],
    }))).toThrow();
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ capabilityRequests: ["core_retrieval", "core_retrieval"] })],
    }))).toThrow(/unique|sorted/i);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ repeatLimit: 5 })],
    }))).toThrow(/repeat|4/i);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({
        enter: { kind: "script", source: "return true" },
      })],
    }))).toThrow();
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ nextPhaseIds: ["missing"] })],
    }))).toThrow(/next|phase|reference/i);
  });
  test("requires the canonical phase keys rather than legacy aliases", () => {
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({
        instructions: [loomSource("legacy-instructions")],
      })],
    }))).toThrow(/unknown|instructionRefs/i);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({
        allowedCapabilities: ["core_retrieval"],
      })],
    }))).toThrow(/unknown|capabilityRequests/i);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({
        version: 2,
      })],
    }))).toThrow(/version/i);
  });


  test("permits only self or the immediate next ordered phase as a transition target", () => {
    const immediate = runtimePolicy({
      phases: [
        customPhase({ id: "one", nextPhaseIds: ["one", "two"] }),
        customPhase({ id: "two", nextPhaseIds: ["two", "three"] }),
        customPhase({ id: "three", nextPhaseIds: ["three"] }),
      ],
    });
    expect(parseAgentRuntimePolicyV1(immediate).phases.map((phase) => phase.nextPhaseIds)).toEqual([
      ["one", "two"],
      ["two", "three"],
      ["three"],
    ]);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [
        customPhase({ id: "one", nextPhaseIds: ["three"] }),
        customPhase({ id: "two" }),
        customPhase({ id: "three" }),
      ],
    }))).toThrow(/next|order|adjacent/i);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ nextPhaseIds: ["draft"], repeatLimit: 0 })],
    }))).toThrow(/self|repeat/i);
  });
  test("enforces the host bound on authored custom phase count", () => {
    const atLimit = Array.from({ length: 64 }, (_, index) => customPhase({
      id: `phase_${index}`,
      label: `Phase ${index}`,
      instructionRefs: [loomSource(`phase-${index}`)],
    }));
    expect(parseAgentRuntimePolicyV1(runtimePolicy({ phases: atLimit })).phases).toHaveLength(64);

    const overLimit = [...atLimit, customPhase({
      id: "phase_64",
      label: "Phase 64",
      instructionRefs: [loomSource("phase-64")],
    })];
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({ phases: overLimit }))).toThrow(/64|phase|limit/i);
  });

  test("enforces the host bound on instruction references within one custom phase", () => {
    const atLimit = Array.from({ length: 64 }, (_, index) =>
      loomSource(`instruction-${index}`, index, index + 1));
    expect(parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ instructionRefs: atLimit })],
    })).phases[0]?.instructionRefs).toHaveLength(64);

    const overLimit = [...atLimit, loomSource("instruction-64", 64, 65)];
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ instructionRefs: overLimit })],
    }))).toThrow(/64|instruction|limit/i);
  });
  test("requires promptOrder and deduplicates only exact instruction occurrences", () => {
    const repeatedId = [loomSource("shared", 0), loomSource("shared", 1)];
    expect(parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ instructionRefs: repeatedId })],
    })).phases[0]?.instructionRefs).toEqual(repeatedId);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ instructionRefs: [repeatedId[0], repeatedId[0]] })],
    }))).toThrow(/duplicate|instructionRefs/i);
    const { promptOrder: _promptOrder, ...missingPromptOrder } = loomSource("shared", 0);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phases: [customPhase({ instructionRefs: [missingPromptOrder] })],
    }))).toThrow(/promptOrder/i);
  });

  test("counts repeated block IDs at different prompt orders toward the aggregate source ceiling", () => {
    const loomBlockId = "loom-policy-source";
    const policyEntry = (id: string, promptOrder: number) => ({
      version: 1,
      id,
      source: loomSource(loomBlockId, promptOrder),
      destination: "root_work",
      checkpoint: "WORK",
      required: true,
      visibility: "work_only",
    });
    const loomPolicy = {
      version: 1,
      workPolicy: [policyEntry("policy-source-zero", 0), policyEntry("policy-source-one", 1)],
      workspaceUsage: [],
      completionCriteria: [],
      renderPolicy: [],
    };
    const phaseDefinitions = (includeExtraSource: boolean) => Array.from({ length: 64 }, (_, phaseIndex) =>
      customPhase({
        id: `phase_${phaseIndex}`,
        label: `Phase ${phaseIndex}`,
        instructionRefs: Array.from(
          { length: phaseIndex === 0 ? (includeExtraSource ? 8 : 7) : 8 },
          (_, refIndex) => loomSource(
            phaseIndex === 0 && refIndex === 0 ? loomBlockId : `phase-${phaseIndex}-${refIndex}`,
            refIndex,
            refIndex + 1,
          ),
        ),
      }));
    expect(parseAgentRuntimePolicyV1(runtimePolicy({
      loomPolicy,
      phases: phaseDefinitions(false),
    })).phases).toHaveLength(64);
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      loomPolicy,
      phases: phaseDefinitions(true),
    }))).toThrow(/512|source|limit/i);
  });



  test("rejects phasePolicy as an unknown public live-config field", () => {
    const phasePolicy = {
      work: [{
        blockId: "legacy-work",
        expectedPresetRevision: 7,
        expectedBlockRevision: 3,
      }],
      render: [{
        blockId: "legacy-render",
        expectedPresetRevision: 7,
        expectedBlockRevision: 5,
      }],
    };
    expect(() => parseAgentConfigV2(v2Config({ phasePolicy })))
      .toThrow(/phasePolicy.*unknown key/i);
    expect(() => parsePortableAgentConfigV1(portableConfig({ phasePolicy })))
      .toThrow(/phasePolicy.*unknown key/i);
  });

  test("does not accept a hidden fifth bucket in canonical runtime policy", () => {
    expect(() => parseAgentRuntimePolicyV1(runtimePolicy({
      phasePolicy: { work: [], render: [] },
    }))).toThrow(/unknown|phasePolicy/i);
  });
});

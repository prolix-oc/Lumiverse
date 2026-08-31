import { describe, expect, test } from "bun:test";
import { AGENT_TOOL_CALL_DEFAULT, AGENT_INVOCATION_DEFAULT, parseAgentConfigV2 } from "../types/agents";
import {
  AGENT_HOST_DEFAULT_LIMITS,
  AGENT_HOST_LIMIT_ENV,
  AGENT_RUNTIME_HOST_LIMITS,
  getAgentRuntimeHostLimits,
  parseAgentRuntimeHostLimits,
  validateAgentConfigForExecution,
} from "./agent-runtime-limits";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    agentsEnabled: true,
    allowedModes: ["response"],
    defaultMode: "response",
    maxInvocations: AGENT_INVOCATION_DEFAULT,
    maxToolCalls: AGENT_TOOL_CALL_DEFAULT,
    mainToolIds: [],
    mainLoreScope: "active",
    profiles: [],
    connectionSlots: [],
    ...overrides,
  };
}

describe("agent runtime host limits", () => {
  test("uses the documented defaults and parses every operator setting", () => {
    expect(AGENT_HOST_DEFAULT_LIMITS).toEqual({
      childAdmissions: 1_024,
      aggregateToolCalls: 1_024,
      logicalProviderRequests: 2_048,
      physicalDispatchAttempts: 4_096,
      childOutputTokens: 1_048_576,
      workAttemptOutputTokens: 1_048_576,
      workAttemptProviderDispatches: 256,
      workAttemptUnsignedBoundaries: 256,
      workAttemptToolCalls: 1_024,
      workAttemptWorkspaceOperations: 1_024,
      workSegmentOutputTokens: 262_144,
      workSegmentProviderDispatches: 64,
      workSegmentUnsignedBoundaries: 64,
      workSegmentToolCalls: 256,
      workSegmentWorkspaceOperations: 256,
      workDispatchOutputTokens: 65_536,
      workRecoveryReserveOutputTokens: 65_536,
      workFuturePhaseReserveOutputTokens: 262_144,
      rootWallClockMs: 3_600_000,
      activityEvents: 512,
      activityBytes: 512 * 1024,
      lifecycleLogRecords: 512,
      activeRootsPerUser: 2,
      activeRootsProcess: 16,
      providerDispatchesPerUser: 4,
      providerDispatchesProcess: 16,
      toolExecutionsPerUser: 8,
      toolExecutionsProcess: 32,
    });

    const environment = Object.fromEntries(
      Object.keys(AGENT_HOST_LIMIT_ENV).map((key, index) => [
        AGENT_HOST_LIMIT_ENV[key as keyof typeof AGENT_HOST_LIMIT_ENV],
        String(index + 1),
      ]),
    );
    const parsed = parseAgentRuntimeHostLimits(environment);
    expect(parsed.childAdmissions).toBe(1);
    expect(parsed.aggregateToolCalls).toBe(2);
    expect(parsed.workAttemptOutputTokens).toBe(6);
    expect(parsed.workFuturePhaseReserveOutputTokens).toBe(18);
    expect(parsed.lifecycleLogRecords).toBe(22);
    expect(parsed.toolExecutionsProcess).toBe(28);
  });

  test("falls back for malformed, non-positive, fractional, and unsafe values", () => {
    const environment = {
      [AGENT_HOST_LIMIT_ENV.childAdmissions]: "0",
      [AGENT_HOST_LIMIT_ENV.aggregateToolCalls]: "nope",
      [AGENT_HOST_LIMIT_ENV.logicalProviderRequests]: "1.5",
      [AGENT_HOST_LIMIT_ENV.physicalDispatchAttempts]: "12junk",
      [AGENT_HOST_LIMIT_ENV.childOutputTokens]: String(Number.MAX_SAFE_INTEGER + 1),
      [AGENT_HOST_LIMIT_ENV.rootWallClockMs]: " 2048 ",
    };
    const parsed = parseAgentRuntimeHostLimits(environment);
    expect(parsed.childAdmissions).toBe(AGENT_HOST_DEFAULT_LIMITS.childAdmissions);
    expect(parsed.aggregateToolCalls).toBe(AGENT_HOST_DEFAULT_LIMITS.aggregateToolCalls);
    expect(parsed.logicalProviderRequests).toBe(AGENT_HOST_DEFAULT_LIMITS.logicalProviderRequests);
    expect(parsed.physicalDispatchAttempts).toBe(AGENT_HOST_DEFAULT_LIMITS.physicalDispatchAttempts);
    expect(parsed.childOutputTokens).toBe(AGENT_HOST_DEFAULT_LIMITS.childOutputTokens);
    expect(parsed.rootWallClockMs).toBe(2_048);
  });

  test("parses authored values portably, then rejects only at execution host validation", () => {
    const parsed = parseAgentConfigV2(config({ maxInvocations: 8, maxToolCalls: 9 }));
    const validation = validateAgentConfigForExecution(parsed, {
      ...AGENT_HOST_DEFAULT_LIMITS,
      childAdmissions: 4,
      aggregateToolCalls: 5,
    });
    expect(parsed.maxInvocations).toBe(8);
    expect(parsed.maxToolCalls).toBe(9);
    expect(validation.executable).toBe(false);
    expect(validation.issues).toEqual([
      {
        code: "host_child_admission_limit_exceeded",
        field: "maxInvocations",
        authored: 8,
        limit: 4,
      },
      {
        code: "host_tool_call_limit_exceeded",
        field: "maxToolCalls",
        authored: 9,
        limit: 5,
      },
    ]);
  });

  test("effective limits are parsed once and exposed immutably", () => {
    expect(getAgentRuntimeHostLimits()).toBe(AGENT_RUNTIME_HOST_LIMITS);
  });
});

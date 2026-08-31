import type { AgentConfigV2 } from "../types/agents";
import type { AgentRuntimeHostLimits } from "../types/agent-runtime";

/** Process settings are read once at module load; presets cannot raise these ceilings. */
export const AGENT_HOST_LIMIT_ENV = {
  childAdmissions: "LUMIVERSE_AGENT_HOST_CHILD_ADMISSIONS",
  aggregateToolCalls: "LUMIVERSE_AGENT_HOST_AGGREGATE_TOOL_CALLS",
  logicalProviderRequests: "LUMIVERSE_AGENT_HOST_LOGICAL_PROVIDER_REQUESTS",
  physicalDispatchAttempts: "LUMIVERSE_AGENT_HOST_PHYSICAL_DISPATCH_ATTEMPTS",
  childOutputTokens: "LUMIVERSE_AGENT_HOST_CHILD_OUTPUT_TOKENS",
  workAttemptOutputTokens: "LUMIVERSE_AGENT_HOST_WORK_ATTEMPT_OUTPUT_TOKENS",
  workAttemptProviderDispatches: "LUMIVERSE_AGENT_HOST_WORK_ATTEMPT_PROVIDER_DISPATCHES",
  workAttemptUnsignedBoundaries: "LUMIVERSE_AGENT_HOST_WORK_ATTEMPT_UNSIGNED_BOUNDARIES",
  workAttemptToolCalls: "LUMIVERSE_AGENT_HOST_WORK_ATTEMPT_TOOL_CALLS",
  workAttemptWorkspaceOperations: "LUMIVERSE_AGENT_HOST_WORK_ATTEMPT_WORKSPACE_OPERATIONS",
  workSegmentOutputTokens: "LUMIVERSE_AGENT_HOST_WORK_SEGMENT_OUTPUT_TOKENS",
  workSegmentProviderDispatches: "LUMIVERSE_AGENT_HOST_WORK_SEGMENT_PROVIDER_DISPATCHES",
  workSegmentUnsignedBoundaries: "LUMIVERSE_AGENT_HOST_WORK_SEGMENT_UNSIGNED_BOUNDARIES",
  workSegmentToolCalls: "LUMIVERSE_AGENT_HOST_WORK_SEGMENT_TOOL_CALLS",
  workSegmentWorkspaceOperations: "LUMIVERSE_AGENT_HOST_WORK_SEGMENT_WORKSPACE_OPERATIONS",
  workDispatchOutputTokens: "LUMIVERSE_AGENT_HOST_WORK_DISPATCH_OUTPUT_TOKENS",
  workRecoveryReserveOutputTokens: "LUMIVERSE_AGENT_HOST_WORK_RECOVERY_RESERVE_OUTPUT_TOKENS",
  workFuturePhaseReserveOutputTokens: "LUMIVERSE_AGENT_HOST_WORK_FUTURE_PHASE_RESERVE_OUTPUT_TOKENS",
  rootWallClockMs: "LUMIVERSE_AGENT_HOST_ROOT_WALL_CLOCK_MS",
  activityEvents: "LUMIVERSE_AGENT_HOST_ACTIVITY_EVENTS",
  activityBytes: "LUMIVERSE_AGENT_HOST_ACTIVITY_BYTES",
  lifecycleLogRecords: "LUMIVERSE_AGENT_HOST_LIFECYCLE_LOG_RECORDS",
  activeRootsPerUser: "LUMIVERSE_AGENT_HOST_ACTIVE_ROOTS_PER_USER",
  activeRootsProcess: "LUMIVERSE_AGENT_HOST_ACTIVE_ROOTS_PROCESS",
  providerDispatchesPerUser: "LUMIVERSE_AGENT_HOST_PROVIDER_DISPATCHES_PER_USER",
  providerDispatchesProcess: "LUMIVERSE_AGENT_HOST_PROVIDER_DISPATCHES_PROCESS",
  toolExecutionsPerUser: "LUMIVERSE_AGENT_HOST_TOOL_EXECUTIONS_PER_USER",
  toolExecutionsProcess: "LUMIVERSE_AGENT_HOST_TOOL_EXECUTIONS_PROCESS",
} as const satisfies Readonly<Record<keyof AgentRuntimeHostLimits, string>>;

export const AGENT_HOST_DEFAULT_LIMITS: AgentRuntimeHostLimits = Object.freeze({
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

const POSITIVE_DECIMAL_INTEGER = /^[1-9][0-9]*$/;

type AgentRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function parsePositiveSafeInteger(raw: string | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  if (!POSITIVE_DECIMAL_INTEGER.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Parse host settings without coercing malformed values or accepting unsafe integers. */
export function parseAgentRuntimeHostLimits(
  environment: AgentRuntimeEnvironment = process.env,
): AgentRuntimeHostLimits {
  const parsed = {} as Record<keyof AgentRuntimeHostLimits, number>;
  for (const key of Object.keys(AGENT_HOST_LIMIT_ENV) as Array<keyof AgentRuntimeHostLimits>) {
    const envName = AGENT_HOST_LIMIT_ENV[key];
    parsed[key] = parsePositiveSafeInteger(environment[envName], AGENT_HOST_DEFAULT_LIMITS[key]);
  }
  return Object.freeze(parsed) as AgentRuntimeHostLimits;
}

/** The immutable effective limits for this server process. */
export const AGENT_RUNTIME_HOST_LIMITS: AgentRuntimeHostLimits = parseAgentRuntimeHostLimits();

export function getAgentRuntimeHostLimits(): AgentRuntimeHostLimits {
  return AGENT_RUNTIME_HOST_LIMITS;
}

export type AgentConfigExecutionIssueCode =
  | "host_child_admission_limit_exceeded"
  | "host_tool_call_limit_exceeded";

export interface AgentConfigExecutionIssue {
  readonly code: AgentConfigExecutionIssueCode;
  readonly field: "maxInvocations" | "maxToolCalls";
  readonly authored: number;
  readonly limit: number;
}

export interface AgentConfigExecutionValidation {
  readonly executable: boolean;
  readonly issues: readonly AgentConfigExecutionIssue[];
}

/**
 * Compare authored values with this host's ceilings without changing the
 * portable config. Structural parsing intentionally remains host-independent.
 */
export function validateAgentConfigForExecution(
  config: Pick<AgentConfigV2, "maxInvocations" | "maxToolCalls">,
  limits: AgentRuntimeHostLimits = AGENT_RUNTIME_HOST_LIMITS,
): AgentConfigExecutionValidation {
  const issues: AgentConfigExecutionIssue[] = [];
  if (config.maxInvocations > limits.childAdmissions) {
    issues.push({
      code: "host_child_admission_limit_exceeded",
      field: "maxInvocations",
      authored: config.maxInvocations,
      limit: limits.childAdmissions,
    });
  }
  if (config.maxToolCalls > limits.aggregateToolCalls) {
    issues.push({
      code: "host_tool_call_limit_exceeded",
      field: "maxToolCalls",
      authored: config.maxToolCalls,
      limit: limits.aggregateToolCalls,
    });
  }
  return Object.freeze({
    executable: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

export class AgentHostLimitValidationError extends Error {
  readonly code = "AGENT_HOST_LIMIT_EXCEEDED" as const;
  readonly validation: AgentConfigExecutionValidation;

  constructor(validation: AgentConfigExecutionValidation) {
    super("agentConfig exceeds the effective host runtime limit");
    this.name = "AgentHostLimitValidationError";
    this.validation = validation;
  }
}

/** Throw the explicit execution-time validation failure while preserving authored data. */
export function assertAgentConfigWithinHostLimits(
  config: Pick<AgentConfigV2, "maxInvocations" | "maxToolCalls">,
  limits: AgentRuntimeHostLimits = AGENT_RUNTIME_HOST_LIMITS,
): void {
  const validation = validateAgentConfigForExecution(config, limits);
  if (!validation.executable) throw new AgentHostLimitValidationError(validation);
}

export type { AgentRuntimeHostLimits } from "../types/agent-runtime";

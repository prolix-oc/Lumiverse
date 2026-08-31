import type { AgentActivityEvent, AgentAuthorizationSnapshot, AgentConfigV2, AgentUsage } from "../types/agents";
import type {
  AgentActivityLifecycle,
  AgentActivityNodeV1,
  AgentActivitySnapshotV1,
  AgentActivityToolId,
  AgentActivityUsageV1,
  AgentLedgerCounters,
  AgentLedgerReservation,
  AgentPublicBudgetContext,
  AgentPublicBudgetId,
  AgentPublicErrorCode,
  AgentRuntimeHostLimits,
  AgentTerminalReason,
  AgentTurnLedger as AgentTurnLedgerContract,
} from "../types/agent-runtime";
import { PUBLIC_ACTIVITY_TOOL_IDS } from "../types/agent-runtime";
import type {
  AgentAdmissionFailureContext,
  AgentAdmissionKind,
} from "./agent-runtime-admission";
import {
  AgentAdmissionPermit,
  AgentRuntimeAdmissionManager,
  AGENT_RUNTIME_ADMISSION_MANAGER,
} from "./agent-runtime-admission";
import { getAgentRuntimeHostLimits } from "./agent-runtime-limits";
import { AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES, AGENT_CONTINUATION_FRAME_MAX_BYTES, AGENT_INITIAL_INPUT_MAX_BYTES, AGENT_RETAINED_DATA_MAX_BYTES, AGENT_SERIALIZED_VALUE_MAX_BYTES } from "./agent-runtime-accounting";

export const AGENT_LEDGER_MAX_DELAY_MS = 2_147_483_647;
export interface AgentLedgerTimeoutScheduler { setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>; clearTimeout(handle: ReturnType<typeof setTimeout>): void; }
export interface AgentTurnLedgerOptions { readonly generationId: string; readonly config: AgentConfigV2; readonly authorization: AgentAuthorizationSnapshot; readonly userId?: string; readonly limits?: AgentRuntimeHostLimits; readonly admission?: AgentRuntimeAdmissionManager; readonly signal?: AbortSignal; readonly timeoutScheduler?: AgentLedgerTimeoutScheduler; readonly now?: () => number; }
export interface AgentLedgerCapacityContext {
  readonly kind: AgentAdmissionKind;
  readonly scope: "user" | "process";
  readonly userId: string;
  readonly userLimit: number;
  readonly processLimit: number;
  readonly userObserved: number;
  readonly processObserved: number;
}
export interface AgentLedgerFailureContext extends AgentPublicBudgetContext {
  readonly code: AgentPublicErrorCode;
  readonly admission?: AgentLedgerCapacityContext;
}
type AgentLedgerFailureDetails = {
  readonly id?: AgentPublicBudgetContext["id"];
  readonly admission?: AgentLedgerCapacityContext;
};
export class AgentLedgerFailure extends Error {
  readonly code: AgentPublicErrorCode;
  readonly budget: AgentPublicBudgetId;
  readonly limit: number;
  readonly observed: number;
  readonly context: AgentLedgerFailureContext;
  constructor(
    code: AgentPublicErrorCode,
    budget: AgentPublicBudgetId,
    limit: number,
    observed: number,
    details?: AgentLedgerFailureDetails,
  ) {
    super(`${code}: ${budget} ${observed}/${limit}`);
    this.name = "AgentLedgerFailure";
    this.code = code;
    this.budget = budget;
    this.limit = limit;
    this.observed = observed;
    this.context = Object.freeze({
      code,
      id: details?.id ?? budget,
      limit,
      observed,
      ...(details?.admission ? { admission: details.admission } : {}),
    });
  }
}

type MutableBudgetCounts = Record<AgentPublicBudgetId, number>;
const ALL_BUDGETS: readonly AgentPublicBudgetId[] = ["child_admissions", "aggregate_tool_calls", "logical_provider_requests", "physical_dispatch_attempts", "child_output_tokens", "root_wall_clock_ms", "activity_events", "activity_bytes", "lifecycle_log_records", "initial_input_bytes", "argument_bytes", "result_bytes", "continuation_bytes", "retained_output_bytes", "materialized_bytes", "context_tokens"];
const EMPTY_COUNTS = (): MutableBudgetCounts => Object.fromEntries(ALL_BUDGETS.map((budget) => [budget, 0])) as MutableBudgetCounts;
const TECHNICAL_LIMITS: Readonly<Partial<Record<AgentPublicBudgetId, number>>> = Object.freeze({ initial_input_bytes: AGENT_INITIAL_INPUT_MAX_BYTES, argument_bytes: AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES, result_bytes: AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES, continuation_bytes: AGENT_CONTINUATION_FRAME_MAX_BYTES, retained_output_bytes: AGENT_RETAINED_DATA_MAX_BYTES, materialized_bytes: AGENT_SERIALIZED_VALUE_MAX_BYTES });
function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T { if (value === null || typeof value !== "object" || seen.has(value)) return value; seen.add(value); if (Array.isArray(value)) for (const item of value) freezeDeep(item, seen); else for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen); return Object.freeze(value); }
function cloneAndFreeze<T>(value: T): T { const clone = typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)); return freezeDeep(clone); }
const ACTIVITY_NODE_LIMIT = 128;
const ACTIVITY_BYTES_LIMIT = 64 * 1024;
const ACTIVITY_LIFECYCLES = new Set<AgentActivityLifecycle>([
  "queued", "running", "completed", "failed", "cancelled", "timed_out",
]);
const ACTIVITY_TERMINAL_LIFECYCLES = new Set<AgentActivityLifecycle>([
  "completed", "failed", "cancelled", "timed_out",
]);
const ACTIVITY_NODE_KINDS = new Set<AgentActivityNodeV1["kind"]>([
  "root_turn", "provider_round", "child_invocation", "tool_attempt",
]);
const ACTIVITY_ACTORS = new Set<AgentActivityNodeV1["actor"]>([
  "root", "provider", "child", "tool",
]);
const ACTIVITY_TOOL_IDS = new Set<AgentActivityToolId>(PUBLIC_ACTIVITY_TOOL_IDS);
const ACTIVITY_ERROR_CODES = new Set<AgentPublicErrorCode>([
  "capacity_exceeded", "host_child_admission_limit_exceeded", "host_tool_call_limit_exceeded",
  "child_admission_limit_exceeded", "tool_call_limit_exceeded",
  "logical_provider_request_limit_exceeded", "physical_dispatch_attempt_limit_exceeded",
  "child_output_token_limit_exceeded", "root_wall_clock_limit_exceeded",
  "activity_event_limit_exceeded", "activity_byte_limit_exceeded",
  "lifecycle_log_record_limit_exceeded", "context_limit_exceeded",
  "initial_input_limit_exceeded", "argument_limit_exceeded", "result_limit_exceeded",
  "continuation_limit_exceeded", "retained_output_limit_exceeded", "materialized_limit_exceeded",
  "timeout", "cancelled", "provider_unavailable", "provider_unsupported",
  "provider_tool_calling_unsupported", "provider_tool_continuation_unsupported",
  "provider_tool_finalization_unsupported",
  "provider_request_error", "provider_protocol_error", "provider_schema_error",
  "invalid_task", "invalid_profile", "invalid_arguments", "batch_rejected",
  "unknown_tool", "unauthorized", "integrity_error", "internal_error",
  "child_required_failed", "child_output_limit_exceeded", "agentic_protocol_failure",
]);
function activityNodeBytes(node: AgentActivityNodeV1): number {
  return new TextEncoder().encode(JSON.stringify(node)).byteLength;
}
function activityUsage(): AgentActivityUsageV1 {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    childInvocations: 0,
  };
}
function budgetCode(
  budget: AgentPublicBudgetId,
  authored: number,
  host: number,
): AgentPublicErrorCode {
  if (budget === "child_admissions") {
    return authored <= host
      ? "child_admission_limit_exceeded"
      : ("host_child_admission_limit_exceeded" as AgentPublicErrorCode);
  }
  if (budget === "aggregate_tool_calls") {
    return authored <= host
      ? "tool_call_limit_exceeded"
      : ("host_tool_call_limit_exceeded" as AgentPublicErrorCode);
  }
  if (budget === "logical_provider_requests") return "logical_provider_request_limit_exceeded";
  if (budget === "physical_dispatch_attempts") return "physical_dispatch_attempt_limit_exceeded";
  if (budget === "child_output_tokens") return "child_output_token_limit_exceeded";
  if (budget === "root_wall_clock_ms") return "root_wall_clock_limit_exceeded";
  if (budget === "activity_events") return "activity_event_limit_exceeded";
  if (budget === "activity_bytes") return "activity_byte_limit_exceeded";
  if (budget === "lifecycle_log_records") return "lifecycle_log_record_limit_exceeded";
  if (budget === "initial_input_bytes") return "initial_input_limit_exceeded";
  if (budget === "argument_bytes") return "argument_limit_exceeded";
  if (budget === "result_bytes") return "result_limit_exceeded";
  if (budget === "continuation_bytes") return "continuation_limit_exceeded";
  if (budget === "retained_output_bytes") return "retained_output_limit_exceeded";
  if (budget === "materialized_bytes") return "materialized_limit_exceeded";
  return "context_limit_exceeded";
}
function admissionFailureDetails(
  context: AgentAdmissionFailureContext,
): AgentLedgerFailureDetails {
  const scope = context.userObserved >= context.userLimit ? "user" : "process";
  const id =
    context.kind === "root"
      ? scope === "user"
        ? "active_roots_per_user"
        : "active_roots_process"
      : context.kind === "provider"
        ? scope === "user"
          ? "provider_dispatches_per_user"
          : "provider_dispatches_process"
        : scope === "user"
          ? "tool_executions_per_user"
          : "tool_executions_process";
  return {
    id,
    admission: {
      ...context,
      scope,
    },
  };
}

function defaultScheduler(): AgentLedgerTimeoutScheduler { return { setTimeout: (callback, delayMs) => setTimeout(callback, delayMs), clearTimeout: (handle) => clearTimeout(handle) }; }

class LedgerReservation implements AgentLedgerReservation {
  readonly id: string; readonly budget: AgentPublicBudgetId; readonly amount: number; readonly #ledger: AgentTurnLedger; #state: "reserved" | "consumed" | "released" = "reserved";
  constructor(id: string, budget: AgentPublicBudgetId, amount: number, ledger: AgentTurnLedger) { this.id = id; this.budget = budget; this.amount = amount; this.#ledger = ledger; }
  get state(): "reserved" | "consumed" | "released" { return this.#state; }
  consume(): void { if (this.#state !== "reserved") return; this.#ledger.consumeReservation(this); this.#state = "consumed"; }
  release(): void { if (this.#state !== "reserved") return; this.#ledger.releaseReservation(this); this.#state = "released"; }
  settleConsumed(): void { if (this.#state === "reserved") this.#state = "consumed"; }
}

/** Shared immutable-config accounting owner for one root and its descendants. */
export class AgentTurnLedger implements AgentTurnLedgerContract {
  readonly generationId: string; readonly authored: Readonly<Pick<AgentConfigV2, "maxInvocations" | "maxToolCalls">>; readonly limits: AgentRuntimeHostLimits; readonly authorization: AgentAuthorizationSnapshot; readonly userId: string; readonly admission: AgentRuntimeAdmissionManager; readonly signal: AbortSignal; readonly rootDeadlineSignal: AbortSignal;
  readonly #abortController = new AbortController();
  #counts = EMPTY_COUNTS();
  #reservations = EMPTY_COUNTS();
  #limits = EMPTY_COUNTS();
  #operationPermits = new Set<AgentAdmissionPermit>();
  #now: () => number;
  #deadlineAt: number;
  #scheduler: AgentLedgerTimeoutScheduler;
  #rootPermit: AgentAdmissionPermit | null;
  #terminal: AgentTerminalReason | null = null;
  #failure: AgentLedgerFailure | null = null;
  #cancelDeadline: (() => void) | null = null;
  #reservationCounter = 0;
  #payloadLimitReached = false;
  #activityNodes: AgentActivityNodeV1[] = [];
  #terminalActivityNodeIds = new Set<string>();
  #activityBytes = 0;
  #activityOmittedNodeCount = 0;
  #activityErrorCounts: Partial<Record<AgentPublicErrorCode, number>> = {};
  #activityUsage: AgentActivityUsageV1 = activityUsage();
  #activityAgentUsage: AgentUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  #activityRootProviderUsage = new Map<string, AgentUsage>();
  #activityStartedAt = Date.now();
  constructor(options: AgentTurnLedgerOptions) {
    this.generationId = options.generationId; this.admission = options.admission ?? AGENT_RUNTIME_ADMISSION_MANAGER; this.limits = Object.freeze({ ...(options.limits ?? getAgentRuntimeHostLimits()) }); this.userId = options.userId || options.authorization.rootUserId || "__anonymous__";
    const permit = this.admission.tryAcquireRoot(this.userId);
    if (!permit) {
      const context = this.admission.lastFailure?.context;
      const details = context ? admissionFailureDetails(context) : undefined;
      const limit = details?.admission
        ? details.admission.scope === "user"
          ? details.admission.userLimit
          : details.admission.processLimit
        : this.limits.activeRootsProcess;
      const observed = details?.admission
        ? details.admission.scope === "user"
          ? details.admission.userObserved
          : details.admission.processObserved
        : this.limits.activeRootsProcess;
      throw new AgentLedgerFailure(
        "capacity_exceeded",
        "child_admissions",
        limit,
        observed,
        details,
      );
    }
    this.#rootPermit = permit;
    try {
      const config = cloneAndFreeze(options.config); this.authored = Object.freeze({ maxInvocations: config.maxInvocations, maxToolCalls: config.maxToolCalls }); this.authorization = cloneAndFreeze(options.authorization);
      this.#limits.child_admissions = Math.min(config.maxInvocations, this.limits.childAdmissions); this.#limits.aggregate_tool_calls = Math.min(config.maxToolCalls, this.limits.aggregateToolCalls); this.#limits.logical_provider_requests = this.limits.logicalProviderRequests; this.#limits.physical_dispatch_attempts = this.limits.physicalDispatchAttempts; this.#limits.child_output_tokens = this.limits.childOutputTokens; this.#limits.root_wall_clock_ms = this.limits.rootWallClockMs; this.#limits.activity_events = this.limits.activityEvents; this.#limits.activity_bytes = this.limits.activityBytes; this.#limits.lifecycle_log_records = this.limits.lifecycleLogRecords;
      for (const budget of ALL_BUDGETS) if (TECHNICAL_LIMITS[budget] !== undefined) this.#limits[budget] = TECHNICAL_LIMITS[budget]!;
      this.#now = options.now ?? Date.now;
      this.#activityStartedAt = this.#now();
      this.#seedActivityRoot();
      this.#deadlineAt = this.#activityStartedAt + this.limits.rootWallClockMs;
      this.#scheduler = options.timeoutScheduler ?? defaultScheduler();
      this.#scheduleDeadline();
      this.signal = this.#abortController.signal;
      this.rootDeadlineSignal = this.signal;
      if (options.signal) { if (options.signal.aborted) this.tryTerminate("cancelled"); else options.signal.addEventListener("abort", () => this.tryTerminate("cancelled"), { once: true }); }
      if (this.limits.rootWallClockMs <= 0) this.#checkDeadline();
    } catch (error) { this.#rootPermit.release(); this.#rootPermit = null; throw error; }
  }
  recordActivityNode(node: AgentActivityNodeV1): void {
    if (!this.#isOpen()) return;
    const normalized = this.#normalizeActivityNode(node);
    if (!normalized) return;
    this.#storeActivityNode(normalized, true);
  }

  /**
   * Terminalize an activity node that was admitted before the ledger CAS.
   * This deliberately cannot admit a new node or charge activity budgets:
   * terminal callbacks may run after ownership has already been claimed.
   */
  recordTerminalActivityNode(node: AgentActivityNodeV1): void {
    if (this.#terminal === null || this.#terminalActivityNodeIds.has(node.id)) {
      return;
    }
    const existing = this.#activityNodes.find((item) => item.id === node.id);
    if (
      !existing ||
      (existing.phase !== "queued" && existing.phase !== "running") ||
      (existing.status !== "queued" && existing.status !== "running")
    ) {
      return;
    }
    const normalized = this.#normalizeActivityNode(node);
    if (!normalized) return;
    const terminalNode = this.#normalizeTerminalActivityNode(normalized);
    this.#terminalActivityNodeIds.add(terminalNode.id);
    this.#storeActivityNode(terminalNode, false);
  }

  #normalizeTerminalActivityNode(
    node: AgentActivityNodeV1,
  ): AgentActivityNodeV1 {
    const reason = this.#terminal;
    if (reason === null) return node;
    let phase: AgentActivityLifecycle;
    let errorCode: AgentPublicErrorCode | undefined;
    if (reason === "stopped" || reason === "cancelled") {
      phase = "cancelled";
      errorCode = "cancelled";
    } else if (
      reason === "timeout" ||
      reason === "root_wall_clock_limit_exceeded"
    ) {
      phase = "timed_out";
      errorCode =
        reason === "timeout" ? "timeout" : "root_wall_clock_limit_exceeded";
    } else if (
      reason === "completed" ||
      reason === "completed_at_tool_budget"
    ) {
      phase = "completed";
    } else {
      phase = "failed";
      errorCode = reason === "failed" ? "internal_error" : reason;
    }
    const terminalNode = { ...node, phase, status: phase };
    if (errorCode) return { ...terminalNode, errorCode };
    delete terminalNode.errorCode;
    return terminalNode;
  }

  #normalizeActivityNode(
    node: AgentActivityNodeV1,
  ): AgentActivityNodeV1 | undefined {
    if (
      typeof node.id !== "string" ||
      node.id.length === 0 ||
      node.id.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(node.id) ||
      (node.parentId !== null && (
        typeof node.parentId !== "string" ||
        node.parentId.length === 0 ||
        node.parentId.length > 256 ||
        /[\u0000-\u001f\u007f]/.test(node.parentId)
      )) ||
      !ACTIVITY_NODE_KINDS.has(node.kind) ||
      !ACTIVITY_ACTORS.has(node.actor) ||
      !ACTIVITY_LIFECYCLES.has(node.phase) ||
      !ACTIVITY_LIFECYCLES.has(node.status) ||
      !Number.isSafeInteger(node.startedAt) ||
      node.startedAt < 0 ||
      !Number.isSafeInteger(node.elapsedMs) ||
      node.elapsedMs < 0
    ) return undefined;
    const profileId =
      node.profileId !== undefined &&
      typeof node.profileId === "string" &&
      node.profileId.length > 0 &&
      node.profileId.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(node.profileId)
        ? node.profileId
        : undefined;
    const taskId =
      node.taskId !== undefined &&
      typeof node.taskId === "string" &&
      node.taskId.length > 0 &&
      node.taskId.length <= 256 &&
      !/[\u0000-\u001f\u007f]/.test(node.taskId)
        ? node.taskId
        : undefined;
    if (node.taskId !== undefined && taskId === undefined) return undefined;
    const toolId =
      node.toolId !== undefined && ACTIVITY_TOOL_IDS.has(node.toolId)
        ? node.toolId
        : undefined;
    const errorCode =
      node.errorCode !== undefined && ACTIVITY_ERROR_CODES.has(node.errorCode)
        ? node.errorCode
        : undefined;
    const usage = node.usage;
    if (
      usage &&
      (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 ||
        !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0 ||
        !Number.isSafeInteger(usage.totalTokens) || usage.totalTokens < 0 ||
        !Number.isSafeInteger(usage.toolCalls) || usage.toolCalls < 0 ||
        !Number.isSafeInteger(usage.childInvocations) || usage.childInvocations < 0)
    ) return undefined;
    return {
      id: node.id,
      parentId: node.parentId,
      kind: node.kind,
      actor: node.actor,
      ...(profileId ? { profileId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(toolId ? { toolId } : {}),
      phase: node.phase,
      status: node.status,
      ...(node.roundIndex !== undefined &&
      Number.isSafeInteger(node.roundIndex) &&
      node.roundIndex >= 0
        ? { roundIndex: node.roundIndex }
        : {}),
      ...(node.continuationMode === "ordinary" ||
      node.continuationMode === "finalization" ||
      node.continuationMode === "none"
        ? { continuationMode: node.continuationMode }
        : {}),
      startedAt: node.startedAt,
      elapsedMs: node.elapsedMs,
      ...(usage ? { usage: { ...usage } } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  #storeActivityNode(
    normalized: AgentActivityNodeV1,
    chargeActivity: boolean,
  ): void {
    if (
      normalized.kind === "provider_round" &&
      normalized.parentId === this.generationId &&
      normalized.usage
    ) {
      this.#activityRootProviderUsage.set(normalized.id, {
        inputTokens: normalized.usage.inputTokens,
        outputTokens: normalized.usage.outputTokens,
        totalTokens: normalized.usage.totalTokens,
      });
    }
    if (chargeActivity) {
      const eventBytes = activityNodeBytes(normalized);
      if (
        !this.charge("activity_events", 1) ||
        !this.charge("activity_bytes", eventBytes)
      ) {
        this.#activityOmittedNodeCount += 1;
        if (normalized.errorCode) this.#recordActivityError(normalized.errorCode);
        return;
      }
    }
    if (normalized.usage) {
      this.#activityUsage = {
        ...this.#activityUsage,
        toolCalls: Math.max(this.#activityUsage.toolCalls, normalized.usage.toolCalls),
        childInvocations: Math.max(
          this.#activityUsage.childInvocations,
          normalized.usage.childInvocations,
        ),
      };
    }
    if (normalized.errorCode) this.#recordActivityError(normalized.errorCode);
    const existingIndex = this.#activityNodes.findIndex(
      (item) => item.id === normalized.id,
    );
    if (existingIndex >= 0) {
      this.#activityNodes[existingIndex] = normalized;
    } else {
      this.#activityNodes.push(normalized);
    }
    this.#trimActivityNodes();
  }

  /**
   * Publish the owner's checked aggregate separately from child/provider
   * detail nodes so multiple invocations cannot collapse through max-of-node
   * projection. Monotonic updates are accepted after cancellation because a
   * provider response may complete before its accounting settlement finishes.
   */
  recordAgentUsage(usage: AgentUsage): void {
    if (
      !Number.isSafeInteger(usage.inputTokens) ||
      usage.inputTokens < this.#activityAgentUsage.inputTokens ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < this.#activityAgentUsage.outputTokens ||
      !Number.isSafeInteger(usage.totalTokens) ||
      usage.totalTokens < this.#activityAgentUsage.totalTokens
    ) return;
    this.#activityAgentUsage = { ...usage };
  }

  #activityTokenUsage(): AgentUsage {
    const aggregate: AgentUsage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    const add = (usage: AgentUsage): void => {
      if (
        aggregate.inputTokens > Number.MAX_SAFE_INTEGER - usage.inputTokens ||
        aggregate.outputTokens > Number.MAX_SAFE_INTEGER - usage.outputTokens ||
        aggregate.totalTokens > Number.MAX_SAFE_INTEGER - usage.totalTokens
      ) {
        return;
      }
      aggregate.inputTokens += usage.inputTokens;
      aggregate.outputTokens += usage.outputTokens;
      aggregate.totalTokens += usage.totalTokens;
    };
    // Match message persistence: root provider rounds settle first, then the
    // child aggregate. An unsafe contribution is omitted atomically rather
    // than publishing a saturated, imprecise total.
    for (const usage of this.#activityRootProviderUsage.values()) add(usage);
    add(this.#activityAgentUsage);
    return aggregate;
  }

  activitySnapshot(
    status?: AgentActivityLifecycle,
    terminalErrorCode?: AgentPublicErrorCode,
  ): AgentActivitySnapshotV1 {
    const resolvedStatus = status ?? this.#activityStatus();
    const resolvedErrorCode =
      terminalErrorCode && ACTIVITY_ERROR_CODES.has(terminalErrorCode)
        ? terminalErrorCode
        : undefined;
    const elapsedMs = Math.max(0, this.#now() - this.#activityStartedAt);
    const tokenUsage = this.#activityTokenUsage();
    const rootIndex = this.#activityNodes.findIndex(
      (node) => node.id === this.generationId,
    );
    const root: AgentActivityNodeV1 = {
      id: this.generationId,
      parentId: null,
      kind: "root_turn",
      actor: "root",
      phase: resolvedStatus,
      status: resolvedStatus,
      startedAt: this.#activityStartedAt,
      elapsedMs,
      usage: {
        ...tokenUsage,
        toolCalls: Math.max(
          this.#activityUsage.toolCalls,
          this.#counts.aggregate_tool_calls,
        ),
        childInvocations: Math.max(
          this.#activityUsage.childInvocations,
          this.#counts.child_admissions,
        ),
      },
      ...(resolvedErrorCode ? { errorCode: resolvedErrorCode } : {}),
    };
    const nodes = [...this.#activityNodes];
    if (rootIndex >= 0) nodes[rootIndex] = root;
    else nodes.unshift(root);
    const errorCounts = { ...this.#activityErrorCounts };
    if (resolvedErrorCode && !errorCounts[resolvedErrorCode]) {
      errorCounts[resolvedErrorCode] = 1;
    }
    const usage = {
      ...tokenUsage,
      toolCalls: Math.max(
        this.#activityUsage.toolCalls,
        this.#counts.aggregate_tool_calls,
      ),
      childInvocations: Math.max(
        this.#activityUsage.childInvocations,
        this.#counts.child_admissions,
      ),
    };
    return cloneAndFreeze({
      version: 1 as const,
      rootId: this.generationId,
      nodes,
      omittedNodeCount: this.#activityOmittedNodeCount,
      errorCounts,
      usage,
      status: resolvedStatus,
      ...(resolvedErrorCode ? { terminalErrorCode: resolvedErrorCode } : {}),
    });
  }
  get terminal(): AgentTerminalReason | null { return this.#terminal; }
  get failure(): AgentLedgerFailure | null { return this.#failure; }
  get lastFailure(): AgentLedgerFailure | null { return this.#failure; }
  get counters(): AgentLedgerCounters { return Object.freeze({ childAdmissions: this.#counts.child_admissions, aggregateToolCalls: this.#counts.aggregate_tool_calls, logicalProviderRequests: this.#counts.logical_provider_requests, physicalDispatchAttempts: this.#counts.physical_dispatch_attempts, childOutputTokens: this.#counts.child_output_tokens }); }
  get budgetCounters(): readonly AgentPublicBudgetContext[] { return Object.freeze(ALL_BUDGETS.map((id) => ({ id, limit: this.#limits[id], observed: this.#counts[id] }))); }
  get deadlineAt(): number { return this.#deadlineAt; }
  get remainingRootWallClockMs(): number { return Math.max(0, this.#deadlineAt - this.#now()); }
  remaining(budget: AgentPublicBudgetId): number { this.#checkDeadline(); if ((budget === "argument_bytes" || budget === "result_bytes") && this.#payloadLimitReached) return 0; const ownRemaining = Math.max(0, this.#limits[budget] - this.#counts[budget] - this.#reservations[budget]); if (budget !== "argument_bytes" && budget !== "result_bytes") return ownRemaining; const payloadUsed = this.#counts.argument_bytes + this.#counts.result_bytes + this.#reservations.argument_bytes + this.#reservations.result_bytes; return Math.min(ownRemaining, Math.max(0, AGENT_AGGREGATE_TOOL_PAYLOAD_MAX_BYTES - payloadUsed)); }
  reserve(budget: AgentPublicBudgetId, amount: number): AgentLedgerReservation | null { if (!this.#validAmount(amount) || !this.#isOpen()) return null; this.#checkDeadline(); if (amount > this.remaining(budget)) { this.#fail(budget, this.#counts[budget] + this.#reservations[budget] + amount); return null; } this.#reservations[budget] += amount; return new LedgerReservation(`${this.generationId}-${budget}-${this.#reservationCounter++}`, budget, amount, this); }
  charge(budget: AgentPublicBudgetId, amount: number): boolean { if (!this.#validAmount(amount) || !this.#isOpen()) return false; this.#checkDeadline(); const available = this.remaining(budget); if (amount > available) { const observed = Math.min(Number.MAX_SAFE_INTEGER, this.#counts[budget] + this.#reservations[budget] + amount); if (budget === "argument_bytes" || budget === "result_bytes") this.#payloadLimitReached = true; this.#counts[budget] = observed; this.#fail(budget, observed); return false; } this.#counts[budget] = Math.min(Number.MAX_SAFE_INTEGER, this.#counts[budget] + amount); return true; }
  chargeChildAdmission(): boolean { return this.charge("child_admissions", 1); }
  chargeToolCallAttempt(): boolean { return this.charge("aggregate_tool_calls", 1); }
  chargeLogicalProviderRequest(): boolean { return this.charge("logical_provider_requests", 1); }
  chargePhysicalDispatchAttempt(): boolean { return this.charge("physical_dispatch_attempts", 1); }
  chargeRetryAttempt(): boolean { return this.chargePhysicalDispatchAttempt(); }
  chargeBytes(budget: Extract<AgentPublicBudgetId, `${string}_bytes`>, amount: number): boolean { return this.charge(budget, amount); }
  reserveProviderDispatch(): { readonly logical: AgentLedgerReservation; readonly physical: AgentLedgerReservation } | null { const logical = this.reserve("logical_provider_requests", 1); if (!logical) return null; const physical = this.reserve("physical_dispatch_attempts", 1); if (!physical) { logical.release(); return null; } return { logical, physical }; }
  acquireProviderPermit(): AgentAdmissionPermit | null {
    const permit = this.admission.tryAcquireProvider(this.userId);
    if (!permit) {
      this.#recordAdmissionFailure(
        "provider",
        "logical_provider_requests",
        this.limits.providerDispatchesProcess,
      );
      return null;
    }
    this.#operationPermits.add(permit);
    return permit;
  }
  acquireToolPermit(): AgentAdmissionPermit | null {
    const permit = this.admission.tryAcquireTool(this.userId);
    if (!permit) {
      this.#recordAdmissionFailure(
        "tool",
        "aggregate_tool_calls",
        this.limits.toolExecutionsProcess,
      );
      return null;
    }
    this.#operationPermits.add(permit);
    return permit;
  }
  releaseOperationPermit(permit: AgentAdmissionPermit): void { permit.release(); this.#operationPermits.delete(permit); }
  consumeReservation(reservation: LedgerReservation): void { if (this.#reservations[reservation.budget] < reservation.amount) return; this.#reservations[reservation.budget] -= reservation.amount; this.#counts[reservation.budget] = Math.min(this.#limits[reservation.budget], this.#counts[reservation.budget] + reservation.amount); }
  releaseReservation(reservation: LedgerReservation): void { this.#reservations[reservation.budget] = Math.max(0, this.#reservations[reservation.budget] - reservation.amount); }
  settleReservation(reservation: AgentLedgerReservation, observedAmount: number): boolean { const concrete = reservation as LedgerReservation; if (concrete.state !== "reserved") return concrete.state === "consumed"; if (!Number.isSafeInteger(observedAmount) || observedAmount < 0 || observedAmount > concrete.amount) { concrete.release(); this.#fail(concrete.budget, observedAmount); return false; } concrete.consume(); if (observedAmount < concrete.amount) this.#counts[concrete.budget] = Math.max(0, this.#counts[concrete.budget] - (concrete.amount - observedAmount)); return true; }
  /**
   * Settle one admitted child-output reservation with the provider's actual
   * response count. Unlike generic settlement, this remains valid after the
   * ledger terminal CAS because it never admits new capacity.
   */
  settleOutputReservation(
    reservation: AgentLedgerReservation,
    observedAmount: number,
  ): boolean {
    if (!(reservation instanceof LedgerReservation)) return false;
    const concrete = reservation;
    if (concrete.budget !== "child_output_tokens") return false;
    if (concrete.state !== "reserved") return concrete.state === "consumed";
    if (!Number.isSafeInteger(observedAmount) || observedAmount < 0) {
      concrete.release();
      this.#fail("child_output_tokens", Number.MAX_SAFE_INTEGER);
      return false;
    }

    const current = this.#counts.child_output_tokens;
    const settled = current > Number.MAX_SAFE_INTEGER - observedAmount
      ? Number.MAX_SAFE_INTEGER
      : current + observedAmount;
    this.#reservations.child_output_tokens = Math.max(
      0,
      this.#reservations.child_output_tokens - concrete.amount,
    );
    concrete.settleConsumed();
    this.#counts.child_output_tokens = settled;
    if (settled > this.#limits.child_output_tokens) {
      this.#fail("child_output_tokens", settled);
      return false;
    }
    return true;
  }
  tryTerminate(reason: AgentTerminalReason): boolean { if (this.#terminal !== null) return false; this.#terminal = reason; this.#cancelDeadline?.(); this.#cancelDeadline = null; if (!this.#abortController.signal.aborted) this.#abortController.abort(new DOMException(reason, "AbortError")); for (const permit of this.#operationPermits) permit.release(); this.#operationPermits.clear(); this.#rootPermit?.release(); this.#rootPermit = null; return true; }
  close(): void { this.tryTerminate("stopped"); }
  #seedActivityRoot(): void {
    const root: AgentActivityNodeV1 = {
      id: this.generationId,
      parentId: null,
      kind: "root_turn",
      actor: "root",
      phase: "running",
      status: "running",
      startedAt: this.#activityStartedAt,
      elapsedMs: 0,
      usage: activityUsage(),
    };
    this.#activityNodes.push(root);
    this.#activityBytes = activityNodeBytes(root);
  }

  #recordActivityError(code: AgentPublicErrorCode): void {
    this.#activityErrorCounts[code] =
      (this.#activityErrorCounts[code] ?? 0) + 1;
  }

  #trimActivityNodes(): void {
    this.#activityBytes = this.#activityNodes.reduce(
      (sum, node) => sum + activityNodeBytes(node),
      0,
    );
    while (
      (this.#activityNodes.length > ACTIVITY_NODE_LIMIT ||
        this.#activityBytes > ACTIVITY_BYTES_LIMIT) &&
      this.#activityNodes.length > 1
    ) {
      const rootIndex = this.#activityNodes.findIndex(
        (node) => node.id === this.generationId,
      );
      const evictIndex = rootIndex === 0 ? 1 : 0;
      const [evicted] = this.#activityNodes.splice(evictIndex, 1);
      if (evicted) {
        this.#activityBytes -= activityNodeBytes(evicted);
        this.#activityOmittedNodeCount += 1;
      }
    }
  }

  #activityStatus(): AgentActivityLifecycle {
    if (this.#terminal === "completed" || this.#terminal === "completed_at_tool_budget") {
      return "completed";
    }
    if (this.#terminal === "cancelled" || this.#terminal === "stopped") {
      return "cancelled";
    }
    if (
      this.#terminal === "timeout" ||
      this.#terminal === "root_wall_clock_limit_exceeded"
    ) {
      return "timed_out";
    }
    return this.#terminal ? "failed" : "running";
  }

  #isOpen(): boolean { return this.#terminal === null; }
  #validAmount(amount: number): boolean { return Number.isSafeInteger(amount) && amount > 0; }
  #recordAdmissionFailure(
    kind: AgentAdmissionKind,
    fallbackBudget: AgentPublicBudgetId,
    fallbackLimit: number,
  ): void {
    const context = this.admission.lastFailure?.context;
    const details = context ? admissionFailureDetails(context) : undefined;
    const limit = details?.admission
      ? details.admission.scope === "user"
        ? details.admission.userLimit
        : details.admission.processLimit
      : fallbackLimit;
    const observed = details?.admission
      ? details.admission.scope === "user"
        ? details.admission.userObserved
        : details.admission.processObserved
      : fallbackLimit;
    this.#failure = new AgentLedgerFailure(
      "capacity_exceeded",
      fallbackBudget,
      limit,
      observed,
      details ?? {
        admission: {
          kind,
          scope: "process",
          userId: this.userId,
          userLimit: fallbackLimit,
          processLimit: fallbackLimit,
          userObserved: 0,
          processObserved: observed,
        },
      },
    );
  }
  #fail(budget: AgentPublicBudgetId, observed: number): AgentLedgerFailure { if (this.#failure) return this.#failure; const authored = budget === "child_admissions" ? this.authored.maxInvocations : budget === "aggregate_tool_calls" ? this.authored.maxToolCalls : this.#limits[budget]; const host = budget === "child_admissions" ? this.limits.childAdmissions : budget === "aggregate_tool_calls" ? this.limits.aggregateToolCalls : this.#limits[budget]; this.#failure = new AgentLedgerFailure(budgetCode(budget, authored, host), budget, this.#limits[budget], Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, observed))); return this.#failure; }
  #checkDeadline(): void { if (!this.#isOpen()) return; if (this.remainingRootWallClockMs <= 0) { this.#failure = this.#failure ?? new AgentLedgerFailure("root_wall_clock_limit_exceeded", "root_wall_clock_ms", this.limits.rootWallClockMs, this.limits.rootWallClockMs); this.tryTerminate("root_wall_clock_limit_exceeded"); } }
  #scheduleDeadline(): void { let remaining = Math.max(0, this.limits.rootWallClockMs); let handle: ReturnType<typeof setTimeout> | undefined; let cancelled = false; const schedule = (): void => { if (cancelled) return; const chunk = Math.min(remaining, AGENT_LEDGER_MAX_DELAY_MS); handle = this.#scheduler.setTimeout(() => { handle = undefined; if (cancelled) return; remaining -= chunk; if (remaining <= 0) { this.#failure = this.#failure ?? new AgentLedgerFailure("root_wall_clock_limit_exceeded", "root_wall_clock_ms", this.limits.rootWallClockMs, this.limits.rootWallClockMs); this.tryTerminate("root_wall_clock_limit_exceeded"); } else schedule(); }, chunk); const maybeUnref = handle as unknown as { unref?: () => void }; maybeUnref.unref?.(); }; schedule(); this.#cancelDeadline = () => { cancelled = true; if (handle !== undefined) this.#scheduler.clearTimeout(handle); handle = undefined; }; }
}
export const createAgentTurnLedger = (options: AgentTurnLedgerOptions): AgentTurnLedger => new AgentTurnLedger(options);
export type AgentLedger = AgentTurnLedger;


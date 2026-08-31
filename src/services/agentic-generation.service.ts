import type { GenerationType, GenerationParameters, LlmMessage } from "../llm/types";
import type { GenerationAssemblySnapshotV1 } from "./prompt-assembly-snapshot.service";
import type { AssemblyPlanV1 } from "./agentic-assembly-compiler";
import type { AgenticWorkPhaseOutcome } from "./agentic-work-phase.service";
import type { RenderUsageV1 } from "../types/agent-preprocessing";
import type {
  AgentWorkAttemptLineageV1,
  AgentWorkOutcome,
  AgentWorkPhase,
  AgentWorkStatus,
} from "../types/agent-runtime";
/** The only generation targets accepted by the closed single-turn Agentic runtime. */
export type AgenticGenerationTarget = "normal" | "continue" | "regenerate" | "swipe";

export type AgenticPhase =
  | "ASSEMBLE"
  | "WORK"
  | "COMPLETE"
  | "RENDER"
  | "PREPARE_COMMIT"
  | "COMMITTING"
  | "COMMITTED"
  | "COMMIT_FAILED"
  | "EXHAUSTED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

export type AgenticTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "exhausted"
  | "rejected";

export type AgenticFailureCode =
  | "agentic_unsupported_surface"
  | "agentic_runtime_unavailable"
  | "agentic_preflight_failed"
  | "decision_refresh_required"
  | "agentic_chat_busy"
  | "agentic_protocol_failure"
  | "agentic_work_exhausted"
  | "agentic_cancelled"
  | "agentic_timed_out"
  | "agentic_commit_failed"
  | "agentic_revision_conflict"
  | "agentic_provider_failure"
  | "agentic_internal_error";

export class AgenticGenerationError extends Error {
  readonly code: AgenticFailureCode;
  readonly phase?: AgenticPhase;
  readonly retryable: boolean;
  readonly responseModeAvailable = true;

  constructor(
    code: AgenticFailureCode,
    message: string = code,
    options: { phase?: AgenticPhase; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AgenticGenerationError";
    this.code = code;
    this.phase = options.phase;
    this.retryable = options.retryable ?? false;
  }
}
export const AGENTIC_DISPATCH_ACKNOWLEDGEMENT_TIMEOUT_MS = 30_000;
export type AgenticDispatchAcknowledgementState = "accepted" | "already_acknowledged";

export interface AgenticDispatchAcknowledgementScheduler {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const SYSTEM_DISPATCH_ACKNOWLEDGEMENT_SCHEDULER: AgenticDispatchAcknowledgementScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface AgenticGenerationInput {
  userId: string;
  chatId: string;
  connectionId?: string;
  presetId?: string;
  forcePresetId?: boolean;
  personaId?: string;
  /** Add-on enablement already resolved by the authenticated generation entrypoint. */
  personaAddonStates?: Readonly<Record<string, boolean>>;
  /** Visible current-turn user messages eligible for native multipart admission. */
  sourceUserMessageIds?: readonly string[];
  messageId?: string;
  swipeId?: number;
  targetCharacterId?: string;
  generationType: GenerationType | AgenticGenerationTarget;
  readonly attemptLineage?: Partial<AgentWorkAttemptLineageV1> | null;
  parameters?: GenerationParameters;
  userInput?: string;
  regenFeedback?: string;
  regenFeedbackPosition?: "system" | "user";
  /** Hold provider dispatch until the authenticated client accepts the durable generation ID. */
  requireDispatchAcknowledgement?: boolean;
  /** Dry-run is a Response-only inspection surface. */
  isDryRun?: boolean;
  runtimeDecisionToken?: string;
  requestEpoch?: number;
  signal?: AbortSignal;
  /** Impersonation is deliberately Response-only, including legacy mode flags. */
  isImpersonate?: boolean;
  /** Surfaces that are deliberately Response-only; `1` preserves legacy group metadata defensively. */
  isGroupChat?: boolean | 1;
  isMultiplayer?: boolean;
  councilEnabled?: boolean;
  councilToolsEnabled?: boolean;
}

export interface AgenticTargetSnapshot {
  generationType: AgenticGenerationTarget;
  messageId?: string;
  swipeId?: number;
  targetCharacterId?: string;
  /** Monotonic target/chat/message revisions captured before any generation write. */
  revision?: number | string;
}

export interface AgenticFrozenConnection {
  logicalId?: string;
  concreteId?: string;
  id?: string;
  name?: string;
  provider?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
  apiUrl?: string;
  capabilities?: Record<string, unknown>;
  fingerprint?: string;
  candidateRevision?: number | string;
  endpointRevision?: number | string;
  credentialRevision?: number | string;
}

export interface AgenticRuntimeDecision {
  /** Safe public fields may be present; private fields are held only in memory. */
  mode?: "response" | "agentic";
  target?: AgenticTargetSnapshot;
  connection?: AgenticFrozenConnection;
  presetId?: string;
  configRevision?: number | string;
  bindingRevision?: number | string;
  inputRevisions?: unknown;
  readiness?: unknown;
  readinessDigest?: string;
  token?: string;
  expiresAt?: number;
  [key: string]: unknown;
}


export type AgenticAssemblySnapshot = GenerationAssemblySnapshotV1;
export type AgenticAssemblyPlan = AssemblyPlanV1;

export interface AgenticWorkspace {
  [key: string]: unknown;
}

export interface AgenticWorkOutcome {
  status: "completed" | "exhausted" | "failed" | "cancelled" | "timed_out";
  summary?: string;
  workspace?: AgenticWorkspace;
  acceptedWorkspace?: AgenticWorkspace;
  unresolvedIds?: readonly string[];
  renderGuidance?: string;
  usage?: Record<string, number>;
  observations?: readonly Record<string, unknown>[];
  errorCode?: AgenticFailureCode | string;
  errorMessage?: string;
  /** Work provider response/carriers are intentionally not part of this contract. */
}

export interface AgenticRenderOutcome {
  content: string;
  usage?: Record<string, number>;
  finishReason?: string;
  /** A returned tool batch is a protocol failure; adapters report it separately. */
  toolCalls?: readonly unknown[];
  privateCarrier?: unknown;
}

export interface AgenticPrepareOutcome {
  content: string;
  usage?: RenderUsageV1;
  sourceMessageDelta?: unknown;
  macroVariableDelta?: unknown;
  chatMetadataDelta?: unknown;
  regexActionDelta?: unknown;
  worldInfoStateDelta?: unknown;
  inputRevisions?: unknown;
  [key: string]: unknown;
}

export interface AgenticCommitReceipt {
  receiptId: string;
  commitKey?: string;
  messageId?: string;
  swipeId?: number;
  summary?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface AgenticExecutionHandle {
  id: string;
  ownerToken?: string;
  commitKey?: string;
  phase?: AgenticPhase;
  signal?: AbortSignal;
  /** The host deadline also bounds terminal child-join reconciliation. */
  deadlineAt?: number;
  target?: AgenticTargetSnapshot;
}

export interface AgenticExecutionCreateInput {
  executionId: string;
  userId: string;
  chatId: string;
  target: AgenticTargetSnapshot;
  decision: AgenticRuntimeDecision;
  readonly attemptLineage?: Partial<AgentWorkAttemptLineageV1> | null;
  signal: AbortSignal;
  deadlineAt?: number;
}

export interface AgenticGenerationDependencies {
  /** Common authenticated admission and one-use decision-token authority. */
  resolveRuntime?: (
    input: AgenticGenerationInput,
    target: AgenticTargetSnapshot,
    signal: AbortSignal,
  ) => Promise<AgenticRuntimeDecision>;
  consumeRuntimeToken?: (
    input: AgenticGenerationInput,
    target: AgenticTargetSnapshot,
    token: string,
    signal: AbortSignal,
  ) => Promise<AgenticRuntimeDecision>;
  /** Burn a one-use token before rejecting a target that has no Agentic shape. */
  claimRuntimeToken?: (
    input: AgenticGenerationInput,
    token: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  createExecution?: (
    input: AgenticExecutionCreateInput,
  ) => Promise<AgenticExecutionHandle> | AgenticExecutionHandle;
  transitionExecution?: (
    execution: AgenticExecutionHandle,
    expected: AgenticPhase,
    next: AgenticPhase,
    terminalReason?: string,
  ) => Promise<AgenticExecutionHandle | void> | AgenticExecutionHandle | void;
  /** Read the durable phase when commit/terminal recovery races a CAS. */
  readExecutionPhase?: (
    execution: AgenticExecutionHandle,
  ) => Promise<AgenticPhase | undefined> | AgenticPhase | undefined;
  /** Read a partially-created durable row when admission throws before returning its handle. */
  readExecutionPhaseById?: (
    executionId: string,
    userId: string,
  ) => Promise<AgenticPhase | undefined> | AgenticPhase | undefined;
  /** Resolve the normalized target while a partially-created execution is being settled. */
  getExecutionTarget?: (executionId: string) => AgenticTargetSnapshot | undefined;
  /** Durable owner CAS for user-facing Stop; low-level abort follows only on acceptance. */
  requestCancellation?: (
    execution: AgenticExecutionHandle,
    reason?: "stopped" | "cancelled" | "timed_out",
  ) => Promise<boolean | "too_late"> | boolean | "too_late";
  /** Bounded client-ID handoff; defaults to the frontend request timeout. */
  dispatchAcknowledgementTimeoutMs?: number;
  dispatchAcknowledgementScheduler?: AgenticDispatchAcknowledgementScheduler;
  /**
   * Cancel the root signal and join every host-tracked child frame before
   * terminal projection. The callback owns child reservations and must be
   * idempotent.
   */
  cancelAndJoinChildren?: (
    execution: AgenticExecutionHandle,
    reason: "failed" | "stopped" | "cancelled" | "timed_out" | "exhausted" | "commit_failed",
  ) => Promise<void> | void;
  /** Bounded SQLite snapshot and strict isolate plan compilation. */
  buildAssemblySnapshot?: (
    input: AgenticGenerationInput,
    decision: AgenticRuntimeDecision,
    target: AgenticTargetSnapshot,
    signal: AbortSignal,
    executionId: string,
  ) => Promise<AgenticAssemblySnapshot>;
  compileAssemblyPlan?: (
    snapshot: AgenticAssemblySnapshot,
    input: AgenticGenerationInput,
    decision: AgenticRuntimeDecision,
    signal: AbortSignal,
    executionId: string,
  ) => Promise<AgenticAssemblyPlan>;
  /** Fallback for a foundation that exposes one combined snapshot/compile call. */
  assemble?: (
    input: AgenticGenerationInput,
    decision: AgenticRuntimeDecision,
    target: AgenticTargetSnapshot,
    signal: AbortSignal,
    executionId: string,
  ) => Promise<{ snapshot: AgenticAssemblySnapshot; plan: AgenticAssemblyPlan }>;
  runWork?: (options: {
    execution: AgenticExecutionHandle;
    input: AgenticGenerationInput;
    decision: AgenticRuntimeDecision;
    snapshot: AgenticAssemblySnapshot;
    plan: AgenticAssemblyPlan;
    signal: AbortSignal;
  }) => Promise<AgenticWorkOutcome>;
  render?: (options: {
    execution: AgenticExecutionHandle;
    input: AgenticGenerationInput;
    decision: AgenticRuntimeDecision;
    snapshot: AgenticAssemblySnapshot;
    plan: AgenticAssemblyPlan;
    work: AgenticWorkOutcome;
    signal: AbortSignal;
  }) => Promise<AgenticRenderOutcome>;
  prepareRender?: (options: {
    execution: AgenticExecutionHandle;
    input: AgenticGenerationInput;
    decision: AgenticRuntimeDecision;
    snapshot: AgenticAssemblySnapshot;
    plan: AgenticAssemblyPlan;
    work: AgenticWorkOutcome;
    render: AgenticRenderOutcome;
    signal: AbortSignal;
  }) => Promise<AgenticPrepareOutcome>;
  commit?: (options: {
    execution: AgenticExecutionHandle;
    input: AgenticGenerationInput;
    decision: AgenticRuntimeDecision;
    snapshot: AgenticAssemblySnapshot;
    plan: AgenticAssemblyPlan;
    work: AgenticWorkOutcome;
    render: AgenticRenderOutcome;
    prepared: AgenticPrepareOutcome;
    signal: AbortSignal;
  }) => Promise<AgenticCommitReceipt>;
  publishPhase?: (event: {
    executionId: string;
    userId: string;
    chatId: string;
    phase: AgenticPhase;
    workPhase?: AgentWorkPhase;
    workStatus?: AgentWorkStatus;
    workOutcome?: AgentWorkOutcome | null;
    reason?: string | null;
    attemptLineage?: AgentWorkAttemptLineageV1;
    target: AgenticTargetSnapshot;
  }) => Promise<void> | void;
  publishTerminal?: (event: {
    executionId: string;
    userId: string;
    chatId: string;
    status: AgenticTerminalStatus;
    phase: AgenticPhase;
    workPhase?: AgentWorkPhase;
    workStatus?: AgentWorkStatus;
    workOutcome?: AgentWorkOutcome | null;
    reason?: string | null;
    attemptLineage?: AgentWorkAttemptLineageV1;
    target: AgenticTargetSnapshot;
    receipt?: AgenticCommitReceipt;
    errorCode?: AgenticFailureCode | string;
    errorMessage?: string;
    retryable?: boolean;
  }) => Promise<void> | void;
  cleanup?: (context: {
    execution?: AgenticExecutionHandle;
    executionId?: string;
    input: AgenticGenerationInput;
    decision?: AgenticRuntimeDecision;
    phase: AgenticPhase;
    status?: AgenticTerminalStatus;
  }) => Promise<void> | void;
}


export interface AgenticGenerationResult {
  generationId: string;
  status: "streaming" | AgenticTerminalStatus;
  mode: "agentic";
  phase: AgenticPhase;
  readonly workPhase: AgentWorkPhase;
  readonly workStatus: AgentWorkStatus;
  readonly workOutcome: AgentWorkOutcome | null;
  readonly reason: string | null;
  readonly attemptLineage: AgentWorkAttemptLineageV1;
  receipt?: AgenticCommitReceipt;
  errorCode?: AgenticFailureCode | string;
  retryable?: boolean;
  errorMessage?: string;
  responseModeAvailable: true;
}
type AgenticInternalGenerationResult = Omit<
  AgenticGenerationResult,
  "workPhase" | "workStatus" | "workOutcome" | "reason" | "attemptLineage"
>;

type ActiveAgenticGeneration = {
  generationId: string;
  input: AgenticGenerationInput;
  dependencies: AgenticGenerationDependencies;
  controller: AbortController;
  execution?: AgenticExecutionHandle;
  completion: Promise<AgenticGenerationResult>;
  resolve: (result: AgenticGenerationResult) => void;
  /** Resolves only after the durable execution row is admitted. */
  admission: Promise<void>;
  resolveAdmission: () => void;
  rejectAdmission: (reason?: unknown) => void;
  admissionSettled: boolean;
  dispatchAcknowledgement: Promise<void>;
  resolveDispatchAcknowledgement: () => boolean;
  dispatchAcknowledged: boolean;
  dispatchAcknowledgementExpired: boolean;
  phase: AgenticPhase;
  attemptLineage: AgentWorkAttemptLineageV1;
  terminal: boolean;
  /** Stop can arrive before durable execution creation finishes. */
  pendingCancellation: boolean;
  /** Collapse concurrent Stop calls into one durable owner CAS. */
  cancellationInFlight?: Promise<boolean | "too_late">;
  /** A completed CAS is never retried by duplicate Stop requests. */
  cancellationRequested: boolean;
};
async function waitForDispatchAcknowledgement(active: ActiveAgenticGeneration): Promise<void> {
  if (active.dispatchAcknowledged) return;
  const signal = active.controller.signal;
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  const scheduler = active.dependencies.dispatchAcknowledgementScheduler
    ?? SYSTEM_DISPATCH_ACKNOWLEDGEMENT_SCHEDULER;
  const configuredTimeoutMs = active.dependencies.dispatchAcknowledgementTimeoutMs;
  const timeoutMs = configuredTimeoutMs !== undefined
    && Number.isFinite(configuredTimeoutMs)
    && configuredTimeoutMs >= 0
    ? configuredTimeoutMs
    : AGENTIC_DISPATCH_ACKNOWLEDGEMENT_TIMEOUT_MS;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: "acknowledged" | "aborted", reason?: unknown) => {
      if (settled) return;
      settled = true;
      scheduler.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      if (outcome === "acknowledged") resolve();
      else reject(reason ?? new DOMException("Aborted", "AbortError"));
    };
    const onAbort = () => finish("aborted", signal.reason);
    const timeout = scheduler.setTimeout(() => {
      if (settled) return;
      active.dispatchAcknowledgementExpired = true;
      void expireDispatchAcknowledgement(active).catch((error) => finish("aborted", error));
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    void active.dispatchAcknowledgement.then(() => finish("acknowledged"));
  });
}

async function expireDispatchAcknowledgement(active: ActiveAgenticGeneration): Promise<void> {
  await requestDurableCancellation(active, "timed_out");
  if (!active.controller.signal.aborted) {
    active.controller.abort(new AgenticGenerationError(
      "agentic_timed_out",
      "Agentic generation dispatch acknowledgement timed out.",
      { phase: "ASSEMBLE" },
    ));
  }
}

const activeAgenticGenerations = new Map<string, ActiveAgenticGeneration>();
const activeAgenticChats = new Map<string, string>();
const settledAgenticGenerations = new Map<string, AgenticGenerationResult>();
const agenticAdmissions = new Map<string, Promise<void>>();
let configuredAgenticDependencies: AgenticGenerationDependencies | undefined;

/**
 * The coordinator installs the same dependency instance used by ordinary
 * Agentic starts. Explicit Retry must never construct a detached authority.
 */
export function configureAgenticGenerationRuntimeDependencies(
  dependencies: AgenticGenerationDependencies,
): void {
  configuredAgenticDependencies = dependencies;
}

function resolveDependencies(
  dependencies: AgenticGenerationDependencies | undefined,
): AgenticGenerationDependencies {
  return dependencies ?? configuredAgenticDependencies ?? {};
}


function targetFromInput(input: AgenticGenerationInput): AgenticTargetSnapshot {
  const generationType = input.generationType;
  if (
    generationType !== "normal" &&
    generationType !== "continue" &&
    generationType !== "regenerate" &&
    generationType !== "swipe"
  ) {
    throw new AgenticGenerationError(
      "agentic_unsupported_surface",
      "This generation surface is only available in Response mode.",
    );
  }
  return Object.freeze({
    generationType,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.swipeId !== undefined ? { swipeId: input.swipeId } : {}),
    ...(input.targetCharacterId ? { targetCharacterId: input.targetCharacterId } : {}),
  });
}
function assertSupportedSurface(input: AgenticGenerationInput): void {
  if (input.isDryRun) {
    throw new AgenticGenerationError(
      "agentic_unsupported_surface",
      "Agentic dry-run inspection is only available in Response mode.",
    );
  }
  if (input.regenFeedback !== undefined) {
    throw new AgenticGenerationError(
      "agentic_unsupported_surface",
      "Regenerate feedback is only available in Response mode.",
    );
  }
  if (
    input.isImpersonate
    || input.isGroupChat
    || input.isMultiplayer
    || input.councilEnabled
    || input.councilToolsEnabled
  ) {
    throw new AgenticGenerationError(
      "agentic_unsupported_surface",
      "This chat surface is only available in Response mode.",
    );
  }
}

function asErrorCode(error: unknown): AgenticFailureCode | string {
  if (error instanceof AgenticGenerationError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return mapAgenticFailureCode(error.code);
  }
  if (error instanceof Error) return mapAgenticFailureCode(error.message);
  return "agentic_internal_error";
}

function mapAgenticFailureCode(value: unknown): AgenticFailureCode {
  switch (value) {
    case "agentic_unsupported_surface":
    case "agentic_runtime_unavailable":
    case "agentic_preflight_failed":
    case "decision_refresh_required":
    case "agentic_chat_busy":
    case "agentic_protocol_failure":
    case "agentic_work_exhausted":
    case "agentic_cancelled":
    case "agentic_timed_out":
    case "agentic_commit_failed":
    case "agentic_revision_conflict":
    case "agentic_provider_failure":
    case "agentic_internal_error":
      return value;
    case "provider_error":
    case "provider_unavailable":
    case "provider_timeout":
      return "agentic_provider_failure";
    case "provider_protocol_error":
    case "malformed_provider_response":
    case "returned_tool_call":
      return "agentic_protocol_failure";
    case "revision_conflict":
    case "stale_input_revision":
    case "input_revision_conflict":
      return "agentic_revision_conflict";
    case "cancelled":
    case "canceled":
      return "agentic_cancelled";
    case "timed_out":
    case "timeout":
      return "agentic_timed_out";
    case "invalid_input":
    case "invalid_plan":
    case "unsupported_plan":
    case "limit_exceeded":
    case "queue_full":
    case "worker_disabled":
    case "worker_unavailable":
    case "worker_crashed":
    case "worker_timed_out":
    case "worker_malformed":
    case "requires_response_mode":
      return "agentic_preflight_failed";
    case "tool_not_allowed":
    case "tool_protocol_error":
    case "tool_batch_rejected":
    case "batch_reservation_failed":
    case "completion_malformed":
    case "completion_forged":
    case "completion_mixed_batch":
    case "completion_not_root":
    case "completion_blocked":
    case "completion_freeze_failed":
    case "child_required_failed":
    case "child_schedule_invalid":
    case "child_executor_unavailable":
      return "agentic_protocol_failure";
    case "child_output_limit_exceeded":
    case "root_output_limit_exceeded":
    case "completion_control_budget_exhausted":
    case "unsigned_boundary_budget_exhausted":
    case "work_budget_exhausted":
    case "provider_round_budget_exhausted":
    case "workspace_budget_exhausted":
    case "context_budget_exhausted":
    case "tool_result_limit_exceeded":
    case "exhausted":
      return "agentic_work_exhausted";
    case "internal_error":
      return "agentic_internal_error";
    case "commit_failed":
      return "agentic_commit_failed";
    default:
      return "agentic_internal_error";
  }
}

function isAgenticFailureCode(value: unknown): value is AgenticFailureCode {
  return mapAgenticFailureCode(value) !== "agentic_internal_error" || value === "agentic_internal_error";
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof DOMException && error.name === "AbortError";
}


function isTimeout(error: unknown, signal?: AbortSignal): boolean {
  if (error instanceof AgenticGenerationError) return error.code === "agentic_timed_out";
  if (error instanceof DOMException && error.name === "TimeoutError") return true;
  const reason = signal?.reason;
  if (reason instanceof AgenticGenerationError) return reason.code === "agentic_timed_out";
  if (
    reason !== null
    && typeof reason === "object"
    && !Array.isArray(reason)
    && "code" in reason
    && (reason.code === "agentic_timed_out" || reason.code === "timed_out" || reason.name === "TimeoutError")
  ) return true;
  return false;
}


function asPhaseError(error: unknown, phase: AgenticPhase): AgenticGenerationError {
  if (error instanceof AgenticGenerationError) {
    const code = mapAgenticFailureCode(error.code);
    return error.phase === phase && code === error.code
      ? error
      : new AgenticGenerationError(code, error.message, {
        phase,
        retryable: error.retryable,
        cause: error,
      });
  }
  const code = mapAgenticFailureCode(asErrorCode(error));
  const message = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Agentic generation failed.";
  return new AgenticGenerationError(code, message, {
    phase,
    cause: error,
  });
}


async function transition(
  deps: AgenticGenerationDependencies,
  active: ActiveAgenticGeneration,
  next: AgenticPhase,
  terminalReason?: string,
): Promise<void> {
  const previous = active.phase;
  if (previous !== next) {
    // A durable CAS is the authority. Do not move the in-memory marker ahead
    // of it: a failed transition must leave the catch path on the real phase.
    if (active.execution && deps.transitionExecution) {
      let transitioned: AgenticExecutionHandle | void;
      try {
        transitioned = await deps.transitionExecution(active.execution, previous, next, terminalReason);
      } catch (error) {
        const durablePhase = await readDurablePhase(deps, active);
        if (durablePhase) active.phase = durablePhase;
        throw error;
      }
      const returnedPhase = transitioned && typeof transitioned === "object"
        ? transitioned.phase
        : undefined;
      if (returnedPhase && returnedPhase !== next) {
        active.phase = returnedPhase;
        const code = returnedPhase === "CANCELLED"
          ? "agentic_cancelled"
          : returnedPhase === "TIMED_OUT"
            ? "agentic_timed_out"
            : returnedPhase === "EXHAUSTED"
              ? "agentic_work_exhausted"
              : returnedPhase === "COMMIT_FAILED"
                ? "agentic_commit_failed"
                : "agentic_internal_error";
        throw new AgenticGenerationError(
          code,
          "Agentic execution became terminal before the requested phase.",
          { phase: returnedPhase, retryable: returnedPhase === "FAILED" },
        );
      }
    }
    active.phase = next;
  }
  // Durable terminal CAS is only the cause authority. The single terminal
  // publisher owns every immutable terminal projection and Turn Session write;
  // routing FAILED/CANCELLED/etc. through the ordinary phase publisher first
  // would freeze a generic failed/internal_error snapshot before cause-aware
  // convergence can publish rejected, stopped, exhausted, or failed truth.
  if (deps.publishPhase && active.execution && !isTerminalAgenticPhase(next)) {
    const target = targetFor(active);
    const canonical = canonicalFor(active, next, "streaming");
    await deps.publishPhase({
      executionId: active.execution.id,
      userId: active.input.userId,
      chatId: active.input.chatId,
      phase: next,
      ...canonical,
      target,
    });
  }
}
async function readDurablePhase(
  deps: AgenticGenerationDependencies,
  active: ActiveAgenticGeneration,
): Promise<AgenticPhase | undefined> {
  try {
    if (active.execution && deps.readExecutionPhase) {
      const phase = await deps.readExecutionPhase(active.execution);
      if (typeof phase === "string" && (
        phase === "ASSEMBLE" || phase === "WORK" || phase === "COMPLETE"
        || phase === "RENDER" || phase === "PREPARE_COMMIT" || phase === "COMMITTING"
        || phase === "COMMITTED" || phase === "COMMIT_FAILED" || phase === "EXHAUSTED"
        || phase === "FAILED" || phase === "CANCELLED" || phase === "TIMED_OUT"
      )) return phase;
    }
    if (deps.readExecutionPhaseById) {
      const phase = await deps.readExecutionPhaseById(active.generationId, active.input.userId);
      if (typeof phase === "string" && (
        phase === "ASSEMBLE" || phase === "WORK" || phase === "COMPLETE"
        || phase === "RENDER" || phase === "PREPARE_COMMIT" || phase === "COMMITTING"
        || phase === "COMMITTED" || phase === "COMMIT_FAILED" || phase === "EXHAUSTED"
        || phase === "FAILED" || phase === "CANCELLED" || phase === "TIMED_OUT"
      )) return phase;
    }
  } catch {
    // A missing/partially-created row is represented by the in-memory phase.
  }
  return undefined;
}

function targetFor(active: ActiveAgenticGeneration): AgenticTargetSnapshot {
  if (active.execution?.target) return active.execution.target;
  return active.dependencies.getExecutionTarget?.(active.generationId) ?? targetFromInput(active.input);
}
function boundedAgenticId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= 256
    ? value
    : null;
}

function attemptLineageFor(
  generationId: string,
  input: AgenticGenerationInput,
  target: AgenticTargetSnapshot,
): AgentWorkAttemptLineageV1 {
  const source = input.attemptLineage && typeof input.attemptLineage === "object"
    ? input.attemptLineage as Record<string, unknown> : {};
  const createdAt = typeof source.createdAt === "number" && Number.isSafeInteger(source.createdAt) && source.createdAt >= 0
    ? source.createdAt : Date.now();
  return {
    version: 1,
    attemptId: boundedAgenticId(source.attemptId) ?? generationId,
    previousAttemptId: source.previousAttemptId === null ? null : boundedAgenticId(source.previousAttemptId),
    target: {
      chatId: input.chatId,
      generationType: target.generationType,
      messageId: target.messageId ?? null,
      swipeId: Number.isSafeInteger(target.swipeId) && (target.swipeId as number) >= 0 ? target.swipeId ?? null : null,
    },
    createdAt,
  };
}

function workPhaseForAgentic(phase: AgenticPhase, terminal: boolean): AgentWorkPhase {
  if (terminal) return "TERMINAL";
  if (phase === "ASSEMBLE") return "ASSEMBLE";
  if (phase === "WORK") return "WORK";
  if (phase === "COMPLETE") return "PREPARE_COMMIT";
  if (phase === "RENDER") return "RENDER";
  if (phase === "PREPARE_COMMIT" || phase === "COMMITTING") return "COMMIT";
  return "TERMINAL";
}

type CanonicalTerminalCause = "stopped" | "exhausted" | "rejected" | "failed";

function terminalCauseForCode(value: unknown): CanonicalTerminalCause | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toLowerCase();
  if (!code) return null;
  if (code === "decision_refresh_required") return "rejected";
  if (["cancelled", "canceled", "stopped", "user_stop", "accepted_cancellation", "agentic_cancelled"].includes(code)) {
    return "stopped";
  }
  if ([
    "timed_out",
    "timeout",
    "deadline_exceeded",
    "agentic_timed_out",
    "root_wall_clock_limit_exceeded",
  ].includes(code)) {
    return "failed";
  }
  if (
    code === "exhausted"
    || code === "budget_exhausted"
    || code === "budget_exceeded"
    || code === "limit_exceeded"
    || code === "agentic_work_exhausted"
    || code.endsWith("_limit_exceeded")
    || code.endsWith("_budget_exhausted")
    || code.endsWith("_budget_exceeded")
  ) {
    return "exhausted";
  }
  return "failed";
}

function hostDeadlineExceeded(
  active: ActiveAgenticGeneration,
  status: "streaming" | AgenticTerminalStatus,
  errorCode?: string,
): boolean {
  if (status !== "timed_out") return false;
  const code = typeof errorCode === "string" ? errorCode.trim().toLowerCase() : "";
  if (code && code !== "timed_out" && code !== "timeout" && code !== "agentic_timed_out") return false;
  const reason = active.controller.signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError";
}

function workOutcomeForStatus(
  active: ActiveAgenticGeneration,
  status: "streaming" | AgenticTerminalStatus,
  errorCode?: string,
): AgentWorkOutcome | null {
  if (status === "completed") return "completed";
  if (status === "rejected") return "rejected";
  if (status === "timed_out") return "failed";
  if (status === "exhausted") return "exhausted";
  if (status === "cancelled") return "stopped";
  const cause = terminalCauseForCode(errorCode);
  if (cause === "stopped") return active.cancellationRequested ? "stopped" : "failed";
  if (cause === "exhausted") return "exhausted";
  if (cause === "rejected") return "rejected";
  if (cause === "failed") return "failed";
  if (status === "failed") return "failed";
  return null;
}

function workReasonForStatus(
  active: ActiveAgenticGeneration,
  status: "streaming" | AgenticTerminalStatus,
  errorCode?: string,
): string | null {
  const outcome = workOutcomeForStatus(active, status, errorCode);
  if (outcome === null) return null;
  if (outcome === "completed") return null;
  if (outcome === "stopped") return "stopped";
  if (typeof errorCode === "string" && errorCode.trim().length > 0) return errorCode;
  if (outcome === "exhausted") return "exhausted";
  if (status === "timed_out") return "timed_out";
  if (outcome === "rejected") return "rejected";
  return "failed";
}
type AgenticTerminalPhase =
  | "COMMITTED"
  | "COMMIT_FAILED"
  | "EXHAUSTED"
  | "FAILED"
  | "CANCELLED"
  | "TIMED_OUT";

type DurableTerminalResult = {
  readonly status: AgenticTerminalStatus;
  readonly phase: AgenticTerminalPhase;
  readonly errorCode?: AgenticFailureCode | string;
};

function isTerminalAgenticPhase(phase: AgenticPhase): phase is AgenticTerminalPhase {
  return phase === "COMMITTED"
    || phase === "COMMIT_FAILED"
    || phase === "EXHAUSTED"
    || phase === "FAILED"
    || phase === "CANCELLED"
    || phase === "TIMED_OUT";
}

function durableTerminalResultForPhase(
  active: ActiveAgenticGeneration,
  phase: AgenticTerminalPhase,
  fallbackStatus: AgenticTerminalStatus,
  fallbackCode: AgenticFailureCode | string | undefined,
): DurableTerminalResult {
  if (phase === "COMMITTED") return { status: "completed", phase };
  if (phase === "CANCELLED") return { status: "cancelled", phase, errorCode: "agentic_cancelled" };
  if (phase === "TIMED_OUT") {
    return {
      status: "timed_out",
      phase,
      errorCode: hostDeadlineExceeded(active, "timed_out", fallbackCode)
        ? "root_wall_clock_limit_exceeded"
        : "agentic_timed_out",
    };
  }
  if (phase === "EXHAUSTED") return { status: "exhausted", phase, errorCode: "agentic_work_exhausted" };
  if (phase === "COMMIT_FAILED") return { status: "failed", phase, errorCode: "agentic_commit_failed" };
  if (phase === "FAILED") {
    if (fallbackCode === "decision_refresh_required") {
      return { status: "rejected", phase, errorCode: fallbackCode };
    }
    const staleTerminalCode = fallbackStatus === "failed"
      && fallbackCode
      && !["agentic_cancelled", "agentic_timed_out", "agentic_work_exhausted"].includes(fallbackCode)
      ? fallbackCode
      : "agentic_internal_error";
    return { status: "failed", phase, errorCode: staleTerminalCode };
  }
  return { status: "failed", phase, errorCode: "agentic_internal_error" };
}


function canonicalFor(
  active: ActiveAgenticGeneration,
  phase: AgenticPhase,
  status: "streaming" | AgenticTerminalStatus,
  errorCode?: string,
): Pick<AgenticGenerationResult, "workPhase" | "workStatus" | "workOutcome" | "reason" | "attemptLineage"> {
  const outcome = phase === "COMMITTED"
    ? "completed"
    : workOutcomeForStatus(active, status, errorCode);
  const terminal = outcome !== null;
  return {
    workPhase: workPhaseForAgentic(phase, terminal),
    workStatus: terminal
      ? "terminal"
      : phase === "COMPLETE" || phase === "PREPARE_COMMIT"
        ? "waiting"
        : "running",
    workOutcome: outcome,
    reason: workReasonForStatus(active, status, errorCode),
    attemptLineage: active.attemptLineage,
  };
}


function assertNotAborted(signal: AbortSignal, phase: AgenticPhase): void {
  if (!signal.aborted) return;
  const reason = signal.reason;
  if (reason instanceof AgenticGenerationError) throw reason;
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    throw new AgenticGenerationError("agentic_timed_out", "Agentic generation timed out.", { phase });
  }
  throw new AgenticGenerationError("agentic_cancelled", "Agentic generation cancelled.", { phase });
}

async function cancelAndJoinChildrenBeforeTerminal(
  active: ActiveAgenticGeneration,
  deps: AgenticGenerationDependencies,
  reason: "failed" | "stopped" | "cancelled" | "timed_out" | "exhausted" | "commit_failed",
): Promise<boolean> {
  if (active.execution && !active.controller.signal.aborted) {
    const code = reason === "timed_out"
      ? "agentic_timed_out"
      : reason === "stopped" || reason === "cancelled"
        ? "agentic_cancelled"
        : reason === "exhausted"
          ? "agentic_work_exhausted"
          : reason === "commit_failed"
            ? "agentic_commit_failed"
            : "agentic_internal_error";
    active.controller.abort(new AgenticGenerationError(code, "Agentic terminal cancellation.", {
      phase: active.phase,
    }));
  }
  if (!active.execution || !deps.cancelAndJoinChildren) return true;
  try {
    const joining = Promise.resolve(deps.cancelAndJoinChildren(active.execution, reason));
    const deadlineAt = active.execution.deadlineAt;
    if (deadlineAt === undefined) {
      await joining;
      return true;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        joining,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("agentic_child_join_timeout")), Math.max(0, deadlineAt - Date.now()));
        }),
      ]);
      return true;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  } catch {
    // The durable terminal CAS still wins, but surface a stable internal error
    // instead of pretending that every child reservation was joined.
    return false;
  }
}

async function runAgenticGenerationInternal(
  active: ActiveAgenticGeneration,
  deps: AgenticGenerationDependencies,
): Promise<AgenticInternalGenerationResult> {
  const { input, controller } = active;
  const signal = controller.signal;
  let decision: AgenticRuntimeDecision | undefined;
  let snapshot: AgenticAssemblySnapshot | undefined;
  let plan: AgenticAssemblyPlan | undefined;
  let work: AgenticWorkOutcome | undefined;
  let render: AgenticRenderOutcome | undefined;
  let prepared: AgenticPrepareOutcome | undefined;
  let receipt: AgenticCommitReceipt | undefined;
  let finalStatus: AgenticTerminalStatus = "failed";
  let finalCode: AgenticFailureCode | string | undefined;

  try {
    assertSupportedSurface(input);
    const target = targetFromInput(input);
    assertNotAborted(signal, "ASSEMBLE");
    if (input.runtimeDecisionToken) {
      if (!deps.consumeRuntimeToken) {
        throw new AgenticGenerationError("agentic_runtime_unavailable", "Agentic decision authority is unavailable.", { phase: "ASSEMBLE", retryable: true });
      }
      decision = await deps.consumeRuntimeToken(input, target, input.runtimeDecisionToken, signal);
    } else {
      if (!deps.resolveRuntime) {
        throw new AgenticGenerationError("agentic_runtime_unavailable", "Agentic decision authority is unavailable.", { phase: "ASSEMBLE", retryable: true });
      }
      decision = await deps.resolveRuntime(input, target, signal);
    }
    if (!decision || decision.mode === "response") {
      throw new AgenticGenerationError(
        "decision_refresh_required",
        "Agentic runtime decision is no longer valid.",
        { phase: "ASSEMBLE", retryable: true },
      );
    }
    assertNotAborted(signal, "ASSEMBLE");
    if (!active.execution && deps.createExecution) {
      active.execution = await deps.createExecution({
        executionId: active.generationId,
        userId: input.userId,
        chatId: input.chatId,
        target,
        decision,
        attemptLineage: active.attemptLineage,
        signal,
      });
    }
    if (deps.createExecution && !active.execution) {
      throw new AgenticGenerationError(
        "agentic_runtime_unavailable",
        "Agentic execution admission did not return a durable handle.",
        { phase: "ASSEMBLE", retryable: true },
      );
    }
    active.resolveAdmission();
    if (active.pendingCancellation) {
      active.pendingCancellation = false;
      const cancellation = await requestDurableCancellation(active, "stopped");
      if (cancellation !== true) {
        throw new AgenticGenerationError(
          cancellation === "too_late" ? "agentic_commit_failed" : "agentic_cancelled",
          cancellation === "too_late"
            ? "Agentic generation reached its terminal commit gate."
            : "Agentic generation was cancelled before provider dispatch.",
          { phase: "ASSEMBLE" },
        );
      }
    }
    await waitForDispatchAcknowledgement(active);
    assertNotAborted(signal, "ASSEMBLE");
    await transition(deps, active, "ASSEMBLE");

    const executionId = active.execution?.id ?? active.generationId;
    if (deps.assemble) {
      const assembled = await deps.assemble(input, decision, target, signal, executionId);
      snapshot = assembled.snapshot;
      plan = assembled.plan;
    } else {
      if (!deps.buildAssemblySnapshot || !deps.compileAssemblyPlan) {
        throw new AgenticGenerationError("agentic_runtime_unavailable", "Agentic assembly authority is unavailable.", { phase: "ASSEMBLE", retryable: true });
      }
      snapshot = await deps.buildAssemblySnapshot(input, decision, target, signal, executionId);
      plan = await deps.compileAssemblyPlan(snapshot, input, decision, signal, executionId);
    }
    if (!snapshot || !plan) {
      throw new AgenticGenerationError("agentic_preflight_failed", "Agentic assembly did not produce a plan.", { phase: "ASSEMBLE" });
    }
    assertNotAborted(signal, "ASSEMBLE");

    await transition(deps, active, "WORK");
    if (!deps.runWork) {
      throw new AgenticGenerationError("agentic_runtime_unavailable", "Agentic work authority is unavailable.", { phase: "WORK", retryable: true });
    }
    work = await deps.runWork({
      execution: active.execution ?? { id: input.chatId, signal },
      input,
      decision,
      snapshot,
      plan,
      signal,
    });
    if (work.status === "cancelled") throw new AgenticGenerationError("agentic_cancelled", "Agentic generation cancelled.", { phase: "WORK" });
    if (work.status === "timed_out") throw new AgenticGenerationError("agentic_timed_out", "Agentic generation timed out.", { phase: "WORK" });
    if (work.status === "exhausted") {
      const rawCode = typeof work.errorCode === "string" && work.errorCode.trim().length > 0 ? work.errorCode : "exhausted";
      console.error(`[agentic] WORK exhausted (${rawCode})`);
      throw new AgenticGenerationError("agentic_work_exhausted", `Agentic work budget exhausted (${rawCode}).`, { phase: "WORK" });
    }
    if (work.status === "failed") {
      const rawCode = typeof work.errorCode === "string" && work.errorCode.trim().length > 0 ? work.errorCode : "internal_error";
      const code = mapAgenticFailureCode(rawCode);
      const detail = typeof work.errorMessage === "string" && work.errorMessage.trim().length > 0 ? work.errorMessage.trim() : rawCode;
      console.error(`[agentic] WORK failed (${rawCode} → ${code}): ${detail}`);
      throw new AgenticGenerationError(code, `Agentic work failed (${rawCode}): ${detail}`, { phase: "WORK" });
    }
    assertNotAborted(signal, "WORK");

    await transition(deps, active, "COMPLETE");
    assertNotAborted(signal, "COMPLETE");

    await transition(deps, active, "RENDER");
    if (!deps.render) {
      throw new AgenticGenerationError("agentic_runtime_unavailable", "Agentic render authority is unavailable.", { phase: "RENDER", retryable: true });
    }
    render = await deps.render({
      execution: active.execution ?? { id: input.chatId, signal },
      input,
      decision,
      snapshot,
      plan,
      work,
      signal,
    });
    if (render.toolCalls && render.toolCalls.length > 0) {
      throw new AgenticGenerationError("agentic_protocol_failure", "Agentic finalization returned a tool call.", { phase: "RENDER" });
    }
    assertNotAborted(signal, "RENDER");

    await transition(deps, active, "PREPARE_COMMIT");
    if (!deps.prepareRender) {
      throw new AgenticGenerationError("agentic_runtime_unavailable", "Agentic render preparation authority is unavailable.", { phase: "PREPARE_COMMIT", retryable: true });
    }
    prepared = await deps.prepareRender({
      execution: active.execution ?? { id: input.chatId, signal },
      input,
      decision,
      snapshot,
      plan,
      work,
      render,
      signal,
    });
    assertNotAborted(signal, "PREPARE_COMMIT");
    if (!deps.commit) {
      throw new AgenticGenerationError("agentic_runtime_unavailable", "Agentic commit authority is unavailable.", { phase: "PREPARE_COMMIT", retryable: true });
    }
    assertNotAborted(signal, "PREPARE_COMMIT");
    receipt = await deps.commit({
      execution: active.execution ?? { id: input.chatId, signal },
      input,
      decision,
      snapshot,
      plan,
      work,
      render,
      prepared,
      signal,
    });
    if (!receipt?.receiptId) {
      throw new AgenticGenerationError("agentic_commit_failed", "Agentic commit did not produce a receipt.", { phase: "PREPARE_COMMIT" });
    }
    const durableAfterCommit = await readDurablePhase(deps, active);
    if (durableAfterCommit && durableAfterCommit !== "COMMITTED") {
      throw new AgenticGenerationError("agentic_commit_failed", "Agentic commit did not reach a durable terminal phase.", { phase: durableAfterCommit, retryable: true });
    }
    active.phase = "COMMITTED";
    finalStatus = "completed";
    return {
      generationId: active.execution?.id ?? active.generationId,
      status: "completed",
      mode: "agentic",
      phase: "COMMITTED",
      receipt,
      responseModeAvailable: true,
    };
  } catch (error) {
    if (!active.admissionSettled) active.rejectAdmission(error);
    console.error("[agentic] turn failed", active.phase, error);
    let phase = active.phase;
    const durablePhase = await readDurablePhase(deps, active);
    if (durablePhase === "COMMITTED") {
      active.phase = "COMMITTED";
      finalStatus = "completed";
      finalCode = undefined;
      return {
        generationId: active.execution?.id ?? active.generationId,
        status: "completed",
        mode: "agentic",
        phase: "COMMITTED",
        ...(receipt ? { receipt } : {}),
        responseModeAvailable: true,
      };
    }
    if (durablePhase === "COMMIT_FAILED" || durablePhase === "EXHAUSTED" || durablePhase === "FAILED" || durablePhase === "CANCELLED" || durablePhase === "TIMED_OUT") {
      active.phase = durablePhase;
      const durableErrorCode = asErrorCode(error);
      const durableFailureCode = durableErrorCode === "agentic_cancelled" && !active.cancellationRequested
        ? "agentic_internal_error"
        : durableErrorCode;
      const hostTimeout = durablePhase === "TIMED_OUT"
        && hostDeadlineExceeded(active, "timed_out", durableErrorCode);
      const acceptedCancellation = durablePhase === "CANCELLED";
      const rejectedBeforeWork = durablePhase === "FAILED"
        && phase === "ASSEMBLE"
        && durableFailureCode !== "agentic_cancelled"
        && durableFailureCode !== "agentic_timed_out";
      finalStatus = durablePhase === "CANCELLED"
        ? (acceptedCancellation ? "cancelled" : "failed")
        : durablePhase === "TIMED_OUT"
          ? "timed_out"
          : durablePhase === "EXHAUSTED"
            ? "exhausted"
            : rejectedBeforeWork
              ? "rejected"
              : "failed";
      finalCode = durablePhase === "CANCELLED"
        ? (acceptedCancellation ? "agentic_cancelled" : "agentic_internal_error")
        : durablePhase === "TIMED_OUT"
          ? (hostTimeout ? "root_wall_clock_limit_exceeded" : durableFailureCode)
          : durablePhase === "EXHAUSTED"
            ? "agentic_work_exhausted"
            : durablePhase === "COMMIT_FAILED"
              ? "agentic_commit_failed"
              : durableFailureCode;
      const joined = await cancelAndJoinChildrenBeforeTerminal(
        active,
        deps,
        durablePhase === "CANCELLED"
          ? (acceptedCancellation ? "cancelled" : "failed")
          : durablePhase === "TIMED_OUT"
            ? "timed_out"
            : durablePhase === "EXHAUSTED"
              ? "exhausted"
              : durablePhase === "COMMIT_FAILED"
                ? "commit_failed"
                : "failed",
      );
      if (!joined && finalCode !== "decision_refresh_required") finalCode = "agentic_internal_error";
      return {
        generationId: active.execution?.id ?? active.generationId,
        status: finalStatus,
        mode: "agentic",
        phase: durablePhase,
        errorCode: finalCode,
        errorMessage: error instanceof Error && error.message.trim().length > 0 ? error.message : undefined,
        responseModeAvailable: true,
      };
    }
    const wrapped = isAbort(error, signal)
      ? (isTimeout(error, signal)
        ? new AgenticGenerationError("agentic_timed_out", "Agentic generation timed out.", { phase })
        : new AgenticGenerationError("agentic_cancelled", "Agentic generation cancelled.", { phase }))
      : asPhaseError(error, phase);
    const hostTimeout = hostDeadlineExceeded(active, "timed_out", wrapped.code);
    const acceptedCancellation = wrapped.code === "agentic_cancelled" && active.cancellationRequested;
    finalCode = hostTimeout
      ? "root_wall_clock_limit_exceeded"
      : wrapped.code === "agentic_cancelled" && !acceptedCancellation
        ? "agentic_internal_error"
        : wrapped.code;
    const rejectedBeforeWork = phase === "ASSEMBLE"
      && wrapped.code !== "agentic_cancelled"
      && wrapped.code !== "agentic_timed_out"
      && wrapped.code !== "agentic_work_exhausted";
    finalStatus = wrapped.code === "agentic_timed_out"
      ? "timed_out"
      : wrapped.code === "agentic_cancelled"
        ? (acceptedCancellation ? "cancelled" : "failed")
        : wrapped.code === "agentic_work_exhausted"
          ? "exhausted"
          : rejectedBeforeWork
            ? "rejected"
            : "failed";
    const commitPhase = phase === "COMMITTING";
    if (commitPhase) finalCode = "agentic_commit_failed";
    const terminalPhase: AgenticPhase = finalStatus === "cancelled"
      ? "CANCELLED"
      : finalStatus === "timed_out"
        ? "TIMED_OUT"
        : finalStatus === "exhausted"
          ? "EXHAUSTED"
          : commitPhase
            ? "COMMIT_FAILED"
            : "FAILED";
    const joined = await cancelAndJoinChildrenBeforeTerminal(
      active,
      deps,
      finalStatus === "cancelled"
        ? "cancelled"
        : finalStatus === "timed_out"
          ? "timed_out"
          : finalStatus === "exhausted"
            ? "exhausted"
            : commitPhase
              ? "commit_failed"
              : "failed",
    );
    if (!joined && finalCode !== "decision_refresh_required") finalCode = "agentic_internal_error";
    let publishedStatus: AgenticTerminalStatus = finalStatus;
    let publishedPhase: AgenticPhase = terminalPhase;
    let publishedCode: AgenticFailureCode | string | undefined = finalCode;
    try {
      await transition(
        deps,
        active,
        terminalPhase,
        finalCode === "decision_refresh_required"
          ? finalCode
          : finalStatus === "rejected" ? "invalid_input" : finalCode,
      );
    } catch (transitionError) {
      const durableAfterTransition = await readDurablePhase(deps, active);
      const transitionPhase = transitionError instanceof AgenticGenerationError
        ? transitionError.phase
        : undefined;
      const winnerPhase = [durableAfterTransition, transitionPhase]
        .find((candidate): candidate is AgenticTerminalPhase => candidate !== undefined && isTerminalAgenticPhase(candidate));
      if (winnerPhase) {
        active.phase = winnerPhase;
        const winner = durableTerminalResultForPhase(active, winnerPhase, finalStatus, finalCode);
        publishedStatus = winner.status;
        publishedPhase = winner.phase;
        publishedCode = winner.errorCode;
      } else {
        if (durableAfterTransition) active.phase = durableAfterTransition;
        if (finalCode !== "decision_refresh_required") {
          publishedCode = asErrorCode(transitionError);
        }
      }
    }
    return {
      generationId: active.execution?.id ?? active.generationId,
      status: publishedStatus,
      mode: "agentic",
      phase: publishedPhase,
      errorCode: publishedCode,
      errorMessage: wrapped.message,
      responseModeAvailable: true,
    };
  } finally {
    // Publication and cleanup are ordered by the outer owner so the terminal
    // projection can retain the immutable target binding.
    active.terminal = true;
  }
}

/**
 * Run one closed Agentic turn. This function is intentionally dependency-injected:
 * strict preprocessing, turn persistence, provider work, projection, and commit
 * remain separate authorities and can be tested without a live provider.
 */
export async function runAgenticGeneration(
  input: AgenticGenerationInput,
  deps?: AgenticGenerationDependencies,
): Promise<AgenticGenerationResult> {
  const resolvedDeps = resolveDependencies(deps);
  let target: AgenticTargetSnapshot;
  try {
    target = targetFromInput(input);
    assertSupportedSurface(input);
  } catch (error) {
    if (
      error instanceof AgenticGenerationError
      && error.code === "agentic_unsupported_surface"
      && input.runtimeDecisionToken
    ) {
      if (!resolvedDeps.claimRuntimeToken) {
        throw new AgenticGenerationError(
          "agentic_runtime_unavailable",
          "Agentic decision authority is unavailable.",
          { phase: "ASSEMBLE", retryable: true },
        );
      }
      await resolvedDeps.claimRuntimeToken(
        input,
        input.runtimeDecisionToken,
        input.signal ?? new AbortController().signal,
      );
    }
    throw error;
  }
  const generationId = crypto.randomUUID();
  const attemptLineage = attemptLineageFor(generationId, input, target);
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(input.signal?.reason ?? new DOMException("Aborted", "AbortError"));
  if (input.signal) {
    if (input.signal.aborted) abortFromRequest();
    else input.signal.addEventListener("abort", abortFromRequest, { once: true });
  }
  let resolve!: (result: AgenticGenerationResult) => void;
  const completion = new Promise<AgenticGenerationResult>((resolveCompletion) => {
    resolve = resolveCompletion;
  });
  let resolveAdmissionPromise!: () => void;
  let rejectAdmissionPromise!: (reason?: unknown) => void;
  let admissionSettled = false;
  let activeAdmissionOwner: ActiveAgenticGeneration | undefined;
  const admission = new Promise<void>((resolveAdmission, rejectAdmission) => {
    resolveAdmissionPromise = resolveAdmission;
    rejectAdmissionPromise = rejectAdmission;
  });
  // A normal Send does not await admission, but a rejected admission must
  // still be marked handled while Retry awaits the same promise.
  void admission.catch(() => undefined);
  const resolveAdmission = (): void => {
    if (admissionSettled) return;
    admissionSettled = true;
    if (activeAdmissionOwner) activeAdmissionOwner.admissionSettled = true;
    resolveAdmissionPromise();
  };
  const rejectAdmission = (reason?: unknown): void => {
    if (admissionSettled) return;
    admissionSettled = true;
    if (activeAdmissionOwner) activeAdmissionOwner.admissionSettled = true;
    rejectAdmissionPromise(reason);
  };
  let resolveDispatchAcknowledgementPromise!: () => void;
  const dispatchAcknowledgement = new Promise<void>((resolveDispatchAcknowledgement) => {
    resolveDispatchAcknowledgementPromise = resolveDispatchAcknowledgement;
  });
  const resolveDispatchAcknowledgement = (): boolean => {
    const owner = activeAdmissionOwner;
    if (!owner || owner.dispatchAcknowledged || owner.dispatchAcknowledgementExpired) return false;
    owner.dispatchAcknowledged = true;
    resolveDispatchAcknowledgementPromise();
    return true;
  };
  const active: ActiveAgenticGeneration = {
    generationId,
    input,
    dependencies: resolvedDeps,
    controller,
    completion,
    resolve,
    admission,
    resolveAdmission,
    rejectAdmission,
    admissionSettled: false,
    dispatchAcknowledgement,
    resolveDispatchAcknowledgement,
    dispatchAcknowledged: false,
    dispatchAcknowledgementExpired: false,
    phase: "ASSEMBLE",
    attemptLineage,
    terminal: false,
    pendingCancellation: false,
    cancellationRequested: false,
  };
  activeAdmissionOwner = active;
  if (!input.requireDispatchAcknowledgement) resolveDispatchAcknowledgement();
  const chatKey = `${input.userId}:${input.chatId}`;
  const existingGenerationId = activeAgenticChats.get(chatKey);
  if (existingGenerationId) {
    const existing = activeAgenticGenerations.get(existingGenerationId);
    if (existing && !existing.terminal) {
      throw new AgenticGenerationError(
        "agentic_chat_busy",
        "An Agentic generation is already active for this chat.",
        { phase: "ASSEMBLE", retryable: true },
      );
    }
    activeAgenticChats.delete(chatKey);
  }
  activeAgenticGenerations.set(generationId, active);
  agenticAdmissions.set(generationId, admission);
  activeAgenticChats.set(chatKey, generationId);
  // Keep the requested generation ID stable across status/stop/projection surfaces.
  // The execution service may use its own durable ID; callers always use this ID.
  void (async () => {
    let projected: AgenticGenerationResult;
    try {
      const result = await runAgenticGenerationInternal(active, resolvedDeps);
      projected = {
        ...result,
        generationId,
        ...canonicalFor(active, result.phase, result.status, result.errorCode),
      };
    } catch (error) {
      // The internal runner normally converts failures into terminal results.
      // Keep the detached owner settling even if an unexpected adapter error
      // escapes that conversion.
      if (!active.admissionSettled) active.rejectAdmission(error);
      const escapedStatus: AgenticTerminalStatus = active.phase === "ASSEMBLE" ? "rejected" : "failed";
      projected = {
        generationId,
        status: escapedStatus,
        mode: "agentic",
        phase: active.phase,
        ...canonicalFor(active, active.phase, escapedStatus, asErrorCode(error)),
        errorCode: asErrorCode(error),
        errorMessage: error instanceof Error && error.message.trim().length > 0 ? error.message : undefined,
        responseModeAvailable: true,
      };
    }
    const terminalTarget = active.execution?.target
      ?? resolvedDeps.getExecutionTarget?.(generationId)
      ?? target;
    active.terminal = true;
    const terminalStatus = projected.status === "streaming" ? "failed" : projected.status;
    const terminalCanonical = canonicalFor(active, projected.phase, terminalStatus, projected.errorCode);
    const terminalEvent = {
      executionId: generationId,
      userId: input.userId,
      chatId: input.chatId,
      status: terminalStatus,
      phase: projected.phase,
      ...terminalCanonical,
      target: terminalTarget,
      ...(projected.receipt ? { receipt: projected.receipt } : {}),
      ...(projected.errorCode ? { errorCode: projected.errorCode } : {}),
      ...(projected.errorMessage ? { errorMessage: projected.errorMessage } : {}),
      ...(projected.retryable ? { retryable: true } : {}),
    };
    const suppressPhantomRetryPublication = active.attemptLineage.previousAttemptId !== null && !active.execution;
    if (!suppressPhantomRetryPublication) {
      try {
        if (resolvedDeps.publishTerminal) await resolvedDeps.publishTerminal(terminalEvent);
      } catch (error) {
        // The durable execution remains the terminal authority. Atomic
        // reconciliation is idempotent and startup recovery may complete it;
        // never replace the WORK/COMMIT cause with a projection-layer cause.
        console.error("[agentic] terminal convergence deferred", error);
      }
    }
    try {
      await resolvedDeps.cleanup?.({
        execution: active.execution,
        executionId: generationId,
        input,
        phase: projected.phase,
        status: projected.status === "streaming" ? "failed" : projected.status,
      });
    } catch {
      // Cleanup is best-effort after durable terminal publication.
    }
    settledAgenticGenerations.set(generationId, projected);
    if (settledAgenticGenerations.size > 256) {
      const oldest = settledAgenticGenerations.keys().next().value;
      if (typeof oldest === "string") settledAgenticGenerations.delete(oldest);
    }
    if (agenticAdmissions.size > 256) {
      const oldestAdmission = agenticAdmissions.keys().next().value;
      if (typeof oldestAdmission === "string") agenticAdmissions.delete(oldestAdmission);
    }
    active.resolveDispatchAcknowledgement();
    active.resolve(projected);
    activeAgenticGenerations.delete(generationId);
    if (activeAgenticChats.get(`${input.userId}:${input.chatId}`) === generationId) {
      activeAgenticChats.delete(`${input.userId}:${input.chatId}`);
    }
    if (input.signal) input.signal.removeEventListener("abort", abortFromRequest);
  })();
  return {
    generationId,
    status: "streaming",
    mode: "agentic",
    phase: "ASSEMBLE",
    workPhase: "ADMIT",
    workStatus: "pending",
    workOutcome: null,
    reason: null,
    attemptLineage,
    responseModeAvailable: true,
  };
}

/** Start an Agentic turn and return before provider work begins. */
export async function startAgenticGeneration(
  input: AgenticGenerationInput,
  deps?: AgenticGenerationDependencies,
): Promise<AgenticGenerationResult> {
  return runAgenticGeneration(input, deps);
}

export function acknowledgeAgenticGenerationDispatch(
  userId: string,
  generationId: string,
): AgenticDispatchAcknowledgementState | false {
  const active = activeAgenticGenerations.get(generationId);
  if (!active || active.input.userId !== userId || active.terminal) return false;
  if (active.dispatchAcknowledged) return "already_acknowledged";
  return active.resolveDispatchAcknowledgement() ? "accepted" : false;
}

/** Wait for a detached turn in focused tests or recovery workers. */
export async function waitForAgenticGeneration(
  generationId: string,
): Promise<AgenticGenerationResult | undefined> {
  const active = activeAgenticGenerations.get(generationId);
  return active?.completion ?? settledAgenticGenerations.get(generationId);
}

/** Wait until the durable execution row for a generation has been admitted. */
export async function waitForAgenticGenerationAdmission(
  generationId: string,
): Promise<void> {
  const admission = agenticAdmissions.get(generationId);
  if (!admission) {
    if (settledAgenticGenerations.has(generationId)) return;
    throw new AgenticGenerationError(
      "agentic_runtime_unavailable",
      "Agentic execution admission is unavailable.",
      { phase: "ASSEMBLE", retryable: true },
    );
  }
  await admission;
}

/**
 * Explicit user Retry. Validation of ownership, prior outcome, and the live
 * target happens in the projection authority before this function is called.
 * This function only enters the same canonical Agentic admission runner and
 * waits until its real durable execution exists.
 */
export async function retryAgenticGeneration(
  input: AgenticGenerationInput,
  previousAttemptId: string,
  deps?: AgenticGenerationDependencies,
): Promise<AgenticGenerationResult> {
  const previous = boundedAgenticId(previousAttemptId);
  if (!previous) {
    throw new AgenticGenerationError(
      "agentic_preflight_failed",
      "Retry requires a valid previous attempt.",
      { phase: "ASSEMBLE" },
    );
  }
  const resolvedDeps = resolveDependencies(deps);
  if (!resolvedDeps.createExecution) {
    throw new AgenticGenerationError(
      "agentic_runtime_unavailable",
      "Agentic execution admission is unavailable.",
      { phase: "ASSEMBLE", retryable: true },
    );
  }
  targetFromInput(input);
  const started = await startAgenticGeneration({
    ...input,
    attemptLineage: { previousAttemptId: previous },
  }, resolvedDeps);
  await waitForAgenticGenerationAdmission(started.generationId);
  return started;
}

async function requestDurableCancellation(
  active: ActiveAgenticGeneration,
  reason: "stopped" | "cancelled" | "timed_out" = "stopped",
): Promise<boolean | "too_late"> {
  if (active.terminal) return false;
  if (active.cancellationInFlight) return active.cancellationInFlight;
  if (active.cancellationRequested) return false;
  if (!active.execution) {
    // Admission has not created a durable row yet. Keep the intent and let the
    // creator perform the owner-scoped CAS before touching the live signal.
    if (active.pendingCancellation) return false;
    active.pendingCancellation = true;
    return true;
  }
  if (!active.dependencies.requestCancellation) return false;
  const inFlight = Promise.resolve(
    active.dependencies.requestCancellation(active.execution, reason),
  ).then(async (accepted) => {
    let acceptedCancellation = accepted === true;
    if (acceptedCancellation && active.dependencies.readExecutionPhase) {
      const phase = await active.dependencies.readExecutionPhase(active.execution!);
      if (phase === "TIMED_OUT" || phase === "EXHAUSTED" || phase === "FAILED" || phase === "COMMIT_FAILED") {
        acceptedCancellation = false;
      }
    }
    if (acceptedCancellation) {
      active.cancellationRequested = true;
      abortControllerForAcceptedCancellation(active);
    }
    return acceptedCancellation ? true : accepted;
  }).catch((error: unknown) => {
    let code: unknown;
    if (error && typeof error === "object" && "code" in error) code = error.code;
    return code === "too_late" ? "too_late" as const : false;
  });
  active.cancellationInFlight = inFlight;
  void inFlight.finally(() => {
    if (active.cancellationInFlight === inFlight) active.cancellationInFlight = undefined;
  });
  return inFlight;
}

function abortControllerForAcceptedCancellation(
  active: ActiveAgenticGeneration,
): boolean {
  active.controller.abort(
    new AgenticGenerationError(
      "agentic_cancelled",
      "Agentic generation cancelled.",
      { phase: active.phase },
    ),
  );
  return true;
}

/** Return the active Agentic generation for one chat without exposing private state. */
export function getActiveAgenticGenerationForChat(
  userId: string,
  chatId: string,
): string | undefined {
  const id = activeAgenticChats.get(`${userId}:${chatId}`);
  const active = id ? activeAgenticGenerations.get(id) : undefined;
  return active && active.input.userId === userId && !active.terminal ? id : undefined;
}

/** Resolve the chat bound to an active generation for cross-mode Stop. */
export function getActiveAgenticGenerationContext(
  userId: string,
  generationId: string,
): { readonly chatId: string } | undefined {
  const active = activeAgenticGenerations.get(generationId);
  if (!active || active.input.userId !== userId || active.terminal) return undefined;
  return { chatId: active.input.chatId };
}

/** Abort only after the coordinator has durably accepted cancellation. */
export function abortAcceptedAgenticGeneration(
  userId: string,
  generationId: string,
): boolean {
  const active = activeAgenticGenerations.get(generationId);
  if (!active || active.input.userId !== userId || active.terminal) return false;
  active.cancellationRequested = true;
  return abortControllerForAcceptedCancellation(active);
}

/**
 * User-facing exact Stop. Durable ownership must be accepted before the live
 * controller is aborted. Durable cancellation is the sole too-late authority.
 */
export async function requestAgenticGenerationCancellation(
  userId: string,
  generationId: string,
): Promise<boolean | "too_late"> {
  const active = activeAgenticGenerations.get(generationId);
  if (!active || active.input.userId !== userId || active.terminal) return false;
  return requestDurableCancellation(active, "stopped");
}

export async function requestAgenticChatCancellation(
  userId: string,
  chatId: string,
): Promise<boolean | "too_late"> {
  const id = activeAgenticChats.get(`${userId}:${chatId}`);
  return id ? requestAgenticGenerationCancellation(userId, id) : false;
}
export async function stopAgenticUserGenerations(userId: string): Promise<boolean | "too_late"> {
  let accepted = false;
  let tooLate = false;
  const generationIds = [...activeAgenticGenerations.values()]
    .filter((active) => active.input.userId === userId && !active.terminal)
    .map((active) => active.generationId);
  for (const generationId of generationIds) {
    const result = await requestAgenticGenerationCancellation(userId, generationId);
    if (result === true) accepted = true;
    else if (result === "too_late") tooLate = true;
  }
  return accepted ? true : tooLate ? "too_late" : false;
}

export async function stopAllAgenticGenerations(): Promise<boolean | "too_late"> {
  let accepted = false;
  let tooLate = false;
  const activeGenerations = [...activeAgenticGenerations.values()]
    .filter((active) => !active.terminal)
    .map((active) => ({ userId: active.input.userId, generationId: active.generationId }));
  for (const active of activeGenerations) {
    const result = await requestAgenticGenerationCancellation(active.userId, active.generationId);
    if (result === true) accepted = true;
    else if (result === "too_late") tooLate = true;
  }
  return accepted ? true : tooLate ? "too_late" : false;
}


export function getActiveAgenticGenerationCount(): number {
  return activeAgenticGenerations.size;
}

export function getActiveAgenticGeneration(userId: string, generationId: string): AgenticGenerationResult | undefined {
  const active = activeAgenticGenerations.get(generationId);
  if (!active || active.input.userId !== userId) return undefined;
  return {
    generationId,
    status: "streaming",
    mode: "agentic",
    phase: active.phase,
    ...canonicalFor(active, active.phase, "streaming"),
    responseModeAvailable: true,
  };
}

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyFeatureMigrationsThrough, createPreBundleDatabase } from "../db/migrations/test-helpers";
import type {
  AgenticWorkMutatingWorkspaceOperationKindV1,
  AgenticWorkWorkspaceMutationReservationV1,
  WorkSegmentAllOptionalPhasesSkippedAuthorityV1,
  WorkSegmentContextV1,
  WorkSegmentSkippedPhaseDecisionAuthorityV1,
  WorkSegmentUsageV1,
} from "../types/agent-work-segment";
import { encodeCanonicalPlainData } from "../utils/canonical-plain-data";
import { computeWorkSegmentContextDigestV1 } from "./agentic-work-phase.service";
import {
  WORK_CANCELLATION_TERMINAL_CLOSE_GRACE_MS,
  AgenticWorkSegmentRepositoryError,
  admitWorkSegmentV1,
  persistWorkSegmentChildAssignmentAuthorityV1,
  appendSettledWorkSegmentDispatchMutationReservationsV1,
  claimQueuedWorkCompletionRecoveryV1,
  claimQueuedWorkSegmentRecoveryV1,
  closeAdmittedWorkSegmentWithoutDispatchTerminalV1,
  closeWorkSegmentTerminalV1,
  commitWorkSegmentTransitionV1,
  computeWorkPhasePlanDigestV1,
  computeWorkTransitionDecisionDigestV1,
  computeWorkSegmentResumeEnvelopeDigestV1,
  createAndAdmitInitialWorkSegmentV1,
  finalizeSettledWorkSegmentDispatchEffectsV1,
  createWorkSegmentAttemptV1,
  interruptUnsettledWorkSegmentDispatchV1,
  readWorkSegmentInspectionChainV1,
  readWorkSegmentRecoveryChainV1,
  listQueuedWorkCompletionRecoveriesV1,
  readWorkSegmentWorkspaceAuthorityV1,
  listQueuedWorkSegmentRecoveriesV1,
  reconcileWorkSegmentRecoveryAtStartupV1,
  reclaimReservedWorkSegmentDispatchV1,
  renewInFlightWorkSegmentDispatchLeaseV1,
  renewWorkExecutionOwnerLeaseV1,
  renewWorkSegmentOwnerLeaseV1,
  reserveWorkSegmentDispatchV1,
  settleWorkSegmentDispatchV1,
  startWorkSegmentDispatchV1,
  type AdmitWorkSegmentInputV1,
  type CommitWorkSegmentTransitionInputV1,
  type CreateAndAdmitInitialWorkSegmentInputV1,
  type CreateWorkSegmentAttemptInputV1,
  type ReserveWorkSegmentDispatchInputV1,
  type SettleWorkSegmentDispatchInputV1,
  type StartWorkSegmentDispatchInputV1,
} from "./agentic-work-segment.repository";
import { reconcileAgentTurns } from "./turn-execution.service";

interface RepositoryFixtureV1 {
  readonly userId: string;
  readonly chatId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly ownerToken: string;
  readonly characterId: string;
  readonly generationId: string;
  readonly commitKey: string;
}

const DEFAULT_FIXTURE: RepositoryFixtureV1 = Object.freeze({
  userId: "segment-user",
  chatId: "segment-chat",
  executionId: "segment-execution",
  attemptId: "segment-attempt",
  workspaceId: "segment-workspace",
  ownerToken: "segment-owner",
  characterId: "segment-character",
  generationId: "segment-generation",
  commitKey: "segment-commit",
});
const USER = DEFAULT_FIXTURE.userId;
const OTHER_USER = "other-segment-user";
const CHAT = DEFAULT_FIXTURE.chatId;
const EXECUTION = DEFAULT_FIXTURE.executionId;
const ATTEMPT = DEFAULT_FIXTURE.attemptId;
const WORKSPACE = DEFAULT_FIXTURE.workspaceId;
const OWNER = DEFAULT_FIXTURE.ownerToken;
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
function canonicalHash(value: unknown): string {
  return createHash("sha256").update(encodeCanonicalPlainData(value), "utf8").digest("hex");
}
function capabilityDigest(capabilities: readonly string[]): string {
  return canonicalHash({ version: 1, admittedCapabilities: [...new Set(capabilities)].sort() });
}
const RESEARCH_REF = Object.freeze({
  kind: "loom_block" as const, blockId: "research-instruction", presetRevision: 1, blockRevision: 1, promptOrder: 0,
});
const DRAFT_REF = Object.freeze({
  kind: "loom_block" as const, blockId: "draft-instruction", presetRevision: 1, blockRevision: 1, promptOrder: 1,
});
const CUSTOM_PHASES = Object.freeze([
  Object.freeze({
    version: 1 as const, id: "research", label: "Research", instructionRefs: Object.freeze([RESEARCH_REF]),
    childInstructionSubsets: Object.freeze([]), required: true,
    enter: Object.freeze({ kind: "phase", value: "WORK" }), exit: Object.freeze({ kind: "phase", value: "WORK" }),
    capabilityRequests: Object.freeze(["workspace_read"]), repeatLimit: 0, nextPhaseIds: Object.freeze(["draft"]),
    index: 0, sourceStatus: "verified" as const,
    sourceIdentity: Object.freeze([{ blockId: RESEARCH_REF.blockId, presetRevision: 1, blockRevision: 1, promptOrder: 0 }]),
    childInstructionSubsetIdentity: Object.freeze([]),
  }),
  Object.freeze({
    version: 1 as const, id: "draft", label: "Draft", instructionRefs: Object.freeze([DRAFT_REF]),
    childInstructionSubsets: Object.freeze([]), required: true,
    enter: Object.freeze({ kind: "phase", value: "WORK" }), exit: Object.freeze({ kind: "phase", value: "WORK" }),
    capabilityRequests: Object.freeze(["delegation"]), repeatLimit: 0, nextPhaseIds: Object.freeze([]),
    index: 1, sourceStatus: "verified" as const,
    sourceIdentity: Object.freeze([{ blockId: DRAFT_REF.blockId, presetRevision: 1, blockRevision: 1, promptOrder: 1 }]),
    childInstructionSubsetIdentity: Object.freeze([]),
  }),
]);
function phaseTransitionDigest(phase: typeof CUSTOM_PHASES[number], index: number): string {
  return canonicalHash({
    version: 1, id: phase.id, index, enter: phase.enter, exit: phase.exit,
    capabilityRequests: phase.capabilityRequests, repeatLimit: phase.repeatLimit,
    nextPhaseIds: phase.nextPhaseIds, sourceStatus: phase.sourceStatus, sourceIdentity: phase.sourceIdentity,
  });
}
const PHASE_PLAN = Object.freeze({
  version: 1 as const,
  phases: Object.freeze(CUSTOM_PHASES.map((phase, index) => Object.freeze({
    id: phase.id,
    index,
    required: phase.required,
    nextPhaseIds: Object.freeze([...(phase.nextPhaseIds.length > 0
      ? new Set(phase.nextPhaseIds)
      : CUSTOM_PHASES[index + 1] ? new Set([CUSTOM_PHASES[index + 1]!.id]) : new Set<string>())].sort()),
    repeatLimit: phase.repeatLimit,
    transitionAuthorityDigest: phaseTransitionDigest(phase, index),
    skipEligibilityDigest: null,
  }))),
});
const PHASE_PLAN_DIGEST = computeWorkPhasePlanDigestV1(PHASE_PLAN);
const ALL_SKIPPED_PHASE_PLAN: CreateWorkSegmentAttemptInputV1["phasePlan"] = Object.freeze({
  version: 1,
  phases: Object.freeze([
    Object.freeze({
      id: "optional_research",
      index: 0,
      required: false,
      nextPhaseIds: Object.freeze(["optional_draft"]),
      repeatLimit: 0,
      transitionAuthorityDigest: DIGEST_A,
      skipEligibilityDigest: DIGEST_B,
    }),
    Object.freeze({
      id: "optional_draft",
      index: 1,
      required: false,
      nextPhaseIds: Object.freeze([]),
      repeatLimit: 0,
      transitionAuthorityDigest: DIGEST_B,
      skipEligibilityDigest: DIGEST_C,
    }),
  ]),
});
const ALL_SKIPPED_PHASE_PLAN_DIGEST = computeWorkPhasePlanDigestV1(ALL_SKIPPED_PHASE_PLAN);
const ATTEMPT_CAPABILITY_DIGEST = capabilityDigest(CUSTOM_PHASES.flatMap((phase) => [...phase.capabilityRequests]));
const RESEARCH_CAPABILITY_DIGEST = capabilityDigest(["workspace_read"]);
const DRAFT_CAPABILITY_DIGEST = capabilityDigest(["delegation"]);
const FORGED_COLLAPSED_PHASE_PLAN = Object.freeze({
  version: 1 as const,
  phases: Object.freeze([
    Object.freeze({ id: "research", index: 0, required: true, nextPhaseIds: Object.freeze(["bridge"]), repeatLimit: 0, transitionAuthorityDigest: DIGEST_A, skipEligibilityDigest: null }),
    Object.freeze({ id: "bridge", index: 1, required: false, nextPhaseIds: Object.freeze([]), repeatLimit: 0, transitionAuthorityDigest: DIGEST_B, skipEligibilityDigest: DIGEST_C }),
    Object.freeze({ id: "draft", index: 2, required: false, nextPhaseIds: Object.freeze([]), repeatLimit: 0, transitionAuthorityDigest: DIGEST_C, skipEligibilityDigest: DIGEST_A }),
  ]),
});
const FORGED_COLLAPSED_PHASE_PLAN_DIGEST = computeWorkPhasePlanDigestV1(FORGED_COLLAPSED_PHASE_PLAN);
let db: Database;

const USAGE: WorkSegmentUsageV1 = Object.freeze({
  providerDispatches: 1,
  providerInputTokens: 10,
  providerOutputTokens: 5,
  providerTotalTokens: 15,
  billedOutputTokens: 5,
  toolCalls: 0,
  workspaceOperations: 0,
  unsignedBoundaries: 1,
  receiveBytes: 100,
  publishedOutputBytes: 0,
});

const ATTEMPT_BUDGET: CreateWorkSegmentAttemptInputV1["budget"] = Object.freeze({
  maxSegments: 4,
  maxProviderDispatches: 4,
  maxProviderOutputTokens: 100,
  maxOutputTokensPerDispatch: 25,
  maxUnsignedBoundaries: 4,
  maxToolCalls: 4,
  maxWorkspaceOperations: 4,
  recoveryReserveOutputTokens: 10,
  futurePhaseReserveOutputTokens: 20,
});

function paginationFixture(index: number): RepositoryFixtureV1 {
  const suffix = index.toString().padStart(4, "0");
  return Object.freeze({
    ...DEFAULT_FIXTURE,
    executionId: "pagination-execution-" + suffix,
    attemptId: "pagination-attempt-" + suffix,
    workspaceId: "pagination-workspace-" + suffix,
    generationId: "pagination-generation-" + suffix,
    commitKey: "pagination-commit-" + suffix,
  });
}

function seedAuthority(
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
  seedPrincipals = true,
): void {
  if (seedPrincipals) {
    db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?), (?, ?, ?)').run(
      fixture.userId,
      "Segment User",
      "segment-user@example.test",
      OTHER_USER,
      "Other Segment User",
      "other-segment-user@example.test",
    );
    db.query("INSERT INTO characters (id, name) VALUES (?, ?)")
      .run(fixture.characterId, "Segment Character");
    db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)")
      .run(fixture.chatId, fixture.userId, fixture.characterId, "Segment Chat");
  }
  const targetSnapshot = encodeCanonicalPlainData({
    attemptLineage: {
      version: 1,
      attemptId: fixture.attemptId,
      previousAttemptId: null,
      target: {
        chatId: fixture.chatId,
        generationType: "normal",
        messageId: null,
        swipeId: null,
      },
      createdAt: 1,
    },
  });
  db.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision,
     target_snapshot_json, mode, runtime_epoch, deadline_at, state, cas_revision,
     cas_owner, cas_expires_at, root_ledger_json, frame_capabilities_json,
     workspace_id, workspace_revision, commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, ?, 'agentic', 1, 5000, 'WORK', 0, ?, 5000,
            '{}', '{}', ?, 0, ?, 5000)`)
    .run(
      fixture.executionId,
      fixture.userId,
      fixture.chatId,
      fixture.generationId,
      targetSnapshot,
      fixture.ownerToken,
      fixture.workspaceId,
      fixture.commitKey,
    );
  db.query(`INSERT INTO agent_turn_workspaces
    (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
     constraints_json, state, revision, operation_caps_json, field_caps_json,
     retention, expires_at, quota_tasks, quota_records, quota_submissions,
     quota_artifacts, quota_bytes)
    VALUES (?, ?, ?, ?, ?, 'Segment objective', '[]', 'active', 0, '{}', '{}',
            'turn_terminal', 5000, 10, 10, 10, 10, 1000000)`)
    .run(
      fixture.workspaceId,
      fixture.executionId,
      fixture.executionId,
      fixture.userId,
      fixture.chatId,
    );
  db.query(`INSERT INTO agent_run_attempts
    (user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
     lifecycle, status, outcome, reason, terminal, started_at, updated_at,
     host_correlation_id, reconciliation_state)
    VALUES (?, ?, ?, ?, ?, ?, 'normal', 'WORK', 'running', NULL, 'none', 0, 1, 1,
            ?, 'authoritative')`)
    .run(
      fixture.userId,
      fixture.chatId,
      fixture.attemptId,
      fixture.generationId,
      fixture.executionId,
      fixture.generationId,
      "workspace-attempt:" + fixture.attemptId,
    );
}
function seedHandoffTaskAuthority(): void {
  const insertTask = db.query(`INSERT INTO agent_workspace_tasks
    (task_id, workspace_id, turn_id, user_id, chat_id, title, state, required, byte_count, retention, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'turn_terminal', 5000)`);
  for (const [id, state, required] of [
    ["task-a", "completed", 0],
    ["task-b", "completed", 0],
    ["required-a", "completed", 1],
    ["required-b", "pending", 1],
  ] as const) {
    insertTask.run(id, WORKSPACE, EXECUTION, USER, CHAT, id, state, required);
  }
  const insertSubmission = db.query(`INSERT INTO agent_workspace_submissions
    (submission_id, task_id, workspace_id, turn_id, user_id, chat_id, child_frame_id,
     state, summary, result_digest, byte_count, retention, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, 1, 'turn_terminal', 5000)`);
  insertSubmission.run("submission-a", "task-a", WORKSPACE, EXECUTION, USER, CHAT, "frame-a", "accepted-a", DIGEST_A);
  insertSubmission.run("submission-b", "task-b", WORKSPACE, EXECUTION, USER, CHAT, "frame-b", "accepted-b", DIGEST_B);
}

function resumeEnvelope(
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
  deadlineAt = 4_000_000_000_000,
) {
  const connection = Object.freeze({
    logicalId: "root", concreteId: "connection", label: "Connection", provider: "test", model: "model",
    effectiveEndpoint: "https://example.invalid", endpointRevision: "endpoint-1",
    credentialSecretRef: "secret-ref", credentialRevision: "credential-1", candidateRevision: "candidate-1",
    capabilities: Object.freeze({ toolCalls: true }), capabilityDigest: DIGEST_A, fingerprint: DIGEST_B,
  });
  const plan = Object.freeze({
    version: 1,
    customPhasePlan: Object.freeze({
      status: "ready", phases: CUSTOM_PHASES, issues: Object.freeze([]), omittedPhaseIds: Object.freeze([]),
    }),
    loomBlocks: Object.freeze([
      Object.freeze({ source: RESEARCH_REF, content: "research" }),
      Object.freeze({ source: DRAFT_REF, content: "draft" }),
    ]),
    completionCriteriaMessages: Object.freeze([Object.freeze({ content: "accepted result" })]),
  });
  const withoutDigest = Object.freeze({
    version: 1 as const, snapshotDigest: DIGEST_A, planDigest: canonicalHash(plan),
    toolCatalogSchemaVersion: 1, toolCatalogDigest: DIGEST_C, configRevision: "config-1",
    authoredRootToolIds: Object.freeze(["web_search"]), authoredChildToolIds: Object.freeze({}),
    snapshot: Object.freeze({ snapshotId: "snapshot" }), plan,
    rootConnection: connection, childConnections: Object.freeze({}), generationParameters: null,
    resumeInput: Object.freeze({ userId: fixture.userId, chatId: fixture.chatId, generationType: "normal" }),
    decisionAuthority: Object.freeze({
      binding: Object.freeze({ userId: fixture.userId, chatId: fixture.chatId, targetDigest: DIGEST_A }),
      readinessVector: Object.freeze({}),
    }),
    liveTargetBinding: Object.freeze({ targetDigest: DIGEST_A, inputRevisionDigest: DIGEST_B }),
    runtime: Object.freeze({ deadlineAt, rootFrameId: fixture.executionId,
      workspaceId: fixture.workspaceId, workspaceRevision: 0,
      ownerLimits: Object.freeze({ providerDispatches: 4 }),
      workspaceRetention: "turn_terminal" as const, workspaceSharing: "root_only" as const }),
  });
  return Object.freeze({ ...withoutDigest, envelopeDigest: computeWorkSegmentResumeEnvelopeDigestV1(withoutDigest) });
}

function createInput(
  now = 1000,
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
  deadlineAt = 4_000_000_000_000,
): CreateWorkSegmentAttemptInputV1 {
  return {
    db,
    userId: fixture.userId,
    executionId: fixture.executionId,
    ownerToken: fixture.ownerToken,
    expectedExecutionCasRevision: 0,
    expectedWorkspaceRevision: 0,
    now,
    attemptId: fixture.attemptId,
    workspaceId: fixture.workspaceId,
    phaseId: "research",
    phaseIndex: 0,
    phaseOccurrence: 0,
    remainingRequiredPhaseCount: 1,
    snapshotDigest: DIGEST_A,
    phasePlanDigest: PHASE_PLAN_DIGEST,
    phasePlan: PHASE_PLAN,
    bindingDigest: DIGEST_C,
    resumeEnvelope: resumeEnvelope(fixture, deadlineAt),
    idempotencyKey: "attempt-key:" + fixture.attemptId,
    budget: ATTEMPT_BUDGET,
  };
}

function inspectionInput() {
  return {
    db,
    userId: USER,
    chatId: CHAT,
    executionId: EXECUTION,
    attemptId: ATTEMPT,
    workspaceId: WORKSPACE,
  };
}

function admissionInput(
  now = 1001,
  budgetOverrides: Partial<AdmitWorkSegmentInputV1["budget"]> = {},
  attemptBudget: CreateWorkSegmentAttemptInputV1["budget"] = ATTEMPT_BUDGET,
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
  deadlineAt = 4_000_000_000_000,
): AdmitWorkSegmentInputV1 {
  const budget = Object.freeze({
    maxProviderDispatches: 2,
    maxProviderOutputTokens: 40,
    maxOutputTokensPerDispatch: 20,
    maxUnsignedBoundaries: 2,
    maxToolCalls: 2,
    maxWorkspaceOperations: 2,
    ...budgetOverrides,
  });
  const withoutDigest: Omit<WorkSegmentContextV1, "contextDigest"> = Object.freeze({
    version: 1,
    bindingDigest: DIGEST_C,
    resumeEnvelopeDigest: resumeEnvelope(fixture, deadlineAt).envelopeDigest,
    phasePlanDigest: PHASE_PLAN_DIGEST,
    protocolDigest: DIGEST_A,
    capabilityDigest: ATTEMPT_CAPABILITY_DIGEST,
    phaseCapabilityDigest: RESEARCH_CAPABILITY_DIGEST,
    rootObjective: "fixture objective",
    rootSnapshotId: DIGEST_A,
    rootSnapshotDigest: DIGEST_A,
    phase: Object.freeze({
      id: "research", index: 0, occurrence: 0,
      instructions: Object.freeze(["research"]),
      completionCriteria: Object.freeze(["accepted result"]),
      admittedCapabilities: Object.freeze(["workspace_read"]),
    }),
    workspace: Object.freeze({
      id: fixture.workspaceId,
      revision: 0,
      acceptedRecords: Object.freeze([]),
      openRequiredIds: Object.freeze([]),
    }),
    previousHandoff: null,
    attemptBudget,
    segmentBudget: budget,
    protocol: Object.freeze({ completeTurnCallMode: "standalone_only", requiredToolModeAvailable: true }),
  });
  const context = Object.freeze({ ...withoutDigest, contextDigest: computeWorkSegmentContextDigestV1(withoutDigest) });
  return {
    db, userId: fixture.userId, executionId: fixture.executionId, ownerToken: fixture.ownerToken,
    expectedExecutionCasRevision: 0, expectedWorkspaceRevision: 0, now,
    attemptId: fixture.attemptId, workspaceId: fixture.workspaceId, sourceTransitionId: null,
    phaseId: "research", phaseIndex: 0, phaseOccurrence: 0, segmentOrdinal: 0,
    admissionKey: "segment-key-0", contextDigest: context.contextDigest, context, budget,
  };
}

function withoutDatabase<T extends { readonly db?: Database }>(input: T): Omit<T, "db"> {
  const { db: ignored, ...value } = input;
  void ignored;
  return value;
}

function createAndAdmitInput(
  now = 1000,
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
  attemptBudget: CreateWorkSegmentAttemptInputV1["budget"] = ATTEMPT_BUDGET,
  segmentBudgetOverrides: Partial<AdmitWorkSegmentInputV1["budget"]> = {},
): CreateAndAdmitInitialWorkSegmentInputV1 {
  return {
    db,
    attempt: withoutDatabase({ ...createInput(now, fixture), budget: attemptBudget }),
    admission: withoutDatabase(admissionInput(now, segmentBudgetOverrides, attemptBudget, fixture)),
  };
}

function allSkippedAuthority(
  phasePlan: CreateWorkSegmentAttemptInputV1["phasePlan"] = ALL_SKIPPED_PHASE_PLAN,
  revision = 0,
): WorkSegmentAllOptionalPhasesSkippedAuthorityV1 {
  const decisions = Object.freeze(phasePlan.phases.map((phase): WorkSegmentSkippedPhaseDecisionAuthorityV1 => {
    if (phase.skipEligibilityDigest === null) throw new Error("all-skipped fixture phase is not optional");
    const withoutDigest: Omit<WorkSegmentSkippedPhaseDecisionAuthorityV1, "evaluationDigest"> = Object.freeze({
      phaseId: phase.id,
      phaseIndex: phase.index,
      checkpoint: "skip",
      revision,
      condition: "true",
      phaseAuthorityDigest: phase.skipEligibilityDigest,
    });
    return Object.freeze({
      ...withoutDigest,
      evaluationDigest: canonicalHash(Object.freeze({ version: 1, ...withoutDigest })),
    });
  }));
  const withoutDigest: Omit<WorkSegmentAllOptionalPhasesSkippedAuthorityV1, "authorityDigest"> = Object.freeze({
    version: 1,
    kind: "all_authored_optional_phases_skipped",
    skippedPhaseIds: Object.freeze(phasePlan.phases.map((phase) => phase.id)),
    decisions,
  });
  return Object.freeze({ ...withoutDigest, authorityDigest: canonicalHash(withoutDigest) });
}

function rehashAllSkippedAuthority(
  authority: WorkSegmentAllOptionalPhasesSkippedAuthorityV1,
  overrides: Partial<Omit<WorkSegmentAllOptionalPhasesSkippedAuthorityV1, "version" | "kind" | "authorityDigest">>,
): WorkSegmentAllOptionalPhasesSkippedAuthorityV1 {
  const { authorityDigest: ignored, ...exactPayload } = authority;
  void ignored;
  const withoutDigest: Omit<WorkSegmentAllOptionalPhasesSkippedAuthorityV1, "authorityDigest"> = Object.freeze({
    ...exactPayload,
    ...overrides,
  });
  return Object.freeze({ ...withoutDigest, authorityDigest: canonicalHash(withoutDigest) });
}

function allSkippedAuthorityWithMismatchedPhaseDigest(): WorkSegmentAllOptionalPhasesSkippedAuthorityV1 {
  const exact = allSkippedAuthority();
  const [first, ...remaining] = exact.decisions;
  if (!first) throw new Error("all-skipped fixture has no first decision");
  const { evaluationDigest: ignored, ...exactDecision } = first;
  void ignored;
  const withoutEvaluationDigest: Omit<WorkSegmentSkippedPhaseDecisionAuthorityV1, "evaluationDigest"> = Object.freeze({
    ...exactDecision,
    phaseAuthorityDigest: DIGEST_C,
  });
  const mismatchedDecision = Object.freeze({
    ...withoutEvaluationDigest,
    evaluationDigest: canonicalHash(Object.freeze({ version: 1, ...withoutEvaluationDigest })),
  });
  return rehashAllSkippedAuthority(exact, {
    decisions: Object.freeze([mismatchedDecision, ...remaining]),
  });
}

function allSkippedAtomicInput(
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
  phasePlan: CreateWorkSegmentAttemptInputV1["phasePlan"] = ALL_SKIPPED_PHASE_PLAN,
  allOptionalPhasesSkippedAuthority: WorkSegmentAllOptionalPhasesSkippedAuthorityV1 = allSkippedAuthority(phasePlan),
): CreateAndAdmitInitialWorkSegmentInputV1 {
  const attemptBudget = Object.freeze({ ...ATTEMPT_BUDGET, futurePhaseReserveOutputTokens: 0 });
  const base = createAndAdmitInput(1000, fixture, attemptBudget);
  const { contextDigest: ignored, ...baseContext } = base.admission.context;
  void ignored;
  const phasePlanDigest = computeWorkPhasePlanDigestV1(phasePlan);
  const withoutDigest: Omit<WorkSegmentContextV1, "contextDigest"> = Object.freeze({
    ...baseContext,
    phasePlanDigest,
    capabilityDigest: capabilityDigest([]),
    phaseCapabilityDigest: capabilityDigest([]),
    phase: Object.freeze({
      id: null,
      index: 0,
      occurrence: 0,
      instructions: Object.freeze([]),
      completionCriteria: Object.freeze([]),
      admittedCapabilities: Object.freeze([]),
    }),
    allOptionalPhasesSkippedAuthority,
    previousHandoff: null,
    attemptBudget,
  });
  const context = Object.freeze({
    ...withoutDigest,
    contextDigest: computeWorkSegmentContextDigestV1(withoutDigest),
  });
  return {
    db,
    attempt: {
      ...base.attempt,
      phaseId: null,
      phaseIndex: 0,
      phaseOccurrence: 0,
      remainingRequiredPhaseCount: phasePlan.phases.slice(1).filter((phase) => phase.required).length,
      phasePlan,
      phasePlanDigest,
      budget: attemptBudget,
    },
    admission: {
      ...base.admission,
      phaseId: null,
      phaseIndex: 0,
      phaseOccurrence: 0,
      context,
      contextDigest: context.contextDigest,
    },
  };
}

function replacePersistedAllSkippedAuthority(
  fixture: RepositoryFixtureV1,
  segmentId: string,
  authority: WorkSegmentAllOptionalPhasesSkippedAuthorityV1,
): void {
  const row = db.query(
    "SELECT context_json FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
  ).get(fixture.userId, fixture.executionId, segmentId) as { context_json: string };
  const persisted = JSON.parse(row.context_json) as WorkSegmentContextV1;
  const { contextDigest: ignored, ...exactContext } = persisted;
  void ignored;
  const withoutDigest: Omit<WorkSegmentContextV1, "contextDigest"> = Object.freeze({
    ...exactContext,
    allOptionalPhasesSkippedAuthority: authority,
  });
  const context = Object.freeze({
    ...withoutDigest,
    contextDigest: computeWorkSegmentContextDigestV1(withoutDigest),
  });
  db.query(
    "UPDATE agent_work_segments SET context_json = ?, context_digest = ? WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
  ).run(
    encodeCanonicalPlainData(context),
    context.contextDigest,
    fixture.userId,
    fixture.executionId,
    segmentId,
  );
}

function allSkippedTerminalTransitionInput(
  segmentId: string,
  now = 1005,
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
): CommitWorkSegmentTransitionInputV1 {
  const source = Object.freeze({
    version: 1 as const,
    executionId: fixture.executionId,
    attemptId: fixture.attemptId,
    segmentId,
    phaseId: null,
    phaseIndex: 0,
    phaseOccurrence: 0,
    segmentOrdinal: 0,
  });
  return {
    db,
    userId: fixture.userId,
    executionId: fixture.executionId,
    ownerToken: fixture.ownerToken,
    expectedExecutionCasRevision: 0,
    expectedWorkspaceRevision: 0,
    now,
    attemptId: fixture.attemptId,
    workspaceId: fixture.workspaceId,
    sourceSegmentId: segmentId,
    phasePlanDigest: ALL_SKIPPED_PHASE_PLAN_DIGEST,
    transitionDecisionDigest: computeWorkTransitionDecisionDigestV1({
      phasePlanDigest: ALL_SKIPPED_PHASE_PLAN_DIGEST,
      source,
      transitionKind: "terminal",
      targetPhaseId: null,
      targetPhaseIndex: null,
      targetPhaseOccurrence: null,
      targetSegmentOrdinal: null,
    }),
    idempotencyKey: "all-skipped-terminal-transition",
    transitionKind: "terminal",
    targetPhaseId: null,
    targetPhaseIndex: null,
    targetPhaseOccurrence: null,
    targetSegmentOrdinal: null,
    remainingRequiredPhaseCount: 0,
    boundaryClass: "tool_free_stop",
    closeResult: "work_complete",
    usage: USAGE,
    completion: {
      summary: "All authored optional phases were skipped under frozen authority.",
      unresolvedIds: [],
      renderGuidance: null,
    },
  };
}

function reservationInput(
  segmentId: string,
  now = 1002,
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
): ReserveWorkSegmentDispatchInputV1 {
  return {
    db,
    userId: fixture.userId,
    executionId: fixture.executionId,
    ownerToken: fixture.ownerToken,
    expectedExecutionCasRevision: 0,
    expectedWorkspaceRevision: 0,
    now,
    attemptId: fixture.attemptId,
    workspaceId: fixture.workspaceId,
    segmentId,
    dispatchOrdinal: 0,
    idempotencyKey: "dispatch-key-0",
    toolMode: "ordinary",
    budgetClass: "normal",
    reservedOutputTokens: 20,
    leaseOwner: "dispatch-owner",
    leaseExpiresAt: 4000,
  };
}

function startInput(
  segmentId: string,
  dispatchId: string,
  now = 1003,
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
): StartWorkSegmentDispatchInputV1 {
  return {
    db,
    userId: fixture.userId,
    executionId: fixture.executionId,
    ownerToken: fixture.ownerToken,
    expectedExecutionCasRevision: 0,
    expectedWorkspaceRevision: 0,
    now,
    segmentId,
    dispatchId,
    leaseOwner: "dispatch-owner",
    fenceGeneration: 1,
  };
}

function settlementInput(
  segmentId: string,
  dispatchId: string,
  now = 1004,
  fixture: RepositoryFixtureV1 = DEFAULT_FIXTURE,
): SettleWorkSegmentDispatchInputV1 {
  return {
    ...startInput(segmentId, dispatchId, now, fixture),
    settlementKey: "settlement-key-0",
    boundaryClass: "tool_free_stop",
    usage: USAGE,
    workspaceMutations: [],
  };
}


function workspaceMutationReservation(
  segmentId: string,
  operationKey: string,
  operationKind: AgenticWorkMutatingWorkspaceOperationKindV1,
  frameId = EXECUTION,
  logicalDispatch = 0,
): AgenticWorkWorkspaceMutationReservationV1 {
  return Object.freeze({ version: 1, operationKey, operationKind, segmentId, logicalDispatch, frameId });
}

function insertWorkspaceMutationReceipt(
  segmentId: string,
  operationKey: string,
  operationDigest: string,
  beforeWorkspaceRevision: number,
  afterWorkspaceRevision: number,
  frameId = EXECUTION,
  logicalDispatch = 0,
): void {
  db.query(`INSERT INTO agent_work_workspace_receipts
    (user_id, execution_id, workspace_id, segment_id, logical_dispatch, frame_id,
     operation_key, operation_digest, before_workspace_revision, after_workspace_revision, settled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1005)`).run(
    USER,
    EXECUTION,
    WORKSPACE,
    segmentId,
    logicalDispatch,
    frameId,
    operationKey,
    operationDigest,
    beforeWorkspaceRevision,
    afterWorkspaceRevision,
  );
}
function transitionInput(segmentId: string, now = 1005): CommitWorkSegmentTransitionInputV1 {
  return {
    db,
    userId: USER,
    executionId: EXECUTION,
    ownerToken: OWNER,
    expectedExecutionCasRevision: 0,
    expectedWorkspaceRevision: 0,
    now,
    attemptId: ATTEMPT,
    workspaceId: WORKSPACE,
    sourceSegmentId: segmentId,
    phasePlanDigest: PHASE_PLAN_DIGEST,
    transitionDecisionDigest: computeWorkTransitionDecisionDigestV1({
      phasePlanDigest: PHASE_PLAN_DIGEST,
      source: { version: 1, executionId: EXECUTION, attemptId: ATTEMPT, segmentId, phaseId: "research", phaseIndex: 0, phaseOccurrence: 0, segmentOrdinal: 0 },
      transitionKind: "advance",
      targetPhaseId: "draft",
      targetPhaseIndex: 1,
      targetPhaseOccurrence: 0,
      targetSegmentOrdinal: 1,
    }),
    idempotencyKey: "transition-key-0",
    transitionKind: "advance",
    targetPhaseId: "draft",
    targetPhaseIndex: 1,
    targetPhaseOccurrence: 0,
    remainingRequiredPhaseCount: 0,
    targetSegmentOrdinal: 1,
    boundaryClass: "tool_free_stop",
    closeResult: "phase_advanced",
    usage: USAGE,
    completion: {
      summary: "Research evidence is sufficient to advance.",
      unresolvedIds: ["question-b", "question-a"],
      renderGuidance: null,
    },
  };
}

function expectCode(action: () => unknown, code: AgenticWorkSegmentRepositoryError["code"]): void {
  try {
    action();
    throw new Error(`Expected repository error ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AgenticWorkSegmentRepositoryError);
    expect((error as AgenticWorkSegmentRepositoryError).code).toBe(code);
  }
}
function tamperPersistedRow(action: () => void): void {
  db.query("PRAGMA ignore_check_constraints = ON").run();
  try {
    action();
  } finally {
    db.query("PRAGMA ignore_check_constraints = OFF").run();
  }
}
function createRunningSegment(): Readonly<{ segmentId: string; dispatchId: string }> {
  createWorkSegmentAttemptV1(createInput());
  const segment = admitWorkSegmentV1(admissionInput()).record;
  const reservation = reserveWorkSegmentDispatchV1(
    reservationInput(segment.identity.segmentId),
  ).record;
  startWorkSegmentDispatchV1(startInput(segment.identity.segmentId, reservation.dispatchId));
  return Object.freeze({ segmentId: segment.identity.segmentId, dispatchId: reservation.dispatchId });
}
function createRunningSegmentForForgedCollapsedPlan(): Readonly<{ segmentId: string; dispatchId: string }> {
  const forgedAttemptBudget = Object.freeze({
    ...ATTEMPT_BUDGET,
    futurePhaseReserveOutputTokens: 0,
  });
  createWorkSegmentAttemptV1({
    ...createInput(),
    phasePlan: FORGED_COLLAPSED_PHASE_PLAN,
    phasePlanDigest: FORGED_COLLAPSED_PHASE_PLAN_DIGEST,
    remainingRequiredPhaseCount: 0,
    budget: forgedAttemptBudget,
  });
  const baseAdmission = admissionInput(1001, {}, forgedAttemptBudget);
  const { contextDigest: _baseDigest, ...baseAuthority } = baseAdmission.context;
  const contextAuthority: Omit<WorkSegmentContextV1, "contextDigest"> = {
    ...baseAuthority,
    phasePlanDigest: FORGED_COLLAPSED_PHASE_PLAN_DIGEST,
  };
  const context = Object.freeze({
    ...contextAuthority,
    contextDigest: computeWorkSegmentContextDigestV1(contextAuthority),
  });
  const segment = admitWorkSegmentV1({
    ...baseAdmission,
    context,
    contextDigest: context.contextDigest,
  }).record;
  const reservation = reserveWorkSegmentDispatchV1(reservationInput(segment.identity.segmentId)).record;
  startWorkSegmentDispatchV1(startInput(segment.identity.segmentId, reservation.dispatchId));
  return Object.freeze({ segmentId: segment.identity.segmentId, dispatchId: reservation.dispatchId });
}
beforeEach(() => {
  db = createPreBundleDatabase();
  applyFeatureMigrationsThrough(db, 135);
  db.query("ALTER TABLE agent_turn_executions ADD COLUMN target_snapshot_json TEXT").run();
  seedAuthority();
});

afterEach(() => {
  db.close();
});
describe("bounded WORK segment repository", () => {
  test("atomically creates and admits the initial segment without a null-segment race window", () => {
    const atomicInput = createAndAdmitInput();
    db.exec(`CREATE TRIGGER inject_initial_segment_failure
      BEFORE INSERT ON agent_work_segments
      BEGIN
        SELECT RAISE(ABORT, 'injected initial segment failure');
      END`);
    try {
      expect(() => createAndAdmitInitialWorkSegmentV1(atomicInput))
        .toThrow("injected initial segment failure");
    } finally {
      db.exec("DROP TRIGGER inject_initial_segment_failure");
    }
    expect(db.query(`SELECT COUNT(*) AS count
      FROM agent_work_segment_recovery
      WHERE state = 'active' AND current_segment_id IS NULL`).get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segments").get()).toEqual({ count: 0 });

    const created = createAndAdmitInitialWorkSegmentV1(atomicInput);
    expect(created.attempt.duplicate).toBe(false);
    expect(created.admission.duplicate).toBe(false);
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.recovery.currentSegmentId).toBe(created.admission.record.identity.segmentId);
    expect(chain.recovery.state).toBe("active");
    expect(chain.segments.map((segment) => segment.identity.segmentId))
      .toEqual([created.admission.record.identity.segmentId]);

    const exactRetry = createAndAdmitInitialWorkSegmentV1(atomicInput);
    expect(exactRetry.attempt.duplicate).toBe(true);
    expect(exactRetry.admission.duplicate).toBe(true);
    expect(exactRetry.admission.record.identity.segmentId)
      .toBe(created.admission.record.identity.segmentId);

    expectCode(() => createAndAdmitInitialWorkSegmentV1({
      ...atomicInput,
      admission: { ...atomicInput.admission, admissionKey: "competing-initial-segment-key" },
    }), "stale_segment");
    expectCode(() => createAndAdmitInitialWorkSegmentV1({
      ...atomicInput,
      attempt: { ...atomicInput.attempt, idempotencyKey: "competing-initial-attempt-key" },
      admission: { ...atomicInput.admission, admissionKey: "competing-initial-attempt-segment-key" },
    }), "idempotency_conflict");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_recovery").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segments").get()).toEqual({ count: 1 });
  });

  test("atomically admits one built-in null Segment and terminally closes exact all-skipped authority idempotently", () => {
    const atomicInput = allSkippedAtomicInput();
    const created = createAndAdmitInitialWorkSegmentV1(atomicInput);
    expect(created.attempt.duplicate).toBe(false);
    expect(created.admission.duplicate).toBe(false);
    expect(created.admission.record.identity).toMatchObject({
      phaseId: null,
      phaseIndex: 0,
      phaseOccurrence: 0,
      segmentOrdinal: 0,
    });

    const exactRetry = createAndAdmitInitialWorkSegmentV1(atomicInput);
    expect(exactRetry.attempt.duplicate).toBe(true);
    expect(exactRetry.admission.duplicate).toBe(true);
    expect(exactRetry.admission.record.contextDigest).toBe(created.admission.record.contextDigest);

    const segmentId = created.admission.record.identity.segmentId;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(segmentId)).record;
    startWorkSegmentDispatchV1(startInput(segmentId, reserved.dispatchId));
    settleWorkSegmentDispatchV1(settlementInput(segmentId, reserved.dispatchId));
    const terminalInput = allSkippedTerminalTransitionInput(segmentId);
    const terminal = commitWorkSegmentTransitionV1(terminalInput);
    expect(terminal.duplicate).toBe(false);
    expect(terminal.record.handoff.transitionKind).toBe("terminal");
    expect(commitWorkSegmentTransitionV1({ ...terminalInput, now: 1010 }).duplicate).toBe(true);

    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.recovery).toMatchObject({ state: "closed", remainingRequiredPhaseCount: 0 });
    expect(chain.segments).toHaveLength(1);
    expect(chain.segments[0]).toMatchObject({
      identity: { phaseId: null, phaseIndex: 0, phaseOccurrence: 0, segmentOrdinal: 0 },
      lifecycle: "closed",
    });
    expect(chain.transitions).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND phase_id IS NOT NULL")
      .get(USER, EXECUTION)).toEqual({ count: 0 });
    expect(chain.segments[0]?.context.allOptionalPhasesSkippedAuthority).toMatchObject({
      skippedPhaseIds: ["optional_research", "optional_draft"],
      authorityDigest: expect.any(String),
    });
  });

  test("rejects partial, reordered, rehashed, stale, or required authored null-phase authority atomically", () => {
    const exactAuthority = allSkippedAuthority();
    const invalidAuthorities = [
      rehashAllSkippedAuthority(exactAuthority, {
        skippedPhaseIds: Object.freeze(["optional_research"]),
      }),
      rehashAllSkippedAuthority(exactAuthority, {
        skippedPhaseIds: Object.freeze(["optional_draft", "optional_research"]),
      }),
      Object.freeze({ ...exactAuthority, authorityDigest: DIGEST_A }),
      allSkippedAuthority(ALL_SKIPPED_PHASE_PLAN, 1),
      allSkippedAuthorityWithMismatchedPhaseDigest(),
    ];
    invalidAuthorities.forEach((invalidAuthority, index) => {
      const fixture = paginationFixture(9000 + index);
      seedAuthority(fixture, false);
      expectCode(() => createAndAdmitInitialWorkSegmentV1(
        allSkippedAtomicInput(fixture, ALL_SKIPPED_PHASE_PLAN, invalidAuthority),
      ), "invalid_input");
      expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?")
        .get(fixture.userId, fixture.executionId)).toEqual({ count: 0 });
      expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segments WHERE user_id = ? AND execution_id = ?")
        .get(fixture.userId, fixture.executionId)).toEqual({ count: 0 });
    });

    const requiredFixture = paginationFixture(9010);
    seedAuthority(requiredFixture, false);
    const requiredPlan: CreateWorkSegmentAttemptInputV1["phasePlan"] = Object.freeze({
      version: 1,
      phases: Object.freeze(ALL_SKIPPED_PHASE_PLAN.phases.map((phase, index) => Object.freeze({
        ...phase,
        required: index === 0,
      }))),
    });
    expectCode(() => createAndAdmitInitialWorkSegmentV1(allSkippedAtomicInput(
      requiredFixture,
      requiredPlan,
      allSkippedAuthority(requiredPlan),
    )), "invalid_input");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?")
      .get(requiredFixture.userId, requiredFixture.executionId)).toEqual({ count: 0 });
  });

  test("revalidates persisted all-skipped authority before a real terminal transition", () => {
    const exactAuthority = allSkippedAuthority();
    const cases: readonly Readonly<{
      authority: WorkSegmentAllOptionalPhasesSkippedAuthorityV1;
      code: "integrity_error" | "invalid_input";
    }>[] = [
      {
        authority: rehashAllSkippedAuthority(exactAuthority, {
          skippedPhaseIds: Object.freeze(["optional_research"]),
        }),
        code: "integrity_error",
      },
      {
        authority: rehashAllSkippedAuthority(exactAuthority, {
          skippedPhaseIds: Object.freeze(["optional_draft", "optional_research"]),
        }),
        code: "integrity_error",
      },
      { authority: Object.freeze({ ...exactAuthority, authorityDigest: DIGEST_A }), code: "integrity_error" },
      { authority: allSkippedAuthorityWithMismatchedPhaseDigest(), code: "invalid_input" },
      { authority: allSkippedAuthority(ALL_SKIPPED_PHASE_PLAN, 1), code: "invalid_input" },
    ];
    cases.forEach(({ authority: persistedAuthority, code }, index) => {
      const fixture = paginationFixture(9050 + index);
      seedAuthority(fixture, false);
      const created = createAndAdmitInitialWorkSegmentV1(allSkippedAtomicInput(fixture));
      const segmentId = created.admission.record.identity.segmentId;
      const reserved = reserveWorkSegmentDispatchV1(reservationInput(segmentId, 1002, fixture)).record;
      startWorkSegmentDispatchV1(startInput(segmentId, reserved.dispatchId, 1003, fixture));
      settleWorkSegmentDispatchV1(settlementInput(segmentId, reserved.dispatchId, 1004, fixture));
      replacePersistedAllSkippedAuthority(fixture, segmentId, persistedAuthority);
      expectCode(() => readWorkSegmentRecoveryChainV1(
        fixture.userId,
        fixture.executionId,
        db,
      ), "integrity_error");
      expectCode(() => reconcileWorkSegmentRecoveryAtStartupV1(db, 90_000 + index), "integrity_error");

      expectCode(() => commitWorkSegmentTransitionV1(
        allSkippedTerminalTransitionInput(segmentId, 1005, fixture),
      ), code);
      expect(db.query(
        "SELECT COUNT(*) AS count FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ?",
      ).get(fixture.userId, fixture.executionId)).toEqual({ count: 0 });
      expect(db.query(
        "SELECT state, current_segment_id FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
      ).get(fixture.userId, fixture.executionId)).toEqual({ state: "active", current_segment_id: segmentId });
    });
  });

  test("rejects corrupted all-skipped authority before closed startup completion recovery", () => {
    const fixture = paginationFixture(9060);
    seedAuthority(fixture, false);
    const created = createAndAdmitInitialWorkSegmentV1(allSkippedAtomicInput(fixture));
    const segmentId = created.admission.record.identity.segmentId;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(segmentId, 1002, fixture)).record;
    startWorkSegmentDispatchV1(startInput(segmentId, reserved.dispatchId, 1003, fixture));
    settleWorkSegmentDispatchV1(settlementInput(segmentId, reserved.dispatchId, 1004, fixture));
    commitWorkSegmentTransitionV1(allSkippedTerminalTransitionInput(segmentId, 1005, fixture));
    expect(readWorkSegmentRecoveryChainV1(fixture.userId, fixture.executionId, db)?.recovery.state).toBe("closed");

    replacePersistedAllSkippedAuthority(
      fixture,
      segmentId,
      allSkippedAuthority(ALL_SKIPPED_PHASE_PLAN, 1),
    );

    expectCode(() => readWorkSegmentRecoveryChainV1(
      fixture.userId,
      fixture.executionId,
      db,
    ), "integrity_error");
    expectCode(() => reconcileWorkSegmentRecoveryAtStartupV1(db, 91_000), "integrity_error");
    expect(db.query(
      "SELECT recovery_epoch FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
    ).get(fixture.userId, fixture.executionId)).toEqual({ recovery_epoch: 0 });
  });

  test("admits resume envelopes within their dedicated bound and rejects tampered, ephemeral, or larger payloads", () => {
    const exact = resumeEnvelope();
    expectCode(() => createWorkSegmentAttemptV1({
      ...createInput(), resumeEnvelope: { ...exact, envelopeDigest: DIGEST_A },
    }), "invalid_input");
    const { envelopeDigest: _exactDigest, ...exactWithoutDigest } = exact;
    const ephemeral = {
      ...exactWithoutDigest,
      resumeInput: { ...exact.resumeInput, providerTransientCarrier: { opaque: "private" } },
    };
    expectCode(() => createWorkSegmentAttemptV1({
      ...createInput(),
      resumeEnvelope: { ...ephemeral, envelopeDigest: computeWorkSegmentResumeEnvelopeDigestV1(ephemeral) },
    }), "invalid_input");
    const largeAuthority = {
      ...exactWithoutDigest,
      liveTargetBinding: { ...exact.liveTargetBinding, blob: "x".repeat(1024 * 1024) },
    };
    const largeEnvelope = {
      ...largeAuthority,
      envelopeDigest: computeWorkSegmentResumeEnvelopeDigestV1(largeAuthority),
    };
    expect(createWorkSegmentAttemptV1({
      ...createInput(), resumeEnvelope: largeEnvelope,
    })).toMatchObject({ duplicate: false, record: { resumeEnvelopeDigest: largeEnvelope.envelopeDigest } });
    const huge = { ...exact, snapshot: { blob: "x".repeat(8 * 1024 * 1024) } };
    const { envelopeDigest: _discarded, ...withoutDigest } = huge;
    expectCode(() => createWorkSegmentAttemptV1({
      ...createInput(),
      resumeEnvelope: { ...withoutDigest, envelopeDigest: computeWorkSegmentResumeEnvelopeDigestV1(withoutDigest) },
    }), "invalid_input");
  });

  test("startup accepts the host timestamp-scale runtime epoch and queues only once", () => {
    const runtimeEpoch = 1_788_046_330_858;
    createWorkSegmentAttemptV1(createInput());
    admitWorkSegmentV1(admissionInput());
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, runtimeEpoch)).toMatchObject({
      scanned: 1, active: 1, queued: 1, fenced: 0, terminalized: 0, complete: true, healthy: true,
    });
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.recovery.recoveryEpoch).toBe(runtimeEpoch);
    expect(listQueuedWorkSegmentRecoveriesV1(runtimeEpoch, db).map((chain) => chain.recovery.executionId)).toEqual([EXECUTION]);
    expect(listQueuedWorkSegmentRecoveriesV1(runtimeEpoch - 1, db)).toEqual([]);
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, runtimeEpoch).scanned).toBe(0);
  });

  test("startup fails closed instead of queueing an execution ahead of recovery workspace authority", () => {
    createWorkSegmentAttemptV1(createInput());
    admitWorkSegmentV1(admissionInput());
    db.query("UPDATE agent_turn_executions SET workspace_revision = 1 WHERE user_id = ? AND id = ?")
      .run(USER, EXECUTION);

    expectCode(() => reconcileWorkSegmentRecoveryAtStartupV1(db, 16), "integrity_error");
    expect(listQueuedWorkSegmentRecoveriesV1(16, db)).toEqual([]);
    expect(db.query(
      "SELECT recovery_epoch, execution_cas_revision FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
    ).get(USER, EXECUTION)).toEqual({ recovery_epoch: 0, execution_cas_revision: 0 });
    expect(db.query(
      "SELECT cas_owner, cas_revision, workspace_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?",
    ).get(USER, EXECUTION)).toEqual({ cas_owner: OWNER, cas_revision: 0, workspace_revision: 1 });
  });

  test("startup fences and fully charges a reserved dispatch without replay, once per epoch", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;

    const result = reconcileWorkSegmentRecoveryAtStartupV1(db, 17);
    expect(result).toMatchObject({ scanned: 1, fenced: 1, terminalized: 1, queued: 0, healthy: true });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db);
    expect(chain?.recovery.state).toBe("closed");
    expect(chain?.dispatches.find((dispatch) => dispatch.dispatchId === reserved.dispatchId)).toMatchObject({
      lifecycle: "interrupted", usage: { billedOutputTokens: 20, unsignedBoundaries: 1 },
    });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 17).scanned).toBe(0);
  });

  test("startup closes a predeadline cancellation marker without dispatch as CANCELLED exactly once", () => {
    createWorkSegmentAttemptV1(createInput());
    admitWorkSegmentV1(admissionInput());
    const deadlineAt = Date.now() - 1_000;
    db.query(
      "UPDATE agent_turn_executions SET deadline_at = ?, cancel_requested_at = ?, cas_expires_at = 0 WHERE user_id = ? AND id = ?",
    ).run(deadlineAt, deadlineAt - 1, USER, EXECUTION);

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 170, 1)).toMatchObject({
      scanned: 1, fenced: 0, terminalized: 1, closed: 1, queued: 0, healthy: true,
    });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.recovery).toMatchObject({
      state: "closed", currentSegmentId: null, terminalCloseResult: "cancelled", terminalCloseReason: "cancelled",
    });
    expect(chain.segments[0]).toMatchObject({
      lifecycle: "cancelled", closeResult: "cancelled", closeReason: "cancelled",
    });
    reconcileAgentTurns(db);
    expect(db.query("SELECT state, terminal_code FROM agent_turn_executions WHERE id = ?")
      .get(EXECUTION)).toEqual({ state: "CANCELLED", terminal_code: "cancelled" });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 170, 1).scanned).toBe(0);
    expect(reconcileAgentTurns(db).claimed).toBe(0);
  });

  test("startup converges a stopped execution ahead of its active running segment exactly once", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const dispatch = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, dispatch.dispatchId));
    settleWorkSegmentDispatchV1(settlementInput(admitted.identity.segmentId, dispatch.dispatchId));
    const terminalAt = Date.now();
    expect(db.query(`UPDATE agent_turn_executions
      SET state = 'CANCELLED', cas_revision = 1, cas_owner = NULL, cas_expires_at = NULL,
          deadline_at = ?, cancel_requested_at = ?, terminal_code = 'cancelled', terminal_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND state = 'WORK' AND cas_revision = 0`)
      .run(terminalAt + 1_000, terminalAt - 1, terminalAt, terminalAt, USER, EXECUTION).changes).toBe(1);

    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)).toMatchObject({
      recovery: { state: "active", executionCasRevision: 0, currentSegmentId: admitted.identity.segmentId },
      segments: [{ lifecycle: "running", executionCasRevision: 0 }],
    });
    let startup: ReturnType<typeof reconcileWorkSegmentRecoveryAtStartupV1> | null = null;
    expect(() => { startup = reconcileWorkSegmentRecoveryAtStartupV1(db, 173, 1); }).not.toThrow();
    expect(startup).toMatchObject({
      scanned: 1, active: 0, closed: 1, queued: 0, fenced: 0, terminalized: 1, healthy: true,
    });
    const converged = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(converged.recovery).toMatchObject({
      state: "closed", recoveryEpoch: 173, executionCasRevision: 1, currentSegmentId: null,
      terminalCloseResult: "cancelled", terminalCloseReason: "cancelled", terminalBoundaryClass: "tool_free_stop",
    });
    expect(converged.segments[0]).toMatchObject({
      lifecycle: "cancelled", closeResult: "cancelled", closeReason: "cancelled",
      boundaryClass: "tool_free_stop", closedExecutionCasRevision: 1, closedAt: terminalAt,
    });
    const terminalAuthority = db.query(
      "SELECT state, cas_revision, cancel_requested_at, terminal_code, terminal_at FROM agent_turn_executions WHERE user_id = ? AND id = ?",
    ).get(USER, EXECUTION);
    expect(terminalAuthority).toEqual({
      state: "CANCELLED", cas_revision: 1, cancel_requested_at: terminalAt - 1,
      terminal_code: "cancelled", terminal_at: terminalAt,
    });
    const closureDigest = converged.segments[0]!.closureDigest;

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 174, 1).scanned).toBe(0);
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.segments[0]?.closureDigest).toBe(closureDigest);
    expect(db.query(
      "SELECT state, cas_revision, cancel_requested_at, terminal_code, terminal_at FROM agent_turn_executions WHERE user_id = ? AND id = ?",
    ).get(USER, EXECUTION)).toEqual(terminalAuthority);
  });

  test("startup rejects an interrupted final dispatch behind a stopped execution", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const dispatch = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, dispatch.dispatchId));
    interruptUnsettledWorkSegmentDispatchV1({
      ...createInput(4000),
      segmentId: admitted.identity.segmentId,
      dispatchId: dispatch.dispatchId,
      interruptionKey: "startup-terminal-interrupted",
      reason: "unknown provider outcome",
    });
    const terminalAt = Date.now();
    expect(db.query(`UPDATE agent_turn_executions
      SET state = 'CANCELLED', cas_revision = 1, cas_owner = NULL, cas_expires_at = NULL,
          deadline_at = ?, cancel_requested_at = ?, terminal_code = 'cancelled', terminal_at = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND state = 'WORK' AND cas_revision = 0`)
      .run(terminalAt + 1_000, terminalAt - 1, terminalAt, terminalAt, USER, EXECUTION).changes).toBe(1);

    expectCode(() => reconcileWorkSegmentRecoveryAtStartupV1(db, 175, 1), "integrity_error");
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)).toMatchObject({
      recovery: { state: "active", recoveryEpoch: 0, executionCasRevision: 0,
        currentSegmentId: admitted.identity.segmentId },
      segments: [{ lifecycle: "running", executionCasRevision: 0, closeResult: null }],
      dispatches: [{ lifecycle: "interrupted" }],
    });
    expect(db.query(
      "SELECT state, cas_revision, terminal_code, terminal_at FROM agent_turn_executions WHERE user_id = ? AND id = ?",
    ).get(USER, EXECUTION)).toEqual({
      state: "CANCELLED", cas_revision: 1, terminal_code: "cancelled", terminal_at: terminalAt,
    });
  });

  test("startup interrupts in-flight work then preserves a predeadline marker as CANCELLED", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const dispatch = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, dispatch.dispatchId));
    const deadlineAt = Date.now() - 1_000;
    db.query(
      "UPDATE agent_turn_executions SET deadline_at = ?, cancel_requested_at = ?, cas_expires_at = 0 WHERE user_id = ? AND id = ?",
    ).run(deadlineAt, deadlineAt - 1, USER, EXECUTION);

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 171, 1)).toMatchObject({
      scanned: 1, fenced: 1, terminalized: 1, closed: 1, queued: 0, healthy: true,
    });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.recovery).toMatchObject({
      state: "closed", terminalCloseResult: "cancelled", terminalCloseReason: "cancelled",
    });
    expect(chain.dispatches[0]).toMatchObject({ lifecycle: "interrupted" });
    expect(chain.segments[0]).toMatchObject({ lifecycle: "cancelled", closeReason: "cancelled" });
    reconcileAgentTurns(db);
    expect(db.query("SELECT state, terminal_code FROM agent_turn_executions WHERE id = ?")
      .get(EXECUTION)).toEqual({ state: "CANCELLED", terminal_code: "cancelled" });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 171, 1).scanned).toBe(0);
  });

  test("startup preserves a marker at the deadline as TIMED_OUT exactly once", () => {
    createWorkSegmentAttemptV1(createInput());
    admitWorkSegmentV1(admissionInput());
    const deadlineAt = Date.now() - 1_000;
    db.query(
      "UPDATE agent_turn_executions SET deadline_at = ?, cancel_requested_at = ?, cas_expires_at = 0 WHERE user_id = ? AND id = ?",
    ).run(deadlineAt, deadlineAt, USER, EXECUTION);

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 172, 1)).toMatchObject({
      scanned: 1, terminalized: 1, closed: 1, queued: 0, healthy: true,
    });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.recovery).toMatchObject({
      state: "closed", terminalCloseResult: "failed", terminalCloseReason: "root_wall_clock_limit_exceeded",
    });
    expect(chain.segments[0]).toMatchObject({
      lifecycle: "failed", closeResult: "failed", closeReason: "root_wall_clock_limit_exceeded",
    });
    reconcileAgentTurns(db);
    expect(db.query("SELECT state, terminal_code FROM agent_turn_executions WHERE id = ?")
      .get(EXECUTION)).toEqual({ state: "TIMED_OUT", terminal_code: "root_wall_clock_limit_exceeded" });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 172, 1).scanned).toBe(0);
    expect(reconcileAgentTurns(db).claimed).toBe(0);
  });
  test("startup atomically admits and queues a durable committed handoff with a NULL current segment", () => {
    createWorkSegmentAttemptV1(createInput());
    const sourceInput = admissionInput();
    const source = admitWorkSegmentV1(sourceInput).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(source.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(source.identity.segmentId, reserved.dispatchId));
    settleWorkSegmentDispatchV1(settlementInput(source.identity.segmentId, reserved.dispatchId));
    const transition = commitWorkSegmentTransitionV1(transitionInput(source.identity.segmentId)).record;
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.recovery.currentSegmentId).toBeNull();

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 18)).toMatchObject({
      scanned: 1, active: 1, queued: 1, fenced: 0, terminalized: 0, complete: true, healthy: true,
    });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    const target = chain.segments[1]!;
    expect(chain.recovery).toMatchObject({
      recoveryEpoch: 18,
      currentSegmentId: target.identity.segmentId,
      nextSegmentOrdinal: 1,
      phaseId: "draft",
      phaseIndex: 1,
      phaseOccurrence: 0,
    });
    expect(target.identity).toMatchObject({ phaseId: "draft", phaseIndex: 1, phaseOccurrence: 0, segmentOrdinal: 1 });
    expect(target.sourceTransitionId).toBe(transition.transitionId);
    expect(target.admissionKey).toBe("work-segment:" + ATTEMPT + ":1");
    expect(target.context.previousHandoff).toEqual(transition.handoff);
    expect(target.context.phase).toEqual({
      id: "draft",
      index: 1,
      occurrence: 0,
      instructions: ["draft"],
      completionCriteria: ["accepted result"],
      admittedCapabilities: ["delegation"],
    });
    expect(target.context.phaseCapabilityDigest).toBe(DRAFT_CAPABILITY_DIGEST);
    expect(target.context.capabilityDigest).toBe(ATTEMPT_CAPABILITY_DIGEST);
    expect(target.context.phase.instructions).not.toContain("research");
    expect(target.context.rootObjective).toBe(source.context.rootObjective);
    const { contextDigest, ...withoutDigest } = target.context;
    expect(contextDigest).toBe(computeWorkSegmentContextDigestV1(withoutDigest));
    expect(chain.dispatches).toHaveLength(1);
    expect(listQueuedWorkSegmentRecoveriesV1(18, db)[0]?.recovery.currentSegmentId)
      .toBe(target.identity.segmentId);
  });

  test("only one exact drain caller can atomically claim a queued chain", () => {
    db.query("UPDATE agent_turn_executions SET deadline_at = ? WHERE user_id = ? AND id = ?")
      .run(4_000_000_000_000, USER, EXECUTION);
    createWorkSegmentAttemptV1(createInput());
    admitWorkSegmentV1(admissionInput());
    reconcileWorkSegmentRecoveryAtStartupV1(db, 19);
    const queued = listQueuedWorkSegmentRecoveriesV1(19, db)[0]!;
    const execution = db.query("SELECT cas_owner FROM agent_turn_executions WHERE user_id = ? AND id = ?")
      .get(USER, EXECUTION) as { cas_owner: string };
    const input = {
      db,
      userId: USER,
      executionId: EXECUTION,
      runtimeEpoch: 19,
      expectedOwnerToken: execution.cas_owner,
      expectedExecutionCasRevision: queued.recovery.executionCasRevision,
      expectedSegmentId: queued.recovery.currentSegmentId!,
      claimOwnerToken: "drain-owner-a",
      now: queued.recovery.updatedAt + 1,
    };
    const claimed = claimQueuedWorkSegmentRecoveryV1(input);
    expect(claimed?.recovery.executionCasRevision).toBe(queued.recovery.executionCasRevision + 1);
    expect(claimed?.segments.find((segment) => segment.identity.segmentId === input.expectedSegmentId)?.executionCasRevision)
      .toBe(queued.recovery.executionCasRevision + 1);
    expect(claimQueuedWorkSegmentRecoveryV1({ ...input, claimOwnerToken: "drain-owner-b" })).toBeNull();
    expect(db.query("SELECT cas_owner, cas_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?")
      .get(USER, EXECUTION)).toEqual({
        cas_owner: "drain-owner-a",
        cas_revision: queued.recovery.executionCasRevision + 1,
      });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 19).scanned).toBe(0);
    db.query("UPDATE agent_turn_executions SET cas_expires_at = 0 WHERE user_id = ? AND id = ?")
      .run(USER, EXECUTION);
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 19, 1)).toMatchObject({
      scanned: 1,
      active: 1,
      queued: 1,
      healthy: true,
    });
    expect(listQueuedWorkSegmentRecoveriesV1(19, db, 1)).toHaveLength(1);
  });
  test("commits a redacted host-authoritative handoff and keeps every write idempotent", () => {
    seedHandoffTaskAuthority();
    const attemptInput = createInput();
    expect(createWorkSegmentAttemptV1(attemptInput).duplicate).toBe(false);
    expect(createWorkSegmentAttemptV1({ ...attemptInput, now: 1010 }).duplicate).toBe(true);

    const admittedInput = admissionInput();
    const admission = admitWorkSegmentV1(admittedInput);
    expect(admission.duplicate).toBe(false);
    expect(admission.record.context).toEqual(admittedInput.context);
    const persistedContext = db.query("SELECT context_json, context_digest FROM agent_work_segments WHERE segment_id = ?")
      .get(admission.record.identity.segmentId) as { context_json: string; context_digest: string };
    expect(JSON.parse(persistedContext.context_json)).toEqual(admittedInput.context);
    expect(persistedContext.context_digest).toBe(admittedInput.context.contextDigest);
    expect(Buffer.byteLength(persistedContext.context_json, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expectCode(() => admitWorkSegmentV1({
      ...admittedInput,
      admissionKey: "segment-key-corrupt-context",
      context: { ...admittedInput.context, rootObjective: "tampered without digest update" },
    }), "invalid_input");
    const reservation = reserveWorkSegmentDispatchV1(
      reservationInput(admission.record.identity.segmentId),
    );
    expect(reservation.duplicate).toBe(false);
    expectCode(() => startWorkSegmentDispatchV1({
      ...startInput(admission.record.identity.segmentId, reservation.record.dispatchId),
      leaseOwner: "forged-dispatch-owner",
    }), "stale_owner");
    expect(startWorkSegmentDispatchV1(
      startInput(admission.record.identity.segmentId, reservation.record.dispatchId),
    ).lifecycle).toBe("in_flight");

    const readOnlyWorkspaceUsage = Object.freeze({
      ...USAGE,
      toolCalls: 2,
      workspaceOperations: 2,
    });
    const settlement = {
      ...settlementInput(admission.record.identity.segmentId, reservation.record.dispatchId),
      usage: readOnlyWorkspaceUsage,
    };
    expect(settleWorkSegmentDispatchV1(settlement).duplicate).toBe(false);
    expect(settleWorkSegmentDispatchV1({ ...settlement, now: 1011 }).duplicate).toBe(true);

    const transition = {
      ...transitionInput(admission.record.identity.segmentId),
      usage: readOnlyWorkspaceUsage,
    };
    const committed = commitWorkSegmentTransitionV1(transition);
    expect(committed.duplicate).toBe(false);
    expect(committed.record.handoff.acceptedIds).toEqual({
      authority: "host",
      taskIds: ["task-a", "task-b"],
      submissionIds: ["submission-a", "submission-b"],
      findingIds: [],
      decisionIds: [],
      artifactIds: [],
    });
    expect(committed.record.handoff.completion).toEqual({
      authority: "model_advisory",
      summary: "Research evidence is sufficient to advance.",
      unresolvedIds: ["question-a", "question-b"],
      renderGuidance: null,
    });
    expect(committed.record.handoff.openRequiredIds).toEqual(["required-a", "required-b"]);

    expect(commitWorkSegmentTransitionV1({ ...transition, now: 1012 }).duplicate).toBe(true);
    expect(admitWorkSegmentV1({ ...admittedInput, now: 1013 }).duplicate).toBe(true);
    expect(reserveWorkSegmentDispatchV1({
      ...reservationInput(admission.record.identity.segmentId),
      now: 4500,
    }).duplicate).toBe(true);

    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db);
    expect(chain?.recovery.phaseId).toBe("draft");
    expect(chain?.recovery.nextSegmentOrdinal).toBe(1);
    expect(chain?.recovery.protectedFuturePhaseReserveOutputTokens).toBe(0);
    expect(chain?.transitions[0]?.handoff.releasedFuturePhaseReserveOutputTokens).toBe(20);
    expect(chain?.segments[0]?.lifecycle).toBe("closed");
    expect(chain?.dispatches[0]?.lifecycle).toBe("settled");
    expect(chain?.transitions).toHaveLength(1);
    const serialized = JSON.stringify(chain);
    for (const forbidden of [
      "provider transcript",
      "private reasoning",
      "carrier message",
      "tool arguments",
      "tool result",
      "external effect payload",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(committed.record.handoff.sourceWorkspaceRevision).toBe(0);
    expect(committed.record.handoff.usage.workspaceOperations).toBe(2);
    expect(readWorkSegmentRecoveryChainV1(OTHER_USER, EXECUTION, db)).toBeNull();
  });

  test("fails closed when any persisted handoff authority escapes its complete payload digest", () => {
    seedHandoffTaskAuthority();
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    settleWorkSegmentDispatchV1(settlementInput(admitted.identity.segmentId, reserved.dispatchId));
    commitWorkSegmentTransitionV1(transitionInput(admitted.identity.segmentId));

    const persisted = db.query(
      "SELECT * FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ? AND source_segment_id = ?",
    ).get(USER, EXECUTION, admitted.identity.segmentId) as Record<string, string | number | null>;
    const corruptions = [
      ["accepted_task_ids_json", JSON.stringify(["forged-task"])],
      ["open_required_ids_json", JSON.stringify(["forged-required"])],
      ["advisory_summary", "forged summary"],
      ["advisory_unresolved_ids_json", JSON.stringify(["forged-unresolved"])],
      ["advisory_render_guidance", "forged guidance"],
      ["remaining_required_phase_count", 1],
      ["released_future_phase_reserve_output_tokens", 1],
      ["payload_digest", DIGEST_B],
      ["accepted_ids_authority", "model_advisory"],
      ["advisory_authority", "host"],
      ["record_complete", 0],
      ["schema_version", 2],
    ] as const;
    for (const [column, corruptedValue] of corruptions) {
      tamperPersistedRow(() => {
        db.query("UPDATE agent_work_segment_transitions SET " + column + " = ? WHERE transition_id = ?")
          .run(corruptedValue, persisted.transition_id);
      });
      expectCode(() => readWorkSegmentRecoveryChainV1(USER, EXECUTION, db), "integrity_error");
      db.query("UPDATE agent_work_segment_transitions SET " + column + " = ? WHERE transition_id = ?")
        .run(persisted[column], persisted.transition_id);
    }

    db.query("UPDATE agent_work_segments SET boundary_class = 'tool_action' WHERE segment_id = ?")
      .run(admitted.identity.segmentId);
    expectCode(() => readWorkSegmentRecoveryChainV1(USER, EXECUTION, db), "integrity_error");
  });

  test("workspace accepted authority admits exactly 128 mixed task, submission, finding, and artifact records and fails closed at 129", () => {
    const digestFor = (value: number): string => value.toString(16).padStart(64, "0");
    const insertTask = db.query(`INSERT INTO agent_workspace_tasks
      (task_id, workspace_id, turn_id, user_id, chat_id, title, description, state, required,
       summary, byte_count, revision, retention, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '', 'completed', 0, ?, 1, ?, 'turn_terminal', 5000, ?)`);
    const insertSubmission = db.query(`INSERT INTO agent_workspace_submissions
      (submission_id, task_id, workspace_id, turn_id, user_id, chat_id, child_frame_id,
       state, summary, result_digest, byte_count, retention, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, 1, 'turn_terminal', 5000)`);
    for (let index = 0; index < 42; index += 1) {
      const taskId = "accepted-task-" + String(index).padStart(3, "0");
      insertTask.run(taskId, WORKSPACE, EXECUTION, USER, CHAT, taskId, "summary " + index, index + 1, index + 1);
      insertSubmission.run(
        "accepted-submission-" + String(index).padStart(3, "0"),
        taskId,
        WORKSPACE,
        EXECUTION,
        USER,
        CHAT,
        "accepted-frame-" + index,
        "accepted " + index,
        digestFor(index + 1),
      );
    }
    const insertRecord = db.query(`INSERT INTO agent_workspace_records
      (record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
       task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'finding', ?, ?, NULL, 'frame-boundary', 1, ?, 'turn_terminal', 5000, ?)`);
    for (let index = 0; index < 22; index += 1) {
      insertRecord.run(
        "accepted-record-" + String(index).padStart(3, "0"),
        WORKSPACE,
        EXECUTION,
        USER,
        CHAT,
        "record " + index,
        digestFor(100 + index),
        index + 1,
        100 + index,
      );
    }
    const insertArtifact = db.query(`INSERT INTO agent_workspace_artifacts
      (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
       byte_count, provenance_json, source_frame_id, source_task_id, publication_state,
       retention, revision, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 1, '{}', 'artifact-frame', NULL, 'attached',
              'turn_terminal', ?, 5000, ?)`);
    for (let index = 0; index < 22; index += 1) {
      insertArtifact.run(
        "accepted-artifact-" + String(index).padStart(3, "0"),
        WORKSPACE,
        EXECUTION,
        USER,
        CHAT,
        digestFor(200 + index),
        index + 1,
        200 + index,
      );
    }
    const accepted = readWorkSegmentWorkspaceAuthorityV1(USER, EXECUTION, WORKSPACE, db).acceptedRecords;
    expect(accepted).toHaveLength(128);
    expect(Object.fromEntries(["task", "submission", "finding", "artifact"].map((kind) => [
      kind,
      accepted.filter((record) => record.kind === kind).length,
    ]))).toEqual({ task: 42, submission: 42, finding: 22, artifact: 22 });
    insertArtifact.run("accepted-artifact-128", WORKSPACE, EXECUTION, USER, CHAT, digestFor(999), 23, 999);
    expectCode(() => readWorkSegmentWorkspaceAuthorityV1(USER, EXECUTION, WORKSPACE, db), "segment_budget_exhausted");
  });
  test("workspace required authority admits exactly 128 open IDs and fails closed at 129", () => {
    const insert = db.query(`INSERT INTO agent_workspace_tasks
      (task_id, workspace_id, turn_id, user_id, chat_id, title, state, required,
       byte_count, retention, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, 0, 'turn_terminal', 5000)`);
    for (let index = 0; index < 128; index += 1) {
      const taskId = "required-" + String(index).padStart(3, "0");
      insert.run(taskId, WORKSPACE, EXECUTION, USER, CHAT, taskId);
    }
    expect(readWorkSegmentWorkspaceAuthorityV1(USER, EXECUTION, WORKSPACE, db).openRequiredIds).toHaveLength(128);
    insert.run("required-128", WORKSPACE, EXECUTION, USER, CHAT, "required-128");
    expectCode(() => readWorkSegmentWorkspaceAuthorityV1(USER, EXECUTION, WORKSPACE, db), "segment_budget_exhausted");
  });
  test("reloads an admitted pre-dispatch segment as the sole current segment", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;

    const recovered = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db);
    expect(recovered?.recovery.currentSegmentId).toBe(admitted.identity.segmentId);
    expect(recovered?.segments).toHaveLength(1);
    expect(recovered?.segments[0]?.lifecycle).toBe("admitted");

    expect(admitWorkSegmentV1({ ...admissionInput(), now: 1002 }).duplicate).toBe(true);
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.segments).toHaveLength(1);
  });

  test("fails closed for unknown provider outcomes, stale owners, and idempotency conflicts", () => {
    const { segmentId, dispatchId } = createRunningSegment();
    expectCode(() => commitWorkSegmentTransitionV1({
      ...transitionInput(segmentId),
      expectedWorkspaceRevision: 1,
    }), "stale_workspace");
    expectCode(() => commitWorkSegmentTransitionV1({
      ...transitionInput(segmentId),
      expectedExecutionCasRevision: 1,
    }), "stale_execution");
    expectCode(() => commitWorkSegmentTransitionV1(transitionInput(segmentId)), "stale_segment");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_transitions").get()).toEqual({ count: 0 });
    expect(db.query(
      "SELECT lifecycle FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
    ).get(USER, EXECUTION, segmentId)).toEqual({ lifecycle: "running" });

    expectCode(() => startWorkSegmentDispatchV1({
      ...startInput(segmentId, dispatchId),
      leaseOwner: "forged-dispatch-owner",
    }), "stale_segment");
    expectCode(() => settleWorkSegmentDispatchV1({
      ...settlementInput(segmentId, dispatchId),
      ownerToken: "forged-execution-owner",
    }), "stale_owner");

    const settlement = settlementInput(segmentId, dispatchId);
    settleWorkSegmentDispatchV1(settlement);
    expectCode(() => settleWorkSegmentDispatchV1({
      ...settlement,
      usage: { ...USAGE, billedOutputTokens: 6 },
    }), "idempotency_conflict");
    expectCode(() => commitWorkSegmentTransitionV1({
      ...transitionInput(segmentId),
      usage: { ...USAGE, providerTotalTokens: 16 },
    }), "integrity_error");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_transitions").get()).toEqual({ count: 0 });
    expect(db.query(
      "SELECT lifecycle FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
    ).get(USER, EXECUTION, segmentId)).toEqual({ lifecycle: "running" });

    commitWorkSegmentTransitionV1(transitionInput(segmentId));
    expectCode(() => commitWorkSegmentTransitionV1({
      ...transitionInput(segmentId),
      completion: {
        ...transitionInput(segmentId).completion,
        summary: "Conflicting handoff",
      },
    }), "idempotency_conflict");
    expectCode(() => createWorkSegmentAttemptV1({
      ...createInput(),
      phaseId: "forged-phase",
    }), "invalid_input");
    expectCode(() => readWorkSegmentRecoveryChainV1(`${USER}x`.repeat(100), EXECUTION, db), "invalid_input");
  });
  test("collapsed advance rejects a forged missing intervening phase edge", () => {
    const { segmentId, dispatchId } = createRunningSegmentForForgedCollapsedPlan();
    settleWorkSegmentDispatchV1(settlementInput(segmentId, dispatchId));
    const source = {
      version: 1 as const,
      executionId: EXECUTION,
      attemptId: ATTEMPT,
      segmentId,
      phaseId: "research",
      phaseIndex: 0,
      phaseOccurrence: 0,
      segmentOrdinal: 0,
    };
    expectCode(() => commitWorkSegmentTransitionV1({
      ...transitionInput(segmentId),
      phasePlanDigest: FORGED_COLLAPSED_PHASE_PLAN_DIGEST,
      transitionDecisionDigest: computeWorkTransitionDecisionDigestV1({
        phasePlanDigest: FORGED_COLLAPSED_PHASE_PLAN_DIGEST,
        source,
        transitionKind: "advance",
        targetPhaseId: "draft",
        targetPhaseIndex: 2,
        targetPhaseOccurrence: 0,
        targetSegmentOrdinal: 1,
      }),
      targetPhaseId: "draft",
      targetPhaseIndex: 2,
      targetPhaseOccurrence: 0,
      targetSegmentOrdinal: 1,
      remainingRequiredPhaseCount: 0,
    }), "invalid_input");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_transitions").get()).toEqual({ count: 0 });
  });

  test("terminal tail rejects a forged missing intervening phase edge", () => {
    const { segmentId, dispatchId } = createRunningSegmentForForgedCollapsedPlan();
    settleWorkSegmentDispatchV1(settlementInput(segmentId, dispatchId));
    const source = {
      version: 1 as const,
      executionId: EXECUTION,
      attemptId: ATTEMPT,
      segmentId,
      phaseId: "research",
      phaseIndex: 0,
      phaseOccurrence: 0,
      segmentOrdinal: 0,
    };
    expectCode(() => commitWorkSegmentTransitionV1({
      ...transitionInput(segmentId),
      phasePlanDigest: FORGED_COLLAPSED_PHASE_PLAN_DIGEST,
      transitionDecisionDigest: computeWorkTransitionDecisionDigestV1({
        phasePlanDigest: FORGED_COLLAPSED_PHASE_PLAN_DIGEST,
        source,
        transitionKind: "terminal",
        targetPhaseId: null,
        targetPhaseIndex: null,
        targetPhaseOccurrence: null,
        targetSegmentOrdinal: null,
      }),
      transitionKind: "terminal",
      targetPhaseId: null,
      targetPhaseIndex: null,
      targetPhaseOccurrence: null,
      targetSegmentOrdinal: null,
      remainingRequiredPhaseCount: 0,
      closeResult: "work_complete",
    }), "invalid_input");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_transitions").get()).toEqual({ count: 0 });
  });
  test("enforces independent segment budgets and bounded canonical inputs", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    expectCode(() => reserveWorkSegmentDispatchV1({
      ...reservationInput(admitted.identity.segmentId),
      reservedOutputTokens: 41,
    }), "dispatch_budget_exhausted");
    expectCode(() => reserveWorkSegmentDispatchV1({
      ...reservationInput(admitted.identity.segmentId),
      reservedOutputTokens: Number.MAX_SAFE_INTEGER,
    }), "invalid_input");
    expectCode(() => reserveWorkSegmentDispatchV1({
      ...reservationInput(admitted.identity.segmentId),
      idempotencyKey: "x".repeat(257),
    }), "invalid_input");

    const reservation = reserveWorkSegmentDispatchV1(
      reservationInput(admitted.identity.segmentId),
    ).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reservation.dispatchId));
    expectCode(() => settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reservation.dispatchId),
      usage: { ...USAGE, billedOutputTokens: 21 },
    }), "dispatch_budget_exhausted");
    const unprovenWorkspaceUsage = { ...USAGE, workspaceOperations: 1 };
    settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reservation.dispatchId),
      usage: unprovenWorkspaceUsage,
    });

    expectCode(() => commitWorkSegmentTransitionV1({
      ...transitionInput(admitted.identity.segmentId),
      transitionKind: "terminal",
      targetPhaseId: null,
      targetPhaseIndex: null,
      targetPhaseOccurrence: null,
      targetSegmentOrdinal: null,
      closeResult: "phase_advanced",
    }), "invalid_input");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_transitions").get()).toEqual({ count: 0 });
  });

  test("enforces the hard dispatch cap and protects recovery and future-phase reserves", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput(1001, {
      maxProviderDispatches: 4,
      maxProviderOutputTokens: 100,
      maxOutputTokensPerDispatch: 25,
      maxUnsignedBoundaries: 4,
      maxToolCalls: 4,
      maxWorkspaceOperations: 4,
    })).record;
    expectCode(() => reserveWorkSegmentDispatchV1({
      ...reservationInput(admitted.identity.segmentId),
      reservedOutputTokens: 26,
    }), "dispatch_budget_exhausted");

    const usageFor = (output: number): WorkSegmentUsageV1 => ({
      ...USAGE,
      providerOutputTokens: output,
      providerTotalTokens: 10 + output,
      billedOutputTokens: output,
    });
    for (let ordinal = 0; ordinal < 2; ordinal += 1) {
      const reserved = reserveWorkSegmentDispatchV1({
        ...reservationInput(admitted.identity.segmentId, 1010 + ordinal * 3),
        dispatchOrdinal: ordinal,
        idempotencyKey: "dispatch-key-" + ordinal,
        leaseOwner: "dispatch-owner-" + ordinal,
        reservedOutputTokens: 25,
      }).record;
      startWorkSegmentDispatchV1({
        ...startInput(admitted.identity.segmentId, reserved.dispatchId, 1011 + ordinal * 3),
        leaseOwner: "dispatch-owner-" + ordinal,
      });
      settleWorkSegmentDispatchV1({
        ...settlementInput(admitted.identity.segmentId, reserved.dispatchId, 1012 + ordinal * 3),
        leaseOwner: "dispatch-owner-" + ordinal,
        settlementKey: "settlement-key-" + ordinal,
        usage: usageFor(25),
      });
    }
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.recovery.usage.billedOutputTokens).toBe(50);
    expectCode(() => reserveWorkSegmentDispatchV1({
      ...reservationInput(admitted.identity.segmentId, 1020),
      dispatchOrdinal: 2,
      idempotencyKey: "normal-cannot-spend-reserve",
      reservedOutputTokens: 21,
    }), "future_phase_reserve_exhausted");

    const recoveryReservation = reserveWorkSegmentDispatchV1({
      ...reservationInput(admitted.identity.segmentId, 1021),
      dispatchOrdinal: 2,
      idempotencyKey: "recovery-may-spend-recovery-reserve",
      budgetClass: "recovery",
      reservedOutputTokens: 25,
    }).record;
    expect(recoveryReservation.ordinaryOutputTokensReserved).toBe(20);
    expect(recoveryReservation.recoveryReserveOutputTokensReserved).toBe(5);
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, recoveryReservation.dispatchId, 1022));
    settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, recoveryReservation.dispatchId, 1023),
      settlementKey: "recovery-settlement",
      usage: usageFor(25),
    });
    const recovery = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!.recovery;
    expect(recovery.protectedRecoveryReserveOutputTokens).toBe(5);
    expect(recovery.protectedFuturePhaseReserveOutputTokens).toBe(20);
  });
  test("pre-segment owner renewal is idempotent at deadline saturation and rejects replacement authority", () => {
    const saturated = {
      ...createInput(1000),
      runtimeEpoch: 1,
      leaseExpiresAt: 5000,
    };
    renewWorkExecutionOwnerLeaseV1(saturated);
    renewWorkExecutionOwnerLeaseV1({ ...saturated, now: 4999 });
    expectCode(() => renewWorkExecutionOwnerLeaseV1({ ...saturated, now: 5000 }), "stale_owner");

    db.query("UPDATE agent_turn_executions SET cas_owner = ?, cas_revision = 1, cas_expires_at = 9000 WHERE user_id = ? AND id = ?")
      .run("replacement-owner", USER, EXECUTION);
    expectCode(() => renewWorkExecutionOwnerLeaseV1({ ...saturated, now: 4000, leaseExpiresAt: 5000 }), "stale_execution");
    expect(db.query("SELECT cas_owner, cas_revision, cas_expires_at FROM agent_turn_executions WHERE user_id = ? AND id = ?")
      .get(USER, EXECUTION)).toEqual({ cas_owner: "replacement-owner", cas_revision: 1, cas_expires_at: 9000 });
  });

  test("pre-segment renewal atomically projects host workspace mutations before Segment admission", () => {
    db.query("UPDATE agent_turn_workspaces SET revision = 2 WHERE user_id = ? AND execution_id = ? AND workspace_id = ?")
      .run(USER, EXECUTION, WORKSPACE);

    renewWorkExecutionOwnerLeaseV1({
      ...createInput(1000),
      expectedWorkspaceRevision: 2,
      runtimeEpoch: 1,
      leaseExpiresAt: 5000,
    });

    expect(db.query("SELECT workspace_revision, cas_owner, cas_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?")
      .get(USER, EXECUTION)).toEqual({ workspace_revision: 2, cas_owner: OWNER, cas_revision: 0 });
    expect(createWorkSegmentAttemptV1({
      ...createInput(),
      expectedWorkspaceRevision: 2,
      resumeEnvelope: (() => {
        const exact = resumeEnvelope();
        const { envelopeDigest: _digest, ...withoutDigest } = exact;
        const projected = { ...withoutDigest, runtime: { ...exact.runtime, workspaceRevision: 2 } };
        return { ...projected, envelopeDigest: computeWorkSegmentResumeEnvelopeDigestV1(projected) };
      })(),
    })).toMatchObject({ duplicate: false, record: { workspaceRevision: 2 } });
  });

  test("segment and dispatch renewal accept repeated saturated ticks until exact deadline expiry", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const ownerHeartbeat = {
      ...createInput(4999),
      runtimeEpoch: 1,
      currentSegmentId: admitted.identity.segmentId,
      leaseExpiresAt: 5000,
    };
    renewWorkSegmentOwnerLeaseV1(ownerHeartbeat);
    renewWorkSegmentOwnerLeaseV1(ownerHeartbeat);
    const dispatchHeartbeat = {
      ...startInput(admitted.identity.segmentId, reserved.dispatchId, 3999),
      leaseExpiresAt: 5000,
    };
    renewInFlightWorkSegmentDispatchLeaseV1(dispatchHeartbeat);
    renewInFlightWorkSegmentDispatchLeaseV1({ ...dispatchHeartbeat, now: 4999 });
    expectCode(() => renewWorkSegmentOwnerLeaseV1({ ...ownerHeartbeat, now: 5000 }), "stale_owner");
    expectCode(() => renewInFlightWorkSegmentDispatchLeaseV1({ ...dispatchHeartbeat, now: 5000 }), "stale_owner");
  });

  test("heartbeats preserve exact owner and dispatch fences across long provider waits", () => {
    db.query("UPDATE agent_turn_executions SET deadline_at = ? WHERE user_id = ? AND id = ?")
      .run(4_000_000_000_000, USER, EXECUTION);
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const initialExecutionFence = db.query(
      "SELECT cas_revision, phase_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?",
    ).get(USER, EXECUTION);
    const ownerHeartbeat = {
      ...createInput(3999),
      runtimeEpoch: 1,
      currentSegmentId: admitted.identity.segmentId,
      leaseExpiresAt: 200_000,
    };
    expectCode(() => renewWorkSegmentOwnerLeaseV1({
      ...ownerHeartbeat,
      ownerToken: "forged-owner",
    }), "stale_owner");
    renewWorkSegmentOwnerLeaseV1(ownerHeartbeat);
    const dispatchHeartbeat = {
      ...startInput(admitted.identity.segmentId, reserved.dispatchId, 3999),
      leaseExpiresAt: 123_999,
    };
    expectCode(() => renewInFlightWorkSegmentDispatchLeaseV1({
      ...dispatchHeartbeat,
      leaseOwner: "forged-dispatch-owner",
    }), "stale_owner");
    expectCode(() => renewInFlightWorkSegmentDispatchLeaseV1({
      ...dispatchHeartbeat,
      fenceGeneration: 2,
    }), "stale_owner");
    expect(renewInFlightWorkSegmentDispatchLeaseV1(dispatchHeartbeat)).toMatchObject({
      lifecycle: "in_flight",
      fenceGeneration: 1,
      leaseExpiresAt: 123_999,
    });

    renewWorkSegmentOwnerLeaseV1({ ...ownerHeartbeat, now: 123_998, leaseExpiresAt: 300_000 });
    expect(renewInFlightWorkSegmentDispatchLeaseV1({
      ...dispatchHeartbeat,
      now: 123_998,
      leaseExpiresAt: 243_998,
    })).toMatchObject({ lifecycle: "in_flight", fenceGeneration: 1, leaseExpiresAt: 243_998 });
    expectCode(() => settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId, 150_000),
      fenceGeneration: 2,
    }), "stale_owner");
    expect(settleWorkSegmentDispatchV1(
      settlementInput(admitted.identity.segmentId, reserved.dispatchId, 150_000),
    ).record.lifecycle).toBe("settled");
    expect(closeWorkSegmentTerminalV1({
      ...createInput(150_001),
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "heartbeat-terminal-close",
      closeResult: "failed",
      closeReason: "heartbeat_terminal_close",
      boundaryClass: "tool_free_stop",
      usage: USAGE,
    }).record.state).toBe("closed");
    expect(db.query(
      "SELECT lifecycle, close_result, close_reason, closed_at FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
    ).get(USER, EXECUTION, admitted.identity.segmentId)).toEqual({
      lifecycle: "failed",
      close_result: "failed",
      close_reason: "heartbeat_terminal_close",
      closed_at: 150_001,
    });
    expect(db.query(
      "SELECT state, current_segment_id, terminal_close_result, terminal_close_reason FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
    ).get(USER, EXECUTION)).toEqual({
      state: "closed",
      current_segment_id: null,
      terminal_close_result: "failed",
      terminal_close_reason: "heartbeat_terminal_close",
    });
    expect(db.query(
      "SELECT cas_revision, phase_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?",
    ).get(USER, EXECUTION)).toEqual(initialExecutionFence);
  });

  test("terminal completion writes the durable transition, segment close, and recovery close rows", () => {
    const terminalPhasePlan = Object.freeze({
      version: 1 as const,
      phases: Object.freeze([Object.freeze({ ...PHASE_PLAN.phases[0]!, nextPhaseIds: Object.freeze([]) })]),
    });
    const terminalPhasePlanDigest = computeWorkPhasePlanDigestV1(terminalPhasePlan);
    const terminalAttemptBudget = Object.freeze({
      ...ATTEMPT_BUDGET,
      futurePhaseReserveOutputTokens: 0,
    });
    createWorkSegmentAttemptV1({
      ...createInput(),
      phasePlan: terminalPhasePlan,
      phasePlanDigest: terminalPhasePlanDigest,
      remainingRequiredPhaseCount: 0,
      budget: terminalAttemptBudget,
    });
    const baseAdmission = admissionInput(1001, {}, terminalAttemptBudget);
    const { contextDigest: _contextDigest, ...contextWithoutDigest } = baseAdmission.context;
    void _contextDigest;
    const terminalContextWithoutDigest = Object.freeze({
      ...contextWithoutDigest,
      phasePlanDigest: terminalPhasePlanDigest,
    });
    const terminalContext = Object.freeze({
      ...terminalContextWithoutDigest,
      contextDigest: computeWorkSegmentContextDigestV1(terminalContextWithoutDigest),
    });
    const admitted = admitWorkSegmentV1({
      ...baseAdmission,
      context: terminalContext,
      contextDigest: terminalContext.contextDigest,
    }).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    settleWorkSegmentDispatchV1(settlementInput(admitted.identity.segmentId, reserved.dispatchId));
    const source = admitted.identity;
    commitWorkSegmentTransitionV1({
      ...transitionInput(source.segmentId),
      phasePlanDigest: terminalPhasePlanDigest,
      transitionDecisionDigest: computeWorkTransitionDecisionDigestV1({
        phasePlanDigest: terminalPhasePlanDigest,
        source,
        transitionKind: "terminal",
        targetPhaseId: null,
        targetPhaseIndex: null,
        targetPhaseOccurrence: null,
        targetSegmentOrdinal: null,
      }),
      idempotencyKey: "terminal-transition-row",
      transitionKind: "terminal",
      targetPhaseId: null,
      targetPhaseIndex: null,
      targetPhaseOccurrence: null,
      targetSegmentOrdinal: null,
      remainingRequiredPhaseCount: 0,
      closeResult: "work_complete",
    });

    expect(db.query(
      "SELECT transition_kind, target_phase_id, record_complete FROM agent_work_segment_transitions WHERE user_id = ? AND execution_id = ? AND idempotency_key = ?",
    ).get(USER, EXECUTION, "terminal-transition-row")).toEqual({
      transition_kind: "terminal",
      target_phase_id: null,
      record_complete: 1,
    });
    expect(db.query(
      "SELECT lifecycle, close_result, close_reason, closed_at FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
    ).get(USER, EXECUTION, source.segmentId)).toEqual({
      lifecycle: "closed",
      close_result: "work_complete",
      close_reason: "transition:terminal",
      closed_at: 1005,
    });
    expect(db.query(
      "SELECT state, current_segment_id FROM agent_work_segment_recovery WHERE user_id = ? AND execution_id = ?",
    ).get(USER, EXECUTION)).toEqual({ state: "closed", current_segment_id: null });
    const startup = reconcileWorkSegmentRecoveryAtStartupV1(db, 2, 1);
    expect(startup).toMatchObject({ scanned: 1, queued: 1, complete: true, healthy: true });
    const queued = listQueuedWorkCompletionRecoveriesV1(2, db, 1);
    expect(queued).toHaveLength(1);
    const owner = db.query("SELECT cas_owner, cas_revision FROM agent_turn_executions WHERE user_id = ? AND id = ?")
      .get(USER, EXECUTION) as { cas_owner: string; cas_revision: number };
    const terminalTransitionId = queued[0]!.transitions.at(-1)!.transitionId;
    const claimInput = {
      db,
      userId: USER,
      executionId: EXECUTION,
      runtimeEpoch: 2,
      expectedOwnerToken: owner.cas_owner,
      expectedExecutionCasRevision: owner.cas_revision,
      expectedAttemptId: ATTEMPT,
      expectedWorkspaceId: WORKSPACE,
      expectedTerminalTransitionId: terminalTransitionId,
      claimOwnerToken: "completion-drain-owner",
      now: Date.now(),
    } as const;
    const claimed = claimQueuedWorkCompletionRecoveryV1(claimInput);
    expect(claimed?.recovery.executionCasRevision).toBe(owner.cas_revision + 1);
    expect(listQueuedWorkCompletionRecoveriesV1(2, db, 1)).toEqual([]);
    expect(claimQueuedWorkCompletionRecoveryV1(claimInput)).toBeNull();
    db.query("UPDATE agent_turn_executions SET cas_expires_at = 0 WHERE user_id = ? AND id = ?")
      .run(USER, EXECUTION);
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 2, 1)).toMatchObject({ queued: 1, healthy: true });
    expect(listQueuedWorkCompletionRecoveriesV1(2, db, 1)).toHaveLength(1);
  });

  test("caught provider failure settles conservatively and terminalizes the chain without an active restart window", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const conservativeUsage: WorkSegmentUsageV1 = Object.freeze({
      providerDispatches: 1,
      providerInputTokens: 0,
      providerOutputTokens: reserved.reservedOutputTokens,
      providerTotalTokens: reserved.reservedOutputTokens,
      billedOutputTokens: reserved.reservedOutputTokens,
      toolCalls: 0,
      workspaceOperations: 0,
      unsignedBoundaries: 1,
      receiveBytes: 0,
      publishedOutputBytes: 0,
    });
    expect(settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      settlementKey: "provider-failure-settlement",
      boundaryClass: "provider_protocol_failure",
      usage: conservativeUsage,
    }).record).toMatchObject({
      lifecycle: "settled",
      boundaryClass: "provider_protocol_failure",
      usage: conservativeUsage,
    });
    expect(closeWorkSegmentTerminalV1({
      ...createInput(1005),
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "provider-failure-terminal-close",
      closeResult: "failed",
      closeReason: "provider_protocol_failure",
      boundaryClass: "provider_protocol_failure",
      usage: conservativeUsage,
    }).record).toMatchObject({
      state: "closed",
      currentSegmentId: null,
      terminalCloseResult: "failed",
      terminalCloseReason: "provider_protocol_failure",
    });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.segments[0]).toMatchObject({ lifecycle: "failed", boundaryClass: "provider_protocol_failure" });
    expect(chain.dispatches[0]).toMatchObject({ lifecycle: "settled", boundaryClass: "provider_protocol_failure" });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 24).scanned).toBe(0);
    expect(listQueuedWorkSegmentRecoveriesV1(24, db)).toEqual([]);
  });

  test("renewing an unknown in-flight dispatch never makes it replayable after restart", () => {
    db.query("UPDATE agent_turn_executions SET deadline_at = ? WHERE user_id = ? AND id = ?")
      .run(4_000_000_000_000, USER, EXECUTION);
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    renewWorkSegmentOwnerLeaseV1({
      ...createInput(3999),
      runtimeEpoch: 1,
      currentSegmentId: admitted.identity.segmentId,
      leaseExpiresAt: 200_000,
    });
    renewInFlightWorkSegmentDispatchLeaseV1({
      ...startInput(admitted.identity.segmentId, reserved.dispatchId, 3999),
      leaseExpiresAt: 123_999,
    });

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 23)).toMatchObject({
      scanned: 1,
      queued: 0,
      fenced: 1,
      terminalized: 1,
    });
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.dispatches[0]).toMatchObject({
      lifecycle: "interrupted",
      interruptionReason: "startup_unsettled_dispatch_no_replay",
    });
  });
  test("reclaims and interrupts only at exact lease expiry, then closes terminally without a handoff", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    expectCode(() => reclaimReservedWorkSegmentDispatchV1({
      ...createInput(3999),
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      newLeaseOwner: "reclaimed-owner",
      newLeaseExpiresAt: 4500,
    }), "stale_owner");
    const reclaimed = reclaimReservedWorkSegmentDispatchV1({
      ...createInput(4000),
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      newLeaseOwner: "reclaimed-owner",
      newLeaseExpiresAt: 4500,
    });
    expect(reclaimed.fenceGeneration).toBe(2);
    expect(reclaimed.leaseOwner).toBe("reclaimed-owner");
    startWorkSegmentDispatchV1({
      ...startInput(admitted.identity.segmentId, reserved.dispatchId, 4001),
      leaseOwner: "reclaimed-owner",
      fenceGeneration: 2,
    });
    expectCode(() => interruptUnsettledWorkSegmentDispatchV1({
      ...createInput(4499),
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      interruptionKey: "interruption-key",
      reason: "unknown provider outcome",
    }), "stale_owner");
    const interrupted = interruptUnsettledWorkSegmentDispatchV1({
      ...createInput(4500),
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      interruptionKey: "interruption-key",
      reason: "unknown provider outcome",
    });
    expect(interrupted.record.lifecycle).toBe("interrupted");
    expect(interrupted.record.usage?.billedOutputTokens).toBe(20);
    expect(interruptUnsettledWorkSegmentDispatchV1({
      ...createInput(4501),
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      interruptionKey: "interruption-key",
      reason: "unknown provider outcome",
    }).duplicate).toBe(true);

    const beforeClose = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    const segmentUsage = beforeClose.segments[0]!.usage;
    expect(beforeClose.recovery.usage.billedOutputTokens).toBe(20);
    const closed = closeWorkSegmentTerminalV1({
      ...createInput(4502),
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "terminal-close-key",
      closeResult: "failed",
      closeReason: "unknown_provider_outcome",
      boundaryClass: "provider_protocol_failure",
      usage: segmentUsage,
    });
    expect(closed.record.state).toBe("closed");
    expect(closed.record.currentSegmentId).toBeNull();
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.transitions).toHaveLength(0);
    db.query("UPDATE agent_turn_executions SET state = 'COMMITTED', cas_revision = 9, cas_owner = NULL, cas_expires_at = NULL WHERE id = ?")
      .run(EXECUTION);
    db.query("UPDATE agent_turn_workspaces SET state = 'frozen' WHERE workspace_id = ?").run(WORKSPACE);
    expect(readWorkSegmentInspectionChainV1(inspectionInput())?.recovery.terminalCloseResult).toBe("failed");
    expectCode(() => readWorkSegmentInspectionChainV1({ ...inspectionInput(), userId: OTHER_USER }), "not_found");
    expectCode(() => readWorkSegmentInspectionChainV1({
      ...inspectionInput(),
      attemptId: "forged-attempt",
    }), "stale_execution");
  });

  test("does not reserve interrupted dispatch output twice", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const first = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, first.dispatchId));
    interruptUnsettledWorkSegmentDispatchV1({
      ...createInput(4000),
      segmentId: admitted.identity.segmentId,
      dispatchId: first.dispatchId,
      interruptionKey: "first-interruption-key",
      reason: "unknown provider outcome",
    });

    const second = reserveWorkSegmentDispatchV1({
      ...reservationInput(admitted.identity.segmentId, 4001),
      dispatchOrdinal: 1,
      idempotencyKey: "dispatch-key-1",
      leaseExpiresAt: 4500,
    }).record;
    expect(second.dispatchOrdinal).toBe(1);
    const recovery = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!.recovery;
    expect(recovery.usage.billedOutputTokens).toBe(20);
    expect(recovery.usage.providerDispatches).toBe(1);
  });

  test("terminal close accepts read-only workspace operations without a revision advance", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const readOnlyWorkspaceUsage = Object.freeze({
      ...USAGE,
      toolCalls: 2,
      workspaceOperations: 2,
    });
    settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      usage: readOnlyWorkspaceUsage,
    });

    const closed = closeWorkSegmentTerminalV1({
      ...createInput(1005),
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "read-only-terminal-close-key",
      closeResult: "failed",
      closeReason: "read_only_recovery_exhausted",
      boundaryClass: "tool_free_stop",
      usage: readOnlyWorkspaceUsage,
    });
    expect(closed.record.state).toBe("closed");
    expect(closed.record.workspaceRevision).toBe(0);
    expect(closed.record.usage.workspaceOperations).toBe(2);
  });

  test("finalizes exact post-tool effects without projection regression", () => {
    const { segmentId, dispatchId } = createRunningSegment();
    const mutation = workspaceMutationReservation(segmentId, "workspace-effect-0", "record_finding");
    const usage: WorkSegmentUsageV1 = {
      ...USAGE,
      toolCalls: 1,
      workspaceOperations: 1,
      unsignedBoundaries: 0,
    };
    const settled = settleWorkSegmentDispatchV1({
      ...settlementInput(segmentId, dispatchId),
      boundaryClass: "tool_action",
      usage,
      workspaceMutations: [mutation],
    }).record;
    db.query("UPDATE agent_turn_workspaces SET revision = 1 WHERE workspace_id = ? AND execution_id = ?")
      .run(WORKSPACE, EXECUTION);
    insertWorkspaceMutationReceipt(segmentId, mutation.operationKey, DIGEST_A, 0, 1);
    const finalized = finalizeSettledWorkSegmentDispatchEffectsV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 1,
      now: 1005,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId,
      dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      owner: mutation,
      finalizationKey: "effect-finalization-0",
      effects: [{
        ...mutation,
        outcome: "mutated",
        outcomeCode: null,
        operationDigest: DIGEST_A,
        beforeWorkspaceRevision: 0,
        afterWorkspaceRevision: 1,
      }],
      nextWorkspaceRevision: 1,
    });
    expect(finalized.record.settledWorkspaceRevision).toBe(1);
    expect(finalized.record.settlementDigest).not.toBe(settled.settlementDigest);
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.recovery.workspaceRevision).toBe(1);
    expect(db.query("SELECT workspace_revision FROM agent_turn_executions WHERE id = ?")
      .get(EXECUTION)).toEqual({ workspace_revision: 1 });
  });

  test("appends durable owner reservations and finalizes interleaved root and child effects in isolation", () => {
    const attemptBudget = {
      ...createInput().budget,
      maxToolCalls: 8,
      maxWorkspaceOperations: 8,
    };
    createWorkSegmentAttemptV1({ ...createInput(), budget: attemptBudget });
    const admitted = admitWorkSegmentV1(admissionInput(1001, {
      maxToolCalls: 8,
      maxWorkspaceOperations: 8,
    }, attemptBudget)).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));

    const rootOwner = Object.freeze({
      segmentId: admitted.identity.segmentId,
      logicalDispatch: 0,
      frameId: EXECUTION,
    });
    const childOwner = Object.freeze({
      segmentId: admitted.identity.segmentId,
      logicalDispatch: 0,
      frameId: "interleaved-child-frame",
    });
    const rootMutations = Object.freeze([
      workspaceMutationReservation(admitted.identity.segmentId, "interleaved-root-a", "create_task"),
      workspaceMutationReservation(admitted.identity.segmentId, "interleaved-root-b", "record_decision"),
    ]);
    const childMutations = Object.freeze([
      workspaceMutationReservation(
        admitted.identity.segmentId,
        "interleaved-child-a",
        "record_finding",
        childOwner.frameId,
      ),
      workspaceMutationReservation(
        admitted.identity.segmentId,
        "interleaved-child-no-op",
        "record_decision",
        childOwner.frameId,
      ),
      workspaceMutationReservation(
        admitted.identity.segmentId,
        "interleaved-child-failed",
        "create_task",
        childOwner.frameId,
      ),
    ]);
    const usage = Object.freeze({
      ...USAGE,
      toolCalls: 1,
      workspaceOperations: 5,
      unsignedBoundaries: 0,
    });
    const settled = settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      boundaryClass: "tool_action",
      usage,
      workspaceMutations: rootMutations,
    }).record;
    const appendInput = {
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1005,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      appendKey: "interleaved-child-reservations",
      owner: childOwner,
      mutations: childMutations,
    } as const;
    const appended = appendSettledWorkSegmentDispatchMutationReservationsV1(appendInput);
    expect(appended.duplicate).toBe(false);
    expect(appended.record.appendOrdinal).toBe(0);
    expect(appended.record.owner).toEqual(childOwner);
    const workspaceAccounting = db.query(
      "SELECT d.workspace_operations AS dispatch_operations, s.workspace_operations AS segment_operations, r.workspace_operations AS attempt_operations FROM agent_work_segment_dispatches AS d JOIN agent_work_segments AS s ON s.user_id = d.user_id AND s.execution_id = d.execution_id AND s.segment_id = d.segment_id JOIN agent_work_segment_recovery AS r ON r.user_id = d.user_id AND r.execution_id = d.execution_id WHERE d.user_id = ? AND d.execution_id = ? AND d.dispatch_id = ?",
    );
    const fullyCharged = { dispatch_operations: 8, segment_operations: 8, attempt_operations: 8 };
    expect(workspaceAccounting.get(USER, EXECUTION, reserved.dispatchId)).toEqual(fullyCharged);
    expect(appendSettledWorkSegmentDispatchMutationReservationsV1({
      ...appendInput,
      now: 1006,
    }).duplicate).toBe(true);
    expect(workspaceAccounting.get(USER, EXECUTION, reserved.dispatchId)).toEqual(fullyCharged);
    expectCode(() => appendSettledWorkSegmentDispatchMutationReservationsV1({
      ...appendInput,
      now: 1006,
      mutations: [
        childMutations[0]!,
        childMutations[1]!,
        { ...childMutations[2]!, operationKind: "record_finding" },
      ],
    }), "idempotency_conflict");
    expectCode(() => appendSettledWorkSegmentDispatchMutationReservationsV1({
      ...appendInput,
      now: 1006,
      appendKey: "mixed-owner-reservations",
      mutations: [rootMutations[0]!],
    }), "invalid_input");
    const overLimitMutation = workspaceMutationReservation(
      admitted.identity.segmentId, "interleaved-child-over-limit", "record_finding", childOwner.frameId,
    );
    expectCode(() => appendSettledWorkSegmentDispatchMutationReservationsV1({
      ...appendInput,
      now: 1007,
      appendKey: "interleaved-child-over-limit",
      mutations: [overLimitMutation],
    }), "segment_budget_exhausted");
    expect(workspaceAccounting.get(USER, EXECUTION, reserved.dispatchId)).toEqual(fullyCharged);
    expectCode(() => appendSettledWorkSegmentDispatchMutationReservationsV1({
      ...appendInput,
      now: 1008,
      appendKey: "interleaved-child-over-limit",
      mutations: [overLimitMutation],
    }), "segment_budget_exhausted");
    expect(workspaceAccounting.get(USER, EXECUTION, reserved.dispatchId)).toEqual(fullyCharged);

    db.query("UPDATE agent_work_segments SET max_workspace_operations = 9 WHERE user_id = ? AND execution_id = ? AND segment_id = ?")
      .run(USER, EXECUTION, admitted.identity.segmentId);
    expectCode(() => appendSettledWorkSegmentDispatchMutationReservationsV1({
      ...appendInput,
      now: 1009,
      appendKey: "interleaved-child-attempt-over-limit",
      mutations: [workspaceMutationReservation(
        admitted.identity.segmentId, "interleaved-child-attempt-over-limit", "record_finding", childOwner.frameId,
      )],
    }), "attempt_budget_exhausted");
    expect(workspaceAccounting.get(USER, EXECUTION, reserved.dispatchId)).toEqual(fullyCharged);
    db.query("UPDATE agent_work_segment_recovery SET max_workspace_operations = 9 WHERE user_id = ? AND execution_id = ?")
      .run(USER, EXECUTION);
    db.exec(`CREATE TRIGGER fail_reservation_append_crash_window
      BEFORE INSERT ON agent_run_audit_records
      WHEN NEW.dedupe_key LIKE '%interleaved-child-crash-window'
      BEGIN SELECT RAISE(ABORT, 'forced reservation append crash window'); END`);
    expect(() => appendSettledWorkSegmentDispatchMutationReservationsV1({
      ...appendInput,
      now: 1010,
      appendKey: "interleaved-child-crash-window",
      mutations: [workspaceMutationReservation(
        admitted.identity.segmentId, "interleaved-child-crash-window", "record_finding", childOwner.frameId,
      )],
    })).toThrow("forced reservation append crash window");
    expect(workspaceAccounting.get(USER, EXECUTION, reserved.dispatchId)).toEqual(fullyCharged);
    db.exec("DROP TRIGGER fail_reservation_append_crash_window");
    db.query(`UPDATE agent_turn_workspaces SET revision = 3
      WHERE user_id = ? AND execution_id = ? AND workspace_id = ?`)
      .run(USER, EXECUTION, WORKSPACE);
    insertWorkspaceMutationReceipt(
      admitted.identity.segmentId,
      rootMutations[0]!.operationKey,
      DIGEST_A,
      0,
      1,
    );
    insertWorkspaceMutationReceipt(
      admitted.identity.segmentId,
      childMutations[0]!.operationKey,
      DIGEST_B,
      1,
      2,
      childOwner.frameId,
    );
    insertWorkspaceMutationReceipt(
      admitted.identity.segmentId,
      rootMutations[1]!.operationKey,
      DIGEST_C,
      2,
      3,
    );
    const rootEffects = Object.freeze([
      Object.freeze({
        ...rootMutations[0]!, outcome: "mutated" as const, outcomeCode: null,
        operationDigest: DIGEST_A, beforeWorkspaceRevision: 0, afterWorkspaceRevision: 1,
      }),
      Object.freeze({
        ...rootMutations[1]!, outcome: "mutated" as const, outcomeCode: null,
        operationDigest: DIGEST_C, beforeWorkspaceRevision: 2, afterWorkspaceRevision: 3,
      }),
    ]);
    const childEffects = Object.freeze([
      Object.freeze({
        ...childMutations[0]!, outcome: "mutated" as const, outcomeCode: null,
        operationDigest: DIGEST_B, beforeWorkspaceRevision: 1, afterWorkspaceRevision: 2,
      }),
      Object.freeze({
        ...childMutations[1]!, outcome: "no_op" as const, outcomeCode: null,
        operationDigest: null, beforeWorkspaceRevision: 2, afterWorkspaceRevision: 2,
      }),
      Object.freeze({
        ...childMutations[2]!, outcome: "failed" as const,
        outcomeCode: "workspace_operation_failed", operationDigest: null,
        beforeWorkspaceRevision: 2, afterWorkspaceRevision: 2,
      }),
    ]);
    expectCode(() => finalizeSettledWorkSegmentDispatchEffectsV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 3,
      now: 1007,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      owner: rootOwner,
      finalizationKey: "mixed-owner-finalization",
      effects: [rootEffects[0]!, childEffects[0]!],
      nextWorkspaceRevision: 3,
    }), "idempotency_conflict");

    const rootFinalizationInput = {
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 3,
      now: 1007,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      owner: rootOwner,
      finalizationKey: "interleaved-root-finalization",
      effects: rootEffects,
      nextWorkspaceRevision: 3,
    } as const;
    const rootFinalized = finalizeSettledWorkSegmentDispatchEffectsV1(rootFinalizationInput);
    expect(rootFinalized.duplicate).toBe(false);
    expect(rootFinalized.record).toMatchObject({
      settlementDigest: settled.settlementDigest,
      settledWorkspaceRevision: 0,
    });
    expect(db.query(`SELECT COUNT(*) AS count FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ? AND event_id = ?
        AND json_extract(payload_json, '$.kind') = 'work_dispatch_effect_finalization'`)
      .get(USER, ATTEMPT, reserved.dispatchId)).toEqual({ count: 0 });
    expect(finalizeSettledWorkSegmentDispatchEffectsV1({
      ...rootFinalizationInput,
      now: 1008,
    }).duplicate).toBe(true);
    expectCode(() => finalizeSettledWorkSegmentDispatchEffectsV1({
      ...rootFinalizationInput,
      now: 1008,
      finalizationKey: "changed-root-finalization",
    }), "idempotency_conflict");



    const childFinalizationInput = {
      ...rootFinalizationInput,
      now: 1010,
      owner: childOwner,
      finalizationKey: "interleaved-child-finalization",
      effects: childEffects,
    } as const;
    const childFinalized = finalizeSettledWorkSegmentDispatchEffectsV1(childFinalizationInput);
    expect(childFinalized.duplicate).toBe(false);
    expect(childFinalized.record.settledWorkspaceRevision).toBe(3);
    expect(childFinalized.record.settlementDigest).not.toBe(settled.settlementDigest);
    expect(finalizeSettledWorkSegmentDispatchEffectsV1({
      ...childFinalizationInput,
      now: 1011,
    }).duplicate).toBe(true);

    const payloads = (db.query(`SELECT payload_json FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ? AND event_id = ?`)
      .all(USER, ATTEMPT, reserved.dispatchId) as { payload_json: string }[])
      .map((row) => JSON.parse(row.payload_json) as {
        kind: string;
        owner?: { frameId: string };
        effects?: { operationKey: string; outcome: string; outcomeCode: string | null }[];
      });
    const ownerFinalizations = payloads.filter((payload) => (
      payload.kind === "work_dispatch_owner_effect_finalization"
    ));
    expect(ownerFinalizations).toHaveLength(2);
    expect(Object.fromEntries(ownerFinalizations.map((payload) => [
      payload.owner!.frameId,
      payload.effects!.map((effect) => effect.operationKey),
    ]))).toEqual({
      [EXECUTION]: ["interleaved-root-a", "interleaved-root-b"],
      [childOwner.frameId]: [
        "interleaved-child-a",
        "interleaved-child-no-op",
        "interleaved-child-failed",
      ],
    });
    const aggregate = payloads.find((payload) => payload.kind === "work_dispatch_effect_finalization")!;
    expect(aggregate.effects).toMatchObject([
      { operationKey: "interleaved-root-a", outcome: "mutated", outcomeCode: null },
      { operationKey: "interleaved-root-b", outcome: "mutated", outcomeCode: null },
      { operationKey: "interleaved-child-a", outcome: "mutated", outcomeCode: null },
      { operationKey: "interleaved-child-no-op", outcome: "no_op", outcomeCode: null },
      {
        operationKey: "interleaved-child-failed",
        outcome: "failed",
        outcomeCode: "workspace_operation_failed",
      },
    ]);
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.recovery.workspaceRevision).toBe(3);
    expect(db.query("SELECT workspace_revision FROM agent_turn_executions WHERE id = ?")
      .get(EXECUTION)).toEqual({ workspace_revision: 3 });
  });

  test("seals post-settlement reservation appends at the first owner finalization", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const rootMutation = workspaceMutationReservation(
      admitted.identity.segmentId,
      "sealed-root-no-op",
      "record_finding",
    );
    const childMutation = workspaceMutationReservation(
      admitted.identity.segmentId,
      "sealed-child-no-op",
      "record_decision",
      "sealed-child-frame",
    );
    const settled = settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      boundaryClass: "tool_action",
      usage: { ...USAGE, toolCalls: 1, workspaceOperations: 1, unsignedBoundaries: 0 },
      workspaceMutations: [rootMutation],
    }).record;
    const appended = appendSettledWorkSegmentDispatchMutationReservationsV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1005,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      appendKey: "sealed-child-reservation",
      owner: childMutation,
      mutations: [childMutation],
    });
    expect(appended.duplicate).toBe(false);
    const rootPending = finalizeSettledWorkSegmentDispatchEffectsV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1006,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      owner: rootMutation,
      finalizationKey: "sealed-root-finalization",
      effects: [{
        ...rootMutation,
        outcome: "no_op",
        outcomeCode: null,
        operationDigest: null,
        beforeWorkspaceRevision: 0,
        afterWorkspaceRevision: 0,
      }],
      nextWorkspaceRevision: 0,
    });
    expect(rootPending.record.settlementDigest).toBe(settled.settlementDigest);
    expectCode(() => appendSettledWorkSegmentDispatchMutationReservationsV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1007,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      appendKey: "sealed-late-reservation",
      owner: {
        segmentId: admitted.identity.segmentId,
        logicalDispatch: 0,
        frameId: "sealed-late-frame",
      },
      mutations: [workspaceMutationReservation(
        admitted.identity.segmentId,
        "sealed-late-mutation",
        "create_task",
        "sealed-late-frame",
      )],
    }), "stale_segment");
    expect(finalizeSettledWorkSegmentDispatchEffectsV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1008,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      owner: childMutation,
      finalizationKey: "sealed-child-finalization",
      effects: [{
        ...childMutation,
        outcome: "no_op",
        outcomeCode: null,
        operationDigest: null,
        beforeWorkspaceRevision: 0,
        afterWorkspaceRevision: 0,
      }],
      nextWorkspaceRevision: 0,
    }).record.settledWorkspaceRevision).toBe(0);
  });

  test("fails closed when nested handoff identities or the recovery chain are corrupt", () => {
    const { segmentId, dispatchId } = createRunningSegment();
    settleWorkSegmentDispatchV1(settlementInput(segmentId, dispatchId));
    commitWorkSegmentTransitionV1(transitionInput(segmentId));
    db.query("UPDATE agent_work_segment_transitions SET accepted_task_ids_json = ? WHERE user_id = ? AND execution_id = ?")
      .run(JSON.stringify(["x".repeat(257)]), USER, EXECUTION);
    expectCode(() => readWorkSegmentRecoveryChainV1(USER, EXECUTION, db), "integrity_error");

    db.query("UPDATE agent_work_segment_transitions SET accepted_task_ids_json = ? WHERE user_id = ? AND execution_id = ?")
      .run(JSON.stringify([]), USER, EXECUTION);
    db.query("UPDATE agent_work_segment_recovery SET next_segment_ordinal = 3 WHERE user_id = ? AND execution_id = ?")
      .run(USER, EXECUTION);
    expectCode(() => readWorkSegmentRecoveryChainV1(USER, EXECUTION, db), "integrity_error");
  });

  test("allows maxSegments one to admit then terminally fails rather than targeting a second segment", () => {
    const attemptBudget = { ...createInput().budget, maxSegments: 1 };
    createWorkSegmentAttemptV1({ ...createInput(), budget: attemptBudget });
    const admitted = admitWorkSegmentV1(admissionInput(1001, {}, attemptBudget)).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    settleWorkSegmentDispatchV1(settlementInput(admitted.identity.segmentId, reserved.dispatchId));

    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)?.recovery.nextSegmentOrdinal).toBe(0);
    expectCode(() => commitWorkSegmentTransitionV1(transitionInput(admitted.identity.segmentId)), "attempt_budget_exhausted");

    closeWorkSegmentTerminalV1({
      db, userId: USER, executionId: EXECUTION, ownerToken: OWNER,
      expectedExecutionCasRevision: 0, expectedWorkspaceRevision: 0, now: 1006,
      attemptId: ATTEMPT, workspaceId: WORKSPACE, sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "terminal-budget-close", closeResult: "failed",
      closeReason: "attempt_budget_exhausted", boundaryClass: "tool_free_stop", usage: USAGE,
    });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db);
    expect(chain?.recovery.state).toBe("closed");
    expect(chain?.recovery.nextSegmentOrdinal).toBe(1);
    expect(chain?.segments[0]?.lifecycle).toBe("failed");
  });

  test("closes an admitted zero-dispatch segment with an explicit null boundary", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    expectCode(() => closeWorkSegmentTerminalV1({
      ...createInput(1002),
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "running-only-close",
      closeResult: "failed",
      closeReason: "must_not_close_admitted",
      boundaryClass: "tool_free_stop",
      usage: {
        providerDispatches: 0,
        providerInputTokens: 0,
        providerOutputTokens: 0,
        providerTotalTokens: 0,
        billedOutputTokens: 0,
        toolCalls: 0,
        workspaceOperations: 0,
        unsignedBoundaries: 0,
        receiveBytes: 0,
        publishedOutputBytes: 0,
      },
    }), "stale_segment");
    const closeInput = {
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1002,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "admitted-terminal-close",
      closeResult: "failed" as const,
      closeReason: "resume_deadline_expired",
    };
    expect(closeAdmittedWorkSegmentWithoutDispatchTerminalV1(closeInput).duplicate).toBe(false);
    expect(closeAdmittedWorkSegmentWithoutDispatchTerminalV1({ ...closeInput, now: 1003 }).duplicate).toBe(true);
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.dispatches).toEqual([]);
    expect(chain.recovery).toMatchObject({
      state: "closed",
      terminalBoundaryClass: null,
      usage: {
        providerDispatches: 0,
        providerInputTokens: 0,
        providerOutputTokens: 0,
        providerTotalTokens: 0,
        billedOutputTokens: 0,
        toolCalls: 0,
        workspaceOperations: 0,
        unsignedBoundaries: 0,
        receiveBytes: 0,
        publishedOutputBytes: 0,
      },
    });
  });

  test("keeps pre-deadline Stop terminal-close grace anchored to the deadline", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const deadlineAt = 10_000;
    const cancelRequestedAt = 2_000;
    db.query(
      "UPDATE agent_turn_executions SET deadline_at = ?, cancel_requested_at = ?, cas_expires_at = ? WHERE user_id = ? AND id = ?",
    ).run(deadlineAt, cancelRequestedAt, deadlineAt, USER, EXECUTION);
    const closeInput = {
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "bounded-cancellation-terminal-close",
      closeResult: "cancelled" as const,
      closeReason: "user_stop",
    };
    expectCode(() => closeAdmittedWorkSegmentWithoutDispatchTerminalV1({
      ...closeInput,
      now: deadlineAt + WORK_CANCELLATION_TERMINAL_CLOSE_GRACE_MS + 1,
    }), "stale_owner");
    expect(closeAdmittedWorkSegmentWithoutDispatchTerminalV1({
      ...closeInput,
      now: deadlineAt + WORK_CANCELLATION_TERMINAL_CLOSE_GRACE_MS,
    }).record).toMatchObject({ state: "closed", currentSegmentId: null, terminalCloseResult: "cancelled" });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.segments).toHaveLength(1);
    expect(chain.segments[0]).toMatchObject({ lifecycle: "cancelled", closeResult: "cancelled" });
  });

  test("anchors delayed cancellation terminal-close grace to durable marker acceptance", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const deadlineAt = 2_000;
    const cancelRequestedAt = 6_000;
    db.query(
      "UPDATE agent_turn_executions SET deadline_at = ?, cancel_requested_at = ?, cas_expires_at = ? WHERE user_id = ? AND id = ?",
    ).run(deadlineAt, cancelRequestedAt, deadlineAt, USER, EXECUTION);

    expect(closeAdmittedWorkSegmentWithoutDispatchTerminalV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: cancelRequestedAt + WORK_CANCELLATION_TERMINAL_CLOSE_GRACE_MS,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "delayed-cancellation-terminal-close",
      closeResult: "cancelled",
      closeReason: "deadline_stop_accepted",
    }).record).toMatchObject({
      state: "closed",
      currentSegmentId: null,
      terminalCloseResult: "cancelled",
    });
  });

  test("rejects cancellation terminal close beyond delayed marker grace", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const deadlineAt = 2_000;
    const cancelRequestedAt = 6_000;
    db.query(
      "UPDATE agent_turn_executions SET deadline_at = ?, cancel_requested_at = ?, cas_expires_at = ? WHERE user_id = ? AND id = ?",
    ).run(deadlineAt, cancelRequestedAt, deadlineAt, USER, EXECUTION);

    expectCode(() => closeAdmittedWorkSegmentWithoutDispatchTerminalV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: cancelRequestedAt + WORK_CANCELLATION_TERMINAL_CLOSE_GRACE_MS + 1,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "expired-delayed-cancellation-terminal-close",
      closeResult: "cancelled",
      closeReason: "deadline_stop_too_late",
    }), "stale_owner");
    expect(readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)).toMatchObject({
      recovery: { state: "active", currentSegmentId: admitted.identity.segmentId },
      segments: [expect.objectContaining({ lifecycle: "admitted", closeResult: null })],
    });
  });

  test("settles an expired in-flight dispatch only under exact cancellation close authority", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    expectCode(() => settleWorkSegmentDispatchV1(
      settlementInput(admitted.identity.segmentId, reserved.dispatchId, 4_001),
    ), "stale_owner");

    db.query(
      "UPDATE agent_turn_executions SET deadline_at = 4000, cancel_requested_at = 3999, cas_expires_at = 4000 WHERE user_id = ? AND id = ?",
    ).run(USER, EXECUTION);
    expect(settleWorkSegmentDispatchV1(
      settlementInput(admitted.identity.segmentId, reserved.dispatchId, 4_001),
    ).record).toMatchObject({
      lifecycle: "settled",
      leaseOwner: null,
      leaseExpiresAt: null,
      settledAt: 4_001,
    });
  });

  test("rejects admitted terminal close after any dispatch reservation history", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId));
    expectCode(() => closeAdmittedWorkSegmentWithoutDispatchTerminalV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1003,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: "admitted-close-with-history",
      closeResult: "failed",
      closeReason: "must_reject_history",
    }), "stale_segment");
  });

  test("startup deadline terminalization preserves the null boundary and zero usage", () => {
    const deadlineAt = 2_000;
    db.query("UPDATE agent_turn_executions SET deadline_at = ? WHERE user_id = ? AND id = ?")
      .run(deadlineAt, USER, EXECUTION);
    createWorkSegmentAttemptV1(createInput(1000, DEFAULT_FIXTURE, deadlineAt));
    admitWorkSegmentV1(admissionInput(1001, {}, ATTEMPT_BUDGET, DEFAULT_FIXTURE, deadlineAt));
    db.query("UPDATE agent_turn_executions SET cas_expires_at = ? WHERE user_id = ? AND id = ?")
      .run(deadlineAt, USER, EXECUTION);
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 2, 1)).toMatchObject({
      scanned: 1,
      closed: 1,
      terminalized: 1,
      healthy: true,
    });
    const chain = readWorkSegmentRecoveryChainV1(USER, EXECUTION, db)!;
    expect(chain.dispatches).toEqual([]);
    expect(chain.recovery.terminalBoundaryClass).toBeNull();
    expect(chain.recovery.usage.providerDispatches).toBe(0);
    expect(chain.recovery).toMatchObject({
      state: "closed",
      terminalCloseResult: "failed",
      terminalCloseReason: "root_wall_clock_limit_exceeded",
    });
    expect(chain.segments[0]).toMatchObject({
      lifecycle: "failed",
      closeResult: "failed",
      closeReason: "root_wall_clock_limit_exceeded",
    });
    expect(reconcileAgentTurns(db)).toMatchObject({
      claimed: 0,
      projectionRepairs: 1,
      failedInterrupted: 0,
      complete: true,
    });
    expect(db.query("SELECT state, terminal_code FROM agent_turn_executions WHERE id = ?")
      .get(EXECUTION)).toEqual({
      state: "TIMED_OUT",
      terminal_code: "root_wall_clock_limit_exceeded",
    });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 2, 1).scanned).toBe(0);
    expect(reconcileAgentTurns(db).claimed).toBe(0);
    expect(chain.recovery.usage.workspaceOperations).toBe(0);
  });

  test("finalizes an ordered partial mutation batch exactly once and advances the next dispatch cursor", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput(1001, {
      maxToolCalls: 4,
      maxWorkspaceOperations: 4,
    })).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const batchMutations = Object.freeze([
      workspaceMutationReservation(admitted.identity.segmentId, "batch-mutation-a", "create_task"),
      workspaceMutationReservation(admitted.identity.segmentId, "batch-mutation-b", "record_finding"),
      workspaceMutationReservation(admitted.identity.segmentId, "batch-mutation-c", "record_decision"),
    ]);
    const batchUsage = { ...USAGE, toolCalls: 3, workspaceOperations: 4, unsignedBoundaries: 0 };
    const settled = settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      boundaryClass: "tool_action",
      usage: batchUsage,
      workspaceMutations: batchMutations,
    }).record;
    expectCode(() => commitWorkSegmentTransitionV1({
      ...transitionInput(admitted.identity.segmentId),
      usage: batchUsage,
    }), "stale_segment");
    db.query("UPDATE agent_turn_workspaces SET revision = 2 WHERE user_id = ? AND execution_id = ? AND workspace_id = ?")
      .run(USER, EXECUTION, WORKSPACE);
    insertWorkspaceMutationReceipt(admitted.identity.segmentId, batchMutations[0]!.operationKey, DIGEST_A, 0, 1);
    insertWorkspaceMutationReceipt(admitted.identity.segmentId, batchMutations[2]!.operationKey, DIGEST_B, 1, 2);
    const finalizeInput = {
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 2,
      now: 1006,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      owner: batchMutations[0]!,
      finalizationKey: "partial-batch-finalization",
      effects: [
        {
          ...batchMutations[0]!,
          outcome: "mutated",
          outcomeCode: null,
          operationDigest: DIGEST_A,
          beforeWorkspaceRevision: 0,
          afterWorkspaceRevision: 1,
        },
        {
          ...batchMutations[1]!,
          outcome: "failed",
          outcomeCode: "workspace_operation_failed",
          operationDigest: null,
          beforeWorkspaceRevision: 1,
          afterWorkspaceRevision: 1,
        },
        {
          ...batchMutations[2]!,
          outcome: "mutated",
          outcomeCode: null,
          operationDigest: DIGEST_B,
          beforeWorkspaceRevision: 1,
          afterWorkspaceRevision: 2,
        },
      ],
      nextWorkspaceRevision: 2,
    } as const;
    expect(finalizeSettledWorkSegmentDispatchEffectsV1(finalizeInput).duplicate).toBe(false);
    expect(finalizeSettledWorkSegmentDispatchEffectsV1({ ...finalizeInput, now: 1007 }).duplicate).toBe(true);
    expectCode(() => finalizeSettledWorkSegmentDispatchEffectsV1({
      ...finalizeInput,
      now: 1007,
      effects: [
        finalizeInput.effects[0],
        { ...finalizeInput.effects[1], outcome: "no_op", outcomeCode: null },
        finalizeInput.effects[2],
      ],
    }), "idempotency_conflict");
    const next = reserveWorkSegmentDispatchV1({
      ...reservationInput(admitted.identity.segmentId, 1008),
      expectedWorkspaceRevision: 2,
      dispatchOrdinal: 1,
      idempotencyKey: "dispatch-key-1",
      leaseOwner: "dispatch-owner-1",
    }).record;
    expect(next.workspaceRevision).toBe(2);
    expect(next.dispatchOrdinal).toBe(1);
  });

  test("startup backfills a mutation-to-link crash without replay or duplicate receipts", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const crashMutations = Object.freeze([
      workspaceMutationReservation(admitted.identity.segmentId, "crash-mutation-a", "record_finding"),
      workspaceMutationReservation(admitted.identity.segmentId, "crash-mutation-b", "record_decision"),
    ]);
    settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      boundaryClass: "tool_action",
      usage: { ...USAGE, toolCalls: 2, workspaceOperations: 2, unsignedBoundaries: 0 },
      workspaceMutations: crashMutations,
    });
    db.query("UPDATE agent_turn_workspaces SET revision = 1 WHERE user_id = ? AND execution_id = ? AND workspace_id = ?")
      .run(USER, EXECUTION, WORKSPACE);
    insertWorkspaceMutationReceipt(
      admitted.identity.segmentId,
      crashMutations[0]!.operationKey,
      DIGEST_A,
      0,
      1,
    );
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 77, 1)).toMatchObject({
      scanned: 1,
      fenced: 0,
      terminalized: 1,
      closed: 1,
      healthy: true,
    });
    const effectRows = db.query(
      "SELECT payload_json FROM agent_run_audit_records WHERE user_id = ? AND attempt_id = ? AND event_id = ?",
    ).all(USER, ATTEMPT, reserved.dispatchId) as { payload_json: string }[];
    const finalization = effectRows.map((row) => JSON.parse(row.payload_json) as Record<string, unknown>)
      .find((payload) => payload.kind === "work_dispatch_effect_finalization") as {
        effects: { operationKey: string; outcome: string; outcomeCode: string | null }[];
      };
    expect(finalization.effects).toMatchObject([
      { operationKey: "crash-mutation-a", outcome: "mutated", outcomeCode: null },
      {
        operationKey: "crash-mutation-b",
        outcome: "failed",
        outcomeCode: "restart_unobserved_workspace_mutation",
      },
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ?")
      .get(USER, EXECUTION)).toEqual({ count: 1 });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 77, 1).scanned).toBe(0);
    expect(db.query(
      "SELECT COUNT(*) AS count FROM agent_run_audit_records "
        + "WHERE user_id = ? AND attempt_id = ? AND event_id = ? "
        + "AND json_extract(payload_json, '$.kind') = 'work_dispatch_effect_finalization'",
    ).get(USER, ATTEMPT, reserved.dispatchId)).toEqual({ count: 1 });
  });
  test("requires root-owned child settlement authority before its chronological receipt", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const childFrameId = "chronological-child-frame";
    const assignmentMutation = workspaceMutationReservation(
      admitted.identity.segmentId,
      "chronological-child-assignment",
      "assign_child_tasks",
      EXECUTION,
    );
    const settlementMutation = workspaceMutationReservation(
      admitted.identity.segmentId,
      "chronological-child-settlement",
      "settle_child_task",
      EXECUTION,
    );
    const settled = settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      boundaryClass: "tool_action",
      usage: { ...USAGE, toolCalls: 1, workspaceOperations: 2, unsignedBoundaries: 0 },
      workspaceMutations: [assignmentMutation, settlementMutation],
    }).record;
    const authorityInput = {
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1005,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      assignmentReservation: assignmentMutation,
      assignments: [{
        taskId: "chronological-child-task",
        frameId: childFrameId,
        settlementReservation: settlementMutation,
      }],
    };
    expectCode(() => persistWorkSegmentChildAssignmentAuthorityV1({
      ...authorityInput,
      assignments: [{
        ...authorityInput.assignments[0]!,
        settlementReservation: workspaceMutationReservation(
          admitted.identity.segmentId,
          settlementMutation.operationKey,
          "settle_child_task",
          childFrameId,
        ),
      }],
    }), "invalid_input");

    insertWorkspaceMutationReceipt(
      admitted.identity.segmentId,
      settlementMutation.operationKey,
      DIGEST_A,
      0,
      1,
      EXECUTION,
    );
    db.query("UPDATE agent_turn_workspaces SET revision = 1 WHERE user_id = ? AND execution_id = ? AND workspace_id = ?")
      .run(USER, EXECUTION, WORKSPACE);
    expectCode(() => persistWorkSegmentChildAssignmentAuthorityV1({
      ...authorityInput,
      expectedWorkspaceRevision: 1,
    }), "stale_segment");
    expect(db.query(
      "SELECT COUNT(*) AS count FROM agent_run_audit_records "
        + "WHERE user_id = ? AND attempt_id = ? AND event_id = ? "
        + "AND json_extract(payload_json, '$.kind') = 'work_dispatch_child_assignment_authority'",
    ).get(USER, ATTEMPT, reserved.dispatchId)).toEqual({ count: 0 });
  });
  test("startup atomically terminal-settles a durably assigned child under root-owned chronological authority", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const childFrameId = "crash-assigned-child-frame";
    const assignmentMutation = workspaceMutationReservation(
      admitted.identity.segmentId,
      "crash-child-assignment",
      "assign_child_tasks",
    );
    const settlementMutation = workspaceMutationReservation(
      admitted.identity.segmentId,
      "crash-child-settlement",
      "settle_child_task",
      EXECUTION,
    );
    const settled = settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      boundaryClass: "tool_action",
      usage: { ...USAGE, toolCalls: 1, workspaceOperations: 2, unsignedBoundaries: 0 },
      workspaceMutations: [assignmentMutation, settlementMutation],
    }).record;
    const childAuthority = persistWorkSegmentChildAssignmentAuthorityV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1005,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      assignmentReservation: assignmentMutation,
      assignments: [{
        taskId: "crash-assigned-task",
        frameId: childFrameId,
        settlementReservation: settlementMutation,
      }],
    });
    expect(childAuthority).toMatchObject({
      duplicate: false,
      record: {
        assignmentReservation: { frameId: EXECUTION },
        assignments: [{
          taskId: "crash-assigned-task",
          frameId: childFrameId,
          settlementReservation: { frameId: EXECUTION },
        }],
      },
    });
    db.query("INSERT INTO agent_workspace_tasks "
      + "(task_id, workspace_id, turn_id, user_id, chat_id, title, state, required, "
      + "assigned_frame_id, byte_count, revision, retention, expires_at, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, ?, 'Crash assigned task', 'active', 1, ?, 0, 0, 'turn_terminal', 5000, 1005, 1005)")
      .run("crash-assigned-task", WORKSPACE, EXECUTION, USER, CHAT, childFrameId);
    db.query("UPDATE agent_turn_workspaces SET revision = 1 WHERE user_id = ? AND execution_id = ? AND workspace_id = ?")
      .run(USER, EXECUTION, WORKSPACE);
    insertWorkspaceMutationReceipt(
      admitted.identity.segmentId,
      assignmentMutation.operationKey,
      DIGEST_A,
      0,
      1,
    );

    db.exec(
      "CREATE TEMP TRIGGER inject_startup_effect_finalization_failure "
        + "BEFORE INSERT ON agent_run_audit_records "
        + "WHEN json_extract(NEW.payload_json, '$.kind') = 'work_dispatch_owner_effect_finalization' "
        + "BEGIN SELECT RAISE(ABORT, 'injected startup effect finalization failure'); END",
    );
    try {
      expect(() => reconcileWorkSegmentRecoveryAtStartupV1(db, 79, 1))
        .toThrow("injected startup effect finalization failure");
    } finally {
      db.exec("DROP TRIGGER inject_startup_effect_finalization_failure");
    }
    expect(db.query("SELECT state FROM agent_workspace_tasks WHERE task_id = ?")
      .get("crash-assigned-task")).toEqual({ state: "active" });
    expect(db.query("SELECT revision FROM agent_turn_workspaces WHERE user_id = ? AND execution_id = ? AND workspace_id = ?")
      .get(USER, EXECUTION, WORKSPACE)).toEqual({ revision: 1 });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM agent_work_workspace_receipts WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
    ).get(USER, EXECUTION, settlementMutation.operationKey)).toEqual({ count: 0 });
    expect(db.query(
      "SELECT COUNT(*) AS count FROM agent_run_audit_records WHERE user_id = ? AND attempt_id = ? AND event_id = ? "
        + "AND json_extract(payload_json, '$.kind') IN ('work_dispatch_owner_effect_finalization', 'work_dispatch_effect_finalization')",
    ).get(USER, ATTEMPT, reserved.dispatchId)).toEqual({ count: 0 });

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 80, 1)).toMatchObject({
      scanned: 1,
      fenced: 0,
      terminalized: 1,
      closed: 1,
      healthy: true,
    });
    expect(db.query("SELECT state, assigned_frame_id FROM agent_workspace_tasks WHERE task_id = ?")
      .get("crash-assigned-task")).toEqual({ state: "failed", assigned_frame_id: childFrameId });
    expect(db.query(
      "SELECT frame_id, before_workspace_revision, after_workspace_revision FROM agent_work_workspace_receipts "
        + "WHERE user_id = ? AND execution_id = ? AND operation_key = ?",
    ).get(USER, EXECUTION, settlementMutation.operationKey)).toEqual({
      frame_id: EXECUTION,
      before_workspace_revision: 1,
      after_workspace_revision: 2,
    });
    const payloads = (db.query("SELECT payload_json FROM agent_run_audit_records "
      + "WHERE user_id = ? AND attempt_id = ? AND event_id = ?")
      .all(USER, ATTEMPT, reserved.dispatchId) as { payload_json: string }[])
      .map((row) => JSON.parse(row.payload_json) as {
        kind: string;
        effects?: { operationKey: string; outcome: string }[];
      });
    expect(payloads.find((payload) => payload.kind === "work_dispatch_effect_finalization")?.effects)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        operationKey: settlementMutation.operationKey,
        outcome: "mutated",
      })]));
    const receiptCount = db.query("SELECT COUNT(*) AS count FROM agent_work_workspace_receipts "
      + "WHERE user_id = ? AND execution_id = ?").get(USER, EXECUTION);
    expect(receiptCount).toEqual({ count: 2 });
    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 80, 1).scanned).toBe(0);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_work_workspace_receipts "
      + "WHERE user_id = ? AND execution_id = ?").get(USER, EXECUTION)).toEqual(receiptCount);
  });

  test("startup links an appended child receipt after a crash without duplicating owner or aggregate records", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const reserved = reserveWorkSegmentDispatchV1(reservationInput(admitted.identity.segmentId)).record;
    startWorkSegmentDispatchV1(startInput(admitted.identity.segmentId, reserved.dispatchId));
    const rootMutation = workspaceMutationReservation(
      admitted.identity.segmentId,
      "crash-appended-root",
      "record_finding",
    );
    const childMutation = workspaceMutationReservation(
      admitted.identity.segmentId,
      "crash-appended-child",
      "record_decision",
      "crash-appended-child-frame",
    );
    const childOwner = Object.freeze({
      segmentId: admitted.identity.segmentId,
      logicalDispatch: 0,
      frameId: childMutation.frameId,
    });
    const settled = settleWorkSegmentDispatchV1({
      ...settlementInput(admitted.identity.segmentId, reserved.dispatchId),
      boundaryClass: "tool_action",
      usage: { ...USAGE, toolCalls: 1, workspaceOperations: 1, unsignedBoundaries: 0 },
      workspaceMutations: [rootMutation],
    }).record;
    appendSettledWorkSegmentDispatchMutationReservationsV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 0,
      now: 1005,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      appendKey: "crash-appended-child-reservation",
      owner: childOwner,
      mutations: [childMutation],
    });
    db.query(`UPDATE agent_turn_workspaces SET revision = 2
      WHERE user_id = ? AND execution_id = ? AND workspace_id = ?`)
      .run(USER, EXECUTION, WORKSPACE);
    insertWorkspaceMutationReceipt(
      admitted.identity.segmentId,
      rootMutation.operationKey,
      DIGEST_A,
      0,
      1,
    );
    insertWorkspaceMutationReceipt(
      admitted.identity.segmentId,
      childMutation.operationKey,
      DIGEST_B,
      1,
      2,
      childMutation.frameId,
    );
    const rootPending = finalizeSettledWorkSegmentDispatchEffectsV1({
      db,
      userId: USER,
      executionId: EXECUTION,
      ownerToken: OWNER,
      expectedExecutionCasRevision: 0,
      expectedWorkspaceRevision: 2,
      now: 1006,
      attemptId: ATTEMPT,
      workspaceId: WORKSPACE,
      segmentId: admitted.identity.segmentId,
      dispatchId: reserved.dispatchId,
      fenceGeneration: 1,
      expectedSettlementDigest: settled.settlementDigest!,
      owner: {
        segmentId: admitted.identity.segmentId,
        logicalDispatch: 0,
        frameId: EXECUTION,
      },
      finalizationKey: "crash-appended-root-finalization",
      effects: [{
        ...rootMutation,
        outcome: "mutated",
        outcomeCode: null,
        operationDigest: DIGEST_A,
        beforeWorkspaceRevision: 0,
        afterWorkspaceRevision: 1,
      }],
      nextWorkspaceRevision: 2,
    });
    expect(rootPending.record).toMatchObject({
      settlementDigest: settled.settlementDigest,
      settledWorkspaceRevision: 0,
    });
    const payloadKindsBefore = (db.query(`SELECT payload_json FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ? AND event_id = ?`)
      .all(USER, ATTEMPT, reserved.dispatchId) as { payload_json: string }[])
      .map((row) => (JSON.parse(row.payload_json) as { kind: string }).kind);
    expect(payloadKindsBefore.filter((kind) => kind === "work_dispatch_owner_effect_finalization"))
      .toHaveLength(1);
    expect(payloadKindsBefore).not.toContain("work_dispatch_effect_finalization");

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 78, 1)).toMatchObject({
      scanned: 1,
      fenced: 0,
      terminalized: 1,
      closed: 1,
      complete: true,
      healthy: true,
    });
    const payloadsAfter = (db.query(`SELECT payload_json FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ? AND event_id = ?`)
      .all(USER, ATTEMPT, reserved.dispatchId) as { payload_json: string }[])
      .map((row) => JSON.parse(row.payload_json) as {
        kind: string;
        owner?: { frameId: string };
        effects?: { operationKey: string; outcome: string }[];
      });
    const ownerFinalizations = payloadsAfter.filter((payload) => (
      payload.kind === "work_dispatch_owner_effect_finalization"
    ));
    expect(ownerFinalizations).toHaveLength(2);
    expect(ownerFinalizations.find((payload) => payload.owner?.frameId === childMutation.frameId)?.effects)
      .toMatchObject([{ operationKey: childMutation.operationKey, outcome: "mutated" }]);
    expect(payloadsAfter.filter((payload) => payload.kind === "work_dispatch_effect_finalization"))
      .toHaveLength(1);
    expect(payloadsAfter.filter((payload) => payload.kind === "work_dispatch_mutation_reservation_append"))
      .toHaveLength(1);
    expect(db.query(`SELECT COUNT(*) AS count FROM agent_work_workspace_receipts
      WHERE user_id = ? AND execution_id = ?`).get(USER, EXECUTION)).toEqual({ count: 2 });

    expect(reconcileWorkSegmentRecoveryAtStartupV1(db, 78, 1).scanned).toBe(0);
    const payloadCountAfterRetry = db.query(`SELECT COUNT(*) AS count FROM agent_run_audit_records
      WHERE user_id = ? AND attempt_id = ? AND event_id = ?`)
      .get(USER, ATTEMPT, reserved.dispatchId);
    expect(payloadCountAfterRetry).toEqual({ count: payloadsAfter.length });
    expect(db.query(`SELECT COUNT(*) AS count FROM agent_work_workspace_receipts
      WHERE user_id = ? AND execution_id = ?`).get(USER, EXECUTION)).toEqual({ count: 2 });
  });

  test.each([
    [1024, [1024], [true]],
    [1025, [1024, 1], [false, true]],
    [2049, [1024, 1024, 1], [false, false, true]],
  ] as const)(
    "paginates %d valid startup candidates without duplicates",
    (candidateCount, expectedScans, expectedCompleteness) => {
      for (let index = 0; index < candidateCount; index += 1) {
        const fixture = paginationFixture(index);
        seedAuthority(fixture, false);
        createAndAdmitInitialWorkSegmentV1(createAndAdmitInput(1000, fixture));
      }
      expect(db.query("SELECT COUNT(*) AS count FROM agent_work_segment_recovery").get())
        .toEqual({ count: candidateCount });
      expect(db.query(`SELECT COUNT(*) AS count FROM agent_work_segment_recovery
        WHERE state <> 'active' OR current_segment_id IS NULL`).get()).toEqual({ count: 0 });

      const epoch = 100_000 + candidateCount;
      const seen = new Set<string>();
      const pageScans: number[] = [];
      const pageCompleteness: boolean[] = [];
      for (const expectedScan of expectedScans) {
        const result = reconcileWorkSegmentRecoveryAtStartupV1(db, epoch, 1024);
        expect(result).toMatchObject({
          scanned: expectedScan,
          active: expectedScan,
          queued: expectedScan,
          closed: 0,
          fenced: 0,
          terminalized: 0,
          healthy: true,
        });
        pageScans.push(result.scanned);
        pageCompleteness.push(result.complete);
        const claimed = db.query(`SELECT execution_id FROM agent_work_segment_recovery
          WHERE recovery_epoch = ? ORDER BY execution_id`).all(epoch) as { execution_id: string }[];
        const newlyClaimed = claimed.filter((row) => !seen.has(row.execution_id));
        expect(newlyClaimed).toHaveLength(result.scanned);
        for (const row of newlyClaimed) seen.add(row.execution_id);
      }
      expect(pageScans).toEqual([...expectedScans]);
      expect(pageCompleteness).toEqual([...expectedCompleteness]);
      expect(seen.size).toBe(candidateCount);
      expect(db.query(`SELECT COUNT(*) AS count, COUNT(DISTINCT execution_id) AS distinct_count
        FROM agent_work_segment_recovery WHERE recovery_epoch = ?`).get(epoch)).toEqual({
        count: candidateCount,
        distinct_count: candidateCount,
      });
      expect(reconcileWorkSegmentRecoveryAtStartupV1(db, epoch, 1024)).toMatchObject({
        scanned: 0,
        complete: true,
        healthy: true,
      });
    },
    120_000,
  );

  test("throws an integrity error for corrupt candidates instead of reporting pagination health", () => {
    createWorkSegmentAttemptV1(createInput());
    admitWorkSegmentV1(admissionInput());
    db.query("UPDATE agent_work_segment_recovery SET next_segment_ordinal = 3 WHERE user_id = ? AND execution_id = ?")
      .run(USER, EXECUTION);

    expectCode(() => reconcileWorkSegmentRecoveryAtStartupV1(db, 41, 1024), "integrity_error");
  });
  test("enforces composite foreign keys and the one-active-segment index with real inserts", () => {
    createWorkSegmentAttemptV1(createInput());
    const admitted = admitWorkSegmentV1(admissionInput()).record;
    const source = db.query(
      "SELECT * FROM agent_work_segments WHERE user_id = ? AND execution_id = ? AND segment_id = ?",
    ).get(USER, EXECUTION, admitted.identity.segmentId) as Record<string, string | number | null>;
    const insertClone = (overrides: Record<string, string | number | null>) => {
      const clone = { ...source, ...overrides };
      const columns = Object.keys(clone);
      db.query(`INSERT INTO agent_work_segments (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...Object.values(clone));
    };

    expect(() => insertClone({
      user_id: OTHER_USER,
      segment_id: "orphan-segment",
      admission_key: "orphan-segment-key",
      context_digest: DIGEST_B,
    })).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insertClone({
      segment_id: "second-active-segment",
      admission_key: "second-active-segment-key",
      context_digest: DIGEST_C,
    })).toThrow(/UNIQUE constraint failed/);
  });
});

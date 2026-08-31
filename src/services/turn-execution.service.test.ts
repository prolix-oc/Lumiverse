import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import {
  __testing,
  beginTurnCommit,
  calculateFinalRenderReservationEnvelopeV1,
  createTurnExecution,
  expireTurnExecution,
  reserveFinalRender,
  transitionTurnExecution,
  finalizeTurnCommit,
  getAgenticRuntimeStatus,
  getTurnExecution,
  isAllowedTurnExecutionTransition,
  reconcileAgentTurns,
  registerAgentTurnReceiptRepair,
  TURN_EXECUTION_RECONCILIATION,
  registerAgentTurnTerminalRecovery,
  requestDormantTurnCancellation,
  requestActiveTurnCancellation,
  requestTurnCancellation,
  TURN_EXECUTION_PHASES,
  TURN_EXECUTION_TRANSITIONS,
  type TurnExecutionPhase,
} from "./turn-execution.service";
import { reconcileStartupState } from "./startup-recovery.service";
import { repairAgentRunProjectionFromReceipt } from "./agent-run-projection.service";
import type {
  WorkAttemptBudgetV1,
  WorkPhasePlanAuthorityV1,
  WorkSegmentBudgetV1,
  WorkSegmentContextV1,
  WorkSegmentResumeEnvelopeV1,
  WorkSegmentUsageV1,
} from "../types/agent-work-segment";
import { computeWorkSegmentContextDigestV1 } from "./agentic-work-phase.service";
import {
  closeAdmittedWorkSegmentWithoutDispatchTerminalV1,
  commitWorkSegmentTransitionV1,
  computeWorkPhasePlanDigestV1,
  computeWorkSegmentResumeEnvelopeDigestV1,
  computeWorkTransitionDecisionDigestV1,
  createAndAdmitInitialWorkSegmentV1,
  reserveWorkSegmentDispatchV1,
  settleWorkSegmentDispatchV1,
  startWorkSegmentDispatchV1,
} from "./agentic-work-segment.repository";

const WORK_SEGMENT_MIGRATION_SQL = readFileSync(
  new URL("../db/migrations/135_agent_work_segments.sql", import.meta.url),
  "utf8",
);

function createExecutionSchema(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE agent_turn_executions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      branch_id TEXT,
      generation_id TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_message_id TEXT,
      target_swipe_id INTEGER,
      target_message_index INTEGER,
      target_swipe_count INTEGER,
      target_chat_revision INTEGER NOT NULL,
      target_message_revision INTEGER,
      preset_snapshot_id TEXT,
      config_snapshot_id TEXT,
      config_revision INTEGER NOT NULL,
      concrete_connection_snapshot_id TEXT,
      concrete_connection_revision INTEGER NOT NULL,
      world_lore_snapshot_id TEXT,
      world_lore_revision INTEGER NOT NULL,
      mode TEXT NOT NULL,
      runtime_epoch INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      cancel_requested_at INTEGER,
      state TEXT NOT NULL,
      phase_revision INTEGER NOT NULL,
      cas_revision INTEGER NOT NULL,
      cas_owner TEXT,
      cas_expires_at INTEGER,
      root_ledger_json TEXT NOT NULL,
      frame_capabilities_json TEXT NOT NULL,
      workspace_id TEXT,
      workspace_revision INTEGER NOT NULL,
      commit_key TEXT NOT NULL UNIQUE,
      final_render_reservations_json TEXT NOT NULL,
      terminal_code TEXT,
      terminal_event_id TEXT,
      retention TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER
    )
  `);
  db.run(`
    CREATE TABLE agent_turn_commit_receipts (
      receipt_id TEXT PRIMARY KEY,
      turn_id TEXT,
      execution_id TEXT,
      workspace_id TEXT,
      user_id TEXT,
      chat_id TEXT,
      commit_key TEXT,
      idempotency_key TEXT,
      state TEXT,
      summary_digest TEXT,
      summary_json TEXT,
      committed_at INTEGER
    )
  `);
  return db;
}

function createTerminalRecoverySchema(db: Database): void {
  db.run(`
    CREATE TABLE agent_run_attempts (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      previous_attempt_id TEXT,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      generation_type TEXT NOT NULL,
      target_message_id TEXT,
      target_swipe_id INTEGER,
      lifecycle TEXT NOT NULL DEFAULT 'TERMINAL',
      status TEXT NOT NULL,
      outcome TEXT,
      reason TEXT NOT NULL,
      terminal INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER,
      host_correlation_id TEXT NOT NULL,
      reconciliation_state TEXT NOT NULL,
      terminal_receipt_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(user_id, attempt_id)
    )
  `);
  db.run(`
    CREATE TABLE agent_run_audit_records (
      record_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      record_kind TEXT NOT NULL,
      event_id TEXT,
      causal_parent_id TEXT,
      host_sequence INTEGER NOT NULL,
      occurred_at INTEGER NOT NULL,
      late INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      dedupe_key TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, attempt_id, dedupe_key)
    )
  `);
  db.run(`
    CREATE TABLE agent_run_projections (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      generation_type TEXT NOT NULL,
      target_message_id TEXT,
      target_swipe_id INTEGER,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      revision INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      terminal_handoff_json TEXT,
      omission_json TEXT,
      PRIMARY KEY(user_id, turn_id)
    )
  `);
  db.run(`
    CREATE TABLE agent_chat_events (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      run_revision INTEGER NOT NULL,
      status TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      snapshot_json TEXT,
      terminal_handoff_json TEXT,
      omission_json TEXT,
      PRIMARY KEY(user_id, chat_id, sequence)
    )
  `);
  db.run(`
    CREATE TABLE agent_chat_event_sequences (
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      last_sequence INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, chat_id)
    )
  `);
  db.run(`
    CREATE TABLE agent_activity_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      target_message_id TEXT,
      target_swipe_id INTEGER,
      snapshot_json TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, chat_id, generation_id)
    )
  `);
  db.run(`
    CREATE TABLE chats (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    )
  `);
  db.query("INSERT INTO chats (id, user_id) VALUES (?, ?)").run("c1", "u1");
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_turn_workspaces (
      workspace_id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      objective TEXT NOT NULL CHECK(length(objective) <= 65536),
      constraints_json TEXT NOT NULL CHECK(length(constraints_json) <= 131072),
      state TEXT NOT NULL CHECK(state IN ('active', 'frozen', 'expired')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      cas_owner TEXT,
      cas_expires_at INTEGER,
      operation_caps_json TEXT NOT NULL CHECK(length(operation_caps_json) <= 65536),
      field_caps_json TEXT NOT NULL CHECK(length(field_caps_json) <= 65536),
      retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
      expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
      quota_tasks INTEGER NOT NULL CHECK(quota_tasks >= 0 AND quota_tasks <= 100000),
      quota_records INTEGER NOT NULL CHECK(quota_records >= 0 AND quota_records <= 100000),
      quota_submissions INTEGER NOT NULL CHECK(quota_submissions >= 0 AND quota_submissions <= 100000),
      quota_artifacts INTEGER NOT NULL CHECK(quota_artifacts >= 0 AND quota_artifacts <= 100000),
      quota_bytes INTEGER NOT NULL CHECK(quota_bytes >= 0 AND quota_bytes <= 2147483648),
      task_count INTEGER NOT NULL DEFAULT 0 CHECK(task_count >= 0 AND task_count <= quota_tasks),
      record_count INTEGER NOT NULL DEFAULT 0 CHECK(record_count >= 0 AND record_count <= quota_records),
      submission_count INTEGER NOT NULL DEFAULT 0 CHECK(submission_count >= 0 AND submission_count <= quota_submissions),
      artifact_count INTEGER NOT NULL DEFAULT 0 CHECK(artifact_count >= 0 AND artifact_count <= quota_artifacts),
      byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0 AND byte_count <= quota_bytes),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      frozen_at INTEGER,
      UNIQUE(user_id, workspace_id),
      UNIQUE(user_id, turn_id),
      UNIQUE(user_id, execution_id),
      FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (execution_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, execution_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agent_turn_workspaces_expiry
      ON agent_turn_workspaces(user_id, state, expires_at)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_workspace_tasks (
      task_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 4096),
      description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 65536),
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')),
      required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0, 1)),
      dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK(length(dependencies_json) <= 65536),
      assigned_frame_id TEXT,
      progress REAL NOT NULL DEFAULT 0 CHECK(progress >= 0 AND progress <= 1),
      summary TEXT CHECK(summary IS NULL OR length(summary) <= 65536),
      byte_count INTEGER NOT NULL DEFAULT 0 CHECK(byte_count >= 0 AND byte_count <= 131072),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      cas_owner TEXT,
      cas_expires_at INTEGER,
      retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
      expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, task_id),
      FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agent_workspace_tasks_state
      ON agent_workspace_tasks(user_id, workspace_id, state, updated_at)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_workspace_records (
      record_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('finding', 'decision', 'question')),
      summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
      digest TEXT NOT NULL CHECK(length(digest) = 64 AND digest GLOB '[0-9a-fA-F]*'),
      task_id TEXT,
      source_frame_id TEXT,
      byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
      expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, record_id),
      UNIQUE(workspace_id, kind, digest),
      FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE RESTRICT
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agent_workspace_records_kind
      ON agent_workspace_records(user_id, workspace_id, kind, created_at)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_workspace_submissions (
      submission_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      child_frame_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('submitted', 'accepted', 'rejected')),
      summary TEXT NOT NULL CHECK(length(summary) BETWEEN 1 AND 65536),
      result_digest TEXT NOT NULL CHECK(length(result_digest) = 64 AND result_digest GLOB '[0-9a-fA-F]*'),
      byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 131072),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
      expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, submission_id),
      UNIQUE(task_id, child_frame_id),
      FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE CASCADE
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agent_workspace_submissions_state
      ON agent_workspace_submissions(user_id, workspace_id, state, updated_at)
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_workspace_artifacts (
      artifact_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      blob_digest TEXT NOT NULL,
      mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 1 AND 255),
      byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 2147483648),
      provenance_json TEXT NOT NULL CHECK(length(provenance_json) <= 65536),
      source_frame_id TEXT,
      source_task_id TEXT,
      publication_state TEXT NOT NULL CHECK(publication_state IN ('attached', 'proposed', 'published')),
      retention TEXT NOT NULL CHECK(retention IN ('operational', 'turn_terminal', 'chat_lifetime')),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      expires_at INTEGER NOT NULL CHECK(expires_at >= 0),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(user_id, artifact_id),
      UNIQUE(workspace_id, blob_digest),
      FOREIGN KEY (workspace_id) REFERENCES agent_turn_workspaces(workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES agent_turn_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, workspace_id) REFERENCES agent_turn_workspaces(user_id, workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, turn_id) REFERENCES agent_turn_executions(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, chat_id) REFERENCES chats(user_id, id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, source_task_id) REFERENCES agent_workspace_tasks(user_id, task_id) ON DELETE RESTRICT
    )
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_agent_workspace_artifacts_publication
      ON agent_workspace_artifacts(user_id, workspace_id, publication_state, updated_at)
  `);
}
function createWorkSegmentRecoverySchema(db: Database): void {
  db.run(WORK_SEGMENT_MIGRATION_SQL);
}

type ClosedWorkSegmentCrashResult = "work_complete" | "failed" | "exhausted" | "cancelled";
type ExecutionFixtureRecord = NonNullable<ReturnType<typeof getTurnExecution>>;

const WORK_FIXTURE_DIGEST_A = "a".repeat(64);
const WORK_FIXTURE_DIGEST_B = "b".repeat(64);
const WORK_FIXTURE_DIGEST_C = "c".repeat(64);
const WORK_FIXTURE_PHASE_PLAN = Object.freeze({
  version: 1,
  phases: Object.freeze([Object.freeze({
    id: "execute",
    index: 0,
    required: true,
    nextPhaseIds: Object.freeze([]),
    repeatLimit: 0,
    transitionAuthorityDigest: WORK_FIXTURE_DIGEST_A,
    skipEligibilityDigest: null,
  })]),
}) satisfies WorkPhasePlanAuthorityV1;
const WORK_FIXTURE_PHASE_PLAN_DIGEST = computeWorkPhasePlanDigestV1(WORK_FIXTURE_PHASE_PLAN);
const WORK_FIXTURE_ATTEMPT_BUDGET = Object.freeze({
  maxSegments: 2,
  maxProviderDispatches: 2,
  maxProviderOutputTokens: 100,
  maxOutputTokensPerDispatch: 50,
  maxUnsignedBoundaries: 2,
  maxToolCalls: 2,
  maxWorkspaceOperations: 2,
  recoveryReserveOutputTokens: 10,
  futurePhaseReserveOutputTokens: 0,
}) satisfies WorkAttemptBudgetV1;
const WORK_FIXTURE_SEGMENT_BUDGET = Object.freeze({
  maxProviderDispatches: 2,
  maxProviderOutputTokens: 50,
  maxOutputTokensPerDispatch: 25,
  maxUnsignedBoundaries: 2,
  maxToolCalls: 2,
  maxWorkspaceOperations: 2,
}) satisfies WorkSegmentBudgetV1;
const WORK_FIXTURE_USAGE = Object.freeze({
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
}) satisfies WorkSegmentUsageV1;

function workFixtureResumeEnvelope(execution: ExecutionFixtureRecord): WorkSegmentResumeEnvelopeV1 {
  if (!execution.workspaceId) throw new Error("test WORK workspace authority is unavailable");
  const withoutDigest: Omit<WorkSegmentResumeEnvelopeV1, "envelopeDigest"> = Object.freeze({
    version: 1,
    snapshotDigest: WORK_FIXTURE_DIGEST_A,
    planDigest: WORK_FIXTURE_DIGEST_B,
    toolCatalogSchemaVersion: 1,
    toolCatalogDigest: WORK_FIXTURE_DIGEST_C,
    configRevision: 1,
    authoredRootToolIds: Object.freeze([]),
    authoredChildToolIds: Object.freeze({}),
    snapshot: Object.freeze({ snapshotId: execution.id + ":snapshot" }),
    plan: Object.freeze({ version: 1 }),
    rootConnection: Object.freeze({
      logicalId: "root",
      concreteId: "fixture-connection",
      label: "Fixture Connection",
      provider: "fixture",
      model: "fixture-model",
      effectiveEndpoint: "https://example.invalid",
      endpointRevision: 1,
      credentialSecretRef: "fixture-credential-ref",
      credentialRevision: 1,
      candidateRevision: 1,
      capabilities: Object.freeze({ toolCalls: true }),
      capabilityDigest: WORK_FIXTURE_DIGEST_A,
      fingerprint: WORK_FIXTURE_DIGEST_B,
    }),
    childConnections: Object.freeze({}),
    generationParameters: null,
    resumeInput: Object.freeze({
      userId: execution.userId,
      chatId: execution.chatId,
      generationType: execution.targetKind,
    }),
    decisionAuthority: Object.freeze({ bindingDigest: WORK_FIXTURE_DIGEST_A }),
    liveTargetBinding: Object.freeze({
      targetDigest: WORK_FIXTURE_DIGEST_A,
      inputRevisionDigest: WORK_FIXTURE_DIGEST_B,
    }),
    runtime: Object.freeze({
      deadlineAt: execution.deadlineAt,
      rootFrameId: execution.id,
      workspaceId: execution.workspaceId,
      workspaceRevision: execution.workspaceRevision,
      ownerLimits: Object.freeze({ providerDispatches: 2 }),
      workspaceRetention: "turn_terminal",
      workspaceSharing: "root_only",
    }),
  });
  return Object.freeze({
    ...withoutDigest,
    envelopeDigest: computeWorkSegmentResumeEnvelopeDigestV1(withoutDigest),
  });
}

function workFixtureContext(
  execution: ExecutionFixtureRecord,
  resumeEnvelope: WorkSegmentResumeEnvelopeV1,
): WorkSegmentContextV1 {
  if (!execution.workspaceId) throw new Error("test WORK workspace authority is unavailable");
  const withoutDigest: Omit<WorkSegmentContextV1, "contextDigest"> = Object.freeze({
    version: 1,
    bindingDigest: WORK_FIXTURE_DIGEST_C,
    resumeEnvelopeDigest: resumeEnvelope.envelopeDigest,
    phasePlanDigest: WORK_FIXTURE_PHASE_PLAN_DIGEST,
    protocolDigest: WORK_FIXTURE_DIGEST_A,
    capabilityDigest: WORK_FIXTURE_DIGEST_B,
    phaseCapabilityDigest: WORK_FIXTURE_DIGEST_C,
    rootObjective: "test objective",
    rootSnapshotId: execution.id + ":snapshot",
    rootSnapshotDigest: WORK_FIXTURE_DIGEST_A,
    phase: Object.freeze({
      id: "execute",
      index: 0,
      occurrence: 0,
      instructions: Object.freeze(["execute"]),
      completionCriteria: Object.freeze(["complete"]),
      admittedCapabilities: Object.freeze([]),
    }),
    workspace: Object.freeze({
      id: execution.workspaceId,
      revision: execution.workspaceRevision,
      acceptedRecords: Object.freeze([]),
      openRequiredIds: Object.freeze([]),
    }),
    previousHandoff: null,
    attemptBudget: WORK_FIXTURE_ATTEMPT_BUDGET,
    segmentBudget: WORK_FIXTURE_SEGMENT_BUDGET,
    protocol: Object.freeze({
      completeTurnCallMode: "standalone_only",
      requiredToolModeAvailable: true,
    }),
  });
  return Object.freeze({
    ...withoutDigest,
    contextDigest: computeWorkSegmentContextDigestV1(withoutDigest),
  });
}

function seedClosedWorkSegmentCrash(
  db: Database,
  executionId: string,
  closeResult: ClosedWorkSegmentCrashResult,
  closeReason = closeResult === "work_complete" ? "transition:terminal" : "closed:" + closeResult,
): void {
  const execution = getTurnExecution(executionId, "u1", db);
  if (!execution || execution.phase !== "WORK" || !execution.workspaceId || !execution.casOwner) {
    throw new Error("test WORK execution authority is unavailable");
  }
  const now = Date.now();
  const attemptId = execution.attemptLineage.attemptId;
  db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
      generation_id, generation_type, target_message_id, target_swipe_id,
      lifecycle, status, outcome, reason, terminal, started_at, updated_at,
      terminal_at, host_correlation_id, reconciliation_state, terminal_receipt_json
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, 'WORK', 'running', NULL,
              'running', 0, ?, ?, NULL, ?, 'authoritative', NULL)`).run(
    execution.userId,
    execution.chatId,
    attemptId,
    execution.generationId,
    execution.id,
    execution.generationId,
    execution.targetKind,
    execution.createdAt,
    now,
    "agentic:" + execution.id + ":" + attemptId,
  );
  const resumeEnvelope = workFixtureResumeEnvelope(execution);
  const context = workFixtureContext(execution, resumeEnvelope);
  const authority = Object.freeze({
    userId: execution.userId,
    executionId: execution.id,
    ownerToken: execution.casOwner,
    expectedExecutionCasRevision: execution.casRevision,
    expectedWorkspaceRevision: execution.workspaceRevision,
    now,
    attemptId,
    workspaceId: execution.workspaceId,
  });
  const admitted = createAndAdmitInitialWorkSegmentV1({
    db,
    attempt: {
      ...authority,
      phaseId: "execute",
      phaseIndex: 0,
      phaseOccurrence: 0,
      remainingRequiredPhaseCount: 0,
      snapshotDigest: WORK_FIXTURE_DIGEST_A,
      phasePlanDigest: WORK_FIXTURE_PHASE_PLAN_DIGEST,
      phasePlan: WORK_FIXTURE_PHASE_PLAN,
      bindingDigest: WORK_FIXTURE_DIGEST_C,
      idempotencyKey: execution.id + ":attempt",
      resumeEnvelope,
      budget: WORK_FIXTURE_ATTEMPT_BUDGET,
    },
    admission: {
      ...authority,
      sourceTransitionId: null,
      phaseId: "execute",
      phaseIndex: 0,
      phaseOccurrence: 0,
      segmentOrdinal: 0,
      admissionKey: execution.id + ":segment:0",
      contextDigest: context.contextDigest,
      context,
      budget: WORK_FIXTURE_SEGMENT_BUDGET,
    },
  }).admission.record;
  if (closeResult !== "work_complete") {
    closeAdmittedWorkSegmentWithoutDispatchTerminalV1({
      db,
      ...authority,
      now: now + 1,
      sourceSegmentId: admitted.identity.segmentId,
      idempotencyKey: execution.id + ":terminal-close",
      closeResult,
      closeReason,
    });
    return;
  }

  const leaseOwner = execution.id + ":dispatch-owner";
  const dispatch = reserveWorkSegmentDispatchV1({
    db,
    ...authority,
    now: now + 1,
    segmentId: admitted.identity.segmentId,
    dispatchOrdinal: 0,
    idempotencyKey: execution.id + ":dispatch:0",
    toolMode: "ordinary",
    budgetClass: "normal",
    reservedOutputTokens: 20,
    leaseOwner,
    leaseExpiresAt: now + 10_000,
  }).record;
  startWorkSegmentDispatchV1({
    db,
    ...authority,
    now: now + 2,
    segmentId: admitted.identity.segmentId,
    dispatchId: dispatch.dispatchId,
    leaseOwner,
    fenceGeneration: dispatch.fenceGeneration,
  });
  settleWorkSegmentDispatchV1({
    db,
    ...authority,
    now: now + 3,
    segmentId: admitted.identity.segmentId,
    dispatchId: dispatch.dispatchId,
    leaseOwner,
    fenceGeneration: dispatch.fenceGeneration,
    settlementKey: execution.id + ":settlement:0",
    boundaryClass: "tool_free_stop",
    usage: WORK_FIXTURE_USAGE,
    workspaceMutations: [],
  });
  const terminalTarget = Object.freeze({
    targetPhaseId: null,
    targetPhaseIndex: null,
    targetPhaseOccurrence: null,
    targetSegmentOrdinal: null,
  });
  commitWorkSegmentTransitionV1({
    db,
    ...authority,
    now: now + 4,
    sourceSegmentId: admitted.identity.segmentId,
    phasePlanDigest: WORK_FIXTURE_PHASE_PLAN_DIGEST,
    transitionDecisionDigest: computeWorkTransitionDecisionDigestV1({
      phasePlanDigest: WORK_FIXTURE_PHASE_PLAN_DIGEST,
      source: admitted.identity,
      transitionKind: "terminal",
      ...terminalTarget,
    }),
    idempotencyKey: execution.id + ":transition:terminal",
    transitionKind: "terminal",
    ...terminalTarget,
    remainingRequiredPhaseCount: 0,
    boundaryClass: "tool_free_stop",
    closeResult: "work_complete",
    usage: WORK_FIXTURE_USAGE,
    completion: {
      summary: "Work completed before the simulated process interruption.",
      unresolvedIds: [],
      renderGuidance: null,
    },
  });
}

function newExecution(db: Database, id: string, deadlineAt = Date.now() + 60_000) {
  const created = createTurnExecution({
    id,
    userId: "u1",
    chatId: "c1",
    generationId: id + "-generation",
    target: "normal",
    targetChatRevision: 0,
    mode: "agentic",
    workspaceId: id + "-workspace",
    deadlineAt,
    expiresAt: deadlineAt + 60_000,
  }, db);
  const workspaceSchema = db.query(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'agent_turn_workspaces' LIMIT 1",
  ).get() as { present: number } | null;
  if (workspaceSchema) {
    const workspaceId = created.execution.workspaceId;
    if (!workspaceId) throw new Error("execution fixture workspace identity is unavailable");
    db.query(`INSERT INTO agent_turn_workspaces
      (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
       constraints_json, state, revision, operation_caps_json, field_caps_json,
       retention, expires_at, quota_tasks, quota_records, quota_submissions,
       quota_artifacts, quota_bytes)
      VALUES (?, ?, ?, ?, ?, 'test objective', '[]', 'active', ?, '{}', '{}',
              'turn_terminal', ?, 10, 10, 10, 10, 1000000)`).run(
      workspaceId,
      created.execution.id,
      created.execution.id,
      created.execution.userId,
      created.execution.chatId,
      created.execution.workspaceRevision,
      deadlineAt + 60_000,
    );
  }
  return created;
}

function seedLegacyStaleDecisionTerminal(
  db: Database,
  id: string,
  projectionErrorCode = "decision_refresh_required",
) {
  const created = newExecution(db, id);
  transitionTurnExecution({
    db,
    executionId: created.execution.id,
    ownerToken: created.ownerToken,
    expectedPhase: "ASSEMBLE",
    nextPhase: "FAILED",
    reason: "decision_refresh_required",
  });
  const now = Date.now();
  const projectedAt = Math.floor(now / 1_000);
  const generationId = `${id}-generation`;
  const omission = {
    omittedNodeCount: 0,
    omittedEventCount: 0,
    firstOmittedSequence: null,
    lastOmittedSequence: null,
  };
  const terminalHandoff = {
    version: 2,
    committed: false,
    messageId: null,
    swipeId: null,
    messageRevision: null,
    swipeRevision: null,
  };
  const snapshot = {
    version: 2,
    runId: generationId,
    turnId: id,
    chatId: "c1",
    generationId,
    generationType: "normal",
    target: null,
    attemptLineage: {
      version: 1,
      attemptId: id,
      previousAttemptId: null,
      target: { chatId: "c1", generationType: "normal", messageId: null, swipeId: null },
      createdAt: now - 100,
    },
    revision: 1,
    sequence: 1,
    workPhase: "TERMINAL",
    workStatus: "terminal",
    workOutcome: "failed",
    recoveryEligible: true,
    recoveryAction: "resync",
    inspectionAttemptId: id,
    reason: "stale_input",
    error: {
      code: projectionErrorCode,
      category: "validation",
      summaryCode: `agentRun.errors.${projectionErrorCode}`,
      recoveryEligible: true,
      recoveryAction: "resync",
      reason: "stale_input",
      workPhase: "TERMINAL",
      workStatus: "terminal",
      workOutcome: "failed",
      inspectionAttemptId: id,
    },
    startedAt: projectedAt,
    updatedAt: projectedAt,
    activity: [{
      version: 2,
      id: `root:${id}`,
      parentId: null,
      kind: "root",
      actor: "root",
      phase: "TERMINAL",
      status: "failed",
      startedAt: projectedAt,
      elapsedMs: 0,
    }],
    terminalHandoff,
    omission,
  };
  const snapshotJson = JSON.stringify(snapshot);
  const handoffJson = JSON.stringify(terminalHandoff);
  const omissionJson = JSON.stringify(omission);
  // Match the old writer: failed public rows were emitted before the terminal
  // inspection settled to canonical rejected/recovered.
  db.query(`
    INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, phase, revision, sequence,
      started_at, updated_at, snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "u1", "c1", id, generationId, "normal", "FAILED", "FAILED", 1, 1,
    projectedAt, projectedAt, snapshotJson, handoffJson, omissionJson,
  );
  db.query(`
    INSERT INTO agent_chat_events (
      user_id, chat_id, sequence, turn_id, generation_id, run_revision,
      status, event_kind, snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "u1", "c1", 1, id, generationId, 1,
    "FAILED", "terminal", snapshotJson, handoffJson, omissionJson,
  );
  db.query(`
    INSERT INTO agent_chat_event_sequences (user_id, chat_id, last_sequence, updated_at)
    VALUES (?, ?, ?, ?)
  `).run("u1", "c1", 1, projectedAt);
  const compatibilityJson = JSON.stringify({
    version: 1,
    generationId,
    chatId: "c1",
    targetMessageId: null,
    targetSwipeId: null,
    snapshot: {
      version: 1,
      rootId: id,
      nodes: [],
      omittedNodeCount: 0,
      errorCounts: { decision_refresh_required: 1 },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, toolCalls: 0, childInvocations: 0 },
      status: "failed",
      terminalErrorCode: "decision_refresh_required",
    },
  });
  db.query(`
    INSERT INTO agent_activity_runs (
      user_id, chat_id, generation_id, target_message_id, target_swipe_id,
      snapshot_json, byte_size, created_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)
  `).run("u1", "c1", generationId, compatibilityJson, new TextEncoder().encode(compatibilityJson).byteLength, projectedAt);
  db.query(`
    INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
      generation_id, generation_type, target_message_id, target_swipe_id,
      lifecycle, status, outcome, reason, terminal, started_at, updated_at,
      terminal_at, host_correlation_id, reconciliation_state, terminal_receipt_json
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    "u1", "c1", id, generationId, id, generationId, "normal",
    "TERMINAL", "terminal", "rejected", "stale_input", 1,
    now - 100, now + 1, now, `agentic:${id}`, "recovered",
  );
  return created;
}

function seedLegacyPrematureFailedProjection(db: Database, id: string) {
  const created = seedLegacyStaleDecisionTerminal(db, id, "internal_error");
  db.query("UPDATE agent_turn_executions SET terminal_code = 'invalid_input' WHERE id = ?")
    .run(id);
  const projectionRow = db.query(
    "SELECT snapshot_json FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
  ).get("u1", id) as { snapshot_json: string };
  const projection = JSON.parse(projectionRow.snapshot_json) as {
    reason: string;
    error: { reason: string };
  };
  projection.reason = "failed";
  projection.error.reason = "failed";
  const projectionJson = JSON.stringify(projection);
  db.query("UPDATE agent_run_projections SET snapshot_json = ? WHERE user_id = ? AND turn_id = ?")
    .run(projectionJson, "u1", id);
  db.query("UPDATE agent_chat_events SET snapshot_json = ? WHERE user_id = ? AND turn_id = ?")
    .run(projectionJson, "u1", id);
  db.query("UPDATE agent_run_attempts SET reason = 'invalid_input' WHERE user_id = ? AND attempt_id = ?")
    .run("u1", id);
  const activityRow = db.query(
    "SELECT snapshot_json FROM agent_activity_runs WHERE user_id = ? AND generation_id = ?",
  ).get("u1", id + "-generation") as { snapshot_json: string };
  const activity = JSON.parse(activityRow.snapshot_json) as {
    snapshot: { errorCounts: Record<string, number>; terminalErrorCode: string };
  };
  activity.snapshot.errorCounts = { internal_error: 1 };
  activity.snapshot.terminalErrorCode = "internal_error";
  const activityJson = JSON.stringify(activity);
  db.query("UPDATE agent_activity_runs SET snapshot_json = ?, byte_size = ? WHERE user_id = ? AND generation_id = ?")
    .run(activityJson, new TextEncoder().encode(activityJson).byteLength, "u1", id + "-generation");
  return created;
}

function replayStartupTurnReconciliation(db: Database) {
  return reconcileStartupState(db, {
    reconcileExportStaging: () => ({ inspected: 0, removed: 0, preserved: 0, failures: 0 }),
    reconcileUserDataImports: () => ({
      inspected: 0,
      recovered: 0,
      deferred: 0,
      failed: 0,
      complete: true,
      healthy: true,
    }),
    reconcilePurgeCleanupIntents: () => {},
    reconcileAgentArtifactBlobs: async () => ({
      inspected: 0,
      retained: 0,
      removed: 0,
      stale: 0,
      quarantined: 0,
      bytesRemoved: 0,
    }),
    reconcileWorkSegmentRecovery: () => ({
      scanned: 0, active: 0, closed: 0, queued: 0, reclaimed: 0, fenced: 0, terminalized: 0,
      complete: true, healthy: true,
    }),
    reconcileAgentTurns: (startupDb) => reconcileAgentTurns(startupDb),
    reconcileAgentRunProjections: () => ({
      inspectedProjections: 0,
      removedProjections: 0,
      inspectedWorkspaces: 0,
      removedWorkspaces: 0,
      preservedChatLifetimeEntries: 0,
      failures: 0,
      healthy: true,
      complete: true,
    }),
    probeIsolateBackendsAtStartup: async () => ({
      epoch: 1,
      worker: "healthy",
      subprocess: "unavailable",
      selected: "worker",
      workerReason: null,
      subprocessReason: "not selected",
      checkedAt: Date.now(),
    }),
    installAgenticGenerationCoordinator: () => {},
  });
}

function transition(
  db: Database,
  executionId: string,
  ownerToken: string,
  expectedPhase: TurnExecutionPhase,
  nextPhase: TurnExecutionPhase,
) {
  return transitionTurnExecution({
    db,
    executionId,
    ownerToken,
    expectedPhase,
    nextPhase,
  });
}

function moveToCommit(db: Database, executionId: string, ownerToken: string): void {
  transition(db, executionId, ownerToken, "ASSEMBLE", "WORK");
  transition(db, executionId, ownerToken, "WORK", "COMPLETE");
  transition(db, executionId, ownerToken, "COMPLETE", "RENDER");
  transition(db, executionId, ownerToken, "RENDER", "PREPARE_COMMIT");
  beginTurnCommit({ db, executionId, ownerToken });
}

let db: Database;
let previousKillSwitch: string | undefined;

beforeEach(() => {
  db = createExecutionSchema();
  previousKillSwitch = process.env.LUMIVERSE_AGENTIC_RUNTIME;
  registerAgentTurnTerminalRecovery(null);
  registerAgentTurnReceiptRepair(null);
  __testing.resetRuntimeEpoch(4_000);
  __testing.resetReadiness();
});

afterEach(() => {
  registerAgentTurnTerminalRecovery(null);
  registerAgentTurnReceiptRepair(null);
  db.close();
  if (previousKillSwitch === undefined) delete process.env.LUMIVERSE_AGENTIC_RUNTIME;
  else process.env.LUMIVERSE_AGENTIC_RUNTIME = previousKillSwitch;
});

describe("closed transition contract", () => {
  test("accepts every table edge and rejects every omitted edge", () => {
    for (const current of TURN_EXECUTION_PHASES) {
      for (const next of TURN_EXECUTION_PHASES) {
        const expected = TURN_EXECUTION_TRANSITIONS[current].includes(next);
        expect(isAllowedTurnExecutionTransition(current, next)).toBe(expected);
      }
    }
  });

  test("creates the durable row before a phase mutation and enforces owner/revision CAS", () => {
    const created = newExecution(db, "cas");
    expect(created.execution.state).toBe("ASSEMBLE");
    expect(created.execution.cas.owner).toBe(created.ownerToken);
    expect(() => transition(db, "cas", "stale-owner", "ASSEMBLE", "WORK")).toThrow("stale_owner");
    transition(db, "cas", created.ownerToken, "ASSEMBLE", "WORK");
    expect(() => transitionTurnExecution({
      db,
      executionId: "cas",
      ownerToken: created.ownerToken,
      expectedPhase: "WORK",
      nextPhase: "COMPLETE",
      expectedRevision: 0,
    })).toThrow("stale_execution");
  });

  test("counts only the CAS row when an UPDATE trigger writes audit evidence", () => {
    db.run("CREATE TABLE cas_trigger_audit (execution_id TEXT NOT NULL, state TEXT NOT NULL)");
    db.run(`CREATE TRIGGER cas_state_audit
      AFTER UPDATE OF state ON agent_turn_executions
      BEGIN
        INSERT INTO cas_trigger_audit (execution_id, state) VALUES (NEW.id, NEW.state);
      END`);
    const created = newExecution(db, "cas-trigger-audit");

    const transitioned = transition(
      db,
      created.execution.id,
      created.ownerToken,
      "ASSEMBLE",
      "WORK",
    );

    expect(transitioned.execution).toMatchObject({ phase: "WORK", casRevision: 1 });
    expect(db.query("SELECT execution_id, state FROM cas_trigger_audit").get()).toEqual({
      execution_id: created.execution.id,
      state: "WORK",
    });
  });
});

describe("final render reservation envelope", () => {
  test("requires the complete chunk plus terminal projection envelope before CAS", () => {
    const created = newExecution(db, "reservation");
    transition(db, "reservation", created.ownerToken, "ASSEMBLE", "WORK");
    transition(db, "reservation", created.ownerToken, "WORK", "COMPLETE");
    transition(db, "reservation", created.ownerToken, "COMPLETE", "RENDER");
    const envelope = calculateFinalRenderReservationEnvelopeV1({
      activityChunks: 16,
      contextBytes: 8 * 1024,
      outputBytes: 16 * 1024,
    });
    const reserved = reserveFinalRender({
      db,
      executionId: "reservation",
      ownerToken: created.ownerToken,
      reservationKey: "render-reservation",
      maxBytes: envelope.maxBytes,
      contextBytes: envelope.contextBytes,
      outputBytes: envelope.outputBytes,
      activityChunks: envelope.activityChunks,
    });
    expect(reserved.maxBytes).toBe(envelope.maxBytes);
    expect(reserved.execution.finalRenderReservations[0]).toMatchObject({
      activityChunks: 16,
      activityEvents: 17,
      maxBytes: envelope.maxBytes,
    });

    const rejected = newExecution(db, "reservation-cap-plus-one");
    const capEnvelope = calculateFinalRenderReservationEnvelopeV1({
      activityChunks: 16,
      contextBytes: 8 * 1024,
      outputBytes: 16 * 1024,
    });
    expect(() => reserveFinalRender({
      db,
      executionId: "reservation-cap-plus-one",
      ownerToken: rejected.ownerToken,
      reservationKey: "under-counted",
      maxBytes: capEnvelope.maxBytes - 1,
      contextBytes: capEnvelope.contextBytes,
      outputBytes: capEnvelope.outputBytes,
      activityChunks: capEnvelope.activityChunks,
    })).toThrow("undercounts");
    expect(rejected.execution.finalRenderReservations).toHaveLength(0);
  });
});

describe("control races and terminal ownership", () => {
  test("bounds the initial owner lease to the root deadline", () => {
    const deadlineAt = Date.now() + 1_000;
    const created = newExecution(db, "initial-owner-lease-deadline", deadlineAt);
    const authority = db.query(
      "SELECT deadline_at, cas_expires_at FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id) as { deadline_at: number; cas_expires_at: number };
    expect(authority).toEqual({ deadline_at: deadlineAt, cas_expires_at: deadlineAt });
  });

  test("cancellation wins in a reversible phase and deadline wins at its CAS", () => {
    const cancelled = newExecution(db, "cancel");
    const cancellation = requestTurnCancellation({ db, executionId: "cancel", ownerToken: cancelled.ownerToken });
    expect(cancellation.code).toBe("cancelled");
    expect(cancellation.execution.state).toBe("CANCELLED");

    const timedOut = newExecution(db, "deadline", 10);
    const timeoutResult = transition(db, "deadline", timedOut.ownerToken, "ASSEMBLE", "WORK");
    expect(timeoutResult.execution.state).toBe("TIMED_OUT");
  });

  test("self-emitted direct cancellation canonicalizes its durable marker reason", () => {
    const settlementAt = Date.now();
    const created = newExecution(db, "self-emitted-canonical-stop", settlementAt + 60_000);
    const result = requestTurnCancellation({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      reason: "operator_requested_stop",
      now: settlementAt,
    });
    expect(result).toMatchObject({
      code: "cancelled",
      execution: {
        phase: "CANCELLED",
        terminalCode: "cancelled",
        cancelRequestedAt: settlementAt,
        casRevision: created.execution.casRevision + 1,
      },
    });
    expect(db.query(
      "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id)).toEqual({
      state: "CANCELLED",
      terminal_code: "cancelled",
      cancel_requested_at: settlementAt,
      terminal_at: settlementAt,
      updated_at: settlementAt,
      cas_revision: created.execution.casRevision + 1,
    });
  });
  test("live WORK cancellation retains owner/CAS until the requested terminal cause is applied", () => {
    const stopped = newExecution(db, "active-stop", Date.now() + 60_000);
    const working = transition(db, "active-stop", stopped.ownerToken, "ASSEMBLE", "WORK").execution;
    const authorityQuery = db.query(
      "SELECT state, cas_owner, cas_expires_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    );
    const authorityBefore = authorityQuery.get(working.id);
    const requested = requestActiveTurnCancellation({
      db,
      executionId: working.id,
      ownerToken: stopped.ownerToken,
      reason: "stopped",
    });
    expect(requested).toMatchObject({
      code: "cancelled",
      execution: {
        phase: "WORK",
        cancelRequested: true,
        casOwner: working.casOwner,
        casRevision: working.casRevision,
      },
    });
    expect(authorityQuery.get(working.id)).toEqual(authorityBefore);
    const markerAt = requested.execution.cancelRequestedAt;
    expect(requestActiveTurnCancellation({
      db,
      executionId: working.id,
      ownerToken: stopped.ownerToken,
      reason: "stopped",
      now: stopped.execution.deadlineAt + 1,
    })).toMatchObject({
      code: "cancelled",
      execution: { cancelRequestedAt: markerAt, casRevision: working.casRevision },
    });
    expect(transitionTurnExecution({
      db,
      executionId: working.id,
      ownerToken: stopped.ownerToken,
      expectedPhase: "WORK",
      nextPhase: "TIMED_OUT",
      now: stopped.execution.deadlineAt + 1,
    }).execution).toMatchObject({
      phase: "CANCELLED",
      casOwner: null,
    });

    const deadlineAt = Date.now() + 60_000;
    const overdue = newExecution(db, "active-stop-after-deadline", deadlineAt);
    const overdueWorking = transition(
      db,
      "active-stop-after-deadline",
      overdue.ownerToken,
      "ASSEMBLE",
      "WORK",
    ).execution;
    const timeoutRequested = requestActiveTurnCancellation({
      db,
      executionId: overdueWorking.id,
      ownerToken: overdue.ownerToken,
      reason: "stopped",
      now: deadlineAt,
    });
    expect(timeoutRequested).toMatchObject({
      code: "timed_out",
      execution: {
        phase: "WORK",
        cancelRequested: true,
        casOwner: overdueWorking.casOwner,
        casRevision: overdueWorking.casRevision,
      },
    });
    expect(transitionTurnExecution({
      db,
      executionId: overdueWorking.id,
      ownerToken: overdue.ownerToken,
      expectedPhase: "WORK",
      nextPhase: "TIMED_OUT",
      now: deadlineAt,
    }).execution).toMatchObject({ phase: "TIMED_OUT", terminalCode: "root_wall_clock_limit_exceeded" });
  });

  test("canonicalizes matching marked terminal phases despite caller reasons", () => {
    const stopCreated = newExecution(db, "matching-stop-reason", Date.now() + 60_000);
    const stopWorking = transition(
      db, stopCreated.execution.id, stopCreated.ownerToken, "ASSEMBLE", "WORK",
    ).execution;
    requestActiveTurnCancellation({
      db, executionId: stopWorking.id, ownerToken: stopCreated.ownerToken, reason: "stopped",
    });
    expect(transitionTurnExecution({
      db, executionId: stopWorking.id, ownerToken: stopCreated.ownerToken, expectedPhase: "WORK",
      nextPhase: "CANCELLED", reason: "agentic_cancelled",
    }).execution).toMatchObject({ phase: "CANCELLED", terminalCode: "cancelled" });

    const deadlineAt = Date.now() + 60_000;
    const timeoutCreated = newExecution(db, "matching-timeout-reason", deadlineAt);
    const timeoutWorking = transition(
      db, timeoutCreated.execution.id, timeoutCreated.ownerToken, "ASSEMBLE", "WORK",
    ).execution;
    requestActiveTurnCancellation({
      db, executionId: timeoutWorking.id, ownerToken: timeoutCreated.ownerToken,
      reason: "timed_out", now: deadlineAt - 1,
    });
    expect(transitionTurnExecution({
      db, executionId: timeoutWorking.id, ownerToken: timeoutCreated.ownerToken, expectedPhase: "WORK",
      nextPhase: "TIMED_OUT", reason: "agentic_timed_out", now: deadlineAt,
    }).execution).toMatchObject({
      phase: "TIMED_OUT", terminalCode: "root_wall_clock_limit_exceeded",
    });
    expect(db.query(
      "SELECT id, terminal_code FROM agent_turn_executions WHERE id IN (?, ?) ORDER BY id",
    ).all(stopWorking.id, timeoutWorking.id)).toEqual([
      { id: stopWorking.id, terminal_code: "cancelled" },
      { id: timeoutWorking.id, terminal_code: "root_wall_clock_limit_exceeded" },
    ]);
  });
  test("a Stop or timeout marker accepted between transition read and UPDATE wins the fenced CAS", () => {
    for (const cause of ["stop", "timeout"] as const) {
      const deadlineAt = Date.now() + 60_000;
      const created = newExecution(db, `transition-marker-race-${cause}`, deadlineAt);
      const working = transition(
        db, created.execution.id, created.ownerToken, "ASSEMBLE", "WORK",
      ).execution;
      let injected = false;
      let acceptedCode: string | undefined;
      const competingDb = new Proxy(db, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.query(sql);
            if (injected
              || !sql.startsWith('UPDATE "agent_turn_executions" SET')
              || !sql.includes('"state" = ?')
              || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "run") {
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                  injected = true;
                  acceptedCode = requestActiveTurnCancellation({
                    db: target,
                    executionId: working.id,
                    ownerToken: created.ownerToken,
                    reason: cause === "stop" ? "stopped" : "timed_out",
                    ...(cause === "timeout" ? { now: deadlineAt } : {}),
                  }).code;
                  return statementTarget.run(...bindings);
                };
              },
            });
          };
        },
      });

      const result = transitionTurnExecution({
        db: competingDb,
        executionId: working.id,
        ownerToken: created.ownerToken,
        expectedPhase: "WORK",
        nextPhase: "COMPLETE",
        now: deadlineAt - 1,
      });
      expect(injected).toBe(true);
      expect(acceptedCode).toBe(cause === "stop" ? "cancelled" : "timed_out");
      expect(result).toMatchObject({
        terminalEventEmitted: true,
        execution: cause === "stop"
          ? { phase: "CANCELLED", terminalCode: "cancelled", casRevision: working.casRevision + 1 }
          : { phase: "TIMED_OUT", terminalCode: "root_wall_clock_limit_exceeded", casRevision: working.casRevision + 1 },
      });
      expect(db.query(
        "SELECT state, terminal_code, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(working.id)).toEqual(cause === "stop"
        ? { state: "CANCELLED", terminal_code: "cancelled", cas_revision: working.casRevision + 1 }
        : { state: "TIMED_OUT", terminal_code: "root_wall_clock_limit_exceeded", cas_revision: working.casRevision + 1 });
    }
  });
  test("expiry CAS preserves a Stop or timeout marker accepted before its terminal UPDATE", () => {
    for (const cause of ["stop", "timeout"] as const) {
      const deadlineAt = Date.now() + 60_000;
      const created = newExecution(db, `expiry-marker-race-${cause}`, deadlineAt);
      const working = transition(
        db, created.execution.id, created.ownerToken, "ASSEMBLE", "WORK",
      ).execution;
      db.query("UPDATE agent_turn_executions SET cas_expires_at = ? WHERE id = ?")
        .run(deadlineAt + 2_000, working.id);
      let injected = false;
      let acceptedCode: string | undefined;
      const competingDb = new Proxy(db, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.query(sql);
            if (injected
              || !sql.startsWith('UPDATE "agent_turn_executions" SET')
              || !sql.includes('"terminal_code" = ?')
              || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "run") {
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                  injected = true;
                  acceptedCode = requestActiveTurnCancellation({
                    db: target,
                    executionId: working.id,
                    ownerToken: created.ownerToken,
                    reason: cause === "stop" ? "stopped" : "timed_out",
                    now: cause === "stop" ? deadlineAt - 1 : deadlineAt,
                  }).code;
                  return statementTarget.run(...bindings);
                };
              },
            });
          };
        },
      });

      const result = expireTurnExecution({
        db: competingDb,
        executionId: working.id,
        ownerToken: created.ownerToken,
        now: deadlineAt + 1_000,
      });
      expect(injected).toBe(true);
      expect(acceptedCode).toBe(cause === "stop" ? "cancelled" : "timed_out");
      expect(result).toMatchObject({
        code: cause === "stop" ? "cancelled" : "timed_out",
        execution: cause === "stop"
          ? { phase: "CANCELLED", terminalCode: "cancelled", cancelRequestedAt: deadlineAt - 1, casRevision: working.casRevision + 1 }
          : { phase: "TIMED_OUT", terminalCode: "root_wall_clock_limit_exceeded", cancelRequestedAt: deadlineAt, casRevision: working.casRevision + 1 },
      });
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(working.id)).toEqual(cause === "stop"
        ? { state: "CANCELLED", terminal_code: "cancelled", cancel_requested_at: deadlineAt - 1, cas_revision: working.casRevision + 1 }
        : { state: "TIMED_OUT", terminal_code: "root_wall_clock_limit_exceeded", cancel_requested_at: deadlineAt, cas_revision: working.casRevision + 1 });
    }
  });

  test("unmarked zero-deadline expiry emits canonical timeout authority once", () => {
    const settlementAt = Date.now();
    const created = newExecution(db, "zero-deadline-expiry", 0);
    const result = expireTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      now: settlementAt,
    });
    expect(result).toMatchObject({
      code: "timed_out",
      execution: {
        phase: "TIMED_OUT",
        terminalCode: "root_wall_clock_limit_exceeded",
        cancelRequested: false,
        cancelRequestedAt: null,
        casRevision: created.execution.casRevision + 1,
      },
    });
    const terminalSnapshot = db.query(
      "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id);
    expect(terminalSnapshot).toEqual({
      state: "TIMED_OUT",
      terminal_code: "root_wall_clock_limit_exceeded",
      cancel_requested_at: null,
      terminal_at: settlementAt,
      updated_at: settlementAt,
      cas_revision: created.execution.casRevision + 1,
    });
    expect(expireTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      now: settlementAt + 1,
    })).toMatchObject({
      code: "already_terminal",
      execution: {
        phase: "TIMED_OUT",
        terminalCode: "root_wall_clock_limit_exceeded",
        cancelRequested: false,
      },
    });
    expect(db.query(
      "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id)).toEqual(terminalSnapshot);
  });
  test("expiry classifies competing marker-owned and unrelated terminal winners without mutation", () => {
    createTerminalRecoverySchema(db);
    const scenarios = [
      { phase: "CANCELLED" as const, terminalCode: "cancelled", marker: "stop" as const, code: "cancelled" as const },
      { phase: "TIMED_OUT" as const, terminalCode: "root_wall_clock_limit_exceeded", marker: "timeout" as const, code: "timed_out" as const },
      { phase: "COMMITTED" as const, terminalCode: "committed", marker: null, code: "too_late" as const },
      { phase: "FAILED" as const, terminalCode: "provider_failed", marker: null, code: "already_terminal" as const },
      { phase: "EXHAUSTED" as const, terminalCode: "attempt_budget_exhausted", marker: null, code: "already_terminal" as const },
    ];
    for (const scenario of scenarios) {
      const deadlineAt = Date.now() + 10_000;
      const settlementAt = deadlineAt + 1_000;
      const winnerAt = deadlineAt + 500;
      const markerAt = scenario.marker === "stop"
        ? deadlineAt - 1
        : scenario.marker === "timeout" ? deadlineAt : null;
      const created = newExecution(db, `expiry-competing-${scenario.phase.toLowerCase()}`, deadlineAt);
      const working = transition(
        db, created.execution.id, created.ownerToken, "ASSEMBLE", "WORK",
      ).execution;
      let injected = false;
      const competingDb = new Proxy(db, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.query(sql);
            if (injected
              || !sql.startsWith('UPDATE "agent_turn_executions" SET')
              || !sql.includes('"terminal_code" = ?')
              || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "run") {
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                  injected = true;
                  target.query(`UPDATE agent_turn_executions
                    SET state = ?, terminal_code = ?, cancel_requested_at = ?, terminal_at = ?, updated_at = ?,
                        cas_revision = cas_revision + 1, phase_revision = phase_revision + 1
                    WHERE id = ?`).run(
                    scenario.phase,
                    scenario.terminalCode,
                    markerAt,
                    winnerAt,
                    winnerAt,
                    created.execution.id,
                  );
                  return statementTarget.run(...bindings);
                };
              },
            });
          };
        },
      });

      const result = expireTurnExecution({
        db: competingDb,
        executionId: created.execution.id,
        ownerToken: created.ownerToken,
        now: settlementAt,
      });
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        code: scenario.code,
        execution: {
          phase: scenario.phase,
          terminalCode: scenario.terminalCode,
          cancelRequested: markerAt !== null,
          cancelRequestedAt: markerAt,
          casRevision: working.casRevision + 1,
        },
      });
      const terminalSnapshot = db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id);
      expect(terminalSnapshot).toEqual({
        state: scenario.phase,
        terminal_code: scenario.terminalCode,
        cancel_requested_at: markerAt,
        terminal_at: winnerAt,
        updated_at: winnerAt,
        cas_revision: working.casRevision + 1,
      });
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
      ).get("u1", created.execution.id) as { count: number }).count).toBe(0);
      expect(expireTurnExecution({
        db,
        executionId: created.execution.id,
        ownerToken: created.ownerToken,
        now: settlementAt + 1,
      }).code).toBe(scenario.phase === "COMMITTED" ? "too_late" : "already_terminal");
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id)).toEqual(terminalSnapshot);
    }
  });
  test("non-WORK direct cancellation preserves a marker accepted immediately before terminal UPDATE", () => {
    for (const cause of ["stop", "timeout"] as const) {
      const deadlineAt = Date.now() + 10_000;
      const markerAt = cause === "stop" ? deadlineAt - 1 : deadlineAt;
      const settlementAt = deadlineAt + 1_000;
      const created = newExecution(db, `direct-terminal-marker-race-${cause}`, deadlineAt);
      let injected = false;
      let acceptedCode: string | undefined;
      const competingDb = new Proxy(db, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.query(sql);
            if (injected
              || !sql.startsWith('UPDATE "agent_turn_executions" SET')
              || !sql.includes('"terminal_code" = ?')
              || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "run") {
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                  injected = true;
                  acceptedCode = requestActiveTurnCancellation({
                    db: target,
                    executionId: created.execution.id,
                    ownerToken: created.ownerToken,
                    reason: cause === "stop" ? "stopped" : "timed_out",
                    now: markerAt,
                  }).code;
                  return statementTarget.run(...bindings);
                };
              },
            });
          };
        },
      });

      const result = requestTurnCancellation({
        db: competingDb,
        executionId: created.execution.id,
        ownerToken: created.ownerToken,
        reason: cause === "stop" ? "stopped" : "timed_out",
        now: settlementAt,
      });
      expect(injected).toBe(true);
      expect(acceptedCode).toBe(cause === "stop" ? "cancelled" : "timed_out");
      expect(result).toMatchObject({
        code: cause === "stop" ? "cancelled" : "timed_out",
        execution: cause === "stop"
          ? { phase: "CANCELLED", terminalCode: "cancelled", cancelRequestedAt: markerAt }
          : { phase: "TIMED_OUT", terminalCode: "root_wall_clock_limit_exceeded", cancelRequestedAt: markerAt },
      });
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id)).toEqual({
        state: cause === "stop" ? "CANCELLED" : "TIMED_OUT",
        terminal_code: cause === "stop" ? "cancelled" : "root_wall_clock_limit_exceeded",
        cancel_requested_at: markerAt,
        terminal_at: settlementAt,
        updated_at: settlementAt,
        cas_revision: created.execution.casRevision + 1,
      });
      const terminalSnapshot = db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id);
      expect(requestTurnCancellation({
        db,
        executionId: created.execution.id,
        ownerToken: created.ownerToken,
        now: settlementAt + 1,
      })).toMatchObject({ code: "already_terminal" });
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id)).toEqual(terminalSnapshot);
    }
  });
  test("fenced direct cancellation validates marked terminal winners before exposing marker authority", () => {
    const scenarios = [
      { id: "marked-winner-cancelled", markerOffset: -1, phase: "CANCELLED", terminalCode: "cancelled", canonical: true, code: "cancelled" },
      { id: "marked-winner-timeout", markerOffset: 0, phase: "TIMED_OUT", terminalCode: "root_wall_clock_limit_exceeded", canonical: true, code: "timed_out" },
      { id: "marked-winner-bad-code", markerOffset: -1, phase: "CANCELLED", terminalCode: "segment_failed", canonical: false, code: null },
      { id: "marked-winner-bad-phase", markerOffset: -1, phase: "TIMED_OUT", terminalCode: "root_wall_clock_limit_exceeded", canonical: false, code: null },
      { id: "marked-winner-failed", markerOffset: -1, phase: "FAILED", terminalCode: "provider_failed", canonical: false, code: null },
      { id: "marked-winner-exhausted", markerOffset: -1, phase: "EXHAUSTED", terminalCode: "attempt_budget_exhausted", canonical: false, code: null },
      { id: "marked-winner-commit-failed", markerOffset: -1, phase: "COMMIT_FAILED", terminalCode: "commit_failed", canonical: false, code: null },
      { id: "marked-winner-committed", markerOffset: -1, phase: "COMMITTED", terminalCode: "committed", canonical: false, code: null },
    ] as const;
    for (const scenario of scenarios) {
      const deadlineAt = Date.now() + 10_000;
      const markerAt = deadlineAt + scenario.markerOffset;
      const winnerAt = deadlineAt + 1_000;
      const created = newExecution(db, scenario.id, deadlineAt);
      let injected = false;
      const competingDb = new Proxy(db, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.query(sql);
            if (injected
              || !sql.startsWith('UPDATE "agent_turn_executions" SET')
              || !sql.includes('"terminal_code" = ?')
              || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "run") {
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                  injected = true;
                  target.query(`UPDATE agent_turn_executions
                    SET state = ?, terminal_code = ?, cancel_requested_at = ?, terminal_at = ?, updated_at = ?,
                        cas_revision = cas_revision + 1, phase_revision = phase_revision + 1
                    WHERE id = ?`).run(
                    scenario.phase,
                    scenario.terminalCode,
                    markerAt,
                    winnerAt,
                    winnerAt,
                    created.execution.id,
                  );
                  return statementTarget.run(...bindings);
                };
              },
            });
          };
        },
      });

      const request = () => requestTurnCancellation({
        db: competingDb,
        executionId: created.execution.id,
        ownerToken: created.ownerToken,
        now: winnerAt + 1,
      });
      if (scenario.canonical) {
        expect(request()).toMatchObject({
          code: scenario.code,
          execution: {
            phase: scenario.phase,
            terminalCode: scenario.terminalCode,
            cancelRequestedAt: markerAt,
            casRevision: created.execution.casRevision + 1,
          },
        });
      } else {
        expect(request).toThrow("accepted cancellation marker lost its terminal cause");
      }
      expect(injected).toBe(true);
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id)).toEqual({
        state: scenario.phase,
        terminal_code: scenario.terminalCode,
        cancel_requested_at: markerAt,
        terminal_at: winnerAt,
        updated_at: winnerAt,
        cas_revision: created.execution.casRevision + 1,
      });
    }
  });

  test("boolean marked non-cancellation terminal winners fail canonical cancellation authority", () => {
    db.run("ALTER TABLE agent_turn_executions RENAME COLUMN cancel_requested_at TO cancel_requested");
    for (const scenario of [
      { phase: "FAILED", terminalCode: "provider_failed" },
      { phase: "EXHAUSTED", terminalCode: "attempt_budget_exhausted" },
      { phase: "COMMIT_FAILED", terminalCode: "commit_failed" },
      { phase: "COMMITTED", terminalCode: "committed" },
    ] as const) {
      const deadlineAt = Date.now() + 10_000;
      const markerAt = deadlineAt - 1;
      const winnerAt = deadlineAt + 1_000;
      const created = newExecution(db, `boolean-marked-winner-${scenario.phase.toLowerCase()}`, deadlineAt);
      let injected = false;
      const competingDb = new Proxy(db, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.query(sql);
            if (injected
              || !sql.startsWith('UPDATE "agent_turn_executions" SET')
              || !sql.includes('"terminal_code" = ?')
              || !sql.includes('COALESCE("cancel_requested", 0) = 0')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "run") {
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                  injected = true;
                  target.query(`UPDATE agent_turn_executions
                    SET state = ?, terminal_code = ?, cancel_requested = 1, terminal_at = ?, updated_at = ?,
                        cas_revision = cas_revision + 1, phase_revision = phase_revision + 1
                    WHERE id = ?`).run(
                    scenario.phase,
                    scenario.terminalCode,
                    winnerAt,
                    markerAt,
                    created.execution.id,
                  );
                  return statementTarget.run(...bindings);
                };
              },
            });
          };
        },
      });

      expect(() => requestTurnCancellation({
        db: competingDb,
        executionId: created.execution.id,
        ownerToken: created.ownerToken,
        now: winnerAt + 1,
      })).toThrow("accepted cancellation marker lost its terminal cause");
      expect(injected).toBe(true);
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id)).toEqual({
        state: scenario.phase,
        terminal_code: scenario.terminalCode,
        cancel_requested: 1,
        terminal_at: winnerAt,
        updated_at: markerAt,
        cas_revision: created.execution.casRevision + 1,
      });
    }
  });
  test("direct cancellation reports unmarked FAILED, EXHAUSTED, and TIMED_OUT terminal winners accurately", () => {
    createTerminalRecoverySchema(db);
    for (const scenario of [
      { phase: "FAILED", terminalCode: "provider_failed" },
      { phase: "EXHAUSTED", terminalCode: "attempt_budget_exhausted" },
      { phase: "TIMED_OUT", terminalCode: "root_wall_clock_limit_exceeded" },
    ] as const) {
      const winnerAt = Date.now();
      const created = newExecution(db, `unmarked-direct-winner-${scenario.phase.toLowerCase()}`, winnerAt + 10_000);
      let injected = false;
      const competingDb = new Proxy(db, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.query(sql);
            if (injected
              || !sql.startsWith('UPDATE "agent_turn_executions" SET')
              || !sql.includes('"terminal_code" = ?')
              || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "run") {
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                  injected = true;
                  target.query(`UPDATE agent_turn_executions
                    SET state = ?, terminal_code = ?, terminal_at = ?, updated_at = ?,
                        cas_revision = cas_revision + 1, phase_revision = phase_revision + 1
                    WHERE id = ?`).run(
                    scenario.phase,
                    scenario.terminalCode,
                    winnerAt,
                    winnerAt,
                    created.execution.id,
                  );
                  return statementTarget.run(...bindings);
                };
              },
            });
          };
        },
      });

      const result = requestTurnCancellation({
        db: competingDb,
        executionId: created.execution.id,
        ownerToken: created.ownerToken,
        now: winnerAt + 1,
      });
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        code: "already_terminal",
        execution: {
          phase: scenario.phase,
          terminalCode: scenario.terminalCode,
          cancelRequested: false,
          cancelRequestedAt: null,
          casRevision: created.execution.casRevision + 1,
        },
      });
      const terminalSnapshot = db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id);
      expect(terminalSnapshot).toEqual({
        state: scenario.phase,
        terminal_code: scenario.terminalCode,
        cancel_requested_at: null,
        terminal_at: winnerAt,
        updated_at: winnerAt,
        cas_revision: created.execution.casRevision + 1,
      });
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
      ).get("u1", created.execution.id) as { count: number }).count).toBe(0);
      expect(requestTurnCancellation({
        db,
        executionId: created.execution.id,
        ownerToken: created.ownerToken,
        now: winnerAt + 2,
      })).toMatchObject({ code: "already_terminal", execution: { phase: scenario.phase } });
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id)).toEqual(terminalSnapshot);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
      ).get("u1", created.execution.id) as { count: number }).count).toBe(0);
    }
  });
  test("live Stop retries across ASSEMBLE to WORK and preserves its pre-deadline timestamp after settlement", () => {
    const requestAt = Date.now();
    const deadlineAt = requestAt + 60_000;
    const created = newExecution(db, "active-forward-retry", deadlineAt);
    let forwarded: ReturnType<typeof transitionTurnExecution>["execution"] | undefined;
    let markerUpdateAttempts = 0;
    const competingDb = new Proxy(db, {
      get(target, property) {
        if (property !== "query") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.query(sql);
          if (!sql.startsWith('UPDATE "agent_turn_executions" SET')
            || !sql.includes('"cancel_requested_at" = ?')
            || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== "run") {
                const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }
              return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                markerUpdateAttempts += 1;
                if (!forwarded) {
                  forwarded = transitionTurnExecution({
                    db: target,
                    executionId: created.execution.id,
                    ownerToken: created.ownerToken,
                    expectedPhase: "ASSEMBLE",
                    nextPhase: "WORK",
                    now: requestAt,
                  }).execution;
                }
                return statementTarget.run(...bindings);
              };
            },
          });
        };
      },
    });

    const stopped = requestActiveTurnCancellation({
      db: competingDb,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      reason: "stopped",
      now: requestAt,
    });
    expect(markerUpdateAttempts).toBe(2);
    expect(forwarded).toMatchObject({ phase: "WORK", casRevision: created.execution.casRevision + 1 });
    expect(stopped).toMatchObject({
      code: "cancelled",
      execution: {
        phase: "WORK",
        cancelRequested: true,
        cancelRequestedAt: requestAt,
        casRevision: created.execution.casRevision + 1,
      },
    });
    expect(db.query(
      "SELECT state, cancel_requested_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id)).toEqual({
      state: "WORK",
      cancel_requested_at: requestAt,
      cas_revision: created.execution.casRevision + 1,
    });

    const abortedForward = transitionTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      expectedPhase: "WORK",
      nextPhase: "COMPLETE",
      now: deadlineAt + 1_000,
    });
    expect(abortedForward).toMatchObject({
      terminalEventEmitted: true,
      execution: {
        phase: "CANCELLED",
        terminalCode: "cancelled",
        cancelRequestedAt: requestAt,
        casRevision: created.execution.casRevision + 2,
      },
    });
    const terminalSnapshot = db.query(
      "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id);
    expect(terminalSnapshot).toEqual({
      state: "CANCELLED",
      terminal_code: "cancelled",
      cancel_requested_at: requestAt,
      terminal_at: deadlineAt + 1_000,
      updated_at: deadlineAt + 1_000,
      cas_revision: created.execution.casRevision + 2,
    });
    expect(expireTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      now: deadlineAt + 2_000,
    })).toMatchObject({ code: "already_terminal", execution: { phase: "CANCELLED", cancelRequestedAt: requestAt } });
    expect(db.query(
      "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id)).toEqual(terminalSnapshot);
  });

  test("live Stop returns canonical too_late when a WORK CAS reaches COMPLETE first", () => {
    const requestAt = Date.now();
    const created = newExecution(db, "active-work-forward-too-late", requestAt + 60_000);
    const working = transition(
      db, created.execution.id, created.ownerToken, "ASSEMBLE", "WORK",
    ).execution;
    let forwarded = false;
    const competingDb = new Proxy(db, {
      get(target, property) {
        if (property !== "query") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.query(sql);
          if (forwarded
            || !sql.startsWith('UPDATE "agent_turn_executions" SET')
            || !sql.includes('"cancel_requested_at" = ?')
            || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== "run") {
                const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }
              return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                forwarded = true;
                transitionTurnExecution({
                  db: target,
                  executionId: working.id,
                  ownerToken: created.ownerToken,
                  expectedPhase: "WORK",
                  nextPhase: "COMPLETE",
                  now: requestAt,
                });
                return statementTarget.run(...bindings);
              };
            },
          });
        };
      },
    });

    const result = requestActiveTurnCancellation({
      db: competingDb,
      executionId: working.id,
      ownerToken: created.ownerToken,
      reason: "stopped",
      now: requestAt,
    });
    expect(forwarded).toBe(true);
    expect(result).toMatchObject({
      code: "too_late",
      execution: { phase: "COMPLETE", cancelRequested: false, casRevision: working.casRevision + 1 },
    });
    expect(db.query(
      "SELECT state, cancel_requested_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(working.id)).toEqual({
      state: "COMPLETE",
      cancel_requested_at: null,
      cas_revision: working.casRevision + 1,
    });
  });

  test("competing deadline marker wins the same SQL CAS over a pre-deadline Stop", () => {
    const deadlineAt = Date.now() + 60_000;
    const created = newExecution(db, "active-competing-cancellation-marker", deadlineAt);
    const working = transition(
      db,
      created.execution.id,
      created.ownerToken,
      "ASSEMBLE",
      "WORK",
    ).execution;
    db.query("UPDATE agent_turn_executions SET cas_expires_at = ? WHERE id = ?")
      .run(deadlineAt + 1_000, working.id);
    let injectedDeadlineMarker = false;
    const competingDb = new Proxy(db, {
      get(target, property) {
        if (property !== "query") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          const statement = target.query(sql);
          if (injectedDeadlineMarker
            || !sql.startsWith('UPDATE "agent_turn_executions" SET')
            || !sql.includes('"cancel_requested_at" = ?')) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== "run") {
                const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }
              return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                injectedDeadlineMarker = true;
                target.query(
                  "UPDATE agent_turn_executions SET cancel_requested_at = ?, updated_at = ? WHERE id = ? AND cancel_requested_at IS NULL",
                ).run(deadlineAt, deadlineAt, working.id);
                return statementTarget.run(...bindings);
              };
            },
          });
        };
      },
    });

    const result = requestActiveTurnCancellation({
      db: competingDb,
      executionId: working.id,
      ownerToken: created.ownerToken,
      reason: "stopped",
      now: deadlineAt - 1,
    });
    expect(injectedDeadlineMarker).toBe(true);
    expect(result).toMatchObject({
      code: "timed_out",
      execution: {
        phase: "WORK",
        cancelRequestedAt: deadlineAt,
        casOwner: working.casOwner,
        casRevision: working.casRevision,
      },
    });
    expect(db.query(
      "SELECT cancel_requested_at, updated_at FROM agent_turn_executions WHERE id = ?",
    ).get(working.id)).toEqual({ cancel_requested_at: deadlineAt, updated_at: deadlineAt });
  });

  test("active cancellation writes compatibility markers and fails closed without one", () => {
    db.run("ALTER TABLE agent_turn_executions RENAME COLUMN cancel_requested_at TO cancel_requested");
    const compatible = newExecution(db, "active-compatible-marker");
    const working = transition(db, compatible.execution.id, compatible.ownerToken, "ASSEMBLE", "WORK").execution;
    const authorityQuery = db.query(
      "SELECT state, cas_owner, cas_expires_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    );
    const authorityBefore = authorityQuery.get(working.id);
    expect(requestActiveTurnCancellation({
      db,
      executionId: working.id,
      ownerToken: compatible.ownerToken,
    })).toMatchObject({ code: "cancelled", execution: { phase: "WORK", cancelRequested: true } });
    expect(db.query("SELECT cancel_requested FROM agent_turn_executions WHERE id = ?").get(working.id))
      .toEqual({ cancel_requested: 1 });
    expect(authorityQuery.get(working.id)).toEqual(authorityBefore);
    const compatibilityDeadline = Date.now() + 60_000;
    const compatibleTimeout = newExecution(db, "active-compatible-timeout-marker", compatibilityDeadline);
    transition(db, compatibleTimeout.execution.id, compatibleTimeout.ownerToken, "ASSEMBLE", "WORK");
    expect(requestActiveTurnCancellation({
      db,
      executionId: compatibleTimeout.execution.id,
      ownerToken: compatibleTimeout.ownerToken,
      reason: "timed_out",
      now: compatibilityDeadline - 1_000,
    })).toMatchObject({ code: "timed_out", execution: { phase: "WORK", cancelRequested: true } });
    expect(transitionTurnExecution({
      db,
      executionId: compatibleTimeout.execution.id,
      ownerToken: compatibleTimeout.ownerToken,
      expectedPhase: "WORK",
      nextPhase: "TIMED_OUT",
      now: compatibilityDeadline,
    }).execution.phase).toBe("TIMED_OUT");

    const unavailableDb = createExecutionSchema();
    try {
      const unavailable = newExecution(unavailableDb, "active-marker-unavailable");
      const unavailableWorking = transition(
        unavailableDb,
        unavailable.execution.id,
        unavailable.ownerToken,
        "ASSEMBLE",
        "WORK",
      ).execution;
      unavailableDb.run("ALTER TABLE agent_turn_executions RENAME COLUMN cancel_requested_at TO unavailable_cancel_requested_at");
      const rowQuery = unavailableDb.query(
        "SELECT state, cas_owner, cas_expires_at, cas_revision, updated_at FROM agent_turn_executions WHERE id = ?",
      );
      const before = rowQuery.get(unavailableWorking.id);
      expect(() => requestActiveTurnCancellation({
        db: unavailableDb,
        executionId: unavailableWorking.id,
        ownerToken: unavailable.ownerToken,
      })).toThrow("no durable cancellation marker");
      expect(rowQuery.get(unavailableWorking.id)).toEqual(before);
    } finally {
      unavailableDb.close();
    }
  });
  test("explicit timeout cancellation remains TIMED_OUT before the local deadline elapses", () => {
    const created = newExecution(db, "explicit-timeout", Date.now() + 60_000);
    const result = requestTurnCancellation({
      db,
      executionId: "explicit-timeout",
      ownerToken: created.ownerToken,
      reason: "timed_out",
      now: Date.now(),
    });
    expect(result.code).toBe("timed_out");
    expect(result.execution.phase).toBe("TIMED_OUT");
    expect(result.execution.workOutcome).toBe("failed");
  });

  test("Stop is too late from COMPLETE while deadline expiry remains TIMED_OUT", () => {
    const working = newExecution(db, "stop-work-boundary");
    transition(db, "stop-work-boundary", working.ownerToken, "ASSEMBLE", "WORK");
    expect(requestTurnCancellation({
      db,
      executionId: "stop-work-boundary",
      ownerToken: working.ownerToken,
    })).toMatchObject({ code: "cancelled", execution: { phase: "WORK", cancelRequested: true } });
    expect(transition(db, "stop-work-boundary", working.ownerToken, "WORK", "COMPLETE").execution.phase)
      .toBe("CANCELLED");

    const latePhases = [
      { id: "stop-complete", path: ["WORK", "COMPLETE"] as const },
      { id: "stop-render", path: ["WORK", "COMPLETE", "RENDER"] as const },
      { id: "stop-prepare", path: ["WORK", "COMPLETE", "RENDER", "PREPARE_COMMIT"] as const },
    ];
    for (const { id, path } of latePhases) {
      const created = newExecution(db, id, Date.now() + 60_000);
      let expected: TurnExecutionPhase = "ASSEMBLE";
      for (const phase of path) {
        transition(db, id, created.ownerToken, expected, phase);
        expected = phase;
      }
      const stopped = requestTurnCancellation({
        db,
        executionId: id,
        ownerToken: created.ownerToken,
        reason: "timed_out",
      });
      expect(stopped.code).toBe("too_late");
      expect(stopped.execution.phase).toBe(expected);
    }

    const dormant = newExecution(db, "stop-dormant-complete");
    transition(db, "stop-dormant-complete", dormant.ownerToken, "ASSEMBLE", "WORK");
    transition(db, "stop-dormant-complete", dormant.ownerToken, "WORK", "COMPLETE");
    db.query(
      "UPDATE agent_turn_executions SET cas_owner = NULL, cas_expires_at = NULL WHERE id = 'stop-dormant-complete'",
    ).run();
    expect(requestDormantTurnCancellation({
      db,
      executionId: "stop-dormant-complete",
      userId: "u1",
      chatId: "c1",
    })).toMatchObject({ code: "too_late", execution: { phase: "COMPLETE" } });

    const deadlineAt = Date.now() + 60_000;
    const expiring = newExecution(db, "deadline-complete", deadlineAt);
    transition(db, "deadline-complete", expiring.ownerToken, "ASSEMBLE", "WORK");
    transition(db, "deadline-complete", expiring.ownerToken, "WORK", "COMPLETE");
    expect(expireTurnExecution({
      db,
      executionId: "deadline-complete",
      ownerToken: expiring.ownerToken,
      now: deadlineAt,
    })).toMatchObject({ code: "timed_out", execution: { phase: "TIMED_OUT" } });
  });
  test("expiry preserves a predeadline cancellation marker after the deadline", () => {
    const deadlineAt = Date.now() + 10_000;
    const created = newExecution(db, "deadline-after-stop", deadlineAt);
    transition(db, created.execution.id, created.ownerToken, "ASSEMBLE", "WORK");

    expect(requestActiveTurnCancellation({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      reason: "stopped",
      now: deadlineAt - 1,
    })).toMatchObject({ code: "cancelled", execution: { phase: "WORK", cancelRequested: true } });

    expect(expireTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      now: deadlineAt + 1,
    })).toMatchObject({
      code: "cancelled",
      execution: { phase: "CANCELLED", terminalCode: "cancelled" },
    });
    expect(expireTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      now: deadlineAt + 2,
    })).toMatchObject({ code: "already_terminal", execution: { phase: "CANCELLED" } });
  });

  test("projects active and terminal phases with canonical status/outcome pairs", () => {
    const active = newExecution(db, "projection-active");
    expect(active.execution.workStatus).toBe("running");
    expect(active.execution.workOutcome).toBeNull();
    transition(db, "projection-active", active.ownerToken, "ASSEMBLE", "WORK");
    const waiting = transition(db, "projection-active", active.ownerToken, "WORK", "COMPLETE");
    expect(waiting.execution.workStatus).toBe("waiting");
    expect(waiting.execution.workOutcome).toBeNull();

    const timedOut = newExecution(db, "projection-timeout", 10);
    const timeoutResult = transition(db, "projection-timeout", timedOut.ownerToken, "ASSEMBLE", "WORK");
    expect(timeoutResult.execution.phase).toBe("TIMED_OUT");
    expect(timeoutResult.execution.workOutcome).toBe("failed");

    const exhausted = newExecution(db, "projection-exhausted");
    transition(db, "projection-exhausted", exhausted.ownerToken, "ASSEMBLE", "WORK");
    const exhaustedResult = transitionTurnExecution({
      db,
      executionId: "projection-exhausted",
      ownerToken: exhausted.ownerToken,
      expectedPhase: "WORK",
      nextPhase: "EXHAUSTED",
      reason: "agentic_work_exhausted",
    });
    expect(exhaustedResult.execution.workOutcome).toBe("exhausted");

    const committed = newExecution(db, "projection-committed");
    const work = transition(db, "projection-committed", committed.ownerToken, "ASSEMBLE", "WORK");
    const completionHandoff = transition(db, "projection-committed", committed.ownerToken, "WORK", "COMPLETE");
    const render = transition(db, "projection-committed", committed.ownerToken, "COMPLETE", "RENDER");
    const commitPreparation = transition(db, "projection-committed", committed.ownerToken, "RENDER", "PREPARE_COMMIT");
    const committing = beginTurnCommit({
      db,
      executionId: "projection-committed",
      ownerToken: committed.ownerToken,
    });
    expect([
      committed.execution.workPhase,
      work.execution.workPhase,
      completionHandoff.execution.workPhase,
      render.execution.workPhase,
      commitPreparation.execution.workPhase,
      committing.execution.workPhase,
    ]).toEqual(["ASSEMBLE", "WORK", "PREPARE_COMMIT", "RENDER", "COMMIT", "COMMIT"]);
    expect(commitPreparation.execution.workStatus).toBe("waiting");
    expect(commitPreparation.execution.workOutcome).toBeNull();
    expect(committing.execution.workStatus).toBe("running");
    expect(committing.execution.workOutcome).toBeNull();
    const completed = finalizeTurnCommit({
      db,
      executionId: "projection-committed",
      ownerToken: committed.ownerToken,
    });
    expect(completed.execution.workStatus).toBe("terminal");
    expect(completed.execution.workOutcome).toBe("completed");
  });

  test("dormant cancellation uses the durable ownerless CAS for reversible, late, terminal, and active rows", () => {
    const dormant = newExecution(db, "dormant");
    db.query(
      "UPDATE agent_turn_executions SET state = 'WORK', cas_owner = NULL, cas_expires_at = NULL WHERE id = 'dormant'",
    ).run();
    const cancelled = requestDormantTurnCancellation({
      db,
      executionId: "dormant",
      userId: "u1",
      chatId: "c1",
    });
    expect(cancelled.code).toBe("cancelled");
    expect(cancelled.execution.state).toBe("CANCELLED");
    expect(cancelled.execution.cas.revision).toBe(dormant.execution.cas.revision + 1);
    expect(requestDormantTurnCancellation({
      db,
      executionId: "dormant",
      userId: "u1",
      chatId: "c1",
    }).code).toBe("already_terminal");

    const late = newExecution(db, "dormant-late");
    moveToCommit(db, "dormant-late", late.ownerToken);
    db.query(
      "UPDATE agent_turn_executions SET cas_owner = NULL, cas_expires_at = NULL WHERE id = 'dormant-late'",
    ).run();
    const tooLate = requestDormantTurnCancellation({
      db,
      executionId: "dormant-late",
      userId: "u1",
      chatId: "c1",
    });
    expect(tooLate.code).toBe("too_late");
    expect(tooLate.execution.state).toBe("COMMITTING");

    const terminal = newExecution(db, "dormant-terminal");
    transition(db, "dormant-terminal", terminal.ownerToken, "ASSEMBLE", "FAILED");
    const alreadyTerminal = requestDormantTurnCancellation({
      db,
      executionId: "dormant-terminal",
      userId: "u1",
      chatId: "c1",
    });
    expect(alreadyTerminal.code).toBe("already_terminal");
    expect(alreadyTerminal.execution.state).toBe("FAILED");

    const active = newExecution(db, "dormant-active");
    expect(() => requestDormantTurnCancellation({
      db,
      executionId: "dormant-active",
      userId: "u1",
      chatId: "c1",
    })).toThrow("stale_owner");

    const deadline = newExecution(db, "dormant-deadline", 10);
    db.query(
      "UPDATE agent_turn_executions SET cas_owner = NULL, cas_expires_at = NULL WHERE id = 'dormant-deadline'",
    ).run();
    const timedOut = requestDormantTurnCancellation({
      db,
      executionId: "dormant-deadline",
      userId: "u1",
      chatId: "c1",
      now: 10,
    });
    expect(timedOut.code).toBe("timed_out");
    expect(timedOut.execution.state).toBe("TIMED_OUT");
    expect(timedOut.execution.cas.revision).toBe(deadline.execution.cas.revision + 1);
  });

  test("dormant cancellation preserves the first marker after wall time crosses the deadline", () => {
    const cases = [
      { id: "dormant-marker-before", markerAt: 9_999, phase: "CANCELLED", code: "cancelled" },
      { id: "dormant-marker-at", markerAt: 10_000, phase: "TIMED_OUT", code: "timed_out" },
    ] as const;
    for (const scenario of cases) {
      newExecution(db, scenario.id, 10_000);
      db.query(
        "UPDATE agent_turn_executions SET cas_owner = NULL, cas_expires_at = NULL, cancel_requested_at = ?, updated_at = ? WHERE id = ?",
      ).run(scenario.markerAt, scenario.markerAt, scenario.id);
      const result = requestDormantTurnCancellation({
        db, executionId: scenario.id, userId: "u1", chatId: "c1", now: 20_000,
      });
      expect(result).toMatchObject({ code: scenario.code, execution: { phase: scenario.phase } });
    }
  });

  test("dormant cancellation classifies competing marker-owned and unrelated terminal winners", () => {
    createTerminalRecoverySchema(db);
    const scenarios = [
      { phase: "CANCELLED" as const, terminalCode: "cancelled", marker: "stop" as const, code: "cancelled" as const },
      { phase: "TIMED_OUT" as const, terminalCode: "root_wall_clock_limit_exceeded", marker: "timeout" as const, code: "timed_out" as const },
      { phase: "COMMITTED" as const, terminalCode: "committed", marker: null, code: "too_late" as const },
      { phase: "FAILED" as const, terminalCode: "provider_failed", marker: null, code: "already_terminal" as const },
      { phase: "EXHAUSTED" as const, terminalCode: "attempt_budget_exhausted", marker: null, code: "already_terminal" as const },
    ];
    for (const scenario of scenarios) {
      const deadlineAt = Date.now() + 10_000;
      const settlementAt = deadlineAt + 1_000;
      const winnerAt = deadlineAt + 500;
      const markerAt = scenario.marker === "stop"
        ? deadlineAt - 1
        : scenario.marker === "timeout" ? deadlineAt : null;
      const created = newExecution(db, `dormant-competing-${scenario.phase.toLowerCase()}`, deadlineAt);
      db.query(
        "UPDATE agent_turn_executions SET cas_owner = NULL, cas_expires_at = NULL WHERE id = ?",
      ).run(created.execution.id);
      let injected = false;
      const competingDb = new Proxy(db, {
        get(target, property) {
          if (property !== "query") {
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return (sql: string) => {
            const statement = target.query(sql);
            if (injected
              || !sql.startsWith('UPDATE "agent_turn_executions" SET')
              || !sql.includes('"terminal_code" = ?')
              || !sql.includes('"cancel_requested_at" IS NULL')) return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty) {
                if (statementProperty !== "run") {
                  const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                  return typeof value === "function" ? value.bind(statementTarget) : value;
                }
                return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                  injected = true;
                  target.query(`UPDATE agent_turn_executions
                    SET state = ?, terminal_code = ?, cancel_requested_at = ?, terminal_at = ?, updated_at = ?,
                        cas_revision = cas_revision + 1, phase_revision = phase_revision + 1
                    WHERE id = ?`).run(
                    scenario.phase,
                    scenario.terminalCode,
                    markerAt,
                    winnerAt,
                    winnerAt,
                    created.execution.id,
                  );
                  return statementTarget.run(...bindings);
                };
              },
            });
          };
        },
      });

      const result = requestDormantTurnCancellation({
        db: competingDb,
        executionId: created.execution.id,
        userId: "u1",
        chatId: "c1",
        now: settlementAt,
      });
      expect(injected).toBe(true);
      expect(result).toMatchObject({
        code: scenario.code,
        execution: {
          phase: scenario.phase,
          terminalCode: scenario.terminalCode,
          cancelRequested: markerAt !== null,
          cancelRequestedAt: markerAt,
          casRevision: created.execution.casRevision + 1,
        },
      });
      const terminalSnapshot = db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id);
      expect(terminalSnapshot).toEqual({
        state: scenario.phase,
        terminal_code: scenario.terminalCode,
        cancel_requested_at: markerAt,
        terminal_at: winnerAt,
        updated_at: winnerAt,
        cas_revision: created.execution.casRevision + 1,
      });
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
      ).get("u1", created.execution.id) as { count: number }).count).toBe(0);
      expect(requestDormantTurnCancellation({
        db,
        executionId: created.execution.id,
        userId: "u1",
        chatId: "c1",
        now: settlementAt + 1,
      }).code).toBe(scenario.phase === "COMMITTED" ? "too_late" : "already_terminal");
      expect(db.query(
        "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
      ).get(created.execution.id)).toEqual(terminalSnapshot);
    }
  });
  test("generic startup reconciliation preserves first markers without segment authority", () => {
    const deadlineAt = Date.now() + 3_600_000;
    const assemble = newExecution(db, "reconcile-marker-assemble", deadlineAt);
    const work = newExecution(db, "reconcile-marker-work", deadlineAt);
    transition(db, work.execution.id, work.ownerToken, "ASSEMBLE", "WORK");
    const markerAt = Date.now();
    db.query(
      "UPDATE agent_turn_executions SET runtime_epoch = 0, cas_expires_at = 0, cancel_requested_at = ?, updated_at = ? WHERE id IN (?, ?)",
    ).run(markerAt, markerAt, assemble.execution.id, work.execution.id);

    const first = reconcileAgentTurns(db);
    expect(first).toMatchObject({ claimed: 2, failedInterrupted: 0 });
    expect(getTurnExecution(assemble.execution.id, "u1", db)?.phase).toBe("CANCELLED");
    expect(getTurnExecution(work.execution.id, "u1", db)?.phase).toBe("CANCELLED");
    expect(reconcileAgentTurns(db)).toMatchObject({ claimed: 0, failedInterrupted: 0 });
  });

  test("boolean-only reconciliation preserves marker time across its ownership claim", () => {
    db.run("ALTER TABLE agent_turn_executions RENAME COLUMN cancel_requested_at TO cancel_requested");
    const deadlineAt = 10_000;
    const stopped = newExecution(db, "reconcile-compatible-stop", deadlineAt);
    const timedOut = newExecution(db, "reconcile-compatible-timeout", deadlineAt);
    db.query(`UPDATE agent_turn_executions
      SET runtime_epoch = 0, cas_expires_at = 0, cancel_requested = 1, updated_at = ?
      WHERE id = ?`).run(deadlineAt - 1, stopped.execution.id);
    db.query(`UPDATE agent_turn_executions
      SET runtime_epoch = 0, cas_expires_at = 0, cancel_requested = 1, updated_at = ?
      WHERE id = ?`).run(deadlineAt + 1, timedOut.execution.id);

    __testing.setReconciliationClock(() => deadlineAt + 10_000);
    try {
      expect(reconcileAgentTurns(db)).toMatchObject({ claimed: 2, failedInterrupted: 0 });
    } finally {
      __testing.setReconciliationClock(null);
    }
    expect(db.query(
      "SELECT state, terminal_code, cancel_requested, updated_at, terminal_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(stopped.execution.id)).toEqual({
      state: "CANCELLED",
      terminal_code: "cancelled",
      cancel_requested: 1,
      updated_at: deadlineAt - 1,
      terminal_at: deadlineAt + 10_000,
      cas_revision: stopped.execution.casRevision + 2,
    });
    expect(db.query(
      "SELECT state, terminal_code, cancel_requested, updated_at, terminal_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(timedOut.execution.id)).toEqual({
      state: "TIMED_OUT",
      terminal_code: "root_wall_clock_limit_exceeded",
      cancel_requested: 1,
      updated_at: deadlineAt + 1,
      terminal_at: deadlineAt + 10_000,
      cas_revision: timedOut.execution.casRevision + 2,
    });
  });

  test("cancellation is too late after the commit gate", () => {
    const created = newExecution(db, "late");
    moveToCommit(db, "late", created.ownerToken);
    const result = requestTurnCancellation({ db, executionId: "late", ownerToken: created.ownerToken });
    expect(result.code).toBe("too_late");
    expect(result.execution.state).toBe("COMMITTING");
  });

  test("direct cancellation synthesizes one marker only when none was accepted", () => {
    const settlementAt = Date.now();
    const created = newExecution(db, "terminal-synthesized-cancellation", settlementAt + 60_000);
    const cancelled = transitionTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      expectedPhase: "ASSEMBLE",
      nextPhase: "CANCELLED",
      reason: "cancelled",
      now: settlementAt,
    });
    expect(cancelled).toMatchObject({
      terminalEventEmitted: true,
      execution: {
        phase: "CANCELLED",
        terminalCode: "cancelled",
        cancelRequestedAt: settlementAt,
        casRevision: created.execution.casRevision + 1,
      },
    });
    const terminalSnapshot = db.query(
      "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id);
    expect(terminalSnapshot).toEqual({
      state: "CANCELLED",
      terminal_code: "cancelled",
      cancel_requested_at: settlementAt,
      terminal_at: settlementAt,
      updated_at: settlementAt,
      cas_revision: created.execution.casRevision + 1,
    });
    expect(expireTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      now: settlementAt + 1_000,
    })).toMatchObject({ code: "already_terminal", execution: { cancelRequestedAt: settlementAt } });
    expect(db.query(
      "SELECT state, terminal_code, cancel_requested_at, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id)).toEqual(terminalSnapshot);
  });

  test("terminal owner emits once and cannot transition again", () => {
    const created = newExecution(db, "terminal");
    const first = transition(db, "terminal", created.ownerToken, "ASSEMBLE", "FAILED");
    expect(first.terminalEventEmitted).toBe(true);
    expect(() => transition(db, "terminal", created.ownerToken, "FAILED", "WORK")).toThrow("already_terminal");
    expect(reconcileAgentTurns(db).failedInterrupted).toBe(0);
  });
});

describe("receipt commit and startup recovery", () => {
  test("binds receipt workspace and target identity to the immutable execution", () => {
    const workspaceMismatch = newExecution(db, "receipt-workspace-mismatch");
    moveToCommit(db, "receipt-workspace-mismatch", workspaceMismatch.ownerToken);
    expect(() => finalizeTurnCommit({
      db,
      executionId: "receipt-workspace-mismatch",
      ownerToken: workspaceMismatch.ownerToken,
      workspaceId: "different-workspace",
    })).toThrow("receipt workspace");
    expect((db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts").get() as { count: number }).count).toBe(0);

    const targeted = createTurnExecution({
      id: "receipt-target-mismatch",
      userId: "u1",
      chatId: "c1",
      generationId: "receipt-target-generation",
      target: { kind: "swipe", messageId: "message-1", swipeId: 1 },
      targetChatRevision: 0,
      mode: "agentic",
      workspaceId: "ws1",
      deadlineAt: Date.now() + 60_000,
      expiresAt: Date.now() + 120_000,
    }, db);
    moveToCommit(db, "receipt-target-mismatch", targeted.ownerToken);
    expect(() => finalizeTurnCommit({
      db,
      executionId: "receipt-target-mismatch",
      ownerToken: targeted.ownerToken,
      messageId: "message-2",
      swipeId: 1,
    })).toThrow("receipt message or swipe");
  });
  test("duplicate commit returns the receipt without a second write", () => {
    const created = newExecution(db, "duplicate");
    moveToCommit(db, "duplicate", created.ownerToken);
    const first = finalizeTurnCommit({ db, executionId: "duplicate", ownerToken: created.ownerToken, summary: { count: 1 } });
    const second = finalizeTurnCommit({ db, executionId: "duplicate", ownerToken: created.ownerToken, summary: { count: 2 } });
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect((db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts").get() as { count: number }).count).toBe(1);
  });

  test("a statement failure rolls back the receipt and settles COMMIT_FAILED", () => {
    const created = newExecution(db, "statement-failure");
    moveToCommit(db, "statement-failure", created.ownerToken);

    db.run(`CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_turn_commit_receipts BEGIN SELECT RAISE(ABORT, 'injected statement failure'); END`);
    expect(() => finalizeTurnCommit({ db, executionId: "statement-failure", ownerToken: created.ownerToken })).toThrow();
    const state = db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("statement-failure") as { state: string };
    expect(state.state).toBe("COMMIT_FAILED");
    expect((db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts").get() as { count: number }).count).toBe(0);
  });

  test("receipt-only crash repair commits without replaying provider work", () => {
    const created = newExecution(db, "receipt-crash");
    moveToCommit(db, "receipt-crash", created.ownerToken);
    db.query(`INSERT INTO agent_turn_commit_receipts
      (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id, commit_key, idempotency_key, state, summary_digest, summary_json, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`)
      .run("receipt-1", "receipt-crash", "receipt-crash", created.execution.workspaceId, "u1", "c1", created.commitKey, created.commitKey, "0".repeat(64), "{}", Date.now());
    const recovered = reconcileAgentTurns(db);
    expect(recovered.committedFromReceipt).toBe(1);
    expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("receipt-crash") as { state: string }).state).toBe("COMMITTED");
    expect(reconcileAgentTurns(db).committedFromReceipt).toBe(0);
  });
  test("fences a crash after terminal transition close until specialized final render commits exactly once", () => {
    createTerminalRecoverySchema(db);
    createWorkSegmentRecoverySchema(db);
    const created = newExecution(db, "closed-work-handoff-crash");
    transition(db, created.execution.id, created.ownerToken, "ASSEMBLE", "WORK");
    seedClosedWorkSegmentCrash(db, created.execution.id, "work_complete");
    const before = getTurnExecution(created.execution.id, "u1", db);

    let genericTerminalPublishes = 0;
    registerAgentTurnTerminalRecovery(() => {
      genericTerminalPublishes++;
    });
    const first = reconcileAgentTurns(db);
    const second = reconcileAgentTurns(db);
    expect(first).toMatchObject({ complete: false, failedInterrupted: 0, claimed: 0 });
    expect(second).toMatchObject({ complete: false, failedInterrupted: 0, claimed: 0 });
    expect(getTurnExecution(created.execution.id, "u1", db)).toEqual(before);
    expect(genericTerminalPublishes).toBe(0);
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?",
    ).get(created.execution.id) as { count: number }).count).toBe(0);

    transition(db, created.execution.id, created.ownerToken, "WORK", "COMPLETE");
    transition(db, created.execution.id, created.ownerToken, "COMPLETE", "RENDER");
    transition(db, created.execution.id, created.ownerToken, "RENDER", "PREPARE_COMMIT");
    beginTurnCommit({ db, executionId: created.execution.id, ownerToken: created.ownerToken });
    const committed = finalizeTurnCommit({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      receiptId: "closed-work-handoff-receipt",
      idempotencyKey: created.commitKey,
      summary: { recovered: true },
    });
    const duplicate = finalizeTurnCommit({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      receiptId: "closed-work-handoff-receipt",
      idempotencyKey: created.commitKey,
      summary: { recovered: true },
    });
    expect(committed.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.receipt.id).toBe(committed.receipt.id);
    expect(duplicate.execution.terminalEventId).toBeNull();
    expect(committed.execution.phase).toBe("COMMITTED");
    expect(committed.execution.terminalEventId).toBeNull();
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?",
    ).get(created.execution.id) as { count: number }).count).toBe(1);

    registerAgentTurnReceiptRepair((execution, receipt, options) => {
      repairAgentRunProjectionFromReceipt(db, execution, receipt, options);
    });
    const afterRecovery = reconcileAgentTurns(db);
    expect(afterRecovery).toMatchObject({ failedInterrupted: 0, projectionRepairs: 1 });
    const convergedTerminalEventId = getTurnExecution(created.execution.id, "u1", db)?.terminalEventId;
    expect(convergedTerminalEventId).not.toBeNull();
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
    ).get("u1", created.execution.id) as { count: number }).count).toBe(1);

    expect(reconcileAgentTurns(db).projectionRepairs).toBe(0);
    expect(getTurnExecution(created.execution.id, "u1", db)?.terminalEventId)
      .toBe(convergedTerminalEventId);
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?",
    ).get(created.execution.id) as { count: number }).count).toBe(1);
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
    ).get("u1", created.execution.id) as { count: number }).count).toBe(1);
    expect(genericTerminalPublishes).toBe(0);
  });

  test("converges crashes after terminal close to exact typed causes and publishes each once", () => {
    createTerminalRecoverySchema(db);
    createWorkSegmentRecoverySchema(db);
    const cases = [
      {
        id: "closed-work-failed-crash",
        result: "failed" as const,
        phase: "FAILED" as const,
        reason: "restart_existing_dispatch_no_replay",
        outcome: "failed",
      },
      {
        id: "closed-work-exhausted-crash",
        result: "exhausted" as const,
        phase: "EXHAUSTED" as const,
        reason: "attempt_budget_exhausted",
        outcome: "exhausted",
      },
      {
        id: "closed-work-cancelled-crash",
        result: "cancelled" as const,
        phase: "CANCELLED" as const,
        reason: "restart_resume_cancel_requested",
        outcome: "stopped",
      },
    ];
    for (const recovery of cases) {
      const created = newExecution(db, recovery.id);
      transition(db, created.execution.id, created.ownerToken, "ASSEMBLE", "WORK");
      seedClosedWorkSegmentCrash(db, recovery.id, recovery.result, recovery.reason);
    }

    let interruptedFallbackPublishes = 0;
    registerAgentTurnTerminalRecovery(() => {
      interruptedFallbackPublishes++;
    });
    const first = reconcileAgentTurns(db);
    expect(first).toMatchObject({ complete: true, failedInterrupted: 0, projectionRepairs: cases.length });
    expect(interruptedFallbackPublishes).toBe(0);
    const terminalEventIds = new Map<string, string | null>();
    for (const recovery of cases) {
      const execution = getTurnExecution(recovery.id, "u1", db);
      expect(execution).toMatchObject({
        phase: recovery.phase,
        terminalCode: recovery.phase === "CANCELLED" ? "cancelled" : recovery.reason,
        workOutcome: recovery.outcome,
      });
      terminalEventIds.set(recovery.id, execution?.terminalEventId ?? null);
      expect(execution?.terminalEventId).not.toBeNull();
      expect(db.query(
        "SELECT status, phase FROM agent_run_projections WHERE user_id = ? AND turn_id = ?",
      ).get("u1", recovery.id)).toEqual({ status: recovery.phase, phase: recovery.phase });
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
      ).get("u1", recovery.id) as { count: number }).count).toBe(1);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_run_attempts WHERE user_id = ? AND turn_id = ? AND terminal = 1",
      ).get("u1", recovery.id) as { count: number }).count).toBe(1);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?",
      ).get(recovery.id) as { count: number }).count).toBe(0);
    }

    const second = reconcileAgentTurns(db);
    expect(second).toMatchObject({ complete: true, failedInterrupted: 0, projectionRepairs: 0 });
    expect(interruptedFallbackPublishes).toBe(0);
    for (const recovery of cases) {
      expect(getTurnExecution(recovery.id, "u1", db)?.terminalEventId)
        .toBe(terminalEventIds.get(recovery.id));
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
      ).get("u1", recovery.id) as { count: number }).count).toBe(1);
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?",
      ).get(recovery.id) as { count: number }).count).toBe(0);
    }
  });

  test("WORK-close recovery preserves boolean markers accepted immediately before terminal UPDATE", () => {
    const cases = [
      { closeResult: "failed" as const, segmentPhase: "FAILED", cause: "stop" as const },
      { closeResult: "exhausted" as const, segmentPhase: "EXHAUSTED", cause: "timeout" as const },
    ];
    for (const scenario of cases) {
      const raceDb = createExecutionSchema();
      try {
        createTerminalRecoverySchema(raceDb);
        createWorkSegmentRecoverySchema(raceDb);
        const deadlineAt = Date.now() + 10_000;
        const markerAt = scenario.cause === "stop" ? deadlineAt - 1 : deadlineAt;
        const settlementAt = deadlineAt + 1_000;
        const executionId = `closed-work-boolean-marker-race-${scenario.cause}`;
        const created = newExecution(raceDb, executionId, deadlineAt);
        const working = transition(
          raceDb, executionId, created.ownerToken, "ASSEMBLE", "WORK",
        ).execution;
        seedClosedWorkSegmentCrash(
          raceDb,
          executionId,
          scenario.closeResult,
          scenario.closeResult === "failed" ? "restart_existing_dispatch_no_replay" : "attempt_budget_exhausted",
        );
        raceDb.run("ALTER TABLE agent_turn_executions RENAME COLUMN cancel_requested_at TO cancel_requested");
        let injected = false;
        let acceptedCode: string | undefined;
        const competingDb = new Proxy(raceDb, {
          get(target, property) {
            if (property !== "query") {
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            }
            return (sql: string) => {
              const statement = target.query(sql);
              if (injected
                || !sql.startsWith('UPDATE "agent_turn_executions" SET')
                || !sql.includes('"terminal_code" = ?')
                || !sql.includes('COALESCE("cancel_requested", 0) = 0')) return statement;
              return new Proxy(statement, {
                get(statementTarget, statementProperty) {
                  if (statementProperty !== "run") {
                    const value = Reflect.get(statementTarget, statementProperty, statementTarget);
                    return typeof value === "function" ? value.bind(statementTarget) : value;
                  }
                  return (...bindings: Parameters<(typeof statementTarget)["run"]>) => {
                    injected = true;
                    acceptedCode = requestActiveTurnCancellation({
                      db: target,
                      executionId,
                      ownerToken: created.ownerToken,
                      reason: scenario.cause === "stop" ? "stopped" : "timed_out",
                      now: markerAt,
                    }).code;
                    return statementTarget.run(...bindings);
                  };
                },
              });
            };
          },
        });

        __testing.setReconciliationClock(() => settlementAt);
        const first = reconcileAgentTurns(competingDb);
        expect(first).toMatchObject({ complete: true, failedInterrupted: 0, projectionRepairs: 1 });
        expect(injected).toBe(true);
        expect(acceptedCode).toBe(scenario.cause === "stop" ? "cancelled" : "timed_out");
        const expected = {
          state: scenario.cause === "stop" ? "CANCELLED" : "TIMED_OUT",
          terminal_code: scenario.cause === "stop" ? "cancelled" : "root_wall_clock_limit_exceeded",
          cancel_requested: 1,
          terminal_at: settlementAt,
          updated_at: markerAt,
          cas_revision: working.casRevision + 1,
        };
        const terminal = raceDb.query(
          "SELECT state, terminal_code, cancel_requested, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
        ).get(executionId);
        expect(terminal).toEqual(expected);
        expect(terminal).not.toMatchObject({ state: scenario.segmentPhase });
        expect((raceDb.query(
          "SELECT COUNT(*) AS count FROM agent_chat_events WHERE user_id = ? AND turn_id = ? AND event_kind = 'terminal'",
        ).get("u1", executionId) as { count: number }).count).toBe(1);
        expect(reconcileAgentTurns(competingDb)).toMatchObject({ projectionRepairs: 0 });
        expect(raceDb.query(
          "SELECT state, terminal_code, cancel_requested, terminal_at, updated_at, cas_revision FROM agent_turn_executions WHERE id = ?",
        ).get(executionId)).toEqual(expected);
      } finally {
        __testing.setReconciliationClock(null);
        raceDb.close();
      }
    }
  });
  test("converges a pre-WORK runtime admission failure to rejected inspection and projection authority", () => {
    createTerminalRecoverySchema(db);
    const created = newExecution(db, "runtime-admission-terminal");
    transitionTurnExecution({
      db,
      executionId: created.execution.id,
      ownerToken: created.ownerToken,
      expectedPhase: "ASSEMBLE",
      nextPhase: "FAILED",
      reason: "agentic_runtime_unavailable",
    });

    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(true);
    const inspection = db.query(
      "SELECT lifecycle, status, outcome, reason, terminal FROM agent_run_attempts WHERE turn_id = ?",
    ).get(created.execution.id) as {
      lifecycle: string;
      status: string;
      outcome: string;
      reason: string;
      terminal: number;
    };
    expect(inspection).toEqual({
      lifecycle: "TERMINAL",
      status: "terminal",
      outcome: "rejected",
      reason: "invalid_input",
      terminal: 1,
    });

    const projection = db.query(
      "SELECT status, phase, snapshot_json FROM agent_run_projections WHERE turn_id = ?",
    ).get(created.execution.id) as { status: string; phase: string; snapshot_json: string };
    expect({
      status: projection.status,
      phase: projection.phase,
      snapshot: JSON.parse(projection.snapshot_json),
    }).toMatchObject({
      status: "FAILED",
      phase: "FAILED",
      snapshot: {
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "rejected",
        reason: "invalid_input",
        error: { code: "invalid_input", workOutcome: "rejected" },
      },
    });
  });

  test("accepts canonical historical terminal outcome with a status-only projection schema", () => {
    const created = newExecution(db, "legacy-terminal-outcome")
    transition(db, created.execution.id, created.ownerToken, "ASSEMBLE", "FAILED")
    db.run(`
      CREATE TABLE agent_run_attempts (
        user_id TEXT NOT NULL, chat_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
        run_id TEXT NOT NULL, turn_id TEXT NOT NULL, generation_id TEXT NOT NULL,
        generation_type TEXT NOT NULL, target_message_id TEXT, target_swipe_id INTEGER,
        status TEXT NOT NULL, outcome TEXT, reason TEXT NOT NULL, terminal INTEGER NOT NULL,
        started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, terminal_at INTEGER,
        host_correlation_id TEXT NOT NULL, reconciliation_state TEXT NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE agent_run_projections (
        user_id TEXT, chat_id TEXT, turn_id TEXT, generation_id TEXT, generation_type TEXT,
        target_message_id TEXT, target_swipe_id INTEGER, status TEXT,
        sequence INTEGER, revision INTEGER, snapshot_json TEXT, started_at INTEGER, updated_at INTEGER,
        terminal_handoff_json TEXT, omission_json TEXT
      )
    `)
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, sequence, revision,
      snapshot_json, started_at, updated_at, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL)`)
      .run(
        "u1", "c1", created.execution.id, created.execution.generationId, "normal",
        "FAILED", 0, 0,
        JSON.stringify({
          workPhase: "TERMINAL",
          workStatus: "terminal",
          workOutcome: "rejected",
          reason: "invalid_input",
          error: { code: "invalid_input" },
        }),
        Date.now(), Date.now(),
      )
    expect((db.query("PRAGMA table_info(agent_run_projections)").all() as { name: string }[])
      .some((column) => column.name === "phase")).toBe(false);
    db.run(`
      CREATE TABLE agent_chat_events (
        user_id TEXT, chat_id TEXT, turn_id TEXT, sequence INTEGER,
        run_revision INTEGER, event_kind TEXT, started_at INTEGER, updated_at INTEGER
      )
    `)
    db.run(`
      CREATE TABLE agent_run_audit_records (
        record_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL, event_id TEXT, host_sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `)
    db.run("CREATE TABLE chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)")
    db.query("INSERT INTO chats (id, user_id, started_at, updated_at) VALUES (?, ?, ?, ?)").run("c1", "u1", Date.now(), Date.now())
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
      .run(
        "u1", "c1", created.execution.id, created.execution.generationId, created.execution.id,
        created.execution.generationId, "normal", "terminal", "rejected", "needs_attention",
        Date.now(), Date.now(), Date.now(), `agentic:${created.execution.id}`, "authoritative",
      )
    db.query(`INSERT INTO agent_run_audit_records (
      record_id, user_id, chat_id, attempt_id, event_id, host_sequence, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        "audit-legacy-terminal-outcome", "u1", "c1", created.execution.id,
        `terminal:failure:${created.execution.id}`, 1, JSON.stringify({
          correlation: { attemptId: created.execution.id, messageId: null, swipeId: null },
          result: { status: "rejected", phase: "FAILED", errorCode: "agentic_preflight_failed" },
          errorReason: "needs_attention",
        }),
      )
    let runnerCalls = 0
    registerAgentTurnTerminalRecovery(() => { runnerCalls++ })
    try {
      const recovered = reconcileAgentTurns(db)
      expect(recovered.complete).toBe(true)
      expect(recovered.alreadyTerminal).toBe(1)
      expect(recovered.projectionRepairs).toBe(0)
      expect(runnerCalls).toBe(0)
    } finally {
      registerAgentTurnTerminalRecovery(null)
    }
  })
  test("uses typed legacy aliases when canonical execution columns are null", () => {
    createTerminalRecoverySchema(db);
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN message_id TEXT");
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN swipe_id INTEGER");
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN error_code TEXT");
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN target_snapshot_json BLOB");
    db.run("ALTER TABLE agent_turn_executions ADD COLUMN target_snapshot TEXT");
    db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, swipes TEXT NOT NULL)");
    db.query("INSERT INTO messages (id, chat_id, swipes) VALUES (?, ?, ?)")
      .run("legacy-message", "c1", JSON.stringify(["legacy swipe"]));

    const created = newExecution(db, "typed-legacy-terminal");
    transition(db, created.execution.id, created.ownerToken, "ASSEMBLE", "FAILED");
    const attemptId = "legacy-attempt-id";
    const targetSnapshot = JSON.stringify({
      attemptLineage: {
        attemptId,
        previousAttemptId: null,
        createdAt: created.execution.createdAt,
      },
    });
    const ignoredBlobSnapshot = new TextEncoder().encode(JSON.stringify({
      attemptLineage: { attemptId: "blob-decoy-attempt" },
    }));
    db.query(`UPDATE agent_turn_executions
      SET target_message_id = NULL, message_id = ?,
          target_swipe_id = NULL, swipe_id = ?,
          terminal_code = NULL, error_code = ?,
          target_snapshot_json = ?, target_snapshot = ?
      WHERE id = ?`)
      .run("legacy-message", 0, "invalid_input", ignoredBlobSnapshot, targetSnapshot, created.execution.id);
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'terminal', 'rejected', 'invalid_input', 1, ?, ?, ?, ?, 'recovered')`)
      .run(
        "u1",
        "c1",
        attemptId,
        created.execution.generationId,
        created.execution.id,
        created.execution.generationId,
        "normal",
        "legacy-message",
        0,
        created.execution.createdAt,
        created.execution.updatedAt,
        created.execution.updatedAt,
        `agentic:${created.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'normal', ?, ?, 'FAILED', 'FAILED', 1, 1, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        created.execution.id,
        created.execution.generationId,
        "legacy-message",
        0,
        created.execution.createdAt,
        created.execution.updatedAt,
        JSON.stringify({ workOutcome: "rejected" }),
        "{}",
      );

    expect((db.query(
      "SELECT typeof(target_snapshot_json) AS type FROM agent_turn_executions WHERE id = ?",
    ).get(created.execution.id) as { type: string }).type).toBe("blob");
    const decoded = getTurnExecution(created.execution.id, undefined, db);
    if (!decoded) {
      throw new Error("expected typed legacy execution to remain readable");
    }
    expect(decoded.targetMessageId).toBe("legacy-message");
    expect(decoded.targetSwipeId).toBe(0);
    expect(decoded.terminalCode).toBe("invalid_input");
    expect(decoded.workOutcome).toBe("rejected");
    expect(decoded.attemptLineage.attemptId).toBe(attemptId);
    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(true);
    expect(recovered.inspected).toBe(0);
    expect(recovered.alreadyTerminal).toBe(0);
  });

  test("does not hide JavaScript-only normalization boundaries from reconciliation", () => {
    createTerminalRecoverySchema(db);
    db.run("CREATE TABLE messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, swipes BLOB NOT NULL)");
    const textSnapshot = JSON.stringify({ workOutcome: "failed" });
    const snapshotBlob = new TextEncoder().encode(textSnapshot);
    const swipesBlob = new TextEncoder().encode(JSON.stringify(["blob swipe"]));
    db.query("INSERT INTO messages (id, chat_id, swipes) VALUES (?, ?, ?)")
      .run("blob-message", "c1", swipesBlob);
    db.query("INSERT INTO messages (id, chat_id, swipes) VALUES (?, ?, ?)")
      .run("fractional-message", "c1", JSON.stringify(["only swipe"]));

    const projectionBlob = newExecution(db, "blob-projection-terminal");
    transition(db, projectionBlob.execution.id, projectionBlob.ownerToken, "ASSEMBLE", "FAILED");
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, 'normal', NULL, NULL, 'terminal', 'failed', 'interrupted', 1, ?, ?, ?, ?, 'authoritative')`)
      .run(
        "u1",
        "c1",
        projectionBlob.execution.id,
        projectionBlob.execution.generationId,
        projectionBlob.execution.id,
        projectionBlob.execution.generationId,
        projectionBlob.execution.createdAt,
        projectionBlob.execution.updatedAt,
        projectionBlob.execution.updatedAt,
        `agentic:${projectionBlob.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'normal', NULL, NULL, 'FAILED', 'FAILED', 1, 1, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        projectionBlob.execution.id,
        projectionBlob.execution.generationId,
        projectionBlob.execution.createdAt,
        projectionBlob.execution.updatedAt,
        snapshotBlob,
        "{}",
      );

    const messageBlob = createTurnExecution({
      id: "blob-message-terminal",
      userId: "u1",
      chatId: "c1",
      generationId: "blob-message-generation",
      target: { kind: "swipe", messageId: "blob-message", swipeId: 0 },
      targetChatRevision: 0,
      mode: "agentic",
      workspaceId: "ws1",
      deadlineAt: Date.now() + 60_000,
      expiresAt: Date.now() + 120_000,
    }, db);
    transition(db, messageBlob.execution.id, messageBlob.ownerToken, "ASSEMBLE", "FAILED");
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, 'swipe', ?, 0, 'terminal', 'failed', 'interrupted', 1, ?, ?, ?, ?, 'authoritative')`)
      .run(
        "u1",
        "c1",
        messageBlob.execution.id,
        messageBlob.execution.generationId,
        messageBlob.execution.id,
        messageBlob.execution.generationId,
        "blob-message",
        messageBlob.execution.createdAt,
        messageBlob.execution.updatedAt,
        messageBlob.execution.updatedAt,
        `agentic:${messageBlob.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'swipe', ?, 0, 'FAILED', 'FAILED', 1, 2, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        messageBlob.execution.id,
        messageBlob.execution.generationId,
        "blob-message",
        messageBlob.execution.createdAt,
        messageBlob.execution.updatedAt,
        textSnapshot,
        "{}",
      );
    const fractional = createTurnExecution({
      id: "fractional-swipe-terminal",
      userId: "u1",
      chatId: "c1",
      generationId: "fractional-swipe-generation",
      target: { kind: "swipe", messageId: "fractional-message", swipeId: 0 },
      targetChatRevision: 0,
      mode: "agentic",
      workspaceId: "ws1",
      deadlineAt: Date.now() + 60_000,
      expiresAt: Date.now() + 120_000,
    }, db);
    transition(db, fractional.execution.id, fractional.ownerToken, "ASSEMBLE", "FAILED");
    db.query("UPDATE agent_turn_executions SET target_swipe_id = ? WHERE id = ?")
      .run(0.5, fractional.execution.id);
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, 'swipe', ?, ?, 'terminal', 'failed', 'interrupted', 1, ?, ?, ?, ?, 'authoritative')`)
      .run(
        "u1",
        "c1",
        fractional.execution.id,
        fractional.execution.generationId,
        fractional.execution.id,
        fractional.execution.generationId,
        "fractional-message",
        0.5,
        fractional.execution.createdAt,
        fractional.execution.updatedAt,
        fractional.execution.updatedAt,
        `agentic:${fractional.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'swipe', ?, ?, 'FAILED', 'FAILED', 1, 3, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        fractional.execution.id,
        fractional.execution.generationId,
        "fractional-message",
        0.5,
        fractional.execution.createdAt,
        fractional.execution.updatedAt,
        textSnapshot,
        "{}",
      );
    const tabWrapped = newExecution(db, "tab-wrapped-terminal-code");
    transition(db, tabWrapped.execution.id, tabWrapped.ownerToken, "ASSEMBLE", "FAILED");
    db.query("UPDATE agent_turn_executions SET terminal_code = ? WHERE id = ?")
      .run("\tinvalid_input\t", tabWrapped.execution.id);
    db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, run_id, turn_id, generation_id, generation_type,
      target_message_id, target_swipe_id, status, outcome, reason, terminal,
      started_at, updated_at, terminal_at, host_correlation_id, reconciliation_state
    ) VALUES (?, ?, ?, ?, ?, ?, 'normal', NULL, NULL, 'terminal', 'failed', 'interrupted', 1, ?, ?, ?, ?, 'authoritative')`)
      .run(
        "u1",
        "c1",
        tabWrapped.execution.id,
        tabWrapped.execution.generationId,
        tabWrapped.execution.id,
        tabWrapped.execution.generationId,
        tabWrapped.execution.createdAt,
        tabWrapped.execution.updatedAt,
        tabWrapped.execution.updatedAt,
        `agentic:${tabWrapped.execution.id}`,
      );
    db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, ?, ?, ?, 'normal', NULL, NULL, 'FAILED', 'FAILED', 1, 4, ?, ?, ?, NULL, ?)`)
      .run(
        "u1",
        "c1",
        tabWrapped.execution.id,
        tabWrapped.execution.generationId,
        tabWrapped.execution.createdAt,
        tabWrapped.execution.updatedAt,
        textSnapshot,
        "{}",
      );

    expect((db.query(
      "SELECT typeof(snapshot_json) AS type FROM agent_run_projections WHERE turn_id = ?",
    ).get(projectionBlob.execution.id) as { type: string }).type).toBe("blob");
    expect((db.query(
      "SELECT typeof(swipes) AS type FROM messages WHERE id = ?",
    ).get("blob-message") as { type: string }).type).toBe("blob");
    expect((db.query(
      "SELECT typeof(target_swipe_id) AS type FROM agent_turn_executions WHERE id = ?",
    ).get(fractional.execution.id) as { type: string }).type).toBe("real");
    const decodedFractional = getTurnExecution(fractional.execution.id, undefined, db);
    if (!decodedFractional) {
      throw new Error("expected fractional target execution to remain readable");
    }
    expect(decodedFractional.targetSwipeId).toBe(0.5);
    const decodedTabWrapped = getTurnExecution(tabWrapped.execution.id, undefined, db);
    if (!decodedTabWrapped) {
      throw new Error("expected tab-wrapped terminal execution to remain readable");
    }
    expect(decodedTabWrapped.terminalCode).toBe("\tinvalid_input\t");
    expect(decodedTabWrapped.workOutcome).toBe("rejected");
    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(false);
    expect(recovered.inspected).toBe(4);
    expect(recovered.alreadyTerminal).toBe(4);
    expect(recovered.projectionRepairs).toBe(0);
  });
  test("receipt repair failure remains incomplete and converges on retry", () => {
    const created = newExecution(db, "receipt-repair-failure");
    moveToCommit(db, "receipt-repair-failure", created.ownerToken);
    db.query(`INSERT INTO agent_turn_commit_receipts
      (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id, commit_key, idempotency_key, state, summary_digest, summary_json, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`)
      .run(
        "receipt-repair-failure-receipt",
        "receipt-repair-failure",
        "receipt-repair-failure",
        created.execution.workspaceId,
        "u1",
        "c1",
        created.commitKey,
        created.commitKey,
        "0".repeat(64),
        "{}",
        Date.now(),
      );
    registerAgentTurnReceiptRepair(() => {
      throw new Error("injected receipt repair failure");
    });
    try {
      const blocked = reconcileAgentTurns(db);
      expect(blocked.complete).toBe(false);
      expect(blocked.committedFromReceipt).toBe(0);
      expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("receipt-repair-failure") as { state: string }).state).toBe("COMMITTING");
    } finally {
      registerAgentTurnReceiptRepair(null);
    }
    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(true);
    expect(recovered.committedFromReceipt).toBe(1);
    expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("receipt-repair-failure") as { state: string }).state).toBe("COMMITTED");
  });
  test("does not replay expired terminal authority after its retained projection is evicted", () => {
    createTerminalRecoverySchema(db);
    const failed = newExecution(db, "expired-terminal-failure");
    transition(db, failed.execution.id, failed.ownerToken, "ASSEMBLE", "FAILED");
    const committed = newExecution(db, "expired-terminal-commit");
    moveToCommit(db, committed.execution.id, committed.ownerToken);
    finalizeTurnCommit({
      db,
      executionId: committed.execution.id,
      ownerToken: committed.ownerToken,
      summary: {},
    });
    db.query("UPDATE agent_turn_executions SET expires_at = 1 WHERE id IN (?, ?)")
      .run(failed.execution.id, committed.execution.id);

    let receiptRepairCalls = 0;
    registerAgentTurnReceiptRepair(() => {
      receiptRepairCalls++;
      throw new Error("expired terminal receipt must not replay");
    });
    try {
      const recovered = reconcileAgentTurns(db);
      expect(recovered.complete).toBe(true);
      expect(recovered.inspected).toBe(0);
      expect(recovered.alreadyTerminal).toBe(0);
      expect(recovered.projectionRepairs).toBe(0);
      expect(receiptRepairCalls).toBe(0);
      expect((db.query("SELECT COUNT(*) AS count FROM agent_run_projections").get() as { count: number }).count).toBe(0);
    } finally {
      registerAgentTurnReceiptRepair(null);
    }
  });

  test("expires interrupted turns without invoking provider or projection callbacks", async () => {
    let callbackCount = 0;
    registerAgentTurnReceiptRepair(() => {
      callbackCount++;
    });
    try {
      newExecution(db, "expired", Date.now() - 1_000);
      const recovered = reconcileAgentTurns(db);
      await Promise.resolve();
      expect(recovered.failedInterrupted).toBe(1);
      const row = db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("expired") as { state: string };
      expect(row.state).toBe("FAILED");
      expect(callbackCount).toBe(0);
    } finally {
      registerAgentTurnReceiptRepair(null);
    }
  });

  test("a committing row with no receipt becomes COMMIT_FAILED and startup is idempotent", () => {
    const created = newExecution(db, "no-receipt");
    moveToCommit(db, "no-receipt", created.ownerToken);
    const first = reconcileAgentTurns(db);
    expect(first.commitFailedWithoutReceipt).toBe(1);
    expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("no-receipt") as { state: string }).state).toBe("COMMIT_FAILED");
    const second = reconcileAgentTurns(db);
    expect(second.commitFailedWithoutReceipt).toBe(0);
  });
  test("scans only candidates and drains large recoverable history in keyset pages", () => {
    for (let index = 0; index < 300; index += 1) {
      const historical = newExecution(db, `historical-terminal-${index}`);
      transition(db, historical.execution.id, historical.ownerToken, "ASSEMBLE", "FAILED");
    }
    for (let index = 0; index < 300; index += 1) {
      newExecution(db, `recoverable-${index}`);
    }
    const candidateCount = (db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE state IN ('ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING')",
    ).get() as { count: number }).count;
    expect(candidateCount).toBe(300);

    const recovered = reconcileAgentTurns(db);
    expect(recovered.inspected).toBe(300);
    expect(recovered.failedInterrupted).toBe(300);
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE state IN ('ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING')",
    ).get() as { count: number }).count).toBe(0);
  });
  test("skips 2,049 padded failed wall-clock authorities so newer work reaches ready startup", async () => {
    createTerminalRecoverySchema(db);
    const retainedCount = TURN_EXECUTION_RECONCILIATION.maxRows + 1;
    const omissionJson = JSON.stringify({
      omittedNodeCount: 0,
      omittedEventCount: 0,
      firstOmittedSequence: null,
      lastOmittedSequence: null,
    });
    const insertAttempt = db.query(`INSERT INTO agent_run_attempts (
      user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
      generation_id, generation_type, target_message_id, target_swipe_id,
      lifecycle, status, outcome, reason, terminal, started_at, updated_at,
      terminal_at, host_correlation_id, reconciliation_state, created_at
    ) VALUES (?, 'c1', ?, NULL, ?, ?, ?, 'normal', NULL, NULL,
      'TERMINAL', 'terminal', ?, 'interrupted', 1, ?, ?, ?, ?, 'recovered', ?)`);
    const insertProjection = db.query(`INSERT INTO agent_run_projections (
      user_id, chat_id, turn_id, generation_id, generation_type, target_message_id,
      target_swipe_id, status, phase, revision, sequence, started_at, updated_at,
      snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, 'c1', ?, ?, 'normal', NULL, NULL, 'FAILED', 'FAILED', 1, ?, ?, ?, ?, NULL, ?)`);
    const insertEvent = db.query(`INSERT INTO agent_chat_events (
      user_id, chat_id, sequence, turn_id, generation_id, run_revision, status,
      event_kind, snapshot_json, terminal_handoff_json, omission_json
    ) VALUES (?, 'c1', ?, ?, ?, 1, 'FAILED', 'terminal', ?, NULL, ?)`);
    const persistExactTerminal = (
      executionId: string,
      generationId: string,
      sequence: number,
      orderedAt: number,
      settledOutcome = "failed",
    ): void => {
      const snapshot = JSON.stringify({
        version: 2,
        runId: generationId,
        turnId: executionId,
        chatId: "c1",
        generationId,
        generationType: "normal",
        target: null,
        attemptLineage: {
          version: 1,
          attemptId: executionId,
          previousAttemptId: null,
          target: {
            chatId: "c1",
            generationType: "normal",
            messageId: null,
            swipeId: null,
          },
          createdAt: orderedAt,
        },
        revision: 1,
        sequence,
        workPhase: "TERMINAL",
        workStatus: "terminal",
        workOutcome: "failed",
        reason: "failed",
        startedAt: orderedAt,
        updatedAt: orderedAt,
        activity: [],
        terminalHandoff: null,
        omission: JSON.parse(omissionJson),
      });
      insertAttempt.run(
        "u1",
        executionId,
        generationId,
        executionId,
        generationId,
        settledOutcome,
        orderedAt,
        orderedAt,
        orderedAt,
        `agentic:${executionId}`,
        orderedAt,
      );
      insertProjection.run(
        "u1",
        executionId,
        generationId,
        sequence,
        orderedAt,
        orderedAt,
        snapshot,
        omissionJson,
      );
      insertEvent.run("u1", sequence, executionId, generationId, snapshot, omissionJson);
    };

    db.transaction(() => {
      for (let index = 0; index < retainedCount; index += 1) {
        const id = `retained-terminal-${index}`;
        const orderedAt = index + 1;
        const historical = newExecution(db, id);
        transition(db, id, historical.ownerToken, "ASSEMBLE", "FAILED");
        db.query("UPDATE agent_turn_executions SET terminal_code = 'root_wall_clock_limit_exceeded', created_at = ?, updated_at = ? WHERE id = ?")
          .run(orderedAt, orderedAt, id);
        const settledOutcome = index % 2 === 0 ? "\tfailed\t" : "\u00a0failed\u00a0";
        persistExactTerminal(id, historical.execution.generationId, orderedAt, orderedAt, settledOutcome);
      }
    })();

    const interrupted = newExecution(db, "newer-interrupted-work");
    const interruptedAt = retainedCount + 100;
    db.query("UPDATE agent_turn_executions SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(interruptedAt, interruptedAt, interrupted.execution.id);
    persistExactTerminal(
      interrupted.execution.id,
      interrupted.execution.generationId,
      retainedCount + 1,
      interruptedAt,
    );

    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE id LIKE 'retained-terminal-%' AND state = 'FAILED' AND terminal_code = 'root_wall_clock_limit_exceeded'",
    ).get() as { count: number }).count).toBe(retainedCount);
    const paddedOutcomes = db.query(`
      SELECT
        SUM(CASE WHEN outcome = char(9) || 'failed' || char(9) THEN 1 ELSE 0 END) AS tabs,
        SUM(CASE WHEN outcome = char(160) || 'failed' || char(160) THEN 1 ELSE 0 END) AS nbsps
      FROM agent_run_attempts
      WHERE turn_id LIKE 'retained-terminal-%'
    `).get() as { tabs: number; nbsps: number };
    expect(paddedOutcomes.tabs).toBeGreaterThan(0);
    expect(paddedOutcomes.nbsps).toBeGreaterThan(0);
    expect(paddedOutcomes.tabs + paddedOutcomes.nbsps).toBe(retainedCount);

    const previousPreprocessingWorker = process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER;
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER = "true";
    try {
      const startup = await reconcileStartupState(db, {
        reconcileExportStaging: () => ({ inspected: 0, removed: 0, preserved: 0, failures: 0 }),
        reconcileUserDataImports: () => ({
          inspected: 0,
          recovered: 0,
          deferred: 0,
          failed: 0,
          complete: true,
          healthy: true,
        }),
        reconcilePurgeCleanupIntents: () => {},
        reconcileAgentArtifactBlobs: async () => ({
          inspected: 0,
          retained: 0,
          removed: 0,
          stale: 0,
          quarantined: 0,
          bytesRemoved: 0,
        }),
        reconcileWorkSegmentRecovery: () => ({
          scanned: 0, active: 0, closed: 0, queued: 0, reclaimed: 0, fenced: 0, terminalized: 0,
          complete: true, healthy: true,
        }),
        reconcileAgentTurns: (startupDb) => reconcileAgentTurns(startupDb),
        reconcileAgentRunProjections: () => ({
          inspectedProjections: 0,
          removedProjections: 0,
          inspectedWorkspaces: 0,
          removedWorkspaces: 0,
          preservedChatLifetimeEntries: 0,
          failures: 0,
          healthy: true,
          complete: true,
        }),
        probeIsolateBackendsAtStartup: async () => ({
          epoch: 1,
          worker: "healthy",
          subprocess: "unavailable",
          selected: "worker",
          workerReason: null,
          subprocessReason: "not selected",
          checkedAt: Date.now(),
        }),
        installAgenticGenerationCoordinator: () => {},
      });

      expect(startup.turns.complete).toBe(true);
      expect(startup.turns.inspected).toBe(1);
      expect(startup.turns.failedInterrupted).toBe(1);
      expect(startup.turns.alreadyTerminal).toBe(0);
      expect(startup.turns.projectionRepairs).toBe(0);
      expect(startup.stages.turns.ok).toBe(true);
      expect(startup.readiness.reconciliation).toBe(true);
      expect(startup.readiness.reason).toBeNull();
      expect(getAgenticRuntimeStatus().enabled).toBe(true);
      expect((db.query(
        "SELECT state FROM agent_turn_executions WHERE id = 'newer-interrupted-work'",
      ).get() as { state: string }).state).toBe("FAILED");
      expect((db.query(
        "SELECT COUNT(*) AS count FROM agent_turn_executions WHERE id LIKE 'retained-terminal-%' AND state = 'FAILED'",
      ).get() as { count: number }).count).toBe(retainedCount);
      const retainedAuthorityCounts = db.query(`
        SELECT
          (SELECT COUNT(*) FROM agent_run_attempts) AS attempts,
          (SELECT COUNT(*) FROM agent_run_projections) AS projections,
          (SELECT COUNT(*) FROM agent_chat_events) AS events
      `).get() as { attempts: number; projections: number; events: number };
      expect(retainedAuthorityCounts).toEqual({
        attempts: retainedCount + 1,
        projections: retainedCount + 1,
        events: retainedCount + 1,
      });
    } finally {
      if (previousPreprocessingWorker === undefined) {
        delete process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER;
      } else {
        process.env.LUMIVERSE_AGENTIC_PREPROCESSING_WORKER = previousPreprocessingWorker;
      }
    }
  });
  test("stops before an expensive row when the recovery deadline expires", () => {
    const first = newExecution(db, "slow-turn-a");
    const second = newExecution(db, "slow-turn-b");
    db.query("UPDATE agent_turn_executions SET created_at = ?, updated_at = ? WHERE id = ?").run(100, 100, first.execution.id);
    db.query("UPDATE agent_turn_executions SET created_at = ?, updated_at = ? WHERE id = ?").run(200, 200, second.execution.id);
    const clockValues = [1_000, 1_000, 1_000, 6_000];
    let clockIndex = 0;
    __testing.setReconciliationClock(() => clockValues[Math.min(clockIndex++, clockValues.length - 1)]!);
    try {
      const blocked = reconcileAgentTurns(db);
      expect(blocked.complete).toBe(false);
      expect(blocked.failedInterrupted).toBe(1);
      expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get(first.execution.id) as { state: string }).state).toBe("FAILED");
      expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get(second.execution.id) as { state: string }).state).toBe("ASSEMBLE");
      __testing.setReconciliationClock(null);
      const recovered = reconcileAgentTurns(db);
      expect(recovered.complete).toBe(true);
      expect(recovered.failedInterrupted).toBe(1);
      expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get(second.execution.id) as { state: string }).state).toBe("FAILED");
    } finally {
      __testing.setReconciliationClock(null);
    }
  });
  test("caps the startup scan while prioritizing receipt-backed commit recovery", () => {
    db.run(`
      CREATE TABLE agent_run_projections (
        user_id TEXT,
        chat_id TEXT,
        turn_id TEXT,
        status TEXT,
        sequence INTEGER,
        revision INTEGER
      )
    `);
    db.run(`
      CREATE TABLE agent_chat_events (
        user_id TEXT,
        chat_id TEXT,
        turn_id TEXT,
        sequence INTEGER,
        run_revision INTEGER,
        event_kind TEXT
      )
    `);
    const prioritized = newExecution(db, "priority-receipt");
    moveToCommit(db, prioritized.execution.id, prioritized.ownerToken);
    db.query(`INSERT INTO agent_turn_commit_receipts
      (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id, commit_key, idempotency_key, state, summary_digest, summary_json, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?)`)
      .run(
        "priority-receipt-row",
        prioritized.execution.id,
        prioritized.execution.id,
        prioritized.execution.workspaceId,
        "u1",
        "c1",
        prioritized.execution.commitKey,
        prioritized.execution.commitKey,
        "0".repeat(64),
        "{}",
        Date.now(),
      );
    for (let index = 0; index < TURN_EXECUTION_RECONCILIATION.maxRows + 1; index += 1) {
      newExecution(db, `bounded-recoverable-${index}`);
    }

    const recovered = reconcileAgentTurns(db);
    expect(recovered.complete).toBe(false);
    expect(recovered.inspected).toBeLessThanOrEqual(TURN_EXECUTION_RECONCILIATION.maxRows);
    expect(recovered.committedFromReceipt).toBe(1);
    expect((db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("priority-receipt") as { state: string }).state).toBe("COMMITTED");
  });


  test("repairs the legacy stale-decision terminal outcome once and remains restart-idempotent", async () => {
    createTerminalRecoverySchema(db);
    seedLegacyStaleDecisionTerminal(db, "legacy-stale-decision");

    const firstStartup = await replayStartupTurnReconciliation(db);
    const first = firstStartup.turns;
    expect(firstStartup.stages.turns.ok).toBe(true);
    expect(first.complete).toBe(true);
    expect(first.inspected).toBe(1);
    expect(first.projectionRepairs).toBe(1);

    const attempt = db.query(`
      SELECT outcome, reason, reconciliation_state, terminal_receipt_json
      FROM agent_run_attempts WHERE attempt_id = ?
    `).get("legacy-stale-decision") as {
      outcome: string;
      reason: string;
      reconciliation_state: string;
      terminal_receipt_json: string | null;
    };
    expect(attempt).toEqual({
      outcome: "rejected",
      reason: "stale_input",
      reconciliation_state: "recovered",
      terminal_receipt_json: null,
    });
    const projection = db.query(`
      SELECT revision, sequence, snapshot_json
      FROM agent_run_projections WHERE turn_id = ?
    `).get("legacy-stale-decision") as {
      revision: number;
      sequence: number;
      snapshot_json: string;
    };
    const snapshot = JSON.parse(projection.snapshot_json) as {
      revision: number;
      sequence: number;
      inspectionAttemptId: string;
      workOutcome: string;
      reason: string;
      error: { code: string; workOutcome: string };
    };
    expect(projection).toMatchObject({ revision: 2, sequence: 2 });
    expect(snapshot).toMatchObject({
      revision: 2,
      sequence: 2,
      inspectionAttemptId: "legacy-stale-decision",
      workOutcome: "rejected",
      reason: "stale_input",
      error: { code: "decision_refresh_required", workOutcome: "rejected" },
    });
    expect(db.query(`
      SELECT state AS phase, terminal_code FROM agent_turn_executions WHERE id = ?
    `).get("legacy-stale-decision")).toEqual({
      phase: "FAILED",
      terminal_code: "decision_refresh_required",
    });
    expect((db.query(`
      SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?
    `).get("legacy-stale-decision") as { count: number }).count).toBe(0);
    const events = db.query(`
      SELECT sequence, run_revision, snapshot_json
      FROM agent_chat_events WHERE turn_id = ? ORDER BY sequence
    `).all("legacy-stale-decision") as Array<{
      sequence: number;
      run_revision: number;
      snapshot_json: string;
    }>;
    expect(events.map((event) => ({
      sequence: event.sequence,
      revision: event.run_revision,
      outcome: (JSON.parse(event.snapshot_json) as { workOutcome: string }).workOutcome,
    }))).toEqual([
      { sequence: 1, revision: 1, outcome: "failed" },
      { sequence: 2, revision: 2, outcome: "rejected" },
    ]);

    const secondStartup = await replayStartupTurnReconciliation(db);
    const second = secondStartup.turns;
    expect(secondStartup.stages.turns.ok).toBe(true);
    expect(second.complete).toBe(true);
    expect(second.inspected).toBe(0);
    expect(second.projectionRepairs).toBe(0);
    const replayedProjection = db.query(`
      SELECT revision, sequence, snapshot_json
      FROM agent_run_projections WHERE turn_id = ?
    `).get("legacy-stale-decision") as typeof projection;
    expect(replayedProjection).toEqual(projection);
    expect((db.query(`
      SELECT COUNT(*) AS count FROM agent_chat_events WHERE turn_id = ?
    `).get("legacy-stale-decision") as { count: number }).count).toBe(2);
  });

  test("repairs the premature generic FAILED projection from a canonical invalid-input rejection", async () => {
    createTerminalRecoverySchema(db);
    seedLegacyPrematureFailedProjection(db, "legacy-premature-failed-projection");

    const firstStartup = await replayStartupTurnReconciliation(db);
    expect(firstStartup.stages.turns.ok).toBe(true);
    expect(firstStartup.turns).toMatchObject({
      complete: true,
      inspected: 1,
      projectionRepairs: 1,
    });
    expect(db.query(
      "SELECT outcome, reason, reconciliation_state FROM agent_run_attempts WHERE attempt_id = ?",
    ).get("legacy-premature-failed-projection")).toEqual({
      outcome: "rejected",
      reason: "invalid_input",
      reconciliation_state: "recovered",
    });
    const projection = db.query(
      "SELECT revision, sequence, snapshot_json FROM agent_run_projections WHERE turn_id = ?",
    ).get("legacy-premature-failed-projection") as {
      revision: number;
      sequence: number;
      snapshot_json: string;
    };
    expect(projection).toMatchObject({ revision: 2, sequence: 2 });
    expect(JSON.parse(projection.snapshot_json)).toMatchObject({
      workOutcome: "rejected",
      reason: "invalid_input",
      error: { code: "invalid_input", workOutcome: "rejected" },
    });
    expect(db.query(
      "SELECT state AS phase, terminal_code FROM agent_turn_executions WHERE id = ?",
    ).get("legacy-premature-failed-projection")).toEqual({
      phase: "FAILED",
      terminal_code: "invalid_input",
    });
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?",
    ).get("legacy-premature-failed-projection") as { count: number }).count).toBe(0);
    const outcomes = db.query(
      "SELECT snapshot_json FROM agent_chat_events WHERE turn_id = ? ORDER BY sequence",
    ).all("legacy-premature-failed-projection") as Array<{ snapshot_json: string }>;
    expect(outcomes.map((event) => (
      JSON.parse(event.snapshot_json) as { workOutcome: string }
    ).workOutcome)).toEqual(["failed", "rejected"]);

    const secondStartup = await replayStartupTurnReconciliation(db);
    expect(secondStartup.stages.turns.ok).toBe(true);
    expect(secondStartup.turns).toMatchObject({
      complete: true,
      inspected: 0,
      projectionRepairs: 0,
    });
    expect(db.query(
      "SELECT revision, sequence, snapshot_json FROM agent_run_projections WHERE turn_id = ?",
    ).get("legacy-premature-failed-projection")).toEqual(projection);
  });

  test("leaves near-match FAILED projections immutable when the historical defect shape differs", async () => {
    createTerminalRecoverySchema(db);
    seedLegacyPrematureFailedProjection(db, "unrelated-premature-failed-projection");
    const row = db.query(
      "SELECT snapshot_json FROM agent_run_projections WHERE turn_id = ?",
    ).get("unrelated-premature-failed-projection") as { snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as { reason: string };
    snapshot.reason = "provider_failure";
    db.query("UPDATE agent_run_projections SET snapshot_json = ? WHERE turn_id = ?")
      .run(JSON.stringify(snapshot), "unrelated-premature-failed-projection");
    const before = db.query(
      "SELECT revision, sequence, snapshot_json FROM agent_run_projections WHERE turn_id = ?",
    ).get("unrelated-premature-failed-projection");

    const startup = await replayStartupTurnReconciliation(db);
    expect(startup.stages.turns.ok).toBe(false);
    expect(startup.turns).toMatchObject({ complete: false, projectionRepairs: 0 });
    expect(db.query(
      "SELECT revision, sequence, snapshot_json FROM agent_run_projections WHERE turn_id = ?",
    ).get("unrelated-premature-failed-projection")).toEqual(before);
    expect((db.query(
      "SELECT COUNT(*) AS count FROM agent_chat_events WHERE turn_id = ?",
    ).get("unrelated-premature-failed-projection") as { count: number }).count).toBe(1);
  });

  test("leaves unrelated terminal mismatches immutable and fails startup closed", async () => {
    createTerminalRecoverySchema(db);
    seedLegacyStaleDecisionTerminal(db, "unrelated-terminal-mismatch");
    db.query(`
      UPDATE agent_run_attempts SET outcome = 'completed' WHERE attempt_id = ?
    `).run("unrelated-terminal-mismatch");
    const beforeProjection = db.query(`
      SELECT revision, sequence, snapshot_json
      FROM agent_run_projections WHERE turn_id = ?
    `).get("unrelated-terminal-mismatch");

    const startup = await replayStartupTurnReconciliation(db);
    const result = startup.turns;
    expect(startup.stages.turns.ok).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.projectionRepairs).toBe(0);
    expect((db.query(`
      SELECT outcome FROM agent_run_attempts WHERE attempt_id = ?
    `).get("unrelated-terminal-mismatch") as { outcome: string }).outcome).toBe("completed");
    expect(db.query(`
      SELECT revision, sequence, snapshot_json
      FROM agent_run_projections WHERE turn_id = ?
    `).get("unrelated-terminal-mismatch")).toEqual(beforeProjection);
    expect((db.query(`
      SELECT COUNT(*) AS count FROM agent_chat_events WHERE turn_id = ?
    `).get("unrelated-terminal-mismatch") as { count: number }).count).toBe(1);
  });
});

describe("dormant runtime kill switch", () => {
  test("off is fail-closed and auto cannot be raised by incomplete readiness", () => {
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "off";
    expect(getAgenticRuntimeStatus().enabled).toBe(false);
    process.env.LUMIVERSE_AGENTIC_RUNTIME = "auto";
    expect(getAgenticRuntimeStatus().mode).toBe("auto");
    expect(getAgenticRuntimeStatus().enabled).toBe(false);
  });
});

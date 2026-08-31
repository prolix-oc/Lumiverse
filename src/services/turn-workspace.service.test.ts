import type { AgenticWorkMutatingWorkspaceOperationKindV1, AgenticWorkWorkspaceMutationReservationV1 } from "../types/agent-work-segment";
import type { CognitionWorkspaceActivationFactoryV1, CognitionWorkspaceCompletionFactoryV1 } from "../types/agent-cognition-runtime";
import type { WorkspaceArtifactReferenceV1, WorkspaceOperationCapabilitiesV1 } from "../types/turn-workspace";
import { deriveCognitionOperationalTaskId, type CognitionActivationResultV1, type CognitionTaskTransition, type TaskTemplateV1 } from "../types/agent-cognition";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { publishArtifactCommit } from "./agent-artifact-blobs.service";
import { requestDormantTurnCancellation } from "./turn-execution.service";
import {
  acceptWorkspaceSubmission,
  getActiveFrameCapabilityCountForTests,
  measureWorkspaceOperationBytesV1,
  WORKSPACE_READ_SECTIONS,
  WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS,
  WORKSPACE_MAX_TASK_ASSIGNMENTS,
  WORKSPACE_OBJECTIVE_MAX_BYTES,
  PERSISTENT_WORKSPACE_MAX_SESSION_OFFSET,
  TurnWorkspaceError,
  assignChildTasks,
  attachWorkspaceArtifactReference,
  createPersistentWorkspace,
  createPersistentWorkspaceHostAuthority,
  createPersistentWorkspaceHostTask,
  createPersistentWorkspaceTask,
  createPersistentWorkspaceHostTurnSession,
  createTurnWorkspace,
  createWorkspaceTask,
  createWorkspaceTaskWithCognition,
  deletePersistentWorkspace,
  deletePersistentWorkspacePublication,
  ensurePersistentWorkspaceForChat,
  ensurePersistentWorkspaceHost,
  freezeWorkspaceForCompletionWithCognition,
  freezeFrameCapabilities,
  freezeTurnWorkspace,
  freezeWorkspaceForCompletionV1,
  getPersistentWorkspace,
  getPersistentWorkspaceById,
  getPersistentWorkspaceForChat,
  getTurnWorkspace,
  getWorkspaceCompletionGatesV1,
  listPersistentWorkspaceArtifacts,
  listPersistentWorkspacePublications,
  listPersistentWorkspaceRecords,
  listPersistentWorkspaceSubmissions,
  listPersistentWorkspaceTasks,
  listPersistentWorkspaceTurnSessions,
  previewWorkspaceForCompletionV1,
  proposeWorkspacePublication,
  publishPersistentWorkspaceSelection,
  publishWorkspaceArtifact,
  recordWorkspaceRecord,
  readTurnWorkspaceSection,
  validateCreateWorkspaceTaskInput,
  validateReadWorkspaceSectionInput,
  setWorkspaceMutationCommitBoundaryHookForTests,
  settleWorkspaceChildTask,
  settleWorkspaceChildTaskWithCognition,
  submitWorkspaceChildResult,
  submitWorkspaceChildResultWithCognition,
  submitWorkspaceRootResult,
  submitWorkspaceRootResultWithCognition,
  updatePersistentWorkspaceHostTurnSession,
  updateWorkspaceTaskProgress,
  updateWorkspaceTaskProgressWithCognition,
  updateWorkspaceTaskPolicy,
  type WorkspaceErrorCode,
} from "./turn-workspace.service";
import * as workspaceService from "./turn-workspace.service";

const USER = "workspace-user";
const OTHER_USER = "workspace-other";
const CHAT = "workspace-chat";
const OTHER_CHAT = "workspace-other-chat";
const ARTIFACT_BYTES = Uint8Array.from([97, 98, 99]);
const BLOB_DIGEST = createHash("sha256").update(ARTIFACT_BYTES).digest("hex");
const CREATOR_TOKEN = "workspace-creator";
let artifactRoot = "";
let artifactPath = "";
const TURN = "workspace-turn";
const OTHER_TURN = "workspace-other-turn";
const TURN_A = "workspace-turn-a";
const TURN_B = "workspace-turn-b";

async function applySchema(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = ON");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

function seed(): void {
  const db = getDb();
  artifactRoot = mkdtempSync(join(tmpdir(), "lumiverse-workspace-artifact-"));
  artifactPath = join(artifactRoot, "artifact");
  writeFileSync(artifactPath, ARTIFACT_BYTES);
  const artifactStat = statSync(artifactPath);
  const artifactIdentity = `${Number(artifactStat.dev)}:${Number(artifactStat.ino)}:${Number(artifactStat.size)}:${Math.trunc(Number(artifactStat.mtimeMs) * 1000)}`;
  const observedIdentity = JSON.stringify({ before: null, after: artifactIdentity, createdByUs: true });
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run(USER, "Workspace user", "workspace@example.test");
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run(OTHER_USER, "Other user", "other-workspace@example.test");
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("workspace-character", USER, "Workspace character");
  db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)").run(CHAT, USER, "workspace-character", "Workspace chat");
  db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)").run(OTHER_CHAT, USER, "workspace-character", "Other workspace chat");
  db.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999)`)
    .run(TURN, USER, CHAT, "workspace-generation", "workspace-commit");
  db.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999)`)
    .run(OTHER_TURN, USER, OTHER_CHAT, "workspace-generation-other", "workspace-commit-other");
  db.query(`INSERT INTO agent_artifact_blobs
    (digest, user_id, byte_count, mime_type, storage_path, provenance_json, expires_at)
    VALUES (?, ?, 3, 'text/plain', ?, '{}', 9999999999)`)
    .run(BLOB_DIGEST, USER, artifactPath);
  db.query(`INSERT INTO agent_artifact_blob_journal
    (journal_id, blob_digest, user_id, turn_id, creator_token, fence_generation,
     staged_path, final_path, state, observed_identity, byte_count, digest)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'installed', ?, 3, ?)`)
    .run("workspace-journal", BLOB_DIGEST, USER, TURN, "workspace-creator", artifactPath, artifactPath, observedIdentity, BLOB_DIGEST);
}

function insertTurnExecution(turnId: string, generationId: string, commitKey: string, chatId = CHAT): void {
  getDb().query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999)`)
    .run(turnId, USER, chatId, generationId, commitKey);
}
type TurnAttemptOptions = {
  readonly chatId?: string;
  readonly attemptId?: string;
  readonly previousAttemptId?: string | null;
  readonly runId?: string;
  readonly generationId?: string;
  readonly generationType?: "normal" | "continue" | "regenerate" | "swipe";
  readonly targetMessageId?: string | null;
  readonly targetSwipeId?: number | null;
};

function insertTurnAttempt(turnId: string, options: TurnAttemptOptions = {}): void {
  const {
    chatId = CHAT,
    attemptId = turnId,
    previousAttemptId = null,
    runId = `${turnId}-run`,
    generationId = `${turnId}-generation`,
    generationType = "normal",
    targetMessageId = null,
    targetSwipeId = null,
  } = options;
  getDb().query(`INSERT INTO agent_run_attempts
    (user_id, chat_id, attempt_id, previous_attempt_id, run_id, turn_id,
     generation_id, generation_type, target_message_id, target_swipe_id,
     lifecycle, status, outcome, reason, terminal, started_at, updated_at,
     terminal_at, host_correlation_id, reconciliation_state, terminal_receipt_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ASSEMBLE', 'running', NULL, 'none',
            0, 1, 1, NULL, ?, 'authoritative', NULL)`)
    .run(
      USER,
      chatId,
      attemptId,
      previousAttemptId,
      runId,
      turnId,
      generationId,
      generationType,
      targetMessageId,
      targetSwipeId,
      `workspace-attempt:${attemptId}`,
    );
}

function workspaceTurnId(workspaceId: string): string {
  const row = getDb().query(
    "SELECT turn_id FROM agent_turn_workspaces WHERE user_id = ? AND workspace_id = ?",
  ).get(USER, workspaceId) as { turn_id: string } | null;
  return row?.turn_id ?? TURN;
}
function rootContext(workspaceId: string, revision: number) {
  const turnId = workspaceTurnId(workspaceId);
  return { userId: USER, chatId: CHAT, turnId, workspaceId, actor: "root" as const, frameId: turnId, expectedRevision: revision };
}
function hostContext(workspaceId: string, revision: number) {
  return { ...rootContext(workspaceId, revision), actor: "host" as const };
}
const childCapabilities = {
  revision: 1,
  allowed: ["read_section", "read_page", "update_assigned_progress", "submit_child_result", "record_finding", "record_decision", "record_question", "attach_artifact", "propose_publication"] as const,
  maxOperationBytes: 64 * 1024,
  maxOperations: 32,
};
function childContext(workspaceId: string, revision: number, frameId = "child-frame") {
  const turnId = workspaceTurnId(workspaceId);
  freezeFrameCapabilities({
    userId: USER,
    chatId: CHAT,
    turnId,
    workspaceId,
    frameId,
    capabilities: childCapabilities,
  });
  return { userId: USER, chatId: CHAT, turnId, workspaceId, actor: "child" as const, frameId, expectedRevision: revision };
}

function boundedChildContext(
  workspaceId: string,
  revision: number,
  frameId: string,
  capabilities: WorkspaceOperationCapabilitiesV1,
) {
  const turnId = workspaceTurnId(workspaceId);
  freezeFrameCapabilities({
    userId: USER,
    chatId: CHAT,
    turnId,
    workspaceId,
    frameId,
    capabilities,
  });
  return { userId: USER, chatId: CHAT, turnId, workspaceId, actor: "child" as const, frameId, expectedRevision: revision };
}
function workspace(id = "workspace-1", turnId = TURN, objective = "Keep the objective immutable") {
  return createTurnWorkspace({
    userId: USER,
    chatId: CHAT,
    turnId,
    workspaceId: id,
    objective,
    constraints: ["Use only bounded retained summaries"],
    retention: "operational",
    ttlSeconds: 100,
    quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
    capabilities: { revision: 1, allowed: ["read_section", "read_page", "create_task", "update_assigned_progress", "submit_child_result", "record_finding", "record_decision", "record_question", "attach_artifact", "propose_publication"], maxOperationBytes: 131072, maxOperations: 128 },
  });
}
function isolatedWorkspace(id: string) {
  const turnId = `turn-${id}`;
  insertTurnExecution(turnId, `generation-${id}`, `commit-${id}`);
  return workspace(id, turnId);
}
function otherWorkspace(id = "workspace-other") {
  return createTurnWorkspace({
    userId: USER,
    chatId: OTHER_CHAT,
    turnId: OTHER_TURN,
    workspaceId: id,
    objective: "Keep the objective immutable",
    constraints: ["Use only bounded retained summaries"],
    retention: "operational",
    ttlSeconds: 100,
    quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
    capabilities: { revision: 1, allowed: ["read_section", "read_page", "create_task", "update_assigned_progress", "submit_child_result", "record_finding", "record_decision", "record_question", "attach_artifact", "propose_publication"], maxOperationBytes: 131072, maxOperations: 128 },
  });
}
function otherRootContext(workspaceId: string, revision: number) {
  return { userId: USER, chatId: OTHER_CHAT, turnId: OTHER_TURN, workspaceId, actor: "root" as const, expectedRevision: revision };
}

type PersistentFixtureOptions = Omit<TurnAttemptOptions, "chatId"> & {
  readonly turnId?: string;
  readonly executionId?: string | null;
};

function persistentFixture(id: string, options: PersistentFixtureOptions = {}) {
  const { turnId = TURN, executionId = turnId, ...attempt } = options;
  insertTurnAttempt(turnId, attempt);
  workspace(id, turnId);
  const persistent = createPersistentWorkspace({ userId: USER, chatId: CHAT, workspaceId: id, objective: "persistent placeholder" });
  const session = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
    userId: USER,
    chatId: CHAT,
    workspaceId: id,
    turnSessionId: `${id}-session`,
    turnId,
    attemptId: attempt.attemptId ?? turnId,
    executionId,
    expectedRevision: persistent.revision,
  });
  return { persistent, session };
}
function insertOperationalTask(workspaceId: string, taskId = "publication-task", turnId = TURN, chatId = CHAT): void {
  getDb().query(`INSERT INTO agent_workspace_tasks
    (task_id, workspace_id, turn_id, user_id, chat_id, title, description, state,
     required, dependencies_json, progress, summary, byte_count, revision,
     retention, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, '[]', 0.5, ?, 32, 4, 'turn_terminal', 9999999999, 10, 20)`)
    .run(taskId, workspaceId, turnId, USER, chatId, "Published task", "Task objective", "Task summary");
}

function insertOperationalFinding(workspaceId: string, recordId = "publication-finding", summary = "Published finding"): void {
  getDb().query(`INSERT INTO agent_workspace_records
    (record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
     task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'finding', ?, ?, NULL, 'frame-publication', 32, 3, 'turn_terminal', 9999999999, 11)`)
    .run(recordId, workspaceId, TURN, USER, CHAT, summary, createHash("sha256").update(summary, "utf8").digest("hex"));
}

function insertOperationalArtifact(workspaceId: string, artifactId = "publication-artifact"): void {
  getDb().query(`INSERT INTO agent_workspace_artifacts
    (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
     byte_count, provenance_json, source_frame_id, source_task_id, publication_state,
     retention, revision, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 3, ?, NULL, NULL, 'published',
            'turn_terminal', 5, 9999999999, 12, 22)`)
    .run(artifactId, workspaceId, TURN, USER, CHAT, BLOB_DIGEST, JSON.stringify({ source: "host" }));
}

function persistentPublicationInput(workspaceId: string, expectedRevision: number, category: string, sourceId: string, sourceRevision?: number) {
  return {
    actor: { kind: "owner" as const, userId: USER },
    userId: USER,
    chatId: CHAT,
    workspaceId,
    expectedRevision,
    category,
    sourceId,
    ...(sourceRevision === undefined ? {} : { sourceRevision }),
  };
}
function expectWorkspaceError(code: WorkspaceErrorCode, callback: () => unknown): void {
  try { callback(); } catch (error) {
    expect(error).toBeInstanceOf(TurnWorkspaceError);
    expect((error as TurnWorkspaceError).code).toBe(code);
    return;
  }
  throw new Error(`expected workspace error ${code}`);
}
function reservationFixtureId(namespace: string, executionId: string): string {
  return `${namespace}:${createHash("sha256").update(`${namespace}\0${executionId}`).digest("hex")}`;
}
function receiptReservation(
  workspaceId: string,
  operationKey: string,
  operationKind: AgenticWorkMutatingWorkspaceOperationKindV1,
  frameId: string,
): AgenticWorkWorkspaceMutationReservationV1 {
  const executionId = workspaceTurnId(workspaceId);
  const segmentId = reservationFixtureId("receipt-segment", executionId);
  const logicalDispatch = 0;
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  try {
    db.query(`INSERT OR IGNORE INTO agent_work_segment_dispatches
      (dispatch_id, user_id, execution_id, attempt_id, segment_id, workspace_id,
       workspace_revision, execution_cas_revision, dispatch_ordinal, lifecycle,
       tool_mode, budget_class, reserved_output_tokens, ordinary_output_tokens_reserved,
       recovery_reserve_output_tokens_reserved, lease_owner, lease_expires_at,
       fence_generation, idempotency_key, payload_digest, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 'reserved', 'ordinary', 'normal', 1, 1, 0,
              ?, 9999999999, 1, ?, ?, 1, 1)`).run(
      reservationFixtureId("receipt-dispatch", executionId),
      USER,
      executionId,
      reservationFixtureId("receipt-attempt", executionId),
      segmentId,
      workspaceId,
      logicalDispatch,
      reservationFixtureId("receipt-owner", executionId),
      reservationFixtureId("receipt-dispatch-key", executionId),
      "0".repeat(64),
    );
  } finally {
    db.run("PRAGMA foreign_keys = ON");
  }
  return Object.freeze({ version: 1, operationKey, operationKind, segmentId, logicalDispatch, frameId });
}

function cognitionProgressFactory(
  taskId: string,
  transition: CognitionTaskTransition,
  workspaceRevision: number,
  materializeTemplates: readonly TaskTemplateV1[],
  reservation: AgenticWorkWorkspaceMutationReservationV1,
): CognitionWorkspaceActivationFactoryV1 {
  const state = Object.freeze({
    version: 1 as const,
    workspaceRevision,
    activatedTemplateIds: [] as readonly string[],
    requiredTemplateIds: [] as readonly string[],
  });
  const activation: CognitionActivationResultV1 = Object.freeze({
    point: "task_transition",
    state,
    newlyActivatedTemplateIds: [],
    newlyRequiredTemplateIds: [],
  });
  return {
    state,
    update: (current) => ({
      taskId,
      transition,
      reservation,
      state: Object.freeze({ ...current, workspaceRevision: current.workspaceRevision + 1 }),
      activation: Object.freeze({ ...activation, state: current }),
      materializeTemplates,
    }),
  };
}


function cognitionCompletionFactory(
  workspaceRevision: number,
  templateId: string,
): CognitionWorkspaceCompletionFactoryV1 {
  const state = Object.freeze({
    version: 1 as const,
    workspaceRevision,
    activatedTemplateIds: [] as readonly string[],
    requiredTemplateIds: [] as readonly string[],
  });
  return {
    state,
    update: (current) => {
      const next = Object.freeze({
        ...current,
        workspaceRevision: current.workspaceRevision + 1,
        activatedTemplateIds: Object.freeze([templateId]),
      });
      return {
        state: next,
        activation: Object.freeze({
          point: "phase_entry" as const,
          state: next,
          newlyActivatedTemplateIds: Object.freeze([templateId]),
          newlyRequiredTemplateIds: Object.freeze([]),
        }),
        accepted: true,
        blockingRequiredTaskIds: Object.freeze([]),
        materializeTemplates: Object.freeze([{
          id: templateId,
          required: false,
          label: "Prepared cognition task",
          description: "Must roll back with a post-preparation invalidation",
        }]),
      };
    },
  };
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applySchema();
  seed();
});
afterEach(() => {
  setWorkspaceMutationCommitBoundaryHookForTests();
  closeDatabase();
  if (artifactRoot) rmSync(artifactRoot, { recursive: true, force: true });
  artifactRoot = "";
  artifactPath = "";
});

describe("turn workspace validators and CAS operations", () => {
  test("bounds child submissions at 32 KiB UTF-8 without narrowing root submissions or records", () => {
    const created = workspace("workspace-submission-byte-limits");
    const context = childContext(created.id, created.revision, "child-byte-boundary");
    const asciiBoundary = "a".repeat(workspaceService.WORKSPACE_CHILD_SUBMISSION_SUMMARY_MAX_BYTES);
    const multibyteBoundary = "é".repeat(workspaceService.WORKSPACE_CHILD_SUBMISSION_SUMMARY_MAX_BYTES / 2);
    const oneByteOver = `${multibyteBoundary}a`;
    const base = {
      ...context,
      taskId: "task-byte-boundary",
      resultDigest: "a".repeat(64),
    };

    expect(Buffer.byteLength(asciiBoundary, "utf8")).toBe(32_768);
    expect(Buffer.byteLength(multibyteBoundary, "utf8")).toBe(32_768);
    expect(Buffer.byteLength(oneByteOver, "utf8")).toBe(32_769);
    for (const summary of [asciiBoundary, multibyteBoundary]) {
      expect(workspaceService.validateSubmitWorkspaceChildResultInput({
        ...base,
        summary,
        byteCount: Buffer.byteLength(summary, "utf8"),
      }).summary).toBe(summary);
    }
    expectWorkspaceError("quota_exceeded", () =>
      workspaceService.validateSubmitWorkspaceChildResultInput({
        ...base,
        summary: oneByteOver,
        byteCount: Buffer.byteLength(oneByteOver, "utf8"),
      }));

    const aboveChildBoundary = "r".repeat(32_769);
    expect(workspaceService.validateSubmitWorkspaceRootResultInput({
      ...rootContext(created.id, created.revision),
      taskId: "task-byte-boundary",
      summary: aboveChildBoundary,
      state: "completed",
    }).summary).toBe(aboveChildBoundary);
    expect(workspaceService.validateRecordWorkspaceRecordInput({
      ...rootContext(created.id, created.revision),
      kind: "finding",
      summary: aboveChildBoundary,
      taskId: null,
    }).summary).toBe(aboveChildBoundary);
  });
  test("keeps root-created tasks optional and omits required from the parsed contract", () => {
    const created = workspace();
    const task = createWorkspaceTask({ ...rootContext(created.id, created.revision), title: "Assigned work" });
    expect(task.required).toBe(false);
    const parsed = validateCreateWorkspaceTaskInput({
      ...rootContext(created.id, created.revision + 1),
      title: "Parsed root task",
    });
    expect(parsed).not.toHaveProperty("required");
    expectWorkspaceError("forbidden", () => createWorkspaceTask({ ...rootContext(created.id, created.revision + 1), title: "Required without host", required: true }));
    expectWorkspaceError("invalid_input", () => createWorkspaceTask({ ...rootContext(created.id, created.revision + 1), title: "Malformed required", required: "true" }));
    expectWorkspaceError("invalid_input", () => validateCreateWorkspaceTaskInput({ ...rootContext(created.id, created.revision + 1), title: "Stale optional flag", required: false }));
    expectWorkspaceError("stale_revision", () => createWorkspaceTask({ ...rootContext(created.id, created.revision), title: "Stale writer" }));
    expectWorkspaceError("child_confinement", () => updateWorkspaceTaskProgress({ ...childContext(created.id, created.revision + 1), taskId: task.id, state: "blocked" }));
    expectWorkspaceError("not_found", () => getTurnWorkspace({ ...rootContext(created.id, created.revision), userId: OTHER_USER }));
  });

  test("derives the closed read validator from the canonical section tuple", () => {
    expect(WORKSPACE_READ_SECTIONS).toEqual([
      "objective",
      "constraints",
      "tasks",
      "records",
      "submissions",
      "artifacts",
      "summary",
    ]);
    for (const section of WORKSPACE_READ_SECTIONS) {
      expect(validateReadWorkspaceSectionInput({
        ...rootContext("section-workspace", 0),
        section,
      }).section).toBe(section);
    }
    expectWorkspaceError("invalid_input", () => validateReadWorkspaceSectionInput({
      ...rootContext("section-workspace", 0),
      section: "future_section",
    }));
  });
  test("child progress cannot complete a task", () => {
    const created = workspace("progress-submission-boundary");
    const task = createWorkspaceTask({
      ...hostContext(created.id, created.revision),
      taskId: "progress-boundary-task",
      title: "Progress boundary",
      assignedFrameId: "progress-boundary-child",
    });
    expectWorkspaceError("invalid_state", () => updateWorkspaceTaskProgress({
      ...childContext(created.id, created.revision + 1, "progress-boundary-child"),
      taskId: task.id,
      state: "completed",
      progress: 1,
    }));
    expect(getDb().query("SELECT state FROM agent_workspace_tasks WHERE task_id = ?").get(task.id)).toEqual({ state: "active" });
    expect(getTurnWorkspace(rootContext(created.id, created.revision + 1)).revision).toBe(created.revision + 1);
  });


  test("freezes per-frame capabilities and prevents capability widening", () => {
    const created = workspace();
    const frame = childContext(created.id, created.revision);
    freezeFrameCapabilities({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      frameId: frame.frameId!,
      capabilities: childCapabilities,
    });
    expectWorkspaceError("forbidden", () => freezeFrameCapabilities({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      frameId: frame.frameId!,
      capabilities: { ...childCapabilities, allowed: ["read_section"] },
    }));
    expectWorkspaceError("capability_denied", () => createWorkspaceTask({ ...frame, title: "child task" }));
    const page = readTurnWorkspaceSection({ ...frame, section: "summary", page: 0, pageSize: 10 });
    expect(page.workspace.revision).toBe(created.revision);
  });
  test("rejects forged child grants and cross-turn frame reuse", () => {
    const first = workspace("frame-scope-first");
    const frame = childContext(first.id, first.revision, "reused-frame");
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: first.id,
      actor: "child",
      frameId: "forged-frame",
      expectedRevision: first.revision,
      capabilities: childCapabilities,
      section: "summary",
      page: 0,
      pageSize: 10,
    }));
    const second = createTurnWorkspace({
      userId: USER,
      chatId: OTHER_CHAT,
      turnId: OTHER_TURN,
      workspaceId: "frame-scope-second",
      objective: "Second turn",
      constraints: [],
      retention: "operational",
      ttlSeconds: 100,
      quota: { maxTasks: 8, maxRecords: 8, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 2048 },
      capabilities: { revision: 1, allowed: ["read_section"], maxOperationBytes: 131072, maxOperations: 128 },
    });
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection({
      userId: USER,
      chatId: OTHER_CHAT,
      turnId: OTHER_TURN,
      workspaceId: second.id,
      actor: "child",
      frameId: frame.frameId,
      expectedRevision: second.revision,
      section: "summary",
      page: 0,
      pageSize: 10,
    }));
  });

  test("charges exactly one operation and rejects cap plus one without consuming it", () => {
    const created = workspace("frame-operation-cap");
    const frameId = "bounded-operation-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    const maxOperationBytes = measureWorkspaceOperationBytesV1(request);
    const frame = boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes,
      maxOperations: 1,
    });
    expect(readTurnWorkspaceSection(request)).toMatchObject({ section: "summary" });
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection({ ...request, ...frame }));
    expect(getActiveFrameCapabilityCountForTests()).toBe(1);
  });

  test("rejects an oversized UTF-8 request without consuming the operation", () => {
    const created = workspace("frame-operation-bytes");
    const frameId = "bounded-byte-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    const maxOperationBytes = measureWorkspaceOperationBytesV1(request);
    const frame = boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes,
      maxOperations: 1,
    });
    const oversized = { ...request, pageSize: 100 };
    expect(measureWorkspaceOperationBytesV1(oversized)).toBeGreaterThan(maxOperationBytes);
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection(oversized));
    expect(readTurnWorkspaceSection({ ...request, ...frame })).toMatchObject({ section: "summary" });
  });

  test("admits only one concurrent request at the last frame operation", async () => {
    const created = workspace("frame-operation-race");
    const frameId = "last-operation-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    const maxOperationBytes = measureWorkspaceOperationBytesV1(request);
    const frame = boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes,
      maxOperations: 1,
    });
    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => readTurnWorkspaceSection({ ...request, ...frame })),
      Promise.resolve().then(() => readTurnWorkspaceSection({ ...request, ...frame })),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((attempts.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ code: "capability_denied" });
  });

  test("removes grants on terminal cleanup and rejects stale frames", () => {
    const created = workspace("frame-terminal-cleanup");
    const frameId = "terminal-cleanup-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes: measureWorkspaceOperationBytesV1(request),
      maxOperations: 2,
    });
    expect(getActiveFrameCapabilityCountForTests()).toBe(1);
    requestDormantTurnCancellation({ executionId: TURN, userId: USER, chatId: CHAT });
    expect(getActiveFrameCapabilityCountForTests()).toBe(0);
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection(request));
  });

  test("rejects every host/root mutation after durable Stop or deadline while preserving reads", () => {
    for (const cause of ["stop", "deadline"] as const) {
      const created = isolatedWorkspace(`global-write-fence-${cause}`);
      const task = createWorkspaceTask({
        ...hostContext(created.id, created.revision),
        taskId: `global-write-fence-${cause}-task`,
        title: "Existing root task",
      });
      const revision = created.revision + 1;
      const turnId = workspaceTurnId(created.id);
      if (cause === "stop") {
        requestDormantTurnCancellation({ executionId: turnId, userId: USER, chatId: CHAT });
      } else {
        const crossedDeadline = Date.now() - 1;
        getDb().query("UPDATE agent_turn_executions SET deadline_at = ? WHERE id = ? AND user_id = ?")
          .run(crossedDeadline, turnId, USER);
        expect(getDb().query(
          "SELECT state, cancel_requested_at, deadline_at FROM agent_turn_executions WHERE id = ? AND user_id = ?",
        ).get(turnId, USER)).toEqual({
          state: "ASSEMBLE", cancel_requested_at: null, deadline_at: crossedDeadline,
        });
      }
      expect(readTurnWorkspaceSection({
        ...rootContext(created.id, revision), section: "summary", page: 0, pageSize: 10,
      }).workspace.revision).toBe(revision);
      const mutations = [
        () => createWorkspaceTask({
          ...hostContext(created.id, revision), taskId: `blocked-${cause}-task`, title: "Blocked task",
        }),
        () => submitWorkspaceRootResult({
          ...rootContext(created.id, revision), taskId: task.id, summary: "Blocked root result", state: "completed",
        }),
        () => recordWorkspaceRecord({
          ...rootContext(created.id, revision), kind: "finding", summary: "Blocked finding",
          digest: "d".repeat(64), taskId: null,
        }),
        () => freezeWorkspaceForCompletionV1(hostContext(created.id, revision)),
      ];
      for (const mutate of mutations) expectWorkspaceError("workspace_frozen", mutate);
      expect(getTurnWorkspace(rootContext(created.id, revision)).revision).toBe(revision);
    }
  });
  test("commit-boundary refresh blocks Stop and deadline races across every mutation family", () => {
    const families = ["task", "assignment", "submission", "record", "artifact", "cognition", "completion"] as const;
    for (const cause of ["stop", "deadline"] as const) {
      for (const family of families) {
        const suffix = `${cause}-${family}`;
        const created = isolatedWorkspace(`commit-boundary-${suffix}`);
        const turnId = workspaceTurnId(created.id);
        let revision = created.revision;
        let mutate: () => unknown;
        if (family === "task") {
          mutate = () => createWorkspaceTask({
            ...hostContext(created.id, revision), taskId: `commit-boundary-task-${suffix}`, title: "Blocked task",
          });
        } else if (family === "assignment") {
          const task = createWorkspaceTask({
            ...rootContext(created.id, revision), taskId: `commit-boundary-assignment-${suffix}`, title: "Assignment target",
          });
          revision += 1;
          mutate = () => assignChildTasks({
            ...hostContext(created.id, revision), assignments: [{ taskId: task.id, frameId: `blocked-frame-${suffix}` }],
          });
        } else if (family === "submission") {
          const task = createWorkspaceTask({
            ...rootContext(created.id, revision), taskId: `commit-boundary-submission-${suffix}`, title: "Submission target",
          });
          revision += 1;
          mutate = () => submitWorkspaceRootResult({
            ...rootContext(created.id, revision), taskId: task.id, summary: "Blocked submission", state: "completed",
          });
        } else if (family === "record") {
          mutate = () => recordWorkspaceRecord({
            ...rootContext(created.id, revision), kind: "finding", summary: "Blocked finding",
            digest: createHash("sha256").update(suffix).digest("hex"), taskId: null,
          });
        } else if (family === "artifact") {
          const creatorToken = `commit-boundary-creator-${suffix}`;
          getDb().query(`INSERT INTO agent_artifact_blob_journal
            (journal_id, blob_digest, user_id, turn_id, creator_token, fence_generation, staged_path, final_path, state, observed_identity, byte_count, digest)
            SELECT ?, blob_digest, user_id, ?, ?, fence_generation, staged_path, final_path, state, observed_identity, byte_count, digest
            FROM agent_artifact_blob_journal WHERE journal_id = ?`).run(`commit-boundary-journal-${suffix}`, turnId, creatorToken, "workspace-journal");
          mutate = () => attachWorkspaceArtifactReference({
            ...rootContext(created.id, revision), blobDigest: BLOB_DIGEST, byteCount: 3, mimeType: "text/plain",
            provenance: "root", creatorToken, taskId: null,
          });
        } else if (family === "cognition") {
          const taskId = `commit-boundary-cognition-${suffix}`;
          const reservation = receiptReservation(created.id, `commit-boundary-cognition-receipt-${suffix}`, "create_task", turnId);
          const factory = cognitionProgressFactory(taskId, "active", revision, [], reservation);
          mutate = () => createWorkspaceTaskWithCognition({
            ...rootContext(created.id, revision), taskId, title: "Blocked cognition task",
            dependencyIds: [], assignedFrameId: null,
          }, factory);
        } else {
          mutate = () => freezeWorkspaceForCompletionV1(hostContext(created.id, revision));
        }
        const snapshot = () => ({
          workspace: getDb().query(
            "SELECT state, revision, task_count, record_count, submission_count, artifact_count, byte_count FROM agent_turn_workspaces WHERE user_id = ? AND workspace_id = ?",
          ).get(USER, created.id),
          tasks: getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_tasks WHERE user_id = ? AND workspace_id = ?").get(USER, created.id),
          submissions: getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_submissions WHERE user_id = ? AND workspace_id = ?").get(USER, created.id),
          records: getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_records WHERE user_id = ? AND workspace_id = ?").get(USER, created.id),
          artifacts: getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_artifacts WHERE user_id = ? AND workspace_id = ?").get(USER, created.id),
        });
        const before = snapshot();
        setWorkspaceMutationCommitBoundaryHookForTests(() => {
          setWorkspaceMutationCommitBoundaryHookForTests();
          if (cause === "stop") {
            requestDormantTurnCancellation({ executionId: turnId, userId: USER, chatId: CHAT });
          } else {
            getDb().query("UPDATE agent_turn_executions SET deadline_at = ? WHERE id = ? AND user_id = ?")
              .run(Date.now() - 1, turnId, USER);
          }
        });
        expectWorkspaceError("workspace_frozen", mutate);
        expect(snapshot()).toEqual(before);
        expect(getDb().query(
          "SELECT state, cancel_requested_at, deadline_at FROM agent_turn_executions WHERE id = ? AND user_id = ?",
        ).get(turnId, USER)).toMatchObject(cause === "stop"
          ? { state: "CANCELLED" }
          : { state: "ASSEMBLE", cancel_requested_at: null });
      }
    }
  });
  test("cognition completion rolls back when preparation invalidates workspace writability", () => {
    for (const cause of ["stop", "deadline", "ttl", "state"] as const) {
      const created = isolatedWorkspace(`cognition-completion-prepare-${cause}`);
      const turnId = workspaceTurnId(created.id);
      const templateId = `prepared-template-${cause}`;
      const frameId = `prepared-frame-${cause}`;
      const childRead = {
        ...boundedChildContext(created.id, created.revision, frameId, {
          revision: 1,
          allowed: ["read_section"],
          maxOperationBytes: 131072,
          maxOperations: 2,
        }),
        section: "summary" as const,
        page: 0,
        pageSize: 10,
      };
      const snapshot = () => ({
        workspace: getDb().query(
          "SELECT state, revision, frozen_at, expires_at, task_count, record_count, submission_count, artifact_count, byte_count FROM agent_turn_workspaces WHERE workspace_id = ? AND user_id = ?",
        ).get(created.id, USER),
        tasks: getDb().query(
          "SELECT COUNT(*) AS count FROM agent_workspace_tasks WHERE workspace_id = ? AND user_id = ?",
        ).get(created.id, USER),
        cognitionTasks: getDb().query(
          "SELECT COUNT(*) AS count FROM agent_workspace_tasks WHERE workspace_id = ? AND user_id = ? AND cognition_template_id IS NOT NULL",
        ).get(created.id, USER),
        execution: getDb().query(
          "SELECT state, cas_revision, terminal_code, deadline_at FROM agent_turn_executions WHERE id = ? AND user_id = ?",
        ).get(turnId, USER),
        activeFrameCapabilities: getActiveFrameCapabilityCountForTests(),
      });
      const before = snapshot();
      const factory = cognitionCompletionFactory(created.revision, templateId);
      expectWorkspaceError("workspace_frozen", () => freezeWorkspaceForCompletionWithCognition(
        hostContext(created.id, created.revision),
        factory,
        {
          prepare: (candidate) => {
            if (cause === "stop") {
              requestDormantTurnCancellation({ executionId: turnId, userId: USER, chatId: CHAT });
            } else if (cause === "deadline") {
              getDb().query("UPDATE agent_turn_executions SET deadline_at = ? WHERE id = ? AND user_id = ?")
                .run(Date.now() - 1, turnId, USER);
            } else if (cause === "ttl") {
              getDb().query("UPDATE agent_turn_workspaces SET expires_at = ? WHERE workspace_id = ? AND user_id = ?")
                .run(Math.floor(Date.now() / 1000) - 1, created.id, USER);
            } else {
              getDb().query("UPDATE agent_turn_workspaces SET state = 'frozen', frozen_at = ? WHERE workspace_id = ? AND user_id = ?")
                .run(Math.floor(Date.now() / 1000), created.id, USER);
            }
            return { candidate, bundle: Object.freeze({ cause }) };
          },
        },
      ));
      expect(snapshot()).toEqual(before);
      expect(getDb().query(
        "SELECT COUNT(*) AS count FROM agent_workspace_tasks WHERE workspace_id = ? AND cognition_template_id = ?",
      ).get(created.id, templateId)).toEqual({ count: 0 });
      expect(readTurnWorkspaceSection(childRead).workspace.revision).toBe(created.revision);
      if (cause === "stop") {
        requestDormantTurnCancellation({ executionId: turnId, userId: USER, chatId: CHAT });
      } else if (cause === "deadline") {
        getDb().query("UPDATE agent_turn_executions SET deadline_at = ? WHERE id = ? AND user_id = ?")
          .run(Date.now() - 1, turnId, USER);
      } else if (cause === "ttl") {
        getDb().query("UPDATE agent_turn_workspaces SET expires_at = ? WHERE workspace_id = ? AND user_id = ?")
          .run(Math.floor(Date.now() / 1000) - 1, created.id, USER);
      } else {
        getDb().query("UPDATE agent_turn_workspaces SET state = 'frozen', frozen_at = ? WHERE workspace_id = ? AND user_id = ?")
          .run(Math.floor(Date.now() / 1000), created.id, USER);
      }
      getTurnWorkspace(rootContext(created.id, created.revision));
      expect(getActiveFrameCapabilityCountForTests()).toBe(0);
      expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection(childRead));
    }
  });

  test("removes grants when the workspace expires", () => {
    const created = workspace("frame-expiry-cleanup");
    const frameId = "expiry-cleanup-frame";
    const request = {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: created.id,
      actor: "child" as const,
      frameId,
      expectedRevision: created.revision,
      section: "summary" as const,
      page: 0,
      pageSize: 10,
    };
    boundedChildContext(created.id, created.revision, frameId, {
      revision: 1,
      allowed: ["read_section"],
      maxOperationBytes: measureWorkspaceOperationBytesV1(request),
      maxOperations: 2,
    });
    getDb().query("UPDATE agent_turn_workspaces SET expires_at = ? WHERE workspace_id = ?").run(Math.floor(Date.now() / 1000) - 1, created.id);
    expect(getTurnWorkspace(rootContext(created.id, created.revision)).state).toBe("expired");
    expect(getActiveFrameCapabilityCountForTests()).toBe(0);
    expectWorkspaceError("capability_denied", () => readTurnWorkspaceSection(request));
  });
  test("public workspace data excludes CAS and capability internals", () => {
    const created = workspace("public-redaction");
    const snapshot = getTurnWorkspace(rootContext(created.id, created.revision));
    expect(snapshot).not.toHaveProperty("casOwner");
    expect(snapshot).not.toHaveProperty("leaseOwner");
    expect(snapshot).not.toHaveProperty("operationCapabilities");
    expect(JSON.stringify(snapshot)).not.toContain("maxOperationBytes");
  });
  test("persists only pending, active, and blocked cognition progress", () => {
    const created = workspace();
    const task = createWorkspaceTask({ ...rootContext(created.id, created.revision), taskId: "cognition-progress-task", title: "Cognition progress", assignedFrameId: "child-frame" });
    let revision = created.revision + 1;
    for (const item of [
      { state: "blocked" as const, transition: "blocked" as const },
      { state: "active" as const, transition: "active" as const },
      { state: "active" as const, transition: "pending" as const },
    ]) {
      const result = updateWorkspaceTaskProgressWithCognition(
        { ...childContext(created.id, revision), taskId: task.id, state: item.state, progress: 0.5 },
        cognitionProgressFactory(task.id, item.transition, revision, [], receiptReservation(created.id, `cognition-progress-${item.transition}-${revision}`, "update_assigned_progress", "child-frame")),
      );
      expect(result.workspaceRevision).toBe(revision + 1);
      const row = getDb().query("SELECT state FROM agent_workspace_tasks WHERE task_id = ? AND workspace_id = ?").get(task.id, created.id) as { state: string } | null;
      expect(row?.state).toBe(item.transition);
      revision += 1;
    }
    expectWorkspaceError("invalid_state", () => updateWorkspaceTaskProgressWithCognition(
      { ...childContext(created.id, revision), taskId: task.id, state: "completed", progress: 1 },
      cognitionProgressFactory(task.id, "completed", revision, [], receiptReservation(created.id, "cognition-progress-invalid-completed", "update_assigned_progress", "child-frame")),
    ));
    expect(getDb().query("SELECT state FROM agent_workspace_tasks WHERE task_id = ? AND workspace_id = ?").get(task.id, created.id)).toEqual({ state: "pending" });
    expect(getTurnWorkspace(rootContext(created.id, revision)).revision).toBe(revision);
  });

  test("rejects dependency cycles and duplicate stable identifiers", () => {
    const created = workspace();
    const a = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "task-a", title: "A" });
    const b = createWorkspaceTask({ ...rootContext(created.id, 1), taskId: "task-b", title: "B", dependencyIds: [a.id] });
    expectWorkspaceError("dependency_cycle", () => updateWorkspaceTaskPolicy({ ...rootContext(created.id, 2), taskId: a.id, dependencyIds: [b.id] }));
    expectWorkspaceError("duplicate_id", () => createWorkspaceTask({ ...rootContext(created.id, 2), taskId: "task-b", title: "Duplicate" }));
  });
  test("scopes a colliding model task id to the current turn", () => {
    const first = workspace("workspace-task-id-first");
    const created = createWorkspaceTask({
      ...rootContext(first.id, first.revision),
      taskId: "honesty-pack-review-4",
      title: "Review Honesty Coverage Pack",
    });
    expect(created.id).toBe("honesty-pack-review-4");
    const second = otherWorkspace("workspace-task-id-second");
    const reused = createWorkspaceTask({
      ...otherRootContext(second.id, second.revision),
      taskId: "honesty-pack-review-4",
      title: "Review Honesty Coverage Pack again",
    });
    expect(reused.id).toBe(`${OTHER_TURN}:honesty-pack-review-4`);
    expect(reused.title).toBe("Review Honesty Coverage Pack again");
    expectWorkspaceError("duplicate_id", () => createWorkspaceTask({
      ...otherRootContext(second.id, second.revision + 1),
      taskId: "honesty-pack-review-4",
      title: "Same turn collision",
    }));
  });
  test("recomputes task policy footprints at the maxBytes boundary", () => {
    const created = workspace("task-policy-byte-cap");
    const dependency = createWorkspaceTask({
      ...rootContext(created.id, created.revision),
      taskId: "policy-dependency",
      title: "Dependency",
    });
    const target = createWorkspaceTask({
      ...rootContext(created.id, created.revision + 1),
      taskId: "policy-target",
      title: "Target",
    });
    const before = getDb().query(
      "SELECT byte_count FROM agent_turn_workspaces WHERE workspace_id = ?",
    ).get(created.id) as { byte_count: number };
    const targetBefore = getDb().query(
      "SELECT byte_count, dependencies_json FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(target.id) as { byte_count: number; dependencies_json: string };
    const oldDependencyBytes = new TextEncoder().encode(targetBefore.dependencies_json).byteLength;
    const newDependencyBytes = new TextEncoder().encode(JSON.stringify([dependency.id])).byteLength;
    const delta = newDependencyBytes - oldDependencyBytes;
    expect(delta).toBeGreaterThan(0);

    getDb().query("UPDATE agent_turn_workspaces SET quota_bytes = ? WHERE workspace_id = ?")
      .run(before.byte_count + delta - 1, created.id);
    expectWorkspaceError("quota_exceeded", () => updateWorkspaceTaskPolicy({
      ...rootContext(created.id, 2),
      taskId: target.id,
      dependencyIds: [dependency.id],
    }));
    expect(getTurnWorkspace(rootContext(created.id, 2)).usage.byteCount).toBe(before.byte_count);
    expect(getDb().query(
      "SELECT dependencies_json, byte_count FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(target.id)).toEqual(targetBefore);

    getDb().query("UPDATE agent_turn_workspaces SET quota_bytes = ? WHERE workspace_id = ?")
      .run(before.byte_count + delta, created.id);
    const updated = updateWorkspaceTaskPolicy({
      ...rootContext(created.id, 2),
      taskId: target.id,
      dependencyIds: [dependency.id],
    });
    expect(updated.dependencyIds).toEqual([dependency.id]);
    expect(getDb().query(
      "SELECT dependencies_json, byte_count FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(target.id)).toEqual({
      dependencies_json: JSON.stringify([dependency.id]),
      byte_count: targetBefore.byte_count + delta,
    });
    expect(getTurnWorkspace(rootContext(created.id, 3)).usage.byteCount).toBe(before.byte_count + delta);
  });

  test("record admission repairs stale counters from current task rows", () => {
    const created = workspace("record-current-accounting");
    const task = createWorkspaceTask({
      ...rootContext(created.id, created.revision),
      taskId: "accounting-task",
      title: "Accounting task",
    });
    const taskRow = getDb().query(
      "SELECT byte_count FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(task.id) as { byte_count: number };
    const summary = "current accounting";
    const summaryBytes = new TextEncoder().encode(summary).byteLength;
    getDb().query(
      "UPDATE agent_turn_workspaces SET byte_count = 0, quota_bytes = ? WHERE workspace_id = ?",
    ).run(taskRow.byte_count + summaryBytes, created.id);

    const record = recordWorkspaceRecord({
      ...rootContext(created.id, 1),
      kind: "finding",
      summary,
      digest: "e".repeat(64),
      taskId: null,
    });
    expect(record.summary).toBe(summary);
    expect(getTurnWorkspace(rootContext(created.id, 2)).usage.byteCount)
      .toBe(taskRow.byte_count + summaryBytes);
  });

  test("rejects a root record linked to a nonexistent task before persistence", () => {
    const created = workspace("record-missing-task");
    expectWorkspaceError("not_found", () => recordWorkspaceRecord({
      ...rootContext(created.id, created.revision),
      kind: "finding",
      summary: "bounded finding",
      digest: "e".repeat(64),
      taskId: "missing-task",
    }));
    expect(getTurnWorkspace(rootContext(created.id, created.revision)).usage.recordCount).toBe(0);
  });
  test("submission and artifact admissions rebuild stale workspace byte counters", () => {
    const created = workspace("submission-artifact-current-accounting");
    const task = createWorkspaceTask({
      ...rootContext(created.id, created.revision),
      taskId: "submission-accounting-task",
      title: "Submission task",
      assignedFrameId: "child-frame",
    });
    const taskRow = getDb().query(
      "SELECT byte_count FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(task.id) as { byte_count: number };
    const summary = "submitted result";
    const submissionBytes = 7 + new TextEncoder().encode(summary).byteLength;
    getDb().query(
      "UPDATE agent_turn_workspaces SET byte_count = 0, quota_bytes = ? WHERE workspace_id = ?",
    ).run(taskRow.byte_count + submissionBytes, created.id);

    const submitted = submitWorkspaceChildResult({
      ...childContext(created.id, 1),
      taskId: task.id,
      summary,
      resultDigest: "f".repeat(64),
      byteCount: 7,
    });
    expect(submitted.state).toBe("completed");
    expect(getDb().query("SELECT state FROM agent_workspace_submissions WHERE task_id = ?").get(task.id)).toEqual({ state: "submitted" });
    expect(getTurnWorkspace(rootContext(created.id, 2)).usage.byteCount)
      .toBe(taskRow.byte_count + submissionBytes);

    const artifactBytes = 3;
    getDb().query(
      "UPDATE agent_turn_workspaces SET byte_count = 0, quota_bytes = ? WHERE workspace_id = ?",
    ).run(taskRow.byte_count + submissionBytes + artifactBytes, created.id);
    const artifact = attachWorkspaceArtifactReference({
      ...rootContext(created.id, 2),
      creatorToken: CREATOR_TOKEN,
      blobDigest: BLOB_DIGEST,
      byteCount: artifactBytes,
      mimeType: "text/plain",
      provenance: "root",
      taskId: null,
    });
    expect(artifact.byteCount).toBe(artifactBytes);
    expect(getTurnWorkspace(rootContext(created.id, 3)).usage.byteCount)
      .toBe(taskRow.byte_count + submissionBytes + artifactBytes);
  });

  test("assigns an accepted dependency batch atomically to exact child frames", () => {
    const created = workspace();
    const prerequisite = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "assignment-prerequisite", title: "Prerequisite", assignedFrameId: "prerequisite-frame" });
    const submitted = submitWorkspaceChildResult({ ...childContext(created.id, 1, "prerequisite-frame"), taskId: prerequisite.id, summary: "accepted prerequisite", resultDigest: "d".repeat(64), byteCount: 8 });
    const submissionRow = getDb().query("SELECT submission_id, state FROM agent_workspace_submissions WHERE task_id = ?").get(prerequisite.id) as { submission_id: string; state: string } | null;
    expect(submitted.state).toBe("completed");
    expect(submissionRow?.state).toBe("submitted");
    const accepted = acceptWorkspaceSubmission({ ...hostContext(created.id, 2), submissionId: submissionRow?.submission_id, taskId: prerequisite.id });
    expect(accepted.state).toBe("accepted");
    const dependent = createWorkspaceTask({ ...rootContext(created.id, 3), taskId: "assignment-dependent", title: "Dependent", dependencyIds: [prerequisite.id] });
    const independent = createWorkspaceTask({ ...rootContext(created.id, 4), taskId: "assignment-independent", title: "Independent" });
    const result = assignChildTasks({
      ...hostContext(created.id, 5),
      assignments: [
        { taskId: dependent.id, frameId: "child-frame-dependent" },
        { taskId: independent.id, frameId: "child-frame-independent" },
      ],
    });
    expect(result.workspaceRevision).toBe(6);
    expect(result.tasks.map((task) => [task.id, task.assignedFrameId])).toEqual([
      ["assignment-dependent", "child-frame-dependent"],
      ["assignment-independent", "child-frame-independent"],
    ]);
    expect(getTurnWorkspace({ ...rootContext(created.id, 6) }).revision).toBe(6);
    expectWorkspaceError("stale_revision", () => assignChildTasks({
      ...hostContext(created.id, 5),
      assignments: [{ taskId: dependent.id, frameId: "stale-frame" }],
    }));
  });

  test("rejects unaccepted dependencies and rolls back the complete assignment batch", () => {
    const created = workspace();
    const prerequisite = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "order-prerequisite", title: "Prerequisite" });
    const dependent = createWorkspaceTask({ ...rootContext(created.id, 1), taskId: "order-dependent", title: "Dependent", dependencyIds: [prerequisite.id] });
    expectWorkspaceError("dependency_cycle", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: [
        { taskId: prerequisite.id, frameId: "order-prerequisite-frame" },
        { taskId: dependent.id, frameId: "order-dependent-frame" },
      ],
    }));
    expect(getTurnWorkspace({ ...rootContext(created.id, 2) }).revision).toBe(2);
    const rows = getDb().query("SELECT task_id, assigned_frame_id FROM agent_workspace_tasks WHERE workspace_id = ? ORDER BY task_id").all(created.id) as Array<{ task_id: string; assigned_frame_id: string | null }>;
    expect(rows).toEqual([
      { task_id: "order-dependent", assigned_frame_id: null },
      { task_id: "order-prerequisite", assigned_frame_id: null },
    ]);
  });

  test("rejects missing, duplicate, already-assigned, and oversized assignment batches without mutation", () => {
    const created = workspace();
    const assigned = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "already-assigned", title: "Assigned", assignedFrameId: "existing-frame" });
    const open = createWorkspaceTask({ ...rootContext(created.id, 1), taskId: "open-assignment", title: "Open" });
    expectWorkspaceError("not_found", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: [
        { taskId: open.id, frameId: "open-frame" },
        { taskId: "missing-assignment", frameId: "missing-frame" },
      ],
    }));
    expectWorkspaceError("duplicate_id", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: [
        { taskId: open.id, frameId: "same-frame" },
        { taskId: assigned.id, frameId: "same-frame" },
      ],
    }));
    expectWorkspaceError("task_assignment_conflict", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: [{ taskId: assigned.id, frameId: "new-frame" }],
    }));
    expectWorkspaceError("quota_exceeded", () => assignChildTasks({
      ...hostContext(created.id, 2),
      assignments: Array.from({ length: WORKSPACE_MAX_TASK_ASSIGNMENTS + 1 }, (_, index) => ({ taskId: `oversized-${index}`, frameId: `oversized-frame-${index}` })),
    }));
    expect(getTurnWorkspace({ ...rootContext(created.id, 2) }).revision).toBe(2);
    expect(getTurnWorkspace({ ...rootContext(created.id, 2) }).state).toBe("active");
  });


  test("enforces UTF-8 objective and retention caps at cap plus one", () => {
    const objective = "😀".repeat(Math.floor(WORKSPACE_OBJECTIVE_MAX_BYTES / 4));
    const created = createTurnWorkspace({ userId: USER, chatId: CHAT, turnId: TURN, workspaceId: "utf8-workspace", objective, constraints: [], retention: "chat_lifetime", capabilities: { revision: 1, allowed: [], maxOperationBytes: 1, maxOperations: 1 } });
    expect(created.objective).toBe(objective);
    expectWorkspaceError("quota_exceeded", () => createTurnWorkspace({ userId: USER, chatId: CHAT, turnId: TURN, workspaceId: "utf8-too-large", objective: `${objective}😀`, constraints: [], retention: "chat_lifetime", capabilities: { revision: 1, allowed: [], maxOperationBytes: 1, maxOperations: 1 } }));
    expectWorkspaceError("invalid_input", () => createTurnWorkspace({ userId: USER, chatId: CHAT, turnId: TURN, workspaceId: "ttl-too-large", objective: "x", constraints: [], retention: "operational", ttlSeconds: WORKSPACE_MAX_OPERATIONAL_TTL_SECONDS + 1, capabilities: { revision: 1, allowed: [], maxOperationBytes: 1, maxOperations: 1 } }));
  });

  test("lets the root settle its own task while denying child root authority", () => {
    const created = createTurnWorkspace({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: "root-result-boundary",
      objective: "Root result boundary",
      constraints: [],
      retention: "operational",
      ttlSeconds: 100,
      quota: { maxTasks: 4, maxRecords: 4, maxSubmissions: 4, maxArtifacts: 2, maxBytes: 1024 },
      capabilities: {
        revision: 1,
        allowed: ["create_task", "submit_child_result", "submit_root_result"],
        maxOperationBytes: 64 * 1024,
        maxOperations: 32,
      },
    });
    const task = createWorkspaceTask({
      ...hostContext(created.id, created.revision),
      taskId: "root-result-task",
      title: "Root-owned required task",
      required: true,
    });
    const completed = submitWorkspaceRootResult({
      ...rootContext(created.id, created.revision + 1),
      taskId: task.id,
      summary: "Root provider completed its assigned task",
      state: "completed",
    });
    expect(completed.state).toBe("completed");
    const replay = submitWorkspaceRootResult({
      ...rootContext(created.id, created.revision + 2),
      taskId: task.id,
      summary: "Root provider completed its assigned task",
      state: "completed",
    });
    expect(replay).toEqual(completed);
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceRootResult({
      ...rootContext(created.id, created.revision + 2),
      taskId: task.id,
      summary: "A different root result",
      state: "completed",
    }));
    expectWorkspaceError("forbidden", () => submitWorkspaceRootResult({
      ...childContext(created.id, created.revision + 2),
      taskId: task.id,
      summary: "Child must not submit a root result",
      state: "completed",
    }));
  });
  test("lets the root fail an unassigned task without creating a submission", () => {
    const created = createTurnWorkspace({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: "root-failure-boundary",
      objective: "Root failure boundary",
      constraints: [],
      retention: "operational",
      ttlSeconds: 100,
      quota: { maxTasks: 4, maxRecords: 4, maxSubmissions: 4, maxArtifacts: 2, maxBytes: 1024 },
      capabilities: {
        revision: 1,
        allowed: ["create_task", "submit_root_result"],
        maxOperationBytes: 64 * 1024,
        maxOperations: 32,
      },
    });
    const task = createWorkspaceTask({
      ...hostContext(created.id, created.revision),
      taskId: "root-failure-task",
      title: "Root-owned failed task",
      required: true,
    });
    const failed = submitWorkspaceRootResult({
      ...rootContext(created.id, created.revision + 1),
      taskId: task.id,
      summary: "Root provider could not complete the task",
      state: "failed",
    });
    expect(failed.state).toBe("failed");
    const failedGates = getWorkspaceCompletionGatesV1(rootContext(created.id, created.revision + 2));
    expect(failedGates).toMatchObject({
      accepted: false,
      openRequiredTaskIds: [task.id],
      pendingSubmissionCount: 0,
    });
    expect(freezeWorkspaceForCompletionV1(rootContext(created.id, created.revision + 2))).toEqual({
      workspaceRevision: created.revision + 2,
      accepted: false,
    });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_submissions WHERE task_id = ?").get(task.id)).toEqual({ count: 0 });
    const replay = submitWorkspaceRootResult({
      ...rootContext(created.id, created.revision + 2),
      taskId: task.id,
      summary: "Root provider could not complete the task",
      state: "failed",
    });
    expect(replay.state).toBe("failed");
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceRootResult({
      ...rootContext(created.id, created.revision + 2),
      taskId: task.id,
      summary: "A different root failure summary",
      state: "failed",
    }));

  });
  test("accounts failed root summaries at exact and over maxBytes caps", () => {
    const normal = isolatedWorkspace("failed-summary-normal");
    const normalTask = createWorkspaceTask({
      ...hostContext(normal.id, normal.revision),
      taskId: "failed-summary-normal-task",
      title: "Normal failed task",
    });
    const normalBefore = getTurnWorkspace(rootContext(normal.id, normal.revision + 1)).usage.byteCount;
    const normalSummary = "normal failure summary";
    const normalSummaryBytes = new TextEncoder().encode(normalSummary).byteLength;
    getDb().query("UPDATE agent_turn_workspaces SET quota_bytes = ? WHERE workspace_id = ?")
      .run(normalBefore + normalSummaryBytes, normal.id);
    const normalFailed = submitWorkspaceRootResult({
      ...rootContext(normal.id, normal.revision + 1),
      taskId: normalTask.id,
      summary: normalSummary,
      state: "failed",
    });
    expect(normalFailed.state).toBe("failed");
    expect(getTurnWorkspace(rootContext(normal.id, normal.revision + 2)).usage.byteCount)
      .toBe(normalBefore + normalSummaryBytes);
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_submissions WHERE workspace_id = ?").get(normal.id))
      .toEqual({ count: 0 });

    const normalOver = isolatedWorkspace("failed-summary-normal-over");
    const normalOverTask = createWorkspaceTask({
      ...hostContext(normalOver.id, normalOver.revision),
      taskId: "failed-summary-normal-over-task",
      title: "Normal over-cap failed task",
    });
    const normalOverBefore = getTurnWorkspace(rootContext(normalOver.id, normalOver.revision + 1)).usage.byteCount;
    getDb().query("UPDATE agent_turn_workspaces SET quota_bytes = ? WHERE workspace_id = ?")
      .run(normalOverBefore + normalSummaryBytes - 1, normalOver.id);
    expectWorkspaceError("quota_exceeded", () => submitWorkspaceRootResult({
      ...rootContext(normalOver.id, normalOver.revision + 1),
      taskId: normalOverTask.id,
      summary: normalSummary,
      state: "failed",
    }));
    expect(getTurnWorkspace(rootContext(normalOver.id, normalOver.revision + 1)).usage.byteCount)
      .toBe(normalOverBefore);
    expect(getDb().query("SELECT state, revision FROM agent_workspace_tasks WHERE task_id = ?").get(normalOverTask.id))
      .toEqual({ state: "active", revision: 0 });

    const cognition = isolatedWorkspace("failed-summary-cognition");
    const cognitionTask = createWorkspaceTask({
      ...hostContext(cognition.id, cognition.revision),
      taskId: "failed-summary-cognition-task",
      title: "Cognition failed task",
    });
    const cognitionBefore = getTurnWorkspace(rootContext(cognition.id, cognition.revision + 1)).usage.byteCount;
    const cognitionSummary = "cognition failure summary";
    const cognitionSummaryBytes = new TextEncoder().encode(cognitionSummary).byteLength;
    getDb().query("UPDATE agent_turn_workspaces SET quota_bytes = ? WHERE workspace_id = ?")
      .run(cognitionBefore + cognitionSummaryBytes, cognition.id);
    const cognitionFailed = submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(cognition.id, cognition.revision + 1),
        taskId: cognitionTask.id,
        summary: cognitionSummary,
        state: "failed",
      },
      cognitionProgressFactory(cognitionTask.id, "failed", cognition.revision + 1, [], receiptReservation(cognition.id, "failed-summary-cognition", "submit_root_result", workspaceTurnId(cognition.id))),
    );
    expect(cognitionFailed.state.workspaceRevision).toBe(cognition.revision + 2);
    expect(getTurnWorkspace(rootContext(cognition.id, cognition.revision + 2)).usage.byteCount)
      .toBe(cognitionBefore + cognitionSummaryBytes);
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_submissions WHERE workspace_id = ?").get(cognition.id))
      .toEqual({ count: 0 });

    const cognitionOver = isolatedWorkspace("failed-summary-cognition-over");
    const cognitionOverTask = createWorkspaceTask({
      ...hostContext(cognitionOver.id, cognitionOver.revision),
      taskId: "failed-summary-cognition-over-task",
      title: "Cognition over-cap failed task",
    });
    const cognitionOverBefore = getTurnWorkspace(rootContext(cognitionOver.id, cognitionOver.revision + 1)).usage.byteCount;
    getDb().query("UPDATE agent_turn_workspaces SET quota_bytes = ? WHERE workspace_id = ?")
      .run(cognitionOverBefore + cognitionSummaryBytes - 1, cognitionOver.id);
    expectWorkspaceError("quota_exceeded", () => submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(cognitionOver.id, cognitionOver.revision + 1),
        taskId: cognitionOverTask.id,
        summary: cognitionSummary,
        state: "failed",
      },
      cognitionProgressFactory(cognitionOverTask.id, "failed", cognitionOver.revision + 1, [], receiptReservation(cognitionOver.id, "failed-summary-cognition-over", "submit_root_result", workspaceTurnId(cognitionOver.id))),
    ));
    expect(getTurnWorkspace(rootContext(cognitionOver.id, cognitionOver.revision + 1)).usage.byteCount)
      .toBe(cognitionOverBefore);
    expect(getDb().query("SELECT state, revision FROM agent_workspace_tasks WHERE task_id = ?").get(cognitionOverTask.id))
      .toEqual({ state: "active", revision: 0 });
  });
  test("replays cognition root results from durable terminal identity", () => {
    const completed = isolatedWorkspace("cognition-root-replay-completed");
    const completedTask = createWorkspaceTask({
      ...hostContext(completed.id, completed.revision),
      taskId: "cognition-root-replay-completed-task",
      title: "Cognition completed task",
    });
    const completedSummary = "Cognition root completed";
    const completedOperationKey = "cognition-root-completed-operation";
    const completedReservation = receiptReservation(
      completed.id,
      completedOperationKey,
      "submit_root_result",
      workspaceTurnId(completed.id),
    );
    const completedFirst = submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(completed.id, completed.revision + 1),
        taskId: completedTask.id,
        summary: completedSummary,
        state: "completed",
      },
      cognitionProgressFactory(completedTask.id, "completed", completed.revision + 1, [], completedReservation),
    );
    const completedReplay = submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(completed.id, completed.revision + 2),
        taskId: completedTask.id,
        summary: completedSummary,
        state: "completed",
      },
      cognitionProgressFactory(completedTask.id, "completed", completed.revision + 2, [], completedReservation),
    );
    expect(completedReplay.workspaceRevision).toBe(completedFirst.workspaceRevision);
    expect(completedReplay.state.workspaceRevision).toBe(completedFirst.state.workspaceRevision);
    expect(completedReplay.taskId).toBe(completedFirst.taskId);
    expect(completedReplay.transition).toBe(completedFirst.transition);
    const completedOwner = {
      operationKey: completedReservation.operationKey,
      segmentId: completedReservation.segmentId,
      logicalDispatch: completedReservation.logicalDispatch,
      frameId: completedReservation.frameId,
    };
    expect(completedFirst).toMatchObject(completedOwner);
    expect(completedReplay).toMatchObject(completedOwner);
    expect(getDb().query(
      "SELECT segment_id, logical_dispatch, frame_id FROM agent_work_workspace_receipts WHERE operation_key = ?",
    ).get(completedOperationKey)).toEqual({
      segment_id: completedReservation.segmentId,
      logical_dispatch: completedReservation.logicalDispatch,
      frame_id: completedReservation.frameId,
    });
    expect(completedReplay.operationKey).toBe(completedOperationKey);
    expect(getDb().query("SELECT revision FROM agent_turn_workspaces WHERE workspace_id = ?").get(completed.id))
      .toEqual({ revision: completed.revision + 2 });
    expect(getDb().query("SELECT revision, cas_owner FROM agent_workspace_tasks WHERE task_id = ?").get(completedTask.id))
      .toEqual({ revision: 1, cas_owner: completedOperationKey });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_submissions WHERE task_id = ?").get(completedTask.id))
      .toEqual({ count: 1 });
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(completed.id, completed.revision + 2),
        taskId: completedTask.id,
        summary: "Different cognition root result",
        state: "completed",
      },
      cognitionProgressFactory(completedTask.id, "completed", completed.revision + 2, [], completedReservation),
    ));
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(completed.id, completed.revision + 2),
        taskId: completedTask.id,
        summary: completedSummary,
        state: "completed",
        retention: "turn_terminal",
        ttlSeconds: 10,
      },
      cognitionProgressFactory(completedTask.id, "completed", completed.revision + 2, [], completedReservation),
    ));
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(completed.id, completed.revision + 2),
        taskId: completedTask.id,
        summary: completedSummary,
        state: "completed",
      },
      cognitionProgressFactory(completedTask.id, "completed", completed.revision + 2, [], receiptReservation(completed.id, "different-cognition-root-operation", "submit_root_result", workspaceTurnId(completed.id))),
    ));

    const failed = isolatedWorkspace("cognition-root-replay-failed");
    const failedTask = createWorkspaceTask({
      ...hostContext(failed.id, failed.revision),
      taskId: "cognition-root-replay-failed-task",
      title: "Cognition failed task",
    });
    const failedSummary = "Cognition root failed";
    const failedOperationKey = "cognition-root-failed-operation";
    const failedReservation = receiptReservation(
      failed.id,
      failedOperationKey,
      "submit_root_result",
      workspaceTurnId(failed.id),
    );
    const failedFirst = submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(failed.id, failed.revision + 1),
        taskId: failedTask.id,
        summary: failedSummary,
        state: "failed",
      },
      cognitionProgressFactory(failedTask.id, "failed", failed.revision + 1, [], failedReservation),
    );
    const failedReplay = submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(failed.id, failed.revision + 2),
        taskId: failedTask.id,
        summary: failedSummary,
        state: "failed",
      },
      cognitionProgressFactory(failedTask.id, "failed", failed.revision + 2, [], failedReservation),
    );
    expect(failedReplay.workspaceRevision).toBe(failedFirst.workspaceRevision);
    expect(failedReplay.state.workspaceRevision).toBe(failedFirst.state.workspaceRevision);
    expect(failedReplay.operationKey).toBe(failedOperationKey);
    expect(getDb().query("SELECT revision FROM agent_turn_workspaces WHERE workspace_id = ?").get(failed.id))
      .toEqual({ revision: failed.revision + 2 });
    expect(getDb().query("SELECT revision, cas_owner FROM agent_workspace_tasks WHERE task_id = ?").get(failedTask.id))
      .toEqual({ revision: 1, cas_owner: failedOperationKey });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_submissions WHERE task_id = ?").get(failedTask.id))
      .toEqual({ count: 0 });
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(failed.id, failed.revision + 2),
        taskId: failedTask.id,
        summary: failedSummary,
        state: "failed",
        retention: "turn_terminal",
        ttlSeconds: 10,
      },
      cognitionProgressFactory(failedTask.id, "failed", failed.revision + 2, [], failedReservation),
    ));
  });

  test("cognition root settlement requires the requested terminal transition", () => {
    const failed = isolatedWorkspace("cognition-root-transition-failed");
    const failedTask = createWorkspaceTask({
      ...hostContext(failed.id, failed.revision),
      taskId: "cognition-root-transition-failed-task",
      title: "Cognition root failed task",
    });
    expectWorkspaceError("invalid_state", () => submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(failed.id, failed.revision + 1),
        taskId: failedTask.id,
        summary: "Failed root result",
        state: "failed",
      },
      cognitionProgressFactory(failedTask.id, "completed", failed.revision + 1, [], receiptReservation(failed.id, "cognition-root-failed-invalid-completed", "submit_root_result", workspaceTurnId(failed.id))),
    ));
    expect(getDb().query("SELECT state, revision FROM agent_workspace_tasks WHERE task_id = ?").get(failedTask.id))
      .toEqual({ state: "active", revision: 0 });

    const completed = isolatedWorkspace("cognition-root-transition-completed");
    const completedTask = createWorkspaceTask({
      ...hostContext(completed.id, completed.revision),
      taskId: "cognition-root-transition-completed-task",
      title: "Cognition root completed task",
    });
    expectWorkspaceError("invalid_state", () => submitWorkspaceRootResultWithCognition(
      {
        ...rootContext(completed.id, completed.revision + 1),
        taskId: completedTask.id,
        summary: "Completed root result",
        state: "completed",
      },
      cognitionProgressFactory(completedTask.id, "failed", completed.revision + 1, [], receiptReservation(completed.id, "cognition-root-completed-invalid-failed", "submit_root_result", workspaceTurnId(completed.id))),
    ));
    expect(getDb().query("SELECT state, revision FROM agent_workspace_tasks WHERE task_id = ?").get(completedTask.id))
      .toEqual({ state: "active", revision: 0 });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_workspace_submissions WHERE task_id = ?").get(completedTask.id))
      .toEqual({ count: 0 });
  });
  test("bounds cognition operational task IDs for the admitted turn limit", () => {
    const ambiguousLeft = deriveCognitionOperationalTaskId("a:b", "c");
    const ambiguousRight = deriveCognitionOperationalTaskId("a", "b:c");
    expect(ambiguousLeft).not.toBe(ambiguousRight);
    expect(new TextEncoder().encode(ambiguousLeft).byteLength).toBeLessThanOrEqual(128);
    expect(new TextEncoder().encode(ambiguousRight).byteLength).toBeLessThanOrEqual(128);
    const maxTurnId = "t".repeat(128);
    insertTurnExecution(maxTurnId, "long-turn-generation", "long-turn-commit");
    const created = workspace("cognition-long-turn", maxTurnId);
    const templates: readonly TaskTemplateV1[] = [
      { id: "template-a", required: false },
      { id: "template-b", required: false },
    ];
    const result = createWorkspaceTaskWithCognition(
      {
        userId: USER,
        chatId: CHAT,
        turnId: maxTurnId,
        workspaceId: created.id,
        actor: "root",
        frameId: maxTurnId,
        expectedRevision: created.revision,
        taskId: "long-turn-root-task",
        title: "Long turn root task",
        dependencyIds: [],
        assignedFrameId: null,
      },
      cognitionProgressFactory("long-turn-root-task", "active", created.revision, templates, receiptReservation(created.id, "long-turn-create-task", "create_task", maxTurnId)),
    );
    expect(result.materializedTaskIds).toHaveLength(templates.length);
    expect(new Set(result.materializedTaskIds).size).toBe(templates.length);
    for (const taskId of result.materializedTaskIds) {
      expect(new TextEncoder().encode(taskId).byteLength).toBeLessThanOrEqual(128);
      expect(taskId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    }
    const rows = getDb().query(
      "SELECT task_id, cognition_template_id FROM agent_workspace_tasks WHERE workspace_id = ? AND cognition_template_id IS NOT NULL ORDER BY cognition_template_id",
    ).all(created.id) as Array<{ task_id: string; cognition_template_id: string }>;
    expect(new Set(rows.map((row) => row.task_id))).toEqual(new Set(result.materializedTaskIds));
    expect(rows.map((row) => row.cognition_template_id)).toEqual(["template-a", "template-b"]);
    expect(rows.map((row) => row.task_id)).toEqual([...result.materializedTaskIds]);
    expectWorkspaceError("quota_exceeded", () => createTurnWorkspace({
      userId: USER,
      chatId: CHAT,
      turnId: `${maxTurnId}x`,
      workspaceId: "cognition-too-long-turn",
      objective: "Too long",
      constraints: [],
      retention: "chat_lifetime",
      capabilities: { revision: 1, allowed: [], maxOperationBytes: 1, maxOperations: 1 },
    }));
  });
  test("settles an assigned child failure only for the exact frame", () => {
    const created = workspace("child-settlement-boundary");
    const task = createWorkspaceTask({
      ...hostContext(created.id, created.revision),
      taskId: "child-settlement-task",
      title: "Assigned child task",
      assignedFrameId: "child-settlement-frame",
    });
    const failed = settleWorkspaceChildTask({
      ...hostContext(created.id, created.revision + 1),
      taskId: task.id,
      assignedFrameId: "child-settlement-frame",
      state: "failed",
    });
    expect(failed.state).toBe("failed");
    const replay = settleWorkspaceChildTask({
      ...hostContext(created.id, created.revision + 2),
      taskId: task.id,
      assignedFrameId: "child-settlement-frame",
      state: "failed",
    });
    expect(replay.state).toBe("failed");
    expectWorkspaceError("task_assignment_conflict", () => settleWorkspaceChildTask({
      ...hostContext(created.id, created.revision + 2),
      taskId: task.id,
      assignedFrameId: "child-settlement-frame",
      state: "cancelled",
    }));
    expectWorkspaceError("child_confinement", () => settleWorkspaceChildTask({
      ...hostContext(created.id, created.revision + 2),
      taskId: task.id,
      assignedFrameId: "other-frame",
      state: "failed",
    }));
  });
  test("cognition child settlement replays only the exact committed operation", () => {
    const created = workspace("cognition-child-settlement");
    const task = createWorkspaceTask({
      ...hostContext(created.id, created.revision),
      taskId: "cognition-child-settlement-task",
      title: "Cognition child task",
      assignedFrameId: "cognition-child-settlement-frame",
    });
    const operationKey = "child-settlement-operation";
    const settlementReservation = receiptReservation(
      created.id,
      operationKey,
      "settle_child_task",
      workspaceTurnId(created.id),
    );
    const failed = settleWorkspaceChildTaskWithCognition(
      {
        ...hostContext(created.id, created.revision + 1),
        taskId: task.id,
        assignedFrameId: "cognition-child-settlement-frame",
        state: "failed",
      },
      cognitionProgressFactory(task.id, "failed", created.revision + 1, [], settlementReservation),
    );
    expect(failed.workspaceRevision).toBe(created.revision + 2);
    expect(failed).toMatchObject({
      operationKey,
      segmentId: settlementReservation.segmentId,
      logicalDispatch: settlementReservation.logicalDispatch,
      frameId: settlementReservation.frameId,
    });
    expect(getDb().query(
      "SELECT segment_id, logical_dispatch, frame_id FROM agent_work_workspace_receipts WHERE operation_key = ?",
    ).get(operationKey)).toEqual({
      segment_id: settlementReservation.segmentId,
      logical_dispatch: settlementReservation.logicalDispatch,
      frame_id: settlementReservation.frameId,
    });
    expect(getDb().query("SELECT cas_owner FROM agent_workspace_tasks WHERE task_id = ?").get(task.id))
      .toEqual({ cas_owner: operationKey });
    expectWorkspaceError("task_assignment_conflict", () => settleWorkspaceChildTask({
      ...hostContext(created.id, created.revision + 2),
      taskId: task.id,
      assignedFrameId: "cognition-child-settlement-frame",
      state: "failed",
    }));
    expectWorkspaceError("task_assignment_conflict", () => updateWorkspaceTaskProgress({
      ...childContext(created.id, created.revision + 2, "cognition-child-settlement-frame"),
      taskId: task.id,
      state: "active",
      progress: 0.4,
    }));
    expectWorkspaceError("task_assignment_conflict", () => updateWorkspaceTaskProgressWithCognition(
      {
        ...childContext(created.id, created.revision + 2, "cognition-child-settlement-frame"),
        taskId: task.id,
        state: "active",
        progress: 0.4,
      },
      cognitionProgressFactory(task.id, "active", created.revision + 2, [], receiptReservation(created.id, "settled-child-progress-rejected", "update_assigned_progress", "cognition-child-settlement-frame")),
    ));
    const replay = settleWorkspaceChildTaskWithCognition(
      {
        ...hostContext(created.id, created.revision + 2),
        taskId: task.id,
        assignedFrameId: "cognition-child-settlement-frame",
        state: "failed",
      },
      cognitionProgressFactory(task.id, "failed", created.revision + 2, [], settlementReservation),
    );
    expect(replay.workspaceRevision).toBe(created.revision + 2);
    expect(replay.state.workspaceRevision).toBe(created.revision + 2);
    expect(replay).toMatchObject({
      operationKey,
      segmentId: settlementReservation.segmentId,
      logicalDispatch: settlementReservation.logicalDispatch,
      frameId: settlementReservation.frameId,
    });
    expectWorkspaceError("task_assignment_conflict", () => settleWorkspaceChildTaskWithCognition(
      {
        ...hostContext(created.id, created.revision + 2),
        taskId: task.id,
        assignedFrameId: "cognition-child-settlement-frame",
        state: "failed",
      },
      cognitionProgressFactory(task.id, "failed", created.revision + 2, [], receiptReservation(created.id, "different-settlement-operation", "settle_child_task", workspaceTurnId(created.id))),
    ));
    expectWorkspaceError("child_confinement", () => settleWorkspaceChildTaskWithCognition(
      {
        ...hostContext(created.id, created.revision + 2),
        taskId: task.id,
        assignedFrameId: "different-settlement-frame",
        state: "failed",
      },
      cognitionProgressFactory(task.id, "failed", created.revision + 2, [], settlementReservation),
    ));
    expectWorkspaceError("task_assignment_conflict", () => settleWorkspaceChildTaskWithCognition(
      {
        ...hostContext(created.id, created.revision + 2),
        taskId: task.id,
        assignedFrameId: "cognition-child-settlement-frame",
        state: "cancelled",
      },
      cognitionProgressFactory(task.id, "cancelled", created.revision + 2, [], settlementReservation),
    ));
  });
  test("normal and cognition child results cannot resurrect terminal host settlements", () => {
    const normalFailed = isolatedWorkspace("child-result-after-failure");
    const normalFailedTask = createWorkspaceTask({
      ...hostContext(normalFailed.id, normalFailed.revision),
      taskId: "child-result-after-failure-task",
      title: "Failed child task",
      assignedFrameId: "child-result-after-failure-frame",
    });
    settleWorkspaceChildTask({
      ...hostContext(normalFailed.id, normalFailed.revision + 1),
      taskId: normalFailedTask.id,
      assignedFrameId: "child-result-after-failure-frame",
      state: "failed",
    });
    expectWorkspaceError("task_assignment_conflict", () => updateWorkspaceTaskProgress({
      ...childContext(normalFailed.id, normalFailed.revision + 2, "child-result-after-failure-frame"),
      taskId: normalFailedTask.id,
      state: "active",
      progress: 0.4,
    }));
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceChildResult({
      ...childContext(normalFailed.id, normalFailed.revision + 2, "child-result-after-failure-frame"),
      taskId: normalFailedTask.id,
      summary: "late child result",
      resultDigest: "a".repeat(64),
      byteCount: 1,
    }));

    const normalCancelled = isolatedWorkspace("child-result-after-cancellation");
    const normalCancelledTask = createWorkspaceTask({
      ...hostContext(normalCancelled.id, normalCancelled.revision),
      taskId: "child-result-after-cancellation-task",
      title: "Cancelled child task",
      assignedFrameId: "child-result-after-cancellation-frame",
    });
    settleWorkspaceChildTask({
      ...hostContext(normalCancelled.id, normalCancelled.revision + 1),
      taskId: normalCancelledTask.id,
      assignedFrameId: "child-result-after-cancellation-frame",
      state: "cancelled",
    });
    expectWorkspaceError("task_assignment_conflict", () => updateWorkspaceTaskProgress({
      ...childContext(normalCancelled.id, normalCancelled.revision + 2, "child-result-after-cancellation-frame"),
      taskId: normalCancelledTask.id,
      state: "active",
      progress: 0.4,
    }));
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceChildResult({
      ...childContext(normalCancelled.id, normalCancelled.revision + 2, "child-result-after-cancellation-frame"),
      taskId: normalCancelledTask.id,
      summary: "late cancelled result",
      resultDigest: "b".repeat(64),
      byteCount: 1,
    }));
    const normalCompleted = isolatedWorkspace("child-result-after-completion");
    const normalCompletedTask = createWorkspaceTask({
      ...hostContext(normalCompleted.id, normalCompleted.revision),
      taskId: "child-result-after-completion-task",
      title: "Completed child task",
      assignedFrameId: "child-result-after-completion-frame",
    });
    getDb().query("UPDATE agent_workspace_tasks SET state = 'completed', progress = 1, revision = 1 WHERE task_id = ? AND workspace_id = ?")
      .run(normalCompletedTask.id, normalCompleted.id);
    expectWorkspaceError("task_assignment_conflict", () => updateWorkspaceTaskProgress({
      ...childContext(normalCompleted.id, normalCompleted.revision + 1, "child-result-after-completion-frame"),
      taskId: normalCompletedTask.id,
      state: "active",
      progress: 0.4,
    }));
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceChildResult({
      ...childContext(normalCompleted.id, normalCompleted.revision + 1, "child-result-after-completion-frame"),
      taskId: normalCompletedTask.id,
      summary: "late completed child result",
      resultDigest: "e".repeat(64),
      byteCount: 1,
    }));


    const cognitionFailed = isolatedWorkspace("cognition-result-after-failure");
    const cognitionFailedTask = createWorkspaceTask({
      ...hostContext(cognitionFailed.id, cognitionFailed.revision),
      taskId: "cognition-result-after-failure-task",
      title: "Cognition failed child task",
      assignedFrameId: "cognition-result-after-failure-frame",
    });
    settleWorkspaceChildTask({
      ...hostContext(cognitionFailed.id, cognitionFailed.revision + 1),
      taskId: cognitionFailedTask.id,
      assignedFrameId: "cognition-result-after-failure-frame",
      state: "failed",
    });
    expectWorkspaceError("task_assignment_conflict", () => updateWorkspaceTaskProgressWithCognition(
      {
        ...childContext(cognitionFailed.id, cognitionFailed.revision + 2, "cognition-result-after-failure-frame"),
        taskId: cognitionFailedTask.id,
        state: "active",
        progress: 0.4,
      },
      cognitionProgressFactory(cognitionFailedTask.id, "active", cognitionFailed.revision + 2, [], receiptReservation(cognitionFailed.id, "late-failed-progress", "update_assigned_progress", "cognition-result-after-failure-frame")),
    ));
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceChildResultWithCognition(
      {
        ...childContext(cognitionFailed.id, cognitionFailed.revision + 2, "cognition-result-after-failure-frame"),
        taskId: cognitionFailedTask.id,
        summary: "late cognition result",
        resultDigest: "c".repeat(64),
        byteCount: 1,
      },
      cognitionProgressFactory(cognitionFailedTask.id, "completed", cognitionFailed.revision + 2, [], receiptReservation(cognitionFailed.id, "late-failed-result", "submit_child_result", "cognition-result-after-failure-frame")),
    ));

    const cognitionCancelled = isolatedWorkspace("cognition-result-after-cancellation");
    const cognitionCancelledTask = createWorkspaceTask({
      ...hostContext(cognitionCancelled.id, cognitionCancelled.revision),
      taskId: "cognition-result-after-cancellation-task",
      title: "Cognition cancelled child task",
      assignedFrameId: "cognition-result-after-cancellation-frame",
    });
    settleWorkspaceChildTask({
      ...hostContext(cognitionCancelled.id, cognitionCancelled.revision + 1),
      taskId: cognitionCancelledTask.id,
      assignedFrameId: "cognition-result-after-cancellation-frame",
      state: "cancelled",
    });
    expectWorkspaceError("task_assignment_conflict", () => updateWorkspaceTaskProgressWithCognition(
      {
        ...childContext(cognitionCancelled.id, cognitionCancelled.revision + 2, "cognition-result-after-cancellation-frame"),
        taskId: cognitionCancelledTask.id,
        state: "active",
        progress: 0.4,
      },
      cognitionProgressFactory(cognitionCancelledTask.id, "active", cognitionCancelled.revision + 2, [], receiptReservation(cognitionCancelled.id, "late-cancelled-progress", "update_assigned_progress", "cognition-result-after-cancellation-frame")),
    ));
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceChildResultWithCognition(
      {
        ...childContext(cognitionCancelled.id, cognitionCancelled.revision + 2, "cognition-result-after-cancellation-frame"),
        taskId: cognitionCancelledTask.id,
        summary: "late cognition cancelled result",
        resultDigest: "d".repeat(64),
        byteCount: 1,
      },
      cognitionProgressFactory(cognitionCancelledTask.id, "completed", cognitionCancelled.revision + 2, [], receiptReservation(cognitionCancelled.id, "late-cancelled-result", "submit_child_result", "cognition-result-after-cancellation-frame")),
    ));
    const cognitionCompleted = isolatedWorkspace("cognition-result-after-completion");
    const cognitionCompletedTask = createWorkspaceTask({
      ...hostContext(cognitionCompleted.id, cognitionCompleted.revision),
      taskId: "cognition-result-after-completion-task",
      title: "Cognition completed child task",
      assignedFrameId: "cognition-result-after-completion-frame",
    });
    getDb().query("UPDATE agent_workspace_tasks SET state = 'completed', progress = 1, revision = 1 WHERE task_id = ? AND workspace_id = ?")
      .run(cognitionCompletedTask.id, cognitionCompleted.id);
    expectWorkspaceError("task_assignment_conflict", () => updateWorkspaceTaskProgressWithCognition(
      {
        ...childContext(cognitionCompleted.id, cognitionCompleted.revision + 1, "cognition-result-after-completion-frame"),
        taskId: cognitionCompletedTask.id,
        state: "active",
        progress: 0.4,
      },
      cognitionProgressFactory(cognitionCompletedTask.id, "active", cognitionCompleted.revision + 1, [], receiptReservation(cognitionCompleted.id, "late-completed-progress", "update_assigned_progress", "cognition-result-after-completion-frame")),
    ));
    expectWorkspaceError("task_assignment_conflict", () => submitWorkspaceChildResultWithCognition(
      {
        ...childContext(cognitionCompleted.id, cognitionCompleted.revision + 1, "cognition-result-after-completion-frame"),
        taskId: cognitionCompletedTask.id,
        summary: "late cognition completed result",
        resultDigest: "f".repeat(64),
        byteCount: 1,
      },
      cognitionProgressFactory(cognitionCompletedTask.id, "completed", cognitionCompleted.revision + 1, [], receiptReservation(cognitionCompleted.id, "late-completed-result", "submit_child_result", "cognition-result-after-completion-frame")),
    ));
  });
  test("accepts a child submission, freezes atomically, and rejects later writes", () => {
    const created = workspace();
    const task = createWorkspaceTask({ ...rootContext(created.id, 0), taskId: "required-task", title: "Child task", assignedFrameId: "child-frame" });
    const progressed = updateWorkspaceTaskProgress({ ...childContext(created.id, 1), taskId: task.id, state: "blocked", progress: 0.5 });
    expect(progressed.state).toBe("blocked");
    const submitted = submitWorkspaceChildResult({ ...childContext(created.id, 2), taskId: task.id, summary: "bounded child summary", resultDigest: "b".repeat(64), byteCount: 22 });
    expect(submitted.state).toBe("completed");
    const submissionRow = getDb().query("SELECT submission_id, state FROM agent_workspace_submissions WHERE task_id = ?").get(task.id) as { submission_id: string; state: string } | null;
    expect(submissionRow?.state).toBe("submitted");
    const accepted = acceptWorkspaceSubmission({ ...hostContext(created.id, 3), submissionId: submissionRow?.submission_id, taskId: task.id });
    expect(accepted.state).toBe("accepted");
    const frozen = freezeTurnWorkspace(rootContext(created.id, 4));
    expect(frozen.state).toBe("frozen");
    expectWorkspaceError("workspace_frozen", () => recordWorkspaceRecord({ ...rootContext(created.id, frozen.revision), kind: "finding", summary: "too late", digest: "c".repeat(64), taskId: null }));
  });
  test("rechecks persisted required tasks and pending submissions before the freeze CAS", () => {
    const created = workspace("completion-gate-race");
    const required = createWorkspaceTask({
      ...hostContext(created.id, 0),
      taskId: "completion-required",
      title: "Required completion task",
      required: true,
      assignedFrameId: "completion-child",
    });
    const blocked = freezeWorkspaceForCompletionV1(rootContext(created.id, 1));
    expect(blocked).toEqual({ workspaceRevision: 1, accepted: false });
    expect(getTurnWorkspace(rootContext(created.id, 1)).state).toBe("active");
    expect(getWorkspaceCompletionGatesV1(rootContext(created.id, 1)).openRequiredTaskIds).toEqual([required.id]);

    const submitted = submitWorkspaceChildResult({
      ...childContext(created.id, 1, "completion-child"),
      taskId: required.id,
      summary: "bounded completion result",
      resultDigest: "e".repeat(64),
      byteCount: 28,
    });
    expect(submitted.state).toBe("completed");
    expect(getDb().query("SELECT state FROM agent_workspace_submissions WHERE task_id = ?").get(required.id)).toEqual({ state: "submitted" });
    const pending = freezeWorkspaceForCompletionV1(rootContext(created.id, 2));
    expect(pending).toEqual({ workspaceRevision: 2, accepted: false });
    expect(getWorkspaceCompletionGatesV1(rootContext(created.id, 2)).pendingSubmissionCount).toBe(1);

    const submissionRow = getDb().query("SELECT submission_id FROM agent_workspace_submissions WHERE task_id = ?").get(required.id) as { submission_id: string } | null;
    acceptWorkspaceSubmission({ ...hostContext(created.id, 2), submissionId: submissionRow?.submission_id, taskId: required.id });
    const exactPreview = previewWorkspaceForCompletionV1(rootContext(created.id, 3));
    const accepted = freezeWorkspaceForCompletionV1(rootContext(created.id, 3), {
      prepare: (candidate) => (
        candidate.accepted === exactPreview.accepted
        && candidate.workspaceRevision === exactPreview.workspaceRevision
      ),
    });
    expect(accepted).toEqual({ workspaceRevision: 4, accepted: true });
    expect(getTurnWorkspace(rootContext(created.id, 4)).state).toBe("frozen");
  });
  test("blocked required tasks remain completion blockers without an accepted submission", () => {
    const created = workspace("completion-blocked-required");
    const required = createWorkspaceTask({
      ...hostContext(created.id, created.revision),
      taskId: "blocked-required-task",
      title: "Blocked required task",
      required: true,
      assignedFrameId: "blocked-required-child",
    });
    getDb().query("UPDATE agent_workspace_tasks SET state = 'blocked' WHERE task_id = ? AND workspace_id = ?").run(required.id, created.id);

    const gates = getWorkspaceCompletionGatesV1(rootContext(created.id, created.revision + 1));
    expect(gates).toMatchObject({
      accepted: false,
      openRequiredTaskIds: [required.id],
      pendingSubmissionCount: 0,
    });
    expect(previewWorkspaceForCompletionV1(rootContext(created.id, created.revision + 1))).toEqual({
      workspaceRevision: created.revision + 1,
      accepted: false,
    });
    expect(freezeWorkspaceForCompletionV1(rootContext(created.id, created.revision + 1))).toEqual({
      workspaceRevision: created.revision + 1,
      accepted: false,
    });
    expect(getTurnWorkspace(rootContext(created.id, created.revision + 1)).state).toBe("active");
  });

  test("previews immutable completion and rejects stale preparation", () => {
    const created = workspace("completion-preview");
    const preview = previewWorkspaceForCompletionV1(rootContext(created.id, 0));
    expect(Object.isFrozen(preview)).toBe(true);
    expect(preview).toEqual({ workspaceRevision: 1, accepted: true });
    const task = createWorkspaceTask({
      ...hostContext(created.id, 0),
      taskId: "preview-required",
      title: "Required after preview",
      required: true,
    });
    expect(task.id).toBe("preview-required");
    expectWorkspaceError("completion_preparation_failed", () => freezeWorkspaceForCompletionV1(
      rootContext(created.id, 1),
      {
        prepare: (candidate) => (
          candidate.accepted === preview.accepted
          && candidate.workspaceRevision === preview.workspaceRevision
        ),
      },
    ));
    expect(getTurnWorkspace(rootContext(created.id, 1)).state).toBe("active");
    const fresh = previewWorkspaceForCompletionV1(rootContext(created.id, 1));
    expect(fresh).toEqual({ workspaceRevision: 1, accepted: false });
    expect(freezeWorkspaceForCompletionV1(rootContext(created.id, 1))).toEqual(fresh);
    expect(getTurnWorkspace(rootContext(created.id, 1)).state).toBe("active");
  });

  test("persists only redacted workspace records and artifact references", () => {
    const created = workspace();
    const finding = recordWorkspaceRecord({ ...rootContext(created.id, 0), kind: "finding", summary: "bounded finding", digest: "c".repeat(64), taskId: null });
    expect(finding.summary).toBe("bounded finding");
    const artifact = attachWorkspaceArtifactReference({ ...rootContext(created.id, 1), blobDigest: BLOB_DIGEST, byteCount: 3, mimeType: "text/plain", provenance: "root", creatorToken: CREATOR_TOKEN, taskId: null });
    expect(artifact.blobDigest).toBe(BLOB_DIGEST);
    expectWorkspaceError("invalid_input", () => recordWorkspaceRecord({ ...rootContext(created.id, 2), kind: "finding", summary: "x", digest: "d".repeat(64), taskId: null, prose: "private work prose" }));
    const dbText = [getDb().query("SELECT * FROM agent_turn_workspaces").all(), getDb().query("SELECT * FROM agent_workspace_tasks").all(), getDb().query("SELECT * FROM agent_workspace_records").all(), getDb().query("SELECT * FROM agent_workspace_artifacts").all()].map((rows) => JSON.stringify(rows)).join("\n");
    expect(dbText).not.toContain("private work prose");
    expect(dbText).not.toContain("tool arguments");
    expect(getDb().query("SELECT record_id FROM agent_workspace_records WHERE record_id = ?").get(finding.id)).toBeTruthy();
    expect(getDb().query("SELECT artifact_id FROM agent_workspace_artifacts WHERE artifact_id = ?").get(artifact.id)).toBeTruthy();
  });
  test("closes cleanup-before-attach and attach-before-cleanup ordering", () => {
    const created = workspace("artifact-race-before");
    getDb().query("UPDATE agent_artifact_blob_journal SET state = 'removed' WHERE journal_id = ?").run("workspace-journal");
    expectWorkspaceError("not_found", () => attachWorkspaceArtifactReference({ ...rootContext(created.id, 0), blobDigest: BLOB_DIGEST, byteCount: 3, mimeType: "text/plain", provenance: "root", creatorToken: CREATOR_TOKEN, taskId: null }));

    getDb().query("UPDATE agent_artifact_blob_journal SET state = 'installed' WHERE journal_id = ?").run("workspace-journal");
    const artifact = attachWorkspaceArtifactReference({ ...rootContext(created.id, 0), blobDigest: BLOB_DIGEST, byteCount: 3, mimeType: "text/plain", provenance: "root", creatorToken: CREATOR_TOKEN, taskId: null });
    const claim = getDb().query(`UPDATE agent_artifact_blob_journal
      SET state = 'removed'
      WHERE journal_id = ? AND state = 'installed'
        AND NOT EXISTS (
          SELECT 1 FROM agent_workspace_artifacts
          WHERE user_id = ? AND blob_digest = ?
        )`).run("workspace-journal", USER, BLOB_DIGEST);
    expect(claim.changes).toBe(0);
    expect(getDb().query("SELECT artifact_id FROM agent_workspace_artifacts WHERE artifact_id = ?").get(artifact.id)).toBeTruthy();
    expect(getDb().query("SELECT state FROM agent_artifact_blob_journal WHERE journal_id = ?").get("workspace-journal")).toEqual({ state: "installed" });
  });
  test("rejects workspace artifact publication before a committed receipt", () => {
    const created = workspace("publish-receipt-required");
    const artifact = attachWorkspaceArtifactReference({
      ...rootContext(created.id, 0),
      blobDigest: BLOB_DIGEST,
      byteCount: 3,
      mimeType: "text/plain",
      provenance: "root",
      creatorToken: CREATOR_TOKEN,
      taskId: null,
    });
    proposeWorkspacePublication({ ...rootContext(created.id, 1), artifactId: artifact.id });
    const frozen = freezeTurnWorkspace(hostContext(created.id, 2));
    expectWorkspaceError("forbidden", () => publishWorkspaceArtifact({
      ...rootContext(created.id, frozen.revision),
      artifactId: artifact.id,
    }));
    expect(getDb().query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(artifact.id)).toEqual({ publication_state: "proposed" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE source_artifact_id = ?").get(artifact.id)).toEqual({ count: 0 });
  });

  test("attach-only artifacts stay ephemeral", () => {
    const attachedWorkspace = workspace("publish-attach-only");
    const attached = attachWorkspaceArtifactReference({
      ...rootContext(attachedWorkspace.id, 0),
      blobDigest: BLOB_DIGEST,
      byteCount: 3,
      mimeType: "text/plain",
      provenance: "root",
      taskId: null,
      creatorToken: CREATOR_TOKEN,
    });
    const attachedFrozen = freezeTurnWorkspace(hostContext(attachedWorkspace.id, 1));
    getDb().query(
      `INSERT INTO agent_turn_commit_receipts
        (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id,
         commit_key, idempotency_key, summary_digest, summary_json, artifact_ref_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("receipt-attach-only", TURN, TURN, attachedWorkspace.id, USER, CHAT, "commit-attach-only", "idempotency-attach-only", "c".repeat(64), "{}", 0);
    expectWorkspaceError("forbidden", () => publishWorkspaceArtifact({
      ...rootContext(attachedWorkspace.id, attachedFrozen.revision),
      artifactId: attached.id,
      receiptId: "receipt-attach-only",
    }));
    expect(getDb().query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(attached.id)).toEqual({ publication_state: "attached" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE source_artifact_id = ?").get(attached.id)).toEqual({ count: 0 });
  });

  test("rejects exported publication of proposed artifacts", () => {
    const proposedWorkspace = workspace("publish-explicit-proposal");
    const proposed = attachWorkspaceArtifactReference({
      ...rootContext(proposedWorkspace.id, 0),
      blobDigest: BLOB_DIGEST,
      byteCount: 3,
      mimeType: "text/plain",
      provenance: "root",
      taskId: null,
      creatorToken: CREATOR_TOKEN,
    });
    proposeWorkspacePublication({ ...rootContext(proposedWorkspace.id, 1), artifactId: proposed.id });
    const proposedFrozen = freezeTurnWorkspace(hostContext(proposedWorkspace.id, 2));
    expectWorkspaceError("forbidden", () => publishWorkspaceArtifact({
      ...rootContext(proposedWorkspace.id, proposedFrozen.revision),
      artifactId: proposed.id,
      receiptId: "receipt-explicit-proposal",
    }));
    expect(getDb().query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(proposed.id)).toEqual({ publication_state: "proposed" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE source_artifact_id = ?").get(proposed.id)).toEqual({ count: 0 });
  });

  test("publishes a frozen workspace artifact through canonical commit and permits exact replay", () => {
    const created = workspace("publish-receipt-valid");
    const artifact = attachWorkspaceArtifactReference({
      ...rootContext(created.id, 0),
      blobDigest: BLOB_DIGEST,
      byteCount: 3,
      mimeType: "text/plain",
      provenance: "root",
      taskId: null,
      creatorToken: CREATOR_TOKEN,
    });
    proposeWorkspacePublication({ ...rootContext(created.id, 1), artifactId: artifact.id });
    const frozen = freezeTurnWorkspace(hostContext(created.id, 2));
    getDb().query(
      `INSERT INTO agent_turn_commit_receipts
        (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id,
         commit_key, idempotency_key, summary_digest, summary_json, artifact_ref_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("receipt-publish-valid", TURN, TURN, created.id, USER, CHAT, "commit-publish-valid", "idempotency-publish-valid", "b".repeat(64), "{}", 1);
    getDb().transaction(() => publishArtifactCommit(getDb(), {
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      executionId: TURN,
      workspaceId: created.id,
      commitKey: "commit-publish-valid",
      receiptId: "receipt-publish-valid",
      targetMessageId: null,
      targetSwipeId: null,
      refs: [{
        digest: BLOB_DIGEST,
        byteCount: 3,
        mimeType: "text/plain",
        provenance: "root",
        retention: "chat_lifetime",
        messageId: null,
        swipeId: null,
        workspaceArtifactId: artifact.id,
      }],
      assertFence: () => {},
    }))();
    expect(getDb().query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(artifact.id)).toEqual({ publication_state: "published" });
    expect(publishWorkspaceArtifact({
      ...rootContext(created.id, frozen.revision),
      artifactId: artifact.id,
      receiptId: "receipt-publish-valid",
    }).publicationState).toBe("published");
    expectWorkspaceError("forbidden", () => publishWorkspaceArtifact({
      ...rootContext(created.id, frozen.revision),
      artifactId: artifact.id,
      receiptId: "receipt-publish-wrong",
    }));
  });

  test("publishes distinct operational objective selections at one source revision", () => {
    insertTurnExecution(TURN_A, "workspace-generation-a", "workspace-commit-a");
    insertTurnExecution(TURN_B, "workspace-generation-b", "workspace-commit-b");
    insertTurnAttempt(TURN_A);
    insertTurnAttempt(TURN_B);
    const operationalA = workspace("operational-objective-a", TURN_A, "Objective A");
    const operationalB = workspace("operational-objective-b", TURN_B, "Objective B");
    const persistent = createPersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: "stable-objective-workspace",
      objective: "Stable objective",
    });
    const sessionA = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: persistent.id,
      turnSessionId: "objective-session-a",
      turnId: TURN_A,
      attemptId: TURN_A,
      executionId: TURN_A,
      expectedRevision: persistent.revision,
    });
    const sessionB = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: persistent.id,
      turnSessionId: "objective-session-b",
      turnId: TURN_B,
      attemptId: TURN_B,
      executionId: TURN_B,
      expectedRevision: persistent.revision,
    });
    const first = publishPersistentWorkspaceSelection(
      persistentPublicationInput(persistent.id, persistent.revision, "objective", operationalA.id, 0),
    );
    const second = publishPersistentWorkspaceSelection(
      persistentPublicationInput(persistent.id, first.revision, "objective", operationalB.id, 0),
    );
    expect(first.sourceId).toBe(operationalA.id);
    expect(first.sourceRevision).toBe(0);
    expect(first.sourceProvenance.turnSessionId).toBe(sessionA.id);
    expect(first.copy).toMatchObject({ category: "objective", id: operationalA.id, objective: "Objective A" });
    expect(second.sourceId).toBe(operationalB.id);
    expect(second.sourceRevision).toBe(0);
    expect(second.sourceProvenance.turnSessionId).toBe(sessionB.id);
    expect(second.copy).toMatchObject({ category: "objective", id: operationalB.id, objective: "Objective B" });
    expect(first.id).not.toBe(second.id);
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(persistent.id)).toEqual({ count: 2 });
  });
  test("publishes turn-scoped sources through stable workspace sessions", () => {
    insertTurnExecution(TURN_A, "workspace-generation-a", "workspace-commit-a");
    insertTurnExecution(TURN_B, "workspace-generation-b", "workspace-commit-b");
    insertTurnAttempt(TURN_A);
    insertTurnAttempt(TURN_B);
    const operationalA = workspace("operational-turn-a", TURN_A);
    const operationalB = workspace("operational-turn-b", TURN_B);
    const persistent = createPersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: "stable-two-turn-workspace",
      objective: "Stable workspace",
    });
    const sessionA = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: persistent.id,
      turnSessionId: "stable-turn-session-a",
      turnId: TURN_A,
      attemptId: TURN_A,
      executionId: TURN_A,
      expectedRevision: persistent.revision,
    });
    const sessionB = createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: persistent.id,
      turnSessionId: "stable-turn-session-b",
      turnId: TURN_B,
      attemptId: TURN_B,
      executionId: TURN_B,
      expectedRevision: persistent.revision,
    });
    insertOperationalTask(operationalA.id, "stable-turn-task-a", TURN_A);
    insertOperationalTask(operationalB.id, "stable-turn-task-b", TURN_B);

    const first = publishPersistentWorkspaceSelection(
      persistentPublicationInput(persistent.id, persistent.revision, "task", "stable-turn-task-a", 4),
    );
    const second = publishPersistentWorkspaceSelection(
      persistentPublicationInput(persistent.id, first.revision, "task", "stable-turn-task-b", 4),
    );
    expect(first.sourceProvenance.turnSessionId).toBe(sessionA.id);
    expect(second.sourceProvenance.turnSessionId).toBe(sessionB.id);
    expect(first.copy).toMatchObject({ category: "task", id: "stable-turn-task-a" });
    expect(second.copy).toMatchObject({ category: "task", id: "stable-turn-task-b" });
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(persistent.id)).toEqual({ count: 2 });
  });


  test("publishes an exact operational task revision", () => {
    const fixture = persistentFixture("publication-task", { attemptId: "publication-task-attempt", executionId: "publication-task-execution" });
    insertOperationalTask(fixture.persistent.id);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-task", 4),
    );
    expect(publication.copy).toMatchObject({ category: "task", id: "publication-task", title: "Published task", objective: "Task objective", summary: "Task summary" });
    expect(publication.sourceCreatedAt).toBe(10);
    expect(publication.sourceUpdatedAt).toBe(20);
    expect(publication.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(publication.sourceProvenance).toMatchObject({
      turnSessionId: fixture.session.id,
      attemptId: "publication-task-attempt",
      executionId: "publication-task-execution",
    });
  });

  test("publishes an exact operational finding revision and excludes submission-shaped content", () => {
    const fixture = persistentFixture("publication-finding");
    insertOperationalFinding(fixture.persistent.id);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "publication-finding", 3),
    );
    expect(publication.copy).toMatchObject({
      category: "finding",
      id: "publication-finding",
      content: { summary: "Published finding", evidenceIds: [], provenance: "frame-publication" },
    });
    expect(publication.sourceCreatedAt).toBe(11);
    expect(publication.sourceUpdatedAt).toBe(11);
    expect(JSON.stringify(publication.copy)).not.toContain("submission");
  });

  test("publishes an exact operational artifact revision with blob provenance", () => {
    const fixture = persistentFixture("publication-artifact");
    insertOperationalArtifact(fixture.persistent.id);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-artifact", 5),
    );
    expect(publication.copy).toMatchObject({ category: "artifact", id: "publication-artifact", blobDigest: BLOB_DIGEST, mimeType: "text/plain", byteCount: 3 });
    expect(publication.sourceCreatedAt).toBe(12);
    expect(publication.sourceUpdatedAt).toBe(22);
    expect(publication.sourceDigest).toBe(BLOB_DIGEST);
  });
  test("acquires one blob reference for an artifact copy and keeps idempotent replay at one", () => {
    const fixture = persistentFixture("publication-artifact-refcount");
    insertOperationalArtifact(fixture.persistent.id, "publication-artifact-refcount-source");
    const input = persistentPublicationInput(
      fixture.persistent.id,
      fixture.persistent.revision,
      "artifact",
      "publication-artifact-refcount-source",
      5,
    );
    const first = publishPersistentWorkspaceSelection(input);
    expect(first.copy).toMatchObject({ category: "artifact", blobDigest: BLOB_DIGEST });
    expect(getDb().query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 1 });
    const second = publishPersistentWorkspaceSelection(input);
    expect(second.id).toBe(first.id);
    expect(getDb().query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 1 });
  });
  test("rejects omitted-revision replay when an immutable copy diverges from the source selection", () => {
    const fixture = persistentFixture("publication-copy-replay-fence");
    const sourceId = "publication-copy-replay-fence-source";
    insertOperationalArtifact(fixture.persistent.id, sourceId);
    const first = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", sourceId, 5),
    );
    const corruptedCopy = JSON.stringify({ ...first.copy, mimeType: "application/stale" });
    const corruptedDigest = createHash("sha256").update(corruptedCopy, "utf8").digest("hex");
    getDb().run("DROP TRIGGER trg_persistent_workspace_publications_immutable_update");
    getDb().query(
      "UPDATE persistent_workspace_publications SET copy_json = ?, copy_digest = ? WHERE publication_id = ?",
    ).run(corruptedCopy, corruptedDigest, first.id);
    expectWorkspaceError("stale_revision", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, first.revision, "artifact", sourceId),
    ));
  });
  test("deletes an artifact publication without deleting its retained blob bytes", () => {
    const fixture = persistentFixture("publication-artifact-delete");
    insertOperationalArtifact(fixture.persistent.id, "publication-artifact-delete-source");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-artifact-delete-source", 5),
    );
    const deleted = deletePersistentWorkspacePublication({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: 1,
      publicationId: publication.id,
    });
    expect(deleted).toMatchObject({ id: fixture.persistent.id, revision: 2, chatId: CHAT });
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(fixture.persistent.id)).toEqual({ count: 0 });
    expect(getDb().query("SELECT published_reference_count, storage_path FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 0, storage_path: artifactPath });
    expect(statSync(artifactPath).size).toBe(ARTIFACT_BYTES.length);
  });

  test("deletes a workspace as an owner-scoped authority and releases publication references", () => {
    const fixture = persistentFixture("workspace-delete-authority");
    insertOperationalArtifact(fixture.persistent.id, "workspace-delete-artifact-source");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "workspace-delete-artifact-source", 5),
    );
    const current = getPersistentWorkspaceForChat({ userId: USER, chatId: CHAT });
    const deleted = deletePersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: current.revision,
    });
    expect(deleted).toEqual({ workspaceId: fixture.persistent.id, deleted: true, publicationCount: 1 });
    expect(getDb().query("SELECT 1 FROM persistent_workspaces WHERE workspace_id = ?").get(fixture.persistent.id)).toBeNull();
    expect(getDb().query("SELECT published_reference_count, storage_path FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 0, storage_path: artifactPath });
    expect(statSync(artifactPath).size).toBe(ARTIFACT_BYTES.length);
    expect(publication.copy).toMatchObject({ category: "artifact", blobDigest: BLOB_DIGEST });
  });

  test("rejects an artifact copy when its immutable bytes are missing", () => {
    const fixture = persistentFixture("publication-artifact-missing-bytes");
    insertOperationalArtifact(fixture.persistent.id, "publication-artifact-missing-source");
    rmSync(artifactPath, { force: true });
    expect(() => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-artifact-missing-source", 5),
    )).toThrow();
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(fixture.persistent.id)).toEqual({ count: 0 });
    expect(getDb().query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 0 });
  });

  test("rejects submission and unknown publication categories", () => {
    const fixture = persistentFixture("publication-category-rejection");
    expectWorkspaceError("invalid_input", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "submission", "submission-1"),
    ));
    expectWorkspaceError("invalid_input", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "transcript", "transcript-1"),
    ));
  });

  test("rejects stale source revisions and owner/session mismatches", () => {
    const fixture = persistentFixture("publication-association");
    insertOperationalTask(fixture.persistent.id, "publication-association-task");
    expectWorkspaceError("stale_revision", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-association-task", 3),
    ));
    expectWorkspaceError("not_found", () => publishPersistentWorkspaceSelection({
      ...persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-association-task", 4),
      actor: { kind: "owner" as const, userId: OTHER_USER },
      userId: OTHER_USER,
    }));
    getDb().query("UPDATE agent_workspace_tasks SET turn_id = ? WHERE task_id = ?").run(OTHER_TURN, "publication-association-task");
    expectWorkspaceError("not_found", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-association-task", 4),
    ));
  });

  test("replays the same publication idempotently without a second content row", () => {
    const fixture = persistentFixture("publication-idempotency");
    insertOperationalFinding(fixture.persistent.id, "publication-idempotent-finding");
    const first = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "publication-idempotent-finding", 3),
    );
    const second = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "publication-idempotent-finding", 3),
    );
    expect(second.id).toBe(first.id);
    expect(second.copy).toEqual(first.copy);
    expect(second.sourceProvenance).toEqual(first.sourceProvenance);
    expect(getDb().query("SELECT revision FROM persistent_workspaces WHERE workspace_id = ?").get(fixture.persistent.id)).toEqual({ revision: 1 });
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?").get(fixture.persistent.id)).toEqual({ count: 1 });
    insertOperationalTask(fixture.persistent.id, "publication-idempotent-task");
    expectWorkspaceError("stale_revision", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", "publication-idempotent-task", 4),
    ));
  });
  test("resolves omitted source revisions against the current source before replay", () => {
    const fixture = persistentFixture("publication-current-source-replay");
    const sourceId = "publication-current-source-task";
    insertOperationalTask(fixture.persistent.id, sourceId);

    const first = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", sourceId),
    );
    expect(first.sourceRevision).toBe(4);
    expect(first.copy).toMatchObject({ category: "task", summary: "Task summary" });

    getDb().query(
      "UPDATE agent_workspace_tasks SET revision = ?, summary = ?, updated_at = ? WHERE task_id = ?",
    ).run(5, "Updated task summary", 30, sourceId);
    const second = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, first.revision, "task", sourceId),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.sourceRevision).toBe(5);
    expect(second.copy).toMatchObject({ category: "task", summary: "Updated task summary" });
    expect(second.sourceDigest).not.toBe(first.sourceDigest);
    const workspaceAfterSecond = getPersistentWorkspaceById({
      userId: USER,
      workspaceId: fixture.persistent.id,
    });
    expect(workspaceAfterSecond.revision).toBe(2);

    getDb().query("UPDATE agent_workspace_tasks SET summary = ? WHERE task_id = ?").run("Mutated without revision", sourceId);
    expectWorkspaceError("stale_revision", () => publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, workspaceAfterSecond.revision, "task", sourceId),
    ));

    const deleted = deletePersistentWorkspacePublication({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: workspaceAfterSecond.revision,
      publicationId: second.id,
    });
    expect(deleted.revision).toBe(workspaceAfterSecond.revision + 1);
    const remaining = listPersistentWorkspacePublications({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: deleted.revision,
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(first.id);
    expect(remaining[0]?.sourceRevision).toBe(4);

  });
  test("rolls back when a source mutates during publication commit", () => {
    const fixture = persistentFixture("publication-source-commit-race");
    const sourceId = "publication-source-commit-race-task";
    insertOperationalTask(fixture.persistent.id, sourceId);
    getDb().run(`CREATE TRIGGER publication_source_commit_race
      BEFORE INSERT ON persistent_workspace_publications
      BEGIN
        UPDATE agent_workspace_tasks
           SET summary = 'Mutated during publication commit'
         WHERE task_id = 'publication-source-commit-race-task';
      END`);
    try {
      expectWorkspaceError("stale_revision", () => publishPersistentWorkspaceSelection(
        persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", sourceId),
      ));
    } finally {
      getDb().run("DROP TRIGGER publication_source_commit_race");
    }
    expect(getDb().query(
      "SELECT revision, summary FROM agent_workspace_tasks WHERE task_id = ?",
    ).get(sourceId)).toEqual({ revision: 4, summary: "Task summary" });
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE workspace_id = ?",
    ).get(fixture.persistent.id)).toEqual({ count: 0 });
    expect(getPersistentWorkspaceById({
      userId: USER,
      workspaceId: fixture.persistent.id,
    }).revision).toBe(0);
  });

  test("keeps owner ad-hoc tasks optional and requires opaque host authority for admission", () => {
    const fixture = persistentFixture("persistent-task-authority");
    const ownerScope = {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
    };
    const optional = createPersistentWorkspaceTask(ownerScope, {
      id: "owner-optional-task",
      title: "Optional owner task",
      objective: "Owner-provided bounded work",
      required: false,
    });
    const current = getPersistentWorkspaceForChat({ userId: USER, chatId: CHAT });
    expect(optional).toMatchObject({ required: false, creator: "owner", hostAdmitted: false });
    expectWorkspaceError("forbidden", () => createPersistentWorkspaceTask(
      { ...ownerScope, expectedRevision: optional.revision + 1 },
      { title: "Required without host", required: true },
    ));
    expectWorkspaceError("invalid_input", () => createPersistentWorkspaceTask(
      { ...ownerScope, expectedRevision: optional.revision },
      { title: "Forged host task", required: true, creator: "host", hostAdmitted: true } as unknown,
    ));

    const authority = createPersistentWorkspaceHostAuthority();
    expect(Object.isFrozen(authority)).toBe(true);
    expectWorkspaceError("forbidden", () => createPersistentWorkspaceHostTask(
      JSON.parse(JSON.stringify(authority)),
      {
        ...ownerScope,
        expectedRevision: optional.revision,
        title: "Cloned authority",
        required: true,
      },
    ));
    const admitted = createPersistentWorkspaceHostTask(authority, {
      ...ownerScope,
      expectedRevision: current.revision,
      id: "host-required-task",
      title: "Host-required task",
      required: true,
    });
    expect(admitted).toMatchObject({ required: true, creator: "host", hostAdmitted: true });
  });

  test("maps cross-workspace persistent task ID collisions to duplicate_id", () => {
    const first = persistentFixture("persistent-global-task-id-first");
    otherWorkspace("persistent-global-task-id-operational-second");
    const second = createPersistentWorkspace({
      userId: USER,
      chatId: OTHER_CHAT,
      workspaceId: "persistent-global-task-id-second",
      objective: "persistent placeholder",
    });
    const authority = createPersistentWorkspaceHostAuthority();
    createPersistentWorkspaceHostTask(authority, {
      userId: USER,
      chatId: CHAT,
      workspaceId: first.persistent.id,
      expectedRevision: first.persistent.revision,
      id: "persistent-global-task-id",
      title: "First workspace task",
      required: true,
    });
    expectWorkspaceError("duplicate_id", () => createPersistentWorkspaceHostTask(authority, {
      userId: USER,
      chatId: OTHER_CHAT,
      workspaceId: second.id,
      expectedRevision: second.revision,
      id: "persistent-global-task-id",
      title: "Second workspace task",
      required: true,
    }));
  });

  test("derives publication attribution from the authenticated actor", () => {
    const fixture = persistentFixture("publication-attribution");
    insertOperationalFinding(fixture.persistent.id, "publication-owner-finding", "Owner finding");
    const ownerPublication = publishPersistentWorkspaceSelection(
      { kind: "owner", userId: USER },
      {
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: fixture.persistent.revision,
        category: "finding",
        sourceId: "publication-owner-finding",
        sourceRevision: 3,
      },
    );
    expect(ownerPublication.publishedBy).toBe(`owner:${USER}`);
    expect(ownerPublication.sourceProvenance.creator).toBe(`owner:${USER}`);
    expectWorkspaceError("invalid_input", () => publishPersistentWorkspaceSelection({
      ...persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "publication-owner-finding", 3),
      publishedBy: "attacker",
    } as unknown));

    insertOperationalFinding(fixture.persistent.id, "publication-host-finding", "Host finding");
    const hostPublication = publishPersistentWorkspaceSelection(
      { kind: "host", authority: createPersistentWorkspaceHostAuthority() },
      {
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: ownerPublication.revision,
        category: "finding",
        sourceId: "publication-host-finding",
        sourceRevision: 3,
      },
    );
    expect(hostPublication.publishedBy).toBe("host");
    expect(hostPublication.sourceProvenance.creator).toBe("host");
  });

  test("reads detached child inventory and usage by immutable workspace owner identity", () => {
    const fixture = persistentFixture("persistent-detached-inventory");
    const task = createPersistentWorkspaceHostTask(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
      id: "detached-inventory-task",
      title: "Detached inventory task",
      required: true,
    });
    const current = getPersistentWorkspaceById({ userId: USER, workspaceId: fixture.persistent.id });
    const expectedByteCount = current.usage.byteCount + 27;
    getDb().query(`INSERT INTO persistent_workspace_records
      (record_id, workspace_id, turn_session_id, user_id, chat_id, kind, content_json,
       summary, task_id, byte_count, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'finding', ?, ?, ?, 11, 1, 11, 11)`)
      .run("detached-inventory-record", fixture.persistent.id, fixture.session.id, USER, CHAT, JSON.stringify({ summary: "Detached finding", evidenceIds: [], provenance: null }), "Detached finding", task.id);
    getDb().query(`INSERT INTO persistent_workspace_submissions
      (submission_id, workspace_id, turn_session_id, task_id, user_id, chat_id, state,
       summary, result_digest, byte_count, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, 13, 1, 12, 12)`)
      .run("detached-inventory-submission", fixture.persistent.id, fixture.session.id, task.id, USER, CHAT, "Detached submission", "a".repeat(64));
    getDb().query(`INSERT INTO persistent_workspace_artifacts
      (artifact_id, workspace_id, turn_session_id, user_id, chat_id, blob_digest, mime_type,
       byte_count, provenance_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 3, '{}', 1, 13, 13)`)
      .run("detached-inventory-artifact", fixture.persistent.id, fixture.session.id, USER, CHAT, BLOB_DIGEST);
    const preDetachRevision = current.revision;
    getDb().query("DELETE FROM chats WHERE id = ?").run(CHAT);
    expect(getDb().query(
      "SELECT chat_id FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
    ).get(fixture.session.id)).toEqual({ chat_id: null });
    expectWorkspaceError("stale_revision", () => createPersistentWorkspaceTask({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: preDetachRevision,
    }, { title: "Detached owner write" }));

    const context = {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: preDetachRevision + 1,
    };
    const detached = getPersistentWorkspace(context);
    expect(detached.revision).toBe(preDetachRevision + 1);
    expect(detached).toMatchObject({
      id: fixture.persistent.id,
      chatId: null,
      state: "archived",
      usage: { taskCount: 1, recordCount: 1, submissionCount: 1, artifactCount: 1, byteCount: expectedByteCount },
    });
    const tasks = listPersistentWorkspaceTasks(context);
    const records = listPersistentWorkspaceRecords(context);
    const submissions = listPersistentWorkspaceSubmissions(context);
    const artifacts = listPersistentWorkspaceArtifacts(context);
    expect(tasks).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(submissions).toHaveLength(1);
    expect(artifacts).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ chatId: null });
    expect(records[0]).toMatchObject({ chatId: null });
    expect(submissions[0]).toMatchObject({ chatId: null });
    expect(artifacts[0]).toMatchObject({ chatId: null });
    const sessions = listPersistentWorkspaceTurnSessions(context, { limit: 50, offset: 0 });
    expect(sessions).toMatchObject({ total: 1, limit: 50, offset: 0 });
    expect(sessions.data).toHaveLength(1);
    expect(sessions.data[0]).toMatchObject({ id: fixture.session.id, chatId: null, attemptId: fixture.session.attemptId });
  });

  test("leaves publication target links absent when its exact attempt is deleted despite a retry", () => {
    const exactMessageId = "publication-exact-attempt-message";
    const retryMessageId = "publication-retry-attempt-message";
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, content, swipe_id, swipes) VALUES (?, ?, 0, ?, 0, ?)",
    ).run(exactMessageId, CHAT, "Exact attempt source", JSON.stringify(["Exact attempt swipe"]));
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, content, swipe_id, swipes) VALUES (?, ?, 1, ?, 0, ?)",
    ).run(retryMessageId, CHAT, "Retry attempt source", JSON.stringify(["Retry attempt swipe"]));
    const fixture = persistentFixture("publication-exact-attempt-deleted", {
      attemptId: "publication-exact-attempt",
      targetMessageId: exactMessageId,
      targetSwipeId: 0,
    });
    insertTurnAttempt(TURN, {
      attemptId: "publication-retry-attempt",
      previousAttemptId: "publication-exact-attempt",
      runId: "publication-retry-run",
      generationId: "publication-retry-generation",
      targetMessageId: retryMessageId,
      targetSwipeId: 0,
    });
    // The self-FK's ON DELETE SET NULL applies to both columns; detach the
    // retry first because user_id is NOT NULL.
    expect(getDb().query(
      "UPDATE agent_run_attempts SET previous_attempt_id = NULL WHERE user_id = ? AND attempt_id = ?",
    ).run(USER, "publication-retry-attempt").changes).toBe(1);
    expect(getDb().query(
      "DELETE FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).run(USER, "publication-exact-attempt").changes).toBe(1);
    insertOperationalArtifact(fixture.persistent.id, "publication-exact-attempt-artifact");

    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-exact-attempt-artifact", 5),
    );
    expect(publication.sourceProvenance).toMatchObject({
      attemptId: "publication-exact-attempt",
      sourceMessageId: null,
      sourceSwipeId: null,
    });
  });
  test("uses the exact stored execution links rather than a retry when its attempt is deleted", () => {
    const exactMessageId = "publication-execution-exact-message";
    const retryMessageId = "publication-execution-retry-message";
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, content, swipe_id, swipes) VALUES (?, ?, 0, ?, 0, ?)",
    ).run(exactMessageId, CHAT, "Exact execution source", JSON.stringify(["Exact execution swipe"]));
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, content, swipe_id, swipes) VALUES (?, ?, 1, ?, 0, ?)",
    ).run(retryMessageId, CHAT, "Retry execution source", JSON.stringify(["Retry execution swipe"]));
    const fixture = persistentFixture("publication-execution-exact", {
      attemptId: "publication-execution-attempt",
      targetMessageId: exactMessageId,
      targetSwipeId: 0,
    });
    insertTurnAttempt(TURN, {
      attemptId: "publication-execution-retry",
      previousAttemptId: "publication-execution-attempt",
      runId: "publication-execution-retry-run",
      generationId: "publication-execution-retry-generation",
      targetMessageId: retryMessageId,
      targetSwipeId: 0,
    });
    getDb().query(
      "UPDATE agent_turn_executions SET target_message_id = ?, target_swipe_id = 0 WHERE id = ?",
    ).run(exactMessageId, TURN);
    // Avoid the composite self-FK's invalid attempt to null the retry's
    // NOT NULL user_id while removing the exact attempt.
    expect(getDb().query(
      "UPDATE agent_run_attempts SET previous_attempt_id = NULL WHERE user_id = ? AND attempt_id = ?",
    ).run(USER, "publication-execution-retry").changes).toBe(1);
    expect(getDb().query(
      "DELETE FROM agent_run_attempts WHERE user_id = ? AND attempt_id = ?",
    ).run(USER, "publication-execution-attempt").changes).toBe(1);
    insertOperationalArtifact(fixture.persistent.id, "publication-execution-exact-artifact");

    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-execution-exact-artifact", 5),
    );
    expect(publication.sourceProvenance).toMatchObject({
      attemptId: "publication-execution-attempt",
      sourceMessageId: exactMessageId,
      sourceSwipeId: 0,
    });
  });

  test("reads an immutable publication after deleting its source message, swipe, source, and chat", () => {
    const sourceMessageId = "publication-deletion-message";
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, content, swipe_id, swipes) VALUES (?, ?, 0, ?, 0, ?)",
    ).run(sourceMessageId, CHAT, "Published source message", JSON.stringify(["Published source swipe"]));
    getDb().query(
      "UPDATE agent_turn_executions SET target_message_id = ?, target_swipe_id = 0 WHERE id = ?",
    ).run(sourceMessageId, TURN);
    const fixture = persistentFixture("publication-deletion-survival", {
      targetMessageId: sourceMessageId,
      targetSwipeId: 0,
    });
    insertOperationalArtifact(fixture.persistent.id, "publication-deletion-artifact");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", "publication-deletion-artifact", 5),
    );
    expect(publication.sourceProvenance).toMatchObject({ sourceMessageId, sourceSwipeId: 0 });

    getDb().query(
      "UPDATE agent_turn_executions SET target_message_id = NULL, target_swipe_id = NULL WHERE id = ?",
    ).run(TURN);
    getDb().query("UPDATE messages SET swipes = '[]' WHERE id = ?").run(sourceMessageId);
    getDb().query("DELETE FROM messages WHERE id = ?").run(sourceMessageId);
    getDb().query("DELETE FROM agent_workspace_artifacts WHERE artifact_id = ?").run("publication-deletion-artifact");
    getDb().query("DELETE FROM chats WHERE id = ?").run(CHAT);
    expect(getDb().query("PRAGMA foreign_key_check").all()).toEqual([]);

    const listed = listPersistentWorkspacePublications({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: 2,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(publication.id);
    expect(listed[0]?.sourceStatus).toBe("deleted");
    expect(listed[0]?.copy).toEqual(publication.copy);
    expect(listed[0]?.sourceDeletedAt).toEqual(expect.any(Number));
    expect(listed[0]?.sourceProvenance).toMatchObject({
      sourceChatId: CHAT,
      sourceMessageId,
      sourceSwipeId: 0,
      sourceDeletedAt: listed[0]?.sourceDeletedAt,
    });
    const persistedProvenance = getDb().query(
      "SELECT source_deleted_at, source_provenance_json FROM persistent_workspace_publications WHERE publication_id = ?",
    ).get(publication.id) as { source_deleted_at: number | null; source_provenance_json: string };
    expect(persistedProvenance.source_deleted_at).toBe(listed[0]?.sourceDeletedAt);
    expect(JSON.parse(persistedProvenance.source_provenance_json).sourceDeletedAt).toBe(listed[0]?.sourceDeletedAt);
    const reread = listPersistentWorkspacePublications({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: 2,
    });
    expect(reread).toEqual(listed);
    expect(getPersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: 2,
    })).toMatchObject({ id: fixture.persistent.id, chatId: null, state: "archived" });
    expectWorkspaceError("not_found", () => createPersistentWorkspaceHostTurnSession(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      turnSessionId: "detached-session",
      turnId: TURN,
      attemptId: TURN,
      expectedRevision: 2,
    }));
    expect(getDb().query(
      "SELECT published_reference_count, storage_path FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?",
    ).get(USER, BLOB_DIGEST)).toEqual({ published_reference_count: 1, storage_path: artifactPath });
    expect(statSync(artifactPath).size).toBe(ARTIFACT_BYTES.length);
  });
  test("keeps one stable workspace per owner chat across concurrent host admissions", async () => {
    const admissions = await Promise.all(
      Array.from({ length: 8 }, (_, index) => Promise.resolve().then(() => (
        index === 0
          ? ensurePersistentWorkspaceForChat({
            userId: USER,
            chatId: CHAT,
            workspaceId: "chat-stable-workspace",
            objective: "Stable chat workspace",
          })
          : ensurePersistentWorkspaceHost(createPersistentWorkspaceHostAuthority(), {
            userId: USER,
            chatId: CHAT,
            objective: `turn ${index}`,
          })
      ))),
    );
    expect(new Set(admissions.map((workspace) => workspace.id))).toEqual(new Set(["chat-stable-workspace"]));
    expect(admissions.every((workspace) => workspace.chatId === CHAT)).toBe(true);
    expect(getDb().query("SELECT COUNT(*) AS count FROM persistent_workspaces WHERE user_id = ? AND chat_id = ?").get(USER, CHAT)).toEqual({ count: 1 });
    expect(ensurePersistentWorkspaceForChat({
      userId: USER,
      chatId: CHAT,
      objective: "A later turn cannot replace the stable objective",
    })).toMatchObject({
      id: "chat-stable-workspace",
      objective: "Stable chat workspace",
    });
  });

  test("keeps persistent identity and reads fenced to the authenticated owner and chat", () => {
    const fixture = persistentFixture("persistent-scope-fence");
    expect(getPersistentWorkspaceById({ userId: USER, workspaceId: fixture.persistent.id }).id).toBe(fixture.persistent.id);
    expectWorkspaceError("not_found", () => getPersistentWorkspaceById({
      userId: OTHER_USER,
      workspaceId: fixture.persistent.id,
    }));
    expectWorkspaceError("not_found", () => getPersistentWorkspace({
      userId: USER,
      chatId: OTHER_CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
    }));
    expectWorkspaceError("not_found", () => getPersistentWorkspace({
      userId: USER,
      chatId: CHAT,
      workspaceId: "persistent-scope-missing",
      expectedRevision: fixture.persistent.revision,
    }));
  });

  test("fails closed when the turn-attempt schema is unavailable", () => {
    const fixture = persistentFixture("persistent-attempt-schema-unavailable");
    const authority = createPersistentWorkspaceHostAuthority();
    getDb().run("ALTER TABLE agent_run_attempts RENAME TO agent_run_attempts_missing");
    try {
      expectWorkspaceError("schema_unavailable", () => createPersistentWorkspaceHostTurnSession(authority, {
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        turnSessionId: "missing-attempt-session",
        turnId: "missing-attempt-turn",
        attemptId: "missing-attempt-id",
        expectedRevision: fixture.persistent.revision,
      }));
    } finally {
      getDb().run("ALTER TABLE agent_run_attempts_missing RENAME TO agent_run_attempts");
    }
  });

  test("fails closed when a persistent workspace child schema is unavailable", () => {
    const fixture = persistentFixture("persistent-usage-schema-unavailable");
    getDb().run("ALTER TABLE persistent_workspace_tasks RENAME TO persistent_workspace_tasks_missing");
    try {
      expectWorkspaceError("schema_unavailable", () => getPersistentWorkspaceById({
        userId: USER,
        workspaceId: fixture.persistent.id,
      }));
    } finally {
      getDb().run("ALTER TABLE persistent_workspace_tasks_missing RENAME TO persistent_workspace_tasks");
    }
  });

  test("rejects persistent session replay aliases and bounds pagination offsets", () => {
    const fixture = persistentFixture("persistent-session-replay-conflict");
    const authority = createPersistentWorkspaceHostAuthority();
    const base = {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      turnSessionId: fixture.session.id,
      turnId: fixture.session.turnId,
      attemptId: fixture.session.attemptId,
      executionId: fixture.session.executionId,
      expectedRevision: fixture.persistent.revision,
    };
    expect(createPersistentWorkspaceHostTurnSession(authority, base)).toEqual(fixture.session);
    expectWorkspaceError("task_assignment_conflict", () => createPersistentWorkspaceHostTurnSession(authority, {
      ...base,
      turnSessionId: "persistent-session-replay-alias",
    }));
    expectWorkspaceError("task_assignment_conflict", () => createPersistentWorkspaceHostTurnSession(authority, {
      ...base,
      executionId: "persistent-session-replay-execution-alias",
    }));
    expectWorkspaceError("task_assignment_conflict", () => createPersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      turnId: fixture.session.turnId,
      attemptId: fixture.session.attemptId,
      executionId: fixture.session.executionId,
      expectedRevision: fixture.persistent.revision,
    }));
    expectWorkspaceError("task_assignment_conflict", () => createPersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      turnSessionId: fixture.session.id,
      turnId: fixture.session.turnId,
      attemptId: fixture.session.attemptId,
      expectedRevision: fixture.persistent.revision,
    }));

    insertTurnExecution(TURN_A, "persistent-session-replay-generation", "persistent-session-replay-commit");
    insertTurnAttempt(TURN_A);
    expectWorkspaceError("task_assignment_conflict", () => createPersistentWorkspaceHostTurnSession(authority, {
      ...base,
      turnId: TURN_A,
      attemptId: TURN_A,
      executionId: TURN_A,
    }));

    const context = {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
    };
    expectWorkspaceError("invalid_input", () => listPersistentWorkspaceTurnSessions(context, {
      limit: 1,
      offset: -1,
    }));
    expectWorkspaceError("invalid_input", () => listPersistentWorkspaceTurnSessions(context, {
      limit: 1,
      offset: Number.MAX_SAFE_INTEGER + 1,
    }));
    expectWorkspaceError("invalid_input", () => listPersistentWorkspaceTurnSessions(context, {
      limit: 1,
      offset: PERSISTENT_WORKSPACE_MAX_SESSION_OFFSET + 1,
    }));
    expect(listPersistentWorkspaceTurnSessions(context, {
      limit: 1,
      offset: PERSISTENT_WORKSPACE_MAX_SESSION_OFFSET,
    })).toMatchObject({
      total: 1,
      limit: 1,
      offset: PERSISTENT_WORKSPACE_MAX_SESSION_OFFSET,
    });
  });

  test("replays an immutable terminal session after an unrelated workspace revision", () => {
    const fixture = persistentFixture("persistent-terminal-replay-revision");
    const authority = createPersistentWorkspaceHostAuthority();
    const expectedRevision = fixture.persistent.revision;
    const terminal = updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    });
    const unrelated = createPersistentWorkspaceTask({
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision,
    }, {
      id: "terminal-replay-unrelated-task",
      title: "Unrelated revision task",
      objective: "Advance the workspace revision without touching the session",
    });
    expect(unrelated.id).toBe("terminal-replay-unrelated-task");
    expect(getPersistentWorkspaceById({
      userId: USER,
      workspaceId: fixture.persistent.id,
    }).revision).toBe(expectedRevision + 1);
    expect(updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    })).toEqual(terminal);
    expectWorkspaceError("invalid_state", () => updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "failed",
    }));
  });

  test("rejects malformed persisted dependency JSON instead of treating it as an empty graph", () => {
    const fixture = persistentFixture("persistent-corrupt-dependencies");
    const task = createPersistentWorkspaceHostTask(createPersistentWorkspaceHostAuthority(), {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
      id: "corrupt-dependency-task",
      title: "Corrupt dependency task",
    });
    const context = {
      userId: USER,
      chatId: CHAT,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision + 1,
    };
    getDb().query(
      "UPDATE persistent_workspace_tasks SET dependency_ids_json = ? WHERE task_id = ?",
    ).run('{"not":"an-array"}', task.id);
    expectWorkspaceError("invalid_state", () => listPersistentWorkspaceTasks(context));
    getDb().query(
      "UPDATE persistent_workspace_tasks SET dependency_ids_json = ? WHERE task_id = ?",
    ).run('["missing-dependency"]', task.id);
    expectWorkspaceError("invalid_state", () => listPersistentWorkspaceTasks(context));
  });

  test("fails closed when a task publication source schema is unavailable", () => {
    const fixture = persistentFixture("persistent-task-source-schema-unavailable");
    const sourceId = "missing-task-source";
    insertOperationalTask(fixture.persistent.id, sourceId);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "task", sourceId, 4),
    );
    getDb().run("ALTER TABLE agent_workspace_tasks RENAME TO agent_workspace_tasks_missing");
    try {
      expectWorkspaceError("schema_unavailable", () => listPersistentWorkspacePublications({
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: publication.revision,
      }));
    } finally {
      getDb().run("ALTER TABLE agent_workspace_tasks_missing RENAME TO agent_workspace_tasks");
    }
  });

  test("fails closed when a finding publication source schema is unavailable", () => {
    const fixture = persistentFixture("persistent-finding-source-schema-unavailable");
    const sourceId = "missing-finding-source";
    insertOperationalFinding(fixture.persistent.id, sourceId);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", sourceId, 3),
    );
    getDb().run("ALTER TABLE agent_workspace_records RENAME TO agent_workspace_records_missing");
    try {
      expectWorkspaceError("schema_unavailable", () => listPersistentWorkspacePublications({
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: publication.revision,
      }));
    } finally {
      getDb().run("ALTER TABLE agent_workspace_records_missing RENAME TO agent_workspace_records");
    }
  });

  test("fails closed when an objective publication source schema is unavailable", () => {
    const fixture = persistentFixture("persistent-objective-source-schema-unavailable");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "objective", fixture.persistent.id, 0),
    );
    getDb().run("ALTER TABLE agent_turn_workspaces RENAME TO agent_turn_workspaces_missing");
    try {
      expectWorkspaceError("schema_unavailable", () => listPersistentWorkspacePublications({
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: publication.revision,
      }));
    } finally {
      getDb().run("ALTER TABLE agent_turn_workspaces_missing RENAME TO agent_turn_workspaces");
    }
  });

  test("fails closed when an artifact publication source schema is unavailable", () => {
    const fixture = persistentFixture("persistent-artifact-source-schema-unavailable");
    const sourceId = "missing-artifact-source";
    insertOperationalArtifact(fixture.persistent.id, sourceId);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", sourceId, 5),
    );
    getDb().run("ALTER TABLE agent_workspace_artifacts RENAME TO agent_workspace_artifacts_missing");
    try {
      expectWorkspaceError("schema_unavailable", () => listPersistentWorkspacePublications({
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: publication.revision,
      }));
    } finally {
      getDb().run("ALTER TABLE agent_workspace_artifacts_missing RENAME TO agent_workspace_artifacts");
    }
  });

  test("fails closed when a publication source message schema is unavailable", () => {
    const sourceMessageId = "persistent-source-message-schema-unavailable";
    getDb().query(
      "INSERT INTO messages (id, chat_id, index_in_chat, content, swipe_id, swipes) VALUES (?, ?, 0, ?, 0, ?)",
    ).run(sourceMessageId, CHAT, "Source message", JSON.stringify(["Source swipe"]));
    const fixture = persistentFixture("persistent-message-source-schema-unavailable", {
      targetMessageId: sourceMessageId,
      targetSwipeId: 0,
    });
    const sourceId = "message-source-artifact";
    insertOperationalArtifact(fixture.persistent.id, sourceId);
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "artifact", sourceId, 5),
    );
    getDb().run("ALTER TABLE messages RENAME TO messages_missing");
    try {
      expectWorkspaceError("schema_unavailable", () => listPersistentWorkspacePublications({
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        expectedRevision: publication.revision,
      }));
    } finally {
      getDb().run("ALTER TABLE messages_missing RENAME TO messages");
    }
  });

  test("terminal turn sessions are monotonic, immutable, and idempotent", () => {
    const fixture = persistentFixture("persistent-terminal-session");
    const authority = createPersistentWorkspaceHostAuthority();
    getDb().query("DELETE FROM chats WHERE id = ?").run(CHAT);
    const detached = getPersistentWorkspaceById({
      userId: USER,
      workspaceId: fixture.persistent.id,
    });
    expect(detached.revision).toBeGreaterThan(fixture.persistent.revision);
    expectWorkspaceError("stale_revision", () => updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision: fixture.persistent.revision,
      turnSessionId: fixture.session.id,
      phase: "WORK",
      status: "running",
    }));
    const running = updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision: detached.revision,
      turnSessionId: fixture.session.id,
      phase: "WORK",
      status: "running",
    });
    expect(running).toMatchObject({ phase: "WORK", status: "running", outcome: null, revision: fixture.session.revision + 1, terminalAt: null });

    const terminal = updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision: detached.revision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    });
    expect(terminal).toMatchObject({ phase: "TERMINAL", status: "terminal", outcome: "completed", revision: running.revision + 1 });
    expect(terminal.terminalAt).toEqual(expect.any(Number));
    expect(Object.isFrozen(terminal)).toBe(true);

    const replay = updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision: detached.revision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
    });
    expect(replay).toEqual(terminal);
    expectWorkspaceError("invalid_state", () => updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision: detached.revision,
      turnSessionId: fixture.session.id,
      phase: "TERMINAL",
      status: "terminal",
      outcome: "failed",
    }));
    expectWorkspaceError("invalid_state", () => updatePersistentWorkspaceHostTurnSession(authority, {
      userId: USER,
      workspaceId: fixture.persistent.id,
      expectedRevision: detached.revision,
      turnSessionId: fixture.session.id,
      phase: "WORK",
      status: "running",
    }));
    expect(getDb().query(
      "SELECT phase, status, outcome, revision FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
    ).get(fixture.session.id)).toEqual({
      phase: "TERMINAL",
      status: "terminal",
      outcome: "completed",
      revision: terminal.revision,
    });
  });

  test("keeps publication provenance and copies immutable after publication", () => {
    const fixture = persistentFixture("persistent-publication-immutability");
    insertOperationalFinding(fixture.persistent.id, "immutable-publication-finding", "Immutable published finding");
    const publication = publishPersistentWorkspaceSelection(
      persistentPublicationInput(fixture.persistent.id, fixture.persistent.revision, "finding", "immutable-publication-finding", 3),
    );
    expect(Object.isFrozen(publication)).toBe(true);
    expect(Object.isFrozen(publication.copy)).toBe(true);
    expect(publication.sourceProvenance).toMatchObject({
      workspaceId: fixture.persistent.id,
      turnSessionId: fixture.session.id,
      attemptId: TURN,
      sourceChatId: CHAT,
      sourceMessageId: null,
      sourceSwipeId: null,
      sourceDeletedAt: null,
      creator: `owner:${USER}`,
    });
    expect(publication.sourceStatus).toBe("present");
    expect(() => getDb().query(
      "UPDATE persistent_workspace_publications SET published_by = ? WHERE publication_id = ?",
    ).run("attacker", publication.id)).toThrow(/immutable/);
    expect(getDb().query(
      "SELECT published_by, copy_digest, revision FROM persistent_workspace_publications WHERE publication_id = ?",
    ).get(publication.id)).toEqual({
      published_by: `owner:${USER}`,
      copy_digest: publication.copyDigest,
      revision: 1,
    });
  });

  test("does not expose direct session mutation helpers or accept forged host authority", () => {
    expect(Object.hasOwn(workspaceService, "createPersistentWorkspaceTurnSession")).toBe(false);
    expect(Object.hasOwn(workspaceService, "updatePersistentWorkspaceTurnSession")).toBe(false);
    const fixture = persistentFixture("persistent-authority-surface");
    const authority = createPersistentWorkspaceHostAuthority();
    expectWorkspaceError("forbidden", () => createPersistentWorkspaceHostTurnSession(
      JSON.parse(JSON.stringify(authority)),
      {
        userId: USER,
        chatId: CHAT,
        workspaceId: fixture.persistent.id,
        turnSessionId: "forged-session",
        turnId: "forged-turn",
        attemptId: "forged-attempt",
        expectedRevision: fixture.persistent.revision,
      },
    ));
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  TurnWorkspaceError,
  acceptWorkspaceSubmission,
  createTurnWorkspace,
  createWorkspaceTask,
  freezeFrameCapabilities,
  freezeWorkspaceForCompletionV1,
  recordWorkspaceRecord,
  submitWorkspaceChildResult,
  type WorkspaceErrorCode,
} from "./turn-workspace.service";
import { buildWorkspaceContextProjectionFromWorkspaceV1 } from "./workspace-context-projection.service";

const USER = "projection-user";
const OTHER_USER = "projection-other";
const CHAT = "projection-chat";
const TURN = "projection-turn";
const BLOB_DIGEST = "a".repeat(64);

const PROJECTION_CHILD_CAPABILITIES = {
  revision: 1,
  allowed: ["submit_child_result"] as const,
  maxOperationBytes: 64 * 1024,
  maxOperations: 32,
};

async function applySchema(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
  db.run("PRAGMA foreign_keys = ON");
}

function seed(): void {
  const db = getDb();
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run(USER, "Projection user", "projection@example.test");
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run(OTHER_USER, "Other user", "other-projection@example.test");
  db.query("INSERT INTO characters (id, user_id, name) VALUES (?, ?, ?)").run("projection-character", USER, "Projection character");
  db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)").run(CHAT, USER, "projection-character", "Projection chat");
  db.query(`INSERT INTO agent_turn_executions
    (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
     runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
     commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, 9999999999999, 'ASSEMBLE', '{}', '{}', ?, 9999999999)`)
    .run(TURN, USER, CHAT, "projection-generation", "projection-commit");
  db.query(`INSERT INTO agent_artifact_blobs
    (digest, user_id, byte_count, mime_type, storage_path, provenance_json, expires_at)
    VALUES (?, ?, 3, 'text/plain', '/tmp/projection-artifact', '{}', 9999999999)`)
    .run(BLOB_DIGEST, USER);
  db.query(`INSERT INTO agent_artifact_blob_journal
    (journal_id, blob_digest, user_id, turn_id, creator_token, fence_generation,
     staged_path, final_path, state, observed_identity, byte_count, digest)
    VALUES (?, ?, ?, ?, ?, 1, '/tmp/projection-artifact.stage', '/tmp/projection-artifact', 'installed', '{}', 3, ?)`)
    .run("projection-journal", BLOB_DIGEST, USER, TURN, "projection-creator", BLOB_DIGEST);
}

function rootContext(workspaceId: string, revision: number) {
  return { userId: USER, chatId: CHAT, turnId: TURN, workspaceId, actor: "root" as const, expectedRevision: revision };
}
function hostContext(workspaceId: string, revision: number) {
  return { ...rootContext(workspaceId, revision), actor: "host" as const };
}
function childContext(workspaceId: string, revision: number) {
  return {
    ...rootContext(workspaceId, revision),
    actor: "child" as const,
    frameId: "projection-frame",
  };
}
function expectWorkspaceError(code: WorkspaceErrorCode, operation: () => unknown): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(TurnWorkspaceError);
    expect((error as TurnWorkspaceError).code).toBe(code);
    return;
  }
  throw new Error(`expected workspace error ${code}`);
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  await applySchema();
  seed();
});
afterEach(() => closeDatabase());

describe("owner-bound workspace context projection", () => {
  test("freezes all sections at the exact owner/revision and emits accepted data", () => {
    const workspace = createTurnWorkspace({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: "projection-workspace",
      objective: "Preserve the objective",
      constraints: ["Keep evidence bounded"],
      retention: "chat_lifetime",
      quota: { maxTasks: 8, maxRecords: 16, maxSubmissions: 8, maxArtifacts: 4, maxBytes: 4096 },
      capabilities: { revision: 1, allowed: ["create_task", "record_finding", "record_decision", "record_question", "submit_child_result"], maxOperationBytes: 131072, maxOperations: 128 },
    });
    let workspaceRevision = workspace.revision;
    const task = createWorkspaceTask({ ...hostContext(workspace.id, workspaceRevision), title: "Required task", required: true, assignedFrameId: "projection-frame" });
    workspaceRevision += 1;
    recordWorkspaceRecord({ ...hostContext(workspace.id, workspaceRevision), kind: "finding", summary: "bounded finding", digest: "b".repeat(64), taskId: null });
    workspaceRevision += 1;
    recordWorkspaceRecord({ ...hostContext(workspace.id, workspaceRevision), kind: "decision", summary: "accepted decision", digest: "c".repeat(64), taskId: null });
    workspaceRevision += 1;
    recordWorkspaceRecord({ ...hostContext(workspace.id, workspaceRevision), kind: "question", summary: "unresolved question", digest: "d".repeat(64), taskId: null });
    workspaceRevision += 1;

    freezeFrameCapabilities({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: workspace.id,
      frameId: "projection-frame",
      capabilities: PROJECTION_CHILD_CAPABILITIES,
    });
    submitWorkspaceChildResult({ ...childContext(workspace.id, workspaceRevision), taskId: task.id, summary: "accepted child submission", resultDigest: "e".repeat(64), byteCount: 26 });
    workspaceRevision += 1;
    const submission = getDb().query("SELECT submission_id FROM agent_workspace_submissions WHERE task_id = ?").get(task.id) as { submission_id: string };
    acceptWorkspaceSubmission({
      ...hostContext(workspace.id, workspaceRevision),
      submissionId: submission.submission_id,
      taskId: task.id,
    });
    workspaceRevision += 1;

    const ownerRevision = workspaceRevision;
    let result: ReturnType<typeof buildWorkspaceContextProjectionFromWorkspaceV1> | undefined;
    const frozen = freezeWorkspaceForCompletionV1(hostContext(workspace.id, ownerRevision), {
      prepare: (candidate) => {
        result = buildWorkspaceContextProjectionFromWorkspaceV1(
          {
            userId: USER,
            chatId: CHAT,
            turnId: TURN,
            workspaceId: workspace.id,
            expectedRevision: ownerRevision,
            sourceWorkspaceRevision: candidate.workspaceRevision,
          },
          { reservedBytes: 100_000 },
        );
        return true;
      },
    });
    expect(frozen).toEqual({ accepted: true, workspaceRevision: ownerRevision + 1 });
    if (!result) throw new Error("workspace projection was not prepared before completion freeze");
    workspaceRevision = frozen.workspaceRevision;

    expect(result.sourceWorkspaceRevision).toBe(workspaceRevision);
    expect(result.mandatory.map((record) => record.kind)).toContain("required_task");
    expect(result.mandatory.map((record) => record.kind)).toContain("accepted_decision");
    expect(result.mandatory.map((record) => record.kind)).toContain("unresolved_question");
    expect(result.optional.map((record) => record.kind)).toContain("finding");
    expect(result.optional.map((record) => record.kind)).toContain("accepted_submission");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.mandatory)).toBe(true);
    expect(Object.isFrozen(result.optional)).toBe(true);
  });

  test("rechecks owner and expected revision instead of widening reads", () => {
    const workspace = createTurnWorkspace({
      userId: USER,
      chatId: CHAT,
      turnId: TURN,
      workspaceId: "projection-owner-workspace",
      objective: "Owner only",
      constraints: [],
      retention: "chat_lifetime",
      capabilities: { revision: 1, allowed: [], maxOperationBytes: 1, maxOperations: 1 },
    });
    expectWorkspaceError("not_found", () => buildWorkspaceContextProjectionFromWorkspaceV1(
      { userId: OTHER_USER, chatId: CHAT, turnId: TURN, workspaceId: workspace.id, expectedRevision: workspace.revision },
      { reservedBytes: 100_000 },
    ));
    expectWorkspaceError("stale_revision", () => buildWorkspaceContextProjectionFromWorkspaceV1(
      { userId: USER, chatId: CHAT, turnId: TURN, workspaceId: workspace.id, expectedRevision: workspace.revision + 1 },
      { reservedBytes: 100_000 },
    ));
  });
});

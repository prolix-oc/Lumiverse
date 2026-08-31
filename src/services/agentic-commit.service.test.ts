import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTIC_COMMIT_DEPENDENCIES_V1,
  AgenticCommitError,
  commitAgenticTurnV1,
  type AgenticCommitDependenciesV1,
  type AgenticCommitInputV1,
} from "./agentic-commit.service";
import { calculateFinalRenderReservationEnvelopeV1 } from "./turn-execution.service";
import type {
  WorkspaceArtifactReferenceV1,
  WorkspaceTerminalHandoffV1,
} from "../types/turn-workspace";
import type { InputRevisionV1 } from "../types/agent-preprocessing";
import {
  liveChatInputRevision,
  liveConnectionInputRevision,
  liveCredentialInputRevision,
  liveEndpointInputRevision,
  liveMessageInputRevision,
} from "./prompt-assembly-snapshot.service";
const baselineSql = await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text();
const artifactBytes = new TextEncoder().encode("blob");
const artifactDigest = createHash("sha256").update(artifactBytes).digest("hex");
let artifactPath: string | undefined;
const reservationEnvelope = calculateFinalRenderReservationEnvelopeV1({
  activityChunks: 1,
  contextBytes: 1024,
  outputBytes: 1024,
});
const testRevisionMembers = [
  { kind: "target" as const, id: "target-1", revision: 1, digest: "a" },
  { kind: "chat" as const, id: "chat-1", revision: 1, digest: "b" },
  { kind: "config" as const, id: "config-1", revision: 1, digest: "c" },
  { kind: "slot_binding" as const, id: "slot-1", revision: 1, digest: "d" },
  { kind: "settings" as const, id: "settings-1", revision: 1, digest: "e" },
  { kind: "macro_variables" as const, id: "macro-1", revision: 1, digest: "f" },
  { kind: "regex" as const, id: "regex-1", revision: 1, digest: "regex-digest" },
  { kind: "world_lore" as const, id: "entry-1", revision: 1, digest: "world-digest" },
  { kind: "cognition_policy" as const, id: "cognition-1", revision: 1, digest: "i" },
  { kind: "runtime_epoch" as const, id: "runtime-1", revision: 1, digest: "j" },
  { kind: "readiness" as const, id: "readiness-1", revision: 1, digest: "k" },
] as const;
const testRevisionDigest = createHash("sha256").update(JSON.stringify(testRevisionMembers.map((member) => ({
  digest: member.digest,
  id: member.id,
  kind: member.kind,
  revision: member.revision,
})))).digest("hex");
const testRevisionSet = {
  version: 1 as const,
  revisions: testRevisionMembers,
  digest: testRevisionDigest,
};

function createDatabase(): Database {
  const db = new Database(":memory:");
  if (artifactPath) {
    try { unlinkSync(artifactPath); } catch { /* previous fixture may already be absent */ }
  }
  const path = join(tmpdir(), `lumiverse-agentic-commit-${crypto.randomUUID()}.blob`);
  artifactPath = path;
  writeFileSync(path, artifactBytes);
  const artifactStat = statSync(path);
  const artifactIdentity = `${Number(artifactStat.dev)}:${Number(artifactStat.ino)}:${Number(artifactStat.size)}:${Math.trunc(Number(artifactStat.mtimeMs) * 1000)}`;
  db.run(baselineSql);
  db.run("PRAGMA foreign_keys = ON");
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run("u1", "Test", "u1@example.test");
  db.query("INSERT INTO characters (id, name) VALUES (?, ?)").run("character-1", "Character");
  db.query("INSERT INTO chats (id, user_id, character_id) VALUES (?, ?, ?)").run("chat-1", "u1", "character-1");
  const future = Date.now() + 60_000;
  db.query("INSERT INTO agent_turn_executions (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode, runtime_epoch, deadline_at, state, cas_revision, cas_owner, root_ledger_json, frame_capabilities_json, workspace_id, commit_key, final_render_reservations_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "turn-1", "u1", "chat-1", "generation-1", "normal", 0, "agentic", 1, future, "PREPARE_COMMIT", 0, "owner-1", "{}", "{}", "workspace-1", "commit-1", JSON.stringify([{ id: "render-1", requestCount: 1, activityChunks: reservationEnvelope.activityChunks, activityEvents: reservationEnvelope.activityEvents, contextBytes: reservationEnvelope.contextBytes, outputBytes: reservationEnvelope.outputBytes, maxBytes: reservationEnvelope.maxBytes, deadlineAt: future, revision: 1, reservedAt: Date.now() }]), future,
  );
  db.query("INSERT INTO agent_turn_workspaces (workspace_id, turn_id, execution_id, user_id, chat_id, objective, constraints_json, state, operation_caps_json, field_caps_json, retention, expires_at, quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "workspace-1", "turn-1", "turn-1", "u1", "chat-1", "objective", "{}", "frozen", "{}", "{}", "turn_terminal", future, 10, 10, 10, 10, 1_000_000,
  );
  db.query("INSERT INTO agent_artifact_blobs (digest, user_id, byte_count, mime_type, storage_path, provenance_json, published_reference_count, retention, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(artifactDigest, "u1", artifactBytes.byteLength, "text/plain", path, "{}", 0, "chat_lifetime", future);
  db.query("INSERT INTO agent_artifact_blob_journal (journal_id, blob_digest, user_id, turn_id, creator_token, fence_generation, staged_path, final_path, state, observed_identity, byte_count, digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("journal-1", artifactDigest, "u1", "turn-1", "creator-1", 1, "/stage/artifact", path, "installed", JSON.stringify({ before: null, after: artifactIdentity, createdByUs: true }), artifactBytes.byteLength, artifactDigest);
  db.query("INSERT INTO agent_workspace_artifacts (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type, byte_count, provenance_json, publication_state, retention, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("artifact-1", "workspace-1", "turn-1", "u1", "chat-1", artifactDigest, "text/plain", 4, "{\"source\":\"test\"}", "proposed", "chat_lifetime", future);
  return db;
}

function render() {
  return {
    version: 1 as const,
    operation: "prepare_agent_render" as const,
    requestId: "protocol-render-1",
    content: { kind: "text" as const, text: "committed answer" },
    usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
    macroVariableDeltas: [],
    sourceMessageDeltas: [],
    chatMetadataDeltas: [],
    regexActionDeltas: [],
    worldInfoStateDeltas: [],
    inputRevisions: testRevisionSet,
  };
}
function artifactReference(): WorkspaceArtifactReferenceV1 {
  return {
    id: "artifact-1",
    workspaceId: "workspace-1",
    turnId: "turn-1",
    userId: "u1",
    chatId: "chat-1",
    blobDigest: artifactDigest,
    mimeType: "text/plain",
    byteCount: 4,
    provenance: "root",
    sourceFrameId: null,
    sourceTaskId: null,
    publicationState: "proposed",
    retention: "chat_lifetime",
    revision: 0,
    expiresAt: 2_000_000_000,
    createdAt: 1,
  };
}

function terminalHandoff(): WorkspaceTerminalHandoffV1 {
  return {
    workspaceId: "workspace-1",
    state: "frozen",
    revision: 0,
    executionState: "PREPARE_COMMIT",
    usage: {
      taskCount: 0,
      recordCount: 0,
      submissionCount: 0,
      artifactCount: 0,
      byteCount: 0,
    },
    finalRenderReservations: [],
  };
}

function input(db: Database, dependencies: AgenticCommitDependenciesV1, includeArtifact = true): AgenticCommitInputV1 {
  return {
    db,
    dependencies,
    executionId: "turn-1",
    ownerToken: "owner-1",
    userId: "u1",
    chatId: "chat-1",
    turnId: "turn-1",
    generationId: "generation-1",
    commitKey: "commit-1",
    renderReservationId: "render-1",
    target: { target: "normal", chatId: "chat-1", branchId: null, messageId: null, swipeId: null, messageIndex: null, swipeCount: null, chatGenerationRevision: 0, messageGenerationRevision: null },
    renderPreparation: render(),
    completion: { summary: "done", unresolvedIds: [] },
    artifacts: includeArtifact ? [artifactReference()] : [],
    inputRevisions: testRevisionSet,
    terminalHandoff: terminalHandoff(),
    revisionReader: (member) => ({ revision: member.revision, digest: member.digest }),
  };
}
function seedTargetMessage(db: Database): void {
  db.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "message-1", "chat-1", 0, 0, "Assistant", "old", 1, 0, JSON.stringify(["old", "other"]), JSON.stringify([1, 1]), "{}", 1,
  );
}
function bindExecutionTarget(db: Database, target: "continue" | "regenerate" | "swipe", messageId: string, swipeId: number): void {
  db.query("UPDATE agent_turn_executions SET target_kind = ?, target_message_id = ?, target_swipe_id = ?, target_message_index = ?, target_swipe_count = ?, target_message_revision = ? WHERE id = ?").run(target, messageId, swipeId, 0, 2, 0, "turn-1");
}

describe("agentic commit transaction", () => {
  let db: Database;
  afterEach(() => {
    db.close();
    if (artifactPath) {
      try { unlinkSync(artifactPath); } catch { /* fixture may have been removed by a negative test */ }
      artifactPath = undefined;
    }
  });

  test("publishes message, receipt, projection and exactly one event atomically", () => {
    db = createDatabase();
    const events: unknown[] = [];
    const dependencies = { ...AGENTIC_COMMIT_DEPENDENCIES_V1, emitProjectionEvent: (event: unknown) => events.push(event) } as AgenticCommitDependenciesV1;
    const result = commitAgenticTurnV1(input(db, dependencies));
    expect(result.status).toBe("committed");
    expect(result.terminalHandoff).toMatchObject({
      workspaceId: "workspace-1",
      state: "frozen",
      revision: 0,
      executionState: "COMMITTED",
      usage: {
        taskCount: 0,
        recordCount: 0,
        submissionCount: 0,
        artifactCount: 0,
        byteCount: 0,
      },
    });
    expect(result.receipt).toMatchObject({
      turnId: "turn-1",
      workspaceId: "workspace-1",
      state: "committed",
      messageId: expect.any(String),
      artifactRefCount: 1,
    });
    expect(events).toHaveLength(1);
    const message = db.query("SELECT id FROM messages WHERE chat_id = ?").get("chat-1") as { id: string };
    const receipt = db.query("SELECT receipt_id, message_id FROM agent_turn_commit_receipts WHERE execution_id = ?").get("turn-1") as { receipt_id: string; message_id: string };
    expect(message.id).toBe(receipt.message_id);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_run_projections WHERE turn_id = ?").get("turn-1")).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE chat_id = ?").get("chat-1")).toEqual({ count: 1 });
    expect(db.query("SELECT receipt_id FROM agent_published_workspace_artifacts WHERE chat_id = ?").get("chat-1")).toEqual({ receipt_id: receipt.receipt_id });
    expect(db.query("SELECT published_reference_count AS count FROM agent_artifact_blobs WHERE digest = ?").get(artifactDigest)).toEqual({ count: 1 });
  });
  test("canonicalizes Unicode message metadata by raw UTF-8 bytes", () => {
    db = createDatabase();
    const result = commitAgenticTurnV1({
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      message: {
        extra: {
          "𐀀": 1,
          "\uE000": 2,
        },
      },
    });
    expect(result.status).toBe("committed");
    const row = db.query("SELECT extra FROM messages WHERE chat_id = ?").get("chat-1") as { extra: string };
    const keys = Object.keys(JSON.parse(row.extra) as Record<string, unknown>);
    expect(keys.slice(-2)).toEqual(["\uE000", "𐀀"]);
  });
  test("projects host activity tool and child counts without inventing them", () => {
    db = createDatabase();
    const result = commitAgenticTurnV1({
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      activityUsage: {
        inputTokens: 9,
        outputTokens: 8,
        totalTokens: 17,
        toolCalls: 4,
        childInvocations: 2,
      },
    });
    expect(result.status).toBe("committed");
    const row = db.query("SELECT snapshot_json FROM agent_run_projections WHERE turn_id = ?").get("turn-1") as { snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as { usage: { inputTokens: number; outputTokens: number; totalTokens: number; toolCalls: number; childInvocations: number } };
    expect(snapshot.usage).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      toolCalls: 4,
      childInvocations: 2,
    });
  });
  test("rejects malformed activity usage before the commit gate", () => {
    db = createDatabase();
    expect(() => commitAgenticTurnV1({
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      activityUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCalls: -1,
        childInvocations: 0,
      },
    })).toThrow();
    expect(db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("turn-1")).toEqual({ state: "PREPARE_COMMIT" });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_run_projections WHERE turn_id = ?").get("turn-1")).toEqual({ count: 0 });
  });

  test("keeps private render guidance out of the durable receipt summary", () => {
    db = createDatabase();
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      completion: {
        summary: "done",
        unresolvedIds: [],
        renderGuidance: "private render-only instructions",
      },
    };
    const result = commitAgenticTurnV1(candidate);
    const row = db.query(
      "SELECT summary_json FROM agent_turn_commit_receipts WHERE execution_id = ?",
    ).get("turn-1") as { summary_json: string };
    expect(row.summary_json).not.toContain("private render-only instructions");
    expect(row.summary_json).not.toContain("renderGuidance");
    expect(result.receipt.summary).toBe("done");
  });
  test("requires the durable render reservation id, not the isolate request id", () => {
    db = createDatabase();
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      renderReservationId: "wrong-reservation",
      renderPreparation: { ...render(), requestId: "another-protocol-request" },
    };
    expect(() => commitAgenticTurnV1(candidate)).toThrow();
    expect(db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("turn-1")).toEqual({ state: "PREPARE_COMMIT" });
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
  });


  test("duplicate commit does not emit or repeat writes", () => {
    db = createDatabase();
    const events: unknown[] = [];
    const dependencies = { ...AGENTIC_COMMIT_DEPENDENCIES_V1, emitProjectionEvent: (event: unknown) => events.push(event) } as AgenticCommitDependenciesV1;
    const first = commitAgenticTurnV1(input(db, dependencies));
    const messageCount = (db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1") as { count: number }).count;
    const second = commitAgenticTurnV1({
      ...input(db, dependencies),
      target: { ...input(db, dependencies).target, chatGenerationRevision: 999, messageGenerationRevision: 999 },
      renderReservationId: "released-reservation",
      renderPreparation: { ...render(), requestId: "released-render-reservation", inputRevisions: { version: 1, revisions: [{ kind: "target", id: "target-1", revision: 99, digest: "changed" }], digest: "stale" } },
      inputRevisions: { version: 1, revisions: [{ kind: "target", id: "target-1", revision: 99, digest: "changed" }], digest: "stale" },
    });
    expect(first.status).toBe("committed");
    expect(second.status).toBe("duplicate");
    expect(second.receipt.summary).toBe("done");
    expect(events).toHaveLength(1);
    expect((db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1") as { count: number }).count).toBe(messageCount);
    expect((db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?").get("turn-1") as { count: number }).count).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE chat_id = ?").get("chat-1") as { count: number }).count).toBe(1);
    expect((db.query("SELECT published_reference_count AS count FROM agent_artifact_blobs WHERE digest = ?").get(artifactDigest) as { count: number }).count).toBe(1);
  });
  test("duplicate retries return durable handoff and reject altered execution identity", () => {
    db = createDatabase();
    const first = commitAgenticTurnV1(input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false));
    const altered = input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false);
    const second = commitAgenticTurnV1({
      ...altered,
      completion: { summary: "caller-controlled retry", unresolvedIds: ["forged"] },
      terminalHandoff: {
        ...altered.terminalHandoff,
        revision: 999,
        usage: { taskCount: 99, recordCount: 99, submissionCount: 99, artifactCount: 99, byteCount: 99 },
        finalRenderReservations: [{
          id: "forged-render",
          requestCount: 1,
          ...reservationEnvelope,
          deadlineAt: Date.now() + 60_000,
          revision: 1,
          reservedAt: Date.now(),
        }],
      },
      message: { content: "caller-controlled message" },
    });
    expect(second.status).toBe("duplicate");
    expect(second.receipt.summary).toBe(first.receipt.summary);
    expect(second.terminalHandoff).toEqual(first.terminalHandoff);
    let identityError: unknown;
    try {
      commitAgenticTurnV1({
        ...altered,
        target: { ...altered.target, target: "continue" as const },
      });
    } catch (error) {
      identityError = error;
    }
    expect(identityError).toBeInstanceOf(AgenticCommitError);
    expect((identityError as AgenticCommitError).code).toBe("receipt_conflict");
  });

  test("rolls back artifact, message, receipt, projection, refcount and event on statement failure", () => {
    db = createDatabase();
    const events: unknown[] = [];
    const dependencies = {
      ...AGENTIC_COMMIT_DEPENDENCIES_V1,
      emitProjectionEvent: (event: unknown) => events.push(event),
      publishAgentRunCommit: () => { throw new Error("injected projection statement failure"); },
    } as unknown as AgenticCommitDependenciesV1;
    expect(() => commitAgenticTurnV1(input(db, dependencies))).toThrow();
    expect(db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("turn-1")).toEqual({ state: "COMMIT_FAILED" });
    expect(events).toHaveLength(0);
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?").get("turn-1")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_run_projections WHERE turn_id = ?").get("turn-1")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
    expect(db.query("SELECT published_reference_count AS count FROM agent_artifact_blobs WHERE digest = ?").get(artifactDigest)).toEqual({ count: 0 });
  });
  test("rechecks every input revision member before durable mutation", () => {
    db = createDatabase();
    const members = [
      { kind: "target", id: "target-1", revision: 1, digest: "a" },
      { kind: "chat", id: "chat-1", revision: 1, digest: "b" },
      { kind: "message", id: "message-1", revision: 1, digest: "c" },
      { kind: "preset", id: "preset-1", revision: 1, digest: "d" },
      { kind: "preset_block", id: "block-1", revision: 1, digest: "e" },
      { kind: "config", id: "config-1", revision: 1, digest: "f" },
      { kind: "slot_binding", id: "slot-1", revision: 1, digest: "g" },
      { kind: "connection", id: "connection-1", revision: 1, digest: "h" },
      { kind: "endpoint", id: "endpoint-1", revision: 1, digest: "i" },
      { kind: "credential", id: "credential-1", revision: 1, digest: "j" },
      { kind: "persona", id: "persona-1", revision: 1, digest: "k" },
      { kind: "character", id: "character-1", revision: 1, digest: "l" },
      { kind: "group", id: "group-1", revision: 1, digest: "m" },
      { kind: "world_lore", id: "lore-1", revision: 1, digest: "n" },
      { kind: "settings", id: "settings-1", revision: 1, digest: "o" },
      { kind: "macro_variables", id: "macro-1", revision: 1, digest: "p" },
      { kind: "regex", id: "regex-1", revision: 1, digest: "q" },
      { kind: "cognition_policy", id: "cognition-1", revision: 1, digest: "u" },
      { kind: "runtime_epoch", id: "runtime-1", revision: 1, digest: "v" },
      { kind: "readiness", id: "readiness-1", revision: 1, digest: "w" },
    ] as const;
    const revisionDigest = createHash("sha256").update(JSON.stringify(members.map((member) => ({
      digest: member.digest,
      id: member.id,
      kind: member.kind,
      revision: member.revision,
    })))).digest("hex");
    const revisions = { version: 1 as const, revisions: members, digest: revisionDigest };
    const dependencies = AGENTIC_COMMIT_DEPENDENCIES_V1;
    const candidate = {
      ...input(db, dependencies, false),
      renderPreparation: { ...render(), inputRevisions: revisions },
      inputRevisions: revisions,
      revisionReader: () => ({ revision: 2, digest: "changed" }),
    };
    expect(() => commitAgenticTurnV1(candidate)).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?").get("turn-1")).toEqual({ count: 0 });
  });
  test("authoritative transaction fence rejects macro and settings changes after commit snapshot", () => {
    db = createDatabase();
    db.query("INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)").run(
      "macro_variables_global",
      JSON.stringify({ keep: "before" }),
      "u1",
      1,
    );
    const liveRevisions = new Map<string, InputRevisionV1>(
      testRevisionSet.revisions.map((member): [string, InputRevisionV1] => [`${member.kind}:${member.id}`, { ...member }]),
    );
    const baseDependencies = AGENTIC_COMMIT_DEPENDENCIES_V1;
    const dependencies = {
      ...baseDependencies,
      beginTurnCommit: (gateInput: Parameters<typeof baseDependencies.beginTurnCommit>[0]) => {
        db.query("UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND user_id = ?").run(
          JSON.stringify({ keep: "external" }),
          2,
          "macro_variables_global",
          "u1",
        );
        liveRevisions.set("macro_variables:macro-1", { kind: "macro_variables", id: "macro-1", revision: 2, digest: "macro-changed" });
        liveRevisions.set("settings:settings-1", { kind: "settings", id: "settings-1", revision: 2, digest: "settings-changed" });
        return baseDependencies.beginTurnCommit(gateInput);
      },
    } as AgenticCommitDependenciesV1;
    const candidate: AgenticCommitInputV1 = {
      ...input(db, dependencies),
      authorizeMacroVariableDelta: () => true,
      revisionReader: (member) => liveRevisions.get(`${member.kind}:${member.id}`) ?? null,
      renderPreparation: {
        ...render(),
        macroVariableDeltas: [{
          kind: "macro_variable" as const,
          scope: "global" as const,
          key: "overwritten",
          operation: "set" as const,
          value: "no",
          expectedRevision: 1,
        }],
      },
    };
    let caught: unknown;
    try {
      commitAgenticTurnV1(candidate);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgenticCommitError);
    expect((caught as AgenticCommitError).code).toBe("stale_input_revision");
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
    expect(db.query("SELECT value FROM settings WHERE key = ? AND user_id = ?").get("macro_variables_global", "u1")).toEqual({
      value: JSON.stringify({ keep: "external" }),
    });
  });
  test("rejects conflicting expected revisions for repeated delta sources", () => {
    db = createDatabase();
    const base = input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false);
    const candidate = {
      ...base,
      authorizeChatMetadataDelta: () => true,
      renderPreparation: {
        ...render(),
        chatMetadataDeltas: [
          { kind: "chat_metadata" as const, key: "first", operation: "set" as const, value: "one", expectedRevision: 1 },
          { kind: "chat_metadata" as const, key: "second", operation: "set" as const, value: "two", expectedRevision: 2 },
        ],
      },
      revisionReader: () => ({ revision: 1, digest: "chat-digest" }),
    };
    let caught: unknown;
    try {
      commitAgenticTurnV1(candidate);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgenticCommitError);
    expect((caught as AgenticCommitError).code).toBe("stale_input_revision");
    expect(db.query("SELECT metadata FROM chats WHERE id = ?").get("chat-1")).toEqual({ metadata: "{}" });
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
  });

  test("chat updated_at alone does not stale-fence; generation_revision and preset still fail closed", () => {
    const digestMembers = (members: readonly InputRevisionV1[]) => createHash("sha256").update(JSON.stringify(members.map((member) => ({
      digest: member.digest,
      id: member.id,
      kind: member.kind,
      revision: member.revision,
    })))).digest("hex");
    const withLiveFence = (database: Database, mutate?: (database: Database) => void) => {
      database.query("INSERT INTO presets (id, name, provider, user_id) VALUES (?, ?, ?, ?)").run("preset-1", "Preset", "openai", "u1");
      const chatRow = database.query("SELECT generation_revision FROM chats WHERE id = ? AND user_id = ?").get("chat-1", "u1") as { generation_revision?: unknown };
      const presetRow = database.query("SELECT updated_at FROM presets WHERE id = ? AND user_id = ?").get("preset-1", "u1") as { updated_at?: unknown };
      const chatMember = { kind: "chat" as const, id: "chat-1", ...liveChatInputRevision("chat-1", chatRow.generation_revision) };
      const presetMember = { kind: "preset" as const, id: "preset-1", revision: String(presetRow.updated_at ?? ""), digest: String(presetRow.updated_at ?? "") };
      const members: InputRevisionV1[] = [...testRevisionSet.revisions.map((member) => member.kind === "chat" ? chatMember : member), presetMember];
      const revisions = { version: 1 as const, revisions: members, digest: digestMembers(members) };
      mutate?.(database);
      const candidate: AgenticCommitInputV1 = {
        ...input(database, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
        renderPreparation: { ...render(), inputRevisions: revisions },
        inputRevisions: revisions,
        revisionReader: (member, liveDb) => {
          const fenceDb = liveDb ?? database;
          if (member.kind === "chat") {
            const live = fenceDb.query("SELECT generation_revision FROM chats WHERE id = ? AND user_id = ? LIMIT 1").get(member.id, "u1") as { generation_revision?: unknown } | null;
            return live ? liveChatInputRevision(member.id, live.generation_revision) : null;
          }
          if (member.kind === "preset") {
            const live = fenceDb.query("SELECT updated_at FROM presets WHERE id = ? AND user_id = ? LIMIT 1").get(member.id, "u1") as { updated_at?: unknown } | null;
            return live ? { revision: String(live.updated_at ?? ""), digest: String(live.updated_at ?? "") } : null;
          }
          return members.find((entry) => entry.kind === member.kind && entry.id === member.id) ?? null;
        },
      };
      return candidate;
    };

    db = createDatabase();
    expect(commitAgenticTurnV1(withLiveFence(db, (live) => {
      live.query("UPDATE chats SET updated_at = updated_at + 100 WHERE id = ? AND user_id = ?").run("chat-1", "u1");
    })).status).toBe("committed");
    db.close();

    db = createDatabase();
    let generationCaught: unknown;
    try {
      commitAgenticTurnV1(withLiveFence(db, (live) => {
        live.query("UPDATE chats SET generation_revision = generation_revision + 1 WHERE id = ? AND user_id = ?").run("chat-1", "u1");
      }));
    } catch (error) {
      generationCaught = error;
    }
    expect(generationCaught).toBeInstanceOf(AgenticCommitError);
    expect((generationCaught as AgenticCommitError).code).toBe("stale_input_revision");
    db.close();

    db = createDatabase();
    let presetCaught: unknown;
    try {
      commitAgenticTurnV1(withLiveFence(db, (live) => {
        live.query("UPDATE presets SET updated_at = updated_at + 10 WHERE id = ? AND user_id = ?").run("preset-1", "u1");
      }));
    } catch (error) {
      presetCaught = error;
    }
    expect(presetCaught).toBeInstanceOf(AgenticCommitError);
    expect((presetCaught as AgenticCommitError).code).toBe("stale_input_revision");
  });

  test("rematerialized connection capabilities or updated_at commit; candidateRevision still fails closed", () => {
    const digestMembers = (members: readonly InputRevisionV1[]) => createHash("sha256").update(JSON.stringify(members.map((member) => ({
      digest: member.digest,
      id: member.id,
      kind: member.kind,
      revision: member.revision,
    })))).digest("hex");
    const connectionId = "240fd0b3-708a-4a62-aacd-7dd78df18fb9";
    const tokens = {
      candidateRevision: "8b001dde-candidate",
      endpointRevision: "ff9b8cc2-endpoint",
      credentialRevision: "credential-33",
    };
    const connectionMember = { kind: "connection" as const, id: connectionId, ...liveConnectionInputRevision(connectionId, tokens.candidateRevision) };
    const endpointMember = { kind: "endpoint" as const, id: connectionId, ...liveEndpointInputRevision(connectionId, tokens.endpointRevision) };
    const credentialMember = { kind: "credential" as const, id: connectionId, ...liveCredentialInputRevision(connectionId, tokens.credentialRevision) };
    const rematerialized = {
      id: connectionId,
      label: "Rematerialized",
      capabilities: { tools: true, vision: true },
      updated_at: 1_700_000_123,
      provider: "anthropic",
      model: "other-model",
      effectiveEndpoint: "https://rematerialized.example/v1",
      candidateRevision: tokens.candidateRevision,
      endpointRevision: tokens.endpointRevision,
      credentialRevision: tokens.credentialRevision,
    };
    expect(createHash("sha256").update(JSON.stringify(rematerialized)).digest("hex")).not.toBe(connectionMember.digest);
    const withLiveFence = (database: Database, liveTokens = tokens) => {
      const members: InputRevisionV1[] = [...testRevisionSet.revisions, connectionMember, endpointMember, credentialMember];
      const revisions = { version: 1 as const, revisions: members, digest: digestMembers(members) };
      const candidate: AgenticCommitInputV1 = {
        ...input(database, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
        renderPreparation: { ...render(), inputRevisions: revisions },
        inputRevisions: revisions,
        revisionReader: (member) => {
          if (member.kind === "connection") {
            return liveConnectionInputRevision(member.id, liveTokens.candidateRevision);
          }
          if (member.kind === "endpoint") {
            return liveEndpointInputRevision(member.id, liveTokens.endpointRevision);
          }
          if (member.kind === "credential") {
            return liveCredentialInputRevision(member.id, liveTokens.credentialRevision);
          }
          return members.find((entry) => entry.kind === member.kind && entry.id === member.id) ?? null;
        },
      };
      return candidate;
    };

    db = createDatabase();
    expect(commitAgenticTurnV1(withLiveFence(db)).status).toBe("committed");
    db.close();

    db = createDatabase();
    let candidateCaught: unknown;
    try {
      commitAgenticTurnV1(withLiveFence(db, { ...tokens, candidateRevision: "candidate-hostile" }));
    } catch (error) {
      candidateCaught = error;
    }
    expect(candidateCaught).toBeInstanceOf(AgenticCommitError);
    expect((candidateCaught as AgenticCommitError).code).toBe("stale_input_revision");
    db.close();

    db = createDatabase();
    let endpointCaught: unknown;
    try {
      commitAgenticTurnV1(withLiveFence(db, { ...tokens, endpointRevision: "endpoint-hostile" }));
    } catch (error) {
      endpointCaught = error;
    }
    expect(endpointCaught).toBeInstanceOf(AgenticCommitError);
    expect((endpointCaught as AgenticCommitError).code).toBe("stale_input_revision");
    db.close();

    db = createDatabase();
    let credentialCaught: unknown;
    try {
      commitAgenticTurnV1(withLiveFence(db, { ...tokens, credentialRevision: "credential-hostile" }));
    } catch (error) {
      credentialCaught = error;
    }
    expect(credentialCaught).toBeInstanceOf(AgenticCommitError);
    expect((credentialCaught as AgenticCommitError).code).toBe("stale_input_revision");
  });

  test("unresolved live connection fence denies commit", () => {
    const digestMembers = (members: readonly InputRevisionV1[]) => createHash("sha256").update(JSON.stringify(members.map((member) => ({
      digest: member.digest,
      id: member.id,
      kind: member.kind,
      revision: member.revision,
    })))).digest("hex");
    const connectionId = "240fd0b3-708a-4a62-aacd-7dd78df18fb9";
    const connectionMember = { kind: "connection" as const, id: connectionId, ...liveConnectionInputRevision(connectionId, "8b001dde-candidate") };
    const endpointMember = { kind: "endpoint" as const, id: connectionId, ...liveEndpointInputRevision(connectionId, "ff9b8cc2-endpoint") };
    const credentialMember = { kind: "credential" as const, id: connectionId, ...liveCredentialInputRevision(connectionId, "credential-33") };
    const members: InputRevisionV1[] = [...testRevisionSet.revisions, connectionMember, endpointMember, credentialMember];
    const revisions = { version: 1 as const, revisions: members, digest: digestMembers(members) };
    db = createDatabase();
    const candidate: AgenticCommitInputV1 = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      renderPreparation: { ...render(), inputRevisions: revisions },
      inputRevisions: revisions,
      revisionReader: (member) => {
        if (member.kind === "connection" || member.kind === "endpoint" || member.kind === "credential") {
          return null;
        }
        return members.find((entry) => entry.kind === member.kind && entry.id === member.id) ?? null;
      },
    };
    let caught: unknown;
    try {
      commitAgenticTurnV1(candidate);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgenticCommitError);
    expect((caught as AgenticCommitError).code).toBe("stale_input_revision");
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
  });


  test("unchanged live revisions commit once and retry as the same receipt", () => {
    db = createDatabase();
    const liveRevisions = new Map(
      testRevisionSet.revisions.map((member) => [`${member.kind}:${member.id}`, { ...member }]),
    );
    const dependencies = AGENTIC_COMMIT_DEPENDENCIES_V1;
    const candidate: AgenticCommitInputV1 = {
      ...input(db, dependencies),
      revisionReader: (member) => liveRevisions.get(`${member.kind}:${member.id}`) ?? null,
    };
    expect(commitAgenticTurnV1(candidate).status).toBe("committed");
    expect(commitAgenticTurnV1({ ...candidate, renderReservationId: "released-reservation", renderPreparation: { ...render(), requestId: "released-render", inputRevisions: testRevisionSet } }).status).toBe("duplicate");
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_turn_commit_receipts WHERE execution_id = ?").get("turn-1")).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE chat_id = ?").get("chat-1")).toEqual({ count: 1 });
  });


  test("cancellation and deadline win before the COMMITTING CAS", () => {
    db = createDatabase();
    const controller = new AbortController();
    controller.abort();
    const cancelled = { ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false), signal: controller.signal };
    expect(() => commitAgenticTurnV1(cancelled)).toThrow();
    expect(db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("turn-1")).toEqual({ state: "PREPARE_COMMIT" });

    db.close();
    db = createDatabase();
    const timedOut = { ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false), now: () => 10, deadlineAt: 10 };
    expect(() => commitAgenticTurnV1(timedOut)).toThrow();
    expect(db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("turn-1")).toEqual({ state: "PREPARE_COMMIT" });
  });

  test("applies regex and world-info deltas once in the commit transaction and rolls both back on failure", () => {
    db = createDatabase();
    db.run("CREATE TABLE delta_probe (kind TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    db.run("INSERT INTO delta_probe (kind, count) VALUES ('regex', 0), ('world', 0)");
    const regexDelta = {
      kind: "regex_action" as const,
      scriptId: "regex-1",
      operation: "apply" as const,
      expectedRevision: 1,
    };
    const worldDelta = {
      kind: "world_info_state" as const,
      entryId: "entry-1",
      operation: "activate" as const,
      state: "active" as const,
      afterState: { active: true, stickyLeft: 0, cooldownLeft: 0, delayCount: 0 },
      expectedRevision: 1,
    };
    const applied: string[] = [];
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      authorizeRegexActionDelta: () => true,
      authorizeWorldInfoStateDelta: () => true,
      applyRegexActionDelta: (tx: Database) => {
        applied.push("regex");
        tx.query("UPDATE delta_probe SET count = count + 1 WHERE kind = 'regex'").run();
      },
      applyWorldInfoStateDelta: (tx: Database) => {
        applied.push("world");
        tx.query("UPDATE delta_probe SET count = count + 1 WHERE kind = 'world'").run();
      },
      renderPreparation: {
        ...render(),
        regexActionDeltas: [regexDelta],
        worldInfoStateDeltas: [worldDelta],
      },
    };
    expect(commitAgenticTurnV1(candidate).status).toBe("committed");
    expect(applied).toEqual(["regex", "world"]);
    expect(db.query("SELECT kind, count FROM delta_probe ORDER BY kind").all()).toEqual([
      { kind: "regex", count: 1 },
      { kind: "world", count: 1 },
    ]);

    db.close();
    db = createDatabase();
    db.run("CREATE TABLE delta_probe (kind TEXT PRIMARY KEY, count INTEGER NOT NULL)");
    db.run("INSERT INTO delta_probe (kind, count) VALUES ('regex', 0), ('world', 0)");
    const failing = {
      ...candidate,
      db,
      applyRegexActionDelta: (tx: Database) => {
        tx.query("UPDATE delta_probe SET count = count + 1 WHERE kind = 'regex'").run();
      },
      applyWorldInfoStateDelta: () => {
        throw new Error("injected world-info failure");
      },
    };
    expect(() => commitAgenticTurnV1(failing)).toThrow();
    expect(db.query("SELECT kind, count FROM delta_probe ORDER BY kind").all()).toEqual([
      { kind: "regex", count: 0 },
      { kind: "world", count: 0 },
    ]);
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
  });

  test("applies only authorized metadata, macro, and source-message deltas", () => {
    db = createDatabase();
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      authorizeChatMetadataDelta: () => true,
      authorizeMacroVariableDelta: () => true,
      authorizeSourceMessageDelta: () => true,
      renderPreparation: {
        ...render(),
        macroVariableDeltas: [{ kind: "macro_variable" as const, scope: "chat" as const, key: "phase", operation: "set" as const, value: "done" }],
        sourceMessageDeltas: [{ kind: "source_message" as const, sourceMessageId: "source-1", operation: "create" as const, role: "system" as const, content: "source" }],
        chatMetadataDeltas: [{ kind: "chat_metadata" as const, key: "last_generation_id", operation: "set" as const, value: "generation-1" }],
      },
    };
    expect(commitAgenticTurnV1(candidate).status).toBe("committed");
    const chat = db.query("SELECT metadata FROM chats WHERE id = ?").get("chat-1") as { metadata: string };
    expect(JSON.parse(chat.metadata)).toMatchObject({ chat_variables: { phase: "done" }, last_generation_id: "generation-1" });
    expect(db.query("SELECT content FROM messages WHERE id = ?").get("source-1")).toEqual({ content: "source" });
  });

  test("applies assembly deltas before render deltas in the commit transaction", () => {
    db = createDatabase();
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      assembleDeltas: [{ kind: "macro_variable" as const, scope: "chat" as const, key: "assembled", operation: "set" as const, value: "yes" }],
      authorizeMacroVariableDelta: () => true,
    };
    expect(commitAgenticTurnV1(candidate).status).toBe("committed");
    const chat = db.query("SELECT metadata FROM chats WHERE id = ?").get("chat-1") as { metadata: string };
    expect(JSON.parse(chat.metadata)).toMatchObject({ chat_variables: { assembled: "yes" } });
  });
  test("preserves world-info state when later ordered metadata and macro deltas commit", () => {
    db = createDatabase();
    const worldDelta = {
      kind: "world_info_state" as const,
      entryId: "entry-1",
      operation: "activate" as const,
      state: "active" as const,
      afterState: { active: true, stickyLeft: 1, cooldownLeft: 0, delayCount: 0 },
      expectedRevision: 1,
    };
    const macroDelta = {
      kind: "macro_variable" as const,
      scope: "chat" as const,
      key: "during_world",
      operation: "set" as const,
      value: "preserved",
      expectedRevision: 1,
    };
    const metadataDelta = {
      kind: "chat_metadata" as const,
      key: "after_world",
      operation: "set" as const,
      value: "preserved",
      expectedRevision: 1,
    };
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      assembleDeltas: [worldDelta, macroDelta, metadataDelta],
      authorizeWorldInfoStateDelta: () => true,
      authorizeMacroVariableDelta: () => true,
      authorizeChatMetadataDelta: () => true,
      applyWorldInfoStateDelta: (_db: Database, _delta: unknown, metadata?: Record<string, unknown>) => {
        if (!metadata) throw new Error("missing transaction metadata");
        const current = metadata.wi_state && typeof metadata.wi_state === "object" && !Array.isArray(metadata.wi_state)
          ? { ...(metadata.wi_state as Record<string, unknown>) }
          : {};
        current.entry_uid = worldDelta.afterState;
        metadata.wi_state = current;
      },
    };
    expect(commitAgenticTurnV1(candidate).status).toBe("committed");
    const chat = db.query("SELECT metadata FROM chats WHERE id = ?").get("chat-1") as { metadata: string };
    expect(JSON.parse(chat.metadata)).toMatchObject({
      wi_state: { entry_uid: worldDelta.afterState },
      chat_variables: { during_world: "preserved" },
      after_world: "preserved",
    });
  });

  test("rejects malformed assembly deltas before the commit CAS", () => {
    db = createDatabase();
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      assembleDeltas: [{ kind: "unknown" }] as never,
    };
    expect(() => commitAgenticTurnV1(candidate)).toThrow();
    expect(db.query("SELECT state FROM agent_turn_executions WHERE id = ?").get("turn-1")).toEqual({ state: "PREPARE_COMMIT" });
  });

  test("rejects private message metadata before writing a message", () => {
    db = createDatabase();
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      message: { extra: { transcript: "private" } },
    };
    expect(() => commitAgenticTurnV1(candidate)).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
  });

  test("fails closed when a macro or source delta has no host authorization", () => {
    db = createDatabase();
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      renderPreparation: {
        ...render(),
        macroVariableDeltas: [{ kind: "macro_variable" as const, scope: "chat" as const, key: "phase", operation: "set" as const, value: "blocked" }],
      },
    };
    expect(() => commitAgenticTurnV1(candidate)).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
  });
  test("rejects local macro deltas without a durable route", () => {
    db = createDatabase();
    const candidate = {
      ...input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false),
      authorizeMacroVariableDelta: () => true,
      renderPreparation: {
        ...render(),
        macroVariableDeltas: [{ kind: "macro_variable" as const, scope: "local" as const, key: "ephemeral", operation: "set" as const, value: "no-durable-row" }],
      },
    };
    let caught: unknown;
    try {
      commitAgenticTurnV1(candidate);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgenticCommitError);
    expect((caught as AgenticCommitError).code).toBe("unsupported_delta");
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 0 });
  });
  test("commits a continue target into the selected swipe", () => {
    db = createDatabase();
    seedTargetMessage(db);
    bindExecutionTarget(db, "continue", "message-1", 0);
    const base = input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false);
    const candidate = {
      ...base,
      target: { ...base.target, target: "continue" as const, messageId: "message-1", swipeId: 0, messageIndex: 0, swipeCount: 2, messageGenerationRevision: 0 },
    };
    expect(commitAgenticTurnV1(candidate).status).toBe("committed");
    expect(db.query("SELECT content FROM messages WHERE id = ?").get("message-1")).toEqual({ content: "oldcommitted answer" });
  });
  test("continue target-reconciliation metadata is not asserted as a chat revision", () => {
    db = createDatabase();
    seedTargetMessage(db);
    bindExecutionTarget(db, "continue", "message-1", 0);
    const base = input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false);
    const candidate = {
      ...base,
      target: { ...base.target, target: "continue" as const, messageId: "message-1", swipeId: 0, messageIndex: 0, swipeCount: 2, messageGenerationRevision: 0 },
      renderPreparation: {
        ...render(),
        chatMetadataDeltas: [{
          kind: "chat_metadata" as const,
          key: "message:message-1:continue",
          operation: "set" as const,
          value: "committed answer",
          expectedRevision: 0,
        }],
      },
    };
    expect(commitAgenticTurnV1(candidate).status).toBe("committed");
    expect(db.query("SELECT content FROM messages WHERE id = ?").get("message-1")).toEqual({ content: "oldcommitted answer" });
    expect(db.query("SELECT metadata FROM chats WHERE id = ?").get("chat-1")).toEqual({ metadata: "{}" });
  });


  test("continue commits when only the target swipe is applied; other-message edits still stale-fence", () => {
    const digestMembers = (members: readonly InputRevisionV1[]) => createHash("sha256").update(JSON.stringify(members.map((member) => ({
      digest: member.digest,
      id: member.id,
      kind: member.kind,
      revision: member.revision,
    })))).digest("hex");
    const seedContinueMessages = (database: Database) => {
      seedTargetMessage(database);
      database.query("INSERT INTO messages (id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id, swipes, swipe_dates, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        "message-2", "chat-1", 1, 1, "User", "prompt", 1, 0, JSON.stringify(["prompt"]), JSON.stringify([1]), "{}", 1,
      );
    };
    const withLiveMessageFence = (database: Database, mutate?: (database: Database) => void) => {
      seedContinueMessages(database);
      bindExecutionTarget(database, "continue", "message-1", 0);
      const targetRow = database.query("SELECT generation_revision FROM messages WHERE id = ? AND chat_id = ?").get("message-1", "chat-1") as { generation_revision?: unknown };
      const otherRow = database.query("SELECT generation_revision FROM messages WHERE id = ? AND chat_id = ?").get("message-2", "chat-1") as { generation_revision?: unknown };
      const targetMember = { kind: "message" as const, id: "message-1", ...liveMessageInputRevision("message-1", targetRow.generation_revision) };
      const otherMember = { kind: "message" as const, id: "message-2", ...liveMessageInputRevision("message-2", otherRow.generation_revision) };
      const members: InputRevisionV1[] = [...testRevisionSet.revisions, targetMember, otherMember];
      const revisions = { version: 1 as const, revisions: members, digest: digestMembers(members) };
      mutate?.(database);
      const base = input(database, AGENTIC_COMMIT_DEPENDENCIES_V1, false);
      return {
        ...base,
        target: {
          ...base.target,
          target: "continue" as const,
          messageId: "message-1",
          swipeId: 0,
          messageIndex: 0,
          swipeCount: 2,
          messageGenerationRevision: Number(targetRow.generation_revision ?? 0),
        },
        renderPreparation: { ...render(), inputRevisions: revisions },
        inputRevisions: revisions,
        revisionReader: (member, liveDb) => {
          const fenceDb = liveDb ?? database;
          if (member.kind === "message") {
            const live = fenceDb.query("SELECT generation_revision FROM messages WHERE id = ? AND chat_id = ? LIMIT 1").get(member.id, "chat-1") as { generation_revision?: unknown } | null;
            return live ? liveMessageInputRevision(member.id, live.generation_revision) : null;
          }
          return members.find((entry) => entry.kind === member.kind && entry.id === member.id) ?? null;
        },
      } satisfies AgenticCommitInputV1;
    };

    db = createDatabase();
    expect(commitAgenticTurnV1(withLiveMessageFence(db, (live) => {
      live.query("UPDATE messages SET extra = ?, swipe_dates = ? WHERE id = ? AND chat_id = ?").run(
        JSON.stringify({ streamed: true }),
        JSON.stringify([99, 99]),
        "message-1",
        "chat-1",
      );
    })).status).toBe("committed");
    expect(db.query("SELECT content FROM messages WHERE id = ?").get("message-1")).toEqual({ content: "oldcommitted answer" });
    expect(db.query("SELECT content FROM messages WHERE id = ?").get("message-2")).toEqual({ content: "prompt" });
    db.close();

    db = createDatabase();
    let otherCaught: unknown;
    try {
      commitAgenticTurnV1(withLiveMessageFence(db, (live) => {
        live.query("UPDATE messages SET generation_revision = generation_revision + 1, content = ? WHERE id = ? AND chat_id = ?").run(
          "hostile edit",
          "message-2",
          "chat-1",
        );
      }));
    } catch (error) {
      otherCaught = error;
    }
    expect(otherCaught).toBeInstanceOf(AgenticCommitError);
    expect((otherCaught as AgenticCommitError).code).toBe("stale_input_revision");
    expect(db.query("SELECT content FROM messages WHERE id = ?").get("message-1")).toEqual({ content: "old" });
    expect(db.query("SELECT content FROM messages WHERE id = ?").get("message-2")).toEqual({ content: "hostile edit" });
  });

  test("commits regenerate and swipe targets without creating messages", () => {
    for (const target of ["regenerate", "swipe"] as const) {
      db = createDatabase();
      seedTargetMessage(db);
      bindExecutionTarget(db, target, "message-1", 1);
      const base = input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false);
      const candidate = {
        ...base,
        target: { ...base.target, target, messageId: "message-1", swipeId: 1, messageIndex: 0, swipeCount: 2, messageGenerationRevision: 0 },
      };
      const result = commitAgenticTurnV1(candidate);
      expect(result.status).toBe("committed");
      const updated = db.query("SELECT content, swipe_id, swipes FROM messages WHERE id = ?").get("message-1") as { content: string; swipe_id: number; swipes: string };
      expect(updated.content).toBe("committed answer");
      expect(updated.swipe_id).toBe(1);
      expect(JSON.parse(updated.swipes)).toEqual(["old", "committed answer"]);
      expect(result.messageId).toBe("message-1");
      expect(result.swipeId).toBe(1);
      expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 1 });
      db.close();
    }
    db = createDatabase();
  });
  test("appends and activates a real new-swipe target", () => {
    db = createDatabase();
    seedTargetMessage(db);
    bindExecutionTarget(db, "swipe", "message-1", 2);
    const base = input(db, AGENTIC_COMMIT_DEPENDENCIES_V1, false);
    const candidate = {
      ...base,
      target: { ...base.target, target: "swipe" as const, messageId: "message-1", swipeId: 2, messageIndex: 0, swipeCount: 2, messageGenerationRevision: 0 },
    };

    expect(commitAgenticTurnV1(candidate).status).toBe("committed");
    const updated = db.query("SELECT content, swipe_id, swipes FROM messages WHERE id = ?").get("message-1") as { content: string; swipe_id: number; swipes: string };
    expect(updated.content).toBe("committed answer");
    expect(updated.swipe_id).toBe(2);
    expect(JSON.parse(updated.swipes)).toEqual(["old", "other", "committed answer"]);
    expect(db.query("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ?").get("chat-1")).toEqual({ count: 1 });
  });

});

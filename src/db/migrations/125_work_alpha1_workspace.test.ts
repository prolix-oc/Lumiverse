import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { createPreBundleDatabase } from "./test-helpers";
const migration117Sql = await Bun.file(join(import.meta.dir, "117_agent_turn_workspace.sql")).text();
const migration125Sql = await Bun.file(join(import.meta.dir, "125_work_alpha1_workspace.sql")).text();
const migration125SchemaSql = migration125Sql.split(
  "-- Stage the exact deterministic legacy projection",
  1,
)[0];
// Recreate the pre-canonical 117 schema so this test exercises the one-time
// 125 translation path rather than treating legacy values as fresh-install data.
const legacyMigration117Sql = migration117Sql
  .replace(
    "state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'))",
    "state TEXT NOT NULL CHECK(state IN ('active', 'blocked', 'submitted'))",
  )
  .replace(
    "state TEXT NOT NULL CHECK(state IN ('submitted', 'accepted', 'rejected'))",
    "state TEXT NOT NULL CHECK(state IN ('proposed', 'accepted', 'rejected'))",
  );


const DIGEST = "a".repeat(64);
const RESULT_DIGEST = "b".repeat(64);
const BLOB_DIGEST = "c".repeat(64);
const PUBLISHED_DIGEST = "d".repeat(64);

function createPopulated117Database(): Database {
  const db = createPreBundleDatabase();
  db.run(legacyMigration117Sql);
  db.run("PRAGMA foreign_keys = ON");

  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)")
    .run("u1", "Test", "u1@example.test");
  db.query("INSERT INTO characters (id, name) VALUES (?, ?)")
    .run("character-1", "Character");
  db.query("INSERT INTO chats (id, user_id, character_id) VALUES (?, ?, ?)")
    .run("chat-1", "u1", "character-1");
  db.query("INSERT INTO messages (id, chat_id, index_in_chat, content) VALUES (?, ?, ?, ?)")
    .run("message-1", "chat-1", 0, "hello");

  db.query(
    `INSERT INTO agent_turn_executions
      (id, user_id, chat_id, generation_id, target_kind, target_message_id,
       target_chat_revision, target_message_revision, mode, runtime_epoch,
       deadline_at, state, phase_revision, root_ledger_json, frame_capabilities_json,
       commit_key, expires_at, created_at, updated_at, terminal_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "execution-106", "u1", "chat-1", "generation-106", "normal", "message-1",
    0, 0, "agentic", 1, 2_000_000_000, "COMMIT_FAILED", 7, "{}", "{}",
    "commit-106", 2_000_000_000, 100, 200, 300,
  );

  db.query(
    `INSERT INTO agent_turn_workspaces
      (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
       constraints_json, state, revision, operation_caps_json, field_caps_json,
       retention, expires_at, quota_tasks, quota_records, quota_submissions,
       quota_artifacts, quota_bytes, created_at, updated_at, frozen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "workspace-106", "execution-106", "execution-106", "u1", "chat-1", "legacy objective",
    "[\"legacy constraint\"]", "frozen", 2, "{}", "{}", "turn_terminal", 2_000_000_000,
    10, 10, 10, 10, 1_000_000, 10, 20, 30,
  );

  db.query(
    `INSERT INTO agent_workspace_tasks
      (task_id, workspace_id, turn_id, user_id, chat_id, title, description, state,
       required, dependencies_json, assigned_frame_id, progress, summary, byte_count,
       revision, retention, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "task-106", "workspace-106", "execution-106", "u1", "chat-1", "legacy task",
    "legacy task objective", "submitted", 0, "[\"dependency-106\"]", "frame-106", 1,
    "task summary", 40, 4, "turn_terminal", 2_000_000_000, 11, 21,
  );
  db.query(
    `INSERT INTO agent_workspace_records
      (record_id, workspace_id, turn_id, user_id, chat_id, kind, summary, digest,
       task_id, source_frame_id, byte_count, revision, retention, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "record-106", "workspace-106", "execution-106", "u1", "chat-1", "finding",
    "legacy finding", DIGEST, "task-106", "frame-106", 32, 3, "turn_terminal",
    2_000_000_000, 12,
  );
  db.query(
    `INSERT INTO agent_workspace_submissions
      (submission_id, task_id, workspace_id, turn_id, user_id, chat_id, child_frame_id,
       state, summary, result_digest, byte_count, revision, retention, expires_at,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "submission-106", "task-106", "workspace-106", "execution-106", "u1", "chat-1",
    "frame-106", "proposed", "accepted result", RESULT_DIGEST, 24, 2, "turn_terminal",
    2_000_000_000, 13, 23,
  );
  db.query(
    `INSERT INTO agent_workspace_artifacts
      (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
       byte_count, provenance_json, source_frame_id, source_task_id, publication_state,
       retention, revision, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "artifact-106", "workspace-106", "execution-106", "u1", "chat-1", BLOB_DIGEST,
    "text/plain", 18, JSON.stringify({ source: "legacy" }), "frame-106", "task-106",
    "published", "turn_terminal", 5, 2_000_000_000, 14, 24,
  );
  db.query(
    `INSERT INTO agent_published_workspace_artifacts
      (published_artifact_id, receipt_id, source_artifact_id, blob_digest, user_id, chat_id,
       storage_path, mime_type, byte_count, digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "published-106", "receipt-106", "artifact-106", BLOB_DIGEST, "u1", "chat-1",
    "published/artifact-106", "text/plain", 18, PUBLISHED_DIGEST, 15,
  );

  db.run("PRAGMA foreign_keys = ON");
  return db;
}

describe("125 persistent workspace migration", () => {
  let db: Database;
  let setupComplete = false;

  beforeEach(() => {
    setupComplete = false;
    db = createPopulated117Database();
    setupComplete = true;
  });

  afterEach(() => {
    if (setupComplete) {
      db.close();
      setupComplete = false;
    }
  });
  test("fresh 117 operational schema uses canonical task and submission states", () => {
    const fresh = createPreBundleDatabase();
    try {
      fresh.run(migration117Sql);
      const taskSchema = fresh.query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_workspace_tasks'",
      ).get() as { sql?: unknown } | null;
      const submissionSchema = fresh.query(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_workspace_submissions'",
      ).get() as { sql?: unknown } | null;
      expect(String(taskSchema?.sql ?? "")).toContain(
        "state IN ('pending', 'active', 'blocked', 'completed', 'cancelled', 'failed')",
      );
      expect(String(submissionSchema?.sql ?? "")).toContain(
        "state IN ('submitted', 'accepted', 'rejected')",
      );
    } finally {
      fresh.close();
    }
  });


  test("preserves workspace identity and turn-session associations without backfilling operational rows", () => {
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });

    db.run(migration125Sql);

    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("SELECT state FROM agent_workspace_tasks WHERE task_id = ?").get("task-106")).toEqual({ state: "completed" });
    expect(db.query("SELECT state FROM agent_workspace_submissions WHERE submission_id = ?").get("submission-106")).toEqual({ state: "submitted" });
    expect(() => db.query("UPDATE agent_workspace_tasks SET state = 'submitted' WHERE task_id = ?").run("task-106")).toThrow();
    expect(() => db.query("UPDATE agent_workspace_submissions SET state = 'proposed' WHERE submission_id = ?").run("submission-106")).toThrow();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);

    db.query(
      `INSERT INTO persistent_workspace_artifacts
        (artifact_id, workspace_id, turn_session_id, user_id, chat_id, blob_digest,
         mime_type, byte_count, provenance_json, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "persistent-artifact-106", "workspace-106", "workspace-106", "u1", "chat-1",
      BLOB_DIGEST, "text/plain", 18,
      JSON.stringify({ sourceChatId: "chat-1", sourceMessageId: "message-1", sourceSwipeId: 0 }),
      1, 15, 25,
    );
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_artifacts WHERE artifact_id = ?").get("persistent-artifact-106")).toEqual({ count: 1 });
    db.query(
      `INSERT INTO persistent_workspace_tasks
        (task_id, workspace_id, turn_session_id, user_id, chat_id, title, objective,
         state, required, dependency_ids_json, creator, host_admitted, progress_json,
         summary, byte_count, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "persistent-task-106", "workspace-106", "workspace-106", "u1", "chat-1",
      "persistent task", "durable task objective", "active", 1, "[]", "host", 1,
      "{}", "durable task", 10, 1, 15, 25,
    );
    db.query(
      `INSERT INTO persistent_workspace_tasks
        (task_id, workspace_id, user_id, title, required, creator, host_admitted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("persistent-owner-task-106", "workspace-106", "u1", "owner task", 0, "owner", 0);
    expect(db.query(
      "SELECT required, creator, host_admitted FROM persistent_workspace_tasks WHERE task_id = ?",
    ).get("persistent-owner-task-106")).toEqual({ required: 0, creator: "owner", host_admitted: 0 });
    expect(() => db.query(
      `INSERT INTO persistent_workspace_tasks
        (task_id, workspace_id, user_id, title, required, creator, host_admitted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("persistent-owner-required-106", "workspace-106", "u1", "owner required", 1, "owner", 0)).toThrow();
    expect(() => db.query(
      `INSERT INTO persistent_workspace_tasks
        (task_id, workspace_id, user_id, title, required, creator, host_admitted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("persistent-owner-admitted-106", "workspace-106", "u1", "owner admitted", 0, "owner", 1)).toThrow();
    expect(() => db.query(
      `INSERT INTO persistent_workspace_tasks
        (task_id, workspace_id, user_id, title, required, creator, host_admitted)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("persistent-host-unadmitted-106", "workspace-106", "u1", "host unadmitted", 1, "host", 0)).toThrow();
    db.query(
      `INSERT INTO persistent_workspace_records
        (record_id, workspace_id, turn_session_id, user_id, chat_id, kind, content_json,
         summary, task_id, byte_count, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "persistent-record-106", "workspace-106", "workspace-106", "u1", "chat-1",
      "finding", JSON.stringify({ detail: "durable finding" }), "durable finding",
      "persistent-task-106", 12, 1, 15, 25,
    );
    db.query(
      `INSERT INTO persistent_workspace_submissions
        (submission_id, workspace_id, turn_session_id, task_id, user_id, chat_id, state,
         summary, result_digest, byte_count, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "persistent-submission-106", "workspace-106", "workspace-106", "persistent-task-106",
      "u1", "chat-1", "accepted", "durable result", RESULT_DIGEST, 14, 1, 15, 25,
    );

    expect(db.query(
      `SELECT workspace_id, user_id, chat_id, objective, state, revision, created_at, updated_at
         FROM persistent_workspaces
        WHERE workspace_id = ?`,
    ).get("workspace-106")).toEqual({
      workspace_id: "workspace-106",
      user_id: "u1",
      chat_id: "chat-1",
      objective: "legacy objective",
      state: "archived",
      revision: 2,
      created_at: 10,
      updated_at: 20,
    });

    expect(db.query(
      `SELECT turn_session_id, workspace_id, turn_id, attempt_id, execution_id,
              phase, status, outcome, revision, created_at, updated_at, terminal_at
         FROM persistent_workspace_turn_sessions
        WHERE turn_session_id = ?`,
    ).get("workspace-106")).toEqual({
      turn_session_id: "workspace-106",
      workspace_id: "workspace-106",
      turn_id: "execution-106",
      attempt_id: "execution-106",
      execution_id: "execution-106",
      phase: "TERMINAL",
      status: "terminal",
      outcome: "failed",
      revision: 7,
      created_at: 100,
      updated_at: 200,
      terminal_at: 300,
    });

    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_tasks WHERE task_id = ?").get("task-106")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_records WHERE record_id = ?").get("record-106")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_submissions WHERE submission_id = ?").get("submission-106")).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_artifacts WHERE artifact_id = ?").get("artifact-106")).toEqual({ count: 0 });


    const publication = db.query(
      `SELECT publication_id, workspace_id, user_id, chat_id, category, source_id,
              source_provenance_json, copy_json, copy_digest, published_by
         FROM persistent_workspace_publications
        WHERE publication_id = ?`,
    ).get("published-106") as Record<string, unknown>;
    expect(publication).toMatchObject({
      publication_id: "published-106",
      workspace_id: "workspace-106",
      user_id: "u1",
      chat_id: "chat-1",
      category: "artifact",
      source_id: "artifact-106",
      copy_digest: PUBLISHED_DIGEST,
      published_by: "migration:106",
    });
    expect(JSON.parse(String(publication.source_provenance_json))).toMatchObject({
      workspaceId: "workspace-106",
      turnSessionId: "workspace-106",
      attemptId: "execution-106",
      executionId: "execution-106",
      sourceChatId: "chat-1",
    });
    const persistentTables = [
      "persistent_workspaces",
      "persistent_workspace_turn_sessions",
      "persistent_workspace_tasks",
      "persistent_workspace_records",
      "persistent_workspace_submissions",
      "persistent_workspace_artifacts",
      "persistent_workspace_publications",
    ] as const;
    const foreignKeysFor = (table: (typeof persistentTables)[number]) => (
      db.query(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table?: string; from?: string; to?: string; on_delete?: string }>
    );
    for (const table of persistentTables) {
      const foreignKeys = foreignKeysFor(table);
      expect(foreignKeys.filter((foreignKey) => foreignKey.table === "chats" && foreignKey.from !== "chat_id")).toEqual([]);
    }
    expect(foreignKeysFor("persistent_workspaces").some(
      (foreignKey) => foreignKey.table === "chats"
        && foreignKey.from === "chat_id"
        && foreignKey.to === "id"
        && foreignKey.on_delete === "SET NULL",
    )).toBe(true);
    expect(foreignKeysFor("persistent_workspace_turn_sessions").some(
      (foreignKey) => foreignKey.table === "chats"
        && foreignKey.from === "chat_id"
        && foreignKey.to === "id"
        && foreignKey.on_delete === "CASCADE",
    )).toBe(true);
    for (const table of [
      "persistent_workspace_tasks",
      "persistent_workspace_records",
      "persistent_workspace_submissions",
      "persistent_workspace_artifacts",
      "persistent_workspace_publications",
    ] as const) {
      expect(foreignKeysFor(table).some((foreignKey) => foreignKey.table === "chats")).toBe(false);
    }
    db.query("DELETE FROM agent_published_workspace_artifacts WHERE published_artifact_id = ?").run("published-106");
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE publication_id = ?").get("published-106")).toEqual({ count: 1 });
    expect(JSON.parse(String(publication.copy_json))).toMatchObject({
      category: "artifact",
      id: "artifact-106",
      blobDigest: BLOB_DIGEST,
      mimeType: "text/plain",
      byteCount: 18,
    });
    const attachedArtifact = db.query(
      `SELECT artifact_id, workspace_id, user_id, chat_id, blob_digest, mime_type, byte_count, provenance_json
         FROM persistent_workspace_artifacts
        WHERE artifact_id = ?`,
    ).get("persistent-artifact-106") as Record<string, unknown>;
    expect(attachedArtifact).toMatchObject({
      artifact_id: "persistent-artifact-106",
      workspace_id: "workspace-106",
      user_id: "u1",
      chat_id: "chat-1",
      blob_digest: BLOB_DIGEST,
      mime_type: "text/plain",
      byte_count: 18,
    });
    expect(JSON.parse(String(attachedArtifact.provenance_json))).toEqual({
      sourceChatId: "chat-1",
      sourceMessageId: "message-1",
      sourceSwipeId: 0,
    });
    db.query("UPDATE agent_turn_executions SET target_message_id = NULL, target_swipe_id = NULL WHERE id = ?").run("execution-106");
    db.query("DELETE FROM agent_workspace_artifacts WHERE artifact_id = ?").run("artifact-106");
    db.query("DELETE FROM messages WHERE id = ?").run("message-1");
    db.query("DELETE FROM chats WHERE id = ?").run("chat-1");
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const retainedPublication = db.query(
      "SELECT chat_id, source_provenance_json FROM persistent_workspace_publications WHERE publication_id = ?",
    ).get("published-106") as { chat_id: string | null; source_provenance_json: string };
    expect(retainedPublication.chat_id).toBe("chat-1");
    expect(JSON.parse(retainedPublication.source_provenance_json)).toMatchObject({
      turnSessionId: "workspace-106",
      attemptId: "execution-106",
      executionId: "execution-106",
      sourceChatId: "chat-1",
    });

    const durableArtifact = db.query(
      `SELECT artifact_id, workspace_id, user_id, chat_id, blob_digest, mime_type, byte_count, provenance_json
         FROM persistent_workspace_artifacts
        WHERE artifact_id = ?`,
    ).get("persistent-artifact-106") as Record<string, unknown>;
    expect(durableArtifact).toMatchObject({
      artifact_id: "persistent-artifact-106",
      workspace_id: "workspace-106",
      user_id: "u1",
      chat_id: "chat-1",
      blob_digest: BLOB_DIGEST,
      mime_type: "text/plain",
      byte_count: 18,
    });
    expect(JSON.parse(String(durableArtifact.provenance_json))).toEqual({
      sourceChatId: "chat-1",
      sourceMessageId: "message-1",
      sourceSwipeId: 0,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_tasks WHERE task_id = ?").get("persistent-task-106")).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_records WHERE record_id = ?").get("persistent-record-106")).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_submissions WHERE submission_id = ?").get("persistent-submission-106")).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM persistent_workspace_publications WHERE publication_id = ?").get("published-106")).toEqual({ count: 1 });
    expect(db.query("SELECT chat_id FROM persistent_workspaces WHERE workspace_id = ?").get("workspace-106")).toEqual({ chat_id: null });
  });
  test("backfills canonical session outcomes from execution phases and codes", () => {
    const cases = [
      { state: "COMMITTED", code: "committed", status: "terminal", outcome: "completed" },
      { state: "CANCELLED", code: "agentic_cancelled", status: "terminal", outcome: "stopped" },
      { state: "TIMED_OUT", code: "root_wall_clock_limit_exceeded", status: "terminal", outcome: "failed" },
      { state: "EXHAUSTED", code: "agentic_work_exhausted", status: "terminal", outcome: "exhausted" },
      { state: "FAILED", code: "root_wall_clock_limit_exceeded", status: "terminal", outcome: "failed" },
      { state: "WORK", code: null, status: "running", outcome: null },
    ] as const;

    for (const expected of cases) {
      const candidate = createPopulated117Database();
      try {
        candidate.query(
          "UPDATE agent_turn_executions SET state = ?, terminal_code = ?, terminal_at = ? WHERE id = ?",
        ).run(expected.state, expected.code, expected.state === "WORK" ? null : 300, "execution-106");
        candidate.run(migration125Sql);
        expect(candidate.query(
          "SELECT status, outcome FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
        ).get("workspace-106")).toEqual({
          status: expected.status,
          outcome: expected.outcome,
        });
      } finally {
        candidate.close();
      }
    }
  });

  test("exact rerun is idempotent after persistent workspace backfill", () => {
    db.run(migration125Sql);
    const snapshot = {
      persistentWorkspaces: db.query(
        "SELECT * FROM persistent_workspaces ORDER BY workspace_id",
      ).all(),
      persistentSessions: db.query(
        "SELECT * FROM persistent_workspace_turn_sessions ORDER BY turn_session_id",
      ).all(),
      persistentPublications: db.query(
        "SELECT * FROM persistent_workspace_publications ORDER BY publication_id",
      ).all(),
      operationalTasks: db.query(
        "SELECT * FROM agent_workspace_tasks ORDER BY task_id",
      ).all(),
      operationalRecords: db.query(
        "SELECT * FROM agent_workspace_records ORDER BY record_id",
      ).all(),
      operationalSubmissions: db.query(
        "SELECT * FROM agent_workspace_submissions ORDER BY submission_id",
      ).all(),
      operationalArtifacts: db.query(
        "SELECT * FROM agent_workspace_artifacts ORDER BY artifact_id",
      ).all(),
    };

    db.run(migration125Sql);

    expect({
      persistentWorkspaces: db.query(
        "SELECT * FROM persistent_workspaces ORDER BY workspace_id",
      ).all(),
      persistentSessions: db.query(
        "SELECT * FROM persistent_workspace_turn_sessions ORDER BY turn_session_id",
      ).all(),
      persistentPublications: db.query(
        "SELECT * FROM persistent_workspace_publications ORDER BY publication_id",
      ).all(),
      operationalTasks: db.query(
        "SELECT * FROM agent_workspace_tasks ORDER BY task_id",
      ).all(),
      operationalRecords: db.query(
        "SELECT * FROM agent_workspace_records ORDER BY record_id",
      ).all(),
      operationalSubmissions: db.query(
        "SELECT * FROM agent_workspace_submissions ORDER BY submission_id",
      ).all(),
      operationalArtifacts: db.query(
        "SELECT * FROM agent_workspace_artifacts ORDER BY artifact_id",
      ).all(),
    }).toEqual(snapshot);
  });

  test("aborts immutable persistent workspace collisions before backfill", () => {
    const collisions = [
      { userId: "u1", chatId: "chat-1", objective: "mismatched objective" },
      { userId: "u2", chatId: "chat-1", objective: "legacy objective" },
      { userId: "u1", chatId: "chat-2", objective: "legacy objective" },
    ] as const;

    for (const collision of collisions) {
      const collisionDb = createPopulated117Database();
      try {
        if (collision.userId !== "u1") {
          collisionDb.query(
            `INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)`,
          ).run(collision.userId, "Other", "u2@example.test");
        }
        if (collision.chatId !== "chat-1") {
          collisionDb.query(
            "INSERT INTO chats (id, user_id, character_id) VALUES (?, ?, ?)",
          ).run(collision.chatId, "u1", "character-1");
        }
        expect(collisionDb.query(
          `SELECT old.workspace_id, old.user_id, old.chat_id, old.objective
             FROM agent_turn_workspaces AS old
            WHERE old.workspace_id = (
              SELECT MIN(candidate.workspace_id)
                FROM agent_turn_workspaces AS candidate
               WHERE candidate.user_id = old.user_id
                 AND candidate.chat_id = old.chat_id
            )`,
        ).get()).toEqual({
          workspace_id: "workspace-106",
          user_id: "u1",
          chat_id: "chat-1",
          objective: "legacy objective",
        });
        collisionDb.run(migration125SchemaSql);
        collisionDb.query(
          `INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id, objective)
           VALUES (?, ?, ?, ?)`,
        ).run("workspace-106", collision.userId, collision.chatId, collision.objective);

        const before = {
          persistentWorkspaces: collisionDb.query(
            "SELECT * FROM persistent_workspaces ORDER BY workspace_id",
          ).all(),
          persistentSessions: collisionDb.query(
            "SELECT * FROM persistent_workspace_turn_sessions ORDER BY turn_session_id",
          ).all(),
          persistentPublications: collisionDb.query(
            "SELECT * FROM persistent_workspace_publications ORDER BY publication_id",
          ).all(),
          taskState: collisionDb.query(
            "SELECT state FROM agent_workspace_tasks WHERE task_id = ?",
          ).get("task-106"),
          submissionState: collisionDb.query(
            "SELECT state FROM agent_workspace_submissions WHERE submission_id = ?",
          ).get("submission-106"),
        };

        expect(() => collisionDb.run(migration125Sql)).toThrow(
          /no such index: persistent_workspace_migration_collision_guard/,
        );
        expect({
          persistentWorkspaces: collisionDb.query(
            "SELECT * FROM persistent_workspaces ORDER BY workspace_id",
          ).all(),
          persistentSessions: collisionDb.query(
            "SELECT * FROM persistent_workspace_turn_sessions ORDER BY turn_session_id",
          ).all(),
          persistentPublications: collisionDb.query(
            "SELECT * FROM persistent_workspace_publications ORDER BY publication_id",
          ).all(),
          taskState: collisionDb.query(
            "SELECT state FROM agent_workspace_tasks WHERE task_id = ?",
          ).get("task-106"),
          submissionState: collisionDb.query(
            "SELECT state FROM agent_workspace_submissions WHERE submission_id = ?",
          ).get("submission-106"),
        }).toEqual(before);
      } finally {
        collisionDb.close();
      }
    }
  });
});

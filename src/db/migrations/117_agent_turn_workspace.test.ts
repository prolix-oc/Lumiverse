import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { createPreBundleDatabase } from "./test-helpers";
const migrationSql = await Bun.file(join(import.meta.dir, "117_agent_turn_workspace.sql")).text();

function createDatabase(): Database {
  const db = createPreBundleDatabase();
  db.run(migrationSql);
  db.run("PRAGMA foreign_keys = ON");
  return db;
}

describe("117 agent turn workspace ownership", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase();
    db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run("u1", "Test", "u1@example.test");
    db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run("u2", "Other", "u2@example.test");
    db.query("INSERT INTO characters (id, name) VALUES (?, ?)").run("character-1", "Character");
    db.query("INSERT INTO characters (id, name) VALUES (?, ?)").run("character-2", "Other Character");
    db.query("INSERT INTO chats (id, user_id, character_id) VALUES (?, ?, ?)").run("chat-1", "u1", "character-1");
    db.query("INSERT INTO chats (id, user_id, character_id) VALUES (?, ?, ?)").run("chat-2", "u2", "character-2");
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, content) VALUES (?, ?, ?, ?)").run("message-1", "chat-1", 0, "hello");
    db.query("INSERT INTO messages (id, chat_id, index_in_chat, content) VALUES (?, ?, ?, ?)").run("message-2", "chat-2", 0, "other");
    db.query(
      `INSERT INTO agent_turn_executions
        (id, user_id, chat_id, generation_id, target_kind, target_message_id,
         target_chat_revision, target_message_revision, mode, runtime_epoch,
         deadline_at, state, root_ledger_json, frame_capabilities_json,
         commit_key, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "turn-1", "u1", "chat-1", "generation-1", "regenerate", "message-1",
      0, 0, "agentic", 1, 2_000_000_000, "ASSEMBLE", "{}", "{}", "commit-1", 2_000_000_000,
    );
    db.query(
      `INSERT INTO agent_turn_workspaces
        (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
         constraints_json, state, operation_caps_json, field_caps_json,
         retention, expires_at, quota_tasks, quota_records, quota_submissions,
         quota_artifacts, quota_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-1", "turn-1", "turn-1", "u1", "chat-1", "objective", "{}", "active", "{}", "{}",
      "operational", 2_000_000_000, 10, 10, 10, 10, 1_000_000,
    );
  });

  afterEach(() => {
    db.close();
  });

  test("restricts deleting an exact target until the turn is cleaned up", () => {
    expect(() => db.query("DELETE FROM messages WHERE id = ? AND chat_id = ?").run("message-1", "chat-1")).toThrow();

    // Operational cleanup removes the execution (and its workspace) first;
    // only then can the user-owned target message be deleted.
    db.query("DELETE FROM agent_turn_executions WHERE id = ?").run("turn-1");
    expect(() => db.query("DELETE FROM messages WHERE id = ? AND chat_id = ?").run("message-1", "chat-1")).not.toThrow();
  });

  test("rejects cross-user message and task references", () => {
    expect(() => db.query(
      `INSERT INTO agent_turn_commit_receipts
        (receipt_id, turn_id, execution_id, workspace_id, user_id, chat_id,
         commit_key, idempotency_key, summary_digest, summary_json, message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-cross-chat", "turn-1", "turn-1", "workspace-1", "u1", "chat-1",
      "commit-cross-chat", "idempotency-cross-chat", "a".repeat(64), "{}", "message-2",
    )).toThrow();

    db.query(
      `INSERT INTO agent_turn_executions
        (id, user_id, chat_id, generation_id, target_kind, target_chat_revision,
         mode, runtime_epoch, deadline_at, state, root_ledger_json,
         frame_capabilities_json, commit_key, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "turn-2", "u2", "chat-2", "generation-2", "normal", 0, "agentic", 1,
      2_000_000_000, "ASSEMBLE", "{}", "{}", "commit-2", 2_000_000_000,
    );
    db.query(
      `INSERT INTO agent_turn_workspaces
        (workspace_id, turn_id, execution_id, user_id, chat_id, objective,
         constraints_json, state, operation_caps_json, field_caps_json,
         retention, expires_at, quota_tasks, quota_records, quota_submissions,
         quota_artifacts, quota_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "workspace-2", "turn-2", "turn-2", "u2", "chat-2", "objective", "{}", "active", "{}", "{}",
      "operational", 2_000_000_000, 10, 10, 10, 10, 1_000_000,
    );
    db.query(
      `INSERT INTO agent_workspace_tasks
        (task_id, workspace_id, turn_id, user_id, chat_id, title, state,
         retention, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("task-2", "workspace-2", "turn-2", "u2", "chat-2", "foreign", "active", "operational", 2_000_000_000);

    expect(() => db.query(
      `INSERT INTO agent_workspace_records
        (record_id, workspace_id, turn_id, user_id, chat_id, kind, summary,
         digest, task_id, byte_count, retention, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "record-cross-user", "workspace-1", "turn-1", "u1", "chat-1", "finding", "cross-user",
      "b".repeat(64), "task-2", 11, "operational", 2_000_000_000,
    )).toThrow();
  });
  test("scopes blobs per user, retains crash journals, and decrements published refs", () => {
    const digest = "c".repeat(64);
    const insertBlob = db.query(
      `INSERT INTO agent_artifact_blobs
        (digest, user_id, byte_count, mime_type, storage_path, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertBlob.run(digest, "u1", 4, "text/plain", "/tmp/u1.blob", 2_000_000_000);
    insertBlob.run(digest, "u2", 4, "text/plain", "/tmp/u2.blob", 2_000_000_000);
    expect(db.query("SELECT COUNT(*) AS count FROM agent_artifact_blobs WHERE digest = ?").get(digest)).toEqual({ count: 2 });

    db.query(
      `INSERT INTO agent_artifact_blob_journal
        (journal_id, blob_digest, user_id, turn_id, creator_token, fence_generation,
         staged_path, final_path, state, byte_count, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "journal-1", digest, "u1", "turn-1", "creator-1", 1,
      "/tmp/u1.part", "/tmp/u1.blob", "installed", 4, digest,
    );
    db.query("DELETE FROM agent_turn_executions WHERE id = ?").run("turn-1");
    expect(db.query("SELECT state FROM agent_artifact_blob_journal WHERE journal_id = ?").get("journal-1")).toEqual({ state: "installed" });

    db.query("UPDATE agent_artifact_blobs SET published_reference_count = 1 WHERE user_id = ? AND digest = ?").run("u1", digest);
    db.query(
      `INSERT INTO agent_published_workspace_artifacts
        (published_artifact_id, receipt_id, source_artifact_id, blob_digest, user_id,
         chat_id, message_id, storage_path, mime_type, byte_count, digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "published-1", "receipt-1", "source-1", digest, "u1",
      "chat-1", "message-1", "/tmp/u1.blob", "text/plain", 4, digest,
    );
    db.query("DELETE FROM agent_published_workspace_artifacts WHERE published_artifact_id = ?").run("published-1");
    expect(db.query(
      "SELECT published_reference_count AS count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?",
    ).get("u1", digest)).toEqual({ count: 0 });
  });

});

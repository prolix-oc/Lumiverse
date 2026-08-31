import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { applyFeatureMigrationsThrough, createPreBundleDatabase } from "./test-helpers";
const migration132Sql = await Bun.file(join(import.meta.dir, "132_persistent_workspace_chat_detach.sql")).text();

const CANONICAL_TRIGGERS = [
  "trg_persistent_workspace_detach_children_on_chat_delete",
  "trg_persistent_workspace_publications_immutable_update",
  "trg_persistent_workspaces_archive_on_detach",
] as const;

function createDatabase(): Database {
  const db = createPreBundleDatabase();
  applyFeatureMigrationsThrough(db, 132);
  return db;
}

function triggerNames(db: Database): string[] {
  return (db.query(
    `SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (?, ?, ?)
      ORDER BY name`,
  ).all(...CANONICAL_TRIGGERS) as Array<{ name: string }>).map((row) => row.name);
}

function seedPersistentRows(db: Database): void {
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)")
    .run("detach-user", "Detach User", "detach-user@example.test");
  db.query("INSERT INTO characters (id, name) VALUES (?, ?)")
    .run("detach-character", "Detach Character");
  db.query("INSERT INTO chats (id, user_id, character_id, name) VALUES (?, ?, ?, ?)")
    .run("detach-chat", "detach-user", "detach-character", "Detach Chat");
  db.query(`INSERT INTO persistent_workspaces
    (workspace_id, user_id, chat_id, objective, revision)
    VALUES (?, ?, ?, ?, 0)`)
    .run("detach-workspace", "detach-user", "detach-chat", "Detach objective");
  db.query(`INSERT INTO persistent_workspace_turn_sessions
    (turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id, execution_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("detach-session", "detach-workspace", "detach-user", "detach-chat", "detach-turn", "detach-attempt", "detach-execution");
  db.query(`INSERT INTO persistent_workspace_tasks
    (task_id, workspace_id, turn_session_id, user_id, chat_id, title)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run("detach-task", "detach-workspace", "detach-session", "detach-user", "detach-chat", "Detach task");
  db.query(`INSERT INTO persistent_workspace_records
    (record_id, workspace_id, turn_session_id, user_id, chat_id, kind, content_json, summary)
    VALUES (?, ?, ?, ?, ?, 'finding', ?, ?)`)
    .run("detach-record", "detach-workspace", "detach-session", "detach-user", "detach-chat", "{\"summary\":\"Detach finding\"}", "Detach finding");
  db.query(`INSERT INTO persistent_workspace_submissions
    (submission_id, workspace_id, turn_session_id, task_id, user_id, chat_id, summary, result_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("detach-submission", "detach-workspace", "detach-session", "detach-task", "detach-user", "detach-chat", "Detach submission", "a".repeat(64));
  db.query(`INSERT INTO persistent_workspace_artifacts
    (artifact_id, workspace_id, turn_session_id, user_id, chat_id, blob_digest, mime_type, byte_count)
    VALUES (?, ?, ?, ?, ?, ?, 'text/plain', 1)`)
    .run("detach-artifact", "detach-workspace", "detach-session", "detach-user", "detach-chat", "b".repeat(64));
  db.query(`INSERT INTO persistent_workspace_publications
    (publication_id, workspace_id, user_id, chat_id, category, source_id, source_revision,
     source_provenance_json, source_created_at, source_updated_at, copy_json, copy_digest,
     byte_count, published_by)
    VALUES (?, ?, ?, ?, 'task', ?, 1, '{}', 1, 1, '{}', ?, 2, 'owner:detach-user')`)
    .run("detach-publication", "detach-workspace", "detach-user", "detach-chat", "detach-task", "c".repeat(64));
}

describe("132 persistent workspace chat detach migration", () => {
  test("keeps baseline trigger names canonical and repairs legacy names idempotently", () => {
    const db = createDatabase();
    try {
      expect(triggerNames(db)).toEqual([...CANONICAL_TRIGGERS].sort());
      db.run(`CREATE TRIGGER persistent_workspace_publications_immutable_update
        BEFORE UPDATE ON persistent_workspace_publications
        BEGIN
          SELECT RAISE(ABORT, 'legacy publication trigger');
        END`);
      db.run(migration132Sql);
      db.run(migration132Sql);
      expect(triggerNames(db)).toEqual([...CANONICAL_TRIGGERS].sort());
      expect(db.query(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'persistent_workspace_publications_immutable_update'",
      ).get()).toEqual({ count: 0 });
      seedPersistentRows(db);
      expect(() => db.query(
        "UPDATE persistent_workspace_publications SET published_by = ? WHERE publication_id = ?",
      ).run("attacker", "detach-publication")).toThrow(/immutable/);
      db.query(
        "UPDATE persistent_workspace_publications SET chat_id = NULL WHERE publication_id = ?",
      ).run("detach-publication");
      expect(db.query(
        "SELECT chat_id FROM persistent_workspace_publications WHERE publication_id = ?",
      ).get("detach-publication")).toEqual({ chat_id: null });
    } finally {
      db.close();
    }
  });
  test("baseline archives a workspace and advances its revision on chat detach", () => {
    const db = createDatabase();
    try {
      seedPersistentRows(db);
      db.query("DELETE FROM chats WHERE id = ?").run("detach-chat");
      expect(db.query(
        "SELECT chat_id, revision, state FROM persistent_workspaces WHERE workspace_id = ?",
      ).get("detach-workspace")).toEqual({ chat_id: null, revision: 1, state: "archived" });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("nulls every persistent child chat association and repairs stale archive revision behavior", () => {
    const db = createDatabase();
    try {
      db.run("DROP TRIGGER trg_persistent_workspaces_archive_on_detach");
      db.run(`CREATE TRIGGER trg_persistent_workspaces_archive_on_detach
        AFTER UPDATE OF chat_id ON persistent_workspaces
        WHEN OLD.chat_id IS NOT NULL AND NEW.chat_id IS NULL
        BEGIN
          UPDATE persistent_workspaces
             SET state = 'archived',
                 updated_at = unixepoch()
           WHERE workspace_id = NEW.workspace_id;
        END`);
      db.run("DROP TRIGGER trg_persistent_workspace_detach_children_on_chat_delete");
      db.run(migration132Sql);
      seedPersistentRows(db);
      expect(db.query(
        "SELECT chat_id, revision, state FROM persistent_workspaces WHERE workspace_id = ?",
      ).get("detach-workspace")).toEqual({ chat_id: "detach-chat", revision: 0, state: "active" });
      db.query("DELETE FROM chats WHERE id = ?").run("detach-chat");

      for (const table of [
        "persistent_workspace_tasks",
        "persistent_workspace_records",
        "persistent_workspace_submissions",
        "persistent_workspace_artifacts",
        "persistent_workspace_publications",
      ]) {
        expect(db.query(`SELECT chat_id FROM ${table}`).all()).toEqual([{ chat_id: null }]);
      }
      expect(db.query(
        "SELECT chat_id, revision, state FROM persistent_workspaces WHERE workspace_id = ?",
      ).get("detach-workspace")).toEqual({ chat_id: null, revision: 1, state: "archived" });
      expect(db.query(
        "SELECT chat_id FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?",
      ).get("detach-session")).toEqual({ chat_id: null });
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

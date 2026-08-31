import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { createPreBundleDatabase } from "./test-helpers";
const importSql = await Bun.file(join(import.meta.dir, "115_user_data_import_integrity.sql")).text();
const workspaceSql = await Bun.file(join(import.meta.dir, "117_agent_turn_workspace.sql")).text();
const integritySql = await Bun.file(join(import.meta.dir, "121_archive_digest_constraints.sql")).text();

function createDatabase(): Database {
  const db = createPreBundleDatabase();
  db.run(importSql);
  db.run(workspaceSql);
  db.run(integritySql);
  db.run("PRAGMA foreign_keys = ON");
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)").run("u1", "Test", "u1@example.test");
  return db;
}

describe("111 archive digest constraints", () => {
  let db: Database;

  beforeEach(() => {
    db = createDatabase();
  });

  afterEach(() => {
    db.close();
  });

  test("rejects malformed archive and file-ledger digests", () => {
    const now = 1_700_000_000;
    const insertImport = db.query(
      `INSERT INTO user_data_imports
       (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
        staging_path,staging_db_path,state,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 'queued', ?, ?)`,
    );
    insertImport.run("job-1", "u1", "archive-1", "idem-1", "a".repeat(64), "/tmp/stage", "/tmp/stage.db", now, now);

    expect(() => db.query("UPDATE user_data_imports SET archive_digest = ? WHERE job_id = ?").run("A".repeat(64), "job-1")).toThrow();
    expect(() => db.query("UPDATE user_data_imports SET archive_digest = ? WHERE job_id = ?").run("a".repeat(63), "job-1")).toThrow();
    expect(() => db.query("UPDATE user_data_imports SET archive_digest = ? WHERE job_id = ?").run(`${"a".repeat(63)}z`, "job-1")).toThrow();

    expect(() => db.query(
      `INSERT INTO user_data_import_files
       (job_id,archive_path,kind,staged_path,final_path,sha256,byte_count,required,
        install_token,staged_identity,install_state,created_at,updated_at)
       VALUES (?, ?, 'file', ?, ?, ?, 1, 1, ?, '{}', 'pending', ?, ?)`,
    ).run("job-1", "files/audio/file.mp3", "/tmp/stage/file", "/tmp/final/file", "A".repeat(64), "token-1", now, now)).toThrow();
  });

  test("rejects malformed operational and canonical artifact digests", () => {
    const insertBlob = db.query(
      `INSERT INTO agent_artifact_blobs
       (digest,user_id,byte_count,mime_type,storage_path,expires_at)
       VALUES (?, ?, 1, 'text/plain', '/tmp/blob', 2000000000)`,
    );
    expect(() => insertBlob.run("A".repeat(64), "u1")).toThrow();
    expect(() => insertBlob.run(`${"a".repeat(63)}g`, "u1")).toThrow();
    db.query(
      `INSERT INTO agent_artifact_blobs
       (digest,user_id,byte_count,mime_type,storage_path,expires_at)
       VALUES (?, ?, 1, 'text/plain', '/tmp/blob', 2000000000)`,
    ).run("b".repeat(64), "u1");
    expect(() => db.query(
      `INSERT INTO agent_artifact_blob_journal
       (journal_id,blob_digest,user_id,turn_id,creator_token,fence_generation,
        staged_path,final_path,state,byte_count,digest)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'pending', 1, ?)`,
    ).run(
      "journal-1",
      "b".repeat(64),
      "u1",
      "turn-1",
      "creator-1",
      "/tmp/staged",
      "/tmp/final",
      "A".repeat(64),
    )).toThrow();
  });
});

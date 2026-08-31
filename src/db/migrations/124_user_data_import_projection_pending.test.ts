import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { createPreBundleDatabase } from "./test-helpers";
const importSql = await Bun.file(join(import.meta.dir, "115_user_data_import_integrity.sql")).text();
const projectionSql = await Bun.file(join(import.meta.dir, "124_user_data_import_projection_pending.sql")).text();

function createLegacyDatabase(): Database {
  const db = createPreBundleDatabase();
  db.run(importSql);
  db.run("PRAGMA foreign_keys = ON");
  db.query("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)")
    .run("u1", "Test", "u1@example.test");
  return db;
}

describe("114 user-data projection pending migration", () => {
  let db: Database;

  beforeEach(() => {
    db = createLegacyDatabase();
  });

  afterEach(() => {
    db.close();
  });

  test("is the next migration after the archive import control plane", () => {
    const names = readdirSync(import.meta.dir)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(names).toContain("123_image_public_provenance.sql");
    expect(names).toContain("124_user_data_import_projection_pending.sql");
    expect(names.indexOf("124_user_data_import_projection_pending.sql"))
      .toBeGreaterThan(names.indexOf("123_image_public_provenance.sql"));
  });

  test("backfills pending projection state from durable receipt summaries", () => {
    const now = 1_700_000_000;
    const summary = JSON.stringify({
      tables: {},
      files: {},
      secrets: { imported: 0, skipped: 0 },
      vectors: {
        imported: 0,
        skipped: 0,
        sourceRows: 501,
        sourceIdentities: {},
        vectorIdentities: {},
        rebuildRequired: true,
        projectionPending: true,
      },
    });
    db.query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,created_at,updated_at,summary_json)
       VALUES (?, ?, ?, ?, ?, '{}', '', '', 'committed', ?, ?, ?)`,
    ).run("job-1", "u1", "archive-1", "idem-1", "a".repeat(64), now, now, "{}");
    db.query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("receipt-1", "job-1", "u1", "idem-1", "a".repeat(64), summary, now);

    db.run(projectionSql);

    expect(db.query(
      "SELECT projection_pending FROM user_data_imports WHERE job_id = ?",
    ).get("job-1")).toEqual({ projection_pending: 1 });
  });

  test("defaults new jobs to settled and enforces the closed flag", () => {
    db.run(projectionSql);
    const now = 1_700_000_000;
    db.query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', '', '', 'queued', ?, ?)`,
    ).run("job-2", "u1", "archive-2", "idem-2", "b".repeat(64), now, now);

    expect(db.query(
      "SELECT projection_pending FROM user_data_imports WHERE job_id = ?",
    ).get("job-2")).toEqual({ projection_pending: 0 });
    expect(() => db.query(
      "UPDATE user_data_imports SET projection_pending = 2 WHERE job_id = ?",
    ).run("job-2")).toThrow();
  });
});

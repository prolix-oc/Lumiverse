import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const migrationPath = join(import.meta.dir, "migrations", "134_bounded_resync_and_portable_artifacts.sql");

describe("134 bounded resync and portable artifact migration", () => {
  test("deduplicates exact watermarks, backfills canonical paths, and installs guards", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`
        CREATE TABLE agent_run_resync_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          snapshot_sequence INTEGER NOT NULL,
          snapshot_at INTEGER NOT NULL,
          total_runs INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE agent_run_resync_snapshot_members (
          snapshot_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          turn_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          run_json TEXT NOT NULL
        );
        CREATE TABLE agent_published_workspace_artifacts (
          published_artifact_id TEXT PRIMARY KEY,
          blob_digest TEXT NOT NULL,
          storage_path TEXT NOT NULL
        );
        INSERT INTO agent_run_resync_snapshots VALUES
          ('older', 'owner', 'chat', 7, 1, 1, 999, 1),
          ('newer', 'owner', 'chat', 7, 1, 1, 999, 2);
        INSERT INTO agent_run_resync_snapshot_members VALUES
          ('older', 'owner', 0, 'turn-old', 1, '{}'),
          ('newer', 'owner', 0, 'turn-new', 2, '{}');
        INSERT INTO agent_published_workspace_artifacts VALUES
          ('publication', '${"a".repeat(64)}', '/private/host/artifact.blob');
      `);

      db.run(await Bun.file(migrationPath).text());

      expect(db.query(
        "SELECT snapshot_id, omitted_runs FROM agent_run_resync_snapshots",
      ).all()).toEqual([{ snapshot_id: "newer", omitted_runs: 0 }]);
      expect(db.query(
        "SELECT snapshot_id FROM agent_run_resync_snapshot_members",
      ).all()).toEqual([{ snapshot_id: "newer" }]);
      expect(db.query(
        "SELECT storage_path FROM agent_published_workspace_artifacts",
      ).get()).toEqual({ storage_path: `${"a".repeat(64)}.blob` });
      expect(() => db.query(
        `INSERT INTO agent_run_resync_snapshots
          (snapshot_id, user_id, chat_id, snapshot_sequence, snapshot_at, total_runs, expires_at, created_at)
         VALUES ('duplicate', 'owner', 'chat', 7, 1, 0, 999, 3)`,
      ).run()).toThrow();
      expect(() => db.query(
        "UPDATE agent_published_workspace_artifacts SET storage_path = '/private/leak'",
      ).run()).toThrow("published artifact storage_path must be portable and owner-relative");
    } finally {
      db.close();
    }
  });
});

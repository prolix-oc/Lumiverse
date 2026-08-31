import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const MIGRATION = "128_persistent_workspace_session_revision.sql";
const migrationSql = readFileSync(join(import.meta.dir, "migrations", MIGRATION), "utf8");
const temporaryRoots: string[] = [];

function makeMigrationDir(): string {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-migrate-118-test-"));
  temporaryRoots.push(root);
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  writeFileSync(join(migrationsDir, MIGRATION), migrationSql);
  return migrationsDir;
}

function revisionColumn(db: Database): Record<string, unknown> | null {
  return (db.query("PRAGMA table_info('persistent_workspace_turn_sessions')").all() as Array<Record<string, unknown>>)
    .find((column) => column.name === "revision") ?? null;
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.length = 0;
});

describe("118 persistent workspace session revision migration", () => {
  test("records the migration without reapplying it when fresh baseline already has revision", async () => {
    const db = new Database(":memory:");
    try {
      await runMigrations(db, makeMigrationDir());
      expect(revisionColumn(db)).toMatchObject({ name: "revision", type: "INTEGER", notnull: 1, dflt_value: "0" });
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION)).toEqual({ count: 1 });

      await runMigrations(db, makeMigrationDir());
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION)).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("adds revision to an existing 115 session table", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`
        CREATE TABLE _migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
      db.run("INSERT INTO _migrations (name) VALUES (?)", ["125_work_alpha1_workspace.sql"]);
      db.run(`
        CREATE TABLE persistent_workspace_turn_sessions (
          turn_session_id TEXT PRIMARY KEY,
          reason TEXT NOT NULL DEFAULT 'none'
        );
      `);

      await runMigrations(db, makeMigrationDir());
      expect(revisionColumn(db)).toMatchObject({ name: "revision", type: "INTEGER", notnull: 1, dflt_value: "0" });
      db.run("INSERT INTO persistent_workspace_turn_sessions (turn_session_id) VALUES (?)", ["legacy"]);
      expect(db.query("SELECT revision FROM persistent_workspace_turn_sessions WHERE turn_session_id = ?").get("legacy")).toEqual({
        revision: 0,
      });
      expect(() => db.run("UPDATE persistent_workspace_turn_sessions SET revision = -1 WHERE turn_session_id = ?", ["legacy"])).toThrow();
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION)).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });
});

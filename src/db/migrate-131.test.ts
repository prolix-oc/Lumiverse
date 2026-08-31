import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const MIGRATION = "131_persistent_workspace_session_detach.sql";
const migrationSql = readFileSync(join(import.meta.dir, "migrations", MIGRATION), "utf8");
const temporaryRoots: string[] = [];

function makeMigrationDir(): string {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-migrate-121-test-"));
  temporaryRoots.push(root);
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  writeFileSync(join(migrationsDir, MIGRATION), migrationSql);
  return migrationsDir;
}

function createParentTables(db: Database): void {
  db.run(`
    CREATE TABLE "user" (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE chats (
      id TEXT PRIMARY KEY
    );
    CREATE TABLE persistent_workspaces (
      workspace_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      UNIQUE(user_id, workspace_id)
    );
  `);
  db.run("INSERT INTO \"user\" (id) VALUES ('user-121')");
  db.run("INSERT INTO chats (id) VALUES ('chat-121')");
  db.run("INSERT INTO persistent_workspaces (workspace_id, user_id) VALUES ('workspace-121', 'user-121')");
}

function createLegacySessionTable(db: Database): void {
  db.run(`
    CREATE TABLE persistent_workspace_turn_sessions (
      turn_session_id TEXT PRIMARY KEY CHECK(length(turn_session_id) BETWEEN 1 AND 128),
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 128),
      attempt_id TEXT NOT NULL CHECK(length(attempt_id) BETWEEN 1 AND 128),
      execution_id TEXT CHECK(execution_id IS NULL OR length(execution_id) BETWEEN 1 AND 128),
      phase TEXT NOT NULL DEFAULT 'ADMIT' CHECK(phase IN ('ADMIT', 'ASSEMBLE', 'WORK', 'PREPARE_COMMIT', 'RENDER', 'COMMIT', 'TERMINAL')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'waiting', 'cancelling', 'terminal')),
      outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed', 'stopped', 'failed', 'exhausted', 'rejected')),
      reason TEXT NOT NULL DEFAULT 'none' CHECK(length(reason) <= 128),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      terminal_at INTEGER,
      UNIQUE(user_id, turn_id, attempt_id),
      UNIQUE(workspace_id, turn_id, attempt_id),
      FOREIGN KEY (workspace_id) REFERENCES persistent_workspaces(workspace_id) ON DELETE CASCADE,
      FOREIGN KEY (user_id, workspace_id) REFERENCES persistent_workspaces(user_id, workspace_id) ON DELETE CASCADE
    );
  `);
  db.run(`
    INSERT INTO persistent_workspace_turn_sessions (
      turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id,
      execution_id, phase, status, outcome, reason, revision, created_at,
      updated_at, terminal_at
    ) VALUES ('session-121', 'workspace-121', 'user-121', 'chat-121', 'turn-121',
      'attempt-121', 'execution-121', 'ADMIT', 'pending', NULL, 'none', 0, 1, 1, NULL)
  `);
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
  temporaryRoots.length = 0;
});

describe("121 persistent workspace session detach migration", () => {
  test("rebuilds an existing 120 session table with nullable chat detachment", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`
        CREATE TABLE _migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
      db.run("INSERT INTO _migrations (name) VALUES (?)", ["130_cognition_task_provenance.sql"]);
      createParentTables(db);
      createLegacySessionTable(db);

      await runMigrations(db, makeMigrationDir());

      const chatColumn = (db.query("PRAGMA table_info('persistent_workspace_turn_sessions')").all() as Array<Record<string, unknown>>)
        .find((column) => column.name === "chat_id");
      expect(chatColumn).toMatchObject({ name: "chat_id", notnull: 0 });
      const chatForeignKey = (db.query("PRAGMA foreign_key_list('persistent_workspace_turn_sessions')").all() as Array<Record<string, unknown>>)
        .find((foreignKey) => foreignKey.from === "chat_id");
      expect(chatForeignKey).toMatchObject({ table: "chats", on_delete: "SET NULL" });
      expect(db.query("SELECT turn_session_id, chat_id FROM persistent_workspace_turn_sessions").get()).toEqual({
        turn_session_id: "session-121",
        chat_id: "chat-121",
      });
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION)).toEqual({ count: 1 });
      expect((db.query("PRAGMA index_list('persistent_workspace_turn_sessions')").all() as Array<Record<string, unknown>>)
        .some((index) => index.name === "idx_persistent_workspace_sessions_turn")).toBe(true);
      expect(() => db.run(`
        INSERT INTO persistent_workspace_turn_sessions (
          turn_session_id, workspace_id, user_id, chat_id, turn_id, attempt_id
        ) VALUES ('duplicate-session-121', 'workspace-121', 'user-121', 'chat-121', 'turn-121', 'attempt-121')
      `)).toThrow();
    } finally {
      db.close();
    }
  });

  test("keeps the persistent turn session after deleting its chat", async () => {
    const db = new Database(":memory:");
    try {
      db.run(`
        CREATE TABLE _migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `);
      db.run("INSERT INTO _migrations (name) VALUES (?)", ["130_cognition_task_provenance.sql"]);
      createParentTables(db);
      createLegacySessionTable(db);

      await runMigrations(db, makeMigrationDir());
      db.run("DELETE FROM chats WHERE id = 'chat-121'");

      expect(db.query("SELECT turn_session_id, chat_id FROM persistent_workspace_turn_sessions").get()).toEqual({
        turn_session_id: "session-121",
        chat_id: null,
      });
    } finally {
      db.close();
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const MIGRATION = "129_agent_inspection_source_retention.sql";
const PREVIOUS_MIGRATION = "128_persistent_workspace_session_revision.sql";
const migrationSql = readFileSync(join(import.meta.dir, "migrations", MIGRATION), "utf8");
const previousMigrationSql = readFileSync(join(import.meta.dir, "migrations", PREVIOUS_MIGRATION), "utf8");
const temporaryRoots: string[] = [];

const SOURCE_TABLE = "agent_run_source_deletions";
const WORKSPACE_TABLE = "agent_run_source_deletion_workspace";
const SOURCE_INDEXES = [
  "idx_agent_run_source_deletions_chat",
  "idx_agent_run_source_deletions_attempt",
];
const WORKSPACE_INDEX = "idx_agent_run_source_deletion_workspace_attempt";

const SOURCE_COLUMNS = [
  ["user_id", "TEXT", 1, 1],
  ["attempt_id", "TEXT", 1, 2],
  ["previous_attempt_id", "TEXT", 0, 0],
  ["chat_id", "TEXT", 1, 0],
  ["source_kind", "TEXT", 1, 0],
  ["target_message_id", "TEXT", 0, 0],
  ["target_swipe_id", "INTEGER", 0, 0],
  ["run_id", "TEXT", 0, 0],
  ["turn_id", "TEXT", 0, 0],
  ["generation_id", "TEXT", 0, 0],
  ["generation_type", "TEXT", 0, 0],
  ["lifecycle", "TEXT", 0, 0],
  ["status", "TEXT", 0, 0],
  ["outcome", "TEXT", 0, 0],
  ["terminal", "INTEGER", 0, 0],
  ["attempt_reason", "TEXT", 0, 0],
  ["started_at", "INTEGER", 0, 0],
  ["updated_at", "INTEGER", 0, 0],
  ["terminal_at", "INTEGER", 0, 0],
  ["host_correlation_id", "TEXT", 0, 0],
  ["reconciliation_state", "TEXT", 0, 0],
  ["attempt_version", "INTEGER", 0, 0],
  ["created_at", "INTEGER", 1, 0],
  ["source_deleted_at", "INTEGER", 1, 0],
  ["reason", "TEXT", 1, 0],
  ["activity_json", "TEXT", 1, 0],
  ["usage_json", "TEXT", 1, 0],
] as const;

const WORKSPACE_COLUMNS = [
  ["user_id", "TEXT", 1, 1],
  ["attempt_id", "TEXT", 1, 2],
  ["association_id", "TEXT", 1, 3],
  ["workspace_id", "TEXT", 1, 0],
  ["workspace_revision", "INTEGER", 1, 0],
  ["relation", "TEXT", 1, 0],
  ["object_kind", "TEXT", 1, 0],
  ["object_id", "TEXT", 0, 0],
  ["source_revision", "INTEGER", 0, 0],
  ["source_deleted", "INTEGER", 1, 0],
  ["provenance_digest", "TEXT", 0, 0],
  ["host_sequence", "INTEGER", 1, 0],
] as const;

const SOURCE_INSERT_COLUMNS = [
  "user_id",
  "attempt_id",
  "previous_attempt_id",
  "chat_id",
  "source_kind",
  "target_message_id",
  "target_swipe_id",
  "run_id",
  "turn_id",
  "generation_id",
  "generation_type",
  "lifecycle",
  "status",
  "outcome",
  "terminal",
  "attempt_reason",
  "started_at",
  "updated_at",
  "terminal_at",
  "host_correlation_id",
  "reconciliation_state",
  "attempt_version",
  "created_at",
  "source_deleted_at",
  "reason",
  "activity_json",
  "usage_json",
] as const;

const MAX_ACTIVITY_JSON = jsonAtLimit(65536);
const MAX_USAGE_JSON = jsonAtLimit(4096);
const MAX_ID = "i".repeat(256);

function jsonAtLimit(limit: number): string {
  const empty = JSON.stringify({ value: "" });
  return JSON.stringify({ value: "x".repeat(limit - empty.length) });
}

function makeMigrationDir(includePrevious = false): string {
  const root = mkdtempSync(join(tmpdir(), "lumiverse-migrate-119-test-"));
  temporaryRoots.push(root);
  const migrationsDir = join(root, "migrations");
  mkdirSync(migrationsDir);
  if (includePrevious) writeFileSync(join(migrationsDir, PREVIOUS_MIGRATION), previousMigrationSql);
  writeFileSync(join(migrationsDir, MIGRATION), migrationSql);
  return migrationsDir;
}

function makePre119Database(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE "user" (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE
    );
    CREATE TABLE agent_run_attempts (
      user_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      PRIMARY KEY(user_id, attempt_id)
    );
    CREATE TABLE _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  db.run("INSERT INTO \"user\" (id, name, email) VALUES (?, ?, ?)", ["user-1", "Test User", "user-1@example.test"]);
  db.run("INSERT INTO _migrations (name) VALUES (?)", [PREVIOUS_MIGRATION]);
  return db;
}

function tableInfo(db: Database, table: string): Array<Record<string, unknown>> {
  return db.query(`PRAGMA table_info('${table}')`).all() as Array<Record<string, unknown>>;
}

function sqlBinding(value: unknown): SQLQueryBindings {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean" || value instanceof Uint8Array) {
    return value;
  }
  throw new Error("unexpected non-SQL test fixture value");
}

function assertColumns(db: Database, table: string, expected: readonly (readonly [string, string, number, number])[]): void {
  expect(
    tableInfo(db, table).map((column) => [column.name, column.type, column.notnull, column.pk]),
  ).toEqual(expected.map(([name, type, notnull, pk]) => [name, type, notnull, pk]));
}

function tableSql(db: Database, table: string): string {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || typeof row !== "object" || !("sql" in row) || typeof row.sql !== "string") {
    throw new Error(`missing SQLite schema SQL for ${table}`);
  }
  return row.sql;
}

function triggerSql(db: Database, trigger: string): string {
  const row = db.query("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger);
  if (!row || typeof row !== "object" || !("sql" in row) || typeof row.sql !== "string") {
    throw new Error(`missing SQLite trigger SQL for ${trigger}`);
  }
  return row.sql;
}

function indexColumns(db: Database, index: string): string[] {
  return (db.query(`PRAGMA index_info('${index}')`).all() as Array<{ seq: number; name: string }>)
    .sort((left, right) => left.seq - right.seq)
    .map((column) => column.name);
}

function assertIndexes(db: Database): void {
  const sourceIndexes = (db.query(`PRAGMA index_list('${SOURCE_TABLE}')`).all() as Array<{ name: string }>)
    .map((index) => index.name)
    .filter((name) => !name.startsWith("sqlite_autoindex"))
    .sort();
  expect(sourceIndexes).toEqual([...SOURCE_INDEXES].sort());
  expect(indexColumns(db, "idx_agent_run_source_deletions_chat")).toEqual([
    "user_id",
    "chat_id",
    "source_kind",
    "target_message_id",
    "target_swipe_id",
  ]);
  expect(indexColumns(db, "idx_agent_run_source_deletions_attempt")).toEqual(["user_id", "attempt_id"]);

  const workspaceIndexes = (db.query(`PRAGMA index_list('${WORKSPACE_TABLE}')`).all() as Array<{ name: string }>)
    .map((index) => index.name)
    .filter((name) => !name.startsWith("sqlite_autoindex"));
  expect(workspaceIndexes).toEqual([WORKSPACE_INDEX]);
  expect(indexColumns(db, WORKSPACE_INDEX)).toEqual([
    "user_id",
    "attempt_id",
    "host_sequence",
    "association_id",
  ]);
}

function assertForeignKeys(db: Database): void {
  for (const table of [SOURCE_TABLE, WORKSPACE_TABLE]) {
    expect(db.query(`PRAGMA foreign_key_list('${table}')`).all()).toEqual([
      expect.objectContaining({ table: "user", from: "user_id", to: "id", on_delete: "CASCADE" }),
    ]);
  }
}

function assertNoPrivateColumns(db: Database): void {
  for (const table of [SOURCE_TABLE, WORKSPACE_TABLE]) {
    const names = tableInfo(db, table).map((column) => String(column.name));
    expect(names.filter((name) => /prompt|transcript|tool|receipt|content/i.test(name))).toEqual([]);
    expect(names.filter((name) => name.endsWith("_json"))).toEqual(
      table === SOURCE_TABLE ? ["activity_json", "usage_json"] : [],
    );
  }
}

function assertSchema(db: Database): void {
  assertColumns(db, SOURCE_TABLE, SOURCE_COLUMNS);
  assertColumns(db, WORKSPACE_TABLE, WORKSPACE_COLUMNS);
  assertIndexes(db);
  assertForeignKeys(db);
  assertNoPrivateColumns(db);

  const sourceSql = tableSql(db, SOURCE_TABLE);
  expect(sourceSql).toContain("CHECK(length(activity_json) <= 65536 AND json_valid(activity_json))");
  expect(sourceSql).toContain("CHECK(length(usage_json) <= 4096 AND json_valid(usage_json))");
  expect(sourceSql).toContain("CHECK(reason = 'source_deleted')");
  expect(sourceSql).toContain("CHECK(target_swipe_id IS NULL OR target_message_id IS NOT NULL)");
  expect(sourceSql).toContain("CHECK(source_kind = 'chat' OR target_message_id IS NOT NULL)");

  const triggerSqlText = triggerSql(db, "trg_agent_run_attempts_reject_source_deleted");
  expect(triggerSqlText).toContain("BEFORE INSERT ON agent_run_attempts");
  expect(triggerSqlText).toContain("NEW.user_id");
  expect(triggerSqlText).toContain("NEW.attempt_id");
  expect(sourceSql).toContain("CHECK(source_kind <> 'swipe' OR target_swipe_id IS NOT NULL)");

  const workspaceSql = tableSql(db, WORKSPACE_TABLE);
  expect(workspaceSql).toContain("CHECK(provenance_digest IS NULL OR length(provenance_digest) = 64)");
  expect(workspaceSql).toContain("PRIMARY KEY(user_id, attempt_id, association_id)");
}

function deletionValues(attemptId = "attempt-valid"): Record<string, unknown> {
  return {
    user_id: "user-1",
    attempt_id: attemptId,
    previous_attempt_id: null,
    chat_id: "chat-1",
    source_kind: "message",
    target_message_id: "message-1",
    target_swipe_id: null,
    run_id: "run-1",
    turn_id: "turn-1",
    generation_id: "generation-1",
    generation_type: "normal",
    lifecycle: "TERMINAL",
    status: "terminal",
    outcome: "completed",
    terminal: 1,
    attempt_reason: "source cleanup",
    started_at: 1,
    updated_at: 2,
    terminal_at: 3,
    host_correlation_id: "host-1",
    reconciliation_state: "authoritative",
    attempt_version: 1,
    created_at: 4,
    source_deleted_at: 5,
    reason: "source_deleted",
    activity_json: MAX_ACTIVITY_JSON,
    usage_json: MAX_USAGE_JSON,
  };
}

function insertDeletion(db: Database, overrides: Record<string, unknown> = {}): void {
  const values = { ...deletionValues(), ...overrides };
  const placeholders = SOURCE_INSERT_COLUMNS.map(() => "?").join(", ");
  db.run(
    `INSERT INTO ${SOURCE_TABLE} (${SOURCE_INSERT_COLUMNS.join(", ")}) VALUES (${placeholders})`,
    SOURCE_INSERT_COLUMNS.map((column) => sqlBinding(values[column])),
  );
}

function workspaceValues(): Record<string, unknown> {
  return {
    user_id: "user-1",
    attempt_id: MAX_ID,
    association_id: MAX_ID,
    workspace_id: MAX_ID,
    workspace_revision: 0,
    relation: "published",
    object_kind: "publication",
    object_id: MAX_ID,
    source_revision: 0,
    source_deleted: 1,
    provenance_digest: "a".repeat(64),
    host_sequence: 0,
  };
}

function insertWorkspace(db: Database, overrides: Record<string, unknown> = {}): void {
  const values = { ...workspaceValues(), ...overrides };
  db.run(
    `INSERT INTO ${WORKSPACE_TABLE} (
      user_id, attempt_id, association_id, workspace_id, workspace_revision,
      relation, object_kind, object_id, source_revision, source_deleted,
      provenance_digest, host_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      values.user_id,
      values.attempt_id,
      values.association_id,
      values.workspace_id,
      values.workspace_revision,
      values.relation,
      values.object_kind,
      values.object_id,
      values.source_revision,
      values.source_deleted,
      values.provenance_digest,
      values.host_sequence,
    ].map(sqlBinding),
  );
}

describe("119 agent inspection source retention migration", () => {
  test("upgrades the pre-119 schema with exact bounded tombstone and workspace association contracts", async () => {
    const db = makePre119Database();
    try {
      await runMigrations(db, makeMigrationDir());
      assertSchema(db);
      expect(db.query("SELECT name FROM _migrations ORDER BY id").all()).toEqual([
        { name: PREVIOUS_MIGRATION },
        { name: MIGRATION },
      ]);

      insertDeletion(db);
      expect(db.query(`SELECT length(activity_json) AS activity, length(usage_json) AS usage, json_valid(activity_json) AS activity_valid, json_valid(usage_json) AS usage_valid FROM ${SOURCE_TABLE}`).get()).toEqual({
        activity: 65536,
        usage: 4096,
        activity_valid: 1,
        usage_valid: 1,
      });
      insertWorkspace(db);
      expect(db.query(`SELECT length(association_id) AS association, length(workspace_id) AS workspace, length(object_id) AS object, length(provenance_digest) AS digest FROM ${WORKSPACE_TABLE}`).get()).toEqual({
        association: 256,
        workspace: 256,
        object: 256,
        digest: 64,
      });

      expect(() => insertDeletion(db, { attempt_id: "too-long-activity", activity_json: `${MAX_ACTIVITY_JSON} ` })).toThrow();
      expect(() => insertDeletion(db, { attempt_id: "too-long-usage", usage_json: `${MAX_USAGE_JSON} ` })).toThrow();
      expect(() => insertDeletion(db, { attempt_id: "invalid-json", activity_json: "not-json" })).toThrow();

      for (const [column, value] of [
        ["source_kind", "invalid"],
        ["generation_type", "invalid"],
        ["lifecycle", "INVALID"],
        ["status", "invalid"],
        ["outcome", "invalid"],
        ["reconciliation_state", "invalid"],
      ] as const) {
        expect(() => insertDeletion(db, { attempt_id: `invalid-${column}`, [column]: value })).toThrow();
      }
      expect(() => insertWorkspace(db, { association_id: "invalid-relation", relation: "invalid" })).toThrow();
      expect(() => insertWorkspace(db, { association_id: "invalid-object-kind", object_kind: "invalid" })).toThrow();

      for (const [column, value] of [
        ["attempt_id", ""],
        ["attempt_id", "x".repeat(257)],
        ["previous_attempt_id", ""],
        ["chat_id", ""],
        ["target_message_id", ""],
        ["run_id", ""],
        ["turn_id", ""],
        ["generation_id", ""],
        ["host_correlation_id", ""],
        ["target_swipe_id", -1],
        ["terminal", 2],
        ["attempt_reason", "r".repeat(129)],
        ["started_at", -1],
        ["updated_at", -1],
        ["terminal_at", -1],
        ["attempt_version", 0],
        ["created_at", -1],
        ["source_deleted_at", -1],
        ["reason", "retained"],
      ] as const) {
        expect(() => insertDeletion(db, { attempt_id: `invalid-check-${column}`, [column]: value })).toThrow();
      }

      for (const [column, value] of [
        ["attempt_id", ""],
        ["association_id", ""],
        ["workspace_id", ""],
        ["workspace_revision", -1],
        ["object_id", ""],
        ["source_revision", -1],
        ["source_deleted", 2],
        ["provenance_digest", "a".repeat(63)],
        ["host_sequence", -1],
      ] as const) {
        expect(() => insertWorkspace(db, { association_id: `invalid-check-${column}`, [column]: value })).toThrow();
      }


      expect(() => insertDeletion(db, { attempt_id: "invalid-target-message", source_kind: "message", target_message_id: null })).toThrow();
      expect(() => insertDeletion(db, { attempt_id: "invalid-target-swipe", source_kind: "swipe", target_message_id: "message-2", target_swipe_id: null })).toThrow();
      expect(() => insertDeletion(db, { attempt_id: "invalid-target-pair", source_kind: "chat", target_message_id: null, target_swipe_id: 0 })).toThrow();
      expect(() => db.run(
        `INSERT INTO ${SOURCE_TABLE} (user_id, attempt_id, source_kind, created_at, source_deleted_at, reason, activity_json, usage_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["user-1", "missing-chat", "chat", 1, 2, "source_deleted", "[]", "{}"],
      )).toThrow();
      expect(() => db.run(
        `INSERT INTO ${WORKSPACE_TABLE} (user_id, attempt_id, workspace_id, workspace_revision, relation, object_kind, source_deleted, host_sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["user-1", "missing-association", "workspace", 0, "linked", "task", 0, 0],
      )).toThrow();
    } finally {
      db.close();
    }
  });

  test("records a fresh baseline's already-converged schema once and remains idempotent", async () => {
    const db = new Database(":memory:");
    try {
      const migrationsDir = makeMigrationDir(true);
      await runMigrations(db, migrationsDir);
      assertSchema(db);
      expect(db.query("SELECT name FROM _migrations WHERE name IN (?, ?) ORDER BY id").all(PREVIOUS_MIGRATION, MIGRATION)).toEqual([
        { name: PREVIOUS_MIGRATION },
        { name: MIGRATION },
      ]);
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION)).toEqual({ count: 1 });

      await runMigrations(db, makeMigrationDir(true));
      expect(db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION)).toEqual({ count: 1 });
      expect(db.query(`SELECT COUNT(*) AS count FROM ${SOURCE_TABLE}`).get()).toEqual({ count: 0 });
      expect(db.query(`SELECT COUNT(*) AS count FROM ${WORKSPACE_TABLE}`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

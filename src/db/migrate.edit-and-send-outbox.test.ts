import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "./migrate";

const MIGRATION_103 = "103_edit_and_send_outbox.sql";
const MIGRATION_103_SQL = `-- Edit-and-send: message OCC revision, durable request log, generation outbox.
-- Post-baseline. The runner records this filename in _migrations so it runs once.

ALTER TABLE messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS edit_and_send_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  branch_chat_id TEXT NOT NULL,
  edited_message_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_index INTEGER,
  generation_id TEXT NOT NULL,
  response TEXT NOT NULL,
  cursor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, chat_id, request_id)
);

CREATE TABLE IF NOT EXISTS generation_outbox (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  branch_chat_id TEXT NOT NULL,
  edited_message_id TEXT NOT NULL,
  target_message_id TEXT,
  target_swipe_index INTEGER,
  expected_version INTEGER NOT NULL,
  generation_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('normal', 'swipe')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'cancelled')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_error_code TEXT,
  terminal_reason TEXT,
  dispatched_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_generation_outbox_status_next
  ON generation_outbox(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_generation_outbox_request
  ON generation_outbox(user_id, chat_id, request_id);
`;

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type IndexInfo = {
  name: string;
  unique: number;
};

let temporaryMigrationDirs: string[] = [];

function makeMigrationDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "lumiverse-migrate-103-test-"));
  temporaryMigrationDirs.push(directory);
  return directory;
}

function installMigration(directory: string): void {
  writeFileSync(join(directory, MIGRATION_103), MIGRATION_103_SQL);
}

function columnSnapshot(db: Database, table: string): ColumnInfo[] {
  return (db.query(`PRAGMA table_info('${table}')`).all() as ColumnInfo[])
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function indexSnapshot(db: Database, table: string): Array<Pick<IndexInfo, "name" | "unique">> {
  return (db.query(`PRAGMA index_list('${table}')`).all() as IndexInfo[])
    .map(({ name, unique }) => ({ name, unique }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function revisionColumn(db: Database): ColumnInfo | null {
  const column = (db.query("PRAGMA table_info('messages')").all() as ColumnInfo[])
    .find((candidate) => candidate.name === "revision");
  return column
    ? {
        name: column.name,
        type: column.type,
        notnull: column.notnull,
        dflt_value: column.dflt_value,
        pk: column.pk,
      }
    : null;
}

function editAndSendSchema(db: Database) {
  return {
    revision: revisionColumn(db),
    requests: columnSnapshot(db, "edit_and_send_requests"),
    requestsIndexes: indexSnapshot(db, "edit_and_send_requests"),
    outbox: columnSnapshot(db, "generation_outbox"),
    outboxIndexes: indexSnapshot(db, "generation_outbox"),
  };
}

function createPre103MessagesDb(db: Database): void {
  db.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    index_in_chat INTEGER NOT NULL,
    is_user INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    send_date INTEGER NOT NULL,
    swipe_id INTEGER NOT NULL DEFAULT 0,
    swipes TEXT NOT NULL DEFAULT '[]',
    swipe_dates TEXT NOT NULL DEFAULT '[]',
    extra TEXT NOT NULL DEFAULT '{}',
    parent_message_id TEXT,
    branch_id TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.run(`INSERT INTO messages (
    id, chat_id, index_in_chat, is_user, name, content, send_date, swipe_id,
    swipes, swipe_dates, extra, parent_message_id, branch_id, created_at
  ) VALUES (
    'm1', 'c1', 0, 1, 'User', 'hello', 1, 0, '["hello"]', '[1]', '{}', NULL, NULL, 1
  )`);
}

afterEach(() => {
  for (const directory of temporaryMigrationDirs) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryMigrationDirs = [];
});

describe("103 edit and send outbox migration", () => {
  test("keeps the canonical migration identity and body", async () => {
    expect(MIGRATION_103).toBe("103_edit_and_send_outbox.sql");
    const sql = await Bun.file(join(import.meta.dir, "migrations", MIGRATION_103)).text();
    expect(sql.replaceAll("\r\n", "\n")).toBe(MIGRATION_103_SQL);
  });

  test("migrates fresh and pre-103 databases to the same edit and send schema", async () => {
    const fresh = new Database(":memory:");
    const pre = new Database(":memory:");
    try {
      await runMigrations(fresh);

      pre.run(`
        CREATE TABLE _migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      createPre103MessagesDb(pre);
      pre.run(MIGRATION_103_SQL);

      const freshSchema = editAndSendSchema(fresh);
      const preSchema = editAndSendSchema(pre);
      expect(freshSchema).toEqual(preSchema);
      expect(freshSchema.revision).toEqual({
        name: "revision",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "1",
        pk: 0,
      });
      expect(freshSchema.requests.map((column) => column.name)).toEqual([
        "branch_chat_id",
        "chat_id",
        "created_at",
        "cursor",
        "edited_message_id",
        "generation_id",
        "id",
        "request_fingerprint",
        "request_id",
        "response",
        "target_message_id",
        "target_swipe_index",
        "updated_at",
        "user_id",
      ]);
      expect(freshSchema.outbox.map((column) => column.name)).toEqual([
        "attempt_count",
        "branch_chat_id",
        "cancelled_at",
        "chat_id",
        "completed_at",
        "created_at",
        "dispatched_at",
        "edited_message_id",
        "expected_version",
        "generation_id",
        "id",
        "last_error_code",
        "lease_expires_at",
        "lease_owner",
        "mode",
        "next_attempt_at",
        "request_id",
        "status",
        "target_message_id",
        "target_swipe_index",
        "terminal_reason",
        "updated_at",
        "user_id",
      ]);
      expect(pre.query("SELECT revision FROM messages WHERE id = 'm1'").get()).toEqual({
        revision: 1,
      });
    } finally {
      fresh.close();
      pre.close();
    }
  });

  test("reruns 103 without schema or data drift", async () => {
    const db = new Database(":memory:");
    const migrationsDir = makeMigrationDir();
    try {
      db.run(`
        CREATE TABLE _migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `);
      // Non-zero _migrations skips baseline bootstrap so this test can apply
      // 103 onto a pre-103 messages table in isolation.
      db.run("INSERT INTO _migrations (name) VALUES ('000_pre103_fixture.sql')");
      createPre103MessagesDb(db);
      installMigration(migrationsDir);
      await runMigrations(db, migrationsDir);

      db.run(`INSERT INTO edit_and_send_requests (
        id, user_id, chat_id, request_id, request_fingerprint, branch_chat_id,
        edited_message_id, generation_id, response, cursor, created_at, updated_at
      ) VALUES (
        'req-1', 'u1', 'c1', 'client-1', 'fp', 'b1', 'm1', 'g1', '{}', '{}', 1, 1
      )`);
      db.run(`INSERT INTO generation_outbox (
        id, request_id, user_id, chat_id, branch_chat_id, edited_message_id,
        expected_version, generation_id, mode, status, created_at, updated_at
      ) VALUES (
        'out-1', 'client-1', 'u1', 'c1', 'b1', 'm1', 1, 'g1', 'normal', 'pending', 1, 1
      )`);

      const before = editAndSendSchema(db);
      await runMigrations(db, migrationsDir);
      expect(editAndSendSchema(db)).toEqual(before);
      expect(
        db.query("SELECT COUNT(*) AS count FROM _migrations WHERE name = ?").get(MIGRATION_103),
      ).toEqual({ count: 1 });
      expect(
        db.query("SELECT request_id, generation_id FROM edit_and_send_requests WHERE id = 'req-1'").get(),
      ).toEqual({ request_id: "client-1", generation_id: "g1" });
      expect(
        db.query("SELECT status, generation_id FROM generation_outbox WHERE id = 'out-1'").get(),
      ).toEqual({ status: "pending", generation_id: "g1" });
    } finally {
      db.close();
    }
  });

  test("matches baseline schema", async () => {
    const db = new Database(":memory:");
    try {
      await runMigrations(db);
      const expected = {
        revision: {
          name: "revision",
          type: "INTEGER",
          notnull: 1,
          dflt_value: "1",
          pk: 0,
        },
        requestColumns: [
          "branch_chat_id",
          "chat_id",
          "created_at",
          "cursor",
          "edited_message_id",
          "generation_id",
          "id",
          "request_fingerprint",
          "request_id",
          "response",
          "target_message_id",
          "target_swipe_index",
          "updated_at",
          "user_id",
        ],
        outboxColumns: [
          "attempt_count",
          "branch_chat_id",
          "cancelled_at",
          "chat_id",
          "completed_at",
          "created_at",
          "dispatched_at",
          "edited_message_id",
          "expected_version",
          "generation_id",
          "id",
          "last_error_code",
          "lease_expires_at",
          "lease_owner",
          "mode",
          "next_attempt_at",
          "request_id",
          "status",
          "target_message_id",
          "target_swipe_index",
          "terminal_reason",
          "updated_at",
          "user_id",
        ],
      };

      const schema = editAndSendSchema(db);
      expect(schema.revision).toEqual(expected.revision);
      expect(schema.requests.map((column) => column.name)).toEqual(expected.requestColumns);
      expect(schema.outbox.map((column) => column.name)).toEqual(expected.outboxColumns);

      const baseline = await Bun.file(join(import.meta.dir, "baseline.sql")).text();
      // 103 is post-baseline. Duplicating it into baseline.sql is forbidden
      // by the lane contract, so this assertion compares migrated schema to
      // the 103 DDL rather than to baseline.sql.
      expect(baseline.includes("edit_and_send_requests")).toBe(false);
      expect(baseline.includes("generation_outbox")).toBe(false);
      expect(
        db.query("SELECT name FROM _migrations WHERE name = ?").get(MIGRATION_103),
      ).toEqual({ name: MIGRATION_103 });
    } finally {
      db.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { buildExportStream } from "./export.service";

const USER_ID = "export-locks-user";
let directory: string;
let path: string;

beforeEach(async () => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lumiverse-export-locks-"));
  path = join(directory, "export.db");
  const db = initDatabase(path);
  db.exec(await Bun.file(join(import.meta.dir, "../../db/baseline.sql")).text());
  db.query('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)')
    .run(USER_ID, "Export test", "export-locks@example.com");
  db.query("INSERT INTO chats (id, user_id) VALUES ('chat', ?)").run(USER_ID);
  db.query("INSERT INTO world_books (id, name, user_id) VALUES ('book', 'Book', ?)").run(USER_ID);
  db.exec("CREATE TABLE lock_probe (value INTEGER); INSERT INTO lock_probe VALUES (0)");
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

describe("export cursor cleanup", () => {
  for (const table of ["characters", "messages", "world_book_entries"] as const) {
    test(`aborting ${table} export releases its read lock`, async () => {
      const db = getDb();
      const statement = table === "characters"
        ? db.prepare("INSERT INTO characters (id, user_id, name) VALUES (?, ?, 'Character')")
        : table === "messages"
          ? db.prepare("INSERT INTO messages (id, chat_id, index_in_chat, is_user, content, created_at) VALUES (?, 'chat', ?, 0, 'Message', 0)")
          : db.prepare("INSERT INTO world_book_entries (id, world_book_id, uid) VALUES (?, 'book', ?)");
      try {
        db.transaction(() => {
          // More than one yield interval: cancellation interrupts an active
          // iterator before SQLite reaches the end of the result set.
          for (let i = 0; i < 2050; i++) {
            statement.run(`row-${i}`, table === "characters" ? USER_ID : i);
          }
        })();
      } finally {
        statement.finalize();
      }

      const controller = new AbortController();
      const stop = new Error(`Cancel ${table} export`);
      const unsubscribe = eventBus.on(EventType.USER_EXPORT_PROGRESS, (event) => {
        if (event.payload.phase === "table_start" && event.payload.table === table) controller.abort(stop);
      });
      const reader = buildExportStream({ userId: USER_ID, includeVectors: false, signal: controller.signal }).getReader();
      try {
        await expect((async () => {
          while (!(await reader.read()).done) { /* drain the archive */ }
        })()).rejects.toThrow(stop.message);
      } finally {
        unsubscribe();
        reader.releaseLock();
      }
      expect(controller.signal.aborted).toBe(true);

      const writer = new Database(path);
      try {
        writer.exec("PRAGMA busy_timeout = 0; UPDATE lock_probe SET value = value + 1");
        // A surviving cursor would pin the old WAL snapshot and return busy=1.
        expect(writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
      } finally {
        writer.close(true);
      }
      // An active statement on this connection also prevents VACUUM outright.
      expect(() => db.exec("VACUUM")).not.toThrow();
    });
  }
});

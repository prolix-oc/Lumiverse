import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "./connection";
import { bunCmd } from "../utils/bun-cmd";

let directory: string;
beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lumiverse-connection-"));
});
afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

describe("managed SQLite connections", () => {
  test("legacy synchronous writes survive a subprocess lock lasting longer than 100 ms", async () => {
    const path = join(directory, "contended.db");
    const signalFile = path + ".locked";
    const db = initDatabase(path);
    db.exec("CREATE TABLE probe (value INTEGER); INSERT INTO probe VALUES (0)");
    const writer = Bun.spawn({
      cmd: bunCmd(join(import.meta.dir, "test-fixtures/connection-lock-holder.ts"), path, signalFile),
      stdout: "inherit",
      stderr: "inherit",
    });
    try {
      // Wait for file-based signal (avoid Windows stdio binary framing bugs).
      // Integration test requires real wait for external subprocess file write.
      // See builtin-defaults:ts-no-test-timers for exception rationale.
      let locked = false;
      for (let i = 0; i < 50; i++) {
        await Bun.sleep(20);
        try {
          const data = readFileSync(signalFile, "utf8");
          if (data.includes("locked")) { locked = true; break; }
        } catch { /* file not yet created */ }
      }
      expect(locked).toBe(true);
      db.query("UPDATE probe SET value = value + 1").run();
      expect(await writer.exited).toBe(0);
      expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 2 });
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    } finally {
      writer.kill();
      await writer.exited;
      try { unlinkSync(signalFile); } catch { /* ignore */ }
    }
  });

  test("rejects async transaction callbacks before invoking them", () => {
    const db = initDatabase(":memory:");
    let invoked = false;
    expect(() => db.transaction(async () => { invoked = true; })).toThrow("must be synchronous");
    expect(invoked).toBe(false);
  });

  test("rolls back a transaction that returns a promise", () => {
    const db = initDatabase(":memory:");
    db.exec("CREATE TABLE probe (value INTEGER)");
    expect(() => db.transaction(() => {
      db.run("INSERT INTO probe VALUES (1)");
      return Promise.resolve(1);
    }).immediate()).toThrow("must not return promises");
    expect(db.query("SELECT COUNT(*) AS count FROM probe").get()).toEqual({ count: 0 });
    expect(db.inTransaction).toBe(false);
  });

  test("finalizes an abandoned cursor when closing", () => {
    const path = join(directory, "cursor.db");
    const db = initDatabase(path);
    db.exec("CREATE TABLE probe (value INTEGER); INSERT INTO probe VALUES (1), (2)");
    const statement = db.prepare("SELECT * FROM probe");
    const cursor = statement.iterate();
    cursor.next();
    const other = new Database(path);
    try {
      other.exec("PRAGMA busy_timeout = 0; UPDATE probe SET value = value + 1");
      expect((other.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as any).busy).toBe(1);
      closeDatabase();
      expect((other.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as any).busy).toBe(0);
    } finally { other.close(true); }
  });

  test("a failed open does not publish a partially initialized connection", () => {
    const path = join(directory, "locked.db");
    const blocker = new Database(path);
    blocker.exec("CREATE TABLE probe (value INTEGER); BEGIN EXCLUSIVE");
    try {
      expect(() => initDatabase(path, { busyTimeoutMs: 20 })).toThrow();
      expect(() => getDb()).toThrow("not initialized");
      blocker.exec("ROLLBACK");
      expect(initDatabase(path).query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    } finally {
      if (blocker.inTransaction) blocker.exec("ROLLBACK");
      blocker.close(true);
    }
  });
});

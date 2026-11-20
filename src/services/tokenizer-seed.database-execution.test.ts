import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { DatabaseExecutor, executeDatabaseOperation, startDatabaseExecution, stopDatabaseExecution } from "../db/execution";
import { seedTokenizers, seedTokenizersAsync } from "./tokenizer-seed";

let directory: string;
let path: string;
let db: Database;
const longRead = { kind: "read" as const, statement: {
  sql: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 1000000000) SELECT sum(x) FROM n",
  mode: "get" as const,
} };

beforeEach(async () => {
  await stopDatabaseExecution(); closeDatabase();
  directory = mkdtempSync(join(tmpdir(), "lumiverse-tokenizer-startup-"));
  path = join(directory, "database.db");
  db = initDatabase(path, { busyTimeoutMs: 100, allowMmap: false });
  db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
});
afterEach(async () => {
  await stopDatabaseExecution(); closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

function snapshot() {
  return {
    configs: db.query("SELECT id, name, type, config, is_built_in FROM tokenizer_configs ORDER BY id").all(),
    patterns: db.query("SELECT id, tokenizer_id, pattern, priority, is_built_in FROM tokenizer_model_patterns ORDER BY id").all(),
  };
}
function pendingSources(): number {
  return (db.query("SELECT COUNT(*) AS count FROM image_reference_index_state WHERE completed = 0").get() as { count: number }).count;
}
async function waitForBackfill(): Promise<void> {
  const deadline = Date.now() + 5000;
  while (pendingSources() > 0 && Date.now() < deadline) await Bun.sleep(10);
  expect(pendingSources()).toBe(0);
}

describe("tokenizer startup with supervised SQLite", () => {
  test("file-backed async seeding runs no SQL on the backend connection", async () => {
    const spies = (["prepare", "query", "run", "exec"] as const).map(method =>
      spyOn(db, method).mockImplementation(() => { throw new Error("Unexpected backend SQL"); }));
    try { await seedTokenizersAsync(); }
    finally { spies.forEach(spy => spy.mockRestore()); }
    expect(snapshot().configs.length).toBeGreaterThan(20);
    expect(snapshot().patterns.length).toBeGreaterThan(20);
  });

  test("async seeding preserves custom rows, refreshes built-ins, and matches synchronous defaults", async () => {
    db.run(`INSERT INTO tokenizer_configs(id, name, type, config) VALUES ('custom', 'Custom', 'approximate', '{"charsPerToken":2}');
      INSERT INTO tokenizer_model_patterns(id, tokenizer_id, pattern, priority) VALUES ('custom-pattern', 'custom', 'custom-model', 999)`);
    seedTokenizers();
    const expected = snapshot();
    db.run("UPDATE tokenizer_configs SET name = 'Outdated', config = '{}' WHERE is_built_in = 1; UPDATE tokenizer_model_patterns SET pattern = 'outdated' WHERE is_built_in = 1");
    await seedTokenizersAsync();
    expect(snapshot()).toEqual(expected);
    await seedTokenizersAsync();
    expect(snapshot()).toEqual(expected);
    expect(db.query("SELECT is_built_in, config FROM tokenizer_configs WHERE id = 'custom'").get()).toEqual({ is_built_in: 0, config: '{"charsPerToken":2}' });
  });

  test("a competing writer reproduces the sync failure while async seeding retries without blocking timers", async () => {
    // Warm the child before holding the writer lock, isolating transaction
    // contention from connection initialization.
    await executeDatabaseOperation({ kind: "read", statement: { sql: "SELECT 1", mode: "get" } });
    const writer = new Database(path);
    writer.run("PRAGMA busy_timeout = 1000; BEGIN IMMEDIATE");
    expect(() => seedTokenizers()).toThrow("database is locked");
    expect(db.inTransaction).toBe(false);
    let beats = 0;
    const heartbeat = setInterval(() => beats++, 10);
    const release = setTimeout(() => writer.run("ROLLBACK"), 350);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const pending = seedTokenizersAsync();
      expect(log).not.toHaveBeenCalled();
      await pending;
      expect(beats).toBeGreaterThan(10);
      expect(log).toHaveBeenCalledTimes(1);
      expect(snapshot().patterns.length).toBeGreaterThan(20);
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 100 });
    } finally {
      log.mockRestore(); clearTimeout(release); clearInterval(heartbeat);
      if (writer.inTransaction) writer.run("ROLLBACK");
      writer.close(true);
    }
  });

  test("a pattern failure rolls back all config writes and emits no success message", async () => {
    db.run(`INSERT INTO tokenizer_configs(id, name, type, config) VALUES ('claude', 'Existing', 'approximate', '{}');
      CREATE TRIGGER reject_seed BEFORE INSERT ON tokenizer_model_patterns
      WHEN NEW.id = 'pat-fallback' BEGIN SELECT RAISE(ABORT, 'seed test failure'); END`);
    const before = snapshot();
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const error = await seedTokenizersAsync().catch(error => error);
      expect(error.code).toBe("SQLITE_CONSTRAINT_TRIGGER");
      expect(error.outcome).toBe("rolled-back");
      expect(snapshot()).toEqual(before);
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
    db.run("DROP TRIGGER reject_seed");
    await seedTokenizersAsync();
    expect(snapshot().patterns.length).toBeGreaterThan(20);
  });

  test("lazy startup SQL and seeding leave background writes paused until runtime starts", async () => {
    await executeDatabaseOperation({ kind: "read", statement: { sql: "SELECT 1", mode: "get" } });
    await Bun.sleep(100);
    expect(pendingSources()).toBe(6);
    await seedTokenizersAsync();
    expect(pendingSources()).toBe(6);
    await startDatabaseExecution();
    await waitForBackfill();
  });

  for (const transport of (process.platform === "win32" ? ["socket"] : ["socket", "stdio", "ipc"]) as Array<"socket" | "stdio" | "ipc">) {
    test(`background activation during startup survives a child replacement over ${transport}`, async () => {
      const executor = new DatabaseExecutor(path, { transport, deferBackgroundWork: true });
      try {
        const starting = executor.execute({ kind: "checkpoint" });
        // Activate while the child is still starting with --defer-background.
        executor.enableBackgroundWork();
        await starting;
        await waitForBackfill();
        executor.enableBackgroundWork(); // Activation is idempotent.
        db.run("UPDATE image_reference_index_state SET completed = 0, last_id = NULL, last_user_id = NULL");
        const error = await executor.execute<never>(longRead, { timeoutMs: 100 }).catch(error => error);
        expect(error.outcome).toBe("unknown");
        await executor.execute({ kind: "checkpoint" });
        await waitForBackfill();
        expect(getDb().query("PRAGMA mmap_size").get()).toEqual({ mmap_size: 0 });
      } finally { await executor.close(); }
    });
  }
});

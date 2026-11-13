import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseExecutor, executeDatabaseOperation, getDatabaseExecutionStatus, startDatabaseExecution, stopDatabaseExecution } from "./execution";
import { closeDatabase, initDatabase } from "./connection";
import { formatCheckpointDiagnostics } from "./checkpoint-diagnostics";

let directory: string;
let path: string;
let db: Database;
let executor: DatabaseExecutor;
const longRead = {
  kind: "read" as const,
  statement: { sql: "WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT sum(n) FROM numbers", mode: "get" as const },
};
const increment = { kind: "transaction" as const, statements: [{ sql: "UPDATE probe SET value = value + 1 WHERE id = 1" }] };

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lumiverse-executor-"));
  path = join(directory, "database.db");
  db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE probe (id INTEGER PRIMARY KEY, value INTEGER); INSERT INTO probe VALUES (1, 0)");
  executor = new DatabaseExecutor(path);
});
afterEach(async () => {
  await executor.close();
  if (db.inTransaction) db.exec("ROLLBACK");
  db.close(true);
  rmSync(directory, { recursive: true, force: true });
});

describe("supervised SQLite execution", () => {
  test("runtime keeps the legacy lock budget while the subprocess uses short waits", async () => {
    const main = initDatabase(path);
    try {
      await startDatabaseExecution();
      expect(main.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
      expect(await executeDatabaseOperation<{ timeout: number }>({
        kind: "read", statement: { sql: "PRAGMA busy_timeout", mode: "get" },
      })).toEqual({ timeout: 100 });
    } finally {
      await stopDatabaseExecution();
      closeDatabase();
    }
  });

  test("periodic checkpoints defer under load but eventually join behind foreground requests", async () => {
    initDatabase(path);
    let tick: (() => Promise<void>) | undefined;
    const originalSetInterval = globalThis.setInterval;
    const captureInterval = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
      if (timeout === 5000) tick = handler as () => Promise<void>;
      return originalSetInterval(handler, timeout, ...args);
    }) as typeof globalThis.setInterval;
    const interval = spyOn(globalThis, "setInterval").mockImplementation(captureInterval);
    try {
      await startDatabaseExecution();
      interval.mockRestore();
      expect(tick).toBeDefined();
      await executeDatabaseOperation({ kind: "transaction", statements: [
        { sql: "CREATE TABLE checkpoint_payload (data BLOB)" },
        { sql: "INSERT INTO checkpoint_payload VALUES (randomblob(3 * 1024 * 1024))" },
      ] });
      const active = executeDatabaseOperation<never>(longRead, { timeoutMs: 1000 }).catch(error => error);
      const foreground = executeDatabaseOperation<[{ changes: number }]>(increment).catch(error => error);
      for (let i = 0; i < 11; i++) {
        await tick!();
        expect(getDatabaseExecutionStatus().queued).toBe(1);
      }
      const forced = tick!();
      const deadline = Date.now() + 500;
      while (getDatabaseExecutionStatus().queued < 2 && Date.now() < deadline) await Bun.sleep(1);
      expect(getDatabaseExecutionStatus().queued).toBe(2);
      expect((await active).outcome).toBe("unknown");
      expect((await foreground)[0].changes).toBe(1);
      await forced;
      expect(getDatabaseExecutionStatus().queued).toBe(0);
      const idle = spyOn(DatabaseExecutor.prototype, "executeWhenIdle");
      try {
        await tick!();
        expect(idle).toHaveBeenCalledTimes(1);
        expect(getDatabaseExecutionStatus().active).toBeNull();
        const obsoleteTick = tick!;
        const restartInterval = spyOn(globalThis, "setInterval").mockImplementation(captureInterval);
        try { await startDatabaseExecution(); }
        finally { restartInterval.mockRestore(); }
        idle.mockClear();
        await obsoleteTick();
        expect(idle).not.toHaveBeenCalled();
        await tick!();
        expect(idle).toHaveBeenCalledTimes(1);
      } finally { idle.mockRestore(); }
    } finally {
      interval.mockRestore();
      await stopDatabaseExecution();
      closeDatabase();
    }
  });

  test("idle background work yields to active and queued foreground requests", async () => {
    expect(executor.executeWhenIdle({ kind: "checkpoint" })).toBeNull();
    await executor.execute({ kind: "checkpoint" });
    const active = executor.execute<never>(longRead, { timeoutMs: 100 }).catch(error => error);
    const queued = executor.execute(increment, { timeoutMs: 3000 });
    expect(executor.status.queued).toBe(1);
    expect(executor.executeWhenIdle({ kind: "checkpoint" })).toBeNull();
    expect((await active).outcome).toBe("unknown");
    await queued;
    const checkpoint = executor.executeWhenIdle<{ busy: number; log: number; checkpointed: number }>({ kind: "checkpoint" });
    expect(checkpoint).not.toBeNull();
    expect((await checkpoint)!.busy).toBe(0);
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 1 });
    await executor.close();
    expect(executor.executeWhenIdle({ kind: "checkpoint" })).toBeNull();
  });

  test("PASSIVE checkpoints report a reader-pinned backlog and complete after its release", async () => {
    await executor.execute({ kind: "checkpoint" });
    const reader = new Database(path);
    try {
      reader.exec("BEGIN");
      expect(reader.query("SELECT value FROM probe").get()).toEqual({ value: 0 });
      await executor.execute(increment);
      const partial = await executor.execute<{ busy: number; log: number; checkpointed: number }>({ kind: "checkpoint" });
      expect(partial.busy).toBe(0);
      expect(partial.log).toBeGreaterThan(partial.checkpointed);
      expect(formatCheckpointDiagnostics(partial)).not.toContain("remainingPages=0");
      reader.exec("COMMIT");
      const complete = await executor.execute<{ busy: number; log: number; checkpointed: number }>({ kind: "checkpoint" });
      expect(complete.busy).toBe(0);
      expect(complete.checkpointed).toBe(complete.log);
      expect(formatCheckpointDiagnostics(complete)).toContain("remainingPages=0");
    } finally {
      if (reader.inTransaction) reader.exec("ROLLBACK");
      reader.close(true);
    }
  });

  test.each(process.platform === "win32" ? ["socket"] as const : ["socket", "ipc", "stdio"] as const)("%s transport preserves fragmented blobs and undefined metadata deletions", async (transport) => {
    await executor.close();
    executor = new DatabaseExecutor(path, { transport });
    const blob = new Uint8Array(8 * 1024 * 1024).map((_, index) => index % 251);
    const row = await executor.execute<{ blob: Uint8Array; integer: number }>({ kind: "read", statement: { sql: "SELECT ? AS blob, ? AS integer", bindings: [blob, 42n], mode: "get" } });
    expect(row.blob).toEqual(blob);
    expect(row.integer).toBe(42);
    db.exec("CREATE TABLE chats (id TEXT, user_id TEXT, metadata TEXT, updated_at INTEGER); INSERT INTO chats VALUES ('chat', 'user', '{\"remove\":true}', 0)");
    const result = await executor.execute<any>({ kind: "chat-mutation", mutation: { action: "merge", userId: "user", id: "chat", partial: { remove: undefined, kept: true } } });
    expect(result.after.metadata).toEqual({ kept: true });
    expect(JSON.parse((db.query("SELECT metadata FROM chats").get() as any).metadata)).toEqual({ kept: true });
  });

  test("serializes concurrent writes", async () => {
    await Promise.all(Array.from({ length: 20 }, () => executor.execute(increment)));
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 20 });
  });

  test("a failed transaction rolls back every statement", async () => {
    const error = await executor.execute<never>({ kind: "transaction", statements: [
      { sql: "UPDATE probe SET value = 10" },
      { sql: "INSERT INTO probe VALUES (1, 99)" },
    ] }).catch((error) => error);
    expect(error.code).toBe("SQLITE_CONSTRAINT_PRIMARYKEY");
    expect(error.outcome).toBe("rolled-back");
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 0 });
    await executor.execute(increment);
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 1 });
  });

  test("compare failures roll back earlier statements and identify the conflict", async () => {
    const error = await executor.execute<never>({ kind: "transaction", statements: [
      { sql: "UPDATE probe SET value = 10" },
      { sql: "UPDATE probe SET value = 20 WHERE id = 99", expectedChanges: 1 },
    ] }).catch((error) => error);
    expect(error.code).toBe("DATABASE_COMPARE_FAILED");
    expect(error.statementIndex).toBe(1);
    expect(error.outcome).toBe("rolled-back");
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 0 });
  });

  test("row-count checks exclude trigger side effects", async () => {
    db.exec("CREATE TABLE audit (value INTEGER); CREATE TRIGGER probe_audit AFTER UPDATE ON probe BEGIN INSERT INTO audit VALUES (new.value); END");
    const [result] = await executor.execute<[{ changes: number }]>({
      kind: "transaction", statements: [{ sql: "UPDATE probe SET value = 1 WHERE id = 1", expectedChanges: 1 }],
    });
    expect(result.changes).toBe(1);
    expect(db.query("SELECT value FROM audit").all()).toEqual([{ value: 1 }]);
  });

  test("cancelling an acknowledged rollback keeps the child available", async () => {
    await executor.execute({ kind: "checkpoint" });
    db.exec("BEGIN IMMEDIATE");
    const abort = new AbortController();
    const pending = executor.execute<never>(increment, { signal: abort.signal }).catch((error) => error);
    const deadline = Date.now() + 2000;
    while (executor.status.phase !== "retrying" && Date.now() < deadline) await Bun.sleep(1);
    expect(executor.status.phase).toBe("retrying");
    abort.abort();
    expect((await pending).name).toBe("AbortError");
    expect(executor.status.ready).toBe(true);
    db.exec("ROLLBACK");
    await executor.execute(increment);
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 1 });
  });

  test("waiting for a previous writer still has a bounded queue and deadline", async () => {
    await executor.close();
    let release!: () => void;
    const previous = new Promise<void>((resolve) => { release = resolve; });
    executor = new DatabaseExecutor(path, { maxPending: 1 }, previous);
    try {
      const pending = executor.execute<never>(increment, { timeoutMs: 30 }).catch((error) => error);
      const full = await executor.execute<never>(increment).catch((error) => error);
      expect(full.code).toBe("DATABASE_QUEUE_FULL");
      expect((await pending).outcome).toBe("not-started");
      expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 0 });
    } finally { release(); }
  });

  test.each(["request", "startup"])("a missing ready handshake reports startup failure when the %s deadline wins", async (deadline) => {
    await executor.close();
    executor = new DatabaseExecutor(path, {
      transport: "socket",
      startupTimeoutMs: deadline === "startup" ? 150 : 2000,
      runtimePath: join(import.meta.dir, "test-fixtures/execution-unready.ts"),
    });
    const error = await executor.execute<never>(increment, { timeoutMs: deadline === "request" ? 150 : 2000 }).catch(error => error);
    expect(error.code).toBe("DATABASE_STARTUP_TIMEOUT");
    expect(error.outcome).toBe("not-started");
    expect(error.message).toContain("transport=socket");
    expect(error.message).toContain("runtime=");
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 0 });
  });

  test("file-backed bootstrap completes at top level without resolving bun from PATH", async () => {
    const startupDir = join(directory, "fresh database ü");
    mkdirSync(startupDir);
    const childEnv = { ...process.env };
    // Windows environment keys are case-insensitive; remove both Path and PATH.
    for (const key of Object.keys(childEnv)) if (key.toLowerCase() === "path") delete childEnv[key];
    const child = Bun.spawn({
      cmd: [process.execPath, "--smol", join(import.meta.dir, "test-fixtures/execution-startup.ts"), join(startupDir, "database.db")],
      env: {
        ...childEnv,
        PATH: startupDir,
        LUMIVERSE_BUN_EXECUTABLE: process.execPath,
        LUMIVERSE_BUN_METHOD: "",
        LUMIVERSE_BUN_PATH: "",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 15_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("database bootstrap complete");
    } finally { clearTimeout(deadline); child.kill(); await child.exited; }
  }, 20_000);

  test("retries a rolled-back busy write while HTTP stays responsive", async () => {
    await executor.execute({ kind: "checkpoint" });
    db.exec("BEGIN IMMEDIATE; UPDATE probe SET value = 5");
    const server = Bun.serve({ port: 0, fetch: () => new Response("healthy") });
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 10);
    const release = setTimeout(() => db.exec("COMMIT"), 350);
    try {
      const pending = executor.execute(increment, { timeoutMs: 3000 });
      const response = await fetch(server.url);
      expect(await response.text()).toBe("healthy");
      await pending;
      expect(heartbeats).toBeGreaterThan(10);
      expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 6 });
    } finally {
      clearTimeout(release);
      clearInterval(heartbeat);
      server.stop(true);
    }
  });

  test("bounds the queue and cancels writes before dispatch", async () => {
    await executor.close();
    executor = new DatabaseExecutor(path, { maxPending: 2 });
    await executor.execute({ kind: "checkpoint" });
    const active = executor.execute<never>(longRead, { timeoutMs: 350 }).catch((error) => error);
    const abort = new AbortController();
    const queued = executor.execute<never>(increment, { signal: abort.signal }).catch((error) => error);
    const full = await executor.execute<never>(increment).catch((error) => error);
    expect(full.code).toBe("DATABASE_QUEUE_FULL");
    expect(full.outcome).toBe("not-started");
    abort.abort();
    expect((await queued).name).toBe("AbortError");
    expect((await active).outcome).toBe("unknown");
    await executor.execute({ kind: "checkpoint" });
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 0 });
  });

  test("a queued deadline expires without executing the write", async () => {
    await executor.execute({ kind: "checkpoint" });
    const active = executor.execute<never>(longRead, { timeoutMs: 350 }).catch((error) => error);
    const error = await executor.execute<never>(increment, { timeoutMs: 50 }).catch((error) => error);
    expect(error.code).toBe("DATABASE_QUEUE_TIMEOUT");
    expect(error.outcome).toBe("not-started");
    await active;
    await executor.execute({ kind: "checkpoint" });
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 0 });
  });

  test.each([undefined, "socket", ...(process.platform === "win32" ? [] : ["stdio"] as const)] as const)("interrupts native SQL on deadline and starts a replacement (%s)", async (transport) => {
    await executor.close();
    executor = new DatabaseExecutor(path, { transport });
    await executor.execute({ kind: "checkpoint" });
    let heartbeats = 0;
    const heartbeat = setInterval(() => heartbeats++, 10);
    try {
      const error = await executor.execute<never>(longRead, { timeoutMs: 200 }).catch((error) => error);
      expect(error.code).toBe("DATABASE_OUTCOME_UNKNOWN");
      expect(heartbeats).toBeGreaterThan(5);
      await executor.execute(increment);
      expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 1 });
    } finally { clearInterval(heartbeat); }
  });

  test.each([undefined, "socket", ...(process.platform === "win32" ? [] : ["stdio"] as const)] as const)("does not replay a committed write after losing its acknowledgment (%s)", async (transport) => {
    await executor.close();
    executor = new DatabaseExecutor(path, { transport, runtimePath: join(import.meta.dir, "test-fixtures/execution-crash.ts") });
    const error = await executor.execute<never>({ kind: "transaction", statements: [{ sql: "UPDATE probe SET value = value + 1 /* lose-ack */" }] }).catch((error) => error);
    expect(error.outcome).toBe("unknown");
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 1 });
    await executor.execute({ kind: "checkpoint" });
    expect(db.query("SELECT value FROM probe").get()).toEqual({ value: 1 });
  });
});

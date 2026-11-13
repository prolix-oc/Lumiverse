import { stat } from "node:fs/promises";
import { join } from "node:path";
import { bunCmd } from "../utils/bun-cmd";
import { configuredBunExecutable } from "../runtime/bun-runtime";
import { getDatabasePath, getDb, onDbReset } from "./connection";
import { executeOperation } from "./execute-operation";
import { formatImageReferenceDiagnostics } from "./image-reference-diagnostics";
import { formatCheckpointDiagnostics } from "./checkpoint-diagnostics";
import { encodeDatabaseMessage, readDatabaseMessages } from "./execution-transport";
import { createDatabaseSocketHost } from "./execution-socket";
import type { DatabaseMaintenanceResult } from "./maintenance";
import type {
  DatabaseChildMessage, DatabaseExecutionFailure, DatabaseExecutionOutcome,
  DatabaseHostMessage, DatabaseOperation,
} from "./execution-protocol";

export class DatabaseExecutionError extends Error {
  readonly name = "DatabaseExecutionError";
  constructor(message: string, readonly code: string, readonly outcome: DatabaseExecutionOutcome, readonly statementIndex?: number) { super(message); }
}
export function isDatabaseUnavailable(error: unknown): error is Error & { code: string } {
  const code = (error as { code?: string } | null)?.code;
  return error instanceof Error && typeof code === "string" && (
    ["DATABASE_CLOSED", "DATABASE_QUEUE_FULL", "DATABASE_QUEUE_TIMEOUT", "DATABASE_LOCK_TIMEOUT",
      "DATABASE_STARTUP_TIMEOUT", "DATABASE_UNAVAILABLE", "DATABASE_OUTCOME_UNKNOWN"].includes(code)
    || code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")
  );
}

interface PendingOperation {
  requestId: string;
  operation: DatabaseOperation;
  deadline: number;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  attempts: number;
  dispatched: boolean;
  interactiveRead?: boolean;
}
export interface DatabaseExecutionOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Promote SELECT reads within a read-only queue segment, never across writes. */
  priority?: "interactive";
}
export interface DatabaseExecutorOptions {
  maxPending?: number;
  startupTimeoutMs?: number;
  runtimePath?: string;
  transport?: "ipc" | "stdio" | "socket";
  /** Bootstrap requests may start the child before synchronous initialization ends. */
  deferBackgroundWork?: boolean;
}

// Be conservative: PRAGMAs, transactions, mutations and unrecognized SQL
// remain ordering barriers even when they happen to return rows.
function isReorderableRead(operation: DatabaseOperation): boolean {
  return operation.kind === "read"
    && (operation.statement.mode === "get" || operation.statement.mode === "all")
    && /^\s*SELECT\b/i.test(operation.statement.sql);
}

/** One bounded queue and one native operation at a time per backend database. */
export class DatabaseExecutor {
  private process: ReturnType<typeof Bun.spawn> | null = null;
  private sendMessage: ((message: DatabaseHostMessage) => void) | null = null;
  private closeTransport: (() => void) | null = null;
  private readonly transport: "ipc" | "stdio" | "socket";
  private childRuntime = "";
  private ready = false;
  private closed = false;
  private queue: PendingOperation[] = [];
  private active: PendingOperation | null = null;
  private interactiveReadStreak = 0;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<unknown> | null = null;
  private backgroundWorkEnabled: boolean;

  constructor(readonly path: string, private readonly options: DatabaseExecutorOptions = {}, previousClosed?: Promise<void>) {
    // Windows has had failures in both Bun IPC and binary stdio pipes. Use the
    // same loopback strategy as the Windows runner, retaining binary values.
    this.transport = options.transport ?? (process.platform === "win32" ? "socket" : "ipc");
    this.backgroundWorkEnabled = !options.deferBackgroundWork;
    if (previousClosed) {
      this.stopping = previousClosed;
      void previousClosed.then(() => {
        if (this.stopping === previousClosed) this.stopping = null;
        this.pump();
      });
    }
  }

  get status() {
    return {
      ready: this.ready, queued: this.queue.length, active: this.active?.operation.kind ?? null,
      phase: this.active ? (this.active.dispatched ? "running" : "retrying") : "idle",
      closed: this.closed,
    };
  }

  execute<T>(operation: DatabaseOperation, options: DatabaseExecutionOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new DatabaseExecutionError("Database executor is closed", "DATABASE_CLOSED", "not-started"));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (this.queue.length + Number(!!this.active) >= (this.options.maxPending ?? 128)) {
      return Promise.reject(new DatabaseExecutionError("Database queue is full", "DATABASE_QUEUE_FULL", "not-started"));
    }
    const timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RangeError("Database timeout must be positive"));
    return new Promise<T>((resolve, reject) => {
      const item: PendingOperation = {
        requestId: crypto.randomUUID(), operation, deadline: Date.now() + timeoutMs,
        resolve: resolve as (result: unknown) => void, reject, attempts: 0, dispatched: false,
        timer: setTimeout(() => this.expire(item), timeoutMs),
        interactiveRead: options.priority === "interactive" && isReorderableRead(operation),
      };
      const abort = () => this.expire(item, options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => options.signal?.removeEventListener("abort", abort);
      item.resolve = (result) => { cleanup(); resolve(result as T); };
      item.reject = (error) => { cleanup(); reject(error); };
      this.queue.push(item);
      this.pump();
    });
  }

  /** Background work may use an already idle child, without queuing ahead of
   * foreground requests or starting a replacement child during shutdown/recovery.
   */
  executeWhenIdle<T>(operation: DatabaseOperation): Promise<T> | null {
    if (!this.ready || this.closed || this.active || this.queue.length || this.stopping) return null;
    return this.execute<T>(operation);
  }

  /** Remember the runtime phase across child replacements. Starting background
   * indexing is idempotent; a lost signal is repaired on the next child spawn.
   */
  enableBackgroundWork(): void {
    this.backgroundWorkEnabled = true;
    if (!this.ready || this.closed || !this.process) return;
    try { this.sendMessage!({ type: "start-background" }); }
    catch { this.transportFailed(this.process); }
  }

  private finish(item: PendingOperation, result: unknown, error?: unknown): void {
    clearTimeout(item.timer);
    if (error) item.reject(error);
    else item.resolve(result);
  }

  private expire(item: PendingOperation, reason?: unknown): void {
    if (this.active === item) {
      this.active = null;
      if (!item.dispatched) {
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.finish(item, null, reason ?? new DatabaseExecutionError("Database remained locked until the operation deadline", "DATABASE_LOCK_TIMEOUT", "rolled-back"));
        this.pump();
        return;
      }
      // Killing the child cannot tell us whether COMMIT reached disk. Never
      // replay this operation automatically, even if it was declared a write.
      this.finish(item, null, new DatabaseExecutionError("Database operation interrupted; its outcome requires reconciliation", "DATABASE_OUTCOME_UNKNOWN", "unknown"));
      void this.retire().then(() => this.pump());
      return;
    }
    const index = this.queue.indexOf(item);
    if (index < 0) return;
    this.queue.splice(index, 1);
    const starting = !this.ready && !!this.process;
    this.finish(item, null, reason ?? (starting ? this.startupFailure()
      : new DatabaseExecutionError("Database operation expired before execution", "DATABASE_QUEUE_TIMEOUT", "not-started")));
    if (starting && this.queue.length === 0) void this.retire();
  }

  private startupFailure(): DatabaseExecutionError {
    return new DatabaseExecutionError(
      `Database subprocess did not become ready (transport=${this.transport}, pid=${this.process?.pid ?? "none"}, runtime=${this.childRuntime})`,
      "DATABASE_STARTUP_TIMEOUT", "not-started",
    );
  }

  private spawn(): void {
    try {
      const pipes = this.transport === "stdio";
      let proc: ReturnType<typeof Bun.spawn>;
      const socket = this.transport === "socket" ? createDatabaseSocketHost({
        receive: (message) => { if (this.process === proc) this.receive(message as DatabaseChildMessage); },
        disconnect: () => { if (this.process === proc) this.transportFailed(proc); },
      }) : null;
      this.closeTransport = socket ? () => socket.close() : null;
      let outputDrained: Promise<void> = Promise.resolve();
      const args = [this.options.runtimePath ?? join(import.meta.dir, "execution-subprocess.ts"), this.path,
        ...(pipes ? ["--stdio"] : []), ...(socket ? ["--socket"] : []),
        ...(!this.backgroundWorkEnabled ? ["--defer-background"] : [])];
      // A Windows side-by-side runtime need not be the bare `bun` on PATH.
      // Bun IPC also requires compatible runtimes on both sides. Preserve the
      // external wrapper that is needed to execute Bun on native Termux.
      const cmd = process.env.LUMIVERSE_BUN_METHOD && process.env.LUMIVERSE_BUN_PATH
        ? bunCmd(...args) : [configuredBunExecutable(), ...args];
      this.childRuntime = cmd[0]!;
      const launch = {
        cmd,
        ...(socket ? { env: { ...process.env, ...socket.env } } : {}),
        stderr: "inherit" as const,
        windowsHide: true,
        onExit: (child: ReturnType<typeof Bun.spawn>) => {
          // Pipe messages already written before exit must be delivered first.
          if (pipes) void outputDrained.then(() => this.childExited(child));
          else this.childExited(child);
        },
      };
      proc = socket ? Bun.spawn({ ...launch, stdin: "ignore", stdout: "inherit" }) : pipes
        ? Bun.spawn({ ...launch, stdin: "pipe", stdout: "pipe" })
        : Bun.spawn({ ...launch, stdin: "ignore", stdout: "inherit", serialization: "advanced", ipc: (message, child) => {
          if (this.process === child) this.receive(message as DatabaseChildMessage);
        } });
      this.process = proc;
      this.sendMessage = socket ? (message) => socket.send(message) : pipes ? (message) => {
        const input = proc.stdin as Bun.FileSink;
        input.write(encodeDatabaseMessage(message));
        void Promise.resolve(input.flush()).catch(() => this.transportFailed(proc));
      } : (message) => { proc.send(message); };
      if (pipes) outputDrained = readDatabaseMessages(proc.stdout as ReadableStream<Uint8Array>, (message) => {
        if (this.process === proc) this.receive(message as DatabaseChildMessage);
      }).then(() => this.transportFailed(proc), () => this.transportFailed(proc));
      this.startupTimer = setTimeout(() => {
        if (this.process !== proc || this.ready) return;
        this.failQueued(this.startupFailure());
        void this.retire();
      }, this.options.startupTimeoutMs ?? 10_000);
    } catch (err) {
      this.closeTransport?.();
      this.closeTransport = null;
      this.failQueued(new DatabaseExecutionError(`Unable to start database subprocess: ${String(err)}`, "DATABASE_UNAVAILABLE", "not-started"));
    }
  }

  private childExited(child: ReturnType<typeof Bun.spawn>): void {
    if (this.process !== child) return;
    this.process = null;
    this.sendMessage = null;
    this.closeTransport?.();
    this.closeTransport = null;
    this.ready = false;
    this.clearStartup();
    if (this.active) {
      const item = this.active;
      this.active = null;
      this.finish(item, null, new DatabaseExecutionError("Database subprocess exited during execution", item.dispatched ? "DATABASE_OUTCOME_UNKNOWN" : "DATABASE_UNAVAILABLE", item.dispatched ? "unknown" : "rolled-back"));
    }
    this.failQueued(new DatabaseExecutionError("Database subprocess exited", "DATABASE_UNAVAILABLE", "not-started"));
  }

  private transportFailed(child: ReturnType<typeof Bun.spawn>): void {
    if (this.process !== child) return;
    if (this.active) {
      const item = this.active;
      this.active = null;
      this.finish(item, null, new DatabaseExecutionError("Database transport closed during execution", item.dispatched ? "DATABASE_OUTCOME_UNKNOWN" : "DATABASE_UNAVAILABLE", item.dispatched ? "unknown" : "rolled-back"));
    }
    this.failQueued(new DatabaseExecutionError("Database transport closed", "DATABASE_UNAVAILABLE", "not-started"));
    void this.retire().then(() => this.pump());
  }

  private clearStartup(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
  }

  private receive(message: DatabaseChildMessage): void {
    if (message.type === "ready") {
      this.clearStartup();
      this.ready = true;
      // Activation can race a child that was spawned in bootstrap mode.
      if (this.backgroundWorkEnabled) this.enableBackgroundWork();
      this.pump();
      return;
    }
    if (message.type === "error" && !message.requestId) {
      this.failQueued(this.failure(message.error));
      void this.retire();
      return;
    }
    const item = this.active;
    if (!item || !("requestId" in message) || message.requestId !== item.requestId) return;
    this.active = null;
    if (message.type === "error") {
      const error = message.error;
      if (error.outcome === "rolled-back" && error.code?.startsWith("SQLITE_BUSY") && Date.now() < item.deadline) {
        // Retry the whole transaction only after a confirmed rollback. Reads
        // and maintenance are not silently replayed after partial progress.
        this.active = item;
        item.dispatched = false;
        const delay = Math.min(250, 25 * 2 ** Math.min(item.attempts++, 4));
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.active !== item) return;
          this.active = null;
          this.queue.unshift(item);
          this.pump();
        }, delay);
        return;
      }
      this.finish(item, null, this.failure(error));
    } else if (message.type === "result") {
      if (message.durationMs > 250) {
        const detail = message.imageReferences ? formatImageReferenceDiagnostics(message.imageReferences)
          : item.operation.kind === "checkpoint" ? formatCheckpointDiagnostics(message.result) : "";
        console.warn(`[db] slow operation kind=${item.operation.kind} request=${item.requestId} duration=${Math.round(message.durationMs)}ms${detail}`);
      }
      this.finish(item, message.result);
    }
    this.pump();
  }

  private failure(error: DatabaseExecutionFailure): DatabaseExecutionError {
    return new DatabaseExecutionError(error.message, error.code ?? "DATABASE_OPERATION_FAILED", error.outcome, error.statementIndex);
  }

  private pump(): void {
    if (this.closed || this.active || this.stopping) return;
    if (this.queue.length === 0) { this.interactiveReadStreak = 0; return; }
    if (!this.process) { this.spawn(); return; }
    if (!this.ready) return;
    let nextIndex = 0;
    if (this.interactiveReadStreak < 4) {
      // Only overtake SELECTs before the first ordering barrier. Earlier
      // writes must commit before an interactive read can observe their state.
      for (let index = 0; index < this.queue.length; index++) {
        const candidate = this.queue[index];
        if (!isReorderableRead(candidate.operation)) break;
        if (candidate.interactiveRead) { nextIndex = index; break; }
      }
    }
    const [item] = this.queue.splice(nextIndex, 1);
    // After four interactive reads, give the oldest queued operation a turn.
    this.interactiveReadStreak = item.interactiveRead ? this.interactiveReadStreak + 1 : 0;
    this.active = item;
    item.dispatched = true;
    try {
      this.sendMessage!({ type: "execute", requestId: item.requestId, operation: item.operation });
    } catch {
      this.active = null;
      this.finish(item, null, new DatabaseExecutionError("Database transport failed; operation outcome is unknown", "DATABASE_OUTCOME_UNKNOWN", "unknown"));
      void this.retire().then(() => this.pump());
    }
  }

  private failQueued(error: unknown): void {
    for (const item of this.queue.splice(0)) this.finish(item, null, error);
  }

  private retire(): Promise<unknown> {
    if (this.stopping) return this.stopping;
    this.clearStartup();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const proc = this.process;
    this.process = null;
    const sendMessage = this.sendMessage;
    const closeTransport = this.closeTransport;
    this.closeTransport = null;
    this.sendMessage = null;
    this.ready = false;
    if (!proc) { closeTransport?.(); return Promise.resolve(); }
    // Graceful shutdown: send shutdown message before SIGKILL to avoid disconnect gaps.
    if (sendMessage) {
      try { sendMessage({ type: "shutdown" }); } catch { /* ignore */ }
    }
    // Give the child a brief window to exit cleanly after shutdown message.
    const gracefulTimeout = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }, 500);
    const stopping = proc.exited.catch(() => {}).finally(() => {
      clearTimeout(gracefulTimeout);
      closeTransport?.();
      if (this.stopping === stopping) this.stopping = null;
    });
    this.stopping = stopping;
    return stopping;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failQueued(new DatabaseExecutionError("Database executor closed", "DATABASE_CLOSED", "not-started"));
    if (this.active) {
      const item = this.active;
      this.active = null;
      this.finish(item, null, new DatabaseExecutionError("Database executor closed during execution", item.dispatched ? "DATABASE_OUTCOME_UNKNOWN" : "DATABASE_CLOSED", item.dispatched ? "unknown" : "rolled-back"));
    }
    await this.retire();
  }
}

let executor: DatabaseExecutor | null = null;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
let checkpointRunning = false;
let checkpointGeneration = 0;
let previousExecutorClosed: Promise<void> = Promise.resolve();
let executionStopped = false;
let runtimeStarted = false;

export function executeDatabaseOperation<T>(operation: DatabaseOperation, options?: DatabaseExecutionOptions): Promise<T> {
  let db: ReturnType<typeof getDb>;
  try { db = getDb(); }
  catch { return Promise.reject(new DatabaseExecutionError("Database connection is closed", "DATABASE_CLOSED", "not-started")); }
  if (executionStopped) return Promise.reject(new DatabaseExecutionError("Database executor is stopped", "DATABASE_CLOSED", "not-started"));
  const path = getDatabasePath();
  // In-memory databases are deliberately local fixtures; a subprocess cannot
  // share their contents. Production file databases never fall back in-process.
  if (path === ":memory:") {
    if (options?.signal?.aborted) return Promise.reject(options.signal.reason);
    try { return Promise.resolve(executeOperation(db, path, operation) as T); }
    catch (err) { return Promise.reject(err); }
  }
  // A reset must release the old writer before opening its replacement.
  if (!executor || executor.path !== path) executor = new DatabaseExecutor(path, { deferBackgroundWork: !runtimeStarted }, previousExecutorClosed);
  return executor.execute<T>(operation, options);
}

export function getDatabaseExecutionStatus() {
  return executor?.status ?? { ready: false, queued: 0, active: null, phase: "idle", closed: false };
}

export function runDatabaseMaintenanceAsync(options: Extract<DatabaseOperation, { kind: "maintenance" }>["options"]): Promise<DatabaseMaintenanceResult> {
  return executeDatabaseOperation({ kind: "maintenance", options }, { timeoutMs: options.vacuum ? 120_000 : 30_000 });
}

/** Replace commit-time checkpoints only after the off-process path is ready. */
export async function startDatabaseExecution(): Promise<void> {
  executionStopped = false;
  const path = getDatabasePath();
  if (path === ":memory:") return;
  await executeDatabaseOperation({ kind: "checkpoint" });
  runtimeStarted = true;
  executor?.enableBackgroundWork();
  const generation = ++checkpointGeneration;
  if (checkpointTimer) clearInterval(checkpointTimer);
  checkpointRunning = false;
  let deferredTicks = 0;
  checkpointTimer = setInterval(async () => {
    if (generation !== checkpointGeneration || checkpointRunning) return;
    checkpointRunning = true;
    try {
      const wal = await stat(`${path}-wal`).catch(() => null);
      if (generation !== checkpointGeneration) return;
      if (!wal || wal.size < 2 * 1024 * 1024) { deferredTicks = 0; return; }
      // Recheck after stat's await. Requests arriving while we inspected the
      // WAL must take priority; the next tick can try again.
      const idle = executor?.executeWhenIdle({ kind: "checkpoint" });
      if (idle) {
        await idle;
        deferredTicks = 0;
      } else if (++deferredTicks >= 12) {
        // Automatic checkpoints are disabled. Sustained foreground traffic
        // must not starve WAL maintenance indefinitely; after a minute, join
        // the normal bounded queue behind requests already waiting.
        await executeDatabaseOperation({ kind: "checkpoint" });
        deferredTicks = 0;
      }
    } catch (err) {
      console.warn("[db] Background checkpoint failed:", err);
    } finally { if (generation === checkpointGeneration) checkpointRunning = false; }
  }, 5000);
  checkpointTimer.unref();
  getDb().run("PRAGMA wal_autocheckpoint = 0");
}

export async function stopDatabaseExecution(): Promise<void> {
  executionStopped = true;
  runtimeStarted = false;
  checkpointGeneration++;
  checkpointRunning = false;
  if (checkpointTimer) clearInterval(checkpointTimer);
  checkpointTimer = null;
  const old = executor;
  executor = null;
  previousExecutorClosed = Promise.all([previousExecutorClosed, old?.close()]).then(() => {});
  await previousExecutorClosed;
}

onDbReset(() => {
  void stopDatabaseExecution();
  // Initialization enables lazy execution again; closure must not accidentally
  // open the default instance database for a late background callback.
  try { getDb(); executionStopped = false; } catch { /* connection closed */ }
});

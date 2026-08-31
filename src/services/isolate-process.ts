import { fileURLToPath } from "node:url";
import { bunCmd } from "../utils/bun-cmd";
import { scheduleLowPriorityTask } from "../utils/low-priority-task";
import {
  DEFAULT_ISOLATE_MAX_FRAME_BYTES,
  decodeJsonFrame,
  LengthPrefixedFrameDecoder,
  normalizeIsolateMaxFrameBytes,
  preflightEncodedFrame,
} from "./isolate-protocol";

export type IsolateProcessSignal = "SIGTERM" | "SIGKILL";

export interface IsolateProcessLike {
  readonly pid?: number;
  readonly stdin?: {
    write(data: Uint8Array | ArrayBuffer): number | Promise<number>;
    flush?: () => void | Promise<void>;
    end?: () => void | Promise<void>;
  } | null;
  readonly stdout?: ReadableStream<Uint8Array> | null;
  readonly exited?: Promise<number>;
  kill(signal?: IsolateProcessSignal): void;
}

export interface IsolateProcessTransport {
  readonly kind: "subprocess";
  readonly pid: number | null;
  send(message: unknown): Promise<void>;
  onMessage(handler: (message: unknown) => void): () => void;
  onError(handler: (error: unknown) => void): () => void;
  terminate(signal?: IsolateProcessSignal): Promise<void>;
}

export interface SpawnIsolateProcessOptions {
  readonly command: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly maxFrameBytes?: number;
  readonly spawn?: (options: {
    cmd: string[];
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdin: "pipe";
    stdout: "pipe";
    stderr: "ignore" | "pipe";
    detached?: boolean;
  }) => IsolateProcessLike;
}

function normalizeEnvironment(env: Record<string, string | undefined> | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

async function writeStdin(
  stdin: NonNullable<IsolateProcessLike["stdin"]>,
  frame: Uint8Array,
): Promise<void> {
  // Bun's FileSink owns the entire view passed to write(), even when the
  // return value reports only the bytes flushed immediately. Retrying a
  // suffix duplicates the queued frame and corrupts the next length prefix.
  const flushedBytes = await stdin.write(frame);
  if (
    !Number.isSafeInteger(flushedBytes)
    || flushedBytes < 0
    || flushedBytes > frame.byteLength
  ) {
    throw new Error(`Isolate subprocess stdin reported an invalid flushed byte count: ${String(flushedBytes)}`);
  }
  if (stdin.flush) await stdin.flush();
}

const TERMINATION_GRACE_MS = 250;

async function waitBounded(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  });
  const completed = Promise.resolve(task).then(() => true, () => true);
  const result = await Promise.race([completed, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}

async function awaitBoundedSuccess(
  task: Promise<void>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    task.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
    new Promise<{ ok: false; error: Error }>((resolve) => {
      timer = setTimeout(
        () => resolve({ ok: false, error: new Error(`${label} timed out`) }),
        timeoutMs,
      );
      (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (!outcome.ok) throw outcome.error;
}

async function cancelReadableBounded(
  stream: ReadableStream<Uint8Array> | null | undefined,
): Promise<void> {
  await waitBounded(cancelReadable(stream), TERMINATION_GRACE_MS);
}

async function cancelReadable(stream: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  if (!stream) return;
  try {
    await stream.cancel();
  } catch {
    // The process kill is authoritative; a closed stream is expected here.
  }
}

/**
 * Kill a subprocess and its descendants. POSIX isolates are started in their
 * own process group; the group signal handles descendants created after the
 * initial snapshot, while the process-table walk covers hosts where a group
 * cannot be addressed. Windows uses taskkill's tree mode.
 */
interface ProcessTableEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number | null;
}

function processTable(): ProcessTableEntry[] {
  try {
    const result = Bun.spawnSync({
      cmd: ["ps", "-axo", "pid=,ppid=,pgid="],
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = typeof result.stdout === "string"
      ? result.stdout
      : new TextDecoder().decode(result.stdout);
    const rows: ProcessTableEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(\d+)\s+(\d+)(?:\s+(\d+))?\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      const pgid = match[3] === undefined ? null : Number(match[3]);
      if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue;
      rows.push({ pid, ppid, pgid });
    }
    return rows;
  } catch {
    return [];
  }
}

function descendantPids(rootPid: number): number[] {
  const rows = processTable();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }

  const root = rows.find((row) => row.pid === rootPid);
  const descendants = new Set<number>();
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift()!;
    if (descendants.has(pid)) continue;
    descendants.add(pid);
    pending.push(...(children.get(pid) ?? []));
  }

  // A detached process is its own process-group leader. Include every member
  // in that group so a child that re-parents during teardown is still seen.
  if (root?.pgid === rootPid) {
    for (const row of rows) {
      if (row.pid !== rootPid && row.pgid === rootPid) descendants.add(row.pid);
    }
  }
  return [...descendants];
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error.code === "ESRCH" || error.code === "ENOENT");
}

function signalDescendants(
  pids: readonly number[],
  signal: IsolateProcessSignal,
): unknown[] {
  const failures: unknown[] = [];
  for (const childPid of pids) {
    try {
      process.kill(childPid, signal as NodeJS.Signals);
    } catch (error) {
      if (!isNoSuchProcess(error)) failures.push(error);
    }
  }
  return failures;
}

interface TerminationAttempt {
  readonly knownDescendants: number[];
  readonly failures: unknown[];
  readonly platformTask: Promise<void> | null;
}

function terminateGroupOrTree(
  processLike: IsolateProcessLike,
  signal: IsolateProcessSignal,
  platform: string,
): TerminationAttempt {
  const pid = Number(processLike.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      processLike.kill(signal);
      return { knownDescendants: [], failures: [], platformTask: null };
    } catch (error) {
      return {
        knownDescendants: [],
        failures: isNoSuchProcess(error) ? [] : [error],
        platformTask: null,
      };
    }
  }

  const knownDescendants = descendantPids(pid);
  const failures: unknown[] = [];
  let platformTask: Promise<void> | null = null;
  if (platform === "win32") {
    try {
      const command = ["taskkill", "/PID", String(pid), "/T", "/F"];
      const spawned = Bun.spawn({ cmd: command, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
      platformTask = spawned.exited.then((code) => {
        if (code !== 0) throw new Error(`taskkill exited with code ${code}`);
      });
    } catch (error) {
      failures.push(error);
    }
  } else {
    try {
      // Detached isolates have pid == process-group id. A failed group signal
      // is tolerated only when the group is already gone.
      process.kill(-pid, signal as NodeJS.Signals);
    } catch (error) {
      if (!isNoSuchProcess(error)) failures.push(error);
    }
    failures.push(...signalDescendants(knownDescendants, signal));
  }
  try {
    processLike.kill(signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) failures.push(error);
  }
  return { knownDescendants, failures, platformTask };
}

function processStillRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

/**
 * Send a bounded tree termination signal. The returned promise confirms that
 * descendants observed before/during teardown have disappeared; callers still
 * need to confirm the direct process's exited promise.
 */
export async function terminateIsolateProcessTree(
  processLike: IsolateProcessLike,
  signal: IsolateProcessSignal = "SIGTERM",
  platform: string = process.platform,
): Promise<void> {
  const attempt = terminateGroupOrTree(processLike, signal, platform);
  if (attempt.failures.length > 0) {
    throw new Error(`Isolate process termination failed: ${attempt.failures.map(String).join("; ")}`);
  }
  if (attempt.platformTask) {
    await awaitBoundedSuccess(
      attempt.platformTask,
      TERMINATION_GRACE_MS,
      "Isolate platform tree termination",
    );
  }
  const deadline = Date.now() + TERMINATION_GRACE_MS;
  while (true) {
    const currentDescendants = descendantPids(Number(processLike.pid));
    const lateFailures = platform === "win32"
      ? []
      : signalDescendants(currentDescendants, signal);
    if (lateFailures.length > 0) {
      throw new Error(`Isolate descendant termination failed: ${lateFailures.map(String).join("; ")}`);
    }
    const knownStillRunning = attempt.knownDescendants.some(processStillRunning);
    if (currentDescendants.length === 0 && !knownStillRunning) return;
    if (Date.now() >= deadline) {
      throw new Error(`Isolate process descendants survived ${TERMINATION_GRACE_MS}ms termination grace`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}
class LengthPrefixedSubprocessTransport implements IsolateProcessTransport {
  readonly kind = "subprocess" as const;
  readonly pid: number | null;

  private readonly processLike: IsolateProcessLike;
  private readonly maxFrameBytes: number;
  private readonly decoder: LengthPrefixedFrameDecoder;
  private readonly messageHandlers = new Set<(message: unknown) => void>();
  private readonly errorHandlers = new Set<(error: unknown) => void>();
  private closed = false;
  private terminated = false;
  private errorEmitted = false;
  private pendingError: unknown = null;
  private exitObserved = false;
  private exitFailure: unknown = null;
  private terminationTask: Promise<void> | null = null;
  private readonly exitTask: Promise<void>;

  constructor(options: SpawnIsolateProcessOptions) {
    if (options.command.length === 0) {
      throw new TypeError("An isolate subprocess command is required");
    }
    this.maxFrameBytes = normalizeIsolateMaxFrameBytes(options.maxFrameBytes);
    this.decoder = new LengthPrefixedFrameDecoder(this.maxFrameBytes);
    const spawn = options.spawn ?? ((spawnOptions) => Bun.spawn(spawnOptions) as unknown as IsolateProcessLike);
    this.processLike = spawn({
      cmd: options.command,
      env: normalizeEnvironment({
        ...process.env,
        ...options.env,
        LUMIVERSE_ISOLATE_MAX_FRAME_BYTES: String(this.maxFrameBytes),
      }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      detached: process.platform !== "win32",
    });
    this.pid = Number.isInteger(this.processLike.pid) ? this.processLike.pid! : null;
    void this.readStdout();
    this.exitTask = this.watchExit();
  }

  async send(message: unknown): Promise<void> {
    if (this.closed) throw new Error("Isolate subprocess is closed");
    const stdin = this.processLike.stdin;
    if (!stdin) throw new Error("Isolate subprocess stdin is unavailable");
    const frame = preflightEncodedFrame(message, this.maxFrameBytes);
    try {
      await writeStdin(stdin, frame);
    } catch (error) {
      this.failTransport(error);
      throw error;
    }
  }

  onMessage(handler: (message: unknown) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onError(handler: (error: unknown) => void): () => void {
    this.errorHandlers.add(handler);
    const pendingError = this.pendingError;
    this.pendingError = null;
    if (pendingError !== null) {
      scheduleLowPriorityTask(() => handler(pendingError), { label: "isolate-process-error" });
    }
    return () => this.errorHandlers.delete(handler);
  }

  private async readStdout(): Promise<void> {
    const stdout = this.processLike.stdout;
    if (!stdout) {
      this.failTransport(new Error("Isolate subprocess stdout is unavailable"));
      return;
    }
    const reader = stdout.getReader();
    try {
      while (!this.closed) {
        const next = await reader.read();
        if (next.done) break;
        if (!next.value || next.value.byteLength === 0) continue;
        const frames = this.decoder.push(next.value);
        for (const frame of frames) {
          const message = decodeJsonFrame(frame);
          for (const handler of this.messageHandlers) handler(message);
        }
      }
      if (!this.closed) this.decoder.finish();
    } catch (error) {
      if (!this.closed) this.failTransport(error);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // The stream may already have released the lock after a process exit.
      }
    }
  }
  async terminate(signal: IsolateProcessSignal = "SIGTERM"): Promise<void> {
    if (this.terminationTask) return this.terminationTask;
    if (this.terminated) return;
    this.terminated = true;
    this.closed = true;
    const task = this.terminateOnce(signal);
    this.terminationTask = task;
    try {
      await task;
    } catch (error) {
      this.terminated = false;
      this.terminationTask = null;
      throw error;
    }
  }

  private async terminateOnce(signal: IsolateProcessSignal): Promise<void> {
    await cancelReadableBounded(this.processLike.stdout);
    let treeFailure: unknown = null;
    try {
      await terminateIsolateProcessTree(this.processLike, signal);
    } catch (error) {
      treeFailure = error;
    }

    const hasExitPromise = this.processLike.exited !== undefined;
    let exitedInGrace = hasExitPromise
      ? await waitBounded(this.exitTask, TERMINATION_GRACE_MS)
      : false;
    const requiresKill = treeFailure !== null
      || !exitedInGrace
      || !this.exitObserved
      || this.exitFailure !== null;
    let killFailure: unknown = null;
    if (requiresKill && signal !== "SIGKILL") {
      try {
        await terminateIsolateProcessTree(this.processLike, "SIGKILL");
      } catch (error) {
        killFailure = error;
      }
      exitedInGrace = hasExitPromise
        ? await waitBounded(this.exitTask, TERMINATION_GRACE_MS)
        : false;
    }

    const terminalTreeFailure = treeFailure !== null
      && !String(treeFailure).includes("descendants survived")
      ? treeFailure
      : null;
    if (terminalTreeFailure !== null || killFailure !== null) {
      throw new Error(
        `Isolate subprocess termination failed: ${[terminalTreeFailure, killFailure].filter(Boolean).map(String).join("; ")}`,
      );
    }
    if (!hasExitPromise || !exitedInGrace || !this.exitObserved) {
      throw new Error("Isolate subprocess exit was not confirmed within the termination grace");
    }
    if (this.exitFailure !== null) {
      throw new Error(`Isolate subprocess exit confirmation failed: ${String(this.exitFailure)}`);
    }
  }

  private async watchExit(): Promise<void> {
    const exited = this.processLike.exited;
    if (!exited) {
      this.exitFailure = new Error("Isolate subprocess does not expose an exit confirmation");
      return;
    }
    try {
      const code = await exited;
      this.exitObserved = true;
      if (!this.closed && code !== 0) {
        this.failTransport(new Error(`Isolate subprocess exited with code ${code}`));
      } else if (!this.closed && code === 0) {
        this.failTransport(new Error("Isolate subprocess exited before its job completed"));
      }
    } catch (error) {
      this.exitFailure = error;
      if (!this.closed) this.failTransport(error);
    }
  }

  private failTransport(error: unknown): void {
    if (this.errorEmitted) return;
    this.closed = true;
    this.emitError(error);
    void this.terminate("SIGKILL").catch(() => {});
  }

  private emitError(error: unknown): void {
    if (this.errorEmitted) return;
    this.errorEmitted = true;
    if (this.errorHandlers.size === 0) {
      this.pendingError = error;
      return;
    }
    for (const handler of this.errorHandlers) handler(error);
  }
}

export function createLengthPrefixedSubprocessTransport(
  options: SpawnIsolateProcessOptions,
): IsolateProcessTransport {
  return new LengthPrefixedSubprocessTransport(options);
}

export function resolveIsolateEntrypoint(pathOrUrl: string | URL): string {
  if (pathOrUrl instanceof URL) return fileURLToPath(pathOrUrl);
  return pathOrUrl;
}

export function defaultIsolateCommand(pathOrUrl: string | URL): string[] {
  const entry = resolveIsolateEntrypoint(pathOrUrl);
  if (process.env.LUMIVERSE_BUN_METHOD && process.env.LUMIVERSE_BUN_PATH) {
    return bunCmd(entry);
  }
  return [process.execPath, entry];
}

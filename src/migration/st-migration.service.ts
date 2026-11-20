import { join } from "node:path";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { FileConnectionConfig, FileSystem } from "../file-connections/types";
import { LocalFileSystem } from "../file-connections/providers/local";
import { openFileSystem } from "../file-connections/factory";
import { applyExternalDeferredImageProcessingStatus, setExternalThumbnailWorkActive } from "../services/images.service";
import { bunCmd } from "../utils/bun-cmd";
import type { HostToStMigration, StMigrationJob, StMigrationToHost } from "./st-ipc";
import type { MigrationLogger } from "./st-reader";
import { runStMigrationPipeline } from "./st-runner";
import type { MigrationResults, MigrationScope } from "./st-types";

export { importSTConnections } from "./st-connections";
export type { MigrationResults, MigrationScope } from "./st-types";

export interface MigrationProgressSnapshot {
  phase: string;
  label: string;
  current: number;
  total: number;
  updatedAt: number;
}

export interface MigrationLogSnapshot {
  level: "info" | "warn" | "error";
  message: string;
  timestamp: number;
}

interface MigrationState {
  migrationId: string;
  callerUserId: string;
  targetUserId: string;
  phase: string;
  startedAt: number;
  results: MigrationResults | null;
  error: string | null;
  completed: boolean;
  progress: MigrationProgressSnapshot | null;
  recentLogs: MigrationLogSnapshot[];
}

export interface IsolatedMigrationChild {
  send: (message: unknown) => void;
  kill: () => void;
}

export interface IsolatedSpawnOptions {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: "ignore";
  stdout: "inherit";
  stderr: "inherit";
  serialization: "advanced";
  ipc: (message: unknown) => void;
  onExit: (proc: IsolatedMigrationChild, exitCode: number | null, signalCode: number | null, error?: Error) => void;
}

export interface IsolatedLaunchDeps {
  spawn: (options: IsolatedSpawnOptions) => IsolatedMigrationChild;
  env: Record<string, string | undefined>;
}

const MAX_RECENT_LOGS = 200;
const PROGRESS_EMIT_INTERVAL_MS = 150;
const ISOLATED_READY_TIMEOUT_MS = 30_000;
const ST_MIGRATION_SUBPROCESS_STARTUP_ERROR_NAME = "StMigrationSubprocessStartupError";

const activeMigrations = new Map<string, MigrationState>();
let currentMigrationId: string | null = null;
let isolatedUnavailableReason: string | null = null;
let warnedIsolatedFallback = false;

const defaultFs = new LocalFileSystem();

export function getActiveMigration(): MigrationState | null {
  if (!currentMigrationId) return null;
  return activeMigrations.get(currentMigrationId) ?? null;
}

export function getLastMigration(): MigrationState | null {
  let latest: MigrationState | null = null;
  for (const state of activeMigrations.values()) {
    if (state.completed && (!latest || state.startedAt > latest.startedAt)) {
      latest = state;
    }
  }
  return latest;
}

export function isMigrationRunning(): boolean {
  return currentMigrationId !== null;
}

export function canUseIsolatedStMigration(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.LUMIVERSE_ST_MIGRATION_SUBPROCESS === "false") return false;
  if (isolatedUnavailableReason) return false;
  return true;
}

export function resetIsolatedStMigrationState(): void {
  isolatedUnavailableReason = null;
  warnedIsolatedFallback = false;
}

function warnIsolatedFallback(): void {
  if (warnedIsolatedFallback || canUseIsolatedStMigration()) return;
  warnedIsolatedFallback = true;
  if (process.env.LUMIVERSE_ST_MIGRATION_SUBPROCESS === "false") {
    console.warn("[st-migration] Isolated subprocess disabled via LUMIVERSE_ST_MIGRATION_SUBPROCESS=false; running in-process.");
    return;
  }
  if (isolatedUnavailableReason) {
    console.warn(`[st-migration] Isolated subprocess unavailable (${isolatedUnavailableReason}); running in-process.`);
  }
}

function appendLog(migrationId: string, level: MigrationLogSnapshot["level"], message: string): void {
  const state = activeMigrations.get(migrationId);
  if (!state) return;
  state.recentLogs.push({ level, message, timestamp: Date.now() });
  if (state.recentLogs.length > MAX_RECENT_LOGS) {
    state.recentLogs.splice(0, state.recentLogs.length - MAX_RECENT_LOGS);
  }
}

function createWsLogger(migrationId: string, callerUserId: string): MigrationLogger {
  let lastProgressEmit: MigrationProgressSnapshot | null = null;

  const updateProgress = (phase: string, label: string, current: number, total: number) => {
    const progress: MigrationProgressSnapshot = {
      phase,
      label,
      current,
      total,
      updatedAt: Date.now(),
    };
    const state = activeMigrations.get(migrationId);
    if (state) state.progress = progress;
    const shouldEmit = !lastProgressEmit
      || progress.phase !== lastProgressEmit.phase
      || progress.label !== lastProgressEmit.label
      || progress.current <= 1
      || progress.current >= progress.total
      || progress.updatedAt - lastProgressEmit.updatedAt >= PROGRESS_EMIT_INTERVAL_MS;
    if (!shouldEmit) return;
    lastProgressEmit = progress;
    eventBus.emit(EventType.MIGRATION_PROGRESS, {
      migrationId,
      phase: progress.phase,
      label: progress.label,
      current: progress.current,
      total: progress.total,
    }, callerUserId);
  };

  return {
    info(message: string) {
      appendLog(migrationId, "info", message);
      eventBus.emit(EventType.MIGRATION_LOG, { migrationId, level: "info", message }, callerUserId);
    },
    warn(message: string) {
      appendLog(migrationId, "warn", message);
      eventBus.emit(EventType.MIGRATION_LOG, { migrationId, level: "warn", message }, callerUserId);
    },
    error(message: string) {
      appendLog(migrationId, "error", message);
      eventBus.emit(EventType.MIGRATION_LOG, { migrationId, level: "error", message }, callerUserId);
    },
    progress(label: string, current: number, total: number) {
      const state = activeMigrations.get(migrationId);
      updateProgress(state?.phase ?? "unknown", label, current, total);
    },
  };
}

function beginMigrationState(
  migrationId: string,
  callerUserId: string,
  targetUserId: string,
): MigrationState {
  const state: MigrationState = {
    migrationId,
    callerUserId,
    targetUserId,
    phase: "starting",
    startedAt: Date.now(),
    results: null,
    error: null,
    completed: false,
    progress: null,
    recentLogs: [],
  };
  activeMigrations.set(migrationId, state);
  currentMigrationId = migrationId;
  return state;
}

function setMigrationPhase(state: MigrationState, phase: string): void {
  state.phase = phase;
  state.progress = {
    phase,
    label: phase,
    current: 0,
    total: 0,
    updatedAt: Date.now(),
  };
  eventBus.emit(EventType.MIGRATION_PROGRESS, {
    migrationId: state.migrationId,
    phase,
    label: phase,
    current: 0,
    total: 0,
  }, state.callerUserId);
}

function finishMigrationSuccess(
  state: MigrationState,
  results: MigrationResults,
  durationMs: number,
  logger: MigrationLogger,
): void {
  state.results = results;
  state.completed = true;
  state.phase = "completed";
  eventBus.emit(EventType.MIGRATION_COMPLETED, {
    migrationId: state.migrationId,
    durationMs,
    results,
  }, state.callerUserId);
  logger.info(`Migration complete in ${(durationMs / 1000).toFixed(1)}s`);
}

function finishMigrationFailure(state: MigrationState, errorMsg: string, logger: MigrationLogger): void {
  state.error = errorMsg;
  state.completed = true;
  state.phase = "failed";
  eventBus.emit(EventType.MIGRATION_FAILED, {
    migrationId: state.migrationId,
    error: errorMsg,
  }, state.callerUserId);
  logger.error(`Migration failed: ${errorMsg}`);
}

function emitCharacterLibraryChange(
  state: MigrationState,
  importedCharacterCount: number,
  characterImportAttempted: boolean,
): void {
  if (!characterImportAttempted) return;
  eventBus.emit(EventType.CHARACTER_LIBRARY_CHANGED, {
    reason: "sillytavern_migration",
    migrationId: state.migrationId,
    imported: importedCharacterCount,
  }, state.targetUserId);
}

async function disconnectRemoteFs(fs: FileSystem): Promise<void> {
  if (fs.type === "local") return;
  try { await fs.disconnect(); } catch { /* ignore */ }
}

export async function executeMigration(
  migrationId: string,
  callerUserId: string,
  targetUserId: string,
  dataDir: string,
  scope: MigrationScope,
  fs: FileSystem = defaultFs,
): Promise<void> {
  const startTime = Date.now();
  let importedCharacterCount = 0;
  let characterImportAttempted = false;
  const state = beginMigrationState(migrationId, callerUserId, targetUserId);
  const logger = createWsLogger(migrationId, callerUserId);

  try {
    const outcome = await runStMigrationPipeline(
      migrationId,
      targetUserId,
      dataDir,
      scope,
      logger,
      fs,
      { setPhase: (phase) => setMigrationPhase(state, phase) },
    );
    importedCharacterCount = outcome.importedCharacterCount;
    characterImportAttempted = outcome.characterImportAttempted;
    finishMigrationSuccess(state, outcome.results, Date.now() - startTime, logger);
  } catch (err: unknown) {
    finishMigrationFailure(state, err instanceof Error ? err.message : String(err), logger);
  } finally {
    emitCharacterLibraryChange(state, importedCharacterCount, characterImportAttempted);
    currentMigrationId = null;
    await disconnectRemoteFs(fs);
  }
}

function createStartupError(message: string): Error {
  const err = new Error(message);
  err.name = ST_MIGRATION_SUBPROCESS_STARTUP_ERROR_NAME;
  return err;
}

function isStartupError(err: unknown): err is Error {
  return err instanceof Error && err.name === ST_MIGRATION_SUBPROCESS_STARTUP_ERROR_NAME;
}

function defaultIsolatedSpawn(options: IsolatedSpawnOptions): IsolatedMigrationChild {
  return Bun.spawn(options);
}

async function runIsolatedMigration(job: StMigrationJob, deps?: IsolatedLaunchDeps): Promise<void> {
  const spawn = deps?.spawn ?? defaultIsolatedSpawn;
  const childEnv = deps?.env ?? process.env;
  const state = beginMigrationState(job.migrationId, job.callerUserId, job.targetUserId);
  const logger = createWsLogger(job.migrationId, job.callerUserId);
  const runtimePath = join(import.meta.dir, "st-migration-subprocess.ts");
  let settled = false;
  let importedCharacterCount = 0;
  let characterImportAttempted = false;
  let child: IsolatedMigrationChild | null = null;

  const settle = async (error?: string) => {
    if (settled) return;
    settled = true;
    setExternalThumbnailWorkActive(false);
    if (error) finishMigrationFailure(state, error, logger);
    emitCharacterLibraryChange(state, importedCharacterCount, characterImportAttempted);
    currentMigrationId = null;
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const readyTimer = setTimeout(() => {
        isolatedUnavailableReason = `did not become ready within ${ISOLATED_READY_TIMEOUT_MS}ms`;
        reject(createStartupError(isolatedUnavailableReason));
      }, ISOLATED_READY_TIMEOUT_MS);

      const spawnEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(childEnv)) {
        if (typeof value === "string") spawnEnv[key] = value;
      }
      spawnEnv.LUMIVERSE_ST_MIGRATION_CHILD = "1";
      setExternalThumbnailWorkActive(true);

      child = spawn({
        cmd: bunCmd(runtimePath),
        cwd: process.cwd(),
        env: spawnEnv,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
        serialization: "advanced",
        ipc(message) {
          if (!message || typeof message !== "object" || !("type" in message)) return;
          const payload = message as StMigrationToHost;
          if (payload.type === "ready") {
            clearTimeout(readyTimer);
            try {
              child?.send({ type: "start", job } satisfies HostToStMigration);
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
            return;
          }
          if (payload.type === "progress") {
            setMigrationPhase(state, payload.phase);
            logger.progress(payload.label, payload.current, payload.total);
            return;
          }
          if (payload.type === "log") {
            logger[payload.level](payload.message);
            return;
          }
          if (payload.type === "thumbnailQueue") {
            const status = {
              processed: payload.processed,
              remaining: payload.remaining,
              total: payload.total,
              active: payload.active,
              queued: payload.queued,
            };
            applyExternalDeferredImageProcessingStatus(status);
            eventBus.emit(EventType.IMAGE_THUMBNAIL_QUEUE, status);
            return;
          }
          if (payload.type === "done") {
            importedCharacterCount = payload.importedCharacterCount;
            characterImportAttempted = payload.characterImportAttempted;
            finishMigrationSuccess(state, payload.results, payload.durationMs, logger);
            void settle().then(() => resolve());
            return;
          }
          if (payload.type !== "failed") return;
          importedCharacterCount = payload.importedCharacterCount;
          characterImportAttempted = payload.characterImportAttempted;
          void settle(payload.error).then(() => resolve());
        },
        onExit(_proc, exitCode, signalCode, error) {
          if (settled) return;
          const detail = error?.message
            || `Isolated migration process exited (code=${exitCode ?? "null"}, signal=${signalCode ?? "null"})`;
          if (!state.completed) {
            isolatedUnavailableReason = detail;
            reject(createStartupError(detail));
            return;
          }
          void settle(detail).then(() => resolve());
        },
      });
    });
  } catch (err) {
    if (isStartupError(err)) {
      isolatedUnavailableReason = err.message;
      await settle();
      throw err;
    }
    await settle(err instanceof Error ? err.message : String(err));
  }
}

export async function startStMigration(
  migrationId: string,
  callerUserId: string,
  targetUserId: string,
  dataDir: string,
  scope: MigrationScope,
  connection: FileConnectionConfig = { type: "local" },
  fs?: FileSystem,
  deps?: IsolatedLaunchDeps,
): Promise<void> {
  const job: StMigrationJob = {
    migrationId,
    callerUserId,
    targetUserId,
    dataDir,
    scope,
    connection,
  };

  if (canUseIsolatedStMigration(deps?.env ?? process.env)) {
    try {
      await runIsolatedMigration(job, deps);
      return;
    } catch (err) {
      if (!isStartupError(err)) throw err;
      warnIsolatedFallback();
    }
  } else {
    warnIsolatedFallback();
  }

  if (fs) {
    await executeMigration(migrationId, callerUserId, targetUserId, dataDir, scope, fs);
    return;
  }
  if (connection.type === "local") {
    await executeMigration(migrationId, callerUserId, targetUserId, dataDir, scope);
    return;
  }
  const remoteFs = await openFileSystem(connection);
  await executeMigration(migrationId, callerUserId, targetUserId, dataDir, scope, remoteFs);
}

import type { Database } from "bun:sqlite";
import { existsSync, statSync, statfsSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname } from "node:path";
import { env } from "../env";

const MiB = 1024 * 1024;
const DEFAULT_DB_PATH = `${env.dataDir}/lumiverse.db`;
const DEFAULT_JOURNAL_SIZE_LIMIT_BYTES = 64 * MiB;
const DEFAULT_MONITOR_INTERVAL_MS = 60 * 60 * 1000;
const DB_TUNING_SETTINGS_KEY = "databaseTuning";
const DB_MAINTENANCE_SETTINGS_KEY = "databaseMaintenance";
const DB_MAINTENANCE_STATE_KEY = "databaseMaintenanceState";
const MIN_CACHE_BYTES = 32 * MiB;
const DEFAULT_CACHE_BYTES = 64 * MiB;
const MIN_MMAP_BYTES = 256 * MiB;

let monitorTimer: ReturnType<typeof setInterval> | null = null;

export type WalCheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

export interface DatabaseTuningSettings {
  cacheMemoryPercent?: number | null;
  mmapSizeBytes?: number | null;
}

export interface DatabaseStats {
  path: string;
  hostMemoryBytes: number;
  fileBytes: number;
  walBytes: number;
  shmBytes: number;
  totalOnDiskBytes: number;
  pageSize: number;
  pageCount: number;
  freelistCount: number;
  usedPageCount: number;
  logicalBytes: number;
  usedBytes: number;
  freeBytes: number;
  journalMode: string;
  synchronous: string;
  tempStore: string;
  mmapSize: number;
  cacheSize: number;
  cacheBytesApprox: number;
  walAutocheckpoint: number;
  journalSizeLimit: number;
  filesystemTotalBytes: number | null;
  filesystemFreeBytes: number | null;
  vacuumEstimatedRequiredBytes: number;
  vacuumHasEnoughFreeBytes: boolean | null;
}

export interface AppliedDatabaseTuning {
  settingsKey: string;
  settings: DatabaseTuningSettings;
  cacheMemoryPercent: number | null;
  cacheBytes: number;
  cacheSource: "auto" | "settings";
  mmapSizeBytes: number;
  mmapSource: "auto" | "settings" | "disabled";
  journalSizeLimitBytes: number;
}

export interface DatabaseMaintenanceResult {
  statsBefore: DatabaseStats;
  statsAfter: DatabaseStats;
  tuning: AppliedDatabaseTuning | null;
  checkpoint: Record<string, number> | null;
  optimized: boolean;
  analyzed: boolean;
  vacuumed: boolean;
  state: DatabaseMaintenanceState | null;
}

export interface DatabaseMaintenanceSettings {
  optimizeIntervalHours?: number | null;
  analyzeIntervalHours?: number | null;
  autoVacuumEnabled?: boolean;
  vacuumIntervalHours?: number | null;
  vacuumMinIdleMinutes?: number;
  vacuumRequireNoVisibleClients?: boolean;
  vacuumRequireNoActiveGenerations?: boolean;
  vacuumMinReclaimBytes?: number;
  vacuumMinReclaimPercent?: number;
  vacuumMinDbSizeBytes?: number;
  vacuumCheckpointMode?: WalCheckpointMode;
}

export interface DatabaseMaintenanceState {
  lastOptimizeAt?: number | null;
  lastAnalyzeAt?: number | null;
  lastVacuumAt?: number | null;
  lastAutoVacuumAttemptAt?: number | null;
  lastAutoVacuumSuccessAt?: number | null;
  lastAutoVacuumSkipReason?: string | null;
}

export class InsufficientDiskSpaceError extends Error {
  constructor(
    public readonly freeBytes: number | null,
    public readonly requiredBytes: number,
  ) {
    super(
      freeBytes == null
        ? `Unable to verify free disk space before VACUUM. Estimated requirement: ${formatBytes(requiredBytes)}.`
        : `Insufficient free disk space for VACUUM. Need about ${formatBytes(requiredBytes)}, have ${formatBytes(freeBytes)}.`
    );
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readFileSize(path: string): number {
  try {
    return existsSync(path) ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 100 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function readFilesystemBytes(path: string): { totalBytes: number | null; freeBytes: number | null } {
  try {
    const stats = statfsSync(dirname(path));
    const blockSize = Number((stats as { bsize?: number }).bsize ?? 0);
    const totalBlocks = Number((stats as { blocks?: number }).blocks ?? 0);
    const availableBlocks = Number((stats as { bavail?: number }).bavail ?? 0);
    if (blockSize > 0 && totalBlocks >= 0 && availableBlocks >= 0) {
      return {
        totalBytes: totalBlocks * blockSize,
        freeBytes: availableBlocks * blockSize,
      };
    }
  } catch {
    // Fall through to unknown values
  }
  return { totalBytes: null, freeBytes: null };
}

function estimateVacuumRequiredBytes(stats: Pick<DatabaseStats, "fileBytes" | "walBytes" | "logicalBytes" | "usedBytes">): number {
  const rewriteBytes = Math.max(stats.fileBytes, stats.logicalBytes, stats.usedBytes, MiB);
  return rewriteBytes + stats.walBytes + 128 * MiB;
}

export function ensureVacuumDiskHeadroom(stats: DatabaseStats): void {
  if (stats.vacuumHasEnoughFreeBytes === false) {
    throw new InsufficientDiskSpaceError(stats.filesystemFreeBytes, stats.vacuumEstimatedRequiredBytes);
  }
}

function getPragmaValue<T extends string | number>(db: Database, pragma: string): T {
  const row = db.query(`PRAGMA ${pragma}`).get() as Record<string, unknown> | null;
  const value = row ? Object.values(row)[0] : undefined;
  return value as T;
}

function normalizeSettings(raw: any): DatabaseTuningSettings {
  const next: DatabaseTuningSettings = {};
  if (!raw || typeof raw !== "object") return next;

  if (raw.cacheMemoryPercent == null) {
    next.cacheMemoryPercent = null;
  } else {
    const pct = Number(raw.cacheMemoryPercent);
    if (Number.isFinite(pct) && pct > 0) {
      next.cacheMemoryPercent = clamp(pct, 0.1, 50);
    }
  }

  if (raw.mmapSizeBytes == null) {
    next.mmapSizeBytes = null;
  } else {
    const mmap = Number(raw.mmapSizeBytes);
    if (Number.isFinite(mmap) && mmap >= 0) {
      next.mmapSizeBytes = Math.floor(mmap);
    }
  }

  return next;
}

function normalizeMaintenanceSettings(raw: any): DatabaseMaintenanceSettings {
  const next: DatabaseMaintenanceSettings = {
    optimizeIntervalHours: 12,
    analyzeIntervalHours: 72,
    autoVacuumEnabled: false,
    vacuumIntervalHours: 24,
    vacuumMinIdleMinutes: 15,
    vacuumRequireNoVisibleClients: true,
    vacuumRequireNoActiveGenerations: true,
    vacuumMinReclaimBytes: 256 * MiB,
    vacuumMinReclaimPercent: 15,
    vacuumMinDbSizeBytes: 1024 * MiB,
    vacuumCheckpointMode: "TRUNCATE",
  };
  if (!raw || typeof raw !== "object") return next;

  if (raw.optimizeIntervalHours == null) next.optimizeIntervalHours = null;
  else if (Number.isFinite(Number(raw.optimizeIntervalHours))) next.optimizeIntervalHours = Math.max(1, Math.floor(Number(raw.optimizeIntervalHours)));

  if (raw.analyzeIntervalHours == null) next.analyzeIntervalHours = null;
  else if (Number.isFinite(Number(raw.analyzeIntervalHours))) next.analyzeIntervalHours = Math.max(1, Math.floor(Number(raw.analyzeIntervalHours)));

  if (typeof raw.autoVacuumEnabled === "boolean") next.autoVacuumEnabled = raw.autoVacuumEnabled;

  if (raw.vacuumIntervalHours == null) next.vacuumIntervalHours = null;
  else if (Number.isFinite(Number(raw.vacuumIntervalHours))) next.vacuumIntervalHours = Math.max(1, Math.floor(Number(raw.vacuumIntervalHours)));

  if (Number.isFinite(Number(raw.vacuumMinIdleMinutes))) next.vacuumMinIdleMinutes = Math.max(1, Math.floor(Number(raw.vacuumMinIdleMinutes)));
  if (typeof raw.vacuumRequireNoVisibleClients === "boolean") next.vacuumRequireNoVisibleClients = raw.vacuumRequireNoVisibleClients;
  if (typeof raw.vacuumRequireNoActiveGenerations === "boolean") next.vacuumRequireNoActiveGenerations = raw.vacuumRequireNoActiveGenerations;
  if (Number.isFinite(Number(raw.vacuumMinReclaimBytes))) next.vacuumMinReclaimBytes = Math.max(0, Math.floor(Number(raw.vacuumMinReclaimBytes)));
  if (Number.isFinite(Number(raw.vacuumMinReclaimPercent))) next.vacuumMinReclaimPercent = clamp(Number(raw.vacuumMinReclaimPercent), 0, 100);
  if (Number.isFinite(Number(raw.vacuumMinDbSizeBytes))) next.vacuumMinDbSizeBytes = Math.max(0, Math.floor(Number(raw.vacuumMinDbSizeBytes)));
  if (typeof raw.vacuumCheckpointMode === "string") {
    const mode = raw.vacuumCheckpointMode.toUpperCase();
    if (["PASSIVE", "FULL", "RESTART", "TRUNCATE"].includes(mode)) {
      next.vacuumCheckpointMode = mode as WalCheckpointMode;
    }
  }

  return next;
}

function normalizeMaintenanceState(raw: any): DatabaseMaintenanceState {
  if (!raw || typeof raw !== "object") return {};
  const next: DatabaseMaintenanceState = {};
  for (const key of ["lastOptimizeAt", "lastAnalyzeAt", "lastVacuumAt", "lastAutoVacuumAttemptAt", "lastAutoVacuumSuccessAt"] as const) {
    const value = raw[key];
    if (value == null) next[key] = null;
    else if (Number.isFinite(Number(value))) next[key] = Math.floor(Number(value));
  }
  next.lastAutoVacuumSkipReason = typeof raw.lastAutoVacuumSkipReason === "string" ? raw.lastAutoVacuumSkipReason : null;
  return next;
}

function readJsonSetting(db: Database, userId: string | null | undefined, key: string): any {
  if (!userId) return null;
  const row = db.query("SELECT value FROM settings WHERE key = ? AND user_id = ?").get(key, userId) as { value: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

function writeJsonSetting(db: Database, userId: string | null | undefined, key: string, value: any): void {
  if (!userId) return;
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, JSON.stringify(value), userId, now);
}

export function getDatabaseTuningSettingKey(): string {
  return DB_TUNING_SETTINGS_KEY;
}

export function getDatabaseMaintenanceSettingKey(): string {
  return DB_MAINTENANCE_SETTINGS_KEY;
}

export function getDatabaseMaintenanceStateSettingKey(): string {
  return DB_MAINTENANCE_STATE_KEY;
}

export function getDatabasePathFallback(path?: string): string {
  return path || DEFAULT_DB_PATH;
}

export function applyBaseDatabasePragmas(db: Database): void {
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA synchronous = NORMAL");
  db.run(`PRAGMA cache_size = ${-Math.floor(DEFAULT_CACHE_BYTES / 1024)}`);
  db.run("PRAGMA temp_store = MEMORY");
  const isWindows = process.platform === "win32";
  db.run(`PRAGMA mmap_size = ${isWindows ? 0 : MIN_MMAP_BYTES}`);
  db.run("PRAGMA wal_autocheckpoint = 500");
  db.run(`PRAGMA journal_size_limit = ${DEFAULT_JOURNAL_SIZE_LIMIT_BYTES}`);
}

export function readDatabaseTuningSettings(db: Database, userId?: string | null): DatabaseTuningSettings {
  if (!userId) return {};
  try {
    const row = db
      .query("SELECT value FROM settings WHERE key = ? AND user_id = ?")
      .get(DB_TUNING_SETTINGS_KEY, userId) as { value: string } | null;
    return normalizeSettings(row ? JSON.parse(row.value) : null);
  } catch {
    return {};
  }
}

export function readDatabaseMaintenanceSettings(db: Database, userId?: string | null): DatabaseMaintenanceSettings {
  return normalizeMaintenanceSettings(readJsonSetting(db, userId, DB_MAINTENANCE_SETTINGS_KEY));
}

export function readDatabaseMaintenanceState(db: Database, userId?: string | null): DatabaseMaintenanceState {
  return normalizeMaintenanceState(readJsonSetting(db, userId, DB_MAINTENANCE_STATE_KEY));
}

export function writeDatabaseMaintenanceState(db: Database, userId: string | null | undefined, patch: Partial<DatabaseMaintenanceState>): DatabaseMaintenanceState | null {
  if (!userId) return null;
  const next = { ...readDatabaseMaintenanceState(db, userId) };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  writeJsonSetting(db, userId, DB_MAINTENANCE_STATE_KEY, next);
  return next;
}

export function collectDatabaseStats(db: Database, dbPath?: string): DatabaseStats {
  const path = getDatabasePathFallback(dbPath);
  const pageSize = Number(getPragmaValue<number>(db, "page_size")) || 4096;
  const pageCount = Number(getPragmaValue<number>(db, "page_count")) || 0;
  const freelistCount = Number(getPragmaValue<number>(db, "freelist_count")) || 0;
  const cacheSize = Number(getPragmaValue<number>(db, "cache_size")) || 0;
  const cacheBytesApprox = cacheSize < 0
    ? Math.abs(cacheSize) * 1024
    : cacheSize * pageSize;
  const fileBytes = readFileSize(path);
  const walBytes = readFileSize(`${path}-wal`);
  const shmBytes = readFileSize(`${path}-shm`);
  const usedPageCount = Math.max(pageCount - freelistCount, 0);
  const filesystem = readFilesystemBytes(path);
  const vacuumEstimatedRequiredBytes = estimateVacuumRequiredBytes({
    fileBytes,
    walBytes,
    logicalBytes: pageCount * pageSize,
    usedBytes: usedPageCount * pageSize,
  });

  return {
    path,
    hostMemoryBytes: totalmem(),
    fileBytes,
    walBytes,
    shmBytes,
    totalOnDiskBytes: fileBytes + walBytes + shmBytes,
    pageSize,
    pageCount,
    freelistCount,
    usedPageCount,
    logicalBytes: pageCount * pageSize,
    usedBytes: usedPageCount * pageSize,
    freeBytes: freelistCount * pageSize,
    journalMode: String(getPragmaValue<string>(db, "journal_mode") || "unknown"),
    synchronous: String(getPragmaValue<string>(db, "synchronous") || "unknown"),
    tempStore: String(getPragmaValue<string>(db, "temp_store") || "unknown"),
    mmapSize: Number(getPragmaValue<number>(db, "mmap_size")) || 0,
    cacheSize,
    cacheBytesApprox,
    walAutocheckpoint: Number(getPragmaValue<number>(db, "wal_autocheckpoint")) || 0,
    journalSizeLimit: Number(getPragmaValue<number>(db, "journal_size_limit")) || 0,
    filesystemTotalBytes: filesystem.totalBytes,
    filesystemFreeBytes: filesystem.freeBytes,
    vacuumEstimatedRequiredBytes,
    vacuumHasEnoughFreeBytes: filesystem.freeBytes == null ? null : filesystem.freeBytes >= vacuumEstimatedRequiredBytes,
  };
}

export function getLatestDatabaseWriteAt(dbPath?: string): number | null {
  const path = getDatabasePathFallback(dbPath);
  const candidates = [path, `${path}-wal`, `${path}-shm`]
    .map((candidate) => {
      try {
        return existsSync(candidate) ? statSync(candidate).mtimeMs : 0;
      } catch {
        return 0;
      }
    })
    .filter((value) => value > 0);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function computeCacheBytes(stats: DatabaseStats, settings: DatabaseTuningSettings): {
  bytes: number;
  percent: number | null;
  source: "auto" | "settings";
} {
  const hostBudgetMax = Math.max(MIN_CACHE_BYTES, Math.min(Math.floor(stats.hostMemoryBytes / 8), 1024 * MiB));
  if (typeof settings.cacheMemoryPercent === "number" && Number.isFinite(settings.cacheMemoryPercent)) {
    return {
      bytes: clamp(Math.floor(stats.hostMemoryBytes * (settings.cacheMemoryPercent / 100)), MIN_CACHE_BYTES, hostBudgetMax),
      percent: settings.cacheMemoryPercent,
      source: "settings",
    };
  }

  const autoTarget = Math.max(DEFAULT_CACHE_BYTES, Math.ceil(stats.usedBytes * 0.25));
  return {
    bytes: clamp(autoTarget, MIN_CACHE_BYTES, hostBudgetMax),
    percent: null,
    source: "auto",
  };
}

function computeMmapBytes(stats: DatabaseStats, settings: DatabaseTuningSettings): {
  bytes: number;
  source: "auto" | "settings" | "disabled";
} {
  if (process.platform === "win32") {
    return { bytes: 0, source: "disabled" };
  }

  if (typeof settings.mmapSizeBytes === "number" && Number.isFinite(settings.mmapSizeBytes)) {
    return { bytes: Math.max(0, Math.floor(settings.mmapSizeBytes)), source: "settings" };
  }

  const hostBudgetMax = Math.max(MIN_MMAP_BYTES, Math.min(Math.floor(stats.hostMemoryBytes / 4), 2 * 1024 * MiB));
  const autoTarget = Math.max(MIN_MMAP_BYTES, Math.ceil(Math.max(stats.logicalBytes, stats.fileBytes) * 2));
  return {
    bytes: clamp(autoTarget, MIN_MMAP_BYTES, hostBudgetMax),
    source: "auto",
  };
}

export function resolveDatabaseTuning(
  stats: DatabaseStats,
  db: Database,
  userId?: string | null,
): AppliedDatabaseTuning {
  const settings = readDatabaseTuningSettings(db, userId);
  const cache = computeCacheBytes(stats, settings);
  const mmap = computeMmapBytes(stats, settings);

  return {
    settingsKey: DB_TUNING_SETTINGS_KEY,
    settings,
    cacheMemoryPercent: cache.percent,
    cacheBytes: cache.bytes,
    cacheSource: cache.source,
    mmapSizeBytes: mmap.bytes,
    mmapSource: mmap.source,
    journalSizeLimitBytes: DEFAULT_JOURNAL_SIZE_LIMIT_BYTES,
  };
}

export function applyAdaptiveDatabasePragmas(
  db: Database,
  dbPath?: string,
  userId?: string | null,
): AppliedDatabaseTuning {
  const stats = collectDatabaseStats(db, dbPath);
  const tuning = resolveDatabaseTuning(stats, db, userId);

  db.run(`PRAGMA cache_size = ${-Math.max(1, Math.floor(tuning.cacheBytes / 1024))}`);
  db.run(`PRAGMA journal_size_limit = ${DEFAULT_JOURNAL_SIZE_LIMIT_BYTES}`);
  db.run(`PRAGMA mmap_size = ${tuning.mmapSizeBytes}`);

  return tuning;
}

export function logDatabaseStats(label: string, stats: DatabaseStats, tuning?: AppliedDatabaseTuning | null): void {
  const parts = [
    `[db] ${label}`,
    `file=${(stats.fileBytes / MiB).toFixed(1)}MiB`,
    `wal=${(stats.walBytes / MiB).toFixed(1)}MiB`,
    `pages=${stats.pageCount}`,
    `freelist=${stats.freelistCount}`,
    `cache~=${(stats.cacheBytesApprox / MiB).toFixed(1)}MiB`,
    `mmap=${(stats.mmapSize / MiB).toFixed(1)}MiB`,
  ];
  if (tuning) {
    parts.push(`cache_source=${tuning.cacheSource}`);
    parts.push(`mmap_source=${tuning.mmapSource}`);
  }
  console.log(parts.join(" "));
}

export function runStartupDatabaseMaintenance(
  db: Database,
  dbPath?: string,
  userId?: string | null,
): DatabaseMaintenanceResult {
  const statsBefore = collectDatabaseStats(db, dbPath);
  const tuning = applyAdaptiveDatabasePragmas(db, dbPath, userId);
  db.run("PRAGMA optimize");
  const state = writeDatabaseMaintenanceState(db, userId, { lastOptimizeAt: Date.now() });
  const statsAfter = collectDatabaseStats(db, dbPath);
  logDatabaseStats("startup", statsAfter, tuning);
  return {
    statsBefore,
    statsAfter,
    tuning,
    checkpoint: null,
    optimized: true,
    analyzed: false,
    vacuumed: false,
    state,
  };
}

export function runDatabaseMaintenance(
  db: Database,
  options: {
    dbPath?: string;
    userId?: string | null;
    optimize?: boolean;
    analyze?: boolean;
    vacuum?: boolean;
    refreshTuning?: boolean;
    checkpointMode?: WalCheckpointMode | null;
    autoVacuumSkipReason?: string | null;
  } = {},
): DatabaseMaintenanceResult {
  const statsBefore = collectDatabaseStats(db, options.dbPath);
  const tuning = options.refreshTuning ? applyAdaptiveDatabasePragmas(db, options.dbPath, options.userId) : null;
  const optimized = options.optimize !== false;
  const analyzed = options.analyze === true;
  const vacuumed = options.vacuum === true;

  let checkpoint: Record<string, number> | null = null;
  if (options.checkpointMode) {
    const row = db.query(`PRAGMA wal_checkpoint(${options.checkpointMode})`).get() as Record<string, unknown> | null;
    checkpoint = {};
    if (row) {
      for (const [key, value] of Object.entries(row)) {
        checkpoint[key] = Number(value) || 0;
      }
    }
  }

  if (vacuumed) {
    ensureVacuumDiskHeadroom(statsBefore);
    db.run("VACUUM");
  }
  if (analyzed) {
    db.run("ANALYZE");
  }
  if (optimized) {
    db.run("PRAGMA optimize");
  }

  const statsAfter = collectDatabaseStats(db, options.dbPath);
  const state = writeDatabaseMaintenanceState(db, options.userId, {
    lastOptimizeAt: optimized ? Date.now() : undefined,
    lastAnalyzeAt: analyzed ? Date.now() : undefined,
    lastVacuumAt: vacuumed ? Date.now() : undefined,
    lastAutoVacuumAttemptAt: options.autoVacuumSkipReason !== undefined || vacuumed ? Date.now() : undefined,
    lastAutoVacuumSuccessAt: vacuumed ? Date.now() : undefined,
    lastAutoVacuumSkipReason: options.autoVacuumSkipReason !== undefined ? options.autoVacuumSkipReason : undefined,
  });
  return {
    statsBefore,
    statsAfter,
    tuning,
    checkpoint,
    optimized,
    analyzed,
    vacuumed,
    state,
  };
}

export function startDatabaseMonitor(getDb: () => Database, dbPath?: string, intervalMs = DEFAULT_MONITOR_INTERVAL_MS): void {
  stopDatabaseMonitor();
  monitorTimer = setInterval(() => {
    try {
      logDatabaseStats("periodic", collectDatabaseStats(getDb(), dbPath));
    } catch (err) {
      console.warn("[db] Periodic stats probe failed:", err);
    }
  }, intervalMs);
}

export function stopDatabaseMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

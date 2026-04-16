import type { Database } from "bun:sqlite";
import {
  collectDatabaseStats,
  getLatestDatabaseWriteAt,
  readDatabaseMaintenanceSettings,
  readDatabaseMaintenanceState,
  runDatabaseMaintenance,
  type DatabaseMaintenanceSettings,
  type DatabaseMaintenanceState,
} from "./maintenance";
import { eventBus } from "../ws/bus";

const CHECK_INTERVAL_MS = 60 * 1000;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;

interface AutomaticTaskStatus {
  dueAt: number | null;
  isDue: boolean;
}

export interface AutomaticDatabaseMaintenanceStatus {
  settings: DatabaseMaintenanceSettings;
  state: DatabaseMaintenanceState;
  visibility: {
    totalSessions: number;
    visibleSessions: number;
    hiddenSessions: number;
    isVisible: boolean;
    allHiddenSince: number | null;
    hiddenIdleMinutes: number | null;
  };
  activeGenerationCount: number;
  operatorBusy: string | null;
  lastWriteAt: number | null;
  lastWriteIdleMinutes: number | null;
  reclaimableBytes: number;
  reclaimablePercent: number;
  optimize: AutomaticTaskStatus;
  analyze: AutomaticTaskStatus;
  vacuum: AutomaticTaskStatus & {
    eligible: boolean;
    blockedReasons: string[];
  };
}

function getDueAt(lastRunAt: number | null | undefined, intervalHours: number | null | undefined): number | null {
  if (!intervalHours || intervalHours <= 0) return null;
  return (lastRunAt ?? 0) + intervalHours * 60 * 60 * 1000;
}

export async function getAutomaticDatabaseMaintenanceStatus(
  db: Database,
  userId: string,
  dbPath: string,
  operatorBusy: string | null,
): Promise<AutomaticDatabaseMaintenanceStatus> {
  const now = Date.now();
  const settings = readDatabaseMaintenanceSettings(db, userId);
  const state = readDatabaseMaintenanceState(db, userId);
  const stats = collectDatabaseStats(db, dbPath);
  const visibility = eventBus.getUserVisibilitySnapshot(userId);
  const hiddenIdleMinutes = visibility.allHiddenSince == null ? null : Math.floor((now - visibility.allHiddenSince) / 60000);
  const lastWriteAt = getLatestDatabaseWriteAt(dbPath);
  const lastWriteIdleMinutes = lastWriteAt == null ? null : Math.floor((now - lastWriteAt) / 60000);
  const reclaimableBytes = stats.freeBytes;
  const reclaimablePercent = stats.logicalBytes > 0 ? (stats.freeBytes / stats.logicalBytes) * 100 : 0;
  const optimizeDueAt = getDueAt(state.lastOptimizeAt ?? null, settings.optimizeIntervalHours ?? null);
  const analyzeDueAt = getDueAt(state.lastAnalyzeAt ?? null, settings.analyzeIntervalHours ?? null);
  const vacuumDueAt = getDueAt(state.lastVacuumAt ?? null, settings.vacuumIntervalHours ?? null);
  const { getActiveGenerationCount } = await import("../services/generate.service");
  const activeGenerationCount = getActiveGenerationCount();

  const blockedReasons: string[] = [];
  if (!settings.autoVacuumEnabled) blockedReasons.push("auto vacuum disabled");
  if (operatorBusy) blockedReasons.push(`operator busy: ${operatorBusy}`);
  if (settings.vacuumRequireNoVisibleClients && visibility.isVisible) blockedReasons.push("visible client session active");
  if (settings.vacuumRequireNoActiveGenerations && activeGenerationCount > 0) blockedReasons.push("generation in progress");
  if (vacuumDueAt != null && now < vacuumDueAt) blockedReasons.push("vacuum interval not reached");
  if ((settings.vacuumMinDbSizeBytes ?? 0) > 0 && stats.logicalBytes < (settings.vacuumMinDbSizeBytes ?? 0)) blockedReasons.push("database below minimum size");
  if ((settings.vacuumMinReclaimBytes ?? 0) > 0 && reclaimableBytes < (settings.vacuumMinReclaimBytes ?? 0)) blockedReasons.push("reclaimable bytes below threshold");
  if ((settings.vacuumMinReclaimPercent ?? 0) > 0 && reclaimablePercent < (settings.vacuumMinReclaimPercent ?? 0)) blockedReasons.push("reclaimable percent below threshold");
  if (stats.vacuumHasEnoughFreeBytes === false) blockedReasons.push("insufficient free disk space for vacuum rewrite");
  if ((settings.vacuumMinIdleMinutes ?? 0) > 0) {
    if (hiddenIdleMinutes == null || hiddenIdleMinutes < (settings.vacuumMinIdleMinutes ?? 0)) blockedReasons.push("hidden idle timer not satisfied");
    if (lastWriteIdleMinutes != null && lastWriteIdleMinutes < (settings.vacuumMinIdleMinutes ?? 0)) blockedReasons.push("recent database writes detected");
  }

  return {
    settings,
    state,
    visibility: {
      ...visibility,
      hiddenIdleMinutes,
    },
    activeGenerationCount,
    operatorBusy,
    lastWriteAt,
    lastWriteIdleMinutes,
    reclaimableBytes,
    reclaimablePercent,
    optimize: {
      dueAt: optimizeDueAt,
      isDue: optimizeDueAt != null && now >= optimizeDueAt,
    },
    analyze: {
      dueAt: analyzeDueAt,
      isDue: analyzeDueAt != null && now >= analyzeDueAt,
    },
    vacuum: {
      dueAt: vacuumDueAt,
      isDue: vacuumDueAt != null && now >= vacuumDueAt,
      eligible: blockedReasons.length === 0,
      blockedReasons,
    },
  };
}

async function tick(
  getDb: () => Database,
  getUserId: () => string | null | undefined,
  getDbPath: () => string,
  getBusy: () => string | null,
  runOperation: (name: string, fn: () => Promise<any>) => Promise<any>,
): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const userId = getUserId();
    if (!userId) return;

    const db = getDb();
    const dbPath = getDbPath();
    const status = await getAutomaticDatabaseMaintenanceStatus(db, userId, dbPath, getBusy());

    if (status.vacuum.eligible) {
      await runOperation("database-auto-vacuum", async () => {
        return runDatabaseMaintenance(db, {
          dbPath,
          userId,
          refreshTuning: true,
          checkpointMode: status.settings.vacuumCheckpointMode ?? "TRUNCATE",
          vacuum: true,
          analyze: true,
          optimize: true,
        });
      });
      return;
    }

    if (status.analyze.isDue && !status.visibility.isVisible && status.activeGenerationCount === 0 && !getBusy()) {
      await runOperation("database-auto-analyze", async () => {
        return runDatabaseMaintenance(db, {
          dbPath,
          userId,
          analyze: true,
          optimize: true,
        });
      });
      return;
    }

    if (status.optimize.isDue && !getBusy()) {
      await runOperation("database-auto-optimize", async () => {
        return runDatabaseMaintenance(db, {
          dbPath,
          userId,
          optimize: true,
        });
      });
    }
  } catch (err) {
    const isConflict = err instanceof Error && /^Operation '.+' already in progress$/.test(err.message);
    if (!isConflict) {
      console.warn("[db] Automatic maintenance tick failed:", err);
    }
  } finally {
    schedulerRunning = false;
  }
}

export function startAutomaticDatabaseMaintenance(
  getDb: () => Database,
  getUserId: () => string | null | undefined,
  getDbPath: () => string,
  getBusy: () => string | null,
  runOperation: (name: string, fn: () => Promise<any>) => Promise<any>,
  intervalMs = CHECK_INTERVAL_MS,
): void {
  stopAutomaticDatabaseMaintenance();
  void tick(getDb, getUserId, getDbPath, getBusy, runOperation);
  schedulerTimer = setInterval(() => {
    void tick(getDb, getUserId, getDbPath, getBusy, runOperation);
  }, intervalMs);
}

export function stopAutomaticDatabaseMaintenance(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

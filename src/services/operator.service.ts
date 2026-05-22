import { RingBuffer } from "../utils/ring-buffer";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { env } from "../env";
import type { LogEntry, OperatorStatus, IPCMessage, OperatorIpcReason } from "../types/operator";
import { getDatabasePath, getDb } from "../db/connection";
import {
  collectDatabaseStats,
  getDatabaseMaintenanceSettingKey,
  getDatabaseMaintenanceStateSettingKey,
  getDatabaseTuningSettingKey,
  readDatabaseMaintenanceSettings,
  readDatabaseMaintenanceState,
  readDatabaseTuningSettings,
  resolveDatabaseTuning,
  runDatabaseMaintenance,
  type WalCheckpointMode,
} from "../db/maintenance";
import { getAutomaticDatabaseMaintenanceStatus } from "../db/maintenance-scheduler";

// ─── Git helpers (sync, lightweight) ────────────────────────────────────────

function gitSync(...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: import.meta.dir + "/../..",
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

function readVersion(): string {
  try {
    const pkg = require("../../package.json");
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Pending IPC request tracker ────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── OperatorService ────────────────────────────────────────────────────────

class OperatorService {
  readonly ipcAvailable: boolean;
  readonly ipcReason: OperatorIpcReason;
  private logBuffer: RingBuffer<LogEntry>;
  private pendingRequests = new Map<string, PendingRequest>();
  private readonly startedAt = Date.now();
  private logSubscribers = new Set<string>(); // userIds
  private batchPending: LogEntry[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private currentOperation: string | null = null;

  // Cached values that don't change during server lifetime
  private readonly version = readVersion();

  constructor() {
    const hasRunnerEnv = process.env.LUMIVERSE_RUNNER_IPC === "1";
    const hasProcessSend = typeof process.send === "function";
    this.ipcAvailable = hasRunnerEnv && hasProcessSend;
    this.ipcReason = this.ipcAvailable
      ? "connected"
      : hasRunnerEnv
        ? "runner_env_without_process_send"
        : "not_started_with_runner";

    this.logBuffer = new RingBuffer(150);

    if (this.ipcAvailable) {
      process.on("message", (msg: IPCMessage) => this.handleRunnerMessage(msg));
    }

    this.interceptConsole();
  }

  // ── Log capture ─────────────────────────────────────────────────────────

  private interceptConsole(): void {
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: any[]) => {
      origLog(...args);
      this.captureEntry("stdout", args);
    };
    console.warn = (...args: any[]) => {
      origWarn(...args);
      this.captureEntry("stderr", args);
    };
    console.error = (...args: any[]) => {
      origError(...args);
      this.captureEntry("stderr", args);
    };
  }

  private captureEntry(source: "stdout" | "stderr", args: any[]): void {
    const text = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ");
    const entry: LogEntry = { timestamp: Date.now(), source, text };
    this.logBuffer.push(entry);

    // Batch for WS streaming
    if (this.logSubscribers.size > 0) {
      this.batchPending.push(entry);
      if (!this.batchTimer) {
        this.batchTimer = setTimeout(() => this.flushLogBatch(), 200);
      }
    }
  }

  private flushLogBatch(): void {
    this.batchTimer = null;
    if (this.batchPending.length === 0) return;
    const entries = this.batchPending;
    this.batchPending = [];

    for (const userId of this.logSubscribers) {
      eventBus.emit(EventType.OPERATOR_LOG, { entries }, userId);
    }
  }

  // ── Log subscription ──────────────────────────────────────────────────

  subscribeLogs(userId: string): void {
    this.logSubscribers.add(userId);
  }

  unsubscribeLogs(userId: string): void {
    this.logSubscribers.delete(userId);
  }

  getLogs(limit: number): LogEntry[] {
    return this.logBuffer.last(limit);
  }

  setLogBufferSize(size: number): void {
    const clamped = Math.max(50, Math.min(2000, size));
    this.logBuffer.resize(clamped);
  }

  // ── Status ────────────────────────────────────────────────────────────

  getLocalStatus(): Omit<OperatorStatus, "updateAvailable" | "commitsBehind" | "latestUpdateMessage"> {
    return {
      port: env.port,
      pid: process.pid,
      uptime: Date.now() - this.startedAt,
      branch: gitSync("rev-parse", "--abbrev-ref", "HEAD") || "unknown",
      version: this.version,
      commit: gitSync("rev-parse", "--short", "HEAD") || "unknown",
      remoteMode: env.trustAnyOrigin,
      ipcAvailable: this.ipcAvailable,
      ipcReason: this.ipcReason,
    };
  }

  async getFullStatus(): Promise<OperatorStatus> {
    const local = this.getLocalStatus();
    // If IPC is available, ask runner for update info
    if (this.ipcAvailable) {
      try {
        const data = await this.sendToRunner("status", undefined, 10_000);
        return {
          ...local,
          updateAvailable: data?.updateAvailable ?? false,
          commitsBehind: data?.commitsBehind ?? 0,
          latestUpdateMessage: data?.latestUpdateMessage ?? "",
        };
      } catch {
        return { ...local, updateAvailable: false, commitsBehind: 0, latestUpdateMessage: "" };
      }
    }
    return { ...local, updateAvailable: false, commitsBehind: 0, latestUpdateMessage: "" };
  }

  async getDatabaseStatus(userId: string) {
    const db = getDb();
    const dbPath = getDatabasePath();
    const stats = collectDatabaseStats(db, dbPath);
    const configuredSettings = readDatabaseTuningSettings(db, userId);
    const maintenanceSettings = readDatabaseMaintenanceSettings(db, userId);
    const maintenanceState = readDatabaseMaintenanceState(db, userId);
    const effectiveTuning = resolveDatabaseTuning(stats, db, userId);
    const automaticMaintenance = await getAutomaticDatabaseMaintenanceStatus(db, userId, dbPath, this.busy);

    return {
      settingsKey: getDatabaseTuningSettingKey(),
      maintenanceSettingsKey: getDatabaseMaintenanceSettingKey(),
      maintenanceStateKey: getDatabaseMaintenanceStateSettingKey(),
      configuredSettings,
      maintenanceSettings,
      maintenanceState,
      effectiveTuning,
      stats,
      recommendation: {
        cacheMemoryPercent: effectiveTuning.cacheMemoryPercent,
        cacheBytes: effectiveTuning.cacheBytes,
        mmapSizeBytes: effectiveTuning.mmapSizeBytes,
      },
      automaticMaintenance,
    };
  }

  async maintainDatabase(
    userId: string,
    options: {
      optimize?: boolean;
      analyze?: boolean;
      vacuum?: boolean;
      refreshTuning?: boolean;
      checkpointMode?: WalCheckpointMode | null;
    }
  ) {
    return this.runOperation("database-maintenance", async () => {
      return runDatabaseMaintenance(getDb(), {
        dbPath: getDatabasePath(),
        userId,
        optimize: options.optimize,
        analyze: options.analyze,
        vacuum: options.vacuum,
        refreshTuning: options.refreshTuning,
        checkpointMode: options.checkpointMode,
      });
    });
  }

  // ── IPC bridge ────────────────────────────────────────────────────────

  async sendToRunner(type: string, payload?: any, timeoutMs = 120_000): Promise<any> {
    if (!this.ipcAvailable) {
      throw new Error("Runner IPC not available");
    }

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("IPC timeout"));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });
      process.send!({ type, id, payload });
    });
  }

  private handleRunnerMessage(msg: IPCMessage): void {
    if (!msg || !msg.type) return;

    if (msg.type === "response" && msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);
        const p = msg.payload as any;
        if (p?.success) {
          pending.resolve(p.data);
        } else {
          pending.reject(new Error(p?.error || "IPC request failed"));
        }
      }
      return;
    }

    if (msg.type === "progress" && msg.id) {
      const p = msg.payload as any;
      // Broadcast progress to all log subscribers
      for (const userId of this.logSubscribers) {
        eventBus.emit(EventType.OPERATOR_PROGRESS, {
          operation: p?.operation ?? "unknown",
          status: "in_progress",
          message: p?.message ?? "",
        }, userId);
      }
      return;
    }
  }

  // ── Operation mutex ───────────────────────────────────────────────────

  get busy(): string | null {
    return this.currentOperation;
  }

  async runOperation(name: string, fn: () => Promise<any>): Promise<any> {
    if (this.currentOperation) {
      throw new OperationConflictError(this.currentOperation);
    }
    this.currentOperation = name;
    try {
      // Broadcast start
      for (const userId of this.logSubscribers) {
        eventBus.emit(EventType.OPERATOR_PROGRESS, {
          operation: name,
          status: "in_progress",
          message: `Starting ${name}...`,
        }, userId);
      }
      const result = await fn();
      // Broadcast complete
      for (const userId of this.logSubscribers) {
        eventBus.emit(EventType.OPERATOR_PROGRESS, {
          operation: name,
          status: "complete",
          message: `${name} complete`,
        }, userId);
      }
      return result;
    } catch (err) {
      for (const userId of this.logSubscribers) {
        eventBus.emit(EventType.OPERATOR_PROGRESS, {
          operation: name,
          status: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        }, userId);
      }
      throw err;
    } finally {
      this.currentOperation = null;
    }
  }

  // ── IPC-backed operations ─────────────────────────────────────────────

  async checkUpdates(): Promise<{ available: boolean; commitsBehind: number; latestMessage: string }> {
    return this.sendToRunner("check-updates", undefined, 30_000);
  }

  async applyUpdate(): Promise<{ message: string }> {
    return this.runOperation("update", () =>
      this.sendToRunner("apply-update", undefined, 300_000)
    );
  }

  async switchBranch(target: string): Promise<{ message: string }> {
    return this.runOperation("branch-switch", () =>
      this.sendToRunner("switch-branch", { target }, 300_000)
    );
  }

  async toggleRemote(enable: boolean): Promise<{ enabled: boolean; message: string }> {
    return this.runOperation("remote-toggle", () =>
      this.sendToRunner("toggle-remote", { enable }, 30_000)
    );
  }

  async restart(): Promise<{ message: string }> {
    return this.runOperation("restart", () =>
      this.sendToRunner("restart", undefined, 15_000)
    );
  }

  async shutdown(): Promise<{ message: string }> {
    return this.sendToRunner("quit", undefined, 10_000);
  }

  async clearCache(): Promise<{ message: string }> {
    return this.sendToRunner("clear-cache", undefined, 60_000);
  }

  async ensureDependencies(): Promise<{ message: string }> {
    return this.sendToRunner("ensure-deps", undefined, 120_000);
  }

  async rebuildFrontend(): Promise<{ message: string }> {
    return this.runOperation("rebuild", () =>
      this.sendToRunner("rebuild-frontend", undefined, 300_000)
    );
  }

  // ── Cleanup ───────────────────────────────────────────────────────────

  cleanup(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.logSubscribers.clear();
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Service shutting down"));
    }
    this.pendingRequests.clear();
  }
}

export class OperationConflictError extends Error {
  constructor(public readonly currentOperation: string) {
    super(`Operation '${currentOperation}' already in progress`);
  }
}

export const operatorService = new OperatorService();

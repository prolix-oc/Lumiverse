import * as managerSvc from "./manager.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { createRuntimeTransport, type RuntimeTransport } from "./runtime-transport";
import type { SpindleManifest } from "lumiverse-spindle-types";
import { join, resolve, sep } from "path";

const MAX_BACKEND_PROCESSES = 16;
export type FrontendProcessState = "starting" | "running" | "stopping" | "stopped" | "completed" | "failed" | "timed_out";
export type BackendProcessState = FrontendProcessState;
type FrontendProcessExitReason = "completed" | "failed" | "stopped" | "timed_out" | "frontend_unloaded" | "backend_unloaded" | "replaced";
type BackendProcessExitReason = "completed" | "failed" | "stopped" | "timed_out" | "backend_unloaded" | "replaced";
type FrontendProcessInfo = { processId: string; kind: string; key?: string; state: FrontendProcessState; userId?: string; metadata?: Record<string, unknown>; startedAt: string; readyAt?: string; lastHeartbeatAt?: string; endedAt?: string; exitReason?: FrontendProcessExitReason; error?: string; };
type FrontendProcessRecord = FrontendProcessInfo & { requestId: string; startupTimer: ReturnType<typeof setTimeout> | null; heartbeatTimer: ReturnType<typeof setTimeout> | null; startupTimeoutMs: number; heartbeatTimeoutMs: number; stopReason?: string; };
type BackendProcessInfo = { processId: string; entry: string; kind: string; key?: string; state: BackendProcessState; userId?: string; metadata?: Record<string, unknown>; startedAt: string; readyAt?: string; lastHeartbeatAt?: string; endedAt?: string; exitReason?: BackendProcessExitReason; error?: string; };
type BackendProcessRecord = BackendProcessInfo & { requestId: string; runtime: RuntimeTransport; startupTimer: ReturnType<typeof setTimeout> | null; heartbeatTimer: ReturnType<typeof setTimeout> | null; stopTimer: ReturnType<typeof setTimeout> | null; startupTimeoutMs: number; heartbeatTimeoutMs: number; stopReason?: string; };
type BackendProcessRuntimeInit = { processId: string; entry: string; entryPath: string; kind: string; key?: string; payload?: unknown; metadata?: Record<string, unknown>; userId?: string; };
type HostToBackendProcessRuntime = { type: "init"; process: BackendProcessRuntimeInit } | { type: "stop"; reason?: string } | { type: "message"; payload: unknown };
type BackendProcessRuntimeToHost = { type: "ready" } | { type: "heartbeat" } | { type: "message"; payload: unknown } | { type: "complete" } | { type: "fail"; error: string } | { type: "stopped" };

export type WorkerHostProcessApiContext = {
  extensionId: string;
  manifest: SpindleManifest;
  installScope: "operator" | "user";
  installedByUserId: string | null;
  storageRootPath: () => string;
  post: (message: any) => void;
  resolve: (requestId: string, result: unknown) => void;
  reject: (requestId: string, error: unknown) => void;
};

/** Owns all managed frontend/backend process records, timers, and runtime handles. */
export class WorkerHostProcessApi {
  private frontendProcesses = new Map<string, FrontendProcessRecord>();
  private frontendProcessKeyIndex = new Map<string, string>();
  private backendProcesses = new Map<string, BackendProcessRecord>();
  private backendProcessKeyIndex = new Map<string, string>();

  constructor(private readonly context: WorkerHostProcessApiContext) {}

  private get extensionId(): string { return this.context.extensionId; }
  private get manifest(): SpindleManifest { return this.context.manifest; }
  private get installScope(): "operator" | "user" { return this.context.installScope; }
  private get installedByUserId(): string | null { return this.context.installedByUserId; }
  private postToWorker(message: any): void { this.context.post(message); }
  private resolveRequest(requestId: string, result: unknown): void { this.context.resolve(requestId, result); }
  private rejectRequest(requestId: string, error: unknown): void { this.context.reject(requestId, error); }
  private getStorageRootPath(_identifier?: string): string { return this.context.storageRootPath(); }

  private sendFrontendProcessEvent(userId: string, payload: Record<string, unknown>): void {
    eventBus.emit(EventType.SPINDLE_FRONTEND_PROCESS, { extensionId: this.extensionId, identifier: this.manifest.identifier, ...payload }, userId);
  }

  private resolveFrontendProcessUserId(userId?: string): string {
    if (this.installScope === "user") {
      if (!this.installedByUserId) {
        throw new Error("Extension owner is not set");
      }
      return this.installedByUserId;
    }

    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("userId is required when spawning a managed process");
    }

    return userId.trim();
  }

  private buildFrontendProcessKey(userId: string, kind: string, key: string): string {
    return `${userId}:${kind}:${key}`;
  }

  private snapshotFrontendProcess(record: FrontendProcessRecord): FrontendProcessInfo {
    return {
      processId: record.processId,
      kind: record.kind,
      ...(record.key ? { key: record.key } : {}),
      state: record.state,
      ...(record.userId ? { userId: record.userId } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      startedAt: record.startedAt,
      ...(record.readyAt ? { readyAt: record.readyAt } : {}),
      ...(record.lastHeartbeatAt ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}),
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      ...(record.exitReason ? { exitReason: record.exitReason } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private clearFrontendProcessTimers(record: FrontendProcessRecord): void {
    if (record.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
    if (record.heartbeatTimer) {
      clearTimeout(record.heartbeatTimer);
      record.heartbeatTimer = null;
    }
  }

  private emitFrontendProcessLifecycle(
    record: FrontendProcessRecord,
    previousState?: FrontendProcessState
  ): void {
    this.postToWorker({
      type: "frontend_process_lifecycle",
      event: {
        processId: record.processId,
        kind: record.kind,
        ...(record.key ? { key: record.key } : {}),
        ...(record.userId ? { userId: record.userId } : {}),
        state: record.state,
        ...(previousState ? { previousState } : {}),
        at: record.endedAt ?? record.lastHeartbeatAt ?? record.readyAt ?? record.startedAt,
        ...(record.exitReason ? { exitReason: record.exitReason } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(record.metadata ? { metadata: record.metadata } : {}),
      },
    });
  }

  private armFrontendHeartbeatTimer(record: FrontendProcessRecord): void {
    if (record.heartbeatTimeoutMs <= 0) return;
    if (record.heartbeatTimer) clearTimeout(record.heartbeatTimer);
    record.heartbeatTimer = setTimeout(() => {
      const latest = this.frontendProcesses.get(record.processId);
      if (!latest) return;
      this.requestFrontendProcessStop(latest, "timed_out");
      this.finalizeFrontendProcess(latest, "timed_out", "timed_out", "Frontend process heartbeat timed out");
    }, record.heartbeatTimeoutMs);
  }

  private requestFrontendProcessStop(record: FrontendProcessRecord, reason?: string): void {
    eventBus.emit(
      EventType.SPINDLE_FRONTEND_PROCESS,
      {
        extensionId: this.extensionId,
        identifier: this.manifest.identifier,
        action: "stop",
        processId: record.processId,
        ...(reason ? { reason } : {}),
      },
      record.userId,
    );
  }

  private transitionFrontendProcess(
    record: FrontendProcessRecord,
    nextState: FrontendProcessState,
    extras?: { readyAt?: string; lastHeartbeatAt?: string; endedAt?: string; exitReason?: FrontendProcessExitReason; error?: string }
  ): void {
    if (record.state === nextState && !extras) return;
    const previousState = record.state;
    record.state = nextState;
    if (extras?.readyAt) record.readyAt = extras.readyAt;
    if (extras?.lastHeartbeatAt) record.lastHeartbeatAt = extras.lastHeartbeatAt;
    if (extras?.endedAt) record.endedAt = extras.endedAt;
    if (extras?.exitReason) record.exitReason = extras.exitReason;
    if (extras && "error" in extras) {
      record.error = extras.error;
    }
    this.emitFrontendProcessLifecycle(record, previousState);
  }

  private finalizeFrontendProcess(
    record: FrontendProcessRecord,
    state: Extract<FrontendProcessState, "stopped" | "completed" | "failed" | "timed_out">,
    exitReason: FrontendProcessExitReason,
    error?: string,
  ): void {
    this.clearFrontendProcessTimers(record);
    this.transitionFrontendProcess(record, state, {
      endedAt: new Date().toISOString(),
      exitReason,
      ...(error ? { error } : { error: undefined }),
    });
    this.frontendProcesses.delete(record.processId);
    if (record.key) {
      this.frontendProcessKeyIndex.delete(
        this.buildFrontendProcessKey(record.userId ?? "", record.kind, record.key)
      );
    }
  }

  private getFrontendProcessRecord(processId: string): FrontendProcessRecord | null {
    return this.frontendProcesses.get(processId) ?? null;
  }

  private getFrontendProcessForUser(processId: string, userId: string): FrontendProcessRecord | null {
    const record = this.frontendProcesses.get(processId);
    if (!record) return null;
    if (record.userId && record.userId !== userId) return null;
    return record;
  }

  stopAllFrontendProcesses(exitReason: FrontendProcessExitReason): void {
    for (const record of Array.from(this.frontendProcesses.values())) {
      this.requestFrontendProcessStop(record, exitReason);
      this.clearFrontendProcessTimers(record);
      this.frontendProcesses.delete(record.processId);
      if (record.key) {
        this.frontendProcessKeyIndex.delete(
          this.buildFrontendProcessKey(record.userId ?? "", record.kind, record.key)
        );
      }
    }
  }

  private getBackendProcessRuntimeMode(): Extract<import("./runtime-transport").RuntimeTransportMode, "process" | "sandbox"> {
    const raw = process.env.LUMIVERSE_SPINDLE_RUNTIME_MODE?.trim().toLowerCase();
    return raw === "sandbox" ? "sandbox" : "process";
  }

  private buildBackendProcessKey(userId: string, kind: string, key: string): string {
    return `${userId}:${kind}:${key}`;
  }

  private snapshotBackendProcess(record: BackendProcessRecord): BackendProcessInfo {
    return {
      processId: record.processId,
      entry: record.entry,
      kind: record.kind,
      ...(record.key ? { key: record.key } : {}),
      state: record.state,
      ...(record.userId ? { userId: record.userId } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      startedAt: record.startedAt,
      ...(record.readyAt ? { readyAt: record.readyAt } : {}),
      ...(record.lastHeartbeatAt ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}),
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      ...(record.exitReason ? { exitReason: record.exitReason } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private clearBackendProcessTimers(record: BackendProcessRecord): void {
    if (record.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
    if (record.heartbeatTimer) {
      clearTimeout(record.heartbeatTimer);
      record.heartbeatTimer = null;
    }
    if (record.stopTimer) {
      clearTimeout(record.stopTimer);
      record.stopTimer = null;
    }
  }

  private emitBackendProcessLifecycle(
    record: BackendProcessRecord,
    previousState?: BackendProcessState
  ): void {
    this.postToWorker({
      type: "backend_process_lifecycle",
      event: {
        processId: record.processId,
        entry: record.entry,
        kind: record.kind,
        ...(record.key ? { key: record.key } : {}),
        ...(record.userId ? { userId: record.userId } : {}),
        state: record.state,
        ...(previousState ? { previousState } : {}),
        at: record.endedAt ?? record.lastHeartbeatAt ?? record.readyAt ?? record.startedAt,
        ...(record.exitReason ? { exitReason: record.exitReason } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(record.metadata ? { metadata: record.metadata } : {}),
      },
    });
  }

  private armBackendHeartbeatTimer(record: BackendProcessRecord): void {
    if (record.heartbeatTimeoutMs <= 0) return;
    if (record.heartbeatTimer) clearTimeout(record.heartbeatTimer);
    record.heartbeatTimer = setTimeout(() => {
      const latest = this.backendProcesses.get(record.processId);
      if (!latest) return;
      try {
        latest.runtime.terminate(true);
      } catch {
        // ignore
      }
      this.finalizeBackendProcess(latest, "timed_out", "timed_out", "Backend process heartbeat timed out");
    }, record.heartbeatTimeoutMs);
  }

  private armBackendStopTimer(record: BackendProcessRecord): void {
    if (record.stopTimer) clearTimeout(record.stopTimer);
    record.stopTimer = setTimeout(() => {
      const latest = this.backendProcesses.get(record.processId);
      if (!latest) return;
      try {
        latest.runtime.terminate(true);
      } catch {
        // ignore
      }
      this.finalizeBackendProcess(latest, "stopped", "stopped", "Backend process force-stopped after stop timeout");
    }, 5_000);
  }

  private transitionBackendProcess(
    record: BackendProcessRecord,
    nextState: BackendProcessState,
    extras?: { readyAt?: string; lastHeartbeatAt?: string; endedAt?: string; exitReason?: BackendProcessExitReason; error?: string }
  ): void {
    if (record.state === nextState && !extras) return;
    const previousState = record.state;
    record.state = nextState;
    if (extras?.readyAt) record.readyAt = extras.readyAt;
    if (extras?.lastHeartbeatAt) record.lastHeartbeatAt = extras.lastHeartbeatAt;
    if (extras?.endedAt) record.endedAt = extras.endedAt;
    if (extras?.exitReason) record.exitReason = extras.exitReason;
    if (extras && "error" in extras) {
      record.error = extras.error;
    }
    this.emitBackendProcessLifecycle(record, previousState);
  }

  private finalizeBackendProcess(
    record: BackendProcessRecord,
    state: Extract<BackendProcessState, "stopped" | "completed" | "failed" | "timed_out">,
    exitReason: BackendProcessExitReason,
    error?: string,
  ): void {
    this.clearBackendProcessTimers(record);
    this.transitionBackendProcess(record, state, {
      endedAt: new Date().toISOString(),
      exitReason,
      ...(error ? { error } : { error: undefined }),
    });
    this.backendProcesses.delete(record.processId);
    if (record.key) {
      this.backendProcessKeyIndex.delete(
        this.buildBackendProcessKey(record.userId ?? "", record.kind, record.key)
      );
    }
  }

  private getBackendProcessRecord(processId: string): BackendProcessRecord | null {
    return this.backendProcesses.get(processId) ?? null;
  }

  private async resolveBackendProcessEntryPath(entry: string): Promise<string> {
    const normalized = typeof entry === "string" ? entry.trim().replace(/\\/g, "/") : "";
    if (!normalized) throw new Error("entry is required");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("entry must be a relative path inside the extension repo");
    }
    if (!normalized.startsWith("dist/")) {
      throw new Error("backend process entries must live under dist/");
    }
    if (!/\.(?:cjs|mjs|js)$/.test(normalized)) {
      throw new Error("backend process entry must be a built JavaScript file");
    }

    const repoPath = managerSvc.getRepoPath(this.manifest.identifier);
    const repoAbs = resolve(repoPath);
    const entryPath = resolve(repoAbs, normalized);
    const insideRepo = entryPath === repoAbs || entryPath.startsWith(`${repoAbs}${sep}`);
    if (!insideRepo) {
      throw new Error(`Path traversal detected in backend process entry: ${entry}`);
    }
    if (!(await Bun.file(entryPath).exists())) {
      throw new Error(`Backend process entry not found: ${normalized}`);
    }

    const blocked = managerSvc.detectDangerousBackendCapabilities(
      await Bun.file(entryPath).text(),
      managerSvc.declaredCapabilitiesFromManifest(this.manifest),
    );
    if (blocked.length > 0) {
      throw new Error(
        `Backend process entry \"${normalized}\" uses blocked backend capabilities: ${blocked.join(", ")}`
      );
    }

    return entryPath;
  }

  handleBackendProcessRuntimeMessage(
    processId: string,
    message: BackendProcessRuntimeToHost
  ): void {
    const record = this.backendProcesses.get(processId);
    if (!record) return;

    switch (message.type) {
      case "ready": {
        if (record.state !== "starting") return;
        if (record.startupTimer) {
          clearTimeout(record.startupTimer);
          record.startupTimer = null;
        }
        const now = new Date().toISOString();
        this.transitionBackendProcess(record, "running", {
          readyAt: now,
          lastHeartbeatAt: now,
        });
        this.armBackendHeartbeatTimer(record);
        this.postToWorker({
          type: "response",
          requestId: record.requestId,
          result: this.snapshotBackendProcess(record),
        });
        return;
      }

      case "heartbeat": {
        if (record.state !== "running") return;
        const now = new Date().toISOString();
        this.transitionBackendProcess(record, "running", { lastHeartbeatAt: now });
        this.armBackendHeartbeatTimer(record);
        return;
      }

      case "message": {
        this.postToWorker({
          type: "backend_process_message",
          processId: record.processId,
          payload: message.payload,
          userId: record.userId ?? "",
        });
        return;
      }

      case "complete": {
        if (record.state === "starting") {
          this.rejectRequest(record.requestId, new Error("Backend process completed before it became ready"));
        }
        this.finalizeBackendProcess(record, "completed", "completed");
        return;
      }

      case "fail": {
        const error = message.error?.trim() || "Backend process failed";
        if (record.state === "starting") {
          this.rejectRequest(record.requestId, new Error(error));
        }
        this.finalizeBackendProcess(record, "failed", "failed", error);
        return;
      }

      case "stopped": {
        if (record.state === "starting") {
          this.rejectRequest(record.requestId, new Error("Backend process stopped before it became ready"));
        }
        this.finalizeBackendProcess(record, "stopped", "stopped");
        return;
      }
    }
  }

  handleBackendProcessRuntimeExit(
    processId: string,
    exitCode: number | null,
    signalCode: number | null,
    error?: Error,
  ): void {
    const record = this.backendProcesses.get(processId);
    if (!record) return;

    const details = error?.message || `Backend process exited (code=${exitCode ?? "null"}, signal=${signalCode ?? "null"})`;
    if (record.state === "starting") {
      this.rejectRequest(record.requestId, new Error(details));
      this.finalizeBackendProcess(record, "failed", "failed", details);
      return;
    }
    if (record.state === "stopping") {
      this.finalizeBackendProcess(record, "stopped", "stopped");
      return;
    }
    this.finalizeBackendProcess(record, "failed", "failed", details);
  }

  stopAllBackendProcesses(exitReason: BackendProcessExitReason): void {
    for (const record of Array.from(this.backendProcesses.values())) {
      this.clearBackendProcessTimers(record);
      try {
        record.runtime.terminate(true);
      } catch {
        // ignore
      }
      this.transitionBackendProcess(record, "stopped", {
        endedAt: new Date().toISOString(),
        exitReason,
      });
      this.backendProcesses.delete(record.processId);
      if (record.key) {
        this.backendProcessKeyIndex.delete(
          this.buildBackendProcessKey(record.userId ?? "", record.kind, record.key)
        );
      }
    }
  }

  handleFrontendProcessEvent(
    processId: string,
    userId: string,
    event: "ready" | "heartbeat" | "complete" | "fail" | "frontend_unloaded",
    error?: string,
  ): void {
    const record = this.getFrontendProcessForUser(processId, userId);
    if (!record) return;

    switch (event) {
      case "ready": {
        if (record.state !== "starting") return;
        const now = new Date().toISOString();
        if (record.startupTimer) {
          clearTimeout(record.startupTimer);
          record.startupTimer = null;
        }
        this.transitionFrontendProcess(record, "running", {
          readyAt: now,
          lastHeartbeatAt: now,
          error: undefined,
        });
        this.armFrontendHeartbeatTimer(record);
        this.resolveRequest(record.requestId, this.snapshotFrontendProcess(record));
        break;
      }
      case "heartbeat": {
        if (record.state !== "running" && record.state !== "stopping") return;
        const now = new Date().toISOString();
        record.lastHeartbeatAt = now;
        this.armFrontendHeartbeatTimer(record);
        break;
      }
      case "complete": {
        if (record.state === "completed" || record.state === "failed" || record.state === "timed_out" || record.state === "stopped") {
          return;
        }
        this.finalizeFrontendProcess(
          record,
          record.state === "stopping" ? "stopped" : "completed",
          record.state === "stopping" ? "stopped" : "completed",
        );
        break;
      }
      case "fail": {
        if (record.state === "completed" || record.state === "failed" || record.state === "timed_out" || record.state === "stopped") {
          return;
        }
        const message = error?.trim() || "Frontend process failed";
        if (record.state === "starting") {
          this.clearFrontendProcessTimers(record);
          this.finalizeFrontendProcess(record, "failed", "failed", message);
          this.rejectRequest(processId, new Error(message));
        } else {
          this.finalizeFrontendProcess(record, "failed", "failed", message);
        }
        break;
      }
      case "frontend_unloaded": {
        if (record.state === "starting") {
          const message = "Frontend extension unloaded before the process became ready";
          this.clearFrontendProcessTimers(record);
          this.finalizeFrontendProcess(record, "failed", "frontend_unloaded", message);
          this.rejectRequest(processId, new Error(message));
          return;
        }
        this.finalizeFrontendProcess(record, "stopped", "frontend_unloaded", error);
        break;
      }
    }
  }

  handleFrontendProcessMessage(processId: string, userId: string, payload: unknown): void {
    const record = this.getFrontendProcessForUser(processId, userId);
    if (!record) return;
    this.postToWorker({ type: "frontend_process_message", processId, payload, userId });
  }

  handleFrontendProcessSpawn(
    requestId: string,
    options: {
      kind: string;
      key?: string;
      payload?: unknown;
      metadata?: Record<string, unknown>;
      userId?: string;
      startupTimeoutMs?: number;
      heartbeatTimeoutMs?: number;
      replaceExisting?: boolean;
    }
  ): void {
    try {
      const kind = typeof options?.kind === "string" ? options.kind.trim() : "";
      if (!kind) throw new Error("kind is required");

      const userId = this.resolveFrontendProcessUserId(options?.userId);
      const processId = crypto.randomUUID();
      const key = typeof options?.key === "string" && options.key.trim() ? options.key.trim() : undefined;
      const startupTimeoutMs = Math.max(1_000, Math.min(120_000, Math.round(options?.startupTimeoutMs ?? 15_000)));
      const heartbeatTimeoutMs = Math.max(0, Math.min(120_000, Math.round(options?.heartbeatTimeoutMs ?? 15_000)));

      if (key) {
        const dedupeKey = this.buildFrontendProcessKey(userId, kind, key);
        const existingId = this.frontendProcessKeyIndex.get(dedupeKey);
        if (existingId) {
          const existing = this.frontendProcesses.get(existingId);
          if (existing) {
            if (!options?.replaceExisting) {
              throw new Error(`Frontend process already exists for kind \"${kind}\" and key \"${key}\"`);
            }
            this.requestFrontendProcessStop(existing, "replaced");
            if (existing.state === "starting") {
              this.rejectRequest(existing.requestId, new Error("Frontend process was replaced before it became ready"));
            }
            this.finalizeFrontendProcess(existing, "stopped", "replaced");
          }
        }
      }

      const record: FrontendProcessRecord = {
        requestId,
        processId,
        kind,
        ...(key ? { key } : {}),
        state: "starting",
        userId,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
        startedAt: new Date().toISOString(),
        startupTimer: null,
        heartbeatTimer: null,
        startupTimeoutMs,
        heartbeatTimeoutMs,
      };

      this.frontendProcesses.set(processId, record);
      if (key) {
        this.frontendProcessKeyIndex.set(
          this.buildFrontendProcessKey(userId, kind, key),
          processId
        );
      }

      this.emitFrontendProcessLifecycle(record);

      record.startupTimer = setTimeout(() => {
        const latest = this.frontendProcesses.get(processId);
        if (!latest || latest.state !== "starting") return;
        this.requestFrontendProcessStop(latest, "timed_out");
        this.finalizeFrontendProcess(latest, "timed_out", "timed_out", "Frontend process startup timed out");
        this.rejectRequest(requestId, new Error("Frontend process startup timed out"));
      }, startupTimeoutMs);

      this.sendFrontendProcessEvent(userId, {
        action: "spawn",
        processId,
        kind,
        ...(key ? { key } : {}),
        payload: options?.payload,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleFrontendProcessList(
    requestId: string,
    filter?: { userId?: string; kind?: string; key?: string; state?: FrontendProcessState }
  ): void {
    try {
      const userId =
        this.installScope === "user"
          ? this.installedByUserId ?? undefined
          : typeof filter?.userId === "string" && filter.userId.trim()
            ? filter.userId.trim()
            : undefined;
      const items = Array.from(this.frontendProcesses.values())
        .filter((record) => {
          if (userId && record.userId !== userId) return false;
          if (filter?.kind && record.kind !== filter.kind) return false;
          if (filter?.key && record.key !== filter.key) return false;
          if (filter?.state && record.state !== filter.state) return false;
          return true;
        })
        .map((record) => this.snapshotFrontendProcess(record));
      this.postToWorker({ type: "response", requestId, result: items });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleFrontendProcessGet(requestId: string, processId: string): void {
    try {
      const record = this.getFrontendProcessRecord(processId);
      this.postToWorker({
        type: "response",
        requestId,
        result: record ? this.snapshotFrontendProcess(record) : null,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleFrontendProcessStop(
    requestId: string,
    processId: string,
    options?: { userId?: string; reason?: string }
  ): void {
    try {
      const record = this.getFrontendProcessRecord(processId);
      if (!record) {
        this.postToWorker({ type: "response", requestId, result: undefined });
        return;
      }
      const resolvedUserId =
        this.installScope === "user"
          ? this.installedByUserId ?? undefined
          : typeof options?.userId === "string" && options.userId.trim()
            ? options.userId.trim()
            : undefined;
      if (resolvedUserId && record.userId !== resolvedUserId) {
        throw new Error("processId does not belong to the requested userId");
      }
      if (record.state === "starting" || record.state === "running") {
        record.stopReason = options?.reason;
        if (record.startupTimer) {
          clearTimeout(record.startupTimer);
          record.startupTimer = null;
        }
        this.transitionFrontendProcess(record, "stopping");
      }
      this.requestFrontendProcessStop(record, options?.reason ?? "stopped");
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleFrontendProcessSend(processId: string, payload: unknown, userId?: string): void {
    const record = this.getFrontendProcessRecord(processId);
    if (!record) return;
    if (this.installScope === "operator" && userId && record.userId !== userId) return;
    this.sendFrontendProcessEvent(record.userId ?? this.resolveFrontendProcessUserId(userId), {
      action: "message",
      processId,
      payload,
    });
  }

  async handleBackendProcessSpawn(
    requestId: string,
    options: {
      entry: string;
      kind?: string;
      key?: string;
      payload?: unknown;
      metadata?: Record<string, unknown>;
      userId?: string;
      startupTimeoutMs?: number;
      heartbeatTimeoutMs?: number;
      replaceExisting?: boolean;
    }
  ): Promise<void> {
    try {
      const entryPath = await this.resolveBackendProcessEntryPath(options?.entry ?? "");
      const entry = typeof options?.entry === "string" ? options.entry.trim().replace(/\\/g, "/") : "";
      const kind = typeof options?.kind === "string" && options.kind.trim() ? options.kind.trim() : entry;
      const userId = this.resolveFrontendProcessUserId(options?.userId);
      const processId = crypto.randomUUID();
      const key = typeof options?.key === "string" && options.key.trim() ? options.key.trim() : undefined;
      const startupTimeoutMs = Math.max(1_000, Math.min(120_000, Math.round(options?.startupTimeoutMs ?? 15_000)));
      const heartbeatTimeoutMs = Math.max(0, Math.min(120_000, Math.round(options?.heartbeatTimeoutMs ?? 15_000)));

      if (key) {
        const dedupeKey = this.buildBackendProcessKey(userId, kind, key);
        const existingId = this.backendProcessKeyIndex.get(dedupeKey);
        if (existingId) {
          const existing = this.backendProcesses.get(existingId);
          if (existing) {
            if (!options?.replaceExisting) {
              throw new Error(`Backend process already exists for kind \"${kind}\" and key \"${key}\"`);
            }
            if (existing.state === "starting") {
              this.rejectRequest(existing.requestId, new Error("Backend process was replaced before it became ready"));
            }
            this.clearBackendProcessTimers(existing);
            try {
              existing.runtime.terminate(true);
            } catch {
              // ignore
            }
            this.finalizeBackendProcess(existing, "stopped", "replaced");
          }
        }
      }

      if (this.backendProcesses.size >= MAX_BACKEND_PROCESSES) {
        throw new Error(`Backend process limit reached (${MAX_BACKEND_PROCESSES})`);
      }

      const runtimePath = join(import.meta.dir, "backend-process-runtime.ts");
      const storagePath = this.getStorageRootPath(this.manifest.identifier);
      const repoPath = managerSvc.getRepoPath(this.manifest.identifier);
      const runtime = createRuntimeTransport({
        runtimePath,
        extensionIdentifier: this.manifest.identifier,
        repoPath,
        storagePath,
        mode: this.getBackendProcessRuntimeMode(),
        onMessage: (message) => {
          this.handleBackendProcessRuntimeMessage(processId, message as BackendProcessRuntimeToHost);
        },
        onError: (message) => {
          const record = this.backendProcesses.get(processId);
          if (!record) return;
          this.finalizeBackendProcess(record, "failed", "failed", message);
        },
        onExit: (exitCode, signalCode, error) => {
          this.handleBackendProcessRuntimeExit(processId, exitCode, signalCode, error);
        },
      });

      const record: BackendProcessRecord = {
        requestId,
        runtime,
        processId,
        entry,
        kind,
        ...(key ? { key } : {}),
        state: "starting",
        userId,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
        startedAt: new Date().toISOString(),
        startupTimer: null,
        heartbeatTimer: null,
        stopTimer: null,
        startupTimeoutMs,
        heartbeatTimeoutMs,
      };

      this.backendProcesses.set(processId, record);
      if (key) {
        this.backendProcessKeyIndex.set(
          this.buildBackendProcessKey(userId, kind, key),
          processId
        );
      }

      this.emitBackendProcessLifecycle(record);

      record.startupTimer = setTimeout(() => {
        const latest = this.backendProcesses.get(processId);
        if (!latest || latest.state !== "starting") return;
        try {
          latest.runtime.terminate(true);
        } catch {
          // ignore
        }
        this.finalizeBackendProcess(latest, "timed_out", "timed_out", "Backend process startup timed out");
        this.rejectRequest(requestId, new Error("Backend process startup timed out"));
      }, startupTimeoutMs);

      runtime.postMessage({
        type: "init",
        process: {
          processId,
          entry,
          entryPath,
          kind,
          ...(key ? { key } : {}),
          payload: options?.payload,
          ...(options?.metadata ? { metadata: options.metadata } : {}),
          ...(userId ? { userId } : {}),
        },
      } satisfies HostToBackendProcessRuntime);
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleBackendProcessList(
    requestId: string,
    filter?: { userId?: string; kind?: string; key?: string; state?: BackendProcessState }
  ): void {
    try {
      const userId =
        this.installScope === "user"
          ? this.installedByUserId ?? undefined
          : typeof filter?.userId === "string" && filter.userId.trim()
            ? filter.userId.trim()
            : undefined;
      const items = Array.from(this.backendProcesses.values())
        .filter((record) => {
          if (userId && record.userId !== userId) return false;
          if (filter?.kind && record.kind !== filter.kind) return false;
          if (filter?.key && record.key !== filter.key) return false;
          if (filter?.state && record.state !== filter.state) return false;
          return true;
        })
        .map((record) => this.snapshotBackendProcess(record));
      this.postToWorker({ type: "response", requestId, result: items });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleBackendProcessGet(requestId: string, processId: string): void {
    try {
      const record = this.getBackendProcessRecord(processId);
      this.postToWorker({
        type: "response",
        requestId,
        result: record ? this.snapshotBackendProcess(record) : null,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleBackendProcessStop(
    requestId: string,
    processId: string,
    options?: { userId?: string; reason?: string }
  ): void {
    try {
      const record = this.getBackendProcessRecord(processId);
      if (!record) {
        this.postToWorker({ type: "response", requestId, result: undefined });
        return;
      }
      const resolvedUserId =
        this.installScope === "user"
          ? this.installedByUserId ?? undefined
          : typeof options?.userId === "string" && options.userId.trim()
            ? options.userId.trim()
            : undefined;
      if (resolvedUserId && record.userId !== resolvedUserId) {
        throw new Error("processId does not belong to the requested userId");
      }
      if (record.state === "starting" || record.state === "running") {
        record.stopReason = options?.reason;
        if (record.startupTimer) {
          clearTimeout(record.startupTimer);
          record.startupTimer = null;
        }
        this.transitionBackendProcess(record, "stopping");
        this.armBackendStopTimer(record);
      }
      record.runtime.postMessage({
        type: "stop",
        ...(options?.reason ? { reason: options.reason } : {}),
      } satisfies HostToBackendProcessRuntime);
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleBackendProcessSend(processId: string, payload: unknown, userId?: string): void {
    const record = this.getBackendProcessRecord(processId);
    if (!record) return;
    if (this.installScope === "operator" && userId && record.userId !== userId) return;
    record.runtime.postMessage({ type: "message", payload } satisfies HostToBackendProcessRuntime);
  }

}

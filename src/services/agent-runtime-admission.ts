import type { AgentRuntimeHostLimits } from "../types/agent-runtime";
import { getAgentRuntimeHostLimits } from "./agent-runtime-limits";

export type AgentAdmissionKind = "root" | "provider" | "tool";
export interface AgentAdmissionFailureContext { readonly code: "capacity_exceeded"; readonly kind: AgentAdmissionKind; readonly userId: string; readonly userLimit: number; readonly processLimit: number; readonly userObserved: number; readonly processObserved: number; }
export class AgentAdmissionFailure extends Error { readonly code = "capacity_exceeded" as const; readonly context: AgentAdmissionFailureContext; constructor(context: AgentAdmissionFailureContext) { super(`${context.kind} admission capacity exceeded`); this.name = "AgentAdmissionFailure"; this.context = Object.freeze({ ...context }); } }
export interface AgentAdmissionSnapshot { readonly rootsProcess: number; readonly providersProcess: number; readonly toolsProcess: number; readonly rootsByUser: Readonly<Record<string, number>>; readonly providersByUser: Readonly<Record<string, number>>; readonly toolsByUser: Readonly<Record<string, number>>; }
export class AgentAdmissionPermit {
  readonly id: string; readonly kind: AgentAdmissionKind; readonly userId: string; #released = false; readonly #releaseCallback: () => void;
  constructor(id: string, kind: AgentAdmissionKind, userId: string, releaseCallback: () => void) { this.id = id; this.kind = kind; this.userId = userId; this.#releaseCallback = releaseCallback; }
  get released(): boolean { return this.#released; }
  release(): void { if (this.#released) return; this.#released = true; this.#releaseCallback(); }
}

type UserCounts = Map<string, number>;
/** Synchronous process-wide check-and-increment admission accounting. */
export class AgentRuntimeAdmissionManager {
  readonly limits: AgentRuntimeHostLimits; #rootsProcess = 0; #providersProcess = 0; #toolsProcess = 0;
  readonly #rootsByUser: UserCounts = new Map(); readonly #providersByUser: UserCounts = new Map(); readonly #toolsByUser: UserCounts = new Map(); #nextPermit = 0; #lastFailure: AgentAdmissionFailure | null = null;
  constructor(limits: AgentRuntimeHostLimits = getAgentRuntimeHostLimits()) { this.limits = Object.freeze({ ...limits }); }
  get lastFailure(): AgentAdmissionFailure | null { return this.#lastFailure; }
  tryAcquireRoot(userId: string): AgentAdmissionPermit | null { return this.#tryAcquire("root", userId); }
  tryAcquireProvider(userId: string): AgentAdmissionPermit | null { return this.#tryAcquire("provider", userId); }
  tryAcquireTool(userId: string): AgentAdmissionPermit | null { return this.#tryAcquire("tool", userId); }
  acquireRoot(userId: string): AgentAdmissionPermit { return this.#require("root", userId); }
  acquireProvider(userId: string): AgentAdmissionPermit { return this.#require("provider", userId); }
  acquireTool(userId: string): AgentAdmissionPermit { return this.#require("tool", userId); }
  snapshot(): AgentAdmissionSnapshot { const record = (values: UserCounts): Readonly<Record<string, number>> => Object.freeze(Object.fromEntries(values)); return Object.freeze({ rootsProcess: this.#rootsProcess, providersProcess: this.#providersProcess, toolsProcess: this.#toolsProcess, rootsByUser: record(this.#rootsByUser), providersByUser: record(this.#providersByUser), toolsByUser: record(this.#toolsByUser) }); }
  resetForTests(): void { this.#rootsProcess = 0; this.#providersProcess = 0; this.#toolsProcess = 0; this.#rootsByUser.clear(); this.#providersByUser.clear(); this.#toolsByUser.clear(); this.#lastFailure = null; }
  #require(kind: AgentAdmissionKind, userId: string): AgentAdmissionPermit { const permit = this.#tryAcquire(kind, userId); if (!permit) throw this.#lastFailure ?? new AgentAdmissionFailure({ code: "capacity_exceeded", kind, userId, userLimit: 0, processLimit: 0, userObserved: 0, processObserved: 0 }); return permit; }
  #tryAcquire(kind: AgentAdmissionKind, rawUserId: string): AgentAdmissionPermit | null {
    const userId = typeof rawUserId === "string" && rawUserId.length > 0 ? rawUserId : "__anonymous__"; const { userMap, userLimit, processLimit, processValue } = this.#kindState(kind); const userObserved = userMap.get(userId) ?? 0;
    if (userObserved >= userLimit || processValue >= processLimit) { this.#lastFailure = new AgentAdmissionFailure({ code: "capacity_exceeded", kind, userId, userLimit, processLimit, userObserved, processObserved: processValue }); return null; }
    userMap.set(userId, userObserved + 1); this.#setProcess(kind, processValue + 1); this.#lastFailure = null; return new AgentAdmissionPermit(`${kind}-${this.#nextPermit++}`, kind, userId, () => this.#release(kind, userId));
  }
  #kindState(kind: AgentAdmissionKind): { userMap: UserCounts; userLimit: number; processLimit: number; processValue: number } { if (kind === "root") return { userMap: this.#rootsByUser, userLimit: this.limits.activeRootsPerUser, processLimit: this.limits.activeRootsProcess, processValue: this.#rootsProcess }; if (kind === "provider") return { userMap: this.#providersByUser, userLimit: this.limits.providerDispatchesPerUser, processLimit: this.limits.providerDispatchesProcess, processValue: this.#providersProcess }; return { userMap: this.#toolsByUser, userLimit: this.limits.toolExecutionsPerUser, processLimit: this.limits.toolExecutionsProcess, processValue: this.#toolsProcess }; }
  #setProcess(kind: AgentAdmissionKind, value: number): void { if (kind === "root") this.#rootsProcess = value; else if (kind === "provider") this.#providersProcess = value; else this.#toolsProcess = value; }
  #release(kind: AgentAdmissionKind, userId: string): void { const { userMap, processValue } = this.#kindState(kind); const current = userMap.get(userId) ?? 0; if (current <= 1) userMap.delete(userId); else userMap.set(userId, current - 1); this.#setProcess(kind, Math.max(0, processValue - 1)); }
}
export const AGENT_RUNTIME_ADMISSION_MANAGER = new AgentRuntimeAdmissionManager();
export const agentRuntimeAdmissionManager = AGENT_RUNTIME_ADMISSION_MANAGER;

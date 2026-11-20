import { AsyncLocalStorage } from "node:async_hooks";

import { getInferenceSchedulerConfig } from "./config";
import { normalizeEndpointOrigin } from "./origin";
import { resolveInferenceResource, type ResolvedInferenceResource } from "./resources";
import { isInferenceSchedulerHost } from "./runtime";
import { withLeaseAbort } from "./signals";
import {
  INFERENCE_CLASS_PRIORITY,
  InferencePreemptedError,
  InferenceQueueTimeoutError,
  type InferenceLease,
  type InferenceLeaseOptions,
  type InferenceRequestClass,
  type InferenceSchedulerConfig,
  type InferenceResourceSnapshot,
  type InferenceSchedulerStatus,
  type InferenceWaitingRequestSnapshot,
} from "./types";

interface LeaseScopeEntry {
  signal: AbortSignal;
  active: boolean;
}

const EMPTY_SCOPE: ReadonlyMap<string, LeaseScopeEntry> = new Map();
const MIN_AGED_PRIORITY = INFERENCE_CLASS_PRIORITY.retrieval;
const PREEMPTIBLE_MIN_PRIORITY = INFERENCE_CLASS_PRIORITY.background;
const MAX_RESOURCES = 256;
const IDLE_RESOURCE_TTL_MS = 60 * 60_000;

const leaseScope = new AsyncLocalStorage<ReadonlyMap<string, LeaseScopeEntry>>();
const neverAbortedSignal = new AbortController().signal;

interface ResourceStats {
  granted: number;
  completed: number;
  preempted: number;
  timedOut: number;
  aborted: number;
  lastWaitMs: number | null;
}

interface ResourceParticipant {
  label: string;
  local: boolean;
  stats: ResourceStats;
  updatedAt: number;
}

interface ActiveRecord {
  id: string;
  userId: string;
  requestClass: InferenceRequestClass;
  purpose: string;
  origin: string | null;
  startedAt: number;
  controller: AbortController;
  callerSignal?: AbortSignal;
  onCallerAbort: (() => void) | null;
}

interface WaiterRecord {
  id: string;
  userId: string;
  requestClass: InferenceRequestClass;
  purpose: string;
  origin: string | null;
  enqueuedAt: number;
  outerScope: ReadonlyMap<string, LeaseScopeEntry>;
  signal?: AbortSignal;
  onAbort: (() => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  resolve: (handoff: LeaseHandoff) => void;
  reject: (reason: unknown) => void;
}

interface ResourceState {
  key: string;
  concurrency: number;
  /**
   * Per-participant limits on a shared resource. The effective limit is the
   * smallest configured value so one account cannot raise another account's
   * concurrency by arriving later.
   */
  concurrencyByUser: Map<string, number>;
  active: ActiveRecord[];
  waiting: WaiterRecord[];
  participants: Map<string, ResourceParticipant>;
  lastUsedAt: number;
}

export interface LeaseHandoff {
  lease: InferenceLease;
  /** Held-resource keys for the async context that owns the lease. */
  context: ReadonlyMap<string, LeaseScopeEntry>;
}

const resources = new Map<string, ResourceState>();

let clock: () => number = () => Date.now();
let hostOverride: boolean | null = null;
let configOverride: InferenceSchedulerConfig | null = null;
let configByUserOverride: ReadonlyMap<string, InferenceSchedulerConfig> | null = null;
let changeListener: ((userIds: readonly string[]) => void) | null = null;

/**
 * Observe queue transitions. The notifier (imported only by the HTTP host)
 * debounces these into `INFERENCE_SCHEDULER_STATE` WebSocket events; worker
 * processes never register a listener.
 */
export function setInferenceSchedulerChangeListener(
  listener: ((userIds: readonly string[]) => void) | null,
): void {
  changeListener = listener;
}

function notifyChange(userIds: readonly string[]): void {
  if (!changeListener || userIds.length === 0) return;
  try {
    changeListener(userIds);
  } catch {
    // Diagnostics must never break request admission.
  }
}

function now(): number {
  return clock();
}

function isHost(): boolean {
  return hostOverride ?? isInferenceSchedulerHost();
}

function currentScope(): ReadonlyMap<string, LeaseScopeEntry> {
  return leaseScope.getStore() ?? EMPTY_SCOPE;
}

function configFor(userId: string): InferenceSchedulerConfig {
  return configByUserOverride?.get(userId) ?? configOverride ?? getInferenceSchedulerConfig(userId);
}

function newId(): string {
  return crypto.randomUUID();
}

function createResource(resolved: ResolvedInferenceResource, concurrency: number): ResourceState {
  pruneIdleResources();
  const resource: ResourceState = {
    key: resolved.key,
    concurrency,
    concurrencyByUser: new Map(),
    active: [],
    waiting: [],
    participants: new Map(),
    lastUsedAt: now(),
  };
  resources.set(resource.key, resource);
  return resource;
}

function updateResourceConcurrency(resource: ResourceState): void {
  let limit = Number.POSITIVE_INFINITY;
  for (const value of resource.concurrencyByUser.values()) {
    limit = Math.min(limit, value);
  }
  resource.concurrency = Number.isFinite(limit) ? Math.max(1, limit) : 1;
}

function noteParticipantConcurrency(
  resource: ResourceState,
  userId: string,
  concurrency: number,
  resolved: ResolvedInferenceResource,
): void {
  const participant = resource.participants.get(userId);
  if (participant) {
    participant.label = resolved.label;
    participant.local = resolved.local;
  } else {
    resource.participants.set(userId, {
      label: resolved.label,
      local: resolved.local,
      stats: { granted: 0, completed: 0, preempted: 0, timedOut: 0, aborted: 0, lastWaitMs: null },
      updatedAt: now(),
    });
  }
  resource.concurrencyByUser.set(userId, Math.max(1, Math.floor(concurrency)));
  updateResourceConcurrency(resource);
}

function releaseIdleParticipant(resource: ResourceState, userId: string): void {
  if (resource.active.some((active) => active.userId === userId)) return;
  if (resource.waiting.some((waiter) => waiter.userId === userId)) return;
  if (!resource.concurrencyByUser.delete(userId)) return;
  updateResourceConcurrency(resource);
}

function pruneIdleResources(): void {
  if (resources.size < MAX_RESOURCES) return;
  const cutoff = now() - IDLE_RESOURCE_TTL_MS;
  for (const [key, resource] of resources) {
    if (resource.active.length === 0 && resource.waiting.length === 0 && resource.lastUsedAt < cutoff) {
      resources.delete(key);
    }
  }
}

function getOrCreateResource(
  resolved: ResolvedInferenceResource,
  concurrency: number,
): ResourceState {
  const existing = resources.get(resolved.key);
  if (existing) return existing;
  return createResource(resolved, concurrency);
}

function effectivePriority(waiter: WaiterRecord, config: InferenceSchedulerConfig): number {
  const base = INFERENCE_CLASS_PRIORITY[waiter.requestClass];
  if (base <= MIN_AGED_PRIORITY || config.agingMs <= 0) return base;
  const steps = Math.floor(Math.max(0, now() - waiter.enqueuedAt) / config.agingMs);
  return Math.max(MIN_AGED_PRIORITY, base - steps);
}

function pickBestWaiter(
  resource: ResourceState,
  config: InferenceSchedulerConfig,
): WaiterRecord | null {
  let best: WaiterRecord | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;
  for (const waiter of resource.waiting) {
    const priority = effectivePriority(waiter, config);
    if (
      best === null
      || priority < bestPriority
      || (priority === bestPriority && waiter.enqueuedAt < best.enqueuedAt)
    ) {
      best = waiter;
      bestPriority = priority;
    }
  }
  return best;
}

function makeUnscheduledLease(
  requestClass: InferenceRequestClass,
  resourceKey: string | null,
  signal = neverAbortedSignal,
): InferenceLease {
  return {
    scheduled: false,
    resourceKey,
    requestClass,
    signal,
    waitedMs: 0,
    release() {},
  };
}

function cleanupWaiter(waiter: WaiterRecord): void {
  if (waiter.timer) {
    clearTimeout(waiter.timer);
    waiter.timer = null;
  }
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
}

function removeWaiter(resource: ResourceState, waiter: WaiterRecord): void {
  const index = resource.waiting.indexOf(waiter);
  if (index >= 0) resource.waiting.splice(index, 1);
}

function grantWaiter(
  resource: ResourceState,
  waiter: WaiterRecord,
): void {
  if (waiter.settled) return;
  waiter.settled = true;
  cleanupWaiter(waiter);
  removeWaiter(resource, waiter);

  const controller = new AbortController();
  const record: ActiveRecord = {
    id: waiter.id,
    userId: waiter.userId,
    requestClass: waiter.requestClass,
    purpose: waiter.purpose,
    origin: waiter.origin,
    startedAt: now(),
    controller,
    callerSignal: waiter.signal,
    onCallerAbort: null,
  };

  if (waiter.signal) {
    const callerSignal = waiter.signal;
    record.onCallerAbort = () => {
      controller.abort(callerSignal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    callerSignal.addEventListener("abort", record.onCallerAbort, { once: true });
  }

  resource.active.push(record);
  const participant = resource.participants.get(waiter.userId)!;
  participant.stats.granted += 1;
  const waitedMs = Math.max(0, now() - waiter.enqueuedAt);
  participant.stats.lastWaitMs = waitedMs;
  participant.updatedAt = now();
  resource.lastUsedAt = now();
  notifyChange([waiter.userId]);

  let released = false;
  const scopeEntry: LeaseScopeEntry = { signal: controller.signal, active: true };
  const lease: InferenceLease = {
    scheduled: true,
    resourceKey: resource.key,
    requestClass: waiter.requestClass,
    signal: controller.signal,
    waitedMs,
    release: () => {
      if (released) return;
      released = true;
      scopeEntry.active = false;
      if (record.callerSignal && record.onCallerAbort) {
        record.callerSignal.removeEventListener("abort", record.onCallerAbort);
      }
      const index = resource.active.indexOf(record);
      if (index >= 0) resource.active.splice(index, 1);
      participant.stats.completed += 1;
      participant.updatedAt = now();
      resource.lastUsedAt = now();
      releaseIdleParticipant(resource, record.userId);
      notifyChange([record.userId]);
      pumpResource(resource, configFor(record.userId));
    },
  };

  const context = new Map(waiter.outerScope);
  context.set(resource.key, scopeEntry);
  waiter.resolve({ lease, context });
}

function pickPreemptableActive(
  resource: ResourceState,
  requesterPriority: number,
): ActiveRecord | null {
  let target: ActiveRecord | null = null;
  let targetPriority = Number.NEGATIVE_INFINITY;
  for (const active of resource.active) {
    if (active.controller.signal.aborted) continue;
    const priority = INFERENCE_CLASS_PRIORITY[active.requestClass];
    if (priority < PREEMPTIBLE_MIN_PRIORITY) continue;
    if (priority <= requesterPriority) continue;
    if (
      target === null
      || priority > targetPriority
      || (priority === targetPriority && active.startedAt > target.startedAt)
    ) {
      target = active;
      targetPriority = priority;
    }
  }
  return target;
}

function maybePreempt(resource: ResourceState, config: InferenceSchedulerConfig): void {
  if (!config.preemptBackground) return;
  if (resource.active.length < resource.concurrency) return;
  const next = pickBestWaiter(resource, config);
  if (!next) return;

  const target = pickPreemptableActive(resource, INFERENCE_CLASS_PRIORITY[next.requestClass]);
  if (!target) return;

  const participant = resource.participants.get(target.userId)!;
  participant.stats.preempted += 1;
  participant.updatedAt = now();
  target.controller.abort(
    new InferencePreemptedError(
      `${target.purpose || target.requestClass} was preempted by a higher-priority request`,
    ),
  );
  notifyChange([target.userId]);
}

function pumpResource(resource: ResourceState, config: InferenceSchedulerConfig): void {
  while (resource.waiting.length > 0 && resource.active.length < resource.concurrency) {
    const waiter = pickBestWaiter(resource, config);
    if (!waiter) break;
    grantWaiter(resource, waiter);
  }
  maybePreempt(resource, config);
}

function resolveMaxWait(
  config: InferenceSchedulerConfig,
  requestClass: InferenceRequestClass,
  override: number | undefined,
): number {
  if (override !== undefined) return Math.max(0, Math.floor(override));
  if (requestClass === "interactive") return 0;
  return Math.max(0, config.maxWaitMs);
}

function enqueue(
  resource: ResourceState,
  config: InferenceSchedulerConfig,
  options: InferenceLeaseOptions,
  origin: string | null,
  requestClass: InferenceRequestClass,
): Promise<LeaseHandoff> {
  const outerScope = currentScope();
  const participant = resource.participants.get(options.userId)!;
  return new Promise<LeaseHandoff>((resolve, reject) => {
    const waiter: WaiterRecord = {
      id: newId(),
      userId: options.userId,
      requestClass,
      purpose: options.purpose?.slice(0, 120) || requestClass,
      origin,
      enqueuedAt: now(),
      outerScope,
      signal: options.signal,
      onAbort: null,
      timer: null,
      settled: false,
      resolve,
      reject,
    };

    const fail = (reason: unknown) => {
      if (waiter.settled) return;
      waiter.settled = true;
      cleanupWaiter(waiter);
      removeWaiter(resource, waiter);
      participant.updatedAt = now();
      releaseIdleParticipant(resource, waiter.userId);
      notifyChange([waiter.userId]);
      pumpResource(resource, config);
      reject(reason);
    };

    if (options.signal?.aborted) {
      fail(options.signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    if (options.signal) {
      const signal = options.signal;
      waiter.onAbort = () => {
        participant.stats.aborted += 1;
        fail(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    }

    const maxWaitMs = resolveMaxWait(config, requestClass, options.maxWaitMs);
    if (maxWaitMs > 0) {
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        participant.stats.timedOut += 1;
        fail(
          new InferenceQueueTimeoutError(
            `${waiter.purpose} waited ${maxWaitMs}ms for ${participant.label} and gave up`,
          ),
        );
      }, maxWaitMs);
    }

    resource.waiting.push(waiter);
    participant.updatedAt = now();
    pumpResource(resource, config);
  });
}

/**
 * Wait for a slot on the resource that owns `options.endpoint`.
 *
 * Never throws when scheduling is disabled, the endpoint is remote, or the
 * caller already holds the same resource in this async context.
 */
export async function acquireInferenceLease(options: InferenceLeaseOptions): Promise<LeaseHandoff> {
  const requestClass = options.requestClass ?? "background";
  const origin = normalizeEndpointOrigin(options.endpoint);
  if (!origin || !isHost()) {
    return { lease: makeUnscheduledLease(requestClass, null), context: currentScope() };
  }

  const config = configFor(options.userId);
  if (!config.enabled) {
    return { lease: makeUnscheduledLease(requestClass, null), context: currentScope() };
  }

  const resolved = resolveInferenceResource(config, origin);
  if (!resolved) {
    return { lease: makeUnscheduledLease(requestClass, null), context: currentScope() };
  }

  const scope = currentScope();
  const outerLease = scope.get(resolved.key);
  if (outerLease?.active) {
    // Nested call (e.g. a council tool call inside an active generation). The
    // outer lease already owns the slot; queueing again would deadlock.
    return { lease: makeUnscheduledLease(requestClass, resolved.key, outerLease.signal), context: scope };
  }

  const resource = getOrCreateResource(resolved, config.concurrency);
  noteParticipantConcurrency(resource, options.userId, config.concurrency, resolved);
  return enqueue(resource, config, options, origin, requestClass);
}

/**
 * Run `fn` while holding a slot on the resource that owns `options.endpoint`.
 * The slot is released when `fn` settles.
 */
export async function withInferenceLease<T>(
  options: InferenceLeaseOptions,
  fn: (lease: InferenceLease) => Promise<T>,
): Promise<T> {
  const handoff = await acquireInferenceLease(options);
  try {
    return await leaseScope.run(handoff.context, () => fn(handoff.lease));
  } finally {
    handoff.lease.release();
  }
}

/**
 * Wrap a provider stream so the slot is held through consumption and provider
 * cleanup. The factory is invoked after the slot is granted, so a queued
 * request does not open an HTTP connection early. An aborted lease or caller
 * must reject even when the provider ends its stream normally after an abort.
 *
 * Each pull of the inner stream runs inside the lease's async context so a
 * nested call (for example a tool round that starts another generation) reuses
 * the slot instead of deadlocking on it. The `yield` itself happens outside
 * that context, so the consumer's own work is not mistaken for a nested call.
 */
export async function* withInferenceLeaseStream<T>(
  options: InferenceLeaseOptions,
  factory: (lease: InferenceLease) => AsyncGenerator<T, void, unknown> | AsyncIterable<T>,
): AsyncGenerator<T, void, unknown> {
  const handoff = await acquireInferenceLease(options);
  let inner: AsyncIterator<T> | undefined;
  try {
    const signal = withLeaseAbort(options.signal, handoff.lease);
    signal.throwIfAborted();
    const iterator = leaseScope.run(handoff.context, () => factory(handoff.lease)[Symbol.asyncIterator]());
    inner = iterator;
    while (true) {
      signal.throwIfAborted();
      const step = await leaseScope.run(handoff.context, () => iterator.next());
      signal.throwIfAborted();
      if (step.done) return;
      yield step.value;
    }
  } finally {
    try {
      // Cleanup may perform nested work on this resource. Keep both the lease
      // and its context until the provider has closed its connection.
      await leaseScope.run(handoff.context, () => inner?.return?.(undefined));
    } finally {
      handoff.lease.release();
    }
  }
}

function snapshotResource(resource: ResourceState, userId: string): InferenceResourceSnapshot | null {
  const participant = resource.participants.get(userId);
  if (!participant) return null;
  const waiting: InferenceWaitingRequestSnapshot[] = resource.waiting
    .filter((waiter) => waiter.userId === userId)
    .map((waiter) => ({
      id: waiter.id,
      userId: waiter.userId,
      requestClass: waiter.requestClass,
      purpose: waiter.purpose,
      origin: waiter.origin,
      enqueuedAt: waiter.enqueuedAt,
      waitMs: Math.max(0, now() - waiter.enqueuedAt),
      effectivePriority: effectivePriority(waiter, configFor(userId)),
    }));

  return {
    key: resource.key,
    label: participant.label,
    local: participant.local,
    concurrency: resource.concurrency,
    active: resource.active
      .filter((active) => active.userId === userId)
      .map((active) => ({
        id: active.id,
        userId: active.userId,
        requestClass: active.requestClass,
        purpose: active.purpose,
        origin: active.origin,
        startedAt: active.startedAt,
        durationMs: Math.max(0, now() - active.startedAt),
      })),
    waiting,
    stats: { ...participant.stats },
    updatedAt: participant.updatedAt,
  };
}

export function getInferenceSchedulerStatus(userId: string): InferenceSchedulerStatus {
  const config = configFor(userId);
  const snapshots: InferenceResourceSnapshot[] = [];
  if (isHost()) {
    for (const resource of resources.values()) {
      const snapshot = snapshotResource(resource, userId);
      if (snapshot) snapshots.push(snapshot);
    }
  }
  snapshots.sort((left, right) => left.label.localeCompare(right.label));
  return {
    enabled: config.enabled,
    host: isHost(),
    resources: snapshots,
    updatedAt: now(),
  };
}

export function resetInferenceSchedulerForTests(): void {
  for (const resource of resources.values()) {
    for (const waiter of resource.waiting) cleanupWaiter(waiter);
  }
  resources.clear();
  hostOverride = null;
  configOverride = null;
  configByUserOverride = null;
  clock = () => Date.now();
}

export const __test__ = {
  setHost(value: boolean | null): void {
    hostOverride = value;
  },
  setConfig(config: InferenceSchedulerConfig | null): void {
    configOverride = config;
  },
  setConfigForUser(configs: ReadonlyMap<string, InferenceSchedulerConfig> | null): void {
    configByUserOverride = configs;
  },
  setClock(fn: (() => number) | null): void {
    clock = fn ?? (() => Date.now());
  },
  getResourceKeys(): string[] {
    return [...resources.keys()];
  },
  getActiveCount(key: string): number {
    return resources.get(key)?.active.length ?? 0;
  },
  reset(): void {
    resetInferenceSchedulerForTests();
  },
};

import { AsyncLocalStorage } from "node:async_hooks";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";

export type CortexRequestPhase = "queued" | "waiting" | "thinking" | "responding";
export interface CortexRequestActivity {
  id: string;
  batch: number | null;
  chunks: number;
  purpose: string;
  model?: string;
  phase: CortexRequestPhase;
  queuedAt: number;
  sentAt?: number;
  firstContentAt?: number;
  updatedAt: number;
}
export interface CortexActivity {
  id: string;
  chatId: string;
  kind: "rebuild" | "warmup" | "ingestion";
  status: "processing" | "complete" | "error" | "cancelled";
  phase: string;
  requestedAt: number;
  clientRequestedAt?: number;
  clientRequestId?: string;
  startedAt?: number;
  updatedAt: number;
  completedChunks: number;
  totalChunks: number;
  completedBatches: number;
  failedBatches: number;
  totalBatches: number;
  activeBatches: Array<{ batch: number; chunks: number; phase: string }>;
  requests: CortexRequestActivity[];
}
export interface CortexActivitySnapshot { chatId: string; revision: number; runs: CortexActivity[] }

type Context = { tracker: CortexActivityTracker; batch?: number; chunks?: number };
const context = new AsyncLocalStorage<Context>();
const chats = new Map<string, Map<string, CortexActivityTracker>>();
let revision = Date.now() * 1000;
const RETENTION_MS = 60_000;

export function getCortexActivity(chatId: string): CortexActivitySnapshot {
  return { chatId, revision,
    runs: [...(chats.get(chatId)?.values() ?? [])].map((tracker) => structuredClone(tracker.state)) };
}

export class CortexActivityTracker {
  readonly state: CortexActivity;
  private timer?: ReturnType<typeof setTimeout>;
  private retentionTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly userId: string, chatId: string, kind: CortexActivity["kind"],
    timing?: Pick<CortexActivity, "requestedAt" | "clientRequestedAt" | "clientRequestId">) {
    const now = Date.now();
    this.state = { id: crypto.randomUUID(), chatId, kind, status: "processing", phase: "queued",
      requestedAt: now, updatedAt: now, completedChunks: 0, totalChunks: 0,
      completedBatches: 0, failedBatches: 0, totalBatches: 0, activeBatches: [], requests: [], ...timing };
    const runs = chats.get(chatId) ?? new Map();
    runs.set(this.state.id, this);
    chats.set(chatId, runs);
    revision++;
    this.publish();
  }
  run<T>(work: () => Promise<T>): Promise<T> {
    this.patch({ startedAt: Date.now(), phase: "preparing" });
    return context.run({ tracker: this }, work);
  }
  patch(patch: Partial<CortexActivity>, throttle = false): void {
    if (this.state.status !== "processing") return;
    Object.assign(this.state, patch, { updatedAt: Date.now() });
    revision++;
    if (!throttle && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    // Content never leaves the request consumer. Activity is bounded to ten
    // snapshots per second even when many streams produce tokens concurrently.
    this.timer ??= setTimeout(() => { this.timer = undefined; this.publish(); }, throttle ? 100 : 0);
  }
  finish(status: CortexActivity["status"] = "complete"): void {
    if (this.state.status !== "processing") return;
    // Keep active work and the latest terminal run of each kind. A burst of
    // heuristic ingests must not grow every subsequent socket snapshot.
    const runs = chats.get(this.state.chatId);
    for (const [id, other] of runs ?? []) {
      if (other !== this && other.state.kind === this.state.kind && other.state.status !== "processing") {
        clearTimeout(other.retentionTimer);
        clearTimeout(other.timer);
        runs!.delete(id);
      }
    }
    this.patch({ status, requests: [], activeBatches: [] });
    this.publish();
    this.retentionTimer = setTimeout(() => {
      const runs = chats.get(this.state.chatId);
      runs?.delete(this.state.id);
      revision++;
      if (!runs?.size) { chats.delete(this.state.chatId); }
    }, RETENTION_MS);
    this.retentionTimer.unref?.();
  }
  private publish(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const chatId = this.state.chatId;
    eventBus.emit(EventType.CORTEX_ACTIVITY, getCortexActivity(chatId), this.userId);
  }
}

export async function withCortexActivity<T>(userId: string, chatId: string, kind: CortexActivity["kind"], work: () => Promise<T>): Promise<T> {
  const existing = context.getStore()?.tracker.state;
  if (existing?.chatId === chatId && existing.status === "processing") return work();
  const tracker = new CortexActivityTracker(userId, chatId, kind);
  try { const result = await tracker.run(work); tracker.finish(); return result; }
  catch (error) { tracker.finish("error"); throw error; }
}

export function updateCortexActivity(patch: Partial<CortexActivity>): void {
  context.getStore()?.tracker.patch(patch);
}

export function updateCortexBatchPhase(phase: string): void {
  const ctx = context.getStore();
  if (ctx?.tracker.state.kind === "ingestion") {
    ctx.tracker.patch({ phase, totalChunks: 1, completedChunks: phase === "complete" ? 1 : 0 });
  }
  if (!ctx?.batch) return;
  const batch = ctx.tracker.state.activeBatches.find((entry) => entry.batch === ctx.batch);
  if (batch) { batch.phase = phase; ctx.tracker.patch({}); }
}

export async function withCortexBatch<T>(batch: number, chunks: number, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const ctx = context.getStore();
  if (!ctx) return work();
  const tracker = ctx.tracker;
  tracker.state.activeBatches.push({ batch, chunks, phase: "preparing" });
  tracker.patch({});
  try {
    const result = await context.run({ tracker, batch, chunks }, work);
    if (!signal?.aborted) tracker.patch({ completedBatches: tracker.state.completedBatches + 1 });
    return result;
  } catch (error) {
    if (!signal?.aborted) tracker.patch({ failedBatches: tracker.state.failedBatches + 1 });
    throw error;
  } finally {
    tracker.patch({ activeBatches: tracker.state.activeBatches.filter((entry) => entry.batch !== batch) });
  }
}

/** One entry per actual attempt, including retries and fallback connections. */
export function trackCortexRequest(purpose: string, model?: string) {
  const ctx = context.getStore();
  const now = Date.now();
  const request: CortexRequestActivity = { id: crypto.randomUUID(), batch: ctx?.batch ?? null,
    chunks: ctx?.chunks ?? 1, purpose, model, phase: "queued", queuedAt: now, updatedAt: now };
  ctx?.tracker.state.requests.push(request);
  ctx?.tracker.patch({});
  let finished = false;
  return {
    phase(phase: CortexRequestPhase) {
      if (finished || !ctx || ctx.tracker.state.status !== "processing") return;
      const changed = request.phase !== phase;
      request.phase = phase;
      request.updatedAt = Date.now();
      if (phase === "waiting") request.sentAt ??= request.updatedAt;
      if (phase === "thinking" || phase === "responding") request.firstContentAt ??= request.updatedAt;
      ctx.tracker.patch({}, !changed);
    },
    finish() {
      if (finished || !ctx) return;
      finished = true;
      ctx.tracker.patch({ requests: ctx.tracker.state.requests.filter((entry) => entry.id !== request.id) });
    },
  };
}

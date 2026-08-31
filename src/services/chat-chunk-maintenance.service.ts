import {
  getDbGeneration,
  isDatabaseGenerationCancellation,
  raceDbGenerationCancellation,
} from "../db/connection";

const maintenanceTasks = new Map<string, Set<Promise<void>>>();
const failureLedger: MaintenanceFailureSummary[] = [];
const MAX_FAILURES_GLOBAL = 256;
const MAX_FAILURES_PER_CHAT = 16;

interface MaintenanceFailureSummary {
  chatId: string;
  name: string;
  message: string;
  occurredAt: number;
  omitted: number;
}

function summarizeFailure(chatId: string, reason: unknown): MaintenanceFailureSummary {
  const name = reason instanceof Error ? reason.name : "Error";
  const raw = reason instanceof Error ? reason.message : String(reason);
  return {
    chatId,
    name: name.slice(0, 80),
    message: raw.slice(0, 512),
    occurredAt: Date.now(),
    omitted: 0,
  };
}

function recordFailure(chatId: string, reason: unknown): void {
  if (isDatabaseGenerationCancellation(reason)) return;
  failureLedger.push(summarizeFailure(chatId, reason));
  const chatIndexes = failureLedger
    .map((entry, index) => entry.chatId === chatId ? index : -1)
    .filter((index) => index >= 0);
  if (chatIndexes.length > MAX_FAILURES_PER_CHAT) {
    const removed = failureLedger.splice(chatIndexes[0]!, 1)[0]!;
    const newest = [...failureLedger].reverse().find((entry) => entry.chatId === chatId);
    if (newest) newest.omitted += removed.omitted + 1;
  }
  while (failureLedger.length > MAX_FAILURES_GLOBAL) failureLedger.shift();
}

function consumeFailures(chatId?: string): MaintenanceFailureSummary[] {
  const consumed: MaintenanceFailureSummary[] = [];
  for (let index = failureLedger.length - 1; index >= 0; index -= 1) {
    if (chatId === undefined || failureLedger[index]!.chatId === chatId) {
      consumed.unshift(...failureLedger.splice(index, 1));
    }
  }
  return consumed;
}

function failureError(summary: MaintenanceFailureSummary): Error {
  const suffix = summary.omitted > 0 ? ` (${summary.omitted} earlier failures omitted)` : "";
  const error = new Error(`${summary.message}${suffix}`);
  error.name = summary.name;
  return error;
}

/**
 * Register work before any asynchronous boundary that can reach chat chunks,
 * vector storage, or the derived chat-memory cache. Settled tasks are always
 * removed; bounded summaries preserve failures until a barrier consumes them.
 */
export function trackChatChunkMaintenance(
  chatId: string,
  task: Promise<void>,
  generation = getDbGeneration(),
): Promise<void> {
  let tasks = maintenanceTasks.get(chatId);
  if (!tasks) {
    tasks = new Set();
    maintenanceTasks.set(chatId, tasks);
  }
  const tracked = raceDbGenerationCancellation(generation, task);
  tasks.add(tracked);

  void tracked.then(
    () => removeMaintenanceTask(chatId, tracked),
    (reason) => {
      removeMaintenanceTask(chatId, tracked);
      recordFailure(chatId, reason);
    },
  );
  return tracked;
}

function removeMaintenanceTask(chatId: string, task: Promise<void>): void {
  const tasks = maintenanceTasks.get(chatId);
  if (!tasks) return;
  tasks.delete(task);
  if (tasks.size === 0) maintenanceTasks.delete(chatId);
}

/** Wait until the selected maintenance graph is empty, then consume failures. */
export async function waitForChatChunkMaintenance(chatId?: string): Promise<void> {
  while (true) {
    const entries = chatId === undefined
      ? [...maintenanceTasks.entries()].flatMap(([id, tasks]) => [...tasks].map(task => [id, task] as const))
      : [...(maintenanceTasks.get(chatId) ?? [])].map(task => [chatId, task] as const);
    if (entries.length === 0) break;
    await Promise.allSettled(entries.map(([, task]) => task));
  }

  const failures = consumeFailures(chatId).map(failureError);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Chat chunk maintenance failed");
}

export const __test__ = {
  snapshot(): { pending: number; failures: number; perChatFailures: Record<string, number> } {
    const perChatFailures: Record<string, number> = {};
    for (const failure of failureLedger) {
      perChatFailures[failure.chatId] = (perChatFailures[failure.chatId] ?? 0) + 1;
    }
    return {
      pending: [...maintenanceTasks.values()].reduce((total, tasks) => total + tasks.size, 0),
      failures: failureLedger.length,
      perChatFailures,
    };
  },
};

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { CortexWarmJob, CortexWarmResult } from "./cortex-warm-worker";
import { abortAllBackgrounds, abortChatBackground } from "./chat-background.service";

const primed: unknown[][] = [];
const linkedPrimed: unknown[][] = [];
const fallbackQueries: unknown[][] = [];
let workerEnabled = true;
let retrieve: (job: CortexWarmJob) => Promise<CortexWarmResult>;
mock.module("./memory-cortex", () => ({
  primeCortexCache: (...args: unknown[]) => { primed.push(args); },
  primeLinkedCortexCache: (...args: unknown[]) => { linkedPrimed.push(args); },
  queryCortex: async (...args: unknown[]) => { fallbackQueries.push(args); },
  queryLinkedCortex: async (...args: unknown[]) => { fallbackQueries.push(args); },
}));
mock.module("./cortex-warm-worker-client", () => ({
  canUseCortexWorker: () => workerEnabled,
  warmCortexInWorker: (job: CortexWarmJob) => retrieve(job),
}));
const { scheduleCortexPromptWarm } = await import("./cortex-prompt-warm.service");
const result = { mainResult: { memories: [] }, linkedResult: { vaults: [], interlinks: [] } } as unknown as CortexWarmResult;
const job = {
  chatId: "chat", userId: "user", cortexConfig: {},
  mainQuery: { excludeMessageIds: ["live-message", "regen-target"] }, linkedQueryText: "query",
} as CortexWarmJob;

beforeEach(() => {
  primed.length = linkedPrimed.length = fallbackQueries.length = 0;
  workerEnabled = true;
  retrieve = async () => result;
});
afterEach(() => abortAllBackgrounds());

test("mirrors off-thread results into the host caches with the original exclusions", async () => {
  await scheduleCortexPromptWarm(job.userId, job.chatId, job);
  expect(primed).toEqual([[job.chatId, result.mainResult, job.mainQuery.excludeMessageIds]]);
  expect(linkedPrimed).toEqual([[job.chatId, result.linkedResult]]);
  expect(fallbackQueries).toHaveLength(0);
});

test.each(["generation", "chat"])("does not prime results after %s cancellation", async (source) => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<CortexWarmResult>();
  retrieve = () => { started.resolve(); return pending.promise; };
  const controller = new AbortController();
  const task = scheduleCortexPromptWarm(job.userId, job.chatId, job, controller.signal);
  await started.promise;
  let stopped: Promise<void> | undefined;
  if (source === "generation") controller.abort();
  else stopped = abortChatBackground(job.userId, job.chatId);
  pending.resolve(result);
  await task;
  await stopped;
  expect(primed).toHaveLength(0);
  expect(linkedPrimed).toHaveLength(0);
});

test("keeps the in-process retrieval fallback attached to the chat abort signal", async () => {
  workerEnabled = false;
  await scheduleCortexPromptWarm(job.userId, job.chatId, job);
  expect(fallbackQueries).toHaveLength(2);
  expect(fallbackQueries[0].slice(0, 2)).toEqual([job.mainQuery, job.cortexConfig]);
  expect(fallbackQueries[1].slice(0, 4)).toEqual([job.chatId, job.userId, job.cortexConfig, job.linkedQueryText]);
  expect(fallbackQueries[0][2]).toBeInstanceOf(AbortSignal);
  expect(fallbackQueries[1][4]).toBe(fallbackQueries[0][2]);
});

test("does not start preparing a job for an already cancelled generation", async () => {
  const controller = new AbortController();
  controller.abort();
  const prepare = mock(async () => job);
  await scheduleCortexPromptWarm(job.userId, job.chatId, prepare, controller.signal);
  expect(prepare).not.toHaveBeenCalled();
  expect(primed).toHaveLength(0);
});

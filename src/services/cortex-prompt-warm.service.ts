import * as memoryCortex from "./memory-cortex";
import { canUseCortexWorker, warmCortexInWorker } from "./cortex-warm-worker-client";
import type { CortexWarmJob } from "./cortex-warm-worker";
import { getChatBackgroundSignal, trackChatBackgroundTask } from "./chat-background.service";

/** Run on the host so warm results always reach the cache used for dispatch. */
async function warmCortexPromptContext(job: CortexWarmJob, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  if (canUseCortexWorker()) {
    try {
      const { mainResult, linkedResult } = await warmCortexInWorker(job);
      if (signal.aborted) return;
      if (mainResult) memoryCortex.primeCortexCache(job.chatId, mainResult, job.mainQuery.excludeMessageIds);
      if (linkedResult) memoryCortex.primeLinkedCortexCache(job.chatId, linkedResult);
      return;
    } catch (err) {
      if (signal.aborted) return;
      console.warn("[prompt-assembly] Cortex worker failed; falling back to in-process retrieval:", err);
    }
  }
  // The in-process fallback writes the same host caches itself.
  await Promise.all([
    memoryCortex.queryCortex(job.mainQuery, job.cortexConfig, signal),
    memoryCortex.queryLinkedCortex(job.chatId, job.userId, job.cortexConfig, job.linkedQueryText, signal),
  ]);
}

/** Accept a deferred preparation step or a completed assembly-worker handoff. */
export function scheduleCortexPromptWarm(
  userId: string,
  chatId: string,
  job: CortexWarmJob | ((signal: AbortSignal) => Promise<CortexWarmJob | undefined>),
  generationSignal?: AbortSignal,
): Promise<void> {
  const chatSignal = getChatBackgroundSignal(userId, chatId);
  const signal = generationSignal ? AbortSignal.any([generationSignal, chatSignal]) : chatSignal;
  const task = (async () => {
    if (signal.aborted) return;
    const resolved = typeof job === "function" ? await job(signal) : job;
    if (resolved && !signal.aborted) await warmCortexPromptContext(resolved, signal);
  })().catch((err) => {
    if (!signal.aborted) console.warn("[prompt-assembly] Background cortex query failed:", err);
  });
  trackChatBackgroundTask(userId, chatId, task);
  return task;
}

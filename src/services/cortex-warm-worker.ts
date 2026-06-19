/**
 * Cortex warm-cache worker (entry point).
 *
 * Runs the best-effort cortex retrieval that warms the per-chat result cache
 * for *subsequent* generations. This work — query embedding + LanceDB vector
 * search + Arrow marshaling + cross-chat linked retrieval — is CPU-bound and
 * its native LanceDB calls block whatever event loop they run on. Executing it
 * here keeps it off the main thread, where it would otherwise stall the WS
 * ping/pong handler long enough to trip the frontend's pong watchdog and flash
 * a spurious "server disconnected" overlay mid-generation.
 *
 * The worker computes the results and posts them back; the main process mirrors
 * them into its own warm cache via memoryCortex.primeCortexCache /
 * primeLinkedCortexCache (the in-worker cache writes are throwaway). See
 * cortex-warm-worker-client.ts for the host side.
 */
import { configureLanceDbNativeOverride } from "../lancedb-preflight";
import { initIdentity } from "../crypto/init";
import { initDatabase } from "../db/connection";
import type { CortexQuery, CortexResult, LinkedCortexResult } from "./memory-cortex/types";
import type { MemoryCortexConfig } from "./memory-cortex/config";

export type CortexWarmJob = {
  chatId: string;
  userId: string;
  cortexConfig: MemoryCortexConfig;
  /** Fully-resolved main retrieval query (queryText + emotionalContext built on the host). */
  mainQuery: CortexQuery;
  /** Query text reused for vault + interlink retrieval. */
  linkedQueryText: string;
};

export type CortexWarmResult = {
  mainResult: CortexResult | null;
  linkedResult: LinkedCortexResult | null;
};

type WarmRequest = {
  type: "warm";
  requestId: string;
  job: CortexWarmJob;
};

type WorkerResponse =
  | { type: "result"; requestId: string; result: CortexWarmResult }
  | { type: "error"; requestId: string; error: string; name?: string; stack?: string };

let initialized: Promise<void> | null = null;

function ensureInitialized(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      await configureLanceDbNativeOverride();
      await initIdentity();
      initDatabase();
    })();
  }
  return initialized;
}

async function handleWarm(message: WarmRequest): Promise<void> {
  await ensureInitialized();

  const memoryCortex = await import("./memory-cortex");
  const { job } = message;

  // Run main + linked retrieval in parallel, exactly as the original detached
  // task did. Each side fails soft: a thrown error or a timed-out result leaves
  // the corresponding cache untouched on the host instead of poisoning it.
  const [mainResult, linkedResult] = await Promise.all([
    memoryCortex
      .queryCortex(job.mainQuery, job.cortexConfig)
      .catch((err: unknown) => {
        console.warn("[cortex-worker] main query failed:", err);
        return null;
      }),
    memoryCortex
      .queryLinkedCortex(job.chatId, job.userId, job.cortexConfig, job.linkedQueryText)
      .catch((err: unknown) => {
        console.warn("[cortex-worker] linked query failed:", err);
        return null;
      }),
  ]);

  postMessage({
    type: "result",
    requestId: message.requestId,
    result: { mainResult, linkedResult },
  } satisfies WorkerResponse);
}

self.onmessage = (event: MessageEvent<WarmRequest>) => {
  const message = event.data;
  if (!message || message.type !== "warm") return;

  handleWarm(message).catch((err: any) => {
    postMessage({
      type: "error",
      requestId: message.requestId,
      error: err?.message || String(err),
      name: err?.name,
      stack: err?.stack,
    } satisfies WorkerResponse);
  });
};

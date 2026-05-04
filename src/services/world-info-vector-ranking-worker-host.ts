import {
  rankVectorWorldInfoCandidates,
  type VectorWorldInfoRankingInput,
  type VectorWorldInfoRankingResult,
} from "./world-info-vector-ranking";
import {
  shouldUseBunWorkers,
  warnBunWorkerFallback,
} from "../utils/bun-worker-guard";

type RankRequest = {
  type: "rank";
  requestId: string;
  payload: VectorWorldInfoRankingInput;
};

type RankResponse =
  | { type: "result"; requestId: string; result: VectorWorldInfoRankingResult }
  | { type: "error"; requestId: string; error: string };

export function rankVectorWorldInfoCandidatesInWorker(
  payload: VectorWorldInfoRankingInput,
  signal?: AbortSignal,
): Promise<VectorWorldInfoRankingResult> {
  if (!shouldUseBunWorkers()) {
    warnBunWorkerFallback("world-info vector ranking");
    return Promise.resolve(rankVectorWorldInfoCandidates(payload));
  }

  return new Promise<VectorWorldInfoRankingResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const requestId = crypto.randomUUID();
    const worker = new Worker(
      new URL("./world-info-vector-ranking-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      settle(() =>
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError")),
      );
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    worker.onmessage = (event: MessageEvent<RankResponse>) => {
      const message = event.data;
      if (!message || message.requestId !== requestId) return;
      if (message.type === "result") {
        settle(() => resolve(message.result));
      } else {
        settle(() => reject(new Error(message.error)));
      }
    };

    worker.onerror = (event) => {
      settle(() => reject(new Error(event.message || "Vector WI ranking worker failed")));
    };

    worker.postMessage({
      type: "rank",
      requestId,
      payload,
    } satisfies RankRequest);
  });
}

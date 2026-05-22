import { runHeuristicAnalysis } from "./heuristic-analysis";
import type { HeuristicWorkerRequest, HeuristicWorkerResponse } from "./heuristic-runtime";

self.onmessage = (event: MessageEvent<HeuristicWorkerRequest>) => {
  const msg = event.data;
  if (!msg || msg.type !== "run") return;

  try {
    const response: HeuristicWorkerResponse = {
      type: "result",
      requestId: msg.requestId,
      result: runHeuristicAnalysis(msg.payload),
    };
    self.postMessage(response);
  } catch (err) {
    const response: HeuristicWorkerResponse = {
      type: "error",
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : "Heuristic worker failed",
    };
    self.postMessage(response);
  }
};

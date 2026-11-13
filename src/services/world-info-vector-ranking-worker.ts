import {
  rankVectorWorldInfoCandidates,
  type VectorWorldInfoRankingInput,
  type VectorWorldInfoRankingResult,
} from "./world-info-vector-ranking";

type RankRequest = {
  type: "rank";
  requestId: string;
  payload: VectorWorldInfoRankingInput;
};

type RankResponse =
  | { type: "result"; requestId: string; result: VectorWorldInfoRankingResult }
  | { type: "error"; requestId: string; error: string };

self.onmessage = (event: MessageEvent<RankRequest>) => {
  const message = event.data;
  if (!message || message.type !== "rank") return;

  try {
    const response: RankResponse = {
      type: "result",
      requestId: message.requestId,
      result: rankVectorWorldInfoCandidates(message.payload),
    };
    self.postMessage(response);
  } catch (err) {
    const response: RankResponse = {
      type: "error",
      requestId: message.requestId,
      error: err instanceof Error ? err.message : "Vector WI ranking worker failed",
    };
    self.postMessage(response);
  }
};

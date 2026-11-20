import type { AssemblyContext, AssemblyResult } from "../llm/types";

export type AssemblyWorkerRequest =
  | { type: "assemble"; requestId: string; ctx: Omit<AssemblyContext, "signal" | "prefetched">; tokenizerRevision: number; resourceOwner: string }
  | { type: "warm-tokenizer"; requestId: string; modelId: string; tokenizerRevision: number; resourceOwner: string }
  | { type: "invalidate-tokenizer"; tokenizerId: string | null };

export type AssemblyWorkerResponse =
  | { type: "result"; requestId: string; result: AssemblyResult; tokenizerRevision: number; tokenizerIds: string[] }
  | { type: "tokenizer-warmed"; requestId: string; tokenizerRevision: number; tokenizerIds: string[] }
  | { type: "error"; requestId: string; error: string; name?: string; stack?: string };

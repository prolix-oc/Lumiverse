export interface RequestOrigin {
  sensitiveMedia?: boolean;
  kind: "chat" | "sidecar" | "extension" | "api";
  name: string;
  operation?: string;
  extensionId?: string;
}

/** Trusted caller context. Never read from a client request body or provider parameters. */
export interface GenerationCallOptions {
  origin?: RequestOrigin;
  chatId?: string;
  generationId?: string;
  /**
   * Local-inference scheduling class. Callers that run in the background
   * (sidecar extraction, summaries, extensions) pass a lower-priority class so
   * interactive chat can preempt them.
   */
  leaseClass?: import("../services/inference-scheduler/types").InferenceRequestClass;
  /** Short diagnostics label for the scheduler queue entry. */
  leasePurpose?: string;
}

export interface ProviderRequestSnapshot {
  body: BodyInit | null | undefined;
  provider: string;
  model: string;
  credentials: readonly string[];
}

export const PROVIDER_RESPONSE_MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface ProviderResponseSnapshot {
  body: string | null;
  bodyBytes: number;
  outcome: "complete" | "interrupted" | "cancelled" | "failed";
  bodyUnavailable?: "too_large" | "unavailable";
  error?: string;
}

export interface ProviderResponseObserver {
  isActive(): boolean;
  headers(status: number): void;
  complete(snapshot: ProviderResponseSnapshot): void;
}

export type ProviderRequestObserver = (snapshot: ProviderRequestSnapshot) => ProviderResponseObserver | void;

export interface ProviderRequestCapture {
  observer?: ProviderRequestObserver;
  provider: string;
  model: string;
  credentials?: readonly string[];
}

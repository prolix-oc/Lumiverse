/**
 * Local-inference admission scheduling.
 *
 * The scheduler serializes requests that share one physical inference resource
 * (a GPU/box) so background work — memory-cortex sidecar extraction, chat-chunk
 * embedding, image generation — cannot pile up on the same VRAM at once while a
 * user is waiting on a chat response.
 *
 * Classes are ordered from most to least urgent. They are advisory: a caller
 * picks the class that describes who is waiting for the result.
 */
export type InferenceRequestClass =
  | "interactive"
  | "user"
  | "retrieval"
  | "background"
  | "bulk";

export const INFERENCE_REQUEST_CLASSES: readonly InferenceRequestClass[] = [
  "interactive",
  "user",
  "retrieval",
  "background",
  "bulk",
] as const;

/** Effective priority numbers; lower runs first. */
export const INFERENCE_CLASS_PRIORITY: Readonly<Record<InferenceRequestClass, number>> = {
  interactive: 0,
  user: 1,
  retrieval: 2,
  background: 3,
  bulk: 4,
};

export interface InferenceLeaseOptions {
  userId: string;
  /**
   * Endpoint the request will contact (full URL or origin). `null`, an empty
   * string, a non-HTTP URL, or a non-local endpoint leaves the request
   * unscheduled.
   */
  endpoint?: string | null;
  requestClass?: InferenceRequestClass;
  /** Short, non-sensitive label shown in diagnostics (e.g. "memory-cortex"). */
  purpose?: string;
  signal?: AbortSignal;
  /** Override the configured maximum queue wait. 0 waits indefinitely. */
  maxWaitMs?: number;
}

export interface InferenceLease {
  /** False when no scheduling happened (disabled, remote endpoint, or nested lease). */
  readonly scheduled: boolean;
  readonly resourceKey: string | null;
  readonly requestClass: InferenceRequestClass;
  /**
   * Aborts when a higher-priority request preempts this lease. Combine it with
   * the caller's own signal so an aborted background request stops its HTTP
   * work instead of holding the resource.
   */
  readonly signal: AbortSignal;
  /** Time spent waiting in the queue before the lease was granted. */
  readonly waitedMs: number;
  release(): void;
}

export interface InferenceSchedulerConfig {
  /** Master switch. Disabled leaves every request on its pre-scheduler path. */
  enabled: boolean;
  /**
   * Serialize every detected local endpoint into one queue. Disable to give
   * each endpoint origin its own queue, then use `groups` to merge only the
   * endpoints that really share hardware.
   */
  unifiedLocalPool: boolean;
  /** Treat RFC1918 / IPv6 ULA / mDNS hosts as local. Loopback is always local. */
  schedulePrivateNetwork: boolean;
  /** Extra origins to schedule even when they are not detected as local. */
  extraOrigins: string[];
  /** Origins that must never be scheduled. Wins over every other rule. */
  excludedOrigins: string[];
  /** Named pools that merge specific origins, regardless of `unifiedLocalPool`. */
  groups: InferenceResourceGroup[];
  /** Max concurrent requests per resource (1 is correct for a single GPU). */
  concurrency: number;
  /** Abort in-flight background/bulk work when interactive work arrives. */
  preemptBackground: boolean;
  /** Promote a waiting request one class per interval. 0 disables aging. */
  agingMs: number;
  /** Give up waiting after this long. 0 waits indefinitely. */
  maxWaitMs: number;
}

export interface InferenceResourceGroup {
  id: string;
  name: string;
  origins: string[];
}

export interface InferenceActiveLeaseSnapshot {
  id: string;
  userId: string;
  requestClass: InferenceRequestClass;
  purpose: string;
  origin: string | null;
  startedAt: number;
  durationMs: number;
}

export interface InferenceWaitingRequestSnapshot {
  id: string;
  userId: string;
  requestClass: InferenceRequestClass;
  purpose: string;
  origin: string | null;
  enqueuedAt: number;
  waitMs: number;
  effectivePriority: number;
}

export interface InferenceResourceStats {
  granted: number;
  completed: number;
  preempted: number;
  timedOut: number;
  aborted: number;
  lastWaitMs: number | null;
}

export interface InferenceResourceSnapshot {
  key: string;
  label: string;
  local: boolean;
  concurrency: number;
  active: InferenceActiveLeaseSnapshot[];
  waiting: InferenceWaitingRequestSnapshot[];
  /** Counters for the requesting user's work only, even on shared resources. */
  stats: InferenceResourceStats;
  updatedAt: number;
}

export interface InferenceSchedulerStatus {
  enabled: boolean;
  /** False inside worker threads / the vectorization subprocess. */
  host: boolean;
  resources: InferenceResourceSnapshot[];
  updatedAt: number;
}

/** Rendered in diagnostics and logs; never includes credentials or prompts. */
export class InferenceQueueTimeoutError extends Error {
  readonly code = "INFERENCE_QUEUE_TIMEOUT";
  constructor(message: string) {
    super(message);
    this.name = "InferenceQueueTimeoutError";
  }
}

export class InferencePreemptedError extends Error {
  readonly code = "INFERENCE_PREEMPTED";
  constructor(message: string) {
    super(message);
    this.name = "InferencePreemptedError";
  }
}

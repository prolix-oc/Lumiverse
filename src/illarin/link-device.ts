/**
 * Headless device fallback (protocol v1).
 *
 * Adopts RFC 8628's protections without being an OAuth Device Authorization
 * Grant: no client ID, no grant_type. The verification URL and user code are
 * shown SEPARATELY by design — there is deliberately no complete prefilled
 * verification URL. The private deviceCode never leaves the backend.
 *
 * This class owns the polling state machine from the protocol table. Each
 * `pollIfDue` call is one finite ordinary request; timing decisions are
 * computed from an injectable clock so tests stay deterministic.
 */

import { pollDeviceRequest, type IllarinFetch } from "./api";
import type { DeviceRequestResponse, TokenPair } from "./types";

export type DeviceLinkStatus =
  | { status: "pending"; retryInMs: number }
  | { status: "linked"; tokens: TokenPair }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "unknown_code" };

export interface DeviceLinkDeps {
  /** Injectable transport for tests; production uses safeFetch. */
  fetchImpl?: IllarinFetch;
  /** Called once when the owner approves. Persist credentials here. */
  onLinked: (tokens: TokenPair) => void | Promise<void>;
  now?: () => number;
}

export interface DeviceLinkRunnerOptions {
  /** Stops the local pickup loop without changing the Illarin request. */
  signal?: AbortSignal;
  /** Test seam; production waits with an abort-aware timer. */
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

const MAX_BACKOFF_MS = 60_000;

export class DeviceLinkSession {
  /** Persistent polling interval in ms — a `slow_down` raises it for good. */
  private intervalMs: number;
  private nextPollAt: number;
  private failedAttempts = 0;

  constructor(
    readonly request: DeviceRequestResponse,
    private readonly baseUrl: string,
    private readonly deps: DeviceLinkDeps,
  ) {
    this.intervalMs = Math.max(1_000, request.interval * 1000);
    this.nextPollAt = this.now() + this.intervalMs;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private schedule(delayMs: number): void {
    this.nextPollAt = this.now() + delayMs;
  }

  /**
   * Poll at most once per call, and only when the current interval has
   * elapsed. Returns the mapped protocol-table outcome.
   */
  async pollIfDue(): Promise<DeviceLinkStatus> {
    const now = this.now();
    if (now < this.nextPollAt) {
      return { status: "pending", retryInMs: this.nextPollAt - now };
    }

    let result;
    try {
      result = await pollDeviceRequest(this.baseUrl, this.request.deviceCode, {
        fetchImpl: this.deps.fetchImpl,
      });
      this.failedAttempts = 0;
    } catch {
      // Network failure: outcome unknown, but a poll consumes nothing, so
      // backing off and retrying is protocol-conformant here.
      this.failedAttempts++;
      const backoff = Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** Math.min(this.failedAttempts, 5));
      this.schedule(backoff);
      return { status: "pending", retryInMs: backoff };
    }

    switch (result.kind) {
      case "pending": {
        this.schedule(this.intervalMs);
        return { status: "pending", retryInMs: this.intervalMs };
      }
      case "slow_down": {
        // The larger interval remains in force from now on.
        const waitMs = Math.max(result.retryAfterSeconds ?? 0, this.request.interval) * 1000;
        this.intervalMs = Math.max(this.intervalMs, waitMs);
        this.schedule(this.intervalMs);
        return { status: "pending", retryInMs: this.intervalMs };
      }
      case "rate_limited": {
        // Source-wide limit: honor Retry-After once without raising the
        // persistent interval, but never poll before the current interval.
        const waitMs = Math.max(
          this.intervalMs,
          (result.retryAfterSeconds ?? this.request.interval) * 1000,
        );
        this.schedule(waitMs);
        return { status: "pending", retryInMs: waitMs };
      }
      case "linked":
        await this.deps.onLinked(result.tokens);
        return { status: "linked", tokens: result.tokens };
      case "denied":
        return { status: "denied" };
      case "expired":
        return { status: "expired" };
      case "unknown_code":
        return { status: "unknown_code" };
    }
  }
}

function sleepUntilNextPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Keep an approved remote-device request alive until the installation picks
 * up its token grant. This belongs in the backend: the browser that displayed
 * the manual code may close, navigate away, or be on another machine.
 *
 * Returns null when the owner starts a replacement link, unlinks, or the
 * process shuts down. Terminal protocol outcomes are returned after
 * `onLinked` has durably persisted a successful grant.
 */
export async function runDeviceLinkUntilTerminal(
  session: Pick<DeviceLinkSession, "pollIfDue">,
  options: DeviceLinkRunnerOptions = {},
): Promise<Exclude<DeviceLinkStatus, { status: "pending" }> | null> {
  const sleep = options.sleep ?? sleepUntilNextPoll;
  while (!options.signal?.aborted) {
    const result = await session.pollIfDue();
    if (result.status !== "pending") return result;
    await sleep(result.retryInMs, options.signal);
  }
  return null;
}

import type { InferenceLease } from "./types";

/**
 * Combine the caller's abort signal with the lease's preemption signal so a
 * background request stops its HTTP work when interactive traffic needs the
 * resource. For unscheduled leases this is just the caller's signal.
 */
export function withLeaseAbort(
  caller: AbortSignal | undefined,
  lease: InferenceLease,
): AbortSignal {
  if (!lease.scheduled) return caller ?? lease.signal;
  if (!caller) return lease.signal;
  return AbortSignal.any([caller, lease.signal]);
}

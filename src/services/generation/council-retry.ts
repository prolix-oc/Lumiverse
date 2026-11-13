import * as pool from "../generation-pool.service";

export type CouncilRetryDecision = "continue" | "retry";

interface PendingCouncilRetry {
  userId: string;
  resolve: (decision: CouncilRetryDecision) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const COUNCIL_RETRY_SAFETY_CAP_MS = 10 * 60 * 1000;
const pendingCouncilRetries = new Map<string, PendingCouncilRetry>();

function clearPoolRetryState(generationId: string): void {
  const poolEntry = pool.getPoolEntry(generationId);
  if (!poolEntry) return;
  poolEntry.councilRetryPending = false;
  delete poolEntry.councilToolsFailure;
}

export function waitForCouncilRetryDecision(
  userId: string,
  generationId: string,
): Promise<CouncilRetryDecision> {
  return new Promise<CouncilRetryDecision>((resolve) => {
    const timeout = setTimeout(() => {
      console.debug(
        "[council] Safety cap reached for %s — auto-continuing",
        generationId,
      );
      pendingCouncilRetries.delete(generationId);
      clearPoolRetryState(generationId);
      resolve("continue");
    }, COUNCIL_RETRY_SAFETY_CAP_MS);
    pendingCouncilRetries.set(generationId, { userId, resolve, timeout });
  });
}

export function clearCouncilRetry(generationId: string): boolean {
  const pending = pendingCouncilRetries.get(generationId);
  if (!pending) return false;
  clearTimeout(pending.timeout);
  pendingCouncilRetries.delete(generationId);
  return true;
}

/** Resolve a pending decision only when it belongs to the caller. */
export function resolveCouncilRetry(
  userId: string,
  generationId: string,
  decision: CouncilRetryDecision,
): boolean {
  const pending = pendingCouncilRetries.get(generationId);
  if (!pending || pending.userId !== userId) return false;
  clearTimeout(pending.timeout);
  pendingCouncilRetries.delete(generationId);
  clearPoolRetryState(generationId);
  pending.resolve(decision);
  return true;
}

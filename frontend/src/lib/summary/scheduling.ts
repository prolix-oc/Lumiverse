/** Normalize the user-configured trailing message buffer. */
export function normalizeSummaryMessageLag(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

/** Number of messages old enough to be included in an automatic summary. */
export function eligibleSummaryMessageCount(totalMessages: number, messageLag: number): number {
  const total = Number.isFinite(totalMessages) ? Math.max(0, Math.floor(totalMessages)) : 0
  return Math.max(0, total - normalizeSummaryMessageLag(messageLag))
}

/**
 * Auto-summary cadence is measured against the eligible (non-lagged) prefix.
 * `lastSummarizedCount` is the previous eligible cutoff, so the lag remains a
 * rolling tail instead of being permanently skipped or added to every window.
 */
export function shouldAutoSummarize(
  totalMessages: number,
  lastSummarizedCount: number,
  interval: number,
  messageLag = 0,
): boolean {
  const eligibleCount = eligibleSummaryMessageCount(totalMessages, messageLag)
  const lastCount = Number.isFinite(lastSummarizedCount)
    ? Math.max(0, Math.floor(lastSummarizedCount))
    : 0
  const normalizedInterval = Number.isFinite(interval) ? Math.max(1, Math.floor(interval)) : 1
  return eligibleCount >= normalizedInterval && eligibleCount - lastCount >= normalizedInterval
}

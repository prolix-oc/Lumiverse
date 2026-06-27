type DidMobileQueueHoldReachThresholdParams = {
  holdStartedAt: number
  releasedAt: number
  thresholdMs: number
}

export function didMobileQueueHoldReachThreshold({
  holdStartedAt,
  releasedAt,
  thresholdMs,
}: DidMobileQueueHoldReachThresholdParams): boolean {
  if (!Number.isFinite(holdStartedAt) || !Number.isFinite(releasedAt)) return false
  if (holdStartedAt <= 0 || releasedAt < holdStartedAt) return false
  return (releasedAt - holdStartedAt) >= thresholdMs
}

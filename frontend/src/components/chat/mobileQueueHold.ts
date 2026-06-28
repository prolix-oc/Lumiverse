type DidMobileQueueHoldReachThresholdParams = {
  holdStartedAt: number
  releasedAt: number
  thresholdMs: number
}

type GetMobileQueueHoldPreviewStateParams = {
  holdStartedAt: number
  evaluatedAt: number
  revealAfterMs: number
  thresholdMs: number
}

export type MobileQueueHoldPreviewState = 'idle' | 'holding' | 'armed'

export function didMobileQueueHoldReachThreshold({
  holdStartedAt,
  releasedAt,
  thresholdMs,
}: DidMobileQueueHoldReachThresholdParams): boolean {
  if (!Number.isFinite(holdStartedAt) || !Number.isFinite(releasedAt)) return false
  if (holdStartedAt <= 0 || releasedAt < holdStartedAt) return false
  return (releasedAt - holdStartedAt) >= thresholdMs
}

export function getMobileQueueHoldPreviewState({
  holdStartedAt,
  evaluatedAt,
  revealAfterMs,
  thresholdMs,
}: GetMobileQueueHoldPreviewStateParams): MobileQueueHoldPreviewState {
  if (!Number.isFinite(holdStartedAt) || !Number.isFinite(evaluatedAt)) return 'idle'
  if (holdStartedAt <= 0 || evaluatedAt < holdStartedAt) return 'idle'

  const heldMs = evaluatedAt - holdStartedAt
  if (heldMs >= thresholdMs) return 'armed'
  if (heldMs >= revealAfterMs) return 'holding'
  return 'idle'
}

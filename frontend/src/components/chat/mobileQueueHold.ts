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

type ShouldQueueMobileHoldParams = DidMobileQueueHoldReachThresholdParams & {
  isArmed: boolean
}

// The visual state is driven by a timer while the release event carries the
// browser's event timestamp. Some Android WebViews do not keep those clocks in
// lockstep, so an armed control must remain queueable even when the timestamps
// cannot be compared reliably on release.
export function shouldQueueMobileHold({
  isArmed,
  holdStartedAt,
  releasedAt,
  thresholdMs,
}: ShouldQueueMobileHoldParams): boolean {
  return isArmed || didMobileQueueHoldReachThreshold({
    holdStartedAt,
    releasedAt,
    thresholdMs,
  })
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

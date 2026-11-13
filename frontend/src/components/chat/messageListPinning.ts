interface ShouldPinMessageListTailOptions {
  distanceFromEnd: number
  userHasUnpinned: boolean
  bottomRepinEpsilon: number
  explicitBottomRepinEpsilon?: number
}

export interface MessageListScrollPosition {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/** Shrinking keyboard padding clamps scrollTop without a user scrolling up. */
export function isMessageListScrollRangeClamp(
  previous: MessageListScrollPosition | null,
  current: MessageListScrollPosition,
): boolean {
  if (!previous) return false
  const previousEnd = Math.max(0, previous.scrollHeight - previous.clientHeight)
  const currentEnd = Math.max(0, current.scrollHeight - current.clientHeight)
  return currentEnd < previousEnd && previous.scrollTop > currentEnd &&
    Math.abs(current.scrollTop - currentEnd) <= 2
}

export function shouldPinMessageListTail({
  distanceFromEnd,
  userHasUnpinned,
  bottomRepinEpsilon,
  explicitBottomRepinEpsilon = 2,
}: ShouldPinMessageListTailOptions): boolean {
  return userHasUnpinned
    ? distanceFromEnd <= explicitBottomRepinEpsilon
    : distanceFromEnd <= bottomRepinEpsilon
}

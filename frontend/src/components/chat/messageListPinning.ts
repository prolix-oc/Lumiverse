interface ShouldPinMessageListTailOptions {
  distanceFromEnd: number
  userHasUnpinned: boolean
  bottomRepinEpsilon: number
  explicitBottomRepinEpsilon?: number
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

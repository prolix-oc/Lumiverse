export type MobileQueueHoldState = 'idle' | 'holding' | 'armed' | 'queueing'

export type MobileQueueHintKey =
  | 'input.keepHoldingToQueue'
  | 'input.releaseToQueue'
  | 'input.queueingMessage'

type GetMobileQueueHintKeyParams = {
  supportsTouchQueueHold: boolean
  isGeneratingInChat: boolean
  mobileQueueHoldState: MobileQueueHoldState
}

export function getMobileQueueHintKey({
  supportsTouchQueueHold,
  isGeneratingInChat,
  mobileQueueHoldState,
}: GetMobileQueueHintKeyParams): MobileQueueHintKey | null {
  // Keep the bubble transient on touch devices; an idle draft should not pin a
  // persistent "Hold to queue" badge above the send button.
  if (!supportsTouchQueueHold || isGeneratingInChat || mobileQueueHoldState === 'idle') {
    return null
  }

  if (mobileQueueHoldState === 'queueing') return 'input.queueingMessage'
  if (mobileQueueHoldState === 'armed') return 'input.releaseToQueue'
  return 'input.keepHoldingToQueue'
}

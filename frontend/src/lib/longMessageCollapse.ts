import type { LongMessageCollapsePreset } from '@/types/store'

export const LONG_MESSAGE_COLLAPSE_CUSTOM_DEFAULT_HEIGHT = 500
export const LONG_MESSAGE_COLLAPSE_CUSTOM_MIN_HEIGHT = 100
export const LONG_MESSAGE_COLLAPSE_CUSTOM_MAX_HEIGHT = 4000

export const LONG_MESSAGE_COLLAPSE_HEIGHTS: Readonly<Record<LongMessageCollapsePreset, number>> = Object.freeze({
  compact: 300,
  comfortable: 500,
  tall: 800,
  custom: LONG_MESSAGE_COLLAPSE_CUSTOM_DEFAULT_HEIGHT,
})

export function getLongMessageCollapseHeight(
  preset: LongMessageCollapsePreset,
  customHeight = LONG_MESSAGE_COLLAPSE_CUSTOM_DEFAULT_HEIGHT,
): number {
  if (preset === 'custom') {
    const normalized = Number.isFinite(customHeight)
      ? Math.round(customHeight)
      : LONG_MESSAGE_COLLAPSE_CUSTOM_DEFAULT_HEIGHT
    return Math.max(
      LONG_MESSAGE_COLLAPSE_CUSTOM_MIN_HEIGHT,
      Math.min(LONG_MESSAGE_COLLAPSE_CUSTOM_MAX_HEIGHT, normalized),
    )
  }

  return LONG_MESSAGE_COLLAPSE_HEIGHTS[preset] ?? LONG_MESSAGE_COLLAPSE_HEIGHTS.comfortable
}

export function isLongMessageCollapseEligible(input: {
  enabled: boolean
  isUser: boolean
  includeUserMessages?: boolean
  depth?: number
  collapseDepth?: number
  chatId?: string
  messageId?: string
}): boolean {
  const depth = typeof input.depth === 'number' && Number.isFinite(input.depth)
    ? Math.max(0, Math.floor(input.depth))
    : 0
  const collapseDepth = typeof input.collapseDepth === 'number' && Number.isFinite(input.collapseDepth)
    ? Math.max(0, Math.floor(input.collapseDepth))
    : 0

  return input.enabled
    && (!input.isUser || input.includeUserMessages === true)
    && depth >= collapseDepth
    && !!input.chatId
    && !!input.messageId
}

export function longMessageExpansionKey(chatId: string, messageId: string): string {
  return `${chatId}:${messageId}`
}

export function isLongMessageOverflowing(contentHeight: number, maxHeight: number): boolean {
  return contentHeight > maxHeight + 1
}

const MAX_RECENT_CHAT_BATCH_SIZE = 100
const MIN_EXPANDED_GRID_ROWS = 3

interface LandingChatPageSizeOptions {
  configuredPageSize: number
  isExpanded: boolean
  layout: 'cards' | 'compact'
  columns: number
  rowHeight: number
  availableHeight: number
}

/**
 * Expanded galleries need enough cards to cover the visible grid rather than
 * the user's normal pagination preference, which was tuned for the narrower
 * default layout. Keep compact/default galleries on that preference exactly;
 * in expanded card view, the visible grid is the source of truth.
 */
export function resolveLandingChatPageSize({
  configuredPageSize,
  isExpanded,
  layout,
  columns,
  rowHeight,
  availableHeight,
}: LandingChatPageSizeOptions): number {
  const baseSize = Math.max(1, Math.min(MAX_RECENT_CHAT_BATCH_SIZE, Math.floor(configuredPageSize)))
  if (!isExpanded || layout !== 'cards') return baseSize

  const safeColumns = Math.max(1, Math.floor(columns))
  const safeRowHeight = Math.max(1, rowHeight)
  const visibleRows = availableHeight > 0
    ? Math.ceil(availableHeight / safeRowHeight) + 1
    : MIN_EXPANDED_GRID_ROWS
  const rows = Math.max(MIN_EXPANDED_GRID_ROWS, visibleRows)

  return Math.min(MAX_RECENT_CHAT_BATCH_SIZE, safeColumns * rows)
}

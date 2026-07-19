export interface MessageListScrollAdjustmentInput {
  delta: number
  itemStart: number
  itemEnd: number
  scrollOffset: number
  scrollDirection: 'forward' | 'backward' | null
  hasMeasuredSize: boolean
  isPinned: boolean
  isStreamingTail: boolean
  isFocusedEditableRow?: boolean
  isUserToggledCollapsibleRow?: boolean
  isProgrammaticContentReflow?: boolean
}

export function shouldAdjustMessageListScrollOnResize({
  delta,
  itemStart,
  itemEnd,
  scrollOffset,
  scrollDirection,
  hasMeasuredSize,
  isPinned,
  isStreamingTail,
  isFocusedEditableRow,
  isUserToggledCollapsibleRow,
  isProgrammaticContentReflow,
}: MessageListScrollAdjustmentInput) {
  const overlapsViewportTop = itemStart < scrollOffset && itemEnd > scrollOffset

  // For the active streaming tail row, height only grows downward as tokens
  // arrive. Once the user has manually unpinned, compensating scrollTop while
  // the viewport sits inside that row makes the whole list climb upward.
  if (!isPinned && isStreamingTail && delta > 0 && overlapsViewportTop) {
    return false
  }

  // While the user types into a message-edit textarea, the browser performs
  // its own caret-reveal scrolling as the field grows and later starts
  // scrolling internally at max-height. Preserving the row's pre-growth
  // offset here fights that native behavior and causes the visible flash.
  // Keep first-measure compensation intact when the edit mode mounts, then
  // leave subsequent growth/shrink of the focused row to the browser.
  if (hasMeasuredSize && isFocusedEditableRow && overlapsViewportTop) {
    return false
  }

  // User-driven collapses/expands inside the viewport should feel local to the
  // row. Compensating scrollTop while the row animates makes the whole chat
  // appear to lurch even though only a collapsible section changed.
  if (hasMeasuredSize && isUserToggledCollapsibleRow && overlapsViewportTop) {
    return false
  }

  // A regex result, message-tag interceptor, or extension widget may replace
  // an already measured row asynchronously. The virtualizer's scrollDirection
  // can still say "backward" long after the gesture that set it, which would
  // otherwise suppress compensation and visibly move the viewport. This flag
  // is scoped to explicit programmatic layout notifications, so ordinary row
  // mounting while the user scrolls upward keeps the default behavior.
  if (isProgrammaticContentReflow && itemStart < scrollOffset) {
    return true
  }

  return itemStart < scrollOffset && (!hasMeasuredSize || scrollDirection !== 'backward')
}

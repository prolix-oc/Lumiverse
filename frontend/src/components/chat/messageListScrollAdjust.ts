export interface MessageListScrollAdjustmentInput {
  delta: number
  itemStart: number
  itemEnd: number
  scrollOffset: number
  scrollDirection: 'forward' | 'backward' | null
  isScrolling?: boolean
  hasMeasuredSize: boolean
  isPinned: boolean
  isStreamingTail: boolean
  isSwipeVariantChange?: boolean
  isFocusedEditableRow?: boolean
  isUserToggledCollapsibleRow?: boolean
  isProgrammaticContentReflow?: boolean
}

export function shouldAdjustMessageListScrollOnResize({
  itemStart,
  itemEnd,
  scrollOffset,
  scrollDirection,
  isScrolling = false,
  hasMeasuredSize,
  isPinned,
  isStreamingTail,
  isSwipeVariantChange,
  isFocusedEditableRow,
  isUserToggledCollapsibleRow,
  isProgrammaticContentReflow,
}: MessageListScrollAdjustmentInput) {
  const overlapsViewportTop = itemStart < scrollOffset && itemEnd > scrollOffset

  // Regeneration first replaces the existing body with a much shorter stream,
  // then grows it again as tokens arrive. Once the user has manually unpinned,
  // compensating scrollTop for either half of that resize makes the whole list
  // jump even though the reader did not move it.
  if (!isPinned && isStreamingTail && overlapsViewportTop) {
    return false
  }

  // An existing-swipe navigation is replacement content, not a layout change
  // within the content the reader was looking at. Keep the same physical
  // scroll offset when the replaced row crosses the viewport top. Rows wholly
  // above the viewport retain normal compensation so unrelated visible
  // messages remain anchored.
  if (!isPinned && isSwipeVariantChange && overlapsViewportTop) {
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

  // scrollDirection records the last direction and can remain "backward"
  // after the gesture has settled. Suppress measured-row correction only while
  // upward scrolling is active; a later resize above the viewport must preserve
  // the visible anchor.
  return itemStart < scrollOffset && (
    !hasMeasuredSize || scrollDirection !== 'backward' || !isScrolling
  )
}

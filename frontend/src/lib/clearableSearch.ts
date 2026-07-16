export interface ClearableSearchKeyEvent {
  key: string
  preventDefault: () => void
  stopPropagation: () => void
}

/** Clears a populated search on Escape and leaves an empty search alone. */
export function clearSearchOnEscape(
  event: ClearableSearchKeyEvent,
  value: string,
  clear: () => void,
): boolean {
  if (event.key !== 'Escape' || value.length === 0) return false
  event.preventDefault()
  event.stopPropagation()
  clear()
  return true
}

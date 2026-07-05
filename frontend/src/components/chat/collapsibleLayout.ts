export const COLLAPSIBLE_TOGGLE_LAYOUT_EVENT = 'lumiverse:collapsible-toggle-layout'

function getTagName(target: EventTarget | null | undefined): string | null {
  if (!target || typeof target !== 'object') return null
  const rawTagName = (target as { tagName?: unknown }).tagName
  return typeof rawTagName === 'string' ? rawTagName.toLowerCase() : null
}

export function getEventPath(event: Event): readonly EventTarget[] {
  if (typeof event.composedPath === 'function') {
    const path = event.composedPath()
    if (Array.isArray(path) && path.length > 0) return path
  }
  return event.target ? [event.target] : []
}

export function findDetailsToggleLayoutTargetFromPath(path: readonly EventTarget[]): EventTarget | null {
  let sawSummary = false

  for (const entry of path) {
    const tagName = getTagName(entry)
    if (!tagName) continue

    if (tagName === 'summary') {
      sawSummary = true
      continue
    }

    if (sawSummary && tagName === 'details') {
      return entry
    }
  }

  return null
}

export function findDetailsToggleLayoutTarget(event: Event): EventTarget | null {
  return findDetailsToggleLayoutTargetFromPath(getEventPath(event))
}

export function dispatchCollapsibleToggleLayoutEvent(target: EventTarget | null): void {
  const dispatchEventFn = (target as { dispatchEvent?: unknown } | null)?.dispatchEvent
  if (typeof dispatchEventFn !== 'function') return

  ;(target as EventTarget).dispatchEvent(new CustomEvent(COLLAPSIBLE_TOGGLE_LAYOUT_EVENT, {
    bubbles: true,
    composed: true,
  }))
}

import { getLiveRootRecordAt, type LiveRootRecord } from './live-root-registry'

export type WidgetTouchScrollMode = 'guarded' | 'native'

// Record identity also invalidates overrides when a root is unregistered or reused.
const nativeRoots = new WeakMap<Element, LiveRootRecord>()

export function assertTouchScrollMode(mode: unknown): asserts mode is WidgetTouchScrollMode {
  if (mode !== 'guarded' && mode !== 'native') {
    throw new Error('SPINDLE_TOUCH_SCROLL_MODE_INVALID: Expected guarded or native')
  }
}

/** Host-only: called with the root owned by a placement handle, never caller DOM. */
export function setWidgetTouchScrollMode(root: Element, mode: WidgetTouchScrollMode): void {
  assertTouchScrollMode(mode)
  if (mode === 'guarded') {
    nativeRoots.delete(root)
    return
  }
  const record = getLiveRootRecordAt(root)
  if (!record || record.permission !== 'ui_panels') {
    throw new Error('PLACEMENT_DESTROYED: Widget root is no longer registered')
  }
  nativeRoots.set(root, record)
}

/** Consult the current path on every move; never cache a detached scroll root. */
export function usesNativeWidgetTouchScroll(event: Event): boolean {
  for (const target of event.composedPath()) {
    if (!(target instanceof Element)) continue
    const record = getLiveRootRecordAt(target)
    if (!record) continue
    // The nearest live placement is a boundary, including nested other widgets.
    return target.isConnected && nativeRoots.get(target) === record
  }
  return false
}

import { useCallback, useEffect, useRef, type PointerEvent } from 'react'
import { preloadDrawerTab } from '@/lib/drawer-tab-registry'
import { canPreloadDrawerTab } from '@/lib/drawer-tab-preload'

/** Brief pointer crossings do no work; deliberate hover, focus and press warm just that tab. */
export function useDrawerTabPreload() {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }, [])
  const schedule = useCallback((tabId: string) => {
    cancel()
    if (!canPreloadDrawerTab()) return
    timer.current = setTimeout(() => {
      timer.current = null
      if (canPreloadDrawerTab()) preloadDrawerTab(tabId)
    }, 100)
  }, [cancel])
  useEffect(() => cancel, [cancel])

  return useCallback((tabId: string) => ({
    onPointerEnter: (event: PointerEvent) => { if (event.pointerType !== 'touch') schedule(tabId) },
    onPointerLeave: cancel,
    onFocus: () => schedule(tabId),
    onBlur: cancel,
    onPointerDown: (event: PointerEvent) => {
      if (event.pointerType === 'touch' || event.button !== 0 || event.isPrimary === false) return
      cancel()
      preloadDrawerTab(tabId)
    },
    // The button owns activation (including touch) and its explicit preload.
    // Returning onClick here could replace navigation when these props are spread.
  }), [cancel, schedule])
}

import { useCallback, useRef } from 'react'

/**
 * Touch-reliable activation for action buttons that sit below text inputs.
 *
 * On Android, tapping such a button blurs the focused input, which dismisses
 * the soft keyboard. Because `main.tsx` opts non-WebKit browsers into
 * `interactive-widget=resizes-content`, that keyboard dismissal reflows the
 * layout and shifts the button out from under the finger *before* the synthetic
 * `click` is delivered — so the browser drops the click and the button only
 * shows its tap-highlight (it never fires).
 *
 * Firing on `pointerup` catches the activation at finger-lift, before the
 * blur-driven reflow happens. The trailing `click` (when it does arrive) is
 * de-duped via the event timeline so the action runs exactly once. Mouse and
 * keyboard activation fall through to `click` untouched.
 *
 * Returns handler props to spread onto the element. Pass `disabled` so a tap
 * is ignored while the action is unavailable (mirrors the button's own state).
 */
export function useTouchActivate(onActivate: () => void, disabled = false) {
  const startPos = useRef<{ x: number; y: number } | null>(null)
  const handledAt = useRef(0)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return
    startPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return
      const start = startPos.current
      startPos.current = null
      if (disabled || !start) return
      // Ignore scroll/drag gestures that merely started on the button.
      if (Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 10) return
      handledAt.current = e.timeStamp
      onActivate()
    },
    [onActivate, disabled],
  )

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      // Suppress the synthetic click that trails a touch we already handled.
      if (e.timeStamp - handledAt.current < 700) return
      if (disabled) return
      onActivate()
    },
    [onActivate, disabled],
  )

  return { onPointerDown, onPointerUp, onClick }
}

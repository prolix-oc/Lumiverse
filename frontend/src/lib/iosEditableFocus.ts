const keyboardInputTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number'])

function editableTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    if (target.matches(':disabled') || target.readOnly) return null
    if (target instanceof HTMLInputElement && !keyboardInputTypes.has(target.type)) return null
    return target
  }
  if (!target.isContentEditable) return null
  return target.closest<HTMLElement>('[contenteditable]') ?? target
}

/** Keep native caret placement while preventing iOS focus from panning the shell. */
export function installIOSEditableFocusScrollPrevention(): () => void {
  let focusing = false
  const preventFocusScroll = (target: HTMLElement | null) => {
    if (!target || focusing || !target.isConnected) return
    if (!document.documentElement.hasAttribute('data-ios-pwa')) return
    if (target.closest('[data-component="InputArea"]')) return
    if (Math.abs((window.visualViewport?.scale ?? 1) - 1) > 0.01) return
    focusing = true
    try {
      target.focus({ preventScroll: true })
    } finally {
      focusing = false
    }
  }
  const beforeMouseDown = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    const target = editableTarget(event.target)
    if (target === document.activeElement) return
    // A compatibility mousedown follows a completed tap, not a touch scroll.
    // Do not cancel it: its native default still places the caret at the tap.
    preventFocusScroll(target)
  }
  const onFocusIn = (event: FocusEvent) => {
    const target = editableTarget(event.target)
    if (target !== document.activeElement) return
    // Labels, keyboard navigation and programmatic focus can bypass mousedown.
    // WebKit refocusing the same element updates its keyboard reveal options
    // without blurring it or restoring/replacing its native selection.
    preventFocusScroll(target)
  }
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented) return
    const target = editableTarget(event.target)
    // Reassert after the native mousedown default, which can refocus a control.
    if (target === document.activeElement) preventFocusScroll(target)
  }
  document.addEventListener('mousedown', beforeMouseDown, true)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('click', onClick, true)
  return () => {
    document.removeEventListener('mousedown', beforeMouseDown, true)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('click', onClick, true)
  }
}

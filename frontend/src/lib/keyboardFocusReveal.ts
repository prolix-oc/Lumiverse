/** Reveal ordinary form controls without treating a tall editor's bottom as its caret. */
export function revealKeyboardFocus(target: HTMLElement): void {
  // The composer positions itself above the keyboard; moving its ancestor
  // would move the entire input bar with it.
  if (target.closest('[data-component="InputArea"]')) return

  let container = target.parentElement
  while (container && container !== document.body && container !== document.documentElement) {
    const { overflowY } = getComputedStyle(container)
    if (overflowY === 'auto' || overflowY === 'scroll') break
    container = container.parentElement
  }
  if (!container || container === document.body || container === document.documentElement) return

  const targetRect = target.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  const viewport = window.visualViewport
  const viewportTop = viewport?.offsetTop ?? 0
  const visibleTop = Math.max(containerRect.top, viewportTop) + 12
  const visibleBottom = Math.min(containerRect.bottom, viewportTop + (viewport?.height ?? window.innerHeight)) - 18

  // A bounding box cannot tell us where the user tapped inside a multiline
  // editor. Aligning its bottom jumps to the end of the document. Such editors
  // must own caret visibility through their native, bounded scrolling surface.
  if (visibleBottom <= visibleTop || targetRect.height > visibleBottom - visibleTop) return

  const delta = targetRect.bottom > visibleBottom
    ? targetRect.bottom - visibleBottom
    : targetRect.top < visibleTop ? targetRect.top - visibleTop : 0
  const scale = container.offsetHeight > 0 ? containerRect.height / container.offsetHeight : 1
  if (Math.abs(delta) >= 1 && scale > 0) container.scrollTop += delta / scale
}

/** Follow actual keyboard resizing, not a guessed animation duration. */
export function installKeyboardFocusReveal(): () => void {
  let frame = 0
  const schedule = () => {
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      // Focus may have moved or the modal may have closed since scheduling.
      const target = document.activeElement
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable)) {
        revealKeyboardFocus(target)
      }
    })
  }
  document.addEventListener('focusin', schedule)
  window.addEventListener('resize', schedule, { passive: true })
  window.visualViewport?.addEventListener('resize', schedule)
  return () => {
    document.removeEventListener('focusin', schedule)
    window.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    window.cancelAnimationFrame(frame)
  }
}

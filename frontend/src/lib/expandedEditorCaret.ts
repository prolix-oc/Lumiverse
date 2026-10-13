/** The mirror shares textarea metrics and ends in a zero-width space so empty
 * and trailing blank lines also have a measurable, collapsed caret range. */
export function getExpandedEditorCaretRect(textarea: HTMLTextAreaElement, mirror: HTMLElement): DOMRect | null {
  const offset = textarea.selectionDirection === 'backward' ? textarea.selectionStart : textarea.selectionEnd
  const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT)
  let remaining = offset
  let node: Node | null
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0
    // At token boundaries choose the following node so a soft-wrapped caret
    // belongs to the next line, not the end of the previous highlight span.
    if (remaining >= length) {
      remaining -= length
      continue
    }
    const range = document.createRange()
    range.setStart(node, remaining)
    range.collapse(true)
    const rect = range.getBoundingClientRect()
    return rect.height > 0 ? rect : null
  }
  return null
}

/** Scroll only enough to expose the active selection end, never the whole field. */
export function revealExpandedEditorCaret(textarea: HTMLTextAreaElement, mirror: HTMLElement): void {
  const rect = textarea.getBoundingClientRect()
  if (rect.height <= 0 || textarea.offsetHeight <= 0) return
  const viewport = window.visualViewport
  const viewportTop = viewport?.offsetTop ?? 0
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
  const scale = rect.height / textarea.offsetHeight
  const gutter = 12 * scale
  const top = Math.max(rect.top, viewportTop) + gutter
  const bottom = Math.min(rect.bottom, viewportBottom) - gutter
  if (bottom <= top) return

  // Native focus/selection handling may have scrolled before this frame.
  // Measure against its current position rather than an earlier tap snapshot.
  mirror.scrollTop = textarea.scrollTop
  mirror.scrollLeft = textarea.scrollLeft
  const caret = getExpandedEditorCaretRect(textarea, mirror)
  if (!caret) return
  const delta = caret.bottom > bottom ? caret.bottom - bottom : caret.top < top ? caret.top - top : 0
  if (Math.abs(delta) < 1) return
  textarea.scrollTop += delta / scale
  mirror.scrollTop = textarea.scrollTop
}

/** Event-driven caret visibility for both Android and iOS (including inline editors). */
export function installExpandedEditorCaretReveal(textarea: HTMLTextAreaElement, mirror: HTMLElement): () => void {
  let frame = 0
  let composing = false
  let lastSelection = ''
  let lastGeometry = ''
  let lastValue: string | null = null
  const schedule = () => {
    if (frame || composing || document.activeElement !== textarea) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      if (!composing && textarea.isConnected && document.activeElement === textarea) {
        const rect = textarea.getBoundingClientRect()
        const viewport = window.visualViewport
        const geometry = [rect.top, rect.bottom, rect.width, viewport?.offsetTop ?? 0,
          viewport?.height ?? window.innerHeight, textarea.selectionStart, textarea.selectionEnd,
          textarea.selectionDirection].join(':')
        // ResizeObserver and visualViewport can report the same layout in
        // successive frames. Once handled, it must not undo a user's scroll.
        // Deliberately exclude scrollTop from this geometry snapshot.
        if (geometry === lastGeometry && textarea.value === lastValue) return
        lastGeometry = geometry
        lastValue = textarea.value
        revealExpandedEditorCaret(textarea, mirror)
      }
    })
  }
  const selectionChanged = () => {
    const selection = `${textarea.selectionStart}:${textarea.selectionEnd}:${textarea.selectionDirection}`
    if (selection === lastSelection) return
    lastSelection = selection
    schedule()
  }
  const compositionStart = () => { composing = true }
  const compositionEnd = () => { composing = false; schedule() }
  // ResizeObserver runs after the CSS viewport variables have resized the
  // field. A visualViewport callback alone can run before that layout commit.
  const observer = new ResizeObserver(schedule)
  observer.observe(textarea)
  textarea.addEventListener('focus', schedule)
  textarea.addEventListener('click', schedule)
  textarea.addEventListener('compositionstart', compositionStart)
  textarea.addEventListener('compositionend', compositionEnd)
  document.addEventListener('selectionchange', selectionChanged)
  window.visualViewport?.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('scroll', schedule)
  // No textarea scroll listener: scrolling to read must not snap to the caret.
  return () => {
    observer.disconnect()
    window.cancelAnimationFrame(frame)
    textarea.removeEventListener('focus', schedule)
    textarea.removeEventListener('click', schedule)
    textarea.removeEventListener('compositionstart', compositionStart)
    textarea.removeEventListener('compositionend', compositionEnd)
    document.removeEventListener('selectionchange', selectionChanged)
    window.visualViewport?.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('scroll', schedule)
  }
}

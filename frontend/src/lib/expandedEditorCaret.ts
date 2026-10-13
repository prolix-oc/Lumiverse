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

interface CaretRevealOptions {
  prepare?: () => void
  getScrollContainer?: () => HTMLElement | null
}

/** Scroll only enough to expose the active selection end, never the whole field. */
export function revealExpandedEditorCaret(textarea: HTMLTextAreaElement, mirror: HTMLElement, options: CaretRevealOptions = {}): void {
  options.prepare?.()
  const rect = textarea.getBoundingClientRect()
  if (rect.height <= 0 || textarea.offsetHeight <= 0) return
  const viewport = window.visualViewport
  const viewportTop = viewport?.offsetTop ?? 0
  const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight)
  const scale = rect.height / textarea.offsetHeight
  const gutter = 12 * scale
  const container = options.getScrollContainer?.()
  const containerRect = container?.getBoundingClientRect()
  const visibleTop = Math.max(viewportTop, containerRect?.top ?? viewportTop) + gutter
  const visibleBottom = Math.min(viewportBottom, containerRect?.bottom ?? viewportBottom) - gutter
  let top = Math.max(rect.top + gutter, visibleTop)
  let bottom = Math.min(rect.bottom - gutter, visibleBottom)
  if (bottom <= top) {
    if (!container) return
    // First reveal the selection inside an off-screen field, then move only
    // that caret into view in its ancestor. Its box can remain partly clipped.
    top = rect.top + gutter
    bottom = rect.bottom - gutter
  }

  // Native focus/selection handling may have scrolled before this frame.
  // Measure against its current position rather than an earlier tap snapshot.
  mirror.scrollTop = textarea.scrollTop
  mirror.scrollLeft = textarea.scrollLeft
  const caret = getExpandedEditorCaretRect(textarea, mirror)
  if (!caret) return
  const delta = caret.bottom > bottom ? caret.bottom - bottom : caret.top < top ? caret.top - top : 0
  if (Math.abs(delta) >= 1) textarea.scrollTop += delta / scale
  mirror.scrollTop = textarea.scrollTop
  if (!container || !containerRect || visibleBottom <= visibleTop) return
  // Internal scrolling can clamp at either end. Only the remaining caret
  // occlusion belongs to the surrounding message list / form panel.
  const actualCaret = getExpandedEditorCaretRect(textarea, mirror)
  if (!actualCaret) return
  const remaining = actualCaret.bottom > visibleBottom ? actualCaret.bottom - visibleBottom
    : actualCaret.top < visibleTop ? actualCaret.top - visibleTop : 0
  const containerScale = container.offsetHeight > 0 ? containerRect.height / container.offsetHeight : scale
  if (Math.abs(remaining) >= 1 && containerScale > 0) {
    container.scrollTop += remaining / containerScale
    options.prepare?.()
    mirror.scrollTop = textarea.scrollTop
    mirror.scrollLeft = textarea.scrollLeft
  }
}

/** Event-driven caret visibility for both Android and iOS (including inline editors). */
export function installExpandedEditorCaretReveal(textarea: HTMLTextAreaElement, mirror: HTMLElement, options: CaretRevealOptions = {}): () => void {
  let frame = 0
  let composing = false
  const selectionKey = () => `${textarea.selectionStart}:${textarea.selectionEnd}:${textarea.selectionDirection}`
  let lastSelection = selectionKey()
  let lastGeometry = ''
  let lastViewport = ''
  let lastFieldSize = ''
  let revealRequested = true
  let lastValue: string | null = null
  const viewportKey = () => `${window.visualViewport?.offsetTop ?? 0}:${window.visualViewport?.height ?? window.innerHeight}`
  const fieldSizeKey = () => `${textarea.offsetWidth}:${textarea.offsetHeight}`
  const geometryKey = () => {
    const rect = textarea.getBoundingClientRect()
    return [rect.top, rect.bottom, rect.width, viewportKey(), textarea.scrollHeight,
      textarea.selectionStart, textarea.selectionEnd, textarea.selectionDirection].join(':')
  }
  const schedule = () => {
    if (frame || composing || document.activeElement !== textarea) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      if (!composing && textarea.isConnected && document.activeElement === textarea) {
        const geometry = geometryKey()
        // ResizeObserver and visualViewport can report the same layout in
        // successive frames. Once handled, it must not undo a user's scroll.
        // Deliberately exclude scrollTop from this geometry snapshot.
        if (geometry === lastGeometry && textarea.value === lastValue) return
        lastGeometry = geometry
        lastViewport = viewportKey()
        lastValue = textarea.value
        revealExpandedEditorCaret(textarea, mirror, options)
        lastGeometry = geometryKey()
        lastFieldSize = fieldSizeKey()
        revealRequested = false
      }
    })
  }
  const selectionChanged = () => {
    const selection = selectionKey()
    if (selection === lastSelection) return
    lastSelection = selection
    requestReveal()
  }
  const requestReveal = () => {
    revealRequested = true
    lastGeometry = ''
    schedule()
  }
  const compositionStart = () => { composing = true }
  const compositionEnd = () => { composing = false; requestReveal() }
  const container = options.getScrollContainer?.()
  const adoptScrollPosition = () => {
    // Moving through history is not a request to return to the selection.
    // Keep real keyboard changes and pending selection requests observable.
    if (!revealRequested && viewportKey() === lastViewport && fieldSizeKey() === lastFieldSize && textarea.value === lastValue) {
      lastGeometry = geometryKey()
    }
  }
  // ResizeObserver runs after the CSS viewport variables have resized the
  // field. A visualViewport callback alone can run before that layout commit.
  const observer = new ResizeObserver(schedule)
  observer.observe(textarea)
  textarea.addEventListener('focus', requestReveal)
  textarea.addEventListener('click', requestReveal)
  textarea.addEventListener('input', schedule)
  textarea.addEventListener('compositionstart', compositionStart)
  textarea.addEventListener('compositionend', compositionEnd)
  textarea.addEventListener('selectionchange', selectionChanged)
  textarea.addEventListener('select', selectionChanged)
  document.addEventListener('selectionchange', selectionChanged)
  container?.addEventListener('scroll', adoptScrollPosition, { passive: true })
  window.visualViewport?.addEventListener('resize', schedule)
  window.visualViewport?.addEventListener('scroll', schedule)
  schedule()
  // No textarea scroll listener: scrolling to read must not snap to the caret.
  return () => {
    observer.disconnect()
    window.cancelAnimationFrame(frame)
    textarea.removeEventListener('focus', requestReveal)
    textarea.removeEventListener('click', requestReveal)
    textarea.removeEventListener('input', schedule)
    textarea.removeEventListener('compositionstart', compositionStart)
    textarea.removeEventListener('compositionend', compositionEnd)
    textarea.removeEventListener('selectionchange', selectionChanged)
    textarea.removeEventListener('select', selectionChanged)
    document.removeEventListener('selectionchange', selectionChanged)
    container?.removeEventListener('scroll', adoptScrollPosition)
    window.visualViewport?.removeEventListener('resize', schedule)
    window.visualViewport?.removeEventListener('scroll', schedule)
  }
}

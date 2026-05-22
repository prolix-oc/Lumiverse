// Returns the current document selection as plain text, but only if the
// selection is non-empty AND wholly contained within `withinEl` (when given).
// Lets context-menu / action-toolbar Copy fall back to the full message text
// unless the user is actually pointing at a piece of it.
export function getSelectionTextWithin(withinEl: HTMLElement | null): string {
  const selection = typeof window !== 'undefined' ? window.getSelection() : null
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''
  const text = selection.toString().trim()
  if (!text) return ''
  if (!withinEl) return text
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i)
    if (!withinEl.contains(range.commonAncestorContainer)) return ''
  }
  return text
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    const successful = document.execCommand('copy')
    if (!successful) {
      throw new Error('The browser refused the copy command.')
    }
  } finally {
    document.body.removeChild(textarea)
  }
}

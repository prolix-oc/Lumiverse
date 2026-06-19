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

/**
 * Copies an image (referenced by a URL or data URL) to the system clipboard.
 * The image is normalised to PNG because the async Clipboard API only reliably
 * accepts `image/png` across engines. Throws if the clipboard API is missing
 * or the image can't be fetched / converted.
 */
export async function copyImageToClipboard(src: string): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    throw new Error('The clipboard image API is not available in this browser.')
  }

  const toPngBlob = async (): Promise<Blob> => {
    const res = await fetch(src)
    if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`)
    const blob = await res.blob()
    return blob.type === 'image/png' ? blob : blobToPng(blob)
  }

  try {
    // Passing a promise to ClipboardItem keeps Safari's user-activation alive
    // (it rejects an async write that awaits before calling write()).
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPngBlob() })])
  } catch {
    // Some engines reject a promise-valued ClipboardItem — retry with a
    // fully-resolved blob.
    const png = await toPngBlob()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  }
}

async function blobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D context unavailable')
    ctx.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (out) => (out ? resolve(out) : reject(new Error('Canvas toBlob returned null'))),
        'image/png',
      )
    })
  } finally {
    bitmap.close()
  }
}

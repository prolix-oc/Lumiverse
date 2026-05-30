/**
 * Triggers a browser download of a Blob with the given filename.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

const EXTENSION_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
}

function deriveImageFilename(src: string, mimeType: string): string {
  const ext = EXTENSION_BY_TYPE[mimeType] || 'png'
  let base = 'image'
  if (!src.startsWith('data:')) {
    try {
      const { pathname } = new URL(src, window.location.origin)
      const segment = pathname.split('/').filter(Boolean).pop()
      if (segment) base = segment.replace(/\.[a-z0-9]+$/i, '') || 'image'
    } catch {
      // Unparseable src — fall back to the default base name.
    }
  }
  return `${base}.${ext}`
}

/**
 * Fetches an image (URL or data URL) and triggers a browser download. When no
 * filename is given one is derived from the source path and the blob's type.
 */
export async function downloadImageFromUrl(src: string, filename?: string): Promise<void> {
  const res = await fetch(src)
  if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`)
  const blob = await res.blob()
  triggerBlobDownload(blob, filename || deriveImageFilename(src, blob.type))
}

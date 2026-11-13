interface NativeDownloads {
  saveBlob: (blob: Blob, filename: string) => Promise<void>
  saveUrl: (url: string, filename: string) => Promise<void>
}

function nativeDownloads(): NativeDownloads | undefined {
  return typeof window === 'undefined' ? undefined : (window as Window & { lumiverseNativeDownloads?: NativeDownloads }).lumiverseNativeDownloads
}

export function hasNativeDownloadCompletion(): boolean { return !!nativeDownloads() }

/** Resolves after Android publishes the file, or after a browser download starts. */
export async function triggerBlobDownload(blob: Blob, filename: string): Promise<void> {
  const native = nativeDownloads()
  if (native) return native.saveBlob(blob, filename)
  const url = URL.createObjectURL(blob)
  try { await triggerUrlDownload(url, filename) }
  finally { URL.revokeObjectURL(url) }
}

export async function triggerUrlDownload(url: string, filename: string): Promise<void> {
  const native = nativeDownloads()
  if (native && /^https?:/i.test(new URL(url, window.location.href).protocol)) return native.saveUrl(url, filename)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
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
  await triggerBlobDownload(blob, filename || deriveImageFilename(src, blob.type))
}

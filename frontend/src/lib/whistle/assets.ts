import { WHISTLE_ASSETS, WHISTLE_CACHE } from './config'

export async function verifyWhistleAsset(bytes: Uint8Array, asset: { bytes: number; sha256: string }): Promise<void> {
  if (bytes.length !== asset.bytes) throw new Error('The Whistle download is incomplete. Please try again.')
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  if (hash !== asset.sha256) throw new Error('The Whistle download could not be verified. Please try again.')
}

export async function loadWhistleAssets(onProgress: (progress: number) => void) {
  let cache: Cache | undefined
  try { cache = await caches.open(WHISTLE_CACHE) } catch { /* Storage may be disabled or full; inference still works. */ }
  const total = WHISTLE_ASSETS.wasm.bytes + WHISTLE_ASSETS.model.bytes
  let completed = 0
  const load = async (asset: typeof WHISTLE_ASSETS.wasm | typeof WHISTLE_ASSETS.model): Promise<Uint8Array> => {
    const base = import.meta.env?.BASE_URL || '/'
    const url = new URL(base + asset.path, self.location.origin).href
    try {
      const cached = await cache?.match(url)
      if (cached) {
        const bytes = new Uint8Array(await cached.arrayBuffer())
        await verifyWhistleAsset(bytes, asset)
        completed += bytes.length
        onProgress(completed / total)
        return bytes
      }
    } catch {
      try { await cache?.delete(url) } catch { /* Best effort repair of corrupt caches. */ }
    }

    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 120_000)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`Whistle could not be downloaded (${response.status}). Please try again.`)
      const bytes = new Uint8Array(asset.bytes)
      let written = 0
      const reader = response.body?.getReader()
      if (reader) {
        try {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (written + value.length > bytes.length) throw new Error('Unexpected Whistle download size. Please try again.')
            bytes.set(value, written)
            written += value.length
            onProgress((completed + written) / total)
          }
        } finally { await reader.cancel().catch(() => {}) }
      } else {
        const body = new Uint8Array(await response.arrayBuffer())
        if (body.length !== bytes.length) throw new Error('The Whistle download is incomplete. Please try again.')
        bytes.set(body)
        written = body.length
      }
      if (written !== bytes.length) throw new Error('The Whistle download is incomplete. Please try again.')
      await verifyWhistleAsset(bytes, asset)
      try { await cache?.put(url, new Response(bytes)) } catch { /* Private browsing/storage quotas must not block STT. */ }
      completed += written
      onProgress(completed / total)
      return bytes
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Whistle took too long to download. Please try again.')
      if (error instanceof TypeError) throw new Error('Whistle could not be downloaded. Check your connection and try again.')
      throw error
    } finally { clearTimeout(deadline) }
  }
  // Sequential downloads keep progress monotonic and avoid holding duplicate response buffers.
  const wasm = await load(WHISTLE_ASSETS.wasm)
  const model = await load(WHISTLE_ASSETS.model)
  return { wasm, model }
}

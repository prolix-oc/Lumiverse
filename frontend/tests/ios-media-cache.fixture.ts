import { acquireIOSMediaImage, setIOSMediaCacheAccount } from '../src/lib/ios-media-cache'
import { iosNativeRequest } from '../src/lib/ios-native'

// Bundled by the sibling iOS regression runner and executed in system WKWebView.
Object.assign(window, { async runMediaFixture(offline: boolean, account: string, imageId: string) {
  let fetches = 0
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwZkAAAAASUVORK5CYII='), char => char.charCodeAt(0))
  window.fetch = async () => {
    fetches++
    if (offline) throw new Error('Network disabled for the cache-hit assertion')
    return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' } })
  }
  setIOSMediaCacheAccount(account)
  const url = `/api/v1/images/${imageId}?size=lg`
  const start = performance.now()
  const lease = acquireIOSMediaImage(url)!
  const src = await lease.ready
  const image = new Image()
  image.src = src
  document.body.append(image)
  await image.decode()
  const elapsed = performance.now() - start
  // Writes deliberately do not block display. Wait for persistence before
  // destroying this WebView and constructing a fresh native cache instance.
  let stored = false
  for (let attempt = 0; attempt < 50; attempt++) {
    const entry = await iosNativeRequest<{ data?: string }>('mediaCache.read', { accountId: account, url })
    if (entry.data) { stored = true; break }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  lease.release()
  return { src, fetches, stored, width: image.naturalWidth, elapsed }
} })

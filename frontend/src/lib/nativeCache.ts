import { hasIOSNativeBridge, iosNativeRequest } from './ios-native'

export function isNativeCacheDocument(): boolean {
  return typeof document !== 'undefined' && hasIOSNativeBridge()
    && document.querySelector('meta[name="lumiverse-native-cache"]')?.getAttribute('content') === '1'
}

/** Local boot health only. Server/auth/network errors are not bundle failures. */
export function reportNativeCacheReady(): void {
  if (!isNativeCacheDocument()) return
  const deadline = performance.now() + 10_000
  const check = () => {
    // Session checks intentionally render nothing in iOS. Their network wait
    // must not quarantine a locally booted frontend as an unhealthy bundle.
    const booted = document.getElementById('root')
      && window.__lumiverseDisplayPerformance?.snapshot().milestones.interactive
    if (!booted) {
      if (performance.now() < deadline) requestAnimationFrame(check)
      return
    }
    const buildId = document.querySelector('meta[name="lumiverse-build-id"]')?.getAttribute('content')
    if (buildId) void iosNativeRequest('cache.ready', { buildId }).catch(() => {})
  }
  requestAnimationFrame(check)
}

import { useCallback, useEffect, useState, type RefObject } from 'react'
import { acquireIOSMediaImage, canCacheIOSMediaImage, invalidateIOSMediaImage } from '@/lib/ios-media-cache'

/** A lease pins compressed bytes while mounted; idle blobs have a separate bounded budget. */
export function useIOSMediaImage(src: string | null | undefined, element: RefObject<HTMLImageElement | null>, loading: 'eager' | 'lazy' = 'lazy') {
  const [resolved, setResolved] = useState<{ src: string; url: string } | null>(null)
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const useCache = Boolean(src && src !== failedSrc && canCacheIOSMediaImage(src))
  const [near, setNear] = useState(false)
  const enabled = !useCache || loading === 'eager' || near
  useEffect(() => {
    if (enabled) return
    const image = element.current
    if (!image || typeof IntersectionObserver === 'undefined') { setNear(true); return }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setNear(true); observer.disconnect() }
    }, { rootMargin: '320px 0px' })
    observer.observe(image)
    return () => observer.disconnect()
  }, [enabled, element])
  useEffect(() => {
    if (!src || !enabled || !useCache) return
    let stopped = false
    const lease = acquireIOSMediaImage(src)
    if (!lease) { setResolved({ src, url: src }); return }
    void lease.ready.then(url => { if (!stopped) setResolved({ src, url }) })
    return () => { stopped = true; lease.release() }
  }, [src, enabled, useCache])
  const url = !useCache ? src ?? undefined : resolved?.src === src ? resolved.url : undefined
  const retryOriginal = useCallback(() => {
    if (!src || !useCache || !url?.startsWith('blob:')) return false
    invalidateIOSMediaImage(src)
    setFailedSrc(src)
    return true
  }, [src, useCache, url])
  return { src: url, retryOriginal }
}

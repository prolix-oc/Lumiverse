import { useCallback, useRef } from 'react'
import { prefetchImages } from '@/lib/imageDecodeCache'

/** Keep prefetch work local to URLs entering the current nearby image range. */
export function useImagePrefetch() {
  const previousUrls = useRef(new Set<string>())

  return useCallback((urls: readonly string[]) => {
    const nextUrls = new Set(urls.filter(Boolean))
    const addedUrls = [...nextUrls].filter((url) => !previousUrls.current.has(url))
    // Retain only the current range, so this stays bounded and images can be
    // warmed again when scrolling back. An avatar edit queues just its new URL,
    // even when unchanged neighbors' decode metadata has expired.
    previousUrls.current = nextUrls
    if (addedUrls.length > 0) prefetchImages(addedUrls)
  }, [])
}

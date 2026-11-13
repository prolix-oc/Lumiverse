import { useEffect, useRef, useState } from 'react'
import { getTauriMobilePlatform, isMacTauriWebView, isTauriDesktop } from '@/lib/desktopWebView'
import { useIOSMediaImage } from '@/hooks/useIOSMediaImage'
import { useImageDecodeReveal } from '@/hooks/useImageDecodeReveal'

interface HomepageLibraryCardImageProps {
  src: string
  alt: string
}

/**
 * Keep the unvirtualized library memory-bounded by withholding image requests
 * until their cards approach the viewport in every Tauri shell. macOS adds a
 * mounted synchronous-decode and paint guard for WKWebView; Windows and Linux
 * retain asynchronous decoding. This avoids materializing all 60 card bitmaps
 * and compositor copies at once.
 */
export default function HomepageLibraryCardImage({ src, alt }: HomepageLibraryCardImageProps) {
  const tauriDesktop = isTauriDesktop()
  const requiresMountedDecode = isMacTauriWebView()
  const [shouldRequest, setShouldRequest] = useState(() => !tauriDesktop)
  const imageRef = useRef<HTMLImageElement>(null)
  const nativeImage = useIOSMediaImage(shouldRequest ? src : null, imageRef, tauriDesktop ? 'eager' : 'lazy')
  const presentation = useImageDecodeReveal(nativeImage.src, imageRef)
  const fade = getTauriMobilePlatform() !== 'android'

  useEffect(() => {
    if (!tauriDesktop || shouldRequest) return
    const image = imageRef.current
    if (!image || typeof IntersectionObserver === 'undefined') {
      setShouldRequest(true)
      return
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      setShouldRequest(true)
      observer.disconnect()
    }, { rootMargin: '320px 0px' })
    observer.observe(image)
    return () => observer.disconnect()
  }, [shouldRequest, tauriDesktop])

  const hidden = tauriDesktop && (
    !shouldRequest || (requiresMountedDecode && !presentation.ready)
  )

  return (
    <img
      ref={imageRef}
      src={nativeImage.src}
      alt={alt}
      loading={tauriDesktop ? 'eager' : 'lazy'}
      decoding={requiresMountedDecode ? 'sync' : tauriDesktop ? 'async' : undefined}
      data-image-decoded={fade ? presentation.ready : undefined}
      onLoad={event => { if (fade) presentation.reveal(event.currentTarget) }}
      onError={() => { presentation.cancel(); nativeImage.retryOriginal() }}
      style={{ visibility: hidden ? 'hidden' : 'visible', ...(fade ? {
        opacity: presentation.ready ? 1 : 0,
        transition: 'opacity 0.2s ease, transform var(--lazy-image-transform-transition, 0ms)',
      } : {}) }}
    />
  )
}

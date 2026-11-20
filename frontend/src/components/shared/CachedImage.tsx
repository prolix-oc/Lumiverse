import { useRef, type ImgHTMLAttributes } from 'react'
import { useIOSMediaImage } from '@/hooks/useIOSMediaImage'
import { useImageDecodeReveal } from '@/hooks/useImageDecodeReveal'
import { getTauriMobilePlatform } from '@/lib/desktopWebView'

/** A plain image using the optional iOS disk cache, with normal browser fallback. */
export default function CachedImage({ src, loading, onLoad, onError, style, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
  const ref = useRef<HTMLImageElement>(null)
  const image = useIOSMediaImage(src, ref, loading)
  const presentation = useImageDecodeReveal(image.src, ref)
  const fade = getTauriMobilePlatform() !== 'android'
  return <img {...props} ref={ref} src={image.src} loading={loading}
    data-image-decoded={fade ? presentation.ready : undefined}
    style={fade ? { ...style, opacity: presentation.ready ? style?.opacity ?? 1 : 0,
      transition: `opacity 0.2s ease, ${style?.transition ?? 'transform var(--lazy-image-transform-transition, 0ms)'}` } : style}
    onLoad={event => { onLoad?.(event); if (fade) presentation.reveal(event.currentTarget) }} onError={event => {
    presentation.cancel()
    if (!image.retryOriginal()) onError?.(event)
  }} />
}

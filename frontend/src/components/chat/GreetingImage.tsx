import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import ImageLightbox from '@/components/shared/ImageLightbox'
import { isMacTauriWebView } from '@/lib/desktopWebView'
import { dispatchMessageContentLayout } from '@/lib/message-content-layout'
import styles from './GreetingImage.module.css'

interface GreetingImageProps {
  src: string
  position: 'top' | 'bottom'
  alt: string
  /** Lets the owning hook fall back to the authored inline image. */
  onError?: () => void
  /** Clears a previous failure once the current source paints successfully. */
  onReady?: () => void
}

function GreetingImageFrame({ src, position, alt, onError, onReady }: GreetingImageProps) {
  const frameRef = useRef<HTMLElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const loadRequestRef = useRef(0)
  const revealFrameRef = useRef<number | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [isLandscape, setIsLandscape] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const requiresMountedDecode = isMacTauriWebView()

  useEffect(() => () => {
    if (revealFrameRef.current !== null) window.cancelAnimationFrame(revealFrameRef.current)
  }, [])

  const handleLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget
    if (imageRef.current !== image) return
    const request = ++loadRequestRef.current
    const isCurrent = () => imageRef.current === image && loadRequestRef.current === request
    const finish = () => {
      if (!isCurrent()) return
      const { naturalWidth, naturalHeight } = image
      const usable = naturalWidth > 0 && naturalHeight > 0
      setIsLandscape(usable && naturalWidth > naturalHeight)
      setState(usable ? 'ready' : 'failed')
      if (usable) onReady?.()
      else onError?.()
    }
    if (!requiresMountedDecode || typeof image.decode !== 'function') {
      finish()
      return
    }

    // WKWebView needs the mounted element's decode and one paint before it
    // has a reliable backing surface, just like the app's shared LazyImage.
    void image.decode().catch(() => {}).then(() => {
      if (!isCurrent()) return
      revealFrameRef.current = window.requestAnimationFrame(() => {
        revealFrameRef.current = null
        finish()
      })
    })
  }, [onError, onReady, requiresMountedDecode])

  const handleError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    if (imageRef.current !== event.currentTarget) return
    ++loadRequestRef.current
    if (revealFrameRef.current !== null) window.cancelAnimationFrame(revealFrameRef.current)
    revealFrameRef.current = null
    setState('failed')
    onError?.()
  }, [onError])

  const openLightbox = useCallback(() => {
    if (state === 'ready') setLightboxOpen(true)
  }, [state])
  const closeLightbox = useCallback(() => setLightboxOpen(false), [])

  useEffect(() => {
    // Landscape artwork uses its intrinsic height; failed images collapse.
    // Notify the message list after either change so it measures the new height.
    const frame = frameRef.current
    if (frame) dispatchMessageContentLayout(frame, { preserveScrollAnchor: true })
  }, [state, position, isLandscape])

  return (
    <>
      <figure
        ref={frameRef}
        className={styles.frame}
        data-position={position}
        data-state={state}
        data-landscape={isLandscape || undefined}
        data-mounted-decode={requiresMountedDecode || undefined}
        hidden={state === 'failed'}
        aria-busy={state === 'loading'}
      >
        <img className={styles.ambient} src={src} alt="" aria-hidden="true" decoding="async" loading="lazy" />
        <img
          ref={imageRef}
          className={styles.artwork}
          src={src}
          alt={alt}
          decoding="async"
          loading="lazy"
          onClick={openLightbox}
          onLoad={handleLoad}
          onError={handleError}
        />
      </figure>
      {lightboxOpen && <ImageLightbox src={src} onClose={closeLightbox} />}
    </>
  )
}

export default function GreetingImage(props: GreetingImageProps) {
  if (!props.src) return null
  // Each source owns its loading/error state, including greeting switches.
  return <GreetingImageFrame key={props.src} {...props} />
}

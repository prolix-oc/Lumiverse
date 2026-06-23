import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react'
import { Spinner } from '@/components/shared/Spinner'
import { isImageDecoded, onImageDecoded, prefetchImage } from '@/lib/imageDecodeCache'

const MAX_LOADED_IMAGE_SRCS = 500
const loadedImageSrcs = new Set<string>()

function rememberLoadedSrc(src: string) {
  loadedImageSrcs.add(src)
  if (loadedImageSrcs.size > MAX_LOADED_IMAGE_SRCS) {
    const oldest = loadedImageSrcs.values().next().value as string | undefined
    if (oldest !== undefined) loadedImageSrcs.delete(oldest)
  }
}

interface LazyImageProps {
  src?: string | null
  alt?: string
  style?: CSSProperties
  objectPosition?: string
  className?: string
  fallback?: ReactNode
  spinnerSize?: number
  containerClassName?: string
  containerStyle?: CSSProperties
  [key: string]: any
}

export default function LazyImage({
  src,
  alt = '',
  style = {},
  objectPosition = 'center',
  className = '',
  fallback = null,
  spinnerSize = 24,
  containerClassName = '',
  containerStyle = {},
  decoding = 'async',
  onLoad,
  onError,
  ...props
}: LazyImageProps) {
  // Skip the spinner when the image is already decoded in the cache — it'll
  // paint within one frame, so showing/hiding a spinner just adds flicker.
  const [isLoading, setIsLoading] = useState(() => {
    if (!src) return false
    if (loadedImageSrcs.has(src)) return false
    if (isImageDecoded(src)) return false
    return true
  })
  const [hasError, setHasError] = useState(false)
  const prevSrcRef = useRef(src)

  useEffect(() => {
    if (src !== prevSrcRef.current) {
      prevSrcRef.current = src
      const decoded = Boolean(src && (loadedImageSrcs.has(src) || isImageDecoded(src)))
      setIsLoading(!decoded)
      setHasError(false)
    }
  }, [src])

  // When the image is pending in the decode cache, subscribe to its
  // completion so we can flip isLoading without waiting for the <img>
  // onload (which fires after a fresh decode on the new element).
  useEffect(() => {
    if (!src || !isLoading) return
    if (loadedImageSrcs.has(src) || isImageDecoded(src)) {
      setIsLoading(false)
      return
    }
    // Trigger prefetch in case it hasn't been started yet
    prefetchImage(src)
    return onImageDecoded(src, () => setIsLoading(false))
  }, [src, isLoading])

  const handleLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    if (src) {
      rememberLoadedSrc(src)
      prefetchImage(src)
    }
    setIsLoading(false)
    onLoad?.(event)
  }, [onLoad, src])
  const handleError = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    setIsLoading(false)
    setHasError(true)
    onError?.(event)
  }, [onError])

  if (hasError || !src) return <>{fallback}</>

  const containerInline: CSSProperties = containerClassName
    ? { position: 'relative', overflow: 'hidden', ...containerStyle }
    : { position: 'relative', width: '100%', height: '100%', ...containerStyle }

  return (
    <div style={containerInline} className={containerClassName || undefined}>
      {isLoading && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--lumiverse-primary, #9370db)',
            opacity: 0.6,
          }}
        >
          <Spinner size={spinnerSize} />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        draggable={false}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transition: 'opacity 0.2s ease, transform var(--lazy-image-transform-transition, 0ms)',
          objectPosition,
          opacity: isLoading ? 0 : 1,
          ...style,
        }}
        className={className}
        decoding={decoding}
        onLoad={handleLoad}
        onError={handleError}
        {...props}
      />
    </div>
  )
}

import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react'
import { Spinner } from '@/components/shared/Spinner'
import { isImageDecoded, onImageDecoded, rememberImageDecoded } from '@/lib/imageDecodeCache'

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
  loading = 'lazy',
  onLoad,
  onError,
  ...props
}: LazyImageProps) {
  // Skip the spinner when the image is already decoded in the cache — it'll
  // paint within one frame, so showing/hiding a spinner just adds flicker.
  const [isLoading, setIsLoading] = useState(() => {
    if (!src) return false
    if (isImageDecoded(src)) return false
    return true
  })
  const [hasError, setHasError] = useState(false)
  const prevSrcRef = useRef(src)

  useEffect(() => {
    if (src !== prevSrcRef.current) {
      prevSrcRef.current = src
      const decoded = Boolean(src && isImageDecoded(src))
      setIsLoading(!decoded)
      setHasError(false)
    }
  }, [src])

  // A near-viewport prefetch may finish before this element's load event.
  // Subscribe to that decode, but do not launch a second detached image here:
  // the mounted <img> is already doing the required fetch and decode.
  useEffect(() => {
    if (!src || !isLoading) return
    if (isImageDecoded(src)) {
      setIsLoading(false)
      return
    }
    return onImageDecoded(src, () => {
      if (isImageDecoded(src)) setIsLoading(false)
    })
  }, [src, isLoading])

  const handleLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    if (src) {
      rememberImageDecoded(src)
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
        loading={loading}
        onLoad={handleLoad}
        onError={handleError}
        {...props}
      />
    </div>
  )
}

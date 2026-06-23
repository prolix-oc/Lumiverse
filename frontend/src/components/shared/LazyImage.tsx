import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode, type SyntheticEvent } from 'react'
import { Spinner } from '@/components/shared/Spinner'

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
  onLoad,
  onError,
  ...props
}: LazyImageProps) {
  const [isLoading, setIsLoading] = useState(() => Boolean(src && !loadedImageSrcs.has(src)))
  const [hasError, setHasError] = useState(false)
  const prevSrcRef = useRef(src)

  useEffect(() => {
    if (src !== prevSrcRef.current) {
      prevSrcRef.current = src
      setIsLoading(Boolean(src && !loadedImageSrcs.has(src)))
      setHasError(false)
    }
  }, [src])

  const handleLoad = useCallback((event: SyntheticEvent<HTMLImageElement>) => {
    if (src) rememberLoadedSrc(src)
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
        loading="lazy"
        onLoad={handleLoad}
        onError={handleError}
        {...props}
      />
    </div>
  )
}

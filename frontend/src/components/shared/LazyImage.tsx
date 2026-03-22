import { useState, useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'

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
  ...props
}: LazyImageProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)
  const prevSrcRef = useRef(src)

  useEffect(() => {
    if (src !== prevSrcRef.current) {
      prevSrcRef.current = src
      setIsLoading(true)
      setHasError(false)
    }
  }, [src])

  const handleLoad = useCallback(() => setIsLoading(false), [])
  const handleError = useCallback(() => {
    setIsLoading(false)
    setHasError(true)
  }, [])

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
            animation: 'spin 1s linear infinite',
          }}
        >
          <Loader2 size={spinnerSize} strokeWidth={1.5} />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transition: 'opacity 0.2s ease',
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

import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { Loader2 } from 'lucide-react'
import styles from './ImageLightbox.module.css'

interface ImageLightboxProps {
  src: string | null
  onClose: () => void
}

export default function ImageLightbox({ src, onClose }: ImageLightboxProps) {
  const [isLoading, setIsLoading] = useState(true)
  const [hasError, setHasError] = useState(false)

  useEffect(() => {
    if (src) {
      setIsLoading(true)
      setHasError(false)
    }
  }, [src])

  useEffect(() => {
    if (!src) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [src, onClose])

  const mouseDownTargetRef = useRef<EventTarget | null>(null)

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) onClose()
    },
    [onClose]
  )

  const handleLoad = useCallback(() => setIsLoading(false), [])
  const handleError = useCallback(() => {
    setIsLoading(false)
    setHasError(true)
  }, [])

  return createPortal(
    <AnimatePresence>
      {src && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onMouseDown={(e) => { mouseDownTargetRef.current = e.target }}
          onClick={handleBackdropClick}
        >
          {isLoading && (
            <div className={styles.spinner}>
              <Loader2 size={32} strokeWidth={1.5} />
            </div>
          )}
          {hasError ? (
            <div className={styles.error}>Failed to load image</div>
          ) : (
            <img
              src={src}
              alt=""
              className={styles.image}
              style={{ opacity: isLoading ? 0 : 1 }}
              onLoad={handleLoad}
              onError={handleError}
            />
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

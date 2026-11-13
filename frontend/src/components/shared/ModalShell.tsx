import { useEffect, useEffectEvent, useCallback, useRef, type ReactNode, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import styles from './ModalShell.module.css'
import clsx from 'clsx'
import useIsMobile from '@/hooks/useIsMobile'

// A library browser can open above a voice-settings dialog. Only the top
// shell should dismiss on Escape, and scrolling stays locked until both close.
const openShells: symbol[] = []
let previousBodyOverflow = ''

interface ModalShellProps {
  isOpen: boolean
  onClose: () => void
  maxWidth?: string | number
  maxHeight?: string | number
  zIndex?: number
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  children: ReactNode
  className?: string
  style?: CSSProperties
  /** Use the available viewport without desktop size caps. */
  fullscreen?: boolean
  /** Fullscreen on mobile is opt-in, independently of the viewport size. */
  mobilePresentation?: 'fullscreen' | 'dialog'
  /** Allow a modal body with form controls to scroll when the viewport is short. */
  scrollable?: boolean
  modalId?: string
  /** Stable theme scope for a caller whose content is portalled. */
  'data-component'?: string
}

export function ModalShell({
  isOpen,
  onClose,
  maxWidth = 560,
  maxHeight = 'calc(85dvh / var(--lumiverse-ui-scale, 1))',
  zIndex = 10002,
  closeOnBackdrop = true,
  closeOnEscape = true,
  children,
  className,
  style,
  fullscreen: requestedFullscreen = false,
  mobilePresentation = 'dialog',
  scrollable = false,
  modalId = 'shell',
  'data-component': dataComponent,
}: ModalShellProps) {
  const isMobile = useIsMobile()
  const fullscreen = requestedFullscreen || (isMobile && mobilePresentation === 'fullscreen')
  const modalLimit = (value: string | number) => {
    const length = typeof value === 'number' ? `${value}px` : value
    if (length === 'none') return '100%'
    // Viewport and fixed-pixel caps must not shrink a second time under body
    // zoom. Existing layout-space limits and caller-resolved CSS variables
    // already account for zoom; percentages refer to the padded backdrop.
    const alreadyScaled = /--lumiverse-ui-scale|--app-scaled-viewport|%/.test(length) || /^var\(/.test(length.trim())
    return `min(${isMobile && !alreadyScaled ? `calc((${length}) / var(--lumiverse-ui-scale, 1))` : length}, 100%)`
  }
  const backdropPointerDownRef = useRef<EventTarget | null>(null)
  const shellId = useRef(Symbol('modal-shell'))
  const handleEscape = useEffectEvent((e: KeyboardEvent) => {
    if (!e.defaultPrevented && closeOnEscape && e.key === 'Escape' && openShells.at(-1) === shellId.current) onClose()
  })

  useEffect(() => {
    if (!isOpen) return
    const id = shellId.current
    if (openShells.length === 0) previousBodyOverflow = document.body.style.overflow
    openShells.push(id)
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      const index = openShells.indexOf(id)
      if (index !== -1) openShells.splice(index, 1)
      if (openShells.length === 0) document.body.style.overflow = previousBodyOverflow
    }
  }, [isOpen])

  const handleBackdropPointerDown = useCallback((e: React.PointerEvent) => {
    backdropPointerDownRef.current = e.target === e.currentTarget ? e.currentTarget : null
  }, [])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (
        closeOnBackdrop
        && e.target === e.currentTarget
        && backdropPointerDownRef.current === e.currentTarget
      ) {
        onClose()
      }
    },
    [onClose, closeOnBackdrop],
  )

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={clsx(styles.backdrop, fullscreen && styles.fullscreenBackdrop)}
          data-modal={dataComponent}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onPointerDown={handleBackdropPointerDown}
          onClick={handleBackdropClick}
          style={{ zIndex }}
        >
          <motion.div
            className={clsx(styles.modal, fullscreen && styles.fullscreenModal, scrollable && styles.scrollable, className)}
            data-component={dataComponent}
            data-liquid-glass-surface=""
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            // A caller's viewport-unit limit also needs to fit the available
            // backdrop at larger UI scales and while a keyboard is open.
            style={{
              ...style,
              width: fullscreen || isMobile ? '100%' : style?.width,
              height: fullscreen ? '100%' : style?.height,
              minWidth: fullscreen || isMobile ? 0 : style?.minWidth,
              minHeight: fullscreen || isMobile ? 0 : style?.minHeight,
              maxWidth: fullscreen ? 'none' : modalLimit(style?.maxWidth ?? maxWidth),
              maxHeight: fullscreen ? 'none' : modalLimit(style?.maxHeight ?? maxHeight),
            }}
          >
            <span data-spindle-mount="modal_header_actions" data-spindle-scope={`modal:${modalId}:header-actions`} style={{ display: 'contents' }} />
            {children}
            <span data-spindle-mount="modal_footer_actions" data-spindle-scope={`modal:${modalId}:footer-actions`} style={{ display: 'contents' }} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

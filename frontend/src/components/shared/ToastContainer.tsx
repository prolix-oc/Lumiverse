import { useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { CheckCircle, AlertTriangle, XCircle, Info, X } from 'lucide-react'
import { useStore } from '@/store'
import type { Toast, ToastType, ToastPosition } from '@/types/store'
import styles from './ToastContainer.module.css'
import clsx from 'clsx'

const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 4000,
  info: 5000,
  warning: 6000,
  error: 8000,
}

const ICON_MAP: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle size={18} />,
  warning: <AlertTriangle size={18} />,
  error: <XCircle size={18} />,
  info: <Info size={18} />,
}

function getSlideDirection(position: ToastPosition): { x?: number; y?: number } {
  if (position.includes('right')) return { x: 80 }
  if (position.includes('left')) return { x: -80 }
  if (position === 'top') return { y: -40 }
  return { y: 40 }
}

function ToastItem({ toast, position }: { toast: Toast; position: ToastPosition }) {
  const removeToast = useStore((s) => s.removeToast)
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null)
  const duration = toast.duration ?? DEFAULT_DURATION[toast.type]

  const dismiss = useCallback(() => {
    removeToast(toast.id)
  }, [toast.id, removeToast])

  useEffect(() => {
    if (duration > 0) {
      timerRef.current = setTimeout(dismiss, duration)
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [duration, dismiss])

  const handleMouseEnter = () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }

  const handleMouseLeave = () => {
    if (duration > 0) {
      timerRef.current = setTimeout(dismiss, 2000)
    }
  }

  const slide = getSlideDirection(position)

  return (
    <motion.div
      layout
      className={clsx(styles.toast, styles[toast.type])}
      initial={{ opacity: 0, ...slide, scale: 0.95 }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      exit={{ opacity: 0, ...slide, scale: 0.95 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="alert"
    >
      <div className={styles.iconWrap}>
        {ICON_MAP[toast.type]}
      </div>
      <div className={styles.body}>
        {toast.title && <div className={styles.title}>{toast.title}</div>}
        <div className={styles.message}>{toast.message}</div>
      </div>
      {toast.dismissible !== false && (
        <button type="button" className={styles.closeBtn} onClick={dismiss} aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
      {duration > 0 && (
        <div className={styles.progressTrack}>
          <motion.div
            className={clsx(styles.progressBar, styles[`${toast.type}Bar`])}
            initial={{ scaleX: 1 }}
            animate={{ scaleX: 0 }}
            transition={{ duration: duration / 1000, ease: 'linear' }}
          />
        </div>
      )}
    </motion.div>
  )
}

export default function ToastContainer() {
  const toasts = useStore((s) => s.toasts)
  const position = useStore((s) => s.toastPosition) as ToastPosition

  const positionClass = styles[position.replace('-', '')] || styles.bottomright

  return createPortal(
    <div className={clsx(styles.container, positionClass)}>
      <AnimatePresence mode="popLayout">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} position={position} />
        ))}
      </AnimatePresence>
    </div>,
    document.body
  )
}

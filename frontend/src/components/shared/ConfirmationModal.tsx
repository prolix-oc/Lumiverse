import { useEffect, useCallback, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { AlertTriangle, AlertCircle, Info, X } from 'lucide-react'
import styles from './ConfirmationModal.module.css'

type Variant = 'danger' | 'warning' | 'safe'

interface ConfirmationModalProps {
  isOpen: boolean
  onConfirm: () => void
  onCancel: () => void
  title?: string
  message?: string | ReactNode
  variant?: Variant
  confirmText?: string
  cancelText?: string
  secondaryText?: string
  onSecondary?: () => void
  secondaryVariant?: Variant
  icon?: ReactNode
  zIndex?: number
}

const variantConfig = {
  danger: {
    accent: 'var(--lumiverse-danger, #ef4444)',
    border: 'color-mix(in srgb, var(--lumiverse-danger, #ef4444) 28%, var(--lumiverse-border, rgba(255, 255, 255, 0.08)))',
  },
  warning: {
    accent: 'var(--lumiverse-warning, #f59e0b)',
    border: 'color-mix(in srgb, var(--lumiverse-warning, #f59e0b) 28%, var(--lumiverse-border, rgba(255, 255, 255, 0.08)))',
  },
  safe: {
    accent: 'var(--lumiverse-primary, #9370db)',
    border: 'color-mix(in srgb, var(--lumiverse-primary, #9370db) 28%, var(--lumiverse-border, rgba(255, 255, 255, 0.08)))',
  },
}

const variantIcons = {
  danger: <AlertCircle size={24} />,
  warning: <AlertTriangle size={24} />,
  safe: <Info size={24} />,
}

function getVariantStyle(variant: Variant): CSSProperties {
  const config = variantConfig[variant]
  return {
    '--confirmation-accent': config.accent,
    '--confirmation-accent-border': config.border,
  } as CSSProperties
}

export default function ConfirmationModal({
  isOpen,
  onConfirm,
  onCancel,
  title = 'Confirm Action',
  message = 'Are you sure you want to proceed?',
  variant = 'safe',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  secondaryText,
  onSecondary,
  secondaryVariant,
  icon: customIcon,
  zIndex = 10002,
}: ConfirmationModalProps) {
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel?.()
    }
    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [isOpen, onCancel])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onCancel?.()
    },
    [onCancel]
  )

  const displayIcon = customIcon || variantIcons[variant]
  const modalStyle = getVariantStyle(variant)

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={handleBackdropClick}
          style={{ zIndex }}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            style={modalStyle}
          >
            <button onClick={onCancel} type="button" className={styles.closeBtn} aria-label="Close">
              <X size={16} />
            </button>

            <div className={styles.content}>
              <div className={styles.iconWrap}>
                {displayIcon}
              </div>
              <h3 className={styles.title}>{title}</h3>
              <div className={styles.message}>{message}</div>
            </div>

            <div className={styles.actions}>
              <button onClick={onCancel} type="button" className={styles.cancelBtn}>
                {cancelText}
              </button>
              {secondaryText && onSecondary && (
                <button
                  onClick={onSecondary}
                  type="button"
                  className={styles.confirmBtn}
                  style={getVariantStyle(secondaryVariant || variant)}
                >
                  {secondaryText}
                </button>
              )}
              <button
                onClick={onConfirm}
                type="button"
                className={styles.confirmBtn}
                style={modalStyle}
              >
                {confirmText}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

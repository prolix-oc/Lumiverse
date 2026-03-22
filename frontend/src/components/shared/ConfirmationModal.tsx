import { useEffect, useCallback, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { AlertTriangle, AlertCircle, Info, X } from 'lucide-react'
import styles from './ConfirmationModal.module.css'
import clsx from 'clsx'

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
    iconBg: 'rgba(239, 68, 68, 0.15)',
    iconColor: 'var(--lumiverse-danger, #ef4444)',
    confirmBg: 'linear-gradient(135deg, rgba(239, 68, 68, 0.9), rgba(220, 38, 38, 0.9))',
    glow: 'rgba(239, 68, 68, 0.3)',
    border: 'rgba(239, 68, 68, 0.2)',
  },
  warning: {
    iconBg: 'rgba(245, 158, 11, 0.15)',
    iconColor: 'var(--lumiverse-warning, #f59e0b)',
    confirmBg: 'linear-gradient(135deg, rgba(245, 158, 11, 0.9), rgba(217, 119, 6, 0.9))',
    glow: 'rgba(245, 158, 11, 0.3)',
    border: 'rgba(245, 158, 11, 0.2)',
  },
  safe: {
    iconBg: 'rgba(147, 112, 219, 0.15)',
    iconColor: 'var(--lumiverse-primary, #9370db)',
    confirmBg: 'linear-gradient(135deg, rgba(147, 112, 219, 0.9), rgba(124, 58, 237, 0.9))',
    glow: 'rgba(147, 112, 219, 0.3)',
    border: 'rgba(147, 112, 219, 0.2)',
  },
}

const variantIcons = {
  danger: <AlertCircle size={24} />,
  warning: <AlertTriangle size={24} />,
  safe: <Info size={24} />,
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

  const config = variantConfig[variant]
  const displayIcon = customIcon || variantIcons[variant]

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
            style={{
              borderColor: config.border,
              boxShadow: `0 25px 50px -12px rgba(0,0,0,0.5), 0 0 40px ${config.glow}`,
            }}
          >
            <button onClick={onCancel} type="button" className={styles.closeBtn} aria-label="Close">
              <X size={16} />
            </button>

            <div className={styles.content}>
              <div className={styles.iconWrap} style={{ background: config.iconBg, color: config.iconColor }}>
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
                  style={{ background: variantConfig[secondaryVariant || variant].confirmBg }}
                >
                  {secondaryText}
                </button>
              )}
              <button
                onClick={onConfirm}
                type="button"
                className={styles.confirmBtn}
                style={{ background: config.confirmBg, boxShadow: `0 4px 12px ${config.glow}` }}
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

import { type CSSProperties, type ReactNode } from 'react'
import { AlertTriangle, AlertCircle, Info, X } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { Spinner } from './Spinner'
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
  /**
   * When true, both buttons disable, the confirm button shows a spinner +
   * `loadingText`, and the modal can't be dismissed (escape, backdrop, or X)
   * — used to indicate an in-flight async action triggered by Confirm.
   */
  loading?: boolean
  /** Label shown alongside the spinner while `loading` is true. */
  loadingText?: string
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
  loading = false,
  loadingText = 'Working...',
}: ConfirmationModalProps) {
  const displayIcon = customIcon || variantIcons[variant]
  const modalStyle = getVariantStyle(variant)

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth={420}
      zIndex={zIndex}
      className={styles.modal}
      style={modalStyle}
      closeOnBackdrop={!loading}
      closeOnEscape={!loading}
    >
      {!loading && (
        <button onClick={onCancel} type="button" className={styles.closeBtn} aria-label="Close">
          <X size={16} />
        </button>
      )}

      <div className={styles.content}>
        <div className={styles.iconWrap}>
          {displayIcon}
        </div>
        <h3 className={styles.title}>{title}</h3>
        <div className={styles.message}>{message}</div>
      </div>

      <div className={styles.actions}>
        <button
          onClick={onCancel}
          type="button"
          className={styles.cancelBtn}
          disabled={loading}
        >
          {cancelText}
        </button>
        {secondaryText && onSecondary && (
          <button
            onClick={onSecondary}
            type="button"
            className={styles.confirmBtn}
            style={getVariantStyle(secondaryVariant || variant)}
            disabled={loading}
          >
            {secondaryText}
          </button>
        )}
        <button
          onClick={onConfirm}
          type="button"
          className={styles.confirmBtn}
          style={modalStyle}
          disabled={loading}
        >
          {loading ? (
            <span className={styles.loadingLabel}>
              <Spinner size={14} />
              {loadingText}
            </span>
          ) : (
            confirmText
          )}
        </button>
      </div>
    </ModalShell>
  )
}

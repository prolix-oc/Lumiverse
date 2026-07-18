import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, AlertCircle, Info, X } from 'lucide-react'
import { ModalShell } from './ModalShell'
import { Spinner } from './Spinner'
import styles from './ConfirmationModal.module.css'

type Variant = 'danger' | 'warning' | 'safe'

interface ConfirmationModalProps {
  isOpen: boolean
  onConfirm: (inputValue: string, checkboxChecked: boolean) => void
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
  /** Optional single-line input shown above the action buttons. */
  inputLabel?: string
  inputPlaceholder?: string
  defaultInputValue?: string
  /** Optional checkbox shown above the action buttons. */
  checkboxLabel?: string
  defaultCheckboxChecked?: boolean
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
  // Variant arrives through untyped modal props (openModal('confirm', …)),
  // so an unknown string must degrade to 'safe' instead of crashing render.
  const config = variantConfig[variant] ?? variantConfig.safe
  return {
    '--confirmation-accent': config.accent,
    '--confirmation-accent-border': config.border,
  } as CSSProperties
}

export default function ConfirmationModal({
  isOpen,
  onConfirm,
  onCancel,
  title,
  message,
  variant = 'safe',
  confirmText,
  cancelText,
  secondaryText,
  onSecondary,
  secondaryVariant,
  icon: customIcon,
  zIndex = 10002,
  loading = false,
  loadingText,
  inputLabel,
  inputPlaceholder,
  defaultInputValue = '',
  checkboxLabel,
  defaultCheckboxChecked = false,
}: ConfirmationModalProps) {
  const { t } = useTranslation('modals')
  const { t: tc } = useTranslation('common')
  const resolvedTitle = title ?? t('confirm.title')
  const resolvedMessage = message ?? t('confirm.message')
  const resolvedConfirm = confirmText ?? t('confirm.confirm')
  const resolvedCancel = cancelText ?? tc('actions.cancel')
  const resolvedLoading = loadingText ?? t('confirm.working')
  const displayIcon = customIcon || variantIcons[variant] || variantIcons.safe
  const modalStyle = getVariantStyle(variant)
  const [inputValue, setInputValue] = useState(defaultInputValue)
  const [checkboxChecked, setCheckboxChecked] = useState(defaultCheckboxChecked)
  const inputId = useId()
  const checkboxId = useId()

  useEffect(() => {
    if (!isOpen) return
    setInputValue(defaultInputValue)
    setCheckboxChecked(defaultCheckboxChecked)
  }, [defaultCheckboxChecked, defaultInputValue, isOpen])

  const handleConfirm = () => {
    onConfirm(inputValue, checkboxChecked)
  }

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
      scrollable={Boolean(inputLabel)}
    >
      {!loading && (
        <button onClick={onCancel} type="button" className={styles.closeBtn} aria-label={t('confirm.close')}>
          <X size={16} />
        </button>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (!loading) handleConfirm()
        }}
      >
        <div className={styles.content}>
          <div className={styles.iconWrap}>
            {displayIcon}
          </div>
          <h3 className={styles.title}>{resolvedTitle}</h3>
          <div className={styles.message}>{resolvedMessage}</div>

          {inputLabel && (
            <div className={styles.inputGroup}>
              <label className={styles.inputLabel} htmlFor={inputId}>{inputLabel}</label>
              <input
                id={inputId}
                className={styles.input}
                type="text"
                placeholder={inputPlaceholder}
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
                disabled={loading}
              />
            </div>
          )}

          {checkboxLabel && (
            <label className={styles.checkbox} htmlFor={checkboxId}>
              <input
                id={checkboxId}
                type="checkbox"
                checked={checkboxChecked}
                onChange={(event) => setCheckboxChecked(event.target.checked)}
                disabled={loading}
              />
              <span>{checkboxLabel}</span>
            </label>
          )}
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            onClick={onCancel}
            className={styles.cancelBtn}
            disabled={loading}
          >
            {resolvedCancel}
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
            type="submit"
            className={styles.confirmBtn}
            style={modalStyle}
            disabled={loading}
          >
            {loading ? (
              <span className={styles.loadingLabel}>
                <Spinner size={14} />
                {resolvedLoading}
              </span>
            ) : (
              resolvedConfirm
            )}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

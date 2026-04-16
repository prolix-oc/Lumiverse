import { useEffect, useRef, useState } from 'react'
import { ModalShell } from '@/components/shared/ModalShell'
import css from './InputPromptModal.module.css'

interface InputPromptModalProps {
  isOpen: boolean
  title: string
  message?: string
  placeholder?: string
  defaultValue?: string
  submitLabel?: string
  cancelLabel?: string
  /** Optional middle button (e.g. "Skip" in regen feedback) */
  secondaryLabel?: string
  onSubmit: (value: string) => void
  onCancel: () => void
  onSecondary?: () => void
  /** Use textarea instead of single-line input */
  multiline?: boolean
  /** Icon component to show in the header */
  icon?: React.ReactNode
  zIndex?: number
  /** Attribution line below the title (e.g. extension name) */
  attribution?: string
}

export function InputPromptModal({
  isOpen,
  title,
  message,
  placeholder,
  defaultValue = '',
  submitLabel = 'Submit',
  cancelLabel = 'Cancel',
  secondaryLabel,
  onSubmit,
  onCancel,
  onSecondary,
  multiline = false,
  icon,
  zIndex,
  attribution,
}: InputPromptModalProps) {
  const [value, setValue] = useState(defaultValue)
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [isOpen, defaultValue])

  const canSubmit = value.trim().length > 0

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canSubmit) {
      e.preventDefault()
      onSubmit(value)
      return
    }
    if (!multiline && e.key === 'Enter' && canSubmit) {
      e.preventDefault()
      onSubmit(value)
    }
  }

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth="clamp(320px, 90vw, min(520px, var(--lumiverse-content-max-width, 520px)))"
      className={css.modal}
      zIndex={zIndex}
    >
      <div className={css.header}>
        {icon}
        <div>
          <h3 className={css.title}>{title}</h3>
          {attribution && <p className={css.attribution}>{attribution}</p>}
        </div>
      </div>

      {message && <p className={css.subtitle}>{message}</p>}

      <div className={css.body}>
        {multiline ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            className={css.textarea}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            type="text"
            className={css.input}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        )}

        <div className={css.actions}>
          <button
            type="button"
            className={`${css.btn} ${css.btnCancel}`}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>

          {secondaryLabel && onSecondary && (
            <button
              type="button"
              className={`${css.btn} ${css.btnSecondary}`}
              onClick={onSecondary}
            >
              {secondaryLabel}
            </button>
          )}

          <button
            type="button"
            className={`${css.btn} ${css.btnSubmit}`}
            disabled={!canSubmit}
            onClick={() => onSubmit(value)}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}

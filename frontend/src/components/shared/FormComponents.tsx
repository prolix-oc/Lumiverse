import { useState, useEffect, type ReactNode } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Image as ImageIcon } from 'lucide-react'
import { useAdaptiveImagePosition } from '@/hooks/useAdaptiveImagePosition'
import styles from './FormComponents.module.css'

export function EditorLayout({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx(styles.editorLayout, className)}>{children}</div>
}

export function EditorContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx(styles.editorContent, className)}>{children}</div>
}

export function EditorFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={clsx(styles.editorFooter, className)}>{children}</div>
}

interface FormFieldProps {
  label: string
  required?: boolean
  hint?: string
  error?: string
  children: ReactNode
  className?: string
}

export function FormField({ label, required, hint, error, children, className }: FormFieldProps) {
  return (
    <div className={clsx(styles.formField, error && styles.formFieldError, className)}>
      <label className={styles.formLabel}>
        {label}
        {required && <span className={styles.required}>*</span>}
      </label>
      {children}
      {hint && <div className={styles.formHint}>{hint}</div>}
      {error && <div className={styles.formError}>{error}</div>}
    </div>
  )
}

interface EditorSectionProps {
  Icon?: any
  title: string
  children: ReactNode
  defaultExpanded?: boolean
  className?: string
}

export function EditorSection({ Icon, title, children, defaultExpanded = true, className }: EditorSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  return (
    <div className={clsx(styles.editorSection, className)}>
      <div className={styles.sectionHeader} onClick={() => setIsExpanded(!isExpanded)}>
        {Icon && (
          <div className={styles.sectionIcon}>
            <Icon size={14} strokeWidth={2} />
          </div>
        )}
        <span className={styles.sectionTitle}>{title}</span>
        <div className={styles.sectionChevron}>
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>
      </div>
      {isExpanded && <div>{children}</div>}
    </div>
  )
}

interface TextInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  [key: string]: any
}

export function TextInput({ value, onChange, placeholder, className, autoFocus, ...props }: TextInputProps) {
  return (
    <input
      type="text"
      className={clsx(styles.input, className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      {...props}
    />
  )
}

interface TextAreaProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  rows?: number
  className?: string
  [key: string]: any
}

export function TextArea({ value, onChange, placeholder, rows = 4, className, ...props }: TextAreaProps) {
  return (
    <textarea
      className={clsx(styles.textarea, className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      {...props}
    />
  )
}

interface SelectOption {
  value: string
  label: string
}

interface SelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  className?: string
  [key: string]: any
}

export function Select({ value, onChange, options, className, ...props }: SelectProps) {
  return (
    <div className={styles.selectWrapper}>
      <select
        className={clsx(styles.select, className)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...props}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <div className={styles.selectChevron}>
        <ChevronDown size={14} />
      </div>
    </div>
  )
}

interface ImageInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
}

export function ImageInput({ value, onChange, placeholder, className }: ImageInputProps) {
  const [previewError, setPreviewError] = useState(false)
  const { objectPosition } = useAdaptiveImagePosition(value || '')

  useEffect(() => {
    setPreviewError(false)
  }, [value])

  return (
    <div className={clsx(styles.imageInput, className)}>
      <div className={styles.imageInputRow}>
        <div className={styles.imageInputField}>
          <TextInput value={value} onChange={onChange} placeholder={placeholder || 'https://...'} />
        </div>
        {value && !previewError ? (
          <div className={styles.imagePreview}>
            <img
              src={value}
              alt="Preview"
              style={{ objectPosition }}
              className={styles.imagePreviewImg}
              onError={() => setPreviewError(true)}
            />
          </div>
        ) : (
          <div className={styles.imagePlaceholder}>
            <ImageIcon size={16} />
          </div>
        )}
      </div>
    </div>
  )
}

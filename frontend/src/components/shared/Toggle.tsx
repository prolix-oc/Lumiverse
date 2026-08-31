import clsx from 'clsx'
import type { ReactNode } from 'react'
import styles from './Toggle.module.css'

/* ── Checkbox ── */

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  hint?: string
  disabled?: boolean
  className?: string
}

function Checkbox({ checked, onChange, label, hint, disabled, className }: CheckboxProps) {
  return (
    <label className={clsx(styles.checkbox, disabled && styles.checkboxDisabled, className)}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
      />
      {(label || hint) && (
        <span className={styles.labelWrap}>
          {label && <span>{label}</span>}
          {hint && <span className={styles.hint}>{hint}</span>}
        </span>
      )}
    </label>
  )
}

/* ── Switch ── */

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
  title?: string
  'aria-label'?: string
  'aria-describedby'?: string
}

function Switch({
  checked,
  onChange,
  size = 'md',
  disabled,
  className,
  title,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      title={title}
      disabled={disabled}
      className={clsx(
        styles.switch,
        size === 'md' ? styles.switchMd : styles.switchSm,
        checked && styles.switchOn,
        disabled && styles.switchDisabled,
        className,
      )}
      onClick={() => onChange(!checked)}
    />
  )
}

export const Toggle = { Checkbox, Switch }

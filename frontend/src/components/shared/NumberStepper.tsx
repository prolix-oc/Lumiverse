import { useCallback } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'
import styles from './NumberStepper.module.css'

export interface NumberStepperProps {
  value: number | null
  onChange: (v: number | null) => void
  min?: number
  max?: number
  step?: number
  allowEmpty?: boolean
  placeholder?: string
  className?: string
}

export default function NumberStepper({
  value,
  onChange,
  min,
  max,
  step = 1,
  allowEmpty,
  placeholder,
  className,
}: NumberStepperProps) {
  const increment = useCallback(() => {
    const cur = value ?? 0
    const next = cur + step
    if (max !== undefined && next > max) return
    onChange(next)
  }, [value, step, max, onChange])

  const decrement = useCallback(() => {
    const cur = value ?? 0
    const next = cur - step
    if (min !== undefined && next < min) return
    onChange(next)
  }, [value, step, min, onChange])

  return (
    <div className={`${styles.stepper} ${className || ''}`}>
      <input
        type="number"
        className={styles.input}
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          if (allowEmpty && e.target.value === '') {
            onChange(null)
          } else {
            const parsed = parseFloat(e.target.value)
            onChange(Number.isNaN(parsed) ? 0 : parsed)
          }
        }}
      />
      <div className={styles.controls}>
        <button type="button" className={styles.btn} onClick={increment} tabIndex={-1}>
          <ChevronUp size={10} />
        </button>
        <button type="button" className={styles.btn} onClick={decrement} tabIndex={-1}>
          <ChevronDown size={10} />
        </button>
      </div>
    </div>
  )
}

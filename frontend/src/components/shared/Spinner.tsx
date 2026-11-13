import { Loader2 } from 'lucide-react'
import clsx from 'clsx'
import styles from './Spinner.module.css'

interface SpinnerProps {
  size?: number
  fast?: boolean
  className?: string
}

export function Spinner({ size = 14, fast, className }: SpinnerProps) {
  return (
    <span className={clsx(styles.spinner, className)}>
      <Loader2 size={size} className={clsx(styles.spin, fast && styles.fast)} />
    </span>
  )
}

/** CSS class for applying spin animation to any element (e.g. RefreshCw icon) */
export const spinClass = styles.spin

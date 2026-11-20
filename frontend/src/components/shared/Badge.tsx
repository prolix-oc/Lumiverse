import clsx from 'clsx'
import type { ReactNode } from 'react'
import styles from './Badge.module.css'

type BadgeColor = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info'
type BadgeSize = 'sm' | 'md' | 'pill'

interface BadgeProps {
  color?: BadgeColor
  size?: BadgeSize
  children: ReactNode
  className?: string
}

export function Badge({ color = 'neutral', size = 'md', children, className }: BadgeProps) {
  return (
    <span className={clsx(styles.badge, styles[size], styles[color], className)}>
      {children}
    </span>
  )
}

import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { Badge } from '@/components/shared/Badge'
import styles from './CollapsibleSection.module.css'

interface CollapsibleSectionProps {
  title: string
  icon?: ReactNode
  defaultExpanded?: boolean
  expanded?: boolean
  onToggle?: (expanded: boolean) => void
  badge?: string | number
  children: ReactNode
  className?: string
}

export default function CollapsibleSection({
  title,
  icon,
  defaultExpanded = true,
  expanded,
  onToggle,
  badge,
  children,
  className,
}: CollapsibleSectionProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded)
  const isControlled = expanded !== undefined
  const isExpanded = isControlled ? expanded : internalExpanded

  const handleToggle = () => {
    const next = !isExpanded
    if (!isControlled) setInternalExpanded(next)
    onToggle?.(next)
  }

  return (
    <div className={clsx(styles.section, className)}>
      <button
        type="button"
        className={styles.header}
        onClick={handleToggle}
      >
        {icon && <span className={styles.icon}>{icon}</span>}
        <span className={styles.title}>{title}</span>
        {badge !== undefined && <Badge color="primary" size="pill">{badge}</Badge>}
        <span className={styles.chevron}>
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {isExpanded && <div className={styles.content}>{children}</div>}
    </div>
  )
}

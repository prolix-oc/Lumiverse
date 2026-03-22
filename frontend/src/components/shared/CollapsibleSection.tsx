import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import styles from './CollapsibleSection.module.css'

interface CollapsibleSectionProps {
  title: string
  icon?: ReactNode
  defaultExpanded?: boolean
  badge?: string | number
  children: ReactNode
  className?: string
}

export default function CollapsibleSection({
  title,
  icon,
  defaultExpanded = true,
  badge,
  children,
  className,
}: CollapsibleSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded)

  return (
    <div className={clsx(styles.section, className)}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {icon && <span className={styles.icon}>{icon}</span>}
        <span className={styles.title}>{title}</span>
        {badge !== undefined && <span className={styles.badge}>{badge}</span>}
        <span className={styles.chevron}>
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
      </button>
      {isExpanded && <div className={styles.content}>{children}</div>}
    </div>
  )
}

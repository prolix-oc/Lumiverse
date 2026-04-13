import { type ReactNode, useState } from 'react'
import { ChevronRight, RefreshCw } from 'lucide-react'
import { ReweaveInput } from './ReweaveInput'
import styles from './CollapsibleGroup.module.css'

interface CollapsibleGroupProps {
  label: string
  subtitle?: string
  badge?: ReactNode
  defaultOpen?: boolean
  reweaving?: boolean
  onReweave?: (instruction: string) => void
  onDelete?: () => void
  children: ReactNode
}

export function CollapsibleGroup({
  label, subtitle, badge, defaultOpen = false, reweaving, onReweave, onDelete, children,
}: CollapsibleGroupProps) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <div className={styles.group} data-open={open || undefined}>
      <button className={styles.header} onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={14} className={styles.chevron} />
        <span className={styles.label}>{label}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        {badge}
        <div className={styles.headerActions} onClick={(e) => e.stopPropagation()}>
          {onReweave && (
            <button
              className={styles.actionButton}
              disabled={reweaving}
              onClick={() => {
                const el = document.querySelector(`[data-reweave-group="${label}"]`)
                if (el) {
                  if (el.hasAttribute('data-open')) {
                    el.removeAttribute('data-open')
                  } else {
                    el.setAttribute('data-open', '')
                  }
                }
              }}
            >
              <RefreshCw size={11} className={reweaving ? styles.spinning : undefined} />
            </button>
          )}
          {onDelete && (
            <button className={`${styles.actionButton} ${styles.deleteButton}`} onClick={onDelete}>
              ×
            </button>
          )}
        </div>
      </button>
      {onReweave && (
        <div data-reweave-group={label}>
          <ReweaveInput loading={reweaving ?? false} onSubmit={onReweave} />
        </div>
      )}
      {open && (
        <div className={styles.body}>
          {children}
        </div>
      )}
    </div>
  )
}

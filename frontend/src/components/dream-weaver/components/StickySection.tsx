import { type ReactNode, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import type { SectionStatus } from '../hooks/useDreamWeaverStudio'
import { ReweaveInput } from './ReweaveInput'
import styles from './StickySection.module.css'

interface StickySectionProps {
  id: string
  label: string
  status?: SectionStatus
  color?: string
  reweaving?: boolean
  onReweave?: (instruction: string) => void
  children: ReactNode
}

export function StickySection({
  id, label, status = 'empty', color, reweaving, onReweave, children,
}: StickySectionProps) {
  const ref = useRef<HTMLDivElement>(null)

  return (
    <section className={styles.section} id={`section-${id}`} ref={ref}>
      <div className={styles.stickyHeader}>
        <div className={styles.headerLeft}>
          <span className={styles.label} style={color ? { color } : undefined}>{label}</span>
          {status !== 'empty' && (
            <span className={styles.statusDot} data-status={status} />
          )}
        </div>
        {onReweave && (
          <button
            className={styles.reweaveButton}
            disabled={reweaving}
            onClick={() => {
              const input = ref.current?.querySelector<HTMLDivElement>('[data-reweave-input]')
              if (input) {
                if (input.hasAttribute('data-open')) {
                  input.removeAttribute('data-open')
                } else {
                  input.setAttribute('data-open', '')
                }
              }
            }}
          >
            {reweaving ? (
              <RefreshCw size={12} className={styles.spinning} />
            ) : (
              <>
                <RefreshCw size={12} />
                <span>Re-weave</span>
              </>
            )}
          </button>
        )}
      </div>
      {onReweave && (
        <ReweaveInput loading={reweaving ?? false} onSubmit={onReweave} />
      )}
      <div className={styles.content} data-reweaving={reweaving || undefined}>
        {children}
      </div>
    </section>
  )
}

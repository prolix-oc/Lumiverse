import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Hash } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Spinner } from '@/components/shared/Spinner'
import { tokenizersApi } from '@/api/tokenizers'
import { worldBooksApi } from '@/api/world-books'
import { useStore } from '@/store'
import type { WorldBookEntry } from '@/types/api'
import styles from './WorldBookTokenReportModal.module.css'

interface CountResult {
  count: number
  approximate: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  bookId: string
  bookName: string
}

function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await callback(items[index])
    }
  }))

  return results
}

export default function WorldBookTokenReportModal({ isOpen, onClose, bookId, bookName }: Props) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel' })
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const [entries, setEntries] = useState<WorldBookEntry[]>([])
  const [counts, setCounts] = useState<Record<string, CountResult>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const requestRef = useRef(0)

  const profileModel = useMemo(() => (
    profiles.find((profile) => profile.id === activeProfileId && profile.review_required !== true)?.model
      ?? profiles.find((profile) => profile.is_default && profile.review_required !== true)?.model
      ?? null
  ), [activeProfileId, profiles])

  const loadReport = useCallback(async () => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)
    setError(false)
    setEntries([])
    setCounts({})

    try {
      const nextEntries = await worldBooksApi.listAllEntries(bookId)
      const results = await mapWithConcurrency(nextEntries, 8, async (entry): Promise<[string, CountResult]> => {
        if (!entry.content.trim()) return [entry.id, { count: 0, approximate: false }]
        try {
          if (profileModel) {
            const result = await tokenizersApi.countForModel(profileModel, entry.content)
            if (result.token_count != null) return [entry.id, { count: result.token_count, approximate: false }]
          }
        } catch {
          // Fall back to the same local estimate used by the character report.
        }
        return [entry.id, { count: approximateTokenCount(entry.content), approximate: true }]
      })

      if (requestId !== requestRef.current) return
      setEntries(nextEntries)
      setCounts(Object.fromEntries(results))
    } catch {
      if (requestId !== requestRef.current) return
      setError(true)
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [bookId, profileModel])

  useEffect(() => {
    if (!isOpen) return
    void loadReport()
  }, [isOpen, loadReport])

  const allCounted = !loading && !error && entries.every((entry) => counts[entry.id] != null)
  const activeEntries = entries.filter((entry) => !entry.disabled)
  const disabledEntries = entries.filter((entry) => entry.disabled)
  const activeTotal = activeEntries.reduce((sum, entry) => sum + (counts[entry.id]?.count ?? 0), 0)
  const disabledTotal = disabledEntries.reduce((sum, entry) => sum + (counts[entry.id]?.count ?? 0), 0)
  const hasApproximation = entries.some((entry) => counts[entry.id]?.approximate)

  const renderEntries = (items: WorldBookEntry[]) => (
    <div className={styles.accordion}>
      {items.map((entry, index) => {
        const result = counts[entry.id]
        const label = entry.comment || t('tokenReportUntitledEntry', { number: index + 1 })
        return (
          <details className={styles.entry} key={entry.id}>
            <summary>
              <ChevronDown className={styles.chevron} size={14} />
              <span className={styles.entryLabel}>{label}</span>
              {entry.disabled && <span className={styles.disabled}>{t('tokenReportDisabled')}</span>}
              {!result ? <Spinner size={12} fast /> : <span className={styles.count}>{result.approximate ? '~' : ''}{result.count.toLocaleString()}</span>}
            </summary>
            <pre className={styles.content}>{entry.content || t('tokenReportEmptyEntry')}</pre>
          </details>
        )
      })}
    </div>
  )

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} maxWidth={620} zIndex={10003}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{t('tokenReportTitle')}</h2>
          <p className={styles.subtitle}>{bookName}</p>
        </div>
        <CloseButton onClick={onClose} size="sm" />
      </div>

      <div className={styles.body}>
        <div className={styles.summary}>
          <Hash size={15} />
          <span>{loading || !allCounted ? t('tokenReportCounting') : t('tokenReportActiveTotal', { count: activeTotal.toLocaleString(), entries: activeEntries.length })}</span>
        </div>
        <p className={styles.note}>{t('tokenReportNote')}</p>

        {error ? (
          <p className={styles.error}>{t('tokenReportError')}</p>
        ) : loading ? (
          <div className={styles.loading}><Spinner size={16} fast />{t('tokenReportLoadingEntries')}</div>
        ) : entries.length === 0 ? (
          <p className={styles.empty}>{t('tokenReportEmpty')}</p>
        ) : (
          <>
            <section className={styles.entries} aria-label={t('tokenReportActiveBreakdown')}>
              <h3>{t('tokenReportActiveBreakdown')}</h3>
              {activeEntries.length > 0 ? renderEntries(activeEntries) : <p className={styles.empty}>{t('tokenReportNoActiveEntries')}</p>}
            </section>
            {disabledEntries.length > 0 && (
              <section className={styles.entries} aria-label={t('tokenReportDisabledTotal', { count: disabledTotal.toLocaleString() })}>
                <h3>{t('tokenReportDisabledTotal', { count: disabledTotal.toLocaleString() })}</h3>
                {renderEntries(disabledEntries)}
              </section>
            )}
          </>
        )}

        {hasApproximation && !loading && <p className={styles.approximation}>{t('tokenReportApproximation')}</p>}
      </div>
    </ModalShell>
  )
}

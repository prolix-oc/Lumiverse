import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Hash } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Spinner } from '@/components/shared/Spinner'
import { tokenizersApi } from '@/api/tokenizers'
import { useStore } from '@/store'
import styles from './CharacterTokenReportModal.module.css'

export interface CharacterTokenReportItem {
  id: string
  label: string
  text: string
  group: 'base' | 'variant' | 'greeting'
}

interface Props {
  isOpen: boolean
  onClose: () => void
  characterName: string
  items: CharacterTokenReportItem[]
}

interface CountResult {
  count: number
  approximate: boolean
}

function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4)
}

export default function CharacterTokenReportModal({ isOpen, onClose, characterName, items }: Props) {
  const { t } = useTranslation('panels')
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const [counts, setCounts] = useState<Record<string, CountResult>>({})
  const [loading, setLoading] = useState(false)
  const requestRef = useRef(0)

  const profileModel = useMemo(() => (
    profiles.find((profile) => profile.id === activeProfileId)?.model
      ?? profiles.find((profile) => profile.is_default)?.model
      ?? null
  ), [activeProfileId, profiles])

  const countItems = useCallback(async () => {
    const requestId = requestRef.current + 1
    requestRef.current = requestId
    setLoading(true)

    const results = await Promise.all(items.map(async (item): Promise<[string, CountResult]> => {
      if (!item.text.trim()) return [item.id, { count: 0, approximate: false }]
      try {
        if (profileModel) {
          const result = await tokenizersApi.countForModel(profileModel, item.text)
          if (result.token_count != null) return [item.id, { count: result.token_count, approximate: false }]
        }
      } catch {
        // Use the same local estimate as the per-field count control.
      }
      return [item.id, { count: approximateTokenCount(item.text), approximate: true }]
    }))

    if (requestId !== requestRef.current) return
    setCounts(Object.fromEntries(results))
    setLoading(false)
  }, [items, profileModel])

  useEffect(() => {
    if (!isOpen) return
    void countItems()
  }, [isOpen, countItems])

  const groups = useMemo(() => ({
    base: items.filter((item) => item.group === 'base'),
    variant: items.filter((item) => item.group === 'variant'),
    greeting: items.filter((item) => item.group === 'greeting'),
  }), [items])

  const allCounted = items.length > 0 && items.every((item) => counts[item.id] != null)
  const total = items.reduce((sum, item) => sum + (counts[item.id]?.count ?? 0), 0)
  const hasApproximation = items.some((item) => counts[item.id]?.approximate)

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} maxWidth={460} zIndex={10003}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{t('characterEditor.tokenReportTitle')}</h2>
          <p className={styles.subtitle}>{characterName}</p>
        </div>
        <CloseButton onClick={onClose} size="sm" />
      </div>

      <div className={styles.body}>
        <div className={styles.summary}>
          <Hash size={15} />
          <span>{loading || !allCounted ? t('characterEditor.tokenReportCounting') : t('characterEditor.tokenReportTotal', { count: total.toLocaleString() })}</span>
        </div>
        <p className={styles.note}>{t('characterEditor.tokenReportNote')}</p>

        <ReportGroup label={t('characterEditor.tokenReportBase')} items={groups.base} counts={counts} loading={loading} />
        {groups.variant.length > 0 && <ReportGroup label={t('characterEditor.tokenReportVariants')} items={groups.variant} counts={counts} loading={loading} />}
        <ReportGroup label={t('characterEditor.tokenReportGreetings')} items={groups.greeting} counts={counts} loading={loading} />

        {hasApproximation && !loading && <p className={styles.approximation}>{t('characterEditor.tokenReportApproximation')}</p>}
      </div>
    </ModalShell>
  )
}

function ReportGroup({ label, items, counts, loading }: {
  label: string
  items: CharacterTokenReportItem[]
  counts: Record<string, CountResult>
  loading: boolean
}) {
  return (
    <section className={styles.group}>
      <h3>{label}</h3>
      <div className={styles.rows}>
        {items.map((item) => {
          const result = counts[item.id]
          return (
            <div className={styles.row} key={item.id}>
              <span>{item.label}</span>
              {loading || !result
                ? <Spinner size={12} fast />
                : <span className={styles.count}>{result.approximate ? '~' : ''}{result.count.toLocaleString()}</span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}

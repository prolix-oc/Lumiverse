import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as weaverApi from '@/api/weaver'
import type { WeaverTuning } from '@/api/weaver'
import { Btn, IconBtn } from './primitives'
import styles from './WeaverStudio.module.css'

const COUNT_FIELDS = [
  'propose_count',
  'named_question_target',
  'dynamic_question_cap',
  'harvest_cap',
] as const
const TEMP_FIELDS = ['generation_temperature', 'review_temperature'] as const
const SECONDS_FIELDS = ['text_timeout_seconds'] as const
type TuningField =
  | (typeof COUNT_FIELDS)[number]
  | (typeof TEMP_FIELDS)[number]
  | (typeof SECONDS_FIELDS)[number]

const ALL_FIELDS = [...COUNT_FIELDS, ...TEMP_FIELDS, ...SECONDS_FIELDS] as const

type Drafts = Record<TuningField, string>

function toDrafts(tuning: WeaverTuning): Drafts {
  const out = {} as Drafts
  for (const f of ALL_FIELDS) {
    const v = tuning[f]
    out[f] = v == null ? '' : String(v)
  }
  return out
}

export function TuningPane({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation('weaver')
  const [drafts, setDrafts] = useState<Drafts | null>(null)
  const [defaults, setDefaults] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    weaverApi.getTuning()
      .then((r) => { setDrafts(toDrafts(r.tuning)); setDefaults(r.defaults) })
      .catch(() => setError(t('tuning.loadFailed')))
  }, [t])

  const save = async () => {
    if (!drafts || busy) return
    setBusy(true); setError(null); setSaved(false)
    const payload: Record<string, number | null> = {}
    for (const f of ALL_FIELDS) {
      const raw = drafts[f].trim()
      payload[f] = raw === '' ? null : Number(raw)
    }
    try {
      const r = await weaverApi.putTuning(payload)
      setDrafts(toDrafts(r.tuning))
      setDefaults(r.defaults)
      setSaved(true)
    } catch {
      setError(t('tuning.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const field = (f: TuningField, step: string, max: string, min = '0') => {
    const overridden = (drafts?.[f] ?? '').trim() !== ''
    return (
      <div key={f} className={styles.tuningRow}>
        <div className={styles.tuningText}>
          <label className={styles.tuningName} htmlFor={`tuning-${f}`}>
            {t(`tuning.fields.${f}`)}
          </label>
          <span className={styles.tuningHint}>{t(`tuning.hints.${f}`)}</span>
        </div>
        <input
          id={`tuning-${f}`}
          className={`${styles.toolin} ${styles.tuningInput} ${overridden ? styles.tuningSet : ''}`}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={drafts?.[f] ?? ''}
          placeholder={defaults[f] != null ? t('tuning.defaultPlaceholder', { value: defaults[f] }) : t('tuning.modelDefault')}
          onChange={(e) => { setSaved(false); setDrafts((d) => (d ? { ...d, [f]: e.target.value } : d)) }}
        />
      </div>
    )
  }

  return (
    <div className={styles.dashPaneInner}>
      <div className={styles.cardPaneHead}>
        <span className={styles.cardPaneTitle}>{t('tuning.title')}</span>
        <span className={styles.cardPaneCount}>{t('tuning.subtitle')}</span>
        <div className={styles.spacer} />
        <IconBtn icon="x" title={t('tuning.back')} onClick={onBack} />
      </div>

      {!drafts ? (
        <p className={styles.stageHelp}>{error ?? t('tuning.loading')}</p>
      ) : (
        <>
          <section>
            <div className={styles.bandLabel}>{t('tuning.bands.flow')}</div>
            <p className={styles.tuningBandHelp}>{t('tuning.intro')}</p>
            {COUNT_FIELDS.map((f) => field(f, '1', '50'))}
          </section>

          <section>
            <div className={styles.bandLabel}>{t('tuning.bands.model')}</div>
            <p className={styles.tuningBandHelp}>{t('tuning.tempsIntro')}</p>
            {TEMP_FIELDS.map((f) => field(f, '0.1', '2'))}
          </section>

          <section>
            <div className={styles.bandLabel}>{t('tuning.bands.reliability')}</div>
            <p className={styles.tuningBandHelp}>{t('tuning.reliabilityIntro')}</p>
            {SECONDS_FIELDS.map((f) => field(f, '10', '1200', '30'))}
          </section>

          <section>
            <div className={styles.toolRow}>
              {error && <span className={styles.errorText}>{error}</span>}
              {saved && !error && <span className={styles.tuningSaved}>{t('tuning.savedNote')}</span>}
              <div className={styles.spacer} />
              <Btn onClick={onBack}>{t('tuning.back')}</Btn>
              <Btn variant="primary" icon={busy ? 'refresh' : 'check'} spin={busy} disabled={busy} onClick={() => void save()}>
                {t('tuning.save')}
              </Btn>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

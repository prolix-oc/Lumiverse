import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as weaverApi from '@/api/weaver'
import type { WeaverAgencyState, WeaverSession } from '@/api/weaver'
import { Band, Btn, Icon } from '../primitives'
import styles from '../WeaverStudio.module.css'

function agencyErrMsg(err: unknown, fallback: string): string {
  const body = (err as { body?: { error?: string } } | null)?.body
  return body?.error ?? (err instanceof Error ? err.message : fallback)
}

export function AgencyBand({ session, agency, onMutated }: {
  session: WeaverSession
  agency: WeaverAgencyState
  onMutated: () => void
}) {
  const { t } = useTranslation('weaver')
  const [editing, setEditing] = useState(false)
  const [agendaDraft, setAgendaDraft] = useState('')
  const [holdsDraft, setHoldsDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const startEdit = () => {
    setAgendaDraft(agency.agenda)
    setHoldsDraft(agency.holds.join('\n'))
    setEditing(true)
    setError(null)
  }

  const save = async () => {
    if (!agendaDraft.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await weaverApi.updateAgency(session.id, {
        agenda: agendaDraft.trim(),
        holds: holdsDraft.split('\n').map((h) => h.trim()).filter(Boolean),
      })
      setEditing(false)
      onMutated()
    } catch (err) {
      setError(agencyErrMsg(err, t('agency.updateFailed')))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (enabled: boolean) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await weaverApi.setAgencyEnabled(session.id, enabled)
      onMutated()
    } catch (err) {
      setError(agencyErrMsg(err, t('agency.toggleFailed')))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Band label={t('agency.band')} count={agency.enabled ? t('agency.on') : t('agency.off')}>
      {editing ? (
        <>
          <div className={styles.agRow}>
            <span className={styles.agRowLabel}>{t('agency.agenda')}</span>
            <input
              className={styles.toolin}
              value={agendaDraft}
              placeholder={t('agency.agendaPlaceholder')}
              onChange={(e) => setAgendaDraft(e.target.value)}
            />
            <span />
          </div>
          <div className={styles.agRow}>
            <span className={styles.agRowLabel}>{t('agency.holds')}</span>
            <textarea
              className={styles.wwAnsField}
              rows={3}
              value={holdsDraft}
              placeholder={t('agency.holdsPlaceholder')}
              onChange={(e) => setHoldsDraft(e.target.value)}
            />
            <span />
          </div>
          <div className={styles.toolRow} style={{ marginTop: 8 }}>
            <span className={styles.agGov}>{t('agency.govNote')}</span>
            <div className={styles.spacer} />
            <Btn disabled={busy} onClick={() => setEditing(false)}>{t('agency.cancel')}</Btn>
            <Btn
              variant="primary"
              icon={busy ? 'refresh' : 'check'}
              spin={busy}
              disabled={!agendaDraft.trim() || busy}
              onClick={() => void save()}
            >
              {t('agency.save')}
            </Btn>
          </div>
        </>
      ) : !agency.enabled ? (
        <div className={styles.agOffRow}>
          <Icon name="shield" size={14} />
          <span>
            {t('agency.offLine')}{' '}
            <span className={styles.agGov}>{t('agency.offHint')}</span>
          </span>
          <div className={styles.spacer} />
          <Btn
            disabled={busy}
            onClick={() => { if (agency.present) void toggle(true); else startEdit() }}
          >
            {t('agency.turnOn')}
          </Btn>
        </div>
      ) : (
        <>
          <div className={styles.agRow}>
            <span className={styles.agRowLabel}>{t('agency.agenda')}</span>
            <span className={styles.agRowText}>{agency.agenda || t('agency.noAgenda')}</span>
            <Btn className={styles.btnTiny} onClick={startEdit}>{t('agency.edit')}</Btn>
          </div>
          <div className={styles.agRow}>
            <span className={styles.agRowLabel}>{t('agency.holds')}</span>
            {agency.holds.length > 0 ? (
              <span className={styles.agHolds}>
                {agency.holds.map((hold) => (
                  <span key={hold} className={styles.agHold}>
                    <Icon name="shield" size={12} />
                    {hold}
                  </span>
                ))}
              </span>
            ) : (
              <span className={styles.agRowText}>{t('agency.noHolds')}</span>
            )}
            <Btn className={styles.btnTiny} icon="plus" onClick={startEdit}>{t('agency.addHold')}</Btn>
          </div>
          <div className={styles.agRow} style={{ borderBottom: 'none' }}>
            <span />
            <span className={styles.agGov}>{t('agency.govNote')}</span>
            <Btn className={styles.btnTiny} disabled={busy} onClick={() => void toggle(false)}>
              {t('agency.turnOff')}
            </Btn>
          </div>
        </>
      )}
      {error && <p className={styles.errorText}>{error}</p>}
    </Band>
  )
}

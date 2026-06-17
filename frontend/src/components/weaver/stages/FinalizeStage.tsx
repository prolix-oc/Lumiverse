import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import type { WeaverFieldDef, WeaverSession } from '@/api/weaver'
import { Band, Btn, SDot, Tag } from '../primitives'
import styles from '../WeaverStudio.module.css'

export function FinalizeStage({ session, onBack, onOpenStudio }: { session: WeaverSession; onBack: () => void; onOpenStudio: () => void }) {
  const { t } = useTranslation('weaver')
  const finalizing = useStore((s) => s.weaverFinalizing)
  const startingChat = useStore((s) => s.weaverStartingChat)
  const error = useStore((s) => s.weaverFinalizeError)
  const result = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverFinalizeResult : null))
  const fields = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverFields : []))
  const fieldDefs = useStore((s) => s.weaverFieldDefs)
  const finalize = useStore((s) => s.finalizeWeaver)
  const startChat = useStore((s) => s.startWeaverChat)
  const navigate = useNavigate()
  const closeModal = useStore((s) => s.closeModal)
  const loadFields = useStore((s) => s.loadWeaverFields)
  const loadFieldDefs = useStore((s) => s.loadWeaverFieldDefs)
  const bible = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverBible : null))
  const loadBible = useStore((s) => s.loadWeaverBible)
  const bookRoles = useStore((s) => s.weaverBookRoles)
  const [bookChoices, setBookChoices] = useState<Record<string, boolean>>({})
  const bookEnabled = (role: { id: string; defaultEnabled: boolean }) =>
    bookChoices[role.id] ?? role.defaultEnabled

  useEffect(() => {
    void loadFieldDefs(session.build_type)
    void loadFields(session.id)
    void loadBible(session.id)
  }, [session.id, session.build_type, loadFieldDefs, loadFields, loadBible])

  const dynamicCount = bible?.spine.dynamic.length ?? 0

  const orderedDefs = useMemo(() => [...fieldDefs].sort((a, b) => a.order - b.order), [fieldDefs])
  const fieldBy = useMemo(() => new Map(fields.map((f) => [f.field_name, f])), [fields])
  const isReady = (def: WeaverFieldDef) => {
    const f = fieldBy.get(def.id)
    return Boolean(f && f.content.trim() && (f.status === 'passed' || f.status === 'manually_edited' || f.provenance.accepted === true))
  }
  const allReady = orderedDefs.length > 0 && orderedDefs.every(isReady)
  const finalized = Boolean(result) || session.status === 'finalized'
  const cardName = result?.character.name ?? (fieldBy.get('name')?.content.trim() || t('finalize.untitled'))

  const onStart = async () => {
    try {
      const r = await startChat(session.id)
      closeModal()
      navigate(`/chat/${r.chat.id}`)
    } catch {
    }
  }

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.stageHead}>
          <div className={styles.stageHeadL}>
            <h2 className={styles.stageH}>{t('finalize.heading')}</h2>
            <p className={styles.stageHelp}>{finalized ? t('finalize.doneHelp') : t('finalize.help')}</p>
          </div>
        </div>
        <div className={styles.scroll}>
          {error && <p className={styles.errorText}>{error}</p>}

          {finalized ? (
            <Band label={t('finalize.cardBandLabel')}>
              <div className={styles.fieldNameBig}>{cardName}</div>
              <p className={styles.stageHelp}>{t('finalize.doneBody')}</p>
              <div className={styles.railLegend}>
                <span className={styles.railLegendRow}><Tag kind="success" icon="check">{t('finalize.tagCard')}</Tag></span>
                <span className={styles.railLegendRow}><Tag kind="neutral" icon="shield">{t('finalize.tagPreset')}</Tag></span>
                {bookRoles.filter((r) => result?.books?.[r.id]).map((r) => (
                  <span key={r.id} className={styles.railLegendRow}>
                    <Tag kind="success" icon="check">{t(`finalize.bookBound.${r.id}`, { defaultValue: r.label })}</Tag>
                  </span>
                ))}
              </div>
              {bookRoles.filter((r) => result?.book_errors?.[r.id]).map((r) => (
                <p key={r.id} className={styles.errorText}>
                  {t(`finalize.bookError.${r.id}`, { error: result?.book_errors?.[r.id], defaultValue: result?.book_errors?.[r.id] })}
                </p>
              ))}
            </Band>
          ) : (
            <>
              <Band label={t('finalize.readyBandLabel', { count: orderedDefs.length })}>
                <div className={styles.railList}>
                  {orderedDefs.map((def) => (
                    <div key={def.id} className={styles.railItem}>
                      <span className={styles.railMarker}><SDot status={isReady(def) ? 'passed' : 'none'} /></span>
                      <span className={styles.railName}>{def.label}</span>
                      {!isReady(def) && <Tag kind="warning">{t('finalize.pending')}</Tag>}
                    </div>
                  ))}
                </div>
              </Band>
              {dynamicCount > 0 && bookRoles.map((role) => (
                <Band key={role.id} label={t(`finalize.bookBand.${role.id}`, { defaultValue: role.label })} count={dynamicCount}>
                  <label className={styles.checkRow}>
                    <input
                      type="checkbox"
                      checked={bookEnabled(role)}
                      onChange={(e) => setBookChoices((prev) => ({ ...prev, [role.id]: e.target.checked }))}
                    />
                    <span>{t(`finalize.bookToggle.${role.id}`, { defaultValue: role.label })}</span>
                  </label>
                  <p className={styles.stageHelp}>{t(`finalize.bookBody.${role.id}`, { defaultValue: '' })}</p>
                </Band>
              ))}
              <Band label={t('finalize.governanceBandLabel')}>
                <p className={styles.stageHelp}>{t('finalize.governanceBody')}</p>
              </Band>
            </>
          )}
        </div>
      </div>
      <div className={styles.footer}>
        <Btn icon="arrowLeft" onClick={onBack}>{t('finalize.backToRender')}</Btn>
        <div className={styles.spacer} />
        {finalized ? (
          <>
            <Btn
              icon={finalizing ? 'refresh' : 'check'}
              spin={finalizing}
              disabled={!allReady || finalizing}
              title={allReady ? t('finalize.update') : t('finalize.blocked')}
              onClick={() => void finalize(session.id, { books: Object.fromEntries(bookRoles.map((r) => [r.id, bookEnabled(r)])) })}
            >
              {finalizing ? t('finalize.updating') : t('finalize.update')}
            </Btn>
            <Btn icon={startingChat ? 'refresh' : 'chat'} spin={startingChat} disabled={startingChat} onClick={() => void onStart()}>
              {t('finalize.startChat')}
            </Btn>
            <Btn variant="primary" iconRight="arrowRight" onClick={onOpenStudio}>
              {t('finalize.continueToStudio')}
            </Btn>
          </>
        ) : (
          <Btn
            variant="primary"
            icon={finalizing ? 'refresh' : 'check'}
            spin={finalizing}
            disabled={!allReady || finalizing}
            title={allReady ? t('finalize.finalize') : t('finalize.blocked')}
            onClick={() => void finalize(session.id, { books: Object.fromEntries(bookRoles.map((r) => [r.id, bookEnabled(r)])) })}
          >
            {finalizing ? t('finalize.finalizing') : t('finalize.finalize')}
          </Btn>
        )}
      </div>
    </>
  )
}

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { WeaverBibleEntry, WeaverSession } from '@/api/weaver'
import { Band, Btn, EditableProse, FlagBand, Icon, OriginTag, Placeholder, StageRunning } from '../primitives'
import styles from '../WeaverStudio.module.css'

export function BibleStage({ session, onBack, onContinue }: { session: WeaverSession; onBack: () => void; onContinue: () => void }) {
  const { t } = useTranslation('weaver')
  const slots = useStore((s) => s.weaverSlots)
  const slotGroups = useStore((s) => s.weaverSlotGroups)
  const owns = useStore((s) => s.weaverStateSessionId === session.id)
  const bible = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverBible : null))
  const running = useStore((s) => s.weaverBibleRunning)
  const error = useStore((s) => s.weaverBibleError)
  const loadBible = useStore((s) => s.loadWeaverBible)
  const synthesize = useStore((s) => s.synthesizeWeaverBible)
  const gate = useStore((s) => s.gateWeaverBible)
  const saveBible = useStore((s) => s.saveWeaverBible)

  const [loading, setLoading] = useState(true)
  const [entries, setEntries] = useState<WeaverBibleEntry[]>([])
  const [brief, setBrief] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setLoading(true)
    void loadBible(session.id).finally(() => setLoading(false))
  }, [session.id, loadBible])

  useEffect(() => {
    if (bible) {
      setEntries(bible.spine.entries)
      setBrief(bible.spine.brief)
      setDirty(false)
    }
  }, [bible])

  const labelFor = (slotId: string) => slots.find((s) => s.id === slotId)?.label ?? slotId
  const partLabelFor = (slotId: string, partId: string) =>
    slots.find((s) => s.id === slotId)?.parts?.find((p) => p.id === partId)?.label ?? partId

  const editEntry = (slot: string, value: string) => {
    setEntries((prev) => prev.map((e) => (e.slot === slot ? { ...e, content: value } : e)))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveBible(session.id, { entries, brief })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  if (loading && !bible) {
    return (
      <>
        <div className={styles.panel}><Placeholder icon="refresh" spin>{t('bible.building')}</Placeholder></div>
        <div className={styles.footer}><Btn icon="arrowLeft" onClick={onBack}>{t('bible.backToInterview')}</Btn><div className={styles.spacer} /></div>
      </>
    )
  }

  if (running && !bible) {
    return <StageRunning label={t('bible.building')} icon="bookOpen" onBack={onBack} backLabel={t('bible.backToInterview')} />
  }

  if (owns && !bible) {
    return (
      <>
        <div className={styles.panel}>
          <div className={styles.stageHead}>
            <div className={styles.stageHeadL}>
              <h2 className={styles.stageH}>{t('bible.introTitle')}</h2>
              <p className={styles.stageHelp}>{t('bible.intro')}</p>
            </div>
          </div>
          {error && <p className={styles.errorText}>{error}</p>}
        </div>
        <div className={styles.footer}>
          <Btn icon="arrowLeft" onClick={onBack}>{t('bible.backToInterview')}</Btn>
          <div className={styles.spacer} />
          <Btn variant="primary" icon="bookOpen" disabled={running} onClick={() => void synthesize(session.id)}>{t('bible.build')}</Btn>
        </div>
      </>
    )
  }

  if (!bible) return null

  const edited = dirty || bible.status === 'pending'
  const passed = bible.status === 'gated'
  const failedCrit = bible.gate ? bible.gate.criteria.filter((c) => !c.passed) : []
  const flagged = bible.status === 'flagged' && !edited

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.stageHead}>
          <div className={styles.stageHeadL}>
            <h2 className={styles.stageH}>{t('bible.heading')}</h2>
            <p className={styles.stageHelp}>{t('bible.help')}</p>
          </div>
          <div className={styles.spend}>{t('bible.spend', { count: bible.token_usage.total_tokens, calls: bible.token_usage.calls })}</div>
        </div>
        <div className={styles.scroll}>
          {error && <p className={styles.errorText}>{error}</p>}
          <div className={styles.work}>
            <div className={styles.workRail}>
              <div>
                <div className={styles.railGroupLabel}>{t('bible.gateTitle')}</div>
                <div className={clsx(styles.gateStatus, edited ? styles.gateStatusEdited : passed ? styles.gateStatusPass : styles.gateStatusFlagged)}>
                  {edited ? <><Icon name="pencil" size={16} /> {t('bible.gatePending')}</>
                    : passed ? <><Icon name="shield" size={16} /> {t('bible.gatePassed')}</>
                    : <><Icon name="alert" size={16} /> {t('bible.gateFlagged')}</>}
                </div>
                {edited ? (
                  <p className={styles.gateSummary}>{t('bible.gateEditedHint')}</p>
                ) : bible.gate ? (
                  <p className={styles.gateSummary}>
                    {failedCrit.length > 0
                      ? t('bible.gateScored', { total: bible.gate.criteria.length, fail: failedCrit.length })
                      : t('bible.gateAllPass')}
                  </p>
                ) : null}
                {!edited && bible.gate && (
                  <div className={styles.critList}>
                    {bible.gate.criteria.map((c) => (
                      <div className={styles.crit} key={c.key}>
                        <Icon name={c.passed ? 'check' : 'alert'} size={15} className={clsx(styles.critIcn, c.passed ? styles.critIcnPass : styles.critIcnFail)} />
                        <div className={styles.critL}>
                          <div className={styles.critLabel}>{c.label}</div>
                          {c.note && <div className={styles.critNote}>{c.note}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className={styles.workMain}>
              {flagged && (
                <FlagBand
                  subject={t('bible.flagSubject')}
                  criteria={failedCrit.map((c) => c.label)}
                  detail={bible.gate?.summary}
                  fix={failedCrit.length > 0
                    ? t('bible.flagFix', { criteria: failedCrit.map((c) => c.label).join(', ') })
                    : t('bible.flagFixGeneric')}
                  note={t('render.noRetryNote')}
                />
              )}
              <Band label={t('bible.briefTitle')}>
                <EditableProse value={brief} onChange={(v) => { setBrief(v); setDirty(true) }} />
              </Band>
              {slotGroups.map((group) => {
                const groupEntries = entries.filter(
                  (e) => (slots.find((s) => s.id === e.slot)?.synthesisGroup ?? slotGroups[0]?.id) === group.id,
                )
                if (groupEntries.length === 0) return null
                return (
                  <Band key={group.id} label={t(`bible.group.${group.id}`, group.label)}>
                    <div className={styles.ledger}>
                      {groupEntries.map((entry) => (
                        <div className={styles.ledgerRow} key={entry.slot}>
                          <div className={clsx(styles.ledgerCell, styles.ledgerLabel)}><span>{labelFor(entry.slot)}</span></div>
                          <div className={clsx(styles.ledgerCell, styles.ledgerContent)}>
                            {entry.parts && entry.parts.length > 0 ? (
                              <div className={styles.partProvenance}>
                                {entry.parts.map((p) => (
                                  <span className={styles.partProvItem} key={p.id}>
                                    <span className={styles.partProvLabel}>{partLabelFor(entry.slot, p.id)}</span>
                                    <OriginTag origin={p.origin} />
                                  </span>
                                ))}
                              </div>
                            ) : (
                              entry.origin !== 'established' && <div><OriginTag origin={entry.origin} /></div>
                            )}
                            <EditableProse value={entry.content} onChange={(v) => editEntry(entry.slot, v)} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </Band>
                )
              })}
              {bible.spine.causal_links.length > 0 && (
                <Band label={t('bible.connectsTitle')} count={t('bible.linkCount', { count: bible.spine.causal_links.length })}>
                  <div className={styles.links}>
                    {bible.spine.causal_links.map((link, i) => (
                      <div className={styles.link} key={i}>
                        <span className={styles.linkSlot}>{labelFor(link.from)}</span>
                        <span className={styles.linkArrow}><Icon name="arrowRight" size={13} /></span>
                        <span className={styles.linkRel}>{link.relation}</span>
                        <span className={styles.linkArrow}><Icon name="arrowRight" size={13} /></span>
                        <span className={styles.linkSlot}>{labelFor(link.to)}</span>
                      </div>
                    ))}
                  </div>
                </Band>
              )}
              {bible.spine.dynamic.length > 0 && (
                <Band label={t('bible.depthTitle')} count={t('bible.depthCount', { count: bible.spine.dynamic.length })}>
                  <p className={styles.stageHelp}>{t('bible.depthHint')}</p>
                  <div className={styles.ledger}>
                    {bible.spine.dynamic.map((d) => (
                      <div className={styles.ledgerRow} key={d.id}>
                        <div className={clsx(styles.ledgerCell, styles.ledgerLabel)}><span>{d.question || t('bible.depthNote')}</span></div>
                        <div className={clsx(styles.ledgerCell, styles.ledgerContent)}>
                          <span className={styles.originProse}>{d.content}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </Band>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <Btn icon="arrowLeft" onClick={onBack}>{t('bible.backToInterview')}</Btn>
        <Btn icon="refresh" onClick={() => void synthesize(session.id)} disabled={running} title={t('bible.rebuildHint')}>{t('bible.rebuild')}</Btn>
        <div className={styles.spacer} />
        {dirty ? (
          <Btn variant="primary" icon="check" disabled={saving} onClick={() => void handleSave()}>{saving ? t('bible.saving') : t('bible.save')}</Btn>
        ) : (
          <>
            <Btn icon="shield" disabled={running} onClick={() => void gate(session.id)} title={t('bible.recheckHint')}>{running ? t('bible.checking') : t('bible.recheck')}</Btn>
            <Btn variant="primary" iconRight="arrowRight" onClick={onContinue} title={bible.status === 'flagged' ? t('bible.continueFlaggedHint') : undefined}>{t('bible.continueToRender')}</Btn>
          </>
        )}
      </div>
    </>
  )
}

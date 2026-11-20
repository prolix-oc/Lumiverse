import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { WeaverCommittedFact, WeaverGap, WeaverSession } from '@/api/weaver'
import { Band, Btn, FactLine, Icon, IconBtn, Placeholder, SDot, StageRunning } from '../primitives'
import styles from '../WeaverStudio.module.css'

interface ReadbackStageProps {
  session: WeaverSession
  onBack: () => void
  onContinue: () => void
}
export function ReadbackStage({ session, onBack, onContinue }: ReadbackStageProps) {
  const { t } = useTranslation('weaver')
  const slots = useStore((s) => s.weaverSlots)
  const extraction = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverExtraction : null))
  const loadExtraction = useStore((s) => s.loadWeaverExtraction)
  const saveExtraction = useStore((s) => s.saveWeaverExtraction)
  const runReadback = useStore((s) => s.runWeaverReadback)
  const readbackRunning = useStore((s) => s.weaverReadbackRunning)

  const [facts, setFacts] = useState<WeaverCommittedFact[]>([])
  const [gaps, setGaps] = useState<WeaverGap[]>([])
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => { void loadExtraction(session.id) }, [session.id, loadExtraction])

  useEffect(() => {
    setFacts(extraction?.committed_facts ?? [])
    setGaps(extraction?.gaps ?? [])
    setDirty(false)
  }, [extraction])

  const labelFor = (slotId: string) => slots.find((s) => s.id === slotId)?.label ?? slotId
  const factsBySlot = useMemo(() => {
    const m = new Map<string, number[]>()
    facts.forEach((f, i) => { const arr = m.get(f.slot) ?? []; arr.push(i); m.set(f.slot, arr) })
    return m
  }, [facts])

  const partsOf = (slotId: string): { id: string; label: string; fill: string }[] => {
    const s = slots.find((sl) => sl.id === slotId)
    if (!s) return []
    if (s.parts && s.parts.length > 0) return s.parts
    return [{ id: s.id, label: s.label, fill: s.fill }]
  }
  const gapClass = (slotId: string): 'elicit' | 'generate' | 'mixed' => {
    const ps = partsOf(slotId)
    const hasElicit = ps.some((p) => p.fill === 'elicit')
    const hasGenerate = ps.some((p) => p.fill === 'generate')
    return hasElicit && hasGenerate ? 'mixed' : hasElicit ? 'elicit' : 'generate'
  }
  const partLabels = (slotId: string, fill: string) =>
    partsOf(slotId).filter((p) => p.fill === fill).map((p) => p.label).join(', ')
  const isOptional = (slotId: string) => slots.find((s) => s.id === slotId)?.optional === true

  const slotStatus = (slotId: string): string => {
    const idxs = factsBySlot.get(slotId) ?? []
    if (idxs.some((i) => facts[i].fact.trim())) return 'committed'
    return gapClass(slotId)
  }

  const factSlots = useMemo(
    () => slots.filter((s) => (factsBySlot.get(s.id) ?? []).length > 0),
    [slots, factsBySlot],
  )
  const askGaps = useMemo(() => gaps.filter((g) => gapClass(g.slot) === 'elicit'), [gaps, slots]) // eslint-disable-line react-hooks/exhaustive-deps
  const mixedGaps = useMemo(() => gaps.filter((g) => gapClass(g.slot) === 'mixed'), [gaps, slots]) // eslint-disable-line react-hooks/exhaustive-deps
  const writeGaps = useMemo(() => gaps.filter((g) => gapClass(g.slot) === 'generate'), [gaps, slots]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateFact = (index: number, value: string) => {
    setFacts((prev) => prev.map((f, i) => (i === index ? { ...f, fact: value, source: 'user' } : f)))
    setDirty(true)
  }
  const deleteFact = (index: number) => {
    setFacts((prev) => prev.filter((_, i) => i !== index))
    setDirty(true)
  }
  const addFact = (slot: string) => {
    setFacts((prev) => [...prev, { slot, fact: '', source: 'user' as const }])
    setGaps((prev) => prev.filter((g) => g.slot !== slot))
    setDirty(true)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await saveExtraction(session.id, { committed_facts: facts.filter((f) => f.fact.trim()), gaps })
      setDirty(false)
    } finally {
      setSaving(false)
    }
  }

  if (readbackRunning && !extraction) {
    return <StageRunning label={t('readback.running')} onBack={onBack} backLabel={t('readback.backToDream')} />
  }

  if (!extraction) {
    return (
      <>
        <div className={styles.panel}>
          <Placeholder icon="alert">{t('readback.none')}</Placeholder>
        </div>
        <div className={styles.footer}>
          <Btn icon="arrowLeft" onClick={onBack}>{t('readback.backToDream')}</Btn>
          <div className={styles.spacer} />
        </div>
      </>
    )
  }

  const miniFor = (status: string) =>
    status === 'committed'
      ? <span className={clsx(styles.railMini, styles.railMiniCommitted)}>{t('readback.miniCommitted')}</span>
      : status === 'elicit'
        ? <span className={clsx(styles.railMini, styles.railMiniElicit)}>{t('readback.miniInterview')}</span>
        : status === 'mixed'
          ? <span className={clsx(styles.railMini, styles.railMiniMixed)}>{t('readback.miniMixed')}</span>
          : <span className={clsx(styles.railMini, styles.railMiniWrite)}>{t('readback.miniWrite')}</span>

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.stageHead}>
          <div className={styles.stageHeadL}>
            <h2 className={styles.stageH}>{t('readback.heading')}</h2>
            <p className={styles.stageHelp}>{t('readback.intro')}</p>
          </div>
        </div>
        <div className={styles.scroll}>
          <div className={styles.work}>
            <div className={styles.workRail}>
              <div>
                <div className={styles.railGroupLabel}>{t('readback.spineRail', { count: slots.length })}</div>
                <div className={styles.railKey}>
                  <span className={styles.railKeyRow}><span className={clsx(styles.sdot, styles.sdotCommitted)} /> {t('readback.keyCommitted')}</span>
                  <span className={styles.railKeyRow}><span className={clsx(styles.sdot, styles.sdotElicit)} /> {t('readback.keyAsked')}</span>
                  <span className={styles.railKeyRow}><span className={clsx(styles.sdot, styles.sdotMixed)} /> {t('readback.keyMixed')}</span>
                  <span className={styles.railKeyRow}><span className={clsx(styles.sdot, styles.sdotGenerate)} /> {t('readback.keyWrites')}</span>
                </div>
                <div className={styles.railList} style={{ marginTop: 12 }}>
                  {slots.map((s) => {
                    const st = slotStatus(s.id)
                    return (
                      <div key={s.id} className={styles.railItem} style={{ cursor: 'default' }}>
                        <span className={styles.railMarker}><SDot status={st} /></span>
                        <span className={styles.railName}>{s.label}</span>
                        {miniFor(st)}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>

            <div className={styles.workMain}>
              <Band label={t('readback.fromDreamTitle')} count={t('readback.slotCount', { count: factSlots.length })}>
                <div className={styles.ledger}>
                  {factSlots.map((slot) => (
                    <div className={styles.ledgerRow} key={slot.id}>
                      <div className={clsx(styles.ledgerCell, styles.ledgerLabel)}>
                        <span>{slot.label}</span>
                        <IconBtn icon="plus" size={14} cls={styles.sq22} title={t('readback.addFact')} onClick={() => addFact(slot.id)} />
                      </div>
                      <div className={clsx(styles.ledgerCell, styles.ledgerContent)}>
                        {(factsBySlot.get(slot.id) ?? []).map((i) => (
                          <FactLine key={i} value={facts[i].fact} empty={!facts[i].fact} onChange={(v) => updateFact(i, v)} onDelete={() => deleteFact(i)} />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Band>

              {(askGaps.length > 0 || mixedGaps.length > 0 || writeGaps.length > 0) && (
                <Band label={t('readback.nextTitle')}>
                  {askGaps.length > 0 && (
                    <div className={styles.chipGroup}>
                      <p className={styles.chipGroupLabel}>{t('readback.willAskGroup')}</p>
                      <div className={styles.chips}>
                        {askGaps.map((g) => (
                          <button key={g.slot} className={styles.chip} title={t('readback.pinYourself')} onClick={() => addFact(g.slot)}>
                            <Icon name="penLine" size={13} className={styles.chipIcn} />{labelFor(g.slot)}
                            {isOptional(g.slot) && <span className={clsx(styles.tag, styles.tagNeutral)}>{t('readback.detectedTag')}</span>}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {mixedGaps.length > 0 && (
                    <div className={styles.chipGroup}>
                      <p className={styles.chipGroupLabel}>{t('readback.willMixedGroup')}</p>
                      <div className={styles.mixedList}>
                        {mixedGaps.map((g) => (
                          <button key={g.slot} className={styles.mixedRow} title={t('readback.pinYourself')} onClick={() => addFact(g.slot)}>
                            <span className={styles.mixedRowHead}>
                              <Icon name="penLine" size={13} className={styles.chipIcn} />{labelFor(g.slot)}
                              {isOptional(g.slot) && <span className={clsx(styles.tag, styles.tagNeutral)}>{t('readback.detectedTag')}</span>}
                            </span>
                            <span className={styles.mixedRowParts}>
                              <span className={styles.mixedYou}>{t('readback.mixedYou', { parts: partLabels(g.slot, 'elicit') })}</span>
                              <span className={styles.mixedDot}>·</span>
                              <span className={styles.mixedWeaver}>{t('readback.mixedWeaver', { parts: partLabels(g.slot, 'generate') })}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {writeGaps.length > 0 && (
                    <div className={styles.chipGroup}>
                      <p className={styles.chipGroupLabel}>{t('readback.willWriteGroup')}</p>
                      <div className={styles.chips}>
                        {writeGaps.map((g) => (
                          <button key={g.slot} className={styles.chip} title={t('readback.pinYourself')} onClick={() => addFact(g.slot)}>
                            <Icon name="pencil" size={13} className={styles.chipIcn} />{labelFor(g.slot)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </Band>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <Btn icon="arrowLeft" onClick={onBack}>{t('readback.backToDream')}</Btn>
        <Btn icon="refresh" onClick={() => void runReadback(session.id)} disabled={readbackRunning} title={t('readback.rerunHint')}>{t('readback.rerun')}</Btn>
        <div className={styles.spacer} />
        <Btn
          variant="primary"
          iconRight="arrowRight"
          disabled={saving}
          onClick={async () => { if (dirty) await handleSave(); onContinue() }}
        >
          {saving ? t('readback.saving') : t('readback.continue')}
        </Btn>
      </div>
    </>
  )
}

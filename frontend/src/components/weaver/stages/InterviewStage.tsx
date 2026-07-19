import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { WeaverCandidate, WeaverResponseKind, WeaverSession } from '@/api/weaver'
import { DYNAMIC_TARGET, OPT_IN_PREFIX } from '@/api/weaver'
import { Btn, FlagBand, Icon, Placeholder, StageRunning } from '../primitives'
import styles from '../WeaverStudio.module.css'

export function InterviewStage({ session, onBack, onContinue }: { session: WeaverSession; onBack: () => void; onContinue: () => void }) {
  const { t } = useTranslation('weaver')
  const slots = useStore((s) => s.weaverSlots)
  const owns = useStore((s) => s.weaverStateSessionId === session.id)
  const interview = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverInterview : null))
  const question = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverQuestion : null))
  const loading = useStore((s) => s.weaverQuestionLoading)
  const error = useStore((s) => s.weaverInterviewError)
  const loadInterview = useStore((s) => s.loadWeaverInterview)
  const nextQuestion = useStore((s) => s.nextWeaverQuestion)
  const answerQuestion = useStore((s) => s.answerWeaverQuestion)
  const sparkQuestion = useStore((s) => s.sparkWeaverQuestion)
  const enhanceAnswer = useStore((s) => s.enhanceWeaverAnswer)
  const beginInterview = useStore((s) => s.beginWeaverInterview)
  const cancelQuestion = useStore((s) => s.cancelWeaverQuestion)
  const decideOptIn = useStore((s) => s.decideWeaverOptIn)
  const completeInterview = useStore((s) => s.completeWeaverInterview)
  const resetInterview = useStore((s) => s.resetWeaverInterview)

  const [draft, setDraft] = useState('')
  const [basis, setBasis] = useState<{ kind: 'picked' | 'enhanced'; content: string } | null>(null)
  const [sparkOptions, setSparkOptions] = useState<WeaverCandidate[]>([])
  const [sparkSeen, setSparkSeen] = useState<string[]>([])
  const [sparkSteer, setSparkSteer] = useState('')
  const [sparkLoading, setSparkLoading] = useState(false)
  const [enhanceOptions, setEnhanceOptions] = useState<WeaverCandidate[]>([])
  const [enhanceLoading, setEnhanceLoading] = useState(false)
  const [toolError, setToolError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [deciding, setDeciding] = useState(false)

  const settleOptIn = async (slot: string, enabled: boolean) => {
    if (deciding) return
    setDeciding(true)
    try {
      await decideOptIn(session.id, slot, enabled)
    } finally {
      setDeciding(false)
    }
  }

  useEffect(() => { void loadInterview(session.id) }, [session.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (owns && interview?.phase === 'active' && !question && !loading && !error
      && !interview.opt_in
      && (!interview.no_gaps_remaining || !interview.at_dynamic_cap)) {
      void nextQuestion(session.id)
    }
  }, [owns, interview?.phase, interview?.no_gaps_remaining, interview?.at_dynamic_cap, interview?.opt_in, question, loading, error]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setDraft(''); setBasis(null); setSparkOptions([]); setSparkSeen([]); setSparkSteer('')
    setEnhanceOptions([]); setToolError(null)
  }, [question])

  const targetLabel = (slot: string, part: string) => {
    if (slot === DYNAMIC_TARGET) return t('interview.deepeningLabel')
    if (slot === OPT_IN_PREFIX) {
      return slots.find((sl) => sl.id === part)?.label ?? part
    }
    const s = slots.find((sl) => sl.id === slot)
    if (part && part !== slot && s?.parts) {
      const p = s.parts.find((pp) => pp.id === part)
      if (p) return `${s.label} · ${p.label}`
    }
    return s?.label ?? slot
  }

  const splitAddr = (addr: string): { slot: string; part: string } => {
    const sep = addr.indexOf(':')
    return sep >= 0 ? { slot: addr.slice(0, sep), part: addr.slice(sep + 1) } : { slot: addr, part: '' }
  }

  const answeredCount = interview?.answered.length ?? 0
  const remainingCount = interview?.remaining_targets.length ?? 0
  const essentialsCovered = interview?.no_gaps_remaining ?? false

  const toolFail = (err: unknown) => {
    const body = (err as { body?: { error?: string } } | null)?.body
    setToolError(body?.error ?? (err instanceof Error ? err.message : t('interview.toolFailed')))
  }

  const submit = async () => {
    if (!question || !draft.trim() || submitting) return
    const kind: WeaverResponseKind = basis
      ? (basis.kind === 'picked' && draft.trim() === basis.content.trim() ? 'picked' : 'enhanced')
      : 'typed'
    setSubmitting(true)
    try {
      await answerQuestion(session.id, { question, kind, content: draft.trim() })
    } finally {
      setSubmitting(false)
    }
  }

  const doSpark = async (steerText?: string) => {
    if (!question || sparkLoading) return
    setSparkLoading(true); setToolError(null)
    try {
      const options = await sparkQuestion(session.id, steerText, sparkSeen.length > 0 ? sparkSeen : undefined)
      setSparkOptions(options)
      setSparkSeen((prev) => [...prev, ...options.map((o) => o.content)])
      setSparkSteer('')
    } catch (err) {
      toolFail(err)
    } finally {
      setSparkLoading(false)
    }
  }

  const doEnhance = async () => {
    if (!question || !draft.trim() || enhanceLoading) return
    setEnhanceLoading(true); setToolError(null)
    try {
      setEnhanceOptions(await enhanceAnswer(session.id, draft.trim()))
    } catch (err) {
      toolFail(err)
    } finally {
      setEnhanceLoading(false)
    }
  }

  const pickSpark = (opt: WeaverCandidate) => {
    setDraft(opt.content)
    setBasis({ kind: 'picked', content: opt.content })
    setSparkOptions([])
  }

  const applyEnhance = (opt: WeaverCandidate) => {
    setDraft(opt.content)
    setBasis({ kind: 'enhanced', content: opt.content })
    setEnhanceOptions([])
  }

  if (owns && interview?.phase === 'pending') {
    return (
      <>
        <div className={styles.panel}>
          <div className={styles.stageHead}>
            <div className={styles.stageHeadL}>
              <h2 className={styles.stageH}>{t('interview.heading')}</h2>
              <p className={styles.stageHelp}>{essentialsCovered ? t('interview.introNoGaps') : t('interview.intro')}</p>
            </div>
          </div>
          {error && <p className={styles.errorText}>{error}</p>}
        </div>
        <div className={styles.footer}>
          <Btn icon="arrowLeft" onClick={onBack}>{t('interview.backToReadback')}</Btn>
          <div className={styles.spacer} />
          {essentialsCovered && (
            <Btn iconRight="arrowRight" disabled={loading} onClick={() => void completeInterview(session.id)}>{t('interview.skipAhead')}</Btn>
          )}
          <Btn variant="primary" icon={loading ? 'refresh' : null} iconRight={loading ? null : 'arrowRight'} spin={loading} disabled={loading} onClick={() => void beginInterview(session.id)}>
            {loading ? t('interview.thinking') : essentialsCovered ? t('interview.beginDeepen') : t('interview.begin')}
          </Btn>
        </div>
      </>
    )
  }

  if (owns && interview?.phase === 'complete' && !loading) {
    return (
      <>
        <div className={styles.panel}>
          <Placeholder icon="check">{t('interview.doneCount', { count: answeredCount })}</Placeholder>
        </div>
        <div className={styles.footer}>
          <Btn icon="arrowLeft" onClick={onBack}>{t('interview.backToReadback')}</Btn>
          <Btn icon="refresh" onClick={() => void resetInterview(session.id)} title={t('interview.rerunHint')}>{t('interview.rerun')}</Btn>
          <div className={styles.spacer} />
          <Btn variant="primary" iconRight="arrowRight" onClick={onContinue}>{t('interview.continueToBible')}</Btn>
        </div>
      </>
    )
  }

  if (loading) {
    return (
      <StageRunning
        label={t('interview.thinking')}
        onBack={onBack}
        backLabel={t('interview.backToReadback')}
        action={{ label: t('interview.cancel'), icon: 'x', onClick: () => cancelQuestion(session.id, t('interview.canceled')) }}
      />
    )
  }

  if (!owns || !interview) {
    return <StageRunning label={t('interview.loading')} onBack={onBack} backLabel={t('interview.backToReadback')} />
  }

  const current = question ? splitAddr(question.target) : null
  const remaining = (interview?.remaining_targets ?? []).filter(
    (r) => !(current && r.slot === current.slot && (r.part === current.part || r.part === r.slot)),
  )
  const railRows: { slot: string; part: string; kind: 'answered' | 'current' | 'upcoming' }[] = [
    ...(interview?.answered ?? []).map((a) => ({ slot: a.slot, part: a.part, kind: 'answered' as const })),
    ...(current ? [{ slot: current.slot, part: current.part, kind: 'current' as const }] : []),
    ...remaining.map((r) => ({ slot: r.slot, part: r.part, kind: 'upcoming' as const })),
  ]

  const canFinish = answeredCount > 0 || essentialsCovered

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.stageHead}>
          <div className={styles.stageHeadL}>
            <h2 className={styles.stageH}>{t('interview.heading')}</h2>
            <p className={styles.stageHelp}>{t('interview.activeHelp')}</p>
          </div>
          <div className={styles.prog}>
            {essentialsCovered
              ? t('interview.progressDeepening')
              : t('interview.progressOpen', { count: remainingCount })}
          </div>
        </div>
        <div className={styles.scroll}>
          {error && <p className={styles.errorText}>{error}</p>}
          <div className={styles.work}>
            <div className={styles.workRail}>
              <div>
                <div className={styles.railGroupLabel}>{t('interview.questionsRail')}</div>
                <div className={styles.railList}>
                  {railRows.map((r, i) => (
                    <div key={`${r.slot}:${r.part}-${i}`} className={clsx(styles.railItem, r.kind === 'current' && styles.railItemActive)} style={{ cursor: 'default' }}>
                      <span className={styles.railMarker}>
                        {r.kind === 'answered'
                          ? <Icon name="check" size={14} className={styles.critIcnPass} />
                          : r.kind === 'current'
                            ? <span className={clsx(styles.sdot, styles.sdotElicit)} />
                            : <span className={clsx(styles.sdot, styles.sdotNone)} />}
                      </span>
                      <span className={clsx(styles.railName, r.kind === 'upcoming' && styles.railNameDim)}>{targetLabel(r.slot, r.part)}</span>
                    </div>
                  ))}
                </div>
                <div className={styles.railNote}>
                  {essentialsCovered ? t('interview.railNoteDeepening') : t('interview.railNoteOpen')}
                </div>
              </div>
            </div>

            <div className={styles.workMain}>
              {!question && interview.opt_in ? (
                <div>
                  <h3 className={styles.axisName}>
                    {t(`optIn.${interview.opt_in.slot}.question`, { defaultValue: interview.opt_in.slot })}
                  </h3>
                  <p className={styles.axisDesc}>
                    {t(`optIn.${interview.opt_in.slot}.why`, { defaultValue: '' })}
                  </p>
                  <button
                    type="button"
                    className={clsx(styles.agOpt, styles.agOptSelected)}
                    disabled={deciding}
                    onClick={() => void settleOptIn(interview.opt_in!.slot, false)}
                  >
                    <span className={styles.agOptText}>
                      <span className={styles.agOptName}>
                        {t(`optIn.${interview.opt_in.slot}.offName`, { defaultValue: '' })}
                      </span>
                      <span className={styles.agOptDesc}>
                        {t(`optIn.${interview.opt_in.slot}.offDesc`, { defaultValue: '' })}
                      </span>
                    </span>
                    <span className={styles.agOptMark}><Icon name="check" size={14} /></span>
                  </button>
                  <button
                    type="button"
                    className={styles.agOpt}
                    disabled={deciding}
                    onClick={() => void settleOptIn(interview.opt_in!.slot, true)}
                  >
                    <span className={styles.agOptText}>
                      <span className={styles.agOptName}>
                        {t(`optIn.${interview.opt_in.slot}.onName`, { defaultValue: '' })}
                      </span>
                      <span className={styles.agOptDesc}>
                        {t(`optIn.${interview.opt_in.slot}.onDesc`, { defaultValue: '' })}
                      </span>
                    </span>
                    <span />
                  </button>
                  <p className={styles.axisDesc} style={{ marginTop: 12 }}>
                    {t(`optIn.${interview.opt_in.slot}.note`, { defaultValue: '' })}
                  </p>
                </div>
              ) : question ? (
                <div>
                  <h3 className={styles.axisName}>{question.prompt}</h3>
                  {question.why && <p className={styles.axisDesc}>{question.why}</p>}
                  <textarea
                    className={styles.field}
                    rows={5}
                    value={draft}
                    placeholder={t('interview.typePlaceholder')}
                    onChange={(e) => {
                      setDraft(e.target.value)
                      if (!e.target.value.trim()) setBasis(null)
                    }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit() }}
                  />
                  <div className={styles.toolRow}>
                    <Btn icon="sparkles" spin={sparkLoading} disabled={sparkLoading || submitting} onClick={() => void doSpark()}>
                      {sparkOptions.length > 0 || sparkSeen.length > 0 ? t('interview.sparkAgain') : t('interview.spark')}
                    </Btn>
                    <Btn icon="penLine" spin={enhanceLoading} disabled={!draft.trim() || enhanceLoading || submitting} onClick={() => void doEnhance()}>
                      {t('interview.enhance')}
                    </Btn>
                    <div className={styles.spacer} />
                    <Btn variant="primary" icon="check" disabled={!draft.trim() || submitting} onClick={() => void submit()}>
                      {t('interview.submitAnswer')}
                    </Btn>
                  </div>
                  {toolError && <p className={styles.errorText}>{toolError}</p>}
                  {sparkOptions.length > 0 && (
                    <div>
                      <p className={styles.axisDesc}>{t('interview.sparkHint')}</p>
                      <div className={styles.opts}>
                        {sparkOptions.map((opt, i) => (
                          <button key={i} className={styles.optCard} onClick={() => pickSpark(opt)}>
                            <span className={styles.optBody}>
                              {opt.caption && <div className={styles.optCaption}>{opt.caption}</div>}
                              <div className={styles.optContent}>{opt.content}</div>
                            </span>
                          </button>
                        ))}
                      </div>
                      <div className={styles.toolRow}>
                        <input
                          className={styles.toolin}
                          value={sparkSteer}
                          placeholder={t('interview.sparkSteerPlaceholder')}
                          onChange={(e) => setSparkSteer(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && sparkSteer.trim()) void doSpark(sparkSteer.trim()) }}
                        />
                        <Btn className={styles.btnTiny} icon="refresh" disabled={!sparkSteer.trim() || sparkLoading} onClick={() => void doSpark(sparkSteer.trim())}>{t('interview.sparkSteer')}</Btn>
                      </div>
                    </div>
                  )}
                  {enhanceOptions.length > 0 && (
                    <div>
                      <p className={styles.axisDesc}>{t('interview.enhanceHint')}</p>
                      <div className={styles.opts}>
                        {enhanceOptions.map((opt, i) => (
                          <button key={i} className={styles.optCard} onClick={() => applyEnhance(opt)}>
                            <span className={styles.optBody}>
                              {opt.caption && <div className={styles.optCaption}>{opt.caption}</div>}
                              <div className={styles.optContent}>{opt.content}</div>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : error ? (
                <FlagBand
                  inField
                  subject={t('interview.generateFailedSubject')}
                  detail={t('interview.generateFailedBody')}
                  note={t('interview.generateFailedNote')}
                />
              ) : (
                <Placeholder icon="check">{t('interview.allAnswered')}</Placeholder>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className={styles.footer}>
        <Btn icon="arrowLeft" onClick={onBack}>{t('interview.backToReadback')}</Btn>
        {!question && error && (
          <Btn icon="refresh" disabled={loading} onClick={() => void nextQuestion(session.id)}>{t('interview.retry')}</Btn>
        )}
        <div className={styles.spacer} />
        {canFinish && (
          <Btn variant="primary" icon="check" disabled={submitting} onClick={() => void completeInterview(session.id)}>
            {t('interview.finish')}
          </Btn>
        )}
      </div>
    </>
  )
}

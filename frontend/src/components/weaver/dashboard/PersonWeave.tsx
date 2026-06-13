import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as weaverApi from '@/api/weaver'
import type {
  WeaverCandidate, WeaverPerson, WeaverInterviewQuestion, WeaverResponseKind, WeaverSession,
} from '@/api/weaver'
import { Btn } from '../primitives'
import styles from '../WeaverStudio.module.css'

function weaveErrMsg(err: unknown, fallback: string): string {
  const body = (err as { body?: { error?: string } } | null)?.body
  return body?.error ?? (err instanceof Error ? err.message : fallback)
}

interface PersonWeaveProps {
  session: WeaverSession
  person: WeaverPerson
  questionTarget: number
  onWoven: () => void
  onClose: () => void
}

export function PersonWeave({ session, person, questionTarget, onWoven, onClose }: PersonWeaveProps) {
  const { t } = useTranslation('weaver')
  const [interview, setInterview] = useState(person.interview)
  const answered = interview.length
  const [question, setQuestion] = useState<WeaverInterviewQuestion | null>(null)
  const [qLoading, setQLoading] = useState(false)
  const [qError, setQError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [basis, setBasis] = useState<{ kind: 'picked' | 'enhanced'; content: string } | null>(null)
  const [sparkOptions, setSparkOptions] = useState<WeaverCandidate[]>([])
  const [sparkSeen, setSparkSeen] = useState<string[]>([])
  const [enhanceOptions, setEnhanceOptions] = useState<WeaverCandidate[]>([])
  const [toolBusy, setToolBusy] = useState<'spark' | 'enhance' | null>(null)
  const [toolError, setToolError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [weaving, setWeaving] = useState(false)

  const resetAnswerState = () => {
    setDraft(''); setBasis(null); setSparkOptions([]); setSparkSeen([]); setEnhanceOptions([]); setToolError(null)
  }

  const fetchQuestion = useCallback(async () => {
    setQLoading(true); setQError(null)
    try {
      const r = await weaverApi.personQuestion(session.id, person.id)
      setQuestion(r.question)
    } catch (err) {
      setQuestion(null)
      setQError(weaveErrMsg(err, t('hub.questionFailed')))
    } finally {
      setQLoading(false)
    }
  }, [session.id, person.id, t])
  useEffect(() => { void fetchQuestion() }, [fetchQuestion])

  const submit = async () => {
    if (!question || !draft.trim() || submitting || weaving) return
    const kind: WeaverResponseKind = basis
      ? (basis.kind === 'picked' && draft.trim() === basis.content.trim() ? 'picked' : 'enhanced')
      : 'typed'
    setSubmitting(true); setToolError(null)
    try {
      const res = await weaverApi.answerPersonQuestion(session.id, person.id, {
        question, kind, content: draft.trim(),
      })
      setInterview(res.person.interview)
      resetAnswerState()
      void fetchQuestion()
    } catch (err) {
      setToolError(weaveErrMsg(err, t('hub.answerFailed')))
    } finally {
      setSubmitting(false)
    }
  }

  const weave = async () => {
    if (answered === 0 || weaving || submitting) return
    setWeaving(true); setToolError(null)
    try {
      await weaverApi.weaveNamed(session.id, person.id)
      onWoven()
    } catch (err) {
      setToolError(weaveErrMsg(err, t('hub.people.weaveFailed')))
      setWeaving(false)
    }
  }

  const doSpark = async () => {
    if (!question || toolBusy) return
    setToolBusy('spark'); setToolError(null)
    try {
      const r = await weaverApi.sparkQuestion(session.id, {
        question,
        ...(sparkSeen.length > 0 ? { avoid: sparkSeen } : {}),
      })
      setSparkOptions(r.options)
      setSparkSeen((prev) => [...prev, ...r.options.map((o) => o.content)])
    } catch (err) {
      setToolError(weaveErrMsg(err, t('interview.toolFailed')))
    } finally {
      setToolBusy(null)
    }
  }

  const doEnhance = async () => {
    if (!question || !draft.trim() || toolBusy) return
    setToolBusy('enhance'); setToolError(null)
    try {
      const r = await weaverApi.enhanceAnswer(session.id, { question, draft: draft.trim() })
      setEnhanceOptions(r.options)
    } catch (err) {
      setToolError(weaveErrMsg(err, t('interview.toolFailed')))
    } finally {
      setToolBusy(null)
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

  const atTarget = answered >= questionTarget
  const weaveLabel = person.npc_entry_id ? t('hub.people.reweave') : t('hub.people.weaveNow')

  return (
    <div className={styles.personWeave}>
      <div className={styles.wwHead}>
        <span className={styles.wwHeadTitle}>{t('hub.people.weaving', { name: person.name })}</span>
        <span className={styles.wwHeadCount}>{t('hub.people.answeredCount', { count: answered })}</span>
        <div className={styles.spacer} />
        <Btn disabled={submitting || weaving} onClick={onClose}>{t('hub.people.closeWeave')}</Btn>
      </div>

      {interview.map((qa) => (
        <div key={qa.id} className={styles.wwQ}>
          <div className={styles.wwQText}>{qa.question}</div>
          <div className={styles.wwAns}>{qa.answer}</div>
        </div>
      ))}

      {qLoading ? (
        <p className={styles.stageHelp}>{t('interview.thinking')}</p>
      ) : question ? (
        <div className={styles.wwQ}>
          <div className={styles.wwQText}>{question.prompt}</div>
          {question.why && <div className={styles.wwQWhy}>{question.why}</div>}
          <textarea
            className={styles.wwAnsField}
            rows={3}
            value={draft}
            placeholder={t('interview.typePlaceholder')}
            onChange={(e) => {
              setDraft(e.target.value)
              if (!e.target.value.trim()) setBasis(null)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit() }}
          />
          <div className={styles.wwTools}>
            <Btn icon="sparkles" spin={toolBusy === 'spark'} disabled={toolBusy !== null || submitting || weaving} onClick={() => void doSpark()}>
              {sparkSeen.length > 0 ? t('interview.sparkAgain') : t('interview.spark')}
            </Btn>
            <Btn icon="penLine" spin={toolBusy === 'enhance'} disabled={!draft.trim() || toolBusy !== null || submitting || weaving} onClick={() => void doEnhance()}>
              {t('interview.enhance')}
            </Btn>
            <div className={styles.spacer} />
            <Btn variant="primary" icon={submitting ? 'refresh' : 'check'} spin={submitting} disabled={!draft.trim() || submitting || weaving} onClick={() => void submit()}>
              {t('interview.submitAnswer')}
            </Btn>
          </div>
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
      ) : (
        <>
          {qError ? <p className={styles.errorText}>{qError}</p> : <p className={styles.stageHelp}>{t('hub.noQuestion')}</p>}
          <div className={styles.toolRow}>
            <Btn icon="refresh" disabled={weaving} onClick={() => void fetchQuestion()}>{t('interview.retry')}</Btn>
          </div>
        </>
      )}

      {toolError && <p className={styles.errorText}>{toolError}</p>}

      <div className={styles.wwFoot}>
        <span className={styles.wwFootNote}>
          {answered === 0
            ? t('hub.people.weaveFootEmpty')
            : atTarget
              ? t('hub.people.weaveHintReady')
              : t('hub.people.weaveHintMore')}
        </span>
        <div className={styles.spacer} />
        <Btn
          variant={atTarget ? 'primary' : 'ghost'}
          icon="sparkles"
          spin={weaving}
          disabled={answered === 0 || weaving || submitting}
          onClick={() => void weave()}
        >
          {weaveLabel}
        </Btn>
      </div>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import * as weaverApi from '@/api/weaver'
import type {
  WeaverCandidate, WeaverHubSummary, WeaverInterviewQuestion, WeaverResponseKind, WeaverSession,
} from '@/api/weaver'
import { worldBooksApi } from '@/api/world-books'
import type { WorldBookEntry } from '@/types/api'
import { Btn, KindChip } from '../primitives'
import { AgencyBand } from './AgencyBand'
import styles from '../WeaverStudio.module.css'

function hubErrMsg(err: unknown, fallback: string): string {
  const body = (err as { body?: { error?: string } } | null)?.body
  return body?.error ?? (err instanceof Error ? err.message : fallback)
}

const LORE_PREVIEW_LIMIT = 100

function LoreList({ bookId, entries, onOpen }: { bookId: string; entries: WorldBookEntry[]; onOpen: () => void }) {
  const { t } = useTranslation('weaver')
  if (entries.length === 0) {
    return <p className={styles.stageHelp}>{t('hub.noEntries')}</p>
  }
  return (
    <div className={styles.loreList} key={bookId}>
      {entries.map((e) => {
        const name = e.comment.trim() || e.key[0] || t('hub.untitledEntry')
        return (
          <button key={e.id} type="button" className={styles.loreRow} onClick={onOpen} title={t('hub.openBook')}>
            <span className={styles.loreName}>{name}</span>
            <span className={styles.loreChipCell}>
              {e.key[0] && <KindChip>{e.key[0]}</KindChip>}
            </span>
            <span className={styles.loreLine}>{e.content.replace(/\s+/g, ' ')}</span>
          </button>
        )
      })}
    </div>
  )
}

export function WorldHubPane({ session }: { session: WeaverSession }) {
  const { t } = useTranslation('weaver')
  const openModal = useStore((s) => s.openModal)
  const [hub, setHub] = useState<WeaverHubSummary | null>(null)
  const [hubError, setHubError] = useState<string | null>(null)
  const [entries, setEntries] = useState<WorldBookEntry[]>([])

  const loreBook = hub?.books.find((b) => b.role === 'lore') ?? null

  const refresh = useCallback(async () => {
    try {
      const summary = await weaverApi.getHub(session.id)
      setHub(summary)
      setHubError(null)
      const book = summary.books.find((b) => b.role === 'lore')
      if (book) {
        const res = await worldBooksApi.listEntries(book.id, {
          limit: LORE_PREVIEW_LIMIT, sort_by: 'created', sort_dir: 'desc',
        })
        setEntries(res.data)
      } else {
        setEntries([])
      }
    } catch (err) {
      setHubError(hubErrMsg(err, t('hub.loadFailed')))
    }
  }, [session.id, t])
  useEffect(() => { void refresh() }, [refresh])

  const [growing, setGrowing] = useState(false)
  const [question, setQuestion] = useState<WeaverInterviewQuestion | null>(null)
  const [qLoading, setQLoading] = useState(false)
  const [qError, setQError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // What the draft was built from, so provenance stays honest (same rule as the interview).
  const [basis, setBasis] = useState<{ kind: 'picked' | 'enhanced'; content: string } | null>(null)
  const [sparkOptions, setSparkOptions] = useState<WeaverCandidate[]>([])
  const [sparkSeen, setSparkSeen] = useState<string[]>([])
  const [enhanceOptions, setEnhanceOptions] = useState<WeaverCandidate[]>([])
  const [toolBusy, setToolBusy] = useState<'spark' | 'enhance' | null>(null)
  const [toolError, setToolError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [added, setAdded] = useState(0)

  const resetAnswerState = () => {
    setDraft(''); setBasis(null); setSparkOptions([]); setSparkSeen([]); setEnhanceOptions([]); setToolError(null)
  }

  const fetchQuestion = useCallback(async () => {
    setQLoading(true); setQError(null)
    try {
      const r = await weaverApi.loreQuestion(session.id)
      setQuestion(r.question)
    } catch (err) {
      setQuestion(null)
      setQError(hubErrMsg(err, t('hub.questionFailed')))
    } finally {
      setQLoading(false)
    }
  }, [session.id, t])

  const begin = () => { setGrowing(true); setAdded(0); resetAnswerState(); void fetchQuestion() }
  const finish = () => { setGrowing(false); setQuestion(null); resetAnswerState() }

  const submit = async () => {
    if (!question || !draft.trim() || submitting) return
    const kind: WeaverResponseKind = basis
      ? (basis.kind === 'picked' && draft.trim() === basis.content.trim() ? 'picked' : 'enhanced')
      : 'typed'
    setSubmitting(true); setToolError(null)
    try {
      const res = await weaverApi.loreAnswer(session.id, { question, kind, content: draft.trim() })
      setAdded((n) => n + res.added)
      if (res.book_error) setToolError(res.book_error)
      resetAnswerState()
      void refresh()
      void fetchQuestion()
    } catch (err) {
      setToolError(hubErrMsg(err, t('hub.answerFailed')))
    } finally {
      setSubmitting(false)
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
      setToolError(hubErrMsg(err, t('interview.toolFailed')))
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
      setToolError(hubErrMsg(err, t('interview.toolFailed')))
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

  const openBookEditor = () => {
    if (loreBook) openModal('worldBookEditor', { bookId: loreBook.id })
  }

  return (
    <div className={styles.dashPaneInner}>
      {hubError && <p className={styles.errorText}>{hubError}</p>}

      <div className={styles.cardPaneHead}>
        <span className={styles.cardPaneTitle}>{t('hub.loreBand')}</span>
        <span className={styles.cardPaneCount}>
          {loreBook ? t('hub.entryCount', { count: loreBook.entry_count }) : null}
          {added > 0 ? ` · ${t('hub.addedNote', { count: added })}` : null}
        </span>
        <div className={styles.spacer} />
        {loreBook && (
          <Btn className={styles.btnTiny} icon="pencil" onClick={openBookEditor}>{t('hub.openBook')}</Btn>
        )}
        {!growing && (
          <Btn className={styles.btnTiny} icon="plus" onClick={begin}>{t('hub.addLore')}</Btn>
        )}
      </div>

      <section>
        {loreBook ? (
          <LoreList bookId={loreBook.id} entries={entries} onOpen={openBookEditor} />
        ) : (
          <p className={styles.stageHelp}>{t('hub.noBook')}</p>
        )}

        {growing && (qLoading ? (
          <p className={styles.stageHelp}>{t('interview.thinking')}</p>
        ) : question ? (
          <div className={styles.wwQ}>
            <div className={styles.wwQText}>{question.prompt}</div>
            {question.why && <div className={styles.wwQWhy}>{question.why}</div>}
            <textarea
              className={styles.wwAnsField}
              rows={4}
              value={draft}
              placeholder={t('interview.typePlaceholder')}
              onChange={(e) => {
                setDraft(e.target.value)
                if (!e.target.value.trim()) setBasis(null)
              }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit() }}
            />
            <div className={styles.wwTools}>
              <Btn icon="sparkles" spin={toolBusy === 'spark'} disabled={toolBusy !== null || submitting} onClick={() => void doSpark()}>
                {sparkSeen.length > 0 ? t('interview.sparkAgain') : t('interview.spark')}
              </Btn>
              <Btn icon="penLine" spin={toolBusy === 'enhance'} disabled={!draft.trim() || toolBusy !== null || submitting} onClick={() => void doEnhance()}>
                {t('interview.enhance')}
              </Btn>
              <div className={styles.spacer} />
              <Btn disabled={submitting} onClick={finish}>{t('hub.done')}</Btn>
              <Btn variant="primary" icon={submitting ? 'refresh' : 'check'} spin={submitting} disabled={!draft.trim() || submitting} onClick={() => void submit()}>
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
              <Btn icon="refresh" onClick={() => void fetchQuestion()}>{t('interview.retry')}</Btn>
              <Btn onClick={finish}>{t('hub.done')}</Btn>
            </div>
          </>
        ))}

        {growing && (
          <div className={styles.wwFoot}>
            <span className={styles.wwFootNote}>{t('hub.growNote')}</span>
          </div>
        )}
      </section>

      {hub?.agency && (
        <AgencyBand session={session} agency={hub.agency} onMutated={() => void refresh()} />
      )}
    </div>
  )
}

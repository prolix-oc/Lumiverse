import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import {
  inspectImport,
  startImport,
  enrichImportEntry,
  type WeaverImportInspection,
} from '@/api/weaver'
import { worldBooksApi } from '@/api/world-books'
import type { WorldBook, WorldBookEntry } from '@/types/api'
import { Btn, Icon, IconBtn, KindChip } from './primitives'
import styles from './WeaverStudio.module.css'
import s from './ImportPane.module.css'

type ProgressState = 'pending' | 'working' | 'enriched' | 'kept'

interface ProgressRow {
  entry: WorldBookEntry
  state: ProgressState
  note: string
}

export function ImportPane({ onBack, onClose }: { onBack: () => void; onClose: () => void }) {
  const { t } = useTranslation('weaver')
  const loadSessions = useStore((st) => st.loadWeaverSessions)
  const openSession = useStore((st) => st.openWeaverSession)
  const openModal = useStore((st) => st.openModal)

  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef(false)
  const [file, setFile] = useState<File | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [inspection, setInspection] = useState<WeaverImportInspection | null>(null)
  const [startingAction, setStartingAction] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrichBook, setEnrichBook] = useState<WorldBook | null>(null)
  const [progress, setProgress] = useState<ProgressRow[]>([])
  const [enriching, setEnriching] = useState(false)

  const reset = () => {
    setFile(null)
    setInspection(null)
    setError(null)
  }

  const pick = async (f: File) => {
    setFile(f)
    setInspection(null)
    setError(null)
    setInspecting(true)
    try {
      const ins = await inspectImport(f)
      setInspection(ins)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.failed'))
      setFile(null)
    } finally {
      setInspecting(false)
    }
  }

  const setRow = (index: number, state: ProgressState, note = '') => {
    setProgress((rows) => rows.map((r, i) => (i === index ? { ...r, state, note } : r)))
  }

  const runEnrich = async (book: WorldBook) => {
    setEnriching(true)
    abortRef.current = false
    try {
      const { data } = await worldBooksApi.listEntries(book.id, { limit: 500 })
      const rows: ProgressRow[] = data
        .filter((e) => e.content?.trim())
        .map((entry) => ({ entry, state: 'pending' as const, note: '' }))
      setProgress(rows)
      for (let i = 0; i < rows.length; i++) {
        if (abortRef.current) break
        setRow(i, 'working')
        try {
          const res = await enrichImportEntry(book.id, rows[i].entry.id)
          setRow(i, res.enriched ? 'enriched' : 'kept', res.note)
        } catch (err) {
          setRow(i, 'kept', err instanceof Error ? err.message : t('import.enrichRun.kept'))
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.failed'))
    } finally {
      setEnriching(false)
    }
  }

  const start = async (actionId: string) => {
    if (!file || startingAction) return
    setStartingAction(actionId)
    setError(null)
    try {
      const res = await startImport(file, actionId)
      if (res.session) {
        await loadSessions()
        openSession(res.session.id)
      } else if (res.world_book) {
        if (res.book_work) {
          setEnrichBook(res.world_book)
          void runEnrich(res.world_book)
        } else {
          openModal('worldBookEditor', { bookId: res.world_book.id })
          onBack()
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.failed'))
    } finally {
      setStartingAction(null)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) void pick(dropped)
  }

  const title = enrichBook
    ? enrichBook.name
    : inspection
      ? (file?.name ?? inspection.name)
      : t('import.titleDrop')
  const doneCount = progress.filter((r) => r.state === 'enriched' || r.state === 'kept').length

  return (
    <div className={clsx(s.root, styles.surfaceEnter)}>
      <header className={styles.hdr}>
        <IconBtn icon="arrowLeft" size={16} cls={styles.sq32} title={t('import.back')} onClick={onBack} />
        <div className={styles.hdrId}>
          <div className={styles.hdrEyebrow}>{t('import.eyebrow')}</div>
          <div className={styles.hdrTitle}>{title}</div>
        </div>
        <IconBtn icon="x" size={16} cls={styles.sq32} title={t('close')} onClick={onClose} />
      </header>

      <div className={s.body}>
        {error && <p className={styles.errorText}>{error}</p>}

        {!enrichBook && !inspection && (
          <div className={clsx(s.center, s.centerDrop)}>
            <div
              className={clsx(s.drop, dragOver && s.dropActive)}
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <Icon name={inspecting ? 'refresh' : 'fileUp'} size={22} spin={inspecting} />
              <span className={s.dropTitle}>{inspecting ? t('import.inspecting') : t('import.drop')}</span>
              {!inspecting && (
                <>
                  <div className={s.formats}>
                    <KindChip>{t('import.formats.png')}</KindChip>
                    <KindChip>{t('import.formats.json')}</KindChip>
                    <KindChip>{t('import.formats.charx')}</KindChip>
                    <KindChip>{t('import.formats.worldbook')}</KindChip>
                  </div>
                  <span className={s.dropOr}>{t('import.or')}</span>
                  {/* No handler: the click bubbles to the drop zone, which opens the picker. */}
                  <Btn>{t('import.browse')}</Btn>
                </>
              )}
              <input
                ref={inputRef}
                className={s.hiddenInput}
                type="file"
                accept=".png,.json,.charx,.jpg,.jpeg,application/json,image/png"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void pick(f)
                  e.target.value = ''
                }}
              />
            </div>
            <div className={s.notes}>
              <div className={s.note}>
                <Icon name="sparkles" size={13} />
                {t('import.noteRebuild')}
              </div>
              <div className={s.note}>
                <Icon name="check" size={13} />
                {t('import.noteOriginal')}
              </div>
            </div>
          </div>
        )}

        {inspection && !enrichBook && (
          <div className={s.center}>
            <div className={s.idband}>
              <span className={s.idbandIcon}>
                <Icon name={inspection.artifact === 'card' ? 'user' : 'bookOpen'} size={18} />
              </span>
              <div className={s.idbandId}>
                <span className={s.idbandName}>{inspection.name}</span>
                <div className={s.idbandChips}>
                  <KindChip>{t(`import.kinds.${inspection.artifact}`, { defaultValue: inspection.artifact })}</KindChip>
                  <KindChip>
                    {inspection.artifact === 'worldbook'
                      ? t('import.entries', { count: inspection.entry_count })
                      : inspection.format.toUpperCase()}
                  </KindChip>
                </div>
              </div>
              <span className={s.idbandSwap}>
                <Btn icon="refresh" onClick={reset}>{t('import.another')}</Btn>
              </span>
            </div>

            {inspection.artifact === 'card' && (
              <>
                <div className={s.sect} style={{ marginTop: 18 }}>
                  <span className={s.sectLabel}>{t('import.carry')}</span>
                </div>
                <div className={s.carry}>
                  {inspection.field_stats.map((f) => (
                    <div key={f.id} className={clsx(s.carryRow, f.words === 0 && s.carryEmpty)}>
                      <Icon name={f.words > 0 ? 'check' : 'x'} size={11} />
                      {t(`import.fields.${f.id}`, { defaultValue: f.id })}
                      <span className={s.carryNote}>
                        {f.words > 0 ? t('import.words', { count: f.words }) : t('import.empty')}
                      </span>
                    </div>
                  ))}
                  {inspection.has_embedded_book && (
                    <div className={s.carryRow}>
                      <Icon name="check" size={11} />
                      {t('import.fields.embedded')}
                      <span className={s.carryNote}>{t('import.entries', { count: inspection.entry_count })}</span>
                    </div>
                  )}
                  <div className={clsx(s.carryRow, !inspection.has_portrait && s.carryEmpty)}>
                    <Icon name={inspection.has_portrait ? 'check' : 'x'} size={11} />
                    {t('import.fields.portrait')}
                    <span className={s.carryNote}>
                      {inspection.has_portrait ? t('import.rides') : t('import.empty')}
                    </span>
                  </div>
                </div>
              </>
            )}

            <div className={s.sect} style={{ marginTop: 14 }}>
              <span className={s.sectLabel}>{t('import.treatment')}</span>
            </div>
            {inspection.reading && (
              <div className={s.suggest}>
                <Icon name="sparkles" size={13} />
                <span>
                  {t('import.suggestedPre')}{' '}
                  <strong>{t(`import.actions.${inspection.reading.action}.title`, { defaultValue: inspection.reading.action })}</strong>
                  {inspection.reading.reason ? <>. {inspection.reading.reason}</> : null}
                </span>
              </div>
            )}
            {inspection.actions.map((id) => (
              <button
                key={id}
                type="button"
                className={s.opt}
                disabled={Boolean(startingAction)}
                onClick={() => void start(id)}
              >
                <span className={s.optText}>
                  <span className={s.optName}>{t(`import.actions.${id}.title`, { defaultValue: id })}</span>
                  <span className={s.optDesc}>{t(`import.actions.${id}.desc`, { defaultValue: '' })}</span>
                </span>
                {inspection.reading?.action === id
                  ? <KindChip>{t('import.suggested')}</KindChip>
                  : <span />}
                <Icon name={startingAction === id ? 'refresh' : 'arrowRight'} size={14} spin={startingAction === id} />
              </button>
            ))}
            {inspection.artifact === 'card' && <div className={s.foot}>{t('import.cardFoot')}</div>}
          </div>
        )}

        {enrichBook && (
          <div className={s.center}>
            <div className={s.idband}>
              <span className={s.idbandIcon}><Icon name="bookOpen" size={18} /></span>
              <div className={s.idbandId}>
                <span className={s.idbandName}>{enrichBook.name}</span>
                <div className={s.idbandChips}>
                  <KindChip>{t('import.kinds.worldbook')}</KindChip>
                  <KindChip>{t('import.entries', { count: progress.length })}</KindChip>
                </div>
              </div>
            </div>

            <div className={s.sect} style={{ marginTop: 18 }}>
              <span className={s.sectLabel}>{t('import.enrichRun.label')}</span>
              <span className={s.sectCount}>{t('import.enrichRun.of', { done: doneCount, total: progress.length })}</span>
              {enriching && (
                <span className={s.sectEnd}>
                  <Btn icon="x" onClick={() => { abortRef.current = true }}>{t('import.enrichRun.stop')}</Btn>
                </span>
              )}
            </div>
            <div>
              {progress.map((row) => (
                <div
                  key={row.entry.id}
                  className={clsx(
                    s.erow,
                    row.state === 'pending' && s.erowPending,
                    row.state === 'kept' && s.erowKept,
                  )}
                >
                  {row.state === 'enriched' && <Icon name="check" size={12} />}
                  {row.state === 'kept' && <Icon name="shield" size={12} />}
                  {row.state === 'working' && <Icon name="refresh" size={12} spin />}
                  {row.state === 'pending' && <span />}
                  <span className={s.erowName}>{row.entry.comment || t('import.enrichRun.untitled')}</span>
                  <span
                    className={clsx(
                      s.erowStatus,
                      row.state === 'enriched' && s.erowStatusDone,
                      row.state === 'kept' && s.erowStatusKept,
                    )}
                    title={row.note || undefined}
                  >
                    {row.state === 'enriched' && t('import.enrichRun.enriched')}
                    {row.state === 'kept' && (row.note
                      ? t('import.enrichRun.keptWhy', { why: row.note })
                      : t('import.enrichRun.kept'))}
                    {row.state === 'working' && t('import.enrichRun.working')}
                    {row.state === 'pending' && t('import.enrichRun.pending')}
                  </span>
                </div>
              ))}
            </div>
            <div className={s.runFoot}>
              <span className={s.runFootNote}>{t('import.enrichRun.stopNote')}</span>
              <span className={s.runFootEnd}>
                <Btn
                  variant="primary"
                  icon="pencil"
                  disabled={enriching}
                  onClick={() => {
                    openModal('worldBookEditor', { bookId: enrichBook.id })
                    onBack()
                  }}
                >
                  {t('import.enrichRun.open')}
                </Btn>
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

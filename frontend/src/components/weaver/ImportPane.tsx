import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import {
  inspectImport,
  startImport,
  inspectGalleryCharacter,
  startGalleryCharacterImport,
  enrichImportEntry,
  type WeaverImportInspection,
} from '@/api/weaver'
import { charactersApi } from '@/api/characters'
import { worldBooksApi } from '@/api/world-books'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import type { CharacterSummary, WorldBook, WorldBookEntry } from '@/types/api'
import { Btn, Icon, IconBtn, KindChip } from './primitives'
import styles from './WeaverStudio.module.css'
import s from './ImportPane.module.css'

type ProgressState = 'pending' | 'working' | 'enriched' | 'kept'
type ImportSourceMode = 'gallery' | 'file'

const GALLERY_PAGE_SIZE = 48

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
  const galleryRequestRef = useRef(0)
  const [sourceMode, setSourceMode] = useState<ImportSourceMode>('gallery')
  const [file, setFile] = useState<File | null>(null)
  const [galleryCharacter, setGalleryCharacter] = useState<CharacterSummary | null>(null)
  const [galleryCharacters, setGalleryCharacters] = useState<CharacterSummary[]>([])
  const [galleryTotal, setGalleryTotal] = useState(0)
  const [galleryQuery, setGalleryQuery] = useState('')
  const [galleryLoading, setGalleryLoading] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [inspection, setInspection] = useState<WeaverImportInspection | null>(null)
  const [startingAction, setStartingAction] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enrichBook, setEnrichBook] = useState<WorldBook | null>(null)
  const [progress, setProgress] = useState<ProgressRow[]>([])
  const [enriching, setEnriching] = useState(false)

  useEffect(() => {
    if (sourceMode !== 'gallery') return
    const request = ++galleryRequestRef.current
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setGalleryLoading(true)
      void charactersApi.listSummaries({
        limit: GALLERY_PAGE_SIZE,
        offset: 0,
        search: galleryQuery.trim() || undefined,
        sort: 'name',
        direction: 'asc',
      }, controller.signal).then((result) => {
        if (galleryRequestRef.current !== request) return
        setGalleryCharacters(result.data)
        setGalleryTotal(result.total)
      }).catch((err) => {
        if (controller.signal.aborted || galleryRequestRef.current !== request) return
        setError(err instanceof Error ? err.message : t('import.gallery.loadFailed'))
      }).finally(() => {
        if (galleryRequestRef.current === request) setGalleryLoading(false)
      })
    }, 180)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [galleryQuery, sourceMode, t])

  const reset = () => {
    setFile(null)
    setGalleryCharacter(null)
    setInspection(null)
    setError(null)
  }

  const chooseSourceMode = (mode: ImportSourceMode) => {
    setSourceMode(mode)
    setFile(null)
    setGalleryCharacter(null)
    setInspection(null)
    setError(null)
  }

  const pick = async (f: File) => {
    setFile(f)
    setGalleryCharacter(null)
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

  const pickGalleryCharacter = async (character: CharacterSummary) => {
    setGalleryCharacter(character)
    setFile(null)
    setInspection(null)
    setError(null)
    setInspecting(true)
    try {
      setInspection(await inspectGalleryCharacter(character.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('import.gallery.inspectFailed'))
      setGalleryCharacter(null)
    } finally {
      setInspecting(false)
    }
  }

  const loadMoreGalleryCharacters = async () => {
    if (galleryLoading || galleryCharacters.length >= galleryTotal) return
    const request = galleryRequestRef.current
    setGalleryLoading(true)
    try {
      const result = await charactersApi.listSummaries({
        limit: GALLERY_PAGE_SIZE,
        offset: galleryCharacters.length,
        search: galleryQuery.trim() || undefined,
        sort: 'name',
        direction: 'asc',
      })
      if (galleryRequestRef.current !== request) return
      setGalleryCharacters((current) => [
        ...current,
        ...result.data.filter((item) => !current.some((existing) => existing.id === item.id)),
      ])
      setGalleryTotal(result.total)
    } catch (err) {
      if (galleryRequestRef.current === request) {
        setError(err instanceof Error ? err.message : t('import.gallery.loadFailed'))
      }
    } finally {
      if (galleryRequestRef.current === request) setGalleryLoading(false)
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
    if ((!file && !galleryCharacter) || startingAction) return
    setStartingAction(actionId)
    setError(null)
    try {
      const res = galleryCharacter
        ? await startGalleryCharacterImport(galleryCharacter.id, actionId)
        : await startImport(file!, actionId)
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
      ? (galleryCharacter?.name ?? file?.name ?? inspection.name)
      : sourceMode === 'gallery'
        ? t('import.gallery.title')
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
            <div className={s.sourceTabs} role="tablist" aria-label={t('import.sourceLabel')}>
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === 'gallery'}
                className={clsx(s.sourceTab, sourceMode === 'gallery' && s.sourceTabActive)}
                onClick={() => chooseSourceMode('gallery')}
              >
                <Icon name="user" size={14} />
                {t('import.sources.gallery')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sourceMode === 'file'}
                className={clsx(s.sourceTab, sourceMode === 'file' && s.sourceTabActive)}
                onClick={() => chooseSourceMode('file')}
              >
                <Icon name="fileUp" size={14} />
                {t('import.sources.file')}
              </button>
            </div>

            {sourceMode === 'gallery' ? (
              <div className={s.galleryPicker}>
                <div className={s.galleryIntro}>
                  <span className={s.dropTitle}>{t('import.gallery.heading')}</span>
                  <span>{t('import.gallery.help')}</span>
                </div>
                <input
                  className={s.gallerySearch}
                  type="search"
                  value={galleryQuery}
                  placeholder={t('import.gallery.search')}
                  aria-label={t('import.gallery.search')}
                  onChange={(e) => setGalleryQuery(e.target.value)}
                />
                <div className={s.galleryList} aria-busy={galleryLoading}>
                  {galleryCharacters.map((character) => {
                    const avatarUrl = getCharacterAvatarThumbUrl(character)
                    return (
                      <button
                        key={character.id}
                        type="button"
                        className={s.galleryRow}
                        disabled={inspecting}
                        onClick={() => void pickGalleryCharacter(character)}
                      >
                        <span className={s.galleryAvatar}>
                          {avatarUrl
                            ? <img src={avatarUrl} alt="" loading="lazy" />
                            : <span>{character.name.slice(0, 1).toUpperCase() || '·'}</span>}
                        </span>
                        <span className={s.galleryIdentity}>
                          <span className={s.galleryName}>{character.name}</span>
                          <span className={s.galleryMeta}>
                            {character.creator || character.preview_description || t('import.gallery.noDetails')}
                          </span>
                        </span>
                        <Icon name={inspecting && galleryCharacter?.id === character.id ? 'refresh' : 'arrowRight'} size={14} spin={inspecting && galleryCharacter?.id === character.id} />
                      </button>
                    )
                  })}
                  {!galleryLoading && galleryCharacters.length === 0 && (
                    <div className={s.galleryEmpty}>
                      {galleryQuery.trim() ? t('import.gallery.noResults') : t('import.gallery.empty')}
                    </div>
                  )}
                </div>
                {galleryLoading && galleryCharacters.length === 0 && (
                  <div className={s.galleryStatus}><Icon name="refresh" size={13} spin /> {t('import.gallery.loading')}</div>
                )}
                {galleryCharacters.length < galleryTotal && (
                  <div className={s.galleryMore}>
                    <Btn disabled={galleryLoading} onClick={() => void loadMoreGalleryCharacters()}>
                      {galleryLoading ? t('import.gallery.loading') : t('import.gallery.more')}
                    </Btn>
                  </div>
                )}
              </div>
            ) : (
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
            )}
            <div className={s.notes}>
              <div className={s.note}>
                <Icon name="sparkles" size={13} />
                {t('import.noteRebuild')}
              </div>
              <div className={s.note}>
                <Icon name="check" size={13} />
                {sourceMode === 'gallery' ? t('import.gallery.noteOriginal') : t('import.noteOriginal')}
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
                <Btn icon="refresh" onClick={reset}>
                  {galleryCharacter ? t('import.gallery.another') : t('import.another')}
                </Btn>
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
            {inspection.artifact === 'card' && (
              <div className={s.foot}>
                {galleryCharacter ? t('import.gallery.cardFoot') : t('import.cardFoot')}
              </div>
            )}
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

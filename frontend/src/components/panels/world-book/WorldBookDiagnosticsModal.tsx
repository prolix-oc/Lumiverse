import { type MouseEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Link2,
  RefreshCcw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import clsx from 'clsx'
import { worldBooksApi } from '@/api/world-books'
import type { WorldBook, WorldBookDiagnostics } from '@/types/api'
import styles from './WorldBookDiagnosticsModal.module.css'

const DIAGNOSTIC_BREAKDOWN_LABELS: Array<{
  key: keyof WorldBookDiagnostics['vector_hits'][number]['score_breakdown']
  label: string
}> = [
  { key: 'vectorSimilarity', label: 'Vector' },
  { key: 'primaryExact', label: 'Primary exact' },
  { key: 'primaryPartial', label: 'Primary partial' },
  { key: 'secondaryExact', label: 'Alias exact' },
  { key: 'secondaryPartial', label: 'Alias partial' },
  { key: 'commentExact', label: 'Title exact' },
  { key: 'commentPartial', label: 'Title partial' },
  { key: 'priority', label: 'Priority' },
]

function formatDiagnosticNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '0.000'
}

function truncateDiagnosticPreview(text: string, maxLength = 420): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}...`
}

function buildDiagnosticMatchSummary(hit: WorldBookDiagnostics['vector_hits'][number]): string {
  const reasons: string[] = []

  if (hit.matched_primary_keys.length > 0) {
    reasons.push(`primary keys: ${hit.matched_primary_keys.join(', ')}`)
  }
  if (hit.matched_secondary_keys.length > 0) {
    reasons.push(`aliases: ${hit.matched_secondary_keys.join(', ')}`)
  }
  if (hit.matched_comment) {
    reasons.push(`title: ${hit.matched_comment}`)
  }

  if (reasons.length === 0) {
    return 'This entry reached the shortlist mostly on semantic similarity.'
  }

  return `Lexical boosts came from ${reasons.join(' | ')}.`
}

interface Props {
  book: WorldBook
  chatId: string
  onClose: () => void
}

export default function WorldBookDiagnosticsModal({ book, chatId, onClose }: Props) {
  const [diagnostics, setDiagnostics] = useState<WorldBookDiagnostics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadDiagnostics = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await worldBooksApi.getDiagnostics(book.id, chatId)
      setDiagnostics(result)
    } catch (err: any) {
      setDiagnostics(null)
      setError(err?.body?.error || err?.message || 'Failed to diagnose this chat')
    } finally {
      setLoading(false)
    }
  }, [book.id, chatId])

  useEffect(() => {
    void loadDiagnostics()
  }, [loadDiagnostics])

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    document.addEventListener('keydown', handleEscape)
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = previousOverflow
    }
  }, [onClose])

  const attachedSources = useMemo(() => {
    if (!diagnostics) return [] as string[]

    const sources: string[] = []
    if (diagnostics.attachment_sources.character) sources.push('Character')
    if (diagnostics.attachment_sources.persona) sources.push('Persona')
    if (diagnostics.attachment_sources.global) sources.push('Global')
    return sources
  }, [diagnostics])

  const attached = attachedSources.length > 0

  const keywordHitIds = useMemo(
    () => new Set(diagnostics?.keyword_hits.map((hit) => hit.entry_id) ?? []),
    [diagnostics],
  )

  const overlapCount = useMemo(
    () => diagnostics?.vector_hits.reduce((count, hit) => count + (keywordHitIds.has(hit.entry_id) ? 1 : 0), 0) ?? 0,
    [diagnostics, keywordHitIds],
  )

  const freshSemanticCount = diagnostics ? Math.max(diagnostics.vector_hits.length - overlapCount, 0) : 0
  const displacedSemanticCount = diagnostics
    ? Math.max(freshSemanticCount - diagnostics.stats.vectorActivated, 0)
    : 0

  const noteMessages = useMemo(() => {
    if (!diagnostics) return [] as string[]

    const notes = [...diagnostics.blocker_messages]

    if (diagnostics.vector_summary.pending > 0) {
      notes.push(
        `${diagnostics.vector_summary.pending} semantic entries are still pending reindex, so retrieval may still be incomplete.`,
      )
    }

    if (diagnostics.vector_summary.error > 0) {
      notes.push(
        `${diagnostics.vector_summary.error} semantic entries have indexing errors and will not participate until they are fixed and reindexed.`,
      )
    }

    return Array.from(new Set(notes))
  }, [diagnostics])

  const hero = useMemo(() => {
    if (loading && !diagnostics) {
      return {
        tone: 'neutral',
        title: 'Checking this chat',
        body: 'Looking at attachment, embeddings, reranked matches, and final prompt outcome.',
      } as const
    }

    if (error && !diagnostics) {
      return {
        tone: 'warning',
        title: 'Diagnostics could not be loaded',
        body: error,
      } as const
    }

    if (!diagnostics) {
      return {
        tone: 'neutral',
        title: 'No diagnostics available yet',
        body: 'Run diagnostics again to inspect this chat.',
      } as const
    }

    if (!attached) {
      return {
        tone: 'warning',
        title: 'This lorebook is not attached to the current chat',
        body: 'Semantic retrieval cannot inject anything until the book is attached through the character, persona, or global books.',
      } as const
    }

    if (!diagnostics.embeddings.ready) {
      return {
        tone: 'warning',
        title: 'Embeddings are not fully ready',
        body: 'Vector search is gated until embeddings are enabled, a key is configured, dimensions are known, and world-book vectorization is on.',
      } as const
    }

    if (diagnostics.eligible_entries === 0) {
      return {
        tone: 'warning',
        title: 'This book has no semantic-ready entries',
        body: 'No non-empty, semantic-enabled entries are eligible for retrieval in this lorebook.',
      } as const
    }

    if (diagnostics.stats.vectorActivated > 0) {
      return {
        tone: 'success',
        title: `${diagnostics.stats.vectorActivated} semantic entr${diagnostics.stats.vectorActivated === 1 ? 'y' : 'ies'} made the final prompt`,
        body: `Reranking found ${diagnostics.vector_hits.length} semantic candidates, and ${diagnostics.stats.vectorActivated} survived into the final world-info result.`,
      } as const
    }

    if (diagnostics.vector_hits.length === 0) {
      return {
        tone: 'neutral',
        title: 'No semantic matches cleared retrieval',
        body: 'The current chat query did not produce any vector hits that survived thresholding and reranking.',
      } as const
    }

    if (freshSemanticCount === 0) {
      return {
        tone: 'neutral',
        title: 'Semantic retrieval mostly confirmed entries already hit by keywords',
        body: 'The vector shortlist overlaps with keyword matches, so semantic search did not add anything new for this chat.',
      } as const
    }

    if (displacedSemanticCount > 0 || diagnostics.stats.evictedByBudget > 0) {
      return {
        tone: 'warning',
        title: 'Semantic matches were found, but they did not survive final prompt assembly',
        body: `${freshSemanticCount} fresh semantic candidate${freshSemanticCount === 1 ? '' : 's'} appeared after reranking, but ${displacedSemanticCount} were displaced before the final prompt.`,
      } as const
    }

    return {
      tone: 'warning',
      title: 'Semantic retrieval found candidates, but none became vector-activated entries',
      body: 'The reranked shortlist exists, but the final prompt still ended up with zero semantic-only additions.',
    } as const
  }, [attached, diagnostics, displacedSemanticCount, error, freshSemanticCount, loading])

  const handleBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose()
  }

  return createPortal(
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <motion.div
        className={styles.modal}
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.headerCopy}>
            <div className={styles.eyebrow}>Current Chat Diagnostics</div>
            <h2 className={styles.title}>Why "{book.name}" did or did not inject</h2>
            <p className={styles.subtitle}>
              This view checks attachment, semantic readiness, the query built from recent chat context,
              reranked vector matches, and what finally survived into the prompt.
            </p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.refreshButton}
              onClick={() => void loadDiagnostics()}
              disabled={loading}
            >
              <RefreshCcw size={14} className={clsx(loading && styles.refreshIconSpinning)} />
              <span>{loading ? 'Refreshing...' : 'Refresh'}</span>
            </button>
            <button
              type="button"
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Close diagnostics"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className={styles.body}>
          <section className={clsx(styles.heroCard, styles[`hero${hero.tone}`])}>
            <div className={styles.heroIcon}>
              {hero.tone === 'success' ? <CheckCircle2 size={20} /> : hero.tone === 'warning' ? <AlertTriangle size={20} /> : <Sparkles size={20} />}
            </div>
            <div className={styles.heroContent}>
              <div className={styles.heroTitle}>{hero.title}</div>
              <p className={styles.heroBody}>{hero.body}</p>
              {diagnostics && (
                <div className={styles.heroTags}>
                  <span className={styles.heroTag}>
                    <Link2 size={12} />
                    <span>{attached ? attachedSources.join(' + ') : 'Not attached'}</span>
                  </span>
                  <span className={styles.heroTag}>
                    <Activity size={12} />
                    <span>{diagnostics.eligible_entries} eligible semantic entries</span>
                  </span>
                  <span className={styles.heroTag}>
                    <Search size={12} />
                    <span>{diagnostics.vector_hits.length} reranked vector matches</span>
                  </span>
                </div>
              )}
            </div>
          </section>

          {error && diagnostics && (
            <div className={styles.inlineWarning}>{error}</div>
          )}

          {diagnostics && (
            <>
              <div className={styles.metricsGrid}>
                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>Attachment</span>
                  <strong className={styles.metricValue}>{attached ? 'Active' : 'Missing'}</strong>
                  <span className={styles.metricMeta}>
                    {attached
                      ? `Attached via ${attachedSources.join(', ')}`
                      : 'Attach through the character, persona, or global books.'}
                  </span>
                </article>

                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>Semantic Index</span>
                  <strong className={styles.metricValue}>
                    {diagnostics.vector_summary.indexed}/{diagnostics.eligible_entries}
                  </strong>
                  <span className={styles.metricMeta}>
                    {diagnostics.vector_summary.pending} pending, {diagnostics.vector_summary.error} errors
                  </span>
                </article>

                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>Reranked Hits</span>
                  <strong className={styles.metricValue}>{diagnostics.vector_hits.length}</strong>
                  <span className={styles.metricMeta}>
                    {freshSemanticCount} fresh semantic, {overlapCount} already keyword-active
                  </span>
                </article>

                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>Final Prompt</span>
                  <strong className={styles.metricValue}>{diagnostics.stats.totalActivated}</strong>
                  <span className={styles.metricMeta}>
                    {diagnostics.stats.keywordActivated} keyword, {diagnostics.stats.vectorActivated} vector
                  </span>
                </article>
              </div>

              <div className={styles.contentGrid}>
                <div className={styles.primaryColumn}>
                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>Reranked shortlist</div>
                        <h3 className={styles.sectionTitle}>Vector matches</h3>
                      </div>
                      <span className={styles.sectionCount}>{diagnostics.vector_hits.length}</span>
                    </div>

                    {diagnostics.vector_hits.length === 0 ? (
                      <div className={styles.emptyState}>
                        No vector hits survived the threshold and rerank steps for this chat.
                      </div>
                    ) : (
                      <div className={styles.hitList}>
                        {diagnostics.vector_hits.map((hit) => {
                          const breakdownItems = DIAGNOSTIC_BREAKDOWN_LABELS
                            .map(({ key, label }) => ({ label, value: hit.score_breakdown[key] }))
                            .filter((item) => item.value > 0.001)

                          return (
                            <article key={hit.entry_id} className={styles.hitCard}>
                              <div className={styles.hitHeader}>
                                <div className={styles.hitText}>
                                  <div className={styles.hitTitleRow}>
                                    <h4 className={styles.hitTitle}>{hit.comment || '(unnamed entry)'}</h4>
                                    {keywordHitIds.has(hit.entry_id) && (
                                      <span className={styles.keywordBadge}>Already keyword-active</span>
                                    )}
                                  </div>
                                  <p className={styles.hitSummary}>{buildDiagnosticMatchSummary(hit)}</p>
                                </div>
                                <div className={styles.hitScores}>
                                  <span className={styles.scorePill}>Final {formatDiagnosticNumber(hit.final_score)}</span>
                                  <span className={styles.distancePill}>Dist {formatDiagnosticNumber(hit.distance)}</span>
                                </div>
                              </div>

                              {(hit.matched_primary_keys.length > 0 || hit.matched_secondary_keys.length > 0 || hit.matched_comment) && (
                                <div className={styles.matchChipRow}>
                                  {hit.matched_primary_keys.map((value) => (
                                    <span key={`${hit.entry_id}-primary-${value}`} className={styles.matchChip}>
                                      Primary: {value}
                                    </span>
                                  ))}
                                  {hit.matched_secondary_keys.map((value) => (
                                    <span key={`${hit.entry_id}-secondary-${value}`} className={styles.matchChip}>
                                      Alias: {value}
                                    </span>
                                  ))}
                                  {hit.matched_comment && (
                                    <span className={styles.matchChip}>Title: {hit.matched_comment}</span>
                                  )}
                                </div>
                              )}

                              {breakdownItems.length > 0 && (
                                <div className={styles.breakdownGrid}>
                                  {breakdownItems.map((item) => (
                                    <span key={`${hit.entry_id}-${item.label}`} className={styles.breakdownChip}>
                                      <span className={styles.breakdownLabel}>{item.label}</span>
                                      <span className={styles.breakdownValue}>{formatDiagnosticNumber(item.value)}</span>
                                    </span>
                                  ))}
                                </div>
                              )}

                              {hit.search_text_preview && (
                                <div className={styles.previewBlock}>
                                  <div className={styles.previewLabel}>Indexed search text</div>
                                  <div className={styles.previewText}>
                                    {truncateDiagnosticPreview(hit.search_text_preview)}
                                  </div>
                                </div>
                              )}
                            </article>
                          )
                        })}
                      </div>
                    )}
                  </section>
                </div>

                <div className={styles.sideColumn}>
                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>Recent chat context</div>
                        <h3 className={styles.sectionTitle}>Vector query preview</h3>
                      </div>
                    </div>
                    <div className={styles.queryBlock}>
                      {diagnostics.query_preview || 'No recent visible chat messages were available to build a semantic query.'}
                    </div>
                  </section>

                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>Readiness</div>
                        <h3 className={styles.sectionTitle}>What this check saw</h3>
                      </div>
                    </div>
                    <div className={styles.factList}>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Embeddings enabled</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.enabled ? 'Yes' : 'No'}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>API key configured</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.has_api_key ? 'Yes' : 'No'}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Dimensions known</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.dimensions ?? 'Missing'}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>World-book vectorization</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.vectorize_world_books ? 'On' : 'Off'}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Semantic-ready</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.ready ? 'Ready' : 'Not ready'}</span>
                      </div>
                    </div>
                  </section>

                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>Prompt pressure</div>
                        <h3 className={styles.sectionTitle}>What happened after retrieval</h3>
                      </div>
                    </div>
                    <div className={styles.factList}>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Activated before budget</span>
                        <span className={styles.factValue}>{diagnostics.stats.activatedBeforeBudget}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Activated after budget</span>
                        <span className={styles.factValue}>{diagnostics.stats.activatedAfterBudget}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Evicted by budget</span>
                        <span className={styles.factValue}>{diagnostics.stats.evictedByBudget}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Fresh semantic candidates</span>
                        <span className={styles.factValue}>{freshSemanticCount}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Displaced semantic candidates</span>
                        <span className={styles.factValue}>{displacedSemanticCount}</span>
                      </div>
                    </div>
                  </section>

                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>Keyword overlap</div>
                        <h3 className={styles.sectionTitle}>Already-covered entries</h3>
                      </div>
                    </div>
                    <div className={styles.overlapSummary}>
                      {overlapCount} of {diagnostics.vector_hits.length} semantic matches were already activated by keyword logic.
                    </div>
                    {diagnostics.keyword_hits.length > 0 ? (
                      <div className={styles.keywordChips}>
                        {diagnostics.keyword_hits.slice(0, 10).map((hit) => (
                          <span key={hit.entry_id} className={styles.keywordChip}>
                            {hit.comment || '(unnamed entry)'}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.emptyStateSmall}>No keyword matches were reported for this chat.</div>
                    )}
                  </section>

                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>Notes</div>
                        <h3 className={styles.sectionTitle}>Most likely blockers</h3>
                      </div>
                    </div>
                    {noteMessages.length > 0 ? (
                      <div className={styles.noteList}>
                        {noteMessages.map((message) => (
                          <div key={message} className={styles.noteCard}>
                            <AlertTriangle size={14} />
                            <span>{message}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.emptyStateSmall}>
                        No obvious blockers were reported for this chat.
                      </div>
                    )}
                  </section>
                </div>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </div>,
    document.body,
  )
}

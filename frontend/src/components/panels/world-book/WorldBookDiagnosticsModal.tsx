import { type MouseEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Check,
  Copy,
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
  { key: 'focusBoost', label: 'Focus boost' },
  { key: 'priority', label: 'Priority' },
  { key: 'broadPenalty', label: 'Broad penalty' },
  { key: 'focusMissPenalty', label: 'Focus miss penalty' },
]

const SCORE_GUIDE_TITLE = 'How to read these scores'
const SCORE_GUIDE_BODY =
  'Vector distance is the raw semantic distance, so lower is better. Rerank score is the final composite ranking after boosts and penalties, so higher is better.'
const LEXICAL_GUIDE_BODY =
  'Lexical candidate score is an optional keyword/FTS-side signal used during reranking. Higher means stronger lexical support when it appears.'
const CUTOFF_GUIDE_BODY =
  'Similarity Threshold filters on vector distance before reranking. Rerank Cutoff filters on rerank score after reranking.'

function formatDiagnosticNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '0.000'
}

function formatDiagnosticBreakdownValue(
  key: keyof WorldBookDiagnostics['vector_hits'][number]['score_breakdown'],
  value: number,
): string {
  const formatted = formatDiagnosticNumber(value)
  return key === 'broadPenalty' || key === 'focusMissPenalty' ? `-${formatted}` : formatted
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

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    const successful = document.execCommand('copy')
    if (!successful) {
      throw new Error('The browser refused the copy command.')
    }
  } finally {
    document.body.removeChild(textarea)
  }
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
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [copyMessage, setCopyMessage] = useState<string | null>(null)

  const loadDiagnostics = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCopyState('idle')
    setCopyMessage(null)
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

  const reportText = useMemo(() => {
    if (!diagnostics) return ''

    const lines: string[] = [
      'WORLD BOOK CHAT DIAGNOSTICS',
      `Book: ${book.name}`,
      `Book ID: ${book.id}`,
      `Chat ID: ${chatId}`,
      '',
      'SUMMARY',
      `Hero: ${hero.title}`,
      `Attached: ${attached ? attachedSources.join(', ') : 'No'}`,
      `Eligible semantic entries: ${diagnostics.eligible_entries}`,
      `Indexed: ${diagnostics.vector_summary.indexed}`,
      `Pending: ${diagnostics.vector_summary.pending}`,
      `Errors: ${diagnostics.vector_summary.error}`,
      `Vector recall size (top-k): ${diagnostics.retrieval.top_k}`,
      `Hits before similarity threshold: ${diagnostics.retrieval.hits_before_threshold}`,
      `Rejected by similarity threshold: ${diagnostics.retrieval.threshold_rejected}`,
      `Rejected by rerank cutoff: ${diagnostics.retrieval.rerank_rejected}`,
      `Reranked vector hits: ${diagnostics.vector_hits.length}`,
      `Keyword hits: ${diagnostics.keyword_hits.length}`,
      `Keyword/vector overlap: ${overlapCount}`,
      `Fresh semantic candidates: ${freshSemanticCount}`,
      `Displaced semantic candidates: ${displacedSemanticCount}`,
      '',
      'EMBEDDINGS',
      `Enabled: ${diagnostics.embeddings.enabled}`,
      `API key configured: ${diagnostics.embeddings.has_api_key}`,
      `Dimensions: ${diagnostics.embeddings.dimensions ?? 'Missing'}`,
      `World-book vectorization: ${diagnostics.embeddings.vectorize_world_books}`,
      `Similarity threshold: ${formatDiagnosticNumber(diagnostics.embeddings.similarity_threshold)}`,
      `Rerank cutoff: ${formatDiagnosticNumber(diagnostics.embeddings.rerank_cutoff)}`,
      `Ready: ${diagnostics.embeddings.ready}`,
      '',
      'FINAL WORLD INFO STATS',
      `Total candidates: ${diagnostics.stats.totalCandidates}`,
      `Activated before budget: ${diagnostics.stats.activatedBeforeBudget}`,
      `Activated after budget: ${diagnostics.stats.activatedAfterBudget}`,
      `Evicted by budget: ${diagnostics.stats.evictedByBudget}`,
      `Evicted by min priority: ${diagnostics.stats.evictedByMinPriority}`,
      `Keyword activated: ${diagnostics.stats.keywordActivated}`,
      `Vector activated: ${diagnostics.stats.vectorActivated}`,
      `Total activated: ${diagnostics.stats.totalActivated}`,
      `Estimated tokens: ${diagnostics.stats.estimatedTokens}`,
      `Recursion passes used: ${diagnostics.stats.recursionPassesUsed}`,
      '',
      'SCORING GUIDE',
      `- ${SCORE_GUIDE_BODY}`,
      `- ${LEXICAL_GUIDE_BODY}`,
      `- ${CUTOFF_GUIDE_BODY}`,
      '',
      'QUERY PREVIEW',
      diagnostics.query_preview || '(empty)',
      '',
      'BLOCKERS / NOTES',
    ]

    if (noteMessages.length === 0) {
      lines.push('(none)')
    } else {
      for (const message of noteMessages) {
        lines.push(`- ${message}`)
      }
    }

    lines.push('', 'KEYWORD HITS')
    if (diagnostics.keyword_hits.length === 0) {
      lines.push('(none)')
    } else {
      for (const hit of diagnostics.keyword_hits) {
        lines.push(`- ${hit.comment || '(unnamed entry)'} [${hit.entry_id}]`)
      }
    }

    lines.push('', 'VECTOR HITS')
    if (diagnostics.vector_hits.length === 0) {
      lines.push('(none)')
    } else {
      diagnostics.vector_hits.forEach((hit, index) => {
        lines.push(
          `${index + 1}. ${hit.comment || '(unnamed entry)'} [${hit.entry_id}]`,
          `   vector_distance=${formatDiagnosticNumber(hit.distance)} rerank_score=${formatDiagnosticNumber(hit.final_score)} lexical_candidate_score=${hit.lexical_candidate_score == null ? '(none)' : formatDiagnosticNumber(hit.lexical_candidate_score)}`,
          `   matched_primary_keys=${hit.matched_primary_keys.join(', ') || '(none)'}`,
          `   matched_secondary_keys=${hit.matched_secondary_keys.join(', ') || '(none)'}`,
          `   matched_comment=${hit.matched_comment || '(none)'}`,
          `   overlaps_keyword=${keywordHitIds.has(hit.entry_id)}`,
          `   score_breakdown=${Object.entries(hit.score_breakdown)
            .map(([key, value]) => `${key}:${key === 'broadPenalty' || key === 'focusMissPenalty' ? `-${formatDiagnosticNumber(value)}` : formatDiagnosticNumber(value)}`)
            .join(', ')}`,
          '   search_text_preview:',
          `   ${truncateDiagnosticPreview(hit.search_text_preview || '(empty)', 800).replace(/\n/g, '\n   ')}`,
        )
      })
    }

    return lines.join('\n')
  }, [
    attached,
    attachedSources,
    book.id,
    book.name,
    chatId,
    diagnostics,
    displacedSemanticCount,
    freshSemanticCount,
    hero.title,
    keywordHitIds,
    noteMessages,
    overlapCount,
  ])

  const handleCopyReport = useCallback(async () => {
    if (!diagnostics || !reportText) return

    setCopyState('copying')
    setCopyMessage(null)

    try {
      await copyTextToClipboard(reportText)
      setCopyState('copied')
      setCopyMessage('Diagnostics report copied to clipboard.')
      window.setTimeout(() => {
        setCopyState((current) => (current === 'copied' ? 'idle' : current))
        setCopyMessage((current) => (current === 'Diagnostics report copied to clipboard.' ? null : current))
      }, 2400)
    } catch (err: any) {
      setCopyState('error')
      setCopyMessage(err?.message || 'Failed to copy diagnostics report.')
    }
  }, [diagnostics, reportText])

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
              className={clsx(
                styles.secondaryButton,
                copyState === 'copied' && styles.secondaryButtonSuccess,
                copyState === 'error' && styles.secondaryButtonError,
              )}
              onClick={() => void handleCopyReport()}
              disabled={!diagnostics || copyState === 'copying'}
            >
              {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
              <span>
                {copyState === 'copying'
                  ? 'Copying...'
                  : copyState === 'copied'
                    ? 'Copied'
                    : 'Copy report'}
              </span>
            </button>
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
          {copyMessage && (
            <div
              className={clsx(
                styles.inlineNotice,
                copyState === 'error' ? styles.inlineNoticeError : styles.inlineNoticeSuccess,
              )}
            >
              {copyMessage}
            </div>
          )}

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

                    <div className={styles.scoreGuide}>
                      <div className={styles.scoreGuideTitle}>{SCORE_GUIDE_TITLE}</div>
                      <p className={styles.scoreGuideText}>{SCORE_GUIDE_BODY}</p>
                      <p className={styles.scoreGuideText}>{LEXICAL_GUIDE_BODY}</p>
                      <p className={styles.scoreGuideText}>{CUTOFF_GUIDE_BODY}</p>
                    </div>

                    {diagnostics.vector_hits.length === 0 ? (
                      <div className={styles.emptyState}>
                        No vector hits survived the threshold and rerank steps for this chat.
                      </div>
                    ) : (
                      <div className={styles.hitList}>
                        {diagnostics.vector_hits.map((hit) => {
                          const breakdownItems = DIAGNOSTIC_BREAKDOWN_LABELS
                            .map(({ key, label }) => ({ key, label, value: hit.score_breakdown[key] }))
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
                                  <span className={styles.scorePill}>
                                    Rerank score {formatDiagnosticNumber(hit.final_score)}
                                  </span>
                                  <span className={styles.distancePill}>
                                    Vector distance {formatDiagnosticNumber(hit.distance)}
                                  </span>
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
                                      <span className={styles.breakdownValue}>
                                        {formatDiagnosticBreakdownValue(item.key, item.value)}
                                      </span>
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
                        <span className={styles.factLabel}>Similarity threshold</span>
                        <span className={styles.factValue}>{formatDiagnosticNumber(diagnostics.embeddings.similarity_threshold)}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Rerank cutoff</span>
                        <span className={styles.factValue}>{formatDiagnosticNumber(diagnostics.embeddings.rerank_cutoff)}</span>
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
                        <span className={styles.factLabel}>Vector recall size</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.top_k}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Rejected by similarity threshold</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.threshold_rejected}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Rejected by rerank cutoff</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.rerank_rejected}</span>
                      </div>
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

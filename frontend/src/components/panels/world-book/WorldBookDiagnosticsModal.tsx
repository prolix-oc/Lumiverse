import { type MouseEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import {
  Activity,
  AlertTriangle,
  ChevronDown,
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
import { copyTextToClipboard } from '@/lib/clipboard'
import styles from './WorldBookDiagnosticsModal.module.css'

type DiagnosticVectorEntry = WorldBookDiagnostics['vector_trace'][number]
type DiagnosticOutcomeCode = DiagnosticVectorEntry['final_outcome_code']
type DiagnosticBreakdownKey = keyof DiagnosticVectorEntry['score_breakdown']

const DIAGNOSTIC_BREAKDOWN_LABELS: Array<{
  key: DiagnosticBreakdownKey
  label: string
}> = [
  { key: 'vectorSimilarity', label: 'Vector' },
  { key: 'lexicalContentBoost', label: 'FTS content' },
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
  'Vector distance is the raw embedding distance, so lower is better. Rerank score is the final composite ranking after boosts and penalties, so higher is better.'
const LEXICAL_GUIDE_BODY =
  'Lexical candidate score is an optional keyword/FTS-side signal used during reranking. Higher means stronger lexical support when it appears.'
const CUTOFF_GUIDE_BODY =
  'Similarity Threshold filters on vector distance before reranking. Rerank Cutoff filters on rerank score after reranking.'

const OUTCOME_SUMMARY_PRIORITY: DiagnosticOutcomeCode[] = [
  'blocked_by_max_entries',
  'blocked_by_token_budget',
  'blocked_by_group',
  'blocked_by_min_priority',
  'deduplicated',
  'blocked_during_final_assembly',
  'already_keyword',
  'injected_vector',
]

function formatDiagnosticNumber(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '0.000'
}

function formatDiagnosticBreakdownValue(
  key: DiagnosticBreakdownKey,
  value: number,
): string {
  const formatted = formatDiagnosticNumber(value)
  return key === 'broadPenalty' || key === 'focusMissPenalty' ? `-${formatted}` : formatted
}

function truncateDiagnosticPreview(text: string, maxLength = 420): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}...`
}

function buildDiagnosticMatchSummary(hit: DiagnosticVectorEntry): string {
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
    return 'This entry reached the shortlist mostly on vector similarity.'
  }

  return `Lexical boosts came from ${reasons.join(' | ')}.`
}

function joinReadableList(parts: string[]): string {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`
}

function formatOutcomeSummaryPart(
  code: DiagnosticOutcomeCode,
  count: number,
): string {
  switch (code) {
    case 'injected_vector':
      return `${count} made the final prompt`
    case 'already_keyword':
      return `${count} ${count === 1 ? 'was' : 'were'} already keyword-active`
    case 'blocked_by_group':
      return `${count} ${count === 1 ? 'was' : 'were'} blocked by a group rule`
    case 'blocked_by_min_priority':
      return `${count} ${count === 1 ? 'was' : 'were'} below minimum priority`
    case 'blocked_by_max_entries':
      return `${count} had no room under the entry cap`
    case 'blocked_by_token_budget':
      return `${count} had no room under the token budget`
    case 'deduplicated':
      return `${count} ${count === 1 ? 'was' : 'were'} removed as duplicate${count === 1 ? '' : 's'}`
    case 'trimmed_by_top_k':
      return `${count} ${count === 1 ? 'was' : 'were'} outside the returned top-k`
    case 'rejected_by_rerank_cutoff':
      return `${count} ${count === 1 ? 'was' : 'were'} below the rerank cutoff`
    case 'rejected_by_similarity_threshold':
      return `${count} ${count === 1 ? 'was' : 'were'} above the similarity threshold`
    case 'blocked_during_final_assembly':
    default:
      return `${count} ${count === 1 ? 'was' : 'were'} dropped during final assembly`
  }
}

function getOutcomeBadgeClassName(
  code: DiagnosticOutcomeCode,
  styles: Record<string, string>,
): string {
  if (code === 'injected_vector') return styles.outcomeBadgeSuccess
  if (code === 'already_keyword') return styles.outcomeBadgeMuted
  return styles.outcomeBadgeWarning
}

function formatScoreBreakdownReport(
  breakdown: DiagnosticVectorEntry['score_breakdown'],
): string {
  return DIAGNOSTIC_BREAKDOWN_LABELS
    .map(({ key }) => {
      const value = breakdown[key]
      return `${key}:${key === 'broadPenalty' || key === 'focusMissPenalty' ? `-${formatDiagnosticNumber(value)}` : formatDiagnosticNumber(value)}`
    })
    .join(', ')
}

interface Props {
  book: WorldBook
  chatId: string
  onClose: () => void
}

interface DiagnosticCandidateCardProps {
  hit: DiagnosticVectorEntry
  keywordHitIds: Set<string>
}

function DiagnosticCandidateCard({ hit, keywordHitIds }: DiagnosticCandidateCardProps) {
  const breakdownItems = DIAGNOSTIC_BREAKDOWN_LABELS
    .map(({ key, label }) => ({ key, label, value: hit.score_breakdown[key] }))
    .filter((item) => item.value > 0.001)

  return (
    <article className={styles.hitCard}>
      <div className={styles.hitHeader}>
        <div className={styles.hitText}>
          <div className={styles.hitTitleRow}>
            <h4 className={styles.hitTitle}>{hit.comment || '(unnamed entry)'}</h4>
            <span
              className={clsx(
                styles.outcomeBadge,
                getOutcomeBadgeClassName(hit.final_outcome_code, styles),
              )}
            >
              {hit.final_outcome_label}
            </span>
            {hit.rerank_rank != null && (
              <span className={styles.rankBadge}>Rerank #{hit.rerank_rank}</span>
            )}
            {keywordHitIds.has(hit.entry_id) && hit.final_outcome_code !== 'already_keyword' && (
              <span className={styles.keywordBadge}>Already keyword-active</span>
            )}
          </div>
          <p className={styles.hitSummary}>{buildDiagnosticMatchSummary(hit)}</p>
          <p className={styles.hitOutcomeReason}>{hit.final_outcome_reason}</p>
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
}

export default function WorldBookDiagnosticsModal({ book, chatId, onClose }: Props) {
  const [diagnostics, setDiagnostics] = useState<WorldBookDiagnostics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [copyMessage, setCopyMessage] = useState<string | null>(null)
  const [traceSearch, setTraceSearch] = useState('')

  const loadDiagnostics = useCallback(async () => {
    setLoading(true)
    setError(null)
    setCopyState('idle')
    setCopyMessage(null)
    setTraceSearch('')
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
    if (diagnostics.attachment_sources.chat) sources.push('Chat')
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
  const injectedVectorCount = diagnostics
    ? diagnostics.vector_hits.filter((hit) => hit.final_outcome_code === 'injected_vector').length
    : 0
  const pulledTraceCount = diagnostics?.vector_trace.length ?? 0
  const trimmedByTopKCount = diagnostics
    ? diagnostics.vector_trace.filter((hit) => hit.final_outcome_code === 'trimmed_by_top_k').length
    : 0
  const pulledTraceSummaryParts = useMemo(() => {
    if (!diagnostics) return [] as string[]

    const parts: string[] = []
    if (diagnostics.retrieval.threshold_rejected > 0) {
      parts.push(`${diagnostics.retrieval.threshold_rejected} above threshold`)
    }
    if (diagnostics.retrieval.rerank_rejected > 0) {
      parts.push(`${diagnostics.retrieval.rerank_rejected} below rerank cutoff`)
    }
    if (trimmedByTopKCount > 0) {
      parts.push(`${trimmedByTopKCount} outside the returned top-k`)
    }
    if (diagnostics.vector_hits.length > 0) {
      parts.push(`${diagnostics.vector_hits.length} in the shortlist`)
    }
    return parts
  }, [diagnostics, trimmedByTopKCount])
  const filteredVectorTrace = useMemo(() => {
    if (!diagnostics) return [] as WorldBookDiagnostics['vector_trace']

    const search = traceSearch.trim().toLowerCase()
    if (!search) return diagnostics.vector_trace

    return diagnostics.vector_trace.filter((hit) => {
      const haystack = [
        hit.comment,
        hit.final_outcome_label,
        hit.final_outcome_reason,
        hit.matched_comment ?? '',
        hit.search_text_preview,
        ...hit.matched_primary_keys,
        ...hit.matched_secondary_keys,
      ]
        .join('\n')
        .toLowerCase()

      return haystack.includes(search)
    })
  }, [diagnostics, traceSearch])
  const displacedOutcomeSummaryParts = useMemo(() => {
    if (!diagnostics) return [] as string[]

    const counts = new Map<WorldBookDiagnostics['vector_hits'][number]['final_outcome_code'], number>()
    for (const hit of diagnostics.vector_hits) {
      if (keywordHitIds.has(hit.entry_id)) continue
      if (hit.final_outcome_code === 'injected_vector') continue
      counts.set(hit.final_outcome_code, (counts.get(hit.final_outcome_code) ?? 0) + 1)
    }

    return OUTCOME_SUMMARY_PRIORITY
      .map((code) => {
        const count = counts.get(code)
        if (!count) return null
        return formatOutcomeSummaryPart(code, count)
      })
      .filter((value): value is string => Boolean(value))
  }, [diagnostics, keywordHitIds])

  const noteMessages = useMemo(() => {
    if (!diagnostics) return [] as string[]

    const notes = [...diagnostics.blocker_messages]

    if (displacedOutcomeSummaryParts.length > 0) {
      notes.unshift(`Fresh vector candidates were displaced because ${joinReadableList(displacedOutcomeSummaryParts)}.`)
    }

    if (diagnostics.vector_summary.pending > 0) {
      notes.push(
        `${diagnostics.vector_summary.pending} vector entries are still pending reindex, so retrieval may still be incomplete.`,
      )
    }

    if (diagnostics.vector_summary.error > 0) {
      notes.push(
        `${diagnostics.vector_summary.error} vector entries have indexing errors and will not participate until they are fixed and reindexed.`,
      )
    }

    return Array.from(new Set(notes))
  }, [diagnostics, displacedOutcomeSummaryParts])

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
        body: 'Vector retrieval cannot inject anything until the book is attached through the character, persona, or global books.',
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
        title: 'This book has no vector-ready entries',
        body: 'No non-empty, vector-enabled entries are eligible for retrieval in this lorebook.',
      } as const
    }

    if (diagnostics.stats.vectorActivated > 0) {
      return {
        tone: 'success',
        title: `${diagnostics.stats.vectorActivated} vector entr${diagnostics.stats.vectorActivated === 1 ? 'y' : 'ies'} made the final prompt`,
        body: `Retrieval pulled ${pulledTraceCount} candidates, ${diagnostics.retrieval.hits_after_rerank_cutoff} cleared the rerank cutoff, and ${diagnostics.stats.vectorActivated} survived into the final world-info result.`,
      } as const
    }

    if (diagnostics.vector_hits.length === 0) {
      return {
        tone: 'neutral',
        title: 'No vector matches cleared retrieval',
        body: 'The current chat query did not produce any vector hits that survived thresholding and reranking.',
      } as const
    }

    if (freshSemanticCount === 0) {
      return {
        tone: 'neutral',
        title: 'Vector retrieval mostly confirmed entries already hit by keywords',
        body: 'The vector shortlist overlaps with keyword matches, so vector search did not add anything new for this chat.',
      } as const
    }

    if (displacedSemanticCount > 0 || diagnostics.stats.evictedByBudget > 0) {
      const displacementWhy = displacedOutcomeSummaryParts.length > 0
        ? `Why: ${joinReadableList(displacedOutcomeSummaryParts)}.`
        : 'Open the reranked shortlist below to see which entries were displaced and why.'
      return {
        tone: 'warning',
        title: 'Vector matches were found, but they did not survive final prompt assembly',
        body: `Retrieval pulled ${pulledTraceCount} candidates. ${freshSemanticCount} fresh vector candidate${freshSemanticCount === 1 ? '' : 's'} made the shortlist, but ${displacedSemanticCount} were displaced before the final prompt. ${displacementWhy}`,
      } as const
    }

    return {
      tone: 'warning',
      title: 'Vector retrieval found candidates, but none became vector-activated entries',
      body: 'The reranked shortlist exists, but the final prompt still ended up with zero vector-only additions.',
    } as const
  }, [attached, diagnostics, displacedOutcomeSummaryParts, displacedSemanticCount, error, freshSemanticCount, loading, pulledTraceCount])

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
      `Eligible vector entries: ${diagnostics.eligible_entries}`,
      `Indexed: ${diagnostics.vector_summary.indexed}`,
      `Pending: ${diagnostics.vector_summary.pending}`,
      `Errors: ${diagnostics.vector_summary.error}`,
      `Vector recall size (top-k): ${diagnostics.retrieval.top_k}`,
      `Pulled vector candidates: ${diagnostics.vector_trace.length}`,
      `Hits before similarity threshold: ${diagnostics.retrieval.hits_before_threshold}`,
      `Rejected by similarity threshold: ${diagnostics.retrieval.threshold_rejected}`,
      `Cleared similarity threshold: ${diagnostics.retrieval.hits_after_threshold}`,
      `Rejected by rerank cutoff: ${diagnostics.retrieval.rerank_rejected}`,
      `Cleared rerank cutoff: ${diagnostics.retrieval.hits_after_rerank_cutoff}`,
      `Shortlisted vector hits shown: ${diagnostics.vector_hits.length}`,
      `Keyword hits: ${diagnostics.keyword_hits.length}`,
      `Keyword/vector overlap: ${overlapCount}`,
      `Fresh vector candidates: ${freshSemanticCount}`,
      `Displaced vector candidates: ${displacedSemanticCount}`,
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

    lines.push('', 'RERANKED SHORTLIST')
    if (diagnostics.vector_hits.length === 0) {
      lines.push('(none)')
    } else {
      diagnostics.vector_hits.forEach((hit, index) => {
        lines.push(
          `${index + 1}. ${hit.comment || '(unnamed entry)'} [${hit.entry_id}]`,
          `   final_outcome=${hit.final_outcome_label}`,
          `   final_outcome_reason=${hit.final_outcome_reason}`,
          `   vector_distance=${formatDiagnosticNumber(hit.distance)} rerank_score=${formatDiagnosticNumber(hit.final_score)} lexical_candidate_score=${hit.lexical_candidate_score == null ? '(none)' : formatDiagnosticNumber(hit.lexical_candidate_score)}`,
          `   matched_primary_keys=${hit.matched_primary_keys.join(', ') || '(none)'}`,
          `   matched_secondary_keys=${hit.matched_secondary_keys.join(', ') || '(none)'}`,
          `   matched_comment=${hit.matched_comment || '(none)'}`,
          `   overlaps_keyword=${keywordHitIds.has(hit.entry_id)}`,
          `   score_breakdown=${formatScoreBreakdownReport(hit.score_breakdown)}`,
          '   search_text_preview:',
          `   ${truncateDiagnosticPreview(hit.search_text_preview || '(empty)', 800).replace(/\n/g, '\n   ')}`,
        )
      })
    }

    lines.push('', 'ALL PULLED VECTOR CANDIDATES')
    if (diagnostics.vector_trace.length === 0) {
      lines.push('(none)')
    } else {
      diagnostics.vector_trace.forEach((hit, index) => {
        lines.push(
          `${index + 1}. ${hit.comment || '(unnamed entry)'} [${hit.entry_id}]`,
          `   final_outcome=${hit.final_outcome_label}`,
          `   final_outcome_reason=${hit.final_outcome_reason}`,
          `   rerank_rank=${hit.rerank_rank == null ? '(n/a)' : hit.rerank_rank}`,
          `   vector_distance=${formatDiagnosticNumber(hit.distance)} rerank_score=${formatDiagnosticNumber(hit.final_score)} lexical_candidate_score=${hit.lexical_candidate_score == null ? '(none)' : formatDiagnosticNumber(hit.lexical_candidate_score)}`,
          `   matched_primary_keys=${hit.matched_primary_keys.join(', ') || '(none)'}`,
          `   matched_secondary_keys=${hit.matched_secondary_keys.join(', ') || '(none)'}`,
          `   matched_comment=${hit.matched_comment || '(none)'}`,
          `   overlaps_keyword=${keywordHitIds.has(hit.entry_id)}`,
          `   score_breakdown=${formatScoreBreakdownReport(hit.score_breakdown)}`,
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
    pulledTraceCount,
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
              This view checks attachment, vector readiness, the query built from recent chat context,
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
                    <span>{diagnostics.eligible_entries} eligible vector entries</span>
                  </span>
                  <span className={styles.heroTag}>
                    <Search size={12} />
                    <span>{pulledTraceCount} pulled, {diagnostics.vector_hits.length} shown in shortlist</span>
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
                  <span className={styles.metricLabel}>Vector Index</span>
                  <strong className={styles.metricValue}>
                    {diagnostics.vector_summary.indexed}/{diagnostics.eligible_entries}
                  </strong>
                  <span className={styles.metricMeta}>
                    {diagnostics.vector_summary.pending} pending, {diagnostics.vector_summary.error} errors
                  </span>
                </article>

                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>Reranked shortlist</span>
                  <strong className={styles.metricValue}>{diagnostics.vector_hits.length}</strong>
                  <span className={styles.metricMeta}>
                    {pulledTraceCount} pulled, {diagnostics.retrieval.hits_after_rerank_cutoff} cleared cutoff, {injectedVectorCount} made prompt
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
                      <div className={clsx(styles.scrollPanel, styles.shortlistScrollPanel)}>
                        <div className={styles.hitList}>
                          {diagnostics.vector_hits.map((hit) => (
                            <DiagnosticCandidateCard
                              key={hit.entry_id}
                              hit={hit}
                              keywordHitIds={keywordHitIds}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </section>

                  <details className={styles.collapsibleSection}>
                    <summary className={styles.collapsibleSummary}>
                      <div className={styles.collapsibleSummaryCopy}>
                        <div className={styles.sectionEyebrow}>Full retrieval trace</div>
                        <h3 className={styles.sectionTitle}>All pulled vector candidates</h3>
                        <p className={styles.collapsibleSummaryText}>
                          {pulledTraceCount === 0
                            ? 'No candidates were pulled from vector search for this chat.'
                            : `${pulledTraceCount} pulled total. ${pulledTraceSummaryParts.length > 0 ? `${joinReadableList(pulledTraceSummaryParts)}.` : 'Open to inspect every pulled entry and why it stayed or got dropped.'}`}
                        </p>
                      </div>
                      <div className={styles.collapsibleSummaryMeta}>
                        <span className={styles.sectionCount}>{pulledTraceCount}</span>
                        <ChevronDown size={16} className={styles.collapsibleChevron} />
                      </div>
                    </summary>

                    <div className={styles.collapsibleBody}>
                      {diagnostics.vector_trace.length === 0 ? (
                        <div className={styles.emptyStateSmall}>
                          No vector candidates were pulled for this chat.
                        </div>
                      ) : (
                        <>
                          <label className={styles.searchField}>
                            <Search size={14} className={styles.searchIcon} />
                            <input
                              type="text"
                              className={styles.searchInput}
                              value={traceSearch}
                              onChange={(event) => setTraceSearch(event.target.value)}
                              placeholder="Search pulled entries, titles, aliases, outcomes, or indexed text"
                            />
                          </label>
                          <div className={styles.traceSearchMeta}>
                            {traceSearch.trim()
                              ? `${filteredVectorTrace.length} of ${diagnostics.vector_trace.length} pulled candidates match "${traceSearch.trim()}".`
                              : `${diagnostics.vector_trace.length} pulled candidates available.`}
                          </div>
                          {filteredVectorTrace.length === 0 ? (
                            <div className={styles.emptyStateSmall}>
                              No pulled vector candidates match the current search.
                            </div>
                          ) : (
                            <div className={clsx(styles.scrollPanel, styles.traceScrollPanel)}>
                              <div className={styles.hitList}>
                                {filteredVectorTrace.map((hit) => (
                                  <DiagnosticCandidateCard
                                    key={`trace-${hit.entry_id}`}
                                    hit={hit}
                                    keywordHitIds={keywordHitIds}
                                  />
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </details>
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
                      {diagnostics.query_preview || 'No recent visible chat messages were available to build a vector query.'}
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
                        <span className={styles.factLabel}>Vector-ready</span>
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
                        <span className={styles.factLabel}>Pulled candidates</span>
                        <span className={styles.factValue}>{pulledTraceCount}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Rejected by similarity threshold</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.threshold_rejected}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Passed similarity threshold</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.hits_after_threshold}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Rejected by rerank cutoff</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.rerank_rejected}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Cleared rerank cutoff</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.hits_after_rerank_cutoff}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Shown in shortlist</span>
                        <span className={styles.factValue}>{diagnostics.vector_hits.length}</span>
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
                        <span className={styles.factLabel}>Fresh vector candidates</span>
                        <span className={styles.factValue}>{freshSemanticCount}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>Displaced shortlist candidates</span>
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
                        {overlapCount} of {diagnostics.vector_hits.length} vector matches were already activated by keyword logic.
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

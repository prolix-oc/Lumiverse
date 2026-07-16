import { type MouseEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
import { clearSearchOnEscape } from '@/lib/clearableSearch'

type DiagnosticVectorEntry = WorldBookDiagnostics['vector_trace'][number]
type DiagnosticOutcomeCode = DiagnosticVectorEntry['final_outcome_code']
type DiagnosticBreakdownKey = keyof DiagnosticVectorEntry['score_breakdown']

function getDiagnosticBreakdownLabels(t: TFunction<'panels'>): Array<{
  key: DiagnosticBreakdownKey
  label: string
}> {
  return [
    { key: 'vectorSimilarity', label: t('worldBookDiagnostics.breakdown.vectorSimilarity') },
    { key: 'lexicalContentBoost', label: t('worldBookDiagnostics.breakdown.lexicalContentBoost') },
    { key: 'supportingContextBoost', label: t('worldBookDiagnostics.breakdown.supportingContextBoost') },
    { key: 'primaryExact', label: t('worldBookDiagnostics.breakdown.primaryExact') },
    { key: 'primaryPartial', label: t('worldBookDiagnostics.breakdown.primaryPartial') },
    { key: 'secondaryExact', label: t('worldBookDiagnostics.breakdown.secondaryExact') },
    { key: 'secondaryPartial', label: t('worldBookDiagnostics.breakdown.secondaryPartial') },
    { key: 'commentExact', label: t('worldBookDiagnostics.breakdown.commentExact') },
    { key: 'commentPartial', label: t('worldBookDiagnostics.breakdown.commentPartial') },
    { key: 'focusBoost', label: t('worldBookDiagnostics.breakdown.focusBoost') },
    { key: 'priority', label: t('worldBookDiagnostics.breakdown.priority') },
    { key: 'broadPenalty', label: t('worldBookDiagnostics.breakdown.broadPenalty') },
    { key: 'focusMissPenalty', label: t('worldBookDiagnostics.breakdown.focusMissPenalty') },
  ]
}

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

function buildDiagnosticMatchSummary(hit: DiagnosticVectorEntry, t: TFunction<'panels'>): string {
  const reasons: string[] = []

  if (hit.matched_primary_keys.length > 0) {
    reasons.push(t('worldBookDiagnostics.match.primaryKeys', { keys: hit.matched_primary_keys.join(', ') }))
  }
  if (hit.matched_secondary_keys.length > 0) {
    reasons.push(t('worldBookDiagnostics.match.aliases', { aliases: hit.matched_secondary_keys.join(', ') }))
  }
  if (hit.matched_comment) {
    reasons.push(t('worldBookDiagnostics.match.titleMatch', { title: hit.matched_comment }))
  }

  if (reasons.length === 0) {
    return t('worldBookDiagnostics.match.vectorOnly')
  }

  return t('worldBookDiagnostics.match.lexicalBoosts', { reasons: reasons.join(' | ') })
}

function joinReadableList(parts: string[], t: TFunction<'panels'>): string {
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) {
    return t('worldBookDiagnostics.listJoin.two', { first: parts[0], second: parts[1] })
  }
  return t('worldBookDiagnostics.listJoin.many', {
    head: parts.slice(0, -1).join(', '),
    last: parts[parts.length - 1],
  })
}

function formatOutcomeSummaryPart(
  code: DiagnosticOutcomeCode,
  count: number,
  t: TFunction<'panels'>,
): string {
  return t(`worldBookDiagnostics.outcome.${code}`, { count })
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
  t: TFunction<'panels'>,
): string {
  return getDiagnosticBreakdownLabels(t)
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
  const { t } = useTranslation('panels')
  const breakdownItems = getDiagnosticBreakdownLabels(t)
    .map(({ key, label }) => ({ key, label, value: hit.score_breakdown[key] }))
    .filter((item) => item.value > 0.001)

  return (
    <article className={styles.hitCard}>
      <div className={styles.hitHeader}>
        <div className={styles.hitText}>
          <div className={styles.hitTitleRow}>
            <h4 className={styles.hitTitle}>{hit.comment || t('worldBookDiagnostics.unnamedEntry')}</h4>
            <span
              className={clsx(
                styles.outcomeBadge,
                getOutcomeBadgeClassName(hit.final_outcome_code, styles),
              )}
            >
              {hit.final_outcome_label}
            </span>
            {hit.rerank_rank != null && (
              <span className={styles.rankBadge}>{t('worldBookDiagnostics.rerankRank', { rank: hit.rerank_rank })}</span>
            )}
            {keywordHitIds.has(hit.entry_id) && hit.final_outcome_code !== 'already_keyword' && (
              <span className={styles.keywordBadge}>{t('worldBookDiagnostics.alreadyKeywordActive')}</span>
            )}
          </div>
          <p className={styles.hitSummary}>{buildDiagnosticMatchSummary(hit, t)}</p>
          <p className={styles.hitOutcomeReason}>{hit.final_outcome_reason}</p>
        </div>
        <div className={styles.hitScores}>
          <span className={styles.scorePill}>
            {t('worldBookDiagnostics.rerankScore', { score: formatDiagnosticNumber(hit.final_score) })}
          </span>
          <span className={styles.distancePill}>
            {t('worldBookDiagnostics.vectorDistance', { distance: formatDiagnosticNumber(hit.distance) })}
          </span>
        </div>
      </div>

      {(hit.matched_primary_keys.length > 0 || hit.matched_secondary_keys.length > 0 || hit.matched_comment) && (
        <div className={styles.matchChipRow}>
          {hit.matched_primary_keys.map((value) => (
            <span key={`${hit.entry_id}-primary-${value}`} className={styles.matchChip}>
              {t('worldBookDiagnostics.matchPrimary', { value })}
            </span>
          ))}
          {hit.matched_secondary_keys.map((value) => (
            <span key={`${hit.entry_id}-secondary-${value}`} className={styles.matchChip}>
              {t('worldBookDiagnostics.matchAlias', { value })}
            </span>
          ))}
          {hit.matched_comment && (
            <span className={styles.matchChip}>{t('worldBookDiagnostics.matchTitle', { value: hit.matched_comment })}</span>
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
          <div className={styles.previewLabel}>{t('worldBookDiagnostics.indexedSearchText')}</div>
          <div className={styles.previewText}>
            {truncateDiagnosticPreview(hit.search_text_preview)}
          </div>
        </div>
      )}
    </article>
  )
}

export default function WorldBookDiagnosticsModal({ book, chatId, onClose }: Props) {
  const { t } = useTranslation('panels')
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
      setError(err?.body?.error || err?.message || t('worldBookDiagnostics.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [book.id, chatId, t])

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
    if (diagnostics.attachment_sources.character) sources.push(t('worldBookDiagnostics.attachmentSource.character'))
    if (diagnostics.attachment_sources.persona) sources.push(t('worldBookDiagnostics.attachmentSource.persona'))
    if (diagnostics.attachment_sources.chat) sources.push(t('worldBookDiagnostics.attachmentSource.chat'))
    if (diagnostics.attachment_sources.global) sources.push(t('worldBookDiagnostics.attachmentSource.global'))
    return sources
  }, [diagnostics, t])

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
      parts.push(t('worldBookDiagnostics.traceSummary.aboveThreshold', { count: diagnostics.retrieval.threshold_rejected }))
    }
    if (diagnostics.retrieval.rerank_rejected > 0) {
      parts.push(t('worldBookDiagnostics.traceSummary.belowRerank', { count: diagnostics.retrieval.rerank_rejected }))
    }
    if (trimmedByTopKCount > 0) {
      parts.push(t('worldBookDiagnostics.traceSummary.outsideTopK', { count: trimmedByTopKCount }))
    }
    if (diagnostics.vector_hits.length > 0) {
      parts.push(t('worldBookDiagnostics.traceSummary.inShortlist', { count: diagnostics.vector_hits.length }))
    }
    return parts
  }, [diagnostics, trimmedByTopKCount, t])
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
        return formatOutcomeSummaryPart(code, count, t)
      })
      .filter((value): value is string => Boolean(value))
  }, [diagnostics, keywordHitIds, t])

  const noteMessages = useMemo(() => {
    if (!diagnostics) return [] as string[]

    const notes = [...diagnostics.blocker_messages]

    if (displacedOutcomeSummaryParts.length > 0) {
      notes.unshift(t('worldBookDiagnostics.notesDisplaced', {
        reasons: joinReadableList(displacedOutcomeSummaryParts, t),
      }))
    }

    if (diagnostics.vector_summary.pending > 0) {
      notes.push(t('worldBookDiagnostics.notesPending', { count: diagnostics.vector_summary.pending }))
    }

    if (diagnostics.vector_summary.error > 0) {
      notes.push(t('worldBookDiagnostics.notesError', { count: diagnostics.vector_summary.error }))
    }

    return Array.from(new Set(notes))
  }, [diagnostics, displacedOutcomeSummaryParts, t])

  const hero = useMemo(() => {
    if (loading && !diagnostics) {
      return {
        tone: 'neutral',
        title: t('worldBookDiagnostics.hero.checkingTitle'),
        body: t('worldBookDiagnostics.hero.checkingBody'),
      } as const
    }

    if (error && !diagnostics) {
      return {
        tone: 'warning',
        title: t('worldBookDiagnostics.hero.loadErrorTitle'),
        body: error,
      } as const
    }

    if (!diagnostics) {
      return {
        tone: 'neutral',
        title: t('worldBookDiagnostics.hero.noDataTitle'),
        body: t('worldBookDiagnostics.hero.noDataBody'),
      } as const
    }

    if (!attached) {
      return {
        tone: 'warning',
        title: t('worldBookDiagnostics.hero.notAttachedTitle'),
        body: t('worldBookDiagnostics.hero.notAttachedBody'),
      } as const
    }

    if (!diagnostics.embeddings.ready) {
      return {
        tone: 'warning',
        title: t('worldBookDiagnostics.hero.embeddingsNotReadyTitle'),
        body: t('worldBookDiagnostics.hero.embeddingsNotReadyBody'),
      } as const
    }

    if (diagnostics.eligible_entries === 0) {
      return {
        tone: 'warning',
        title: t('worldBookDiagnostics.hero.noEligibleTitle'),
        body: t('worldBookDiagnostics.hero.noEligibleBody'),
      } as const
    }

    if (diagnostics.stats.vectorActivated > 0) {
      return {
        tone: 'success',
        title: t('worldBookDiagnostics.hero.vectorActivatedTitle', { count: diagnostics.stats.vectorActivated }),
        body: t('worldBookDiagnostics.hero.vectorActivatedBody', {
          pulled: pulledTraceCount,
          cleared: diagnostics.retrieval.hits_after_rerank_cutoff,
          activated: diagnostics.stats.vectorActivated,
        }),
      } as const
    }

    if (diagnostics.vector_hits.length === 0) {
      return {
        tone: 'neutral',
        title: t('worldBookDiagnostics.hero.noMatchesTitle'),
        body: t('worldBookDiagnostics.hero.noMatchesBody'),
      } as const
    }

    if (freshSemanticCount === 0) {
      return {
        tone: 'neutral',
        title: t('worldBookDiagnostics.hero.keywordOverlapTitle'),
        body: t('worldBookDiagnostics.hero.keywordOverlapBody'),
      } as const
    }

    if (displacedSemanticCount > 0 || diagnostics.stats.evictedByBudget > 0) {
      const displacementWhy = displacedOutcomeSummaryParts.length > 0
        ? t('worldBookDiagnostics.hero.displacedWhyPrefix', {
          reasons: joinReadableList(displacedOutcomeSummaryParts, t),
        })
        : t('worldBookDiagnostics.hero.displacedWhyFallback')
      return {
        tone: 'warning',
        title: t('worldBookDiagnostics.hero.displacedTitle'),
        body: t('worldBookDiagnostics.hero.displacedBody', {
          pulled: pulledTraceCount,
          fresh: freshSemanticCount,
          displaced: displacedSemanticCount,
          why: displacementWhy,
        }),
      } as const
    }

    return {
      tone: 'warning',
      title: t('worldBookDiagnostics.hero.noVectorActivatedTitle'),
      body: t('worldBookDiagnostics.hero.noVectorActivatedBody'),
    } as const
  }, [attached, diagnostics, displacedOutcomeSummaryParts, displacedSemanticCount, error, freshSemanticCount, loading, pulledTraceCount, t])

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
      'WORLD-BOOK QUERY SCOPE',
      `Global scan depth: ${diagnostics.query_scope.configured_scan_depth ?? 'Unlimited'}`,
      `Visible messages available: ${diagnostics.query_scope.visible_messages_available}`,
      `Vector messages selected: ${diagnostics.query_scope.vector_messages_selected}`,
      `Vector query token limit: ${diagnostics.query_scope.max_tokens}`,
      `Vector query token-truncated: ${diagnostics.query_scope.token_truncated ? 'Yes' : 'No'}`,
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
      `- ${t('worldBookDiagnostics.scoreGuide.body')}`,
      `- ${t('worldBookDiagnostics.scoreGuide.lexical')}`,
      `- ${t('worldBookDiagnostics.scoreGuide.cutoff')}`,
      '',
      'QUERY PREVIEW',
      diagnostics.query_preview || '(empty)',
      '',
      'LEXICAL QUERY PREVIEWS',
      ...(diagnostics.lexical_query_previews.length > 0
        ? diagnostics.lexical_query_previews.flatMap((batch, index) => [
          `Batch ${index + 1} (${batch.kind})`,
          batch.text,
          '',
        ])
        : ['(none)', '']),
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
          `   score_breakdown=${formatScoreBreakdownReport(hit.score_breakdown, t)}`,
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
          `   score_breakdown=${formatScoreBreakdownReport(hit.score_breakdown, t)}`,
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
    t,
  ])

  const handleCopyReport = useCallback(async () => {
    if (!diagnostics || !reportText) return

    setCopyState('copying')
    setCopyMessage(null)

    try {
      await copyTextToClipboard(reportText)
      setCopyState('copied')
      const successMessage = t('worldBookDiagnostics.copySuccess')
      setCopyMessage(successMessage)
      window.setTimeout(() => {
        setCopyState((current) => (current === 'copied' ? 'idle' : current))
        setCopyMessage((current) => (current === successMessage ? null : current))
      }, 2400)
    } catch (err: any) {
      setCopyState('error')
      setCopyMessage(err?.message || t('worldBookDiagnostics.copyFailed'))
    }
  }, [diagnostics, reportText, t])

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
            <div className={styles.eyebrow}>{t('worldBookDiagnostics.headerEyebrow')}</div>
            <h2 className={styles.title}>{t('worldBookDiagnostics.headerTitle', { name: book.name })}</h2>
            <p className={styles.subtitle}>{t('worldBookDiagnostics.headerSubtitle')}</p>
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
                  ? t('worldBookDiagnostics.copying')
                  : copyState === 'copied'
                    ? t('worldBookDiagnostics.copied')
                    : t('worldBookDiagnostics.copyReport')}
              </span>
            </button>
            <button
              type="button"
              className={styles.refreshButton}
              onClick={() => void loadDiagnostics()}
              disabled={loading}
            >
              <RefreshCcw size={14} className={clsx(loading && styles.refreshIconSpinning)} />
              <span>{loading ? t('worldBookDiagnostics.refreshing') : t('worldBookDiagnostics.refresh')}</span>
            </button>
            <button
              type="button"
              className={styles.closeButton}
              onClick={onClose}
              aria-label={t('worldBookDiagnostics.closeAria')}
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
                    <span>{attached ? attachedSources.join(' + ') : t('worldBookDiagnostics.tags.notAttached')}</span>
                  </span>
                  <span className={styles.heroTag}>
                    <Activity size={12} />
                    <span>{t('worldBookDiagnostics.tags.eligibleEntries', { count: diagnostics.eligible_entries })}</span>
                  </span>
                  <span className={styles.heroTag}>
                    <Search size={12} />
                    <span>{t('worldBookDiagnostics.tags.pulledShown', { pulled: pulledTraceCount, shown: diagnostics.vector_hits.length })}</span>
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
                  <span className={styles.metricLabel}>{t('worldBookDiagnostics.metrics.attachment')}</span>
                  <strong className={styles.metricValue}>{attached ? t('worldBookDiagnostics.metrics.active') : t('worldBookDiagnostics.metrics.missing')}</strong>
                  <span className={styles.metricMeta}>
                    {attached
                      ? t('worldBookDiagnostics.metrics.attachedVia', { sources: attachedSources.join(', ') })
                      : t('worldBookDiagnostics.metrics.attachHint')}
                  </span>
                </article>

                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>{t('worldBookDiagnostics.metrics.vectorIndex')}</span>
                  <strong className={styles.metricValue}>
                    {diagnostics.vector_summary.indexed}/{diagnostics.eligible_entries}
                  </strong>
                  <span className={styles.metricMeta}>
                    {t('worldBookDiagnostics.metrics.indexPendingErrors', {
                      pending: diagnostics.vector_summary.pending,
                      errors: diagnostics.vector_summary.error,
                    })}
                  </span>
                </article>

                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>{t('worldBookDiagnostics.metrics.rerankedShortlist')}</span>
                  <strong className={styles.metricValue}>{diagnostics.vector_hits.length}</strong>
                  <span className={styles.metricMeta}>
                    {t('worldBookDiagnostics.metrics.shortlistMeta', {
                      pulled: pulledTraceCount,
                      cleared: diagnostics.retrieval.hits_after_rerank_cutoff,
                      injected: injectedVectorCount,
                    })}
                  </span>
                </article>

                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>{t('worldBookDiagnostics.metrics.finalPrompt')}</span>
                  <strong className={styles.metricValue}>{diagnostics.stats.totalActivated}</strong>
                  <span className={styles.metricMeta}>
                    {t('worldBookDiagnostics.metrics.promptMeta', {
                      keyword: diagnostics.stats.keywordActivated,
                      vector: diagnostics.stats.vectorActivated,
                    })}
                  </span>
                </article>

                <article className={styles.metricCard}>
                  <span className={styles.metricLabel}>{t('worldBookDiagnostics.metrics.vectorTiming')}</span>
                  <strong className={styles.metricValue}>{Math.round(diagnostics.retrieval.timings_ms.total)}ms</strong>
                  <span className={styles.metricMeta}>
                    {t('worldBookDiagnostics.metrics.timingMeta', {
                      search: Math.round(diagnostics.retrieval.timings_ms.search),
                      rank: Math.round(diagnostics.retrieval.timings_ms.ranking),
                    })}
                  </span>
                </article>
              </div>

              <div className={styles.contentGrid}>
                <div className={styles.primaryColumn}>
                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>{t('worldBookDiagnostics.sections.rerankedEyebrow')}</div>
                        <h3 className={styles.sectionTitle}>{t('worldBookDiagnostics.sections.vectorMatches')}</h3>
                      </div>
                      <span className={styles.sectionCount}>{diagnostics.vector_hits.length}</span>
                    </div>

                    <div className={styles.scoreGuide}>
                      <div className={styles.scoreGuideTitle}>{t('worldBookDiagnostics.scoreGuide.title')}</div>
                      <p className={styles.scoreGuideText}>{t('worldBookDiagnostics.scoreGuide.body')}</p>
                      <p className={styles.scoreGuideText}>{t('worldBookDiagnostics.scoreGuide.lexical')}</p>
                      <p className={styles.scoreGuideText}>{t('worldBookDiagnostics.scoreGuide.cutoff')}</p>
                    </div>

                    {diagnostics.vector_hits.length === 0 ? (
                      <div className={styles.emptyState}>
                        {t('worldBookDiagnostics.sections.noVectorHits')}
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
                        <div className={styles.sectionEyebrow}>{t('worldBookDiagnostics.sections.fullTraceEyebrow')}</div>
                        <h3 className={styles.sectionTitle}>{t('worldBookDiagnostics.sections.allPulled')}</h3>
                        <p className={styles.collapsibleSummaryText}>
                          {pulledTraceCount === 0
                            ? t('worldBookDiagnostics.sections.noPulledSummary')
                            : t('worldBookDiagnostics.sections.pulledSummary', {
                              total: pulledTraceCount,
                              details: pulledTraceSummaryParts.length > 0
                                ? `${joinReadableList(pulledTraceSummaryParts, t)}.`
                                : t('worldBookDiagnostics.sections.pulledSummaryFallback'),
                            })}
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
                          {t('worldBookDiagnostics.sections.noPulledCandidates')}
                        </div>
                      ) : (
                        <>
                          <div className={styles.searchField}>
                            <Search size={14} className={styles.searchIcon} />
                            <input
                              type="text"
                              className={styles.searchInput}
                              value={traceSearch}
                              onChange={(event) => setTraceSearch(event.target.value)}
                              onKeyDown={(event) => clearSearchOnEscape(event, traceSearch, () => setTraceSearch(''))}
                              placeholder={t('worldBookDiagnostics.sections.searchPlaceholder')}
                              aria-label={t('worldBookDiagnostics.sections.searchPlaceholder')}
                            />
                            {traceSearch && (
                              <button
                                type="button"
                                className={styles.searchClear}
                                onClick={() => setTraceSearch('')}
                                aria-label={t('worldBookDiagnostics.sections.searchPlaceholder')}
                              >
                                <X size={13} />
                              </button>
                            )}
                          </div>
                          <div className={styles.traceSearchMeta}>
                            {traceSearch.trim()
                              ? t('worldBookDiagnostics.sections.searchMatch', {
                                matched: filteredVectorTrace.length,
                                total: diagnostics.vector_trace.length,
                                query: traceSearch.trim(),
                              })
                              : t('worldBookDiagnostics.sections.searchAvailable', { total: diagnostics.vector_trace.length })}
                          </div>
                          {filteredVectorTrace.length === 0 ? (
                            <div className={styles.emptyStateSmall}>
                              {t('worldBookDiagnostics.sections.searchNoMatch')}
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
                        <div className={styles.sectionEyebrow}>{t('worldBookDiagnostics.sections.queryEyebrow')}</div>
                        <h3 className={styles.sectionTitle}>{t('worldBookDiagnostics.sections.queryTitle')}</h3>
                      </div>
                    </div>
                    <div
                      className={clsx(styles.queryBlock, styles.scrollPanel, styles.queryPreviewScroll)}
                      role="region"
                      aria-label={t('worldBookDiagnostics.sections.queryTitle')}
                      tabIndex={0}
                    >
                      {diagnostics.query_preview || t('worldBookDiagnostics.sections.noQuery')}
                    </div>
                    {diagnostics.lexical_query_previews.map((batch, index) => (
                      <div className={styles.queryBlock} key={`lexical-query-${index}`}>
                        <strong>FTS batch {index + 1} ({batch.kind})</strong>
                        {'\n'}
                        {batch.text}
                      </div>
                    ))}
                  </section>

                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>{t('worldBookDiagnostics.sections.readinessEyebrow')}</div>
                        <h3 className={styles.sectionTitle}>{t('worldBookDiagnostics.sections.readinessTitle')}</h3>
                      </div>
                    </div>
                    <div className={styles.factList}>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.embeddingsEnabled')}</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.enabled ? t('worldBookDiagnostics.yes') : t('worldBookDiagnostics.no')}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.apiKeyConfigured')}</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.has_api_key ? t('worldBookDiagnostics.yes') : t('worldBookDiagnostics.no')}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.dimensionsKnown')}</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.dimensions ?? t('worldBookDiagnostics.missing')}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.worldBookVectorization')}</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.vectorize_world_books ? t('worldBookDiagnostics.on') : t('worldBookDiagnostics.off')}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.globalScanDepth')}</span>
                        <span className={styles.factValue}>{diagnostics.query_scope.configured_scan_depth ?? t('worldBookDiagnostics.unlimited')}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.visibleMessagesAvailable')}</span>
                        <span className={styles.factValue}>{diagnostics.query_scope.visible_messages_available}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.vectorMessagesSelected')}</span>
                        <span className={styles.factValue}>{diagnostics.query_scope.vector_messages_selected}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.vectorQueryTokenLimit')}</span>
                        <span className={styles.factValue}>{diagnostics.query_scope.max_tokens}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.vectorQueryTruncated')}</span>
                        <span className={styles.factValue}>{diagnostics.query_scope.token_truncated ? t('worldBookDiagnostics.yes') : t('worldBookDiagnostics.no')}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.similarityThreshold')}</span>
                        <span className={styles.factValue}>{formatDiagnosticNumber(diagnostics.embeddings.similarity_threshold)}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.rerankCutoff')}</span>
                        <span className={styles.factValue}>{formatDiagnosticNumber(diagnostics.embeddings.rerank_cutoff)}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.vectorReady')}</span>
                        <span className={styles.factValue}>{diagnostics.embeddings.ready ? t('worldBookDiagnostics.ready') : t('worldBookDiagnostics.notReady')}</span>
                      </div>
                    </div>
                  </section>

                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>{t('worldBookDiagnostics.sections.promptEyebrow')}</div>
                        <h3 className={styles.sectionTitle}>{t('worldBookDiagnostics.sections.promptTitle')}</h3>
                      </div>
                    </div>
                    <div className={styles.factList}>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.vectorRecallSize')}</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.top_k}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.pulledCandidates')}</span>
                        <span className={styles.factValue}>{pulledTraceCount}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.queryBuild')}</span>
                        <span className={styles.factValue}>{Math.round(diagnostics.retrieval.timings_ms.query_build)} ms</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.queryEmbed')}</span>
                        <span className={styles.factValue}>{Math.round(diagnostics.retrieval.timings_ms.query_embed)} ms</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.vectorSearch')}</span>
                        <span className={styles.factValue}>{Math.round(diagnostics.retrieval.timings_ms.search)} ms</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.candidateRanking')}</span>
                        <span className={styles.factValue}>{Math.round(diagnostics.retrieval.timings_ms.ranking)} ms</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.finalMerge')}</span>
                        <span className={styles.factValue}>{Math.round(diagnostics.retrieval.timings_ms.merge)} ms</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.totalVectorPath')}</span>
                        <span className={styles.factValue}>{Math.round(diagnostics.retrieval.timings_ms.total)} ms</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.rejectedSimilarity')}</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.threshold_rejected}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.passedSimilarity')}</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.hits_after_threshold}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.rejectedRerank')}</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.rerank_rejected}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.clearedRerank')}</span>
                        <span className={styles.factValue}>{diagnostics.retrieval.hits_after_rerank_cutoff}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.shownInShortlist')}</span>
                        <span className={styles.factValue}>{diagnostics.vector_hits.length}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.activatedBeforeBudget')}</span>
                        <span className={styles.factValue}>{diagnostics.stats.activatedBeforeBudget}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.activatedAfterBudget')}</span>
                        <span className={styles.factValue}>{diagnostics.stats.activatedAfterBudget}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.evictedByBudget')}</span>
                        <span className={styles.factValue}>{diagnostics.stats.evictedByBudget}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.freshVectorCandidates')}</span>
                        <span className={styles.factValue}>{freshSemanticCount}</span>
                      </div>
                      <div className={styles.factRow}>
                        <span className={styles.factLabel}>{t('worldBookDiagnostics.facts.displacedShortlist')}</span>
                        <span className={styles.factValue}>{displacedSemanticCount}</span>
                      </div>
                    </div>
                  </section>

                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>{t('worldBookDiagnostics.sections.overlapEyebrow')}</div>
                        <h3 className={styles.sectionTitle}>{t('worldBookDiagnostics.sections.overlapTitle')}</h3>
                      </div>
                    </div>
                    <div className={styles.overlapSummary}>
                      {t('worldBookDiagnostics.overlapSummary', {
                        overlap: overlapCount,
                        total: diagnostics.vector_hits.length,
                      })}
                    </div>
                    {diagnostics.keyword_hits.length > 0 ? (
                      <div className={styles.keywordChips}>
                        {diagnostics.keyword_hits.slice(0, 10).map((hit) => (
                          <span key={hit.entry_id} className={styles.keywordChip}>
                            {hit.comment || t('worldBookDiagnostics.unnamedEntry')}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className={styles.emptyStateSmall}>{t('worldBookDiagnostics.noKeywordMatches')}</div>
                    )}
                  </section>

                  <section className={styles.sectionCard}>
                    <div className={styles.sectionHeader}>
                      <div>
                        <div className={styles.sectionEyebrow}>{t('worldBookDiagnostics.sections.notesEyebrow')}</div>
                        <h3 className={styles.sectionTitle}>{t('worldBookDiagnostics.sections.notesTitle')}</h3>
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
                        {t('worldBookDiagnostics.sections.noBlockers')}
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

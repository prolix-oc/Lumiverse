import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { charactersApi } from '@/api/characters'
import { Spinner } from '@/components/shared/Spinner'
import { toast } from '@/lib/toast'
import styles from './ChubExpressionBackfillBanner.module.css'

const DISMISSED_KEY = 'lumiverse.chubExpressionBackfillDismissed'

/** Characters named individually in the summary before it collapses to a count. */
const SUMMARY_NAME_LIMIT = 8

type Candidate = { id: string; name: string }

/**
 * Offers a one-time sweep for cards imported before expression packs were
 * pulled automatically.
 *
 * The count comes from a purely local query — cards whose stored provenance
 * points at Chub and which have no expressions yet. Nothing reaches Chub until
 * the user asks, which is why this is phrased as a question: locally we can
 * only tell that a card *might* have a pack, never that it does.
 *
 * Self-suppressing by design. Once a sweep succeeds the count reaches zero and
 * the banner stops appearing on its own, so a one-time migration does not
 * become permanent furniture.
 */
export default function ChubExpressionBackfillBanner() {
  const { t } = useTranslation('panels')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (dismissed) return
    let cancelled = false
    charactersApi
      .chubExpressionCandidates()
      .then((result) => {
        if (!cancelled) setCandidates(result.candidates)
      })
      .catch(() => {
        // A failed scan is not worth interrupting the library for.
      })
    return () => {
      cancelled = true
    }
  }, [dismissed])

  const dismiss = useCallback(() => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISSED_KEY, '1')
    } catch {
      // A browser refusing storage just means the offer returns next visit.
    }
  }, [])

  const fetchAll = useCallback(async () => {
    setRunning(true)
    setProgress(0)
    const updated: Array<{ name: string; imported: number }> = []
    const failedNames: string[] = []
    // Sequential on purpose: the server queues packs and downloads each one in
    // bounded batches, so this loop should not manufacture a large request
    // backlog that could outlive the browser session.
    for (const [index, candidate] of candidates.entries()) {
      try {
        const result = await charactersApi.fetchChubExpressions(candidate.id)
        if (result.imported > 0) updated.push({ name: candidate.name, imported: result.imported })
      } catch {
        failedNames.push(candidate.name)
      }
      setProgress(index + 1)
    }
    setRunning(false)
    setCandidates([])

    const imported = updated.reduce((sum, entry) => sum + entry.imported, 0)
    if (imported === 0 && failedNames.length === 0) {
      toast.info(t('characterBrowser.chubBackfillNothingFound'))
      return
    }

    // A sweep touches several characters at once, so the result is a report
    // rather than a status line — it stays until dismissed, and names what
    // actually changed instead of only counting it.
    const named = updated
      .slice(0, SUMMARY_NAME_LIMIT)
      .map((entry) => t('characterBrowser.chubBackfillSummaryItem', {
        name: entry.name,
        count: entry.imported,
      }))
    const remaining = updated.length - named.length
    const lines = [
      updated.length > 0
        ? t('characterBrowser.chubBackfillSummaryHead', { characters: updated.length, count: imported })
        : t('characterBrowser.chubBackfillNothingFound'),
      ...named,
      ...(remaining > 0 ? [t('characterBrowser.chubBackfillSummaryMore', { count: remaining })] : []),
      // Name the failures too — "3 could not be checked" without saying which
      // leaves nothing to act on.
      ...(failedNames.length > 0
        ? [
            t('characterBrowser.chubBackfillSummaryFailed', { count: failedNames.length }),
            ...failedNames.slice(0, SUMMARY_NAME_LIMIT).map((name) =>
              t('characterBrowser.chubBackfillSummaryFailedItem', { name }),
            ),
            ...(failedNames.length > SUMMARY_NAME_LIMIT
              ? [t('characterBrowser.chubBackfillSummaryMore', { count: failedNames.length - SUMMARY_NAME_LIMIT })]
              : []),
          ]
        : []),
    ]
    toast[failedNames.length > 0 ? 'warning' : 'success'](lines.join('\n'), {
      duration: 0,
      dismissible: true,
    })
  }, [candidates, t])

  if (dismissed || candidates.length === 0) return null

  return (
    <div className={styles.banner}>
      <span className={styles.text}>
        {running
          ? t('characterBrowser.chubBackfillProgress', { done: progress, total: candidates.length })
          : t('characterBrowser.chubBackfillAvailable', { count: candidates.length })}
      </span>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={fetchAll} disabled={running}>
          {running ? <Spinner size={12} /> : null}
          {t('characterBrowser.chubBackfillFetchAll')}
        </button>
        <button type="button" className={styles.dismiss} onClick={dismiss} disabled={running}>
          {t('characterBrowser.chubBackfillDismiss')}
        </button>
      </div>
    </div>
  )
}

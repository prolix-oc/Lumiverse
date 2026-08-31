import { useCallback, useSyncExternalStore } from 'react'
import { useActiveTokenizerModel, useTokenCountSweep } from '@/hooks/useTokenCounts'
import {
  getTokenCountCacheVersion,
  makeTokenCountCacheKey,
  peekTokenCountByKey,
  subscribeTokenCountCache,
} from '@/lib/tokenCountCache'
import { readStoredTokenCount } from '@/lib/storedTokenCount'
import { estimateTokens } from '@/lib/tokenEstimate'
import type { WorldBookEntry } from '@/types/api'
import { useStore } from '@/store'

export interface LorebookResolvedTokenCount {
  value: number
  exact: boolean
}

export function useLorebookTokenCounts(entries: readonly WorldBookEntry[], enabled: boolean) {
  const model = useActiveTokenizerModel(useStore)
  useTokenCountSweep(entries, enabled, useStore)
  useSyncExternalStore(subscribeTokenCountCache, getTokenCountCacheVersion, getTokenCountCacheVersion)

  const resolveTokenCount = useCallback((entry: WorldBookEntry): LorebookResolvedTokenCount => {
    const content = entry.content ?? ''
    if (!model) return { value: estimateTokens(content), exact: false }
    const stored = readStoredTokenCount(entry.extensions, model, content)
    if (stored.exact && stored.count != null) return { value: stored.count, exact: true }
    const cached = peekTokenCountByKey(makeTokenCountCacheKey(model, content))
    if (cached && !cached.approximate) return { value: cached.count, exact: true }
    if (stored.count != null) return { value: stored.count, exact: false }
    if (cached) return { value: cached.count, exact: false }
    return { value: estimateTokens(content), exact: false }
  }, [model])

  return {
    resolveTokenCount,
    handleEntryPointerEnter: (_entryId: string) => undefined,
    handleEntryPointerLeave: (_entryId: string) => undefined,
  }
}

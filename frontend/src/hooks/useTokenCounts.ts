import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { tokenizersApi } from '@/api/tokenizers'
import {
  clearTokenCountCache,
  fnv1a32,
  getTokenCountCacheVersion,
  makeTokenCountCacheKey,
  peekTokenCountByKey,
  setTokenCount,
  subscribeTokenCountCache,
  type TokenCountValue,
} from '@/lib/tokenCountCache'
import { estimateTokens, type TokenizableContent } from '@/lib/tokenEstimate'
import {
  createTokenCountScheduler,
  type TokenCountRequest,
  type TokenCountResult,
  type TokenCountScheduleHandle,
  type TokenCountScheduler,
} from '@/lib/tokenCountScheduler'
import {
  readStoredTokenCount,
  TOKEN_COUNT_APPROXIMATE_EXTENSION,
  TOKEN_COUNT_EXTENSION,
  TOKEN_COUNT_HASH_EXTENSION,
  TOKEN_COUNT_LENGTH_EXTENSION,
  TOKEN_COUNT_MODEL_EXTENSION,
  type StoredTokenCountResult,
} from '@/lib/storedTokenCount'

export interface ResolvedTokenCount {
  count: number
  approximate: boolean
}

interface ResolveTokenCountInput {
  stored: StoredTokenCountResult
  cached: TokenCountValue | undefined
  estimate: number
}

export interface UseTokenCountsOptions {
  persistExactCount?: (values: Readonly<Record<string, string | number | boolean>>) => Promise<void>
  entryId?: string
  content: TokenizableContent
  extensions?: unknown
  enabled?: boolean
}
export type TokenCountStoreState = {
  activeProfileId: string | null
  profiles: Array<{ id: string; model?: string; is_default?: boolean; review_required?: boolean }>
}

export type TokenCountStore = <T>(selector: (state: TokenCountStoreState) => T) => T

export interface UseTokenCountsDependencies {
  store: TokenCountStore
}

export interface TokenCountSweepEntry {
  id: string
  content: string | null | undefined
  extensions?: unknown
}

export interface TokenCountSweepRequest {
  entryId: string
  cacheKey: string
  model: string
  content: string
}

export interface UseTokenCountsResult {
  model: string | null
  count: number | null
  approximate: boolean
  status: 'idle' | 'counting' | 'ready'
  requestCount(): void
  cancel(): void
}

interface ActiveRequest {
  fingerprint: string
  handle: TokenCountScheduleHandle
}

interface ManualFallback {
  fingerprint: string
  count: number
}

interface EntryInvalidationState {
  version: number
  consumers: number
}

const runtimeListeners = new Set<() => void>()
const entryInvalidationVersions = new Map<string, EntryInvalidationState>()
let runtimeVersion = 0

function publishRuntimeMutation(): void {
  runtimeVersion += 1
  for (const listener of [...runtimeListeners]) listener()
}

function subscribeTokenCountRuntime(listener: () => void): () => void {
  runtimeListeners.add(listener)
  return () => {
    runtimeListeners.delete(listener)
  }
}

function getTokenCountRuntimeVersion(): number {
  return runtimeVersion + getTokenCountCacheVersion()
}

subscribeTokenCountCache(publishRuntimeMutation)

export type TokenCountRuntimeApi = Pick<typeof tokenizersApi, 'countForModel' | 'testPattern'>

let tokenCountApiForRuntime: TokenCountRuntimeApi = tokenizersApi

function createRuntimeScheduler(): TokenCountScheduler {
  const runtimeApi = tokenCountApiForRuntime
  return createTokenCountScheduler({
    async run(request: TokenCountRequest, signal: AbortSignal): Promise<TokenCountResult> {
      const response = await runtimeApi.countForModel(request.model, request.content, { signal })
      const count = response.token_count
      if (count == null || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) {
        return { count: estimateTokens(request.content), approximate: true }
      }
      return { count, approximate: false }
    },
    onResult(request, result): void {
      setTokenCount(request.cacheKey, {
        count: result.count,
        approximate: result.approximate,
        model: request.model,
        contentLength: request.content.length,
      })
    },
    onError(request): void {
      setTokenCount(request.cacheKey, {
        count: estimateTokens(request.content),
        approximate: true,
        model: request.model,
        contentLength: request.content.length,
      })
    },
    yieldControl: () => Promise.resolve(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (timer) => clearTimeout(timer),
    now: () => Date.now(),
  })
}

let tokenCountScheduler = createRuntimeScheduler()

/** Resolve the preferred value without treating approximate data as authoritative. */
export function resolveTokenCount({ stored, cached, estimate }: ResolveTokenCountInput): ResolvedTokenCount {
  if (stored.exact && stored.count != null) {
    return { count: stored.count, approximate: false }
  }
  if (cached && !cached.approximate) {
    return { count: cached.count, approximate: false }
  }
  if (stored.count != null && stored.approximate) {
    return { count: stored.count, approximate: true }
  }
  if (cached?.approximate) {
    return { count: cached.count, approximate: true }
  }
  return { count: estimate, approximate: true }
}

/** Resolve the active connection profile model, falling back to the default profile. */
export function useActiveTokenizerModel(store: TokenCountStore): string | null {
  const activeProfileId = store((state) => state.activeProfileId)
  const profiles = store((state) => state.profiles)
  const activeModel = profiles.find((profile) => profile.id === activeProfileId && profile.review_required !== true)?.model
  const defaultModel = profiles.find((profile) => profile.is_default && profile.review_required !== true)?.model
  const candidate = typeof activeModel === 'string' && activeModel.length > 0 ? activeModel : defaultModel
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

export type TokenizerAvailabilityStatus = 'no-model' | 'checking' | 'available' | 'unavailable'

export interface TokenizerAvailability {
  status: TokenizerAvailabilityStatus
  model: string | null
  tokenizerName: string | null
}

const tokenizerPatternProbes = new Map<string, { matched: boolean; tokenizerName: string | null }>()

/**
 * Prove that the active model has a tokenizer before settings enable an
 * all-entry exact-count sweep. A failed request remains uncached so a later
 * mount can recover when a tokenizer is installed or the service returns.
 */
export function useTokenizerAvailability(store: TokenCountStore): TokenizerAvailability {
  const model = useActiveTokenizerModel(store)
  const [, setProbeVersion] = useState(0)

  useEffect(() => {
    if (!model || tokenizerPatternProbes.has(model)) return
    let cancelled = false
    void tokenCountApiForRuntime.testPattern(model)
      .then((result) => {
        tokenizerPatternProbes.set(model, { matched: result.matched, tokenizerName: result.tokenizer_name })
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setProbeVersion((version) => version + 1)
      })
    return () => {
      cancelled = true
    }
  }, [model])

  if (!model) return { status: 'no-model', model: null, tokenizerName: null }
  const probe = tokenizerPatternProbes.get(model)
  if (!probe) return { status: 'checking', model, tokenizerName: null }
  return {
    status: probe.matched ? 'available' : 'unavailable',
    model,
    tokenizerName: probe.tokenizerName,
  }
}

/** Cancel requests and invalidate scheduler consumers for one immutable entry identity. */
export function invalidateTokenCountsForEntry(entryId: string): void {
  if (typeof entryId !== 'string' || entryId.length === 0) return
  const state = entryInvalidationVersions.get(entryId)
  if (state == null || state.consumers === 0) return

  tokenCountScheduler.invalidateEntry(entryId)
  state.version += 1
  publishRuntimeMutation()
}

/** Dispose the shared runtime and clear non-persistent cache/invalidation state. */
export function resetTokenCountRuntime(runtimeApi?: TokenCountRuntimeApi): void {
  tokenCountApiForRuntime = runtimeApi ?? tokenizersApi
  tokenCountScheduler.dispose()
  tokenCountScheduler = createRuntimeScheduler()
  for (const state of entryInvalidationVersions.values()) state.version += 1
  clearTokenCountCache()
  publishRuntimeMutation()
}

/** Manually request a count for one entry snapshot. */
export function useTokenCounts(
  {
    entryId,
    persistExactCount,
    content,
    extensions,
    enabled = true,
  }: UseTokenCountsOptions,
  dependencies: UseTokenCountsDependencies,
): UseTokenCountsResult {
  const model = useActiveTokenizerModel(dependencies.store)
  const syntheticEntryId = useId()

  const normalizedContent = content ?? ''
  const estimate = estimateTokens(content)
  const resolvedEntryId = entryId ?? syntheticEntryId
  const cacheKey = model == null ? null : makeTokenCountCacheKey(model, normalizedContent)
  const fingerprint = `${resolvedEntryId}\u0000${model ?? ''}\u0000${cacheKey ?? normalizedContent.length}`
  const [activeRequest, setActiveRequest] = useState<ActiveRequest | null>(null)
  const [manualFallback, setManualFallback] = useState<ManualFallback | null>(null)
  const activeRequestRef = useRef<ActiveRequest | null>(null)
  const persistedFingerprintRef = useRef<string | null>(null)

  useSyncExternalStore(
    subscribeTokenCountRuntime,
    getTokenCountRuntimeVersion,
    getTokenCountRuntimeVersion,
  )

  const invalidationVersion = entryInvalidationVersions.get(resolvedEntryId)?.version ?? 0
  const cached = cacheKey == null ? undefined : peekTokenCountByKey(cacheKey)
  const stored = model == null
    ? { count: null, exact: false, approximate: false, reason: 'missing' as const }
    : readStoredTokenCount(extensions, model, normalizedContent)
  const resolved = resolveTokenCount({ stored, cached, estimate })
  const hasResolvedValue = stored.count != null || cached != null
  const fallback = manualFallback?.fingerprint === fingerprint ? manualFallback : null
  const requestIsCurrent = activeRequest?.fingerprint === fingerprint
  const count = hasResolvedValue
    ? resolved.count
    : fallback?.count ?? null
  const approximate = hasResolvedValue
    ? resolved.approximate
    : fallback != null
  const status: UseTokenCountsResult['status'] = hasResolvedValue || fallback != null
    ? 'ready'
    : requestIsCurrent ? 'counting' : 'idle'

  const activeFingerprint = useRef(fingerprint)
  activeFingerprint.current = fingerprint

  const cancel = useCallback(() => {
    activeRequestRef.current?.handle.cancel()
    activeRequestRef.current = null
    setActiveRequest(null)
  }, [])

  useEffect(() => {
    const state = entryInvalidationVersions.get(resolvedEntryId)
    if (state == null) {
      entryInvalidationVersions.set(resolvedEntryId, { version: 0, consumers: 1 })
    } else {
      state.consumers += 1
    }

    return () => {
      const current = entryInvalidationVersions.get(resolvedEntryId)
      if (current == null) return

      current.consumers -= 1
      if (current.consumers === 0) entryInvalidationVersions.delete(resolvedEntryId)
    }
  }, [resolvedEntryId])

  useEffect(() => {
    return () => {
      const current = activeRequestRef.current
      if (current?.fingerprint === fingerprint) {
        current.handle.cancel()
        activeRequestRef.current = null
      }
    }
  }, [fingerprint, invalidationVersion])


  useEffect(() => {
    if (
      persistExactCount == null
      || !entryId
      || !model
      || status !== 'ready'
      || count == null
      || approximate
      || readStoredTokenCount(extensions, model, normalizedContent).exact
    ) return

    const persistenceFingerprint = `${fingerprint}\u0000${count}`
    if (persistedFingerprintRef.current === persistenceFingerprint) return
    persistedFingerprintRef.current = persistenceFingerprint

    const values = {
      [TOKEN_COUNT_EXTENSION]: count,
      [TOKEN_COUNT_APPROXIMATE_EXTENSION]: false,
      [TOKEN_COUNT_MODEL_EXTENSION]: model,
      [TOKEN_COUNT_LENGTH_EXTENSION]: normalizedContent.length,
      [TOKEN_COUNT_HASH_EXTENSION]: fnv1a32(normalizedContent),
    }

    void persistExactCount(values).catch(() => {
      if (persistedFingerprintRef.current === persistenceFingerprint) {
        persistedFingerprintRef.current = null
      }
    })
  }, [approximate, count, entryId, extensions, fingerprint, model, normalizedContent, persistExactCount, status])
  const requestCount = useCallback(() => {
    if (!enabled) return
    tokenCountScheduler.notifyActivity()

    setManualFallback(null)
    activeRequestRef.current?.handle.cancel()
    activeRequestRef.current = null
    setActiveRequest(null)

    if (normalizedContent.length === 0) {
      if (cacheKey != null && model != null) {
        setTokenCount(cacheKey, { count: 0, approximate: true, model, contentLength: 0 })
      } else {
        setManualFallback({ fingerprint, count: 0 })
      }
      return
    }

    if (model == null || cacheKey == null) {
      setManualFallback({ fingerprint, count: estimate })
      return
    }

    const handle = tokenCountScheduler.schedule({
      entryId: resolvedEntryId,
      cacheKey,
      model,
      content: normalizedContent,
      priority: 'interactive',
    })
    const request = { fingerprint, handle }
    activeRequestRef.current = request
    setActiveRequest(request)
  }, [cacheKey, enabled, estimate, fingerprint, model, normalizedContent, resolvedEntryId])

  useEffect(() => {
    setActiveRequest(null)
    setManualFallback(null)
  }, [fingerprint, invalidationVersion])

  return { model, count, approximate, status, requestCount, cancel }
}

export function planTokenCountSweep(
  entries: readonly TokenCountSweepEntry[],
  model: string,
): TokenCountSweepRequest[] {
  return entries.flatMap((entry) => {
    const content = entry.content ?? ''
    if (content.length === 0) return []
    const cacheKey = makeTokenCountCacheKey(model, content)
    const cached = peekTokenCountByKey(cacheKey)
    const stored = readStoredTokenCount(entry.extensions, model, content)
    if (stored.exact || (cached != null && !cached.approximate)) return []
    return [{ entryId: entry.id, cacheKey, model, content }]
  })
}

/**
 * Queue a finite, cancellable idle sweep for the supplied entry snapshots.
 * Sweep tasks receive one explicit permit each and remain subject to the
 * scheduler's two-request concurrency ceiling and activity pause.
 */
export function useTokenCountSweep(
  entries: readonly TokenCountSweepEntry[],
  enabled: boolean,
  store: TokenCountStore,
): void {
  const model = useActiveTokenizerModel(store)
  const plan = useMemo(
    () => (!enabled || model == null ? [] : planTokenCountSweep(entries, model)),
    [enabled, entries, model],
  )

  useEffect(() => {
    const handles = plan.map((request) => tokenCountScheduler.schedule({ ...request, priority: 'sweep' }))
    for (let index = 0; index < handles.length; index += 1) tokenCountScheduler.pumpSweep()
    return () => {
      for (const handle of handles) handle.cancel()
    }
  }, [plan])
}

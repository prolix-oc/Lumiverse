import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { applyDisplayRegex, applyDisplayRegexAsync } from '@/lib/regex/compiler'
import { resolveMacrosBatch } from '@/api/macros'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'
import type { RegexScript } from '@/types/regex'

interface ResolvedDisplayRegexTemplates {
  resolvedFindPatterns: Map<string, string>
  resolvedReplacements: Map<string, string>
}

interface DisplayRegexCacheEntry {
  value?: ResolvedDisplayRegexTemplates
  promise?: Promise<ResolvedDisplayRegexTemplates>
}

interface DisplayRegexContentCacheEntry {
  value?: string
  promise?: Promise<string>
  touchedVars?: ReadonlySet<string>
  messageId?: string
}

export interface DisplayPreprocessOpts {
  messageId: string
  role: 'user' | 'assistant' | 'system'
}

interface ResolvedTemplatesState {
  key: string
  value: ResolvedDisplayRegexTemplates
}

interface ResolvedContentState {
  key: string
  value: string
}

interface SlowRegexReport {
  script: RegexScript
  elapsedMs: number
  timedOut: boolean
  thresholdMs: number
}

interface DisplayPreprocessBody {
  messageId: string
  role: string
  rawContent: string
}

interface PendingDisplayPreprocess {
  body: DisplayPreprocessBody
  resolve: (value: string) => void
}

const displayRegexResolutionCache = new Map<string, DisplayRegexCacheEntry>()
const displayRegexContentCache = new Map<string, DisplayRegexContentCacheEntry>()
const displayPreprocessCache = new Map<string, { value?: string; promise?: Promise<string>; touchedVars?: ReadonlySet<string>; messageId?: string }>()
const DISPLAY_PREPROCESS_CACHE_MAX = 500
const displayRegexCacheListeners = new Set<() => void>()
let displayRegexGlobalCv = 0
const displayRegexPerMessageCv = new Map<string, number>()
const slowDisplayRegexToastKeys = new Set<string>()
const displayPreprocessQueues = new Map<string, PendingDisplayPreprocess[]>()
const DISPLAY_PREPROCESS_BATCH_MAX = 64
const DISPLAY_PREPROCESS_BATCH_DELAY_MS = 8
let displayPreprocessFlushTimer: number | null = null

function bumpGlobalCv(): void {
  displayRegexGlobalCv += 1
  for (const listener of displayRegexCacheListeners) listener()
}

function bumpPerMessageCv(messageId: string): void {
  displayRegexPerMessageCv.set(messageId, (displayRegexPerMessageCv.get(messageId) ?? 0) + 1)
  for (const listener of displayRegexCacheListeners) listener()
}

function formatElapsedMs(elapsedMs: number): string {
  if (elapsedMs >= 1000) return `${(elapsedMs / 1000).toFixed(1)}s`
  return `${Math.round(elapsedMs)}ms`
}

function reportSlowDisplayRegex(script: RegexScript, elapsedMs: number, timedOut: boolean, thresholdMs: number): void {
  const versionKey = `${script.id}:${script.updated_at}`
  if (!slowDisplayRegexToastKeys.has(versionKey)) {
    slowDisplayRegexToastKeys.add(versionKey)
    toast.warning(
      timedOut
        ? `Display regex "${script.name}" timed out and was flagged in Regex Scripts.`
        : `Display regex "${script.name}" ran for ${formatElapsedMs(elapsedMs)} and was flagged in Regex Scripts.`,
      { title: 'Slow Regex Script', duration: 7000 },
    )
  }

  void regexApi.reportPerformance(script.id, {
    elapsed_ms: elapsedMs,
    timed_out: timedOut,
    threshold_ms: thresholdMs,
    source: 'display_client',
  }).catch(() => {})
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

async function fetchDisplayPreprocessBatch(
  chatId: string,
  bodies: DisplayPreprocessBody[],
): Promise<string[]> {
  try {
    const res = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}/display-preprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: bodies }),
      credentials: 'include',
    })
    if (!res.ok) return bodies.map((body) => body.rawContent)
    const json = (await res.json()) as { items?: Array<{ content?: unknown }> }
    if (!Array.isArray(json.items)) return bodies.map((body) => body.rawContent)
    return bodies.map((body, index) => {
      const content = json.items?.[index]?.content
      return typeof content === 'string' ? content : body.rawContent
    })
  } catch {
    return bodies.map((body) => body.rawContent)
  }
}

function flushDisplayPreprocessQueue(): void {
  displayPreprocessFlushTimer = null

  for (const [chatId, queue] of displayPreprocessQueues) {
    displayPreprocessQueues.delete(chatId)
    for (let i = 0; i < queue.length; i += DISPLAY_PREPROCESS_BATCH_MAX) {
      const batch = queue.slice(i, i + DISPLAY_PREPROCESS_BATCH_MAX)
      void fetchDisplayPreprocessBatch(chatId, batch.map((item) => item.body))
        .then((contents) => {
          batch.forEach((item, index) => item.resolve(contents[index] ?? item.body.rawContent))
        })
    }
  }
}

function fetchDisplayPreprocess(chatId: string, body: DisplayPreprocessBody): Promise<string> {
  return new Promise((resolve) => {
    const queue = displayPreprocessQueues.get(chatId)
    if (queue) queue.push({ body, resolve })
    else displayPreprocessQueues.set(chatId, [{ body, resolve }])

    if (displayPreprocessFlushTimer === null) {
      displayPreprocessFlushTimer = window.setTimeout(flushDisplayPreprocessQueue, DISPLAY_PREPROCESS_BATCH_DELAY_MS)
    }
  })
}

export function useDisplayPreprocessed(
  content: string,
  chatId: string | null,
  opts: DisplayPreprocessOpts | undefined,
): string {
  const messageIdForSnapshot = opts?.messageId ?? null
  const getSnapshotForThisMessage = useCallback(
    () => getDisplayRegexCacheSnapshot(messageIdForSnapshot),
    [messageIdForSnapshot],
  )
  const cvSnapshot = useSyncExternalStore(
    subscribeDisplayRegexCache,
    getSnapshotForThisMessage,
    getSnapshotForThisMessage,
  )

  const key = useMemo(() => {
    if (!opts?.messageId || !chatId) return null
    return `${chatId}|${opts.messageId}|${opts.role}|${content.length}|${fnv1a(content)}`
  }, [content, opts?.messageId, opts?.role, chatId])

  const cached = key ? displayPreprocessCache.get(key)?.value : undefined
  const [state, setState] = useState<{ key: string; value: string } | null>(() =>
    key && cached !== undefined ? { key, value: cached } : null,
  )

  const lastRef = useRef<{ raw: string; value: string } | null>(null)
  if (key && cached !== undefined) lastRef.current = { raw: content, value: cached }
  else if (key && state?.key === key) lastRef.current = { raw: content, value: state.value }

  useEffect(() => {
    if (!key || !opts?.messageId || !chatId) {
      setState((cur) => (cur === null ? cur : null))
      return
    }
    let cancelled = false
    const apply = (next: string) => {
      if (!cancelled) setState({ key, value: next })
    }
    const existing = displayPreprocessCache.get(key)
    if (existing?.value !== undefined) {
      apply(existing.value)
      return () => { cancelled = true }
    }
    if (!existing?.promise) {
      const messageIdForEntry = opts.messageId
      let assignedPromise: Promise<string>
      const promise = fetchDisplayPreprocess(chatId, {
        messageId: opts.messageId,
        role: opts.role,
        rawContent: content,
      })
        .then((next) => {
          if (displayPreprocessCache.get(key)?.promise === assignedPromise) {
            displayPreprocessCache.set(key, { value: next, messageId: messageIdForEntry })
            if (displayPreprocessCache.size > DISPLAY_PREPROCESS_CACHE_MAX) {
              const drop = displayPreprocessCache.size - DISPLAY_PREPROCESS_CACHE_MAX
              let i = 0
              for (const k of displayPreprocessCache.keys()) {
                if (i++ >= drop) break
                displayPreprocessCache.delete(k)
              }
            }
          }
          return next
        })
        .catch(() => {
          if (displayPreprocessCache.get(key)?.promise === assignedPromise) {
            displayPreprocessCache.delete(key)
          }
          return content
        })
      assignedPromise = promise
      displayPreprocessCache.set(key, { promise, messageId: messageIdForEntry })
    }
    displayPreprocessCache.get(key)?.promise?.then(apply)
    return () => { cancelled = true }
  }, [key, opts?.messageId, opts?.role, chatId, content, cvSnapshot])

  if (!key) return content
  if (cached !== undefined) return cached
  if (state?.key === key) return state.value
  if (lastRef.current?.raw === content) return lastRef.current.value
  return content
}

const RAW_MACRO_RE = /\{\{(?!\s*(?:user|char|bot|notChar|not_char|charName)\s*\}\})/i

/** Quick check for macro syntax in a string. */
function hasMacroSyntax(s: string): boolean {
  return s.includes('{{') || s.includes('<USER>') || s.includes('<BOT>') || s.includes('<CHAR>')
}

function createEmptyResolvedTemplates(): ResolvedDisplayRegexTemplates {
  return {
    resolvedFindPatterns: new Map(),
    resolvedReplacements: new Map(),
  }
}

const EMPTY_RESOLVED_TEMPLATES = createEmptyResolvedTemplates()

function subscribeDisplayRegexCache(listener: () => void): () => void {
  displayRegexCacheListeners.add(listener)
  return () => displayRegexCacheListeners.delete(listener)
}

function getDisplayRegexCacheSnapshot(messageId: string | null): string {
  const perMsg = messageId ? (displayRegexPerMessageCv.get(messageId) ?? 0) : 0
  return `${displayRegexGlobalCv}|${perMsg}`
}

export function invalidateDisplayRegexCache(): void {
  displayRegexResolutionCache.clear()
  displayRegexContentCache.clear()
  displayPreprocessCache.clear()
  bumpGlobalCv()
}

export function invalidateDisplayRegexCacheForMessage(messageId: string): void {
  let removed = 0
  for (const [key, entry] of displayRegexContentCache) {
    if (entry.messageId === messageId) { displayRegexContentCache.delete(key); removed++ }
  }
  for (const [key, entry] of displayPreprocessCache) {
    if (entry.messageId === messageId) { displayPreprocessCache.delete(key); removed++ }
  }
  if (removed > 0) bumpPerMessageCv(messageId)
}

export function invalidateDisplayRegexCacheForVars(changedVars: ReadonlySet<string>): void {
  if (changedVars.size === 0) return
  const affectedMessages = new Set<string>()
  for (const [key, entry] of displayRegexContentCache) {
    const fp = entry.touchedVars
    if (!fp) {
      displayRegexContentCache.delete(key)
      if (entry.messageId) affectedMessages.add(entry.messageId)
      continue
    }
    for (const v of fp) {
      if (changedVars.has(v)) {
        displayRegexContentCache.delete(key)
        if (entry.messageId) affectedMessages.add(entry.messageId)
        break
      }
    }
  }
  for (const [key, entry] of displayPreprocessCache) {
    const fp = entry.touchedVars
    if (!fp) {
      displayPreprocessCache.delete(key)
      if (entry.messageId) affectedMessages.add(entry.messageId)
      continue
    }
    for (const v of fp) {
      if (changedVars.has(v)) {
        displayPreprocessCache.delete(key)
        if (entry.messageId) affectedMessages.add(entry.messageId)
        break
      }
    }
  }
  displayRegexResolutionCache.clear()
  for (const messageId of affectedMessages) bumpPerMessageCv(messageId)
  bumpGlobalCv()
}

async function resolveMacrosBatchChunked(
  templates: Record<string, string>,
  context: {
    chat_id?: string
    character_id?: string
    persona_id?: string
  },
): Promise<Record<string, string>> {
  const entries = Object.entries(templates)
  if (entries.length === 0) return {}

  const chunkPromises: Array<Promise<Record<string, string>>> = []
  for (let i = 0; i < entries.length; i += 100) {
    chunkPromises.push(
      resolveMacrosBatch({
        templates: Object.fromEntries(entries.slice(i, i + 100)),
        ...context,
      }).then((res) => res.resolved),
    )
  }

  const chunks = await Promise.all(chunkPromises)
  return Object.assign({}, ...chunks)
}

export function useDisplayRegex(
  rawContent: string,
  isUser: boolean,
  depth: number,
  macroCtx?: DisplayMacroContext,
  preprocessOpts?: DisplayPreprocessOpts,
): string {
  const regexScripts = useStore((s) => s.regexScripts)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const messageIndex = useStore((s) => {
    if (!preprocessOpts?.messageId) return -1
    return s.messages.findIndex((m) => m.id === preprocessOpts.messageId)
  })
  const messageIdForSnapshot = preprocessOpts?.messageId ?? null
  const getSnapshotForThisMessage = useCallback(
    () => getDisplayRegexCacheSnapshot(messageIdForSnapshot),
    [messageIdForSnapshot],
  )
  const cvSnapshot = useSyncExternalStore(
    subscribeDisplayRegexCache,
    getSnapshotForThisMessage,
    getSnapshotForThisMessage,
  )

  const dynamicMacros = useMemo(() => {
    if (messageIndex < 0) return undefined
    return { chat_index: String(messageIndex) }
  }, [messageIndex])

  const content = useDisplayPreprocessed(rawContent, activeChatId, preprocessOpts)
  const pendingSlowReportsRef = useRef<SlowRegexReport[]>([])

  const displayScripts = useMemo(
    () =>
      regexScripts.filter(
        (s) =>
          s.target === 'display' &&
          !s.disabled &&
          (s.scope === 'global' ||
            (s.scope === 'character' && s.scope_id === activeCharacterId) ||
            (s.scope === 'chat' && s.scope_id === activeChatId)),
      ),
    [regexScripts, activeCharacterId, activeChatId],
  )

  // Collect display scripts that need backend macro resolution
  const scriptsNeedingResolution = useMemo(
    () =>
      displayScripts.filter(
        (s) => s.substitute_macros !== 'none' && (hasMacroSyntax(s.find_regex) || hasMacroSyntax(s.replace_string)),
      ),
    [displayScripts],
  )

  // Pre-resolve find patterns and non-raw replacement strings via the backend macro engine.
  // Raw replacements stay per-match so capture groups remain available before macro evaluation.
  const templateCacheKey = useMemo(() => {
    const templates: Record<string, string> = {}
    for (const s of scriptsNeedingResolution) {
      if (hasMacroSyntax(s.find_regex)) {
        templates[`find:${s.id}`] = s.find_regex
      }
      if (s.substitute_macros !== 'raw' && s.substitute_macros !== 'after' && hasMacroSyntax(s.replace_string)) {
        templates[`replace:${s.id}`] = s.replace_string
      }
    }

    const templateEntries = Object.entries(templates)
    if (templateEntries.length === 0) return null

    return JSON.stringify({
      activeChatId,
      activeCharacterId,
      activePersonaId,
      scripts: scriptsNeedingResolution.map((s) => [
        s.id,
        s.updated_at,
        s.find_regex,
        s.replace_string,
        s.substitute_macros,
      ]),
    })
  }, [scriptsNeedingResolution, activeChatId, activeCharacterId, activePersonaId])

  const cachedTemplates = templateCacheKey ? displayRegexResolutionCache.get(templateCacheKey)?.value : undefined
  const [resolvedTemplatesState, setResolvedTemplatesState] = useState<ResolvedTemplatesState | null>(() => (
    templateCacheKey && cachedTemplates ? { key: templateCacheKey, value: cachedTemplates } : null
  ))

  const resolvedTemplates = cachedTemplates
    ?? (resolvedTemplatesState?.key === templateCacheKey ? resolvedTemplatesState.value : undefined)
    ?? EMPTY_RESOLVED_TEMPLATES

  const [resolvedContentState, setResolvedContentState] = useState<ResolvedContentState | null>(null)

  useEffect(() => {
    if (!templateCacheKey) {
      setResolvedTemplatesState((current) => current === null ? current : null)
      return
    }

    const templates: Record<string, string> = {}
    for (const s of scriptsNeedingResolution) {
      if (hasMacroSyntax(s.find_regex)) {
        templates[`find:${s.id}`] = s.find_regex
      }
      if (s.substitute_macros !== 'raw' && s.substitute_macros !== 'after' && hasMacroSyntax(s.replace_string)) {
        templates[`replace:${s.id}`] = s.replace_string
      }
    }

    const templateEntries = Object.entries(templates)
    if (templateEntries.length === 0) {
      setResolvedTemplatesState((current) => current === null ? current : null)
      return
    }

    let cancelled = false

    const applyResolvedTemplates = (next: ResolvedDisplayRegexTemplates) => {
      if (!cancelled) setResolvedTemplatesState({ key: templateCacheKey, value: next })
    }

    const cached = displayRegexResolutionCache.get(templateCacheKey)
    if (cached?.value) {
      applyResolvedTemplates(cached.value)
      return () => { cancelled = true }
    }

    if (!cached?.promise) {
      let assignedPromise: Promise<ResolvedDisplayRegexTemplates>
      const promise = resolveMacrosBatch({
        templates,
        chat_id: activeChatId ?? undefined,
        character_id: activeCharacterId ?? undefined,
        persona_id: activePersonaId ?? undefined,
      })
        .then((res) => {
          const next = createEmptyResolvedTemplates()
          for (const [key, value] of Object.entries(res.resolved)) {
            if (key.startsWith('find:')) {
              next.resolvedFindPatterns.set(key.slice(5), value)
            } else if (key.startsWith('replace:')) {
              next.resolvedReplacements.set(key.slice(8), value)
            }
          }
          if (displayRegexResolutionCache.get(templateCacheKey)?.promise === assignedPromise) {
            displayRegexResolutionCache.set(templateCacheKey, { value: next })
          }
          return next
        })
        .catch(() => {
          if (displayRegexResolutionCache.get(templateCacheKey)?.promise === assignedPromise) {
            displayRegexResolutionCache.delete(templateCacheKey)
          }
          return createEmptyResolvedTemplates()
        })
      assignedPromise = promise

      displayRegexResolutionCache.set(templateCacheKey, { promise })
    }

    displayRegexResolutionCache.get(templateCacheKey)?.promise?.then(applyResolvedTemplates)

    return () => { cancelled = true }
  }, [scriptsNeedingResolution, templateCacheKey, activeChatId, activeCharacterId, activePersonaId, cvSnapshot])

  const fallbackContent = useMemo(
    () => {
      const slowReports: SlowRegexReport[] = []
      if (displayScripts.length === 0) {
        pendingSlowReportsRef.current = slowReports
        return content
      }
      const next = applyDisplayRegex(content, displayScripts, {
        isUser,
        depth,
        macroCtx,
        resolvedFindPatterns: resolvedTemplates.resolvedFindPatterns,
        resolvedReplacements: resolvedTemplates.resolvedReplacements,
        dynamicMacros,
      }, ({ script, elapsedMs, timedOut, thresholdMs }) => {
        slowReports.push({ script, elapsedMs, timedOut, thresholdMs })
      })
      pendingSlowReportsRef.current = slowReports
      return next
    },
    [content, displayScripts, isUser, depth, macroCtx, resolvedTemplates, dynamicMacros],
  )

  useEffect(() => {
    const reports = pendingSlowReportsRef.current
    if (reports.length === 0) return
    pendingSlowReportsRef.current = []
    for (const report of reports) {
      reportSlowDisplayRegex(report.script, report.elapsedMs, report.timedOut, report.thresholdMs)
    }
  }, [fallbackContent])

  const hasAsyncMacroScripts = useMemo(
    () => displayScripts.some(
      (s) => s.substitute_macros === 'raw' || s.substitute_macros === 'after',
    ),
    [displayScripts],
  )

  const resolvedTemplateKey = useMemo(
    () => JSON.stringify({
      find: Array.from(resolvedTemplates.resolvedFindPatterns.entries()),
      replace: Array.from(resolvedTemplates.resolvedReplacements.entries()),
    }),
    [resolvedTemplates],
  )

  const contentCacheKey = useMemo(() => {
    if (displayScripts.length === 0 || !hasAsyncMacroScripts) return null

    return JSON.stringify({
      activeChatId,
      activeCharacterId,
      activePersonaId,
      isUser,
      depth,
      userName: macroCtx?.userName ?? null,
      charName: macroCtx?.charName ?? null,
      content,
      resolvedTemplateKey,
      dynamicMacros: dynamicMacros ?? null,
      scripts: displayScripts.map((s) => [
        s.id,
        s.updated_at,
        s.find_regex,
        s.replace_string,
        s.flags,
        s.placement,
        s.min_depth,
        s.max_depth,
        s.trim_strings,
        s.substitute_macros,
      ]),
    })
  }, [
    displayScripts,
    hasAsyncMacroScripts,
    activeChatId,
    activeCharacterId,
    activePersonaId,
    isUser,
    depth,
    macroCtx,
    content,
    resolvedTemplateKey,
    dynamicMacros,
  ])

  const cachedResolvedContent = contentCacheKey ? displayRegexContentCache.get(contentCacheKey)?.value : undefined

  useEffect(() => {
    if (!contentCacheKey) {
      setResolvedContentState((current) => current === null ? current : null)
      return
    }

    let cancelled = false
    const applyResolvedContent = (next: string) => {
      if (!cancelled) setResolvedContentState({ key: contentCacheKey, value: next })
    }

    const cached = displayRegexContentCache.get(contentCacheKey)
    if (cached?.value !== undefined) {
      applyResolvedContent(cached.value)
      return () => { cancelled = true }
    }

    if (!cached?.promise) {
      // Captured once so the .then/.catch handlers can verify the cache
      // entry hasn't been replaced or invalidated by a CHAT_CHANGED in flight.
      // Without this guard, an invalidation between the initial set and the
      // resolve would let the stale fetch result clobber the live key.
      let assignedPromise: Promise<string>
      const promise = applyDisplayRegexAsync(
        content,
        displayScripts,
        {
          isUser,
          depth,
          chatId: activeChatId ?? undefined,
          characterId: activeCharacterId ?? undefined,
          personaId: activePersonaId ?? undefined,
          macroCtx,
          resolvedFindPatterns: resolvedTemplates.resolvedFindPatterns,
          resolvedReplacements: resolvedTemplates.resolvedReplacements,
          dynamicMacros,
        },
        (templates) => resolveMacrosBatchChunked(templates, {
          chat_id: activeChatId ?? undefined,
          character_id: activeCharacterId ?? undefined,
          persona_id: activePersonaId ?? undefined,
        }),
      )
        .then(({ result: next, touchedVars, cacheable }) => {
          if (displayRegexContentCache.get(contentCacheKey)?.promise === assignedPromise) {
            if (cacheable !== false) {
              displayRegexContentCache.set(contentCacheKey, {
                value: next,
                ...(touchedVars ? { touchedVars } : {}),
                ...(preprocessOpts?.messageId ? { messageId: preprocessOpts.messageId } : {}),
              })
            } else {
              displayRegexContentCache.delete(contentCacheKey)
            }
          }
          return next
        })
        .catch(() => {
          if (displayRegexContentCache.get(contentCacheKey)?.promise === assignedPromise) {
            displayRegexContentCache.delete(contentCacheKey)
          }
          return fallbackContent
        })
      assignedPromise = promise

      displayRegexContentCache.set(contentCacheKey, {
        promise,
        ...(preprocessOpts?.messageId ? { messageId: preprocessOpts.messageId } : {}),
      })
    }

    displayRegexContentCache.get(contentCacheKey)?.promise?.then(applyResolvedContent)

    return () => { cancelled = true }
  }, [
    content,
    isUser,
    depth,
    macroCtx,
    fallbackContent,
    displayScripts,
    hasAsyncMacroScripts,
    resolvedTemplateKey,
    resolvedTemplates,
    activeChatId,
    activeCharacterId,
    activePersonaId,
    contentCacheKey,
    dynamicMacros,
    cvSnapshot,
  ])

  // Carry the previous resolved value forward across cv-bumps and per-chunk
  // content churn so the sync fallback's raw {{...}} doesn't flash through
  // during the async re-resolve window.
  const lastResolvedRef = useRef<{ content: string; value: string } | null>(null)
  const liveResolved = cachedResolvedContent
    ?? (resolvedContentState?.key === contentCacheKey ? resolvedContentState.value : undefined)
  if (liveResolved !== undefined) {
    lastResolvedRef.current = { content, value: liveResolved }
  }
  const stale = lastResolvedRef.current
  const staleResolved = stale && (stale.content === content || RAW_MACRO_RE.test(fallbackContent))
    ? stale.value
    : undefined

  // No stale to carry forward (first render of a streaming bubble), so raw input renders cleaner than panel HTML with unresolved macros.
  if (liveResolved === undefined && staleResolved === undefined && RAW_MACRO_RE.test(fallbackContent)) {
    return content
  }

  return liveResolved ?? staleResolved ?? fallbackContent
}

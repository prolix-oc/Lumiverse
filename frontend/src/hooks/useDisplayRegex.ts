import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { trackInitialDisplayResolve } from '@/lib/chatDisplaySettle'
import { applyDisplayRegexTiered } from '@/lib/regex/pipeline'
import { canSkipDisplayRegex } from '@/lib/regex/match-gate'
import { applyLiteralDisplayNormalization } from '@/lib/regex/literal-normalization'
import { getRegexScriptCacheKey } from '@/lib/regex/script-cache-key'
import { useDisplayTask } from './useDisplayTask'
import { resolveMacrosBatch } from '@/api/macros'
import { isDisplayChatOwned, getDisplayResolverForChat } from '@/lib/spindle/display-resolver-registry'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'
import type { Message } from '@/types/api'
import type { MessagePresetContext, RegexScript } from '@/types/regex'
import { resetMessagePresetScriptsForTests, useMessagePresetScripts } from './useMessagePresetScripts'
import { canOptimisticallyAppendStreamingText } from '@/lib/display-streaming'
import { TextBudgetCache } from '@/lib/textBudgetCache'

interface ResolvedDisplayRegexTemplates {
  resolvedFindPatterns: Map<string, string>
  resolvedReplacements: Map<string, string>
}

interface DisplayRegexCacheEntry {
  pendingCharacters?: number
  value?: ResolvedDisplayRegexTemplates
  promise?: Promise<ResolvedDisplayRegexTemplates>
  touchedVars?: ReadonlySet<string>
}

interface DisplayRegexContentCacheEntry {
  pendingCharacters?: number
  processingState?: string
  value?: string
  promise?: Promise<string>
  touchedVars?: ReadonlySet<string>
  messageId?: string
}

export interface DisplayPreprocessOpts {
  swipeIndex?: number
  presetContext?: MessagePresetContext
  messageId: string
  role: 'user' | 'assistant' | 'system'
  chatId?: string
  depth?: number
  messageIndex?: number
  dynamicMacros?: Record<string, string>
}

interface ResolvedTemplatesState {
  key: string
  value: ResolvedDisplayRegexTemplates
}

interface ResolvedContentState {
  key: string
  version: unknown
  content: string
  value: string
}

interface DisplayPreprocessBody {
  swipeIndex?: number
  messageId: string
  role: string
  rawContent: string
  depth?: number
  messageIndex?: number
  dynamicMacros?: Record<string, string>
}

interface DisplayPreprocessOutcome {
  processingState?: string
  content: string
  ok: boolean
  touchedVars?: readonly string[]
  cacheable?: boolean
  incrementalRawAppendSafe?: boolean
}

interface PendingDisplayPreprocess {
  body: DisplayPreprocessBody
  resolve: (value: DisplayPreprocessOutcome) => void
}

interface DisplayPreprocessCacheEntry {
  pendingCharacters?: number
  processingState?: string
  value?: string
  promise?: Promise<DisplayPreprocessOutcome>
  touchedVars?: ReadonlySet<string>
  messageId?: string
  incrementalRawAppendSafe?: boolean
}

// Count limits alone allow hundreds of full, progressively longer streaming
// frames or macro-expanded templates to remain live after leaving a chat.
const DISPLAY_CACHE_TEXT_BUDGET = 2 * 1024 * 1024
function variableCharacters(entry: { touchedVars?: ReadonlySet<string> }): number {
  let total = 0
  for (const name of entry.touchedVars ?? []) total += name.length
  return total
}
const displayRegexResolutionCache = new TextBudgetCache<DisplayRegexCacheEntry>(300, DISPLAY_CACHE_TEXT_BUDGET, (entry) => {
  let total = (entry.pendingCharacters ?? 0) + variableCharacters(entry)
  if (entry.value) {
    for (const map of [entry.value.resolvedFindPatterns, entry.value.resolvedReplacements]) {
      for (const [key, value] of map) total += key.length + value.length
    }
  }
  return total
})

function cacheResolvedTemplates(key: string, entry: DisplayRegexCacheEntry): void {
  displayRegexResolutionCache.set(key, entry)
}
function bodyCharacters(entry: DisplayPreprocessCacheEntry | DisplayRegexContentCacheEntry): number {
  return (entry.pendingCharacters ?? 0) + (entry.value?.length ?? 0)
    + (entry.processingState?.length ?? 0) + (entry.messageId?.length ?? 0) + variableCharacters(entry)
}
const displayRegexContentCache = new TextBudgetCache<DisplayRegexContentCacheEntry>(300, DISPLAY_CACHE_TEXT_BUDGET, bodyCharacters)
const displayPreprocessCache = new TextBudgetCache<DisplayPreprocessCacheEntry>(500, DISPLAY_CACHE_TEXT_BUDGET, bodyCharacters)
function getDisplayContentCacheEntry(key: string, processingState: string | undefined) {
  const entry = displayRegexContentCache.get(key)
  return entry?.processingState === processingState ? entry : undefined
}

const displayRegexCacheListeners = new Set<() => void>()
let displayRegexGlobalCv = 0
const displayRegexPerMessageCv = new Map<string, number>()
const displayPreprocessQueues = new Map<string, PendingDisplayPreprocess[]>()
const DISPLAY_PREPROCESS_BATCH_MAX = 64
const DISPLAY_PREPROCESS_BATCH_DELAY_MS = 8
let displayPreprocessFlushTimer: number | null = null

/**
 * The chat reveal gate only needs the first display pass for a live message.
 * Every later streaming flush has a distinct cache key, but treating each of
 * those keys as another "initial" resolve keeps recovery chats hidden for as
 * long as tokens continue to arrive. Keep idle/finalized resolves fully
 * tracked, while registering exactly one key for each message stream.
 *
 * Preprocessing and regex application each use their own instance so the
 * reveal still waits for both stages of the first recovered frame.
 */
function useDisplaySettleTracker(
  chatId: string | null,
  messageId: string | null,
  isStreaming: boolean,
) {
  const identity = chatId && messageId ? `${chatId}\u0000${messageId}` : null
  const stateRef = useRef({
    identity,
    wasStreaming: isStreaming,
    trackedCurrentStream: false,
  })
  const state = stateRef.current

  if (state.identity !== identity || (!state.wasStreaming && isStreaming)) {
    state.identity = identity
    state.trackedCurrentStream = false
  }
  state.wasStreaming = isStreaming

  return useCallback(<T,>(promise: Promise<T>): Promise<T> => {
    if (isStreaming) {
      if (stateRef.current.trackedCurrentStream) return promise
      stateRef.current.trackedCurrentStream = true
    }
    return trackInitialDisplayResolve(promise, chatId)
  }, [chatId, isStreaming])
}

function bumpGlobalCv(): void {
  displayRegexGlobalCv += 1
  for (const listener of displayRegexCacheListeners) listener()
}

function bumpPerMessageCv(messageId: string): void {
  displayRegexPerMessageCv.set(messageId, (displayRegexPerMessageCv.get(messageId) ?? 0) + 1)
  for (const listener of displayRegexCacheListeners) listener()
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

async function resolveTemplatesWithResolver(
  templates: Record<string, string>,
  ctx: { chatId?: string; characterId?: string; personaId?: string; messageId?: string; swipeIndex?: number; presetContext?: MessagePresetContext; presetRegexIds?: string[] },
): Promise<{ resolved: Record<string, string>; touched_vars?: Record<string, string[]>; cacheable?: Record<string, boolean> }> {
  if (ctx.chatId && isDisplayChatOwned(ctx.chatId)) {
    const resolver = getDisplayResolverForChat(ctx.chatId)
    if (resolver) {
      try {
        const local = await resolver.resolveTemplates({
          templates,
          context: {
            chatId: ctx.chatId,
            characterId: ctx.characterId,
            personaId: ctx.personaId,
            isUser: false,
            depth: 0,
            ...(ctx.presetContext ? { messageId: ctx.messageId, presetContext: ctx.presetContext, presetRegexIds: ctx.presetRegexIds } : {}),
          },
        })
        if (local) {
          return {
            resolved: local.resolved,
            ...(local.touchedVars ? { touched_vars: local.touchedVars } : {}),
            ...(local.cacheable ? { cacheable: local.cacheable } : {}),
          }
        }
        console.error(`[display] resolver.resolveTemplates returned null for owned chat=${ctx.chatId}; showing raw (no backend fallback)`)
      } catch (err) {
        console.error(`[display] resolver.resolveTemplates threw for owned chat=${ctx.chatId}; showing raw (no backend fallback)`, err)
      }
    }
    return { resolved: { ...templates } }
  }
  return resolveMacrosBatch({
    templates,
    chat_id: ctx.chatId,
    character_id: ctx.characterId,
    persona_id: ctx.personaId,
    ...(ctx.presetContext ? { message_id: ctx.messageId, swipe_index: ctx.swipeIndex, use_message_preset: true } : {}),
  })
}

async function fetchDisplayPreprocessBatch(
  chatId: string,
  bodies: DisplayPreprocessBody[],
): Promise<DisplayPreprocessOutcome[]> {
  try {
    const res = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}/display-preprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: bodies }),
      credentials: 'include',
    })
    if (!res.ok) return bodies.map((body) => ({ content: body.rawContent, ok: false }))
    const json = (await res.json()) as {
      items?: Array<{ content?: unknown; incrementalRawAppendSafe?: unknown }>
    }
    if (!Array.isArray(json.items)) {
      return bodies.map((body) => ({ content: body.rawContent, ok: false }))
    }
    return bodies.map((body, index) => {
      const item = json.items?.[index]
      return {
        content: typeof item?.content === 'string' ? item.content : body.rawContent,
        ok: typeof item?.content === 'string',
        incrementalRawAppendSafe: item?.incrementalRawAppendSafe === true,
      }
    })
  } catch {
    return bodies.map((body) => ({ content: body.rawContent, ok: false }))
  }
}

function flushDisplayPreprocessQueue(): void {
  displayPreprocessFlushTimer = null

  for (const [chatId, queue] of displayPreprocessQueues) {
    displayPreprocessQueues.delete(chatId)
    for (let i = 0; i < queue.length; i += DISPLAY_PREPROCESS_BATCH_MAX) {
      const batch = queue.slice(i, i + DISPLAY_PREPROCESS_BATCH_MAX)
      void fetchDisplayPreprocessBatch(chatId, batch.map((item) => item.body))
        .then((outcomes) => {
          batch.forEach((item, index) => item.resolve(
            outcomes[index] ?? { content: item.body.rawContent, ok: false },
          ))
        })
    }
  }
}

function enqueueDisplayPreprocess(chatId: string, body: DisplayPreprocessBody): Promise<DisplayPreprocessOutcome> {
  return new Promise((resolve) => {
    const queue = displayPreprocessQueues.get(chatId)
    if (queue) queue.push({ body, resolve })
    else displayPreprocessQueues.set(chatId, [{ body, resolve }])

    if (displayPreprocessFlushTimer === null) {
      displayPreprocessFlushTimer = window.setTimeout(flushDisplayPreprocessQueue, DISPLAY_PREPROCESS_BATCH_DELAY_MS)
    }
  })
}

export function fetchDisplayPreprocess(chatId: string, body: DisplayPreprocessBody, presetContext?: MessagePresetContext): Promise<DisplayPreprocessOutcome> {
  if (isDisplayChatOwned(chatId)) {
    const resolver = getDisplayResolverForChat(chatId)
    if (resolver) {
      return resolver
        .resolveBody({
          content: body.rawContent,
          context: {
            chatId,
            isUser: body.role === 'user',
            depth: body.depth ?? 0,
            messageId: body.messageId,
            role: body.role,
            ...(presetContext ? { presetContext } : {}),
            ...(typeof body.messageIndex === 'number' ? { messageIndex: body.messageIndex } : {}),
            ...(body.dynamicMacros ? { dynamicMacros: body.dynamicMacros } : {}),
          },
        })
        .then((local) => {
          if (local) {
            return {
              content: local.content,
              processingState: local.processingState,
              ok: true,
              ...(Array.isArray(local.touchedVars) && local.touchedVars.length > 0
                ? { touchedVars: local.touchedVars }
                : {}),
              cacheable: local.cacheable !== false,
            }
          }
          console.error(`[display] resolver.resolveBody returned null for owned chat=${chatId}; showing raw (no backend fallback)`)
          return { content: body.rawContent, ok: false }
        })
        .catch((err: unknown) => {
          console.error(`[display] resolver.resolveBody threw for owned chat=${chatId}; showing raw (no backend fallback)`, err)
          return { content: body.rawContent, ok: false }
        })
    }
    return Promise.resolve({ content: body.rawContent, ok: false })
  }
  return enqueueDisplayPreprocess(chatId, body)
}

interface DisplayPreprocessedState {
  processingState?: string
  value: string
  // False while the preprocess is pending or an owning resolver failed.
  ready: boolean
  // False while `value` is a same-identity carry of an OLDER content's
  // preprocess output, i.e. the newest key is still in flight.
  settled: boolean
}

function useDisplayPreprocessedState(
  content: string,
  chatId: string | null,
  opts: DisplayPreprocessOpts | undefined,
  isStreaming = false,
  allowOptimisticRawAppend = false,
): DisplayPreprocessedState {
  const messageId = opts?.messageId ?? null
  const trackForDisplaySettle = useDisplaySettleTracker(chatId, messageId, isStreaming)
  const getSnapshot = useCallback(() => getDisplayRegexCacheSnapshot(messageId), [messageId])
  const cvSnapshot = useSyncExternalStore(subscribeDisplayRegexCache, getSnapshot, getSnapshot)
  const contextKey = useMemo(() => JSON.stringify([
    chatId, messageId, opts?.swipeIndex, opts?.presetContext, opts?.role, opts?.depth, opts?.messageIndex, opts?.dynamicMacros,
  ]), [chatId, messageId, opts?.swipeIndex, opts?.presetContext, opts?.role, opts?.depth, opts?.messageIndex, opts?.dynamicMacros])
  const key = chatId && messageId ? `${contextKey}|${content.length}|${fnv1a(content)}` : null
  const version = `${contextKey}|${cvSnapshot}`
  const schedule = useDisplayTask(version, content, isStreaming)
  type Snapshot = { key: string; version: string; raw: string; outcome: DisplayPreprocessOutcome }
  const [state, setState] = useState<Snapshot | null>(null)
  const seenState = useRef(state)
  const carry = useRef<Snapshot | null>(null)
  const lifecycle = useRef({ chatId, messageId, isStreaming, finishing: false, presetContext: opts?.presetContext })
  if (
    lifecycle.current.chatId !== chatId || lifecycle.current.messageId !== messageId || lifecycle.current.presetContext !== opts?.presetContext
    || (!lifecycle.current.isStreaming && isStreaming)
  ) {
    carry.current = null
    lifecycle.current.finishing = false
  } else if (lifecycle.current.isStreaming && !isStreaming) {
    lifecycle.current.finishing = true
  }
  Object.assign(lifecycle.current, { chatId, messageId, isStreaming, presetContext: opts?.presetContext })

  // Only adopt a completion once; an older completed prefix must never rewind
  // a longer suffix already proven to pass through preprocessing unchanged.
  if (state !== seenState.current) {
    seenState.current = state
    if (state?.version === version && state.outcome.ok && (
      state.key === key || !carry.current || state.raw.startsWith(carry.current.raw)
    )) carry.current = state
  }
  const cached = key ? displayPreprocessCache.get(key) : undefined
  const live = cached?.value !== undefined
    ? { content: cached.value, processingState: cached.processingState, ok: true, incrementalRawAppendSafe: cached.incrementalRawAppendSafe }
    : state?.key === key && state.version === version ? state.outcome : undefined
  if (key && live?.ok) carry.current = { key, version, raw: content, outcome: live }

  const carried = carry.current
  const appendSafe = !!carried && carried.version === version && allowOptimisticRawAppend
    && carried.outcome.incrementalRawAppendSafe === true
    && (content === carried.raw || canOptimisticallyAppendStreamingText(carried.raw, content))
  if (!live && appendSafe) {
    carry.current = {
      key: key!, version, raw: content,
      outcome: { ...carried.outcome, content: carried.outcome.content + content.slice(carried.raw.length) },
    }
  }

  useEffect(() => {
    if (!key || !chatId || !messageId || appendSafe) return
    return schedule(() => {
      const existing = displayPreprocessCache.get(key)
      if (existing?.value !== undefined) return Promise.resolve({
        content: existing.value, processingState: existing.processingState, ok: true, incrementalRawAppendSafe: existing.incrementalRawAppendSafe,
      })
      if (existing?.promise) return existing.promise
      let assigned: Promise<DisplayPreprocessOutcome>
      const promise = fetchDisplayPreprocess(chatId, {
        messageId,
        role: opts.role,
        rawContent: content,
        ...(typeof opts.swipeIndex === 'number' ? { swipeIndex: opts.swipeIndex } : {}),
        ...(typeof opts.depth === 'number' ? { depth: opts.depth } : {}),
        ...(typeof opts.messageIndex === 'number' ? { messageIndex: opts.messageIndex } : {}),
        ...(opts.dynamicMacros ? { dynamicMacros: opts.dynamicMacros } : {}),
      }, opts.presetContext).then((next) => {
        if (displayPreprocessCache.get(key)?.promise === assigned) {
          if (next.ok && next.cacheable !== false) {
            displayPreprocessCache.set(key, {
              value: next.content,
              processingState: next.processingState,
              messageId,
              ...(next.touchedVars ? { touchedVars: new Set(next.touchedVars) } : {}),
              incrementalRawAppendSafe: next.incrementalRawAppendSafe === true,
            })
          } else displayPreprocessCache.delete(key)
        }
        return next
      }).catch(() => {
        if (displayPreprocessCache.get(key)?.promise === assigned) displayPreprocessCache.delete(key)
        return { content, ok: false }
      })
      assigned = trackForDisplaySettle(promise)
      displayPreprocessCache.set(key, { promise: assigned, messageId, pendingCharacters: content.length })
      return assigned
    }, (outcome) => setState({ key, version, raw: content, outcome }))
  }, [key, version, chatId, messageId, content, opts?.swipeIndex, opts?.presetContext, opts?.role, opts?.depth, opts?.messageIndex,
    opts?.dynamicMacros, appendSafe, schedule, trackForDisplaySettle])

  if (!key) return { value: content, ready: true, settled: true }
  if (live) {
    lifecycle.current.finishing = false
    return { value: live.content, processingState: live.processingState, ready: live.ok, settled: true }
  }
  if (appendSafe) return { value: carry.current!.outcome.content, processingState: carry.current!.outcome.processingState, ready: true, settled: true }
  if (carry.current && (isStreaming || lifecycle.current.finishing) && content.length > 0) {
    return { value: carry.current.outcome.content, processingState: carry.current.outcome.processingState, ready: true, settled: false }
  }
  return { value: content, ready: false, settled: false }
}

export function useDisplayPreprocessed(
  content: string,
  chatId: string | null,
  opts: DisplayPreprocessOpts | undefined,
): string {
  return useDisplayPreprocessedState(content, chatId, opts).value
}

const RAW_MACRO_RE = /\{\{(?!\s*(?:user|char|bot|notChar|not_char|charName)\s*\}\})/i

// id→index lookup shared across every mounted message card, built once per
// messages-array identity. The previous per-card findIndex selector was
// O(messages) per card per store update — O(n²) on chat open.
const messageIndexMaps = new WeakMap<readonly Message[], Map<string, number>>()
const previousSameRoleMaps = new WeakMap<
  readonly Message[],
  Map<string, string | undefined>
>()

function getMessageIndex(messages: readonly Message[], messageId: string): number {
  let map = messageIndexMaps.get(messages)
  if (!map) {
    map = new Map()
    for (let i = 0; i < messages.length; i++) map.set(messages[i]!.id, i)
    messageIndexMaps.set(messages, map)
  }
  return map.get(messageId) ?? -1
}

function getPreviousSameRoleContent(
  messages: readonly Message[],
  messageId: string,
): string | undefined {
  let map = previousSameRoleMaps.get(messages)
  if (!map) {
    map = new Map()
    const greeting = messages[0]?.content
    let previousUser: string | undefined
    let previousAssistant: string | undefined
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index]!
      map.set(
        message.id,
        index === 0
          ? undefined
          : message.is_user
            ? previousUser ?? greeting
            : previousAssistant ?? greeting,
      )
      if (message.is_user) previousUser = message.content
      else previousAssistant = message.content
    }
    previousSameRoleMaps.set(messages, map)
  }
  return map.get(messageId)
}

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
    // Entries without touchedVars are dependency-free (output depends only on
    // their cache key), so var-scoped invalidation cannot affect them.
    if (!fp) continue
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
    if (!fp) continue
    for (const v of fp) {
      if (changedVars.has(v)) {
        displayPreprocessCache.delete(key)
        if (entry.messageId) affectedMessages.add(entry.messageId)
        break
      }
    }
  }
  // Selective clear by touchedVars
  for (const [key, entry] of displayRegexResolutionCache) {
    const fp = entry.touchedVars
    if (!fp) { displayRegexResolutionCache.delete(key); continue }
    for (const v of fp) {
      if (changedVars.has(v)) { displayRegexResolutionCache.delete(key); break }
    }
  }
  for (const messageId of affectedMessages) bumpPerMessageCv(messageId)
  bumpGlobalCv()
}

export function seedDisplayPreprocessEntryForTests(entry: {
  key: string
  value: string
  messageId?: string
  touchedVars?: Iterable<string>
}): void {
  displayPreprocessCache.set(entry.key, {
    value: entry.value,
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(entry.touchedVars ? { touchedVars: new Set(entry.touchedVars) } : {}),
  })
}

export function getDisplayPreprocessCacheStatsForTests(): { size: number } {
  return { size: displayPreprocessCache.size }
}

export function seedDisplayContentEntryForTests(entry: {
  key: string
  value: string
  messageId?: string
  touchedVars?: Iterable<string>
}): void {
  displayRegexContentCache.set(entry.key, {
    value: entry.value,
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(entry.touchedVars ? { touchedVars: new Set(entry.touchedVars) } : {}),
  })
}

export function getDisplayContentCacheStatsForTests(): { size: number; templateSize: number; keyCharacters: number; retainedCharacters: number; hasKey(key: string): boolean } {
  let keyCharacters = 0
  for (const key of displayRegexContentCache.keys()) keyCharacters += key.length
  return { size: displayRegexContentCache.size, templateSize: displayRegexResolutionCache.size, keyCharacters,
    retainedCharacters: displayRegexContentCache.retainedCharacters, hasKey: (k) => displayRegexContentCache.has(k) }
}

export function resetDisplayRegexCachesForTests(): void {
  resetMessagePresetScriptsForTests()
  displayPreprocessCache.clear()
  displayRegexContentCache.clear()
  displayRegexResolutionCache.clear()
  displayRegexPerMessageCv.clear()
}

export function useDisplayRegex(
  ...args: Parameters<typeof useDisplayRegexState>
): string {
  return useDisplayRegexState(...args).content
}

/** `pending` means provisional first-pass content, not a refresh of visible output. */
export function useDisplayRegexState(
  rawContent: string,
  isUser: boolean,
  depth: number,
  macroCtx?: DisplayMacroContext,
  preprocessOpts?: DisplayPreprocessOpts,
  isStreaming = false,
): { content: string; pending: boolean; scripts: RegexScript[] } {
  const configuredRegexScripts = useStore((s) => s.regexScripts)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const scopedChatId = preprocessOpts?.chatId ?? activeChatId
  const activePersonaId = useStore((s) => s.activePersonaId)
  const messageIndex = useStore((s) => {
    if (!preprocessOpts?.messageId) return -1
    return getMessageIndex(s.messages, preprocessOpts.messageId)
  })
  const messageIdForSnapshot = preprocessOpts?.messageId ?? null
  const trackContentForDisplaySettle = useDisplaySettleTracker(
    scopedChatId,
    messageIdForSnapshot,
    isStreaming,
  )
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
  const macroCharacterId = activeGroupCharacterId ?? activeCharacterId
  const storedPresetContext = useStore((s) => {
    const message = preprocessOpts?.messageId ? s.messages[getMessageIndex(s.messages, preprocessOpts.messageId)] : undefined
    return message?.extra?.spindle_metadata?.preset_contexts?.[preprocessOpts?.swipeIndex ?? message?.swipe_id ?? 0] as MessagePresetContext | undefined
  })
  const storedSwipeIndex = useStore((s) => preprocessOpts?.messageId
    ? s.messages[getMessageIndex(s.messages, preprocessOpts.messageId)]?.swipe_id : undefined)
  const presetSwipeIndex = preprocessOpts?.swipeIndex ?? storedSwipeIndex
  const presetContextKey = JSON.stringify(preprocessOpts?.presetContext ?? storedPresetContext ?? null)
  const presetContext = useMemo<MessagePresetContext | undefined>(() => {
    const value = JSON.parse(presetContextKey)
    return typeof value?.preset_id === 'string' && value.preset_id ? value : undefined
  }, [presetContextKey])
  const presetScripts = useMessagePresetScripts(presetContext?.preset_id, scopedChatId, macroCharacterId, configuredRegexScripts)
  const regexScripts = presetScripts.scripts ?? configuredRegexScripts
  const presetRegexIds = useMemo(() => presetContext
    ? regexScripts.filter(s => s.preset_id === presetContext.preset_id && !s.owner_extension_identifier).map(s => s.id) : undefined,
  [presetContext, regexScripts])

  const displayPreprocessOpts = useMemo(
    () => preprocessOpts
      ? {
          ...preprocessOpts,
          ...(presetContext ? { presetContext, swipeIndex: presetSwipeIndex } : {}),
          depth,
          ...(messageIndex >= 0 ? { messageIndex } : {}),
          ...(dynamicMacros ? { dynamicMacros } : {}),
        }
      : undefined,
    [preprocessOpts, presetContext, presetSwipeIndex, depth, messageIndex, dynamicMacros],
  )
  const displayOwned = !!scopedChatId && isDisplayChatOwned(scopedChatId)
  const displayScripts = useMemo(
    () =>
      regexScripts.filter(
        (s) =>
          s.target.includes('display') &&
          !s.disabled &&
          s.placement.includes(isUser ? 'user_input' : 'ai_output') &&
          (s.min_depth === null || depth >= s.min_depth) &&
          (s.max_depth === null || depth <= s.max_depth) &&
          (s.scope === 'global' ||
            (s.scope === 'character' && s.scope_id === activeCharacterId) ||
            (s.scope === 'chat' && s.scope_id === scopedChatId)),
      ),
    [regexScripts, isUser, depth, activeCharacterId, scopedChatId],
  )
  const {
    value: content,
    processingState,
    ready: preprocessReady,
    settled: preprocessSettled,
  } = useDisplayPreprocessedState(
    rawContent,
    scopedChatId,
    displayPreprocessOpts,
    isStreaming,
    (isStreaming || !!presetContext) && !displayOwned,
  )
  // Every saved message runs the body stage once before regex, including unowned chats.
  const regexGated = (!!preprocessOpts?.messageId && !preprocessReady) || !presetScripts.ready
  const needsPreviousContent = useMemo(
    () => displayScripts.some(
      (script) =>
        Array.isArray(script.metadata?.match_actions)
        && script.metadata.match_actions.includes('repeat_back'),
    ),
    [displayScripts],
  )
  const previousContent = useStore((s) => {
    if (!needsPreviousContent || !preprocessOpts?.messageId) return undefined
    return getPreviousSameRoleContent(s.messages, preprocessOpts.messageId)
  })

  // Collect display scripts that need backend macro resolution
  const scriptsNeedingResolution = useMemo(
    () =>
      displayScripts.filter(
        (s) =>
          s.substitute_macros !== 'none'
          && (
            hasMacroSyntax(s.find_regex)
            || (
              s.substitute_macros !== 'find'
              && hasMacroSyntax(s.replace_string)
            )
          ),
      ),
    [displayScripts],
  )

  // Pre-resolve find patterns and non-raw replacement strings via the backend macro engine.
  // Raw replacements stay per-match so capture groups remain available before macro evaluation.
  const templateCacheKey = useMemo(() => {
    const templates: Record<string, string> = {}
    for (const s of scriptsNeedingResolution) {
      if (!(s.preset_id && s.metadata?.prompt_activation) && hasMacroSyntax(s.find_regex)) {
        templates[`find:${s.id}`] = s.find_regex
      }
      if (
        s.substitute_macros !== 'none'
        && s.substitute_macros !== 'find'
        && s.substitute_macros !== 'raw'
        && s.substitute_macros !== 'after'
        && hasMacroSyntax(s.replace_string)
      ) {
        templates[`replace:${s.id}`] = s.replace_string
      }
    }

    const templateEntries = Object.entries(templates)
    if (templateEntries.length === 0) return null

    return JSON.stringify({
      scopedChatId,
      macroCharacterId,
      activePersonaId,
      ...(presetContext ? { presetContextKey, presetSwipeIndex, messageId: preprocessOpts?.messageId } : {}),
      scripts: getRegexScriptCacheKey(scriptsNeedingResolution),
    })
  }, [scriptsNeedingResolution, scopedChatId, macroCharacterId, activePersonaId, presetContext, presetContextKey, presetSwipeIndex, preprocessOpts?.messageId])

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
      if (!(s.preset_id && s.metadata?.prompt_activation) && hasMacroSyntax(s.find_regex)) {
        templates[`find:${s.id}`] = s.find_regex
      }
      if (
        s.substitute_macros !== 'none'
        && s.substitute_macros !== 'find'
        && s.substitute_macros !== 'raw'
        && s.substitute_macros !== 'after'
        && hasMacroSyntax(s.replace_string)
      ) {
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

    let pendingTemplates = cached?.promise
    if (!pendingTemplates) {
      let assignedPromise: Promise<ResolvedDisplayRegexTemplates>
      const promise = resolveTemplatesWithResolver(templates, {
        chatId: scopedChatId ?? undefined,
        characterId: macroCharacterId ?? undefined,
        personaId: activePersonaId ?? undefined,
        ...(presetContext ? { messageId: preprocessOpts?.messageId, swipeIndex: presetSwipeIndex, presetContext, presetRegexIds } : {}),
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
          let agg: Set<string> | null = res.touched_vars ? new Set<string>() : null
          if (agg && res.touched_vars) {
            for (const arr of Object.values(res.touched_vars)) for (const v of arr) agg.add(v)
          }
          if (res.cacheable && Object.values(res.cacheable).some((c) => c === false)) agg = null
          if (displayRegexResolutionCache.get(templateCacheKey)?.promise === assignedPromise) {
            cacheResolvedTemplates(templateCacheKey, agg ? { value: next, touchedVars: agg } : { value: next })
          }
          return next
        })
        .catch(() => {
          if (displayRegexResolutionCache.get(templateCacheKey)?.promise === assignedPromise) {
            displayRegexResolutionCache.delete(templateCacheKey)
          }
          return createEmptyResolvedTemplates()
        })
      assignedPromise = trackInitialDisplayResolve(promise, scopedChatId)
      pendingTemplates = assignedPromise
      cacheResolvedTemplates(templateCacheKey, {
        promise: assignedPromise,
        pendingCharacters: templateEntries.reduce((sum, [key, value]) => sum + key.length + value.length, 0),
      })
    }

    // Delivery must not depend on admission to the optional reuse cache.
    pendingTemplates.then(applyResolvedTemplates)

    return () => { cancelled = true }
  }, [scriptsNeedingResolution, templateCacheKey, scopedChatId, macroCharacterId, activePersonaId, cvSnapshot,
    preprocessOpts?.messageId, presetContext, presetRegexIds, presetSwipeIndex])

  const skipEmptyFinalization = displayScripts.length === 0
    && getDisplayResolverForChat(scopedChatId ?? '')?.finalizeWithoutScripts !== true
  const passthrough = !displayOwned && displayScripts.every(
    (script) => canSkipDisplayRegex(content, script, resolvedTemplates.resolvedFindPatterns),
  )
  const normalizedContent = useMemo(
    () => displayOwned || passthrough ? undefined : applyLiteralDisplayNormalization(content, displayScripts),
    [displayOwned, passthrough, content, displayScripts],
  )
  const resolvedTemplateKey = useMemo(
    () => JSON.stringify({
      find: Array.from(resolvedTemplates.resolvedFindPatterns.entries()),
      replace: Array.from(resolvedTemplates.resolvedReplacements.entries()),
    }),
    [resolvedTemplates],
  )

  // Definition/context serialization is independent of streamed content.
  const contextKey = useMemo(() => JSON.stringify({
    scopedChatId, messageId: preprocessOpts?.messageId, role: preprocessOpts?.role,
    macroCharacterId, activePersonaId, isUser, depth, macroCtx, messageIndex,
    resolvedTemplateKey, dynamicMacros, previousContent, displayOwned,
    ...(presetContext ? { presetContextKey, presetSwipeIndex } : {}),
    scripts: getRegexScriptCacheKey(displayScripts),
  }), [scopedChatId, preprocessOpts?.messageId, preprocessOpts?.role, macroCharacterId,
    activePersonaId, isUser, depth, macroCtx, messageIndex, resolvedTemplateKey,
    dynamicMacros, previousContent, displayOwned, displayScripts, presetContext, presetContextKey, presetSwipeIndex])
  const version = useMemo(() => ({ contextKey, cvSnapshot, processingState }), [contextKey, cvSnapshot, processingState])
  const contentCacheKey = skipEmptyFinalization || passthrough || regexGated || normalizedContent !== undefined
    ? null : JSON.stringify([contextKey, content])
  const schedule = useDisplayTask(version, content, isStreaming)
  const cachedResolvedContent = contentCacheKey ? getDisplayContentCacheEntry(contentCacheKey, processingState)?.value : undefined

  useEffect(() => {
    if (!contentCacheKey) return
    return schedule(() => {
      const cached = getDisplayContentCacheEntry(contentCacheKey, processingState)
      if (cached?.value !== undefined) return Promise.resolve(cached.value)
      if (cached?.promise) return cached.promise
      let assigned: Promise<string>
      const promise = applyDisplayRegexTiered(content, displayScripts, {
        processingState, isUser, depth, macroCtx,
        chatId: scopedChatId ?? undefined,
        characterId: macroCharacterId ?? undefined,
        personaId: activePersonaId ?? undefined,
        resolvedFindPatterns: resolvedTemplates.resolvedFindPatterns,
        resolvedReplacements: resolvedTemplates.resolvedReplacements,
        dynamicMacros,
        ...(presetContext ? { presetContext, presetRegexIds, swipeIndex: presetSwipeIndex } : {}),
        ...(preprocessOpts?.messageId ? { messageId: preprocessOpts.messageId } : {}),
        ...(messageIndex >= 0 ? { messageIndex } : {}),
        ...(previousContent !== undefined ? { previousContent } : {}),
        ...(preprocessOpts?.role ? { role: preprocessOpts.role } : {}),
      }).then(({ result, touchedVars, cacheable }) => {
        if (displayRegexContentCache.get(contentCacheKey)?.promise === assigned) {
          if (cacheable !== false) {
            displayRegexContentCache.set(contentCacheKey, {
              value: result, processingState, touchedVars, messageId: preprocessOpts?.messageId,
            })
          } else displayRegexContentCache.delete(contentCacheKey)
        }
        return result
      }).catch(() => {
        if (displayRegexContentCache.get(contentCacheKey)?.promise === assigned) {
          displayRegexContentCache.delete(contentCacheKey)
        }
        return content
      })
      assigned = trackContentForDisplaySettle(promise)
      displayRegexContentCache.set(contentCacheKey, {
        promise: assigned, processingState, messageId: preprocessOpts?.messageId,
        pendingCharacters: content.length,
      })
      return assigned
    }, (value) => setResolvedContentState({ key: contentCacheKey, version, content, value }))
  }, [contentCacheKey, version, content, processingState, displayScripts, isUser, depth, macroCtx,
    scopedChatId, macroCharacterId, activePersonaId, resolvedTemplates, dynamicMacros,
    preprocessOpts?.messageId, preprocessOpts?.role, messageIndex, previousContent,
    schedule, trackContentForDisplaySettle, presetContext, presetRegexIds, presetSwipeIndex])

  const messageId = preprocessOpts?.messageId ?? null
  const carry = useRef<ResolvedContentState | null>(null)
  const settledDisplay = useRef<{ rawContent: string; value: string } | null>(null)
  const presetIdentity = presetContext ? `${presetContextKey}|${presetSwipeIndex ?? ''}` : ''
  const previousPresetIdentity = useRef(presetIdentity)
  if (previousPresetIdentity.current !== presetIdentity) {
    previousPresetIdentity.current = presetIdentity; carry.current = null; settledDisplay.current = null
  }
  const seenState = useRef(resolvedContentState)
  const lifecycle = useRef({ chatId: scopedChatId, messageId, isStreaming, finishing: false })
  if (
    lifecycle.current.chatId !== scopedChatId || lifecycle.current.messageId !== messageId
    || (!lifecycle.current.isStreaming && isStreaming)
  ) {
    carry.current = null
    settledDisplay.current = null
    lifecycle.current.finishing = false
  } else if (lifecycle.current.isStreaming && !isStreaming) {
    lifecycle.current.finishing = true
  }
  Object.assign(lifecycle.current, { chatId: scopedChatId, messageId, isStreaming })

  // The scheduler accepts completed append-only revisions. Display those
  // immediately instead of demanding a cache hit for the newest token.
  if (resolvedContentState !== seenState.current) {
    seenState.current = resolvedContentState
    if (resolvedContentState?.version === version) carry.current = resolvedContentState
  }
  const live = normalizedContent ?? (passthrough || (skipEmptyFinalization && preprocessSettled) ? content : cachedResolvedContent)
    ?? (resolvedContentState?.key === contentCacheKey && resolvedContentState.version === version
      ? resolvedContentState.value : undefined)
  const pending = !presetScripts.ready || !preprocessSettled || (
    templateCacheKey !== null && !cachedTemplates && resolvedTemplatesState?.key !== templateCacheKey
  )
  const resolutionPending = pending || (contentCacheKey !== null && live === undefined)
  // Appending messages changes the depth of every mounted row and restarts
  // preprocessing. Its provisional raw output can differ from both the prior
  // preprocessed text and the final HTML, so the streaming carry cannot cover
  // this gap. Retain a completed display of the same source through ALL stages
  // of the refresh; cold mounts still reserve their height and stay hidden.
  if (!isStreaming && resolutionPending && settledDisplay.current && (settledDisplay.current.rawContent === rawContent
    || (!!presetContext && rawContent.startsWith(settledDisplay.current.rawContent)))) {
    return { content: settledDisplay.current.value, pending: false, scripts: regexScripts }
  }
  if (live !== undefined) {
    if (!presetContext || !resolutionPending) carry.current = { key: contentCacheKey ?? '', version, content, value: live }
    if (!resolutionPending) settledDisplay.current = { rawContent, value: live }
    // Finalization may still need a second pass after preprocessing settles.
    if (!isStreaming && preprocessSettled) lifecycle.current.finishing = false
    return { content: live, pending, scripts: regexScripts }
  }
  if (carry.current && (
    isStreaming || lifecycle.current.finishing
    || carry.current.content === content || RAW_MACRO_RE.test(content)
  )) return { content: carry.current.value, pending: false, scripts: regexScripts }
  if (!resolutionPending) settledDisplay.current = { rawContent, value: content }
  return { content, pending: pending || contentCacheKey !== null, scripts: regexScripts }
}

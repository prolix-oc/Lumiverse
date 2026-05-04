import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { applyDisplayRegex, applyDisplayRegexAsync } from '@/lib/regex/compiler'
import { resolveMacrosBatch } from '@/api/macros'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'

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

const displayRegexResolutionCache = new Map<string, DisplayRegexCacheEntry>()
const displayRegexContentCache = new Map<string, DisplayRegexContentCacheEntry>()
const displayPreprocessCache = new Map<string, { value?: string; promise?: Promise<string> }>()
const DISPLAY_PREPROCESS_CACHE_MAX = 500
const displayRegexCacheListeners = new Set<() => void>()
let displayRegexCacheVersion = 0

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

async function fetchDisplayPreprocess(
  chatId: string,
  body: { messageId: string; role: string; rawContent: string },
): Promise<string> {
  try {
    const res = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}/display-preprocess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'include',
    })
    if (!res.ok) return body.rawContent
    const json = (await res.json()) as { content?: unknown }
    return typeof json.content === 'string' ? json.content : body.rawContent
  } catch {
    return body.rawContent
  }
}

export function useDisplayPreprocessed(
  content: string,
  chatId: string | null,
  opts: DisplayPreprocessOpts | undefined,
): string {
  const cacheVersion = useSyncExternalStore(
    subscribeDisplayRegexCache,
    getDisplayRegexCacheVersion,
    getDisplayRegexCacheVersion,
  )

  const key = useMemo(() => {
    if (!opts?.messageId || !chatId) return null
    return `${cacheVersion}|${chatId}|${opts.messageId}|${opts.role}|${content.length}|${fnv1a(content)}`
  }, [content, opts?.messageId, opts?.role, chatId, cacheVersion])

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
      const promise = fetchDisplayPreprocess(chatId, {
        messageId: opts.messageId,
        role: opts.role,
        rawContent: content,
      })
        .then((next) => {
          displayPreprocessCache.set(key, { value: next })
          if (displayPreprocessCache.size > DISPLAY_PREPROCESS_CACHE_MAX) {
            const drop = displayPreprocessCache.size - DISPLAY_PREPROCESS_CACHE_MAX
            let i = 0
            for (const k of displayPreprocessCache.keys()) {
              if (i++ >= drop) break
              displayPreprocessCache.delete(k)
            }
          }
          return next
        })
        .catch(() => {
          displayPreprocessCache.delete(key)
          return content
        })
      displayPreprocessCache.set(key, { promise })
    }
    displayPreprocessCache.get(key)?.promise?.then(apply)
    return () => { cancelled = true }
  }, [key, opts?.messageId, opts?.role, chatId, content])

  if (!key) return content
  if (cached !== undefined) return cached
  if (state?.key === key) return state.value
  if (lastRef.current?.raw === content) return lastRef.current.value
  return content
}

const RAW_MACRO_RE = /\{\{(?!\s*(?:user|char|bot|notChar|not_char|charName)\s*\}\})/

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

function getDisplayRegexCacheVersion(): number {
  return displayRegexCacheVersion
}

export function invalidateDisplayRegexCache(): void {
  displayRegexCacheVersion += 1
  displayRegexResolutionCache.clear()
  displayRegexContentCache.clear()
  displayPreprocessCache.clear()
  for (const listener of displayRegexCacheListeners) listener()
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
  const cacheVersion = useSyncExternalStore(
    subscribeDisplayRegexCache,
    getDisplayRegexCacheVersion,
    getDisplayRegexCacheVersion,
  )

  const dynamicMacros = useMemo(() => {
    if (messageIndex < 0) return undefined
    return { chat_index: String(messageIndex) }
  }, [messageIndex])

  const content = useDisplayPreprocessed(rawContent, activeChatId, preprocessOpts)

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
      if (s.substitute_macros !== 'raw' && hasMacroSyntax(s.replace_string)) {
        templates[`replace:${s.id}`] = s.replace_string
      }
    }

    const templateEntries = Object.entries(templates)
    if (templateEntries.length === 0) return null

    return JSON.stringify({
      cacheVersion,
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
  }, [scriptsNeedingResolution, activeChatId, activeCharacterId, activePersonaId, cacheVersion])

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
      if (s.substitute_macros !== 'raw' && hasMacroSyntax(s.replace_string)) {
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
          displayRegexResolutionCache.set(templateCacheKey, { value: next })
          return next
        })
        .catch(() => {
          displayRegexResolutionCache.delete(templateCacheKey)
          return createEmptyResolvedTemplates()
        })

      displayRegexResolutionCache.set(templateCacheKey, { promise })
    }

    displayRegexResolutionCache.get(templateCacheKey)?.promise?.then(applyResolvedTemplates)

    return () => { cancelled = true }
  }, [scriptsNeedingResolution, templateCacheKey, activeChatId, activeCharacterId, activePersonaId])

  const fallbackContent = useMemo(
    () => {
      if (displayScripts.length === 0) return content
      return applyDisplayRegex(content, displayScripts, {
        isUser,
        depth,
        macroCtx,
        resolvedFindPatterns: resolvedTemplates.resolvedFindPatterns,
        resolvedReplacements: resolvedTemplates.resolvedReplacements,
        dynamicMacros,
      })
    },
    [content, displayScripts, isUser, depth, macroCtx, resolvedTemplates, dynamicMacros],
  )

  const hasRawMacroScripts = useMemo(
    () => displayScripts.some((s) => s.substitute_macros === 'raw'),
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
    if (displayScripts.length === 0 || !hasRawMacroScripts) return null

    return JSON.stringify({
      cacheVersion,
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
    hasRawMacroScripts,
    cacheVersion,
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
        .then((next) => {
          displayRegexContentCache.set(contentCacheKey, { value: next })
          return next
        })
        .catch(() => {
          displayRegexContentCache.delete(contentCacheKey)
          return fallbackContent
        })

      displayRegexContentCache.set(contentCacheKey, { promise })
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
    hasRawMacroScripts,
    resolvedTemplateKey,
    resolvedTemplates,
    activeChatId,
    activeCharacterId,
    activePersonaId,
    contentCacheKey,
    dynamicMacros,
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

  return liveResolved ?? staleResolved ?? fallbackContent
}

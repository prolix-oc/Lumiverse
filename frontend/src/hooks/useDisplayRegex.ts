import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { applyDisplayRegex, applyDisplayRegexAsync } from '@/lib/regex/compiler'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'

interface DisplayRegexContentCacheEntry {
  value?: string
  promise?: Promise<string>
}

interface ResolvedContentState {
  key: string
  value: string
}

const displayRegexContentCache = new Map<string, DisplayRegexContentCacheEntry>()
const displayRegexCacheListeners = new Set<() => void>()
let displayRegexCacheVersion = 0

const RAW_MACRO_RE = /\{\{(?!\s*(?:user|char|bot|notChar|not_char|charName)\s*\}\})/

function hasMacroSyntax(s: string): boolean {
  return s.includes('{{') || s.includes('<USER>') || s.includes('<BOT>') || s.includes('<CHAR>')
}

function subscribeDisplayRegexCache(listener: () => void): () => void {
  displayRegexCacheListeners.add(listener)
  return () => displayRegexCacheListeners.delete(listener)
}

function getDisplayRegexCacheVersion(): number {
  return displayRegexCacheVersion
}

export function invalidateDisplayRegexCache(): void {
  displayRegexCacheVersion += 1
  displayRegexContentCache.clear()
  for (const listener of displayRegexCacheListeners) listener()
}

export function useDisplayRegex(content: string, isUser: boolean, depth: number, macroCtx?: DisplayMacroContext): string {
  const regexScripts = useStore((s) => s.regexScripts)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const cacheVersion = useSyncExternalStore(
    subscribeDisplayRegexCache,
    getDisplayRegexCacheVersion,
    getDisplayRegexCacheVersion,
  )

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

  const needsBackend = useMemo(
    () =>
      displayScripts.some(
        (s) => s.substitute_macros !== 'none' && (hasMacroSyntax(s.find_regex) || hasMacroSyntax(s.replace_string)),
      ),
    [displayScripts],
  )

  const fallbackContent = useMemo(
    () => {
      if (displayScripts.length === 0) return content
      return applyDisplayRegex(content, displayScripts, { isUser, depth, macroCtx })
    },
    [content, displayScripts, isUser, depth, macroCtx],
  )

  const contentCacheKey = useMemo(() => {
    if (displayScripts.length === 0 || !needsBackend) return null
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
    needsBackend,
    cacheVersion,
    activeChatId,
    activeCharacterId,
    activePersonaId,
    isUser,
    depth,
    macroCtx,
    content,
  ])

  const [resolvedContentState, setResolvedContentState] = useState<ResolvedContentState | null>(null)
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
      const promise = applyDisplayRegexAsync(content, displayScripts, {
        isUser,
        depth,
        chatId: activeChatId ?? undefined,
        characterId: activeCharacterId ?? undefined,
        personaId: activePersonaId ?? undefined,
        macroCtx,
      })
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
    activeChatId,
    activeCharacterId,
    activePersonaId,
    contentCacheKey,
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

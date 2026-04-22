import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { applyDisplayRegex } from '@/lib/regex/compiler'
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

const displayRegexResolutionCache = new Map<string, DisplayRegexCacheEntry>()
const displayRegexCacheListeners = new Set<() => void>()
let displayRegexCacheVersion = 0

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
  for (const listener of displayRegexCacheListeners) listener()
}

export function useDisplayRegex(): (content: string, isUser: boolean, depth: number, macroCtx?: DisplayMacroContext) => string {
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
  const [resolvedTemplates, setResolvedTemplates] = useState<ResolvedDisplayRegexTemplates>(createEmptyResolvedTemplates)

  useEffect(() => {
    if (scriptsNeedingResolution.length === 0) {
      setResolvedTemplates((current) =>
        current.resolvedFindPatterns.size === 0 && current.resolvedReplacements.size === 0
          ? current
          : createEmptyResolvedTemplates(),
      )
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
      setResolvedTemplates((current) =>
        current.resolvedFindPatterns.size === 0 && current.resolvedReplacements.size === 0
          ? current
          : createEmptyResolvedTemplates(),
      )
      return
    }

    const cacheKey = JSON.stringify({
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

    let cancelled = false

    const applyResolvedTemplates = (next: ResolvedDisplayRegexTemplates) => {
      if (!cancelled) setResolvedTemplates(next)
    }

    const cached = displayRegexResolutionCache.get(cacheKey)
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
          displayRegexResolutionCache.set(cacheKey, { value: next })
          return next
        })
        .catch(() => {
          displayRegexResolutionCache.delete(cacheKey)
          return createEmptyResolvedTemplates()
        })

      displayRegexResolutionCache.set(cacheKey, { promise })
    }

    displayRegexResolutionCache.get(cacheKey)?.promise?.then(applyResolvedTemplates)

    return () => { cancelled = true }
  }, [scriptsNeedingResolution, activeChatId, activeCharacterId, activePersonaId, cacheVersion])

  return useCallback(
    (content: string, isUser: boolean, depth: number, macroCtx?: DisplayMacroContext) => {
      if (displayScripts.length === 0) return content
      return applyDisplayRegex(content, displayScripts, {
        isUser,
        depth,
        macroCtx,
        resolvedFindPatterns: resolvedTemplates.resolvedFindPatterns,
        resolvedReplacements: resolvedTemplates.resolvedReplacements,
      })
    },
    [displayScripts, resolvedTemplates],
  )
}

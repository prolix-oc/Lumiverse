import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/store'
import { applyDisplayRegex } from '@/lib/regex/compiler'
import { resolveMacrosBatch } from '@/api/macros'
import type { DisplayMacroContext } from '@/lib/resolveDisplayMacros'

/** Quick check for macro syntax in a string. */
function hasMacroSyntax(s: string): boolean {
  return s.includes('{{') || s.includes('<USER>') || s.includes('<BOT>') || s.includes('<CHAR>')
}

export function useDisplayRegex(): (content: string, isUser: boolean, depth: number, macroCtx?: DisplayMacroContext) => string {
  const regexScripts = useStore((s) => s.regexScripts)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activePersonaId = useStore((s) => s.activePersonaId)

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
        (s) => s.substitute_macros !== 'none' && hasMacroSyntax(s.replace_string),
      ),
    [displayScripts],
  )

  // Pre-resolve replacement strings via the backend macro engine
  const [resolvedReplacements, setResolvedReplacements] = useState<Map<string, string>>(new Map())
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (scriptsNeedingResolution.length === 0) {
      if (resolvedReplacements.size > 0) setResolvedReplacements(new Map())
      return
    }

    // Abort any in-flight request
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    const templates: Record<string, string> = {}
    for (const s of scriptsNeedingResolution) {
      templates[s.id] = s.replace_string
    }

    resolveMacrosBatch({
      templates,
      chat_id: activeChatId ?? undefined,
      character_id: activeCharacterId ?? undefined,
      persona_id: activePersonaId ?? undefined,
    })
      .then((res) => {
        if (controller.signal.aborted) return
        setResolvedReplacements(new Map(Object.entries(res.resolved)))
      })
      .catch(() => {
        // Non-fatal: fall back to client-side resolution
      })

    return () => { controller.abort() }
  }, [scriptsNeedingResolution, activeChatId, activeCharacterId, activePersonaId])

  return useCallback(
    (content: string, isUser: boolean, depth: number, macroCtx?: DisplayMacroContext) => {
      if (displayScripts.length === 0) return content
      return applyDisplayRegex(content, displayScripts, { isUser, depth, macroCtx, resolvedReplacements })
    },
    [displayScripts, resolvedReplacements],
  )
}

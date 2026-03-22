import { useCallback, useMemo } from 'react'
import { useStore } from '@/store'
import { applyDisplayRegex } from '@/lib/regex/compiler'

export function useDisplayRegex(): (content: string, isUser: boolean, depth: number) => string {
  const regexScripts = useStore((s) => s.regexScripts)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)

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

  return useCallback(
    (content: string, isUser: boolean, depth: number) => {
      if (displayScripts.length === 0) return content
      return applyDisplayRegex(content, displayScripts, { isUser, depth })
    },
    [displayScripts],
  )
}

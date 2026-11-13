import type { CreateRegexScriptInput } from '@/types/regex'

export type RegexPanelScopeFilterValue = 'all' | 'global' | 'character' | 'chat' | 'preset'

type RegexCreateScopeError = 'missingCharacter' | 'missingChat'

type ResolveRegexCreateScopeResult =
  | { ok: true; input: Pick<CreateRegexScriptInput, 'scope' | 'scope_id'> }
  | { ok: false; error: RegexCreateScopeError }

export function resolveRegexCreateScope(
  scopeFilter: RegexPanelScopeFilterValue,
  activeCharacterId: string | null,
  activeChatId: string | null,
): ResolveRegexCreateScopeResult {
  if (scopeFilter === 'character') {
    if (!activeCharacterId) return { ok: false, error: 'missingCharacter' }
    return { ok: true, input: { scope: 'character', scope_id: activeCharacterId } }
  }

  if (scopeFilter === 'chat') {
    if (!activeChatId) return { ok: false, error: 'missingChat' }
    return { ok: true, input: { scope: 'chat', scope_id: activeChatId } }
  }

  return { ok: true, input: { scope: 'global', scope_id: null } }
}

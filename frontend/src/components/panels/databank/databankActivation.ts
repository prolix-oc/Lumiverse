import type { Databank } from '@/api/databank'

export type ContextDatabankScope = 'character' | 'chat'

export interface ContextDatabankBinding {
  bank: Databank
  attached: boolean
  automatic: boolean
}

export function isAutomaticallyActiveForContext(
  bank: Databank,
  scope: ContextDatabankScope,
  scopeId: string | null,
): boolean {
  return Boolean(scopeId) && bank.scope === scope && bank.scopeId === scopeId
}

/**
 * Mirrors the context-specific part of the backend databank resolver for the
 * attachment UI. Scoped banks are active automatically; attachment IDs add
 * banks from other scopes to the same context.
 *
 * Disabled banks remain in the result so the panel can explain why a bound
 * bank is not currently retrievable instead of silently hiding it.
 */
export function getContextDatabankBindings(
  banks: Databank[],
  scope: ContextDatabankScope,
  scopeId: string | null,
  attachedIds: string[],
): ContextDatabankBinding[] {
  const attached = new Set(attachedIds)

  return banks.flatMap((bank) => {
    const isAttached = attached.has(bank.id)
    const isAutomatic = isAutomaticallyActiveForContext(bank, scope, scopeId)
    if (!isAttached && !isAutomatic) return []
    return [{ bank, attached: isAttached, automatic: isAutomatic }]
  })
}

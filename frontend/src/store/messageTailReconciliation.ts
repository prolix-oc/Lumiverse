import type { Message, PaginatedResult } from '@/types/api'

export type MessageTailPage = Pick<PaginatedResult<Message>, 'data' | 'total' | 'offset'> & {
  requestSnapshot?: { ids: string[]; total: number }
}

const LOCAL_MESSAGE_PREFIXES = ['__stream_placeholder_', '__regen_placeholder_']

function isPersistedMessage(message: Message): boolean {
  return !LOCAL_MESSAGE_PREFIXES.some((prefix) => message.id.startsWith(prefix))
}

export function preserveNewerMessageRevisions(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((message) => [message.id, message]))
  return incoming.map((message) => {
    const existing = byId.get(message.id)
    // An edit event can arrive after the server read but before its response is applied.
    return typeof existing?.revision === 'number' && typeof message.revision === 'number'
      && existing.revision > message.revision ? existing : message
  })
}

/**
 * Replace the authoritative overlap covered by a fresh tail response without
 * discarding history pages that the user has already loaded above it.
 *
 * Loaded chat state is a contiguous suffix of the persisted conversation.
 * `currentTotal - persisted.length` therefore gives that suffix's prior
 * offset. The response offset tells us exactly how much of the suffix remains
 * strictly before the refreshed tail.
 */
export function reconcileMessageTail(
  current: Message[],
  currentTotal: number,
  fresh: MessageTailPage,
): Message[] {
  const persisted = current.filter(isPersistedMessage)
  if (fresh.requestSnapshot) {
    const initial = fresh.requestSnapshot
    const initialIds = new Set(initial.ids), currentById = new Map(persisted.map(message => [message.id, message]))
    const incoming = fresh.data.filter(message => !initialIds.has(message.id) || currentById.has(message.id))
    const freshIds = new Set(incoming.map(message => message.id))
    const prefixLength = Math.max(0, Math.min(initial.ids.length, fresh.offset - Math.max(0, initial.total - initial.ids.length)))
    return [
      ...initial.ids.slice(0, prefixLength).flatMap(id => currentById.has(id) && !freshIds.has(id) ? [currentById.get(id)!] : []),
      ...preserveNewerMessageRevisions(persisted, incoming),
      ...persisted.filter(message => !initialIds.has(message.id) && !freshIds.has(message.id)),
    ]
  }
  const currentOffset = Math.max(0, currentTotal - persisted.length)
  const prefixLength = Math.max(0, Math.min(persisted.length, fresh.offset - currentOffset))
  const prefix = persisted.slice(0, prefixLength)
  const freshIds = new Set(fresh.data.map((message) => message.id))

  return [
    ...prefix.filter((message) => !freshIds.has(message.id)),
    ...preserveNewerMessageRevisions(persisted, fresh.data),
  ]
}

export function reconciledTailTotal(current: Message[], currentTotal: number, fresh: MessageTailPage): number {
  if (!fresh.requestSnapshot) return fresh.total
  const initialIds = new Set(fresh.requestSnapshot.ids), freshIds = new Set(fresh.data.map(message => message.id))
  const currentIds = new Set(current.map(message => message.id))
  const deleted = fresh.data.filter(message => initialIds.has(message.id) && !currentIds.has(message.id)).length
  const knownCreations = Math.max(0, currentTotal - fresh.requestSnapshot.total + fresh.requestSnapshot.ids.filter(id => !currentIds.has(id)).length)
  const missingCreations = Math.min(knownCreations, Math.max(0, currentTotal - fresh.total + deleted),
    current.filter(message => isPersistedMessage(message) && !initialIds.has(message.id) && !freshIds.has(message.id)).length)
  return fresh.total - deleted + missingCreations
}

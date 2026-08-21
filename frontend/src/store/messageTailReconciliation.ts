import type { Message, PaginatedResult } from '@/types/api'

const LOCAL_MESSAGE_PREFIXES = ['__stream_placeholder_', '__regen_placeholder_']

function isPersistedMessage(message: Message): boolean {
  return !LOCAL_MESSAGE_PREFIXES.some((prefix) => message.id.startsWith(prefix))
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
  fresh: Pick<PaginatedResult<Message>, 'data' | 'total' | 'offset'>,
): Message[] {
  const persisted = current.filter(isPersistedMessage)
  const currentOffset = Math.max(0, currentTotal - persisted.length)
  const prefixLength = Math.max(0, Math.min(persisted.length, fresh.offset - currentOffset))
  const prefix = persisted.slice(0, prefixLength)
  const freshIds = new Set(fresh.data.map((message) => message.id))

  return [
    ...prefix.filter((message) => !freshIds.has(message.id)),
    ...fresh.data,
  ]
}

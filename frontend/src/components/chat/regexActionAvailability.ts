import type { Message } from '@/types/api'

// MessageContent is mounted once per visible chat row. Cache the adjacency
// scan by messages-array identity so a store update stays O(n), not O(n²).
const repliedToMessageIds = new WeakMap<readonly Message[], Set<string>>()

/**
 * A choice belongs to the assistant turn that rendered it. Once the next
 * visible chat message is a user reply, that choice is no longer actionable.
 * Internal Loom injection rows are skipped because MessageList does not render
 * them and they are not conversation turns from the user's perspective.
 */
export function hasImmediateUserReply(
  messages: readonly Message[],
  messageId: string | undefined,
): boolean {
  if (!messageId) return false

  let replied = repliedToMessageIds.get(messages)
  if (!replied) {
    replied = new Set<string>()
    let previousVisible: Message | undefined

    for (const message of messages) {
      if (message.extra?._loom_inject) continue
      if (message.is_user && previousVisible && !previousVisible.is_user) {
        replied.add(previousVisible.id)
      }
      previousVisible = message
    }

    repliedToMessageIds.set(messages, replied)
  }

  return replied.has(messageId)
}

export interface NativeCorpusMessage {
  readonly id: string;
  readonly index_in_chat: number;
  readonly extra?: Readonly<Record<string, unknown>> | null;
}

export interface NativeCorpusChat {
  readonly metadata?: Readonly<Record<string, unknown>> | null;
}

export function isNativeMessageHidden(message: NativeCorpusMessage): boolean {
  return message.extra?.hidden === true || message.extra?.hidden === 1;
}

/**
 * Project the persisted, user-visible context corpus. A valid native context
 * anchor keeps its own row and all later visible rows; missing or hidden anchor
 * rows fail closed to the full visible corpus, matching normal chat assembly.
 */
export function selectNativeVisibleHistory<T extends NativeCorpusMessage>(
  chat: NativeCorpusChat,
  messages: readonly T[],
): T[] {
  const visible = messages.filter((message) => !isNativeMessageHidden(message));
  const anchorId = typeof chat.metadata?.context_history_anchor_message_id === "string"
    ? chat.metadata.context_history_anchor_message_id
    : null;
  if (!anchorId) return visible;
  const anchor = messages.find((message) => message.id === anchorId);
  if (!anchor || isNativeMessageHidden(anchor)) return visible;
  return visible.filter((message) => message.index_in_chat >= anchor.index_in_chat);
}

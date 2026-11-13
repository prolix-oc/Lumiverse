const INTERNAL_SOURCE_MESSAGE_METADATA_KEY = "__sourceMessageMetadata";
const INTERNAL_CHAT_HISTORY_KEY = "__chatHistorySource";
const INTERNAL_SOURCE_MESSAGE_ID_KEY = "__sourceMessageId";
const INTERNAL_SOURCE_MESSAGE_INDEX_KEY = "__sourceIndexInChat";

export type SourceMessageMetadata = Readonly<Record<string, unknown>>;

interface SourceMessageIdentity {
  index: number;
  metadata: SourceMessageMetadata;
}

function normalizeMetadata(value: unknown): SourceMessageMetadata {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function stampSourceMessageMetadata(
  message: object,
  value: unknown,
): void {
  (message as Record<string, unknown>)[INTERNAL_SOURCE_MESSAGE_METADATA_KEY] =
    normalizeMetadata(value);
}

export function getSourceMessageMetadata(
  message: object,
): SourceMessageMetadata | undefined {
  const value = (message as Record<string, unknown>)[
    INTERNAL_SOURCE_MESSAGE_METADATA_KEY
  ];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SourceMessageMetadata)
    : undefined;
}

function getSourceMessageId(message: object): string | undefined {
  const value = message as Record<string, unknown>;
  const internal = value[INTERNAL_SOURCE_MESSAGE_ID_KEY];
  if (typeof internal === "string") return internal;
  return typeof value.sourceMessageId === "string"
    ? value.sourceMessageId
    : undefined;
}

function getSourceMessageIndex(message: object): number | undefined {
  const value = message as Record<string, unknown>;
  const internal = value[INTERNAL_SOURCE_MESSAGE_INDEX_KEY];
  if (typeof internal === "number" && Number.isFinite(internal)) {
    return internal;
  }
  const projected = value.sourceIndexInChat;
  return typeof projected === "number" && Number.isFinite(projected)
    ? projected
    : undefined;
}

export function collectSourceMessageMetadata(
  messages: readonly object[],
): Map<string, SourceMessageIdentity> {
  const result = new Map<string, SourceMessageIdentity>();
  for (const message of messages) {
    const value = message as Record<string, unknown>;
    if (value[INTERNAL_CHAT_HISTORY_KEY] !== true) continue;
    const id = getSourceMessageId(message);
    const index = getSourceMessageIndex(message);
    if (id === undefined || index === undefined) continue;
    result.set(id, {
      index,
      metadata: getSourceMessageMetadata(message) ?? {},
    });
  }
  return result;
}

export function restoreSourceMessageMetadata(
  messages: readonly object[],
  metadataById: ReadonlyMap<string, SourceMessageIdentity>,
): void {
  for (const message of messages) {
    const value = message as Record<string, unknown>;
    const isChatHistory =
      value[INTERNAL_CHAT_HISTORY_KEY] === true ||
      value.__isChatHistory === true;
    const id =
      typeof value.sourceMessageId === "string"
        ? value.sourceMessageId
        : getSourceMessageId(message);
    delete value[INTERNAL_SOURCE_MESSAGE_METADATA_KEY];
    delete value[INTERNAL_CHAT_HISTORY_KEY];
    delete value[INTERNAL_SOURCE_MESSAGE_ID_KEY];
    delete value[INTERNAL_SOURCE_MESSAGE_INDEX_KEY];
    delete value.__isChatHistory;
    delete value.sourceMessageId;
    delete value.sourceIndexInChat;
    delete value.sourceMessageMetadata;
    const identity =
      isChatHistory && id !== undefined ? metadataById.get(id) : undefined;
    if (!identity) continue;
    value[INTERNAL_CHAT_HISTORY_KEY] = true;
    value[INTERNAL_SOURCE_MESSAGE_ID_KEY] = id;
    value[INTERNAL_SOURCE_MESSAGE_INDEX_KEY] = identity.index;
    stampSourceMessageMetadata(message, identity.metadata);
  }
}

export function projectSourceMessageMetadata<T extends object>(
  message: T,
  isChatHistory: boolean,
  allowed: boolean,
): T & { sourceMessageMetadata?: SourceMessageMetadata } {
  const metadata = getSourceMessageMetadata(message);
  const projected = {
    ...message,
  } as T & Record<string, unknown> & {
    sourceMessageMetadata?: SourceMessageMetadata;
  };
  delete projected[INTERNAL_SOURCE_MESSAGE_METADATA_KEY];
  delete projected[INTERNAL_CHAT_HISTORY_KEY];
  delete projected[INTERNAL_SOURCE_MESSAGE_ID_KEY];
  delete projected[INTERNAL_SOURCE_MESSAGE_INDEX_KEY];
  delete projected.__isChatHistory;
  delete projected.sourceMessageId;
  delete projected.sourceIndexInChat;
  delete projected.sourceMessageMetadata;
  if (isChatHistory && allowed) {
    projected.sourceMessageMetadata = metadata ?? {};
  }
  return projected;
}

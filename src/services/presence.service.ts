import { getDb } from "../db/connection";
import { resolveChatGenerationConnection } from "./generation/connection-resolution";
import * as settingsSvc from "./settings.service";
import * as tokenizerSvc from "./tokenizer.service";

/** What the desktop shell needs to render a Discord Rich Presence activity. */
export interface PresenceChatSnapshot {
  chatId: string;
  characterName: string | null;
  messageCount: number;
  totalTokens: number | null;
  model: string | null;
}

export interface PresenceLandingSnapshot {
  chatId: null;
  characterName: null;
  messageCount: null;
  totalTokens: null;
  model: null;
  characterCount: number;
}

export type PresenceSnapshot = PresenceChatSnapshot | PresenceLandingSnapshot;

/** An authenticated user without an active chat is choosing one on the landing page. */
export async function getPresenceSnapshot(userId: string): Promise<PresenceSnapshot> {
  const chat = await getPresenceChatSnapshot(userId);
  if (chat) return chat;

  const row = getDb()
    .query("SELECT COUNT(*) AS count FROM characters WHERE user_id = ? AND deleting = 0")
    .get(userId) as { count: number };
  return {
    chatId: null,
    characterName: null,
    messageCount: null,
    totalTokens: null,
    model: null,
    characterCount: row.count,
  };
}

const PRESENCE_SQL = `
  SELECT
    ch.name AS character_name,
    c.metadata AS metadata,
    (
      SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id
    ) AS message_count
  FROM chats c
  LEFT JOIN characters ch ON ch.id = c.character_id
  WHERE c.id = ? AND c.user_id = ?
`;

/**
 * Snapshot of the user's currently active chat for the desktop shell's
 * Discord Rich Presence. Returns null when no chat is active or the
 * `activeChatId` setting dangles (chats can be deleted without clearing it).
 *
 * The model is resolved the same way a generation would resolve it — per-chat
 * pin and override first, then the user's active/default connection — so the
 * presence reflects what the next message will actually generate with. A chat
 * without any resolvable connection simply omits the model rather than
 * failing the whole snapshot.
 *
 * Token totals use that model's configured tokenizer over canonical message
 * content. A missing, approximate, or failed tokenizer yields null so Discord
 * can omit the metric. The tokenizer service memoizes by content and tokenizer
 * revision, so repeated polls reuse counts while edits and model changes
 * naturally get fresh values.
 */
export async function getPresenceChatSnapshot(userId: string): Promise<PresenceChatSnapshot | null> {
  const activeChatId = (await settingsSvc.getSettingAsync(userId, "activeChatId"))?.value;
  if (typeof activeChatId !== "string" || activeChatId.length === 0) return null;

  const row = getDb().query(PRESENCE_SQL).get(activeChatId, userId) as
    | {
        character_name: string | null;
        metadata: string | null;
        message_count: number;
      }
    | undefined;
  if (!row) return null;

  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata);
    } catch {
      metadata = null;
    }
  }

  let model: string | null = null;
  try {
    model = resolveChatGenerationConnection(userId, metadata).model.trim() || null;
  } catch {
    model = null;
  }

  // Stored generation metrics may be estimates or counts from another model.
  // Count the canonical content with the connection this chat will use now.
  const messages = getDb()
    .query("SELECT content FROM messages WHERE chat_id = ?")
    .all(activeChatId) as Array<{ content: string }>;
  const totalTokens = await countPresenceTokens(model, messages);

  return {
    chatId: activeChatId,
    characterName: row.character_name ?? null,
    messageCount: Number(row.message_count) || 0,
    totalTokens,
    model,
  };
}

async function countPresenceTokens(model: string | null, messages: Array<{ content: string }>): Promise<number | null> {
  if (messages.length === 0) return 0;
  if (!model) return null;
  try {
    const tokenizerId = tokenizerSvc.getTokenizerIdForModel(model);
    if (!tokenizerId || tokenizerSvc.getConfig(tokenizerId)?.type === "approximate") return null;

    let total = 0;
    for (let index = 0; index < messages.length; index++) {
      const count = await tokenizerSvc.countWithTokenizer(tokenizerId, messages[index].content);
      if (!Number.isSafeInteger(count) || count < 0) return null;
      total += count;
      if ((index + 1) % tokenizerSvc.COUNT_BATCH_YIELD_EVERY === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    return total;
  } catch {
    // Missing/broken tokenizers omit the metric instead of claiming an estimate
    // is an exact count. The model and message count can still be published.
    return null;
  }
}

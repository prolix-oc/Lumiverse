import { getDb } from "../db/connection";
import * as embeddingsSvc from "./embeddings.service";
import { sanitizeForVectorization } from "../utils/content-sanitizer";

const MAX_STALE_VISIBLE_MESSAGES = 2;
const REFRESH_DEBOUNCE_MS = 100;

interface MemoryMessageRow {
  id: string;
  is_user: number;
  name: string;
  content: string;
  extra: string;
  index_in_chat: number;
}

interface MemoryMessageView {
  id: string;
  is_user: boolean;
  name: string;
  content: string;
  extra: Record<string, any>;
}

interface ChatMemoryCacheRow {
  id: string;
  user_id: string;
  chat_id: string;
  settings_key: string;
  source_message_count: number;
  query_preview: string;
  chunks_json: string;
  formatted: string;
  count: number;
  enabled: number;
  settings_source: "global" | "per_chat";
  chunks_available: number;
  chunks_pending: number;
  retrieval_mode: "vector" | "recency" | "empty" | "disabled";
  created_at: number;
  updated_at: number;
}

export interface CachedChatMemoryResult {
  chunks: Array<{ content: string; score: number; metadata: any }>;
  formatted: string;
  count: number;
  enabled: boolean;
  queryPreview: string;
  settingsSource: "global" | "per_chat";
  chunksAvailable: number;
  chunksPending: number;
}

interface RefreshJob {
  userId: string;
  chatId: string;
  priority: number;
}

const EMPTY_RESULT: CachedChatMemoryResult = {
  chunks: [],
  formatted: "",
  count: 0,
  enabled: false,
  queryPreview: "",
  settingsSource: "global",
  chunksAvailable: 0,
  chunksPending: 0,
};

function rowToMemoryMessage(row: MemoryMessageRow): MemoryMessageView {
  return {
    id: row.id,
    is_user: !!row.is_user,
    name: row.name,
    content: row.content,
    extra: safeJsonObject(row.extra),
  };
}

function safeJsonObject(raw: string | null | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function safeJsonArray<T>(raw: string | null | undefined, fallback: T[] = []): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function truncateToContextSize(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 3;
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function buildQueryText(
  messages: MemoryMessageView[],
  settings: embeddingsSvc.ChatMemorySettings,
): string {
  const visibleMessages = messages.filter(m => !(m.extra?.hidden) && m.content.trim().length > 0);
  const contextSize = Math.max(1, settings.queryContextSize);

  switch (settings.queryStrategy) {
    case "last_user_message": {
      const lastUser = [...visibleMessages].reverse().find(m => m.is_user);
      if (!lastUser) return "";
      return truncateToContextSize(
        `[USER | ${lastUser.name}]: ${sanitizeForVectorization(lastUser.content)}`,
        settings.queryMaxTokens,
      );
    }
    case "weighted_recent": {
      const queryMessages = visibleMessages.slice(-contextSize);
      const parts = queryMessages.map(m =>
        `[${m.is_user ? "USER" : "CHARACTER"} | ${m.name}]: ${sanitizeForVectorization(m.content)}`,
      );
      if (parts.length > 0) parts.push(parts[parts.length - 1]);
      return truncateToContextSize(parts.join("\n").trim(), settings.queryMaxTokens);
    }
    case "recent_messages":
    default: {
      const queryMessages = visibleMessages.slice(-contextSize);
      return truncateToContextSize(
        queryMessages
          .map(m => `[${m.is_user ? "USER" : "CHARACTER"} | ${m.name}]: ${sanitizeForVectorization(m.content)}`)
          .join("\n")
          .trim(),
        settings.queryMaxTokens,
      );
    }
  }
}

function formatMemoryOutput(
  chunks: Array<{ content: string; score: number; metadata: any }>,
  settings: embeddingsSvc.ChatMemorySettings,
): string {
  if (chunks.length === 0) return "";

  const renderedChunks = chunks.map(c => {
    let rendered = settings.chunkTemplate;
    rendered = rendered.replace(/\{\{content\}\}/g, c.content);
    rendered = rendered.replace(/\{\{score\}\}/g, c.score.toFixed(4));
    const meta = c.metadata ?? {};
    rendered = rendered.replace(/\{\{startIndex\}\}/g, String(meta.startIndex ?? "?"));
    rendered = rendered.replace(/\{\{endIndex\}\}/g, String(meta.endIndex ?? "?"));
    return rendered;
  });

  const joined = renderedChunks.join(settings.chunkSeparator);
  return settings.memoryHeaderTemplate.replace(/\{\{memories\}\}/g, joined);
}

function computeSettingsKey(
  settings: embeddingsSvc.ChatMemorySettings,
  perChatOverrides: embeddingsSvc.PerChatMemoryOverrides | null | undefined,
  hybridWeightMode: embeddingsSvc.EmbeddingConfig["hybrid_weight_mode"],
): string {
  const raw = JSON.stringify({
    queryStrategy: settings.queryStrategy,
    queryContextSize: settings.queryContextSize,
    queryMaxTokens: settings.queryMaxTokens,
    retrievalTopK: perChatOverrides?.retrievalTopK ?? settings.retrievalTopK,
    exclusionWindow: perChatOverrides?.exclusionWindow ?? settings.exclusionWindow,
    similarityThreshold: settings.similarityThreshold,
    memoryHeaderTemplate: settings.memoryHeaderTemplate,
    chunkTemplate: settings.chunkTemplate,
    chunkSeparator: settings.chunkSeparator,
    hybridWeightMode,
  });

  // FNV-32 has only 2^32 outputs, so two distinct settings combinations would
  // collide after roughly 65k unique payloads (birthday paradox). On a hit the
  // cache would return the wrong precomputed memories. SHA-256 puts the
  // collision probability beyond any practical concern.
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(raw);
  return hasher.digest("hex");
}

function getVisibleMessageCount(messages: MemoryMessageView[]): number {
  return messages.filter(m => !(m.extra?.hidden) && m.content.trim().length > 0).length;
}

function getRecentFallbackChunks(chatId: string, limit: number): Array<{ content: string; score: number; metadata: any }> {
  const rows = getDb()
    .query(
      `SELECT id, content, message_ids FROM chat_chunks
       WHERE chat_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(chatId, limit) as Array<{ id: string; content: string; message_ids: string | null }>;

  return rows.map((row) => ({
    content: row.content,
    score: 0,
    metadata: {
      chunkId: row.id,
      messageIds: safeJsonArray<string>(row.message_ids, []),
    },
  }));
}

function getChatMemoryContext(userId: string, chatId: string): {
  exists: boolean;
  messages: MemoryMessageView[];
  perChatOverrides: embeddingsSvc.PerChatMemoryOverrides | null;
} {
  const chatRow = getDb()
    .query("SELECT metadata FROM chats WHERE id = ? AND user_id = ?")
    .get(chatId, userId) as { metadata: string } | null;

  if (!chatRow) {
    return { exists: false, messages: [], perChatOverrides: null };
  }

  const metadata = safeJsonObject(chatRow.metadata);
  const rows = getDb()
    .query(
      `SELECT id, is_user, name, content, extra, index_in_chat
       FROM messages
       WHERE chat_id = ?
       ORDER BY index_in_chat ASC`,
    )
    .all(chatId) as MemoryMessageRow[];

  return {
    exists: true,
    messages: rows.map(rowToMemoryMessage),
    perChatOverrides: (metadata.memory_settings as embeddingsSvc.PerChatMemoryOverrides | undefined) ?? null,
  };
}

function readCacheRow(chatId: string, settingsKey: string): ChatMemoryCacheRow | null {
  return getDb()
    .query("SELECT * FROM chat_memory_cache WHERE chat_id = ? AND settings_key = ?")
    .get(chatId, settingsKey) as ChatMemoryCacheRow | null;
}

function toCachedResult(row: ChatMemoryCacheRow): CachedChatMemoryResult {
  return {
    chunks: safeJsonArray(row.chunks_json, []),
    formatted: row.formatted,
    count: row.count,
    enabled: !!row.enabled,
    queryPreview: row.query_preview,
    settingsSource: row.settings_source,
    chunksAvailable: row.chunks_available,
    chunksPending: row.chunks_pending,
  };
}

function upsertCacheRow(
  userId: string,
  chatId: string,
  settingsKey: string,
  sourceMessageCount: number,
  result: CachedChatMemoryResult,
  retrievalMode: ChatMemoryCacheRow["retrieval_mode"],
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query(
      `INSERT INTO chat_memory_cache (
         id, user_id, chat_id, settings_key, source_message_count, query_preview,
         chunks_json, formatted, count, enabled, settings_source, chunks_available,
         chunks_pending, retrieval_mode, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, settings_key) DO UPDATE SET
         user_id = excluded.user_id,
         source_message_count = excluded.source_message_count,
         query_preview = excluded.query_preview,
         chunks_json = excluded.chunks_json,
         formatted = excluded.formatted,
         count = excluded.count,
         enabled = excluded.enabled,
         settings_source = excluded.settings_source,
         chunks_available = excluded.chunks_available,
         chunks_pending = excluded.chunks_pending,
         retrieval_mode = excluded.retrieval_mode,
         updated_at = excluded.updated_at`,
    )
    .run(
      crypto.randomUUID(),
      userId,
      chatId,
      settingsKey,
      sourceMessageCount,
      result.queryPreview,
      JSON.stringify(result.chunks),
      result.formatted,
      result.count,
      result.enabled ? 1 : 0,
      result.settingsSource,
      result.chunksAvailable,
      result.chunksPending,
      retrievalMode,
      now,
      now,
    );
}

async function computeFreshMemoryResult(
  userId: string,
  chatId: string,
  messages: MemoryMessageView[],
  chatMemorySettings: embeddingsSvc.ChatMemorySettings | null,
  perChatOverrides: embeddingsSvc.PerChatMemoryOverrides | null,
): Promise<{
  settingsKey: string;
  sourceMessageCount: number;
  result: CachedChatMemoryResult;
  retrievalMode: ChatMemoryCacheRow["retrieval_mode"];
}> {
  if (perChatOverrides?.enabled === false) {
    return {
      settingsKey: "disabled",
      sourceMessageCount: getVisibleMessageCount(messages),
      result: { ...EMPTY_RESULT, enabled: false, settingsSource: "per_chat" },
      retrievalMode: "disabled",
    };
  }

  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  const settings = embeddingsSvc.resolveEffectiveChatMemorySettings(chatMemorySettings, cfg);
  const settingsSource: "global" | "per_chat" = perChatOverrides ? "per_chat" : "global";
  const sourceMessageCount = getVisibleMessageCount(messages);
  const queryText = buildQueryText(messages, settings);
  const settingsKey = computeSettingsKey(settings, perChatOverrides, cfg.hybrid_weight_mode);

  const chunkStats = getDb()
    .query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN vectorized_at IS NOT NULL THEN 1 ELSE 0 END) as vectorized
       FROM chat_chunks
       WHERE chat_id = ?`,
    )
    .get(chatId) as { total: number; vectorized: number | null } | null;

  const chunksAvailable = chunkStats?.total ?? 0;
  const chunksPending = chunksAvailable - (chunkStats?.vectorized ?? 0);
  const queryPreview = queryText.slice(0, 200);

  if (!cfg.enabled || !cfg.vectorize_chat_messages) {
    return {
      settingsKey,
      sourceMessageCount,
      result: {
        ...EMPTY_RESULT,
        enabled: false,
        queryPreview,
        settingsSource,
        chunksAvailable,
        chunksPending,
      },
      retrievalMode: "disabled",
    };
  }

  if (!queryText || chunksAvailable === 0) {
    return {
      settingsKey,
      sourceMessageCount,
      result: {
        ...EMPTY_RESULT,
        enabled: true,
        queryPreview,
        settingsSource,
        chunksAvailable,
        chunksPending,
      },
      retrievalMode: "empty",
    };
  }

  const effectiveTopK = perChatOverrides?.retrievalTopK ?? settings.retrievalTopK;
  const effectiveExclusionWindow = perChatOverrides?.exclusionWindow ?? settings.exclusionWindow;
  const effectiveThreshold = settings.similarityThreshold;

  if (chunksPending > 0) {
    const chunks = getRecentFallbackChunks(chatId, effectiveTopK);
    return {
      settingsKey,
      sourceMessageCount,
      result: {
        chunks,
        formatted: formatMemoryOutput(chunks, settings),
        count: chunks.length,
        enabled: true,
        queryPreview,
        settingsSource,
        chunksAvailable,
        chunksPending,
      },
      retrievalMode: chunks.length > 0 ? "recency" : "empty",
    };
  }

  try {
    const [queryVector] = await embeddingsSvc.cachedEmbedTexts(userId, [queryText]);
    if (!queryVector || queryVector.length === 0) {
      return {
        settingsKey,
        sourceMessageCount,
        result: {
          ...EMPTY_RESULT,
          enabled: true,
          queryPreview,
          settingsSource,
          chunksAvailable,
          chunksPending,
        },
        retrievalMode: "empty",
      };
    }

    const excludeIds = new Set<string>();
    const visibleMessages = messages.filter(m => !(m.extra?.hidden) && m.content.trim().length > 0);
    const recentMessages = visibleMessages.slice(-effectiveExclusionWindow);
    for (const message of recentMessages) {
      excludeIds.add(message.id);
    }

    const hits = await embeddingsSvc.searchChatChunks(
      userId,
      chatId,
      queryVector,
      excludeIds,
      effectiveTopK,
      queryText,
      cfg.hybrid_weight_mode,
    );

    const filteredHits = effectiveThreshold > 0
      ? hits.filter(h => h.score <= effectiveThreshold)
      : hits;

    const chunks = filteredHits.map(h => ({
      content: h.content,
      score: h.score,
      metadata: h.metadata ?? {},
    }));

    return {
      settingsKey,
      sourceMessageCount,
      result: {
        chunks,
        formatted: formatMemoryOutput(chunks, settings),
        count: chunks.length,
        enabled: true,
        queryPreview,
        settingsSource,
        chunksAvailable,
        chunksPending,
      },
      retrievalMode: chunks.length > 0 ? "vector" : "empty",
    };
  } catch (err) {
    console.warn("[chat-memory-cache] Background refresh failed, storing recency fallback:", err);
    const chunks = getRecentFallbackChunks(chatId, effectiveTopK);
    return {
      settingsKey,
      sourceMessageCount,
      result: {
        chunks,
        formatted: formatMemoryOutput(chunks, settings),
        count: chunks.length,
        enabled: true,
        queryPreview,
        settingsSource,
        chunksAvailable,
        chunksPending,
      },
      retrievalMode: chunks.length > 0 ? "recency" : "empty",
    };
  }
}

class ChatMemoryRefreshQueue {
  private queue: RefreshJob[] = [];
  private processing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  add(job: RefreshJob): void {
    const existing = this.queue.findIndex((entry) =>
      entry.userId === job.userId && entry.chatId === job.chatId,
    );

    if (existing >= 0) {
      this.queue[existing].priority = Math.max(this.queue[existing].priority, job.priority);
    } else {
      this.queue.push(job);
    }

    this.queue.sort((a, b) => b.priority - a.priority);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.process();
    }, REFRESH_DEBOUNCE_MS);
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        await refreshChatMemoryCache(job.userId, job.chatId);
      }
    } finally {
      this.processing = false;
      if (this.queue.length > 0) this.schedule();
    }
  }
}

const refreshQueue = new ChatMemoryRefreshQueue();

export function scheduleChatMemoryRefresh(userId: string, chatId: string, priority = 5): void {
  refreshQueue.add({ userId, chatId, priority });
}

export async function readCachedChatMemory(
  userId: string,
  chatId: string,
  messages: Array<{ id: string; is_user: boolean; name: string; content: string; extra?: Record<string, any> }>,
  chatMemorySettings: embeddingsSvc.ChatMemorySettings | null,
  perChatOverrides: embeddingsSvc.PerChatMemoryOverrides | null,
): Promise<CachedChatMemoryResult> {
  if (perChatOverrides?.enabled === false) {
    return { ...EMPTY_RESULT, enabled: false, settingsSource: "per_chat" };
  }

  const cfg = await embeddingsSvc.getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_chat_messages) {
    return { ...EMPTY_RESULT, enabled: false };
  }

  const messageViews: MemoryMessageView[] = messages.map((message) => ({
    id: message.id,
    is_user: message.is_user,
    name: message.name,
    content: message.content,
    extra: message.extra ?? {},
  }));
  const settings = embeddingsSvc.resolveEffectiveChatMemorySettings(chatMemorySettings, cfg);
  const settingsSource: "global" | "per_chat" = perChatOverrides ? "per_chat" : "global";
  const queryText = buildQueryText(messageViews, settings);
  if (!queryText) {
    return { ...EMPTY_RESULT, enabled: true, settingsSource };
  }

  const settingsKey = computeSettingsKey(settings, perChatOverrides, cfg.hybrid_weight_mode);
  const row = readCacheRow(chatId, settingsKey);
  const visibleMessageCount = getVisibleMessageCount(messageViews);

  if (!row) {
    scheduleChatMemoryRefresh(userId, chatId, 9);
    return {
      ...EMPTY_RESULT,
      enabled: true,
      queryPreview: queryText.slice(0, 200),
      settingsSource,
    };
  }

  const delta = visibleMessageCount - row.source_message_count;
  if (delta > 0) {
    scheduleChatMemoryRefresh(userId, chatId, delta > MAX_STALE_VISIBLE_MESSAGES ? 9 : 6);
  }

  if (delta < 0 || delta > MAX_STALE_VISIBLE_MESSAGES) {
    return {
      ...EMPTY_RESULT,
      enabled: !!row.enabled,
      queryPreview: queryText.slice(0, 200),
      settingsSource: row.settings_source,
      chunksAvailable: row.chunks_available,
      chunksPending: row.chunks_pending,
    };
  }

  return toCachedResult(row);
}

export async function refreshChatMemoryCache(userId: string, chatId: string): Promise<void> {
  const context = getChatMemoryContext(userId, chatId);
  if (!context.exists) {
    invalidateChatMemoryCache(chatId);
    return;
  }

  const chatMemorySettings = embeddingsSvc.loadChatMemorySettings(userId);
  const refreshed = await computeFreshMemoryResult(
    userId,
    chatId,
    context.messages,
    chatMemorySettings,
    context.perChatOverrides,
  );

  upsertCacheRow(
    userId,
    chatId,
    refreshed.settingsKey,
    refreshed.sourceMessageCount,
    refreshed.result,
    refreshed.retrievalMode,
  );
}

export function invalidateChatMemoryCache(chatId: string): void {
  getDb().query("DELETE FROM chat_memory_cache WHERE chat_id = ?").run(chatId);
}

export function clearAllChatMemoryCache(): void {
  getDb().query("DELETE FROM chat_memory_cache").run();
}

import { getDb } from "../db/connection";
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import type {
  WorldBookEntry,
  WorldBookReindexProgress,
  WorldBookReindexResult,
  WorldBookVectorIndexStatus
} from "../types/world-book";
import { embeddingCache, computeCacheKey, type ModelFingerprint } from "./embedding-cache";
import {
  parseServiceAccount,
  getAccessToken,
  vertexHostForLocation,
} from "../llm/providers/google-vertex";
import { getProvider } from "../llm/registry";
import { getFirstUserId } from "../auth/seed";
import { sanitizeForVectorization } from "../utils/content-sanitizer";
import { describeProviderError, readBoundedText } from "../utils/provider-errors";
import { fetchWithPreflightAbort, readJsonWithAbort } from "../llm/stream-utils";
import {
  buildChatChunkEmbeddingSlices,
  collapseVectorHitsBySourceId,
  estimateChatChunkTokens,
  hashChatChunkContent,
  splitChatChunkContent,
  type ChatChunkEmbeddingMetadata,
} from "./chat-chunk-embedding";
import { isChatChunkVectorizationBatchTimeoutError } from "./chat-chunk-vectorization-timeouts";
import { chunkDocument } from "./databank/document-chunker.service";
import { loadWorldBookVectorSettings, type WorldBookVectorSettings } from "./world-book-vector-settings.service";
import {
  desiredWorldBookVectorIndexStatus,
  isWorldBookEntryVectorEligible,
  worldBookVectorDesiredStatusSql,
  worldBookVectorSettingsFingerprint,
  worldBookVectorTrackingFingerprint,
} from "./world-book-vector-state";
import { getActiveVectorStore } from "./vector-store";
import {
  andFilter,
  cosineSimilarity,
  distanceFromSimilarity,
  eq,
  idsIn,
  inSet,
  mmrSelect,
  ownerScope,
  ownersScope,
  reciprocalRankFusion,
  rowId,
  sourceIdsIn,
  sourceIdsNotIn,
} from "./vector-store/addressing";
import type {
  CollectionName,
  LexicalSearchOptions,
  SearchOptions,
  VectorFilter,
  VectorHit,
  VectorRow,
} from "./vector-store/types";
import {
  EMBEDDINGS_TABLE,
  WORLD_BOOK_EMBEDDINGS_TABLE,
  asLanceRows,
  coerceLanceVector,
  ensureFtsIndex,
  ensureScalarIndexes,
  ensureVectorIndex,
  getOrCreateTable,
  getTableIfExists,
  getTableState,
  getVectorStoreHealth,
  getWorldBookTableForRead,
  isLanceReadRaceError,
  optimizeTable,
  raceWithSignal,
  retryAfterSchemaDriftReset,
  runStartupVectorMaintenance,
  safeTableDelete,
  scheduleOptimize,
  sqlValue,
  stopIndexHealthMonitor,
  upsertEmbeddingRows,
  withReadRetry,
  withWriteLock,
  type EmbeddingRow,
  type Table,
} from "./vector-store/providers/lancedb";

// LanceDB infrastructure now lives in the provider module. Re-export the symbols
// that other modules import through the embeddings.service namespace (main.ts,
// routes) so their existing import paths keep working unchanged.
export {
  getVectorStoreHealth,
  optimizeTable,
  runStartupVectorMaintenance,
  stopIndexHealthMonitor,
};

const EMBEDDING_SETTINGS_KEY = "embeddingConfig";
const EMBEDDING_SECRET_KEY = "embedding_api_key";
const WORLD_BOOK_VECTOR_VERSION = 4;
const WORLD_BOOK_VECTOR_VERSION_KEY = "worldBookVectorVersion";
const WORLD_BOOK_ROW_SCAN_FALLBACK_LIMIT = 10_000;
/** Default safety timeout for embedding API requests. Prevents a hanging
 *  upstream server from stalling the entire generation pipeline.
 *  User-configurable via EmbeddingConfig.request_timeout (seconds). */
const DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS = 120_000; // 120 seconds

function embeddingProviderSecretKey(provider: EmbeddingProvider): string {
  return `${EMBEDDING_SECRET_KEY}_${provider}`;
}

async function getEmbeddingSecret(userId: string, provider: EmbeddingProvider): Promise<string | null> {
  const scopedKey = embeddingProviderSecretKey(provider);
  const scoped = await secretsSvc.getSecret(userId, scopedKey);
  if (scoped && scoped.length > 0) return scoped;

  const legacy = await secretsSvc.getSecret(userId, EMBEDDING_SECRET_KEY);
  if (!legacy || legacy.length === 0) return null;

  await secretsSvc.putSecret(userId, scopedKey, legacy);
  secretsSvc.deleteSecret(userId, EMBEDDING_SECRET_KEY);
  return legacy;
}

async function hasEmbeddingSecret(userId: string, provider: EmbeddingProvider): Promise<boolean> {
  const secret = await getEmbeddingSecret(userId, provider);
  return !!secret && secret.length > 0;
}

async function putEmbeddingSecret(userId: string, provider: EmbeddingProvider, value: string): Promise<void> {
  await secretsSvc.putSecret(userId, embeddingProviderSecretKey(provider), value);
  secretsSvc.deleteSecret(userId, EMBEDDING_SECRET_KEY);
}

function deleteEmbeddingSecret(userId: string, provider: EmbeddingProvider): void {
  secretsSvc.deleteSecret(userId, embeddingProviderSecretKey(provider));
  secretsSvc.deleteSecret(userId, EMBEDDING_SECRET_KEY);
}

/** Combine an optional external abort signal with an internal timeout into a
 *  single signal. Used so callers (like an active generation) can cancel an
 *  in-flight embedding request without waiting for its own timeout. */
function linkTimeoutSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const timeoutController = new AbortController();
  const timer = timeoutMs > 0
    ? setTimeout(() => timeoutController.abort(), timeoutMs)
    : null;
  const combined = external
    ? AbortSignal.any([external, timeoutController.signal])
    : timeoutController.signal;
  return {
    signal: combined,
    cleanup: () => { if (timer) clearTimeout(timer); },
  };
}

function resolveAbortError(signal: AbortSignal | undefined, fallbackMessage = "Aborted"): Error {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) return signal.reason;
    if (signal.reason != null) return new Error(String(signal.reason));
  }
  return new DOMException(fallbackMessage, "AbortError");
}

export type EmbeddingProvider =
  | "openai-compatible"
  | "openai"
  | "openrouter"
  | "electronhub"
  | "bananabread"
  | "nanogpt"
  | "google_vertex";

export interface EmbeddingConfig {
  enabled: boolean;
  provider: EmbeddingProvider;
  api_url: string;
  model: string;
  dimensions: number | null;
  send_dimensions: boolean;
  retrieval_top_k: number;
  hybrid_weight_mode: "keyword_first" | "balanced" | "vector_first";
  preferred_context_size: number;
  batch_size: number;
  similarity_threshold: number;
  rerank_cutoff: number;
  vectorize_world_books: boolean;
  vectorize_chat_messages: boolean;
  vectorize_chat_documents: boolean;
  chat_memory_mode: "conservative" | "balanced" | "aggressive";
  /** Timeout in seconds for individual embedding API requests.
   *  0 = no timeout. Default: 60. */
  request_timeout: number;
  /** Google Vertex AI region. Only used when `provider === "google_vertex"`.
   *  The `api_url` field is ignored for Vertex — host is derived from this. */
  vertex_region?: string;
}

export interface EmbeddingConfigWithStatus extends EmbeddingConfig {
  has_api_key: boolean;
  /** True when the returned config belongs to the server owner and the caller
   *  is a non-owner receiving it by inheritance. Non-owners cannot mutate an
   *  inherited config and share the owner's API key / billing. */
  inherited?: boolean;
}

export interface EmbeddingModelsPreviewInput {
  provider?: EmbeddingProvider;
  api_url?: string;
  api_key?: string;
}

export interface WorldBookEmbeddingMetadata {
  comment?: string;
  key?: string[];
  keysecondary?: string[];
  world_book_id?: string;
  search_text?: string;
  vector_version?: number;
  chunk_index?: number;
  chunk_count?: number;
}

export interface WorldBookSearchCandidate {
  entry_id: string;
  distance: number;
  lexical_score: number | null;
  content: string;
  searchTextPreview: string;
  metadata: WorldBookEmbeddingMetadata;
}

// ---------------------------------------------------------------------------
// Chat Memory Settings — fine-grained control over long-term memory
// ---------------------------------------------------------------------------

export interface ChatMemorySettings {
  /** Automatically warm chat chunks when a chat is opened */
  autoWarmup: boolean;

  // --- Chunking ---
  chunkTargetTokens: number;      // Default 800. Range: 200–2000
  chunkMaxTokens: number;         // Default 1600. Range: chunkTargetTokens–4000
  chunkOverlapTokens: number;     // Default 120. Range: 0–500

  // --- Exclusion ---
  exclusionWindow: number;        // Default 20. Range: 5–50. Recent messages skipped during search

  // --- Retrieval ---
  queryContextSize: number;       // Default 6. Range: 1–64. Messages used to build query vector
  retrievalTopK: number;          // Default 4. Range: 1+
  similarityThreshold: number;    // Default 0 (disabled). Range: 0–2

  // --- Query ---
  queryStrategy: "recent_messages" | "last_user_message" | "weighted_recent";
  queryMaxTokens: number;         // Default 8000

  // --- Formatting ---
  memoryHeaderTemplate: string;   // Wraps entire block. Default below
  chunkTemplate: string;          // Per-chunk. Default: "{{content}}". Supports: {{content}}, {{score}}, {{startIndex}}, {{endIndex}}
  chunkSeparator: string;         // Default: "\n---\n"

  // --- Chunk Splitting ---
  splitOnSceneBreaks: boolean;    // Default true. Force split at ---, ***, <scene_break>
  splitOnTimeGapMinutes: number;  // Default 0 (disabled). Force split after N minutes idle
  maxMessagesPerChunk: number;    // Default 0 (unlimited)

  // --- Quick Mode ---
  quickMode: "conservative" | "balanced" | "aggressive" | null; // Default "balanced". null = manual
}

export interface PerChatMemoryOverrides {
  enabled?: boolean;          // false = disable memory for this chat
  retrievalTopK?: number;     // Override retrieval count
  exclusionWindow?: number;   // Override exclusion window
}

const LEGACY_CHAT_MEMORY_HEADER_TEMPLATE = "Relevant context from earlier in this conversation:\n{{memories}}";
const LEGACY_CHAT_MEMORY_CHUNK_TEMPLATE = "{{content}}";

export const DEFAULT_CHAT_MEMORY_HEADER_TEMPLATE = `Long-term continuity notes from earlier in this conversation.
These are retrieval results, not live chat history.
Use them only to preserve continuity.
Do not quote, continue, imitate, or replay their wording, actions, emotional beats, or dialogue.
If an event appears complete, treat it as background consequence rather than repeating it.

{{memories}}`;

export const DEFAULT_CHAT_MEMORY_CHUNK_TEMPLATE = `Earlier retrieved context:
{{content}}

Use only the continuity-relevant facts/state above. Do not reuse its phrasing.`;

export const DEFAULT_CHAT_MEMORY_SETTINGS: ChatMemorySettings = {
  autoWarmup: false,
  chunkTargetTokens: 800,
  chunkMaxTokens: 1600,
  chunkOverlapTokens: 120,
  exclusionWindow: 20,
  queryContextSize: 6,
  retrievalTopK: 4,
  similarityThreshold: 0,
  queryStrategy: "recent_messages",
  queryMaxTokens: 8000,
  memoryHeaderTemplate: DEFAULT_CHAT_MEMORY_HEADER_TEMPLATE,
  chunkTemplate: DEFAULT_CHAT_MEMORY_CHUNK_TEMPLATE,
  chunkSeparator: "\n---\n",
  splitOnSceneBreaks: true,
  splitOnTimeGapMinutes: 0,
  maxMessagesPerChunk: 0,
  quickMode: "balanced",
};

const CHAT_MEMORY_SETTINGS_KEY = "chatMemorySettings";

/**
 * Normalize user-provided ChatMemorySettings, filling in defaults.
 */
export function normalizeChatMemorySettings(input: any): ChatMemorySettings {
  const d = DEFAULT_CHAT_MEMORY_SETTINGS;
  return {
    autoWarmup: input?.autoWarmup !== undefined ? !!input.autoWarmup : d.autoWarmup,
    chunkTargetTokens: clampInt(input?.chunkTargetTokens, 200, 2000, d.chunkTargetTokens),
    chunkMaxTokens: clampInt(input?.chunkMaxTokens, 400, 4000, d.chunkMaxTokens),
    chunkOverlapTokens: clampInt(input?.chunkOverlapTokens, 0, 500, d.chunkOverlapTokens),
    exclusionWindow: clampInt(input?.exclusionWindow, 5, 50, d.exclusionWindow),
    queryContextSize: clampInt(input?.queryContextSize, 1, 64, d.queryContextSize),
    retrievalTopK: clampInt(input?.retrievalTopK, 1, Infinity, d.retrievalTopK),
    similarityThreshold: clampFloat(input?.similarityThreshold, 0, 2, d.similarityThreshold),
    queryStrategy: ["recent_messages", "last_user_message", "weighted_recent"].includes(input?.queryStrategy)
      ? input.queryStrategy : d.queryStrategy,
    queryMaxTokens: clampInt(input?.queryMaxTokens, 1000, 32000, d.queryMaxTokens),
    memoryHeaderTemplate: typeof input?.memoryHeaderTemplate === "string"
      ? (input.memoryHeaderTemplate === LEGACY_CHAT_MEMORY_HEADER_TEMPLATE ? d.memoryHeaderTemplate : input.memoryHeaderTemplate)
      : d.memoryHeaderTemplate,
    chunkTemplate: typeof input?.chunkTemplate === "string"
      ? (input.chunkTemplate === LEGACY_CHAT_MEMORY_CHUNK_TEMPLATE ? d.chunkTemplate : input.chunkTemplate)
      : d.chunkTemplate,
    chunkSeparator: typeof input?.chunkSeparator === "string" ? input.chunkSeparator : d.chunkSeparator,
    splitOnSceneBreaks: input?.splitOnSceneBreaks !== undefined ? !!input.splitOnSceneBreaks : d.splitOnSceneBreaks,
    splitOnTimeGapMinutes: clampInt(input?.splitOnTimeGapMinutes, 0, 1440, d.splitOnTimeGapMinutes),
    maxMessagesPerChunk: clampInt(input?.maxMessagesPerChunk, 0, 100, d.maxMessagesPerChunk),
    quickMode: input?.quickMode === null ? null
      : ["conservative", "balanced", "aggressive"].includes(input?.quickMode) ? input.quickMode
      : d.quickMode,
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function clampFloat(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// ─── LTCM Config Hash ─────────────────────────────────────────
// Detects when chunking settings or compilation logic change so stale
// chunks can be lazily rebuilt per-chat at the next generation.

/**
 * Bump this when the chunk compilation logic changes in a breaking way.
 * Any chat whose stored hash doesn't match the current hash will get
 * its chunks rebuilt on the next generation.
 */
export const LTCM_FORMAT_VERSION = 4;

/**
 * Compute a deterministic hash from the settings that affect how chunks
 * are compiled. Changes to retrieval-only settings (topK, exclusionWindow,
 * templates) do NOT trigger a rebuild — only structural chunking params.
 */
export function computeChatMemoryHash(
  settings: ChatMemorySettings,
  embeddingModel?: string,
): string {
  const input = JSON.stringify({
    v: LTCM_FORMAT_VERSION,
    ct: settings.chunkTargetTokens,
    cm: settings.chunkMaxTokens,
    co: settings.chunkOverlapTokens,
    sb: settings.splitOnSceneBreaks,
    tg: settings.splitOnTimeGapMinutes,
    mm: settings.maxMessagesPerChunk,
    em: embeddingModel || "",
  });
  // FNV-1a 32-bit — fast, deterministic, good enough for config comparison
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Resolve effective chat memory parameters. When quickMode is active,
 * the preset map values override the fine-grained fields (backward compat).
 * Falls back to legacy EmbeddingConfig fields when chatMemorySettings doesn't exist.
 */
export function resolveEffectiveChatMemorySettings(
  chatMemorySettings: ChatMemorySettings | null,
  legacyCfg: EmbeddingConfig,
): ChatMemorySettings {
  // Start from explicit settings or defaults
  let settings = chatMemorySettings ?? { ...DEFAULT_CHAT_MEMORY_SETTINGS };

  // If no explicit settings exist, derive from legacy EmbeddingConfig
  if (!chatMemorySettings) {
    settings = {
      ...DEFAULT_CHAT_MEMORY_SETTINGS,
      retrievalTopK: legacyCfg.retrieval_top_k,
      queryContextSize: legacyCfg.preferred_context_size || DEFAULT_CHAT_MEMORY_SETTINGS.queryContextSize,
      similarityThreshold: legacyCfg.similarity_threshold,
      quickMode: legacyCfg.chat_memory_mode,
    };
  }

  // When quickMode is active, overlay the preset values
  if (settings.quickMode) {
    const presetParams = getChatMemoryParams(settings.quickMode);
    settings = {
      ...settings,
      chunkTargetTokens: presetParams.chunkTargetTokens,
      chunkMaxTokens: presetParams.chunkMaxTokens,
      chunkOverlapTokens: presetParams.chunkOverlapTokens,
      exclusionWindow: presetParams.exclusionWindow,
    };
  }

  return settings;
}

/**
 * Load ChatMemorySettings from the settings table for a user.
 */
export function loadChatMemorySettings(userId: string): ChatMemorySettings | null {
  const setting = settingsSvc.getSetting(userId, CHAT_MEMORY_SETTINGS_KEY);
  if (!setting?.value) return null;
  return normalizeChatMemorySettings(setting.value);
}

/**
 * Save ChatMemorySettings to the settings table for a user.
 */
export function saveChatMemorySettings(userId: string, input: any): ChatMemorySettings {
  const normalized = normalizeChatMemorySettings(input);
  settingsSvc.putSetting(userId, CHAT_MEMORY_SETTINGS_KEY, normalized);
  return normalized;
}

const PROVIDER_DEFAULT_URL: Record<EmbeddingProvider, string> = {
  "openai-compatible": "https://api.openai.com/v1/embeddings",
  openai: "https://api.openai.com/v1/embeddings",
  openrouter: "https://openrouter.ai/api/v1/embeddings",
  electronhub: "https://api.electronhub.top/v1/embeddings",
  bananabread: "http://localhost:8008/v1/embeddings",
  nanogpt: "https://nano-gpt.com/api/v1/embeddings",
  // Vertex derives its host from vertex_region — this is a cosmetic default.
  google_vertex: "https://aiplatform.googleapis.com",
};

function providerDefaultModel(provider: EmbeddingProvider): string {
  if (provider === "bananabread") return "mixedbread-ai/mxbai-embed-large-v1";
  if (provider === "nanogpt") return "text-embedding-3-small";
  if (provider === "openrouter") return "text-embedding-3-small";
  if (provider === "electronhub") return "text-embedding-3-small";
  if (provider === "openai") return "text-embedding-3-small";
  if (provider === "google_vertex") return "gemini-embedding-001";
  return "text-embedding-3-small";
}

function providerAllowsCustomApiUrl(provider: EmbeddingProvider): boolean {
  return provider === "openai-compatible" || provider === "bananabread";
}

function defaultConfig(provider: EmbeddingProvider = "openai-compatible"): EmbeddingConfig {
  return {
    enabled: false,
    provider,
    api_url: PROVIDER_DEFAULT_URL[provider],
    model: providerDefaultModel(provider),
    dimensions: null,
    send_dimensions: false,
    retrieval_top_k: 4,
    hybrid_weight_mode: "balanced",
    preferred_context_size: 6,
    batch_size: 50,
    similarity_threshold: 0,
    rerank_cutoff: 0,
    vectorize_world_books: true,
    vectorize_chat_messages: false,
    vectorize_chat_documents: true,
    chat_memory_mode: "balanced",
    request_timeout: 120,
    vertex_region: provider === "google_vertex" ? "global" : undefined,
  };
}

const VALID_EMBEDDING_PROVIDERS: EmbeddingProvider[] = [
  "openai-compatible", "openai", "openrouter", "electronhub", "bananabread", "nanogpt", "google_vertex",
];

function normalizeConfig(input: any): EmbeddingConfig {
  const rawProvider = input?.provider as EmbeddingProvider | undefined;
  const provider: EmbeddingProvider = rawProvider && VALID_EMBEDDING_PROVIDERS.includes(rawProvider)
    ? rawProvider
    : "openai-compatible";
  const base = defaultConfig(provider);
  const api_url = providerAllowsCustomApiUrl(provider)
    ? (typeof input?.api_url === "string" && input.api_url.trim() ? input.api_url.trim() : base.api_url)
    : base.api_url;
  return {
    enabled: input?.enabled !== undefined ? !!input.enabled : base.enabled,
    provider,
    api_url,
    model: typeof input?.model === "string" && input.model.trim() ? input.model.trim() : base.model,
    dimensions: Number.isFinite(input?.dimensions) && input.dimensions > 0 ? Math.floor(input.dimensions) : null,
    send_dimensions: input?.send_dimensions !== undefined ? !!input.send_dimensions : base.send_dimensions,
    retrieval_top_k:
      Number.isFinite(input?.retrieval_top_k) && input.retrieval_top_k > 0
        ? Math.floor(input.retrieval_top_k)
        : base.retrieval_top_k,
    hybrid_weight_mode:
      input?.hybrid_weight_mode === "keyword_first" ||
      input?.hybrid_weight_mode === "balanced" ||
      input?.hybrid_weight_mode === "vector_first"
        ? input.hybrid_weight_mode
        : base.hybrid_weight_mode,
    preferred_context_size:
      Number.isFinite(input?.preferred_context_size) && input.preferred_context_size > 0
        ? Math.min(64, Math.floor(input.preferred_context_size))
        : base.preferred_context_size,
    batch_size:
      Number.isFinite(input?.batch_size) && input.batch_size > 0
        ? Math.min(200, Math.max(1, Math.floor(input.batch_size)))
        : base.batch_size,
    similarity_threshold:
      Number.isFinite(input?.similarity_threshold) && input.similarity_threshold >= 0
        ? Math.min(2, input.similarity_threshold)
        : base.similarity_threshold,
    rerank_cutoff:
      Number.isFinite(input?.rerank_cutoff) && input.rerank_cutoff >= 0
        ? Math.min(2, input.rerank_cutoff)
        : base.rerank_cutoff,
    vectorize_world_books:
      input?.vectorize_world_books !== undefined ? !!input.vectorize_world_books : base.vectorize_world_books,
    vectorize_chat_messages:
      input?.vectorize_chat_messages !== undefined ? !!input.vectorize_chat_messages : base.vectorize_chat_messages,
    vectorize_chat_documents:
      input?.vectorize_chat_documents !== undefined ? !!input.vectorize_chat_documents : base.vectorize_chat_documents,
    chat_memory_mode:
      input?.chat_memory_mode === "conservative" ||
      input?.chat_memory_mode === "balanced" ||
      input?.chat_memory_mode === "aggressive"
        ? input.chat_memory_mode
        : base.chat_memory_mode,
    request_timeout:
      Number.isFinite(input?.request_timeout) && input.request_timeout >= 0
        ? Math.min(300, input.request_timeout)
        : base.request_timeout,
    vertex_region: provider === "google_vertex"
      ? (typeof input?.vertex_region === "string" && input.vertex_region.trim()
          ? input.vertex_region.trim()
          : base.vertex_region)
      : undefined,
  };
}

/**
 * Resolve the final embedding request URL from user-provided api_url.
 *
 * - Already ends with /embeddings or /embed → use as-is
 * - No path or just "/"                     → append /v1/embeddings
 * - Has a partial path (e.g. /v1)           → append /embeddings
 */
function resolveEmbeddingUrl(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "");
    // Already ends with an embedding endpoint — use as-is
    if (/\/(embeddings|embed)$/.test(path)) {
      return trimmed;
    }
    if (!path || path === "/") {
      // Bare base URL — add full /v1/embeddings
      parsed.pathname = "/v1/embeddings";
    } else {
      // Partial path (e.g. /v1, /api/v1, /proxy) — append /embeddings
      parsed.pathname = path + "/embeddings";
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    // Malformed URL — best-effort append
    return `${trimmed}/v1/embeddings`;
  }
}

export function getChatMemoryParams(mode: "conservative" | "balanced" | "aggressive") {
  switch (mode) {
    case "conservative":
      return {
        exclusionWindow: 30,
        chunkTargetTokens: 600,
        chunkMaxTokens: 1200,
        chunkOverlapTokens: 100,
        syncDebounceMs: 1000,
      };
    case "aggressive":
      return {
        exclusionWindow: 15,
        chunkTargetTokens: 1000, 
        chunkMaxTokens: 2000,
        chunkOverlapTokens: 200,
        syncDebounceMs: 300,
      };
    case "balanced":
    default:
      return {
        exclusionWindow: 20,
        chunkTargetTokens: 800,
        chunkMaxTokens: 1600,
        chunkOverlapTokens: 120,
        syncDebounceMs: 500,
      };
  }
}

function getWorldBookVectorVersionCacheKey(userId: string): string {
  return `${userId}:${WORLD_BOOK_VECTOR_VERSION}`;
}

const worldBookVectorVersionChecked = new Set<string>();

// Periodically clear the version-check cache so it doesn't grow unbounded.
// Re-checking is cheap (single DB read per user), so hourly clearing is fine.
let _versionCheckCleanupTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  worldBookVectorVersionChecked.clear();
}, 3600_000);

export function stopVersionCheckCleanup(): void {
  if (_versionCheckCleanupTimer) {
    clearInterval(_versionCheckCleanupTimer);
    _versionCheckCleanupTimer = null;
  }
}

function normalizeVectorSearchText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function buildWorldBookEntrySearchText(entry: WorldBookEntry): string {
  const content = sanitizeForVectorization(entry.content || "");
  if (!content) return "";
  return normalizeVectorSearchText([
    ...buildWorldBookChunkLead(entry),
    `Content:\n${content}`,
  ].join("\n\n"));
}

function buildWorldBookChunkLead(entry: WorldBookEntry): string[] {
  const primaryKeys = uniqueNonEmpty(entry.key || []);
  const secondaryKeys = uniqueNonEmpty(entry.keysecondary || []);
  const comment = (entry.comment || "").trim();
  const sections: string[] = [];

  if (comment) sections.push(`Entry title: ${comment}`);
  if (primaryKeys.length > 0) sections.push(`Primary keys: ${primaryKeys.join(", ")}`);
  if (secondaryKeys.length > 0) sections.push(`Secondary keys: ${secondaryKeys.join(", ")}`);
  return sections;
}

function buildWorldBookEntryEmbeddingChunks(
  entry: WorldBookEntry,
  settings: WorldBookVectorSettings,
): Array<{ chunkIndex: number; content: string; searchText: string; chunkCount: number }> {
  const content = sanitizeForVectorization(entry.content || "");
  if (!content) return [];

  const chunked = chunkDocument(content, {
    targetTokens: settings.chunkTargetTokens,
    maxTokens: settings.chunkMaxTokens,
    overlapTokens: settings.chunkOverlapTokens,
  });
  const limited = (chunked.length > 0 ? chunked : [{ index: 0, content, tokenCount: 0, metadata: { startOffset: 0, endOffset: content.length } }])
    .slice(0, settings.maxChunksPerEntry)
    .filter((chunk) => chunk.content.trim().length > 0);
  const leadSections = buildWorldBookChunkLead(entry);
  const chunkCount = limited.length;

  return limited.map((chunk, index) => {
    const sections = [...leadSections];
    if (chunkCount > 1) sections.push(`Chunk ${index + 1} of ${chunkCount}`);
    sections.push(`Content:\n${chunk.content.trim()}`);
    return {
      chunkIndex: index,
      content: chunk.content.trim(),
      searchText: normalizeVectorSearchText(sections.join("\n\n")),
      chunkCount,
    };
  });
}

function buildWorldBookEmbeddingMetadata(
  entry: WorldBookEntry,
  searchText: string,
  chunkIndex: number,
  chunkCount: number,
): WorldBookEmbeddingMetadata {
  return {
    comment: entry.comment,
    key: entry.key,
    keysecondary: entry.keysecondary,
    world_book_id: entry.world_book_id,
    search_text: searchText,
    vector_version: WORLD_BOOK_VECTOR_VERSION,
    chunk_index: chunkIndex,
    chunk_count: chunkCount,
  };
}

function parseWorldBookEmbeddingMetadata(raw: unknown): WorldBookEmbeddingMetadata {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as WorldBookEmbeddingMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseChatChunkEmbeddingMetadata(raw: unknown): ChatChunkEmbeddingMetadata {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as ChatChunkEmbeddingMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function buildChatChunkEmbeddingRows(
  userId: string,
  chatId: string,
  chunkId: string,
  sourceContent: string,
  leaves: Array<{ content: string; vector: number[] }>,
  metadata?: Record<string, any>,
  now = Math.floor(Date.now() / 1000),
  sourceTokenCount?: number,
): EmbeddingRow[] {
  const normalizedSource = sourceContent.trim();
  const normalizedMetadata = metadata || {};
  const metadataSourceTokenCount = Number(normalizedMetadata.sourceTokenCount);
  const resolvedSourceTokenCount = Math.max(
    0,
    sourceTokenCount
      ?? (Number.isFinite(metadataSourceTokenCount) ? metadataSourceTokenCount : estimateChatChunkTokens(normalizedSource)),
  );
  const sourceContentHash = hashChatChunkContent(normalizedSource);
  const chunkCount = leaves.length;

  return leaves.map((leaf, chunkIndex) => ({
    id: rowId(userId, "chat_chunk", chunkId, chunkIndex),
    user_id: userId,
    source_type: "chat_chunk",
    source_id: chunkId,
    owner_id: chatId,
    chunk_index: chunkIndex,
    content: leaf.content.trim(),
    vector: leaf.vector,
    metadata_json: JSON.stringify({
      ...normalizedMetadata,
      autoSplit: chunkCount > 1,
      splitIndex: chunkIndex,
      splitCount: chunkCount,
      sourceCharCount: normalizedSource.length,
      sourceTokenCount: resolvedSourceTokenCount,
      sourceContentHash,
    }),
    updated_at: now,
  }));
}

function buildVaultChunkEmbeddingRows(
  userId: string,
  vaultId: string,
  vaultChunkId: string,
  sourceContent: string,
  leaves: Array<{ content: string; vector: number[] }>,
  metadata?: Record<string, any>,
  now = Math.floor(Date.now() / 1000),
  sourceTokenCount?: number,
): EmbeddingRow[] {
  const normalizedSource = sourceContent.trim();
  const normalizedMetadata = metadata || {};
  const metadataSourceTokenCount = Number(normalizedMetadata.sourceTokenCount);
  const resolvedSourceTokenCount = Math.max(
    0,
    sourceTokenCount
      ?? (Number.isFinite(metadataSourceTokenCount) ? metadataSourceTokenCount : estimateChatChunkTokens(normalizedSource)),
  );
  const sourceContentHash = hashChatChunkContent(normalizedSource);
  const chunkCount = leaves.length;

  return leaves.map((leaf, chunkIndex) => ({
    id: rowId(userId, "vault_chunk", vaultChunkId, chunkIndex),
    user_id: userId,
    source_type: "vault_chunk",
    source_id: vaultChunkId,
    owner_id: vaultId,
    chunk_index: chunkIndex,
    content: leaf.content.trim(),
    vector: leaf.vector,
    metadata_json: JSON.stringify({
      ...normalizedMetadata,
      autoSplit: chunkCount > 1,
      splitIndex: chunkIndex,
      splitCount: chunkCount,
      sourceCharCount: normalizedSource.length,
      sourceTokenCount: resolvedSourceTokenCount,
      sourceContentHash,
    }),
    updated_at: now,
  }));
}

async function replaceChatChunkEmbeddingRows(
  userId: string,
  targets: Array<{ chatId: string; chunkId: string }>,
  rows: EmbeddingRow[],
): Promise<void> {
  if (targets.length > 0) {
    const chunkIdsByChat = new Map<string, string[]>();
    for (const target of targets) {
      const bucket = chunkIdsByChat.get(target.chatId);
      if (bucket) bucket.push(target.chunkId);
      else chunkIdsByChat.set(target.chatId, [target.chunkId]);
    }
    for (const [chatId, chunkIds] of chunkIdsByChat) {
      await deleteStoreRows("embeddings", andFilter([
        ownerScope(userId, "chat_chunk", chatId),
        inSet("source_id", Array.from(new Set(chunkIds))),
      ]));
    }
  }
  if (rows.length > 0) {
    await upsertStoreRows("embeddings", rows);
  }
}

async function replaceVaultChunkEmbeddingRows(
  userId: string,
  vaultId: string,
  vaultChunkIds: string[],
  rows: EmbeddingRow[],
): Promise<void> {
  if (vaultChunkIds.length > 0) {
    await deleteStoreRows("embeddings", andFilter([
      ownerScope(userId, "vault_chunk", vaultId),
      inSet("source_id", Array.from(new Set(vaultChunkIds))),
    ]));
  }
  if (rows.length > 0) {
    await upsertStoreRows("embeddings", rows);
  }
}

function loadChatChunkMessageIds(chunkId: string): string[] {
  const row = getDb().query("SELECT message_ids FROM chat_chunks WHERE id = ?").get(chunkId) as { message_ids: string | null } | null;
  if (!row?.message_ids) return [];
  try {
    const parsed = JSON.parse(row.message_ids);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

async function embedChatChunkContentLeaves(
  userId: string,
  content: string,
  initialError?: Error,
  options?: { signal?: AbortSignal },
): Promise<Array<{ content: string; vector: number[] }>> {
  const text = content.trim();
  if (!text) return [];
  if (options?.signal?.aborted) throw resolveAbortError(options.signal);

  if (initialError && !isRetryableBatchError(initialError)) {
    throw initialError;
  }
  if (initialError) {
    const forcedSlices = splitChatChunkContent(text, { forceSplit: true });
    if (forcedSlices.length < 2) throw initialError;
    const out: Array<{ content: string; vector: number[] }> = [];
    for (const slice of forcedSlices) {
      out.push(...await embedChatChunkContentLeaves(userId, slice, undefined, options));
    }
    return out;
  }

  const proactiveSlices = buildChatChunkEmbeddingSlices(text).map((slice) => slice.content);
  if (proactiveSlices.length > 1) {
    const out: Array<{ content: string; vector: number[] }> = [];
    for (const slice of proactiveSlices) {
      out.push(...await embedChatChunkContentLeaves(userId, slice, undefined, options));
    }
    return out;
  }

  try {
    const [vector] = await cachedEmbedTexts(userId, [text], { signal: options?.signal });
    if (!vector || vector.length === 0) {
      throw new Error("No embedding vector returned");
    }
    return [{ content: text, vector }];
  } catch (err) {
    if (options?.signal?.aborted) throw resolveAbortError(options.signal);
    const error = err instanceof Error ? err : new Error(String(err));
    if (!isRetryableBatchError(error)) throw error;

    const parts = splitChatChunkContent(text, { forceSplit: true });
    if (parts.length < 2) throw error;

    const out: Array<{ content: string; vector: number[] }> = [];
    for (const part of parts) {
      out.push(...await embedChatChunkContentLeaves(userId, part, undefined, options));
    }
    return out;
  }
}

export async function tryRecoverChatChunkEmbeddingWithAutoSplit(
  userId: string,
  chatId: string,
  chunkId: string,
  content: string,
  error: Error,
  metadata?: Record<string, any>,
  sourceTokenCount?: number,
  options?: { signal?: AbortSignal },
): Promise<{
  recovered: boolean;
  skipped: boolean;
  splitCount: number;
  splitCharCounts: number[];
  splitTokenCounts: number[];
}> {
  if (options?.signal?.aborted) throw resolveAbortError(options.signal);
  const text = content.trim();
  if (!text || !isRetryableBatchError(error)) {
    return {
      recovered: false,
      skipped: false,
      splitCount: 0,
      splitCharCounts: [],
      splitTokenCounts: [],
    };
  }

  const previewSplits = splitChatChunkContent(text, { forceSplit: true });
  if (previewSplits.length < 2) {
    return {
      recovered: false,
      skipped: false,
      splitCount: 0,
      splitCharCounts: [],
      splitTokenCounts: [],
    };
  }

  const db = getDb();
  const liveBefore = db
    .query("SELECT 1 AS found FROM chat_chunks WHERE id = ? AND chat_id = ?")
    .get(chunkId, chatId) as { found: number } | null;
  if (!liveBefore) {
    return {
      recovered: true,
      skipped: true,
      splitCount: 0,
      splitCharCounts: [],
      splitTokenCounts: [],
    };
  }

  const resolvedSourceTokenCount = Math.max(0, sourceTokenCount ?? estimateChatChunkTokens(text));
  console.warn(
    "[embeddings] Chat chunk auto-split triggered:",
    {
      chunkId,
      chatId,
      sourceChars: text.length,
      sourceTokensApprox: resolvedSourceTokenCount,
      previewSplits: previewSplits.length,
      previewSplitChars: previewSplits.map((part) => part.length),
      previewSplitTokensApprox: previewSplits.map((part) => estimateChatChunkTokens(part)),
      error: error.message,
    },
  );

  const leaves = await embedChatChunkContentLeaves(userId, text, error, options);
  const liveAfter = db
    .query("SELECT 1 AS found FROM chat_chunks WHERE id = ? AND chat_id = ?")
    .get(chunkId, chatId) as { found: number } | null;
  if (!liveAfter) {
    console.info(`[embeddings] Chat chunk auto-split skipped write for deleted chunk ${chunkId}`);
    return {
      recovered: true,
      skipped: true,
      splitCount: 0,
      splitCharCounts: [],
      splitTokenCounts: [],
    };
  }
  if (options?.signal?.aborted) throw resolveAbortError(options.signal);

  const rows = buildChatChunkEmbeddingRows(
    userId,
    chatId,
    chunkId,
    text,
    leaves,
    metadata,
    Math.floor(Date.now() / 1000),
    resolvedSourceTokenCount,
  );
  await replaceChatChunkEmbeddingRows(userId, [{ chatId, chunkId }], rows);
  await scheduleStoreOptimize("chat_chunk");

  const splitCharCounts = rows.map((row) => row.content.length);
  const splitTokenCounts = rows.map((row) => estimateChatChunkTokens(row.content));
  console.info(
    "[embeddings] Chat chunk auto-split recovered:",
    {
      chunkId,
      chatId,
      splitCount: rows.length,
      splitCharCounts,
      splitTokenCountsApprox: splitTokenCounts,
    },
  );

  return {
    recovered: true,
    skipped: false,
    splitCount: rows.length,
    splitCharCounts,
    splitTokenCounts,
  };
}

async function tryRecoverVaultChunkEmbeddingWithAutoSplit(
  userId: string,
  vaultId: string,
  vaultChunkId: string,
  content: string,
  error: Error,
  metadata?: Record<string, any>,
  sourceTokenCount?: number,
): Promise<{
  recovered: boolean;
  skipped: boolean;
  splitCount: number;
  splitCharCounts: number[];
  splitTokenCounts: number[];
}> {
  const text = content.trim();
  if (!text || !isRetryableBatchError(error)) {
    return {
      recovered: false,
      skipped: false,
      splitCount: 0,
      splitCharCounts: [],
      splitTokenCounts: [],
    };
  }

  const previewSplits = splitChatChunkContent(text, { forceSplit: true });
  if (previewSplits.length < 2) {
    return {
      recovered: false,
      skipped: false,
      splitCount: 0,
      splitCharCounts: [],
      splitTokenCounts: [],
    };
  }

  const db = getDb();
  const liveBefore = db
    .query("SELECT 1 AS found FROM cortex_vault_chunks WHERE id = ? AND vault_id = ?")
    .get(vaultChunkId, vaultId) as { found: number } | null;
  if (!liveBefore) {
    return {
      recovered: true,
      skipped: true,
      splitCount: 0,
      splitCharCounts: [],
      splitTokenCounts: [],
    };
  }

  const resolvedSourceTokenCount = Math.max(0, sourceTokenCount ?? estimateChatChunkTokens(text));
  console.warn(
    "[embeddings] Vault chunk auto-split triggered:",
    {
      vaultChunkId,
      vaultId,
      sourceChars: text.length,
      sourceTokensApprox: resolvedSourceTokenCount,
      previewSplits: previewSplits.length,
      previewSplitChars: previewSplits.map((part) => part.length),
      previewSplitTokensApprox: previewSplits.map((part) => estimateChatChunkTokens(part)),
      error: error.message,
    },
  );

  const leaves = await embedChatChunkContentLeaves(userId, text, error);
  const liveAfter = db
    .query("SELECT 1 AS found FROM cortex_vault_chunks WHERE id = ? AND vault_id = ?")
    .get(vaultChunkId, vaultId) as { found: number } | null;
  if (!liveAfter) {
    console.info(`[embeddings] Vault chunk auto-split skipped write for deleted chunk ${vaultChunkId}`);
    return {
      recovered: true,
      skipped: true,
      splitCount: 0,
      splitCharCounts: [],
      splitTokenCounts: [],
    };
  }

  const rows = buildVaultChunkEmbeddingRows(
    userId,
    vaultId,
    vaultChunkId,
    text,
    leaves,
    metadata,
    Math.floor(Date.now() / 1000),
    resolvedSourceTokenCount,
  );
  await replaceVaultChunkEmbeddingRows(userId, vaultId, [vaultChunkId], rows);
  await scheduleStoreOptimize();

  const splitCharCounts = rows.map((row) => row.content.length);
  const splitTokenCounts = rows.map((row) => estimateChatChunkTokens(row.content));
  console.info(
    "[embeddings] Vault chunk auto-split recovered:",
    {
      vaultChunkId,
      vaultId,
      splitCount: rows.length,
      splitCharCounts,
      splitTokenCountsApprox: splitTokenCounts,
    },
  );

  return {
    recovered: true,
    skipped: false,
    splitCount: rows.length,
    splitCharCounts,
    splitTokenCounts,
  };
}

async function deleteStoreRows(collection: CollectionName, filter: VectorFilter): Promise<void> {
  const store = await getActiveVectorStore();
  await store.deleteByFilter(collection, filter);
}

async function upsertStoreRows(collection: CollectionName, rows: EmbeddingRow[]): Promise<void> {
  if (rows.length === 0) return;
  const store = await getActiveVectorStore();
  await store.upsert(collection, rows);
}

async function scheduleStoreOptimize(reason: "general" | "chat_chunk" | "world_book" = "general"): Promise<void> {
  const store = await getActiveVectorStore();
  if (store.capabilities.supportsOptimize) {
    scheduleOptimize(reason);
    return;
  }
  if (store.capabilities.requiresExplicitFlush) {
    const collections: CollectionName[] = reason === "world_book" ? ["embeddings_world_books"] : ["embeddings"];
    await store.optimize(collections);
  }
}

async function ensureWorldBookVectorVersion(userId: string): Promise<void> {
  const cacheKey = getWorldBookVectorVersionCacheKey(userId);
  if (worldBookVectorVersionChecked.has(cacheKey)) return;

  const setting = settingsSvc.getSetting(userId, WORLD_BOOK_VECTOR_VERSION_KEY);
  const storedValue = typeof setting?.value === "number"
    ? setting.value
    : Number(setting?.value);

  if (storedValue === WORLD_BOOK_VECTOR_VERSION) {
    worldBookVectorVersionChecked.add(cacheKey);
    return;
  }

  try {
    await deleteStoreRows("embeddings_world_books", andFilter([eq("user_id", userId), eq("source_type", "world_book_entry")]));
  } catch (err) {
    console.warn("[embeddings] Failed to invalidate legacy world-book vectors:", err);
  }

  try {
    getDb().query(
      `UPDATE world_book_entries
       SET vector_index_status = ${worldBookVectorDesiredStatusSql()},
           vector_indexed_at = NULL,
           vector_index_error = NULL
       WHERE world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)`
    ).run(userId);
  } catch (err) {
    console.warn("[embeddings] Failed to reset world-book vector state for new schema:", err);
  }

  settingsSvc.putSetting(userId, WORLD_BOOK_VECTOR_VERSION_KEY, WORLD_BOOK_VECTOR_VERSION);
  worldBookVectorVersionChecked.add(cacheKey);
}

export function getProviderDefaults(provider: EmbeddingProvider) {
  return {
    api_url: PROVIDER_DEFAULT_URL[provider],
    model: providerDefaultModel(provider),
  };
}

function normalizeEmbeddingApiUrlForModelListing(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    let path = parsed.pathname.replace(/\/+$/, "");
    if (/\/(embeddings|embed)$/.test(path)) {
      path = path.replace(/\/(embeddings|embed)$/, "");
    }
    parsed.pathname = path || "/v1";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    const stripped = trimmed.replace(/\/(embeddings|embed)$/, "");
    return stripped || trimmed;
  }
}

function resolveNanoGptEmbeddingModelsUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return "https://nano-gpt.com/api/v1/embedding-models";

  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (/\/embedding-models$/.test(path)) {
      return trimmed;
    }
    if (/\/(embeddings|embed)$/.test(path)) {
      parsed.pathname = path.replace(/\/(embeddings|embed)$/, "/embedding-models");
    } else if (!path || path === "/") {
      parsed.pathname = "/api/v1/embedding-models";
    } else {
      parsed.pathname = `${path}/embedding-models`;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    const stripped = trimmed.replace(/\/(embeddings|embed)$/, "");
    return `${stripped || trimmed}/embedding-models`;
  }
}

async function fetchNanoGptEmbeddingModels(
  apiKey: string,
  rawUrl: string,
): Promise<{ models: string[]; model_labels?: Record<string, string> }> {
  const url = resolveNanoGptEmbeddingModelsUrl(rawUrl);
  const res = await fetch(url, {
    headers: {
      ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim().replace(/^Bearer\s+/i, "")}` } : {}),
    },
  });

  if (!res.ok) {
    throw new Error(`NanoGPT model listing failed with ${res.status}`);
  }

  const payload = await res.json() as { data?: Array<{ id?: unknown; name?: unknown }> };
  const labels: Record<string, string> = {};
  const models = Array.isArray(payload?.data)
    ? payload.data
      .map((entry) => {
        const id = typeof entry?.id === "string" ? entry.id.trim() : "";
        const name = typeof entry?.name === "string" ? entry.name.trim() : "";
        if (id && name && name !== id) {
          labels[id] = name;
        }
        return id;
      })
      .filter(Boolean)
      .sort()
    : [];

  return {
    models,
    model_labels: Object.keys(labels).length > 0 ? labels : undefined,
  };
}

export async function previewEmbeddingModels(
  userId: string,
  input: EmbeddingModelsPreviewInput,
): Promise<{ models: string[]; model_labels?: Record<string, string>; provider: EmbeddingProvider; error?: string }> {
  const ctx = resolveEmbeddingUserContext(userId);
  const base = readRawEmbeddingConfig(ctx.userId);
  const provider = input.provider ?? base.provider;
  const cfg = normalizeConfig({ ...base, ...input, provider });

  let apiKey = input.api_key?.trim() || "";
  if (!apiKey) {
    apiKey = (await getEmbeddingSecret(ctx.userId, cfg.provider)) || "";
  }

  try {
    if (cfg.provider === "nanogpt") {
      const result = await fetchNanoGptEmbeddingModels(apiKey, cfg.api_url);
      return { ...result, provider: cfg.provider };
    }

    if (cfg.provider === "openrouter") {
      const providerImpl = getProvider("openrouter");
      const { OpenRouterProvider } = await import("../llm/providers/openrouter");
      if (providerImpl instanceof OpenRouterProvider) {
        const richModels = await providerImpl.fetchModelsWithMetadata(apiKey, normalizeEmbeddingApiUrlForModelListing(cfg.api_url), {
          outputModalities: "embeddings",
        });
        const models = richModels.map((m) => m.id).sort();
        const model_labels: Record<string, string> = {};
        for (const model of richModels) {
          if (model.name && model.name !== model.id) model_labels[model.id] = model.name;
        }
        return {
          models,
          model_labels: Object.keys(model_labels).length > 0 ? model_labels : undefined,
          provider: cfg.provider,
        };
      }
    }

    const providerName = cfg.provider === "openai-compatible" || cfg.provider === "bananabread"
      ? "custom"
      : cfg.provider;
    const providerImpl = getProvider(providerName);
    if (!providerImpl) {
      return { models: [], provider: cfg.provider, error: `Unknown provider: ${cfg.provider}` };
    }

    const models = await providerImpl.listModels(apiKey, normalizeEmbeddingApiUrlForModelListing(cfg.api_url));
    return { models, provider: cfg.provider };
  } catch (err) {
    return {
      models: [],
      provider: cfg.provider,
      error: describeProviderError(err, "Failed to fetch embedding models"),
    };
  }
}

/** Raw per-user embedding config (no inheritance resolution). */
function readRawEmbeddingConfig(userId: string): EmbeddingConfig {
  const setting = settingsSvc.getSetting(userId, EMBEDDING_SETTINGS_KEY);
  return normalizeConfig(setting?.value);
}

/**
 * Owner gate: LanceDB stores one table with a dimension locked at creation,
 * so a multi-user box cannot support different embedding models per user
 * without dim mismatches. When the owner has enabled embeddings, every
 * non-owner inherits that config (and the owner's API key / billing). When
 * the owner has embeddings disabled, users fall back to their own config.
 *
 * Returns the userId whose settings + secret should drive embedding
 * operations, and whether inheritance is active for the caller.
 */
function resolveEmbeddingUserContext(callerUserId: string): { userId: string; inherited: boolean } {
  const ownerId = getFirstUserId();
  if (!ownerId || ownerId === callerUserId) {
    return { userId: callerUserId, inherited: false };
  }
  const ownerCfg = readRawEmbeddingConfig(ownerId);
  if (ownerCfg.enabled) {
    return { userId: ownerId, inherited: true };
  }
  return { userId: callerUserId, inherited: false };
}

export async function getEmbeddingConfig(userId: string): Promise<EmbeddingConfigWithStatus> {
  const ctx = resolveEmbeddingUserContext(userId);
  const cfg = readRawEmbeddingConfig(ctx.userId);
  const has_api_key = await hasEmbeddingSecret(ctx.userId, cfg.provider);
  return ctx.inherited
    ? { ...cfg, has_api_key, inherited: true }
    : { ...cfg, has_api_key };
}

export async function updateEmbeddingConfig(
  userId: string,
  input: Partial<EmbeddingConfig> & { api_key?: string | null }
): Promise<EmbeddingConfigWithStatus> {
  const ownerId = getFirstUserId();
  const callerIsOwner = ownerId !== null && ownerId === userId;

  // Reject non-owner writes while the gate is active — the config they'd see
  // is inherited from the owner, so a per-user write would be silently shadowed.
  if (!callerIsOwner && ownerId) {
    const ownerCfg = readRawEmbeddingConfig(ownerId);
    if (ownerCfg.enabled) {
      throw new Error("Embedding configuration is managed by the server owner and cannot be overridden.");
    }
  }

  const current = readRawEmbeddingConfig(userId);
  const merged = normalizeConfig({ ...current, ...input });
  settingsSvc.putSetting(userId, EMBEDDING_SETTINGS_KEY, merged);

  if (input.api_key !== undefined) {
    const next = (input.api_key || "").trim();
    if (next) {
      await putEmbeddingSecret(userId, merged.provider, next);
    } else {
      deleteEmbeddingSecret(userId, merged.provider);
    }
  }

  const oldFp = getModelFingerprint(current);
  const newFp = getModelFingerprint(merged);
  const fingerprintChanged =
    oldFp.provider !== newFp.provider ||
    oldFp.model !== newFp.model ||
    oldFp.dimensions !== newFp.dimensions ||
    oldFp.api_url !== newFp.api_url;

  // When the owner flips the gate or changes their fingerprint while enabled,
  // every user's vectors become stale at once — nuke the shared LanceDB store
  // so everyone re-vectorizes against the new config. For non-owner edits
  // (only reachable when the gate was inactive), scope invalidation to caller.
  const ownerGateTransition = callerIsOwner && current.enabled !== merged.enabled;
  const ownerFingerprintChanged = callerIsOwner && merged.enabled && fingerprintChanged;
  if (ownerGateTransition || ownerFingerprintChanged) {
    await forceResetLanceDB();
  } else if (!callerIsOwner && fingerprintChanged) {
    await invalidateAllVectors(userId);
  }

  const has_api_key = await hasEmbeddingSecret(userId, merged.provider);
  return { ...merged, has_api_key };
}

/**
 * Parse embedding responses from OpenAI-compatible, Ollama /api/embed, and Ollama /api/embeddings formats.
 */
function parseEmbeddingResponse(payload: any, expectedCount: number): number[][] {
  // Some providers (notably OpenRouter) return HTTP 200 with an error envelope
  // like `{ error: { message, code } }` when the request was shaped correctly
  // but couldn't be served (unsupported model, no routing provider, etc.).
  // Surface that instead of the generic "Unrecognized" error.
  if (payload && typeof payload === "object" && payload.error) {
    const err = payload.error;
    const msg = typeof err === "string"
      ? err
      : (err.message || err.code || JSON.stringify(err));
    throw new Error(`Embedding provider returned an error: ${msg}`);
  }

  // OpenAI format: { data: [{ embedding: number[] }, ...] }
  if (Array.isArray(payload.data) && payload.data.length > 0 && payload.data[0].embedding) {
    const vectors = payload.data.map((d: any) => d.embedding || []);
    if (vectors.length !== expectedCount) {
      throw new Error(`Embedding provider returned ${vectors.length} vectors, expected ${expectedCount}`);
    }
    return vectors;
  }

  // Ollama /api/embed format: { embeddings: number[][] }
  if (Array.isArray(payload.embeddings) && Array.isArray(payload.embeddings[0])) {
    if (payload.embeddings.length !== expectedCount) {
      throw new Error(`Embedding provider returned ${payload.embeddings.length} vectors, expected ${expectedCount}`);
    }
    return payload.embeddings;
  }

  // Ollama /api/embeddings (legacy single): { embedding: number[] }
  if (Array.isArray(payload.embedding)) {
    if (expectedCount !== 1) {
      throw new Error(`Ollama /api/embeddings only supports single inputs, but ${expectedCount} texts were sent`);
    }
    return [payload.embedding];
  }

  const preview = (() => {
    try {
      const s = JSON.stringify(payload);
      return s.length > 400 ? `${s.slice(0, 400)}…` : s;
    } catch {
      return String(payload);
    }
  })();
  throw new Error(`Unrecognized embedding response format — payload: ${preview}`);
}

// ---------------------------------------------------------------------------
// Google Vertex AI embeddings
// ---------------------------------------------------------------------------

/**
 * Vertex splits embeddings across two endpoints. Rule mirrors the
 * @google/genai SDK's `tIsVertexEmbedContentModel()`:
 *   - `:embedContent` when the model contains "gemini" (but isn't
 *     `gemini-embedding-001`) OR contains "maas"
 *   - `:predict` for everything else (incl. `text-embedding-*`,
 *     `text-multilingual-embedding-*`, `textembedding-gecko*`,
 *     and `gemini-embedding-001`)
 */
function isVertexEmbedContentModel(model: string): boolean {
  return (model.includes("gemini") && model !== "gemini-embedding-001")
      || model.includes("maas");
}

async function requestVertexEmbeddings(
  cfg: EmbeddingConfig,
  apiKey: string,
  texts: string[],
  options?: { omitDimensions?: boolean; signal?: AbortSignal }
): Promise<number[][]> {
  const sa = parseServiceAccount(apiKey);
  const accessToken = await getAccessToken(sa);
  const location = cfg.vertex_region || "global";
  const host = vertexHostForLocation(location);
  const projectId = sa.project_id;
  const model = cfg.model;
  const useEmbedContent = isVertexEmbedContentModel(model);
  const dims = !options?.omitDimensions && cfg.send_dimensions && cfg.dimensions
    ? cfg.dimensions
    : undefined;

  const timeoutMs = cfg.request_timeout > 0
    ? cfg.request_timeout * 1000
    : DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS;

  const base = `${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}`;

  // The `:embedContent` endpoint accepts exactly one content per call.
  // Serialize the batch to match the SDK's behavior.
  if (useEmbedContent) {
    const results: number[][] = [];
    for (const text of texts) {
      if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      const body: Record<string, any> = {
        content: { role: "user", parts: [{ text }] },
      };
      if (dims) body.embedContentConfig = { outputDimensionality: dims };
      const vec = await postVertex<{ embedding?: { values?: number[] } }>(
        `${base}:embedContent`,
        accessToken,
        body,
        timeoutMs,
        options?.signal,
      );
      const values = vec?.embedding?.values;
      if (!Array.isArray(values)) {
        throw new Error("Vertex embedContent response missing embedding.values");
      }
      results.push(values);
    }
    return results;
  }

  // `:predict` supports batched inputs via `instances[]`.
  const body: Record<string, any> = {
    instances: texts.map((text) => ({ content: text })),
  };
  if (dims) body.parameters = { outputDimensionality: dims };
  const payload = await postVertex<{ predictions?: Array<{ embeddings?: { values?: number[] } }> }>(
    `${base}:predict`,
    accessToken,
    body,
    timeoutMs,
    options?.signal,
  );
  const preds = payload?.predictions;
  if (!Array.isArray(preds) || preds.length !== texts.length) {
    throw new Error(
      `Vertex predict returned ${preds?.length ?? 0} predictions, expected ${texts.length}`,
    );
  }
  return preds.map((p, i) => {
    const values = p?.embeddings?.values;
    if (!Array.isArray(values)) {
      throw new Error(`Vertex predict response missing embeddings.values at index ${i}`);
    }
    return values;
  });
}

async function postVertex<T>(url: string, accessToken: string, body: Record<string, any>, timeoutMs: number, externalSignal?: AbortSignal): Promise<T> {
  const { signal, cleanup } = linkTimeoutSignal(externalSignal, timeoutMs);
  const mapAbortError = (err: any): Error => {
    if (err?.name === "AbortError") {
      if (externalSignal?.aborted) return resolveAbortError(externalSignal);
      return new Error(`Vertex embedding request timed out after ${timeoutMs / 1000}s`);
    }
    return err;
  };
  try {
    let res: Response;
    try {
      res = await fetchWithPreflightAbort(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      }, signal);
    } catch (err: any) {
      throw mapAbortError(err);
    }
    if (!res.ok) {
      const msg = (await readBoundedText(res)) || "Vertex embedding request failed";
      throw new Error(`Vertex embedding request failed (${res.status}): ${msg}`);
    }
    try {
      return await readJsonWithAbort<T>(res, signal);
    } catch (err: any) {
      throw mapAbortError(err);
    }
  } finally {
    cleanup();
  }
}

async function requestEmbeddings(
  userId: string,
  texts: string[],
  options?: { omitDimensions?: boolean; signal?: AbortSignal }
): Promise<number[][]> {
  // Resolve which user's settings + API key actually drive this call. In gate
  // mode non-owners inherit the owner's config and use the owner's key.
  const ctx = resolveEmbeddingUserContext(userId);
  const cfg = readRawEmbeddingConfig(ctx.userId);
  if (!cfg.enabled) throw new Error("Embeddings are disabled for this user");
  const apiKey = await getEmbeddingSecret(ctx.userId, cfg.provider);
  if (!apiKey) throw new Error("Embedding API key is not configured");
  if (!texts.length) return [];
  if (options?.signal?.aborted) throw resolveAbortError(options.signal);

  if (cfg.provider === "google_vertex") {
    return requestVertexEmbeddings(cfg, apiKey, texts, options);
  }

  const url = resolveEmbeddingUrl(cfg.api_url);

  // Detect Ollama endpoints from the resolved URL (not the raw user input)
  // so that partial paths like /api → /api/embeddings are caught correctly.
  const isOllamaNative = /\/api\/(embed|embeddings)\b/.test(url);
  // Ollama's legacy /api/embeddings endpoint only supports single inputs.
  // The modern /api/embed endpoint supports batch natively.
  const isOllamaLegacySingleOnly = /\/api\/embeddings\b/.test(url);

  // If using the legacy single-input Ollama endpoint with multiple texts,
  // send them sequentially instead of as a batch to avoid the
  // "only supports single inputs" error.
  if (isOllamaLegacySingleOnly && texts.length > 1) {
    const results: number[][] = [];
    for (const text of texts) {
      const [vec] = await requestEmbeddings(userId, [text], options);
      results.push(vec);
    }
    return results;
  }

  const body: Record<string, any> = {
    model: cfg.model,
    input: isOllamaLegacySingleOnly ? texts[0] : texts,
  };
  if (!isOllamaNative) {
    body.encoding_format = "float";
  }
  if (!options?.omitDimensions && cfg.send_dimensions && cfg.dimensions) body.dimensions = cfg.dimensions;
  const timeoutMs = cfg.request_timeout > 0
    ? cfg.request_timeout * 1000
    : DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS;
  const { signal, cleanup } = linkTimeoutSignal(options?.signal, timeoutMs);
  const mapAbortError = (err: any): Error => {
    if (err?.name === "AbortError") {
      // Distinguish external cancel (caller-initiated) from our own timeout.
      if (options?.signal?.aborted) return resolveAbortError(options.signal);
      return new Error(`Embedding request timed out after ${timeoutMs / 1000}s`);
    }
    return err;
  };
  try {
    let res: Response;
    try {
      res = await fetchWithPreflightAbort(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      }, signal);
    } catch (err: any) {
      throw mapAbortError(err);
    }

    if (!res.ok) {
      const msg = (await readBoundedText(res)) || "Embedding request failed";
      throw new Error(`Embedding request failed (${res.status}): ${msg}`);
    }

    let payload: any;
    try {
      payload = await readJsonWithAbort<any>(res, signal);
    } catch (err: any) {
      throw mapAbortError(err);
    }
    return parseEmbeddingResponse(payload, texts.length);
  } finally {
    cleanup();
  }
}

export async function embedTexts(
  userId: string,
  texts: string[],
  options?: { signal?: AbortSignal },
): Promise<number[][]> {
  return requestEmbeddings(userId, texts, options);
}

function getModelFingerprint(
  cfg: Pick<EmbeddingConfig, "provider" | "model" | "dimensions" | "api_url" | "vertex_region">,
): ModelFingerprint {
  // For Vertex the `api_url` field is cosmetic — the effective endpoint is
  // derived from `vertex_region`. Encode it into the fingerprint so a region
  // change still invalidates cached vectors.
  const api_url = cfg.provider === "google_vertex"
    ? `vertex:${cfg.vertex_region || "global"}`
    : cfg.api_url;
  return { provider: cfg.provider, model: cfg.model, dimensions: cfg.dimensions, api_url };
}

export function getWorldBookVectorWriteFingerprint(
  cfg: Pick<EmbeddingConfig, "enabled" | "vectorize_world_books" | "provider" | "model" | "dimensions" | "api_url" | "vertex_region">,
): string {
  const model = getModelFingerprint(cfg);
  return JSON.stringify({
    enabled: !!cfg.enabled,
    vectorize_world_books: !!cfg.vectorize_world_books,
    vector_version: WORLD_BOOK_VECTOR_VERSION,
    ...model,
  });
}

/**
 * In-flight dedup with ref-counted abort: prevents concurrent
 * requestEmbeddings() calls for the same text AND lets the shared upstream
 * fetch be torn down when every caller has aborted.
 *
 * - `controller` aborts the shared upstream fetch.
 * - `liveJoiners` is the number of joiners that haven't aborted yet.
 * - `hasUncancellableJoiner` pins the fetch as unabortable when at least
 *   one joiner passed no signal — otherwise an aborting joiner could
 *   starve a no-signal caller (e.g. a background vectorization batch).
 */
interface InflightEmbeddingEntry {
  promise: Promise<number[]>;
  controller: AbortController;
  liveJoiners: number;
  hasUncancellableJoiner: boolean;
}
const inflightEmbeddings = new Map<string, InflightEmbeddingEntry>();

/**
 * Cache-aware embedding. Checks in-memory LRU cache first, batches only
 * uncached texts to the upstream API, then stores results.
 *
 * Single-text calls are deduped: if another caller is already fetching the
 * same text, we share its promise instead of making a second API call.
 */
export async function cachedEmbedTexts(
  userId: string,
  texts: string[],
  options?: { signal?: AbortSignal },
): Promise<number[][]> {
  if (!texts.length) return [];
  if (options?.signal?.aborted) throw resolveAbortError(options.signal);
  const cfg = await getEmbeddingConfig(userId);
  const fingerprint = getModelFingerprint(cfg);

  // Fast path for single-text calls (the common case for cortex + chat memory retrieval)
  if (texts.length === 1) {
    const key = computeCacheKey(texts[0], fingerprint);
    const cached = embeddingCache.get(key);
    if (cached) return [cached];

    const vec = await joinOrStartInflight(userId, texts, key, options?.signal);
    return [vec];
  }

  // Multi-text path: LRU cache check, batch uncached
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  const uncachedIndices: number[] = [];

  for (let i = 0; i < texts.length; i++) {
    const key = computeCacheKey(texts[i], fingerprint);
    const cached = embeddingCache.get(key);
    if (cached) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
    }
  }

  if (uncachedIndices.length > 0) {
    const uncachedTexts = uncachedIndices.map((i) => texts[i]);
    const vectors = await requestEmbeddings(userId, uncachedTexts, options);
    for (let j = 0; j < uncachedIndices.length; j++) {
      const idx = uncachedIndices[j];
      results[idx] = vectors[j];
      embeddingCache.set(computeCacheKey(texts[idx], fingerprint), vectors[j]);
    }
  }

  return results as number[][];
}

/**
 * llama.cpp's /v1/embeddings endpoint rejects requests whose cumulative token
 * count exceeds the server's `n_ubatch` (physical batch size, default 512).
 * The error surfaces as HTTP 500 "input is too large to process. increase the
 * physical batch size" — not a timeout — so the caller's timeout-only retry
 * never kicks in. Detect it (plus timeouts and a few other transient shapes)
 * so callers can halve and retry down to size 1 without user intervention.
 */
function isRetryableBatchError(err: Error): boolean {
  if (isChatChunkVectorizationBatchTimeoutError(err)) return false;
  const m = err.message;
  if (/timed out|abort/i.test(m)) return true;
  if (/too large to process|physical batch size|increase.*batch.*size/i.test(m)) return true;
  if (/exceeds.*context|context.*exceed/i.test(m)) return true;
  if (/\(413\)|\(500\)|\(503\)/.test(m)) return true;
  return false;
}

function looksLikePhysicalBatchLimit(err: Error): boolean {
  return /too large to process|physical batch size|exceeds.*context/i.test(err.message);
}

/**
 * Next (shorter) length to retry an over-budget query embed at, or null when
 * we've hit the floor and should give up. Halving mirrors
 * embedWithAdaptiveBatching's backoff; the floor stops us from spinning on a
 * backend that rejects everything.
 */
export function nextQueryEmbedLength(currentLen: number, minChars: number): number | null {
  if (currentLen <= minChars) return null;
  const next = Math.max(minChars, Math.floor(currentLen / 2));
  return next < currentLen ? next : null;
}

/**
 * Embed a single retrieval query, shrinking it on retryable "input too large"
 * errors instead of letting the caller collapse to a recency fallback.
 * Token-limited embedding backends (llama.cpp `n_ubatch`, 512-token BERT
 * models) reject oversized inputs with 413/500 — and a multi-message LTCM
 * query easily exceeds that. We keep the most-recent tail (consistent with how
 * the query is built) and halve until the backend accepts it or we hit the
 * floor, at which point the original error propagates.
 */
export async function embedQueryAdaptive(
  userId: string,
  text: string,
  options?: { signal?: AbortSignal; minChars?: number },
): Promise<number[]> {
  const minChars = Math.max(64, options?.minChars ?? 512);
  let current = text;
  for (;;) {
    try {
      const [vec] = await cachedEmbedTexts(userId, [current], { signal: options?.signal });
      return vec ?? [];
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // Never swallow a genuine cancellation by retrying a smaller input.
      if (options?.signal?.aborted || /abort/i.test(e.message)) throw e;
      const nextLen = isRetryableBatchError(e) ? nextQueryEmbedLength(current.length, minChars) : null;
      if (nextLen == null) throw e;
      console.warn(
        `[embeddings] Query embed of ${current.length} chars failed (${e.message}); retrying truncated to ${nextLen} chars`,
      );
      current = current.slice(-nextLen);
    }
  }
}

/**
 * Embed a list of items with automatic batch-halving on transient errors.
 *
 * For llama.cpp-style backends where the server's `n_ubatch` caps per-request
 * token volume, the user can't know the right `batch_size` in advance — a
 * batch that works for 256-token chunks will blow up on 2048-token ones. This
 * wrapper starts at `initialBatchSize`, halves on retryable failures, and
 * processes surviving sub-batches via `onBatchReady`. Items that still fail
 * at size 1 are surfaced via `onItemFailed` so callers can record error state
 * and move on rather than aborting the whole run.
 */
export async function embedWithAdaptiveBatching<T>(
  userId: string,
  items: T[],
  initialBatchSize: number,
  getText: (item: T) => string,
  onBatchReady: (items: T[], texts: string[], vectors: number[][]) => Promise<void>,
  onItemFailed: (items: T[], error: Error) => void | Promise<void>,
  options?: { signal?: AbortSignal; label?: string },
): Promise<void> {
  if (items.length === 0) return;
  const bs = Math.max(1, Math.min(initialBatchSize, 200));
  const label = options?.label ?? "embed";

  const process = async (batch: T[], currentSize: number): Promise<void> => {
    if (options?.signal?.aborted) {
      await onItemFailed(batch, resolveAbortError(options.signal));
      return;
    }
    const texts = batch.map(getText);
    try {
      const vectors = await cachedEmbedTexts(userId, texts, { signal: options?.signal });
      await onBatchReady(batch, texts, vectors);
    } catch (err) {
      if (options?.signal?.aborted) {
        await onItemFailed(batch, resolveAbortError(options.signal));
        return;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      if (isRetryableBatchError(e) && currentSize > 1) {
        const half = Math.max(1, Math.floor(currentSize / 2));
        console.warn(
          `[embeddings] ${label}: batch of ${batch.length} failed (${e.message}); retrying in sub-batches of ${half}`,
        );
        for (let j = 0; j < batch.length; j += half) {
          await process(batch.slice(j, j + half), half);
        }
        return;
      }
      if (currentSize === 1 && looksLikePhysicalBatchLimit(e)) {
        await onItemFailed(
          batch,
          new Error(
            `${e.message} — a single input still exceeds the server's physical batch size. ` +
            `For llama.cpp, restart llama-server with a larger --ubatch-size / -ub (and matching --batch-size / -b), ` +
            `or reduce the source chunk size.`,
          ),
        );
      } else {
        await onItemFailed(batch, e);
      }
    }
  };

  for (let i = 0; i < items.length; i += bs) {
    await process(items.slice(i, i + bs), bs);
  }
}

/**
 * Attach to an in-flight shared fetch or start a new one. The shared fetch's
 * own AbortController is aborted only when every cancellable joiner has
 * aborted AND no uncancellable joiner is attached.
 */
function joinOrStartInflight(
  userId: string,
  texts: string[],
  key: string,
  signal: AbortSignal | undefined,
): Promise<number[]> {
  const existing = inflightEmbeddings.get(key);
  if (existing) {
    return attachJoiner(existing, signal);
  }

  const controller = new AbortController();
  const entry: InflightEmbeddingEntry = {
    promise: null as unknown as Promise<number[]>,
    controller,
    liveJoiners: 0,
    hasUncancellableJoiner: false,
  };

  entry.promise = requestEmbeddings(userId, texts, { signal: controller.signal }).then(
    (vecs) => {
      const vec = vecs[0];
      embeddingCache.set(key, vec);
      inflightEmbeddings.delete(key);
      return vec;
    },
    (err) => {
      inflightEmbeddings.delete(key);
      throw err;
    },
  );
  inflightEmbeddings.set(key, entry);

  return attachJoiner(entry, signal);
}

function attachJoiner(
  entry: InflightEmbeddingEntry,
  signal: AbortSignal | undefined,
): Promise<number[]> {
  if (!signal) {
    entry.hasUncancellableJoiner = true;
    return entry.promise;
  }

  entry.liveJoiners++;
  const onAbort = () => {
    entry.liveJoiners--;
    // Tear down the shared upstream only when every cancellable joiner has
    // aborted and no uncancellable joiner is waiting on the result.
    if (!entry.hasUncancellableJoiner && entry.liveJoiners <= 0) {
      entry.controller.abort();
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });

  // Wrap the shared promise so this caller's await rejects on their own abort
  // without waiting for the shared work. The shared work may still continue
  // for other joiners; refcount decides when to actually cancel upstream.
  return new Promise<number[]>((resolve, reject) => {
    const onLocalAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onLocalAbort, { once: true });
    entry.promise.then(
      (v) => {
        signal.removeEventListener("abort", onLocalAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onLocalAbort);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Query vector cache — read/write
// ---------------------------------------------------------------------------

const QUERY_CACHE_TTL_SECONDS = 300; // 5 minutes

function computeQueryHash(queryText: string): string {
  return Bun.hash(queryText).toString(36);
}

/**
 * Look up a previously-cached query vector for a chat. Returns the vector if
 * found and not expired, otherwise null.
 */
export async function getCachedQueryVector(
  chatId: string,
  queryText: string,
): Promise<number[] | null> {
  try {
    const db = getDb();
    const hash = computeQueryHash(queryText);
    const now = Math.floor(Date.now() / 1000);

    const row = db.query<{ vector_json: string }, [string, string, number]>(
      `SELECT vector_json FROM query_vector_cache
       WHERE chat_id = ? AND query_hash = ? AND expires_at > ?`
    ).get(chatId, hash, now);

    if (!row) return null;

    // Update hit stats
    db.query(
      `UPDATE query_vector_cache
       SET hit_count = hit_count + 1, last_used_at = ?
       WHERE chat_id = ? AND query_hash = ?`
    ).run(now, chatId, hash);

    return JSON.parse(row.vector_json);
  } catch {
    return null;
  }
}

/**
 * Persist a query vector so future generations for the same chat + query text
 * can skip the embedding API call entirely.
 */
export function cacheQueryVector(
  chatId: string,
  queryText: string,
  vector: number[],
): void {
  try {
    const db = getDb();
    const hash = computeQueryHash(queryText);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + QUERY_CACHE_TTL_SECONDS;

    db.query(
      `INSERT INTO query_vector_cache
       (id, chat_id, query_hash, query_text, vector_json, hit_count, created_at, last_used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(chat_id, query_hash) DO UPDATE SET
         vector_json = excluded.vector_json,
         query_text = excluded.query_text,
         last_used_at = excluded.last_used_at,
         expires_at = excluded.expires_at`
    ).run(
      crypto.randomUUID(),
      chatId,
      hash,
      queryText,
      JSON.stringify(vector),
      now,
      now,
      expiresAt,
    );
  } catch {
    // Non-critical cache write failure — silently ignore
  }
}

export async function testEmbeddingConfig(
  userId: string,
  text: string
): Promise<{ dimension: number; config: EmbeddingConfigWithStatus }> {
  // Deliberately omit dimensions so providers return native/default dimensionality.
  const vectors = await requestEmbeddings(userId, [text], { omitDimensions: true });
  const first = vectors[0] || [];
  if (!first.length) throw new Error("No embedding vector returned");

  // In gate mode non-owners get a read-only test — verify the inherited config
  // works for them without mutating the owner's stored dimension.
  const ctx = resolveEmbeddingUserContext(userId);
  if (ctx.inherited) {
    const ownerCfg = readRawEmbeddingConfig(ctx.userId);
    const has_api_key = await hasEmbeddingSecret(ctx.userId, ownerCfg.provider);
    return {
      dimension: first.length,
      config: { ...ownerCfg, has_api_key, inherited: true },
    };
  }

  const current = readRawEmbeddingConfig(userId);
  const updated = normalizeConfig({ ...current, dimensions: first.length });
  settingsSvc.putSetting(userId, EMBEDDING_SETTINGS_KEY, updated);
  const has_api_key = await hasEmbeddingSecret(userId, updated.provider);

  return {
    dimension: first.length,
    config: {
      ...updated,
      has_api_key,
    },
  };
}

export async function deleteWorldBookEntryEmbeddings(userId: string, entryId: string): Promise<void> {
  await deleteWorldBookEntryRows(userId, [entryId]);
}

async function deleteWorldBookEntryRows(userId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  await deleteStoreRows("embeddings_world_books", andFilter([
    eq("user_id", userId),
    eq("source_type", "world_book_entry"),
    inSet("source_id", entryIds),
  ]));
}

async function deleteWorldBookEntryEmbeddingsBatch(userId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  await deleteWorldBookEntryRows(userId, entryIds);
}

function getDesiredWorldBookVectorStatus(entry: WorldBookEntry): WorldBookVectorIndexStatus {
  return desiredWorldBookVectorIndexStatus(entry);
}

function updateWorldBookEntryVectorState(
  entryId: string,
  status: WorldBookVectorIndexStatus,
  indexedAt: number | null,
  error: string | null,
): void {
  const exists = getDb().query("SELECT 1 AS found FROM world_book_entries WHERE id = ?").get(entryId) as { found: number } | null;
  getDb().query(
    `UPDATE world_book_entries
     SET vector_index_status = ?, vector_indexed_at = ?, vector_index_error = ?
     WHERE id = ?`
  ).run(status, indexedAt, error, entryId);
  if (!exists) {
    console.warn(`[embeddings] World-book vector status update matched no entry: id=${entryId}, status=${status}`);
  }
}

function updateWorldBookEntriesVectorState(
  entryIds: string[],
  status: WorldBookVectorIndexStatus,
  indexedAt: number | null,
  error: string | null,
): void {
  if (entryIds.length === 0) return;
  const placeholders = entryIds.map(() => "?").join(", ");
  const matched = getDb().query(
    `SELECT COUNT(*) AS count FROM world_book_entries WHERE id IN (${placeholders})`
  ).get(...entryIds) as { count: number };
  getDb().query(
    `UPDATE world_book_entries
     SET vector_index_status = ?, vector_indexed_at = ?, vector_index_error = ?
     WHERE id IN (${placeholders})`
  ).run(status, indexedAt, error, ...entryIds);
  if ((matched.count ?? 0) !== entryIds.length) {
    console.warn(`[embeddings] World-book vector batch status update matched ${matched.count ?? 0}/${entryIds.length} entries (status=${status})`);
  }
}

function isEligibleWorldBookEntry(entry: WorldBookEntry): boolean {
  return isWorldBookEntryVectorEligible(entry);
}

function buildWorldBookEmbeddingRows(
  userId: string,
  entry: WorldBookEntry,
  chunks: Array<{ chunkIndex: number; content: string; searchText: string; chunkCount: number }>,
  vectors: number[][],
  now: number,
): EmbeddingRow[] {
  return chunks.map((chunk, idx) => ({
    id: rowId(userId, "world_book_entry", entry.id, chunk.chunkIndex),
    user_id: userId,
    source_type: "world_book_entry",
    source_id: entry.id,
    owner_id: entry.world_book_id,
    chunk_index: chunk.chunkIndex,
    content: chunk.content,
    vector: vectors[idx],
    metadata_json: JSON.stringify(buildWorldBookEmbeddingMetadata(entry, chunk.searchText, chunk.chunkIndex, chunk.chunkCount)),
    updated_at: now,
  }));
}

type WorldBookVectorTrackedEntry = Pick<
  WorldBookEntry,
  "id" | "world_book_id" | "content" | "comment" | "key" | "keysecondary" | "vectorized" | "disabled" | "updated_at"
>;

function parseTrackedKeywordArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((item) => typeof item === "string" ? item : "");
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((item) => typeof item === "string" ? item : "") : [];
  } catch {
    return [];
  }
}

function rowToTrackedWorldBookEntry(row: any): WorldBookVectorTrackedEntry {
  return {
    id: String(row.id),
    world_book_id: String(row.world_book_id || ""),
    content: String(row.content || ""),
    comment: String(row.comment || ""),
    key: parseTrackedKeywordArray(row.key),
    keysecondary: parseTrackedKeywordArray(row.keysecondary),
    vectorized: !!row.vectorized,
    disabled: !!row.disabled,
    updated_at: Number(row.updated_at ?? 0),
  };
}

function loadTrackedWorldBookEntriesForWrite(userId: string, entryIds: string[]): Map<string, WorldBookVectorTrackedEntry> {
  if (entryIds.length === 0) return new Map();
  const placeholders = entryIds.map(() => "?").join(", ");
  const rows = getDb().query(
    `SELECT e.id, e.world_book_id, e.content, e.comment, e.key, e.keysecondary, e.vectorized, e.disabled, e.updated_at
     FROM world_book_entries e
     JOIN world_books w ON w.id = e.world_book_id
     WHERE w.user_id = ? AND e.id IN (${placeholders})`
  ).all(userId, ...entryIds) as any[];
  return new Map(rows.map((row) => {
    const tracked = rowToTrackedWorldBookEntry(row);
    return [tracked.id, tracked] as const;
  }));
}

async function filterCurrentWorldBookEntriesForWrite(
  userId: string,
  entries: WorldBookEntry[],
  settingsFingerprint: string,
  configFingerprint: string,
): Promise<WorldBookEntry[]> {
  if (entries.length === 0) return [];
  try {
    const currentConfigFingerprint = getWorldBookVectorWriteFingerprint(await getEmbeddingConfig(userId));
    if (currentConfigFingerprint !== configFingerprint) return [];
  } catch (err) {
    console.warn("[embeddings] Failed to verify current world-book embedding config before write:", err);
    return [];
  }
  const currentSettingsFingerprint = worldBookVectorSettingsFingerprint(loadWorldBookVectorSettings(userId));
  if (currentSettingsFingerprint !== settingsFingerprint) return [];

  const currentEntries = loadTrackedWorldBookEntriesForWrite(userId, entries.map((entry) => entry.id));
  return entries.filter((entry) => {
    const current = currentEntries.get(entry.id);
    return !!current && worldBookVectorTrackingFingerprint(current) === worldBookVectorTrackingFingerprint(entry);
  });
}

export async function markWorldBookEntriesVectorErrorIfCurrent(
  userId: string,
  entries: WorldBookEntry[],
  error: string,
  settingsFingerprint: string,
  configFingerprint: string,
): Promise<number> {
  const stableEntries = await filterCurrentWorldBookEntriesForWrite(userId, entries, settingsFingerprint, configFingerprint);
  if (stableEntries.length === 0) return 0;
  const stableIds = stableEntries.map((entry) => entry.id);
  try {
    await deleteWorldBookEntryEmbeddingsBatch(userId, stableIds);
  } catch (err) {
    console.warn("[embeddings] Failed to delete stale world-book vectors while marking error:", err);
  }
  updateWorldBookEntriesVectorState(stableIds, "error", null, error);
  return stableIds.length;
}

export async function syncWorldBookEntryEmbedding(userId: string, entry: WorldBookEntry): Promise<void> {
  await ensureWorldBookVectorVersion(userId);
  const desiredStatus = getDesiredWorldBookVectorStatus(entry);
  if (!entry.vectorized) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, desiredStatus, null, null);
    return;
  }

  const cfg = await getEmbeddingConfig(userId);
  const configFingerprint = getWorldBookVectorWriteFingerprint(cfg);
  const worldBookSettings = loadWorldBookVectorSettings(userId, {
    retrievalTopK: cfg.retrieval_top_k,
  });
  const settingsFingerprint = worldBookVectorSettingsFingerprint(worldBookSettings);
  const chunks = buildWorldBookEntryEmbeddingChunks(entry, worldBookSettings);
  if (!cfg.enabled || !cfg.vectorize_world_books || entry.disabled || chunks.length === 0) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, "not_enabled", null, null);
    return;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const vectors = await cachedEmbedTexts(userId, chunks.map((chunk) => chunk.searchText));
    const [stableEntry] = await filterCurrentWorldBookEntriesForWrite(userId, [entry], settingsFingerprint, configFingerprint);
    if (!stableEntry) {
      console.info("[embeddings] Skipping stale world-book vector write for entry=%s", entry.id.slice(0, 8));
      return;
    }
    const rows = buildWorldBookEmbeddingRows(userId, stableEntry, chunks, vectors, now);

    await deleteWorldBookEntryRows(userId, [stableEntry.id]);
    await upsertStoreRows("embeddings_world_books", rows);

    updateWorldBookEntryVectorState(stableEntry.id, "indexed", now, null);
    await scheduleStoreOptimize("world_book");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vector indexing failed";
    await markWorldBookEntriesVectorErrorIfCurrent(userId, [entry], message, settingsFingerprint, configFingerprint);
    throw err;
  }
}

export async function reindexWorldBookEntries(
  userId: string,
  entries: WorldBookEntry[],
  options?: {
    batchSize?: number;
    force?: boolean;
    optimizeAfter?: boolean;
    rebuildVectorIndex?: boolean;
    onProgress?: (progress: WorldBookReindexProgress) => void;
  }
) : Promise<WorldBookReindexResult> {
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? 50, 200));
  const force = options?.force ?? false;
  const optimizeAfter = options?.optimizeAfter ?? true;
  const rebuildVectorIndex = options?.rebuildVectorIndex ?? optimizeAfter;
  const progress: WorldBookReindexProgress = {
    total: entries.length,
    current: 0,
    eligible: 0,
    indexed: 0,
    removed: 0,
    skipped_not_enabled: 0,
    skipped_disabled_or_empty: 0,
    failed: 0,
  };
  const emitProgress = () => {
    if (!options?.onProgress) return;
    try {
      options.onProgress({ ...progress });
    } catch (err) {
      console.warn("[embeddings] Progress callback failed:", err);
    }
  };
  const toIndex: WorldBookEntry[] = [];
  const notEnabled: WorldBookEntry[] = [];
  const disabledOrEmpty: WorldBookEntry[] = [];
  const alreadyIndexed: WorldBookEntry[] = [];

  for (const entry of entries) {
    if (!force && entry.vector_index_status === "indexed") {
      alreadyIndexed.push(entry);
      progress.skipped_not_enabled += 1;
    } else if (!entry.vectorized) {
      notEnabled.push(entry);
      progress.skipped_not_enabled += 1;
    } else if (!isEligibleWorldBookEntry(entry)) {
      disabledOrEmpty.push(entry);
      progress.skipped_disabled_or_empty += 1;
    } else {
      toIndex.push(entry);
    }
  }
  progress.eligible = toIndex.length;

  for (const entry of notEnabled) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, "not_enabled", null, null);
    progress.removed += 1;
    progress.current += 1;
    emitProgress();
  }

  for (const entry of disabledOrEmpty) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, "not_enabled", null, null);
    progress.removed += 1;
    progress.current += 1;
    emitProgress();
  }

  for (const entry of alreadyIndexed) {
    progress.current += 1;
    emitProgress();
  }

  const cfg = await getEmbeddingConfig(userId);
  const configFingerprint = getWorldBookVectorWriteFingerprint(cfg);
  if (!cfg.enabled || !cfg.vectorize_world_books) {
    for (const entry of toIndex) {
      await deleteWorldBookEntryEmbeddings(userId, entry.id);
      updateWorldBookEntryVectorState(entry.id, "not_enabled", null, null);
      progress.removed += 1;
      progress.current += 1;
      emitProgress();
    }
    return progress;
  }

  await ensureWorldBookVectorVersion(userId);
  const worldBookSettings = loadWorldBookVectorSettings(userId, {
    retrievalTopK: cfg.retrieval_top_k,
  });
  const settingsFingerprint = worldBookVectorSettingsFingerprint(worldBookSettings);
  const allEntryGroups = toIndex.map((entry) => ({
    entry,
    chunks: buildWorldBookEntryEmbeddingChunks(entry, worldBookSettings),
  }));
  const entryGroups = allEntryGroups.filter((group) => group.chunks.length > 0);
  const emptiedEntries = allEntryGroups.filter((group) => group.chunks.length === 0);
  progress.eligible = entryGroups.length;

  for (const group of emptiedEntries) {
    await deleteWorldBookEntryEmbeddings(userId, group.entry.id);
    updateWorldBookEntryVectorState(group.entry.id, "not_enabled", null, null);
    progress.removed += 1;
    progress.current += 1;
    emitProgress();
  }

  const processGroupBatch = async (
    groups: Array<{ entry: WorldBookEntry; chunks: Array<{ chunkIndex: number; content: string; searchText: string; chunkCount: number }> }>,
    currentSize: number,
  ): Promise<void> => {
    if (groups.length === 0) return;
    const payloads = groups.flatMap((group) => group.chunks.map((chunk) => ({ entry: group.entry, chunk })));
    try {
      const vectors = await cachedEmbedTexts(userId, payloads.map((payload) => payload.chunk.searchText));
      const now = Math.floor(Date.now() / 1000);
      const vectorSlices = new Map<string, number[][]>();
      let offset = 0;
      for (const group of groups) {
        const slice = vectors.slice(offset, offset + group.chunks.length);
        vectorSlices.set(group.entry.id, slice);
        offset += group.chunks.length;
      }

      const stableEntries = await filterCurrentWorldBookEntriesForWrite(
        userId,
        groups.map((group) => group.entry),
        settingsFingerprint,
        configFingerprint,
      );
      const stableIds = new Set(stableEntries.map((entry) => entry.id));
      const stableGroups = groups.filter((group) => stableIds.has(group.entry.id));
      if (stableGroups.length === 0) {
        console.info("[embeddings] Skipping stale world-book reindex batch of %d entr%s", groups.length, groups.length === 1 ? "y" : "ies");
        progress.current += groups.length;
        emitProgress();
        return;
      }
      if (stableGroups.length !== groups.length) {
        console.info(
          "[embeddings] Skipping %d stale world-book entr%s during reindex batch",
          groups.length - stableGroups.length,
          groups.length - stableGroups.length === 1 ? "y" : "ies",
        );
      }

      const rows: EmbeddingRow[] = [];
      for (const group of stableGroups) {
        rows.push(...buildWorldBookEmbeddingRows(
          userId,
          group.entry,
          group.chunks,
          vectorSlices.get(group.entry.id) ?? [],
          now,
        ));
      }

      await deleteWorldBookEntryRows(userId, stableGroups.map((group) => group.entry.id));
      await upsertStoreRows("embeddings_world_books", rows);

      updateWorldBookEntriesVectorState(stableGroups.map((group) => group.entry.id), "indexed", now, null);
      progress.indexed += stableGroups.length;
      progress.current += groups.length;
      emitProgress();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (isRetryableBatchError(error) && currentSize > 1) {
        const half = Math.max(1, Math.floor(currentSize / 2));
        console.warn(
          `[embeddings] WB reindex: batch of ${groups.length} failed (${error.message}); retrying in sub-batches of ${half}`,
        );
        for (let i = 0; i < groups.length; i += half) {
          await processGroupBatch(groups.slice(i, i + half), half);
        }
        return;
      }
      console.warn("[embeddings] Batch embedding failed:", error);
      const failed = await markWorldBookEntriesVectorErrorIfCurrent(
        userId,
        groups.map((group) => group.entry),
        error.message,
        settingsFingerprint,
        configFingerprint,
      );
      progress.failed += failed;
      progress.current += groups.length;
      emitProgress();
    }
  };

  for (let i = 0; i < entryGroups.length; i += batchSize) {
    await processGroupBatch(entryGroups.slice(i, i + batchSize), batchSize);
  }

  // Compact all fragments into fewer files, prune old versions, and optionally
  // rebuild the vector index. Automatic edit indexing uses deferred maintenance
  // so a burst of edited entries does not repeatedly rewrite a large index.
  if (optimizeAfter) {
    try {
      const store = await getActiveVectorStore();
      if (rebuildVectorIndex) getTableState(WORLD_BOOK_EMBEDDINGS_TABLE).vectorIndexReady = false;
      await store.optimize(["embeddings_world_books"]);
    } catch (err) {
      console.warn("[embeddings] Post-reindex optimize failed:", err);
    }
  } else {
    await scheduleStoreOptimize("world_book");
  }

  return progress;
}

export async function searchWorldBookEntries(
  userId: string,
  worldBookId: string,
  query: string,
  limit = 8
): Promise<Array<{ entry_id: string; score: number; content: string }>> {
  const cfg = await getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_world_books) return [];
  const text = query.trim();
  if (!text) return [];

  const [vector] = await cachedEmbedTexts(userId, [text]);
  const rows = await searchWorldBookEntriesHybridWithVector(userId, worldBookId, text, vector, limit, cfg.hybrid_weight_mode);
  return rows.map((row) => ({
    entry_id: row.entry_id,
    score: row.distance,
    content: row.content,
  }));
}

/**
 * Search world book entries using a pre-computed vector and optional query text,
 * returning enough metadata to rerank candidates deterministically.
 */
export async function searchWorldBookEntriesHybridWithVector(
  userId: string,
  worldBookId: string,
  queryText: string,
  vector: number[],
  requestedLimit = 8,
  hybridWeightMode?: EmbeddingConfig["hybrid_weight_mode"],
  signal?: AbortSignal,
  options?: { expandLimit?: boolean },
): Promise<WorldBookSearchCandidate[]> {
  await ensureWorldBookVectorVersion(userId);
  if (signal?.aborted) return [];

  const trimmedQuery = queryText.trim();
  const filter = ownerScope(userId, "world_book_entry", worldBookId);
  const finalLimit = Math.max(
    1,
    Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 8,
  );
  // Some callers (notably prompt assembly) already expand topK to a wider
  // candidate pool before calling this helper. Allow them to opt out of a
  // second 3x expansion so providers like Milvus do not multiply candidates at
  // multiple layers and turn an 8-hit request into a 72/200-hit search.
  const candidateLimit = options?.expandLimit === false
    ? finalLimit
    : Math.min(200, Math.max(finalLimit * 3, finalLimit));

  const store = await getActiveVectorStore();
  const nativeHybridSearch = store.hybridSearch?.bind(store);
  const canUseNativeHybrid = !!nativeHybridSearch && !!trimmedQuery && hybridWeightMode !== "vector_first" && store.capabilities.nativeLexical;
  let vectorRows = canUseNativeHybrid
    ? await nativeHybridSearch({
      collection: "embeddings_world_books",
      vector,
      queryText: trimmedQuery,
      filter,
      limit: candidateLimit,
      withVector: false,
      refine: true,
      signal,
    })
    : await store.vectorSearch({
      collection: "embeddings_world_books",
      vector,
      filter,
      limit: candidateLimit,
      withVector: false,
      refine: true,
      signal,
    });

  if (vectorRows.length === 0 && canUseNativeHybrid && !signal?.aborted) {
    try {
      const denseFallbackRows = await store.vectorSearch({
        collection: "embeddings_world_books",
        vector,
        filter,
        limit: candidateLimit,
        withVector: false,
        refine: true,
        signal,
      });
      if (denseFallbackRows.length > 0) {
        let recoveredRows = denseFallbackRows;
        if (trimmedQuery && store.capabilities.nativeLexical) {
          const lexicalRows = await store.lexicalSearch({
            collection: "embeddings_world_books",
            queryText: trimmedQuery,
            filter,
            limit: candidateLimit,
            withVector: false,
            signal,
          }).catch((err) => {
            console.warn(
              "[embeddings] WI lexical fallback failed after native hybrid miss for book=%s in provider=%s: %s",
              worldBookId.slice(0, 8),
              store.id,
              err instanceof Error ? err.message : String(err),
            );
            return [] as VectorHit[];
          });
          recoveredRows = reciprocalRankFusion(denseFallbackRows, lexicalRows).slice(0, candidateLimit);
        }
        vectorRows = recoveredRows;
        console.warn(
          "[embeddings] WI vector search: native hybrid returned 0 rows for book=%s (provider=%s, limit=%d); dense fallback recovered %d row(s)",
          worldBookId.slice(0, 8),
          store.id,
          finalLimit,
          vectorRows.length,
        );
      }
    } catch (err) {
      console.warn(
        "[embeddings] WI dense fallback failed after native hybrid miss for book=%s in provider=%s: %s",
        worldBookId.slice(0, 8),
        store.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (vectorRows.length === 0 && !signal?.aborted) {
    const fallback = await recoverWorldBookScopedRowsFromStore(
      store,
      filter,
      vector,
      candidateLimit,
      trimmedQuery,
      signal,
    );

    if (fallback.scopedRowCount > 0) {
      vectorRows = fallback.hits;
      console.warn(
        "[embeddings] WI vector search returned 0 direct rows for book=%s (provider=%s, limit=%d) but %d scoped row(s) exist; row-scan fallback recovered %d row(s)%s",
        worldBookId.slice(0, 8),
        store.id,
        finalLimit,
        fallback.scopedRowCount,
        vectorRows.length,
        fallback.truncated ? ` (scan capped at ${WORLD_BOOK_ROW_SCAN_FALLBACK_LIMIT})` : "",
      );
    } else {
      console.log(
        "[embeddings] WI vector search: 0 rows from vector store for book=%s (limit=%d, provider=%s)",
        worldBookId.slice(0, 8),
        finalLimit,
        store.id,
      );
    }
  }

  const merged = new Map<string, WorldBookSearchCandidate>();

  for (const row of vectorRows) {
    const metadata = parseWorldBookEmbeddingMetadata(row.metadata_json);
    const entryId = String(row.source_id);
    const distance = distanceFromSimilarity(row.similarity);
    const existing = merged.get(entryId);
    if (!existing || distance < existing.distance) {
      merged.set(entryId, {
        entry_id: entryId,
        distance,
        lexical_score: existing?.lexical_score ?? null,
        content: String(row.content || ""),
        searchTextPreview: typeof metadata.search_text === "string" ? metadata.search_text : existing?.searchTextPreview || "",
        metadata: { ...(existing?.metadata ?? {}), ...metadata },
      });
    }
  }

  if (!canUseNativeHybrid && trimmedQuery && hybridWeightMode !== "vector_first" && store.capabilities.nativeLexical && !signal?.aborted) {
    try {
      const lexicalRows = await store.lexicalSearch({
        collection: "embeddings_world_books",
        queryText: trimmedQuery,
        filter,
        limit: candidateLimit,
        withVector: false,
        signal,
      });

      for (const row of lexicalRows) {
        const entryId = String(row.source_id);
        const metadata = parseWorldBookEmbeddingMetadata(row.metadata_json);
        const lexicalScore = row.lexicalScore;
        const existing = merged.get(entryId);

        if (existing) {
          if (lexicalScore !== null && (existing.lexical_score === null || lexicalScore > existing.lexical_score)) {
            existing.lexical_score = lexicalScore;
          }
          if (!existing.searchTextPreview && typeof metadata.search_text === "string") {
            existing.searchTextPreview = metadata.search_text;
          }
          if ((!existing.content || existing.content.length === 0) && typeof row.content === "string") {
            existing.content = row.content;
          }
          if (!existing.metadata.search_text && metadata.search_text) {
            existing.metadata = { ...existing.metadata, ...metadata };
          }
        } else {
          merged.set(entryId, {
            entry_id: entryId,
            distance: Number.POSITIVE_INFINITY,
            lexical_score: lexicalScore,
            content: String(row.content || ""),
            searchTextPreview: typeof metadata.search_text === "string" ? metadata.search_text : "",
            metadata,
          });
        }
      }
    } catch (err) {
      if (!signal?.aborted && (err as any)?.name !== "AbortError") {
        console.warn("[embeddings] World-book FTS candidate fetch failed:", err);
      }
    }
  }

  return Array.from(merged.values())
    .sort((a, b) => {
      if (a.distance !== b.distance) return a.distance - b.distance;
      return (b.lexical_score ?? Number.NEGATIVE_INFINITY) - (a.lexical_score ?? Number.NEGATIVE_INFINITY);
    })
    .slice(0, finalLimit);
}

async function recoverWorldBookScopedRowsFromStore(
  store: Awaited<ReturnType<typeof getActiveVectorStore>>,
  filter: VectorFilter,
  queryVector: number[],
  limit: number,
  queryText: string,
  signal?: AbortSignal,
): Promise<{ hits: VectorHit[]; scopedRowCount: number; truncated: boolean }> {
  const scopedRowCount = await store.countRows("embeddings_world_books", filter).catch(() => 0);
  if (scopedRowCount <= 0 || signal?.aborted) {
    return { hits: [], scopedRowCount, truncated: false };
  }

  const scanLimit = Math.min(
    WORLD_BOOK_ROW_SCAN_FALLBACK_LIMIT,
    Math.max(limit, scopedRowCount),
  );
  const storedRows = await store.getRowsByFilter(
    "embeddings_world_books",
    filter,
    scanLimit,
  ).catch(() => [] as VectorRow[]);

  const denseHits = storedRows
    .filter((row) => row.vector.length === queryVector.length && row.vector.length > 0)
    .map((row) => ({
      id: row.id,
      source_id: row.source_id,
      content: row.content,
      metadata_json: row.metadata_json,
      similarity: cosineSimilarity(queryVector, row.vector),
      lexicalScore: null,
      vector: null,
    } satisfies VectorHit))
    .sort((a, b) => (b.similarity ?? Number.NEGATIVE_INFINITY) - (a.similarity ?? Number.NEGATIVE_INFINITY))
    .slice(0, limit);

  if (!queryText || !store.capabilities.nativeLexical || signal?.aborted) {
    return {
      hits: denseHits,
      scopedRowCount,
      truncated: scopedRowCount > scanLimit,
    };
  }

  const lexicalHits = await store.lexicalSearch({
    collection: "embeddings_world_books",
    queryText,
    filter,
    limit,
    withVector: false,
    signal,
  }).catch(() => [] as VectorHit[]);

  return {
    hits: reciprocalRankFusion(denseHits, lexicalHits).slice(0, limit),
    scopedRowCount,
    truncated: scopedRowCount > scanLimit,
  };
}

/**
 * Search world book entries using a pre-computed vector, skipping the embedding step.
 */
export async function searchWorldBookEntriesWithVector(
  userId: string,
  worldBookId: string,
  vector: number[],
  limit = 8
): Promise<Array<{ entry_id: string; score: number; content: string }>> {
  const rows = await searchWorldBookEntriesHybridWithVector(userId, worldBookId, "", vector, limit, "vector_first");
  return rows.map((row) => ({
    entry_id: row.entry_id,
    score: row.distance,
    content: row.content,
  }));
}

/**
 * Invalidate all vectors for a user when their embedding model changes.
 * Clears in-memory cache, deletes LanceDB rows, and resets index state while
 * preserving semantic opt-in.
 */
export async function invalidateAllVectors(userId: string): Promise<void> {
  embeddingCache.clear();

  try {
    await Promise.all([
      deleteStoreRows("embeddings", eq("user_id", userId)),
      deleteStoreRows("embeddings_world_books", eq("user_id", userId)),
    ]);
  } catch (err) {
    console.warn("[embeddings] Failed to delete vector rows during invalidation:", err);
  }

  try {
    const db = getDb();
    db.run(
      `UPDATE world_book_entries
       SET vector_index_status = ${worldBookVectorDesiredStatusSql()},
           vector_indexed_at = NULL,
           vector_index_error = NULL
       WHERE world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)`,
      [userId]
    );
  } catch (err) {
    console.warn("[embeddings] Failed to reset world book vector index state:", err);
  }

  settingsSvc.putSetting(userId, WORLD_BOOK_VECTOR_VERSION_KEY, WORLD_BOOK_VECTOR_VERSION);
  worldBookVectorVersionChecked.add(getWorldBookVectorVersionCacheKey(userId));

  for (const tableName of [EMBEDDINGS_TABLE, WORLD_BOOK_EMBEDDINGS_TABLE]) {
    const state = getTableState(tableName);
    state.vectorIndexReady = false;
    state.scalarIndexReady = false;
    state.ftsIndexReady = false;
    state.lastIndexRebuildAt = 0;
    state.unindexedRowEstimate = 0;
  }
  stopIndexHealthMonitor();
}

/**
 * Drop every LanceDB vector belonging to a user. Used by user-purge so the
 * embeddings tables don't keep rows pointing at a tombstoned user_id. Does not
 * touch SQLite or settings — caller is responsible for the surrounding wipe.
 */
export async function deleteUserVectors(userId: string): Promise<void> {
  embeddingCache.clear();
  worldBookVectorVersionChecked.delete(getWorldBookVectorVersionCacheKey(userId));

  try {
    await Promise.all([
      deleteStoreRows("embeddings", eq("user_id", userId)),
      deleteStoreRows("embeddings_world_books", eq("user_id", userId)),
    ]);
  } catch (err) {
    console.warn(`[embeddings] Failed to delete vector rows for user ${userId}:`, err);
  }
}

function markAllVectorStateStaleAfterReset(): void {
  embeddingCache.clear();
  worldBookVectorVersionChecked.clear();

  const db = getDb();
  try {
    db.transaction(() => {
      db.run(
        `UPDATE world_book_entries
         SET vector_index_status = ${worldBookVectorDesiredStatusSql()},
             vector_indexed_at = NULL,
             vector_index_error = NULL`
      );
      db.run("UPDATE chat_chunks SET vectorized_at = NULL, vector_model = NULL");
      db.run("UPDATE databank_chunks SET vectorized_at = NULL, vector_model = NULL");
      db.run("UPDATE memory_consolidations SET vectorized_at = NULL, vector_model = NULL");
      db.run("DELETE FROM query_vector_cache");
      db.run("DELETE FROM chat_memory_cache");
    })();
  } catch (err) {
    console.warn("[embeddings] Failed to mark vector state stale after reset:", err);
  }

  for (const tableName of [EMBEDDINGS_TABLE, WORLD_BOOK_EMBEDDINGS_TABLE]) {
    const state = getTableState(tableName);
    state.vectorIndexReady = false;
    state.scalarIndexReady = false;
    state.ftsIndexReady = false;
    state.lastIndexRebuildAt = 0;
    state.unindexedRowEstimate = 0;
  }
  stopIndexHealthMonitor();
}

/**
 * Force reset the entire vector store.
 * Nukes the on-disk LanceDB directory, resets all module state, clears caches,
 * and resets vector index state in SQLite. This is the nuclear option for
 * recovering from corruption (e.g. "vector not divisible by 8" errors).
 *
 * Delegates to the active vector store's `reset()`. Keeps the historical name +
 * `{ deleted, path }` return shape so existing callers don't change.
 */
export async function forceResetLanceDB(): Promise<{ deleted: boolean; path: string }> {
  const store = await getActiveVectorStore();
  const { deleted, location } = await store.reset();
  markAllVectorStateStaleAfterReset();
  const { queueStaleChatChunkVectorization } = await import("./vectorization-queue.service");
  await queueStaleChatChunkVectorization().catch((err) => {
    console.warn("[embeddings] Failed to queue stale chat chunks after vector reset:", err);
  });
  return { deleted, path: location };
}

// --- Chat Vectorization ---

export async function deleteChatChunkEmbeddings(
  userId: string,
  chatId: string,
  chunkIds?: string | string[],
): Promise<void> {
  const idList = chunkIds === undefined
    ? null
    : (Array.isArray(chunkIds) ? chunkIds : [chunkIds]);
  if (idList && idList.length === 0) return;

  await deleteStoreRows("embeddings", andFilter([
    ownerScope(userId, "chat_chunk", chatId),
    idList ? inSet("source_id", idList) : null,
  ]));
  await scheduleStoreOptimize("chat_chunk");
}

/**
 * Delete chat-chunk vectors whose source_id is no longer a live chunk.
 * Chunk rebuilds mint fresh chunk UUIDs and clear the chat's vectors up
 * front, but the vectorization queue writes asynchronously — a batch that
 * was mid-flight during a rebuild can land its vectors *after* that delete,
 * leaving orphans keyed to chunk UUIDs that no longer exist. Those orphans
 * carry the same content as the rebuilt chunks, so retrieval surfaces them
 * as duplicate memory-injection entries. This reconciles LanceDB against the
 * authoritative chat_chunks set and removes the strays.
 *
 * `validChunkIds` MUST be the current chat_chunks ids. An empty set is
 * treated as "unknown" and skipped so we never wipe a chat that is mid-
 * rebuild (between its DELETE and its re-insert).
 */
export async function reconcileChatChunkEmbeddings(
  userId: string,
  chatId: string,
  validChunkIds: Iterable<string>,
): Promise<number> {
  const valid = new Set(validChunkIds);
  if (valid.size === 0) return 0;

  const store = await getActiveVectorStore();
  const rows = await store.getRowsByFilter("embeddings", ownerScope(userId, "chat_chunk", chatId));

  const orphanIds = Array.from(
    new Set((rows as any[]).map((r) => String(r.source_id)).filter((id) => !valid.has(id))),
  );
  if (orphanIds.length === 0) return 0;

  await deleteChatChunkEmbeddings(userId, chatId, orphanIds);
  console.info(`[embeddings] Reconciled chat ${chatId.split("-")[0]}…: removed ${orphanIds.length} orphaned chunk vector(s)`);
  return orphanIds.length;
}

export async function syncChatChunkEmbedding(
  userId: string,
  chatId: string,
  chunkId: string,
  content: string,
  metadata?: Record<string, any>
): Promise<void> {
  const cfg = await getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_chat_messages) {
    await deleteChatChunkEmbeddings(userId, chatId, chunkId);
    return;
  }
  
  const text = content.trim();
  if (!text) {
    await deleteChatChunkEmbeddings(userId, chatId, chunkId);
    return;
  }

  const baseMetadata = {
    chunkId,
    messageIds: loadChatChunkMessageIds(chunkId),
    ...(metadata || {}),
  };
  const leaves = await embedChatChunkContentLeaves(userId, text);
  if (leaves.length === 0) return;
  const rows = buildChatChunkEmbeddingRows(
    userId,
    chatId,
    chunkId,
    text,
    leaves,
    baseMetadata,
  );
  await replaceChatChunkEmbeddingRows(userId, [{ chatId, chunkId }], rows);

  console.info(
    `[embeddings] Vectorized chat chunk ${chunkId} for chat ${chatId}${rows.length > 1 ? ` (${rows.length} split rows)` : ""}`,
  );

  await scheduleStoreOptimize("chat_chunk");
}

/**
 * Batch upsert multiple chunk vectors in a single mergeInsert call.
 * Avoids creating one Lance fragment per chunk (the main cause of slow queries
 * after accumulating tens of thousands of embeddings via individual upserts).
 */
export async function batchUpsertChunkVectors(
  userId: string,
  chunks: Array<{ chatId: string; chunkId: string; vector: number[]; content: string; metadata?: Record<string, any> }>,
): Promise<void> {
  if (chunks.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const rows: EmbeddingRow[] = chunks.flatMap((c) => buildChatChunkEmbeddingRows(
    userId,
    c.chatId,
    c.chunkId,
    c.content,
    [{ content: c.content, vector: c.vector }],
    { chunkId: c.chunkId, ...(c.metadata || {}) },
    now,
  ));

  await replaceChatChunkEmbeddingRows(
    userId,
    chunks.map((chunk) => ({ chatId: chunk.chatId, chunkId: chunk.chunkId })),
    rows,
  );

  console.info(`[embeddings] Batch-vectorized ${rows.length} chat chunk(s)`);
  await scheduleStoreOptimize("chat_chunk");
}

async function getExistingChatChunks(userId: string, chatId: string): Promise<Record<string, string>> {
  const store = await getActiveVectorStore();
  const rows = await store.getRowsByFilter("embeddings", ownerScope(userId, "chat_chunk", chatId));
  const map: Record<string, string> = {};
  for (const r of rows) {
    const meta = parseChatChunkEmbeddingMetadata(r.metadata_json);
    map[r.source_id] = typeof meta.sourceContentHash === "string" && meta.sourceContentHash.length > 0
      ? meta.sourceContentHash
      : hashChatChunkContent(r.content);
  }
  return map;
}

export async function reindexChatMessages(
  userId: string,
  chatId: string,
  chunks: Array<{ chunkId: string; content: string; metadata?: Record<string, any> }>
): Promise<void> {
  const cfg = await getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_chat_messages) {
    // If disabled, just ensure it's wiped
    await deleteChatChunkEmbeddings(userId, chatId);
    return;
  }

  const validChunks = chunks.filter(c => c.content.trim().length > 0);
  
  // Smart Diffing: Query LanceDB for the chunks we already know about.
  const existingChunks = await getExistingChatChunks(userId, chatId);
  const chunksToUpsert: Array<{ chunkId: string; content: string; metadata?: Record<string, any> }> = [];
  const validChunkIds = new Set<string>();

  // 1. Find chunks that are entirely new OR have changed content.
  for (const chunk of validChunks) {
    validChunkIds.add(chunk.chunkId);
    const existingContentHash = existingChunks[chunk.chunkId];
    if (existingContentHash !== hashChatChunkContent(chunk.content.trim())) {
      chunksToUpsert.push(chunk);
    }
  }

  // 2. Find "orphaned" chunks.
  const chunksToDelete: string[] = [];
  for (const existingId of Object.keys(existingChunks)) {
    if (!validChunkIds.has(existingId)) {
      chunksToDelete.push(existingId);
    }
  }

  // Delete orphaned chunks in a single call (the helper accepts a string[]).
  if (chunksToDelete.length > 0) {
    await deleteChatChunkEmbeddings(userId, chatId, chunksToDelete);
  }

  const batchSize = Math.max(1, Math.min(cfg.batch_size, 200));
  await embedWithAdaptiveBatching(
    userId,
    chunksToUpsert,
    batchSize,
    (c) => c.content.trim(),
    async (batch, _texts, vectors) => {
      const now = Math.floor(Date.now() / 1000);
      const rows: EmbeddingRow[] = batch.flatMap((c, idx) => buildChatChunkEmbeddingRows(
        userId,
        chatId,
        c.chunkId,
        c.content,
        [{ content: c.content, vector: vectors[idx] }],
        { chunkId: c.chunkId, ...(c.metadata || {}) },
        now,
      ));

      await replaceChatChunkEmbeddingRows(
        userId,
        batch.map((chunk) => ({ chatId, chunkId: chunk.chunkId })),
        rows,
      );
    },
    async (failedBatch, err) => {
      if (failedBatch.length === 1) {
        const [failed] = failedBatch;
        const recovered = await tryRecoverChatChunkEmbeddingWithAutoSplit(
          userId,
          chatId,
          failed.chunkId,
          failed.content,
          err,
          { chunkId: failed.chunkId, ...(failed.metadata || {}) },
        );
        if (recovered.recovered) return;
      }
      console.warn("[embeddings] Batch chat embedding failed:", err);
    },
    { label: "chat memory" },
  );

  if (chunksToDelete.length > 0 || chunksToUpsert.length > 0) {
    console.info(`[embeddings] Synced chat memory for ${chatId.split('-')[0]}... (+${chunksToUpsert.length} updated, -${chunksToDelete.length} removed)`);
  }

  await scheduleStoreOptimize("chat_chunk");
}

export async function searchChatChunks(
  userId: string,
  chatId: string,
  vector: number[],
  excludeIds: Set<string>,
  requestedLimit = 8,
  queryText?: string,
  hybridWeightMode?: "keyword_first" | "balanced" | "vector_first",
  allowedChunkIds?: Set<string>,
  signal?: AbortSignal,
  options?: { skipVectorFetch?: boolean },
): Promise<Array<{ chunk_id: string; score: number | null; content: string; metadata: any }>> {
  if (signal?.aborted) return [];

  const skipVectorFetch = options?.skipVectorFetch === true;

  // Resolve excluded message IDs to chunk IDs so the store can filter at the
  // storage layer instead of us over-fetching and post-discarding. Massive
  // payload reduction when the exclusion set actually overlaps cached chunks.
  const excludedChunkIds = excludeIds.size > 0
    ? resolveExcludedChunkIds(chatId, excludeIds)
    : null;

  // sourceIdsIn / sourceIdsNotIn return null when the candidate set exceeds
  // MAX_SOURCE_FILTER_IDS; the query then searches the whole chat partition and
  // we client-side filter (preserving the historical filterWasScoped path).
  const allowedClause = allowedChunkIds && allowedChunkIds.size > 0
    ? sourceIdsIn(allowedChunkIds)
    : null;
  const excludedClause = excludedChunkIds && excludedChunkIds.size > 0
    ? sourceIdsNotIn(excludedChunkIds)
    : null;
  const filterWasScoped = allowedClause != null || excludedClause != null;

  const filter = andFilter([
    ownerScope(userId, "chat_chunk", chatId),
    allowedClause,
    excludedClause,
  ]);

  // When the source filter was dropped (candidate set > MAX_SOURCE_FILTER_IDS),
  // the query searches the entire chat partition and results are client-side
  // filtered. Increase candidateLimit to compensate for post-filter loss, but skip
  // refineFactor since re-scanning 5x results on a large unscoped partition is
  // the biggest cost.
  const candidateLimit = filterWasScoped
    ? Math.max(1, Math.min(requestedLimit + 50, 150))
    : Math.max(1, Math.min(requestedLimit * 4, 300));

  // The vector column is only needed for MMR diversity selection downstream.
  // When the caller opts out, we skip the column entirely — that's the bulk of
  // the per-row payload on high-dim embeddings (3072 floats × 4 bytes = 12 KB
  // each) and Float32Array marshaling through Lance/Arrow has been a tender spot
  // in Bun 1.3.12+.
  const withVector = !skipVectorFetch;

  // Refine with full vectors after PQ approximate search for better accuracy.
  // Skip refineFactor for unscoped queries — prohibitive on large partitions.
  const refine = filterWasScoped;

  // Providers may expose native dense+sparse fusion (Milvus BM25). LanceDB keeps
  // the existing app-side split vector/FTS legs and RRF fusion.
  const useHybrid = !!queryText?.trim() && hybridWeightMode !== "vector_first";

  const store = await getActiveVectorStore();
  const nativeHybridSearch = store.hybridSearch?.bind(store);

  let hits: VectorHit[];
  if (useHybrid && store.capabilities.nativeLexical && nativeHybridSearch) {
    hits = await nativeHybridSearch({
      collection: "embeddings",
      queryText: queryText!.trim(),
      vector,
      filter,
      limit: candidateLimit,
      withVector,
      refine,
      signal,
    });
  } else if (useHybrid && store.capabilities.nativeLexical) {
    const searchOpts: SearchOptions = {
      collection: "embeddings",
      vector,
      filter,
      limit: candidateLimit,
      withVector,
      refine,
      signal,
    };
    const lexicalOpts: LexicalSearchOptions = {
      collection: "embeddings",
      queryText: queryText!.trim(),
      filter,
      limit: candidateLimit,
      withVector,
      signal,
    };
    const [vectorHits, lexicalHits] = await Promise.all([
      store.vectorSearch(searchOpts),
      store.lexicalSearch(lexicalOpts),
    ]);
    if (signal?.aborted) return [];
    hits = reciprocalRankFusion(vectorHits, lexicalHits);
  } else {
    hits = await store.vectorSearch({
      collection: "embeddings",
      vector,
      filter,
      limit: candidateLimit,
      withVector,
      refine,
      signal,
    });
  }
  hits = collapseVectorHitsBySourceId(hits);

  if (signal?.aborted) return [];

  // Parse metadata and collect chunks needing a message-id lookup.
  const parsed: Array<{ chunkId: string; meta: any; hit: VectorHit }> = [];
  const needMessageIdLookup: string[] = [];

  for (const hit of hits) {
    const chunkId = String(hit.source_id);
    let meta: any = {};
    try {
      meta = JSON.parse(hit.metadata_json || "{}");
    } catch {
      // Treat as empty metadata
    }

    parsed.push({ chunkId, meta, hit });
    if (!meta.messageIds || !Array.isArray(meta.messageIds)) {
      needMessageIdLookup.push(chunkId);
    }
  }

  // Batch-load message_ids for chunks missing them in metadata (replaces N+1 individual queries)
  const messageIdsByChunk = new Map<string, string[]>();
  if (needMessageIdLookup.length > 0) {
    const db = getDb();
    for (let i = 0; i < needMessageIdLookup.length; i += 500) {
      const batch = needMessageIdLookup.slice(i, i + 500);
      const placeholders = batch.map(() => "?").join(",");
      try {
        const chunkRows = db.query(`SELECT id, message_ids FROM chat_chunks WHERE id IN (${placeholders})`).all(...batch) as any[];
        for (const cr of chunkRows) {
          if (cr.message_ids) {
            try { messageIdsByChunk.set(cr.id, JSON.parse(cr.message_ids)); } catch { /* non-fatal */ }
          }
        }
      } catch { /* non-fatal */ }
    }
  }

  // Exclude and build candidate VectorHits (clip oversized content + carry
  // normalized similarity through to MMR).
  const candidates: VectorHit[] = [];
  for (const { chunkId, meta, hit } of parsed) {
    const chunkMessageIds: string[] = (meta.messageIds && Array.isArray(meta.messageIds))
      ? meta.messageIds
      : (messageIdsByChunk.get(chunkId) ?? []);

    const shouldExclude = chunkMessageIds.length > 0 && chunkMessageIds.some((id: string) => excludeIds.has(id));
    if (shouldExclude) continue;

    candidates.push({
      ...hit,
      content: clipOversizedChunkContent(hit.content, chunkId),
    });
  }

  if (candidates.length === 0) return [];

  // Apply MMR diversity selection on the canonical VectorHit list.
  const selected = mmrSelect(candidates, vector, requestedLimit, 0.7);

  // Adapt back to the historical distance-shaped contract: lexical-only hits
  // (similarity == null) keep score: null, otherwise distance = 1 - similarity.
  return selected.map((hit) => {
    let meta: any = {};
    try { meta = JSON.parse(hit.metadata_json || "{}"); } catch { /* empty */ }
    return {
      chunk_id: String(hit.source_id),
      score: hit.similarity == null ? null : distanceFromSimilarity(hit.similarity),
      content: hit.content,
      metadata: meta,
    };
  });
}

/** Resolve a set of excluded message IDs into the chunks that hold them.
 *  Returns null when nothing maps (so the caller can skip building a filter). */
function resolveExcludedChunkIds(chatId: string, excludedMessageIds: Set<string>): Set<string> | null {
  if (excludedMessageIds.size === 0) return null;
  const rows = getDb()
    .query("SELECT id, message_ids FROM chat_chunks WHERE chat_id = ?")
    .all(chatId) as Array<{ id: string; message_ids: string | null }>;
  const chunkIds = new Set<string>();
  for (const row of rows) {
    if (!row.message_ids) continue;
    let parsed: string[];
    try { parsed = JSON.parse(row.message_ids); } catch { continue; }
    for (const mid of parsed) {
      if (excludedMessageIds.has(mid)) {
        chunkIds.add(row.id);
        break;
      }
    }
  }
  return chunkIds.size > 0 ? chunkIds : null;
}

/**
 * Sanity ceiling for a single chunk's content after retrieval. A well-formed
 * chunk respects `chunkMaxTokens` (default 1600 ≈ 6.4 KB); anything over the
 * cap indicates a single oversized message overflowed the chunk and is
 * sitting in the candidate list with a payload large enough to stress
 * downstream string handling. Truncates with a marker so the prompt builder
 * gets a usable fragment instead of nothing.
 */
const MAX_CHUNK_CONTENT_CHARS = 65536;
function clipOversizedChunkContent(content: string, chunkId: string): string {
  if (content.length <= MAX_CHUNK_CONTENT_CHARS) return content;
  console.warn(
    `[embeddings] Clipping oversized chunk content (chat_chunks.id=${chunkId}, ${content.length} chars). `
      + `Consider lowering chunkMaxTokens or splitting the underlying message.`,
  );
  return `${content.slice(0, MAX_CHUNK_CONTENT_CHARS)}\n…[content clipped]`;
}

/**
 * Upsert a single chunk vector into LanceDB.
 * Used by the vectorization queue for incremental updates.
 */
export async function upsertChunkVector(
  userId: string,
  chatId: string,
  chunkId: string,
  vector: number[],
  content: string
): Promise<void> {
  const rows = buildChatChunkEmbeddingRows(
    userId,
    chatId,
    chunkId,
    content,
    [{ content, vector }],
    { chunkId, messageIds: loadChatChunkMessageIds(chunkId) },
  );
  await replaceChatChunkEmbeddingRows(userId, [{ chatId, chunkId }], rows);

  await scheduleStoreOptimize("chat_chunk");
}

/**
 * Delete a specific chunk's vector from LanceDB.
 */
export async function deleteChunkVector(userId: string, chunkId: string): Promise<void> {
  await deleteStoreRows("embeddings", andFilter([
    eq("user_id", userId),
    eq("source_type", "chat_chunk"),
    eq("source_id", chunkId),
  ]));
  await scheduleStoreOptimize("chat_chunk");
}

// ─── Vault Chunk Vector Operations ─────────────────────────────
// Vaults are self-contained salience sources. Their embedding rows live in
// the same LanceDB table with source_type='vault_chunk' and owner_id=vaultId.
// Copy-from-chat reuses existing chat_chunk vectors (no re-embedding cost),
// while rebuild-from-content handles recovery after forceResetLanceDB wipes
// the table out from under us.

/**
 * Copy chat_chunk LanceDB rows into vault_chunk rows for a new vault.
 * Reuses existing vectors — no re-embedding. `chunkIdMap` maps the source
 * chat_chunk id → the newly-minted cortex_vault_chunks row id.
 */
export async function copyChunksToVault(
  userId: string,
  sourceChatId: string,
  vaultId: string,
  chunkIdMap: Map<string, string>,
): Promise<{ copied: number }> {
  if (chunkIdMap.size === 0) return { copied: 0 };

  const sourceIds = [...chunkIdMap.keys()];
  const now = Math.floor(Date.now() / 1000);
  let copied = 0;
  const store = await getActiveVectorStore();

  // Read source rows in batches to avoid blowing up the filter string.
  for (let i = 0; i < sourceIds.length; i += 200) {
    const batch = sourceIds.slice(i, i + 200);
    const rows = await store.getRowsByFilter("embeddings", andFilter([
      ownerScope(userId, "chat_chunk", sourceChatId),
      inSet("source_id", batch),
    ]));

    const outRows: EmbeddingRow[] = [];
    for (const row of rows as any[]) {
      const sourceId = String(row.source_id);
      const vaultChunkId = chunkIdMap.get(sourceId);
      if (!vaultChunkId) continue;
      const vector = row.vector;
      if (!vector || vector.length === 0) continue;

      let meta: any = {};
      const rawMeta = row.metadata_json;
      try {
        if (typeof rawMeta === "string") meta = JSON.parse(rawMeta);
        else if (rawMeta && typeof rawMeta === "object") meta = rawMeta;
      } catch { /* ignore — use empty metadata */ }

      outRows.push({
        id: rowId(userId, "vault_chunk", vaultChunkId, Number(row.chunk_index ?? 0)),
        user_id: userId,
        source_type: "vault_chunk",
        source_id: vaultChunkId,
        owner_id: vaultId,
        chunk_index: Number(row.chunk_index ?? 0),
        content: String(row.content || ""),
        vector,
        metadata_json: JSON.stringify({ ...meta, sourceChatId, sourceChunkId: sourceId, vaultId }),
        updated_at: now,
      });
    }

    if (outRows.length === 0) continue;

    await upsertStoreRows("embeddings", outRows);
    copied += outRows.length;
  }

  if (copied > 0) await scheduleStoreOptimize();
  return { copied };
}

/**
 * Re-embed vault chunks from their stored content. Used when LanceDB was
 * reset (e.g. embedding config change) but the cortex_vault_chunks SQLite
 * rows survived. Caller passes (vaultChunkId, content) pairs.
 */
export async function rebuildVaultEmbeddings(
  userId: string,
  vaultId: string,
  chunks: Array<{ vaultChunkId: string; content: string }>,
): Promise<{ embedded: number }> {
  if (chunks.length === 0) return { embedded: 0 };

  const cfg = await getEmbeddingConfig(userId);
  if (!cfg.enabled) return { embedded: 0 };

  const valid = chunks.filter((c) => c.content.trim().length > 0);
  if (valid.length === 0) return { embedded: 0 };

  const batchSize = Math.max(1, Math.min(cfg.batch_size, 200));
  const embeddedChunkIds = new Set<string>();

  await embedWithAdaptiveBatching(
    userId,
    valid,
    batchSize,
    (c) => c.content.trim(),
    async (batch, _texts, vectors) => {
      const now = Math.floor(Date.now() / 1000);
      const rows: EmbeddingRow[] = batch.flatMap((c, idx) => buildVaultChunkEmbeddingRows(
        userId,
        vaultId,
        c.vaultChunkId,
        c.content,
        [{ content: c.content, vector: vectors[idx] }],
        { vaultId, rebuiltAt: now, vaultChunkId: c.vaultChunkId },
        now,
      ));

      await replaceVaultChunkEmbeddingRows(
        userId,
        vaultId,
        batch.map((chunk) => chunk.vaultChunkId),
        rows,
      );
      for (const chunk of batch) embeddedChunkIds.add(chunk.vaultChunkId);
    },
    async (failedBatch, err) => {
      if (failedBatch.length === 1) {
        const [chunk] = failedBatch;
        const sourceTokenCount = estimateChatChunkTokens(chunk.content.trim());
        console.warn("[embeddings] Terminal vault chunk rebuild failure:", {
          vaultChunkId: chunk.vaultChunkId,
          vaultId,
          sourceChars: chunk.content.length,
          sourceTokensApprox: sourceTokenCount,
          model: cfg.model,
          timeoutSeconds: cfg.request_timeout,
          error: err.message,
        });

        const recovered = await tryRecoverVaultChunkEmbeddingWithAutoSplit(
          userId,
          vaultId,
          chunk.vaultChunkId,
          chunk.content,
          err,
          {
            vaultId,
            rebuiltAt: Math.floor(Date.now() / 1000),
            vaultChunkId: chunk.vaultChunkId,
          },
          sourceTokenCount,
        );
        if (recovered.recovered) {
          if (!recovered.skipped) embeddedChunkIds.add(chunk.vaultChunkId);
          return;
        }
      }
      console.warn("[embeddings] Batch vault rebuild failed:", err);
    },
    { label: "vault rebuild" },
  );

  if (embeddedChunkIds.size > 0) await scheduleStoreOptimize();
  return { embedded: embeddedChunkIds.size };
}

/**
 * Search vault chunks in LanceDB scoped to a single vault. Mirrors
 * searchChatChunks but filters on source_type='vault_chunk' AND owner_id.
 */
export async function searchVaultChunks(
  userId: string,
  vaultId: string,
  vector: number[],
  limit = 8,
  allowedChunkIds?: Set<string>,
  signal?: AbortSignal,
): Promise<Array<{ chunk_id: string; score: number; content: string; metadata: any }>> {
  if (signal?.aborted) return [];

  const allowedClause = allowedChunkIds && allowedChunkIds.size > 0
    ? sourceIdsIn(allowedChunkIds)
    : null;
  const filter = andFilter([ownerScope(userId, "vault_chunk", vaultId), allowedClause]);

  const store = await getActiveVectorStore();
  const hits = await store.vectorSearch({
    collection: "embeddings",
    vector,
    filter,
    limit: Math.max(1, Math.min(limit * 3, 200)),
    withVector: false,
    refine: true,
    signal,
  });

  if (signal?.aborted) return [];
  const collapsed = collapseVectorHitsBySourceId(hits);

  return collapsed.map((hit) => {
    let meta: any = {};
    try { meta = JSON.parse(hit.metadata_json || "{}"); } catch { /* use empty */ }
    return {
      chunk_id: String(hit.source_id),
      // Historical contract: cosine distance (lower = better); 0 when absent.
      score: hit.similarity == null ? 0 : distanceFromSimilarity(hit.similarity),
      content: hit.content,
      metadata: meta,
    };
  });
}

/**
 * Delete all LanceDB rows belonging to a vault. Called during vault deletion
 * and before a reindex replaces the snapshot.
 */
export async function deleteVaultChunks(userId: string, vaultId: string): Promise<void> {
  await deleteStoreRows("embeddings", ownerScope(userId, "vault_chunk", vaultId));
  await scheduleStoreOptimize();
}

// ─── Databank Vector Operations ─────────────────────────────────

/**
 * Batch upsert databank chunk vectors into LanceDB.
 * Uses source_type "databank" and owner_id = databankId for scope filtering.
 */
export async function batchUpsertDatabankVectors(
  userId: string,
  chunks: Array<{ chatId: string; chunkId: string; vector: number[]; content: string; metadata?: Record<string, any> }>,
): Promise<void> {
  if (chunks.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const rows: EmbeddingRow[] = chunks.map((c) => ({
    id: rowId(userId, "databank", c.chunkId, 0),
    user_id: userId,
    source_type: "databank",
    source_id: c.chunkId,
    owner_id: c.chatId, // owner_id = databankId for databank chunks
    chunk_index: 0,
    content: c.content.trim(),
    vector: c.vector,
    metadata_json: JSON.stringify(c.metadata || {}),
    updated_at: now,
  }));

  await upsertStoreRows("embeddings", rows);

  console.info(`[embeddings] Batch-vectorized ${rows.length} databank chunk(s)`);
  await scheduleStoreOptimize();
}

/**
 * Delete all databank embeddings for a specific bank from LanceDB.
 * Uses owner_id = databankId for efficient filtering.
 * For per-document deletion, use deleteDatabankChunksByIds() instead.
 */
export async function deleteDatabankEmbeddings(
  userId: string,
  databankId: string,
): Promise<void> {
  await deleteStoreRows("embeddings", ownerScope(userId, "databank", databankId));
  await scheduleStoreOptimize();
}

/**
 * Delete specific databank chunk vectors by their chunk IDs.
 * More precise than filtering by owner_id — avoids deleting unrelated documents.
 */
export async function deleteDatabankChunksByIds(userId: string, chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;
  const store = await getActiveVectorStore();
  const ids = chunkIds.map((id) => rowId(userId, "databank", id, 0));
  for (let i = 0; i < ids.length; i += 500) {
    await store.deleteByIds("embeddings", ids.slice(i, i + 500));
  }
  await scheduleStoreOptimize();
}

/**
 * Re-point existing databank chunk vectors to a different owner (target databank).
 *
 * Used when fusing databanks: chunk IDs and vectors stay the same, only the
 * owner_id (and metadata.databankId) changes so retrieval filtered by the new
 * owner picks them up. mergeInsert by id preserves the existing vector — we
 * fetch the row first to keep the embedding without re-vectorizing.
 */
export async function moveDatabankChunkVectorsToOwner(
  userId: string,
  chunkIds: string[],
  newOwnerId: string,
): Promise<void> {
  if (chunkIds.length === 0) return;

  const store = await getActiveVectorStore();
  const BATCH = 500;
  for (let i = 0; i < chunkIds.length; i += BATCH) {
    const batch = chunkIds.slice(i, i + BATCH);
    const ids = batch.map((id) => rowId(userId, "databank", id, 0));
    const existing = await store.getRowsByFilter("embeddings", idsIn(ids));
    if (existing.length === 0) continue;

    const now = Math.floor(Date.now() / 1000);
    const updated: EmbeddingRow[] = existing.map((row) => {
        let meta: Record<string, unknown> = {};
        try {
          const raw = typeof row.metadata_json === "string" ? row.metadata_json : JSON.stringify(row.metadata_json ?? {});
          meta = JSON.parse(raw || "{}");
        } catch {
          meta = {};
        }
        meta.databankId = newOwnerId;

        return {
          id: String(row.id),
          user_id: String(row.user_id),
          source_type: String(row.source_type),
          source_id: String(row.source_id),
          owner_id: newOwnerId,
          chunk_index: Number(row.chunk_index ?? 0),
          content: String(row.content || ""),
          vector: row.vector,
          metadata_json: JSON.stringify(meta),
          updated_at: now,
        };
      }).filter((r) => r.vector.length > 0);

    if (updated.length === 0) continue;
    await store.upsert("embeddings", updated);
  }
  await scheduleStoreOptimize();
}

/**
 * Search databank chunks in LanceDB by vector similarity.
 * Filters by source_type="databank" and owner_id IN (databankIds).
 */
export async function searchDatabankChunks(
  userId: string,
  databankIds: string[],
  vector: number[],
  requestedLimit = 4,
  queryText?: string,
  signal?: AbortSignal,
): Promise<Array<{ chunk_id: string; score: number; content: string; metadata: any }>> {
  if (databankIds.length === 0) return [];
  if (signal?.aborted) return [];

  const filter = ownersScope(userId, "databank", databankIds);
  const candidateLimit = Math.max(1, Math.min(requestedLimit + 20, 100));

  const store = await getActiveVectorStore();
  const nativeHybridSearch = store.hybridSearch?.bind(store);

  let hits: VectorHit[];
  if (queryText?.trim() && store.capabilities.nativeLexical && nativeHybridSearch) {
    hits = await nativeHybridSearch({
      collection: "embeddings",
      queryText: queryText.trim(),
      vector,
      filter,
      limit: candidateLimit,
      withVector: false,
      refine: true,
      signal,
    });
  } else if (queryText?.trim() && store.capabilities.nativeLexical) {
    // Existing LanceDB path: split vector/FTS legs and fuse with RRF in app code.
    const [vectorHits, lexicalHits] = await Promise.all([
      store.vectorSearch({
        collection: "embeddings",
        vector,
        filter,
        limit: candidateLimit,
        withVector: false,
        refine: true,
        signal,
      }),
      store.lexicalSearch({
        collection: "embeddings",
        queryText: queryText.trim(),
        filter,
        limit: candidateLimit,
        withVector: false,
        signal,
      }),
    ]);
    if (signal?.aborted) return [];
    hits = reciprocalRankFusion(vectorHits, lexicalHits);
  } else {
    hits = await store.vectorSearch({
      collection: "embeddings",
      vector,
      filter,
      limit: candidateLimit,
      withVector: false,
      refine: true,
      signal,
    });
  }

  if (signal?.aborted) return [];

  const results: Array<{ chunk_id: string; score: number; content: string; metadata: any }> = [];

  for (const hit of hits) {
    let meta: any = {};
    try { meta = JSON.parse(hit.metadata_json || "{}"); } catch { /* empty */ }

    // Historical contract: score = max(0, 1 - distance). A lexical-only hit had
    // no `_distance` (distance treated as 0 → score 1).
    const distance = hit.similarity == null ? 0 : distanceFromSimilarity(hit.similarity);
    const score = Math.max(0, 1 - distance);

    results.push({
      chunk_id: String(hit.source_id),
      score,
      content: hit.content,
      metadata: meta,
    });
  }

  // Sort by score descending and take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, requestedLimit);
}

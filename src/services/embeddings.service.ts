import { connect, Index, rerankers, type Connection, type Table } from "@lancedb/lancedb";
import { join } from "path";
import { rmSync, existsSync } from "fs";
import { env } from "../env";
import { getDb } from "../db/connection";
import * as settingsSvc from "./settings.service";
import * as secretsSvc from "./secrets.service";
import type {
  WorldBookEntry,
  WorldBookReindexProgress,
  WorldBookReindexResult,
  WorldBookVectorIndexStatus,
} from "../types/world-book";
import { embeddingCache, computeCacheKey, type ModelFingerprint } from "./embedding-cache";

const EMBEDDING_SETTINGS_KEY = "embeddingConfig";
const EMBEDDING_SECRET_KEY = "embedding_api_key";
const LANCEDB_PATH = join(env.dataDir, "lancedb");
const EMBEDDINGS_TABLE = "embeddings";
const WORLD_BOOK_VECTOR_VERSION = 2;
const WORLD_BOOK_VECTOR_VERSION_KEY = "worldBookVectorVersion";
/** Safety timeout for embedding API requests. Prevents a hanging upstream
 *  server from stalling the entire generation pipeline. */
const EMBEDDING_REQUEST_TIMEOUT_MS = 15_000; // 15 seconds

export type EmbeddingProvider =
  | "openai-compatible"
  | "openai"
  | "openrouter"
  | "electronhub"
  | "nanogpt";

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
}

export interface EmbeddingConfigWithStatus extends EmbeddingConfig {
  has_api_key: boolean;
}

export interface WorldBookEmbeddingMetadata {
  comment?: string;
  key?: string[];
  keysecondary?: string[];
  world_book_id?: string;
  search_text?: string;
  vector_version?: number;
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
  // --- Chunking ---
  chunkTargetTokens: number;      // Default 800. Range: 200–2000
  chunkMaxTokens: number;         // Default 1600. Range: chunkTargetTokens–4000
  chunkOverlapTokens: number;     // Default 120. Range: 0–500

  // --- Exclusion ---
  exclusionWindow: number;        // Default 20. Range: 5–100. Recent messages skipped during search

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

export const DEFAULT_CHAT_MEMORY_SETTINGS: ChatMemorySettings = {
  chunkTargetTokens: 800,
  chunkMaxTokens: 1600,
  chunkOverlapTokens: 120,
  exclusionWindow: 20,
  queryContextSize: 6,
  retrievalTopK: 4,
  similarityThreshold: 0,
  queryStrategy: "recent_messages",
  queryMaxTokens: 8000,
  memoryHeaderTemplate: "Relevant context from earlier in this conversation:\n{{memories}}",
  chunkTemplate: "{{content}}",
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
    chunkTargetTokens: clampInt(input?.chunkTargetTokens, 200, 2000, d.chunkTargetTokens),
    chunkMaxTokens: clampInt(input?.chunkMaxTokens, 400, 4000, d.chunkMaxTokens),
    chunkOverlapTokens: clampInt(input?.chunkOverlapTokens, 0, 500, d.chunkOverlapTokens),
    exclusionWindow: clampInt(input?.exclusionWindow, 5, 100, d.exclusionWindow),
    queryContextSize: clampInt(input?.queryContextSize, 1, 64, d.queryContextSize),
    retrievalTopK: clampInt(input?.retrievalTopK, 1, Infinity, d.retrievalTopK),
    similarityThreshold: clampFloat(input?.similarityThreshold, 0, 2, d.similarityThreshold),
    queryStrategy: ["recent_messages", "last_user_message", "weighted_recent"].includes(input?.queryStrategy)
      ? input.queryStrategy : d.queryStrategy,
    queryMaxTokens: clampInt(input?.queryMaxTokens, 1000, 32000, d.queryMaxTokens),
    memoryHeaderTemplate: typeof input?.memoryHeaderTemplate === "string" ? input.memoryHeaderTemplate : d.memoryHeaderTemplate,
    chunkTemplate: typeof input?.chunkTemplate === "string" ? input.chunkTemplate : d.chunkTemplate,
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
export const LTCM_FORMAT_VERSION = 2;

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

interface EmbeddingRow {
  id: string;
  user_id: string;
  source_type: string;
  source_id: string;
  owner_id: string;
  chunk_index: number;
  content: string;
  vector: number[];
  metadata_json: string;
  updated_at: number;
}

type LanceRow = Record<string, unknown>;

function asLanceRows(rows: EmbeddingRow[]): LanceRow[] {
  return rows as unknown as LanceRow[];
}

const PROVIDER_DEFAULT_URL: Record<EmbeddingProvider, string> = {
  "openai-compatible": "https://api.openai.com/v1/embeddings",
  openai: "https://api.openai.com/v1/embeddings",
  openrouter: "https://openrouter.ai/api/v1/embeddings",
  electronhub: "https://api.electronhub.top/v1/embeddings",
  nanogpt: "https://nano-gpt.com/api/v1/embeddings",
};

let connPromise: Promise<Connection> | null = null;
let vectorIndexReady = false;
let optimizeTimer: ReturnType<typeof setTimeout> | null = null;
const OPTIMIZE_DEBOUNCE_MS = 15_000; // 15 seconds after last write (reduced from 30s)
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

function providerDefaultModel(provider: EmbeddingProvider): string {
  if (provider === "nanogpt") return "text-embedding-3-small";
  if (provider === "openrouter") return "text-embedding-3-small";
  if (provider === "electronhub") return "text-embedding-3-small";
  if (provider === "openai") return "text-embedding-3-small";
  return "text-embedding-3-small";
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
  };
}

function normalizeConfig(input: any): EmbeddingConfig {
  const provider = ((input?.provider as EmbeddingProvider) || "openai-compatible");
  const base = defaultConfig(provider);
  return {
    enabled: input?.enabled !== undefined ? !!input.enabled : base.enabled,
    provider,
    api_url: typeof input?.api_url === "string" && input.api_url.trim() ? input.api_url.trim() : base.api_url,
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
  };
}

/**
 * Resolve the final embedding request URL from user-provided api_url.
 *
 * - No path or just "/" → append /v1/embeddings  (bare base URL)
 * - Any path present     → use as-is             (user-specified endpoint)
 */
function resolveEmbeddingUrl(rawUrl: string): string {
  const trimmed = rawUrl.replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    const path = parsed.pathname;
    if (!path || path === "/") {
      parsed.pathname = "/v1/embeddings";
      return parsed.toString().replace(/\/+$/, "");
    }
    return trimmed;
  } catch {
    // Malformed URL — best-effort append
    return `${trimmed}/v1/embeddings`;
  }
}

function sqlValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rowId(userId: string, sourceType: string, sourceId: string, chunkIndex: number): string {
  return `${userId}:${sourceType}:${sourceId}:${chunkIndex}`;
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

async function getConnection(): Promise<Connection> {
  if (!connPromise) connPromise = connect(LANCEDB_PATH);
  return connPromise;
}

async function tableExists(conn: Connection, name: string): Promise<boolean> {
  const names = await conn.tableNames();
  return names.includes(name);
}

async function getTableIfExists(): Promise<Table | null> {
  const conn = await getConnection();
  const exists = await tableExists(conn, EMBEDDINGS_TABLE);
  if (exists) {
    return conn.openTable(EMBEDDINGS_TABLE);
  }
  return null;
}

async function getOrCreateTable(seedRows?: EmbeddingRow[]): Promise<Table> {
  const conn = await getConnection();
  const exists = await tableExists(conn, EMBEDDINGS_TABLE);
  if (exists) {
    return conn.openTable(EMBEDDINGS_TABLE);
  }
  if (!seedRows || seedRows.length === 0) {
    throw new Error("Cannot create embeddings table without initial seed rows to infer schema.");
  }
  const table = await conn.createTable(EMBEDDINGS_TABLE, asLanceRows(seedRows));
  return table;
}

const MIN_ROWS_FOR_VECTOR_INDEX = 5_000;
let scalarIndexReady = false;
let ftsIndexReady = false;
const MAX_LANCE_SOURCE_FILTER_IDS = 250;
const OPTIMIZE_MAX_WAIT_MS = 2 * 60_000; // 2 minutes (reduced from 5 min to prevent fragment buildup)
let optimizeQueuedAt: number | null = null;

// ---------------------------------------------------------------------------
// Index health tracking — detect when indexes need rebuilding
// ---------------------------------------------------------------------------
let lastIndexRebuildAt = 0;
let unindexedRowEstimate = 0;
const INDEX_REBUILD_COOLDOWN_MS = 10 * 60_000; // Don't rebuild more than once per 10 min
const UNINDEXED_ROW_THRESHOLD = 2_000; // Rebuild when this many rows are unindexed
const INDEX_HEALTH_CHECK_INTERVAL_MS = 2 * 60_000; // Check index health every 2 min
let indexHealthTimer: ReturnType<typeof setInterval> | null = null;

function getWorldBookVectorVersionCacheKey(userId: string): string {
  return `${userId}:${WORLD_BOOK_VECTOR_VERSION}`;
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
  const primaryKeys = uniqueNonEmpty(entry.key || []);
  const secondaryKeys = uniqueNonEmpty(entry.keysecondary || []);
  const comment = (entry.comment || "").trim();
  const content = (entry.content || "").trim();
  const sections: string[] = [];

  if (comment) sections.push(`Entry title: ${comment}`);
  if (primaryKeys.length > 0) sections.push(`Primary keys: ${primaryKeys.join(", ")}`);
  if (secondaryKeys.length > 0) sections.push(`Secondary keys: ${secondaryKeys.join(", ")}`);
  if (content) sections.push(`Content:\n${content}`);

  return normalizeVectorSearchText(sections.join("\n\n")) || content;
}

function buildWorldBookEmbeddingMetadata(
  entry: WorldBookEntry,
  searchText: string,
): WorldBookEmbeddingMetadata {
  return {
    comment: entry.comment,
    key: entry.key,
    keysecondary: entry.keysecondary,
    world_book_id: entry.world_book_id,
    search_text: searchText,
    vector_version: WORLD_BOOK_VECTOR_VERSION,
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
    const table = await getTableIfExists();
    if (table) {
      await table.delete(
        `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry'`
      );
      scheduleOptimize();
    }
  } catch (err) {
    console.warn("[embeddings] Failed to invalidate legacy world-book vectors:", err);
  }

  try {
    getDb().query(
      `UPDATE world_book_entries
       SET vector_index_status = CASE WHEN vectorized = 1 THEN 'pending' ELSE 'not_enabled' END,
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

async function ensureVectorIndex(table: Table): Promise<void> {
  if (vectorIndexReady) return;
  try {
    const rowCount = await table.countRows();
    if (rowCount < MIN_ROWS_FOR_VECTOR_INDEX) {
      // Brute-force search is fast enough for small tables and avoids
      // KMeans warnings about empty clusters when rows < num_partitions * 256.
      vectorIndexReady = true;
      return;
    }
    // IVF_PQ handles metadata-filtered workloads (every query uses .where())
    // much better than HNSW_PQ, which suffers latency fluctuation with filters.
    const numPartitions = Math.max(2, Math.floor(Math.sqrt(rowCount)));
    await table.createIndex("vector", {
      config: Index.ivfPq({
        distanceType: "cosine",
        numPartitions,
      }),
    } as any);
  } catch {
    // Index may already exist - that's fine
  }
  vectorIndexReady = true;
  lastIndexRebuildAt = Date.now();
  startIndexHealthMonitor(table);
}

/**
 * Ensure scalar indexes exist on filter columns for fast prefiltering.
 * BTree for high-cardinality (user_id, owner_id, id), Bitmap for low-cardinality (source_type).
 * The `id` BTree is critical for mergeInsert performance — without it, every upsert
 * does a full table scan to find matching rows.
 *
 * When `force` is true, indexes are rebuilt with `replace: true` even if they already
 * exist. This is needed after compaction cleanup, which can leave stale index files
 * referencing deleted data versions (manifests as "Object not found" errors on Windows
 * and other platforms).
 */
async function ensureScalarIndexes(table: Table, force = false): Promise<void> {
  if (scalarIndexReady && !force) return;
  const indexNames = new Set((await table.listIndices()).map((i: any) => i.name || i.indexName || ""));
  const create = async (col: string, config?: any) => {
    // LanceDB names indexes as {col}_idx by convention
    if (!force && indexNames.has(`${col}_idx`)) return;
    try {
      const opts: any = config ? { config } : {};
      if (force && indexNames.has(`${col}_idx`)) opts.replace = true;
      await table.createIndex(col, opts);
    } catch {
      // Index may already exist
    }
  };
  await create("id"); // Critical for mergeInsert("id") join performance
  await create("user_id");
  await create("owner_id");
  await create("source_id");
  await create("source_type", Index.bitmap());
  scalarIndexReady = true;
}

/**
 * Ensure FTS index exists on the content column for hybrid search.
 * When `force` is true, the index is rebuilt even if it already exists.
 */
async function ensureFtsIndex(table: Table, force = false): Promise<void> {
  if (ftsIndexReady && !force) return;
  const indexNames = new Set((await table.listIndices()).map((i: any) => i.name || i.indexName || ""));
  if (!force && indexNames.has("content_idx")) {
    ftsIndexReady = true;
    return;
  }
  try {
    const opts: any = { config: Index.fts() };
    if (force && indexNames.has("content_idx")) opts.replace = true;
    await table.createIndex("content", opts);
  } catch {
    // Index may already exist
  }
  ftsIndexReady = true;
}

/**
 * Periodic index health monitor. Checks unindexed row count and triggers
 * a vector index rebuild when too many rows have drifted out of the index
 * (which happens naturally with mergeInsert updates).
 */
function startIndexHealthMonitor(table: Table): void {
  if (indexHealthTimer) return;
  indexHealthTimer = setInterval(async () => {
    try {
      await checkAndRebuildIndexes(table);
    } catch (err) {
      console.warn("[embeddings] Index health check failed:", err);
    }
  }, INDEX_HEALTH_CHECK_INTERVAL_MS);
}

export function stopIndexHealthMonitor(): void {
  if (indexHealthTimer) {
    clearInterval(indexHealthTimer);
    indexHealthTimer = null;
  }
}

async function checkAndRebuildIndexes(table: Table): Promise<void> {
  const now = Date.now();
  if (now - lastIndexRebuildAt < INDEX_REBUILD_COOLDOWN_MS) return;

  try {
    const indices = await table.listIndices();
    const vectorIdx = indices.find((i: any) => {
      const name = i.name || i.indexName || "";
      return name.includes("vector");
    });
    if (!vectorIdx) return;

    const idxName = vectorIdx.name || (vectorIdx as any).indexName;
    let unindexed = 0;
    try {
      const stats = await (table as any).indexStats(idxName);
      if (stats) {
        unindexed = (stats as any).num_unindexed_rows ?? (stats as any).numUnindexedRows ?? 0;
      }
    } catch {
      // indexStats may not be supported for this index type — fall back to
      // heuristic: rebuild if enough time has passed since last rebuild and
      // we've been writing (optimizeQueuedAt !== null indicates recent writes).
      if (optimizeQueuedAt !== null && now - lastIndexRebuildAt > INDEX_REBUILD_COOLDOWN_MS * 3) {
        unindexed = UNINDEXED_ROW_THRESHOLD; // Force rebuild
      }
    }
    unindexedRowEstimate = unindexed;

    if (unindexed >= UNINDEXED_ROW_THRESHOLD) {
      console.info(`[embeddings] ${unindexed} unindexed rows detected, rebuilding vector index...`);
      const rowCount = await table.countRows();
      const numPartitions = Math.max(2, Math.floor(Math.sqrt(rowCount)));
      await table.createIndex("vector", {
        config: Index.ivfPq({
          distanceType: "cosine",
          numPartitions,
        }),
        replace: true,
      } as any);
      lastIndexRebuildAt = Date.now();
      unindexedRowEstimate = 0;
      console.info(`[embeddings] Vector index rebuilt (${rowCount} rows, ${numPartitions} partitions)`);
    }
  } catch (err) {
    // Non-fatal — index health checks are best-effort
    console.warn("[embeddings] Index health check error:", err);
  }
}

/**
 * One-time startup migration: detect old HNSW_PQ vector index and replace it
 * with IVF_PQ (better for filtered workloads). Also compacts fragments.
 * Safe to call every startup — skips quickly if no table exists or index is
 * already the correct type.
 */
export async function runStartupVectorMaintenance(): Promise<void> {
  const conn = await getConnection();
  const exists = await tableExists(conn, EMBEDDINGS_TABLE);
  if (!exists) return;

  const table = await conn.openTable(EMBEDDINGS_TABLE);
  const indices = await table.listIndices();
  const vectorIdx = indices.find((i: any) => {
    const name = i.name || i.indexName || "";
    return name.includes("vector");
  });

  // Check if the existing index is the old HNSW_PQ type that needs migration
  const idxType = vectorIdx ? ((vectorIdx as any).indexType || (vectorIdx as any).type || "") : "";
  const needsMigration = vectorIdx && /hnsw/i.test(idxType);

  // Also compact fragments regardless of index type
  try {
    console.info("[embeddings] Running startup compaction...");
    await table.optimize({ cleanupOlderThan: new Date() });
  } catch (err) {
    console.warn("[embeddings] Startup compaction failed:", err);
  }

  if (needsMigration) {
    const rowCount = await table.countRows();
    if (rowCount >= MIN_ROWS_FOR_VECTOR_INDEX) {
      console.info(`[embeddings] Migrating vector index from HNSW_PQ → IVF_PQ (${rowCount} rows)...`);
      const numPartitions = Math.max(2, Math.floor(Math.sqrt(rowCount)));
      try {
        await table.createIndex("vector", {
          config: Index.ivfPq({
            distanceType: "cosine",
            numPartitions,
          }),
          replace: true,
        } as any);
        vectorIndexReady = true;
        lastIndexRebuildAt = Date.now();
        console.info(`[embeddings] Vector index migrated successfully (${numPartitions} partitions)`);
      } catch (err) {
        console.warn("[embeddings] Vector index migration failed (will retry on next query):", err);
      }
    }
  }

  // Force-rebuild scalar + FTS indexes after compaction cleanup to avoid stale
  // index files referencing deleted data versions (causes "Object not found" errors).
  await ensureScalarIndexes(table, true);
  await ensureFtsIndex(table, true);
  await ensureVectorIndex(table);
  startIndexHealthMonitor(table);
}

export async function optimizeTable(): Promise<void> {
  const conn = await getConnection();
  const exists = await tableExists(conn, EMBEDDINGS_TABLE);
  if (!exists) return;

  const table = await conn.openTable(EMBEDDINGS_TABLE);
  await table.optimize({
    cleanupOlderThan: new Date(),
  });

  // Rebuild scalar + FTS indexes after compaction cleanup.
  // optimize() with cleanupOlderThan removes old data versions, which can
  // orphan index files that referenced those versions. This manifests as
  // "Object at location ... not found" errors when LanceDB tries to read
  // stale index metadata. Force-rebuilding ensures indexes reference the
  // current compacted data.
  try {
    await ensureScalarIndexes(table, true);
    await ensureFtsIndex(table, true);
  } catch (err) {
    console.warn("[embeddings] Post-optimize index rebuild failed:", err);
  }
}

/**
 * Get LanceDB table health diagnostics for the embeddings table.
 */
export async function getVectorStoreHealth(): Promise<{
  exists: boolean;
  rowCount: number;
  vectorIndexReady: boolean;
  scalarIndexReady: boolean;
  ftsIndexReady: boolean;
  unindexedRowEstimate: number;
  lastIndexRebuildAt: number;
  indexes: Array<{ name: string; type?: string }>;
}> {
  const conn = await getConnection();
  const exists = await tableExists(conn, EMBEDDINGS_TABLE);
  if (!exists) {
    return {
      exists: false,
      rowCount: 0,
      vectorIndexReady,
      scalarIndexReady,
      ftsIndexReady,
      unindexedRowEstimate: 0,
      lastIndexRebuildAt: 0,
      indexes: [],
    };
  }

  const table = await conn.openTable(EMBEDDINGS_TABLE);
  const rowCount = await table.countRows();
  const indices = await table.listIndices();

  return {
    exists: true,
    rowCount,
    vectorIndexReady,
    scalarIndexReady,
    ftsIndexReady,
    unindexedRowEstimate,
    lastIndexRebuildAt,
    indexes: indices.map((i: any) => ({
      name: i.name || i.indexName || "unknown",
      type: i.indexType || i.type || undefined,
    })),
  };
}

function scheduleOptimize(): void {
  const now = Date.now();
  if (optimizeQueuedAt == null) optimizeQueuedAt = now;
  if (optimizeTimer) clearTimeout(optimizeTimer);
  const elapsed = now - optimizeQueuedAt;
  const delay = elapsed >= OPTIMIZE_MAX_WAIT_MS
    ? 0
    : Math.min(OPTIMIZE_DEBOUNCE_MS, OPTIMIZE_MAX_WAIT_MS - elapsed);
  optimizeTimer = setTimeout(async () => {
    optimizeTimer = null;
    optimizeQueuedAt = null;
    try {
      await optimizeTable();
    } catch (err) {
      console.warn("[embeddings] Deferred optimize failed:", err);
    }
  }, delay);
}

export function getProviderDefaults(provider: EmbeddingProvider) {
  return {
    api_url: PROVIDER_DEFAULT_URL[provider],
    model: providerDefaultModel(provider),
  };
}

export async function getEmbeddingConfig(userId: string): Promise<EmbeddingConfigWithStatus> {
  const setting = settingsSvc.getSetting(userId, EMBEDDING_SETTINGS_KEY);
  const cfg = normalizeConfig(setting?.value);
  const has_api_key = await secretsSvc.validateSecret(userId, EMBEDDING_SECRET_KEY);
  return { ...cfg, has_api_key };
}

export async function updateEmbeddingConfig(
  userId: string,
  input: Partial<EmbeddingConfig> & { api_key?: string | null }
): Promise<EmbeddingConfigWithStatus> {
  const current = await getEmbeddingConfig(userId);
  const merged = normalizeConfig({ ...current, ...input });
  settingsSvc.putSetting(userId, EMBEDDING_SETTINGS_KEY, merged);

  if (input.api_key !== undefined) {
    const next = (input.api_key || "").trim();
    if (next) {
      await secretsSvc.putSecret(userId, EMBEDDING_SECRET_KEY, next);
    } else {
      secretsSvc.deleteSecret(userId, EMBEDDING_SECRET_KEY);
    }
  }

  // Detect model change and invalidate stale vectors
  const oldFp = getModelFingerprint(current);
  const newFp = getModelFingerprint(merged);
  if (
    oldFp.provider !== newFp.provider ||
    oldFp.model !== newFp.model ||
    oldFp.dimensions !== newFp.dimensions ||
    oldFp.api_url !== newFp.api_url
  ) {
    await invalidateAllVectors(userId);
  }

  const has_api_key = await secretsSvc.validateSecret(userId, EMBEDDING_SECRET_KEY);
  return { ...merged, has_api_key };
}

/**
 * Parse embedding responses from OpenAI-compatible, Ollama /api/embed, and Ollama /api/embeddings formats.
 */
function parseEmbeddingResponse(payload: any, expectedCount: number): number[][] {
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

  throw new Error("Unrecognized embedding response format");
}

async function requestEmbeddings(
  userId: string,
  texts: string[],
  options?: { omitDimensions?: boolean }
): Promise<number[][]> {
  const cfg = await getEmbeddingConfig(userId);
  if (!cfg.enabled) throw new Error("Embeddings are disabled for this user");
  const apiKey = await secretsSvc.getSecret(userId, EMBEDDING_SECRET_KEY);
  if (!apiKey) throw new Error("Embedding API key is not configured");
  if (!texts.length) return [];

  const isOllamaNative = /\/api\/(embed|embeddings)\b/.test(cfg.api_url);

  const body: Record<string, any> = {
    model: cfg.model,
    input: texts,
  };
  if (!isOllamaNative) {
    body.encoding_format = "float";
  }
  if (!options?.omitDimensions && cfg.send_dimensions && cfg.dimensions) body.dimensions = cfg.dimensions;

  const url = resolveEmbeddingUrl(cfg.api_url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      throw new Error(`Embedding request timed out after ${EMBEDDING_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const msg = await res.text().catch(() => "Embedding request failed");
    throw new Error(`Embedding request failed (${res.status}): ${msg}`);
  }

  const payload = await res.json() as any;
  const vectors = parseEmbeddingResponse(payload, texts.length);
  return vectors;
}

export async function embedTexts(userId: string, texts: string[]): Promise<number[][]> {
  return requestEmbeddings(userId, texts);
}

function getModelFingerprint(cfg: EmbeddingConfig): ModelFingerprint {
  return { provider: cfg.provider, model: cfg.model, dimensions: cfg.dimensions, api_url: cfg.api_url };
}

/**
 * In-flight dedup: prevents concurrent requestEmbeddings() calls for the
 * same text. Key = cache key (model-aware), Value = pending promise.
 */
const inflightEmbeddings = new Map<string, Promise<number[]>>();

/**
 * Cache-aware embedding. Checks in-memory LRU cache first, batches only
 * uncached texts to the upstream API, then stores results.
 *
 * Single-text calls are deduped: if another caller is already fetching the
 * same text, we share its promise instead of making a second API call.
 */
export async function cachedEmbedTexts(userId: string, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const cfg = await getEmbeddingConfig(userId);
  const fingerprint = getModelFingerprint(cfg);

  // Fast path for single-text calls (the common case for cortex + chat memory retrieval)
  if (texts.length === 1) {
    const key = computeCacheKey(texts[0], fingerprint);
    const cached = embeddingCache.get(key);
    if (cached) return [cached];

    // Join an in-flight request for the same text instead of making a duplicate API call
    const inflight = inflightEmbeddings.get(key);
    if (inflight) return [await inflight];

    const promise = requestEmbeddings(userId, texts).then(vecs => {
      const vec = vecs[0];
      embeddingCache.set(key, vec);
      inflightEmbeddings.delete(key);
      return vec;
    }, err => {
      inflightEmbeddings.delete(key);
      throw err;
    });
    inflightEmbeddings.set(key, promise);
    return [await promise];
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
    const vectors = await requestEmbeddings(userId, uncachedTexts);
    for (let j = 0; j < uncachedIndices.length; j++) {
      const idx = uncachedIndices[j];
      results[idx] = vectors[j];
      embeddingCache.set(computeCacheKey(texts[idx], fingerprint), vectors[j]);
    }
  }

  return results as number[][];
}

export async function testEmbeddingConfig(
  userId: string,
  text: string
): Promise<{ dimension: number; config: EmbeddingConfigWithStatus }> {
  // Deliberately omit dimensions so providers return native/default dimensionality.
  const vectors = await requestEmbeddings(userId, [text], { omitDimensions: true });
  const first = vectors[0] || [];
  if (!first.length) throw new Error("No embedding vector returned");

  const current = await getEmbeddingConfig(userId);
  const updated = normalizeConfig({ ...current, dimensions: first.length });
  settingsSvc.putSetting(userId, EMBEDDING_SETTINGS_KEY, updated);
  const has_api_key = await secretsSvc.validateSecret(userId, EMBEDDING_SECRET_KEY);

  return {
    dimension: first.length,
    config: {
      ...updated,
      has_api_key,
    },
  };
}

export async function deleteWorldBookEntryEmbeddings(userId: string, entryId: string): Promise<void> {
  const table = await getTableIfExists();
  if (!table) return;
  await table.delete(
    `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry' AND source_id = ${sqlValue(entryId)}`
  );
  scheduleOptimize();
}

function getDesiredWorldBookVectorStatus(entry: WorldBookEntry): WorldBookVectorIndexStatus {
  return entry.vectorized ? "pending" : "not_enabled";
}

function updateWorldBookEntryVectorState(
  entryId: string,
  status: WorldBookVectorIndexStatus,
  indexedAt: number | null,
  error: string | null,
): void {
  getDb().query(
    `UPDATE world_book_entries
     SET vector_index_status = ?, vector_indexed_at = ?, vector_index_error = ?
     WHERE id = ?`
  ).run(status, indexedAt, error, entryId);
}

function updateWorldBookEntriesVectorState(
  entryIds: string[],
  status: WorldBookVectorIndexStatus,
  indexedAt: number | null,
  error: string | null,
): void {
  if (entryIds.length === 0) return;
  const placeholders = entryIds.map(() => "?").join(", ");
  getDb().query(
    `UPDATE world_book_entries
     SET vector_index_status = ?, vector_indexed_at = ?, vector_index_error = ?
     WHERE id IN (${placeholders})`
  ).run(status, indexedAt, error, ...entryIds);
}

function isEligibleWorldBookEntry(entry: WorldBookEntry): boolean {
  return entry.vectorized && !entry.disabled && (entry.content || "").trim().length > 0;
}

async function getExistingWorldBookVectorPayload(
  userId: string,
  entryId: string,
): Promise<{ content: string; searchText: string; vectorVersion: number | null } | null> {
  try {
    const table = await getTableIfExists();
    if (!table) return null;
    const rows = await table
      .query()
      .where(
        `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry' AND source_id = ${sqlValue(entryId)}`
      )
      .select(["content", "metadata_json"])
      .limit(1)
      .toArray();
    if (rows.length === 0) return null;

    const row = rows[0] as any;
    if (typeof row.content !== "string") return null;
    const metadata = parseWorldBookEmbeddingMetadata(row.metadata_json);
    return {
      content: row.content,
      searchText: typeof metadata.search_text === "string" ? metadata.search_text : "",
      vectorVersion: typeof metadata.vector_version === "number" ? metadata.vector_version : null,
    };
  } catch {
    // Table may not exist yet
  }
  return null;
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
  const content = (entry.content || "").trim();
  const searchText = buildWorldBookEntrySearchText(entry);
  if (!cfg.enabled || !cfg.vectorize_world_books || entry.disabled || !content) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, "not_enabled", null, null);
    return;
  }

  try {
    const existing = await getExistingWorldBookVectorPayload(userId, entry.id);
    const now = Math.floor(Date.now() / 1000);

    if (
      existing &&
      existing.content === content &&
      existing.searchText === searchText &&
      existing.vectorVersion === WORLD_BOOK_VECTOR_VERSION
    ) {
      updateWorldBookEntryVectorState(entry.id, "indexed", now, null);
      return;
    }

    const [vector] = await cachedEmbedTexts(userId, [searchText]);
    const row: EmbeddingRow = {
      id: rowId(userId, "world_book_entry", entry.id, 0),
      user_id: userId,
      source_type: "world_book_entry",
      source_id: entry.id,
      owner_id: entry.world_book_id,
      chunk_index: 0,
      content,
      vector,
      metadata_json: JSON.stringify(buildWorldBookEmbeddingMetadata(entry, searchText)),
      updated_at: now,
    };

    const table = await getOrCreateTable([row]);
    await ensureVectorIndex(table);
    await ensureScalarIndexes(table);
    await ensureFtsIndex(table);
    await table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(asLanceRows([row]));

    updateWorldBookEntryVectorState(entry.id, "indexed", now, null);
    scheduleOptimize();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Vector indexing failed";
    updateWorldBookEntryVectorState(entry.id, "error", null, message);
    throw err;
  }
}

export async function reindexWorldBookEntries(
  userId: string,
  entries: WorldBookEntry[],
  options?: {
    batchSize?: number;
    onProgress?: (progress: WorldBookReindexProgress) => void;
  }
) : Promise<WorldBookReindexResult> {
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? 50, 200));
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

  for (const entry of entries) {
    if (!entry.vectorized) {
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

  const cfg = await getEmbeddingConfig(userId);
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

  for (let i = 0; i < toIndex.length; i += batchSize) {
    const batch = toIndex.slice(i, i + batchSize);

    try {
      const searchTexts = batch.map((entry) => buildWorldBookEntrySearchText(entry));
      const vectors = await cachedEmbedTexts(userId, searchTexts);
      const now = Math.floor(Date.now() / 1000);

      const rows: EmbeddingRow[] = batch.map((entry, idx) => ({
        id: rowId(userId, "world_book_entry", entry.id, 0),
        user_id: userId,
        source_type: "world_book_entry",
        source_id: entry.id,
        owner_id: entry.world_book_id,
        chunk_index: 0,
        content: (entry.content || "").trim(),
        vector: vectors[idx],
        metadata_json: JSON.stringify(buildWorldBookEmbeddingMetadata(entry, searchTexts[idx])),
        updated_at: now,
      }));

      const table = await getOrCreateTable(rows);
      await ensureVectorIndex(table);
      await ensureScalarIndexes(table);
      await ensureFtsIndex(table);
      await table
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(asLanceRows(rows));

      updateWorldBookEntriesVectorState(batch.map((entry) => entry.id), "indexed", now, null);
      progress.indexed += batch.length;
      progress.current += batch.length;
      emitProgress();
    } catch (err) {
      console.warn("[embeddings] Batch embedding failed:", err);
      const message = err instanceof Error ? err.message : "Batch vector indexing failed";
      updateWorldBookEntriesVectorState(batch.map((entry) => entry.id), "error", null, message);
      progress.failed += batch.length;
      progress.current += batch.length;
      emitProgress();
    }
  }

  // Compact all fragments into fewer files, prune old versions, and
  // rebuild vector index so freshly-upserted rows are fully indexed.
  try {
    await optimizeTable();
    // After bulk reindex, force a vector index rebuild to absorb all new rows
    const table = await getTableIfExists();
    if (table) {
      vectorIndexReady = false;
      await ensureVectorIndex(table);
    }
  } catch (err) {
    console.warn("[embeddings] Post-reindex optimize failed:", err);
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
  const rows = await searchWorldBookEntriesHybridWithVector(userId, worldBookId, text, vector, limit);
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
  limit = 8
): Promise<WorldBookSearchCandidate[]> {
  await ensureWorldBookVectorVersion(userId);
  const table = await getTableIfExists();
  if (!table) return [];

  const trimmedQuery = queryText.trim();
  const filter = `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry' AND owner_id = ${sqlValue(worldBookId)}`;
  const effectiveLimit = Math.max(1, Math.min(limit, 100));

  const query = table
    .query()
    .nearestTo(vector)
    .where(filter)
    .select(["source_id", "content", "_distance", "metadata_json"])
    .limit(effectiveLimit) as any;
  // Refine with full vectors after PQ approximate search for better accuracy
  if (vectorIndexReady) query.refineFactor(5);
  const vectorRows = await query.toArray();

  const merged = new Map<string, WorldBookSearchCandidate>();

  for (const row of vectorRows) {
    const metadata = parseWorldBookEmbeddingMetadata(row.metadata_json);
    merged.set(String(row.source_id), {
      entry_id: String(row.source_id),
      distance: typeof row._distance === "number" ? row._distance : 0,
      lexical_score: null,
      content: String(row.content || ""),
      searchTextPreview: typeof metadata.search_text === "string" ? metadata.search_text : "",
      metadata,
    });
  }

  if (trimmedQuery) {
    try {
      const lexicalRows = await table
        .query()
        .fullTextSearch(trimmedQuery)
        .where(filter)
        .select(["source_id", "content", "_score", "metadata_json"])
        .limit(effectiveLimit)
        .toArray();

      for (const row of lexicalRows) {
        const entryId = String(row.source_id);
        const metadata = parseWorldBookEmbeddingMetadata(row.metadata_json);
        const lexicalScore = typeof row._score === "number" ? row._score : null;
        const existing = merged.get(entryId);

        if (existing) {
          existing.lexical_score = lexicalScore;
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
      console.warn("[embeddings] World-book FTS candidate fetch failed:", err);
    }
  }

  return Array.from(merged.values());
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
  const rows = await searchWorldBookEntriesHybridWithVector(userId, worldBookId, "", vector, limit);
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
    const table = await getTableIfExists();
    if (table) {
      await table.delete(`user_id = ${sqlValue(userId)}`);
      scheduleOptimize();
    }
  } catch (err) {
    console.warn("[embeddings] Failed to delete LanceDB rows during invalidation:", err);
  }

  try {
    const db = getDb();
    db.run(
      `UPDATE world_book_entries
       SET vector_index_status = CASE WHEN vectorized = 1 THEN 'pending' ELSE 'not_enabled' END,
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

  vectorIndexReady = false;
  scalarIndexReady = false;
  ftsIndexReady = false;
  lastIndexRebuildAt = 0;
  unindexedRowEstimate = 0;
  stopIndexHealthMonitor();
}

/**
 * Force reset the entire LanceDB vector store.
 * Nukes the on-disk LanceDB directory, resets all module state, clears caches,
 * and resets vector index state in SQLite. This is the nuclear option for
 * recovering from corruption (e.g. "vector not divisible by 8" errors).
 */
export async function forceResetLanceDB(): Promise<{ deleted: boolean; path: string }> {
  // 1. Cancel any pending optimize and index health monitor
  if (optimizeTimer) {
    clearTimeout(optimizeTimer);
    optimizeTimer = null;
  }
  optimizeQueuedAt = null;
  stopIndexHealthMonitor();

  // 2. Clear in-memory caches
  embeddingCache.clear();

  // 3. Reset connection state so next access creates a fresh connection
  connPromise = null;
  vectorIndexReady = false;
  scalarIndexReady = false;
  ftsIndexReady = false;
  lastIndexRebuildAt = 0;
  unindexedRowEstimate = 0;

  // 4. Delete the entire LanceDB directory from disk
  const deleted = existsSync(LANCEDB_PATH);
  if (deleted) {
    rmSync(LANCEDB_PATH, { recursive: true, force: true });
    console.info(`[embeddings] Force-deleted LanceDB directory: ${LANCEDB_PATH}`);
  }

  // 5. Reset world book index state in SQLite while preserving semantic opt-in
  try {
    const db = getDb();
    db.run(
      `UPDATE world_book_entries
       SET vector_index_status = CASE WHEN vectorized = 1 THEN 'pending' ELSE 'not_enabled' END,
           vector_indexed_at = NULL,
           vector_index_error = NULL`
    );
    db.run(`UPDATE chat_chunks SET vectorized_at = NULL, vector_model = NULL`);
    db.run(`DELETE FROM query_vector_cache`);
    db.run(`DELETE FROM chat_memory_cache`);
  } catch (err) {
    console.warn("[embeddings] Failed to reset SQLite vectorization state:", err);
  }

  console.info("[embeddings] LanceDB force reset complete. Vector store will reinitialize on next use.");
  return { deleted, path: LANCEDB_PATH };
}

// --- Chat Vectorization ---

export async function deleteChatChunkEmbeddings(userId: string, chatId: string, chunkId?: string): Promise<void> {
  const table = await getTableIfExists();
  if (!table) return;
  let filter = `user_id = ${sqlValue(userId)} AND source_type = 'chat_chunk' AND owner_id = ${sqlValue(chatId)}`;
  if (chunkId) {
    filter += ` AND source_id = ${sqlValue(chunkId)}`;
  }
  await table.delete(filter);
  scheduleOptimize();
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

  const [vector] = await cachedEmbedTexts(userId, [text]);
  if (!vector || vector.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const row: EmbeddingRow = {
    id: rowId(userId, "chat_chunk", chunkId, 0),
    user_id: userId,
    source_type: "chat_chunk",
    source_id: chunkId,
    owner_id: chatId,
    chunk_index: 0,
    content: text,
    vector,
    metadata_json: JSON.stringify(metadata || {}),
    updated_at: now,
  };

  const table = await getOrCreateTable([row]);
  await ensureVectorIndex(table);
  await ensureScalarIndexes(table);
  await ensureFtsIndex(table);
  await table
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(asLanceRows([row]));

  console.info(`[embeddings] Vectorized chat chunk ${chunkId} for chat ${chatId}`);

  scheduleOptimize();
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
  const rows: EmbeddingRow[] = chunks.map((c) => ({
    id: rowId(userId, "chat_chunk", c.chunkId, 0),
    user_id: userId,
    source_type: "chat_chunk",
    source_id: c.chunkId,
    owner_id: c.chatId,
    chunk_index: 0,
    content: c.content.trim(),
    vector: c.vector,
    metadata_json: JSON.stringify(c.metadata || {}),
    updated_at: now,
  }));

  const table = await getOrCreateTable(rows);
  await ensureVectorIndex(table);
  await ensureScalarIndexes(table);
  await ensureFtsIndex(table);
  await table
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(asLanceRows(rows));

  console.info(`[embeddings] Batch-vectorized ${rows.length} chat chunk(s)`);
  scheduleOptimize();
}

async function getExistingChatChunks(userId: string, chatId: string): Promise<Record<string, string>> {
  const table = await getTableIfExists();
  if (!table) return {};
  const rows = await table
    .query()
    .where(`user_id = ${sqlValue(userId)} AND source_type = 'chat_chunk' AND owner_id = ${sqlValue(chatId)}`)
    .select(["source_id", "content"])
    .toArray();
  const map: Record<string, string> = {};
  for (const r of rows as any[]) {
    map[r.source_id] = r.content;
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
    const existingContent = existingChunks[chunk.chunkId];
    if (existingContent !== chunk.content.trim()) {
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

  // Delete orphaned chunks
  for (const id of chunksToDelete) {
    await deleteChatChunkEmbeddings(userId, chatId, id);
  }

  const batchSize = Math.max(1, Math.min(cfg.batch_size, 200));
  for (let i = 0; i < chunksToUpsert.length; i += batchSize) {
    const batch = chunksToUpsert.slice(i, i + batchSize);
    try {
      const texts = batch.map((c) => c.content.trim());
      const vectors = await cachedEmbedTexts(userId, texts);
      const now = Math.floor(Date.now() / 1000);

      const rows: EmbeddingRow[] = batch.map((c, idx) => ({
        id: rowId(userId, "chat_chunk", c.chunkId, 0),
        user_id: userId,
        source_type: "chat_chunk",
        source_id: c.chunkId,
        owner_id: chatId,
        chunk_index: 0,
        content: c.content.trim(),
        vector: vectors[idx],
        metadata_json: JSON.stringify(c.metadata || {}),
        updated_at: now,
      }));

      const table = await getOrCreateTable(rows);
      await ensureVectorIndex(table);
      await ensureScalarIndexes(table);
      await ensureFtsIndex(table);
      await table
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(asLanceRows(rows));
    } catch (err) {
      console.warn("[embeddings] Batch chat embedding failed:", err);
    }
  }

  if (chunksToDelete.length > 0 || chunksToUpsert.length > 0) {
    console.info(`[embeddings] Synced chat memory for ${chatId.split('-')[0]}... (+${chunksToUpsert.length} updated, -${chunksToDelete.length} removed)`);
  }

  scheduleOptimize();
}

export async function searchChatChunks(
  userId: string,
  chatId: string,
  vector: number[],
  excludeIds: Set<string>,
  limit = 8,
  queryText?: string,
  hybridWeightMode?: "keyword_first" | "balanced" | "vector_first",
  allowedChunkIds?: Set<string>,
): Promise<Array<{ chunk_id: string; score: number; content: string; metadata: any }>> {
  const table = await getTableIfExists();
  if (!table) return [];

  const baseFilter = `user_id = ${sqlValue(userId)} AND source_type = 'chat_chunk' AND owner_id = ${sqlValue(chatId)}`;
  const sourceFilter = buildAllowedChunkFilter(allowedChunkIds);
  const filter = sourceFilter ? `${baseFilter} AND ${sourceFilter}` : baseFilter;
  const fetchLimit = Math.max(1, Math.min(limit + 50, 150));

  // Try hybrid search when query text is available
  let rows: any[];
  // Refine with full vectors after PQ approximate search for better accuracy
  const applyRefineFactor = (q: any) => { if (vectorIndexReady) q.refineFactor(5); return q; };
  if (queryText?.trim() && hybridWeightMode !== "vector_first") {
    try {
      const reranker = await rerankers.RRFReranker.create();
      const q = table
        .query()
        .nearestTo(vector)
        .fullTextSearch(queryText.trim())
        .where(filter)
        .rerank(reranker)
        .select(["source_id", "content", "_distance", "_relevance_score", "metadata_json", "vector"])
        .limit(fetchLimit);
      rows = await applyRefineFactor(q).toArray();
    } catch {
      // FTS index may not exist yet — fall back to vector-only
      const q = table
        .query()
        .nearestTo(vector)
        .where(filter)
        .select(["source_id", "content", "_distance", "metadata_json", "vector"])
        .limit(fetchLimit);
      rows = await applyRefineFactor(q).toArray();
    }
  } else {
    const q = table
      .query()
      .nearestTo(vector)
      .where(filter)
      .select(["source_id", "content", "_distance", "metadata_json", "vector"])
      .limit(fetchLimit);
    rows = await applyRefineFactor(q).toArray();
  }

  // Parse and exclude
  type ParsedRow = { chunkId: string; score: number; content: string; metadata: any; rowVector: number[] | null };
  const candidates: ParsedRow[] = [];

  for (const row of rows) {
    const chunkId = String(row.source_id);
    let meta: any = {};
    try {
      const raw = row.metadata_json;
      if (typeof raw === "string") {
        meta = JSON.parse(raw);
      } else if (raw && typeof raw === "object") {
        meta = raw; // Already parsed (Arrow deserialization)
      }
    } catch {
      // Treat as empty metadata
    }

    // Exclusion check: resolve message IDs from metadata or fall back to SQLite
    let chunkMessageIds: string[] = [];
    if (meta.messageIds && Array.isArray(meta.messageIds)) {
      chunkMessageIds = meta.messageIds;
    } else {
      // Fallback: look up message_ids from the chat_chunks table
      try {
        const chunkRow = getDb().query("SELECT message_ids FROM chat_chunks WHERE id = ?").get(chunkId) as any;
        if (chunkRow?.message_ids) {
          chunkMessageIds = JSON.parse(chunkRow.message_ids);
        }
      } catch {
        // non-fatal
      }
    }

    const shouldExclude = chunkMessageIds.length > 0 && chunkMessageIds.some((id: string) => excludeIds.has(id));
    if (shouldExclude) continue;

    // Extract vector for MMR (may be Float32Array from Lance)
    let rowVector: number[] | null = null;
    if (row.vector) {
      rowVector = row.vector instanceof Float32Array ? Array.from(row.vector) : row.vector;
    }

    candidates.push({
      chunkId,
      score: typeof row._distance === "number" ? row._distance : 0,
      content: String(row.content || ""),
      metadata: meta,
      rowVector,
    });
  }

  if (candidates.length === 0) return [];

  // Apply MMR diversity selection
  const selected = mmrSelect(candidates, vector, limit, 0.7);

  return selected.map(c => ({
    chunk_id: c.chunkId,
    score: c.score,
    content: c.content,
    metadata: c.metadata,
  }));
}

function buildAllowedChunkFilter(allowedChunkIds?: Set<string>): string | null {
  if (!allowedChunkIds || allowedChunkIds.size === 0) return null;
  if (allowedChunkIds.size > MAX_LANCE_SOURCE_FILTER_IDS) return null;
  const values = [...allowedChunkIds].map((id) => sqlValue(id)).join(", ");
  return `source_id IN (${values})`;
}

/**
 * Maximal Marginal Relevance selection.
 * Iteratively picks chunks that are relevant to the query but diverse from
 * already-selected chunks. lambda controls the trade-off:
 *   1.0 = pure relevance (no diversity), 0.0 = pure diversity.
 *   0.7 is a good default for chat memory.
 */
function mmrSelect(
  candidates: Array<{ chunkId: string; score: number; content: string; metadata: any; rowVector: number[] | null }>,
  queryVector: number[],
  k: number,
  lambda = 0.7,
): typeof candidates {
  // If we don't have vectors for diversity, just return top-K by score
  const withVectors = candidates.filter(c => c.rowVector !== null);
  if (withVectors.length <= k || withVectors.length === 0) {
    return candidates.slice(0, k);
  }

  const selected: typeof candidates = [];
  const remaining = new Set(withVectors.map((_, i) => i));

  for (let i = 0; i < k && remaining.size > 0; i++) {
    let bestIdx = -1;
    let bestMmr = -Infinity;

    for (const idx of remaining) {
      const candidate = withVectors[idx];
      // Relevance: higher similarity to query = better (invert cosine distance)
      const relevance = 1 - candidate.score;

      // Diversity: max similarity to any already-selected chunk
      let maxSimToSelected = 0;
      if (selected.length > 0) {
        for (const sel of selected) {
          if (sel.rowVector && candidate.rowVector) {
            const sim = cosineSimilarity(candidate.rowVector, sel.rowVector);
            if (sim > maxSimToSelected) maxSimToSelected = sim;
          }
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;
      if (mmrScore > bestMmr) {
        bestMmr = mmrScore;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(withVectors[bestIdx]);
      remaining.delete(bestIdx);
    }
  }

  return selected;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
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
  const db = getDb();
  const chunk = db.query("SELECT message_ids FROM chat_chunks WHERE id = ?").get(chunkId) as any;
  const messageIds = chunk ? JSON.parse(chunk.message_ids) : [];

  const now = Math.floor(Date.now() / 1000);
  const row: EmbeddingRow = {
    id: rowId(userId, "chat_chunk", chunkId, 0),
    user_id: userId,
    source_type: "chat_chunk",
    source_id: chunkId,
    owner_id: chatId,
    chunk_index: 0,
    content: content.trim(),
    vector,
    metadata_json: JSON.stringify({ chunkId, messageIds }),
    updated_at: now,
  };

  const table = await getOrCreateTable([row]);
  await ensureVectorIndex(table);
  await ensureScalarIndexes(table);
  await ensureFtsIndex(table);
  await table
    .mergeInsert("id")
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(asLanceRows([row]));

  scheduleOptimize();
}

/**
 * Delete a specific chunk's vector from LanceDB.
 */
export async function deleteChunkVector(userId: string, chunkId: string): Promise<void> {
  const table = await getTableIfExists();
  if (!table) return;

  const id = rowId(userId, "chat_chunk", chunkId, 0);
  await table.delete(`id = ${sqlValue(id)}`);
}

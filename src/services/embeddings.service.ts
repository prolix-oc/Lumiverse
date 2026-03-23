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
  retrieval_top_k: number;
  hybrid_weight_mode: "keyword_first" | "balanced" | "vector_first";
  preferred_context_size: number;
  batch_size: number;
  similarity_threshold: number;
  vectorize_world_books: boolean;
  vectorize_chat_messages: boolean;
  vectorize_chat_documents: boolean;
  chat_memory_mode: "conservative" | "balanced" | "aggressive";
}

export interface EmbeddingConfigWithStatus extends EmbeddingConfig {
  has_api_key: boolean;
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
  retrievalTopK: number;          // Default 4. Range: 1–24
  similarityThreshold: number;    // Default 0 (disabled). Range: 0–1

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
    retrievalTopK: clampInt(input?.retrievalTopK, 1, 24, d.retrievalTopK),
    similarityThreshold: clampFloat(input?.similarityThreshold, 0, 1, d.similarityThreshold),
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
const OPTIMIZE_DEBOUNCE_MS = 30_000; // 30 seconds after last write

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
    retrieval_top_k: 4,
    hybrid_weight_mode: "balanced",
    preferred_context_size: 6,
    batch_size: 50,
    similarity_threshold: 0,
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
    retrieval_top_k:
      Number.isFinite(input?.retrieval_top_k) && input.retrieval_top_k > 0
        ? Math.min(24, Math.floor(input.retrieval_top_k))
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
        ? Math.min(1, input.similarity_threshold)
        : base.similarity_threshold,
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

const MIN_ROWS_FOR_VECTOR_INDEX = 10_000;
let scalarIndexReady = false;
let ftsIndexReady = false;

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
    await table.createIndex("vector", {
      config: Index.hnswPq({
        distanceType: "cosine",
        m: 20,
        efConstruction: 300,
      }),
    } as any);
  } catch {
    // Index may already exist - that's fine
  }
  vectorIndexReady = true;
}

/**
 * Ensure scalar indexes exist on filter columns for fast prefiltering.
 * BTree for high-cardinality (user_id, owner_id), Bitmap for low-cardinality (source_type).
 */
async function ensureScalarIndexes(table: Table): Promise<void> {
  if (scalarIndexReady) return;
  const indexNames = new Set((await table.listIndices()).map((i: any) => i.name || i.indexName || ""));
  const create = async (col: string, config?: any) => {
    // LanceDB names indexes as {col}_idx by convention
    if (indexNames.has(`${col}_idx`)) return;
    try {
      if (config) {
        await table.createIndex(col, { config });
      } else {
        await table.createIndex(col);
      }
    } catch {
      // Index may already exist
    }
  };
  await create("user_id");
  await create("owner_id");
  await create("source_type", Index.bitmap());
  scalarIndexReady = true;
}

/**
 * Ensure FTS index exists on the content column for hybrid search.
 */
async function ensureFtsIndex(table: Table): Promise<void> {
  if (ftsIndexReady) return;
  const indexNames = new Set((await table.listIndices()).map((i: any) => i.name || i.indexName || ""));
  if (indexNames.has("content_idx")) {
    ftsIndexReady = true;
    return;
  }
  try {
    await table.createIndex("content", {
      config: Index.fts(),
    });
  } catch {
    // Index may already exist
  }
  ftsIndexReady = true;
}

export async function optimizeTable(): Promise<void> {
  const conn = await getConnection();
  const exists = await tableExists(conn, EMBEDDINGS_TABLE);
  if (!exists) return;

  const table = await conn.openTable(EMBEDDINGS_TABLE);
  await table.optimize({
    cleanupOlderThan: new Date(),
  });
}

function scheduleOptimize(): void {
  if (optimizeTimer) clearTimeout(optimizeTimer);
  optimizeTimer = setTimeout(async () => {
    optimizeTimer = null;
    try {
      await optimizeTable();
    } catch (err) {
      console.warn("[embeddings] Deferred optimize failed:", err);
    }
  }, OPTIMIZE_DEBOUNCE_MS);
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

  const body: Record<string, any> = {
    model: cfg.model,
    input: texts,
  };
  if (!options?.omitDimensions && cfg.dimensions) body.dimensions = cfg.dimensions;

  const url = resolveEmbeddingUrl(cfg.api_url);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "Embedding request failed");
    throw new Error(`Embedding request failed (${res.status}): ${msg}`);
  }

  const payload = await res.json() as { data?: Array<{ embedding?: number[] }> };
  const vectors = (payload.data || []).map((d) => d.embedding || []);
  if (vectors.length !== texts.length) {
    throw new Error("Embedding provider returned an unexpected number of vectors");
  }
  return vectors;
}

export async function embedTexts(userId: string, texts: string[]): Promise<number[][]> {
  return requestEmbeddings(userId, texts);
}

function getModelFingerprint(cfg: EmbeddingConfig): ModelFingerprint {
  return { provider: cfg.provider, model: cfg.model, dimensions: cfg.dimensions, api_url: cfg.api_url };
}

/**
 * Cache-aware embedding. Checks in-memory LRU cache first, batches only
 * uncached texts to the upstream API, then stores results.
 */
export async function cachedEmbedTexts(userId: string, texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const cfg = await getEmbeddingConfig(userId);
  const fingerprint = getModelFingerprint(cfg);

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

async function getExistingEntryContent(userId: string, entryId: string): Promise<string | null> {
  try {
    const table = await getTableIfExists();
    if (!table) return null;
    const rows = await table
      .query()
      .where(
        `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry' AND source_id = ${sqlValue(entryId)}`
      )
      .select(["content"])
      .limit(1)
      .toArray();
    if (rows.length > 0 && typeof (rows[0] as any).content === "string") {
      return (rows[0] as any).content;
    }
  } catch {
    // Table may not exist yet
  }
  return null;
}

export async function syncWorldBookEntryEmbedding(userId: string, entry: WorldBookEntry): Promise<void> {
  const desiredStatus = getDesiredWorldBookVectorStatus(entry);
  if (!entry.vectorized) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, desiredStatus, null, null);
    return;
  }

  const cfg = await getEmbeddingConfig(userId);
  const content = (entry.content || "").trim();
  if (!cfg.enabled || !cfg.vectorize_world_books || entry.disabled || !content) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, "pending", null, null);
    return;
  }

  try {
    const existing = await getExistingEntryContent(userId, entry.id);
    const now = Math.floor(Date.now() / 1000);

    if (existing === content) {
      updateWorldBookEntryVectorState(entry.id, "indexed", now, null);
      return;
    }

    const [vector] = await cachedEmbedTexts(userId, [content]);
    const row: EmbeddingRow = {
      id: rowId(userId, "world_book_entry", entry.id, 0),
      user_id: userId,
      source_type: "world_book_entry",
      source_id: entry.id,
      owner_id: entry.world_book_id,
      chunk_index: 0,
      content,
      vector,
      metadata_json: JSON.stringify({
        comment: entry.comment,
        key: entry.key,
        keysecondary: entry.keysecondary,
        world_book_id: entry.world_book_id,
      }),
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
    options?.onProgress?.({ ...progress });
  }

  for (const entry of disabledOrEmpty) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, "pending", null, null);
    progress.removed += 1;
    progress.current += 1;
    options?.onProgress?.({ ...progress });
  }

  const cfg = await getEmbeddingConfig(userId);
  if (!cfg.enabled || !cfg.vectorize_world_books) {
    for (const entry of toIndex) {
      await deleteWorldBookEntryEmbeddings(userId, entry.id);
      updateWorldBookEntryVectorState(entry.id, "pending", null, null);
      progress.removed += 1;
      progress.current += 1;
      options?.onProgress?.({ ...progress });
    }
    return progress;
  }

  for (let i = 0; i < toIndex.length; i += batchSize) {
    const batch = toIndex.slice(i, i + batchSize);

    try {
      const texts = batch.map((e) => (e.content || "").trim());
      const vectors = await cachedEmbedTexts(userId, texts);
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
        metadata_json: JSON.stringify({
          comment: entry.comment,
          key: entry.key,
          keysecondary: entry.keysecondary,
          world_book_id: entry.world_book_id,
        }),
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
      options?.onProgress?.({ ...progress });
    } catch (err) {
      console.warn("[embeddings] Batch embedding failed:", err);
      const message = err instanceof Error ? err.message : "Batch vector indexing failed";
      updateWorldBookEntriesVectorState(batch.map((entry) => entry.id), "error", null, message);
      progress.failed += batch.length;
      progress.current += batch.length;
      options?.onProgress?.({ ...progress });
    }
  }

  // Compact all fragments into fewer files and prune old versions
  try {
    await optimizeTable();
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

  const table = await getTableIfExists();
  if (!table) return [];
  const [vector] = await cachedEmbedTexts(userId, [text]);
  const filter = `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry' AND owner_id = ${sqlValue(worldBookId)}`;
  const effectiveLimit = Math.max(1, Math.min(limit, 50));

  // Hybrid search: combine vector similarity with BM25 keyword matching via RRF
  let rows: any[];
  try {
    const reranker = await rerankers.RRFReranker.create();
    rows = await table
      .query()
      .nearestTo(vector)
      .fullTextSearch(text)
      .where(filter)
      .rerank(reranker)
      .select(["source_id", "content", "_distance", "_relevance_score"])
      .limit(effectiveLimit)
      .toArray();
  } catch {
    // FTS index may not exist yet — fall back to vector-only
    rows = await table
      .query()
      .nearestTo(vector)
      .where(filter)
      .select(["source_id", "content", "_distance"])
      .limit(effectiveLimit)
      .toArray();
  }

  return rows.map((row: any) => ({
    entry_id: String(row.source_id),
    score: typeof row._distance === "number" ? row._distance : 0,
    content: String(row.content || ""),
  }));
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
  const table = await getTableIfExists();
  if (!table) return [];
  const rows = await table
    .query()
    .nearestTo(vector)
    .where(
      `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry' AND owner_id = ${sqlValue(worldBookId)}`
    )
    .select(["source_id", "content", "_distance"])
    .limit(Math.max(1, Math.min(limit, 50)))
    .toArray();

  return rows.map((row: any) => ({
    entry_id: String(row.source_id),
    score: typeof row._distance === "number" ? row._distance : 0,
    content: String(row.content || ""),
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

  vectorIndexReady = false;
  scalarIndexReady = false;
  ftsIndexReady = false;
}

/**
 * Force reset the entire LanceDB vector store.
 * Nukes the on-disk LanceDB directory, resets all module state, clears caches,
 * and resets vector index state in SQLite. This is the nuclear option for
 * recovering from corruption (e.g. "vector not divisible by 8" errors).
 */
export async function forceResetLanceDB(): Promise<{ deleted: boolean; path: string }> {
  // 1. Cancel any pending optimize
  if (optimizeTimer) {
    clearTimeout(optimizeTimer);
    optimizeTimer = null;
  }

  // 2. Clear in-memory caches
  embeddingCache.clear();

  // 3. Reset connection state so next access creates a fresh connection
  connPromise = null;
  vectorIndexReady = false;
  scalarIndexReady = false;
  ftsIndexReady = false;

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
): Promise<Array<{ chunk_id: string; score: number; content: string; metadata: any }>> {
  const table = await getTableIfExists();
  if (!table) return [];

  const filter = `user_id = ${sqlValue(userId)} AND source_type = 'chat_chunk' AND owner_id = ${sqlValue(chatId)}`;
  const fetchLimit = Math.max(1, Math.min(limit + 50, 150));

  // Try hybrid search when query text is available
  let rows: any[];
  if (queryText?.trim() && hybridWeightMode !== "vector_first") {
    try {
      const reranker = await rerankers.RRFReranker.create();
      rows = await table
        .query()
        .nearestTo(vector)
        .fullTextSearch(queryText.trim())
        .where(filter)
        .rerank(reranker)
        .select(["source_id", "content", "_distance", "_relevance_score", "metadata_json", "vector"])
        .limit(fetchLimit)
        .toArray();
    } catch {
      // FTS index may not exist yet — fall back to vector-only
      rows = await table
        .query()
        .nearestTo(vector)
        .where(filter)
        .select(["source_id", "content", "_distance", "metadata_json", "vector"])
        .limit(fetchLimit)
        .toArray();
    }
  } else {
    rows = await table
      .query()
      .nearestTo(vector)
      .where(filter)
      .select(["source_id", "content", "_distance", "metadata_json", "vector"])
      .limit(fetchLimit)
      .toArray();
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

import { connect, Index, rerankers, type Connection, type Table } from "@lancedb/lancedb";
import { dirname, join } from "path";
import { mkdirSync, readdirSync, renameSync, rmSync, existsSync, readFileSync } from "fs";
import { env } from "../env";
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
import { describeProviderError } from "../utils/provider-errors";
import { resolveBrokenTermuxLanceDbMirrorPath, resolveLanceDbConnectUri } from "../utils/lancedb-path";
import { chunkDocument } from "./databank/document-chunker.service";
import { loadWorldBookVectorSettings, type WorldBookVectorSettings } from "./world-book-vector-settings.service";

const EMBEDDING_SETTINGS_KEY = "embeddingConfig";
const EMBEDDING_SECRET_KEY = "embedding_api_key";
const LANCEDB_PATH = join(env.dataDir, "lancedb");
const LANCEDB_URI = resolveLanceDbConnectUri(LANCEDB_PATH);
const EMBEDDINGS_TABLE = "embeddings";
const WORLD_BOOK_EMBEDDINGS_TABLE = "embeddings_world_books";
const TERMUX_PATH_PREFIX = "/data/data/com.termux/";
const LANCEDB_TERMUX_LIKE = Boolean(process.env.TERMUX_VERSION)
  || process.env.LUMIVERSE_IS_TERMUX === "true"
  || process.env.LUMIVERSE_IS_PROOT === "true"
  || process.env.PREFIX?.startsWith(TERMUX_PATH_PREFIX) === true
  || process.env.HOME?.startsWith(`${TERMUX_PATH_PREFIX}files/home`) === true
  || LANCEDB_PATH.startsWith(TERMUX_PATH_PREFIX);
const WORLD_BOOK_VECTOR_VERSION = 3;
const WORLD_BOOK_VECTOR_VERSION_KEY = "worldBookVectorVersion";
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
    autoWarmup: input?.autoWarmup !== undefined ? !!input.autoWarmup : d.autoWarmup,
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
export const LTCM_FORMAT_VERSION = 3;

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

let loggedUnknownLegacyWorldBookVectorShape = false;

function coerceLanceVector(raw: unknown): number[] {
  if (raw instanceof Float32Array || raw instanceof Float64Array) {
    return Array.from(raw);
  }
  if (Array.isArray(raw)) {
    return raw.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  }
  if (raw && typeof raw === "object") {
    const iterable = raw as Iterable<unknown>;
    if (typeof (raw as { toArray?: unknown }).toArray === "function") {
      try {
        return coerceLanceVector((raw as { toArray: () => unknown }).toArray());
      } catch {}
    }
    if (typeof iterable[Symbol.iterator] === "function") {
      try {
        return coerceLanceVector(Array.from(iterable));
      } catch {}
    }
    const indexed = raw as { length?: unknown; [key: number]: unknown };
    if (typeof indexed.length === "number" && Number.isFinite(indexed.length) && indexed.length > 0) {
      try {
        const values = Array.from({ length: indexed.length }, (_, idx) => indexed[idx]);
        return coerceLanceVector(values);
      } catch {}
    }
    const candidate = raw as { values?: unknown; data?: unknown; vector?: unknown };
    if (candidate.values !== undefined) return coerceLanceVector(candidate.values);
    if (candidate.data !== undefined) return coerceLanceVector(candidate.data);
    if (candidate.vector !== undefined) return coerceLanceVector(candidate.vector);
    if (!loggedUnknownLegacyWorldBookVectorShape) {
      loggedUnknownLegacyWorldBookVectorShape = true;
      try {
        const ctor = (raw as { constructor?: { name?: string } }).constructor?.name || typeof raw;
        const keys = Object.keys(raw as Record<string, unknown>).slice(0, 12);
        console.warn(`[embeddings] Unknown legacy world-book vector payload shape: constructor=${ctor}; keys=${keys.join(",") || "(none)"}`);
      } catch {}
    }
  }
  return [];
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

let connPromise: Promise<Connection> | null = null;
let connHandle: Connection | null = null;
let connGeneration = 0;
let lancedbPathDiagnosticsLogged = false;
let optimizeTimer: ReturnType<typeof setTimeout> | null = null;
const OPTIMIZE_DEBOUNCE_MS = 15_000; // 15 seconds after last write (reduced from 30s)
/** Grace period for version cleanup — keeps old versions alive long enough for
 *  in-flight reads to complete. Without this, optimize() can delete manifests
 *  that concurrent queries still reference, causing "Object not found" errors. */
const CLEANUP_GRACE_PERIOD_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Write serialization — prevents concurrent LanceDB mutations from racing.
// LanceDB's internal conflict resolver panics when optimize() deletes version
// manifests that in-flight mergeInsert() operations still reference.
// Serializing all writes through a single async mutex eliminates this entirely.
//
// Safety bounds:
//   - Lock acquisition times out after WRITE_LOCK_WAIT_TIMEOUT_MS to prevent
//     unbounded queue growth when LanceDB operations are slow or hung.
//   - The queue is capped at MAX_WRITE_LOCK_QUEUE to reject new work instead
//     of piling up indefinitely behind a slow lock holder.
// ---------------------------------------------------------------------------
const WRITE_LOCK_WAIT_TIMEOUT_MS = 120_000; // 120s max wait to acquire the lock
const MAX_WRITE_LOCK_QUEUE = 50;           // reject if more than 50 waiters queued
const CROSS_PROCESS_WRITE_LOCK_DIR = join(env.dataDir, ".lancedb-write-lock");
const CROSS_PROCESS_WRITE_LOCK_INFO = join(CROSS_PROCESS_WRITE_LOCK_DIR, "owner.json");
const CROSS_PROCESS_WRITE_LOCK_POLL_MS = 250;
const CROSS_PROCESS_WRITE_LOCK_STALE_MS = 5 * 60_000;
const _writeLockQueue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
let _writeLockHeld = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryWriteCrossProcessLockInfo(): void {
  try {
    Bun.write(
      CROSS_PROCESS_WRITE_LOCK_INFO,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: Date.now(),
        cwd: process.cwd(),
      }),
    ).catch(() => {});
  } catch {}
}

function readCrossProcessLockInfo(): { pid?: number; acquiredAt?: number } | null {
  try {
    if (!existsSync(CROSS_PROCESS_WRITE_LOCK_INFO)) return null;
    const raw = readFileSync(CROSS_PROCESS_WRITE_LOCK_INFO, "utf8");
    const parsed = JSON.parse(raw) as { pid?: unknown; acquiredAt?: unknown };
    return {
      pid: typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : undefined,
      acquiredAt: typeof parsed.acquiredAt === "number" && Number.isFinite(parsed.acquiredAt) ? parsed.acquiredAt : undefined,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shouldBreakStaleCrossProcessLock(): boolean {
  if (!existsSync(CROSS_PROCESS_WRITE_LOCK_DIR)) return false;

  const info = readCrossProcessLockInfo();
  const ageMs = info?.acquiredAt ? Date.now() - info.acquiredAt : Number.POSITIVE_INFINITY;
  if (ageMs < CROSS_PROCESS_WRITE_LOCK_STALE_MS) return false;
  if (info?.pid && isProcessAlive(info.pid)) return false;
  return true;
}

async function acquireCrossProcessWriteLockIfNeeded(): Promise<(() => void) | null> {
  if (!LANCEDB_TERMUX_LIKE) return null;

  const startedAt = Date.now();
  while (true) {
    try {
      mkdirSync(CROSS_PROCESS_WRITE_LOCK_DIR, { recursive: false });
      tryWriteCrossProcessLockInfo();
      return () => {
        try {
          rmSync(CROSS_PROCESS_WRITE_LOCK_DIR, { recursive: true, force: true });
        } catch {}
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;

      if (shouldBreakStaleCrossProcessLock()) {
        try {
          rmSync(CROSS_PROCESS_WRITE_LOCK_DIR, { recursive: true, force: true });
          console.warn(`[embeddings] Cleared stale cross-process LanceDB write lock at ${CROSS_PROCESS_WRITE_LOCK_DIR}`);
          continue;
        } catch {}
      }

      const waitedMs = Date.now() - startedAt;
      if (waitedMs >= WRITE_LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(
          `[embeddings] Cross-process LanceDB write lock acquisition timed out after ${WRITE_LOCK_WAIT_TIMEOUT_MS}ms (${CROSS_PROCESS_WRITE_LOCK_DIR})`,
        );
      }

      await sleep(Math.min(CROSS_PROCESS_WRITE_LOCK_POLL_MS, WRITE_LOCK_WAIT_TIMEOUT_MS - waitedMs));
    }
  }
}

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!_writeLockHeld) {
    _writeLockHeld = true;
  } else {
    if (_writeLockQueue.length >= MAX_WRITE_LOCK_QUEUE) {
      throw new Error(`[embeddings] Write lock queue full (${_writeLockQueue.length} waiters) — rejecting to prevent resource exhaustion`);
    }
    await new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      _writeLockQueue.push(entry);
      const timer = setTimeout(() => {
        const idx = _writeLockQueue.indexOf(entry);
        if (idx >= 0) {
          _writeLockQueue.splice(idx, 1);
          reject(new Error(`[embeddings] Write lock acquisition timed out after ${WRITE_LOCK_WAIT_TIMEOUT_MS}ms (${_writeLockQueue.length} still queued)`));
        }
      }, WRITE_LOCK_WAIT_TIMEOUT_MS);
      // Clear the timer if the lock is acquired before timeout
      const origResolve = entry.resolve;
      entry.resolve = () => { clearTimeout(timer); origResolve(); };
    });
  }
  const releaseCrossProcessLock = await acquireCrossProcessWriteLockIfNeeded();
  try {
    return await fn();
  } finally {
    releaseCrossProcessLock?.();
    const next = _writeLockQueue.shift();
    if (next) next.resolve();
    else _writeLockHeld = false;
  }
}

// ---------------------------------------------------------------------------
// Table handle cache — avoids repeated openTable() calls that each hit disk
// to resolve the version manifest. Invalidated on reset/errors.
// ---------------------------------------------------------------------------
interface TableRuntimeState {
  tableHandle: Table | null;
  vectorIndexReady: boolean;
  scalarIndexReady: boolean;
  ftsIndexReady: boolean;
  lastIndexRebuildAt: number;
  unindexedRowEstimate: number;
  indexHealthTimer: ReturnType<typeof setInterval> | null;
}

const tableStates = new Map<string, TableRuntimeState>();

function getTableState(tableName: string): TableRuntimeState {
  let state = tableStates.get(tableName);
  if (!state) {
    state = {
      tableHandle: null,
      vectorIndexReady: false,
      scalarIndexReady: false,
      ftsIndexReady: false,
      lastIndexRebuildAt: 0,
      unindexedRowEstimate: 0,
      indexHealthTimer: null,
    };
    tableStates.set(tableName, state);
  }
  return state;
}

function invalidateTableHandle(tableName?: string): void {
  if (tableName) {
    getTableState(tableName).tableHandle = null;
    return;
  }
  for (const state of tableStates.values()) {
    state.tableHandle = null;
  }
}

function logLanceDbPathDiagnostics(): void {
  if (lancedbPathDiagnosticsLogged || !LANCEDB_TERMUX_LIKE) return;
  lancedbPathDiagnosticsLogged = true;
  console.info(
    `[embeddings] LanceDB path config: path=${LANCEDB_PATH}; uri=${LANCEDB_URI}; cwd=${process.cwd()}; tmpdir=${process.env.TMPDIR || "(unset)"}`,
  );
  if (process.cwd() === "/") {
    console.warn(
      "[embeddings] Process cwd is / on Termux; keeping LanceDB URI absolute to avoid generating data/data/com.termux/...",
    );
  }
}

function collectErrorMessages(err: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = err;
  let depth = 0;
  while (current && depth < 8) {
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
    } else if (typeof current === "object") {
      const candidate = current as { message?: unknown; cause?: unknown };
      if (typeof candidate.message === "string") messages.push(candidate.message);
      else messages.push(String(current));
      current = candidate.cause;
    } else {
      messages.push(String(current));
      break;
    }
    depth += 1;
  }
  return messages.filter(Boolean);
}

function isIncompleteEmbeddingsTableError(err: unknown, tableName: string): boolean {
  const text = collectErrorMessages(err).join(" | ").toLowerCase();
  if (!text) return false;
  if (!text.includes(`${tableName}.lance`) && !text.includes(`table '${tableName}' was not found`)) {
    return false;
  }
  return (
    text.includes("/_versions") ||
    text.includes("\\_versions") ||
    text.includes("dataset at path") ||
    text.includes("table 'embeddings' was not found")
  );
}

function resetInMemoryVectorStoreState(): void {
  if (optimizeTimer) {
    clearTimeout(optimizeTimer);
    optimizeTimer = null;
  }
  optimizeQueuedAt = null;
  stopIndexHealthMonitor();
  embeddingCache.clear();

  try {
    for (const state of tableStates.values()) {
      state.tableHandle?.close();
    }
  } catch {}
  try {
    connHandle?.close();
  } catch {}

  connGeneration += 1;
  connHandle = null;
  connPromise = null;
  invalidateTableHandle();
  for (const state of tableStates.values()) {
    state.vectorIndexReady = false;
    state.scalarIndexReady = false;
    state.ftsIndexReady = false;
    state.lastIndexRebuildAt = 0;
    state.unindexedRowEstimate = 0;
    if (state.indexHealthTimer) {
      clearInterval(state.indexHealthTimer);
      state.indexHealthTimer = null;
    }
  }
}

function resetSqliteVectorizationState(): void {
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
}

function performBrokenEmbeddingsTableRecovery(reason: string, err: unknown): void {
  resetInMemoryVectorStoreState();

  // This store only contains one shared table, so deleting just embeddings.lance
  // can leave parent-level LanceDB metadata claiming the table still exists.
  // Reset the entire store so the next operation can recreate it cleanly.
  const deleted = existsSync(LANCEDB_PATH);
  if (deleted) {
    rmSync(LANCEDB_PATH, { recursive: true, force: true });
  }
  resetSqliteVectorizationState();
  console.warn(`[embeddings] Recovered incomplete LanceDB table after ${reason}; deleted ${LANCEDB_PATH}`, err);
}

async function recoverBrokenEmbeddingsTable(tableName: string, reason: string, err: unknown, lockHeld = false): Promise<boolean> {
  if (!isIncompleteEmbeddingsTableError(err, tableName)) return false;
  if (lockHeld) {
    performBrokenEmbeddingsTableRecovery(reason, err);
    return true;
  }
  await withWriteLock(async () => {
    performBrokenEmbeddingsTableRecovery(reason, err);
  });
  return true;
}

function isEmbeddingsTableSchemaDriftError(err: unknown): boolean {
  const text = collectErrorMessages(err).join(" | ").toLowerCase();
  if (!text) return false;
  if (text.includes("vector not divisible by 8")) return true;

  const mentionsVectorSchema =
    text.includes("fixedsizelist") ||
    text.includes("fixed_size_list") ||
    text.includes("vector");
  const mentionsShapeMismatch =
    text.includes("dimension") ||
    text.includes("dimensionality") ||
    text.includes("length") ||
    text.includes("schema") ||
    (text.includes("expected") && text.includes("got"));

  return mentionsVectorSchema && mentionsShapeMismatch;
}

async function retryAfterSchemaDriftReset<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isEmbeddingsTableSchemaDriftError(err)) throw err;
    console.warn(`[embeddings] ${reason} hit schema drift; force-resetting LanceDB and retrying once`, err);
    await forceResetLanceDB();
    return await fn();
  }
}

function tableNameForRows(rows: EmbeddingRow[]): string {
  if (rows.every((row) => row.source_type === "world_book_entry")) {
    return WORLD_BOOK_EMBEDDINGS_TABLE;
  }
  return EMBEDDINGS_TABLE;
}

async function upsertEmbeddingRows(rows: EmbeddingRow[], reason: string): Promise<void> {
  if (rows.length === 0) return;
  const tableName = tableNameForRows(rows);
  await retryAfterSchemaDriftReset(reason, async () => {
    await withWriteLock(async () => {
      const table = await getOrCreateTable(tableName, rows, true);
      await ensureVectorIndex(tableName, table);
      await ensureScalarIndexes(tableName, table);
      await ensureFtsIndex(tableName, table);
      await table
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(asLanceRows(rows));
    });
  });
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

function sqlValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function rowId(userId: string, sourceType: string, sourceId: string, chunkIndex: number): string {
  return `${userId}:${sourceType}:${sourceId}:${chunkIndex}`;
}

let termuxMirrorCleanupAttempted = false;

function pruneEmptyAncestors(path: string, stopAt: string): void {
  let current = dirname(path);
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      if (readdirSync(current).length > 0) break;
      rmSync(current, { recursive: false, force: true });
    } catch {
      break;
    }
    current = dirname(current);
  }
}

function cleanupBrokenTermuxLanceDbMirror(): void {
  if (termuxMirrorCleanupAttempted) return;
  termuxMirrorCleanupAttempted = true;

  const brokenPath = resolveBrokenTermuxLanceDbMirrorPath(LANCEDB_PATH);
  if (!brokenPath || brokenPath === LANCEDB_PATH || !existsSync(brokenPath)) return;

  const workspaceRoot = process.cwd();
  try {
    if (existsSync(LANCEDB_PATH)) {
      rmSync(brokenPath, { recursive: true, force: true });
      pruneEmptyAncestors(brokenPath, workspaceRoot);
      console.warn(`[embeddings] Removed broken Termux LanceDB mirror at ${brokenPath}`);
      return;
    }

    mkdirSync(dirname(LANCEDB_PATH), { recursive: true });
    renameSync(brokenPath, LANCEDB_PATH);
    pruneEmptyAncestors(brokenPath, workspaceRoot);
    console.warn(`[embeddings] Moved broken Termux LanceDB mirror into place: ${brokenPath} -> ${LANCEDB_PATH}`);
  } catch (err) {
    console.warn(`[embeddings] Failed to clean up broken Termux LanceDB mirror at ${brokenPath}`, err);
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

async function getConnection(): Promise<Connection> {
  if (connHandle) return connHandle;

  const generation = connGeneration;
  logLanceDbPathDiagnostics();
  cleanupBrokenTermuxLanceDbMirror();
  if (!connPromise) connPromise = connect(LANCEDB_URI);

  const conn = await connPromise;
  if (generation !== connGeneration) {
    try {
      conn.close();
    } catch {}
    return getConnection();
  }

  connHandle = conn;
  return conn;
}

async function tableExists(conn: Connection, name: string): Promise<boolean> {
  const names = await conn.tableNames();
  return names.includes(name);
}

async function getTableIfExists(tableName = EMBEDDINGS_TABLE, lockHeld = false): Promise<Table | null> {
  const state = getTableState(tableName);
  if (state.tableHandle) return state.tableHandle;
  const conn = await getConnection();
  const exists = await tableExists(conn, tableName);
  if (!exists) return null;
  try {
    state.tableHandle = await conn.openTable(tableName);
  } catch (err) {
    if (await recoverBrokenEmbeddingsTable(tableName, `opening ${tableName} table`, err, lockHeld)) {
      return null;
    }
    throw err;
  }
  return state.tableHandle;
}

async function getOrCreateTable(tableName = EMBEDDINGS_TABLE, seedRows?: EmbeddingRow[], lockHeld = false): Promise<Table> {
  const state = getTableState(tableName);
  if (state.tableHandle) return state.tableHandle;
  let conn = await getConnection();
  const exists = await tableExists(conn, tableName);
  if (exists) {
    try {
      state.tableHandle = await conn.openTable(tableName);
      return state.tableHandle;
    } catch (err) {
      if (!(await recoverBrokenEmbeddingsTable(tableName, `opening ${tableName} before write`, err, lockHeld))) {
        throw err;
      }
      conn = await getConnection();
    }
  }
  if (!seedRows || seedRows.length === 0) {
    throw new Error("Cannot create embeddings table without initial seed rows to infer schema.");
  }
  try {
    state.tableHandle = await conn.createTable(tableName, asLanceRows(seedRows));
  } catch (err) {
    if (!(await recoverBrokenEmbeddingsTable(tableName, `creating ${tableName}`, err, lockHeld))) {
      throw err;
    }
    conn = await getConnection();
    state.tableHandle = await conn.createTable(tableName, asLanceRows(seedRows));
  }
  return state.tableHandle;
}

const MIN_ROWS_FOR_VECTOR_INDEX = 5_000;
const MIN_ROWS_FOR_PQ_VECTOR_INDEX = 65_536;
const MAX_LANCE_SOURCE_FILTER_IDS = 250;
const OPTIMIZE_MAX_WAIT_MS = 2 * 60_000; // 2 minutes (reduced from 5 min to prevent fragment buildup)
const CHAT_OPTIMIZE_MIN_INTERVAL_MS = 30 * 60_000; // Avoid full-table optimize churn from active chat writes
let optimizeQueuedAt: number | null = null;
let lastChatOptimizeScheduledAt = 0;
let optimizeWorldBooksQueued = false;

// ---------------------------------------------------------------------------
// Index health tracking — detect when indexes need rebuilding
// ---------------------------------------------------------------------------
const INDEX_REBUILD_COOLDOWN_MS = 10 * 60_000; // Don't rebuild more than once per 10 min
const UNINDEXED_ROW_THRESHOLD = 2_000; // Rebuild when this many rows are unindexed
const INDEX_HEALTH_CHECK_INTERVAL_MS = 2 * 60_000; // Check index health every 2 min

function getVectorIndexPartitions(rowCount: number): number | null {
  if (rowCount < MIN_ROWS_FOR_VECTOR_INDEX) return null;

  // LanceDB's IVF_PQ training becomes noisy when partitions outpace the data.
  // Keep at least 256 rows per partition to avoid empty-cluster warnings.
  return Math.max(2, Math.min(
    Math.floor(Math.sqrt(rowCount)),
    Math.floor(rowCount / 256),
  ));
}

function getVectorIndexConfig(rowCount: number): any | null {
  const numPartitions = getVectorIndexPartitions(rowCount);
  if (numPartitions === null) return null;

  if (rowCount < MIN_ROWS_FOR_PQ_VECTOR_INDEX) {
    return Index.ivfFlat({
      distanceType: "cosine",
      numPartitions,
    } as any);
  }

  return Index.ivfPq({
    distanceType: "cosine",
    numPartitions,
  } as any);
}

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
    await withWriteLock(async () => {
      const table = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE, true);
      if (table) {
        await table.delete(
          `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry'`
        );
      }
    });
    scheduleOptimize("world_book");
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

async function ensureVectorIndex(tableName: string, table: Table): Promise<void> {
  const state = getTableState(tableName);
  if (state.vectorIndexReady) return;
  try {
    const rowCount = await table.countRows();
    const indexConfig = getVectorIndexConfig(rowCount);
    if (indexConfig === null) {
      // Brute-force search is fast enough for small tables and avoids
      // KMeans warnings about empty clusters when rows < num_partitions * 256.
      state.vectorIndexReady = true;
      return;
    }
    await table.createIndex("vector", {
      config: indexConfig,
    } as any);
  } catch {
    // Index may already exist - that's fine
  }
  state.vectorIndexReady = true;
  state.lastIndexRebuildAt = Date.now();
  if (tableName !== WORLD_BOOK_EMBEDDINGS_TABLE) {
    startIndexHealthMonitor(tableName);
  }
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
async function ensureScalarIndexes(tableName: string, table: Table, force = false): Promise<void> {
  const state = getTableState(tableName);
  if (state.scalarIndexReady && !force) return;

  let indexNames: Set<string>;
  try {
    indexNames = new Set((await table.listIndices()).map((i: any) => i.name || i.indexName || ""));
  } catch {
    // listIndices can fail if index files are orphaned from a previous compaction.
    // Treat as empty so every index gets (re)created below.
    indexNames = new Set();
  }

  const create = async (col: string, config?: any) => {
    // LanceDB names indexes as {col}_idx by convention
    if (!force && indexNames.has(`${col}_idx`)) return;
    try {
      const opts: any = config ? { config } : {};
      if (force && indexNames.has(`${col}_idx`)) opts.replace = true;
      await table.createIndex(col, opts);
    } catch (err) {
      // replace: true can fail when the old index references orphaned files.
      // Fall back to a plain create (LanceDB overwrites by column name).
      if (force) {
        try {
          const opts: any = config ? { config } : {};
          await table.createIndex(col, opts);
        } catch {
          // Index may already exist in a usable state
        }
      }
    }
  };
  await create("id"); // Critical for mergeInsert("id") join performance
  await create("user_id");
  await create("owner_id");
  await create("source_id");
  if (tableName !== WORLD_BOOK_EMBEDDINGS_TABLE) {
    await create("source_type", Index.bitmap());
  }
  state.scalarIndexReady = true;
}

/**
 * Ensure FTS index exists on the content column for hybrid search.
 * When `force` is true, the index is rebuilt even if it already exists.
 */
async function ensureFtsIndex(tableName: string, table: Table, force = false): Promise<void> {
  const state = getTableState(tableName);
  if (state.ftsIndexReady && !force) return;

  let indexNames: Set<string>;
  try {
    indexNames = new Set((await table.listIndices()).map((i: any) => i.name || i.indexName || ""));
  } catch {
    indexNames = new Set();
  }

  if (!force && indexNames.has("content_idx")) {
    state.ftsIndexReady = true;
    return;
  }
  try {
    const opts: any = { config: Index.fts() };
    if (force && indexNames.has("content_idx")) opts.replace = true;
    await table.createIndex("content", opts);
  } catch {
    if (force) {
      try {
        await table.createIndex("content", { config: Index.fts() });
      } catch {
        // Index may already exist in a usable state
      }
    }
  }
  state.ftsIndexReady = true;
}

/**
 * Periodic index health monitor. Checks unindexed row count and triggers
 * a vector index rebuild when too many rows have drifted out of the index
 * (which happens naturally with mergeInsert updates).
 */
function startIndexHealthMonitor(tableName = EMBEDDINGS_TABLE): void {
  const state = getTableState(tableName);
  if (state.indexHealthTimer) return;
  state.indexHealthTimer = setInterval(async () => {
    try {
      const table = await getTableIfExists(tableName);
      if (table) await checkAndRebuildIndexes(tableName, table);
    } catch (err) {
      console.warn(`[embeddings] Index health check failed for ${tableName}:`, err);
    }
  }, INDEX_HEALTH_CHECK_INTERVAL_MS);
}

export function stopIndexHealthMonitor(tableName?: string): void {
  if (tableName) {
    const state = getTableState(tableName);
    if (state.indexHealthTimer) {
      clearInterval(state.indexHealthTimer);
      state.indexHealthTimer = null;
    }
    return;
  }
  for (const state of tableStates.values()) {
    if (state.indexHealthTimer) {
      clearInterval(state.indexHealthTimer);
      state.indexHealthTimer = null;
    }
  }
}

async function checkAndRebuildIndexes(tableName: string, table: Table): Promise<void> {
  const state = getTableState(tableName);
  const now = Date.now();
  if (now - state.lastIndexRebuildAt < INDEX_REBUILD_COOLDOWN_MS) return;

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
      if (optimizeQueuedAt !== null && now - state.lastIndexRebuildAt > INDEX_REBUILD_COOLDOWN_MS * 3) {
        unindexed = UNINDEXED_ROW_THRESHOLD; // Force rebuild
      }
    }
    state.unindexedRowEstimate = unindexed;

    if (unindexed >= UNINDEXED_ROW_THRESHOLD) {
      console.info(`[embeddings] ${unindexed} unindexed rows detected, rebuilding vector index...`);
      await withWriteLock(async () => {
        const t = await getTableIfExists(tableName, true);
        if (!t) return;
        const rowCount = await t.countRows();
        const indexConfig = getVectorIndexConfig(rowCount);
        if (indexConfig === null) {
          state.vectorIndexReady = true;
          state.unindexedRowEstimate = 0;
          state.lastIndexRebuildAt = Date.now();
          return;
        }
        await t.createIndex("vector", {
          config: indexConfig,
          replace: true,
        } as any);
        state.lastIndexRebuildAt = Date.now();
        state.unindexedRowEstimate = 0;
        console.info(`[embeddings] Vector index rebuilt (${rowCount} rows)`);
      });
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
  const migration = await migrateWorldBookRowsToDedicatedTable();
  if (migration.migratedRows > 0) {
    console.info(`[embeddings] Startup WI split complete: migrated ${migration.migratedRows} row(s) to ${WORLD_BOOK_EMBEDDINGS_TABLE}`);
  } else if (migration.legacyRowsFound) {
    console.warn(`[embeddings] Startup WI split: legacy world-book rows still appear present in ${EMBEDDINGS_TABLE}`);
  }
  const tablesToMaintain = [EMBEDDINGS_TABLE, WORLD_BOOK_EMBEDDINGS_TABLE];

  await withWriteLock(async () => {
    for (const tableName of tablesToMaintain) {
      const exists = await tableExists(conn, tableName);
      if (!exists) continue;
      const table = await getTableIfExists(tableName, true);
      if (!table) continue;
      const state = getTableState(tableName);

      let indices: any[];
      try {
        indices = await table.listIndices();
      } catch {
        indices = [];
      }
      const vectorIdx = indices.find((i: any) => {
        const name = i.name || i.indexName || "";
        return name.includes("vector");
      });
      const idxType = vectorIdx ? ((vectorIdx as any).indexType || (vectorIdx as any).type || "") : "";
      const needsMigration = vectorIdx && /hnsw/i.test(idxType);

      try {
        console.info(`[embeddings] Running startup compaction for ${tableName}...`);
        await table.optimize({ cleanupOlderThan: new Date(Date.now() - CLEANUP_GRACE_PERIOD_MS) });
      } catch (err) {
        console.warn(`[embeddings] Startup compaction failed for ${tableName}:`, err);
      }

      if (needsMigration) {
        const rowCount = await table.countRows();
        const indexConfig = getVectorIndexConfig(rowCount);
        if (indexConfig !== null) {
          console.info(`[embeddings] Migrating vector index for ${tableName} from HNSW_PQ → IVF (${rowCount} rows)...`);
          try {
            await table.createIndex("vector", {
              config: indexConfig,
              replace: true,
            } as any);
            state.vectorIndexReady = true;
            state.lastIndexRebuildAt = Date.now();
            console.info(`[embeddings] Vector index migrated successfully for ${tableName}`);
          } catch (err) {
            console.warn(`[embeddings] Vector index migration failed for ${tableName} (will retry on next query):`, err);
          }
        }
      }

      await ensureScalarIndexes(tableName, table, true);
      await ensureFtsIndex(tableName, table, true);
      await ensureVectorIndex(tableName, table);
    }
  });

  startIndexHealthMonitor(EMBEDDINGS_TABLE);
}

export async function optimizeTable(tableNames?: string[]): Promise<void> {
  const targets = tableNames && tableNames.length > 0
    ? tableNames
    : [EMBEDDINGS_TABLE, WORLD_BOOK_EMBEDDINGS_TABLE];
  await withWriteLock(async () => {
    for (const tableName of targets) {
      try {
        const table = await getTableIfExists(tableName, true);
        if (!table) continue;

        await table.optimize({
          cleanupOlderThan: new Date(Date.now() - CLEANUP_GRACE_PERIOD_MS),
        });

        await ensureScalarIndexes(tableName, table, true);
        await ensureFtsIndex(tableName, table, true);
      } catch (err) {
        console.warn(`[embeddings] Optimize failed for ${tableName}:`, err);
      }
    }
  });
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
  tables?: Record<string, {
    exists: boolean;
    rowCount: number;
    vectorIndexReady: boolean;
    scalarIndexReady: boolean;
    ftsIndexReady: boolean;
    unindexedRowEstimate: number;
    lastIndexRebuildAt: number;
    indexes: Array<{ name: string; type?: string }>;
  }>;
}> {
  // Keep operator-panel health aligned with the read path: if startup migration
  // hasn't run yet, try the same lazy world-book migration before reporting the
  // dedicated table as missing/empty.
  try {
    await migrateWorldBookRowsToDedicatedTable();
  } catch (err) {
    console.warn("[embeddings] Vector store health lazy WI migration failed:", err);
  }

  const readTableHealth = async (tableName: string) => {
    const table = await getTableIfExists(tableName);
    const state = getTableState(tableName);
    if (!table) {
      return {
        exists: false,
        rowCount: 0,
        vectorIndexReady: state.vectorIndexReady,
        scalarIndexReady: state.scalarIndexReady,
        ftsIndexReady: state.ftsIndexReady,
        unindexedRowEstimate: 0,
        lastIndexRebuildAt: 0,
        indexes: [],
      };
    }

    const rowCount = await table.countRows();
    let indices: any[];
    try {
      indices = await table.listIndices();
    } catch {
      try {
        await withWriteLock(async () => {
          const t = await getTableIfExists(tableName, true);
          if (t) {
            await ensureScalarIndexes(tableName, t, true);
            await ensureFtsIndex(tableName, t, true);
          }
        });
        indices = await table.listIndices();
      } catch {
        indices = [];
      }
    }

    return {
      exists: true,
      rowCount,
      vectorIndexReady: state.vectorIndexReady,
      scalarIndexReady: state.scalarIndexReady,
      ftsIndexReady: state.ftsIndexReady,
      unindexedRowEstimate: state.unindexedRowEstimate,
      lastIndexRebuildAt: state.lastIndexRebuildAt,
      indexes: indices.map((i: any) => ({
        name: i.name || i.indexName || "unknown",
        type: i.indexType || i.type || undefined,
      })),
    };
  };

  const runtime = await readTableHealth(EMBEDDINGS_TABLE);
  const worldBooks = await readTableHealth(WORLD_BOOK_EMBEDDINGS_TABLE);
  const combinedExists = runtime.exists || worldBooks.exists;
  const combinedRowCount = runtime.rowCount + worldBooks.rowCount;
  const combinedUnindexedRowEstimate = runtime.unindexedRowEstimate + worldBooks.unindexedRowEstimate;
  const combinedLastIndexRebuildAt = Math.max(runtime.lastIndexRebuildAt, worldBooks.lastIndexRebuildAt);
  const combinedIndexes = [
    ...runtime.indexes.map((idx) => ({
      name: `${EMBEDDINGS_TABLE}:${idx.name}`,
      type: idx.type,
    })),
    ...worldBooks.indexes.map((idx) => ({
      name: `${WORLD_BOOK_EMBEDDINGS_TABLE}:${idx.name}`,
      type: idx.type,
    })),
  ];

  return {
    exists: combinedExists,
    rowCount: combinedRowCount,
    vectorIndexReady: (!runtime.exists || runtime.vectorIndexReady) && (!worldBooks.exists || worldBooks.vectorIndexReady),
    scalarIndexReady: (!runtime.exists || runtime.scalarIndexReady) && (!worldBooks.exists || worldBooks.scalarIndexReady),
    ftsIndexReady: (!runtime.exists || runtime.ftsIndexReady) && (!worldBooks.exists || worldBooks.ftsIndexReady),
    unindexedRowEstimate: combinedUnindexedRowEstimate,
    lastIndexRebuildAt: combinedLastIndexRebuildAt,
    indexes: combinedIndexes,
    tables: {
      [EMBEDDINGS_TABLE]: runtime,
      [WORLD_BOOK_EMBEDDINGS_TABLE]: worldBooks,
    },
  };
}

function scheduleOptimize(reason: "general" | "chat_chunk" | "world_book" = "general"): void {
  const now = Date.now();
  if (reason === "chat_chunk") {
    // Chat memory writes are high-frequency, but they share the same Lance table
    // as large static world-book corpora. Running full optimize/index rebuilds on
    // every chat-churn window can make disk usage balloon during active chats.
    // Rate-limit the background optimize for chat-only writes and leave startup,
    // manual, and bulk world-book/databank maintenance paths unchanged.
    if (now - lastChatOptimizeScheduledAt < CHAT_OPTIMIZE_MIN_INTERVAL_MS) {
      return;
    }
    lastChatOptimizeScheduledAt = now;
  }
  if (reason === "world_book") {
    optimizeWorldBooksQueued = true;
  }
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
      const includeWorldBooks = optimizeWorldBooksQueued;
      optimizeWorldBooksQueued = false;
      await optimizeTable(includeWorldBooks ? undefined : [EMBEDDINGS_TABLE]);
    } catch (err) {
      console.warn("[embeddings] Deferred optimize failed:", err);
    }
  }, delay);
}

async function migrateWorldBookRowsToDedicatedTable(): Promise<{ migratedRows: number; legacyRowsFound: boolean }> {
  let migratedRowsCount = 0;
  await withWriteLock(async () => {
    const runtimeTable = await getTableIfExists(EMBEDDINGS_TABLE, true);
    if (!runtimeTable) return;

    const rows = await runtimeTable
      .query()
      .where(`source_type = 'world_book_entry'`)
      .select(["id", "user_id", "source_type", "source_id", "owner_id", "chunk_index", "content", "vector", "metadata_json", "updated_at"])
      .toArray();

    if ((rows as any[]).length === 0) return;

    const migratedRows: EmbeddingRow[] = (rows as any[]).map((row) => ({
      id: String(row.id),
      user_id: String(row.user_id),
      source_type: String(row.source_type),
      source_id: String(row.source_id),
      owner_id: String(row.owner_id),
      chunk_index: Number(row.chunk_index ?? 0),
      content: String(row.content || ""),
      vector: coerceLanceVector(row.vector),
      metadata_json: typeof row.metadata_json === "string" ? row.metadata_json : JSON.stringify(row.metadata_json ?? {}),
      updated_at: Number(row.updated_at ?? Math.floor(Date.now() / 1000)),
    })).filter((row) => row.vector.length > 0);

    if (migratedRows.length === 0) {
      console.warn("[embeddings] World-book migration found legacy rows, but none exposed a usable vector payload");
      return;
    }

    const worldBookTable = await getOrCreateTable(WORLD_BOOK_EMBEDDINGS_TABLE, migratedRows, true);
    await ensureVectorIndex(WORLD_BOOK_EMBEDDINGS_TABLE, worldBookTable);
    await ensureScalarIndexes(WORLD_BOOK_EMBEDDINGS_TABLE, worldBookTable);
    await ensureFtsIndex(WORLD_BOOK_EMBEDDINGS_TABLE, worldBookTable);
    await worldBookTable
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(asLanceRows(migratedRows));

    const migratedEntryIds = [...new Set(migratedRows.map((row) => row.source_id))];
    const latestUpdatedAt = migratedRows.reduce((max, row) => Math.max(max, row.updated_at), 0);
    updateWorldBookEntriesVectorState(migratedEntryIds, "indexed", latestUpdatedAt || Math.floor(Date.now() / 1000), null);

    await runtimeTable.delete(`source_type = 'world_book_entry'`);
    migratedRowsCount = migratedRows.length;
    console.info(`[embeddings] Migrated ${migratedRows.length} world-book embedding row(s) into ${WORLD_BOOK_EMBEDDINGS_TABLE}`);
  });

  if (migratedRowsCount > 0) {
    return { migratedRows: migratedRowsCount, legacyRowsFound: true };
  }

  const runtimeTable = await getTableIfExists(EMBEDDINGS_TABLE);
  if (!runtimeTable) {
    return { migratedRows: 0, legacyRowsFound: false };
  }

  try {
    const legacyRows = await runtimeTable
      .query()
      .where(`source_type = 'world_book_entry'`)
      .select(["id"])
      .limit(1)
      .toArray();
    if (legacyRows.length === 0) {
      return { migratedRows: 0, legacyRowsFound: false };
    }
  } catch {}

  return { migratedRows: 0, legacyRowsFound: true };
}

async function getWorldBookTableForRead(): Promise<Table | null> {
  let table = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE);
  if (table) return table;

  // Startup maintenance runs fire-and-forget, so the first world-book search can
  // arrive before the dedicated table has been created. Try the migration lazily.
  try {
    await migrateWorldBookRowsToDedicatedTable();
  } catch (err) {
    console.warn("[embeddings] Lazy world-book table migration failed:", err);
  }

  table = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE);
  if (table) return table;

  // Final fallback: if legacy rows still exist in the runtime table, read them
  // there rather than returning an empty result during migration rollout.
  const legacyTable = await getTableIfExists(EMBEDDINGS_TABLE);
  if (!legacyTable) return null;
  try {
    const legacyRows = await legacyTable
      .query()
      .where(`source_type = 'world_book_entry'`)
      .select(["id"])
      .limit(1)
      .toArray();
    return legacyRows.length > 0 ? legacyTable : null;
  } catch {
    return null;
  }
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
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      if (externalSignal?.aborted) throw err;
      throw new Error(`Vertex embedding request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    cleanup();
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => "Vertex embedding request failed");
    throw new Error(`Vertex embedding request failed (${res.status}): ${msg}`);
  }
  return (await res.json()) as T;
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
  if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");

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
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      // Distinguish external cancel (caller-initiated) from our own timeout.
      if (options?.signal?.aborted) throw err;
      throw new Error(`Embedding request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  } finally {
    cleanup();
  }

  if (!res.ok) {
    const msg = await res.text().catch(() => "Embedding request failed");
    throw new Error(`Embedding request failed (${res.status}): ${msg}`);
  }

  const payload = await res.json() as any;
  const vectors = parseEmbeddingResponse(payload, texts.length);
  return vectors;
}

export async function embedTexts(
  userId: string,
  texts: string[],
  options?: { signal?: AbortSignal },
): Promise<number[][]> {
  return requestEmbeddings(userId, texts, options);
}

function getModelFingerprint(cfg: EmbeddingConfig): ModelFingerprint {
  // For Vertex the `api_url` field is cosmetic — the effective endpoint is
  // derived from `vertex_region`. Encode it into the fingerprint so a region
  // change still invalidates cached vectors.
  const api_url = cfg.provider === "google_vertex"
    ? `vertex:${cfg.vertex_region || "global"}`
    : cfg.api_url;
  return { provider: cfg.provider, model: cfg.model, dimensions: cfg.dimensions, api_url };
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
  if (options?.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
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
  onItemFailed: (items: T[], error: Error) => void,
  options?: { signal?: AbortSignal; label?: string },
): Promise<void> {
  if (items.length === 0) return;
  const bs = Math.max(1, Math.min(initialBatchSize, 200));
  const label = options?.label ?? "embed";

  const process = async (batch: T[], currentSize: number): Promise<void> => {
    if (options?.signal?.aborted) {
      onItemFailed(batch, options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Aborted"));
      return;
    }
    const texts = batch.map(getText);
    try {
      const vectors = await cachedEmbedTexts(userId, texts, { signal: options?.signal });
      await onBatchReady(batch, texts, vectors);
    } catch (err) {
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
        onItemFailed(
          batch,
          new Error(
            `${e.message} — a single input still exceeds the server's physical batch size. ` +
            `For llama.cpp, restart llama-server with a larger --ubatch-size / -ub (and matching --batch-size / -b), ` +
            `or reduce the source chunk size.`,
          ),
        );
      } else {
        onItemFailed(batch, e);
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

/** Race a shared promise against an abort signal so the caller's await can
 *  reject on cancel without killing the shared upstream request. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      v => { signal.removeEventListener("abort", onAbort); resolve(v); },
      e => { signal.removeEventListener("abort", onAbort); reject(e); },
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
  await withWriteLock(async () => {
    const table = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE, true);
    if (!table) return;
    await deleteWorldBookEntryRowsFromTable(table, userId, [entryId]);
  });
  scheduleOptimize("world_book");
}

async function deleteWorldBookEntryRowsFromTable(table: Table, userId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  const sourceFilter = `source_id IN (${entryIds.map((id) => sqlValue(id)).join(", ")})`;
  await table.delete(
    `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry' AND (${sourceFilter})`
  );
}

async function deleteWorldBookEntryEmbeddingsBatch(userId: string, entryIds: string[]): Promise<void> {
  if (entryIds.length === 0) return;
  await withWriteLock(async () => {
    const table = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE, true);
    if (!table) return;
    await deleteWorldBookEntryRowsFromTable(table, userId, entryIds);
  });
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

export async function syncWorldBookEntryEmbedding(userId: string, entry: WorldBookEntry): Promise<void> {
  await ensureWorldBookVectorVersion(userId);
  const desiredStatus = getDesiredWorldBookVectorStatus(entry);
  if (!entry.vectorized) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, desiredStatus, null, null);
    return;
  }

  const cfg = await getEmbeddingConfig(userId);
  const worldBookSettings = loadWorldBookVectorSettings(userId, {
    retrievalTopK: cfg.retrieval_top_k,
  });
  const chunks = buildWorldBookEntryEmbeddingChunks(entry, worldBookSettings);
  if (!cfg.enabled || !cfg.vectorize_world_books || entry.disabled || chunks.length === 0) {
    await deleteWorldBookEntryEmbeddings(userId, entry.id);
    updateWorldBookEntryVectorState(entry.id, "not_enabled", null, null);
    return;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const vectors = await cachedEmbedTexts(userId, chunks.map((chunk) => chunk.searchText));
    const rows = buildWorldBookEmbeddingRows(userId, entry, chunks, vectors, now);

    await retryAfterSchemaDriftReset("world-book entry sync", async () => {
      await withWriteLock(async () => {
        const table = await getOrCreateTable(WORLD_BOOK_EMBEDDINGS_TABLE, rows, true);
        await ensureVectorIndex(WORLD_BOOK_EMBEDDINGS_TABLE, table);
        await ensureScalarIndexes(WORLD_BOOK_EMBEDDINGS_TABLE, table);
        await ensureFtsIndex(WORLD_BOOK_EMBEDDINGS_TABLE, table);
        await deleteWorldBookEntryRowsFromTable(table, userId, [entry.id]);
        await table
          .mergeInsert("id")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(asLanceRows(rows));
      });
    });

    updateWorldBookEntryVectorState(entry.id, "indexed", now, null);
    scheduleOptimize("world_book");
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
  const alreadyIndexed: WorldBookEntry[] = [];

  for (const entry of entries) {
    if (entry.vector_index_status === "indexed") {
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
  const allEntryGroups = toIndex.map((entry) => ({
    entry,
    chunks: buildWorldBookEntryEmbeddingChunks(entry, worldBookSettings),
  }));
  const entryGroups = allEntryGroups.filter((group) => group.chunks.length > 0);
  const emptiedEntries = allEntryGroups.filter((group) => group.chunks.length === 0);
  progress.eligible = entryGroups.length;

  for (const group of emptiedEntries) {
    await deleteWorldBookEntryEmbeddings(userId, group.entry.id);
    updateWorldBookEntryVectorState(group.entry.id, "indexed", Math.floor(Date.now() / 1000), null);
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
      const rows: EmbeddingRow[] = [];
      const vectorSlices = new Map<string, number[][]>();
      let offset = 0;
      for (const group of groups) {
        const slice = vectors.slice(offset, offset + group.chunks.length);
        vectorSlices.set(group.entry.id, slice);
        offset += group.chunks.length;
      }
      for (const group of groups) {
        rows.push(...buildWorldBookEmbeddingRows(
          userId,
          group.entry,
          group.chunks,
          vectorSlices.get(group.entry.id) ?? [],
          now,
        ));
      }

      await retryAfterSchemaDriftReset("world-book reindex batch", async () => {
        await withWriteLock(async () => {
          const table = await getOrCreateTable(WORLD_BOOK_EMBEDDINGS_TABLE, rows, true);
          await ensureVectorIndex(WORLD_BOOK_EMBEDDINGS_TABLE, table);
          await ensureScalarIndexes(WORLD_BOOK_EMBEDDINGS_TABLE, table);
          await ensureFtsIndex(WORLD_BOOK_EMBEDDINGS_TABLE, table);
          await deleteWorldBookEntryRowsFromTable(table, userId, groups.map((group) => group.entry.id));
          await table
            .mergeInsert("id")
            .whenMatchedUpdateAll()
            .whenNotMatchedInsertAll()
            .execute(asLanceRows(rows));
        });
      });

      updateWorldBookEntriesVectorState(groups.map((group) => group.entry.id), "indexed", now, null);
      progress.indexed += groups.length;
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
      await deleteWorldBookEntryEmbeddingsBatch(userId, groups.map((group) => group.entry.id));
      updateWorldBookEntriesVectorState(groups.map((group) => group.entry.id), "error", null, error.message);
      progress.failed += groups.length;
      progress.current += groups.length;
      emitProgress();
    }
  };

  for (let i = 0; i < entryGroups.length; i += batchSize) {
    await processGroupBatch(entryGroups.slice(i, i + batchSize), batchSize);
  }

  // Compact all fragments into fewer files, prune old versions, and
  // rebuild vector index so freshly-upserted rows are fully indexed.
  try {
    await optimizeTable([WORLD_BOOK_EMBEDDINGS_TABLE]);
    // After bulk reindex, force a vector index rebuild to absorb all new rows
    await withWriteLock(async () => {
      const table = await getTableIfExists(WORLD_BOOK_EMBEDDINGS_TABLE, true);
      if (table) {
        getTableState(WORLD_BOOK_EMBEDDINGS_TABLE).vectorIndexReady = false;
        await ensureVectorIndex(WORLD_BOOK_EMBEDDINGS_TABLE, table);
      }
    });
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
  limit = 8,
  signal?: AbortSignal,
): Promise<WorldBookSearchCandidate[]> {
  await ensureWorldBookVectorVersion(userId);
  if (signal?.aborted) return [];
  const table = await getWorldBookTableForRead();
  if (!table) {
    console.log("[embeddings] WI vector search: no LanceDB table exists yet (entries may not be indexed)");
    return [];
  }

  const trimmedQuery = queryText.trim();
  const filter = `user_id = ${sqlValue(userId)} AND source_type = 'world_book_entry' AND owner_id = ${sqlValue(worldBookId)}`;
  const effectiveLimit = Math.max(1, Math.min(limit, 100));
  const rawLimit = Math.min(200, Math.max(effectiveLimit * 3, effectiveLimit));

  const query = table
    .query()
    .nearestTo(vector)
    .where(filter)
    .select(["source_id", "content", "_distance", "metadata_json"])
    .limit(rawLimit) as any;
  // Refine with full vectors after PQ approximate search for better accuracy
  if (getTableState(WORLD_BOOK_EMBEDDINGS_TABLE).vectorIndexReady) query.refineFactor(5);
  const vectorRows = await raceWithSignal(query.toArray() as Promise<any[]>, signal);

  if (vectorRows.length === 0) {
    console.log("[embeddings] WI vector search: 0 rows from LanceDB for book=%s (limit=%d)", worldBookId.slice(0, 8), effectiveLimit);
  }

  const merged = new Map<string, WorldBookSearchCandidate>();

  for (const row of vectorRows) {
    const metadata = parseWorldBookEmbeddingMetadata(row.metadata_json);
    const entryId = String(row.source_id);
    const distance = typeof row._distance === "number" ? row._distance : 0;
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

  if (trimmedQuery && !signal?.aborted) {
    try {
      const lexicalRows = await raceWithSignal(
        table
          .query()
          .fullTextSearch(trimmedQuery)
          .where(filter)
          .select(["source_id", "content", "_score", "metadata_json"])
          .limit(rawLimit)
          .toArray() as Promise<any[]>,
        signal,
      );

      for (const row of lexicalRows) {
        const entryId = String(row.source_id);
        const metadata = parseWorldBookEmbeddingMetadata(row.metadata_json);
        const lexicalScore = typeof row._score === "number" ? row._score : null;
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
    .slice(0, effectiveLimit);
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
    await withWriteLock(async () => {
      for (const tableName of [EMBEDDINGS_TABLE, WORLD_BOOK_EMBEDDINGS_TABLE]) {
        const table = await getTableIfExists(tableName, true);
        if (table) {
          await table.delete(`user_id = ${sqlValue(userId)}`);
        }
      }
    });
    scheduleOptimize();
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
 * Force reset the entire LanceDB vector store.
 * Nukes the on-disk LanceDB directory, resets all module state, clears caches,
 * and resets vector index state in SQLite. This is the nuclear option for
 * recovering from corruption (e.g. "vector not divisible by 8" errors).
 */
export async function forceResetLanceDB(): Promise<{ deleted: boolean; path: string }> {
  // Acquire write lock to ensure no LanceDB operations are in-flight when we
  // delete the directory. Without this, concurrent writes would panic trying
  // to access files that no longer exist.
  return withWriteLock(async () => {
    resetInMemoryVectorStoreState();

    // Delete the entire LanceDB directory from disk
    const deleted = existsSync(LANCEDB_PATH);
    if (deleted) {
      rmSync(LANCEDB_PATH, { recursive: true, force: true });
      console.info(`[embeddings] Force-deleted LanceDB directory: ${LANCEDB_PATH}`);
    }

    resetSqliteVectorizationState();

    console.info("[embeddings] LanceDB force reset complete. Vector store will reinitialize on next use.");
    return { deleted, path: LANCEDB_PATH };
  });
}

// --- Chat Vectorization ---

export async function deleteChatChunkEmbeddings(userId: string, chatId: string, chunkId?: string): Promise<void> {
  let filter = `user_id = ${sqlValue(userId)} AND source_type = 'chat_chunk' AND owner_id = ${sqlValue(chatId)}`;
  if (chunkId) {
    filter += ` AND source_id = ${sqlValue(chunkId)}`;
  }
  await withWriteLock(async () => {
    const table = await getTableIfExists(EMBEDDINGS_TABLE, true);
    if (!table) return;
    await table.delete(filter);
  });
  scheduleOptimize("chat_chunk");
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

  await upsertEmbeddingRows([row], "chat chunk sync");

  console.info(`[embeddings] Vectorized chat chunk ${chunkId} for chat ${chatId}`);

  scheduleOptimize("chat_chunk");
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

  await upsertEmbeddingRows(rows, "chat chunk batch upsert");

  console.info(`[embeddings] Batch-vectorized ${rows.length} chat chunk(s)`);
  scheduleOptimize("chat_chunk");
}

async function getExistingChatChunks(userId: string, chatId: string): Promise<Record<string, string>> {
  const table = await getTableIfExists(EMBEDDINGS_TABLE);
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
  await embedWithAdaptiveBatching(
    userId,
    chunksToUpsert,
    batchSize,
    (c) => c.content.trim(),
    async (batch, _texts, vectors) => {
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

      await upsertEmbeddingRows(rows, "chat memory reindex batch");
    },
    (_batch, err) => {
      console.warn("[embeddings] Batch chat embedding failed:", err);
    },
    { label: "chat memory" },
  );

  if (chunksToDelete.length > 0 || chunksToUpsert.length > 0) {
    console.info(`[embeddings] Synced chat memory for ${chatId.split('-')[0]}... (+${chunksToUpsert.length} updated, -${chunksToDelete.length} removed)`);
  }

  scheduleOptimize("chat_chunk");
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
  signal?: AbortSignal,
): Promise<Array<{ chunk_id: string; score: number; content: string; metadata: any }>> {
  if (signal?.aborted) return [];
  const table = await getTableIfExists(EMBEDDINGS_TABLE);
  if (!table) return [];

  const baseFilter = `user_id = ${sqlValue(userId)} AND source_type = 'chat_chunk' AND owner_id = ${sqlValue(chatId)}`;
  const sourceFilter = buildAllowedChunkFilter(allowedChunkIds);
  const filterWasScoped = sourceFilter != null;
  const filter = sourceFilter ? `${baseFilter} AND ${sourceFilter}` : baseFilter;

  // When source filter was dropped (candidate set > MAX_LANCE_SOURCE_FILTER_IDS),
  // the query searches the entire chat partition and results are client-side filtered.
  // Increase fetchLimit to compensate for post-filter loss, but skip refineFactor
  // since re-scanning 5x results on a large unscoped partition is the biggest cost.
  const fetchLimit = filterWasScoped
    ? Math.max(1, Math.min(limit + 50, 150))
    : Math.max(1, Math.min(limit * 4, 300));

  // Try hybrid search when query text is available
  let rows: any[];
  // Refine with full vectors after PQ approximate search for better accuracy.
  // Skip refineFactor for unscoped queries — the cost is prohibitive on large partitions.
  const applyRefineFactor = (q: any) => {
    if (getTableState(EMBEDDINGS_TABLE).vectorIndexReady && filterWasScoped) q.refineFactor(5);
    return q;
  };
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
      rows = await raceWithSignal(applyRefineFactor(q).toArray() as Promise<any[]>, signal);
    } catch {
      if (signal?.aborted) return [];
      // FTS index may not exist yet — fall back to vector-only
      const q = table
        .query()
        .nearestTo(vector)
        .where(filter)
        .select(["source_id", "content", "_distance", "metadata_json", "vector"])
        .limit(fetchLimit);
      rows = await raceWithSignal(applyRefineFactor(q).toArray() as Promise<any[]>, signal);
    }
  } else {
    const q = table
      .query()
      .nearestTo(vector)
      .where(filter)
      .select(["source_id", "content", "_distance", "metadata_json", "vector"])
      .limit(fetchLimit);
    rows = await raceWithSignal(applyRefineFactor(q).toArray() as Promise<any[]>, signal);
  }

  // Parse rows and collect metadata
  type ParsedRow = { chunkId: string; score: number; content: string; metadata: any; rowVector: number[] | null };
  const parsed: Array<{ chunkId: string; meta: any; row: any }> = [];
  const needMessageIdLookup: string[] = [];

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

    parsed.push({ chunkId, meta, row });
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

  // Exclude and build candidates
  const candidates: ParsedRow[] = [];
  for (const { chunkId, meta, row } of parsed) {
    const chunkMessageIds: string[] = (meta.messageIds && Array.isArray(meta.messageIds))
      ? meta.messageIds
      : (messageIdsByChunk.get(chunkId) ?? []);

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

  await upsertEmbeddingRows([row], "chat chunk incremental upsert");

  scheduleOptimize("chat_chunk");
}

/**
 * Delete a specific chunk's vector from LanceDB.
 */
export async function deleteChunkVector(userId: string, chunkId: string): Promise<void> {
  await withWriteLock(async () => {
    const table = await getTableIfExists(EMBEDDINGS_TABLE, true);
    if (!table) return;
    const id = rowId(userId, "chat_chunk", chunkId, 0);
    await table.delete(`id = ${sqlValue(id)}`);
  });
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

  const table = await getTableIfExists(EMBEDDINGS_TABLE);
  if (!table) return { copied: 0 };

  const sourceIds = [...chunkIdMap.keys()];
  const now = Math.floor(Date.now() / 1000);
  let copied = 0;

  // Read source rows in batches to avoid blowing up the filter string.
  for (let i = 0; i < sourceIds.length; i += 200) {
    const batch = sourceIds.slice(i, i + 200);
    const sourceIdFilter = batch.map((id) => sqlValue(id)).join(", ");
    const filter = `user_id = ${sqlValue(userId)} AND source_type = 'chat_chunk' AND owner_id = ${sqlValue(sourceChatId)} AND source_id IN (${sourceIdFilter})`;

    const rows = await table
      .query()
      .where(filter)
      .select(["source_id", "content", "vector", "metadata_json"])
      .toArray();

    const outRows: EmbeddingRow[] = [];
    for (const row of rows as any[]) {
      const sourceId = String(row.source_id);
      const vaultChunkId = chunkIdMap.get(sourceId);
      if (!vaultChunkId) continue;
      const rawVec = row.vector;
      const vector = rawVec instanceof Float32Array ? Array.from(rawVec) : (rawVec as number[] | null);
      if (!vector || vector.length === 0) continue;

      let meta: any = {};
      const rawMeta = row.metadata_json;
      try {
        if (typeof rawMeta === "string") meta = JSON.parse(rawMeta);
        else if (rawMeta && typeof rawMeta === "object") meta = rawMeta;
      } catch { /* ignore — use empty metadata */ }

      outRows.push({
        id: rowId(userId, "vault_chunk", vaultChunkId, 0),
        user_id: userId,
        source_type: "vault_chunk",
        source_id: vaultChunkId,
        owner_id: vaultId,
        chunk_index: 0,
        content: String(row.content || ""),
        vector,
        metadata_json: JSON.stringify({ ...meta, sourceChatId, sourceChunkId: sourceId, vaultId }),
        updated_at: now,
      });
    }

    if (outRows.length === 0) continue;

    await upsertEmbeddingRows(outRows, "vault chunk copy");
    copied += outRows.length;
  }

  if (copied > 0) scheduleOptimize();
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
  let embedded = 0;

  await embedWithAdaptiveBatching(
    userId,
    valid,
    batchSize,
    (c) => c.content.trim(),
    async (batch, _texts, vectors) => {
      const now = Math.floor(Date.now() / 1000);
      const rows: EmbeddingRow[] = batch.map((c, idx) => ({
        id: rowId(userId, "vault_chunk", c.vaultChunkId, 0),
        user_id: userId,
        source_type: "vault_chunk",
        source_id: c.vaultChunkId,
        owner_id: vaultId,
        chunk_index: 0,
        content: c.content.trim(),
        vector: vectors[idx],
        metadata_json: JSON.stringify({ vaultId, rebuiltAt: now }),
        updated_at: now,
      }));

      await upsertEmbeddingRows(rows, "vault rebuild batch");
      embedded += rows.length;
    },
    (_batch, err) => {
      console.warn("[embeddings] Batch vault rebuild failed:", err);
    },
    { label: "vault rebuild" },
  );

  if (embedded > 0) scheduleOptimize();
  return { embedded };
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
  const table = await getTableIfExists(EMBEDDINGS_TABLE);
  if (!table) return [];

  const baseFilter = `user_id = ${sqlValue(userId)} AND source_type = 'vault_chunk' AND owner_id = ${sqlValue(vaultId)}`;
  const sourceFilter = buildAllowedChunkFilter(allowedChunkIds);
  const filter = sourceFilter ? `${baseFilter} AND ${sourceFilter}` : baseFilter;

  const applyRefineFactor = (q: any) => {
    if (getTableState(EMBEDDINGS_TABLE).vectorIndexReady) q.refineFactor(5);
    return q;
  };
  const q = table
    .query()
    .nearestTo(vector)
    .where(filter)
    .select(["source_id", "content", "_distance", "metadata_json"])
    .limit(Math.max(1, Math.min(limit * 3, 200)));

  const rows = await raceWithSignal(applyRefineFactor(q).toArray() as Promise<any[]>, signal);

  return (rows as any[]).map((row) => {
    let meta: any = {};
    try {
      const raw = row.metadata_json;
      if (typeof raw === "string") meta = JSON.parse(raw);
      else if (raw && typeof raw === "object") meta = raw;
    } catch { /* use empty */ }
    return {
      chunk_id: String(row.source_id),
      score: typeof row._distance === "number" ? row._distance : 0,
      content: String(row.content || ""),
      metadata: meta,
    };
  });
}

/**
 * Delete all LanceDB rows belonging to a vault. Called during vault deletion
 * and before a reindex replaces the snapshot.
 */
export async function deleteVaultChunks(userId: string, vaultId: string): Promise<void> {
  const filter = `user_id = ${sqlValue(userId)} AND source_type = 'vault_chunk' AND owner_id = ${sqlValue(vaultId)}`;
  await withWriteLock(async () => {
    const table = await getTableIfExists(EMBEDDINGS_TABLE, true);
    if (!table) return;
    await table.delete(filter);
  });
  scheduleOptimize();
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

  await upsertEmbeddingRows(rows, "databank batch upsert");

  console.info(`[embeddings] Batch-vectorized ${rows.length} databank chunk(s)`);
  scheduleOptimize();
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
  await withWriteLock(async () => {
    const table = await getTableIfExists(EMBEDDINGS_TABLE, true);
    if (!table) return;
    const filter = `user_id = ${sqlValue(userId)} AND source_type = 'databank' AND owner_id = ${sqlValue(databankId)}`;
    await table.delete(filter);
  });
  scheduleOptimize();
}

/**
 * Delete specific databank chunk vectors by their chunk IDs.
 * More precise than filtering by owner_id — avoids deleting unrelated documents.
 */
export async function deleteDatabankChunksByIds(userId: string, chunkIds: string[]): Promise<void> {
  if (chunkIds.length === 0) return;
  await withWriteLock(async () => {
    const table = await getTableIfExists(EMBEDDINGS_TABLE, true);
    if (!table) return;
    // Delete in batches to avoid overly long filter expressions
    const BATCH = 500;
    for (let i = 0; i < chunkIds.length; i += BATCH) {
      const batch = chunkIds.slice(i, i + BATCH);
      const ids = batch.map((id) => rowId(userId, "databank", id, 0));
      const filter = `id IN (${ids.map((id) => sqlValue(id)).join(", ")})`;
      await table.delete(filter);
    }
  });
  scheduleOptimize();
}

/**
 * Search databank chunks in LanceDB by vector similarity.
 * Filters by source_type="databank" and owner_id IN (databankIds).
 */
export async function searchDatabankChunks(
  userId: string,
  databankIds: string[],
  vector: number[],
  limit = 4,
  queryText?: string,
  signal?: AbortSignal,
): Promise<Array<{ chunk_id: string; score: number; content: string; metadata: any }>> {
  if (databankIds.length === 0) return [];
  if (signal?.aborted) return [];

  const table = await getTableIfExists(EMBEDDINGS_TABLE);
  if (!table) return [];

  const ownerFilter = `owner_id IN (${databankIds.map((id) => sqlValue(id)).join(", ")})`;
  const filter = `user_id = ${sqlValue(userId)} AND source_type = 'databank' AND (${ownerFilter})`;
  const fetchLimit = Math.max(1, Math.min(limit + 20, 100));

  let rows: any[];
  const applyRefineFactor = (q: any) => {
    if (getTableState(EMBEDDINGS_TABLE).vectorIndexReady) q.refineFactor(5);
    return q;
  };

  if (queryText?.trim()) {
    try {
      const { rerankers } = await import("@lancedb/lancedb");
      const reranker = await rerankers.RRFReranker.create();
      const q = table
        .query()
        .nearestTo(vector)
        .fullTextSearch(queryText.trim())
        .where(filter)
        .rerank(reranker)
        .select(["source_id", "content", "_distance", "_relevance_score", "metadata_json"])
        .limit(fetchLimit);
      rows = await raceWithSignal(applyRefineFactor(q).toArray() as Promise<any[]>, signal);
    } catch {
      if (signal?.aborted) return [];
      const q = table
        .query()
        .nearestTo(vector)
        .where(filter)
        .select(["source_id", "content", "_distance", "metadata_json"])
        .limit(fetchLimit);
      rows = await raceWithSignal(applyRefineFactor(q).toArray() as Promise<any[]>, signal);
    }
  } else {
    const q = table
      .query()
      .nearestTo(vector)
      .where(filter)
      .select(["source_id", "content", "_distance", "metadata_json"])
      .limit(fetchLimit);
    rows = await raceWithSignal(applyRefineFactor(q).toArray() as Promise<any[]>, signal);
  }

  const results: Array<{ chunk_id: string; score: number; content: string; metadata: any }> = [];

  for (const row of rows) {
    let meta: any = {};
    try {
      const raw = row.metadata_json;
      if (typeof raw === "string") meta = JSON.parse(raw);
      else if (raw && typeof raw === "object") meta = raw;
    } catch { /* empty */ }

    const distance = typeof row._distance === "number" ? row._distance : 0;
    const score = Math.max(0, 1 - distance);

    results.push({
      chunk_id: String(row.source_id),
      score,
      content: String(row.content || ""),
      metadata: meta,
    });
  }

  // Sort by score descending and take top N
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

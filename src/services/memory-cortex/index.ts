/**
 * Memory Cortex — Public API surface.
 *
 * This module is the single entry point for all cortex operations.
 * It exposes:
 *
 *   - Retrieval: queryCortex() — the dual-pass retrieval engine
 *   - Ingestion: processChunk() — called when a new chat chunk is created
 *   - Rebuild:   rebuildCortex() — reconstruct all derived data from chunks
 *   - Config:    getCortexConfig(), putCortexConfig()
 *   - Formatting: cortexToMemoryResult() — backwards-compat adapter
 *
 * Integration:
 *   The prompt assembly pipeline calls queryCortex() during generation.
 *   The chat chunk creation pipeline calls processChunk() on new chunks.
 */

import { getDb } from "../../db/connection";
import {
  getCortexConfig,
  putCortexConfig,
  shouldUseCortexSidecar,
  shouldUseCortexSidecarForChunkAnalysis,
  type MemoryCortexConfig,
} from "./config";
import { scoreChunkHeuristic } from "./salience-heuristic";
import { extractWithSidecar, extractBatchWithSidecar, getToolChoiceParams, getExtractionStructuredParams } from "./salience-sidecar";
import { createCortexSidecarGenerateRawAdapter } from "./sidecar-adapter";
import { extractEntitiesHeuristic, extractMentionExcerpt, detectNicknameIntroductions } from "./entity-extractor";
import { refineHeuristicDetections } from "./detection-refiner";
import { filterEntitiesByExtractionFilters } from "./entity-extraction-filters";
import { isPlausibleAlias, sanitizeAlias } from "./alias-validation";
import { runHeuristicAnalysisInWorker } from "./heuristic-worker-host";
import { resolveCounter } from "../tokenizer.service";
import * as entityGraph from "./entity-graph";
import * as entityContext from "./entity-context";
import * as consolidation from "./consolidation";
import { buildEmotionalContext } from "./emotional-context";
import { queryCortex as queryCortexImpl, queryVaultCortex as queryVaultCortexImpl } from "./retrieval";
import { formatShadowPrompt, type FormatterMode, type ShadowPromptResult } from "./shadow-formatter";
import { getCortexUsageStats, runMaintenance, debouncedVectorize } from "./gc";
import { processChunkFontColors, formatColorMapForPrompt, deleteColorMapForChat, getColorMap, recordColorAttribution, stripFontTags, stripThoughtDelimiters } from "./font-attribution";
import { extractRelationshipsHeuristic } from "./relationship-extractor";
import { extractNPsFromChunk } from "./np-chunker";
import { stripNonProseTags } from "../../utils/content-sanitizer";
import { getLinkedCortexData, reindexVault, getVaultRow } from "./vault";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import type {
  ChunkIngestionData,
  CortexQuery,
  CortexResult,
  CortexMemory,
  MemoryEntity,
  EntitySnapshot,
  SalienceResult,
  EmotionalTag,
  LinkedCortexResult,
  InterlinkCortexData,
} from "./types";

// Re-export public types and config
export { getCortexConfig, putCortexConfig, applyCortexPreset, shouldUseCortexSidecar, shouldUseCortexSidecarForChunkAnalysis } from "./config";
export type { MemoryCortexConfig, CortexPresetMode, FactManagementConfig } from "./config";
export { createCortexSidecarGenerateRawAdapter } from "./sidecar-adapter";
export { formatShadowPrompt, formatContextSections, formatLinkedCortexSection } from "./shadow-formatter";
export type { FormatterMode, ShadowPromptResult, LinkedFormatResult } from "./shadow-formatter";
export { getCortexUsageStats, runMaintenance, debouncedVectorize } from "./gc";
export type { CortexUsageStats } from "./gc";
export { formatColorMapForPrompt, getColorMap } from "./font-attribution";
export { getExtractionStructuredParams, getToolChoiceParams } from "./salience-sidecar";
export type { FontColorMapping, ColorAttribution } from "./font-attribution";
export type {
  CortexQuery,
  CortexResult,
  CortexMemory,
  CortexStats,
  EntitySnapshot,
  RelationEdge,
  EmotionalTag,
  MemoryEntity,
  MemoryRelation,
  MemoryConsolidation,
  DiscoveredAlias,
} from "./types";
export { buildEmotionalContext } from "./emotional-context";
export { formatEntitySnapshots, formatRelationships } from "./entity-context";
export { extractNPsFromChunk } from "./np-chunker";
export {
  resolveCanonicalId,
  normalizeEntityName,
  computeStrength,
  computeEdgeSalience,
  computeEdgeDecayRate,
  computeGraphCentrality,
  consolidateEdgeTypes,
  runHeuristicsMigration,
  getEntitiesNeedingFactExtraction,
  updateFactExtractionStatus,
  updateSalienceBreakdown,
  processProvisionalEntities,
  getAllRelationsUnfiltered,
  mergeEntitiesInternal,
  checkAndAutoMerge,
} from "./entity-graph";
export type { MigrationResult } from "./entity-graph";
export {
  createVault, listVaults, getVault, getVaultRow, deleteVault, renameVault,
  attachLink, getChatLinks, removeLink, toggleLink,
  getVaultDataForAssembly, getLinkedCortexData,
  reindexVault, getVaultChunks,
} from "./vault";
export { queryVaultCortex } from "./retrieval";
export type { Vault, VaultEntity, VaultRelation, VaultChunk, ChatLink } from "./vault";
export type { LinkedCortexResult, VaultCortexData, InterlinkCortexData } from "./types";

export interface CortexWarmupCoverage {
  totalChunks: number;
  completedChunks: number;
  pendingChunks: number;
  requiresFullRebuild: boolean;
}

export interface CortexRebuildOptions {
  resumable?: boolean;
  warmupSignature?: string;
  /** Cooperative cancellation. When aborted (e.g. an explicit POST /rebuild
   *  preempts an in-flight passive warmup), the worker loop stops pulling new
   *  chunks and rebuildCortex rejects with the signal's abort reason instead of
   *  racing the superseding run on the same chat's derived data. */
  signal?: AbortSignal;
}

export interface CortexIngestionTimings {
  mode: "heuristic" | "sidecar" | "mixed";
  fontMs: number;
  heuristicMs: number;
  heuristicSalienceMs: number;
  heuristicEntityMs: number;
  heuristicRelationshipMs: number;
  heuristicAliasMs: number;
  sidecarMs: number;
  graphMs: number;
  dbMs: number;
  totalMs: number;
  completedAt: number;
  chunkId: string;
}

export interface CortexIngestionTelemetry {
  samples: number;
  last: CortexIngestionTimings | null;
  averages: {
    fontMs: number;
    heuristicMs: number;
    sidecarMs: number;
    graphMs: number;
    dbMs: number;
    totalMs: number;
  };
}

export interface CortexIngestionStatus {
  chatId: string;
  status: "idle" | "processing" | "complete" | "error";
  phase: "queued" | "font" | "heuristics" | "sidecar" | "persisting" | "complete" | "error";
  chunkId: string | null;
  startedAt: number | null;
  updatedAt: number;
  pendingJobs: number;
  error?: string;
  timings?: CortexIngestionTimings | null;
}

// ─── Result Cache ─────────────────────────────────────────────
// Warm cache of cortex retrieval results per chat. Background queries
// populate the cache so prompt assembly can read non-blockingly — cortex
// never stalls generation.

const EMPTY_CORTEX_RESULT: CortexResult = {
  memories: [],
  entityContext: [],
  activeRelationships: [],
  arcContext: null,
  stats: {
    candidatePoolSize: 0,
    vectorSearchResults: 0,
    entitiesMatched: 0,
    scoreFusionApplied: false,
    topScore: 0,
    retrievalTimeMs: 0,
  },
};

interface CachedCortexEntry {
  result: CortexResult;
  queriedAt: number;
  /**
   * The message IDs that were excluded from retrieval when this result was
   * computed. The warm cache is keyed by chatId only, so a result warmed by a
   * generation that excluded message A can be read back by a later generation
   * that is regenerating message B. Recording the exclude set lets the reader
   * reject an entry that did NOT exclude the message it is now regenerating,
   * preventing the regen target's own chunk from being re-injected as a
   * "memory" (the duplicate-swipe / self-contamination leak).
   */
  excludeMessageIds: string[];
}

const cortexResultCache = new Map<string, CachedCortexEntry>();
const inflightCortexQueries = new Map<string, Promise<CortexResult>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Race a shared promise against an abort signal so a dedup joiner can bail
 *  out early without cancelling the shared upstream work for other joiners. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Structural signature: the subset of cortex config that determines what's
 * actually stored per-chunk (extracted entities, salience flags, font colors,
 * etc.). Stamped on chat_chunks.cortex_warmup_signature so we can tell when a
 * chunk's derived state is still consistent with the current config.
 *
 * Runtime-only fields (sidecar tuning, timeouts, consolidation thresholds,
 * pruning) live in getCortexRuntimeSignature instead — they affect future
 * ingestions, not the validity of work already done.
 */
export function getCortexStructuralSignature(config: MemoryCortexConfig): string {
  return JSON.stringify({
    enabled: config.enabled,
    entityTracking: config.entityTracking,
    entityExtractionMode: config.entityExtractionMode,
    thoughtMarkers: config.thoughtMarkers,
    salienceScoring: config.salienceScoring,
    salienceScoringMode: config.salienceScoringMode,
    entityWhitelist: config.entityWhitelist,
    entityExtractionFilters: config.entityExtractionFilters,
  });
}

/** Runtime signature: fields that affect how new ingestions are performed but
 *  don't invalidate per-chunk state already on disk. Surfaced for telemetry
 *  and downstream callers that want to detect runtime-only drift. */
export function getCortexRuntimeSignature(config: MemoryCortexConfig): string {
  return JSON.stringify({
    sidecar: {
      connectionProfileId: config.sidecar?.connectionProfileId ?? null,
      model: config.sidecar?.model ?? null,
      temperature: config.sidecar?.temperature ?? 0.1,
      topP: config.sidecar?.topP ?? 1.0,
      maxTokens: config.sidecar?.maxTokens ?? 4096,
      chunkBatchSize: config.sidecar?.chunkBatchSize ?? 5,
      rebuildConcurrency: config.sidecar?.rebuildConcurrency ?? 3,
    },
    sidecarTimeoutMs: config.sidecarTimeoutMs,
    consolidation: config.consolidation,
    entityPruning: config.entityPruning,
  });
}

const LEGACY_SIGNATURE_KEYS_TO_DROP = new Set([
  "consolidation",
  "sidecar",
  "sidecarTimeoutMs",
  "entityPruning",
]);

/**
 * Rewrite a legacy (pre-narrowed) chunk warmup signature into the new
 * structural-only format. Legacy signatures embedded runtime tuning fields
 * (sidecar timeouts, consolidation thresholds, pruning) — touching any of
 * those used to invalidate every chunk and force a full rebuild even though
 * none of those fields affect per-chunk derived state. Returns null when the
 * stored value can't be parsed; callers should null out the chunk's signature
 * so the resumable path picks it up. Returns the input unchanged when it's
 * already in the new format.
 */
export function migrateLegacyChunkSignature(stored: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stored); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  let hasLegacyKey = false;
  for (const key of LEGACY_SIGNATURE_KEYS_TO_DROP) {
    if (key in obj) { hasLegacyKey = true; break; }
  }
  if (!hasLegacyKey) return stored;

  return JSON.stringify({
    enabled: obj.enabled,
    entityTracking: obj.entityTracking,
    entityExtractionMode: obj.entityExtractionMode,
    thoughtMarkers: obj.thoughtMarkers,
    salienceScoring: obj.salienceScoring,
    salienceScoringMode: obj.salienceScoringMode,
    entityWhitelist: obj.entityWhitelist,
    entityExtractionFilters: obj.entityExtractionFilters,
  });
}

// Chats whose legacy chunk signatures have been resolved in this process.
// The migration is idempotent and reads every signature row on each call —
// after the first hit, every subsequent warmup can skip the scan. Cleared
// only on process restart (legacy formats can't reappear without a code
// change, which itself requires a restart).
const legacyChunkSignaturesMigrated = new Set<string>();

/**
 * Lazy per-chat migration: rewrite legacy chunk warmup signatures to the
 * narrowed structural format. Idempotent. Called at the start of warmup so
 * the coverage check post-upgrade sees pre-existing chunks as still warm
 * under the same structural config (avoiding a one-time forced full rebuild
 * that would nuke entities). Returns the number of rows rewritten.
 */
export function migrateLegacyChunkSignatures(chatId: string): number {
  if (legacyChunkSignaturesMigrated.has(chatId)) return 0;

  const db = getDb();
  const rows = db
    .query("SELECT id, cortex_warmup_signature FROM chat_chunks WHERE chat_id = ? AND cortex_warmup_signature IS NOT NULL")
    .all(chatId) as Array<{ id: string; cortex_warmup_signature: string }>;
  if (rows.length === 0) {
    legacyChunkSignaturesMigrated.add(chatId);
    return 0;
  }

  const updateStmt = db.query("UPDATE chat_chunks SET cortex_warmup_signature = ? WHERE id = ?");
  const clearStmt = db.query("UPDATE chat_chunks SET cortex_warmup_signature = NULL, cortex_warmup_completed_at = NULL WHERE id = ?");
  let migrated = 0;
  for (const row of rows) {
    const next = migrateLegacyChunkSignature(row.cortex_warmup_signature);
    if (next === null) {
      clearStmt.run(row.id);
      migrated++;
    } else if (next !== row.cortex_warmup_signature) {
      updateStmt.run(next, row.id);
      migrated++;
    }
  }
  legacyChunkSignaturesMigrated.add(chatId);
  return migrated;
}

function clearDerivedCortexData(chatId: string, options: { preserveSalience?: boolean } = {}): void {
  const db = getDb();
  invalidateCortexCache(chatId);
  // User-edited entity rows survive rebuilds with their curated fields intact;
  // their derived counters are reset so live ingestion can rebuild stats cleanly.
  entityGraph.deleteEntitiesForChat(chatId, { preserveUserEdited: true });
  entityGraph.deleteMentionsForChat(chatId);
  entityGraph.deleteRelationsForChat(chatId, { preserveUserEdited: true });
  consolidation.deleteConsolidationsForChat(chatId);
  deleteColorMapForChat(chatId);
  if (!options.preserveSalience) {
    db.query("DELETE FROM memory_salience WHERE chat_id = ?").run(chatId);
  }
  db.query(
    options.preserveSalience
      ? "UPDATE chat_chunks SET entity_ids = NULL, consolidation_id = NULL, cortex_warmup_signature = NULL, cortex_warmup_completed_at = NULL WHERE chat_id = ?"
      : "UPDATE chat_chunks SET salience_score = NULL, emotional_tags = NULL, entity_ids = NULL, consolidation_id = NULL, cortex_warmup_signature = NULL, cortex_warmup_completed_at = NULL WHERE chat_id = ?",
  ).run(chatId);
}

export function getCortexWarmupCoverage(chatId: string, warmupSignature: string): CortexWarmupCoverage {
  const db = getDb();
  // Single query: 2 chunk counts + 4 EXISTS probes for "has any derived
  // data?". EXISTS short-circuits on the first matching row (O(1) on indexed
  // chat_id), so this replaces the 8-COUNT getCortexUsageStats call where
  // we only need 4 booleans for the requiresFullRebuild decision.
  const row = db.query(`
    SELECT
      (SELECT COUNT(*) FROM chat_chunks WHERE chat_id = ?) AS total,
      (SELECT COUNT(*) FROM chat_chunks WHERE chat_id = ? AND cortex_warmup_signature = ?) AS completed,
      EXISTS(SELECT 1 FROM memory_entities WHERE chat_id = ?) AS has_entities,
      EXISTS(SELECT 1 FROM memory_relations WHERE chat_id = ?) AS has_relations,
      EXISTS(SELECT 1 FROM memory_salience WHERE chat_id = ?) AS has_salience,
      EXISTS(SELECT 1 FROM memory_consolidations WHERE chat_id = ?) AS has_consolidations
  `).get(chatId, chatId, warmupSignature, chatId, chatId, chatId, chatId) as {
    total?: number;
    completed?: number;
    has_entities?: number;
    has_relations?: number;
    has_salience?: number;
    has_consolidations?: number;
  } | null;

  const totalChunks = row?.total ?? 0;
  const completedChunks = row?.completed ?? 0;
  const hasDerivedData =
    !!row?.has_entities ||
    !!row?.has_relations ||
    !!row?.has_salience ||
    !!row?.has_consolidations;
  const requiresFullRebuild = completedChunks === 0 && hasDerivedData;

  return {
    totalChunks,
    completedChunks: requiresFullRebuild ? 0 : completedChunks,
    pendingChunks: requiresFullRebuild ? totalChunks : Math.max(0, totalChunks - completedChunks),
    requiresFullRebuild,
  };
}

function buildCortexQueryKey(query: CortexQuery, config: MemoryCortexConfig): string {
  return JSON.stringify({
    chatId: query.chatId,
    userId: query.userId,
    queryText: query.queryText,
    entityFilter: query.entityFilter ?? [],
    timeRange: query.timeRange ?? null,
    emotionalContext: query.emotionalContext ?? [],
    generationType: query.generationType,
    topK: query.topK,
    includeConsolidations: query.includeConsolidations,
    includeRelationships: query.includeRelationships,
    excludeMessageIds: [...(query.excludeMessageIds ?? [])].sort(),
    entityTracking: config.entityTracking,
    salienceScoring: config.salienceScoring,
    retrieval: config.retrieval,
    decay: config.decay,
  });
}

/**
 * Read the most recent cortex result from the warm cache.
 * Returns null if no cached result exists or if it has expired.
 * This is a synchronous, non-blocking call — safe to use in the generation hot path.
 *
 * When `requiredExcludedMessageIds` is provided, the cached entry is only
 * returned if every required message was excluded when the entry was warmed.
 * Otherwise it could contain the regen target or current live-context tail and
 * re-inject it as "memory". On a reject the caller falls through to
 * exclusion-aware vector retrieval.
 */
export function getCachedCortexResult(
  chatId: string,
  requiredExcludedMessageIds?: string | string[],
): CortexResult | null {
  const entry = cortexResultCache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.queriedAt > CACHE_TTL_MS) {
    cortexResultCache.delete(chatId);
    return null;
  }
  const required = typeof requiredExcludedMessageIds === "string"
    ? [requiredExcludedMessageIds]
    : (requiredExcludedMessageIds ?? []);
  if (required.length > 0) {
    const excluded = new Set(entry.excludeMessageIds);
    for (const id of required) {
      if (!excluded.has(id)) {
        // Stale-context entry: it was warmed without excluding a message that is
        // now live or being regenerated, so it may contain that chunk.
        return null;
      }
    }
  }
  return entry.result;
}

/** Invalidate cached cortex result for a chat (e.g. on rebuild or delete). */
export function invalidateCortexCache(chatId: string): void {
  cortexResultCache.delete(chatId);
}

/**
 * Prime the warm cache with a cortex result computed off the main thread.
 *
 * `queryCortex` normally writes the cache as a side effect, but when the warm
 * query runs inside the cortex worker (so its CPU-bound LanceDB/embedding work
 * never blocks the WS event loop), the side effect lands in the *worker's*
 * module instance. The main process calls this to mirror the result into its
 * own cache so `getCachedCortexResult` serves it on the next generation.
 *
 * Mirrors `queryCortex`'s caching contract: timeouts/aborts are not cached,
 * so a stale-but-real entry survives instead of a hollow placeholder.
 */
export function primeCortexCache(
  chatId: string,
  result: CortexResult,
  excludeMessageIds: string[] = [],
): void {
  if (result.stats?.timedOut || result.stats?.aborted) return;
  cortexResultCache.set(chatId, {
    result,
    queriedAt: Date.now(),
    excludeMessageIds: [...excludeMessageIds],
  });
}

// ─── Linked Cortex Cache ──────────────────────────────────────

interface CachedLinkedEntry {
  result: LinkedCortexResult;
  queriedAt: number;
}

const linkedCortexResultCache = new Map<string, CachedLinkedEntry>();

// Track in-flight vault auto-reindex jobs so queryLinkedCortex doesn't
// fire duplicate rebuilds on every generation while the first one runs.
// Keyed by vaultId.
const autoReindexInFlight = new Set<string>();

/** Fire an auto-reindex for a vault that has no chunk snapshot yet.
 *  Runs in the background; the current generation falls back to structural-
 *  only retrieval. Subsequent generations pick up the populated vault. */
function scheduleVaultAutoReindex(userId: string, vaultId: string): void {
  if (autoReindexInFlight.has(vaultId)) return;
  autoReindexInFlight.add(vaultId);
  void (async () => {
    try {
      const result = await reindexVault(userId, vaultId);
      console.info(`[cortex] Auto-reindexed vault ${vaultId}: mode=${result.mode} chunks=${result.chunkCount}`);
    } catch (err) {
      console.warn(`[cortex] Auto-reindex failed for vault ${vaultId}:`, err);
    } finally {
      autoReindexInFlight.delete(vaultId);
    }
  })();
}

export function getCachedLinkedCortexResult(chatId: string): LinkedCortexResult | null {
  const entry = linkedCortexResultCache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.queriedAt > CACHE_TTL_MS) {
    linkedCortexResultCache.delete(chatId);
    return null;
  }
  return entry.result;
}

export function invalidateLinkedCortexCache(chatId: string): void {
  linkedCortexResultCache.delete(chatId);
}

/**
 * Prime the linked-cortex warm cache with a result computed off the main
 * thread (see `primeCortexCache`). `queryLinkedCortex` skips caching on abort;
 * callers must not prime a result assembled after their own abort fired.
 */
export function primeLinkedCortexCache(
  chatId: string,
  result: LinkedCortexResult,
): void {
  linkedCortexResultCache.set(chatId, { result, queriedAt: Date.now() });
}

// ─── Ingestion Status / Telemetry ──────────────────────────────

const cortexIngestionStatus = new Map<string, CortexIngestionStatus>();
const cortexIngestionSamples = new Map<string, {
  samples: number;
  fontMsTotal: number;
  heuristicMsTotal: number;
  sidecarMsTotal: number;
  graphMsTotal: number;
  dbMsTotal: number;
  totalMsTotal: number;
  last: CortexIngestionTimings | null;
}>();

function getOrCreateIngestionStatus(chatId: string): CortexIngestionStatus {
  const existing = cortexIngestionStatus.get(chatId);
  if (existing) return existing;
  const created: CortexIngestionStatus = {
    chatId,
    status: "idle",
    phase: "complete",
    chunkId: null,
    startedAt: null,
    updatedAt: Date.now(),
    pendingJobs: 0,
    timings: null,
  };
  cortexIngestionStatus.set(chatId, created);
  return created;
}

function emitIngestionStatus(userId: string, status: CortexIngestionStatus): void {
  eventBus.emit(EventType.CORTEX_INGESTION_PROGRESS, status, userId);
}

function updateIngestionStatus(
  userId: string,
  chatId: string,
  patch: Partial<CortexIngestionStatus>,
): CortexIngestionStatus {
  const next = {
    ...getOrCreateIngestionStatus(chatId),
    ...patch,
    chatId,
    updatedAt: Date.now(),
  };
  cortexIngestionStatus.set(chatId, next);
  emitIngestionStatus(userId, next);
  return next;
}

function beginIngestionTracking(userId: string, chatId: string, chunkId: string): number {
  const current = getOrCreateIngestionStatus(chatId);
  const pendingJobs = current.pendingJobs + 1;
  updateIngestionStatus(userId, chatId, {
    status: "processing",
    phase: "queued",
    chunkId,
    startedAt: current.startedAt ?? Date.now(),
    pendingJobs,
    error: undefined,
  });
  return pendingJobs;
}

function completeIngestionTracking(
  userId: string,
  chatId: string,
  chunkId: string,
  timings: CortexIngestionTimings,
): void {
  const current = getOrCreateIngestionStatus(chatId);
  const pendingJobs = Math.max(0, current.pendingJobs - 1);
  updateIngestionStatus(userId, chatId, {
    status: pendingJobs > 0 ? "processing" : "complete",
    phase: pendingJobs > 0 ? "queued" : "complete",
    chunkId: pendingJobs > 0 ? current.chunkId : chunkId,
    startedAt: pendingJobs > 0 ? current.startedAt : null,
    pendingJobs,
    error: undefined,
    timings,
  });

  const aggregate = cortexIngestionSamples.get(chatId) ?? {
    samples: 0,
    fontMsTotal: 0,
    heuristicMsTotal: 0,
    sidecarMsTotal: 0,
    graphMsTotal: 0,
    dbMsTotal: 0,
    totalMsTotal: 0,
    last: null,
  };
  aggregate.samples += 1;
  aggregate.fontMsTotal += timings.fontMs;
  aggregate.heuristicMsTotal += timings.heuristicMs;
  aggregate.sidecarMsTotal += timings.sidecarMs;
  aggregate.graphMsTotal += timings.graphMs;
  aggregate.dbMsTotal += timings.dbMs;
  aggregate.totalMsTotal += timings.totalMs;
  aggregate.last = timings;
  cortexIngestionSamples.set(chatId, aggregate);
}

function failIngestionTracking(userId: string, chatId: string, error: string): void {
  const current = getOrCreateIngestionStatus(chatId);
  const pendingJobs = Math.max(0, current.pendingJobs - 1);
  updateIngestionStatus(userId, chatId, {
    status: "error",
    phase: "error",
    startedAt: pendingJobs > 0 ? current.startedAt : null,
    pendingJobs,
    error,
  });
}

export function getIngestionStatus(chatId: string): CortexIngestionStatus | null {
  return cortexIngestionStatus.get(chatId) ?? null;
}

export function getIngestionTelemetry(chatId: string): CortexIngestionTelemetry {
  const aggregate = cortexIngestionSamples.get(chatId);
  if (!aggregate || aggregate.samples === 0) {
    return {
      samples: 0,
      last: null,
      averages: {
        fontMs: 0,
        heuristicMs: 0,
        sidecarMs: 0,
        graphMs: 0,
        dbMs: 0,
        totalMs: 0,
      },
    };
  }

  return {
    samples: aggregate.samples,
    last: aggregate.last,
    averages: {
      fontMs: aggregate.fontMsTotal / aggregate.samples,
      heuristicMs: aggregate.heuristicMsTotal / aggregate.samples,
      sidecarMs: aggregate.sidecarMsTotal / aggregate.samples,
      graphMs: aggregate.graphMsTotal / aggregate.samples,
      dbMs: aggregate.dbMsTotal / aggregate.samples,
      totalMs: aggregate.totalMsTotal / aggregate.samples,
    },
  };
}

export function clearIngestionState(chatId: string): void {
  cortexIngestionStatus.delete(chatId);
  cortexIngestionSamples.delete(chatId);
}

/** Invalidate every linked-cortex cache entry whose linked data set includes
 *  the given vault. Used after a reindex so every target chat that attached
 *  the vault picks up the refreshed snapshot on the next generation. */
export function invalidateLinkedCortexCacheForVault(vaultId: string): void {
  const db = getDb();
  const rows = db.query(
    `SELECT DISTINCT chat_id FROM cortex_chat_links WHERE vault_id = ?`,
  ).all(vaultId) as Array<{ chat_id: string }>;
  for (const r of rows) linkedCortexResultCache.delete(r.chat_id);
}

/**
 * Query all linked cortex data for a chat (vaults + interlinks).
 * Vault data is read synchronously from SQLite, then optionally enriched
 * with memory retrieval from the source chat's embeddings.
 * Interlink targets are queried via queryCortex() in parallel.
 *
 * @param queryText — The current chat's query context (from recent messages).
 *   When provided, enables semantic vector search against linked chats'
 *   embeddings so retrieved memories are relevant to the current conversation.
 */
export async function queryLinkedCortex(
  chatId: string,
  userId: string,
  config?: MemoryCortexConfig,
  queryText?: string,
  signal?: AbortSignal,
): Promise<LinkedCortexResult> {
  const cfg = config ?? getCortexConfig(userId);
  const linked = getLinkedCortexData(userId, chatId);
  const topK = cfg.retrieval?.maxEntitySnapshots ?? 10;
  const includeRelationships = cfg.retrieval?.relationshipInjection ?? true;

  // Fire all linked queries in parallel (vault self-contained retrieval + interlinks)
  const promises: Promise<void>[] = [];

  // Vault structural data (entities/relations) is already populated from SQLite.
  // Enrich each vault with its own vault-scoped retrieval so memories come from
  // the vault snapshot, not the live source chat. This:
  //   - works even if the source chat is deleted,
  //   - doesn't pollute the source chat's cortexResultCache,
  //   - keeps the target chat's own cortex build-up independent.
  const vaults = linked.vaults;
  if (queryText) {
    for (const vault of vaults) {
      const vaultId = vault.vaultId;
      promises.push(
        (async () => {
          try {
            // Auto-reindex trigger for vaults with no chunk snapshot (created
            // before migration 061 OR wiped by a LanceDB reset). -1 is the
            // "tried and source chat is gone" sentinel — don't retry.
            const row = getVaultRow(userId, vaultId);
            if (row && row.chunkCount === 0) {
              scheduleVaultAutoReindex(userId, vaultId);
              return; // structural-only for this generation
            }
            if (row && row.chunkCount < 0) return; // sentinel — skip retrieval

            const result = await queryVaultCortexImpl({
              userId,
              vaultId,
              queryText,
              topK,
              includeRelationships,
              signal,
            }, cfg);
            vault.memories = result.memories;
            vault.arcContext = result.arcContext;
            // Prefer the richer entity/relation context from retrieval (it
            // prioritises entities mentioned in selected memories); fall back
            // to the structural snapshot when retrieval returned none.
            if (result.entityContext.length > 0) vault.entities = result.entityContext;
            if (result.activeRelationships.length > 0) vault.relations = result.activeRelationships;
          } catch (err) {
            if (signal?.aborted) return;
            console.warn(`[cortex] Vault retrieval failed for vault ${vaultId}:`, err);
          }
        })(),
      );
    }
  }

  // Fire interlink queries in parallel
  const interlinkResults: InterlinkCortexData[] = [];
  if (linked.interlinkTargetChatIds.length > 0) {
    for (const target of linked.interlinkTargetChatIds) {
      promises.push(
        (async () => {
          try {
            const result = await queryCortex({
              chatId: target.chatId,
              userId,
              queryText: queryText || "",
              generationType: "normal",
              topK,
              includeConsolidations: false,
              includeRelationships,
            }, cfg, signal);
            interlinkResults.push({ targetChatId: target.chatId, targetChatName: target.chatName, result });
          } catch (err) {
            if (signal?.aborted) return;
            console.warn(`[cortex] Interlink query failed for chat ${target.chatId}:`, err);
          }
        })(),
      );
    }
  }

  await Promise.all(promises);

  // Don't cache a partial result assembled after an abort — the next live
  // generation should re-run the linked queries instead of reading an
  // abort-truncated snapshot.
  if (signal?.aborted) {
    return { vaults, interlinks: interlinkResults };
  }

  const result: LinkedCortexResult = { vaults, interlinks: interlinkResults };
  linkedCortexResultCache.set(chatId, { result, queriedAt: Date.now() });
  return result;
}

// ─── Retrieval ─────────────────────────────────────────────────

/**
 * Execute a cortex-enhanced memory retrieval query.
 *
 * The result is automatically cached so that prompt assembly can read it
 * non-blockingly via getCachedCortexResult(). The query itself is always
 * fired as a background task — never awaited in the generation hot path.
 */
export async function queryCortex(
  query: CortexQuery,
  config?: MemoryCortexConfig,
  signal?: AbortSignal,
): Promise<CortexResult> {
  const cfg = config ?? getCortexConfig(query.userId);
  if (!cfg.enabled) return EMPTY_CORTEX_RESULT;
  if (signal?.aborted) return EMPTY_CORTEX_RESULT;

  const queryKey = buildCortexQueryKey(query, cfg);
  const inflight = inflightCortexQueries.get(queryKey);
  // Dedup join: race against the caller's signal so an aborting joiner bails
  // out without cancelling the shared in-flight retrieval for other callers.
  if (inflight) return raceWithSignal(inflight, signal);

  const runQuery = (async (): Promise<CortexResult> => {
    // Time-bound the retrieval to prevent hanging promises from accumulating
    // when embedding APIs or vector search are unresponsive.
    const timeoutMs = cfg.retrievalTimeoutMs ?? 60000;
    let result: CortexResult;

    if (timeoutMs > 0 || signal) {
      const TIMEOUT = Symbol("cortex-timeout");
      // AbortController lets the retrieval pipeline bail out early instead of
      // continuing to run in the background after the timeout fires.
      const timeoutController = new AbortController();
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            console.warn(`[memory-cortex] Retrieval timed out after ${timeoutMs}ms`);
            timeoutController.abort();
          }, timeoutMs)
        : null;

      // Forward the caller's abort into the retrieval's signal so a user stop
      // tears down the embedding + LanceDB work instead of letting it run on.
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutController.signal])
        : timeoutController.signal;

      let raced: CortexResult | typeof TIMEOUT;
      try {
        raced = await Promise.race([
          queryCortexImpl(query, cfg, combinedSignal),
          new Promise<typeof TIMEOUT>((resolve) => {
            combinedSignal.addEventListener("abort", () => resolve(TIMEOUT), { once: true });
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (raced === TIMEOUT) {
        // Do NOT cache timeouts / aborts — leave any existing cache entry
        // intact so future generations can still use stale-but-real results
        // instead of falling through to the slow vector retrieval fallback.
        const aborted = signal?.aborted === true;
        return {
          ...EMPTY_CORTEX_RESULT,
          stats: {
            ...EMPTY_CORTEX_RESULT.stats,
            ...(aborted ? { aborted: true } : { timedOut: true }),
          },
        };
      }

      result = raced as CortexResult;
    } else {
      result = await queryCortexImpl(query, cfg);
    }

    // Auto-populate warm cache for non-blocking reads in future generations.
    // Only genuine completions (success or "no memories") reach here — timeouts
    // are returned early above without touching the cache. Record the exclude
    // set so a later regen of a message this query did NOT exclude is served a
    // miss instead of a result that could contain that message's own chunk.
    cortexResultCache.set(query.chatId, {
      result,
      queriedAt: Date.now(),
      excludeMessageIds: [...(query.excludeMessageIds ?? [])],
    });

    return result;
  })();

  inflightCortexQueries.set(queryKey, runQuery);

  try {
    return await runQuery;
  } finally {
    if (inflightCortexQueries.get(queryKey) === runQuery) {
      inflightCortexQueries.delete(queryKey);
    }
  }
}

// ─── Ingestion Pipeline ────────────────────────────────────────

/**
 * Process a newly created chat chunk through the cortex pipeline.
 *
 * Called after a chunk is created and inserted into `chat_chunks`.
 * Runs salience scoring, entity extraction, and entity graph updates.
 *
 * This function is designed to be fast and non-blocking:
 *   - Heuristic mode: fully synchronous, ~1-2ms
 *   - Sidecar mode: async, but does not block the caller
 *
 * @param data - Chunk ingestion data
 * @param characterNames - Names of all characters and the persona in this chat
 * @param generateRawFn - Optional: sidecar LLM call function
 * @param sidecarConnectionId - Optional: connection profile for sidecar
 */
export async function processChunk(
  data: ChunkIngestionData,
  characterNames: string[],
  generateRawFn?: (opts: {
    connectionId: string;
    messages: Array<{ role: string; content: string }>;
    parameters: Record<string, any>;
    tools?: import("../../llm/types").ToolDefinition[];
    signal?: AbortSignal;
  }) => Promise<{ content: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> }>,
  sidecarConnectionId?: string,
  /** Alias → canonical name. Built from character/persona descriptions and world books.
   *  Used to auto-associate nicknames from descriptions to their canonical entity. */
  descriptionAliases?: Map<string, string>,
  /** Pre-computed heuristic output for this chunk. When provided, processChunk
   *  skips its own runHeuristicAnalysisInWorker call. Used by the batch rebuild
   *  path so the heuristic worker doesn't run twice (once to build arbiter
   *  input, again during ingestion). */
  precomputedHeuristic?: import("./heuristic-runtime").HeuristicAnalysisOutput,
): Promise<void> {
  const config = getCortexConfig(data.userId);
  if (!config.enabled) return;
  const sidecarActive = shouldUseCortexSidecarForChunkAnalysis(config) && !!generateRawFn && !!sidecarConnectionId;
  const warmupSignature = getCortexStructuralSignature(config);

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const pipelineStartedAt = performance.now();
  beginIngestionTracking(data.userId, data.chatId, data.chunkId);

  const timings = {
    fontMs: 0,
    heuristicMs: 0,
    heuristicSalienceMs: 0,
    heuristicEntityMs: 0,
    heuristicRelationshipMs: 0,
    heuristicAliasMs: 0,
    sidecarMs: 0,
    graphMs: 0,
    dbMs: 0,
  };

  try {
    let salienceResult: SalienceResult;
    let sidecarEntities: Array<{ name: string; type: string; role?: string }> = [];
    let sidecarRelationships: Array<{ source: string; target: string; type: string; label: string; sentiment: number }> = [];
    let sidecarFacts: string[] = [];
    let sidecarFontColors: Array<{ hexColor: string; characterName: string; usageType: "speech" | "thought" | "narration" }> = [];
    let sidecarDiscoveredAliases: Array<{ canonicalName: string; alias: string; evidence?: string }> = [];
    let sidecarGrading: import("./types").SidecarGradedHeuristics | undefined;

    const rawChunkContent = hydrateChunkContentFromMessages(data.messageIds, data.content);
    // Strip non-prose markup (HTML, <details>, <lumia_ooc>, scaffold blocks,
    // user-defined HUD tags, etc.) before any evaluator sees the chunk —
    // keeps font tags so attribution still works.
    const proseContent = stripNonProseTags(rawChunkContent, {
      keepFontTags: true,
      extraScaffoldTags: config.nonProseScaffoldTags,
    });
    const thoughtDelimiters = config.thoughtMarkers;

    const knownEntities = entityGraph.getActiveEntities(data.chatId);
    const entityIdByName = new Map<string, string>();
    for (const e of knownEntities) {
      entityIdByName.set(e.name.toLowerCase(), e.id);
      for (const alias of e.aliases) entityIdByName.set(alias.toLowerCase(), e.id);
    }

    // Allowlist for font color attribution. Only character-type entities and
    // the canonical chat participants (characters + persona) are eligible — a
    // word like "Discord" or "gyoza" picked up from a status block will not
    // match here and the attribution gets dropped instead of polluting the
    // color table. Aliases from descriptions count too so persona nicknames
    // resolve correctly even before they're persisted.
    const allowedColorNames = new Set<string>();
    for (const n of characterNames) allowedColorNames.add(n.toLowerCase());
    if (descriptionAliases) {
      for (const [alias] of descriptionAliases.entries()) allowedColorNames.add(alias.toLowerCase());
    }
    for (const e of knownEntities) {
      if (e.entityType !== "character") continue;
      allowedColorNames.add(e.name.toLowerCase());
      for (const alias of e.aliases) allowedColorNames.add(alias.toLowerCase());
    }
    const isAllowedColorName = (name: string): boolean => allowedColorNames.has(name.trim().toLowerCase());

    const entityContext = knownEntities.map((e) => ({
      name: e.name,
      type: e.entityType,
      aliases: e.aliases,
    }));

    updateIngestionStatus(data.userId, data.chatId, { phase: "font", chunkId: data.chunkId });
    const fontStart = performance.now();
    const fontResult = processChunkFontColors(
      data.chatId,
      proseContent,
      [...new Set([...characterNames, ...knownEntities.map((e) => e.name)])],
      entityIdByName,
      thoughtDelimiters,
    );
    timings.fontMs = performance.now() - fontStart;
    const cleanContent = fontResult.strippedContent;

    const shouldRunHeuristicWorker =
      (config.entityTracking && config.entityExtractionMode !== "off") ||
      !config.salienceScoring ||
      !sidecarActive;

    // When a precomputed heuristic is supplied (batch rebuild path), skip the
    // worker call entirely and treat the precomputed value as the resolved
    // result. shouldRunHeuristicWorker still governs whether heuristic data is
    // used downstream.
    const heuristicPromise = shouldRunHeuristicWorker && !precomputedHeuristic
      ? runHeuristicAnalysisInWorker({
          cleanContent,
          knownEntities: knownEntities.map((entity) => ({
            name: entity.name,
            entityType: entity.entityType,
            aliases: entity.aliases,
          })),
          characterNames,
          entityWhitelist: config.entityWhitelist,
          minConfidence: config.entityPruning.minConfidence,
          entityExtractionFilters: config.entityExtractionFilters,
          descriptionAliases: descriptionAliases
            ? [...descriptionAliases.entries()].map(([alias, canonicalName]) => ({ alias, canonicalName }))
            : undefined,
        })
      : null;
    if (heuristicPromise) {
      updateIngestionStatus(data.userId, data.chatId, { phase: "heuristics", chunkId: data.chunkId });
    }

    let heuristicResult = (shouldRunHeuristicWorker && precomputedHeuristic
      ? precomputedHeuristic
      : null) as Awaited<typeof heuristicPromise>;
    if (heuristicResult && precomputedHeuristic) {
      timings.heuristicMs = heuristicResult.timings.totalMs;
      timings.heuristicSalienceMs = heuristicResult.timings.salienceMs;
      timings.heuristicEntityMs = heuristicResult.timings.entityMs;
      timings.heuristicRelationshipMs = heuristicResult.timings.relationshipMs;
      timings.heuristicAliasMs = heuristicResult.timings.aliasMs;
    }

    // Arbiter mode needs heuristic candidates BEFORE the sidecar call so the
    // sidecar can grade them. We pay a small serial cost (heuristic worker
    // typically ~1-50ms) in exchange for sidecar-as-arbiter semantics.
    const arbiterActive = sidecarActive
      && config.sidecarReliability.arbitratesHeuristics
      && !!heuristicPromise;
    let arbiterInput: {
      heuristicEntities: Array<{ name: string; type: string }>;
      heuristicRelationships: Array<{ source: string; target: string; type: string }>;
      existingGraphEntities: string[];
    } | undefined;
    if (arbiterActive && heuristicPromise) {
      heuristicResult = await heuristicPromise;
      timings.heuristicMs = heuristicResult.timings.totalMs;
      timings.heuristicSalienceMs = heuristicResult.timings.salienceMs;
      timings.heuristicEntityMs = heuristicResult.timings.entityMs;
      timings.heuristicRelationshipMs = heuristicResult.timings.relationshipMs;
      timings.heuristicAliasMs = heuristicResult.timings.aliasMs;
      arbiterInput = {
        heuristicEntities: heuristicResult.entities.map((e) => ({ name: e.name, type: e.type })),
        heuristicRelationships: heuristicResult.relationships.map((r) => ({
          source: r.source, target: r.target, type: r.type,
        })),
        existingGraphEntities: config.sidecarReliability.gradesExistingRecords
          ? knownEntities.map((e) => e.name)
          : [],
      };
    }

    let extraction: Awaited<ReturnType<typeof extractWithSidecar>> | null = null;
    let skipChunkPersistence = false;
    let liveSidecarTokenCounter: ((text: string) => number) | undefined;
    if (sidecarActive) {
      updateIngestionStatus(data.userId, data.chatId, { phase: "sidecar", chunkId: data.chunkId });
      // Resolve a tokenizer once per processChunk for diagnostic log lines.
      // Falls back to char/4 inside resolveCounter when no model-specific
      // tokenizer is available — never throws.
      try {
        const resolved = await resolveCounter(config.sidecar.model || "");
        liveSidecarTokenCounter = resolved.count;
      } catch {
        liveSidecarTokenCounter = undefined;
      }
      const sidecarStart = performance.now();
      const maxAttempts = 1 + (config.sidecarReliability.maxRetries ?? 0);
      const baseDelayMs = config.sidecarReliability.retryDelayMs ?? 500;
      let lastErr: any = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
          const delay = baseDelayMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
          console.info(`[memory-cortex] Sidecar retry attempt ${attempt + 1}/${maxAttempts} after ${delay}ms`);
        }

        const sidecarTimeout = config.sidecarTimeoutMs ?? 30000;
        const ac = sidecarTimeout > 0 ? new AbortController() : null;
        const timer = ac ? setTimeout(() => {
          console.warn("[memory-cortex] Sidecar extraction timed out, aborting LLM call");
          ac.abort();
        }, sidecarTimeout) : null;

        try {
          extraction = await extractWithSidecar(
            proseContent,
            generateRawFn!,
            sidecarConnectionId!,
            {
              characterNames,
              knownEntities: entityContext,
              arbiter: arbiterInput,
              descriptionAliases: buildSidecarAliasList(descriptionAliases, knownEntities),
              samplingParameters: buildSidecarSamplingParameters(config.sidecar),
              tokenCounter: liveSidecarTokenCounter,
              logTag: `live chunk=${data.chunkId.slice(0, 8)} attempt=${attempt + 1}/${maxAttempts}`,
              throwOnFailure: true,
              signal: ac?.signal,
            },
          );
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
          const isAbort = err?.name === "AbortError" || ac?.signal.aborted;
          if (!isAbort) {
            console.warn(`[memory-cortex] Sidecar attempt ${attempt + 1}/${maxAttempts} failed:`, err?.message ?? err);
          }
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      timings.sidecarMs = performance.now() - sidecarStart;

      if (!extraction && lastErr) {
        if (config.sidecarReliability.fallback === "skip") {
          console.warn(
            `[memory-cortex] Sidecar failed after ${maxAttempts} attempt(s); skipping chunk persistence ` +
            `(warmup signature left null so next warmup will retry)`,
          );
          skipChunkPersistence = true;
        } else {
          console.warn(`[memory-cortex] Sidecar failed after ${maxAttempts} attempt(s); falling back to heuristic`);
        }
      }
    }

    if (heuristicPromise && !heuristicResult) {
      heuristicResult = await heuristicPromise;
      timings.heuristicMs = heuristicResult.timings.totalMs;
      timings.heuristicSalienceMs = heuristicResult.timings.salienceMs;
      timings.heuristicEntityMs = heuristicResult.timings.entityMs;
      timings.heuristicRelationshipMs = heuristicResult.timings.relationshipMs;
      timings.heuristicAliasMs = heuristicResult.timings.aliasMs;
    }

    if (skipChunkPersistence) {
      const skippedTimings: CortexIngestionTimings = {
        mode: "sidecar",
        fontMs: timings.fontMs,
        heuristicMs: timings.heuristicMs,
        heuristicSalienceMs: timings.heuristicSalienceMs,
        heuristicEntityMs: timings.heuristicEntityMs,
        heuristicRelationshipMs: timings.heuristicRelationshipMs,
        heuristicAliasMs: timings.heuristicAliasMs,
        sidecarMs: timings.sidecarMs,
        graphMs: timings.graphMs,
        dbMs: timings.dbMs,
        totalMs: performance.now() - pipelineStartedAt,
        completedAt: Date.now(),
        chunkId: data.chunkId,
      };
      completeIngestionTracking(data.userId, data.chatId, data.chunkId, skippedTimings);
      return;
    }

    if (extraction) {
      salienceResult = {
        score: extraction.score,
        source: "sidecar",
        emotionalTags: extraction.emotionalTags,
        statusChanges: extraction.statusChanges,
        narrativeFlags: extraction.narrativeFlags,
        hasDialogue: /[""\u201C]/.test(proseContent),
        hasAction: /\*[^*]{10,}\*/.test(proseContent),
        hasInternalThought: /\b(thought|wondered|realized|felt|knew)\b/i.test(cleanContent),
        wordCount: cleanContent.split(/\s+/).length,
      };
      sidecarEntities = extraction.entitiesPresent;
      sidecarRelationships = extraction.relationshipsShown;
      sidecarFacts = extraction.keyFacts;
      sidecarFontColors = extraction.fontColors;
      sidecarDiscoveredAliases = extraction.discoveredAliases;
      sidecarGrading = extraction.gradedHeuristics;

      if (extraction.fontColors.length > 0) {
        const dbStart = performance.now();
        for (const fc of extraction.fontColors) {
          if (!isAllowedColorName(fc.characterName)) continue;
          // Only write here if the character is already persisted. Otherwise
          // skip and let the post-ingest transactional write below handle it
          // once the entity has been created — that avoids stamping a
          // null-entity ("Unattributed") row that the later write can't always
          // reliably replace.
          const entityId = entityIdByName.get(fc.characterName.toLowerCase());
          if (!entityId) continue;
          recordColorAttribution(data.chatId, fc.hexColor, entityId, fc.usageType as any, null);
        }
        timings.dbMs += performance.now() - dbStart;
      }
    } else if (heuristicResult) {
      salienceResult = heuristicResult.salienceResult;
    } else {
      salienceResult = scoreChunkHeuristic(cleanContent);
    }

    // Warmup rebuild works from a chunk snapshot, so the source chunk may have
    // been deleted by a concurrent chat chunk rebuild before we persist.
    const chunkStillExists = db
      .query("SELECT 1 FROM chat_chunks WHERE id = ? AND chat_id = ?")
      .get(data.chunkId, data.chatId);
    if (!chunkStillExists) {
      const skippedTimings: CortexIngestionTimings = {
        mode: extraction ? (heuristicResult ? "mixed" : "sidecar") : "heuristic",
        fontMs: timings.fontMs,
        heuristicMs: timings.heuristicMs,
        heuristicSalienceMs: timings.heuristicSalienceMs,
        heuristicEntityMs: timings.heuristicEntityMs,
        heuristicRelationshipMs: timings.heuristicRelationshipMs,
        heuristicAliasMs: timings.heuristicAliasMs,
        sidecarMs: timings.sidecarMs,
        graphMs: timings.graphMs,
        dbMs: timings.dbMs,
        totalMs: performance.now() - pipelineStartedAt,
        completedAt: Date.now(),
        chunkId: data.chunkId,
      };
      completeIngestionTracking(data.userId, data.chatId, data.chunkId, skippedTimings);
      return;
    }

    updateIngestionStatus(data.userId, data.chatId, { phase: "persisting", chunkId: data.chunkId });
    const persistStartedAt = performance.now();
    const deferredFactAutopilot = db.transaction(() => {
      let deferredAutopilotEntityId: string | null = null;

      if (config.salienceScoring) {
        const dbStart = performance.now();
        db.query(
          `INSERT INTO memory_salience
            (id, chunk_id, chat_id, score, score_source, emotional_tags, status_changes,
             narrative_flags, has_dialogue, has_action, has_internal_thought, word_count,
             scored_at, scored_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(chunk_id) DO UPDATE SET
             score = excluded.score,
             score_source = excluded.score_source,
             emotional_tags = excluded.emotional_tags,
             status_changes = excluded.status_changes,
             narrative_flags = excluded.narrative_flags,
             has_dialogue = excluded.has_dialogue,
             has_action = excluded.has_action,
             has_internal_thought = excluded.has_internal_thought,
             word_count = excluded.word_count,
             scored_by = excluded.scored_by,
             scored_at = excluded.scored_at`,
        ).run(
          crypto.randomUUID(), data.chunkId, data.chatId,
          salienceResult.score, salienceResult.source,
          JSON.stringify(salienceResult.emotionalTags),
          JSON.stringify(salienceResult.statusChanges),
          JSON.stringify(salienceResult.narrativeFlags),
          salienceResult.hasDialogue ? 1 : 0,
          salienceResult.hasAction ? 1 : 0,
          salienceResult.hasInternalThought ? 1 : 0,
          salienceResult.wordCount,
          now, salienceResult.source === "sidecar" ? "sidecar" : null, now,
        );
        db.query("UPDATE chat_chunks SET salience_score = ?, emotional_tags = ? WHERE id = ?").run(
          salienceResult.score,
          JSON.stringify(salienceResult.emotionalTags),
          data.chunkId,
        );
        timings.dbMs += performance.now() - dbStart;
      }

      if (config.entityTracking && config.entityExtractionMode !== "off") {
        const heuristicEntities = heuristicResult?.entities ?? extractEntitiesHeuristic(
          cleanContent,
          knownEntities,
          characterNames,
          config.entityWhitelist,
          config.entityPruning.minConfidence,
          config.entityExtractionFilters,
        );

        const refinedFallback = heuristicResult ? null : refineHeuristicDetections({
          content: cleanContent,
          knownEntities,
          characterNames,
          entities: heuristicEntities,
          relationships: [],
          aliases: detectNicknameIntroductions(cleanContent, knownEntities, characterNames).map((alias) => ({
            ...alias,
            evidence: "nickname introduction",
          })),
          descriptionAliases: descriptionAliases
            ? [...descriptionAliases.entries()].map(([alias, canonicalName]) => ({ alias, canonicalName }))
            : undefined,
        });

        const refinedEntities = refinedFallback?.entities ?? heuristicEntities;

        // Sidecar arbiter: drop heuristic entities the sidecar rejected and
        // rename heuristic entities the sidecar transformed to a canonical
        // form. Done before merge so sidecar's own list naturally dedupes
        // with the transformed names.
        const arbitratedHeuristicEntities = sidecarGrading
          ? applyEntityGrading(refinedEntities, sidecarGrading)
          : refinedEntities;

        const mergedEntities = filterEntitiesByExtractionFilters(
          mergeExtractedEntities(arbitratedHeuristicEntities, sidecarEntities),
          cleanContent,
          config.entityExtractionFilters,
        );

        const heuristicRelationshipsRaw = heuristicResult?.relationships ?? refinedFallback?.relationships ?? extractRelationshipsHeuristic(
          cleanContent,
          mergedEntities.map((e) => e.name),
          salienceResult.emotionalTags,
        );
        const heuristicRelationships = sidecarGrading
          ? applyRelationshipGrading(heuristicRelationshipsRaw, sidecarGrading)
          : heuristicRelationshipsRaw;

        const allowedEntityNames = new Set(mergedEntities.map((entity) => entity.name.toLowerCase()));
        const allRelationships = mergeRelationships(heuristicRelationships, sidecarRelationships).filter(
          (rel) => allowedEntityNames.has(rel.source.toLowerCase()) && allowedEntityNames.has(rel.target.toLowerCase()),
        );

        const heuristicAliases = heuristicResult?.aliases ?? refinedFallback?.aliases ?? detectNicknameIntroductions(cleanContent, knownEntities, characterNames);
        const allDiscoveredAliases = [...sidecarDiscoveredAliases, ...heuristicAliases]
          .filter((alias) => isPlausibleAlias(alias.alias, alias.canonicalName));

        const graphStart = performance.now();
        const entityIds = entityGraph.ingestChunkEntities(
          data.chatId,
          data.chunkId,
          data.createdAt,
          mergedEntities,
          allRelationships as any[],
          salienceResult.score,
          salienceResult.emotionalTags,
          cleanContent,
          undefined,
          allDiscoveredAliases,
        );
        timings.graphMs += performance.now() - graphStart;

        const dbStart = performance.now();
        db.query("UPDATE chat_chunks SET entity_ids = ? WHERE id = ?").run(JSON.stringify(entityIds), data.chunkId);
        // Allowlist (characterNames + description aliases + persisted
        // character-type entities) is the authoritative gate. Don't add an
        // entityType check here: resolveEntityTypeFromEvidence can promote or
        // demote a freshly-extracted character entity to a different type
        // based on accumulated metadata, and that would silently drop
        // legitimate attributions. If the name passes the allowlist, we know
        // it's a real character regardless of what the graph's evidence
        // resolution currently says about its type.
        for (const attr of fontResult.attributions) {
          if (!attr.entityName) continue;
          if (!isAllowedColorName(attr.entityName)) continue;
          const entity = entityGraph.findEntityByName(data.chatId, attr.entityName);
          if (!entity) continue;
          recordColorAttribution(data.chatId, attr.hexColor, entity.id, attr.usageType, null);
        }
        for (const fc of sidecarFontColors) {
          if (!isAllowedColorName(fc.characterName)) continue;
          const entity = entityGraph.findEntityByName(data.chatId, fc.characterName);
          if (!entity) continue;
          recordColorAttribution(data.chatId, fc.hexColor, entity.id, fc.usageType, null);
        }
        timings.dbMs += performance.now() - dbStart;

        const postGraphStart = performance.now();
        for (const ext of mergedEntities) {
          const entity = entityGraph.findEntityByName(data.chatId, ext.name);
          if (entity && !entity.description) {
            const excerpt = extractMentionExcerpt(ext.name, cleanContent);
            if (excerpt) entityGraph.populateEntityDescription(entity.id, excerpt);
          }
        }

        if (config.entityPruning.enabled) {
          const chunkCount = db.query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ?").get(data.chatId) as any;
          if (chunkCount?.c && chunkCount.c % 50 === 0) {
            entityGraph.pruneStaleEntities(data.chatId, config.entityPruning.staleAfterMessages);
          }
        }

        const chunkImportance = Math.round(salienceResult.score * 10);
        const factThreshold = config.factManagement.importanceThreshold;
        const maxFacts = config.factManagement.maxFactsPerEntity;

        // Deferred autopilot: collect entity ID for post-transaction LLM curation.
        // Returned from the transaction so the async LLM call runs after commit.

        if (sidecarFacts.length > 0 && sidecarEntities.length > 0 && chunkImportance >= factThreshold) {
          const subjectEntity = sidecarEntities.find((e) => e.role === "subject") ?? sidecarEntities[0];
          const entity = entityGraph.findEntityByName(data.chatId, subjectEntity.name);
          if (entity) {
            if (config.factManagement.autopilot && sidecarActive) {
              // Defer LLM call to after the transaction completes
              deferredAutopilotEntityId = entity.id;
              entityGraph.addEntityFacts(entity.id, sidecarFacts, null, chunkImportance, maxFacts);
            } else {
              entityGraph.addEntityFacts(entity.id, sidecarFacts, null, chunkImportance, maxFacts);
            }
          }
        }

        if (salienceResult.statusChanges.length > 0) {
          for (const change of salienceResult.statusChanges) {
            const entity = entityGraph.findEntityByName(data.chatId, change.entity);
            if (!entity) continue;
            const statusMap: Record<string, string> = {
              died: "deceased",
              destroyed: "destroyed",
              departed: "inactive",
              transformed: "active",
            };
            const newStatus = statusMap[change.change];
            if (newStatus) entityGraph.updateEntityStatus(entity.id, newStatus as any);
            // Status changes are always high-importance (8+)
            entityGraph.addEntityFacts(entity.id, [`${change.change}: ${change.detail}`], null, 8, maxFacts);
          }
        }

        for (const discovered of allDiscoveredAliases) {
          const canonicalEntity = entityGraph.findEntityByName(data.chatId, discovered.canonicalName);
          if (!canonicalEntity) continue;
          entityGraph.upsertEntity(data.chatId, {
            name: canonicalEntity.name,
            type: canonicalEntity.entityType,
            aliases: [discovered.alias],
            confidence: Number(canonicalEntity.confidence) || 0.9,
          }, data.chunkId, data.createdAt);

          const evidence = "evidence" in discovered ? (discovered as any).evidence : undefined;
          // Alias facts are durable metadata — always high importance
          entityGraph.addEntityFacts(canonicalEntity.id, [
            evidence
              ? `Also known as "${discovered.alias}" (${evidence})`
              : `Also known as "${discovered.alias}"`,
          ], null, 7, maxFacts);
        }
        timings.graphMs += performance.now() - postGraphStart;
      }

      // Only runs server-side during sidecar mode (amortized cost acceptable).
      // Does NOT run in heuristic-only mode to protect mobile latency.
      if (sidecarActive) {
        // cleanContent is already prose-only (stripped upstream), so feed it directly.
        const npCandidates = extractNPsFromChunk(cleanContent);
        for (const np of npCandidates) {
          const resolved = entityGraph.resolveCanonicalId(np.text, data.chatId);
          if (resolved) {
            entityGraph.updateEntityMentionTimestamp(resolved, data.createdAt);
            continue;
          }

          const variants = getInflectionalVariants(np.text);
          let variantResolved = false;
          for (const variant of variants) {
            const existing = entityGraph.resolveCanonicalId(variant, data.chatId);
            if (existing) {
              entityGraph.updateEntityMentionTimestamp(existing, data.createdAt);
              variantResolved = true;
              break;
            }
          }
          if (variantResolved) continue;

          if (descriptionAliases && isPlausibleAlias(np.text)) {
            const aliasCanonical = descriptionAliases.get(np.text.toLowerCase());
            if (aliasCanonical) {
              const entity = entityGraph.findEntityByName(data.chatId, aliasCanonical);
              if (entity) {
                entityGraph.updateEntityMentionTimestamp(entity.id, data.createdAt);
                entityGraph.upsertEntity(data.chatId, {
                  name: entity.name,
                  type: entity.entityType,
                  aliases: [np.text],
                  confidence: Number(entity.confidence) || 0.9,
                }, data.chunkId, data.createdAt);
                continue;
              }
            }
          }

          const prefixMatch = isPlausibleAlias(np.text) ? findPrefixMatch(np.text, characterNames) : null;
          if (prefixMatch) {
            const entity = entityGraph.findEntityByName(data.chatId, prefixMatch);
            if (entity) {
              entityGraph.updateEntityMentionTimestamp(entity.id, data.createdAt);
              entityGraph.upsertEntity(data.chatId, {
                name: entity.name,
                type: entity.entityType,
                aliases: [np.text],
                confidence: Number(entity.confidence) || 0.9,
              }, data.chunkId, data.createdAt);
              continue;
            }
          }

          if (np.text.length >= 2 && np.text.length <= 50) {
            entityGraph.upsertEntity(data.chatId, {
              name: np.text,
              type: "concept",
              aliases: [],
              confidence: 0.5,
              provisional: true,
            }, data.chunkId, data.createdAt);
          }
        }
        entityGraph.processProvisionalEntities(data.chatId);
      }

      if (sidecarActive && salienceResult.score >= 0.5) {
        const needsFacts = entityGraph.getEntitiesNeedingFactExtraction(data.chatId, 0.45, 3);
        for (const entity of needsFacts) {
          const existingEntity = entityGraph.findEntityByName(data.chatId, entity.name);
          if (existingEntity && sidecarFacts.length === 0) {
            entityGraph.updateFactExtractionStatus(existingEntity.id, "attempted_empty");
          }
        }
      }

      // Sidecar arbiter: delete existing graph entities the sidecar judged as
      // invalid (e.g., a verb erroneously persisted in an earlier chunk).
      // Gated on gradesExistingRecords. User-edited entities are preserved by
      // deleteEntityIfNotUserEdited regardless of sidecar verdict.
      if (sidecarGrading
        && config.sidecarReliability.gradesExistingRecords
        && sidecarGrading.rejectedExistingEntities.length > 0) {
        let deletedCount = 0;
        for (const rejectedName of sidecarGrading.rejectedExistingEntities) {
          const entity = entityGraph.findEntityByName(data.chatId, rejectedName);
          if (!entity) continue;
          if (entityGraph.deleteEntityIfNotUserEdited(entity.id)) deletedCount++;
        }
        if (deletedCount > 0) {
          console.info(
            `[memory-cortex] Sidecar graded ${deletedCount} existing entit${deletedCount === 1 ? "y" : "ies"} as invalid; removed from graph.`,
          );
        }
      }

      db.query(
        "UPDATE chat_chunks SET cortex_warmup_signature = ?, cortex_warmup_completed_at = ? WHERE id = ?",
      ).run(warmupSignature, now, data.chunkId);

      return deferredAutopilotEntityId;
    })();
    timings.dbMs += performance.now() - persistStartedAt;

    // Fact Auto-Pilot: run LLM curation after the transaction commits
    if (deferredFactAutopilot && config.factManagement.autopilot
      && sidecarActive && generateRawFn && sidecarConnectionId) {
      const chunkImp = Math.round(salienceResult.score * 10);
      await curateEntityFactsWithLLM(
        deferredFactAutopilot, sidecarFacts, chunkImp,
        config.factManagement.maxFactsPerEntity,
        generateRawFn, sidecarConnectionId, config,
      );
    }

    // Relationship Reactivation: check for dormant user-curated relations
    // that received fresh evidence in this chunk. If the arbiter is active,
    // ask it whether to reactivate; otherwise auto-reactivate.
    if (sidecarActive && config.sidecarReliability.arbitratesHeuristics) {
      await evaluatePendingReactivations(
        data.chatId, proseContent, generateRawFn!, sidecarConnectionId!, config,
      );
    } else {
      // Non-arbiter mode: auto-reactivate any pending relations
      autoReactivatePendingRelations(data.chatId);
    }

    const mode: CortexIngestionTimings["mode"] = extraction
      ? (heuristicResult ? "mixed" : "sidecar")
      : "heuristic";
    const completedTimings: CortexIngestionTimings = {
      mode,
      fontMs: timings.fontMs,
      heuristicMs: timings.heuristicMs,
      heuristicSalienceMs: timings.heuristicSalienceMs,
      heuristicEntityMs: timings.heuristicEntityMs,
      heuristicRelationshipMs: timings.heuristicRelationshipMs,
      heuristicAliasMs: timings.heuristicAliasMs,
      sidecarMs: timings.sidecarMs,
      graphMs: timings.graphMs,
      dbMs: timings.dbMs,
      totalMs: performance.now() - pipelineStartedAt,
      completedAt: Date.now(),
      chunkId: data.chunkId,
    };
    completeIngestionTracking(data.userId, data.chatId, data.chunkId, completedTimings);
  } catch (err: any) {
    failIngestionTracking(data.userId, data.chatId, err?.message || "Cortex ingestion failed");
    throw err;
  }

  // ── Consolidation Check ──

  if (config.consolidation.enabled) {
    // Run async — don't block the ingestion pipeline
    consolidation
      .maybeConsolidate(
        data.userId,
        data.chatId,
        config.consolidation,
        generateRawFn,
        sidecarConnectionId,
        config.sidecarTimeoutMs,
        buildSidecarSamplingParameters(config.sidecar, { includeMaxTokens: false }),
        config.nonProseScaffoldTags,
      )
      .catch((err) => {
        console.warn("[memory-cortex] Consolidation failed:", err);
      });
  }
}

// ─── Rebuild ───────────────────────────────────────────────────

/**
 * Rebuild all cortex-derived data from canonical chat chunks.
 * Used for recovery, migration, or after configuration changes.
 *
 * This wipes and reconstructs: entities, mentions, relations, salience, consolidations.
 */
// ─── Rebuild State (in-memory, survives browser close) ─────────

/** What the rebuild is doing right now. Surfaced so the UI can show "Awaiting
 *  provider response..." instead of a frozen 0% during long LLM calls. */
export type RebuildPhase =
  | "starting"
  | "heuristic_only"
  | "precompute"
  | "awaiting_provider"
  | "ingesting"
  | "idle_between_batches";

interface RebuildState {
  chatId: string;
  status: "processing" | "complete" | "error" | "superseded";
  current: number;
  total: number;
  percent: number;
  /** Coarse-grained phase of the most recently active batch worker. With
   *  multiple concurrent batch workers, this reflects the latest transition;
   *  the more accurate "is anything in flight" signal is inFlightBatches. */
  phase: RebuildPhase;
  /** Number of batches currently awaiting a provider response. > 0 means at
   *  least one LLM call is in flight. */
  inFlightBatches: number;
  /** Epoch ms of the most recent batch dispatched to the provider. */
  lastProviderRequestAt: number | null;
  /** Wall-clock ms of the most recent completed batch response. */
  lastProviderResponseMs: number | null;
  result?: { chunksProcessed: number; entitiesFound: number; relationsFound: number };
  error?: string;
  startedAt: number;
}

const activeRebuilds = new Map<string, RebuildState>();

/** Get the current rebuild state for a chat (if any). Used by the status endpoint. */
export function getRebuildStatus(chatId: string): RebuildState | null {
  return activeRebuilds.get(chatId) ?? null;
}

/** Default concurrency for sidecar calls during rebuild */
const REBUILD_CONCURRENCY = 5;

/** Minimum cleaned-content length to bother pre-computing heuristics for the
 *  arbiter prompt during rebuild. Chunks below this almost never contain
 *  graphable entities; skipping the worker call shortens the critical path. */
const ARBITER_PRECOMPUTE_MIN_CHARS = 80;

export async function rebuildCortex(
  userId: string,
  chatId: string,
  characterNames: string[],
  generateRawFn?: (opts: {
    connectionId: string;
    messages: Array<{ role: string; content: string }>;
    parameters: Record<string, any>;
    tools?: import("../../llm/types").ToolDefinition[];
    signal?: AbortSignal;
  }) => Promise<{ content: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> }>,
  sidecarConnectionId?: string,
  /** Called whenever the rebuild's state changes meaningfully (progress tick,
   *  phase transition, batch dispatch/response). Receives a snapshot of the
   *  full RebuildState so callers can relay phase + in-flight info to the
   *  frontend, not just current/total. */
  onProgress?: (state: Readonly<RebuildState>) => void,
  descriptionAliases?: Map<string, string>,
  options: CortexRebuildOptions = {},
): Promise<{ chunksProcessed: number; entitiesFound: number; relationsFound: number }> {
  const config = getCortexConfig(userId);
  if (!config.enabled) {
    return { chunksProcessed: 0, entitiesFound: 0, relationsFound: 0 };
  }
  const resumable = options.resumable === true;
  const warmupSignature = options.warmupSignature || getCortexStructuralSignature(config);
  const sidecarAvailable = shouldUseCortexSidecar(config) && !!generateRawFn && !!sidecarConnectionId;
  const sidecarAnalysisActive = shouldUseCortexSidecarForChunkAnalysis(config) && !!generateRawFn && !!sidecarConnectionId;
  const signal = options.signal;
  const db = getDb();

  console.info(
    `[memory-cortex] ${resumable ? "Warming" : "Rebuilding"} cortex for chat ${chatId} (sidecar: ${sidecarAvailable ? "yes" : "heuristic only"})`,
  );

  let completedBeforeStart = 0;
  let totalChunks = 0;
  let chunks: any[] = [];

  if (!resumable) {
    clearDerivedCortexData(chatId);
    chunks = db
      .query("SELECT * FROM chat_chunks WHERE chat_id = ? ORDER BY created_at ASC")
      .all(chatId) as any[];
    totalChunks = chunks.length;
  } else {
    const coverage = getCortexWarmupCoverage(chatId, warmupSignature);
    totalChunks = coverage.totalChunks;

    if (coverage.requiresFullRebuild) {
      // Passive warmup runs after chat activity. If the only warmed chunk was
      // invalidated by an appended message, completedChunks can drop to zero;
      // keep existing salience visible until replacement scores are upserted.
      clearDerivedCortexData(chatId, { preserveSalience: true });
      chunks = db
        .query("SELECT * FROM chat_chunks WHERE chat_id = ? ORDER BY created_at ASC")
        .all(chatId) as any[];
    } else {
      completedBeforeStart = coverage.completedChunks;
      chunks = db
        .query(
          "SELECT * FROM chat_chunks WHERE chat_id = ? AND (cortex_warmup_signature IS NULL OR cortex_warmup_signature != ?) ORDER BY created_at ASC",
        )
        .all(chatId, warmupSignature) as any[];
    }
  }

  // Track state so the frontend can reconnect and see progress
  const state: RebuildState = {
    chatId,
    status: "processing",
    current: completedBeforeStart,
    total: totalChunks,
    percent: totalChunks > 0 ? Math.round((completedBeforeStart / totalChunks) * 100) : 100,
    phase: "starting",
    inFlightBatches: 0,
    lastProviderRequestAt: null,
    lastProviderResponseMs: null,
    startedAt: Date.now(),
  };
  activeRebuilds.set(chatId, state);
  const emit = () => { if (onProgress) onProgress(state); };
  emit();

  try {
    const concurrency = config.sidecar?.rebuildConcurrency ?? 3;

    if (!sidecarAnalysisActive) {
      // Heuristic-only: sequential, ~1-2ms per chunk — no concurrency needed
      state.phase = "heuristic_only";
      emit();
      for (let i = 0; i < chunks.length; i++) {
        if (signal?.aborted) break;
        await processChunkFromRaw(
          chunks[i],
          chatId,
          userId,
          characterNames,
          sidecarAvailable ? generateRawFn : undefined,
          sidecarAvailable ? sidecarConnectionId : undefined,
          descriptionAliases,
        );
        const current = completedBeforeStart + i + 1;
        state.current = current;
        state.percent = totalChunks > 0 ? Math.round((current / totalChunks) * 100) : 100;
        emit();
        await yieldToEventLoop();
      }
    } else {
      // Each worker pulls up to chunkBatchSize chunks and resolves them in one
      // request. At most concurrency batch requests run at once.
      const chunkBatchSize = Math.max(1, config.sidecar?.chunkBatchSize ?? 5);
      let nextChunkIdx = 0;
      let completed = completedBeforeStart;
      const activeGenerateRawFn = generateRawFn!;
      const activeSidecarConnectionId = sidecarConnectionId!;

      // Resolve a token counter once for the whole rebuild. The same counter
      // is shared across all batches because they all use the same sidecar
      // connection / model.
      let rebuildTokenCounter: ((text: string) => number) | undefined;
      try {
        const resolved = await resolveCounter(config.sidecar.model || "");
        rebuildTokenCounter = resolved.count;
        console.info(`[memory-cortex] Rebuild dispatch logging using tokenizer=${resolved.name}`);
      } catch {
        rebuildTokenCounter = undefined;
      }
      let batchCounter = 0;

      const tickProgress = () => {
        completed++;
        state.current = completed;
        state.percent = totalChunks > 0 ? Math.round((completed / totalChunks) * 100) : 100;
        emit();
      };

      const arbiterMode = config.sidecarReliability.arbitratesHeuristics === true;

      async function processNextBatch(): Promise<void> {
        while (nextChunkIdx < chunks.length) {
          if (signal?.aborted) return;
          const start = nextChunkIdx;
          const end = Math.min(start + chunkBatchSize, chunks.length);
          nextChunkIdx = end;

          const batch = chunks.slice(start, end);
          const batchInput = batch.map((chunk, i) => ({
            index: i,
            // Strip non-prose content before the sidecar sees it — matching what
            // the live processChunk path does. Without this, Spindle extension
            // tags, HUD blocks, scaffold markup, and other XML-wrapped content
            // would leak into the batch prompt and pollute extraction/salience.
            // keepFontTags: true so the sidecar can still do color attribution.
            content: stripNonProseTags(
              hydrateChunkContentFromMessages(safeJsonArray(chunk.message_ids), chunk.content),
              { keepFontTags: true, extraScaffoldTags: config.nonProseScaffoldTags },
            ),
          }));

          // Arbiter mode: pre-compute heuristics for the whole batch so the
          // batched LLM call can grade them. Heuristic results are forwarded
          // to processChunkWithPrecomputedSidecar to avoid running the worker
          // a second time during ingestion.
          let perChunkHeuristic: Array<import("./heuristic-runtime").HeuristicAnalysisOutput | null> = new Array(batch.length).fill(null);
          let perChunkArbiter: Array<import("./salience-sidecar").BatchArbiterChunk | null> | undefined;
          let batchExistingEntities: string[] | undefined;
          if (arbiterMode) {
            state.phase = "precompute";
            emit();
            const batchKnownEntities = entityGraph.getActiveEntities(chatId);
            if (config.sidecarReliability.gradesExistingRecords) {
              // Merge top confirmed entities + ALL provisionals. Provisionals
              // sort last by mention_count and would otherwise be cut by the
              // cap — but they're exactly the entries most likely to be junk
              // that the arbiter should grade.
              const confirmedNames = batchKnownEntities.slice(0, 60).map((e) => e.name);
              const provisionalNames = entityGraph.getProvisionalEntityNames(chatId);
              const seen = new Set(confirmedNames.map((n) => n.toLowerCase()));
              for (const pn of provisionalNames) {
                if (!seen.has(pn.toLowerCase())) {
                  confirmedNames.push(pn);
                  seen.add(pn.toLowerCase());
                }
              }
              batchExistingEntities = confirmedNames;
            }
            const heuristicKnownEntities = batchKnownEntities.map((e) => ({
              name: e.name,
              entityType: e.entityType,
              aliases: e.aliases,
            }));
            const heuristicAliases = descriptionAliases
              ? [...descriptionAliases.entries()].map(([alias, canonicalName]) => ({ alias, canonicalName }))
              : undefined;

            perChunkHeuristic = await Promise.all(
              batch.map((_, i) => {
                const raw = batchInput[i].content;
                // Approximate processChunk's cleanContent: strip non-prose
                // tags, then font tags, then thought delimiters. Pure (no DB
                // writes). Slight divergence from processChunk's full
                // processChunkFontColors path is acceptable for grading input.
                const proseContent = stripNonProseTags(raw, {
                  keepFontTags: true,
                  extraScaffoldTags: config.nonProseScaffoldTags,
                });
                const cleanContent = stripThoughtDelimiters(stripFontTags(proseContent), config.thoughtMarkers);

                // Skip the worker entirely for chunks too small/empty to plausibly
                // contain entities. Proper nouns are title-cased (Capital +
                // lowercase) — chunks lacking that pattern, or below the length
                // threshold, will produce empty heuristic output. Returning null
                // omits the <arbiter> block for that passage (saving prompt
                // tokens) and lets processChunk run its own heuristic worker
                // during ingestion if needed.
                if (cleanContent.length < ARBITER_PRECOMPUTE_MIN_CHARS || !/[A-Z][a-z]/.test(cleanContent)) {
                  return Promise.resolve(null);
                }

                return runHeuristicAnalysisInWorker({
                  cleanContent,
                  knownEntities: heuristicKnownEntities,
                  characterNames,
                  entityWhitelist: config.entityWhitelist,
                  minConfidence: config.entityPruning.minConfidence,
                  entityExtractionFilters: config.entityExtractionFilters,
                  descriptionAliases: heuristicAliases,
                }).catch(() => null);
              }),
            );

            perChunkArbiter = perChunkHeuristic.map((h) => {
              if (!h) return null;
              return {
                heuristicEntities: h.entities.map((e) => ({ name: e.name, type: e.type })),
                heuristicRelationships: h.relationships.map((r) => ({ source: r.source, target: r.target, type: r.type })),
              };
            });
          }

          const batchIdx = ++batchCounter;
          const requestStart = Date.now();
          state.inFlightBatches += 1;
          state.lastProviderRequestAt = requestStart;
          state.phase = "awaiting_provider";
          emit();

          let sidecarResults: Array<import("./types").SidecarExtractionResult | null>;
          try {
            sidecarResults = await extractBatchWithSidecar(
              batchInput,
              activeGenerateRawFn,
              activeSidecarConnectionId,
              {
                characterNames,
                perChunkArbiter,
                batchExistingEntities,
                descriptionAliases: buildSidecarAliasList(
                  descriptionAliases,
                  entityGraph.getActiveEntities(chatId),
                ),
                samplingParameters: buildSidecarSamplingParameters(config.sidecar),
                tokenCounter: rebuildTokenCounter,
                logTag: `rebuild:batch-${batchIdx} chat=${chatId.slice(0, 8)}`,
              },
            );
          } catch (err: any) {
            console.warn(`[memory-cortex] rebuild:batch-${batchIdx} threw, all chunks falling back to heuristic:`, err?.message ?? err);
            sidecarResults = new Array(batch.length).fill(null);
          } finally {
            state.inFlightBatches = Math.max(0, state.inFlightBatches - 1);
            state.lastProviderResponseMs = Date.now() - requestStart;
            // Other concurrent workers may still be awaiting the provider, so
            // only flip back to "ingesting" if nothing else is in flight.
            state.phase = state.inFlightBatches > 0 ? "awaiting_provider" : "ingesting";
            emit();
          }

          for (let i = 0; i < batch.length; i++) {
            // Bail before persisting this batch if a superseding rebuild has
            // preempted us — its clearDerivedCortexData + reprocess owns the
            // chat now, so writing here would just be overwritten work.
            if (signal?.aborted) return;
            const chunk = batch[i];
            try {
              const sidecarResult = sidecarResults[i];
              if (sidecarResult) {
                await processChunkWithPrecomputedSidecar(
                  chunk, chatId, userId, characterNames, sidecarResult, descriptionAliases,
                  perChunkHeuristic[i] ?? undefined,
                );
              } else {
                await processChunkFromRaw(chunk, chatId, userId, characterNames, undefined, undefined, descriptionAliases);
              }
            } catch {
              // fall back to heuristic on ingest failure
              await processChunkFromRaw(chunk, chatId, userId, characterNames, undefined, undefined, descriptionAliases);
            }
            tickProgress();
          }
        }
      }

      // concurrency workers, each pulls batches
      const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, () => processNextBatch());
      await Promise.all(workers);
    }

    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Cortex rebuild aborted", "AbortError");
    }

    const entities = entityGraph.getEntities(chatId);
    const relations = entityGraph.getRelations(chatId);

    const result = {
      chunksProcessed: totalChunks,
      entitiesFound: entities.length,
      relationsFound: relations.length,
    };

    state.status = "complete";
    state.result = result;
    // Keep state around for 5 minutes so reconnecting clients can see the
    // result. Guard the delete: a stale timer must never evict a newer rebuild's
    // state that has since replaced this one for the same chat.
    setTimeout(() => { if (activeRebuilds.get(chatId) === state) activeRebuilds.delete(chatId); }, 5 * 60 * 1000);

    console.info(
      `[memory-cortex] ${resumable ? "Warmup" : "Rebuild"} complete: ${totalChunks} chunks, ${entities.length} entities, ${relations.length} relations`,
    );

    return result;
  } catch (err: any) {
    // A deliberately superseded run (an explicit rebuild preempted this warmup)
    // is not a failure — don't mark it "error" or the superseding run, which
    // owns the chat's progress stream, gets shadowed by a spurious error state.
    state.status = signal?.aborted ? "superseded" : "error";
    if (!signal?.aborted) state.error = err?.message || "Rebuild failed";
    setTimeout(() => { if (activeRebuilds.get(chatId) === state) activeRebuilds.delete(chatId); }, 60 * 1000);
    throw err;
  }
}

/** Helper: convert a raw DB chunk row into processChunk input */
async function processChunkFromRaw(
  chunk: any,
  chatId: string,
  userId: string,
  characterNames: string[],
  generateRawFn?: any,
  sidecarConnectionId?: string,
  descriptionAliases?: Map<string, string>,
): Promise<void> {
  await processChunk(
    {
      chunkId: chunk.id,
      chatId: chunk.chat_id || chatId,
      userId,
      content: chunk.content,
      messageIds: safeJsonArray(chunk.message_ids),
      startMessageIndex: 0,
      endMessageIndex: 0,
      createdAt: chunk.created_at,
    },
    characterNames,
    generateRawFn,
    sidecarConnectionId,
    descriptionAliases,
  );
}

/**
 * Process a chunk with a pre-computed sidecar result (from batched extraction).
 * Skips the LLM call inside processChunk by providing a generateRawFn that
 * returns the already-computed result as if the LLM had produced it.
 */
async function processChunkWithPrecomputedSidecar(
  chunk: any,
  chatId: string,
  userId: string,
  characterNames: string[],
  sidecarResult: import("./types").SidecarExtractionResult,
  descriptionAliases?: Map<string, string>,
  /** Pre-computed heuristic output for this chunk. Forwarded to processChunk
   *  so the heuristic worker doesn't run a second time during batched rebuild. */
  precomputedHeuristic?: import("./heuristic-runtime").HeuristicAnalysisOutput,
): Promise<void> {
  // Build a fake generateRawFn that returns pre-computed tool_calls so processChunk's
  // sidecar branch gets structured data without making an actual API call.
  const fakeToolCalls: Array<{ name: string; args: Record<string, unknown> }> = [
    {
      name: "score_salience",
      args: {
        importance: Math.round(sidecarResult.score * 10),
        emotional_tones: sidecarResult.emotionalTags,
        narrative_flags: sidecarResult.narrativeFlags,
        key_facts: sidecarResult.keyFacts,
      },
    },
    {
      name: "extract_entities",
      args: {
        entities: sidecarResult.entitiesPresent.map((e) => ({
          name: e.name, type: e.type, role: e.role ?? "present",
        })),
        discovered_aliases: (sidecarResult.discoveredAliases || []).map((a) => ({
          canonical_name: a.canonicalName,
          alias: a.alias,
          evidence: a.evidence,
        })),
        status_changes: sidecarResult.statusChanges,
      },
    },
    {
      name: "extract_relationships",
      args: {
        relationships: sidecarResult.relationshipsShown,
      },
    },
    {
      name: "extract_font_colors",
      args: {
        color_attributions: (sidecarResult.fontColors || []).map((fc) => ({
          hex_color: fc.hexColor,
          character_name: fc.characterName,
          usage_type: fc.usageType,
        })),
      },
    },
  ];

  // Forward the batched arbiter's verdict so processChunk's merge logic can
  // drop/rename heuristic candidates and prune existing graph entities.
  if (sidecarResult.gradedHeuristics) {
    const g = sidecarResult.gradedHeuristics;
    fakeToolCalls.push({
      name: "grade_heuristic_candidates",
      args: {
        rejected_heuristic_entities: g.rejectedHeuristicEntities,
        transformed_heuristic_entities: g.transformedHeuristicEntities.map((t) => ({ from: t.from, to: t.to })),
        rejected_heuristic_relationships: g.rejectedHeuristicRelationships,
        rejected_existing_entities: g.rejectedExistingEntities,
      },
    });
  }

  const fakeGenerateRaw = async () => ({
    content: "",
    tool_calls: fakeToolCalls,
  });

  await processChunk(
    {
      chunkId: chunk.id,
      chatId: chunk.chat_id || chatId,
      userId,
      content: chunk.content,
      messageIds: safeJsonArray(chunk.message_ids),
      startMessageIndex: 0,
      endMessageIndex: 0,
      createdAt: chunk.created_at,
    },
    characterNames,
    fakeGenerateRaw as any,
    "precomputed",
    descriptionAliases,
    precomputedHeuristic,
  );
}

// ─── Backwards Compatibility Adapter ───────────────────────────

/**
 * Convert a CortexResult into the existing MemoryRetrievalResult format
 * used by the prompt assembly pipeline.
 *
 * This allows the cortex to slot in without changing the assembly contract.
 */
export function cortexToMemoryResult(
  cortexResult: CortexResult,
  settings: {
    chunkTemplate: string;
    chunkSeparator: string;
    memoryHeaderTemplate: string;
  },
): {
  chunks: Array<{ content: string; score: number; metadata: any }>;
  formatted: string;
  count: number;
  enabled: boolean;
  queryPreview: string;
  settingsSource: "global" | "per_chat";
  chunksAvailable: number;
  chunksPending: number;
} {
  const chunks = cortexResult.memories.map((m) => ({
    content: m.content,
    score: m.finalScore,
    metadata: {
      source: m.source,
      sourceId: m.sourceId,
      components: m.components,
      emotionalTags: m.emotionalTags,
      entityNames: m.entityNames,
      messageRange: m.messageRange,
    },
  }));

  // Render chunks using the user's templates
  const renderedChunks = chunks.map((c) => {
    let rendered = settings.chunkTemplate;
    rendered = rendered.replace(/\{\{content\}\}/g, c.content);
    rendered = rendered.replace(/\{\{score\}\}/g, c.score.toFixed(4));
    rendered = rendered.replace(/\{\{startIndex\}\}/g, String(c.metadata.messageRange?.[0] ?? "?"));
    rendered = rendered.replace(/\{\{endIndex\}\}/g, String(c.metadata.messageRange?.[1] ?? "?"));
    return rendered;
  });

  const joined = renderedChunks.join(settings.chunkSeparator);
  const formatted = chunks.length > 0
    ? settings.memoryHeaderTemplate.replace(/\{\{memories\}\}/g, joined)
    : "";

  return {
    chunks,
    formatted,
    count: chunks.length,
    enabled: true,
    queryPreview: "",
    settingsSource: "global",
    chunksAvailable: 0,
    chunksPending: 0,
  };
}

// ─── Entity Access (for macros and routes) ─────────────────────

/** Get all entities for a chat */
export function getEntities(chatId: string): MemoryEntity[] {
  return entityGraph.getEntities(chatId);
}

/** Get entity by name */
export function findEntity(chatId: string, name: string): MemoryEntity | null {
  return entityGraph.findEntityByName(chatId, name);
}

/** Get all consolidations for a chat */
export function getConsolidations(chatId: string, tier?: number) {
  return consolidation.getConsolidations(chatId, tier);
}

/** Get active relations for a chat */
export function getRelations(chatId: string) {
  return entityGraph.getRelations(chatId);
}

/** Get all viewable relations including dormant/broken/former (for UI listing) */
export function getRelationsIncludingInactive(chatId: string) {
  return entityGraph.getRelationsIncludingInactive(chatId);
}

// ─── Helpers ───────────────────────────────────────────────────

/**
 * Build LLM sampling parameters from the user-configured sidecar settings.
 *
 * The cortex settings UI exposes temperature, topP, and maxTokens; these need
 * to flow through to the underlying LLM call. Without this, the sidecar
 * silently fell back to the legacy hardcoded {temperature: 0.1} and ignored
 * the user's configuration entirely.
 *
 * `includeMaxTokens` is opt-out for consolidation, which manages max_tokens
 * per-call from config.maxTokensPerSummary.
 */
function buildSidecarSamplingParameters(
  sidecar: MemoryCortexConfig["sidecar"],
  opts: { includeMaxTokens?: boolean } = {},
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (typeof sidecar.temperature === "number" && Number.isFinite(sidecar.temperature)) {
    params.temperature = sidecar.temperature;
  } else {
    params.temperature = 0.1;
  }
  if (typeof sidecar.topP === "number" && Number.isFinite(sidecar.topP) && sidecar.topP > 0 && sidecar.topP < 1) {
    params.top_p = sidecar.topP;
  }
  if (opts.includeMaxTokens !== false
    && typeof sidecar.maxTokens === "number"
    && Number.isFinite(sidecar.maxTokens)
    && sidecar.maxTokens > 0) {
    params.max_tokens = sidecar.maxTokens;
  }
  return params;
}

/**
 * LLM-arbitrated fact curation ("Fact Auto-Pilot").
 * When the entity's facts exceed maxFacts, asks the sidecar to decide which
 * facts to keep, merge, or discard.
 *
 * Salience back-linking: each fact carries an [i:N] importance tag from its
 * source chunk's salience score. The LLM sees these scores so it can weigh
 * "this fact came from a story-defining moment" vs "this came from filler".
 * Surviving facts retain their original importance; merged facts inherit the
 * highest importance of their constituents.
 */
async function curateEntityFactsWithLLM(
  entityId: string,
  _newFacts: string[],
  _chunkImportance: number,
  maxFacts: number,
  generateRawFn: (opts: {
    connectionId: string;
    messages: Array<{ role: string; content: string }>;
    parameters: Record<string, any>;
    tools?: import("../../llm/types").ToolDefinition[];
    signal?: AbortSignal;
  }) => Promise<{ content: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> }>,
  connectionId: string,
  config: MemoryCortexConfig,
): Promise<void> {
  // Read raw facts WITH importance tags to preserve provenance
  const entity = entityGraph.getEntity(entityId);
  if (!entity || entity.facts.length <= maxFacts) return;

  // Build scored fact list: { text (clean), importance, raw }
  const scoredFacts = entity.facts.map((raw) => ({
    raw,
    text: entityGraph.stripFactTags(raw),
    importance: entityGraph.getFactImportance(raw),
  }));

  const prompt = `You are a memory curator for a narrative entity. Given the numbered facts below (each with a salience score 0–10), select which to KEEP.

SCORING CONTEXT:
- The [salience:N] prefix shows how narratively important the source passage was.
- Higher salience = the fact emerged from a story-defining moment (death, betrayal, discovery, transformation).
- Lower salience = the fact came from routine or atmospheric content.

RULES:
- You MUST keep facts with salience >= 7 unless they are provably superseded by a later fact (e.g. "X is alive" superseded by "X died").
- You MUST keep facts about lasting events: deaths, betrayals, promises, confessions, transformations, major actions, status changes, and relationship changes — regardless of salience score.
- You MUST keep facts that would be untrue or misleading to forget (e.g. "X stole from Y" cannot be discarded just because newer events happened).
- You MAY discard facts with salience <= 3 that are purely transient observations (walked somewhere, looked around, routine movements) with no lasting consequence.
- You MAY merge near-duplicate facts into one concise fact. When merging, keep the higher salience score.
- Return at most ${maxFacts} facts.

OUTPUT FORMAT:
Return a JSON array of objects: [{"text": "fact text", "salience": N}, ...]
Each object has the curated fact text and its salience score (preserve original, or use the highest if merging).

CURRENT FACTS:
${scoredFacts.map((f, i) => `${i + 1}. [salience:${f.importance}] ${f.text}`).join("\n")}`;

  try {
    const result = await generateRawFn({
      connectionId,
      messages: [
        { role: "system", content: "You are a factual memory curator. Output valid JSON only — an array of {\"text\": string, \"salience\": number} objects." },
        { role: "user", content: prompt },
      ],
      parameters: {
        ...buildSidecarSamplingParameters(config.sidecar, { includeMaxTokens: false }),
        max_tokens: 2048,
        temperature: 0.1,
      },
    });

    const text = result.content.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;

    const curated: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(curated) || curated.length === 0) return;

    const curatedFacts: Array<{ text: string; importance: number }> = [];
    for (const item of curated) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const factText = typeof obj.text === "string" ? obj.text.trim() : "";
      if (!factText) continue;
      // Preserve original salience, falling back to 5
      const salience = typeof obj.salience === "number" && Number.isFinite(obj.salience)
        ? Math.max(0, Math.min(10, Math.round(obj.salience)))
        : 5;
      curatedFacts.push({ text: factText, importance: salience });
    }

    if (curatedFacts.length === 0) return;

    // Rebuild tagged facts preserving per-fact provenance
    const tagged = curatedFacts
      .slice(0, maxFacts)
      .map((f) => `[i:${f.importance}] ${f.text}`);
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    db.query(
      `UPDATE memory_entities SET facts = ?, fact_extraction_status = 'ok', updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(tagged), now, entityId);
  } catch (err) {
    console.warn("[memory-cortex] Fact autopilot LLM call failed, keeping score-based result:", err);
  }
}

/**
 * Auto-reactivate all pending dormant relations for a chat (non-arbiter mode).
 * Called when the sidecar/arbiter isn't available to make nuanced decisions.
 */
function autoReactivatePendingRelations(chatId: string): void {
  const db = getDb();
  const rows = db.query(
    `SELECT id, metadata FROM memory_relations
     WHERE chat_id = ? AND status != 'active'
       AND metadata LIKE '%"pending_reactivation":true%'`,
  ).all(chatId) as Array<{ id: string; metadata: string }>;

  for (const row of rows) {
    entityGraph.reactivateRelation(row.id);
  }
  if (rows.length > 0) {
    console.info(`[memory-cortex] Auto-reactivated ${rows.length} dormant relation(s) on fresh evidence.`);
  }
}

/**
 * Arbiter-evaluated reactivation of dormant user-curated relations.
 * Asks the sidecar whether dormant relations should be restored based on
 * the current passage content (are the entities meaningfully interacting
 * in a way that re-establishes the relationship?).
 */
async function evaluatePendingReactivations(
  chatId: string,
  passageContent: string,
  generateRawFn: (opts: {
    connectionId: string;
    messages: Array<{ role: string; content: string }>;
    parameters: Record<string, any>;
    tools?: import("../../llm/types").ToolDefinition[];
    signal?: AbortSignal;
  }) => Promise<{ content: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> }>,
  connectionId: string,
  config: MemoryCortexConfig,
): Promise<void> {
  const db = getDb();
  const pendingRows = db.query(
    `SELECT r.id, r.source_entity_id, r.target_entity_id, r.relation_type,
            r.relation_label, r.status
     FROM memory_relations r
     WHERE r.chat_id = ? AND r.status != 'active'
       AND r.metadata LIKE '%"pending_reactivation":true%'
       AND r.superseded_by IS NULL AND r.merged_into IS NULL`,
  ).all(chatId) as Array<{
    id: string; source_entity_id: string; target_entity_id: string;
    relation_type: string; relation_label: string | null; status: string;
  }>;

  if (pendingRows.length === 0) return;

  // Resolve entity names for the LLM prompt
  const nameCache = new Map<string, string>();
  const resolveName = (id: string) => {
    if (nameCache.has(id)) return nameCache.get(id)!;
    const row = db.query("SELECT name FROM memory_entities WHERE id = ?").get(id) as any;
    const name = row?.name ?? "Unknown";
    nameCache.set(id, name);
    return name;
  };

  const candidates = pendingRows.map((r) => ({
    id: r.id,
    source: resolveName(r.source_entity_id),
    target: resolveName(r.target_entity_id),
    type: r.relation_type,
    label: r.relation_label,
    currentStatus: r.status,
  }));

  const prompt = `Given the passage below, decide whether these DORMANT relationships should be REACTIVATED.

A relationship should be reactivated if the passage shows the entities meaningfully interacting in a way consistent with that relationship type (not just being mentioned in passing).

PASSAGE:
${passageContent.slice(0, 2000)}

DORMANT RELATIONSHIPS:
${candidates.map((c, i) => `${i + 1}. ${c.source} → ${c.target} (${c.type}${c.label ? `: ${c.label}` : ""}) [currently: ${c.currentStatus}]`).join("\n")}

Return a JSON array of objects: [{"index": N, "reactivate": true/false, "reason": "brief reason"}]
Only include entries where you have a clear signal. Omit entries you're unsure about (they stay dormant).`;

  try {
    const result = await generateRawFn({
      connectionId,
      messages: [
        { role: "system", content: "You are a relationship status evaluator. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      parameters: {
        ...buildSidecarSamplingParameters(config.sidecar, { includeMaxTokens: false }),
        max_tokens: 1024,
        temperature: 0.1,
      },
    });

    const text = result.content.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // No decision — keep dormant
      for (const c of candidates) entityGraph.dismissReactivation(c.id);
      return;
    }

    const decisions: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(decisions)) {
      for (const c of candidates) entityGraph.dismissReactivation(c.id);
      return;
    }

    const decided = new Set<string>();
    for (const d of decisions) {
      if (!d || typeof d !== "object") continue;
      const obj = d as Record<string, unknown>;
      const idx = typeof obj.index === "number" ? obj.index - 1 : -1;
      if (idx < 0 || idx >= candidates.length) continue;
      const candidate = candidates[idx];
      decided.add(candidate.id);

      if (obj.reactivate === true) {
        entityGraph.reactivateRelation(candidate.id);
        console.info(`[memory-cortex] Arbiter reactivated: ${candidate.source} → ${candidate.target} (${candidate.type})`);
      } else {
        entityGraph.dismissReactivation(candidate.id);
      }
    }

    // Dismiss any candidates the LLM didn't mention (stay dormant)
    for (const c of candidates) {
      if (!decided.has(c.id)) entityGraph.dismissReactivation(c.id);
    }
  } catch (err) {
    console.warn("[memory-cortex] Relationship reactivation arbiter failed, auto-reactivating:", err);
    for (const c of candidates) entityGraph.reactivateRelation(c.id);
  }
}

/**
 * Apply sidecar arbiter verdict to heuristic entity candidates.
 * - Drops entries whose name is in rejectedHeuristicEntities (case-insensitive).
 * - Renames entries per transformedHeuristicEntities mapping (from→to).
 *
 * Confirmation is by omission: candidates the sidecar didn't mention remain.
 */
function applyEntityGrading<T extends { name: string }>(
  heuristic: T[],
  grading: import("./types").SidecarGradedHeuristics,
): T[] {
  if (heuristic.length === 0) return heuristic;
  const rejected = new Set(grading.rejectedHeuristicEntities.map((n) => n.toLowerCase()));
  const renames = new Map<string, string>();
  for (const t of grading.transformedHeuristicEntities) {
    renames.set(t.from.toLowerCase(), t.to);
  }
  const out: T[] = [];
  for (const e of heuristic) {
    if (rejected.has(e.name.toLowerCase())) continue;
    const rename = renames.get(e.name.toLowerCase());
    out.push(rename ? { ...e, name: rename } : e);
  }
  return out;
}

/**
 * Apply sidecar arbiter verdict to heuristic relationship candidates.
 * Drops triples (source, target, type) that the sidecar judged as unsupported.
 * Comparison is case-insensitive on all three fields.
 */
function applyRelationshipGrading<T extends { source: string; target: string; type: string }>(
  heuristic: T[],
  grading: import("./types").SidecarGradedHeuristics,
): T[] {
  if (heuristic.length === 0 || grading.rejectedHeuristicRelationships.length === 0) return heuristic;
  const rejected = new Set(
    grading.rejectedHeuristicRelationships.map(
      (r) => `${r.source.toLowerCase()}→${r.target.toLowerCase()}:${r.type.toLowerCase()}`,
    ),
  );
  return heuristic.filter(
    (r) => !rejected.has(`${r.source.toLowerCase()}→${r.target.toLowerCase()}:${r.type.toLowerCase()}`),
  );
}

function mergeExtractedEntities(
  heuristic: Array<{ name: string; type: string; aliases: string[]; confidence: number; mentionRole?: string; role?: string }>,
  sidecar: Array<{ name: string; type: string; role?: string }>,
): Array<{ name: string; type: any; aliases: string[]; confidence: number; mentionRole?: any; role?: any }> {
  const merged = new Map<string, any>();

  // Heuristic entities first
  for (const e of heuristic) {
    merged.set(e.name.toLowerCase(), e);
  }

  // Overlay sidecar entities (higher confidence)
  for (const e of sidecar) {
    const key = e.name.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      // Sidecar overrides type — UNLESS sidecar defaulted to "concept" and
      // heuristic inferred a more specific type (location, faction, etc.).
      // Heuristic type inference uses structural signals (suffixes, verb adjacency)
      // that are more reliable than an LLM defaulting to "concept".
      if (e.type && e.type !== "concept") {
        existing.type = e.type;
      }
      existing.role = e.role || existing.role;
      existing.confidence = Math.max(existing.confidence, 0.9);
    } else {
      merged.set(key, {
        name: e.name,
        type: e.type || "concept",
        aliases: [],
        confidence: 0.9,
        mentionRole: e.role || "present",
      });
    }
  }

  return [...merged.values()];
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function hydrateChunkContentFromMessages(messageIds: string[], fallbackContent: string): string {
  if (messageIds.length === 0) return fallbackContent;

  const db = getDb();
  const stmt = db.query("SELECT name, content, is_user FROM messages WHERE id = ?");
  const lines: string[] = [];

  for (const messageId of messageIds) {
    const row = stmt.get(messageId) as { name: string; content: string; is_user: number } | null;
    if (!row) return fallbackContent;
    lines.push(`[${row.is_user ? "USER" : "CHARACTER"} | ${row.name}]: ${row.content}`);
  }

  return lines.join("\n");
}

/**
 * Find an unambiguous prefix match of an NP against character names.
 * Handles abbreviations where the NP is a ≥3-char prefix of exactly
 * ONE character name (or first/last name part).
 *
 * Returns the canonical character name if exactly one match, null otherwise.
 * Ambiguous matches (prefix matches multiple characters) return null.
 */
function findPrefixMatch(np: string, characterNames: string[]): string | null {
  const lower = np.toLowerCase();
  if (lower.length < 3) return null;

  const matches: string[] = [];
  for (const name of characterNames) {
    const parts = [name, ...name.split(/\s+/)];
    for (const part of parts) {
      const partLower = part.toLowerCase();
      // Prefix match: must be shorter than the full part to avoid exact matches
      if (partLower.startsWith(lower) && lower.length < partLower.length && lower.length >= 3) {
        if (!matches.includes(name)) matches.push(name);
        break;
      }
    }
  }

  // Only return if unambiguous — exactly one character matches
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Extract nickname/alias patterns from character or persona description text.
 * Returns a map of lowercase alias → canonical name.
 *
 * Patterns detected:
 *   - "known as X", "also known as X", "aka X", "nicknamed X"
 *   - "called X", "goes by X", "referred to as X", "titled X"
 *   - Quoted nicknames in description text
 *
 * Usage: call once per character/persona during chunk processing setup,
 * pass the merged map to processChunk as `descriptionAliases`.
 */
// ─── Bot Name Filler ──────────────────────────────────────────
// Words that appear in sloppy bot-card names as genre tags, meta labels,
// or scenario descriptors. Used by normalizeCharacterName to distinguish
// the real character name from the surrounding noise.

const BOT_NAME_FILLER = new Set([
  // Meta / platform tags
  "live", "new", "old", "reloaded", "remake", "rework", "updated", "original",
  "alternate", "version", "edition", "nsfw", "sfw", "oc", "wip", "beta", "au", "canon",
  // Narrative structure
  "episode", "chapter", "part", "scenario", "adventure", "story", "encounter",
  "meeting", "date", "quest", "tale", "journey", "arc", "prologue", "epilogue",
  // Genre tags
  "modern", "fantasy", "romance", "action", "horror", "mystery", "drama",
  "comedy", "thriller", "historical", "futuristic", "dystopian", "supernatural",
  // Common descriptive filler
  "chance", "interrogation", "confrontation", "conversation", "introduction",
  // Interjections / filler words
  "ah", "oh", "hey", "hi", "yo", "welcome",
  // Articles / prepositions (short ones caught by length, but include for safety)
  "the", "a", "an", "of", "in", "at", "to", "for", "with", "by", "and", "or",
]);

/**
 * Normalize a sloppy character card name to extract the real character name.
 *
 * Handles common bot-card naming patterns:
 *   - Tag prefixes: "LIVE:", "NSFW:", "OC:", "[WIP]"
 *   - Structural separators: |, _, —, –, :, /
 *   - Decorative Unicode: emoji, CJK brackets, symbols
 *   - Scenario suffixes: "A Chance Interrogation", "Episode 3", "Modern AU"
 *
 * Returns the extracted proper name, or the original trimmed name if
 * no clear proper noun sequence is found.
 */
export function normalizeCharacterName(rawName: string): string {
  // 1. Strip emoji and decorative Unicode
  let cleaned = rawName;
  try {
    cleaned = cleaned.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, "");
  } catch { /* regex unicode support varies */ }
  cleaned = cleaned.replace(/[\u{300}-\u{36F}]/gu, ""); // combining diacritical marks that aren't part of names
  cleaned = cleaned.replace(/[「」『』【】〖〗★☆✨~♡♥●○◆◇■□▪▫▲△▶◀♪♫§†‡※•·]/g, "");

  // 2. Strip bracketed tags: [OC], (NSFW), {WIP}, etc.
  cleaned = cleaned.replace(/[\[({]\s*(?:OC|NSFW|SFW|WIP|BETA|AU|CANON|NEW|UPDATED?|REMAKE|V\d+(?:\.\d+)?)\s*[\])}]/gi, "");

  // 3. Split on structural separators
  const segments = cleaned.split(/[|_—–:\/\\]/).map((s) => s.trim()).filter((s) => s.length >= 2);

  // 4. From each segment, extract runs of title-cased non-filler words
  const candidates: { text: string; wordCount: number; index: number }[] = [];
  let candidateIndex = 0;

  for (const segment of segments) {
    const words = segment.split(/[\s,]+/).filter(Boolean);
    let current: string[] = [];

    const flush = () => {
      if (current.length >= 1 && current.length <= 5) {
        candidates.push({ text: current.join(" "), wordCount: current.length, index: candidateIndex++ });
      }
      current = [];
    };

    for (const word of words) {
      const clean = word.replace(/[.,;:!?"'()\[\]{}]+/g, "").trim();
      if (!clean || clean.length < 2) { flush(); continue; }

      // Must be title-cased (uppercase + lowercase) and not a filler word
      if (/^[A-Z][a-z]/.test(clean) && !BOT_NAME_FILLER.has(clean.toLowerCase())) {
        current.push(clean);
      } else {
        flush();
      }
    }
    flush();
  }

  if (candidates.length === 0) return rawName.trim();

  // 5. Pick the best candidate
  // Priority: 2-3 word names > other multi-word > single word > fallback
  // Tiebreaker: earlier position in the string (real name usually comes first)
  candidates.sort((a, b) => {
    const aMulti = a.wordCount >= 2 ? 1 : 0;
    const bMulti = b.wordCount >= 2 ? 1 : 0;
    if (aMulti !== bMulti) return bMulti - aMulti;
    // Among multi-word, prefer 2-3 words (typical name length)
    if (aMulti && bMulti) {
      const aIdeal = a.wordCount >= 2 && a.wordCount <= 3 ? 1 : 0;
      const bIdeal = b.wordCount >= 2 && b.wordCount <= 3 ? 1 : 0;
      if (aIdeal !== bIdeal) return bIdeal - aIdeal;
    }
    // Earlier position wins (stable tiebreaker)
    return a.index - b.index;
  });

  return candidates[0].text;
}

export function extractDescriptionAliases(
  canonicalName: string,
  ...descriptions: (string | null | undefined)[]
): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const desc of descriptions) {
    if (!desc) continue;

    // Pattern 1: Verb-based with quoted name.
    // Handles verb + optional pronoun + quoted name patterns
    // Optional pronoun object (him/her/them/me/it) + space between verb and quote.
    const quotedPatterns = /(?:known as|also known as|aka|nicknamed|called|goes by|referred to as|titled|call(?:s|ed)?)\s+(?:(?:him|her|them|me|it)\s+)?["'""\u201C\u2018]([^"'""'\u201D\u2019]{2,50})["'""\u201D\u2019]/gi;
    let match;
    while ((match = quotedPatterns.exec(desc)) !== null) {
      addAlias(aliases, match[1], canonicalName);
    }

    // Pattern 2: Unquoted capitalized name — only captures title-cased words.
    // "Known as Lady Fellini among the nobility" → captures "Lady Fellini" (stops at lowercase "among")
    // Note: NO `i` flag — the capture group MUST match actual uppercase to avoid
    // grabbing lowercase words like "him" or "among" as aliases.
    // Keywords use [Xx] alternation for first-letter case insensitivity instead.
    const unquotedPatterns = /(?:[Kk]nown as|[Aa]lso known as|[Aa]ka|[Nn]icknamed|[Cc]alled|[Gg]oes by|[Rr]eferred to as|[Tt]itled)\s+(?:[Tt]he\s+)?([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+){0,4})/g;
    while ((match = unquotedPatterns.exec(desc)) !== null) {
      addAlias(aliases, match[1], canonicalName);
    }

    // Pattern 3: parenthetical aliases — "Name (Alias)", "Name (Alias1, Alias2)"
    const parenPatterns = /\(([^)]{2,60})\)/g;
    while ((match = parenPatterns.exec(desc)) !== null) {
      // Split on commas for multiple aliases in one parenthetical
      for (const part of match[1].split(/,/)) {
        const trimmed = part.trim();
        // Must look name-like: starts with capital or "the"
        if (/^(?:the\s+)?[A-Z]/i.test(trimmed) && trimmed.length >= 2) {
          addAlias(aliases, trimmed, canonicalName);
        }
      }
    }

    // Pattern 4: colloquial intros — "real name is X", "everyone calls him X",
    // "they call her X". Catches forms outside the formal "known as" register.
    const colloquialPatterns = /(?:real name(?:\s+is)?|everyone\s+calls?(?:\s+(?:him|her|them|me|it))?|they\s+call(?:\s+(?:him|her|them|me|it))?)\s+["'“‘]?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})["'”’]?/gi;
    while ((match = colloquialPatterns.exec(desc)) !== null) {
      addAlias(aliases, match[1], canonicalName);
    }

    // Pattern 5: locale-scoped aliases — "in/at/around <Place>, they/people call him/her X".
    // Picks up aliases bound to a setting (common in fantasy/regional naming).
    const localePatterns = /(?:in|at|around|among|to)\s+[A-Z][A-Za-z']+(?:\s+[A-Za-z']+){0,3},?\s+(?:they|she|he|people|locals|the\s+\w+)\s+(?:call|know)\s+(?:him|her|them|me|it)\s+(?:as\s+)?["'“‘]?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})["'”’]?/gi;
    while ((match = localePatterns.exec(desc)) !== null) {
      addAlias(aliases, match[1], canonicalName);
    }
  }

  return aliases;
}

/** Add an alias to the map, including the "without the" variant */
function addAlias(map: Map<string, string>, alias: string, canonical: string): void {
  const trimmed = sanitizeAlias(alias);
  if (!trimmed || !isPlausibleAlias(trimmed, canonical)) return;
  map.set(trimmed.toLowerCase(), canonical);
  // Also add without leading "the" / "The"
  const withoutThe = trimmed.replace(/^the\s+/i, "");
  if (withoutThe !== trimmed && withoutThe.length >= 2) {
    map.set(withoutThe.toLowerCase(), canonical);
  }
}

/**
 * Build the alias list passed to the sidecar's <canonical_aliases> block.
 *
 * Merges two sources:
 *   1. Persisted entity-graph aliases (includes prior user-curated edits and
 *      learned aliases from earlier rebuild passes). These survive rebuilds via
 *      memory_entities.user_edited_at and the entity row's `aliases` JSON.
 *   2. Description aliases from character/persona/world-book definitions —
 *      take priority on key collision since they're the canonical authority.
 *
 * Resulting list is what the sidecar sees as authoritative alias→canonical
 * mappings for the current chat.
 */
export function buildSidecarAliasList(
  descriptionAliases: Map<string, string> | undefined,
  knownEntities: Array<{ name: string; aliases: string[] }>,
): Array<{ alias: string; canonicalName: string }> {
  const merged = new Map<string, string>();
  for (const e of knownEntities) {
    for (const alias of e.aliases) {
      const lower = alias.toLowerCase();
      if (!merged.has(lower)) merged.set(lower, e.name);
    }
  }
  if (descriptionAliases) {
    for (const [alias, canonical] of descriptionAliases.entries()) {
      merged.set(alias.toLowerCase(), canonical);
    }
  }
  return [...merged.entries()].map(([alias, canonicalName]) => ({ alias, canonicalName }));
}

/**
 * Merge description aliases from multiple characters with collision detection.
 *
 * In group chats, multiple characters might claim the same nickname (e.g., both
 * are "called 'Captain'" or "nicknamed 'Shadow'"). Ambiguous aliases — where
 * the same alias maps to different canonical names — are dropped to prevent
 * misattribution. Unambiguous aliases are preserved.
 *
 * Usage: extract aliases per-character with extractDescriptionAliases(), then
 * pass all maps here. Returns a single clean map safe for group chats.
 */
export function mergeDescriptionAliases(
  ...aliasMaps: Map<string, string>[]
): Map<string, string> {
  // Track every canonical name each alias points to
  const owners = new Map<string, Set<string>>();

  for (const aliasMap of aliasMaps) {
    for (const [alias, canonical] of aliasMap) {
      if (!owners.has(alias)) owners.set(alias, new Set());
      owners.get(alias)!.add(canonical);
    }
  }

  // Only keep aliases that map to exactly one character
  const merged = new Map<string, string>();
  for (const [alias, canonicals] of owners) {
    if (canonicals.size === 1) {
      merged.set(alias, [...canonicals][0]);
    }
    // size > 1: ambiguous — silently dropped
  }

  return merged;
}

/**
 * Generate common English inflectional variants of a word.
 * Used to prevent different tense forms from being registered as
 * separate provisional entities — if a variant already exists in the
 * entity graph, the new occurrence is treated as a mention, not a new entity.
 *
 * Only handles regular inflection (covers ~90% of English verbs).
 * Irregular forms (run/ran, go/went) are handled by the COMMON_ENGLISH reject set.
 */
function getInflectionalVariants(word: string): string[] {
  if (word.length < 5) return [];
  const lower = word.toLowerCase();
  const variants: string[] = [];

  if (lower.endsWith("ing") && lower.length >= 6) {
    // walking → walk, walked, walks; cutting → cut
    const stem = lower.slice(0, -3);
    variants.push(stem, stem + "ed", stem + "s", stem + "e", stem + "es");
    // Doubled consonant: running → run, runs, ran
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      const short = stem.slice(0, -1);
      variants.push(short, short + "s", short + "ed");
    }
  } else if (lower.endsWith("ed") && lower.length >= 5) {
    // walked → walk, walking, walks
    const stem = lower.slice(0, -2);
    variants.push(stem, stem + "ing", stem + "s");
    // -ied → -y: carried → carry, carrying
    if (lower.endsWith("ied")) {
      const ystem = lower.slice(0, -3) + "y";
      variants.push(ystem, ystem + "ing");
    }
    // Doubled consonant: stopped → stop, stopping
    if (stem.length >= 2 && stem[stem.length - 1] === stem[stem.length - 2]) {
      const short = stem.slice(0, -1);
      variants.push(short, short + "s", short + "ing");
    }
    // -e + d: moved → move, moving
    if (stem.endsWith("e")) {
      variants.push(stem.slice(0, -1) + "ing");
    }
  } else if (lower.endsWith("s") && !lower.endsWith("ss") && lower.length >= 4) {
    // walks → walk, walked, walking
    const stem = lower.slice(0, -1);
    variants.push(stem, stem + "ed", stem + "ing");
    if (lower.endsWith("ies") && lower.length >= 5) {
      const ystem = lower.slice(0, -3) + "y";
      variants.push(ystem, ystem + "ed", ystem + "ing");
    } else if (lower.endsWith("es") && lower.length >= 5) {
      const estem = lower.slice(0, -2);
      variants.push(estem, estem + "ed", estem + "ing");
    }
  }

  // Return title-cased variants (entity names are capitalized), deduplicated
  return [...new Set(variants)]
    .filter((v) => v.length >= 3 && v !== lower)
    .map((v) => v.charAt(0).toUpperCase() + v.slice(1));
}

/**
 * Merge heuristic and sidecar relationships, preferring sidecar for duplicate pair+type combos.
 */
function mergeRelationships(
  heuristic: Array<{ source: string; target: string; type: string; label: string; sentiment: number; confidence?: number }>,
  sidecar: Array<{ source: string; target: string; type: string; label: string; sentiment: number }>,
): Array<{ source: string; target: string; type: string; label: string; sentiment: number }> {
  const merged = new Map<string, any>();

  // Heuristic first (lower priority)
  for (const rel of heuristic) {
    const key = `${rel.source.toLowerCase()}→${rel.target.toLowerCase()}:${rel.type}`;
    merged.set(key, rel);
  }

  // Sidecar overwrites (higher priority)
  for (const rel of sidecar) {
    const key = `${rel.source.toLowerCase()}→${rel.target.toLowerCase()}:${rel.type}`;
    merged.set(key, rel);
  }

  return [...merged.values()];
}

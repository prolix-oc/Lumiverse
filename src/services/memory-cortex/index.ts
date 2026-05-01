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
import { runHeuristicAnalysisInWorker } from "./heuristic-worker-host";
import * as entityGraph from "./entity-graph";
import * as entityContext from "./entity-context";
import * as consolidation from "./consolidation";
import { buildEmotionalContext } from "./emotional-context";
import { queryCortex as queryCortexImpl, queryVaultCortex as queryVaultCortexImpl } from "./retrieval";
import { formatShadowPrompt, type FormatterMode, type ShadowPromptResult } from "./shadow-formatter";
import { getCortexUsageStats, runMaintenance, debouncedVectorize } from "./gc";
import { processChunkFontColors, formatColorMapForPrompt, deleteColorMapForChat, getColorMap, recordColorAttribution } from "./font-attribution";
import { extractRelationshipsHeuristic } from "./relationship-extractor";
import { extractNPsFromChunk } from "./np-chunker";
import { stripLoomTags, stripDetailsBlocks } from "../../utils/content-sanitizer";
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
export type { MemoryCortexConfig, CortexPresetMode } from "./config";
export { createCortexSidecarGenerateRawAdapter } from "./sidecar-adapter";
export { formatShadowPrompt, formatLinkedCortexSection } from "./shadow-formatter";
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

export function getCortexWarmupSignature(config: MemoryCortexConfig): string {
  return JSON.stringify({
    enabled: config.enabled,
    entityTracking: config.entityTracking,
    entityExtractionMode: config.entityExtractionMode,
    thoughtMarkers: config.thoughtMarkers,
    salienceScoring: config.salienceScoring,
    salienceScoringMode: config.salienceScoringMode,
    consolidation: config.consolidation,
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
    entityPruning: config.entityPruning,
    entityWhitelist: config.entityWhitelist,
    entityExtractionFilters: config.entityExtractionFilters,
  });
}

function clearDerivedCortexData(chatId: string): void {
  const db = getDb();
  invalidateCortexCache(chatId);
  entityGraph.deleteEntitiesForChat(chatId);
  entityGraph.deleteMentionsForChat(chatId);
  entityGraph.deleteRelationsForChat(chatId);
  consolidation.deleteConsolidationsForChat(chatId);
  deleteColorMapForChat(chatId);
  db.query("DELETE FROM memory_salience WHERE chat_id = ?").run(chatId);
  db.query(
    "UPDATE chat_chunks SET salience_score = NULL, emotional_tags = NULL, entity_ids = NULL, consolidation_id = NULL, cortex_warmup_signature = NULL, cortex_warmup_completed_at = NULL WHERE chat_id = ?",
  ).run(chatId);
}

export function getCortexWarmupCoverage(chatId: string, warmupSignature: string): CortexWarmupCoverage {
  const db = getDb();
  const totalRow = db.query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ?").get(chatId) as { c?: number } | null;
  const completedRow = db
    .query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ? AND cortex_warmup_signature = ?")
    .get(chatId, warmupSignature) as { c?: number } | null;

  const totalChunks = totalRow?.c ?? 0;
  const completedChunks = completedRow?.c ?? 0;
  const stats = getCortexUsageStats(chatId);
  const requiresFullRebuild = completedChunks === 0 && (
    stats.entityCount > 0 ||
    stats.relationCount > 0 ||
    stats.salienceRecordCount > 0 ||
    stats.consolidationCount > 0
  );

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
 */
export function getCachedCortexResult(chatId: string): CortexResult | null {
  const entry = cortexResultCache.get(chatId);
  if (!entry) return null;
  if (Date.now() - entry.queriedAt > CACHE_TTL_MS) {
    cortexResultCache.delete(chatId);
    return null;
  }
  return entry.result;
}

/** Invalidate cached cortex result for a chat (e.g. on rebuild or delete). */
export function invalidateCortexCache(chatId: string): void {
  cortexResultCache.delete(chatId);
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
    // are returned early above without touching the cache.
    cortexResultCache.set(query.chatId, { result, queriedAt: Date.now() });

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
): Promise<void> {
  const config = getCortexConfig(data.userId);
  if (!config.enabled) return;
  const sidecarActive = shouldUseCortexSidecarForChunkAnalysis(config) && !!generateRawFn && !!sidecarConnectionId;
  const warmupSignature = getCortexWarmupSignature(config);

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

    const rawChunkContent = hydrateChunkContentFromMessages(data.messageIds, data.content);
    const thoughtDelimiters = config.thoughtMarkers;

    const knownEntities = entityGraph.getActiveEntities(data.chatId);
    const entityIdByName = new Map<string, string>();
    for (const e of knownEntities) {
      entityIdByName.set(e.name.toLowerCase(), e.id);
      for (const alias of e.aliases) entityIdByName.set(alias.toLowerCase(), e.id);
    }

    const entityContext = knownEntities.map((e) => ({
      name: e.name,
      type: e.entityType,
      aliases: e.aliases,
    }));

    updateIngestionStatus(data.userId, data.chatId, { phase: "font", chunkId: data.chunkId });
    const fontStart = performance.now();
    const fontResult = processChunkFontColors(
      data.chatId,
      rawChunkContent,
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

    const heuristicPromise = shouldRunHeuristicWorker
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

    let heuristicResult = null as Awaited<typeof heuristicPromise>;

    let extraction: Awaited<ReturnType<typeof extractWithSidecar>> | null = null;
    if (sidecarActive) {
      updateIngestionStatus(data.userId, data.chatId, { phase: "sidecar", chunkId: data.chunkId });
      const sidecarStart = performance.now();
      const sidecarTimeout = config.sidecarTimeoutMs ?? 30000;
      const ac = sidecarTimeout > 0 ? new AbortController() : null;
      const timer = ac ? setTimeout(() => {
        console.warn("[memory-cortex] Sidecar extraction timed out, aborting LLM call");
        ac.abort();
      }, sidecarTimeout) : null;
      const activeGenerateRawFn = generateRawFn!;
      const activeSidecarConnectionId = sidecarConnectionId!;
      const boundGenFn: typeof activeGenerateRawFn = ac
        ? (opts) => activeGenerateRawFn({ ...opts, signal: ac.signal })
        : activeGenerateRawFn;

      try {
        extraction = await extractWithSidecar(
          rawChunkContent,
          boundGenFn,
          activeSidecarConnectionId,
          { characterNames, knownEntities: entityContext },
        );
      } catch (err: any) {
        if (err?.name === "AbortError" || ac?.signal.aborted) {
          console.warn("[memory-cortex] Sidecar extraction timed out, falling back to heuristic");
          extraction = null;
        } else {
          throw err;
        }
      } finally {
        timings.sidecarMs = performance.now() - sidecarStart;
        if (timer) clearTimeout(timer);
      }
    }

    if (heuristicPromise) {
      heuristicResult = await heuristicPromise;
      timings.heuristicMs = heuristicResult.timings.totalMs;
      timings.heuristicSalienceMs = heuristicResult.timings.salienceMs;
      timings.heuristicEntityMs = heuristicResult.timings.entityMs;
      timings.heuristicRelationshipMs = heuristicResult.timings.relationshipMs;
      timings.heuristicAliasMs = heuristicResult.timings.aliasMs;
    }

    if (extraction) {
      salienceResult = {
        score: extraction.score,
        source: "sidecar",
        emotionalTags: extraction.emotionalTags,
        statusChanges: extraction.statusChanges,
        narrativeFlags: extraction.narrativeFlags,
        hasDialogue: /[""\u201C]/.test(rawChunkContent),
        hasAction: /\*[^*]{10,}\*/.test(rawChunkContent),
        hasInternalThought: /\b(thought|wondered|realized|felt|knew)\b/i.test(cleanContent),
        wordCount: cleanContent.split(/\s+/).length,
      };
      sidecarEntities = extraction.entitiesPresent;
      sidecarRelationships = extraction.relationshipsShown;
      sidecarFacts = extraction.keyFacts;
      sidecarFontColors = extraction.fontColors;
      sidecarDiscoveredAliases = extraction.discoveredAliases;

      if (extraction.fontColors.length > 0) {
        const dbStart = performance.now();
        for (const fc of extraction.fontColors) {
          const entityId = entityIdByName.get(fc.characterName.toLowerCase()) || null;
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
    db.transaction(() => {
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

        const mergedEntities = filterEntitiesByExtractionFilters(
          mergeExtractedEntities(refinedEntities, sidecarEntities),
          cleanContent,
          config.entityExtractionFilters,
        );

        const heuristicRelationships = heuristicResult?.relationships ?? refinedFallback?.relationships ?? extractRelationshipsHeuristic(
          cleanContent,
          mergedEntities.map((e) => e.name),
          salienceResult.emotionalTags,
        );

        const allowedEntityNames = new Set(mergedEntities.map((entity) => entity.name.toLowerCase()));
        const allRelationships = mergeRelationships(heuristicRelationships, sidecarRelationships).filter(
          (rel) => allowedEntityNames.has(rel.source.toLowerCase()) && allowedEntityNames.has(rel.target.toLowerCase()),
        );

        const heuristicAliases = heuristicResult?.aliases ?? refinedFallback?.aliases ?? detectNicknameIntroductions(cleanContent, knownEntities, characterNames);
        const allDiscoveredAliases = [...sidecarDiscoveredAliases, ...heuristicAliases];

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
        for (const attr of fontResult.attributions) {
          if (!attr.entityName) continue;
          const entity = entityGraph.findEntityByName(data.chatId, attr.entityName);
          if (!entity) continue;
          recordColorAttribution(data.chatId, attr.hexColor, entity.id, attr.usageType, null);
        }
        for (const fc of sidecarFontColors) {
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

        if (sidecarFacts.length > 0 && sidecarEntities.length > 0) {
          const subjectEntity = sidecarEntities.find((e) => e.role === "subject") ?? sidecarEntities[0];
          const entity = entityGraph.findEntityByName(data.chatId, subjectEntity.name);
          if (entity) entityGraph.addEntityFacts(entity.id, sidecarFacts);
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
            entityGraph.addEntityFacts(entity.id, [`${change.change}: ${change.detail}`]);
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
          entityGraph.addEntityFacts(canonicalEntity.id, [
            evidence
              ? `Also known as "${discovered.alias}" (${evidence})`
              : `Also known as "${discovered.alias}"`,
          ]);
        }
        timings.graphMs += performance.now() - postGraphStart;
      }

      // Only runs server-side during sidecar mode (amortized cost acceptable).
      // Does NOT run in heuristic-only mode to protect mobile latency.
      if (sidecarActive) {
        let npContent = stripLoomTags(cleanContent);
        npContent = stripDetailsBlocks(npContent);
        const npCandidates = extractNPsFromChunk(npContent);
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

          if (descriptionAliases) {
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

          const prefixMatch = findPrefixMatch(np.text, characterNames);
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

      db.query(
        "UPDATE chat_chunks SET cortex_warmup_signature = ?, cortex_warmup_completed_at = ? WHERE id = ?",
      ).run(warmupSignature, now, data.chunkId);
    })();
    timings.dbMs += performance.now() - persistStartedAt;

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

interface RebuildState {
  chatId: string;
  status: "processing" | "complete" | "error";
  current: number;
  total: number;
  percent: number;
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
  onProgress?: (current: number, total: number) => void,
  descriptionAliases?: Map<string, string>,
  options: CortexRebuildOptions = {},
): Promise<{ chunksProcessed: number; entitiesFound: number; relationsFound: number }> {
  const config = getCortexConfig(userId);
  if (!config.enabled) {
    return { chunksProcessed: 0, entitiesFound: 0, relationsFound: 0 };
  }
  const resumable = options.resumable === true;
  const warmupSignature = options.warmupSignature || getCortexWarmupSignature(config);
  const sidecarAvailable = shouldUseCortexSidecar(config) && !!generateRawFn && !!sidecarConnectionId;
  const sidecarAnalysisActive = shouldUseCortexSidecarForChunkAnalysis(config) && !!generateRawFn && !!sidecarConnectionId;
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
      clearDerivedCortexData(chatId);
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
    startedAt: Date.now(),
  };
  activeRebuilds.set(chatId, state);

  try {
    const concurrency = config.sidecar?.rebuildConcurrency ?? 3;

    if (!sidecarAnalysisActive) {
      // Heuristic-only: sequential, ~1-2ms per chunk — no concurrency needed
      for (let i = 0; i < chunks.length; i++) {
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
        if (onProgress) onProgress(current, totalChunks);
        await yieldToEventLoop();
      }
    } else {
      // Sidecar path: bounded concurrency queue.
      // Each slot processes ONE chunk at a time: sends the request, waits for ALL
      // tool calls to resolve, ingests the result, then takes the next chunk.
      // At most `concurrency` slots are active simultaneously.
      //
      // This avoids spamming the provider — behaves like N sequential pipelines.

      let nextChunkIdx = 0;
      let completed = completedBeforeStart;
      const activeGenerateRawFn = generateRawFn!;
      const activeSidecarConnectionId = sidecarConnectionId!;

      async function processNextChunk(): Promise<void> {
        while (nextChunkIdx < chunks.length) {
          const idx = nextChunkIdx++;
          const chunk = chunks[idx];
          const rawChunkContent = hydrateChunkContentFromMessages(safeJsonArray(chunk.message_ids), chunk.content);

          try {
            // Single request per chunk — sends tools, waits for ALL tool_calls to resolve
            const sidecarResult = await extractWithSidecar(
              rawChunkContent,
              activeGenerateRawFn,
              activeSidecarConnectionId,
              { characterNames },
            );

            if (sidecarResult) {
              await processChunkWithPrecomputedSidecar(chunk, chatId, userId, characterNames, sidecarResult, descriptionAliases);
            } else {
              await processChunkFromRaw(chunk, chatId, userId, characterNames, undefined, undefined, descriptionAliases);
            }
          } catch {
            // Sidecar failed — fall back to heuristic for this chunk
            await processChunkFromRaw(chunk, chatId, userId, characterNames, undefined, undefined, descriptionAliases);
          }

          completed++;
          state.current = completed;
          state.percent = totalChunks > 0 ? Math.round((completed / totalChunks) * 100) : 100;
          if (onProgress) onProgress(completed, totalChunks);
        }
      }

      // Launch `concurrency` worker slots — each one pulls chunks sequentially
      const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, () => processNextChunk());
      await Promise.all(workers);
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
    // Keep state around for 5 minutes so reconnecting clients can see the result
    setTimeout(() => activeRebuilds.delete(chatId), 5 * 60 * 1000);

    console.info(
      `[memory-cortex] ${resumable ? "Warmup" : "Rebuild"} complete: ${totalChunks} chunks, ${entities.length} entities, ${relations.length} relations`,
    );

    return result;
  } catch (err: any) {
    state.status = "error";
    state.error = err?.message || "Rebuild failed";
    setTimeout(() => activeRebuilds.delete(chatId), 60 * 1000);
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
): Promise<void> {
  // Build a fake generateRawFn that returns pre-computed tool_calls so processChunk's
  // sidecar branch gets structured data without making an actual API call.
  const fakeToolCalls = [
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

/** Get relations for a chat */
export function getRelations(chatId: string) {
  return entityGraph.getRelations(chatId);
}

// ─── Helpers ───────────────────────────────────────────────────

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
  }

  return aliases;
}

/** Add an alias to the map, including the "without the" variant */
function addAlias(map: Map<string, string>, alias: string, canonical: string): void {
  const trimmed = alias.trim();
  if (trimmed.length < 2 || trimmed.length > 50) return;
  map.set(trimmed.toLowerCase(), canonical);
  // Also add without leading "the" / "The"
  const withoutThe = trimmed.replace(/^the\s+/i, "");
  if (withoutThe !== trimmed && withoutThe.length >= 2) {
    map.set(withoutThe.toLowerCase(), canonical);
  }
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

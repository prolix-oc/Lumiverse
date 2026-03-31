/**
 * Memory Cortex — Dual-pass retrieval orchestrator.
 *
 * The core retrieval engine that fuses structured SQLite filtering with
 * LanceDB vector search for dramatically more precise memory recall.
 *
 * Pipeline:
 *   Phase 1: SQLite narrows the candidate set (entity filter, time range, salience)
 *   Phase 2: LanceDB vector-searches within the candidate set
 *   Phase 3: Multi-signal score fusion (semantic + salience + recency + emotional + entity)
 *   Phase 4: Diversity-aware selection (prevent temporal clustering)
 *   Phase 5: Entity context assembly
 */

import { getDb } from "../../db/connection";
import * as embeddingsSvc from "../embeddings.service";
import * as entityContext from "./entity-context";
import * as consolidation from "./consolidation";
import type {
  CortexQuery,
  CortexResult,
  CortexMemory,
  CortexStats,
  EntitySnapshot,
  RelationEdge,
  EmotionalTag,
  MemorySalienceRow,
} from "./types";
import type { MemoryCortexConfig } from "./config";

// ─── Main Retrieval ────────────────────────────────────────────

/**
 * Execute a cortex-enhanced memory retrieval query.
 *
 * This is the primary entry point called from the prompt assembly pipeline.
 * It replaces the simpler vector-only search with a multi-phase pipeline
 * that combines structural, semantic, and emotional signals.
 */
export async function queryCortex(
  query: CortexQuery,
  config: MemoryCortexConfig,
): Promise<CortexResult> {
  const startTime = Date.now();
  const db = getDb();

  // ────────────────────────────────────────────
  // PHASE 1: SQLite Structural Filtering
  // ────────────────────────────────────────────

  // 1a. Identify active entities from query context
  let activeEntityIds: string[];

  if (query.entityFilter?.length) {
    activeEntityIds = entityContext.resolveEntityIdsByNames(query.chatId, query.entityFilter);
  } else if (config.entityTracking) {
    activeEntityIds = entityContext.resolveActiveEntityIds(query.chatId, query.queryText);
  } else {
    activeEntityIds = [];
  }

  // 1b. Build candidate chunk set
  const candidateChunkIds = new Set<string>();

  if (activeEntityIds.length > 0) {
    // Get chunks mentioning active entities
    const entityChunkIds = getEntityChunkIds(db, query.chatId, activeEntityIds, query.timeRange);
    for (const id of entityChunkIds) candidateChunkIds.add(id);
  }

  // Always include high-salience chunks (serendipitous recall)
  if (config.salienceScoring) {
    const highSalienceChunkIds = getHighSalienceChunkIds(
      db, query.chatId, Math.ceil(query.topK * 0.5),
    );
    for (const id of highSalienceChunkIds) candidateChunkIds.add(id);
  }

  // If no entity or salience candidates, fall back to recent vectorized chunks
  if (candidateChunkIds.size === 0) {
    const fallbackIds = getRecentVectorizedChunkIds(db, query.chatId, query.topK * 5);
    for (const id of fallbackIds) candidateChunkIds.add(id);
  }

  // 1c. Load salience data for all candidates
  const salienceMap = loadSalienceMap(db, query.chatId, candidateChunkIds);

  // ────────────────────────────────────────────
  // PHASE 2: LanceDB Vector Search
  // ────────────────────────────────────────────

  let vectorResults: VectorSearchResult[];

  try {
    const [queryVector] = await embeddingsSvc.cachedEmbedTexts(query.userId, [query.queryText]);
    if (!queryVector || queryVector.length === 0) {
      return emptyResult(startTime);
    }

    vectorResults = await searchChatChunksScoped(
      query.userId,
      query.chatId,
      queryVector,
      candidateChunkIds,
      query.topK * 3, // Over-fetch for reranking
      query.excludeMessageIds,
    );
  } catch (err) {
    console.warn("[memory-cortex] Vector search failed:", err);
    return emptyResult(startTime);
  }

  if (vectorResults.length === 0) {
    return emptyResult(startTime);
  }

  // ────────────────────────────────────────────
  // PHASE 3: Score Fusion
  // ────────────────────────────────────────────

  const now = Math.floor(Date.now() / 1000);
  const lambda = Math.LN2 / config.decay.halfLifeTurns;

  // Batch-load chunk metadata for all vector results (replaces N+1 individual queries)
  const chunkMetaMap = batchLoadChunkMeta(db, vectorResults.map(vr => vr.chunkId));

  const scoredMemories: CortexMemory[] = vectorResults.map((vr) => {
    const salience = salienceMap.get(vr.chunkId);
    const chunkMeta = chunkMetaMap.get(vr.chunkId) ?? null;

    // Semantic similarity (cosine distance → similarity)
    const semanticScore = Math.max(0, 1 - vr.distance);

    // Salience score
    const salienceScore = salience?.score ?? 0.3;

    // Temporal decay (Ebbinghaus-inspired) with core memory protection
    const age = Math.max(0, now - (chunkMeta?.created_at ?? now));
    const ageInTurns = age / 60; // ~1 turn per minute as rough approximation

    // Core memory protection: high-salience or narratively flagged memories resist decay
    const isCoreMemory =
      salienceScore >= config.decay.coreMemoryThreshold ||
      (salience?.narrativeFlags?.length &&
        salience.narrativeFlags.some((f: string) => config.decay.coreMemoryFlags.includes(f)));

    const recencyScore = isCoreMemory
      ? Math.max(0.5, Math.exp(-lambda * ageInTurns * 0.2)) // 5x slower decay, floor at 0.5
      : Math.exp(-lambda * ageInTurns);

    // Reinforcement from retrieval history
    const retrievalCount = chunkMeta?.retrieval_count ?? 0;
    const reinforcementScore = Math.log2(1 + retrievalCount) * config.decay.reinforcementWeight;

    // Emotional resonance
    let emotionalScore = 0;
    if (config.retrieval.emotionalResonance && query.emotionalContext?.length && salience?.emotionalTags?.length) {
      const overlap = salience.emotionalTags.filter((t) =>
        query.emotionalContext!.includes(t as EmotionalTag),
      );
      emotionalScore = Math.min(0.4, overlap.length * 0.15);
    }

    // Entity relevance
    let entityScore = 0;
    if (activeEntityIds.length > 0 && chunkMeta?.entity_ids) {
      const chunkEntityIds = safeJsonArray(chunkMeta.entity_ids);
      const overlap = chunkEntityIds.filter((e) => activeEntityIds.includes(e));
      entityScore = Math.min(0.3, overlap.length * 0.1);
    }

    // Final fusion — weights tuned for roleplay recall patterns
    let finalScore: number;
    if (config.retrieval.useFusedScoring) {
      finalScore =
        semanticScore * 0.35 +
        salienceScore * 0.25 +
        recencyScore * 0.15 +
        emotionalScore * 0.10 +
        entityScore * 0.10 +
        Math.min(0.05, reinforcementScore);
    } else {
      // Pure vector mode (fallback)
      finalScore = semanticScore;
    }

    return {
      source: "chunk" as const,
      sourceId: vr.chunkId,
      content: vr.content,
      finalScore,
      components: {
        semantic: semanticScore,
        salience: salienceScore,
        recency: recencyScore,
        reinforcement: reinforcementScore,
        emotional: emotionalScore,
        entity: entityScore,
      },
      emotionalTags: (salience?.emotionalTags ?? []) as EmotionalTag[],
      entityNames: resolveEntityNames(db, chunkMeta?.entity_ids ?? null),
      messageRange: [
        chunkMeta?.message_range_start ?? 0,
        chunkMeta?.message_range_end ?? 0,
      ] as [number, number],
      timeRange: [
        chunkMeta?.created_at ?? 0,
        chunkMeta?.updated_at ?? 0,
      ] as [number, number],
    };
  });

  // ────────────────────────────────────────────
  // PHASE 4: Diversity-Aware Selection
  // ────────────────────────────────────────────

  // Estimate total messages for diversity window scaling
  const totalMessages = db
    .query("SELECT COUNT(*) as count FROM messages WHERE chat_id = ?")
    .get(query.chatId) as { count: number } | null;
  const messageCount = totalMessages?.count ?? 200;

  let selected: CortexMemory[];
  if (config.retrieval.diversitySelection) {
    selected = diversitySelect(scoredMemories, query.topK, messageCount);
  } else {
    selected = scoredMemories
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, query.topK);
  }

  // ────────────────────────────────────────────
  // PHASE 5: Entity Context Assembly
  // ────────────────────────────────────────────

  let entitySnapshots: EntitySnapshot[] = [];
  let activeRelationships: RelationEdge[] = [];
  let arcCtx: string | null = null;

  if (config.retrieval.entityContextInjection && activeEntityIds.length > 0) {
    entitySnapshots = entityContext.assembleEntitySnapshots(
      query.chatId,
      activeEntityIds,
      config.retrieval.maxEntitySnapshots,
    );
  }

  if (config.retrieval.relationshipInjection && activeEntityIds.length > 0) {
    activeRelationships = entityContext.getActiveRelationEdges(
      query.chatId,
      activeEntityIds,
      config.retrieval.maxRelationships,
    );
  }

  if (config.retrieval.arcInjection) {
    const latestArc = consolidation.getLatestArc(query.chatId);
    if (latestArc) {
      arcCtx = latestArc.title
        ? `[${latestArc.title}] ${latestArc.summary}`
        : latestArc.summary;
    }
  }

  // Update retrieval stats on selected chunks
  batchUpdateRetrievalStats(db, selected.map((m) => m.sourceId));

  return {
    memories: selected,
    entityContext: entitySnapshots,
    activeRelationships,
    arcContext: arcCtx,
    stats: {
      candidatePoolSize: candidateChunkIds.size,
      vectorSearchResults: vectorResults.length,
      entitiesMatched: activeEntityIds.length,
      scoreFusionApplied: config.retrieval.useFusedScoring,
      topScore: selected[0]?.finalScore ?? 0,
      retrievalTimeMs: Date.now() - startTime,
    },
  };
}

// ─── Phase 1 Helpers ───────────────────────────────────────────

function getEntityChunkIds(
  db: any,
  chatId: string,
  entityIds: string[],
  timeRange?: { start?: number; end?: number },
): string[] {
  if (entityIds.length === 0) return [];

  const placeholders = entityIds.map(() => "?").join(",");
  let sql = `SELECT DISTINCT mm.chunk_id FROM memory_mentions mm
    WHERE mm.chat_id = ? AND mm.entity_id IN (${placeholders})`;
  const params: any[] = [chatId, ...entityIds];

  if (timeRange?.start) {
    sql += ` AND EXISTS (SELECT 1 FROM chat_chunks cc WHERE cc.id = mm.chunk_id AND cc.created_at >= ?)`;
    params.push(timeRange.start);
  }
  if (timeRange?.end) {
    sql += ` AND EXISTS (SELECT 1 FROM chat_chunks cc WHERE cc.id = mm.chunk_id AND cc.created_at <= ?)`;
    params.push(timeRange.end);
  }

  const rows = db.query(sql).all(...params) as Array<{ chunk_id: string }>;
  return rows.map((r) => r.chunk_id);
}

function getHighSalienceChunkIds(db: any, chatId: string, limit: number): string[] {
  const rows = db
    .query(
      `SELECT chunk_id FROM memory_salience
       WHERE chat_id = ? AND score >= 0.6
       ORDER BY score DESC LIMIT ?`,
    )
    .all(chatId, limit) as Array<{ chunk_id: string }>;
  return rows.map((r) => r.chunk_id);
}

function getRecentVectorizedChunkIds(db: any, chatId: string, limit: number): string[] {
  const rows = db
    .query(
      `SELECT id FROM chat_chunks
       WHERE chat_id = ? AND vectorized_at IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(chatId, limit) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

interface SalienceData {
  score: number;
  emotionalTags: string[];
  narrativeFlags: string[];
}

function loadSalienceMap(
  db: any,
  chatId: string,
  chunkIds: Set<string>,
): Map<string, SalienceData> {
  const map = new Map<string, SalienceData>();
  if (chunkIds.size === 0) return map;

  // Batch load in groups of 500 to avoid SQLite variable limit
  const idArray = [...chunkIds];
  for (let i = 0; i < idArray.length; i += 500) {
    const batch = idArray.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .query(`SELECT chunk_id, score, emotional_tags, narrative_flags FROM memory_salience WHERE chunk_id IN (${placeholders})`)
      .all(...batch) as MemorySalienceRow[];

    for (const row of rows) {
      map.set(row.chunk_id, {
        score: row.score,
        emotionalTags: safeJsonArray(row.emotional_tags as string),
        narrativeFlags: safeJsonArray(row.narrative_flags as string),
      });
    }
  }

  return map;
}

// ─── Phase 2 Helpers ───────────────────────────────────────────

interface VectorSearchResult {
  chunkId: string;
  content: string;
  distance: number;
}

/**
 * Search LanceDB for chat chunks, optionally scoped to a candidate set.
 * If the candidate set is small enough, we filter by source_id in the query.
 */
async function searchChatChunksScoped(
  userId: string,
  chatId: string,
  queryVector: number[],
  candidateChunkIds: Set<string>,
  limit: number,
  excludeMessageIds?: string[],
): Promise<VectorSearchResult[]> {
  // Pass exclude IDs to the vector search so chunks containing the
  // regeneration target (or other excluded messages) are filtered out.
  // This prevents the LLM from seeing its own previous output as a "memory".
  const excludeIds = new Set(excludeMessageIds ?? []);

  const hits = await embeddingsSvc.searchChatChunks(
    userId,
    chatId,
    queryVector,
    excludeIds,
    limit,
  );

  // Filter to candidate set if we have one
  const filtered = candidateChunkIds.size > 0
    ? hits.filter((h: any) => candidateChunkIds.has(h.chunk_id))
    : hits;

  return filtered.map((h: any) => ({
    chunkId: h.chunk_id,
    content: h.content,
    distance: h.score, // LanceDB returns distance as score
  }));
}

// ─── Phase 3 Helpers ───────────────────────────────────────────

interface ChunkMeta {
  created_at: number;
  updated_at: number;
  retrieval_count: number;
  entity_ids: string | null;
  message_range_start: number;
  message_range_end: number;
}

function loadChunkMeta(db: any, chunkId: string): ChunkMeta | null {
  // Uses denormalized message_range_start/end columns (migration 044)
  // Falls back to 0 if not yet populated — harmless for scoring
  const row = db
    .query(
      `SELECT created_at, updated_at, retrieval_count, entity_ids,
              COALESCE(message_range_start, 0) as message_range_start,
              COALESCE(message_range_end, 0) as message_range_end
       FROM chat_chunks WHERE id = ?`,
    )
    .get(chunkId) as ChunkMeta | null;
  return row;
}

/** Batch-load chunk metadata in a single query (replaces N individual loadChunkMeta calls). */
function batchLoadChunkMeta(db: any, chunkIds: string[]): Map<string, ChunkMeta> {
  const map = new Map<string, ChunkMeta>();
  if (chunkIds.length === 0) return map;

  for (let i = 0; i < chunkIds.length; i += 500) {
    const batch = chunkIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT id, created_at, updated_at, retrieval_count, entity_ids,
                COALESCE(message_range_start, 0) as message_range_start,
                COALESCE(message_range_end, 0) as message_range_end
         FROM chat_chunks WHERE id IN (${placeholders})`,
      )
      .all(...batch) as (ChunkMeta & { id: string })[];

    for (const row of rows) {
      map.set(row.id, row);
    }
  }

  return map;
}

function resolveEntityNames(db: any, entityIdsJson: string | null): string[] {
  if (!entityIdsJson) return [];
  const ids = safeJsonArray(entityIdsJson);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .query(`SELECT name FROM memory_entities WHERE id IN (${placeholders})`)
    .all(...ids) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

// ─── Phase 4: Diversity Selection ──────────────────────────────

/**
 * Select memories while enforcing temporal diversity.
 * Prevents multiple results from clustering in the same time window.
 */
function diversitySelect(memories: CortexMemory[], topK: number, totalMessages = 200): CortexMemory[] {
  const sorted = [...memories].sort((a, b) => b.finalScore - a.finalScore);
  const selected: CortexMemory[] = [];
  const coveredWindows = new Map<number, number>(); // window → highest score

  // Scale window size with chat length: ~20 windows regardless of total messages
  const windowSize = Math.max(50, Math.floor(totalMessages / 20));

  for (const mem of sorted) {
    if (selected.length >= topK) break;

    // Temporal window: group by scaled blocks
    const window = Math.floor(mem.messageRange[0] / windowSize);

    const existingScore = coveredWindows.get(window);
    if (existingScore != null) {
      // Only allow a second entry from the same window if it's significantly scored
      if (mem.finalScore - existingScore < -0.15) continue;
    }

    selected.push(mem);
    if (!coveredWindows.has(window) || mem.finalScore > (coveredWindows.get(window) ?? 0)) {
      coveredWindows.set(window, mem.finalScore);
    }
  }

  return selected;
}

// ─── Retrieval Stats Update ────────────────────────────────────

function batchUpdateRetrievalStats(db: any, chunkIds: string[]): void {
  if (chunkIds.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.query(
    "UPDATE chat_chunks SET retrieval_count = COALESCE(retrieval_count, 0) + 1, last_retrieved_at = ? WHERE id = ?",
  );
  for (const id of chunkIds) {
    stmt.run(now, id);
  }
}

// ─── Utilities ─────────────────────────────────────────────────

function emptyResult(startTime: number): CortexResult {
  return {
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
      retrievalTimeMs: Date.now() - startTime,
    },
  };
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

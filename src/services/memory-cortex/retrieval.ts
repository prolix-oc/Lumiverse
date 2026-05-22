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
import * as entityGraph from "./entity-graph";
import * as consolidation from "./consolidation";
import type {
  CortexQuery,
  CortexResult,
  CortexMemory,
  CortexStats,
  EntitySnapshot,
  EntityType,
  EntityStatus,
  RelationEdge,
  RelationType,
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
  signal?: AbortSignal,
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

  // Early exit: if Phase 1 found zero candidate chunks (no entities, no
  // salience records, no vectorized chunks for this chat), skip the
  // expensive Phase 2 entirely.  Without this guard, the LanceDB query
  // falls through to an UNSCOPED nearest-neighbor scan across the entire
  // embeddings table (potentially tens of thousands of rows from other
  // chats), which blocks the event loop via the native NAPI call and is
  // the primary cause of server lockups on chats without cortex data.
  if (candidateChunkIds.size === 0) {
    return emptyResult(startTime);
  }

  // Early abort: if the caller (timeout wrapper) already fired, bail out
  // before the expensive vector search + embedding API call.
  if (signal?.aborted) return emptyResult(startTime);

  // ────────────────────────────────────────────
  // PHASE 2: LanceDB Vector Search
  // ────────────────────────────────────────────

  let vectorResults: VectorSearchResult[];

  try {
    const [queryVector] = await embeddingsSvc.cachedEmbedTexts(query.userId, [query.queryText], { signal });
    if (signal?.aborted) return emptyResult(startTime);
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
      signal,
    );
  } catch (err) {
    if (signal?.aborted) return emptyResult(startTime);
    console.warn("[memory-cortex] Vector search failed:", err);
    return emptyResult(startTime);
  }

  if (vectorResults.length === 0) {
    return emptyResult(startTime);
  }

  // Abort check before the CPU-intensive score fusion and diversity selection.
  if (signal?.aborted) return emptyResult(startTime);

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

  // Load relations once and pass to both snapshot assembly and edge extraction
  // to avoid the duplicate unbounded query that previously ran twice.
  const needsRelations = activeEntityIds.length > 0 &&
    (config.retrieval.entityContextInjection || config.retrieval.relationshipInjection);
  const relationsLimit = Math.max(
    config.retrieval.maxEntitySnapshots * 5,
    config.retrieval.maxRelationships,
  );
  const preloadedRelations = needsRelations
    ? entityGraph.getRelationsForEntities(query.chatId, activeEntityIds, relationsLimit)
    : [];

  if (config.retrieval.entityContextInjection && activeEntityIds.length > 0) {
    entitySnapshots = entityContext.assembleEntitySnapshots(
      query.chatId,
      activeEntityIds,
      config.retrieval.maxEntitySnapshots,
      preloadedRelations,
    );
  }

  if (config.retrieval.relationshipInjection && activeEntityIds.length > 0) {
    activeRelationships = entityContext.getActiveRelationEdges(
      query.chatId,
      activeEntityIds,
      config.retrieval.maxRelationships,
      preloadedRelations,
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
  signal?: AbortSignal,
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
    undefined,
    undefined,
    candidateChunkIds,
    signal,
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
  // Wrap in a transaction so all updates share a single WAL write
  // instead of each stmt.run() auto-committing individually.
  db.exec("BEGIN");
  try {
    for (const id of chunkIds) {
      stmt.run(now, id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
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

// ─── Vault-scoped retrieval ────────────────────────────────────

export interface VaultCortexQuery {
  userId: string;
  vaultId: string;
  queryText: string;
  topK: number;
  emotionalContext?: EmotionalTag[];
  includeRelationships?: boolean;
  signal?: AbortSignal;
}

/**
 * Retrieve memories + entity/relation context from a vault's own snapshot.
 * Mirrors the chat pipeline (Phase 1-5) but reads from cortex_vault_*
 * tables and vault-scoped LanceDB rows — the source chat is never touched,
 * so this works even after the source chat has been deleted.
 */
export async function queryVaultCortex(
  query: VaultCortexQuery,
  config: MemoryCortexConfig,
): Promise<CortexResult> {
  const startTime = Date.now();
  const db = getDb();
  const { userId, vaultId, queryText, topK, emotionalContext, signal } = query;

  // ── Load vault entity list for fuzzy name overlap + Phase 5 output ──
  const vaultEntities = db.query(
    `SELECT id, name, entity_type, aliases, description, status, facts,
            emotional_valence, salience_avg
     FROM cortex_vault_entities WHERE vault_id = ? ORDER BY salience_avg DESC`,
  ).all(vaultId) as Array<{
    id: string; name: string; entity_type: string; aliases: string;
    description: string; status: string; facts: string;
    emotional_valence: string; salience_avg: number;
  }>;

  // Name-based entity activation — vault chunks store entity_names (not ids),
  // so we match against the query text via the same normalized-name scan the
  // live pipeline uses (prefix/alias/exact).
  const activeEntityNames = new Set<string>();
  if (queryText && vaultEntities.length > 0) {
    const lowerQuery = queryText.toLowerCase();
    for (const e of vaultEntities) {
      if (lowerQuery.includes(e.name.toLowerCase())) {
        activeEntityNames.add(e.name);
        continue;
      }
      const aliases = safeJsonArray(e.aliases);
      for (const a of aliases) {
        if (a.length >= 2 && lowerQuery.includes(a.toLowerCase())) {
          activeEntityNames.add(e.name);
          break;
        }
      }
    }
  }

  // ── Phase 1: Candidate chunk set from SQLite ──
  const chunkRows = db.query(
    `SELECT id, source_chunk_id, content, salience_score, emotional_tags,
            entity_names, source_created_at
     FROM cortex_vault_chunks WHERE vault_id = ?`,
  ).all(vaultId) as Array<{
    id: string; source_chunk_id: string; content: string;
    salience_score: number | null; emotional_tags: string;
    entity_names: string; source_created_at: number;
  }>;

  if (chunkRows.length === 0) return emptyResult(startTime);
  if (signal?.aborted) return emptyResult(startTime);

  // Build a chunk lookup + candidate pool: entity-name matches + high-salience fallback.
  const chunkMap = new Map<string, typeof chunkRows[number]>();
  for (const c of chunkRows) chunkMap.set(c.id, c);

  const candidateIds = new Set<string>();
  if (activeEntityNames.size > 0) {
    for (const c of chunkRows) {
      const names = safeJsonArray(c.entity_names);
      if (names.some((n) => activeEntityNames.has(n))) {
        candidateIds.add(c.id);
      }
    }
  }

  // Always add top-salience chunks for serendipitous recall.
  const highSalience = [...chunkRows]
    .filter((c) => (c.salience_score ?? 0) >= 0.6)
    .sort((a, b) => (b.salience_score ?? 0) - (a.salience_score ?? 0))
    .slice(0, Math.ceil(topK * 0.5));
  for (const c of highSalience) candidateIds.add(c.id);

  // Final fallback: most recent chunks (source_created_at DESC).
  if (candidateIds.size === 0) {
    const recent = [...chunkRows]
      .sort((a, b) => b.source_created_at - a.source_created_at)
      .slice(0, topK * 5);
    for (const c of recent) candidateIds.add(c.id);
  }

  if (candidateIds.size === 0) return emptyResult(startTime);

  // ── Phase 2: LanceDB vector search scoped to this vault ──
  let vectorResults: VectorSearchResult[];
  try {
    const [queryVector] = await embeddingsSvc.cachedEmbedTexts(userId, [queryText], { signal });
    if (signal?.aborted) return emptyResult(startTime);
    if (!queryVector || queryVector.length === 0) return emptyResult(startTime);

    const hits = await embeddingsSvc.searchVaultChunks(
      userId, vaultId, queryVector, topK * 3, candidateIds, signal,
    );
    vectorResults = hits.map((h) => ({ chunkId: h.chunk_id, content: h.content, distance: h.score }));
  } catch (err) {
    if (signal?.aborted) return emptyResult(startTime);
    console.warn("[memory-cortex] Vault vector search failed:", err);
    return emptyResult(startTime);
  }

  if (vectorResults.length === 0) return emptyResult(startTime);

  // ── Phase 3: Score fusion ──
  const now = Math.floor(Date.now() / 1000);
  const lambda = Math.LN2 / config.decay.halfLifeTurns;

  const scored: CortexMemory[] = vectorResults.map((vr) => {
    const row = chunkMap.get(vr.chunkId);
    const salienceScore = row?.salience_score ?? 0.3;
    const emotionalTags = safeJsonArray(row?.emotional_tags) as EmotionalTag[];
    const entityNames = safeJsonArray(row?.entity_names);

    const semanticScore = Math.max(0, 1 - vr.distance);

    const age = Math.max(0, now - (row?.source_created_at ?? now));
    const ageInTurns = age / 60;
    const isCoreMemory = salienceScore >= config.decay.coreMemoryThreshold;
    const recencyScore = isCoreMemory
      ? Math.max(0.5, Math.exp(-lambda * ageInTurns * 0.2))
      : Math.exp(-lambda * ageInTurns);

    let emoScore = 0;
    if (config.retrieval.emotionalResonance && emotionalContext?.length && emotionalTags.length) {
      const overlap = emotionalTags.filter((t) => emotionalContext.includes(t));
      emoScore = Math.min(0.4, overlap.length * 0.15);
    }

    let entityScore = 0;
    if (activeEntityNames.size > 0 && entityNames.length > 0) {
      const overlap = entityNames.filter((n) => activeEntityNames.has(n));
      entityScore = Math.min(0.3, overlap.length * 0.1);
    }

    const finalScore = config.retrieval.useFusedScoring
      ? semanticScore * 0.35 + salienceScore * 0.25 + recencyScore * 0.15 + emoScore * 0.10 + entityScore * 0.10
      : semanticScore;

    return {
      source: "chunk" as const,
      sourceId: vr.chunkId,
      content: vr.content,
      finalScore,
      components: {
        semantic: semanticScore,
        salience: salienceScore,
        recency: recencyScore,
        reinforcement: 0,
        emotional: emoScore,
        entity: entityScore,
      },
      emotionalTags,
      entityNames,
      messageRange: [0, 0] as [number, number],
      timeRange: [row?.source_created_at ?? 0, row?.source_created_at ?? 0] as [number, number],
    };
  });

  // ── Phase 4: Diversity selection ──
  const selected = config.retrieval.diversitySelection
    ? diversitySelect(scored, topK, chunkRows.length)
    : scored.sort((a, b) => b.finalScore - a.finalScore).slice(0, topK);

  // ── Phase 5: Entity + relation context from vault tables ──
  const entitySnapshots: EntitySnapshot[] = [];
  const activeRelationships: RelationEdge[] = [];

  if (config.retrieval.entityContextInjection) {
    // Prioritise entities surfaced in selected memories; fall back to top-salience.
    const activeInMemories = new Set<string>();
    for (const m of selected) for (const n of m.entityNames) activeInMemories.add(n);
    const orderedEntities = [
      ...vaultEntities.filter((e) => activeInMemories.has(e.name) || activeEntityNames.has(e.name)),
      ...vaultEntities.filter((e) => !activeInMemories.has(e.name) && !activeEntityNames.has(e.name)),
    ].slice(0, config.retrieval.maxEntitySnapshots);

    for (const e of orderedEntities) {
      let emotionalProfile: Record<string, number> = {};
      try { emotionalProfile = JSON.parse(e.emotional_valence); } catch { /* empty */ }
      entitySnapshots.push({
        id: e.id,
        name: e.name,
        type: e.entity_type as EntityType,
        status: e.status as EntityStatus,
        description: e.description,
        lastSeenAt: null,
        mentionCount: 0,
        topFacts: safeJsonArray(e.facts),
        emotionalProfile,
        relationships: [],
      });
    }
  }

  if (query.includeRelationships !== false && config.retrieval.relationshipInjection) {
    const relRows = db.query(
      `SELECT source_entity_name, target_entity_name, relation_type, relation_label,
              strength, sentiment
       FROM cortex_vault_relations WHERE vault_id = ?
       ORDER BY strength DESC LIMIT ?`,
    ).all(vaultId, config.retrieval.maxRelationships) as Array<{
      source_entity_name: string; target_entity_name: string;
      relation_type: string; relation_label: string | null;
      strength: number; sentiment: number;
    }>;
    for (const r of relRows) {
      activeRelationships.push({
        sourceName: r.source_entity_name,
        targetName: r.target_entity_name,
        type: r.relation_type as RelationType,
        label: r.relation_label,
        strength: r.strength,
        sentiment: r.sentiment,
      });
    }
  }

  return {
    memories: selected,
    entityContext: entitySnapshots,
    activeRelationships,
    arcContext: null,
    stats: {
      candidatePoolSize: candidateIds.size,
      vectorSearchResults: vectorResults.length,
      entitiesMatched: activeEntityNames.size,
      scoreFusionApplied: config.retrieval.useFusedScoring,
      topScore: selected[0]?.finalScore ?? 0,
      retrievalTimeMs: Date.now() - startTime,
    },
  };
}

/**
 * Memory Cortex — Garbage collection and embedding optimization.
 *
 * Solves:
 *   - Redundant re-vectorization on chunk append (debounce)
 *   - Stale vectors from consolidated chunks (compaction)
 *   - Expired query cache entries (cleanup)
 *   - Disk usage visibility for users
 */

import { getDb } from "../../db/connection";

// ─── Chunk Vectorization Debounce ──────────────────────────────

const dirtyChunks = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Mark a chunk as needing vectorization, but debounce for `delayMs`.
 * If the chunk is mutated again within the delay window, the timer resets.
 * Prevents re-embedding a chunk 3x when 3 messages are appended in succession.
 */
export function debouncedVectorize(
  userId: string,
  chatId: string,
  chunkId: string,
  queueFn: (userId: string, chatId: string, chunkId: string, priority: number) => void,
  delayMs = 30_000,
): void {
  const key = chunkId;

  const existing = dirtyChunks.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    dirtyChunks.delete(key);
    queueFn(userId, chatId, chunkId, 3);
  }, delayMs);

  dirtyChunks.set(key, timer);
}

/** Flush all pending debounced vectorizations (call on shutdown) */
export function flushDebouncedVectorizations(): void {
  for (const [, timer] of dirtyChunks) {
    clearTimeout(timer);
  }
  dirtyChunks.clear();
}

/** Check if a chunk has a pending debounced vectorization */
export function hasPendingVectorization(chunkId: string): boolean {
  return dirtyChunks.has(chunkId);
}

// ─── Stale Vector Compaction ───────────────────────────────────

/**
 * Remove LanceDB vectors for chunks that have been consolidated.
 * Once a chunk is rolled into a tier-1 consolidation, its individual vector
 * is redundant — the consolidation has its own vector.
 *
 * @returns Number of vectors removed
 */
export async function compactConsolidatedVectors(
  userId: string,
  chatId: string,
  deleteVectorFn: (userId: string, sourceType: string, sourceId: string) => Promise<void>,
): Promise<number> {
  const db = getDb();

  const staleChunks = db
    .query(
      `SELECT id FROM chat_chunks
       WHERE chat_id = ? AND consolidation_id IS NOT NULL AND vectorized_at IS NOT NULL`,
    )
    .all(chatId) as Array<{ id: string }>;

  let removed = 0;
  for (const chunk of staleChunks) {
    try {
      await deleteVectorFn(userId, "chat_chunk", chunk.id);
      db.query("UPDATE chat_chunks SET vectorized_at = NULL, vector_model = NULL WHERE id = ?")
        .run(chunk.id);
      removed++;
    } catch {
      // Non-fatal: vector may already be gone
    }
  }

  if (removed > 0) {
    console.info(`[memory-cortex] Compacted ${removed} stale vectors for chat ${chatId}`);
  }

  return removed;
}

// ─── Query Cache Cleanup ───────────────────────────────────────

/** Remove expired entries from the query vector cache. */
export function cleanupQueryCache(): number {
  const now = Math.floor(Date.now() / 1000);
  const result = getDb()
    .query("DELETE FROM query_vector_cache WHERE expires_at < ?")
    .run(now);
  return result.changes;
}

// ─── Disk Usage Stats ──────────────────────────────────────────

export interface CortexUsageStats {
  chunkCount: number;
  vectorizedChunkCount: number;
  entityCount: number;
  activeEntityCount: number;
  consolidationCount: number;
  salienceRecordCount: number;
  mentionCount: number;
  relationCount: number;
  estimatedEmbeddingCalls: number;
}

/**
 * Get usage statistics for a chat's cortex data.
 * Designed to be surfaced in a user-facing stats panel.
 */
export function getCortexUsageStats(chatId: string): CortexUsageStats {
  const db = getDb();

  const chunks = db.query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ?").get(chatId) as any;
  const vectorized = db.query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ? AND vectorized_at IS NOT NULL").get(chatId) as any;
  const entities = db.query("SELECT COUNT(*) as c FROM memory_entities WHERE chat_id = ?").get(chatId) as any;
  const activeEntities = db.query("SELECT COUNT(*) as c FROM memory_entities WHERE chat_id = ? AND status != 'inactive'").get(chatId) as any;
  const consolidations = db.query("SELECT COUNT(*) as c FROM memory_consolidations WHERE chat_id = ?").get(chatId) as any;
  const salience = db.query("SELECT COUNT(*) as c FROM memory_salience WHERE chat_id = ?").get(chatId) as any;
  const mentions = db.query("SELECT COUNT(*) as c FROM memory_mentions WHERE chat_id = ?").get(chatId) as any;
  const relations = db.query("SELECT COUNT(*) as c FROM memory_relations WHERE chat_id = ?").get(chatId) as any;

  return {
    chunkCount: chunks?.c ?? 0,
    vectorizedChunkCount: vectorized?.c ?? 0,
    entityCount: entities?.c ?? 0,
    activeEntityCount: activeEntities?.c ?? 0,
    consolidationCount: consolidations?.c ?? 0,
    salienceRecordCount: salience?.c ?? 0,
    mentionCount: mentions?.c ?? 0,
    relationCount: relations?.c ?? 0,
    estimatedEmbeddingCalls: (vectorized?.c ?? 0) + Math.floor((chunks?.c ?? 0) * 0.3),
  };
}

// ─── Periodic Maintenance ──────────────────────────────────────

/**
 * Run all maintenance tasks. Called periodically or after bulk operations.
 */
export async function runMaintenance(
  userId: string,
  chatId: string,
  deleteVectorFn: (userId: string, sourceType: string, sourceId: string) => Promise<void>,
): Promise<{ cacheEntriesCleaned: number; vectorsCompacted: number }> {
  const cacheEntriesCleaned = cleanupQueryCache();
  const vectorsCompacted = await compactConsolidatedVectors(userId, chatId, deleteVectorFn);

  return { cacheEntriesCleaned, vectorsCompacted };
}

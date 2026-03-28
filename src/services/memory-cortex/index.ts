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
import { getCortexConfig, putCortexConfig, type MemoryCortexConfig } from "./config";
import { scoreChunkHeuristic } from "./salience-heuristic";
import { extractWithSidecar, extractBatchWithSidecar, getToolChoiceParams, getExtractionStructuredParams } from "./salience-sidecar";
import { extractEntitiesHeuristic, extractMentionExcerpt } from "./entity-extractor";
import * as entityGraph from "./entity-graph";
import * as entityContext from "./entity-context";
import * as consolidation from "./consolidation";
import { buildEmotionalContext } from "./emotional-context";
import { queryCortex as queryCortexImpl } from "./retrieval";
import { formatShadowPrompt, type FormatterMode, type ShadowPromptResult } from "./shadow-formatter";
import { getCortexUsageStats, runMaintenance, debouncedVectorize } from "./gc";
import { processChunkFontColors, formatColorMapForPrompt, deleteColorMapForChat, getColorMap, recordColorAttribution } from "./font-attribution";
import { extractRelationshipsHeuristic } from "./relationship-extractor";
import type {
  ChunkIngestionData,
  CortexQuery,
  CortexResult,
  CortexMemory,
  MemoryEntity,
  EntitySnapshot,
  SalienceResult,
  EmotionalTag,
} from "./types";

// Re-export public types and config
export { getCortexConfig, putCortexConfig, applyCortexPreset } from "./config";
export type { MemoryCortexConfig, CortexPresetMode } from "./config";
export { formatShadowPrompt } from "./shadow-formatter";
export type { FormatterMode, ShadowPromptResult } from "./shadow-formatter";
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
} from "./types";
export { buildEmotionalContext } from "./emotional-context";
export { formatEntitySnapshots, formatRelationships } from "./entity-context";

// ─── Retrieval ─────────────────────────────────────────────────

/**
 * Execute a cortex-enhanced memory retrieval query.
 * This is the primary entry point called from prompt assembly.
 */
export async function queryCortex(
  query: CortexQuery,
  config?: MemoryCortexConfig,
): Promise<CortexResult> {
  const cfg = config ?? getCortexConfig(query.userId);
  if (!cfg.enabled) {
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
        retrievalTimeMs: 0,
      },
    };
  }

  return queryCortexImpl(query, cfg);
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
  }) => Promise<{ content: string }>,
  sidecarConnectionId?: string,
): Promise<void> {
  const config = getCortexConfig(data.userId);
  if (!config.enabled) return;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  let salienceResult: SalienceResult;
  let sidecarEntities: Array<{ name: string; type: string; role?: string }> = [];
  let sidecarRelationships: Array<{ source: string; target: string; type: string; label: string; sentiment: number }> = [];
  let sidecarFacts: string[] = [];

  // ── Font Color Extraction (runs before everything else) ──
  // Must run first so the sidecar and heuristics both get clean content.

  const knownEntities = entityGraph.getActiveEntities(data.chatId);
  const entityIdByName = new Map<string, string>();
  for (const e of knownEntities) {
    entityIdByName.set(e.name.toLowerCase(), e.id);
    for (const alias of e.aliases) entityIdByName.set(alias.toLowerCase(), e.id);
  }

  // Build entity context with aliases for the sidecar (canonical names + known aliases)
  const entityContext = knownEntities.map((e) => ({
    name: e.name,
    type: e.entityType,
    aliases: e.aliases,
  }));

  const fontResult = processChunkFontColors(
    data.chatId,
    data.content,
    [...new Set([...characterNames, ...knownEntities.map((e) => e.name)])],
    entityIdByName,
  );
  const cleanContent = fontResult.strippedContent;

  // ── Salience Scoring ──

  if (config.salienceScoring) {
    // Use sidecar if a sidecar adapter was provided. The caller (ingestion hook or
    // rebuild route) already decided the sidecar should be used — we honor that
    // regardless of the config mode setting. This prevents the config mode from
    // silently overriding an explicit sidecar rebuild.
    if (generateRawFn && sidecarConnectionId) {
      // Sidecar mode: send RAW content (with font tags) so the LLM can
      // also attribute colors. The LLM handles HTML tags gracefully.
      // Pass known entities with aliases so the LLM uses canonical names.
      const extraction = await extractWithSidecar(
        data.content,
        generateRawFn,
        sidecarConnectionId,
        { characterNames, knownEntities: entityContext },
      );

      if (extraction) {
        salienceResult = {
          score: extraction.score,
          source: "sidecar",
          emotionalTags: extraction.emotionalTags,
          statusChanges: extraction.statusChanges,
          narrativeFlags: extraction.narrativeFlags,
          hasDialogue: /[""\u201C]/.test(data.content),
          hasAction: /\*[^*]{10,}\*/.test(data.content),
          hasInternalThought: /\b(thought|wondered|realized|felt|knew)\b/i.test(data.content),
          wordCount: data.content.split(/\s+/).length,
        };
        sidecarEntities = extraction.entitiesPresent;
        sidecarRelationships = extraction.relationshipsShown;
        sidecarFacts = extraction.keyFacts;

        // LLM font color attributions override/supplement heuristic
        if (extraction.fontColors.length > 0) {
          for (const fc of extraction.fontColors) {
            const entityId = entityIdByName.get(fc.characterName.toLowerCase()) || null;
            recordColorAttribution(
              data.chatId,
              fc.hexColor,
              entityId,
              fc.usageType as any,
              null,
            );
          }
        }
      } else {
        salienceResult = scoreChunkHeuristic(cleanContent);
      }
    } else {
      salienceResult = scoreChunkHeuristic(cleanContent);
    }

    // Insert salience record
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

    // Update denormalized fields on chat_chunks
    db.query(
      "UPDATE chat_chunks SET salience_score = ?, emotional_tags = ? WHERE id = ?",
    ).run(
      salienceResult.score,
      JSON.stringify(salienceResult.emotionalTags),
      data.chunkId,
    );
  } else {
    // No salience scoring — use neutral defaults
    salienceResult = scoreChunkHeuristic(cleanContent);
  }

  // ── Entity Extraction & Graph Update ──

  if (config.entityTracking && config.entityExtractionMode !== "off") {
    // Start with heuristic extraction on CLEAN (font-stripped) content
    // Pass whitelist and confidence threshold from config
    const heuristicEntities = extractEntitiesHeuristic(
      cleanContent,
      knownEntities,
      characterNames,
      config.entityWhitelist,
      config.entityPruning.minConfidence,
    );

    // Merge sidecar entities if available
    const mergedEntities = mergeExtractedEntities(heuristicEntities, sidecarEntities);

    // Extract heuristic relationships between entities found in this chunk
    const entityNamesInChunk = mergedEntities.map((e) => e.name);
    const heuristicRelationships = extractRelationshipsHeuristic(
      cleanContent,
      entityNamesInChunk,
      salienceResult.emotionalTags,
    );

    // Merge sidecar + heuristic relationships (sidecar takes priority for same pair+type)
    const allRelationships = mergeRelationships(heuristicRelationships, sidecarRelationships);

    // Ingest into the entity graph (using font-stripped content)
    const entityIds = entityGraph.ingestChunkEntities(
      data.chatId,
      data.chunkId,
      data.createdAt,
      mergedEntities,
      allRelationships as any[],
      salienceResult.score,
      salienceResult.emotionalTags,
      cleanContent,
    );

    // Update denormalized entity_ids on chat_chunks
    db.query("UPDATE chat_chunks SET entity_ids = ? WHERE id = ?")
      .run(JSON.stringify(entityIds), data.chunkId);

    // Auto-populate descriptions for newly created entities (using clean content)
    for (const ext of mergedEntities) {
      const entity = entityGraph.findEntityByName(data.chatId, ext.name);
      if (entity && !entity.description) {
        const excerpt = extractMentionExcerpt(ext.name, cleanContent);
        if (excerpt) entityGraph.populateEntityDescription(entity.id, excerpt);
      }
    }

    // Periodically prune stale entities (every 50 chunks)
    if (config.entityPruning.enabled) {
      const chunkCount = db.query("SELECT COUNT(*) as c FROM chat_chunks WHERE chat_id = ?").get(data.chatId) as any;
      if (chunkCount?.c && chunkCount.c % 50 === 0) {
        entityGraph.pruneStaleEntities(data.chatId, config.entityPruning.staleAfterMessages);
      }
    }

    // Apply sidecar-extracted facts to entities
    if (sidecarFacts.length > 0 && sidecarEntities.length > 0) {
      // Distribute facts to the primary subject entity
      const subjectEntity = sidecarEntities.find((e) => e.role === "subject") ?? sidecarEntities[0];
      const entity = entityGraph.findEntityByName(data.chatId, subjectEntity.name);
      if (entity) {
        entityGraph.addEntityFacts(entity.id, sidecarFacts);
      }
    }

    // Apply status changes from sidecar extraction
    if (salienceResult.statusChanges.length > 0) {
      for (const change of salienceResult.statusChanges) {
        const entity = entityGraph.findEntityByName(data.chatId, change.entity);
        if (entity) {
          const statusMap: Record<string, string> = {
            died: "deceased",
            destroyed: "destroyed",
            departed: "inactive",
            transformed: "active",
          };
          const newStatus = statusMap[change.change];
          if (newStatus) {
            entityGraph.updateEntityStatus(entity.id, newStatus as any);
          }
          // Add the status change as a fact
          entityGraph.addEntityFacts(entity.id, [`${change.change}: ${change.detail}`]);
        }
      }
    }
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
  }) => Promise<{ content: string }>,
  sidecarConnectionId?: string,
  onProgress?: (current: number, total: number) => void,
): Promise<{ chunksProcessed: number; entitiesFound: number; relationsFound: number }> {
  const config = getCortexConfig(userId);
  const db = getDb();

  console.info(`[memory-cortex] Rebuilding cortex for chat ${chatId} (sidecar: ${sidecarConnectionId ? "yes" : "heuristic only"})`);

  // Clear all derived data
  entityGraph.deleteEntitiesForChat(chatId);
  entityGraph.deleteMentionsForChat(chatId);
  entityGraph.deleteRelationsForChat(chatId);
  consolidation.deleteConsolidationsForChat(chatId);
  deleteColorMapForChat(chatId);
  db.query("DELETE FROM memory_salience WHERE chat_id = ?").run(chatId);
  db.query("UPDATE chat_chunks SET salience_score = NULL, emotional_tags = NULL, entity_ids = NULL, consolidation_id = NULL WHERE chat_id = ?").run(chatId);

  const chunks = db
    .query("SELECT * FROM chat_chunks WHERE chat_id = ? ORDER BY created_at ASC")
    .all(chatId) as any[];

  // Track state so the frontend can reconnect and see progress
  const state: RebuildState = {
    chatId,
    status: "processing",
    current: 0,
    total: chunks.length,
    percent: 0,
    startedAt: Date.now(),
  };
  activeRebuilds.set(chatId, state);

  try {
    const concurrency = config.sidecar?.rebuildConcurrency ?? 3;

    if (!generateRawFn || !sidecarConnectionId) {
      // Heuristic-only: sequential, ~1-2ms per chunk — no concurrency needed
      for (let i = 0; i < chunks.length; i++) {
        await processChunkFromRaw(chunks[i], chatId, userId, characterNames);
        state.current = i + 1;
        state.percent = Math.round(((i + 1) / chunks.length) * 100);
        if (onProgress) onProgress(i + 1, chunks.length);
      }
    } else {
      // Sidecar path: bounded concurrency queue.
      // Each slot processes ONE chunk at a time: sends the request, waits for ALL
      // tool calls to resolve, ingests the result, then takes the next chunk.
      // At most `concurrency` slots are active simultaneously.
      //
      // This avoids spamming the provider — behaves like N sequential pipelines.

      let nextChunkIdx = 0;
      let completed = 0;

      async function processNextChunk(): Promise<void> {
        while (nextChunkIdx < chunks.length) {
          const idx = nextChunkIdx++;
          const chunk = chunks[idx];

          try {
            // Single request per chunk — sends tools, waits for ALL tool_calls to resolve
            const sidecarResult = await extractWithSidecar(
              chunk.content,
              generateRawFn!,
              sidecarConnectionId!,
              { characterNames },
            );

            if (sidecarResult) {
              await processChunkWithPrecomputedSidecar(chunk, chatId, userId, characterNames, sidecarResult);
            } else {
              await processChunkFromRaw(chunk, chatId, userId, characterNames);
            }
          } catch {
            // Sidecar failed — fall back to heuristic for this chunk
            await processChunkFromRaw(chunk, chatId, userId, characterNames);
          }

          completed++;
          state.current = completed;
          state.percent = Math.round((completed / chunks.length) * 100);
          if (onProgress) onProgress(completed, chunks.length);
        }
      }

      // Launch `concurrency` worker slots — each one pulls chunks sequentially
      const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, () => processNextChunk());
      await Promise.all(workers);
    }

    const entities = entityGraph.getEntities(chatId);
    const relations = entityGraph.getRelations(chatId);

    const result = {
      chunksProcessed: chunks.length,
      entitiesFound: entities.length,
      relationsFound: relations.length,
    };

    state.status = "complete";
    state.result = result;
    // Keep state around for 5 minutes so reconnecting clients can see the result
    setTimeout(() => activeRebuilds.delete(chatId), 5 * 60 * 1000);

    console.info(
      `[memory-cortex] Rebuild complete: ${chunks.length} chunks, ${entities.length} entities, ${relations.length} relations`,
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
      // Sidecar overrides type and role if present
      existing.type = e.type || existing.type;
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

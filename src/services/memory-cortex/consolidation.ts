/**
 * Memory Cortex — Hierarchical memory consolidation.
 *
 * As chats grow, raw chunks accumulate. Consolidation compresses older chunks
 * into higher-level summaries:
 *
 *   Tier 1 (Consolidated): N raw chunks → 1 summary paragraph
 *   Tier 2 (Arc):          N consolidations → 1 arc summary
 *
 * Supports two modes:
 *   - Extractive (no sidecar): Picks highest-salience sentences from source chunks
 *   - Generative (sidecar): LLM produces a focused narrative summary
 *
 * Consolidation is always async and never blocks generation.
 */

import { getDb } from "../../db/connection";
import type {
  MemoryConsolidation,
  MemoryConsolidationRow,
  EmotionalTag,
} from "./types";
import type { ConsolidationConfig } from "./config";
import { scoreChunkHeuristic } from "./salience-heuristic";

// ─── Row Mapper ────────────────────────────────────────────────

function rowToConsolidation(row: MemoryConsolidationRow): MemoryConsolidation {
  return {
    id: row.id,
    chatId: row.chat_id,
    tier: row.tier,
    title: row.title,
    summary: row.summary,
    sourceChunkIds: safeJsonArray(row.source_chunk_ids),
    sourceConsolidationIds: safeJsonArray(row.source_consolidation_ids),
    entityIds: safeJsonArray(row.entity_ids),
    messageRangeStart: row.message_range_start,
    messageRangeEnd: row.message_range_end,
    timeRangeStart: row.time_range_start,
    timeRangeEnd: row.time_range_end,
    salienceAvg: row.salience_avg,
    emotionalTags: safeJsonArray(row.emotional_tags) as EmotionalTag[],
    tokenCount: row.token_count,
    vectorizedAt: row.vectorized_at,
    vectorModel: row.vector_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

// ─── Consolidation Queries ─────────────────────────────────────

/** Get all consolidations for a chat at a given tier */
export function getConsolidations(chatId: string, tier?: number): MemoryConsolidation[] {
  const db = getDb();
  const query = tier != null
    ? "SELECT * FROM memory_consolidations WHERE chat_id = ? AND tier = ? ORDER BY message_range_start ASC"
    : "SELECT * FROM memory_consolidations WHERE chat_id = ? ORDER BY tier ASC, message_range_start ASC";
  const rows = tier != null
    ? db.query(query).all(chatId, tier) as MemoryConsolidationRow[]
    : db.query(query).all(chatId) as MemoryConsolidationRow[];
  return rows.map(rowToConsolidation);
}

/** Get the most recent arc summary for a chat */
export function getLatestArc(chatId: string): MemoryConsolidation | null {
  const row = getDb()
    .query("SELECT * FROM memory_consolidations WHERE chat_id = ? AND tier = 2 ORDER BY message_range_end DESC LIMIT 1")
    .get(chatId) as MemoryConsolidationRow | null;
  return row ? rowToConsolidation(row) : null;
}

/** Delete all consolidations for a chat (used in rebuild) */
export function deleteConsolidationsForChat(chatId: string): void {
  getDb().query("DELETE FROM memory_consolidations WHERE chat_id = ?").run(chatId);
}

// ─── Consolidation Pipeline ────────────────────────────────────

/**
 * Check if consolidation is needed and run it if so.
 * Called after chunk creation, runs synchronously for extractive mode.
 */
export async function maybeConsolidate(
  userId: string,
  chatId: string,
  config: ConsolidationConfig,
  generateRawFn?: (opts: {
    connectionId: string;
    messages: Array<{ role: string; content: string }>;
    parameters: Record<string, any>;
  }) => Promise<{ content: string }>,
  sidecarConnectionId?: string,
): Promise<void> {
  if (!config.enabled) return;

  const db = getDb();

  // Count unconsolidated chunks
  const unconsolidated = db
    .query(
      `SELECT cc.*, ms.score as salience_score, ms.emotional_tags as salience_emotional_tags
       FROM chat_chunks cc
       LEFT JOIN memory_salience ms ON ms.chunk_id = cc.id
       WHERE cc.chat_id = ? AND cc.consolidation_id IS NULL
       ORDER BY cc.created_at ASC`,
    )
    .all(chatId) as any[];

  if (unconsolidated.length < config.chunkThreshold) return;

  // Take the oldest batch
  const batch = unconsolidated.slice(0, config.chunksPerConsolidation);

  let summary: string;
  let title: string | null = null;

  if (config.useSidecar && generateRawFn && sidecarConnectionId) {
    const result = await generateConsolidationSummary(
      batch, generateRawFn, sidecarConnectionId, config.maxTokensPerSummary,
    );
    summary = result.summary;
    title = result.title;
  } else {
    summary = extractiveConsolidation(batch);
    title = inferTitle(batch);
  }

  // Collect metadata from source chunks
  const entityIdSet = new Set<string>();
  const emotionalTagSet = new Set<string>();
  let salienceSum = 0;
  let salienceCount = 0;

  for (const chunk of batch) {
    const entityIds = safeJsonArray(chunk.entity_ids);
    for (const id of entityIds) entityIdSet.add(id);

    const tags = safeJsonArray(chunk.salience_emotional_tags ?? chunk.emotional_tags);
    for (const tag of tags) emotionalTagSet.add(tag);

    if (chunk.salience_score != null) {
      salienceSum += chunk.salience_score;
      salienceCount++;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const consolidationId = crypto.randomUUID();

  // Insert consolidation record
  db.query(
    `INSERT INTO memory_consolidations
      (id, chat_id, tier, title, summary, source_chunk_ids, entity_ids,
       message_range_start, message_range_end, time_range_start, time_range_end,
       salience_avg, emotional_tags, token_count, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    consolidationId, chatId, title, summary,
    JSON.stringify(batch.map((c: any) => c.id)),
    JSON.stringify([...entityIdSet]),
    batch[0].created_at,
    batch[batch.length - 1].created_at,
    batch[0].created_at,
    batch[batch.length - 1].created_at,
    salienceCount > 0 ? salienceSum / salienceCount : 0,
    JSON.stringify([...emotionalTagSet]),
    estimateTokens(summary),
    now, now,
  );

  // Mark source chunks as consolidated
  const chunkIds = batch.map((c: any) => c.id);
  const placeholders = chunkIds.map(() => "?").join(",");
  db.query(`UPDATE chat_chunks SET consolidation_id = ? WHERE id IN (${placeholders})`)
    .run(consolidationId, ...chunkIds);

  console.info(
    `[memory-cortex] Consolidated ${batch.length} chunks into ${consolidationId} for chat ${chatId}`,
  );

  // Check for arc-level consolidation
  await maybeConsolidateArcs(userId, chatId, config, generateRawFn, sidecarConnectionId);
}

/**
 * Arc-level consolidation: Tier 2.
 * Groups tier-1 consolidations into broader narrative arc summaries.
 */
async function maybeConsolidateArcs(
  userId: string,
  chatId: string,
  config: ConsolidationConfig,
  generateRawFn?: (opts: {
    connectionId: string;
    messages: Array<{ role: string; content: string }>;
    parameters: Record<string, any>;
  }) => Promise<{ content: string }>,
  sidecarConnectionId?: string,
): Promise<void> {
  const db = getDb();

  // Count tier-1 consolidations not yet rolled into an arc
  const tier1 = db
    .query(
      `SELECT * FROM memory_consolidations
       WHERE chat_id = ? AND tier = 1
         AND id NOT IN (
           SELECT json_each.value FROM memory_consolidations mc2
           CROSS JOIN json_each(mc2.source_consolidation_ids)
           WHERE mc2.chat_id = ? AND mc2.tier = 2
         )
       ORDER BY message_range_start ASC`,
    )
    .all(chatId, chatId) as MemoryConsolidationRow[];

  if (tier1.length < config.arcThreshold) return;

  const batch = tier1.slice(0, config.arcThreshold);
  const summaries = batch.map((c) => c.summary);

  let arcSummary: string;
  let arcTitle: string | null = null;

  if (config.useSidecar && generateRawFn && sidecarConnectionId) {
    const combined = summaries.join("\n\n---\n\n");
    const result = await generateArcSummary(
      combined, generateRawFn, sidecarConnectionId, config.maxTokensPerSummary,
    );
    arcSummary = result.summary;
    arcTitle = result.title;
  } else {
    arcSummary = summaries.join(" ");
    arcTitle = `Arc: Messages ${batch[0].message_range_start}-${batch[batch.length - 1].message_range_end}`;
  }

  const now = Math.floor(Date.now() / 1000);
  const arcId = crypto.randomUUID();

  // Merge metadata from source consolidations
  const entityIdSet = new Set<string>();
  const emotionalTagSet = new Set<string>();
  let salienceSum = 0;

  for (const c of batch) {
    for (const id of safeJsonArray(c.entity_ids)) entityIdSet.add(id);
    for (const tag of safeJsonArray(c.emotional_tags)) emotionalTagSet.add(tag);
    salienceSum += c.salience_avg;
  }

  db.query(
    `INSERT INTO memory_consolidations
      (id, chat_id, tier, title, summary, source_consolidation_ids, entity_ids,
       message_range_start, message_range_end, time_range_start, time_range_end,
       salience_avg, emotional_tags, token_count, created_at, updated_at)
     VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    arcId, chatId, arcTitle, arcSummary,
    JSON.stringify(batch.map((c) => c.id)),
    JSON.stringify([...entityIdSet]),
    batch[0].message_range_start,
    batch[batch.length - 1].message_range_end,
    batch[0].time_range_start,
    batch[batch.length - 1].time_range_end,
    salienceSum / batch.length,
    JSON.stringify([...emotionalTagSet]),
    estimateTokens(arcSummary),
    now, now,
  );

  console.info(
    `[memory-cortex] Created arc consolidation ${arcId} from ${batch.length} tier-1 consolidations`,
  );
}

// ─── Extractive Consolidation ──────────────────────────────────

/**
 * Extractive summarization: no sidecar needed.
 * Selects the highest-salience sentences from source chunks,
 * preserving chronological order.
 */
function extractiveConsolidation(chunks: any[]): string {
  const sentences: Array<{ text: string; salience: number; chunkIdx: number }> = [];

  for (let i = 0; i < chunks.length; i++) {
    const content = chunks[i].content || "";
    const chunkSalience = chunks[i].salience_score ?? 0.3;

    for (const sent of splitSentences(content)) {
      if (sent.length < 15) continue; // Skip very short fragments
      const sentSalience = scoreChunkHeuristic(sent).score * chunkSalience;
      sentences.push({ text: sent.trim(), salience: sentSalience, chunkIdx: i });
    }
  }

  // Select top sentences, preserving chronological order
  const selected = sentences
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 8)
    .sort((a, b) => a.chunkIdx - b.chunkIdx);

  return selected.map((s) => s.text).join(" ");
}

/**
 * Infer a title from the chunks using the highest-salience content.
 */
function inferTitle(chunks: any[]): string | null {
  // Try to find a distinctive proper noun or location
  for (const chunk of chunks) {
    const content = chunk.content || "";
    const match = content.match(/(?:the\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/);
    if (match) return match[0];
  }
  return null;
}

// ─── Generative Consolidation (Sidecar) ────────────────────────

const CONSOLIDATION_PROMPT = `Summarize this sequence of roleplay passages into a single, concise narrative summary. Preserve key facts, character actions, emotional beats, and plot developments. Write in past tense, third person.

<passages>
{{CONTENT}}
</passages>

Respond in JSON:
{"title": "<brief 3-6 word title for this segment>", "summary": "<narrative summary, max {{MAX_TOKENS}} tokens>"}`;

async function generateConsolidationSummary(
  chunks: any[],
  generateRawFn: (opts: any) => Promise<{ content: string }>,
  connectionId: string,
  maxTokens: number,
): Promise<{ summary: string; title: string | null }> {
  try {
    const content = chunks.map((c: any) => c.content || "").join("\n\n---\n\n");
    const prompt = CONSOLIDATION_PROMPT
      .replace("{{CONTENT}}", content)
      .replace("{{MAX_TOKENS}}", String(maxTokens));

    const response = await generateRawFn({
      connectionId,
      messages: [
        { role: "system", content: "You are a narrative summarizer. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      parameters: { temperature: 0.3, max_tokens: maxTokens + 100 },
    });

    const json = extractJson(response.content);
    if (json) {
      return {
        summary: json.summary || extractiveConsolidation(chunks),
        title: json.title || null,
      };
    }
  } catch (err) {
    console.warn("[memory-cortex] Generative consolidation failed, using extractive:", err);
  }

  return { summary: extractiveConsolidation(chunks), title: inferTitle(chunks) };
}

const ARC_PROMPT = `These are sequential narrative summaries from a long roleplay. Create a single high-level arc summary that captures the overarching plot, character development, and thematic threads.

<summaries>
{{CONTENT}}
</summaries>

Respond in JSON:
{"title": "<arc title, 3-8 words>", "summary": "<arc-level summary, max {{MAX_TOKENS}} tokens>"}`;

async function generateArcSummary(
  combinedSummaries: string,
  generateRawFn: (opts: any) => Promise<{ content: string }>,
  connectionId: string,
  maxTokens: number,
): Promise<{ summary: string; title: string | null }> {
  try {
    const prompt = ARC_PROMPT
      .replace("{{CONTENT}}", combinedSummaries)
      .replace("{{MAX_TOKENS}}", String(maxTokens));

    const response = await generateRawFn({
      connectionId,
      messages: [
        { role: "system", content: "You are a narrative summarizer. Output valid JSON only." },
        { role: "user", content: prompt },
      ],
      parameters: { temperature: 0.3, max_tokens: maxTokens + 100 },
    });

    const json = extractJson(response.content);
    if (json) {
      return {
        summary: json.summary || combinedSummaries,
        title: json.title || null,
      };
    }
  } catch (err) {
    console.warn("[memory-cortex] Arc summary generation failed:", err);
  }

  return { summary: combinedSummaries, title: null };
}

// ─── Helpers ───────────────────────────────────────────────────

function splitSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or newline
  return text.split(/(?<=[.!?])\s+|(?<=\n)\s*/).filter((s) => s.length > 0);
}

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

function extractJson(text: string): any | null {
  try {
    let cleaned = text.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    }
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

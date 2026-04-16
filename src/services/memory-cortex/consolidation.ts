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
    signal?: AbortSignal;
  }) => Promise<{ content: string }>,
  sidecarConnectionId?: string,
  sidecarTimeoutMs?: number,
): Promise<void> {
  if (!config.enabled) return;

  const db = getDb();

  // Check if we have enough unconsolidated chunks to warrant consolidation.
  // Use a COUNT query first to avoid loading the entire result set into memory
  // (in long chats with a backlog, there can be thousands of unconsolidated chunks).
  const countRow = db
    .query(
      `SELECT COUNT(*) as count FROM chat_chunks
       WHERE chat_id = ? AND consolidation_id IS NULL`,
    )
    .get(chatId) as { count: number } | null;

  if (!countRow || countRow.count < config.chunkThreshold) return;

  // Only fetch the batch we actually need
  const batch = db
    .query(
      `SELECT cc.*, ms.score as salience_score, ms.emotional_tags as salience_emotional_tags
       FROM chat_chunks cc
       LEFT JOIN memory_salience ms ON ms.chunk_id = cc.id
       WHERE cc.chat_id = ? AND cc.consolidation_id IS NULL
       ORDER BY cc.created_at ASC
       LIMIT ?`,
    )
    .all(chatId, config.chunksPerConsolidation) as any[];

  let summary: string;
  let title: string | null = null;

  if (config.useSidecar && generateRawFn && sidecarConnectionId) {
    // Time-bound the sidecar call to prevent hanging promises during consolidation.
    // Timeout is user-configurable to accommodate thinking models.
    // Uses AbortController so the underlying HTTP request is cancelled on timeout.
    const timeoutMs = sidecarTimeoutMs ?? 30_000;
    const ac = timeoutMs > 0 ? new AbortController() : null;
    const timer = ac ? setTimeout(() => {
      console.warn(`[memory-cortex] Consolidation sidecar timed out after ${timeoutMs}ms, aborting LLM call`);
      ac.abort();
    }, timeoutMs) : null;

    const boundGenFn: typeof generateRawFn = ac
      ? (opts) => generateRawFn({ ...opts, signal: ac.signal })
      : generateRawFn;

    let result: { summary: string; title: string | null } | null;
    try {
      result = await generateConsolidationSummary(
        batch, boundGenFn, sidecarConnectionId, config.maxTokensPerSummary,
      );
    } catch (err: any) {
      if (err?.name === "AbortError" || ac?.signal.aborted) {
        console.warn(`[memory-cortex] Consolidation sidecar timed out after ${timeoutMs}ms, using extractive fallback`);
        result = null;
      } else {
        throw err;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (result) {
      summary = result.summary;
      title = result.title;
    } else {
      summary = extractiveConsolidation(batch);
      title = inferTitle(batch);
    }
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
  await maybeConsolidateArcs(userId, chatId, config, generateRawFn, sidecarConnectionId, sidecarTimeoutMs);
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
    signal?: AbortSignal;
  }) => Promise<{ content: string }>,
  sidecarConnectionId?: string,
  sidecarTimeoutMs?: number,
): Promise<void> {
  const db = getDb();

  // Check threshold with COUNT first, then fetch only the batch we need.
  const countRow = db
    .query(
      `SELECT COUNT(*) as count FROM memory_consolidations
       WHERE chat_id = ? AND tier = 1
         AND id NOT IN (
           SELECT json_each.value FROM memory_consolidations mc2
           CROSS JOIN json_each(mc2.source_consolidation_ids)
           WHERE mc2.chat_id = ? AND mc2.tier = 2
         )`,
    )
    .get(chatId, chatId) as { count: number } | null;

  if (!countRow || countRow.count < config.arcThreshold) return;

  const batch = db
    .query(
      `SELECT * FROM memory_consolidations
       WHERE chat_id = ? AND tier = 1
         AND id NOT IN (
           SELECT json_each.value FROM memory_consolidations mc2
           CROSS JOIN json_each(mc2.source_consolidation_ids)
           WHERE mc2.chat_id = ? AND mc2.tier = 2
         )
       ORDER BY message_range_start ASC
       LIMIT ?`,
    )
    .all(chatId, chatId, config.arcThreshold) as MemoryConsolidationRow[];
  const summaries = batch.map((c) => c.summary);

  let arcSummary: string;
  let arcTitle: string | null = null;

  if (config.useSidecar && generateRawFn && sidecarConnectionId) {
    const combined = summaries.join("\n\n---\n\n");
    const timeoutMs = sidecarTimeoutMs ?? 30_000;
    const ac = timeoutMs > 0 ? new AbortController() : null;
    const timer = ac ? setTimeout(() => {
      console.warn(`[memory-cortex] Arc consolidation sidecar timed out after ${timeoutMs}ms, aborting LLM call`);
      ac.abort();
    }, timeoutMs) : null;

    const boundGenFn: typeof generateRawFn = ac
      ? (opts) => generateRawFn({ ...opts, signal: ac.signal })
      : generateRawFn;

    let result: { summary: string; title: string | null } | null;
    try {
      result = await generateArcSummary(
        combined, boundGenFn, sidecarConnectionId, config.maxTokensPerSummary,
      );
    } catch (err: any) {
      if (err?.name === "AbortError" || ac?.signal.aborted) {
        console.warn(`[memory-cortex] Arc consolidation sidecar timed out after ${timeoutMs}ms, using join fallback`);
        result = null;
      } else {
        throw err;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (result) {
      arcSummary = result.summary;
      arcTitle = result.title;
    } else {
      arcSummary = summaries.join(" ");
      arcTitle = null;
    }
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
 * preserving chronological order with diversity across chunks.
 */
function extractiveConsolidation(chunks: any[]): string {
  const sentences: Array<{ text: string; salience: number; chunkIdx: number; sentIdx: number }> = [];

  for (let i = 0; i < chunks.length; i++) {
    let content = chunks[i].content || "";
    // Strip chunk format prefix: [CHARACTER | Name]: or [USER | Name]:
    content = content.replace(/^\[(?:CHARACTER|USER)\s*\|\s*[^\]]*\]\s*:\s*/gi, "").trim();
    const chunkSalience = chunks[i].salience_score ?? 0.3;
    const sents = splitSentences(content);

    for (let j = 0; j < sents.length; j++) {
      const sent = sents[j].trim();
      if (sent.length < 20) continue;
      let sentScore = scoreChunkHeuristic(sent).score * chunkSalience;
      // Slight boost for topic sentences (first in chunk)
      if (j === 0) sentScore *= 1.15;
      sentences.push({ text: sent, salience: sentScore, chunkIdx: i, sentIdx: j });
    }
  }

  // Select top sentences with per-chunk diversity cap
  const selected: typeof sentences = [];
  const chunkCounts = new Map<number, number>();
  const ranked = [...sentences].sort((a, b) => b.salience - a.salience);

  for (const sent of ranked) {
    if (selected.length >= 8) break;
    const count = chunkCounts.get(sent.chunkIdx) || 0;
    if (count >= 3) continue; // Max 3 sentences per source chunk
    selected.push(sent);
    chunkCounts.set(sent.chunkIdx, count + 1);
  }

  // Re-sort chronologically
  selected.sort((a, b) => a.chunkIdx - b.chunkIdx || a.sentIdx - b.sentIdx);

  return selected.map((s) => s.text).join(" ");
}

/**
 * Infer a title from the chunks using the highest-salience content.
 */
function inferTitle(chunks: any[]): string | null {
  // Extract message range for a fallback title
  const firstTime = chunks[0]?.created_at;
  const lastTime = chunks[chunks.length - 1]?.created_at;

  // Try to find a distinctive proper noun or location from the highest-salience chunk
  const sorted = [...chunks].sort((a, b) => (b.salience_score ?? 0) - (a.salience_score ?? 0));
  for (const chunk of sorted.slice(0, 3)) {
    let content = chunk.content || "";
    content = content.replace(/^\[(?:CHARACTER|USER)\s*\|\s*[^\]]*\]\s*:\s*/gi, "");
    const match = content.match(/(?:the\s+)?([A-Z][a-z]+(?:\s+(?:of\s+)?[A-Z][a-z]+){0,2})/);
    if (match && match[0].length > 3) return match[0];
  }

  if (firstTime && lastTime) {
    return `Scene ${new Date(firstTime * 1000).toLocaleDateString()}`;
  }
  return null;
}

// ─── Generative Consolidation (Sidecar) ────────────────────────

const CONSOLIDATION_PROMPT = `Compress these roleplay passages into a dense narrative summary for a memory system. This summary replaces the original text for long-term recall.

RULES:
- Past tense, third person
- Preserve: character names, key actions, decisions, emotional shifts, locations visited, items gained/lost, promises made, status changes
- Omit: atmospheric filler, redundant descriptions, routine greetings, scenery that doesn't matter later
- Every sentence must carry a plot fact, character action, or relationship change
- Do NOT add interpretation, meta-commentary, or analysis

<passages>
{{CONTENT}}
</passages>

Respond in JSON only:
{"title": "<3-6 word title capturing the key event or scene>", "summary": "<factual narrative summary>"}`;

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

const ARC_PROMPT = `These are sequential scene summaries from a long roleplay. Compress them into ONE arc-level summary that tracks what changed across the entire sequence.

RULES:
- Past tense, third person
- Track: who did what, how relationships shifted, what was gained/lost/discovered, where the story moved
- Focus on CHANGE: what was different at the end vs the beginning of this arc
- Omit details that don't affect anything later
- Dense and factual — this single summary replaces all the individual scene summaries

<summaries>
{{CONTENT}}
</summaries>

Respond in JSON only:
{"title": "<3-8 word arc title>", "summary": "<arc-level summary tracking key changes>"}`;

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
    // Strip reasoning/thinking tags that some models emit
    cleaned = cleaned.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
    cleaned = cleaned.replace(/<(think|thinking|reasoning)>[\s\S]*$/gi, "");
    // Strip markdown fences
    cleaned = cleaned.trim();
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

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
import { stripNonProseTags } from "../../utils/content-sanitizer";
import type {
  MemoryConsolidation,
  MemoryConsolidationRow,
  EmotionalTag,
} from "./types";
import type {
  ConsolidationConfig,
  CortexModelFallbackPair,
  SidecarReliabilityConfig,
} from "./config";
import { getCortexConfig, listCortexFallbackEndpoints } from "./config";
import { scoreChunkHeuristic } from "./salience-heuristic";

type ConsolidationGenerateRawFn = (opts: {
  connectionId: string;
  messages: Array<{ role: string; content: string }>;
  parameters: Record<string, any>;
  signal?: AbortSignal;
}) => Promise<{ content: string }>;

export type MemorySummarizationRole = "primary" | "secondary";
export type MemorySummarizationChainStatus = "ok" | "aborted" | "timeout" | "unavailable" | "exhausted";

export interface MemorySummarizationTarget {
  connectionProfileId: string;
  model: string | null;
  role: MemorySummarizationRole;
}

export interface MemorySummarizationDecision<T = unknown> {
  status: MemorySummarizationChainStatus;
  result: T | null;
  role: MemorySummarizationRole | null;
  persist: boolean;
  useExtractive: boolean;
  attempts: number;
}

export interface ConsolidationSidecarOptions {
  memorySummarization?: CortexModelFallbackPair;
  sidecarReliability?: Pick<SidecarReliabilityConfig, "fallback" | "maxRetries" | "retryDelayMs">;
  sidecarTimeoutMs?: number;
  sidecar?: { connectionProfileId?: string | null; model?: string | null };
  signal?: AbortSignal;
}

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

export function collectMemorySummarizationTargets(
  pair: CortexModelFallbackPair | undefined,
  fallbackConnectionId?: string,
  sidecar?: { connectionProfileId?: string | null; model?: string | null },
): MemorySummarizationTarget[] {
  const primaryId = pair?.primary.connectionProfileId
    || sidecar?.connectionProfileId
    || fallbackConnectionId
    || null;
  const primaryModel = pair?.primary.model ?? sidecar?.model ?? null;
  const targets: MemorySummarizationTarget[] = [];
  if (primaryId) {
    targets.push({ connectionProfileId: primaryId, model: primaryModel, role: "primary" });
  }
  const seen = new Set<string>(primaryId ? [primaryId] : []);
  for (const extra of listCortexFallbackEndpoints(pair)) {
    if (!extra.connectionProfileId || seen.has(extra.connectionProfileId)) continue;
    seen.add(extra.connectionProfileId);
    targets.push({
      connectionProfileId: extra.connectionProfileId,
      model: extra.model,
      role: "secondary",
    });
  }
  return targets;
}

export function decideMemorySummarizationFallback(
  status: MemorySummarizationChainStatus,
  fallback: "heuristic" | "skip",
): { persist: boolean; useExtractive: boolean } {
  if (status === "ok") return { persist: true, useExtractive: false };
  if (status === "aborted") return { persist: false, useExtractive: false };
  if (fallback === "skip") return { persist: false, useExtractive: false };
  return { persist: true, useExtractive: true };
}

function callerAbortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Aborted", "AbortError");
}

function throwIfCallerAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw callerAbortReason(signal);
}

async function delayWithCallerSignal(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCallerAborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(callerAbortReason(signal));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runMemorySummarizationSidecar<T>(options: {
  memorySummarization?: CortexModelFallbackPair;
  sidecarReliability?: Pick<SidecarReliabilityConfig, "fallback" | "maxRetries" | "retryDelayMs">;
  sidecarTimeoutMs?: number;
  sidecar?: { connectionProfileId?: string | null; model?: string | null };
  sidecarConnectionId?: string;
  signal?: AbortSignal;
  extract: (target: MemorySummarizationTarget & { attempt: number; signal?: AbortSignal }) => Promise<T | null>;
}): Promise<MemorySummarizationDecision<T>> {
  const {
    memorySummarization,
    sidecarReliability,
    sidecar,
    sidecarConnectionId,
    signal,
    extract,
  } = options;
  const fallback = sidecarReliability?.fallback === "skip" ? "skip" : "heuristic";
  const maxAttempts = 1 + (sidecarReliability?.maxRetries ?? 0);
  const baseDelayMs = sidecarReliability?.retryDelayMs ?? 500;
  const sidecarTimeoutMs = options.sidecarTimeoutMs ?? 30_000;
  const targets = collectMemorySummarizationTargets(memorySummarization, sidecarConnectionId, sidecar);

  const finish = (
    status: MemorySummarizationChainStatus,
    extra: Partial<MemorySummarizationDecision<T>> = {},
  ): MemorySummarizationDecision<T> => {
    const decided = decideMemorySummarizationFallback(status, fallback);
    return {
      status,
      result: extra.result ?? null,
      role: extra.role ?? null,
      persist: decided.persist,
      useExtractive: decided.useExtractive,
      attempts: extra.attempts ?? 0,
    };
  };

  if (signal?.aborted) return finish("aborted");
  if (targets.length === 0) return finish("unavailable");

  let attempts = 0;
  let lastRole: MemorySummarizationRole | null = null;
  let sawTimeout = false;
  let invokedAny = false;

  for (const target of targets) {
    if (signal?.aborted) return finish("aborted", { role: lastRole, attempts });
    lastRole = target.role;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) return finish("aborted", { role: lastRole, attempts });
      if (attempt > 0) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        try {
          await delayWithCallerSignal(delay, signal);
        } catch {
          return finish("aborted", { role: lastRole, attempts });
        }
        console.info(
          `[memory-cortex] Consolidation ${target.role} retry attempt ${attempt + 1}/${maxAttempts} after ${delay}ms`,
        );
      }

      const timeoutController = sidecarTimeoutMs > 0 ? new AbortController() : null;
      const timer = timeoutController
        ? setTimeout(() => {
            console.warn(`[memory-cortex] Consolidation sidecar timed out after ${sidecarTimeoutMs}ms, aborting LLM call`);
            timeoutController.abort();
          }, sidecarTimeoutMs)
        : null;
      const combinedSignal = signal && timeoutController
        ? AbortSignal.any([signal, timeoutController.signal])
        : signal ?? timeoutController?.signal;

      attempts += 1;
      invokedAny = true;
      try {
        const result = await extract({
          ...target,
          attempt: attempt + 1,
          signal: combinedSignal,
        });
        if (signal?.aborted) return finish("aborted", { role: lastRole, attempts });
        if (result != null) {
          return finish("ok", { result, role: target.role, attempts });
        }
        throw new Error("sidecar returned empty consolidation");
      } catch (err: unknown) {
        if (signal?.aborted) return finish("aborted", { role: lastRole, attempts });
        const timedOut = timeoutController?.signal.aborted === true;
        if (timedOut) sawTimeout = true;
        const name = err && typeof err === "object" && "name" in err ? String((err as { name?: unknown }).name) : "";
        if (name !== "AbortError" && !timedOut) {
          console.warn(
            `[memory-cortex] Consolidation ${target.role} attempt ${attempt + 1}/${maxAttempts} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  }

  if (signal?.aborted) return finish("aborted", { role: lastRole, attempts });
  if (!invokedAny) return finish("unavailable", { role: lastRole, attempts });
  if (sawTimeout) return finish("timeout", { role: lastRole, attempts });
  return finish("exhausted", { role: lastRole, attempts });
}

function resolveConsolidationSidecarOptions(
  userId: string,
  sidecarConnectionId?: string,
  sidecarTimeoutMs?: number,
  sidecarOptions?: ConsolidationSidecarOptions,
): ConsolidationSidecarOptions {
  if (sidecarOptions) {
    return {
      memorySummarization: sidecarOptions.memorySummarization,
      sidecarReliability: sidecarOptions.sidecarReliability,
      sidecarTimeoutMs: sidecarOptions.sidecarTimeoutMs ?? sidecarTimeoutMs,
      sidecar: sidecarOptions.sidecar,
      signal: sidecarOptions.signal,
    };
  }

  try {
    const cfg = getCortexConfig(userId);
    return {
      memorySummarization: cfg.memorySummarization,
      sidecarReliability: cfg.sidecarReliability,
      sidecarTimeoutMs: sidecarTimeoutMs ?? cfg.sidecarTimeoutMs,
      sidecar: cfg.sidecar,
    };
  } catch {
    return {
      sidecarTimeoutMs,
      sidecar: sidecarConnectionId
        ? { connectionProfileId: sidecarConnectionId, model: null }
        : undefined,
    };
  }
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
  generateRawFn?: ConsolidationGenerateRawFn,
  sidecarConnectionId?: string,
  sidecarTimeoutMs?: number,
  /** Sampling parameters forwarded to the underlying LLM call. Caller supplies
   *  the user-configured sidecar temperature/top_p; max_tokens is set per call
   *  from config.maxTokensPerSummary. */
  samplingParameters?: Record<string, unknown>,
  /** Additional scaffold tag names to strip from raw chunk content before
   *  feeding it to the consolidation LLM or extractive scorer. */
  extraScaffoldTags?: string[],
  sidecarOptions?: ConsolidationSidecarOptions,
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

  const resolvedSidecar = resolveConsolidationSidecarOptions(
    userId, sidecarConnectionId, sidecarTimeoutMs, sidecarOptions,
  );
  if (resolvedSidecar.signal?.aborted) return;

  if (config.useSidecar && generateRawFn) {
    const decision = await generateConsolidationSummary(
      batch,
      generateRawFn,
      sidecarConnectionId ?? resolvedSidecar.sidecar?.connectionProfileId ?? "",
      config.maxTokensPerSummary,
      samplingParameters,
      extraScaffoldTags,
      resolvedSidecar,
    );

    if (!decision.persist) {
      if (decision.status === "aborted") {
        console.warn("[memory-cortex] Consolidation sidecar aborted, skipping persist");
      } else {
        console.warn("[memory-cortex] Consolidation sidecar exhausted, skip persist");
      }
      return;
    }

    if (decision.result && !decision.useExtractive) {
      summary = decision.result.summary;
      title = decision.result.title;
    } else {
      console.warn("[memory-cortex] Consolidation sidecar exhausted, using extractive fallback");
      summary = extractiveConsolidation(batch, extraScaffoldTags);
      title = inferTitle(batch);
    }
  } else {
    summary = extractiveConsolidation(batch, extraScaffoldTags);
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
  await maybeConsolidateArcs(
    userId, chatId, config, generateRawFn, sidecarConnectionId, sidecarTimeoutMs,
    samplingParameters, extraScaffoldTags, resolvedSidecar,
  );
}

/**
 * Arc-level consolidation: Tier 2.
 * Groups tier-1 consolidations into broader narrative arc summaries.
 */
async function maybeConsolidateArcs(
  userId: string,
  chatId: string,
  config: ConsolidationConfig,
  generateRawFn?: ConsolidationGenerateRawFn,
  sidecarConnectionId?: string,
  sidecarTimeoutMs?: number,
  samplingParameters?: Record<string, unknown>,
  extraScaffoldTags?: string[],
  sidecarOptions?: ConsolidationSidecarOptions,
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

  if (sidecarOptions?.signal?.aborted) return;

  if (config.useSidecar && generateRawFn) {
    const combined = summaries.join("\n\n---\n\n");
    const decision = await generateArcSummary(
      combined,
      generateRawFn,
      sidecarConnectionId ?? sidecarOptions?.sidecar?.connectionProfileId ?? "",
      config.maxTokensPerSummary,
      samplingParameters,
      sidecarOptions,
    );

    if (!decision.persist) {
      if (decision.status === "aborted") {
        console.warn("[memory-cortex] Arc consolidation sidecar aborted, skipping persist");
      } else {
        console.warn("[memory-cortex] Arc consolidation sidecar exhausted, skip persist");
      }
      return;
    }

    if (decision.result && !decision.useExtractive) {
      arcSummary = decision.result.summary;
      arcTitle = decision.result.title;
    } else {
      console.warn("[memory-cortex] Arc consolidation sidecar exhausted, using join fallback");
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
function extractiveConsolidation(chunks: any[], extraScaffoldTags?: string[]): string {
  const sentences: Array<{ text: string; salience: number; chunkIdx: number; sentIdx: number }> = [];

  for (let i = 0; i < chunks.length; i++) {
    let content = stripNonProseTags(chunks[i].content || "", { extraScaffoldTags });
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

const CONSOLIDATION_PROMPT = `Compress these roleplay passages into a factual long-term memory summary.

RULES
- Use past tense and third person.
- Use names instead of vague pronouns whenever possible.
- Preserve only durable information: actions taken, decisions made, discoveries, promises, relationship changes, status changes, location moves, and important gains/losses.
- Omit atmospheric filler, repeated banter, scenic description, and details that do not matter later.
- Every sentence must contain a concrete event, state change, or decision supported by the source text.
- Do NOT add interpretation, motives, symbolism, theme analysis, or likely implications.
- Do NOT invent links between events that are not stated.
- Keep chronology clear.

<passages>
{{CONTENT}}
</passages>

Return exactly one JSON object with this shape and no extra text:
{"title":"<3-6 word concrete scene title>","summary":"<dense factual summary>"}`;

export async function generateConsolidationSummary(
  chunks: any[],
  generateRawFn: ConsolidationGenerateRawFn,
  connectionId: string,
  maxTokens: number,
  samplingParameters?: Record<string, unknown>,
  extraScaffoldTags?: string[],
  sidecarOptions?: ConsolidationSidecarOptions,
): Promise<MemorySummarizationDecision<{ summary: string; title: string | null }>> {
  return runMemorySummarizationSidecar({
    memorySummarization: sidecarOptions?.memorySummarization,
    sidecarReliability: sidecarOptions?.sidecarReliability,
    sidecarTimeoutMs: sidecarOptions?.sidecarTimeoutMs,
    sidecar: sidecarOptions?.sidecar,
    sidecarConnectionId: connectionId,
    signal: sidecarOptions?.signal,
    extract: async (target) => {
      const content = chunks
        .map((c: any) => stripNonProseTags(c.content || "", { extraScaffoldTags }))
        .join("\n\n---\n\n");
      const prompt = CONSOLIDATION_PROMPT
        .replace("{{CONTENT}}", content)
        .replace("{{MAX_TOKENS}}", String(maxTokens));

      // Caller-supplied temperature/top_p are honored; max_tokens is always set
      // here from config.maxTokensPerSummary regardless of what the caller passed.
      const userParams = samplingParameters ?? { temperature: 0.1 };
      const response = await generateRawFn({
        connectionId: target.connectionProfileId,
        messages: [
          { role: "system", content: "You are a factual memory summarizer. Output one valid JSON object only. Omit anything not directly supported by the source passages." },
          { role: "user", content: prompt },
        ],
        parameters: {
          ...userParams,
          max_tokens: maxTokens + 100,
          ...(target.model ? { model: target.model } : {}),
        },
        signal: target.signal,
      });

      if (target.signal?.aborted) return null;

      const json = extractJson(response.content);
      if (!json) return null;
      const parsedSummary = typeof json.summary === "string" ? json.summary.trim() : "";
      const parsedTitle = typeof json.title === "string" ? json.title.trim() : "";
      if (!parsedSummary) return null;
      return {
        summary: parsedSummary,
        title: parsedTitle || null,
      };
    },
  });
}

const ARC_PROMPT = `These are sequential scene summaries from a long roleplay. Compress them into ONE arc-level summary that tracks what changed across the sequence.

RULES
- Use past tense and third person.
- Focus on durable change across the arc: decisions, discoveries, relationship shifts, status changes, movement, gains/losses, and turning points.
- Preserve chronology and causal clarity when the source supports it.
- Omit scenic filler and details that do not matter later.
- Do NOT add interpretation, motives, themes, or unsupported links.
- Dense and factual: this summary replaces the individual scene summaries.

<summaries>
{{CONTENT}}
</summaries>

Return exactly one JSON object with this shape and no extra text:
{"title":"<3-8 word concrete arc title>","summary":"<arc-level factual summary>"}`;

async function generateArcSummary(
  combinedSummaries: string,
  generateRawFn: ConsolidationGenerateRawFn,
  connectionId: string,
  maxTokens: number,
  samplingParameters?: Record<string, unknown>,
  sidecarOptions?: ConsolidationSidecarOptions,
): Promise<MemorySummarizationDecision<{ summary: string; title: string | null }>> {
  return runMemorySummarizationSidecar({
    memorySummarization: sidecarOptions?.memorySummarization,
    sidecarReliability: sidecarOptions?.sidecarReliability,
    sidecarTimeoutMs: sidecarOptions?.sidecarTimeoutMs,
    sidecar: sidecarOptions?.sidecar,
    sidecarConnectionId: connectionId,
    signal: sidecarOptions?.signal,
    extract: async (target) => {
      const prompt = ARC_PROMPT
        .replace("{{CONTENT}}", combinedSummaries)
        .replace("{{MAX_TOKENS}}", String(maxTokens));

      const userParams = samplingParameters ?? { temperature: 0.1 };
      const response = await generateRawFn({
        connectionId: target.connectionProfileId,
        messages: [
          { role: "system", content: "You are a factual memory summarizer. Output one valid JSON object only. Omit anything not directly supported by the supplied summaries." },
          { role: "user", content: prompt },
        ],
        parameters: {
          ...userParams,
          max_tokens: maxTokens + 100,
          ...(target.model ? { model: target.model } : {}),
        },
        signal: target.signal,
      });

      if (target.signal?.aborted) return null;

      const json = extractJson(response.content);
      if (!json) return null;
      const parsedSummary = typeof json.summary === "string" ? json.summary.trim() : "";
      const parsedTitle = typeof json.title === "string" ? json.title.trim() : "";
      if (!parsedSummary) return null;
      return {
        summary: parsedSummary,
        title: parsedTitle || null,
      };
    },
  });
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

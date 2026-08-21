/**
 * Memory Cortex — Hierarchical memory consolidation.
 *
 * As chats grow, raw chunks accumulate. Consolidation compresses older chunks
 * into higher-level summaries:
 *
 *   Tier 1 (Consolidated): N raw chunks → 1 summary paragraph
 *   Tier 2 (Arc):          N consolidations → 1 arc summary
 *
 * Semantic consolidation requires a sidecar. Without one, source chunks stay
 * available as evidence rather than being mislabeled as a summary assembled
 * from verbatim sentences.
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
import type { ToolDefinition } from "../../llm/types";

export type ConsolidationGenerateRawFn = (opts: {
  connectionId: string;
  messages: Array<{ role: string; content: string }>;
  parameters: Record<string, any>;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}) => Promise<{
  content: string;
  tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
}>;

const inFlightConsolidations = new Map<string, Promise<boolean>>();

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
 * Called after chunk creation; semantic consolidation runs asynchronously.
 */
export function maybeConsolidate(
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
   *  feeding it to the consolidation LLM. */
  extraScaffoldTags?: string[],
  sidecarOptions?: ConsolidationSidecarOptions,
): Promise<boolean> {
  const existing = inFlightConsolidations.get(chatId);
  if (existing) return existing;

  const pending = runConsolidationCheck(
    userId,
    chatId,
    config,
    generateRawFn,
    sidecarConnectionId,
    sidecarTimeoutMs,
    samplingParameters,
    extraScaffoldTags,
    sidecarOptions,
  );
  inFlightConsolidations.set(chatId, pending);
  void pending.finally(() => {
    if (inFlightConsolidations.get(chatId) === pending) {
      inFlightConsolidations.delete(chatId);
    }
  }).catch(() => undefined);
  return pending;
}

async function runConsolidationCheck(
  userId: string,
  chatId: string,
  config: ConsolidationConfig,
  generateRawFn?: ConsolidationGenerateRawFn,
  sidecarConnectionId?: string,
  sidecarTimeoutMs?: number,
  samplingParameters?: Record<string, unknown>,
  extraScaffoldTags?: string[],
  sidecarOptions?: ConsolidationSidecarOptions,
): Promise<boolean> {
  if (!config.enabled) return false;

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

  if (!countRow || countRow.count < config.chunkThreshold) return false;

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
  if (batch.length === 0) return false;

  // A transcript excerpt is useful evidence, but it is not a scene summary.
  // Keep the chunks intact until a model is available to synthesize them.
  if (!(config.useSidecar && generateRawFn && (sidecarConnectionId || sidecarOptions?.sidecar?.connectionProfileId))) return false;

  let summary: string;
  let title: string | null = null;

  const resolvedSidecar = resolveConsolidationSidecarOptions(
    userId, sidecarConnectionId, sidecarTimeoutMs, sidecarOptions,
  );
  if (resolvedSidecar.signal?.aborted) return false;

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
      return false;
    }

    if (decision.result && !decision.useExtractive) {
      summary = decision.result.summary;
      title = decision.result.title;
    } else {
      console.warn("[memory-cortex] Consolidation sidecar exhausted, using extractive fallback");
      summary = extractiveConsolidation(batch, extraScaffoldTags);
      title = inferTitle(batch);
    }
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
    batch[0].message_range_start ?? 0,
    batch[batch.length - 1].message_range_end ?? 0,
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
  return true;
}

/**
 * Drain an existing chunk backlog after a rebuild. Rebuild ingestion uses
 * pre-computed extraction responses, so consolidation must run separately
 * with the real sidecar adapter after all chunks have been persisted.
 */
export async function consolidateBacklog(
  userId: string,
  chatId: string,
  config: ConsolidationConfig,
  generateRawFn?: ConsolidationGenerateRawFn,
  sidecarConnectionId?: string,
  sidecarTimeoutMs?: number,
  samplingParameters?: Record<string, unknown>,
  extraScaffoldTags?: string[],
  sidecarOptions?: ConsolidationSidecarOptions,
): Promise<number> {
  let created = 0;
  while (await maybeConsolidate(
    userId,
    chatId,
    config,
    generateRawFn,
    sidecarConnectionId,
    sidecarTimeoutMs,
    samplingParameters,
    extraScaffoldTags,
    sidecarOptions,
  )) {
    created++;
  }
  return created;
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

  // Arc summaries must synthesize scene changes. Joining scene text merely
  // creates a longer transcript, so defer until semantic generation is usable.
  if (!(config.useSidecar && generateRawFn && (sidecarConnectionId || sidecarOptions?.sidecar?.connectionProfileId))) return;

  let arcSummary: string;
  let arcTitle: string | null;

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

// ─── Generative Consolidation (Sidecar) ────────────────────────

const CONSOLIDATION_PROMPT = `Create a CONTINUITY NOTE, not a retelling or transcript of these roleplay passages.

First identify only the durable deltas: who acted, what changed, decisions or commitments, discoveries, relationship/status/location changes, gains/losses, and unresolved obligations. Then synthesize those deltas.

RULES
- Use past tense, third person, and names instead of vague pronouns.
- Merge repeated or related events into one outcome. Do not describe turn-by-turn dialogue or narration.
- Do not quote, imitate, or copy long phrases from the passages. Do not preserve scene-setting, banter, or action choreography unless it changed later continuity.
- Every statement must be directly supported by the passages. Do not infer motives, themes, symbolism, or unstated causality.
- The summary must be at most {{MAX_WORDS}} words and no more than 5 sentences.
- A bad summary says what each message said. A good summary says what is now true or different because of the scene.

<passages>
{{CONTENT}}
</passages>

Call the write_scene_continuity tool exactly once. Put the compressed note in summary and the durable deltas it synthesizes in changes.`;

const ARC_PROMPT = `Create a CONTINUITY NOTE for the full narrative arc, not a concatenation or recap of its scene summaries.

First identify the arc's beginning state, decisive turning points, durable end state, and unresolved threads. Then synthesize the net changes across the whole sequence.

RULES
- Use past tense, third person, and names instead of vague pronouns.
- Group related scenes into arc-level developments; do not list one sentence per scene.
- Do not quote, imitate, or copy long phrases from the input. Do not retell scene order unless it establishes a supported causal change.
- Preserve only decisions, discoveries, relationship/status/location changes, gains/losses, and unresolved obligations.
- Do not infer motives, themes, symbolism, or unstated causality.
- The summary must be at most {{MAX_WORDS}} words and no more than 7 sentences.
- A bad summary recounts scenes. A good summary explains what changed from the beginning of the arc to its current state.

<scene_summaries>
{{CONTENT}}
</scene_summaries>

Call the write_arc_continuity tool exactly once. Put the compressed note in summary, supported decisive changes in turning_points, and explicitly unresolved obligations in open_threads.`;

export type SummaryKind = "scene" | "arc";
type GeneratedSummary = { summary: string; title: string | null };

const SCENE_SUMMARY_TOOL: ToolDefinition = {
  name: "write_scene_continuity",
  description: "Write one compressed scene-level continuity note from the supplied passages. Report durable changes, not a transcript or turn-by-turn recap.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A concrete 3-6 word title for the scene.",
      },
      summary: {
        type: "string",
        description: "A compact past-tense continuity note stating only supported durable changes and unresolved obligations.",
      },
      changes: {
        type: "array",
        items: { type: "string" },
        description: "The durable state changes synthesized into the summary. Use an empty array if nothing changed.",
      },
    },
    required: ["title", "summary", "changes"],
  },
};

const ARC_SUMMARY_TOOL: ToolDefinition = {
  name: "write_arc_continuity",
  description: "Write one compressed arc-level continuity note that synthesizes net changes across scenes instead of concatenating scene recaps.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "A concrete 3-8 word title for the narrative arc.",
      },
      summary: {
        type: "string",
        description: "A compact past-tense note describing the arc's supported beginning-to-current state changes.",
      },
      turning_points: {
        type: "array",
        items: { type: "string" },
        description: "Decisive supported changes in the arc, without one item per scene.",
      },
      open_threads: {
        type: "array",
        items: { type: "string" },
        description: "Unresolved obligations or conflicts explicitly supported by the source.",
      },
    },
    required: ["title", "summary", "turning_points", "open_threads"],
  },
};

function summaryTool(kind: SummaryKind): ToolDefinition {
  return kind === "scene" ? SCENE_SUMMARY_TOOL : ARC_SUMMARY_TOOL;
}

function summaryWordBudget(kind: SummaryKind, maxTokens: number): number {
  const cap = kind === "scene" ? 120 : 180;
  return Math.max(40, Math.min(cap, Math.floor(maxTokens * 0.65)));
}

/** Return the reason a candidate should be retried, or null when it is compact enough. */
export function getSummaryQualityIssue(
  summary: string,
  source: string,
  maxWords: number,
): string | null {
  const summaryWords = summary.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  const sourceWords = source.trim().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
  if (summaryWords.length < 8) return "it is too short to preserve useful continuity";
  if (summaryWords.length > maxWords) return `it exceeds the ${maxWords}-word limit`;
  if (sourceWords.length >= maxWords * 2 && summaryWords.length / sourceWords.length > 0.45) {
    return "it does not compress the source enough";
  }

  // A weak model often emits source sentences unchanged. Flag sustained
  // seven-word overlap, while allowing names and short factual phrases.
  const normalize = (words: string[]) => words.map((word) => word.toLowerCase());
  const sourcePhrases = new Set<string>();
  const normalizedSource = normalize(sourceWords);
  for (let index = 0; index + 7 <= normalizedSource.length; index++) {
    sourcePhrases.add(normalizedSource.slice(index, index + 7).join(" "));
  }
  const normalizedSummary = normalize(summaryWords);
  let phraseCount = 0;
  let copiedPhrases = 0;
  for (let index = 0; index + 7 <= normalizedSummary.length; index++) {
    phraseCount++;
    if (sourcePhrases.has(normalizedSummary.slice(index, index + 7).join(" "))) copiedPhrases++;
  }
  if (copiedPhrases >= 2 && copiedPhrases / phraseCount >= 0.35) {
    return "it copies too much source wording instead of synthesizing changes";
  }
  return null;
}

function cleanSummaryResponse(content: string): string {
  let cleaned = content.trim();
  cleaned = cleaned.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, "");
  cleaned = cleaned.replace(/<(think|thinking|reasoning)>[\s\S]*$/gi, "");
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json|text)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return cleaned.trim();
}

export function parseGeneratedSummary(content: string): GeneratedSummary | null {
  const json = extractJson(content);
  if (json) {
    const summary = typeof json.summary === "string" ? json.summary.trim() : "";
    if (!summary) return null;
    return {
      summary,
      title: typeof json.title === "string" && json.title.trim() ? json.title.trim() : null,
    };
  }

  // JSON is preferred for titles and diagnostics, but many smaller or local
  // models produce a perfectly usable note as plain text. Treat that as a
  // candidate and let the semantic quality gate decide whether it needs retry.
  const plain = cleanSummaryResponse(content);
  if (!plain || /[{}]/.test(plain)) return null;
  const summary = plain
    .replace(/^(?:summary|continuity note)\s*:\s*/i, "")
    .trim();
  return summary ? { summary, title: null } : null;
}

export function parseGeneratedSummaryResponse(
  response: {
    content: string;
    tool_calls?: Array<{ name: string; args: Record<string, unknown> }>;
  },
  kind: SummaryKind,
): GeneratedSummary | null {
  const expectedName = summaryTool(kind).name;
  const call = response.tool_calls?.find((candidate) => candidate.name === expectedName);
  if (call) {
    const summary = typeof call.args.summary === "string" ? call.args.summary.trim() : "";
    if (!summary) return null;
    const title = typeof call.args.title === "string" && call.args.title.trim()
      ? call.args.title.trim()
      : null;
    return { summary, title };
  }
  return parseGeneratedSummary(response.content);
}

async function generateSemanticSummary(
  kind: SummaryKind,
  source: string,
  generateRawFn: ConsolidationGenerateRawFn,
  connectionId: string,
  maxTokens: number,
  samplingParameters: Record<string, unknown> | undefined,
): Promise<GeneratedSummary | null> {
  const maxWords = summaryWordBudget(kind, maxTokens);
  const template = kind === "scene" ? CONSOLIDATION_PROMPT : ARC_PROMPT;
  const prompt = template
    .replace("{{CONTENT}}", source)
    .replace("{{MAX_WORDS}}", String(maxWords));
  const tool = summaryTool(kind);
  const system = `You write compact continuity notes for roleplay memory. Call ${tool.name} exactly once. Never turn source passages into a transcript.`;
  const userParams = samplingParameters ?? { temperature: 0.1 };
  const parameters = { ...userParams, max_tokens: maxTokens + 100 };

  try {
    const first = await generateRawFn({
      connectionId,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      parameters,
      tools: [tool],
    });
    const firstCandidate = parseGeneratedSummaryResponse(first, kind);
    // No candidate usually means an incompatible provider response (often an
    // empty completion). Retrying that same transport shape immediately only
    // doubles the failure rate; the caller applies a short per-chat cooldown.
    if (!firstCandidate) return null;

    const firstIssue = getSummaryQualityIssue(firstCandidate.summary, source, maxWords);
    if (!firstIssue) return firstCandidate;

    // Spend one corrective retry only when the model did return a note but it
    // was too long or transcript-like. That is a prompt-following problem the
    // correction can realistically solve.
    const correction = firstIssue;
    const retry = await generateRawFn({
      connectionId,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${prompt}\n\nYour previous attempt was rejected because ${correction}. Call ${tool.name} exactly once with a shorter synthesis of durable changes; do not retell or quote the source.` },
      ],
      parameters,
      tools: [tool],
    });
    const retryCandidate = parseGeneratedSummaryResponse(retry, kind);
    const retryIssue = retryCandidate && getSummaryQualityIssue(retryCandidate.summary, source, maxWords);
    if (retryCandidate && !retryIssue) return retryCandidate;
  } catch (err) {
    console.warn(`[memory-cortex] Generative ${kind} consolidation failed:`, err);
  }
  return null;
}

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

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

function extractJson(text: string): any | null {
  try {
    const cleaned = cleanSummaryResponse(text);
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

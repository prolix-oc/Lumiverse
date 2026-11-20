import { getDb } from "../../db/connection";
import type { Message } from "../../types/message";
import type { MemoryCortexConfig } from "./config";
import { getConsolidations, getLatestArc } from "./consolidation";

export interface CortexHistoryReplacement {
  consolidationId: string;
  tier: number;
  content: string;
}

export interface CortexHistoryPlan {
  /** All source messages are omitted, except endpoints carrying a replacement. */
  replacedMessageIds: Set<string>;
  replacements: Map<string, CortexHistoryReplacement>;
  suppressArcContext: boolean;
}

/** Apply the user's history limit to original messages, before compression. */
export function selectCortexHistoryMessages(
  messages: Message[],
  settings?: { messageLimitEnabled?: boolean; messageLimitCount?: number },
  anchorIndex?: number,
): Message[] {
  if (!settings?.messageLimitEnabled || !(Number(settings.messageLimitCount) > 0)) return messages;
  const requestedStart = Math.max(0, messages.length - Math.floor(settings.messageLimitCount!));
  const anchorStart = anchorIndex == null ? -1 : messages.findIndex((m) => m.index_in_chat >= anchorIndex);
  return messages.slice(anchorStart >= 0 ? Math.min(requestedStart, anchorStart) : requestedStart);
}

function parseIds(raw: string): string[] | null {
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string" && id.length > 0)
      ? ids : null;
  } catch { return null; }
}

/** Prompt-only compression. Resolve actual message IDs, never the legacy numeric
 * ranges (some older consolidations stored timestamps in those columns).
 * Fail closed on missing, hidden, excluded, clipped, or noncontiguous evidence.
 * Saved chat messages and the ingestion pipeline never see these summaries. */
export function buildCortexHistoryPlan(
  chatId: string,
  messages: Message[],
  config: MemoryCortexConfig,
  anchorIndex?: number,
  protectedMessageId?: string,
): CortexHistoryPlan {
  const plan: CortexHistoryPlan = {
    replacedMessageIds: new Set(), replacements: new Map(), suppressArcContext: config.replaceArcSummariesInContext,
  };
  if (!config.replaceConsolidatedMessagesInContext && !config.replaceArcSummariesInContext) return plan;
  // The anchor is a hard history start. Earlier turns will be clipped, and
  // every turn from the anchor onward is explicitly protected verbatim.
  if (anchorIndex != null) return plan;
  const summaries = getConsolidations(chatId);
  if (!summaries.length) return plan;
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const chunkRows = getDb().query(
    "SELECT id, message_ids, consolidation_id FROM chat_chunks WHERE chat_id = ?",
  ).all(chatId) as Array<{ id: string; message_ids: string; consolidation_id: string | null }>;
  const chunks = new Map(chunkRows.map((c) => [c.id, parseIds(c.message_ids)]));
  const linkedChunks = new Map<string, string[]>();
  for (const chunk of chunkRows) {
    if (!chunk.consolidation_id) continue;
    const ids = linkedChunks.get(chunk.consolidation_id) ?? [];
    ids.push(chunk.id);
    linkedChunks.set(chunk.consolidation_id, ids);
  }
  const visible = messages.filter((m) => m.extra?.hidden !== true);
  const positions = new Map(visible.map((m, i) => [m.id, i]));

  const resolveSources = (id: string): Set<string> | null => {
    const summary = byId.get(id);
    if (!summary) return null;
    const result = new Set<string>();
    if (summary.tier === 1) {
      if (!Array.isArray(summary.sourceChunkIds) || !summary.sourceChunkIds.length) return null;
      if ((linkedChunks.get(id) ?? []).some((chunkId) => !summary.sourceChunkIds.includes(chunkId))) return null;
      for (const chunkId of summary.sourceChunkIds) {
        const ids = chunks.get(chunkId);
        if (!ids) return null;
        for (const messageId of ids) result.add(messageId);
      }
    } else if (summary.tier === 2) {
      if (!Array.isArray(summary.sourceConsolidationIds) || !summary.sourceConsolidationIds.length) return null;
      for (const sceneId of summary.sourceConsolidationIds) {
        // Arcs consist of scenes only. This also rejects cycles in imported data.
        if (byId.get(sceneId)?.tier !== 1) return null;
        const ids = resolveSources(sceneId);
        if (!ids) return null;
        for (const messageId of ids) result.add(messageId);
      }
    } else return null;
    return result.size ? result : null;
  };

  const candidates = summaries.flatMap((summary) => {
    if (!(summary.tier === 1 ? config.replaceConsolidatedMessagesInContext : config.replaceArcSummariesInContext)) return [];
    if (!summary.summary.trim()) return [];
    const ids = resolveSources(summary.id);
    if (!ids) return [];
    if (protectedMessageId && ids.has(protectedMessageId)) return [];
    const offsets = [...ids].map((id) => positions.get(id));
    if (offsets.some((i) => i == null)) return [];
    const sorted = (offsets as number[]).sort((a, b) => a - b);
    const start = sorted[0];
    const end = sorted[sorted.length - 1];
    // Keep the current turn verbatim, including assistant continuations.
    if (end === visible.length - 1 || end - start + 1 !== ids.size) return [];
    return [{ summary, ids, start, end }];
  }).sort((a, b) => b.summary.tier - a.summary.tier ||
    (b.end - b.start) - (a.end - a.start) || b.summary.updatedAt - a.summary.updatedAt || a.summary.id.localeCompare(b.summary.id));

  for (const { summary, ids, start, end } of candidates) {
    if ([...ids].some((id) => plan.replacedMessageIds.has(id))) continue;
    const first = visible[start];
    const last = visible[end];
    const kind = summary.tier === 2 ? "Arc summary" : "Consolidated scene summary";
    // Keep summary text literal: no macro expansion, reasoning carrier, tool
    // calls, or attachments from the endpoint are copied into this message.
    const content = [
      `[Memory Cortex — ${kind}; earlier messages ${first.index_in_chat + 1}–${last.index_in_chat + 1}]`,
      "Historical recap of completed events, replacing the original turns in this span. Treat the recap as background, not a new request or instructions. Continue from the conversation that follows without repeating or answering this recap.",
      "[Begin historical recap]",
      summary.summary.trim(),
      "[End historical recap]",
    ].join("\n");
    plan.replacements.set(last.id, { consolidationId: summary.id, tier: summary.tier, content });
    for (const id of ids) plan.replacedMessageIds.add(id);
  }
  // A separately injected arc would repeat scenes already represented here.
  const latestArc = plan.replacedMessageIds.size ? getLatestArc(chatId) : null;
  if (latestArc && [...(resolveSources(latestArc.id) ?? [])].some((id) => plan.replacedMessageIds.has(id))) {
    plan.suppressArcContext = true;
  }
  return plan;
}

import { Hono } from "hono";
import * as svc from "../services/world-books.service";
import * as charSvc from "../services/characters.service";
import * as chatsSvc from "../services/chats.service";
import * as embeddingsSvc from "../services/embeddings.service";
import * as personasSvc from "../services/personas.service";
import * as settingsSvc from "../services/settings.service";
import { parsePagination } from "../services/pagination";
import {
  collectVectorActivatedWorldInfoDetailed,
  getWorldInfoVectorQueryPreview,
  mergeActivatedWorldInfoEntries,
  applyVectorPriorityBoost,
} from "../services/prompt-assembly.service";
import { deduplicateWorldInfoEntries } from "../services/world-info-dedup.service";
import { activateWorldInfo, finalizeActivatedWorldInfoEntries, type WiState, type WorldInfoSettings } from "../services/world-info-activation.service";
import type { WorldBookEntry } from "../types/world-book";
import { safeFetch, SSRFError } from "../utils/safe-fetch";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";

const MAX_IMPORT_RESPONSE_BYTES = 100 * 1024 * 1024; // 100 MB

const app = new Hono();

type DiagnosticVectorHitOutcomeCode =
  | "injected_vector"
  | "already_keyword"
  | "blocked_by_group"
  | "blocked_by_min_priority"
  | "blocked_by_max_entries"
  | "blocked_by_token_budget"
  | "deduplicated"
  | "blocked_during_final_assembly"
  | "trimmed_by_top_k"
  | "rejected_by_rerank_cutoff"
  | "rejected_by_similarity_threshold";

interface DiagnosticVectorHitOutcome {
  code: DiagnosticVectorHitOutcomeCode;
  label: string;
  reason: string;
}

type VectorHitEntry = Awaited<ReturnType<typeof collectVectorActivatedWorldInfoDetailed>>["candidateTrace"][number];
type VectorTraceEntry = Awaited<ReturnType<typeof collectVectorActivatedWorldInfoDetailed>>["candidateTrace"][number];

function formatDiagnosticMetric(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "0.000";
}

function buildRerankLead(options: {
  rerankRank?: number | null;
  finalScore?: number | null;
  distance?: number | null;
}): string {
  const score = typeof options.finalScore === "number" && Number.isFinite(options.finalScore)
    ? `rerank ${formatDiagnosticMetric(options.finalScore)}`
    : null;
  const distance = typeof options.distance === "number" && Number.isFinite(options.distance)
    ? `distance ${formatDiagnosticMetric(options.distance)}`
    : null;
  const metrics = [score, distance].filter((value): value is string => Boolean(value));
  const metricText = metrics.length > 0 ? ` (${metrics.join(", ")})` : "";
  if (typeof options.rerankRank === "number" && Number.isFinite(options.rerankRank)) {
    return `It ranked #${options.rerankRank} after reranking${metricText}.`;
  }
  return `This candidate was pulled from vector search${metricText}.`;
}

function getWorldInfoGroupKey(entry: WorldBookEntry): string | null {
  const groupName = typeof entry.group_name === "string" ? entry.group_name.trim() : "";
  return groupName ? groupName.toLowerCase() : null;
}

function buildDiagnosticVectorOutcome(
  code: DiagnosticVectorHitOutcomeCode,
  options: {
    entry?: WorldBookEntry;
    maxActivatedEntries?: number;
    minPriority?: number;
    conflictingEntry?: WorldBookEntry;
    conflictingSource?: "keyword" | "vector";
    keptEntryComment?: string;
    dedupTier?: "exact" | "near-exact" | "fuzzy";
    rerankRank?: number | null;
    finalScore?: number | null;
    distance?: number | null;
    topK?: number;
    rerankCutoff?: number;
    similarityThreshold?: number;
  } = {},
): DiagnosticVectorHitOutcome {
  const rerankLead = buildRerankLead({
    rerankRank: options.rerankRank,
    finalScore: options.finalScore,
    distance: options.distance,
  });
  switch (code) {
    case "injected_vector":
      return {
        code,
        label: "Made final prompt",
        reason: `${rerankLead} It survived final prompt assembly as a vector-activated entry.`,
      };
    case "already_keyword":
      return {
        code,
        label: "Already keyword-active",
        reason: `${rerankLead} The same entry was already activated by keyword logic, so vector retrieval did not add a second copy.`,
      };
    case "blocked_by_group": {
      const conflicting = options.conflictingEntry?.comment?.trim() || "another entry";
      const source = options.conflictingSource === "vector" ? "another vector hit" : "keyword activation";
      const groupName = options.entry?.group_name?.trim() || "this mutually exclusive group";
      return {
        code,
        label: "Blocked by group rule",
        reason: `${rerankLead} ${groupName} was already occupied by "${conflicting}" via ${source}.`,
      };
    }
    case "blocked_by_min_priority":
      return {
        code,
        label: "Below minimum priority",
        reason: `${rerankLead} Its priority (${options.entry?.priority ?? 0}) is below the current World Info minimum priority (${options.minPriority ?? 0}).`,
      };
    case "blocked_by_max_entries":
      return {
        code,
        label: "No room under entry cap",
        reason: `${rerankLead} The final World Info list had already reached the ${options.maxActivatedEntries ?? 0}-entry cap before this entry could be added.`,
      };
    case "blocked_by_token_budget":
      return {
        code,
        label: "No room under token budget",
        reason: `${rerankLead} Adding it would have pushed the World Info prompt past the current token budget, so earlier entries kept the room.`,
      };
    case "deduplicated": {
      const kept = options.keptEntryComment?.trim() || "another entry";
      const tier = options.dedupTier === "exact"
        ? "exact duplicate"
        : options.dedupTier === "near-exact"
          ? "near-exact duplicate"
          : "fuzzy duplicate";
      return {
        code,
        label: "Removed as duplicate",
        reason: `${rerankLead} It initially made the merged set, but it was removed as a ${tier} of "${kept}".`,
      };
    }
    case "trimmed_by_top_k":
      return {
        code,
        label: "Outside returned top-k",
        reason: `${rerankLead} It cleared the rerank cutoff, but only the top ${options.topK ?? 0} reranked candidates are kept in the shortlist shown here.`,
      };
    case "rejected_by_rerank_cutoff":
      return {
        code,
        label: "Below rerank cutoff",
        reason: `It was pulled from vector search (rerank ${formatDiagnosticMetric(options.finalScore)}, distance ${formatDiagnosticMetric(options.distance)}), but the rerank score stayed below the current cutoff (${formatDiagnosticMetric(options.rerankCutoff)}).`,
      };
    case "rejected_by_similarity_threshold":
      return {
        code,
        label: "Above similarity threshold",
        reason: `It was pulled from vector search at distance ${formatDiagnosticMetric(options.distance)}, but that exceeded the current similarity threshold (${formatDiagnosticMetric(options.similarityThreshold)}), so reranking never got a chance to keep it.`,
      };
    case "blocked_during_final_assembly":
    default:
      return {
        code: "blocked_during_final_assembly",
        label: "Lost during final assembly",
        reason: `${rerankLead} Later prompt-assembly rules still left no room for it in the final World Info list.`,
      };
  }
}

function traceDiagnosticVectorHitOutcomes(
  keywordEntries: WorldBookEntry[],
  vectorEntries: VectorHitEntry[],
  settingsInput?: Partial<WorldInfoSettings>,
): Map<string, DiagnosticVectorHitOutcome> {
  const settings: WorldInfoSettings = {
    globalScanDepth: null,
    maxRecursionPasses: 0,
    maxActivatedEntries: 50,
    maxTokenBudget: 0,
    minPriority: 0,
    ...settingsInput,
  };
  const mergedEntries: WorldBookEntry[] = [];
  const sources = new Map<string, { source: "keyword" | "vector"; score?: number }>();
  const seen = new Set<string>();
  const occupiedGroups = new Map<string, { entry: WorldBookEntry; source: "keyword" | "vector" }>();
  const outcomes = new Map<string, DiagnosticVectorHitOutcome>();
  const maxActivatedTarget = settings.maxActivatedEntries > 0
    ? settings.maxActivatedEntries
    : Number.POSITIVE_INFINITY;

  for (const entry of keywordEntries) {
    if (seen.has(entry.id)) continue;
    mergedEntries.push(entry);
    seen.add(entry.id);
    sources.set(entry.id, { source: "keyword" });
    const groupKey = getWorldInfoGroupKey(entry);
    if (groupKey) occupiedGroups.set(groupKey, { entry, source: "keyword" });
  }

  let finalized = finalizeActivatedWorldInfoEntries(mergedEntries, settings, {
    skipGroupLogic: true,
    preserveOrder: true,
  });

  for (const item of vectorEntries) {
    if (seen.has(item.entry.id)) {
      outcomes.set(item.entry.id, buildDiagnosticVectorOutcome("already_keyword", {
        entry: item.entry,
        rerankRank: item.rerankRank,
        finalScore: item.finalScore,
        distance: item.distance,
      }));
      continue;
    }

    if (settings.minPriority > 0 && item.entry.priority < settings.minPriority && !item.entry.constant) {
      outcomes.set(item.entry.id, buildDiagnosticVectorOutcome("blocked_by_min_priority", {
        entry: item.entry,
        minPriority: settings.minPriority,
        rerankRank: item.rerankRank,
        finalScore: item.finalScore,
        distance: item.distance,
      }));
      continue;
    }

    const groupKey = getWorldInfoGroupKey(item.entry);
    if (groupKey) {
      const occupied = occupiedGroups.get(groupKey);
      if (occupied) {
        outcomes.set(item.entry.id, buildDiagnosticVectorOutcome("blocked_by_group", {
          entry: item.entry,
          conflictingEntry: occupied.entry,
          conflictingSource: occupied.source,
          rerankRank: item.rerankRank,
          finalScore: item.finalScore,
          distance: item.distance,
        }));
        continue;
      }
    }

    // Mirror prompt-assembly's merge: when the cap is full, apply a bounded
    // score-derived priority boost to vector entries so they can compete on
    // retrieval relevance instead of losing the order_value tiebreaker. See
    // `applyVectorPriorityBoost` in prompt-assembly.service.ts.
    const budgetFull = finalized.activatedEntries.length >= maxActivatedTarget;
    const nextMergedEntries = [...mergedEntries, item.entry];
    const finalizeInput = budgetFull
      ? applyVectorPriorityBoost(nextMergedEntries, sources, item)
      : nextMergedEntries;
    const rawNextFinalized = finalizeActivatedWorldInfoEntries(finalizeInput, settings, {
      skipGroupLogic: true,
      preserveOrder: !budgetFull,
    });
    const nextFinalized = budgetFull
      ? {
          ...rawNextFinalized,
          activatedEntries: rawNextFinalized.activatedEntries
            .map((e) => nextMergedEntries.find((orig) => orig.id === e.id))
            .filter((e): e is WorldBookEntry => !!e),
        }
      : rawNextFinalized;
    const itemSurvived = nextFinalized.activatedEntries.some((entry) => entry.id === item.entry.id);
    const grewActivationSet = nextFinalized.activatedEntries.length > finalized.activatedEntries.length;

    if (!itemSurvived) {
      outcomes.set(item.entry.id, buildDiagnosticVectorOutcome(
        budgetFull
          ? "blocked_by_max_entries"
          : settings.maxTokenBudget > 0 ? "blocked_by_token_budget" : "blocked_during_final_assembly",
        {
          maxActivatedEntries: settings.maxActivatedEntries,
          rerankRank: item.rerankRank,
          finalScore: item.finalScore,
          distance: item.distance,
        },
      ));
      continue;
    }
    if (!budgetFull && !grewActivationSet && !item.entry.constant) {
      outcomes.set(item.entry.id, buildDiagnosticVectorOutcome(
        settings.maxTokenBudget > 0 ? "blocked_by_token_budget" : "blocked_during_final_assembly",
        {
          rerankRank: item.rerankRank,
          finalScore: item.finalScore,
          distance: item.distance,
        },
      ));
      continue;
    }

    mergedEntries.push(item.entry);
    seen.add(item.entry.id);
    sources.set(item.entry.id, { source: "vector", score: item.finalScore });
    if (groupKey) occupiedGroups.set(groupKey, { entry: item.entry, source: "vector" });
    finalized = nextFinalized;
    outcomes.set(item.entry.id, buildDiagnosticVectorOutcome("injected_vector", {
      rerankRank: item.rerankRank,
      finalScore: item.finalScore,
      distance: item.distance,
    }));
  }

  const dedupResult = deduplicateWorldInfoEntries(mergedEntries, sources);
  for (const removed of dedupResult.removed) {
    if (!outcomes.has(removed.removedEntryId)) continue;
    outcomes.set(removed.removedEntryId, buildDiagnosticVectorOutcome("deduplicated", {
      keptEntryComment: removed.keptEntryComment,
      dedupTier: removed.tier,
    }));
  }

  return outcomes;
}

function resolveDiagnosticVectorTraceOutcome(
  item: VectorTraceEntry,
  shortlistedOutcomes: Map<string, DiagnosticVectorHitOutcome>,
  options: {
    topK: number;
    rerankCutoff: number;
    similarityThreshold: number;
  },
): DiagnosticVectorHitOutcome {
  if (item.retrievalStage === "rejected_by_similarity_threshold") {
    return buildDiagnosticVectorOutcome("rejected_by_similarity_threshold", {
      entry: item.entry,
      distance: item.distance,
      similarityThreshold: options.similarityThreshold,
    });
  }

  if (item.retrievalStage === "rejected_by_rerank_cutoff") {
    return buildDiagnosticVectorOutcome("rejected_by_rerank_cutoff", {
      entry: item.entry,
      distance: item.distance,
      finalScore: item.finalScore,
      rerankCutoff: options.rerankCutoff,
    });
  }

  if (item.retrievalStage === "trimmed_by_top_k") {
    return buildDiagnosticVectorOutcome("trimmed_by_top_k", {
      entry: item.entry,
      rerankRank: item.rerankRank,
      finalScore: item.finalScore,
      distance: item.distance,
      topK: options.topK,
    });
  }

  return shortlistedOutcomes.get(item.entry.id) ?? buildDiagnosticVectorOutcome("blocked_during_final_assembly", {
    entry: item.entry,
    rerankRank: item.rerankRank,
    finalScore: item.finalScore,
    distance: item.distance,
  });
}

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listWorldBooks(userId, pagination));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  return c.json(svc.createWorldBook(userId, body), 201);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const book = svc.getWorldBook(userId, c.req.param("id"));
  if (!book) return c.json({ error: "Not found" }, 404);
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const entries = svc.listEntriesPaginated(userId, book.id, pagination);
  return c.json({ ...book, entries });
});

app.get("/:id/export", (c) => {
  const userId = c.get("userId");
  const format = (c.req.query("format") || "lumiverse") as svc.WorldBookExportFormat;
  const validFormats: svc.WorldBookExportFormat[] = ["lumiverse", "character_book", "sillytavern"];
  if (!validFormats.includes(format)) {
    return c.json({ error: `Invalid format. Must be one of: ${validFormats.join(", ")}` }, 400);
  }
  const result = svc.exportWorldBook(userId, c.req.param("id"), format);
  if (!result) return c.json({ error: "Not found" }, 404);
  return c.json(result);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const book = svc.updateWorldBook(userId, c.req.param("id"), body);
  if (!book) return c.json({ error: "Not found" }, 404);
  return c.json(book);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteWorldBook(userId, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/:id/vector-summary", (c) => {
  const userId = c.get("userId");
  const summary = svc.getWorldBookVectorSummary(userId, c.req.param("id"));
  if (!summary) return c.json({ error: "World book not found" }, 404);
  return c.json(summary);
});

app.post("/:id/semantic-activation", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ enabled?: boolean }>().catch(() => ({} as { enabled?: boolean }));
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }
  const result = svc.setWorldBookSemanticActivation(userId, c.req.param("id"), body.enabled);
  if (!result) return c.json({ error: "World book not found" }, 404);
  return c.json(result);
});

app.get("/:id/convert-to-vectorized/preview", (c) => {
  const userId = c.get("userId");
  const preview = svc.getConvertToVectorizedPreview(userId, c.req.param("id"));
  if (!preview) return c.json({ error: "World book not found" }, 404);
  return c.json(preview);
});

app.post("/:id/convert-to-vectorized", (c) => {
  const userId = c.get("userId");
  const result = svc.convertToVectorized(userId, c.req.param("id"));
  if (!result) return c.json({ error: "World book not found" }, 404);
  return c.json(result);
});

app.post("/:id/diagnostics", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  const body = await c.req.json<{ chatId?: string }>().catch(() => ({} as { chatId?: string }));
  if (!body.chatId) return c.json({ error: "chatId is required" }, 400);

  const book = svc.getWorldBook(userId, bookId);
  if (!book) return c.json({ error: "World book not found" }, 404);

  const chat = chatsSvc.getChat(userId, body.chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const character = charSvc.getCharacter(userId, chat.character_id);
  if (!character) return c.json({ error: "Character not found" }, 404);

  const persona = personasSvc.resolvePersonaOrDefault(userId);
  const globalWorldBooks = (settingsSvc.getSetting(userId, "globalWorldBooks")?.value as string[] | undefined) ?? [];
  const chatWorldBookIds = (chat.metadata?.chat_world_book_ids as string[] | undefined) ?? [];
  const messages = chatsSvc.getMessages(userId, chat.id);
  const vectorSummary = svc.getWorldBookVectorSummary(userId, bookId)!;
  const bookEntries = svc.listEntries(userId, bookId);
  const attachmentSources = {
    character: getCharacterWorldBookIds(character.extensions).includes(bookId),
    persona: persona?.attached_world_book_id === bookId,
    global: globalWorldBooks.includes(bookId),
    chat: chatWorldBookIds.includes(bookId),
  };
  const isAttached = attachmentSources.character || attachmentSources.persona || attachmentSources.global || attachmentSources.chat;

  const embeddings = await embeddingsSvc.getEmbeddingConfig(userId);
  const queryPreview = await getWorldInfoVectorQueryPreview(userId, messages);
  const blockerMessages: string[] = [];

  if (!isAttached) {
    blockerMessages.push("This world book is not attached to the current character, active persona, global world books, or this chat's world books.");
  }

  const worldInfoSettings = (settingsSvc.getSetting(userId, "worldInfoSettings")?.value as Partial<WorldInfoSettings> | undefined) ?? {};
  const wiState: WiState = (chat.metadata?.wi_state as WiState) ?? {};

  const wiResult = isAttached
    ? activateWorldInfo({
        entries: bookEntries,
        messages,
        chatTurn: messages.length,
        wiState: JSON.parse(JSON.stringify(wiState)),
        settings: worldInfoSettings,
      })
    : activateWorldInfo({
        entries: [],
        messages,
        chatTurn: messages.length,
        wiState: {},
        settings: worldInfoSettings,
      });

  const vectorDetail = isAttached
    ? await collectVectorActivatedWorldInfoDetailed(userId, [bookId], bookEntries, messages)
      : {
        entries: [],
        candidateTrace: [],
        queryPreview,
        eligibleCount: 0,
        hitsBeforeThreshold: 0,
        hitsAfterThreshold: 0,
        thresholdRejected: 0,
        hitsAfterRerankCutoff: 0,
        rerankRejected: 0,
        topK: Math.max(1, embeddings.retrieval_top_k || 4),
        cap: Math.max(1, embeddings.retrieval_top_k || 4),
        blockerMessages: [] as string[],
      };

  blockerMessages.push(...vectorDetail.blockerMessages);

  const mergedWorldInfo = mergeActivatedWorldInfoEntries(
    wiResult.activatedEntries,
    vectorDetail.entries,
    worldInfoSettings,
  );
  const vectorHitOutcomes = traceDiagnosticVectorHitOutcomes(
    wiResult.activatedEntries,
    vectorDetail.candidateTrace.filter((item) => item.retrievalStage === "shortlisted"),
    worldInfoSettings,
  );
  const vectorTrace = vectorDetail.candidateTrace.map((item) => {
    const outcome = resolveDiagnosticVectorTraceOutcome(item, vectorHitOutcomes, {
      topK: vectorDetail.topK,
      rerankCutoff: embeddings.rerank_cutoff,
      similarityThreshold: embeddings.similarity_threshold,
    });
    return {
      entry_id: item.entry.id,
      comment: item.entry.comment || "",
      score: item.score,
      distance: item.distance,
      final_score: item.finalScore,
      lexical_candidate_score: item.lexicalCandidateScore,
      matched_primary_keys: item.matchedPrimaryKeys,
      matched_secondary_keys: item.matchedSecondaryKeys,
      matched_comment: item.matchedComment,
      score_breakdown: item.scoreBreakdown,
      search_text_preview: item.searchTextPreview,
      rerank_rank: item.rerankRank,
      final_outcome_code: outcome.code,
      final_outcome_label: outcome.label,
      final_outcome_reason: outcome.reason,
    };
  });

  const keywordHits = mergedWorldInfo.activatedWorldInfo
    .filter((entry) => entry.source === "keyword")
    .map((entry) => ({
      entry_id: entry.id,
      comment: entry.comment || "",
    }));
  const keywordHitIds = new Set(keywordHits.map((entry) => entry.entry_id));
  const vectorKeywordOverlapCount = vectorDetail.entries.reduce(
    (count, item) => count + (keywordHitIds.has(item.entry.id) ? 1 : 0),
    0,
  );
  const displacedFreshVectorHits = vectorDetail.entries.filter((item) => {
    if (keywordHitIds.has(item.entry.id)) return false;
    const outcome = vectorHitOutcomes.get(item.entry.id);
    return outcome?.code !== "injected_vector";
  });

  if (vectorDetail.thresholdRejected > 0 && vectorDetail.entries.length === 0) {
    blockerMessages.push("Vector matches were found, but all of them were rejected by the current similarity threshold.");
  }

  if (vectorDetail.rerankRejected > 0 && vectorDetail.entries.length === 0) {
    blockerMessages.push("Vector matches survived raw similarity filtering, but all of them were rejected by the current rerank cutoff.");
  }

  if (worldInfoSettings.minPriority && worldInfoSettings.minPriority > 0) {
    const belowMinPriority = bookEntries.some((entry) => !entry.disabled && !entry.constant && entry.priority < worldInfoSettings.minPriority!);
    if (belowMinPriority && mergedWorldInfo.totalActivated === 0) {
      blockerMessages.push("Entry priority is below the current World Info minimum priority setting.");
    }
  }

  if (
    mergedWorldInfo.evictedByBudget > 0 &&
    mergedWorldInfo.totalActivated === 0 &&
    bookEntries.some((entry) => !entry.disabled && (entry.content || "").trim().length > 0)
  ) {
    blockerMessages.push("World Info budget limits may be crowding this book out of the final prompt.");
  }

  if (
    vectorDetail.entries.length > 0 &&
    mergedWorldInfo.vectorActivated === 0 &&
    mergedWorldInfo.evictedByBudget > 0
  ) {
    blockerMessages.push("Vector matches were found, but the World Info max-activated or token budget limits left no room for them after keyword activation.");
  }

  if (
    vectorDetail.entries.length > 0 &&
    mergedWorldInfo.vectorActivated === 0 &&
    mergedWorldInfo.totalActivated === 0
  ) {
    blockerMessages.push("Vector candidates were found, but they lost to group, minimum-priority, or budget rules before final injection.");
  }

  if (
    vectorDetail.entries.length > 0 &&
    mergedWorldInfo.vectorActivated === 0 &&
    keywordHits.length > 0 &&
    mergedWorldInfo.evictedByBudget === 0 &&
    vectorKeywordOverlapCount === vectorDetail.entries.length
  ) {
    blockerMessages.push("Vector matches were found, but the top vector hits were already activated by keyword, so the final list still counts them as keyword entries.");
  }

  if (mergedWorldInfo.deduplicationDetails.some(d => d.removedEntryBookId === bookId)) {
    const dedupCount = mergedWorldInfo.deduplicationDetails.filter(d => d.removedEntryBookId === bookId).length;
    blockerMessages.push(`${dedupCount} entry/entries from this book were removed as content duplicates of entries from other books.`);
  }

  if (displacedFreshVectorHits.length > 0) {
    const grouped = new Map<string, { outcome: DiagnosticVectorHitOutcome; count: number }>();
    for (const item of displacedFreshVectorHits) {
      const outcome = vectorHitOutcomes.get(item.entry.id);
      if (!outcome) continue;
      const existing = grouped.get(outcome.code);
      if (existing) existing.count += 1;
      else grouped.set(outcome.code, { outcome, count: 1 });
    }
    for (const { outcome, count } of grouped.values()) {
      blockerMessages.push(`${count} fresh vector candidate${count === 1 ? "" : "s"}: ${outcome.reason}`);
    }
  }

  return c.json({
    book_id: bookId,
    chat_id: chat.id,
    attachment_sources: attachmentSources,
    embeddings: {
      enabled: embeddings.enabled,
      has_api_key: embeddings.has_api_key,
      dimensions: embeddings.dimensions,
      vectorize_world_books: embeddings.vectorize_world_books,
      similarity_threshold: embeddings.similarity_threshold,
      rerank_cutoff: embeddings.rerank_cutoff,
      ready: embeddings.enabled && embeddings.has_api_key && !!embeddings.dimensions && embeddings.vectorize_world_books,
    },
    vector_summary: vectorSummary,
    query_preview: vectorDetail.queryPreview || queryPreview,
    eligible_entries: vectorDetail.eligibleCount,
    retrieval: {
      top_k: vectorDetail.topK,
      hits_before_threshold: vectorDetail.hitsBeforeThreshold,
      hits_after_threshold: vectorDetail.hitsAfterThreshold,
      threshold_rejected: vectorDetail.thresholdRejected,
      hits_after_rerank_cutoff: vectorDetail.hitsAfterRerankCutoff,
      rerank_rejected: vectorDetail.rerankRejected,
    },
    keyword_hits: keywordHits,
    vector_hits: vectorTrace.filter((item) =>
      item.final_outcome_code !== "rejected_by_similarity_threshold" &&
      item.final_outcome_code !== "rejected_by_rerank_cutoff" &&
      item.final_outcome_code !== "trimmed_by_top_k"
    ),
    vector_trace: vectorTrace,
    blocker_messages: Array.from(new Set(blockerMessages)),
    deduplication: mergedWorldInfo.deduplicated > 0 ? {
      removed_count: mergedWorldInfo.deduplicated,
      removed: mergedWorldInfo.deduplicationDetails.map(d => ({
        removed_entry_id: d.removedEntryId,
        removed_entry_comment: d.removedEntryComment,
        kept_entry_id: d.keptEntryId,
        kept_entry_comment: d.keptEntryComment,
        tier: d.tier,
        similarity: d.similarity,
      })),
    } : undefined,
    stats: {
      ...wiResult.stats,
      activatedBeforeBudget: mergedWorldInfo.activatedBeforeBudget,
      activatedAfterBudget: mergedWorldInfo.activatedAfterBudget,
      evictedByBudget: mergedWorldInfo.evictedByBudget,
      estimatedTokens: mergedWorldInfo.estimatedTokens,
      keywordActivated: mergedWorldInfo.keywordActivated,
      vectorActivated: mergedWorldInfo.vectorActivated,
      totalActivated: mergedWorldInfo.totalActivated,
      deduplicated: mergedWorldInfo.deduplicated,
      queryPreview: vectorDetail.queryPreview || queryPreview,
    },
  });
});

// --- World Book Import ---

app.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const result = svc.importWorldBook(userId, body);
    return c.json({ world_book: result.worldBook, entry_count: result.entryCount }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 400);
  }
});

app.post("/import-url", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.url) return c.json({ error: "url is required" }, 400);

  let payload: any;
  try {
    const res = await safeFetch(body.url, {
      maxBytes: MAX_IMPORT_RESPONSE_BYTES,
      timeoutMs: 10_000,
    });
    if (!res.ok) return c.json({ error: `Failed to fetch URL: ${res.status}` }, 400);

    const text = await res.text();
    if (text.length > MAX_IMPORT_RESPONSE_BYTES) {
      return c.json({ error: "Response too large" }, 400);
    }
    payload = JSON.parse(text);
  } catch (err: any) {
    if (err instanceof SSRFError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: "Failed to fetch or parse URL" }, 400);
  }

  try {
    const result = svc.importWorldBook(userId, payload);
    return c.json({ world_book: result.worldBook, entry_count: result.entryCount }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 400);
  }
});

// --- Character Book Import ---

app.post("/import-character-book", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { characterId } = body;
  if (!characterId) return c.json({ error: "characterId is required" }, 400);

  const character = charSvc.getCharacter(userId, characterId);
  if (!character) return c.json({ error: "Character not found" }, 404);

  const characterBook = character.extensions?.character_book;
  if (!characterBook?.entries?.length) {
    return c.json({ error: "No embedded character book found" }, 400);
  }

  const result = svc.importCharacterBook(userId, characterId, character.name, characterBook);
  const currentIds = getCharacterWorldBookIds(character.extensions);
  const nextExtensions = setCharacterWorldBookIds(
    { ...(character.extensions || {}) },
    [...currentIds, result.worldBook.id],
  );
  await charSvc.updateCharacter(userId, characterId, { extensions: nextExtensions });
  return c.json({ world_book: result.worldBook, entry_count: result.entryCount }, 201);
});

// --- Entry endpoints ---

const VALID_ENTRY_SORT_KEYS = new Set(["order", "priority", "created", "updated", "name"]);

app.get("/:id/entries", (c) => {
  const userId = c.get("userId");
  const book = svc.getWorldBook(userId, c.req.param("id"));
  if (!book) return c.json({ error: "World book not found" }, 404);
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const rawSortBy = c.req.query("sort_by");
  const rawSortDir = c.req.query("sort_dir");
  const sortBy = rawSortBy && VALID_ENTRY_SORT_KEYS.has(rawSortBy) ? (rawSortBy as svc.EntrySortKey) : undefined;
  const sortDir = rawSortDir === "desc" || rawSortDir === "asc" ? rawSortDir : undefined;
  const search = c.req.query("search") || undefined;
  return c.json(svc.listEntriesPaginated(userId, book.id, pagination, { sortBy, sortDir, search }));
});

app.post("/:id/entries", async (c) => {
  const userId = c.get("userId");
  const book = svc.getWorldBook(userId, c.req.param("id"));
  if (!book) return c.json({ error: "World book not found" }, 404);
  const body = await c.req.json();
  const entry = svc.createEntry(userId, book.id, body);
  if (!entry) return c.json({ error: "World book not found" }, 404);
  return c.json(entry, 201);
});

app.post("/:id/entries/reorder", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  const book = svc.getWorldBook(userId, bookId);
  if (!book) return c.json({ error: "World book not found" }, 404);
  const body = await c.req.json();
  if (!Array.isArray(body?.ordered_ids) || body.ordered_ids.length === 0) {
    return c.json({ error: "ordered_ids is required" }, 400);
  }
  const success = svc.reorderEntries(userId, bookId, body.ordered_ids);
  if (!success) return c.json({ error: "Unable to reorder entries" }, 400);
  return c.json({ success: true, count: body.ordered_ids.length });
});

app.post("/:id/entries/bulk", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  const book = svc.getWorldBook(userId, bookId);
  if (!book) return c.json({ error: "World book not found" }, 404);
  const body = await c.req.json();
  if (!body?.action) return c.json({ error: "action is required" }, 400);
  if (!Array.isArray(body?.entry_ids) || body.entry_ids.length === 0) {
    return c.json({ error: "entry_ids is required" }, 400);
  }
  try {
    const result = svc.bulkOperateEntries(userId, bookId, body);
    if (!result) return c.json({ error: "World book not found" }, 404);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || "Bulk action failed" }, 400);
  }
});

app.put("/:id/entries/:eid", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const entry = svc.updateEntry(userId, c.req.param("eid"), body);
  if (!entry) return c.json({ error: "Not found" }, 404);
  return c.json(entry);
});

app.post("/:id/entries/:eid/duplicate", async (c) => {
  const userId = c.get("userId");
  const bookId = c.req.param("id");
  const book = svc.getWorldBook(userId, bookId);
  if (!book) return c.json({ error: "World book not found" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const entry = svc.getEntry(userId, c.req.param("eid"));
  if (!entry || entry.world_book_id !== bookId) return c.json({ error: "Not found" }, 404);
  const duplicated = svc.duplicateEntry(userId, entry.id, body);
  if (!duplicated) return c.json({ error: "Target world book not found" }, 404);
  return c.json(duplicated, 201);
});

app.delete("/:id/entries/:eid", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteEntry(userId, c.req.param("eid"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as worldBooksRoutes };

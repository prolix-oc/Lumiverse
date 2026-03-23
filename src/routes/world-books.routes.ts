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
} from "../services/prompt-assembly.service";
import { activateWorldInfo, type WiState, type WorldInfoSettings } from "../services/world-info-activation.service";
import { safeFetch, SSRFError } from "../utils/safe-fetch";

const MAX_IMPORT_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB

const app = new Hono();

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
  const messages = chatsSvc.getMessages(userId, chat.id);
  const vectorSummary = svc.getWorldBookVectorSummary(userId, bookId)!;
  const bookEntries = svc.listEntries(userId, bookId);
  const attachmentSources = {
    character: character.extensions?.world_book_id === bookId,
    persona: persona?.attached_world_book_id === bookId,
    global: globalWorldBooks.includes(bookId),
  };
  const isAttached = attachmentSources.character || attachmentSources.persona || attachmentSources.global;

  const embeddings = await embeddingsSvc.getEmbeddingConfig(userId);
  const queryPreview = await getWorldInfoVectorQueryPreview(userId, messages);
  const blockerMessages: string[] = [];

  if (!isAttached) {
    blockerMessages.push("This world book is not attached to the current character, active persona, or global world books.");
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
        queryPreview,
        eligibleCount: 0,
        hitsBeforeThreshold: 0,
        hitsAfterThreshold: 0,
        thresholdRejected: 0,
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

  const keywordHits = mergedWorldInfo.activatedWorldInfo
    .filter((entry) => entry.source === "keyword")
    .map((entry) => ({
      entry_id: entry.id,
      comment: entry.comment || "",
    }));

  if (vectorDetail.thresholdRejected > 0 && vectorDetail.entries.length === 0) {
    blockerMessages.push("Vector matches were found, but all of them were rejected by the current similarity threshold.");
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
    blockerMessages.push("Semantic matches were found, but the World Info max-activated or token budget limits left no room for them after keyword activation.");
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
    mergedWorldInfo.evictedByBudget === 0
  ) {
    blockerMessages.push("Semantic matches were found, but the top vector hits were already activated by keyword, so the final list still counts them as keyword entries.");
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
      ready: embeddings.enabled && embeddings.has_api_key && !!embeddings.dimensions && embeddings.vectorize_world_books,
    },
    vector_summary: vectorSummary,
    query_preview: vectorDetail.queryPreview || queryPreview,
    eligible_entries: vectorDetail.eligibleCount,
    keyword_hits: keywordHits,
    vector_hits: vectorDetail.entries.map((item) => ({
      entry_id: item.entry.id,
      comment: item.entry.comment || "",
      score: item.score,
      distance: item.distance,
      final_score: item.finalScore,
      matched_primary_keys: item.matchedPrimaryKeys,
      matched_secondary_keys: item.matchedSecondaryKeys,
      matched_comment: item.matchedComment,
      score_breakdown: item.scoreBreakdown,
      search_text_preview: item.searchTextPreview,
    })),
    blocker_messages: Array.from(new Set(blockerMessages)),
    stats: {
      ...wiResult.stats,
      activatedBeforeBudget: mergedWorldInfo.activatedBeforeBudget,
      activatedAfterBudget: mergedWorldInfo.activatedAfterBudget,
      evictedByBudget: mergedWorldInfo.evictedByBudget,
      estimatedTokens: mergedWorldInfo.estimatedTokens,
      keywordActivated: mergedWorldInfo.keywordActivated,
      vectorActivated: mergedWorldInfo.vectorActivated,
      totalActivated: mergedWorldInfo.totalActivated,
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
  await charSvc.updateCharacter(userId, characterId, {
    extensions: {
      ...(character.extensions || {}),
      world_book_id: result.worldBook.id,
    },
  });
  return c.json({ world_book: result.worldBook, entry_count: result.entryCount }, 201);
});

// --- Entry endpoints ---

app.get("/:id/entries", (c) => {
  const userId = c.get("userId");
  const book = svc.getWorldBook(userId, c.req.param("id"));
  if (!book) return c.json({ error: "World book not found" }, 404);
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listEntriesPaginated(userId, book.id, pagination));
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

app.put("/:id/entries/:eid", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const entry = svc.updateEntry(userId, c.req.param("eid"), body);
  if (!entry) return c.json({ error: "Not found" }, 404);
  return c.json(entry);
});

app.delete("/:id/entries/:eid", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteEntry(userId, c.req.param("eid"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as worldBooksRoutes };

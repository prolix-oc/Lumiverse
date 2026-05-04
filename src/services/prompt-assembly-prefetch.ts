/**
 * Prompt Assembly Prefetch
 *
 * Batch-loads all statically-known data for the prompt assembly pipeline
 * in a minimal number of DB queries. The returned PrefetchedData is set
 * on AssemblyContext.prefetched so assemblePrompt() reads from it instead
 * of making 30+ individual service calls.
 */

import type { AssemblyContext, PrefetchedData } from "../llm/types";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as connectionsSvc from "./connections.service";
import * as presetsSvc from "./presets.service";
import * as settingsSvc from "./settings.service";
import * as worldBooksSvc from "./world-books.service";
import * as embeddingsSvc from "./embeddings.service";
import * as globalAddonsSvc from "./global-addons.service";
import { applyPersonaAddonStates } from "./persona-addon-states";
import { normalizeCortexConfig, DEFAULT_CORTEX_CONFIG } from "./memory-cortex/config";
import { getCharacterWorldBookIds } from "../utils/character-world-books";
import type { BookSource } from "./prompt-assembly.service";
import { createPromptAssemblyProfiler } from "./prompt-assembly-profiler";

/**
 * All settings keys the assembly pipeline may need. Loaded in a single
 * batched query instead of 5+ individual getSetting() calls.
 */
const ALL_SETTINGS_KEYS = [
  // Previously loaded individually before the batch
  "chatMemorySettings",
  "globalWorldBooks",
  "worldInfoSettings",
  // Previously loaded by getCortexConfig / getCouncilSettings
  "memoryCortexConfig",
  "council_settings",
  // Expression detection (used post-generation but loaded here for completeness)
  "expressionDetection",
  // The original batch keys from assemblePrompt line 422-434
  "reasoningSettings",
  "selectedDefinition", "selectedChimeraDefinitions", "selectedBehaviors", "selectedPersonalities",
  "chimeraMode", "lumiaQuirks", "lumiaQuirksEnabled",
  "oocEnabled", "lumiaOOCInterval", "lumiaOOCStyle",
  "sovereignHand",
  "selectedLoomStyles", "selectedLoomUtils", "selectedLoomRetrofits",
  "guidedGenerations", "promptBias",
  "theme",
  "contextFilters",
  "summarization",
  // Sidecar settings (used by council)
  "sidecarSettings",
];

export async function prefetchAssemblyData(ctx: AssemblyContext): Promise<PrefetchedData> {
  const profiler = createPromptAssemblyProfiler("prefetch", {
    chatId: ctx.chatId,
    generationType: ctx.generationType,
  });

  try {
  // Macrotask yield + abort check at the top. Without this, a stop clicked
  // during the first ~500ms of assembly stayed queued behind prefetch's
  // synchronous DB reads (which can total 100-300ms on large chats with
  // hundreds of WI entries) — the event loop had no chance to process the
  // incoming /generate/stop request until the first internal yield, and by
  // then the user had already perceived an unresponsive stop button.
  await profiler.measure("entry-yield", () => new Promise<void>(r => setTimeout(r, 0)));
  if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");

  // ── 1. Batch settings (1 query for ~25 keys) ─────────────────────────
  const allSettings = profiler.measureSync("settings", () =>
    settingsSvc.getSettingsByKeys(ctx.userId, ALL_SETTINGS_KEYS)
  );

  // ── 2. Core entities (each 1 query) ──────────────────────────────────
  const chat = profiler.measureSync("chat", () =>
    chatsSvc.getChat(ctx.userId, ctx.chatId)
  );
  if (!chat) throw new Error("Chat not found");

  const allMessages = profiler.measureSync("messages", () =>
    chatsSvc.getMessages(ctx.userId, ctx.chatId)
  );
  const messages = ctx.excludeMessageId
    ? allMessages.filter(m => m.id !== ctx.excludeMessageId)
    : allMessages;

  // Yield after loading messages — for large chats (thousands of messages),
  // the SQLite query + JSON.parse per row can block the event loop for
  // 50-200ms. Yielding here lets Bun process pending HTTP requests and
  // WebSocket frames before we continue with more sync DB work.
  if (allMessages.length > 200) {
    await profiler.measure("post-messages-yield", () => new Promise<void>(r => setTimeout(r, 0)));
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  const characterId = ctx.targetCharacterId || chat.character_id;
  const character = profiler.measureSync("character", () =>
    charactersSvc.getCharacter(ctx.userId, characterId)
  );
  if (!character) throw new Error("Character not found");

  let persona = profiler.measureSync("persona", () =>
    applyPersonaAddonStates(
      personasSvc.resolvePersonaOrDefault(ctx.userId, ctx.personaId),
      ctx.personaAddonStates,
    )
  );

  // Resolve attached global add-ons for the persona
  if (persona) {
    const attachedRefs = (persona.metadata?.attached_global_addons as Array<{ id: string; enabled: boolean }>) ?? [];
    const enabledIds = attachedRefs.filter(a => a.enabled).map(a => a.id);
    if (enabledIds.length > 0) {
      const resolved = profiler.measureSync("global-addons", () =>
        globalAddonsSvc.getGlobalAddonsByIds(ctx.userId, enabledIds)
      );
      persona = { ...persona, metadata: { ...persona.metadata, _resolvedGlobalAddons: resolved } };
    }
  }

  const connection = profiler.measureSync("connection", () =>
    ctx.connectionId
      ? connectionsSvc.getConnection(ctx.userId, ctx.connectionId)
      : connectionsSvc.getDefaultConnection(ctx.userId)
  );

  const resolvedPresetId = ctx.presetId || connection?.preset_id;
  const preset = profiler.measureSync("preset", () =>
    resolvedPresetId ? presetsSvc.getPreset(ctx.userId, resolvedPresetId) : null
  );

  // ── 3. Embedding config (1 setting + 1 secret decrypt — only async op) ─
  const embeddingConfig = await profiler.measure("embedding-config", () =>
    embeddingsSvc.getEmbeddingConfig(ctx.userId)
  );

  if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");

  // ── 4. World book entries (2 queries total) ──────────────────────────
  const globalWorldBooks = (allSettings.get("globalWorldBooks") as string[] | undefined) ?? [];
  const chatWorldBookIds = (chat.metadata?.chat_world_book_ids as string[] | undefined) ?? [];
  const charBookIds = getCharacterWorldBookIds(character.extensions);
  const personaBookId = persona?.attached_world_book_id;

  // Collect all book IDs in source-priority order (character → persona → chat → global)
  // while deduplicating
  const allBookIds: string[] = [];
  const bookSourceMap = new Map<string, BookSource>();
  const seen = new Set<string>();

  for (const id of charBookIds) {
    if (seen.has(id)) continue;
    seen.add(id); allBookIds.push(id); bookSourceMap.set(id, "character");
  }
  if (personaBookId && !seen.has(personaBookId)) {
    seen.add(personaBookId); allBookIds.push(personaBookId); bookSourceMap.set(personaBookId, "persona");
  }
  for (const id of chatWorldBookIds) {
    if (seen.has(id)) continue;
    seen.add(id); allBookIds.push(id); bookSourceMap.set(id, "chat");
  }
  for (const id of globalWorldBooks) {
    if (seen.has(id)) continue;
    seen.add(id); allBookIds.push(id); bookSourceMap.set(id, "global");
  }

  const entriesByBook = profiler.measureSync("world-book-entries", () =>
    worldBooksSvc.listEntriesForBooks(ctx.userId, allBookIds)
  );
  const allEntries: import("../types/world-book").WorldBookEntry[] = [];
  for (const bookId of allBookIds) {
    const bookEntries = entriesByBook.get(bookId);
    if (bookEntries) allEntries.push(...bookEntries);
  }

  // Large lorebooks make listEntriesForBooks + row hydration a noticeable
  // synchronous stretch. Give pending navigation/status requests a chance to run
  // before group character loads and cortex config derivation continue.
  if (allEntries.length > 200) {
    await profiler.measure("post-world-books-yield", () => new Promise<void>(r => setTimeout(r, 0)));
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new DOMException("Aborted", "AbortError");
  }

  // ── 5. Group characters (1 batch query) ──────────────────────────────
  const isGroup = chat.metadata?.group === true;
  const groupCharacterIds: string[] = isGroup ? (chat.metadata.character_ids || []) : [];
  const groupCharacters = profiler.measureSync("group-characters", () =>
    groupCharacterIds.length > 0
      ? charactersSvc.getCharactersByIds(ctx.userId, groupCharacterIds)
      : undefined
  );

  // ── 6. Derive cortex config from settings (pure computation) ─────────
  const cortexConfig = profiler.measureSync("cortex-config", () => {
    const cortexRaw = allSettings.get("memoryCortexConfig");
    return cortexRaw
      ? normalizeCortexConfig(cortexRaw)
      : { ...DEFAULT_CORTEX_CONFIG };
  });

  return {
    chat,
    messages,
    character,
    persona,
    connection,
    preset,
    allSettings,
    embeddingConfig,
    worldInfoSources: {
      entries: allEntries,
      worldBookIds: allBookIds,
      bookSourceMap,
    },
    groupCharacters,
    cortexConfig,
  };
  } finally {
    profiler.finish();
  }
}

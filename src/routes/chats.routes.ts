import { Hono } from "hono";
import * as svc from "../services/chats.service";
import * as personasSvc from "../services/personas.service";
import * as charactersSvc from "../services/characters.service";
import * as regexScriptsSvc from "../services/regex-scripts.service";
import * as managerSvc from "../spindle/manager.service";
import { pruneOrphanedWiState } from "../services/wi-state-prune.service";
import { parsePagination } from "../services/pagination";
import { RECENT_CHATS_DEFAULT_LIMIT } from "../types/pagination";
import { parseStChatJsonl, parseStGroupChatJsonl } from "../migration/st-reader";
import {
  messageContentProcessorChain,
  type MessageContentProcessorCtx,
} from "../spindle/message-content-processor";
import { resolveRenderedMessageContent } from "../services/chat-macro-render.service";
import { contentHasMacroHints } from "../services/vectorization-content.service";
import { computeMessageTokenCount } from "../services/message-token-count";
import {
  getActivatedWorldInfoEntriesForChat,
  resolveWorldInfoOutlets,
} from "../services/prompt-assembly.service";
import { resolveRegexActionEffects } from "../services/associative-regex-effects.service";
import {
  personaHasAddon,
  withChatPersonaAddonState,
} from "../services/persona-addon-states";
import type { RegexActionEffect } from "../types/regex-script";

async function runMessageContentProcessors(
  ctx: MessageContentProcessorCtx,
  userId: string,
  signal?: AbortSignal,
): Promise<MessageContentProcessorCtx> {
  if (messageContentProcessorChain.count === 0) return ctx;
  return messageContentProcessorChain.run(ctx, userId, signal);
}

// Auto-greetings are inserted by service-layer createMessage calls that
// bypass the per-route processor hook; run the chain explicitly so the
// DB holds resolved content before MESSAGE_SENT broadcasts.
async function processChatGreeting(userId: string, chat: { id: string }) {
  if (messageContentProcessorChain.count === 0) return;
  const msgs = svc.listMessagesTail(userId, chat.id, 1);
  const greeting = msgs.data[0];
  if (!greeting || greeting.is_user || greeting.extra?.greeting !== true) return;
  const ctx: MessageContentProcessorCtx = {
    chatId: chat.id,
    messageId: greeting.id,
    content: greeting.content,
    extra: greeting.extra,
    origin: "create",
    userId,
  };
  const processed = await messageContentProcessorChain.run(ctx, userId);
  const update: { content?: string; extra?: Record<string, unknown> } = {};
  if (processed.content !== greeting.content) update.content = processed.content;
  if (processed.extra && processed.extra !== greeting.extra) update.extra = processed.extra;
  if (update.content !== undefined || update.extra !== undefined) {
    svc.updateMessage(userId, greeting.id, update);
  }
}

const app = new Hono();

/** Matches an outlet macro so display resolution can populate Lorebook
 * outlets when a directly or indirectly referenced persona outlet needs one. */
const OUTLET_MACRO_RE = /\{\{(?:outlet|persona_outlet|personaoutlet)::/i;
const DISPLAY_PREPROCESS_BATCH_MAX = 100;

interface DisplayPreprocessItem {
  messageId?: string;
  messageIndex?: number;
  role?: string;
  rawContent: string;
}

function parseDisplayPreprocessItem(input: unknown): DisplayPreprocessItem | null {
  if (!input || typeof input !== "object") return null;
  const body = input as {
    messageId?: unknown;
    messageIndex?: unknown;
    role?: unknown;
    rawContent?: unknown;
  };
  if (typeof body.rawContent !== "string") return null;

  return {
    rawContent: body.rawContent,
    ...(typeof body.messageId === "string" ? { messageId: body.messageId } : {}),
    ...(typeof body.messageIndex === "number" ? { messageIndex: body.messageIndex } : {}),
    ...(typeof body.role === "string" ? { role: body.role } : {}),
  };
}

async function runDisplayPreprocessItem(
  userId: string,
  chatId: string,
  item: DisplayPreprocessItem,
  signal?: AbortSignal,
) {
  const processed = messageContentProcessorChain.count > 0
    ? await messageContentProcessorChain.run({
        chatId,
        content: item.rawContent,
        origin: "render",
        userId,
        ...(item.messageId ? { messageId: item.messageId } : {}),
        extra: {
          ...(typeof item.messageIndex === "number" ? { messageIndex: item.messageIndex } : {}),
          ...(item.role ? { role: item.role, is_user: item.role === "user" } : {}),
        },
      }, userId, signal)
    : { content: item.rawContent };

  let content = processed.content ?? item.rawContent;
  if (contentHasMacroHints(content)) {
    const env = svc.buildMacroEnvForChat(userId, chatId);
    if (env) {
      // {{outlet::name}} is only populated during prompt assembly; mirror it
      // here so displayed messages match what the model actually receives.
      if (OUTLET_MACRO_RE.test(content)) {
        try {
          const entries = await getActivatedWorldInfoEntriesForChat(userId, chatId);
          await resolveWorldInfoOutlets(entries, env, signal);
        } catch {
          // Leave outlets unresolved — base macro resolution still runs.
        }
      }
      content = await resolveRenderedMessageContent(content, env);
    }
  }

  return { messageId: item.messageId, content };
}

// --- Chat endpoints ---

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const characterId = c.req.query("characterId");
  return c.json(svc.listChats(userId, pagination, characterId));
});

app.get("/recent", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"), RECENT_CHATS_DEFAULT_LIMIT);
  return c.json(svc.listRecentChats(userId, pagination));
});

app.get("/recent-grouped", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"), RECENT_CHATS_DEFAULT_LIMIT);
  const search = c.req.query("search");
  const sortParam = c.req.query("sort");
  const directionParam = c.req.query("direction");
  const favoriteCharacterIds = c.req.query("favorite_ids")
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const hiddenCharacterIds = c.req.query("hidden_character_ids")
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const sort: svc.GroupedRecentChatSort | undefined =
    sortParam === "name" || sortParam === "recent" || sortParam === "created" ? sortParam : undefined;
  const direction: "asc" | "desc" | undefined =
    directionParam === "asc" || directionParam === "desc" ? directionParam : undefined;
  return c.json(svc.listRecentChatsGrouped(userId, pagination, {
    ...(search ? { search } : {}),
    ...(sort ? { sort } : {}),
    ...(direction ? { direction } : {}),
    ...(favoriteCharacterIds?.length ? { favoriteCharacterIds } : {}),
    ...(hiddenCharacterIds?.length ? { hiddenCharacterIds } : {}),
  }));
});

app.get("/character-chats/:characterId", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  return c.json(svc.listChatSummaries(userId, characterId));
});

app.delete("/character-chats/:characterId", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteAllChatsForCharacter(userId, c.req.param("characterId"));
  return c.json({ success: true, deleted });
});

app.post("/bulk-delete", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body?.ids)) return c.json({ error: "ids must be an array" }, 400);
  const ids = body.ids.filter((value: unknown): value is string => typeof value === "string" && value.length > 0);
  const deleted = svc.deleteChats(userId, ids);
  return c.json({ deleted, count: deleted.length });
});

app.get("/group-chats", (c) => {
  const userId = c.get("userId");
  const rawCharacterIds = c.req.query("character_ids");
  const characterIds = rawCharacterIds
    ? rawCharacterIds.split(",").map((id) => id.trim()).filter(Boolean)
    : undefined;
  return c.json(svc.listGroupChatSummaries(userId, characterIds));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.character_id) return c.json({ error: "character_id is required" }, 400);
  const chat = svc.createChat(userId, body);
  await processChatGreeting(userId, chat);
  return c.json(chat, 201);
});

// Temporary character-less, persona-less chat for trying out a connection
// profile. No greeting, hidden from recent lists, swept when the user
// returns to the landing page (DELETE below). Registered before the /:id
// routes so "temporary" never matches as a chat id.
app.post("/temporary", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const chat = svc.createChat(userId, {
    character_id: null,
    name: typeof body?.name === "string" && body.name.trim() ? body.name : "Temporary Chat",
    // no_preset opts the chat out of presets entirely (raw model test):
    // generation skips preset blocks/parameters and the active/connection
    // preset fallbacks.
    metadata: { temporary: true, ...(body?.no_preset === true ? { no_preset: true } : {}) },
  });
  return c.json(chat, 201);
});

app.delete("/temporary", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteTemporaryChats(userId);
  return c.json({ success: true, deleted });
});

app.post("/group", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!Array.isArray(body.character_ids) || body.character_ids.length < 2) {
    return c.json({ error: "character_ids must be an array with at least 2 entries" }, 400);
  }
  const chat = svc.createGroupChat(userId, body);
  await processChatGreeting(userId, chat);
  return c.json(chat, 201);
});

app.post("/:id/convert-to-group", (c) => {
  const userId = c.get("userId");
  try {
    const chat = svc.convertSoloChatToGroup(userId, c.req.param("id"));
    if (!chat) return c.json({ error: "Not found" }, 404);
    return c.json(chat, 201);
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to convert chat" }, 400);
  }
});

// Group chat muting
app.post("/:id/mute/:characterId", (c) => {
  const userId = c.get("userId");
  const updated = svc.setGroupMute(userId, c.req.param("id"), c.req.param("characterId"), true);
  if (!updated) return c.json({ error: "Not found or not a group chat member" }, 404);
  return c.json(updated);
});

app.post("/:id/unmute/:characterId", (c) => {
  const userId = c.get("userId");
  const updated = svc.setGroupMute(userId, c.req.param("id"), c.req.param("characterId"), false);
  if (!updated) return c.json({ error: "Not found or not a group chat member" }, 404);
  return c.json(updated);
});

// Group chat member management
app.post("/:id/members/:characterId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const updated = svc.addGroupMember(userId, c.req.param("id"), c.req.param("characterId"), {
    skip_greeting: body.skip_greeting,
    greeting_index: body.greeting_index,
  });
  if (!updated) return c.json({ error: "Not found, not a group chat, character not found, or already a member" }, 400);
  if (!body.skip_greeting) await processChatGreeting(userId, updated);
  return c.json(updated);
});

app.delete("/:id/members/:characterId", (c) => {
  const userId = c.get("userId");
  const updated = svc.removeGroupMember(userId, c.req.param("id"), c.req.param("characterId"));
  if (!updated) return c.json({ error: "Not found, not a group chat, not a member, or cannot remove (minimum 2 members)" }, 400);
  return c.json(updated);
});

app.patch("/:id/members/:characterId/alternate-fields", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const selections = body?.selections;
  if (!selections || typeof selections !== "object" || Array.isArray(selections)) {
    return c.json({ error: "selections must be an object" }, 400);
  }
  const updated = svc.setGroupMemberAlternateFields(
    userId,
    c.req.param("id"),
    c.req.param("characterId"),
    selections,
  );
  if (!updated) {
    return c.json({ error: "Not found, not a group chat/member, or invalid alternate field selection" }, 400);
  }
  return c.json(updated);
});

/**
 * Atomically toggle one persona add-on in this chat. Besides the existing
 * boolean override, this records toggle recency so that the newest enabled
 * add-on with alternative art owns the active persona avatar.
 */
app.put("/:id/persona-addons/:personaId/:addonId", async (c) => {
  const userId = c.get("userId");
  const chat = svc.getChat(userId, c.req.param("id"));
  if (!chat) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json().catch(() => null);
  if (!body || typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  const persona = personasSvc.getPersona(userId, c.req.param("personaId"));
  if (!persona) return c.json({ error: "Persona not found" }, 404);
  if (!personaHasAddon(persona, c.req.param("addonId"))) {
    return c.json({ error: "Add-on is not attached to this persona" }, 404);
  }

  const metadata = withChatPersonaAddonState(
    chat.metadata,
    persona.id,
    c.req.param("addonId"),
    body.enabled,
  );
  const updated = svc.updateChat(userId, chat.id, { metadata });
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const chat = svc.getChat(userId, c.req.param("id"));
  if (!chat) return c.json({ error: "Not found" }, 404);
  const ownerCandidates = managerSvc.getEnabledExtensionIdentifiers();
  const character_display_owner = chat.character_id
    ? charactersSvc.getCharacterDisplayOwner(userId, chat.character_id, ownerCandidates)
    : null;
  if (c.req.query("messages") === "false") return c.json({ ...chat, character_display_owner });
  const messages = svc.getMessages(userId, chat.id);
  return c.json({ ...chat, character_display_owner, messages });
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const chat = svc.getChat(userId, c.req.param("id"));
  if (!chat) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json();
  let updated = svc.updateChat(userId, chat.id, body);
  // PUT replaces metadata wholesale, so book attachments can change (or
  // vanish) on any metadata write.
  if (updated && body?.metadata !== undefined) {
    const beforeIds = JSON.stringify(chat.metadata?.chat_world_book_ids ?? []);
    const afterIds = JSON.stringify(updated.metadata?.chat_world_book_ids ?? []);
    if (beforeIds !== afterIds) {
      updated = pruneOrphanedWiState(userId, updated);
    }
  }
  return c.json(updated);
});

/**
 * Atomic partial metadata merge. Re-reads the latest chat row inside the
 * service so concurrent writers (post-generation expression detection,
 * council caching, deferred WI/chat var persistence, etc.) cannot clobber
 * the keys the caller is updating. Pass `null` for a key to delete it.
 *
 * Used by chat-scoped UI controls (alternate field selector, world book
 * attachments, author's note) that previously did GET-then-PUT and lost
 * concurrent edits.
 */
app.patch("/:id/metadata", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("id");
  const chat = svc.getChat(userId, chatId);
  if (!chat) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Body must be an object of metadata keys" }, 400);
  }
  // Translate `null` sentinels to `undefined` so mergeChatMetadata deletes them.
  // Also sanitize the `voiceOverrides` payload here — TTS voice routing is
  // client-side, but defensive parsing keeps malformed clients from writing
  // garbage that confuses the resolver later.
  const partial: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null) {
      partial[key] = undefined;
      continue;
    }
    if (key === "voiceOverrides") {
      const sanitized = svc.sanitizeVoiceOverrides(value);
      // If the caller sent a voiceOverrides blob and nothing survived
      // sanitization, treat it as a delete rather than silently keeping
      // a stale value.
      partial[key] = sanitized ?? undefined;
      continue;
    }
    partial[key] = value;
  }
  let updated = svc.mergeChatMetadata(userId, chatId, partial);
  if (!updated) return c.json({ error: "Not found" }, 404);

  if ("chat_world_book_ids" in body) {
    updated = pruneOrphanedWiState(userId, updated);
  }

  return c.json(updated);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteChat(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/:id/export", (c) => {
  const userId = c.get("userId");
  const data = svc.exportChat(userId, c.req.param("id"));
  if (!data) return c.json({ error: "Not found" }, 404);
  return c.json(data);
});

app.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();

  if (!body.character_id) return c.json({ error: "character_id is required" }, 400);
  if (!body.chat || !body.messages) return c.json({ error: "chat and messages are required" }, 400);

  try {
    const chat = svc.createChatRaw(userId, {
      character_id: body.character_id,
      name: body.chat.name || "Imported Chat",
      metadata: body.chat.metadata || {},
    });

    const bulkMessages = (body.messages as any[]).map((m) => ({
      is_user: Boolean(m.is_user),
      name: m.name || "",
      content: m.content || "",
      send_date: m.send_date,
      swipes: m.swipes,
      swipe_dates: m.swipe_dates,
      swipe_id: m.swipe_id,
      extra: m.extra,
    }));

    const msgCount = svc.bulkInsertMessages(chat.id, bulkMessages, userId);

    return c.json({ chat_id: chat.id, name: chat.name, message_count: msgCount }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 500);
  }
});

app.post("/import-st", async (c) => {
  const userId = c.get("userId");

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  const characterId = formData.get("character_id") as string | null;
  const file = formData.get("file") as File | null;

  if (!characterId) {
    return c.json({ error: "character_id is required" }, 400);
  }
  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }

  const parsed = parseStChatJsonl(await file.text(), (file.name || "import").replace(/\.jsonl$/i, ""));
  if (!parsed) {
    return c.json({ error: "No valid messages found in file" }, 400);
  }

  try {
    const chat = svc.createChatRaw(userId, {
      character_id: characterId,
      name: parsed.name,
      metadata: {},
      ...(parsed.createdAt ? { created_at: parsed.createdAt } : {}),
    });

    const msgCount = svc.bulkInsertMessages(chat.id, parsed.messages, userId);
    return c.json({
      chat_id: chat.id,
      name: chat.name,
      message_count: msgCount,
      speaker_name_fallback_count: parsed.speakerNameFallbackCount ?? 0,
    }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 500);
  }
});

app.post("/import-st-group", async (c) => {
  const userId = c.get("userId");

  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Expected multipart/form-data" }, 400);
  }

  const characterIds = formData
    .getAll("character_ids")
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean);
  const greetingCharacterIdValue = formData.get("greeting_character_id");
  const greetingCharacterId = typeof greetingCharacterIdValue === "string" ? greetingCharacterIdValue.trim() : "";
  const file = formData.get("file") as File | null;

  if (characterIds.length < 2) {
    return c.json({ error: "character_ids must contain at least 2 entries" }, 400);
  }
  if (!file) {
    return c.json({ error: "file is required" }, 400);
  }

  const uniqueCharacterIds = Array.from(new Set(characterIds));
  const characters = charactersSvc.getCharactersByIds(userId, uniqueCharacterIds);
  if (characters.size !== uniqueCharacterIds.length) {
    return c.json({ error: "One or more group characters were not found" }, 404);
  }

  const filenameToId = new Map<string, string>();
  for (const [id, character] of characters.entries()) {
    const sourceFilename = typeof character.extensions?._lumiverse_source_filename === "string"
      ? character.extensions._lumiverse_source_filename.trim()
      : "";
    const addKey = (key: string) => {
      const normalized = key.trim();
      if (!normalized) return;
      filenameToId.set(normalized, id);
      filenameToId.set(normalized.toLowerCase(), id);
    };
    addKey(character.name);
    addKey(sourceFilename);
    if (sourceFilename.toLowerCase().endsWith(".png")) addKey(sourceFilename.slice(0, -4));
  }

  const personas = personasSvc.listPersonas(userId, { limit: 10000, offset: 0 });
  const personaNameToId = new Map<string, string>();
  for (const persona of personas.data) {
    if (persona.name) personaNameToId.set(persona.name, persona.id);
  }

  const parsed = parseStGroupChatJsonl(
    await file.text(),
    (file.name || "group").replace(/\.jsonl$/i, ""),
    personaNameToId,
    filenameToId,
  );
  if (!parsed) {
    return c.json({ error: "No valid messages found in file" }, 400);
  }

  try {
    const chat = svc.createChatRaw(userId, {
      character_id: greetingCharacterId && characters.has(greetingCharacterId)
        ? greetingCharacterId
        : uniqueCharacterIds[0],
      name: parsed.name,
      metadata: { group: true, character_ids: uniqueCharacterIds },
      ...(parsed.createdAt ? { created_at: parsed.createdAt } : {}),
    });

    const msgCount = svc.bulkInsertMessages(chat.id, parsed.messages, userId);
    return c.json({ chat_id: chat.id, name: chat.name, message_count: msgCount }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 500);
  }
});

app.get("/:id/tree", (c) => {
  const userId = c.get("userId");
  const tree = svc.getChatTree(userId, c.req.param("id"));
  if (!tree) return c.json({ error: "Not found" }, 404);
  return c.json(tree);
});

app.post("/:id/branch", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.message_id) return c.json({ error: "message_id is required" }, 400);
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
  const branch = svc.branchChat(userId, c.req.param("id"), body.message_id, name);
  if (!branch) return c.json({ error: "Not found or invalid message" }, 404);
  return c.json(branch, 201);
});

app.post("/reattribute-all", async (c) => {
  const userId = c.get("userId");
  const personas = personasSvc.listPersonas(userId, { limit: 10000, offset: 0 });

  const nameMap = new Map<string, { id: string; name: string }>();
  for (const p of personas.data) {
    nameMap.set(p.name, { id: p.id, name: p.name });
  }

  if (nameMap.size === 0) {
    return c.json({ success: true, chats_updated: 0, messages_updated: 0, message: "No personas found" });
  }

  const result = svc.bulkReattributeByPersonaName(userId, nameMap);
  return c.json({ success: true, ...result });
});

app.post("/:id/reattribute-user-messages", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("id");
  const body = await c.req.json<{ persona_id?: string }>();

  if (!body.persona_id) return c.json({ error: "persona_id is required" }, 400);

  const persona = personasSvc.getPersona(userId, body.persona_id);
  if (!persona) return c.json({ error: "Persona not found" }, 404);

  const updated = svc.reattributeUserMessages(userId, chatId, persona.id, persona.name);
  if (updated === null) return c.json({ error: "Chat not found" }, 404);

  return c.json({ success: true, updated, persona_id: persona.id, persona_name: persona.name });
});

// --- Message endpoints (nested under chats) ---

app.get("/:chatId/messages", (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const chat = svc.getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  // Lists ship the light projection (active swipe only, no per-swipe extra
  // arrays) — non-active swipe data dominated the payload but is only needed
  // by swipe actions, which re-fetch the full message. ?full=true opts out.
  const light = c.req.query("full") !== "true";

  // tail=true fetches the last N messages efficiently (single index scan from end)
  if (c.req.query("tail") === "true") {
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 1000);
    return c.json(svc.listMessagesTail(userId, chatId, limit, { light }));
  }

  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listMessages(userId, chatId, pagination, { light }));
});

app.get("/:chatId/messages/search", (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const chat = svc.getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const query = c.req.query("q")?.trim() ?? "";
  if (query.length === 0) return c.json({ data: [], total: 0, message_total: 0, truncated: false });
  if (query.length > 500) return c.json({ error: "Search query is too long" }, 400);

  return c.json(svc.searchMessages(userId, chatId, query));
});

app.post("/:chatId/messages/bulk-hide", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const body = await c.req.json();

  if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return c.json({ error: "message_ids must be a non-empty array" }, 400);
  }
  if (typeof body.hidden !== "boolean") {
    return c.json({ error: "hidden must be a boolean" }, 400);
  }

  try {
    const messages = svc.bulkSetHidden(userId, chatId, body.message_ids, body.hidden);
    return c.json({ success: true, updated: messages.length, messages });
  } catch (e: any) {
    if (e.message === "Chat not found") return c.json({ error: e.message }, 404);
    if (e.message.includes("Maximum")) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.post("/:chatId/messages/bulk-delete", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const body = await c.req.json();

  if (!Array.isArray(body.message_ids) || body.message_ids.length === 0) {
    return c.json({ error: "message_ids must be a non-empty array" }, 400);
  }

  try {
    const deleted = svc.bulkDeleteMessages(userId, chatId, body.message_ids);
    return c.json({ success: true, deleted });
  } catch (e: any) {
    if (e.message === "Chat not found") return c.json({ error: e.message }, 404);
    if (e.message.includes("Maximum")) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.post("/:chatId/messages", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const chat = svc.getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const body = await c.req.json();
  if (body.name === undefined || body.content === undefined) {
    return c.json({ error: "name and content are required" }, 400);
  }

  const processed = await runMessageContentProcessors(
    { chatId, content: body.content, extra: body.extra, origin: "create", userId },
    userId,
    c.req.raw.signal,
  );
  body.content = processed.content;
  if (processed.extra !== undefined) body.extra = processed.extra;

  // Tokenize user-sent (and any manually-created) messages so they carry a
  // tokenCount just like assistant messages do. Inline so the count rides the
  // creation response/MESSAGE_SENT broadcast, avoiding a follow-up edit event.
  const tokenCount = await computeMessageTokenCount(userId, body.content, body.connection_id);
  if (tokenCount != null) {
    body.extra = { ...(body.extra || {}), tokenCount };
  }

  const msg = svc.createMessage(chatId, body, userId);
  return c.json(msg, 201);
});

// POST /:chatId/messages/:id/regex-action — atomically consume a rendered
// associative-regex choice block before the client sends or queues its effect.
app.post("/:chatId/messages/regex-actions/claim", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const body = await c.req.json().catch(() => null);
  const rawSelections = Array.isArray(body?.selections) ? body.selections : [];
  if (rawSelections.length === 0 || rawSelections.length > 64) {
    return c.json({ error: "selections must contain between 1 and 64 actions" }, 400);
  }

  const selections: svc.AssociativeRegexActionBatchInput[] = [];
  for (const raw of rawSelections) {
    const messageId = typeof raw?.message_id === "string" ? raw.message_id : "";
    const scriptId = typeof raw?.script_id === "string" ? raw.script_id : "";
    const actionId = typeof raw?.action_id === "string" ? raw.action_id : "";
    const instanceId = typeof raw?.instance_id === "string" ? raw.instance_id : "";
    if (!messageId || !scriptId || !actionId || !instanceId ||
      !instanceId.startsWith(`${scriptId}:`) ||
      !/^\d+:\d+$/.test(instanceId.slice(scriptId.length + 1))) {
      return c.json({ error: "invalid regex action selection" }, 400);
    }
    const script = regexScriptsSvc.getRegexScript(userId, scriptId);
    const action = script?.actions.find((candidate) => candidate.id === actionId);
    if (!script || script.disabled || !script.target.includes("display") || !action) {
      return c.json({ error: "regex action is no longer available" }, 404);
    }
    if (!action.multi_select && action.type !== "send") {
      return c.json({ error: "only Send actions can trigger a mixed batch claim" }, 400);
    }
    let stateEffects: Array<{ key: string; value: string }> | undefined;
    if (action.effects?.length) {
      const resolved = await resolveRegexActionEffects(userId, chatId, messageId, scriptId, actionId, instanceId);
      if (resolved.status === "user_source") {
        return c.json({ error: "composable effects require an assistant source message" }, 403);
      }
      if (resolved.status !== "resolved") {
        return c.json({ error: "regex action could not be verified from its source message" }, 404);
      }
      stateEffects = resolved.effects
        .filter((effect) => effect.type === "set_state")
        .map(({ key, value }) => ({ key, value }));
    }
    selections.push({
      messageId,
      scriptId,
      actionId,
      instanceId,
      multiSelect: action.multi_select,
      ...(stateEffects ? { stateEffects } : {}),
    });
  }

  const result = svc.claimAssociativeRegexActions(userId, chatId, selections);
  if (result.status === "not_found") return c.json({ error: "Source message not found", messages: result.messages }, 404);
  if (result.status === "forbidden") return c.json({ error: "composable effects require an assistant source message", messages: result.messages }, 403);
  if (result.status === "used") {
    return c.json({ error: "One or more choices have already been used", messages: result.messages, usage: result.usage }, 409);
  }
  return c.json({ messages: result.messages, usages: result.usages });
});

app.post("/:chatId/messages/:id/regex-action", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const messageId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  const scriptId = typeof body?.script_id === "string" ? body.script_id : "";
  const actionId = typeof body?.action_id === "string" ? body.action_id : "";
  const instanceId = typeof body?.instance_id === "string" ? body.instance_id : "";
  if (!scriptId || !actionId || !instanceId) {
    return c.json({ error: "script_id, action_id, and instance_id are required" }, 400);
  }
  if (!instanceId.startsWith(`${scriptId}:`) || !/^\d+:\d+$/.test(instanceId.slice(scriptId.length + 1))) {
    return c.json({ error: "invalid regex action instance" }, 400);
  }

  const script = regexScriptsSvc.getRegexScript(userId, scriptId);
  const action = script?.actions.find((candidate) => candidate.id === actionId);
  if (!script || script.disabled || !script.target.includes("display") || !action) {
    return c.json({ error: "regex action is no longer available" }, 404);
  }
  if (action.multi_select) {
    return c.json({ error: "multi-select actions must be finalized with the batch claim endpoint" }, 400);
  }

  let resolvedEffects: RegexActionEffect[] = [];
  let stateEffects: Array<{ key: string; value: string }> | undefined;
  if (action.effects?.length) {
    const resolved = await resolveRegexActionEffects(userId, chatId, messageId, scriptId, actionId, instanceId);
    if (resolved.status === "user_source") {
      return c.json({ error: "composable effects require an assistant source message" }, 403);
    }
    if (resolved.status !== "resolved") {
      return c.json({ error: "regex action could not be verified from its source message" }, 404);
    }
    resolvedEffects = resolved.effects;
    stateEffects = resolvedEffects
      .filter((effect) => effect.type === "set_state")
      .map(({ key, value }) => ({ key, value }));
  }

  const result = svc.claimAssociativeRegexAction(userId, chatId, messageId, {
    instanceId,
    scriptId,
    actionId,
    multiSelect: false,
    ...(stateEffects ? { stateEffects } : {}),
    ...(resolvedEffects.length > 0 ? {
      requiresAssistantSource: true,
      fork: resolvedEffects.some((effect) => effect.type === "fork"),
    } : {}),
  });
  if (result.status === "not_found") return c.json({ error: "Message not found" }, 404);
  if (result.status === "forbidden") return c.json({ error: "composable effects require an assistant source message" }, 403);
  if (result.status === "used") {
    return c.json({ error: "This choice has already been used", message: result.message, usage: result.usage }, 409);
  }
  return c.json({
    message: result.message,
    usage: result.usage,
    ...(resolvedEffects.length > 0 ? { effects: resolvedEffects } : {}),
    ...(result.forkedChat ? { forked_chat: result.forkedChat } : {}),
  });
});

app.put("/:chatId/messages/:id", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const messageId = c.req.param("id");
  const body = await c.req.json();

  if (body.content !== undefined) {
    const processed = await runMessageContentProcessors(
      {
        chatId,
        messageId,
        content: body.content,
        extra: body.extra,
        origin: "update",
        userId,
      },
      userId,
      c.req.raw.signal,
    );
    body.content = processed.content;
    if (processed.extra !== undefined) body.extra = processed.extra;

    const chat = svc.getChat(userId, chatId);
    if (chat) {
      const editScripts = regexScriptsSvc.getRunOnEditScripts(userId, {
        characterId: chat.character_id ?? undefined,
        chatId,
      });
      if (editScripts.length > 0) {
        const existing = svc.getMessage(userId, messageId);
        const placement = existing?.is_user ? "user_input" as const : "ai_output" as const;
        body.content = await regexScriptsSvc.applyRegexScripts(
          body.content,
          editScripts,
          placement,
          0,
        );
      }
    }

    // Content changed → refresh the stored tokenCount so it doesn't reflect the
    // pre-edit text. Merge onto the extra being saved (the edit may omit extra,
    // in which case base off the message's current extra to avoid clobbering it).
    const tokenCount = await computeMessageTokenCount(userId, body.content, body.connection_id);
    if (tokenCount != null) {
      const baseExtra = body.extra ?? svc.getMessage(userId, messageId)?.extra ?? {};
      body.extra = { ...baseExtra, tokenCount };
    }
  }

  const msg = svc.updateMessage(userId, messageId, body);
  if (!msg) return c.json({ error: "Not found" }, 404);
  return c.json(msg);
});

app.delete("/:chatId/messages/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteMessage(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.delete("/:chatId/messages/:id/attachments/:imageId", (c) => {
  const userId = c.get("userId");
  const updated = svc.removeMessageAttachment(userId, c.req.param("id"), c.req.param("imageId"));
  if (!updated) return c.json({ error: "Message not found" }, 404);
  return c.json(updated);
});

app.post("/:chatId/messages/:id/swipe", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const messageId = c.req.param("id");
  const body = await c.req.json();
  let msg = null;

  if (body.direction === "left" || body.direction === "right") {
    msg = svc.cycleSwipe(userId, messageId, body.direction);
  } else if (body.content !== undefined) {
    const processed = await runMessageContentProcessors(
      {
        chatId,
        messageId,
        content: body.content,
        origin: "swipe_add",
        userId,
      },
      userId,
      c.req.raw.signal,
    );
    msg = svc.addSwipe(userId, messageId, processed.content);
  } else {
    return c.json({ error: "direction or content is required" }, 400);
  }

  if (!msg) return c.json({ error: "Not found" }, 404);
  return c.json(msg);
});

app.put("/:chatId/messages/:id/swipe/:idx", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const messageId = c.req.param("id");
  const body = await c.req.json();
  if (body.content === undefined) return c.json({ error: "content is required" }, 400);
  const idx = parseInt(c.req.param("idx"), 10);

  const processed = await runMessageContentProcessors(
    {
      chatId,
      messageId,
      content: body.content,
      origin: "swipe_update",
      swipeIndex: idx,
      userId,
    },
    userId,
    c.req.raw.signal,
  );

  let finalContent = processed.content;
  const chat = svc.getChat(userId, chatId);
  if (chat) {
    const editScripts = regexScriptsSvc.getRunOnEditScripts(userId, {
      characterId: chat.character_id ?? undefined,
      chatId,
    });
    if (editScripts.length > 0) {
      const existing = svc.getMessage(userId, messageId);
      const placement = existing?.is_user ? "user_input" as const : "ai_output" as const;
      finalContent = await regexScriptsSvc.applyRegexScripts(
        finalContent,
        editScripts,
        placement,
        0,
      );
    }
  }

  const msg = svc.updateSwipe(userId, messageId, idx, finalContent);
  if (!msg) return c.json({ error: "Not found or invalid swipe index" }, 404);
  return c.json(msg);
});

app.delete("/:chatId/messages/:id/swipe/:idx", (c) => {
  const userId = c.get("userId");
  const idx = parseInt(c.req.param("idx"), 10);
  const msg = svc.deleteSwipe(userId, c.req.param("id"), idx);
  if (!msg) return c.json({ error: "Not found, invalid index, or last swipe" }, 404);
  return c.json(msg);
});

app.post("/:chatId/display-preprocess", async (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const body = await c.req.json().catch(() => null);

  if (body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)) {
    const rawItems = (body as { items: unknown[] }).items;
    if (rawItems.length > DISPLAY_PREPROCESS_BATCH_MAX) {
      return c.json({ error: `items must contain at most ${DISPLAY_PREPROCESS_BATCH_MAX} entries` }, 400);
    }

    const items = rawItems.map(parseDisplayPreprocessItem);
    if (items.some((item) => item === null)) {
      return c.json({ error: "each item requires rawContent (string)" }, 400);
    }

    const processed = await Promise.all(
      (items as DisplayPreprocessItem[]).map((item) =>
        runDisplayPreprocessItem(userId, chatId, item, c.req.raw.signal)
      )
    );

    return c.json({ items: processed });
  }

  const item = parseDisplayPreprocessItem(body);
  if (!item) {
    return c.json({ error: "rawContent (string) required" }, 400);
  }

  const processed = await runDisplayPreprocessItem(userId, chatId, item, c.req.raw.signal);
  return c.json({ content: processed.content });
});

export { app as chatsRoutes };

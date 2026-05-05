import { Hono } from "hono";
import * as svc from "../services/chats.service";
import * as personasSvc from "../services/personas.service";
import * as charactersSvc from "../services/characters.service";
import { parsePagination } from "../services/pagination";
import { RECENT_CHATS_DEFAULT_LIMIT } from "../types/pagination";
import { parseStChatJsonl, parseStGroupChatJsonl } from "../migration/st-reader";
import {
  messageContentProcessorChain,
  type MessageContentProcessorCtx,
} from "../spindle/message-content-processor";

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
  return c.json(svc.listRecentChatsGrouped(userId, pagination));
});

app.get("/character-chats/:characterId", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  return c.json(svc.listChatSummaries(userId, characterId));
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

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const chat = svc.getChat(userId, c.req.param("id"));
  if (!chat) return c.json({ error: "Not found" }, 404);
  if (c.req.query("messages") === "false") return c.json(chat);
  const messages = svc.getMessages(userId, chat.id);
  return c.json({ ...chat, messages });
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const chat = svc.getChat(userId, c.req.param("id"));
  if (!chat) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json();
  const updated = svc.updateChat(userId, chat.id, body);
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
  const partial: Record<string, any> = {};
  for (const [key, value] of Object.entries(body)) {
    partial[key] = value === null ? undefined : value;
  }
  const updated = svc.mergeChatMetadata(userId, chatId, partial);
  if (!updated) return c.json({ error: "Not found" }, 404);
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
  const branch = svc.branchChat(userId, c.req.param("id"), body.message_id);
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

  // tail=true fetches the last N messages efficiently (single index scan from end)
  if (c.req.query("tail") === "true") {
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") || "50", 10) || 50, 1), 1000);
    return c.json(svc.listMessagesTail(userId, chatId, limit));
  }

  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listMessages(userId, chatId, pagination));
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

  const msg = svc.createMessage(chatId, body, userId);
  return c.json(msg, 201);
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

  const msg = svc.updateSwipe(userId, messageId, idx, processed.content);
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
  const body = (await c.req.json().catch(() => null)) as {
    messageId?: unknown;
    messageIndex?: unknown;
    role?: unknown;
    rawContent?: unknown;
  } | null;
  if (!body || typeof body.rawContent !== "string") {
    return c.json({ error: "rawContent (string) required" }, 400);
  }
  if (messageContentProcessorChain.count === 0) {
    return c.json({ content: body.rawContent });
  }
  const role = typeof body.role === "string" ? body.role : undefined;
  const processed = await messageContentProcessorChain.run({
    chatId,
    content: body.rawContent,
    origin: "render",
    userId,
    ...(typeof body.messageId === "string" ? { messageId: body.messageId } : {}),
    extra: {
      ...(typeof body.messageIndex === "number" ? { messageIndex: body.messageIndex } : {}),
      ...(role ? { role, is_user: role === "user" } : {}),
    },
  }, userId, c.req.raw.signal);
  return c.json({ content: processed.content ?? body.rawContent });
});

export { app as chatsRoutes };

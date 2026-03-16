import { Hono } from "hono";
import * as svc from "../services/chats.service";
import * as personasSvc from "../services/personas.service";
import { parsePagination } from "../services/pagination";
import { RECENT_CHATS_DEFAULT_LIMIT } from "../types/pagination";

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

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.character_id) return c.json({ error: "character_id is required" }, 400);
  const chat = svc.createChat(userId, body);
  return c.json(chat, 201);
});

app.post("/group", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!Array.isArray(body.character_ids) || body.character_ids.length < 2) {
    return c.json({ error: "character_ids must be an array with at least 2 entries" }, 400);
  }
  const chat = svc.createGroupChat(userId, body);
  return c.json(chat, 201);
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const chat = svc.getChat(userId, c.req.param("id"));
  if (!chat) return c.json({ error: "Not found" }, 404);
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

    const msgCount = svc.bulkInsertMessages(chat.id, bulkMessages);

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

  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listMessages(userId, chatId, pagination));
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

  const msg = svc.createMessage(chatId, body, userId);
  return c.json(msg, 201);
});

app.put("/:chatId/messages/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const msg = svc.updateMessage(userId, c.req.param("id"), body);
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
  const body = await c.req.json();
  let msg = null;

  if (body.direction === "left" || body.direction === "right") {
    msg = svc.cycleSwipe(userId, c.req.param("id"), body.direction);
  } else if (body.content !== undefined) {
    msg = svc.addSwipe(userId, c.req.param("id"), body.content);
  } else {
    return c.json({ error: "direction or content is required" }, 400);
  }

  if (!msg) return c.json({ error: "Not found" }, 404);
  return c.json(msg);
});

app.put("/:chatId/messages/:id/swipe/:idx", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (body.content === undefined) return c.json({ error: "content is required" }, 400);
  const idx = parseInt(c.req.param("idx"), 10);
  const msg = svc.updateSwipe(userId, c.req.param("id"), idx, body.content);
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

export { app as chatsRoutes };

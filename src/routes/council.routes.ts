import { Hono } from "hono";
import * as councilSettingsSvc from "../services/council/council-settings.service";
import * as councilProfilesSvc from "../services/council/council-profiles.service";
import * as chatsSvc from "../services/chats.service";

const app = new Hono();

// GET /api/v1/council/settings
app.get("/settings", (c) => {
  const userId = c.get("userId");
  return c.json(councilSettingsSvc.getCouncilSettings(userId));
});

// PUT /api/v1/council/settings
app.put("/settings", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const updated = councilSettingsSvc.putCouncilSettings(userId, body);
  return c.json(updated);
});

app.get("/settings/defaults", (c) => {
  const userId = c.get("userId");
  const binding = councilProfilesSvc.getDefaults(userId);
  if (!binding) return c.json({ error: "No default council profile" }, 404);
  return c.json(binding);
});

app.put("/settings/defaults", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const updated = councilProfilesSvc.putDefaults(userId, body ?? {});
  return c.json(updated);
});

app.delete("/settings/defaults", (c) => {
  const userId = c.get("userId");
  if (!councilProfilesSvc.deleteDefaults(userId)) {
    return c.json({ error: "No default council profile" }, 404);
  }
  return c.json({ success: true });
});

app.get("/settings/character/:characterId", (c) => {
  const userId = c.get("userId");
  const binding = councilProfilesSvc.getCharacterBinding(userId, c.req.param("characterId"));
  if (!binding) return c.json({ error: "No binding for this character" }, 404);
  return c.json(binding);
});

app.put("/settings/character/:characterId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const updated = councilProfilesSvc.putCharacterBinding(
      userId,
      c.req.param("characterId"),
      body ?? {},
    );
    return c.json(updated);
  } catch (e: any) {
    if (e.message === "Character not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/settings/character/:characterId", (c) => {
  const userId = c.get("userId");
  if (!councilProfilesSvc.deleteCharacterBinding(userId, c.req.param("characterId"))) {
    return c.json({ error: "No binding for this character" }, 404);
  }
  return c.json({ success: true });
});

app.get("/settings/chat/:chatId", (c) => {
  const userId = c.get("userId");
  const binding = councilProfilesSvc.getChatBinding(userId, c.req.param("chatId"));
  if (!binding) return c.json({ error: "No binding for this chat" }, 404);
  return c.json(binding);
});

app.put("/settings/chat/:chatId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const updated = councilProfilesSvc.putChatBinding(
      userId,
      c.req.param("chatId"),
      body ?? {},
    );
    return c.json(updated);
  } catch (e: any) {
    if (e.message === "Chat not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/settings/chat/:chatId", (c) => {
  const userId = c.get("userId");
  if (!councilProfilesSvc.deleteChatBinding(userId, c.req.param("chatId"))) {
    return c.json({ error: "No binding for this chat" }, 404);
  }
  return c.json({ success: true });
});

app.get("/settings/resolve/:chatId", (c) => {
  const userId = c.get("userId");
  const chatId = c.req.param("chatId");
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const resolved = councilProfilesSvc.resolveProfile(userId, chatId, chat.character_id, {
    isGroup: chat.metadata?.group === true,
  });
  return c.json(resolved);
});

// GET /api/v1/council/tools
app.get("/tools", async (c) => {
  const userId = c.get("userId");
  const tools = await councilSettingsSvc.getAvailableTools(userId);
  return c.json(tools);
});

export { app as councilRoutes };

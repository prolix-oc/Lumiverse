import { Hono } from "hono";
import * as svc from "../services/preset-profiles.service";
import * as chatsSvc from "../services/chats.service";

const app = new Hono();

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

app.get("/defaults", (c) => {
  const userId = c.get("userId");
  const defaults = svc.getDefaults(userId);
  if (!defaults) return c.json({ error: "No defaults captured" }, 404);
  return c.json(defaults);
});

app.put("/defaults", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.preset_id || !body.block_states) {
    return c.json({ error: "preset_id and block_states are required" }, 400);
  }
  const binding = svc.captureDefaults(userId, body.preset_id, body.block_states);
  return c.json(binding);
});

app.delete("/defaults", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteDefaults(userId)) return c.json({ error: "No defaults to delete" }, 404);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Character bindings
// ---------------------------------------------------------------------------

app.get("/character/:characterId", (c) => {
  const userId = c.get("userId");
  const binding = svc.getCharacterBinding(userId, c.req.param("characterId"));
  if (!binding) return c.json({ error: "No binding for this character" }, 404);
  return c.json(binding);
});

app.put("/character/:characterId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.preset_id || !body.block_states) {
    return c.json({ error: "preset_id and block_states are required" }, 400);
  }
  try {
    const binding = svc.setCharacterBinding(
      userId,
      c.req.param("characterId"),
      body.preset_id,
      body.block_states
    );
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Character not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/character/:characterId", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteCharacterBinding(userId, c.req.param("characterId"))) {
    return c.json({ error: "No binding for this character" }, 404);
  }
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Chat bindings
// ---------------------------------------------------------------------------

app.get("/chat/:chatId", (c) => {
  const userId = c.get("userId");
  const binding = svc.getChatBinding(userId, c.req.param("chatId"));
  if (!binding) return c.json({ error: "No binding for this chat" }, 404);
  return c.json(binding);
});

app.put("/chat/:chatId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.preset_id) {
    return c.json({ error: "preset_id is required" }, 400);
  }
  if (!body.block_states && !body.linked_to_defaults) {
    return c.json({ error: "block_states or linked_to_defaults is required" }, 400);
  }
  try {
    const binding = svc.setChatBinding(
      userId,
      c.req.param("chatId"),
      body.preset_id,
      body.block_states || null,
      body.linked_to_defaults
    );
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Chat not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/chat/:chatId", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteChatBinding(userId, c.req.param("chatId"))) {
    return c.json({ error: "No binding for this chat" }, 404);
  }
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Resolution — resolve the effective binding for a chat context
// ---------------------------------------------------------------------------

app.get("/resolve/:chatId", (c) => {
  const userId = c.get("userId");
  const presetId = c.req.query("preset_id");
  if (!presetId) return c.json({ error: "preset_id query param is required" }, 400);

  const chatId = c.req.param("chatId");

  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const resolved = svc.resolveProfile(userId, presetId, chatId, chat.character_id, {
    isGroup: chat.metadata?.group === true,
  });
  return c.json(resolved);
});

export { app as presetProfilesRoutes };

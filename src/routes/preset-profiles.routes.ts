import { Hono } from "hono";
import * as svc from "../services/preset-profiles.service";
import * as chatsSvc from "../services/chats.service";
import * as personasSvc from "../services/personas.service";

const app = new Hono();

// All editor snapshots for one context. Missing bindings are normal and do
// not require five independent 404 responses from the client.
app.get("/context", (c) => {
  const userId = c.get("userId");
  const query = c.req.query();
  // Preserve the independent endpoints' failure isolation and user scoping.
  const errors: Record<string, string> = {};
  const read = <T>(section: string, load: () => T): T | null => {
    try { return load(); } catch { errors[section] = 'unavailable'; return null; }
  };
  return c.json({
    defaults: query.preset_id ? read('defaults', () => svc.getDefaults(userId, query.preset_id)) : null,
    chat: query.chat_id ? read('chat', () => svc.getChatBinding(userId, query.chat_id)) : null,
    persona: query.persona_id ? read('persona', () => svc.getPersonaBinding(userId, query.persona_id)) : null,
    character: query.character_id && query.is_group !== 'true'
      ? read('character', () => svc.getCharacterBinding(userId, query.character_id)) : null,
    connection: query.connection_id ? read('connection', () => svc.getConnectionBinding(userId, query.connection_id)) : null,
    errors,
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

app.get("/defaults", (c) => {
  const userId = c.get("userId");
  const presetId = c.req.query("preset_id");
  if (!presetId) return c.json({ error: "preset_id query param is required" }, 400);

  const defaults = svc.getDefaults(userId, presetId);
  if (!defaults) return c.json({ error: "No defaults captured" }, 404);
  return c.json(defaults);
});

app.put("/defaults", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.preset_id || !body.block_states) {
    return c.json({ error: "preset_id and block_states are required" }, 400);
  }
  try {
    const binding = svc.captureDefaults(userId, body.preset_id, body.block_states, body.prompt_variables);
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Preset not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/defaults", (c) => {
  const userId = c.get("userId");
  const presetId = c.req.query("preset_id");
  if (!presetId) return c.json({ error: "preset_id query param is required" }, 400);

  if (!svc.deleteDefaults(userId, presetId)) return c.json({ error: "No defaults to delete" }, 404);
  return c.json({ success: true });
});

app.patch("/defaults/prompt-variables", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.preset_id || !body.prompt_variables || typeof body.prompt_variables !== "object" || Array.isArray(body.prompt_variables)) {
    return c.json({ error: "preset_id and prompt_variables are required" }, 400);
  }
  try {
    return c.json(svc.updateDefaultsPromptVariables(userId, body.preset_id, body.prompt_variables));
  } catch (e: any) {
    if (e.message === "No defaults captured") return c.json({ error: e.message }, 404);
    throw e;
  }
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
      body.block_states,
      body.prompt_variables,
    );
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Character not found") return c.json({ error: e.message }, 404);
    if (e.message === "Preset not found") return c.json({ error: e.message }, 404);
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

app.patch("/character/:characterId/prompt-variables", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.prompt_variables || typeof body.prompt_variables !== "object" || Array.isArray(body.prompt_variables)) {
    return c.json({ error: "prompt_variables is required" }, 400);
  }
  try {
    return c.json(svc.updateCharacterPromptVariables(userId, c.req.param("characterId"), body.prompt_variables));
  } catch (e: any) {
    if (e.message === "No profile binding found" || e.message === "No defaults captured") return c.json({ error: e.message }, 404);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Persona bindings
// ---------------------------------------------------------------------------

app.get("/persona/:personaId", (c) => {
  const userId = c.get("userId");
  const binding = svc.getPersonaBinding(userId, c.req.param("personaId"));
  if (!binding) return c.json({ error: "No binding for this persona" }, 404);
  return c.json(binding);
});

app.put("/persona/:personaId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.preset_id || !body.block_states) {
    return c.json({ error: "preset_id and block_states are required" }, 400);
  }
  try {
    const binding = svc.setPersonaBinding(
      userId,
      c.req.param("personaId"),
      body.preset_id,
      body.block_states,
      body.prompt_variables,
    );
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Persona not found") return c.json({ error: e.message }, 404);
    if (e.message === "Preset not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/persona/:personaId", (c) => {
  const userId = c.get("userId");
  if (!svc.deletePersonaBinding(userId, c.req.param("personaId"))) {
    return c.json({ error: "No binding for this persona" }, 404);
  }
  return c.json({ success: true });
});

app.patch("/persona/:personaId/prompt-variables", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.prompt_variables || typeof body.prompt_variables !== "object" || Array.isArray(body.prompt_variables)) {
    return c.json({ error: "prompt_variables is required" }, 400);
  }
  try {
    return c.json(svc.updatePersonaPromptVariables(userId, c.req.param("personaId"), body.prompt_variables));
  } catch (e: any) {
    if (e.message === "No profile binding found" || e.message === "No defaults captured") return c.json({ error: e.message }, 404);
    throw e;
  }
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
      body.prompt_variables,
      body.linked_to_defaults
    );
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Chat not found") return c.json({ error: e.message }, 404);
    if (e.message === "Preset not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.patch("/chat/:chatId/prompt-variables", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.prompt_variables || typeof body.prompt_variables !== "object" || Array.isArray(body.prompt_variables)) {
    return c.json({ error: "prompt_variables is required" }, 400);
  }
  try {
    return c.json(svc.updateChatPromptVariables(userId, c.req.param("chatId"), body.prompt_variables));
  } catch (e: any) {
    if (e.message === "No profile binding found" || e.message === "No defaults captured") {
      return c.json({ error: e.message }, 404);
    }
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
// Connection profile bindings
// ---------------------------------------------------------------------------

app.get("/connection/:connectionId", (c) => {
  const userId = c.get("userId");
  const binding = svc.getConnectionBinding(userId, c.req.param("connectionId"));
  if (!binding) return c.json({ error: "No binding for this connection" }, 404);
  return c.json(binding);
});

app.put("/connection/:connectionId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.preset_id || !body.block_states) {
    return c.json({ error: "preset_id and block_states are required" }, 400);
  }
  try {
    const binding = svc.setConnectionBinding(
      userId,
      c.req.param("connectionId"),
      body.preset_id,
      body.block_states,
      body.prompt_variables,
    );
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Connection not found") return c.json({ error: e.message }, 404);
    if (e.message === "Preset not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/connection/:connectionId", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteConnectionBinding(userId, c.req.param("connectionId"))) {
    return c.json({ error: "No binding for this connection" }, 404);
  }
  return c.json({ success: true });
});

app.patch("/connection/:connectionId/prompt-variables", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.prompt_variables || typeof body.prompt_variables !== "object" || Array.isArray(body.prompt_variables)) {
    return c.json({ error: "prompt_variables is required" }, 400);
  }
  try {
    return c.json(svc.updateConnectionPromptVariables(userId, c.req.param("connectionId"), body.prompt_variables));
  } catch (e: any) {
    if (e.message === "No profile binding found" || e.message === "No defaults captured") return c.json({ error: e.message }, 404);
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Resolution — resolve the effective binding for a chat context
// ---------------------------------------------------------------------------

app.get("/resolve/:chatId", async (c) => {
  const userId = c.get("userId");
  const presetId = c.req.query("preset_id");
  const connectionId = c.req.query("connection_id") || null;
  const requestedPersonaId = c.req.query("persona_id") || null;

  const chatId = c.req.param("chatId");

  const chat = await chatsSvc.getChatAsync(userId, chatId);
  if (!chat) return c.json({ error: "Chat not found" }, 404);

  const resolved = svc.resolveProfile(userId, presetId ?? null, chatId, chat.character_id, {
    isGroup: chat.metadata?.group === true,
    connectionId,
    personaId: requestedPersonaId ?? (await personasSvc.resolvePersonaOrDefaultAsync(userId))?.id ?? null,
  });
  return c.json(resolved);
});

export { app as presetProfilesRoutes };

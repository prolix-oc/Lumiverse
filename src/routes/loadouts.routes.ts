import { Hono } from "hono";
import * as svc from "../services/loadouts.service";

const app = new Hono();

// ---------------------------------------------------------------------------
// Loadout CRUD
// ---------------------------------------------------------------------------

app.get("/", (c) => {
  const userId = c.get("userId");
  return c.json(svc.getAllLoadouts(userId));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const loadout = svc.createLoadout(userId, body.name, body.snapshot);
  return c.json(loadout, 201);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const loadout = svc.updateLoadout(userId, c.req.param("id"), body);
  if (!loadout) return c.json({ error: "Not found" }, 404);
  return c.json(loadout);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteLoadout(userId, c.req.param("id"))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ success: true });
});

app.post("/:id/apply", (c) => {
  const userId = c.get("userId");
  const loadout = svc.getLoadout(userId, c.req.param("id"));
  if (!loadout) return c.json({ error: "Not found" }, 404);
  svc.applySnapshot(userId, loadout.snapshot);
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Character bindings
// ---------------------------------------------------------------------------

app.get("/bindings/character/:characterId", (c) => {
  const userId = c.get("userId");
  const binding = svc.getCharacterBinding(userId, c.req.param("characterId"));
  if (!binding) return c.json({ error: "No binding for this character" }, 404);
  return c.json(binding);
});

app.put("/bindings/character/:characterId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.loadout_id) return c.json({ error: "loadout_id is required" }, 400);
  try {
    const binding = svc.setCharacterBinding(userId, c.req.param("characterId"), body.loadout_id);
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Loadout not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/bindings/character/:characterId", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteCharacterBinding(userId, c.req.param("characterId"))) {
    return c.json({ error: "No binding for this character" }, 404);
  }
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Chat bindings
// ---------------------------------------------------------------------------

app.get("/bindings/chat/:chatId", (c) => {
  const userId = c.get("userId");
  const binding = svc.getChatBinding(userId, c.req.param("chatId"));
  if (!binding) return c.json({ error: "No binding for this chat" }, 404);
  return c.json(binding);
});

app.put("/bindings/chat/:chatId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.loadout_id) return c.json({ error: "loadout_id is required" }, 400);
  try {
    const binding = svc.setChatBinding(userId, c.req.param("chatId"), body.loadout_id);
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Chat not found" || e.message === "Loadout not found") {
      return c.json({ error: e.message }, 404);
    }
    throw e;
  }
});

app.delete("/bindings/chat/:chatId", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteChatBinding(userId, c.req.param("chatId"))) {
    return c.json({ error: "No binding for this chat" }, 404);
  }
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

app.get("/resolve/:chatId", (c) => {
  const userId = c.get("userId");
  const resolved = svc.resolveLoadout(userId, c.req.param("chatId"));
  return c.json(resolved);
});

export { app as loadoutsRoutes };

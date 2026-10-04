import { Hono } from "hono";
import * as charactersSvc from "../services/characters.service";
import * as connectionsSvc from "../services/connections.service";

/**
 * Per-character connection bindings ("bind to char").
 *
 * `GET /:characterId` → `{ connection_id: string | null }` — null means
 * unbound. Deliberately 200-with-null (rather than the preset-profiles
 * 404-on-unbound) because "no binding" is the default state of every
 * character, not a missing resource.
 *
 * `PUT /:characterId` body `{ connection_id: string | null }` — a non-empty
 * string binds, `null` or an absent `connection_id` clears, and anything else
 * (empty string, numbers, objects) is a 400 rather than a silent clear: a
 * client that fails to serialize its selection should hear about it. Returns
 * the resulting `{ connection_id }`.
 *
 * Error mapping follows the preset-profiles route conventions: unknown
 * character → 404, unknown connection → 404 (`"Connection not found"` from
 * the service, same string the preset-profiles connection binding maps).
 */
const app = new Hono();

app.get("/:characterId", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");
  // The service getter is a deliberately raw read (resolution degrades
  // gracefully), so existence is checked here — an unknown character is a
  // missing resource, distinct from a known character with no binding.
  if (!charactersSvc.getCharacter(userId, characterId)) {
    return c.json({ error: "Character not found" }, 404);
  }
  return c.json({ connection_id: connectionsSvc.getCharacterConnectionBind(userId, characterId) });
});

app.put("/:characterId", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("characterId");

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object" }, 400);
  }
  const requested = (body as Record<string, unknown>).connection_id;
  if (requested !== undefined && requested !== null
    && (typeof requested !== "string" || requested.trim() === "")) {
    return c.json({ error: "connection_id must be a non-empty string or null" }, 400);
  }

  // One existence check covers both branches (the bind path re-validates in
  // the service for direct callers; the clear path would otherwise be a
  // blind write against a possibly-foreign character id).
  if (!charactersSvc.getCharacter(userId, characterId)) {
    return c.json({ error: "Character not found" }, 404);
  }

  if (requested == null) {
    connectionsSvc.clearCharacterConnectionBind(userId, characterId);
    return c.json({ connection_id: null });
  }

  try {
    const connectionId = connectionsSvc.setCharacterConnectionBind(userId, characterId, requested);
    return c.json({ connection_id: connectionId });
  } catch (e: any) {
    if (e.message === "Connection not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

export { app as characterConnectionBindsRoutes };

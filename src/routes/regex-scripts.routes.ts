import { Hono } from "hono";
import * as svc from "../services/regex-scripts.service";
import { parsePagination } from "../services/pagination";
import type { RegexScope, RegexTarget } from "../types/regex-script";

const app = new Hono();

// GET / — list regex scripts (paginated, filterable)
app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const filters: { scope?: RegexScope; target?: RegexTarget; character_id?: string; chat_id?: string } = {};
  const scope = c.req.query("scope");
  if (scope) filters.scope = scope as RegexScope;
  const target = c.req.query("target");
  if (target) filters.target = target as RegexTarget;
  const characterId = c.req.query("character_id");
  if (characterId) filters.character_id = characterId;
  const chatId = c.req.query("chat_id");
  if (chatId) filters.chat_id = chatId;

  return c.json(svc.listRegexScripts(userId, pagination, Object.keys(filters).length > 0 ? filters : undefined));
});

// GET /active — resolved active scripts for pipeline
app.get("/active", (c) => {
  const userId = c.get("userId");
  const target = c.req.query("target") as RegexTarget;
  if (!target) return c.json({ error: "target query param is required" }, 400);
  const characterId = c.req.query("character_id");
  const chatId = c.req.query("chat_id");
  return c.json(svc.getActiveScripts(userId, { characterId: characterId || undefined, chatId: chatId || undefined, target }));
});

// POST /preset-activation — activate preset-bound regex state for a preset
app.post("/preset-activation", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  return c.json(svc.activatePresetBoundRegexScripts(userId, body?.preset_id ?? null));
});

// POST /preset-switch — snapshot outgoing preset state and activate the next preset
app.post("/preset-switch", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  return c.json(svc.switchPresetBoundRegexScripts(userId, {
    previousPresetId: body?.previous_preset_id ?? null,
    presetId: body?.preset_id ?? null,
  }));
});

// POST / — create
app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { active_preset_id, ...input } = body ?? {};
  const result = svc.createRegexScript(userId, input, { activePresetId: active_preset_id ?? null });
  if (typeof result === "string") return c.json({ error: result }, 400);
  return c.json(result, 201);
});

// POST /test — test regex
app.post("/test", async (c) => {
  const userId = c.get("userId");
  const { find_regex, replace_string, flags, content } = await c.req.json();
  if (!find_regex || content === undefined) return c.json({ error: "find_regex and content are required" }, 400);
  return c.json(await svc.testRegex(find_regex, replace_string ?? "", flags ?? "gi", content));
});

// POST /export — export scripts
app.post("/export", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  return c.json(svc.exportRegexScripts(userId, body?.ids));
});

// POST /import — import scripts
app.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  return c.json(svc.importRegexScripts(userId, body, { activePresetId: body?.active_preset_id ?? null }), 201);
});

// PUT /reorder — bulk reorder
app.put("/reorder", async (c) => {
  const userId = c.get("userId");
  const { ids } = await c.req.json();
  if (!Array.isArray(ids)) return c.json({ error: "ids must be an array" }, 400);
  svc.reorderRegexScripts(userId, ids);
  return c.json({ success: true });
});

// POST /bulk-delete — delete many scripts in one transaction
app.post("/bulk-delete", async (c) => {
  const userId = c.get("userId");
  const { ids } = await c.req.json();
  if (!Array.isArray(ids)) return c.json({ error: "ids must be an array" }, 400);
  const stringIds = ids.filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
  const deleted = svc.deleteRegexScripts(userId, stringIds);
  return c.json({ deleted, count: deleted.length });
});

// GET /:id — get by ID
app.get("/:id", (c) => {
  const userId = c.get("userId");
  const script = svc.getRegexScript(userId, c.req.param("id"));
  if (!script) return c.json({ error: "Not found" }, 404);
  return c.json(script);
});

// PUT /:id — update
app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { active_preset_id, ...input } = body ?? {};
  const result = svc.updateRegexScript(userId, c.req.param("id"), input, { activePresetId: active_preset_id ?? null });
  if (result === null) return c.json({ error: "Not found" }, 404);
  if (typeof result === "string") return c.json({ error: result }, 400);
  return c.json(result);
});

// DELETE /:id — delete
app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteRegexScript(userId, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// POST /:id/duplicate — duplicate
app.post("/:id/duplicate", (c) => {
  const userId = c.get("userId");
  const script = svc.duplicateRegexScript(userId, c.req.param("id"));
  if (!script) return c.json({ error: "Not found" }, 404);
  return c.json(script, 201);
});

// PUT /:id/toggle — quick enable/disable
app.put("/:id/toggle", async (c) => {
  const userId = c.get("userId");
  const { disabled, active_preset_id } = await c.req.json();
  const script = svc.toggleRegexScript(userId, c.req.param("id"), !!disabled, { activePresetId: active_preset_id ?? null });
  if (!script) return c.json({ error: "Not found" }, 404);
  return c.json(script);
});

export { app as regexScriptsRoutes };

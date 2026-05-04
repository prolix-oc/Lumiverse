import { Hono } from "hono";
import * as svc from "../services/regex-scripts.service";
import { parsePagination } from "../services/pagination";
import { applyDisplayRegex } from "../services/display-regex.service";
import type { RegexMacroMode, RegexPlacement, RegexScope, RegexScript, RegexTarget } from "../types/regex-script";

const app = new Hono();

const APPLY_MAX_CONTENT_LENGTH = 500_000;
const APPLY_MAX_SCRIPT_COUNT = 500;
const APPLY_MAX_PATTERN_LENGTH = 10_000;
const APPLY_MAX_RESOLVED_TEMPLATE_LENGTH = 100_000;
const APPLY_VALID_PLACEMENTS = new Set<RegexPlacement>(["user_input", "ai_output", "world_info", "reasoning"]);
const APPLY_VALID_FLAGS = new Set(["g", "i", "m", "s", "u"]);
const APPLY_VALID_MACRO_MODES = new Set<RegexMacroMode>(["none", "raw", "escaped"]);

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResolvedMap(value: unknown): Map<string, string> | undefined {
  if (!isStringRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => (
    typeof entry[0] === "string" &&
    typeof entry[1] === "string" &&
    entry[1].length <= APPLY_MAX_RESOLVED_TEMPLATE_LENGTH
  ));
  return entries.length > 0 ? new Map(entries) : undefined;
}

function validateFlags(flags: string): boolean {
  if (new Set(flags).size !== flags.length) return false;
  return flags.split("").every((flag) => APPLY_VALID_FLAGS.has(flag));
}

function normalizeDisplayScripts(value: unknown, userId: string): RegexScript[] | string {
  if (!Array.isArray(value)) return "scripts must be an array";
  if (value.length > APPLY_MAX_SCRIPT_COUNT) return `scripts exceeds maximum length (${APPLY_MAX_SCRIPT_COUNT})`;

  const scripts: RegexScript[] = [];
  for (const raw of value) {
    if (!isStringRecord(raw)) return "scripts contains an invalid entry";

    const id = typeof raw.id === "string" ? raw.id : "";
    const findRegex = typeof raw.find_regex === "string" ? raw.find_regex : undefined;
    const replaceString = typeof raw.replace_string === "string" ? raw.replace_string : "";
    const flags = typeof raw.flags === "string" ? raw.flags : "gi";
    const placement = raw.placement;
    const target = raw.target;
    const substituteMacros = raw.substitute_macros;

    if (!id) return "script id is required";
    if (findRegex === undefined) return "script find_regex is required";
    if (findRegex.length > APPLY_MAX_PATTERN_LENGTH) return "script find_regex exceeds maximum length";
    if (!validateFlags(flags)) return "script flags are invalid";
    if (!Array.isArray(placement) || !placement.every((p): p is RegexPlacement => (
      typeof p === "string" && APPLY_VALID_PLACEMENTS.has(p as RegexPlacement)
    ))) {
      return "script placement is invalid";
    }
    if (target !== "display") return "only display regex scripts can be applied";
    if (!APPLY_VALID_MACRO_MODES.has(substituteMacros as RegexMacroMode)) return "script substitute_macros is invalid";

    scripts.push({
      id,
      user_id: userId,
      name: typeof raw.name === "string" ? raw.name : "Display Regex",
      script_id: typeof raw.script_id === "string" ? raw.script_id : id,
      find_regex: findRegex,
      replace_string: replaceString,
      flags,
      placement,
      scope: raw.scope === "character" || raw.scope === "chat" ? raw.scope : "global",
      scope_id: typeof raw.scope_id === "string" ? raw.scope_id : null,
      target,
      min_depth: typeof raw.min_depth === "number" ? raw.min_depth : null,
      max_depth: typeof raw.max_depth === "number" ? raw.max_depth : null,
      trim_strings: Array.isArray(raw.trim_strings)
        ? raw.trim_strings.filter((trim): trim is string => typeof trim === "string")
        : [],
      run_on_edit: !!raw.run_on_edit,
      substitute_macros: substituteMacros as RegexMacroMode,
      disabled: !!raw.disabled,
      sort_order: typeof raw.sort_order === "number" ? raw.sort_order : 0,
      description: typeof raw.description === "string" ? raw.description : "",
      folder: typeof raw.folder === "string" ? raw.folder : "",
      pack_id: typeof raw.pack_id === "string" ? raw.pack_id : null,
      preset_id: typeof raw.preset_id === "string" ? raw.preset_id : null,
      character_id: typeof raw.character_id === "string" ? raw.character_id : null,
      metadata: isStringRecord(raw.metadata) ? raw.metadata : {},
      created_at: typeof raw.created_at === "number" ? raw.created_at : 0,
      updated_at: typeof raw.updated_at === "number" ? raw.updated_at : 0,
    });
  }

  return scripts;
}

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

// POST /apply — apply display regex using the backend sandboxed regex engine.
app.post("/apply", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!isStringRecord(body)) return c.json({ error: "invalid request body" }, 400);

  const content = body.content;
  if (typeof content !== "string") return c.json({ error: "content is required" }, 400);
  if (content.length > APPLY_MAX_CONTENT_LENGTH) return c.json({ error: "content exceeds maximum length" }, 413);

  const scripts = normalizeDisplayScripts(body.scripts, userId);
  if (typeof scripts === "string") return c.json({ error: scripts }, 400);

  const context = body.context;
  if (!isStringRecord(context)) return c.json({ error: "context is required" }, 400);

  const dynamicMacros = isStringRecord(body.dynamic_macros)
    ? Object.fromEntries(Object.entries(body.dynamic_macros).filter(([, v]) => typeof v === "string")) as Record<string, string>
    : undefined;

  const result = await applyDisplayRegex({
    content,
    scripts: scripts.filter((script) => !script.disabled),
    context: {
      chat_id: typeof context.chat_id === "string" ? context.chat_id : undefined,
      character_id: typeof context.character_id === "string" ? context.character_id : undefined,
      persona_id: typeof context.persona_id === "string" ? context.persona_id : undefined,
      is_user: !!context.is_user,
      depth: typeof context.depth === "number" ? context.depth : 0,
    },
    userId,
    resolvedFindPatterns: normalizeResolvedMap(body.resolved_find_patterns),
    resolvedReplacements: normalizeResolvedMap(body.resolved_replacements),
    dynamicMacros,
  });

  return c.json({ result });
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
  return c.json(svc.exportRegexScripts(userId, {
    ids: body?.ids,
    presetId: body?.preset_id,
    folder: body?.folder,
  }));
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

// POST /:id/report-performance — persist slow/timed-out regex warning metadata
app.post("/:id/report-performance", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const elapsedMs = Number(body?.elapsed_ms);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return c.json({ error: "elapsed_ms must be a non-negative number" }, 400);
  }

  const result = svc.reportRegexScriptPerformance(userId, c.req.param("id"), {
    elapsedMs,
    timedOut: !!body?.timed_out,
    thresholdMs: Number.isFinite(Number(body?.threshold_ms)) ? Number(body.threshold_ms) : undefined,
    source: typeof body?.source === "string" ? body.source : undefined,
  });
  if (!result.script) return c.json({ error: "Not found" }, 404);
  return c.json(result.script);
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

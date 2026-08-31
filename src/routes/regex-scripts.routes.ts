import { Hono } from "hono";
import * as svc from "../services/regex-scripts.service";
import { parsePagination } from "../services/pagination";
import { applyDisplayRegex } from "../services/display-regex.service";
import type { RegexMacroMode, RegexPlacement, RegexScope, RegexScript, RegexTarget } from "../types/regex-script";
import { REGEX_LIMITS_V1, utf8ByteLength } from "../utils/regex-limits";

const app = new Hono();
const APPLY_MAX_CONTENT_LENGTH = 500_000;
const APPLY_MAX_SCRIPT_COUNT = 500;
const APPLY_MAX_PATTERN_LENGTH = REGEX_LIMITS_V1.maxPatternBytes;
const APPLY_MAX_RESOLVED_TEMPLATE_LENGTH = REGEX_LIMITS_V1.maxReplacementBytes;
const APPLY_VALID_PLACEMENTS = new Set<RegexPlacement>(["user_input", "ai_output", "world_info", "reasoning"]);
const APPLY_VALID_FLAGS = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);
const APPLY_VALID_TARGETS = new Set<RegexTarget>(["prompt", "response", "display"]);
const APPLY_VALID_MACRO_MODES: Record<RegexMacroMode, true> = {
  none: true,
  find: true,
  raw: true,
  escaped: true,
  after: true,
};
function runRegexAuthorityMutation<T>(userId: string, mutate: () => T): {
  value: T;
  presetAuthorityChanged: boolean;
  presetAuthorities: ReturnType<typeof svc.resolveRegexPresetAuthorities>["presetAuthorities"];
} {
  const before = svc.captureRegexPresetAuthorities(userId);
  const value = mutate();
  return { value, ...svc.resolveRegexPresetAuthorities(userId, before) };
}
function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isRegexMacroMode(value: unknown): value is RegexMacroMode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(APPLY_VALID_MACRO_MODES, value);
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResolvedMap(value: unknown): Map<string, string> | undefined {
  if (!isStringRecord(value)) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, candidate] of Object.entries(value)) {
    if (entries.length >= REGEX_LIMITS_V1.maxPatterns) break;
    if (
      typeof key === "string"
      && typeof candidate === "string"
      && utf8ByteLength(key) <= REGEX_LIMITS_V1.maxActionBytes
      && utf8ByteLength(candidate) <= APPLY_MAX_RESOLVED_TEMPLATE_LENGTH
    ) {
      entries.push([key, candidate]);
    }
  }
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
    if (utf8ByteLength(id) > REGEX_LIMITS_V1.maxActionBytes) return "script id exceeds maximum byte length";
    if (utf8ByteLength(findRegex) > APPLY_MAX_PATTERN_LENGTH) return "script find_regex exceeds maximum byte length";
    if (utf8ByteLength(replaceString) > REGEX_LIMITS_V1.maxReplacementBytes) {
      return "script replace_string exceeds maximum byte length";
    }
    if (!validateFlags(flags)) return "script flags are invalid";
    if (!Array.isArray(placement) || !placement.every((p): p is RegexPlacement => (
      typeof p === "string" && APPLY_VALID_PLACEMENTS.has(p as RegexPlacement)
    ))) {
      return "script placement is invalid";
    }
    const normalizedTarget: RegexTarget[] = Array.isArray(target)
      ? target.filter((candidate): candidate is RegexTarget => typeof candidate === "string")
      : (typeof target === "string" ? [target as RegexTarget] : ["display"]);
    if (
      normalizedTarget.length === 0
      || !normalizedTarget.every((candidate) => APPLY_VALID_TARGETS.has(candidate))
      || !normalizedTarget.includes("display")
    ) return "script target is invalid";
    if (!isRegexMacroMode(substituteMacros)) return "script substitute_macros is invalid";

    if (Array.isArray(raw.trim_strings)) {
      if (raw.trim_strings.length > REGEX_LIMITS_V1.maxTrimStrings) return "script trim_strings exceeds maximum count";
      for (const trim of raw.trim_strings) {
        if (typeof trim !== "string" || trim.length === 0) return "script trim_strings must be non-empty strings";
        if (utf8ByteLength(trim) > REGEX_LIMITS_V1.maxTrimStringBytes) return "script trim_string exceeds maximum byte length";
      }
    }
    const metadata = isStringRecord(raw.metadata) ? raw.metadata : {};
    const metadataJson = JSON.stringify(metadata);
    if (utf8ByteLength(metadataJson) > REGEX_LIMITS_V1.maxActionBytes) return "script metadata exceeds maximum byte length";

    scripts.push({
      id,
      user_id: userId,
      name: typeof raw.name === "string" ? raw.name : "Display Regex",
      script_id: typeof raw.script_id === "string" ? raw.script_id : id,
      find_regex: findRegex,
      replace_string: replaceString,
      actions: svc.normalizeRegexActions(raw.actions),
      flags,
      placement,
      scope: raw.scope === "character" || raw.scope === "chat" ? raw.scope : "global",
      scope_id: typeof raw.scope_id === "string" ? raw.scope_id : null,
      target: normalizedTarget,
      min_depth: isSafeInteger(raw.min_depth) ? raw.min_depth : null,
      max_depth: isSafeInteger(raw.max_depth) ? raw.max_depth : null,
      trim_strings: Array.isArray(raw.trim_strings)
        ? raw.trim_strings.filter((trim): trim is string => typeof trim === "string")
        : [],
      run_on_edit: !!raw.run_on_edit,
      substitute_macros: substituteMacros,
      disabled: !!raw.disabled,
      sort_order: isSafeInteger(raw.sort_order) ? raw.sort_order : 0,
      description: typeof raw.description === "string" ? raw.description : "",
      folder: typeof raw.folder === "string" ? raw.folder : "",
      pack_id: typeof raw.pack_id === "string" ? raw.pack_id : null,
      character_id: typeof raw.character_id === "string" ? raw.character_id : null,
      preset_id: typeof raw.preset_id === "string" ? raw.preset_id : null,
      owner_extension_identifier: null,
      validation_error_code: null,
      metadata,
      created_at: isSafeInteger(raw.created_at) ? raw.created_at : 0,
      updated_at: isSafeInteger(raw.updated_at) ? raw.updated_at : 0,
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
  const mutation = runRegexAuthorityMutation(userId, () => svc.createRegexScript(userId, input, { activePresetId: active_preset_id ?? null }));
  const result = mutation.value;
  if (typeof result === "string") return c.json({ error: result }, 400);
  return c.json({ script: result, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities }, 201);
});

// POST /apply — apply display regex using the backend sandboxed regex engine.
app.post("/apply", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  if (!isStringRecord(body)) return c.json({ error: "invalid request body" }, 400);

  const content = body.content;
  if (typeof content !== "string") return c.json({ error: "content is required", code: "invalid_input" }, 400);
  if (
    content.length > APPLY_MAX_CONTENT_LENGTH
    || utf8ByteLength(content) > REGEX_LIMITS_V1.maxInputBytes
  ) return c.json({ error: "content exceeds maximum length", code: "input_too_large" }, 413);

  const scripts = normalizeDisplayScripts(body.scripts, userId);
  if (typeof scripts === "string") return c.json({ error: scripts, code: "invalid_input" }, 400);

  const context = body.context;
  if (!isStringRecord(context)) return c.json({ error: "context is required", code: "invalid_input" }, 400);

  const dynamicMacrosRecord = body.dynamic_macros;
  if (dynamicMacrosRecord !== undefined && !isStringRecord(dynamicMacrosRecord)) {
    return c.json({ error: "dynamic_macros must be an object", code: "invalid_input" }, 400);
  }
  const dynamicEntries = isStringRecord(dynamicMacrosRecord)
    ? Object.entries(dynamicMacrosRecord)
    : [];
  if (dynamicEntries.length > REGEX_LIMITS_V1.maxCount) {
    return c.json({ error: "dynamic_macros exceeds maximum entries", code: "limit_exceeded" }, 413);
  }
  for (const [key, value] of dynamicEntries) {
    if (
      typeof value !== "string"
      || utf8ByteLength(key) > REGEX_LIMITS_V1.maxActionBytes
      || utf8ByteLength(value) > REGEX_LIMITS_V1.maxReplacementBytes
    ) {
      return c.json({ error: "dynamic_macros contains an oversized or invalid value", code: "limit_exceeded" }, 413);
    }
  }
  const dynamicMacros = dynamicEntries.length > 0
    ? Object.fromEntries(dynamicEntries) as Record<string, string>
    : undefined;

  const ctxRole = typeof context.role === "string"
    && (context.role === "user" || context.role === "assistant" || context.role === "system")
    ? (context.role as "user" | "assistant" | "system")
    : undefined;

  const applied = await applyDisplayRegex({
    content,
    scripts: scripts.filter((script) => !script.disabled),
    context: {
      chat_id: typeof context.chat_id === "string" ? context.chat_id : undefined,
      character_id: typeof context.character_id === "string" ? context.character_id : undefined,
      persona_id: typeof context.persona_id === "string" ? context.persona_id : undefined,
      is_user: !!context.is_user,
      depth: isSafeInteger(context.depth) ? context.depth : 0,
    },
    userId,
    resolvedFindPatterns: normalizeResolvedMap(body.resolved_find_patterns),
    resolvedReplacements: normalizeResolvedMap(body.resolved_replacements),
    dynamicMacros,
    signal: c.req.raw.signal,
  });

  return c.json({
    result: applied.result,
    touched_vars: Array.from(applied.touchedVars),
    cacheable: applied.cacheable,
    timed_out_script_ids: Array.from(applied.timedOutScriptIds),
  });
});

// POST /test — test regex
app.post("/test", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!isStringRecord(body)) {
    return c.json({ error: "request body must be an object", code: "invalid_input" }, 400);
  }
  const findRegex = body.find_regex;
  const replaceString = body.replace_string;
  const flags = body.flags;
  const content = body.content;
  if (typeof findRegex !== "string" || findRegex.length === 0) {
    return c.json({ error: "find_regex must be a non-empty string", code: "invalid_input" }, 400);
  }
  if (typeof content !== "string") {
    return c.json({ error: "content must be a string", code: "invalid_input" }, 400);
  }
  if (replaceString !== undefined && typeof replaceString !== "string") {
    return c.json({ error: "replace_string must be a string", code: "invalid_input" }, 400);
  }
  if (flags !== undefined && typeof flags !== "string") {
    return c.json({ error: "flags must be a string", code: "invalid_input" }, 400);
  }
  if (utf8ByteLength(findRegex) > REGEX_LIMITS_V1.maxPatternBytes) {
    return c.json({ error: "find_regex exceeds its UTF-8 byte limit", code: "pattern_too_large" }, 413);
  }
  if (typeof replaceString === "string" && utf8ByteLength(replaceString) > REGEX_LIMITS_V1.maxReplacementBytes) {
    return c.json({ error: "replace_string exceeds its UTF-8 byte limit", code: "replacement_too_large" }, 413);
  }
  if (utf8ByteLength(content) > REGEX_LIMITS_V1.maxInputBytes) {
    return c.json({ error: "content exceeds its UTF-8 byte limit", code: "invalid_input" }, 413);
  }
  const resolvedFlags = flags ?? "gi";
  if (!validateFlags(resolvedFlags)) {
    return c.json({ error: "flags are invalid", code: "invalid_flags" }, 400);
  }
  const actionsValue = body.match_actions;
  if (actionsValue !== undefined && !Array.isArray(actionsValue)) {
    return c.json({ error: "match_actions must be an array", code: "invalid_input" }, 400);
  }
  const actions = Array.isArray(actionsValue)
    ? actionsValue.filter(
        (action): action is "move_top" | "move_bottom" | "repeat_back" =>
          action === "move_top"
          || action === "move_bottom"
          || action === "repeat_back",
      )
    : [];
  const result = await svc.testRegex(
    findRegex,
    replaceString ?? "",
    resolvedFlags,
    content,
    actions,
  );
  if (result.error_code) {
    return c.json({ ...result, code: result.error_code }, 400);
  }
  return c.json(result);
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
  const mutation = runRegexAuthorityMutation(userId, () => svc.importRegexScripts(userId, body, { activePresetId: body?.active_preset_id ?? null }));
  return c.json({ ...mutation.value, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities }, 201);
});

// PUT /reorder — bulk reorder
app.put("/reorder", async (c) => {
  const userId = c.get("userId");
  const { ids } = await c.req.json();
  if (!Array.isArray(ids)) return c.json({ error: "ids must be an array" }, 400);
  const mutation = runRegexAuthorityMutation(userId, () => svc.reorderRegexScripts(userId, ids));
  return c.json({ success: true, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities });
});

// POST /bulk-delete — delete many scripts in one transaction
app.post("/bulk-delete", async (c) => {
  const userId = c.get("userId");
  const { ids } = await c.req.json();
  if (!Array.isArray(ids)) return c.json({ error: "ids must be an array" }, 400);
  const stringIds = ids.filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
  const mutation = runRegexAuthorityMutation(userId, () => svc.deleteRegexScripts(userId, stringIds));
  return c.json({ deleted: mutation.value, count: mutation.value.length, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities });
});

// POST /bulk-toggle — enable/disable an explicit selection in one transaction
app.post("/bulk-toggle", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  if (!Array.isArray(body?.ids)) return c.json({ error: "ids must be an array" }, 400);
  const stringIds = body.ids.filter((v: unknown): v is string => typeof v === "string" && v.length > 0);
  const mutation = runRegexAuthorityMutation(userId, () => svc.toggleRegexScriptsByIds(userId, stringIds, !!body?.disabled, {
    activePresetId: body?.active_preset_id ?? null,
  }));
  return c.json({ ...mutation.value, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities });
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
  const mutation = runRegexAuthorityMutation(userId, () => svc.updateRegexScript(userId, c.req.param("id"), input, { activePresetId: active_preset_id ?? null }));
  const result = mutation.value;
  if (result === null) return c.json({ error: "Not found" }, 404);
  if (typeof result === "string") return c.json({ error: result }, 400);
  return c.json({ script: result, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities });
});

// DELETE /:id — delete
app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const mutation = runRegexAuthorityMutation(userId, () => svc.deleteRegexScript(userId, c.req.param("id")));
  if (!mutation.value) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities });
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

// POST /:id/report-evidence — persist client-side execution evidence
// (metadata.regex_evidence.quarantined) used by the display-regex tier rules.
// Quarantine is the only field accepted: it is the only evidence that changes
// which tier a script runs in. Successful-timing evidence was removed rather
// than kept, because nothing read it and it could not promote a script.
// `quarantined: false` is a valid body and clears the flag, which is how the
// panel lets a user un-quarantine a script.
export type RegexEvidenceReportBody = {
  quarantined?: boolean;
};

function parseEvidenceBody(body: any): RegexEvidenceReportBody | null {
  if (body?.quarantined === undefined) return null;
  return { quarantined: !!body.quarantined };
}

app.post("/:id/report-evidence", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const patch = parseEvidenceBody(body);
  if (!patch) return c.json({ error: "evidence patch requires a quarantined field" }, 400);
  const script = svc.reportRegexScriptEvidence(userId, c.req.param("id"), {
    quarantined: patch.quarantined,
  });
  if (!script) return c.json({ error: "Not found" }, 404);
  return c.json(script);
});

// PUT /:id/toggle — quick enable/disable
app.put("/:id/toggle", async (c) => {
  const userId = c.get("userId");
  const { disabled, active_preset_id } = await c.req.json();
  const mutation = runRegexAuthorityMutation(userId, () => svc.toggleRegexScript(userId, c.req.param("id"), !!disabled, { activePresetId: active_preset_id ?? null }));
  const script = mutation.value;
  if (!script) return c.json({ error: "Not found" }, 404);
  return c.json({ script, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities });
});

// POST /folders/toggle — bulk enable/disable every script in a folder
app.post("/folders/toggle", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const folder = typeof body?.folder === "string" ? body.folder : undefined;
  if (folder === undefined) return c.json({ error: "folder is required" }, 400);
  const mutation = runRegexAuthorityMutation(userId, () => svc.toggleRegexScriptsByFolder(userId, folder, !!body?.disabled, {
    activePresetId: body?.active_preset_id ?? null,
  }));
  return c.json({ ...mutation.value, presetAuthorityChanged: mutation.presetAuthorityChanged, presetAuthorities: mutation.presetAuthorities });
});

export { app as regexScriptsRoutes };

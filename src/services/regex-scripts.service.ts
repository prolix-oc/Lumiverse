import { getDb } from "../db/connection";
import { paginatedQuery } from "./pagination";
import type { PaginationParams } from "../types/pagination";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type {
  RegexScript,
  CreateRegexScriptInput,
  UpdateRegexScriptInput,
  RegexScriptExport,
  RegexPlacement,
  RegexScope,
  RegexTarget,
} from "../types/regex-script";
import type { MacroEnv } from "../macros/types";
import { evaluate } from "../macros/MacroEvaluator";
import { registry } from "../macros/MacroRegistry";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_PLACEMENTS = new Set(["user_input", "ai_output", "world_info", "reasoning"]);
const VALID_SCOPES = new Set(["global", "character", "chat"]);
const VALID_TARGETS = new Set(["prompt", "response", "display"]);
const VALID_FLAGS = new Set(["g", "i", "m", "s", "u"]);
const VALID_MACRO_MODES = new Set(["none", "raw", "escaped"]);
const MAX_PATTERN_LENGTH = 10_000;

function rowToRegexScript(row: any): RegexScript {
  return {
    ...row,
    script_id: row.script_id || "",
    placement: JSON.parse(row.placement),
    trim_strings: JSON.parse(row.trim_strings),
    folder: row.folder || "",
    metadata: JSON.parse(row.metadata),
    run_on_edit: !!row.run_on_edit,
    disabled: !!row.disabled,
  };
}

function validateFlags(flags: string): boolean {
  for (const ch of flags) {
    if (!VALID_FLAGS.has(ch)) return false;
  }
  // No duplicate flags
  return new Set(flags).size === flags.length;
}

function validateRegex(pattern: string, flags: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "find_regex exceeds maximum length";
  if (!validateFlags(flags)) return "Invalid flags — allowed: g, i, m, s, u";
  try {
    new RegExp(pattern, flags);
    return null;
  } catch (e: any) {
    return `Invalid regex: ${e.message}`;
  }
}

function validateInput(input: CreateRegexScriptInput | UpdateRegexScriptInput, isCreate: boolean): string | null {
  if (isCreate) {
    const ci = input as CreateRegexScriptInput;
    if (!ci.name?.trim()) return "name is required";
    if (ci.find_regex === undefined || ci.find_regex === null) return "find_regex is required";
  }

  if (input.find_regex !== undefined && input.find_regex.length > MAX_PATTERN_LENGTH) {
    return "find_regex exceeds maximum length";
  }
  if (input.flags !== undefined && !validateFlags(input.flags)) {
    return "Invalid flags — allowed: g, i, m, s, u";
  }
  if (input.find_regex !== undefined || input.flags !== undefined) {
    const pattern = input.find_regex ?? "";
    const flags = input.flags ?? "gi";
    const err = validateRegex(pattern, flags);
    if (err) return err;
  }
  if (input.placement !== undefined) {
    if (!Array.isArray(input.placement)) return "placement must be an array";
    for (const p of input.placement) {
      if (!VALID_PLACEMENTS.has(p)) return `Invalid placement: ${p}`;
    }
  }
  if (input.scope !== undefined && !VALID_SCOPES.has(input.scope)) {
    return `Invalid scope: ${input.scope}`;
  }
  if (input.scope !== undefined && input.scope !== "global" && !input.scope_id) {
    return "scope_id is required for non-global scope";
  }
  if (input.target !== undefined && !VALID_TARGETS.has(input.target)) {
    return `Invalid target: ${input.target}`;
  }
  if (input.substitute_macros !== undefined && !VALID_MACRO_MODES.has(input.substitute_macros)) {
    return `Invalid substitute_macros: ${input.substitute_macros}`;
  }
  if (input.script_id !== undefined) {
    input.script_id = normalizeScriptId(input.script_id);
    if (input.script_id.length > 100) {
      return "script_id exceeds maximum length (100 characters)";
    }
  }

  return null;
}

/**
 * Normalize a script_id to lowercase alphanumeric + underscores.
 * Uppercase → lowercase, spaces/hyphens → underscores, strip all other punctuation.
 */
function normalizeScriptId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function listRegexScripts(
  userId: string,
  pagination: PaginationParams,
  filters?: { scope?: RegexScope; target?: RegexTarget; character_id?: string; chat_id?: string }
) {
  const conditions = ["user_id = ?"];
  const params: any[] = [userId];

  if (filters?.scope) {
    conditions.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters?.target) {
    conditions.push("target = ?");
    params.push(filters.target);
  }
  if (filters?.character_id) {
    conditions.push("((scope = 'global') OR (scope = 'character' AND scope_id = ?))");
    params.push(filters.character_id);
  }
  if (filters?.chat_id) {
    conditions.push("((scope = 'global') OR (scope = 'chat' AND scope_id = ?))");
    params.push(filters.chat_id);
  }

  const where = conditions.join(" AND ");
  return paginatedQuery(
    `SELECT * FROM regex_scripts WHERE ${where} ORDER BY sort_order ASC, created_at ASC`,
    `SELECT COUNT(*) as count FROM regex_scripts WHERE ${where}`,
    params,
    pagination,
    rowToRegexScript
  );
}

// Prepared statement for hot-path regex fetch
let _stmtRegexById: ReturnType<ReturnType<typeof getDb>["query"]> | null = null;

export function getRegexScript(userId: string, id: string): RegexScript | null {
  if (!_stmtRegexById) _stmtRegexById = getDb().query("SELECT * FROM regex_scripts WHERE id = ? AND user_id = ?");
  const row = _stmtRegexById.get(id, userId) as any;
  return row ? rowToRegexScript(row) : null;
}

export function createRegexScript(userId: string, input: CreateRegexScriptInput): RegexScript | string {
  const err = validateInput(input, true);
  if (err) return err;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO regex_scripts (id, user_id, name, script_id, find_regex, replace_string, flags, placement, scope, scope_id, target, min_depth, max_depth, trim_strings, run_on_edit, substitute_macros, disabled, sort_order, description, folder, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      userId,
      input.name.trim(),
      input.script_id ?? "",
      input.find_regex,
      input.replace_string ?? "",
      input.flags ?? "gi",
      JSON.stringify(input.placement ?? ["ai_output"]),
      input.scope ?? "global",
      input.scope === "global" || !input.scope ? null : (input.scope_id ?? null),
      input.target ?? "response",
      input.min_depth ?? null,
      input.max_depth ?? null,
      JSON.stringify(input.trim_strings ?? []),
      input.run_on_edit ? 1 : 0,
      input.substitute_macros ?? "none",
      input.disabled ? 1 : 0,
      input.sort_order ?? 0,
      input.description ?? "",
      input.folder ?? "",
      JSON.stringify(input.metadata ?? {}),
      now,
      now
    );

  const script = getRegexScript(userId, id)!;
  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id, script }, userId);
  return script;
}

export function updateRegexScript(userId: string, id: string, input: UpdateRegexScriptInput): RegexScript | string | null {
  const existing = getRegexScript(userId, id);
  if (!existing) return null;

  // If updating regex or flags, validate together
  if (input.find_regex !== undefined || input.flags !== undefined) {
    const pattern = input.find_regex ?? existing.find_regex;
    const flags = input.flags ?? existing.flags;
    const regexErr = validateRegex(pattern, flags);
    if (regexErr) return regexErr;
  }

  const err = validateInput(input, false);
  if (err) return err;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name.trim()); }
  if (input.script_id !== undefined) { fields.push("script_id = ?"); values.push(input.script_id); }
  if (input.find_regex !== undefined) { fields.push("find_regex = ?"); values.push(input.find_regex); }
  if (input.replace_string !== undefined) { fields.push("replace_string = ?"); values.push(input.replace_string); }
  if (input.flags !== undefined) { fields.push("flags = ?"); values.push(input.flags); }
  if (input.placement !== undefined) { fields.push("placement = ?"); values.push(JSON.stringify(input.placement)); }
  if (input.scope !== undefined) { fields.push("scope = ?"); values.push(input.scope); }
  if (input.scope_id !== undefined) { fields.push("scope_id = ?"); values.push(input.scope_id); }
  if (input.target !== undefined) { fields.push("target = ?"); values.push(input.target); }
  if (input.min_depth !== undefined) { fields.push("min_depth = ?"); values.push(input.min_depth); }
  if (input.max_depth !== undefined) { fields.push("max_depth = ?"); values.push(input.max_depth); }
  if (input.trim_strings !== undefined) { fields.push("trim_strings = ?"); values.push(JSON.stringify(input.trim_strings)); }
  if (input.run_on_edit !== undefined) { fields.push("run_on_edit = ?"); values.push(input.run_on_edit ? 1 : 0); }
  if (input.substitute_macros !== undefined) { fields.push("substitute_macros = ?"); values.push(input.substitute_macros); }
  if (input.disabled !== undefined) { fields.push("disabled = ?"); values.push(input.disabled ? 1 : 0); }
  if (input.sort_order !== undefined) { fields.push("sort_order = ?"); values.push(input.sort_order); }
  if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
  if (input.folder !== undefined) { fields.push("folder = ?"); values.push(input.folder); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE regex_scripts SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);

  const updated = getRegexScript(userId, id)!;
  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id, script: updated }, userId);
  return updated;
}

export function deleteRegexScript(userId: string, id: string): boolean {
  const result = getDb()
    .query("DELETE FROM regex_scripts WHERE id = ? AND user_id = ?")
    .run(id, userId);
  if (result.changes > 0) {
    eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id }, userId);
    return true;
  }
  return false;
}

export function duplicateRegexScript(userId: string, id: string): RegexScript | null {
  const existing = getRegexScript(userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO regex_scripts (id, user_id, name, script_id, find_regex, replace_string, flags, placement, scope, scope_id, target, min_depth, max_depth, trim_strings, run_on_edit, substitute_macros, disabled, sort_order, description, folder, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId,
      userId,
      existing.name + " (Copy)",
      "", // script_id intentionally blank on duplicate — must be unique
      existing.find_regex,
      existing.replace_string,
      existing.flags,
      JSON.stringify(existing.placement),
      existing.scope,
      existing.scope_id,
      existing.target,
      existing.min_depth,
      existing.max_depth,
      JSON.stringify(existing.trim_strings),
      existing.run_on_edit ? 1 : 0,
      existing.substitute_macros,
      existing.disabled ? 1 : 0,
      existing.sort_order,
      existing.description,
      existing.folder,
      JSON.stringify(existing.metadata),
      now,
      now
    );

  const script = getRegexScript(userId, newId)!;
  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id: newId, script }, userId);
  return script;
}

export function reorderRegexScripts(userId: string, orderedIds: string[]): boolean {
  const db = getDb();
  const txn = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      db.query("UPDATE regex_scripts SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(i, Math.floor(Date.now() / 1000), orderedIds[i], userId);
    }
  });
  txn();
  return true;
}

export function toggleRegexScript(userId: string, id: string, disabled: boolean): RegexScript | null {
  const existing = getRegexScript(userId, id);
  if (!existing) return null;

  getDb()
    .query("UPDATE regex_scripts SET disabled = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(disabled ? 1 : 0, Math.floor(Date.now() / 1000), id, userId);

  const updated = getRegexScript(userId, id)!;
  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id, script: updated }, userId);
  return updated;
}

// ── Character-bound query ────────────────────────────────────────────────────

/** Returns all regex scripts scoped to a specific character (for bundling into .charx exports). */
export function getCharacterBoundScripts(userId: string, characterId: string): RegexScript[] {
  const rows = getDb()
    .query("SELECT * FROM regex_scripts WHERE user_id = ? AND scope = 'character' AND scope_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(userId, characterId) as any[];
  return rows.map(rowToRegexScript);
}

// ── Lookup by script_id ─────────────────────────────────────────────────────

/** Find a regex script by its user-defined script_id. Returns null if not found or script_id is empty. */
export function getRegexScriptByScriptId(userId: string, scriptId: string): RegexScript | null {
  if (!scriptId) return null;
  const row = getDb()
    .query("SELECT * FROM regex_scripts WHERE user_id = ? AND script_id = ?")
    .get(userId, scriptId) as any;
  return row ? rowToRegexScript(row) : null;
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Get active (enabled) scripts matching the given context, properly ordered by
 * scope resolution: global → character → chat, within each tier by sort_order ASC, created_at ASC.
 */
export function getActiveScripts(
  userId: string,
  opts: { characterId?: string; chatId?: string; target: RegexTarget }
): RegexScript[] {
  const db = getDb();

  // Build a query that fetches all candidate scripts and orders by scope tier, then sort_order
  const conditions = [
    "user_id = ?",
    "disabled = 0",
    "target = ?",
  ];
  const params: any[] = [userId, opts.target];

  // Scope filter: include global + character-scoped + chat-scoped matching the current context
  const scopeConditions: string[] = ["scope = 'global'"];
  if (opts.characterId) {
    scopeConditions.push("(scope = 'character' AND scope_id = ?)");
    params.push(opts.characterId);
  }
  if (opts.chatId) {
    scopeConditions.push("(scope = 'chat' AND scope_id = ?)");
    params.push(opts.chatId);
  }
  conditions.push(`(${scopeConditions.join(" OR ")})`);

  const where = conditions.join(" AND ");

  const rows = db
    .query(
      `SELECT * FROM regex_scripts WHERE ${where}
       ORDER BY
         CASE scope WHEN 'global' THEN 0 WHEN 'character' THEN 1 WHEN 'chat' THEN 2 END ASC,
         sort_order ASC, created_at ASC`
    )
    .all(...params) as any[];

  return rows.map(rowToRegexScript);
}

/**
 * Manually substitute regex capture references ($1, $&, etc.) in a replacement
 * template using actual match values.  Mirrors String.prototype.replace's
 * special $ patterns so that macros can see the captured text.
 */
export function substituteRegexCaptures(
  template: string,
  fullMatch: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  namedGroups?: Record<string, string>,
): string {
  return template.replace(
    /\$(?:(\$)|(&)|(`)|(')|(\d{1,2})|<([^>]*)>)/g,
    (token, dollar, amp, backtick, quote, digits, name) => {
      if (dollar !== undefined) return "$";
      if (amp !== undefined) return fullMatch;
      if (backtick !== undefined) return input.slice(0, offset);
      if (quote !== undefined) return input.slice(offset + fullMatch.length);
      if (digits !== undefined) {
        const idx = parseInt(digits, 10);
        if (idx >= 1 && idx <= groups.length) return groups[idx - 1] ?? "";
        return token;
      }
      if (name !== undefined && namedGroups) return namedGroups[name] ?? token;
      return token;
    },
  );
}

/**
 * Collect all regex matches from a string, returning match metadata needed
 * for capture-group substitution.
 */
function collectMatches(content: string, regex: RegExp) {
  const re = new RegExp(regex.source, regex.flags);
  const matches: { fullMatch: string; index: number; groups: (string | undefined)[]; namedGroups?: Record<string, string> }[] = [];

  if (re.global || re.sticky) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      matches.push({
        fullMatch: m[0],
        index: m.index,
        groups: Array.from(m).slice(1),
        namedGroups: m.groups,
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  } else {
    const m = re.exec(content);
    if (m) {
      matches.push({
        fullMatch: m[0],
        index: m.index,
        groups: Array.from(m).slice(1),
        namedGroups: m.groups,
      });
    }
  }

  return matches;
}

/**
 * Rebuild a string by splicing replacements into the original at match positions.
 */
function rebuildFromMatches(
  content: string,
  matches: { fullMatch: string; index: number }[],
  replacements: string[],
): string {
  let out = "";
  let lastIdx = 0;
  for (let i = 0; i < matches.length; i++) {
    out += content.slice(lastIdx, matches[i].index);
    out += replacements[i];
    lastIdx = matches[i].index + matches[i].fullMatch.length;
  }
  out += content.slice(lastIdx);
  return out;
}

/**
 * Resolve macros in a regex replacement string based on the substitute_macros mode.
 * - "none": return as-is
 * - "raw": resolve macros, result may contain regex back-references ($1, etc.)
 * - "escaped": resolve macros, then escape $ so no back-references are interpreted
 */
async function resolveReplacementMacros(
  replaceString: string,
  mode: RegexScript["substitute_macros"],
  macroEnv: MacroEnv,
): Promise<string> {
  if (mode === "none") return replaceString;

  const resolved = (await evaluate(replaceString, macroEnv, registry)).text;

  if (mode === "escaped") {
    // Escape $ so regex replacement doesn't interpret $1, $&, etc.
    return resolved.replace(/\$/g, "$$$$");
  }

  return resolved;
}

/**
 * Apply regex scripts to content string.
 * Returns the transformed content.
 *
 * When `macroEnv` is provided, scripts with `substitute_macros` set to "raw" or
 * "escaped" will have their replacement strings resolved through the macro engine
 * before being applied.
 *
 * For "raw" mode, capture groups ($1, $2, etc.) are substituted into the
 * replacement template BEFORE macro resolution, so macros can reference
 * captured text (e.g. `{{setvar::key::$1}}`).
 */
export async function applyRegexScripts(
  content: string,
  scripts: RegexScript[],
  placement: RegexPlacement,
  depth?: number,
  macroEnv?: MacroEnv,
): Promise<string> {
  let result = content;

  for (const script of scripts) {
    // Check placement match
    if (!script.placement.includes(placement)) continue;

    // Check depth bounds
    if (depth !== undefined) {
      if (script.min_depth !== null && depth < script.min_depth) continue;
      if (script.max_depth !== null && depth > script.max_depth) continue;
    }

    try {
      const startTime = Date.now();
      const regex = new RegExp(script.find_regex, script.flags);

      if (macroEnv && script.substitute_macros === "raw") {
        // "raw" mode: substitute capture groups into the replacement template
        // BEFORE macro resolution so $1, $2, etc. are available inside macros
        const matches = collectMatches(result, regex);
        if (matches.length > 0) {
          const replacements = await Promise.all(
            matches.map(async ({ fullMatch, groups, index, namedGroups }) => {
              const withCaptures = substituteRegexCaptures(
                script.replace_string, fullMatch, groups, index, result, namedGroups,
              );
              return (await evaluate(withCaptures, macroEnv, registry)).text;
            }),
          );
          result = rebuildFromMatches(result, matches, replacements);
        }
      } else {
        // "none" or "escaped" mode: resolve macros first (if applicable), then string replace
        let replaceString = script.replace_string;
        if (macroEnv && script.substitute_macros !== "none") {
          replaceString = await resolveReplacementMacros(replaceString, script.substitute_macros, macroEnv);
        }
        result = result.replace(regex, replaceString);
      }

      // Apply trim_strings
      if (script.trim_strings.length > 0) {
        for (const trim of script.trim_strings) {
          while (result.includes(trim)) {
            result = result.replaceAll(trim, "");
          }
        }
      }

      // Safety check: skip script if it took > 500ms
      if (Date.now() - startTime > 500) {
        console.warn(`[RegexScripts] Script "${script.name}" (${script.id}) exceeded 500ms, skipping`);
      }
    } catch (e) {
      console.warn(`[RegexScripts] Failed to apply script "${script.name}" (${script.id}):`, e);
    }
  }

  return result;
}

// ── Test ─────────────────────────────────────────────────────────────────────

export function testRegex(
  findRegex: string,
  replaceString: string,
  flags: string,
  content: string
): { result: string; matches: number; error?: string } {
  try {
    const regex = new RegExp(findRegex, flags);
    let matches = 0;
    content.replace(regex, (...args) => {
      matches++;
      return args[0];
    });
    const result = content.replace(regex, replaceString);
    return { result, matches };
  } catch (e: any) {
    return { result: content, matches: 0, error: e.message };
  }
}

// ── Import / Export ──────────────────────────────────────────────────────────

export function exportRegexScripts(userId: string, ids?: string[]): RegexScriptExport {
  const db = getDb();
  let rows: any[];

  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    rows = db
      .query(`SELECT * FROM regex_scripts WHERE user_id = ? AND id IN (${placeholders}) ORDER BY sort_order ASC, created_at ASC`)
      .all(userId, ...ids) as any[];
  } else {
    rows = db
      .query("SELECT * FROM regex_scripts WHERE user_id = ? ORDER BY sort_order ASC, created_at ASC")
      .all(userId) as any[];
  }

  const scripts = rows.map(rowToRegexScript).map((s) => {
    const { id, user_id, created_at, updated_at, ...rest } = s;
    return rest;
  });

  return {
    version: 1,
    type: "lumiverse_regex_scripts",
    scripts,
    exported_at: Math.floor(Date.now() / 1000),
  };
}

// SillyTavern regex_placement enum → Lumiverse placement strings
const ST_PLACEMENT_MAP: Record<number, RegexPlacement> = {
  // 0 = MD_DISPLAY (deprecated in ST, map to user_input as closest equivalent)
  0: "user_input",
  1: "user_input",
  2: "ai_output",
  // 3 = SLASH_COMMAND (no equivalent, skip)
  // 4 = sendAs (legacy, skip)
  5: "world_info",
  6: "reasoning",
};

// SillyTavern substitute_find_regex enum → Lumiverse macro mode
const ST_SUBSTITUTE_MAP: Record<number, "none" | "raw" | "escaped"> = {
  0: "none",
  1: "raw",
  2: "escaped",
};

/**
 * Parse a SillyTavern `/pattern/flags` regex literal into pattern + flags.
 * Falls back to treating the whole string as the pattern if it's not in literal form.
 */
function parseRegexLiteral(findRegex: string): { pattern: string; flags: string } {
  const match = findRegex.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (match) {
    return { pattern: match[1], flags: match[2] || "gi" };
  }
  return { pattern: findRegex, flags: "gi" };
}

function convertStPlacement(placement: any[]): RegexPlacement[] {
  const result: RegexPlacement[] = [];
  for (const p of placement) {
    if (typeof p === "string" && VALID_PLACEMENTS.has(p)) {
      result.push(p as RegexPlacement);
    } else if (typeof p === "number" && ST_PLACEMENT_MAP[p]) {
      result.push(ST_PLACEMENT_MAP[p]);
    }
  }
  // Deduplicate
  return [...new Set(result)];
}

function convertStTarget(item: any): RegexTarget {
  if (item.markdownOnly) return "display";
  if (item.promptOnly) return "prompt";
  return "response";
}

export function importRegexScripts(
  userId: string,
  payload: any
): { imported: number; skipped: number; errors: string[] } {
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;

  // Extract top-level folder override (e.g. preset name)
  const folderOverride: string | undefined =
    typeof payload?.folder === "string" && payload.folder.trim()
      ? payload.folder.trim()
      : undefined;

  // Normalize input: accept array, { scripts: [] }, or single object
  let scripts: any[];
  if (Array.isArray(payload)) {
    scripts = payload;
  } else if (Array.isArray(payload?.scripts)) {
    scripts = payload.scripts;
  } else if (payload && typeof payload === "object" && (payload.scriptName || payload.findRegex || payload.find_regex || payload.name)) {
    // Single script object
    scripts = [payload];
  } else {
    scripts = [];
  }

  for (let i = 0; i < scripts.length; i++) {
    let item = scripts[i];

    // SillyTavern format conversion
    if (item.scriptName || item.findRegex) {
      const { pattern, flags } = parseRegexLiteral(item.findRegex ?? item.find_regex ?? "");

      // Convert numeric placement array to string values
      const rawPlacement = Array.isArray(item.placement) ? item.placement : ["ai_output"];
      const placement = convertStPlacement(rawPlacement);

      // Convert substituteRegex enum (0=none, 1=raw, 2=escaped)
      const subVal = Number(item.substituteRegex ?? 0);
      const substitute_macros = ST_SUBSTITUTE_MAP[subVal] ?? "none";

      // Convert promptOnly/markdownOnly booleans to target
      const target = convertStTarget(item);

      // Normalize depth: ST uses -1 for "any"
      const minDepth = item.minDepth ?? item.min_depth ?? null;
      const maxDepth = item.maxDepth ?? item.max_depth ?? null;

      item = {
        name: item.scriptName ?? item.name ?? `Imported Script ${i + 1}`,
        script_id: item.script_id ?? "",
        find_regex: pattern,
        replace_string: item.replaceString ?? item.replace_string ?? "",
        flags,
        placement: placement.length > 0 ? placement : ["ai_output"],
        scope: item.scope ?? "global",
        scope_id: item.scope_id ?? null,
        target,
        min_depth: (typeof minDepth === "number" && minDepth >= 0) ? minDepth : null,
        max_depth: (typeof maxDepth === "number" && maxDepth >= 0) ? maxDepth : null,
        trim_strings: item.trimStrings ?? item.trim_strings ?? [],
        run_on_edit: item.runOnEdit ?? item.run_on_edit ?? false,
        substitute_macros,
        disabled: item.disabled ?? false,
        sort_order: item.sort_order ?? i,
        description: item.description ?? "",
        metadata: item.metadata ?? {},
      };
    }

    if (!item.name || !item.find_regex) {
      errors.push(`Script ${i}: missing name or find_regex`);
      skipped++;
      continue;
    }

    // Apply folder override if script doesn't already have one
    if (folderOverride && !item.folder) {
      item.folder = folderOverride;
    }

    const result = createRegexScript(userId, item);
    if (typeof result === "string") {
      errors.push(`Script "${item.name}": ${result}`);
      skipped++;
    } else {
      imported++;
    }
  }

  return { imported, skipped, errors };
}

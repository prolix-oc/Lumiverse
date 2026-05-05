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
import {
  regexCollectSandboxed,
  regexReplaceSandboxed,
  regexTestSandboxed,
  RegexTimeoutError,
  type SandboxMatch,
} from "../utils/regex-sandbox";

const REGEX_SCRIPT_TIMEOUT_MS = 500;
const REGEX_SLOW_WARNING_MS = 5_000;

type RegexPerformanceSource = "prompt_backend" | "response_backend" | "display_backend" | "display_client";

interface RegexPerformanceMetadata {
  slow: boolean;
  timed_out: boolean;
  elapsed_ms: number;
  threshold_ms: number;
  detected_at: number;
  source: RegexPerformanceSource;
  version: number;
}

export interface RegexPerformanceIssue {
  scriptId: string;
  name: string;
  elapsedMs: number;
  thresholdMs: number;
  timedOut: boolean;
  source: RegexPerformanceSource;
  newlyFlagged: boolean;
}

interface RegexPerformanceReportResult {
  script: RegexScript | null;
  newlyFlagged: boolean;
}

interface ApplyRegexScriptOptions {
  source?: RegexPerformanceSource;
  onPerformanceIssue?: (issue: RegexPerformanceIssue) => void;
  outFingerprint?: { touchedVars: Set<string>; cacheable: boolean };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_PLACEMENTS = new Set(["user_input", "ai_output", "world_info", "reasoning"]);
const VALID_SCOPES = new Set(["global", "character", "chat"]);
const VALID_TARGETS = new Set(["prompt", "response", "display"]);
const VALID_FLAGS = new Set(["g", "i", "m", "s", "u"]);
const VALID_MACRO_MODES = new Set(["none", "raw", "escaped", "after"]);
const MAX_PATTERN_LENGTH = 10_000;
const PRESET_REGEX_ENABLED_SETTING_PREFIX = "presetRegexEnabled:";

interface RegexMutationContext {
  activePresetId?: string | null;
}

function normalizeOptionalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getPresetRegexSettingKey(presetId: string): string {
  return `${PRESET_REGEX_ENABLED_SETTING_PREFIX}${presetId}`;
}

function normalizeStoredPresetRegexIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return [...new Set(ids)];
}

function readStoredPresetRegexIdsRecord(userId: string, presetId: string): { exists: boolean; ids: string[] } {
  const row = getDb()
    .query("SELECT value FROM settings WHERE key = ? AND user_id = ?")
    .get(getPresetRegexSettingKey(presetId), userId) as { value?: string } | undefined;
  if (!row) return { exists: false, ids: [] };

  try {
    return { exists: true, ids: normalizeStoredPresetRegexIds(JSON.parse(row.value ?? "[]")) };
  } catch {
    return { exists: true, ids: [] };
  }
}

function writeStoredPresetRegexIdsWithDb(db: ReturnType<typeof getDb>, userId: string, presetId: string, ids: string[]): void {
  const now = Math.floor(Date.now() / 1000);
  db
    .query(
      `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(getPresetRegexSettingKey(presetId), JSON.stringify(normalizeStoredPresetRegexIds(ids)), userId, now);
}

function updateStoredPresetRegexIds(
  userId: string,
  presetId: string,
  updater: (ids: string[]) => string[],
): void {
  const db = getDb();
  const current = readStoredPresetRegexIdsRecord(userId, presetId).ids;
  writeStoredPresetRegexIdsWithDb(db, userId, presetId, updater(current));
}

function deleteStoredPresetRegexIds(userId: string, presetId: string): void {
  getDb().query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(getPresetRegexSettingKey(presetId), userId);
}

function setPresetBoundScriptEnabledInRestoreList(
  userId: string,
  presetId: string,
  scriptId: string,
  enabled: boolean,
): void {
  updateStoredPresetRegexIds(userId, presetId, (current) => {
    const next = new Set(current);
    if (enabled) next.add(scriptId);
    else next.delete(scriptId);
    return [...next];
  });
}

function emitRegexChanged(userId: string, id: string): void {
  const script = getRegexScript(userId, id);
  if (!script) return;
  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id, script }, userId);
}

function getRegexPerformanceMetadata(script: RegexScript): RegexPerformanceMetadata | null {
  const raw = script.metadata?.regex_performance;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<RegexPerformanceMetadata>;
  if (value.slow !== true) return null;
  if (typeof value.version !== "number") return null;
  return {
    slow: true,
    timed_out: value.timed_out === true,
    elapsed_ms: typeof value.elapsed_ms === "number" ? value.elapsed_ms : 0,
    threshold_ms: typeof value.threshold_ms === "number" ? value.threshold_ms : REGEX_SLOW_WARNING_MS,
    detected_at: typeof value.detected_at === "number" ? value.detected_at : 0,
    source: (value.source as RegexPerformanceSource) || "display_backend",
    version: value.version,
  };
}

function withoutRegexPerformanceMetadata(metadata: Record<string, any> | null | undefined): Record<string, any> {
  if (!metadata || typeof metadata !== "object") return {};
  const next = { ...metadata };
  delete next.regex_performance;
  return next;
}

function shouldResetRegexPerformance(input: UpdateRegexScriptInput): boolean {
  return [
    "find_regex",
    "replace_string",
    "flags",
    "placement",
    "target",
    "min_depth",
    "max_depth",
    "trim_strings",
    "substitute_macros",
  ].some((key) => Object.prototype.hasOwnProperty.call(input, key));
}

export function reportRegexScriptPerformance(
  userId: string,
  id: string,
  issue: { elapsedMs: number; timedOut?: boolean; thresholdMs?: number; source?: RegexPerformanceSource },
): RegexPerformanceReportResult {
  const script = getRegexScript(userId, id);
  if (!script) return { script: null, newlyFlagged: false };

  const thresholdMs = issue.thresholdMs ?? REGEX_SLOW_WARNING_MS;
  const timedOut = issue.timedOut === true;
  if (!timedOut && issue.elapsedMs < thresholdMs) return { script, newlyFlagged: false };

  const existing = getRegexPerformanceMetadata(script);
  if (
    existing &&
    existing.version === script.updated_at &&
    existing.timed_out === timedOut &&
    existing.threshold_ms === thresholdMs
  ) {
    return { script, newlyFlagged: false };
  }

  const nextMetadata = {
    ...withoutRegexPerformanceMetadata(script.metadata),
    regex_performance: {
      slow: true,
      timed_out: timedOut,
      elapsed_ms: Math.max(0, Math.round(issue.elapsedMs)),
      threshold_ms: thresholdMs,
      detected_at: Math.floor(Date.now() / 1000),
      source: issue.source ?? "display_backend",
      version: script.updated_at,
    } satisfies RegexPerformanceMetadata,
  };

  getDb().query("UPDATE regex_scripts SET metadata = ? WHERE id = ? AND user_id = ?").run(
    JSON.stringify(nextMetadata),
    id,
    userId,
  );
  emitRegexChanged(userId, id);
  return { script: getRegexScript(userId, id), newlyFlagged: true };
}

function resolveCreateDisabledState(input: CreateRegexScriptInput, activePresetId: string | null): boolean {
  const requestedDisabled = !!input.disabled;
  const presetId = normalizeOptionalId(input.preset_id);
  if (!presetId) return requestedDisabled;
  if (presetId !== activePresetId) return true;
  return requestedDisabled;
}

type PresetBoundRowState = {
  id: string;
  preset_id: string;
  disabled: number;
};

function applyPresetBoundActivationWithDb(
  db: ReturnType<typeof getDb>,
  userId: string,
  targetPresetId: string | null,
): { changedIds: string[]; restoredIds: string[] } {
  const rows = db
    .query("SELECT id, preset_id, disabled FROM regex_scripts WHERE user_id = ? AND preset_id IS NOT NULL ORDER BY sort_order ASC, created_at ASC")
    .all(userId) as PresetBoundRowState[];
  if (rows.length === 0) return { changedIds: [], restoredIds: [] };

  let restoreIds = new Set<string>();
  if (targetPresetId) {
    const stored = readStoredPresetRegexIdsRecord(userId, targetPresetId);
    if (stored.exists) {
      restoreIds = new Set(stored.ids);
    } else {
      restoreIds = new Set(
        rows
          .filter((row) => row.preset_id === targetPresetId && !row.disabled)
          .map((row) => row.id),
      );
    }
  }

  const changedIds: string[] = [];
  const restoredIds: string[] = [];
  const updateDisabled = db.query("UPDATE regex_scripts SET disabled = ?, updated_at = ? WHERE id = ? AND user_id = ?");
  const now = Math.floor(Date.now() / 1000);

  for (const row of rows) {
    const shouldEnable = !!targetPresetId && row.preset_id === targetPresetId && restoreIds.has(row.id);
    const nextDisabled = shouldEnable ? 0 : 1;
    if (row.disabled !== nextDisabled) {
      updateDisabled.run(nextDisabled, now, row.id, userId);
      changedIds.push(row.id);
    }
    if (shouldEnable) restoredIds.push(row.id);
  }

  return { changedIds, restoredIds };
}

export function rowToRegexScript(row: any): RegexScript {
  return {
    ...row,
    script_id: row.script_id || "",
    placement: JSON.parse(row.placement),
    trim_strings: JSON.parse(row.trim_strings),
    folder: row.folder || "",
    pack_id: row.pack_id || null,
    preset_id: row.preset_id || null,
    character_id: row.character_id || null,
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

function hasMacroSyntax(pattern: string): boolean {
  return pattern.includes("{{") || pattern.includes("<USER>") || pattern.includes("<BOT>") || pattern.includes("<CHAR>");
}

function sanitizeRegexPatternForValidation(pattern: string): string {
  return pattern
    .replace(/\{\{[\s\S]*?\}\}/g, "x")
    .replace(/<USER>|<BOT>|<CHAR>/g, "x");
}

function validateRegex(
  pattern: string,
  flags: string,
  substituteMacros: RegexScript["substitute_macros"] = "none",
): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return "find_regex exceeds maximum length";
  if (!validateFlags(flags)) return "Invalid flags — allowed: g, i, m, s, u";
  try {
    const compilePattern = substituteMacros !== "none" && hasMacroSyntax(pattern)
      ? sanitizeRegexPatternForValidation(pattern)
      : pattern;
    new RegExp(compilePattern, flags);
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
  if (input.placement !== undefined) {
    if (!Array.isArray(input.placement)) return "placement must be an array";
    for (const p of input.placement) {
      if (!VALID_PLACEMENTS.has(p)) return `Invalid placement: ${p}`;
    }
  }
  if (input.scope !== undefined && !VALID_SCOPES.has(input.scope)) {
    return `Invalid scope: ${input.scope}`;
  }
  if (isCreate) {
    if (input.scope !== undefined && input.scope !== "global" && !input.scope_id) {
      return "scope_id is required for non-global scope";
    }
  } else {
    if (
      input.scope !== undefined &&
      input.scope !== "global" &&
      input.scope_id !== undefined &&
      !input.scope_id
    ) {
      return "scope_id is required for non-global scope";
    }
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
  filters?: { scope?: RegexScope; scope_id?: string; target?: RegexTarget; character_id?: string; chat_id?: string }
) {
  const conditions = ["user_id = ?"];
  const params: any[] = [userId];

  if (filters?.scope) {
    conditions.push("scope = ?");
    params.push(filters.scope);
  }
  if (filters?.scope_id) {
    conditions.push("scope_id = ?");
    params.push(filters.scope_id);
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

export function createRegexScript(
  userId: string,
  input: CreateRegexScriptInput,
  context?: RegexMutationContext,
): RegexScript | string {
  const err = validateInput(input, true);
  if (err) return err;

  const regexErr = validateRegex(input.find_regex, input.flags ?? "gi", input.substitute_macros ?? "none");
  if (regexErr) return regexErr;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const activePresetId = normalizeOptionalId(context?.activePresetId);
  const disabled = resolveCreateDisabledState(input, activePresetId);

  getDb()
    .query(
      `INSERT INTO regex_scripts (id, user_id, name, script_id, find_regex, replace_string, flags, placement, scope, scope_id, target, min_depth, max_depth, trim_strings, run_on_edit, substitute_macros, disabled, sort_order, description, folder, pack_id, preset_id, character_id, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
       disabled ? 1 : 0,
       input.sort_order ?? 0,
      input.description ?? "",
      input.folder ?? "",
      input.pack_id ?? null,
      input.preset_id ?? null,
      input.character_id ?? null,
      JSON.stringify(input.metadata ?? {}),
      now,
      now
    );

  const script = getRegexScript(userId, id)!;
  if (script.preset_id && script.preset_id === activePresetId) {
    setPresetBoundScriptEnabledInRestoreList(userId, script.preset_id, script.id, !script.disabled);
  }
  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id, script }, userId);
  return script;
}

export function updateRegexScript(
  userId: string,
  id: string,
  input: UpdateRegexScriptInput,
  context?: RegexMutationContext,
): RegexScript | string | null {
  const existing = getRegexScript(userId, id);
  if (!existing) return null;

  const activePresetId = normalizeOptionalId(context?.activePresetId);
  const isPresetBound = !!existing.preset_id;
  const nextInput: UpdateRegexScriptInput = { ...input };
  if (shouldResetRegexPerformance(nextInput)) {
    nextInput.metadata = withoutRegexPerformanceMetadata(nextInput.metadata ?? existing.metadata);
  }
  const hasPresetIdUpdate = Object.prototype.hasOwnProperty.call(nextInput, "preset_id");
  const nextPresetId = hasPresetIdUpdate ? normalizeOptionalId(nextInput.preset_id) : existing.preset_id;
  const mayPersistPresetEnablement = !!nextPresetId && nextPresetId === activePresetId;

  if (isPresetBound && nextInput.disabled !== undefined && nextPresetId && !mayPersistPresetEnablement) {
    delete nextInput.disabled;
  }
  if (nextPresetId && nextPresetId !== activePresetId && hasPresetIdUpdate) {
    nextInput.disabled = true;
  }

  // If updating regex or flags, validate together
  if (nextInput.find_regex !== undefined || nextInput.flags !== undefined || nextInput.substitute_macros !== undefined) {
    const pattern = nextInput.find_regex ?? existing.find_regex;
    const flags = nextInput.flags ?? existing.flags;
    const substituteMacros = nextInput.substitute_macros ?? existing.substitute_macros;
    const regexErr = validateRegex(pattern, flags, substituteMacros);
    if (regexErr) return regexErr;
  }

  const err = validateInput(nextInput, false);
  if (err) return err;

  const fields: string[] = [];
  const values: any[] = [];

  if (nextInput.name !== undefined) { fields.push("name = ?"); values.push(nextInput.name.trim()); }
  if (nextInput.script_id !== undefined) { fields.push("script_id = ?"); values.push(nextInput.script_id); }
  if (nextInput.find_regex !== undefined) { fields.push("find_regex = ?"); values.push(nextInput.find_regex); }
  if (nextInput.replace_string !== undefined) { fields.push("replace_string = ?"); values.push(nextInput.replace_string); }
  if (nextInput.flags !== undefined) { fields.push("flags = ?"); values.push(nextInput.flags); }
  if (nextInput.placement !== undefined) { fields.push("placement = ?"); values.push(JSON.stringify(nextInput.placement)); }
  if (nextInput.scope !== undefined) { fields.push("scope = ?"); values.push(nextInput.scope); }
  if (nextInput.scope_id !== undefined) { fields.push("scope_id = ?"); values.push(nextInput.scope_id); }
  if (nextInput.target !== undefined) { fields.push("target = ?"); values.push(nextInput.target); }
  if (nextInput.min_depth !== undefined) { fields.push("min_depth = ?"); values.push(nextInput.min_depth); }
  if (nextInput.max_depth !== undefined) { fields.push("max_depth = ?"); values.push(nextInput.max_depth); }
  if (nextInput.trim_strings !== undefined) { fields.push("trim_strings = ?"); values.push(JSON.stringify(nextInput.trim_strings)); }
  if (nextInput.run_on_edit !== undefined) { fields.push("run_on_edit = ?"); values.push(nextInput.run_on_edit ? 1 : 0); }
  if (nextInput.substitute_macros !== undefined) { fields.push("substitute_macros = ?"); values.push(nextInput.substitute_macros); }
  if (nextInput.disabled !== undefined) { fields.push("disabled = ?"); values.push(nextInput.disabled ? 1 : 0); }
  if (nextInput.sort_order !== undefined) { fields.push("sort_order = ?"); values.push(nextInput.sort_order); }
  if (nextInput.description !== undefined) { fields.push("description = ?"); values.push(nextInput.description); }
  if (nextInput.folder !== undefined) { fields.push("folder = ?"); values.push(nextInput.folder); }
  if (hasPresetIdUpdate) { fields.push("preset_id = ?"); values.push(nextPresetId); }
  if (nextInput.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(nextInput.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE regex_scripts SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);

  const updated = getRegexScript(userId, id)!;
  if (existing.preset_id && existing.preset_id !== updated.preset_id) {
    setPresetBoundScriptEnabledInRestoreList(userId, existing.preset_id, updated.id, false);
  }
  if (updated.preset_id && (hasPresetIdUpdate || (mayPersistPresetEnablement && nextInput.disabled !== undefined))) {
    setPresetBoundScriptEnabledInRestoreList(userId, updated.preset_id, updated.id, !updated.disabled);
  }
  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id, script: updated }, userId);
  return updated;
}

export function deleteRegexScript(userId: string, id: string): boolean {
  const existing = getRegexScript(userId, id);
  const result = getDb()
    .query("DELETE FROM regex_scripts WHERE id = ? AND user_id = ?")
    .run(id, userId);
  if (result.changes > 0) {
    if (existing?.preset_id) {
      setPresetBoundScriptEnabledInRestoreList(userId, existing.preset_id, existing.id, false);
    }
    eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id }, userId);
    return true;
  }
  return false;
}

/**
 * Bulk delete a set of regex scripts. Runs in a single transaction and emits
 * REGEX_SCRIPT_DELETED per removed row. Returns the IDs that were actually
 * deleted (missing / cross-user IDs are silently skipped).
 */
export function deleteRegexScripts(userId: string, ids: string[]): string[] {
  if (ids.length === 0) return [];

  const db = getDb();
  const placeholders = ids.map(() => "?").join(", ");
  const existingRows = db
    .query(`SELECT id, preset_id FROM regex_scripts WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...ids) as Array<{ id: string; preset_id?: string | null }>;
  if (existingRows.length === 0) return [];

  const existingIds = existingRows.map((r) => r.id);
  const existingPlaceholders = existingIds.map(() => "?").join(", ");

  db.transaction(() => {
    db
      .query(`DELETE FROM regex_scripts WHERE user_id = ? AND id IN (${existingPlaceholders})`)
      .run(userId, ...existingIds);
  })();

  for (const row of existingRows) {
    if (row.preset_id) {
      setPresetBoundScriptEnabledInRestoreList(userId, row.preset_id, row.id, false);
    }
  }

  for (const id of existingIds) {
    eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id }, userId);
  }

  return existingIds;
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

export function toggleRegexScript(
  userId: string,
  id: string,
  disabled: boolean,
  context?: RegexMutationContext,
): RegexScript | null {
  const existing = getRegexScript(userId, id);
  if (!existing) return null;

  const activePresetId = normalizeOptionalId(context?.activePresetId);
  if (existing.preset_id && existing.preset_id !== activePresetId) {
    return existing;
  }

  getDb()
    .query("UPDATE regex_scripts SET disabled = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(disabled ? 1 : 0, Math.floor(Date.now() / 1000), id, userId);

  const updated = getRegexScript(userId, id)!;
  if (updated.preset_id) {
    setPresetBoundScriptEnabledInRestoreList(userId, updated.preset_id, updated.id, !updated.disabled);
  }
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
 * Resolve macros in a regex find pattern based on the substitute_macros mode.
 * The result stays as plain regex source, so `$` is not escaped here.
 */
function foldFingerprint(
  acc: { touchedVars: Set<string>; cacheable: boolean } | undefined,
  result: { touchedVars: ReadonlySet<string>; cacheable: boolean },
): void {
  if (!acc) return;
  for (const v of result.touchedVars) acc.touchedVars.add(v);
  if (!result.cacheable) acc.cacheable = false;
}

async function resolveFindMacros(
  findRegex: string,
  mode: RegexScript["substitute_macros"],
  macroEnv: MacroEnv,
  outFingerprint?: { touchedVars: Set<string>; cacheable: boolean },
): Promise<string> {
  if (mode === "none") return findRegex;
  const result = await evaluate(findRegex, macroEnv, registry);
  foldFingerprint(outFingerprint, result);
  return result.text;
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
  outFingerprint?: { touchedVars: Set<string>; cacheable: boolean },
): Promise<string> {
  if (mode === "none") return replaceString;

  const result = await evaluate(replaceString, macroEnv, registry);
  foldFingerprint(outFingerprint, result);
  const resolved = result.text;

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
 * When `macroEnv` is provided, scripts with `substitute_macros` enabled resolve
 * both their `find_regex` and `replace_string` through the macro engine.
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
  resolvedTemplates?: {
    resolvedFindPatterns?: Map<string, string>;
    resolvedReplacements?: Map<string, string>;
  },
  options?: ApplyRegexScriptOptions,
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

    const startedAt = Date.now();
    try {
      let findRegex = script.find_regex;
      const preResolvedFind = resolvedTemplates?.resolvedFindPatterns?.get(script.id);
      if (preResolvedFind !== undefined) {
        findRegex = preResolvedFind;
      } else if (macroEnv && script.substitute_macros !== "none") {
        findRegex = await resolveFindMacros(findRegex, script.substitute_macros, macroEnv, options?.outFingerprint);
      }

      if (macroEnv && script.substitute_macros === "raw") {
        // "raw" mode: substitute capture groups into the replacement template
        // BEFORE macro resolution so $1, $2, etc. are available inside macros.
        // Match collection runs in the regex sandbox so a pathological
        // user-authored pattern can't freeze the event loop here.
        const matches: SandboxMatch[] = await regexCollectSandboxed(
          findRegex,
          script.flags,
          result,
          REGEX_SCRIPT_TIMEOUT_MS,
        );
        if (matches.length > 0) {
          const replacements = await Promise.all(
            matches.map(async ({ fullMatch, groups, index, namedGroups }) => {
              const withCaptures = substituteRegexCaptures(
                script.replace_string, fullMatch, groups, index, result, namedGroups,
              );
              const evalResult = await evaluate(withCaptures, macroEnv, registry);
              foldFingerprint(options?.outFingerprint, evalResult);
              return evalResult.text;
            }),
          );
          result = rebuildFromMatches(result, matches, replacements);
        }
      } else if (macroEnv && script.substitute_macros === "after") {
        const substituted = await regexReplaceSandboxed(
          findRegex,
          script.flags,
          result,
          script.replace_string,
          REGEX_SCRIPT_TIMEOUT_MS,
        );
        const evalResult = await evaluate(substituted, macroEnv, registry);
        foldFingerprint(options?.outFingerprint, evalResult);
        result = evalResult.text;
      } else {
        // "none" or "escaped" mode: resolve macros first (if applicable), then
        // run the actual replace inside the sandbox.
        let replaceString = script.replace_string;
        const preResolvedReplacement = resolvedTemplates?.resolvedReplacements?.get(script.id);
        if (preResolvedReplacement !== undefined) {
          replaceString = script.substitute_macros === "escaped"
            ? preResolvedReplacement.replace(/\$/g, "$$$$")
            : preResolvedReplacement;
        } else if (macroEnv && script.substitute_macros !== "none") {
          replaceString = await resolveReplacementMacros(replaceString, script.substitute_macros, macroEnv, options?.outFingerprint);
        }
        result = await regexReplaceSandboxed(
          findRegex,
          script.flags,
          result,
          replaceString,
          REGEX_SCRIPT_TIMEOUT_MS,
        );
      }

      // Apply trim_strings
      if (script.trim_strings.length > 0) {
        for (const trim of script.trim_strings) {
          while (result.includes(trim)) {
            result = result.replaceAll(trim, "");
          }
        }
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= REGEX_SLOW_WARNING_MS) {
        const flagged = reportRegexScriptPerformance(script.user_id, script.id, {
          elapsedMs,
          thresholdMs: REGEX_SLOW_WARNING_MS,
          source: options?.source,
        });
        options?.onPerformanceIssue?.({
          scriptId: script.id,
          name: script.name,
          elapsedMs,
          thresholdMs: REGEX_SLOW_WARNING_MS,
          timedOut: false,
          source: options?.source ?? "display_backend",
          newlyFlagged: flagged.newlyFlagged,
        });
      }
    } catch (e) {
      if (e instanceof RegexTimeoutError) {
        const elapsedMs = Date.now() - startedAt;
        const flagged = reportRegexScriptPerformance(script.user_id, script.id, {
          elapsedMs,
          timedOut: true,
          thresholdMs: REGEX_SCRIPT_TIMEOUT_MS,
          source: options?.source,
        });
        options?.onPerformanceIssue?.({
          scriptId: script.id,
          name: script.name,
          elapsedMs,
          thresholdMs: REGEX_SCRIPT_TIMEOUT_MS,
          timedOut: true,
          source: options?.source ?? "display_backend",
          newlyFlagged: flagged.newlyFlagged,
        });
        console.warn(
          `[RegexScripts] Script "${script.name}" (${script.id}) exceeded ${REGEX_SCRIPT_TIMEOUT_MS}ms, skipping`,
        );
        continue;
      }
      console.warn(`[RegexScripts] Failed to apply script "${script.name}" (${script.id}):`, e);
    }
  }

  return result;
}

// ── Test ─────────────────────────────────────────────────────────────────────

const TEST_REGEX_TIMEOUT_MS = 1_000;

export async function testRegex(
  findRegex: string,
  replaceString: string,
  flags: string,
  content: string,
): Promise<{ result: string; matches: number; error?: string }> {
  try {
    const out = await regexTestSandboxed(
      findRegex,
      flags,
      content,
      replaceString,
      TEST_REGEX_TIMEOUT_MS,
    );
    return out;
  } catch (e: any) {
    if (e instanceof RegexTimeoutError) {
      // Surface the timeout to the caller as a soft error so the UI can show
      // "your regex is too slow / contains catastrophic backtracking" without
      // a 500.
      return { result: content, matches: 0, error: e.message };
    }
    return { result: content, matches: 0, error: e?.message || "Regex error" };
  }
}

// ── Import / Export ──────────────────────────────────────────────────────────

export interface RegexScriptExportOptions {
  ids?: string[];
  presetId?: string | null;
  folder?: string | null;
}

export function exportRegexScripts(userId: string, options?: string[] | RegexScriptExportOptions): RegexScriptExport {
  const db = getDb();
  let rows: any[];
  const ids = Array.isArray(options) ? options : options?.ids;
  const presetIdFilter = !Array.isArray(options) ? normalizeOptionalId(options?.presetId) : null;

  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    rows = db
      .query(`SELECT * FROM regex_scripts WHERE user_id = ? AND id IN (${placeholders}) ORDER BY sort_order ASC, created_at ASC`)
      .all(userId, ...ids) as any[];
  } else {
    const conditions = ["user_id = ?"];
    const params: any[] = [userId];
    if (!Array.isArray(options)) {
      if (presetIdFilter) {
        conditions.push("preset_id = ?");
        params.push(presetIdFilter);
      }
      if (typeof options?.folder === "string") {
        conditions.push("folder = ?");
        params.push(options.folder.trim());
      }
    }
    rows = db
      .query(`SELECT * FROM regex_scripts WHERE ${conditions.join(" AND ")} ORDER BY sort_order ASC, created_at ASC`)
      .all(...params) as any[];
  }

  let normalizedRows = rows.map(rowToRegexScript);
  if (presetIdFilter) {
    const stored = readStoredPresetRegexIdsRecord(userId, presetIdFilter);
    if (stored.exists) {
      const enabledIds = new Set(stored.ids);
      normalizedRows = normalizedRows.map((s) => ({ ...s, disabled: !enabledIds.has(s.id) }));
    }
  }

  const scripts = normalizedRows.map((s) => {
    const { id, user_id, created_at, updated_at, pack_id, preset_id, character_id, ...rest } = s;
    return rest;
  });

  return {
    version: 1,
    type: "lumiverse_regex_scripts",
    scripts,
    exported_at: Math.floor(Date.now() / 1000),
  };
}

export function getRegexScriptsByPackId(userId: string, packId: string): RegexScript[] {
  const rows = getDb()
    .query("SELECT * FROM regex_scripts WHERE user_id = ? AND pack_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(userId, packId) as any[];
  return rows.map(rowToRegexScript);
}

export function getRegexScriptsByPresetId(userId: string, presetId: string): RegexScript[] {
  const rows = getDb()
    .query("SELECT * FROM regex_scripts WHERE user_id = ? AND preset_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(userId, presetId) as any[];
  return rows.map(rowToRegexScript);
}

export function activatePresetBoundRegexScripts(userId: string, presetId?: string | null): { changedIds: string[]; restoredIds: string[] } {
  const targetPresetId = normalizeOptionalId(presetId);
  const db = getDb();
  const result = db.transaction(() => applyPresetBoundActivationWithDb(db, userId, targetPresetId))();

  for (const id of result.changedIds) {
    emitRegexChanged(userId, id);
  }

  return result;
}

export function switchPresetBoundRegexScripts(
  userId: string,
  opts: { previousPresetId?: string | null; presetId?: string | null },
): { changedIds: string[]; restoredIds: string[] } {
  const previousPresetId = normalizeOptionalId(opts.previousPresetId);
  const targetPresetId = normalizeOptionalId(opts.presetId);
  const db = getDb();

  const result = db.transaction(() => {
    if (previousPresetId) {
      const enabledRows = db
        .query(
          "SELECT id FROM regex_scripts WHERE user_id = ? AND preset_id = ? AND disabled = 0 ORDER BY sort_order ASC, created_at ASC",
        )
        .all(userId, previousPresetId) as Array<{ id: string }>;
      writeStoredPresetRegexIdsWithDb(db, userId, previousPresetId, enabledRows.map((row) => row.id));
    }

    return applyPresetBoundActivationWithDb(db, userId, targetPresetId);
  })();

  for (const id of result.changedIds) {
    emitRegexChanged(userId, id);
  }

  return result;
}

export function getRegexScriptsByCharacterId(userId: string, characterId: string): RegexScript[] {
  const rows = getDb()
    .query("SELECT * FROM regex_scripts WHERE user_id = ? AND character_id = ? ORDER BY sort_order ASC, created_at ASC")
    .all(userId, characterId) as any[];
  return rows.map(rowToRegexScript);
}

/**
 * Delete every regex script owned by a preset. Emits REGEX_SCRIPT_DELETED per
 * removed script so subscribed clients update their lists.
 */
export function deleteRegexScriptsByPresetId(userId: string, presetId: string): number {
  const db = getDb();
  const rows = db
    .query("SELECT id FROM regex_scripts WHERE user_id = ? AND preset_id = ?")
    .all(userId, presetId) as Array<{ id: string }>;
  if (rows.length === 0) {
    deleteStoredPresetRegexIds(userId, presetId);
    return 0;
  }

  const result = db
    .query("DELETE FROM regex_scripts WHERE user_id = ? AND preset_id = ?")
    .run(userId, presetId);
  const changes = Number(result.changes ?? 0);

  for (const { id } of rows) {
    eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id }, userId);
  }

  deleteStoredPresetRegexIds(userId, presetId);

  return changes;
}

/**
 * Delete every regex script owned by a character import/generation flow. Emits
 * REGEX_SCRIPT_DELETED per removed script so subscribed clients update their lists.
 */
export function deleteRegexScriptsByCharacterId(userId: string, characterId: string): number {
  const db = getDb();
  const rows = db
    .query("SELECT id FROM regex_scripts WHERE user_id = ? AND character_id = ?")
    .all(userId, characterId) as Array<{ id: string }>;
  if (rows.length === 0) return 0;

  const result = db
    .query("DELETE FROM regex_scripts WHERE user_id = ? AND character_id = ?")
    .run(userId, characterId);
  const changes = Number(result.changes ?? 0);

  for (const { id } of rows) {
    eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id }, userId);
  }

  return changes;
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
  payload: any,
  context?: RegexMutationContext,
): { imported: number; skipped: number; errors: string[] } {
  const errors: string[] = [];
  let imported = 0;
  let skipped = 0;

  // Extract top-level folder override (e.g. preset name)
  const folderOverride: string | undefined =
    typeof payload?.folder === "string" && payload.folder.trim()
      ? payload.folder.trim()
      : undefined;

  // Extract top-level preset_id ownership link so preset deletion can cascade
  const presetIdOverride: string | undefined =
    typeof payload?.preset_id === "string" && payload.preset_id.trim()
      ? payload.preset_id.trim()
      : undefined;

  // Extract top-level character_id ownership link so character deletion can cascade
  const characterIdOverride: string | undefined =
    typeof payload?.character_id === "string" && payload.character_id.trim()
      ? payload.character_id.trim()
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

    // Stamp preset ownership if provided
    if (presetIdOverride && !item.preset_id) {
      item.preset_id = presetIdOverride;
    }

    // Stamp character ownership if provided
    if (characterIdOverride && !item.character_id) {
      item.character_id = characterIdOverride;
    }

    const result = createRegexScript(userId, item, context);
    if (typeof result === "string") {
      errors.push(`Script "${item.name}": ${result}`);
      skipped++;
    } else {
      imported++;
    }
  }

  return { imported, skipped, errors };
}

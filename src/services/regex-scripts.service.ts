import { readDatabaseRow, readDatabaseRows, runDatabaseStatement } from "../db/queries";
import { mutateRegexWithDb, type RegexMutationResult } from "../db/regex-operations";
import { getDb } from "../db/connection";
import { executeDatabaseOperation } from "../db/execution";
import { paginatedQuery, paginatedQueryAsync } from "./pagination";
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
  RegexAction,
  RegexActionEffect,
} from "../types/regex-script";
import type { MacroEnv } from "../macros/types";
import { evaluate, type EvaluateOptions } from "../macros/MacroEvaluator";
import { registry } from "../macros/MacroRegistry";
import {
  regexCollectSandboxed,
  regexCaptureReplacementsSandboxed,
  regexReplaceSandboxed,
  regexTestSandboxed,
  RegexSandboxShutdownError,
  RegexTimeoutError,
  type SandboxCaptureReplacement,
  type SandboxMatch,
} from "../utils/regex-sandbox";
import { substituteRegexCaptures as substituteRegexCapturesCore } from "../utils/regex-sandbox-core";
import {
  buildRegexActionCaptureTemplate,
  decorateRegexActionReplacements,
} from "../utils/regex-actions";
import { applyRegexTrimStrings } from "../utils/regex-trim";
import { readPromptActivation, validatePromptActivation } from "../utils/regex-prompt-activation";
import { activationPatternForValidation, resolveActivationFindPattern, type ActivationInputSnapshot } from "../utils/regex-activation-inputs";
import type { PromptBlock } from "../types/preset";

const REGEX_SCRIPT_TIMEOUT_MS = 500;
const REGEX_SLOW_WARNING_MS = 5_000;
const REGEX_PERFORMANCE_ENGINE_VERSION = 2;

type RegexPerformanceSource = "prompt_backend" | "response_backend" | "display_backend" | "display_client";

interface RegexPerformanceMetadata {
  slow: boolean;
  timed_out: boolean;
  elapsed_ms: number;
  threshold_ms: number;
  detected_at: number;
  source: RegexPerformanceSource;
  version: number;
  engine_version: number;
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
  cleared: boolean;
}

interface ApplyRegexScriptOptions {
  source?: RegexPerformanceSource;
  onPerformanceIssue?: (issue: RegexPerformanceIssue) => void;
  outFingerprint?: { touchedVars: Set<string>; cacheable: boolean };
  previousContent?: string;
}

export type RegexMatchAction = "move_top" | "move_bottom" | "repeat_back";

export function hasRegexMatchAction(
  scripts: readonly { metadata?: Record<string, any> }[],
  action: RegexMatchAction,
): boolean {
  return scripts.some(
    (script) =>
      Array.isArray(script.metadata?.match_actions)
      && script.metadata.match_actions.includes(action),
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_PLACEMENTS = new Set(["user_input", "ai_output", "world_info", "reasoning", "memory"]);
const VALID_SCOPES = new Set(["global", "character", "chat"]);
const VALID_TARGETS = new Set(["prompt", "response", "display"]);
const VALID_FLAGS = new Set(["d", "g", "i", "m", "s", "u", "v", "y"]);
const VALID_MACRO_MODES = new Set(["none", "find", "raw", "escaped", "after"]);
export const MAX_REGEX_PATTERN_LENGTH = 50_000;
const MAX_REGEX_ACTIONS = 50;
const MAX_REGEX_ACTION_FIELD_LENGTH = 10_000;
const REGEX_ACTION_ID_RE = /^[A-Za-z][A-Za-z0-9_:.-]{0,63}$/;
const REGEX_ACTION_STATE_KEY_RE = /^[A-Za-z][A-Za-z0-9_:.-]{0,127}$/;
const PRESET_REGEX_ENABLED_SETTING_PREFIX = "presetRegexEnabled:";
const IMPORTED_SOURCE_SCRIPT_ID_METADATA_KEY = "imported_script_id";
const SPINDLE_EXTENSION_REGEX_METADATA_KEY = "_lumiverse_spindle_extension";
const MAX_REGEX_FOLDER_VERSION_LENGTH = 100;

interface RegexMutationContext {
  activePresetId?: string | null;
  /** Identifies the calling extension and applies the default ownership boundary. */
  extensionIdentifier?: string;
  /** Explicitly-authorized editors may mutate rows outside their extension ownership boundary. */
  allowUnownedMutation?: boolean;
  /** Present only when a Spindle mutation explicitly supplied folder_version. */
  extensionFolderVersion?: unknown;
}

// Wording is intentionally unchanged from the pre-preset-link behaviour. The rule
// behind it is now ownership-only, but extensions and other callers compare this
// string verbatim, so the message is kept byte-identical and the semantics live in
// the docs instead. Change it only with a deliberate breaking migration.
const EXTENSION_REGEX_OWNERSHIP_ERROR = "Regex script is not an unbound script owned by this extension";

function normalizeOptionalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * A preset link is resolved by user whenever it is used: the deletion cascade
 * (deleteRegexScriptsByPresetId) matches on user_id + preset_id, and preset
 * activation reads the preset's own restore list. A link to an unknown preset,
 * or to another user's preset, would therefore persist as an orphan row that no
 * cascade can ever reach, so it is rejected instead of stored.
 */
function validateOwnedPresetLink(userId: string, presetId: string): string | null {
  const preset = getDb().query("SELECT 1 AS found FROM presets WHERE id = ? AND user_id = ?")
    .get(presetId, userId);
  return preset ? null : "Linked preset not found";
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
  if (value.engine_version !== REGEX_PERFORMANCE_ENGINE_VERSION) return null;
  return {
    slow: true,
    timed_out: value.timed_out === true,
    elapsed_ms: typeof value.elapsed_ms === "number" ? value.elapsed_ms : 0,
    threshold_ms: typeof value.threshold_ms === "number" ? value.threshold_ms : REGEX_SLOW_WARNING_MS,
    detected_at: typeof value.detected_at === "number" ? value.detected_at : 0,
    source: (value.source as RegexPerformanceSource) || "display_backend",
    version: value.version,
    engine_version: value.engine_version,
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

function isDisplayPerformanceSource(source: RegexPerformanceSource): boolean {
  return source === "display_client" || source === "display_backend";
}

function performanceSourcesMatch(existing: RegexPerformanceSource, current: RegexPerformanceSource): boolean {
  return existing === current || (isDisplayPerformanceSource(existing) && isDisplayPerformanceSource(current));
}

export function reportRegexScriptPerformance(
  userId: string,
  id: string,
  issue: { elapsedMs: number; timedOut?: boolean; thresholdMs?: number; source?: RegexPerformanceSource },
): RegexPerformanceReportResult {
  const script = getRegexScript(userId, id);
  if (!script) return { script: null, newlyFlagged: false, cleared: false };

  const thresholdMs = issue.thresholdMs ?? REGEX_SLOW_WARNING_MS;
  const timedOut = issue.timedOut === true;
  const source = issue.source ?? "display_backend";
  const existing = getRegexPerformanceMetadata(script);
  if (!timedOut && issue.elapsedMs < thresholdMs) {
    // A display regex can be expensive only for particular message content or
    // macro expansions. Clear a warning once that same execution path has
    // completed quickly for the current saved script version. Display-client
    // and display-backend executions are equivalent for this purpose, while
    // prompt and response runs remain isolated from display warnings.
    if (
      existing &&
      existing.version === script.updated_at &&
      performanceSourcesMatch(existing.source, source) &&
      existing.threshold_ms === thresholdMs
    ) {
      getDb().query("UPDATE regex_scripts SET metadata = ? WHERE id = ? AND user_id = ?").run(
        JSON.stringify(withoutRegexPerformanceMetadata(script.metadata)),
        id,
        userId,
      );
      emitRegexChanged(userId, id);
      return { script: getRegexScript(userId, id), newlyFlagged: false, cleared: true };
    }
    return { script, newlyFlagged: false, cleared: false };
  }

  if (
    existing &&
    existing.version === script.updated_at &&
    existing.timed_out === timedOut &&
    existing.threshold_ms === thresholdMs
  ) {
    return { script, newlyFlagged: false, cleared: false };
  }

  const nextMetadata = {
    ...withoutRegexPerformanceMetadata(script.metadata),
    regex_performance: {
      slow: true,
      timed_out: timedOut,
      elapsed_ms: Math.max(0, Math.round(issue.elapsedMs)),
      threshold_ms: thresholdMs,
      detected_at: Math.floor(Date.now() / 1000),
      source,
      version: script.updated_at,
      engine_version: REGEX_PERFORMANCE_ENGINE_VERSION,
    } satisfies RegexPerformanceMetadata,
  };

  getDb().query("UPDATE regex_scripts SET metadata = ? WHERE id = ? AND user_id = ?").run(
    JSON.stringify(nextMetadata),
    id,
    userId,
  );
  emitRegexChanged(userId, id);
  return { script: getRegexScript(userId, id), newlyFlagged: true, cleared: false };
}

// Client-side evidence persistence for the display-regex execution tiers
// (metadata.regex_evidence.quarantined). Quarantine deliberately survives a
// script edit: a pattern that hung the executor stays skipped until the user
// clears it from the panel, which sends `quarantined: false` and deletes the
// key here. Timing evidence used to live alongside it and was removed — no
// consumer read it, so it could never affect tier selection.
export function reportRegexScriptEvidence(
  userId: string,
  id: string,
  patch: { quarantined?: boolean },
): RegexScript | null {
  const script = getRegexScript(userId, id);
  if (!script) return null;

  const metadata: Record<string, any> =
    script.metadata && typeof script.metadata === "object" ? { ...script.metadata } : {};
  const evidence =
    metadata.regex_evidence && typeof metadata.regex_evidence === "object" ? { ...metadata.regex_evidence } : {};

  if (patch.quarantined !== undefined) {
    if (patch.quarantined) {
      evidence.quarantined = true;
    } else {
      delete evidence.quarantined;
    }
  }

  metadata.regex_evidence = evidence;
  getDb().query("UPDATE regex_scripts SET metadata = ? WHERE id = ? AND user_id = ?").run(
    JSON.stringify(metadata),
    id,
    userId,
  );
  emitRegexChanged(userId, id);
  return getRegexScript(userId, id);
}

function resolveCreateDisabledState(
  input: CreateRegexScriptInput,
  activePresetId: string | null,
  presetActivationManaged = true,
): boolean {
  const requestedDisabled = !!input.disabled;
  // Extension-owned rows are not driven by preset activation: the extension that
  // created the row keeps its enabled state, even while it carries a preset link.
  if (!presetActivationManaged) return requestedDisabled;
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
  // Extension-owned rows are excluded: their preset link is a lifecycle link, so
  // preset activation neither disables an extension's row nor enables it against
  // the extension's own `disabled` state.
  const rows = db
    .query("SELECT id, preset_id, disabled FROM regex_scripts WHERE user_id = ? AND preset_id IS NOT NULL AND owner_extension_identifier IS NULL ORDER BY sort_order ASC, created_at ASC")
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
  let target: RegexTarget[];
  try {
    const parsed = JSON.parse(row.target);
    target = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    target = [row.target || "response"];
  }
  return {
    ...row,
    script_id: row.script_id || "",
    actions: normalizeRegexActions(parseJsonArray(row.actions)),
    placement: JSON.parse(row.placement),
    target,
    trim_strings: JSON.parse(row.trim_strings),
    folder: row.folder || "",
    pack_id: row.pack_id || null,
    preset_id: row.preset_id || null,
    character_id: row.character_id || null,
    owner_extension_identifier: row.owner_extension_identifier || null,
    metadata: JSON.parse(row.metadata),
    run_on_edit: !!row.run_on_edit,
    disabled: !!row.disabled,
  };
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function normalizeRegexActions(value: unknown): RegexAction[] {
  if (!Array.isArray(value)) return [];
  const actions: RegexAction[] = [];
  for (const raw of value.slice(0, MAX_REGEX_ACTIONS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const type = item.type === "append" || item.type === "send" || item.type === "effects" ? item.type : null;
    if (!REGEX_ACTION_ID_RE.test(id) || !type) continue;
    const effects = Array.isArray(item.effects)
      ? item.effects.slice(0, 16).flatMap((rawEffect): RegexActionEffect[] => {
          if (!rawEffect || typeof rawEffect !== "object") return [];
          const effect = rawEffect as Record<string, unknown>;
          if (effect.type === "set_state") {
            const key = typeof effect.key === "string" ? effect.key.trim() : "";
            if (!REGEX_ACTION_STATE_KEY_RE.test(key)) return [];
            return [{
              type: "set_state",
              key,
              value: typeof effect.value === "string"
                ? effect.value.slice(0, MAX_REGEX_ACTION_FIELD_LENGTH)
                : "",
            }];
          }
          if (effect.type === "draft") {
            return [{
              type: "draft",
              content: typeof effect.content === "string"
                ? effect.content.slice(0, MAX_REGEX_ACTION_FIELD_LENGTH)
                : "",
              mode: effect.mode === "append" ? "append" : "replace",
            }];
          }
          if (effect.type === "fork") return [{ type: "fork" }];
          return [];
        })
      : [];
    const compatibleEffects = type === "effects"
      ? effects
      : effects.filter((effect) => effect.type === "set_state");
    if (type === "effects" && compatibleEffects.length === 0) continue;
    actions.push({
      id,
      type,
      multi_select: type === "effects" ? false : item.multi_select === true,
      cost: typeof item.cost === "string" ? item.cost.slice(0, MAX_REGEX_ACTION_FIELD_LENGTH) : "1",
      limit: typeof item.limit === "string" ? item.limit.slice(0, MAX_REGEX_ACTION_FIELD_LENGTH) : "3",
      title: typeof item.title === "string" ? item.title.slice(0, MAX_REGEX_ACTION_FIELD_LENGTH) : "",
      subtitle: typeof item.subtitle === "string" ? item.subtitle.slice(0, MAX_REGEX_ACTION_FIELD_LENGTH) : "",
      content: typeof item.content === "string" ? item.content.slice(0, MAX_REGEX_ACTION_FIELD_LENGTH) : "",
      ...(compatibleEffects.length > 0 ? { effects: compatibleEffects } : {}),
    });
  }
  return actions;
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
  activation = false,
): string | null {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) return "find_regex exceeds maximum length";
  if (!validateFlags(flags)) return "Invalid flags — allowed: d, g, i, m, s, u, v, y";
  try {
    const compilePattern = activation ? activationPatternForValidation(pattern)
      : substituteMacros !== "none" && hasMacroSyntax(pattern)
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

  if (input.find_regex !== undefined && input.find_regex.length > MAX_REGEX_PATTERN_LENGTH) {
    return "find_regex exceeds maximum length";
  }
  if (input.actions !== undefined) {
    if (!Array.isArray(input.actions)) return "actions must be an array";
    if (input.actions.length > MAX_REGEX_ACTIONS) return `actions exceeds maximum length (${MAX_REGEX_ACTIONS})`;
    const ids = new Set<string>();
    for (const action of input.actions) {
      if (!action || typeof action !== "object") return "actions contains an invalid entry";
      if (!REGEX_ACTION_ID_RE.test(action.id?.trim?.() ?? "")) {
        return "action id must start with a letter and contain only letters, numbers, _, :, . or -";
      }
      if (ids.has(action.id.trim())) return `duplicate action id: ${action.id.trim()}`;
      ids.add(action.id.trim());
      if (action.type !== "send" && action.type !== "append" && action.type !== "effects") {
        return `Invalid action type: ${action.type}`;
      }
      if (action.multi_select !== undefined && typeof action.multi_select !== "boolean") {
        return "action multi_select must be a boolean";
      }
      for (const field of [action.title, action.subtitle, action.content, action.cost ?? "1", action.limit ?? "3"]) {
        if (typeof field !== "string") return "action title, subtitle, content, cost, and limit must be strings";
        if (field.length > MAX_REGEX_ACTION_FIELD_LENGTH) return "action field exceeds maximum length";
      }
      if (action.type !== "effects" && !action.content.trim()) return `action content is required: ${action.id}`;
      if (action.type === "effects" && action.multi_select) return "effects-only actions cannot be multi-select";
      if (action.type === "effects" && (!action.effects || action.effects.length === 0)) {
        return `effects-only action requires at least one effect: ${action.id}`;
      }
      if (action.effects !== undefined) {
        if (!Array.isArray(action.effects)) return "action effects must be an array";
        if (action.effects.length > 16) return "action effects exceeds maximum length (16)";
        for (const effect of action.effects) {
          if (!effect || typeof effect !== "object" || !["set_state", "draft", "fork"].includes(effect.type)) {
            return "action contains an unsupported effect";
          }
          if (effect.type === "set_state") {
            if (typeof effect.key !== "string" || !REGEX_ACTION_STATE_KEY_RE.test(effect.key.trim())) {
              return "state effect key must start with a letter and contain only letters, numbers, _, :, . or -";
            }
            if (typeof effect.value !== "string") return "state effect value must be a string";
            if (effect.value.length > MAX_REGEX_ACTION_FIELD_LENGTH) return "state effect value exceeds maximum length";
          } else if (effect.type === "draft") {
            if (typeof effect.content !== "string" || !effect.content.trim()) return "draft effect content is required";
            if (effect.content.length > MAX_REGEX_ACTION_FIELD_LENGTH) return "draft effect content exceeds maximum length";
            if (effect.mode !== "replace" && effect.mode !== "append") return "draft effect mode must be replace or append";
          }
        }
        if (action.effects.filter((effect) => effect.type === "draft").length > 1) return "an action can contain only one draft effect";
        if (action.effects.filter((effect) => effect.type === "fork").length > 1) return "an action can contain only one fork effect";
        if (action.type !== "effects" && action.effects.some((effect) => effect.type === "draft" || effect.type === "fork")) {
          return "draft and fork effects require an effects-only action";
        }
      }
    }
    input.actions = normalizeRegexActions(input.actions);
  }
  if (input.flags !== undefined && !validateFlags(input.flags)) {
    return "Invalid flags — allowed: d, g, i, m, s, u, v, y";
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
  if (input.target !== undefined) {
    if (typeof input.target === "string") {
      (input as any).target = [input.target];
    }
    if (!Array.isArray(input.target) || input.target.length === 0) {
      return "target must be a non-empty array";
    }
    for (const t of input.target) {
      if (!VALID_TARGETS.has(t)) return `Invalid target: ${t}`;
    }
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

function isPlainMetadataRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface SpindleExtensionRegexAttribution {
  identifier: string;
  version: string;
}

function getSpindleExtensionRegexAttribution(metadata: unknown): SpindleExtensionRegexAttribution | null {
  if (!isPlainMetadataRecord(metadata)) return null;
  const raw = metadata[SPINDLE_EXTENSION_REGEX_METADATA_KEY];
  if (!isPlainMetadataRecord(raw)) return null;
  const identifier = normalizeOptionalId(raw.identifier);
  const version = normalizeOptionalId(raw.version);
  return identifier && version ? { identifier, version } : null;
}

/** Return trusted folder-version attribution for a Spindle-owned regex script. */
export function getSpindleExtensionRegexFolderVersion(
  script: Pick<RegexScript, "folder" | "owner_extension_identifier" | "metadata">,
): string | null {
  const owner = normalizeOptionalId(script.owner_extension_identifier);
  if (!owner || !normalizeOptionalId(script.folder)) return null;
  const attribution = getSpindleExtensionRegexAttribution(script.metadata);
  return attribution?.identifier === owner ? attribution.version : null;
}

function validateExtensionFolderVersion(context?: RegexMutationContext): string | null {
  if (!context || !Object.prototype.hasOwnProperty.call(context, "extensionFolderVersion")) return null;
  const value = context.extensionFolderVersion;
  if (value !== null && value !== undefined && typeof value !== "string") {
    return "folder_version must be a string or null";
  }
  if (typeof value === "string" && value.trim().length > MAX_REGEX_FOLDER_VERSION_LENGTH) {
    return `folder_version exceeds maximum length (${MAX_REGEX_FOLDER_VERSION_LENGTH} characters)`;
  }
  return null;
}

function applySpindleExtensionRegexAttribution<T extends CreateRegexScriptInput | UpdateRegexScriptInput>(
  input: T,
  extensionIdentifier: string,
  context: RegexMutationContext,
  existing?: RegexScript,
): T {
  const suppliedVersion = Object.prototype.hasOwnProperty.call(context, "extensionFolderVersion");
  const shouldWriteMetadata = !existing
    || input.metadata !== undefined
    || input.folder !== undefined
    || suppliedVersion;
  if (!shouldWriteMetadata) return { ...input };

  const metadataSource = input.metadata !== undefined ? input.metadata : existing?.metadata;
  const metadata = isPlainMetadataRecord(metadataSource) ? { ...metadataSource } : {};
  delete metadata[SPINDLE_EXTENSION_REGEX_METADATA_KEY];

  const existingAttribution = existing
    ? getSpindleExtensionRegexAttribution(existing.metadata)
    : null;
  const version = suppliedVersion
    ? normalizeOptionalId(context.extensionFolderVersion)
    : existingAttribution?.identifier === extensionIdentifier
      ? existingAttribution.version
      : null;
  const folder = input.folder !== undefined ? input.folder : existing?.folder;

  if (version && normalizeOptionalId(folder)) {
    metadata[SPINDLE_EXTENSION_REGEX_METADATA_KEY] = { identifier: extensionIdentifier, version };
  }

  return { ...input, metadata };
}

function mapRegexScriptPersistenceError(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (
    message.includes("idx_regex_scripts_script_id")
    || message.includes("UNIQUE constraint failed: regex_scripts.user_id, regex_scripts.script_id")
  ) {
    return "script_id already exists";
  }
  return null;
}

function prepareCharacterBoundImportedScript<T extends Record<string, any>>(input: T, source: string): T {
  const importedScriptId = typeof input.script_id === "string"
    ? normalizeScriptId(input.script_id)
    : "";
  const metadata = isPlainMetadataRecord(input.metadata) ? { ...input.metadata } : {};
  metadata.source = source;
  if (importedScriptId) {
    metadata[IMPORTED_SOURCE_SCRIPT_ID_METADATA_KEY] = importedScriptId;
  }

  // Character-bound regexes are rebound per imported character, so their
  // script_id must not remain globally unique across the whole user.
  return {
    ...input,
    script_id: "",
    metadata,
  };
}

export interface PresetBoundRegexAttribution {
  source?: "lumihub" | "illarin";
  remotePresetId?: string | null;
  /** Legacy LumiHub call-site alias. */
  hubPresetId?: string | null;
  presetVersion?: string | null;
  presetVersionNumber?: number;
  folderName?: string | null;
}

interface RemotePresetRegexAttribution {
  id: string | null;
  version: string | null;
  versionNumber: number | null;
  folderName: string | null;
}

type RemotePresetRegexSource = "lumihub" | "illarin";

function remotePresetMetadataKey(source: RemotePresetRegexSource): string {
  return source === "lumihub" ? "_lumiverse_lumihub_preset" : "_lumiverse_illarin_preset";
}

function remotePresetLabel(source: RemotePresetRegexSource): string {
  return source === "lumihub" ? "LumiHub" : "Illarin";
}

function getRemotePresetRegexAttribution(
  metadata: unknown,
  source: RemotePresetRegexSource,
): RemotePresetRegexAttribution | null {
  if (!isPlainMetadataRecord(metadata)) return null;
  const raw = metadata[remotePresetMetadataKey(source)];
  if (!isPlainMetadataRecord(raw)) return null;
  const id = normalizeOptionalId(raw.id);
  const version = normalizeOptionalId(raw.version);
  const versionNumber = normalizePresetVersionNumber(raw.versionNumber);
  const folderName = normalizeOptionalId(raw.folderName);
  return id || version || versionNumber ? { id, version, versionNumber, folderName } : null;
}

function normalizePresetVersionNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Preset bundles may reuse a publisher-defined script_id that already exists in
 * another local preset. Keep that ID as provenance metadata (the macro resolver
 * already scopes it to the active preset) instead of competing for the user's
 * globally-unique script_id column.
 */
function preparePresetBoundImportedScript<T extends Record<string, any>>(
  input: T,
  attribution?: PresetBoundRegexAttribution,
): T {
  const importedScriptId = typeof input.script_id === "string"
    ? normalizeScriptId(input.script_id)
    : "";
  const metadata = isPlainMetadataRecord(input.metadata) ? { ...input.metadata } : {};
  if (importedScriptId) metadata[IMPORTED_SOURCE_SCRIPT_ID_METADATA_KEY] = importedScriptId;

  if (attribution?.source === "lumihub") {
    metadata._lumiverse_lumihub_preset = {
      id: normalizeOptionalId(attribution.remotePresetId ?? attribution.hubPresetId),
      version: normalizeOptionalId(attribution.presetVersion),
      folderName: normalizeOptionalId(attribution.folderName),
    };
  } else if (attribution?.source === "illarin") {
    delete metadata._lumiverse_lumihub_preset;
    metadata._lumiverse_illarin_preset = {
      id: normalizeOptionalId(attribution.remotePresetId),
      version: normalizeOptionalId(attribution.presetVersion),
      ...(normalizePresetVersionNumber(attribution.presetVersionNumber) === null
        ? {} : { versionNumber: attribution.presetVersionNumber }),
      folderName: normalizeOptionalId(attribution.folderName),
    };
  }

  return {
    ...input,
    script_id: "",
    metadata,
  };
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
    conditions.push(`instr(target, '"' || ? || '"') > 0`);
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
let _stmtRegexByIdGen = -1;

export function getRegexScript(userId: string, id: string): RegexScript | null {
  const gen = require("../db/connection").getDbGeneration() as number;
  if (!_stmtRegexById || _stmtRegexByIdGen !== gen) {
    _stmtRegexById = getDb().query("SELECT * FROM regex_scripts WHERE id = ? AND user_id = ?");
    _stmtRegexByIdGen = gen;
  }
  const row = _stmtRegexById.get(id, userId) as any;
  return row ? rowToRegexScript(row) : null;
}

export function createRegexScript(
  userId: string,
  input: CreateRegexScriptInput,
  context?: RegexMutationContext,
): RegexScript | string {
  return finishRegexMutation(mutateRegexWithDb(getDb(), { action: "createRegexScript", args: [userId, input, context] }), userId);
}

export async function createRegexScriptAsync(
  userId: string,
  input: CreateRegexScriptInput,
  context?: RegexMutationContext,
): Promise<RegexScript | string> {
  const result = await executeDatabaseOperation<RegexMutationResult>({ kind: "regex-mutation", mutation: { action: "createRegexScript", args: [userId, input, context] } });
  return finishRegexMutation(result, userId);
}

export function updateRegexScript(
  userId: string,
  id: string,
  input: UpdateRegexScriptInput,
  context?: RegexMutationContext,
): RegexScript | string | null {
  return finishRegexMutation(mutateRegexWithDb(getDb(), { action: "updateRegexScript", args: [userId, id, input, context] }), userId);
}

export async function updateRegexScriptAsync(
  userId: string,
  id: string,
  input: UpdateRegexScriptInput,
  context?: RegexMutationContext,
): Promise<RegexScript | string | null> {
  const result = await executeDatabaseOperation<RegexMutationResult>({ kind: "regex-mutation", mutation: { action: "updateRegexScript", args: [userId, id, input, context] } });
  return finishRegexMutation(result, userId);
}

export function deleteRegexScript(userId: string, id: string): boolean;
export function deleteRegexScript(userId: string, id: string, context: RegexMutationContext): boolean | string;
export function deleteRegexScript(userId: string, id: string, context?: RegexMutationContext): boolean | string {
  const existing = getRegexScript(userId, id);
  const extensionIdentifier = normalizeOptionalId(context?.extensionIdentifier);
  // A preset-bound row the extension owns is still the extension's row, so the
  // host's preset-delete cascade is what removes it once the preset is gone.
  const ownsRow = !!extensionIdentifier && existing?.owner_extension_identifier === extensionIdentifier;
  if (extensionIdentifier && existing && !ownsRow && !context?.allowUnownedMutation) {
    return EXTENSION_REGEX_OWNERSHIP_ERROR;
  }
  const result = getDb()
    .query("DELETE FROM regex_scripts WHERE id = ? AND user_id = ?")
    .run(id, userId);
  if (result.changes > 0) {
    // Only host-owned rows are tracked by a preset's restore list. An
    // extension-owned row is outside that snapshot, so deleting it must not
    // rewrite (and thereby pin) the preset's saved enablement.
    if (existing?.preset_id && existing.owner_extension_identifier == null) {
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
    .query(`SELECT id, preset_id, owner_extension_identifier FROM regex_scripts WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...ids) as Array<{
      id: string;
      preset_id?: string | null;
      owner_extension_identifier?: string | null;
    }>;
  if (existingRows.length === 0) return [];

  const existingIds = existingRows.map((r) => r.id);
  const existingPlaceholders = existingIds.map(() => "?").join(", ");

  db.transaction(() => {
    db
      .query(`DELETE FROM regex_scripts WHERE user_id = ? AND id IN (${existingPlaceholders})`)
      .run(userId, ...existingIds);
  })();

  for (const row of existingRows) {
    if (row.preset_id && row.owner_extension_identifier == null) {
      setPresetBoundScriptEnabledInRestoreList(userId, row.preset_id, row.id, false);
    }
  }

  for (const id of existingIds) {
    eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id }, userId);
  }

  return existingIds;
}

export function deleteRegexScriptAsync(userId: string, id: string): Promise<boolean>;
export function deleteRegexScriptAsync(userId: string, id: string, context: RegexMutationContext): Promise<boolean | string>;
export async function deleteRegexScriptAsync(userId: string, id: string, context?: RegexMutationContext): Promise<boolean | string> {
  const result = await executeDatabaseOperation<{ deleted: string[]; denied: boolean }>({ kind: "regex-delete", userId, ids: [id], context });
  if (result.denied) return EXTENSION_REGEX_OWNERSHIP_ERROR;
  for (const deletedId of result.deleted) eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id: deletedId }, userId);
  return result.deleted.length > 0;
}

export async function deleteRegexScriptsAsync(userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const result = await executeDatabaseOperation<{ deleted: string[]; denied: boolean }>({ kind: "regex-delete", userId, ids });
  for (const id of result.deleted) eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id }, userId);
  return result.deleted;
}



export function duplicateRegexScript(userId: string, id: string): RegexScript | null {
  return finishRegexMutation(mutateRegexWithDb(getDb(), { action: "duplicateRegexScript", args: [userId, id] }), userId);
}

export async function duplicateRegexScriptAsync(userId: string, id: string): Promise<RegexScript | null> {
  const result = await executeDatabaseOperation<RegexMutationResult>({ kind: "regex-mutation", mutation: { action: "duplicateRegexScript", args: [userId, id] } });
  return finishRegexMutation(result, userId);
}

export function reorderRegexScripts(userId: string, orderedIds: string[]): boolean {
  return finishRegexMutation(mutateRegexWithDb(getDb(), { action: "reorderRegexScripts", args: [userId, orderedIds] }), userId);
}

export async function reorderRegexScriptsAsync(userId: string, orderedIds: string[]): Promise<boolean> {
  const result = await executeDatabaseOperation<RegexMutationResult>({ kind: "regex-mutation", mutation: { action: "reorderRegexScripts", args: [userId, orderedIds] } });
  return finishRegexMutation(result, userId);
}

export function toggleRegexScript(
  userId: string,
  id: string,
  disabled: boolean,
  context?: RegexMutationContext,
): RegexScript | null {
  return finishRegexMutation(mutateRegexWithDb(getDb(), { action: "toggleRegexScript", args: [userId, id, disabled, context] }), userId);
}

export async function toggleRegexScriptAsync(
  userId: string,
  id: string,
  disabled: boolean,
  context?: RegexMutationContext,
): Promise<RegexScript | null> {
  const result = await executeDatabaseOperation<RegexMutationResult>({ kind: "regex-mutation", mutation: { action: "toggleRegexScript", args: [userId, id, disabled, context] } });
  return finishRegexMutation(result, userId);
}

type RegexToggleRow = {
  id: string;
  preset_id?: string | null;
  owner_extension_identifier?: string | null;
  disabled: number;
};

function toggleRegexScriptRows(
  userId: string,
  rows: RegexToggleRow[],
  disabled: boolean,
  activePresetId: string | null,
): { changedIds: string[]; skippedIds: string[] } {
  const changedIds: string[] = [];
  const skippedIds: string[] = [];
  const targets: Array<{ id: string; preset_id: string | null }> = [];

  for (const row of rows) {
    const presetActivationManaged = row.owner_extension_identifier == null;
    if (presetActivationManaged && row.preset_id && row.preset_id !== activePresetId) {
      skippedIds.push(row.id);
      continue;
    }
    if (row.disabled === (disabled ? 1 : 0)) {
      continue;
    }
    targets.push({ id: row.id, preset_id: presetActivationManaged ? row.preset_id ?? null : null });
  }

  if (targets.length === 0) {
    return { changedIds, skippedIds };
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const targetIds = targets.map((t) => t.id);
  const placeholders = targetIds.map(() => "?").join(", ");

  db.transaction(() => {
    db.query(`UPDATE regex_scripts SET disabled = ?, updated_at = ? WHERE id IN (${placeholders}) AND user_id = ?`)
      .run(disabled ? 1 : 0, now, ...targetIds, userId);
  })();

  for (const target of targets) {
    changedIds.push(target.id);
    if (target.preset_id) {
      setPresetBoundScriptEnabledInRestoreList(userId, target.preset_id, target.id, !disabled);
    }
    const updated = getRegexScript(userId, target.id);
    if (updated) {
      eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id: target.id, script: updated }, userId);
    }
  }

  return { changedIds, skippedIds };
}

/**
 * Bulk enable/disable an explicit set of regex scripts.
 *
 * Missing / cross-user IDs are ignored. Scripts bound to a preset other than
 * the active one are returned in skippedIds, matching per-script toggle safety.
 */
export function toggleRegexScriptsByIds(
  userId: string,
  ids: string[],
  disabled: boolean,
  context?: RegexMutationContext,
): { changedIds: string[]; skippedIds: string[] } {
  return finishRegexMutation(mutateRegexWithDb(getDb(), { action: "toggleRegexScriptsByIds", args: [userId, ids, disabled, context] }), userId);
}

export async function toggleRegexScriptsByIdsAsync(
  userId: string,
  ids: string[],
  disabled: boolean,
  context?: RegexMutationContext,
): Promise<{ changedIds: string[]; skippedIds: string[] }> {
  const result = await executeDatabaseOperation<RegexMutationResult>({ kind: "regex-mutation", mutation: { action: "toggleRegexScriptsByIds", args: [userId, ids, disabled, context] } });
  return finishRegexMutation(result, userId);
}

/**
 * Bulk enable/disable every regex script in a folder.
 *
 * Scripts bound to a preset other than the active one are skipped (mirroring
 * per-script toggle behavior). Scripts bound to the active preset have their
 * enablement persisted to the preset restore list.
 */
export function toggleRegexScriptsByFolder(
  userId: string,
  folder: string,
  disabled: boolean,
  context?: RegexMutationContext,
): { changedIds: string[]; skippedIds: string[] } {
  return finishRegexMutation(mutateRegexWithDb(getDb(), { action: "toggleRegexScriptsByFolder", args: [userId, folder, disabled, context] }), userId);
}

export async function toggleRegexScriptsByFolderAsync(
  userId: string,
  folder: string,
  disabled: boolean,
  context?: RegexMutationContext,
): Promise<{ changedIds: string[]; skippedIds: string[] }> {
  const result = await executeDatabaseOperation<RegexMutationResult>({ kind: "regex-mutation", mutation: { action: "toggleRegexScriptsByFolder", args: [userId, folder, disabled, context] } });
  return finishRegexMutation(result, userId);
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
export function getRegexScriptByScriptId(
  userId: string,
  scriptId: string,
  context?: { characterId?: string | null; chatId?: string | null; presetId?: string | null },
): RegexScript | null {
  const normalizedScriptId = normalizeScriptId(scriptId);
  if (!normalizedScriptId) return null;

  const characterId = normalizeOptionalId(context?.characterId);
  const chatId = normalizeOptionalId(context?.chatId);
  const presetId = normalizeOptionalId(context?.presetId);
  const conditions = [
    "user_id = ?",
    `(script_id = ? OR json_extract(metadata, '$.${IMPORTED_SOURCE_SCRIPT_ID_METADATA_KEY}') = ?)`,
  ];
  const params: any[] = [userId, normalizedScriptId, normalizedScriptId];

  const scopeConditions: string[] = ["scope = 'global'"];
  if (characterId) {
    scopeConditions.push("(scope = 'character' AND scope_id = ?)");
    params.push(characterId);
  }
  if (chatId) {
    scopeConditions.push("(scope = 'chat' AND scope_id = ?)");
    params.push(chatId);
  }
  if (characterId || chatId) {
    conditions.push(`(${scopeConditions.join(" OR ")})`);
  }

  const row = getDb()
    .query(
      `SELECT * FROM regex_scripts
       WHERE ${conditions.join(" AND ")}
       ORDER BY
         CASE
           WHEN scope = 'chat' AND scope_id = ? THEN 0
           WHEN scope = 'character' AND scope_id = ? THEN 1
           WHEN scope = 'global' THEN 2
           ELSE 3
         END ASC,
         CASE
           WHEN ? IS NOT NULL AND preset_id = ? THEN 0
           WHEN preset_id IS NULL THEN 1
           ELSE 2
         END ASC,
         CASE WHEN disabled = 0 THEN 0 ELSE 1 END ASC,
         CASE WHEN script_id = ? THEN 0 ELSE 1 END ASC,
         sort_order ASC,
         created_at ASC
       LIMIT 1`
    )
    .get(
      ...params,
      chatId,
      characterId,
      presetId,
      presetId,
      normalizedScriptId,
    ) as any;
  return row ? rowToRegexScript(row) : null;
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

export function validatePromptActivationBinding(userId: string, input: CreateRegexScriptInput): string | null {
  const raw = input.metadata?.prompt_activation;
  const error = validatePromptActivation(raw);
  if (error || raw == null) return error;
  if (typeof input.preset_id !== "string" || !input.preset_id.trim() || input.preset_id.length > 200) return "Prompt activation requires a linked preset";
  const preset = getDb().query("SELECT prompt_order FROM presets WHERE id = ? AND user_id = ?")
    .get(input.preset_id, userId) as { prompt_order: string } | null;
  if (!preset) return "Linked prompt activation preset not found";
  const blocks = JSON.parse(preset.prompt_order) as PromptBlock[];
  try {
    activationPatternForValidation(input.find_regex, blocks);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const ids = new Set(blocks.map((block) => block.id));
  const config = readPromptActivation(input.metadata)!;
  if (config.mappings.some((mapping) => mapping.block_ids.some((id) => !ids.has(id)))) {
    return "Prompt activation targets must belong to the linked preset";
  }
  return null;
}

/** Use the resolved preset's own enabled list, independent of another tab's active preset. */
export function getPresetActivationScripts(
  userId: string,
  presetId: string,
  context: { chatId: string; characterId?: string | null },
): RegexScript[] {
  const scripts = getRegexScriptsByPresetId(userId, presetId);
  if (!scripts.some((script) => readPromptActivation(script.metadata))) return [];
  const saved = readStoredPresetRegexIdsRecord(userId, presetId);
  const enabledIds = new Set(saved.ids);
  const scopeOrder = { global: 0, character: 1, chat: 2 };
  return scripts.filter((script) =>
    (script.owner_extension_identifier == null && saved.exists
      ? enabledIds.has(script.id)
      : !script.disabled)
    && readPromptActivation(script.metadata)
    && (script.scope === "global"
      || (script.scope === "chat" && script.scope_id === context.chatId)
      || (script.scope === "character" && script.scope_id === context.characterId)),
  ).sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope] || a.sort_order - b.sort_order || a.created_at - b.created_at)
    .map((script) => ({ ...script, disabled: false }));
}

/**
 * Active scripts for a chat context, ordered global → character → chat then
 * sort_order, created_at. matchConditions/matchParams are the caller's column
 * filter; bind order is userId, matchParams, scope ids.
 */
function getScopedScripts(
  userId: string,
  opts: { characterId?: string | null; chatId?: string | null },
  matchConditions: string[],
  matchParams: any[],
): RegexScript[] {
  const conditions = ["user_id = ?", "disabled = 0", ...matchConditions];
  const params: any[] = [userId, ...matchParams];

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

  const rows = getDb()
    .query(
      `SELECT * FROM regex_scripts WHERE ${conditions.join(" AND ")}
       ORDER BY
         CASE scope WHEN 'global' THEN 0 WHEN 'character' THEN 1 WHEN 'chat' THEN 2 END ASC,
         sort_order ASC, created_at ASC`
    )
    .all(...params) as any[];

  return rows.map(rowToRegexScript);
}

/** Active scripts whose `target` array contains opts.target. */
export function getActiveScripts(
  userId: string,
  opts: { characterId?: string; chatId?: string; target: RegexTarget }
): RegexScript[] {
  // target stored as a JSON array; instr matches the quoted needle.
  return getScopedScripts(userId, opts, [`instr(target, '"' || ? || '"') > 0`], [opts.target]);
}

/** Resolve a message's preset without changing the user's active preset or its saved enabled list. */
export function getActiveScriptsForPreset(userId: string, opts: { presetId: string; characterId?: string; chatId?: string; target: RegexTarget }): RegexScript[] {
  const saved = readStoredPresetRegexIdsRecord(userId, opts.presetId);
  const params: any[] = [userId, opts.target, opts.presetId];
  const enabled = saved.exists
    ? saved.ids.length ? `id IN (${saved.ids.map(() => "?").join(",")})` : "0"
    : "disabled = 0";
  if (saved.exists) params.push(...saved.ids);
  const scopes = ["scope = 'global'"];
  if (opts.characterId) { scopes.push("(scope = 'character' AND scope_id = ?)"); params.push(opts.characterId); }
  if (opts.chatId) { scopes.push("(scope = 'chat' AND scope_id = ?)"); params.push(opts.chatId); }
  // Filter before parsing definitions; inactive versions and other presets never enter the chain.
  const rows = getDb().query(`SELECT * FROM regex_scripts
    WHERE user_id = ? AND instr(target, '"' || ? || '"') > 0
      AND ((disabled = 0 AND (preset_id IS NULL OR owner_extension_identifier IS NOT NULL))
        OR (preset_id = ? AND owner_extension_identifier IS NULL AND ${enabled}))
      AND (${scopes.join(" OR ")})
    ORDER BY CASE scope WHEN 'global' THEN 0 WHEN 'character' THEN 1 WHEN 'chat' THEN 2 END,
      sort_order, created_at`).all(...params) as any[];
  return rows.map(row => ({ ...rowToRegexScript(row), disabled: false }))
    .filter(script => opts.target !== "display" || script.metadata?.regex_evidence?.quarantined !== true);
}

/**
 * Active scripts carrying the "memory" placement, for stripping content at
 * ingestion. Filters by placement, not target — a memory script applies
 * whenever memory is written, regardless of prompt/response/display target.
 */
export function getActiveMemoryScripts(
  userId: string,
  opts: { characterId?: string | null; chatId?: string | null }
): RegexScript[] {
  // placement stored as a JSON array; instr matches the quoted needle.
  return getScopedScripts(userId, opts, [`instr(placement, '"' || ? || '"') > 0`], ["memory"]);
}

/**
 * Apply "memory"-placement scripts to text before it's persisted/embedded.
 * No macro env at ingestion, so find/replace macros aren't resolved — memory
 * scripts must use literal patterns.
 */
export async function applyMemoryIngestionRegex(
  userId: string,
  content: string,
  opts: { characterId?: string | null; chatId?: string | null },
): Promise<string> {
  if (!content) return content;
  const scripts = getActiveMemoryScripts(userId, opts);
  if (scripts.length === 0) return content;
  return applyRegexScripts(
    content,
    scripts,
    "memory",
    undefined,
    undefined,
    undefined,
    { source: "prompt_backend" },
  );
}

/**
 * Get scripts that target "response" and have run_on_edit enabled —
 * used when a message is edited to apply regex transformations.
 */
export function getRunOnEditScripts(
  userId: string,
  opts: { characterId?: string; chatId?: string }
): RegexScript[] {
  return getScopedScripts(
    userId,
    opts,
    ["run_on_edit = 1", `instr(target, '"response"') > 0`],
    [],
  );
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
  namedGroups?: Record<string, string | undefined>,
): string {
  return substituteRegexCapturesCore(template, fullMatch, groups, offset, input, namedGroups);
}

/**
 * Rebuild a string by splicing replacements into the original at match positions.
 */
function rebuildFromMatches(
  content: string,
  matches: { index: number; matchLength: number }[],
  replacements: string[],
): string {
  let out = "";
  let lastIdx = 0;
  for (let i = 0; i < matches.length; i++) {
    out += content.slice(lastIdx, matches[i].index);
    out += replacements[i];
    lastIdx = matches[i].index + matches[i].matchLength;
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

function macroOptionsForRegexScript(script: RegexScript): EvaluateOptions | undefined {
  if (script.owner_extension_identifier) {
    return { sourceOwner: { extensionIdentifier: script.owner_extension_identifier } };
  }
  if (script.preset_id && script.owner_extension_identifier == null) {
    return { sourceOwner: "host", sourceHint: "regex_script:preset" };
  }
  return undefined;
}

async function resolveFindMacros(
  findRegex: string,
  mode: RegexScript["substitute_macros"],
  macroEnv: MacroEnv,
  outFingerprint?: { touchedVars: Set<string>; cacheable: boolean },
  macroOptions?: EvaluateOptions,
): Promise<string> {
  if (mode === "none") return findRegex;
  const result = await evaluate(findRegex, macroEnv, registry, macroOptions);
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
  macroOptions?: EvaluateOptions,
): Promise<string> {
  if (mode === "none" || mode === "find") return replaceString;

  const result = await evaluate(replaceString, macroEnv, registry, macroOptions);
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
 * When `macroEnv` is provided, every enabled mode resolves `find_regex`.
 * The "find" mode leaves `replace_string` unchanged.
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

  // Keep the assembly's pre-render snapshot through response processing. Other passes
  // load owned, persisted inputs once per preset, never mutable macro variables.
  const activationSnapshots: Map<string, ActivationInputSnapshot> = macroEnv?.extra.activationInputSnapshots ?? new Map();
  if (macroEnv) macroEnv.extra.activationInputSnapshots = activationSnapshots;

  for (const script of scripts) {
    // Most callers load active scripts from the database, but keep the executor
    // safe for request-supplied lists and other snapshots too.
    if (script.disabled) continue;

    // Check placement match
    if (!script.placement.includes(placement)) continue;

    // Check depth bounds
    if (depth !== undefined) {
      if (script.min_depth !== null && depth < script.min_depth) continue;
      if (script.max_depth !== null && depth > script.max_depth) continue;
    }

    const startedAt = Date.now();
    try {
      const macroOptions = macroOptionsForRegexScript(script);
      let findRegex = script.find_regex;
      const preResolvedFind = resolvedTemplates?.resolvedFindPatterns?.get(script.id);
      if (script.preset_id && readPromptActivation(script.metadata) && findRegex.includes("{{")) {
        if (options?.outFingerprint) options.outFingerprint.cacheable = false;
        let snapshot = activationSnapshots.get(script.preset_id);
        if (!snapshot) {
          const { loadActivationInputSnapshot } = await import("./regex-activation-inputs.service");
          snapshot = loadActivationInputSnapshot(script.user_id, script.preset_id, {
            chat_id: macroEnv?.chat?.id || undefined,
            character_id: macroEnv?.extra.characterId || undefined,
            ...(macroEnv?.extra.activationPreviewContext ?? {}),
          }, scripts.filter((candidate) => candidate.preset_id === script.preset_id && readPromptActivation(candidate.metadata)).map((candidate) => candidate.find_regex));
          activationSnapshots.set(script.preset_id, snapshot);
        }
        findRegex = resolveActivationFindPattern(findRegex, snapshot);
      } else if (preResolvedFind !== undefined) {
        findRegex = preResolvedFind;
      } else if (macroEnv && script.substitute_macros !== "none") {
        findRegex = await resolveFindMacros(
          findRegex,
          script.substitute_macros,
          macroEnv,
          options?.outFingerprint,
          macroOptions,
        );
      }

      const regexActions = readRegexActions(script);
      if (regexActions.size > 0) {
        if (
          options?.outFingerprint
          && regexActions.has("repeat_back")
        ) {
          options.outFingerprint.cacheable = false;
        }
        const applied = await applyRegexActions(
          result,
          findRegex,
          script.flags,
          script.replace_string,
          regexActions,
          options,
          readRepeatPosition(script),
          readRepeatRawMatch(script),
          (match, input) => resolveRepeatedMatchReplacement(
            script,
            match,
            input,
            macroEnv,
            resolvedTemplates,
            options,
          ),
        );
        if (applied.handled) {
          result = applyRegexTrimStrings(applied.content, script.trim_strings);
          continue;
        }
      }

      const actionCapture = script.actions.length > 0 && options?.source === "display_backend"
        ? buildRegexActionCaptureTemplate(script.actions)
        : null;
      const actionMatches = actionCapture
        ? await regexCaptureReplacementsSandboxed(
            findRegex,
            script.flags,
            result,
            actionCapture.template,
            REGEX_SCRIPT_TIMEOUT_MS,
          )
        : [];

      if (macroEnv && script.substitute_macros === "raw") {
        // "raw" mode: substitute capture groups into the replacement template
        // BEFORE macro resolution so $1, $2, etc. are available inside macros.
        // Capture interpolation runs in the regex sandbox so a pathological
        // pattern can't freeze the event loop and large capture arrays never
        // need to cross the worker boundary.
        const matches: SandboxCaptureReplacement[] = await regexCaptureReplacementsSandboxed(
          findRegex,
          script.flags,
          result,
          script.replace_string,
          REGEX_SCRIPT_TIMEOUT_MS,
        );
        if (matches.length > 0) {
          const replacements = await Promise.all(
            matches.map(async ({ replacement }) => {
              const evalResult = await evaluate(replacement, macroEnv, registry, macroOptions);
              foldFingerprint(options?.outFingerprint, evalResult);
              return evalResult.text;
            }),
          );
          result = rebuildFromMatches(
            result,
            matches,
            actionCapture
              ? decorateRegexActionReplacements(replacements, actionMatches, actionCapture.unpack, script.id)
              : replacements,
          );
        }
      } else if (macroEnv && script.substitute_macros === "after") {
        const matches = await regexCaptureReplacementsSandboxed(
          findRegex,
          script.flags,
          result,
          script.replace_string,
          REGEX_SCRIPT_TIMEOUT_MS,
        );
        const replacements = matches.map((match) => match.replacement);
        const substituted = rebuildFromMatches(
          result,
          matches,
          actionCapture
            ? decorateRegexActionReplacements(replacements, actionMatches, actionCapture.unpack, script.id)
            : replacements,
        );
        const evalResult = await evaluate(substituted, macroEnv, registry, macroOptions);
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
        } else if (
          macroEnv
          && script.substitute_macros !== "none"
          && script.substitute_macros !== "find"
        ) {
          replaceString = await resolveReplacementMacros(
            replaceString,
            script.substitute_macros,
            macroEnv,
            options?.outFingerprint,
            macroOptions,
          );
        }
        if (actionCapture) {
          const matches = await regexCaptureReplacementsSandboxed(
            findRegex,
            script.flags,
            result,
            replaceString,
            REGEX_SCRIPT_TIMEOUT_MS,
          );
          result = rebuildFromMatches(
            result,
            matches,
            decorateRegexActionReplacements(
              matches.map((match) => match.replacement),
              actionMatches,
              actionCapture.unpack,
              script.id,
            ),
          );
        } else {
          result = await regexReplaceSandboxed(
            findRegex,
            script.flags,
            result,
            replaceString,
            REGEX_SCRIPT_TIMEOUT_MS,
          );
        }
      }

      result = applyRegexTrimStrings(result, script.trim_strings);

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
      } else {
        const existingPerformance = getRegexPerformanceMetadata(script);
        const source = options?.source ?? "display_backend";
        if (
          existingPerformance &&
          existingPerformance.version === script.updated_at &&
          performanceSourcesMatch(existingPerformance.source, source) &&
          elapsedMs < existingPerformance.threshold_ms
        ) {
          reportRegexScriptPerformance(script.user_id, script.id, {
            elapsedMs,
            thresholdMs: existingPerformance.threshold_ms,
            source,
          });
        }
      }
    } catch (e) {
      // Pool teardown is expected process-shutdown cancellation, not a broken
      // user script. Stop this pass quietly and do not try to spawn more work.
      if (e instanceof RegexSandboxShutdownError) return result;
      if (options?.outFingerprint) options.outFingerprint.cacheable = false;
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

function readRegexActions(script: RegexScript): ReadonlySet<RegexMatchAction> {
  const raw = script.metadata?.match_actions;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter(
    (action): action is RegexMatchAction =>
      action === "move_top"
      || action === "move_bottom"
      || action === "repeat_back",
  ));
}

function readRepeatPosition(script: RegexScript): string | undefined {
  const value = script.metadata?.repeat_position;
  return typeof value === "string" ? value : undefined;
}

function readRepeatRawMatch(script: RegexScript): boolean {
  return script.metadata?.repeat_raw_match === true;
}

async function resolveRepeatedMatchReplacement(
  script: RegexScript,
  match: SandboxMatch,
  input: string,
  macroEnv: MacroEnv | undefined,
  resolvedTemplates: {
    resolvedFindPatterns?: Map<string, string>;
    resolvedReplacements?: Map<string, string>;
  } | undefined,
  options: ApplyRegexScriptOptions | undefined,
): Promise<string> {
  let replacement = script.replace_string;
  const macroOptions = macroOptionsForRegexScript(script);

  if (script.substitute_macros === "raw" || script.substitute_macros === "after") {
    replacement = substituteRegexCapturesCore(
      replacement,
      match.fullMatch,
      match.groups,
      match.index,
      input,
      match.namedGroups,
    );
    if (macroEnv) {
      const evaluated = await evaluate(replacement, macroEnv, registry, macroOptions);
      foldFingerprint(options?.outFingerprint, evaluated);
      replacement = evaluated.text;
    }
  } else {
    const preResolved = resolvedTemplates?.resolvedReplacements?.get(script.id);
    if (preResolved !== undefined) {
      replacement = script.substitute_macros === "escaped"
        ? preResolved.replace(/\$/g, "$$$$")
        : preResolved;
    } else if (
      macroEnv
      && script.substitute_macros !== "none"
      && script.substitute_macros !== "find"
    ) {
      replacement = await resolveReplacementMacros(
        replacement,
        script.substitute_macros,
        macroEnv,
        options?.outFingerprint,
        macroOptions,
      );
    }
    replacement = substituteRegexCapturesCore(
      replacement,
      match.fullMatch,
      match.groups,
      match.index,
      input,
      match.namedGroups,
    );
  }

  if (script.actions.length > 0 && options?.source === "display_backend") {
    const capture = buildRegexActionCaptureTemplate(script.actions);
    const actionReplacement = substituteRegexCapturesCore(
      capture.template,
      match.fullMatch,
      match.groups,
      match.index,
      input,
      match.namedGroups,
    );
    return decorateRegexActionReplacements(
      [replacement],
      [{
        index: match.index,
        matchLength: match.fullMatch.length,
        replacement: actionReplacement,
      }],
      capture.unpack,
      script.id,
    )[0]!;
  }

  return replacement;
}

async function applyRegexActions(
  content: string,
  pattern: string,
  flags: string,
  replacement: string,
  actions: ReadonlySet<RegexMatchAction>,
  options: ApplyRegexScriptOptions | undefined,
  repeatPosition?: string,
  repeatRawMatch = false,
  resolveRepeatedMatch?: (match: SandboxMatch, input: string) => Promise<string>,
): Promise<{ handled: boolean; content: string }> {
  const movesTop = actions.has("move_top");
  const movesBottom = actions.has("move_bottom");
  const effectiveFlags = movesTop || movesBottom
    ? flags.replaceAll("g", "") || "u"
    : flags;
  const matches = await regexCollectSandboxed(
    pattern,
    effectiveFlags,
    content,
    REGEX_SCRIPT_TIMEOUT_MS,
  );
  if (matches.length === 0) {
    if (
      !actions.has("repeat_back")
      || options?.previousContent === undefined
    ) return { handled: true, content };
    const prior = await regexCollectSandboxed(
      pattern,
      effectiveFlags,
      options.previousContent,
      REGEX_SCRIPT_TIMEOUT_MS,
    );
    if (prior.length === 0) return { handled: true, content };
    const piece = repeatRawMatch || !resolveRepeatedMatch
      ? prior[0]!.fullMatch
      : await resolveRepeatedMatch(prior[0]!, options.previousContent);
    const position = repeatPosition ?? replacement.split(" ", 2)[1];
    if (!position || position === "end") return { handled: true, content: content + piece };
    if (position === "start") return { handled: true, content: piece + content };
    if (position === "end_nl") return { handled: true, content: `${content}\n${piece}` };
    if (position === "start_nl") return { handled: true, content: `${piece}\n${content}` };
    return { handled: true, content };
  }

  if (movesTop || movesBottom) {
    const match = matches[0]!;
    const moved = substituteRegexCapturesCore(
      replacement,
      match.fullMatch,
      match.groups,
      match.index,
      content,
      match.namedGroups,
    );
    const remainder = rebuildFromMatches(
      content,
      [{ index: match.index, matchLength: match.fullMatch.length }],
      [""],
    );
    return {
      handled: true,
      content: movesTop
        ? `${moved}\n${remainder}`
        : `${remainder}\n${moved}`,
    };
  }

  // A repeat rule is an ordinary replacement when the current text matches.
  return { handled: false, content };
}

// ── Test ─────────────────────────────────────────────────────────────────────

const TEST_REGEX_TIMEOUT_MS = 1_000;

export async function testRegex(
  findRegex: string,
  replaceString: string,
  flags: string,
  content: string,
  matchActions: readonly RegexMatchAction[] = [],
): Promise<{ result: string; matches: number; error?: string }> {
  try {
    const out = await regexTestSandboxed(
      findRegex,
      flags,
      content,
      replaceString,
      TEST_REGEX_TIMEOUT_MS,
    );
    if (matchActions.length > 0) {
      const applied = await applyRegexActions(
        content,
        findRegex,
        flags,
        replaceString,
        new Set(matchActions),
        undefined,
      );
      return { ...out, result: applied.content };
    }
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
      normalizedRows = normalizedRows.map((s) => s.owner_extension_identifier == null
        ? { ...s, disabled: !enabledIds.has(s.id) }
        : s);
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

export interface RetireLumiHubPresetRegexOptions {
  presetId: string;
  hubPresetId: string;
  previousHubPresetId?: string | null;
  previousVersion?: string | null;
  incomingVersion?: string | null;
  presetName: string;
  preserveIds?: string[];
}

export interface RetireLumiHubPresetRegexResult {
  archivedIds: string[];
  replacedIds: string[];
}

interface RetireRemotePresetRegexOptions {
  source: RemotePresetRegexSource;
  presetId: string;
  remotePresetId: string;
  previousRemotePresetId?: string | null;
  previousVersion?: string | null;
  incomingVersion?: string | null;
  previousVersionNumber?: number | null;
  incomingVersionNumber?: number;
  presetName: string;
  preserveIds?: string[];
}

function versionLabel(version: string | null): string {
  if (!version) return "previous";
  return /^v/i.test(version) ? version : `v${version}`;
}

/** Recover the author-provided source folder for older rows that predate explicit storage. */
function getRemotePresetSourceFolder(
  script: Pick<RegexScript, "folder">,
  attribution: RemotePresetRegexAttribution | null,
  fallback: string,
  version: string | null,
  source: RemotePresetRegexSource,
): string {
  const stored = normalizeOptionalId(attribution?.folderName);
  if (stored) return stored;

  const folder = normalizeOptionalId(script.folder);
  if (!folder) return fallback;
  const label = remotePresetLabel(source);
  const currentMatch = folder.match(new RegExp(`^(.*?) · ${label}(?: \\(\\d+\\))?$`));
  if (currentMatch?.[1]?.trim()) return currentMatch[1].trim();
  const historicalSuffix = ` · ${versionLabel(version)}`;
  if (folder.endsWith(historicalSuffix)) return folder.slice(0, -historicalSuffix.length).trim() || fallback;
  return folder;
}

function chooseAvailableRegexFolder(
  userId: string,
  desiredFolder: string,
  allowedOccupantIds: Set<string>,
  reserveRemoteNamespace = false,
  remoteLabel = "LumiHub",
): string {
  const db = getDb();
  const base = desiredFolder.trim() || `${remoteLabel} preset`;
  const candidates = reserveRemoteNamespace
    ? [`${base} · ${remoteLabel}`]
    : [base, `${base} · ${remoteLabel}`];

  for (let suffix = 2; suffix < 1000; suffix++) {
    candidates.push(`${base} · ${remoteLabel} (${suffix})`);
  }

  for (const candidate of candidates) {
    const occupants = db
      .query("SELECT id FROM regex_scripts WHERE user_id = ? AND folder = ?")
      .all(userId, candidate) as Array<{ id: string }>;
    if (occupants.every((row) => allowedOccupantIds.has(row.id))) return candidate;
  }

  return `${base} · ${remoteLabel} (${Date.now()})`;
}

/**
 * Preserve historical remote-preset regex payloads while making an update safe:
 * older versions are disabled and moved into version-specific folders, while a
 * repeat install of the incoming version is replaced instead of duplicated.
 *
 * Selection is based exclusively on preset ownership plus source attribution.
 * Folder names are never used to decide which rows to mutate.
 */
function retireRemotePresetRegexScriptsForUpdate(
  userId: string,
  options: RetireRemotePresetRegexOptions,
): RetireLumiHubPresetRegexResult {
  const remotePresetId = normalizeOptionalId(options.remotePresetId);
  const previousRemotePresetId = normalizeOptionalId(options.previousRemotePresetId);
  const previousVersion = normalizeOptionalId(options.previousVersion);
  const incomingVersion = normalizeOptionalId(options.incomingVersion);
  const incomingVersionNumber = options.source === "illarin"
    ? normalizePresetVersionNumber(options.incomingVersionNumber) : null;
  if (!remotePresetId) return { archivedIds: [], replacedIds: [] };

  const acceptedRemoteIds = new Set([remotePresetId, previousRemotePresetId].filter((id): id is string => !!id));
  const preserveIds = new Set(options.preserveIds ?? []);
  const rows = getRegexScriptsByPresetId(userId, options.presetId);
  const matching = rows.flatMap((script) => {
    if (preserveIds.has(script.id)) return [];
    if (script.owner_extension_identifier != null) return [];
    const attribution = getRemotePresetRegexAttribution(script.metadata, options.source);
    if (attribution?.id && !acceptedRemoteIds.has(attribution.id)) return [];

    // Rows from installations predating explicit per-regex attribution are
    // still attributable through their preset_id, but only when the containing
    // preset was already a tracked installation from the same remote source.
    if (!attribution?.id && !previousRemotePresetId) return [];
    const version = attribution?.version ?? previousVersion;
    const versionNumber = attribution
      ? attribution.versionNumber : normalizePresetVersionNumber(options.previousVersionNumber);
    return [{
      script,
      version,
      versionNumber,
      folderName: getRemotePresetSourceFolder(script, attribution, options.presetName, version, options.source),
    }];
  });

  const sameRelease = (entry: typeof matching[number]) => incomingVersionNumber === null
    ? entry.version === incomingVersion
    : entry.versionNumber === incomingVersionNumber;
  const replaced = matching.filter(sameRelease);
  const archived = matching.filter((entry) => !sameRelease(entry));
  const replacedIds = replaced.map(({ script }) => script.id);
  const archivedIds = archived.map(({ script }) => script.id);
  const replaceIdSet = new Set(replacedIds);
  const archiveGroups = new Map<string, { version: string | null; folderName: string; ids: Set<string> }>();
  const archiveKey = (version: string | null, folderName: string) => `${version ?? ""}\u0000${folderName}`;
  for (const { script, version, versionNumber, folderName } of archived) {
    const historyVersion = versionNumber === null ? version : String(versionNumber);
    const key = archiveKey(historyVersion, folderName);
    const group = archiveGroups.get(key) ?? { version: historyVersion, folderName, ids: new Set<string>() };
    group.ids.add(script.id);
    archiveGroups.set(key, group);
  }

  const foldersByArchiveKey = new Map<string, string>();
  for (const [key, group] of archiveGroups) {
    const allowedOccupants = new Set([...group.ids, ...replaceIdSet]);
    const desired = `${group.folderName} · ${versionLabel(group.version)}`;
    foldersByArchiveKey.set(key, chooseAvailableRegexFolder(
      userId,
      desired,
      allowedOccupants,
      false,
      remotePresetLabel(options.source),
    ));
  }

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    const deleteRow = db.query("DELETE FROM regex_scripts WHERE id = ? AND user_id = ?");
    for (const { script } of replaced) deleteRow.run(script.id, userId);

    const updateRow = db.query(
      "UPDATE regex_scripts SET disabled = 1, folder = ?, metadata = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    );
    for (const { script, version, versionNumber, folderName } of archived) {
      const metadata = isPlainMetadataRecord(script.metadata) ? { ...script.metadata } : {};
      metadata[remotePresetMetadataKey(options.source)] = {
        id: remotePresetId, version, folderName,
        ...(versionNumber === null ? {} : { versionNumber }),
      };
      updateRow.run(
        foldersByArchiveKey.get(archiveKey(versionNumber === null ? version : String(versionNumber), folderName))!,
        JSON.stringify(metadata),
        now,
        script.id,
        userId,
      );
    }

    // Switching back to this preset must never revive a historical version.
    writeStoredPresetRegexIdsWithDb(db, userId, options.presetId, []);
  })();

  for (const id of replacedIds) eventBus.emit(EventType.REGEX_SCRIPT_DELETED, { id }, userId);
  for (const id of archivedIds) emitRegexChanged(userId, id);
  return { archivedIds, replacedIds };
}

export function retireLumiHubPresetRegexScriptsForUpdate(
  userId: string,
  options: RetireLumiHubPresetRegexOptions,
): RetireLumiHubPresetRegexResult {
  return retireRemotePresetRegexScriptsForUpdate(userId, {
    source: "lumihub",
    presetId: options.presetId,
    remotePresetId: options.hubPresetId,
    previousRemotePresetId: options.previousHubPresetId,
    previousVersion: options.previousVersion,
    incomingVersion: options.incomingVersion,
    presetName: options.presetName,
    preserveIds: options.preserveIds,
  });
}

/** Pick a current-version folder without merging into an unrelated local folder. */
function resolveRemotePresetRegexInstallFolder(
  source: RemotePresetRegexSource,
  userId: string,
  presetId: string,
  remotePresetId: string,
  presetName: string,
  sourceFolder = presetName,
): string {
  const normalizedRemoteId = normalizeOptionalId(remotePresetId);
  const normalizedSourceFolder = normalizeOptionalId(sourceFolder) ?? presetName;
  const allowedIds = new Set(
    getRegexScriptsByPresetId(userId, presetId)
      .filter((script) => {
        const attribution = getRemotePresetRegexAttribution(script.metadata, source);
        return attribution?.id === normalizedRemoteId
          && getRemotePresetSourceFolder(script, attribution, presetName, attribution.version, source) === normalizedSourceFolder;
      })
      .map((script) => script.id),
  );
  // The unqualified preset name is user-owned namespace. Even if an older
  // remote installation is the only current occupant, do not reuse it: a
  // user can later add local regexes to that folder and the UI groups solely
  // by folder name. The current remote payload always gets a reserved folder.
  return chooseAvailableRegexFolder(userId, normalizedSourceFolder, allowedIds, true, remotePresetLabel(source));
}

export function resolveLumiHubPresetRegexInstallFolder(
  userId: string,
  presetId: string,
  hubPresetId: string,
  presetName: string,
  sourceFolder = presetName,
): string {
  return resolveRemotePresetRegexInstallFolder(
    "lumihub", userId, presetId, hubPresetId, presetName, sourceFolder,
  );
}

export function resolveIllarinPresetRegexInstallFolder(
  userId: string,
  presetId: string,
  assetId: string,
  presetName: string,
  sourceFolder = presetName,
): string {
  return resolveRemotePresetRegexInstallFolder(
    "illarin", userId, presetId, assetId, presetName, sourceFolder,
  );
}

export interface InstallLumiHubPresetRegexOptions {
  presetId: string;
  presetName: string;
  hubPresetId: string;
  presetVersion?: string | null;
  scripts: any[];
  previous?: {
    hubPresetId?: string | null;
    version?: string | null;
    presetName?: string | null;
  } | null;
}

export interface InstallIllarinPresetRegexOptions {
  presetId: string;
  presetName: string;
  assetId: string;
  presetVersion?: string | null;
  presetVersionNumber?: number;
  scripts: any[];
  previous?: {
    assetId?: string | null;
    version?: string | null;
    versionNumber?: number | null;
    presetName?: string | null;
  } | null;
}

interface InstallRemotePresetRegexOptions {
  source: RemotePresetRegexSource;
  presetId: string;
  presetName: string;
  remotePresetId: string;
  presetVersion?: string | null;
  presetVersionNumber?: number;
  scripts: any[];
  previous?: {
    remotePresetId?: string | null;
    version?: string | null;
    versionNumber?: number | null;
    presetName?: string | null;
  } | null;
}

/**
 * Stage a remote preset's regex payload before retiring the previous version. A partial
 * import is removed and the old restore-list is reinstated, leaving the prior
 * working set untouched.
 */
function installRemotePresetRegexScripts(
  userId: string,
  options: InstallRemotePresetRegexOptions,
): { imported: number; archived: number; replaced: number; folder: string | null } {
  const previousRestore = readStoredPresetRegexIdsRecord(userId, options.presetId);
  const beforeIds = new Set(getRegexScriptsByPresetId(userId, options.presetId).map((script) => script.id));
  let newIds: string[] = [];
  let folder: string | null = null;

  try {
    if (options.scripts.length > 0) {
      const imported = importPresetBoundRegexScripts(
        userId,
        options.presetId,
        options.presetName,
        options.scripts,
        {
          source: options.source,
          remotePresetId: options.remotePresetId,
          presetVersion: options.presetVersion,
          presetVersionNumber: options.presetVersionNumber,
        },
      );
      newIds = getRegexScriptsByPresetId(userId, options.presetId)
        .filter((script) => !beforeIds.has(script.id))
        .map((script) => script.id);
      folder = newIds.length > 0 ? getRegexScript(userId, newIds[0])?.folder ?? null : null;
      if (imported.skipped > 0 || imported.imported !== options.scripts.length) {
        throw new Error(`${remotePresetLabel(options.source)} preset regex import was incomplete (${imported.imported}/${options.scripts.length})`);
      }
    }

    const nextRestore = options.scripts.length > 0
      ? readStoredPresetRegexIdsRecord(userId, options.presetId).ids
      : [];
    const retired = options.previous
      ? retireRemotePresetRegexScriptsForUpdate(userId, {
          source: options.source,
          presetId: options.presetId,
          remotePresetId: options.remotePresetId,
          previousRemotePresetId: options.previous.remotePresetId,
          previousVersion: options.previous.version,
          incomingVersion: options.presetVersion,
          previousVersionNumber: options.previous.versionNumber,
          incomingVersionNumber: options.presetVersionNumber,
          presetName: normalizeOptionalId(options.previous.presetName) ?? options.presetName,
          preserveIds: newIds,
        })
      : { archivedIds: [], replacedIds: [] };

    // Retirement clears the old restore-list. Reapply only the staged version's
    // author-enabled IDs, including an intentionally empty list.
    writeStoredPresetRegexIdsWithDb(getDb(), userId, options.presetId, nextRestore);
    return {
      imported: newIds.length,
      archived: retired.archivedIds.length,
      replaced: retired.replacedIds.length,
      folder,
    };
  } catch (error) {
    newIds = getRegexScriptsByPresetId(userId, options.presetId)
      .filter((script) => !beforeIds.has(script.id))
      .map((script) => script.id);
    if (newIds.length > 0) deleteRegexScripts(userId, newIds);
    if (previousRestore.exists) {
      writeStoredPresetRegexIdsWithDb(getDb(), userId, options.presetId, previousRestore.ids);
    } else {
      deleteStoredPresetRegexIds(userId, options.presetId);
    }
    throw error;
  }
}

export function installLumiHubPresetRegexScripts(
  userId: string,
  options: InstallLumiHubPresetRegexOptions,
): { imported: number; archived: number; replaced: number; folder: string | null } {
  return installRemotePresetRegexScripts(userId, {
    source: "lumihub",
    presetId: options.presetId,
    presetName: options.presetName,
    remotePresetId: options.hubPresetId,
    presetVersion: options.presetVersion,
    scripts: options.scripts,
    previous: options.previous ? {
      remotePresetId: options.previous.hubPresetId,
      version: options.previous.version,
      presetName: options.previous.presetName,
    } : null,
  });
}

export function installIllarinPresetRegexScripts(
  userId: string,
  options: InstallIllarinPresetRegexOptions,
): { imported: number; archived: number; replaced: number; folder: string | null } {
  return installRemotePresetRegexScripts(userId, {
    source: "illarin",
    presetId: options.presetId,
    presetName: options.presetName,
    remotePresetId: options.assetId,
    presetVersion: options.presetVersion,
    presetVersionNumber: options.presetVersionNumber,
    scripts: options.scripts,
    previous: options.previous ? {
      remotePresetId: options.previous.assetId,
      version: options.previous.version,
      versionNumber: options.previous.versionNumber,
      presetName: options.previous.presetName,
    } : null,
  });
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
          "SELECT id FROM regex_scripts WHERE user_id = ? AND preset_id = ? AND disabled = 0 AND owner_extension_identifier IS NULL ORDER BY sort_order ASC, created_at ASC",
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
  const match = findRegex.match(/^\/(.+)\/([dgimsuvy]*)$/s);
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

function convertStTarget(item: any): RegexTarget[] {
  const targets: RegexTarget[] = [];
  if (item.markdownOnly) targets.push("display");
  if (item.promptOnly) targets.push("prompt");
  if (targets.length === 0) targets.push("response");
  return targets;
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

    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`Script ${i}: invalid script`);
      skipped++;
      continue;
    }
    // Never mutate the parsed import payload supplied by the caller.
    item = { ...item };

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
        actions: item.actions ?? [],
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

    // A top-level preset binding is authoritative. Imported scripts can carry
    // their source preset_id, which must not survive an overwrite/re-import.
    if (presetIdOverride) {
      item.preset_id = presetIdOverride;
    }

    // Stamp character ownership if provided
    if (characterIdOverride && !item.character_id) {
      item.character_id = characterIdOverride;
    }

    const result = createRegexScript(userId, item, context);
    if (typeof result === "string") {
      // A stable script_id identifies the row an import should overwrite. Keep
      // ownership fields off ordinary JSON updates so replacing a script does
      // not silently detach it from its preset/pack/character. A preset import's
      // explicit top-level binding is the one exception: it intentionally moves
      // the existing regex to the imported preset.
      const existing = result === "script_id already exists" && item.script_id
        ? getRegexScriptByScriptId(userId, item.script_id)
        : null;
      if (!existing) {
        errors.push(`Script "${item.name}": ${result}`);
        skipped++;
        continue;
      }

      const {
        id: _id,
        user_id: _userId,
        pack_id: _packId,
        preset_id: _importedPresetId,
        character_id: _characterId,
        created_at: _createdAt,
        updated_at: _updatedAt,
        ...updates
      } = item;
      if (presetIdOverride) updates.preset_id = presetIdOverride;

      const overwritten = updateRegexScript(userId, existing.id, updates, context);
      if (!overwritten || typeof overwritten === "string") {
        errors.push(`Script "${item.name}": ${overwritten || "overwrite failed"}`);
        skipped++;
      } else {
        imported++;
      }
    } else {
      imported++;
    }
  }

  return { imported, skipped, errors };
}

/**
 * Import a character card's bound regex scripts into live, character-scoped rows
 * so they apply for that character immediately. Covers both shapes carried by
 * cards: Lumiverse-native bundles (`extensions.lumiverse_modules.regex_scripts`,
 * already internal-shaped) and SillyTavern cards (`extensions.regex_scripts`,
 * converted on the fly). Each script is rebound to the new character — `scope`
 * + `scope_id` so it applies at runtime, `character_id` so it cascade-deletes
 * when the character is removed.
 *
 * The CHARX import path imports its bundle separately (applyCharxModulesAndAssets);
 * this helper covers the non-CHARX card paths (inline card data, PNG, JSON), which
 * previously dropped bound regexes — leaving them as inert JSON in `extensions`.
 * Returns the number of scripts imported.
 */
export function importCharacterBoundRegexScripts(
  userId: string,
  characterId: string,
  extensions: unknown,
  options?: { bundleSource?: string },
): number {
  if (!extensions || typeof extensions !== "object") return 0;
  const ext = extensions as Record<string, any>;
  let imported = 0;
  const bundleSource = options?.bundleSource ?? "card_bundle";

  // Lumiverse-native bundle: already internal-shaped, rebind directly (mirrors
  // the CHARX bundle import in charx-import.service).
  const bundle = ext.lumiverse_modules?.regex_scripts;
  if (Array.isArray(bundle)) {
    for (const script of bundle) {
      if (!script || typeof script !== "object") continue;
      const result = createRegexScript(userId, prepareCharacterBoundImportedScript({
        ...(script as CreateRegexScriptInput),
        scope: "character",
        scope_id: characterId,
        character_id: characterId,
      }, bundleSource));
      if (typeof result !== "string") imported++;
    }
    return imported;
  }

  // SillyTavern cards store regex at `extensions.regex_scripts`. Only consulted
  // when there is no Lumiverse bundle, so a card carrying both isn't double-imported.
  const stScripts = ext.regex_scripts;
  if (Array.isArray(stScripts) && stScripts.length > 0) {
    const result = importRegexScripts(userId, {
      scripts: stScripts.map((s) =>
        s && typeof s === "object"
          ? prepareCharacterBoundImportedScript({ ...s, scope: "character", scope_id: characterId }, bundleSource)
          : s,
      ),
      character_id: characterId,
    });
    imported += result.imported;
  }

  return imported;
}

/**
 * Import preset-bound regex scripts for a preset that is NOT the currently-active
 * one (a LumiHub remote install, or any background preset import). The local
 * Loom-builder import can rely on the freshly-imported preset already being
 * active; this path cannot. importRegexScripts force-disables preset-bound scripts
 * whose preset is inactive, so each script is created dormant and the preset's
 * restore-list (`presetRegexEnabled:<id>`) is seeded from the author's intended
 * on/off state — so the scripts light up correctly the moment the user switches
 * to the preset.
 *
 * Caller is responsible for clearing a prior install's scripts
 * (deleteRegexScriptsByPresetId) before re-importing on an update. Returns counts.
 */
export function importPresetBoundRegexScripts(
  userId: string,
  presetId: string,
  presetName: string,
  scripts: any[],
  attribution?: PresetBoundRegexAttribution,
): { imported: number; skipped: number } {
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return { imported: 0, skipped: 0 };
  }

  let imported = 0;
  let skipped = 0;
  const enabledIds: string[] = [];

  // Import one at a time so each new row can be paired with the author's intended
  // enabled state; importRegexScripts still handles SillyTavern/internal normalization.
  for (const script of scripts) {
    if (!script || typeof script !== "object") {
      skipped++;
      continue;
    }
    const before = new Set(getRegexScriptsByPresetId(userId, presetId).map((s) => s.id));
    // Keep the publisher's folder grouping, but namespace it for this remote
    // installation so a local folder with the same author-provided name cannot
    // be merged into it.
    const sourceFolder = normalizeOptionalId(script.folder) ?? presetName;
    const remoteSource = attribution?.source;
    const remotePresetId = remoteSource
      ? normalizeOptionalId(attribution.remotePresetId ?? attribution.hubPresetId)
      : null;
    const folder = remoteSource && remotePresetId
      ? resolveRemotePresetRegexInstallFolder(remoteSource, userId, presetId, remotePresetId, presetName, sourceFolder)
      : normalizeOptionalId(attribution?.folderName) ?? sourceFolder;
    const scriptAttribution = remoteSource
      ? { ...attribution, folderName: sourceFolder }
      : attribution;
    const result = importRegexScripts(userId, {
      scripts: [{
        ...preparePresetBoundImportedScript(script, scriptAttribution),
        folder,
      }],
      folder,
      preset_id: presetId,
    });
    imported += result.imported;
    skipped += result.skipped;
    if (result.imported > 0 && !script.disabled) {
      for (const created of getRegexScriptsByPresetId(userId, presetId)) {
        if (!before.has(created.id)) enabledIds.push(created.id);
      }
    }
  }

  // Replace the restore-list so only this imported version's author-enabled
  // scripts can activate. Persist an empty list too; otherwise an older
  // version's IDs could be restored when every new script ships disabled.
  updateStoredPresetRegexIds(userId, presetId, () => enabledIds);

  return { imported, skipped };
}

function finishRegexMutation<T>(result: RegexMutationResult, userId: string): T {
  for (const event of result.events) eventBus.emit(event.type, event.payload, userId);
  return result.value as T;
}

export async function getRegexScriptAsync(userId: string, id: string): Promise<RegexScript | null> {
  const row = await readDatabaseRow<any>("SELECT * FROM regex_scripts WHERE id = ? AND user_id = ?", [id, userId]);
  return row ? rowToRegexScript(row) : null;
}

export async function listRegexScriptsAsync(
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
    conditions.push(`instr(target, '"' || ? || '"') > 0`);
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
  return await paginatedQueryAsync(`SELECT * FROM regex_scripts WHERE ${where} ORDER BY sort_order ASC, created_at ASC`, `SELECT COUNT(*) as count FROM regex_scripts WHERE ${where}`, params, pagination, rowToRegexScript);
}

async function readStoredPresetRegexIdsRecordAsync(userId: string, presetId: string): Promise<{ exists: boolean; ids: string[] }> {
  const row = (await readDatabaseRow<any>("SELECT value FROM settings WHERE key = ? AND user_id = ?", [getPresetRegexSettingKey(presetId), userId])) as { value?: string } | undefined;
  if (!row) return { exists: false, ids: [] };

  try {
    return { exists: true, ids: normalizeStoredPresetRegexIds(JSON.parse(row.value ?? "[]")) };
  } catch {
    return { exists: true, ids: [] };
  }
}

export async function getPresetActivationScriptsAsync(
  userId: string,
  presetId: string,
  context: { chatId: string; characterId?: string | null },
): Promise<RegexScript[]> {
  const scripts = getRegexScriptsByPresetId(userId, presetId);
  if (!scripts.some((script) => readPromptActivation(script.metadata))) return [];
  const saved = await readStoredPresetRegexIdsRecordAsync(userId, presetId);
  const enabledIds = new Set(saved.ids);
  const scopeOrder = { global: 0, character: 1, chat: 2 };
  return scripts.filter((script) =>
    (script.owner_extension_identifier == null && saved.exists
      ? enabledIds.has(script.id)
      : !script.disabled)
    && readPromptActivation(script.metadata)
    && (script.scope === "global"
      || (script.scope === "chat" && script.scope_id === context.chatId)
      || (script.scope === "character" && script.scope_id === context.characterId)),
  ).sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope] || a.sort_order - b.sort_order || a.created_at - b.created_at)
    .map((script) => ({ ...script, disabled: false }));
}

export async function getRegexScriptsByCharacterIdAsync(userId: string, characterId: string): Promise<RegexScript[]> {
  const rows = (await readDatabaseRows<any>("SELECT * FROM regex_scripts WHERE user_id = ? AND character_id = ? ORDER BY sort_order ASC, created_at ASC", [userId, characterId])) as any[];
  return rows.map(rowToRegexScript);
}

export async function exportRegexScriptsAsync(userId: string, options?: string[] | RegexScriptExportOptions): Promise<RegexScriptExport> {

  let rows: any[];
  const ids = Array.isArray(options) ? options : options?.ids;
  const presetIdFilter = !Array.isArray(options) ? normalizeOptionalId(options?.presetId) : null;

  if (ids && ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    rows = (await readDatabaseRows<any>(`SELECT * FROM regex_scripts WHERE user_id = ? AND id IN (${placeholders}) ORDER BY sort_order ASC, created_at ASC`, [userId, ...ids])) as any[];
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
    rows = (await readDatabaseRows<any>(`SELECT * FROM regex_scripts WHERE ${conditions.join(" AND ")} ORDER BY sort_order ASC, created_at ASC`, [...params])) as any[];
  }

  let normalizedRows = rows.map(rowToRegexScript);
  if (presetIdFilter) {
    const stored = await readStoredPresetRegexIdsRecordAsync(userId, presetIdFilter);
    if (stored.exists) {
      const enabledIds = new Set(stored.ids);
      normalizedRows = normalizedRows.map((s) => s.owner_extension_identifier == null
        ? { ...s, disabled: !enabledIds.has(s.id) }
        : s);
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

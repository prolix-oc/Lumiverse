import type { Database, SQLQueryBindings } from "bun:sqlite";
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
  RegexAction,
  RegexActionEffect,
} from "../types/regex-script";
import type { Preset } from "../types/preset";
import { evaluate, registry } from "../macros";
import type { MacroEnv, EvaluateResult } from "../macros/types";
import type { EvaluateOptions } from "../macros/MacroEvaluator";
import {
  regexCollectSandboxed,
  regexCaptureReplacementsSandboxed,
  regexNativeCaptureReplacementsSandboxed,
  regexTestSandboxed,
  RegexTimeoutError,
  RegexSandboxError,
  type RegexSandboxOptions,
  type SandboxCaptureReplacement,
  type SandboxMatch,
} from "../utils/regex-sandbox";
import { substituteRegexCaptures as substituteRegexCapturesCore } from "../utils/regex-sandbox-core";
import {
  buildRegexActionCaptureTemplate,
  decorateRegexActionReplacements,
} from "../utils/regex-actions";
import {
  REGEX_LIMITS_V1,
  RegexCancelledError,
  RegexDeadlineError,
  RegexExpansionBudget,
  RegexLimitError,
  type RegexValidationErrorCode,
  type RegexValidationFailure,
  assertRegexTextBytes,
  throwIfRegexAborted,
  truncateUtf8,
  utf8ByteLength,
} from "../utils/regex-limits";
import { createExpansionBudget } from "../types/agent-preprocessing";
import { getPresetAgentConfig, quarantineAgentConfigForPresetRevisionWithDb } from "./agent-config-portability.service";
import { sameJsonValue } from "../utils/json-value";

const REGEX_SCRIPT_TIMEOUT_MS = 500;
const REGEX_SLOW_WARNING_MS = 5_000;
const REGEX_PERFORMANCE_ENGINE_VERSION = 2;
function reserveRegexGrowth(_before: string, after: string, budget: RegexExpansionBudget): void {
  // Macro output is generated data even when it happens to be shorter than
  // the source template. Charge the complete result so shrinking macros
  // cannot be used to bypass the shared expansion budget.
  budget.reserve(utf8ByteLength(after));
}

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
  userId?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  expansionBudget?: RegexExpansionBudget;
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
const MAX_PATTERN_LENGTH = REGEX_LIMITS_V1.maxPatternBytes;
const MAX_REGEX_ACTIONS = REGEX_LIMITS_V1.maxActionCount;
const MAX_REGEX_ACTION_FIELD_LENGTH = REGEX_LIMITS_V1.maxActionBytes;
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
  /** Imported data is retained disabled with a repair code instead of rejected. */
  foreignImport?: boolean;
  /** Explicitly-authorized editors may mutate rows outside their extension ownership boundary. */
  allowUnownedMutation?: boolean;
  /** Present only when a Spindle mutation explicitly supplied folder_version. */
  extensionFolderVersion?: unknown;
  /** Collects owners so one bulk/import operation advances each preset once. */
  presetAuthorityBatch?: Set<string>;
  /** The enclosing preset mutation already owns its revision advance. */
  suppressPresetAuthorityMutation?: boolean;
}
export type RegexPresetAuthoritySnapshot = Map<string, string>;

function readRegexPresetAuthorities(userId: string): Preset[] {
  const rows = getDb().query("SELECT * FROM presets WHERE user_id = ? ORDER BY id").all(userId) as any[];
  return rows.map((row) => {
    const preset: Preset = {
      id: row.id,
      name: row.name,
      provider: row.provider,
      engine: row.engine,
      parameters: JSON.parse(row.parameters),
      prompt_order: JSON.parse(row.prompt_order),
      prompts: JSON.parse(row.prompts),
      metadata: JSON.parse(row.metadata),
      cache_revision: row.cache_revision ?? 0,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const projection = getPresetAgentConfig(userId, row.id);
    if (projection) {
      preset.agent_config = projection.config;
      preset.agent_config_revision = projection.configRevision;
      preset.agent_config_review = projection.review;
    }
    return preset;
  });
}

export function captureRegexPresetAuthorities(userId: string): RegexPresetAuthoritySnapshot {
  return new Map(readRegexPresetAuthorities(userId).map((preset) => [
    preset.id,
    `${preset.cache_revision ?? 0}:${preset.agent_config_revision ?? 0}`,
  ]));
}

export function resolveRegexPresetAuthorities(
  userId: string,
  before: RegexPresetAuthoritySnapshot,
): { presetAuthorityChanged: boolean; presetAuthorities: Preset[] } {
  const presetAuthorities = readRegexPresetAuthorities(userId).filter((preset) => (
    before.get(preset.id) !== `${preset.cache_revision ?? 0}:${preset.agent_config_revision ?? 0}`
  ));
  for (const preset of presetAuthorities) {
    eventBus.emit(EventType.PRESET_CHANGED, { id: preset.id, preset }, userId);
  }
  return { presetAuthorityChanged: presetAuthorities.length > 0, presetAuthorities };
}
const EXTENSION_REGEX_OWNERSHIP_ERROR = "Regex script is not an unbound script owned by this extension";

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

function advancePresetRegexAuthoritiesWithDb(
  db: Database,
  userId: string,
  presetIds: Iterable<string>,
): Set<string> {
  const advanced = new Set<string>();
  const now = Math.floor(Date.now() / 1000);
  for (const presetId of new Set(presetIds)) {
    const row = db.query(
      "SELECT cache_revision, prompt_order FROM presets WHERE id = ? AND user_id = ?",
    ).get(presetId, userId) as { cache_revision?: number; prompt_order?: string } | null;
    if (!row) continue;
    const currentRevision = Number(row.cache_revision) || 0;
    const result = db.query(
      "UPDATE presets SET cache_revision = cache_revision + 1, updated_at = ? WHERE id = ? AND user_id = ? AND cache_revision = ?",
    ).run(now, presetId, userId, currentRevision);
    if (result.changes !== 1) throw new Error("PRESET_REVISION_CONFLICT");
    let promptOrder: readonly unknown[] = [];
    try {
      const parsed = JSON.parse(row.prompt_order ?? "[]");
      if (Array.isArray(parsed)) promptOrder = parsed;
    } catch {}
    quarantineAgentConfigForPresetRevisionWithDb(
      db,
      userId,
      presetId,
      currentRevision + 1,
      promptOrder,
    );
    advanced.add(presetId);
  }
  return advanced;
}

function recordPresetRegexAuthorities(
  db: Database,
  userId: string,
  presetIds: Iterable<string | null | undefined>,
  context?: RegexMutationContext,
): void {
  if (context?.suppressPresetAuthorityMutation) return;
  const owners = [...presetIds].filter((value): value is string => typeof value === "string" && value.length > 0);
  if (context?.presetAuthorityBatch) {
    for (const presetId of owners) context.presetAuthorityBatch.add(presetId);
    return;
  }
  advancePresetRegexAuthoritiesWithDb(db, userId, owners);
}

function regexAuthoritySemantics(script: RegexScript): Record<string, unknown> {
  const { id: _id, user_id: _userId, created_at: _createdAt, updated_at: _updatedAt, ...semantic } = script;
  const metadata = { ...(semantic.metadata ?? {}) };
  delete metadata.regex_performance;
  delete metadata.regex_evidence;
  return { ...semantic, metadata };
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

function parseJsonValue(value: unknown, fallback: unknown): unknown {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToValidationInput(row: any): CreateRegexScriptInput {
  const parsedTarget = parseJsonValue(row.target, ["response"]);
  const parsedPlacement = parseJsonValue(row.placement, ["ai_output"]);
  const parsedTrimStrings = parseJsonValue(row.trim_strings, []);
  const parsedActions = parseJsonValue(row.actions, []);
  const parsedMetadata = parseJsonValue(row.metadata, {});
  return {
    name: row.name,
    find_regex: row.find_regex,
    replace_string: row.replace_string ?? "",
    actions: parsedActions as RegexAction[],
    flags: row.flags ?? "gi",
    placement: parsedPlacement as RegexPlacement[],
    scope: row.scope ?? "global",
    scope_id: row.scope_id ?? null,
    target: parsedTarget as RegexTarget[],
    min_depth: row.min_depth ?? null,
    max_depth: row.max_depth ?? null,
    trim_strings: parsedTrimStrings as string[],
    run_on_edit: !!row.run_on_edit,
    substitute_macros: row.substitute_macros ?? "none",
    metadata: parsedMetadata as Record<string, any>,
  };
}

function validateStoredRow(row: any): RegexValidationFailure | null {
  if (typeof row.actions === "string" && !Array.isArray(parseJsonValue(row.actions, null))) {
    return failure("invalid_input", "actions contains invalid JSON");
  }
  if (typeof row.placement === "string" && !Array.isArray(parseJsonValue(row.placement, null))) {
    return failure("invalid_input", "placement contains invalid JSON");
  }
  if (typeof row.target === "string" && !Array.isArray(parseJsonValue(row.target, null))) {
    return failure("invalid_input", "target contains invalid JSON");
  }
  if (typeof row.trim_strings === "string" && !Array.isArray(parseJsonValue(row.trim_strings, null))) {
    return failure("invalid_input", "trim_strings contains invalid JSON");
  }
  if (typeof row.metadata === "string" && !isPlainMetadataRecord(parseJsonValue(row.metadata, null))) {
    return failure("invalid_input", "metadata contains invalid JSON");
  }
  const input = rowToValidationInput(row);
  const inputFailure = validateInput(input, true);
  if (inputFailure) return inputFailure;
  return validateRegex(input.find_regex, input.flags, input.substitute_macros);
}

function quarantineRegexRow(row: any): any {
  if (row.validation_error_code) {
    if (!row.disabled) row.disabled = 1;
    return row;
  }
  const validation = validateStoredRow(row);
  if (!validation) return row;
  try {
    getDb().query(
      `UPDATE regex_scripts
       SET disabled = 1, validation_error_code = ?, updated_at = ?
       WHERE id = ? AND user_id = ?
         AND (validation_error_code IS NULL OR validation_error_code = '')`,
    ).run(validation.code, Math.floor(Date.now() / 1000), row.id, row.user_id);
    row.disabled = 1;
    row.validation_error_code = validation.code;
  } catch {
    // Focused test schemas and pre-103 databases may not have the column yet.
    // They still receive the in-memory disabled result and cannot execute.
    row.disabled = 1;
    row.validation_error_code = validation.code;
  }
  return row;
}

export function rowToRegexScript(row: any): RegexScript {
  const safeRow = quarantineRegexRow({ ...row });
  const targetValue = parseJsonValue(safeRow.target, ["response"]);
  const target: RegexTarget[] = Array.isArray(targetValue)
    ? targetValue as RegexTarget[]
    : [safeRow.target || "response"];
  const placementValue = parseJsonValue(safeRow.placement, ["ai_output"]);
  const trimValue = parseJsonValue(safeRow.trim_strings, []);
  const metadataValue = parseJsonValue(safeRow.metadata, {});
  return {
    ...safeRow,
    script_id: safeRow.script_id || "",
    actions: normalizeRegexActions(parseJsonArray(safeRow.actions)),
    placement: Array.isArray(placementValue) ? placementValue : ["ai_output"],
    target,
    trim_strings: Array.isArray(trimValue) ? trimValue.filter((entry): entry is string => typeof entry === "string") : [],
    folder: safeRow.folder || "",
    pack_id: safeRow.pack_id || null,
    preset_id: safeRow.preset_id || null,
    character_id: safeRow.character_id || null,
    owner_extension_identifier: safeRow.owner_extension_identifier || null,
    validation_error_code: safeRow.validation_error_code || null,
    metadata: isPlainMetadataRecord(metadataValue) ? metadataValue : {},
    run_on_edit: !!safeRow.run_on_edit,
    disabled: !!safeRow.disabled,
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
                ? truncateUtf8(effect.value, MAX_REGEX_ACTION_FIELD_LENGTH)
                : "",
            }];
          }
          if (effect.type === "draft") {
            return [{
              type: "draft",
              content: typeof effect.content === "string"
                ? truncateUtf8(effect.content, MAX_REGEX_ACTION_FIELD_LENGTH)
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
      cost: typeof item.cost === "string" ? truncateUtf8(item.cost, MAX_REGEX_ACTION_FIELD_LENGTH) : "1",
      limit: typeof item.limit === "string" ? truncateUtf8(item.limit, MAX_REGEX_ACTION_FIELD_LENGTH) : "3",
      title: typeof item.title === "string" ? truncateUtf8(item.title, MAX_REGEX_ACTION_FIELD_LENGTH) : "",
      subtitle: typeof item.subtitle === "string" ? truncateUtf8(item.subtitle, MAX_REGEX_ACTION_FIELD_LENGTH) : "",
      content: typeof item.content === "string" ? truncateUtf8(item.content, MAX_REGEX_ACTION_FIELD_LENGTH) : "",
      ...(compatibleEffects.length > 0 ? { effects: compatibleEffects } : {}),
    });
  }
  return actions;
}

function validateFlags(flags: string): boolean {
  for (const ch of flags) {
    if (!VALID_FLAGS.has(ch)) return false;
  }
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

function failure(code: RegexValidationErrorCode, message: string): RegexValidationFailure {
  return { code, message };
}

function validateText(
  value: unknown,
  maxBytes: number,
  code: RegexValidationErrorCode,
  label: string,
): RegexValidationFailure | null {
  if (typeof value !== "string") return failure("invalid_input", `${label} must be a string`);
  if (utf8ByteLength(value) > maxBytes) {
    return failure(code, `${label} exceeds maximum UTF-8 size of ${maxBytes} bytes`);
  }
  return null;
}

function validateRegex(
  pattern: unknown,
  flags: unknown,
  substituteMacros: RegexScript["substitute_macros"] = "none",
): RegexValidationFailure | null {
  const patternFailure = validateText(
    pattern,
    REGEX_LIMITS_V1.maxPatternBytes,
    "pattern_too_large",
    "find_regex",
  );
  if (patternFailure) return patternFailure;
  if (typeof flags !== "string") return failure("invalid_flags", "flags must be a string");
  if (!validateFlags(flags)) {
    return failure("invalid_flags", "Invalid flags — allowed: d, g, i, m, s, u, v, y");
  }
  try {
    const source = substituteMacros !== "none" && hasMacroSyntax(pattern as string)
      ? sanitizeRegexPatternForValidation(pattern as string)
      : pattern as string;
    new RegExp(source, flags);
    return null;
  } catch (error: unknown) {
    return failure("invalid_regex", `Invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateAction(action: unknown): RegexValidationFailure | null {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    return failure("invalid_input", "actions contains an invalid entry");
  }
  const candidate = action as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  if (!REGEX_ACTION_ID_RE.test(id)) {
    return failure("invalid_input", "action id must start with a letter and contain only letters, numbers, _, :, . or -");
  }
  const type = candidate.type;
  if (type !== "send" && type !== "append" && type !== "effects") {
    return failure("invalid_input", `Invalid action type: ${String(type)}`);
  }
  if (candidate.multi_select !== undefined && typeof candidate.multi_select !== "boolean") {
    return failure("invalid_input", "action multi_select must be a boolean");
  }
  const fields = [candidate.title, candidate.subtitle, candidate.content, candidate.cost ?? "1", candidate.limit ?? "3"];
  for (const field of fields) {
    const fieldFailure = validateText(field, MAX_REGEX_ACTION_FIELD_LENGTH, "action_too_large", "action field");
    if (fieldFailure) {
      if (fieldFailure.code === "invalid_input") {
        return failure("invalid_input", "action title, subtitle, content, cost, and limit must be strings");
      }
      return failure(fieldFailure.code, "action field exceeds maximum UTF-8 size");
    }
  }
  if (type !== "effects" && !(candidate.content as string).trim()) {
    return failure("invalid_input", `action content is required: ${id}`);
  }
  if (type === "effects" && candidate.multi_select) {
    return failure("invalid_input", "effects-only actions cannot be multi-select");
  }
  const effects = candidate.effects;
  if (type === "effects" && (!Array.isArray(effects) || effects.length === 0)) {
    return failure("invalid_input", `effects-only action requires at least one effect: ${id}`);
  }
  if (effects !== undefined) {
    if (!Array.isArray(effects)) return failure("invalid_input", "action effects must be an array");
    if (effects.length > 16) return failure("invalid_input", "action effects exceeds maximum length (16)");
    let draftCount = 0;
    let forkCount = 0;
    for (const rawEffect of effects) {
      if (!rawEffect || typeof rawEffect !== "object" || Array.isArray(rawEffect)) {
        return failure("invalid_input", "action contains an unsupported effect");
      }
      const effect = rawEffect as Record<string, unknown>;
      if (effect.type === "set_state") {
        if (typeof effect.key !== "string" || !REGEX_ACTION_STATE_KEY_RE.test(effect.key.trim())) {
          return failure("invalid_input", "state effect key must start with a letter and contain only letters, numbers, _, :, . or -");
        }
        if (typeof effect.value !== "string") return failure("invalid_input", "state effect value must be a string");
        if (utf8ByteLength(effect.value) > MAX_REGEX_ACTION_FIELD_LENGTH) {
          return failure("action_too_large", "state effect value exceeds maximum UTF-8 size");
        }
      } else if (effect.type === "draft") {
        draftCount += 1;
        if (typeof effect.content !== "string" || !effect.content.trim()) {
          return failure("invalid_input", "draft effect content is required");
        }
        if (utf8ByteLength(effect.content) > MAX_REGEX_ACTION_FIELD_LENGTH) {
          return failure("action_too_large", "draft effect content exceeds maximum UTF-8 size");
        }
        if (effect.mode !== "replace" && effect.mode !== "append") {
          return failure("invalid_input", "draft effect mode must be replace or append");
        }
      } else if (effect.type === "fork") {
        forkCount += 1;
      } else {
        return failure("invalid_input", "action contains an unsupported effect");
      }
    }
    if (draftCount > 1) return failure("invalid_input", "an action can contain only one draft effect");
    if (forkCount > 1) return failure("invalid_input", "an action can contain only one fork effect");
    if (type !== "effects" && effects.some((effect) => {
      const kind = effect && typeof effect === "object" ? (effect as Record<string, unknown>).type : undefined;
      return kind === "draft" || kind === "fork";
    })) {
      return failure("invalid_input", "draft and fork effects require an effects-only action");
    }
  }
  return null;
}

function validateInput(
  input: CreateRegexScriptInput | UpdateRegexScriptInput,
  isCreate: boolean,
): RegexValidationFailure | null {
  const candidate = input as Record<string, unknown>;
  if (isCreate) {
    if (typeof candidate.name !== "string" || !candidate.name.trim()) return failure("invalid_input", "name is required");
    if (candidate.find_regex === undefined || candidate.find_regex === null) {
      return failure("invalid_input", "find_regex is required");
    }
  }
  if (candidate.name !== undefined) {
    const nameFailure = validateText(candidate.name, MAX_REGEX_ACTION_FIELD_LENGTH, "action_too_large", "name");
    if (nameFailure) return nameFailure;
  }
  if (candidate.find_regex !== undefined) {
    const patternFailure = validateText(candidate.find_regex, MAX_PATTERN_LENGTH, "pattern_too_large", "find_regex");
    if (patternFailure) return patternFailure;
  }
  if (candidate.replace_string !== undefined) {
    const replacementFailure = validateText(
      candidate.replace_string,
      REGEX_LIMITS_V1.maxReplacementBytes,
      "replacement_too_large",
      "replace_string",
    );
    if (replacementFailure) return replacementFailure;
  }
  if (candidate.actions !== undefined) {
    if (!Array.isArray(candidate.actions)) return failure("invalid_input", "actions must be an array");
    if (candidate.actions.length > MAX_REGEX_ACTIONS) {
      return failure("action_count_exceeded", `actions exceeds maximum length (${MAX_REGEX_ACTIONS})`);
    }
    const ids = new Set<string>();
    for (const action of candidate.actions) {
      const actionFailure = validateAction(action);
      if (actionFailure) return actionFailure;
      const id = (action as RegexAction).id.trim();
      if (ids.has(id)) return failure("invalid_input", `duplicate action id: ${id}`);
      ids.add(id);
    }
  }
  if (candidate.flags !== undefined) {
    if (typeof candidate.flags !== "string" || !validateFlags(candidate.flags)) {
      return failure("invalid_flags", "Invalid flags — allowed: d, g, i, m, s, u, v, y");
    }
  }
  if (candidate.placement !== undefined) {
    if (!Array.isArray(candidate.placement)) return failure("invalid_input", "placement must be an array");
    for (const placement of candidate.placement) {
      if (!VALID_PLACEMENTS.has(placement)) return failure("invalid_input", `Invalid placement: ${String(placement)}`);
    }
  }
  if (candidate.scope !== undefined && (typeof candidate.scope !== "string" || !VALID_SCOPES.has(candidate.scope))) {
    return failure("invalid_input", `Invalid scope: ${String(candidate.scope)}`);
  }
  if (
    isCreate
    && candidate.scope !== undefined
    && candidate.scope !== "global"
    && !candidate.scope_id
  ) {
    return failure("invalid_input", "scope_id is required for non-global scope");
  }
  if (
    !isCreate
    && candidate.scope !== undefined
    && candidate.scope !== "global"
    && candidate.scope_id !== undefined
    && !candidate.scope_id
  ) {
    return failure("invalid_input", "scope_id is required for non-global scope");
  }
  if (candidate.target !== undefined) {
    const targets = typeof candidate.target === "string" ? [candidate.target] : candidate.target;
    if (!Array.isArray(targets) || targets.length === 0) return failure("invalid_input", "target must be a non-empty array");
    for (const target of targets) {
      if (!VALID_TARGETS.has(target)) return failure("invalid_input", `Invalid target: ${String(target)}`);
    }
  }
  if (candidate.trim_strings !== undefined) {
    if (!Array.isArray(candidate.trim_strings)) return failure("invalid_input", "trim_strings must be an array");
    if (candidate.trim_strings.length > REGEX_LIMITS_V1.maxTrimStrings) {
      return failure("trim_string_count_exceeded", `trim_strings exceeds maximum length (${REGEX_LIMITS_V1.maxTrimStrings})`);
    }
    for (const trim of candidate.trim_strings) {
      if (typeof trim !== "string") return failure("invalid_input", "trim_strings must contain strings");
      if (trim.length === 0) return failure("trim_string_empty", "trim_strings cannot contain empty strings");
      if (utf8ByteLength(trim) > REGEX_LIMITS_V1.maxTrimStringBytes) {
        return failure("trim_string_too_large", `trim string exceeds maximum UTF-8 size of ${REGEX_LIMITS_V1.maxTrimStringBytes} bytes`);
      }
    }
  }
  if (candidate.min_depth !== undefined && candidate.min_depth !== null) {
    if (!Number.isInteger(candidate.min_depth) || (candidate.min_depth as number) < 0) {
      return failure("invalid_input", "min_depth must be a non-negative integer");
    }
  }
  if (candidate.max_depth !== undefined && candidate.max_depth !== null) {
    if (!Number.isInteger(candidate.max_depth) || (candidate.max_depth as number) < 0) {
      return failure("invalid_input", "max_depth must be a non-negative integer");
    }
  }
  if (
    candidate.min_depth !== undefined
    && candidate.max_depth !== undefined
    && candidate.min_depth !== null
    && candidate.max_depth !== null
    && (candidate.min_depth as number) > (candidate.max_depth as number)
  ) {
    return failure("invalid_input", "min_depth cannot exceed max_depth");
  }
  if (
    candidate.substitute_macros !== undefined
    && (typeof candidate.substitute_macros !== "string" || !VALID_MACRO_MODES.has(candidate.substitute_macros))
  ) {
    return failure("invalid_input", `Invalid substitute_macros: ${String(candidate.substitute_macros)}`);
  }
  if (candidate.script_id !== undefined) {
    if (typeof candidate.script_id !== "string") return failure("invalid_input", "script_id must be a string");
    if (utf8ByteLength(normalizeScriptId(candidate.script_id)) > 100) {
      return failure("action_too_large", "script_id exceeds maximum length (100 characters)");
    }
  }
  if (candidate.metadata !== undefined && !isPlainMetadataRecord(candidate.metadata)) {
    return failure("invalid_input", "metadata must be an object");
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
  folderName?: string | null;
}

interface RemotePresetRegexAttribution {
  id: string | null;
  version: string | null;
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
  const folderName = normalizeOptionalId(raw.folderName);
  return id || version ? { id, version, folderName } : null;
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
    metadata._lumiverse_illarin_preset = {
      id: normalizeOptionalId(attribution.remotePresetId),
      version: normalizeOptionalId(attribution.presetVersion),
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
    (row) => rowToRegexScript(row),
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

function normalizeForeignRegexInput(
  input: CreateRegexScriptInput,
): CreateRegexScriptInput {
  const candidate: Record<string, unknown> = { ...input };
  const name = typeof candidate.name === "string" && candidate.name.trim()
    ? truncateUtf8(candidate.name.trim(), MAX_REGEX_ACTION_FIELD_LENGTH)
    : "Imported regex";
  const findRegex = typeof candidate.find_regex === "string"
    ? truncateUtf8(candidate.find_regex, REGEX_LIMITS_V1.maxPatternBytes)
    : "";
  const replaceString = typeof candidate.replace_string === "string"
    ? truncateUtf8(candidate.replace_string, REGEX_LIMITS_V1.maxReplacementBytes)
    : "";
  const trimStrings = Array.isArray(candidate.trim_strings)
    ? candidate.trim_strings
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .slice(0, REGEX_LIMITS_V1.maxTrimStrings)
      .map((value) => truncateUtf8(value, REGEX_LIMITS_V1.maxTrimStringBytes))
    : [];
  return {
    name,
    find_regex: findRegex,
    replace_string: replaceString,
    actions: Array.isArray(candidate.actions) ? normalizeRegexActions(candidate.actions) : [],
    flags: typeof candidate.flags === "string" ? candidate.flags : "gi",
    placement: Array.isArray(candidate.placement) ? candidate.placement as RegexPlacement[] : ["ai_output"],
    scope: candidate.scope === "character" || candidate.scope === "chat" ? candidate.scope : "global",
    scope_id: typeof candidate.scope_id === "string" ? candidate.scope_id : null,
    target: Array.isArray(candidate.target)
      ? candidate.target as RegexTarget[]
      : typeof candidate.target === "string"
        ? [candidate.target as RegexTarget]
        : ["response"],
    trim_strings: trimStrings,
    run_on_edit: candidate.run_on_edit === true,
    substitute_macros: typeof candidate.substitute_macros === "string" && VALID_MACRO_MODES.has(candidate.substitute_macros)
      ? candidate.substitute_macros as RegexScript["substitute_macros"]
      : "none",
    disabled: true,
    sort_order: typeof candidate.sort_order === "number" ? candidate.sort_order : 0,
    description: typeof candidate.description === "string"
      ? truncateUtf8(candidate.description, MAX_REGEX_ACTION_FIELD_LENGTH)
      : "",
    folder: typeof candidate.folder === "string"
      ? truncateUtf8(candidate.folder, MAX_REGEX_ACTION_FIELD_LENGTH)
      : "",
    pack_id: normalizeOptionalId(candidate.pack_id),
    preset_id: normalizeOptionalId(candidate.preset_id),
    character_id: normalizeOptionalId(candidate.character_id),
    metadata: isPlainMetadataRecord(candidate.metadata) ? candidate.metadata : {},
    script_id: typeof candidate.script_id === "string" ? normalizeScriptId(candidate.script_id) : "",
  };
}

function regexScriptCount(userId: string): number {
  const row = getDb().query("SELECT COUNT(*) AS count FROM regex_scripts WHERE user_id = ?").get(userId) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

export function createRegexScript(
  userId: string,
  input: CreateRegexScriptInput,
  context?: RegexMutationContext,
): RegexScript | string {
  const extensionIdentifier = normalizeOptionalId(context?.extensionIdentifier);
  let nextInput: CreateRegexScriptInput = extensionIdentifier
    ? { ...input, pack_id: null, preset_id: null, character_id: null }
    : { ...input };
  if (extensionIdentifier && context) {
    const folderVersionError = validateExtensionFolderVersion(context);
    if (folderVersionError) return folderVersionError;
    nextInput = applySpindleExtensionRegexAttribution(nextInput, extensionIdentifier, context);
  }
  let validation = validateInput(nextInput, true);
  if (!validation) {
    validation = validateRegex(nextInput.find_regex, nextInput.flags ?? "gi", nextInput.substitute_macros ?? "none");
  }
  const countFailure = regexScriptCount(userId) >= REGEX_LIMITS_V1.maxScripts
    ? failure("script_count_exceeded", `Regex script limit exceeded (${REGEX_LIMITS_V1.maxScripts})`)
    : null;
  if (!validation && countFailure) validation = countFailure;
  if (validation && !context?.foreignImport) return validation.message;

  const persistedInput = validation
    ? normalizeForeignRegexInput(nextInput)
    : {
      ...nextInput,
      script_id: nextInput.script_id === undefined ? "" : normalizeScriptId(nextInput.script_id),
    };
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const activePresetId = normalizeOptionalId(context?.activePresetId);
  const disabled = validation ? true : resolveCreateDisabledState(persistedInput, activePresetId);

  const db = getDb();
  try {
    db.transaction(() => {
      db.query(
        `INSERT INTO regex_scripts (id, user_id, name, script_id, find_regex, replace_string, actions, flags, placement, scope, scope_id, target, min_depth, max_depth, trim_strings, run_on_edit, substitute_macros, disabled, sort_order, description, folder, pack_id, preset_id, character_id, owner_extension_identifier, validation_error_code, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        userId,
        persistedInput.name.trim(),
        persistedInput.script_id ?? "",
        persistedInput.find_regex,
        persistedInput.replace_string ?? "",
        JSON.stringify(persistedInput.actions ?? []),
        persistedInput.flags ?? "gi",
        JSON.stringify(persistedInput.placement ?? ["ai_output"]),
        persistedInput.scope ?? "global",
        persistedInput.scope === "global" || !persistedInput.scope ? null : (persistedInput.scope_id ?? null),
        JSON.stringify(persistedInput.target ?? ["response"]),
        persistedInput.min_depth ?? null,
        persistedInput.max_depth ?? null,
        JSON.stringify(persistedInput.trim_strings ?? []),
        persistedInput.run_on_edit ? 1 : 0,
        persistedInput.substitute_macros ?? "none",
        disabled ? 1 : 0,
        persistedInput.sort_order ?? 0,
        persistedInput.description ?? "",
        persistedInput.folder ?? "",
        persistedInput.pack_id ?? null,
        persistedInput.preset_id ?? null,
        persistedInput.character_id ?? null,
        extensionIdentifier,
        validation?.code ?? null,
        JSON.stringify(persistedInput.metadata ?? {}),
        now,
        now,
      );
      const presetId = normalizeOptionalId(persistedInput.preset_id);
      if (presetId && presetId === activePresetId) {
        setPresetBoundScriptEnabledInRestoreList(userId, presetId, id, !disabled);
      }
      recordPresetRegexAuthorities(db, userId, [presetId], context);
    })();
  } catch (error) {
    const mapped = mapRegexScriptPersistenceError(error);
    if (mapped) return mapped;
    throw error;
  }

  const script = getRegexScript(userId, id)!;
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

  const extensionIdentifier = normalizeOptionalId(context?.extensionIdentifier);
  if (extensionIdentifier && (
    existing.owner_extension_identifier !== extensionIdentifier
    || existing.preset_id !== null
  ) && !context?.allowUnownedMutation) {
    return EXTENSION_REGEX_OWNERSHIP_ERROR;
  }

  const activePresetId = normalizeOptionalId(context?.activePresetId);
  const isPresetBound = !!existing.preset_id;
  let nextInput: UpdateRegexScriptInput = { ...input };
  if (extensionIdentifier) {
    const folderVersionError = validateExtensionFolderVersion(context);
    if (folderVersionError) return folderVersionError;
    if (existing.owner_extension_identifier === extensionIdentifier) {
      nextInput = applySpindleExtensionRegexAttribution(nextInput, extensionIdentifier, context!, existing);
    } else if (nextInput.metadata !== undefined) {
      // An unrestricted editor may change ordinary metadata, but must not
      // spoof or erase another extension's host-validated folder attribution.
      const metadata = isPlainMetadataRecord(nextInput.metadata) ? { ...nextInput.metadata } : {};
      const attribution = getSpindleExtensionRegexAttribution(existing.metadata);
      delete metadata[SPINDLE_EXTENSION_REGEX_METADATA_KEY];
      if (attribution) metadata[SPINDLE_EXTENSION_REGEX_METADATA_KEY] = attribution;
      nextInput.metadata = metadata;
    }
    // These links are host-owned. A script that becomes preset-bound through a
    // native flow automatically becomes read-only to its creating extension.
    delete nextInput.pack_id;
    delete nextInput.preset_id;
    delete nextInput.character_id;
  }
  if (nextInput.scope !== undefined) {
    if (nextInput.scope === "global") {
      nextInput.scope_id = null;
    } else if (nextInput.scope_id === undefined) {
      nextInput.scope_id = existing.scope === nextInput.scope ? existing.scope_id : null;
    }
  }
  // A pattern-affecting edit clears the slow/timed-out warning, since the
  // measurement described the old shape. The quarantine flag under
  // metadata.regex_evidence is intentionally left untouched: a script that hung
  // the executor stays skipped until the user clears it from the panel.
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

  const mergedInput = {
    ...existing,
    ...nextInput,
    name: nextInput.name ?? existing.name,
    find_regex: nextInput.find_regex ?? existing.find_regex,
    replace_string: nextInput.replace_string ?? existing.replace_string,
    actions: nextInput.actions ?? existing.actions,
    flags: nextInput.flags ?? existing.flags,
    placement: nextInput.placement ?? existing.placement,
    target: nextInput.target ?? existing.target,
    trim_strings: nextInput.trim_strings ?? existing.trim_strings,
    metadata: nextInput.metadata ?? existing.metadata,
  } as CreateRegexScriptInput;
  let validation = validateInput(mergedInput, true);
  if (!validation) {
    validation = validateRegex(
      mergedInput.find_regex,
      mergedInput.flags ?? "gi",
      mergedInput.substitute_macros ?? "none",
    );
  }
  if (validation && !context?.foreignImport) return validation.message;
  const writeInput = validation
    ? normalizeForeignRegexInput(mergedInput)
    : {
      ...nextInput,
      script_id: nextInput.script_id === undefined ? undefined : normalizeScriptId(nextInput.script_id),
    };

  const fields: string[] = [];
  const values: SQLQueryBindings[] = [];

  if (nextInput.name !== undefined) {
    fields.push("name = ?");
    values.push(writeInput.name === undefined ? existing.name : writeInput.name.trim());
  }
  if (nextInput.script_id !== undefined) { fields.push("script_id = ?"); values.push(writeInput.script_id ?? existing.script_id); }
  if (nextInput.find_regex !== undefined) { fields.push("find_regex = ?"); values.push(writeInput.find_regex ?? existing.find_regex); }
  if (nextInput.replace_string !== undefined) { fields.push("replace_string = ?"); values.push(writeInput.replace_string ?? existing.replace_string); }
  if (nextInput.actions !== undefined) { fields.push("actions = ?"); values.push(JSON.stringify(writeInput.actions ?? existing.actions)); }
  if (nextInput.flags !== undefined) { fields.push("flags = ?"); values.push(writeInput.flags ?? existing.flags); }
  if (nextInput.placement !== undefined) { fields.push("placement = ?"); values.push(JSON.stringify(writeInput.placement ?? existing.placement)); }
  if (nextInput.scope !== undefined) { fields.push("scope = ?"); values.push(writeInput.scope ?? existing.scope); }
  if (nextInput.scope_id !== undefined) {
    fields.push("scope_id = ?");
    values.push(writeInput.scope_id === undefined ? existing.scope_id : writeInput.scope_id);
  }
  if (nextInput.target !== undefined) { fields.push("target = ?"); values.push(JSON.stringify(writeInput.target ?? existing.target)); }
  if (nextInput.min_depth !== undefined) {
    fields.push("min_depth = ?");
    values.push(writeInput.min_depth === undefined ? existing.min_depth : writeInput.min_depth);
  }
  if (nextInput.max_depth !== undefined) {
    fields.push("max_depth = ?");
    values.push(writeInput.max_depth === undefined ? existing.max_depth : writeInput.max_depth);
  }
  if (nextInput.trim_strings !== undefined) { fields.push("trim_strings = ?"); values.push(JSON.stringify(writeInput.trim_strings ?? existing.trim_strings)); }
  if (nextInput.run_on_edit !== undefined) { fields.push("run_on_edit = ?"); values.push(writeInput.run_on_edit === true ? 1 : 0); }
  if (nextInput.substitute_macros !== undefined) { fields.push("substitute_macros = ?"); values.push(writeInput.substitute_macros ?? existing.substitute_macros); }
  if (nextInput.disabled !== undefined) { fields.push("disabled = ?"); values.push(validation ? 1 : (writeInput.disabled === true ? 1 : 0)); }
  if (nextInput.sort_order !== undefined) { fields.push("sort_order = ?"); values.push(writeInput.sort_order ?? existing.sort_order); }
  if (nextInput.description !== undefined) { fields.push("description = ?"); values.push(writeInput.description ?? existing.description); }
  if (nextInput.folder !== undefined) { fields.push("folder = ?"); values.push(writeInput.folder ?? existing.folder); }
  if (hasPresetIdUpdate) { fields.push("preset_id = ?"); values.push(nextPresetId); }
  if (nextInput.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(writeInput.metadata ?? existing.metadata)); }
  if (validation || existing.validation_error_code) {
    fields.push("validation_error_code = ?");
    values.push(validation?.code ?? null);
    if (validation && nextInput.disabled === undefined) {
      fields.push("disabled = ?");
      values.push(1);
    }
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  const db = getDb();
  let updated: RegexScript;
  try {
    db.transaction(() => {
      db.query(`UPDATE regex_scripts SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
      updated = getRegexScript(userId, id)!;
      if (existing.preset_id && existing.preset_id !== updated.preset_id) {
        setPresetBoundScriptEnabledInRestoreList(userId, existing.preset_id, updated.id, false);
      }
      if (updated.preset_id && (hasPresetIdUpdate || (mayPersistPresetEnablement && nextInput.disabled !== undefined))) {
        setPresetBoundScriptEnabledInRestoreList(userId, updated.preset_id, updated.id, !updated.disabled);
      }
      if (!sameJsonValue(regexAuthoritySemantics(existing), regexAuthoritySemantics(updated))) {
        recordPresetRegexAuthorities(db, userId, [existing.preset_id, updated.preset_id], context);
      }
    })();
  } catch (err) {
    const mapped = mapRegexScriptPersistenceError(err);
    if (mapped) return mapped;
    throw err;
  }

  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id, script: updated! }, userId);
  return updated!;
}

export function deleteRegexScript(userId: string, id: string): boolean;
export function deleteRegexScript(userId: string, id: string, context: RegexMutationContext): boolean | string;
export function deleteRegexScript(userId: string, id: string, context?: RegexMutationContext): boolean | string {
  const existing = getRegexScript(userId, id);
  const extensionIdentifier = normalizeOptionalId(context?.extensionIdentifier);
  if (extensionIdentifier && existing && (
    existing.owner_extension_identifier !== extensionIdentifier
    || existing.preset_id !== null
  ) && !context?.allowUnownedMutation) {
    return EXTENSION_REGEX_OWNERSHIP_ERROR;
  }
  const db = getDb();
  const result = db.transaction(() => {
    const deleted = db.query("DELETE FROM regex_scripts WHERE id = ? AND user_id = ?").run(id, userId);
    if (deleted.changes > 0 && existing?.preset_id) {
      setPresetBoundScriptEnabledInRestoreList(userId, existing.preset_id, existing.id, false);
      recordPresetRegexAuthorities(db, userId, [existing.preset_id], context);
    }
    return deleted;
  })();
  if (result.changes > 0) {
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
export function deleteRegexScripts(userId: string, ids: string[], context?: RegexMutationContext): string[] {
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
    db.query(`DELETE FROM regex_scripts WHERE user_id = ? AND id IN (${existingPlaceholders})`)
      .run(userId, ...existingIds);
    for (const row of existingRows) {
      if (row.preset_id) {
        setPresetBoundScriptEnabledInRestoreList(userId, row.preset_id, row.id, false);
      }
    }
    recordPresetRegexAuthorities(db, userId, existingRows.map((row) => row.preset_id), context);
  })();

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
      `INSERT INTO regex_scripts (id, user_id, name, script_id, find_regex, replace_string, actions, flags, placement, scope, scope_id, target, min_depth, max_depth, trim_strings, run_on_edit, substitute_macros, disabled, sort_order, description, folder, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      newId,
      userId,
      existing.name + " (Copy)",
      "", // script_id intentionally blank on duplicate — must be unique
      existing.find_regex,
      existing.replace_string,
      JSON.stringify(existing.actions),
      existing.flags,
      JSON.stringify(existing.placement),
      existing.scope,
      existing.scope_id,
      JSON.stringify(existing.target),
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
  const rows = orderedIds.length === 0 ? [] : db.query(
    `SELECT id, preset_id, sort_order FROM regex_scripts WHERE user_id = ? AND id IN (${orderedIds.map(() => "?").join(", ")})`,
  ).all(userId, ...orderedIds) as Array<{ id: string; preset_id?: string | null; sort_order: number }>;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const changed = orderedIds.flatMap((id, index) => {
    const row = rowsById.get(id);
    return row && row.sort_order !== index ? [row] : [];
  });
  if (changed.length === 0) return true;
  db.transaction(() => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < orderedIds.length; i++) {
      db.query("UPDATE regex_scripts SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(i, now, orderedIds[i], userId);
    }
    recordPresetRegexAuthorities(db, userId, changed.map((row) => row.preset_id));
  })();
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

  if (existing.disabled === disabled) return existing;
  const db = getDb();
  db.transaction(() => {
    db.query("UPDATE regex_scripts SET disabled = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(disabled ? 1 : 0, Math.floor(Date.now() / 1000), id, userId);
    if (existing.preset_id) {
      setPresetBoundScriptEnabledInRestoreList(userId, existing.preset_id, existing.id, !disabled);
    }
    recordPresetRegexAuthorities(db, userId, [existing.preset_id], context);
  })();

  const updated = getRegexScript(userId, id)!;
  eventBus.emit(EventType.REGEX_SCRIPT_CHANGED, { id, script: updated }, userId);
  return updated;
}

type RegexToggleRow = { id: string; preset_id?: string | null; disabled: number };

function toggleRegexScriptRows(
  userId: string,
  rows: RegexToggleRow[],
  disabled: boolean,
  activePresetId: string | null,
  context?: RegexMutationContext,
): { changedIds: string[]; skippedIds: string[] } {
  const changedIds: string[] = [];
  const skippedIds: string[] = [];
  const targets: Array<{ id: string; preset_id: string | null }> = [];

  for (const row of rows) {
    if (row.preset_id && row.preset_id !== activePresetId) {
      skippedIds.push(row.id);
      continue;
    }
    if (row.disabled === (disabled ? 1 : 0)) {
      continue;
    }
    targets.push({ id: row.id, preset_id: row.preset_id ?? null });
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
    for (const target of targets) {
      if (target.preset_id) {
        setPresetBoundScriptEnabledInRestoreList(userId, target.preset_id, target.id, !disabled);
      }
    }
    recordPresetRegexAuthorities(db, userId, targets.map((target) => target.preset_id), context);
  })();

  for (const target of targets) {
    changedIds.push(target.id);
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
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return { changedIds: [], skippedIds: [] };

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const unorderedRows = getDb()
    .query(`SELECT id, preset_id, disabled FROM regex_scripts WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...uniqueIds) as RegexToggleRow[];
  const rowsById = new Map(unorderedRows.map((row) => [row.id, row]));
  const rows = uniqueIds.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [row] : [];
  });

  return toggleRegexScriptRows(userId, rows, disabled, normalizeOptionalId(context?.activePresetId), context);
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
  const activePresetId = normalizeOptionalId(context?.activePresetId);
  const rows = getDb()
    .query("SELECT id, preset_id, disabled FROM regex_scripts WHERE user_id = ? AND folder = ?")
    .all(userId, folder) as RegexToggleRow[];

  return toggleRegexScriptRows(userId, rows, disabled, activePresetId, context);
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
         sort_order ASC, created_at ASC
       LIMIT ?`,
    )
    .all(...params, REGEX_LIMITS_V1.maxScripts) as any[];

  return rows.map((row) => rowToRegexScript(row));
}

/** Active scripts whose `target` array contains opts.target. */
export function getActiveScripts(
  userId: string,
  opts: { characterId?: string; chatId?: string; target: RegexTarget }
): RegexScript[] {
  // target stored as a JSON array; instr matches the quoted needle.
  return getScopedScripts(userId, opts, [`instr(target, '"' || ? || '"') > 0`], [opts.target]);
}

/** Active scripts configured to run when a message is edited. */
export function getRunOnEditScripts(
  userId: string,
  opts: { characterId?: string | null; chatId?: string | null },
): RegexScript[] {
  return getScopedScripts(userId, opts, ["run_on_edit = 1"], []);
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
 * All generated bytes are reserved before the final string is allocated.
 */
function rebuildFromMatches(
  content: string,
  matches: { index: number; matchLength: number }[],
  replacements: string[],
  expansionBudget?: RegexExpansionBudget,
  generatedAlreadyReserved = false,
): string {
  let outputBytes = utf8ByteLength(content);
  let generatedBytes = 0;
  let lastIdx = 0;

  // Validate all spans and sizes before retaining slices or joining output.
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const replacement = replacements[index] ?? "";
    if (
      !Number.isSafeInteger(match.index)
      || !Number.isSafeInteger(match.matchLength)
      || match.index < lastIdx
      || match.index < 0
      || match.matchLength < 0
      || match.index + match.matchLength > content.length
    ) {
      throw new RegexLimitError("worker_malformed", "Regex replacement returned malformed match spans");
    }
    const originalMatch = content.slice(match.index, match.index + match.matchLength);
    const replacementBytes = utf8ByteLength(replacement);
    if (replacementBytes > REGEX_LIMITS_V1.maxOperationBytes) {
      throw new RegexLimitError("operation_limit_exceeded", "Regex replacement exceeds its operation byte limit");
    }
    outputBytes += replacementBytes - utf8ByteLength(originalMatch);
    generatedBytes += replacementBytes;
    if (generatedBytes > REGEX_LIMITS_V1.maxExpansionBytes) {
      throw new RegexLimitError("expansion_limit_exceeded", "Regex replacements exceeded the expansion byte limit");
    }
    if (outputBytes > REGEX_LIMITS_V1.maxOutputBytes) {
      throw new RegexLimitError("output_limit_exceeded", "Regex output exceeded the output byte limit");
    }
    lastIdx = match.index + match.matchLength;
  }
  if (expansionBudget && !generatedAlreadyReserved) {
    for (const replacement of replacements) {
      expansionBudget.reserve(utf8ByteLength(replacement));
    }
  }

  const chunks: string[] = [];
  lastIdx = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    chunks.push(content.slice(lastIdx, match.index), replacements[index] ?? "");
    lastIdx = match.index + match.matchLength;
  }
  chunks.push(content.slice(lastIdx));
  return chunks.join("");
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
  if (script.preset_id) {
    return { sourceOwner: "host", sourceHint: "regex_script:preset" };
  }
  return undefined;
}

function evaluateRegexMacroWithBudget(
  text: string,
  macroEnv: MacroEnv,
  expansionBudget?: RegexExpansionBudget,
  macroOptions?: EvaluateOptions,
): Promise<EvaluateResult> {
  if (!expansionBudget) return evaluate(text, macroEnv, registry, macroOptions);
  const remaining = expansionBudget.remainingBytes();
  if (!Number.isSafeInteger(remaining) || remaining < 0) {
    throw new RegexLimitError("expansion_limit_exceeded", "Regex macro expansion budget is exhausted");
  }
  const macroBudget = createExpansionBudget({
    maxOutputBytes: remaining,
    maxCumulativeExpansionBytes: remaining,
    maxOperationBytes: Math.min(remaining, REGEX_LIMITS_V1.maxOperationBytes),
  }, macroEnv.signal);
  return evaluate(text, macroEnv, registry, { ...macroOptions, budget: macroBudget });
}

async function resolveFindMacros(
  findRegex: string,
  mode: RegexScript["substitute_macros"],
  macroEnv: MacroEnv,
  outFingerprint?: { touchedVars: Set<string>; cacheable: boolean },
  expansionBudget?: RegexExpansionBudget,
  macroOptions?: EvaluateOptions,
): Promise<string> {
  if (mode === "none") return findRegex;
  const result = await evaluateRegexMacroWithBudget(findRegex, macroEnv, expansionBudget, macroOptions);
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
  expansionBudget?: RegexExpansionBudget,
  macroOptions?: EvaluateOptions,
): Promise<string> {
  if (mode === "none" || mode === "find") return replaceString;

  const result = await evaluateRegexMacroWithBudget(replaceString, macroEnv, expansionBudget, macroOptions);
  foldFingerprint(outFingerprint, result);
  const resolved = result.text;

  if (mode === "escaped") {
    return resolved.replace(/\$/g, "$$$$");
  }
  return resolved;
}
function escapeTrimRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove configured trim tokens with a bounded number of scans. A single
 * combined literal regex replaces the old one-full-rescan-per-token loop;
 * oversized token sets are split into a small number of bounded batches.
 */
function applyTrimStrings(
  content: string,
  trims: readonly string[],
  options: ApplyRegexScriptOptions | undefined,
): string {
  if (trims.length === 0) return content;
  if (trims.length > REGEX_LIMITS_V1.maxTrimStrings) {
    throw new RegexLimitError("trim_string_count_exceeded", "Regex trim string count exceeds its limit");
  }

  const batches: string[][] = [];
  let batch: string[] = [];
  let patternBytes = utf8ByteLength("(?:)");
  for (const trim of trims) {
    throwIfRegexAborted(options?.signal, options?.deadlineAt);
    if (trim.length === 0) {
      throw new RegexLimitError("trim_string_empty", "Regex trim strings cannot be empty");
    }
    if (utf8ByteLength(trim) > REGEX_LIMITS_V1.maxTrimStringBytes) {
      throw new RegexLimitError("trim_string_too_large", "Regex trim string exceeds its byte limit");
    }
    const escaped = escapeTrimRegex(trim);
    const escapedBytes = utf8ByteLength(escaped);
    if (
      batch.length > 0
      && patternBytes + escapedBytes + utf8ByteLength("|") > REGEX_LIMITS_V1.maxPatternBytes
    ) {
      batches.push(batch);
      batch = [];
      patternBytes = utf8ByteLength("(?:)");
    }
    batch.push(escaped);
    patternBytes += escapedBytes + (batch.length > 1 ? utf8ByteLength("|") : 0);
  }
  if (batch.length > 0) batches.push(batch);
  if (batches.length > 32) {
    throw new RegexLimitError(
      "operation_limit_exceeded",
      "Regex trim operation would require too many full input scans",
    );
  }

  let result = content;
  for (const alternatives of batches) {
    throwIfRegexAborted(options?.signal, options?.deadlineAt);
    const regex = new RegExp(`(?:${alternatives.join("|")})`, "g");
    let matchCount = 0;
    result = result.replace(regex, () => {
      matchCount += 1;
      if (matchCount > REGEX_LIMITS_V1.maxMatchCount) {
        throw new RegexLimitError("match_limit_exceeded", "Regex trim match count exceeds its limit");
      }
      return "";
    });
    assertRegexTextBytes(result, REGEX_LIMITS_V1.maxOutputBytes, "output_limit_exceeded", "Regex output");
  }
  return result;
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
  assertRegexTextBytes(content, REGEX_LIMITS_V1.maxInputBytes, "invalid_input", "Regex input");
  if (scripts.length > REGEX_LIMITS_V1.maxScripts) {
    throw new RegexLimitError(
      "script_count_exceeded",
      `Regex script limit exceeded (${REGEX_LIMITS_V1.maxScripts})`,
    );
  }
  const expansionBudget = options?.expansionBudget ?? new RegexExpansionBudget();
  const sandboxOptions: RegexSandboxOptions = {
    userId: options?.userId ?? scripts[0]?.user_id ?? "regex-host",
    signal: options?.signal,
    deadlineAt: options?.deadlineAt,
    maxMatches: REGEX_LIMITS_V1.maxMatchCount,
    maxExpansionBytes: expansionBudget.remainingBytes(),
    maxOutputBytes: REGEX_LIMITS_V1.maxOutputBytes,
    maxOperationBytes: REGEX_LIMITS_V1.maxOperationBytes,
  };
  const executionOptions: ApplyRegexScriptOptions = {
    ...options,
    userId: options?.userId ?? scripts[0]?.user_id ?? "regex-host",
    expansionBudget,
  };
  let result = content;
  let patternCount = 0;

  for (const script of scripts) {
    throwIfRegexAborted(options?.signal, options?.deadlineAt);
    if (script.disabled) continue;
    if (!script.placement.includes(placement)) continue;
    if (depth !== undefined) {
      if (script.min_depth !== null && depth < script.min_depth) continue;
      if (script.max_depth !== null && depth > script.max_depth) continue;
    }
    const storedValidation = validateStoredRow(script);
    if (storedValidation) {
      throw new RegexLimitError(storedValidation.code, storedValidation.message);
    }
    patternCount += 1;
    if (patternCount > REGEX_LIMITS_V1.maxPatterns) {
      throw new RegexLimitError(
        "pattern_count_exceeded",
        `Compiled regex pattern limit exceeded (${REGEX_LIMITS_V1.maxPatterns})`,
      );
    }

    const startedAt = Date.now();
    try {
      const macroOptions = macroOptionsForRegexScript(script);
      let findRegex = script.find_regex;
      const preResolvedFind = resolvedTemplates?.resolvedFindPatterns?.get(script.id);
      if (preResolvedFind !== undefined) {
        findRegex = preResolvedFind;
      } else if (macroEnv && script.substitute_macros !== "none") {
        const originalFind = findRegex;
        findRegex = await resolveFindMacros(
          findRegex,
          script.substitute_macros,
          macroEnv,
          options?.outFingerprint,
          expansionBudget,
          macroOptions,
        );
        reserveRegexGrowth(originalFind, findRegex, expansionBudget);
      }
      assertRegexTextBytes(findRegex, REGEX_LIMITS_V1.maxPatternBytes, "pattern_too_large", "Regex pattern");

      const regexActions = readRegexActions(script);
      if (regexActions.size > 0) {
        if (options?.outFingerprint && regexActions.has("repeat_back")) {
          options.outFingerprint.cacheable = false;
        }
        const applied = await applyRegexActions(
          result,
          findRegex,
          script.flags,
          script.replace_string,
          regexActions,
          executionOptions,
          readRepeatPosition(script),
          readRepeatRawMatch(script),
          (match, input) => resolveRepeatedMatchReplacement(
            script,
            match,
            input,
            macroEnv,
            resolvedTemplates,
            executionOptions,
          ),
        );
        if (applied.handled) {
          result = applied.content;
          result = applyTrimStrings(result, script.trim_strings, options);
          assertRegexTextBytes(result, REGEX_LIMITS_V1.maxOutputBytes, "output_limit_exceeded", "Regex output");
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
            sandboxOptions,
          )
        : [];

      if (macroEnv && script.substitute_macros === "raw") {
        const matches: SandboxCaptureReplacement[] = await regexCaptureReplacementsSandboxed(
          findRegex,
          script.flags,
          result,
          script.replace_string,
          REGEX_SCRIPT_TIMEOUT_MS,
          sandboxOptions,
        );
        if (matches.length > 0) {
          const replacements: string[] = [];
          for (const match of matches) {
            throwIfRegexAborted(options?.signal, options?.deadlineAt);
            const evalResult = await evaluateRegexMacroWithBudget(
              match.replacement,
              macroEnv,
              expansionBudget,
              macroOptions,
            );
            foldFingerprint(options?.outFingerprint, evalResult);
            replacements.push(evalResult.text);
          }
          result = rebuildFromMatches(
            result,
            matches,
            actionCapture
              ? decorateRegexActionReplacements(replacements, actionMatches, actionCapture.unpack, script.id)
              : replacements,
            expansionBudget,
            false,
          );
        }
      } else if (macroEnv && script.substitute_macros === "after") {
        const matches = await regexNativeCaptureReplacementsSandboxed(
          findRegex,
          script.flags,
          result,
          script.replace_string,
          REGEX_SCRIPT_TIMEOUT_MS,
          sandboxOptions,
        );
        const replacements = matches.map((match) => match.replacement);
        const substituted = rebuildFromMatches(
          result,
          matches,
          actionCapture
            ? decorateRegexActionReplacements(replacements, actionMatches, actionCapture.unpack, script.id)
            : replacements,
          expansionBudget,
        );
        const evalResult = await evaluateRegexMacroWithBudget(substituted, macroEnv, expansionBudget, macroOptions);
        foldFingerprint(options?.outFingerprint, evalResult);
        reserveRegexGrowth(substituted, evalResult.text, expansionBudget);
        result = evalResult.text;
      } else {
        let replaceString = script.replace_string;
        const originalReplacement = replaceString;
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
            expansionBudget,
            macroOptions,
          );
          reserveRegexGrowth(originalReplacement, replaceString, expansionBudget);
        }
        const matches = await regexNativeCaptureReplacementsSandboxed(
          findRegex,
          script.flags,
          result,
          replaceString,
          REGEX_SCRIPT_TIMEOUT_MS,
          sandboxOptions,
        );
        result = rebuildFromMatches(
          result,
          matches,
          actionCapture
            ? decorateRegexActionReplacements(
              matches.map((match) => match.replacement),
              actionMatches,
              actionCapture.unpack,
              script.id,
            )
            : matches.map((match) => match.replacement),
          expansionBudget,
        );
      }

      result = applyTrimStrings(result, script.trim_strings, options);
      assertRegexTextBytes(result, REGEX_LIMITS_V1.maxOutputBytes, "output_limit_exceeded", "Regex output");

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
          existingPerformance
          && existingPerformance.version === script.updated_at
          && performanceSourcesMatch(existingPerformance.source, source)
          && elapsedMs < existingPerformance.threshold_ms
        ) {
          reportRegexScriptPerformance(script.user_id, script.id, {
            elapsedMs,
            thresholdMs: existingPerformance.threshold_ms,
            source,
          });
        }
      }
    } catch (error) {
      if (options?.outFingerprint) options.outFingerprint.cacheable = false;
      if (error instanceof RegexTimeoutError) {
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
        throw error;
      }
      if (
        error instanceof RegexLimitError
        || error instanceof RegexCancelledError
        || error instanceof RegexDeadlineError
        || error instanceof RegexSandboxError
      ) {
        throw error;
      }
      throw error;
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
      const evaluated = await evaluateRegexMacroWithBudget(
        replacement,
        macroEnv,
        options?.expansionBudget,
        macroOptions,
      );
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
        options?.expansionBudget,
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
  const sandboxOptions: RegexSandboxOptions = {
    userId: options?.userId ?? "regex-host",
    signal: options?.signal,
    deadlineAt: options?.deadlineAt,
    maxMatches: REGEX_LIMITS_V1.maxMatchCount,
    maxExpansionBytes: options?.expansionBudget?.remainingBytes() ?? REGEX_LIMITS_V1.maxExpansionBytes,
    maxOutputBytes: REGEX_LIMITS_V1.maxOutputBytes,
    maxOperationBytes: REGEX_LIMITS_V1.maxOperationBytes,
  };
  const matches = await regexCollectSandboxed(
    pattern,
    effectiveFlags,
    content,
    REGEX_SCRIPT_TIMEOUT_MS,
    sandboxOptions,
  );
  if (matches.length === 0) {
    if (
      !actions.has("repeat_back")
      || options?.previousContent === undefined
    ) return { handled: true, content };
    throwIfRegexAborted(options?.signal, options?.deadlineAt);
    const prior = await regexCollectSandboxed(
      pattern,
      effectiveFlags,
      options.previousContent,
      REGEX_SCRIPT_TIMEOUT_MS,
      sandboxOptions,
    );
    if (prior.length === 0) return { handled: true, content };
    const piece = repeatRawMatch || !resolveRepeatedMatch
      ? prior[0]!.fullMatch
      : await resolveRepeatedMatch(prior[0]!, options.previousContent);
    const pieceBytes = utf8ByteLength(piece);
    if (pieceBytes > REGEX_LIMITS_V1.maxOperationBytes) {
      throw new RegexLimitError("operation_limit_exceeded", "Regex repeat output exceeds its operation byte limit");
    }
    options?.expansionBudget?.reserve(pieceBytes);
    const firstSpace = replacement.indexOf(" ");
    const secondSpace = firstSpace < 0 ? -1 : replacement.indexOf(" ", firstSpace + 1);
    const position = repeatPosition ?? (
      firstSpace < 0
        ? undefined
        : replacement.slice(firstSpace + 1, secondSpace < 0 ? replacement.length : secondSpace)
    );
    const separatorBytes = position === "end_nl" || position === "start_nl" ? utf8ByteLength("\n") : 0;
    const nextBytes = utf8ByteLength(content) + pieceBytes + separatorBytes;
    if (nextBytes > REGEX_LIMITS_V1.maxOutputBytes) {
      throw new RegexLimitError("output_limit_exceeded", `Regex output exceeded ${REGEX_LIMITS_V1.maxOutputBytes} bytes`);
    }
    const next = !position || position === "end"
      ? content + piece
      : position === "start"
        ? piece + content
        : position === "end_nl"
          ? `${content}\n${piece}`
          : position === "start_nl"
            ? `${piece}\n${content}`
            : content;
    return { handled: true, content: next };

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
    const movedBytes = utf8ByteLength(moved);
    if (movedBytes > REGEX_LIMITS_V1.maxOperationBytes) {
      throw new RegexLimitError("operation_limit_exceeded", "Regex move output exceeds its operation byte limit");
    }
    const remainderBytes = utf8ByteLength(content)
      - utf8ByteLength(content.slice(match.index, match.index + match.fullMatch.length));
    const movedOutputBytes = remainderBytes + movedBytes + utf8ByteLength("\n");
    if (movedOutputBytes > REGEX_LIMITS_V1.maxOutputBytes) {
      throw new RegexLimitError("output_limit_exceeded", `Regex output exceeded ${REGEX_LIMITS_V1.maxOutputBytes} bytes`);
    }
    options?.expansionBudget?.reserve(movedBytes);
    const remainder = rebuildFromMatches(
      content,
      [{ index: match.index, matchLength: match.fullMatch.length }],
      [""],
      options?.expansionBudget,
    );
    const movedOutput = movesTop ? `${moved}\n${remainder}` : `${remainder}\n${moved}`;
    return {
      handled: true,
      content: movedOutput,
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
): Promise<{ result: string; matches: number; error?: string; error_code?: RegexValidationErrorCode }> {
  if (typeof findRegex !== "string" || findRegex.length === 0) {
    return { result: content, matches: 0, error: "find_regex must be a non-empty string", error_code: "invalid_input" };
  }
  if (typeof replaceString !== "string" || typeof flags !== "string" || typeof content !== "string") {
    return { result: typeof content === "string" ? content : "", matches: 0, error: "Regex test fields must be strings", error_code: "invalid_input" };
  }
  const patternFailure = validateRegex(findRegex, flags, "none");
  if (patternFailure) {
    return { result: content, matches: 0, error: patternFailure.message, error_code: patternFailure.code };
  }
  const contentFailure = validateText(content, REGEX_LIMITS_V1.maxInputBytes, "invalid_input", "Regex input");
  if (contentFailure) {
    return { result: content, matches: 0, error: contentFailure.message, error_code: contentFailure.code };
  }
  const replacementFailure = validateText(
    replaceString,
    REGEX_LIMITS_V1.maxReplacementBytes,
    "replacement_too_large",
    "Regex replacement",
  );
  if (replacementFailure) {
    return { result: content, matches: 0, error: replacementFailure.message, error_code: replacementFailure.code };
  }

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
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Regex error";
    if (error instanceof RegexTimeoutError) {
      return { result: content, matches: 0, error: message, error_code: "worker_timed_out" };
    }
    if (error instanceof RegexLimitError) {
      return { result: content, matches: 0, error: message, error_code: error.code };
    }
    if (error instanceof RegexCancelledError) {
      return { result: content, matches: 0, error: message, error_code: "cancelled" };
    }
    if (error instanceof RegexDeadlineError) {
      return { result: content, matches: 0, error: message, error_code: "deadline_exceeded" };
    }
    if (error instanceof RegexSandboxError) {
      return { result: content, matches: 0, error: message, error_code: error.code };
    }
    return { result: content, matches: 0, error: message, error_code: "invalid_input" };
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
  if (!remotePresetId) return { archivedIds: [], replacedIds: [] };

  const acceptedRemoteIds = new Set([remotePresetId, previousRemotePresetId].filter((id): id is string => !!id));
  const preserveIds = new Set(options.preserveIds ?? []);
  const rows = getRegexScriptsByPresetId(userId, options.presetId);
  const matching = rows.flatMap((script) => {
    if (preserveIds.has(script.id)) return [];
    const attribution = getRemotePresetRegexAttribution(script.metadata, options.source);
    if (attribution?.id && !acceptedRemoteIds.has(attribution.id)) return [];

    // Rows from installations predating explicit per-regex attribution are
    // still attributable through their preset_id, but only when the containing
    // preset was already a tracked installation from the same remote source.
    if (!attribution?.id && !previousRemotePresetId) return [];
    const version = attribution?.version ?? previousVersion;
    return [{
      script,
      version,
      folderName: getRemotePresetSourceFolder(script, attribution, options.presetName, version, options.source),
    }];
  });

  const replaced = matching.filter(({ version }) => version === incomingVersion);
  const archived = matching.filter(({ version }) => version !== incomingVersion);
  const replacedIds = replaced.map(({ script }) => script.id);
  const archivedIds = archived.map(({ script }) => script.id);
  const replaceIdSet = new Set(replacedIds);
  const archiveGroups = new Map<string, { version: string | null; folderName: string; ids: Set<string> }>();
  const archiveKey = (version: string | null, folderName: string) => `${version ?? ""}\u0000${folderName}`;
  for (const { script, version, folderName } of archived) {
    const key = archiveKey(version, folderName);
    const group = archiveGroups.get(key) ?? { version, folderName, ids: new Set<string>() };
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
    for (const { script, version, folderName } of archived) {
      const metadata = isPlainMetadataRecord(script.metadata) ? { ...script.metadata } : {};
      metadata[remotePresetMetadataKey(options.source)] = { id: remotePresetId, version, folderName };
      updateRow.run(
        foldersByArchiveKey.get(archiveKey(version, folderName))!,
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
  scripts: any[];
  previous?: {
    assetId?: string | null;
    version?: string | null;
    presetName?: string | null;
  } | null;
}

interface InstallRemotePresetRegexOptions {
  source: RemotePresetRegexSource;
  presetId: string;
  presetName: string;
  remotePresetId: string;
  presetVersion?: string | null;
  scripts: any[];
  previous?: {
    remotePresetId?: string | null;
    version?: string | null;
    presetName?: string | null;
  } | null;
}

/**
 * Stage a remote preset's regex payload before retiring the previous version. A partial
 * import is removed and the old restore-list is reinstated, leaving the prior
 * working set untouched.
 */
function installRemotePresetRegexScriptsInTransaction(
  userId: string,
  options: InstallRemotePresetRegexOptions,
): { imported: number; archived: number; replaced: number; folder: string | null } {
  const previousRestore = readStoredPresetRegexIdsRecord(userId, options.presetId);
  const presetAuthorityBatch = new Set<string>();
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
        },
        { presetAuthorityBatch },
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
          presetName: normalizeOptionalId(options.previous.presetName) ?? options.presetName,
          preserveIds: newIds,
        })
      : { archivedIds: [], replacedIds: [] };

    if (retired.archivedIds.length > 0 || retired.replacedIds.length > 0) {
      presetAuthorityBatch.add(options.presetId);
    }
    advancePresetRegexAuthoritiesWithDb(getDb(), userId, presetAuthorityBatch);
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
    if (newIds.length > 0) deleteRegexScripts(userId, newIds, { suppressPresetAuthorityMutation: true });
    if (previousRestore.exists) {
      writeStoredPresetRegexIdsWithDb(getDb(), userId, options.presetId, previousRestore.ids);
    } else {
      deleteStoredPresetRegexIds(userId, options.presetId);
    }
    throw error;
  }
}
function installRemotePresetRegexScripts(
  userId: string,
  options: InstallRemotePresetRegexOptions,
): { imported: number; archived: number; replaced: number; folder: string | null } {
  const db = getDb();
  const authorityBefore = captureRegexPresetAuthorities(userId);
  const buffered = eventBus.withBufferedEvents(() => {
    const value = db.transaction(() => installRemotePresetRegexScriptsInTransaction(userId, options))();
    resolveRegexPresetAuthorities(userId, authorityBefore);
    return value;
  });
  for (const event of buffered.events) {
    eventBus.emit(event.event, event.payload, event.userId, event.options);
  }
  return buffered.value;
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
    scripts: options.scripts,
    previous: options.previous ? {
      remotePresetId: options.previous.assetId,
      version: options.previous.version,
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
): { imported: number; skipped: number; errors: string[]; presetAuthorityChanged?: boolean } {
  if (!context?.presetAuthorityBatch) {
    const db = getDb();
    const presetAuthorityBatch = new Set<string>();
    const buffered = eventBus.withBufferedEvents(() => db.transaction(() => {
      const result = importRegexScripts(userId, payload, { ...context, presetAuthorityBatch });
      const advanced = context?.suppressPresetAuthorityMutation
        ? new Set<string>()
        : advancePresetRegexAuthoritiesWithDb(db, userId, presetAuthorityBatch);
      return { ...result, presetAuthorityChanged: advanced.size > 0 };
    })());
    for (const event of buffered.events) {
      eventBus.emit(event.event, event.payload, event.userId, event.options);
    }
    return buffered.value;
  }
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
  const importContext: RegexMutationContext = {
    ...context,
    foreignImport: context?.foreignImport ?? true,
  };

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
    const result = createRegexScript(userId, item, importContext);
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

      const overwritten = updateRegexScript(userId, existing.id, updates, importContext);
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
      }, bundleSource), { foreignImport: true });
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
  context?: RegexMutationContext,
): { imported: number; skipped: number } {
  if (!Array.isArray(scripts) || scripts.length === 0) {
    return { imported: 0, skipped: 0 };
  }
  if (!context?.presetAuthorityBatch) {
    const db = getDb();
    const presetAuthorityBatch = new Set<string>();
    const buffered = eventBus.withBufferedEvents(() => db.transaction(() => {
      const result = importPresetBoundRegexScripts(
        userId,
        presetId,
        presetName,
        scripts,
        attribution,
        { ...context, presetAuthorityBatch },
      );
      if (!context?.suppressPresetAuthorityMutation) {
        advancePresetRegexAuthoritiesWithDb(db, userId, presetAuthorityBatch);
      }
      return result;
    })());
    for (const event of buffered.events) {
      eventBus.emit(event.event, event.payload, event.userId, event.options);
    }
    return buffered.value;
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
    }, {
      foreignImport: false,
      presetAuthorityBatch: context.presetAuthorityBatch,
      suppressPresetAuthorityMutation: context.suppressPresetAuthorityMutation,
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

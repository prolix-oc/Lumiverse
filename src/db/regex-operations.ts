import type { Database } from "bun:sqlite";

export interface RegexDeletionContext {
  extensionIdentifier?: string;
  allowUnownedMutation?: boolean;
}
export const EXTENSION_REGEX_OWNERSHIP_ERROR = "Regex script is not an unbound script owned by this extension";

function removeFromRestoreLists(db: Database, userId: string, rows: Array<{ id: string; preset_id: string | null; owner_extension_identifier: string | null }>): void {
  const byPreset = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.preset_id || row.owner_extension_identifier != null) continue;
    const ids = byPreset.get(row.preset_id) ?? new Set<string>();
    ids.add(row.id);
    byPreset.set(row.preset_id, ids);
  }
  for (const [presetId, removed] of byPreset) {
    const key = `presetRegexEnabled:${presetId}`;
    const row = db.query("SELECT value FROM settings WHERE key = ? AND user_id = ?").get(key, userId) as { value: string } | null;
    let ids: string[] = [];
    try {
      const value = JSON.parse(row?.value ?? "[]");
      if (Array.isArray(value)) ids = [...new Set(value.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))];
    } catch { /* Preserve normalization of malformed legacy restore lists. */ }
    db.query(`INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(key, JSON.stringify(ids.filter((id) => !removed.has(id))), userId, Math.floor(Date.now() / 1000));
  }
}

export function deleteRegexScriptsWithDb(db: Database, userId: string, ids: string[], context?: RegexDeletionContext): { deleted: string[]; denied: boolean } {
  return db.transaction(() => {
    const rows: Array<{ id: string; preset_id: string | null; owner_extension_identifier: string | null }> = [];
    const uniqueIds = [...new Set(ids)];
    for (let i = 0; i < uniqueIds.length; i += 400) {
      const chunk = uniqueIds.slice(i, i + 400);
      rows.push(...db.query(`SELECT id, preset_id, owner_extension_identifier FROM regex_scripts WHERE user_id = ? AND id IN (${chunk.map(() => "?").join(",")})`).all(userId, ...chunk) as typeof rows);
    }
    const extension = context?.extensionIdentifier?.trim();
    if (extension && !context?.allowUnownedMutation && rows.some((row) => row.owner_extension_identifier !== extension)) return { deleted: [], denied: true };
    for (const row of rows) db.query("DELETE FROM regex_scripts WHERE id = ? AND user_id = ?").run(row.id, userId);
    removeFromRestoreLists(db, userId, rows);
    return { deleted: rows.map((row) => row.id), denied: false };
  }).immediate();
}

export function deletePresetRegexScriptsWithDb(db: Database, userId: string, presetId: string): string[] {
  const rows = db.query("SELECT id FROM regex_scripts WHERE user_id = ? AND preset_id = ?").all(userId, presetId) as Array<{ id: string }>;
  db.query("DELETE FROM regex_scripts WHERE user_id = ? AND preset_id = ?").run(userId, presetId);
  db.query("DELETE FROM settings WHERE key = ? AND user_id = ?").run(`presetRegexEnabled:${presetId}`, userId);
  return rows.map((row) => row.id);
}

import { EventType } from "../ws/events";
import type { RegexScript, CreateRegexScriptInput, UpdateRegexScriptInput, RegexTarget, RegexAction, RegexActionEffect } from "../types/regex-script";
import { readPromptActivation, validatePromptActivation } from "../utils/regex-prompt-activation";
import { activationPatternForValidation } from "../utils/regex-activation-inputs";
import type { PromptBlock } from "../types/preset";
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

interface SpindleExtensionRegexAttribution {
  identifier: string;
  version: string;
}

type RegexToggleRow = {
  id: string;
  preset_id?: string | null;
  owner_extension_identifier?: string | null;
  disabled: number;
};
function createRegexScript(db: Database, events: RegexDatabaseEvent[],
  userId: string,
  input: CreateRegexScriptInput,
  context?: RegexMutationContext,
): RegexScript | string {
  const extensionIdentifier = normalizeOptionalId(context?.extensionIdentifier);
  // Pack and character links stay host-owned. A preset link is the one binding an
  // extension may install itself: it owns the row, so the host's preset-delete
  // cascade must be able to reap it. The link is same-user-validated here and is
  // treated as lifecycle-only — preset activation leaves extension-owned rows to
  // their own `disabled` state (see applyPresetBoundActivationWithDb).
  let nextInput: CreateRegexScriptInput = extensionIdentifier
    ? { ...input, pack_id: null, character_id: null }
    : { ...input };
  if (extensionIdentifier) {
    const rawPresetId = nextInput.preset_id;
    // A silently-dropped link would leave the caller believing its row cascades
    // with a preset it was never bound to, so a malformed value is rejected.
    if (rawPresetId !== undefined && rawPresetId !== null && typeof rawPresetId !== "string") {
      return "preset_id must be a string or null";
    }
    const presetId = normalizeOptionalId(rawPresetId);
    nextInput.preset_id = presetId;
    if (presetId) {
      const presetError = validateOwnedPresetLink(db, userId, presetId);
      if (presetError) return presetError;
    }
  }
  if (extensionIdentifier && context) {
    const folderVersionError = validateExtensionFolderVersion(context);
    if (folderVersionError) return folderVersionError;
    nextInput = applySpindleExtensionRegexAttribution(nextInput, extensionIdentifier, context);
  }
  const err = validateInput(nextInput, true);
  if (err) return err;
  const activationError = validatePromptActivationBinding(db, userId, nextInput);
  if (activationError) return activationError;

  const regexErr = validateRegex(nextInput.find_regex, nextInput.flags ?? "gi", nextInput.substitute_macros ?? "none", !!readPromptActivation(nextInput.metadata));
  if (regexErr) return regexErr;

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const activePresetId = normalizeOptionalId(context?.activePresetId);
  const disabled = resolveCreateDisabledState(nextInput, activePresetId, !extensionIdentifier);

  try {
    db
      .query(
        `INSERT INTO regex_scripts (id, user_id, name, script_id, find_regex, replace_string, actions, flags, placement, scope, scope_id, target, min_depth, max_depth, trim_strings, run_on_edit, substitute_macros, disabled, sort_order, description, folder, pack_id, preset_id, character_id, owner_extension_identifier, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        userId,
        nextInput.name.trim(),
        nextInput.script_id ?? "",
        nextInput.find_regex,
        nextInput.replace_string ?? "",
        JSON.stringify(nextInput.actions ?? []),
        nextInput.flags ?? "gi",
        JSON.stringify(nextInput.placement ?? ["ai_output"]),
        nextInput.scope ?? "global",
        nextInput.scope === "global" || !nextInput.scope ? null : (nextInput.scope_id ?? null),
        JSON.stringify(nextInput.target ?? ["response"]),
        nextInput.min_depth ?? null,
        nextInput.max_depth ?? null,
        JSON.stringify(nextInput.trim_strings ?? []),
        nextInput.run_on_edit ? 1 : 0,
        nextInput.substitute_macros ?? "none",
        disabled ? 1 : 0,
        nextInput.sort_order ?? 0,
        nextInput.description ?? "",
        nextInput.folder ?? "",
        nextInput.pack_id ?? null,
        nextInput.preset_id ?? null,
        nextInput.character_id ?? null,
        extensionIdentifier,
        JSON.stringify(nextInput.metadata ?? {}),
        now,
        now
      );
  } catch (err) {
    const mapped = mapRegexScriptPersistenceError(err);
    if (mapped) return mapped;
    throw err;
  }

  const script = getRegexScript(db, userId, id)!;
  if (!extensionIdentifier && script.preset_id && script.preset_id === activePresetId) {
    setPresetBoundScriptEnabledInRestoreList(db, userId, script.preset_id, script.id, !script.disabled);
  }
  events.push({ type: EventType.REGEX_SCRIPT_CHANGED, payload: { id, script } });
  return script;
}

function normalizeOptionalId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateOwnedPresetLink(db: Database, userId: string, presetId: string): string | null {
  const preset = db.query("SELECT 1 AS found FROM presets WHERE id = ? AND user_id = ?")
    .get(presetId, userId);
  return preset ? null : "Linked preset not found";
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

function isPlainMetadataRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getSpindleExtensionRegexAttribution(metadata: unknown): SpindleExtensionRegexAttribution | null {
  if (!isPlainMetadataRecord(metadata)) return null;
  const raw = metadata[SPINDLE_EXTENSION_REGEX_METADATA_KEY];
  if (!isPlainMetadataRecord(raw)) return null;
  const identifier = normalizeOptionalId(raw.identifier);
  const version = normalizeOptionalId(raw.version);
  return identifier && version ? { identifier, version } : null;
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

function normalizeRegexActions(value: unknown): RegexAction[] {
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

function normalizeScriptId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function validatePromptActivationBinding(db: Database, userId: string, input: CreateRegexScriptInput): string | null {
  const raw = input.metadata?.prompt_activation;
  const error = validatePromptActivation(raw);
  if (error || raw == null) return error;
  if (typeof input.preset_id !== "string" || !input.preset_id.trim() || input.preset_id.length > 200) return "Prompt activation requires a linked preset";
  const preset = db.query("SELECT prompt_order FROM presets WHERE id = ? AND user_id = ?")
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

function hasMacroSyntax(pattern: string): boolean {
  return pattern.includes("{{") || pattern.includes("<USER>") || pattern.includes("<BOT>") || pattern.includes("<CHAR>");
}

function sanitizeRegexPatternForValidation(pattern: string): string {
  return pattern
    .replace(/\{\{[\s\S]*?\}\}/g, "x")
    .replace(/<USER>|<BOT>|<CHAR>/g, "x");
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

function getRegexScript(db: Database, userId: string, id: string): RegexScript | null { const row = db.query("SELECT * FROM regex_scripts WHERE id = ? AND user_id = ?").get(id, userId); return row ? rowToRegexScript(row) : null; }

function setPresetBoundScriptEnabledInRestoreList(db: Database,
  userId: string,
  presetId: string,
  scriptId: string,
  enabled: boolean,
): void {
  updateStoredPresetRegexIds(db, userId, presetId, (current) => {
    const next = new Set(current);
    if (enabled) next.add(scriptId);
    else next.delete(scriptId);
    return [...next];
  });
}

function updateStoredPresetRegexIds(db: Database,
  userId: string,
  presetId: string,
  updater: (ids: string[]) => string[],
): void {
  const current = readStoredPresetRegexIdsRecord(db, userId, presetId).ids;
  writeStoredPresetRegexIdsWithDb(db, userId, presetId, updater(current));
}

function readStoredPresetRegexIdsRecord(db: Database, userId: string, presetId: string): { exists: boolean; ids: string[] } {
  const row = db
    .query("SELECT value FROM settings WHERE key = ? AND user_id = ?")
    .get(getPresetRegexSettingKey(presetId), userId) as { value?: string } | undefined;
  if (!row) return { exists: false, ids: [] };

  try {
    return { exists: true, ids: normalizeStoredPresetRegexIds(JSON.parse(row.value ?? "[]")) };
  } catch {
    return { exists: true, ids: [] };
  }
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

function writeStoredPresetRegexIdsWithDb(db: Database, userId: string, presetId: string, ids: string[]): void {
  const now = Math.floor(Date.now() / 1000);
  db
    .query(
      `INSERT INTO settings (key, value, user_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .run(getPresetRegexSettingKey(presetId), JSON.stringify(normalizeStoredPresetRegexIds(ids)), userId, now);
}

function updateRegexScript(db: Database, events: RegexDatabaseEvent[],
  userId: string,
  id: string,
  input: UpdateRegexScriptInput,
  context?: RegexMutationContext,
): RegexScript | string | null {
  const existing = getRegexScript(db, userId, id);
  if (!existing) return null;

  const extensionIdentifier = normalizeOptionalId(context?.extensionIdentifier);
  // Ownership, not the preset link, decides mutability: a row this extension
  // owns stays editable after it is bound to a preset.
  const ownsRow = !!extensionIdentifier && existing.owner_extension_identifier === extensionIdentifier;
  const presetActivationManaged = existing.owner_extension_identifier == null;
  if (extensionIdentifier && !ownsRow && !context?.allowUnownedMutation) {
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
    // Pack and character links are host-owned. A preset link is installed at
    // creation only: an owner may edit the row it is attached to, but never
    // re-points or clears the binding here.
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

  if (isPresetBound && nextInput.disabled !== undefined && nextPresetId && !mayPersistPresetEnablement && presetActivationManaged) {
    // The preset's own enable snapshot owns host rows; an extension-owned row is
    // outside that snapshot, so its owner keeps control of `disabled`.
    delete nextInput.disabled;
  }
  if (nextPresetId && nextPresetId !== activePresetId && hasPresetIdUpdate && presetActivationManaged) {
    nextInput.disabled = true;
  }

  // If updating regex or flags, validate together
  if (nextInput.find_regex !== undefined || nextInput.flags !== undefined || nextInput.substitute_macros !== undefined) {
    const pattern = nextInput.find_regex ?? existing.find_regex;
    const flags = nextInput.flags ?? existing.flags;
    const substituteMacros = nextInput.substitute_macros ?? existing.substitute_macros;
    const regexErr = validateRegex(pattern, flags, substituteMacros, !!nextPresetId && !!readPromptActivation(nextInput.metadata ?? existing.metadata));
    if (regexErr) return regexErr;
  }

  const err = validateInput(nextInput, false);
  if (err) return err;

  // Unlinking removes the preset-only capability. Other edits cannot install it unbound.
  if (hasPresetIdUpdate && !nextPresetId) {
    nextInput.metadata = { ...(nextInput.metadata ?? existing.metadata) };
    delete nextInput.metadata.prompt_activation;
  }
  const activationError = validatePromptActivationBinding(db, userId, { ...existing, ...nextInput, preset_id: nextPresetId });
  if (activationError) return activationError;

  const fields: string[] = [];
  const values: any[] = [];

  if (nextInput.name !== undefined) { fields.push("name = ?"); values.push(nextInput.name.trim()); }
  if (nextInput.script_id !== undefined) { fields.push("script_id = ?"); values.push(nextInput.script_id); }
  if (nextInput.find_regex !== undefined) { fields.push("find_regex = ?"); values.push(nextInput.find_regex); }
  if (nextInput.replace_string !== undefined) { fields.push("replace_string = ?"); values.push(nextInput.replace_string); }
  if (nextInput.actions !== undefined) { fields.push("actions = ?"); values.push(JSON.stringify(nextInput.actions)); }
  if (nextInput.flags !== undefined) { fields.push("flags = ?"); values.push(nextInput.flags); }
  if (nextInput.placement !== undefined) { fields.push("placement = ?"); values.push(JSON.stringify(nextInput.placement)); }
  if (nextInput.scope !== undefined) { fields.push("scope = ?"); values.push(nextInput.scope); }
  if (nextInput.scope_id !== undefined) { fields.push("scope_id = ?"); values.push(nextInput.scope_id); }
  if (nextInput.target !== undefined) { fields.push("target = ?"); values.push(JSON.stringify(nextInput.target)); }
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

  try {
    db.query(`UPDATE regex_scripts SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  } catch (err) {
    const mapped = mapRegexScriptPersistenceError(err);
    if (mapped) return mapped;
    throw err;
  }

  const updated = getRegexScript(db, userId, id)!;
  if (presetActivationManaged && existing.preset_id && existing.preset_id !== updated.preset_id) {
    setPresetBoundScriptEnabledInRestoreList(db, userId, existing.preset_id, updated.id, false);
  }
  if (presetActivationManaged && updated.preset_id && (hasPresetIdUpdate || (mayPersistPresetEnablement && nextInput.disabled !== undefined))) {
    setPresetBoundScriptEnabledInRestoreList(db, userId, updated.preset_id, updated.id, !updated.disabled);
  }
  events.push({ type: EventType.REGEX_SCRIPT_CHANGED, payload: { id, script: updated } });
  return updated;
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

function withoutRegexPerformanceMetadata(metadata: Record<string, any> | null | undefined): Record<string, any> {
  if (!metadata || typeof metadata !== "object") return {};
  const next = { ...metadata };
  delete next.regex_performance;
  return next;
}

function duplicateRegexScript(db: Database, events: RegexDatabaseEvent[], userId: string, id: string): RegexScript | null {
  const existing = getRegexScript(db, userId, id);
  if (!existing) return null;

  const newId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const metadata = { ...existing.metadata };
  delete metadata.prompt_activation; // Duplicates are unbound.

  db
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
      JSON.stringify(metadata),
      now,
      now
    );

  const script = getRegexScript(db, userId, newId)!;
  events.push({ type: EventType.REGEX_SCRIPT_CHANGED, payload: { id: newId, script } });
  return script;
}

function toggleRegexScript(db: Database, events: RegexDatabaseEvent[],
  userId: string,
  id: string,
  disabled: boolean,
  context?: RegexMutationContext,
): RegexScript | null {
  const existing = getRegexScript(db, userId, id);
  if (!existing) return null;

  const activePresetId = normalizeOptionalId(context?.activePresetId);
  const presetActivationManaged = existing.owner_extension_identifier == null;
  if (presetActivationManaged && existing.preset_id && existing.preset_id !== activePresetId) {
    return existing;
  }

  db
    .query("UPDATE regex_scripts SET disabled = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .run(disabled ? 1 : 0, Math.floor(Date.now() / 1000), id, userId);

  const updated = getRegexScript(db, userId, id)!;
  if (presetActivationManaged && updated.preset_id) {
    setPresetBoundScriptEnabledInRestoreList(db, userId, updated.preset_id, updated.id, !updated.disabled);
  }
  events.push({ type: EventType.REGEX_SCRIPT_CHANGED, payload: { id, script: updated } });
  return updated;
}

function toggleRegexScriptsByIds(db: Database, events: RegexDatabaseEvent[],
  userId: string,
  ids: string[],
  disabled: boolean,
  context?: RegexMutationContext,
): { changedIds: string[]; skippedIds: string[] } {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return { changedIds: [], skippedIds: [] };

  const placeholders = uniqueIds.map(() => "?").join(", ");
  const unorderedRows = db
    .query(`SELECT id, preset_id, owner_extension_identifier, disabled FROM regex_scripts WHERE user_id = ? AND id IN (${placeholders})`)
    .all(userId, ...uniqueIds) as RegexToggleRow[];
  const rowsById = new Map(unorderedRows.map((row) => [row.id, row]));
  const rows = uniqueIds.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [row] : [];
  });

  return toggleRegexScriptRows(db, events, userId, rows, disabled, normalizeOptionalId(context?.activePresetId));
}

function toggleRegexScriptRows(db: Database, events: RegexDatabaseEvent[],
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
      setPresetBoundScriptEnabledInRestoreList(db, userId, target.preset_id, target.id, !disabled);
    }
    const updated = getRegexScript(db, userId, target.id);
    if (updated) {
      events.push({ type: EventType.REGEX_SCRIPT_CHANGED, payload: { id: target.id, script: updated } });
    }
  }

  return { changedIds, skippedIds };
}

function toggleRegexScriptsByFolder(db: Database, events: RegexDatabaseEvent[],
  userId: string,
  folder: string,
  disabled: boolean,
  context?: RegexMutationContext,
): { changedIds: string[]; skippedIds: string[] } {
  const activePresetId = normalizeOptionalId(context?.activePresetId);
  const rows = db
    .query("SELECT id, preset_id, owner_extension_identifier, disabled FROM regex_scripts WHERE user_id = ? AND folder = ?")
    .all(userId, folder) as RegexToggleRow[];

  return toggleRegexScriptRows(db, events, userId, rows, disabled, activePresetId);
}

function reorderRegexScripts(db: Database, userId: string, orderedIds: string[]): boolean {
  const txn = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      db.query("UPDATE regex_scripts SET sort_order = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(i, Math.floor(Date.now() / 1000), orderedIds[i], userId);
    }
  });
  txn();
  return true;
}

function rowToRegexScript(row: any): RegexScript {
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
export interface RegexDatabaseEvent { type: EventType; payload: any }
const mutations = { createRegexScript, updateRegexScript, duplicateRegexScript, toggleRegexScript, toggleRegexScriptsByIds, toggleRegexScriptsByFolder, reorderRegexScripts };
type MutationArguments<F> = F extends (db: Database, events: RegexDatabaseEvent[], ...args: infer A) => unknown ? A : F extends (db: Database, ...args: infer A) => unknown ? A : never;
export type RegexMutation = { [K in keyof typeof mutations]: { action: K; args: MutationArguments<(typeof mutations)[K]> } }[keyof typeof mutations];
export interface RegexMutationResult { value: unknown; events: RegexDatabaseEvent[] }
export function mutateRegexWithDb(db: Database, mutation: RegexMutation): RegexMutationResult {
  return db.transaction(() => {
    const events: RegexDatabaseEvent[] = [];
    let value: unknown;
    switch (mutation.action) {
      case "createRegexScript": value = createRegexScript(db, events, ...mutation.args); break;
      case "updateRegexScript": value = updateRegexScript(db, events, ...mutation.args); break;
      case "duplicateRegexScript": value = duplicateRegexScript(db, events, ...mutation.args); break;
      case "toggleRegexScript": value = toggleRegexScript(db, events, ...mutation.args); break;
      case "toggleRegexScriptsByIds": value = toggleRegexScriptsByIds(db, events, ...mutation.args); break;
      case "toggleRegexScriptsByFolder": value = toggleRegexScriptsByFolder(db, events, ...mutation.args); break;
      case "reorderRegexScripts": value = reorderRegexScripts(db, ...mutation.args); break;
    }
    return { value, events };
  }).immediate();
}

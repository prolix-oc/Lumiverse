import type { Database } from "bun:sqlite";
import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as connectionsSvc from "./connections.service";
import * as presetsSvc from "./presets.service";
import * as personasSvc from "./personas.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { PresetProfileBinding, ResolvedPresetProfile } from "../types/preset-profile";
import type { PromptBlock, PromptVariableValues } from "../types/preset";

// ---------------------------------------------------------------------------
// Setting key conventions
// ---------------------------------------------------------------------------

const LEGACY_DEFAULTS_KEY = "presetProfileDefaults";
function defaultsKey(presetId: string): string {
  return `presetProfileDefaults:${presetId}`;
}
function characterKey(characterId: string): string {
  return `presetProfile:character:${characterId}`;
}
function personaKey(personaId: string): string {
  return `presetProfile:persona:${personaId}`;
}
function chatKey(chatId: string): string {
  return `presetProfile:chat:${chatId}`;
}
function connectionKey(connectionId: string): string {
  return `presetProfile:connection:${connectionId}`;
}
function defaultsVariablesKey(presetId: string): string {
  return `presetProfileVariables:defaults:${presetId}`;
}
function variablesKey(scope: "chat" | "persona" | "character" | "connection", id: string): string {
  return `presetProfileVariables:${scope}:${id}`;
}

/**
 * Profile bindings happen to be stored in the settings table, but they are
 * not app settings. Broadcasting SETTINGS_UPDATED makes clients reload the
 * globally selected preset, which can race and undo a chat-bound selection.
 */
function putProfileBinding(userId: string, key: string, binding: PresetProfileBinding): void {
  settingsSvc.putSetting(userId, key, binding, { suppressBroadcast: true });
  eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key, binding }, userId);
}

function getProfilePromptVariables(
  userId: string,
  key: string,
  legacyBinding: PresetProfileBinding,
): PromptVariableValues | undefined {
  const stored = settingsSvc.getSetting(userId, key)?.value;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    return stored as PromptVariableValues;
  }
  return legacyBinding.prompt_variables;
}

function withProfilePromptVariables(
  userId: string,
  binding: PresetProfileBinding,
  key: string,
): PresetProfileBinding {
  const promptVariables = getProfilePromptVariables(userId, key, binding);
  return promptVariables ? { ...binding, prompt_variables: promptVariables } : binding;
}

function replaceProfilePromptVariables(
  userId: string,
  key: string,
  promptVariables: PromptVariableValues | undefined,
): void {
  if (promptVariables) {
    settingsSvc.putSetting(userId, key, promptVariables, { suppressBroadcast: true });
    eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key, promptVariables }, userId);
  } else {
    settingsSvc.deleteSetting(userId, key);
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function getDefaults(userId: string, presetId: string): PresetProfileBinding | null {
  const current = getValidBinding(userId, defaultsKey(presetId));
  if (current) {
    if (current.preset_id === presetId) {
      return withProfilePromptVariables(userId, current, defaultsVariablesKey(presetId));
    }
    settingsSvc.deleteSetting(userId, defaultsKey(presetId));
  }

  // Legacy fallback: older builds stored a single shared defaults snapshot.
  const legacy = getValidBinding(userId, LEGACY_DEFAULTS_KEY);
  return legacy?.preset_id === presetId
    ? withProfilePromptVariables(userId, legacy, defaultsVariablesKey(presetId))
    : null;
}

function getDefaultsForBinding(
  userId: string,
  binding: PresetProfileBinding
): PresetProfileBinding | null {
  return getDefaults(userId, binding.preset_id);
}

function createBinding(
  presetId: string,
  blockStates: Record<string, boolean>,
  promptVariables?: PromptVariableValues,
  linkedToDefaults?: boolean
): PresetProfileBinding {
  return {
    preset_id: presetId,
    block_states: blockStates,
    ...(promptVariables ? { prompt_variables: promptVariables } : {}),
    captured_at: Math.floor(Date.now() / 1000),
    ...(linkedToDefaults ? { linked_to_defaults: true } : {}),
  };
}

function assertPresetExists(userId: string, presetId: string): void {
  if (!presetsSvc.getPreset(userId, presetId)) throw new Error("Preset not found");
}

function getValidBinding(
  userId: string,
  key: string,
): PresetProfileBinding | null {
  const s = settingsSvc.getSetting(userId, key);
  if (!s) return null;
  const binding = s.value as PresetProfileBinding;
  if (!binding?.preset_id || !presetsSvc.getPreset(userId, binding.preset_id)) {
    settingsSvc.deleteSetting(userId, key);
    return null;
  }
  return binding;
}


export function captureDefaults(
  userId: string,
  presetId: string,
  blockStates: Record<string, boolean>,
  promptVariables?: PromptVariableValues,
): PresetProfileBinding {
  assertPresetExists(userId, presetId);
  const binding = createBinding(presetId, blockStates);
  putProfileBinding(userId, defaultsKey(presetId), binding);
  replaceProfilePromptVariables(userId, defaultsVariablesKey(presetId), promptVariables);
  return withProfilePromptVariables(userId, binding, defaultsVariablesKey(presetId));
}

export function deleteDefaults(userId: string, presetId: string): boolean {
  const deleted = settingsSvc.deleteSetting(userId, defaultsKey(presetId));
  settingsSvc.deleteSetting(userId, defaultsVariablesKey(presetId));
  const legacy = settingsSvc.getSetting(userId, LEGACY_DEFAULTS_KEY);
  if (legacy && (legacy.value as PresetProfileBinding)?.preset_id === presetId) {
    settingsSvc.deleteSetting(userId, LEGACY_DEFAULTS_KEY);
    return true;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Character bindings
// ---------------------------------------------------------------------------

export function getCharacterBinding(
  userId: string,
  characterId: string
): PresetProfileBinding | null {
  const binding = getValidBinding(userId, characterKey(characterId));
  return binding ? withProfilePromptVariables(userId, binding, variablesKey("character", characterId)) : null;
}

export function setCharacterBinding(
  userId: string,
  characterId: string,
  presetId: string,
  blockStates: Record<string, boolean>,
  promptVariables?: PromptVariableValues,
): PresetProfileBinding {
  // Validate character exists
  const character = charactersSvc.getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");
  assertPresetExists(userId, presetId);

  const binding = createBinding(presetId, blockStates);
  putProfileBinding(userId, characterKey(characterId), binding);
  replaceProfilePromptVariables(userId, variablesKey("character", characterId), promptVariables);
  return withProfilePromptVariables(userId, binding, variablesKey("character", characterId));
}

export function deleteCharacterBinding(
  userId: string,
  characterId: string
): boolean {
  const deleted = settingsSvc.deleteSetting(userId, characterKey(characterId));
  settingsSvc.deleteSetting(userId, variablesKey("character", characterId));
  return deleted;
}

// ---------------------------------------------------------------------------
// Persona bindings
// ---------------------------------------------------------------------------

export function getPersonaBinding(
  userId: string,
  personaId: string,
): PresetProfileBinding | null {
  const binding = getValidBinding(userId, personaKey(personaId));
  return binding ? withProfilePromptVariables(userId, binding, variablesKey("persona", personaId)) : null;
}

export function setPersonaBinding(
  userId: string,
  personaId: string,
  presetId: string,
  blockStates: Record<string, boolean>,
  promptVariables?: PromptVariableValues,
): PresetProfileBinding {
  if (!personasSvc.getPersona(userId, personaId)) throw new Error("Persona not found");
  assertPresetExists(userId, presetId);

  const binding = createBinding(presetId, blockStates);
  putProfileBinding(userId, personaKey(personaId), binding);
  replaceProfilePromptVariables(userId, variablesKey("persona", personaId), promptVariables);
  return withProfilePromptVariables(userId, binding, variablesKey("persona", personaId));
}

export function deletePersonaBinding(userId: string, personaId: string): boolean {
  const deleted = settingsSvc.deleteSetting(userId, personaKey(personaId));
  settingsSvc.deleteSetting(userId, variablesKey("persona", personaId));
  return deleted;
}

// ---------------------------------------------------------------------------
// Chat bindings
// ---------------------------------------------------------------------------

export function getChatBinding(
  userId: string,
  chatId: string
): PresetProfileBinding | null {
  const binding = getValidBinding(userId, chatKey(chatId));
  return binding ? withProfilePromptVariables(userId, binding, variablesKey("chat", chatId)) : null;
}

export function setChatBinding(
  userId: string,
  chatId: string,
  presetId: string,
  blockStates: Record<string, boolean> | null,
  promptVariables?: PromptVariableValues,
  linkedToDefaults?: boolean
): PresetProfileBinding {
  // Validate chat exists
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) throw new Error("Chat not found");
  assertPresetExists(userId, presetId);

  const binding = createBinding(presetId, blockStates ?? {}, undefined, linkedToDefaults);
  putProfileBinding(userId, chatKey(chatId), binding);
  replaceProfilePromptVariables(userId, variablesKey("chat", chatId), promptVariables);
  return withProfilePromptVariables(userId, binding, variablesKey("chat", chatId));
}

export function deleteChatBinding(
  userId: string,
  chatId: string
): boolean {
  const deleted = settingsSvc.deleteSetting(userId, chatKey(chatId));
  settingsSvc.deleteSetting(userId, variablesKey("chat", chatId));
  return deleted;
}

/** Update a profile's values without replacing its saved block states. */
function updateBindingPromptVariables(
  userId: string,
  key: string,
  promptVariablesKey: string,
  promptVariables: PromptVariableValues,
): PresetProfileBinding {
  const binding = getValidBinding(userId, key);
  if (!binding) throw new Error("No profile binding found");

  // A linked chat delegates both block and variable state to the defaults.
  if (binding.linked_to_defaults) {
    const defaults = getDefaults(userId, binding.preset_id);
    if (!defaults) throw new Error("No defaults captured");
    replaceProfilePromptVariables(userId, defaultsVariablesKey(defaults.preset_id), promptVariables);
    return getDefaults(userId, defaults.preset_id)!;
  }

  replaceProfilePromptVariables(userId, promptVariablesKey, promptVariables);
  return withProfilePromptVariables(userId, binding, promptVariablesKey);
}

export function updateDefaultsPromptVariables(
  userId: string,
  presetId: string,
  promptVariables: PromptVariableValues,
): PresetProfileBinding {
  const binding = getDefaults(userId, presetId);
  if (!binding) throw new Error("No defaults captured");
  replaceProfilePromptVariables(userId, defaultsVariablesKey(presetId), promptVariables);
  return getDefaults(userId, presetId)!;
}

export function updateChatPromptVariables(userId: string, chatId: string, promptVariables: PromptVariableValues): PresetProfileBinding {
  return updateBindingPromptVariables(userId, chatKey(chatId), variablesKey("chat", chatId), promptVariables);
}

export function updatePersonaPromptVariables(userId: string, personaId: string, promptVariables: PromptVariableValues): PresetProfileBinding {
  return updateBindingPromptVariables(userId, personaKey(personaId), variablesKey("persona", personaId), promptVariables);
}

export function updateCharacterPromptVariables(userId: string, characterId: string, promptVariables: PromptVariableValues): PresetProfileBinding {
  return updateBindingPromptVariables(userId, characterKey(characterId), variablesKey("character", characterId), promptVariables);
}

export function updateConnectionPromptVariables(userId: string, connectionId: string, promptVariables: PromptVariableValues): PresetProfileBinding {
  return updateBindingPromptVariables(userId, connectionKey(connectionId), variablesKey("connection", connectionId), promptVariables);
}

// ---------------------------------------------------------------------------
// Connection profile bindings
// ---------------------------------------------------------------------------

export function getConnectionBinding(
  userId: string,
  connectionId: string
): PresetProfileBinding | null {
  const binding = getValidBinding(userId, connectionKey(connectionId));
  return binding ? withProfilePromptVariables(userId, binding, variablesKey("connection", connectionId)) : null;
}

export function setConnectionBinding(
  userId: string,
  connectionId: string,
  presetId: string,
  blockStates: Record<string, boolean>,
  promptVariables?: PromptVariableValues,
): PresetProfileBinding {
  const connection = connectionsSvc.getUsableConnection(userId, connectionId);
  if (!connection) throw new Error("Connection not found");
  assertPresetExists(userId, presetId);

  const binding = createBinding(presetId, blockStates);
  putProfileBinding(userId, connectionKey(connectionId), binding);
  replaceProfilePromptVariables(userId, variablesKey("connection", connectionId), promptVariables);
  return withProfilePromptVariables(userId, binding, variablesKey("connection", connectionId));
}

export function deleteConnectionBinding(
  userId: string,
  connectionId: string
): boolean {
  const deleted = settingsSvc.deleteSetting(userId, connectionKey(connectionId));
  settingsSvc.deleteSetting(userId, variablesKey("connection", connectionId));
  return deleted;
}
// ---------------------------------------------------------------------------
// Resolution — determines which binding to apply for a given context
// ---------------------------------------------------------------------------

export type PresetProfileResolveOptions = {
  isGroup?: boolean;
  connectionId?: string | null;
  personaId?: string | null;
};

type PresetProfileBindingLoader = {
  chat(chatId: string): PresetProfileBinding | null;
  persona(personaId: string): PresetProfileBinding | null;
  character(characterId: string): PresetProfileBinding | null;
  connection(connectionId: string): PresetProfileBinding | null;
  defaults(presetId: string): PresetProfileBinding | null;
};

function resolveSpecificBindingWithDefaults(
  source: "chat" | "persona" | "character" | "connection",
  sourceId: string,
  binding: PresetProfileBinding,
  defaults: (presetId: string) => PresetProfileBinding | null,
): ResolvedPresetProfile {
  if (binding.linked_to_defaults) {
    return {
      preset_id: binding.preset_id,
      binding: defaults(binding.preset_id),
      source,
      source_id: sourceId,
    };
  }
  return {
    preset_id: binding.preset_id,
    binding,
    source,
    source_id: sourceId,
  };
}

function resolveProfileWithLoader(
  fallbackPresetId: string | null,
  chatId: string,
  characterId: string | null,
  options: PresetProfileResolveOptions,
  load: PresetProfileBindingLoader,
): ResolvedPresetProfile {
  const chatBinding = load.chat(chatId);
  if (chatBinding) {
    return resolveSpecificBindingWithDefaults("chat", chatId, chatBinding, load.defaults);
  }
  if (options.personaId) {
    const personaBinding = load.persona(options.personaId);
    if (personaBinding) {
      return resolveSpecificBindingWithDefaults("persona", options.personaId, personaBinding, load.defaults);
    }
  }
  if (!options.isGroup && characterId) {
    const charBinding = load.character(characterId);
    if (charBinding) {
      return resolveSpecificBindingWithDefaults("character", characterId, charBinding, load.defaults);
    }
  }
  if (options.connectionId) {
    const connectionBinding = load.connection(options.connectionId);
    if (connectionBinding) {
      return resolveSpecificBindingWithDefaults("connection", options.connectionId, connectionBinding, load.defaults);
    }
  }
  if (fallbackPresetId) {
    const defaults = load.defaults(fallbackPresetId);
    if (defaults) {
      return { preset_id: defaults.preset_id, binding: defaults, source: "defaults", source_id: fallbackPresetId };
    }
  }
  return { preset_id: fallbackPresetId, binding: null, source: "none", source_id: null };
}


function readSettingJson(db: Database, userId: string, key: string): unknown {
  const row = db.query("SELECT value FROM settings WHERE key = ? AND user_id = ? LIMIT 1").get(key, userId) as { value?: unknown } | null;
  if (!row || typeof row.value !== "string") return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

function presetExistsWithDb(db: Database, userId: string, presetId: string): boolean {
  return db.query("SELECT 1 AS ok FROM presets WHERE id = ? AND user_id = ? LIMIT 1").get(presetId, userId) !== null;
}

function asProfileBinding(value: unknown): PresetProfileBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.preset_id !== "string" || record.preset_id.length === 0) return null;
  if (!record.block_states || typeof record.block_states !== "object" || Array.isArray(record.block_states)) return null;
  const block_states: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(record.block_states as Record<string, unknown>)) {
    if (typeof enabled === "boolean") block_states[id] = enabled;
  }
  const binding: PresetProfileBinding = {
    preset_id: record.preset_id,
    block_states,
    captured_at: typeof record.captured_at === "number" && Number.isFinite(record.captured_at) ? record.captured_at : 0,
  };
  if (record.linked_to_defaults === true) binding.linked_to_defaults = true;
  if (record.prompt_variables && typeof record.prompt_variables === "object" && !Array.isArray(record.prompt_variables)) {
    binding.prompt_variables = record.prompt_variables as PromptVariableValues;
  }
  return binding;
}

function asPromptVariables(value: unknown): PromptVariableValues | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as PromptVariableValues;
  return undefined;
}

function readBindingWithDb(db: Database, userId: string, key: string): PresetProfileBinding | null {
  const binding = asProfileBinding(readSettingJson(db, userId, key));
  if (!binding || !presetExistsWithDb(db, userId, binding.preset_id)) return null;
  return binding;
}

function overlayPromptVariables(binding: PresetProfileBinding, stored: PromptVariableValues | undefined): PresetProfileBinding {
  return stored ? { ...binding, prompt_variables: stored } : binding;
}

function readScopedBindingWithDb(
  db: Database,
  userId: string,
  bindingKey: string,
  promptVariablesKey: string,
): PresetProfileBinding | null {
  const binding = readBindingWithDb(db, userId, bindingKey);
  if (!binding) return null;
  return overlayPromptVariables(binding, asPromptVariables(readSettingJson(db, userId, promptVariablesKey)) ?? binding.prompt_variables);
}

function readDefaultsWithDb(db: Database, userId: string, presetId: string): PresetProfileBinding | null {
  const current = readBindingWithDb(db, userId, defaultsKey(presetId));
  if (current) {
    if (current.preset_id !== presetId) return null;
    return overlayPromptVariables(current, asPromptVariables(readSettingJson(db, userId, defaultsVariablesKey(presetId))) ?? current.prompt_variables);
  }
  const legacy = readBindingWithDb(db, userId, LEGACY_DEFAULTS_KEY);
  if (legacy?.preset_id !== presetId) return null;
  return overlayPromptVariables(legacy, asPromptVariables(readSettingJson(db, userId, defaultsVariablesKey(presetId))) ?? legacy.prompt_variables);
}

export function resolveProfile(
  userId: string,
  fallbackPresetId: string | null,
  chatId: string,
  characterId: string | null,
  options: PresetProfileResolveOptions = {},
): ResolvedPresetProfile {
  return resolveProfileWithLoader(fallbackPresetId, chatId, characterId, options, {
    chat: (id) => getChatBinding(userId, id),
    persona: (id) => getPersonaBinding(userId, id),
    character: (id) => getCharacterBinding(userId, id),
    connection: (id) => getConnectionBinding(userId, id),
    defaults: (id) => getDefaults(userId, id),
  });
}

/** Read-only resolution against an exact Database handle. Does not use getDb() or mutate settings. */
export function resolveProfileWithDb(
  db: Database,
  userId: string,
  fallbackPresetId: string | null,
  chatId: string,
  characterId: string | null,
  options: PresetProfileResolveOptions = {},
): ResolvedPresetProfile {
  return resolveProfileWithLoader(fallbackPresetId, chatId, characterId, options, {
    chat: (id) => readScopedBindingWithDb(db, userId, chatKey(id), variablesKey("chat", id)),
    persona: (id) => readScopedBindingWithDb(db, userId, personaKey(id), variablesKey("persona", id)),
    character: (id) => readScopedBindingWithDb(db, userId, characterKey(id), variablesKey("character", id)),
    connection: (id) => readScopedBindingWithDb(db, userId, connectionKey(id), variablesKey("connection", id)),
    defaults: (id) => readDefaultsWithDb(db, userId, id),
  });
}

// ---------------------------------------------------------------------------
// Block state application — mutates block enabled states in place
// ---------------------------------------------------------------------------

export function applyProfileToBlocks(
  blocks: PromptBlock[],
  binding: PresetProfileBinding
): void {
  for (const block of blocks) {
    if (block.id in binding.block_states) {
      block.enabled = binding.block_states[block.id];
    }
  }
}

export function normalizeCategoryBlockStates(
  blocks: PromptBlock[]
): void {
  let currentCategoryMode: PromptBlock["categoryMode"] = null;
  let currentChildren: PromptBlock[] = [];

  const normalizeCurrentGroup = () => {
    if (currentCategoryMode !== "radio") return;
    const enabledChildren = currentChildren.filter((block) => block.enabled);
    if (enabledChildren.length <= 1) return;

    const keepId = enabledChildren[0].id;
    for (const block of currentChildren) {
      block.enabled = block.id === keepId;
    }
  };

  for (const block of blocks) {
    if (block.marker === "category") {
      normalizeCurrentGroup();
      currentCategoryMode = block.categoryMode ?? null;
      currentChildren = [];
      continue;
    }
    currentChildren.push(block);
  }

  normalizeCurrentGroup();
}

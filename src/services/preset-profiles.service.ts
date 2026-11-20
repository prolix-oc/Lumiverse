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
import { isNoPresetChatMetadata, isTemporaryChatMetadata } from "../types/chat";
import { resolveChatGenerationConnection } from "./generation/connection-resolution";

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
  if (!presetsSvc.presetExists(userId, presetId)) throw new Error("Preset not found");
}

function getValidBinding(
  userId: string,
  key: string,
): PresetProfileBinding | null {
  const s = settingsSvc.getSetting(userId, key);
  if (!s) return null;
  const binding = s.value as PresetProfileBinding;
  if (!binding?.preset_id || !presetsSvc.presetExists(userId, binding.preset_id)) {
    settingsSvc.deleteSetting(userId, key);
    return null;
  }
  return binding;
}

function resolveSpecificBinding(
  userId: string,
  source: "chat" | "persona" | "character" | "connection",
  sourceId: string,
  binding: PresetProfileBinding
): ResolvedPresetProfile {
  if (binding.linked_to_defaults) {
    return {
      preset_id: binding.preset_id,
      binding: getDefaultsForBinding(userId, binding),
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
  let deleted = settingsSvc.deleteSetting(userId, defaultsKey(presetId));
  settingsSvc.deleteSetting(userId, defaultsVariablesKey(presetId));
  const legacy = settingsSvc.getSetting(userId, LEGACY_DEFAULTS_KEY);
  if (legacy && (legacy.value as PresetProfileBinding)?.preset_id === presetId) {
    settingsSvc.deleteSetting(userId, LEGACY_DEFAULTS_KEY);
    deleted = true;
  }
  if (deleted) eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key: defaultsKey(presetId), binding: null }, userId);
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
  if (deleted) eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key: characterKey(characterId), binding: null }, userId);
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
  if (deleted) eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key: personaKey(personaId), binding: null }, userId);
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
  if (deleted) eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key: chatKey(chatId), binding: null }, userId);
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
  const connection = connectionsSvc.getConnection(userId, connectionId);
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
  if (deleted) eventBus.emit(EventType.PRESET_PROFILE_CHANGED, { key: connectionKey(connectionId), binding: null }, userId);
  return deleted;
}

// ---------------------------------------------------------------------------
// Resolution — determines which binding to apply for a given context
// ---------------------------------------------------------------------------

export function resolveProfile(
  userId: string,
  fallbackPresetId: string | null,
  chatId: string,
  characterId: string | null,
  options: { isGroup?: boolean; connectionId?: string | null; personaId?: string | null } = {}
): ResolvedPresetProfile {
  // 1. Chat-level binding (most specific)
  const chatBinding = getChatBinding(userId, chatId);
  if (chatBinding) {
    return resolveSpecificBinding(userId, "chat", chatId, chatBinding);
  }

  // 2. Persona-level binding. It deliberately outranks a character profile:
  // switching personas is expected to restore that persona's preset state in
  // one action. Chat bindings remain the explicit per-conversation override.
  if (options.personaId) {
    const personaBinding = getPersonaBinding(userId, options.personaId);
    if (personaBinding) {
      return resolveSpecificBinding(userId, "persona", options.personaId, personaBinding);
    }
  }

  // 3. Character-level binding — skipped in group chats. Per-member bindings
  //    would be ambiguous (which member wins?), so group chats are chat-only.
  if (!options.isGroup && characterId) {
    const charBinding = getCharacterBinding(userId, characterId);
    if (charBinding) {
      return resolveSpecificBinding(userId, "character", characterId, charBinding);
    }
  }

  // 4. Connection-level binding — applies across chats for the active model
  //    environment when there isn't a more specific chat/character binding.
  if (options.connectionId) {
    const connectionBinding = getConnectionBinding(userId, options.connectionId);
    if (connectionBinding) {
      return resolveSpecificBinding(userId, "connection", options.connectionId, connectionBinding);
    }
  }

  // 5. Default snapshot — defaults are stored per preset, so they only apply
  //    when there isn't a more specific chat/character/connection binding.
  if (fallbackPresetId) {
    const defaults = getDefaults(userId, fallbackPresetId);
    if (defaults) {
      return { preset_id: defaults.preset_id, binding: defaults, source: "defaults", source_id: fallbackPresetId };
    }
  }

  // 6. No matching binding — use raw preset block states
  return { preset_id: fallbackPresetId, binding: null, source: "none", source_id: null };
}

/**
 * The preset a chat generates with, mirroring prompt assembly: the selected
 * Loom preset or the chat connection's preset, then the profile bindings
 * above. Without a chat, only the selected preset and its defaults apply.
 * Returns null when the chat does not exist.
 */
export async function resolveActivePreset(
  userId: string,
  chatId?: string | null,
): Promise<ResolvedPresetProfile | null> {
  const selected = settingsSvc.getSetting(userId, "activeLoomPresetId")?.value;
  const selectedPresetId = typeof selected === "string" && selected ? selected : null;

  if (!chatId) {
    const defaults = selectedPresetId ? getDefaults(userId, selectedPresetId) : null;
    return defaults
      ? { preset_id: defaults.preset_id, binding: defaults, source: "defaults", source_id: selectedPresetId }
      : { preset_id: selectedPresetId, binding: null, source: "none", source_id: null };
  }

  const chat = await chatsSvc.getChatAsync(userId, chatId);
  if (!chat) return null;
  if (isNoPresetChatMetadata(chat.metadata)) {
    return { preset_id: null, binding: null, source: "none", source_id: null };
  }

  let connection: { id: string; preset_id?: string | null } | null = null;
  try {
    connection = resolveChatGenerationConnection(userId, chat.metadata);
  } catch {
    // No usable connection: resolve from the selected preset alone.
  }
  const persona = isTemporaryChatMetadata(chat.metadata)
    ? null
    : await personasSvc.resolvePersonaOrDefaultAsync(userId);

  return resolveProfile(
    userId,
    selectedPresetId ?? connection?.preset_id ?? null,
    chatId,
    chat.character_id,
    {
      isGroup: chat.metadata?.group === true,
      connectionId: connection?.id ?? null,
      personaId: persona?.id ?? null,
    },
  );
}

// ---------------------------------------------------------------------------
// Block state application — mutates block enabled states in place
// ---------------------------------------------------------------------------

/** Read-only projection for regex previews; unlike normal resolution, never cleans up settings. */
export function readActivationProfileVariables(userId: string, presetId: string, context: {
  chatId?: string; personaId?: string; characterId?: string; connectionId?: string; isGroup?: boolean;
}): PromptVariableValues | undefined {
  const read = (key: string) => {
    const binding = settingsSvc.getSetting(userId, key)?.value as PresetProfileBinding | undefined;
    return binding?.preset_id && presetsSvc.getPreset(userId, binding.preset_id) ? binding : undefined;
  };
  const defaults = () => {
    const current = read(defaultsKey(presetId));
    const binding = current?.preset_id === presetId ? current : read(LEGACY_DEFAULTS_KEY);
    return binding?.preset_id === presetId ? getProfilePromptVariables(userId, defaultsVariablesKey(presetId), binding) : undefined;
  };
  const candidates: Array<["chat" | "persona" | "character" | "connection", string | undefined]> = [
    ["chat", context.chatId], ["persona", context.personaId],
    ["character", context.isGroup ? undefined : context.characterId], ["connection", context.connectionId],
  ];
  for (const [scope, id] of candidates) {
    if (!id) continue;
    const binding = read(`presetProfile:${scope}:${id}`);
    if (!binding) continue;
    // A preview stays in the explicitly linked preset; never borrow another preset's values.
    if (binding.preset_id !== presetId || binding.linked_to_defaults) return defaults();
    return getProfilePromptVariables(userId, variablesKey(scope, id), binding);
  }
  return defaults();
}

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

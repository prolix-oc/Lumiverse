import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as connectionsSvc from "./connections.service";
import * as presetsSvc from "./presets.service";
import type { PresetProfileBinding, ResolvedPresetProfile } from "../types/preset-profile";
import type { PromptBlock } from "../types/preset";

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
function chatKey(chatId: string): string {
  return `presetProfile:chat:${chatId}`;
}
function connectionKey(connectionId: string): string {
  return `presetProfile:connection:${connectionId}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function getDefaults(userId: string, presetId: string): PresetProfileBinding | null {
  const current = getValidBinding(userId, defaultsKey(presetId));
  if (current) {
    if (current.preset_id === presetId) return current;
    settingsSvc.deleteSetting(userId, defaultsKey(presetId));
  }

  // Legacy fallback: older builds stored a single shared defaults snapshot.
  const legacy = getValidBinding(userId, LEGACY_DEFAULTS_KEY);
  return legacy?.preset_id === presetId ? legacy : null;
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
  linkedToDefaults?: boolean
): PresetProfileBinding {
  return {
    preset_id: presetId,
    block_states: blockStates,
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

function resolveSpecificBinding(
  userId: string,
  source: "chat" | "character" | "connection",
  binding: PresetProfileBinding
): ResolvedPresetProfile {
  if (binding.linked_to_defaults) {
    return {
      preset_id: binding.preset_id,
      binding: getDefaultsForBinding(userId, binding),
      source,
    };
  }

  return {
    preset_id: binding.preset_id,
    binding,
    source,
  };
}

export function captureDefaults(
  userId: string,
  presetId: string,
  blockStates: Record<string, boolean>
): PresetProfileBinding {
  assertPresetExists(userId, presetId);
  const binding = createBinding(presetId, blockStates);
  settingsSvc.putSetting(userId, defaultsKey(presetId), binding);
  return binding;
}

export function deleteDefaults(userId: string, presetId: string): boolean {
  const deleted = settingsSvc.deleteSetting(userId, defaultsKey(presetId));
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
  return getValidBinding(userId, characterKey(characterId));
}

export function setCharacterBinding(
  userId: string,
  characterId: string,
  presetId: string,
  blockStates: Record<string, boolean>
): PresetProfileBinding {
  // Validate character exists
  const character = charactersSvc.getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");
  assertPresetExists(userId, presetId);

  const binding = createBinding(presetId, blockStates);
  settingsSvc.putSetting(userId, characterKey(characterId), binding);
  return binding;
}

export function deleteCharacterBinding(
  userId: string,
  characterId: string
): boolean {
  return settingsSvc.deleteSetting(userId, characterKey(characterId));
}

// ---------------------------------------------------------------------------
// Chat bindings
// ---------------------------------------------------------------------------

export function getChatBinding(
  userId: string,
  chatId: string
): PresetProfileBinding | null {
  return getValidBinding(userId, chatKey(chatId));
}

export function setChatBinding(
  userId: string,
  chatId: string,
  presetId: string,
  blockStates: Record<string, boolean> | null,
  linkedToDefaults?: boolean
): PresetProfileBinding {
  // Validate chat exists
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) throw new Error("Chat not found");
  assertPresetExists(userId, presetId);

  const binding = createBinding(presetId, blockStates ?? {}, linkedToDefaults);
  settingsSvc.putSetting(userId, chatKey(chatId), binding);
  return binding;
}

export function deleteChatBinding(
  userId: string,
  chatId: string
): boolean {
  return settingsSvc.deleteSetting(userId, chatKey(chatId));
}

// ---------------------------------------------------------------------------
// Connection profile bindings
// ---------------------------------------------------------------------------

export function getConnectionBinding(
  userId: string,
  connectionId: string
): PresetProfileBinding | null {
  return getValidBinding(userId, connectionKey(connectionId));
}

export function setConnectionBinding(
  userId: string,
  connectionId: string,
  presetId: string,
  blockStates: Record<string, boolean>
): PresetProfileBinding {
  const connection = connectionsSvc.getConnection(userId, connectionId);
  if (!connection) throw new Error("Connection not found");
  assertPresetExists(userId, presetId);

  const binding = createBinding(presetId, blockStates);
  settingsSvc.putSetting(userId, connectionKey(connectionId), binding);
  return binding;
}

export function deleteConnectionBinding(
  userId: string,
  connectionId: string
): boolean {
  return settingsSvc.deleteSetting(userId, connectionKey(connectionId));
}

// ---------------------------------------------------------------------------
// Resolution — determines which binding to apply for a given context
// ---------------------------------------------------------------------------

export function resolveProfile(
  userId: string,
  fallbackPresetId: string | null,
  chatId: string,
  characterId: string | null,
  options: { isGroup?: boolean; connectionId?: string | null } = {}
): ResolvedPresetProfile {
  // 1. Chat-level binding (most specific)
  const chatBinding = getChatBinding(userId, chatId);
  if (chatBinding) {
    return resolveSpecificBinding(userId, "chat", chatBinding);
  }

  // 2. Character-level binding — skipped in group chats. Per-member bindings
  //    would be ambiguous (which member wins?), so group chats are chat-only.
  if (!options.isGroup && characterId) {
    const charBinding = getCharacterBinding(userId, characterId);
    if (charBinding) {
      return resolveSpecificBinding(userId, "character", charBinding);
    }
  }

  // 3. Connection-level binding — applies across chats for the active model
  //    environment when there isn't a more specific chat/character binding.
  if (options.connectionId) {
    const connectionBinding = getConnectionBinding(userId, options.connectionId);
    if (connectionBinding) {
      return resolveSpecificBinding(userId, "connection", connectionBinding);
    }
  }

  // 4. Default snapshot — defaults are stored per preset, so they only apply
  //    when there isn't a more specific chat/character/connection binding.
  if (fallbackPresetId) {
    const defaults = getDefaults(userId, fallbackPresetId);
    if (defaults) {
      return { preset_id: defaults.preset_id, binding: defaults, source: "defaults" };
    }
  }

  // 5. No matching binding — use raw preset block states
  return { preset_id: fallbackPresetId, binding: null, source: "none" };
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

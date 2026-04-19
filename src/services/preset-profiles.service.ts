import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import type { PresetProfileBinding, ResolvedPresetProfile } from "../types/preset-profile";
import type { PromptBlock } from "../types/preset";

// ---------------------------------------------------------------------------
// Setting key conventions
// ---------------------------------------------------------------------------

const DEFAULTS_KEY = "presetProfileDefaults";
function characterKey(characterId: string): string {
  return `presetProfile:character:${characterId}`;
}
function chatKey(chatId: string): string {
  return `presetProfile:chat:${chatId}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function getDefaults(userId: string): PresetProfileBinding | null {
  const s = settingsSvc.getSetting(userId, DEFAULTS_KEY);
  return s ? (s.value as PresetProfileBinding) : null;
}

export function captureDefaults(
  userId: string,
  presetId: string,
  blockStates: Record<string, boolean>
): PresetProfileBinding {
  const binding: PresetProfileBinding = {
    preset_id: presetId,
    block_states: blockStates,
    captured_at: Math.floor(Date.now() / 1000),
  };
  settingsSvc.putSetting(userId, DEFAULTS_KEY, binding);
  return binding;
}

export function deleteDefaults(userId: string): boolean {
  return settingsSvc.deleteSetting(userId, DEFAULTS_KEY);
}

// ---------------------------------------------------------------------------
// Character bindings
// ---------------------------------------------------------------------------

export function getCharacterBinding(
  userId: string,
  characterId: string
): PresetProfileBinding | null {
  const s = settingsSvc.getSetting(userId, characterKey(characterId));
  return s ? (s.value as PresetProfileBinding) : null;
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

  const binding: PresetProfileBinding = {
    preset_id: presetId,
    block_states: blockStates,
    captured_at: Math.floor(Date.now() / 1000),
  };
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
  const s = settingsSvc.getSetting(userId, chatKey(chatId));
  return s ? (s.value as PresetProfileBinding) : null;
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

  const binding: PresetProfileBinding = {
    preset_id: presetId,
    block_states: blockStates ?? {},
    captured_at: Math.floor(Date.now() / 1000),
    ...(linkedToDefaults ? { linked_to_defaults: true } : {}),
  };
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
// Resolution — determines which binding to apply for a given context
// ---------------------------------------------------------------------------

export function resolveProfile(
  userId: string,
  presetId: string,
  chatId: string,
  characterId: string,
  options: { isGroup?: boolean } = {}
): ResolvedPresetProfile {
  // 1. Chat-level binding (most specific)
  const chatBinding = getChatBinding(userId, chatId);
  if (chatBinding && chatBinding.preset_id === presetId) {
    // If this binding is linked to defaults, skip to defaults resolution
    // so that updating the defaults propagates to all linked chats.
    if (!chatBinding.linked_to_defaults) {
      return { binding: chatBinding, source: "chat" };
    }
  }

  // 2. Character-level binding — skipped in group chats. Per-member bindings
  //    would be ambiguous (which member wins?), so group chats are chat-only.
  if (!options.isGroup) {
    const charBinding = getCharacterBinding(userId, characterId);
    if (charBinding && charBinding.preset_id === presetId) {
      return { binding: charBinding, source: "character" };
    }
  }

  // 3. Default snapshot — also used when chat binding delegates via linked_to_defaults
  const defaults = getDefaults(userId);
  if (defaults && defaults.preset_id === presetId) {
    return { binding: defaults, source: "defaults" };
  }

  // 4. No matching binding — use raw preset block states
  return { binding: null, source: "none" };
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

import type { CouncilSettings } from "lumiverse-spindle-types";
import { SIDECAR_DEFAULTS } from "lumiverse-spindle-types";
import * as settingsSvc from "../settings.service";
import * as chatsSvc from "../chats.service";
import * as charactersSvc from "../characters.service";
import {
  getCouncilSettings,
  normalizeCouncilSettings,
} from "./council-settings.service";
import {
  getSidecarSettings,
  type SidecarSettings,
} from "../sidecar-settings.service";
import type {
  CouncilProfileBinding,
  ResolvedCouncilProfile,
} from "../../types/council-profile";

const DEFAULTS_KEY = "councilProfileDefaults";

function characterKey(characterId: string): string {
  return `councilProfile:character:${characterId}`;
}

function chatKey(chatId: string): string {
  return `councilProfile:chat:${chatId}`;
}

function mergeCouncilSnapshot(
  base: CouncilSettings,
  partial?: Partial<CouncilSettings>,
): CouncilSettings {
  if (!partial) return normalizeCouncilSettings(base);
  return normalizeCouncilSettings({
    ...base,
    ...partial,
    toolsSettings: partial.toolsSettings
      ? {
          ...base.toolsSettings,
          ...partial.toolsSettings,
        }
      : base.toolsSettings,
  });
}

function mergeSidecarSnapshot(
  base: SidecarSettings,
  partial?: Partial<SidecarSettings>,
): SidecarSettings {
  return { ...base, ...(partial ?? {}) };
}

function normalizeBinding(
  binding: CouncilProfileBinding,
): CouncilProfileBinding {
  return {
    council_settings: normalizeCouncilSettings(binding.council_settings),
    sidecar_settings: mergeSidecarSnapshot(
      { ...SIDECAR_DEFAULTS },
      binding.sidecar_settings,
    ),
    captured_at: binding.captured_at || Math.floor(Date.now() / 1000),
  };
}

function createBinding(
  councilSettings: CouncilSettings,
  sidecarSettings: SidecarSettings,
): CouncilProfileBinding {
  return {
    council_settings: normalizeCouncilSettings(councilSettings),
    sidecar_settings: mergeSidecarSnapshot(
      { ...SIDECAR_DEFAULTS },
      sidecarSettings,
    ),
    captured_at: Math.floor(Date.now() / 1000),
  };
}

function getBaseBinding(
  userId: string,
  current: CouncilProfileBinding | null,
): CouncilProfileBinding {
  return current ?? createBinding(getCouncilSettings(userId), getSidecarSettings(userId));
}

function mergeBinding(
  userId: string,
  current: CouncilProfileBinding | null,
  partial: {
    council_settings?: Partial<CouncilSettings>;
    sidecar_settings?: Partial<SidecarSettings>;
  },
): CouncilProfileBinding {
  const base = getBaseBinding(userId, current);
  return createBinding(
    mergeCouncilSnapshot(base.council_settings, partial.council_settings),
    mergeSidecarSnapshot(base.sidecar_settings, partial.sidecar_settings),
  );
}

export function getDefaults(userId: string): CouncilProfileBinding | null {
  const row = settingsSvc.getSetting(userId, DEFAULTS_KEY);
  return row ? normalizeBinding(row.value as CouncilProfileBinding) : null;
}

export function putDefaults(
  userId: string,
  partial: {
    council_settings?: Partial<CouncilSettings>;
    sidecar_settings?: Partial<SidecarSettings>;
  },
): CouncilProfileBinding {
  const binding = mergeBinding(userId, getDefaults(userId), partial);
  settingsSvc.putSetting(userId, DEFAULTS_KEY, binding);
  return binding;
}

export function deleteDefaults(userId: string): boolean {
  return settingsSvc.deleteSetting(userId, DEFAULTS_KEY);
}

export function getCharacterBinding(
  userId: string,
  characterId: string,
): CouncilProfileBinding | null {
  const row = settingsSvc.getSetting(userId, characterKey(characterId));
  return row ? normalizeBinding(row.value as CouncilProfileBinding) : null;
}

export function putCharacterBinding(
  userId: string,
  characterId: string,
  partial: {
    council_settings?: Partial<CouncilSettings>;
    sidecar_settings?: Partial<SidecarSettings>;
  },
): CouncilProfileBinding {
  const character = charactersSvc.getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");

  const binding = mergeBinding(
    userId,
    getCharacterBinding(userId, characterId),
    partial,
  );
  settingsSvc.putSetting(userId, characterKey(characterId), binding);
  return binding;
}

export function deleteCharacterBinding(userId: string, characterId: string): boolean {
  return settingsSvc.deleteSetting(userId, characterKey(characterId));
}

export function getChatBinding(userId: string, chatId: string): CouncilProfileBinding | null {
  const row = settingsSvc.getSetting(userId, chatKey(chatId));
  return row ? normalizeBinding(row.value as CouncilProfileBinding) : null;
}

export function putChatBinding(
  userId: string,
  chatId: string,
  partial: {
    council_settings?: Partial<CouncilSettings>;
    sidecar_settings?: Partial<SidecarSettings>;
  },
): CouncilProfileBinding {
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) throw new Error("Chat not found");

  const binding = mergeBinding(userId, getChatBinding(userId, chatId), partial);
  settingsSvc.putSetting(userId, chatKey(chatId), binding);
  return binding;
}

export function deleteChatBinding(userId: string, chatId: string): boolean {
  return settingsSvc.deleteSetting(userId, chatKey(chatId));
}

function toResolved(
  binding: CouncilProfileBinding,
  source: ResolvedCouncilProfile["source"],
): ResolvedCouncilProfile {
  return {
    binding,
    source,
    council_settings: binding.council_settings,
    sidecar_settings: binding.sidecar_settings,
  };
}

export function resolveProfile(
  userId: string,
  chatId: string,
  characterId: string | null,
  options: { isGroup?: boolean } = {},
): ResolvedCouncilProfile {
  const chatBinding = getChatBinding(userId, chatId);
  if (chatBinding) return toResolved(chatBinding, "chat");

  if (!options.isGroup && characterId) {
    const characterBinding = getCharacterBinding(userId, characterId);
    if (characterBinding) return toResolved(characterBinding, "character");
  }

  const defaults = getDefaults(userId);
  if (defaults) return toResolved(defaults, "defaults");

  return {
    binding: null,
    source: "none",
    council_settings: getCouncilSettings(userId),
    sidecar_settings: getSidecarSettings(userId),
  };
}

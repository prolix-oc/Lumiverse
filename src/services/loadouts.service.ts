import * as settingsSvc from "./settings.service";
import * as chatsSvc from "./chats.service";
import { getCouncilSettings, putCouncilSettings } from "./council/council-settings.service";
import type { Loadout, LoadoutSnapshot, LoadoutBinding, ResolvedLoadout } from "../types/loadout";

// ---------------------------------------------------------------------------
// Setting key conventions
// ---------------------------------------------------------------------------

const LOADOUTS_KEY = "loadouts";

function characterKey(characterId: string): string {
  return `loadout:character:${characterId}`;
}

function chatKey(chatId: string): string {
  return `loadout:chat:${chatId}`;
}

// ---------------------------------------------------------------------------
// Settings keys captured in a loadout snapshot
// ---------------------------------------------------------------------------

const SNAPSHOT_SETTINGS_KEYS = [
  "selectedDefinition", "selectedChimeraDefinitions", "selectedBehaviors", "selectedPersonalities",
  "chimeraMode", "lumiaQuirks", "lumiaQuirksEnabled",
  "selectedLoomStyles", "selectedLoomUtils", "selectedLoomRetrofits",
  "oocEnabled", "lumiaOOCStyle", "lumiaOOCInterval",
  "sovereignHand", "contextFilters",
];

// ---------------------------------------------------------------------------
// Loadout CRUD
// ---------------------------------------------------------------------------

export function getAllLoadouts(userId: string): Loadout[] {
  const s = settingsSvc.getSetting(userId, LOADOUTS_KEY);
  return s ? (s.value as Loadout[]) : [];
}

export function getLoadout(userId: string, loadoutId: string): Loadout | null {
  const all = getAllLoadouts(userId);
  return all.find((l) => l.id === loadoutId) ?? null;
}

export function createLoadout(userId: string, name: string, snapshot?: LoadoutSnapshot): Loadout {
  const all = getAllLoadouts(userId);
  const finalSnapshot = snapshot ?? captureSnapshot(userId);
  const now = Math.floor(Date.now() / 1000);
  const loadout: Loadout = {
    id: crypto.randomUUID(),
    name,
    snapshot: finalSnapshot,
    created_at: now,
    updated_at: now,
  };
  all.push(loadout);
  settingsSvc.putSetting(userId, LOADOUTS_KEY, all);
  return loadout;
}

export function updateLoadout(
  userId: string,
  loadoutId: string,
  updates: { name?: string; recapture?: boolean }
): Loadout | null {
  const all = getAllLoadouts(userId);
  const idx = all.findIndex((l) => l.id === loadoutId);
  if (idx < 0) return null;

  const loadout = all[idx];
  if (updates.name !== undefined) loadout.name = updates.name;
  if (updates.recapture) loadout.snapshot = captureSnapshot(userId);
  loadout.updated_at = Math.floor(Date.now() / 1000);

  all[idx] = loadout;
  settingsSvc.putSetting(userId, LOADOUTS_KEY, all);
  return loadout;
}

export function deleteLoadout(userId: string, loadoutId: string): boolean {
  const all = getAllLoadouts(userId);
  const filtered = all.filter((l) => l.id !== loadoutId);
  if (filtered.length === all.length) return false;

  settingsSvc.putSetting(userId, LOADOUTS_KEY, filtered);

  // Cleanup bindings referencing this loadout
  cleanupBindings(userId, loadoutId);

  return true;
}

// ---------------------------------------------------------------------------
// Snapshot capture & apply
// ---------------------------------------------------------------------------

export function captureSnapshot(userId: string): LoadoutSnapshot {
  const settingsMap = settingsSvc.getSettingsByKeys(userId, SNAPSHOT_SETTINGS_KEYS);
  const councilSettings = getCouncilSettings(userId);

  return {
    selectedDefinition: settingsMap.get("selectedDefinition") ?? null,
    selectedChimeraDefinitions: settingsMap.get("selectedChimeraDefinitions") ?? [],
    selectedBehaviors: settingsMap.get("selectedBehaviors") ?? [],
    selectedPersonalities: settingsMap.get("selectedPersonalities") ?? [],
    chimeraMode: settingsMap.get("chimeraMode") ?? false,
    lumiaQuirks: settingsMap.get("lumiaQuirks") ?? "",
    lumiaQuirksEnabled: settingsMap.get("lumiaQuirksEnabled") ?? true,
    councilSettings,
    selectedLoomStyles: settingsMap.get("selectedLoomStyles") ?? [],
    selectedLoomUtils: settingsMap.get("selectedLoomUtils") ?? [],
    selectedLoomRetrofits: settingsMap.get("selectedLoomRetrofits") ?? [],
    oocEnabled: settingsMap.get("oocEnabled") ?? true,
    lumiaOOCStyle: settingsMap.get("lumiaOOCStyle") ?? "social",
    lumiaOOCInterval: settingsMap.get("lumiaOOCInterval") ?? null,
    sovereignHand: settingsMap.get("sovereignHand") ?? {
      enabled: false,
      excludeLastMessage: true,
      includeMessageInPrompt: true,
    },
    contextFilters: settingsMap.get("contextFilters") ?? {},
  };
}

export function applySnapshot(userId: string, snapshot: LoadoutSnapshot): void {
  const batch: Record<string, any> = {
    selectedDefinition: snapshot.selectedDefinition,
    selectedChimeraDefinitions: snapshot.selectedChimeraDefinitions ?? [],
    selectedBehaviors: snapshot.selectedBehaviors,
    selectedPersonalities: snapshot.selectedPersonalities,
    chimeraMode: snapshot.chimeraMode,
    lumiaQuirks: snapshot.lumiaQuirks,
    lumiaQuirksEnabled: snapshot.lumiaQuirksEnabled,
    selectedLoomStyles: snapshot.selectedLoomStyles,
    selectedLoomUtils: snapshot.selectedLoomUtils,
    selectedLoomRetrofits: snapshot.selectedLoomRetrofits,
    oocEnabled: snapshot.oocEnabled,
    lumiaOOCStyle: snapshot.lumiaOOCStyle,
    lumiaOOCInterval: snapshot.lumiaOOCInterval,
    sovereignHand: snapshot.sovereignHand,
    contextFilters: snapshot.contextFilters,
  };

  settingsSvc.putMany(userId, batch);

  // Council settings use a separate key with merge logic
  if (snapshot.councilSettings) {
    putCouncilSettings(userId, snapshot.councilSettings);
  }
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

export function getCharacterBinding(userId: string, characterId: string): LoadoutBinding | null {
  const s = settingsSvc.getSetting(userId, characterKey(characterId));
  return s ? (s.value as LoadoutBinding) : null;
}

export function setCharacterBinding(
  userId: string,
  characterId: string,
  loadoutId: string
): LoadoutBinding {
  const loadout = getLoadout(userId, loadoutId);
  if (!loadout) throw new Error("Loadout not found");

  const binding: LoadoutBinding = {
    loadout_id: loadoutId,
    bound_at: Math.floor(Date.now() / 1000),
  };
  settingsSvc.putSetting(userId, characterKey(characterId), binding);
  return binding;
}

export function deleteCharacterBinding(userId: string, characterId: string): boolean {
  return settingsSvc.deleteSetting(userId, characterKey(characterId));
}

export function getChatBinding(userId: string, chatId: string): LoadoutBinding | null {
  const s = settingsSvc.getSetting(userId, chatKey(chatId));
  return s ? (s.value as LoadoutBinding) : null;
}

export function setChatBinding(
  userId: string,
  chatId: string,
  loadoutId: string
): LoadoutBinding {
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) throw new Error("Chat not found");
  const loadout = getLoadout(userId, loadoutId);
  if (!loadout) throw new Error("Loadout not found");

  const binding: LoadoutBinding = {
    loadout_id: loadoutId,
    bound_at: Math.floor(Date.now() / 1000),
  };
  settingsSvc.putSetting(userId, chatKey(chatId), binding);
  return binding;
}

export function deleteChatBinding(userId: string, chatId: string): boolean {
  return settingsSvc.deleteSetting(userId, chatKey(chatId));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export function resolveLoadout(userId: string, chatId: string): ResolvedLoadout {
  // 1. Chat-level binding (most specific)
  const chatBinding = getChatBinding(userId, chatId);
  if (chatBinding) {
    const loadout = getLoadout(userId, chatBinding.loadout_id);
    if (loadout) return { loadout, source: "chat" };
  }

  // 2. Character-level binding
  const chat = chatsSvc.getChat(userId, chatId);
  if (chat) {
    const charBinding = getCharacterBinding(userId, chat.character_id);
    if (charBinding) {
      const loadout = getLoadout(userId, charBinding.loadout_id);
      if (loadout) return { loadout, source: "character" };
    }
  }

  // 3. No binding
  return { loadout: null, source: "none" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanupBindings(userId: string, loadoutId: string): void {
  // Get all settings and scan for loadout binding keys referencing this loadout
  const allSettings = settingsSvc.getAllSettings(userId);
  for (const setting of allSettings) {
    if (
      (setting.key.startsWith("loadout:character:") || setting.key.startsWith("loadout:chat:")) &&
      setting.value?.loadout_id === loadoutId
    ) {
      settingsSvc.deleteSetting(userId, setting.key);
    }
  }
}

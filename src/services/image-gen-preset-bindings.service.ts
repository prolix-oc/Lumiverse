import * as settingsSvc from "./settings.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";

export interface ImageGenPresetBinding {
  preset_id: string;
  bound_at: number;
}

function characterKey(characterId: string): string {
  return `imageGenPromptPreset:character:${characterId}`;
}

function personaKey(personaId: string): string {
  return `imageGenPromptPreset:persona:${personaId}`;
}

function readBinding(userId: string, key: string): ImageGenPresetBinding | null {
  const s = settingsSvc.getSetting(userId, key);
  if (!s) return null;
  const value = s.value as ImageGenPresetBinding | null;
  if (!value?.preset_id) {
    settingsSvc.deleteSetting(userId, key);
    return null;
  }
  return value;
}

export function getCharacterBinding(
  userId: string,
  characterId: string,
): ImageGenPresetBinding | null {
  return readBinding(userId, characterKey(characterId));
}

export function setCharacterBinding(
  userId: string,
  characterId: string,
  presetId: string,
): ImageGenPresetBinding {
  const character = charactersSvc.getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");

  const binding: ImageGenPresetBinding = {
    preset_id: presetId,
    bound_at: Math.floor(Date.now() / 1000),
  };
  settingsSvc.putSetting(userId, characterKey(characterId), binding);
  return binding;
}

export function deleteCharacterBinding(
  userId: string,
  characterId: string,
): boolean {
  return settingsSvc.deleteSetting(userId, characterKey(characterId));
}

export function getPersonaBinding(
  userId: string,
  personaId: string,
): ImageGenPresetBinding | null {
  return readBinding(userId, personaKey(personaId));
}

export function setPersonaBinding(
  userId: string,
  personaId: string,
  presetId: string,
): ImageGenPresetBinding {
  const persona = personasSvc.getPersona(userId, personaId);
  if (!persona) throw new Error("Persona not found");

  const binding: ImageGenPresetBinding = {
    preset_id: presetId,
    bound_at: Math.floor(Date.now() / 1000),
  };
  settingsSvc.putSetting(userId, personaKey(personaId), binding);
  return binding;
}

export function deletePersonaBinding(
  userId: string,
  personaId: string,
): boolean {
  return settingsSvc.deleteSetting(userId, personaKey(personaId));
}

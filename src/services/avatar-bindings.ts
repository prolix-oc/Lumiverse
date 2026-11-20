import type { Character } from "../types/character";

export const AVATAR_BINDING_PRIMARY = "primary";
export const AVATAR_BINDING_FIELDS = ["description", "personality", "scenario"] as const;

export type AvatarBindingField = (typeof AVATAR_BINDING_FIELDS)[number];

export interface AvatarFieldBinding {
  description?: string | null;
  personality?: string | null;
  scenario?: string | null;
  greeting_index?: number | null;
}

export interface AlternateAvatarRecord {
  id: string;
  image_id: string;
  original_image_id?: string;
  label: string;
}

export type AvatarBindings = Record<string, AvatarFieldBinding>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function getAlternateAvatars(character: Character): AlternateAvatarRecord[] {
  const raw = character.extensions?.alternate_avatars;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is AlternateAvatarRecord =>
    isRecord(entry)
    && typeof entry.id === "string"
    && !!entry.id
    && typeof entry.image_id === "string"
    && !!entry.image_id
    && typeof entry.label === "string",
  );
}

export function getAvatarBindings(character: Character): AvatarBindings {
  const raw = character.extensions?.avatar_bindings;
  if (!isRecord(raw)) return {};

  const result: AvatarBindings = {};
  for (const [avatarId, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const binding: AvatarFieldBinding = {};
    for (const field of AVATAR_BINDING_FIELDS) {
      const selected = value[field];
      if (selected === null || typeof selected === "string") binding[field] = selected;
    }
    const greetingIndex = value.greeting_index;
    if (greetingIndex === null || (Number.isInteger(greetingIndex) && (greetingIndex as number) >= 0)) {
      binding.greeting_index = greetingIndex as number | null;
    }
    if (Object.keys(binding).length > 0) result[avatarId] = binding;
  }
  return result;
}

export function resolveAvatarImageId(character: Character, avatarEntryId: string): string | null | undefined {
  if (avatarEntryId === AVATAR_BINDING_PRIMARY) return character.image_id || null;
  return getAlternateAvatars(character).find((entry) => entry.id === avatarEntryId)?.image_id;
}

export function findAvatarForFieldBinding(
  character: Character,
  field: AvatarBindingField,
  variantId: string | null,
): string | null {
  const matches = Object.entries(getAvatarBindings(character))
    .filter(([, binding]) => Object.prototype.hasOwnProperty.call(binding, field) && binding[field] === variantId)
    .map(([avatarId]) => avatarId)
    .filter((avatarId) => resolveAvatarImageId(character, avatarId) !== undefined);
  return matches.length === 1 ? matches[0] : null;
}

export function findAvatarForGreetingBinding(character: Character, greetingIndex: number): string | null {
  const matches = Object.entries(getAvatarBindings(character))
    .filter(([, binding]) => binding.greeting_index === greetingIndex)
    .map(([avatarId]) => avatarId)
    .filter((avatarId) => resolveAvatarImageId(character, avatarId) !== undefined);
  return matches.length === 1 ? matches[0] : null;
}

import type { Persona } from "../types/persona";
import { resolvePersonaGlobalAddons } from "./global-addons.service";

export type PersonaAddonStateMap = Record<string, boolean>;
export type PersonaAddonToggleOrder = string[];

export interface PersonaAvatarInfo {
  image_id: string | null;
  avatar_path: string | null;
  avatar_crop_image_id: string | null;
  /** Present when the active avatar comes from a persona add-on. */
  addon_id?: string;
}

function sanitizeAddonStates(addonStates?: PersonaAddonStateMap): PersonaAddonStateMap | undefined {
  if (!addonStates || typeof addonStates !== "object") return undefined;
  const entries = Object.entries(addonStates).filter(
    ([id, enabled]) => !!id && typeof enabled === "boolean",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeAddonToggleOrder(order?: unknown): PersonaAddonToggleOrder | undefined {
  if (!Array.isArray(order)) return undefined;
  const seen = new Set<string>();
  const sanitized: string[] = [];
  for (const id of order) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    sanitized.push(id);
  }
  return sanitized.length > 0 ? sanitized : undefined;
}

export function getChatPersonaAddonStates(
  metadata: Record<string, any> | null | undefined,
  personaId: string | null | undefined,
): PersonaAddonStateMap | undefined {
  if (!personaId) return undefined;
  const statesByPersona = metadata?.persona_addon_states;
  if (!statesByPersona || typeof statesByPersona !== "object") return undefined;
  return sanitizeAddonStates(statesByPersona[personaId]);
}

/**
 * Returns add-on ids in the order they were last toggled for this persona.
 * The final id is the most recent toggle and therefore has avatar precedence.
 */
export function getChatPersonaAddonToggleOrder(
  metadata: Record<string, any> | null | undefined,
  personaId: string | null | undefined,
): PersonaAddonToggleOrder | undefined {
  if (!personaId) return undefined;
  return sanitizeAddonToggleOrder(metadata?.persona_addon_toggle_order?.[personaId]);
}

/**
 * Update the two chat metadata structures used by persona add-ons. Keeping
 * order beside the boolean state map makes avatar selection deterministic when
 * more than one enabled add-on supplies alternative art.
 */
export function withChatPersonaAddonState(
  metadata: Record<string, any> | null | undefined,
  personaId: string,
  addonId: string,
  enabled: boolean,
): Record<string, any> {
  const current = metadata && typeof metadata === "object" ? metadata : {};
  const statesByPersona = current.persona_addon_states && typeof current.persona_addon_states === "object"
    ? current.persona_addon_states
    : {};
  const existingStates = sanitizeAddonStates(statesByPersona[personaId]) ?? {};
  const orderByPersona = current.persona_addon_toggle_order && typeof current.persona_addon_toggle_order === "object"
    ? current.persona_addon_toggle_order
    : {};
  const existingOrder = sanitizeAddonToggleOrder(orderByPersona[personaId]) ?? [];

  return {
    ...current,
    persona_addon_states: {
      ...statesByPersona,
      [personaId]: { ...existingStates, [addonId]: enabled },
    },
    persona_addon_toggle_order: {
      ...orderByPersona,
      [personaId]: [...existingOrder.filter((id) => id !== addonId), addonId],
    },
    // A distinct value lets clients cache-bust a chat-scoped avatar URL after
    // a toggle, even when two writes land in the same updated_at second.
    persona_addon_avatar_versions: {
      ...(current.persona_addon_avatar_versions && typeof current.persona_addon_avatar_versions === "object"
        ? current.persona_addon_avatar_versions
        : {}),
      [personaId]: crypto.randomUUID(),
    },
  };
}

export function applyPersonaAddonStates(
  persona: Persona | null,
  addonStates?: PersonaAddonStateMap,
): Persona | null {
  const states = sanitizeAddonStates(addonStates);
  if (!persona || !states) return persona;

  const metadata = persona.metadata || {};
  const addons = Array.isArray(metadata.addons)
    ? metadata.addons.map((addon: any) => (
        addon?.id in states ? { ...addon, enabled: states[addon.id] } : addon
      ))
    : metadata.addons;
  const attachedGlobalAddons = Array.isArray(metadata.attached_global_addons)
    ? metadata.attached_global_addons.map((ref: any) => (
        ref?.id in states ? { ...ref, enabled: states[ref.id] } : ref
      ))
    : metadata.attached_global_addons;

  return {
    ...persona,
    metadata: {
      ...metadata,
      ...(Array.isArray(metadata.addons) ? { addons } : {}),
      ...(Array.isArray(metadata.attached_global_addons) ? { attached_global_addons: attachedGlobalAddons } : {}),
    },
  };
}

/** Whether an id refers to a local or attached global add-on on this persona. */
export function personaHasAddon(persona: Persona | null, addonId: string): boolean {
  if (!persona || !addonId) return false;
  const metadata = persona.metadata ?? {};
  return [metadata.addons, metadata.attached_global_addons].some(
    (addons) => Array.isArray(addons) && addons.some((addon: any) => addon?.id === addonId),
  );
}

/**
 * Resolve the avatar currently represented by a persona. Add-on avatar
 * bindings are persona-owned and only apply while that add-on is enabled. If
 * multiple bindings are active, the final item in the chat's toggle order
 * wins. Older chats without ordering data retain a stable metadata-order
 * fallback, with the last configured add-on winning.
 */
export function resolvePersonaAvatarInfo(
  persona: Persona | null,
  addonStates?: PersonaAddonStateMap,
  addonToggleOrder?: PersonaAddonToggleOrder,
): PersonaAvatarInfo | null {
  if (!persona) return null;

  const metadata = persona.metadata ?? {};
  const states = sanitizeAddonStates(addonStates) ?? {};
  const candidates = [metadata.addons, metadata.attached_global_addons]
    .flatMap((addons) => Array.isArray(addons) ? addons : [])
    .filter((addon: any) => addon && typeof addon.id === "string")
    .map((addon: any) => ({
      id: addon.id as string,
      enabled: addon.id in states ? states[addon.id] : addon.enabled === true,
      image_id: typeof addon.avatar_image_id === "string" ? addon.avatar_image_id : null,
      avatar_crop_image_id: typeof addon.avatar_crop_image_id === "string"
        ? addon.avatar_crop_image_id
        : null,
    }))
    .filter((addon) => addon.image_id || addon.avatar_crop_image_id);

  const byId = new Map(candidates.map((addon) => [addon.id, addon]));
  const order = sanitizeAddonToggleOrder(addonToggleOrder) ?? [];
  for (let i = order.length - 1; i >= 0; i--) {
    const addon = byId.get(order[i]);
    if (!addon?.enabled) continue;
    return {
      image_id: addon.image_id,
      avatar_path: null,
      avatar_crop_image_id: addon.avatar_crop_image_id,
      addon_id: addon.id,
    };
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const addon = candidates[i];
    if (!addon.enabled) continue;
    return {
      image_id: addon.image_id,
      avatar_path: null,
      avatar_crop_image_id: addon.avatar_crop_image_id,
      addon_id: addon.id,
    };
  }

  const avatarCropImageId = typeof metadata.avatar_crop_image_id === "string"
    ? metadata.avatar_crop_image_id
    : null;
  return {
    image_id: persona.image_id || null,
    avatar_path: persona.avatar_path || null,
    avatar_crop_image_id: avatarCropImageId,
  };
}

/**
 * Resolve a persona for rendering `{{persona}}` in a chat context: overlay the
 * chat's per-persona add-on binding overrides on top of the persona's stored
 * defaults, then resolve attached global add-ons into `_resolvedGlobalAddons`.
 *
 * Use this anywhere `{{persona}}` is resolved with a chat in scope (macro
 * preview/resolve, display regex, Spindle) so add-on visibility matches the
 * chat's bindings rather than the persona defaults. The main generation
 * pipeline applies the equivalent overlay via `ctx.personaAddonStates`. Pass
 * `chatMetadata` as null/undefined when there is no chat (character-only or
 * persona-only contexts) — only global add-on resolution is applied then.
 */
export function resolvePersonaForChatMacros(
  userId: string,
  persona: Persona | null,
  chatMetadata: Record<string, any> | null | undefined,
): Persona | null {
  const states = getChatPersonaAddonStates(chatMetadata, persona?.id);
  const withStates = applyPersonaAddonStates(persona, states);
  return resolvePersonaGlobalAddons(userId, withStates);
}

import type { Persona } from "../types/persona";
import { resolvePersonaGlobalAddons } from "./global-addons.service";

export type PersonaAddonStateMap = Record<string, boolean>;

function sanitizeAddonStates(addonStates?: PersonaAddonStateMap): PersonaAddonStateMap | undefined {
  if (!addonStates || typeof addonStates !== "object") return undefined;
  const entries = Object.entries(addonStates).filter(
    ([id, enabled]) => !!id && typeof enabled === "boolean",
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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

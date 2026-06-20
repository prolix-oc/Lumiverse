/**
 * Build a portable snapshot of the user's *active persona* for multiplayer:
 * their persona NAME (so room names = persona names), their EFFECTIVE
 * description (base + enabled add-ons, resolved exactly like the backend's
 * `buildPersonaWithAddons`), and their persona AVATAR compressed to a small WebP
 * **data URL**.
 *
 * Why a data URL: persona-avatar endpoints are user-scoped, so a URL only
 * resolves for the owner — other participants can't fetch it. Embedding a small
 * compressed copy lets every client (local or relayed) render the avatar.
 *
 * Why flatten add-ons here: a peer's persona is relayed to the HOST, which can't
 * see the peer's add-on/global-add-on rows. We resolve the effective text on the
 * peer side (where the data lives) and ship the merged description, so the host's
 * generation reflects exactly what the peer has toggled on.
 */

import { useStore } from '@/store'
import { getPersonaAvatarLargeUrlById } from '@/lib/avatarUrls'
import { compressAvatarToWebP } from '@/lib/webpAvatar'
import { globalAddonsApi } from '@/api/global-addons'
import type { PersonaSnapshot } from '@/types/multiplayer'
import type { Persona, PersonaAddon, GlobalAddon, AttachedGlobalAddon } from '@/types/api'

const MAX_DATA_URL_LEN = 24 * 1024 // mirrors the backend cap

type AddonStateMap = Record<string, boolean>

function asAddonArray(raw: unknown): PersonaAddon[] {
  return Array.isArray(raw) ? (raw as PersonaAddon[]) : []
}
function asGlobalRefArray(raw: unknown): AttachedGlobalAddon[] {
  return Array.isArray(raw) ? (raw as AttachedGlobalAddon[]) : []
}

/**
 * The active persona's per-chat add-on overrides (set when the user toggles an
 * add-on in real time). Lives in the active chat's metadata, mirrored into the
 * store by InputArea.
 */
function activeChatAddonOverrides(personaId: string): AddonStateMap {
  const meta = useStore.getState().activeChatMetadata as
    | { persona_addon_states?: Record<string, AddonStateMap> }
    | undefined
  return meta?.persona_addon_states?.[personaId] ?? {}
}

/**
 * Effective enabled-state for every add-on attached to the persona: the persona/
 * global-add-on defaults, overlaid with any live per-chat toggles. Mirrors the
 * merge in InputArea so the relayed text matches what the user sees.
 */
function resolveEffectiveAddonStates(persona: Persona, overrides: AddonStateMap): AddonStateMap {
  const states: AddonStateMap = {}
  for (const a of asAddonArray(persona.metadata?.addons)) states[a.id] = a.enabled
  for (const r of asGlobalRefArray(persona.metadata?.attached_global_addons)) states[r.id] = r.enabled
  Object.assign(states, overrides)
  return states
}

/**
 * A stable signature of the active persona's effective add-on enabled-state.
 * The relay subscription keys on this so a real-time add-on toggle re-sends the
 * snapshot (the persona id alone is unchanged by a toggle).
 */
export function activePersonaAddonSignature(): string {
  const s = useStore.getState()
  const persona = s.personas.find((p) => p.id === s.activePersonaId)
  if (!persona) return ''
  const states = resolveEffectiveAddonStates(persona, activeChatAddonOverrides(persona.id))
  return Object.keys(states)
    .sort()
    .map((id) => `${id}:${states[id] ? 1 : 0}`)
    .join(',')
}

/** Resolve base description + enabled add-ons into one string (≈ buildPersonaWithAddons). */
async function buildEffectiveDescription(persona: Persona): Promise<string> {
  const base = (persona.description || '').trim()
  const states = resolveEffectiveAddonStates(persona, activeChatAddonOverrides(persona.id))

  const personaContent = asAddonArray(persona.metadata?.addons)
    .filter((a) => (states[a.id] ?? a.enabled) && a.content)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .map((a) => (a.content || '').trim())
    .filter(Boolean)

  const enabledGlobalIds = asGlobalRefArray(persona.metadata?.attached_global_addons)
    .filter((r) => states[r.id] ?? r.enabled)
    .map((r) => r.id)

  let globalContent: string[] = []
  if (enabledGlobalIds.length > 0) {
    try {
      const res = await globalAddonsApi.list({ limit: 200, offset: 0 })
      const byId = new Map(res.data.map((g) => [g.id, g] as const))
      globalContent = enabledGlobalIds
        .map((id) => byId.get(id))
        .filter((g): g is GlobalAddon => !!g)
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((g) => (g.content || '').trim())
        .filter(Boolean)
    } catch {
      // Global add-ons unreachable — fall back to base + persona add-ons.
    }
  }

  const all = [...personaContent, ...globalContent]
  if (all.length === 0) return base
  return base ? `${base}\n${all.join('\n')}` : all.join('\n')
}

/** Snapshot the active persona (name + effective description + pronouns + WebP avatar). */
export async function buildActivePersonaSnapshot(): Promise<PersonaSnapshot | null> {
  const s = useStore.getState()
  const persona = s.personas.find((p) => p.id === s.activePersonaId)
  if (!persona) return null

  const description = await buildEffectiveDescription(persona)

  const snapshot: PersonaSnapshot = {
    name: persona.name,
    description: description || undefined,
    pronouns: {
      subjective: persona.subjective_pronoun,
      objective: persona.objective_pronoun,
      possessive: persona.possessive_pronoun,
    },
    avatarUrl: null,
  }

  if (persona.image_id) {
    try {
      const src = getPersonaAvatarLargeUrlById(persona.id, persona.image_id)
      const blob = await compressAvatarToWebP(src, 128, 0.72)
      const dataUrl = await blobToDataUrl(blob)
      if (dataUrl.length <= MAX_DATA_URL_LEN) snapshot.avatarUrl = dataUrl
    } catch {
      // Avatar load/compress failed — fall back to name only.
    }
  }

  return snapshot
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('avatar read failed'))
    r.readAsDataURL(blob)
  })
}

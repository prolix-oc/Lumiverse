/**
 * Build a portable snapshot of the user's *active persona* for multiplayer:
 * their persona NAME (so room names = persona names) and their persona AVATAR
 * compressed to a small WebP **data URL**.
 *
 * Why a data URL: persona-avatar endpoints are user-scoped, so a URL only
 * resolves for the owner — other participants can't fetch it. Embedding a small
 * compressed copy lets every client (local or relayed) render the avatar.
 */

import { useStore } from '@/store'
import { getPersonaAvatarLargeUrlById } from '@/lib/avatarUrls'
import { compressAvatarToWebP } from '@/lib/webpAvatar'
import type { PersonaSnapshot } from '@/types/multiplayer'

const MAX_DATA_URL_LEN = 24 * 1024 // mirrors the backend cap

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('avatar read failed'))
    r.readAsDataURL(blob)
  })
}

/** Snapshot the active persona (name + pronouns + a compressed WebP data-URL avatar). */
export async function buildActivePersonaSnapshot(): Promise<PersonaSnapshot | null> {
  const s = useStore.getState()
  const persona = s.personas.find((p) => p.id === s.activePersonaId)
  if (!persona) return null

  const snapshot: PersonaSnapshot = {
    name: persona.name,
    description: persona.description || undefined,
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

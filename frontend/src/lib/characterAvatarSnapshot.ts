/**
 * Compress a chat's CHARACTER (bot) avatar to a small WebP **data URL** so room
 * peers can render it. Like persona avatars, the character-avatar endpoint is
 * owner-scoped (and unreachable cross-instance for relayed peers), so a URL
 * alone won't resolve for anyone but the host — we embed a compressed copy.
 *
 * Built on the HOST and relayed via room_join → hydration, mirroring
 * buildActivePersonaSnapshot.
 */

import { useStore } from '@/store'
import { getCharacterAvatarLargeUrlById } from '@/lib/avatarUrls'
import { compressAvatarToWebP } from '@/lib/webpAvatar'

const MAX_DATA_URL_LEN = 24 * 1024 // mirrors the backend cap

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('avatar read failed'))
    r.readAsDataURL(blob)
  })
}

/** A compressed WebP data URL of the character's avatar, or null if none/too big. */
export async function buildCharacterAvatarSnapshot(
  characterId: string | null | undefined,
): Promise<string | null> {
  if (!characterId) return null
  const character = useStore.getState().characters.find((c) => c.id === characterId)
  if (!character?.image_id) return null
  try {
    const src = getCharacterAvatarLargeUrlById(characterId, character.image_id)
    const blob = await compressAvatarToWebP(src, 128, 0.72)
    const dataUrl = await blobToDataUrl(blob)
    return dataUrl.length <= MAX_DATA_URL_LEN ? dataUrl : null
  } catch {
    return null
  }
}

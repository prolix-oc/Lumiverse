import { ApiError } from '@/api/client'
import { presetsApi } from '@/api/presets'
import i18n from '@/i18n'
import { toast } from '@/lib/toast'
import { createNewLoomPreset, marshalPreset } from './service'
import { InvalidLoomPresetError, unmarshalPresetForEditor } from './preset-validation'
import type { LoomPreset } from './types'

export async function resolveLoomPresetSelection(presetId: string, currentPresetId: string | null, isCurrent: () => boolean) {
  try {
    unmarshalPresetForEditor(await presetsApi.get(presetId))
    return { presetId }
  } catch (error) {
    if (!(error instanceof InvalidLoomPresetError)) throw error
    if (!isCurrent()) return null
    console.warn('[Loom] Rejected malformed preset selection:', presetId, error)
    const fallback = await findLoomPresetFallback(presetId, currentPresetId ?? undefined, isCurrent)
    if (!fallback || !isCurrent()) return null
    toast.warning(fallback.id === currentPresetId
      ? i18n.t('loomBuilder.toast.invalidPresetSelection', { ns: 'panels' })
      : i18n.t('loomBuilder.toast.presetRecovered', { ns: 'panels', name: fallback.name }))
    return { presetId: fallback.id, recoverFromPresetId: currentPresetId ?? undefined }
  }
}

/** Read candidates individually: a corrupt row must not poison recovery of the whole registry. */
export async function findLoomPresetFallback(
  failedPresetId: string,
  preferredPresetId: string | undefined,
  isCurrent: () => boolean,
): Promise<LoomPreset | null> {
  const attempted = new Set([failedPresetId])
  const read = async (id: string): Promise<LoomPreset | null> => {
    if (attempted.has(id) || !isCurrent()) return null
    attempted.add(id)
    try {
      return unmarshalPresetForEditor(await presetsApi.get(id))
    } catch (error) {
      if (error instanceof InvalidLoomPresetError || (error instanceof ApiError && error.status === 404)) return null
      throw error
    }
  }

  if (preferredPresetId) {
    const previous = await read(preferredPresetId)
    if (previous && isCurrent()) return previous
  }

  let offset = 0
  while (isCurrent()) {
    const page = await presetsApi.listRegistry({ provider: 'loom', limit: 200, offset })
    // The built-in starts with this name, but still needs validation because it is editable.
    const candidates = [...page.data].sort((a, b) => Number(b.name === 'Default') - Number(a.name === 'Default'))
    for (const candidate of candidates) {
      const preset = await read(candidate.id)
      if (preset && isCurrent()) return preset
      if (!isCurrent()) return null
    }
    offset += page.data.length
    if (page.data.length === 0 || offset >= page.total) break
  }
  if (!isCurrent()) return null

  // Keep the damaged presets intact. A fresh factory preset provides a safe final fallback.
  const created = await presetsApi.create(marshalPreset(createNewLoomPreset(i18n.t('loomBuilder.recoveryPresetName', { ns: 'panels' }))))
  return isCurrent() ? unmarshalPresetForEditor(created) : null
}

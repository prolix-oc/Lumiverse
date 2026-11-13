import { useState, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import type { ImageGenConnectionProfile } from '@/types/api'
import type { LoraEntry, LoraPreset } from '@/types/store'
import { uuidv7 } from '@/lib/uuid'
import { toast } from '@/lib/toast'
import { snapRangeValue } from '@/components/shared/rangeSliderMath'
import { useLoraDiscovery, type DraftLoraEntry, type LoraModelLoader } from '../imageGenLoraEditor'
const LORA_WEIGHT_MIN = 0
const LORA_WEIGHT_MAX = 1.5
const LORA_WEIGHT_STEP = 0.05
const LORA_DEFAULT_WEIGHT = 1
const LORA_STRENGTH_SCALE_MIN = 0
const LORA_STRENGTH_SCALE_MAX = 2
const LORA_STRENGTH_SCALE_STEP = 0.05
const EMPTY_LORA_PRESETS: LoraPreset[] = []

const loadImageGenModels: LoraModelLoader = (id, subtype) => imageGenConnectionsApi.modelsBySubtype(id, subtype)
function loraPresetToDraft(preset: LoraPreset | null): DraftLoraEntry[] {
  return preset?.loras.map((lora) => {
    const weightModel = Number.isFinite(lora.weight_model) ? String(lora.weight_model) : String(LORA_DEFAULT_WEIGHT)
    const weightClipFallback = Number.isFinite(lora.weight_model) ? lora.weight_model : LORA_DEFAULT_WEIGHT
    return {
      draftId: uuidv7(),
      lora_name: lora.lora_name,
      weight_model: weightModel,
      weight_clip: lora.weight_clip === undefined ? '' : String(Number.isFinite(lora.weight_clip) ? lora.weight_clip : weightClipFallback),
    }
  }) ?? []
}

function parseDraftLoraWeight(value: string): number | null {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return snapRangeValue(parsed, {
    min: LORA_WEIGHT_MIN,
    max: LORA_WEIGHT_MAX,
    step: LORA_WEIGHT_STEP,
  })
}


export function useImageGenLoraEditor(activeConnection: ImageGenConnectionProfile | null) {
  const { t } = useTranslation('panels')
  const imageGeneration = useStore((s) => s.imageGeneration)
  const setImageGenSettings = useStore((s) => s.setImageGenSettings)
  const [loraPresetName, setLoraPresetName] = useState('')
  const [draftLoras, setDraftLoras] = useState<DraftLoraEntry[]>([])
  const [draftLoraBaseTags, setDraftLoraBaseTags] = useState('')
  const [loadedLoraPresetId, setLoadedLoraPresetId] = useState<string | null>(null)
  const [confirmDeleteLoraPreset, setConfirmDeleteLoraPreset] = useState(false)
  const loraPresets = imageGeneration.loraPresets ?? EMPTY_LORA_PRESETS

  const loadedLoraPreset = useMemo(
    () => (loadedLoraPresetId ? loraPresets.find((p) => p.id === loadedLoraPresetId) ?? null : null),
    [loadedLoraPresetId, loraPresets],
  )

  useEffect(() => {
    const activeId = imageGeneration.activeLoraPresetId || null
    const preset = activeId ? loraPresets.find((p) => p.id === activeId) ?? null : null
    setLoadedLoraPresetId(preset?.id ?? null)
    setDraftLoras(loraPresetToDraft(preset))
    setDraftLoraBaseTags(preset?.base_tags ?? '')
    setLoraPresetName('')
  }, [imageGeneration.activeLoraPresetId, loraPresets])

  const loraDiscovery = useLoraDiscovery(
    activeConnection,
    loadImageGenModels,
    t('imageGenPanel.fetchLorasFailed'),
  )
  const supportsLoraDiscovery = loraDiscovery.supportsDiscovery
  const addDraftLora = useCallback(() => {
    setDraftLoras((current) => [
      ...current,
      {
        draftId: uuidv7(),
        lora_name: '',
        weight_model: String(LORA_DEFAULT_WEIGHT),
        weight_clip: '',
      },
    ])
  }, [])


  const pickLoraPreset = useCallback((presetId: string | null) => {
    if (!presetId) {
      setLoadedLoraPresetId(null)
      setDraftLoras([])
      setDraftLoraBaseTags('')
      setLoraPresetName('')
      setImageGenSettings({ activeLoraPresetId: null })
      return
    }

    const preset = loraPresets.find((p) => p.id === presetId)
    if (!preset) return

    setLoadedLoraPresetId(preset.id)
    setDraftLoras(loraPresetToDraft(preset))
    setDraftLoraBaseTags(preset.base_tags ?? '')
    setLoraPresetName('')
    setImageGenSettings({ activeLoraPresetId: preset.id })
  }, [loraPresets, setImageGenSettings])

  const saveLoraPreset = useCallback(() => {
    const loraNames = draftLoras.map((draft) => draft.lora_name.trim())
    if (!loraNames.some(Boolean)) {
      toast.error(t('imageGenPanel.pickLoraBeforeSave'))
      return
    }

    if (loraNames.some((loraName) => !loraName)) {
      toast.error(t('imageGenPanel.pickLoraFilenameBeforeSave'))
      return
    }

    const nextLoras: LoraEntry[] = []

    for (const [index, draft] of draftLoras.entries()) {
      const loraName = loraNames[index] ?? ''
      const weightModel = parseDraftLoraWeight(draft.weight_model)
      const weightClip = parseDraftLoraWeight(draft.weight_clip)
      if (weightModel === null || (draft.weight_clip.trim() && weightClip === null)) {
        toast.error(t('imageGenPanel.loraWeightsMustBeNumbers'))
        return
      }

      const entry: LoraEntry = {
        lora_name: loraName,
        weight_model: weightModel,
      }
      if (draft.weight_clip.trim()) entry.weight_clip = weightClip ?? weightModel
      nextLoras.push(entry)
    }

    if (nextLoras.length === 0) {
      toast.error(t('imageGenPanel.pickLoraBeforeSave'))
      return
    }

    const existingId = loadedLoraPresetId
    const nextPreset: LoraPreset = {
      id: existingId || uuidv7(),
      name: loraPresetName.trim() || loadedLoraPreset?.name || t('imageGenPanel.loraPresetsSection'),
      loras: nextLoras,
      base_tags: draftLoraBaseTags.trim() || undefined,
    }
    const next = existingId
      ? loraPresets.map((preset) => (preset.id === existingId ? nextPreset : preset))
      : [...loraPresets, nextPreset]

    setImageGenSettings({
      loraPresets: next,
      activeLoraPresetId: nextPreset.id,
    })
    setLoadedLoraPresetId(nextPreset.id)
    setLoraPresetName('')
    toast.success(t('imageGenPanel.loraPresetSaved'))
  }, [
    draftLoraBaseTags,
    draftLoras,
    loadedLoraPreset,
    loadedLoraPresetId,
    loraPresetName,
    loraPresets,
    setImageGenSettings,
    t,
  ])

  const deleteLoraPreset = useCallback(() => {
    if (!loadedLoraPresetId) return
    setConfirmDeleteLoraPreset(false)
    const id = loadedLoraPresetId
    const next = loraPresets.filter((preset) => preset.id !== id)
    setImageGenSettings({
      loraPresets: next,
      activeLoraPresetId: imageGeneration.activeLoraPresetId === id ? null : imageGeneration.activeLoraPresetId ?? null,
    })
    setLoadedLoraPresetId(null)
    setDraftLoras([])
    setDraftLoraBaseTags('')
    setLoraPresetName('')
  }, [imageGeneration.activeLoraPresetId, loadedLoraPresetId, loraPresets, setImageGenSettings])

  const loraPresetOptions = useMemo(() => [
    { value: '', label: t('imageGenPanel.noActiveLoraPreset') },
    ...loraPresets.map((preset) => ({ value: preset.id, label: preset.name })),
  ], [loraPresets, t])

  const loraFilenameOptions = useMemo(() => {
    const seen = new Set<string>()
    const manualOptions: { value: string; label: string; sublabel?: string }[] = []
    const discoveredOptions: { value: string; label: string; sublabel?: string }[] = []
    for (const lora of loraDiscovery.loras) {
      if (seen.has(lora.id)) continue
      seen.add(lora.id)
      discoveredOptions.push({ value: lora.id, label: lora.label, sublabel: lora.id })
    }
    for (const draft of draftLoras) {
      const value = draft.lora_name.trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      manualOptions.push({ value, label: value })
    }
    return [...manualOptions, ...discoveredOptions]
  }, [loraDiscovery.loras, draftLoras])

  return {
    loraPresetName,
    setLoraPresetName,
    draftLoras,
    setDraftLoras,
    draftLoraBaseTags,
    setDraftLoraBaseTags,
    loadedLoraPresetId,
    loadedLoraPreset,
    confirmDeleteLoraPreset,
    setConfirmDeleteLoraPreset,
    pickLoraPreset,
    saveLoraPreset,
    deleteLoraPreset,
    addDraftLora,
    loraPresetOptions,
    loraFilenameOptions,
    loraDiscovery,
    supportsLoraDiscovery,
  }
}
export type ImageGenLoraEditor = ReturnType<typeof useImageGenLoraEditor>

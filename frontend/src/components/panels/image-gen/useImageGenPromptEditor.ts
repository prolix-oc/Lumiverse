import { useState, useRef, useMemo, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { imageGenPresetBindingsApi } from '@/api/image-gen'
import type { ImageGenPromptPreset } from '@/types/store'
import { uuidv7 } from '@/lib/uuid'
export function useImageGenPromptEditor(setError: (message: string | null) => void) {
  const { t } = useTranslation('panels')
  const imageGeneration = useStore((s) => s.imageGeneration)
  const setImageGenSettings = useStore((s) => s.setImageGenSettings)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const [presetName, setPresetName] = useState('')
  const [captionParser, setCaptionParser] = useState<Pick<ImageGenPromptPreset, 'parserConnectionId' | 'parserModel' | 'parserParameters'>>({})
  const updateCaptionParser = (patch: Partial<typeof captionParser>) => setCaptionParser((previous) => ({ ...previous, ...patch }))
  const [editTarget, setEditTarget] = useState<'main' | 'character' | 'persona' | 'captioning'>('main')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [draftNegative, setDraftNegative] = useState('')
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null)
  const [confirmDeletePreset, setConfirmDeletePreset] = useState(false)
  const [characterPresetId, setCharacterPresetId] = useState<string | null>(null)
  const [personaPresetId, setPersonaPresetId] = useState<string | null>(null)
  const promptPresets = useMemo(() => imageGeneration.promptPresets || [], [imageGeneration.promptPresets])
  const mainPresets = useMemo(() => promptPresets.filter((p) => (p.kind ?? 'main') === 'main'), [promptPresets])
  const characterPresets = useMemo(() => promptPresets.filter((p) => p.kind === 'character'), [promptPresets])
  const personaPresets = useMemo(() => promptPresets.filter((p) => p.kind === 'persona'), [promptPresets])
  const captioningPresets = useMemo(() => promptPresets.filter((p) => p.kind === 'captioning'), [promptPresets])
  // Load this character's bound preset whenever the active character changes.
  useEffect(() => {
    if (!activeCharacterId) {
      setCharacterPresetId(null)
      return
    }
    let cancelled = false
    imageGenPresetBindingsApi
      .getCharacterBinding(activeCharacterId)
      .then((binding) => {
        if (!cancelled) setCharacterPresetId(binding?.preset_id ?? null)
      })
      .catch(() => {
        if (!cancelled) setCharacterPresetId(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeCharacterId])

  // Load this persona's bound preset whenever the active persona changes.
  useEffect(() => {
    if (!activePersonaId) {
      setPersonaPresetId(null)
      return
    }
    let cancelled = false
    imageGenPresetBindingsApi
      .getPersonaBinding(activePersonaId)
      .then((binding) => {
        if (!cancelled) setPersonaPresetId(binding?.preset_id ?? null)
      })
      .catch(() => {
        if (!cancelled) setPersonaPresetId(null)
      })
    return () => {
      cancelled = true
    }
  }, [activePersonaId])

  const loadedPreset = useMemo(
    () => (loadedPresetId ? promptPresets.find((p) => p.id === loadedPresetId) ?? null : null),
    [loadedPresetId, promptPresets],
  )

  // Re-hydrate the editor textareas whenever the edit target (or its bindings)
  // changes. For main, the editor mirrors the live customPrompt; for
  // character/persona, it mirrors the bound preset (or stays blank).
  // The live custom prompt/negative are read through refs so the effect does
  // not re-run on every keystroke while the user is editing.
  const customPromptRef = useRef(imageGeneration.customPrompt)
  customPromptRef.current = imageGeneration.customPrompt
  const customNegativePromptRef = useRef(imageGeneration.customNegativePrompt)
  customNegativePromptRef.current = imageGeneration.customNegativePrompt
  const previousTarget = useRef(editTarget)
  useEffect(() => {
    const changedTarget = previousTarget.current !== editTarget
    previousTarget.current = editTarget
    if (editTarget === 'main') {
      const activeId = imageGeneration.activePromptPresetId || null
      const activePreset = activeId ? mainPresets.find((p) => p.id === activeId) : null
      setLoadedPresetId(activePreset?.id ?? null)
      setDraftPrompt(customPromptRef.current || '')
      setDraftNegative(customNegativePromptRef.current || '')
    } else if (editTarget === 'character') {
      const preset = characterPresetId ? characterPresets.find((p) => p.id === characterPresetId) : null
      setLoadedPresetId(preset?.id ?? null)
      setDraftPrompt(preset?.prompt || '')
      setDraftNegative(preset?.negativePrompt || '')
    } else if (editTarget === 'persona') {
      const preset = personaPresetId ? personaPresets.find((p) => p.id === personaPresetId) : null
      setLoadedPresetId(preset?.id ?? null)
      setDraftPrompt(preset?.prompt || '')
      setDraftNegative(preset?.negativePrompt || '')
    } else if (editTarget === 'captioning' && changedTarget) {
      setCaptionParser({})
      setLoadedPresetId(null)
      setDraftPrompt('')
      setDraftNegative('')
    }
    setPresetName('')
  }, [editTarget, imageGeneration.activePromptPresetId, characterPresetId, personaPresetId, promptPresets, mainPresets, characterPresets, personaPresets])

  // Typing only updates local state — keystrokes do NOT touch the store, so
  // the whole panel doesn't re-render mid-type. A debounced effect below
  // flushes the draft to settings for persistence, and handleGenerate flushes
  // synchronously before submitting.
  const onDraftPromptChange = useCallback((value: string) => {
    setDraftPrompt(value)
  }, [])

  const onDraftNegativeChange = useCallback((value: string) => {
    setDraftNegative(value)
  }, [])

  // Persist main-mode drafts to settings after typing pauses. Keeps the prompt
  // available on refresh / panel remount without causing per-keystroke
  // store updates.
  useEffect(() => {
    if (editTarget !== 'main') return
    const currentPrompt = imageGeneration.customPrompt || ''
    const currentNeg = imageGeneration.customNegativePrompt || ''
    if (draftPrompt === currentPrompt && draftNegative === currentNeg) return
    const timer = setTimeout(() => {
      setImageGenSettings({ customPrompt: draftPrompt, customNegativePrompt: draftNegative })
    }, 500)
    return () => clearTimeout(timer)
  }, [draftPrompt, draftNegative, editTarget, imageGeneration.customPrompt, imageGeneration.customNegativePrompt, setImageGenSettings])

  const bindCharacterPreset = useCallback(async (presetId: string | null) => {
    if (!activeCharacterId) return
    try {
      if (!presetId) {
        await imageGenPresetBindingsApi.deleteCharacterBinding(activeCharacterId).catch(() => {})
        setCharacterPresetId(null)
        return
      }
      const binding = await imageGenPresetBindingsApi.setCharacterBinding(activeCharacterId, presetId)
      setCharacterPresetId(binding.preset_id)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('imageGenPanel.failedUpdateCharacterBinding'))
    }
  }, [activeCharacterId, setError, t])

  const bindPersonaPreset = useCallback(async (presetId: string | null) => {
    if (!activePersonaId) return
    try {
      if (!presetId) {
        await imageGenPresetBindingsApi.deletePersonaBinding(activePersonaId).catch(() => {})
        setPersonaPresetId(null)
        return
      }
      const binding = await imageGenPresetBindingsApi.setPersonaBinding(activePersonaId, presetId)
      setPersonaPresetId(binding.preset_id)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('imageGenPanel.failedUpdatePersonaBinding'))
    }
  }, [activePersonaId, setError, t])

  // Unified picker: switches active main preset (and panel content) when
  // editing main, or binds/unbinds the active character/persona when editing
  // those targets. Selecting null clears the binding / active selection and
  // empties the editor for a fresh draft.
  const pickPreset = useCallback((presetId: string | null, target = editTarget) => {
    if (!presetId) {
      setLoadedPresetId(null)
      if (target === 'main') {
        setImageGenSettings({ activePromptPresetId: null, customPrompt: '', customNegativePrompt: '' })
        setDraftPrompt('')
        setDraftNegative('')
      } else if (target === 'character') {
        bindCharacterPreset(null)
        setDraftPrompt('')
        setDraftNegative('')
      } else if (target === 'persona') {
        bindPersonaPreset(null)
        setDraftPrompt('')
        setDraftNegative('')
      } else if (target === 'captioning') {
        setCaptionParser({})
        setDraftPrompt('')
        setDraftNegative('')
      }
      return
    }
    const preset = promptPresets.find((p) => p.id === presetId)
    if (!preset) return
    setLoadedPresetId(preset.id)
    setDraftPrompt(preset.prompt)
    setDraftNegative(preset.negativePrompt || '')
    if (target === 'main') {
      setImageGenSettings({
        activePromptPresetId: preset.id,
        promptMode: preset.mode,
        customPrompt: preset.prompt,
        customNegativePrompt: preset.negativePrompt || '',
      } as any)
    } else if (target === 'captioning') {
      setCaptionParser({ parserConnectionId: preset.parserConnectionId, parserModel: preset.parserModel, parserParameters: preset.parserParameters })
    } else if (target === 'character') {
      bindCharacterPreset(preset.id)
    } else if (target === 'persona') {
      bindPersonaPreset(preset.id)
    }
  }, [editTarget, promptPresets, setImageGenSettings, bindCharacterPreset, bindPersonaPreset])

  // Saves the textarea draft back to the loaded preset (or creates a new one
  // if nothing is loaded). The save side-effects are scoped to the edit
  // target: 'main' bumps the activePromptPresetId and writes to settings;
  // 'character'/'persona' rebind the new id to the active actor.
  const savePromptPreset = useCallback((asNew = false) => {
    const targetLabel = editTarget === 'main' ? t('imageGenPanel.imagePrompt') : editTarget === 'character' ? t('imageGenPanel.characterPreset') : editTarget === 'captioning' ? t('imageGenPanel.captioningPreset') : t('imageGenPanel.personaPreset')
    const name = presetName.trim() || loadedPreset?.name || targetLabel
    const existingId = asNew ? null : loadedPresetId
    const nextPreset: ImageGenPromptPreset = {
      id: existingId || uuidv7(),
      name,
      mode: imageGeneration.promptMode === 'parsed_custom' ? 'parsed_custom' : 'custom',
      prompt: draftPrompt,
      negativePrompt: draftNegative,
      ...(editTarget === 'captioning' ? captionParser : {}),
      kind: editTarget,
    }
    const next = existingId
      ? promptPresets.map((p) => (p.id === existingId ? nextPreset : p))
      : [...promptPresets, nextPreset]

    const updates: Partial<typeof imageGeneration> = { promptPresets: next }
    if (editTarget === 'main') {
      ;(updates as any).activePromptPresetId = nextPreset.id
      ;(updates as any).customPrompt = draftPrompt
      ;(updates as any).customNegativePrompt = draftNegative
    }
    setImageGenSettings(updates as any)
    setLoadedPresetId(nextPreset.id)
    setPresetName('')

    if (editTarget === 'character' && activeCharacterId) {
      void bindCharacterPreset(nextPreset.id)
    } else if (editTarget === 'persona' && activePersonaId) {
      void bindPersonaPreset(nextPreset.id)
    }
  }, [
    activeCharacterId,
    activePersonaId,
    captionParser,
    bindCharacterPreset,
    bindPersonaPreset,
    draftNegative,
    draftPrompt,
    editTarget,
    imageGeneration,
    loadedPreset,
    loadedPresetId,
    presetName,
    promptPresets,
    setImageGenSettings,
    t,
  ])

  const deletePromptPreset = useCallback(() => {
    if (!loadedPresetId) return
    setConfirmDeletePreset(false)
    const id = loadedPresetId
    const next = promptPresets.filter((p) => p.id !== id)
    const updates: Partial<typeof imageGeneration> = { promptPresets: next }
    if (editTarget === 'main' && imageGeneration.activePromptPresetId === id) {
      ;(updates as any).activePromptPresetId = null
    }
    setImageGenSettings(updates as any)
    setLoadedPresetId(null)
    setDraftPrompt('')
    setDraftNegative('')
    if (editTarget === 'character' && characterPresetId === id) {
      void bindCharacterPreset(null)
    } else if (editTarget === 'persona' && personaPresetId === id) {
      void bindPersonaPreset(null)
    }
  }, [
    bindCharacterPreset,
    bindPersonaPreset,
    characterPresetId,
    editTarget,
    imageGeneration.activePromptPresetId,
    loadedPresetId,
    personaPresetId,
    promptPresets,
    setImageGenSettings,
  ])
  const mainPresetOptions = useMemo(() => [
    { value: '', label: t('imageGenPanel.noSavedPrompt') },
    ...mainPresets.map((p) => ({ value: p.id, label: p.name })),
  ], [mainPresets, t])

  const characterPresetOptions = useMemo(() => [
    { value: '', label: t('imageGenPanel.noCharacterPreset') },
    ...characterPresets.map((p) => ({ value: p.id, label: p.name })),
  ], [characterPresets, t])

  const personaPresetOptions = useMemo(() => [
    { value: '', label: t('imageGenPanel.noPersonaPreset') },
    ...personaPresets.map((p) => ({ value: p.id, label: p.name })),
  ], [personaPresets, t])

  const captioningPresetOptions = useMemo(() => [
    { value: '', label: 'No captioning preset' },
    ...captioningPresets.map((p) => ({ value: p.id, label: p.name })),
  ], [captioningPresets])


  const pickMainPreset = (id: string | null) => { setEditTarget('main'); pickPreset(id, 'main') }
  return {
    presetName,
    setPresetName,
    captionParser,
    updateCaptionParser,
    editTarget,
    setEditTarget,
    draftPrompt,
    draftNegative,
    loadedPresetId,
    loadedPreset,
    confirmDeletePreset,
    setConfirmDeletePreset,
    onDraftPromptChange,
    onDraftNegativeChange,
    pickPreset,
    savePromptPreset,
    deletePromptPreset,
    promptPresets,
    mainPresetOptions,
    characterPresetOptions,
    personaPresetOptions,
    captioningPresetOptions,
    activeCharacterId,
    activePersonaId,
    pickMainPreset,
  }
}
export type ImageGenPromptEditor = ReturnType<typeof useImageGenPromptEditor>

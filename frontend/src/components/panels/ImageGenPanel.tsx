import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Image as ImageIcon, Settings2, Trash2, Plus, X, Workflow, Shuffle, Download, Upload } from 'lucide-react'
import { IconBrush } from '@tabler/icons-react'
import { useStore } from '@/store'
import { imageGenApi, imageGenPresetBindingsApi, type ComfyUICapabilities, type SceneData } from '@/api/image-gen'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import ImageGenProgressBar from './ImageGenProgressBar'
import { Toggle } from '@/components/shared/Toggle'
import { Button, FormField, Select, TextInput, EditorSection, TextArea } from '@/components/shared/FormComponents'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { LabeledRangeSlider } from '@/components/shared/RangeSlider'
import { useTouchActivate } from '@/hooks/useTouchActivate'
import ModelCombobox from './connection-manager/ModelCombobox'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import { getMacroCatalog } from '@/api/macros'
import { getAvailableMacros } from '@/lib/loom/service'
import type { MacroGroup } from '@/lib/loom/types'
import { uuidv7 } from '@/lib/uuid'
import { toast } from '@/lib/toast'
import ImageGenExportModal from './ImageGenExportModal'
import ImageLightbox from '@/components/shared/ImageLightbox'
import { ComfyWorkflowEditor } from './image-gen-connections/ComfyWorkflowEditor'
import { buildMappedFieldControls, type ComfyMappedFieldControl } from '@/lib/comfyui-mapped-fields'
import type { ComfyUIFieldMapping, ComfyUIWorkflowConfig } from '@/api/image-gen-connections'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { ImageGenProviderInfo, ImageGenParameterSchema } from '@/types/api'
import type { ImageGenPromptPreset } from '@/types/store'
import styles from './ImageGenPanel.module.css'

type RefImage = { data: string; mimeType?: string }
const COMFY_CUSTOM_CONTROL_PREFIX = 'custom:'
const DEFAULT_PROMPT_TIMEOUT_SECONDS = 60
const DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS = 300

function normalizeTimeoutSeconds(value: string, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(0, Math.floor(parsed))
}

function ToggleRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint?: string }) {
  return (
    <Toggle.Checkbox
      checked={checked}
      onChange={onChange}
      label={label}
      hint={hint}
      className={styles.toggle}
    />
  )
}

function toDataRef(file: File): Promise<RefImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const idx = result.indexOf(',')
      if (idx < 0) return reject(new Error('Invalid image file'))
      resolve({ data: result.slice(idx + 1), mimeType: file.type || 'image/png' })
    }
    reader.onerror = () => reject(new Error('Failed to read image file'))
    reader.readAsDataURL(file)
  })
}

function normalizeComfyControlValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value == null) return ''
  return String(value)
}

function parseComfyControlValue(control: ComfyMappedFieldControl, value: string): string | number | boolean | undefined {
  if (value === '') return undefined
  if (control.kind === 'number') return Number(value)
  if (control.options && typeof control.defaultValue === 'boolean') return value === 'true'
  return value
}

/**
 * Image-gen variant of the shared ModelCombobox. Lazy-loads the model list
 * from the provider via `imageGenConnectionsApi.modelsBySubtype` and surfaces
 * the standard searchable combobox UI used by Connections / TTS / STT panels.
 */
function ModelComboField({
  label,
  hint,
  paramKey,
  modelSubtype,
  connectionId,
  value,
  onChange,
}: {
  label: string
  hint: string
  paramKey: string
  modelSubtype: string
  connectionId: string | null
  value: any
  onChange: (key: string, value: any) => void
}) {
  const { t } = useTranslation('panels')
  const [models, setModels] = useState<Array<{ id: string; label: string }>>([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (!connectionId) return
    setLoading(true)
    try {
      const res = await imageGenConnectionsApi.modelsBySubtype(connectionId, modelSubtype)
      setModels(res.models ?? [])
    } catch {
      setModels([])
    } finally {
      setLoading(false)
    }
  }, [connectionId, modelSubtype])

  const modelIds = useMemo(() => models.map((m) => m.id), [models])
  const modelLabels = useMemo(() => {
    const labels: Record<string, string> = {}
    for (const m of models) labels[m.id] = m.label
    return labels
  }, [models])

  return (
    <FormField label={label} hint={hint}>
      <ModelCombobox
        value={typeof value === 'string' ? value : ''}
        onChange={(v) => onChange(paramKey, v || undefined)}
        models={modelIds}
        modelLabels={modelLabels}
        loading={loading}
        onRefresh={load}
        autoRefreshOnFocus
        refreshKey={connectionId ?? ''}
        disabled={!connectionId}
        placeholder={t('imageGenPanel.workflowOrConnectionDefault')}
        appearance="standard"
        emptyMessage={connectionId ? t('imageGenPanel.noModelsFound') : t('imageGenPanel.pickConnectionFirst')}
      />
    </FormField>
  )
}

/** Render a single parameter from the provider capability schema */
/** Raw Request Override editor — validates JSON inline so typos don't silently break generation. */
function RawOverrideField({
  label,
  schema,
  value,
  onChange,
}: {
  label: string
  schema: ImageGenParameterSchema
  value: any
  onChange: (value: string) => void
}) {
  const { t } = useTranslation('panels')
  const text = typeof value === 'string' ? value : ''
  let error: string | undefined
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        error = t('imageGenPanel.rawOverrideNotObject')
      }
    } catch {
      error = t('imageGenPanel.rawOverrideInvalidJson')
    }
  }
  return (
    <FormField label={label} hint={schema.description} error={error}>
      <TextArea rows={3} value={text} onChange={onChange} placeholder='{"steps": 30}' />
    </FormField>
  )
}

function ParamField({
  paramKey,
  schema,
  value,
  onChange,
  connectionId,
}: {
  paramKey: string
  schema: ImageGenParameterSchema
  value: any
  onChange: (key: string, value: any) => void
  connectionId?: string | null
}) {
  const displayName = paramKey
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()

  // Model-component fields get a combobox backed by the API
  if (schema.modelSubtype && schema.type === 'string') {
    return (
      <ModelComboField
        label={displayName}
        hint={schema.description}
        paramKey={paramKey}
        modelSubtype={schema.modelSubtype}
        connectionId={connectionId ?? null}
        value={value}
        onChange={onChange}
      />
    )
  }

  switch (schema.type) {
    case 'select':
      return (
        <FormField label={displayName} hint={schema.description}>
          <Select
            value={value ?? schema.default ?? ''}
            onChange={(v) => onChange(paramKey, v)}
            options={(schema.options || []).map((o) => ({ value: o.id, label: o.label }))}
          />
        </FormField>
      )

    case 'boolean':
      return (
        <FormField label="" hint={schema.description}>
          <ToggleRow
            checked={value ?? schema.default ?? false}
            onChange={(checked) => onChange(paramKey, checked)}
            label={displayName}
          />
        </FormField>
      )

    case 'number':
    case 'integer':
      if (schema.min !== undefined && schema.max !== undefined) {
        const numValue = value ?? schema.default ?? schema.min
        const step = schema.step ?? (schema.type === 'integer' ? 1 : 0.1)
        const isInt = schema.type === 'integer'
        return (
          <LabeledRangeSlider
            label={displayName}
            hint={schema.description}
            min={schema.min}
            max={schema.max}
            step={step}
            integer={isInt}
            value={numValue}
            formatValue={(v) => isInt ? String(v) : v.toFixed(step < 1 ? 2 : 1)}
            onCommit={(v) => onChange(paramKey, isInt ? Math.round(v) : v)}
          />
        )
      }
      if (schema.type === 'integer' && paramKey.toLowerCase() === 'seed') {
        return (
          <FormField label={displayName} hint={schema.description}>
            <div className={styles.inlineRow}>
              <TextInput
                className={styles.inlineGrow}
                value={value != null ? String(value) : ''}
                onChange={(v) => {
                  const parsed = parseInt(v)
                  onChange(paramKey, v === '' ? undefined : (isNaN(parsed) ? undefined : parsed))
                }}
                placeholder={schema.default != null ? String(schema.default) : ''}
              />
              <Button
                variant="secondary"
                size="sm"
                icon={<Shuffle size={14} />}
                onClick={() => onChange(paramKey, -1)}
              >
                Randomize
              </Button>
            </div>
          </FormField>
        )
      }
      return (
        <FormField label={displayName} hint={schema.description}>
          <TextInput
            value={value != null ? String(value) : ''}
            onChange={(v) => {
              const parsed = schema.type === 'integer' ? parseInt(v) : parseFloat(v)
              onChange(paramKey, v === '' ? undefined : (isNaN(parsed) ? undefined : parsed))
            }}
            placeholder={schema.default != null ? String(schema.default) : ''}
          />
        </FormField>
      )

    case 'string':
      if (paramKey === 'rawRequestOverride') {
        return (
          <RawOverrideField
            label={displayName}
            schema={schema}
            value={value}
            onChange={(v) => onChange(paramKey, v)}
          />
        )
      }
      if (schema.description?.toLowerCase().includes('prompt') || schema.description?.toLowerCase().includes('negative')) {
        return (
          <FormField label={displayName} hint={schema.description}>
            <TextArea
              rows={3}
              value={value ?? schema.default ?? ''}
              onChange={(v) => onChange(paramKey, v)}
              placeholder={schema.default != null ? String(schema.default) : ''}
            />
          </FormField>
        )
      }
      return (
        <FormField label={displayName} hint={schema.description}>
          <TextInput
            value={value ?? schema.default ?? ''}
            onChange={(v) => onChange(paramKey, v)}
          />
        </FormField>
      )

    default:
      return null
  }
}

export default function ImageGenPanel() {
  const { t } = useTranslation('panels')
  const imageGeneration = useStore((s) => s.imageGeneration)
  const sceneBackground = useStore((s) => s.sceneBackground)
  const sceneGenerating = useStore((s) => s.sceneGenerating)
  const activeChatId = useStore((s) => s.activeChatId)
  const setImageGenSettings = useStore((s) => s.setImageGenSettings)
  const setSceneBackground = useStore((s) => s.setSceneBackground)
  const setSceneGenerating = useStore((s) => s.setSceneGenerating)
  const openModal = useStore((s) => s.openModal)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activePersonaId = useStore((s) => s.activePersonaId)

  const imageGenProfiles = useStore((s) => s.imageGenProfiles)
  const activeImageGenConnectionId = useStore((s) => s.activeImageGenConnectionId)
  const setActiveImageGenConnection = useStore((s) => s.setActiveImageGenConnection)
  const setImageGenProfiles = useStore((s) => s.setImageGenProfiles)
  const setImageGenProviders = useStore((s) => s.setImageGenProviders)
  const imageGenProviders = useStore((s) => s.imageGenProviders)

  const [lastScene, setLastScene] = useState<SceneData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [generatedPreview, setGeneratedPreview] = useState<string | null>(null)
  const [presetName, setPresetName] = useState('')
  const [availableMacros, setAvailableMacros] = useState<MacroGroup[]>(() => getAvailableMacros())
  const [editTarget, setEditTarget] = useState<'main' | 'character' | 'persona' | 'captioning'>('main')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [draftNegative, setDraftNegative] = useState('')
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null)
  const [confirmDeletePreset, setConfirmDeletePreset] = useState(false)
  const [characterPresetId, setCharacterPresetId] = useState<string | null>(null)
  const [personaPresetId, setPersonaPresetId] = useState<string | null>(null)
  const [currentJobId, setCurrentJobId] = useState<string | null>(null)
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false)
  const [workflowConfig, setWorkflowConfig] = useState<ComfyUIWorkflowConfig | null>(null)
  const [workflowCapabilities, setWorkflowCapabilities] = useState<ComfyUICapabilities | null>(null)
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const refInputRef = useRef<HTMLInputElement | null>(null)
  const importConfigInputRef = useRef<HTMLInputElement | null>(null)
  const [exportModalOpen, setExportModalOpen] = useState(false)
  const [importConfigBusy, setImportConfigBusy] = useState(false)

  // Connection lists come from the store; only the image-gen provider registry
  // needs a refresh here.
  useEffect(() => {
    imageGenConnectionsApi.providers().then((res) => {
      if (res.providers?.length) setImageGenProviders(res.providers)
    }).catch(() => {})
  }, [setImageGenProviders])

  // Resolve active connection and its provider capabilities
  const activeConnection = useMemo(
    () => imageGenProfiles.find((p) => p.id === activeImageGenConnectionId) || null,
    [imageGenProfiles, activeImageGenConnectionId],
  )

  const providerInfo: ImageGenProviderInfo | null = useMemo(
    () => (activeConnection ? imageGenProviders.find((p) => p.id === activeConnection.provider) || null : null),
    [activeConnection, imageGenProviders],
  )

  const capabilities = providerInfo?.capabilities
  const providerName = activeConnection?.provider || ''
  const isComfyUI = providerName === 'comfyui'

  const comfyCustomControls = useMemo(() => {
    if (!isComfyUI || !workflowConfig) return []
    return buildMappedFieldControls(workflowConfig, workflowCapabilities)
      .filter((control) => control.key.startsWith(COMFY_CUSTOM_CONTROL_PREFIX))
  }, [isComfyUI, workflowConfig, workflowCapabilities])

  const refreshActiveComfyWorkflow = useCallback(async (forceRefresh = false) => {
    if (!activeConnection || activeConnection.provider !== 'comfyui') {
      setWorkflowConfig(null)
      setWorkflowCapabilities(null)
      setWorkflowError(null)
      return
    }

    setWorkflowLoading(true)
    setWorkflowError(null)
    try {
      const [configResponse, comfyCapabilities] = await Promise.all([
        imageGenConnectionsApi.getComfyUIWorkflowConfig(activeConnection.id),
        imageGenConnectionsApi.getComfyUICapabilities(activeConnection.id, forceRefresh),
      ])
      setWorkflowConfig(configResponse.config)
      setWorkflowCapabilities(comfyCapabilities)
    } catch (err: any) {
      setWorkflowConfig(null)
      setWorkflowCapabilities(null)
      setWorkflowError(err?.message || t('imageGenPanel.failedLoadWorkflow'))
    } finally {
      setWorkflowLoading(false)
    }
  }, [activeConnection])

  useEffect(() => {
    void refreshActiveComfyWorkflow()
  }, [refreshActiveComfyWorkflow])

  const refreshActiveImageGenConnection = useCallback(async () => {
    if (!activeConnection) return
    try {
      const updated = await imageGenConnectionsApi.get(activeConnection.id)
      setImageGenProfiles(imageGenProfiles.map((profile) => (profile.id === updated.id ? updated : profile)))
    } catch {
      // The workflow update already succeeded; stale metadata in the list is non-fatal.
    }
  }, [activeConnection, imageGenProfiles, setImageGenProfiles])

  const importComfyWorkflow = useCallback(async (workflow: unknown) => {
    if (!activeConnection) return null
    const response = await imageGenConnectionsApi.importComfyUIWorkflow(activeConnection.id, workflow)
    setWorkflowConfig(response.config)
    await refreshActiveImageGenConnection()
    return response.config
  }, [activeConnection, refreshActiveImageGenConnection])

  const updateComfyMappings = useCallback(async (mappings: ComfyUIFieldMapping[]) => {
    if (!activeConnection) return null
    const response = await imageGenConnectionsApi.updateComfyUIWorkflowMappings(activeConnection.id, mappings)
    setWorkflowConfig(response.config)
    await refreshActiveImageGenConnection()
    return response.config
  }, [activeConnection, refreshActiveImageGenConnection])

  // Group parameters by their group field
  const paramGroups = useMemo(() => {
    if (!capabilities) return { main: [], advanced: [], references: [], extra: [] as Array<{ name: string; params: Array<[string, ImageGenParameterSchema]> }> }
    const groups: Record<string, Array<[string, ImageGenParameterSchema]>> = {
      main: [],
      advanced: [],
      references: [],
    }
    const KNOWN_GROUPS = new Set(['main', 'advanced', 'references'])
    const extraGroups: Array<{ name: string; params: Array<[string, ImageGenParameterSchema]> }> = []
    const extraMap = new Map<string, Array<[string, ImageGenParameterSchema]>>()

    for (const [key, schema] of Object.entries(capabilities.parameters)) {
      const group = schema.group || 'main'
      if (KNOWN_GROUPS.has(group)) {
        groups[group].push([key, schema])
      } else {
        if (!extraMap.has(group)) extraMap.set(group, [])
        extraMap.get(group)!.push([key, schema])
      }
    }
    for (const [name, params] of extraMap) {
      extraGroups.push({ name, params })
    }
    return { ...groups, extra: extraGroups }
  }, [capabilities])

  // Provider parameters are saved on the active connection so they do not leak
  // across profiles that happen to use the same parameter names.
  const genParams: Record<string, any> = activeConnection?.default_parameters || {}

  const updateTop = (partial: Record<string, any>) => setImageGenSettings(partial)

  const updateParam = useCallback((key: string, value: any) => {
    if (!activeConnection) return

    const nextParams = { ...genParams }
    if (value === undefined || value === '') delete nextParams[key]
    else nextParams[key] = value

    const updatedConnection = { ...activeConnection, default_parameters: nextParams }
    setImageGenProfiles(imageGenProfiles.map((profile) => (profile.id === activeConnection.id ? updatedConnection : profile)))
    imageGenConnectionsApi.update(activeConnection.id, { default_parameters: nextParams }).catch(() => {
      refreshActiveImageGenConnection()
    })
  }, [activeConnection, genParams, imageGenProfiles, refreshActiveImageGenConnection, setImageGenProfiles])

  const updateComfyCustomControl = useCallback((control: ComfyMappedFieldControl, value: string) => {
    const customKey = control.key.slice(COMFY_CUSTOM_CONTROL_PREFIX.length)
    const existingFieldValues = genParams.comfyui_field_values && typeof genParams.comfyui_field_values === 'object'
      ? genParams.comfyui_field_values
      : {}
    const nextCustom = { ...(existingFieldValues.custom || {}) }
    const parsed = parseComfyControlValue(control, value)

    if (parsed === undefined) {
      delete nextCustom[customKey]
    } else {
      nextCustom[customKey] = parsed
    }

    updateParam('comfyui_field_values', {
      ...existingFieldValues,
      custom: nextCustom,
    })
  }, [genParams, updateParam])

  const readComfyCustomControlValue = useCallback((control: ComfyMappedFieldControl) => {
    const customKey = control.key.slice(COMFY_CUSTOM_CONTROL_PREFIX.length)
    const customValues = genParams.comfyui_field_values?.custom || {}
    return normalizeComfyControlValue(customValues[customKey] ?? control.defaultValue)
  }, [genParams.comfyui_field_values])

  const promptPresets = imageGeneration.promptPresets || []
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
  useEffect(() => {
    if (editTarget === 'main') {
      const activeId = imageGeneration.activePromptPresetId || null
      const activePreset = activeId ? mainPresets.find((p) => p.id === activeId) : null
      setLoadedPresetId(activePreset?.id ?? null)
      setDraftPrompt(imageGeneration.customPrompt || '')
      setDraftNegative(imageGeneration.customNegativePrompt || '')
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
    } else if (editTarget === 'captioning') {
      setLoadedPresetId(null)
      setDraftPrompt('')
      setDraftNegative('')
    }
    setPresetName('')
    // We intentionally exclude `imageGeneration.customPrompt`/`customNegativePrompt`
    // from deps — the editor itself is the source of truth for those when on
    // the 'main' target. Re-running on every keystroke would clobber the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTarget, imageGeneration.activePromptPresetId, characterPresetId, personaPresetId, promptPresets])

  // Mirror the Loom builder pattern: ship the full backend macro catalog into
  // the expandable editor so users can browse/insert macros that work inside
  // image-gen prompts ({{user}}, {{char}}, etc.).
  const refreshMacros = useCallback(() => {
    getMacroCatalog()
      .then((catalog) => {
        const groups: MacroGroup[] = catalog.categories.map((c) => ({
          category: c.category,
          macros: c.macros.map((m) => ({
            name: m.name,
            syntax: m.syntax,
            description: m.description,
            args: m.args,
            returns: m.returns,
          })),
        }))
        const apiCategoryNames = new Set(groups.map((g) => g.category))
        const localOnly = getAvailableMacros().filter((g) => !apiCategoryNames.has(g.category))
        setAvailableMacros([...groups, ...localOnly])
      })
      .catch(() => {
        // Keep the local fallback on failure.
      })
  }, [])

  useEffect(() => { refreshMacros() }, [refreshMacros])

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
  }, [activeCharacterId])

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
  }, [activePersonaId])

  // Unified picker: switches active main preset (and panel content) when
  // editing main, or binds/unbinds the active character/persona when editing
  // those targets. Selecting null clears the binding / active selection and
  // empties the editor for a fresh draft.
  const pickPreset = useCallback((presetId: string | null) => {
    if (!presetId) {
      setLoadedPresetId(null)
      if (editTarget === 'main') {
        setImageGenSettings({ activePromptPresetId: null, customPrompt: '', customNegativePrompt: '' })
        setDraftPrompt('')
        setDraftNegative('')
      } else if (editTarget === 'character') {
        bindCharacterPreset(null)
        setDraftPrompt('')
        setDraftNegative('')
      } else if (editTarget === 'persona') {
        bindPersonaPreset(null)
        setDraftPrompt('')
        setDraftNegative('')
      } else if (editTarget === 'captioning') {
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
    if (editTarget === 'main') {
      setImageGenSettings({
        activePromptPresetId: preset.id,
        promptMode: preset.mode,
        customPrompt: preset.prompt,
        customNegativePrompt: preset.negativePrompt || '',
        promptParserConnectionId: preset.parserConnectionId || null,
        promptParserModel: preset.parserModel || '',
        promptParserParameters: preset.parserParameters || {},
      } as any)
    } else if (editTarget === 'character') {
      bindCharacterPreset(preset.id)
    } else if (editTarget === 'persona') {
      bindPersonaPreset(preset.id)
    }
  }, [editTarget, promptPresets, setImageGenSettings, bindCharacterPreset, bindPersonaPreset])

  // Saves the textarea draft back to the loaded preset (or creates a new one
  // if nothing is loaded). The save side-effects are scoped to the edit
  // target: 'main' bumps the activePromptPresetId and writes to settings;
  // 'character'/'persona' rebind the new id to the active actor.
  const savePromptPreset = useCallback(() => {
    const targetLabel = editTarget === 'main' ? t('imageGenPanel.imagePrompt') : editTarget === 'character' ? t('imageGenPanel.characterPreset') : editTarget === 'captioning' ? t('imageGenPanel.captioningPreset') : t('imageGenPanel.personaPreset')
    const name = presetName.trim() || loadedPreset?.name || targetLabel
    const existingId = loadedPresetId
    const nextPreset: ImageGenPromptPreset = {
      id: existingId || uuidv7(),
      name,
      mode: imageGeneration.promptMode === 'parsed_custom' ? 'parsed_custom' : 'custom',
      prompt: draftPrompt,
      negativePrompt: draftNegative,
      parserConnectionId: (editTarget === 'main' || editTarget === 'captioning') ? (imageGeneration.promptParserConnectionId || null) : null,
      parserModel: (editTarget === 'main' || editTarget === 'captioning') ? (imageGeneration.promptParserModel || '') : '',
      parserParameters: (editTarget === 'main' || editTarget === 'captioning') ? (imageGeneration.promptParserParameters || {}) : {},
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

  const handleImportConfigFile: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportConfigBusy(true)
    try {
      const payload = JSON.parse(await file.text())
      const res = await imageGenApi.importConfig(payload)
      // The backend already persisted the merged settings; this re-syncs the store.
      setImageGenSettings(res.settings)
      if (res.imported.connections > 0) {
        const list = await imageGenConnectionsApi.list({ limit: 100, offset: 0 })
        setImageGenProfiles(list.data)
      }
      toast.success(t('imageGenPanel.importSuccess', {
        presets: res.imported.presets,
        connections: res.imported.connections,
      }))
      for (const issue of res.errors || []) toast.error(issue)
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('imageGenPanel.importFailed'))
    } finally {
      setImportConfigBusy(false)
    }
  }

  // Reference images are provider parameters and stay scoped to this connection.
  const currentRefs: RefImage[] = genParams.referenceImages || []
  const setCurrentRefs = (next: RefImage[]) => {
    updateParam('referenceImages', next)
  }

  // Providers that accept image input: NovelAI/NanoGPT (style references) plus
  // the img2img providers, which reuse the same reference-image config surface.
  const supportsImg2ImgSource = providerName === 'swarmui' || providerName === 'comfyui' || providerName === 'google_gemini' || providerName === 'openrouter' || providerName === 'openai' || providerName === 'sdapi'
  const supportsRefs = providerName === 'novelai' || providerName === 'nanogpt' || supportsImg2ImgSource

  const runGenerationCall = useCallback(async (input: {
    chatId: string
    forceGeneration: boolean
    promptMode: 'scene' | 'custom' | 'parsed_custom'
    prompt: string
    negativePrompt: string
    promptPresetId: string | null
    outputTarget: 'background' | 'chat_attachment' | 'preview' | 'attach_to_message'
    attachToMessageId?: string
    skipParse?: boolean
  }) => {
    const jobId = uuidv7()
    setCurrentJobId(jobId)
    setSceneGenerating(true)
    try {
      const res = await imageGenApi.generate({
        chatId: input.chatId,
        forceGeneration: input.forceGeneration,
        promptMode: input.promptMode,
        prompt: input.prompt,
        negativePrompt: input.negativePrompt,
        promptPresetId: input.promptPresetId,
        outputTarget: input.outputTarget,
        attachToMessageId: input.attachToMessageId,
        skipParse: input.skipParse,
        clientJobId: jobId,
        promptGenerationTimeoutSeconds: imageGeneration.promptGenerationTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS,
        generationTimeoutSeconds: imageGeneration.generationTimeoutSeconds ?? DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS,
      })
      setLastScene(res.scene || null)
      if (res.generated && res.imageDataUrl) {
        if (input.outputTarget === 'background') {
          setSceneBackground(res.imageDataUrl)
          setGeneratedPreview(null)
        } else {
          setGeneratedPreview(res.imageDataUrl)
        }
      }
      if (!res.generated && res.reason) setError(res.reason)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('imageGenPanel.imageGenerationFailed'))
    } finally {
      setSceneGenerating(false)
      setCurrentJobId(null)
    }
  }, [imageGeneration.promptGenerationTimeoutSeconds, imageGeneration.generationTimeoutSeconds, setSceneBackground, setSceneGenerating])

  const handleGenerate = async (forceGeneration = false) => {
    if (!activeChatId) {
      setError(t('imageGenPanel.openChatFirst'))
      return
    }

    setError(null)

    const promptMode = (imageGeneration.promptMode || 'scene') as 'scene' | 'custom' | 'parsed_custom'
    const outputTarget = (imageGeneration.outputTarget || 'background') as 'background' | 'chat_attachment' | 'preview' | 'attach_to_message'
    const promptPresetId = imageGeneration.activePromptPresetId || null

    // Capture "the latest message at click time" so the attach-to-message
    // semantics are tied to what the user saw when they pressed Generate.
    let attachToMessageId: string | undefined
    if (outputTarget === 'attach_to_message') {
      const messages = useStore.getState().messages
      const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
      if (!lastMessage) {
        setError(t('imageGenPanel.noMessageToAttach'))
        return
      }
      attachToMessageId = lastMessage.id
    }

    // Flush any pending draft text into settings before submitting so we never
    // miss the user's latest keystrokes inside the 500ms debounce window.
    if (editTarget === 'main') {
      const needsFlush =
        draftPrompt !== (imageGeneration.customPrompt || '') ||
        draftNegative !== (imageGeneration.customNegativePrompt || '')
      if (needsFlush) {
        setImageGenSettings({ customPrompt: draftPrompt, customNegativePrompt: draftNegative })
      }
    }

    const livePrompt = editTarget === 'main' ? draftPrompt : (imageGeneration.customPrompt || '')
    const liveNegative = editTarget === 'main' ? draftNegative : (imageGeneration.customNegativePrompt || '')

    const baseInput = {
      chatId: activeChatId,
      forceGeneration,
      promptMode,
      prompt: livePrompt,
      negativePrompt: liveNegative,
      promptPresetId,
      outputTarget,
      attachToMessageId,
    }

    // Optional preview-and-edit flow: ask the backend to resolve the outgoing
    // prompt first, open the modal, then run generation with skipParse=true on
    // confirm so the edited text is sent verbatim.
    if (imageGeneration.previewPromptBeforeGenerate) {
      setSceneGenerating(true)
      try {
        const previewRes = await imageGenApi.previewPrompt({
          chatId: activeChatId,
          promptMode,
          prompt: livePrompt,
          negativePrompt: liveNegative,
          promptPresetId,
          promptGenerationTimeoutSeconds: imageGeneration.promptGenerationTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS,
        })
        setSceneGenerating(false)
        openModal('imagePromptPreview', {
          chatId: activeChatId,
          initialPrompt: previewRes.prompt,
          initialNegativePrompt: previewRes.negativePrompt || '',
          initialPromptMode: promptMode,
          initialPromptPresetId: promptPresetId,
          promptGenerationTimeoutSeconds: imageGeneration.promptGenerationTimeoutSeconds,
          onCancel: () => {},
          onConfirm: (editedPrompt: string, editedNegative: string) => {
            void runGenerationCall({
              ...baseInput,
              prompt: editedPrompt,
              negativePrompt: editedNegative,
              skipParse: true,
            })
          },
        })
        return
      } catch (err: any) {
        setSceneGenerating(false)
        setError(err?.body?.error || err?.message || t('imageGenPanel.promptPreviewFailed'))
        return
      }
    }

    await runGenerationCall(baseInput)
  }

  // The Generate buttons sit directly below the prompt textareas. On Android,
  // tapping them blurs the input and dismisses the keyboard, which reflows the
  // layout and moves the button before the synthetic click lands (the click is
  // then dropped — the button only flashes). Activate on pointerup instead.
  const genDisabled = sceneGenerating || !activeChatId || !activeImageGenConnectionId
  const generateNowTap = useTouchActivate(() => handleGenerate(false), genDisabled)
  const forceGenerateTap = useTouchActivate(() => handleGenerate(true), genDisabled)

  const onPickRefs = () => refInputRef.current?.click()
  const onRefFiles: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    try {
      const added = await Promise.all(files.slice(0, Math.max(0, 14 - currentRefs.length)).map(toDataRef))
      setCurrentRefs([...currentRefs, ...added])
    } catch {
      setError(t('imageGenPanel.failedLoadReferences'))
    } finally {
      e.target.value = ''
    }
  }

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

  // Resolve the model ID to a human-readable label
  const modelLabel = useMemo(() => {
    if (!activeConnection?.model) return null
    const staticModel = capabilities?.staticModels?.find((m) => m.id === activeConnection.model)
    return staticModel?.label || activeConnection.model
  }, [activeConnection?.model, capabilities?.staticModels])

  const previewSrc = generatedPreview || sceneBackground

  return (
    <div className={styles.panel}>
      <ToggleRow
        checked={!!imageGeneration.enabled}
        onChange={(checked) => updateTop({ enabled: checked })}
        label={t('imageGenPanel.enable')}
        hint={t('imageGenPanel.enableHint')}
      />

      <FormField label="Image Captioner" hint="Upload an image and generate descriptive tags using your parser model. Useful for creating character or scene prompts from reference images.">
        <Button variant="secondary" size="sm" onClick={() => useStore.getState().openModal('imageCaptioner', {})}>
          Open Captioner
        </Button>
      </FormField>

      <EditorSection title={t('imageGenPanel.importExport')} Icon={Settings2} defaultExpanded={false}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="secondary" size="sm" onClick={() => setExportModalOpen(true)}>
            <Download size={14} /> {t('imageGenPanel.exportConfig')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => importConfigInputRef.current?.click()}
            disabled={importConfigBusy}
          >
            <Upload size={14} /> {t('imageGenPanel.importConfig')}
          </Button>
        </div>
        <input
          ref={importConfigInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={handleImportConfigFile}
        />
      </EditorSection>

      <ImageGenExportModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        presets={promptPresets}
      />

      {imageGeneration.enabled && (
        <>
          {/* Connection Profile Selector */}
          <FormField label={t('imageGenPanel.connection')} hint={imageGenProfiles.length === 0 ? t('imageGenPanel.createConnectionFirst') : undefined}>
            <ConnectionSelect
              kind="imageGen"
              value={activeImageGenConnectionId || ''}
              onChange={(value) => setActiveImageGenConnection(value || null)}
              placeholder={t('imageGenPanel.selectConnection')}
              searchPlaceholder={t('imageGenPanel.searchConnections')}
              ariaLabel={t('imageGenPanel.connection')}
              clearable
              clearLabel={t('imageGenPanel.noConnection')}
            />
            {activeConnection && (
              <div style={{ fontSize: 11, color: 'var(--lumiverse-text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {providerInfo?.name || activeConnection.provider}
                {modelLabel && <> &middot; {modelLabel}</>}
              </div>
            )}
          </FormField>

          <EditorSection title={t('imageGenPanel.promptMode')} Icon={IconBrush}>
            <FormField label={t('imageGenPanel.mode')} hint={t('imageGenPanel.modeHint')}>
              <Select
                value={imageGeneration.promptMode || 'scene'}
                onChange={(value) => updateTop({ promptMode: value })}
                options={[
                  { value: 'scene', label: t('imageGenPanel.sceneTool') },
                  { value: 'custom', label: t('imageGenPanel.customPrompt') },
                  { value: 'parsed_custom', label: t('imageGenPanel.chatAwareCustom') },
                ]}
              />
            </FormField>

            <FormField label={t('imageGenPanel.output')} hint={t('imageGenPanel.outputHint')}>
              <Select
                value={imageGeneration.outputTarget || 'background'}
                onChange={(value) => updateTop({ outputTarget: value })}
                options={[
                  { value: 'background', label: t('imageGenPanel.setAsBackground') },
                  { value: 'chat_attachment', label: t('imageGenPanel.insertIntoChat') },
                  { value: 'attach_to_message', label: t('imageGenPanel.attachToLastMessage') },
                  { value: 'preview', label: t('imageGenPanel.previewOnly') },
                ]}
              />
            </FormField>

            {(imageGeneration.promptMode === 'custom' || imageGeneration.promptMode === 'parsed_custom') && (
              <>
                <FormField
                  label={t('imageGenPanel.editing')}
                  hint={t('imageGenPanel.editingHint')}
                >
                  <Select
                    value={editTarget}
                    onChange={(value) => setEditTarget(value as 'main' | 'character' | 'persona' | 'captioning')}
                    options={[
                      { value: 'main', label: t('imageGenPanel.mainPreset') },
                      { value: 'character', label: t('imageGenPanel.characterPreset') },
                      { value: 'persona', label: t('imageGenPanel.personaPreset') },
                      { value: 'captioning', label: t('imageGenPanel.captioningPreset') },
                    ]}
                  />
                </FormField>

                <FormField
                  label={editTarget === 'main' ? t('imageGenPanel.activeMainPreset') : editTarget === 'character' ? t('imageGenPanel.boundCharacterPreset') : editTarget === 'captioning' ? t('imageGenPanel.boundCaptioningPreset') : t('imageGenPanel.boundPersonaPreset')}
                  hint={
                    editTarget === 'main'
                      ? t('imageGenPanel.pickMainPresetHint')
                      : editTarget === 'character'
                        ? activeCharacterId
                          ? t('imageGenPanel.pickCharacterPresetHint')
                          : t('imageGenPanel.openChatBindPreset')
                        : editTarget === 'captioning'
                          ? t('imageGenPanel.pickCaptioningPresetHint')
                          : activePersonaId
                            ? t('imageGenPanel.pickPersonaPresetHint')
                            : t('imageGenPanel.selectActivePersona')
                  }
                >
                  <Select
                    value={loadedPresetId || ''}
                    onChange={(value) => pickPreset(value || null)}
                    options={
                      editTarget === 'main' ? mainPresetOptions : editTarget === 'character' ? characterPresetOptions : editTarget === 'captioning' ? captioningPresetOptions : personaPresetOptions
                    }
                  />
                </FormField>

                <FormField
                  label={
                    editTarget === 'main'
                      ? (imageGeneration.promptMode === 'parsed_custom' ? t('imageGenPanel.parserInstructions') : t('imageGenPanel.prompt'))
                      : editTarget === 'character' ? t('imageGenPanel.characterSnippet')
                      : editTarget === 'captioning' ? t('imageGenPanel.captioningInstructions')
                      : t('imageGenPanel.personaSnippet')
                  }
                  hint={
                    editTarget === 'main'
                      ? (imageGeneration.promptMode === 'parsed_custom'
                          ? t('imageGenPanel.parserInstructionsHint')
                          : t('imageGenPanel.sentDirectlyHint'))
                      : editTarget === 'character'
                        ? t('imageGenPanel.characterSnippetHint')
                        : editTarget === 'captioning'
                          ? t('imageGenPanel.captioningInstructionsHint')
                          : t('imageGenPanel.personaSnippetHint')
                  }
                >
                  <ExpandableTextarea
                    className={styles.promptTextarea}
                    value={draftPrompt}
                    onChange={onDraftPromptChange}
                    title={loadedPreset ? t('imageGenPanel.editingPresetTitle', { name: loadedPreset.name }) : t('imageGenPanel.editTargetPromptTitle', { target: editTarget })}
                    placeholder={
                      editTarget === 'main'
                        ? (imageGeneration.promptMode === 'parsed_custom'
                            ? t('imageGenPanel.parserPromptExample')
                            : t('imageGenPanel.describeImage'))
                        : editTarget === 'character'
                          ? '1girl, long red hair, leather jacket'
                          : editTarget === 'captioning'
                            ? 'Describe this image in detail using concise image-generation tags. Include subject, composition, style, lighting, mood, and colors.'
                            : 'middle-aged man, glasses, beige coat'
                    }
                    rows={5}
                    macros={availableMacros}
                    onRefreshMacros={refreshMacros}
                  />
                  {editTarget === 'main' && /\{\{\s*character_prompt\s*\}\}/i.test(draftPrompt) && (
                    <div className={styles.editorTargetBanner}>
                      <code>{'{{character_prompt}}'}</code> {t('imageGenPanel.characterPromptMacroHint')}
                    </div>
                  )}
                  {editTarget === 'main' && /\{\{\s*persona_prompt\s*\}\}/i.test(draftPrompt) && (
                    <div className={styles.editorTargetBanner}>
                      <code>{'{{persona_prompt}}'}</code> {t('imageGenPanel.personaPromptMacroHint')}
                    </div>
                  )}
                </FormField>

                <FormField
                  label={editTarget === 'main' ? t('imageGenPanel.negativePrompt') : `${editTarget === 'character' ? t('imageGenPanel.character') : editTarget === 'captioning' ? t('imageGenPanel.captioning') : t('imageGenPanel.persona')} ${t('imageGenPanel.negativeSnippet')}`}
                  hint={
                    editTarget === 'main'
                      ? undefined
                      : t('imageGenPanel.negativeSnippetHint', { target: editTarget })
                  }
                >
                  <ExpandableTextarea
                    className={styles.promptTextarea}
                    value={draftNegative}
                    onChange={onDraftNegativeChange}
                    title={loadedPreset ? t('imageGenPanel.editingPresetNegativeTitle', { name: loadedPreset.name }) : t('imageGenPanel.editTargetNegativeTitle', { target: editTarget })}
                    placeholder={t('imageGenPanel.optionalNegativePrompt')}
                    rows={3}
                    macros={availableMacros}
                    onRefreshMacros={refreshMacros}
                  />
                </FormField>

                <div className={styles.inlineRow}>
                  <TextInput
                    value={presetName}
                    onChange={setPresetName}
                    placeholder={loadedPreset ? t('imageGenPanel.renamePreset', { name: loadedPreset.name }) : t('imageGenPanel.newPresetName', { target: editTarget })}
                  />
                  <Button variant="secondary" size="sm" onClick={savePromptPreset}>
                    {loadedPresetId ? t('imageGenPanel.saveChanges') : t('imageGenPanel.saveAsNew')}
                  </Button>
                  {loadedPresetId && <Button variant="danger" size="sm" onClick={() => setConfirmDeletePreset(true)}>{t('imageGenPanel.delete')}</Button>}
                </div>

                {confirmDeletePreset && (
                  <ConfirmationModal
                    isOpen={true}
                    title={t('imageGenPanel.deletePresetConfirmTitle')}
                    message={t('imageGenPanel.deletePresetConfirmMessage', { name: loadedPreset?.name })}
                    variant="danger"
                    confirmText={t('imageGenPanel.delete')}
                    onConfirm={deletePromptPreset}
                    onCancel={() => setConfirmDeletePreset(false)}
                  />
                )}
                {loadedPreset && (
                  <div className={styles.editorTargetBanner}>
                    {t('imageGenPanel.editing')} <strong>{loadedPreset.name}</strong> ({editTarget})
                    {editTarget === 'character' && activeCharacterId && ` · ${t('imageGenPanel.boundToActiveCharacter')}`}
                    {editTarget === 'persona' && activePersonaId && ` · ${t('imageGenPanel.boundToActivePersona')}`}
                  </div>
                )}
              </>
            )}

          </EditorSection>

          {(imageGeneration.promptMode === 'scene' || imageGeneration.promptMode === 'parsed_custom') && (
            <EditorSection title={t('imageGenPanel.promptParser')} Icon={Settings2} defaultExpanded={imageGeneration.promptMode === 'parsed_custom'}>
              <FormField label={t('imageGenPanel.parserConnection')} hint={t('imageGenPanel.parserConnectionHint')}>
                <ConnectionSelect
                  kind="llm"
                  value={imageGeneration.promptParserConnectionId || ''}
                  onChange={(value) => updateTop({ promptParserConnectionId: value || null })}
                  withModel
                  seedDefaultModel={false}
                  modelValue={imageGeneration.promptParserModel || ''}
                  onModelChange={(value) => updateTop({ promptParserModel: value })}
                  placeholder={t('imageGenPanel.useSidecarOrSelect')}
                  searchPlaceholder={t('imageGenPanel.searchConnections')}
                  emptyMessage={t('imageGenPanel.noLlmConnections')}
                  ariaLabel={t('imageGenPanel.parserConnection')}
                  modelPlaceholder={t('imageGenPanel.useConnectionDefault')}
                  modelEmptyMessage={t('imageGenPanel.noModelsReturned')}
                  modelNoConnectionMessage={t('imageGenPanel.pickParserConnectionFirst')}
                  modelAppearance="standard"
                  portal
                />
              </FormField>

              <LabeledRangeSlider
                label={t('imageGenPanel.parserTemperature')}
                min={0}
                max={2}
                step={0.05}
                value={imageGeneration.promptParserParameters?.temperature ?? 0.4}
                formatValue={(v) => v.toFixed(2)}
                onCommit={(v) => updateTop({ promptParserParameters: { ...(imageGeneration.promptParserParameters || {}), temperature: v } })}
              />

              <LabeledRangeSlider
                label={t('imageGenPanel.parserTopP')}
                min={0}
                max={1}
                step={0.05}
                value={imageGeneration.promptParserParameters?.top_p ?? 1}
                formatValue={(v) => v.toFixed(2)}
                onCommit={(v) => updateTop({ promptParserParameters: { ...(imageGeneration.promptParserParameters || {}), top_p: v } })}
              />

              <FormField label={t('imageGenPanel.parserMaxTokens')}>
                <TextInput
                  value={String(imageGeneration.promptParserParameters?.max_tokens ?? '')}
                  onChange={(value) => updateTop({ promptParserParameters: { ...(imageGeneration.promptParserParameters || {}), max_tokens: value ? Number(value) : undefined } })}
                  placeholder={t('imageGenPanel.useConnectionDefault')}
                />
              </FormField>
            </EditorSection>
          )}

          <EditorSection title={t('imageGenPanel.timeouts')} Icon={Settings2} defaultExpanded={false}>
            <FormField label={t('imageGenPanel.promptGenerationTimeout')} hint={t('imageGenPanel.promptGenerationTimeoutHint')}>
              <TextInput
                type="number"
                min={0}
                step={1}
                value={String(imageGeneration.promptGenerationTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS)}
                onChange={(value) => updateTop({ promptGenerationTimeoutSeconds: normalizeTimeoutSeconds(value, DEFAULT_PROMPT_TIMEOUT_SECONDS) })}
              />
            </FormField>

            <FormField label={t('imageGenPanel.imageGenerationTimeout')} hint={t('imageGenPanel.imageGenerationTimeoutHint')}>
              <TextInput
                type="number"
                min={0}
                step={1}
                value={String(imageGeneration.generationTimeoutSeconds ?? DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS)}
                onChange={(value) => updateTop({ generationTimeoutSeconds: normalizeTimeoutSeconds(value, DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS) })}
              />
            </FormField>
          </EditorSection>

          {/* Dynamic Generation Parameters from Provider Schema */}
          {activeConnection && capabilities && (
            <>
              {isComfyUI && (
                <EditorSection title={t('imageGenPanel.comfyWorkflow')} Icon={Workflow} defaultExpanded={!workflowConfig}>
                  <div className={styles.workflowCard}>
                    <div className={styles.workflowInfo}>
                      <span className={styles.workflowTitle}>
                        {workflowConfig ? t('imageGenPanel.workflowImported') : t('imageGenPanel.noWorkflowSelected')}
                      </span>
                      <span className={styles.workflowMeta}>
                        {workflowConfig
                          ? t('imageGenPanel.workflowMappedMeta', {
                              count: workflowConfig.field_mappings.length,
                              format: workflowConfig.workflow_format === 'ui_workflow'
                                ? t('imageGenPanel.workflowFormatUi')
                                : t('imageGenPanel.workflowFormatApi'),
                            })
                          : t('imageGenPanel.importWorkflowHint')}
                      </span>
                    </div>
                    <div className={styles.workflowActions}>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Workflow size={14} />}
                        onClick={() => {
                          setWorkflowEditorOpen(true)
                          void refreshActiveComfyWorkflow(true)
                        }}
                        disabled={workflowLoading}
                      >
                        {workflowConfig ? t('imageGenPanel.editWorkflow') : t('imageGenPanel.importWorkflow')}
                      </Button>
                    </div>
                  </div>
                  {comfyCustomControls.length > 0 && (
                    <div className={styles.workflowCustomFields}>
                      {comfyCustomControls.map((control) => {
                        const value = readComfyCustomControlValue(control)
                        return (
                            <FormField key={control.key} label={control.label} hint={t('imageGenPanel.exposedFromWorkflow')}>
                            {control.options ? (
                              <Select
                                value={value}
                                onChange={(next) => updateComfyCustomControl(control, next)}
                                options={[
                                  { value: '', label: t('imageGenPanel.workflowDefault') },
                                  ...control.options,
                                ]}
                              />
                            ) : (
                              <TextInput
                                type={control.kind === 'number' ? 'number' : 'text'}
                                value={value}
                                onChange={(next) => updateComfyCustomControl(control, next)}
                                placeholder={normalizeComfyControlValue(control.defaultValue)}
                              />
                            )}
                          </FormField>
                        )
                      })}
                    </div>
                  )}
                  {workflowError && <div className={styles.error}>{workflowError}</div>}
                </EditorSection>
              )}

              {/* Main parameters */}
              {paramGroups.main.map(([key, schema]) => (
                <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} connectionId={activeImageGenConnectionId} />
              ))}

              {/* Advanced parameters */}
              {paramGroups.advanced.length > 0 && (
                <EditorSection title={t('imageGenPanel.advanced')} Icon={Settings2} defaultExpanded={false}>
                  {paramGroups.advanced.map(([key, schema]) => (
                    <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} connectionId={activeImageGenConnectionId} />
                  ))}
                </EditorSection>
              )}

              {/* Extra parameter groups (e.g. "models" for SwarmUI) */}
              {paramGroups.extra.map(({ name, params }) => (
                <EditorSection key={name} title={name.charAt(0).toUpperCase() + name.slice(1)} Icon={Settings2} defaultExpanded={false}>
                  {params.map(([key, schema]) => (
                    <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} connectionId={activeImageGenConnectionId} />
                  ))}
                </EditorSection>
              ))}

              {/* Reference / source images — NovelAI & NanoGPT style references,
                  plus img2img init images for SwarmUI / ComfyUI / Gemini. */}
              {supportsRefs && (
                <EditorSection title={t(providerName === 'novelai' ? 'imageGenPanel.directorReferences' : 'imageGenPanel.references')} Icon={IconBrush} defaultExpanded={false}>
                  {supportsImg2ImgSource && (
                    <>
                      <ToggleRow
                        checked={!!genParams.includeCharacterAvatar}
                        onChange={(checked) => updateParam('includeCharacterAvatar', checked)}
                        label={t('imageGenPanel.includeCharacterAvatar')}
                        hint={t('imageGenPanel.includeCharacterAvatarHint')}
                      />
                      <ToggleRow
                        checked={!!genParams.includePersonaAvatar}
                        onChange={(checked) => updateParam('includePersonaAvatar', checked)}
                        label={t('imageGenPanel.includePersonaAvatar')}
                        hint={t('imageGenPanel.includePersonaAvatarHint')}
                      />
                    </>
                  )}
                  {providerName === 'novelai' && (
                    <>
                      <ToggleRow
                        checked={!!genParams.includeCharacterAvatar}
                        onChange={(checked) => updateParam('includeCharacterAvatar', checked)}
                        label={t('imageGenPanel.includeCharacterAvatar')}
                        hint={t('imageGenPanel.includeCharacterAvatarHint')}
                      />
                      <ToggleRow
                        checked={!!genParams.includePersonaAvatar}
                        onChange={(checked) => updateParam('includePersonaAvatar', checked)}
                        label={t('imageGenPanel.includePersonaAvatar')}
                        hint={t('imageGenPanel.includePersonaAvatarHint')}
                      />
                      <LabeledRangeSlider
                        label={t('imageGenPanel.referenceStrength')}
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceStrength ?? 0.5}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceStrength', v)}
                      />
                      <LabeledRangeSlider
                        label={t('imageGenPanel.informationExtracted')}
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceInfoExtracted ?? 1}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceInfoExtracted', v)}
                      />
                      <LabeledRangeSlider
                        label={t('imageGenPanel.referenceFidelity')}
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceFidelity ?? 1}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceFidelity', v)}
                      />

                      {(genParams.includeCharacterAvatar || genParams.includePersonaAvatar) && (
                      <FormField label={t('imageGenPanel.avatarReferenceType')}>
                          <Select
                            value={genParams.avatarReferenceType || 'character'}
                            onChange={(value) => updateParam('avatarReferenceType', value)}
                            options={[
                              { value: 'character', label: t('imageGenPanel.characterOnly') },
                              { value: 'style', label: t('imageGenPanel.styleOnly') },
                              { value: 'character&style', label: t('imageGenPanel.characterAndStyle') },
                            ]}
                          />
                        </FormField>
                      )}

                      <FormField label={t('imageGenPanel.manualReferenceType')}>
                        <Select
                          value={genParams.referenceType || 'character&style'}
                          onChange={(value) => updateParam('referenceType', value)}
                          options={[
                            { value: 'character&style', label: t('imageGenPanel.characterAndStyle') },
                            { value: 'character', label: t('imageGenPanel.characterOnly') },
                            { value: 'style', label: t('imageGenPanel.styleOnly') },
                          ]}
                        />
                      </FormField>
                    </>
                  )}

                  <FormField label={`${t('imageGenPanel.referenceImages')} (${currentRefs.length}/14)`} hint={t('imageGenPanel.referenceImagesHint')}>
                    <div className={styles.refGrid}>
                      {currentRefs.map((img, idx) => (
                        <div key={idx} className={styles.refTile}>
                          <img src={`data:${img.mimeType || 'image/png'};base64,${img.data}`} alt={t('imageGenPanel.referenceImageAlt', { index: idx + 1 })} />
                          <button type="button" className={styles.refRemove} onClick={() => setCurrentRefs(currentRefs.filter((_, i) => i !== idx))}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    {currentRefs.length < 14 && (
                      <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={onPickRefs}>{t('imageGenPanel.addReference')}</Button>
                    )}
                  </FormField>
                </EditorSection>
              )}

              {/* References group parameters from schema (if any future provider declares them) */}
              {paramGroups.references.length > 0 && !supportsRefs && (
                <EditorSection title={t('imageGenPanel.references')} Icon={IconBrush} defaultExpanded={false}>
                  {paramGroups.references.map(([key, schema]) => (
                    <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} connectionId={activeImageGenConnectionId} />
                  ))}
                </EditorSection>
              )}
            </>
          )}

          <input ref={refInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onRefFiles} />

          <EditorSection title={t('imageGenPanel.sceneSettings')} Icon={IconBrush}>
            <ToggleRow checked={!!imageGeneration.includeCharacters} onChange={(checked) => updateTop({ includeCharacters: checked })} label={t('imageGenPanel.includeCharactersPersona')} hint={t('imageGenPanel.includeCharactersPersonaHint')} />
            <ToggleRow checked={imageGeneration.autoGenerate !== false} onChange={(checked) => updateTop({ autoGenerate: checked })} label={t('imageGenPanel.autoGenerateOnReply')} />
            <ToggleRow checked={!!imageGeneration.forceGeneration} onChange={(checked) => updateTop({ forceGeneration: checked })} label={t('imageGenPanel.ignoreSceneChange')} />
            <ToggleRow
              checked={!!imageGeneration.previewPromptBeforeGenerate}
              onChange={(checked) => updateTop({ previewPromptBeforeGenerate: checked })}
              label={t('imageGenPanel.previewBeforeGenerate')}
              hint={t('imageGenPanel.previewBeforeGenerateHint')}
            />
            <ToggleRow
              checked={!!imageGeneration.recycleGeneratedImages}
              onChange={(checked) => updateTop({ recycleGeneratedImages: checked })}
              label={t('imageGenPanel.recycleGeneratedImages')}
              hint={t('imageGenPanel.recycleGeneratedImagesHint')}
            />
            <ToggleRow
              checked={imageGeneration.addToGallery !== false}
              onChange={(checked) => updateTop({ addToGallery: checked })}
              label={t('imageGenPanel.addGeneratedToGallery')}
              hint={t('imageGenPanel.addGeneratedToGalleryHint')}
            />
            {imageGeneration.recycleGeneratedImages && (
              <FormField label={t('imageGenPanel.generatedImagesResend')} hint={t('imageGenPanel.generatedImagesResendHint')}>
                <TextInput
                  type="number"
                  min={1}
                  max={20}
                  value={String(imageGeneration.recycledImageLimit ?? 1)}
                  onChange={(value) => {
                    const parsed = Number(value)
                    updateTop({ recycledImageLimit: Math.max(1, Math.min(20, Number.isFinite(parsed) ? Math.floor(parsed) : 1)) })
                  }}
                />
              </FormField>
            )}
            <FormField label={t('imageGenPanel.contextMessageLimit')} hint={t('imageGenPanel.contextMessageLimitHint')}>
              <TextInput
                type="number"
                min={1}
                max={200}
                value={String(imageGeneration.promptContextMessageLimit ?? 3)}
                onChange={(value) => {
                  const parsed = Number(value)
                  updateTop({ promptContextMessageLimit: Math.max(1, Math.min(200, Number.isFinite(parsed) ? Math.floor(parsed) : 3)) })
                }}
              />
            </FormField>
            <LabeledRangeSlider
              label={t('imageGenPanel.sceneChangeSensitivity')}
              min={1}
              max={5}
              step={1}
              integer
              value={imageGeneration.sceneChangeThreshold || 2}
              onCommit={(v) => updateTop({ sceneChangeThreshold: v })}
            />
          </EditorSection>

          <EditorSection title={t('imageGenPanel.backgroundDisplay')} Icon={ImageIcon} defaultExpanded={false}>
            <LabeledRangeSlider
              label={t('imageGenPanel.opacity')}
              min={5}
              max={90}
              step={5}
              integer
              value={Math.round((imageGeneration.backgroundOpacity || 0.35) * 100)}
              formatValue={(v) => `${v}%`}
              onCommit={(v) => updateTop({ backgroundOpacity: v / 100 })}
            />
            <LabeledRangeSlider
              label={t('imageGenPanel.fadeDuration')}
              min={200}
              max={2000}
              step={100}
              integer
              value={imageGeneration.fadeTransitionMs || 800}
              formatValue={(v) => `${v}ms`}
              onCommit={(v) => updateTop({ fadeTransitionMs: v })}
            />
          </EditorSection>

          {currentJobId && <ImageGenProgressBar jobId={currentJobId} />}

          {previewSrc && <div className={styles.preview} onClick={() => setLightboxOpen(true)}><img src={previewSrc} alt={t('imageGenPanel.generatedPreview')} className={styles.previewImg} /></div>}
          {lastScene && <div className={styles.sceneInfo}><div><strong>{t('imageGenPanel.scene')}:</strong> {lastScene.environment}</div><div><strong>{t('imageGenPanel.time')}:</strong> {lastScene.time_of_day}</div><div><strong>{t('imageGenPanel.mood')}:</strong> {lastScene.mood}</div></div>}

          <div className={styles.actions}>
            <Button variant="primary" size="sm" icon={<ImageIcon size={14} />} {...generateNowTap} disabled={genDisabled}>{sceneGenerating ? t('imageGenPanel.generating') : t('imageGenPanel.generateNow')}</Button>
            <Button variant="secondary" size="sm" icon={<IconBrush size={14} />} {...forceGenerateTap} disabled={genDisabled}>{t('imageGenPanel.forceGenerate')}</Button>
            {generatedPreview && <Button variant="secondary" size="sm" onClick={() => { setSceneBackground(generatedPreview); setGeneratedPreview(null) }}>{t('imageGenPanel.useAsBackground')}</Button>}
            {previewSrc && <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => { setSceneBackground(null); setGeneratedPreview(null) }}>{t('imageGenPanel.clear')}</Button>}
          </div>

          {!activeImageGenConnectionId && (
            <div className={styles.error}>{t('imageGenPanel.selectConnectionError')}</div>
          )}
          {error && <div className={styles.error}>{error}</div>}
        </>
      )}

      {lightboxOpen && previewSrc && (
        <ImageLightbox
          src={previewSrc}
          onClose={() => setLightboxOpen(false)}
          onDelete={() => { setSceneBackground(null); setGeneratedPreview(null) }}
        />
      )}
      {workflowEditorOpen && (
        <ComfyWorkflowEditor
          config={workflowConfig}
          error={workflowError}
          onImportWorkflow={importComfyWorkflow}
          onUpdateMappings={updateComfyMappings}
          onClose={() => setWorkflowEditorOpen(false)}
        />
      )}
    </div>
  )
}

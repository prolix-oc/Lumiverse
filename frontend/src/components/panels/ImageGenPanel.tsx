import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Image as ImageIcon, Settings2, Trash2, Plus, X, Workflow, Shuffle } from 'lucide-react'
import { IconBrush } from '@tabler/icons-react'
import { useStore } from '@/store'
import { imageGenApi, imageGenPresetBindingsApi, type ComfyUICapabilities, type SceneData } from '@/api/image-gen'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import ImageGenProgressBar from './ImageGenProgressBar'
import { connectionsApi } from '@/api/connections'
import { Toggle } from '@/components/shared/Toggle'
import { Button, FormField, Select, TextInput, EditorSection, TextArea } from '@/components/shared/FormComponents'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { LabeledRangeSlider } from '@/components/shared/RangeSlider'
import ModelCombobox from './connection-manager/ModelCombobox'
import SearchableSelect from '@/components/shared/SearchableSelect'
import { getMacroCatalog } from '@/api/macros'
import { getAvailableMacros } from '@/lib/loom/service'
import type { MacroGroup } from '@/lib/loom/types'
import ImageLightbox from '@/components/shared/ImageLightbox'
import { WorkflowEditorModal } from '@/components/dream-weaver/visual-studio/comfyui/WorkflowEditorModal'
import { buildMappedFieldControls, type ComfyMappedFieldControl } from '@/components/dream-weaver/visual-studio/comfyui/mapped-fields'
import type { ComfyUIFieldMapping, ComfyUIWorkflowConfig } from '@/api/dream-weaver'
import type { ConnectionProfile, ImageGenProviderInfo, ImageGenParameterSchema } from '@/types/api'
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
        placeholder="(workflow / connection default)"
        appearance="standard"
        emptyMessage={connectionId ? 'No models found. Refresh, or enter one manually.' : 'Pick a connection first.'}
      />
    </FormField>
  )
}

/** Render a single parameter from the provider capability schema */
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
  const [llmConnections, setLlmConnections] = useState<ConnectionProfile[]>([])
  const [parserModels, setParserModels] = useState<string[]>([])
  const [parserModelLabels, setParserModelLabels] = useState<Record<string, string>>({})
  const [parserModelsLoading, setParserModelsLoading] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [availableMacros, setAvailableMacros] = useState<MacroGroup[]>(() => getAvailableMacros())
  const [editTarget, setEditTarget] = useState<'main' | 'character' | 'persona'>('main')
  const [draftPrompt, setDraftPrompt] = useState('')
  const [draftNegative, setDraftNegative] = useState('')
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null)
  const [characterPresetId, setCharacterPresetId] = useState<string | null>(null)
  const [personaPresetId, setPersonaPresetId] = useState<string | null>(null)
  const [currentJobId, setCurrentJobId] = useState<string | null>(null)
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false)
  const [workflowConfig, setWorkflowConfig] = useState<ComfyUIWorkflowConfig | null>(null)
  const [workflowCapabilities, setWorkflowCapabilities] = useState<ComfyUICapabilities | null>(null)
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  const refInputRef = useRef<HTMLInputElement | null>(null)

  // Load profiles and providers on mount
  useEffect(() => {
    imageGenConnectionsApi.list({ limit: 100, offset: 0 }).then((res) => {
      setImageGenProfiles(res.data)
    }).catch(() => {})

    imageGenConnectionsApi.providers().then((res) => {
      if (res.providers?.length) setImageGenProviders(res.providers)
    }).catch(() => {})

    connectionsApi.list({ limit: 100, offset: 0 }).then((res) => {
      setLlmConnections(res.data)
    }).catch(() => {})
  }, [setImageGenProfiles, setImageGenProviders])

  const loadParserModels = useCallback(async () => {
    const connectionId = imageGeneration.promptParserConnectionId
    if (!connectionId) {
      setParserModels([])
      setParserModelLabels({})
      return
    }
    setParserModelsLoading(true)
    try {
      const res = await connectionsApi.models(connectionId)
      setParserModels(res.models || [])
      setParserModelLabels(res.model_labels || {})
    } catch {
      setParserModels([])
      setParserModelLabels({})
    } finally {
      setParserModelsLoading(false)
    }
  }, [imageGeneration.promptParserConnectionId])

  useEffect(() => { void loadParserModels() }, [loadParserModels])

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
      setWorkflowError(err?.message || 'Failed to load ComfyUI workflow')
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
    } else {
      const preset = personaPresetId ? personaPresets.find((p) => p.id === personaPresetId) : null
      setLoadedPresetId(preset?.id ?? null)
      setDraftPrompt(preset?.prompt || '')
      setDraftNegative(preset?.negativePrompt || '')
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
      setError(err?.body?.error || err?.message || 'Failed to update character preset binding')
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
      setError(err?.body?.error || err?.message || 'Failed to update persona preset binding')
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
    const targetLabel = editTarget === 'main' ? 'Image prompt' : editTarget === 'character' ? 'Character preset' : 'Persona preset'
    const name = presetName.trim() || loadedPreset?.name || targetLabel
    const existingId = loadedPresetId
    const nextPreset: ImageGenPromptPreset = {
      id: existingId || crypto.randomUUID(),
      name,
      mode: imageGeneration.promptMode === 'parsed_custom' ? 'parsed_custom' : 'custom',
      prompt: draftPrompt,
      negativePrompt: draftNegative,
      parserConnectionId: editTarget === 'main' ? (imageGeneration.promptParserConnectionId || null) : null,
      parserModel: editTarget === 'main' ? (imageGeneration.promptParserModel || '') : '',
      parserParameters: editTarget === 'main' ? (imageGeneration.promptParserParameters || {}) : {},
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

  // Reference images are provider parameters and stay scoped to this connection.
  const currentRefs: RefImage[] = genParams.referenceImages || []
  const setCurrentRefs = (next: RefImage[]) => {
    updateParam('referenceImages', next)
  }

  const supportsRefs = providerName === 'novelai' || providerName === 'nanogpt'

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
    const jobId = crypto.randomUUID()
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
      setError(err?.body?.error || err?.message || 'Image generation failed')
    } finally {
      setSceneGenerating(false)
      setCurrentJobId(null)
    }
  }, [imageGeneration.promptGenerationTimeoutSeconds, imageGeneration.generationTimeoutSeconds, setSceneBackground, setSceneGenerating])

  const handleGenerate = async (forceGeneration = false) => {
    if (!activeChatId) {
      setError('Open a chat first to generate a scene background.')
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
        setError('No message to attach the generated image to.')
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
        setError(err?.body?.error || err?.message || 'Prompt preview failed')
        return
      }
    }

    await runGenerationCall(baseInput)
  }

  const onPickRefs = () => refInputRef.current?.click()
  const onRefFiles: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    try {
      const added = await Promise.all(files.slice(0, Math.max(0, 14 - currentRefs.length)).map(toDataRef))
      setCurrentRefs([...currentRefs, ...added])
    } catch {
      setError('Failed to load one or more reference images')
    } finally {
      e.target.value = ''
    }
  }

  // Connection selector options — just the name
  const connectionOptions = useMemo(() => [
    { value: '', label: 'Select a connection...' },
    ...imageGenProfiles.map((p) => ({ value: p.id, label: p.name })),
  ], [imageGenProfiles])

  const llmConnectionOptions = useMemo(
    () => llmConnections.map((p) => ({ value: p.id, label: p.name })),
    [llmConnections],
  )

  const mainPresetOptions = useMemo(() => [
    { value: '', label: 'No saved prompt' },
    ...mainPresets.map((p) => ({ value: p.id, label: p.name })),
  ], [mainPresets])

  const characterPresetOptions = useMemo(() => [
    { value: '', label: 'No character preset' },
    ...characterPresets.map((p) => ({ value: p.id, label: p.name })),
  ], [characterPresets])

  const personaPresetOptions = useMemo(() => [
    { value: '', label: 'No persona preset' },
    ...personaPresets.map((p) => ({ value: p.id, label: p.name })),
  ], [personaPresets])

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
        label="Enable Image Generation"
        hint="Generate scene-aware chat backgrounds through the council scene tool"
      />

      {imageGeneration.enabled && (
        <>
          {/* Connection Profile Selector */}
          <FormField label="Connection" hint={imageGenProfiles.length === 0 ? 'Create a connection in the Connections tab first' : undefined}>
            <Select
              value={activeImageGenConnectionId || ''}
              onChange={(value) => setActiveImageGenConnection(value || null)}
              options={connectionOptions}
            />
            {activeConnection && (
              <div style={{ fontSize: 11, color: 'var(--lumiverse-text-muted)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {providerInfo?.name || activeConnection.provider}
                {modelLabel && <> &middot; {modelLabel}</>}
              </div>
            )}
          </FormField>

          <EditorSection title="Prompt Mode" Icon={IconBrush}>
            <FormField label="Mode" hint="Scene analyzes chat into a scene prompt. Custom sends your prompt directly. Chat-aware custom uses your instructions to rewrite the current chat context into the final image prompt.">
              <Select
                value={imageGeneration.promptMode || 'scene'}
                onChange={(value) => updateTop({ promptMode: value })}
                options={[
                  { value: 'scene', label: 'Scene tool' },
                  { value: 'custom', label: 'Custom prompt' },
                  { value: 'parsed_custom', label: 'Chat-aware custom' },
                ]}
              />
            </FormField>

            <FormField label="Output" hint="Choose whether the result becomes the chat background, inserted as a new chat image, or attached to the latest existing message.">
              <Select
                value={imageGeneration.outputTarget || 'background'}
                onChange={(value) => updateTop({ outputTarget: value })}
                options={[
                  { value: 'background', label: 'Set as background' },
                  { value: 'chat_attachment', label: 'Insert into chat' },
                  { value: 'attach_to_message', label: 'Attach to last message' },
                  { value: 'preview', label: 'Preview only' },
                ]}
              />
            </FormField>

            {(imageGeneration.promptMode === 'custom' || imageGeneration.promptMode === 'parsed_custom') && (
              <>
                <FormField
                  label="Editing"
                  hint="Switch which preset bucket the text fields below are editing. Main feeds the live prompt; Character/Persona define snippets that replace {{character_prompt}} / {{persona_prompt}} at generation time."
                >
                  <Select
                    value={editTarget}
                    onChange={(value) => setEditTarget(value as 'main' | 'character' | 'persona')}
                    options={[
                      { value: 'main', label: 'Main preset' },
                      { value: 'character', label: 'Character preset' },
                      { value: 'persona', label: 'Persona preset' },
                    ]}
                  />
                </FormField>

                <FormField
                  label={editTarget === 'main' ? 'Active Main Preset' : editTarget === 'character' ? 'Bound Character Preset' : 'Bound Persona Preset'}
                  hint={
                    editTarget === 'main'
                      ? 'Pick a saved main preset to load it into the editor below. It also becomes the active prompt sent at generation time.'
                      : editTarget === 'character'
                        ? activeCharacterId
                          ? 'Pick a character preset to load it into the editor and bind it to the current chat’s character.'
                          : 'Open a chat to bind a preset to its character. Until then, picks won’t persist.'
                        : activePersonaId
                          ? 'Pick a persona preset to load it into the editor and bind it to the active persona.'
                          : 'Select an active persona to bind a preset to it.'
                  }
                >
                  <Select
                    value={loadedPresetId || ''}
                    onChange={(value) => pickPreset(value || null)}
                    options={
                      editTarget === 'main' ? mainPresetOptions : editTarget === 'character' ? characterPresetOptions : personaPresetOptions
                    }
                  />
                </FormField>

                <FormField
                  label={
                    editTarget === 'main'
                      ? (imageGeneration.promptMode === 'parsed_custom' ? 'Parser Instructions' : 'Prompt')
                      : editTarget === 'character' ? 'Character snippet' : 'Persona snippet'
                  }
                  hint={
                    editTarget === 'main'
                      ? (imageGeneration.promptMode === 'parsed_custom'
                          ? 'Instructions for how the parser LLM should turn chat context into the final image prompt. This is not sent directly to the image provider.'
                          : 'Sent directly to the image provider.')
                      : editTarget === 'character'
                        ? 'Text spliced in wherever {{character_prompt}} appears in the main preset.'
                        : 'Text spliced in wherever {{persona_prompt}} appears in the main preset.'
                  }
                >
                  <ExpandableTextarea
                    className={styles.promptTextarea}
                    value={draftPrompt}
                    onChange={onDraftPromptChange}
                    title={loadedPreset ? `Editing: ${loadedPreset.name}` : `${editTarget} prompt`}
                    placeholder={
                      editTarget === 'main'
                        ? (imageGeneration.promptMode === 'parsed_custom'
                            ? 'Example: Focus on the current pose, expressions, clothing, lighting, and room details. Use concise image-generation tags.'
                            : 'Describe the image you want to generate...')
                        : editTarget === 'character'
                          ? '1girl, long red hair, leather jacket'
                          : 'middle-aged man, glasses, beige coat'
                    }
                    rows={5}
                    macros={availableMacros}
                    onRefreshMacros={refreshMacros}
                  />
                  {editTarget === 'main' && /\{\{\s*character_prompt\s*\}\}/i.test(draftPrompt) && (
                    <div className={styles.editorTargetBanner}>
                      <code>{'{{character_prompt}}'}</code> will be replaced with the bound character preset at generation time.
                    </div>
                  )}
                  {editTarget === 'main' && /\{\{\s*persona_prompt\s*\}\}/i.test(draftPrompt) && (
                    <div className={styles.editorTargetBanner}>
                      <code>{'{{persona_prompt}}'}</code> will be replaced with the bound persona preset at generation time.
                    </div>
                  )}
                </FormField>

                <FormField
                  label={editTarget === 'main' ? 'Negative Prompt' : `${editTarget === 'character' ? 'Character' : 'Persona'} negative snippet`}
                  hint={
                    editTarget === 'main'
                      ? undefined
                      : `Replaces {{${editTarget}_negative_prompt}} in the main preset’s negative prompt.`
                  }
                >
                  <ExpandableTextarea
                    className={styles.promptTextarea}
                    value={draftNegative}
                    onChange={onDraftNegativeChange}
                    title={loadedPreset ? `Editing: ${loadedPreset.name} — Negative` : `${editTarget} negative prompt`}
                    placeholder="Optional negative prompt"
                    rows={3}
                    macros={availableMacros}
                    onRefreshMacros={refreshMacros}
                  />
                </FormField>

                <div className={styles.inlineRow}>
                  <TextInput
                    value={presetName}
                    onChange={setPresetName}
                    placeholder={loadedPreset ? `Rename ${loadedPreset.name}` : `New ${editTarget} preset name`}
                  />
                  <Button variant="secondary" size="sm" onClick={savePromptPreset}>
                    {loadedPresetId ? 'Save Changes' : 'Save as New'}
                  </Button>
                  {loadedPresetId && <Button variant="danger" size="sm" onClick={deletePromptPreset}>Delete</Button>}
                </div>
                {loadedPreset && (
                  <div className={styles.editorTargetBanner}>
                    Editing <strong>{loadedPreset.name}</strong> ({editTarget})
                    {editTarget === 'character' && activeCharacterId && ' · bound to active character'}
                    {editTarget === 'persona' && activePersonaId && ' · bound to active persona'}
                  </div>
                )}
              </>
            )}
          </EditorSection>

          {(imageGeneration.promptMode === 'scene' || imageGeneration.promptMode === 'parsed_custom') && (
            <EditorSection title="Prompt Parser" Icon={Settings2} defaultExpanded={imageGeneration.promptMode === 'parsed_custom'}>
              <FormField label="Parser Connection" hint="Overrides the Council sidecar for ImageGen scene/prompt parsing.">
                <SearchableSelect
                  value={imageGeneration.promptParserConnectionId || ''}
                  onChange={(value) => updateTop({ promptParserConnectionId: value || null, promptParserModel: '' })}
                  options={llmConnectionOptions}
                  placeholder="Use Council sidecar / select…"
                  searchPlaceholder="Search connections…"
                  emptyMessage={llmConnections.length === 0 ? 'No LLM connections configured' : 'No matching connections'}
                  disabled={llmConnections.length === 0}
                  ariaLabel="Parser Connection"
                  portal
                />
              </FormField>

              <FormField label="Parser Model">
                <ModelCombobox
                  value={imageGeneration.promptParserModel || ''}
                  onChange={(value) => updateTop({ promptParserModel: value })}
                  models={parserModels}
                  modelLabels={parserModelLabels}
                  loading={parserModelsLoading}
                  onRefresh={loadParserModels}
                  autoRefreshOnFocus
                  refreshKey={imageGeneration.promptParserConnectionId || ''}
                  placeholder="Use connection default"
                  emptyMessage={
                    imageGeneration.promptParserConnectionId
                      ? 'No models returned. Refresh, or enter one manually.'
                      : 'Pick a parser connection first.'
                  }
                  disabled={!imageGeneration.promptParserConnectionId}
                  appearance="standard"
                />
              </FormField>

              <LabeledRangeSlider
                label="Parser Temperature"
                min={0}
                max={2}
                step={0.05}
                value={imageGeneration.promptParserParameters?.temperature ?? 0.4}
                formatValue={(v) => v.toFixed(2)}
                onCommit={(v) => updateTop({ promptParserParameters: { ...(imageGeneration.promptParserParameters || {}), temperature: v } })}
              />

              <LabeledRangeSlider
                label="Parser Top P"
                min={0}
                max={1}
                step={0.05}
                value={imageGeneration.promptParserParameters?.top_p ?? 1}
                formatValue={(v) => v.toFixed(2)}
                onCommit={(v) => updateTop({ promptParserParameters: { ...(imageGeneration.promptParserParameters || {}), top_p: v } })}
              />

              <FormField label="Parser Max Tokens">
                <TextInput
                  value={String(imageGeneration.promptParserParameters?.max_tokens ?? '')}
                  onChange={(value) => updateTop({ promptParserParameters: { ...(imageGeneration.promptParserParameters || {}), max_tokens: value ? Number(value) : undefined } })}
                  placeholder="Use connection default"
                />
              </FormField>
            </EditorSection>
          )}

          <EditorSection title="Timeouts" Icon={Settings2} defaultExpanded={false}>
            <FormField label="Prompt Generation Timeout" hint="Seconds to wait for ImageGen scene parsing or parsed custom prompt generation. Set to 0 to disable.">
              <TextInput
                type="number"
                min={0}
                step={1}
                value={String(imageGeneration.promptGenerationTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS)}
                onChange={(value) => updateTop({ promptGenerationTimeoutSeconds: normalizeTimeoutSeconds(value, DEFAULT_PROMPT_TIMEOUT_SECONDS) })}
              />
            </FormField>

            <FormField label="Image Generation Timeout" hint="Seconds to wait for the image provider after the prompt is ready. Increase this for long ComfyUI workflows, or set to 0 to disable.">
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
                <EditorSection title="ComfyUI Workflow" Icon={Workflow} defaultExpanded={!workflowConfig}>
                  <div className={styles.workflowCard}>
                    <div className={styles.workflowInfo}>
                      <span className={styles.workflowTitle}>
                        {workflowConfig ? 'Workflow imported' : 'No workflow selected'}
                      </span>
                      <span className={styles.workflowMeta}>
                        {workflowConfig
                          ? `${workflowConfig.field_mappings.length} mapped fields · ${workflowConfig.workflow_format === 'ui_workflow' ? 'UI workflow' : 'API prompt'}`
                          : 'Import a ComfyUI workflow JSON and map prompt, seed, sampler, size, and model fields for generation.'}
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
                        {workflowConfig ? 'Edit Workflow' : 'Import Workflow'}
                      </Button>
                    </div>
                  </div>
                  {comfyCustomControls.length > 0 && (
                    <div className={styles.workflowCustomFields}>
                      {comfyCustomControls.map((control) => {
                        const value = readComfyCustomControlValue(control)
                        return (
                          <FormField key={control.key} label={control.label} hint="Exposed from the imported ComfyUI workflow.">
                            {control.options ? (
                              <Select
                                value={value}
                                onChange={(next) => updateComfyCustomControl(control, next)}
                                options={[
                                  { value: '', label: '(workflow default)' },
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
                <EditorSection title="Advanced" Icon={Settings2} defaultExpanded={false}>
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

              {/* Director References — provider-specific, only for NovelAI and NanoGPT */}
              {supportsRefs && (
                <EditorSection title="Director References" Icon={IconBrush} defaultExpanded={false}>
                  {providerName === 'novelai' && (
                    <>
                      <ToggleRow
                        checked={!!genParams.includeCharacterAvatar}
                        onChange={(checked) => updateParam('includeCharacterAvatar', checked)}
                        label="Include Character Avatar"
                        hint="Send current character avatar as director reference"
                      />
                      <ToggleRow
                        checked={!!genParams.includePersonaAvatar}
                        onChange={(checked) => updateParam('includePersonaAvatar', checked)}
                        label="Include Persona Avatar"
                        hint="Send persona avatar as director reference"
                      />
                      <LabeledRangeSlider
                        label="Reference Strength"
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceStrength ?? 0.5}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceStrength', v)}
                      />
                      <LabeledRangeSlider
                        label="Information Extracted"
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceInfoExtracted ?? 1}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceInfoExtracted', v)}
                      />
                      <LabeledRangeSlider
                        label="Reference Fidelity"
                        min={0}
                        max={1}
                        step={0.05}
                        value={genParams.referenceFidelity ?? 1}
                        formatValue={(v) => v.toFixed(2)}
                        onCommit={(v) => updateParam('referenceFidelity', v)}
                      />

                      {(genParams.includeCharacterAvatar || genParams.includePersonaAvatar) && (
                        <FormField label="Avatar Reference Type">
                          <Select
                            value={genParams.avatarReferenceType || 'character'}
                            onChange={(value) => updateParam('avatarReferenceType', value)}
                            options={[
                              { value: 'character', label: 'Character Only' },
                              { value: 'style', label: 'Style Only' },
                              { value: 'character&style', label: 'Character + Style' },
                            ]}
                          />
                        </FormField>
                      )}

                      <FormField label="Manual Reference Type">
                        <Select
                          value={genParams.referenceType || 'character&style'}
                          onChange={(value) => updateParam('referenceType', value)}
                          options={[
                            { value: 'character&style', label: 'Character + Style' },
                            { value: 'character', label: 'Character Only' },
                            { value: 'style', label: 'Style Only' },
                          ]}
                        />
                      </FormField>
                    </>
                  )}

                  <FormField label={`Reference Images (${currentRefs.length}/14)`} hint="Upload images for style/vibe transfer">
                    <div className={styles.refGrid}>
                      {currentRefs.map((img, idx) => (
                        <div key={idx} className={styles.refTile}>
                          <img src={`data:${img.mimeType || 'image/png'};base64,${img.data}`} alt={`Reference ${idx + 1}`} />
                          <button type="button" className={styles.refRemove} onClick={() => setCurrentRefs(currentRefs.filter((_, i) => i !== idx))}>
                            <X size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                    {currentRefs.length < 14 && (
                      <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={onPickRefs}>Add Reference</Button>
                    )}
                  </FormField>
                </EditorSection>
              )}

              {/* References group parameters from schema (if any future provider declares them) */}
              {paramGroups.references.length > 0 && !supportsRefs && (
                <EditorSection title="References" Icon={IconBrush} defaultExpanded={false}>
                  {paramGroups.references.map(([key, schema]) => (
                    <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} connectionId={activeImageGenConnectionId} />
                  ))}
                </EditorSection>
              )}
            </>
          )}

          <input ref={refInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onRefFiles} />

          <EditorSection title="Scene Settings" Icon={IconBrush}>
            <ToggleRow checked={!!imageGeneration.includeCharacters} onChange={(checked) => updateTop({ includeCharacters: checked })} label="Include Characters and Persona" hint="Adds character and active persona descriptions to scene parsing, and asks the parser to include visible subjects when supported by the chat context." />
            <ToggleRow checked={imageGeneration.autoGenerate !== false} onChange={(checked) => updateTop({ autoGenerate: checked })} label="Auto-Generate On Reply" />
            <ToggleRow checked={!!imageGeneration.forceGeneration} onChange={(checked) => updateTop({ forceGeneration: checked })} label="Ignore Scene Change Detection" />
            <ToggleRow
              checked={!!imageGeneration.previewPromptBeforeGenerate}
              onChange={(checked) => updateTop({ previewPromptBeforeGenerate: checked })}
              label="Preview prompt before generating"
              hint="When on, clicking Generate runs the parser and opens an editable preview of the outgoing prompt before sending it to the image provider."
            />
            <ToggleRow
              checked={!!imageGeneration.recycleGeneratedImages}
              onChange={(checked) => updateTop({ recycleGeneratedImages: checked })}
              label="Recycle Generated Images Into Context"
              hint="When off, ImageGen chat attachments stay visible in chat but are not re-sent to the LLM."
            />
            <ToggleRow
              checked={imageGeneration.addToGallery !== false}
              onChange={(checked) => updateTop({ addToGallery: checked })}
              label="Add Generated Images to Character Gallery"
              hint="When on, every generated image is also linked into the active chat's character gallery. Turn off to keep generations out of the gallery."
            />
            {imageGeneration.recycleGeneratedImages && (
              <FormField label="Generated Images To Re-Send" hint="Only the most recent generated images are included in multimodal context.">
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
            <LabeledRangeSlider
              label="Scene Change Sensitivity"
              min={1}
              max={5}
              step={1}
              integer
              value={imageGeneration.sceneChangeThreshold || 2}
              onCommit={(v) => updateTop({ sceneChangeThreshold: v })}
            />
          </EditorSection>

          <EditorSection title="Background Display" Icon={ImageIcon} defaultExpanded={false}>
            <LabeledRangeSlider
              label="Opacity"
              min={5}
              max={90}
              step={5}
              integer
              value={Math.round((imageGeneration.backgroundOpacity || 0.35) * 100)}
              formatValue={(v) => `${v}%`}
              onCommit={(v) => updateTop({ backgroundOpacity: v / 100 })}
            />
            <LabeledRangeSlider
              label="Fade Duration"
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

          {previewSrc && <div className={styles.preview} onClick={() => setLightboxOpen(true)}><img src={previewSrc} alt="Generated preview" className={styles.previewImg} /></div>}
          {lastScene && <div className={styles.sceneInfo}><div><strong>Scene:</strong> {lastScene.environment}</div><div><strong>Time:</strong> {lastScene.time_of_day}</div><div><strong>Mood:</strong> {lastScene.mood}</div></div>}

          <div className={styles.actions}>
            <Button variant="primary" size="sm" icon={<ImageIcon size={14} />} onClick={() => handleGenerate(false)} disabled={sceneGenerating || !activeChatId || !activeImageGenConnectionId}>{sceneGenerating ? 'Generating...' : 'Generate Now'}</Button>
            <Button variant="secondary" size="sm" icon={<IconBrush size={14} />} onClick={() => handleGenerate(true)} disabled={sceneGenerating || !activeChatId || !activeImageGenConnectionId}>Force Generate</Button>
            {generatedPreview && <Button variant="secondary" size="sm" onClick={() => { setSceneBackground(generatedPreview); setGeneratedPreview(null) }}>Use as Background</Button>}
            {previewSrc && <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => { setSceneBackground(null); setGeneratedPreview(null) }}>Clear</Button>}
          </div>

          {!activeImageGenConnectionId && (
            <div className={styles.error}>Select an image gen connection to generate backgrounds.</div>
          )}
          {error && <div className={styles.error}>{error}</div>}
        </>
      )}

      {lightboxOpen && previewSrc && <ImageLightbox src={previewSrc} onClose={() => setLightboxOpen(false)} />}
      {workflowEditorOpen && (
        <WorkflowEditorModal
          config={workflowConfig}
          capabilities={workflowCapabilities}
          error={workflowError}
          onImportWorkflow={importComfyWorkflow}
          onUpdateMappings={updateComfyMappings}
          onClose={() => setWorkflowEditorOpen(false)}
        />
      )}
    </div>
  )
}

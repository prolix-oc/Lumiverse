import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Image as ImageIcon, Settings2, Trash2, Plus, X, Workflow, Shuffle } from 'lucide-react'
import { IconBrush } from '@tabler/icons-react'
import { useStore } from '@/store'
import { imageGenApi, type ComfyUICapabilities, type SceneData } from '@/api/image-gen'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { connectionsApi } from '@/api/connections'
import { Toggle } from '@/components/shared/Toggle'
import { Button, FormField, Select, TextInput, EditorSection, TextArea } from '@/components/shared/FormComponents'
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

/** Combobox for model-component fields backed by a live API fetch. */
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
  const [models, setModels] = useState<Array<{ id: string; label: string }> | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    if (!connectionId) return
    setLoading(true)
    try {
      const res = await imageGenConnectionsApi.modelsBySubtype(connectionId, modelSubtype)
      setModels(res.models ?? [])
      setOpen(true)
    } catch {
      setModels([])
    } finally {
      setLoading(false)
    }
  }, [connectionId, modelSubtype])

  return (
    <FormField label={label} hint={hint}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <TextInput
          value={value ?? ''}
          onChange={(v) => onChange(paramKey, v)}
          placeholder="(default)"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          onClick={load}
          disabled={loading || !connectionId}
          title="Browse available models"
          style={{
            flexShrink: 0,
            padding: '0 8px',
            height: 30,
            background: 'var(--lumiverse-surface-raised)',
            border: '1px solid var(--lumiverse-border)',
            borderRadius: 4,
            color: 'var(--lumiverse-text)',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {loading ? '…' : '↓'}
        </button>
      </div>
      {open && models !== null && (
        <div
          style={{
            marginTop: 4,
            border: '1px solid var(--lumiverse-border)',
            borderRadius: 4,
            background: 'var(--lumiverse-surface-raised)',
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          <div
            style={{ padding: '4px 8px', cursor: 'pointer', fontSize: 12, color: 'var(--lumiverse-text-muted)' }}
            onClick={() => { onChange(paramKey, ''); setOpen(false) }}
          >
            (clear / use default)
          </div>
          {models.length === 0 ? (
            <div style={{ padding: '4px 8px', fontSize: 12, color: 'var(--lumiverse-text-muted)' }}>
              No models found
            </div>
          ) : (
            models.map((m) => (
              <div
                key={m.id}
                style={{
                  padding: '4px 8px',
                  cursor: 'pointer',
                  fontSize: 12,
                  background: value === m.id ? 'var(--lumiverse-accent-muted)' : undefined,
                }}
                onClick={() => { onChange(paramKey, m.id); setOpen(false) }}
              >
                {m.label}
              </div>
            ))
          )}
        </div>
      )}
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
        const formatted = schema.type === 'integer' ? numValue : Number(numValue).toFixed(schema.step && schema.step < 1 ? 2 : 1)
        return (
          <FormField label={`${displayName} (${formatted})`} hint={schema.description}>
            <input
              className={styles.slider}
              type="range"
              min={schema.min}
              max={schema.max}
              step={schema.step ?? (schema.type === 'integer' ? 1 : 0.1)}
              value={numValue}
              onChange={(e) => onChange(paramKey, schema.type === 'integer' ? parseInt(e.target.value) : parseFloat(e.target.value))}
            />
          </FormField>
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
  const [parserModels, setParserModels] = useState<Array<{ id: string; label: string }>>([])
  const [presetName, setPresetName] = useState('')
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

  useEffect(() => {
    const connectionId = imageGeneration.promptParserConnectionId
    if (!connectionId) {
      setParserModels([])
      return
    }
    connectionsApi.models(connectionId).then((res) => {
      setParserModels((res.models || []).map((m) => ({ id: m, label: m })))
    }).catch(() => setParserModels([]))
  }, [imageGeneration.promptParserConnectionId])

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

  // Generation parameters stored in imageGeneration.parameters (flat, provider-agnostic)
  const genParams: Record<string, any> = imageGeneration.parameters || {}

  const updateTop = (partial: Record<string, any>) => setImageGenSettings(partial)

  const updateParam = useCallback((key: string, value: any) => {
    setImageGenSettings({ parameters: { ...genParams, [key]: value } } as any)
  }, [genParams, setImageGenSettings])

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

    setImageGenSettings({
      parameters: {
        ...genParams,
        comfyui_field_values: {
          ...existingFieldValues,
          custom: nextCustom,
        },
      },
    } as any)
  }, [genParams, setImageGenSettings])

  const readComfyCustomControlValue = useCallback((control: ComfyMappedFieldControl) => {
    const customKey = control.key.slice(COMFY_CUSTOM_CONTROL_PREFIX.length)
    const customValues = genParams.comfyui_field_values?.custom || {}
    return normalizeComfyControlValue(customValues[customKey] ?? control.defaultValue)
  }, [genParams.comfyui_field_values])

  const promptPresets = imageGeneration.promptPresets || []
  const activePromptPreset = promptPresets.find((p) => p.id === imageGeneration.activePromptPresetId) || null

  const applyPromptPreset = useCallback((presetId: string | null) => {
    const preset = promptPresets.find((p) => p.id === presetId)
    if (!preset) {
      setImageGenSettings({ activePromptPresetId: null })
      return
    }
    setImageGenSettings({
      activePromptPresetId: preset.id,
      promptMode: preset.mode,
      customPrompt: preset.prompt,
      customNegativePrompt: preset.negativePrompt || '',
      promptParserConnectionId: preset.parserConnectionId || null,
      promptParserModel: preset.parserModel || '',
      promptParserParameters: preset.parserParameters || {},
    } as any)
  }, [promptPresets, setImageGenSettings])

  const savePromptPreset = useCallback(() => {
    const name = presetName.trim() || activePromptPreset?.name || 'Image prompt'
    const existingId = activePromptPreset?.id
    const nextPreset: ImageGenPromptPreset = {
      id: existingId || crypto.randomUUID(),
      name,
      mode: imageGeneration.promptMode === 'parsed_custom' ? 'parsed_custom' : 'custom',
      prompt: imageGeneration.customPrompt || '',
      negativePrompt: imageGeneration.customNegativePrompt || '',
      parserConnectionId: imageGeneration.promptParserConnectionId || null,
      parserModel: imageGeneration.promptParserModel || '',
      parserParameters: imageGeneration.promptParserParameters || {},
    }
    const next = existingId
      ? promptPresets.map((p) => (p.id === existingId ? nextPreset : p))
      : [...promptPresets, nextPreset]
    setImageGenSettings({ promptPresets: next, activePromptPresetId: nextPreset.id } as any)
    setPresetName('')
  }, [activePromptPreset, imageGeneration, presetName, promptPresets, setImageGenSettings])

  const deletePromptPreset = useCallback(() => {
    if (!activePromptPreset) return
    setImageGenSettings({
      promptPresets: promptPresets.filter((p) => p.id !== activePromptPreset.id),
      activePromptPresetId: null,
    } as any)
  }, [activePromptPreset, promptPresets, setImageGenSettings])

  // Reference images (stored per-session in settings)
  const currentRefs: RefImage[] = genParams.referenceImages || []
  const setCurrentRefs = (next: RefImage[]) => {
    setImageGenSettings({ parameters: { ...genParams, referenceImages: next } } as any)
  }

  const supportsRefs = providerName === 'novelai' || providerName === 'nanogpt'

  const handleGenerate = async (forceGeneration = false) => {
    if (!activeChatId) {
      setError('Open a chat first to generate a scene background.')
      return
    }

    setError(null)
    setSceneGenerating(true)
    try {
      const res = await imageGenApi.generate({
        chatId: activeChatId,
        forceGeneration,
        promptMode: imageGeneration.promptMode || 'scene',
        prompt: imageGeneration.customPrompt || '',
        negativePrompt: imageGeneration.customNegativePrompt || '',
        promptPresetId: imageGeneration.activePromptPresetId || null,
        outputTarget: imageGeneration.outputTarget || 'background',
        promptGenerationTimeoutSeconds: imageGeneration.promptGenerationTimeoutSeconds ?? DEFAULT_PROMPT_TIMEOUT_SECONDS,
        generationTimeoutSeconds: imageGeneration.generationTimeoutSeconds ?? DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS,
      })
      setLastScene(res.scene || null)
      if (res.generated && res.imageDataUrl) {
        if ((imageGeneration.outputTarget || 'background') === 'background') {
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
    }
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

  const llmConnectionOptions = useMemo(() => [
    { value: '', label: 'Use Council sidecar / select...' },
    ...llmConnections.map((p) => ({ value: p.id, label: p.name })),
  ], [llmConnections])

  const parserModelOptions = useMemo(() => {
    const current = imageGeneration.promptParserModel || ''
    const options = [{ value: '', label: 'Use connection default' }, ...parserModels.map((m) => ({ value: m.id, label: m.label }))]
    if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: current })
    return options
  }, [imageGeneration.promptParserModel, parserModels])

  const promptPresetOptions = useMemo(() => [
    { value: '', label: 'No saved prompt' },
    ...promptPresets.map((p) => ({ value: p.id, label: p.name })),
  ], [promptPresets])

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
            <FormField label="Mode" hint="Scene uses the built-in scene parser. Custom sends your prompt directly. Parsed custom rewrites your prompt with chat context first.">
              <Select
                value={imageGeneration.promptMode || 'scene'}
                onChange={(value) => updateTop({ promptMode: value })}
                options={[
                  { value: 'scene', label: 'Scene tool' },
                  { value: 'custom', label: 'Custom prompt' },
                  { value: 'parsed_custom', label: 'Parsed custom prompt' },
                ]}
              />
            </FormField>

            <FormField label="Output" hint="Choose whether the result becomes the chat background or is inserted as a chat image.">
              <Select
                value={imageGeneration.outputTarget || 'background'}
                onChange={(value) => updateTop({ outputTarget: value })}
                options={[
                  { value: 'background', label: 'Set as background' },
                  { value: 'chat_attachment', label: 'Insert into chat' },
                  { value: 'preview', label: 'Preview only' },
                ]}
              />
            </FormField>

            {(imageGeneration.promptMode === 'custom' || imageGeneration.promptMode === 'parsed_custom') && (
              <>
                <FormField label="Saved Prompt">
                  <Select
                    value={imageGeneration.activePromptPresetId || ''}
                    onChange={(value) => applyPromptPreset(value || null)}
                    options={promptPresetOptions}
                  />
                </FormField>

                <FormField label="Prompt" hint={imageGeneration.promptMode === 'parsed_custom' ? 'Instructions for the parser LLM to turn chat context into the final image prompt.' : 'Sent directly to the image provider.'}>
                  <TextArea
                    rows={5}
                    value={imageGeneration.customPrompt || ''}
                    onChange={(value) => updateTop({ customPrompt: value })}
                    placeholder="Describe the image you want to generate..."
                  />
                </FormField>

                <FormField label="Negative Prompt">
                  <TextArea
                    rows={3}
                    value={imageGeneration.customNegativePrompt || ''}
                    onChange={(value) => updateTop({ customNegativePrompt: value })}
                    placeholder="Optional negative prompt"
                  />
                </FormField>

                <div className={styles.inlineRow}>
                  <TextInput
                    value={presetName}
                    onChange={setPresetName}
                    placeholder={activePromptPreset ? `Rename ${activePromptPreset.name}` : 'Preset name'}
                  />
                  <Button variant="secondary" size="sm" onClick={savePromptPreset}>Save Prompt</Button>
                  {activePromptPreset && <Button variant="danger" size="sm" onClick={deletePromptPreset}>Delete</Button>}
                </div>
              </>
            )}
          </EditorSection>

          {(imageGeneration.promptMode === 'scene' || imageGeneration.promptMode === 'parsed_custom') && (
            <EditorSection title="Prompt Parser" Icon={Settings2} defaultExpanded={imageGeneration.promptMode === 'parsed_custom'}>
              <FormField label="Parser Connection" hint="Overrides the Council sidecar for ImageGen scene/prompt parsing.">
                <Select
                  value={imageGeneration.promptParserConnectionId || ''}
                  onChange={(value) => updateTop({ promptParserConnectionId: value || null, promptParserModel: '' })}
                  options={llmConnectionOptions}
                />
              </FormField>

              <FormField label="Parser Model">
                <Select
                  value={imageGeneration.promptParserModel || ''}
                  onChange={(value) => updateTop({ promptParserModel: value })}
                  options={parserModelOptions}
                />
              </FormField>

              <FormField label={`Parser Temperature (${imageGeneration.promptParserParameters?.temperature ?? 0.4})`}>
                <input
                  className={styles.slider}
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={imageGeneration.promptParserParameters?.temperature ?? 0.4}
                  onChange={(e) => updateTop({ promptParserParameters: { ...(imageGeneration.promptParserParameters || {}), temperature: Number(e.target.value) } })}
                />
              </FormField>

              <FormField label={`Parser Top P (${imageGeneration.promptParserParameters?.top_p ?? 1})`}>
                <input
                  className={styles.slider}
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={imageGeneration.promptParserParameters?.top_p ?? 1}
                  onChange={(e) => updateTop({ promptParserParameters: { ...(imageGeneration.promptParserParameters || {}), top_p: Number(e.target.value) } })}
                />
              </FormField>

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
                      <FormField label={`Reference Strength (${(genParams.referenceStrength ?? 0.5).toFixed(2)})`}>
                        <input className={styles.slider} type="range" min={0} max={1} step={0.05} value={genParams.referenceStrength ?? 0.5} onChange={(e) => updateParam('referenceStrength', Number(e.target.value))} />
                      </FormField>
                      <FormField label={`Information Extracted (${(genParams.referenceInfoExtracted ?? 1).toFixed(2)})`}>
                        <input className={styles.slider} type="range" min={0} max={1} step={0.05} value={genParams.referenceInfoExtracted ?? 1} onChange={(e) => updateParam('referenceInfoExtracted', Number(e.target.value))} />
                      </FormField>
                      <FormField label={`Reference Fidelity (${(genParams.referenceFidelity ?? 1).toFixed(2)})`}>
                        <input className={styles.slider} type="range" min={0} max={1} step={0.05} value={genParams.referenceFidelity ?? 1} onChange={(e) => updateParam('referenceFidelity', Number(e.target.value))} />
                      </FormField>

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
            <ToggleRow checked={!!imageGeneration.includeCharacters} onChange={(checked) => updateTop({ includeCharacters: checked })} label="Include Characters" />
            <ToggleRow checked={imageGeneration.autoGenerate !== false} onChange={(checked) => updateTop({ autoGenerate: checked })} label="Auto-Generate On Reply" />
            <ToggleRow checked={!!imageGeneration.forceGeneration} onChange={(checked) => updateTop({ forceGeneration: checked })} label="Ignore Scene Change Detection" />
            <ToggleRow
              checked={!!imageGeneration.recycleGeneratedImages}
              onChange={(checked) => updateTop({ recycleGeneratedImages: checked })}
              label="Recycle Generated Images Into Context"
              hint="When off, ImageGen chat attachments stay visible in chat but are not re-sent to the LLM."
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
            <FormField label={`Scene Change Sensitivity (${imageGeneration.sceneChangeThreshold || 2})`}>
              <input className={styles.slider} type="range" min={1} max={5} step={1} value={imageGeneration.sceneChangeThreshold || 2} onChange={(e) => updateTop({ sceneChangeThreshold: Number(e.target.value) })} />
            </FormField>
          </EditorSection>

          <EditorSection title="Background Display" Icon={ImageIcon} defaultExpanded={false}>
            <FormField label={`Opacity (${Math.round((imageGeneration.backgroundOpacity || 0.35) * 100)}%)`}>
              <input className={styles.slider} type="range" min={5} max={90} step={5} value={Math.round((imageGeneration.backgroundOpacity || 0.35) * 100)} onChange={(e) => updateTop({ backgroundOpacity: Number(e.target.value) / 100 })} />
            </FormField>
            <FormField label={`Fade Duration (${imageGeneration.fadeTransitionMs || 800}ms)`}>
              <input className={styles.slider} type="range" min={200} max={2000} step={100} value={imageGeneration.fadeTransitionMs || 800} onChange={(e) => updateTop({ fadeTransitionMs: Number(e.target.value) })} />
            </FormField>
          </EditorSection>

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

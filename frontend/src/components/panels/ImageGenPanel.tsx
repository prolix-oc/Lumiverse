import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Image as ImageIcon, Trash2, Download, Upload } from 'lucide-react'
import { IconBrush } from '@tabler/icons-react'
import { useStore } from '@/store'
import { imageGenApi, type ComfyUICapabilities, type SceneData } from '@/api/image-gen'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import ImageGenProgressBar from './ImageGenProgressBar'
import { Button, FormField, Select } from '@/components/shared/FormComponents'
import { useTouchActivate } from '@/hooks/useTouchActivate'
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
import type { ImageGenConnectionProfile, ImageGenProviderInfo, ImageGenParameterSchema } from '@/types/api'
import ImageGenPromptStudioModal from '../modals/ImageGenPromptStudioModal'
import ImageGenLoraStudioModal from '../modals/ImageGenLoraStudioModal'
import ImageGenSettingsModal from '../modals/ImageGenSettingsModal'
import { useImageGenPromptEditor } from './image-gen/useImageGenPromptEditor'
import { useImageGenLoraEditor } from './image-gen/useImageGenLoraEditor'
import { ToggleRow } from './image-gen/ImageGenFields'
export { ModelComboField } from './image-gen/ImageGenFields'
import styles from './ImageGenPanel.module.css'

type RefImage = { data: string; mimeType?: string }
const COMFY_CUSTOM_CONTROL_PREFIX = 'custom:'
const DEFAULT_PROMPT_TIMEOUT_SECONDS = 60
const DEFAULT_IMAGE_GEN_TIMEOUT_SECONDS = 300

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



function parameterAppliesToModel(schema: ImageGenParameterSchema, model: string | undefined): boolean {
  if (!schema.modelPrefixes?.length) return true
  if (!model) return false
  return schema.modelPrefixes.some((prefix) => model.startsWith(prefix))
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
  const [availableMacros, setAvailableMacros] = useState<MacroGroup[]>(() => getAvailableMacros())
  const [currentJobId, setCurrentJobId] = useState<string | null>(null)
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false)
  const [workflowConfig, setWorkflowConfig] = useState<ComfyUIWorkflowConfig | null>(null)
  const [workflowCapabilities, setWorkflowCapabilities] = useState<ComfyUICapabilities | null>(null)
  const [workflowLoading, setWorkflowLoading] = useState(false)
  const [workflowError, setWorkflowError] = useState<string | null>(null)
  // Profile refreshes can overlap an explicit workflow activation.  Keep a
  // monotonically increasing request id so an older read cannot restore the
  // workflow that was active when that read began.
  const workflowRequestVersion = useRef(0)

  const applyWorkflowConfig = useCallback((config: ComfyUIWorkflowConfig | null) => {
    workflowRequestVersion.current += 1
    setWorkflowConfig(config)
    setWorkflowLoading(false)
  }, [])
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

  const promptEditor = useImageGenPromptEditor(setError)
  const { editTarget, draftPrompt, draftNegative, promptPresets, mainPresetOptions } = promptEditor
  const loraEditor = useImageGenLoraEditor(activeConnection)
  const [promptStudioOpen, setPromptStudioOpen] = useState(false)
  const [loraStudioOpen, setLoraStudioOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const capabilities = providerInfo?.capabilities
  const providerName = activeConnection?.provider || ''
  const isComfyUI = providerName === 'comfyui'
  const isNovelAIV5 = providerName === 'novelai' && activeConnection?.model.startsWith('nai-diffusion-5')

  const comfyCustomControls = useMemo(() => {
    if (!isComfyUI || !workflowConfig) return []
    return buildMappedFieldControls(workflowConfig, workflowCapabilities)
      .filter((control) => control.key.startsWith(COMFY_CUSTOM_CONTROL_PREFIX))
  }, [isComfyUI, workflowConfig, workflowCapabilities])

  const refreshActiveComfyWorkflow = useCallback(async (forceRefresh = false) => {
    const requestVersion = ++workflowRequestVersion.current
    if (!activeConnection || activeConnection.provider !== 'comfyui') {
      setWorkflowConfig(null)
      setWorkflowCapabilities(null)
      setWorkflowError(null)
      setWorkflowLoading(false)
      return
    }

    setWorkflowLoading(true)
    setWorkflowError(null)
    try {
      const [configResponse, comfyCapabilities] = await Promise.all([
        imageGenConnectionsApi.getComfyUIWorkflowConfig(activeConnection.id),
        imageGenConnectionsApi.getComfyUICapabilities(activeConnection.id, forceRefresh),
      ])
      if (requestVersion !== workflowRequestVersion.current) return
      setWorkflowConfig(configResponse.config)
      setWorkflowCapabilities(comfyCapabilities)
    } catch (err: any) {
      if (requestVersion !== workflowRequestVersion.current) return
      setWorkflowConfig(null)
      setWorkflowCapabilities(null)
      setWorkflowError(err?.message || t('imageGenPanel.failedLoadWorkflow'))
    } finally {
      if (requestVersion === workflowRequestVersion.current) setWorkflowLoading(false)
    }
  }, [activeConnection, t])

  useEffect(() => {
    void refreshActiveComfyWorkflow()
  }, [refreshActiveComfyWorkflow])


  const refreshActiveImageGenConnection = useCallback(async () => {
    if (
      !activeConnection
      || useStore.getState().activeImageGenConnectionId !== activeConnection.id
    ) return
    const requestUserId = useStore.getState().user?.id ?? null
    const expectedProfileVersion = useStore.getState().imageGenProfilesVersion
    try {
      const updated = await imageGenConnectionsApi.get(activeConnection.id)
      if (
        useStore.getState().user?.id !== requestUserId
        || useStore.getState().activeImageGenConnectionId !== activeConnection.id
      ) return
      setImageGenProfiles(
        imageGenProfiles.map((profile) => (profile.id === updated.id ? updated : profile)),
        expectedProfileVersion,
      )
    } catch {
      // The workflow update already succeeded; stale metadata in the list is non-fatal.
    }
  }, [activeConnection, imageGenProfiles, setImageGenProfiles])

  const importComfyWorkflow = useCallback(async (workflow: unknown) => {
    if (!activeConnection) return null
    const response = await imageGenConnectionsApi.importComfyUIWorkflow(activeConnection.id, workflow)
    applyWorkflowConfig(response.config)
    await refreshActiveImageGenConnection()
    return response.config
  }, [activeConnection, applyWorkflowConfig, refreshActiveImageGenConnection])

  const updateComfyMappings = useCallback(async (mappings: ComfyUIFieldMapping[]) => {
    if (!activeConnection) return null
    const response = await imageGenConnectionsApi.updateComfyUIWorkflowMappings(activeConnection.id, mappings)
    applyWorkflowConfig(response.config)
    await refreshActiveImageGenConnection()
    return response.config
  }, [activeConnection, applyWorkflowConfig, refreshActiveImageGenConnection])

  // Group parameters by their group field
  const paramGroups = useMemo(() => {
    if (!capabilities) return { main: [], advanced: [], references: [], extra: [] as Array<{ name: string; params: Array<[string, ImageGenParameterSchema]> }> }
    const groups: { main: Array<[string, ImageGenParameterSchema]>; advanced: Array<[string, ImageGenParameterSchema]>; references: Array<[string, ImageGenParameterSchema]> } = {
      main: [],
      advanced: [],
      references: [],
    }
    const KNOWN_GROUPS = new Set(['main', 'advanced', 'references'])
    const extraGroups: Array<{ name: string; params: Array<[string, ImageGenParameterSchema]> }> = []
    const extraMap = new Map<string, Array<[string, ImageGenParameterSchema]>>()

    for (const [key, schema] of Object.entries(capabilities.parameters)) {
      if (!parameterAppliesToModel(schema, activeConnection?.model)) continue
      const group = schema.group || 'main'
      if (KNOWN_GROUPS.has(group)) {
        groups[group as keyof typeof groups].push([key, schema])
      } else {
        if (!extraMap.has(group)) extraMap.set(group, [])
        extraMap.get(group)!.push([key, schema])
      }
    }
    for (const [name, params] of extraMap) {
      extraGroups.push({ name, params })
    }
    return { ...groups, extra: extraGroups }
  }, [activeConnection?.model, capabilities])

  // Provider parameters are saved on the active connection so they do not leak
  // across profiles that happen to use the same parameter names.
  const genParams = useMemo(() => activeConnection?.default_parameters || {}, [activeConnection?.default_parameters])

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



  const handleImportConfigFile: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const requestUserId = useStore.getState().user?.id ?? null
    const expectedProfileVersion = useStore.getState().imageGenProfilesVersion
    setImportConfigBusy(true)
    try {
      const payload = JSON.parse(await file.text())
      if (useStore.getState().user?.id !== requestUserId) return
      const res = await imageGenApi.importConfig(payload)
      if (useStore.getState().user?.id !== requestUserId) return
      // The backend already persisted the merged settings; this re-syncs the store.
      setImageGenSettings(res.settings)
      if (res.imported.connections > 0) {
        const list = await imageGenConnectionsApi.list({ limit: 100, offset: 0 })
        if (useStore.getState().user?.id !== requestUserId) return
        setImageGenProfiles(list.data, expectedProfileVersion)
      }
      toast.success(t('imageGenPanel.importSuccess', {
        presets: res.imported.presets,
        connections: res.imported.connections,
      }))
      for (const issue of res.errors || []) toast.error(issue)
    } catch (err: any) {
      if (useStore.getState().user?.id === requestUserId) {
        toast.error(err.body?.error || err.message || t('imageGenPanel.importFailed'))
      }
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
  const supportsRefs = (providerName === 'novelai' && !isNovelAIV5) || providerName === 'nanogpt' || supportsImg2ImgSource

  const runGenerationCall = useCallback(async (input: {
    chatId: string
    forceGeneration: boolean
    promptMode: 'scene' | 'custom' | 'parsed_custom'
    prompt: string
    negativePrompt: string
    promptPresetId: string | null
    outputTarget: 'background' | 'chat_attachment' | 'preview' | 'attach_to_message'
    bypassCharacterLora?: boolean
    bypassActiveLoraPreset?: boolean
    loraStrengthScale?: number
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
        bypassCharacterLora: input.bypassCharacterLora,
        bypassActiveLoraPreset: input.bypassActiveLoraPreset,
        loraStrengthScale: input.loraStrengthScale,
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
  }, [imageGeneration.promptGenerationTimeoutSeconds, imageGeneration.generationTimeoutSeconds, setSceneBackground, setSceneGenerating, t])

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
      bypassCharacterLora: !!imageGeneration.bypassCharacterLora,
      bypassActiveLoraPreset: !!imageGeneration.bypassActiveLoraPreset,
      loraStrengthScale: imageGeneration.loraStrengthScale,
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

  // On Android,
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

      <div className={`${styles.actions} ${styles.utilities}`} aria-label="Image utilities">
        <Button variant="secondary" size="sm" onClick={() => openModal('imageCaptioner', {})}>Caption Image</Button>
          <Button variant="secondary" size="sm" onClick={() => setExportModalOpen(true)}><Download size={14} /> {t('imageGenPanel.exportConfig')}</Button>
          <Button variant="secondary" size="sm" onClick={() => importConfigInputRef.current?.click()} disabled={importConfigBusy}><Upload size={14} /> {t('imageGenPanel.importConfig')}</Button>
      </div>
      <input ref={importConfigInputRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={handleImportConfigFile} />

      <ImageGenExportModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        presets={promptPresets}
      />

      {imageGeneration.enabled && (
        <>
          {/* Connection Profile Selector */}
          <FormField className={styles.runtimeField} label={t('imageGenPanel.connection')} hint={imageGenProfiles.length === 0 ? t('imageGenPanel.createConnectionFirst') : undefined}>
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

            <FormField className={styles.runtimeField} label={t('imageGenPanel.mode')} hint={t('imageGenPanel.modeHint')}>
              <Select
                aria-label={t('imageGenPanel.mode')}
                value={imageGeneration.promptMode || 'scene'}
                onChange={(value) => updateTop({ promptMode: value })}
                options={[
                  { value: 'scene', label: t('imageGenPanel.sceneTool') },
                  { value: 'custom', label: t('imageGenPanel.customPrompt') },
                  { value: 'parsed_custom', label: t('imageGenPanel.chatAwareCustom') },
                ]}
              />
            </FormField>

            <FormField className={styles.runtimeField} label={t('imageGenPanel.output')} hint={t('imageGenPanel.outputHint')}>
              <Select
                aria-label={t('imageGenPanel.output')}
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

          {(imageGeneration.promptMode === 'custom' || imageGeneration.promptMode === 'parsed_custom') &&
            <FormField className={styles.runtimeField} label={t('imageGenPanel.activeMainPreset')}>
              <div className={styles.inlineRow}>
                <Select aria-label={t('imageGenPanel.activeMainPreset')} value={imageGeneration.activePromptPresetId || ''} onChange={value => promptEditor.pickMainPreset(value || null)} options={mainPresetOptions} />
                <Button variant="secondary" size="sm" onClick={() => setPromptStudioOpen(true)}>Edit</Button>
              </div>
            </FormField>}
          <FormField className={styles.runtimeField} label={t('imageGenPanel.activeLoraPreset')}>
            <div className={styles.inlineRow}>
              <Select aria-label={t('imageGenPanel.activeLoraPreset')} value={imageGeneration.activeLoraPresetId || ''} onChange={value => loraEditor.pickLoraPreset(value || null)} options={loraEditor.loraPresetOptions} />
              <Button variant="secondary" size="sm" onClick={() => setLoraStudioOpen(true)}>Edit</Button>
            </div>
          </FormField>
          <div className={styles.actions}>
            <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true)}>Configure Generation…</Button>
            {imageGeneration.promptMode !== 'custom' && imageGeneration.promptMode !== 'parsed_custom' && <Button variant="secondary" size="sm" onClick={() => setPromptStudioOpen(true)}>Prompt Studio…</Button>}
          </div>
          <section className={styles.quickBehavior} aria-label="Quick Behavior"><h3>Quick Behavior</h3>
            <ToggleRow checked={imageGeneration.autoGenerate !== false} onChange={(checked) => updateTop({ autoGenerate: checked })} label={t('imageGenPanel.autoGenerateOnReply')} />
            <ToggleRow
              checked={!!imageGeneration.previewPromptBeforeGenerate}
              onChange={(checked) => updateTop({ previewPromptBeforeGenerate: checked })}
              label={t('imageGenPanel.previewBeforeGenerate')}
              hint={t('imageGenPanel.previewBeforeGenerateHint')}
            />
            <ToggleRow checked={!!imageGeneration.includeCharacters} onChange={(checked) => updateTop({ includeCharacters: checked })} label={t('imageGenPanel.includeCharacters')} hint={t('imageGenPanel.includeCharactersHint')} />
            <ToggleRow checked={!!imageGeneration.includePersona} onChange={(checked) => updateTop({ includePersona: checked })} label={t('imageGenPanel.includePersona')} hint={t('imageGenPanel.includePersonaHint')} />
          </section>
          <input ref={refInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onRefFiles} />
          {currentJobId && <ImageGenProgressBar jobId={currentJobId} />}

          {previewSrc && <div className={styles.preview} onClick={() => setLightboxOpen(true)}><img src={previewSrc} alt={t('imageGenPanel.generatedPreview')} className={styles.previewImg} /></div>}
          {lastScene && <div className={styles.sceneInfo}><div><strong>{t('imageGenPanel.scene')}:</strong> {lastScene.environment}</div><div><strong>{t('imageGenPanel.time')}:</strong> {lastScene.time_of_day}</div><div><strong>{t('imageGenPanel.mood')}:</strong> {lastScene.mood}</div></div>}

          {previewSrc && <div className={styles.actions}>
            {generatedPreview && <Button variant="secondary" size="sm" onClick={() => { setSceneBackground(generatedPreview); setGeneratedPreview(null) }}>{t('imageGenPanel.useAsBackground')}</Button>}
            {previewSrc && <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => { setSceneBackground(null); setGeneratedPreview(null) }}>{t('imageGenPanel.clear')}</Button>}
          </div>}

          {!activeImageGenConnectionId && (
            <div className={styles.error}>{t('imageGenPanel.selectConnectionError')}</div>
          )}
          {error && <div className={styles.error}>{error}</div>}
          <div className={`${styles.actions} ${styles.generationActions}`} aria-label="Generation actions">
            <Button variant="primary" size="sm" icon={<ImageIcon size={14} />} {...generateNowTap} disabled={genDisabled}>{sceneGenerating ? t('imageGenPanel.generating') : t('imageGenPanel.generateNow')}</Button>
            <Button variant="secondary" size="sm" icon={<IconBrush size={14} />} {...forceGenerateTap} disabled={genDisabled}>{t('imageGenPanel.forceGenerate')}</Button>
          </div>
        </>
      )}

      <ImageGenPromptStudioModal isOpen={promptStudioOpen} onClose={() => setPromptStudioOpen(false)} editor={promptEditor} imageGeneration={imageGeneration} updateTop={updateTop} availableMacros={availableMacros} refreshMacros={refreshMacros} />
      <ImageGenLoraStudioModal isOpen={loraStudioOpen} onClose={() => setLoraStudioOpen(false)} editor={loraEditor} imageGeneration={imageGeneration} updateTop={updateTop} availableMacros={availableMacros} refreshMacros={refreshMacros} />
      <ImageGenSettingsModal nestedEditorOpen={workflowEditorOpen} isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} imageGeneration={imageGeneration} updateTop={updateTop} controller={{
        activeConnection, paramGroups, genParams, updateParam, providerName, isComfyUI, isNovelAIV5: !!isNovelAIV5, supportsRefs, supportsImg2ImgSource,
        workflowConfig, workflowError, workflowLoading, comfyCustomControls, readComfyCustomControlValue, updateComfyCustomControl,
        openWorkflow: () => { setWorkflowEditorOpen(true); void refreshActiveComfyWorkflow(true) }, currentRefs, setCurrentRefs, onPickRefs,
      }} />
      {lightboxOpen && previewSrc && (
        <ImageLightbox
          src={previewSrc}
          onClose={() => setLightboxOpen(false)}
          onDelete={() => { setSceneBackground(null); setGeneratedPreview(null) }}
        />
      )}
      {workflowEditorOpen && activeConnection && (
        <ComfyWorkflowEditor
          connectionId={activeConnection.id}
          config={workflowConfig}
          error={workflowError}
          onImportWorkflow={importComfyWorkflow}
          onUpdateMappings={updateComfyMappings}
          onWorkflowActivated={applyWorkflowConfig}
          onConnectionRefresh={refreshActiveImageGenConnection}
          onClose={() => setWorkflowEditorOpen(false)}
        />
      )}
    </div>
  )
}

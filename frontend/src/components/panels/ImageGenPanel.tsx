import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Image as ImageIcon, Settings2, Trash2, Plus, X } from 'lucide-react'
import { IconBrush } from '@tabler/icons-react'
import { useStore } from '@/store'
import { imageGenApi, type SceneData } from '@/api/image-gen'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { Toggle } from '@/components/shared/Toggle'
import { Button, FormField, Select, TextInput, EditorSection, TextArea } from '@/components/shared/FormComponents'
import ImageLightbox from '@/components/shared/ImageLightbox'
import type { ImageGenProviderInfo, ImageGenParameterSchema } from '@/types/api'
import styles from './ImageGenPanel.module.css'

type RefImage = { data: string; mimeType?: string }

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

/** Render a single parameter from the provider capability schema */
function ParamField({
  paramKey,
  schema,
  value,
  onChange,
}: {
  paramKey: string
  schema: ImageGenParameterSchema
  value: any
  onChange: (key: string, value: any) => void
}) {
  const displayName = paramKey
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()

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
  const refInputRef = useRef<HTMLInputElement | null>(null)

  // Load profiles and providers on mount
  useEffect(() => {
    imageGenConnectionsApi.list({ limit: 100, offset: 0 }).then((res) => {
      setImageGenProfiles(res.data)
    }).catch(() => {})

    imageGenConnectionsApi.providers().then((res) => {
      if (res.providers?.length) setImageGenProviders(res.providers)
    }).catch(() => {})
  }, [setImageGenProfiles, setImageGenProviders])

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

  // Group parameters by their group field
  const paramGroups = useMemo(() => {
    if (!capabilities) return { main: [], advanced: [], references: [] }
    const groups: Record<string, Array<[string, ImageGenParameterSchema]>> = {
      main: [],
      advanced: [],
      references: [],
    }
    for (const [key, schema] of Object.entries(capabilities.parameters)) {
      const group = schema.group || 'main'
      if (!groups[group]) groups[group] = []
      groups[group].push([key, schema])
    }
    return groups
  }, [capabilities])

  // Generation parameters stored in imageGeneration.parameters (flat, provider-agnostic)
  const genParams: Record<string, any> = imageGeneration.parameters || {}

  const updateTop = (partial: Record<string, any>) => setImageGenSettings(partial)

  const updateParam = useCallback((key: string, value: any) => {
    setImageGenSettings({ parameters: { ...genParams, [key]: value } } as any)
  }, [genParams, setImageGenSettings])

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
      const res = await imageGenApi.generate({ chatId: activeChatId, forceGeneration })
      setLastScene(res.scene)
      if (res.generated && res.imageDataUrl) setSceneBackground(res.imageDataUrl)
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

  // Resolve the model ID to a human-readable label
  const modelLabel = useMemo(() => {
    if (!activeConnection?.model) return null
    const staticModel = capabilities?.staticModels?.find((m) => m.id === activeConnection.model)
    return staticModel?.label || activeConnection.model
  }, [activeConnection?.model, capabilities?.staticModels])

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

          {/* Dynamic Generation Parameters from Provider Schema */}
          {activeConnection && capabilities && (
            <>
              {/* Main parameters */}
              {paramGroups.main.map(([key, schema]) => (
                <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} />
              ))}

              {/* Advanced parameters */}
              {paramGroups.advanced.length > 0 && (
                <EditorSection title="Advanced" Icon={Settings2} defaultExpanded={false}>
                  {paramGroups.advanced.map(([key, schema]) => (
                    <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} />
                  ))}
                </EditorSection>
              )}

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
                    <ParamField key={key} paramKey={key} schema={schema} value={genParams[key]} onChange={updateParam} />
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

          {sceneBackground && <div className={styles.preview} onClick={() => setLightboxOpen(true)}><img src={sceneBackground} alt="Scene preview" className={styles.previewImg} /></div>}
          {lastScene && <div className={styles.sceneInfo}><div><strong>Scene:</strong> {lastScene.environment}</div><div><strong>Time:</strong> {lastScene.time_of_day}</div><div><strong>Mood:</strong> {lastScene.mood}</div></div>}

          <div className={styles.actions}>
            <Button variant="primary" size="sm" icon={<ImageIcon size={14} />} onClick={() => handleGenerate(false)} disabled={sceneGenerating || !activeChatId || !activeImageGenConnectionId}>{sceneGenerating ? 'Generating...' : 'Generate Now'}</Button>
            <Button variant="secondary" size="sm" icon={<IconBrush size={14} />} onClick={() => handleGenerate(true)} disabled={sceneGenerating || !activeChatId || !activeImageGenConnectionId}>Force Generate</Button>
            {sceneBackground && <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => setSceneBackground(null)}>Clear</Button>}
          </div>

          {!activeImageGenConnectionId && (
            <div className={styles.error}>Select an image gen connection to generate backgrounds.</div>
          )}
          {error && <div className={styles.error}>{error}</div>}
        </>
      )}

      {lightboxOpen && sceneBackground && <ImageLightbox src={sceneBackground} onClose={() => setLightboxOpen(false)} />}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { Image as ImageIcon, Sparkles, Settings2, Trash2, RefreshCw, Plus, X } from 'lucide-react'
import { useStore } from '@/store'
import { imageGenApi, type SceneData, type ImageGenProvider } from '@/api/image-gen'
import { connectionsApi } from '@/api/connections'
import { FormField, Select, TextInput, EditorSection, TextArea } from '@/components/shared/FormComponents'
import ImageLightbox from '@/components/chat/ImageLightbox'
import styles from './ImageGenPanel.module.css'

type RefImage = { data: string; mimeType?: string }

const FALLBACK_PROVIDERS: ImageGenProvider[] = [
  {
    id: 'google_gemini',
    name: 'Google Gemini',
    models: [
      { id: 'gemini-3.1-flash-image', label: 'Nano Banana 2 (Flash)' },
      { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro' },
    ],
    aspectRatios: ['1:1', '4:3', '16:9', '9:16'],
    resolutions: ['1K', '2K', '4K'],
  },
  {
    id: 'nanogpt',
    name: 'Nano-GPT',
    models: [{ id: 'hidream', label: 'HiDream' }],
    sizes: ['256x256', '512x512', '1024x1024'],
  },
  {
    id: 'novelai',
    name: 'NovelAI',
    models: [{ id: 'nai-diffusion-4-5-full', label: 'NAI Diffusion V4.5 (Full)' }],
    samplers: [{ id: 'k_euler_ancestral', label: 'Euler Ancestral' }],
    resolutions: [
      { id: '832x1216', label: '832x1216 (Portrait)' },
      { id: '1216x832', label: '1216x832 (Landscape)' },
      { id: '1024x1024', label: '1024x1024 (Square)' },
    ],
  },
]

function ToggleRow({ checked, onChange, label, hint }: { checked: boolean; onChange: (checked: boolean) => void; label: string; hint?: string }) {
  return (
    <label className={styles.toggle}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={styles.toggleTextWrap}>
        <span className={styles.toggleLabel}>{label}</span>
        {hint && <span className={styles.toggleHint}>{hint}</span>}
      </span>
    </label>
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

function normalizeResolutionOptions(values: ImageGenProvider['resolutions']) {
  const list = values || []
  return list.map((r: any) => (typeof r === 'string' ? { value: r, label: r } : { value: r.id, label: r.label }))
}

export default function ImageGenPanel() {
  const imageGeneration = useStore((s) => s.imageGeneration)
  const sceneBackground = useStore((s) => s.sceneBackground)
  const sceneGenerating = useStore((s) => s.sceneGenerating)
  const activeChatId = useStore((s) => s.activeChatId)
  const setImageGenSettings = useStore((s) => s.setImageGenSettings)
  const setSceneBackground = useStore((s) => s.setSceneBackground)
  const setSceneGenerating = useStore((s) => s.setSceneGenerating)

  const [providers, setProviders] = useState<ImageGenProvider[]>(FALLBACK_PROVIDERS)
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; provider: string; model: string }>>([])
  const [lastScene, setLastScene] = useState<SceneData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [modelsLoading, setModelsLoading] = useState(false)
  const refInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    imageGenApi.providers().then((res) => {
      if (Array.isArray(res.providers) && res.providers.length > 0) setProviders(res.providers)
    }).catch(() => {})

    connectionsApi.list({ limit: 100, offset: 0 }).then((res) => {
      setProfiles(res.data.map((p) => ({ id: p.id, name: p.name, provider: p.provider, model: p.model })))
    }).catch(() => {})
  }, [])

  const provider = imageGeneration.provider || 'google_gemini'
  const providerConfig = useMemo(() => providers.find((p) => p.id === provider), [providers, provider])
  const googleProfiles = profiles.filter((p) => p.provider.toLowerCase().includes('google'))
  const nanoModels = imageGeneration.nanogpt?.fetchedModels || providerConfig?.models || []

  const updateTop = (partial: Record<string, any>) => setImageGenSettings(partial)
  const updateGoogle = (partial: Record<string, any>) => setImageGenSettings({ google: { ...(imageGeneration.google || {}), ...partial } })
  const updateNano = (partial: Record<string, any>) => setImageGenSettings({ nanogpt: { ...(imageGeneration.nanogpt || {}), ...partial } })
  const updateNovel = (partial: Record<string, any>) => setImageGenSettings({ novelai: { ...(imageGeneration.novelai || {}), ...partial } })

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

  const handleRefreshNanoModels = async () => {
    const apiKey = imageGeneration.nanogpt?.apiKey
    if (!apiKey) return
    setModelsLoading(true)
    try {
      const res = await imageGenApi.fetchNanoGptModels(apiKey)
      if (res.models?.length) updateNano({ fetchedModels: res.models })
    } catch {
      setError('Failed to refresh Nano-GPT models')
    } finally {
      setModelsLoading(false)
    }
  }

  const currentRefs: RefImage[] = provider === 'novelai'
    ? (imageGeneration.novelai?.referenceImages || [])
    : (imageGeneration.nanogpt?.referenceImages || [])

  const setCurrentRefs = (next: RefImage[]) => {
    if (provider === 'novelai') updateNovel({ referenceImages: next })
    else if (provider === 'nanogpt') updateNano({ referenceImages: next })
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
          <FormField label="Provider">
            <Select value={provider} onChange={(value) => updateTop({ provider: value })} options={providers.map((p) => ({ value: p.id, label: p.name }))} />
          </FormField>

          {provider === 'google_gemini' && (
            <EditorSection title="Google Gemini" Icon={Settings2}>
              <FormField label="Model">
                <Select
                  value={imageGeneration.google?.model || 'gemini-3.1-flash-image'}
                  onChange={(value) => updateGoogle({ model: value })}
                  options={(providerConfig?.models || FALLBACK_PROVIDERS[0].models || []).map((m) => ({ value: m.id, label: m.label }))}
                />
              </FormField>
              <FormField label="Google Connection Profile" hint="Used for Gemini API key + endpoint">
                <Select
                  value={imageGeneration.google?.connectionProfileId || ''}
                  onChange={(value) => updateGoogle({ connectionProfileId: value || null })}
                  options={[{ value: '', label: 'Select profile...' }, ...googleProfiles.map((p) => ({ value: p.id, label: `${p.name} (${p.model || 'no model'})` }))]}
                />
              </FormField>
              <FormField label="Aspect Ratio">
                <Select
                  value={imageGeneration.google?.aspectRatio || '16:9'}
                  onChange={(value) => updateGoogle({ aspectRatio: value })}
                  options={(providerConfig?.aspectRatios || FALLBACK_PROVIDERS[0].aspectRatios || []).map((ar) => ({ value: ar, label: ar }))}
                />
              </FormField>
            </EditorSection>
          )}

          {provider === 'nanogpt' && (
            <EditorSection title="Nano-GPT" Icon={Settings2}>
              <FormField label="API Key">
                <TextInput type="password" value={imageGeneration.nanogpt?.apiKey || ''} onChange={(value) => updateNano({ apiKey: value })} placeholder="Enter Nano-GPT API key" />
              </FormField>

              <FormField label="Model">
                <div className={styles.inlineRow}>
                  <div className={styles.inlineGrow}>
                    <Select
                      value={imageGeneration.nanogpt?.model || 'hidream'}
                      onChange={(value) => updateNano({ model: value })}
                      options={nanoModels.map((m: any) => ({ value: m.id, label: m.label }))}
                    />
                  </div>
                  <button type="button" className={styles.iconBtn} onClick={handleRefreshNanoModels} disabled={modelsLoading || !(imageGeneration.nanogpt?.apiKey || '')}>
                    <RefreshCw size={14} className={modelsLoading ? styles.spin : ''} />
                  </button>
                </div>
              </FormField>

              <FormField label="Image Size">
                <Select
                  value={imageGeneration.nanogpt?.size || '1024x1024'}
                  onChange={(value) => updateNano({ size: value })}
                  options={(providerConfig?.sizes || FALLBACK_PROVIDERS[1].sizes || []).map((s) => ({ value: s, label: s }))}
                />
              </FormField>

              <FormField label={`Reference Images (${currentRefs.length}/14)`} hint="Upload style reference images to guide generation">
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
                {currentRefs.length < 14 && <button type="button" className={styles.secondaryBtn} onClick={onPickRefs}><Plus size={14} />Add Reference</button>}
              </FormField>
            </EditorSection>
          )}

          {provider === 'novelai' && (
            <EditorSection title="NovelAI" Icon={Settings2}>
              <FormField label="API Key" hint="Persistent API Token from NovelAI Account Settings">
                <TextInput type="password" value={imageGeneration.novelai?.apiKey || ''} onChange={(value) => updateNovel({ apiKey: value })} placeholder="Enter your NovelAI Persistent API Token" />
              </FormField>
              <FormField label="Model">
                <Select
                  value={imageGeneration.novelai?.model || 'nai-diffusion-4-5-full'}
                  onChange={(value) => updateNovel({ model: value })}
                  options={(providerConfig?.models || FALLBACK_PROVIDERS[2].models || []).map((m) => ({ value: m.id, label: m.label }))}
                />
              </FormField>
              <FormField label="Sampler">
                <Select
                  value={imageGeneration.novelai?.sampler || 'k_euler_ancestral'}
                  onChange={(value) => updateNovel({ sampler: value })}
                  options={(providerConfig?.samplers || FALLBACK_PROVIDERS[2].samplers || []).map((m: any) => ({ value: m.id, label: m.label }))}
                />
              </FormField>
              <FormField label="Resolution">
                <Select
                  value={imageGeneration.novelai?.resolution || '1216x832'}
                  onChange={(value) => updateNovel({ resolution: value })}
                  options={normalizeResolutionOptions(providerConfig?.resolutions || FALLBACK_PROVIDERS[2].resolutions)}
                />
              </FormField>

              <EditorSection title="Advanced" Icon={Settings2} defaultExpanded={false}>
                <FormField label={`Steps (${imageGeneration.novelai?.steps ?? 28})`}>
                  <input className={styles.slider} type="range" min={1} max={50} step={1} value={imageGeneration.novelai?.steps ?? 28} onChange={(e) => updateNovel({ steps: Number(e.target.value) })} />
                </FormField>
                <FormField label={`Guidance Scale (${imageGeneration.novelai?.guidance ?? 5})`}>
                  <input className={styles.slider} type="range" min={1} max={20} step={0.5} value={imageGeneration.novelai?.guidance ?? 5} onChange={(e) => updateNovel({ guidance: Number(e.target.value) })} />
                </FormField>
                <FormField label="Negative Prompt" hint="Comma-separated tags to avoid in generated image">
                  <TextArea
                    rows={3}
                    value={imageGeneration.novelai?.negativePrompt || ''}
                    onChange={(value) => updateNovel({ negativePrompt: value })}
                    placeholder="Tags to exclude from generation"
                  />
                </FormField>
                <ToggleRow checked={!!imageGeneration.novelai?.smea} onChange={(checked) => updateNovel({ smea: checked, smeaDyn: checked ? !!imageGeneration.novelai?.smeaDyn : false })} label="SMEA" hint="Sampling method enhancement for higher resolutions" />
                {imageGeneration.novelai?.smea && (
                  <ToggleRow checked={!!imageGeneration.novelai?.smeaDyn} onChange={(checked) => updateNovel({ smeaDyn: checked })} label="SMEA Dynamic" hint="Dynamic variant of SMEA for more varied results" />
                )}
              </EditorSection>

              <EditorSection title="Director References" Icon={Sparkles} defaultExpanded={false}>
                <ToggleRow checked={!!imageGeneration.novelai?.includeCharacterAvatar} onChange={(checked) => updateNovel({ includeCharacterAvatar: checked })} label="Include Character Avatar" hint="Send current character avatar as director reference" />
                <ToggleRow checked={!!imageGeneration.novelai?.includePersonaAvatar} onChange={(checked) => updateNovel({ includePersonaAvatar: checked })} label="Include Persona Avatar" hint="Send persona avatar as director reference" />
                <FormField label={`Reference Strength (${(imageGeneration.novelai?.referenceStrength ?? 0.5).toFixed(2)})`}>
                  <input className={styles.slider} type="range" min={0} max={1} step={0.05} value={imageGeneration.novelai?.referenceStrength ?? 0.5} onChange={(e) => updateNovel({ referenceStrength: Number(e.target.value) })} />
                </FormField>
                <FormField label={`Information Extracted (${(imageGeneration.novelai?.referenceInfoExtracted ?? 1).toFixed(2)})`}>
                  <input className={styles.slider} type="range" min={0} max={1} step={0.05} value={imageGeneration.novelai?.referenceInfoExtracted ?? 1} onChange={(e) => updateNovel({ referenceInfoExtracted: Number(e.target.value) })} />
                </FormField>
                <FormField label={`Reference Fidelity (${(imageGeneration.novelai?.referenceFidelity ?? 1).toFixed(2)})`}>
                  <input className={styles.slider} type="range" min={0} max={1} step={0.05} value={imageGeneration.novelai?.referenceFidelity ?? 1} onChange={(e) => updateNovel({ referenceFidelity: Number(e.target.value) })} />
                </FormField>

                {(imageGeneration.novelai?.includeCharacterAvatar || imageGeneration.novelai?.includePersonaAvatar) && (
                  <FormField label="Avatar Reference Type">
                    <Select
                      value={imageGeneration.novelai?.avatarReferenceType || 'character'}
                      onChange={(value) => updateNovel({ avatarReferenceType: value })}
                      options={[{ value: 'character', label: 'Character Only' }, { value: 'style', label: 'Style Only' }, { value: 'character&style', label: 'Character + Style' }]}
                    />
                  </FormField>
                )}

                <FormField label="Manual Reference Type">
                  <Select
                    value={imageGeneration.novelai?.referenceType || 'character&style'}
                    onChange={(value) => updateNovel({ referenceType: value })}
                    options={[{ value: 'character&style', label: 'Character + Style' }, { value: 'character', label: 'Character Only' }, { value: 'style', label: 'Style Only' }]}
                  />
                </FormField>

                <FormField label={`Reference Images (${currentRefs.length}/14)`} hint="Upload images for vibe/style transfer via NovelAI Director">
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
                  {currentRefs.length < 14 && <button type="button" className={styles.secondaryBtn} onClick={onPickRefs}><Plus size={14} />Add Reference</button>}
                </FormField>
              </EditorSection>
            </EditorSection>
          )}

          <input ref={refInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={onRefFiles} />

          <EditorSection title="Scene Settings" Icon={Sparkles}>
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
            <button type="button" className={styles.primaryBtn} onClick={() => handleGenerate(false)} disabled={sceneGenerating || !activeChatId}><ImageIcon size={14} /><span>{sceneGenerating ? 'Generating...' : 'Generate Now'}</span></button>
            <button type="button" className={styles.secondaryBtn} onClick={() => handleGenerate(true)} disabled={sceneGenerating || !activeChatId}><Sparkles size={14} /><span>Force Generate</span></button>
            {sceneBackground && <button type="button" className={styles.dangerBtn} onClick={() => setSceneBackground(null)}><Trash2 size={14} /><span>Clear</span></button>}
          </div>

          {error && <div className={styles.error}>{error}</div>}
        </>
      )}

      {lightboxOpen && sceneBackground && <ImageLightbox src={sceneBackground} onClose={() => setLightboxOpen(false)} />}
    </div>
  )
}

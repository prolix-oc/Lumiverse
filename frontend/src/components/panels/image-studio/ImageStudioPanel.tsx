import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Crop, Image as ImageIcon, ImagePlus, MessageCircle, Sparkles, Trash2, Upload, User } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import LazyImage from '@/components/shared/LazyImage'
import ImageCropModal from '@/components/shared/ImageCropModal'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import { charactersApi } from '@/api/characters'
import { characterGalleryApi } from '@/api/character-gallery'
import { imageGenApi } from '@/api/image-gen'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { imagesApi } from '@/api/images'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import {
  findEmbeddedGreetingImageSource,
  getGreetingCellImageUrl,
  removeGreetingImageMarkup,
} from '@/lib/greetingImage'
import { toast } from '@/lib/toast'
import { useStore } from '@/store'
import type {
  Character,
  CharacterGalleryItem,
  ImageGenConnectionProfile,
} from '@/types/api'
import type { StudioImageResult } from '@/api/image-gen'
import styles from './ImageStudioPanel.module.css'

type Target = 'avatar' | 'greeting' | 'gallery'

/** liquid/d1 accepts at most 8 images per request. */
const MAX_REFERENCES = 8
const MAX_LIBRARY_CARDS = 1000
const PAGE_SIZE = 100

/**
 * The Image Studio tab: one place to edit, crop and generate the art a
 * character carries — the card avatar, a greeting image, and gallery images.
 *
 * Generation is chat-free (`POST /image-gen/studio`) and can take up to eight
 * reference images (the current avatar, gallery art, or uploads) so the model
 * keeps the character's look. Results apply straight to the chosen target:
 * avatars go through the crop flow, gallery images are linked into the
 * character's gallery, and greeting images become a `gallery://` embed in the
 * selected greeting.
 */
export default function ImageStudioPanel() {
  const { t } = useTranslation('panels')
  const activeCharacterId = useStore((s) => s.activeCharacterId)

  const [characters, setCharacters] = useState<Character[]>([])
  const [loading, setLoading] = useState(true)
  const [characterId, setCharacterId] = useState('')
  const [gallery, setGallery] = useState<CharacterGalleryItem[]>([])
  const [connections, setConnections] = useState<ImageGenConnectionProfile[]>([])
  const [connectionId, setConnectionId] = useState('')
  const [target, setTarget] = useState<Target>('avatar')
  const [greetingIndex, setGreetingIndex] = useState(0)
  const [prompt, setPrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [references, setReferences] = useState<string[]>([])
  const [uploadedIds, setUploadedIds] = useState<string[]>([])
  const [result, setResult] = useState<StudioImageResult | null>(null)
  const [busy, setBusy] = useState<'generate' | 'avatar' | 'gallery' | 'greeting' | 'upload' | null>(null)
  const [confirmRemoveGreeting, setConfirmRemoveGreeting] = useState(false)

  const character = characters.find((card) => card.id === characterId)

  const refreshCharacters = useCallback(async () => {
    try {
      const collected: Character[] = []
      for (let offset = 0; offset < MAX_LIBRARY_CARDS; offset += PAGE_SIZE) {
        const page = await charactersApi.list({ limit: PAGE_SIZE, offset })
        collected.push(...(page.data || []))
        if (!page.data || page.data.length < PAGE_SIZE) break
      }
      collected.sort((a, b) => a.name.localeCompare(b.name))
      setCharacters(collected)
      return collected
    } catch (err) {
      console.error('[ImageStudio] Loading characters failed:', err)
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  const loadGallery = useCallback(async (id: string) => {
    if (!id) { setGallery([]); return }
    try {
      setGallery(await characterGalleryApi.list(id))
    } catch (err) {
      console.error('[ImageStudio] Loading gallery failed:', err)
      setGallery([])
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void refreshCharacters().then((collected) => {
      if (cancelled) return
      const preferred = collected.find((card) => card.id === activeCharacterId) || collected[0]
      if (preferred) setCharacterId(preferred.id)
    })
    imageGenConnectionsApi
      .list({ limit: 100 })
      .then((page) => { if (!cancelled) setConnections(page.data || []) })
      .catch(() => { if (!cancelled) setConnections([]) })
    return () => { cancelled = true }
  }, [refreshCharacters, activeCharacterId])

  useEffect(() => { void loadGallery(characterId) }, [characterId, loadGallery])

  const greetingCount = 1 + (character?.alternate_greetings?.length ?? 0)

  const greetingContent = useCallback((index: number) => {
    if (!character) return ''
    if (index === 0) return character.first_mes || ''
    return character.alternate_greetings?.[index - 1] || ''
  }, [character])

  const greetingImageUrl = useMemo(() => {
    if (!character) return null
    return getGreetingCellImageUrl(character, greetingIndex, greetingContent(greetingIndex))
  }, [character, greetingIndex, greetingContent])

  const greetingSource = useMemo(
    () => findEmbeddedGreetingImageSource(greetingContent(greetingIndex)),
    [greetingContent, greetingIndex],
  )

  /** Images the model can learn from: the avatar, gallery art, and uploads. */
  const referencePool = useMemo(() => {
    const pool: Array<{ id: string; label: string }> = []
    const seen = new Set<string>()
    const push = (id: string | null | undefined, label: string) => {
      if (!id || seen.has(id)) return
      seen.add(id)
      pool.push({ id, label })
    }
    if (character?.image_id) push(character.image_id, t('imageStudio.targetAvatar'))
    gallery.forEach((item, index) => push(item.image_id, item.caption || `${t('imageStudio.targetGallery')} ${index + 1}`))
    uploadedIds.forEach((id) => push(id, t('imageStudio.addReference')))
    return pool
  }, [character, gallery, uploadedIds, t])

  const toggleReference = (id: string) => {
    setReferences((previous) => {
      if (previous.includes(id)) return previous.filter((entry) => entry !== id)
      if (previous.length >= MAX_REFERENCES) return previous
      return [...previous, id]
    })
  }

  // ── Avatar crop flow (generated results and files from disk) ──
  const applyAvatar = useCallback(async (croppedFile: File, originalFile: File) => {
    if (!characterId) return
    setBusy('avatar')
    try {
      await charactersApi.uploadAvatar(characterId, croppedFile, undefined, originalFile)
      await refreshCharacters()
      toast.success(t('imageStudio.avatarApplied'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.avatarApplied'))
    } finally {
      setBusy(null)
    }
  }, [characterId, refreshCharacters, t])

  const { cropModalProps, openCropFlow } = useImageCropFlow(applyAvatar)
  const {
    cropModalProps: resultCropProps,
    openCropFlow: openResultCrop,
  } = useImageCropFlow(async (croppedFile) => {
    if (!characterId) return
    setBusy('upload')
    try {
      const image = await imagesApi.upload(croppedFile)
      setResult((previous) => ({
        imageId: image.id,
        imageUrl: `/api/v1/images/${image.id}`,
        provider: previous?.provider ?? '',
        model: previous?.model ?? '',
        prompt: previous?.prompt ?? prompt,
      }))
      toast.success(t('imageStudio.cropped'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.generationFailed'))
    } finally {
      setBusy(null)
    }
  })

  const fetchImageFile = useCallback(async (imageId: string): Promise<File> => {
    const response = await fetch(characterGalleryApi.imageUrl(imageId))
    if (!response.ok) throw new Error(`Could not read image (${response.status})`)
    const blob = await response.blob()
    return new File([blob], 'image.png', { type: blob.type || 'image/png' })
  }, [])

  const handleGenerate = async () => {
    if (busy || !prompt.trim()) return
    setBusy('generate')
    try {
      const generated = await imageGenApi.studio({
        prompt: prompt.trim(),
        ...(negativePrompt.trim() ? { negativePrompt: negativePrompt.trim() } : {}),
        ...(references.length ? { referenceImageIds: references } : {}),
        ...(connectionId ? { connectionId } : {}),
      })
      setResult(generated)
      toast.success(t('imageStudio.generated', { model: generated.model }))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.generationFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleUpload = async (file: File) => {
    if (!characterId || !file.type.startsWith('image/')) return
    if (target === 'avatar') {
      openCropFlow(file)
      return
    }
    setBusy('upload')
    try {
      if (target === 'gallery') {
        await characterGalleryApi.upload(characterId, file)
        await loadGallery(characterId)
        toast.success(t('imageStudio.galleryAdded'))
        return
      }
      const image = await imagesApi.upload(file)
      await applyGreetingImage(image.id)
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.generationFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void handleUpload(file)
  }

  /** Embed the image in the selected greeting through a gallery reference. */
  const applyGreetingImage = useCallback(async (imageId: string) => {
    if (!characterId) return
    setBusy('greeting')
    try {
      let item = gallery.find((entry) => entry.image_id === imageId)
      if (!item) item = await characterGalleryApi.link(characterId, imageId, prompt.trim().slice(0, 120))
      const current = greetingContent(greetingIndex)
      const source = findEmbeddedGreetingImageSource(current)
      const body = source ? removeGreetingImageMarkup(current, source) : current
      const markdown = `![${item.caption || t('imageStudio.targetGreeting')}](${item.reference})`
      const next = body.trim() ? `${markdown}\n\n${body.trim()}` : markdown
      if (greetingIndex === 0) {
        await charactersApi.update(characterId, { first_mes: next })
      } else {
        const alternate = [...(character?.alternate_greetings ?? [])]
        alternate[greetingIndex - 1] = next
        await charactersApi.update(characterId, { alternate_greetings: alternate })
      }
      await loadGallery(characterId)
      await refreshCharacters()
      toast.success(t('imageStudio.greetingApplied'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.greetingApplied'))
    } finally {
      setBusy(null)
    }
  }, [characterId, gallery, greetingContent, greetingIndex, character, loadGallery, refreshCharacters, prompt, t])

  const handleRemoveGreetingImage = async () => {
    if (!characterId || !greetingSource) return
    setBusy('greeting')
    try {
      const current = greetingContent(greetingIndex)
      const next = removeGreetingImageMarkup(current, greetingSource).trim()
      const patch: Record<string, unknown> = {}
      if (greetingIndex === 0) patch.first_mes = next
      else {
        const alternate = [...(character?.alternate_greetings ?? [])]
        alternate[greetingIndex - 1] = next
        patch.alternate_greetings = alternate
      }
      // `greeting_backgrounds` overrides the embedded image when present.
      const backgrounds = character?.extensions?.greeting_backgrounds
      if (backgrounds && typeof backgrounds === 'object' && greetingIndex in backgrounds) {
        const cleaned = { ...(backgrounds as Record<string, string>) }
        delete cleaned[greetingIndex]
        patch.extensions = { ...(character?.extensions ?? {}), greeting_backgrounds: cleaned }
      }
      await charactersApi.update(characterId, patch as any)
      await refreshCharacters()
      toast.success(t('imageStudio.greetingRemoved'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.greetingRemoved'))
    } finally {
      setBusy(null)
      setConfirmRemoveGreeting(false)
    }
  }

  const handleAddToGallery = async () => {
    if (!characterId || !result || busy) return
    setBusy('gallery')
    try {
      await characterGalleryApi.link(characterId, result.imageId, prompt.trim().slice(0, 120))
      await loadGallery(characterId)
      toast.success(t('imageStudio.galleryAdded'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.galleryAdded'))
    } finally {
      setBusy(null)
    }
  }

  const handleSetAsAvatar = async () => {
    if (!characterId || !result || busy) return
    setBusy('avatar')
    try {
      openCropFlow(await fetchImageFile(result.imageId))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.avatarApplied'))
    } finally {
      setBusy(null)
    }
  }

  const handleCropResult = async () => {
    if (!result || busy) return
    setBusy('upload')
    try {
      openResultCrop(await fetchImageFile(result.imageId))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.generationFailed'))
    } finally {
      setBusy(null)
    }
  }

  const handleCropCurrentAvatar = async () => {
    const imageId = character?.image_id
    if (!imageId || busy) return
    setBusy('avatar')
    try {
      openCropFlow(await fetchImageFile(imageId))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.avatarApplied'))
    } finally {
      setBusy(null)
    }
  }

  const handleUploadReference = async (file: File) => {
    if (!file.type.startsWith('image/')) return
    setBusy('upload')
    try {
      const image = await imagesApi.upload(file)
      setUploadedIds((previous) => [...previous, image.id])
      setReferences((previous) => (
        previous.length >= MAX_REFERENCES ? previous : [...previous, image.id]
      ))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('imageStudio.generationFailed'))
    } finally {
      setBusy(null)
    }
  }

  const targets: Array<{ id: Target; label: string; icon: typeof User }> = [
    { id: 'avatar', label: t('imageStudio.targetAvatar'), icon: User },
    { id: 'greeting', label: t('imageStudio.targetGreeting'), icon: MessageCircle },
    { id: 'gallery', label: t('imageStudio.targetGallery'), icon: ImageIcon },
  ]

  const avatarUrl = character ? getCharacterAvatarThumbUrl(character) : null

  return (
    <div className={styles.panel}>
      <aside className={styles.sidebar}>
        <label className={styles.fieldLabel} htmlFor="image-studio-character">
          {t('imageStudio.character')}
        </label>
        <select
          id="image-studio-character"
          className={styles.select}
          value={characterId}
          onChange={(event) => setCharacterId(event.target.value)}
          disabled={loading || characters.length === 0}
        >
          {characters.length === 0 && <option value="">{t('foldersPanel.noCharacters')}</option>}
          {characters.map((card) => <option key={card.id} value={card.id}>{card.name}</option>)}
        </select>

        <div className={styles.targetList}>
          {targets.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`${styles.targetBtn} ${target === id ? styles.targetBtnActive : ''}`}
              onClick={() => setTarget(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {connections.length > 0 && (
          <>
            <label className={styles.fieldLabel} htmlFor="image-studio-connection">
              {t('imageGenPanel.connection')}
            </label>
            <select
              id="image-studio-connection"
              className={styles.select}
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
              disabled={busy === 'generate'}
            >
              <option value="">{t('imageGenPanel.selectConnection')}</option>
              {connections.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}{profile.is_default ? ` — ${t('characterBrowser.organizeDefaultConnection')}` : ''}
                </option>
              ))}
            </select>
          </>
        )}
        {connections.length === 0 && (
          <p className={styles.hint}>{t('imageGenPanel.createConnectionFirst')}</p>
        )}

        <div className={styles.currentBox}>
          <span className={styles.fieldLabel}>{t('imageStudio.currentAsset')}</span>
          {target === 'avatar' && (
            <div className={styles.currentAvatarRow}>
              <LazyImage
                containerClassName={styles.currentAvatar}
                src={avatarUrl ?? ''}
                alt=""
                spinnerSize={14}
                fallback={<span className={styles.currentAvatarFallback}>{(character?.name || '?').slice(0, 1).toUpperCase()}</span>}
              />
              <div className={styles.currentActions}>
                <button
                  type="button"
                  className={styles.smallBtn}
                  onClick={() => void handleCropCurrentAvatar()}
                  disabled={!character?.image_id || !!busy}
                >
                  <Crop size={12} />
                  {t('imageStudio.cropCurrentAvatar')}
                </button>
              </div>
            </div>
          )}

          {target === 'greeting' && (
            <>
              <select
                className={styles.select}
                value={greetingIndex}
                onChange={(event) => setGreetingIndex(Number(event.target.value))}
                disabled={greetingCount < 2}
              >
                {Array.from({ length: greetingCount }, (_, index) => (
                  <option key={index} value={index}>
                    {t('imageStudio.greetingIndex', { index: index + 1 })}
                  </option>
                ))}
              </select>
              {greetingImageUrl ? (
                <div className={styles.currentGreetingRow}>
                  <LazyImage
                    containerClassName={styles.currentGreeting}
                    src={greetingImageUrl}
                    alt=""
                    spinnerSize={14}
                    fallback={<span className={styles.currentAvatarFallback}>?</span>}
                  />
                  <button
                    type="button"
                    className={styles.smallBtn}
                    onClick={() => setConfirmRemoveGreeting(true)}
                    disabled={!!busy}
                  >
                    <Trash2 size={12} />
                    {t('imageStudio.removeGreeting')}
                  </button>
                </div>
              ) : (
                <p className={styles.hint}>{t('imageStudio.noGreeting')}</p>
              )}
            </>
          )}

          {target === 'gallery' && (
            <>
              {gallery.length === 0 ? (
                <p className={styles.hint}>{t('imageStudio.galleryEmpty')}</p>
              ) : (
                <div className={styles.galleryGrid}>
                  {gallery.map((item) => (
                    <div key={item.id} className={styles.galleryCell}>
                      <LazyImage
                        containerClassName={styles.galleryThumb}
                        src={characterGalleryApi.smallUrl(item.image_id)}
                        alt={item.caption || ''}
                        spinnerSize={12}
                        fallback={<span className={styles.currentAvatarFallback}>?</span>}
                      />
                      <button
                        type="button"
                        className={styles.cellAction}
                        title={t('imageStudio.useAsGreeting')}
                        onClick={() => void applyGreetingImage(item.image_id)}
                        disabled={!!busy}
                      >
                        <MessageCircle size={11} />
                      </button>
                      <button
                        type="button"
                        className={styles.cellAction}
                        title={t('imageStudio.references')}
                        onClick={() => toggleReference(item.image_id)}
                        disabled={!!busy}
                      >
                        <ImagePlus size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </aside>

      <section className={styles.main}>
        <div className={styles.promptRow}>
          <label className={styles.fieldLabel} htmlFor="image-studio-prompt">
            {t('imageGenPanel.prompt')}
          </label>
          <textarea
            id="image-studio-prompt"
            className={styles.textarea}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={t('imageStudio.promptPlaceholder')}
            rows={3}
            disabled={busy === 'generate'}
          />
        </div>
        <div className={styles.promptRow}>
          <label className={styles.fieldLabel} htmlFor="image-studio-negative">
            {t('imageStudio.negativePrompt')}
          </label>
          <input
            id="image-studio-negative"
            className={styles.input}
            value={negativePrompt}
            onChange={(event) => setNegativePrompt(event.target.value)}
            disabled={busy === 'generate'}
          />
        </div>

        <div className={styles.referenceRow}>
          <span className={styles.fieldLabel}>{t('imageStudio.references')}</span>
          <span className={styles.hintInline}>{t('imageStudio.referenceHint')}</span>
          <span className={styles.spacer} />
          <label className={styles.fileBtn}>
            <ImagePlus size={13} />
            {t('imageStudio.addReference')}
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void handleUploadReference(file)
              }}
            />
          </label>
        </div>

        <div className={styles.referenceList}>
          {referencePool.length === 0 && <span className={styles.hintInline}>{t('imageStudio.noReferences')}</span>}
          {referencePool.map((entry) => {
            const active = references.includes(entry.id)
            return (
              <button
                key={entry.id}
                type="button"
                className={`${styles.referenceChip} ${active ? styles.referenceChipActive : ''}`}
                onClick={() => toggleReference(entry.id)}
                disabled={!active && references.length >= MAX_REFERENCES}
                title={entry.label}
              >
                <LazyImage
                  containerClassName={styles.referenceThumb}
                  src={characterGalleryApi.smallUrl(entry.id)}
                  alt=""
                  spinnerSize={10}
                  fallback={<span className={styles.currentAvatarFallback}>?</span>}
                />
                <span className={styles.referenceLabel}>{entry.label}</span>
              </button>
            )
          })}
        </div>

        <div className={styles.generateRow}>
          <label className={styles.fileBtn}>
            <Upload size={13} />
            {t('imageStudio.uploadImage')}
            <input type="file" accept="image/*" hidden onChange={handleFilePicked} />
          </label>
          <span className={styles.spacer} />
          <button
            type="button"
            className={styles.generateBtn}
            onClick={() => void handleGenerate()}
            disabled={!!busy || !prompt.trim()}
          >
            {busy === 'generate' ? <Spinner size={14} /> : <Sparkles size={14} />}
            {busy === 'generate' ? t('imageStudio.generating') : t('imageStudio.generate')}
          </button>
        </div>

        <div className={styles.resultBox}>
          {result ? (
            <>
              <LazyImage
                containerClassName={styles.resultImage}
                src={characterGalleryApi.imageUrl(result.imageId)}
                alt={result.prompt}
                spinnerSize={16}
                fallback={<span className={styles.currentAvatarFallback}>?</span>}
              />
              <div className={styles.resultActions}>
                <button type="button" className={styles.smallBtn} onClick={() => void handleCropResult()} disabled={!!busy}>
                  <Crop size={12} />
                  {t('imageStudio.cropResult')}
                </button>
                <button type="button" className={styles.smallBtn} onClick={() => void handleSetAsAvatar()} disabled={!!busy}>
                  <User size={12} />
                  {t('imageStudio.setAsAvatar')}
                </button>
                <button type="button" className={styles.smallBtn} onClick={() => void handleAddToGallery()} disabled={!!busy || !characterId}>
                  <ImageIcon size={12} />
                  {t('imageStudio.addToGallery')}
                </button>
                <button
                  type="button"
                  className={styles.smallBtn}
                  onClick={() => void applyGreetingImage(result.imageId)}
                  disabled={!!busy || !characterId}
                >
                  <MessageCircle size={12} />
                  {t('imageStudio.useAsGreeting')}
                </button>
              </div>
            </>
          ) : (
            <p className={styles.hint}>{t('imageStudio.resultEmpty')}</p>
          )}
        </div>
      </section>

      <ImageCropModal {...cropModalProps} />
      <ImageCropModal {...resultCropProps} cropShape="rect" outputSize={1024} />

      <ConfirmationModal
        isOpen={confirmRemoveGreeting}
        variant="danger"
        title={t('imageStudio.removeGreeting')}
        message={t('imageStudio.removeGreetingConfirm')}
        confirmText={t('characterBrowser.delete')}
        cancelText={t('common.actions.cancel')}
        loading={busy === 'greeting'}
        onConfirm={() => void handleRemoveGreetingImage()}
        onCancel={() => setConfirmRemoveGreeting(false)}
      />
    </div>
  )
}

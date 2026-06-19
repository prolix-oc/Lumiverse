import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageIcon, Upload, Trash2, Monitor, MessageSquare } from 'lucide-react'
import { useStore } from '@/store'
import { imagesApi } from '@/api/images'
import { chatsApi } from '@/api/chats'
import { FormField, Select, EditorSection } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { flushSettingsNow } from '@/store/slices/settings'
import type { WallpaperRef } from '@/types/store'
import styles from './WallpaperPanel.module.css'

const MAX_VIDEO_SIZE = 100 * 1024 * 1024 // 100MB
const ACCEPTED_TYPES = 'image/*,video/mp4,video/webm'

function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/')
}

function isVideoMime(mime?: string): boolean {
  return !!mime && mime.startsWith('video/')
}

export default function WallpaperPanel() {
  const { t } = useTranslation('panels')
  const wallpaper = useStore((s) => s.wallpaper)
  const setWallpaper = useStore((s) => s.setWallpaper)
  const useCharacterBackground = useStore((s) => s.useCharacterBackground)
  const setSetting = useStore((s) => s.setSetting)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatWallpaper = useStore((s) => s.activeChatWallpaper)
  const setActiveChatWallpaper = useStore((s) => s.setActiveChatWallpaper)

  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [uploadTarget, setUploadTarget] = useState<'global' | 'chat'>('global')

  const globalWp = wallpaper.global
  const chatWp = activeChatWallpaper
  const globalUrl = globalWp?.image_id ? imagesApi.url(globalWp.image_id) : null
  const chatUrl = chatWp?.image_id ? imagesApi.url(chatWp.image_id) : null

  const handleUpload = async (target: 'global' | 'chat') => {
    setUploadTarget(target)
    fileInputRef.current?.click()
  }

  const onFileSelected: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const isVideo = isVideoFile(file)

    if (isVideo && file.size > MAX_VIDEO_SIZE) {
      setError(t('wallpaperPanel.videoTooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }))
      return
    }

    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      setError(t('wallpaperPanel.invalidFileType'))
      return
    }

    setError(null)
    setUploading(true)

    try {
      const image = await imagesApi.upload(file)
      const ref: WallpaperRef = {
        image_id: image.id,
        type: isVideo ? 'video' : 'image',
      }

      if (uploadTarget === 'chat' && activeChatId) {
        const oldImageId = activeChatWallpaper?.image_id
        // Save to chat metadata
        await chatsApi.patchMetadata(activeChatId, { wallpaper: ref })
        setActiveChatWallpaper(ref)
        if (oldImageId && oldImageId !== ref.image_id) void imagesApi.deleteIfUnused(oldImageId).catch(() => {})
      } else {
        const oldImageId = wallpaper.global?.image_id
        // Save as global wallpaper
        setWallpaper({ global: ref })
        await flushSettingsNow()
        if (oldImageId && oldImageId !== ref.image_id) void imagesApi.deleteIfUnused(oldImageId).catch(() => {})
      }
    } catch (err: any) {
      setError(err?.message || t('wallpaperPanel.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  const clearGlobal = async () => {
    const oldImageId = wallpaper.global?.image_id
    setWallpaper({ global: null })
    await flushSettingsNow()
    if (oldImageId) void imagesApi.deleteIfUnused(oldImageId).catch(() => {})
  }

  const clearChat = async () => {
    if (!activeChatId) return
    const oldImageId = activeChatWallpaper?.image_id
    try {
      await chatsApi.patchMetadata(activeChatId, { wallpaper: null })
      setActiveChatWallpaper(null)
      if (oldImageId) void imagesApi.deleteIfUnused(oldImageId).catch(() => {})
    } catch (err: any) {
      setError(err?.message || t('wallpaperPanel.clearChatFailed'))
    }
  }

  return (
    <div className={styles.panel}>
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        style={{ display: 'none' }}
        onChange={onFileSelected}
      />

      {/* Character avatar background toggle */}
      <div className={styles.actions} style={{ alignItems: 'center' }}>
        <Toggle.Switch
          checked={useCharacterBackground}
          onChange={(v) => setSetting('useCharacterBackground', v)}
        />
        <span style={{ fontSize: 'calc(13px * var(--lumiverse-font-scale, 1))' }}>
          Use Character Avatar as Background
        </span>
      </div>
      <div className={styles.info}>
        Automatically uses the character's art as the chat background when no wallpaper is set.
      </div>

      <hr className={styles.divider} />

      {/* Global wallpaper section */}
      <span className={styles.scopeLabel}>{t('wallpaperPanel.globalWallpaper')}</span>
      <div className={styles.preview}>
        {globalUrl && globalWp?.type === 'video' ? (
          <>
            <video className={styles.previewVideo} src={globalUrl} autoPlay muted loop playsInline />
            <span className={styles.previewBadge}>{t('wallpaperPanel.video')}</span>
          </>
        ) : globalUrl ? (
          <img className={styles.previewImg} src={globalUrl} alt={t('wallpaperPanel.globalWallpaperAlt')} />
        ) : (
          <div className={styles.previewPlaceholder}>
            <Monitor size={16} />
            <span>{t('wallpaperPanel.noGlobalWallpaper')}</span>
          </div>
        )}
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={() => handleUpload('global')}
          disabled={uploading}
        >
          <Upload size={14} />
          <span>{uploading && uploadTarget === 'global' ? t('wallpaperPanel.uploading') : t('wallpaperPanel.setGlobal')}</span>
        </button>
        {globalWp && (
          <button type="button" className={styles.dangerBtn} onClick={clearGlobal}>
            <Trash2 size={14} />
            <span>{t('wallpaperPanel.clear')}</span>
          </button>
        )}
      </div>

      <hr className={styles.divider} />

      {/* Per-chat wallpaper section */}
      <span className={styles.scopeLabel}>{t('wallpaperPanel.chatWallpaper')}</span>
      {activeChatId ? (
        <>
          <div className={styles.preview}>
            {chatUrl && chatWp?.type === 'video' ? (
              <>
                <video className={styles.previewVideo} src={chatUrl} autoPlay muted loop playsInline />
                <span className={styles.previewBadge}>{t('wallpaperPanel.video')}</span>
              </>
            ) : chatUrl ? (
              <img className={styles.previewImg} src={chatUrl} alt={t('wallpaperPanel.chatWallpaperAlt')} />
            ) : (
              <div className={styles.previewPlaceholder}>
                <MessageSquare size={16} />
                <span>{t('wallpaperPanel.noChatWallpaper')}</span>
              </div>
            )}
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={() => handleUpload('chat')}
              disabled={uploading}
            >
              <Upload size={14} />
              <span>{uploading && uploadTarget === 'chat' ? t('wallpaperPanel.uploading') : t('wallpaperPanel.setForChat')}</span>
            </button>
            {chatWp && (
              <button type="button" className={styles.dangerBtn} onClick={clearChat}>
                <Trash2 size={14} />
                <span>{t('wallpaperPanel.clear')}</span>
              </button>
            )}
          </div>
          <div className={styles.info}>
            {t('wallpaperPanel.chatOverrideHint')}
          </div>
        </>
      ) : (
        <div className={styles.info}>
          {t('wallpaperPanel.openChatHint')}
        </div>
      )}

      <hr className={styles.divider} />

      {/* Display settings */}
      <EditorSection title={t('wallpaperPanel.displaySettings')} Icon={ImageIcon}>
        <FormField label={t('wallpaperPanel.opacityLabel', { percent: Math.round((wallpaper.opacity ?? 0.3) * 100) })}>
          <input
            className={styles.slider}
            type="range"
            min={5}
            max={100}
            step={5}
            value={Math.round((wallpaper.opacity ?? 0.3) * 100)}
            onChange={(e) => setWallpaper({ opacity: Number(e.target.value) / 100 })}
          />
        </FormField>
        <FormField label={`Blur (${wallpaper.blur ?? 0}px)`}>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={20}
            step={1}
            value={wallpaper.blur ?? 0}
            onChange={(e) => setWallpaper({ blur: Number(e.target.value) })}
          />
        </FormField>
        <FormField label={t('wallpaperPanel.fitMode')}>
          <Select
            value={wallpaper.fit ?? 'cover'}
            onChange={(value) => setWallpaper({ fit: value as 'cover' | 'contain' | 'fill' })}
            options={[
              { value: 'cover', label: t('wallpaperPanel.fitCover') },
              { value: 'contain', label: t('wallpaperPanel.fitContain') },
              { value: 'fill', label: t('wallpaperPanel.fitFill') },
            ]}
          />
        </FormField>
      </EditorSection>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  )
}

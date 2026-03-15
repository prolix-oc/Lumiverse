import { useRef, useState } from 'react'
import { ImageIcon, Upload, Trash2, Monitor, MessageSquare } from 'lucide-react'
import { useStore } from '@/store'
import { imagesApi } from '@/api/images'
import { chatsApi } from '@/api/chats'
import { FormField, Select, EditorSection } from '@/components/shared/FormComponents'
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
  const wallpaper = useStore((s) => s.wallpaper)
  const setWallpaper = useStore((s) => s.setWallpaper)
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
      setError(`Video files must be under 100MB. Selected file is ${(file.size / 1024 / 1024).toFixed(1)}MB.`)
      return
    }

    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) {
      setError('Please select an image or video file (.mp4, .webm).')
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
        // Save to chat metadata
        const chat = await chatsApi.get(activeChatId)
        const metadata = { ...(chat.metadata || {}), wallpaper: ref }
        await chatsApi.update(activeChatId, { metadata })
        setActiveChatWallpaper(ref)
      } else {
        // Save as global wallpaper
        setWallpaper({ global: ref })
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to upload wallpaper.')
    } finally {
      setUploading(false)
    }
  }

  const clearGlobal = () => {
    setWallpaper({ global: null })
  }

  const clearChat = async () => {
    if (!activeChatId) return
    try {
      const chat = await chatsApi.get(activeChatId)
      const metadata = { ...(chat.metadata || {}) }
      delete metadata.wallpaper
      await chatsApi.update(activeChatId, { metadata })
      setActiveChatWallpaper(null)
    } catch (err: any) {
      setError(err?.message || 'Failed to clear chat wallpaper.')
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

      {/* Global wallpaper section */}
      <span className={styles.scopeLabel}>Global Wallpaper</span>
      <div className={styles.preview}>
        {globalUrl && globalWp?.type === 'video' ? (
          <>
            <video className={styles.previewVideo} src={globalUrl} autoPlay muted loop playsInline />
            <span className={styles.previewBadge}>Video</span>
          </>
        ) : globalUrl ? (
          <img className={styles.previewImg} src={globalUrl} alt="Global wallpaper" />
        ) : (
          <div className={styles.previewPlaceholder}>
            <Monitor size={16} />
            <span>No global wallpaper set</span>
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
          <span>{uploading && uploadTarget === 'global' ? 'Uploading...' : 'Set Global'}</span>
        </button>
        {globalWp && (
          <button type="button" className={styles.dangerBtn} onClick={clearGlobal}>
            <Trash2 size={14} />
            <span>Clear</span>
          </button>
        )}
      </div>

      <hr className={styles.divider} />

      {/* Per-chat wallpaper section */}
      <span className={styles.scopeLabel}>Chat Wallpaper</span>
      {activeChatId ? (
        <>
          <div className={styles.preview}>
            {chatUrl && chatWp?.type === 'video' ? (
              <>
                <video className={styles.previewVideo} src={chatUrl} autoPlay muted loop playsInline />
                <span className={styles.previewBadge}>Video</span>
              </>
            ) : chatUrl ? (
              <img className={styles.previewImg} src={chatUrl} alt="Chat wallpaper" />
            ) : (
              <div className={styles.previewPlaceholder}>
                <MessageSquare size={16} />
                <span>No chat wallpaper set</span>
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
              <span>{uploading && uploadTarget === 'chat' ? 'Uploading...' : 'Set for Chat'}</span>
            </button>
            {chatWp && (
              <button type="button" className={styles.dangerBtn} onClick={clearChat}>
                <Trash2 size={14} />
                <span>Clear</span>
              </button>
            )}
          </div>
          <div className={styles.info}>
            Chat wallpapers override the global wallpaper. AI-generated scene backgrounds override both when active.
          </div>
        </>
      ) : (
        <div className={styles.info}>
          Open a chat to set a per-chat wallpaper.
        </div>
      )}

      <hr className={styles.divider} />

      {/* Display settings */}
      <EditorSection title="Display Settings" Icon={ImageIcon}>
        <FormField label={`Opacity (${Math.round((wallpaper.opacity ?? 0.3) * 100)}%)`}>
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
        <FormField label="Fit Mode">
          <Select
            value={wallpaper.fit ?? 'cover'}
            onChange={(value) => setWallpaper({ fit: value as 'cover' | 'contain' | 'fill' })}
            options={[
              { value: 'cover', label: 'Cover (fill, crop edges)' },
              { value: 'contain', label: 'Contain (fit, may letterbox)' },
              { value: 'fill', label: 'Fill (stretch to fit)' },
            ]}
          />
        </FormField>
      </EditorSection>

      {error && <div className={styles.error}>{error}</div>}
    </div>
  )
}

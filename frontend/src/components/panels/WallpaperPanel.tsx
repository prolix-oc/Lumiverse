import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageIcon, Upload, Trash2, Monitor, MessageSquare } from 'lucide-react'
import { useStore } from '@/store'
import { imagesApi } from '@/api/images'
import { chatsApi } from '@/api/chats'
import { wsClient } from '@/ws/client'
import { EventType, type WallpaperUploadProgressPayload } from '@/ws/events'
import { FormField, Select, EditorSection } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { flushSettingsNow } from '@/store/slices/settings'
import type { WallpaperRef } from '@/types/store'
import WallpaperLibraryModal from './WallpaperLibraryModal'
import styles from './WallpaperPanel.module.css'

const MAX_VIDEO_SIZE = 250 * 1024 * 1024 // 250MB
const MAX_WALLPAPER_BLUR = 8
const FILE_PICKER_RESUME_PING_SUPPRESSION_MS = 2 * 60 * 1000
const COMPLETED_UPLOAD_STATUS_LINGER_MS = 1200
const TRANSFER_PROGRESS_SHARE = 65
const PROCESSING_PROGRESS_SHARE = 30
const ACCEPTED_TYPES = 'image/*,video/mp4,video/webm,video/quicktime,video/x-m4v,.mp4,.webm,.mov,.m4v'
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v'])
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])

type WallpaperUploadPhase = 'uploading' | 'waiting_server' | WallpaperUploadProgressPayload['phase']

interface WallpaperUploadStatus {
  uploadId: string
  target: 'global' | 'chat'
  kind: 'image' | 'video'
  phase: WallpaperUploadPhase
  uploadPercent: number
  step: number
  totalSteps: number
  codec?: 'h264' | 'hevc'
  phaseProgressPct?: number
  currentTimeMs?: number
  durationMs?: number
  speed?: number
}

function fileExtension(name: string): string {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

function detectWallpaperFileKind(file: File): 'image' | 'video' | null {
  const type = (file.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'

  const ext = fileExtension(file.name)
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return null
}

function createWallpaperUploadId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // Fall through to a timestamp-based id when Web Crypto is unavailable.
  }
  return `wallpaper-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function wallpaperCodecLabel(codec?: 'h264' | 'hevc'): string {
  if (codec === 'hevc') return 'H.265 / HEVC'
  return 'H.264'
}

function getWallpaperUploadPercent(status: WallpaperUploadStatus): number {
  const uploadPercent = Math.max(0, Math.min(100, status.uploadPercent || 0))

  if (status.phase === 'uploading') {
    return Math.min(TRANSFER_PROGRESS_SHARE, Math.round((uploadPercent / 100) * TRANSFER_PROGRESS_SHARE))
  }

  if (status.phase === 'waiting_server' || status.phase === 'received') {
    return TRANSFER_PROGRESS_SHARE
  }

  if (status.phase === 'completed') {
    return 100
  }

  if (status.totalSteps > 0) {
    const clampedStep = Math.max(0, Math.min(status.step, status.totalSteps))
    const stageFraction = typeof status.phaseProgressPct === 'number'
      ? Math.max(0, Math.min(100, status.phaseProgressPct)) / 100
      : 1
    const weightedStep = stageFraction < 1
      ? Math.max(0, clampedStep - 1) + stageFraction
      : clampedStep
    return Math.min(
      99,
      Math.round(
        TRANSFER_PROGRESS_SHARE + (weightedStep / status.totalSteps) * PROCESSING_PROGRESS_SHARE,
      ),
    )
  }

  return 90
}

function getWallpaperUploadMessage(status: WallpaperUploadStatus, t: any): string {
  switch (status.phase) {
    case 'uploading':
      return t('wallpaperPanel.uploadStatus.uploading')
    case 'waiting_server':
      return t('wallpaperPanel.uploadStatus.waiting')
    case 'received':
      return t('wallpaperPanel.uploadStatus.preparing')
    case 'transcoding_primary':
      return t('wallpaperPanel.uploadStatus.transcodingPrimary', { codec: wallpaperCodecLabel(status.codec) })
    case 'transcoding_variant':
      return t('wallpaperPanel.uploadStatus.transcodingVariant', { codec: wallpaperCodecLabel(status.codec) })
    case 'extracting_poster':
      return t('wallpaperPanel.uploadStatus.extractingPoster')
    case 'finalizing':
      return t('wallpaperPanel.uploadStatus.finalizing')
    case 'completed':
      return t('wallpaperPanel.uploadStatus.completed')
    default:
      return t('wallpaperPanel.uploadStatus.waiting')
  }
}

function getWallpaperUploadMeta(status: WallpaperUploadStatus, t: any): string | null {
  if (status.phase === 'uploading') {
    return t('wallpaperPanel.uploadStatus.uploadedPercent', {
      percent: Math.max(0, Math.min(100, Math.round(status.uploadPercent || 0))),
    })
  }

  if (status.phase === 'waiting_server' || status.phase === 'received') {
    return t('wallpaperPanel.uploadStatus.awaitingBackend')
  }

  if (
    (status.phase === 'transcoding_primary' || status.phase === 'transcoding_variant')
    && typeof status.phaseProgressPct === 'number'
  ) {
    return t('wallpaperPanel.uploadStatus.stepWithBackendPercent', {
      current: Math.max(1, Math.min(status.step, status.totalSteps || 1)),
      total: Math.max(1, status.totalSteps || 1),
      percent: Math.max(0, Math.min(100, Math.round(status.phaseProgressPct))),
    })
  }

  if (status.totalSteps > 0) {
    const currentStep = status.phase === 'completed'
      ? status.totalSteps
      : Math.max(1, Math.min(status.step, status.totalSteps))
    return t('wallpaperPanel.uploadStatus.step', {
      current: currentStep,
      total: status.totalSteps,
    })
  }

  return null
}

function getWallpaperPreviewUrl(wallpaper: WallpaperRef | null | undefined): string | null {
  if (!wallpaper?.image_id) return null
  return wallpaper.type === 'video'
    ? imagesApi.largeUrl(wallpaper.image_id)
    : imagesApi.url(wallpaper.image_id)
}

export default function WallpaperPanel() {
  const { t } = useTranslation('panels')
  const wallpaper = useStore((s) => s.wallpaper)
  const setWallpaper = useStore((s) => s.setWallpaper)
  const useCharacterBackground = useStore((s) => s.useCharacterBackground)
  const setSetting = useStore((s) => s.setSetting)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeChatWallpaper = useStore((s) => s.activeChatWallpaper)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const setActiveChatWallpaper = useStore((s) => s.setActiveChatWallpaper)
  const setActiveChatMetadata = useStore((s) => s.setActiveChatMetadata)

  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [uploadStatus, setUploadStatus] = useState<WallpaperUploadStatus | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadStatusClearTimerRef = useRef<number | null>(null)
  const [uploadTarget, setUploadTarget] = useState<'global' | 'chat'>('global')
  const [libraryTarget, setLibraryTarget] = useState<'global' | 'chat' | null>(null)

  const globalWp = wallpaper.global
  const chatWp = activeChatWallpaper
  const globalPreviewUrl = getWallpaperPreviewUrl(globalWp)
  const chatPreviewUrl = getWallpaperPreviewUrl(chatWp)
  const blurValue = Math.min(Math.max(wallpaper.blur ?? 0, 0), MAX_WALLPAPER_BLUR)
  const uploadStatusTargetLabel = uploadStatus
    ? uploadStatus.target === 'chat'
      ? t('wallpaperPanel.chatWallpaper')
      : t('wallpaperPanel.globalWallpaper')
    : null
  const uploadProgressPercent = uploadStatus ? getWallpaperUploadPercent(uploadStatus) : 0
  const uploadStatusMessage = uploadStatus ? getWallpaperUploadMessage(uploadStatus, t) : null
  const uploadStatusMeta = uploadStatus ? getWallpaperUploadMeta(uploadStatus, t) : null

  const clearUploadStatusTimer = () => {
    if (uploadStatusClearTimerRef.current) {
      clearTimeout(uploadStatusClearTimerRef.current)
      uploadStatusClearTimerRef.current = null
    }
  }

  const scheduleUploadStatusClear = () => {
    clearUploadStatusTimer()
    uploadStatusClearTimerRef.current = window.setTimeout(() => {
      setUploadStatus((current) => (current?.phase === 'completed' ? null : current))
      uploadStatusClearTimerRef.current = null
    }, COMPLETED_UPLOAD_STATUS_LINGER_MS)
  }

  useEffect(() => {
    return () => clearUploadStatusTimer()
  }, [])

  useEffect(() => {
    return wsClient.on(EventType.WALLPAPER_UPLOAD_PROGRESS, (payload: WallpaperUploadProgressPayload) => {
      setUploadStatus((current) => {
        if (!current || current.uploadId !== payload.uploadId) return current
        return {
          ...current,
          phase: payload.phase,
          uploadPercent: 100,
          step: payload.step,
          totalSteps: payload.totalSteps,
          codec: payload.codec ?? current.codec,
          phaseProgressPct: payload.phaseProgressPct,
          currentTimeMs: payload.currentTimeMs,
          durationMs: payload.durationMs,
          speed: payload.speed,
        }
      })
    })
  }, [])

  const handleUpload = async (target: 'global' | 'chat') => {
    setUploadTarget(target)
    // Opening the native file picker can briefly hide/blur the page. Suppress
    // the next fast resume ping so a large wallpaper upload does not trip a
    // false WS reconnect the moment the picker closes.
    wsClient.suppressNextResumePingFor(FILE_PICKER_RESUME_PING_SUPPRESSION_MS)
    fileInputRef.current?.click()
  }

  const applyWallpaper = async (target: 'global' | 'chat', ref: WallpaperRef) => {
    setError(null)
    try {
      if (target === 'chat') {
        if (!activeChatId) throw new Error(t('wallpaperPanel.openChatHint'))
        const oldImageId = activeChatWallpaper?.image_id
        await chatsApi.patchMetadata(activeChatId, { wallpaper: ref })
        setActiveChatWallpaper(ref)
        if (oldImageId && oldImageId !== ref.image_id) void imagesApi.deleteIfUnused(oldImageId).catch(() => {})
        return
      }

      const oldImageId = wallpaper.global?.image_id
      setWallpaper({ global: ref })
      await flushSettingsNow()
      if (oldImageId && oldImageId !== ref.image_id) void imagesApi.deleteIfUnused(oldImageId).catch(() => {})
    } catch (err: any) {
      setError(err?.message || t('wallpaperPanel.assignFailed'))
      throw err
    }
  }

  const onFileSelected: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    const kind = detectWallpaperFileKind(file)
    const isVideo = kind === 'video'

    if (isVideo && file.size > MAX_VIDEO_SIZE) {
      setError(t('wallpaperPanel.videoTooLarge', { size: (file.size / 1024 / 1024).toFixed(1) }))
      return
    }

    if (!kind) {
      setError(t('wallpaperPanel.invalidFileType'))
      return
    }

    setError(null)
    clearUploadStatusTimer()
    setUploading(true)
    const nextUploadId = createWallpaperUploadId()
    const nextTarget = uploadTarget
    setUploadStatus({
      uploadId: nextUploadId,
      target: nextTarget,
      kind,
      phase: 'uploading',
      uploadPercent: 0,
      step: 0,
      totalSteps: kind === 'video' ? 4 : 1,
      phaseProgressPct: 0,
    })

    try {
      const image = await imagesApi.uploadWallpaper(file, kind, {
        uploadId: nextUploadId,
        onProgress: (percent) => {
          setUploadStatus((current) => {
            if (!current || current.uploadId !== nextUploadId) return current
            if (current.phase !== 'uploading' && current.phase !== 'waiting_server') return current
            return {
              ...current,
              uploadPercent: Math.max(0, Math.min(100, percent)),
              phase: percent >= 100 ? 'waiting_server' : 'uploading',
              phaseProgressPct: 0,
            }
          })
        },
      })
      const ref: WallpaperRef = {
        image_id: image.id,
        type: kind,
      }
      await applyWallpaper(nextTarget, ref)
      setUploadStatus((current) => {
        if (!current || current.uploadId !== nextUploadId) return current
        const totalSteps = current.totalSteps > 0 ? current.totalSteps : 1
        return {
          ...current,
          phase: 'completed',
          uploadPercent: 100,
          step: totalSteps,
          totalSteps,
          phaseProgressPct: 100,
        }
      })
      scheduleUploadStatusClear()
    } catch (err: any) {
      clearUploadStatusTimer()
      setUploadStatus((current) => (current?.uploadId === nextUploadId ? null : current))
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

  const handleLibraryDelete = (imageId: string) => {
    if (wallpaper.global?.image_id === imageId) {
      setWallpaper({ global: null })
    }

    if (activeChatWallpaper?.image_id === imageId) {
      setActiveChatWallpaper(null)
      setActiveChatMetadata(activeChatMetadata ? { ...activeChatMetadata, wallpaper: null } : { wallpaper: null })
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
        {globalPreviewUrl ? (
          <>
            <img className={styles.previewImg} src={globalPreviewUrl} alt={t('wallpaperPanel.globalWallpaperAlt')} />
            {globalWp?.type === 'video' && <span className={styles.previewBadge}>{t('wallpaperPanel.video')}</span>}
          </>
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
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={() => setLibraryTarget('global')}
        >
          <ImageIcon size={14} />
          <span>{t('wallpaperPanel.browseLibrary')}</span>
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
            {chatPreviewUrl ? (
              <>
                <img className={styles.previewImg} src={chatPreviewUrl} alt={t('wallpaperPanel.chatWallpaperAlt')} />
                {chatWp?.type === 'video' && <span className={styles.previewBadge}>{t('wallpaperPanel.video')}</span>}
              </>
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
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => setLibraryTarget('chat')}
            >
              <ImageIcon size={14} />
              <span>{t('wallpaperPanel.browseLibrary')}</span>
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

      {uploadStatus && (
        <div
          className={`${styles.uploadStatus}${uploadStatus.phase === 'completed' ? ` ${styles.uploadStatusComplete}` : ''}`}
          aria-live="polite"
        >
          <div className={styles.uploadStatusHeader}>
            <span className={styles.uploadStatusTitle}>
              {t('wallpaperPanel.uploadStatus.title', { target: uploadStatusTargetLabel })}
            </span>
            <span className={styles.uploadStatusPercent}>{uploadProgressPercent}%</span>
          </div>
          <div className={styles.uploadStatusMessage}>{uploadStatusMessage}</div>
          <div className={styles.progressTrack}>
            <div
              className={`${styles.progressFill}${uploadStatus.phase === 'completed' ? ` ${styles.progressFillComplete}` : ''}`}
              style={{ width: `${uploadProgressPercent}%` }}
            />
          </div>
          {uploadStatusMeta && <div className={styles.uploadStatusMeta}>{uploadStatusMeta}</div>}
        </div>
      )}

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
        <FormField label={`Blur (${blurValue}px)`}>
          <input
            className={styles.slider}
            type="range"
            min={0}
            max={MAX_WALLPAPER_BLUR}
            step={1}
            value={blurValue}
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

      <WallpaperLibraryModal
        isOpen={libraryTarget !== null}
        target={libraryTarget ?? 'global'}
        currentImageId={libraryTarget === 'chat' ? chatWp?.image_id ?? null : globalWp?.image_id ?? null}
        onClose={() => setLibraryTarget(null)}
        onSelect={(ref) => applyWallpaper(libraryTarget ?? 'global', ref)}
        onDelete={handleLibraryDelete}
      />
    </div>
  )
}

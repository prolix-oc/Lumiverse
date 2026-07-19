import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Film, Image as ImageIcon, Loader2, Trash2 } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { ModalShell } from '@/components/shared/ModalShell'
import { imagesApi } from '@/api/images'
import type { Image } from '@/types/api'
import type { WallpaperRef } from '@/types/store'
import styles from './WallpaperLibraryModal.module.css'
import clsx from 'clsx'

const PAGE_SIZE = 36

interface WallpaperLibraryModalProps {
  isOpen: boolean
  target: 'global' | 'chat'
  currentImageId: string | null
  onClose: () => void
  onSelect: (ref: WallpaperRef) => Promise<void> | void
  onDelete?: (imageId: string) => void
}

function formatBytes(bytes: number, unknownLabel: string): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return unknownLabel
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function formatResolution(item: Image, unknownLabel: string): string {
  return item.width && item.height ? `${item.width} x ${item.height}` : unknownLabel
}

function toWallpaperRef(item: Image): WallpaperRef {
  return {
    image_id: item.id,
    type: item.mime_type.startsWith('video/') ? 'video' : 'image',
  }
}

export default function WallpaperLibraryModal({
  isOpen,
  target,
  currentImageId,
  onClose,
  onSelect,
  onDelete,
}: WallpaperLibraryModalProps) {
  const { t, i18n } = useTranslation('panels')
  const [items, setItems] = useState<Image[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [applyingId, setApplyingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteCandidate, setDeleteCandidate] = useState<Image | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    setError(null)
    try {
      const result = await imagesApi.listWallpapers({ limit: PAGE_SIZE, offset })
      setItems((prev) => {
        if (!append) return result.data
        const seen = new Set(prev.map((item) => item.id))
        return [...prev, ...result.data.filter((item) => !seen.has(item.id))]
      })
      setTotal(result.total)
    } catch (err: any) {
      setError(err?.message || t('wallpaperLibrary.loadFailed'))
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [t])

  useEffect(() => {
    if (!isOpen) return
    setItems([])
    setTotal(0)
    setApplyingId(null)
    setDeletingId(null)
    setDeleteCandidate(null)
    void loadPage(0, false)
  }, [isOpen, loadPage])

  const handleApply = useCallback(async (item: Image) => {
    setApplyingId(item.id)
    try {
      await onSelect(toWallpaperRef(item))
      onClose()
    } catch {
      // The parent panel surfaces assignment errors inline.
    } finally {
      setApplyingId(null)
    }
  }, [onClose, onSelect])

  const handleDelete = useCallback(async (item: Image) => {
    setDeletingId(item.id)
    setError(null)
    try {
      await imagesApi.deleteWallpaper(item.id)
      setItems((prev) => prev.filter((entry) => entry.id !== item.id))
      setTotal((prev) => Math.max(0, prev - 1))
      setDeleteCandidate(null)
      onDelete?.(item.id)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('wallpaperLibrary.deleteFailed'))
    } finally {
      setDeletingId(null)
    }
  }, [onDelete, t])

  const canLoadMore = items.length < total
  const scopeLabel = target === 'chat' ? t('wallpaperPanel.chatWallpaper') : t('wallpaperPanel.globalWallpaper')
  const unknownValue = t('wallpaperLibrary.unknownValue')
  const actionBusy = applyingId !== null || deletingId !== null

  return (
    <ModalShell isOpen={isOpen} onClose={onClose} maxWidth={1040} maxHeight="86vh" className={styles.modal}>
      <CloseButton onClick={onClose} variant="solid" position="absolute" className={styles.closeBtnPos} />

      <div className={styles.header}>
        <div>
          <h3 className={styles.title}>{t('wallpaperLibrary.title')}</h3>
          <p className={styles.subtitle}>{t('wallpaperLibrary.subtitle', { scope: scopeLabel })}</p>
        </div>
        <span className={styles.count}>{t('wallpaperLibrary.count', { count: total })}</span>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.scrollArea}>
        {loading && items.length === 0 ? (
          <div className={styles.state}>{t('wallpaperLibrary.loading')}</div>
        ) : items.length === 0 ? (
          <div className={styles.state}>{t('wallpaperLibrary.empty')}</div>
        ) : (
          <div className={styles.grid}>
            {items.map((item) => {
              const isVideo = item.mime_type.startsWith('video/')
              const isCurrent = item.id === currentImageId
              const thumbUrl = item.has_thumbnail ? imagesApi.smallUrl(item.id) : null

              return (
                <article key={item.id} className={clsx(styles.card, isCurrent && styles.cardCurrent)}>
                  <div className={styles.thumb}>
                    {thumbUrl ? (
                      <img
                        src={thumbUrl}
                        alt={item.original_filename || t('wallpaperLibrary.thumbnailAlt')}
                        className={styles.thumbImage}
                      />
                    ) : (
                      <div className={styles.thumbPlaceholder}>
                        {isVideo ? <Film size={20} /> : <ImageIcon size={20} />}
                        <span>{t('wallpaperLibrary.noPreview')}</span>
                      </div>
                    )}
                    {isVideo && <span className={styles.badge}>{t('wallpaperPanel.video')}</span>}
                    {isCurrent && (
                      <span className={styles.currentBadge}>
                        <Check size={12} />
                        {t('wallpaperLibrary.current')}
                      </span>
                    )}
                  </div>

                  <div className={styles.meta}>
                    <div className={styles.filename} title={item.original_filename}>
                      {item.original_filename || t('wallpaperLibrary.untitled')}
                    </div>
                    <div className={styles.metaRow}>
                      <span>{t('wallpaperLibrary.uploaded')}</span>
                      <strong>{new Date(item.created_at * 1000).toLocaleString(i18n.language, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}</strong>
                    </div>
                    <div className={styles.metaRow}>
                      <span>{t('wallpaperLibrary.size')}</span>
                      <strong>{formatBytes(item.byte_size, unknownValue)}</strong>
                    </div>
                    <div className={styles.metaRow}>
                      <span>{t('wallpaperLibrary.resolution')}</span>
                      <strong>{formatResolution(item, unknownValue)}</strong>
                    </div>
                  </div>

                  <div className={styles.cardActions}>
                    <button
                      type="button"
                      className={styles.applyBtn}
                      disabled={actionBusy}
                      onClick={() => handleApply(item)}
                    >
                      {applyingId === item.id ? t('wallpaperLibrary.applying') : t('wallpaperLibrary.apply', { scope: scopeLabel })}
                    </button>
                    <button
                      type="button"
                      className={styles.deleteBtn}
                      disabled={actionBusy}
                      onClick={() => setDeleteCandidate(item)}
                      aria-label={t('wallpaperLibrary.delete')}
                      title={t('wallpaperLibrary.delete')}
                    >
                      {deletingId === item.id ? <Loader2 size={14} className={styles.spin} /> : <Trash2 size={14} />}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      {canLoadMore && (
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.loadMoreBtn}
            onClick={() => void loadPage(items.length, true)}
            disabled={loadingMore || loading || actionBusy}
          >
            {loadingMore ? t('wallpaperLibrary.loadingMore') : t('wallpaperLibrary.loadMore')}
          </button>
        </div>
      )}

      {deleteCandidate && (
        <ConfirmationModal
          isOpen={true}
          title={t('wallpaperLibrary.deleteConfirmTitle')}
          message={t('wallpaperLibrary.deleteConfirmMessage', {
            name: deleteCandidate.original_filename || t('wallpaperLibrary.untitled'),
          })}
          variant="danger"
          confirmText={t('wallpaperLibrary.delete')}
          loading={deletingId === deleteCandidate.id}
          loadingText={t('wallpaperLibrary.deleting')}
          onConfirm={() => { void handleDelete(deleteCandidate) }}
          onCancel={() => {
            if (deletingId === null) setDeleteCandidate(null)
          }}
        />
      )}
    </ModalShell>
  )
}

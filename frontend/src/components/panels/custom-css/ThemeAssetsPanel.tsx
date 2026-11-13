import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, Copy, FileImage, Link2, Loader2, Save, Trash2, Upload } from 'lucide-react'
import LazyImage from '@/components/shared/LazyImage'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { themeAssetsApi } from '@/api/theme-assets'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toThemeAssetRelativePath } from '@/lib/themeAssetCss'
import { toast } from '@/lib/toast'
import i18n from '@/i18n'
import type { ThemeAsset } from '@/types/api'
import styles from './ThemeAssetsPanel.module.css'
import clsx from 'clsx'

interface Props {
  bundleId: string
  onInsertReference: (text: string) => void
}

function isFontAsset(asset: ThemeAsset): boolean {
  return asset.mime_type.startsWith('font/')
    || asset.mime_type === 'application/font-woff'
    || asset.mime_type === 'application/x-font-woff'
    || asset.mime_type === 'application/x-font-ttf'
    || asset.mime_type === 'application/x-font-opentype'
    || asset.mime_type === 'application/vnd.ms-fontobject'
}

function guessFontFormat(asset: ThemeAsset): string {
  const mime = asset.mime_type.toLowerCase()
  if (mime.includes('woff2')) return 'woff2'
  if (mime.includes('woff')) return 'woff'
  if (mime.includes('ttf')) return 'truetype'
  if (mime.includes('otf') || mime.includes('opentype')) return 'opentype'
  if (mime.includes('fontobject') || asset.original_filename.toLowerCase().endsWith('.eot')) return 'embedded-opentype'
  return 'woff2'
}

function guessFontFamily(asset: ThemeAsset): string {
  const stem = asset.original_filename.replace(/\.[^.]+$/, '') || i18n.t('panels:customCssPanel.themeAssets.themeFontFallback')
  return stem
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function ThemeAssetRow({
  asset,
  bundleId,
  expanded,
  onToggle,
  onChanged,
  onDeleted,
  onInsertReference,
}: {
  asset: ThemeAsset
  bundleId: string
  expanded: boolean
  onToggle: () => void
  onChanged: (next: ThemeAsset) => void
  onDeleted: (id: string) => void
  onInsertReference: (text: string) => void
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'customCssPanel.themeAssets' })
  const [slug, setSlug] = useState(asset.slug)
  const [tags, setTags] = useState(asset.tags.join(', '))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [optimizing, setOptimizing] = useState(false)

  useEffect(() => {
    setSlug(asset.slug)
    setTags(asset.tags.join(', '))
  }, [asset.slug, asset.tags])

  const previewUrl = themeAssetsApi.bundleUrl(bundleId, asset.slug)
  const relativePath = toThemeAssetRelativePath(asset.slug)
  const hasChanges = slug.trim() !== asset.slug || tags.trim() !== asset.tags.join(', ')
  const canOptimizeToWebp = asset.storage_type === 'image' && asset.mime_type !== 'image/webp' && asset.mime_type !== 'image/svg+xml'
  const canInsertFontFace = isFontAsset(asset)

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const updated = await themeAssetsApi.update(asset.id, {
        slug,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      })
      onChanged(updated)
      toast.success(t('toast.updated'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('toast.updateFailed'))
    } finally {
      setSaving(false)
    }
  }, [asset.id, onChanged, slug, tags, t])

  const handleDelete = useCallback(async () => {
    setConfirmDelete(false)
    setDeleting(true)
    try {
      await themeAssetsApi.delete(asset.id)
      onDeleted(asset.id)
      toast.info(t('toast.deleted'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('toast.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }, [asset.id, onDeleted, t])

  const handleOptimizeWebp = useCallback(async () => {
    setOptimizing(true)
    try {
      const updated = await themeAssetsApi.optimizeWebp(asset.id)
      onChanged(updated)
      toast.success(t('toast.optimized'))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('toast.optimizeFailed'))
    } finally {
      setOptimizing(false)
    }
  }, [asset.id, onChanged, t])

  return (
    <div className={styles.assetCard}>
      <button type="button" className={styles.assetSummary} onClick={onToggle} aria-expanded={expanded}>
        <span className={styles.assetSummaryLeft}>
          <span className={styles.assetChevron}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
          <span className={styles.assetSummaryIcon}><FileImage size={14} /></span>
          <span className={styles.assetSummaryText}>
            <span className={styles.assetTitle}>{asset.original_filename}</span>
            <span className={styles.assetSummaryMeta}>{asset.slug}</span>
          </span>
        </span>
        <span className={styles.assetSummaryRight}>
          <span className={styles.assetType}>{asset.mime_type}</span>
          <span className={styles.assetStats}>{Math.max(1, Math.round(asset.byte_size / 1024))} KB</span>
        </span>
      </button>

      {expanded && (
        <div className={styles.assetBody}>
          <LazyImage
            src={previewUrl}
            alt={asset.original_filename}
            className={styles.assetPreview}
            containerClassName={styles.assetPreviewWrap}
            spinnerSize={14}
            fallback={<div className={styles.assetPreviewFallback}><FileImage size={18} /></div>}
          />
          <div className={styles.assetMeta}>
            <label className={styles.assetLabel}>
              {t('slug')}
              <input className={styles.assetInput} value={slug} onChange={(e) => setSlug(e.target.value)} />
            </label>
            <label className={styles.assetLabel}>
              {t('tags')}
              <input className={styles.assetInput} value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('tagsPlaceholder')} />
            </label>
            <div className={styles.assetActions}>
              <button type="button" className={styles.assetBtn} onClick={() => copyTextToClipboard(relativePath).then(() => toast.success(t('toast.pathCopied'))).catch(() => toast.error(t('toast.pathCopyFailed')))}>
                <Copy size={12} /> {t('path')}
              </button>
              <button type="button" className={styles.assetBtn} onClick={() => copyTextToClipboard(previewUrl).then(() => toast.success(t('toast.urlCopied'))).catch(() => toast.error(t('toast.urlCopyFailed')))}>
                <Link2 size={12} /> {t('url')}
              </button>
              <button type="button" className={styles.assetBtn} onClick={() => onInsertReference(`url("${relativePath}")`)}>
                <FileImage size={12} /> {t('insert')}
              </button>
              {canInsertFontFace && (
                <button
                  type="button"
                  className={styles.assetBtn}
                  onClick={() => onInsertReference(`@font-face {\n  font-family: "${guessFontFamily(asset)}";\n  src: url("${relativePath}") format("${guessFontFormat(asset)}");\n  font-display: swap;\n}\n`)}
                >
                  <FileImage size={12} /> {t('fontFace')}
                </button>
              )}
              {canOptimizeToWebp && (
                <button type="button" className={clsx(styles.assetBtn, styles.assetBtnAccent)} onClick={handleOptimizeWebp} disabled={saving || deleting || optimizing}>
                  {optimizing ? <Loader2 size={12} className={styles.spin} /> : <FileImage size={12} />} {t('webp')}
                </button>
              )}
              <button type="button" className={clsx(styles.assetBtn, styles.assetBtnPrimary)} onClick={handleSave} disabled={!hasChanges || saving || deleting || optimizing}>
                {saving ? <Loader2 size={12} className={styles.spin} /> : <Save size={12} />} {t('save')}
              </button>
              <button type="button" className={clsx(styles.assetBtn, styles.assetBtnDanger)} onClick={() => setConfirmDelete(true)} disabled={saving || deleting || optimizing}>
                {deleting ? <Loader2 size={12} className={styles.spin} /> : <Trash2 size={12} />} {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <ConfirmationModal
          isOpen={true}
          title={t('deleteConfirmTitle')}
          message={t('deleteConfirmMessage', { name: asset.original_filename })}
          variant="danger"
          confirmText={t('delete')}
          onConfirm={() => { void handleDelete() }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

export default function ThemeAssetsPanel({ bundleId, onInsertReference }: Props) {
  const { t } = useTranslation('panels', { keyPrefix: 'customCssPanel.themeAssets' })
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [assets, setAssets] = useState<ThemeAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [expandedIds, setExpandedIds] = useState<string[]>([])

  const loadAssets = useCallback(async () => {
    setLoading(true)
    try {
      const nextAssets = await themeAssetsApi.list(bundleId)
      setAssets(nextAssets)
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('toast.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [bundleId, t])

  useEffect(() => {
    void loadAssets()
  }, [loadAssets])

  const sortedAssets = useMemo(
    () => [...assets].sort((a, b) => a.slug.localeCompare(b.slug)),
    [assets],
  )

  const allExpanded = sortedAssets.length > 0 && sortedAssets.every((asset) => expandedIds.includes(asset.id))

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id])
  }, [])

  const toggleAllExpanded = useCallback(() => {
    setExpandedIds((current) => {
      const nextIds = sortedAssets.map((asset) => asset.id)
      return nextIds.length > 0 && nextIds.every((id) => current.includes(id)) ? [] : nextIds
    })
  }, [sortedAssets])

  const handleFilePick = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      const asset = await themeAssetsApi.upload(file, { bundleId })
      setAssets((current) => [...current, asset])
      toast.success(t('toast.uploaded', { name: asset.original_filename }))
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || t('toast.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }, [bundleId, t])

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h4 className={styles.panelTitle}>{t('title')}</h4>
          <p className={styles.panelHint}>{t('hint')}</p>
        </div>
        <div className={styles.panelActions}>
          {sortedAssets.length > 0 && (
            <button type="button" className={styles.panelBtn} onClick={toggleAllExpanded}>
              {allExpanded ? t('collapseAll') : t('expandAll')}
            </button>
          )}
          <button type="button" className={styles.panelBtn} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 size={13} className={styles.spin} /> : <Upload size={13} />} {t('upload')}
          </button>
          <input ref={fileInputRef} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,font/woff,font/woff2,font/ttf,font/otf,.svg,.woff,.woff2,.ttf,.otf,.eot" onChange={handleFilePick} />
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}><Loader2 size={15} className={styles.spin} /> {t('loading')}</div>
      ) : sortedAssets.length === 0 ? (
        <div className={styles.emptyState}>{t('empty')}</div>
      ) : (
        <div className={styles.assetList}>
          {sortedAssets.map((asset) => (
            <ThemeAssetRow
              key={asset.id}
              asset={asset}
              bundleId={bundleId}
              expanded={expandedIds.includes(asset.id)}
              onToggle={() => toggleExpanded(asset.id)}
              onChanged={(next) => setAssets((current) => current.map((entry) => entry.id === next.id ? next : entry))}
              onDeleted={(id) => {
                setAssets((current) => current.filter((entry) => entry.id !== id))
                setExpandedIds((current) => current.filter((entry) => entry !== id))
              }}
              onInsertReference={onInsertReference}
            />
          ))}
        </div>
      )}
    </section>
  )
}

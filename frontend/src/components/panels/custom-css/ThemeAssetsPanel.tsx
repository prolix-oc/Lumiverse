import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { ChevronDown, ChevronRight, Copy, FileImage, Link2, Loader2, Save, Trash2, Upload } from 'lucide-react'
import LazyImage from '@/components/shared/LazyImage'
import { themeAssetsApi } from '@/api/theme-assets'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toThemeAssetRelativePath } from '@/lib/themeAssetCss'
import { toast } from '@/lib/toast'
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
  const stem = asset.original_filename.replace(/\.[^.]+$/, '') || 'Theme Font'
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
  const [slug, setSlug] = useState(asset.slug)
  const [tags, setTags] = useState(asset.tags.join(', '))
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
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
      toast.success('Theme asset updated')
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || 'Failed to update theme asset')
    } finally {
      setSaving(false)
    }
  }, [asset.id, onChanged, slug, tags])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await themeAssetsApi.delete(asset.id)
      onDeleted(asset.id)
      toast.info('Theme asset deleted')
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || 'Failed to delete theme asset')
    } finally {
      setDeleting(false)
    }
  }, [asset.id, onDeleted])

  const handleOptimizeWebp = useCallback(async () => {
    setOptimizing(true)
    try {
      const updated = await themeAssetsApi.optimizeWebp(asset.id)
      onChanged(updated)
      toast.success('Theme asset optimized to WebP')
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || 'Failed to optimize theme asset')
    } finally {
      setOptimizing(false)
    }
  }, [asset.id, onChanged])

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
              Slug
              <input className={styles.assetInput} value={slug} onChange={(e) => setSlug(e.target.value)} />
            </label>
            <label className={styles.assetLabel}>
              Tags
              <input className={styles.assetInput} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="bg, icon, texture" />
            </label>
            <div className={styles.assetActions}>
              <button type="button" className={styles.assetBtn} onClick={() => copyTextToClipboard(relativePath).then(() => toast.success('Relative path copied')).catch(() => toast.error('Failed to copy relative path'))}>
                <Copy size={12} /> Path
              </button>
              <button type="button" className={styles.assetBtn} onClick={() => copyTextToClipboard(previewUrl).then(() => toast.success('Resolved URL copied')).catch(() => toast.error('Failed to copy URL'))}>
                <Link2 size={12} /> URL
              </button>
              <button type="button" className={styles.assetBtn} onClick={() => onInsertReference(`url("${relativePath}")`)}>
                <FileImage size={12} /> Insert
              </button>
              {canInsertFontFace && (
                <button
                  type="button"
                  className={styles.assetBtn}
                  onClick={() => onInsertReference(`@font-face {\n  font-family: "${guessFontFamily(asset)}";\n  src: url("${relativePath}") format("${guessFontFormat(asset)}");\n  font-display: swap;\n}\n`)}
                >
                  <FileImage size={12} /> @font-face
                </button>
              )}
              {canOptimizeToWebp && (
                <button type="button" className={clsx(styles.assetBtn, styles.assetBtnAccent)} onClick={handleOptimizeWebp} disabled={saving || deleting || optimizing}>
                  {optimizing ? <Loader2 size={12} className={styles.spin} /> : <FileImage size={12} />} WebP
                </button>
              )}
              <button type="button" className={clsx(styles.assetBtn, styles.assetBtnPrimary)} onClick={handleSave} disabled={!hasChanges || saving || deleting || optimizing}>
                {saving ? <Loader2 size={12} className={styles.spin} /> : <Save size={12} />} Save
              </button>
              <button type="button" className={clsx(styles.assetBtn, styles.assetBtnDanger)} onClick={handleDelete} disabled={saving || deleting || optimizing}>
                {deleting ? <Loader2 size={12} className={styles.spin} /> : <Trash2 size={12} />} Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ThemeAssetsPanel({ bundleId, onInsertReference }: Props) {
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
      toast.error(err?.body?.error || err?.message || 'Failed to load theme assets')
    } finally {
      setLoading(false)
    }
  }, [bundleId])

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
      toast.success(`Uploaded ${asset.original_filename}`)
    } catch (err: any) {
      toast.error(err?.body?.error || err?.message || 'Failed to upload theme asset')
    } finally {
      setUploading(false)
    }
  }, [bundleId])

  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div>
          <h4 className={styles.panelTitle}>Theme Assets</h4>
          <p className={styles.panelHint}>Upload SVGs, images, and web fonts, then reference them with relative paths like <code>url("./assets/bg.png")</code> or <code>url("./assets/my-font.woff2")</code> inside <code>@font-face</code>.</p>
        </div>
        <div className={styles.panelActions}>
          {sortedAssets.length > 0 && (
            <button type="button" className={styles.panelBtn} onClick={toggleAllExpanded}>
              {allExpanded ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          <button type="button" className={styles.panelBtn} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
            {uploading ? <Loader2 size={13} className={styles.spin} /> : <Upload size={13} />} Upload
          </button>
          <input ref={fileInputRef} className={styles.hiddenInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml,font/woff,font/woff2,font/ttf,font/otf,.svg,.woff,.woff2,.ttf,.otf,.eot" onChange={handleFilePick} />
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState}><Loader2 size={15} className={styles.spin} /> Loading assets...</div>
      ) : sortedAssets.length === 0 ? (
        <div className={styles.emptyState}>No assets yet. Upload a background, texture, SVG icon, or custom font to start building relative CSS references.</div>
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

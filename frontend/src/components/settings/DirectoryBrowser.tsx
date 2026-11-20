import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, ArrowUp, ChevronRight } from 'lucide-react'
import { stMigrationApi, type BrowseResult, type FileConnectionConfig } from '@/api/st-migration'
import styles from './DirectoryBrowser.module.css'

interface DirectoryBrowserProps {
  onNavigate?: (path: string) => void
  /** Fired on each load with whether the current directory matches the core
   *  SillyTavern install shape (a soft hint — Validate remains authoritative). */
  onShapeChange?: (looksLikeSillyTavern: boolean) => void
  initialPath?: string
  connection?: FileConnectionConfig
}

// A SillyTavern install root contains both data/ (per-user data) and public/
// (web root) on modern installs, or public/ alongside default/ on legacy ones.
// These are the same folders the backend /validate endpoint keys off of.
function looksLikeSillyTavernRoot(entries: { name: string }[]): boolean {
  const names = new Set(entries.map((e) => e.name.toLowerCase()))
  return names.has('public') && (names.has('data') || names.has('default'))
}

export default function DirectoryBrowser({ onNavigate, onShapeChange, initialPath, connection }: DirectoryBrowserProps) {
  const { t } = useTranslation('settings')
  const [data, setData] = useState<BrowseResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')

  const isRemote = connection && connection.type !== 'local'

  const navigate = useCallback(async (path?: string) => {
    setLoading(true)
    setError(null)
    try {
      const result = await stMigrationApi.browse(path, connection)
      setData(result)
      setManualPath(result.path)
      onNavigate?.(result.path)
      onShapeChange?.(looksLikeSillyTavernRoot(result.entries))
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('directoryBrowser.browseFailed'))
      onShapeChange?.(false)
    } finally {
      setLoading(false)
    }
  }, [onNavigate, onShapeChange, connection, t])

  useEffect(() => {
    // For remote connections, start at root. For local, use default (home dir).
    navigate(initialPath || (isRemote ? '/' : undefined))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleManualSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && manualPath.trim()) {
      navigate(manualPath.trim())
    }
  }

  const pathSegments = data?.path ? data.path.split('/').filter(Boolean) : []

  return (
    <div className={styles.container}>
      <div className={styles.breadcrumbs}>
        <button type="button" className={styles.breadcrumbBtn} onClick={() => navigate('/')}>
          /
        </button>
        {pathSegments.map((segment, i) => {
          const segmentPath = '/' + pathSegments.slice(0, i + 1).join('/')
          return (
            <span key={segmentPath} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <span className={styles.breadcrumbSep}><ChevronRight size={10} /></span>
              <button type="button" className={styles.breadcrumbBtn} onClick={() => navigate(segmentPath)}>
                {segment}
              </button>
            </span>
          )
        })}
      </div>

      <div className={styles.list}>
        {loading ? (
          <div className={styles.loading}>{t('directoryBrowser.loading')}</div>
        ) : error ? (
          <div className={styles.error}>{error}</div>
        ) : (
          <>
            {data?.parent && (
              <button type="button" className={styles.entryUp} onClick={() => navigate(data.parent!)}>
                <ArrowUp size={14} className={styles.entryIcon} />
                ..
              </button>
            )}
            {data?.entries.length === 0 && !data?.parent && (
              <div className={styles.empty}>{t('directoryBrowser.noDirectories')}</div>
            )}
            {data?.entries.length === 0 && data?.parent && (
              <div className={styles.empty}>{t('directoryBrowser.emptyDirectory')}</div>
            )}
            {data?.entries.map((entry) => (
              <button
                key={entry.name}
                type="button"
                className={styles.entry}
                onClick={() => navigate(data.path === '/' ? `/${entry.name}` : `${data.path}/${entry.name}`)}
              >
                <Folder size={14} className={styles.entryIcon} />
                {entry.name}
              </button>
            ))}
          </>
        )}
      </div>

      <div className={styles.pathInput}>
        <input
          type="text"
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          onKeyDown={handleManualSubmit}
          placeholder={isRemote ? t('directoryBrowser.pathPlaceholderRemote') : t('directoryBrowser.pathPlaceholderLocal')}
        />
      </div>
    </div>
  )
}

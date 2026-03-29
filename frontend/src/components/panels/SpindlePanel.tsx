import { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw, RotateCw, Trash2, Github, Plus, ChevronDown, Download, FolderOpen, SlidersHorizontal } from 'lucide-react'
import { IconVersions } from '@tabler/icons-react'
import { useStore } from '@/store'
import { spindleApi } from '@/api/spindle'
import type { ExtensionInfo, SpindlePermission } from 'lumiverse-spindle-types'
import SpindleUIControlPanel from '@/components/spindle/SpindleUIControlPanel'
import { Spinner } from '@/components/shared/Spinner'
import { Button } from '@/components/shared/FormComponents'
import styles from './SpindlePanel.module.css'
import clsx from 'clsx'

const OPERATION_LABELS: Record<string, string> = {
  installing: 'Installing...',
  installed: 'Installed',
  updating: 'Updating...',
  updated: 'Updated',
  enabling: 'Starting...',
  enabled: 'Started',
  disabling: 'Stopping...',
  disabled: 'Stopped',
  restarting: 'Restarting...',
  restarted: 'Restarted',
  removing: 'Removing...',
  removed: 'Removed',
}

export default function SpindlePanel() {
  const extensions = useStore((s) => s.extensions)
  const loadExtensions = useStore((s) => s.loadExtensions)
  const installExtension = useStore((s) => s.installExtension)
  const updateExtension = useStore((s) => s.updateExtension)
  const removeExtension = useStore((s) => s.removeExtension)
  const enableExtension = useStore((s) => s.enableExtension)
  const disableExtension = useStore((s) => s.disableExtension)
  const restartExtension = useStore((s) => s.restartExtension)
  const grantPermission = useStore((s) => s.grantPermission)
  const revokePermission = useStore((s) => s.revokePermission)
  const switchBranch = useStore((s) => s.switchBranch)
  const openSettings = useStore((s) => s.openSettings)
  const user = useStore((s) => s.user)
  const spindlePrivileged = useStore((s) => s.spindlePrivileged)

  const extensionOperationStatus = useStore((s) => s.extensionOperationStatus)

  const isPrivileged = spindlePrivileged || user?.role === 'owner' || user?.role === 'admin'

  const [togglingPerm, setTogglingPerm] = useState<string | null>(null)
  const [installUrl, setInstallUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)
  const [importingLocal, setImportingLocal] = useState(false)
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)

  // Branch selection for install
  const [installBranches, setInstallBranches] = useState<string[]>([])
  const [installBranch, setInstallBranch] = useState<string | null>(null)
  const [fetchingBranches, setFetchingBranches] = useState(false)

  // Branch switching for installed extensions
  const [branchMenuExtId, setBranchMenuExtId] = useState<string | null>(null)
  const [branchMenuBranches, setBranchMenuBranches] = useState<string[]>([])
  const [branchMenuCurrent, setBranchMenuCurrent] = useState<string | null>(null)
  const [fetchingExtBranches, setFetchingExtBranches] = useState(false)
  const [addMenuPos, setAddMenuPos] = useState<{ top: number; left: number; width: number }>({
    top: 0,
    left: 12,
    width: 360,
  })
  const addMenuRef = useRef<HTMLDivElement | null>(null)
  const addMenuButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    loadExtensions()
  }, [loadExtensions])

  useEffect(() => {
    if (!addMenuOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      const inMenu = !!addMenuRef.current?.contains(target)
      const inButton = !!addMenuButtonRef.current?.contains(target)
      if (!inMenu && !inButton) {
        setAddMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [addMenuOpen])

  const computeAddMenuPosition = useCallback(() => {
    const rect = addMenuButtonRef.current?.getBoundingClientRect()
    if (!rect) return
    const viewportWidth = window.innerWidth
    const width = Math.min(440, Math.max(280, viewportWidth - 24))
    const maxLeft = Math.max(12, viewportWidth - width - 12)
    const left = Math.min(maxLeft, Math.max(12, rect.left))
    const top = rect.bottom + 8
    setAddMenuPos({ top, left, width })
  }, [])

  useEffect(() => {
    if (!addMenuOpen) return
    computeAddMenuPosition()
    const handleReflow = () => computeAddMenuPosition()
    window.addEventListener('resize', handleReflow)
    window.addEventListener('scroll', handleReflow, true)
    return () => {
      window.removeEventListener('resize', handleReflow)
      window.removeEventListener('scroll', handleReflow, true)
    }
  }, [addMenuOpen, computeAddMenuPosition])

  // Fetch branches when install URL looks like a valid git URL
  const fetchBranchesForUrl = useCallback(async (url: string) => {
    if (!url.trim() || !url.includes('/')) {
      setInstallBranches([])
      setInstallBranch(null)
      return
    }
    setFetchingBranches(true)
    try {
      const { branches } = await spindleApi.listRemoteBranches(url.trim())
      setInstallBranches(branches)
      setInstallBranch(null)
    } catch {
      setInstallBranches([])
      setInstallBranch(null)
    } finally {
      setFetchingBranches(false)
    }
  }, [])

  // Debounced branch fetch on URL change
  useEffect(() => {
    if (!installUrl.trim()) {
      setInstallBranches([])
      setInstallBranch(null)
      return
    }
    const timeout = setTimeout(() => fetchBranchesForUrl(installUrl), 600)
    return () => clearTimeout(timeout)
  }, [installUrl, fetchBranchesForUrl])

  const handleInstall = useCallback(async () => {
    if (!installUrl.trim()) return
    setInstalling(true)
    setInstallError(null)
    try {
      await installExtension(installUrl.trim(), installBranch)
      setInstallUrl('')
      setInstallBranch(null)
      setInstallBranches([])
      setAddMenuOpen(false)
    } catch (err: any) {
      const message = err?.body?.error || err?.message || 'Installation failed'
      setInstallError(message)
      console.error('[Spindle] Install failed:', err)
    } finally {
      setInstalling(false)
    }
  }, [installUrl, installBranch, installExtension])

  const handleToggle = useCallback(async (ext: ExtensionInfo) => {
    setLoadingAction(ext.id)
    try {
      if (ext.enabled) {
        await disableExtension(ext.id)
      } else {
        await enableExtension(ext.id)
      }
    } catch (err: any) {
      console.error('[Spindle] Toggle failed:', err)
    } finally {
      setLoadingAction(null)
    }
  }, [enableExtension, disableExtension])

  const handleUpdate = useCallback(async (ext: ExtensionInfo) => {
    setLoadingAction(ext.id)
    try {
      await updateExtension(ext.id)
    } catch (err: any) {
      console.error('[Spindle] Update failed:', err)
    } finally {
      setLoadingAction(null)
    }
  }, [updateExtension])

  const handleRestart = useCallback(async (ext: ExtensionInfo) => {
    setLoadingAction(ext.id)
    try {
      await restartExtension(ext.id)
    } catch (err: any) {
      console.error('[Spindle] Restart failed:', err)
    } finally {
      setLoadingAction(null)
    }
  }, [restartExtension])

  const handleRemove = useCallback(async (ext: ExtensionInfo) => {
    setLoadingAction(ext.id)
    try {
      await removeExtension(ext.id)
    } catch (err: any) {
      console.error('[Spindle] Remove failed:', err)
    } finally {
      setLoadingAction(null)
    }
  }, [removeExtension])

  const handleOpenBranchMenu = useCallback(async (ext: ExtensionInfo) => {
    if (branchMenuExtId === ext.id) {
      setBranchMenuExtId(null)
      return
    }
    setBranchMenuExtId(ext.id)
    setBranchMenuBranches([])
    setBranchMenuCurrent(null)
    setFetchingExtBranches(true)
    try {
      const result = await spindleApi.getBranches(ext.id)
      setBranchMenuBranches(result.branches)
      setBranchMenuCurrent(result.current)
    } catch (err: any) {
      console.error('[Spindle] Failed to fetch branches:', err)
      setBranchMenuExtId(null)
    } finally {
      setFetchingExtBranches(false)
    }
  }, [branchMenuExtId])

  const handleSwitchBranch = useCallback(async (ext: ExtensionInfo, branch: string) => {
    setLoadingAction(ext.id)
    setBranchMenuExtId(null)
    try {
      await switchBranch(ext.id, branch)
    } catch (err: any) {
      console.error('[Spindle] Branch switch failed:', err)
    } finally {
      setLoadingAction(null)
    }
  }, [switchBranch])

  const handlePermissionToggle = useCallback(async (ext: ExtensionInfo, perm: string) => {
    const key = `${ext.id}:${perm}`
    setTogglingPerm(key)
    try {
      if (ext.granted_permissions.includes(perm as SpindlePermission)) {
        await revokePermission(ext.id, perm)
      } else {
        await grantPermission(ext.id, perm)
      }
    } catch (err: any) {
      console.error('[Spindle] Permission toggle failed:', err)
    } finally {
      setTogglingPerm(null)
    }
  }, [grantPermission, revokePermission])

  const handleImportLocal = useCallback(async () => {
    setImportingLocal(true)
    setImportSummary(null)
    try {
      const result = await spindleApi.importLocal()
      const importedCount = result.imported.length
      const skippedCount = result.skipped.length
      setImportSummary(
        skippedCount > 0
          ? `Imported ${importedCount}, skipped ${skippedCount}. Check browser console for details.`
          : `Imported ${importedCount} extension${importedCount === 1 ? '' : 's'}.`
      )
      if (skippedCount > 0) console.warn('[Spindle] Local import skipped entries:', result.skipped)
      await loadExtensions()
      setAddMenuOpen(false)
    } catch (err: any) {
      console.error('[Spindle] Local import failed:', err)
      setImportSummary(`Import failed: ${err?.body?.error || err?.message || 'Unknown error'}`)
    } finally {
      setImportingLocal(false)
    }
  }, [loadExtensions])

  const toggleAddMenu = useCallback(() => {
    if (addMenuOpen) {
      setAddMenuOpen(false)
      return
    }
    computeAddMenuPosition()
    setAddMenuOpen(true)
  }, [addMenuOpen, computeAddMenuPosition])

  return (
    <>
    <div className={styles.panel}>
      {/* Add extension menu — only visible to admin/owner */}
      {isPrivileged && (
        <div className={styles.installRow}>
          <div className={styles.addMenuWrap}>
            <button
              ref={addMenuButtonRef}
              className={styles.installBtn}
              onClick={toggleAddMenu}
              aria-expanded={addMenuOpen}
              aria-haspopup="menu"
            >
              <Plus size={13} /> Add Extension <ChevronDown size={13} />
            </button>
          </div>
        </div>
      )}

      {importSummary && <div className={styles.importSummary}>{importSummary}</div>}

      <SpindleUIControlPanel />

      {/* Extensions list */}
      <span className={styles.sectionLabel}>
        Installed ({extensions.length})
      </span>

      {extensions.length === 0 ? (
        <div className={styles.emptyState}>
          No extensions installed yet.
          {isPrivileged && (
            <>
              <br />
              Click <strong>Add Extension</strong> above to get started.
            </>
          )}
        </div>
      ) : (
        <div className={styles.extensionList}>
          {extensions.map((ext) => (
            <div key={ext.id} className={styles.extensionCard}>
              {(() => {
                const installScope = ((ext.metadata as any)?.install_scope || 'operator') as 'operator' | 'user'
                const installedBy = ((ext.metadata as any)?.installed_by_user_id || null) as string | null
                const extBranch = ((ext.metadata as any)?.branch || null) as string | null
                const isNonDefaultBranch = extBranch && extBranch !== 'main' && extBranch !== 'master'
                const canManage = isPrivileged || (installScope === 'user' && !!user?.id && installedBy === user.id)
                const scopeLabel = installScope === 'user' ? 'Personal' : 'Operator'

                return (
                  <>
              <div className={styles.extensionHeader}>
                <div className={styles.extensionInfo}>
                  <div className={styles.extensionName}>
                    <span
                      className={clsx(
                        styles.statusDot,
                        ext.status === 'running' && styles.statusRunning,
                        ext.status === 'error' && styles.statusError,
                        ext.status === 'stopped' && styles.statusStopped
                      )}
                    />{' '}
                    {ext.name}
                  </div>
                  <span className={styles.extensionMeta}>
                    v{ext.version} by {ext.author}
                  </span>
                  <span className={styles.extensionMeta}>
                    {scopeLabel}
                    {isNonDefaultBranch && (
                      <span className={styles.branchBadge}>
                        <IconVersions size={10} /> {extBranch}
                      </span>
                    )}
                  </span>
                </div>

                <div className={styles.extensionActions}>
                  <button
                    className={clsx(
                      styles.toggleBtn,
                      ext.enabled ? styles.toggleOn : styles.toggleOff
                    )}
                    onClick={() => handleToggle(ext)}
                    disabled={loadingAction === ext.id || !canManage}
                    title={canManage ? (ext.enabled ? 'Disable' : 'Enable') : 'Managed by operator'}
                  />
                </div>
              </div>

              {/* Operation status indicator */}
              {extensionOperationStatus?.extensionId === ext.id && extensionOperationStatus.operation.endsWith('ing') && (
                <div className={styles.operationStatus}>
                  <Spinner size={12} fast />
                  {OPERATION_LABELS[extensionOperationStatus.operation] ?? extensionOperationStatus.operation}
                </div>
              )}

              {ext.description && (
                <div className={styles.extensionDesc}>{ext.description}</div>
              )}

              {/* Permissions — union of declared + granted so runtime-requested perms are visible */}
              {(() => {
                const allPerms = [...new Set([...ext.permissions, ...ext.granted_permissions])]
                return allPerms.length > 0 ? (
                  <div className={styles.permissions}>
                    {allPerms.map((perm) => {
                      const granted = ext.granted_permissions.includes(perm)
                      const isToggling = togglingPerm === `${ext.id}:${perm}`
                      const pretty = perm
                        .replaceAll('_', ' ')
                        .replace(/\b\w/g, (ch) => ch.toUpperCase())
                      return (
                        <button
                          key={perm}
                          className={clsx(
                            styles.permPill,
                            granted ? styles.permPillActive : styles.permPillInactive,
                            isToggling && styles.permPillToggling
                          )}
                          onClick={() => handlePermissionToggle(ext, perm)}
                          title={
                            canManage
                              ? `${pretty} (${granted ? 'Enabled' : 'Disabled'})`
                              : 'Managed by operator'
                          }
                          disabled={!canManage || isToggling}
                        >
                          {isToggling && <Spinner size={10} fast />}
                          {pretty}
                        </button>
                      )
                    })}
                  </div>
                ) : null
              })()}

              {/* Actions row */}
              <div className={styles.extensionActions}>
                <Button
                  size="icon" variant="ghost"
                  onClick={() => handleUpdate(ext)}
                  disabled={loadingAction === ext.id || !canManage}
                  title={canManage ? 'Update' : 'Managed by operator'}
                  icon={loadingAction === ext.id && extensionOperationStatus?.operation === 'updating'
                    ? <Spinner size={14} fast />
                    : <RefreshCw size={14} />}
                />
                <Button
                  size="icon" variant="ghost"
                  onClick={() => handleRestart(ext)}
                  disabled={loadingAction === ext.id || !ext.enabled}
                  title={ext.enabled ? 'Restart extension' : 'Extension is not enabled'}
                  icon={loadingAction === ext.id && extensionOperationStatus?.operation === 'restarting'
                    ? <Spinner size={14} fast />
                    : <RotateCw size={14} />}
                />
                {ext.github && (
                  <a
                    className={styles.githubLink}
                    href={ext.github}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="GitHub"
                  >
                    <Github size={14} />
                  </a>
                )}
                {canManage && (
                  <Button
                    size="icon" variant="ghost"
                    className={clsx(branchMenuExtId === ext.id && styles.actionBtnActive)}
                    onClick={() => handleOpenBranchMenu(ext)}
                    disabled={loadingAction === ext.id}
                    title="Switch branch"
                    icon={<IconVersions size={14} />}
                  />
                )}
                <Button
                  size="icon" variant="ghost"
                  onClick={() => openSettings('extensions')}
                  disabled={!ext.has_frontend}
                  title={ext.has_frontend ? 'Open extension settings' : 'No frontend settings available'}
                  icon={<SlidersHorizontal size={14} />}
                />
                <Button
                  size="icon" variant="danger-ghost"
                  onClick={() => handleRemove(ext)}
                  disabled={loadingAction === ext.id || !canManage}
                  title={canManage ? 'Remove' : 'Managed by operator'}
                  icon={<Trash2 size={14} />}
                />
              </div>

              {/* Branch switch dropdown */}
              {branchMenuExtId === ext.id && (
                <div className={styles.branchMenu}>
                  {fetchingExtBranches ? (
                    <span className={styles.branchMenuLoading}>Loading branches...</span>
                  ) : branchMenuBranches.length === 0 ? (
                    <span className={styles.branchMenuLoading}>No remote branches found</span>
                  ) : (
                    branchMenuBranches.map((b) => (
                      <button
                        key={b}
                        className={clsx(
                          styles.branchMenuItem,
                          b === branchMenuCurrent && styles.branchMenuItemCurrent
                        )}
                        onClick={() => b !== branchMenuCurrent && handleSwitchBranch(ext, b)}
                        disabled={b === branchMenuCurrent || loadingAction === ext.id}
                      >
                        <IconVersions size={12} />
                        {b}
                        {b === branchMenuCurrent && <span className={styles.branchCurrentLabel}>current</span>}
                      </button>
                    ))
                  )}
                </div>
              )}
                  </>
                )
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
    {addMenuOpen && isPrivileged && createPortal(
      <div
        ref={addMenuRef}
        className={styles.addMenu}
        role="menu"
        style={{ top: addMenuPos.top, left: addMenuPos.left, width: addMenuPos.width }}
      >
        {isPrivileged && (
          <>
            <button
              className={styles.menuActionBtn}
              onClick={handleImportLocal}
              disabled={importingLocal}
              title="Import local extensions from backend data/extensions"
            >
              <FolderOpen size={13} /> {importingLocal ? 'Importing Local...' : 'Import Local'}
            </button>

            <div className={styles.menuDivider} />
          </>
        )}

        <label className={styles.menuLabel}>Install from Source</label>
        <input
          className={styles.installInput}
          placeholder="GitHub repo URL..."
          value={installUrl}
          onChange={(e) => setInstallUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleInstall()}
          disabled={installing}
        />
        {fetchingBranches && (
          <span className={styles.branchFetchHint}>Detecting branches...</span>
        )}
        {!fetchingBranches && installBranches.length > 1 && (
          <div className={styles.branchSelect}>
            <label className={styles.branchSelectLabel}>
              <IconVersions size={11} /> Branch
            </label>
            <select
              className={styles.branchSelectInput}
              value={installBranch || ''}
              onChange={(e) => setInstallBranch(e.target.value || null)}
              disabled={installing}
            >
              <option value="">Default</option>
              {installBranches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
        )}
        <button
          className={styles.menuActionBtn}
          onClick={handleInstall}
          disabled={installing || !installUrl.trim()}
        >
          <Download size={13} /> {installing ? 'Installing...' : 'Install from Source'}
        </button>
        {installError && (
          <div className={styles.installError}>{installError}</div>
        )}
      </div>,
      document.body
    )}
    </>
  )
}

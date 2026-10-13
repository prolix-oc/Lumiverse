import { useState, useEffect, useCallback, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  Download,
  FolderOpen,
  Github,
  GripVertical,
  LayoutGrid,
  List,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { IconVersions } from '@tabler/icons-react'
import {
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { useStore } from '@/store'
import { spindleApi } from '@/api/spindle'
import type { ExtensionInfo, SpindlePermission } from 'lumiverse-spindle-types'
import SpindleUIControlPanel from '@/components/spindle/SpindleUIControlPanel'
import SpindleSettings from './SpindleSettings'
import { Spinner } from '@/components/shared/Spinner'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { getSafeHttpsUrl } from '@/lib/navigationSafety'
import { DndContext, useScaledSortableStyle } from '@/lib/dndUiScale'
import {
  getExtensionMountPointsVersion,
  hasExtensionMountPoint,
  subscribeExtensionMountPoints,
} from '@/lib/spindle/loader'
import { toast } from '@/lib/toast'
import styles from './SpindlePanel.module.css'
import clsx from 'clsx'
import {
  EXTENSION_SORT_OPTIONS,
  filterExtensions,
  reconcileExtensionOrder,
  sortExtensions,
  type ExtensionSortMode,
} from './spindle-extension-sort'

interface EnableAllPermissionsTarget {
  extensionId: string
  extensionName: string
  permissions: string[]
}

type ExtensionViewMode = 'cards' | 'list'

interface ExtensionPanelPreferences {
  sortMode: ExtensionSortMode
  viewMode: ExtensionViewMode
  manualOrder: string[]
}

const EXTENSION_PANEL_PREFS_KEY = 'lumiverse:spindle:extension-panel-preferences'

const DEFAULT_PANEL_PREFERENCES: ExtensionPanelPreferences = {
  sortMode: 'installed',
  viewMode: 'cards',
  manualOrder: [],
}

const SORT_LABEL_FALLBACKS: Record<ExtensionSortMode, string> = {
  manual: 'Manual',
  installed: 'Recently installed',
  updated: 'Recently updated',
  'name-asc': 'Name A–Z',
  'name-desc': 'Name Z–A',
}

function readPanelPreferences(): ExtensionPanelPreferences {
  if (typeof window === 'undefined') return DEFAULT_PANEL_PREFERENCES
  try {
    const parsed = JSON.parse(window.localStorage.getItem(EXTENSION_PANEL_PREFS_KEY) || '{}') as Partial<ExtensionPanelPreferences>
    const sortMode = EXTENSION_SORT_OPTIONS.some((option) => option.value === parsed.sortMode)
      ? parsed.sortMode as ExtensionSortMode
      : DEFAULT_PANEL_PREFERENCES.sortMode
    const viewMode = parsed.viewMode === 'list' ? 'list' : 'cards'
    const manualOrder = Array.isArray(parsed.manualOrder)
      ? parsed.manualOrder.filter((id): id is string => typeof id === 'string')
      : []
    return { sortMode, viewMode, manualOrder }
  } catch {
    return DEFAULT_PANEL_PREFERENCES
  }
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function SortableExtensionCard({
  id,
  dragEnabled,
  className,
  children,
  dragLabel,
}: {
  id: string
  dragEnabled: boolean
  className: string
  children: ReactNode
  dragLabel: string
}) {
  const { attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !dragEnabled,
  })
  const { setNodeRef, style } = useScaledSortableStyle({
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  })

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(className, dragEnabled && styles.extensionCardManual, isDragging && styles.extensionCardDragging)}
    >
      {dragEnabled && (
        <button
          type="button"
          className={styles.dragHandle}
          aria-label={dragLabel}
          title={dragLabel}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={15} />
        </button>
      )}
      {children}
    </div>
  )
}

export default function SpindlePanel() {
  const { t } = useTranslation('panels')
  const extensions = useStore((s) => s.extensions)
  const loadExtensions = useStore((s) => s.loadExtensions)
  const installExtension = useStore((s) => s.installExtension)
  const updateExtension = useStore((s) => s.updateExtension)
  const removeExtension = useStore((s) => s.removeExtension)
  const enableExtension = useStore((s) => s.enableExtension)
  const disableExtension = useStore((s) => s.disableExtension)
  const restartExtension = useStore((s) => s.restartExtension)
  const grantPermission = useStore((s) => s.grantPermission)
  const grantPermissions = useStore((s) => s.grantPermissions)
  const revokePermission = useStore((s) => s.revokePermission)
  const switchBranch = useStore((s) => s.switchBranch)
  const openSettings = useStore((s) => s.openSettings)
  const user = useStore((s) => s.user)
  const spindlePrivileged = useStore((s) => s.spindlePrivileged)
  const extensionUpdates = useStore((s) => s.extensionUpdates)
  const spindleSettings = useStore((s) => s.spindleSettings)
  const setSetting = useStore((s) => s.setSetting)

  const extensionOperationStatus = useStore((s) => s.extensionOperationStatus)
  const setOperationStatus = useStore((s) => s.setExtensionOperationStatus)
  const bulkUpdateStatus = useStore((s) => s.bulkUpdateStatus)
  const updateAllExtensions = useStore((s) => s.updateAllExtensions)
  useSyncExternalStore(
    subscribeExtensionMountPoints,
    getExtensionMountPointsVersion,
    getExtensionMountPointsVersion,
  )

  const isPrivileged = spindlePrivileged || user?.role === 'owner' || user?.role === 'admin'

  // `mount()` registration happens asynchronously while frontend extensions
  // hydrate. `useSyncExternalStore` re-renders this component when it changes,
  // so derive the set during rendering rather than using a memo solely as a
  // version-change trigger.
  const extensionsWithRegisteredSettings = new Set(
    extensions
      .filter((ext) => hasExtensionMountPoint(ext.id, 'settings_extensions'))
      .map((ext) => ext.id)
  )

  const [togglingPerm, setTogglingPerm] = useState<string | null>(null)
  const [installUrl, setInstallUrl] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [loadingAction, setLoadingAction] = useState<string | null>(null)

  const [importingLocal, setImportingLocal] = useState(false)
  const [importSummary, setImportSummary] = useState<string | null>(null)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [confirmUpdateAllOpen, setConfirmUpdateAllOpen] = useState(false)
  const [enableAllPermissionsTarget, setEnableAllPermissionsTarget] = useState<EnableAllPermissionsTarget | null>(null)
  const [bulkPermissionExtensionId, setBulkPermissionExtensionId] = useState<string | null>(null)
  const [extensionSearch, setExtensionSearch] = useState('')
  const [extensionSortMode, setExtensionSortMode] = useState<ExtensionSortMode>(() => readPanelPreferences().sortMode)
  const [extensionViewMode, setExtensionViewMode] = useState<ExtensionViewMode>(() => readPanelPreferences().viewMode)
  const [manualExtensionOrder, setManualExtensionOrder] = useState<string[]>(() => readPanelPreferences().manualOrder)
  const [expandedListRows, setExpandedListRows] = useState<Set<string>>(() => new Set())
  const [expandedPermissionRows, setExpandedPermissionRows] = useState<Set<string>>(() => new Set())

  const extensionDragSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

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

  /** True when any operation (local or WS-driven) is in progress for this extension */
  const isExtBusy = useCallback((id: string) =>
    loadingAction === id ||
    (extensionOperationStatus?.extensionId === id && extensionOperationStatus.operation.endsWith('ing')),
    [loadingAction, extensionOperationStatus]
  )

  // Extensions are also loaded on auth and resynced on WS events
  // (see `useWebSocket.ts`), so if the store is already populated we skip
  // the redundant mount-time fetch — the list is kept fresh by the WS layer.
  useEffect(() => {
    if (useStore.getState().extensions.length > 0) return
    loadExtensions()
  }, [loadExtensions])

  useEffect(() => {
    if (extensions.length === 0) return
    setManualExtensionOrder((current) => {
      const reconciled = reconcileExtensionOrder(extensions, current)
      return sameStringArray(current, reconciled) ? current : reconciled
    })
  }, [extensions])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const preferences: ExtensionPanelPreferences = {
      sortMode: extensionSortMode,
      viewMode: extensionViewMode,
      manualOrder: manualExtensionOrder,
    }
    window.localStorage.setItem(EXTENSION_PANEL_PREFS_KEY, JSON.stringify(preferences))
  }, [extensionSortMode, extensionViewMode, manualExtensionOrder])

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
      const message = err?.body?.error || err?.message || t('spindlePanel.installationFailed')
      setInstallError(message)
      console.error('[Spindle] Install failed:', err)
    } finally {
      setInstalling(false)
    }
  }, [installUrl, installBranch, installExtension, t])

  const handleToggle = useCallback(async (ext: ExtensionInfo) => {
    setLoadingAction(ext.id)
    try {
      if (ext.enabled) {
        await disableExtension(ext.id)
      } else {
        const firstRun = (ext.metadata as any)?.illarin?.permissionsApproved === false
        if (firstRun && !window.confirm(t('spindlePanel.illarinFirstRunApproval', {
          name: ext.name,
          permissions: ext.permissions.length ? ext.permissions.join(', ') : t('spindlePanel.illarinNoPermissions'),
        }))) return
        await enableExtension(ext.id, firstRun ? ext.permissions : undefined)
      }
    } catch (err: any) {
      console.error('[Spindle] Toggle failed:', err)
    } finally {
      setLoadingAction(null)
    }
  }, [enableExtension, disableExtension, t])

  const handleUpdate = useCallback(async (ext: ExtensionInfo) => {
    // Set status optimistically — don't wait for the WS round-trip from the
    // backend, which may be blocked by heavy git/npm work on the event loop.
    setOperationStatus(ext.id, 'updating', ext.name)
    try {
      await updateExtension(ext.id)
      setOperationStatus(ext.id, 'updated', ext.name)
    } catch (err: any) {
      console.error('[Spindle] Update failed:', err)
      setOperationStatus(ext.id, 'failed', ext.name)
    }
  }, [updateExtension, setOperationStatus])

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

  const handleEnableAllPermissions = useCallback((ext: ExtensionInfo, permissions: string[]) => {
    if (permissions.length === 0) return
    setEnableAllPermissionsTarget({
      extensionId: ext.id,
      extensionName: ext.name,
      permissions,
    })
  }, [])

  const handleConfirmEnableAllPermissions = useCallback(async () => {
    if (!enableAllPermissionsTarget) return

    setBulkPermissionExtensionId(enableAllPermissionsTarget.extensionId)
    try {
      await grantPermissions(enableAllPermissionsTarget.extensionId, enableAllPermissionsTarget.permissions)
      setEnableAllPermissionsTarget(null)
    } catch (err: any) {
      const msg = err?.body?.error || err?.message || t('spindlePanel.enableAllPermissionsFailed')
      toast.error(msg, { title: t('spindlePanel.enableAllPermissions') })
    } finally {
      setBulkPermissionExtensionId(null)
    }
  }, [enableAllPermissionsTarget, grantPermissions, t])

  // Extensions the current user is allowed to update. Matches the backend's
  // canManageExtension rule: owner/admin can update everything, regular users
  // can only update their own user-scoped installs.
  const manageableExtensions = extensions.filter((ext) => {
    const meta = (ext.metadata as any) || {}
    const scope = (meta.install_scope || 'operator') as 'operator' | 'user'
    const installedBy = (meta.installed_by_user_id || null) as string | null
    return isPrivileged || (scope === 'user' && !!user?.id && installedBy === user.id)
  })
  const manageableCount = manageableExtensions.length
  const filteredExtensions = useMemo(
    () => filterExtensions(extensions, extensionSearch),
    [extensions, extensionSearch],
  )
  const sortedExtensions = useMemo(
    () => sortExtensions(filteredExtensions, extensionSortMode, manualExtensionOrder),
    [filteredExtensions, extensionSortMode, manualExtensionOrder],
  )
  const extensionSortOptions = EXTENSION_SORT_OPTIONS.map((option) => ({
    value: option.value,
    label: t(`spindlePanel.sort.${option.labelKey}`, { defaultValue: SORT_LABEL_FALLBACKS[option.value] }),
  }))
  const extensionUpdatesById = useMemo(
    () => new Map(extensionUpdates.map((update) => [update.extensionId, update])),
    [extensionUpdates],
  )

  const bulkUpdating = !!bulkUpdateStatus && !bulkUpdateStatus.done
  const bulkProcessed = bulkUpdateStatus
    ? bulkUpdateStatus.completed + bulkUpdateStatus.failed
    : 0
  // While an extension is actively being updated, show its 1-indexed
  // position (e.g. "1/3" when the first is in flight) rather than the
  // count-of-finished (which would start at 0). Once everything is done,
  // fall back to the finished count.
  const bulkDisplayIndex = bulkUpdateStatus?.currentName
    ? Math.min(bulkProcessed + 1, bulkUpdateStatus.total)
    : bulkProcessed

  const handleUpdateAll = useCallback(() => {
    if (manageableCount === 0) return
    setConfirmUpdateAllOpen(true)
  }, [manageableCount])

  const handleConfirmUpdateAll = useCallback(async () => {
    setConfirmUpdateAllOpen(false)
    try {
      await updateAllExtensions()
    } catch (err: any) {
      const msg = err?.body?.error || err?.message || t('spindlePanel.bulkUpdateFailed')
      toast.error(msg, { title: t('spindlePanel.updateAll') })
    }
  }, [updateAllExtensions, t])

  const handleUpdateToastToggle = useCallback((identifier: string) => {
    const disabled = { ...spindleSettings.extensionUpdateToastDisabled }
    if (disabled[identifier] === true) {
      delete disabled[identifier]
    } else {
      disabled[identifier] = true
    }
    setSetting('spindleSettings', {
      ...spindleSettings,
      extensionUpdateToastDisabled: disabled,
    })
  }, [setSetting, spindleSettings])

  const handleImportLocal = useCallback(async () => {
    setImportingLocal(true)
    setImportSummary(null)
    try {
      const result = await spindleApi.importLocal()
      const importedCount = result.imported.length
      const skippedCount = result.skipped.length
      setImportSummary(
        skippedCount > 0
          ? t('spindlePanel.importSummaryWithSkipped', { imported: importedCount, skipped: skippedCount })
          : t('spindlePanel.importSummary', { count: importedCount })
      )
      if (skippedCount > 0) console.warn('[Spindle] Local import skipped entries:', result.skipped)
      await loadExtensions()
      setAddMenuOpen(false)
    } catch (err: any) {
      console.error('[Spindle] Local import failed:', err)
      setImportSummary(t('spindlePanel.importFailed', { error: err?.body?.error || err?.message || t('spindlePanel.unknownError') }))
    } finally {
      setImportingLocal(false)
    }
  }, [loadExtensions, t])

  const toggleAddMenu = useCallback(() => {
    if (addMenuOpen) {
      setAddMenuOpen(false)
      return
    }
    computeAddMenuPosition()
    setAddMenuOpen(true)
  }, [addMenuOpen, computeAddMenuPosition])

  const toggleListRow = useCallback((extensionId: string) => {
    setExpandedListRows((current) => {
      const next = new Set(current)
      if (next.has(extensionId)) next.delete(extensionId)
      else next.add(extensionId)
      return next
    })
  }, [])

  const togglePermissionDetails = useCallback((extensionId: string) => {
    setExpandedPermissionRows((current) => {
      const next = new Set(current)
      if (next.has(extensionId)) next.delete(extensionId)
      else next.add(extensionId)
      return next
    })
  }, [])

  const handleExtensionDragEnd = useCallback((event: DragEndEvent) => {
    if (extensionSortMode !== 'manual' || extensionSearch.trim()) return
    const { active, over } = event
    if (!over || active.id === over.id) return

    const reconciled = reconcileExtensionOrder(extensions, manualExtensionOrder)
    const oldIndex = reconciled.indexOf(String(active.id))
    const newIndex = reconciled.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return
    setManualExtensionOrder(arrayMove(reconciled, oldIndex, newIndex))
  }, [extensionSortMode, extensionSearch, extensions, manualExtensionOrder])

  const canDragExtensions = extensionSortMode === 'manual' && !extensionSearch.trim()

  return (
    <>
    <div className={styles.panel}>
      <div className={styles.managementToolbar}>
        <div className={styles.toolbarPrimaryRow}>
          <div className={styles.searchField}>
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={extensionSearch}
              onChange={(event) => setExtensionSearch(event.target.value)}
              placeholder={t('spindlePanel.searchPlaceholder', { defaultValue: 'Search extensions…' })}
              aria-label={t('spindlePanel.searchAria', { defaultValue: 'Search installed extensions' })}
            />
            {extensionSearch && (
              <button
                type="button"
                className={styles.searchClearBtn}
                onClick={() => setExtensionSearch('')}
                aria-label={t('spindlePanel.clearSearch', { defaultValue: 'Clear extension search' })}
                title={t('spindlePanel.clearSearch', { defaultValue: 'Clear extension search' })}
              >
                <X size={13} />
              </button>
            )}
          </div>

          {isPrivileged && (
            <div className={styles.addMenuWrap}>
              <button
                ref={addMenuButtonRef}
                className={styles.installBtn}
                onClick={toggleAddMenu}
                aria-expanded={addMenuOpen}
                aria-haspopup="menu"
              >
                <Plus size={13} /> {t('spindlePanel.addExtension')} <ChevronDown size={13} />
              </button>
            </div>
          )}
        </div>

        <div className={styles.toolbarActions}>
          <div
            className={styles.viewToggle}
            role="group"
            aria-label={t('spindlePanel.viewMode', { defaultValue: 'Extension view' })}
          >
            <button
              type="button"
              className={clsx(styles.viewToggleBtn, extensionViewMode === 'cards' && styles.viewToggleBtnActive)}
              onClick={() => setExtensionViewMode('cards')}
              aria-pressed={extensionViewMode === 'cards'}
              title={t('spindlePanel.cardView', { defaultValue: 'Card view' })}
            >
              <LayoutGrid size={13} />
              <span>{t('spindlePanel.cards', { defaultValue: 'Cards' })}</span>
            </button>
            <button
              type="button"
              className={clsx(styles.viewToggleBtn, extensionViewMode === 'list' && styles.viewToggleBtnActive)}
              onClick={() => setExtensionViewMode('list')}
              aria-pressed={extensionViewMode === 'list'}
              title={t('spindlePanel.listView', { defaultValue: 'List view' })}
            >
              <List size={13} />
              <span>{t('spindlePanel.list', { defaultValue: 'List' })}</span>
            </button>
          </div>

          <label className={styles.sortField}>
            <span>{t('spindlePanel.sortLabel', { defaultValue: 'Sort' })}</span>
            <select
              value={extensionSortMode}
              onChange={(event) => setExtensionSortMode(event.target.value as ExtensionSortMode)}
              aria-label={t('spindlePanel.sortLabel', { defaultValue: 'Sort extensions' })}
            >
              {extensionSortOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>

        </div>
      </div>

      {importSummary && <div className={styles.importSummary}>{importSummary}</div>}

      <SpindleSettings />

      <SpindleUIControlPanel />

      <div className={styles.listHeaderRow}>
        <span className={styles.sectionLabel}>
          {t('spindlePanel.installed', { count: extensions.length })}
        </span>
        <div className={styles.listHeaderActions}>
          <div className={styles.listHeaderMeta}>
            {extensionSearch.trim() && (
              <span>
                {t('spindlePanel.searchResults', {
                  count: sortedExtensions.length,
                  defaultValue: `${sortedExtensions.length} matching`,
                })}
              </span>
            )}
            {extensionSortMode === 'manual' && (
              <span>
                {extensionSearch.trim()
                  ? t('spindlePanel.clearSearchToReorder', { defaultValue: 'Clear search to reorder' })
                  : t('spindlePanel.dragToReorderHint', { defaultValue: 'Drag to reorder' })}
              </span>
            )}
          </div>
          {manageableCount > 0 && (
            <button
              type="button"
              className={styles.updateAllBtn}
              onClick={handleUpdateAll}
              disabled={bulkUpdating}
              title={bulkUpdating ? t('spindlePanel.bulkUpdateInProgress') : t('spindlePanel.updateAllHint')}
            >
              {bulkUpdating ? (
                <>
                  <Spinner size={12} fast />
                  {t('spindlePanel.updatingProgress', {
                    current: bulkDisplayIndex,
                    total: bulkUpdateStatus?.total ?? manageableCount,
                    name: bulkUpdateStatus?.currentName ? `: ${bulkUpdateStatus.currentName}` : '',
                  })}
                </>
              ) : (
                <>
                  <RefreshCw size={12} />
                  {t('spindlePanel.updateAll')}
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {extensions.length === 0 ? (
        <div className={styles.emptyState}>
          {t('spindlePanel.noExtensions')}
          {isPrivileged && (
            <>
              <br />
              {t('spindlePanel.emptyHint')}
            </>
          )}
        </div>
      ) : sortedExtensions.length === 0 ? (
        <div className={styles.emptyState}>
          {t('spindlePanel.noSearchResults', { defaultValue: 'No installed extensions match this search.' })}
        </div>
      ) : (
        <DndContext
          sensors={extensionDragSensors}
          collisionDetection={closestCenter}
          onDragEnd={handleExtensionDragEnd}
        >
          <SortableContext
            items={sortedExtensions.map((extension) => extension.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className={styles.extensionList}>
              {sortedExtensions.map((ext) => {
                const installScope = ((ext.metadata as any)?.install_scope || 'operator') as 'operator' | 'user'
                const installedBy = ((ext.metadata as any)?.installed_by_user_id || null) as string | null
                const extBranch = ((ext.metadata as any)?.branch || null) as string | null
                const isNonDefaultBranch = extBranch && extBranch !== 'main' && extBranch !== 'master'
                const canManage = isPrivileged || (installScope === 'user' && !!user?.id && installedBy === user.id)
                const scopeLabel = installScope === 'user' ? t('spindlePanel.personal') : t('spindlePanel.operator')
                const hasUpdate = extensionUpdatesById.has(ext.id)
                const updateToastsEnabled = spindleSettings.extensionUpdateToastDisabled[ext.identifier] !== true
                const updateAlertLabel = updateToastsEnabled
                  ? t('spindlePanel.updateAlertsToastAndBadge')
                  : t('spindlePanel.updateAlertsBadgeOnly')
                const isExpanded = extensionViewMode === 'cards' || expandedListRows.has(ext.id)
                const allPerms = [...new Set([...ext.permissions, ...ext.granted_permissions])]
                const disabledPerms = allPerms.filter((perm) => !ext.granted_permissions.includes(perm))
                const grantedPermissionCount = allPerms.length - disabledPerms.length
                const isBulkPermissionBusy = bulkPermissionExtensionId === ext.id
                const isPermissionBusy = isBulkPermissionBusy || togglingPerm?.startsWith(`${ext.id}:`) === true
                const permissionsExpanded = expandedPermissionRows.has(ext.id)

                return (
                  <SortableExtensionCard
                    key={ext.id}
                    id={ext.id}
                    dragEnabled={canDragExtensions}
                    className={clsx(
                      styles.extensionCard,
                      extensionViewMode === 'list' && styles.extensionCardList,
                      extensionViewMode === 'list' && isExpanded && styles.extensionCardListExpanded,
                    )}
                    dragLabel={t('spindlePanel.dragToReorder', { name: ext.name, defaultValue: `Drag ${ext.name} to reorder` })}
                  >
                    <div className={styles.extensionHeader}>
                      {extensionViewMode === 'list' && (
                        <button
                          type="button"
                          className={styles.expandRowBtn}
                          onClick={() => toggleListRow(ext.id)}
                          aria-expanded={isExpanded}
                          aria-label={isExpanded
                            ? t('spindlePanel.collapseExtension', { name: ext.name, defaultValue: `Collapse ${ext.name}` })
                            : t('spindlePanel.expandExtension', { name: ext.name, defaultValue: `Expand ${ext.name}` })}
                          title={isExpanded
                            ? t('spindlePanel.collapse', { defaultValue: 'Collapse' })
                            : t('spindlePanel.expand', { defaultValue: 'Expand' })}
                        >
                          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </button>
                      )}

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
                          {t('spindlePanel.extensionVersionBy', { version: ext.version, author: ext.author })}
                        </span>
                        <span className={styles.extensionMeta}>
                          {scopeLabel}
                          {isNonDefaultBranch && (
                            <span className={styles.branchBadge}>
                              <IconVersions size={10} /> {extBranch}
                            </span>
                          )}
                        </span>
                        {((ext.metadata as any)?.illarin?.takenDownAt || (ext.metadata as any)?.illarin?.withheldAt) && (
                          <span className={styles.extensionMeta}>{t('spindlePanel.illarinWithheld')}</span>
                        )}
                        {extensionViewMode === 'list' && allPerms.length > 0 && (
                          <span className={styles.extensionMeta}>
                            {t('spindlePanel.permissionsCompact', {
                              granted: grantedPermissionCount,
                              total: allPerms.length,
                              defaultValue: `${grantedPermissionCount}/${allPerms.length} permissions`,
                            })}
                          </span>
                        )}
                      </div>

                      <div className={styles.extensionActions}>
                        {canManage && (
                          <button
                            type="button"
                            className={clsx(
                              styles.updateNotificationBtn,
                              updateToastsEnabled && styles.updateNotificationBtnActive,
                            )}
                            onClick={() => handleUpdateToastToggle(ext.identifier)}
                            aria-pressed={updateToastsEnabled}
                            aria-label={updateAlertLabel}
                            title={updateAlertLabel}
                          >
                            {updateToastsEnabled ? <Bell size={13} /> : <BellOff size={13} />}
                          </button>
                        )}
                        <button
                          className={clsx(
                            styles.toggleBtn,
                            ext.enabled ? styles.toggleOn : styles.toggleOff
                          )}
                          onClick={() => handleToggle(ext)}
                          disabled={isExtBusy(ext.id) || !canManage}
                          title={canManage ? (ext.enabled ? t('spindlePanel.disable') : t('spindlePanel.enable')) : t('spindlePanel.managedByOperator')}
                        />
                      </div>
                    </div>

                    {isExpanded && (
                      <>
                        {extensionOperationStatus?.extensionId === ext.id && extensionOperationStatus.operation.endsWith('ing') && (
                          <div className={styles.operationStatus}>
                            <Spinner size={12} fast />
                            {t(`spindlePanel.operations.${extensionOperationStatus.operation}`, { defaultValue: extensionOperationStatus.operation })}
                          </div>
                        )}

                        {ext.description && (
                          <div className={styles.extensionDesc}>{ext.description}</div>
                        )}

                        {allPerms.length > 0 && (
                          <div className={styles.permissionsBlock}>
                            <div className={styles.permissionsHeader}>
                              <div className={styles.permissionsSummary}>
                                <span className={styles.permissionsLabel}>{t('spindlePanel.permissionsLabel')}</span>
                                <span className={clsx(
                                  styles.permissionsCount,
                                  disabledPerms.length > 0 && styles.permissionsCountIncomplete,
                                )}>
                                  {t('spindlePanel.permissionsGrantedSummary', {
                                    granted: grantedPermissionCount,
                                    total: allPerms.length,
                                    defaultValue: `${grantedPermissionCount} / ${allPerms.length} enabled`,
                                  })}
                                </span>
                              </div>
                              <div className={styles.permissionHeaderActions}>
                                {disabledPerms.length > 0 && (
                                  <button
                                    type="button"
                                    className={clsx(
                                      styles.enableAllBtn,
                                      grantedPermissionCount === 0 && styles.enableAllBtnProminent,
                                    )}
                                    onClick={() => handleEnableAllPermissions(ext, disabledPerms)}
                                    disabled={!canManage || isPermissionBusy}
                                    title={!canManage
                                      ? t('spindlePanel.managedByOperator')
                                      : t('spindlePanel.enableAllPermissionsHint')}
                                  >
                                    {isBulkPermissionBusy && <Spinner size={12} fast />}
                                    {isBulkPermissionBusy ? t('spindlePanel.enablingAllPermissions') : t('spindlePanel.enableAllPermissions')}
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className={styles.permissionReviewBtn}
                                  onClick={() => togglePermissionDetails(ext.id)}
                                  aria-expanded={permissionsExpanded}
                                >
                                  {permissionsExpanded
                                    ? t('spindlePanel.hidePermissions', { defaultValue: 'Hide' })
                                    : t('spindlePanel.reviewPermissions', { defaultValue: 'Review' })}
                                  {permissionsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                </button>
                              </div>
                            </div>
                            {permissionsExpanded && (
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
                                        (isToggling || isBulkPermissionBusy) && styles.permPillToggling
                                      )}
                                      onClick={() => handlePermissionToggle(ext, perm)}
                                      title={canManage
                                        ? t('spindlePanel.permissionStatus', { name: pretty, status: granted ? t('spindlePanel.enabled') : t('spindlePanel.disabled') })
                                        : t('spindlePanel.managedByOperator')}
                                      disabled={!canManage || isToggling || isBulkPermissionBusy}
                                    >
                                      {isToggling && <Spinner size={10} fast />}
                                      {pretty}
                                    </button>
                                  )
                                })}
                              </div>
                            )}
                          </div>
                        )}

                        <div className={styles.actionRow}>
                          <div className={styles.primaryActions}>
                            <button
                              type="button"
                              className={clsx(
                                styles.labeledBtn,
                                hasUpdate && styles.updateAvailableBtn,
                              )}
                              onClick={() => handleUpdate(ext)}
                              disabled={isExtBusy(ext.id) || !canManage}
                              title={canManage
                                ? (hasUpdate ? t('spindlePanel.updateAvailableHint') : t('spindlePanel.updateHint'))
                                : t('spindlePanel.managedByOperator')}
                            >
                              {extensionOperationStatus?.extensionId === ext.id && extensionOperationStatus.operation === 'updating'
                                ? <Spinner size={14} fast />
                                : (
                                  <span className={styles.updateIconWrap}>
                                    <RefreshCw size={14} />
                                    {hasUpdate && <span className={styles.updateDot} aria-hidden="true" />}
                                  </span>
                                )}
                              <span>{t('spindlePanel.update')}</span>
                            </button>
                            <button
                              type="button"
                              className={styles.labeledBtn}
                              onClick={() => handleRestart(ext)}
                              disabled={isExtBusy(ext.id) || !ext.enabled}
                              title={ext.enabled ? t('spindlePanel.restartHint') : t('spindlePanel.notEnabled')}
                            >
                              {extensionOperationStatus?.extensionId === ext.id && extensionOperationStatus.operation === 'restarting'
                                ? <Spinner size={14} fast />
                                : <RotateCw size={14} />}
                              <span>{t('spindlePanel.restart')}</span>
                            </button>
                            {canManage && (
                              <button
                                type="button"
                                className={clsx(
                                  styles.labeledBtn,
                                  branchMenuExtId === ext.id && styles.labeledBtnActive,
                                )}
                                onClick={() => handleOpenBranchMenu(ext)}
                                disabled={isExtBusy(ext.id)}
                                title={t('spindlePanel.switchBranch')}
                              >
                                <IconVersions size={14} />
                                <span>{t('spindlePanel.branch')}</span>
                              </button>
                            )}
                            {extensionsWithRegisteredSettings.has(ext.id) && (
                              <button
                                type="button"
                                className={styles.labeledBtn}
                                onClick={() => openSettings('extensions', { extensionId: ext.id })}
                                title={t('spindlePanel.openSettings')}
                              >
                                <SlidersHorizontal size={14} />
                                <span>{t('spindlePanel.settingsLabel')}</span>
                              </button>
                            )}
                          </div>
                          <div className={styles.secondaryActions}>
                            {getSafeHttpsUrl(ext.github) && (
                              <a
                                className={styles.iconBtnSmall}
                                href={getSafeHttpsUrl(ext.github)!}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={t('spindlePanel.viewOnGitHub')}
                                aria-label={t('spindlePanel.viewOnGitHub')}
                              >
                                <Github size={13} />
                              </a>
                            )}
                            <button
                              type="button"
                              className={clsx(styles.iconBtnSmall, styles.iconBtnDanger)}
                              onClick={() => handleRemove(ext)}
                              disabled={isExtBusy(ext.id) || !canManage}
                              title={canManage ? t('spindlePanel.removeExtension') : t('spindlePanel.managedByOperator')}
                              aria-label={t('spindlePanel.removeExtension')}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>

                        {branchMenuExtId === ext.id && (
                          <div className={styles.branchMenu}>
                            {fetchingExtBranches ? (
                              <span className={styles.branchMenuLoading}>{t('spindlePanel.loadingBranches')}</span>
                            ) : branchMenuBranches.length === 0 ? (
                              <span className={styles.branchMenuLoading}>{t('spindlePanel.noBranches')}</span>
                            ) : (
                              branchMenuBranches.map((branch) => (
                                <button
                                  key={branch}
                                  className={clsx(
                                    styles.branchMenuItem,
                                    branch === branchMenuCurrent && styles.branchMenuItemCurrent
                                  )}
                                  onClick={() => branch !== branchMenuCurrent && handleSwitchBranch(ext, branch)}
                                  disabled={branch === branchMenuCurrent || isExtBusy(ext.id)}
                                >
                                  <IconVersions size={12} />
                                  {branch}
                                  {branch === branchMenuCurrent && (
                                    <span className={styles.branchCurrentLabel}>{t('spindlePanel.current')}</span>
                                  )}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </SortableExtensionCard>
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
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
              title={t('spindlePanel.importLocalHint')}
            >
              <FolderOpen size={13} /> {importingLocal ? t('spindlePanel.importingLocal') : t('spindlePanel.importLocal')}
            </button>

            <div className={styles.menuDivider} />
          </>
        )}

        <label className={styles.menuLabel}>{t('spindlePanel.installFromSource')}</label>
        <input
          className={styles.installInput}
          placeholder={t('spindlePanel.repoUrlPlaceholder')}
          value={installUrl}
          onChange={(e) => setInstallUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleInstall()}
          disabled={installing}
        />
        {fetchingBranches && (
          <span className={styles.branchFetchHint}>{t('spindlePanel.detectingBranches')}</span>
        )}
        {!fetchingBranches && installBranches.length > 1 && (
          <div className={styles.branchSelect}>
            <label className={styles.branchSelectLabel}>
              <IconVersions size={11} /> {t('spindlePanel.branch')}
            </label>
            <select
              className={styles.branchSelectInput}
              value={installBranch || ''}
              onChange={(e) => setInstallBranch(e.target.value || null)}
              disabled={installing}
            >
              <option value="">{t('spindlePanel.defaultBranch')}</option>
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
          <Download size={13} /> {installing ? t('spindlePanel.installing') : t('spindlePanel.installFromSource')}
        </button>
        {installError && (
          <div className={styles.installError}>{installError}</div>
        )}
      </div>,
      document.body
    )}
    <ConfirmationModal
      isOpen={confirmUpdateAllOpen}
      onConfirm={handleConfirmUpdateAll}
      onCancel={() => setConfirmUpdateAllOpen(false)}
      title={t('spindlePanel.updateAllConfirmTitle', { count: manageableCount })}
      message={t('spindlePanel.updateAllConfirmMessage')}
      variant="safe"
      confirmText={t('spindlePanel.updateAll')}
    />
    <ConfirmationModal
      isOpen={enableAllPermissionsTarget !== null}
      onConfirm={() => { void handleConfirmEnableAllPermissions() }}
      onCancel={() => setEnableAllPermissionsTarget(null)}
      title={t('spindlePanel.enableAllPermissionsConfirmTitle', {
        name: enableAllPermissionsTarget?.extensionName ?? '',
      })}
      message={t('spindlePanel.enableAllPermissionsConfirmMessage', {
        count: enableAllPermissionsTarget?.permissions.length ?? 0,
      })}
      variant="warning"
      confirmText={t('spindlePanel.enableAllPermissions')}
      loading={bulkPermissionExtensionId === enableAllPermissionsTarget?.extensionId}
      loadingText={t('spindlePanel.enablingAllPermissions')}
    />
    </>
  )
}

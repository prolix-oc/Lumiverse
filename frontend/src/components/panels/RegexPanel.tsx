import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'

import { Plus, Upload, Download, Trash2, Globe, User, MessageCircle, ChevronRight, FolderPlus, Check, X, Link, Unlink, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import { useFolders } from '@/hooks/useFolders'
import FolderDropdown from '@/components/shared/FolderDropdown'
import { Toggle } from '@/components/shared/Toggle'
import { Badge } from '@/components/shared/Badge'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { RegexScript, RegexScope, RegexPerformanceMetadata } from '@/types/regex'
import styles from './RegexPanel.module.css'
import clsx from 'clsx'

type ScopeFilterValue = 'all' | 'global' | 'character' | 'chat'

const SCOPE_FILTER_LABEL_KEYS: Record<ScopeFilterValue, string> = {
  all: 'regexPanel.scopeAll',
  global: 'regexPanel.scopeGlobal',
  character: 'regexPanel.scopeThisChar',
  chat: 'regexPanel.scopeThisChat',
}

/** Insert text at cursor position in a textarea, returning new value */
function insertAtCursor(el: HTMLTextAreaElement | null, token: string): string {
  if (!el) return token
  const start = el.selectionStart
  const end = el.selectionEnd
  const val = el.value
  const newVal = val.slice(0, start) + token + val.slice(end)
  // Restore focus + cursor after React re-render
  requestAnimationFrame(() => {
    el.focus()
    el.selectionStart = el.selectionEnd = start + token.length
  })
  return newVal
}

const REPLACE_TOKEN_KEYS = [
  { label: '$&', value: '$&', hintKey: 'regexPanel.tokenHintFullMatch' },
  { label: '$1', value: '$1', hintKey: 'regexPanel.tokenHintGroup1' },
  { label: '$2', value: '$2', hintKey: 'regexPanel.tokenHintGroup2' },
  { label: '""', value: '', hintKey: 'regexPanel.tokenHintDelete' },
] as const

const REPLACE_HTML = [
  { label: '<b>', value: '<b>$1</b>' },
  { label: '<i>', value: '<i>$1</i>' },
  { label: '<span>', value: '<span class="">$1</span>' },
  { label: '<mark>', value: '<mark>$1</mark>' },
  { label: '<del>', value: '<del>$1</del>' },
] as const

function getRegexPerformanceMetadata(script: RegexScript): RegexPerformanceMetadata | null {
  const raw = script.metadata?.regex_performance
  if (!raw || typeof raw !== 'object') return null
  if (raw.slow !== true || typeof raw.version !== 'number') return null
  return raw as RegexPerformanceMetadata
}

export default function RegexPanel() {
  const { t } = useTranslation('panels')
  const { t: tc } = useTranslation('common')

  const regexScripts = useStore((s) => s.regexScripts)
  const loadRegexScripts = useStore((s) => s.loadRegexScripts)
  const addRegexScript = useStore((s) => s.addRegexScript)
  const updateRegexScript = useStore((s) => s.updateRegexScript)
  const removeRegexScript = useStore((s) => s.removeRegexScript)
  const bulkRemoveRegexScripts = useStore((s) => s.bulkRemoveRegexScripts)
  const toggleRegexScript = useStore((s) => s.toggleRegexScript)
  const openModal = useStore((s) => s.openModal)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)

  const [scopeFilter, setScopeFilter] = useState<ScopeFilterValue>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [showCreatePopover, setShowCreatePopover] = useState(false)
  const [creatingFolderName, setCreatingFolderName] = useState('')
  const [creatingFolderMode, setCreatingFolderMode] = useState(false)
  const [deleteScriptTarget, setDeleteScriptTarget] = useState<RegexScript | null>(null)
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<{ scripts: RegexScript[]; folder: string } | null>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const { folders, createFolder } = useFolders('regexScriptFolders', regexScripts)

  useEffect(() => {
    loadRegexScripts()
  }, [loadRegexScripts])

  // Close create popover on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowCreatePopover(false)
        setCreatingFolderMode(false)
        setCreatingFolderName('')
      }
    }
    if (showCreatePopover) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [showCreatePopover])

  useEffect(() => {
    if (creatingFolderMode && folderInputRef.current) {
      folderInputRef.current.focus()
    }
  }, [creatingFolderMode])

  const filteredScripts = regexScripts.filter((s) => {
    if (scopeFilter === 'all') return true
    if (scopeFilter === 'global') return s.scope === 'global'
    if (scopeFilter === 'character') return s.scope === 'character' && s.scope_id === activeCharacterId
    if (scopeFilter === 'chat') return s.scope === 'chat' && s.scope_id === activeChatId
    return true
  })

  const hasAnyFolders = folders.length > 0 || filteredScripts.some((s) => s.folder)

  const groupedScripts = useMemo(() => {
    if (!hasAnyFolders) return null
    const groups: Array<{ folder: string; scripts: RegexScript[] }> = []
    const folderMap = new Map<string, RegexScript[]>()
    for (const s of filteredScripts) {
      const key = s.folder || ''
      if (!folderMap.has(key)) {
        folderMap.set(key, [])
        groups.push({ folder: key, scripts: folderMap.get(key)! })
      }
      folderMap.get(key)!.push(s)
    }
    // Sort: uncategorized first, then alphabetically
    groups.sort((a, b) => {
      if (!a.folder) return -1
      if (!b.folder) return 1
      return a.folder.localeCompare(b.folder)
    })
    return groups
  }, [filteredScripts, hasAnyFolders])

  const toggleFolder = useCallback((folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
  }, [])

  const handleAdd = useCallback(async (folder?: string) => {
    try {
      const script = await addRegexScript({
        name: t('regexPanel.newScript'),
        find_regex: '',
        flags: 'gi',
        folder: folder || '',
      })
      setExpandedId(script.id)
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('regexPanel.requestFailed'))
    }
  }, [addRegexScript])

  const handleCreateFolder = useCallback(() => {
    const trimmed = creatingFolderName.trim()
    if (!trimmed) return
    createFolder(trimmed)
    setCreatingFolderMode(false)
    setCreatingFolderName('')
    setShowCreatePopover(false)
  }, [creatingFolderName, createFolder])

  const handleDelete = useCallback(async (id: string) => {
    setDeleteScriptTarget(null)
    try {
      await removeRegexScript(id)
      if (expandedId === id) setExpandedId(null)
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('regexPanel.requestFailed'))
    }
  }, [removeRegexScript, expandedId])

  const handleDeleteFolder = useCallback(async (scripts: RegexScript[]) => {
    setDeleteFolderTarget(null)
    if (scripts.length === 0) return
    const ids = scripts.map((s) => s.id)
    try {
      const deleted = await bulkRemoveRegexScripts(ids)
      if (expandedId && ids.includes(expandedId)) setExpandedId(null)
      if (deleted < ids.length) {
        toast.error(t('regexPanel.deleteSomeFailed', { count: ids.length - deleted }))
      } else {
        toast.success(t('regexPanel.deletedScripts', { count: deleted }))
      }
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('regexPanel.requestFailed'))
    }
  }, [bulkRemoveRegexScripts, expandedId])

  const handleToggle = useCallback(async (id: string, disabled: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await toggleRegexScript(id, disabled)
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('regexPanel.requestFailed'))
    }
  }, [toggleRegexScript])

  const handleBindToPreset = useCallback(async (script: RegexScript, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!activeLoomPresetId) {
      toast.error(t('regexPanel.selectPresetFirstScript'))
      return
    }
    const nextPresetId = script.preset_id === activeLoomPresetId ? null : activeLoomPresetId
    try {
      await updateRegexScript(script.id, { preset_id: nextPresetId })
      toast.success(nextPresetId ? t('regexPanel.boundToActivePreset') : t('regexPanel.unboundFromPreset'))
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('regexPanel.requestFailed'))
    }
  }, [activeLoomPresetId, updateRegexScript])

  const handleBindFolderToPreset = useCallback(async (scripts: RegexScript[], folderLabel: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!activeLoomPresetId) {
      toast.error(t('regexPanel.selectPresetFirstFolder'))
      return
    }
    const allBound = scripts.length > 0 && scripts.every((s) => s.preset_id === activeLoomPresetId)
    const nextPresetId = allBound ? null : activeLoomPresetId
    try {
      await Promise.all(scripts.map((script) => updateRegexScript(script.id, { preset_id: nextPresetId })))
      toast.success(nextPresetId
        ? t('regexPanel.boundFolderToPreset', { folder: folderLabel })
        : t('regexPanel.unboundFolderFromPreset', { folder: folderLabel }))
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('regexPanel.requestFailed'))
    }
  }, [activeLoomPresetId, updateRegexScript])

  const handleExport = useCallback(async () => {
    try {
      const data = await regexApi.exportScripts()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = t('regexPanel.exportFilename')
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('regexPanel.requestFailed'))
    }
  }, [])

  const handleExportFolder = useCallback(async (folder: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      const data = await regexApi.exportScripts(undefined, { folder })
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${folder || t('regexPanel.uncategorized')}-regex-scripts.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      toast.error(err.body?.error || err.message || t('regexPanel.requestFailed'))
    }
  }, [])

  const handleImport = useCallback(() => {
    openModal('regexImport')
  }, [openModal])

  const targetBadge = (target: string | string[]) => {
    const targets = Array.isArray(target) ? target : [target]
    return (
      <>
        {targets.includes('prompt') && <Badge color="warning" size="sm">P</Badge>}
        {targets.includes('response') && <Badge color="success" size="sm">R</Badge>}
        {targets.includes('display') && <Badge color="info" size="sm">D</Badge>}
      </>
    )
  }

  const scopeIcon = (scope: RegexScope) => {
    switch (scope) {
      case 'global': return <Globe size={12} />
      case 'character': return <User size={12} />
      case 'chat': return <MessageCircle size={12} />
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.topBar}>
        <span className={styles.topBarTitle}>{t('regexPanel.title')}</span>
        <div className={styles.topBarActions}>
          <Button size="icon-sm" variant="ghost" onClick={handleImport} title={t('actions.import', { ns: 'common' })}>
            <Upload size={14} />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={handleExport} title={t('actions.export', { ns: 'common' })}>
            <Download size={14} />
          </Button>
          <div className={styles.createPopoverWrapper} ref={popoverRef}>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setShowCreatePopover(!showCreatePopover)}
              title={t('actions.add', { ns: 'common' })}
            >
              <Plus size={14} />
            </Button>
            {showCreatePopover && (
              <div className={styles.createPopover}>
                {creatingFolderMode ? (
                  <div className={styles.createPopoverInput}>
                    <input
                      ref={folderInputRef}
                      value={creatingFolderName}
                      onChange={(e) => setCreatingFolderName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleCreateFolder()
                        if (e.key === 'Escape') {
                          setCreatingFolderMode(false)
                          setCreatingFolderName('')
                        }
                      }}
                      placeholder={t('regexPanel.folderName')}
                      className={styles.createPopoverField}
                    />
                    <button
                      className={styles.createPopoverBtn}
                      onClick={handleCreateFolder}
                      disabled={!creatingFolderName.trim()}
                    >
                      <Check size={12} />
                    </button>
                    <button
                      className={styles.createPopoverBtn}
                      onClick={() => {
                        setCreatingFolderMode(false)
                        setCreatingFolderName('')
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      className={styles.createPopoverOption}
                      onClick={() => {
                        handleAdd()
                        setShowCreatePopover(false)
                      }}
                    >
                      <Plus size={12} /> {t('regexPanel.newScript')}
                    </button>
                    <button
                      className={clsx(styles.createPopoverOption, styles.createPopoverFolder)}
                      onClick={() => setCreatingFolderMode(true)}
                    >
                      <FolderPlus size={12} /> {t('regexPanel.newFolder')}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.scopeFilter}>
        {(['all', 'global', 'character', 'chat'] as ScopeFilterValue[]).map((v) => (
          <button
            key={v}
            className={clsx(styles.scopePill, scopeFilter === v && styles.scopePillActive)}
            onClick={() => setScopeFilter(v)}
          >
            {t(SCOPE_FILTER_LABEL_KEYS[v])}
          </button>
        ))}
      </div>

      <div className={styles.scriptList}>
        {filteredScripts.length === 0 ? (
          <div className={styles.emptyState}>
            <p>{t('regexPanel.noScripts')}</p>
            <p>{t('regexPanel.clickPlus')}</p>
          </div>
        ) : groupedScripts ? (
          groupedScripts.map((group) => {
            const folderKey = group.folder || '__uncategorized'
            const isCollapsed = collapsedFolders.has(folderKey)
            const folderLabel = group.folder || t('regexPanel.uncategorized')
            return (
              <div key={folderKey}>
                <div
                  className={styles.folderHeader}
                  onClick={() => toggleFolder(folderKey)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleFolder(folderKey) }}
                >
                  <ChevronRight
                    size={12}
                    className={clsx(styles.folderChevron, !isCollapsed && styles.folderChevronOpen)}
                  />
                  <span className={styles.folderName}>
                    {folderLabel}
                  </span>
                  <span className={styles.folderCount}>{group.scripts.length}</span>
                  {group.folder && (
                    <>
                      {activeLoomPresetId && (
                        <button
                          className={styles.folderDeleteBtn}
                          onClick={(e) => handleBindFolderToPreset(group.scripts, folderLabel, e)}
                          title={group.scripts.every((s) => s.preset_id === activeLoomPresetId)
                            ? t('regexPanel.unbindFolderFromPreset', { folder: folderLabel })
                            : t('regexPanel.bindFolderToPreset', { folder: folderLabel })}
                          aria-label={group.scripts.every((s) => s.preset_id === activeLoomPresetId)
                            ? t('regexPanel.unbindFolderFromPresetAria', { folder: folderLabel })
                            : t('regexPanel.bindFolderToPresetAria', { folder: folderLabel })}
                        >
                          {group.scripts.every((s) => s.preset_id === activeLoomPresetId) ? <Unlink size={12} /> : <Link size={12} />}
                        </button>
                      )}
                      <button
                        className={styles.folderDeleteBtn}
                        onClick={(e) => handleExportFolder(group.folder, e)}
                        title={t('regexPanel.exportFolder', { folder: folderLabel })}
                        aria-label={t('regexPanel.exportFolderAria', { folder: folderLabel })}
                      >
                        <Download size={12} />
                      </button>
                      <button
                        className={styles.folderDeleteBtn}
                        onClick={(e) => { e.stopPropagation(); setDeleteFolderTarget({ scripts: group.scripts, folder: folderLabel }) }}
                        title={t('regexPanel.deleteFolderScripts', { folder: folderLabel })}
                        aria-label={t('regexPanel.deleteFolderScriptsAria', { folder: folderLabel })}
                      >
                        <Trash2 size={12} />
                      </button>
                    </>
                  )}
                </div>
                {!isCollapsed &&
                  group.scripts.map((script) => (
                    <ScriptRow
                      key={script.id}
                      script={script}
                      expanded={expandedId === script.id}
                      onToggleExpand={() => setExpandedId(expandedId === script.id ? null : script.id)}
                      onDelete={(e) => { e.stopPropagation(); setDeleteScriptTarget(script) }}
                      onToggle={(disabled, e) => handleToggle(script.id, disabled, e)}
                      onBindPreset={(e) => handleBindToPreset(script, e)}
                      onUpdate={(updates) => updateRegexScript(script.id, updates)}
                      onOpenModal={() => openModal('regexEditor', { scriptId: script.id })}
                      targetBadge={targetBadge(script.target)}
                      scopeIcon={scopeIcon(script.scope)}
                      folders={folders}
                      onCreateFolder={createFolder}
                      activePresetId={activeLoomPresetId}
                    />
                  ))}
              </div>
            )
          })
        ) : (
          filteredScripts.map((script) => (
            <ScriptRow
              key={script.id}
              script={script}
              expanded={expandedId === script.id}
              onToggleExpand={() => setExpandedId(expandedId === script.id ? null : script.id)}
              onDelete={(e) => { e.stopPropagation(); setDeleteScriptTarget(script) }}
              onToggle={(disabled, e) => handleToggle(script.id, disabled, e)}
              onBindPreset={(e) => handleBindToPreset(script, e)}
              onUpdate={(updates) => updateRegexScript(script.id, updates)}
              onOpenModal={() => openModal('regexEditor', { scriptId: script.id })}
              targetBadge={targetBadge(script.target)}
              scopeIcon={scopeIcon(script.scope)}
              folders={folders}
              onCreateFolder={createFolder}
              activePresetId={activeLoomPresetId}
            />
          ))
        )}
      </div>

      {deleteScriptTarget && (
        <ConfirmationModal
          isOpen={true}
          title={t('regexPanel.deleteScriptTitle')}
          message={t('regexPanel.deleteScriptConfirm', { name: deleteScriptTarget.name })}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={() => { void handleDelete(deleteScriptTarget.id) }}
          onCancel={() => setDeleteScriptTarget(null)}
        />
      )}

      {deleteFolderTarget && (
        <ConfirmationModal
          isOpen={true}
          title={t('regexPanel.deleteFolderTitle')}
          message={t('regexPanel.deleteFolderConfirm', { count: deleteFolderTarget.scripts.length, folder: deleteFolderTarget.folder })}
          variant="danger"
          confirmText={tc('actions.delete')}
          onConfirm={() => { void handleDeleteFolder(deleteFolderTarget.scripts) }}
          onCancel={() => setDeleteFolderTarget(null)}
        />
      )}
    </div>
  )
}

function ScriptRow({
  script,
  expanded,
  onToggleExpand,
  onDelete,
  onToggle,
  onBindPreset,
  onUpdate,
  onOpenModal,
  targetBadge,
  scopeIcon,
  folders,
  onCreateFolder,
  activePresetId,
}: {
  script: RegexScript
  expanded: boolean
  onToggleExpand: () => void
  onDelete: (e: React.MouseEvent) => void
  onToggle: (disabled: boolean, e: React.MouseEvent) => void
  onBindPreset: (e: React.MouseEvent) => void
  onUpdate: (updates: Record<string, any>) => void | Promise<void>
  onOpenModal: () => void
  targetBadge: React.ReactNode
  scopeIcon: React.ReactNode
  folders: string[]
  onCreateFolder: (name: string) => void
  activePresetId: string | null
}) {
  const { t } = useTranslation('panels')
  const replaceRef = useRef<HTMLTextAreaElement>(null)

  // Text fields go through a local draft so the controlled inputs update
  // synchronously (the store round-trips through the API and a WS-triggered
  // refetch, which would replace the value mid-typing and throw the cursor
  // to the end) and the API write is debounced per typing pause.
  const [draft, setDraft] = useState(() => ({
    name: script.name,
    find_regex: script.find_regex,
    replace_string: script.replace_string,
  }))
  const pendingRef = useRef<Record<string, any>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const onUpdateRef = useRef(onUpdate)
  onUpdateRef.current = onUpdate

  // Adopt external changes (editor modal, other tabs) only when no local
  // edits are waiting to be saved.
  useEffect(() => {
    if (Object.keys(pendingRef.current).length > 0) return
    setDraft((d) =>
      d.name === script.name && d.find_regex === script.find_regex && d.replace_string === script.replace_string
        ? d
        : { name: script.name, find_regex: script.find_regex, replace_string: script.replace_string }
    )
  }, [script.name, script.find_regex, script.replace_string])

  const flushDraft = useCallback(() => {
    clearTimeout(saveTimer.current)
    const pending = pendingRef.current
    pendingRef.current = {}
    if (Object.keys(pending).length === 0) return
    void Promise.resolve(onUpdateRef.current(pending)).catch((err: any) => {
      toast.error(err.body?.error || err.message || i18n.t('regexPanel.requestFailed', { ns: 'panels' }))
    })
  }, [])

  const queueDraftUpdate = useCallback((updates: Partial<Pick<RegexScript, 'name' | 'find_regex' | 'replace_string'>>) => {
    setDraft((d) => ({ ...d, ...updates }))
    pendingRef.current = { ...pendingRef.current, ...updates }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flushDraft, 400)
  }, [flushDraft])

  // Persist trailing edits when the row unmounts (folder collapse, scope
  // filter change, panel close).
  useEffect(() => () => flushDraft(), [flushDraft])

  const performance = getRegexPerformanceMetadata(script)
  const warningText = performance
    ? performance.timed_out
      ? t('regexPanel.timedOut')
      : t('regexPanel.slowDetected', { seconds: (performance.elapsed_ms / 1000).toFixed(1) })
    : null

  return (
    <div>
      <div
        className={clsx(
          styles.scriptRow,
          expanded && styles.scriptRowExpanded,
          performance && styles.scriptRowSlow,
        )}
        onClick={onToggleExpand}
      >
        <Badge size="sm">{scopeIcon}</Badge>
        <span className={clsx(styles.scriptName, script.disabled && styles.scriptNameDisabled)}>
          {draft.name}
        </span>
        {performance && (
          <span className={styles.slowBadge} title={warningText ?? undefined} aria-label={warningText ?? undefined}>
            <TriangleAlert size={12} /> {t('regexPanel.slow')}
          </span>
        )}
        {targetBadge}
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center' }}>
          <Toggle.Switch
            checked={!script.disabled}
            onChange={(v) => onToggle(!v, { stopPropagation: () => {} } as React.MouseEvent)}
          />
        </div>
        {activePresetId && (
          <Button
            size="icon-sm"
            variant="ghost"
            className={styles.deleteBtn}
            onClick={onBindPreset}
            title={script.preset_id === activePresetId ? t('regexPanel.unbindFromActivePreset') : t('regexPanel.bindToActivePreset')}
          >
            {script.preset_id === activePresetId ? <Unlink size={13} /> : <Link size={13} />}
          </Button>
        )}
        <Button size="icon-sm" variant="danger-ghost" className={styles.deleteBtn} onClick={onDelete} title={i18n.t('actions.delete', { ns: 'common' })}>
          <Trash2 size={13} />
        </Button>
      </div>

      {expanded && (
        <div className={styles.inlineEditor}>
          <div className={styles.field}>
              <label className={styles.fieldLabel}>{t('regexPanel.name')}</label>
            <input
              className={styles.fieldInput}
              value={draft.name}
              onChange={(e) => queueDraftUpdate({ name: e.target.value })}
            />
          </div>
          {performance && (
            <div className={styles.warningBox}>
              <TriangleAlert size={14} />
              <span>
                {performance.timed_out
                  ? t('regexPanel.timedOutDetail')
                  : t('regexPanel.slowDetail', { seconds: (performance.elapsed_ms / 1000).toFixed(1) })}
              </span>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('regexPanel.folder')}</label>
            <FolderDropdown
              folders={folders}
              selectedFolder={script.folder || ''}
              onSelect={(f) => onUpdate({ folder: f })}
              onCreateFolder={onCreateFolder}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>
              Find
              <span className={styles.fieldHint}>{t('regexPanel.findHint')}</span>
            </label>
            <input
              className={styles.fieldInputMono}
              value={draft.find_regex}
              onChange={(e) => queueDraftUpdate({ find_regex: e.target.value })}
              placeholder={t('regexPanel.findPlaceholder')}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>
              {t('regexPanel.replaceWith')}
              <span className={styles.fieldHint}>{t('regexPanel.replaceHint')}</span>
            </label>
            <div className={styles.tokenBar}>
              {REPLACE_TOKEN_KEYS.map((token) => (
                <button
                  key={token.label}
                  className={styles.tokenChip}
                  title={t(token.hintKey)}
                  onClick={() => {
                    queueDraftUpdate({ replace_string: insertAtCursor(replaceRef.current, token.value) })
                  }}
                >
                  {token.label}
                </button>
              ))}
              <span className={styles.tokenDivider} />
              {REPLACE_HTML.map((htmlToken) => (
                <button
                  key={htmlToken.label}
                  className={clsx(styles.tokenChip, styles.tokenChipHtml)}
                  title={t('regexPanel.wrapIn', { tag: htmlToken.label })}
                  onClick={() => {
                    queueDraftUpdate({ replace_string: insertAtCursor(replaceRef.current, htmlToken.value) })
                  }}
                >
                  {htmlToken.label}
                </button>
              ))}
            </div>
            <textarea
              ref={replaceRef}
              className={styles.fieldTextarea}
              value={draft.replace_string}
              onChange={(e) => queueDraftUpdate({ replace_string: e.target.value })}
              placeholder={t('regexPanel.replacePlaceholder')}
              rows={2}
            />
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>{t('regexPanel.flags')}</label>
              <div className={styles.flagsRow}>
                {[
                  { f: 'g', hint: t('regexPanel.flagGlobal') },
                  { f: 'i', hint: t('regexPanel.flagInsensitive') },
                  { f: 'm', hint: t('regexPanel.flagMultiline') },
                  { f: 's', hint: t('regexPanel.flagDotall') },
                  { f: 'u', hint: t('regexPanel.flagUnicode') },
                  { f: 'v', hint: t('regexPanel.flagUnicodeSets') },
                  { f: 'd', hint: t('regexPanel.flagIndices') },
                  { f: 'y', hint: t('regexPanel.flagSticky') },
                ].map(({ f, hint }) => (
                  <label key={f} className={styles.flagCheck} title={hint}>
                    <input
                      type="checkbox"
                      checked={script.flags.includes(f)}
                      onChange={(e) => {
                        const flags = e.target.checked
                          ? script.flags + f
                          : script.flags.replace(f, '')
                        onUpdate({ flags })
                      }}
                    />
                    {f}
                  </label>
                ))}
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>{t('regexPanel.appliesTo')}</label>
              <div className={styles.placementRow}>
                {([
                  { p: 'user_input' as const, label: t('regexPanel.targetUser') },
                  { p: 'ai_output' as const, label: t('regexPanel.targetAi') },
                  { p: 'world_info' as const, label: t('regexPanel.targetWi') },
                  { p: 'reasoning' as const, label: t('regexPanel.targetCot') },
                ]).map(({ p, label }) => (
                  <label key={p} className={styles.flagCheck}>
                    <input
                      type="checkbox"
                      checked={script.placement.includes(p)}
                      onChange={(e) => {
                        const placement = e.target.checked
                          ? [...script.placement, p]
                          : script.placement.filter((x) => x !== p)
                        onUpdate({ placement })
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
          <button className={styles.editModalLink} onClick={onOpenModal}>
            {t('regexPanel.allOptions')}
          </button>
        </div>
      )}
    </div>
  )
}

import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Plus, Upload, Download, Trash2, Globe, User, MessageCircle, ChevronRight, FolderPlus, Check, X, Link, Unlink, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import { useFolders } from '@/hooks/useFolders'
import FolderDropdown from '@/components/shared/FolderDropdown'
import { Toggle } from '@/components/shared/Toggle'
import { Badge } from '@/components/shared/Badge'
import type { RegexScript, RegexScope, RegexPerformanceMetadata } from '@/types/regex'
import styles from './RegexPanel.module.css'
import clsx from 'clsx'

type ScopeFilterValue = 'all' | 'global' | 'character'

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

const REPLACE_TOKENS = [
  { label: '$&', value: '$&', hint: 'Full match' },
  { label: '$1', value: '$1', hint: 'Group 1' },
  { label: '$2', value: '$2', hint: 'Group 2' },
  { label: '""', value: '', hint: 'Delete' },
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
  const regexScripts = useStore((s) => s.regexScripts)
  const loadRegexScripts = useStore((s) => s.loadRegexScripts)
  const addRegexScript = useStore((s) => s.addRegexScript)
  const updateRegexScript = useStore((s) => s.updateRegexScript)
  const removeRegexScript = useStore((s) => s.removeRegexScript)
  const bulkRemoveRegexScripts = useStore((s) => s.bulkRemoveRegexScripts)
  const toggleRegexScript = useStore((s) => s.toggleRegexScript)
  const openModal = useStore((s) => s.openModal)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)

  const [scopeFilter, setScopeFilter] = useState<ScopeFilterValue>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [showCreatePopover, setShowCreatePopover] = useState(false)
  const [creatingFolderName, setCreatingFolderName] = useState('')
  const [creatingFolderMode, setCreatingFolderMode] = useState(false)
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
        name: 'New Script',
        find_regex: '',
        flags: 'gi',
        folder: folder || '',
      })
      setExpandedId(script.id)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
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

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await removeRegexScript(id)
      if (expandedId === id) setExpandedId(null)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [removeRegexScript, expandedId])

  const handleDeleteFolder = useCallback(async (scripts: RegexScript[], folderLabel: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (scripts.length === 0) return
    const confirmMsg = `Delete all ${scripts.length} regex script${scripts.length === 1 ? '' : 's'} in "${folderLabel}"? This cannot be undone.`
    if (!confirm(confirmMsg)) return
    const ids = scripts.map((s) => s.id)
    try {
      const deleted = await bulkRemoveRegexScripts(ids)
      if (expandedId && ids.includes(expandedId)) setExpandedId(null)
      if (deleted < ids.length) {
        toast.error(`${ids.length - deleted} script${ids.length - deleted === 1 ? '' : 's'} could not be deleted`)
      } else {
        toast.success(`Deleted ${deleted} script${deleted === 1 ? '' : 's'}`)
      }
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [bulkRemoveRegexScripts, expandedId])

  const handleToggle = useCallback(async (id: string, disabled: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await toggleRegexScript(id, disabled)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [toggleRegexScript])

  const handleBindToPreset = useCallback(async (script: RegexScript, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!activeLoomPresetId) {
      toast.error('Select a Loom preset before binding regex scripts')
      return
    }
    const nextPresetId = script.preset_id === activeLoomPresetId ? null : activeLoomPresetId
    try {
      await updateRegexScript(script.id, { preset_id: nextPresetId })
      toast.success(nextPresetId ? 'Regex bound to active preset' : 'Regex unbound from preset')
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [activeLoomPresetId, updateRegexScript])

  const handleBindFolderToPreset = useCallback(async (scripts: RegexScript[], folderLabel: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!activeLoomPresetId) {
      toast.error('Select a Loom preset before binding regex folders')
      return
    }
    const allBound = scripts.length > 0 && scripts.every((s) => s.preset_id === activeLoomPresetId)
    const nextPresetId = allBound ? null : activeLoomPresetId
    try {
      await Promise.all(scripts.map((script) => updateRegexScript(script.id, { preset_id: nextPresetId })))
      toast.success(nextPresetId
        ? `Bound "${folderLabel}" to active preset`
        : `Unbound "${folderLabel}" from active preset`)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [activeLoomPresetId, updateRegexScript])

  const handleExport = useCallback(async () => {
    try {
      const data = await regexApi.exportScripts()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'regex-scripts.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
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
      a.download = `${folder || 'uncategorized'}-regex-scripts.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [])

  const handleImport = useCallback(() => {
    openModal('regexImport')
  }, [openModal])

  const targetBadge = (target: string) => {
    switch (target) {
      case 'prompt': return <Badge color="warning" size="sm">P</Badge>
      case 'response': return <Badge color="success" size="sm">R</Badge>
      case 'display': return <Badge color="info" size="sm">D</Badge>
      default: return null
    }
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
        <span className={styles.topBarTitle}>Regex Scripts</span>
        <div className={styles.topBarActions}>
          <Button size="icon-sm" variant="ghost" onClick={handleImport} title="Import">
            <Upload size={14} />
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={handleExport} title="Export">
            <Download size={14} />
          </Button>
          <div className={styles.createPopoverWrapper} ref={popoverRef}>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => setShowCreatePopover(!showCreatePopover)}
              title="Add"
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
                      placeholder="Folder name..."
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
                      <Plus size={12} /> New Script
                    </button>
                    <button
                      className={clsx(styles.createPopoverOption, styles.createPopoverFolder)}
                      onClick={() => setCreatingFolderMode(true)}
                    >
                      <FolderPlus size={12} /> New Folder
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className={styles.scopeFilter}>
        {(['all', 'global', 'character'] as ScopeFilterValue[]).map((v) => (
          <button
            key={v}
            className={clsx(styles.scopePill, scopeFilter === v && styles.scopePillActive)}
            onClick={() => setScopeFilter(v)}
          >
            {v === 'all' ? 'All' : v === 'global' ? 'Global' : 'This Char'}
          </button>
        ))}
      </div>

      <div className={styles.scriptList}>
        {filteredScripts.length === 0 ? (
          <div className={styles.emptyState}>
            <p>No regex scripts yet.</p>
            <p>Click + to create one.</p>
          </div>
        ) : groupedScripts ? (
          groupedScripts.map((group) => {
            const folderKey = group.folder || '__uncategorized'
            const isCollapsed = collapsedFolders.has(folderKey)
            const folderLabel = group.folder || 'Uncategorized'
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
                            ? `Unbind "${folderLabel}" from active preset`
                            : `Bind "${folderLabel}" to active preset`}
                          aria-label={group.scripts.every((s) => s.preset_id === activeLoomPresetId)
                            ? `Unbind ${folderLabel} from active preset`
                            : `Bind ${folderLabel} to active preset`}
                        >
                          {group.scripts.every((s) => s.preset_id === activeLoomPresetId) ? <Unlink size={12} /> : <Link size={12} />}
                        </button>
                      )}
                      <button
                        className={styles.folderDeleteBtn}
                        onClick={(e) => handleExportFolder(group.folder, e)}
                        title={`Export scripts in "${folderLabel}"`}
                        aria-label={`Export scripts in ${folderLabel}`}
                      >
                        <Download size={12} />
                      </button>
                      <button
                        className={styles.folderDeleteBtn}
                        onClick={(e) => handleDeleteFolder(group.scripts, folderLabel, e)}
                        title={`Delete all scripts in "${folderLabel}"`}
                        aria-label={`Delete all scripts in ${folderLabel}`}
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
                      onDelete={(e) => handleDelete(script.id, e)}
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
              onDelete={(e) => handleDelete(script.id, e)}
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
  onUpdate: (updates: Record<string, any>) => void
  onOpenModal: () => void
  targetBadge: React.ReactNode
  scopeIcon: React.ReactNode
  folders: string[]
  onCreateFolder: (name: string) => void
  activePresetId: string | null
}) {
  const replaceRef = useRef<HTMLTextAreaElement>(null)
  const performance = getRegexPerformanceMetadata(script)
  const warningText = performance
    ? performance.timed_out
      ? 'Timed out during regex execution'
      : `Slow regex detected (${(performance.elapsed_ms / 1000).toFixed(1)}s)`
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
          {script.name}
        </span>
        {performance && (
          <span className={styles.slowBadge} title={warningText ?? undefined} aria-label={warningText ?? undefined}>
            <TriangleAlert size={12} /> Slow
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
            title={script.preset_id === activePresetId ? 'Unbind from active preset' : 'Bind to active preset'}
          >
            {script.preset_id === activePresetId ? <Unlink size={13} /> : <Link size={13} />}
          </Button>
        )}
        <Button size="icon-sm" variant="danger-ghost" className={styles.deleteBtn} onClick={onDelete} title="Delete">
          <Trash2 size={13} />
        </Button>
      </div>

      {expanded && (
        <div className={styles.inlineEditor}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <input
              className={styles.fieldInput}
              value={script.name}
              onChange={(e) => onUpdate({ name: e.target.value })}
            />
          </div>
          {performance && (
            <div className={styles.warningBox}>
              <TriangleAlert size={14} />
              <span>
                {performance.timed_out
                  ? 'This script hit the regex timeout and was skipped during execution.'
                  : `This script was flagged as slow after taking ${(performance.elapsed_ms / 1000).toFixed(1)}s to run.`}
              </span>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Folder</label>
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
              <span className={styles.fieldHint}>Regex pattern — use (parentheses) to capture groups</span>
            </label>
            <input
              className={styles.fieldInputMono}
              value={script.find_regex}
              onChange={(e) => onUpdate({ find_regex: e.target.value })}
              placeholder="e.g. \(OOC:.*?\) or <tag>(.*?)</tag>"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>
              Replace with
              <span className={styles.fieldHint}>What matched text becomes — supports HTML</span>
            </label>
            <div className={styles.tokenBar}>
              {REPLACE_TOKENS.map((t) => (
                <button
                  key={t.label}
                  className={styles.tokenChip}
                  title={t.hint}
                  onClick={() => {
                    onUpdate({ replace_string: insertAtCursor(replaceRef.current, t.value) })
                  }}
                >
                  {t.label}
                </button>
              ))}
              <span className={styles.tokenDivider} />
              {REPLACE_HTML.map((t) => (
                <button
                  key={t.label}
                  className={clsx(styles.tokenChip, styles.tokenChipHtml)}
                  title={`Wrap in ${t.label}`}
                  onClick={() => {
                    onUpdate({ replace_string: insertAtCursor(replaceRef.current, t.value) })
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <textarea
              ref={replaceRef}
              className={styles.fieldTextarea}
              value={script.replace_string}
              onChange={(e) => onUpdate({ replace_string: e.target.value })}
              placeholder="Leave empty to delete matches, or use $1, $& and HTML"
              rows={2}
            />
          </div>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Flags</label>
              <div className={styles.flagsRow}>
                {[
                  { f: 'g', hint: 'Global — all matches' },
                  { f: 'i', hint: 'Case insensitive' },
                  { f: 'm', hint: 'Multiline' },
                  { f: 's', hint: 'Dotall — . matches newlines' },
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
              <label className={styles.fieldLabel}>Applies to</label>
              <div className={styles.placementRow}>
                {([
                  { p: 'user_input' as const, label: 'User' },
                  { p: 'ai_output' as const, label: 'AI' },
                  { p: 'world_info' as const, label: 'WI' },
                  { p: 'reasoning' as const, label: 'CoT' },
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
            All options...
          </button>
        </div>
      )}
    </div>
  )
}

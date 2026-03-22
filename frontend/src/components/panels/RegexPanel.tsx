import { useState, useCallback, useEffect, useRef } from 'react'
import { Plus, Upload, Download, Trash2, Globe, User, MessageCircle } from 'lucide-react'
import { useStore } from '@/store'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import type { RegexScript, RegexScope } from '@/types/regex'
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

export default function RegexPanel() {
  const regexScripts = useStore((s) => s.regexScripts)
  const loadRegexScripts = useStore((s) => s.loadRegexScripts)
  const addRegexScript = useStore((s) => s.addRegexScript)
  const updateRegexScript = useStore((s) => s.updateRegexScript)
  const removeRegexScript = useStore((s) => s.removeRegexScript)
  const toggleRegexScript = useStore((s) => s.toggleRegexScript)
  const openModal = useStore((s) => s.openModal)
  const activeCharacterId = useStore((s) => s.activeCharacterId)

  const [scopeFilter, setScopeFilter] = useState<ScopeFilterValue>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    loadRegexScripts()
  }, [loadRegexScripts])

  const filteredScripts = regexScripts.filter((s) => {
    if (scopeFilter === 'all') return true
    if (scopeFilter === 'global') return s.scope === 'global'
    if (scopeFilter === 'character') return s.scope === 'character' && s.scope_id === activeCharacterId
    return true
  })

  const handleAdd = useCallback(async () => {
    try {
      const script = await addRegexScript({
        name: 'New Script',
        find_regex: '',
        flags: 'gi',
      })
      setExpandedId(script.id)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [addRegexScript])

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await removeRegexScript(id)
      if (expandedId === id) setExpandedId(null)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [removeRegexScript, expandedId])

  const handleToggle = useCallback(async (id: string, disabled: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await toggleRegexScript(id, disabled)
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [toggleRegexScript])

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

  const handleImport = useCallback(() => {
    openModal('regexImport')
  }, [openModal])

  const targetBadge = (target: string) => {
    switch (target) {
      case 'prompt': return <span className={clsx(styles.badge, styles.badgePrompt)}>P</span>
      case 'response': return <span className={clsx(styles.badge, styles.badgeResponse)}>R</span>
      case 'display': return <span className={clsx(styles.badge, styles.badgeDisplay)}>D</span>
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
          <button className={styles.iconBtn} onClick={handleImport} title="Import">
            <Upload size={14} />
          </button>
          <button className={styles.iconBtn} onClick={handleExport} title="Export">
            <Download size={14} />
          </button>
          <button className={styles.iconBtn} onClick={handleAdd} title="Add Script">
            <Plus size={14} />
          </button>
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
        ) : (
          filteredScripts.map((script) => (
            <ScriptRow
              key={script.id}
              script={script}
              expanded={expandedId === script.id}
              onToggleExpand={() => setExpandedId(expandedId === script.id ? null : script.id)}
              onDelete={(e) => handleDelete(script.id, e)}
              onToggle={(disabled, e) => handleToggle(script.id, disabled, e)}
              onUpdate={(updates) => updateRegexScript(script.id, updates)}
              onOpenModal={() => {
                openModal('regexEditor', { scriptId: script.id })
              }}
              targetBadge={targetBadge(script.target)}
              scopeIcon={scopeIcon(script.scope)}
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
  onUpdate,
  onOpenModal,
  targetBadge,
  scopeIcon,
}: {
  script: RegexScript
  expanded: boolean
  onToggleExpand: () => void
  onDelete: (e: React.MouseEvent) => void
  onToggle: (disabled: boolean, e: React.MouseEvent) => void
  onUpdate: (updates: Record<string, any>) => void
  onOpenModal: () => void
  targetBadge: React.ReactNode
  scopeIcon: React.ReactNode
}) {
  const replaceRef = useRef<HTMLTextAreaElement>(null)

  return (
    <div>
      <div
        className={clsx(styles.scriptRow, expanded && styles.scriptRowExpanded)}
        onClick={onToggleExpand}
      >
        <span className={styles.badge}>{scopeIcon}</span>
        <span className={clsx(styles.scriptName, script.disabled && styles.scriptNameDisabled)}>
          {script.name}
        </span>
        {targetBadge}
        <div
          className={clsx(styles.toggle, !script.disabled && styles.toggleOn)}
          onClick={(e) => onToggle(!script.disabled, e)}
        />
        <button className={styles.deleteBtn} onClick={onDelete} title="Delete">
          <Trash2 size={13} />
        </button>
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

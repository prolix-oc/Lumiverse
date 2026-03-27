import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Zap,
  Plus,
  Trash2,
  Copy,
  Download,
  Upload,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  MoreVertical,
  Layers,
  Settings,
  Info,
  FileText,
  Lock,
  ToggleLeft,
  ToggleRight,
  FolderPlus,
  Radio,
  CheckSquare,
  Edit3,
} from 'lucide-react'
import { useLumiBuilder } from '@/hooks/useLumiBuilder'
import { useStore } from '@/store'
import type { LumiPipeline, LumiModule, BlockGroupConfig } from '@/types/api'
import clsx from 'clsx'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import styles from './LumiBuilder.module.css'

/* ── Sub-components ── */

function Section({
  title,
  Icon,
  children,
  defaultExpanded = false,
}: {
  title: string
  Icon: any
  children: React.ReactNode
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader} onClick={() => setExpanded(!expanded)}>
        <Icon size={14} className={styles.sectionIcon} />
        <span className={styles.sectionTitle}>{title}</span>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
      {expanded && <div className={styles.sectionBody}>{children}</div>}
    </div>
  )
}

function PipelineGroup({
  pipeline,
  onToggle,
  onRemove,
  onRename,
  onAddModule,
  onRemoveModule,
  onUpdateModule,
}: {
  pipeline: LumiPipeline
  onToggle: () => void
  onRemove: () => void
  onRename: (name: string) => void
  onAddModule: () => void
  onRemoveModule: (moduleKey: string) => void
  onUpdateModule: (moduleKey: string, updates: Partial<LumiModule>) => void
}) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className={styles.pipelineGroup}>
      <div className={styles.pipelineHeader}>
        <input
          type="checkbox"
          checked={pipeline.enabled}
          onChange={onToggle}
        />
        <button
          type="button"
          className={styles.pipelineExpand}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <input
          className={clsx(styles.input, styles.moduleName)}
          value={pipeline.name}
          onChange={(e) => onRename(e.target.value)}
        />
        <button className={styles.iconBtn} onClick={onRemove} title="Remove pipeline">
          <Trash2 size={14} />
        </button>
      </div>
      {expanded && (
        <div className={styles.pipelineModules}>
          {pipeline.modules.map((mod) => (
            <div key={mod.key} className={styles.moduleItem}>
              <div className={styles.moduleHeader}>
                <input
                  type="checkbox"
                  checked={mod.enabled}
                  onChange={() => onUpdateModule(mod.key, { enabled: !mod.enabled })}
                />
                <input
                  className={clsx(styles.input, styles.moduleName)}
                  value={mod.name}
                  onChange={(e) => onUpdateModule(mod.key, { name: e.target.value })}
                  placeholder="Module name"
                />
                <span className={styles.moduleKeyTag} title={`Use {{pipe(${mod.key.slice(0, 8)}...)}} in prompt blocks`}>
                  {mod.key.slice(0, 8)}
                </span>
                <button className={styles.iconBtn} onClick={() => onRemoveModule(mod.key)}>
                  <Trash2 size={14} />
                </button>
              </div>
              <textarea
                className={styles.modulePrompt}
                value={mod.prompt}
                onChange={(e) => onUpdateModule(mod.key, { prompt: e.target.value })}
                placeholder="Module instruction prompt... (supports macros like {{char}}, {{user}})"
              />
            </div>
          ))}
          <button className={styles.btn} onClick={onAddModule}>
            <Plus size={14} /> Add Module
          </button>
        </div>
      )}
    </div>
  )
}

const ROLE_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
]

const POSITION_OPTIONS = [
  { value: 'pre_history', label: 'Before Chat History' },
  { value: 'post_history', label: 'After Chat History' },
  { value: 'in_history', label: 'In Chat History (at depth)' },
]

function BlockItem({
  block,
  idx,
  totalCount,
  expandedId,
  setExpandedId,
  onUpdate,
  onRemove,
  onMove,
  blockGroups,
  onSetGroup,
  onRadioToggle,
}: {
  block: any
  idx: number
  totalCount: number
  expandedId: string | null
  setExpandedId: (id: string | null) => void
  onUpdate: (id: string, updates: Record<string, any>) => void
  onRemove: (id: string) => void
  onMove: (id: string, direction: 'up' | 'down') => void
  blockGroups?: BlockGroupConfig[]
  onSetGroup?: (id: string, group: string | null) => void
  onRadioToggle?: (id: string) => void
}) {
  const isExpanded = expandedId === block.id
  const groupConfig = blockGroups?.find((g) => g.name === block.group)
  const isRadio = groupConfig?.mode === 'radio'

  const handleToggle = () => {
    if (isRadio && onRadioToggle) {
      onRadioToggle(block.id)
    } else {
      onUpdate(block.id, { enabled: !block.enabled })
    }
  }

  return (
    <div className={clsx(styles.blockItem, !block.enabled && styles.blockDisabled)}>
      <div className={styles.blockHeader}>
        <button
          className={styles.iconBtn}
          onClick={handleToggle}
          title={block.enabled ? 'Disable' : 'Enable'}
        >
          {block.enabled ? <ToggleRight size={14} className={styles.toggleOn} /> : <ToggleLeft size={14} />}
        </button>
        <button
          className={styles.pipelineExpand}
          onClick={() => setExpandedId(isExpanded ? null : block.id)}
        >
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span
          className={styles.blockName}
          onClick={() => setExpandedId(isExpanded ? null : block.id)}
        >
          {block.name || 'Untitled Block'}
        </span>
        <span className={clsx(styles.blockTag, styles[`blockTag_${block.role}`])}>
          {block.role}
        </span>
        {block.position === 'in_history' && (
          <span className={styles.blockDepth}>d:{block.depth}</span>
        )}
        {block.isLocked && <Lock size={12} className={styles.lockIcon} />}
        <div className={styles.blockActions}>
          <button className={styles.iconBtn} onClick={() => onMove(block.id, 'up')} disabled={idx === 0}>
            <ChevronUp size={14} />
          </button>
          <button className={styles.iconBtn} onClick={() => onMove(block.id, 'down')} disabled={idx === totalCount - 1}>
            <ChevronDown size={14} />
          </button>
          {!block.isLocked && (
            <button className={styles.iconBtn} onClick={() => onRemove(block.id)}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className={styles.blockBody}>
          <div className={styles.blockRow}>
            <div className={styles.field}>
              <label className={styles.label}>Name</label>
              <input
                className={styles.input}
                value={block.name}
                onChange={(e) => onUpdate(block.id, { name: e.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Role</label>
              <select
                className={styles.select}
                value={block.role}
                onChange={(e) => onUpdate(block.id, { role: e.target.value })}
              >
                {ROLE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className={styles.blockRow}>
            <div className={styles.field}>
              <label className={styles.label}>Position</label>
              <select
                className={styles.select}
                value={block.position}
                onChange={(e) => onUpdate(block.id, { position: e.target.value })}
              >
                {POSITION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            {block.position === 'in_history' && (
              <div className={styles.field}>
                <label className={styles.label}>Depth</label>
                <input
                  type="number"
                  className={styles.input}
                  min={0}
                  value={block.depth}
                  onChange={(e) => onUpdate(block.id, { depth: parseInt(e.target.value) || 0 })}
                />
              </div>
            )}
          </div>
          {blockGroups && onSetGroup && (
            <div className={styles.field}>
              <label className={styles.label}>Group</label>
              <select
                className={styles.select}
                value={block.group || ''}
                onChange={(e) => onSetGroup(block.id, e.target.value || null)}
              >
                <option value="">(Ungrouped)</option>
                {blockGroups.map((g) => (
                  <option key={g.name} value={g.name}>{g.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label}>Content</label>
            <textarea
              className={styles.textarea}
              value={block.content}
              onChange={(e) => onUpdate(block.id, { content: e.target.value })}
              placeholder="Prompt content... supports macros like {{pipeline}}, {{pipe(key)}}, {{char}}, {{user}}"
            />
          </div>
          <div className={styles.blockRow}>
            <label className={styles.inlineCheck}>
              <input
                type="checkbox"
                checked={block.isLocked}
                onChange={(e) => onUpdate(block.id, { isLocked: e.target.checked })}
              />
              <span>Locked</span>
            </label>
            <div className={styles.field} style={{ flex: 1 }}>
              <label className={styles.label}>Marker</label>
              <input
                className={styles.input}
                value={block.marker || ''}
                onChange={(e) => onUpdate(block.id, { marker: e.target.value || null })}
                placeholder="e.g. chat_history, world_info"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function GroupedPromptBlockEditor({
  blocks,
  blockGroups,
  onUpdate,
  onRemove,
  onMove,
  onAdd,
  onSetGroup,
  onRadioToggle,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onUpdateGroupConfig,
}: {
  blocks: any[]
  blockGroups: BlockGroupConfig[]
  onUpdate: (id: string, updates: Record<string, any>) => void
  onRemove: (id: string) => void
  onMove: (id: string, direction: 'up' | 'down') => void
  onAdd: (group?: string | null) => void
  onSetGroup: (id: string, group: string | null) => void
  onRadioToggle: (id: string) => void
  onCreateGroup: (name: string, mode: 'radio' | 'checkbox') => void
  onRenameGroup: (oldName: string, newName: string) => void
  onDeleteGroup: (name: string) => void
  onUpdateGroupConfig: (name: string, updates: Partial<BlockGroupConfig>) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [showNewGroup, setShowNewGroup] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupMode, setNewGroupMode] = useState<'radio' | 'checkbox'>('checkbox')
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const toggleGroupCollapse = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleCreateGroup = () => {
    if (!newGroupName.trim()) return
    onCreateGroup(newGroupName.trim(), newGroupMode)
    setNewGroupName('')
    setNewGroupMode('checkbox')
    setShowNewGroup(false)
  }

  const handleStartRename = (name: string) => {
    setRenamingGroup(name)
    setRenameValue(name)
  }

  const handleFinishRename = (oldName: string) => {
    if (renameValue.trim() && renameValue.trim() !== oldName) {
      onRenameGroup(oldName, renameValue.trim())
    }
    setRenamingGroup(null)
  }

  // Sort groups by order
  const sortedGroups = [...blockGroups].sort((a, b) => a.order - b.order)

  // Group blocks by their group field
  const groupedBlocks = new Map<string, any[]>()
  const ungrouped: any[] = []
  for (const block of blocks) {
    if (block.group && blockGroups.some((g) => g.name === block.group)) {
      if (!groupedBlocks.has(block.group)) groupedBlocks.set(block.group, [])
      groupedBlocks.get(block.group)!.push(block)
    } else {
      ungrouped.push(block)
    }
  }

  return (
    <div className={styles.blockList}>
      {/* Grouped blocks */}
      {sortedGroups.map((group) => {
        const groupBlocks = groupedBlocks.get(group.name) || []
        const isCollapsed = collapsedGroups.has(group.name)
        const enabledCount = groupBlocks.filter((b: any) => b.enabled).length

        return (
          <div key={group.name} className={styles.blockGroup}>
            <div className={styles.blockGroupHeader}>
              <button
                className={styles.pipelineExpand}
                onClick={() => toggleGroupCollapse(group.name)}
              >
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              {renamingGroup === group.name ? (
                <input
                  className={clsx(styles.input, styles.moduleName)}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => handleFinishRename(group.name)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleFinishRename(group.name); if (e.key === 'Escape') setRenamingGroup(null) }}
                  autoFocus
                />
              ) : (
                <span className={styles.blockGroupName} onClick={() => toggleGroupCollapse(group.name)}>
                  {group.name}
                </span>
              )}
              <span className={clsx(styles.groupBadge, group.mode === 'radio' ? styles.groupBadge_radio : styles.groupBadge_checkbox)}>
                {group.mode === 'radio' ? <Radio size={10} /> : <CheckSquare size={10} />}
                {group.mode}
              </span>
              <span className={styles.blockDepth}>{enabledCount}/{groupBlocks.length}</span>
              <div className={styles.blockActions}>
                <button className={styles.iconBtn} onClick={() => onUpdateGroupConfig(group.name, { mode: group.mode === 'radio' ? 'checkbox' : 'radio' })} title="Toggle mode">
                  {group.mode === 'radio' ? <CheckSquare size={14} /> : <Radio size={14} />}
                </button>
                <button className={styles.iconBtn} onClick={() => handleStartRename(group.name)} title="Rename">
                  <Edit3 size={14} />
                </button>
                <button className={styles.iconBtn} onClick={() => onDeleteGroup(group.name)} title="Delete group">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {!isCollapsed && (
              <div className={styles.blockGroupBody}>
                {groupBlocks.map((block: any, idx: number) => (
                  <BlockItem
                    key={block.id}
                    block={block}
                    idx={idx}
                    totalCount={groupBlocks.length}
                    expandedId={expandedId}
                    setExpandedId={setExpandedId}
                    onUpdate={onUpdate}
                    onRemove={onRemove}
                    onMove={onMove}
                    blockGroups={blockGroups}
                    onSetGroup={onSetGroup}
                    onRadioToggle={onRadioToggle}
                  />
                ))}
                <button className={clsx(styles.btn, styles.btnSmall)} onClick={() => onAdd(group.name)}>
                  <Plus size={12} /> Add Block
                </button>
              </div>
            )}
          </div>
        )
      })}

      {/* Ungrouped blocks */}
      {ungrouped.length > 0 && (
        <div className={styles.blockGroup}>
          <div className={styles.blockGroupHeader}>
            <span className={styles.blockGroupName}>Ungrouped</span>
            <span className={styles.blockDepth}>{ungrouped.length}</span>
          </div>
          <div className={styles.blockGroupBody}>
            {ungrouped.map((block: any, idx: number) => (
              <BlockItem
                key={block.id}
                block={block}
                idx={idx}
                totalCount={ungrouped.length}
                expandedId={expandedId}
                setExpandedId={setExpandedId}
                onUpdate={onUpdate}
                onRemove={onRemove}
                onMove={onMove}
                blockGroups={blockGroups}
                onSetGroup={onSetGroup}
                onRadioToggle={onRadioToggle}
              />
            ))}
          </div>
        </div>
      )}

      {/* Add block / Add group buttons */}
      <div className={styles.blockRow} style={{ gap: 8 }}>
        <button className={styles.btn} onClick={() => onAdd(null)}>
          <Plus size={14} /> Add Block
        </button>
        <button className={styles.btn} onClick={() => setShowNewGroup(true)}>
          <FolderPlus size={14} /> Add Group
        </button>
      </div>

      {showNewGroup && (
        <div className={styles.blockItem} style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className={styles.blockRow}>
            <div className={styles.field} style={{ flex: 1 }}>
              <label className={styles.label}>Group Name</label>
              <input
                className={styles.input}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateGroup() }}
                placeholder="e.g. POV, Narrative Style"
                autoFocus
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Mode</label>
              <select
                className={styles.select}
                value={newGroupMode}
                onChange={(e) => setNewGroupMode(e.target.value as 'radio' | 'checkbox')}
              >
                <option value="checkbox">Checkbox (multi)</option>
                <option value="radio">Radio (pick one)</option>
              </select>
            </div>
          </div>
          <div className={styles.blockRow} style={{ gap: 8 }}>
            <button className={clsx(styles.btn, styles.btnPrimary, styles.btnSmall)} onClick={handleCreateGroup} disabled={!newGroupName.trim()}>Create</button>
            <button className={clsx(styles.btn, styles.btnSmall)} onClick={() => { setShowNewGroup(false); setNewGroupName('') }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function LumiBuilder({ compact = true }: { compact?: boolean }) {
  const {
    registry,
    activePresetId,
    activePreset,
    metadata,
    promptOrder,
    isLoading,
    addPipeline,
    removePipeline,
    togglePipeline,
    updatePipeline,
    addModule,
    removeModule,
    updateModule,
    updateSidecar,
    addBlock,
    updateBlock,
    removeBlock,
    moveBlock,
    blockGroups,
    createBlockGroup,
    renameBlockGroup,
    deleteBlockGroup,
    setBlockGroup,
    toggleBlockInRadioGroup,
    updateBlockGroupConfig,
    createPreset,
    selectPreset,
    deletePreset,
    duplicatePreset,
    importLumiFile,
    exportLumiFile,
    savePreset,
  } = useLumiBuilder()

  const profiles = useStore((s) => s.profiles)

  // Local state for UI
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newProvider, setNewProvider] = useState('')
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Handlers
  const handleCreate = async () => {
    if (!newName.trim()) return
    const provider = newProvider || 'openai'
    await createPreset(newName.trim(), provider)
    setNewName('')
    setNewProvider('')
    setShowCreate(false)
  }

  const handleDuplicate = async () => {
    if (!activePreset) return
    const name = `${activePreset.name} (Copy)`
    await duplicatePreset(activePreset.id, name)
    setShowMenu(false)
  }

  const handleDelete = async () => {
    if (!activePreset) return
    if (confirm(`Are you sure you want to delete "${activePreset.name}"?`)) {
      await deletePreset(activePreset.id)
      setShowMenu(false)
    }
  }

  const handleExport = async () => {
    const data = await exportLumiFile()
    if (!data) return
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${data.name || 'preset'}.lumi`
    a.click()
    URL.revokeObjectURL(url)
    setShowMenu(false)
  }

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.lumi,.json'
    input.onchange = async (e: any) => {
      const file = e.target.files[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = async (re: any) => {
        try {
          const data = JSON.parse(re.target.result)
          await importLumiFile(data)
        } catch (err) {
          alert('Failed to import Lumi file: ' + err)
        }
      }
      reader.readAsText(file)
    }
    input.click()
    setShowMenu(false)
  }

  const handleAddPipeline = () => {
    addPipeline('New Pipeline')
  }

  // Create dialog component (shared between empty and active states)
  const createDialog = showCreate && (
    <div className={styles.createOverlay}>
      <div className={styles.createDialog}>
        <h3 className={styles.createTitle}>Create Lumi Preset</h3>
        <div className={styles.field}>
          <label className={styles.label}>Preset Name</label>
          <input
            className={styles.input}
            autoFocus
            placeholder="My Lumi Preset"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          />
        </div>
        <div className={styles.field} style={{ marginTop: 12 }}>
          <label className={styles.label}>Provider</label>
          <select
            className={styles.select}
            value={newProvider}
            onChange={(e) => setNewProvider(e.target.value)}
          >
            <option value="">Select provider...</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="google">Google</option>
            <option value="openrouter">OpenRouter</option>
            <option value="mistral">Mistral</option>
            <option value="cohere">Cohere</option>
            <option value="groq">Groq</option>
            <option value="custom">Custom/Other</option>
          </select>
          <span className={styles.settingsHint}>The API provider for the main LLM. Sidecar uses its own connection profile.</span>
        </div>
        <div className={styles.toolbar} style={{ border: 'none', padding: '16px 0 0', justifyContent: 'flex-end' }}>
          <button className={styles.btn} onClick={() => { setShowCreate(false); setNewName(''); setNewProvider('') }}>Cancel</button>
          <button className={clsx(styles.btn, styles.btnPrimary)} onClick={handleCreate} disabled={!newName.trim()}>Create</button>
        </div>
      </div>
    </div>
  )

  if (!activePreset && !isLoading) {
    return (
      <div className={styles.layout}>
        <div className={styles.toolbar}>
          <button className={clsx(styles.btn, styles.btnPrimary)} onClick={() => setShowCreate(true)}>
            <Plus size={14} /> New Lumi Preset
          </button>
          <button className={styles.btn} onClick={handleImport}>
            <Upload size={14} /> Import
          </button>
        </div>
        <div className={styles.emptyState}>
          <Zap size={48} strokeWidth={1} />
          <p>No Lumi preset selected.</p>
          <p className={styles.settingsHint}>
            Lumi Engine runs sidecar LLM analysis pipelines alongside your main preset.
            Use <code>{`{{pipeline}}`}</code> or <code>{`{{pipe(key)}}`}</code> in prompt blocks to inject results.
          </p>
        </div>

        {/* Preset selector for existing presets */}
        {registry.length > 0 && (
          <div style={{ padding: '0 14px' }}>
            <select
              className={styles.select}
              style={{ width: '100%' }}
              value=""
              onChange={(e) => selectPreset(e.target.value || null)}
            >
              <option value="">(Select Preset)</option>
              {registry.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
        )}

        {createDialog}
      </div>
    )
  }

  return (
    <PanelFadeIn>
      <div className={styles.layout}>
        {/* ── Toolbar ── */}
        <div className={styles.toolbar}>
          <div style={{ position: 'relative', flex: 1 }}>
            <select
            className={styles.select}
            style={{ width: '100%' }}
            value={activePresetId || ''}
            onChange={(e) => selectPreset(e.target.value || null)}
          >
            <option value="">(Select Preset)</option>
            {registry.map((item) => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </div>

        <button className={styles.iconBtn} onClick={() => setShowCreate(true)} title="New Preset">
          <Plus size={18} />
        </button>

        <div style={{ position: 'relative' }} ref={menuRef}>
          <button className={styles.iconBtn} onClick={() => setShowMenu(!showMenu)}>
            <MoreVertical size={18} />
          </button>
          {showMenu && (
            <div className={styles.dropdownMenu}>
              <button className={styles.menuButton} onClick={handleDuplicate}>
                <Copy size={14} /> Duplicate
              </button>
              <button className={styles.menuButton} onClick={handleExport}>
                <Download size={14} /> Export .lumi
              </button>
              <button className={styles.menuButton} onClick={handleImport}>
                <Upload size={14} /> Import .lumi
              </button>
              <div className={styles.menuDivider} />
              <button className={clsx(styles.menuButton, styles.menuButtonDanger)} onClick={handleDelete}>
                <Trash2 size={14} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={styles.scrollArea}>
        {/* ── Info hint ── */}
        <div className={styles.hintBar}>
          <Info size={12} />
          <span>
            Use <code>{`{{pipeline}}`}</code> in prompt blocks to inject all sidecar results,
            or <code>{`{{pipe(key)}}`}</code> for a specific module.
            CoT uses your global reasoning settings — add thinking directives in your prompt blocks.
          </span>
        </div>

        {/* ── Preset Info ── */}
        {activePreset && (
          <Section title="Preset Info" Icon={Zap} defaultExpanded={false}>
            <div className={styles.field}>
              <label className={styles.label}>Name</label>
              <input
                className={styles.input}
                value={activePreset.name}
                onChange={(e) => savePreset({ name: e.target.value })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Provider</label>
              <input
                className={styles.input}
                value={activePreset.provider}
                onChange={(e) => savePreset({ provider: e.target.value })}
              />
              <span className={styles.settingsHint}>API provider for the main LLM (e.g. openai, anthropic, openrouter)</span>
            </div>
          </Section>
        )}

        {/* ── Pipeline Editor ── */}
        <Section title="Analysis Pipelines" Icon={Layers} defaultExpanded>
          {metadata.pipelines.map((pipeline) => (
            <PipelineGroup
              key={pipeline.key}
              pipeline={pipeline}
              onToggle={() => togglePipeline(pipeline.key)}
              onRemove={() => removePipeline(pipeline.key)}
              onRename={(name) => updatePipeline(pipeline.key, { name })}
              onAddModule={() => addModule(pipeline.key)}
              onRemoveModule={(moduleKey) => removeModule(pipeline.key, moduleKey)}
              onUpdateModule={(moduleKey, updates) => updateModule(pipeline.key, moduleKey, updates)}
            />
          ))}
          <button className={styles.btn} onClick={handleAddPipeline}>
            <Plus size={14} /> Add Pipeline
          </button>
        </Section>

        {/* ── Sidecar Settings ── */}
        <Section title="Sidecar LLM Config" Icon={Settings}>
          <div className={styles.field}>
            <label className={styles.label}>Connection Profile</label>
            <select
              className={styles.select}
              value={metadata.sidecar.connectionProfileId || ''}
              onChange={(e) => updateSidecar({ connectionProfileId: e.target.value || null })}
            >
              <option value="">(No Connection)</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Model Override</label>
            <input
              className={styles.input}
              value={metadata.sidecar.model || ''}
              onChange={(e) => updateSidecar({ model: e.target.value || null })}
              placeholder="Leave empty to use connection default"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Temperature — {metadata.sidecar.temperature}</label>
            <input
              type="range"
              min="0"
              max="2"
              step="0.01"
              value={metadata.sidecar.temperature}
              onChange={(e) => updateSidecar({ temperature: parseFloat(e.target.value) })}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Top P — {metadata.sidecar.topP}</label>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={metadata.sidecar.topP}
              onChange={(e) => updateSidecar({ topP: parseFloat(e.target.value) })}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Max Tokens per Module</label>
            <input
              type="number"
              className={styles.input}
              value={metadata.sidecar.maxTokensPerModule}
              onChange={(e) => updateSidecar({ maxTokensPerModule: parseInt(e.target.value) || 256 })}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label}>Context Window</label>
            <input
              type="number"
              className={styles.input}
              value={metadata.sidecar.contextWindow}
              onChange={(e) => updateSidecar({ contextWindow: parseInt(e.target.value) || 4096 })}
            />
            <span className={styles.settingsHint}>Approximate context size for sidecar calls (tokens).</span>
          </div>
        </Section>

        {/* ── Prompt Blocks ── */}
        <Section title="Prompt Blocks" Icon={FileText}>
          <p className={styles.settingsHint} style={{ marginBottom: 8 }}>
            Loom-style prompt blocks that build the main LLM's context.
            Use <code>{`{{pipeline}}`}</code> to inject all sidecar results or <code>{`{{pipe(key)}}`}</code> for individual modules.
          </p>
          <GroupedPromptBlockEditor
            blocks={promptOrder}
            blockGroups={blockGroups}
            onUpdate={updateBlock}
            onRemove={removeBlock}
            onMove={moveBlock}
            onAdd={(group) => addBlock(group ?? null)}
            onSetGroup={setBlockGroup}
            onRadioToggle={toggleBlockInRadioGroup}
            onCreateGroup={createBlockGroup}
            onRenameGroup={renameBlockGroup}
            onDeleteGroup={deleteBlockGroup}
            onUpdateGroupConfig={updateBlockGroupConfig}
          />
        </Section>

      </div>

      {createDialog}
      </div>
    </PanelFadeIn>
  )
}

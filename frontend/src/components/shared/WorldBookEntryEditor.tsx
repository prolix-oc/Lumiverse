import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import clsx from 'clsx'
import type { WorldBookEntry } from '@/types/api'
import { getVectorIndexStatusDescription, getVectorIndexStatusLabel } from '@/lib/worldBookVectorization'
import NumberStepper from './NumberStepper'
import styles from './WorldBookEntryEditor.module.css'

export const POSITION_OPTIONS = [
  { value: 0, label: 'Before Main Prompt' },
  { value: 1, label: 'After Main Prompt' },
  { value: 2, label: 'Before AN' },
  { value: 3, label: 'After AN' },
  { value: 4, label: 'At Depth' },
]

export const ROLE_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'user', label: 'User' },
  { value: 'assistant', label: 'Assistant' },
]

export const SELECTIVE_LOGIC_OPTIONS = [
  { value: 0, label: 'AND All Keys' },
  { value: 1, label: 'NOT None' },
  { value: 2, label: 'OR Any Key' },
  { value: 3, label: 'NOT All' },
]

export interface EntryEditorProps {
  entry: WorldBookEntry
  onUpdate: (id: string, updates: Record<string, any>) => void
  onImmediateUpdate: (id: string, updates: Record<string, any>) => void
}

export default function WorldBookEntryEditor({ entry, onUpdate, onImmediateUpdate }: EntryEditorProps) {
  const [groupOpen, setGroupOpen] = useState(false)
  const [timingOpen, setTimingOpen] = useState(false)
  const [recursionOpen, setRecursionOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const vectorStatusClass =
    entry.vector_index_status === 'indexed'
      ? styles.vectorStatusIndexed
      : entry.vector_index_status === 'error'
        ? styles.vectorStatusError
        : entry.vector_index_status === 'pending'
          ? styles.vectorStatusPending
          : styles.vectorStatusNotEnabled

  // Local state for text fields to prevent prop-sync from overwriting in-progress edits
  const [content, setContent] = useState(entry.content)
  const [comment, setComment] = useState(entry.comment)
  const [primaryKeys, setPrimaryKeys] = useState(entry.key.join(', '))
  const [secondaryKeys, setSecondaryKeys] = useState(entry.keysecondary.join(', '))
  const lastSyncedId = useRef<string | null>(null)

  // Sync from entry prop only when switching to a different entry
  useEffect(() => {
    if (lastSyncedId.current === entry.id) return
    lastSyncedId.current = entry.id
    setContent(entry.content)
    setComment(entry.comment)
    setPrimaryKeys(entry.key.join(', '))
    setSecondaryKeys(entry.keysecondary.join(', '))
  }, [entry])

  const handleContentChange = useCallback(
    (v: string) => {
      setContent(v)
      onUpdate(entry.id, { content: v })
    },
    [entry.id, onUpdate]
  )

  const handleCommentChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setComment(e.target.value)
      onUpdate(entry.id, { comment: e.target.value })
    },
    [entry.id, onUpdate]
  )

  const handlePrimaryKeysChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPrimaryKeys(e.target.value)
      onUpdate(entry.id, {
        key: e.target.value.split(',').map((k) => k.trim()).filter(Boolean),
      })
    },
    [entry.id, onUpdate]
  )

  const handleSecondaryKeysChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSecondaryKeys(e.target.value)
      onUpdate(entry.id, {
        keysecondary: e.target.value.split(',').map((k) => k.trim()).filter(Boolean),
      })
    },
    [entry.id, onUpdate]
  )

  return (
    <div className={styles.entryEditor}>
      {/* Identity & Content */}
      <span className={styles.sectionHeading}>Identity & Content</span>
      <div className={styles.entryFieldGroup}>
        <div className={styles.entryField}>
          <label className={styles.fieldLabel}>Comment / Label</label>
          <input
            type="text"
            className={styles.entryInput}
            value={comment}
            onChange={handleCommentChange}
          />
        </div>
        <div className={styles.entryField}>
          <label className={styles.fieldLabel}>Primary Keys (comma-separated)</label>
          <input
            type="text"
            className={styles.entryInput}
            value={primaryKeys}
            onChange={handlePrimaryKeysChange}
          />
        </div>
        <div className={styles.entryField}>
          <label className={styles.fieldLabel}>Secondary Keys (comma-separated)</label>
          <input
            type="text"
            className={styles.entryInput}
            value={secondaryKeys}
            onChange={handleSecondaryKeysChange}
          />
        </div>
        <div className={styles.entryField}>
          <label className={styles.fieldLabel}>Content</label>
          <ExpandableTextarea
            className={styles.entryTextarea}
            value={content}
            onChange={handleContentChange}
            title={comment || 'Entry Content'}
            rows={4}
          />
        </div>
      </div>

      {/* Injection */}
      <span className={styles.sectionHeading}>Injection</span>
      <div className={styles.entryFieldGroup}>
        <div className={styles.entryFieldRow}>
          <div className={styles.entryField}>
            <label className={styles.fieldLabel}>Position</label>
            <select
              className={styles.entrySelect}
              value={entry.position}
              onChange={(e) => onImmediateUpdate(entry.id, { position: Number(e.target.value) })}
            >
              {POSITION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {entry.position === 4 && (
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>Depth</label>
              <NumberStepper
                value={entry.depth}
                min={0}
                onChange={(v) => onImmediateUpdate(entry.id, { depth: v ?? 0 })}
              />
            </div>
          )}
          <div className={styles.entryField}>
            <label className={styles.fieldLabel}>Role</label>
            <select
              className={styles.entrySelect}
              value={entry.role || 'system'}
              onChange={(e) => onImmediateUpdate(entry.id, { role: e.target.value })}
            >
              {ROLE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
            <label className={styles.fieldLabel}>Order</label>
            <NumberStepper
              value={entry.order_value}
              onChange={(v) => onImmediateUpdate(entry.id, { order_value: v ?? 0 })}
            />
          </div>
        </div>
      </div>

      {/* Activation */}
      <span className={styles.sectionHeading}>Activation</span>
      <div className={styles.entryFieldGroup}>
        <div className={styles.toggleRow}>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.selective}
              onChange={() => onImmediateUpdate(entry.id, { selective: !entry.selective })}
            />
            Selective
          </label>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.constant}
              onChange={() => onImmediateUpdate(entry.id, { constant: !entry.constant })}
            />
            Constant
          </label>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.disabled}
              onChange={() => onImmediateUpdate(entry.id, { disabled: !entry.disabled })}
            />
            Disabled
          </label>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.case_sensitive}
              onChange={() => onImmediateUpdate(entry.id, { case_sensitive: !entry.case_sensitive })}
            />
            Case Sensitive
          </label>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.match_whole_words}
              onChange={() =>
                onImmediateUpdate(entry.id, { match_whole_words: !entry.match_whole_words })
              }
            />
            Match Whole Words
          </label>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.use_regex}
              onChange={() => onImmediateUpdate(entry.id, { use_regex: !entry.use_regex })}
            />
            Use Regex
          </label>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.use_probability}
              onChange={() => onImmediateUpdate(entry.id, { use_probability: !entry.use_probability })}
            />
            Use Probability
          </label>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.vectorized}
              onChange={() => onImmediateUpdate(entry.id, { vectorized: !entry.vectorized })}
            />
            Use for semantic activation
          </label>
        </div>
        <div className={styles.vectorStatusRow}>
          <span className={clsx(styles.vectorStatusBadge, vectorStatusClass)}>
            {getVectorIndexStatusLabel(entry.vector_index_status)}
          </span>
          <span className={styles.vectorStatusText}>
            {getVectorIndexStatusDescription(entry)}
          </span>
        </div>
        <div className={styles.entryFieldRow}>
          <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
            <label className={styles.fieldLabel}>Probability</label>
            <NumberStepper
              value={entry.probability}
              min={0}
              max={100}
              onChange={(v) => onImmediateUpdate(entry.id, { probability: v ?? 0 })}
            />
          </div>
          <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
            <label className={styles.fieldLabel}>Scan Depth</label>
            <NumberStepper
              value={entry.scan_depth}
              min={0}
              allowEmpty
              onChange={(v) => onImmediateUpdate(entry.id, { scan_depth: v })}
            />
          </div>
          {entry.selective && (
            <div className={styles.entryField}>
              <label className={styles.fieldLabel}>Selective Logic</label>
              <select
                className={styles.entrySelect}
                value={entry.selective_logic}
                onChange={(e) => onImmediateUpdate(entry.id, { selective_logic: Number(e.target.value) })}
              >
                {SELECTIVE_LOGIC_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Timing (collapsible) */}
      <button
        type="button"
        className={styles.groupToggle}
        onClick={() => setTimingOpen((o) => !o)}
      >
        <ChevronRight
          size={12}
          className={clsx(styles.groupToggleIcon, timingOpen && styles.groupToggleOpen)}
        />
        Timing
      </button>
      {timingOpen && (
        <div className={styles.entryFieldGroup}>
          <div className={styles.entryFieldRow}>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>Priority</label>
              <NumberStepper
                value={entry.priority}
                onChange={(v) => onImmediateUpdate(entry.id, { priority: v ?? 0 })}
              />
            </div>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>Sticky</label>
              <NumberStepper
                value={entry.sticky}
                min={0}
                onChange={(v) => onImmediateUpdate(entry.id, { sticky: v ?? 0 })}
              />
            </div>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>Cooldown</label>
              <NumberStepper
                value={entry.cooldown}
                min={0}
                onChange={(v) => onImmediateUpdate(entry.id, { cooldown: v ?? 0 })}
              />
            </div>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>Delay</label>
              <NumberStepper
                value={entry.delay}
                min={0}
                onChange={(v) => onImmediateUpdate(entry.id, { delay: v ?? 0 })}
              />
            </div>
          </div>
        </div>
      )}

      {/* Recursion (collapsible) */}
      <button
        type="button"
        className={styles.groupToggle}
        onClick={() => setRecursionOpen((o) => !o)}
      >
        <ChevronRight
          size={12}
          className={clsx(styles.groupToggleIcon, recursionOpen && styles.groupToggleOpen)}
        />
        Recursion
      </button>
      {recursionOpen && (
        <div className={styles.entryFieldGroup}>
          <div className={styles.toggleRow}>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={entry.prevent_recursion}
                onChange={() =>
                  onImmediateUpdate(entry.id, { prevent_recursion: !entry.prevent_recursion })
                }
              />
              Prevent Recursion
            </label>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={entry.exclude_recursion}
                onChange={() =>
                  onImmediateUpdate(entry.id, { exclude_recursion: !entry.exclude_recursion })
                }
              />
              Exclude Recursion
            </label>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={entry.delay_until_recursion}
                onChange={() =>
                  onImmediateUpdate(entry.id, { delay_until_recursion: !entry.delay_until_recursion })
                }
              />
              Delay Until Recursion
            </label>
          </div>
        </div>
      )}

      {/* Group (collapsible) */}
      <button
        type="button"
        className={styles.groupToggle}
        onClick={() => setGroupOpen((o) => !o)}
      >
        <ChevronRight
          size={12}
          className={clsx(styles.groupToggleIcon, groupOpen && styles.groupToggleOpen)}
        />
        Group
      </button>
      {groupOpen && (
        <div className={styles.entryFieldGroup}>
          <div className={styles.entryFieldRow}>
            <div className={styles.entryField}>
              <label className={styles.fieldLabel}>Group Name</label>
              <input
                type="text"
                className={styles.entryInput}
                value={entry.group_name}
                onChange={(e) => onUpdate(entry.id, { group_name: e.target.value })}
              />
            </div>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>Weight</label>
              <NumberStepper
                value={entry.group_weight}
                onChange={(v) => onImmediateUpdate(entry.id, { group_weight: v ?? 0 })}
              />
            </div>
          </div>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={entry.group_override}
              onChange={() =>
                onImmediateUpdate(entry.id, { group_override: !entry.group_override })
              }
            />
            Group Override
          </label>
        </div>
      )}

      {/* Metadata (collapsible) */}
      <button
        type="button"
        className={styles.groupToggle}
        onClick={() => setMetadataOpen((o) => !o)}
      >
        <ChevronRight
          size={12}
          className={clsx(styles.groupToggleIcon, metadataOpen && styles.groupToggleOpen)}
        />
        Metadata
      </button>
      {metadataOpen && (
        <div className={styles.entryFieldGroup}>
          <div className={styles.entryField}>
            <label className={styles.fieldLabel}>UID</label>
            <span className={styles.readOnlyValue}>{entry.uid}</span>
          </div>
          <div className={styles.entryField}>
            <label className={styles.fieldLabel}>Automation ID</label>
            <input
              type="text"
              className={styles.entryInput}
              value={entry.automation_id || ''}
              onChange={(e) => onUpdate(entry.id, { automation_id: e.target.value || null })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

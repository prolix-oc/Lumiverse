import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from 'lucide-react'
import { Toggle } from '@/components/shared/Toggle'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import TokenCountButton from '@/components/shared/TokenCountButton'
import clsx from 'clsx'
import type { WorldBookEntry } from '@/types/api'
import { getVectorIndexStatusDescription, getVectorIndexStatusLabel } from '@/lib/worldBookVectorization'
import { useWorldBookEntryLabels } from '@/lib/i18n/worldBookEntryLabels'
import { useLoomOptionLabels } from '@/lib/i18n/loomOptionLabels'
import NumberStepper from './NumberStepper'
import styles from './WorldBookEntryEditor.module.css'

export interface EntryEditorProps {
  entry: WorldBookEntry
  onUpdate: (id: string, updates: Record<string, any>) => void
  onImmediateUpdate: (id: string, updates: Record<string, any>) => void
}

export default function WorldBookEntryEditor({ entry, onUpdate, onImmediateUpdate }: EntryEditorProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entryEditor' })
  const { positionOptions, roleOptions, selectiveLogicOptions } = useWorldBookEntryLabels()
  const { addableMarkers, markerLabel, markerSectionLabel } = useLoomOptionLabels()

  const [groupOpen, setGroupOpen] = useState(false)
  const [timingOpen, setTimingOpen] = useState(false)
  const [recursionOpen, setRecursionOpen] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const recursionInvalidated = entry.vectorized
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
  const [outletName, setOutletName] = useState(entry.outlet_name || '')
  const [wiMarker, setWiMarker] = useState(entry.wi_marker || '')
  const [wiMarkerSide, setWiMarkerSide] = useState(entry.wi_marker_side || 'after')
  const [primaryKeys, setPrimaryKeys] = useState(entry.key.join(', '))
  const [secondaryKeys, setSecondaryKeys] = useState(entry.keysecondary.join(', '))
  const lastSyncedId = useRef<string | null>(null)

  // Sync from entry prop only when switching to a different entry
  useEffect(() => {
    if (lastSyncedId.current === entry.id) return
    lastSyncedId.current = entry.id
    setContent(entry.content)
    setComment(entry.comment)
    setOutletName(entry.outlet_name || '')
    setWiMarker(entry.wi_marker || '')
    setWiMarkerSide(entry.wi_marker_side || 'after')
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

  const handleOutletNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const nextValue = e.target.value
      setOutletName(nextValue)
      onUpdate(entry.id, { outlet_name: nextValue || null })
    },
    [entry.id, onUpdate]
  )
  const handleWiMarkerChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value
      setWiMarker(value)
      onImmediateUpdate(entry.id, { wi_marker: value || null })
    },
    [entry.id, onImmediateUpdate]
  )

  const handleWiMarkerSideChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value as 'before' | 'after'
      setWiMarkerSide(value)
      onImmediateUpdate(entry.id, { wi_marker_side: value })
    },
    [entry.id, onImmediateUpdate]
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
  const markerGroups = (() => {
    const groups: Array<{ section: string; items: string[] }> = []
    let current: { section: string; items: string[] } | null = null
    for (const item of addableMarkers) {
      if (typeof item === 'object' && 'section' in item) {
        current = { section: item.section, items: [] }
        groups.push(current)
      } else if (current) {
        current.items.push(item)
      }
    }
    return groups
  })()

  return (
    <div className={styles.entryEditor} data-world-book-entry-editor="true">
      {/* Identity & Content */}
      <span className={styles.sectionHeading}>{t('sections.identity')}</span>
      <div className={styles.entryFieldGroup}>
        <div className={styles.entryField}>
          <label className={styles.fieldLabel}>{t('fields.comment')}</label>
          <input
            type="text"
            className={styles.entryInput}
            value={comment}
            onChange={handleCommentChange}
          />
        </div>
        <div className={styles.entryField}>
          <label className={styles.fieldLabel}>{t('fields.outletName')}</label>
          <input
            type="text"
            className={styles.entryInput}
            value={outletName}
            onChange={handleOutletNameChange}
            placeholder={t('outletPlaceholder')}
          />
        </div>
        <div className={styles.entryField}>
          <label className={styles.fieldLabel}>{t('fields.primaryKeys')}</label>
          <input
            type="text"
            className={styles.entryInput}
            value={primaryKeys}
            onChange={handlePrimaryKeysChange}
          />
        </div>
        <div className={styles.entryField}>
          <label className={styles.fieldLabel}>{t('fields.secondaryKeys')}</label>
          <input
            type="text"
            className={styles.entryInput}
            value={secondaryKeys}
            onChange={handleSecondaryKeysChange}
          />
        </div>
        <div className={styles.entryField}>
          <div className={styles.fieldLabelRow}>
            <label className={styles.fieldLabel}>{t('fields.content')}</label>
            <TokenCountButton text={content} />
          </div>
          <ExpandableTextarea
            className={styles.entryTextarea}
            value={content}
            onChange={handleContentChange}
            title={comment || t('entryContentTitle')}
            rows={4}
          />
        </div>
      </div>

      {/* Injection */}
      <span className={styles.sectionHeading}>{t('sections.injection')}</span>
      <div className={styles.entryFieldGroup}>
        <div className={styles.entryFieldRow}>
          <div className={styles.entryField}>
            <label className={styles.fieldLabel}>{t('fields.position')}</label>
            <select
              className={styles.entrySelect}
              value={entry.position}
              onChange={(e) => onImmediateUpdate(entry.id, { position: Number(e.target.value) })}
            >
              {positionOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {entry.position === 4 && (
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>{t('fields.depth')}</label>
              <NumberStepper
                value={entry.depth}
                min={0}
                onChange={(v) => onImmediateUpdate(entry.id, { depth: v ?? 0 })}
              />
            </div>
          )}
          <div className={styles.entryField}>
            <label className={styles.fieldLabel}>{t('fields.role')}</label>
            <select
              className={styles.entrySelect}
              value={entry.role || 'system'}
              onChange={(e) => onImmediateUpdate(entry.id, { role: e.target.value })}
            >
              {roleOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
            <label className={styles.fieldLabel}>{t('fields.order')}</label>
            <NumberStepper
              value={entry.order_value}
              onChange={(v) => onImmediateUpdate(entry.id, { order_value: v ?? 0 })}
            />
          </div>
        </div>
        {entry.position === 8 && !(entry.outlet_name || '').trim() && (
          <p className={styles.fieldHint}>{t('outletOnlyHint')}</p>
        )}
        {entry.position === 7 && (
          <div className={styles.entryFieldRow}>
            <div className={styles.entryField}>
              <label className={styles.fieldLabel}>{t('markerTarget')}</label>
              <select
                className={styles.entrySelect}
                value={wiMarker}
                onChange={handleWiMarkerChange}
              >
                <option value="">{t('markerTargetNone')}</option>
                {markerGroups.map((group) => (
                  <optgroup key={group.section} label={markerSectionLabel(group.section)}>
                    {group.items.map((marker) => (
                      <option key={marker} value={marker}>
                        {markerLabel(marker)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            {wiMarker && (
              <div className={styles.entryField}>
                <label className={styles.fieldLabel}>{t('markerSideLabel')}</label>
                <select
                  className={styles.entrySelect}
                  value={wiMarkerSide}
                  onChange={handleWiMarkerSideChange}
                >
                  <option value="before">{t('markerSideBefore')}</option>
                  <option value="after">{t('markerSideAfter')}</option>
                </select>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Activation */}
      <span className={styles.sectionHeading}>{t('sections.activation')}</span>
      <div className={styles.entryFieldGroup}>
        <div className={styles.toggleRow}>
          <Toggle.Checkbox
            checked={entry.selective}
            onChange={() => onImmediateUpdate(entry.id, { selective: !entry.selective })}
            label={t('toggles.selective')}
          />
          <Toggle.Checkbox
            checked={entry.constant}
            onChange={() => onImmediateUpdate(entry.id, { constant: !entry.constant })}
            label={t('toggles.constant')}
          />
          <Toggle.Checkbox
            checked={entry.disabled}
            onChange={() => onImmediateUpdate(entry.id, { disabled: !entry.disabled })}
            label={t('toggles.disabled')}
          />
          <Toggle.Checkbox
            checked={entry.case_sensitive}
            onChange={() => onImmediateUpdate(entry.id, { case_sensitive: !entry.case_sensitive })}
            label={t('toggles.caseSensitive')}
          />
          <Toggle.Checkbox
            checked={entry.match_whole_words}
            onChange={() => onImmediateUpdate(entry.id, { match_whole_words: !entry.match_whole_words })}
            label={t('toggles.matchWholeWords')}
          />
          <Toggle.Checkbox
            checked={entry.use_regex}
            onChange={() => onImmediateUpdate(entry.id, { use_regex: !entry.use_regex })}
            label={t('toggles.useRegex')}
          />
          <Toggle.Checkbox
            checked={entry.use_probability}
            onChange={() => onImmediateUpdate(entry.id, { use_probability: !entry.use_probability })}
            label={t('toggles.useProbability')}
          />
          <Toggle.Checkbox
            checked={entry.vectorized}
            onChange={() => onImmediateUpdate(entry.id, { vectorized: !entry.vectorized })}
            label={t('toggles.vectorized')}
          />
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
            <label className={styles.fieldLabel}>{t('fields.probability')}</label>
            <NumberStepper
              value={entry.probability}
              min={0}
              max={100}
              onChange={(v) => onImmediateUpdate(entry.id, { probability: v ?? 0 })}
            />
          </div>
          <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
            <label className={styles.fieldLabel}>{t('fields.scanDepth')}</label>
            <NumberStepper
              value={entry.scan_depth}
              min={0}
              allowEmpty
              onChange={(v) => onImmediateUpdate(entry.id, { scan_depth: v })}
            />
          </div>
          {entry.selective && (
            <div className={styles.entryField}>
              <label className={styles.fieldLabel}>{t('fields.selectiveLogic')}</label>
              <select
                className={styles.entrySelect}
                value={entry.selective_logic}
                onChange={(e) => onImmediateUpdate(entry.id, { selective_logic: Number(e.target.value) })}
              >
                {selectiveLogicOptions.map((opt) => (
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
        {t('sections.timing')}
      </button>
      {timingOpen && (
        <div className={styles.entryFieldGroup}>
          <div className={styles.entryFieldRow}>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>{t('fields.priority')}</label>
              <NumberStepper
                value={entry.priority}
                onChange={(v) => onImmediateUpdate(entry.id, { priority: v ?? 0 })}
              />
            </div>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>{t('fields.sticky')}</label>
              <NumberStepper
                value={entry.sticky}
                min={0}
                onChange={(v) => onImmediateUpdate(entry.id, { sticky: v ?? 0 })}
              />
            </div>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>{t('fields.cooldown')}</label>
              <NumberStepper
                value={entry.cooldown}
                min={0}
                onChange={(v) => onImmediateUpdate(entry.id, { cooldown: v ?? 0 })}
              />
            </div>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>{t('fields.delay')}</label>
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
        {t('sections.recursion')}{recursionInvalidated ? t('sections.recursionInactiveSuffix') : ''}
      </button>
      {recursionOpen && (
        <div className={styles.entryFieldGroup}>
          {recursionInvalidated && (
            <div className={styles.inactiveNote}>
              {t('recursionInactiveNote')}
            </div>
          )}
          <div className={styles.toggleRow}>
            <Toggle.Checkbox
              checked={entry.prevent_recursion}
              onChange={() => onImmediateUpdate(entry.id, { prevent_recursion: !entry.prevent_recursion })}
              label={t('toggles.preventRecursion')}
              disabled={recursionInvalidated}
            />
            <Toggle.Checkbox
              checked={entry.exclude_recursion}
              onChange={() => onImmediateUpdate(entry.id, { exclude_recursion: !entry.exclude_recursion })}
              label={t('toggles.excludeRecursion')}
              disabled={recursionInvalidated}
            />
            <Toggle.Checkbox
              checked={entry.delay_until_recursion}
              onChange={() => onImmediateUpdate(entry.id, { delay_until_recursion: !entry.delay_until_recursion })}
              label={t('toggles.delayUntilRecursion')}
              disabled={recursionInvalidated}
            />
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
        {t('sections.group')}
      </button>
      {groupOpen && (
        <div className={styles.entryFieldGroup}>
          <div className={styles.entryFieldRow}>
            <div className={styles.entryField}>
              <label className={styles.fieldLabel}>{t('fields.groupName')}</label>
              <input
                type="text"
                className={styles.entryInput}
                value={entry.group_name}
                onChange={(e) => onUpdate(entry.id, { group_name: e.target.value })}
              />
            </div>
            <div className={clsx(styles.entryField, styles.entryFieldSmall)}>
              <label className={styles.fieldLabel}>{t('fields.weight')}</label>
              <NumberStepper
                value={entry.group_weight}
                onChange={(v) => onImmediateUpdate(entry.id, { group_weight: v ?? 0 })}
              />
            </div>
          </div>
          <Toggle.Checkbox
            checked={entry.group_override}
            onChange={() => onImmediateUpdate(entry.id, { group_override: !entry.group_override })}
            label={t('toggles.groupOverride')}
          />
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
        {t('sections.metadata')}
      </button>
      {metadataOpen && (
        <div className={styles.entryFieldGroup}>
          <div className={styles.entryField}>
            <label className={styles.fieldLabel}>{t('fields.uid')}</label>
            <span className={styles.readOnlyValue}>{entry.uid}</span>
          </div>
          <div className={styles.entryField}>
            <label className={styles.fieldLabel}>{t('fields.automationId')}</label>
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

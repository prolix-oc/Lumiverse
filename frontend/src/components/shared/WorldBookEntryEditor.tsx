import { useState, useEffect, useRef, useCallback, useId, type ReactNode } from 'react'
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

export interface EntryEditorConflictState {
  kind: 'conflict' | 'malformed-precondition'
  current?: WorldBookEntry | null
  message?: string
}

export interface EntryEditorProps {
  density?: 'default' | 'compact'
  entry: WorldBookEntry
  onUpdate: (id: string, updates: Record<string, any>) => void
  onImmediateUpdate: (id: string, updates: Record<string, any>) => void
  conflict?: EntryEditorConflictState | null
  onRetryConflict?: () => void
  onUseServerConflict?: () => void
}

interface DisclosureSectionProps {
  id: string
  label: string
  summary?: string
  open: boolean
  onToggle: () => void
  trailing?: ReactNode
  collapsible?: boolean
  children: ReactNode
}

function DisclosureSection({ id, label, summary, open, onToggle, trailing, collapsible = true, children }: DisclosureSectionProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const triggerId = `${id}-trigger`

  const handleToggle = () => {
    const restoreFocus = open && panelRef.current?.contains(document.activeElement)
    onToggle()
    if (restoreFocus) triggerRef.current?.focus()
  }

  if (!collapsible) {
    return (
      <>
        <span className={styles.sectionHeading}>{label}</span>
        {children}
      </>
    )
  }

  return (
    <section className={styles.disclosureSection} data-entry-disclosure={id}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={styles.groupToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={handleToggle}
      >
        <ChevronRight
          size={12}
          className={clsx(styles.groupToggleIcon, open && styles.groupToggleOpen)}
        />
        <span className={styles.groupToggleLabel}>{label}</span>
        {summary && <span className={styles.groupToggleSummary}>{summary}</span>}
        {trailing}
      </button>
      <div
        ref={panelRef}
        id={id}
        className={styles.disclosurePanel}
        role="group"
        aria-labelledby={triggerId}
        hidden={!open}
      >
        {children}
      </div>
    </section>
  )
}

export default function WorldBookEntryEditor({ entry, density = 'default', onUpdate, onImmediateUpdate, conflict, onRetryConflict, onUseServerConflict }: EntryEditorProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entryEditor' })
  const { positionOptions, roleOptions, selectiveLogicOptions } = useWorldBookEntryLabels()
  const { addableMarkers, markerLabel, markerSectionLabel } = useLoomOptionLabels()

  const [injectionOpen, setInjectionOpen] = useState(density !== 'compact')
  const [activationOpen, setActivationOpen] = useState(density !== 'compact')
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
  const [groupName, setGroupName] = useState(entry.group_name)
  const [automationId, setAutomationId] = useState(entry.automation_id || '')
  const disclosureId = useId()
  const lastSyncedId = useRef<string | null>(null)
  const dirtyFields = useRef<Set<string>>(new Set())

  const markDirty = useCallback((field: string) => {
    dirtyFields.current.add(field)
  }, [])

  const applyServerEntry = useCallback((serverEntry: WorldBookEntry) => {
    dirtyFields.current.clear()
    setContent(serverEntry.content)
    setComment(serverEntry.comment)
    setOutletName(serverEntry.outlet_name || '')
    setWiMarker(serverEntry.wi_marker || '')
    setWiMarkerSide(serverEntry.wi_marker_side || 'after')
    setPrimaryKeys(serverEntry.key.join(', '))
    setSecondaryKeys(serverEntry.keysecondary.join(', '))
    setGroupName(serverEntry.group_name)
    setAutomationId(serverEntry.automation_id || '')
  }, [])

  const handleUseServerConflict = useCallback(() => {
    if (conflict?.current) applyServerEntry(conflict.current)
    onUseServerConflict?.()
  }, [applyServerEntry, conflict, onUseServerConflict])

  useEffect(() => {
    if (lastSyncedId.current !== entry.id) {
      lastSyncedId.current = entry.id
      dirtyFields.current.clear()
      setContent(entry.content)
      setComment(entry.comment)
      setOutletName(entry.outlet_name || '')
      setWiMarker(entry.wi_marker || '')
      setWiMarkerSide(entry.wi_marker_side || 'after')
      setPrimaryKeys(entry.key.join(', '))
      setSecondaryKeys(entry.keysecondary.join(', '))
      setGroupName(entry.group_name)
      setAutomationId(entry.automation_id || '')
      return
    }
    if (!dirtyFields.current.has('content')) setContent(entry.content)
    if (!dirtyFields.current.has('comment')) setComment(entry.comment)
    if (!dirtyFields.current.has('outlet_name')) setOutletName(entry.outlet_name || '')
    if (!dirtyFields.current.has('wi_marker')) setWiMarker(entry.wi_marker || '')
    if (!dirtyFields.current.has('wi_marker_side')) setWiMarkerSide(entry.wi_marker_side || 'after')
    if (!dirtyFields.current.has('key')) setPrimaryKeys(entry.key.join(', '))
    if (!dirtyFields.current.has('keysecondary')) setSecondaryKeys(entry.keysecondary.join(', '))
    if (!dirtyFields.current.has('group_name')) setGroupName(entry.group_name)
    if (!dirtyFields.current.has('automation_id')) setAutomationId(entry.automation_id || '')
  }, [entry])

  const handleContentChange = useCallback(
    (v: string) => {
      markDirty('content')
      setContent(v)
      onUpdate(entry.id, { content: v })
    },
    [entry.id, markDirty, onUpdate]
  )

  const handleCommentChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      markDirty('comment')
      setComment(e.target.value)
      onUpdate(entry.id, { comment: e.target.value })
    },
    [entry.id, markDirty, onUpdate]
  )

  const handleOutletNameChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const nextValue = e.target.value
      markDirty('outlet_name')
      setOutletName(nextValue)
      onUpdate(entry.id, { outlet_name: nextValue || null })
    },
    [entry.id, markDirty, onUpdate]
  )
  const handleWiMarkerChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value
      markDirty('wi_marker')
      setWiMarker(value)
      onImmediateUpdate(entry.id, { wi_marker: value || null })
    },
    [entry.id, markDirty, onImmediateUpdate]
  )

  const handleWiMarkerSideChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = e.target.value as 'before' | 'after'
      markDirty('wi_marker_side')
      setWiMarkerSide(value)
      onImmediateUpdate(entry.id, { wi_marker_side: value })
    },
    [entry.id, markDirty, onImmediateUpdate]
  )

  const handlePrimaryKeysChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      markDirty('key')
      setPrimaryKeys(e.target.value)
      onUpdate(entry.id, { key: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })
    },
    [entry.id, markDirty, onUpdate]
  )

  const handleSecondaryKeysChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      markDirty('keysecondary')
      setSecondaryKeys(e.target.value)
      onUpdate(entry.id, { keysecondary: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })
    },
    [entry.id, markDirty, onUpdate]
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
  const positionLabel = positionOptions.find((option) => option.value === entry.position)?.label ?? String(entry.position)
  const roleLabel = roleOptions.find((option) => option.value === (entry.role || 'system'))?.label ?? (entry.role || 'system')
  const injectionSummary = [
    positionLabel,
    entry.position === 4 ? `${t('fields.depth')}: ${entry.depth}` : null,
    entry.position === 7 && wiMarker ? `${t('markerTarget')}: ${markerLabel(wiMarker)}` : null,
    entry.position === 7 && wiMarker
      ? `${t('markerSideLabel')}: ${wiMarkerSide === 'before' ? t('markerSideBefore') : t('markerSideAfter')}`
      : null,
    roleLabel,
    `${t('fields.order')}: ${entry.order_value}`,
  ].filter((value): value is string => Boolean(value)).join(', ')
  const activationSummary = [
    entry.selective && t('toggles.selective'),
    entry.constant && t('toggles.constant'),
    entry.disabled && t('toggles.disabled'),
    entry.case_sensitive && t('toggles.caseSensitive'),
    entry.match_whole_words && t('toggles.matchWholeWords'),
    entry.use_regex && t('toggles.useRegex'),
    entry.use_probability && t('toggles.useProbability'),
    entry.vectorized && t('toggles.vectorized'),
  ].filter((value): value is string => Boolean(value)).join(', ')

  return (
    <div
      className={clsx(styles.entryEditor, density === 'compact' && styles.compactEntryEditor)}
      data-world-book-entry-editor="true"
      data-density={density}
      data-editor-scroll-owner={density === 'compact' ? 'true' : undefined}
    >
      <span data-spindle-mount="world_book_entry_editor" data-spindle-scope={`world-book-entry:${entry.id}:editor`} style={{ display: 'contents' }} />
      {conflict && (
        <div className={styles.entryFieldGroup} role="alert" data-entry-conflict={conflict.kind}>
          <strong>{conflict.kind === 'conflict' ? 'Entry changed on the server' : 'Invalid revision precondition'}</strong>
          {conflict.message && <span>{conflict.message}</span>}
          {conflict.kind === 'conflict' && (
            <div>
              <button type="button" onClick={onRetryConflict}>Retry with server revision</button>
              <button type="button" onClick={handleUseServerConflict}>Use server version</button>
            </div>
          )}
        </div>
      )}
      {/* Identity & Content */}
      <section className={styles.identityContentSection} data-world-book-identity-content="true">
        <span className={styles.sectionHeading}>{t('sections.identity')}</span>
        <div className={styles.identityFields}>
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
        </div>
        <div className={clsx(styles.entryField, styles.contentField)} data-content-flex-region="true">
          <div className={styles.fieldLabelRow}>
            <label className={styles.fieldLabel}>{t('fields.content')}</label>
            <TokenCountButton text={content} entryId={entry.id} extensions={entry.extensions} />
          </div>
          <ExpandableTextarea
            className={styles.entryTextarea}
            value={content}
            onChange={handleContentChange}
            title={comment || t('entryContentTitle')}
            rows={4}
          />
        </div>
      </section>

      {/* Injection */}
      <DisclosureSection
        id={`${disclosureId}-injection`}
        label={t('sections.injection')}
        summary={injectionSummary}
        open={injectionOpen}
        onToggle={() => setInjectionOpen((open) => !open)}
        collapsible={density === 'compact'}
      >
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
      </DisclosureSection>

      {/* Activation */}
      <DisclosureSection
        id={`${disclosureId}-activation`}
        label={t('sections.activation')}
        summary={activationSummary}
        open={activationOpen}
        onToggle={() => setActivationOpen((open) => !open)}
        collapsible={density === 'compact'}
        trailing={
          <span className={clsx(styles.vectorStatusBadge, styles.vectorStatusTrigger, vectorStatusClass)}>
            {getVectorIndexStatusLabel(entry.vector_index_status)}
          </span>
        }
      >
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
      </DisclosureSection>

      {/* Timing (collapsible) */}
      <DisclosureSection
        id={`${disclosureId}-timing`}
        label={t('sections.timing')}
        open={timingOpen}
        onToggle={() => setTimingOpen((open) => !open)}
      >
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
      </DisclosureSection>

      {/* Recursion (collapsible) */}
      <DisclosureSection
        id={`${disclosureId}-recursion`}
        label={`${t('sections.recursion')}${recursionInvalidated ? t('sections.recursionInactiveSuffix') : ''}`}
        open={recursionOpen}
        onToggle={() => setRecursionOpen((open) => !open)}
      >
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
      </DisclosureSection>

      {/* Group (collapsible) */}
      <DisclosureSection
        id={`${disclosureId}-group`}
        label={t('sections.group')}
        open={groupOpen}
        onToggle={() => setGroupOpen((open) => !open)}
      >
        <div className={styles.entryFieldGroup}>
          <div className={styles.entryFieldRow}>
            <div className={styles.entryField}>
              <label className={styles.fieldLabel}>{t('fields.groupName')}</label>
              <input
                type="text"
                className={styles.entryInput}
                value={groupName}
                onChange={(e) => {
                  markDirty('group_name')
                  setGroupName(e.target.value)
                  onUpdate(entry.id, { group_name: e.target.value })
                }}
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
      </DisclosureSection>

      {/* Metadata (collapsible) */}
      <DisclosureSection
        id={`${disclosureId}-metadata`}
        label={t('sections.metadata')}
        open={metadataOpen}
        onToggle={() => setMetadataOpen((open) => !open)}
      >
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
              value={automationId}
              onChange={(e) => {
                markDirty('automation_id')
                setAutomationId(e.target.value)
                onUpdate(entry.id, { automation_id: e.target.value || null })
              }}
            />
          </div>
        </div>
      </DisclosureSection>
      <span data-spindle-mount="world_book_entry_toolbar" data-spindle-scope={`world-book-entry:${entry.id}:toolbar`} style={{ display: 'contents' }} />
    </div>
  )
}

import { useState, useCallback, type ReactNode } from 'react'
import { Layers, Hand, Filter, Info, Edit2, Check, X } from 'lucide-react'
import { useStore } from '@/store'
import { EditorSection } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import type { SovereignHandSettings, ContextFilters } from '@/types/store'
import clsx from 'clsx'
import styles from './PromptPanel.module.css'

/* ── Local sub-components ── */

function Toggle({
  id,
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <div className={clsx(styles.toggleRow, disabled && styles.toggleRowDisabled)}>
      <div className={styles.toggleLabel}>
        <span className={styles.toggleText}>{label}</span>
        {hint && <span className={styles.toggleHint}>{hint}</span>}
      </div>
      <label className={styles.toggleSwitch}>
        <input
          type="checkbox"
          id={id}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
        />
        <div className={clsx(styles.toggleTrack, checked && styles.toggleTrackOn)}>
          <div className={styles.toggleThumb} />
        </div>
      </label>
    </div>
  )
}

function Collapsible({ isOpen, children, className }: { isOpen: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={clsx(styles.collapsible, isOpen && styles.collapsibleOpen, className)}>
      <div className={styles.collapsibleInner}>{children}</div>
    </div>
  )
}

function InfoBox({ items, muted = false }: { items: ReactNode[]; muted?: boolean }) {
  return (
    <div className={clsx(styles.infoBox, muted && styles.infoBoxMuted)}>
      <div className={styles.infoBoxHeader}>
        <Info size={14} strokeWidth={2} />
        <span>When enabled:</span>
      </div>
      <ul className={styles.infoBoxList}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function FilterItem({
  id,
  label,
  hint,
  enabled,
  onToggle,
  depthValue,
  onDepthChange,
  depthLabel,
}: {
  id: string
  label: string
  hint: string
  enabled: boolean
  onToggle: (v: boolean) => void
  depthValue: number
  onDepthChange: (v: number | null) => void
  depthLabel?: string
}) {
  return (
    <div className={styles.filterItem}>
      <Toggle id={id} checked={enabled} onChange={onToggle} label={label} hint={hint} />
      <Collapsible isOpen={enabled}>
        <div className={styles.filterDepthRow}>
          <span className={styles.filterDepthLabel}>{depthLabel || 'Keep in last N messages'}</span>
          <div className={styles.filterDepthInput}>
            <NumberStepper value={depthValue} onChange={(v) => onDepthChange(v ?? 1)} min={1} max={100} step={1} />
          </div>
        </div>
      </Collapsible>
    </div>
  )
}

function FilterKeepOnlyToggle({
  id,
  checked,
  onChange,
  label,
  hint,
}: {
  id: string
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint: string
}) {
  return (
    <div className={styles.filterModeBlock}>
      <Toggle id={id} checked={checked} onChange={onChange} label={label} hint={hint} />
    </div>
  )
}

/* ── Main Panel ── */

export default function PromptPanel() {
  const chimeraMode = useStore((s) => s.chimeraMode)
  const councilSettings = useStore((s) => s.councilSettings)
  const lumiaQuirks = useStore((s) => s.lumiaQuirks)
  const lumiaQuirksEnabled = useStore((s) => s.lumiaQuirksEnabled)
  const sovereignHand = useStore((s) => s.sovereignHand)
  const contextFilters = useStore((s) => s.contextFilters)
  const selectedDefinition = useStore((s) => s.selectedDefinition)
  const setSetting = useStore((s) => s.setSetting)
  const saveCouncilSettings = useStore((s) => s.saveCouncilSettings)

  const councilMode = councilSettings.councilMode
  const councilMembersCount = councilSettings.members.length

  // Quirks editing state
  const [quirksValue, setQuirksValue] = useState(lumiaQuirks)
  const [isEditingQuirks, setIsEditingQuirks] = useState(false)

  // Handlers
  const handleChimeraModeChange = useCallback(
    (enabled: boolean) => setSetting('chimeraMode', enabled),
    [setSetting]
  )

  const handleCouncilModeChange = useCallback(
    (enabled: boolean) => {
      saveCouncilSettings({ councilMode: enabled })
    },
    [saveCouncilSettings]
  )

  const handleQuirksSave = useCallback(() => {
    setSetting('lumiaQuirks', quirksValue)
    setIsEditingQuirks(false)
  }, [setSetting, quirksValue])

  const handleQuirksCancel = useCallback(() => {
    setQuirksValue(lumiaQuirks)
    setIsEditingQuirks(false)
  }, [lumiaQuirks])

  const handleQuirksEnabledChange = useCallback(
    (enabled: boolean) => setSetting('lumiaQuirksEnabled', enabled),
    [setSetting]
  )

  const updateSovereignHand = useCallback(
    (patch: Partial<SovereignHandSettings>) => {
      setSetting('sovereignHand', { ...sovereignHand, ...patch })
    },
    [setSetting, sovereignHand]
  )

  const updateContextFilter = useCallback(
    (filterType: keyof ContextFilters, key: string, value: any) => {
      setSetting('contextFilters', {
        ...contextFilters,
        [filterType]: {
          ...contextFilters[filterType],
          [key]: value,
        },
      })
    },
    [setSetting, contextFilters]
  )

  const sovereignEnabled = sovereignHand.enabled
  const filtersActive =
    contextFilters.htmlTags.enabled ||
    contextFilters.detailsBlocks.enabled ||
    contextFilters.loomItems.enabled

  const definitionCount = selectedDefinition ? 1 : 0

  return (
    <div className={styles.panel}>
      {/* ── Lumia Modes ── */}
      <EditorSection Icon={Layers} title="Lumia Modes" defaultExpanded>
        <p className={styles.desc}>
          Configure special Lumia modes for unique character setups. These modes are mutually exclusive.
        </p>

        {/* Chimera Mode */}
        <div className={styles.modeOption}>
          <Toggle
            id="chimera-mode"
            checked={chimeraMode}
            onChange={handleChimeraModeChange}
            label="Chimera Mode"
            hint="Fuse multiple physical definitions into one hybrid form"
          />
          <Collapsible isOpen={chimeraMode}>
            <InfoBox
              items={[
                'Select multiple definitions in the Definition modal',
                'All selected forms will be fused into one Chimera',
                `Currently ${definitionCount} definition${definitionCount !== 1 ? 's' : ''} selected`,
              ]}
            />
          </Collapsible>
        </div>

        {/* Council Mode */}
        <div className={styles.modeOption}>
          <Toggle
            id="council-mode"
            checked={councilMode}
            onChange={handleCouncilModeChange}
            label="Council Mode"
            hint="Multiple independent Lumias that collaborate"
          />
          <Collapsible isOpen={councilMode}>
            <InfoBox
              items={[
                'Each council member has independent traits',
                'Members can converse and collaborate',
                `Currently ${councilMembersCount} council member${councilMembersCount !== 1 ? 's' : ''}`,
              ]}
            />
            <p className={styles.modeNote}>Configure council members in the Council tab.</p>
          </Collapsible>
        </div>

        {/* Behavioral Quirks */}
        <div className={clsx(styles.quirksSection, !lumiaQuirksEnabled && styles.quirksSectionDisabled)}>
          <div className={styles.quirksHeader}>
            <div className={styles.quirksHeaderLeft}>
              <span className={styles.quirksLabel}>Behavioral Quirks</span>
              <Toggle
                id="quirks-toggle"
                checked={lumiaQuirksEnabled}
                onChange={handleQuirksEnabledChange}
                label=""
              />
            </div>
            {!isEditingQuirks && lumiaQuirksEnabled && (
              <button
                type="button"
                className={styles.quirksEditBtn}
                onClick={() => {
                  setQuirksValue(lumiaQuirks)
                  setIsEditingQuirks(true)
                }}
                title="Edit quirks"
              >
                <Edit2 size={12} strokeWidth={1.5} />
              </button>
            )}
          </div>
          <p className={styles.quirksHint}>
            Extra behavioral modifications. Use <code>{'{{lumiaQuirks}}'}</code>
          </p>

          {isEditingQuirks && lumiaQuirksEnabled ? (
            <div className={styles.quirksEdit}>
              <textarea
                className={styles.quirksTextarea}
                placeholder="Enter behavioral quirks..."
                value={quirksValue}
                onChange={(e) => setQuirksValue(e.target.value)}
                rows={3}
              />
              <div className={styles.quirksActions}>
                <button
                  type="button"
                  className={clsx(styles.quirksBtn, styles.quirksBtnPrimary)}
                  onClick={handleQuirksSave}
                >
                  <Check size={12} strokeWidth={2} /> Save
                </button>
                <button type="button" className={styles.quirksBtn} onClick={handleQuirksCancel}>
                  <X size={12} strokeWidth={2} /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.quirksPreview}>
              {lumiaQuirks?.trim() ? (
                <span>{lumiaQuirks}</span>
              ) : (
                <span className={styles.quirksEmpty}>No quirks set</span>
              )}
            </div>
          )}
        </div>
      </EditorSection>

      {/* ── Sovereign Hand ── */}
      <EditorSection Icon={Hand} title="Sovereign Hand" defaultExpanded={false}>
        <p className={styles.desc}>
          Enable Sovereign Hand integration to use advanced prompt manipulation features.
        </p>
        <Toggle
          id="sovereign-hand"
          checked={sovereignEnabled}
          onChange={(v) => updateSovereignHand({ enabled: v })}
          label="Use Sovereign Hand Features"
          hint="Enables Sovereign Hand macros for advanced prompt control"
        />
        <Toggle
          id="sovereign-exclude"
          checked={sovereignHand.excludeLastMessage}
          onChange={(v) => updateSovereignHand({ excludeLastMessage: v })}
          label="Exclude Last Message from Context"
          hint="When enabled, removes the last user message from the outgoing context"
          disabled={!sovereignEnabled}
        />
        <Toggle
          id="sovereign-include"
          checked={sovereignHand.includeMessageInPrompt}
          onChange={(v) => updateSovereignHand({ includeMessageInPrompt: v })}
          label="Include Message in Master Prompt"
          hint="When enabled, includes the user message in the {{loomSovHand}} macro output"
          disabled={!sovereignEnabled}
        />
        <InfoBox
          muted={!sovereignEnabled}
          items={[
            <><code>{'{{loomLastUserMessage}}'}</code> returns the last user message</>,
            <><code>{'{{loomLastCharMessage}}'}</code> returns the last character message</>,
            <><code>{'{{lastMessageName}}'}</code> returns the name of whoever sent the last message</>,
            <><code>{'{{loomContinuePrompt}}'}</code> adds continuation instructions when character spoke last</>,
          ]}
        />
      </EditorSection>

      {/* ── Context Filters ── */}
      <EditorSection Icon={Filter} title="Context Filters" defaultExpanded={false}>
        <p className={styles.desc}>
          Filter out specific content from the chat context before sending to the AI.
        </p>

        {/* HTML Tags */}
        <FilterItem
          id="filter-html"
          label="Strip HTML Tags"
          hint="Removes formatting tags: <div>, <span>, <b>, <i>, etc."
          enabled={contextFilters.htmlTags.enabled}
          onToggle={(v) => updateContextFilter('htmlTags', 'enabled', v)}
          depthValue={contextFilters.htmlTags.keepDepth}
          onDepthChange={(v) => updateContextFilter('htmlTags', 'keepDepth', v)}
          depthLabel="Keep HTML in last N messages"
        />

        {/* Strip Fonts sub-option */}
        <Collapsible isOpen={contextFilters.htmlTags.enabled}>
          <div className={styles.filterSub}>
            <FilterItem
              id="filter-fonts"
              label="Also Strip Fonts"
              hint="Remove <font> tags (used by some presets)"
              enabled={contextFilters.htmlTags.stripFonts}
              onToggle={(v) => updateContextFilter('htmlTags', 'stripFonts', v)}
              depthValue={contextFilters.htmlTags.fontKeepDepth}
              onDepthChange={(v) => updateContextFilter('htmlTags', 'fontKeepDepth', v)}
              depthLabel="Keep fonts in last N messages"
            />
          </div>
        </Collapsible>

        {/* Details Blocks */}
        <FilterItem
          id="filter-details"
          label="Filter Details Blocks"
          hint="Removes <details> blocks from older messages"
          enabled={contextFilters.detailsBlocks.enabled}
          onToggle={(v) => updateContextFilter('detailsBlocks', 'enabled', v)}
          depthValue={contextFilters.detailsBlocks.keepDepth}
          onDepthChange={(v) => updateContextFilter('detailsBlocks', 'keepDepth', v)}
        />
        <Collapsible isOpen={contextFilters.detailsBlocks.enabled}>
          <div className={styles.filterSub}>
            <FilterKeepOnlyToggle
              id="filter-details-keep-only"
              checked={contextFilters.detailsBlocks.keepOnly ?? false}
              onChange={(v) => updateContextFilter('detailsBlocks', 'keepOnly', v)}
              label="Keep Only Details Content"
              hint="Past the keep depth, discard everything except content inside <details> blocks"
            />
          </div>
        </Collapsible>

        {/* Loom Tags */}
        <FilterItem
          id="filter-loom"
          label="Filter Loom Tags"
          hint="Removes Lucid Loom-related tags from older messages"
          enabled={contextFilters.loomItems.enabled}
          onToggle={(v) => updateContextFilter('loomItems', 'enabled', v)}
          depthValue={contextFilters.loomItems.keepDepth}
          onDepthChange={(v) => updateContextFilter('loomItems', 'keepDepth', v)}
          depthLabel="Keep Loom tags in last N messages"
        />
        <Collapsible isOpen={contextFilters.loomItems.enabled}>
          <div className={styles.filterSub}>
            <FilterKeepOnlyToggle
              id="filter-loom-keep-only"
              checked={contextFilters.loomItems.keepOnly ?? false}
              onChange={(v) => updateContextFilter('loomItems', 'keepOnly', v)}
              label="Keep Only Loom Content"
              hint="Past the keep depth, discard everything except content inside Loom-related tags"
            />
          </div>
        </Collapsible>
      </EditorSection>
    </div>
  )
}

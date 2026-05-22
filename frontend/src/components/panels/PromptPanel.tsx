import { useState, useCallback, type ReactNode } from 'react'
import { Hand, Filter, Info, ChevronRight } from 'lucide-react'
import { IconScript, IconTool, IconTransform } from '@tabler/icons-react'
import { useStore } from '@/store'
import { EditorSection } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import { Toggle } from '@/components/shared/Toggle'
import LoomSelector from '@/components/modals/LoomSelector'
import type { SovereignHandSettings, ContextFilters } from '@/types/store'
import type { LoomItemCategory } from '@/types/api'
import clsx from 'clsx'
import styles from './PromptPanel.module.css'

/* ── Local sub-components ── */

function ToggleRow({
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
      <Toggle.Switch checked={checked} onChange={onChange} disabled={disabled} />
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
      <ToggleRow id={id} checked={enabled} onChange={onToggle} label={label} hint={hint} />
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

function SelectionBtn({
  icon: Icon,
  label,
  count,
  onClick,
  disabled = false,
}: {
  icon: any
  label: string
  count: number
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={clsx(styles.selectionBtn, disabled && styles.selectionBtnDisabled)}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={14} className={styles.selectionBtnIcon} />
      <span className={styles.selectionBtnLabel}>{label}</span>
      {count > 0 && <span className={styles.selectionBtnBadge}>{count}</span>}
      <ChevronRight size={14} className={styles.selectionBtnChevron} />
    </button>
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
      <ToggleRow id={id} checked={checked} onChange={onChange} label={label} hint={hint} />
    </div>
  )
}

export default function PromptPanel() {
  const sovereignHand = useStore((s) => s.sovereignHand)
  const contextFilters = useStore((s) => s.contextFilters)
  const selectedLoomStyles = useStore((s) => s.selectedLoomStyles)
  const selectedLoomUtils = useStore((s) => s.selectedLoomUtils)
  const selectedLoomRetrofits = useStore((s) => s.selectedLoomRetrofits)
  const setSetting = useStore((s) => s.setSetting)

  // Modal state
  const [loomModal, setLoomModal] = useState<LoomItemCategory | null>(null)

  // Handlers
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
  const styleCount = selectedLoomStyles.length
  const utilCount = selectedLoomUtils.length
  const retrofitCount = selectedLoomRetrofits.length

  return (
    <div className={styles.panel}>
      {/* ── Loom Content ── */}
      <EditorSection Icon={IconScript} title="Loom Content" defaultExpanded={false}>
        <p className={styles.desc}>
          Select narrative styles, utilities, and retrofits from your loaded packs. These are injected
          via <code>{'{{loomStyle}}'}</code>, <code>{'{{loomUtils}}'}</code>, and <code>{'{{loomRetrofits}}'}</code> macros.
        </p>

        <div className={styles.selectionGroup}>
          <SelectionBtn
            icon={IconScript}
            label="Narrative Styles"
            count={styleCount}
            onClick={() => setLoomModal('narrative_style')}
          />
          <SelectionBtn
            icon={IconTool}
            label="Loom Utilities"
            count={utilCount}
            onClick={() => setLoomModal('loom_utility')}
          />
          <SelectionBtn
            icon={IconTransform}
            label="Retrofits"
            count={retrofitCount}
            onClick={() => setLoomModal('retrofit')}
          />
        </div>
      </EditorSection>

      {/* ── Sovereign Hand ── */}
      <EditorSection Icon={Hand} title="Sovereign Hand" defaultExpanded={false}>
        <p className={styles.desc}>
          Enable Sovereign Hand integration to use advanced prompt manipulation features.
        </p>
        <ToggleRow
          id="sovereign-hand"
          checked={sovereignEnabled}
          onChange={(v) => updateSovereignHand({ enabled: v })}
          label="Use Sovereign Hand Features"
          hint="Enables Sovereign Hand macros for advanced prompt control"
        />
        <ToggleRow
          id="sovereign-exclude"
          checked={sovereignHand.excludeLastMessage}
          onChange={(v) => updateSovereignHand({ excludeLastMessage: v })}
          label="Exclude Last Message from Context"
          hint="When enabled, removes the last user message from the outgoing context"
          disabled={!sovereignEnabled}
        />
        <ToggleRow
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

      {loomModal && (
        <LoomSelector category={loomModal} onClose={() => setLoomModal(null)} />
      )}
    </div>
  )
}

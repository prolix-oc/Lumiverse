import { useState, useCallback, type ReactNode } from 'react'
import { Hand, Filter, Info, ChevronRight } from 'lucide-react'
import { IconScript, IconTool, IconTransform } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('panels')
  return (
    <div className={clsx(styles.infoBox, muted && styles.infoBoxMuted)}>
      <div className={styles.infoBoxHeader}>
        <Info size={14} strokeWidth={2} />
        <span>{t('promptPanel.whenEnabled')}</span>
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
  const { t } = useTranslation('panels')
  return (
    <div className={styles.filterItem}>
      <ToggleRow id={id} checked={enabled} onChange={onToggle} label={label} hint={hint} />
      <Collapsible isOpen={enabled}>
        <div className={styles.filterDepthRow}>
          <span className={styles.filterDepthLabel}>{depthLabel || t('promptPanel.keepInLastN')}</span>
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
  const { t } = useTranslation('panels')
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
      <EditorSection Icon={IconScript} title={t('promptPanel.loomContentTitle')} defaultExpanded={false}>
        <p className={styles.desc}>
          {t('promptPanel.loomContentDescPrefix')}{' '}
          <code>{'{{loomStyle}}'}</code>, <code>{'{{loomUtils}}'}</code>, {t('promptPanel.and')}{' '}
          <code>{'{{loomRetrofits}}'}</code> {t('promptPanel.loomContentDescSuffix')}
        </p>

        <div className={styles.selectionGroup}>
          <SelectionBtn
            icon={IconScript}
            label={t('promptPanel.narrativeStyles')}
            count={styleCount}
            onClick={() => setLoomModal('narrative_style')}
          />
          <SelectionBtn
            icon={IconTool}
            label={t('promptPanel.loomUtilities')}
            count={utilCount}
            onClick={() => setLoomModal('loom_utility')}
          />
          <SelectionBtn
            icon={IconTransform}
            label={t('promptPanel.retrofits')}
            count={retrofitCount}
            onClick={() => setLoomModal('retrofit')}
          />
        </div>
      </EditorSection>

      {/* ── Sovereign Hand ── */}
      <EditorSection Icon={Hand} title={t('promptPanel.sovereignHandTitle')} defaultExpanded={false}>
        <p className={styles.desc}>
          {t('promptPanel.sovereignHandDesc')}
        </p>
        <ToggleRow
          id="sovereign-hand"
          checked={sovereignEnabled}
          onChange={(v) => updateSovereignHand({ enabled: v })}
          label={t('promptPanel.useSovereignHand')}
          hint={t('promptPanel.useSovereignHandHint')}
        />
        <ToggleRow
          id="sovereign-exclude"
          checked={sovereignHand.excludeLastMessage}
          onChange={(v) => updateSovereignHand({ excludeLastMessage: v })}
          label={t('promptPanel.excludeLastMessage')}
          hint={t('promptPanel.excludeLastMessageHint')}
          disabled={!sovereignEnabled}
        />
        <ToggleRow
          id="sovereign-include"
          checked={sovereignHand.includeMessageInPrompt}
          onChange={(v) => updateSovereignHand({ includeMessageInPrompt: v })}
          label={t('promptPanel.includeMessageInMasterPrompt')}
          hint={t('promptPanel.includeMessageInMasterPromptHint')}
          disabled={!sovereignEnabled}
        />
        <InfoBox
          muted={!sovereignEnabled}
          items={[
            <><code>{'{{loomLastUserMessage}}'}</code> {t('promptPanel.loomLastUserMessage')}</>,
            <><code>{'{{loomLastCharMessage}}'}</code> {t('promptPanel.loomLastCharMessage')}</>,
            <><code>{'{{lastMessageName}}'}</code> {t('promptPanel.lastMessageName')}</>,
            <><code>{'{{loomContinuePrompt}}'}</code> {t('promptPanel.loomContinuePrompt')}</>,
          ]}
        />
      </EditorSection>

      {/* ── Context Filters ── */}
      <EditorSection Icon={Filter} title={t('promptPanel.contextFiltersTitle')} defaultExpanded={false}>
        <p className={styles.desc}>
          {t('promptPanel.contextFiltersDesc')}
        </p>

        {/* HTML Tags */}
        <FilterItem
          id="filter-html"
          label={t('promptPanel.stripHtmlTags')}
          hint={t('promptPanel.stripHtmlTagsHint')}
          enabled={contextFilters.htmlTags.enabled}
          onToggle={(v) => updateContextFilter('htmlTags', 'enabled', v)}
          depthValue={contextFilters.htmlTags.keepDepth}
          onDepthChange={(v) => updateContextFilter('htmlTags', 'keepDepth', v)}
          depthLabel={t('promptPanel.keepHtmlDepth')}
        />

        {/* Strip Fonts sub-option */}
        <Collapsible isOpen={contextFilters.htmlTags.enabled}>
          <div className={styles.filterSub}>
            <FilterItem
              id="filter-fonts"
              label={t('promptPanel.alsoStripFonts')}
              hint={t('promptPanel.alsoStripFontsHint')}
              enabled={contextFilters.htmlTags.stripFonts}
              onToggle={(v) => updateContextFilter('htmlTags', 'stripFonts', v)}
              depthValue={contextFilters.htmlTags.fontKeepDepth}
              onDepthChange={(v) => updateContextFilter('htmlTags', 'fontKeepDepth', v)}
              depthLabel={t('promptPanel.keepFontsDepth')}
            />
          </div>
        </Collapsible>

        {/* Details Blocks */}
        <FilterItem
          id="filter-details"
          label={t('promptPanel.filterDetailsBlocks')}
          hint={t('promptPanel.filterDetailsBlocksHint')}
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
              label={t('promptPanel.keepOnlyDetailsContent')}
              hint={t('promptPanel.keepOnlyDetailsContentHint')}
            />
          </div>
        </Collapsible>

        {/* Loom Tags */}
        <FilterItem
          id="filter-loom"
          label={t('promptPanel.filterLoomTags')}
          hint={t('promptPanel.filterLoomTagsHint')}
          enabled={contextFilters.loomItems.enabled}
          onToggle={(v) => updateContextFilter('loomItems', 'enabled', v)}
          depthValue={contextFilters.loomItems.keepDepth}
          onDepthChange={(v) => updateContextFilter('loomItems', 'keepDepth', v)}
          depthLabel={t('promptPanel.keepLoomTagsDepth')}
        />
        <Collapsible isOpen={contextFilters.loomItems.enabled}>
          <div className={styles.filterSub}>
            <FilterKeepOnlyToggle
              id="filter-loom-keep-only"
              checked={contextFilters.loomItems.keepOnly ?? false}
              onChange={(v) => updateContextFilter('loomItems', 'keepOnly', v)}
              label={t('promptPanel.keepOnlyLoomContent')}
              hint={t('promptPanel.keepOnlyLoomContentHint')}
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

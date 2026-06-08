import { useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link2, Settings, Users, Plus, Package, Power, AlertTriangle, Cpu, Info, Edit2, Check, X, User, Sparkles, ChevronRight, Camera, RotateCcw, Link } from 'lucide-react'
import { IconAdjustments, IconAdjustmentsHorizontal } from '@tabler/icons-react'
import clsx from 'clsx'
import { useStore } from '@/store'
import { fetchConnectionModels } from '@/api/connectionModels'
import { Toggle } from '@/components/shared/Toggle'
import { Button, EditorSection, FormField } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import ModelCombobox from './connection-manager/ModelCombobox'
import LoadoutSelector from './LoadoutSelector'
import CouncilMemberItem from './council/CouncilMemberItem'
import AddMemberDropdown from './council/AddMemberDropdown'
import QuickAddPackDropdown from './council/QuickAddPackDropdown'
import LumiaSelector from '@/components/modals/LumiaSelector'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import { useCouncilProfiles } from '@/hooks/useCouncilProfiles'
import type { CouncilMember } from 'lumiverse-spindle-types'
import promptStyles from './PromptPanel.module.css'
import styles from './CouncilManager.module.css'

const MIN_TOOL_TIMEOUT_MS = 15000

type LumiaSelectorMode = 'definition' | 'behavior' | 'personality'

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <div className={clsx(promptStyles.toggleRow, disabled && promptStyles.toggleRowDisabled)}>
      <div className={promptStyles.toggleLabel}>
        <span className={promptStyles.toggleText}>{label}</span>
        {hint && <span className={promptStyles.toggleHint}>{hint}</span>}
      </div>
      <Toggle.Switch checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  )
}

function Collapsible({ isOpen, children }: { isOpen: boolean; children: ReactNode }) {
  return (
    <div className={clsx(promptStyles.collapsible, isOpen && promptStyles.collapsibleOpen)}>
      <div className={promptStyles.collapsibleInner}>{children}</div>
    </div>
  )
}

function InfoBox({ items }: { items: ReactNode[] }) {
  const { t } = useTranslation('panels', { keyPrefix: 'councilManager' })
  return (
    <div className={promptStyles.infoBox}>
      <div className={promptStyles.infoBoxHeader}>
        <Info size={14} strokeWidth={2} />
        <span>{t('whenEnabled')}</span>
      </div>
      <ul className={promptStyles.infoBoxList}>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
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
      className={clsx(promptStyles.selectionBtn, disabled && promptStyles.selectionBtnDisabled)}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={14} className={promptStyles.selectionBtnIcon} />
      <span className={promptStyles.selectionBtnLabel}>{label}</span>
      {count > 0 && <span className={promptStyles.selectionBtnBadge}>{count}</span>}
      <ChevronRight size={14} className={promptStyles.selectionBtnChevron} />
    </button>
  )
}

export default function CouncilManager() {
  const { t } = useTranslation('panels', { keyPrefix: 'councilManager' })
  const { t: tc } = useTranslation('common')
  const councilSettings = useStore((s) => s.councilSettings)
  const availableCouncilTools = useStore((s) => s.availableCouncilTools)
  const councilLoading = useStore((s) => s.councilLoading)
  const profiles = useStore((s) => s.profiles)
  const chimeraMode = useStore((s) => s.chimeraMode)
  const lumiaQuirks = useStore((s) => s.lumiaQuirks)
  const lumiaQuirksEnabled = useStore((s) => s.lumiaQuirksEnabled)
  const selectedDefinition = useStore((s) => s.selectedDefinition)
  const selectedChimeraDefinitions = useStore((s) => s.selectedChimeraDefinitions)
  const selectedBehaviors = useStore((s) => s.selectedBehaviors)
  const selectedPersonalities = useStore((s) => s.selectedPersonalities)
  const saveCouncilSettings = useStore((s) => s.saveCouncilSettings)
  const addCouncilMember = useStore((s) => s.addCouncilMember)
  const addCouncilMembersFromPack = useStore((s) => s.addCouncilMembersFromPack)
  const updateCouncilMember = useStore((s) => s.updateCouncilMember)
  const removeCouncilMember = useStore((s) => s.removeCouncilMember)
  const setCouncilToolsSettings = useStore((s) => s.setCouncilToolsSettings)
  const setSetting = useStore((s) => s.setSetting)
  const loadAvailableTools = useStore((s) => s.loadAvailableTools)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const presets = useStore((s) => s.presets)
  const councilProfiles = useCouncilProfiles()

  const [sidecarModels, setSidecarModels] = useState<string[]>([])
  const [sidecarModelLabels, setSidecarModelLabels] = useState<Record<string, string>>({})
  const [sidecarModelsLoading, setSidecarModelsLoading] = useState(false)

  const fetchSidecarModels = useCallback(async () => {
    if (!councilProfiles.sidecarConfig.connectionProfileId) {
      setSidecarModels([])
      setSidecarModelLabels({})
      return
    }

    setSidecarModelsLoading(true)
    try {
      const result = await fetchConnectionModels('llm', councilProfiles.sidecarConfig.connectionProfileId)
      setSidecarModels(result.models)
      setSidecarModelLabels(result.labels)
    } catch {
      setSidecarModels([])
      setSidecarModelLabels({})
    } finally {
      setSidecarModelsLoading(false)
    }
  }, [councilProfiles.sidecarConfig.connectionProfileId])

  useEffect(() => {
    if (!councilProfiles.sidecarConfig.connectionProfileId) {
      setSidecarModels([])
      setSidecarModelLabels({})
      return
    }
    fetchSidecarModels()
  }, [fetchSidecarModels, councilProfiles.sidecarConfig.connectionProfileId])

  const functionCallingEnabled = useMemo(() => {
    if (!activeLoomPresetId) return true
    const preset = presets[activeLoomPresetId]
    if (!preset) return true
    const cs = preset.prompts?.completionSettings
    return cs?.enableFunctionCalling !== false
  }, [activeLoomPresetId, presets])

  const [addMode, setAddMode] = useState<'none' | 'member' | 'pack'>('none')
  const [quirksValue, setQuirksValue] = useState(lumiaQuirks)
  const [isEditingQuirks, setIsEditingQuirks] = useState(false)
  const [lumiaModal, setLumiaModal] = useState<LumiaSelectorMode | null>(null)

  // Refresh available tools (including extension-registered tools) each time the panel mounts
  useEffect(() => {
    loadAvailableTools()
  }, [loadAvailableTools])

  const ts = councilSettings.toolsSettings

  const handleToggleEnabled = useCallback(() => {
    saveCouncilSettings({
      councilMode: !councilSettings.councilMode,
    })
  }, [councilSettings.councilMode, saveCouncilSettings])

  const handleAddMember = useCallback(
    (member: CouncilMember) => {
      addCouncilMember(member)
    },
    [addCouncilMember]
  )

  const handleAddPack = useCallback(
    (packId: string) => {
      addCouncilMembersFromPack(packId)
    },
    [addCouncilMembersFromPack]
  )

  const handleChimeraModeChange = useCallback(
    (enabled: boolean) => setSetting('chimeraMode', enabled),
    [setSetting]
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

  const definitionCount = chimeraMode
    ? (selectedChimeraDefinitions.length || (selectedDefinition ? 1 : 0))
    : (selectedDefinition ? 1 : 0)
  const behaviorCount = selectedBehaviors.length
  const personalityCount = selectedPersonalities.length
  const councilMembersCount = councilSettings.members.length
  const isCouncilActive = councilSettings.councilMode && councilMembersCount > 0

  if (councilLoading) {
    return <div className={styles.loading}>{t('loading')}</div>
  }

  return (
    <PanelFadeIn>
      <div className={styles.container}>
        {/* Master Toggle */}
        <div className={styles.masterToggle}>
          <button
            type="button"
            className={councilSettings.councilMode ? styles.toggleActive : styles.toggleInactive}
            onClick={handleToggleEnabled}
          >
            <Power size={14} />
            {councilSettings.councilMode ? t('enabled') : t('disabled')}
          </button>
        </div>

        <div className={styles.profileBar}>
          <div className={styles.profileHeader}>
            <span className={styles.profileLabel}>{t('profiles.label')}</span>

            {councilProfiles.activeSource !== 'none' && (
              <span className={styles.profileSourceBadge}>
                {councilProfiles.activeSource === 'chat' ? t('profiles.sourceChat')
                  : councilProfiles.activeSource === 'character' ? t('profiles.sourceCharacter')
                    : t('profiles.sourceDefault')}
              </span>
            )}
          </div>

          <div className={styles.profileBtnGroup}>
            {!councilProfiles.hasDefaults ? (
              <button
                className={styles.profileBtn}
                onClick={councilProfiles.captureDefaults}
                disabled={councilProfiles.isLoading}
                title={t('profiles.captureTitle')}
                type="button"
              >
                <Camera size={10} /> {t('profiles.defaults')}
              </button>
            ) : (
              <button
                className={clsx(styles.profileBtn, styles.profileBtnActive)}
                onClick={councilProfiles.captureDefaults}
                disabled={councilProfiles.isLoading}
                title={t('profiles.resaveDefaultsTitle')}
                type="button"
              >
                <RotateCcw size={10} /> {t('profiles.defaults')}
                <span
                  className={styles.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); councilProfiles.clearDefaults() }}
                  title={t('profiles.clearDefaultsTitle')}
                  role="button"
                  tabIndex={0}
                >
                  <X size={8} />
                </span>
              </button>
            )}

            {councilProfiles.characterBindingEnabled && (!councilProfiles.hasCharacterBinding ? (
              <button
                className={styles.profileBtn}
                onClick={councilProfiles.bindToCharacter}
                disabled={councilProfiles.isLoading || !councilProfiles.activeCharacterId}
                title={
                  councilProfiles.activeCharacterId
                    ? t('profiles.bindCharacter')
                    : t('profiles.noCharacter')
                }
                type="button"
              >
                <Link size={10} /> {t('profiles.character')}
              </button>
            ) : (
              <button
                className={clsx(styles.profileBtn, styles.profileBtnActive)}
                onClick={councilProfiles.bindToCharacter}
                disabled={councilProfiles.isLoading || !councilProfiles.activeCharacterId}
                title={t('profiles.rebindCharacter')}
                type="button"
              >
                <RotateCcw size={10} /> {t('profiles.character')}
                <span
                  className={styles.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); councilProfiles.unbindCharacter() }}
                  title={t('profiles.removeCharacter')}
                  role="button"
                  tabIndex={0}
                >
                  <X size={8} />
                </span>
              </button>
            ))}

            {!councilProfiles.hasChatBinding ? (
              <button
                className={styles.profileBtn}
                onClick={councilProfiles.bindToChat}
                disabled={councilProfiles.isLoading || !councilProfiles.activeChatId}
                title={
                  councilProfiles.activeChatId
                    ? t('profiles.bindChat')
                    : t('profiles.noChat')
                }
                type="button"
              >
                <Link size={10} /> {t('profiles.chat')}
              </button>
            ) : (
              <button
                className={clsx(styles.profileBtn, styles.profileBtnActive)}
                onClick={councilProfiles.bindToChat}
                disabled={councilProfiles.isLoading || !councilProfiles.activeChatId}
                title={t('profiles.rebindChat')}
                type="button"
              >
                <RotateCcw size={10} /> {t('profiles.chat')}
                <span
                  className={styles.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); councilProfiles.unbindChat() }}
                  title={t('profiles.removeChat')}
                  role="button"
                  tabIndex={0}
                >
                  <X size={8} />
                </span>
              </button>
            )}
          </div>
        </div>

        <EditorSection Icon={Package} title={t('sections.loadout')}>
          <LoadoutSelector />
        </EditorSection>

        <EditorSection Icon={User} title={t('sections.lumiaSelection')}>
          <p className={promptStyles.desc}>
            {t('lumiaSelection.desc')}
          </p>

          <div className={clsx(promptStyles.selectionGroup, isCouncilActive && promptStyles.selectionGroupDisabled)}>
            <SelectionBtn
              icon={User}
              label={chimeraMode ? t('lumiaSelection.chimeraDefinitions') : t('lumiaSelection.definition')}
              count={definitionCount}
              onClick={() => setLumiaModal('definition')}
              disabled={isCouncilActive}
            />
            <SelectionBtn
              icon={IconAdjustments}
              label={t('lumiaSelection.behaviors')}
              count={behaviorCount}
              onClick={() => setLumiaModal('behavior')}
              disabled={isCouncilActive}
            />
            <SelectionBtn
              icon={Sparkles}
              label={t('lumiaSelection.personalities')}
              count={personalityCount}
              onClick={() => setLumiaModal('personality')}
              disabled={isCouncilActive}
            />
          </div>

          {isCouncilActive && (
            <p className={promptStyles.modeNote}>
              {t('lumiaSelection.councilActiveNote')}
            </p>
          )}
        </EditorSection>

        <EditorSection Icon={IconAdjustmentsHorizontal} title={t('sections.lumiaModes')}>
          <p className={promptStyles.desc}>
            {t('lumiaModes.desc')}
          </p>

          <div className={promptStyles.modeOption}>
            <ToggleRow
              checked={chimeraMode}
              onChange={handleChimeraModeChange}
              label={t('lumiaModes.chimeraMode')}
              hint={t('lumiaModes.chimeraHint')}
            />
            <Collapsible isOpen={chimeraMode}>
              <InfoBox
                items={[
                  t('lumiaModes.chimeraInfo1'),
                  t('lumiaModes.chimeraInfo2'),
                  t('lumiaModes.chimeraInfo3', { count: definitionCount }),
                ]}
              />
            </Collapsible>
          </div>

          <div className={clsx(promptStyles.quirksSection, !lumiaQuirksEnabled && promptStyles.quirksSectionDisabled)}>
            <div className={promptStyles.quirksHeader}>
              <div className={promptStyles.quirksHeaderLeft}>
                <span className={promptStyles.quirksLabel}>{t('lumiaModes.quirks')}</span>
                <ToggleRow
                  checked={lumiaQuirksEnabled}
                  onChange={handleQuirksEnabledChange}
                  label=""
                />
              </div>
              {!isEditingQuirks && lumiaQuirksEnabled && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => {
                    setQuirksValue(lumiaQuirks)
                    setIsEditingQuirks(true)
                  }}
                  title={t('lumiaModes.editQuirks')}
                  icon={<Edit2 size={12} strokeWidth={1.5} />}
                />
              )}
            </div>
            <p className={promptStyles.quirksHint}>
              {t('lumiaModes.quirksHint', { macro: '{{lumiaQuirks}}' })}
            </p>

            {isEditingQuirks && lumiaQuirksEnabled ? (
              <div className={promptStyles.quirksEdit}>
                <textarea
                  className={promptStyles.quirksTextarea}
                  placeholder={t('lumiaModes.quirksPlaceholder')}
                  value={quirksValue}
                  onChange={(e) => setQuirksValue(e.target.value)}
                  rows={3}
                />
                <div className={promptStyles.quirksActions}>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Check size={12} strokeWidth={2} />}
                    onClick={handleQuirksSave}
                  >
                    {tc('actions.save')}
                  </Button>
                  <Button size="sm" icon={<X size={12} strokeWidth={2} />} onClick={handleQuirksCancel}>
                    {tc('actions.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className={promptStyles.quirksPreview}>
                {lumiaQuirks?.trim() ? (
                  <span>{lumiaQuirks}</span>
                ) : (
                  <span className={promptStyles.quirksEmpty}>{t('lumiaModes.noQuirks')}</span>
                )}
              </div>
            )}
          </div>
        </EditorSection>

        <EditorSection Icon={Cpu} title={t('sections.sidecar')}>
          <div className={styles.inlineHint} style={{ marginBottom: 10 }}>
            {t('sidecar.hint')}
          </div>

          <FormField label={t('sidecar.connectionProfile')}>
            <ConnectionSelect
              kind="llm"
              value={councilProfiles.sidecarConfig.connectionProfileId}
              onChange={(val) => councilProfiles.saveSidecar({ connectionProfileId: val, model: profiles.find((p) => p.id === val)?.model || '' })}
              placeholder={t('sidecar.selectConnection')}
              searchPlaceholder={t('sidecar.searchConnections')}
              emptyMessage={t('sidecar.noConnections')}
              clearable
              clearLabel={t('sidecar.clearConnection')}
            />
          </FormField>

          <FormField label={t('sidecar.model')}>
            <ModelCombobox
              value={councilProfiles.sidecarConfig.model}
              onChange={(val) => councilProfiles.saveSidecar({ model: val })}
              placeholder={t('sidecar.modelPlaceholder')}
              models={sidecarModels}
              modelLabels={sidecarModelLabels}
              loading={sidecarModelsLoading}
              onRefresh={fetchSidecarModels}
              autoRefreshOnFocus
              refreshKey={councilProfiles.sidecarConfig.connectionProfileId}
              disabled={!councilProfiles.sidecarConfig.connectionProfileId}
              emptyMessage={councilProfiles.sidecarConfig.connectionProfileId ? t('sidecar.noModelsForConnection') : t('sidecar.selectConnectionFirst')}
              browseHint={councilProfiles.sidecarConfig.connectionProfileId ? t('sidecar.browseHintWithConnection') : t('sidecar.browseHintNoConnection')}
            />
          </FormField>

          <div className={styles.fieldRow}>
            <FormField label={t('sidecar.temperature')}>
              <NumberStepper
                value={councilProfiles.sidecarConfig.temperature}
                onChange={(val) => councilProfiles.saveSidecar({ temperature: val })}
                min={0}
                max={2}
                step={0.05}
              />
            </FormField>
            <FormField label={t('sidecar.topP')}>
              <NumberStepper
                value={councilProfiles.sidecarConfig.topP}
                onChange={(val) => councilProfiles.saveSidecar({ topP: val })}
                min={0}
                max={1}
                step={0.05}
              />
            </FormField>
            <FormField label={t('sidecar.maxTokens')}>
              <NumberStepper
                value={councilProfiles.sidecarConfig.maxTokens}
                onChange={(val) => councilProfiles.saveSidecar({ maxTokens: val })}
                min={256}
                max={4096}
                step={50}
              />
            </FormField>
          </div>
        </EditorSection>

        <EditorSection Icon={Link2} title={t('sections.tools')}>
          <FormField label={t('tools.mode')}>
            <div className={styles.modeToggle}>
              <button
                type="button"
                className={`${styles.modeBtn}${(ts.mode ?? 'sidecar') === 'sidecar' ? ` ${styles.modeBtnActive}` : ''}`}
                onClick={() => setCouncilToolsSettings({ mode: 'sidecar' })}
              >
                {t('tools.sidecar')}
              </button>
              <button
                type="button"
                className={`${styles.modeBtn}${(ts.mode ?? 'sidecar') === 'inline' ? ` ${styles.modeBtnActive}` : ''}`}
                onClick={() => setCouncilToolsSettings({ mode: 'inline' })}
              >
                {t('tools.inline')}
              </button>
            </div>
          </FormField>

          {(ts.mode ?? 'sidecar') === 'sidecar' && (
            <div className={styles.inlineHint}>
              {t('tools.sidecarHint')}
            </div>
          )}

          {(ts.mode ?? 'sidecar') === 'inline' && (
            <>
              <div className={styles.inlineHint}>
                {t('tools.inlineHint')}
              </div>
              {!functionCallingEnabled && (
                <div className={styles.inlineWarning}>
                  <AlertTriangle size={14} />
                  {t('tools.inlineWarning')}
                </div>
              )}
            </>
          )}
        </EditorSection>

        <EditorSection Icon={Settings} title={t('sections.context')}>
          <div className={styles.fieldRow}>
            <FormField label={t('context.contextWindow')} hint={t('context.contextWindowHint')}>
              <NumberStepper
                value={ts.sidecarContextWindow}
                onChange={(val) => setCouncilToolsSettings({ sidecarContextWindow: val })}
                min={1}
                max={100}
              />
            </FormField>
            <FormField label={t('context.maxWordsPerTool')}>
              <NumberStepper
                value={ts.maxWordsPerTool}
                onChange={(val) => setCouncilToolsSettings({ maxWordsPerTool: val })}
                min={50}
                max={500}
                step={25}
              />
            </FormField>
            <FormField label={t('context.timeoutMs')}>
              <NumberStepper
                value={ts.timeoutMs}
                onChange={(val) => setCouncilToolsSettings({ timeoutMs: val })}
                min={MIN_TOOL_TIMEOUT_MS}
                max={120000}
                step={1000}
              />
            </FormField>
          </div>

          <div className={styles.checkboxGroup}>
            <Toggle.Checkbox
              checked={ts.includeUserPersona}
              onChange={(checked) => setCouncilToolsSettings({ includeUserPersona: checked })}
              label={t('context.includeUserPersona')}
            />
            <Toggle.Checkbox
              checked={ts.includeCharacterInfo}
              onChange={(checked) => setCouncilToolsSettings({ includeCharacterInfo: checked })}
              label={t('context.includeCharacterInfo')}
            />
            <Toggle.Checkbox
              checked={ts.includeWorldInfo}
              onChange={(checked) => setCouncilToolsSettings({ includeWorldInfo: checked })}
              label={t('context.includeWorldInfo')}
            />
            <Toggle.Checkbox
              checked={ts.allowUserControl}
              onChange={(checked) => setCouncilToolsSettings({ allowUserControl: checked })}
              label={t('context.allowUserControl')}
            />
            <Toggle.Checkbox
              checked={ts.retainResultsForRegens ?? false}
              onChange={(checked) => setCouncilToolsSettings({ retainResultsForRegens: checked })}
              label={t('context.retainResults')}
            />
          </div>

          <div className={styles.inlineHint} style={{ marginTop: 10 }}>
            {t('context.webSearchHint')}
          </div>
        </EditorSection>

        <EditorSection Icon={Users} title={t('sections.members')}>
          {addMode === 'member' ? (
            <AddMemberDropdown
              existingMembers={councilSettings.members}
              onAdd={handleAddMember}
              onClose={() => setAddMode('none')}
            />
          ) : addMode === 'pack' ? (
            <QuickAddPackDropdown
              existingMembers={councilSettings.members}
              onAddPack={handleAddPack}
              onClose={() => setAddMode('none')}
            />
          ) : (
            <div className={styles.addButtons}>
              <Button variant="ghost" size="sm" icon={<Plus size={14} />} className={styles.addBtn} onClick={() => setAddMode('member')}>
                {t('members.addMember')}
              </Button>
              <Button variant="ghost" size="sm" icon={<Package size={14} />} className={styles.addBtn} onClick={() => setAddMode('pack')}>
                {t('members.quickAddPack')}
              </Button>
            </div>
          )}

          {councilSettings.members.length === 0 && addMode === 'none' && (
            <div className={styles.emptyState}>{t('members.empty')}</div>
          )}

          {councilSettings.members.map((member) => (
            <CouncilMemberItem
              key={member.id}
              member={member}
              availableTools={availableCouncilTools}
              onUpdate={updateCouncilMember}
              onDelete={() => removeCouncilMember(member.id)}
            />
          ))}
        </EditorSection>

        {lumiaModal && (
          <LumiaSelector mode={lumiaModal} onClose={() => setLumiaModal(null)} />
        )}
      </div>
    </PanelFadeIn>
  )
}

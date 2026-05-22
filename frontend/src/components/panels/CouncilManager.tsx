import { useState, useCallback, useEffect, useMemo, type ReactNode } from 'react'
import { Link2, Settings, Users, Plus, Package, Power, AlertTriangle, Cpu, Info, Edit2, Check, X, User, Sparkles, ChevronRight, Camera, RotateCcw, Link } from 'lucide-react'
import { IconAdjustments, IconAdjustmentsHorizontal } from '@tabler/icons-react'
import clsx from 'clsx'
import { useStore } from '@/store'
import { connectionsApi } from '@/api/connections'
import { Toggle } from '@/components/shared/Toggle'
import { Button, EditorSection, FormField } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import SearchableSelect from '@/components/shared/SearchableSelect'
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
  return (
    <div className={promptStyles.infoBox}>
      <div className={promptStyles.infoBoxHeader}>
        <Info size={14} strokeWidth={2} />
        <span>When enabled:</span>
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
      const result = await connectionsApi.models(councilProfiles.sidecarConfig.connectionProfileId)
      setSidecarModels(result.models || [])
      setSidecarModelLabels(result.model_labels || {})
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

  const profileOptions = profiles.map((p) => ({ value: p.id, label: `${p.name} (${p.provider})` }))

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
    return <div className={styles.loading}>Loading council settings...</div>
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
            {councilSettings.councilMode ? 'Council Enabled' : 'Council Disabled'}
          </button>
        </div>

        <div className={styles.profileBar}>
          <div className={styles.profileHeader}>
            <span className={styles.profileLabel}>Profiles</span>

            {councilProfiles.activeSource !== 'none' && (
              <span className={styles.profileSourceBadge}>
                {councilProfiles.activeSource === 'chat' ? 'CHAT'
                  : councilProfiles.activeSource === 'character' ? 'CHAR'
                    : 'DEFAULT'}
              </span>
            )}
          </div>

          <div className={styles.profileBtnGroup}>
            {!councilProfiles.hasDefaults ? (
              <button
                className={styles.profileBtn}
                onClick={councilProfiles.captureDefaults}
                disabled={councilProfiles.isLoading}
                title="Save the current council and sidecar settings as the default council profile"
                type="button"
              >
                <Camera size={10} /> Defaults
              </button>
            ) : (
              <button
                className={clsx(styles.profileBtn, styles.profileBtnActive)}
                onClick={councilProfiles.captureDefaults}
                disabled={councilProfiles.isLoading}
                title="Resave the current council and sidecar settings as the default council profile"
                type="button"
              >
                <RotateCcw size={10} /> Defaults
                <span
                  className={styles.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); councilProfiles.clearDefaults() }}
                  title="Clear the default council profile"
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
                    ? 'Save the current council and sidecar settings to this character'
                    : 'No active character - open a chat first'
                }
                type="button"
              >
                <Link size={10} /> Character
              </button>
            ) : (
              <button
                className={clsx(styles.profileBtn, styles.profileBtnActive)}
                onClick={councilProfiles.bindToCharacter}
                disabled={councilProfiles.isLoading || !councilProfiles.activeCharacterId}
                title="Resave the current council and sidecar settings to this character"
                type="button"
              >
                <RotateCcw size={10} /> Character
                <span
                  className={styles.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); councilProfiles.unbindCharacter() }}
                  title="Remove character council binding"
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
                    ? 'Save the current council and sidecar settings to this chat'
                    : 'No active chat - open a chat first'
                }
                type="button"
              >
                <Link size={10} /> Chat
              </button>
            ) : (
              <button
                className={clsx(styles.profileBtn, styles.profileBtnActive)}
                onClick={councilProfiles.bindToChat}
                disabled={councilProfiles.isLoading || !councilProfiles.activeChatId}
                title="Resave the current council and sidecar settings to this chat"
                type="button"
              >
                <RotateCcw size={10} /> Chat
                <span
                  className={styles.profileBtnDismiss}
                  onClick={(e) => { e.stopPropagation(); councilProfiles.unbindChat() }}
                  title="Remove chat council binding"
                  role="button"
                  tabIndex={0}
                >
                  <X size={8} />
                </span>
              </button>
            )}
          </div>
        </div>

        <EditorSection Icon={Package} title="Council Loadout">
          <LoadoutSelector />
        </EditorSection>

        <EditorSection Icon={User} title="Lumia Selection">
          <p className={promptStyles.desc}>
            Select Lumia definitions, behaviors, and personalities from your loaded packs.
          </p>

          <div className={clsx(promptStyles.selectionGroup, isCouncilActive && promptStyles.selectionGroupDisabled)}>
            <SelectionBtn
              icon={User}
              label={chimeraMode ? 'Chimera Definitions' : 'Definition'}
              count={definitionCount}
              onClick={() => setLumiaModal('definition')}
              disabled={isCouncilActive}
            />
            <SelectionBtn
              icon={IconAdjustments}
              label="Behaviors"
              count={behaviorCount}
              onClick={() => setLumiaModal('behavior')}
              disabled={isCouncilActive}
            />
            <SelectionBtn
              icon={Sparkles}
              label="Personalities"
              count={personalityCount}
              onClick={() => setLumiaModal('personality')}
              disabled={isCouncilActive}
            />
          </div>

          {isCouncilActive && (
            <p className={promptStyles.modeNote}>
              Individual Lumia selections are disabled while Council Mode is active. Configure members below.
            </p>
          )}
        </EditorSection>

        <EditorSection Icon={IconAdjustmentsHorizontal} title="Lumia Modes">
          <p className={promptStyles.desc}>
            Configure special Lumia modes for unique character setups.
          </p>

          <div className={promptStyles.modeOption}>
            <ToggleRow
              checked={chimeraMode}
              onChange={handleChimeraModeChange}
              label="Chimera Mode"
              hint="Fuse multiple physical definitions into one hybrid form"
            />
            <Collapsible isOpen={chimeraMode}>
              <InfoBox
                items={[
                  'Select multiple definitions in the Definition picker',
                  'All selected forms will be fused into one Chimera',
                  `Currently ${definitionCount} definition${definitionCount !== 1 ? 's' : ''} selected`,
                ]}
              />
            </Collapsible>
          </div>

          <div className={clsx(promptStyles.quirksSection, !lumiaQuirksEnabled && promptStyles.quirksSectionDisabled)}>
            <div className={promptStyles.quirksHeader}>
              <div className={promptStyles.quirksHeaderLeft}>
                <span className={promptStyles.quirksLabel}>Behavioral Quirks</span>
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
                  title="Edit quirks"
                  icon={<Edit2 size={12} strokeWidth={1.5} />}
                />
              )}
            </div>
            <p className={promptStyles.quirksHint}>
              Extra behavioral modifications. Use <code>{'{{lumiaQuirks}}'}</code>
            </p>

            {isEditingQuirks && lumiaQuirksEnabled ? (
              <div className={promptStyles.quirksEdit}>
                <textarea
                  className={promptStyles.quirksTextarea}
                  placeholder="Enter behavioral quirks..."
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
                    Save
                  </Button>
                  <Button size="sm" icon={<X size={12} strokeWidth={2} />} onClick={handleQuirksCancel}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className={promptStyles.quirksPreview}>
                {lumiaQuirks?.trim() ? (
                  <span>{lumiaQuirks}</span>
                ) : (
                  <span className={promptStyles.quirksEmpty}>No quirks set</span>
                )}
              </div>
            )}
          </div>
        </EditorSection>

        {/* Sidecar LLM — shared connection used by council tools, expression detection, and other sidecar features */}
        <EditorSection Icon={Cpu} title="Sidecar LLM">
          <div className={styles.inlineHint} style={{ marginBottom: 10 }}>
            The sidecar connection is used by council tools, expression detection, and other background LLM features.
          </div>

          <FormField label="Connection Profile">
            <SearchableSelect
              value={councilProfiles.sidecarConfig.connectionProfileId}
              onChange={(val) => councilProfiles.saveSidecar({ connectionProfileId: val })}
              options={profileOptions}
              placeholder="Select a connection…"
              searchPlaceholder="Search connections…"
              emptyMessage="No connection profiles configured"
              clearable
              clearLabel="No connection"
            />
          </FormField>

          <FormField label="Model">
            <ModelCombobox
              value={councilProfiles.sidecarConfig.model}
              onChange={(val) => councilProfiles.saveSidecar({ model: val })}
              placeholder="e.g. claude-3-haiku-20240307"
              models={sidecarModels}
              modelLabels={sidecarModelLabels}
              loading={sidecarModelsLoading}
              onRefresh={fetchSidecarModels}
              autoRefreshOnFocus
              refreshKey={councilProfiles.sidecarConfig.connectionProfileId}
              disabled={!councilProfiles.sidecarConfig.connectionProfileId}
              emptyMessage={councilProfiles.sidecarConfig.connectionProfileId ? 'No models returned for this connection. Enter one manually.' : 'Select a connection profile to browse models.'}
              browseHint={councilProfiles.sidecarConfig.connectionProfileId ? 'Click into the field to browse models for the selected connection, or type one manually.' : 'Select a connection profile first, then click into the field to browse models.'}
            />
          </FormField>

          <div className={styles.fieldRow}>
            <FormField label="Temperature">
              <NumberStepper
                value={councilProfiles.sidecarConfig.temperature}
                onChange={(val) => councilProfiles.saveSidecar({ temperature: val })}
                min={0}
                max={2}
                step={0.05}
              />
            </FormField>
            <FormField label="Top P">
              <NumberStepper
                value={councilProfiles.sidecarConfig.topP}
                onChange={(val) => councilProfiles.saveSidecar({ topP: val })}
                min={0}
                max={1}
                step={0.05}
              />
            </FormField>
            <FormField label="Max Tokens">
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

        {/* Tools Config — how tools are invoked (sidecar vs inline) */}
        <EditorSection Icon={Link2} title="Tools Configuration">
          <FormField label="Mode">
            <div className={styles.modeToggle}>
              <button
                type="button"
                className={`${styles.modeBtn}${(ts.mode ?? 'sidecar') === 'sidecar' ? ` ${styles.modeBtnActive}` : ''}`}
                onClick={() => setCouncilToolsSettings({ mode: 'sidecar' })}
              >
                Sidecar
              </button>
              <button
                type="button"
                className={`${styles.modeBtn}${(ts.mode ?? 'sidecar') === 'inline' ? ` ${styles.modeBtnActive}` : ''}`}
                onClick={() => setCouncilToolsSettings({ mode: 'inline' })}
              >
                Inline
              </button>
            </div>
          </FormField>

          {(ts.mode ?? 'sidecar') === 'sidecar' && (
            <div className={styles.inlineHint}>
              Tools run on the sidecar LLM configured above. Each tool gets its own call.
            </div>
          )}

          {(ts.mode ?? 'sidecar') === 'inline' && (
            <>
              <div className={styles.inlineHint}>
                Tools are registered as function calls directly with the main LLM. No separate
                sidecar model is used — the primary model handles tool invocations itself.
                Requires <strong>Enable Function Calling</strong> in your Loom preset's completion settings.
              </div>
              {!functionCallingEnabled && (
                <div className={styles.inlineWarning}>
                  <AlertTriangle size={14} />
                  Function Calling is disabled in the active Loom preset. Inline tools will not be sent.
                </div>
              )}
            </>
          )}
        </EditorSection>

        {/* Context Settings */}
        <EditorSection Icon={Settings} title="Context Settings">
          <div className={styles.fieldRow}>
            <FormField label="Context Window" hint="Messages to include">
              <NumberStepper
                value={ts.sidecarContextWindow}
                onChange={(val) => setCouncilToolsSettings({ sidecarContextWindow: val })}
                min={1}
                max={100}
              />
            </FormField>
            <FormField label="Max Words / Tool">
              <NumberStepper
                value={ts.maxWordsPerTool}
                onChange={(val) => setCouncilToolsSettings({ maxWordsPerTool: val })}
                min={50}
                max={500}
                step={25}
              />
            </FormField>
            <FormField label="Timeout (ms)">
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
              label="Include User Persona"
            />
            <Toggle.Checkbox
              checked={ts.includeCharacterInfo}
              onChange={(checked) => setCouncilToolsSettings({ includeCharacterInfo: checked })}
              label="Include Character Info"
            />
            <Toggle.Checkbox
              checked={ts.includeWorldInfo}
              onChange={(checked) => setCouncilToolsSettings({ includeWorldInfo: checked })}
              label="Include World Info"
            />
            <Toggle.Checkbox
              checked={ts.allowUserControl}
              onChange={(checked) => setCouncilToolsSettings({ allowUserControl: checked })}
              label="Allow User Control"
            />
            <Toggle.Checkbox
              checked={ts.retainResultsForRegens ?? false}
              onChange={(checked) => setCouncilToolsSettings({ retainResultsForRegens: checked })}
              label="Retain Results for Regens/Swipes"
            />
          </div>

          <div className={styles.inlineHint} style={{ marginTop: 10 }}>
            Configure <strong>Settings → Web Search</strong> to enable the Web Search council tool for inline or sidecar use.
          </div>
        </EditorSection>

        {/* Council Members */}
        <EditorSection Icon={Users} title="Council Members">
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
                Add Member
              </Button>
              <Button variant="ghost" size="sm" icon={<Package size={14} />} className={styles.addBtn} onClick={() => setAddMode('pack')}>
                Quick Add Pack
              </Button>
            </div>
          )}

          {councilSettings.members.length === 0 && addMode === 'none' && (
            <div className={styles.emptyState}>No council members yet. Add one to get started.</div>
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

import { useState, useCallback, useEffect, useMemo } from 'react'
import { Link2, Settings, Users, Plus, Package, Power, AlertTriangle, Cpu } from 'lucide-react'
import { useStore } from '@/store'
import { settingsApi } from '@/api/settings'
import { Toggle } from '@/components/shared/Toggle'
import { Button, EditorSection, FormField, TextInput, Select } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import CouncilMemberItem from './council/CouncilMemberItem'
import AddMemberDropdown from './council/AddMemberDropdown'
import QuickAddPackDropdown from './council/QuickAddPackDropdown'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import type { CouncilMember } from 'lumiverse-spindle-types'
import styles from './CouncilManager.module.css'

const MIN_TOOL_TIMEOUT_MS = 15000

interface SidecarConfig {
  connectionProfileId: string
  model: string
  temperature: number
  topP: number
  maxTokens: number
}

const SIDECAR_DEFAULTS: SidecarConfig = {
  connectionProfileId: '',
  model: '',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 1024,
}

export default function CouncilManager() {
  const councilSettings = useStore((s) => s.councilSettings)
  const availableCouncilTools = useStore((s) => s.availableCouncilTools)
  const councilLoading = useStore((s) => s.councilLoading)
  const profiles = useStore((s) => s.profiles)
  const saveCouncilSettings = useStore((s) => s.saveCouncilSettings)
  const addCouncilMember = useStore((s) => s.addCouncilMember)
  const addCouncilMembersFromPack = useStore((s) => s.addCouncilMembersFromPack)
  const updateCouncilMember = useStore((s) => s.updateCouncilMember)
  const removeCouncilMember = useStore((s) => s.removeCouncilMember)
  const setCouncilToolsSettings = useStore((s) => s.setCouncilToolsSettings)
  const loadAvailableTools = useStore((s) => s.loadAvailableTools)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const presets = useStore((s) => s.presets)

  // Shared sidecar settings (independent of council)
  const [sidecarConfig, setSidecarConfig] = useState<SidecarConfig>(SIDECAR_DEFAULTS)

  useEffect(() => {
    const applyLegacy = (cs: any) => {
      const legacy = cs?.toolsSettings?.sidecar
      if (legacy?.connectionProfileId) {
        setSidecarConfig({
          connectionProfileId: legacy.connectionProfileId,
          model: legacy.model || '',
          temperature: legacy.temperature ?? 0.7,
          topP: legacy.topP ?? 0.9,
          maxTokens: legacy.maxTokens ?? 1024,
        })
      }
    }
    settingsApi.get('sidecarSettings')
      .then((row) => {
        if (row?.value?.connectionProfileId) {
          setSidecarConfig({ ...SIDECAR_DEFAULTS, ...(row.value as Partial<SidecarConfig>) })
        } else {
          // No dedicated setting — try legacy council sidecar
          settingsApi.get('council_settings')
            .then((cs) => applyLegacy(cs?.value))
            .catch(() => {})
        }
      })
      .catch(() => {
        // sidecarSettings key doesn't exist — try legacy
        settingsApi.get('council_settings')
          .then((cs) => applyLegacy(cs?.value))
          .catch(() => {})
      })
  }, [])

  const saveSidecar = useCallback((partial: Partial<SidecarConfig>) => {
    setSidecarConfig((prev) => {
      const updated = { ...prev, ...partial }
      settingsApi.put('sidecarSettings', updated).catch(() => {})
      return updated
    })
  }, [])

  const functionCallingEnabled = useMemo(() => {
    if (!activeLoomPresetId) return true
    const preset = presets[activeLoomPresetId]
    if (!preset) return true
    const cs = preset.prompts?.completionSettings
    return cs?.enableFunctionCalling !== false
  }, [activeLoomPresetId, presets])

  const [addMode, setAddMode] = useState<'none' | 'member' | 'pack'>('none')

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

      {/* Sidecar LLM — shared connection used by council tools, expression detection, and other sidecar features */}
      <EditorSection Icon={Cpu} title="Sidecar LLM">
        <div className={styles.inlineHint} style={{ marginBottom: 10 }}>
          The sidecar connection is used by council tools, expression detection, and other background LLM features.
        </div>

        <FormField label="Connection Profile">
          <Select
            value={sidecarConfig.connectionProfileId}
            onChange={(val) => saveSidecar({ connectionProfileId: val })}
            options={[{ value: '', label: 'Select a connection...' }, ...profileOptions]}
          />
        </FormField>

        <FormField label="Model">
          <TextInput
            value={sidecarConfig.model}
            onChange={(val) => saveSidecar({ model: val })}
            placeholder="e.g. claude-3-haiku-20240307"
          />
        </FormField>

        <div className={styles.fieldRow}>
          <FormField label="Temperature">
            <NumberStepper
              value={sidecarConfig.temperature}
              onChange={(val) => saveSidecar({ temperature: val })}
              min={0}
              max={2}
              step={0.05}
            />
          </FormField>
          <FormField label="Top P">
            <NumberStepper
              value={sidecarConfig.topP}
              onChange={(val) => saveSidecar({ topP: val })}
              min={0}
              max={1}
              step={0.05}
            />
          </FormField>
          <FormField label="Max Tokens">
            <NumberStepper
              value={sidecarConfig.maxTokens}
              onChange={(val) => saveSidecar({ maxTokens: val })}
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
      </div>
    </PanelFadeIn>
  )
}

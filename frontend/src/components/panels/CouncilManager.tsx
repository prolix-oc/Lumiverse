import { useState, useCallback, useEffect, useMemo } from 'react'
import { Link2, Settings, Users, Plus, Package, Power, AlertTriangle } from 'lucide-react'
import { useStore } from '@/store'
import { EditorSection, FormField, TextInput, Select } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import CouncilMemberItem from './council/CouncilMemberItem'
import AddMemberDropdown from './council/AddMemberDropdown'
import QuickAddPackDropdown from './council/QuickAddPackDropdown'
import type { CouncilMember } from 'lumiverse-spindle-types'
import styles from './CouncilManager.module.css'

const MIN_TOOL_TIMEOUT_MS = 15000

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
  const sidecar = ts.sidecar

  const profileOptions = profiles.map((p) => ({ value: p.id, label: `${p.name} (${p.provider})` }))

  const handleToggleEnabled = useCallback(() => {
    saveCouncilSettings({
      councilMode: !councilSettings.councilMode,
      toolsSettings: { ...ts, enabled: !councilSettings.councilMode },
    })
  }, [councilSettings.councilMode, ts, saveCouncilSettings])

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

      {/* Tools Config */}
      <EditorSection Icon={Link2} title="Tools Configuration">
        {/* Mode Toggle */}
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

        {(ts.mode ?? 'sidecar') === 'sidecar' && (
          <>
        <FormField label="Connection Profile">
          <Select
            value={sidecar.connectionProfileId}
            onChange={(val) =>
              setCouncilToolsSettings({ sidecar: { ...sidecar, connectionProfileId: val } })
            }
            options={[{ value: '', label: 'Select a connection...' }, ...profileOptions]}
          />
        </FormField>

        <FormField label="Model">
          <TextInput
            value={sidecar.model}
            onChange={(val) => setCouncilToolsSettings({ sidecar: { ...sidecar, model: val } })}
            placeholder="e.g. claude-3-haiku-20240307"
          />
        </FormField>

        <div className={styles.fieldRow}>
          <FormField label="Temperature">
            <NumberStepper
              value={sidecar.temperature}
              onChange={(val) => setCouncilToolsSettings({ sidecar: { ...sidecar, temperature: val } })}
              min={0}
              max={2}
              step={0.05}
            />
          </FormField>
          <FormField label="Top P">
            <NumberStepper
              value={sidecar.topP}
              onChange={(val) => setCouncilToolsSettings({ sidecar: { ...sidecar, topP: val } })}
              min={0}
              max={1}
              step={0.05}
            />
          </FormField>
          <FormField label="Max Tokens">
            <NumberStepper
              value={sidecar.maxTokens}
              onChange={(val) => setCouncilToolsSettings({ sidecar: { ...sidecar, maxTokens: val } })}
              min={256}
              max={4096}
              step={50}
            />
          </FormField>
        </div>
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
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={ts.includeUserPersona}
              onChange={(e) => setCouncilToolsSettings({ includeUserPersona: e.target.checked })}
            />
            Include User Persona
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={ts.includeCharacterInfo}
              onChange={(e) => setCouncilToolsSettings({ includeCharacterInfo: e.target.checked })}
            />
            Include Character Info
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={ts.includeWorldInfo}
              onChange={(e) => setCouncilToolsSettings({ includeWorldInfo: e.target.checked })}
            />
            Include World Info
          </label>
          <label className={styles.checkbox}>
            <input
              type="checkbox"
              checked={ts.allowUserControl}
              onChange={(e) => setCouncilToolsSettings({ allowUserControl: e.target.checked })}
            />
            Allow User Control
          </label>
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
            <button type="button" className={styles.addBtn} onClick={() => setAddMode('member')}>
              <Plus size={14} /> Add Member
            </button>
            <button type="button" className={styles.addBtnSecondary} onClick={() => setAddMode('pack')}>
              <Package size={14} /> Quick Add Pack
            </button>
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
  )
}

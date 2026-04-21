import { useState, useMemo, useCallback, useEffect } from 'react'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { chatsApi } from '@/api/chats'
import { presetsApi } from '@/api/presets'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import type { Character, Chat, PresetRegistryItem } from '@/types/api'
import styles from './GroupChatCreatorModal.module.css'

export default function GroupSettingsModal() {
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps) as {
    chatId: string
    chatName?: string
    metadata: Record<string, any>
    onSaved?: (chat: Chat) => void
  } | null
  const characters = useStore((s) => s.characters)

  const chatId = modalProps?.chatId ?? ''
  const metadata = modalProps?.metadata ?? {}
  const isGroup = metadata.group === true
  const characterIds: string[] = metadata.character_ids ?? []

  const selectedCharacters = useMemo(
    () => characterIds.map((id) => characters.find((c) => c.id === id)).filter(Boolean) as Character[],
    [characterIds, characters]
  )

  const [groupName, setGroupName] = useState(modalProps?.chatName ?? '')
  const [presetOptions, setPresetOptions] = useState<PresetRegistryItem[]>([])
  const [loadingPresets, setLoadingPresets] = useState(false)
  const [impersonationPresetId, setImpersonationPresetId] = useState<string>(
    typeof metadata.impersonation_preset_id === 'string' ? metadata.impersonation_preset_id : ''
  )
  const [talkativenessOverrides, setTalkativenessOverrides] = useState<Record<string, number>>(
    metadata.talkativeness_overrides ?? {}
  )

  const existingOverride = metadata.group_scenario_override ?? {}
  const [scenarioMode, setScenarioMode] = useState<'individual' | 'member' | 'custom'>(
    existingOverride.mode ?? 'individual'
  )
  const [scenarioMemberId, setScenarioMemberId] = useState<string>(
    existingOverride.member_character_id ?? ''
  )
  const [scenarioCustom, setScenarioCustom] = useState(existingOverride.content ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoadingPresets(true)
    presetsApi.listRegistry({ provider: 'loom', limit: 200 })
      .then((result) => {
        if (!cancelled) setPresetOptions(result.data)
      })
      .catch((err) => {
        if (!cancelled) console.error('[ChatSettings] Failed to load presets:', err)
      })
      .finally(() => {
        if (!cancelled) setLoadingPresets(false)
      })
    return () => { cancelled = true }
  }, [])

  const handleSave = useCallback(async () => {
    if (saving || !chatId) return
    setSaving(true)
    try {
      if ((groupName || '') !== (modalProps?.chatName || '')) {
        await chatsApi.update(chatId, { name: groupName || undefined })
      }

      const metadataPatch: Record<string, any> = {
        impersonation_preset_id: impersonationPresetId || null,
      }

      if (isGroup) {
        metadataPatch.talkativeness_overrides = talkativenessOverrides
        metadataPatch.group_scenario_override = scenarioMode !== 'individual'
          ? {
              mode: scenarioMode,
              ...(scenarioMode === 'member' && scenarioMemberId ? { member_character_id: scenarioMemberId } : {}),
              ...(scenarioMode === 'custom' ? { content: scenarioCustom } : {}),
            }
          : null
      }

      await chatsApi.patchMetadata(chatId, metadataPatch)
      const updatedChat = await chatsApi.get(chatId, { messages: false })
      modalProps?.onSaved?.(updatedChat)
      closeModal()
    } catch (err) {
      console.error('[ChatSettings] Failed to save:', err)
    } finally {
      setSaving(false)
    }
  }, [saving, chatId, groupName, impersonationPresetId, isGroup, talkativenessOverrides, scenarioMode, scenarioMemberId, scenarioCustom, modalProps, closeModal])

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth={520}>
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />
      <div className={styles.header}>
        <h2 className={styles.title}>{isGroup ? 'Group Settings' : 'Chat Settings'}</h2>
      </div>
      <div className={styles.body}>
        <div className={styles.settingsSection}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{isGroup ? 'Group Name' : 'Chat Name'}</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={isGroup ? 'Enter group name...' : 'Enter chat name...'}
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>One-Liner Impersonation Preset</label>
            <select
              className={styles.fieldInput}
              value={impersonationPresetId}
              onChange={(e) => setImpersonationPresetId(e.target.value)}
              disabled={loadingPresets}
            >
              <option value="">Use main preset</option>
              {typeof metadata.impersonation_preset_id === 'string'
                && metadata.impersonation_preset_id
                && !presetOptions.some((preset) => preset.id === metadata.impersonation_preset_id) && (
                  <option value={metadata.impersonation_preset_id}>
                    Deleted preset ({metadata.impersonation_preset_id.slice(0, 8)})
                  </option>
                )}
              {presetOptions.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
              When set, input-bar one-liner impersonation uses this preset's impersonation prompt, assistant impersonation prefill, and parameters without changing the main preset for the chat.
            </div>
          </div>

          {isGroup && (
            <>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Group Scenario</label>
                <select
                  className={styles.fieldInput}
                  value={scenarioMode === 'member' ? `member:${scenarioMemberId}` : scenarioMode}
                  onChange={(e) => {
                    const val = e.target.value
                    if (val === 'individual') {
                      setScenarioMode('individual')
                      setScenarioMemberId('')
                    } else if (val === 'custom') {
                      setScenarioMode('custom')
                      setScenarioMemberId('')
                    } else if (val.startsWith('member:')) {
                      setScenarioMode('member')
                      setScenarioMemberId(val.slice(7))
                    }
                  }}
                >
                  <option value="individual">Use individual scenarios</option>
                  {selectedCharacters.map((char) => (
                    <option key={char.id} value={`member:${char.id}`}>
                      Use {char.name}'s scenario
                    </option>
                  ))}
                  <option value="custom">Custom scenario</option>
                </select>
                {scenarioMode === 'custom' && (
                  <textarea
                    className={styles.fieldInput}
                    value={scenarioCustom}
                    onChange={(e) => setScenarioCustom(e.target.value)}
                    placeholder="Enter a shared scenario for the group..."
                    rows={4}
                    style={{ resize: 'vertical', marginTop: 8 }}
                  />
                )}
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Talkativeness per Character</label>
                {selectedCharacters.map((char) => (
                  <div key={char.id} className={styles.talkSlider}>
                    {char.avatar_path || char.image_id ? (
                      <img
                        src={getCharacterAvatarThumbUrl(char) || undefined}
                        alt={char.name}
                        className={styles.talkAvatar}
                      />
                    ) : (
                      <span className={styles.talkAvatarFallback}>
                        {char.name[0]?.toUpperCase()}
                      </span>
                    )}
                    <span className={styles.talkName}>{char.name}</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={talkativenessOverrides[char.id] ?? 0.5}
                      onChange={(e) =>
                        setTalkativenessOverrides((prev) => ({
                          ...prev,
                          [char.id]: parseFloat(e.target.value),
                        }))
                      }
                      className={styles.talkRange}
                    />
                    <span className={styles.talkValue}>
                      {(talkativenessOverrides[char.id] ?? 0.5).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
      <div className={styles.footer}>
        <Button variant="ghost" onClick={closeModal}>Cancel</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
          Save
        </Button>
      </div>
    </ModalShell>
  )
}

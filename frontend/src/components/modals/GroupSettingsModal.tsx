import { useState, useMemo, useCallback, useEffect } from 'react'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import VoicePicker from '@/components/shared/VoicePicker'
import { chatsApi } from '@/api/chats'
import { presetsApi } from '@/api/presets'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import type { Character, Chat, PresetRegistryItem, VoiceRef } from '@/types/api'
import styles from './GroupChatCreatorModal.module.css'

/**
 * Parse a free-form metadata blob into a VoiceRef. Returns null on shape
 * mismatch so untyped chat.metadata can't crash the editor.
 */
function readVoiceRef(value: unknown): VoiceRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.connectionId !== 'string' || !v.connectionId) return null
  const voice = typeof v.voice === 'string' ? v.voice : ''
  const parameters =
    v.parameters && typeof v.parameters === 'object'
      ? { speed: typeof (v.parameters as any).speed === 'number' ? (v.parameters as any).speed : undefined }
      : undefined
  return { connectionId: v.connectionId, voice, parameters }
}

type GroupCardMode = 'swap' | 'merge_ignore_muted' | 'merge'

export default function GroupSettingsModal() {
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps) as {
    chatId: string
    chatName?: string
    metadata: Record<string, any>
    onSaved?: (chat: Chat) => void
  } | null
  const characters = useStore((s) => s.characters)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const setActiveChatMetadata = useStore((s) => s.setActiveChatMetadata)
  const ttsProfiles = useStore((s) => s.ttsProfiles)
  const setTtsProfiles = useStore((s) => s.setTtsProfiles)
  const setTtsProviders = useStore((s) => s.setTtsProviders)

  const chatId = modalProps?.chatId ?? ''
  const metadata = modalProps?.metadata ?? {}
  const isGroup = metadata.group === true
  const characterIds: string[] = metadata.character_ids ?? []
  // Single-character chats hang voice overrides off the chat's owning
  // character. The modal opens for the active chat, so activeCharacterId is
  // a reliable proxy when this isn't a group.
  const chatCharacter = useMemo(
    () => (!isGroup && activeCharacterId
      ? characters.find((c) => c.id === activeCharacterId) ?? null
      : null),
    [isGroup, activeCharacterId, characters],
  )

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
  const [groupCardMode, setGroupCardMode] = useState<GroupCardMode>(
    metadata.group_card_mode === 'merge_ignore_muted' || metadata.group_card_mode === 'merge'
      ? metadata.group_card_mode
      : 'swap'
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

  // ── Voice overrides ──────────────────────────────────────────────────
  // Only exposed in single-character chats. Group chats use the member-bar
  // context menu to set per-member overrides individually.
  const initialVoiceOverrides = metadata.voiceOverrides && typeof metadata.voiceOverrides === 'object'
    ? metadata.voiceOverrides as Record<string, any>
    : {}
  const [narratorOverride, setNarratorOverride] = useState<VoiceRef | null>(
    readVoiceRef(initialVoiceOverrides.narrator),
  )
  const [characterOverride, setCharacterOverride] = useState<VoiceRef | null>(
    chatCharacter
      ? readVoiceRef(initialVoiceOverrides.characters?.[chatCharacter.id])
      : null,
  )

  const characterDefaultVoice = useMemo(
    () => readVoiceRef(chatCharacter?.extensions?.ttsVoice),
    [chatCharacter],
  )

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

  // Lazy-load TTS profiles / providers if the user opened the modal without
  // visiting global Voice settings first. Voice pickers can't populate
  // without these.
  useEffect(() => {
    if (isGroup) return
    if (ttsProfiles.length === 0) {
      ttsConnectionsApi.list().then((res) => setTtsProfiles(res.data || [])).catch(() => {})
    }
    ttsConnectionsApi.providers().then((res) => setTtsProviders(res.providers || [])).catch(() => {})
  }, [isGroup, ttsProfiles.length, setTtsProfiles, setTtsProviders])

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
        metadataPatch.group_card_mode = groupCardMode === 'swap' ? null : groupCardMode
        metadataPatch.group_scenario_override = scenarioMode !== 'individual'
          ? {
              mode: scenarioMode,
              ...(scenarioMode === 'member' && scenarioMemberId ? { member_character_id: scenarioMemberId } : {}),
              ...(scenarioMode === 'custom' ? { content: scenarioCustom } : {}),
            }
          : null
      } else if (chatCharacter) {
        // Single-character chats: merge the current per-character overrides
        // map so any voices set by other surfaces (future per-chat narrator
        // override hooks, etc.) survive a save here.
        const existing = (initialVoiceOverrides.characters && typeof initialVoiceOverrides.characters === 'object')
          ? { ...initialVoiceOverrides.characters }
          : {}
        if (characterOverride) {
          existing[chatCharacter.id] = characterOverride
        } else {
          delete existing[chatCharacter.id]
        }
        const nextOverrides: Record<string, any> = {}
        if (narratorOverride) nextOverrides.narrator = narratorOverride
        if (Object.keys(existing).length > 0) nextOverrides.characters = existing
        // Send `null` to delete the key entirely when nothing remains; the
        // server treats null as a delete via mergeChatMetadata.
        metadataPatch.voiceOverrides = Object.keys(nextOverrides).length > 0 ? nextOverrides : null
      }

      await chatsApi.patchMetadata(chatId, metadataPatch)
      const updatedChat = await chatsApi.get(chatId, { messages: false })
      // Keep the resolver's view of metadata fresh so any subsequent TTS
      // playback (manual or auto) picks up the new overrides without waiting
      // for a chat reopen.
      setActiveChatMetadata(updatedChat.metadata ?? null)
      modalProps?.onSaved?.(updatedChat)
      closeModal()
    } catch (err) {
      console.error('[ChatSettings] Failed to save:', err)
    } finally {
      setSaving(false)
    }
  }, [saving, chatId, groupName, impersonationPresetId, isGroup, talkativenessOverrides, groupCardMode, scenarioMode, scenarioMemberId, scenarioCustom, chatCharacter, characterOverride, narratorOverride, initialVoiceOverrides, setActiveChatMetadata, modalProps, closeModal])

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

          {!isGroup && chatCharacter && (
            <>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Voice for {chatCharacter.name} (this chat)</label>
                <VoicePicker
                  value={characterOverride}
                  onChange={setCharacterOverride}
                  ariaLabel={`${chatCharacter.name} voice`}
                  clearLabel={characterDefaultVoice ? 'Use character default' : 'Use global default'}
                  portal
                />
                <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                  Overrides {chatCharacter.name}&apos;s voice for this chat only. Leave unset to use
                  {characterDefaultVoice ? ' the character’s default voice.' : ' the global default voice.'}
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Narrator (this chat)</label>
                <VoicePicker
                  value={narratorOverride}
                  onChange={setNarratorOverride}
                  ariaLabel="Narrator voice"
                  clearLabel="Use global narrator"
                  portal
                />
                <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                  Overrides the narrator voice for narration segments in this chat. Falls back to the global narrator voice (or speech voice) when unset.
                </div>
              </div>
            </>
          )}

          {isGroup && (
            <>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>Character Card Macros</label>
                <select
                  className={styles.fieldInput}
                  value={groupCardMode}
                  onChange={(e) => setGroupCardMode(e.target.value as GroupCardMode)}
                >
                  <option value="swap">Swap to active character card</option>
                  <option value="merge_ignore_muted">Merge all unmuted member cards</option>
                  <option value="merge">Merge all member cards</option>
                </select>
                <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                  Controls how character-card macros like {'{{description}}'}, {'{{personality}}'}, and {'{{scenario}}'} resolve during generation.
                </div>
              </div>

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

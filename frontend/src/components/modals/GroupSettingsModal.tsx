import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import VoicePicker from '@/components/shared/VoicePicker'
import { chatsApi } from '@/api/chats'
import { presetsApi } from '@/api/presets'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import type { GroupResponseOrder } from '@/lib/groupResponseOrder'
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
type GroupLorebookMode = 'follow_card_mode' | 'active_character' | 'all_unmuted' | 'all'

export default function GroupSettingsModal() {
  const { t } = useTranslation('modals', { keyPrefix: 'groupSettings' })
  const { t: tc } = useTranslation('common')

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
  const characterIds = useMemo(() => (metadata.character_ids ?? []) as string[], [metadata.character_ids])
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
  const [groupLorebookMode, setGroupLorebookMode] = useState<GroupLorebookMode>(
    metadata.group_lorebook_mode === 'active_character'
      || metadata.group_lorebook_mode === 'all_unmuted'
      || metadata.group_lorebook_mode === 'all'
      ? metadata.group_lorebook_mode
      : 'follow_card_mode'
  )
  const [groupResponseOrder, setGroupResponseOrder] = useState<GroupResponseOrder>(
    metadata.group_response_order === 'random' ? 'random' : 'sequential'
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
  const initialVoiceOverrides = useMemo(
    () => metadata.voiceOverrides && typeof metadata.voiceOverrides === 'object'
      ? metadata.voiceOverrides as Record<string, any>
      : {},
    [metadata.voiceOverrides],
  )
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
        metadataPatch.group_lorebook_mode = groupLorebookMode === 'follow_card_mode' ? null : groupLorebookMode
        metadataPatch.group_response_order = groupResponseOrder === 'sequential' ? null : groupResponseOrder
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
  }, [saving, chatId, groupName, impersonationPresetId, isGroup, talkativenessOverrides, groupCardMode, groupLorebookMode, groupResponseOrder, scenarioMode, scenarioMemberId, scenarioCustom, chatCharacter, characterOverride, narratorOverride, initialVoiceOverrides, setActiveChatMetadata, modalProps, closeModal])

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth={520}>
      <CloseButton onClick={closeModal} variant="solid" position="absolute" />
      <div className={styles.header}>
        <h2 className={styles.title}>{isGroup ? t('title') : t('singleTitle')}</h2>
      </div>
      <div className={styles.body}>
        <div className={styles.settingsSection}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{isGroup ? t('groupName') : t('chatName')}</label>
            <input
              type="text"
              className={styles.fieldInput}
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={isGroup ? t('groupNamePlaceholder') : t('chatNamePlaceholder')}
            />
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>{t('impersonationPreset')}</label>
            <select
              className={styles.fieldInput}
              value={impersonationPresetId}
              onChange={(e) => setImpersonationPresetId(e.target.value)}
              disabled={loadingPresets}
            >
              <option value="">{t('useMainPreset')}</option>
              {typeof metadata.impersonation_preset_id === 'string'
                && metadata.impersonation_preset_id
                && !presetOptions.some((preset) => preset.id === metadata.impersonation_preset_id) && (
                  <option value={metadata.impersonation_preset_id}>
                    {t('deletedPreset', { id: metadata.impersonation_preset_id.slice(0, 8) })}
                  </option>
                )}
              {presetOptions.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
              {t('impersonationHint')}
            </div>
          </div>

          {!isGroup && chatCharacter && (
            <>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('voiceForCharacter', { name: chatCharacter.name })}</label>
                <VoicePicker
                  value={characterOverride}
                  onChange={setCharacterOverride}
                  ariaLabel={t('voiceForCharacter', { name: chatCharacter.name })}
                  clearLabel={characterDefaultVoice ? t('useCharacterDefault') : t('useGlobalDefault')}
                  portal
                />
                <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                  {characterDefaultVoice
                    ? t('voiceHintWithDefault', { name: chatCharacter.name })
                    : t('voiceHintGlobal', { name: chatCharacter.name })}
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('narrator')}</label>
                <VoicePicker
                  value={narratorOverride}
                  onChange={setNarratorOverride}
                  ariaLabel={t('narrator')}
                  clearLabel={t('useGlobalNarrator')}
                  portal
                />
                <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                  {t('narratorHint')}
                </div>
              </div>
            </>
          )}

          {isGroup && (
            <>
              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('characterCardMacros')}</label>
                <select
                  className={styles.fieldInput}
                  value={groupCardMode}
                  onChange={(e) => setGroupCardMode(e.target.value as GroupCardMode)}
                >
                  <option value="swap">{t('cardModeSwap')}</option>
                  <option value="merge_ignore_muted">{t('cardModeMergeUnmuted')}</option>
                  <option value="merge">{t('cardModeMerge')}</option>
                </select>
                <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                  {t('cardMacrosHint')}
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('groupLorebooks')}</label>
                <select
                  className={styles.fieldInput}
                  value={groupLorebookMode}
                  onChange={(e) => setGroupLorebookMode(e.target.value as GroupLorebookMode)}
                >
                  <option value="follow_card_mode">{t('lorebookModeFollow')}</option>
                  <option value="active_character">{t('lorebookModeActive')}</option>
                  <option value="all_unmuted">{t('lorebookModeAllUnmuted')}</option>
                  <option value="all">{t('lorebookModeAll')}</option>
                </select>
                <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                  {t('groupLorebooksHint')}
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('groupResponseOrder')}</label>
                <select
                  className={styles.fieldInput}
                  value={groupResponseOrder}
                  onChange={(e) => setGroupResponseOrder(e.target.value as GroupResponseOrder)}
                >
                  <option value="sequential">{t('responseOrderSequential')}</option>
                  <option value="random">{t('responseOrderRandom')}</option>
                </select>
                <div style={{ fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: 'var(--lumiverse-text-dim)', lineHeight: 1.45 }}>
                  {t('groupResponseOrderHint')}
                </div>
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('groupScenario')}</label>
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
                  <option value="individual">{t('scenarioIndividual')}</option>
                  {selectedCharacters.map((char) => (
                    <option key={char.id} value={`member:${char.id}`}>
                      {t('scenarioFromMemberNamed', { name: char.name })}
                    </option>
                  ))}
                  <option value="custom">{t('scenarioCustom')}</option>
                </select>
                {scenarioMode === 'custom' && (
                  <textarea
                    className={styles.fieldInput}
                    value={scenarioCustom}
                    onChange={(e) => setScenarioCustom(e.target.value)}
                    placeholder={t('scenarioPlaceholder')}
                    rows={4}
                    style={{ resize: 'vertical', marginTop: 8 }}
                  />
                )}
              </div>

              <div className={styles.fieldGroup}>
                <label className={styles.fieldLabel}>{t('talkativenessPerCharacter')}</label>
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
        <Button variant="ghost" onClick={closeModal}>{tc('actions.cancel')}</Button>
        <Button variant="primary" onClick={handleSave} disabled={saving} loading={saving}>
          {tc('actions.save')}
        </Button>
      </div>
    </ModalShell>
  )
}

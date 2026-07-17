import { useState, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { generateApi } from '@/api/generate'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { shouldForceLoomRuntimePreset } from '@/lib/loom/runtimeProfile'
import { Plus, VolumeX, Volume2, UserMinus, AudioLines } from 'lucide-react'
import { IconBolt } from '@tabler/icons-react'
import ContextMenu, { type ContextMenuPos, type ContextMenuEntry } from '@/components/shared/ContextMenu'
import { useLongPress } from '@/hooks/useLongPress'
import useHorizontalScroll from '@/hooks/useHorizontalScroll'
import styles from './GroupChatMemberBar.module.css'
import clsx from 'clsx'

interface GroupChatMemberBarProps {
  chatId: string
}

interface ContextMenuState extends ContextMenuPos {
  characterId: string
}

export default function GroupChatMemberBar({ chatId }: GroupChatMemberBarProps) {
  const { t } = useTranslation('chat')
  const { t: tc } = useTranslation('common')
  const { t: te } = useTranslation('errors')
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const mutedCharacterIds = useStore((s) => s.mutedCharacterIds)
  const characters = useStore((s) => s.characters)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const isStreaming = useStore((s) => s.isStreaming)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)
  const startStreaming = useStore((s) => s.startStreaming)
  const setStreamingError = useStore((s) => s.setStreamingError)
  const toggleMuteCharacter = useStore((s) => s.toggleMuteCharacter)
  const setGroupCharacterIds = useStore((s) => s.setGroupCharacterIds)
  const setMutedCharacterIds = useStore((s) => s.setMutedCharacterIds)
  const openModal = useStore((s) => s.openModal)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [barRef, { canScrollLeft, canScrollRight }] = useHorizontalScroll<HTMLDivElement>()

  const handleForceGenerate = useCallback(
    async (characterId: string) => {
      if (isStreaming || mutedCharacterIds.includes(characterId)) return
      try {
        const presetId = getActivePresetForGeneration() || undefined
        const res = await generateApi.start({
          chat_id: chatId,
          target_character_id: characterId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: presetId,
          force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
          generation_type: 'normal',
        })
        startStreaming(res.generationId)
      } catch (err: any) {
        console.error('[GroupMemberBar] Force generate failed:', err)
        const msg = err?.body?.error || err?.message || te('failedToGenerate')
        setStreamingError(msg)
      }
    },
    [chatId, isStreaming, mutedCharacterIds, activeProfileId, activePersonaId, activeCharacterId, getActivePresetForGeneration, startStreaming, setStreamingError, te]
  )

  const openContextMenu = useCallback((characterId: string, pos: ContextMenuPos) => {
    setContextMenu({ ...pos, characterId })
  }, [])

  const handleToggleMute = useCallback(
    async (characterId: string) => {
      setContextMenu(null)
      const newMuted = toggleMuteCharacter(characterId)
      const isMuted = newMuted.includes(characterId)
      try {
        if (isMuted) {
          await chatsApi.muteCharacter(chatId, characterId)
        } else {
          await chatsApi.unmuteCharacter(chatId, characterId)
        }
      } catch (err) {
        console.error('[GroupMemberBar] Mute toggle failed:', err)
        toggleMuteCharacter(characterId)
      }
    },
    [chatId, toggleMuteCharacter]
  )

  const handleRemoveMember = useCallback(
    (characterId: string) => {
      const char = characters.find((c) => c.id === characterId)
      setContextMenu(null)

      if (groupCharacterIds.length <= 2) {
        toast.warning(t('groupChat.cannotRemoveMinMembers'))
        return
      }

      openModal('confirm', {
        title: t('groupChat.removeFromGroup'),
        message: t('groupChat.removeConfirmMessage', { name: char?.name || t('characterFallback') }),
        variant: 'danger',
        confirmText: t('groupChat.removeConfirm'),
        onConfirm: async () => {
          try {
            await chatsApi.removeMember(chatId, characterId)
            const newIds = groupCharacterIds.filter((id) => id !== characterId)
            setGroupCharacterIds(newIds)
            // Also clean up muted list locally
            if (mutedCharacterIds.includes(characterId)) {
              setMutedCharacterIds(mutedCharacterIds.filter((id) => id !== characterId))
            }
            toast.success(t('groupChat.removedFromGroup', { name: char?.name || t('characterFallback') }))
          } catch (err: any) {
            console.error('[GroupMemberBar] Remove member failed:', err)
            toast.error(err?.body?.error || t('groupChat.failedRemoveMember'))
          }
        },
      })
    },
    [chatId, characters, groupCharacterIds, mutedCharacterIds, setGroupCharacterIds, setMutedCharacterIds, openModal, t]
  )

  const handleForceGenerateFromMenu = useCallback(
    (characterId: string) => {
      setContextMenu(null)
      handleForceGenerate(characterId)
    },
    [handleForceGenerate]
  )

  const handleOpenVoiceModal = useCallback(
    (characterId: string) => {
      setContextMenu(null)
      openModal('memberVoice', { chatId, characterId })
    },
    [chatId, openModal],
  )

  // Set of group member ids that have a per-chat voice override applied.
  // Used to badge the avatars so an override is discoverable at a glance.
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const overrideIds = useMemo(() => {
    const overrides = activeChatMetadata?.voiceOverrides
    if (!overrides || typeof overrides !== 'object') return new Set<string>()
    const chars = (overrides as any).characters
    if (!chars || typeof chars !== 'object') return new Set<string>()
    return new Set(Object.keys(chars).filter((id) => !!chars[id]))
  }, [activeChatMetadata])

  const contextIsMuted = contextMenu ? mutedCharacterIds.includes(contextMenu.characterId) : false

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    if (!contextMenu) return []
    const cid = contextMenu.characterId
    return [
      {
        key: 'force-gen',
        label: t('groupChat.forceGenerate'),
        icon: <IconBolt size={13} />,
        onClick: () => handleForceGenerateFromMenu(cid),
        disabled: isStreaming || contextIsMuted,
      },
      {
        key: 'toggle-mute',
        label: contextIsMuted ? t('groupChat.unmute') : t('groupChat.mute'),
        icon: contextIsMuted ? <Volume2 size={13} /> : <VolumeX size={13} />,
        onClick: () => handleToggleMute(cid),
      },
      {
        key: 'voice',
        label: overrideIds.has(cid) ? t('groupChat.voiceOverridden') : t('groupChat.voiceMenu'),
        icon: <AudioLines size={13} />,
        onClick: () => handleOpenVoiceModal(cid),
      },
      { key: 'div', type: 'divider' as const },
      {
        key: 'remove',
        label: t('groupChat.removeFromGroup'),
        icon: <UserMinus size={13} />,
        onClick: () => handleRemoveMember(cid),
        danger: true,
      },
    ]
  }, [contextMenu, contextIsMuted, isStreaming, overrideIds, handleForceGenerateFromMenu, handleToggleMute, handleOpenVoiceModal, handleRemoveMember, t])

  if (groupCharacterIds.length === 0) return null

  return (
    <div className={styles.barWrapper}>
      {canScrollLeft && <div className={clsx(styles.scrollFade, styles.scrollFadeLeft)} aria-hidden="true" />}
      {canScrollRight && <div className={clsx(styles.scrollFade, styles.scrollFadeRight)} aria-hidden="true" />}
      <div ref={barRef} className={styles.bar}>
        {groupCharacterIds.map((id) => (
          <MemberButton
            key={id}
            id={id}
            chatId={chatId}
            characters={characters}
            isActive={id === activeGroupCharacterId}
            isMuted={mutedCharacterIds.includes(id)}
            isStreaming={isStreaming}
            hasVoiceOverride={overrideIds.has(id)}
            onForceGenerate={handleForceGenerate}
            onOpenContextMenu={openContextMenu}
          />
        ))}

        <button
          type="button"
          className={styles.addMemberBtn}
          onClick={() => openModal('addGroupMember', { chatId })}
          title={t('groupChat.addMember')}
        >
          <Plus size={16} />
        </button>

        <ContextMenu
          position={contextMenu}
          items={menuItems}
          onClose={() => setContextMenu(null)}
        />
      </div>
    </div>
  )
}

interface MemberButtonProps {
  id: string
  chatId: string
  characters: any[]
  isActive: boolean
  isMuted: boolean
  isStreaming: boolean
  hasVoiceOverride: boolean
  onForceGenerate: (id: string) => void
  onOpenContextMenu: (id: string, pos: ContextMenuPos) => void
}

function MemberButton({ id, characters, isActive, isMuted, isStreaming, hasVoiceOverride, onForceGenerate, onOpenContextMenu }: MemberButtonProps) {
  const { t } = useTranslation('chat')
  const char = characters.find((c: any) => c.id === id)
  const talk = char?.talkativeness ?? 0.5
  const avatarUrl = getCharacterAvatarThumbUrl(char)

  const longPress = useLongPress({
    onLongPress: (pos) => onOpenContextMenu(id, pos),
  })

  return (
    <button
      type="button"
      className={clsx(
        styles.member,
        isActive && styles.memberActive,
        isMuted && styles.memberMuted,
        talk >= 0.7 && styles.talkHigh,
        talk <= 0.3 && styles.talkLow
      )}
      onClick={() => onForceGenerate(id)}
      {...longPress}
      title={char?.name || t('characterFallback')}
      disabled={isStreaming}
    >
      {char?.avatar_path || char?.image_id ? (
        <img
          src={avatarUrl || undefined}
          alt={char?.name}
          className={styles.avatar}
          loading="lazy"
        />
      ) : (
        <span className={styles.avatarFallback}>
          {char?.name?.[0]?.toUpperCase() || '?'}
        </span>
      )}
      <span className={styles.name}>{char?.name || t('unknown')}</span>
      {isMuted && <span className={styles.mutedBadge} />}
      {hasVoiceOverride && (
        <span className={styles.voiceBadge} aria-hidden="true" title={t('groupChat.customVoice')}>
          <AudioLines size={9} strokeWidth={2.5} />
        </span>
      )}
    </button>
  )
}

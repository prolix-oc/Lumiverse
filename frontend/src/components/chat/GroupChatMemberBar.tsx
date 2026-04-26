import { useState, useCallback, useMemo } from 'react'
import { useStore } from '@/store'
import { chatsApi } from '@/api/chats'
import { generateApi } from '@/api/generate'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { Plus, VolumeX, Volume2, UserMinus } from 'lucide-react'
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
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const mutedCharacterIds = useStore((s) => s.mutedCharacterIds)
  const characters = useStore((s) => s.characters)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const isStreaming = useStore((s) => s.isStreaming)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
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
        const res = await generateApi.start({
          chat_id: chatId,
          target_character_id: characterId,
          connection_id: activeProfileId || undefined,
          persona_id: activePersonaId || undefined,
          preset_id: getActivePresetForGeneration() || undefined,
          generation_type: 'normal',
        })
        startStreaming(res.generationId)
      } catch (err: any) {
        console.error('[GroupMemberBar] Force generate failed:', err)
        const msg = err?.body?.error || err?.message || 'Failed to generate'
        setStreamingError(msg)
      }
    },
    [chatId, isStreaming, mutedCharacterIds, activeProfileId, activePersonaId, getActivePresetForGeneration, startStreaming, setStreamingError]
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
        toast.warning('Cannot remove — group chats require at least 2 members')
        return
      }

      openModal('confirm', {
        title: 'Remove from Group',
        message: `Remove ${char?.name || 'this character'} from the group chat?`,
        variant: 'danger',
        confirmText: 'Remove',
        onConfirm: async () => {
          try {
            await chatsApi.removeMember(chatId, characterId)
            const newIds = groupCharacterIds.filter((id) => id !== characterId)
            setGroupCharacterIds(newIds)
            // Also clean up muted list locally
            if (mutedCharacterIds.includes(characterId)) {
              setMutedCharacterIds(mutedCharacterIds.filter((id) => id !== characterId))
            }
            toast.success(`${char?.name || 'Character'} removed from group`)
          } catch (err: any) {
            console.error('[GroupMemberBar] Remove member failed:', err)
            toast.error(err?.body?.error || 'Failed to remove member')
          }
        },
      })
    },
    [chatId, characters, groupCharacterIds, mutedCharacterIds, setGroupCharacterIds, setMutedCharacterIds, openModal]
  )

  const handleForceGenerateFromMenu = useCallback(
    (characterId: string) => {
      setContextMenu(null)
      handleForceGenerate(characterId)
    },
    [handleForceGenerate]
  )

  if (groupCharacterIds.length === 0) return null

  const contextIsMuted = contextMenu ? mutedCharacterIds.includes(contextMenu.characterId) : false

  const menuItems: ContextMenuEntry[] = useMemo(() => {
    if (!contextMenu) return []
    const cid = contextMenu.characterId
    return [
      {
        key: 'force-gen',
        label: 'Force Generate',
        icon: <IconBolt size={13} />,
        onClick: () => handleForceGenerateFromMenu(cid),
        disabled: isStreaming || contextIsMuted,
      },
      {
        key: 'toggle-mute',
        label: contextIsMuted ? 'Unmute' : 'Mute',
        icon: contextIsMuted ? <Volume2 size={13} /> : <VolumeX size={13} />,
        onClick: () => handleToggleMute(cid),
      },
      { key: 'div', type: 'divider' as const },
      {
        key: 'remove',
        label: 'Remove from Group',
        icon: <UserMinus size={13} />,
        onClick: () => handleRemoveMember(cid),
        danger: true,
      },
    ]
  }, [contextMenu, contextIsMuted, isStreaming, handleForceGenerateFromMenu, handleToggleMute, handleRemoveMember])

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
            onForceGenerate={handleForceGenerate}
            onOpenContextMenu={openContextMenu}
          />
        ))}

        <button
          type="button"
          className={styles.addMemberBtn}
          onClick={() => openModal('addGroupMember', { chatId })}
          title="Add member to group"
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
  onForceGenerate: (id: string) => void
  onOpenContextMenu: (id: string, pos: ContextMenuPos) => void
}

function MemberButton({ id, characters, isActive, isMuted, isStreaming, onForceGenerate, onOpenContextMenu }: MemberButtonProps) {
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
      title={char?.name || 'Character'}
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
      <span className={styles.name}>{char?.name || 'Unknown'}</span>
      {isMuted && <span className={styles.mutedBadge} />}
    </button>
  )
}

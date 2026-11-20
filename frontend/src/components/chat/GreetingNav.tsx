import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { MessageCircle } from 'lucide-react'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { chatsApi } from '@/api/chats'
import GreetingPickerModal from '@/components/modals/GreetingPickerModal'
import type { Message, Character } from '@/types/api'
import styles from './GreetingNav.module.css'
import clsx from 'clsx'
import { applyChatAppearance } from '@/lib/chatAppearance'
import { buildGreetingChatTarget, shouldStartNewChatForGreeting } from '@/lib/greetingChatTarget'
import { toast } from '@/lib/toast'

interface GreetingNavProps {
  message: Message
  chatId: string
  variant?: 'minimal' | 'bubble'
}

export default function GreetingNav({ message, chatId, variant = 'minimal' }: GreetingNavProps) {
  const { t } = useTranslation('chat')
  const navigate = useNavigate()
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const totalChatLength = useStore((s) => s.totalChatLength)
  const characters = useStore((s) => s.characters)
  const updateMessage = useStore((s) => s.updateMessage)
  const setHighlightedMessageId = useStore((s) => s.setHighlightedMessageId)
  const [character, setCharacter] = useState<Character | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const greetingCharId = isGroupChat
    ? (typeof message.extra?.greeting_character_id === 'string' ? message.extra.greeting_character_id : activeCharacterId)
    : activeCharacterId

  useEffect(() => {
    if (!greetingCharId) return
    const cached = characters.find((c) => c.id === greetingCharId)
    if (cached) {
      setCharacter(cached)
      return
    }
    charactersApi
      .get(greetingCharId)
      .then(setCharacter)
      .catch(() => setCharacter(null))
  }, [greetingCharId, characters])

  const greetingCount = character
    ? 1 + (character.alternate_greetings?.length || 0)
    : 0

  const handleSelect = useCallback(
    async (greetingIndex: number) => {
      if (!character) return

      // Once a conversation has progressed, its opening greeting is part of
      // the history. Choosing another greeting should open a fresh chat rather
      // than rewriting that history underneath the later messages.
      if (shouldStartNewChatForGreeting(totalChatLength)) {
        setPickerOpen(false)
        const toastId = toast.info(t('toast.creatingChatCortex'), {
          title: t('toast.startingChat'),
          duration: 60_000,
          dismissible: false,
        })
        try {
          const target = buildGreetingChatTarget({
            characterId: character.id,
            greetingIndex,
            isGroupChat,
            groupCharacterIds,
            greetingCharacterId: greetingCharId,
          })
          const nextChat = target.kind === 'group'
            ? await chatsApi.createGroup(target.input)
            : await chatsApi.create(target.input)
          toast.dismiss(toastId)
          navigate(`/chat/${nextChat.id}`)
        } catch (err) {
          toast.dismiss(toastId)
          console.error('[GreetingNav] Failed to create chat for greeting:', err)
          toast.error(t('toast.failedCreateChat'))
        }
        return
      }

      const greetings = [character.first_mes, ...(character.alternate_greetings || [])]
      const newContent = greetings[greetingIndex]
      const contentChanged = !!newContent && newContent !== message.content
      if (contentChanged) {
        updateMessage(message.id, { content: newContent })
      }

      try {
        await applyChatAppearance(chatId, character, {
          type: 'greeting',
          greeting_index: greetingIndex,
          ...(isGroupChat && greetingCharId ? { character_id: greetingCharId } : {}),
        })
      } catch (err) {
        if (contentChanged) updateMessage(message.id, { content: message.content })
        console.error('[GreetingNav] Failed to update greeting:', err)
        toast.error(err instanceof Error ? err.message : 'Failed to change greeting')
      }

      setPickerOpen(false)

      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${message.id}"]`)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        setHighlightedMessageId(message.id)
        window.setTimeout(() => {
          const current = useStore.getState().highlightedMessageId
          if (current === message.id) setHighlightedMessageId(null)
        }, 1700)
      })
    },
    [
      character,
      chatId,
      greetingCharId,
      groupCharacterIds,
      isGroupChat,
      message.id,
      message.content,
      navigate,
      setHighlightedMessageId,
      t,
      totalChatLength,
      updateMessage,
    ]
  )

  if (!character || !character.alternate_greetings?.length) return null

  return (
    <>
      <button
        type="button"
        className={clsx(styles.indicator, variant === 'bubble' && styles.indicatorBubble)}
        onClick={() => setPickerOpen(true)}
        title={t('greetingNav.browseGreetings')}
      >
        <MessageCircle size={13} />
        <span>{t('greetingNav.label')}</span>
        <span className={styles.badge}>{greetingCount}</span>
      </button>

      {pickerOpen && (
        <GreetingPickerModal
          character={character}
          activeContent={message.content}
          activeGreetingIndex={message.extra?.greeting_index}
          onSelect={handleSelect}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </>
  )
}

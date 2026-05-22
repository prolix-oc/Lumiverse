import { useState, useEffect, useCallback } from 'react'
import { MessageCircle } from 'lucide-react'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { messagesApi } from '@/api/chats'
import GreetingPickerModal from '@/components/modals/GreetingPickerModal'
import type { Message, Character } from '@/types/api'
import styles from './GreetingNav.module.css'
import clsx from 'clsx'

interface GreetingNavProps {
  message: Message
  chatId: string
  variant?: 'minimal' | 'bubble'
}

export default function GreetingNav({ message, chatId, variant = 'minimal' }: GreetingNavProps) {
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const characters = useStore((s) => s.characters)
  const updateMessage = useStore((s) => s.updateMessage)
  const setHighlightedMessageId = useStore((s) => s.setHighlightedMessageId)
  const [character, setCharacter] = useState<Character | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // In group chats, use the character_id from the message's extra field
  const greetingCharId = isGroupChat
    ? (typeof message.extra?.character_id === 'string' ? message.extra.character_id : activeCharacterId)
    : activeCharacterId

  useEffect(() => {
    if (!greetingCharId) return
    // Try store first, then fetch
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
      const greetings = [character.first_mes, ...(character.alternate_greetings || [])]
      const newContent = greetings[greetingIndex]
      const contentChanged = !!newContent && newContent !== message.content
      if (contentChanged) {
        try {
          const updated = await messagesApi.update(chatId, message.id, { content: newContent })
          updateMessage(updated.id, updated)
        } catch (err) {
          console.error('[GreetingNav] Failed to update greeting:', err)
        }
      }
      setPickerOpen(false)

      // Let the modal unmount before scrolling so the greeting isn't obscured.
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${message.id}"]`)
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
        setHighlightedMessageId(message.id)
        window.setTimeout(() => {
          // Only clear if we're still the highlighted one — avoid stomping
          // a newer highlight target.
          const current = useStore.getState().highlightedMessageId
          if (current === message.id) setHighlightedMessageId(null)
        }, 1700)
      })
    },
    [character, chatId, message.id, message.content, setHighlightedMessageId, updateMessage]
  )

  if (!character || !character.alternate_greetings?.length) return null

  return (
    <>
      <button
        type="button"
        className={clsx(styles.indicator, variant === 'bubble' && styles.indicatorBubble)}
        onClick={() => setPickerOpen(true)}
        title="Browse alternate greetings"
      >
        <MessageCircle size={13} />
        <span>Greetings</span>
        <span className={styles.badge}>{greetingCount}</span>
      </button>

      {pickerOpen && (
        <GreetingPickerModal
          character={character}
          activeContent={message.content}
          onSelect={handleSelect}
          onCancel={() => setPickerOpen(false)}
        />
      )}
    </>
  )
}

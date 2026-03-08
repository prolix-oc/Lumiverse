import { useEffect, useMemo } from 'react'
import { useParams } from 'react-router'
import { AnimatePresence } from 'motion/react'
import { UserRound } from 'lucide-react'
import { useStore } from '@/store'
import { chatsApi, messagesApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
import MessageList from './MessageList'
import InputArea from './InputArea'
import ScrollToBottom from './ScrollToBottom'
import CouncilPill from './CouncilPill'
import PortraitPanel from './PortraitPanel'
import styles from './ChatView.module.css'
import clsx from 'clsx'

export default function ChatView() {
  const { chatId } = useParams<{ chatId: string }>()
  const setActiveChat = useStore((s) => s.setActiveChat)
  const setMessages = useStore((s) => s.setMessages)
  const messages = useStore((s) => s.messages)
  const isStreaming = useStore((s) => s.isStreaming)
  const activeChatId = useStore((s) => s.activeChatId)
  const portraitPanelOpen = useStore((s) => s.portraitPanelOpen)
  const togglePortraitPanel = useStore((s) => s.togglePortraitPanel)
  const portraitPanelSide = useStore((s) => s.portraitPanelSide)
  const sceneBackground = useStore((s) => s.sceneBackground)
  const imageGeneration = useStore((s) => s.imageGeneration)
  const chatWidthMode = useStore((s) => s.chatWidthMode)
  const chatContentMaxWidth = useStore((s) => s.chatContentMaxWidth)

  const innerStyle = useMemo(() => {
    switch (chatWidthMode) {
      case 'comfortable': return { '--lumiverse-chat-content-width': '1000px' } as React.CSSProperties
      case 'compact': return { '--lumiverse-chat-content-width': '760px' } as React.CSSProperties
      case 'custom': return { '--lumiverse-chat-content-width': `${chatContentMaxWidth}px` } as React.CSSProperties
      default: return undefined
    }
  }, [chatWidthMode, chatContentMaxWidth])

  // Load chat and messages
  useEffect(() => {
    if (!chatId) return

    let cancelled = false

    const loadChat = async () => {
      try {
        const chat = await chatsApi.get(chatId)
        if (cancelled) return
        setActiveChat(chatId, chat.character_id)

        // Detect group chat and initialize group state
        const isGroup = chat.metadata?.group === true
        const groupCharIds: string[] = isGroup ? (chat.metadata.character_ids || []) : []
        if (isGroup && groupCharIds.length > 0) {
          useStore.getState().setGroupChat(true, groupCharIds)
          // Load all group characters into the store
          const store = useStore.getState()
          const missingIds = groupCharIds.filter((id) => !store.characters.some((c) => c.id === id))
          if (missingIds.length > 0) {
            Promise.all(missingIds.map((id) => charactersApi.get(id).catch(() => null)))
              .then((chars) => {
                if (!cancelled) {
                  const valid = chars.filter(Boolean) as import('@/types/api').Character[]
                  if (valid.length > 0) useStore.getState().addCharacters(valid)
                }
              })
          }
        } else {
          useStore.getState().clearGroupChat()
          // Ensure the active character is in the store for name resolution
          if (chat.character_id) {
            const store = useStore.getState()
            if (!store.characters.some((c) => c.id === chat.character_id)) {
              charactersApi.get(chat.character_id).then((char) => {
                if (!cancelled) useStore.getState().addCharacter(char)
              }).catch(() => {})
            }
          }
        }

        // Load the last batch of messages (tail-first)
        const PAGE_SIZE = 100
        // First request: try loading PAGE_SIZE messages from the start
        const first = await messagesApi.list(chatId, { limit: PAGE_SIZE, offset: 0 })
        if (cancelled) return
        if (first.total <= PAGE_SIZE) {
          // Small chat — we have all messages already
          setMessages(first.data, first.total)
        } else {
          // Large chat — load from the tail
          const tailOffset = Math.max(0, first.total - PAGE_SIZE)
          const tail = await messagesApi.list(chatId, { limit: PAGE_SIZE, offset: tailOffset })
          if (cancelled) return
          setMessages(tail.data, tail.total)
        }
      } catch (err) {
        console.error('[ChatView] Failed to load chat:', err)
      }
    }

    loadChat()

    return () => {
      cancelled = true
    }
  }, [chatId, setActiveChat, setMessages])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      setActiveChat(null)
      useStore.getState().clearGroupChat()
    }
  }, [setActiveChat])

  if (!chatId) return null

  return (
    <div
      className={clsx(
        styles.container,
        isStreaming && styles.streaming,
        sceneBackground && styles.hasSceneBackground
      )}
    >
      <div
        className={styles.sceneBackgroundLayer}
        style={{
          backgroundImage: sceneBackground ? `url("${sceneBackground}")` : 'none',
          opacity: sceneBackground ? Math.max(0, Math.min(1, imageGeneration.backgroundOpacity ?? 0.35)) : 0,
          transitionDuration: `${Math.max(100, imageGeneration.fadeTransitionMs ?? 800)}ms`,
        }}
      />
      <div
        className={styles.sceneTextContextLayer}
        style={{
          opacity: sceneBackground ? 1 : 0,
          transitionDuration: `${Math.max(100, imageGeneration.fadeTransitionMs ?? 800)}ms`,
        }}
      />
      <div className={styles.body}>
        {portraitPanelSide === 'left' && (
          <>
            <AnimatePresence>
              {portraitPanelOpen && <PortraitPanel side="left" />}
            </AnimatePresence>
            <button
              type="button"
              className={clsx(styles.portraitTab, styles.portraitTabLeft, portraitPanelOpen && styles.portraitTabActive)}
              onClick={togglePortraitPanel}
              aria-label="Toggle portrait panel"
            >
              <UserRound size={14} />
            </button>
          </>
        )}

        <div className={styles.chatColumn}>
          <div className={styles.chatColumnInner} style={innerStyle}>
            <MessageList messages={messages} chatId={chatId} isStreaming={isStreaming} />
            <ScrollToBottom />
            <CouncilPill />
            <InputArea chatId={chatId} />
          </div>
        </div>

        {portraitPanelSide === 'right' && (
          <>
            <button
              type="button"
              className={clsx(styles.portraitTab, styles.portraitTabRight, portraitPanelOpen && styles.portraitTabActive)}
              onClick={togglePortraitPanel}
              aria-label="Toggle portrait panel"
            >
              <UserRound size={14} />
            </button>
            <AnimatePresence>
              {portraitPanelOpen && <PortraitPanel side="right" />}
            </AnimatePresence>
          </>
        )}
      </div>
    </div>
  )
}

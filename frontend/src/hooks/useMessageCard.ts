import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useStore } from '@/store'
import { messagesApi, chatsApi } from '@/api/chats'
import { getCharacterAvatarThumbUrlById, getCharacterAvatarLargeUrlById, getCharacterAvatarUrlById, getPersonaAvatarThumbUrlById, getPersonaAvatarLargeUrlById, getPersonaAvatarUrlById } from '@/lib/avatarUrls'
import { imagesApi } from '@/api/images'
import type { Message } from '@/types/api'
import type { GenerationMetrics } from '@/types/ws-events'

/**
 * Strip thinking/reasoning tags from content and extract the thoughts.
 * Handles <think>, <thinking>, <reasoning> and their closing variants.
 * Also handles unclosed tags (e.g. when generation was interrupted mid-thought).
 * Returns the cleaned content and extracted reasoning text.
 */
function parseThinkingTags(content: string): { cleaned: string; thoughts: string } {
  let thoughts = ''

  // First pass: extract complete (closed) reasoning blocks
  const tagPattern = /\s*<(think|thinking|reasoning)>([\s\S]*?)<\/\1>\s*/gi
  let cleaned = content.replace(tagPattern, (_match, _tag, inner) => {
    thoughts += (thoughts ? '\n\n' : '') + inner.trim()
    return ''
  })

  // Second pass: handle unclosed reasoning tags (interrupted generation)
  const unclosedPattern = /\s*<(think|thinking|reasoning)>([\s\S]*)$/i
  cleaned = cleaned.replace(unclosedPattern, (_match, _tag, inner) => {
    const trimmed = inner.trim()
    if (trimmed) {
      thoughts += (thoughts ? '\n\n' : '') + trimmed
    }
    return ''
  })

  return { cleaned: cleaned.trim(), thoughts }
}

export function useMessageCard(message: Message, chatId: string) {
  const navigate = useNavigate()
  const editingMessageId = useStore((s) => s.editingMessageId)
  const setEditingMessageId = useStore((s) => s.setEditingMessageId)
  const updateMessage = useStore((s) => s.updateMessage)
  const addToast = useStore((s) => s.addToast)
  const isEditing = editingMessageId === message.id
  const [editContent, setEditContent] = useState('')
  const [editReasoning, setEditReasoning] = useState('')
  const [showReasoningEditor, setShowReasoningEditor] = useState(false)
  const hadReasoningRef = useRef(false)
  const wasEditingRef = useRef(false)
  const removeMessage = useStore((s) => s.removeMessage)
  const openModal = useStore((s) => s.openModal)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const isStreaming = useStore((s) => s.isStreaming)
  const messages = useStore((s) => s.messages)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const personas = useStore((s) => s.personas)
  const autoParse = useStore((s) => s.reasoningSettings.autoParse)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const isBubbleMode = useStore((s) => s.chatSheldDisplayMode) === 'bubble'

  const streamingContent = useStore((s) => s.streamingContent)
  const streamingReasoning = useStore((s) => s.streamingReasoning)
  const streamingReasoningDuration = useStore((s) => s.streamingReasoningDuration)
  const streamingReasoningStartedAt = useStore((s) => s.streamingReasoningStartedAt)
  const regeneratingMessageId = useStore((s) => s.regeneratingMessageId)
  const streamingGenerationType = useStore((s) => s.streamingGenerationType)

  const isUser = message.is_user
  const isLastMessage = messages.length > 0 && messages[messages.length - 1].id === message.id
  const isRegenerating = isStreaming && regeneratingMessageId === message.id
  const isContinuing = isStreaming && streamingGenerationType === 'continue' && isLastMessage && !isUser
  const isActivelyStreaming = isRegenerating || isContinuing || (isStreaming && isLastMessage && !isUser && !regeneratingMessageId)
  // When this message is being regenerated, show streaming content in-place
  // instead of the saved (blank) swipe content.
  // When continuing, append streaming content to the existing message content.
  // For non-regeneration streaming (normal generation), the streaming bubble
  // in MessageList handles display to avoid race conditions with MESSAGE_SENT.
  const rawContent = isRegenerating
    ? (streamingContent || message.content)
    : isContinuing
      ? message.content + (streamingContent || '')
      : message.content

  // Auto-parse: strip thinking tags from assistant messages and extract as reasoning
  const { displayContent, parsedReasoning } = useMemo(() => {
    if (!autoParse || isUser) return { displayContent: rawContent, parsedReasoning: '' }
    const { cleaned, thoughts } = parseThinkingTags(rawContent)
    return { displayContent: cleaned || rawContent, parsedReasoning: thoughts }
  }, [rawContent, autoParse, isUser])

  // API-level reasoning takes priority; during regeneration use streaming reasoning;
  // fall back to parsed inline reasoning
  const apiReasoning = message.extra?.reasoning as string | undefined
  const reasoning = isRegenerating
    ? (streamingReasoning || parsedReasoning || undefined)
    : isContinuing
      ? (streamingReasoning || apiReasoning || parsedReasoning || undefined)
      : (apiReasoning || parsedReasoning || undefined)
  const reasoningDuration = isActivelyStreaming
    ? (streamingReasoningDuration ?? undefined)
    : (message.extra?.reasoningDuration as number | undefined)
  const reasoningStartedAt = isActivelyStreaming
    ? (streamingReasoningStartedAt ?? undefined)
    : undefined
  const tokenCount = message.extra?.tokenCount as number | undefined
  const generationMetrics = message.extra?.generationMetrics as GenerationMetrics | undefined

  const isGroupChat = useStore((s) => s.isGroupChat)

  const userPersonaId = typeof message.extra?.persona_id === 'string' ? message.extra.persona_id : null
  const messagePersona = userPersonaId ? personas.find((p) => p.id === userPersonaId) : null
  const activePersona = activePersonaId ? personas.find((p) => p.id === activePersonaId) ?? null : null
  const activeCharacter = activeCharacterId ? characters.find((c) => c.id === activeCharacterId) : null

  // In group chats, assistant messages carry character_id in message.extra
  const messageCharacterId = !isUser && isGroupChat
    ? (typeof message.extra?.character_id === 'string' ? message.extra.character_id : null)
    : null
  const effectiveCharacter = messageCharacterId
    ? characters.find((c) => c.id === messageCharacterId) ?? activeCharacter
    : activeCharacter

  const normalizedMessageName = (message.name || '').trim()
  const isGenericAssistantName = normalizedMessageName.length === 0 || /^assistant$/i.test(normalizedMessageName)
  const isGenericUserName = normalizedMessageName.length === 0 || /^user$/i.test(normalizedMessageName)

  const displayName = isUser
    ? (messagePersona?.name || (isGenericUserName ? (personas.find((p) => p.id === activePersonaId)?.name || 'User') : normalizedMessageName))
    : ((isGenericAssistantName ? effectiveCharacter?.name : normalizedMessageName) || effectiveCharacter?.name || 'Assistant')

  const effectiveCharId = messageCharacterId || activeCharacterId
  const getCharAvatarUrl = isBubbleMode ? getCharacterAvatarLargeUrlById : getCharacterAvatarThumbUrlById
  const getPersonaAvatarUrl = isBubbleMode ? getPersonaAvatarLargeUrlById : getPersonaAvatarThumbUrlById
  const getImageUrl = isBubbleMode ? imagesApi.largeUrl : imagesApi.smallUrl

  const avatarUrl = isUser
    ? getPersonaAvatarUrl(
        userPersonaId ?? activePersona?.id ?? null,
        messagePersona?.image_id ?? activePersona?.image_id ?? null
      )
    : (activeChatAvatarId && effectiveCharId === activeCharacterId)
      ? getImageUrl(activeChatAvatarId)
      : getCharAvatarUrl(effectiveCharId, effectiveCharacter?.image_id ?? null)

  // Full-size avatar URL for lightbox/floating viewer (no resize)
  const fullAvatarUrl = isUser
    ? getPersonaAvatarUrlById(
        userPersonaId ?? activePersona?.id ?? null,
        messagePersona?.image_id ?? activePersona?.image_id ?? null
      )
    : (activeChatAvatarId && effectiveCharId === activeCharacterId)
      ? imagesApi.url(activeChatAvatarId)
      : getCharacterAvatarUrlById(effectiveCharId, effectiveCharacter?.image_id ?? null)

  const macroUserName = useMemo(() => {
    const fallback = activePersona?.name ?? 'User'

    if (isUser) {
      return message.name || fallback
    }

    const idx = messages.findIndex((m) => m.id === message.id)
    const limit = idx >= 0 ? idx : messages.length
    for (let i = limit - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.is_user && m.name?.trim()) return m.name
    }

    const firstUser = messages.find((m) => m.is_user && m.name?.trim())
    return firstUser?.name || fallback
  }, [messages, message.id, message.name, isUser, activePersona])

  const initializeEdit = useCallback(() => {
    if (!message.is_user) {
      // For assistant messages, separate reasoning from content
      const apiReasoning = typeof message.extra?.reasoning === 'string' ? message.extra.reasoning : ''
      const { cleaned, thoughts } = parseThinkingTags(message.content)
      const reasoningText = apiReasoning || thoughts
      const hasReasoning = !!reasoningText
      hadReasoningRef.current = hasReasoning
      setShowReasoningEditor(hasReasoning)
      setEditReasoning(reasoningText)
      // Clean content: strip think tags and leading blank lines
      setEditContent(cleaned.replace(/^\n{2,}/, ''))
    } else {
      setEditContent(message.content)
      setEditReasoning('')
      setShowReasoningEditor(false)
      hadReasoningRef.current = false
    }
  }, [message.content, message.is_user, message.extra])

  // Populate edit fields on the false→true transition of isEditing,
  // so externally-triggered edits (keyboard shortcut) seed the fields too.
  useEffect(() => {
    if (isEditing && !wasEditingRef.current) {
      initializeEdit()
    }
    wasEditingRef.current = isEditing
  }, [isEditing, initializeEdit])

  const handleEdit = useCallback(() => {
    setEditingMessageId(message.id)
  }, [message.id, setEditingMessageId])

  const handleSaveEdit = useCallback(async () => {
    try {
      const trimmedReasoning = editReasoning.trim()
      const cleanContent = editContent.trim()
      let updated: Message

      if (!message.is_user && hadReasoningRef.current) {
        // Let the WS MESSAGE_EDITED payload reconcile the final stored message so
        // extension-postprocessed content is not overwritten by a late local merge.
        const extra = {
          ...(message.extra || {}),
          reasoning: trimmedReasoning || null,
          ...(trimmedReasoning ? {} : { reasoningDuration: null }),
        }
        updated = await messagesApi.update(chatId, message.id, { content: cleanContent, extra })
      } else {
        updated = await messagesApi.update(chatId, message.id, { content: cleanContent })
      }
      updateMessage(updated.id, updated)
      setEditingMessageId(null)
    } catch (err) {
      console.error('[MessageCard] Failed to save edit:', err)
      addToast({ type: 'error', message: 'Failed to save message edit' })
    }
  }, [chatId, message.id, editContent, editReasoning, message.is_user, message.extra, setEditingMessageId, updateMessage, addToast])

  const handleCancelEdit = useCallback(() => {
    setEditingMessageId(null)
    setEditContent('')
    setEditReasoning('')
    setShowReasoningEditor(false)
    hadReasoningRef.current = false
  }, [setEditingMessageId])

  const doDeleteMessage = useCallback(async () => {
    try {
      await messagesApi.delete(chatId, message.id)
      removeMessage(message.id)
    } catch (err) {
      console.error('[MessageCard] Failed to delete:', err)
    }
  }, [chatId, message.id, removeMessage])

  const doDeleteSwipe = useCallback(async () => {
    try {
      await messagesApi.deleteSwipe(chatId, message.id, message.swipe_id)
    } catch (err) {
      console.error('[MessageCard] Failed to delete swipe:', err)
    }
  }, [chatId, message.id, message.swipe_id])

  const isHidden = message.extra?.hidden === true

  const handleToggleHidden = useCallback(async () => {
    try {
      const newHidden = !message.extra?.hidden
      const extra = { ...(message.extra || {}), hidden: newHidden || undefined }
      if (!newHidden) delete extra.hidden
      const updated = await messagesApi.update(chatId, message.id, { extra })
      updateMessage(updated.id, updated)
    } catch (err) {
      console.error('[MessageCard] Failed to toggle hidden:', err)
    }
  }, [chatId, message.id, message.extra, updateMessage])

  const handleFork = useCallback(() => {
    openModal('confirm', {
      title: 'Fork Chat',
      message: 'Create a new chat branch at this message? All messages up to this point will be copied.',
      confirmText: 'Fork',
      onConfirm: async () => {
        try {
          const newChat = await chatsApi.branch(chatId, message.id)
          navigate(`/chat/${newChat.id}`)
        } catch (err) {
          console.error('[MessageCard] Failed to fork chat:', err)
        }
      },
    })
  }, [chatId, message.id, openModal, navigate])

  const handleDelete = useCallback(() => {
    const hasSwipes = message.swipes && message.swipes.length > 1

    if (!message.is_user && hasSwipes) {
      // Assistant message with swipes: offer Swipe vs Message deletion
      openModal('confirm', {
        title: 'Delete',
        message: 'Delete just this swipe, or the entire message with all swipes?',
        variant: 'danger',
        confirmText: 'Message',
        onConfirm: doDeleteMessage,
        secondaryText: 'Swipe',
        onSecondary: doDeleteSwipe,
        secondaryVariant: 'warning',
      })
    } else if (!message.is_user) {
      // Assistant message without swipes: simple confirm
      openModal('confirm', {
        title: 'Delete Message',
        message: 'This will permanently remove this message from the chat.',
        variant: 'danger',
        confirmText: 'Delete',
        onConfirm: doDeleteMessage,
      })
    } else {
      // User messages: delete directly (existing behavior)
      doDeleteMessage()
    }
  }, [message.is_user, message.swipes, openModal, doDeleteMessage, doDeleteSwipe])

  return {
    isEditing,
    editContent,
    setEditContent,
    editReasoning,
    setEditReasoning,
    showReasoningEditor,
    isUser,
    isLastMessage,
    isActivelyStreaming,
    displayContent,
    reasoning,
    reasoningDuration,
    reasoningStartedAt,
    tokenCount,
    generationMetrics,
    avatarUrl,
    fullAvatarUrl,
    displayName,
    macroUserName,
    isHidden,
    handleEdit,
    handleSaveEdit,
    handleCancelEdit,
    handleDelete,
    handleToggleHidden,
    handleFork,
  }
}

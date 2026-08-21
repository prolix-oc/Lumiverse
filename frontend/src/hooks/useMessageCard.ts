import { useState, useRef, useCallback, useMemo, useEffect, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { useStore } from '@/store'
import { messagesApi, chatsApi } from '@/api/chats'
import { generateApi } from '@/api/generate'
import { findSubsequentAssistant, startSwipeGeneration } from '@/hooks/useSwipeAction'
import { shouldForceLoomRuntimePreset } from '@/lib/loom/runtimeProfile'
import {
  getCharacterAvatarThumbUrlById,
  getCharacterAvatarLargeUrlById,
  getCharacterAvatarUrlById,
  getPersonaAvatarThumbUrlById,
  getPersonaAvatarLargeUrlById,
  getPersonaAvatarUrlById,
  getPersonaAvatarTiers,
  getCharacterAvatarTiers,
  getImageTiers,
  type AvatarTierUrls,
} from '@/lib/avatarUrls'
import { imagesApi } from '@/api/images'
import type { Message } from '@/types/api'
import type { GenerationMetrics } from '@/types/ws-events'
import { resolveMultiplayerMessageAuthor } from '@/lib/multiplayerMessageAuthor'

const CONTEXT_HISTORY_ANCHOR_KEY = 'context_history_anchor_message_id'

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
  const { t } = useTranslation('chat', { keyPrefix: 'toast' })
  const { t: tChat } = useTranslation('chat')
  const { t: tc } = useTranslation('chat', { keyPrefix: 'messageCard' })
  const navigate = useNavigate()
  const editingMessageId = useStore((s) => s.editingMessageId)
  const messageEditDraft = useStore((s) => s.messageEditDraft)
  const beginMessageEdit = useStore((s) => s.beginMessageEdit)
  const updateMessageEditDraft = useStore((s) => s.updateMessageEditDraft)
  const clearMessageEdit = useStore((s) => s.clearMessageEdit)
  const updateMessage = useStore((s) => s.updateMessage)
  const addToast = useStore((s) => s.addToast)
  const isEditing = editingMessageId === message.id
  const activeDraft = messageEditDraft?.chatId === chatId && messageEditDraft.messageId === message.id
    ? messageEditDraft
    : null
  const editContent = activeDraft?.content ?? ''
  const editReasoning = activeDraft?.reasoning ?? ''
  const showReasoningEditor = activeDraft?.showReasoningEditor ?? false
  const setEditContent = useCallback((content: string) => {
    updateMessageEditDraft({ content })
  }, [updateMessageEditDraft])
  const setEditReasoning = useCallback((reasoning: string) => {
    updateMessageEditDraft({ reasoning })
  }, [updateMessageEditDraft])
  const editAndSendAbortRef = useRef<AbortController | null>(null)
  const [editAndSendPending, setEditAndSendPending] = useState(false)
  const removeMessage = useStore((s) => s.removeMessage)
  const openModal = useStore((s) => s.openModal)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const isStreaming = useStore((s) => s.isStreaming)
  const messages = useStore((s) => s.messages)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const personas = useStore((s) => s.personas)
  const mpRoomId = useStore((s) => s.mpRoomId)
  const mpIsHost = useStore((s) => s.mpIsHost)
  const mpCharacterAvatar = useStore((s) => s.mpCharacterAvatar)
  const autoParse = useStore((s) => s.reasoningSettings.autoParse)
  const activeChatAvatarId = useStore((s) => s.activeChatAvatarId)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const setActiveChatMetadata = useStore((s) => s.setActiveChatMetadata)
  const isBubbleMode = useStore((s) => s.chatDisplayMode) === 'bubble'

  const regeneratingMessageId = useStore((s) => s.regeneratingMessageId)
  const streamingSwipeId = useStore((s) => s.streamingSwipeId)
  const streamingGenerationType = useStore((s) => s.streamingGenerationType)
  const streamingContent = useStore((s) => {
    if (!s.isStreaming) return ''
    const onSwipe = s.streamingSwipeId == null || message.swipe_id === s.streamingSwipeId
    if (!onSwipe) return ''
    const isTailMessage = s.messages.length > 0 && s.messages[s.messages.length - 1].id === message.id
    if (s.regeneratingMessageId === message.id) return s.streamingContent
    if (s.streamingGenerationType === 'continue' && isTailMessage && !message.is_user) return s.streamingContent
    return ''
  })
  const streamingReasoning = useStore((s) => {
    if (!s.isStreaming) return ''
    const onSwipe = s.streamingSwipeId == null || message.swipe_id === s.streamingSwipeId
    if (!onSwipe) return ''
    const isTailMessage = s.messages.length > 0 && s.messages[s.messages.length - 1].id === message.id
    const isStreamingMessage = s.regeneratingMessageId === message.id
      || (isTailMessage && !message.is_user && (!s.regeneratingMessageId || s.streamingGenerationType === 'continue'))
    return isStreamingMessage ? s.streamingReasoning : ''
  })
  const streamingReasoningDuration = useStore((s) => {
    if (!s.isStreaming) return null
    const onSwipe = s.streamingSwipeId == null || message.swipe_id === s.streamingSwipeId
    if (!onSwipe) return null
    const isTailMessage = s.messages.length > 0 && s.messages[s.messages.length - 1].id === message.id
    const isStreamingMessage = s.regeneratingMessageId === message.id
      || (isTailMessage && !message.is_user && (!s.regeneratingMessageId || s.streamingGenerationType === 'continue'))
    return isStreamingMessage ? s.streamingReasoningDuration : null
  })
  const streamingReasoningStartedAt = useStore((s) => {
    if (!s.isStreaming) return null
    const onSwipe = s.streamingSwipeId == null || message.swipe_id === s.streamingSwipeId
    if (!onSwipe) return null
    const isTailMessage = s.messages.length > 0 && s.messages[s.messages.length - 1].id === message.id
    const isStreamingMessage = s.regeneratingMessageId === message.id
      || (isTailMessage && !message.is_user && (!s.regeneratingMessageId || s.streamingGenerationType === 'continue'))
    return isStreamingMessage ? s.streamingReasoningStartedAt : null
  })

  const isUser = message.is_user
  const isLastMessage = messages.length > 0 && messages[messages.length - 1].id === message.id
  // The streaming buffer only belongs on the swipe that is actually being
  // generated. If the user navigates to a different swipe of this message while
  // it streams, paint that swipe's saved content instead and let the stream
  // keep filling the target swipe in the background. (null = swipe index not
  // yet known, e.g. before GENERATION_STARTED — fall back to painting in-place.)
  const onStreamingSwipe = streamingSwipeId == null || message.swipe_id === streamingSwipeId
  const isRegenerating = isStreaming && regeneratingMessageId === message.id && onStreamingSwipe
  const isContinuing = isStreaming && streamingGenerationType === 'continue' && isLastMessage && !isUser && onStreamingSwipe
  const isActivelyStreaming = isRegenerating || isContinuing || (isStreaming && isLastMessage && !isUser && !regeneratingMessageId && onStreamingSwipe)
  // When this message is being regenerated, show streaming content in-place
  // instead of the saved (blank) swipe content.
  // When continuing, append streaming content to the existing message content.
  // For non-regeneration streaming (normal generation), the streaming bubble
  // in MessageList handles display to avoid race conditions with MESSAGE_SENT.
  // When navigated to a non-streaming swipe, falls through to message.content
  // (kept in sync with the active swipe by cycleSwipe / MESSAGE_SWIPED).
  const rawContent = isRegenerating
    ? (streamingContent || message.content)
    : isContinuing
      ? message.content + (streamingContent || '')
      : message.content

  // Auto-parse: strip thinking tags from assistant messages and extract as reasoning
  const { displayContent, parsedReasoning } = useMemo(() => {
    if (!autoParse || isUser) return { displayContent: rawContent, parsedReasoning: '' }
    const { cleaned, thoughts } = parseThinkingTags(rawContent)
    // When thoughts were extracted, trust cleaned even if empty — the entire
    // message may have been inside <think> tags. Falling back to rawContent
    // here re-displays the thinking content in the message body (duplication).
    return { displayContent: thoughts ? cleaned : (cleaned || rawContent), parsedReasoning: thoughts }
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

  // Temporary chats are persona-less: never attribute the user's messages to
  // the globally active persona (name or avatar).
  const isTemporaryChat = useStore((s) => s.activeChatMetadata?.temporary === true)

  const userPersonaId = typeof message.extra?.persona_id === 'string' ? message.extra.persona_id : null
  const messagePersona = userPersonaId ? personas.find((p) => p.id === userPersonaId) : null
  const activePersona = activePersonaId && !isTemporaryChat ? personas.find((p) => p.id === activePersonaId) ?? null : null
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
    ? (messagePersona?.name || (isGenericUserName ? (activePersona?.name || 'User') : normalizedMessageName))
    : ((isGenericAssistantName ? effectiveCharacter?.name : normalizedMessageName) || effectiveCharacter?.name || 'Assistant')

  const effectiveCharId = messageCharacterId || activeCharacterId
  const getCharAvatarUrl = isBubbleMode ? getCharacterAvatarLargeUrlById : getCharacterAvatarThumbUrlById
  const getImageUrl = isBubbleMode ? imagesApi.largeUrl : imagesApi.smallUrl
  const characterAvatarCropImageId = typeof effectiveCharacter?.extensions?.avatar_crop_image_id === 'string'
    ? effectiveCharacter.extensions.avatar_crop_image_id
    : null
  const personaAvatarId = userPersonaId ?? activePersona?.id ?? null
  const chatPersonaAvatarVersion = personaAvatarId && typeof activeChatMetadata?.persona_addon_avatar_versions?.[personaAvatarId] === 'string'
    ? activeChatMetadata.persona_addon_avatar_versions[personaAvatarId]
    : null
  // Chat-aware persona avatars use a resolver URL so add-on overrides can be
  // applied server-side. Include the current base image IDs in its version so
  // an upload changes the <img> URL immediately, rather than waiting for a
  // browser revalidation of the otherwise-stable resolver URL.
  const effectivePersona = messagePersona ?? activePersona
  const personaImageVersion = [
    effectivePersona?.image_id,
    effectivePersona?.metadata?.avatar_crop_image_id,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join('.')
  const personaAvatarVersion = [chatPersonaAvatarVersion, personaImageVersion]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join('.') || null
  const personaAvatarContext = !isTemporaryChat && personaAvatarId
    ? { chatId, version: personaAvatarVersion }
    : undefined
  const personaAvatarFallbackUrl = isBubbleMode
    ? getPersonaAvatarLargeUrlById(personaAvatarId, null, personaAvatarContext)
    : getPersonaAvatarThumbUrlById(personaAvatarId, null, personaAvatarContext)
  const groupAvatarId = typeof activeChatMetadata?.group_active_avatar_ids?.[effectiveCharId || ''] === 'string'
    ? activeChatMetadata.group_active_avatar_ids[effectiveCharId || ''] as string
    : null
  const effectiveChatAvatarId = activeChatMetadata?.group === true
    ? groupAvatarId
    : activeChatAvatarId && effectiveCharId === activeCharacterId
      ? activeChatAvatarId
      : null
  const activeAltAvatar = effectiveChatAvatarId
    ? (effectiveCharacter?.extensions?.alternate_avatars as Array<{ image_id: string; original_image_id?: string }> | undefined)
        ?.find((avatar) => avatar.image_id === effectiveChatAvatarId)
    : null

  // Multiplayer peers can't fetch the owner-scoped character-avatar endpoint —
  // the host relays a compressed copy of the bot avatar. Use it for non-user
  // messages when we're a peer (the host renders the real character avatar).
  const peerBotAvatar = !isUser && mpRoomId && !mpIsHost ? mpCharacterAvatar : null

  const avatarUrl = isUser
    ? personaAvatarFallbackUrl
    : peerBotAvatar
      ?? (effectiveChatAvatarId
        ? getImageUrl(effectiveChatAvatarId)
        : getCharAvatarUrl(effectiveCharId, characterAvatarCropImageId ?? effectiveCharacter?.image_id ?? null))

  // Full-size avatar URL for lightbox/floating viewer (no resize)
  const fullAvatarUrl = isUser
    ? getPersonaAvatarUrlById(personaAvatarId, null, personaAvatarContext)
    : peerBotAvatar
      ?? (effectiveChatAvatarId
        ? imagesApi.url(activeAltAvatar?.original_image_id || effectiveChatAvatarId)
        : getCharacterAvatarUrlById(
            effectiveCharId,
            typeof effectiveCharacter?.extensions?.original_image_id === 'string'
              ? effectiveCharacter.extensions.original_image_id
              : effectiveCharacter?.image_id ?? null
          ))

  // ── Full sm/lg/full tier matrix for theme overrides. `cropped` is the 1:1
  //    square variant; `original` is the uploaded aspect ratio. Mirrors the
  //    avatarUrl/fullAvatarUrl resolution above so they stay consistent. ──
  const characterOriginalImageId = typeof effectiveCharacter?.extensions?.original_image_id === 'string'
    ? effectiveCharacter.extensions.original_image_id
    : effectiveCharacter?.image_id ?? null
  const usesChatAvatar = !!effectiveChatAvatarId

  const croppedAvatarTiers: AvatarTierUrls = isUser
    ? getPersonaAvatarTiers(personaAvatarId, null, personaAvatarContext, 'crop')
    : usesChatAvatar
      ? getImageTiers(effectiveChatAvatarId)
      : getCharacterAvatarTiers(effectiveCharId, characterAvatarCropImageId ?? effectiveCharacter?.image_id ?? null)

  const originalAvatarTiers: AvatarTierUrls = isUser
    ? getPersonaAvatarTiers(personaAvatarId, null, personaAvatarContext, 'original')
    : usesChatAvatar
      ? getImageTiers(activeAltAvatar?.original_image_id || effectiveChatAvatarId)
      : getCharacterAvatarTiers(effectiveCharId, characterOriginalImageId)

  const avatar = useMemo(
    () => ({ cropped: croppedAvatarTiers, original: originalAvatarTiers }),
    [croppedAvatarTiers, originalAvatarTiers],
  )

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
    const persistedMessages = messages.filter((entry) => (
      !entry.id.startsWith('__stream_placeholder_') && !entry.id.startsWith('__regen_placeholder_')
    ))
    const loadedOffset = Math.max(0, useStore.getState().totalChatLength - persistedMessages.length)
    const loadedIndex = persistedMessages.findIndex((entry) => entry.id === message.id)
    const messageOffset = loadedOffset + Math.max(0, loadedIndex)

    if (!message.is_user) {
      // For assistant messages, separate reasoning from content
      const apiReasoning = typeof message.extra?.reasoning === 'string' ? message.extra.reasoning : ''
      const { cleaned, thoughts } = parseThinkingTags(message.content)
      const reasoningText = apiReasoning || thoughts
      const hasReasoning = !!reasoningText
      beginMessageEdit({
        chatId,
        messageId: message.id,
        messageOffset,
        messageIndexInChat: message.index_in_chat,
        content: cleaned.replace(/^\n{2,}/, ''),
        reasoning: reasoningText,
        showReasoningEditor: hasReasoning,
        hadReasoning: hasReasoning,
      })
    } else {
      beginMessageEdit({
        chatId,
        messageId: message.id,
        messageOffset,
        messageIndexInChat: message.index_in_chat,
        content: message.content,
        reasoning: '',
        showReasoningEditor: false,
        hadReasoning: false,
      })
    }
  }, [beginMessageEdit, chatId, message.content, message.extra, message.id, message.index_in_chat, message.is_user, messages])

  // Keyboard-triggered edits only publish the target id. Initialize the
  // durable draft before paint if this target does not have one yet. A row
  // remount caused by virtualization sees the matching draft and leaves it
  // untouched.
  useLayoutEffect(() => {
    if (isEditing && !activeDraft) {
      initializeEdit()
    }
  }, [activeDraft, isEditing, initializeEdit])

  const handleEdit = useCallback(() => {
    initializeEdit()
  }, [initializeEdit])

  const handleSaveEdit = useCallback(async () => {
    try {
      const trimmedReasoning = editReasoning.trim()
      const cleanContent = editContent.trim()
      let updated: Message

      if (!message.is_user && activeDraft?.hadReasoning) {
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
      clearMessageEdit()
    } catch (err) {
      console.error('[MessageCard] Failed to save edit:', err)
      addToast({ type: 'error', message: t('failedSaveMessageEdit') })
    }
  }, [activeDraft?.hadReasoning, chatId, message.id, editContent, editReasoning, message.is_user, message.extra, clearMessageEdit, updateMessage, addToast, t])

  const handleCancelEdit = useCallback(() => {
    editAndSendAbortRef.current?.abort()
    editAndSendAbortRef.current = null
    setEditAndSendPending(false)
    clearMessageEdit()
  }, [clearMessageEdit])

  const handleEditAndSend = useCallback(async () => {
    if (!message.is_user || editAndSendPending || isStreaming) return
    const cleanContent = editContent.trim()
    if (!cleanContent) {
      addToast({ type: 'error', message: t('emptyEditAndSend', { defaultValue: 'Message cannot be empty' }) })
      return
    }

    setEditAndSendPending(true)
    clearMessageEdit()
    const previousContent = message.content
    updateMessage(message.id, { ...message, content: cleanContent })

    try {
      const updated = await messagesApi.update(chatId, message.id, { content: cleanContent })
      updateMessage(message.id, updated)

      const currentMessages = useStore.getState().messages
      const assistantMessage = findSubsequentAssistant(currentMessages, message.id)

      if (assistantMessage) {
        try {
          await startSwipeGeneration(assistantMessage, chatId)
        } catch (err: any) {
          addToast({ type: 'error', message: err?.message || t('failedEditAndSend', { defaultValue: 'Failed to edit and send' }) })
        }
      } else {
        const state = useStore.getState()
        const {
          beginStreaming,
          startStreaming,
          setStreamingError,
          activeProfileId,
          activePersonaId,
          activeCharacterId,
          getActivePresetForGeneration,
        } = state
        beginStreaming(undefined, 'continue')
        try {
          const presetId = getActivePresetForGeneration() || undefined
          const genRes = await generateApi.start({
            chat_id: chatId,
            generation_type: 'continue',
            connection_id: activeProfileId || undefined,
            persona_id: activePersonaId || undefined,
            preset_id: presetId,
            force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
          })
          startStreaming(genRes.generationId, undefined, 'continue')
        } catch (err: any) {
          setStreamingError(err?.message || 'Failed to start generation')
        }
      }
    } catch (err: any) {
      console.error('[MessageCard] Failed to edit and send:', err)
      updateMessage(message.id, { ...message, content: previousContent })
      addToast({ type: 'error', message: t('failedEditAndSend', { defaultValue: 'Failed to edit and send' }) })
    } finally {
      setEditAndSendPending(false)
    }
  }, [chatId, editAndSendPending, editContent, isStreaming, message, t, updateMessage, addToast, clearMessageEdit])

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
  const contextAnchorMessageId = typeof activeChatMetadata?.[CONTEXT_HISTORY_ANCHOR_KEY] === 'string'
    ? activeChatMetadata[CONTEXT_HISTORY_ANCHOR_KEY] as string
    : null
  const isContextAnchor = contextAnchorMessageId === message.id

  const handleToggleContextAnchor = useCallback(async () => {
    if (isHidden) return

    const previousMetadata = activeChatMetadata
    const nextAnchorMessageId = isContextAnchor ? null : message.id
    const optimisticMetadata = {
      ...(previousMetadata ?? {}),
      ...(nextAnchorMessageId ? { [CONTEXT_HISTORY_ANCHOR_KEY]: nextAnchorMessageId } : {}),
    }
    if (!nextAnchorMessageId) delete optimisticMetadata[CONTEXT_HISTORY_ANCHOR_KEY]
    setActiveChatMetadata(optimisticMetadata)

    try {
      const updated = await chatsApi.patchMetadata(chatId, {
        [CONTEXT_HISTORY_ANCHOR_KEY]: nextAnchorMessageId,
      })
      setActiveChatMetadata(updated.metadata ?? null)
      addToast({
        type: 'success',
        message: tChat(isContextAnchor ? 'messageActions.contextAnchorCleared' : 'messageActions.contextAnchorSet'),
      })
    } catch (err) {
      console.error('[MessageCard] Failed to update context anchor:', err)
      setActiveChatMetadata(previousMetadata)
      addToast({ type: 'error', message: tChat('messageActions.contextAnchorFailed') })
    }
  }, [activeChatMetadata, addToast, chatId, isContextAnchor, isHidden, message.id, setActiveChatMetadata, tChat])

  const handleToggleHidden = useCallback(async () => {
    try {
      const newHidden = !message.extra?.hidden
      const extra = { ...(message.extra || {}), hidden: newHidden || undefined }
      if (!newHidden) delete extra.hidden
      const updated = await messagesApi.update(chatId, message.id, { extra })
      updateMessage(updated.id, updated)
      if (newHidden && isContextAnchor) {
        const updatedChat = await chatsApi.patchMetadata(chatId, {
          [CONTEXT_HISTORY_ANCHOR_KEY]: null,
        })
        setActiveChatMetadata(updatedChat.metadata ?? null)
      }
    } catch (err) {
      console.error('[MessageCard] Failed to toggle hidden:', err)
    }
  }, [chatId, isContextAnchor, message.id, message.extra, setActiveChatMetadata, updateMessage])

  const handleFork = useCallback(() => {
    openModal('confirm', {
      title: tc('fork.title'),
      message: tc('fork.message'),
      confirmText: tc('fork.confirm'),
      inputLabel: tc('fork.nameLabel'),
      inputPlaceholder: tc('fork.namePlaceholder'),
      onConfirm: async (name: string) => {
        try {
          const newChat = await chatsApi.branch(chatId, message.id, name)
          navigate(`/chat/${newChat.id}`)
        } catch (err) {
          console.error('[MessageCard] Failed to fork chat:', err)
        }
      },
    })
  }, [chatId, message.id, openModal, navigate, tc])

  const handleDelete = useCallback(() => {
    const hasSwipes = message.swipes && message.swipes.length > 1

    if (!message.is_user && hasSwipes) {
      // Assistant message with swipes: offer Swipe vs Message deletion
      openModal('confirm', {
        title: tc('delete.title'),
        message: tc('delete.message'),
        variant: 'danger',
        confirmText: tc('delete.confirmMessage'),
        onConfirm: doDeleteMessage,
        secondaryText: tc('delete.confirmSwipe'),
        onSecondary: doDeleteSwipe,
        secondaryVariant: 'warning',
      })
    } else {
      // Single-message delete (assistant without swipes, or any user message)
      openModal('confirm', {
        title: tc('deleteMessage.title'),
        message: tc('deleteMessage.message'),
        variant: 'danger',
        confirmText: tc('deleteMessage.confirm'),
        onConfirm: doDeleteMessage,
      })
    }
  }, [message.is_user, message.swipes, openModal, doDeleteMessage, doDeleteSwipe, tc])

  // Multiplayer author resolution. Peer-authored messages persist a stamped
  // snapshot in `extra.mp`; that saved row is authoritative for historical
  // rendering and must not be rewritten by later peer persona/avatar changes.
  // Unstamped room messages (the host's own local-account turns) still fall
  // back to the live roster because no per-message snapshot exists for them.
  // Non-reactive read on purpose: avoids re-rendering every card on
  // typing/presence churn.
  // eslint-disable-next-line react-compiler/react-compiler
  const mpStore = useStore.getState()
  const mpAuthor = resolveMultiplayerMessageAuthor({
    message,
    roomId: mpStore.mpRoomId,
    participants: mpStore.mpParticipants,
    fallbackDisplayName: displayName,
  })
  const isMpAuthor = !!mpAuthor
  const mpAvatarData = mpAuthor?.avatarUrl || ''
  const mpDisplayName = mpAuthor?.displayName || displayName
  const mpAvatarUrl = isMpAuthor ? (mpAvatarData || null) : avatarUrl
  const mpFullAvatarUrl = isMpAuthor ? (mpAvatarData || null) : fullAvatarUrl
  const mpAvatar: typeof avatar = isMpAuthor
    ? {
        cropped: { sm: mpAvatarData, lg: mpAvatarData, full: mpAvatarData },
        original: { sm: mpAvatarData, lg: mpAvatarData, full: mpAvatarData },
      }
    : avatar

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
    avatarUrl: mpAvatarUrl,
    fullAvatarUrl: mpFullAvatarUrl,
    avatar: mpAvatar,
    displayName: mpDisplayName,
    macroUserName,
    isHidden,
    isContextAnchor,
    handleEdit,
    handleSaveEdit,
    handleEditAndSend,
    handleCancelEdit,
    editAndSendPending,
    handleDelete,
    handleToggleHidden,
    handleToggleContextAnchor,
    handleFork,
  }
}

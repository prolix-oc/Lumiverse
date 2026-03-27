import { useState, useCallback, useRef, useEffect, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { Send, RotateCw, CornerDownLeft, Square, FilePlus, Eye, UserCircle, Compass, MessageSquareQuote, Wrench, UserRound, UsersRound, Home, MoreHorizontal, FolderOpen, Paperclip, X, StickyNote, Crown, ScrollText, MessageSquare, BrainCircuit, Drama, Layers, Puzzle } from 'lucide-react'
import { useStore } from '@/store'
import { messagesApi, chatsApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
import { generateApi } from '@/api/generate'
import { embeddingsApi } from '@/api/embeddings'
import { expressionsApi } from '@/api/expressions'
import { personasApi } from '@/api/personas'
import { imagesApi } from '@/api/images'
import { getPersonaAvatarThumbUrlById } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { useDeviceFrameRadius } from '@/hooks/useDeviceFrameRadius'
import type { MessageAttachment, PersonaAddon } from '@/types/api'
import AuthorsNotePanel from './AuthorsNotePanel'
import styles from './InputArea.module.css'
import clsx from 'clsx'
import InputBarExtensionActions from './InputBarExtensionActions'

interface InputAreaProps {
  chatId: string
}

export default function InputArea({ chatId }: InputAreaProps) {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [dryRunning, setDryRunning] = useState(false)
  const [authorsNoteOpen, setAuthorsNoteOpen] = useState(false)
  const [openPopover, setOpenPopover] = useState<null | 'guides' | 'quick' | 'persona' | 'tools' | 'extras' | 'altFields' | 'addons'>(null)
  const [renderPopover, setRenderPopover] = useState<null | 'guides' | 'quick' | 'persona' | 'tools' | 'extras' | 'altFields' | 'addons'>(null)
  const [popoverClosing, setPopoverClosing] = useState(false)
  const [sendPersonaId, setSendPersonaId] = useState<string | null>(null)
  const [personaList, setPersonaList] = useState<Array<{ id: string; name: string; title: string; avatar_path: string | null; image_id: string | null }>>([])
  const [characterName, setCharacterName] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<(MessageAttachment & { previewUrl?: string })[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)
  const generationNonceRef = useRef(0)
  const isStreaming = useStore((s) => s.isStreaming)
  const activeGenerationId = useStore((s) => s.activeGenerationId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const enterToSend = useStore((s) => s.chatSheldEnterToSend)
  const saveDraftInput = useStore((s) => s.saveDraftInput)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)
  const regenFeedback = useStore((s) => s.regenFeedback)
  const guidedGenerations = useStore((s) => s.guidedGenerations)
  const quickReplySets = useStore((s) => s.quickReplySets)
  const personas = useStore((s) => s.personas)
  const messages = useStore((s) => s.messages)
  const addMessage = useStore((s) => s.addMessage)
  const beginStreaming = useStore((s) => s.beginStreaming)
  const startStreaming = useStore((s) => s.startStreaming)
  const stopStreaming = useStore((s) => s.stopStreaming)
  const setStreamingError = useStore((s) => s.setStreamingError)
  const openModal = useStore((s) => s.openModal)
  const setSetting = useStore((s) => s.setSetting)

  const isGroupChat = useStore((s) => s.isGroupChat)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const mutedCharacterIds = useStore((s) => s.mutedCharacterIds)
  const expressionDisplay = useStore((s) => s.expressionDisplay)
  const setExpressionDisplay = useStore((s) => s.setExpressionDisplay)

  // Track whether the active character has expressions configured
  const [hasExpressions, setHasExpressions] = useState(false)
  useEffect(() => {
    if (!activeCharacterId) { setHasExpressions(false); return }
    expressionsApi.get(activeCharacterId)
      .then((cfg) => setHasExpressions(!!cfg?.enabled && Object.keys(cfg.mappings || {}).length > 0))
      .catch(() => setHasExpressions(false))
  }, [activeCharacterId])

  // Track alternate fields for the active character
  type AltFieldVariant = { id: string; label: string; content: string }
  const [altFieldsData, setAltFieldsData] = useState<Record<string, AltFieldVariant[]>>({})
  const [altFieldSelections, setAltFieldSelections] = useState<Record<string, string>>({})
  const hasAltFields = Object.values(altFieldsData).some((arr) => arr.length > 0)

  useEffect(() => {
    if (!activeCharacterId) { setAltFieldsData({}); return }
    charactersApi.get(activeCharacterId)
      .then((c) => {
        const af = c.extensions?.alternate_fields as Record<string, AltFieldVariant[]> | undefined
        setAltFieldsData(af && typeof af === 'object' ? af : {})
      })
      .catch(() => setAltFieldsData({}))
  }, [activeCharacterId])

  // Load per-chat alternate field selections
  useEffect(() => {
    if (!chatId || !hasAltFields) { setAltFieldSelections({}); return }
    chatsApi.get(chatId, { messages: false })
      .then((chat) => setAltFieldSelections((chat.metadata?.alternate_field_selections as Record<string, string>) || {}))
      .catch(() => setAltFieldSelections({}))
  }, [chatId, hasAltFields])

  const handleAltFieldSelect = useCallback(async (field: string, variantId: string | null) => {
    const newSelections = { ...altFieldSelections }
    if (variantId) newSelections[field] = variantId
    else delete newSelections[field]
    setAltFieldSelections(newSelections)
    try {
      const chat = await chatsApi.get(chatId, { messages: false })
      const metadata = { ...(chat.metadata || {}) }
      if (Object.keys(newSelections).length > 0) metadata.alternate_field_selections = newSelections
      else delete metadata.alternate_field_selections
      await chatsApi.update(chatId, { metadata })
    } catch (err) {
      console.error('[AltFields] Failed to save:', err)
    }
  }, [chatId, altFieldSelections])

  // Track persona add-ons for the active persona
  const [personaAddons, setPersonaAddons] = useState<PersonaAddon[]>([])
  const hasAddons = personaAddons.length > 0

  useEffect(() => {
    if (!activePersonaId) { setPersonaAddons([]); return }
    personasApi.get(activePersonaId)
      .then((p) => {
        const raw = p.metadata?.addons
        setPersonaAddons(Array.isArray(raw) ? raw : [])
      })
      .catch(() => setPersonaAddons([]))
  }, [activePersonaId])

  // Listen for persona changes via store to keep addons in sync
  const storePersonas = useStore((s) => s.personas)
  useEffect(() => {
    if (!activePersonaId) return
    const p = storePersonas.find((x) => x.id === activePersonaId)
    if (p) {
      const raw = p.metadata?.addons
      setPersonaAddons(Array.isArray(raw) ? raw : [])
    }
  }, [storePersonas, activePersonaId])

  const handleToggleAddon = useCallback(async (addonId: string) => {
    if (!activePersonaId) return
    const next = personaAddons.map((a) => a.id === addonId ? { ...a, enabled: !a.enabled } : a)
    setPersonaAddons(next)
    try {
      const p = await personasApi.get(activePersonaId)
      const newMeta = { ...(p.metadata || {}), addons: next }
      const updated = await personasApi.update(activePersonaId, { metadata: newMeta })
      useStore.getState().updatePersona(activePersonaId, updated)
    } catch {
      // Revert on failure
      setPersonaAddons(personaAddons)
      toast.error('Failed to toggle add-on')
    }
  }, [activePersonaId, personaAddons])

  // iPhone-specific: match input bar bottom corners to device screen curvature
  const screenCornerRadius = useDeviceFrameRadius()
  const [inputFocused, setInputFocused] = useState(false)

  // ── Draft input persistence ──────────────────────────────────────────
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const DRAFT_KEY_PREFIX = 'lumiverse:chatDraft:'

  // Restore draft on mount or chat switch
  useEffect(() => {
    if (!saveDraftInput) return
    try {
      const saved = localStorage.getItem(DRAFT_KEY_PREFIX + chatId)
      if (saved) {
        setText(saved)
        requestAnimationFrame(() => {
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
            textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 180) + 'px'
          }
        })
      }
    } catch {}
  }, [chatId, saveDraftInput])

  // Debounced save on text change
  useEffect(() => {
    if (!saveDraftInput) return
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    draftTimerRef.current = setTimeout(() => {
      try {
        if (text) {
          localStorage.setItem(DRAFT_KEY_PREFIX + chatId, text)
        } else {
          localStorage.removeItem(DRAFT_KEY_PREFIX + chatId)
        }
      } catch {}
    }, 500)
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    }
  }, [text, chatId, saveDraftInput])

  const activeGuides = guidedGenerations.filter((g) => g.enabled)
  const activeGuideCount = activeGuides.length
  const activeQuickReplySets = quickReplySets.filter((s) => s.enabled)

  const consumeOneshotGuides = useCallback(() => {
    const next = guidedGenerations.map((g) =>
      g.mode === 'oneshot' && g.enabled ? { ...g, enabled: false } : g
    )
    if (next.some((g, i) => g.enabled !== guidedGenerations[i].enabled)) {
      setSetting('guidedGenerations', next)
    }
  }, [guidedGenerations, setSetting])

  useEffect(() => {
    if (openPopover) {
      setRenderPopover(openPopover)
      setPopoverClosing(false)
      return
    }
    if (!renderPopover) return
    setPopoverClosing(true)
    const timer = setTimeout(() => {
      setRenderPopover(null)
      setPopoverClosing(false)
    }, 250)
    return () => clearTimeout(timer)
  }, [openPopover, renderPopover])

  // ResizeObserver — set --lcs-input-safe-zone on parent so scroll padding stays in sync
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const parent = el.parentElement
    if (!parent) return

    const update = () => {
      const h = el.offsetHeight
      const bottomOffset = parseFloat(getComputedStyle(el).bottom) || 12
      parent.style.setProperty('--lcs-input-safe-zone', `${h + bottomOffset + 16}px`)
    }

    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [])

  // Document-level Escape to stop generation
  useEffect(() => {
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && isStreaming) {
        e.preventDefault()
        e.stopPropagation()
        generateApi.stop(activeGenerationId || undefined).catch(console.error)
        // If in optimistic phase, revert locally
        if (!activeGenerationId) {
          stopStreaming()
        }
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isStreaming, activeGenerationId, stopStreaming])

  useEffect(() => {
    if (openPopover !== 'persona') return
    if (personas.length > 0) {
      setPersonaList(personas.map((p) => ({ id: p.id, name: p.name, title: p.title || '', avatar_path: p.avatar_path, image_id: p.image_id })))
      return
    }
    personasApi.list({ limit: 200 }).then((res) => {
      setPersonaList(res.data.map((p) => ({ id: p.id, name: p.name, title: p.title || '', avatar_path: p.avatar_path, image_id: p.image_id })))
    }).catch(() => {})
  }, [openPopover, personas])

  useEffect(() => {
    if (!sendPersonaId) return
    if (personas.some((p) => p.id === sendPersonaId)) return
    setSendPersonaId(null)
  }, [sendPersonaId, personas])

  useEffect(() => {
    if (!activeCharacterId) return
    charactersApi.get(activeCharacterId).then((c) => setCharacterName(c.name)).catch(() => {})
  }, [activeCharacterId])

  const handleAttachFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const isImage = file.type.startsWith('image/')
        const isAudio = file.type.startsWith('audio/')
        if (!isImage && !isAudio) {
          toast.error(`Unsupported file type: ${file.type}`, { title: 'Upload Failed' })
          continue
        }
        const image = await imagesApi.upload(file)
        const att: MessageAttachment & { previewUrl?: string } = {
          type: isImage ? 'image' : 'audio',
          image_id: image.id,
          mime_type: file.type,
          original_filename: file.name,
          width: image.width ?? undefined,
          height: image.height ?? undefined,
          previewUrl: isImage ? imagesApi.smallUrl(image.id) : undefined,
        }
        setPendingAttachments((prev) => [...prev, att])
      }
    } catch (err: any) {
      console.error('[InputArea] Attachment upload failed:', err)
      toast.error(err?.message || 'Failed to upload attachment', { title: 'Upload Failed' })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [])

  const removeAttachment = useCallback((imageId: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.image_id !== imageId))
  }, [])

  const handleSend = useCallback(async () => {
    if (sendingRef.current || isStreaming) return
    const content = text.trim()
    const attachments = pendingAttachments.length > 0
      ? pendingAttachments.map(({ previewUrl: _, ...a }) => a)
      : undefined

    sendingRef.current = true
    const nonce = ++generationNonceRef.current
    setText('')
    setPendingAttachments([])
    if (saveDraftInput) {
      try { localStorage.removeItem(DRAFT_KEY_PREFIX + chatId) } catch {}
    }
    setStreamingError(null)

    // Reset textarea height
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.focus()
      }
    })

    try {
      const effectivePersonaId = sendPersonaId || activePersonaId
      const effectivePersonaName = personas.find((p) => p.id === effectivePersonaId)?.name || 'User'
      const genOpts: import('@/api/generate').GenerateRequest = {
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: effectivePersonaId || undefined,
        preset_id: getActivePresetForGeneration() || undefined,
        generation_type: 'normal' as const,
      }
      // For group chats, pick the first non-muted character as the initial speaker
      if (isGroupChat && groupCharacterIds.length > 0) {
        const firstUnmuted = groupCharacterIds.find((id) => !mutedCharacterIds.includes(id))
        if (firstUnmuted) genOpts.target_character_id = firstUnmuted
      }
      if (content || attachments) {
        const extra: Record<string, any> = {}
        if (effectivePersonaId) extra.persona_id = effectivePersonaId
        if (attachments) extra.attachments = attachments
        const msg = await messagesApi.create(chatId, {
          is_user: true,
          name: effectivePersonaName,
          content: content || '(attached)',
          extra: Object.keys(extra).length > 0 ? extra : undefined,
        })
        // Optimistically add to store so it appears immediately
        addMessage(msg)
        // Show streaming state immediately so stop button appears during assembly
        beginStreaming()
        const res = await generateApi.start(genOpts)
        if (generationNonceRef.current !== nonce) return
        startStreaming(res.generationId)
        consumeOneshotGuides()
        if (sendPersonaId) setSendPersonaId(null)
      } else {
        // Empty send = silent continue (nudge AI to generate)
        beginStreaming()
        const res = await generateApi.continueGeneration(genOpts)
        if (generationNonceRef.current !== nonce) return
        startStreaming(res.generationId)
        consumeOneshotGuides()
      }
    } catch (err: any) {
      if (generationNonceRef.current !== nonce) return
      console.error('[InputArea] Failed to send:', err)
      const msg = err?.body?.error || err?.message || 'Failed to start generation'
      setStreamingError(msg)
      toast.error(msg, { title: 'Generation Failed' })
    } finally {
      sendingRef.current = false
    }
  }, [text, chatId, isStreaming, activeProfileId, activePersonaId, getActivePresetForGeneration, personas, sendPersonaId, pendingAttachments, addMessage, startStreaming, setStreamingError, consumeOneshotGuides, saveDraftInput])

  const doRegenerate = useCallback(async (feedback?: string | null) => {
    if (isStreaming) return
    const nonce = ++generationNonceRef.current

    // 1. Delete the last assistant message (if after the latest user turn)
    const lastMsg = messages[messages.length - 1]
    let nextIndex = 0
    if (lastMsg && !lastMsg.is_user) {
      nextIndex = lastMsg.index_in_chat
      try {
        await messagesApi.delete(chatId, lastMsg.id)
        useStore.getState().removeMessage(lastMsg.id)
      } catch (err) {
        console.error('[InputArea] Failed to delete before regenerate:', err)
      }
    } else {
      nextIndex = (lastMsg?.index_in_chat ?? -1) + 1
    }

    // 2. Insert a blank placeholder message immediately so there's a card to stream into
    const placeholderId = `__regen_placeholder_${Date.now()}`
    const placeholder: import('@/types/api').Message = {
      id: placeholderId,
      chat_id: chatId,
      index_in_chat: nextIndex,
      is_user: false,
      name: '',
      content: '',
      send_date: Math.floor(Date.now() / 1000),
      swipe_id: 0,
      swipes: [''],
      swipe_dates: [Math.floor(Date.now() / 1000)],
      extra: {},
      parent_message_id: null,
      branch_id: null,
      created_at: Math.floor(Date.now() / 1000),
    }
    addMessage(placeholder)

    // 3. Begin streaming, targeting the placeholder card
    beginStreaming(placeholderId)

    // 4. Fire generation
    try {
      const genOpts: import('@/api/generate').GenerateRequest = {
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: getActivePresetForGeneration() || undefined,
        generation_type: 'normal',
      }
      if (feedback) {
        genOpts.regen_feedback = feedback
        genOpts.regen_feedback_position = regenFeedback.position
      }
      const res = await generateApi.start(genOpts)
      if (generationNonceRef.current !== nonce) return
      startStreaming(res.generationId)
      consumeOneshotGuides()
    } catch (err: any) {
      if (generationNonceRef.current !== nonce) return
      // Remove the placeholder on failure
      useStore.getState().removeMessage(placeholderId)
      console.error('[InputArea] Failed to regenerate:', err)
      const msg = err?.body?.error || err?.message || 'Failed to regenerate'
      setStreamingError(msg)
      toast.error(msg, { title: 'Regeneration Failed' })
    }
  }, [chatId, isStreaming, messages, activeProfileId, activePersonaId, getActivePresetForGeneration, regenFeedback.position, addMessage, beginStreaming, startStreaming, setStreamingError, consumeOneshotGuides])

  const handleRegenerate = useCallback(() => {
    if (isStreaming) return
    if (regenFeedback.enabled) {
      openModal('regenFeedback', {
        onSubmit: (feedback: string) => doRegenerate(feedback),
        onSkip: () => doRegenerate(),
      })
    } else {
      doRegenerate()
    }
  }, [isStreaming, regenFeedback.enabled, openModal, doRegenerate])

  const handleContinue = useCallback(async () => {
    if (isStreaming) return
    const nonce = ++generationNonceRef.current
    beginStreaming()
    try {
      const res = await generateApi.continueGeneration({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: getActivePresetForGeneration() || undefined,
      })
      if (generationNonceRef.current !== nonce) return
      startStreaming(res.generationId)
      consumeOneshotGuides()
    } catch (err: any) {
      if (generationNonceRef.current !== nonce) return
      console.error('[InputArea] Failed to continue:', err)
      const msg = err?.body?.error || err?.message || 'Failed to continue'
      setStreamingError(msg)
      toast.error(msg, { title: 'Continue Failed' })
    }
  }, [chatId, isStreaming, activeProfileId, activePersonaId, getActivePresetForGeneration, beginStreaming, startStreaming, setStreamingError, consumeOneshotGuides])

  const handleImpersonate = useCallback(async (mode: import('@/api/generate').ImpersonateMode) => {
    if (isStreaming) return
    const nonce = ++generationNonceRef.current
    beginStreaming(undefined, 'impersonate')
    try {
      const res = await generateApi.start({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: getActivePresetForGeneration() || undefined,
        generation_type: 'impersonate',
        impersonate_mode: mode,
      })
      if (generationNonceRef.current !== nonce) return
      startStreaming(res.generationId)
      consumeOneshotGuides()
    } catch (err: any) {
      if (generationNonceRef.current !== nonce) return
      console.error('[InputArea] Failed to impersonate:', err)
      const msg = err?.body?.error || err?.message || 'Failed to impersonate'
      setStreamingError(msg)
      toast.error(msg, { title: 'Impersonation Failed' })
    }
  }, [chatId, isStreaming, activeProfileId, activePersonaId, getActivePresetForGeneration, beginStreaming, startStreaming, setStreamingError, consumeOneshotGuides])

  const handleStop = useCallback(async () => {
    if (!isStreaming) return
    try {
      // If we have a generation ID, stop that specific generation.
      // Otherwise (optimistic phase), stop all user generations.
      await generateApi.stop(activeGenerationId || undefined)
    } catch (err) {
      console.error('[InputArea] Failed to stop:', err)
    }
    // If we're in the optimistic phase (no WS events yet), revert locally
    if (!activeGenerationId) {
      stopStreaming()
    }
  }, [isStreaming, activeGenerationId, stopStreaming])

  const handleNewChat = useCallback(async () => {
    if (!activeCharacterId) return
    try {
      const character = await charactersApi.get(activeCharacterId)
      if (character.alternate_greetings?.length > 0) {
        openModal('greetingPicker', {
          character,
          onSelect: async (greetingIndex: number) => {
            try {
              const chat = await chatsApi.create({
                character_id: character.id,
                greeting_index: greetingIndex,
              })
              navigate(`/chat/${chat.id}`)
            } catch (err) {
              console.error('[InputArea] Failed to create chat:', err)
            }
          },
        })
        return
      }
      const chat = await chatsApi.create({ character_id: character.id })
      navigate(`/chat/${chat.id}`)
    } catch (err) {
      console.error('[InputArea] Failed to start new chat:', err)
    }
  }, [activeCharacterId, navigate, openModal])

  const handleDryRun = useCallback(async () => {
    if (dryRunning || isStreaming) return
    setDryRunning(true)
    try {
      const result = await generateApi.dryRun({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: getActivePresetForGeneration() || undefined,
      })
      openModal('dryRun', result)
    } catch (err: any) {
      console.error('[InputArea] Dry run failed:', err)
      const msg = err?.body?.error || err?.message || 'Dry run failed'
      setStreamingError(msg)
    } finally {
      setDryRunning(false)
    }
  }, [chatId, dryRunning, isStreaming, activeProfileId, activePersonaId, getActivePresetForGeneration, openModal, setStreamingError])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter') {
        if (enterToSend) {
          if (!e.shiftKey) {
            e.preventDefault()
            handleSend()
          }
        } else {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            handleSend()
          }
        }
      }
    },
    [enterToSend, handleSend]
  )

  // Auto-resize textarea
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value)
    const ta = e.target
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 180) + 'px'
  }, [])

  const toggleGuide = useCallback((id: string) => {
    const next = guidedGenerations.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g))
    setSetting('guidedGenerations', next)
  }, [guidedGenerations, setSetting])

  return (
    <div
      ref={containerRef}
      className={styles.container}
      style={screenCornerRadius ? {
        borderRadius: inputFocused
          ? 'var(--lcs-radius, 14px)'
          : `var(--lcs-radius, 14px) var(--lcs-radius, 14px) ${screenCornerRadius}px ${screenCornerRadius}px`,
      } : undefined}
    >
      {/* Author's Note Panel */}
      <AuthorsNotePanel
        chatId={chatId}
        isOpen={authorsNoteOpen}
        onClose={() => setAuthorsNoteOpen(false)}
      />

      {/* Action bar — hidden during streaming */}
      <div data-spindle-mount="chat_toolbar">
        {!isStreaming && (
          <div className={styles.actionBar}>
            <button type="button" className={styles.actionBtn} onClick={() => navigate('/')} title="Back to home">
              <Home size={14} />
            </button>
            <span className={styles.actionDivider} />
            <button type="button" className={styles.actionBtn} onClick={handleRegenerate} title="Regenerate">
              <RotateCw size={14} />
            </button>
            <button type="button" className={styles.actionBtn} onClick={handleContinue} title="Continue">
              <CornerDownLeft size={14} />
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'persona' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'persona' ? null : 'persona'))}
              title="Send next message as persona"
            >
              <UserCircle size={14} />
              {sendPersonaId && <span className={styles.badge}>1</span>}
            </button>
            {hasAltFields && (
              <button
                type="button"
                className={clsx(styles.actionBtn, openPopover === 'altFields' && styles.actionBtnActive)}
                onClick={() => setOpenPopover((p) => (p === 'altFields' ? null : 'altFields'))}
                title="Alternate fields"
              >
                <Layers size={14} />
                {Object.keys(altFieldSelections).length > 0 && <span className={styles.badge}>{Object.keys(altFieldSelections).length}</span>}
              </button>
            )}
            {hasAddons && (
              <button
                type="button"
                className={clsx(styles.actionBtn, openPopover === 'addons' && styles.actionBtnActive)}
                onClick={() => setOpenPopover((p) => (p === 'addons' ? null : 'addons'))}
                title="Persona add-ons"
              >
                <Puzzle size={14} />
              </button>
            )}
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'guides' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'guides' ? null : 'guides'))}
              title="Guided generations"
            >
              <Compass size={14} />
              {activeGuideCount > 0 && <span className={styles.badge}>{activeGuideCount}</span>}
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'quick' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'quick' ? null : 'quick'))}
              title="Quick replies"
            >
              <MessageSquareQuote size={14} />
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'tools' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'tools' ? null : 'tools'))}
              title="Tools"
            >
              <Wrench size={14} />
            </button>
            <button
              type="button"
              className={clsx(styles.actionBtn, openPopover === 'extras' && styles.actionBtnActive)}
              onClick={() => setOpenPopover((p) => (p === 'extras' ? null : 'extras'))}
              title="Extras"
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        )}
      </div>

      {activeGuideCount > 0 && (
        <div className={styles.guidePills}>
          {activeGuides.map((g) => (
            <button key={g.id} type="button" className={styles.guidePill} onClick={() => toggleGuide(g.id)}>
              {g.name}
            </button>
          ))}
        </div>
      )}

      <div className={clsx(styles.popoverSlot, openPopover && styles.popoverSlotOpen)}>
        <div className={styles.popoverSlotInner}>
          {renderPopover === 'guides' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {guidedGenerations.length === 0 && <div className={styles.popEmpty}>No guided generations configured.</div>}
              {guidedGenerations.map((g) => (
                <button key={g.id} type="button" className={styles.popRowBtn} onClick={() => toggleGuide(g.id)}>
                  <span>{g.name}</span>
                  <span className={styles.popMeta}>{g.enabled ? 'ON' : 'OFF'} • {g.mode}</span>
                </button>
              ))}
              <button type="button" className={styles.popLink} onClick={() => {
                setOpenPopover(null)
                useStore.getState().openSettings('guided')
              }}>Manage in settings</button>
            </div>
          )}

          {renderPopover === 'quick' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {activeQuickReplySets.length === 0 && <div className={styles.popEmpty}>No enabled quick reply sets.</div>}
              {activeQuickReplySets.map((set) => (
                <div key={set.id} className={styles.quickSet}>
                  <div className={styles.quickSetName}>{set.name}</div>
                  {set.replies.map((reply) => (
                    <button
                      key={reply.id}
                      type="button"
                      className={styles.popRowBtn}
                      onClick={() => {
                        setText(reply.message)
                        setOpenPopover(null)
                        requestAnimationFrame(() => textareaRef.current?.focus())
                      }}
                    >
                      <span>{reply.label || 'Untitled reply'}</span>
                    </button>
                  ))}
                </div>
              ))}
              <button type="button" className={styles.popLink} onClick={() => {
                setOpenPopover(null)
                useStore.getState().openSettings('quickReplies')
              }}>Manage in settings</button>
            </div>
          )}

          {renderPopover === 'persona' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {sendPersonaId && (
                <button
                  type="button"
                  className={styles.popLink}
                  onClick={() => {
                    setSendPersonaId(null)
                    setOpenPopover(null)
                  }}
                >
                  Clear one-shot persona
                </button>
              )}
              {personaList.length === 0 && <div className={styles.popEmpty}>No personas available.</div>}
              {personaList.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={clsx(styles.popRowBtn, sendPersonaId === p.id && styles.popRowBtnActive)}
                  onClick={() => {
                    setSendPersonaId(p.id)
                    setOpenPopover(null)
                  }}
                >
                  <span className={styles.personaMain}>
                    <span className={styles.personaAvatar}>
                      {p.avatar_path || p.image_id ? (
                        <img
                          className={styles.personaAvatarImg}
                          src={getPersonaAvatarThumbUrlById(p.id, p.image_id) || undefined}
                          alt={p.name}
                          loading="lazy"
                        />
                      ) : (
                        <span className={styles.personaFallback}>{p.name.slice(0, 1).toUpperCase()}</span>
                      )}
                    </span>
                    <span className={styles.personaNameGroup}>
                      <span>{p.name}</span>
                      {p.title && <span className={styles.personaTitle}>{p.title}</span>}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {renderPopover === 'tools' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <button
                type="button"
                className={styles.popRowBtn}
                onClick={() => {
                  setOpenPopover(null)
                  openModal('manageChats', {
                    characterId: activeCharacterId,
                    characterName: characterName || 'Character',
                  })
                }}
              >
                <span className={styles.personaMain}>
                  <FolderOpen size={14} />
                  <span>Manage Chats</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.popRowBtn}
                onClick={() => {
                  setOpenPopover(null)
                  openModal('groupChatCreator')
                }}
              >
                <span className={styles.personaMain}>
                  <UsersRound size={14} />
                  <span>New Group Chat</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.popRowBtn}
                onClick={() => {
                  setOpenPopover(null)
                  setAuthorsNoteOpen(true)
                }}
              >
                <span className={styles.personaMain}>
                  <StickyNote size={14} />
                  <span>Author's Note</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.popRowBtn}
                onClick={async () => {
                  setOpenPopover(null)
                  try {
                    toast.info('Recompiling chat memories...')
                    const res = await embeddingsApi.recompileChatMemory(chatId)
                    toast.success(`Recompiled: ${res.totalChunks} chunk${res.totalChunks !== 1 ? 's' : ''}, ${res.pendingChunks} pending vectorization`)
                  } catch (err: any) {
                    toast.error(err?.message || 'Failed to recompile memories')
                  }
                }}
              >
                <span className={styles.personaMain}>
                  <BrainCircuit size={14} />
                  <span>Recompile Memories</span>
                </span>
              </button>
              {hasExpressions && !expressionDisplay.enabled && (
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    setExpressionDisplay({ enabled: true, minimized: false })
                  }}
                >
                  <span className={styles.personaMain}>
                    <Drama size={14} />
                    <span>Show Expression Display</span>
                  </span>
                </button>
              )}
            </div>
          )}

          {renderPopover === 'extras' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.extrasSection}>
                <div className={styles.quickSetName}>Impersonate</div>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    handleImpersonate('prompts')
                  }}
                >
                  <span className={styles.personaMain}>
                    <ScrollText size={14} />
                    <span className={styles.personaNameGroup}>
                      <span>Preset Prompts</span>
                      <span className={styles.personaTitle}>Full assembly with impersonate-triggered blocks</span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    handleImpersonate('oneliner')
                  }}
                >
                  <span className={styles.personaMain}>
                    <MessageSquare size={14} />
                    <span className={styles.personaNameGroup}>
                      <span>One-liner</span>
                      <span className={styles.personaTitle}>Chat history + impersonation nudge only</span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  disabled
                  style={{ opacity: 0.4 }}
                  title="Coming soon"
                >
                  <span className={styles.personaMain}>
                    <Crown size={14} />
                    <span className={styles.personaNameGroup}>
                      <span>Sovereign Hand</span>
                      <span className={styles.personaTitle}>Co-pilot guided impersonation (coming soon)</span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    handleNewChat()
                  }}
                >
                  <span className={styles.personaMain}>
                    <FilePlus size={14} />
                    <span>New Chat</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    handleDryRun()
                  }}
                  disabled={dryRunning}
                  style={dryRunning ? { opacity: 0.5 } : undefined}
                >
                  <span className={styles.personaMain}>
                    <Eye size={14} />
                    <span>Dry Run</span>
                  </span>
                </button>
              </div>
              <InputBarExtensionActions onClose={() => setOpenPopover(null)} />
            </div>
          )}

          {renderPopover === 'altFields' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.quickSetName}>Alternate Fields</div>
              {(['description', 'personality', 'scenario'] as const).map((field) => {
                const variants = altFieldsData[field]
                if (!Array.isArray(variants) || variants.length === 0) return null
                const selectedId = altFieldSelections[field] || ''
                return (
                  <div key={field} className={styles.popRowBtn} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'default' }}>
                    <span style={{ textTransform: 'capitalize' }}>{field}</span>
                    <select
                      style={{
                        marginLeft: 8,
                        flex: 1,
                        minWidth: 0,
                        padding: '3px 6px',
                        fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))',
                        background: 'var(--lumiverse-fill-hover)',
                        border: '1px solid var(--lumiverse-border)',
                        borderRadius: 6,
                        color: 'var(--lumiverse-text)',
                        outline: 'none',
                        cursor: 'pointer',
                      }}
                      value={selectedId}
                      onChange={(e) => handleAltFieldSelect(field, e.target.value || null)}
                    >
                      <option value="">Default</option>
                      {variants.map((v) => (
                        <option key={v.id} value={v.id}>{v.label}</option>
                      ))}
                    </select>
                  </div>
                )
              })}
              {Object.values(altFieldsData).every((arr) => !arr?.length) && (
                <div className={styles.popEmpty}>No alternate fields configured.</div>
              )}
            </div>
          )}

          {renderPopover === 'addons' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.quickSetName}>Persona Add-Ons</div>
              {personaAddons.length === 0 && <div className={styles.popEmpty}>No add-ons configured.</div>}
              {personaAddons.map((addon) => (
                <button
                  key={addon.id}
                  type="button"
                  className={clsx(styles.popRowBtn, addon.enabled && styles.popRowBtnActive)}
                  onClick={() => handleToggleAddon(addon.id)}
                >
                  <span className={styles.personaMain}>
                    <Puzzle size={13} style={{ opacity: addon.enabled ? 1 : 0.4, color: addon.enabled ? 'var(--lumiverse-primary)' : undefined }} />
                    <span>{addon.label || 'Untitled add-on'}</span>
                  </span>
                  <span className={styles.popMeta}>{addon.enabled ? 'ON' : 'OFF'}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Attachment preview strip */}
      {pendingAttachments.length > 0 && (
        <div className={styles.attachmentStrip}>
          {pendingAttachments.map((att) => (
            <div key={att.image_id} className={styles.attachmentPreview}>
              {att.type === 'image' && att.previewUrl ? (
                <img src={att.previewUrl} alt={att.original_filename} className={styles.attachmentThumb} />
              ) : (
                <span className={styles.attachmentLabel}>{att.original_filename}</span>
              )}
              <button
                type="button"
                className={styles.attachmentRemove}
                onClick={() => removeAttachment(att.image_id)}
                aria-label="Remove attachment"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input — outside flex row to avoid layout interference on mobile */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,audio/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => handleAttachFiles(e.target.files)}
      />

      {/* Input row */}
      <div className={styles.inputRow}>
        {!isStreaming && (
          <button
            type="button"
            className={styles.attachBtn}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Attach image or audio"
            aria-label="Attach file"
          >
            <Paperclip size={16} />
          </button>
        )}

        <div className={styles.inputWrapper}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder="Type a message..."
            rows={1}
            disabled={isStreaming}
          />
        </div>

        {isStreaming ? (
          <button
            type="button"
            className={clsx(styles.sendBtn, styles.sendBtnStop)}
            onClick={handleStop}
            title="Stop generation"
            aria-label="Stop generation"
          >
            <Square size={16} />
          </button>
        ) : (
          <button
            type="button"
            className={styles.sendBtn}
            onClick={handleSend}
            title={text.trim() || pendingAttachments.length > 0 ? 'Send message' : 'Silent continue (nudge)'}
            aria-label={text.trim() || pendingAttachments.length > 0 ? 'Send message' : 'Silent continue'}
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect, type CSSProperties, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { Send, RotateCw, CornerDownLeft, Square, FilePlus, Eye, UserCircle, Compass, MessageSquareQuote, Wrench, UserRound, UsersRound, UserPlus, Settings2, Home, MoreHorizontal, FolderOpen, Paperclip, X, StickyNote, Crown, ScrollText, MessageSquare, BrainCircuit, Drama, Layers, FileText, Braces, Globe } from 'lucide-react'
import { IconPlaylistAdd } from '@tabler/icons-react'
import { useStore } from '@/store'
import { messagesApi, chatsApi } from '@/api/chats'
import { charactersApi } from '@/api/characters'
import { generateApi } from '@/api/generate'
import { embeddingsApi } from '@/api/embeddings'
import { expressionsApi } from '@/api/expressions'
import { personasApi } from '@/api/personas'
import { globalAddonsApi } from '@/api/global-addons'
import { imagesApi } from '@/api/images'
import { getPersonaAvatarThumbUrlById, getCharacterAvatarThumbUrlById } from '@/lib/avatarUrls'
import { toast } from '@/lib/toast'
import { useDeviceFrameRadius } from '@/hooks/useDeviceFrameRadius'
import useIsMobile from '@/hooks/useIsMobile'
import type { MessageAttachment, PersonaAddon, GlobalAddon, AttachedGlobalAddon } from '@/types/api'
import AuthorsNotePanel from './AuthorsNotePanel'
import { databankApi } from '@/api/databank'
import { resolveMacros } from '@/api/macros'
import type { AutocompleteResult } from '@/api/databank'
import styles from './InputArea.module.css'
import clsx from 'clsx'
import InputBarExtensionActions from './InputBarExtensionActions'
import { unlockNotificationAudio } from '@/lib/notificationAudio'
import { unlockTTSAudio } from '@/lib/ttsAudio'

interface InputAreaProps {
  chatId: string
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
const queueModLabel = isMac ? 'Cmd' : 'Ctrl'
const TEXTAREA_MAX_HEIGHT = 180

// Slugify a character name into a stable @mention token. Matches the
// databank `#` convention (lowercase, hyphen-separated, diacritics stripped).
function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default function InputArea({ chatId }: InputAreaProps) {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [lastImpersonateInput, setLastImpersonateInput] = useState<string>('')
  const [dryRunning, setDryRunning] = useState(false)
  const [resolvingMacros, setResolvingMacros] = useState(false)
  const [authorsNoteOpen, setAuthorsNoteOpen] = useState(false)
  const [openPopover, setOpenPopover] = useState<null | 'guides' | 'quick' | 'persona' | 'tools' | 'extras' | 'altFields' | 'addons' | 'databank' | 'groupMember'>(null)
  const [renderPopover, setRenderPopover] = useState<null | 'guides' | 'quick' | 'persona' | 'tools' | 'extras' | 'altFields' | 'addons' | 'databank' | 'groupMember'>(null)
  const [popoverClosing, setPopoverClosing] = useState(false)
  const [sendPersonaId, setSendPersonaId] = useState<string | null>(null)
  const [personaList, setPersonaList] = useState<Array<{ id: string; name: string; title: string; avatar_path: string | null; image_id: string | null }>>([])
  const [characterName, setCharacterName] = useState('')
  const [impersonationPresetId, setImpersonationPresetId] = useState<string | null>(null)
  const [pendingAttachments, setPendingAttachments] = useState<(MessageAttachment & { previewUrl?: string })[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mirrorRef = useRef<HTMLDivElement>(null)
  // Android IME predictive text fires input events mid-composition where
  // `selectionStart` sits at the *start* of the composing span, not the caret
  // the user sees. Running `@`/`#` detection against that value causes the
  // autocomplete popover to flicker open on the wrong token and can make the
  // caret visually "jump back" onto the partial word. We gate detection on
  // this ref and re-run once on `compositionend` with the committed text.
  const isComposingRef = useRef(false)
  const [hashQuery, setHashQuery] = useState<string | null>(null)
  const [hashStartIndex, setHashStartIndex] = useState(0)
  const [databankResults, setDatabankResults] = useState<AutocompleteResult[]>([])
  const [databankActiveIdx, setDatabankActiveIdx] = useState(0)
  const databankDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [atQuery, setAtQuery] = useState<string | null>(null)
  const [atStartIndex, setAtStartIndex] = useState(0)
  const [atResults, setAtResults] = useState<Array<{ id: string; name: string; slug: string; muted: boolean; image_id: string | null }>>([])
  const [atActiveIdx, setAtActiveIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const pendingSelectionRef = useRef<{ start: number; end: number; direction?: 'forward' | 'backward' | 'none' } | null>(null)
  const sendingRef = useRef(false)
  const generationNonceRef = useRef(0)
  const queueLockRef = useRef(false)
  const touchTimerRef = useRef<number>(0)
  const isStreaming = useStore((s) => s.isStreaming)
  const editingMessageId = useStore((s) => s.editingMessageId)
  const isMobile = useIsMobile()
  const hideForMobileEdit = isMobile && !!editingMessageId
  const activeGenerationId = useStore((s) => s.activeGenerationId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const enterToSend = useStore((s) => s.chatSheldEnterToSend)
  const saveDraftInput = useStore((s) => s.saveDraftInput)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)
  const regenFeedback = useStore((s) => s.regenFeedback)
  const retainCouncilForRegens = useStore((s) => s.councilSettings.toolsSettings.retainResultsForRegens)
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
  const characters = useStore((s) => s.characters)
  const setMentionQueue = useStore((s) => s.setMentionQueue)
  const expressionDisplay = useStore((s) => s.expressionDisplay)
  const setExpressionDisplay = useStore((s) => s.setExpressionDisplay)
  const impersonateDraftContent = useStore((s) => s.impersonateDraftContent)
  const setImpersonateDraftContent = useStore((s) => s.setImpersonateDraftContent)
  const streamingContent = useStore((s) => s.streamingContent)
  const streamingGenerationType = useStore((s) => s.streamingGenerationType)

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

  useEffect(() => {
    if (!chatId) { setImpersonationPresetId(null); return }
    chatsApi.get(chatId, { messages: false })
      .then((chat) => {
        const value = chat.metadata?.impersonation_preset_id
        setImpersonationPresetId(typeof value === 'string' && value ? value : null)
      })
      .catch(() => setImpersonationPresetId(null))
  }, [chatId])

  const handleAltFieldSelect = useCallback(async (field: string, variantId: string | null) => {
    const newSelections = { ...altFieldSelections }
    if (variantId) newSelections[field] = variantId
    else delete newSelections[field]
    setAltFieldSelections(newSelections)
    try {
      // Atomic merge — server re-reads the latest chat row so background
      // writers (post-generation expression detection, council caching,
      // deferred WI/chat var persistence) cannot clobber this selection.
      // Send `null` to delete the key when no fields are selected.
      await chatsApi.patchMetadata(chatId, {
        alternate_field_selections: Object.keys(newSelections).length > 0 ? newSelections : null,
      })
    } catch (err) {
      console.error('[AltFields] Failed to save:', err)
    }
  }, [chatId, altFieldSelections])

  // Track persona add-ons for the active persona
  const [personaAddons, setPersonaAddons] = useState<PersonaAddon[]>([])
  // Track global add-ons attached to the active persona
  const [attachedGlobalAddons, setAttachedGlobalAddons] = useState<(GlobalAddon & { enabled: boolean })[]>([])
  const hasAddons = personaAddons.length > 0 || attachedGlobalAddons.length > 0

  useEffect(() => {
    if (!activePersonaId) { setPersonaAddons([]); setAttachedGlobalAddons([]); return }
    personasApi.get(activePersonaId)
      .then(async (p) => {
        const raw = p.metadata?.addons
        setPersonaAddons(Array.isArray(raw) ? raw : [])
        // Resolve attached global addons
        const refs: AttachedGlobalAddon[] = Array.isArray(p.metadata?.attached_global_addons) ? p.metadata.attached_global_addons : []
        if (refs.length > 0) {
          try {
            const globalRes = await globalAddonsApi.list({ limit: 200, offset: 0 })
            const refMap = new Map(refs.map(r => [r.id, r.enabled]))
            const resolved = globalRes.data
              .filter(g => refMap.has(g.id))
              .map(g => ({ ...g, enabled: refMap.get(g.id)! }))
            setAttachedGlobalAddons(resolved)
          } catch {
            setAttachedGlobalAddons([])
          }
        } else {
          setAttachedGlobalAddons([])
        }
      })
      .catch(() => { setPersonaAddons([]); setAttachedGlobalAddons([]) })
  }, [activePersonaId])

  // Listen for persona changes via store to keep addons in sync
  const storePersonas = useStore((s) => s.personas)
  useEffect(() => {
    if (!activePersonaId) return
    const p = storePersonas.find((x) => x.id === activePersonaId)
    if (p) {
      const raw = p.metadata?.addons
      setPersonaAddons(Array.isArray(raw) ? raw : [])
      // Update global addon enabled state from store
      const refs: AttachedGlobalAddon[] = Array.isArray(p.metadata?.attached_global_addons) ? p.metadata.attached_global_addons : []
      setAttachedGlobalAddons(prev => {
        const refMap = new Map(refs.map(r => [r.id, r.enabled]))
        return prev
          .filter(g => refMap.has(g.id))
          .map(g => ({ ...g, enabled: refMap.get(g.id)! }))
      })
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

  const handleToggleGlobalAddon = useCallback(async (globalAddonId: string) => {
    if (!activePersonaId) return
    const nextAttached = attachedGlobalAddons.map((a) => a.id === globalAddonId ? { ...a, enabled: !a.enabled } : a)
    setAttachedGlobalAddons(nextAttached)
    try {
      const p = await personasApi.get(activePersonaId)
      const refs: AttachedGlobalAddon[] = Array.isArray(p.metadata?.attached_global_addons) ? p.metadata.attached_global_addons : []
      const nextRefs = refs.map((r) => r.id === globalAddonId ? { ...r, enabled: !r.enabled } : r)
      const newMeta = { ...(p.metadata || {}), attached_global_addons: nextRefs }
      const updated = await personasApi.update(activePersonaId, { metadata: newMeta })
      useStore.getState().updatePersona(activePersonaId, updated)
    } catch {
      setAttachedGlobalAddons(attachedGlobalAddons)
      toast.error('Failed to toggle global add-on')
    }
  }, [activePersonaId, attachedGlobalAddons])

  // iPhone-specific: match input bar bottom corners to device screen curvature
  const screenCornerRadius = useDeviceFrameRadius()
  const [inputFocused, setInputFocused] = useState(false)

  const syncTextareaMirrorScroll = useCallback(() => {
    const ta = textareaRef.current
    const mirror = mirrorRef.current
    if (!ta || !mirror) return
    mirror.scrollTop = ta.scrollTop
    mirror.scrollLeft = ta.scrollLeft
  }, [])

  const resizeTextarea = useCallback((ta: HTMLTextAreaElement | null) => {
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, TEXTAREA_MAX_HEIGHT)}px`
    syncTextareaMirrorScroll()
  }, [syncTextareaMirrorScroll])

  const queueTextareaSelection = useCallback((start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'none') => {
    pendingSelectionRef.current = { start, end, direction }
  }, [])

  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    resizeTextarea(ta)
    const pendingSelection = pendingSelectionRef.current
    if (!pendingSelection) return
    pendingSelectionRef.current = null
    ta.focus()
    ta.setSelectionRange(pendingSelection.start, pendingSelection.end, pendingSelection.direction)
    syncTextareaMirrorScroll()
  }, [text, resizeTextarea, syncTextareaMirrorScroll])

  // ── Impersonate draft streaming into textarea ────────────────────────
  // Stream impersonate draft tokens into the textarea live
  useEffect(() => {
    if (streamingGenerationType === 'impersonate_draft' && streamingContent) {
      setText(streamingContent)
      requestAnimationFrame(() => resizeTextarea(textareaRef.current))
    }
  }, [streamingContent, streamingGenerationType, resizeTextarea])

  // When an impersonate draft completes, ensure final content is in the textarea
  useEffect(() => {
    if (impersonateDraftContent) {
      setText(impersonateDraftContent)
      setImpersonateDraftContent(null)
      requestAnimationFrame(() => resizeTextarea(textareaRef.current))
    }
  }, [impersonateDraftContent, setImpersonateDraftContent, resizeTextarea])

  // ── Draft input persistence ──────────────────────────────────────────
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const DRAFT_KEY_PREFIX = 'lumiverse:chatDraft:'

  // Restore draft on mount or chat switch
  useEffect(() => {
    setLastImpersonateInput('')
    if (!saveDraftInput) return
    try {
      const saved = localStorage.getItem(DRAFT_KEY_PREFIX + chatId)
      if (saved) {
        setText(saved)
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

  // Databank # autocomplete — search when hash query changes
  useEffect(() => {
    if (databankDebounceRef.current) clearTimeout(databankDebounceRef.current)
    if (hashQuery === null || hashQuery.length === 0) {
      if (openPopover === 'databank') setOpenPopover(null)
      setDatabankResults([])
      return
    }
    databankDebounceRef.current = setTimeout(async () => {
      try {
        const params: { q: string; chatId?: string; characterId?: string } = { q: hashQuery }
        if (chatId) params.chatId = chatId
        if (activeCharacterId) params.characterId = activeCharacterId
        const res = await databankApi.autocomplete(params)
        const results = res.data || []
        setDatabankResults(results)
        setDatabankActiveIdx(0)
        if (results.length > 0) {
          setOpenPopover('databank')
        } else if (openPopover === 'databank') {
          setOpenPopover(null)
        }
      } catch {
        setDatabankResults([])
      }
    }, 200)
    return () => { if (databankDebounceRef.current) clearTimeout(databankDebounceRef.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hashQuery, chatId, activeCharacterId])

  // @ autocomplete — filter locally against group members. Muted members are
  // kept in the list (dimmed in UI); selecting them overrides mute for this turn.
  useEffect(() => {
    if (!isGroupChat || atQuery === null) {
      if (openPopover === 'groupMember') setOpenPopover(null)
      setAtResults([])
      return
    }
    const q = atQuery.toLowerCase()
    const members = groupCharacterIds
      .map((id) => {
        const c = characters.find((ch) => ch.id === id)
        if (!c) return null
        return {
          id,
          name: c.name,
          slug: slugifyName(c.name),
          muted: mutedCharacterIds.includes(id),
          image_id: (c as any).image_id ?? null,
        }
      })
      .filter(Boolean) as Array<{ id: string; name: string; slug: string; muted: boolean; image_id: string | null }>
    const ranked = members
      .map((m) => {
        const lname = m.name.toLowerCase()
        let score: number
        if (q.length === 0) score = 100
        else if (m.slug.startsWith(q) || lname.startsWith(q)) score = 0
        else if (m.slug.includes(q) || lname.includes(q)) score = 1
        else score = -1
        return { m, score }
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || a.m.name.localeCompare(b.m.name))
      .map((x) => x.m)
    setAtResults(ranked)
    setAtActiveIdx(0)
    if (ranked.length > 0) {
      setOpenPopover('groupMember')
    } else if (openPopover === 'groupMember') {
      setOpenPopover(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atQuery, isGroupChat, groupCharacterIds, mutedCharacterIds, characters])

  // ResizeObserver — set --lcs-input-safe-zone on parent so scroll padding stays in sync
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const parent = el.parentElement
    if (!parent) return
    const isIOSPwa = document.documentElement.hasAttribute('data-ios-pwa')

    const update = () => {
      const h = el.offsetHeight
      // On iOS PWA, read --app-keyboard-inset-bottom directly instead of
      // getComputedStyle(el).bottom. The CSS `bottom` property transitions,
      // so the computed value may be mid-animation when the ResizeObserver
      // fires (triggered by the instant padding-bottom change). The CSS
      // variable is set synchronously by JS and always reflects the final value.
      let bottomOffset: number
      if (isIOSPwa) {
        const rootStyle = getComputedStyle(document.documentElement)
        bottomOffset = parseFloat(rootStyle.getPropertyValue('--app-keyboard-inset-bottom')) || 0
      } else {
        bottomOffset = parseFloat(getComputedStyle(el).bottom) || 12
      }
      parent.style.setProperty('--lcs-input-safe-zone', `${h + bottomOffset + 16}px`)
    }

    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()

    // On iOS PWA, the virtual keyboard changes `bottom` via CSS variable but
    // doesn't change the element's size — ResizeObserver alone won't catch it.
    // Listen to visualViewport resize (keyboard open/close) and re-compute.
    let vpFrame = 0
    const onViewportResize = () => {
      // Run after main.tsx's syncViewportVars (also uses requestAnimationFrame)
      cancelAnimationFrame(vpFrame)
      vpFrame = requestAnimationFrame(update)
    }
    if (isIOSPwa) {
      window.visualViewport?.addEventListener('resize', onViewportResize)
    }

    return () => {
      ro.disconnect()
      cancelAnimationFrame(vpFrame)
      if (isIOSPwa) {
        window.visualViewport?.removeEventListener('resize', onViewportResize)
      }
    }
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

  const DOCUMENT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml',
    '.html', '.htm', '.yaml', '.yml', '.log', '.rst', '.rtf',
  ])

  const isDocumentFile = useCallback((file: File) => {
    const ext = file.name.lastIndexOf('.') >= 0 ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : ''
    return DOCUMENT_EXTENSIONS.has(ext)
  }, [DOCUMENT_EXTENSIONS])

  const handleAttachFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const isImage = file.type.startsWith('image/')
        const isAudio = file.type.startsWith('audio/')
        const isDoc = isDocumentFile(file)

        if (isDoc) {
          // Document files → upload to chat databank for persistent reference
          try {
            const chatLabel = characterName ? `${characterName} Chat` : 'Chat Documents'
            await databankApi.attachToChat(file, chatId, chatLabel)
            const docName = file.name.replace(/\.[^.]+$/, '')
            toast.success(`"${docName}" added to chat databank`, { duration: 3000 })
          } catch (err: any) {
            toast.error(err?.body?.error || err?.message || `Failed to upload ${file.name}`, { title: 'Upload Failed' })
          }
          continue
        }

        if (!isImage && !isAudio) {
          toast.error(`Unsupported file type: ${file.name}`, { title: 'Upload Failed' })
          continue
        }

        // Image/audio → inline attachment as before
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
  }, [isDocumentFile, chatId, characterName])

  const removeAttachment = useCallback((imageId: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.image_id !== imageId))
  }, [])

  // Detect trailing consecutive user messages (queued messages awaiting generation)
  const hasQueuedMessages = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].extra?.hidden) continue
      return messages[i].is_user
    }
    return false
  }, [messages])

  const handleQueueMessage = useCallback(async () => {
    if (sendingRef.current || isStreaming) return
    const content = text.trim()
    const attachments = pendingAttachments.length > 0
      ? pendingAttachments.map(({ previewUrl: _, ...a }) => a)
      : undefined
    if (!content && !attachments) return

    sendingRef.current = true
    setText('')
    setPendingAttachments([])
    if (saveDraftInput) {
      try { localStorage.removeItem(DRAFT_KEY_PREFIX + chatId) } catch {}
    }

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        resizeTextarea(textareaRef.current)
        textareaRef.current.focus()
      }
    })

    try {
      const effectivePersonaId = sendPersonaId || activePersonaId
      const effectivePersonaName = personas.find((p) => p.id === effectivePersonaId)?.name || 'User'
      const extra: Record<string, any> = {}
      if (effectivePersonaId) extra.persona_id = effectivePersonaId
      if (attachments) extra.attachments = attachments

      const msg = await messagesApi.create(chatId, {
        is_user: true,
        name: effectivePersonaName,
        content: content || '(attached)',
        extra: Object.keys(extra).length > 0 ? extra : undefined,
      })
      addMessage(msg)
      if (sendPersonaId) setSendPersonaId(null)
      toast.info('Message queued', { duration: 1500 })
    } catch (err: any) {
      console.error('[InputArea] Failed to queue message:', err)
      toast.error(err?.body?.error || err?.message || 'Failed to queue message')
    } finally {
      sendingRef.current = false
    }
  }, [text, chatId, isStreaming, activePersonaId, personas, sendPersonaId, pendingAttachments, addMessage, saveDraftInput, resizeTextarea])

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
        resizeTextarea(textareaRef.current)
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

      // Parse @mentions in the user's message (group chats only). Each mention
      // force-summons a group member in the order they appear — muted members
      // included. Mentions are normalized to canonical names in the saved text.
      let finalContent = content
      const mentionedIds: string[] = []
      if (isGroupChat && content) {
        const slugToMember = new Map<string, { id: string; name: string }>()
        for (const id of groupCharacterIds) {
          const c = characters.find((ch) => ch.id === id)
          if (!c) continue
          const slug = slugifyName(c.name)
          if (!slugToMember.has(slug)) slugToMember.set(slug, { id, name: c.name })
        }
        const seen = new Set<string>()
        finalContent = content.replace(/(^|\s)@([a-z0-9][a-z0-9-]*)(?=\s|$|[.,!?;:])/gi, (_, lead: string, rawSlug: string) => {
          const slug = rawSlug.toLowerCase()
          const member = slugToMember.get(slug)
          if (!member) return `${lead}@${rawSlug}`
          if (!seen.has(member.id)) { seen.add(member.id); mentionedIds.push(member.id) }
          return `${lead}@${member.name}`
        })
      }

      // Initial speaker: first mention → first unmuted → undefined.
      if (isGroupChat && groupCharacterIds.length > 0) {
        if (mentionedIds.length > 0) {
          genOpts.target_character_id = mentionedIds[0]
        } else {
          const firstUnmuted = groupCharacterIds.find((id) => !mutedCharacterIds.includes(id))
          if (firstUnmuted) genOpts.target_character_id = firstUnmuted
        }
      }

      // Queue remaining mentioned members to speak in order after the first.
      const remainingMentions = mentionedIds.slice(1)
      if (isGroupChat && remainingMentions.length > 0) {
        setMentionQueue({
          chatId,
          ids: remainingMentions,
          opts: {
            connection_id: genOpts.connection_id,
            persona_id: genOpts.persona_id,
            preset_id: genOpts.preset_id,
          },
        })
      } else {
        setMentionQueue(null)
      }

      if (finalContent || attachments) {
        const extra: Record<string, any> = {}
        if (effectivePersonaId) extra.persona_id = effectivePersonaId
        if (attachments) extra.attachments = attachments
        const msg = await messagesApi.create(chatId, {
          is_user: true,
          name: effectivePersonaName,
          content: finalContent || '(attached)',
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
      } else if (hasQueuedMessages) {
        // Queued user messages waiting — trigger normal generation
        beginStreaming()
        const res = await generateApi.start(genOpts)
        if (generationNonceRef.current !== nonce) return
        startStreaming(res.generationId)
        consumeOneshotGuides()
      } else {
        // Empty send from the input bar is a nudge for a fresh reply, not the
        // explicit Continue action that appends onto the previous assistant message.
        beginStreaming()
        const res = await generateApi.start(genOpts)
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
  }, [text, chatId, isStreaming, activeProfileId, activePersonaId, getActivePresetForGeneration, personas, sendPersonaId, pendingAttachments, addMessage, startStreaming, setStreamingError, consumeOneshotGuides, saveDraftInput, hasQueuedMessages, isGroupChat, groupCharacterIds, mutedCharacterIds, characters, setMentionQueue, resizeTextarea])

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
        retain_council: retainCouncilForRegens || undefined,
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
  }, [chatId, isStreaming, messages, activeProfileId, activePersonaId, getActivePresetForGeneration, regenFeedback.position, retainCouncilForRegens, addMessage, beginStreaming, startStreaming, setStreamingError, consumeOneshotGuides])

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
    beginStreaming(undefined, 'continue')
    try {
      const res = await generateApi.continueGeneration({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: getActivePresetForGeneration() || undefined,
        retain_council: retainCouncilForRegens || undefined,
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
    const impersonateInput = text.trim()
    beginStreaming(undefined, 'impersonate_draft')
    // Stash the input so the user can restore it after the run, and clear the box.
    if (impersonateInput) {
      setLastImpersonateInput(impersonateInput)
      setText('')
      try { localStorage.removeItem(DRAFT_KEY_PREFIX + chatId) } catch {}
      requestAnimationFrame(() => resizeTextarea(textareaRef.current))
    }
    try {
      const forcedPresetId = mode === 'oneliner' ? impersonationPresetId : null
      const res = await generateApi.start({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: forcedPresetId || getActivePresetForGeneration() || undefined,
        force_preset_id: !!forcedPresetId,
        generation_type: 'impersonate',
        impersonate_mode: mode,
        impersonate_input: impersonateInput || undefined,
        impersonate_draft: true,
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
  }, [chatId, isStreaming, text, activeProfileId, activePersonaId, impersonationPresetId, getActivePresetForGeneration, beginStreaming, startStreaming, setStreamingError, consumeOneshotGuides, resizeTextarea])

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
    // For group chats, open group creator pre-populated with current members
    if (isGroupChat && groupCharacterIds.length > 0) {
      openModal('groupChatCreator', { initialCharacterIds: [...groupCharacterIds] })
      return
    }
    if (!activeCharacterId) return
    let creationToastId: string | null = null
    try {
      const character = await charactersApi.get(activeCharacterId)
      if (character.alternate_greetings?.length > 0) {
        openModal('greetingPicker', {
          character,
          onSelect: async (greetingIndex: number) => {
            const toastId = toast.info('Creating chat and preparing Memory Cortex in the background…', {
              title: 'Starting Chat',
              duration: 60_000,
              dismissible: false,
            })
            try {
              const chat = await chatsApi.create({
                character_id: character.id,
                greeting_index: greetingIndex,
              })
              toast.dismiss(toastId)
              navigate(`/chat/${chat.id}`)
            } catch (err) {
              toast.dismiss(toastId)
              console.error('[InputArea] Failed to create chat:', err)
              toast.error('Failed to create chat')
            }
          },
        })
        return
      }
      creationToastId = toast.info('Creating chat and preparing Memory Cortex in the background…', {
        title: 'Starting Chat',
        duration: 60_000,
        dismissible: false,
      })
      const chat = await chatsApi.create({ character_id: character.id })
      toast.dismiss(creationToastId)
      creationToastId = null
      navigate(`/chat/${chat.id}`)
    } catch (err) {
      if (creationToastId) toast.dismiss(creationToastId)
      console.error('[InputArea] Failed to start new chat:', err)
      toast.error('Failed to start new chat')
    }
  }, [activeCharacterId, isGroupChat, groupCharacterIds, navigate, openModal])

  const handleDryRun = useCallback(async () => {
    if (dryRunning || isStreaming) return
    const presetId = getActivePresetForGeneration()
    if (!presetId) {
      toast.warning('No preset selected. Create or select a preset to dry-run.')
      return
    }
    setDryRunning(true)
    try {
      const result = await generateApi.dryRun({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        preset_id: presetId,
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

  const handleResolveMacros = useCallback(async () => {
    if (resolvingMacros || isStreaming) return
    const template = text.trim()
    if (!template) {
      toast.info('Nothing to resolve')
      return
    }
    setResolvingMacros(true)
    try {
      const res = await resolveMacros({
        template: text,
        chat_id: chatId,
        character_id: activeCharacterId || undefined,
        persona_id: activePersonaId || undefined,
        connection_id: activeProfileId || undefined,
      })
      if (res.text === text) {
        toast.info('No macros found to resolve')
      } else {
        queueTextareaSelection(res.text.length)
        setText(res.text)
        const warns = res.diagnostics.filter((d) => d.level === 'warning' || d.level === 'error')
        if (warns.length > 0) {
          toast.warning(`Macros resolved with ${warns.length} warning${warns.length !== 1 ? 's' : ''}`)
        } else {
          toast.success('Macros resolved')
        }
      }
    } catch (err: any) {
      console.error('[InputArea] Macro resolution failed:', err)
      const msg = err?.body?.error || err?.message || 'Failed to resolve macros'
      toast.error(msg)
    } finally {
      setResolvingMacros(false)
    }
  }, [text, chatId, resolvingMacros, isStreaming, activeCharacterId, activePersonaId, activeProfileId, queueTextareaSelection])

  const handleHashSelect = useCallback((result: { slug: string; name: string }) => {
    const before = text.slice(0, hashStartIndex)
    const afterCursor = text.slice(hashStartIndex + 1 + (hashQuery?.length ?? 0))
    const newText = `${before}#${result.slug} ${afterCursor}`
    queueTextareaSelection(before.length + result.slug.length + 2)
    setText(newText)
    setHashQuery(null)
    setOpenPopover(null)
  }, [text, hashStartIndex, hashQuery, queueTextareaSelection])

  const handleAtSelect = useCallback((result: { slug: string; name: string }) => {
    const before = text.slice(0, atStartIndex)
    const afterCursor = text.slice(atStartIndex + 1 + (atQuery?.length ?? 0))
    const newText = `${before}@${result.slug} ${afterCursor}`
    queueTextareaSelection(before.length + result.slug.length + 2)
    setText(newText)
    setAtQuery(null)
    setOpenPopover(null)
  }, [text, atStartIndex, atQuery, queueTextareaSelection])

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Intercept keys when databank autocomplete popover is active
      if (openPopover === 'databank' && databankResults.length > 0) {
        if (e.key === 'ArrowUp') { e.preventDefault(); setDatabankActiveIdx((i) => Math.max(0, i - 1)); return }
        if (e.key === 'ArrowDown') { e.preventDefault(); setDatabankActiveIdx((i) => Math.min(databankResults.length - 1, i + 1)); return }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleHashSelect(databankResults[databankActiveIdx]); return }
        if (e.key === 'Escape') { e.preventDefault(); setHashQuery(null); setOpenPopover(null); return }
      }

      // Intercept keys when @ member autocomplete popover is active
      if (openPopover === 'groupMember' && atResults.length > 0) {
        if (e.key === 'ArrowUp') { e.preventDefault(); setAtActiveIdx((i) => Math.max(0, i - 1)); return }
        if (e.key === 'ArrowDown') { e.preventDefault(); setAtActiveIdx((i) => Math.min(atResults.length - 1, i + 1)); return }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAtSelect(atResults[atActiveIdx]); return }
        if (e.key === 'Tab') { e.preventDefault(); handleAtSelect(atResults[atActiveIdx]); return }
        if (e.key === 'Escape') { e.preventDefault(); setAtQuery(null); setOpenPopover(null); return }
      }

      // Cmd+L (Mac) / Ctrl+L (other) — resolve macros in input
      if (e.key === 'l' && (isMac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        handleResolveMacros()
        return
      }

      if (e.key === 'Enter') {
        const queueMod = isMac ? e.metaKey : e.ctrlKey
        if (enterToSend) {
          if (queueMod) {
            e.preventDefault()
            handleQueueMessage()
          } else if (!e.shiftKey) {
            e.preventDefault()
            handleSend()
          }
        } else {
          if (queueMod) {
            e.preventDefault()
            handleQueueMessage()
          }
        }
      }
    },
    [enterToSend, handleSend, handleQueueMessage, handleResolveMacros, openPopover, databankResults, databankActiveIdx, handleHashSelect, atResults, atActiveIdx, handleAtSelect]
  )

  // Send button: cmd+click (mac) / ctrl+click (other) queues, normal click sends
  const handleSendClick = useCallback((e: React.MouseEvent) => {
    unlockNotificationAudio()
    unlockTTSAudio()
    if (queueLockRef.current) {
      queueLockRef.current = false
      return
    }
    const queueMod = isMac ? e.metaKey : e.ctrlKey
    if (queueMod && (text.trim() || pendingAttachments.length > 0)) {
      handleQueueMessage()
    } else {
      handleSend()
    }
  }, [text, pendingAttachments, handleQueueMessage, handleSend])

  // Long-press on send button (mobile, 2s) queues the message
  const handleSendTouchStart = useCallback(() => {
    if (!text.trim() && pendingAttachments.length === 0) return
    touchTimerRef.current = window.setTimeout(() => {
      queueLockRef.current = true
      handleQueueMessage()
    }, 2000)
  }, [text, pendingAttachments, handleQueueMessage])

  const handleSendTouchEnd = useCallback(() => {
    if (touchTimerRef.current) {
      clearTimeout(touchTimerRef.current)
      touchTimerRef.current = 0
    }
  }, [])

  // Detect `#`/`@` autocomplete triggers from the textarea's current value
  // and caret position. Pulled out of `handleInput` so `compositionend` can
  // re-run the same scan once IME input has fully committed.
  const runAutocompleteDetection = useCallback((ta: HTMLTextAreaElement) => {
    const val = ta.value
    const cursorPos = ta.selectionStart ?? val.length
    const textBeforeCursor = val.slice(0, cursorPos)

    const hashIdx = textBeforeCursor.lastIndexOf('#')
    if (hashIdx >= 0) {
      const charBefore = hashIdx > 0 ? textBeforeCursor[hashIdx - 1] : ' '
      if (hashIdx === 0 || /\s/.test(charBefore)) {
        const fragment = textBeforeCursor.slice(hashIdx + 1)
        if (!fragment.includes(' ') && fragment.length > 0) {
          setHashQuery(fragment)
          setHashStartIndex(hashIdx)
          setAtQuery(null)
          return
        }
      }
    }
    setHashQuery(null)

    if (isGroupChat) {
      const atIdx = textBeforeCursor.lastIndexOf('@')
      if (atIdx >= 0) {
        const charBefore = atIdx > 0 ? textBeforeCursor[atIdx - 1] : ' '
        if (atIdx === 0 || /\s/.test(charBefore)) {
          const fragment = textBeforeCursor.slice(atIdx + 1)
          if (!/\s/.test(fragment)) {
            setAtQuery(fragment)
            setAtStartIndex(atIdx)
            return
          }
        }
      }
    }
    setAtQuery(null)
  }, [isGroupChat])

  // Auto-resize textarea
  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setText(val)
    const ta = e.target

    // Skip trigger detection while an IME is composing (Android predictive
    // text, CJK input, etc.). `selectionStart` is unreliable mid-composition
    // and would flicker the popover or re-anchor `atStartIndex` incorrectly.
    if (isComposingRef.current) return

    runAutocompleteDetection(ta)
  }, [runAutocompleteDetection])

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true
  }, [])

  const handleCompositionEnd = useCallback((e: React.CompositionEvent<HTMLTextAreaElement>) => {
    isComposingRef.current = false
    const ta = e.currentTarget
    // Mirror React's onChange state for the final committed value — some
    // Android IMEs (Gboard swipe, Samsung Keyboard) commit via composition
    // without firing a trailing `input` event.
    if (ta.value !== text) setText(ta.value)
    runAutocompleteDetection(ta)
  }, [runAutocompleteDetection, text])

  // Background-only mirror content. The textarea renders the real visible text
  // so caret geometry, drag-selection, and IME behavior stay native, while the
  // mirror only paints pill backgrounds behind matching @/# tokens.
  // A trailing `\u200b` keeps the last line's height when the user's text ends
  // with a newline.
  const mirrorContent = useMemo(() => {
    const ZWSP = '\u200B'
    if (!text) return ZWSP

    const slugMap = new Map<string, { muted: boolean }>()
    if (isGroupChat) {
      for (const id of groupCharacterIds) {
        const c = characters.find((ch) => ch.id === id)
        if (!c) continue
        const slug = slugifyName(c.name)
        if (slug) slugMap.set(slug, { muted: mutedCharacterIds.includes(id) })
      }
    }

    const parts: React.ReactNode[] = []
    const re = /(^|\s)([@#])([a-z0-9][a-z0-9-]*)(?=\s|$|[.,!?;:])/gi
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(text)) !== null) {
      const [, lead, trigger, rawSlug] = match
      const normalizedSlug = rawSlug.toLowerCase()
      const info = trigger === '@' ? slugMap.get(normalizedSlug) : null
      const shouldHighlight = trigger === '#' || !!info
      if (!shouldHighlight) continue
      const tagStart = match.index + lead.length
      const tagEnd = tagStart + trigger.length + rawSlug.length
      if (tagStart > lastIndex) parts.push(text.slice(lastIndex, tagStart))
      parts.push(
        <span
          key={`mp-${tagStart}`}
          className={
            trigger === '#'
              ? styles.documentPill
              : info?.muted
                ? styles.mentionPillMuted
                : styles.mentionPill
          }
        >
          {trigger}{rawSlug}
        </span>
      )
      lastIndex = tagEnd
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex))
    parts.push(ZWSP)
    return <>{parts}</>
  }, [text, isGroupChat, groupCharacterIds, mutedCharacterIds, characters])

  // Keep the mirror's scroll position locked to the textarea so pills stay
  // aligned with the caret once content overflows the 180px max-height.
  const handleTextareaScroll = useCallback(() => {
    syncTextareaMirrorScroll()
  }, [syncTextareaMirrorScroll])

  const toggleGuide = useCallback((id: string) => {
    const next = guidedGenerations.map((g) => (g.id === id ? { ...g, enabled: !g.enabled } : g))
    setSetting('guidedGenerations', next)
  }, [guidedGenerations, setSetting])

  return (
    <div
      data-component="InputArea"
      ref={containerRef}
      className={styles.container}
      style={(() => {
        const s: CSSProperties = {}
        if (screenCornerRadius) {
          s.borderRadius = inputFocused
            ? 'var(--lcs-radius, 14px)'
            : `var(--lcs-radius, 14px) var(--lcs-radius, 14px) ${screenCornerRadius}px ${screenCornerRadius}px`
        }
        if (hideForMobileEdit) s.display = 'none'
        return Object.keys(s).length ? s : undefined
      })()}
    >
      {/* Author's Note Panel */}
      <AuthorsNotePanel
        chatId={chatId}
        isOpen={authorsNoteOpen}
        onClose={() => setAuthorsNoteOpen(false)}
      />

      {/* Action bar — home button always visible, rest hidden during streaming */}
      <div data-spindle-mount="chat_toolbar">
        {isStreaming && (
          <div className={styles.actionBar}>
            <button type="button" className={styles.actionBtn} onClick={() => navigate('/')} title="Back to home">
              <Home size={14} />
            </button>
          </div>
        )}
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
            {hasAltFields && (() => {
              const selectionCount = Object.keys(altFieldSelections).length
              const hasSelection = selectionCount > 0
              // Build a descriptive title so the user can confirm what's bound
              // to this chat without opening the popover.
              const titleParts: string[] = []
              for (const [field, variantId] of Object.entries(altFieldSelections)) {
                const variant = altFieldsData[field]?.find((v) => v.id === variantId)
                if (variant) titleParts.push(`${field}: ${variant.label}`)
              }
              const title = hasSelection
                ? `Alternate fields — ${titleParts.join(', ')}`
                : 'Alternate fields'
              return (
                <button
                  type="button"
                  className={clsx(
                    styles.actionBtn,
                    openPopover === 'altFields' && styles.actionBtnActive,
                    hasSelection && styles.actionBtnHasSelection,
                  )}
                  onClick={() => setOpenPopover((p) => (p === 'altFields' ? null : 'altFields'))}
                  title={title}
                  aria-label={title}
                >
                  <Layers size={14} />
                  {hasSelection && <span className={styles.badge}>{selectionCount}</span>}
                </button>
              )
            })()}
            {hasAddons && (
              <button
                type="button"
                className={clsx(styles.actionBtn, openPopover === 'addons' && styles.actionBtnActive)}
                onClick={() => setOpenPopover((p) => (p === 'addons' ? null : 'addons'))}
                title="Persona add-ons"
              >
                <IconPlaylistAdd size={14} />
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
                        queueTextareaSelection(reply.message.length)
                        setText(reply.message)
                        setOpenPopover(null)
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
                    characterName: isGroupChat ? 'Group Chat' : (characterName || 'Character'),
                    isGroupChat,
                    groupCharacterIds,
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
                onClick={async () => {
                  setOpenPopover(null)
                  try {
                    const chat = await chatsApi.get(chatId, { messages: false })
                    openModal('chatSettings', {
                      chatId,
                      chatName: chat.name || '',
                      metadata: chat.metadata || {},
                      onSaved: (updatedChat: import('@/types/api').Chat) => {
                        const value = updatedChat.metadata?.impersonation_preset_id
                        setImpersonationPresetId(typeof value === 'string' && value ? value : null)
                      },
                    })
                  } catch (err) {
                    console.error('[InputArea] Failed to load chat settings:', err)
                  }
                }}
              >
                <span className={styles.personaMain}>
                  <Settings2 size={14} />
                  <span>{isGroupChat ? 'Group Settings' : 'Chat Settings'}</span>
                </span>
              </button>
              {!isGroupChat && activeCharacterId && (
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    openModal('groupChatCreator', { initialCharacterIds: [activeCharacterId] })
                  }}
                >
                  <span className={styles.personaMain}>
                    <UserPlus size={14} />
                    <span>Convert to Group Chat</span>
                  </span>
                </button>
              )}
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
                {lastImpersonateInput && (
                  <button
                    type="button"
                    className={styles.popRowBtn}
                    title={lastImpersonateInput}
                    onClick={() => {
                      setOpenPopover(null)
                      const nextText = text ? `${text}\n${lastImpersonateInput}` : lastImpersonateInput
                      queueTextareaSelection(nextText.length)
                      setText(nextText)
                      setLastImpersonateInput('')
                    }}
                  >
                    <span className={styles.personaMain}>
                      <ScrollText size={14} />
                      <span className={styles.personaNameGroup}>
                        <span>Restore last input</span>
                        <span className={styles.personaTitle}>{lastImpersonateInput.length > 60 ? lastImpersonateInput.slice(0, 60) + '…' : lastImpersonateInput}</span>
                      </span>
                    </span>
                  </button>
                )}
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
                {(() => {
                  const hasPreset = !!getActivePresetForGeneration()
                  const dryRunDisabled = dryRunning || !hasPreset
                  return (
                    <button
                      type="button"
                      className={styles.popRowBtn}
                      onClick={() => {
                        setOpenPopover(null)
                        handleDryRun()
                      }}
                      disabled={dryRunDisabled}
                      style={dryRunDisabled ? { opacity: 0.5 } : undefined}
                      title={!hasPreset ? 'No preset selected' : undefined}
                    >
                      <span className={styles.personaMain}>
                        <Eye size={14} />
                        <span className={styles.personaNameGroup}>
                          <span>Dry Run</span>
                          <span className={styles.personaTitle}>
                            {hasPreset ? 'Preview the full prompt sent to the AI without generating' : 'Select a preset to enable dry run'}
                          </span>
                        </span>
                      </span>
                    </button>
                  )
                })()}
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    handleResolveMacros()
                  }}
                  disabled={resolvingMacros}
                  style={resolvingMacros ? { opacity: 0.5 } : undefined}
                >
                  <span className={styles.personaMain}>
                    <Braces size={14} />
                    <span className={styles.personaNameGroup}>
                      <span>Resolve Macros</span>
                      <span className={styles.personaTitle}>Replace macros in input text ({isMac ? '⌘' : 'Ctrl'}+L)</span>
                    </span>
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
                const isOverridden = !!selectedId
                return (
                  <div
                    key={field}
                    className={styles.popRowBtn}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      cursor: 'default',
                      // Subtle accent border on rows that have an active override
                      // so the user sees at a glance which fields are bound.
                      borderLeft: isOverridden
                        ? '2px solid var(--lumiverse-primary, rgba(140, 130, 255, 0.95))'
                        : '2px solid transparent',
                      paddingLeft: isOverridden ? 6 : 8,
                    }}
                  >
                    <span
                      style={{
                        textTransform: 'capitalize',
                        color: isOverridden
                          ? 'var(--lumiverse-primary, rgba(140, 130, 255, 0.95))'
                          : undefined,
                        fontWeight: isOverridden ? 600 : undefined,
                      }}
                    >
                      {field}
                    </span>
                    <select
                      style={{
                        marginLeft: 8,
                        flex: 1,
                        minWidth: 0,
                        padding: '3px 6px',
                        fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))',
                        background: 'var(--lumiverse-fill-hover)',
                        border: isOverridden
                          ? '1px solid var(--lumiverse-primary, rgba(140, 130, 255, 0.6))'
                          : '1px solid var(--lumiverse-border)',
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
              {personaAddons.length > 0 && (
                <>
                  <div className={styles.quickSetName}>Persona Add-Ons</div>
                  {personaAddons.map((addon) => (
                    <button
                      key={addon.id}
                      type="button"
                      className={clsx(styles.popRowBtn, addon.enabled && styles.popRowBtnActive)}
                      onClick={() => handleToggleAddon(addon.id)}
                    >
                      <span className={styles.personaMain}>
                        <IconPlaylistAdd size={13} style={{ opacity: addon.enabled ? 1 : 0.4, color: addon.enabled ? 'var(--lumiverse-primary)' : undefined }} />
                        <span>{addon.label || 'Untitled add-on'}</span>
                      </span>
                      <span className={styles.popMeta}>{addon.enabled ? 'ON' : 'OFF'}</span>
                    </button>
                  ))}
                </>
              )}
              {attachedGlobalAddons.length > 0 && (
                <>
                  {personaAddons.length > 0 && <div className={styles.popDivider} />}
                  <div className={styles.quickSetName}>Global Add-Ons</div>
                  {attachedGlobalAddons.map((addon) => (
                    <button
                      key={addon.id}
                      type="button"
                      className={clsx(styles.popRowBtn, addon.enabled && styles.popRowBtnActive)}
                      onClick={() => handleToggleGlobalAddon(addon.id)}
                    >
                      <span className={styles.personaMain}>
                        <Globe size={13} style={{ opacity: addon.enabled ? 1 : 0.4, color: addon.enabled ? 'var(--lumiverse-info, #42a5f5)' : undefined }} />
                        <span>{addon.label || 'Untitled global add-on'}</span>
                      </span>
                      <span className={styles.popMeta}>{addon.enabled ? 'ON' : 'OFF'}</span>
                    </button>
                  ))}
                </>
              )}
              {personaAddons.length === 0 && attachedGlobalAddons.length === 0 && (
                <div className={styles.popEmpty}>No add-ons configured.</div>
              )}
            </div>
          )}

          {renderPopover === 'databank' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.quickSetName}>Documents</div>
              {databankResults.length === 0 && <div className={styles.popEmpty}>No matching documents.</div>}
              {databankResults.map((r, i) => (
                <button
                  key={`${r.databankId}-${r.slug}`}
                  type="button"
                  className={clsx(styles.popRowBtn, i === databankActiveIdx && styles.popRowBtnActive)}
                  onMouseDown={(e) => { e.preventDefault(); handleHashSelect(r) }}
                  onMouseEnter={() => setDatabankActiveIdx(i)}
                >
                  <span className={styles.personaMain}>
                    <FileText size={13} style={{ opacity: 0.6 }} />
                    <span className={styles.personaNameGroup}>
                      <span>{r.name}</span>
                      <span className={styles.personaTitle}>{r.databankName}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}

          {renderPopover === 'groupMember' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.quickSetName}>Mention member</div>
              {atResults.length === 0 && <div className={styles.popEmpty}>No matching members.</div>}
              {atResults.map((r, i) => {
                const avatarUrl = getCharacterAvatarThumbUrlById(r.id, r.image_id)
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={clsx(styles.popRowBtn, i === atActiveIdx && styles.popRowBtnActive)}
                    style={r.muted ? { opacity: 0.55 } : undefined}
                    onMouseDown={(e) => { e.preventDefault(); handleAtSelect(r) }}
                    onMouseEnter={() => setAtActiveIdx(i)}
                    title={r.muted ? `${r.name} (muted — mention will override)` : r.name}
                  >
                    <span className={styles.personaMain}>
                      {avatarUrl ? (
                        <img
                          src={avatarUrl}
                          alt=""
                          loading="lazy"
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: '50%',
                            objectFit: 'cover',
                            flexShrink: 0,
                            background: 'var(--lumiverse-surface-muted, rgba(255,255,255,0.06))',
                          }}
                        />
                      ) : (
                        <span
                          aria-hidden="true"
                          style={{
                            width: 22,
                            height: 22,
                            borderRadius: '50%',
                            flexShrink: 0,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'var(--lumiverse-surface-muted, rgba(255,255,255,0.06))',
                            color: 'var(--lumiverse-text-dim, rgba(255,255,255,0.7))',
                            fontSize: 11,
                            fontWeight: 600,
                          }}
                        >
                          {r.name?.[0]?.toUpperCase() || '?'}
                        </span>
                      )}
                      <span className={styles.personaNameGroup}>
                        <span>{r.name}</span>
                        <span className={styles.personaTitle}>@{r.slug}{r.muted ? ' · muted' : ''}</span>
                      </span>
                    </span>
                  </button>
                )
              })}
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
        accept="image/*,audio/*,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.yaml,.yml,.log,.rst,.rtf"
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
          <div ref={mirrorRef} className={styles.textareaMirror} aria-hidden="true">
            {mirrorContent}
          </div>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={text}
            onChange={handleInput}
            onScroll={handleTextareaScroll}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
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
            onClick={handleSendClick}
            onTouchStart={handleSendTouchStart}
            onTouchEnd={handleSendTouchEnd}
            onTouchCancel={handleSendTouchEnd}
            title={
              text.trim() || pendingAttachments.length > 0
                ? `Send message (${queueModLabel}+click to queue)`
                : hasQueuedMessages
                  ? 'Send queued messages'
                  : 'Nudge for a fresh reply'
            }
            aria-label={
              text.trim() || pendingAttachments.length > 0
                ? 'Send message'
                : hasQueuedMessages
                  ? 'Send queued messages'
                  : 'Nudge for a fresh reply'
            }
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

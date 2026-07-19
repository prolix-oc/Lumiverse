import { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect, type CSSProperties, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { Send, RotateCw, CornerDownLeft, Square, FilePlus, Eye, UserCircle, Compass, MessageSquareQuote, Wrench, UsersRound, UserPlus, Settings2, Home, MoreHorizontal, FolderOpen, Paperclip, X, StickyNote, Crown, ScrollText, MessageSquare, BrainCircuit, Drama, Layers, FileText, Braces, Globe, Plus, Mic, Link2, LoaderCircle, Sliders, Search } from 'lucide-react'
import { IconPlaylistAdd } from '@tabler/icons-react'
import { useStore } from '@/store'
import { sendRoomAction } from '@/ws/relayClient'
import { messagesApi, chatsApi } from '@/api/chats'
import { presetsApi } from '@/api/presets'
import { charactersApi } from '@/api/characters'
import { generateApi } from '@/api/generate'
import { memoryCortexApi } from '@/api/memory-cortex'
import { expressionsApi } from '@/api/expressions'
import { personasApi } from '@/api/personas'
import { globalAddonsApi } from '@/api/global-addons'
import { imagesApi } from '@/api/images'
import { getPersonaAvatarThumbUrl, getPersonaAvatarThumbUrlById, getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import { uuidv7 } from '@/lib/uuid'
import { toast } from '@/lib/toast'
import { shouldForceLoomRuntimePreset } from '@/lib/loom/runtimeProfile'
import { unmarshalPreset } from '@/lib/loom/service'
import { presetSaveCoordinator, StalePresetHydrationError } from '@/lib/loom/preset-save-coordinator'
import { resolveAutoPersonaBinding } from '@/store/slices/personas'
import {
  CHAT_PERSONA_METADATA_KEY,
  getPersistedChatPersonaId,
  resolveChatPersonaSelection,
  setPersistedChatPersonaId,
} from '@/lib/chatPersonaSelection'
import { useDeviceFrameRadius } from '@/hooks/useDeviceFrameRadius'
import useIsMobile from '@/hooks/useIsMobile'
import type { MessageAttachment, PersonaAddon, GlobalAddon, AttachedGlobalAddon } from '@/types/api'
import type { LoomPreset, PromptVariableValues } from '@/lib/loom/types'
import AuthorsNotePanel from './AuthorsNotePanel'
import { PromptVariablesModal } from '@/components/shared/PromptVariablesModal'
import ProviderIcon from '@/components/shared/ProviderIcon'
import { databankApi } from '@/api/databank'
import { resolveMacros } from '@/api/macros'
import type { AutocompleteResult } from '@/api/databank'
import styles from './InputArea.module.css'
import clsx from 'clsx'
import InputBarExtensionActions from './InputBarExtensionActions'
import { didMobileQueueHoldReachThreshold, getMobileQueueHoldPreviewState } from './mobileQueueHold'
import { getMobileQueueHintKey, type MobileQueueHoldState } from './mobileQueueHint'
import { unlockNotificationAudio } from '@/lib/notificationAudio'
import { unlockTTSAudio } from '@/lib/ttsAudio'
import { orderGroupResponseIds, readGroupResponseOrder } from '@/lib/groupResponseOrder'
import {
  REGEX_ACTION_EVENT,
  applyRegexActionDraft,
  clearRegexSelectionForSource,
  claimLocalRegexAction,
  claimLocalRegexActions,
  consumeRegexSelections,
  consumeRegexActionDraft,
  getPendingRegexSelections,
  hasPendingRegexSelectionsForBlock,
  queueRegexSelection,
  queueRegexActionDraft,
  restoreRegexSelections,
  toggleRegexSelection,
  type PendingRegexSelection,
  type RegexActionActivation,
} from '@/lib/regex/actionBus'
import { createSTTEngine, getSupportedSTTAudioFormat, isWebSpeechAvailable, type STTAudioFrame, type STTEngine } from '@/lib/sttEngine'

interface InputAreaProps {
  chatId: string
  onNavigateHome?: () => void
  onOpenChatFind?: () => void
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
const TEXTAREA_MAX_HEIGHT = 180
const STT_VISUALIZER_BARS = 18
const MOBILE_QUEUE_HOLD_PROMPT_MS = 180
const MOBILE_QUEUE_HOLD_MS = 900
const LIVE_GENERATION_HEAD_STATUSES = new Set(['assembling', 'council', 'waiting', 'reasoning', 'streaming'])

function stackVisibleRegexSelections(base: string, selections: PendingRegexSelection[]): string {
  return [base.trim(), ...selections.filter((item) => item.type === 'send').map((item) => item.content.trim())]
    .filter(Boolean)
    .join('\n\n')
}

function serializeHiddenRegexSelections(selections: PendingRegexSelection[]) {
  return selections.filter((item) => item.type === 'append').map((item) => ({
    content: item.content,
    action_id: item.id,
    script_id: item.scriptId,
    instance_id: item.instanceId,
    source_message_id: item.messageId,
  }))
}
const STT_IDLE_BARS = Array.from({ length: STT_VISUALIZER_BARS }, (_, index) => {
  const centerBias = 1 - Math.abs(index - ((STT_VISUALIZER_BARS - 1) / 2)) / (STT_VISUALIZER_BARS / 2)
  return 0.12 + centerBias * 0.22
})

type STTCommandState = {
  thoughtDepth: number
}

const STT_COMMAND_ALIASES: Record<string, string[]> = {
  'quote': ['quote start', 'quote end', 'open quote', 'close quote'],
  'single quote': ['single quote', 'apostrophe'],
  'em dash': ['em dash'],
  'asterisk': ['asterisk'],
  'thought start': ['thought start', 'begin thought'],
  'thought end': ['thought end', 'end thought'],
}

function normalizeSTTCommandWord(word: string): string {
  if (word === 'quotes') return 'quote'
  if (word === 'starts') return 'start'
  if (word === 'ends') return 'end'
  if (word === 'thoughts') return 'thought'
  if (word === 'begins') return 'begin'
  if (word === 'dashes') return 'dash'
  if (word === 'apostrophes') return 'apostrophe'
  if (word === 'asterisks') return 'asterisk'
  return word
}

function sttCommandEditDistance(a: string, b: string): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > 1) return 2

  let edits = 0
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
      continue
    }
    edits += 1
    if (edits > 1) return edits
    if (a.length > b.length) i += 1
    else if (b.length > a.length) j += 1
    else {
      i += 1
      j += 1
    }
  }

  return edits + (i < a.length || j < b.length ? 1 : 0)
}

function normalizeSTTCommandCandidate(candidate: string): string | null {
  const normalized = candidate
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return null

  const candidateWords = normalized.split(' ').map(normalizeSTTCommandWord)
  for (const [canonical, aliases] of Object.entries(STT_COMMAND_ALIASES)) {
    for (const alias of aliases) {
      const aliasWords = alias.split(' ')
      if (candidateWords.length !== aliasWords.length) continue
      const isSimilar = candidateWords.every((word, index) => {
        const aliasWord = aliasWords[index]
        return word === aliasWord || (word.length >= 4 && aliasWord.length >= 4 && sttCommandEditDistance(word, aliasWord) <= 1)
      })
      if (isSimilar) return canonical
    }
  }

  return null
}

function normalizeSTTTranscript(raw: string, state: STTCommandState): string {
  if (!raw.trim()) return ''

  const commandPattern = /\b(?:quotes?\s+(?:starts?|ends?)|open\s+quotes?|close\s+quotes?|single\s+quotes?|apostrophes?|thoughts?\s+(?:starts?|ends?)|begins?\s+thoughts?|ends?\s+thoughts?|asterisks?|em\s+dashes?)\b(?:\s*[,.;:!?]+)?/gi

  return raw
    .replace(commandPattern, (match) => {
      const command = normalizeSTTCommandCandidate(match)
      if (!command) return match

      if (command === 'quote') return '"'
      if (command === 'single quote') return "'"
      if (command === 'em dash') return '—'
      if (command === 'asterisk') return '*'
      if (command === 'thought start') {
        const marker = state.thoughtDepth >= 1 ? '**' : '*'
        state.thoughtDepth += 1
        return marker
      }
      if (command === 'thought end') {
        const marker = state.thoughtDepth > 1 ? '**' : '*'
        state.thoughtDepth = Math.max(0, state.thoughtDepth - 1)
        return marker
      }

      return match
    })
    .replace(/(^|[\s([{"'])(\*{1,2})\s*[.,;:!?]+\s*/g, '$1$2')
    .replace(/(\*{1,2})\s+[.,;:!?]+(?=\s|$)/g, '$1')
    .replace(/([.!?])\s+([.!?])(?=\s|$|\*)/g, '$1')
    .replace(/([.!?])(\*{1,2})\.(?=\s|$)/g, '$1$2')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+([”’])/g, '$1')
    .replace(/([“‘])\s+/g, '$1')
    .replace(/\s*—\s*/g, ' — ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function stripSTTSendCommand(raw: string): { text: string; shouldSend: boolean } {
  const match = raw.match(/^(.*?)(?:[\s,.;:!?-]*)send\s+message\s*$/i)
  if (!match) return { text: raw.trim(), shouldSend: false }
  return { text: (match[1] || '').trim(), shouldSend: true }
}

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

export default function InputArea({ chatId, onNavigateHome, onOpenChatFind }: InputAreaProps) {
  const { t } = useTranslation('chat')
  const { t: te } = useTranslation('errors')
  const queueModLabel = isMac ? t('input.modCmd') : t('input.modCtrl')
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [pendingRegexVisibleCount, setPendingRegexVisibleCount] = useState(0)
  const [lastImpersonateInput, setLastImpersonateInput] = useState<string>('')
  const [dryRunning, setDryRunning] = useState(false)
  const [resolvingMacros, setResolvingMacros] = useState(false)
  const [authorsNoteOpen, setAuthorsNoteOpen] = useState(false)
  const [openPopover, setOpenPopover] = useState<null | 'guides' | 'quick' | 'persona' | 'tools' | 'extras' | 'altFields' | 'addons' | 'databank' | 'groupMember' | 'connections'>(null)
  const openPopoverRef = useRef(openPopover)
  useEffect(() => {
    openPopoverRef.current = openPopover
  }, [openPopover])
  const [renderPopover, setRenderPopover] = useState<null | 'guides' | 'quick' | 'persona' | 'tools' | 'extras' | 'altFields' | 'addons' | 'databank' | 'groupMember' | 'connections'>(null)
  const [popoverClosing, setPopoverClosing] = useState(false)
  const [personaSearch, setPersonaSearch] = useState('')
  const [personaList, setPersonaList] = useState<Array<{
    id: string
    name: string
    title: string
    description: string
    folder: string
    avatar_path: string | null
    image_id: string | null
    metadata?: Record<string, any>
  }>>([])
  const [characterName, setCharacterName] = useState('')
  const [impersonationPresetId, setImpersonationPresetId] = useState<string | null>(null)
  const [promptVariablesModalOpen, setPromptVariablesModalOpen] = useState(false)
  const [promptVariablesPreset, setPromptVariablesPreset] = useState<LoomPreset | null>(null)
  const [promptVariablesLoading, setPromptVariablesLoading] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<(MessageAttachment & { previewUrl?: string })[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const dragCounterRef = useRef(0)
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
  const [atResults, setAtResults] = useState<Array<{ id: string; name: string; slug: string; muted: boolean; image_id: string | null; extensions?: Record<string, any> }>>([])
  const [atActiveIdx, setAtActiveIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const pendingSelectionRef = useRef<{ start: number; end: number; direction?: 'forward' | 'backward' | 'none' } | null>(null)
  const pendingSTTActionRef = useRef<'queue' | 'send' | null>(null)
  const sendingRef = useRef(false)
  const regexActionHandlingRef = useRef(false)
  const generationNonceRef = useRef(0)
  const touchHoldPromptTimerRef = useRef<number>(0)
  const touchQueueArmTimerRef = useRef<number>(0)
  const touchHoldStartedAtRef = useRef(0)
  const ignoreFollowupClickUntilRef = useRef(0)
  const ignoreFollowupClickCountRef = useRef(0)
  const mobileQueueHoldStateRef = useRef<MobileQueueHoldState>('idle')
  const isStreaming = useStore((s) => s.isStreaming)
  const editingMessageId = useStore((s) => s.editingMessageId)
  const isMobile = useIsMobile()
  const hideForMobileEdit = isMobile && !!editingMessageId
  const supportsTouchQueueHold = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  const activeChatId = useStore((s) => s.activeChatId)
  const activeGenerationId = useStore((s) => s.activeGenerationId)
  const liveChatGenerationId = useStore((s) =>
    s.chatHeads.find((head) =>
      head.chatId === chatId &&
      !head.generationId.startsWith('mp-room:') &&
      LIVE_GENERATION_HEAD_STATUSES.has(head.status)
    )?.generationId ?? null
  )
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const enterToSend = useStore((s) => s.chatSheldEnterToSend)
  const saveDraftInput = useStore((s) => s.saveDraftInput)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const setActiveProfile = useStore((s) => s.setActiveProfile)
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || null
  const voiceSettings = useStore((s) => s.voiceSettings)
  // Temporary chats are persona-less: messages send as plain "User" and no
  // persona_id is attached to message extras or generation requests.
  const isTemporaryChat = useStore((s) => s.activeChatMetadata?.temporary === true)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const setActivePersona = useStore((s) => s.setActivePersona)
  const getActivePresetForGeneration = useStore((s) => s.getActivePresetForGeneration)
  const activeLoomPresetId = useStore((s) => s.activeLoomPresetId)
  const loomRegistry = useStore((s) => s.loomRegistry)
  const regenFeedback = useStore((s) => s.regenFeedback)
  const retainCouncilForRegens = useStore((s) => s.councilSettings.toolsSettings.retainResultsForRegens)
  const guidedGenerations = useStore((s) => s.guidedGenerations)
  const quickReplySets = useStore((s) => s.quickReplySets)
  const personas = useStore((s) => s.personas)
  const recentPersonaIds = useStore((s) => s.recentPersonaIds)
  const characterPersonaBindings = useStore((s) => s.characterPersonaBindings)
  const personaTagBindings = useStore((s) => s.personaTagBindings)
  const messages = useStore((s) => s.messages)
  const addMessage = useStore((s) => s.addMessage)
  const updateMessage = useStore((s) => s.updateMessage)
  const beginStreaming = useStore((s) => s.beginStreaming)
  const startStreaming = useStore((s) => s.startStreaming)
  const stopStreaming = useStore((s) => s.stopStreaming)
  const setStreamingError = useStore((s) => s.setStreamingError)
  const mpRoomId = useStore((s) => s.mpRoomId)
  const mpIsHost = useStore((s) => s.mpIsHost)
  // A non-host room peer can't stop the host's generation (it isn't theirs) —
  // used to suppress the stop control so they can't trigger a no-op/stuck state.
  const isRoomPeer = !!mpRoomId && !mpIsHost
  const openModal = useStore((s) => s.openModal)
  const setSetting = useStore((s) => s.setSetting)

  const isGroupChat = useStore((s) => s.isGroupChat)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const mutedCharacterIds = useStore((s) => s.mutedCharacterIds)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  const setActiveChatMetadata = useStore((s) => s.setActiveChatMetadata)
  const characters = useStore((s) => s.characters)
  const setMentionQueue = useStore((s) => s.setMentionQueue)
  const expressionDisplay = useStore((s) => s.expressionDisplay)
  const setExpressionDisplay = useStore((s) => s.setExpressionDisplay)
  const impersonateDraftContent = useStore((s) => s.impersonateDraftContent)
  const setImpersonateDraftContent = useStore((s) => s.setImpersonateDraftContent)
  const streamingContent = useStore((s) => s.streamingContent)
  const streamingGenerationType = useStore((s) => s.streamingGenerationType)
  const localGenerationInChat = isStreaming && activeChatId === chatId
  const isGeneratingInChat = !!liveChatGenerationId || localGenerationInChat
  const generationIdForChat = liveChatGenerationId || (localGenerationInChat ? activeGenerationId : null)
  const groupResponseOrder = useMemo(
    () => readGroupResponseOrder(activeChatMetadata),
    [activeChatMetadata],
  )
  const focusedPreviewCharacterId = useMemo(() => {
    if (!isGroupChat) return activeCharacterId ?? null
    if (activeGroupCharacterId) return activeGroupCharacterId
    const firstUnmuted = orderGroupResponseIds(
      groupCharacterIds.filter((id) => !mutedCharacterIds.includes(id)),
      groupResponseOrder,
    )[0]
    return firstUnmuted ?? activeCharacterId ?? null
  }, [
    activeCharacterId,
    activeGroupCharacterId,
    groupCharacterIds,
    groupResponseOrder,
    isGroupChat,
    mutedCharacterIds,
  ])

  // Track whether the active character has expressions configured
  const [hasExpressions, setHasExpressions] = useState(false)
  useEffect(() => {
    if (!activeCharacterId) { setHasExpressions(false); return }
    expressionsApi.get(activeCharacterId)
      .then((cfg) => setHasExpressions(!!cfg?.enabled && Object.keys(cfg.mappings || {}).length > 0))
      .catch(() => setHasExpressions(false))
  }, [activeCharacterId])

  // Track alternate fields for the active character or group members.
  type AltFieldVariant = { id: string; label: string; content: string }
  const ALT_FIELD_NAMES = ['description', 'personality', 'scenario'] as const
  const [altFieldsData, setAltFieldsData] = useState<Record<string, AltFieldVariant[]>>({})
  const [groupAltFieldsData, setGroupAltFieldsData] = useState<Record<string, Record<string, AltFieldVariant[]>>>({})
  const [altFieldsLoaded, setAltFieldsLoaded] = useState(false)
  const [groupAltFieldsLoadedIds, setGroupAltFieldsLoadedIds] = useState<string[]>([])
  const [altFieldSelections, setAltFieldSelections] = useState<Record<string, string>>({})
  const [groupAltFieldSelections, setGroupAltFieldSelections] = useState<Record<string, Record<string, string>>>({})
  const [groupScenarioMode, setGroupScenarioMode] = useState<'individual' | 'member' | 'custom'>('individual')
  const hasSingleAltFields = Object.values(altFieldsData).some((arr) => arr.length > 0)
  const groupMembersWithAltFields = useMemo(() => {
    if (!isGroupChat) return []
    return groupCharacterIds
      .map((id) => {
        const char = characters.find((c) => c.id === id)
        const altFields = groupAltFieldsData[id]
        const hasAlternates = altFields && Object.values(altFields).some((arr) => Array.isArray(arr) && arr.length > 0)
        return char && hasAlternates ? { char, altFields } : null
      })
      .filter(Boolean) as Array<{ char: typeof characters[number]; altFields: Record<string, AltFieldVariant[]> }>
  }, [isGroupChat, groupCharacterIds, characters, groupAltFieldsData])
  const hasAltFields = isGroupChat ? groupMembersWithAltFields.length > 0 : hasSingleAltFields
  const activeAltSelectionCount = isGroupChat
    ? Object.values(groupAltFieldSelections).reduce((total, selections) => total + Object.keys(selections || {}).length, 0)
    : Object.keys(altFieldSelections).length
  const groupCharacterKey = useMemo(() => groupCharacterIds.join('\0'), [groupCharacterIds])
  const groupAltFieldsKey = useMemo(() => {
    if (!isGroupChat) return ''
    return groupCharacterIds.map((id) => {
      const altFields = characters.find((c) => c.id === id)?.extensions?.alternate_fields
      return `${id}:${altFields ? JSON.stringify(altFields) : ''}`
    }).join('\0')
  }, [characters, groupCharacterIds, isGroupChat])

  useEffect(() => {
    if (isGroupChat) {
      setAltFieldsData({})
      setAltFieldsLoaded(false)
      if (groupCharacterIds.length === 0) { setGroupAltFieldsData({}); setGroupAltFieldsLoadedIds([]); return }
      let cancelled = false
      const characterSnapshot = useStore.getState().characters
      Promise.all(groupCharacterIds.map(async (id) => {
        const cached = characterSnapshot.find((c) => c.id === id)
        if (cached?.extensions?.alternate_fields) {
          return { id, loaded: true, altFields: cached.extensions.alternate_fields as Record<string, AltFieldVariant[]> }
        }
        if (cached) {
          return { id, loaded: true, altFields: undefined }
        }
        const fetched = await charactersApi.get(id).catch(() => null)
        if (fetched) useStore.getState().updateCharacter(fetched.id, fetched)
        return {
          id,
          loaded: !!fetched,
          altFields: fetched?.extensions?.alternate_fields as Record<string, AltFieldVariant[]> | undefined,
        }
      }))
        .then((items) => {
          if (cancelled) return
          const next: Record<string, Record<string, AltFieldVariant[]>> = {}
          for (const item of items) {
            if (item.altFields && typeof item.altFields === 'object') next[item.id] = item.altFields
          }
          setGroupAltFieldsData(next)
          setGroupAltFieldsLoadedIds(items.filter((item) => item.loaded).map((item) => item.id))
        })
        .catch(() => { if (!cancelled) { setGroupAltFieldsData({}); setGroupAltFieldsLoadedIds([]) } })
      return () => { cancelled = true }
    }

    setGroupAltFieldsData({})
    setGroupAltFieldsLoadedIds([])
    setAltFieldsLoaded(false)
    if (!activeCharacterId) { setAltFieldsData({}); return }
    charactersApi.get(activeCharacterId)
      .then((c) => {
        const af = c.extensions?.alternate_fields as Record<string, AltFieldVariant[]> | undefined
        setAltFieldsData(af && typeof af === 'object' ? af : {})
        setAltFieldsLoaded(true)
      })
      .catch(() => { setAltFieldsData({}); setAltFieldsLoaded(false) })
  }, [activeCharacterId, isGroupChat, groupCharacterIds, groupCharacterKey, groupAltFieldsKey])

  const pruneAltSelections = useCallback((
    selections: Record<string, string>,
    altFields: Record<string, AltFieldVariant[]> | undefined,
  ) => {
    let changed = false
    const next: Record<string, string> = {}

    for (const [field, variantId] of Object.entries(selections)) {
      const variants = altFields?.[field]
      if (Array.isArray(variants) && variants.some((variant) => variant.id === variantId)) {
        next[field] = variantId
      } else {
        changed = true
      }
    }

    return changed ? next : selections
  }, [])

  useEffect(() => {
    if (!chatId) return

    if (isGroupChat) {
      if (groupAltFieldsLoadedIds.length === 0 || Object.keys(groupAltFieldSelections).length === 0) return
      const loadedIds = new Set(groupAltFieldsLoadedIds)
      let changed = false
      const next: Record<string, Record<string, string>> = {}

      for (const [characterId, selections] of Object.entries(groupAltFieldSelections)) {
        if (!loadedIds.has(characterId)) {
          next[characterId] = selections
          continue
        }

        const pruned = pruneAltSelections(selections, groupAltFieldsData[characterId])
        if (pruned !== selections) changed = true
        if (Object.keys(pruned).length > 0) next[characterId] = pruned
      }

      if (!changed) return
      setGroupAltFieldSelections(next)
      chatsApi.patchMetadata(chatId, {
        group_alternate_field_selections: Object.keys(next).length > 0 ? next : null,
      }).catch((err) => console.error('[AltFields] Failed to clear stale group selections:', err))
      return
    }

    if (!altFieldsLoaded || Object.keys(altFieldSelections).length === 0) return
    const next = pruneAltSelections(altFieldSelections, altFieldsData)
    if (next === altFieldSelections) return
    setAltFieldSelections(next)
    chatsApi.patchMetadata(chatId, {
      alternate_field_selections: Object.keys(next).length > 0 ? next : null,
    }).catch((err) => console.error('[AltFields] Failed to clear stale selections:', err))
  }, [
    altFieldSelections,
    altFieldsData,
    altFieldsLoaded,
    chatId,
    groupAltFieldSelections,
    groupAltFieldsData,
    groupAltFieldsLoadedIds,
    isGroupChat,
    pruneAltSelections,
  ])

  // Load per-chat alternate field selections
  useEffect(() => {
    if (!chatId) {
      setAltFieldSelections({})
      setGroupAltFieldSelections({})
      setGroupScenarioMode('individual')
      return
    }
    chatsApi.get(chatId, { messages: false })
      .then((chat) => {
        setAltFieldSelections((chat.metadata?.alternate_field_selections as Record<string, string>) || {})
        setGroupAltFieldSelections((chat.metadata?.group_alternate_field_selections as Record<string, Record<string, string>>) || {})
        const mode = chat.metadata?.group_scenario_override?.mode
        setGroupScenarioMode(mode === 'member' || mode === 'custom' ? mode : 'individual')
      })
      .catch(() => {
        setAltFieldSelections({})
        setGroupAltFieldSelections({})
        setGroupScenarioMode('individual')
      })
  }, [chatId])

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

  const handleGroupAltFieldSelect = useCallback(async (characterId: string, field: string, variantId: string | null) => {
    const memberSelections = { ...(groupAltFieldSelections[characterId] || {}) }
    if (variantId) memberSelections[field] = variantId
    else delete memberSelections[field]

    const newSelections = { ...groupAltFieldSelections }
    if (Object.keys(memberSelections).length > 0) newSelections[characterId] = memberSelections
    else delete newSelections[characterId]
    setGroupAltFieldSelections(newSelections)

    try {
      await chatsApi.setGroupMemberAlternateFields(chatId, characterId, memberSelections)
    } catch (err) {
      console.error('[AltFields] Failed to save group member selection:', err)
    }
  }, [chatId, groupAltFieldSelections])

  // Track persona add-ons for the active persona
  const [personaAddons, setPersonaAddons] = useState<PersonaAddon[]>([])
  // Track global add-ons attached to the active persona
  const [attachedGlobalAddons, setAttachedGlobalAddons] = useState<(GlobalAddon & { enabled: boolean })[]>([])
  const [chatAddonStatesByPersona, setChatAddonStatesByPersona] = useState<Record<string, Record<string, boolean>>>({})
  const [showCreateAddon, setShowCreateAddon] = useState(false)
  const [newAddonLabel, setNewAddonLabel] = useState('')
  const [newAddonContent, setNewAddonContent] = useState('')
  const [creatingAddon, setCreatingAddon] = useState(false)
  const hasAddons = personaAddons.length > 0 || attachedGlobalAddons.length > 0

  useEffect(() => {
    if (!chatId) { setChatAddonStatesByPersona({}); return }
    chatsApi.get(chatId, { messages: false })
      .then((chat) => {
        const states = chat.metadata?.persona_addon_states
        setChatAddonStatesByPersona(states && typeof states === 'object' ? states : {})
      })
      .catch(() => setChatAddonStatesByPersona({}))
  }, [chatId])

  // Keep quick-toggle state coherent when another tab (or a websocket chat
  // update) changes the active chat's add-ons and avatar version.
  useEffect(() => {
    const states = activeChatMetadata?.persona_addon_states
    if (states && typeof states === 'object') setChatAddonStatesByPersona(states)
  }, [activeChatMetadata?.persona_addon_states])

  const activeCharacter = activeCharacterId ? characters.find((c) => c.id === activeCharacterId) : null
  const resolvedPersonaBinding = useMemo(() => resolveAutoPersonaBinding({
    characterId: activeCharacterId,
    characterTags: activeCharacter?.tags ?? [],
    personas,
    characterPersonaBindings,
    personaTagBindings,
  }), [activeCharacterId, activeCharacter?.tags, personas, characterPersonaBindings, personaTagBindings])
  const persistedChatPersonaId = useMemo(
    () => getPersistedChatPersonaId(activeChatMetadata),
    [activeChatMetadata],
  )

  const personaPickerGroups = useMemo(() => {
    const query = personaSearch.trim().toLocaleLowerCase()
    const matching = query
      ? personaList.filter((persona) => [persona.name, persona.title, persona.description, persona.folder]
          .some((value) => value.toLocaleLowerCase().includes(query)))
      : personaList
    const matchingById = new Map(matching.map((persona) => [persona.id, persona]))
    const recent = recentPersonaIds
      .map((id) => matchingById.get(id))
      .filter((persona): persona is (typeof personaList)[number] => !!persona)
    const recentIds = new Set(recent.map((persona) => persona.id))
    const folders = new Map<string, typeof personaList>()

    for (const persona of matching) {
      if (recentIds.has(persona.id)) continue
      const folder = persona.folder.trim()
      const items = folders.get(folder) ?? []
      items.push(persona)
      folders.set(folder, items)
    }

    const groups: Array<{
      key: string
      folder: string
      recent: boolean
      personas: typeof personaList
    }> = []
    if (recent.length > 0) groups.push({ key: '__recent', folder: '', recent: true, personas: recent })
    for (const [folder, items] of [...folders.entries()].sort(([a], [b]) => {
      if (!a) return 1
      if (!b) return -1
      return a.localeCompare(b)
    })) {
      groups.push({
        key: folder || '__uncategorized',
        folder,
        recent: false,
        personas: items.sort((a, b) => a.name.localeCompare(b.name)),
      })
    }
    return groups
  }, [personaList, personaSearch, recentPersonaIds])

  const persistChatPersonaSelection = useCallback(async (personaId: string | null) => {
    if (!chatId || isTemporaryChat) return false

    const previousMetadata = activeChatMetadata
    const previousActivePersonaId = activePersonaId
    const nextMetadata = setPersistedChatPersonaId(previousMetadata, personaId)
    const fallbackPersonaId = personaId ?? resolveChatPersonaSelection({
      metadata: nextMetadata,
      characterId: activeCharacterId,
      characterTags: activeCharacter?.tags ?? [],
      personas,
      characterPersonaBindings,
      personaTagBindings,
    }).personaId

    setActiveChatMetadata(nextMetadata)
    setActivePersona(fallbackPersonaId)

    try {
      await chatsApi.patchMetadata(chatId, { [CHAT_PERSONA_METADATA_KEY]: personaId })
      return true
    } catch (err) {
      console.error('[InputArea] Failed to save chat persona selection:', err)
      setActiveChatMetadata(previousMetadata)
      setActivePersona(previousActivePersonaId)
      toast.error(t('toast.failedSaveChatPersona'))
      return false
    }
  }, [
    chatId,
    isTemporaryChat,
    activeChatMetadata,
    activePersonaId,
    activeCharacterId,
    activeCharacter?.tags,
    personas,
    characterPersonaBindings,
    personaTagBindings,
    setActiveChatMetadata,
    setActivePersona,
    t,
  ])

  const currentChatAddonOverrides = useMemo(
    () => activePersonaId ? (chatAddonStatesByPersona[activePersonaId] ?? {}) : {},
    [activePersonaId, chatAddonStatesByPersona],
  )
  const basePersonaAddonStates = useMemo(() => {
    const states: Record<string, boolean> = {}
    for (const addon of personaAddons) states[addon.id] = addon.enabled
    for (const addon of attachedGlobalAddons) states[addon.id] = addon.enabled
    if (activePersonaId && resolvedPersonaBinding.personaId === activePersonaId && resolvedPersonaBinding.addonStates) {
      Object.assign(states, resolvedPersonaBinding.addonStates)
    }
    return states
  }, [activePersonaId, personaAddons, attachedGlobalAddons, resolvedPersonaBinding])
  const effectivePersonaAddonStates = useMemo(
    () => ({ ...basePersonaAddonStates, ...currentChatAddonOverrides }),
    [basePersonaAddonStates, currentChatAddonOverrides],
  )
  const effectivePersonaAddons = useMemo(
    () => personaAddons.map((addon) => ({ ...addon, enabled: effectivePersonaAddonStates[addon.id] ?? addon.enabled })),
    [personaAddons, effectivePersonaAddonStates],
  )
  const effectiveAttachedGlobalAddons = useMemo(
    () => attachedGlobalAddons.map((addon) => ({ ...addon, enabled: effectivePersonaAddonStates[addon.id] ?? addon.enabled })),
    [attachedGlobalAddons, effectivePersonaAddonStates],
  )
  const chatAddonOverrideCount = Object.entries(currentChatAddonOverrides)
    .filter(([id, enabled]) => id in basePersonaAddonStates && enabled !== basePersonaAddonStates[id])
    .length
  const activeGenerationAddonStates = activePersonaId && Object.keys(effectivePersonaAddonStates).length > 0
    ? effectivePersonaAddonStates
    : undefined

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
            const refMap = new Map(refs.map(r => [r.id, r]))
            const resolved = globalRes.data
              .filter(g => refMap.has(g.id))
              .map(g => ({ ...g, ...refMap.get(g.id)! }))
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
        const refMap = new Map(refs.map(r => [r.id, r]))
        return prev
          .filter(g => refMap.has(g.id))
          .map(g => ({ ...g, ...refMap.get(g.id)! }))
      })
    }
  }, [storePersonas, activePersonaId])

  // Mirror the server-returned metadata into the shared chat state. The
  // dedicated toggle endpoint records both boolean state and recency/version,
  // which keeps avatar override selection and image cache-busting in sync.
  const syncChatAddonMetadata = useCallback((metadata: Record<string, any>) => {
    const store = useStore.getState()
    if (store.activeChatId !== chatId) return
    store.setActiveChatMetadata(metadata)
  }, [chatId])

  const persistChatAddonOverride = useCallback(async (addonId: string, enabled: boolean) => {
    if (!activePersonaId) return false
    const previous = chatAddonStatesByPersona
    const nextByPersona = {
      ...chatAddonStatesByPersona,
      [activePersonaId]: {
        ...(chatAddonStatesByPersona[activePersonaId] ?? {}),
        [addonId]: enabled,
      },
    }
    setChatAddonStatesByPersona(nextByPersona)
    try {
      const updated = await chatsApi.setPersonaAddonState(chatId, activePersonaId, addonId, enabled)
      const serverStates = updated.metadata?.persona_addon_states
      if (serverStates && typeof serverStates === 'object') {
        setChatAddonStatesByPersona(serverStates)
      }
      syncChatAddonMetadata(updated.metadata ?? {})
      return true
    } catch {
      setChatAddonStatesByPersona(previous)
      toast.error(t('toast.failedSaveAddonState'))
      return false
    }
  }, [activePersonaId, chatId, chatAddonStatesByPersona, syncChatAddonMetadata, t])

  const handleToggleAddonState = useCallback((addonId: string) => {
    void persistChatAddonOverride(addonId, !(effectivePersonaAddonStates[addonId] ?? false))
  }, [effectivePersonaAddonStates, persistChatAddonOverride])

  const handleCreateChatAddon = useCallback(async () => {
    if (!activePersonaId || creatingAddon) return
    const label = newAddonLabel.trim()
    const content = newAddonContent.trim()
    if (!label && !content) return

    setCreatingAddon(true)
    try {
      const p = await personasApi.get(activePersonaId)
      const existing = Array.isArray(p.metadata?.addons) ? p.metadata.addons : []
      const addon: PersonaAddon = {
        id: uuidv7(),
        label: label || t('quickMenu.untitledAddon'),
        content,
        enabled: false,
        sort_order: existing.length,
      }
      const updated = await personasApi.update(activePersonaId, {
        metadata: { ...(p.metadata || {}), addons: [...existing, addon] },
      })
      useStore.getState().updatePersona(activePersonaId, updated)
      setPersonaAddons(Array.isArray(updated.metadata?.addons) ? updated.metadata.addons : [])
      const overrideSaved = await persistChatAddonOverride(addon.id, true)
      setNewAddonLabel('')
      setNewAddonContent('')
      setShowCreateAddon(false)
      toast.success(overrideSaved ? t('toast.addonCreated') : t('toast.addonCreatedNotEnabled'))
    } catch {
      toast.error(t('toast.failedCreateAddon'))
    } finally {
      setCreatingAddon(false)
    }
  }, [activePersonaId, creatingAddon, newAddonLabel, newAddonContent, persistChatAddonOverride, t])

  // iPhone-specific: match input bar bottom corners to device screen curvature
  const screenCornerRadius = useDeviceFrameRadius()
  const [inputFocused, setInputFocused] = useState(false)
  const [sttStatus, setSttStatus] = useState<'idle' | 'starting' | 'listening' | 'processing'>('idle')
  const [sttAudioFrame, setSttAudioFrame] = useState<STTAudioFrame | null>(null)
  const sttEngineRef = useRef<STTEngine | null>(null)
  const sttDraftBaseRef = useRef('')
  const sttInterimTextRef = useRef('')
  const sttFinalSegmentsRef = useRef<string[]>([])
  const sttNormalizedFinalSegmentsRef = useRef<string[]>([])
  const sttCommandStateRef = useRef<STTCommandState>({ thoughtDepth: 0 })
  const sttShouldSendRef = useRef(false)

  const isSTTSupported = useMemo(() => {
    if (voiceSettings.sttProvider === 'webspeech') return isWebSpeechAvailable()
    return getSupportedSTTAudioFormat() != null && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  }, [voiceSettings.sttProvider])
  const isListeningToSTT = sttStatus === 'starting' || sttStatus === 'listening' || sttStatus === 'processing'
  const showSTTIndicator = isListeningToSTT
  const sttIndicatorLabel = useMemo(() => {
    if (sttStatus === 'starting') return voiceSettings.sttProvider === 'webspeech' ? t('input.sttStartingMic') : t('input.sttPreparingRecording')
    if (sttStatus === 'processing') return voiceSettings.sttProvider === 'webspeech' ? t('input.sttFinalizingTranscript') : t('input.sttTranscribingAudio')
    if (sttStatus === 'listening') return voiceSettings.sttProvider === 'webspeech' ? t('input.sttListening') : t('input.sttRecording')
    return ''
  }, [sttStatus, voiceSettings.sttProvider, t])
  const sttVisualizerBars = sttAudioFrame?.frequencies?.length ? sttAudioFrame.frequencies : STT_IDLE_BARS
  const sttVisualizerLevel = sttAudioFrame ? Math.max(sttAudioFrame.amplitude, sttAudioFrame.peak * 0.65) : 0.16

  const stopSTTSession = useCallback((mode: 'stop' | 'destroy' = 'stop') => {
    const engine = sttEngineRef.current
    if (!engine) return
    setSttAudioFrame(null)
    if (mode === 'destroy') engine.destroy()
    else engine.stop()
    if (mode === 'destroy') sttEngineRef.current = null
  }, [])

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

  const applySTTTranscript = useCallback((transcript: string, moveCaret = false) => {
    const base = sttDraftBaseRef.current
    const normalized = transcript.trim()
    const nextText = normalized
      ? (base ? `${base.replace(/\s+$/, '')} ${normalized}` : normalized)
      : base

    setText(nextText)
    if (moveCaret) queueTextareaSelection(nextText.length)
  }, [queueTextareaSelection])


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

  useEffect(() => () => {
    sttEngineRef.current?.destroy()
    sttEngineRef.current = null
  }, [])

  // ── Draft input persistence ──────────────────────────────────────────
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const DRAFT_KEY_PREFIX = 'lumiverse:chatDraft:'

  // Restore draft on mount or chat switch
  useEffect(() => {
    setLastImpersonateInput('')
    setPendingRegexVisibleCount(getPendingRegexSelections(chatId).filter((item) => item.type === 'send').length)
    const queuedDraft = consumeRegexActionDraft(chatId)
    if (queuedDraft) {
      let saved = ''
      if (saveDraftInput) {
        try { saved = localStorage.getItem(DRAFT_KEY_PREFIX + chatId) || '' } catch {}
      }
      setText(applyRegexActionDraft(saved, queuedDraft))
      requestAnimationFrame(() => resizeTextarea(textareaRef.current))
      return
    }
    if (!saveDraftInput) return
    try {
      const saved = localStorage.getItem(DRAFT_KEY_PREFIX + chatId)
      if (saved) {
        setText(saved)
      }
    } catch {}
  }, [chatId, saveDraftInput, resizeTextarea])

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
  const activeLoomPresetName = activeLoomPresetId ? loomRegistry[activeLoomPresetId]?.name ?? null : null

  const openPromptVariablesModal = useCallback(async () => {
    if (!activeLoomPresetId) {
      toast.info(t('toast.noPresetForPromptVariables'))
      return
    }
    if (promptVariablesLoading) return
    setOpenPopover(null)
    setPromptVariablesLoading(true)
    const presetId = activeLoomPresetId
    const hydration = presetSaveCoordinator.beginHydration(presetId, 'prompt-variables')
    try {
      const preset = await presetsApi.get(presetId)
      if (useStore.getState().activeLoomPresetId !== presetId) {
        presetSaveCoordinator.cancelHydration(hydration)
        return
      }
      setPromptVariablesPreset(presetSaveCoordinator.hydrate(unmarshalPreset(preset), hydration))
      setPromptVariablesModalOpen(true)
    } catch (err) {
      presetSaveCoordinator.cancelHydration(hydration)
      if (err instanceof StalePresetHydrationError) return
      console.error('[InputArea] Failed to load prompt variables preset:', err)
      toast.error(t('toast.failedLoadPromptVariables'))
    } finally {
      setPromptVariablesLoading(false)
    }
  }, [activeLoomPresetId, promptVariablesLoading, t])

  const savePromptVariableValues = useCallback(async (values: PromptVariableValues) => {
    if (!promptVariablesPreset || useStore.getState().activeLoomPresetId !== promptVariablesPreset.id) {
      setPromptVariablesModalOpen(false)
      setPromptVariablesPreset(null)
      return
    }
    const updated = presetSaveCoordinator.mutate(
      promptVariablesPreset.id,
      promptVariablesPreset,
      (preset) => ({ ...preset, promptVariables: values }),
      { immediate: true },
    )
    try {
      const saved = await presetSaveCoordinator.flush(updated.id)
      setPromptVariablesPreset(saved ?? updated)
    } catch (err) {
      console.warn('[InputArea] Failed to save prompt variable values:', err)
      toast.error(t('toast.failedSavePromptVariables'))
      throw err
    }
  }, [promptVariablesPreset, t])

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

  useEffect(() => {
    if (!promptVariablesPreset) return
    if (promptVariablesPreset.id === activeLoomPresetId) return
    setPromptVariablesModalOpen(false)
    setPromptVariablesPreset(null)
  }, [activeLoomPresetId, promptVariablesPreset])

  // Databank # autocomplete — search when hash query changes
  useEffect(() => {
    if (databankDebounceRef.current) clearTimeout(databankDebounceRef.current)
      if (hashQuery === null || hashQuery.length === 0) {
      if (openPopoverRef.current === 'databank') setOpenPopover(null)
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
        } else if (openPopoverRef.current === 'databank') {
          setOpenPopover(null)
        }
      } catch {
        setDatabankResults([])
      }
    }, 200)
    return () => { if (databankDebounceRef.current) clearTimeout(databankDebounceRef.current) }
  }, [hashQuery, chatId, activeCharacterId])

  // @ autocomplete — filter locally against group members. Muted members are
  // kept in the list (dimmed in UI); selecting them overrides mute for this turn.
  useEffect(() => {
    if (!isGroupChat || atQuery === null) {
      if (openPopoverRef.current === 'groupMember') setOpenPopover(null)
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
          extensions: (c as any).extensions ?? undefined,
        }
      })
      .filter(Boolean) as Array<{ id: string; name: string; slug: string; muted: boolean; image_id: string | null; extensions?: Record<string, any> }>
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
    } else if (openPopoverRef.current === 'groupMember') {
      setOpenPopover(null)
    }
  }, [atQuery, isGroupChat, groupCharacterIds, mutedCharacterIds, characters])

  // While hidden for mobile edit, the RO below cannot observe a display:none
  // element, so --lcs-input-safe-zone would freeze at the pre-edit (potentially
  // tall) value and leave a void under the message list. Override directly.
  useLayoutEffect(() => {
    if (!hideForMobileEdit) return
    const parent = containerRef.current?.parentElement
    if (!parent) return
    const root = document.documentElement
    let syncRaf = 0

    const syncHiddenEditSafeZone = () => {
      const rootStyle = getComputedStyle(root)
      const keyboardInset = parseFloat(rootStyle.getPropertyValue('--app-keyboard-inset-bottom')) || 0
      parent.style.setProperty('--lcs-input-safe-zone', `${Math.max(16, Math.round(16 + keyboardInset))}px`)
    }

    const scheduleHiddenEditSafeZoneSync = () => {
      if (syncRaf) cancelAnimationFrame(syncRaf)
      syncRaf = requestAnimationFrame(() => {
        syncRaf = 0
        syncHiddenEditSafeZone()
      })
    }

    const rootObserver = new MutationObserver(scheduleHiddenEditSafeZoneSync)
    rootObserver.observe(root, { attributes: true, attributeFilter: ['style'] })

    syncHiddenEditSafeZone()
    window.addEventListener('resize', scheduleHiddenEditSafeZoneSync)
    window.visualViewport?.addEventListener('resize', scheduleHiddenEditSafeZoneSync)
    window.visualViewport?.addEventListener('scroll', scheduleHiddenEditSafeZoneSync)

    return () => {
      rootObserver.disconnect()
      if (syncRaf) cancelAnimationFrame(syncRaf)
      window.removeEventListener('resize', scheduleHiddenEditSafeZoneSync)
      window.visualViewport?.removeEventListener('resize', scheduleHiddenEditSafeZoneSync)
      window.visualViewport?.removeEventListener('scroll', scheduleHiddenEditSafeZoneSync)
    }
  }, [hideForMobileEdit])

  // ResizeObserver — set --lcs-input-safe-zone on parent so scroll padding stays in sync
  useLayoutEffect(() => {
    if (hideForMobileEdit) return
    const el = containerRef.current
    if (!el) return
    const parent = el.parentElement
    if (!parent) return
    const root = document.documentElement
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
        const rootStyle = getComputedStyle(root)
        bottomOffset = parseFloat(rootStyle.getPropertyValue('--app-keyboard-inset-bottom')) || 0
      } else {
        bottomOffset = parseFloat(getComputedStyle(el).bottom) || 12
      }
      parent.style.setProperty('--lcs-input-safe-zone', `${h + bottomOffset + 8}px`)
    }

    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()

    // On iOS PWA, the virtual keyboard changes `bottom` via CSS variable but
    // doesn't change the element's size — ResizeObserver alone won't catch it.
    // Mirror root style writes as well because some focus transitions only
    // update --app-keyboard-inset-bottom after our own JS sync path.
    let vpFrame = 0
    const onViewportResize = () => {
      // Run after main.tsx's syncViewportVars (also uses requestAnimationFrame)
      cancelAnimationFrame(vpFrame)
      vpFrame = requestAnimationFrame(update)
    }
    const rootObserver = new MutationObserver(onViewportResize)
    if (isIOSPwa) {
      rootObserver.observe(root, { attributes: true, attributeFilter: ['style'] })
      window.addEventListener('resize', onViewportResize)
      window.visualViewport?.addEventListener('resize', onViewportResize)
      window.visualViewport?.addEventListener('scroll', onViewportResize)
    }

    return () => {
      ro.disconnect()
      cancelAnimationFrame(vpFrame)
      if (isIOSPwa) {
        rootObserver.disconnect()
        window.removeEventListener('resize', onViewportResize)
        window.visualViewport?.removeEventListener('resize', onViewportResize)
        window.visualViewport?.removeEventListener('scroll', onViewportResize)
      }
    }
  }, [hideForMobileEdit])

  // Document-level Escape to stop generation
  useEffect(() => {
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      // Peers can't stop the host's generation — ignore Escape for them.
      if (e.key === 'Escape' && isGeneratingInChat && !isRoomPeer) {
        e.preventDefault()
        e.stopPropagation()
        generateApi.stop(generationIdForChat || undefined, chatId).catch(console.error)
        // If in optimistic phase, revert locally
        if (localGenerationInChat && !activeGenerationId) {
          stopStreaming()
        }
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isGeneratingInChat, generationIdForChat, localGenerationInChat, activeGenerationId, chatId, stopStreaming, isRoomPeer])

  useEffect(() => {
    if (openPopover !== 'persona') {
      setPersonaSearch('')
      return
    }
    if (personas.length > 0) {
      setPersonaList(personas.map((p) => ({
        id: p.id,
        name: p.name,
        title: p.title || '',
        description: p.description || '',
        folder: p.folder || '',
        avatar_path: p.avatar_path,
        image_id: p.image_id,
        metadata: p.metadata,
      })))
      return
    }
    personasApi.listAll().then((allPersonas) => {
      setPersonaList(allPersonas.map((p) => ({
        id: p.id,
        name: p.name,
        title: p.title || '',
        description: p.description || '',
        folder: p.folder || '',
        avatar_path: p.avatar_path,
        image_id: p.image_id,
        metadata: p.metadata,
      })))
    }).catch(() => {})
  }, [openPopover, personas])

  useEffect(() => {
    if (!activeCharacterId) return
    charactersApi.get(activeCharacterId).then((c) => setCharacterName(c.name)).catch(() => {})
  }, [activeCharacterId])

  const DOCUMENT_EXTENSIONS = useMemo(() => new Set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml',
    '.html', '.htm', '.yaml', '.yml', '.log', '.rst', '.rtf',
  ]), [])

  const isDocumentFile = useCallback((file: File) => {
    const ext = file.name.lastIndexOf('.') >= 0 ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : ''
    return DOCUMENT_EXTENSIONS.has(ext)
  }, [DOCUMENT_EXTENSIONS])

  const handleAttachFiles = useCallback(async (files: FileList | File[] | null) => {
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
            const chatLabel = characterName ? t('toast.chatDocumentsNamed', { name: characterName }) : t('toast.chatDocuments')
            await databankApi.attachToChat(file, chatId, chatLabel)
            const docName = file.name.replace(/\.[^.]+$/, '')
            toast.success(t('toast.docAddedToDatabank', { name: docName }), { duration: 3000 })
          } catch (err: any) {
            toast.error(err?.body?.error || err?.message || t('toast.uploadFileFailed', { name: file.name }), { title: t('toast.uploadFailed') })
          }
          continue
        }

        if (!isImage && !isAudio) {
          toast.error(t('toast.unsupportedFileType', { name: file.name }), { title: t('toast.uploadFailed') })
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
      toast.error(err?.message || t('toast.failedUploadAttachment'), { title: t('toast.uploadFailed') })
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [isDocumentFile, chatId, characterName, t])

  const removeAttachment = useCallback((imageId: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.image_id !== imageId))
  }, [])

  // Paste-to-attach: pull any files (e.g. screenshots) out of the clipboard and
  // route them through the same pipeline as the file picker. Plain-text pastes
  // contain no files, so we leave the default behavior untouched for those.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile()
      if (!file) continue
      // Clipboard images arrive with a generic name like "image.png"; stamp a
      // friendlier, unique name so the attachment strip and saved filename read clearly.
      if (file.type.startsWith('image/') && /^image\.\w+$/i.test(file.name)) {
        const ext = file.name.slice(file.name.lastIndexOf('.'))
        files.push(new File([file], `pasted-image-${Date.now()}${ext}`, { type: file.type }))
      } else {
        files.push(file)
      }
    }
    if (files.length === 0) return
    e.preventDefault()
    handleAttachFiles(files)
  }, [handleAttachFiles])

  // Drag-and-drop: a counter tracks enter/leave across child elements so the
  // overlay doesn't flicker as the cursor moves over nested nodes.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
    e.preventDefault()
    dragCounterRef.current += 1
    setDragActive(true)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return
    e.preventDefault()
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (dragCounterRef.current === 0) return
    e.preventDefault()
    dragCounterRef.current -= 1
    if (dragCounterRef.current === 0) setDragActive(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    dragCounterRef.current = 0
    setDragActive(false)
    handleAttachFiles(files)
  }, [handleAttachFiles])

  // Detect trailing consecutive user messages (queued messages awaiting generation)
  const hasQueuedMessages = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].extra?.hidden) continue
      return messages[i].is_user
    }
    return false
  }, [messages])
  const hasDraftContent = text.trim().length > 0 || pendingAttachments.length > 0 || pendingRegexVisibleCount > 0
  const [mobileQueueHoldState, setMobileQueueHoldState] = useState<MobileQueueHoldState>('idle')

  const setMobileQueueHoldVisualState = useCallback((next: MobileQueueHoldState) => {
    mobileQueueHoldStateRef.current = next
    setMobileQueueHoldState(next)
  }, [])

  const suppressFollowupClick = useCallback((durationMs = 1500) => {
    ignoreFollowupClickCountRef.current = 1
    ignoreFollowupClickUntilRef.current = Date.now() + durationMs
  }, [])

  const clearTouchQueueTimers = useCallback(() => {
    if (touchHoldPromptTimerRef.current) {
      clearTimeout(touchHoldPromptTimerRef.current)
      touchHoldPromptTimerRef.current = 0
    }
    if (touchQueueArmTimerRef.current) {
      clearTimeout(touchQueueArmTimerRef.current)
      touchQueueArmTimerRef.current = 0
    }
  }, [])

  const syncMobileQueueHoldVisualState = useCallback((holdStartedAt: number, evaluatedAt: number) => {
    if (touchHoldStartedAtRef.current !== holdStartedAt || mobileQueueHoldStateRef.current === 'queueing') {
      return 'idle'
    }

    const nextState = getMobileQueueHoldPreviewState({
      holdStartedAt,
      evaluatedAt,
      revealAfterMs: MOBILE_QUEUE_HOLD_PROMPT_MS,
      thresholdMs: MOBILE_QUEUE_HOLD_MS,
    })
    if (nextState !== mobileQueueHoldStateRef.current) {
      setMobileQueueHoldVisualState(nextState)
    }
    return nextState
  }, [setMobileQueueHoldVisualState])

  useEffect(() => {
    return () => {
      clearTouchQueueTimers()
    }
  }, [clearTouchQueueTimers])

  useEffect(() => {
    if ((mobileQueueHoldState === 'holding' || mobileQueueHoldState === 'armed') && (!hasDraftContent || isGeneratingInChat)) {
      clearTouchQueueTimers()
      setMobileQueueHoldVisualState('idle')
    }
  }, [mobileQueueHoldState, hasDraftContent, isGeneratingInChat, clearTouchQueueTimers, setMobileQueueHoldVisualState])

  const finalizeRegexSelections = useCallback(async (
    selections: PendingRegexSelection[],
    triggerAction?: RegexActionActivation,
  ): Promise<boolean> => {
    const multiSelections = selections.filter((selection) => selection.multi_select)
    const actionsToClaim: RegexActionActivation[] = [
      ...multiSelections,
      ...(triggerAction ? [triggerAction] : []),
    ]
    if (actionsToClaim.length === 0) return true

    if (mpRoomId && !mpIsHost) {
      if (claimLocalRegexActions(actionsToClaim)) return true
      for (const selection of multiSelections) clearRegexSelectionForSource(selection)
      setPendingRegexVisibleCount(getPendingRegexSelections(chatId).filter((item) => item.type === 'send').length)
      toast.info(t('toast.regexActionAlreadyUsed'))
      return false
    }

    try {
      const result = await messagesApi.claimRegexActions(chatId, actionsToClaim.flatMap((selection) => (
        selection.messageId ? [{
          message_id: selection.messageId,
          script_id: selection.scriptId,
          action_id: selection.id,
          instance_id: selection.instanceId,
        }] : []
      )))
      for (const message of result.messages) updateMessage(message.id, { extra: message.extra })
      return true
    } catch (error: any) {
      for (const message of error?.body?.messages || []) {
        if (message?.id && message?.extra) updateMessage(message.id, { extra: message.extra })
      }
      if (error?.status === 404 || error?.status === 409) {
        for (const selection of multiSelections) clearRegexSelectionForSource(selection)
        setPendingRegexVisibleCount(getPendingRegexSelections(chatId).filter((item) => item.type === 'send').length)
      }
      toast.info(error?.body?.error || t('toast.regexActionClaimFailed'))
      return false
    }
  }, [chatId, mpIsHost, mpRoomId, t, updateMessage])

  // Multiplayer room send. Returns 'sent' (routed to the room — caller stops),
  // 'blocked' (off-turn / closed freeform window — caller stops), or 'local'
  // (not in a room, or host in round-robin → caller does its normal local
  // send/queue). Shared by send AND queue so both are turn/window-gated
  // identically — queueing must not be a bypass.
  const attemptRoomSend = useCallback(async (
    contentOverride?: string,
    triggerAction?: RegexActionActivation,
  ): Promise<'sent' | 'blocked' | 'local'> => {
    const mp = useStore.getState()
    if (!mp.mpRoomId) return 'local'
    if (!mp.isMyTurn()) {
      toast.info(mp.mpTurnStrategy === 'freeform' ? 'The freeform window is closed' : 'Wait for your turn')
      return 'blocked'
    }
    // The host in round-robin sends locally (owns the chat); everyone else —
    // peers always, and the host during a freeform window — submits via the room.
    const hostFreeformContribution = mp.mpIsHost && mp.mpTurnStrategy === 'freeform'
    if (mp.mpIsHost && !hostFreeformContribution) return 'local'
    const pendingSelections = getPendingRegexSelections(chatId)
    const roomContent = stackVisibleRegexSelections(contentOverride ?? text, pendingSelections)
    if (!roomContent) return 'blocked'
    if (!await finalizeRegexSelections(pendingSelections, triggerAction)) return 'blocked'
    const consumedSelections = consumeRegexSelections(chatId)
    setPendingRegexVisibleCount(0)
    sendRoomAction({
      type: 'room_message',
      content: roomContent,
      associative_regex_append: serializeHiddenRegexSelections(consumedSelections),
    })
    if (contentOverride === undefined) {
      setText('')
      if (saveDraftInput) { try { localStorage.removeItem(DRAFT_KEY_PREFIX + chatId) } catch {} }
    }
    requestAnimationFrame(() => {
      if (textareaRef.current) { resizeTextarea(textareaRef.current); textareaRef.current.focus() }
    })
    return 'sent'
  }, [text, chatId, saveDraftInput, resizeTextarea, finalizeRegexSelections])

  const handleQueueMessage = useCallback(async () => {
    if (sendingRef.current || isGeneratingInChat) return
    sendingRef.current = true
    // In a room, queueing IS sending — gate by turn/window + route through the
    // host (peers can't write to the chat directly).
    if (await attemptRoomSend() !== 'local') {
      sendingRef.current = false
      return
    }
    const pendingSelections = getPendingRegexSelections(chatId)
    const content = stackVisibleRegexSelections(text, pendingSelections)
    const attachments = pendingAttachments.length > 0
      ? pendingAttachments.map(({ previewUrl: _, ...a }) => a)
      : undefined
    if (!content && !attachments) {
      sendingRef.current = false
      return
    }

    if (!await finalizeRegexSelections(pendingSelections)) {
      sendingRef.current = false
      return
    }

    setText('')
    setPendingAttachments([])
    if (saveDraftInput) {
      try { localStorage.removeItem(DRAFT_KEY_PREFIX + chatId) } catch {}
    }

    let consumedRegexSelections: PendingRegexSelection[] = []
    const regexSelectionsFinalized = pendingSelections.some((selection) => selection.multi_select)

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        resizeTextarea(textareaRef.current)
        textareaRef.current.focus()
      }
    })

    try {
      const effectivePersonaId = isTemporaryChat ? null : activePersonaId
      const effectivePersonaName = personas.find((p) => p.id === effectivePersonaId)?.name || t('userFallback')
      const extra: Record<string, any> = {}
      if (effectivePersonaId) extra.persona_id = effectivePersonaId
      if (attachments) extra.attachments = attachments
      consumedRegexSelections = consumeRegexSelections(chatId)
      setPendingRegexVisibleCount(0)
      const hiddenSelections = serializeHiddenRegexSelections(consumedRegexSelections)
      if (hiddenSelections.length > 0) extra.associative_regex_append = hiddenSelections

      const msg = await messagesApi.create(chatId, {
        is_user: true,
        name: effectivePersonaName,
        content: content || '(attached)',
        extra: Object.keys(extra).length > 0 ? extra : undefined,
      })
      addMessage(msg)
      toast.info(t('toast.messageQueued'), { duration: 1500 })
    } catch (err: any) {
      restoreRegexSelections(
        chatId,
        regexSelectionsFinalized
          ? consumedRegexSelections.filter((selection) => !selection.multi_select)
          : consumedRegexSelections,
      )
      setPendingRegexVisibleCount(getPendingRegexSelections(chatId).filter((item) => item.type === 'send').length)
      console.error('[InputArea] Failed to queue message:', err)
      toast.error(err?.body?.error || err?.message || t('toast.failedQueueMessage'))
    } finally {
      sendingRef.current = false
    }
  }, [text, chatId, isGeneratingInChat, isTemporaryChat, activePersonaId, personas, pendingAttachments, addMessage, saveDraftInput, resizeTextarea, attemptRoomSend, finalizeRegexSelections, t])

  const handleSend = useCallback(async (
    contentOverride?: string,
    triggerAction?: RegexActionActivation,
  ) => {
    if (sendingRef.current || isGeneratingInChat) return
    sendingRef.current = true

    // Multiplayer: route through the room (turn/window-gated) unless we're the
    // host in round-robin, who sends locally on their own chat.
    if (await attemptRoomSend(contentOverride, triggerAction) !== 'local') {
      sendingRef.current = false
      return
    }

    const pendingSelections = getPendingRegexSelections(chatId)
    const sourceText = stackVisibleRegexSelections(contentOverride ?? text, pendingSelections)
    const content = sourceText.trim()
    const attachments = contentOverride === undefined && pendingAttachments.length > 0
      ? pendingAttachments.map(({ previewUrl: _, ...a }) => a)
      : undefined

    const willCreateMessage = !!content || !!attachments
    if (willCreateMessage && !await finalizeRegexSelections(pendingSelections, triggerAction)) {
      sendingRef.current = false
      return
    }

    const nonce = ++generationNonceRef.current
    if (contentOverride === undefined) {
      setText('')
      setPendingAttachments([])
    }
    if (contentOverride === undefined && saveDraftInput) {
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

    let consumedRegexSelections: PendingRegexSelection[] = []
    let regexAppendsCommitted = false
    const regexSelectionsFinalized = willCreateMessage && (
      !!triggerAction || pendingSelections.some((selection) => selection.multi_select)
    )
    try {
      const effectivePersonaId = isTemporaryChat ? null : activePersonaId
      const effectivePersonaName = personas.find((p) => p.id === effectivePersonaId)?.name || t('userFallback')
      const presetId = getActivePresetForGeneration() || undefined
      const genOpts: import('@/api/generate').GenerateRequest = {
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: effectivePersonaId || undefined,
        persona_addon_states: effectivePersonaId === activePersonaId ? activeGenerationAddonStates : undefined,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
        generation_type: 'normal' as const,
        user_input: sourceText || undefined,
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

      const orderedMentionedIds = mentionedIds.length > 0
        ? orderGroupResponseIds(mentionedIds, groupResponseOrder, { priorityIds: [mentionedIds[0]] })
        : []

      // Initial speaker: first mention → configured unmuted member order → undefined.
      if (isGroupChat && groupCharacterIds.length > 0) {
        if (orderedMentionedIds.length > 0) {
          genOpts.target_character_id = orderedMentionedIds[0]
        } else {
          const firstUnmuted = orderGroupResponseIds(
            groupCharacterIds.filter((id) => !mutedCharacterIds.includes(id)),
            groupResponseOrder,
          )[0]
          if (firstUnmuted) genOpts.target_character_id = firstUnmuted
        }
      }

      // Queue remaining mentioned members after the direct-mention lead.
      const remainingMentions = orderedMentionedIds.slice(1)
      if (isGroupChat && remainingMentions.length > 0) {
        setMentionQueue({
          chatId,
          ids: remainingMentions,
          opts: {
            connection_id: genOpts.connection_id,
            persona_id: genOpts.persona_id,
            persona_addon_states: genOpts.persona_addon_states,
            preset_id: genOpts.preset_id,
            force_preset_id: genOpts.force_preset_id,
            user_input: genOpts.user_input,
          },
        })
      } else {
        setMentionQueue(null)
      }

      if (finalContent || attachments) {
        const extra: Record<string, any> = {}
        if (effectivePersonaId) extra.persona_id = effectivePersonaId
        if (attachments) extra.attachments = attachments
        consumedRegexSelections = consumeRegexSelections(chatId)
        setPendingRegexVisibleCount(0)
        const hiddenSelections = serializeHiddenRegexSelections(consumedRegexSelections)
        if (hiddenSelections.length > 0) extra.associative_regex_append = hiddenSelections
        const msg = await messagesApi.create(chatId, {
          is_user: true,
          name: effectivePersonaName,
          content: finalContent || '(attached)',
          extra: Object.keys(extra).length > 0 ? extra : undefined,
        })
        regexAppendsCommitted = true
        // Optimistically add to store so it appears immediately
        addMessage(msg)
        // Show streaming state immediately so stop button appears during assembly
        beginStreaming()
        const res = await generateApi.start(genOpts)
        if (generationNonceRef.current !== nonce) return
        startStreaming(res.generationId)
        consumeOneshotGuides()
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
      if (!regexAppendsCommitted) {
        restoreRegexSelections(
          chatId,
          regexSelectionsFinalized
            ? consumedRegexSelections.filter((selection) => !selection.multi_select)
            : consumedRegexSelections,
        )
        setPendingRegexVisibleCount(getPendingRegexSelections(chatId).filter((item) => item.type === 'send').length)
      }
      if (generationNonceRef.current !== nonce) return
      console.error('[InputArea] Failed to send:', err)
      const msg = err?.body?.error || err?.message || te('failedToStartGeneration')
      setStreamingError(msg)
      toast.error(msg, { title: t('toast.generationFailed') })
    } finally {
      sendingRef.current = false
    }
  }, [text, chatId, isGeneratingInChat, isTemporaryChat, activeProfileId, activePersonaId, activeGenerationAddonStates, getActivePresetForGeneration, personas, pendingAttachments, addMessage, startStreaming, beginStreaming, setStreamingError, consumeOneshotGuides, saveDraftInput, hasQueuedMessages, isGroupChat, groupCharacterIds, mutedCharacterIds, groupResponseOrder, characters, setMentionQueue, resizeTextarea, attemptRoomSend, finalizeRegexSelections, activeCharacterId, t, te])

  useEffect(() => {
    const handleRegexAction = async (event: Event) => {
      const action = (event as CustomEvent<RegexActionActivation>).detail
      if (!action || action.chatId !== chatId) return
      if (!action.messageId || regexActionHandlingRef.current) return
      if (action.effects?.length && mpRoomId && !mpIsHost) {
        toast.info(t('toast.regexActionStateHostOnly'))
        return
      }
      if (action.multi_select && sendingRef.current) {
        toast.info(t('toast.regexActionSelectionLocked'))
        return
      }
      if (!action.multi_select && action.type === 'send' && (sendingRef.current || isGeneratingInChat)) {
        toast.info(t('toast.regexActionClaimFailed'))
        return
      }
      regexActionHandlingRef.current = true
      try {
        if (action.multi_select) {
          const result = toggleRegexSelection(action)
          setPendingRegexVisibleCount(result.items.filter((item) => item.type === 'send').length)
          if ('reason' in result) {
            if (result.reason === 'removed') {
              toast.info(t('toast.regexActionMultiRemoved'), { title: action.title || t('toast.regexActionSelected') })
            } else if (result.reason === 'used') {
              toast.info(t('toast.regexActionAlreadyUsed'))
            } else {
              toast.info(t(result.reason === 'invalid_limit'
                ? 'toast.regexActionInvalidLimit'
                : 'toast.regexActionLimitReached', { limit: action.limit }))
            }
            return
          }
          toast.info(action.subtitle || t('toast.regexActionMultiQueued', {
            cost: action.cost,
            total: result.items
              .filter((item) => item.messageId === action.messageId && item.instanceId === action.instanceId)
              .reduce((sum, item) => sum + item.cost, 0),
            limit: action.limit,
          }), {
            title: action.title || t('toast.regexActionSelected'),
            duration: 2500,
          })
          textareaRef.current?.focus()
          return
        }
        if (action.type === 'effects') {
          const claimed = await messagesApi.claimRegexAction(chatId, action.messageId, {
            script_id: action.scriptId,
            action_id: action.id,
            instance_id: action.instanceId,
          })
          updateMessage(claimed.message.id, { extra: claimed.message.extra })
          const draft = claimed.effects?.find((effect) => effect.type === 'draft')
          if (claimed.forked_chat) {
            if (draft) queueRegexActionDraft(claimed.forked_chat.id, draft)
            navigate(`/chat/${claimed.forked_chat.id}`)
          } else if (draft) {
            setText((current) => applyRegexActionDraft(current, draft))
            requestAnimationFrame(() => {
              resizeTextarea(textareaRef.current)
              textareaRef.current?.focus()
            })
          }
          toast.info(action.subtitle || t('toast.regexActionEffectsApplied'), {
            title: action.title || t('toast.regexActionSelected'),
            duration: 2500,
          })
          return
        }
        if (action.type === 'append' && hasPendingRegexSelectionsForBlock(action)) {
          toast.info(t('toast.regexActionClearMultiFirst'))
          return
        }
        if (mpRoomId && !mpIsHost) {
          if (action.type === 'append') {
            if (!claimLocalRegexAction(action)) {
              toast.info(t('toast.regexActionAlreadyUsed'))
              return
            }
            queueRegexSelection(action)
            setPendingRegexVisibleCount(getPendingRegexSelections(chatId).filter((item) => item.type === 'send').length)
            toast.info(action.subtitle || t('toast.regexActionQueued'), {
              title: action.title || t('toast.regexActionSelected'),
              duration: 2500,
            })
            return
          }
          await handleSend(action.content, action)
          return
        }

        if (action.type === 'append') {
          const claimed = await messagesApi.claimRegexAction(chatId, action.messageId, {
            script_id: action.scriptId,
            action_id: action.id,
            instance_id: action.instanceId,
          })
          updateMessage(claimed.message.id, { extra: claimed.message.extra })
          queueRegexSelection(action)
          setPendingRegexVisibleCount(getPendingRegexSelections(chatId).filter((item) => item.type === 'send').length)
          toast.info(action.subtitle || t('toast.regexActionQueued'), {
            title: action.title || t('toast.regexActionSelected'),
            duration: 2500,
          })
          textareaRef.current?.focus()
          return
        }
        await handleSend(action.content, action)
      } catch (error: any) {
        const current = error?.body?.message
        if (current?.id && current?.extra) updateMessage(current.id, { extra: current.extra })
        toast.info(error?.body?.error || t('toast.regexActionClaimFailed'))
      } finally {
        regexActionHandlingRef.current = false
      }
    }
    window.addEventListener(REGEX_ACTION_EVENT, handleRegexAction)
    return () => window.removeEventListener(REGEX_ACTION_EVENT, handleRegexAction)
  }, [chatId, handleSend, isGeneratingInChat, mpIsHost, mpRoomId, navigate, resizeTextarea, t, updateMessage])

  const finalizeSTTTranscript = useCallback(() => {
    const transcript = sttNormalizedFinalSegmentsRef.current.join(' ').trim()
    const shouldSend = sttShouldSendRef.current

    sttInterimTextRef.current = ''
    sttFinalSegmentsRef.current = []
    sttNormalizedFinalSegmentsRef.current = []
    sttCommandStateRef.current = { thoughtDepth: 0 }
    sttShouldSendRef.current = false

    setSttStatus('idle')
    stopSTTSession('destroy')

    if (!transcript) {
      pendingSTTActionRef.current = null
      applySTTTranscript('', true)
      return
    }

    pendingSTTActionRef.current = shouldSend ? 'send' : 'queue'
    applySTTTranscript(transcript, true)
  }, [applySTTTranscript, stopSTTSession])

  useEffect(() => {
    const pendingAction = pendingSTTActionRef.current
    if (!pendingAction) return
    if (!text.trim()) {
      pendingSTTActionRef.current = null
      return
    }

    pendingSTTActionRef.current = null
    if (pendingAction === 'send') {
      void handleSend()
      return
    }
    void handleQueueMessage()
  }, [text, handleQueueMessage, handleSend])

  const doRegenerate = useCallback(async (feedback?: string | null) => {
    if (isGeneratingInChat) return
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
      const presetId = getActivePresetForGeneration() || undefined
      const genOpts: import('@/api/generate').GenerateRequest = {
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        persona_addon_states: activeGenerationAddonStates,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
        generation_type: 'normal',
        retain_council: retainCouncilForRegens || undefined,
      }
      if (isGroupChat && typeof lastMsg?.extra?.character_id === 'string') {
        genOpts.target_character_id = lastMsg.extra.character_id
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
      const msg = err?.body?.error || err?.message || te('failedToRegenerate')
      setStreamingError(msg)
      toast.error(msg, { title: t('toast.regenerationFailed') })
    }
  }, [chatId, isGeneratingInChat, messages, isGroupChat, activeProfileId, activeCharacterId, activePersonaId, activeGenerationAddonStates, getActivePresetForGeneration, regenFeedback.position, retainCouncilForRegens, addMessage, beginStreaming, startStreaming, setStreamingError, consumeOneshotGuides, t, te])

  const handleRegenerate = useCallback(() => {
    if (isGeneratingInChat) return
    if (regenFeedback.enabled) {
      openModal('regenFeedback', {
        chatId,
        onSubmit: (feedback: string) => doRegenerate(feedback),
        onSkip: () => doRegenerate(),
      })
    } else {
      doRegenerate()
    }
  }, [isGeneratingInChat, regenFeedback.enabled, openModal, doRegenerate, chatId])

  const handleContinue = useCallback(async () => {
    if (isGeneratingInChat) return
    const nonce = ++generationNonceRef.current
    beginStreaming(undefined, 'continue')
    try {
      const lastMessage = messages.at(-1)
      const lastAssistant = lastMessage && !lastMessage.is_user ? lastMessage : undefined
      const targetCharacterId = isGroupChat && typeof lastAssistant?.extra?.character_id === 'string'
        ? lastAssistant.extra.character_id
        : undefined
      const presetId = getActivePresetForGeneration() || undefined
      const res = await generateApi.continueGeneration({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        persona_addon_states: activeGenerationAddonStates,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
        message_id: lastAssistant?.id,
        target_character_id: targetCharacterId,
        retain_council: retainCouncilForRegens || undefined,
      })
      if (generationNonceRef.current !== nonce) return
      startStreaming(res.generationId)
      consumeOneshotGuides()
    } catch (err: any) {
      if (generationNonceRef.current !== nonce) return
      console.error('[InputArea] Failed to continue:', err)
      const msg = err?.body?.error || err?.message || te('failedToContinue')
      setStreamingError(msg)
      toast.error(msg, { title: t('toast.continueFailed') })
    }
  }, [chatId, isGeneratingInChat, messages, isGroupChat, activeProfileId, activeCharacterId, activePersonaId, activeGenerationAddonStates, getActivePresetForGeneration, retainCouncilForRegens, beginStreaming, startStreaming, setStreamingError, consumeOneshotGuides, t, te])

  const handleImpersonate = useCallback(async (mode: import('@/api/generate').ImpersonateMode) => {
    if (isGeneratingInChat) return
    const nonce = ++generationNonceRef.current
    const inputDraft = text
    const impersonateInput = inputDraft.trim()
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
      const presetId = forcedPresetId || getActivePresetForGeneration() || undefined
      const res = await generateApi.start({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        persona_addon_states: activeGenerationAddonStates,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
        generation_type: 'impersonate',
        impersonate_mode: mode,
        impersonate_input: impersonateInput || undefined,
        user_input: inputDraft || undefined,
        impersonate_draft: true,
      })
      if (generationNonceRef.current !== nonce) return
      startStreaming(res.generationId)
      consumeOneshotGuides()
    } catch (err: any) {
      if (generationNonceRef.current !== nonce) return
      console.error('[InputArea] Failed to impersonate:', err)
      const msg = err?.body?.error || err?.message || te('failedToImpersonate')
      setStreamingError(msg)
      toast.error(msg, { title: t('toast.impersonationFailed') })
    }
  }, [chatId, isGeneratingInChat, text, activeProfileId, activeCharacterId, activePersonaId, activeGenerationAddonStates, impersonationPresetId, getActivePresetForGeneration, beginStreaming, startStreaming, setStreamingError, consumeOneshotGuides, resizeTextarea, t, te])

  const handleStop = useCallback(async () => {
    if (!isGeneratingInChat) return
    // Peers don't own the host's generation — stopping is the host's to do.
    if (isRoomPeer) return
    try {
      // Stop the specific generation when we know its ID; the chat id lets the
      // backend fall back to the chat's active generation if the ID is stale
      // (or, in the optimistic phase, not yet known).
      await generateApi.stop(generationIdForChat || undefined, chatId)
    } catch (err) {
      console.error('[InputArea] Failed to stop:', err)
    }
    // If we're in the optimistic phase (no WS events yet), revert locally
    if (localGenerationInChat && !activeGenerationId) {
      stopStreaming()
    }
  }, [isGeneratingInChat, generationIdForChat, localGenerationInChat, activeGenerationId, chatId, stopStreaming, isRoomPeer])

  const queueCurrentChatDeletion = useCallback(() => {
    void chatsApi.delete(chatId).catch((err) => {
      console.error('[InputArea] Failed to delete previous chat after creating a new one:', err)
      toast.error(t('toast.failedDeleteChat'))
    })
  }, [chatId, t])

  const createNewChat = useCallback(async (deleteThisChat: boolean) => {
    // For group chats, open group creator pre-populated with current members
    if (isGroupChat && groupCharacterIds.length > 0) {
      openModal('groupChatCreator', {
        initialCharacterIds: [...groupCharacterIds],
        ...(deleteThisChat ? { deleteChatIdAfterCreate: chatId } : {}),
      })
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
            const toastId = toast.info(t('toast.creatingChatCortex'), {
              title: t('toast.startingChat'),
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
              if (deleteThisChat) queueCurrentChatDeletion()
            } catch (err) {
              toast.dismiss(toastId)
              console.error('[InputArea] Failed to create chat:', err)
              toast.error(t('toast.failedCreateChat'))
            }
          },
        })
        return
      }
      creationToastId = toast.info(t('toast.creatingChatCortex'), {
        title: t('toast.startingChat'),
        duration: 60_000,
        dismissible: false,
      })
      const chat = await chatsApi.create({ character_id: character.id })
      toast.dismiss(creationToastId)
      creationToastId = null
      navigate(`/chat/${chat.id}`)
      if (deleteThisChat) queueCurrentChatDeletion()
    } catch (err) {
      if (creationToastId) toast.dismiss(creationToastId)
      console.error('[InputArea] Failed to start new chat:', err)
      toast.error(t('toast.failedStartNewChat'))
    }
  }, [activeCharacterId, chatId, isGroupChat, groupCharacterIds, navigate, openModal, queueCurrentChatDeletion, t])

  const handleNewChat = useCallback(() => {
    openModal('confirm', {
      title: t('newChatConfirm.title'),
      message: t('newChatConfirm.message'),
      confirmText: t('newChatConfirm.confirm'),
      checkboxLabel: t('newChatConfirm.deleteThisChat'),
      onConfirm: (_inputValue: string, deleteThisChat: boolean) => {
        void createNewChat(deleteThisChat)
      },
    })
  }, [createNewChat, openModal, t])

  const handleConvertToGroup = useCallback(async () => {
    if (!chatId || !activeCharacterId || isGroupChat) return

    let conversionToastId: string | null = null
    try {
      conversionToastId = toast.info(t('toast.creatingGroupFromChat'), {
        title: t('toast.convertingChat'),
        duration: 60_000,
        dismissible: false,
      })
      const converted = await chatsApi.convertToGroup(chatId)
      toast.dismiss(conversionToastId)
      conversionToastId = null

      useStore.getState().setGroupChat(true, [activeCharacterId], [])
      navigate(`/chat/${converted.id}`)
      openModal('addGroupMember', {
        chatId: converted.id,
        existingCharacterIds: [activeCharacterId],
      })
      toast.success(t('toast.convertedToGroupChat'))
    } catch (err: any) {
      if (conversionToastId) toast.dismiss(conversionToastId)
      console.error('[InputArea] Failed to convert chat to group:', err)
      toast.error(err?.body?.error || err?.message || t('toast.failedConvertChat'), {
        title: t('toast.conversionFailed'),
      })
    }
  }, [chatId, activeCharacterId, isGroupChat, navigate, openModal, t])

  const handleDryRun = useCallback(async () => {
    if (dryRunning || isGeneratingInChat) return
    const presetId = getActivePresetForGeneration()
    if (!presetId) {
      toast.warning(t('toast.noPresetForDryRun'))
      return
    }
    setDryRunning(true)
    try {
      const result = await generateApi.dryRun({
        chat_id: chatId,
        connection_id: activeProfileId || undefined,
        persona_id: activePersonaId || undefined,
        persona_addon_states: activeGenerationAddonStates,
        preset_id: presetId,
        force_preset_id: shouldForceLoomRuntimePreset(presetId, chatId, activeCharacterId, activeProfileId),
        user_input: text || undefined,
        target_character_id: isGroupChat ? focusedPreviewCharacterId || undefined : undefined,
      })
      openModal('dryRun', result)
    } catch (err: any) {
      console.error('[InputArea] Dry run failed:', err)
      const msg = err?.body?.error || err?.message || 'Dry run failed'
      setStreamingError(msg)
    } finally {
      setDryRunning(false)
    }
  }, [text, chatId, dryRunning, isGeneratingInChat, activeProfileId, activeCharacterId, activePersonaId, activeGenerationAddonStates, getActivePresetForGeneration, openModal, setStreamingError, focusedPreviewCharacterId, isGroupChat, t])

  const handleResolveMacros = useCallback(async () => {
    if (resolvingMacros) return
    const template = text.trim()
    if (!template) {
      toast.info(t('toast.nothingToResolve'))
      return
    }
    setResolvingMacros(true)
    try {
      const res = await resolveMacros({
        template: text,
        chat_id: chatId,
        character_id: focusedPreviewCharacterId || undefined,
        persona_id: activePersonaId || undefined,
        connection_id: activeProfileId || undefined,
        user_input: text,
      })
      if (res.text === text) {
        toast.info(t('toast.noMacrosFound'))
      } else {
        queueTextareaSelection(res.text.length)
        setText(res.text)
        const warns = res.diagnostics.filter((d) => d.level === 'warning' || d.level === 'error')
        if (warns.length > 0) {
          toast.warning(t('toast.macrosResolvedWithWarnings', { count: warns.length }))
        } else {
          toast.success(t('toast.macrosResolved'))
        }
      }
    } catch (err: any) {
      console.error('[InputArea] Macro resolution failed:', err)
      const msg = err?.body?.error || err?.message || te('failedToResolveMacros')
      toast.error(msg)
    } finally {
      setResolvingMacros(false)
    }
  }, [text, chatId, resolvingMacros, focusedPreviewCharacterId, activePersonaId, activeProfileId, queueTextareaSelection, t, te])

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

  // Mouse/keyboard activation still routes through click. Touch activation is
  // handled on touchend and marks the follow-up synthetic click to ignore.
  const handleSendClick = useCallback((e: React.MouseEvent) => {
    unlockNotificationAudio()
    unlockTTSAudio()
    if (ignoreFollowupClickCountRef.current > 0) {
      ignoreFollowupClickCountRef.current -= 1
      return
    }
    if (Date.now() < ignoreFollowupClickUntilRef.current) {
      return
    }
    const queueMod = isMac ? e.metaKey : e.ctrlKey
    if (queueMod && hasDraftContent) {
      handleQueueMessage()
    } else {
      handleSend()
    }
  }, [hasDraftContent, handleQueueMessage, handleSend])

  // Touch interactions with draft content are handled on touchend directly so
  // the synthetic follow-up click cannot trigger a second action.
  const handleSendTouchStart = useCallback((e: React.TouchEvent<HTMLButtonElement>) => {
    if (!hasDraftContent || isGeneratingInChat) return
    const holdStartedAt = e.timeStamp
    touchHoldStartedAtRef.current = holdStartedAt
    clearTouchQueueTimers()
    if (mobileQueueHoldStateRef.current !== 'idle') {
      setMobileQueueHoldVisualState('idle')
    }
    touchHoldPromptTimerRef.current = window.setTimeout(() => {
      touchHoldPromptTimerRef.current = 0
      syncMobileQueueHoldVisualState(holdStartedAt, holdStartedAt + MOBILE_QUEUE_HOLD_PROMPT_MS)
    }, MOBILE_QUEUE_HOLD_PROMPT_MS)
    touchQueueArmTimerRef.current = window.setTimeout(() => {
      touchQueueArmTimerRef.current = 0
      const nextState = syncMobileQueueHoldVisualState(holdStartedAt, holdStartedAt + MOBILE_QUEUE_HOLD_MS)
      if (nextState !== 'armed') return
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(12)
      }
    }, MOBILE_QUEUE_HOLD_MS)
  }, [hasDraftContent, isGeneratingInChat, clearTouchQueueTimers, setMobileQueueHoldVisualState, syncMobileQueueHoldVisualState])

  const handleSendTouchEnd = useCallback((e: React.TouchEvent<HTMLButtonElement>) => {
    // Use the native event timestamps instead of Date.now(). On Android the
    // button tap can trigger keyboard/viewport reflow before JS handles
    // touchend, which inflates wall-clock duration and turns a tap into a
    // false long-press.
    const heldLongEnough = didMobileQueueHoldReachThreshold({
      holdStartedAt: touchHoldStartedAtRef.current,
      releasedAt: e.timeStamp,
      thresholdMs: MOBILE_QUEUE_HOLD_MS,
    })
    touchHoldStartedAtRef.current = 0
    clearTouchQueueTimers()
    if (heldLongEnough && hasDraftContent) {
      e.preventDefault()
      e.stopPropagation()
      unlockNotificationAudio()
      unlockTTSAudio()
      suppressFollowupClick()
      setMobileQueueHoldVisualState('queueing')
      void handleQueueMessage().finally(() => {
        setMobileQueueHoldVisualState('idle')
      })
      return
    }
    if (hasDraftContent) {
      e.preventDefault()
      e.stopPropagation()
      unlockNotificationAudio()
      unlockTTSAudio()
      suppressFollowupClick()
      setMobileQueueHoldVisualState('idle')
      void handleSend()
      return
    }
    if (mobileQueueHoldStateRef.current === 'idle' && !hasDraftContent) {
      e.preventDefault()
      e.stopPropagation()
      unlockNotificationAudio()
      unlockTTSAudio()
      suppressFollowupClick()
      void handleSend()
      return
    }
    if (mobileQueueHoldStateRef.current !== 'queueing') {
      setMobileQueueHoldVisualState('idle')
    }
  }, [handleQueueMessage, handleSend, hasDraftContent, suppressFollowupClick, clearTouchQueueTimers, setMobileQueueHoldVisualState])

  const handleSendTouchCancel = useCallback(() => {
    touchHoldStartedAtRef.current = 0
    clearTouchQueueTimers()
    if (mobileQueueHoldStateRef.current !== 'queueing') {
      setMobileQueueHoldVisualState('idle')
    }
  }, [clearTouchQueueTimers, setMobileQueueHoldVisualState])

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

  const handleSTTToggle = useCallback(async () => {
    if (isListeningToSTT) {
      setSttStatus('processing')
      stopSTTSession('stop')
      return
    }

    if (!isSTTSupported) {
      toast.warning(
        voiceSettings.sttProvider === 'webspeech'
          ? t('toast.speechRecognitionUnavailable')
          : t('toast.audioRecordingUnsupported'),
      )
      return
    }

    if (voiceSettings.sttProvider === 'connection' && !voiceSettings.sttConnectionId) {
      toast.warning(t('toast.selectSttConnection'))
      openModal('settings')
      return
    }

    try {
      setSttStatus('starting')
      setSttAudioFrame(null)
      sttDraftBaseRef.current = text.trimEnd()
      sttInterimTextRef.current = ''
      sttFinalSegmentsRef.current = []
      sttNormalizedFinalSegmentsRef.current = []
      sttCommandStateRef.current = { thoughtDepth: 0 }
      sttShouldSendRef.current = false

      const engine = createSTTEngine({
        provider: voiceSettings.sttProvider,
        language: voiceSettings.sttLanguage,
        continuous: voiceSettings.sttContinuous,
        interimResults: voiceSettings.sttInterimResults,
        autoSubmitOnSilence: voiceSettings.sttAutoSubmitOnSilence,
        connectionId: voiceSettings.sttConnectionId,
      })
      sttEngineRef.current?.destroy()
      sttEngineRef.current = engine

      engine.onAudioFrame((frame) => {
        setSttAudioFrame(frame)
      })

      engine.onResult((result) => {
        if (result.isFinal) {
          const { text: commandStrippedText, shouldSend } = stripSTTSendCommand(result.text)
          if (shouldSend) sttShouldSendRef.current = true

          const normalizedSegment = normalizeSTTTranscript(commandStrippedText, sttCommandStateRef.current)
          sttFinalSegmentsRef.current = [...sttFinalSegmentsRef.current, result.text.trim()].filter(Boolean)
          sttNormalizedFinalSegmentsRef.current = [...sttNormalizedFinalSegmentsRef.current, normalizedSegment].filter(Boolean)
          sttInterimTextRef.current = ''
        } else {
          const { text: commandStrippedText } = stripSTTSendCommand(result.text)
          sttInterimTextRef.current = normalizeSTTTranscript(commandStrippedText, { ...sttCommandStateRef.current })
        }

        const transcript = [...sttNormalizedFinalSegmentsRef.current, sttInterimTextRef.current].filter(Boolean).join(' ')
        applySTTTranscript(transcript, result.isFinal)
        setSttStatus(engine.isListening() ? 'listening' : 'idle')
      })

      engine.onStop(() => {
        setSttAudioFrame(null)
        void finalizeSTTTranscript()
      })

      engine.onError((err) => {
        const msg = err.message || 'Speech-to-text failed'
        stopSTTSession('destroy')
        sttInterimTextRef.current = ''
        sttFinalSegmentsRef.current = []
        sttNormalizedFinalSegmentsRef.current = []
        sttCommandStateRef.current = { thoughtDepth: 0 }
        sttShouldSendRef.current = false
        setSttAudioFrame(null)
        setSttStatus('idle')
        toast.error(msg, { title: t('toast.sttFailed') })
      })

      await engine.start()
      setSttStatus(engine.isListening() ? 'listening' : 'idle')
    } catch (err: any) {
      stopSTTSession('destroy')
      setSttStatus('idle')
      toast.error(err?.message || t('toast.sttFailed'), { title: t('toast.sttFailed') })
    }
  }, [isListeningToSTT, isSTTSupported, voiceSettings, text, openModal, applySTTTranscript, stopSTTSession, finalizeSTTTranscript, t])

  useEffect(() => {
    if (isGeneratingInChat && isListeningToSTT) {
      stopSTTSession('destroy')
      setSttStatus('idle')
    }
  }, [isGeneratingInChat, isListeningToSTT, stopSTTSession])

  useEffect(() => {
    if (!isListeningToSTT) return
    if (voiceSettings.sttProvider !== 'webspeech' && sttStatus === 'processing') return
    if (voiceSettings.sttProvider === 'connection' && !voiceSettings.sttConnectionId) {
      stopSTTSession('destroy')
      setSttStatus('idle')
    }
  }, [voiceSettings.sttProvider, voiceSettings.sttConnectionId, isListeningToSTT, sttStatus, stopSTTSession])

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

  const disableAllGuides = useCallback(() => {
    const next = guidedGenerations.map((g) => (g.enabled ? { ...g, enabled: false } : g))
    if (next.some((g, i) => g.enabled !== guidedGenerations[i].enabled)) {
      setSetting('guidedGenerations', next)
    }
  }, [guidedGenerations, setSetting])

  const mobileQueueHintKey = getMobileQueueHintKey({
    supportsTouchQueueHold,
    isGeneratingInChat,
    mobileQueueHoldState,
  })
  const mobileQueueHint = mobileQueueHintKey ? t(mobileQueueHintKey) : null

  let sendButtonTitle = t('input.nudgeFreshReply')
  if (isGeneratingInChat) {
    sendButtonTitle = t('input.stopGeneration')
  } else if (mobileQueueHoldState === 'queueing') {
    sendButtonTitle = t('input.queueingMessage')
  } else if (mobileQueueHoldState === 'armed') {
    sendButtonTitle = t('input.releaseToQueue')
  } else if (mobileQueueHoldState === 'holding') {
    sendButtonTitle = t('input.keepHoldingToQueue')
  } else if (hasDraftContent) {
    sendButtonTitle = supportsTouchQueueHold
      ? t('input.sendMessage')
      : t('input.sendMessageQueueHint', { mod: queueModLabel })
  } else if (hasQueuedMessages) {
    sendButtonTitle = t('input.sendQueuedMessages')
  }

  let sendButtonAriaLabel = t('input.nudgeFreshReply')
  if (isGeneratingInChat) {
    sendButtonAriaLabel = t('input.stopGeneration')
  } else if (mobileQueueHoldState === 'queueing') {
    sendButtonAriaLabel = t('input.queueingMessage')
  } else if (mobileQueueHoldState === 'armed') {
    sendButtonAriaLabel = t('input.releaseToQueue')
  } else if (mobileQueueHoldState === 'holding') {
    sendButtonAriaLabel = t('input.keepHoldingToQueue')
  } else if (hasDraftContent) {
    sendButtonAriaLabel = t('input.sendMessage')
  } else if (hasQueuedMessages) {
    sendButtonAriaLabel = t('input.sendQueuedMessages')
  }

  const sendButtonStyle: CSSProperties = {
    '--send-btn-hold-duration': `${MOBILE_QUEUE_HOLD_MS}ms`,
  } as CSSProperties
  if (isGeneratingInChat) sendButtonStyle.opacity = 0.55

  return (
    <div
      data-component="InputArea"
      ref={containerRef}
      className={styles.container}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
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
      {dragActive && (
        <div className={styles.dropOverlay} aria-hidden="true">
          <Paperclip size={20} />
          <span>{t('input.dropToAttach')}</span>
        </div>
      )}

      {/* Author's Note Panel */}
      <AuthorsNotePanel
        chatId={chatId}
        isOpen={authorsNoteOpen}
        onClose={() => setAuthorsNoteOpen(false)}
      />

      {promptVariablesPreset && (
        <PromptVariablesModal
          isOpen={promptVariablesModalOpen}
          blocks={promptVariablesPreset.blocks}
          values={promptVariablesPreset.promptVariables ?? {}}
          onSave={savePromptVariableValues}
          onClose={() => setPromptVariablesModalOpen(false)}
        />
      )}

      {/* Action bar */}
      <div data-spindle-mount="chat_toolbar">
        <div className={styles.actionBar}>
          <button type="button" className={styles.actionBtn} onClick={onNavigateHome ?? (() => navigate('/'))} title={t('input.backHome')}>
            <Home size={14} />
          </button>
          <span className={styles.actionDivider} />
          {!isGeneratingInChat && (
            <>
              <button type="button" className={styles.actionBtn} onClick={handleRegenerate} title={t('input.regenerate')}>
                <RotateCw size={14} />
              </button>
              <button type="button" className={styles.actionBtn} onClick={handleContinue} title={t('input.continue')}>
                <CornerDownLeft size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            className={styles.actionBtn}
            onClick={() => handleImpersonate('oneliner')}
            title={`${t('quickMenu.oneLiner')}: ${t('quickMenu.oneLinerDesc')}`}
            aria-label={t('quickMenu.oneLiner')}
            disabled={isGeneratingInChat}
            style={isGeneratingInChat ? { opacity: 0.5 } : undefined}
          >
            <MessageSquare size={14} />
          </button>
          <button
            type="button"
            className={clsx(
              styles.actionBtn,
              openPopover === 'persona' && styles.actionBtnActive,
              persistedChatPersonaId && styles.actionBtnHasSelection,
            )}
            onClick={() => setOpenPopover((p) => (p === 'persona' ? null : 'persona'))}
            title={t('input.sendAsPersona')}
          >
            <UserCircle size={14} />
            {persistedChatPersonaId && <span className={styles.badge}>1</span>}
          </button>
          <button
            type="button"
            className={clsx(styles.actionBtn, openPopover === 'connections' && styles.actionBtnActive)}
            onClick={() => setOpenPopover((p) => (p === 'connections' ? null : 'connections'))}
            title={activeProfile ? t('input.switchConnectionActive', { name: activeProfile.name }) : t('input.switchConnection')}
          >
            <Link2 size={14} />
          </button>
          {hasAltFields && (() => {
            const selectionCount = activeAltSelectionCount
            const hasSelection = selectionCount > 0
            const titleParts: string[] = []
            if (isGroupChat) {
              for (const { char, altFields } of groupMembersWithAltFields) {
                const selections = groupAltFieldSelections[char.id] || {}
                const labels = Object.entries(selections)
                  .map(([field, variantId]) => altFields[field]?.find((v) => v.id === variantId)?.label)
                  .filter(Boolean)
                if (labels.length > 0) titleParts.push(`${char.name}: ${labels.join(', ')}`)
              }
            } else {
              for (const [field, variantId] of Object.entries(altFieldSelections)) {
                const variant = altFieldsData[field]?.find((v) => v.id === variantId)
                if (variant) titleParts.push(`${field}: ${variant.label}`)
              }
            }
            const title = hasSelection
              ? t('input.alternateFieldsActive', { details: titleParts.join(', ') })
              : isGroupChat ? t('input.groupAlternateFields') : t('input.alternateFields')
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
          {activePersonaId && (
            <button
              type="button"
              className={clsx(
                styles.actionBtn,
                openPopover === 'addons' && styles.actionBtnActive,
                chatAddonOverrideCount > 0 && styles.actionBtnHasSelection,
              )}
              onClick={() => setOpenPopover((p) => (p === 'addons' ? null : 'addons'))}
              title={chatAddonOverrideCount > 0 ? t('input.personaAddonsCustomized') : t('input.personaAddons')}
            >
              <IconPlaylistAdd size={14} />
              {chatAddonOverrideCount > 0 && <span className={styles.badge}>{chatAddonOverrideCount}</span>}
            </button>
          )}
          <button
            type="button"
            className={clsx(
              styles.actionBtn,
              openPopover === 'guides' && styles.actionBtnActive,
              activeGuideCount > 0 && styles.actionBtnHasSelection,
            )}
            onClick={() => setOpenPopover((p) => (p === 'guides' ? null : 'guides'))}
            title={t('input.guidedGenerations')}
          >
            <Compass size={14} />
            {activeGuideCount > 0 && <span className={styles.badge}>{activeGuideCount}</span>}
          </button>
          <button
            type="button"
            className={clsx(styles.actionBtn, openPopover === 'quick' && styles.actionBtnActive)}
            onClick={() => setOpenPopover((p) => (p === 'quick' ? null : 'quick'))}
            title={t('input.quickReplies')}
          >
            <MessageSquareQuote size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.actionBtn, openPopover === 'tools' && styles.actionBtnActive)}
            onClick={() => setOpenPopover((p) => (p === 'tools' ? null : 'tools'))}
            title={t('input.tools')}
          >
            <Wrench size={14} />
          </button>
          <button
            type="button"
            className={clsx(styles.actionBtn, openPopover === 'extras' && styles.actionBtnActive)}
            onClick={() => setOpenPopover((p) => (p === 'extras' ? null : 'extras'))}
            title={t('input.extras')}
          >
            <MoreHorizontal size={14} />
          </button>
        </div>
      </div>

      <div className={clsx(styles.popoverSlot, openPopover && styles.popoverSlotOpen)}>
        <div className={styles.popoverSlotInner}>
          {renderPopover === 'guides' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {guidedGenerations.length === 0 && <div className={styles.popEmpty}>{t('quickMenu.noGuidedGenerations')}</div>}
              {guidedGenerations.length > 0 && (
                <>
                  <button
                    type="button"
                    className={styles.popRowBtn}
                    onClick={disableAllGuides}
                    disabled={activeGuideCount === 0}
                  >
                    <span>{t('quickMenu.disableAllGuidedGenerations')}</span>
                    <span className={styles.popMeta}>{t('quickMenu.activeCount', { count: activeGuideCount })}</span>
                  </button>
                  <div className={styles.popDivider} />
                </>
              )}
              {guidedGenerations.map((g) => (
                <button key={g.id} type="button" className={styles.popRowBtn} onClick={() => toggleGuide(g.id)}>
                  <span>{g.name}</span>
                  <span className={styles.popMeta}>{g.enabled ? t('on') : t('off')} • {g.mode}</span>
                </button>
              ))}
              <button type="button" className={styles.popLink} onClick={() => {
                setOpenPopover(null)
                useStore.getState().openSettings('guided')
              }}>{t('quickMenu.manageInSettings')}</button>
            </div>
          )}

          {renderPopover === 'quick' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {activeQuickReplySets.length === 0 && <div className={styles.popEmpty}>{t('quickMenu.noQuickReplySets')}</div>}
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
                      <span>{reply.label || t('quickMenu.untitledReply')}</span>
                    </button>
                  ))}
                </div>
              ))}
              <button type="button" className={styles.popLink} onClick={() => {
                setOpenPopover(null)
                useStore.getState().openSettings('quickReplies')
              }}>{t('quickMenu.manageInSettings')}</button>
            </div>
          )}

          {renderPopover === 'persona' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <label className={styles.personaSearch}>
                <Search size={13} />
                <input
                  type="search"
                  value={personaSearch}
                  onChange={(event) => setPersonaSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape' && personaSearch) {
                      event.preventDefault()
                      event.stopPropagation()
                      setPersonaSearch('')
                    }
                  }}
                  placeholder={t('quickMenu.searchPersonas')}
                  aria-label={t('quickMenu.searchPersonas')}
                  autoFocus
                />
                {personaSearch && (
                  <button type="button" onClick={() => setPersonaSearch('')} aria-label={t('quickMenu.searchPersonas')}>
                    <X size={12} />
                  </button>
                )}
              </label>
              {persistedChatPersonaId && (
                <button
                  type="button"
                  className={styles.popLink}
                  onClick={() => {
                    void persistChatPersonaSelection(null)
                    setOpenPopover(null)
                  }}
                >
                  {t('quickMenu.clearOneShotPersona')}
                </button>
              )}
              {personaPickerGroups.length === 0 && <div className={styles.popEmpty}>{t('quickMenu.noPersonas')}</div>}
              {personaPickerGroups.map((group) => (
                <div key={group.key} className={styles.personaGroup}>
                  <div className={styles.personaGroupHeader}>
                    <span>{group.recent
                      ? t('quickMenu.recentPersonas')
                      : group.folder || t('quickMenu.uncategorizedPersonas')}</span>
                    <span>{group.personas.length}</span>
                  </div>
                  {group.personas.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={clsx(styles.popRowBtn, activePersonaId === p.id && styles.popRowBtnActive)}
                      onClick={() => {
                        void persistChatPersonaSelection(p.id)
                        setOpenPopover(null)
                      }}
                    >
                      <span className={styles.personaMain}>
                        <span className={styles.personaAvatar}>
                          {p.avatar_path || p.image_id ? (
                            <img
                              className={styles.personaAvatarImg}
                              src={(
                                p.id === activePersonaId
                                  ? getPersonaAvatarThumbUrlById(p.id, null, {
                                      chatId,
                                      version: activeChatMetadata?.persona_addon_avatar_versions?.[p.id],
                                    })
                                  : getPersonaAvatarThumbUrl(p)
                              ) || undefined}
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
              ))}
            </div>
          )}

          {renderPopover === 'connections' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {profiles.length === 0 && <div className={styles.popEmpty}>{t('quickMenu.noConnections')}</div>}
              {profiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={clsx(styles.popRowBtn, activeProfileId === p.id && styles.popRowBtnActive)}
                  onClick={() => {
                    setActiveProfile(p.id)
                    setOpenPopover(null)
                  }}
                >
                  <span className={styles.personaMain}>
                    <ProviderIcon kind="llm" provider={p.provider} size={22} />
                    <span className={styles.personaNameGroup}>
                      <span>{p.name}</span>
                      <span className={styles.popMeta}>{p.provider}{p.model ? ` / ${p.model}` : ''}</span>
                    </span>
                  </span>
                </button>
              ))}
              <button type="button" className={styles.popLink} onClick={() => {
                setOpenPopover(null)
                useStore.getState().openDrawer('connections')
              }}>{t('quickMenu.manageConnections')}</button>
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
                    characterName: isGroupChat ? t('quickMenu.groupChat') : (characterName || t('characterFallback')),
                    isGroupChat,
                    groupCharacterIds,
                  })
                }}
              >
                <span className={styles.personaMain}>
                  <FolderOpen size={14} />
                  <span>{t('quickMenu.manageChats')}</span>
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
                  <span>{t('quickMenu.newChat')}</span>
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
                        const mode = updatedChat.metadata?.group_scenario_override?.mode
                        setGroupScenarioMode(mode === 'member' || mode === 'custom' ? mode : 'individual')
                      },
                    })
                  } catch (err) {
                    console.error('[InputArea] Failed to load chat settings:', err)
                  }
                }}
              >
                <span className={styles.personaMain}>
                  <Settings2 size={14} />
                  <span>{isGroupChat ? t('quickMenu.groupSettings') : t('quickMenu.chatSettings')}</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.popRowBtn}
                onClick={() => void openPromptVariablesModal()}
                disabled={!activeLoomPresetId || promptVariablesLoading}
                style={!activeLoomPresetId || promptVariablesLoading ? { opacity: 0.5 } : undefined}
                title={!activeLoomPresetId ? t('quickMenu.promptVariablesSelectPreset') : undefined}
              >
                <span className={styles.personaMain}>
                  <Sliders size={14} />
                  <span className={styles.personaNameGroup}>
                    <span>{t('quickMenu.promptVariables')}</span>
                    <span className={styles.personaTitle}>
                      {promptVariablesLoading
                        ? t('quickMenu.loadingPromptVariables')
                        : activeLoomPresetName
                          ? t('quickMenu.promptVariablesFor', { name: activeLoomPresetName })
                          : t('quickMenu.promptVariablesActivePreset')}
                    </span>
                  </span>
                </span>
              </button>
              {!isGroupChat && activeCharacterId && (
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    void handleConvertToGroup()
                  }}
                >
                  <span className={styles.personaMain}>
                    <UserPlus size={14} />
                    <span>{t('quickMenu.convertToGroupChat')}</span>
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
                  <span>{t('quickMenu.newGroupChat')}</span>
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
                  <span>{t('quickMenu.authorsNote')}</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.popRowBtn}
                onClick={async () => {
                  setOpenPopover(null)
                  try {
                    toast.info(t('toast.recompilingMemories'))
                    const res = await memoryCortexApi.warm(chatId, { force: true })
                    if (res.cortex.status === 'started') {
                      toast.success(t('toast.memoryRebuildStarted'))
                    } else if (res.chatMemory.status === 'complete') {
                      toast.success(t('toast.memoryRebuilt'))
                    } else if (res.reason === 'chat_vectorization_disabled') {
                      toast.error(t('toast.memoryVectorizationDisabled'))
                    } else {
                      toast.info(t('toast.noMemoryRebuildNeeded'))
                    }
                  } catch (err: any) {
                    toast.error(err?.message || t('toast.failedRecompileMemories'))
                  }
                }}
              >
                <span className={styles.personaMain}>
                  <BrainCircuit size={14} />
                  <span>{t('quickMenu.recompileMemories')}</span>
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
                    <span>{t('quickMenu.showExpressionDisplay')}</span>
                  </span>
                </button>
              )}
            </div>
          )}

          {renderPopover === 'extras' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              {isMobile && onOpenChatFind && (
                <button
                  type="button"
                  className={styles.popRowBtn}
                  onClick={() => {
                    setOpenPopover(null)
                    onOpenChatFind()
                  }}
                >
                  <span className={styles.personaMain}>
                    <Search size={14} />
                    <span>{t('findInChat.open')}</span>
                  </span>
                </button>
              )}
              <div className={styles.extrasSection}>
                <div className={styles.quickSetName}>{t('quickMenu.impersonate')}</div>
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
                        <span>{t('quickMenu.restoreLastInput')}</span>
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
                  disabled={isGeneratingInChat}
                  style={isGeneratingInChat ? { opacity: 0.5 } : undefined}
                >
                  <span className={styles.personaMain}>
                    <ScrollText size={14} />
                    <span className={styles.personaNameGroup}>
                      <span>{t('quickMenu.presetPrompts')}</span>
                      <span className={styles.personaTitle}>{t('quickMenu.presetPromptsDesc')}</span>
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
                  disabled={isGeneratingInChat}
                  style={isGeneratingInChat ? { opacity: 0.5 } : undefined}
                >
                  <span className={styles.personaMain}>
                    <MessageSquare size={14} />
                    <span className={styles.personaNameGroup}>
                      <span>{t('quickMenu.oneLiner')}</span>
                      <span className={styles.personaTitle}>{t('quickMenu.oneLinerDesc')}</span>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.popRowBtn}
                  disabled
                  style={{ opacity: 0.4 }}
                  title={t('quickMenu.comingSoon')}
                >
                  <span className={styles.personaMain}>
                    <Crown size={14} />
                    <span className={styles.personaNameGroup}>
                      <span>{t('quickMenu.sovereignHand')}</span>
                      <span className={styles.personaTitle}>{t('quickMenu.sovereignHandDesc')}</span>
                    </span>
                  </span>
                </button>
                {(() => {
                  const hasPreset = !!getActivePresetForGeneration()
                  const dryRunDisabled = dryRunning || !hasPreset || isGeneratingInChat
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
                      title={!hasPreset ? t('quickMenu.noPresetSelected') : undefined}
                    >
                      <span className={styles.personaMain}>
                        <Eye size={14} />
                        <span className={styles.personaNameGroup}>
                          <span>{t('quickMenu.dryRun')}</span>
                          <span className={styles.personaTitle}>
                            {hasPreset ? t('quickMenu.dryRunDesc') : t('quickMenu.dryRunSelectPreset')}
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
                      <span>{t('quickMenu.resolveMacros')}</span>
                      <span className={styles.personaTitle}>{t('quickMenu.resolveMacrosDesc', { mod: queueModLabel })}</span>
                    </span>
                  </span>
                </button>
              </div>
              <InputBarExtensionActions onClose={() => setOpenPopover(null)} />
            </div>
          )}

          {renderPopover === 'altFields' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.quickSetName}>{isGroupChat ? t('quickMenu.groupAlternateFields') : t('quickMenu.alternateFields')}</div>
              {isGroupChat ? (
                <>
                  {groupScenarioMode !== 'individual' && (
                    <div className={styles.popEmpty}>{t('quickMenu.scenarioGroupControlled')}</div>
                  )}
                  {groupMembersWithAltFields.map(({ char, altFields }) => {
                    const memberSelections = groupAltFieldSelections[char.id] || {}
                    const memberSelectionCount = Object.keys(memberSelections).length
                    return (
                      <div
                        key={char.id}
                        className={styles.popRowBtn}
                        style={{
                          alignItems: 'stretch',
                          flexDirection: 'column',
                          cursor: 'default',
                          borderLeft: memberSelectionCount > 0
                            ? '2px solid var(--lumiverse-primary, rgba(140, 130, 255, 0.95))'
                            : '2px solid transparent',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span className={styles.personaAvatar}>
                            {char.avatar_path || char.image_id ? (
                              <img
                                className={styles.personaAvatarImg}
                                src={getCharacterAvatarThumbUrl(char) || undefined}
                                alt={char.name}
                                loading="lazy"
                              />
                            ) : (
                              <span className={styles.personaFallback}>{char.name.slice(0, 1).toUpperCase()}</span>
                            )}
                          </span>
                          <span className={styles.personaNameGroup}>
                            <span>{char.name}</span>
                            {memberSelectionCount > 0 && <span className={styles.personaTitle}>{t('quickMenu.activeCount', { count: memberSelectionCount })}</span>}
                          </span>
                        </div>
                        <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                          {ALT_FIELD_NAMES.map((field) => {
                            const variants = altFields[field]
                            if (!Array.isArray(variants) || variants.length === 0) return null
                            const selectedId = memberSelections[field] || ''
                            const isScenarioDisabled = field === 'scenario' && groupScenarioMode !== 'individual'
                            return (
                              <label key={field} style={{ display: 'grid', gridTemplateColumns: '82px minmax(0, 1fr)', gap: 8, alignItems: 'center' }}>
                                <span style={{ textTransform: 'capitalize', fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))', color: selectedId ? 'var(--lumiverse-primary)' : 'var(--lumiverse-text-dim)' }}>{field}</span>
                                <select
                                  name={`group-alt-${field}`}
                                  aria-label={t('quickMenu.fieldVariantFor', { field, name: char.name })}
                                  style={{
                                    minWidth: 0,
                                    padding: '3px 6px',
                                    fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))',
                                    background: 'var(--lumiverse-fill-hover)',
                                    border: selectedId
                                      ? '1px solid var(--lumiverse-primary, rgba(140, 130, 255, 0.6))'
                                      : '1px solid var(--lumiverse-border)',
                                    borderRadius: 6,
                                    color: 'var(--lumiverse-text)',
                                    outline: 'none',
                                    cursor: isScenarioDisabled ? 'not-allowed' : 'pointer',
                                    opacity: isScenarioDisabled ? 0.55 : 1,
                                  }}
                                  value={selectedId}
                                  disabled={isScenarioDisabled}
                                  title={isScenarioDisabled ? t('quickMenu.scenarioGroupControlled') : undefined}
                                  onChange={(e) => handleGroupAltFieldSelect(char.id, field, e.target.value || null)}
                                >
                                  <option value="">{t('defaultOption')}</option>
                                  {variants.map((v) => (
                                    <option key={v.id} value={v.id}>{v.label}</option>
                                  ))}
                                </select>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    )
                  })}
                  {groupMembersWithAltFields.length === 0 && (
                    <div className={styles.popEmpty}>{t('quickMenu.noGroupAltFields')}</div>
                  )}
                </>
              ) : (
                <>
                  {ALT_FIELD_NAMES.map((field) => {
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
                          name={`alt-${field}`}
                          aria-label={t('quickMenu.fieldVariant', { field })}
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
                          <option value="">{t('defaultOption')}</option>
                          {variants.map((v) => (
                            <option key={v.id} value={v.id}>{v.label}</option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                  {Object.values(altFieldsData).every((arr) => !arr?.length) && (
                    <div className={styles.popEmpty}>{t('quickMenu.noAltFields')}</div>
                  )}
                </>
              )}
            </div>
          )}

          {renderPopover === 'addons' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.addonPopoverHeader}>
                <span>{t('quickMenu.personaAddons')}</span>
                <button
                  type="button"
                  className={styles.addonCreateToggle}
                  onClick={() => setShowCreateAddon((v) => !v)}
                  title={t('quickMenu.createAddonForChat')}
                >
                  <Plus size={12} />
                </button>
              </div>
              {showCreateAddon && (
                <div className={styles.addonCreateForm}>
                  <input
                    type="text"
                    name="addon-name"
                    aria-label={t('quickMenu.addonName')}
                    className={styles.addonCreateInput}
                    value={newAddonLabel}
                    onChange={(e) => setNewAddonLabel(e.target.value)}
                    placeholder={t('quickMenu.addonName')}
                  />
                  <textarea
                    name="addon-content"
                    aria-label={t('quickMenu.addonContent')}
                    className={styles.addonCreateTextarea}
                    value={newAddonContent}
                    onChange={(e) => setNewAddonContent(e.target.value)}
                    placeholder={t('quickMenu.addonContent')}
                    rows={3}
                  />
                  <button
                    type="button"
                    className={styles.popLink}
                    onClick={handleCreateChatAddon}
                    disabled={creatingAddon || (!newAddonLabel.trim() && !newAddonContent.trim())}
                  >
                    {creatingAddon ? t('quickMenu.creating') : t('quickMenu.createForChat')}
                  </button>
                </div>
              )}
              {effectivePersonaAddons.length > 0 && (
                <>
                  {effectivePersonaAddons.map((addon) => (
                    <button
                      key={addon.id}
                      type="button"
                      className={clsx(styles.popRowBtn, addon.enabled && styles.popRowBtnActive)}
                      onClick={() => handleToggleAddonState(addon.id)}
                    >
                      <span className={styles.personaMain}>
                        <IconPlaylistAdd size={13} style={{ opacity: addon.enabled ? 1 : 0.4, color: addon.enabled ? 'var(--lumiverse-primary)' : undefined }} />
                        <span>{addon.label || t('quickMenu.untitledAddon')}</span>
                      </span>
                      <span className={styles.popMeta}>{addon.enabled ? t('on') : t('off')}</span>
                    </button>
                  ))}
                </>
              )}
              {effectiveAttachedGlobalAddons.length > 0 && (
                <>
                  {effectivePersonaAddons.length > 0 && <div className={styles.popDivider} />}
                  <div className={styles.quickSetName}>{t('quickMenu.globalAddons')}</div>
                  {effectiveAttachedGlobalAddons.map((addon) => (
                    <button
                      key={addon.id}
                      type="button"
                      className={clsx(styles.popRowBtn, addon.enabled && styles.popRowBtnActive)}
                      onClick={() => handleToggleAddonState(addon.id)}
                    >
                      <span className={styles.personaMain}>
                        <Globe size={13} style={{ opacity: addon.enabled ? 1 : 0.4, color: addon.enabled ? 'var(--lumiverse-info, #42a5f5)' : undefined }} />
                        <span>{addon.label || t('quickMenu.untitledGlobalAddon')}</span>
                      </span>
                      <span className={styles.popMeta}>{addon.enabled ? t('on') : t('off')}</span>
                    </button>
                  ))}
                </>
              )}
              {!hasAddons && !showCreateAddon && (
                <div className={styles.popEmpty}>{t('quickMenu.noAddons')}</div>
              )}
            </div>
          )}

          {renderPopover === 'databank' && (
            <div className={clsx(styles.popover, popoverClosing && styles.popoverClosing)}>
              <div className={styles.quickSetName}>{t('quickMenu.documents')}</div>
              {databankResults.length === 0 && <div className={styles.popEmpty}>{t('quickMenu.noMatchingDocuments')}</div>}
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
              <div className={styles.quickSetName}>{t('quickMenu.mentionMember')}</div>
              {atResults.length === 0 && <div className={styles.popEmpty}>{t('quickMenu.noMatchingMembers')}</div>}
              {atResults.map((r, i) => {
                const avatarUrl = getCharacterAvatarThumbUrl(r)
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={clsx(styles.popRowBtn, i === atActiveIdx && styles.popRowBtnActive)}
                    style={r.muted ? { opacity: 0.55 } : undefined}
                    onMouseDown={(e) => { e.preventDefault(); handleAtSelect(r) }}
                    onMouseEnter={() => setAtActiveIdx(i)}
                    title={r.muted ? t('quickMenu.mutedMentionOverride', { name: r.name }) : r.name}
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
                        <span className={styles.personaTitle}>@{r.slug}{r.muted ? t('quickMenu.mutedSuffix') : ''}</span>
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
                aria-label={t('input.removeAttachment')}
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
        name="chat-attachment"
        aria-label={t('input.attachFiles')}
        aria-hidden="true"
        tabIndex={-1}
        accept="image/*,audio/*,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.html,.htm,.yaml,.yml,.log,.rst,.rtf"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => handleAttachFiles(e.target.files)}
      />

      {showSTTIndicator ? (
        <button
          type="button"
          className={clsx(
            styles.sttRecordingPanel,
            sttAudioFrame && styles.sttIndicatorReactive,
            sttStatus === 'processing' && styles.sttIndicatorProcessing,
          )}
          style={{
            '--stt-glow-x': `${12 + sttVisualizerLevel * 12}%`,
            '--stt-glow-size': `${10 + sttVisualizerLevel * 24}px`,
          } as CSSProperties}
          onClick={sttStatus === 'processing' ? undefined : handleSTTToggle}
          disabled={sttStatus === 'processing'}
          title={sttStatus === 'processing' ? t('input.processingSpeech') : t('input.stopStt')}
          aria-label={sttStatus === 'processing' ? t('input.processingSpeech') : t('input.stopStt')}
          aria-live="polite"
        >
          <span className={styles.sttRecordingStatus}>
            {sttStatus === 'processing' || sttStatus === 'starting' ? (
              <LoaderCircle size={15} className={styles.sttSpinner} />
            ) : (
              <Mic size={15} />
            )}
            <span>{sttIndicatorLabel}</span>
          </span>
          <span className={styles.sttRecordingWave} aria-hidden="true">
            {sttVisualizerBars.map((bar, index) => {
              const level = Math.max(0.08, Math.min(1, bar))
              return (
                <span
                  key={index}
                  className={styles.sttIndicatorBar}
                  style={{
                    '--stt-bar-height': `${8 + level * 34}px`,
                    '--stt-bar-opacity': 0.45 + level * 0.55,
                    '--stt-bar-saturate': 0.95 + level * 0.75,
                    '--stt-bar-delay': `${index * 34}ms`,
                  } as CSSProperties}
                />
              )
            })}
          </span>
          <span className={styles.sttRecordingHint}>
            {sttStatus === 'processing' ? t('input.transcribing') : t('input.tapToStopTranscribe')}
          </span>
        </button>
      ) : (
        <div className={styles.inputRow}>
          <button
            type="button"
            className={styles.attachBtn}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title={t('input.attachImageOrAudio')}
            aria-label={t('input.attachFile')}
          >
            <Paperclip size={16} />
          </button>

          {voiceSettings.sttShowMicButton && (
            <button
              type="button"
              className={clsx(styles.attachBtn, styles.sttBtn)}
              onClick={handleSTTToggle}
              disabled={!isSTTSupported}
              title={
                !isSTTSupported
                  ? voiceSettings.sttProvider === 'webspeech'
                    ? t('input.speechRecognitionUnavailable')
                    : t('input.audioRecordingUnavailable')
                  : t('input.startStt')
              }
              aria-label={t('input.startStt')}
              aria-pressed={false}
            >
              <Mic size={16} />
            </button>
          )}

          <div className={styles.inputWrapper}>
            <div ref={mirrorRef} className={styles.textareaMirror} aria-hidden="true">
              {mirrorContent}
            </div>
            <textarea
              ref={textareaRef}
              name="chat-message"
              aria-label={t('input.message')}
              className={styles.textarea}
              value={text}
              onChange={handleInput}
              onScroll={handleTextareaScroll}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder={t('input.placeholder')}
              rows={1}
            />
          </div>

          {isGeneratingInChat && !isRoomPeer ? (
            <div className={styles.sendBtnShell}>
              <button
                type="button"
                className={clsx(styles.sendBtn, styles.sendBtnStop)}
                onClick={handleStop}
                title={t('input.stopGeneration')}
                aria-label={t('input.stopGeneration')}
              >
                <Square size={16} />
              </button>
            </div>
          ) : (
            <div className={styles.sendBtnShell}>
              {mobileQueueHint ? (
                <span
                  className={clsx(
                    styles.mobileQueueHint,
                    mobileQueueHoldState === 'holding' && styles.mobileQueueHintHolding,
                    mobileQueueHoldState === 'armed' && styles.mobileQueueHintReady,
                    mobileQueueHoldState === 'queueing' && styles.mobileQueueHintQueueing
                  )}
                  aria-live="polite"
                >
                  {mobileQueueHint}
                </span>
              ) : null}
              <button
                type="button"
                className={clsx(
                  styles.sendBtn,
                  mobileQueueHoldState === 'holding' && styles.sendBtnHoldTracking,
                  mobileQueueHoldState === 'armed' && styles.sendBtnHoldReady,
                  mobileQueueHoldState === 'queueing' && styles.sendBtnQueueing
                )}
                onClick={handleSendClick}
                onTouchStart={handleSendTouchStart}
                onTouchEnd={handleSendTouchEnd}
                onTouchCancel={handleSendTouchCancel}
                disabled={isGeneratingInChat}
                style={sendButtonStyle}
                title={sendButtonTitle}
                aria-label={sendButtonAriaLabel}
              >
                <span className={styles.sendBtnIcon}>
                  {mobileQueueHoldState === 'queueing' ? (
                    <LoaderCircle size={16} className={styles.sendBtnSpinner} />
                  ) : mobileQueueHoldState === 'holding' || mobileQueueHoldState === 'armed' ? (
                    <IconPlaylistAdd size={18} />
                  ) : (
                    <Send size={16} />
                  )}
                </span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

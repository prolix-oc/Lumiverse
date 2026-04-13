import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  dreamWeaverApi,
  normalizeDraftVisualAssets,
  type DreamWeaverDraft,
  type DreamWeaverSession,
} from '../../../api/dream-weaver'
import { charactersApi } from '../../../api/characters'
import { chatsApi } from '../../../api/chats'
import { toast } from '../../../lib/toast'
import { useStore } from '../../../store'
import { getTextSectionStatus } from '../lib/studio-model'

export type TabId = 'soul' | 'world' | 'visuals'
export type SectionStatus = 'empty' | 'populated' | 'attention'

interface StudioState {
  session: DreamWeaverSession | null
  draft: DreamWeaverDraft | null
  activeTab: TabId
  dreamPanelOpen: boolean
  dirty: boolean
  loading: boolean
  saving: boolean
  generating: boolean
  generatingWorld: boolean
  finalizing: boolean
  errorMessage: string | null
}

interface StudioActions {
  setActiveTab: (tab: TabId) => void
  toggleDreamPanel: (next?: boolean) => void
  updateSessionField: <K extends keyof Pick<
    DreamWeaverSession,
    'dream_text' | 'tone' | 'constraints' | 'dislikes' | 'persona_id' | 'connection_id'
  >>(
    field: K,
    value: DreamWeaverSession[K],
  ) => void
  updateDraftCard: (patch: Partial<DreamWeaverDraft['card']>) => void
  updateDraftField: <K extends keyof DreamWeaverDraft>(
    field: K,
    value: DreamWeaverDraft[K],
  ) => void
  save: () => Promise<void>
  generateSoul: () => Promise<void>
  generateWorld: () => Promise<void>
  finalize: () => Promise<void>
  openChat: () => Promise<void>
  requestClose: () => boolean
  dismissError: () => void
  getSectionStatus: (section: string) => SectionStatus
}

function parseStoredDraft(rawDraft: string | null): DreamWeaverDraft | null {
  if (!rawDraft) return null

  try {
    return JSON.parse(rawDraft) as DreamWeaverDraft
  } catch {
    return null
  }
}

export function useDreamWeaverStudio(
  sessionId: string,
): StudioState & StudioActions {
  const navigate = useNavigate()
  const closeModal = useStore((s) => s.closeModal)
  const addCharacter = useStore((s) => s.addCharacter)

  const [session, setSession] = useState<DreamWeaverSession | null>(null)
  const [draft, setDraft] = useState<DreamWeaverDraft | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('soul')
  const [dreamPanelOpen, setDreamPanelOpen] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [generatingWorld, setGeneratingWorld] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const sessionRef = useRef(session)
  const draftRef = useRef(draft)
  const dirtyRef = useRef(dirty)

  sessionRef.current = session
  draftRef.current = draft
  dirtyRef.current = dirty

  useEffect(() => {
    let cancelled = false

    setLoading(true)
    setErrorMessage(null)

    dreamWeaverApi.getSession(sessionId)
      .then((nextSession) => {
        if (cancelled) return

        setSession(nextSession)
        setDraft(parseStoredDraft(nextSession.draft))
        setDirty(false)
      })
      .catch((err: any) => {
        if (cancelled) return
        setErrorMessage(err?.message ?? 'Failed to load Dream Weaver session')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [sessionId])

  const updateSessionField = useCallback(
    <K extends keyof Pick<
      DreamWeaverSession,
      'dream_text' | 'tone' | 'constraints' | 'dislikes' | 'persona_id' | 'connection_id'
    >>(
      field: K,
      value: DreamWeaverSession[K],
    ) => {
      setSession((current) => (current ? { ...current, [field]: value } : current))
      setDirty(true)
    },
    [],
  )

  const updateDraftCard = useCallback((patch: Partial<DreamWeaverDraft['card']>) => {
    setDraft((current) => (current ? { ...current, card: { ...current.card, ...patch } } : current))
    setDirty(true)
  }, [])

  const updateDraftField = useCallback(
    <K extends keyof DreamWeaverDraft>(field: K, value: DreamWeaverDraft[K]) => {
      setDraft((current) => (current ? { ...current, [field]: value } : current))
      setDirty(true)
    },
    [],
  )

  const save = useCallback(async () => {
    const currentSession = sessionRef.current
    if (!currentSession) return

    setSaving(true)
    setErrorMessage(null)
    try {
      const updated = await dreamWeaverApi.updateSession(currentSession.id, {
        dream_text: currentSession.dream_text,
        tone: currentSession.tone,
        constraints: currentSession.constraints,
        dislikes: currentSession.dislikes,
        persona_id: currentSession.persona_id,
        connection_id: currentSession.connection_id,
        draft: draftRef.current,
      })

      setSession(updated)
      if (currentSession.character_id) {
        try {
          const character = await charactersApi.get(currentSession.character_id)
          addCharacter(character)
        } catch {
        }
      }
      setDirty(false)
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Failed to save session')
      throw err
    } finally {
      setSaving(false)
    }
  }, [])

  const generateSoul = useCallback(async () => {
    const currentSession = sessionRef.current
    if (!currentSession) return

    setGenerating(true)
    setErrorMessage(null)
    try {
      if (dirtyRef.current) await save()

      const result = await dreamWeaverApi.generateDraft(currentSession.id)
      setSession(result.session)
      setDraft(result.draft)
      setDirty(false)
      setActiveTab('soul')
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }, [save])

  const generateWorld = useCallback(async () => {
    const currentSession = sessionRef.current
    if (!currentSession) return

    setGeneratingWorld(true)
    setErrorMessage(null)
    try {
      if (dirtyRef.current) await save()

      const result = await dreamWeaverApi.generateWorld(currentSession.id)
      setSession(result.session)
      setDraft(result.draft)
      setDirty(false)
      setActiveTab('world')
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'World generation failed')
    } finally {
      setGeneratingWorld(false)
    }
  }, [save])

  const hydrateCharacter = useCallback(async (characterId: string) => {
    try {
      const character = await charactersApi.get(characterId)
      addCharacter(character)
    } catch {
    }
  }, [addCharacter])

  const navigateToChat = useCallback((chatId: string) => {
    closeModal()
    navigate(`/chat/${chatId}`)
  }, [closeModal, navigate])

  const finalize = useCallback(async () => {
    const currentSession = sessionRef.current
    if (!currentSession) return

    setFinalizing(true)
    setErrorMessage(null)
    try {
      if (dirtyRef.current) await save()

      const result = await dreamWeaverApi.finalize(currentSession.id)
      setSession(result.session)
      await hydrateCharacter(result.characterId)
      setDirty(false)

      toast.success(
        result.alreadyFinalized
          ? 'Character already created from Dream Weaver'
          : 'Character created from Dream Weaver',
        { title: 'Dream Weaver' },
      )

      if (result.chatId) {
        navigateToChat(result.chatId)
      }
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Finalization failed')
    } finally {
      setFinalizing(false)
    }
  }, [hydrateCharacter, navigateToChat, save])

  const openChat = useCallback(async () => {
    const currentSession = sessionRef.current
    const characterId = currentSession?.character_id
    if (!currentSession || !characterId) return

    setFinalizing(true)
    setErrorMessage(null)
    try {
      if (dirtyRef.current) await save()

      if (currentSession.launch_chat_id) {
        try {
          await chatsApi.get(currentSession.launch_chat_id, { messages: false })
          navigateToChat(currentSession.launch_chat_id)
          return
        } catch {
          // Fall through to backend recovery if the chat was deleted.
        }
      }

      const result = await dreamWeaverApi.finalize(currentSession.id)
      setSession(result.session)
      await hydrateCharacter(result.characterId)
      setDirty(false)

      if (result.chatId) {
        navigateToChat(result.chatId)
        return
      }

      const fallbackChat = await chatsApi.create({ character_id: characterId })
      navigateToChat(fallbackChat.id)
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Failed to open chat')
    } finally {
      setFinalizing(false)
    }
  }, [hydrateCharacter, navigateToChat, save])

  const getSectionStatus = useCallback((section: string): SectionStatus => {
    if (!draftRef.current) return 'empty'

    const currentDraft = draftRef.current

    switch (section) {
      case 'name':
        return getTextSectionStatus(currentDraft.card.name)
      case 'appearance':
        return getTextSectionStatus(currentDraft.card.appearance)
      case 'description':
        return getTextSectionStatus(currentDraft.card.description)
      case 'personality':
        return getTextSectionStatus(currentDraft.card.personality)
      case 'scenario':
        return getTextSectionStatus(currentDraft.card.scenario)
      case 'first_mes':
        return getTextSectionStatus(currentDraft.card.first_mes)
      case 'system_prompt':
        return getTextSectionStatus(currentDraft.card.system_prompt)
      case 'post_history_instructions':
        return getTextSectionStatus(currentDraft.card.post_history_instructions)
      case 'voice_guidance':
        return currentDraft.voice_guidance.compiled.trim() ||
          Object.values(currentDraft.voice_guidance.rules).some((items) => items.length > 0)
          ? 'populated'
          : 'empty'
      case 'alternate_fields':
        return Object.values(currentDraft.alternate_fields).some((items) => items.length > 0)
          ? 'populated'
          : 'empty'
      case 'greetings':
        return currentDraft.greetings.length > 0 ? 'populated' : 'empty'
      case 'lorebooks':
        return currentDraft.lorebooks.length > 0 ? 'populated' : 'empty'
      case 'npc_definitions':
        return currentDraft.npc_definitions.length > 0 ? 'populated' : 'empty'
      case 'regex_scripts':
        return currentDraft.regex_scripts.length > 0 ? 'populated' : 'empty'
      case 'package_health':
      case 'visuals_locked': {
        const visualAssets = normalizeDraftVisualAssets(currentDraft)
        const hasPortrait = visualAssets.some((asset) =>
          asset.references.some((reference) => Boolean(reference.image_id || reference.image_url)),
        )
        const hasVisualSetup = visualAssets.some((asset) =>
          Boolean(asset.prompt.trim() || asset.provider || asset.references.length > 0),
        )

        if (hasPortrait) return 'populated'
        return hasVisualSetup ? 'attention' : 'empty'
      }
      default:
        return 'empty'
    }
  }, [])

  const requestClose = useCallback(() => !dirtyRef.current, [])
  const dismissError = useCallback(() => setErrorMessage(null), [])
  const toggleDreamPanel = useCallback((next?: boolean) => {
    setDreamPanelOpen((previous) => (typeof next === 'boolean' ? next : !previous))
  }, [])

  return useMemo(() => ({
    session,
    draft,
    activeTab,
    dreamPanelOpen,
    dirty,
    loading,
    saving,
    generating,
    generatingWorld,
    finalizing,
    errorMessage,
    setActiveTab,
    toggleDreamPanel,
    updateSessionField,
    updateDraftCard,
    updateDraftField,
    save,
    generateSoul,
    generateWorld,
    finalize,
    openChat,
    requestClose,
    dismissError,
    getSectionStatus,
  }), [
    session,
    draft,
    activeTab,
    dreamPanelOpen,
    dirty,
    loading,
    saving,
    generating,
    generatingWorld,
    finalizing,
    errorMessage,
    updateSessionField,
    updateDraftCard,
    updateDraftField,
    save,
    generateSoul,
    generateWorld,
    finalize,
    openChat,
    requestClose,
    dismissError,
    getSectionStatus,
    toggleDreamPanel,
  ])
}

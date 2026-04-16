import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  dreamWeaverApi,
  normalizeDraftVisualAssets,
  normalizeDreamWeaverDraft,
  syncDraftVisualAssets,
  type DreamWeaverDraft,
  type DreamWeaverSession,
  type ExtendTarget,
} from '../../../api/dream-weaver'
import { charactersApi } from '../../../api/characters'
import { chatsApi } from '../../../api/chats'
import { settingsApi } from '../../../api/settings'
import { toast } from '../../../lib/toast'
import { useStore } from '../../../store'
import { EventType } from '../../../types/ws-events'
import { wsClient } from '../../../ws/client'
import { getTextSectionStatus } from '../lib/studio-model'

export type TabId = 'soul' | 'world' | 'visuals'
export type SectionStatus = 'empty' | 'populated' | 'attention'

export interface ProgressState {
  operation: 'soul' | 'world' | 'finalize'
  step: string
  stepIndex: number
  totalSteps: number
  message: string
}

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
  progress: ProgressState | null
  extending: Record<string, boolean>
  syncingWorld: boolean
  worldSynced: boolean
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
  syncWorld: () => Promise<void>
  requestClose: () => boolean
  dismissError: () => void
  getSectionStatus: (section: string) => SectionStatus
  extendField: (target: ExtendTarget, instruction?: string, bookId?: string) => Promise<void>
}

function parseStoredDraft(rawDraft: string | null): DreamWeaverDraft | null {
  if (!rawDraft) return null

  try {
    return normalizeDreamWeaverDraft(JSON.parse(rawDraft) as DreamWeaverDraft)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Step animation queue
// ---------------------------------------------------------------------------
// Ensures each progress step is visible for at least MIN_STEP_MS before
// advancing to the next. When an operation completes, the queue fast-forwards
// through remaining steps and holds the final "completed" state briefly.
// ---------------------------------------------------------------------------

const MIN_STEP_MS = 600
const COMPLETE_DELAY_MS = 800

interface StepQueue {
  operation: string
  targetStep: number
  displayedStep: number
  totalSteps: number
  lastAdvanceTime: number
  done: boolean
  timer: ReturnType<typeof setTimeout> | undefined
  onDone: (() => void) | null
}

function createStepQueue(): StepQueue {
  return {
    operation: '',
    targetStep: -1,
    displayedStep: -1,
    totalSteps: 0,
    lastAdvanceTime: 0,
    done: false,
    timer: undefined,
    onDone: null,
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
  const [progress, setProgress] = useState<ProgressState | null>(null)
  const [extending, setExtending] = useState<Record<string, boolean>>({})
  const [syncingWorld, setSyncingWorld] = useState(false)
  const [worldSynced, setWorldSynced] = useState(false)

  const sessionRef = useRef(session)
  const draftRef = useRef(draft)
  const dirtyRef = useRef(dirty)

  sessionRef.current = session
  draftRef.current = draft
  dirtyRef.current = dirty

  // -----------------------------------------------------------------------
  // Step animation queue internals
  // -----------------------------------------------------------------------
  const queueRef = useRef<StepQueue>(createStepQueue())

  const advanceDisplayedStep = useCallback(() => {
    const q = queueRef.current
    q.timer = undefined

    if (q.displayedStep >= q.targetStep) {
      // Caught up to target — if the operation is done, wait then cleanup
      if (q.done && q.displayedStep >= q.totalSteps - 1) {
        q.timer = setTimeout(() => {
          q.timer = undefined
          const cb = q.onDone
          Object.assign(q, createStepQueue())
          setProgress(null)
          cb?.()
        }, COMPLETE_DELAY_MS)
      }
      return
    }

    // Advance one step
    const nextStep = q.displayedStep + 1
    q.displayedStep = nextStep
    q.lastAdvanceTime = Date.now()

    setProgress((prev) => (prev ? { ...prev, stepIndex: nextStep } : prev))

    // Schedule the next advance if we haven't caught up yet
    if (nextStep < q.targetStep) {
      q.timer = setTimeout(advanceDisplayedStep, MIN_STEP_MS)
    } else if (q.done && nextStep >= q.totalSteps - 1) {
      // Reached final step and operation is done
      q.timer = setTimeout(() => {
        q.timer = undefined
        const cb = q.onDone
        Object.assign(q, createStepQueue())
        setProgress(null)
        cb?.()
      }, COMPLETE_DELAY_MS)
    }
  }, [])

  /** Feed a WS progress event into the animation queue. */
  const pushProgressStep = useCallback(
    (p: ProgressState) => {
      const q = queueRef.current

      // New operation or first event — show immediately
      if (q.operation !== p.operation) {
        if (q.timer) clearTimeout(q.timer)
        q.operation = p.operation
        q.targetStep = p.stepIndex
        q.displayedStep = p.stepIndex
        q.totalSteps = p.totalSteps
        q.lastAdvanceTime = Date.now()
        q.done = false
        q.onDone = null
        q.timer = undefined
        setProgress(p)
        return
      }

      // Same operation — update target and total
      q.totalSteps = p.totalSteps
      if (p.stepIndex <= q.targetStep) return
      q.targetStep = p.stepIndex

      // Schedule an advance if one isn't already pending
      if (!q.timer) {
        const elapsed = Date.now() - q.lastAdvanceTime
        const delay = Math.max(0, MIN_STEP_MS - elapsed)
        q.timer = setTimeout(advanceDisplayedStep, delay)
      }
    },
    [advanceDisplayedStep],
  )

  /** Mark the operation as complete. The queue will fast-forward to the final
   *  step, hold briefly, then call `onDone`. */
  const completeProgressAnimation = useCallback(
    (onDone: () => void) => {
      const q = queueRef.current
      if (!q.operation) {
        onDone()
        return
      }

      q.done = true
      q.onDone = onDone
      q.targetStep = q.totalSteps - 1

      if (!q.timer) {
        const elapsed = Date.now() - q.lastAdvanceTime
        const delay = Math.max(0, MIN_STEP_MS - elapsed)
        q.timer = setTimeout(advanceDisplayedStep, delay)
      }
    },
    [advanceDisplayedStep],
  )

  /** Hard-reset the queue (e.g. on error). */
  const resetProgress = useCallback(() => {
    const q = queueRef.current
    if (q.timer) clearTimeout(q.timer)
    Object.assign(q, createStepQueue())
    setProgress(null)
  }, [])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (queueRef.current.timer) clearTimeout(queueRef.current.timer)
    }
  }, [])

  // -----------------------------------------------------------------------
  // Session loading
  // -----------------------------------------------------------------------
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
        if (nextSession.soul_state === 'generating') setGenerating(true)
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

  const refreshSession = useCallback(async () => {
    const nextSession = await dreamWeaverApi.getSession(sessionId)
    setSession(nextSession)
    setDraft(parseStoredDraft(nextSession.draft))
    return nextSession
  }, [sessionId])

  // -----------------------------------------------------------------------
  // WebSocket event handlers
  // -----------------------------------------------------------------------
  useEffect(() => {
    const handleGenerating = (payload: { sessionId?: string; operation?: string }) => {
      if (payload?.sessionId !== sessionId) return
      const op = payload.operation
      if (op === 'world') {
        setGeneratingWorld(true)
      } else if (op === 'finalize') {
        setFinalizing(true)
      } else {
        setGenerating(true)
      }
      void refreshSession()
    }

    const handleComplete = (payload: { sessionId?: string; operation?: string }) => {
      if (payload?.sessionId !== sessionId) return
      void refreshSession().then(() => {
        setDirty(false)
        const op = payload.operation
        if (op === 'world') {
          completeProgressAnimation(() => {
            setGeneratingWorld(false)
            setWorldSynced(false)
            setActiveTab('world')
          })
        } else if (op === 'finalize') {
          // Finalize completion is handled by the finalize/openChat callbacks
          // (they await the HTTP response which carries characterId/chatId).
          // This handler is a safety net for cases where only WS events arrive.
          completeProgressAnimation(() => {
            setFinalizing(false)
          })
        } else {
          completeProgressAnimation(() => {
            setGenerating(false)
            setActiveTab('soul')
          })
        }
      })
    }

    const handleError = (payload: { sessionId?: string; operation?: string; error?: string }) => {
      if (payload?.sessionId !== sessionId) return
      void refreshSession().finally(() => {
        const op = payload.operation
        if (op === 'world') {
          setGeneratingWorld(false)
        } else if (op === 'finalize') {
          setFinalizing(false)
        } else {
          setGenerating(false)
        }
        resetProgress()
        setErrorMessage(payload?.error ?? 'Generation failed')
      })
    }

    const handleProgress = (payload: {
      sessionId?: string
      operation?: string
      step?: string
      stepIndex?: number
      totalSteps?: number
      message?: string
    }) => {
      if (payload?.sessionId !== sessionId) return
      pushProgressStep({
        operation: payload.operation as ProgressState['operation'],
        step: payload.step ?? '',
        stepIndex: payload.stepIndex ?? 0,
        totalSteps: payload.totalSteps ?? 0,
        message: payload.message ?? '',
      })
    }

    const unsubs = [
      wsClient.on(EventType.DREAM_WEAVER_GENERATING, handleGenerating),
      wsClient.on(EventType.DREAM_WEAVER_COMPLETE, handleComplete),
      wsClient.on(EventType.DREAM_WEAVER_ERROR, handleError),
      wsClient.on(EventType.DREAM_WEAVER_PROGRESS, handleProgress),
    ]

    return () => {
      unsubs.forEach((unsub) => unsub())
    }
  }, [refreshSession, sessionId, pushProgressStep, completeProgressAnimation, resetProgress])

  // -----------------------------------------------------------------------
  // Draft / session mutation helpers
  // -----------------------------------------------------------------------
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
      setDraft((current) => {
        if (!current) return current
        const next = { ...current, [field]: value }
        // Keep image_assets in sync with visual_assets so stale legacy data
        // cannot clobber prompts when the draft is reloaded.
        return field === 'visual_assets' ? syncDraftVisualAssets(next) as DreamWeaverDraft : next
      })
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

  // -----------------------------------------------------------------------
  // Generation actions
  // -----------------------------------------------------------------------
  const generateSoul = useCallback(async () => {
    const currentSession = sessionRef.current
    if (!currentSession) return

    setGenerating(true)
    setErrorMessage(null)

    // Seed the animation queue so step 0 is visible immediately
    pushProgressStep({
      operation: 'soul',
      step: 'reading_dream',
      stepIndex: 0,
      totalSteps: 3,
      message: 'Reading dream',
    })

    try {
      if (dirtyRef.current) await save()

      const nextSession = await dreamWeaverApi.generateDraft(currentSession.id)
      setSession(nextSession)
      setActiveTab('soul')
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Generation failed')
      setGenerating(false)
      resetProgress()
    }
  }, [save, pushProgressStep, resetProgress])

  const generateWorld = useCallback(async () => {
    const currentSession = sessionRef.current
    if (!currentSession) return

    setGeneratingWorld(true)
    setErrorMessage(null)

    // Seed the animation queue so step 0 is visible immediately
    pushProgressStep({
      operation: 'world',
      step: 'preparing',
      stepIndex: 0,
      totalSteps: 4,
      message: 'Preparing world',
    })

    try {
      if (dirtyRef.current) await save()

      // Fire-and-forget: backend returns immediately, progress via WS events
      await dreamWeaverApi.generateWorld(currentSession.id)
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'World generation failed')
      setGeneratingWorld(false)
      resetProgress()
    }
  }, [save, pushProgressStep, resetProgress])

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

    // Seed the animation queue so finalize steps are visible
    pushProgressStep({
      operation: 'finalize',
      step: 'persisting_portrait',
      stepIndex: 0,
      totalSteps: 4,
      message: 'Saving portrait',
    })

    try {
      if (dirtyRef.current) await save()

      const result = await dreamWeaverApi.finalize(currentSession.id)
      setSession(result.session)
      await hydrateCharacter(result.characterId)
      setDirty(false)

      // Let the step animation play through before navigating
      completeProgressAnimation(() => {
        setFinalizing(false)

        toast.success(
          result.alreadyFinalized
            ? 'Character already created from Dream Weaver'
            : 'Character created from Dream Weaver',
          { title: 'Dream Weaver' },
        )

        if (result.chatId) {
          navigateToChat(result.chatId)
        }
      })
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Finalization failed')
      setFinalizing(false)
      resetProgress()
    }
  }, [hydrateCharacter, navigateToChat, save, pushProgressStep, completeProgressAnimation, resetProgress])

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
          setFinalizing(false)
          navigateToChat(currentSession.launch_chat_id)
          return
        } catch {
          // Fall through to backend recovery if the chat was deleted.
        }
      }

      // Seed the animation queue for finalize
      pushProgressStep({
        operation: 'finalize',
        step: 'persisting_portrait',
        stepIndex: 0,
        totalSteps: 4,
        message: 'Saving portrait',
      })

      const result = await dreamWeaverApi.finalize(currentSession.id)
      setSession(result.session)
      await hydrateCharacter(result.characterId)
      setDirty(false)

      completeProgressAnimation(() => {
        setFinalizing(false)

        if (result.chatId) {
          navigateToChat(result.chatId)
          return
        }

        // Fallback: create a chat directly
        chatsApi.create({ character_id: characterId }).then((chat) => {
          navigateToChat(chat.id)
        }).catch(() => {
          setErrorMessage('Failed to create chat')
        })
      })
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Failed to open chat')
      setFinalizing(false)
      resetProgress()
    }
  }, [hydrateCharacter, navigateToChat, save, pushProgressStep, completeProgressAnimation, resetProgress])

  // -----------------------------------------------------------------------
  // Extend (additive generation)
  // -----------------------------------------------------------------------
  const extendField = useCallback(async (target: ExtendTarget, instruction?: string, bookId?: string) => {
    const currentSession = sessionRef.current
    if (!currentSession || !draftRef.current) return

    // Use bookId as the extending key for per-book generation so each book has independent loading state
    const extendingKey = bookId ? `lorebook_entries:${bookId}` : target
    setExtending((prev) => ({ ...prev, [extendingKey]: true }))
    setErrorMessage(null)
    try {
      if (dirtyRef.current) await save()

      // Read the user's Dream Weaver timeout so the browser doesn't abort
      // before the backend's user-controlled timeout fires. Backend honors
      // the same setting via createDWTimeout().
      let timeoutMs: number | null | undefined
      try {
        const row = await settingsApi.get('dreamWeaverGenParams')
        const value = row?.value as { timeoutMs?: number | null } | null | undefined
        timeoutMs = value?.timeoutMs
      } catch {}

      const result = await dreamWeaverApi.extend(
        currentSession.id,
        { target, instruction, bookId },
        { timeoutMs },
      )

      setDraft((current) => {
        if (!current) return current

        switch (target) {
          case 'greetings':
            return { ...current, greetings: [...current.greetings, ...result.items] }
          case 'alternate_fields.description':
          case 'alternate_fields.personality':
          case 'alternate_fields.scenario': {
            const fieldType = target.split('.')[1] as keyof typeof current.alternate_fields
            return {
              ...current,
              alternate_fields: {
                ...current.alternate_fields,
                [fieldType]: [...current.alternate_fields[fieldType], ...result.items],
              },
            }
          }
          case 'lorebook_entries':
            if (result.bookId) {
              // Per-book mode: merge new entries into the specific book
              return {
                ...current,
                lorebooks: current.lorebooks.map((book: any) =>
                  book.id === result.bookId
                    ? { ...book, entries: [...(book.entries ?? []), ...result.items] }
                    : book,
                ),
              }
            }
            // Whole-book mode: append new lorebook objects
            return { ...current, lorebooks: [...current.lorebooks, ...result.items] }
          case 'npc_definitions':
            return { ...current, npc_definitions: [...current.npc_definitions, ...result.items] }
          default:
            return current
        }
      })
      setDirty(true)
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Generation failed')
    } finally {
      setExtending((prev) => ({ ...prev, [extendingKey]: false }))
    }
  }, [save])

  // -----------------------------------------------------------------------
  // Section status helper
  // -----------------------------------------------------------------------
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

  const syncWorld = useCallback(async () => {
    const currentSession = sessionRef.current
    if (!currentSession?.character_id) return

    setSyncingWorld(true)
    setErrorMessage(null)
    try {
      if (dirtyRef.current) await save()

      const result = await dreamWeaverApi.syncWorld(currentSession.id)
      const bookCount = result.worldBookIds.length
      const scriptCount = result.regexScriptsCreated
      const parts: string[] = []
      if (bookCount > 0) parts.push(`${bookCount} world book${bookCount > 1 ? 's' : ''}`)
      if (scriptCount > 0) parts.push(`${scriptCount} regex script${scriptCount > 1 ? 's' : ''}`)

      const message = parts.length > 0
        ? `Synced ${parts.join(' and ')} to character`
        : 'World content is already in sync'
      toast.success(message)
      setWorldSynced(true)
    } catch (err: any) {
      setErrorMessage(err?.message ?? 'Failed to sync world content')
    } finally {
      setSyncingWorld(false)
    }
  }, [save])

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
    progress,
    extending,
    syncingWorld,
    worldSynced,
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
    syncWorld,
    requestClose,
    dismissError,
    getSectionStatus,
    extendField,
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
    progress,
    extending,
    syncingWorld,
    worldSynced,
    updateSessionField,
    updateDraftCard,
    updateDraftField,
    save,
    generateSoul,
    generateWorld,
    finalize,
    openChat,
    syncWorld,
    requestClose,
    dismissError,
    getSectionStatus,
    toggleDreamPanel,
    extendField,
  ])
}

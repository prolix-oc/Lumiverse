import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '@/store'
import {
  generateSummary,
  saveSummary,
  clearSummary,
  getSummary,
} from '@/lib/summary/service'
import { generateApi } from '@/api/generate'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import type { SummarizationProgressPayload } from '@/types/ws-events'

export function useSummary() {
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const personas = useStore((s) => s.personas)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const profiles = useStore((s) => s.profiles)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const summarization = useStore((s) => s.summarization)
  const setSummarization = useStore((s) => s.setSummarization)
  const isSummarizing = useStore((s) => s.isSummarizing)
  const setIsSummarizing = useStore((s) => s.setIsSummarizing)
  const lastSummaryMutation = useStore((s) => s.lastSummaryMutation)

  const [summaryText, setSummaryText] = useState('')
  const [originalText, setOriginalText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Derived values
  const hasChat = !!activeChatId
  const hasChanges = summaryText !== originalText

  const character = characters.find((c) => c.id === activeCharacterId)
  const characterName = character?.name || 'Character'
  const activePersona = personas.find((p) => p.id === activePersonaId)
  const userName = activePersona?.name || 'User'

  // Resolve connection ID for summary generation
  // 'sidecar' mode omits the ID so the backend resolves via sidecar settings
  const resolveConnectionId = useCallback((): string | undefined => {
    if (summarization.apiSource === 'sidecar') return undefined
    if (summarization.apiSource === 'dedicated' && summarization.dedicatedConnectionId) {
      return summarization.dedicatedConnectionId
    }
    return activeProfileId || undefined
  }, [summarization.apiSource, summarization.dedicatedConnectionId, activeProfileId])

  // Load summary from chat metadata
  const loadSummary = useCallback(async () => {
    if (!activeChatId) {
      setSummaryText('')
      setOriginalText('')
      return
    }
    try {
      const text = await getSummary(activeChatId)
      setSummaryText(text)
      setOriginalText(text)
    } catch (err) {
      console.error('[useSummary] Failed to load summary:', err)
    }
  }, [activeChatId])

  // Load on chat change
  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  useEffect(() => {
    if (!activeChatId) return
    if (!lastSummaryMutation || lastSummaryMutation.chatId !== activeChatId) return
    setSummaryText(lastSummaryMutation.summaryText)
    setOriginalText(lastSummaryMutation.summaryText)
  }, [activeChatId, lastSummaryMutation])

  // Generate summary
  const generate = useCallback(async (isManual = true) => {
    if (!activeChatId || isSummarizing) return null
    setIsSummarizing(true)
    setIsLoading(true)
    setError(null)
    useStore.getState().setActiveSummaryOperation('generating')

    try {
      const messageContext = isManual
        ? summarization.manualMessageContext
        : summarization.autoMessageContext

      const result = await generateSummary({
        chatId: activeChatId,
        connectionId: resolveConnectionId(),
        messageContext,
        userName,
        characterName,
        systemPromptOverride: summarization.systemPromptOverride,
        userPromptOverride: summarization.userPromptOverride,
        requestTimeoutMs: summarization.requestTimeoutMs,
      })

      if (result) {
        setSummaryText(result)
        setOriginalText(result)
      }
      return result
    } catch (err: any) {
      const msg = err.message || 'Summary generation failed'
      setError(msg)
      throw err
    } finally {
      setIsLoading(false)
      setIsSummarizing(false)
      useStore.getState().setActiveSummaryOperation(null)
    }
  }, [activeChatId, isSummarizing, summarization, resolveConnectionId, userName, characterName, setIsSummarizing])

  // Save edited summary
  const save = useCallback(async () => {
    if (!activeChatId) return
    try {
      await saveSummary(activeChatId, summaryText)
      setOriginalText(summaryText.trim())
    } catch (err: any) {
      setError(err.message)
    }
  }, [activeChatId, summaryText])

  // Clear summary
  const clear = useCallback(async () => {
    if (!activeChatId) return
    try {
      await clearSummary(activeChatId)
      setSummaryText('')
      setOriginalText('')
    } catch (err: any) {
      setError(err.message)
    }
  }, [activeChatId])

  // Rebuild summary from scratch (processes all messages in batches)
  const rebuild = useCallback(async () => {
    if (!activeChatId || isSummarizing) return null

    const batchSize = summarization.manualMessageContext
    const connectionId = resolveConnectionId()

    // Register in-progress state
    setIsSummarizing(true)
    setIsLoading(true)
    setError(null)
    useStore.getState().setActiveSummaryOperation('rebuilding')
    useStore.getState().setRebuildProgress({ batchNumber: 0, totalBatches: 0 })

    // Set up WS listener for progress events
    const progressListener = (payload: SummarizationProgressPayload) => {
      if (payload.chatId === activeChatId) {
        useStore.getState().setRebuildProgress({
          batchNumber: payload.batchNumber,
          totalBatches: payload.totalBatches,
        })
      }
    }

    const completionListener = (payload: { chatId: string; generationId: string; summaryText?: string }) => {
      if (payload.chatId === activeChatId) {
        unsubProgress()
        unsubComplete()
        unsubFail()
        useStore.getState().setRebuildProgress(null)
        useStore.getState().setActiveSummaryOperation(null)
        setIsSummarizing(false)
        setIsLoading(false)
        loadSummary()
      }
    }

    const failureListener = (payload: { chatId: string; generationId: string; error: string }) => {
      if (payload.chatId === activeChatId) {
        unsubProgress()
        unsubComplete()
        unsubFail()
        setError(payload.error || 'Summary rebuild failed')
        useStore.getState().setRebuildProgress(null)
        useStore.getState().setActiveSummaryOperation(null)
        setIsSummarizing(false)
        setIsLoading(false)
      }
    }

    const unsubProgress = wsClient.on(EventType.SUMMARIZATION_PROGRESS, progressListener)
    const unsubComplete = wsClient.on(EventType.SUMMARIZATION_COMPLETED, completionListener)
    const unsubFail = wsClient.on(EventType.SUMMARIZATION_FAILED, failureListener)

    try {
      const result = await generateApi.rebuildSummary(activeChatId, batchSize, userName, {
        connection_id: connectionId,
        system_prompt_override: summarization.systemPromptOverride,
        user_prompt_override: summarization.userPromptOverride,
      })
      // Store total batches for immediate progress display
      useStore.getState().setRebuildProgress({
        batchNumber: 0,
        totalBatches: result.totalBatches,
      })
    } catch (err: any) {
      // API call failed (e.g. validation error) — clean up listeners
      unsubProgress()
      unsubComplete()
      unsubFail()
      setError(err.message || 'Summary rebuild failed')
      useStore.getState().setRebuildProgress(null)
      useStore.getState().setActiveSummaryOperation(null)
      setIsSummarizing(false)
      setIsLoading(false)
    }

    return null
  }, [activeChatId, isSummarizing, summarization, resolveConnectionId, userName, setIsSummarizing, loadSummary])

  return {
    // State
    summaryText,
    originalText,
    hasChat,
    hasChanges,
    isLoading,
    isSummarizing,
    error,
    // Settings
    summarization,
    setSummarization,
    // Connection
    profiles,
    activeProfileId,
    // Rebuild
    rebuildProgress: useStore((s) => s.rebuildProgress),
    // Actions
    setSummaryText,
    generate,
    save,
    clear,
    rebuild,
    loadSummary,
    activeChatId,
  }
}

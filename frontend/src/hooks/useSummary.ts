import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '@/store'
import {
  generateSummary,
  saveSummary,
  clearSummary,
  getSummary,
  getLastSummarizedInfo,
  shouldAutoSummarize,
} from '@/lib/summary/service'

export function useSummary() {
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const personas = useStore((s) => s.personas)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const profiles = useStore((s) => s.profiles)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const messages = useStore((s) => s.messages)
  const summarization = useStore((s) => s.summarization)
  const setSummarization = useStore((s) => s.setSummarization)
  const isSummarizing = useStore((s) => s.isSummarizing)
  const setIsSummarizing = useStore((s) => s.setIsSummarizing)

  const [summaryText, setSummaryText] = useState('')
  const [originalText, setOriginalText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const autoCheckRef = useRef(false)

  // Derived values
  const hasChat = !!activeChatId
  const hasChanges = summaryText !== originalText

  const character = characters.find((c) => c.id === activeCharacterId)
  const characterName = character?.name || 'Character'
  const activePersona = personas.find((p) => p.id === activePersonaId)
  const userName = activePersona?.name || 'User'

  // Resolve connection ID for summary generation
  const resolveConnectionId = useCallback((): string | undefined => {
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

  // Generate summary
  const generate = useCallback(async (isManual = true) => {
    if (!activeChatId || isSummarizing) return null
    setIsSummarizing(true)
    setIsLoading(true)
    setError(null)

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

  // Auto-summarization check on message count changes
  useEffect(() => {
    if (summarization.mode !== 'auto' || !activeChatId || isSummarizing) return
    if (autoCheckRef.current) return // Prevent double-trigger

    const check = async () => {
      const info = await getLastSummarizedInfo(activeChatId)
      const lastCount = info?.messageCount ?? 0

      if (shouldAutoSummarize(messages.length, lastCount, summarization.autoInterval)) {
        autoCheckRef.current = true
        try {
          await generate(false)
        } finally {
          autoCheckRef.current = false
        }
      }
    }

    check()
  }, [messages.length, summarization.mode, summarization.autoInterval, activeChatId, isSummarizing, generate])

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
    // Actions
    setSummaryText,
    generate,
    save,
    clear,
    loadSummary,
  }
}

import { generateApi } from '@/api/generate'
import { chatsApi, messagesApi } from '@/api/chats'
import {
  buildSummarizationPrompt,
  FALLBACK_SUMMARIZATION_SYSTEM_PROMPT,
  FALLBACK_SUMMARIZATION_USER_PROMPT,
} from './prompts'
import { LOOM_SUMMARY_KEY, LOOM_LAST_SUMMARIZED_KEY } from './types'
import type { LastSummarizedInfo } from './types'

interface GenerateSummaryOpts {
  chatId: string
  connectionId?: string
  messageContext: number
  userName: string
  characterName: string
  isGroup?: boolean
  groupMembers?: string[]
  /** Custom system prompt template; falls back to backend default when null/empty. */
  systemPromptOverride?: string | null
  /** Custom user prompt template; falls back to backend default when null/empty. */
  userPromptOverride?: string | null
}

/**
 * In-memory cache for the backend's default prompt templates. Fetched on first
 * summary generation (or UI load) and kept until the page is refreshed. The
 * defaults are versioned with the server, so there's no TTL to worry about.
 */
let defaultsCache: { systemPrompt: string; userPrompt: string } | null = null
let defaultsInFlight: Promise<{ systemPrompt: string; userPrompt: string }> | null = null

/**
 * Fetch the backend default prompt templates, cached for the session. Falls
 * back to the bundled frontend literals if the fetch fails so summary
 * generation never gets stuck on a network error.
 */
export async function loadSummarizationDefaults(): Promise<{ systemPrompt: string; userPrompt: string }> {
  if (defaultsCache) return defaultsCache
  if (defaultsInFlight) return defaultsInFlight

  defaultsInFlight = generateApi.getSummarizationDefaults()
    .then((res) => {
      defaultsCache = res
      return res
    })
    .catch((err) => {
      console.warn('[summary] Falling back to bundled defaults:', err)
      const fallback = {
        systemPrompt: FALLBACK_SUMMARIZATION_SYSTEM_PROMPT,
        userPrompt: FALLBACK_SUMMARIZATION_USER_PROMPT,
      }
      // Cache the fallback too — if the endpoint is down, we don't want every
      // summary generation to retry and add latency.
      defaultsCache = fallback
      return fallback
    })
    .finally(() => {
      defaultsInFlight = null
    })

  return defaultsInFlight
}

/**
 * Generate a summary for a chat using the backend's quiet generation endpoint.
 * Returns the generated summary text, or null if no messages.
 */
export async function generateSummary(opts: GenerateSummaryOpts): Promise<string | null> {
  const {
    chatId,
    connectionId,
    messageContext,
    userName,
    characterName,
    isGroup = false,
    groupMembers = [],
    systemPromptOverride,
    userPromptOverride,
  } = opts

  // Fetch chat for existing summary
  const chat = await chatsApi.get(chatId)
  const existingSummary = (chat.metadata?.[LOOM_SUMMARY_KEY] as string) || ''

  // Fetch recent messages
  const { data: allMessages } = await messagesApi.list(chatId, { limit: 500, offset: 0 })
  if (allMessages.length === 0) return null

  const recentMessages = allMessages.slice(-messageContext)

  // Fetch default templates up front — needed whenever an override is empty
  const defaults = await loadSummarizationDefaults()

  // Build prompt
  const prompt = buildSummarizationPrompt({
    recentMessages,
    existingSummary,
    userName,
    characterName,
    isGroup,
    groupMembers,
    systemPromptOverride,
    userPromptOverride,
    systemTemplate: defaults.systemPrompt,
    userTemplate: defaults.userPrompt,
  })
  if (!prompt) return null

  // Send to backend via summarize endpoint (sidecar-aware, not localhost-restricted)
  const result = await generateApi.summarize({
    connection_id: connectionId,
    messages: [
      { role: 'system', content: prompt.systemPrompt },
      { role: 'user', content: prompt.userPrompt },
    ],
  })

  const summaryText = result.content?.trim()
  if (!summaryText) return null

  // Store summary in chat metadata
  const updatedMetadata = {
    ...(chat.metadata || {}),
    [LOOM_SUMMARY_KEY]: summaryText,
    [LOOM_LAST_SUMMARIZED_KEY]: {
      messageCount: allMessages.length,
      timestamp: Date.now(),
    } satisfies LastSummarizedInfo,
  }

  await chatsApi.update(chatId, { metadata: updatedMetadata })

  return summaryText
}

/**
 * Save a manually edited summary to chat metadata.
 */
export async function saveSummary(chatId: string, summaryText: string): Promise<void> {
  const chat = await chatsApi.get(chatId)
  const metadata = { ...(chat.metadata || {}) }

  if (summaryText.trim()) {
    metadata[LOOM_SUMMARY_KEY] = summaryText.trim()
  } else {
    delete metadata[LOOM_SUMMARY_KEY]
  }

  await chatsApi.update(chatId, { metadata })
}

/**
 * Clear the summary from chat metadata.
 */
export async function clearSummary(chatId: string): Promise<void> {
  const chat = await chatsApi.get(chatId)
  const metadata = { ...(chat.metadata || {}) }
  delete metadata[LOOM_SUMMARY_KEY]
  delete metadata[LOOM_LAST_SUMMARIZED_KEY]
  await chatsApi.update(chatId, { metadata })
}

/**
 * Get the stored summary from chat metadata.
 */
export async function getSummary(chatId: string): Promise<string> {
  const chat = await chatsApi.get(chatId)
  return (chat.metadata?.[LOOM_SUMMARY_KEY] as string) || ''
}

/**
 * Get the last summarized info from chat metadata.
 */
export async function getLastSummarizedInfo(chatId: string): Promise<LastSummarizedInfo | null> {
  const chat = await chatsApi.get(chatId)
  return (chat.metadata?.[LOOM_LAST_SUMMARIZED_KEY] as LastSummarizedInfo) || null
}

/**
 * Check if auto-summarization should trigger.
 */
export function shouldAutoSummarize(
  totalMessages: number,
  lastSummarizedCount: number,
  interval: number,
): boolean {
  const messagesSinceLast = totalMessages - lastSummarizedCount
  return totalMessages >= interval && messagesSinceLast >= interval
}

import { generateApi } from '@/api/generate'
import { chatsApi, messagesApi } from '@/api/chats'
import { useStore } from '@/store'
import {
  FALLBACK_SUMMARIZATION_SYSTEM_PROMPT,
  FALLBACK_SUMMARIZATION_USER_PROMPT,
} from './prompts'
import { DEFAULT_SUMMARY_REQUEST_TIMEOUT_MS, LOOM_SUMMARY_KEY, LOOM_LAST_SUMMARIZED_KEY } from './types'
import type { LastSummarizedInfo } from './types'

/**
 * In-memory cache for the backend's default prompt templates. Fetched on first
 * request and kept until the page is refreshed. Used by the prompt template
 * editor to display server defaults and support reset.
 */
let defaultsCache: { systemPrompt: string; userPrompt: string } | null = null
let defaultsInFlight: Promise<{ systemPrompt: string; userPrompt: string }> | null = null

/**
 * Fetch the backend default prompt templates, cached for the session. Falls
 * back to the bundled frontend literals if the fetch fails so the prompt
 * editor never shows a blank template.
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
      defaultsCache = fallback
      return fallback
    })
    .finally(() => {
      defaultsInFlight = null
    })

  return defaultsInFlight
}

interface GenerateSummaryOpts {
  chatId: string
  connectionId?: string
  /** Number of recent messages to include in the summary prompt. */
  messageContext: number
  /** Active persona / user name. */
  userName: string
  /** Active character name. */
  characterName: string
  /** Custom system prompt template; falls back to backend default when null/empty. */
  systemPromptOverride?: string | null
  /** Custom user prompt template; falls back to backend default when null/empty. */
  userPromptOverride?: string | null
  /** Client request timeout for the summarize API call. */
  requestTimeoutMs?: number
}

const MIN_SUMMARY_REQUEST_TIMEOUT_MS = 5_000

function normalizeSummaryRequestTimeoutMs(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_SUMMARY_REQUEST_TIMEOUT_MS
  return Math.max(MIN_SUMMARY_REQUEST_TIMEOUT_MS, Math.round(parsed))
}

/**
 * Generate a summary for a chat. The backend fetches messages and builds
 * the prompt internally — the frontend only sends chatId + settings.
 * Returns the generated summary text, or null if no messages.
 */
export async function generateSummary(opts: GenerateSummaryOpts): Promise<string | null> {
  const {
    chatId,
    connectionId,
    messageContext,
    userName,
    characterName,
    systemPromptOverride,
    userPromptOverride,
    requestTimeoutMs,
  } = opts

  // Fetch existing summary and total message count
  const chat = await chatsApi.get(chatId)
  const existingSummary = (chat.metadata?.[LOOM_SUMMARY_KEY] as string) || ''
  const msgCountPage = await messagesApi.list(chatId, { limit: 1 })

  // Send chatId + settings to the backend — it fetches messages and builds the prompt
  const result = await generateApi.summarize(
    {
      chat_id: chatId,
      message_context: messageContext,
      existingSummary,
      userName,
      characterName,
      systemPromptOverride,
      userPromptOverride,
      connection_id: connectionId,
    },
    { timeout: normalizeSummaryRequestTimeoutMs(requestTimeoutMs) },
  )

  const summaryText = result.content?.trim()
  if (!summaryText) {
    if (result.reasoning) {
      throw new Error('Model returned only reasoning with no summary content')
    }
    throw new Error(`No summary generated (finish reason: ${result.finish_reason || 'unknown'})`)
  }

  // Store summary in chat metadata
  await chatsApi.patchMetadata(chatId, {
    [LOOM_SUMMARY_KEY]: summaryText,
    [LOOM_LAST_SUMMARIZED_KEY]: {
      messageCount: msgCountPage.total,
      timestamp: Date.now(),
    } satisfies LastSummarizedInfo,
  })
  useStore.getState().setLastSummaryMutation({ chatId, summaryText })

  return summaryText
}

/**
 * Save a manually edited summary to chat metadata.
 */
export async function saveSummary(chatId: string, summaryText: string): Promise<void> {
  const normalized = summaryText.trim()
  await chatsApi.patchMetadata(chatId, {
    [LOOM_SUMMARY_KEY]: normalized || null,
  })
  useStore.getState().setLastSummaryMutation({ chatId, summaryText: normalized })
}

/**
 * Clear the summary from chat metadata.
 */
export async function clearSummary(chatId: string): Promise<void> {
  await chatsApi.patchMetadata(chatId, {
    [LOOM_SUMMARY_KEY]: null,
    [LOOM_LAST_SUMMARIZED_KEY]: null,
  })
  useStore.getState().setLastSummaryMutation({ chatId, summaryText: '' })
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

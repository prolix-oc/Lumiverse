import { generateApi } from '@/api/generate'
import { chatsApi, messagesApi } from '@/api/chats'
import { buildSummarizationPrompt } from './prompts'
import { LOOM_SUMMARY_KEY, LOOM_LAST_SUMMARIZED_KEY } from './types'
import type { LastSummarizedInfo } from './types'
import type { Message } from '@/types/api'

interface GenerateSummaryOpts {
  chatId: string
  connectionId?: string
  messageContext: number
  userName: string
  characterName: string
  isGroup?: boolean
  groupMembers?: string[]
}

/**
 * Generate a summary for a chat using the backend's quiet generation endpoint.
 * Returns the generated summary text, or null if no messages.
 */
export async function generateSummary(opts: GenerateSummaryOpts): Promise<string | null> {
  const { chatId, connectionId, messageContext, userName, characterName, isGroup = false, groupMembers = [] } = opts

  // Fetch chat for existing summary
  const chat = await chatsApi.get(chatId)
  const existingSummary = (chat.metadata?.[LOOM_SUMMARY_KEY] as string) || ''

  // Fetch recent messages
  const { data: allMessages } = await messagesApi.list(chatId, { limit: 500, offset: 0 })
  if (allMessages.length === 0) return null

  const recentMessages = allMessages.slice(-messageContext)

  // Build prompt
  const prompt = buildSummarizationPrompt(
    recentMessages,
    existingSummary,
    userName,
    characterName,
    isGroup,
    groupMembers,
  )
  if (!prompt) return null

  // Send to backend via quiet generation
  const result = await generateApi.quiet({
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

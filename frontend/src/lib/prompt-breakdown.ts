import type { AgentRunInspectionDetailV1 } from '@/types/agent-runs'
import type { BreakdownCacheEntry } from '@/types/store'

export const GROUP_COLORS: Record<string, string> = {
  lumiverse: '#8a7fb0',
  chatHistory: '#d4a842',
  longTermMemory: '#e89b5f',
  worldInfo: '#68b87a',
  sidecar: '#e05daa',
  extensions: '#5bc0c0',
  system: '#5b8ca8',
}

export const BLOCK_PALETTE = [
  '#7c6fb0', '#b07c6f', '#6fb0a0', '#b0a06f', '#6f8db0', '#b06fa0',
  '#a0b06f', '#6fb0b0', '#b06f6f', '#6fb06f', '#8a6fb0', '#b08a6f',
]

export interface BreakdownEntry {
  name: string
  type: string
  tokens: number
  role?: string
  content?: string
  blockId?: string
  promptOrder?: number
  extensionId?: string
  extensionName?: string
  messageCount?: number
  firstMessageIndex?: number
}

export type BreakdownGroupId =
  | 'lumiverse'
  | 'chatHistory'
  | 'longTermMemory'
  | 'worldInfo'
  | 'sidecar'
  | 'extensions'
  | 'system'

export interface BreakdownGroup {
  /** Stable key for i18n and React state (language-independent). */
  id: BreakdownGroupId | string
  /** English fallback label; prefer `translateBreakdownGroupLabel(id, t)` in UI. */
  label: string
  color: string
  tokens: number
  entries: BreakdownEntry[]
}

const TYPE_TO_GROUP: Record<string, string> = {
  block: 'lumiverse',
  chat_history: 'chatHistory',
  long_term_memory: 'longTermMemory',
  world_info: 'worldInfo',
  sidecar: 'sidecar',
  extension: 'extensions',
  authors_note: 'extensions',
  separator: 'system',
  utility: 'system',
  append: 'lumiverse',
}

export const GROUP_LABEL_FALLBACKS: Record<string, string> = {
  lumiverse: 'Lumiverse Prompts',
  chatHistory: 'Chat History',
  longTermMemory: 'Long-Term Memory',
  worldInfo: 'World Info',
  sidecar: 'Sidecar (Lumi Pipeline)',
  extensions: 'Extensions / Author\'s Note',
  system: 'System',
}

export function groupBreakdownEntries(entries: BreakdownEntry[]): BreakdownGroup[] {
  const groupMap = new Map<string, BreakdownGroup>()

  for (const entry of entries) {
    const groupKey = TYPE_TO_GROUP[entry.type] || 'system'
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, {
        id: groupKey,
        label: GROUP_LABEL_FALLBACKS[groupKey] || groupKey,
        color: GROUP_COLORS[groupKey] || GROUP_COLORS.system,
        tokens: 0,
        entries: [],
      })
    }
    const group = groupMap.get(groupKey)!
    group.tokens += entry.tokens
    group.entries.push(entry)
  }

  // Return in a stable order
  const order = ['lumiverse', 'chatHistory', 'longTermMemory', 'worldInfo', 'sidecar', 'extensions', 'system']
  const result: BreakdownGroup[] = []
  for (const key of order) {
    const g = groupMap.get(key)
    if (g) result.push(g)
  }
  return result
}

export function getBlockDisplayColor(index: number): string {
  return BLOCK_PALETTE[index % BLOCK_PALETTE.length]
}


export function workInspectionCheckpointLabel(
  assemblySurface: 'RESPONSE' | 'WORK' | undefined,
  checkpoint?: string | null,
  customPhaseId?: string | null,
): string {
  if (assemblySurface === 'WORK') {
    const labeled = (typeof checkpoint === 'string' && checkpoint.length > 0)
      ? checkpoint
      : (typeof customPhaseId === 'string' && customPhaseId.length > 0)
        ? customPhaseId
        : 'WORK'
    return labeled === 'ordinary_response' ? 'WORK' : labeled
  }
  return (typeof checkpoint === 'string' && checkpoint.length > 0) ? checkpoint : 'ordinary_response'
}

export function inspectionAttemptTargetMessageId(
  detail: Pick<AgentRunInspectionDetailV1, 'target' | 'committedTarget'>,
): string | null {
  return detail.target?.messageId ?? detail.committedTarget?.messageId ?? null
}

export function inspectionDetailToBreakdown(detail: AgentRunInspectionDetailV1): BreakdownCacheEntry {
  const retained = detail.promptEvidence.filter(
    (entry) => entry.destination !== 'cortex' && entry.destination !== 'council',
  )
  const prompts = retained.some((entry) => entry.included)
    ? retained.filter((entry) => entry.included)
    : retained
  const rootWorkInspection = detail.promptEvidence.find(
    (entry) => entry.destination === 'root_work' && entry.loomInspection,
  )?.loomInspection
  const continuationInspection = detail.promptEvidence.find(
    (entry) => (
      (entry.destination === 'completion_handoff' || entry.destination === 'child_work')
      && entry.loomInspection
    ),
  )?.loomInspection
  const loomPromptInspection = rootWorkInspection
    ?? continuationInspection
    ?? detail.promptEvidence.find((entry) => entry.loomInspection)?.loomInspection
    ?? undefined
  return {
    entries: prompts.map((entry) => ({
      name: entry.sourceId,
      type: 'lumiverse',
      tokens: 0,
      role: entry.role,
      content: entry.content,
      blockId: entry.sourceId,
      promptOrder: entry.promptOrder,
    })),
    messages: prompts.map((entry) => ({
      role: entry.role === 'user' || entry.role === 'assistant' ? entry.role : 'system',
      content: entry.content,
    })),
    totalTokens: detail.usage.totals.totalTokens,
    chatHistoryTokens: 0,
    maxContext: 0,
    model: 'recorded',
    provider: 'inspection',
    parameters: {},
    usage: {
      prompt_tokens: detail.usage.totals.inputTokens,
      completion_tokens: detail.usage.totals.outputTokens,
      total_tokens: detail.usage.totals.totalTokens,
    },
    tokenizer_name: null,
    assemblySurface: 'WORK',
    loomPromptInspection,
  }
}


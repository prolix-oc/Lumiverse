import { get, post, type RequestOptions } from './client'
import { flushSettingsNow } from '@/store/slices/settings'

/** Generation requests go through prompt assembly + council + embedding calls
 *  which can legitimately take longer than the default 30s client timeout. */
const LONG: RequestOptions = { timeout: 120_000 }

export type GenerationType = 'normal' | 'continue' | 'regenerate' | 'swipe' | 'impersonate' | 'quiet'

export type ImpersonateMode = 'prompts' | 'oneliner' | 'sovereign_hand'

export interface GenerateRequest {
  chat_id: string
  connection_id?: string
  persona_id?: string
  preset_id?: string
  force_preset_id?: boolean
  message_id?: string
  continue_from?: string
  force_name?: string
  generation_type?: GenerationType
  impersonate_mode?: ImpersonateMode
  /** For impersonate: free-form text from the input box, appended to the impersonation prompt. */
  impersonate_input?: string
  target_character_id?: string
  regen_feedback?: string
  regen_feedback_position?: 'system' | 'user'
  retain_council?: boolean
  /** Dry-run only: reassemble as if this message were absent from history. */
  exclude_message_id?: string
}

export interface GenerateResponse {
  generationId: string
}

export interface QuietGenerateRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  connection_id?: string
  parameters?: Record<string, any>
  /**
   * Optional chat id. When passed to the `/generate/summarize` endpoint, the
   * server registers the job in its summarize-pool so frontends can recover
   * in-flight state via `getSummarizeStatus` and the `SUMMARIZATION_*` WS
   * events.
   */
  chat_id?: string
}

export interface SummarizeStatusResponse {
  active: boolean
  generationId?: string
  startedAt?: number
}

export interface QuietGenerateResponse {
  content: string
  reasoning?: string
  finish_reason: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export interface SummarizationPromptDefaults {
  systemPrompt: string
  userPrompt: string
}

export interface DryRunMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AssemblyBreakdownEntry {
  name: string
  type: string
  role?: string
  content?: string
  blockId?: string
  extensionId?: string
  extensionName?: string
  messageCount?: number
  firstMessageIndex?: number
}

export interface DryRunResponse {
  messages: DryRunMessage[]
  breakdown: AssemblyBreakdownEntry[]
  parameters: Record<string, any>
  assistantPrefill?: string
  model: string
  provider: string
  tokenCount?: {
    total_tokens: number
    breakdown: {
      name: string
      type: string
      tokens: number
      role?: string
      extensionId?: string
      extensionName?: string
    }[]
    tokenizer_id: string | null
    tokenizer_name: string | null
  }
  worldInfoStats?: {
    totalCandidates: number
    activatedBeforeBudget: number
    activatedAfterBudget: number
    evictedByBudget: number
    evictedByMinPriority: number
    estimatedTokens: number
    recursionPassesUsed: number
    keywordActivated: number
    vectorActivated: number
    totalActivated: number
    queryPreview: string
  }
  memoryStats?: {
    enabled: boolean
    chunksRetrieved: number
    chunksAvailable: number
    chunksPending: number
    injectionMethod: 'macro' | 'fallback' | 'disabled'
    retrievedChunks: Array<{
      score: number
      tokenEstimate: number
      messageRange: [number, number]
      preview: string
    }>
    queryPreview: string
    settingsSource: 'global' | 'per_chat'
  }
  databankStats?: {
    enabled: boolean
    embeddingsEnabled: boolean
    activeBankCount: number
    activeDatabankIds: string[]
    chunksRetrieved: number
    injectionMethod: 'macro' | 'fallback' | 'none' | 'disabled'
    retrievalState:
      | 'cache_hit'
      | 'awaited_prefetch'
      | 'awaited_direct'
      | 'skipped_no_active_banks'
      | 'skipped_embeddings_disabled'
    retrievedChunks: Array<{
      score: number
      tokenEstimate: number
      documentName: string
      databankId: string
      preview: string
    }>
    queryPreview: string
  }
  contextClipStats?: import('@/types/ws-events').ContextClipStats
}

export interface BreakdownResponse {
  entries: {
    name: string
    type: string
    tokens: number
    role?: string
    content?: string
    blockId?: string
    extensionId?: string
    extensionName?: string
    messageCount?: number
    firstMessageIndex?: number
  }[]
  messages?: DryRunMessage[]
  totalTokens: number
  maxContext: number
  model: string
  provider: string
  presetName?: string
  tokenizer_name: string | null
}

export interface GenerationStatusResponse {
  active: boolean
  generationId?: string
  status?: 'assembling' | 'council' | 'streaming' | 'completed' | 'stopped' | 'error'
  councilRetryPending?: boolean
  councilToolsFailure?: {
    generationId: string
    chatId: string
    failedTools: {
      memberId: string
      memberName: string
      toolName: string
      toolDisplayName: string
      error?: string
    }[]
    successCount: number
    failedCount: number
  }
  content?: string
  reasoning?: string
  tokenSeq?: number
  generationType?: string
  targetMessageId?: string
  characterName?: string
  characterId?: string
  model?: string
  startedAt?: number
  reasoningStartedAt?: number
  reasoningDurationMs?: number
  completedMessageId?: string
  completedAt?: number
  error?: string
}

export interface ActiveGenerationEntry {
  generationId: string
  chatId: string
  status: 'assembling' | 'council' | 'streaming' | 'completed' | 'stopped' | 'error'
  generationType: string
  characterName: string
  characterId?: string
  model: string
  startedAt: number
  councilRetryPending: boolean
}

export const generateApi = {
  async start(request: GenerateRequest) {
    await flushSettingsNow()
    return post<GenerateResponse>('/generate', request, LONG)
  },

  stop(generationId?: string) {
    return post<void>('/generate/stop', generationId ? { generation_id: generationId } : {})
  },

  async regenerate(request: GenerateRequest) {
    await flushSettingsNow()
    return post<GenerateResponse>('/generate/regenerate', request, LONG)
  },

  async continueGeneration(request: GenerateRequest) {
    await flushSettingsNow()
    return post<GenerateResponse>('/generate/continue', request, LONG)
  },

  quiet(request: QuietGenerateRequest) {
    return post<QuietGenerateResponse>('/generate/quiet', request, LONG)
  },

  summarize(request: QuietGenerateRequest) {
    return post<QuietGenerateResponse>('/generate/summarize', request, LONG)
  },

  getSummarizationDefaults() {
    return get<SummarizationPromptDefaults>('/generate/summarize/prompt-defaults')
  },

  getSummarizeStatus(chatId: string) {
    return get<SummarizeStatusResponse>(`/generate/summarize/status/${chatId}`)
  },

  async dryRun(request: GenerateRequest) {
    await flushSettingsNow()
    return post<DryRunResponse>('/generate/dry-run', request, LONG)
  },

  getBreakdown(messageId: string) {
    return get<BreakdownResponse>(`/generate/breakdown/${messageId}`)
  },

  getStatus(chatId: string) {
    return get<GenerationStatusResponse>(`/generate/status/${chatId}`)
  },

  getActive() {
    return get<ActiveGenerationEntry[]>('/generate/active')
  },

  acknowledge(chatId: string) {
    return post<{ acknowledged: boolean; removed: number; generationIds: string[] }>('/generate/acknowledge', { chatId })
  },

  councilRetry(generationId: string, decision: 'continue' | 'retry') {
    return post<{ resolved: boolean }>('/generate/council-retry', { generation_id: generationId, decision })
  },
}

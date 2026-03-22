import { get, post } from './client'

export type GenerationType = 'normal' | 'continue' | 'regenerate' | 'swipe' | 'impersonate' | 'quiet'

export type ImpersonateMode = 'prompts' | 'oneliner' | 'sovereign_hand'

export interface GenerateRequest {
  chat_id: string
  connection_id?: string
  persona_id?: string
  preset_id?: string
  message_id?: string
  continue_from?: string
  force_name?: string
  generation_type?: GenerationType
  impersonate_mode?: ImpersonateMode
  target_character_id?: string
  regen_feedback?: string
  regen_feedback_position?: 'system' | 'user'
}

export interface GenerateResponse {
  generationId: string
}

export interface QuietGenerateRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  connection_id?: string
  parameters?: Record<string, any>
}

export interface QuietGenerateResponse {
  content: string
  finish_reason: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
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
    breakdown: { name: string; type: string; tokens: number; role?: string }[]
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
}

export interface BreakdownResponse {
  entries: { name: string; type: string; tokens: number; role?: string; blockId?: string }[]
  totalTokens: number
  maxContext: number
  model: string
  provider: string
  presetName?: string
  tokenizer_name: string | null
}

export const generateApi = {
  start(request: GenerateRequest) {
    return post<GenerateResponse>('/generate', request)
  },

  stop(generationId?: string) {
    return post<void>('/generate/stop', generationId ? { generation_id: generationId } : {})
  },

  regenerate(request: GenerateRequest) {
    return post<GenerateResponse>('/generate/regenerate', request)
  },

  continueGeneration(request: GenerateRequest) {
    return post<GenerateResponse>('/generate/continue', request)
  },

  quiet(request: QuietGenerateRequest) {
    return post<QuietGenerateResponse>('/generate/quiet', request)
  },

  dryRun(request: GenerateRequest) {
    return post<DryRunResponse>('/generate/dry-run', request)
  },

  getBreakdown(messageId: string) {
    return get<BreakdownResponse>(`/generate/breakdown/${messageId}`)
  },
}

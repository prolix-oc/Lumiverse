/** Summary mode: disabled, auto (interval-based), or manual (on-demand). */
export type SummaryMode = 'disabled' | 'auto' | 'manual'

/** Which connection profile to use for generation. */
export type SummaryApiSource = 'active' | 'dedicated'

export interface SummarizationSettings {
  mode: SummaryMode
  apiSource: SummaryApiSource
  /** Connection profile ID when apiSource is 'dedicated'. */
  dedicatedConnectionId: string | null
  /** Auto-summarize every N messages. */
  autoInterval: number
  /** Messages to include in auto context. */
  autoMessageContext: number
  /** Messages to include when triggered manually. */
  manualMessageContext: number
  /** Whether to limit the number of messages included in generation context. */
  messageLimitEnabled: boolean
  /** Maximum number of recent messages to include when messageLimit is enabled. */
  messageLimitCount: number
}

export const DEFAULT_SUMMARIZATION_SETTINGS: SummarizationSettings = {
  mode: 'disabled',
  apiSource: 'active',
  dedicatedConnectionId: null,
  autoInterval: 10,
  autoMessageContext: 10,
  manualMessageContext: 10,
  messageLimitEnabled: false,
  messageLimitCount: 50,
}

/** Metadata keys stored on chat.metadata */
export const LOOM_SUMMARY_KEY = 'loom_summary'
export const LOOM_LAST_SUMMARIZED_KEY = 'loom_last_summarized_at'

export interface LastSummarizedInfo {
  messageCount: number
  timestamp: number
}

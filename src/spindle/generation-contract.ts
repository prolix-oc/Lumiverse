import type {
  DryRunResultDTO as PublicDryRunResultDTO,
  LlmThinkingBlockDTO,
  StreamChunkDTO,
} from "lumiverse-spindle-types";
import type { ContextClipStats } from "../llm/types";

/** Host additions pending publication in lumiverse-spindle-types. */
export interface DryRunResultDTO extends PublicDryRunResultDTO {
  request_messages?: import("lumiverse-spindle-types").LlmMessageDTO[];
  assistantPrefill?: string;
  chatHistoryTokens?: number;
  contextClipStats?: ContextClipStats;
}

/**
 * Host additions pending publication in lumiverse-spindle-types: the terminal
 * stream chunk carries the same reasoning blocks as GenerationResponseDTO, so a
 * streamed tool call can be continued with them.
 */
export interface StreamDoneChunkDTO extends Extract<StreamChunkDTO, { type: "done" }> {
  thinking_blocks?: LlmThinkingBlockDTO[];
  reasoning_details?: Record<string, unknown>[];
}

export interface SavedBreakdownDTO {
  entries: Array<{
    name: string;
    type: string;
    tokens: number;
    role?: string;
    content?: string;
    blockId?: string;
    extensionId?: string;
    extensionName?: string;
    messageCount?: number;
    firstMessageIndex?: number;
  }>;
  messages?: Array<{ role: string; content: string }>;
  totalTokens: number;
  chatHistoryTokens?: number;
  maxContext: number;
  model: string;
  provider: string;
  parameters?: Record<string, unknown>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    provider_raw?: Record<string, unknown>;
  };
  presetName?: string;
  presetId?: string;
  tokenizer_name?: string | null;
}

export type GetBreakdownWorkerMessage = {
  type: "generate_get_breakdown";
  requestId: string;
  messageId: string;
  userId?: string;
};

import type { MacroEnv } from "../macros/types";

// --- Multi-part content types (for multimodal messages) ---

export interface LlmTextPart {
  type: "text";
  text: string;
}

export interface LlmImagePart {
  type: "image";
  data: string;      // base64-encoded
  mime_type: string;  // e.g. "image/png", "image/jpeg"
}

export interface LlmAudioPart {
  type: "audio";
  data: string;      // base64-encoded
  mime_type: string;  // e.g. "audio/wav", "audio/mp3"
}

export type LlmMessagePart = LlmTextPart | LlmImagePart | LlmAudioPart;

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmMessagePart[];
  name?: string;
}

/** Helper: extract the text content from an LlmMessage regardless of format. */
export function getTextContent(msg: LlmMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((p): p is LlmTextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export interface GenerationRequest {
  messages: LlmMessage[];
  model: string;
  parameters?: GenerationParameters;
  stream?: boolean;
  /** Optional tool/function definitions for inline function calling. */
  tools?: ToolDefinition[];
  /** Optional abort signal — when fired, cancels the in-flight HTTP request. */
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  strict?: boolean;
  inputExamples?: Array<Record<string, unknown>>;
}

export interface GenerationParameters {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string[];
  [key: string]: any;
}

export interface ToolCallResult {
  name: string;
  args: Record<string, unknown>;
  /** Provider call ID (e.g. Anthropic `id`, OpenAI `id`). Synthetic UUID for providers that don't supply one. */
  call_id: string;
}

export interface GenerationResponse {
  content: string;
  reasoning?: string;
  finish_reason: string;
  /** Present when the LLM requested function calls instead of (or in addition to) generating text. */
  tool_calls?: ToolCallResult[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  token: string;
  reasoning?: string;
  finish_reason?: string;
  /** Accumulated function calls (set on the final chunk when finish_reason indicates tool use). */
  tool_calls?: ToolCallResult[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// --- Prompt Assembly Types ---

export type GenerationType = 'normal' | 'continue' | 'regenerate' | 'swipe' | 'impersonate' | 'quiet';

export type ImpersonateMode = 'prompts' | 'oneliner' | 'sovereign_hand';

export interface AssemblyContext {
  userId: string;
  chatId: string;
  connectionId?: string;
  presetId?: string;
  /** When true, bypass preset-profile preset selection and use presetId directly. */
  forcePresetId?: boolean;
  generationType: GenerationType;
  personaId?: string;
  /** For impersonate: controls how much of the preset is included. */
  impersonateMode?: ImpersonateMode;
  /** For impersonate: free-form user text from the input box, appended to the impersonation prompt. */
  impersonateInput?: string;
  /** For regenerate: exclude this message from chat history (it has a blank swipe). */
  excludeMessageId?: string;
  /** For group chats: generate a response as this specific character. */
  targetCharacterId?: string;
  /** Council tool results (passed from generate.service when council executes before assembly). */
  councilToolResults?: CouncilToolResultSummary[];
  /** Named council tool results (variable_name → content). */
  councilNamedResults?: Record<string, string>;
  /** Pre-computed vector-activated world info entries from the generation pipeline.
   *  When provided, assembly reuses these instead of re-running vector retrieval. */
  precomputedVectorEntries?: import("../services/prompt-assembly.service").VectorActivatedEntry[];
  /** User-provided feedback text for regeneration guidance. */
  regenFeedback?: string;
  /** Where to inject regen feedback: 'system' (last system msg) or 'user' (last user msg). */
  regenFeedbackPosition?: "system" | "user";
  /** Pre-fetched data to avoid redundant DB calls during assembly.
   *  When provided, assembly reads from this instead of querying DB. */
  prefetched?: PrefetchedData;
  /** Optional abort signal. When fired, in-flight embedding requests
   *  (WI vector retrieval) are cancelled and assembly short-circuits with
   *  an AbortError so the caller can unwind cleanly. */
  signal?: AbortSignal;
}

/**
 * Batch-prefetched data for the assembly pipeline. Every field here replaces
 * one or more individual DB queries inside `assemblePrompt()`.
 */
export interface PrefetchedData {
  chat: import("../types/chat").Chat;
  messages: import("../types/message").Message[];
  character: import("../types/character").Character;
  persona: import("../types/persona").Persona | null;
  connection: import("../types/connection-profile").ConnectionProfile | null;
  preset: import("../types/preset").Preset | null;
  /** All settings keys the pipeline needs, in one batch. */
  allSettings: Map<string, any>;
  /** Embedding config resolved once (includes secret validation). */
  embeddingConfig: import("../services/embeddings.service").EmbeddingConfigWithStatus;
  /** World info entries from all attached books, batch-loaded. */
  worldInfoSources: {
    entries: import("../types/world-book").WorldBookEntry[];
    worldBookIds: string[];
    bookSourceMap: Map<string, import("../services/prompt-assembly.service").BookSource>;
  };
  /** Group chat members, batch-loaded. */
  groupCharacters?: Map<string, import("../types/character").Character>;
  /** Memory cortex config (derived from allSettings). */
  cortexConfig: import("../services/memory-cortex").MemoryCortexConfig;
}

/** Lightweight summary of a council tool result for macro access (avoids importing spindle-types). */
export interface CouncilToolResultSummary {
  memberId: string;
  memberName: string;
  toolName: string;
  toolDisplayName: string;
  success: boolean;
  content: string;
  error?: string;
}

export interface ActivatedWorldInfoEntry {
  id: string;
  comment: string;
  keys: string[];
  source: 'keyword' | 'vector';
  score?: number;
  bookSource?: 'character' | 'persona' | 'chat' | 'global';
  bookId?: string;
}

export interface MemoryStats {
  enabled: boolean;
  chunksRetrieved: number;
  chunksAvailable: number;
  chunksPending: number;
  injectionMethod: "macro" | "fallback" | "disabled";
  retrievedChunks: Array<{
    score: number;
    tokenEstimate: number;
    messageRange: [number, number];
    preview: string;
  }>;
  queryPreview: string;
  settingsSource: "global" | "per_chat";
}

export interface DatabankStats {
  enabled: boolean;
  embeddingsEnabled: boolean;
  activeBankCount: number;
  activeDatabankIds: string[];
  chunksRetrieved: number;
  injectionMethod: "macro" | "fallback" | "none" | "disabled";
  retrievalState:
    | "cache_hit"
    | "awaited_prefetch"
    | "awaited_direct"
    | "skipped_no_active_banks"
    | "skipped_embeddings_disabled";
  retrievedChunks: Array<{
    score: number;
    tokenEstimate: number;
    documentName: string;
    databankId: string;
    preview: string;
  }>;
  queryPreview: string;
}

/**
 * Result of the context-budget clipping step that runs at the end of prompt
 * assembly. When `enabled` is true and `messagesDropped > 0`, oldest chat
 * history messages were excluded so the assembly would fit within the preset's
 * configured `contextSize` (minus response headroom + a small safety margin).
 *
 * When `enabled` is false, clipping was skipped (no contextSize configured,
 * or the budget computed to <= 0 — see `budgetInvalid`).
 */
export interface ContextClipStats {
  /** True when a context budget was resolved and the clip step ran. */
  enabled: boolean;
  /** Preset `contextSize` (→ `max_context_length`). 0 when unset. */
  maxContext: number;
  /** Reserved for the LLM response (`max_tokens`). */
  maxResponseTokens: number;
  /** Headroom for interceptors, deliberation inject, tokenizer variance. */
  safetyMargin: number;
  /** `maxContext - maxResponseTokens - safetyMargin`. */
  inputBudget: number;
  /** Tokens consumed by non-chat-history messages (system blocks, WI, prefill, …). */
  fixedTokens: number;
  /** `inputBudget - fixedTokens`. Can be negative when fixed overhead already exceeds budget. */
  remainingHistoryBudget: number;
  /** Chat-history tokens before clipping. */
  chatHistoryTokensBefore: number;
  /** Chat-history tokens after clipping. */
  chatHistoryTokensAfter: number;
  /** Number of chat-history messages excluded from the final assembly. */
  messagesDropped: number;
  /** Sum of tokens dropped (oldest messages). */
  tokensDropped: number;
  /** Display name of the tokenizer used, or "approximate" for the char/4 fallback. */
  tokenizerUsed: string;
  /** True when the budget computed to <= 0 (misconfigured preset) — no clipping attempted. */
  budgetInvalid?: boolean;
  /** True when fixed prompt overhead alone is larger than the available input budget. */
  fixedOverBudget?: boolean;
}

export interface AssemblyResult {
  messages: LlmMessage[];
  breakdown: AssemblyBreakdownEntry[];
  parameters: Record<string, any>;
  /** The resolved assistant prefill text (from promptBias / assistantPrefill / assistantImpersonation).
   *  When set, the last message in `messages` is an assistant message containing this text.
   *  The generate service must prepend this to the LLM response content since the model
   *  continues *after* the prefill (it's not included in the model's output). */
  assistantPrefill?: string;
  /** Summary of all world info entries activated during this assembly. */
  activatedWorldInfo?: ActivatedWorldInfoEntry[];
  /** Statistics from the World Info activation pipeline (budget enforcement, etc.). */
  worldInfoStats?: {
    totalCandidates: number;
    activatedBeforeBudget: number;
    activatedAfterBudget: number;
    evictedByBudget: number;
    evictedByMinPriority: number;
    estimatedTokens: number;
    recursionPassesUsed: number;
    keywordActivated: number;
    vectorActivated: number;
    totalActivated: number;
    deduplicated: number;
    queryPreview: string;
    /** Diagnostic details from the vector retrieval pipeline. */
    vectorRetrieval?: {
      eligibleCount: number;
      hitsBeforeThreshold: number;
      hitsAfterThreshold: number;
      thresholdRejected: number;
      hitsAfterRerankCutoff: number;
      rerankRejected: number;
      topK: number;
      blockerMessages: string[];
    };
  };
  /** Statistics from long-term memory retrieval. */
  memoryStats?: MemoryStats;
  /** Statistics from databank retrieval. */
  databankStats?: DatabankStats;
  /** Context-budget clipping stats. Present when assembly went through the
   *  token-budget clip step (i.e. the preset-driven path, not legacyAssembly). */
  contextClipStats?: ContextClipStats;
  /** Deferred WI state to persist after generation completes. Only the keys
   *  this writer owns; merged via mergeChatMetadata so concurrent user edits
   *  to chat metadata are not clobbered. */
  deferredWiState?: { chatId: string; partial: Record<string, any> };
  /** True if the {{lumiaCouncilDeliberation}} macro was resolved during assembly. */
  deliberationHandledByMacro?: boolean;
  /** The macro environment built during assembly — used downstream for regex script macro substitution. */
  macroEnv?: MacroEnv;
  /** Snapshot of the macro environment before chat-history evaluation mutates it. */
  macroEnvSeed?: MacroEnv;
}

export interface AssemblyBreakdownEntry {
  type: 'block' | 'chat_history' | 'separator' | 'utility' | 'world_info' | 'authors_note' | 'append' | 'long_term_memory' | 'sidecar' | 'databank' | 'databank_mention' | 'extension';
  name: string;
  role?: string;
  content?: string;
  blockId?: string;
  marker?: string;
  messageCount?: number;
  /** Index of the first chat history message in the assembled messages array. */
  firstMessageIndex?: number;
  /** Pre-counted token value (e.g. from sidecar usage stats). Skips local tokenization. */
  preCountedTokens?: number;
  /** If true, tokens are displayed but NOT added to the total (e.g. sidecar tokens spent on a separate LLM). */
  excludeFromTotal?: boolean;
  /** Present for prompt blocks injected by Spindle interceptors. */
  extensionId?: string;
  /** Human-readable extension attribution for injected prompt blocks. */
  extensionName?: string;
}

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
  generationType: GenerationType;
  personaId?: string;
  /** For impersonate: controls how much of the preset is included. */
  impersonateMode?: ImpersonateMode;
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
  /** Pipeline results from Lumi sidecar execution. */
  lumiPipelineResults?: import("../types/lumi-engine").LumiPipelineResult;
  /** User-provided feedback text for regeneration guidance. */
  regenFeedback?: string;
  /** Where to inject regen feedback: 'system' (last system msg) or 'user' (last user msg). */
  regenFeedbackPosition?: "system" | "user";
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
  };
  /** Statistics from long-term memory retrieval. */
  memoryStats?: MemoryStats;
  /** Deferred WI state to persist after generation completes. */
  deferredWiState?: { chatId: string; metadata: Record<string, any> };
  /** True if the {{lumiaCouncilDeliberation}} macro was resolved during assembly. */
  deliberationHandledByMacro?: boolean;
}

export interface AssemblyBreakdownEntry {
  type: 'block' | 'chat_history' | 'separator' | 'utility' | 'world_info' | 'authors_note' | 'append' | 'long_term_memory' | 'sidecar';
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
}

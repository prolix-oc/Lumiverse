import type { MacroEnv } from "../macros/types";
import type { AgentRuntimeOwner } from "../services/agent-runtime.service";
import type { ResolvedConcreteConnectionV1 } from "../services/connections.service";
import type { AgentConfigV2 } from "../types/agents";
import type { AgentToolSnapshot } from "../types/agents";
import type { WorldBook } from "../types/world-book";

import type { PrecomputedWorldInfoVectorEntries } from "../services/prompt-assembly.service";
import type { LoomPromptInspectionV1 } from "../types/agent-cognition";

export type { ProviderCapabilities, ToolContinuationMode } from "./param-schema";

// --- Multi-part content types (for multimodal messages) ---

export interface LlmTextPart {
  type: "text";
  text: string;
  cache_control?: Record<string, unknown>;
  /** Opaque Gemini thought signature for this non-tool part. */
  thought_signature?: string;
}

export interface LlmImagePart {
  type: "image";
  data: string;      // base64-encoded
  mime_type: string;  // e.g. "image/png", "image/jpeg"
  cache_control?: Record<string, unknown>;
}

export interface LlmAudioPart {
  type: "audio";
  data: string;      // base64-encoded
  mime_type: string;  // e.g. "audio/wav", "audio/mp3"
  cache_control?: Record<string, unknown>;
}

export interface LlmToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: Record<string, unknown>;
  thought_signature?: string;
}

export interface LlmToolResultPart {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: Record<string, unknown>;
}

export type LlmMessagePart =
  | LlmTextPart
  | LlmImagePart
  | LlmAudioPart
  | LlmToolUsePart
  | LlmToolResultPart;

export interface DisplayContentPartSummary {
  type: string;
  count: number;
}

/**
 * A provider-native reasoning block that must be replayed verbatim on tool-use
 * continuations to preserve interleaved thinking. Currently produced by
 * Anthropic (extended/adaptive thinking): a `thinking` block carries the
 * model's reasoning text plus an opaque `signature` that the server decrypts to
 * reconstruct the full thinking; a `redacted_thinking` block carries an opaque
 * encrypted `data` payload. Both are opaque to Lumiverse and must be passed
 * back unmodified, in order, before the assistant turn's `tool_use` blocks.
 */
export interface LlmThinkingBlock {
  type: "thinking" | "redacted_thinking";
  /** Reasoning text for `thinking` blocks (may be summarized or empty when display is omitted). */
  thinking?: string;
  /** Opaque signature for `thinking` blocks — replay unmodified. */
  signature?: string;
  /** Opaque encrypted payload for `redacted_thinking` blocks — replay unmodified. */
  data?: string;
  /**
   * Internal cloneable provenance: this carrier's thinking text was exposed
   * as visible output because the request disabled thinking. Providers must
   * omit it from native wire blocks and validate it as the literal `true`.
   */
  display_suppressed?: true;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmMessagePart[];
  name?: string;
  /**
   * Marks a trailing assistant message as a generation prefix. Providers that
   * support native partial/prefill mode can use this to continue after
   * `content` instead of treating it as a completed history message.
   */
  partial?: boolean;
  cache_control?: Record<string, unknown>;
  /** Provider-returned reasoning payload required by some OpenAI-compatible tool-call continuations. */
  reasoning_content?: string;
  /** Provider-native reasoning blocks (Anthropic thinking blocks with
   *  signatures) replayed verbatim on tool-use continuations for interleaved
   *  thinking. Providers that don't use this carrier ignore the field. */
  thinking_blocks?: LlmThinkingBlock[];
  /** OpenRouter's opaque, normalized reasoning blocks (`reasoning_details`).
   *  Replayed verbatim (entire sequence, unmodified) on the assistant message
   *  to preserve chain-of-thought across tool calls. Opaque to Lumiverse. */
  reasoning_details?: Record<string, unknown>[];
  /** Opaque Gemini signature on a non-tool response part, replayed when enabled. */
  thought_signature?: string;
}

/** Helper: extract the text content from an LlmMessage regardless of format. */
export function getTextContent(msg: LlmMessage): string {
  if (typeof msg.content === "string") return msg.content;
  return msg.content
    .filter((p): p is LlmTextPart => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export function describeContentForDisplay(
  content: string | LlmMessagePart[],
): { text: string; contentParts: DisplayContentPartSummary[] } {
  if (typeof content === "string") {
    return { text: content, contentParts: [] };
  }

  const partCounts = new Map<string, number>();
  const countPart = (type: string) => {
    partCounts.set(type, (partCounts.get(type) ?? 0) + 1);
  };

  const text = content
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "image":
          countPart("image");
          return `[image: ${part.mime_type}]`;
        case "audio":
          countPart("audio");
          return `[audio: ${part.mime_type}]`;
        case "tool_use":
          countPart("tool_use");
          return `[tool_call: ${part.name}(${JSON.stringify(part.input)})]`;
        case "tool_result":
          countPart("tool_result");
          return `[tool_result${part.is_error ? " (error)" : ""}: ${part.content}]`;
        default: {
          const rawType =
            typeof (part as { type?: unknown }).type === "string"
              ? (part as { type: string }).type
              : "part";
          countPart(rawType);
          return `[${rawType}]`;
        }
      }
    })
    .join("\n");

  return {
    text,
    contentParts: [...partCounts.entries()].map(([type, count]) => ({
      type,
      count,
    })),
  };
}

/**
 * Flatten message content to a human-readable string for display-only surfaces
 * (e.g. the dry-run prompt viewer) that can't render multimodal parts. Text is
 * inlined in order; non-text parts become bracketed placeholders so an
 * image/audio/tool part is still visible. Unlike {@link getTextContent}, this
 * never silently drops media — important for a debugging view.
 */
export function flattenContentForDisplay(
  content: string | LlmMessagePart[],
): string {
  return describeContentForDisplay(content).text;
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
  /** Receive-boundary cap selected by the root/child runtime frame. */
  receiveLimitBytes?: number;
  /** Host-owned tool policy; provider parameters cannot override it. */
  toolMode?: "ordinary" | "required" | "finalization";
  /**
   * Provider-native continuation state. This is owned by the active loop frame,
   * must never be copied into an LlmMessage or persisted, and is cleared after
   * the request/frame reaches a terminal state.
   */
  providerTransientCarrier?: ProviderTransientCarrier;
}

export type ResponsesOutputTextAnnotation = Readonly<Record<string, unknown>>;
export type ResponsesOutputTextLogprob = Readonly<Record<string, unknown>>;

export interface ResponsesOutputTextPart {
  readonly type: "output_text";
  readonly text: string;
  /**
   * Provider-owned output metadata is retained only in the transient
   * Responses continuation carrier. It must never be persisted or rendered.
   */
  readonly annotations?: readonly ResponsesOutputTextAnnotation[] | null;
  readonly logprobs?: readonly ResponsesOutputTextLogprob[] | null;
}

export interface ResponsesRefusalPart {
  readonly type: "refusal";
  readonly refusal: string;
}

export type ResponsesMessageContentPart =
  | ResponsesOutputTextPart
  | ResponsesRefusalPart;

export interface ResponsesMessageOutputItem {
  readonly type: "message";
  readonly id: string;
  readonly role: "assistant";
  readonly status?: string;
  readonly content: readonly ResponsesMessageContentPart[];
}

export interface ResponsesReasoningSummaryPart {
  readonly type: "summary_text";
  readonly text: string;
}

export interface ResponsesReasoningOutputItem {
  readonly type: "reasoning";
  readonly id: string;
  readonly status?: string;
  readonly summary: readonly ResponsesReasoningSummaryPart[];
  readonly encrypted_content?: string;
}

export interface ResponsesFunctionCallOutputItem {
  readonly type: "function_call";
  readonly id: string;
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
  readonly status?: string;
}

export type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesReasoningOutputItem
  | ResponsesFunctionCallOutputItem;

export interface ResponsesFunctionCallOutput {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string;
}
/** Bounded host-authored text appended to an ordered Responses continuation. */
export interface ResponsesInputMessageItem {
  readonly type: "message";
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}

/** Closed, in-memory-only provider continuation carriers. */
export type ProviderTransientCarrier = {
  readonly kind: "openai_responses";
  /** Exact chronology across provider output and host input items. */
  readonly items: readonly (
    | ResponsesOutputItem
    | ResponsesFunctionCallOutput
    | ResponsesInputMessageItem
  )[];
};

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  strict?: boolean;
  inputExamples?: Array<Record<string, unknown>>;
  cache_control?: Record<string, unknown>;
}

export interface GenerationUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  provider_raw?: Record<string, unknown>;
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
  thought_signature?: string;
}

export interface GenerationResponse {
  content: string;
  reasoning?: string;
  finish_reason: string;
  /** Present when the LLM requested function calls instead of (or in addition to) generating text. */
  tool_calls?: ToolCallResult[];
  /** Provider-native reasoning blocks captured this turn (Anthropic), to replay
   *  on tool-use continuations for interleaved thinking. */
  thinking_blocks?: LlmThinkingBlock[];
  /** OpenRouter `reasoning_details` captured this turn, to replay on tool-use
   *  continuations. */
  reasoning_details?: Record<string, unknown>[];
  /**
   * Frame-private provider state. It is intentionally not part of LlmMessage
   * and must never reach persistence, logs, error payloads, or activity DTOs.
   */
  providerTransientCarrier?: ProviderTransientCarrier;
  /** Optional Gemini signature from a non-tool response part. */
  thought_signature?: string;
  usage?: GenerationUsage;
}

export interface StreamChunk {
  token: string;
  reasoning?: string;
  finish_reason?: string;
  /** Accumulated function calls (set on the final chunk when finish_reason indicates tool use). */
  tool_calls?: ToolCallResult[];
  /** Provider-native reasoning blocks (set on the final chunk alongside
   *  tool_calls) — Anthropic thinking blocks with signatures for interleaved
   *  thinking continuations. */
  thinking_blocks?: LlmThinkingBlock[];
  /** OpenRouter `reasoning_details`, accumulated across stream chunks and set on
   *  the final chunk alongside tool_calls. */
  reasoning_details?: Record<string, unknown>[];
  /** Frame-private provider state; never persisted or rendered. */
  providerTransientCarrier?: ProviderTransientCarrier;
  /** Optional Gemini signature from a non-tool response part. */
  thought_signature?: string;
  usage?: GenerationUsage;
}

// --- Prompt Assembly Types ---

export type GenerationType = 'normal' | 'continue' | 'regenerate' | 'swipe' | 'impersonate' | 'quiet';

export type ImpersonateMode = 'prompts' | 'oneliner' | 'sovereign_hand';

/** The authenticated prompt surface for one assembly; callers must provide it explicitly. */
export type AssemblySurfaceV1 = "RESPONSE" | "WORK";

export interface AssemblyContext {
  userId: string;
  /** Pre-resolved authenticated account name used when no persona is selected. */
  userName?: string;
  generationId: string;
  dryRun: boolean;
  chatId: string;
  /** Host-authenticated surface; every assembly caller must set this explicitly. */
  assemblySurface: AssemblySurfaceV1;
  connectionId?: string;
  presetId?: string;
  /** Internal transient preset used by assembly-only callers. Never persisted. */
  presetOverride?: import("../types/preset").Preset;
  /** Skip per-chat/character/connection preset-profile block overrides. */
  skipPresetProfileBinding?: boolean;
  /** Immutable effective preset/profile binding admitted before async sidecar work. */
  effectivePresetSnapshot?: {
    preset: import("../types/preset").Preset | null;
    binding: import("../types/preset-profile").PresetProfileBinding | null;
  };
  /** Whether macro handlers may commit side effects. Defaults to true. */
  macroCommit?: boolean;
  /** When true, bypass preset-profile preset selection and use presetId directly. */
  forcePresetId?: boolean;
  generationType: GenerationType;
  personaId?: string;
  /** Effective persona add-on states for this generation. Applied to a cloned persona only. */
  personaAddonStates?: Record<string, boolean>;
  /** For impersonate: controls how much of the preset is included. */
  impersonateMode?: ImpersonateMode;
  /** For impersonate: free-form user text from the input box, appended to the impersonation prompt. */
  impersonateInput?: string;
  /** Exact input-bar draft snapshot captured when this generation started. */
  userInput?: string;
  /** Persisted user rows that started this normal generation. Identity only. */
  sourceUserMessageIds?: readonly string[];
  /** For regenerate: exclude this message from chat history (it has a blank swipe). */
  excludeMessageId?: string;
  /** For regenerate/swipe: content of the active target swipe before it was replaced. */
  rejectedSwipe?: string;
  /** For continue: source message id of the assistant turn being extended. */
  continueMessageId?: string;
  /** For continue: separator to append to the target in the model prompt and saved reply. */
  continuePostfix?: string;
  /** For group chats: generate a response as this specific character. */
  targetCharacterId?: string;
  /** Council tool results (passed from generate.service when council executes before assembly). */
  councilToolResults?: CouncilToolResultSummary[];
  /** Named council tool results (variable_name → content). */
  councilNamedResults?: Record<string, string>;
  /** Prior retained council deliberations formatted as a historical baseline block. */
  councilHistoricalDeliberationBlock?: string;
  /** Pre-computed vector-activated World Info from the generation pipeline.
   *  Assembly reuses it only when its immutable source fingerprint matches the
   *  current native World Info snapshot. */
  precomputedVectorEntries?: PrecomputedWorldInfoVectorEntries;
  /** User-provided feedback text for regeneration guidance. */
  regenFeedback?: string;
  /** Where to inject regen feedback: 'system' (last system msg) or 'user' (last user msg). */
  regenFeedbackPosition?: "system" | "user";
  /** Freeform prompt template containing the guarded {{$regenInput}} placeholder. */
  regenFeedbackFormat?: string;
  /** When true, an extension owns this chat's `target:prompt` regex and the
   *  host skips its own per-message prompt-regex pass. */
  skipPromptRegex?: boolean;
  /** Pre-fetched data to avoid redundant DB calls during assembly.
   *  When provided, assembly reads from this instead of querying DB. */
  prefetched?: PrefetchedData;
  /** Main-process-only bounded child/tool runtime. Never structured-cloned. */
  agentRuntimeOwner?: AgentRuntimeOwner;
  /** Main-process factory created only after assembly resolves the frozen concrete identity. */
  createAgentRuntimeOwner?: (
    config: AgentConfigV2,
    rootConnection: ResolvedConcreteConnectionV1 | null,
  ) => AgentRuntimeOwner;
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
    bookSourceMap: Map<string, import("../services/world-info-sources.service").BookSource>;
    bookNameMap: Map<string, string>;
    bookMap: Map<string, WorldBook>;
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
  bookSource?: 'character' | 'persona' | 'chat' | 'global' | 'peer';
  bookId?: string;
  bookName?: string;
  activationType?: "constant" | "sticky" | "keyword" | "vector";
  estimatedTokens?: number;
  activationOrder?: number;
  priority?: number;
  position?: number;
  depth?: number;
  preventRecursion?: boolean;
  activationProvenance?: ActivationProvenance;
  firstTriggeredForBook?: boolean;
}

export interface MemoryStats {
  enabled: boolean;
  chunksRetrieved: number;
  chunksAvailable: number;
  chunksPending: number;
  injectionMethod: "macro" | "fallback" | "disabled";
  /** How chunks were retrieved: real vector/hybrid search vs. the recency
   *  fallback (e.g. when the query embedding failed). null score = a
   *  keyword-only or recency hit with no vector distance. */
  retrievalMode?: "vector" | "recency" | "empty" | "disabled";
  retrievedChunks: Array<{
    score: number | null;
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
    score: number | null;
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
  /** True when a context anchor set the first chat-history message the model may read. */
  anchorActive?: boolean;
  /** Exact tokens required by the anchored history tail. */
  protectedHistoryTokens?: number;
  /** Budget remaining after the anchored history tail. Negative means the anchor cannot fit. */
  remainingBeforeAnchor?: number;
  /** True when the anchored history tail cannot fit in the remaining history budget. */
  anchorOverflow?: boolean;
}

export interface AssemblyResult {
  /** Surface used to build this provider message set. */
  assemblySurface: AssemblySurfaceV1;
  /** Owner-only Loom policy/context inspection, including Response omissions. */
  loomPromptInspection?: LoomPromptInspectionV1;
  messages: LlmMessage[];
  breakdown: AssemblyBreakdownEntry[];
  parameters: Record<string, any>;
  /** Whether a directly word-terminated streaming response should lose its final word. */
  trimIncompleteWords?: boolean;
  /** The resolved assistant prefill text (from promptBias / assistantPrefill / assistantImpersonation).
   *  When set, the last message in `messages` is an assistant message containing this text.
   *  The generate service must prepend this to the LLM response content since the model
   *  continues *after* the prefill (it's not included in the model's output). */
  assistantPrefill?: string;
  /** A provider-native `reasoning_content` prefix. The generation service
   * surfaces this before the provider's streamed reasoning tail. */
  assistantReasoningPrefill?: string;
  /** Summary of all world info entries activated during this assembly. */
  activatedWorldInfo?: ActivatedWorldInfoEntry[];
  spindleWorldInfoCaptures?: Record<string, ActivatedWorldInfoEntry[]>;
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
      timingsMs?: {
        queryBuild: number;
        queryEmbed: number;
        search: number;
        ranking: number;
        merge: number;
        total: number;
      };
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
  /**
   * Alternate content used only for prompt-breakdown tokenization. The normal
   * `content` remains the fully resolved text shown in inspectors.
   */
  tokenCountContent?: string;
  /** True when this entry's token-count content delegates marker-mode WI to its World Info rows. */
  attributesWorldInfoMarkerTokens?: boolean;
  /** If true, tokens are displayed but NOT added to the total (e.g. sidecar tokens spent on a separate LLM). */
  excludeFromTotal?: boolean;
  /** Present for prompt blocks injected by Spindle interceptors. */
  extensionId?: string;
  /** Human-readable extension attribution for injected prompt blocks. */
  extensionName?: string;
}
import type { ActivationProvenance } from "../spindle/activation-provenance";
export type { ActivationProvenance, ActivationTraceEntry } from "../spindle/activation-provenance";

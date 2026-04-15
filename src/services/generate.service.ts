import { getProvider } from "../llm/registry";
import type { LlmProvider } from "../llm/provider";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as secretsSvc from "./secrets.service";
import * as connectionsSvc from "./connections.service";
import * as chatsSvc from "./chats.service";
import * as presetsSvc from "./presets.service";
import * as settingsSvc from "./settings.service";
import * as personasSvc from "./personas.service";
import {
  assemblePrompt,
  injectReasoningParams,
  collectVectorActivatedWorldInfo,
  mergeActivatedWorldInfoEntries,
  type VectorActivatedEntry,
} from "./prompt-assembly.service";
import * as charactersSvc from "./characters.service";
import { getEffectiveCharacterName } from "../types/character";
import { getTextContent, type LlmMessage, type GenerationParameters, type GenerationRequest, type GenerationResponse, type StreamChunk, type GenerationType, type ImpersonateMode, type AssemblyBreakdownEntry, type ActivatedWorldInfoEntry, type ToolDefinition } from "../llm/types";
import { interceptorPipeline } from "../spindle/interceptor-pipeline";
import { contextHandlerChain } from "../spindle/context-handler";
import { executeCouncil, collectWorldInfoForCouncil, formatDeliberation, type CouncilEnrichment } from "./council/council-execution.service";
import { activateWorldInfo } from "./world-info-activation.service";
import type { CouncilExecutionResult, CachedCouncilResult } from "lumiverse-spindle-types";
import { getCouncilSettings, getAvailableTools } from "./council/council-settings.service";
import * as tokenizerSvc from "./tokenizer.service";
import * as breakdownSvc from "./breakdown.service";
import * as regexScriptsSvc from "./regex-scripts.service";
import * as pool from "./generation-pool.service";
import { detectExpression, detectMultiCharacterExpression, getExpressionDetectionSettings } from "./expression-detection.service";
import { hasExpressions, getExpressionConfig, getExpressionGroups } from "./expressions.service";
import { getSidecarSettings } from "./sidecar-settings.service";

interface GenerateInput {
  userId: string;
  chat_id: string;
  connection_id?: string;
  persona_id?: string;
  preset_id?: string;
  message_id?: string;
  messages?: LlmMessage[];
  parameters?: GenerationParameters;
  generation_type?: GenerationType;
  impersonate_mode?: ImpersonateMode;
  target_character_id?: string;
  regen_feedback?: string;
  regen_feedback_position?: "system" | "user";
  retain_council?: boolean;
}

/** Lifecycle context passed from startGeneration → runGeneration */
interface GenerationLifecycle {
  /** For regenerate: update swipe on this message instead of creating new */
  targetMessageId?: string;
  /** For regenerate: index of the blank swipe to fill with generated content */
  targetSwipeIdx?: number;
  /** For sidecar council: pre-created empty message to fill with generated content */
  stagedMessageId?: string;
  /** For continue: append to this message's content */
  continueMessageId?: string;
  /** For continue: original content to prepend to generated text */
  continueOriginalContent?: string;
  /** For continue: separator between original content and generated text */
  continuePostfix?: string;
  /** Resolved character name for saved messages */
  characterName: string;
  /** Assembly breakdown for WS event */
  breakdown?: AssemblyBreakdownEntry[];
  /** Generation type used for this run */
  generationType: GenerationType;
  /** Active persona display name (for impersonate saves) */
  personaName?: string;
  /** Active persona id (for impersonate message metadata) */
  personaId?: string;
  /** Target character id (for group chat message attribution) */
  targetCharacterId?: string;
  /** Chat history messages snapshot (used for accurate tokenization in breakdown) */
  chatHistoryMessages?: LlmMessage[];
  /** Model + provider + preset info for breakdown storage */
  model?: string;
  providerName?: string;
  presetName?: string;
  /** Max context from connection parameters (for breakdown display) */
  maxContext?: number;
  /** Council named results (for expression detection and other post-generation hooks) */
  councilNamedResults?: Record<string, string>;
}

export interface RawGenerateInput {
  provider: string;
  model: string;
  messages: LlmMessage[];
  parameters?: GenerationParameters;
  api_url?: string;
  /** Optional: resolve key from a connection instead of global lookup */
  connection_id?: string;
  /** Optional: use this key directly (for extension endpoints) */
  api_key?: string;
  /** Optional tool/function definitions for inline function calling. */
  tools?: ToolDefinition[];
}

export interface QuietGenerateInput {
  messages: LlmMessage[];
  connection_id?: string;
  parameters?: GenerationParameters;
  /** Optional tool/function definitions for inline function calling. */
  tools?: ToolDefinition[];
  /** Optional abort signal — when fired, cancels the in-flight HTTP request. */
  signal?: AbortSignal;
}

export interface DryRunResult {
  messages: LlmMessage[];
  breakdown: AssemblyBreakdownEntry[];
  parameters: Record<string, any>;
  assistantPrefill?: string;
  model: string;
  provider: string;
  tokenCount?: {
    total_tokens: number;
    breakdown: { name: string; type: string; tokens: number; role?: string }[];
    tokenizer_id: string | null;
    tokenizer_name: string | null;
  };
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
    queryPreview: string;
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
  memoryStats?: import("../llm/types").MemoryStats;
}

export interface BatchGenerateInput {
  requests: RawGenerateInput[];
  concurrent?: boolean;
}

export interface BatchResultItem {
  index: number;
  success: boolean;
  content?: string;
  finish_reason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  error?: string;
}

/** Context passed through the Spindle handler chain and interceptor pipeline. */
interface SpindleContext {
  chatId: string;
  connectionId?: string;
  personaId?: string;
  generationType: string;
  activatedWorldInfo?: ActivatedWorldInfoEntry[];
  [key: string]: unknown;
}

/** Result of assembling + post-processing the prompt pipeline. */
interface PromptPipelineResult {
  messages: LlmMessage[];
  parameters: GenerationParameters;
  breakdown?: AssemblyBreakdownEntry[];
  /** Snapshot of chat history messages taken before interceptors/post-processing,
   *  used as the shared tokenization source for both dry-run and generation breakdowns. */
  chatHistoryMessages?: LlmMessage[];
  /** The resolved assistant prefill text. When set, the generate service prepends
   *  this to the LLM response since the model continues after the prefill. */
  assistantPrefill?: string;
  activatedWorldInfo?: ActivatedWorldInfoEntry[];
  worldInfoStats?: DryRunResult["worldInfoStats"];
  memoryStats?: import("../llm/types").MemoryStats;
  deferredWiState?: { chatId: string; partial: Record<string, any> };
  spindleContext: SpindleContext;
  /** True if the {{lumiaCouncilDeliberation}} macro was resolved during assembly. */
  deliberationHandledByMacro?: boolean;
  /** The macro environment built during assembly — used for regex script macro substitution. */
  macroEnv?: import("../macros/types").MacroEnv;
}

/**
 * If the generated content contains an unclosed reasoning/thinking tag
 * (e.g. generation was interrupted mid-thought), append the closing tag
 * so the frontend can properly collapse the reasoning block.
 */
function closeUnterminatedReasoningTags(userId: string, content: string): string {
  if (!content) return content;

  // Get user's configured reasoning tags, fallback to defaults
  const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
  const prefix = ((reasoningSetting?.value?.prefix as string) || "<think>\n").replace(/^\n+|\n+$/g, "");
  const suffix = ((reasoningSetting?.value?.suffix as string) || "\n</think>").replace(/^\n+|\n+$/g, "");

  // Check if content has an opening tag without a matching close
  const lastOpenIdx = content.lastIndexOf(prefix);
  if (lastOpenIdx === -1) return content;

  const afterOpen = content.indexOf(suffix, lastOpenIdx + prefix.length);
  if (afterOpen === -1) {
    // Unclosed tag — append the suffix
    return content + suffix;
  }

  return content;
}

// Track active generations for stop support
const activeGenerations = new Map<string, { controller: AbortController; userId: string; chatId: string; startedAt: number }>();

// Per-chat generation lock: prevents concurrent generations (including council) in the same chat.
// Keyed by `${userId}:${chatId}` → generationId. Registered BEFORE council execution so that
// a second request for the same chat will abort the in-flight one (including its council tools).
const activeChatGenerations = new Map<string, string>();

// Pending council retry decisions: when council tools partially fail, the generation
// pauses and waits for the user to decide whether to continue or retry. Keyed by
// generationId → { resolve, timeout }. The user responds via POST /generate/council-retry.
/** Safety cap: auto-continue after 10 minutes to prevent permanent resource hangs */
const COUNCIL_RETRY_SAFETY_CAP_MS = 10 * 60 * 1000;

const pendingCouncilRetries = new Map<string, {
  resolve: (decision: "continue" | "retry") => void;
  timeout: ReturnType<typeof setTimeout>;
  // H-06: track the owner so a different user cannot resolve this retry.
  userId: string;
}>();

/** Called from the council-retry route to resolve a pending decision. */
export function resolveCouncilRetry(generationId: string, decision: "continue" | "retry", userId: string): boolean {
  const pending = pendingCouncilRetries.get(generationId);
  if (!pending) return false;
  // H-06: Verify that the resolving user is the same user who initiated the
  // generation, preventing one user from resolving another user's pending
  // council decision by guessing or enumerating generation IDs.
  if (pending.userId !== userId) return false;
  clearTimeout(pending.timeout);
  pendingCouncilRetries.delete(generationId);
  // Clear the pool flag
  const poolEntry = pool.getPoolEntry(generationId);
  if (poolEntry) poolEntry.councilRetryPending = false;
  pending.resolve(decision);
  return true;
}

/** Resolve connection profile by ID or fall back to the user's default. */
function resolveConnection(userId: string, connectionId?: string) {
  const connection = connectionId
    ? connectionsSvc.getConnection(userId, connectionId)
    : connectionsSvc.getDefaultConnection(userId);
  if (!connection) {
    throw new Error("No connection profile found. Create one first.");
  }
  return connection;
}

/** Resolve provider and API key from a connection profile. */
async function resolveProviderAndKey(
  userId: string,
  connectionId: string
): Promise<{ provider: LlmProvider; apiKey: string; apiUrl: string }> {
  const connection = connectionsSvc.getConnection(userId, connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const provider = getProvider(connection.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${connection.provider}`);
  }

  const apiKey = await secretsSvc.getSecret(userId, connectionsSvc.connectionSecretKey(connectionId));
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    throw new Error(`No API key found for connection "${connection.name}". Add one via the connection settings.`);
  }

  return { provider, apiKey: apiKey || "", apiUrl: connectionsSvc.resolveEffectiveApiUrl(connection) };
}

/**
 * Shared prompt pipeline: build spindle context, assemble prompt, run
 * interceptors, apply post-processing, and merge parameters.
 */
async function runPromptPipeline(opts: {
  userId: string;
  chatId: string;
  connectionId?: string;
  presetId?: string;
  personaId?: string;
  generationType: string;
  impersonateMode?: ImpersonateMode;
  inputMessages?: LlmMessage[];
  inputParameters?: GenerationParameters;
  excludeMessageId?: string;
  targetCharacterId?: string;
  councilToolResults?: any[];
  councilNamedResults?: Record<string, string>;
  precomputedVectorEntries?: VectorActivatedEntry[];
  regenFeedback?: string;
  regenFeedbackPosition?: "system" | "user";
}): Promise<PromptPipelineResult> {
  // Build spindle context
  let spindleContext: SpindleContext = {
    chatId: opts.chatId,
    connectionId: opts.connectionId,
    personaId: opts.personaId,
    generationType: opts.generationType,
  };
  if (contextHandlerChain.count > 0) {
    spindleContext = await contextHandlerChain.run(spindleContext, opts.userId) as SpindleContext;
  }

  // Build messages: use explicit messages if provided, otherwise assemble from preset
  let messages: LlmMessage[];
  let assembledParams: GenerationParameters = {};
  let breakdown: AssemblyBreakdownEntry[] | undefined;
  let assistantPrefill: string | undefined;
  let activatedWorldInfo: ActivatedWorldInfoEntry[] | undefined;
  let worldInfoStats: DryRunResult["worldInfoStats"] | undefined;
  let memoryStats: import("../llm/types").MemoryStats | undefined;
  let deferredWiState: { chatId: string; partial: Record<string, any> } | undefined;
  let macroEnv: import("../macros/types").MacroEnv | undefined;

  let deliberationHandledByMacro = false;

  if (opts.inputMessages) {
    messages = opts.inputMessages;
  } else {
    // Batch-prefetch all data the assembly pipeline needs in ~7 queries
    // instead of the ~35-40 scattered individual calls inside assemblePrompt
    const { prefetchAssemblyData } = await import("./prompt-assembly-prefetch");
    const prefetched = await prefetchAssemblyData({
      userId: opts.userId,
      chatId: opts.chatId,
      connectionId: opts.connectionId,
      presetId: opts.presetId,
      personaId: opts.personaId,
      generationType: opts.generationType as GenerationType,
      excludeMessageId: opts.excludeMessageId,
      targetCharacterId: opts.targetCharacterId,
    });

    // All presets (classic and lumi) go through the same assembly path
    const assemblyResult = await assemblePrompt({
      userId: opts.userId,
      chatId: opts.chatId,
      connectionId: opts.connectionId,
      presetId: opts.presetId,
      personaId: opts.personaId,
      generationType: opts.generationType as GenerationType,
      impersonateMode: opts.impersonateMode,
      excludeMessageId: opts.excludeMessageId,
      targetCharacterId: opts.targetCharacterId,
      councilToolResults: opts.councilToolResults,
      councilNamedResults: opts.councilNamedResults,
      precomputedVectorEntries: opts.precomputedVectorEntries,
      regenFeedback: opts.regenFeedback,
      regenFeedbackPosition: opts.regenFeedbackPosition,
      prefetched,
    });

    messages = assemblyResult.messages;
    assembledParams = assemblyResult.parameters;
    breakdown = assemblyResult.breakdown;
    assistantPrefill = assemblyResult.assistantPrefill;
    activatedWorldInfo = assemblyResult.activatedWorldInfo;
    worldInfoStats = assemblyResult.worldInfoStats;
    memoryStats = assemblyResult.memoryStats;
    deferredWiState = assemblyResult.deferredWiState;
    deliberationHandledByMacro = !!assemblyResult.deliberationHandledByMacro;
    macroEnv = assemblyResult.macroEnv;
  }

  // Snapshot chat history messages BEFORE interceptors/post-processing can
  // splice, merge, or reorder the array.  This snapshot is the shared
  // tokenization source used by both dry-run and generation breakdowns.
  let chatHistoryMessages: LlmMessage[] | undefined;
  if (breakdown) {
    const chEntry = breakdown.find(e => e.type === "chat_history");
    if (chEntry?.firstMessageIndex != null && chEntry.messageCount && chEntry.messageCount > 0) {
      chatHistoryMessages = messages.slice(
        chEntry.firstMessageIndex,
        chEntry.firstMessageIndex + chEntry.messageCount,
      );
    }
  }

  // Expose activated world info to spindle context
  if (activatedWorldInfo) {
    spindleContext.activatedWorldInfo = activatedWorldInfo;
  }

  // Run Spindle interceptor pipeline on assembled messages
  // The pipeline uses LlmMessageDTO (string-only content) — at this stage
  // multimodal parts have already been serialised so the cast is safe.
  let interceptorParameters: Record<string, unknown> | undefined;
  if (interceptorPipeline.count > 0) {
    const interceptorResult = await interceptorPipeline.run(
      messages as import("lumiverse-spindle-types").LlmMessageDTO[],
      spindleContext,
      opts.userId
    );
    messages = interceptorResult.messages as unknown as LlmMessage[];
    interceptorParameters = interceptorResult.parameters;
  }

  // Apply promptPostProcessing
  const postProcessing = settingsSvc.getSetting(opts.userId, "promptPostProcessing");
  if (postProcessing?.value) {
    applyPostProcessing(messages, postProcessing.value);
  }

  // Apply regex scripts (prompt target)
  {
    const chatForRegex = chatsSvc.getChat(opts.userId, opts.chatId);
    const characterId = opts.targetCharacterId || chatForRegex?.character_id;
    const promptScripts = regexScriptsSvc.getActiveScripts(opts.userId, { characterId, chatId: opts.chatId, target: "prompt" });
    if (promptScripts.length > 0) {
      // Determine chat history bounds for depth calculation
      const chEntry = breakdown?.find(e => e.type === "chat_history");
      const chatHistoryStart = chEntry?.firstMessageIndex ?? 0;
      const chatHistoryCount = chEntry?.messageCount ?? messages.length;

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const placement = msg.role === "user" ? "user_input" as const
          : msg.role === "assistant" ? "ai_output" as const
          : "world_info" as const;

        // Depth: distance from end of chat history portion (0 = latest)
        const isChatHistory = i >= chatHistoryStart && i < chatHistoryStart + chatHistoryCount;
        const depth = isChatHistory ? (chatHistoryStart + chatHistoryCount - 1 - i) : undefined;

        if (typeof msg.content === "string") {
          messages[i] = { ...msg, content: await regexScriptsSvc.applyRegexScripts(msg.content, promptScripts, placement, depth, macroEnv) };
        } else if (Array.isArray(msg.content)) {
          const resolvedParts = await Promise.all(
            msg.content.map(async (part: any) =>
              part.type === "text"
                ? { ...part, text: await regexScriptsSvc.applyRegexScripts(part.text, promptScripts, placement, depth, macroEnv) }
                : part
            ),
          );
          messages[i] = { ...msg, content: resolvedParts };
        }
      }
    }
  }

  // Merge parameters: assembled (from preset) < interceptor overrides < request overrides
  const parameters: GenerationParameters = { ...assembledParams, ...interceptorParameters, ...opts.inputParameters };

  return { messages, parameters, breakdown, chatHistoryMessages, assistantPrefill, activatedWorldInfo, worldInfoStats, memoryStats, deferredWiState, spindleContext, deliberationHandledByMacro, macroEnv };
}

/** Resolve provider and key for raw generate: supports connection_id, direct api_key, or provider-name lookup. */
async function resolveRawProviderAndKey(
  userId: string,
  input: RawGenerateInput
): Promise<{ provider: LlmProvider; apiKey: string; apiUrl: string }> {
  // If a connection_id is provided, use per-connection key
  if (input.connection_id) {
    return resolveProviderAndKey(userId, input.connection_id);
  }

  // If a direct api_key is provided, use it
  if (input.api_key) {
    const provider = getProvider(input.provider);
    if (!provider) throw new Error(`Unknown provider: ${input.provider}`);
    return { provider, apiKey: input.api_key, apiUrl: input.api_url || "" };
  }

  // Fallback: look up provider by name, but there's no global key anymore.
  // For backward compat with extensions that pass provider+api_key inline, require api_key.
  const provider = getProvider(input.provider);
  if (!provider) throw new Error(`Unknown provider: ${input.provider}`);

  if (provider.capabilities.apiKeyRequired) {
    throw new Error(`No API key provided. Pass api_key or connection_id in the request.`);
  }

  return { provider, apiKey: "", apiUrl: input.api_url || "" };
}

export async function startGeneration(input: GenerateInput): Promise<{ generationId: string; status: string }> {
  const generationId = crypto.randomUUID();
  let genType = input.generation_type || "normal";

  // Safety fallback: regenerate/continue should only target an assistant
  // message when the latest chat message is assistant-authored.
  // If the latest message is user (common right after send), treat this as
  // normal generation so we create a new assistant reply instead of mutating
  // an older assistant message (e.g. greeting at index 0).
  // Skip this check when an explicit message_id is provided — the frontend
  // already validated the target.
  if ((genType === "regenerate" || genType === "continue") && !input.message_id) {
    const lastMessage = chatsSvc.getLastMessage(input.userId, input.chat_id);
    if (!lastMessage || lastMessage.is_user) {
      genType = "normal";
    }
  }

  // --- Per-chat generation lock ---
  // Stop any existing generation for this chat (including in-flight council tools)
  // before proceeding. This prevents council re-firing and generation interruption.
  const chatKey = `${input.userId}:${input.chat_id}`;
  const existingGenId = activeChatGenerations.get(chatKey);
  if (existingGenId) {
    const existing = activeGenerations.get(existingGenId);
    if (existing) {
      console.debug("[generate] Aborting existing generation %s for chat %s before starting new one", existingGenId, input.chat_id);
      existing.controller.abort();
    }
    activeGenerations.delete(existingGenId);
    activeChatGenerations.delete(chatKey);
  }

  // Register this generation early (before council) so it can be tracked and aborted
  const abortController = new AbortController();
  activeGenerations.set(generationId, { controller: abortController, userId: input.userId, chatId: input.chat_id, startedAt: Date.now() });
  activeChatGenerations.set(chatKey, generationId);

  // Helper: bail out cleanly if aborted during the setup phase
  const checkAborted = () => {
    if (abortController.signal.aborted) {
      throw new Error("Generation aborted");
    }
  };

  // Hoisted so the catch block can clean up the staged message on abort
  let stagedMessageId: string | undefined;

  try {

  const connection = resolveConnection(input.userId, input.connection_id);
  const { provider, apiKey, apiUrl } = await resolveProviderAndKey(input.userId, connection.id);

  // Resolve character name for saved messages — prefer target_character_id for group chats
  const chat = chatsSvc.getChat(input.userId, input.chat_id);
  let characterName = "Assistant";
  const targetCharId = input.target_character_id || chat?.character_id;
  if (targetCharId) {
    const character = charactersSvc.getCharacter(input.userId, targetCharId);
    if (character) characterName = getEffectiveCharacterName(character);
  }

  // Resolve persona_id from settings if not provided by the frontend, so the
  // persona's attached world book is always included regardless of UI state.
  if (!input.persona_id) {
    const activePersonaSetting = settingsSvc.getSetting(input.userId, "activePersonaId");
    if (activePersonaSetting?.value && typeof activePersonaSetting.value === "string") {
      input.persona_id = activePersonaSetting.value;
    }
  }

  // Resolve target message EARLY (before council) so we can visually clear the
  // message on the frontend before council tools start executing.
  const resolvedPersona = personasSvc.resolvePersonaOrDefault(input.userId, input.persona_id);

  const lifecycle: GenerationLifecycle = {
    characterName,
    generationType: genType,
    personaId: resolvedPersona?.id,
    personaName: resolvedPersona?.name || "User",
    targetCharacterId: targetCharId,
  };

  let excludeMessageId: string | undefined;

  if (genType === "regenerate") {
    const targetMsg = input.message_id
      ? chatsSvc.getMessage(input.userId, input.message_id)
      : chatsSvc.getLastAssistantMessage(input.userId, input.chat_id);
    if (targetMsg) {
      lifecycle.targetMessageId = targetMsg.id;
      excludeMessageId = targetMsg.id;
      // Add a blank swipe immediately so the frontend shows cleared content
      // before council/assembly begins (MESSAGE_SWIPED event fires now).
      const withBlank = chatsSvc.addSwipe(input.userId, targetMsg.id, "");
      lifecycle.targetSwipeIdx = withBlank ? withBlank.swipe_id : 0;
      // Clear stale generation metrics from the previous swipe so the pill
      // doesn't display outdated values while the new generation runs.
      // Uses patchMessageExtra to avoid triggering chunk rebuilds / WS events.
      const prevExtra = targetMsg.extra;
      if (prevExtra && (prevExtra.tokenCount != null || prevExtra.generationMetrics || prevExtra.usage || prevExtra.reasoning || prevExtra.reasoningDuration)) {
        const { tokenCount: _, generationMetrics: _gm, usage: _u, reasoning: _r, reasoningDuration: _rd, ...cleanExtra } = prevExtra;
        chatsSvc.patchMessageExtra(input.userId, targetMsg.id, cleanExtra);
      }
    }
  } else if (genType === "continue") {
    const lastMsg = chatsSvc.getLastAssistantMessage(input.userId, input.chat_id);
    if (lastMsg) {
      lifecycle.continueMessageId = lastMsg.id;
      lifecycle.continueOriginalContent = lastMsg.content;
      // Resolve continuePostfix from the preset's completion settings so it can
      // be inserted between original content and generated text when saving.
      const cpPresetId = input.preset_id || connection.preset_id;
      const cpPreset = cpPresetId ? presetsSvc.getPreset(input.userId, cpPresetId) : null;
      lifecycle.continuePostfix = cpPreset?.prompts?.completionSettings?.continuePostfix || "";
    }
  }

  // Register pool entry for recovery — at this point we have all the metadata
  pool.createPoolEntry({
    generationId,
    userId: input.userId,
    chatId: input.chat_id,
    generationType: genType,
    characterName,
    characterId: targetCharId,
    model: connection.model,
    targetMessageId: lifecycle.targetMessageId,
  });

  // Emit GENERATION_STARTED immediately so the frontend can show a chat head
  // and streaming indicator BEFORE prompt assembly (which may involve slow
  // embedding calls, council sidecar, etc.). Without this, navigating away
  // during assembly leaves no chat head and the UI appears stuck.
  eventBus.emit(EventType.GENERATION_STARTED, {
    generationId,
    chatId: input.chat_id,
    model: connection.model,
    targetMessageId: lifecycle.targetMessageId,
    characterId: targetCharId,
    characterName,
  }, input.userId);

  // ── Return the HTTP response NOW ──────────────────────────────────────
  // Council execution, prompt assembly, and embedding calls can take 10-60s+.
  // Holding the HTTP response open for that duration blocks the frontend's
  // connection pool and makes the UI appear frozen when the user navigates
  // away. By returning immediately, the frontend gets the generationId and
  // can track progress via WS events + the pool status endpoint.
  //
  // The remaining heavy work (council → assembly → streaming) runs as a
  // detached async continuation. Errors are surfaced via GENERATION_ENDED
  // with an error payload.
  void (async () => {
    // Yield to the macro task queue IMMEDIATELY so that the HTTP response
    // (`return { generationId, status: "streaming" }` below) is sent before
    // any assembly work begins.  Without this, JavaScript's async execution
    // model runs everything between here and the first internal `await`
    // synchronously — which can include council settings, all DB prefetch
    // queries, world-info activation, and more — blocking the event loop
    // and delaying the response (and every other request) until that first
    // internal `await` yields.
    await new Promise<void>(r => setTimeout(r, 0));
    try {

  // Execute council if enabled (before prompt assembly so it doesn't slow the critical path visibly)
  const councilSettings = getCouncilSettings(input.userId);
  let councilResult: CouncilExecutionResult | null = null;
  let inlineTools: ToolDefinition[] | undefined;
  let precomputedVectorEntries: VectorActivatedEntry[] | undefined;

  // Council is active when enabled with members. Tools run if any member has tools assigned.
  const councilActive = councilSettings.councilMode
    && councilSettings.members.length > 0;
  const councilHasTools = councilActive
    && councilSettings.members.some((m) => m.tools.length > 0);

  if (councilHasTools) {
    pool.setPoolStatus(generationId, "council");
    if (councilSettings.toolsSettings.mode === "inline") {
      // Inline mode requires enableFunctionCalling in the preset's completion
      // settings — the tools are registered as native function calls with the
      // primary LLM. Sidecar mode has no such requirement.
      const presetId = input.preset_id || connection.preset_id;
      const preset = presetId ? presetsSvc.getPreset(input.userId, presetId) : null;
      const completionSettings = preset?.prompts?.completionSettings;
      if (completionSettings?.enableFunctionCalling === false) {
        console.warn("[council] Inline tools skipped: enableFunctionCalling is disabled in preset '%s'", preset?.name);
      } else {
        const availableTools = await getAvailableTools(input.userId);
        const activeMembers = councilSettings.members.filter((m) => m.tools.length > 0);
        inlineTools = [];
        for (const member of activeMembers) {
          for (const toolName of member.tools) {
            const toolDef = availableTools.find((t) => t.name === toolName);
            if (!toolDef) continue;
            inlineTools.push({
              name: `${member.id.slice(0, 8)}_${toolDef.name}`,
              description: `[${member.itemName}${member.role ? ` - ${member.role}` : ''}] ${toolDef.description}`,
              parameters: toolDef.inputSchema,
            });
          }
        }
        if (inlineTools.length === 0) inlineTools = undefined;
      }
    } else {
      // Check if we can reuse cached council results for regens/swipes/continues
      const shouldRetain = councilSettings.toolsSettings.retainResultsForRegens
        && (genType === "regenerate" || genType === "swipe" || genType === "continue" || input.retain_council);
      const cached = shouldRetain
        ? (chat?.metadata?.last_council_results as CachedCouncilResult | undefined)
        : undefined;

      if (cached?.results?.length) {
        // Reuse cached council results — skip execution entirely
        console.debug(
          "[council] Reusing cached results for %s (cachedAt=%d, results=%d)",
          genType,
          cached.cachedAt,
          cached.results.length,
        );
        councilResult = {
          results: cached.results,
          deliberationBlock: cached.deliberationBlock,
          totalDurationMs: 0,
        };
      } else {
        // Sidecar mode: stage an empty assistant message BEFORE council execution
        // so the frontend has a real message bubble to stream tokens into. Without
        // this, the HTTP response (and thus startStreaming) arrives after council
        // completes, racing with WS events that may have already finished.
        if (genType === "normal" || genType === "swipe") {
          const extra: Record<string, any> = {};
          if (input.target_character_id) extra.character_id = input.target_character_id;
          const stagedMsg = chatsSvc.createMessage(input.chat_id, {
            is_user: false,
            name: characterName,
            content: "",
            extra: Object.keys(extra).length > 0 ? extra : undefined,
          }, input.userId);
          // Park the staged message ID so runGeneration updates it instead of
          // creating a second message. targetMessageId without targetSwipeIdx
          // signals a staged-message update (as opposed to regeneration).
          stagedMessageId = stagedMsg.id;
        }

        checkAborted();

        // Yield before the heavy council enrichment phase — the next section
        // loads all messages, collects world info entries, and runs keyword
        // activation synchronously. Without a yield here the event loop is
        // blocked from the setTimeout at the top of the IIFE through all of
        // this sync work until the first real `await` (embedding API call).
        await new Promise<void>(r => setTimeout(r, 0));
        checkAborted();

        // Pre-compute enrichment for council tools — resolve world info at the
        // top of the generation chain so tools receive proper world book context.
        // Also filters out the staged empty message and excluded (regenerated)
        // message so council doesn't see blank assistant turns.
        const fullCharacter = chat
          ? charactersSvc.getCharacter(input.userId, targetCharId || chat.character_id)
          : null;
        const councilMessages = chatsSvc.getMessages(input.userId, input.chat_id)
          .filter(m => m.id !== excludeMessageId && m.id !== stagedMessageId);
        const { entries: wiEntries, worldBookIds: wiBookIds } = collectWorldInfoForCouncil(input.userId, fullCharacter, resolvedPersona, input.chat_id);
        let councilWiActivated = wiEntries.length > 0
          ? activateWorldInfo({
              entries: wiEntries,
              messages: councilMessages,
              chatTurn: councilMessages.length,
              wiState: {},
            }).activatedEntries
          : [];

        // Run vector retrieval so council also sees vectorized world info entries.
        // Also cached for prompt assembly to reuse (avoids redundant embedding queries).
        const vectorActivated = await collectVectorActivatedWorldInfo(
          input.userId,
          wiBookIds,
          wiEntries,
          councilMessages,
        );
        councilWiActivated = mergeActivatedWorldInfoEntries(
          councilWiActivated,
          vectorActivated,
        ).activatedEntries;

        // Cache for assembly to reuse
        precomputedVectorEntries = vectorActivated;

        console.debug(
          "[generate] Council enrichment: char=%s, persona=%s, messages=%d, wi=%d/%d, vector=%d",
          fullCharacter?.name ?? "none",
          resolvedPersona?.name ?? "none",
          councilMessages.length,
          councilWiActivated.length,
          wiEntries.length,
          vectorActivated.length,
        );

        const councilEnrichment: CouncilEnrichment = {
          character: fullCharacter,
          persona: resolvedPersona,
          messages: councilMessages,
          activatedWorldInfoEntries: councilWiActivated,
        };

        // Execute pre-generation tool calls (abort-aware)
        councilResult = await executeCouncil({
          userId: input.userId,
          chatId: input.chat_id,
          personaId: input.persona_id,
          connectionId: input.connection_id,
          settings: councilSettings,
          signal: abortController.signal,
          enrichment: councilEnrichment,
        });

        checkAborted();

        // Check for partial failures — if some tools failed, ask the user whether
        // to continue with partial results or retry the broken tools.
        if (councilResult) {
          const failedResults = councilResult.results.filter((r) => !r.success);
          if (failedResults.length > 0 && failedResults.length < councilResult.results.length) {
            // Partial failure — emit event and wait for user decision
            eventBus.emit(EventType.COUNCIL_TOOLS_FAILED, {
              generationId,
              chatId: input.chat_id,
              failedTools: failedResults.map((r) => ({
                memberId: r.memberId,
                memberName: r.memberName,
                toolName: r.toolName,
                toolDisplayName: r.toolDisplayName,
                error: r.error,
              })),
              successCount: councilResult.results.length - failedResults.length,
              failedCount: failedResults.length,
            }, input.userId);

            // Mark pool entry so the active endpoint surfaces the pending state to chat heads
            const poolEntry = pool.getPoolEntry(generationId);
            if (poolEntry) poolEntry.councilRetryPending = true;

            // Pause indefinitely — no short timer. The frontend controls when to
            // show the modal (only when the user navigates to this chat). A 10-minute
            // safety cap prevents permanent resource hangs if the user never responds.
            const decision = await new Promise<"continue" | "retry">((resolve) => {
              const timeout = setTimeout(() => {
                console.debug("[council] Safety cap reached for %s — auto-continuing", generationId);
                pendingCouncilRetries.delete(generationId);
                if (poolEntry) poolEntry.councilRetryPending = false;
                resolve("continue");
              }, COUNCIL_RETRY_SAFETY_CAP_MS);
              pendingCouncilRetries.set(generationId, { resolve, timeout, userId: input.userId });
            });

            checkAborted();

            if (decision === "retry") {
              console.debug("[council] User chose retry — re-executing %d failed tools", failedResults.length);
              // Re-execute only the failed tools by creating a retry run
              const retryResult = await executeCouncil({
                userId: input.userId,
                chatId: input.chat_id,
                personaId: input.persona_id,
                connectionId: input.connection_id,
                settings: councilSettings,
                signal: abortController.signal,
                enrichment: councilEnrichment,
                retryToolNames: failedResults.map((r) => r.toolName),
              });

              checkAborted();

              if (retryResult) {
                // Merge: replace failed results with retry results, keep original successes
                const retryResultMap = new Map(retryResult.results.map((r) => [`${r.memberId}:${r.toolName}`, r]));
                const mergedResults = councilResult.results.map((r) => {
                  if (!r.success) {
                    const retried = retryResultMap.get(`${r.memberId}:${r.toolName}`);
                    return retried ?? r;
                  }
                  return r;
                });

                // Rebuild the deliberation block from the full merged result set
                const allTools = await getAvailableTools(input.userId);
                const toolsMap = new Map(allTools.map((t) => [t.name, t]));
                councilResult = {
                  results: mergedResults,
                  deliberationBlock: formatDeliberation(mergedResults, toolsMap),
                  totalDurationMs: councilResult.totalDurationMs + retryResult.totalDurationMs,
                };
              }
            } else {
              console.debug("[council] User chose continue — proceeding with %d successful results", councilResult.results.length - failedResults.length);
            }
          }
        }
      }
    }
  }

  // Wire staged message into lifecycle so GENERATION_STARTED includes it as
  // targetMessageId and runGeneration knows to update instead of create.
  if (stagedMessageId) {
    lifecycle.stagedMessageId = stagedMessageId;
    lifecycle.targetMessageId = stagedMessageId;
    // Exclude the staged (empty) message from prompt assembly so the LLM
    // doesn't see a blank assistant turn at the end of the conversation.
    excludeMessageId = stagedMessageId;
  }

  // Extract council results for macro access
  let councilToolResults: any[] | undefined;
  let councilNamedResults: Record<string, string> | undefined;
  if (councilResult?.results) {
    councilToolResults = councilResult.results;
    councilNamedResults = {};
    for (const r of councilResult.results) {
      if (r.success && (r as any).resultVariable) {
        councilNamedResults[(r as any).resultVariable] = r.content;
      }
    }

    // Persist council results to chat metadata for potential reuse on regens/swipes.
    // Only cache when results were freshly executed (totalDurationMs > 0 distinguishes
    // a live execution from a cache hit which sets totalDurationMs to 0).
    if (councilResult.totalDurationMs > 0) {
      const cachedResult: CachedCouncilResult = {
        results: councilResult.results,
        deliberationBlock: councilResult.deliberationBlock,
        namedResults: councilNamedResults,
        cachedAt: Date.now(),
      };
      try {
        // Atomic merge so we don't clobber concurrent user edits to chat
        // metadata (alternate field selections, world book attachments, etc.)
        // that landed while the council was running.
        chatsSvc.mergeChatMetadata(input.userId, input.chat_id, {
          last_council_results: cachedResult,
        });
      } catch (err) {
        console.warn("[council] Failed to cache results to chat metadata:", err);
      }
    }
  }

  checkAborted();

  // Run shared prompt pipeline — cortex retrieval runs concurrently inside assembly.
  const pipeline = await runPromptPipeline({
    userId: input.userId,
    chatId: input.chat_id,
    connectionId: input.connection_id,
    presetId: input.preset_id,
    personaId: input.persona_id,
    generationType: genType,
    impersonateMode: genType === "impersonate" ? (input.impersonate_mode || "prompts") : undefined,
    inputMessages: input.messages,
    inputParameters: input.parameters,
    excludeMessageId,
    targetCharacterId: input.target_character_id,
    councilToolResults,
    councilNamedResults,
    precomputedVectorEntries,
    regenFeedback: input.regen_feedback,
    regenFeedbackPosition: input.regen_feedback_position,
  });

  let { messages } = pipeline;
  const { parameters: mergedParams, breakdown, activatedWorldInfo, deliberationHandledByMacro } = pipeline;

  // Persist deferred WI state and dirty chat variables after assembly.
  // Both go through mergeChatMetadata so that any user-driven metadata edits
  // (alternate field selections, world book attachments, etc.) that landed
  // during generation survive these background writes.
  {
    const partial: Record<string, any> = { ...(pipeline.deferredWiState?.partial ?? {}) };
    if (pipeline.macroEnv?._chatVarsDirty) {
      partial.chat_variables = Object.fromEntries(pipeline.macroEnv.variables.chat);
    }
    if (Object.keys(partial).length > 0) {
      chatsSvc.mergeChatMetadata(
        input.userId,
        pipeline.deferredWiState?.chatId ?? input.chat_id,
        partial,
      );
    }
  }

  // Emit activated world info event (always emit so UI can clear stale entries)
  if (activatedWorldInfo) {
    eventBus.emit(EventType.WORLD_INFO_ACTIVATED, {
      chatId: input.chat_id,
      entries: activatedWorldInfo,
      stats: pipeline.worldInfoStats,
    }, input.userId);
  }

  // Inject council deliberation block into assembled messages (fallback for presets
  // that don't use {{lumiaCouncilDeliberation}} macro)
  if (councilResult?.deliberationBlock && !deliberationHandledByMacro) {
    const insertIdx = Math.max(0, messages.length - 4);
    messages.splice(insertIdx, 0, {
      role: "system",
      content: councilResult.deliberationBlock,
    });
  }

  // Attach assembly metadata to lifecycle
  lifecycle.breakdown = breakdown;
  lifecycle.chatHistoryMessages = pipeline.chatHistoryMessages;
  lifecycle.model = connection.model;
  lifecycle.providerName = provider.name;
  lifecycle.maxContext = mergedParams.max_context_length as number | undefined;
  lifecycle.councilNamedResults = councilNamedResults;

  // Strip internal-only keys before they reach the provider
  delete mergedParams.max_context_length;

  // Inject connection-level metadata flags into parameters (e.g. use_responses_api)
  if (connection.metadata?.use_responses_api) {
    mergedParams.use_responses_api = true;
  }

  // Inject OpenRouter-specific settings from connection metadata
  if (connection.provider === "openrouter" && connection.metadata?.openrouter) {
    mergedParams._openrouter = connection.metadata.openrouter;
  }

  // Resolve preset name for breakdown display
  const presetId = input.preset_id || connection.preset_id;
  if (presetId) {
    const preset = presetsSvc.getPreset(input.userId, presetId);
    if (preset) lifecycle.presetName = preset.name;
  }

  // Run generation in the background
  runGeneration(generationId, provider, apiKey, apiUrl, connection.model, messages, mergedParams, input.userId, input.chat_id, lifecycle, abortController.signal, inlineTools, pipeline.assistantPrefill, pipeline.macroEnv);

    } catch (err: any) {
      // Clean up tracking maps if setup (council, assembly, etc.) fails or is aborted
      activeGenerations.delete(generationId);
      activeChatGenerations.delete(chatKey);

      // Clean up any pending council retry decision
      const pendingRetry = pendingCouncilRetries.get(generationId);
      if (pendingRetry) {
        clearTimeout(pendingRetry.timeout);
        pendingCouncilRetries.delete(generationId);
      }

      // If this was a user-initiated abort (stop request), emit proper events so the
      // frontend can reset its streaming state and clean up.
      if (abortController.signal.aborted) {
        // Clean up staged message if one was created (sidecar council mode)
        if (stagedMessageId) {
          try {
            chatsSvc.deleteMessage(input.userId, stagedMessageId);
          } catch { /* best-effort cleanup */ }
        }
        pool.stopPool(generationId);
        eventBus.emit(EventType.GENERATION_STOPPED, {
          generationId,
          chatId: input.chat_id,
          content: "",
        }, input.userId);
        return;
      }

      pool.errorPool(generationId, err.message);
      eventBus.emit(EventType.GENERATION_ENDED, {
        generationId,
        chatId: input.chat_id,
        error: err.message,
      }, input.userId);
    }
  })();

  return { generationId, status: "streaming" };

  } catch (err: any) {
    // Early setup failure (before the async continuation) — connection
    // resolution, character lookup, swipe creation, etc.
    activeGenerations.delete(generationId);
    activeChatGenerations.delete(chatKey);
    pool.errorPool(generationId, err.message);
    throw err;
  }
}

/**
 * Dry-run generation: assemble the full prompt (with macro resolution,
 * world info, post-processing, interceptors) but stop before the LLM call.
 * Council is skipped because it is expensive and hits the LLM.
 */
export async function dryRunGeneration(input: GenerateInput): Promise<DryRunResult> {
  const genType = input.generation_type || "normal";

  // Resolve persona_id from settings if not provided (same as startGeneration)
  if (!input.persona_id) {
    const activePersonaSetting = settingsSvc.getSetting(input.userId, "activePersonaId");
    if (activePersonaSetting?.value && typeof activePersonaSetting.value === "string") {
      input.persona_id = activePersonaSetting.value;
    }
  }

  const connection = resolveConnection(input.userId, input.connection_id);
  const { provider } = await resolveProviderAndKey(input.userId, connection.id);

  const pipeline = await runPromptPipeline({
    userId: input.userId,
    chatId: input.chat_id,
    connectionId: input.connection_id,
    presetId: input.preset_id,
    personaId: input.persona_id,
    generationType: genType,
    impersonateMode: genType === "impersonate" ? (input.impersonate_mode || "prompts") : undefined,
    inputMessages: input.messages,
    inputParameters: input.parameters,
  });

  // Compute token counts for the breakdown
  let tokenCount: DryRunResult["tokenCount"];
  if (pipeline.breakdown && pipeline.breakdown.length > 0) {
    try {
      tokenCount = await tokenizerSvc.countBreakdown(connection.model, pipeline.breakdown, pipeline.chatHistoryMessages);
    } catch {
      // non-fatal: skip token count if tokenizer fails
    }
  }

  // Build ground-truth outbound parameters: strip internal-only keys that
  // never reach the provider, and inject defaults the provider would add.
  const outboundParams: Record<string, any> = { ...pipeline.parameters };
  delete outboundParams.max_context_length;
  delete outboundParams._include_usage;

  // Providers with requiresMaxTokens inject a default when max_tokens is absent
  if (provider.capabilities.requiresMaxTokens && outboundParams.max_tokens === undefined) {
    outboundParams.max_tokens = provider.capabilities.parameters.max_tokens?.default ?? 4096;
  }

  return {
    messages: pipeline.messages,
    breakdown: pipeline.breakdown || [],
    parameters: outboundParams,
    assistantPrefill: pipeline.assistantPrefill,
    model: connection.model,
    provider: provider.name,
    tokenCount,
    worldInfoStats: pipeline.worldInfoStats,
    memoryStats: pipeline.memoryStats,
  };
}

async function runGeneration(
  generationId: string,
  provider: import("../llm/provider").LlmProvider,
  apiKey: string,
  apiUrl: string,
  model: string,
  messages: LlmMessage[],
  parameters: GenerationParameters,
  userId: string,
  chatId: string,
  lifecycle: GenerationLifecycle,
  signal: AbortSignal,
  tools?: ToolDefinition[],
  assistantPrefill?: string,
  macroEnv?: import("../macros/types").MacroEnv,
): Promise<void> {
  // GENERATION_STARTED was already emitted when the pool entry was created
  // (before assembly). Now update to streaming status and push breakdown data.
  pool.setPoolStatus(generationId, "streaming");
  eventBus.emit(EventType.GENERATION_STARTED, {
    generationId, chatId, model,
    breakdown: lifecycle.breakdown,
    targetMessageId: lifecycle.targetMessageId,
    characterId: lifecycle.targetCharacterId,
    characterName: lifecycle.characterName,
  }, userId);

  let fullContent = "";
  let fullReasoning = "";

  let streamUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
  let reasoningStartedAt = 0;
  let reasoningDurationMs = 0;

  // ── Guided CoT detection ───────────────────────────────────────────
  // When autoParse is enabled, detect the user's configured reasoning
  // prefix/suffix in the content stream. Separates guided CoT (prompt-
  // engineered reasoning tags) into fullReasoning + reasoning WS events,
  // keeping fullContent clean. Native provider reasoning (chunk.reasoning)
  // bypasses this — it's already separated at the provider level.
  const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
  const cotAutoParse = reasoningSetting?.value?.autoParse === true;
  const cotPrefix = cotAutoParse
    ? ((reasoningSetting?.value?.prefix as string) || "<think>\n").replace(/^\n+|\n+$/g, "")
    : "";
  const cotSuffix = cotAutoParse
    ? ((reasoningSetting?.value?.suffix as string) || "\n</think>").replace(/^\n+|\n+$/g, "")
    : "";
  let cotPhase: "detecting" | "reasoning" | "content" = cotAutoParse && cotPrefix ? "detecting" : "content";
  let cotDetectBuffer = "";
  let cotSuffixBuffer = "";

  function emitContentToken(text: string) {
    if (!text) return;
    if (reasoningStartedAt && !reasoningDurationMs) {
      reasoningDurationMs = Date.now() - reasoningStartedAt;
    }
    fullContent += text;
    const seq = pool.appendPoolContent(generationId, text);
    eventBus.emit(EventType.STREAM_TOKEN_RECEIVED, {
      generationId, chatId, token: text, seq,
    }, userId);
  }

  function emitReasoningToken(text: string) {
    if (!text) return;
    if (!reasoningStartedAt) reasoningStartedAt = Date.now();
    fullReasoning += text;
    const seq = pool.appendPoolReasoning(generationId, text);
    eventBus.emit(EventType.STREAM_TOKEN_RECEIVED, {
      generationId, chatId, token: text, type: "reasoning", seq,
    }, userId);
  }

  function processReasoningChunk(token: string) {
    cotSuffixBuffer += token;
    const suffixIdx = cotSuffixBuffer.indexOf(cotSuffix);
    if (suffixIdx !== -1) {
      emitReasoningToken(cotSuffixBuffer.slice(0, suffixIdx));
      const afterSuffix = cotSuffixBuffer.slice(suffixIdx + cotSuffix.length);
      cotPhase = "content";
      cotSuffixBuffer = "";
      if (afterSuffix) emitContentToken(afterSuffix);
    } else {
      // Emit chars that can't be part of the suffix (safe lookback)
      const safe = cotSuffixBuffer.length - cotSuffix.length;
      if (safe > 0) {
        emitReasoningToken(cotSuffixBuffer.slice(0, safe));
        cotSuffixBuffer = cotSuffixBuffer.slice(safe);
      }
    }
  }

  function processContentToken(token: string) {
    if (cotPhase === "content") {
      if (!cotPrefix) {
        emitContentToken(token);
        return;
      }
      // Scan content for reasoning prefix re-entry (handles mid-response thinking tags)
      cotDetectBuffer += token;
      const prefixIdx = cotDetectBuffer.indexOf(cotPrefix);
      if (prefixIdx !== -1) {
        // Full prefix found — emit content before it, switch to reasoning
        if (prefixIdx > 0) emitContentToken(cotDetectBuffer.slice(0, prefixIdx));
        cotPhase = "reasoning";
        const afterPrefix = cotDetectBuffer.slice(prefixIdx + cotPrefix.length);
        cotDetectBuffer = "";
        if (afterPrefix) processReasoningChunk(afterPrefix);
        return;
      }
      // Check if the buffer tail could be the start of the prefix (partial match)
      let partialLen = Math.min(cotDetectBuffer.length, cotPrefix.length - 1);
      while (partialLen > 0) {
        if (cotPrefix.startsWith(cotDetectBuffer.slice(-partialLen))) break;
        partialLen--;
      }
      // Emit everything that's definitely content (not a potential prefix start)
      const safeLen = cotDetectBuffer.length - partialLen;
      if (safeLen > 0) {
        emitContentToken(cotDetectBuffer.slice(0, safeLen));
        cotDetectBuffer = cotDetectBuffer.slice(safeLen);
      }
      return;
    }
    if (cotPhase === "detecting") {
      cotDetectBuffer += token;
      const trimmed = cotDetectBuffer.trimStart();
      if (trimmed.length >= cotPrefix.length && trimmed.startsWith(cotPrefix)) {
        cotPhase = "reasoning";
        const afterPrefix = trimmed.slice(cotPrefix.length);
        cotDetectBuffer = "";
        if (afterPrefix) processReasoningChunk(afterPrefix);
      } else if (cotPrefix.startsWith(trimmed)) {
        // Partial match — keep buffering
      } else {
        // No prefix at response start — switch to content which also scans for prefix
        cotPhase = "content";
        const buf = cotDetectBuffer;
        cotDetectBuffer = "";
        processContentToken(buf);
      }
      return;
    }
    processReasoningChunk(token);
  }

  function flushCotBuffers() {
    if (cotDetectBuffer) {
      if (cotPhase === "reasoning") {
        emitReasoningToken(cotDetectBuffer);
      } else {
        emitContentToken(cotDetectBuffer);
      }
      cotDetectBuffer = "";
    }
    if (cotPhase === "reasoning" && cotSuffixBuffer) {
      emitReasoningToken(cotSuffixBuffer);
      cotSuffixBuffer = "";
    }
    cotPhase = "content";
  }

  // Route the assistant prefill ("Start Reply With") through the CoT detection
  // state machine before the model's stream begins. The model continues *after*
  // the prefill, so the prefill text is not included in the model's output —
  // we still need to surface it to the frontend and include it in the saved
  // content/reasoning. Running it through processContentToken ensures that if
  // the prefill is (or starts with) the configured reasoning prefix, it's
  // classified as reasoning from the first token instead of leaking into the
  // content bubble and then being re-extracted by the post-parse safety net.
  if (assistantPrefill) {
    processContentToken(assistantPrefill);
  }

  // Determine streaming mode from _streaming parameter (defaults to true)
  const useStreaming = parameters._streaming !== false;
  delete parameters._streaming;

  // Record streaming mode on the pool entry for metrics
  const poolEntry = pool.getPoolEntry(generationId);
  if (poolEntry) poolEntry.wasStreaming = useStreaming;

  try {
    // Non-streaming path: call generate() once, then synthesize a single-chunk stream
    const stream: AsyncGenerator<StreamChunk, void, unknown> = useStreaming
      ? provider.generateStream(apiKey, apiUrl, { messages, model, parameters, stream: true, tools, signal })
      : (async function* () {
          const result = await provider.generate(apiKey, apiUrl, { messages, model, parameters, stream: false, tools, signal });
          yield {
            token: result.content,
            reasoning: result.reasoning,
            finish_reason: result.finish_reason,
            tool_calls: result.tool_calls,
            usage: result.usage,
          };
        })();

    for await (const chunk of stream) {
      if (signal.aborted) {
        // Flush any buffered CoT tokens before saving partial content
        flushCotBuffers();
        // Close unclosed reasoning tags so the frontend can properly collapse them
        let closedContent = closeUnterminatedReasoningTags(userId, fullContent);

        // Apply regex scripts (response target) to partial content on abort
        {
          const responseScripts = regexScriptsSvc.getActiveScripts(userId, {
            characterId: lifecycle.targetCharacterId,
            chatId,
            target: "response",
          });
          if (responseScripts.length > 0) {
            closedContent = await regexScriptsSvc.applyRegexScripts(closedContent, responseScripts, "ai_output", 0, macroEnv);
            if (fullReasoning) {
              fullReasoning = await regexScriptsSvc.applyRegexScripts(fullReasoning, responseScripts, "reasoning", 0, macroEnv);
            }
          }
        }

        if (lifecycle.targetMessageId && lifecycle.targetSwipeIdx != null) {
          chatsSvc.updateSwipe(userId, lifecycle.targetMessageId, lifecycle.targetSwipeIdx, closedContent);
          // Persist partial reasoning on abort for regenerate (extra-only, no chunk rebuild needed)
          if (fullReasoning) {
            const existingExtra = chatsSvc.getMessage(userId, lifecycle.targetMessageId)?.extra || {};
            chatsSvc.patchMessageExtra(userId, lifecycle.targetMessageId, { ...existingExtra, reasoning: fullReasoning });
          }
        } else if (lifecycle.stagedMessageId) {
          // Preserve existing extra (character_id etc.) and save partial reasoning
          const existingStagedExtra = chatsSvc.getMessage(userId, lifecycle.stagedMessageId)?.extra || {};
          const abortExtra = fullReasoning ? { ...existingStagedExtra, reasoning: fullReasoning } : existingStagedExtra;
          chatsSvc.updateMessage(userId, lifecycle.stagedMessageId, {
            content: closedContent,
            ...(Object.keys(abortExtra).length > 0 ? { extra: abortExtra } : {}),
          });
        } else if (lifecycle.continueMessageId && closedContent) {
          // Continue aborted: merge partial content into existing assistant message
          const abortCombined = (lifecycle.continueOriginalContent ?? "") + (lifecycle.continuePostfix ?? "") + closedContent;
          const existingContinueExtra = chatsSvc.getMessage(userId, lifecycle.continueMessageId)?.extra;
          const continueAbortExtra = fullReasoning ? { ...existingContinueExtra, reasoning: fullReasoning } : undefined;
          chatsSvc.updateMessage(userId, lifecycle.continueMessageId, { content: abortCombined, ...(continueAbortExtra ? { extra: continueAbortExtra } : {}) });
        } else if (closedContent) {
          // Normal generation with no staged message — save partial content as a new message
          const isImpersonate = lifecycle.generationType === "impersonate";
          const extra: Record<string, any> = {};
          if (isImpersonate && lifecycle.personaId) extra.persona_id = lifecycle.personaId;
          if (!isImpersonate && lifecycle.targetCharacterId) extra.character_id = lifecycle.targetCharacterId;
          if (fullReasoning) extra.reasoning = fullReasoning;
          chatsSvc.createMessage(chatId, {
            is_user: isImpersonate,
            name: isImpersonate ? (lifecycle.personaName || "User") : lifecycle.characterName,
            content: closedContent,
            extra: Object.keys(extra).length > 0 ? extra : undefined,
          }, userId);
        }
        pool.stopPool(generationId);
        eventBus.emit(EventType.GENERATION_STOPPED, { generationId, chatId, content: closedContent }, userId);
        break;
      }

      // Emit reasoning tokens (provider thinking/extended thinking)
      if (chunk.reasoning) {
        if (!reasoningStartedAt) reasoningStartedAt = Date.now();
        fullReasoning += chunk.reasoning;
        const seq = pool.appendPoolReasoning(generationId, chunk.reasoning);
        eventBus.emit(EventType.STREAM_TOKEN_RECEIVED, {
          generationId,
          chatId,
          token: chunk.reasoning,
          type: "reasoning",
          seq,
        }, userId);
      }

      if (chunk.token) {
        processContentToken(chunk.token);
      }

      // Capture provider usage data (token counts) from the stream
      if (chunk.usage) {
        streamUsage = chunk.usage;
      }

      if (chunk.finish_reason) {
        break;
      }
    }

    if (!signal.aborted) {
      // Flush any remaining CoT detection buffers before saving
      flushCotBuffers();

      // Post-parse: extract any reasoning tags that slipped through streaming
      // detection. Handles edge cases where prefix/suffix split across chunks
      // in ways the streaming state machine didn't catch, and ensures the
      // saved message content is always clean of reasoning tag markup.
      {
        const ppPrefix = ((reasoningSetting?.value?.prefix as string) || "<think>\n").replace(/^\n+|\n+$/g, "");
        const ppSuffix = ((reasoningSetting?.value?.suffix as string) || "\n</think>").replace(/^\n+|\n+$/g, "");
        if (ppPrefix && ppSuffix && fullContent.includes(ppPrefix)) {
          let cleaned = fullContent;
          let extracted = "";
          let idx = cleaned.indexOf(ppPrefix);
          while (idx !== -1) {
            const endIdx = cleaned.indexOf(ppSuffix, idx + ppPrefix.length);
            if (endIdx !== -1) {
              extracted += cleaned.slice(idx + ppPrefix.length, endIdx);
              cleaned = cleaned.slice(0, idx) + cleaned.slice(endIdx + ppSuffix.length);
            } else {
              // Unclosed tag — extract everything after prefix
              extracted += cleaned.slice(idx + ppPrefix.length);
              cleaned = cleaned.slice(0, idx);
              break;
            }
            idx = cleaned.indexOf(ppPrefix);
          }
          if (extracted) {
            fullContent = cleaned;
            fullReasoning = (fullReasoning ? fullReasoning + "\n" : "") + extracted;
          }
        }
      }

      // Apply regex scripts (response target) to completed content
      {
        const responseScripts = regexScriptsSvc.getActiveScripts(userId, {
          characterId: lifecycle.targetCharacterId,
          chatId,
          target: "response",
        });
        if (responseScripts.length > 0) {
          fullContent = await regexScriptsSvc.applyRegexScripts(fullContent, responseScripts, "ai_output", 0, macroEnv);
          if (fullReasoning) {
            fullReasoning = await regexScriptsSvc.applyRegexScripts(fullReasoning, responseScripts, "reasoning", 0, macroEnv);
          }
        }
      }

      let messageId: string;

      if (lifecycle.targetMessageId && lifecycle.targetSwipeIdx != null) {
        // Regenerate: fill in the blank swipe that was created at generation start
        const updated = chatsSvc.updateSwipe(userId, lifecycle.targetMessageId, lifecycle.targetSwipeIdx, fullContent);
        messageId = updated?.id ?? lifecycle.targetMessageId;
      } else if (lifecycle.continueMessageId) {
        // Continue: append generated text to existing assistant message,
        // inserting the continuePostfix separator (e.g. newline, double newline)
        const combined = (lifecycle.continueOriginalContent ?? "") + (lifecycle.continuePostfix ?? "") + fullContent;
        const existingExtra = chatsSvc.getMessage(userId, lifecycle.continueMessageId)?.extra;
        const continueExtra = fullReasoning ? { ...existingExtra, reasoning: fullReasoning } : undefined;
        const updated = chatsSvc.updateMessage(userId, lifecycle.continueMessageId, { content: combined, ...(continueExtra ? { extra: continueExtra } : {}) });
        messageId = updated?.id ?? lifecycle.continueMessageId;
      } else if (lifecycle.stagedMessageId) {
        // Staged (sidecar council): update the pre-created empty message
        // Merge with existing extra to preserve character_id etc. set during staging
        const existingStagedExtra = chatsSvc.getMessage(userId, lifecycle.stagedMessageId)?.extra || {};
        const stagedExtra = fullReasoning
          ? { ...existingStagedExtra, reasoning: fullReasoning }
          : (Object.keys(existingStagedExtra).length > 0 ? existingStagedExtra : undefined);
        chatsSvc.updateMessage(userId, lifecycle.stagedMessageId, { content: fullContent, ...(stagedExtra ? { extra: stagedExtra } : {}) });
        messageId = lifecycle.stagedMessageId;
      } else {
        // Normal / swipe: create assistant message, impersonate: create user message
        const isImpersonate = lifecycle.generationType === "impersonate";
        const extra: Record<string, any> = {};
        if (isImpersonate && lifecycle.personaId) extra.persona_id = lifecycle.personaId;
        if (!isImpersonate && lifecycle.targetCharacterId) extra.character_id = lifecycle.targetCharacterId;
        if (fullReasoning) extra.reasoning = fullReasoning;

        const message = chatsSvc.createMessage(chatId, {
          is_user: isImpersonate,
          name: isImpersonate ? (lifecycle.personaName || "User") : lifecycle.characterName,
          content: fullContent,
          extra: Object.keys(extra).length > 0 ? extra : undefined,
        }, userId);
        messageId = message.id;
      }

      // Compute reasoning duration if content tokens never arrived (reasoning-only response)
      if (reasoningStartedAt && !reasoningDurationMs) {
        reasoningDurationMs = Date.now() - reasoningStartedAt;
      }

      // ── Generation metrics (tokenCount, TTFT, TPS) ─────────────────────
      const finalPoolEntry = pool.getPoolEntry(generationId);
      // Total output token count via model's tokenizer (content + reasoning)
      let resolvedTokenCount: number | undefined;
      const fullOutput = (fullReasoning ? fullReasoning + fullContent : fullContent);
      if (fullOutput.length > 0) {
        try {
          resolvedTokenCount = (await tokenizerSvc.countForModel(model, fullOutput)) ?? undefined;
        } catch { /* non-fatal */ }
      }

      let generationMetrics: { ttft?: number; tps?: number; durationMs: number; wasStreaming: boolean } | undefined;
      if (finalPoolEntry) {
        const wasStreaming = finalPoolEntry.wasStreaming ?? true;
        const streamStart = finalPoolEntry.streamingStartedAt;
        const now = Date.now();
        const durationMs = streamStart ? now - streamStart : 0;
        let ttft: number | undefined;
        let tps: number | undefined;

        if (wasStreaming && streamStart) {
          // TTFT: time from LLM request to first token (content or reasoning)
          if (finalPoolEntry.firstTokenAt) {
            ttft = finalPoolEntry.firstTokenAt - streamStart;
          }
          // TPS: total output tokens over total streaming duration (first token → completion)
          if (finalPoolEntry.firstTokenAt && resolvedTokenCount && resolvedTokenCount > 1) {
            const streamDurationSec = (now - finalPoolEntry.firstTokenAt) / 1000;
            if (streamDurationSec > 0) {
              tps = Math.round((resolvedTokenCount / streamDurationSec) * 10) / 10;
            }
          }
        }

        generationMetrics = { durationMs, wasStreaming, ...(ttft != null ? { ttft } : {}), ...(tps != null ? { tps } : {}) };
      }

      // Persist all generation metadata (reasoning, usage, metrics) in a single
      // patchMessageExtra call to avoid triggering redundant chunk rebuilds,
      // cache invalidation, and MESSAGE_EDITED events for each field.
      {
        const metaExtra: Record<string, any> = {};
        if (fullReasoning) metaExtra.reasoning = fullReasoning;
        if (streamUsage) metaExtra.usage = streamUsage;
        if (reasoningDurationMs > 0) metaExtra.reasoningDuration = reasoningDurationMs;
        if (resolvedTokenCount) metaExtra.tokenCount = resolvedTokenCount;
        if (generationMetrics) metaExtra.generationMetrics = generationMetrics;

        if (Object.keys(metaExtra).length > 0) {
          const existing = chatsSvc.getMessage(userId, messageId)?.extra || {};
          chatsSvc.patchMessageExtra(userId, messageId, { ...existing, ...metaExtra });
        }
      }

      // Compute and store breakdown for the generated message
      let breakdownPayload: any;
      if (lifecycle.breakdown && lifecycle.breakdown.length > 0 && lifecycle.model) {
        try {
          const tokenResult = await tokenizerSvc.countBreakdown(lifecycle.model, lifecycle.breakdown, lifecycle.chatHistoryMessages);
          breakdownPayload = {
            entries: tokenResult.breakdown,
            totalTokens: tokenResult.total_tokens,
            maxContext: lifecycle.maxContext || 0,
            model: lifecycle.model,
            provider: lifecycle.providerName || "",
            presetName: lifecycle.presetName,
            tokenizer_name: tokenResult.tokenizer_name,
          };
          breakdownSvc.storeBreakdown(userId, messageId, chatId, breakdownPayload);
        } catch {
          // non-fatal
        }
      }

      pool.completePool(generationId, messageId);
      eventBus.emit(EventType.GENERATION_ENDED, {
        generationId,
        chatId,
        messageId,
        content: fullContent,
        breakdown: breakdownPayload,
        usage: streamUsage,
        tokenCount: resolvedTokenCount,
        generationMetrics,
      }, userId);

      // Fire-and-forget expression detection after successful generation
      fireExpressionDetection(userId, chatId, lifecycle).catch(() => {});
    }
  } catch (err: any) {
    pool.errorPool(generationId, err.message);
    eventBus.emit(EventType.GENERATION_ENDED, {
      generationId,
      chatId,
      error: err.message,
    }, userId);
  } finally {
    activeGenerations.delete(generationId);
    // Clean up per-chat lock (only if this generation still owns it — a newer
    // generation may have already replaced it via startGeneration).
    for (const [key, id] of activeChatGenerations) {
      if (id === generationId) {
        activeChatGenerations.delete(key);
        break;
      }
    }
  }
}

/**
 * Fire-and-forget expression detection after a successful generation.
 * Handles both standalone auto-detect mode and council tool result extraction.
 */
async function fireExpressionDetection(
  userId: string,
  chatId: string,
  lifecycle: GenerationLifecycle
): Promise<void> {
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) return;

  const characterId = lifecycle.targetCharacterId || chat.character_id;
  if (!characterId) return;

  // ── Multi-character expression groups ──────────────────────────────────────
  // Cards with expression_groups (e.g., multi-character RisuAI imports) use a
  // two-stage pipeline: identify the focus character, then detect expression
  // within that character's label set.
  const expressionGroups = getExpressionGroups(userId, characterId);
  if (expressionGroups && Object.keys(expressionGroups).length > 0) {
    const detectionSettings = getExpressionDetectionSettings(userId);
    if (detectionSettings.mode === "off") return;

    const allMessages = chatsSvc.getMessages(userId, chatId);
    const recentMessages: LlmMessage[] = allMessages
      .slice(-detectionSettings.contextWindow)
      .map((m) => ({ role: m.is_user ? "user" as const : "assistant" as const, content: m.content }));

    const result = await detectMultiCharacterExpression({
      userId,
      chatId,
      characterId,
      groups: expressionGroups,
      recentMessages,
    }, rawGenerate);

    if (result) {
      emitExpressionChanged(userId, chatId, chat, characterId, result.expression, result.imageId, result.characterGroup);
    }
    return;
  }

  // ── Single-character expression detection (existing path) ─────────────────
  if (!hasExpressions(userId, characterId)) return;

  const expressionConfig = getExpressionConfig(userId, characterId);
  if (!expressionConfig?.enabled) return;

  const labels = Object.keys(expressionConfig.mappings);
  if (labels.length === 0) return;

  // Check if council already produced an expression result
  if (lifecycle.councilNamedResults?.["expression_data"]) {
    const councilLabel = lifecycle.councilNamedResults["expression_data"].trim().toLowerCase();
    const matched = labels.find((l) => l.toLowerCase() === councilLabel);
    if (matched) {
      emitExpressionChanged(userId, chatId, chat, characterId, matched, expressionConfig.mappings[matched]);
      return;
    }
  }

  // Standalone auto-detect mode
  const detectionSettings = getExpressionDetectionSettings(userId);
  if (detectionSettings.mode === "off" || detectionSettings.mode === "council") return;

  const allMessages = chatsSvc.getMessages(userId, chatId);
  const recentMessages: LlmMessage[] = allMessages
    .slice(-detectionSettings.contextWindow)
    .map((m) => ({ role: m.is_user ? "user" as const : "assistant" as const, content: m.content }));

  const detectedLabel = await detectExpression({
    userId,
    chatId,
    characterId,
    labels,
    recentMessages,
  }, rawGenerate);

  if (detectedLabel && expressionConfig.mappings[detectedLabel]) {
    emitExpressionChanged(userId, chatId, chat, characterId, detectedLabel, expressionConfig.mappings[detectedLabel]);
  }
}

function emitExpressionChanged(
  userId: string,
  chatId: string,
  chat: { metadata: any },
  characterId: string,
  label: string,
  imageId: string,
  expressionGroup?: string,
): void {
  const isGroup = chat.metadata?.group === true;

  // Build only the keys this writer owns. The merge helper re-reads current
  // chat metadata so any user-driven changes that landed during generation
  // (alternate field selections, world books, etc.) are preserved.
  const partial: Record<string, any> = { active_expression: label };

  // Track which character group the expression belongs to (multi-character cards)
  if (expressionGroup) {
    partial.active_expression_group = expressionGroup;
  }

  if (isGroup) {
    // Re-read current group_expressions so we don't drop entries written by
    // concurrent expression detections for other group members.
    const latest = chatsSvc.getChat(userId, chatId);
    const existingGroup = (latest?.metadata?.group_expressions ?? {}) as Record<
      string,
      { label: string; imageId: string }
    >;
    partial.group_expressions = { ...existingGroup, [characterId]: { label, imageId } };
  }

  chatsSvc.mergeChatMetadata(userId, chatId, partial);
  // Emit to frontend
  eventBus.emit(EventType.EXPRESSION_CHANGED, {
    chatId,
    characterId,
    label,
    imageId,
    expressionGroup,
  }, userId);
}

export function stopGeneration(generationId: string): boolean {
  const entry = activeGenerations.get(generationId);
  if (!entry) return false;
  entry.controller.abort();
  return true;
}

export function stopUserGenerations(userId: string): void {
  for (const [id, entry] of activeGenerations) {
    if (entry.userId === userId) {
      entry.controller.abort();
    }
  }
}

export function stopChatGenerations(userId: string, chatId: string): void {
  const chatKey = `${userId}:${chatId}`;
  const genId = activeChatGenerations.get(chatKey);
  if (genId) {
    const entry = activeGenerations.get(genId);
    if (entry) entry.controller.abort();
  }
}

export function stopAllGenerations(): void {
  for (const [id, entry] of activeGenerations) {
    entry.controller.abort();
  }
  activeGenerations.clear();
  activeChatGenerations.clear();
}

/** Returns the active generationId for a chat, if any. */
export function getActiveChatGeneration(userId: string, chatId: string): string | undefined {
  return activeChatGenerations.get(`${userId}:${chatId}`);
}

export function getActiveGenerationCount(): number {
  return activeGenerations.size;
}

// Periodically abort generations that have been running too long (provider hung, broken stream)
const GENERATION_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
let _generationSweepTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of activeGenerations) {
    if (now - entry.startedAt > GENERATION_MAX_AGE_MS) {
      console.warn(`[generate] Aborting stale generation ${id} (age: ${Math.round((now - entry.startedAt) / 1000)}s)`);
      entry.controller.abort();
    }
  }
}, 60_000);

export function stopGenerationSweep(): void {
  if (_generationSweepTimer) {
    clearInterval(_generationSweepTimer);
    _generationSweepTimer = null;
  }
}

// --- Stream-to-response helper ---
// Some providers (especially with tool calling) work better with streaming.
// This helper consumes a stream and produces a full GenerationResponse,
// properly accumulating tool call deltas.

async function consumeStream(
  stream: AsyncGenerator<StreamChunk, void, unknown>,
): Promise<GenerationResponse> {
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let toolCalls: import("../llm/types").ToolCallResult[] | undefined;
  let usage: GenerationResponse["usage"];

  for await (const chunk of stream) {
    if (chunk.token) content += chunk.token;
    if (chunk.reasoning) reasoning += chunk.reasoning;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.finish_reason) finishReason = chunk.finish_reason;
    if (chunk.tool_calls) toolCalls = chunk.tool_calls;
  }

  return {
    content,
    reasoning: reasoning || undefined,
    finish_reason: finishReason,
    tool_calls: toolCalls,
    usage,
  };
}

// --- Extension generation (stateless, synchronous, no WS events) ---

export async function rawGenerate(userId: string, input: RawGenerateInput & { signal?: AbortSignal }): Promise<GenerationResponse> {
  const { provider, apiKey, apiUrl } = await resolveRawProviderAndKey(userId, input);
  const request: GenerationRequest = {
    messages: input.messages,
    model: input.model,
    parameters: input.parameters,
    tools: input.tools,
    signal: input.signal,
  };

  // Use streaming when tools are present — some providers only emit tool call
  // deltas correctly via the streaming path. Consume the stream internally to
  // produce a complete response.
  if (input.tools && input.tools.length > 0) {
    return consumeStream(provider.generateStream(apiKey, apiUrl, { ...request, stream: true }));
  }

  return provider.generate(apiKey, apiUrl, { ...request, stream: false });
}

export async function quietGenerate(userId: string, input: QuietGenerateInput): Promise<GenerationResponse> {
  const connection = resolveConnection(userId, input.connection_id);
  const { provider, apiKey, apiUrl } = await resolveProviderAndKey(userId, connection.id);

  // Merge preset parameters with request overrides
  let mergedParams: GenerationParameters = input.parameters || {};
  if (connection.preset_id) {
    const preset = presetsSvc.getPreset(userId, connection.preset_id);
    if (preset) {
      mergedParams = { ...preset.parameters, ...mergedParams };
    }
  }

  // Inject API-level reasoning params from user settings
  const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
  if (reasoningSetting?.value?.apiReasoning) {
    const effort = reasoningSetting.value.reasoningEffort || "auto";
    if (effort !== "auto") {
      injectReasoningParams(mergedParams, provider.name, effort, connection.model || undefined);
    }
  }

  // Inject connection-level metadata flags into parameters (e.g. use_responses_api)
  if (connection.metadata?.use_responses_api) {
    mergedParams.use_responses_api = true;
  }

  // Inject OpenRouter-specific settings from connection metadata
  if (connection.provider === "openrouter" && connection.metadata?.openrouter) {
    mergedParams._openrouter = connection.metadata.openrouter;
  }

  // Allow callers (e.g. Memory Cortex sidecar) to override the model without
  // swapping connection profiles. Strip the key from parameters so it doesn't
  // leak into provider-specific request bodies as an unknown field.
  const paramModel = typeof (mergedParams as any).model === "string"
    ? (mergedParams as any).model.trim()
    : "";
  if ("model" in mergedParams) delete (mergedParams as any).model;

  const request: GenerationRequest = {
    messages: input.messages,
    model: paramModel || connection.model,
    parameters: mergedParams,
    tools: input.tools,
    signal: input.signal,
  };

  // Use streaming when tools are present — some providers only emit tool call
  // deltas correctly via the streaming path.
  if (input.tools && input.tools.length > 0) {
    return consumeStream(provider.generateStream(apiKey, apiUrl, { ...request, stream: true }));
  }

  return provider.generate(apiKey, apiUrl, { ...request, stream: false });
}

/**
 * Summarize generation — used by the Loom Summary feature.
 * Resolves connection via: explicit connection_id → sidecar settings → default.
 * When using sidecar, applies sidecar model/temperature/maxTokens overrides.
 */
export async function summarizeGenerate(userId: string, input: QuietGenerateInput): Promise<GenerationResponse> {
  let connectionId = input.connection_id;
  let sidecarModel: string | undefined;
  let sidecarParams: Record<string, unknown> = {};

  // If no explicit connection, resolve via shared sidecar settings
  if (!connectionId) {
    const sidecar = getSidecarSettings(userId);
    if (sidecar.connectionProfileId) {
      connectionId = sidecar.connectionProfileId;
      if (sidecar.model) sidecarModel = sidecar.model;
      sidecarParams = {
        temperature: sidecar.temperature,
        top_p: sidecar.topP,
        max_tokens: sidecar.maxTokens,
      };
    }
  }

  const connection = resolveConnection(userId, connectionId);
  const { provider, apiKey, apiUrl } = await resolveProviderAndKey(userId, connection.id);

  // Merge: preset defaults < sidecar overrides < request overrides
  let mergedParams: GenerationParameters = {};
  if (connection.preset_id) {
    const preset = presetsSvc.getPreset(userId, connection.preset_id);
    if (preset) {
      mergedParams = { ...preset.parameters };
    }
  }
  mergedParams = { ...mergedParams, ...sidecarParams, ...input.parameters };

  // Inject connection-level metadata flags
  if (connection.metadata?.use_responses_api) {
    mergedParams.use_responses_api = true;
  }
  if (connection.provider === "openrouter" && connection.metadata?.openrouter) {
    mergedParams._openrouter = connection.metadata.openrouter;
  }

  const request: GenerationRequest = {
    messages: input.messages,
    model: sidecarModel || connection.model,
    parameters: mergedParams,
    tools: input.tools,
  };

  // Use streaming when tools are present — some providers only emit tool call
  // deltas correctly via the streaming path.
  if (input.tools && input.tools.length > 0) {
    return consumeStream(provider.generateStream(apiKey, apiUrl, { ...request, stream: true }));
  }

  return provider.generate(apiKey, apiUrl, { ...request, stream: false });
}

/**
 * Apply prompt post-processing to the message array in place.
 * - "merge": merge consecutive messages with the same role
 * - "semi": merge consecutive same-role, but keep alternation between user/assistant
 * - "strict": enforce strict user/assistant alternation by merging violations
 * - "single": collapse entire prompt into a single system message
 */
function applyPostProcessing(messages: LlmMessage[], mode: string): void {
  if (mode === "merge" || mode === "semi" || mode === "strict") {
    let i = 1;
    while (i < messages.length) {
      if (messages[i].role === messages[i - 1].role) {
        messages[i - 1] = {
          ...messages[i - 1],
          content: getTextContent(messages[i - 1]) + "\n\n" + getTextContent(messages[i]),
        };
        messages.splice(i, 1);
      } else {
        i++;
      }
    }
  } else if (mode === "single") {
    if (messages.length > 1) {
      const combined = messages.map((m) => getTextContent(m)).join("\n\n");
      messages.length = 0;
      messages.push({ role: "system", content: combined });
    }
  }
}

export async function batchGenerate(userId: string, input: BatchGenerateInput): Promise<BatchResultItem[]> {
  const processOne = async (req: RawGenerateInput, index: number): Promise<BatchResultItem> => {
    try {
      const result = await rawGenerate(userId, req);
      return {
        index,
        success: true,
        content: result.content,
        finish_reason: result.finish_reason,
        usage: result.usage,
      };
    } catch (err: any) {
      return { index, success: false, error: err.message };
    }
  };

  if (input.concurrent) {
    return Promise.all(input.requests.map((req, i) => processOne(req, i)));
  }

  const results: BatchResultItem[] = [];
  for (let i = 0; i < input.requests.length; i++) {
    results.push(await processOne(input.requests[i], i));
  }
  return results;
}

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
import { assemblePrompt } from "./prompt-assembly.service";
import * as charactersSvc from "./characters.service";
import { getTextContent, type LlmMessage, type GenerationParameters, type GenerationResponse, type GenerationType, type ImpersonateMode, type AssemblyBreakdownEntry, type ActivatedWorldInfoEntry, type ToolDefinition } from "../llm/types";
import { interceptorPipeline } from "../spindle/interceptor-pipeline";
import { contextHandlerChain } from "../spindle/context-handler";
import { executeCouncil, collectWorldInfoForCouncil, type CouncilEnrichment } from "./council/council-execution.service";
import { activateWorldInfo } from "./world-info-activation.service";
import type { CouncilExecutionResult } from "lumiverse-spindle-types";
import { getCouncilSettings, getAvailableTools } from "./council/council-settings.service";
import * as tokenizerSvc from "./tokenizer.service";
import * as breakdownSvc from "./breakdown.service";

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
  /** Model + provider + preset info for breakdown storage */
  model?: string;
  providerName?: string;
  presetName?: string;
  /** Max context from connection parameters (for breakdown display) */
  maxContext?: number;
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
}

export interface QuietGenerateInput {
  messages: LlmMessage[];
  connection_id?: string;
  parameters?: GenerationParameters;
}

export interface DryRunResult {
  messages: LlmMessage[];
  breakdown: AssemblyBreakdownEntry[];
  parameters: Record<string, any>;
  model: string;
  provider: string;
  tokenCount?: {
    total_tokens: number;
    breakdown: { name: string; type: string; tokens: number; role?: string }[];
    tokenizer_id: string | null;
    tokenizer_name: string | null;
  };
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
  activatedWorldInfo?: ActivatedWorldInfoEntry[];
  deferredWiState?: { chatId: string; metadata: any };
  spindleContext: SpindleContext;
  /** True if the {{lumiaCouncilDeliberation}} macro was resolved during assembly. */
  deliberationHandledByMacro?: boolean;
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
const activeGenerations = new Map<string, { controller: AbortController; userId: string; chatId: string }>();

// Per-chat generation lock: prevents concurrent generations (including council) in the same chat.
// Keyed by `${userId}:${chatId}` → generationId. Registered BEFORE council execution so that
// a second request for the same chat will abort the in-flight one (including its council tools).
const activeChatGenerations = new Map<string, string>();

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

  return { provider, apiKey: apiKey || "", apiUrl: connection.api_url || "" };
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
  let activatedWorldInfo: ActivatedWorldInfoEntry[] | undefined;
  let deferredWiState: { chatId: string; metadata: any } | undefined;

  let deliberationHandledByMacro = false;

  if (opts.inputMessages) {
    messages = opts.inputMessages;
  } else {
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
    });
    messages = assemblyResult.messages;
    assembledParams = assemblyResult.parameters;
    breakdown = assemblyResult.breakdown;
    activatedWorldInfo = assemblyResult.activatedWorldInfo;
    deferredWiState = assemblyResult.deferredWiState;
    deliberationHandledByMacro = !!assemblyResult.deliberationHandledByMacro;
  }

  // Expose activated world info to spindle context
  if (activatedWorldInfo) {
    spindleContext.activatedWorldInfo = activatedWorldInfo;
  }

  // Run Spindle interceptor pipeline on assembled messages
  // The pipeline uses LlmMessageDTO (string-only content) — at this stage
  // multimodal parts have already been serialised so the cast is safe.
  if (interceptorPipeline.count > 0) {
    messages = await interceptorPipeline.run(
      messages as import("lumiverse-spindle-types").LlmMessageDTO[],
      spindleContext,
      opts.userId
    ) as unknown as LlmMessage[];
  }

  // Apply promptPostProcessing
  const postProcessing = settingsSvc.getSetting(opts.userId, "promptPostProcessing");
  if (postProcessing?.value) {
    applyPostProcessing(messages, postProcessing.value);
  }

  // Merge parameters: assembled (from preset) < request overrides
  const parameters: GenerationParameters = { ...assembledParams, ...opts.inputParameters };

  return { messages, parameters, breakdown, activatedWorldInfo, deferredWiState, spindleContext, deliberationHandledByMacro };
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
  activeGenerations.set(generationId, { controller: abortController, userId: input.userId, chatId: input.chat_id });
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
    if (character) characterName = character.name;
  }

  // Resolve target message EARLY (before council) so we can visually clear the
  // message on the frontend before council tools start executing.
  const resolvedPersona = personasSvc.resolvePersonaOrDefault(input.userId, input.persona_id);

  const lifecycle: GenerationLifecycle = {
    characterName,
    generationType: genType,
    personaId: resolvedPersona?.id,
    personaName: resolvedPersona?.name || "User",
    targetCharacterId: input.target_character_id,
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
    }
  } else if (genType === "continue") {
    const lastMsg = chatsSvc.getLastAssistantMessage(input.userId, input.chat_id);
    if (lastMsg) {
      lifecycle.continueMessageId = lastMsg.id;
      lifecycle.continueOriginalContent = lastMsg.content;
    }
  }

  // Execute council if enabled (before prompt assembly so it doesn't slow the critical path visibly)
  const councilSettings = getCouncilSettings(input.userId);
  let councilResult: CouncilExecutionResult | null = null;
  let inlineTools: ToolDefinition[] | undefined;

  const councilActive = councilSettings.councilMode
    && councilSettings.toolsSettings.enabled
    && councilSettings.members.length > 0
    && councilSettings.members.some((m) => m.tools.length > 0);

  if (councilActive) {
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
        const availableTools = getAvailableTools(input.userId);
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

      // Pre-compute enrichment for council tools — resolve world info at the
      // top of the generation chain so tools receive proper world book context.
      // Also filters out the staged empty message and excluded (regenerated)
      // message so council doesn't see blank assistant turns.
      const fullCharacter = chat
        ? charactersSvc.getCharacter(input.userId, targetCharId || chat.character_id)
        : null;
      const councilMessages = chatsSvc.getMessages(input.userId, input.chat_id)
        .filter(m => m.id !== excludeMessageId && m.id !== stagedMessageId);
      const wiEntries = collectWorldInfoForCouncil(input.userId, fullCharacter, resolvedPersona);
      let councilWiActivated = wiEntries.length > 0
        ? activateWorldInfo({
            entries: wiEntries,
            messages: councilMessages,
            chatTurn: councilMessages.length,
            wiState: {},
          }).activatedEntries
        : [];
      console.debug(
        "[generate] Council enrichment: char=%s, persona=%s, messages=%d, wi=%d/%d",
        fullCharacter?.name ?? "none",
        resolvedPersona?.name ?? "none",
        councilMessages.length,
        councilWiActivated.length,
        wiEntries.length,
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
  }

  // Run shared prompt pipeline
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
  });

  let { messages } = pipeline;
  const { parameters: mergedParams, breakdown, activatedWorldInfo, deliberationHandledByMacro } = pipeline;

  // Persist deferred WI state after assembly
  if (pipeline.deferredWiState) {
    chatsSvc.updateChat(input.userId, pipeline.deferredWiState.chatId, {
      metadata: pipeline.deferredWiState.metadata,
    });
  }

  // Emit activated world info event (always emit so UI can clear stale entries)
  if (activatedWorldInfo) {
    eventBus.emit(EventType.WORLD_INFO_ACTIVATED, {
      chatId: input.chat_id,
      entries: activatedWorldInfo,
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
  lifecycle.model = connection.model;
  lifecycle.providerName = provider.name;
  lifecycle.maxContext = mergedParams.max_context_length as number | undefined;

  // Strip internal-only keys before they reach the provider
  delete mergedParams.max_context_length;

  // Resolve preset name for breakdown display
  const presetId = input.preset_id || connection.preset_id;
  if (presetId) {
    const preset = presetsSvc.getPreset(input.userId, presetId);
    if (preset) lifecycle.presetName = preset.name;
  }

  // Run generation in the background
  runGeneration(generationId, provider, apiKey, apiUrl, connection.model, messages, mergedParams, input.userId, input.chat_id, lifecycle, abortController.signal, inlineTools);

  return { generationId, status: "streaming" };

  } catch (err: any) {
    // Clean up tracking maps if setup (council, assembly, etc.) fails or is aborted
    activeGenerations.delete(generationId);
    activeChatGenerations.delete(chatKey);

    // If this was a user-initiated abort (stop request), emit proper events so the
    // frontend can reset its streaming state and clean up.
    if (abortController.signal.aborted) {
      // Clean up staged message if one was created (sidecar council mode)
      if (stagedMessageId) {
        try {
          chatsSvc.deleteMessage(input.userId, stagedMessageId);
        } catch { /* best-effort cleanup */ }
      }
      eventBus.emit(EventType.GENERATION_STOPPED, {
        generationId,
        chatId: input.chat_id,
        content: "",
      }, input.userId);
      // Return a stopped status instead of throwing, so the HTTP response is clean
      return { generationId, status: "stopped" };
    }

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
      tokenCount = await tokenizerSvc.countBreakdown(connection.model, pipeline.breakdown);
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
    model: connection.model,
    provider: provider.name,
    tokenCount,
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
  tools?: ToolDefinition[]
): Promise<void> {
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
    fullContent += text;
    eventBus.emit(EventType.STREAM_TOKEN_RECEIVED, {
      generationId, chatId, token: text,
    }, userId);
  }

  function emitReasoningToken(text: string) {
    if (!text) return;
    fullReasoning += text;
    eventBus.emit(EventType.STREAM_TOKEN_RECEIVED, {
      generationId, chatId, token: text, type: "reasoning",
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
      emitContentToken(token);
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
        cotPhase = "content";
        emitContentToken(cotDetectBuffer);
        cotDetectBuffer = "";
      }
      return;
    }
    processReasoningChunk(token);
  }

  function flushCotBuffers() {
    if (cotPhase === "detecting" && cotDetectBuffer) {
      emitContentToken(cotDetectBuffer);
      cotDetectBuffer = "";
    } else if (cotPhase === "reasoning" && cotSuffixBuffer) {
      emitReasoningToken(cotSuffixBuffer);
      cotSuffixBuffer = "";
    }
    cotPhase = "content";
  }

  try {
    const stream = provider.generateStream(apiKey, apiUrl, { messages, model, parameters, stream: true, tools });

    for await (const chunk of stream) {
      if (signal.aborted) {
        // Flush any buffered CoT tokens before saving partial content
        flushCotBuffers();
        // Close unclosed reasoning tags so the frontend can properly collapse them
        const closedContent = closeUnterminatedReasoningTags(userId, fullContent);

        if (lifecycle.targetMessageId && lifecycle.targetSwipeIdx != null) {
          chatsSvc.updateSwipe(userId, lifecycle.targetMessageId, lifecycle.targetSwipeIdx, closedContent);
          // Persist partial reasoning on abort for regenerate
          if (fullReasoning) {
            const existingExtra = chatsSvc.getMessage(userId, lifecycle.targetMessageId)?.extra || {};
            chatsSvc.updateMessage(userId, lifecycle.targetMessageId, { extra: { ...existingExtra, reasoning: fullReasoning } });
          }
        } else if (lifecycle.stagedMessageId) {
          // Preserve existing extra (character_id etc.) and save partial reasoning
          const existingStagedExtra = chatsSvc.getMessage(userId, lifecycle.stagedMessageId)?.extra || {};
          const abortExtra = fullReasoning ? { ...existingStagedExtra, reasoning: fullReasoning } : existingStagedExtra;
          chatsSvc.updateMessage(userId, lifecycle.stagedMessageId, {
            content: closedContent,
            ...(Object.keys(abortExtra).length > 0 ? { extra: abortExtra } : {}),
          });
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
        eventBus.emit(EventType.GENERATION_STOPPED, { generationId, chatId, content: closedContent }, userId);
        break;
      }

      // Emit reasoning tokens (provider thinking/extended thinking)
      if (chunk.reasoning) {
        fullReasoning += chunk.reasoning;
        eventBus.emit(EventType.STREAM_TOKEN_RECEIVED, {
          generationId,
          chatId,
          token: chunk.reasoning,
          type: "reasoning",
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
      let messageId: string;

      if (lifecycle.targetMessageId && lifecycle.targetSwipeIdx != null) {
        // Regenerate: fill in the blank swipe that was created at generation start
        const updated = chatsSvc.updateSwipe(userId, lifecycle.targetMessageId, lifecycle.targetSwipeIdx, fullContent);
        messageId = updated?.id ?? lifecycle.targetMessageId;
        // Persist API reasoning in message extra
        if (fullReasoning) {
          chatsSvc.updateMessage(userId, messageId, { extra: { ...chatsSvc.getMessage(userId, messageId)?.extra, reasoning: fullReasoning } });
        }
      } else if (lifecycle.continueMessageId) {
        // Continue: append generated text to existing assistant message
        const combined = (lifecycle.continueOriginalContent ?? "") + fullContent;
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

      // Persist provider usage (token counts) in message extra when available
      if (streamUsage) {
        const existing = chatsSvc.getMessage(userId, messageId)?.extra || {};
        chatsSvc.updateMessage(userId, messageId, { extra: { ...existing, usage: streamUsage } });
      }

      // Compute and store breakdown for the generated message
      let breakdownPayload: any;
      if (lifecycle.breakdown && lifecycle.breakdown.length > 0 && lifecycle.model) {
        try {
          const tokenResult = await tokenizerSvc.countBreakdown(lifecycle.model, lifecycle.breakdown);
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

      eventBus.emit(EventType.GENERATION_ENDED, {
        generationId,
        chatId,
        messageId,
        content: fullContent,
        breakdown: breakdownPayload,
        usage: streamUsage,
      }, userId);
    }
  } catch (err: any) {
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

// --- Extension generation (stateless, synchronous, no WS events) ---

export async function rawGenerate(userId: string, input: RawGenerateInput & { signal?: AbortSignal }): Promise<GenerationResponse> {
  const { provider, apiKey, apiUrl } = await resolveRawProviderAndKey(userId, input);
  return provider.generate(apiKey, apiUrl, {
    messages: input.messages,
    model: input.model,
    parameters: input.parameters,
    stream: false,
    signal: input.signal,
  });
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

  return provider.generate(apiKey, apiUrl, {
    messages: input.messages,
    model: connection.model,
    parameters: mergedParams,
    stream: false,
  });
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

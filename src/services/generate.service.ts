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
  applyProviderReasoningOffSwitch,
  injectReasoningParams,
  collectVectorActivatedWorldInfo,
  mergeActivatedWorldInfoEntries,
  isChatHistoryMessage,
  type VectorActivatedEntry,
} from "./prompt-assembly.service";
import * as charactersSvc from "./characters.service";
import { getEffectiveCharacterName } from "../types/character";
import {
  getTextContent,
  type LlmMessage,
  type GenerationParameters,
  type GenerationRequest,
  type GenerationResponse,
  type StreamChunk,
  type GenerationType,
  type ImpersonateMode,
  type AssemblyBreakdownEntry,
  type ActivatedWorldInfoEntry,
  type ToolDefinition,
  type ToolCallResult,
} from "../llm/types";
import {
  interceptorPipeline,
  type InterceptorBreakdownEntry,
} from "../spindle/interceptor-pipeline";
import { contextHandlerChain } from "../spindle/context-handler";
import {
  executeCouncil,
  collectWorldInfoForCouncil,
  formatDeliberation,
  type CouncilEnrichment,
} from "./council/council-execution.service";
import { activateWorldInfo } from "./world-info-activation.service";
import type {
  CouncilExecutionResult,
  CachedCouncilResult,
  CouncilMember,
} from "lumiverse-spindle-types";
import {
  getCouncilSettings,
  getAvailableTools,
} from "./council/council-settings.service";
import * as councilProfilesSvc from "./council/council-profiles.service";
import * as tokenizerSvc from "./tokenizer.service";
import * as breakdownSvc from "./breakdown.service";
import * as regexScriptsSvc from "./regex-scripts.service";
import * as pool from "./generation-pool.service";
import * as summarizePool from "./summarize-pool.service";
import {
  detectExpression,
  detectMultiCharacterExpression,
  getExpressionDetectionSettings,
} from "./expression-detection.service";
import {
  hasExpressions,
  getExpressionConfig,
  getExpressionGroups,
} from "./expressions.service";
import { getSidecarSettings } from "./sidecar-settings.service";
import {
  abortChatBackground,
  abortUserBackgrounds,
  abortAllBackgrounds,
} from "./chat-background.service";
import {
  createCooperativeYielder,
  yieldToEventLoop,
} from "../llm/stream-utils";
import { getMcpClientManager } from "./mcp-client-manager";
import { parseMcpToolName } from "./council/mcp-tools";
import {
  buildCouncilMemberContext,
  getCouncilToolExecution,
  getExtensionToolRegistration,
  invokeExtensionCouncilTool,
  isCouncilToolInlineCallable,
  type RuntimeCouncilToolDefinition,
  getCouncilToolArgsSchema,
  normalizeToolJsonSchema,
} from "./council/tool-runtime";
import { toolRegistry } from "../spindle/tool-registry";
import { executeHostCouncilTool } from "./council/host-tools";
import {
  applyPersonaAddonStates,
  getChatPersonaAddonStates,
} from "./persona-addon-states";
import * as packsSvc from "./packs.service";
import {
  GuidedReasoningStreamParser,
  closeUnterminatedDelimitedReasoning,
  extractDelimitedReasoning,
  resolveReasoningDelimiters,
  separateDelimitedReasoning,
  wrapDelimitedReasoningStream,
} from "../utils/reasoning-strip";
import {
  persistMacroVariableState,
  reconcileChatMessageMacros,
  resolveRenderedMessageContent,
} from "./chat-macro-render.service";
import { cloneEnv } from "../macros";
import {
  assemblePromptInWorker,
  canUsePromptAssemblyWorker,
} from "./prompt-assembly-worker-client";

interface GenerateInput {
  userId: string;
  chat_id: string;
  connection_id?: string;
  persona_id?: string;
  persona_addon_states?: Record<string, boolean>;
  preset_id?: string;
  force_preset_id?: boolean;
  message_id?: string;
  messages?: LlmMessage[];
  parameters?: GenerationParameters;
  generation_type?: GenerationType;
  impersonate_mode?: ImpersonateMode;
  /** For impersonate: free-form text from the user's input box, appended to the impersonation prompt. */
  impersonate_input?: string;
  /** For impersonate: stream tokens to the frontend but do NOT create a message. The user edits and sends manually. */
  impersonate_draft?: boolean;
  target_character_id?: string;
  regen_feedback?: string;
  regen_feedback_position?: "system" | "user";
  retain_council?: boolean;
  /** Dry-run only: reassemble as if this message were absent from history
   *  (used to reconstruct the prompt that produced an existing assistant turn). */
  exclude_message_id?: string;
  /** Optional abort signal — when fired, cancels an in-flight dry run. */
  signal?: AbortSignal;
}

/** Lifecycle context passed from startGeneration → runGeneration */
interface GenerationLifecycle {
  /** User-authored messages that immediately preceded this generation. */
  sourceUserMessageIds?: string[];
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
  /** For impersonate draft: stream tokens but do not create a message */
  impersonateDraft?: boolean;
  /** Target character id (for group chat message attribution) */
  targetCharacterId?: string;
  /** Chat history messages snapshot (used for accurate tokenization in breakdown) */
  chatHistoryMessages?: LlmMessage[];
  /** Full assembled outbound message list for prompt breakdown inspection. */
  messages?: LlmMessage[];
  /** Model + provider + preset info for breakdown storage */
  model?: string;
  providerName?: string;
  presetName?: string;
  /** Max context from connection parameters (for breakdown display) */
  maxContext?: number;
  /** Council named results (for expression detection and other post-generation hooks) */
  councilNamedResults?: Record<string, string>;
  /** Context-budget clipping stats (for GENERATION_IN_PROGRESS payload + breakdown). */
  contextClipStats?: import("../llm/types").ContextClipStats;
}

function collectTrailingUserMessageIds(userId: string, chatId: string): string[] {
  const messages = chatsSvc.getMessages(userId, chatId);
  const trailing: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.extra?.hidden === true) continue;
    if (!message.is_user) break;
    trailing.push(message.id);
  }
  trailing.reverse();
  return trailing;
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
  /**
   * Optional chat id. Currently used by the summarize path to track in-flight
   * jobs in the summarize pool so frontends can recover state on reconnect or
   * chat-switch. Ignored by `quietGenerate`.
   */
  chat_id?: string;
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
    breakdown: {
      name: string;
      type: string;
      tokens: number;
      role?: string;
      extensionId?: string;
      extensionName?: string;
    }[];
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
  databankStats?: import("../llm/types").DatabankStats;
  contextClipStats?: import("../llm/types").ContextClipStats;
}

export interface BatchGenerateInput {
  requests: RawGenerateInput[];
  concurrent?: boolean;
  /**
   * Optional abort signal — when fired, every still-pending sub-request is
   * cancelled. Already-completed sub-requests keep their results in the
   * returned array; cancelled ones surface as `{ success: false, error: "AbortError" }`.
   */
  signal?: AbortSignal;
}

export interface BatchResultItem {
  index: number;
  success: boolean;
  content?: string;
  finish_reason?: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
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
  databankStats?: import("../llm/types").DatabankStats;
  contextClipStats?: import("../llm/types").ContextClipStats;
  deferredWiState?: { chatId: string; partial: Record<string, any> };
  spindleContext: SpindleContext;
  /** True if the {{lumiaCouncilDeliberation}} macro was resolved during assembly. */
  deliberationHandledByMacro?: boolean;
  /** The macro environment built during assembly — used for regex script macro substitution. */
  macroEnv?: import("../macros/types").MacroEnv;
  /** Snapshot of the macro environment before chat-history evaluation mutates it. */
  macroEnvSeed?: import("../macros/types").MacroEnv;
}

interface InlineCouncilToolResult {
  callId: string;
  qualifiedName: string;
  toolName: string;
  toolDisplayName: string;
  memberName?: string;
  result: string;
}

/**
 * If the generated content contains an unclosed reasoning/thinking tag
 * (e.g. generation was interrupted mid-thought), append the closing tag
 * so the frontend can properly collapse the reasoning block.
 */
function closeUnterminatedReasoningTags(
  userId: string,
  content: string,
): string {
  if (!content) return content;

  const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
  return closeUnterminatedDelimitedReasoning(
    content,
    resolveReasoningDelimiters(reasoningSetting?.value),
  );
}

function getReasoningParseConfig(userId: string): {
  enabled: boolean;
  delimiters: ReturnType<typeof resolveReasoningDelimiters>;
} {
  const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
  return {
    enabled: reasoningSetting?.value?.autoParse === true,
    delimiters: resolveReasoningDelimiters(reasoningSetting?.value),
  };
}

function appendInterceptorBreakdownEntries(
  breakdown: AssemblyBreakdownEntry[] | undefined,
  interceptorBreakdown: InterceptorBreakdownEntry[] | undefined,
): AssemblyBreakdownEntry[] | undefined {
  if (!breakdown || !interceptorBreakdown || interceptorBreakdown.length === 0)
    return breakdown;
  const injected = interceptorBreakdown
    .slice()
    .sort((a, b) => a.messageIndex - b.messageIndex)
    .map((entry) => ({
      type: "extension" as const,
      name: entry.name,
      role: entry.role,
      content: entry.content,
      extensionId: entry.extensionId,
      extensionName: entry.extensionName,
    }));
  return [...breakdown, ...injected];
}

function applyDelimitedReasoningParsing(
  userId: string,
  response: GenerationResponse,
): GenerationResponse {
  const { enabled, delimiters } = getReasoningParseConfig(userId);
  const parsed = separateDelimitedReasoning(
    response.content,
    response.reasoning,
    delimiters,
    enabled,
  );
  return {
    ...response,
    content: parsed.content,
    ...(parsed.reasoning ? { reasoning: parsed.reasoning } : {}),
  };
}

function wrapDelimitedReasoningForUser(
  userId: string,
  stream: AsyncGenerator<StreamChunk, void, unknown>,
): AsyncGenerator<StreamChunk, void, unknown> {
  const { enabled, delimiters } = getReasoningParseConfig(userId);
  return wrapDelimitedReasoningStream(stream, delimiters, enabled);
}

/**
 * Safely extract a human-readable message from a thrown value.
 * Bun's fetch/stream internals on Windows can reject with `null` when an
 * abort signal fires mid-stream, so `err.message` would throw a TypeError
 * and crash the server. Handles null, undefined, strings, and non-Error
 * objects gracefully.
 */
function errorMessage(err: unknown): string {
  if (err == null) return "Unknown error";
  if (typeof err === "string") return err;
  if (
    typeof err === "object" &&
    "message" in err &&
    typeof (err as any).message === "string"
  ) {
    return (err as any).message;
  }
  try {
    return String(err);
  } catch {
    return "Unknown error";
  }
}

function parseInlineToolCallName(
  name: string,
): { memberIdPrefix: string; qualifiedName: string } | null {
  const splitIdx = name.indexOf("_");
  if (splitIdx <= 0 || splitIdx >= name.length - 1) return null;
  return {
    memberIdPrefix: name.slice(0, splitIdx),
    qualifiedName: name.slice(splitIdx + 1),
  };
}

async function executeInlineCouncilToolCalls(
  userId: string,
  toolCalls: ToolCallResult[],
  timeoutMs: number,
  toolsByName: Map<string, RuntimeCouncilToolDefinition>,
  membersByPrefix: Map<string, CouncilMember> | undefined,
  contextMessages: LlmMessage[],
): Promise<InlineCouncilToolResult[]> {
  const results: InlineCouncilToolResult[] = [];

  for (const toolCall of toolCalls) {
    // Try Council-prefixed tool name first (memberIdPrefix_toolName)
    const parsedName = parseInlineToolCallName(toolCall.name);
    let tool: RuntimeCouncilToolDefinition | undefined;
    let member: CouncilMember | undefined;
    let resolvedQualifiedName: string;

    if (parsedName) {
      const { memberIdPrefix, qualifiedName } = parsedName;
      tool = toolsByName.get(qualifiedName);
      member = membersByPrefix?.get(memberIdPrefix);
      resolvedQualifiedName = qualifiedName;
    }

    // Fall back to direct lookup — extension inline tools use the sanitized
    // name directly (extensionId__toolName) without a member prefix.
    if (!tool) {
      tool = toolsByName.get(toolCall.name);
      resolvedQualifiedName = toolCall.name;
    }

    if (!tool) continue;
    // Council tools require a member match; extension inline tools do not
    if (parsedName && !member && membersByPrefix?.size) continue;

    const execution = getCouncilToolExecution(userId, tool);
    if (execution === "llm") continue;

    let result = "";

    if (execution === "mcp") {
      const mcpMatch = parseMcpToolName(userId, resolvedQualifiedName!);
      if (!mcpMatch) continue;

      result = await getMcpClientManager().callTool(
        userId,
        mcpMatch.serverId,
        mcpMatch.toolName,
        toolCall.args ?? {},
        timeoutMs,
      );
    } else if (execution === "extension") {
      // Resolve the extension tool registration. For extension inline tools,
      // the qualified name uses __ instead of : (sanitized for LLM function names).
      const extQualified = resolvedQualifiedName!.replace(/__/g, ":");
      const extToolReg = getExtensionToolRegistration(extQualified);
      if (!extToolReg) continue;

      let memberContext: import("lumiverse-spindle-types").CouncilMemberContext | undefined;
      if (member) {
        let lumiaItem: ReturnType<typeof packsSvc.getLumiaItem> = null;
        try {
          lumiaItem = packsSvc.getLumiaItem(userId, member.itemId);
        } catch {
          // Pack/item may have been removed mid-generation.
        }
        memberContext = buildCouncilMemberContext(member, lumiaItem);
      }

      const contextSummary = contextMessages
        .map((m) => {
          const prefix = m.role === "system" ? "" : `${m.role}: `;
          return `${prefix}${typeof m.content === "string" ? m.content : ""}`;
        })
        .join("\n\n");

      result = await invokeExtensionCouncilTool(
        extToolReg.extension_id,
        extToolReg.name,
        {
          ...(toolCall.args ?? {}),
          context: contextSummary,
          __deadlineMs: Date.now() + timeoutMs,
        },
        timeoutMs,
        memberContext,
        contextMessages,
      );
    } else if (execution === "host") {
      if (!member) continue; // Host tools require a council member
      let lumiaItem: ReturnType<typeof packsSvc.getLumiaItem> = null;
      try {
        lumiaItem = packsSvc.getLumiaItem(userId, member.itemId);
      } catch {
        // Pack/item may have been removed mid-generation.
      }

      result = await executeHostCouncilTool({
        userId,
        tool,
        args: toolCall.args ?? {},
        member,
        memberContext: buildCouncilMemberContext(member, lumiaItem),
        contextMessages,
        timeoutMs,
      });
    }

    results.push({
      callId: toolCall.call_id,
      qualifiedName: resolvedQualifiedName!,
      toolName: tool.name,
      toolDisplayName: tool.displayName,
      memberName: member?.itemName,
      result,
    });
  }

  return results;
}

function formatInlineCouncilToolResults(
  results: InlineCouncilToolResult[],
): string {
  const lines = [
    "## Inline Council Tool Results",
    "The model requested council tool calls during generation. Use these results to continue the reply naturally.",
    "",
  ];

  for (const result of results) {
    lines.push(
      `### ${result.memberName ? `${result.memberName} - ` : ""}${result.toolDisplayName}`,
    );
    lines.push(result.result || "(empty result)");
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Race a promise against an AbortSignal. If the signal fires before the
 * promise settles, rejects with the signal's reason (or a standard AbortError).
 * Used to tear down long-running pipelines (prompt assembly, etc.) whose inner
 * awaits may not all be signal-aware — the race guarantees the caller unwinds
 * immediately on abort instead of stalling behind a blocking op.
 */
function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException("Aborted", "AbortError"),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

// Track active generations for stop support
const activeGenerations = new Map<
  string,
  {
    controller: AbortController;
    userId: string;
    chatId: string;
    startedAt: number;
  }
>();

// Per-chat generation lock: prevents concurrent generations (including council) in the same chat.
// Keyed by `${userId}:${chatId}` → generationId. Registered BEFORE council execution so that
// a second request for the same chat will abort the in-flight one (including its council tools).
const activeChatGenerations = new Map<string, string>();

// Pending council retry decisions: when council tools partially fail, the generation
// pauses and waits for the user to decide whether to continue or retry. Keyed by
// generationId → { resolve, timeout }. The user responds via POST /generate/council-retry.
/** Safety cap: auto-continue after 10 minutes to prevent permanent resource hangs */
const COUNCIL_RETRY_SAFETY_CAP_MS = 10 * 60 * 1000;

const pendingCouncilRetries = new Map<
  string,
  {
    userId: string;
    resolve: (decision: "continue" | "retry") => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Called from the council-retry route to resolve a pending decision. Verifies
 * the generation belongs to the caller — without this check, any authenticated
 * user could approve/retry another user's pending generation by guessing IDs.
 */
export function resolveCouncilRetry(
  userId: string,
  generationId: string,
  decision: "continue" | "retry",
): boolean {
  const pending = pendingCouncilRetries.get(generationId);
  if (!pending) return false;
  if (pending.userId !== userId) return false;
  clearTimeout(pending.timeout);
  pendingCouncilRetries.delete(generationId);
  // Clear the pool flag
  const poolEntry = pool.getPoolEntry(generationId);
  if (poolEntry) {
    poolEntry.councilRetryPending = false;
    delete poolEntry.councilToolsFailure;
  }
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

type ReasoningSettingsSnapshot = {
  apiReasoning?: boolean;
  reasoningEffort?: string;
  thinkingDisplay?: string;
} | null;

type CouncilResultCache = CachedCouncilResult & {
  fingerprint?: string;
};

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function buildCouncilCacheFingerprint(
  councilSettings: import("lumiverse-spindle-types").CouncilSettings,
  sidecarSettings: import("lumiverse-spindle-types").SidecarConfig,
): string {
  return stableJson({
    version: 1,
    members: councilSettings.members.map((member) => ({
      id: member.id,
      itemId: member.itemId,
      role: member.role,
      chance: member.chance,
      tools: member.tools,
    })),
    toolsSettings: {
      mode: councilSettings.toolsSettings.mode,
      timeoutMs: councilSettings.toolsSettings.timeoutMs,
      sidecarContextWindow: councilSettings.toolsSettings.sidecarContextWindow,
      includeUserPersona: councilSettings.toolsSettings.includeUserPersona,
      includeCharacterInfo: councilSettings.toolsSettings.includeCharacterInfo,
      includeWorldInfo: councilSettings.toolsSettings.includeWorldInfo,
      allowUserControl: councilSettings.toolsSettings.allowUserControl,
      maxWordsPerTool: councilSettings.toolsSettings.maxWordsPerTool,
    },
    sidecar: {
      connectionProfileId: sidecarSettings.connectionProfileId,
      model: sidecarSettings.model,
      temperature: sidecarSettings.temperature,
      topP: sidecarSettings.topP,
      maxTokens: sidecarSettings.maxTokens,
    },
  });
}

function isReusableCouncilCache(
  cached: CouncilResultCache | undefined,
  fingerprint: string,
): boolean {
  if (!cached?.results?.length) return false;
  if (cached.results.some((result) => !result.success)) return false;
  return cached.fingerprint === fingerprint;
}

function getEffectiveReasoningSettings(
  userId: string,
  connection?: { metadata?: Record<string, any> | null } | null,
): ReasoningSettingsSnapshot {
  const boundSettings = connection?.metadata?.reasoningBindings?.settings;
  if (boundSettings && typeof boundSettings === "object") {
    return boundSettings as ReasoningSettingsSnapshot;
  }

  const reasoningSetting = settingsSvc.getSetting(userId, "reasoningSettings");
  return (reasoningSetting?.value as ReasoningSettingsSnapshot | undefined) ?? null;
}

function applyEffectiveReasoningSettings(
  userId: string,
  connection: { metadata?: Record<string, any> | null },
  providerName: string,
  modelName: string | undefined,
  params: GenerationParameters,
): void {
  const reasoningSettings = getEffectiveReasoningSettings(userId, connection);

  if (reasoningSettings?.apiReasoning) {
    const effort = reasoningSettings.reasoningEffort || "auto";
    const isToggleOnly = providerName === "moonshot" || providerName === "zai";
    if (effort !== "auto" || isToggleOnly) {
      injectReasoningParams(
        params,
        providerName,
        effort,
        modelName,
        reasoningSettings.thinkingDisplay,
      );
    }
    return;
  }

  if (reasoningSettings?.apiReasoning !== false) return;

  applyProviderReasoningOffSwitch(params as any, providerName, modelName);
}

/** Resolve provider and API key from a connection profile. */
async function resolveProviderAndKey(
  userId: string,
  connectionId: string,
): Promise<{ provider: LlmProvider; apiKey: string; apiUrl: string }> {
  const connection = connectionsSvc.getConnection(userId, connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const provider = getProvider(connection.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${connection.provider}`);
  }

  const apiKey = await secretsSvc.getSecret(
    userId,
    connectionsSvc.connectionSecretKey(connectionId),
  );
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    throw new Error(
      `No API key found for connection "${connection.name}". Add one via the connection settings.`,
    );
  }

  return {
    provider,
    apiKey: apiKey || "",
    apiUrl: connectionsSvc.resolveEffectiveApiUrl(connection),
  };
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
  forcePresetId?: boolean;
  personaId?: string;
  personaAddonStates?: Record<string, boolean>;
  generationType: string;
  impersonateMode?: ImpersonateMode;
  impersonateInput?: string;
  inputMessages?: LlmMessage[];
  inputParameters?: GenerationParameters;
  excludeMessageId?: string;
  targetCharacterId?: string;
  councilToolResults?: any[];
  councilNamedResults?: Record<string, string>;
  precomputedVectorEntries?: VectorActivatedEntry[];
  regenFeedback?: string;
  regenFeedbackPosition?: "system" | "user";
  signal?: AbortSignal;
}): Promise<PromptPipelineResult> {
  // Yield to the event loop before entering the assembly pipeline so a stop
  // clicked in the first few ticks after the generation starts can actually
  // be processed. Without this yield the pipeline runs back-to-back from the
  // caller's await through contextHandlerChain and the dynamic prefetch
  // import, synchronously blocking the HTTP server from picking up the stop
  // request.
  await new Promise<void>((r) => setTimeout(r, 0));
  if (opts.signal?.aborted)
    throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");

  // Build spindle context
  let spindleContext: SpindleContext = {
    chatId: opts.chatId,
    connectionId: opts.connectionId,
    personaId: opts.personaId,
    generationType: opts.generationType,
  };
  if (contextHandlerChain.count > 0) {
    spindleContext = (await contextHandlerChain.run(
      spindleContext,
      opts.userId,
      opts.signal,
    )) as SpindleContext;
  }

  // Build messages: use explicit messages if provided, otherwise assemble from preset
  let messages: LlmMessage[];
  let assembledParams: GenerationParameters = {};
  let breakdown: AssemblyBreakdownEntry[] | undefined;
  let interceptorBreakdown: InterceptorBreakdownEntry[] | undefined;
  let assistantPrefill: string | undefined;
  let activatedWorldInfo: ActivatedWorldInfoEntry[] | undefined;
  let worldInfoStats: DryRunResult["worldInfoStats"] | undefined;
  let memoryStats: import("../llm/types").MemoryStats | undefined;
  let databankStats: import("../llm/types").DatabankStats | undefined;
  let contextClipStats: import("../llm/types").ContextClipStats | undefined;
  let deferredWiState:
    | { chatId: string; partial: Record<string, any> }
    | undefined;
  let macroEnv: import("../macros/types").MacroEnv | undefined;

  let deliberationHandledByMacro = false;

  if (opts.inputMessages) {
    messages = opts.inputMessages;
  } else {
    const assemblyCtx = {
      userId: opts.userId,
      chatId: opts.chatId,
      connectionId: opts.connectionId,
      presetId: opts.presetId,
      forcePresetId: opts.forcePresetId,
      personaId: opts.personaId,
      personaAddonStates: opts.personaAddonStates,
      generationType: opts.generationType as GenerationType,
      impersonateMode: opts.impersonateMode,
      impersonateInput: opts.impersonateInput,
      excludeMessageId: opts.excludeMessageId,
      targetCharacterId: opts.targetCharacterId,
      councilToolResults: opts.councilToolResults,
      councilNamedResults: opts.councilNamedResults,
      precomputedVectorEntries: opts.precomputedVectorEntries,
      regenFeedback: opts.regenFeedback,
      regenFeedbackPosition: opts.regenFeedbackPosition,
      signal: opts.signal,
    };

    let assemblyResult: Awaited<ReturnType<typeof assemblePrompt>>;

    if (canUsePromptAssemblyWorker()) {
      try {
        assemblyResult = await assemblePromptInWorker(assemblyCtx);
      } catch (err: any) {
        if (opts.signal?.aborted || err?.name === "AbortError") throw err;
        console.warn(
          "[generate] Prompt assembly worker failed; falling back to in-process assembly:",
          err?.message || err,
        );
        const { prefetchAssemblyData } = await import("./prompt-assembly-prefetch");
        const prefetched = await prefetchAssemblyData(assemblyCtx);
        assemblyResult = await assemblePrompt({ ...assemblyCtx, prefetched });
      }
    } else {
      // Batch-prefetch all data the assembly pipeline needs in ~7 queries
      // instead of the ~35-40 scattered individual calls inside assemblePrompt.
      // Thread the signal so prefetch yields + bails out if the user aborts
      // during its synchronous DB reads.
      const { prefetchAssemblyData } = await import("./prompt-assembly-prefetch");
      const prefetched = await prefetchAssemblyData(assemblyCtx);

      // All presets (classic and lumi) go through the same assembly path
      assemblyResult = await assemblePrompt({ ...assemblyCtx, prefetched });
    }

    messages = assemblyResult.messages;
    assembledParams = assemblyResult.parameters;
    breakdown = assemblyResult.breakdown;
    assistantPrefill = assemblyResult.assistantPrefill;
    activatedWorldInfo = assemblyResult.activatedWorldInfo;
    worldInfoStats = assemblyResult.worldInfoStats;
    memoryStats = assemblyResult.memoryStats;
    databankStats = assemblyResult.databankStats;
    contextClipStats = assemblyResult.contextClipStats;
    deferredWiState = assemblyResult.deferredWiState;
    deliberationHandledByMacro = !!assemblyResult.deliberationHandledByMacro;
    macroEnv = assemblyResult.macroEnv;
  }

  // Snapshot chat history messages BEFORE interceptors/post-processing can
  // splice, merge, or reorder the array.  This snapshot is the shared
  // tokenization source used by both dry-run and generation breakdowns.
  // Filter by the chat-history identity marker rather than slicing by
  // breakdown bounds: depth-injected blocks (WI depth, Author's Note, depth
  // blocks, EM/AN-after) can splice non-history messages INTO the chat
  // history range, which would corrupt a slice-based snapshot.
  let chatHistoryMessages: LlmMessage[] | undefined;
  if (breakdown) {
    const filtered = messages.filter(isChatHistoryMessage);
    if (filtered.length > 0) chatHistoryMessages = filtered;
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
      opts.userId,
      opts.signal,
    );
    messages = interceptorResult.messages as unknown as LlmMessage[];
    interceptorParameters = interceptorResult.parameters;
    interceptorBreakdown = interceptorResult.breakdown;
  }

  // Apply promptPostProcessing
  const postProcessing = settingsSvc.getSetting(
    opts.userId,
    "promptPostProcessing",
  );
  if (postProcessing?.value) {
    applyPostProcessing(messages, postProcessing.value);
  }

  // Normal assembly applies prompt-target regexes before context clipping.
  // Keep this fallback for raw/explicit message callers that bypass assembly.
  if (opts.inputMessages) {
    const chatForRegex = chatsSvc.getChat(opts.userId, opts.chatId);
    const characterId = opts.targetCharacterId || chatForRegex?.character_id;
    const promptScripts = regexScriptsSvc.getActiveScripts(opts.userId, {
      characterId,
      chatId: opts.chatId,
      target: "prompt",
    });
    if (promptScripts.length > 0) {
      // Build a per-index depth map from the chat-history marker. Walk
      // messages in order, collect indices that carry the marker, then assign
      // depth = (totalChatHistory - 1 - positionInHistory) so the latest chat
      // history message gets depth 0 and the oldest gets depth N-1. This
      // works regardless of contiguity — depth-injected blocks splicing into
      // the chat history range no longer skew depth values.
      const chatHistoryDepth = new Map<number, number>();
      const chIndices: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (isChatHistoryMessage(messages[i])) chIndices.push(i);
      }
      for (let pos = 0; pos < chIndices.length; pos++) {
        chatHistoryDepth.set(chIndices[pos], chIndices.length - 1 - pos);
      }

      const regexedChatHistoryMessages: LlmMessage[] = [];

      for (let i = 0; i < messages.length; i++) {
        // Cooperative cancellation: applyRegexScripts runs every enabled
        // prompt-target script against every message (N scripts × M messages
        // regex executions). On long chats this can block the event loop for
        // hundreds of ms; yield every 16 messages so /generate/stop lands.
        if (i > 0 && (i & 15) === 0) {
          await new Promise<void>((r) => setTimeout(r, 0));
          if (opts.signal?.aborted) {
            throw (
              opts.signal.reason ?? new DOMException("Aborted", "AbortError")
            );
          }
        }
        const msg = messages[i];
        const wasChatHistory = isChatHistoryMessage(msg);
        const placement =
          msg.role === "user"
            ? ("user_input" as const)
            : msg.role === "assistant"
              ? ("ai_output" as const)
              : ("world_info" as const);

        const depth = chatHistoryDepth.get(i);

        if (typeof msg.content === "string") {
          messages[i] = {
            ...msg,
            content: await regexScriptsSvc.applyRegexScripts(
              msg.content,
              promptScripts,
              placement,
              depth,
              macroEnv,
            ),
          };
        } else if (Array.isArray(msg.content)) {
          const resolvedParts = await Promise.all(
            msg.content.map(async (part: any) =>
              part.type === "text"
                ? {
                    ...part,
                    text: await regexScriptsSvc.applyRegexScripts(
                      part.text,
                      promptScripts,
                      placement,
                      depth,
                      macroEnv,
                    ),
                  }
                : part,
            ),
          );
          messages[i] = { ...msg, content: resolvedParts };
        }

        if (wasChatHistory) {
          regexedChatHistoryMessages.push(messages[i]);
        }
      }

      if (regexedChatHistoryMessages.length > 0) {
        chatHistoryMessages = regexedChatHistoryMessages;
        const chatHistoryEntry = breakdown?.find(
          (e) => e.type === "chat_history",
        );
        if (chatHistoryEntry) delete chatHistoryEntry.preCountedTokens;
      }

      if (interceptorBreakdown && interceptorBreakdown.length > 0) {
        for (const entry of interceptorBreakdown) {
          const placement =
            entry.role === "user"
              ? ("user_input" as const)
              : entry.role === "assistant"
                ? ("ai_output" as const)
                : ("world_info" as const);
          entry.content = await regexScriptsSvc.applyRegexScripts(
            entry.content,
            promptScripts,
            placement,
            undefined,
            macroEnv,
          );
        }
      }
    }
  }

  // Filter out any messages that became entirely empty after interceptors/regex scripts.
  // Many providers and LLM proxies drop requests entirely or hang if they encounter empty messages.
  const hasNonEmptyContent = (msg: LlmMessage) => {
    if (typeof msg.content === "string") return msg.content.trim().length > 0;
    if (Array.isArray(msg.content)) return msg.content.length > 0;
    return true;
  };
  messages = messages.filter(hasNonEmptyContent);
  if (chatHistoryMessages) {
    chatHistoryMessages = chatHistoryMessages.filter(hasNonEmptyContent);
  }

  breakdown = appendInterceptorBreakdownEntries(
    breakdown,
    interceptorBreakdown,
  );

  // Merge parameters: assembled (from preset) < interceptor overrides < request overrides
  const parameters: GenerationParameters = {
    ...assembledParams,
    ...interceptorParameters,
    ...opts.inputParameters,
  };
  const effectiveConnection = resolveConnection(
    opts.userId,
    spindleContext.connectionId || opts.connectionId,
  );
  applyEffectiveReasoningSettings(
    opts.userId,
    effectiveConnection,
    effectiveConnection.provider,
    effectiveConnection.model || undefined,
    parameters,
  );

  return {
    messages,
    parameters,
    breakdown,
    chatHistoryMessages,
    assistantPrefill,
    activatedWorldInfo,
    worldInfoStats,
    memoryStats,
    databankStats,
    contextClipStats,
    deferredWiState,
    spindleContext,
    deliberationHandledByMacro,
    macroEnv,
  };
}

/** Resolve provider and key for raw generate: supports connection_id, direct api_key, or provider-name lookup. */
async function resolveRawProviderAndKey(
  userId: string,
  input: RawGenerateInput,
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
    throw new Error(
      `No API key provided. Pass api_key or connection_id in the request.`,
    );
  }

  return { provider, apiKey: "", apiUrl: input.api_url || "" };
}

export async function startGeneration(
  input: GenerateInput,
): Promise<{ generationId: string; status: string }> {
  const generationId = crypto.randomUUID();
  let genType = input.generation_type || "normal";

  // Safety fallback: regenerate/continue should only target an assistant
  // message when the latest chat message is assistant-authored.
  // If the latest message is user (common right after send), treat this as
  // normal generation so we create a new assistant reply instead of mutating
  // an older assistant message (e.g. greeting at index 0).
  // Skip this check when an explicit message_id is provided — the frontend
  // already validated the target.
  if (
    (genType === "regenerate" || genType === "continue") &&
    !input.message_id
  ) {
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
      console.debug(
        "[generate] Aborting existing generation %s for chat %s before starting new one",
        existingGenId,
        input.chat_id,
      );
      existing.controller.abort();
    }
    activeGenerations.delete(existingGenId);
    activeChatGenerations.delete(chatKey);
  }

  // Tear down any fire-and-forget background work (cortex cache warming,
  // databank retrieval) left over from prior generations on this chat.
  // Successful completions don't abort their own controllers, so without
  // this, slow embedding APIs can accumulate orphan tasks across sends.
  abortChatBackground(input.userId, input.chat_id);

  // Register this generation early (before council) so it can be tracked and aborted
  const abortController = new AbortController();
  activeGenerations.set(generationId, {
    controller: abortController,
    userId: input.userId,
    chatId: input.chat_id,
    startedAt: Date.now(),
  });
  activeChatGenerations.set(chatKey, generationId);

  // Helper: bail out cleanly if aborted during the setup phase.
  // Throws the same DOMException shape that fetch / AbortSignal.any use so
  // intermediate catches that sniff `err.name === "AbortError"` re-throw
  // rather than swallowing it.
  const checkAborted = () => {
    if (abortController.signal.aborted) {
      throw (
        abortController.signal.reason ??
        new DOMException("Aborted", "AbortError")
      );
    }
  };

  // Hoisted so the catch block can clean up the staged message on abort
  let stagedMessageId: string | undefined;

  try {
    const connection = resolveConnection(input.userId, input.connection_id);
    if (
      input.force_preset_id &&
      genType === "impersonate" &&
      input.impersonate_mode === "oneliner" &&
      input.preset_id &&
      !presetsSvc.getPreset(input.userId, input.preset_id)
    ) {
      console.warn(
        "[generate] Clearing stale chat impersonation preset override %s for chat %s",
        input.preset_id,
        input.chat_id,
      );
      chatsSvc.mergeChatMetadata(input.userId, input.chat_id, {
        impersonation_preset_id: undefined,
      });
      input.preset_id = undefined;
      input.force_preset_id = false;
    }
    presetsSvc.assertUsablePreset(
      input.userId,
      input.preset_id,
      connection.preset_id,
    );
    const { provider, apiKey, apiUrl } = await resolveProviderAndKey(
      input.userId,
      connection.id,
    );

    // Resolve character name for saved messages — prefer target_character_id for group chats
    const chat = chatsSvc.getChat(input.userId, input.chat_id);
    if (genType === "normal") {
      const lastMessage = chatsSvc.getLastMessage(input.userId, input.chat_id);
      const attachments = Array.isArray(lastMessage?.extra?.attachments)
        ? lastMessage.extra.attachments
        : [];
      const hasAttachments = attachments.length > 0;
      if (
        lastMessage?.is_user &&
        lastMessage.content.trim().length === 0 &&
        !hasAttachments
      ) {
        throw new Error("Cannot generate from an empty user message.");
      }
    }
    let characterName = "Assistant";
    const targetCharId = input.target_character_id || chat?.character_id;
    if (targetCharId) {
      const character = charactersSvc.getCharacter(input.userId, targetCharId);
      if (character) characterName = getEffectiveCharacterName(character);
    }

    // Resolve persona_id from settings if not provided by the frontend, so the
    // persona's attached world book is always included regardless of UI state.
    if (!input.persona_id) {
      const activePersonaSetting = settingsSvc.getSetting(
        input.userId,
        "activePersonaId",
      );
      if (
        activePersonaSetting?.value &&
        typeof activePersonaSetting.value === "string"
      ) {
        input.persona_id = activePersonaSetting.value;
      }
    }

    // Resolve target message EARLY (before council) so we can visually clear the
    // message on the frontend before council tools start executing.
    let resolvedPersona = personasSvc.resolvePersonaOrDefault(
      input.userId,
      input.persona_id,
    );
    if (!input.persona_addon_states) {
      input.persona_addon_states = getChatPersonaAddonStates(
        chat?.metadata,
        resolvedPersona?.id,
      );
    }
    resolvedPersona = applyPersonaAddonStates(
      resolvedPersona,
      input.persona_addon_states,
    );

    const lifecycle: GenerationLifecycle = {
      characterName,
      generationType: genType,
      personaId: resolvedPersona?.id,
      personaName: resolvedPersona?.name || "User",
      targetCharacterId: targetCharId,
      impersonateDraft: genType === "impersonate" && !!input.impersonate_draft,
    };
    if (genType === "normal") {
      lifecycle.sourceUserMessageIds = collectTrailingUserMessageIds(
        input.userId,
        input.chat_id,
      );
    }

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
        if (
          prevExtra &&
          (prevExtra.tokenCount != null ||
            prevExtra.generationMetrics ||
            prevExtra.usage ||
            prevExtra.reasoning ||
            prevExtra.reasoningDuration)
        ) {
          const {
            tokenCount: _,
            generationMetrics: _gm,
            usage: _u,
            reasoning: _r,
            reasoningDuration: _rd,
            ...cleanExtra
          } = prevExtra;
          chatsSvc.patchMessageExtra(input.userId, targetMsg.id, cleanExtra);
        }
      }
    } else if (genType === "continue") {
      const lastMsg = chatsSvc.getLastAssistantMessage(
        input.userId,
        input.chat_id,
      );
      if (lastMsg) {
        lifecycle.continueMessageId = lastMsg.id;
        lifecycle.continueOriginalContent = lastMsg.content;
        // Resolve continuePostfix from the preset's completion settings so it can
        // be inserted between original content and generated text when saving.
        const cpPresetId = input.preset_id || connection.preset_id;
        const cpPreset = cpPresetId
          ? presetsSvc.getPreset(input.userId, cpPresetId)
          : null;
        lifecycle.continuePostfix =
          cpPreset?.prompts?.completionSettings?.continuePostfix || "";
      }
    }

    // Stage an empty assistant message early for normal sends so the frontend
    // has a real message ID to attach to the streaming bubble via data-message-id.
    // This eliminates the duplicate ephemeral bubble and renders tokens in-place
    // on the message card, matching the regenerate/swipe UX.
    if (genType === "normal") {
      const extra: Record<string, any> = {};
      if (input.target_character_id)
        extra.character_id = input.target_character_id;
      const stagedMsg = chatsSvc.createMessage(
        input.chat_id,
        {
          is_user: false,
          name: characterName,
          content: "",
          extra: Object.keys(extra).length > 0 ? extra : undefined,
        },
        input.userId,
      );
      stagedMessageId = stagedMsg.id;
      lifecycle.targetMessageId = stagedMsg.id;
      excludeMessageId = stagedMsg.id;
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
    eventBus.emit(
      EventType.GENERATION_STARTED,
      {
        generationId,
        chatId: input.chat_id,
        model: connection.model,
        targetMessageId: lifecycle.targetMessageId,
        characterId: targetCharId,
        characterName,
        generationType: lifecycle.generationType,
      },
      input.userId,
    );

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
      await new Promise<void>((r) => setTimeout(r, 0));
      try {
        // Execute council if enabled (before prompt assembly so it doesn't slow the critical path visibly)
        const resolvedCouncilProfile = councilProfilesSvc.resolveProfile(
          input.userId,
          input.chat_id,
          chat?.character_id ?? null,
          { isGroup: chat?.metadata?.group === true },
        );
        const councilSettings = resolvedCouncilProfile.council_settings;
        let councilResult: CouncilExecutionResult | null = null;
        let inlineTools: ToolDefinition[] | undefined;
        let inlineToolDefsByName:
          | Map<string, RuntimeCouncilToolDefinition>
          | undefined;
        let inlineMembersByPrefix: Map<string, CouncilMember> | undefined;
        let precomputedVectorEntries: VectorActivatedEntry[] | undefined;

        // Council is active when enabled with members. Tools run if any member has tools assigned.
        const councilActive =
          councilSettings.councilMode && councilSettings.members.length > 0;
        const councilHasTools =
          councilActive &&
          councilSettings.members.some((m) => m.tools.length > 0);

        if (councilHasTools && genType !== "impersonate") {
          pool.setPoolStatus(generationId, "council");
          if (councilSettings.toolsSettings.mode === "inline") {
            // Inline mode requires enableFunctionCalling in the preset's completion
            // settings — the tools are registered as native function calls with the
            // primary LLM. Sidecar mode has no such requirement.
            const presetId = input.preset_id || connection.preset_id;
            const preset = presetId
              ? presetsSvc.getPreset(input.userId, presetId)
              : null;
            const completionSettings = preset?.prompts?.completionSettings;
            if (completionSettings?.enableFunctionCalling === false) {
              console.warn(
                "[council] Inline tools skipped: enableFunctionCalling is disabled in preset '%s'",
                preset?.name,
              );
            } else {
              const availableTools = await getAvailableTools(input.userId);
              const activeMembers = councilSettings.members.filter(
                (m) => m.tools.length > 0,
              );
              inlineTools = [];
              inlineToolDefsByName = new Map<
                string,
                RuntimeCouncilToolDefinition
              >();
              inlineMembersByPrefix = new Map<string, CouncilMember>();
              for (const member of activeMembers) {
                inlineMembersByPrefix.set(member.id.slice(0, 8), member);
                for (const toolName of member.tools) {
                  const toolDef = availableTools.find(
                    (t) => t.name === toolName,
                  );
                  if (!toolDef) continue;

                  if (!isCouncilToolInlineCallable(input.userId, toolDef)) {
                    continue;
                  }

                  const argsSchema = getCouncilToolArgsSchema(
                    input.userId,
                    toolDef,
                  );
                  if (!argsSchema) continue;

                  inlineToolDefsByName.set(toolDef.name, toolDef);
                  inlineTools.push({
                    name: `${member.id.slice(0, 8)}_${toolDef.name}`,
                    description: `[${member.itemName}${member.role ? ` - ${member.role}` : ""}] ${toolDef.description}`,
                    parameters: argsSchema,
                    strict: toolDef.strict ?? true,
                    inputExamples: toolDef.inputExamples,
                  });
                }
              }
              if (inlineTools.length === 0) {
                inlineTools = undefined;
                inlineToolDefsByName = undefined;
                inlineMembersByPrefix = undefined;
              }
            }
          } else {
            // Check if we can reuse cached council results for regens/swipes/continues
            const shouldRetain =
              councilSettings.toolsSettings.retainResultsForRegens &&
              (genType === "regenerate" ||
                genType === "swipe" ||
                genType === "continue" ||
                input.retain_council);
            const councilCacheFingerprint = buildCouncilCacheFingerprint(
              councilSettings,
              resolvedCouncilProfile.sidecar_settings,
            );
            const cached = shouldRetain
              ? (chat?.metadata?.last_council_results as
                  | CouncilResultCache
                  | undefined)
              : undefined;

            if (cached && isReusableCouncilCache(cached, councilCacheFingerprint)) {
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
              if (cached?.results?.length) {
                console.debug(
                  "[council] Ignoring stale cached results for %s (cachedAt=%d, results=%d, fingerprint=%s)",
                  genType,
                  cached.cachedAt,
                  cached.results.length,
                  cached.fingerprint ? "mismatch" : "missing",
                );
              }

              // Sidecar mode: stage an empty assistant message BEFORE council execution
              // so the frontend has a real message bubble to stream tokens into. Without
              // this, the HTTP response (and thus startStreaming) arrives after council
              // completes, racing with WS events that may have already finished.
              // Guard: normal sends are already staged above; only stage here for swipe
              // or for sidecar council paths that bypassed the early staging.
              if (
                !stagedMessageId &&
                (genType === "normal" || genType === "swipe")
              ) {
                const extra: Record<string, any> = {};
                if (input.target_character_id)
                  extra.character_id = input.target_character_id;
                const stagedMsg = chatsSvc.createMessage(
                  input.chat_id,
                  {
                    is_user: false,
                    name: characterName,
                    content: "",
                    extra: Object.keys(extra).length > 0 ? extra : undefined,
                  },
                  input.userId,
                );
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
              await new Promise<void>((r) => setTimeout(r, 0));
              checkAborted();

              // Pre-compute enrichment for council tools — resolve world info at the
              // top of the generation chain so tools receive proper world book context.
              // Also filters out the staged empty message and excluded (regenerated)
              // message so council doesn't see blank assistant turns.
              const fullCharacter = chat
                ? charactersSvc.getCharacter(
                    input.userId,
                    targetCharId || chat.character_id,
                  )
                : null;
              const councilMessages = chatsSvc
                .getMessages(input.userId, input.chat_id)
                .filter(
                  (m) => m.id !== excludeMessageId && m.id !== stagedMessageId,
                );
              const { entries: wiEntries, worldBookIds: wiBookIds } =
                collectWorldInfoForCouncil(
                  input.userId,
                  fullCharacter,
                  resolvedPersona,
                  input.chat_id,
                );
              let councilWiActivated =
                wiEntries.length > 0
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
                input.chat_id,
                wiBookIds,
                wiEntries,
                councilMessages,
                abortController.signal,
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
                sidecarSettings: resolvedCouncilProfile.sidecar_settings,
                signal: abortController.signal,
                enrichment: councilEnrichment,
              });

              checkAborted();

              // Check for partial failures — if some tools failed, ask the user whether
              // to continue with partial results or retry the broken tools.
              if (councilResult) {
                const failedResults = councilResult.results.filter(
                  (r) => !r.success,
                );
                if (failedResults.length > 0) {
                  // Failure — emit event and wait for user decision. This covers
                  // both partial failures and all-tool failures (for example, a
                  // temporary sidecar/provider ban). The user must be able to
                  // retry after recovery instead of silently continuing with a
                  // failed council run.
                  eventBus.emit(
                    EventType.COUNCIL_TOOLS_FAILED,
                    {
                      generationId,
                      chatId: input.chat_id,
                      failedTools: failedResults.map((r) => ({
                        memberId: r.memberId,
                        memberName: r.memberName,
                        toolName: r.toolName,
                        toolDisplayName: r.toolDisplayName,
                        error: r.error,
                      })),
                      successCount:
                        councilResult.results.length - failedResults.length,
                      failedCount: failedResults.length,
                    },
                    input.userId,
                  );

                  // Mark pool entry so the active endpoint surfaces the pending state to chat heads
                  const poolEntry = pool.getPoolEntry(generationId);
                  if (poolEntry) {
                    poolEntry.councilRetryPending = true;
                    poolEntry.councilToolsFailure = {
                      generationId,
                      chatId: input.chat_id,
                      failedTools: failedResults.map((r) => ({
                        memberId: r.memberId,
                        memberName: r.memberName,
                        toolName: r.toolName,
                        toolDisplayName: r.toolDisplayName,
                        error: r.error,
                      })),
                      successCount:
                        councilResult.results.length - failedResults.length,
                      failedCount: failedResults.length,
                    };
                  }

                  // Pause indefinitely — no short timer. The frontend controls when to
                  // show the modal (only when the user navigates to this chat). A 10-minute
                  // safety cap prevents permanent resource hangs if the user never responds.
                  const decision = await new Promise<"continue" | "retry">(
                    (resolve) => {
                      const timeout = setTimeout(() => {
                        console.debug(
                          "[council] Safety cap reached for %s — auto-continuing",
                          generationId,
                        );
                        pendingCouncilRetries.delete(generationId);
                        if (poolEntry) {
                          poolEntry.councilRetryPending = false;
                          delete poolEntry.councilToolsFailure;
                        }
                        resolve("continue");
                      }, COUNCIL_RETRY_SAFETY_CAP_MS);
                      pendingCouncilRetries.set(generationId, {
                        userId: input.userId,
                        resolve,
                        timeout,
                      });
                    },
                  );

                  checkAborted();

                  if (decision === "retry") {
                    console.debug(
                      "[council] User chose retry — re-executing %d failed tools",
                      failedResults.length,
                    );
                    // Re-execute only the failed tools by creating a retry run
                    const retryResult = await executeCouncil({
                      userId: input.userId,
                      chatId: input.chat_id,
                      personaId: input.persona_id,
                      connectionId: input.connection_id,
                        settings: councilSettings,
                        sidecarSettings: resolvedCouncilProfile.sidecar_settings,
                        signal: abortController.signal,
                        enrichment: councilEnrichment,
                        retryToolNames: failedResults.map((r) => r.toolName),
                    });

                    checkAborted();

                    if (retryResult) {
                      // Merge: replace failed results with retry results, keep original successes
                      const retryResultMap = new Map(
                        retryResult.results.map((r) => [
                          `${r.memberId}:${r.toolName}`,
                          r,
                        ]),
                      );
                      const mergedResults = councilResult.results.map((r) => {
                        if (!r.success) {
                          const retried = retryResultMap.get(
                            `${r.memberId}:${r.toolName}`,
                          );
                          return retried ?? r;
                        }
                        return r;
                      });

                      // Rebuild the deliberation block from the full merged result set
                      const allTools = await getAvailableTools(input.userId);
                      const toolsMap = new Map(
                        allTools.map((t) => [t.name, t]),
                      );
                      councilResult = {
                        results: mergedResults,
                        deliberationBlock: formatDeliberation(
                          mergedResults,
                          toolsMap,
                        ),
                        totalDurationMs:
                          councilResult.totalDurationMs +
                          retryResult.totalDurationMs,
                      };
                    }
                  } else {
                    console.debug(
                      "[council] User chose continue — proceeding with %d successful results",
                      councilResult.results.length - failedResults.length,
                    );
                  }
                }
              }
            }
          }
        }

        // ── Extension Inline Tools (independent of Council) ──────────────
        // Extensions can register tools with `inline_available: true` to make
        // them callable by the primary model via native function calling, even
        // when no Council is configured. Gated by the same preset toggle.
        // Skip for impersonate — it generates user messages, not assistant
        // messages with tool-use capability.
        const extensionInlineTools =
          genType !== "impersonate"
            ? toolRegistry.getInlineAvailableTools()
            : [];
        if (extensionInlineTools.length > 0) {
          const presetId = input.preset_id || connection.preset_id;
          const preset = presetId
            ? presetsSvc.getPreset(input.userId, presetId)
            : null;
          const completionSettings = preset?.prompts?.completionSettings;
          if (completionSettings?.enableFunctionCalling !== false) {
            if (!inlineTools) inlineTools = [];
            if (!inlineToolDefsByName)
              inlineToolDefsByName = new Map<
                string,
                RuntimeCouncilToolDefinition
              >();

            for (const extTool of extensionInlineTools) {
              const qualifiedName = toolRegistry.getQualifiedName(extTool);
              // Sanitize the qualified name for LLM function calling —
              // some providers reject colons in function names.
              const safeName = qualifiedName.replace(/:/g, "__");

              // Wrap as RuntimeCouncilToolDefinition for the dispatch lookup
              const runtimeDef: RuntimeCouncilToolDefinition = {
                name: qualifiedName,
                displayName: extTool.display_name,
                description: extTool.description,
                category: "extension",
                execution: "extension",
                inputSchema: extTool.parameters,
              };

              const argsSchema = normalizeToolJsonSchema(extTool.parameters);
              inlineToolDefsByName.set(safeName, runtimeDef);
              inlineTools.push({
                name: safeName,
                description: extTool.description,
                parameters: argsSchema,
              });
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

          // Persist fully successful council results for potential reuse on regens/swipes.
          // Only cache when results were freshly executed (totalDurationMs > 0 distinguishes
          // a live execution from a cache hit which sets totalDurationMs to 0). Failed
          // results are intentionally not cached; otherwise one bad sidecar/tool call can
          // poison later regens and prevent council tools from re-firing.
          if (
            councilResult.totalDurationMs > 0 &&
            councilResult.results.every((result) => result.success)
          ) {
            const cachedResult: CouncilResultCache = {
              results: councilResult.results,
              deliberationBlock: councilResult.deliberationBlock,
              namedResults: councilNamedResults,
              cachedAt: Date.now(),
              fingerprint: buildCouncilCacheFingerprint(
                councilSettings,
                resolvedCouncilProfile.sidecar_settings,
              ),
            };
            try {
              // Atomic merge so we don't clobber concurrent user edits to chat
              // metadata (alternate field selections, world book attachments, etc.)
              // that landed while the council was running.
              chatsSvc.mergeChatMetadata(input.userId, input.chat_id, {
                last_council_results: cachedResult,
              });
            } catch (err) {
              console.warn(
                "[council] Failed to cache results to chat metadata:",
                err,
              );
            }
          }
        }

        checkAborted();

        // Run shared prompt pipeline — cortex retrieval runs concurrently inside assembly.
        // Raced against the abort signal so a stop request tears down the setup phase
        // immediately, even when an inner await (e.g. databank mention resolution with
        // large docs) is sleeping on a non-signal-aware op. The race rejects with a
        // DOMException("Aborted","AbortError") which is caught below and converted into
        // a GENERATION_STOPPED event so the frontend clears its streaming state.
        const pipeline = await raceWithSignal(
          runPromptPipeline({
            userId: input.userId,
            chatId: input.chat_id,
            connectionId: input.connection_id,
            presetId: input.preset_id,
            forcePresetId: input.force_preset_id,
            personaId: input.persona_id,
            personaAddonStates: input.persona_addon_states,
            generationType: genType,
            impersonateMode:
              genType === "impersonate"
                ? input.impersonate_mode || "prompts"
                : undefined,
            impersonateInput:
              genType === "impersonate" ? input.impersonate_input : undefined,
            inputMessages: input.messages,
            inputParameters: input.parameters,
            excludeMessageId,
            targetCharacterId: input.target_character_id,
            councilToolResults,
            councilNamedResults,
            precomputedVectorEntries,
            regenFeedback: input.regen_feedback,
            regenFeedbackPosition: input.regen_feedback_position,
            signal: abortController.signal,
          }),
          abortController.signal,
        );

        let { messages } = pipeline;
        const {
          parameters: mergedParams,
          breakdown,
          activatedWorldInfo,
          deliberationHandledByMacro,
        } = pipeline;

        // Persist deferred WI state and dirty chat variables after assembly.
        // Both go through mergeChatMetadata so that any user-driven metadata edits
        // (alternate field selections, world book attachments, etc.) that landed
        // during generation survive these background writes.
        {
          const partial: Record<string, any> = {
            ...(pipeline.deferredWiState?.partial ?? {}),
          };
          if (pipeline.macroEnv?._chatVarsDirty) {
            partial.chat_variables = Object.fromEntries(
              pipeline.macroEnv.variables.chat,
            );
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
          eventBus.emit(
            EventType.WORLD_INFO_ACTIVATED,
            {
              chatId: input.chat_id,
              entries: activatedWorldInfo,
              stats: pipeline.worldInfoStats,
            },
            input.userId,
          );
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
        lifecycle.messages = messages;
        lifecycle.model = connection.model;
        lifecycle.providerName = provider.name;
        lifecycle.maxContext = mergedParams.max_context_length as
          | number
          | undefined;
        lifecycle.councilNamedResults = councilNamedResults;
        lifecycle.contextClipStats = pipeline.contextClipStats;

        // Strip internal-only keys before they reach the provider
        delete mergedParams.max_context_length;

        // Inject connection-level metadata flags into parameters (e.g. use_responses_api)
        if (connection.metadata?.use_responses_api) {
          mergedParams.use_responses_api = true;
        }

        // Inject OpenRouter-specific settings from connection metadata
        if (
          connection.provider === "openrouter" &&
          connection.metadata?.openrouter
        ) {
          mergedParams._openrouter = connection.metadata.openrouter;
        }

        // Resolve preset name for breakdown display
        const presetId = input.preset_id || connection.preset_id;
        if (presetId) {
          const preset = presetsSvc.getPreset(input.userId, presetId);
          if (preset) lifecycle.presetName = preset.name;
        }

        // Final abort checkpoint between assembly completion and runGeneration
        // entry. If the user stopped while prompt assembly was winding down,
        // bail out here instead of emitting GENERATION_STARTED (with breakdown)
        // and then tearing the stream down on the first iter.next() race.
        checkAborted();

        // Run generation in the background
        runGeneration(
          generationId,
          provider,
          apiKey,
          apiUrl,
          connection.model,
          messages,
          mergedParams,
          input.userId,
          input.chat_id,
          lifecycle,
          abortController.signal,
          inlineTools,
          inlineToolDefsByName,
          inlineMembersByPrefix,
          councilSettings.toolsSettings.timeoutMs,
          pipeline.assistantPrefill,
          pipeline.macroEnv,
          pipeline.macroEnvSeed,
        );
      } catch (err: any) {
        // Clean up tracking maps if setup (council, assembly, etc.) fails or is aborted.
        // Only clear the per-chat mapping if it still points at THIS generation —
        // a newer startGeneration on the same chat may have already taken over the
        // chatKey (see line 590), and wiping it would strand the new generation.
        activeGenerations.delete(generationId);
        if (activeChatGenerations.get(chatKey) === generationId) {
          activeChatGenerations.delete(chatKey);
        }

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
            } catch {
              /* best-effort cleanup */
            }
          }
          pool.stopPool(generationId);
          eventBus.emit(
            EventType.GENERATION_STOPPED,
            {
              generationId,
              chatId: input.chat_id,
              content: "",
            },
            input.userId,
          );
          return;
        }

        const msg = errorMessage(err);
        pool.errorPool(generationId, msg);
        eventBus.emit(
          EventType.GENERATION_ENDED,
          {
            generationId,
            chatId: input.chat_id,
            error: msg,
            generationType: lifecycle.generationType,
          },
          input.userId,
        );
      }
    })();

    return { generationId, status: "streaming" };
  } catch (err: any) {
    // Early setup failure (before the async continuation) — connection
    // resolution, character lookup, swipe creation, etc.
    if (stagedMessageId) {
      try {
        chatsSvc.deleteMessage(input.userId, stagedMessageId);
      } catch {
        /* best-effort cleanup */
      }
    }
    activeGenerations.delete(generationId);
    activeChatGenerations.delete(chatKey);
    pool.errorPool(generationId, errorMessage(err));
    throw err;
  }
}

/**
 * Dry-run generation: assemble the full prompt (with macro resolution,
 * world info, post-processing, interceptors) but stop before the LLM call.
 * Council is skipped because it is expensive and hits the LLM.
 */
export async function dryRunGeneration(
  input: GenerateInput,
): Promise<DryRunResult> {
  const genType = input.generation_type || "normal";

  // Resolve persona_id from settings if not provided (same as startGeneration)
  if (!input.persona_id) {
    const activePersonaSetting = settingsSvc.getSetting(
      input.userId,
      "activePersonaId",
    );
    if (
      activePersonaSetting?.value &&
      typeof activePersonaSetting.value === "string"
    ) {
      input.persona_id = activePersonaSetting.value;
    }
  }

  const connection = resolveConnection(input.userId, input.connection_id);
  presetsSvc.assertUsablePreset(
    input.userId,
    input.preset_id,
    connection.preset_id,
  );
  const { provider } = await resolveProviderAndKey(input.userId, connection.id);

  const pipeline = await runPromptPipeline({
    userId: input.userId,
    chatId: input.chat_id,
    connectionId: input.connection_id,
    presetId: input.preset_id,
    personaId: input.persona_id,
    personaAddonStates: input.persona_addon_states,
    generationType: genType,
    impersonateMode:
      genType === "impersonate"
        ? input.impersonate_mode || "prompts"
        : undefined,
    impersonateInput:
      genType === "impersonate" ? input.impersonate_input : undefined,
    inputMessages: input.messages,
    inputParameters: input.parameters,
    excludeMessageId: input.exclude_message_id,
    targetCharacterId: input.target_character_id,
    signal: input.signal,
  });

  // Compute token counts for the breakdown
  let tokenCount: DryRunResult["tokenCount"];
  if (pipeline.breakdown && pipeline.breakdown.length > 0) {
    try {
      tokenCount = await tokenizerSvc.countBreakdown(
        connection.model,
        pipeline.breakdown,
        pipeline.chatHistoryMessages,
      );
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
  if (
    provider.capabilities.requiresMaxTokens &&
    outboundParams.max_tokens === undefined
  ) {
    outboundParams.max_tokens =
      provider.capabilities.parameters.max_tokens?.default ?? 4096;
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
    databankStats: pipeline.databankStats,
    contextClipStats: pipeline.contextClipStats,
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
  inlineToolDefsByName?: Map<string, RuntimeCouncilToolDefinition>,
  inlineMembersByPrefix?: Map<string, CouncilMember>,
  inlineToolTimeoutMs?: number,
  assistantPrefill?: string,
  macroEnv?: import("../macros/types").MacroEnv,
  macroEnvSeed?: import("../macros/types").MacroEnv,
): Promise<void> {
  // GENERATION_STARTED was already emitted when the pool entry was created
  // (before assembly). Once the provider stream is live, emit a lighter
  // progress event with the resolved breakdown metadata.
  pool.setPoolStatus(generationId, "streaming");

  type PendingStreamSegment = {
    token: string;
    type?: "reasoning";
    seq: number;
  };

  const streamTopic = `stream:${userId}:${chatId}`;
  const STREAM_EMIT_INTERVAL_MS = 40;
  const STREAM_EMIT_MAX_CHARS = 768;
  let pendingStreamSegments: PendingStreamSegment[] = [];
  let pendingStreamChars = 0;
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPendingStreamSegments(): void {
    if (streamFlushTimer) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    if (pendingStreamSegments.length === 0) return;

    const segments = pendingStreamSegments;
    pendingStreamSegments = [];
    pendingStreamChars = 0;

    for (const segment of segments) {
      eventBus.emit(
        EventType.STREAM_TOKEN_RECEIVED,
        {
          generationId,
          chatId,
          token: segment.token,
          ...(segment.type ? { type: segment.type } : {}),
          seq: segment.seq,
        },
        userId,
        { topic: streamTopic },
      );
    }
  }

  function schedulePendingStreamFlush(): void {
    if (streamFlushTimer) return;
    streamFlushTimer = setTimeout(() => {
      flushPendingStreamSegments();
    }, STREAM_EMIT_INTERVAL_MS);
  }

  function queueStreamSegment(token: string, seq: number, type?: "reasoning"): void {
    const previous = pendingStreamSegments[pendingStreamSegments.length - 1];
    if (previous && previous.type === type) {
      previous.token += token;
      previous.seq = seq;
    } else {
      pendingStreamSegments.push({ token, seq, ...(type ? { type } : {}) });
    }

    pendingStreamChars += token.length;
    if (pendingStreamChars >= STREAM_EMIT_MAX_CHARS) {
      flushPendingStreamSegments();
      return;
    }

    schedulePendingStreamFlush();
  }

  eventBus.emit(
    EventType.GENERATION_IN_PROGRESS,
    {
      generationId,
      chatId,
      model,
      breakdown: lifecycle.breakdown,
      targetMessageId: lifecycle.targetMessageId,
      characterId: lifecycle.targetCharacterId,
      characterName: lifecycle.characterName,
      contextClipStats: lifecycle.contextClipStats,
    },
    userId,
  );

  let fullContent = "";
  let fullReasoning = "";

  let streamUsage:
    | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    | undefined;
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
  const cotDelimiters = resolveReasoningDelimiters(reasoningSetting?.value);
  const cotParser = new GuidedReasoningStreamParser(
    cotDelimiters,
    cotAutoParse,
  );

  function emitContentToken(text: string) {
    if (!text) return;
    if (reasoningStartedAt && !reasoningDurationMs) {
      reasoningDurationMs = Date.now() - reasoningStartedAt;
    }
    fullContent += text;
    const seq = pool.appendPoolContent(generationId, text);
    queueStreamSegment(text, seq);
  }

  function emitReasoningToken(text: string) {
    if (!text) return;
    if (!reasoningStartedAt) reasoningStartedAt = Date.now();
    fullReasoning += text;
    const seq = pool.appendPoolReasoning(generationId, text);
    queueStreamSegment(text, seq, "reasoning");
  }

  function processContentToken(token: string) {
    const parsed = cotParser.push(token);
    if (parsed.reasoning) emitReasoningToken(parsed.reasoning);
    if (parsed.content) emitContentToken(parsed.content);
  }

  function flushCotBuffers() {
    const parsed = cotParser.flush();
    if (parsed.reasoning) emitReasoningToken(parsed.reasoning);
    if (parsed.content) emitContentToken(parsed.content);
  }

  // Persist whatever was streamed before termination. Shared between user-
  // initiated abort and mid-stream errors (e.g. socket close) so the UI never
  // loses content that the user already saw. Routes to the same targets the
  // success path uses (regen swipe, continue merge, staged slot, or new row).
  async function persistPartialContent(): Promise<{
    messageId?: string;
    content: string;
  }> {
    flushCotBuffers();
    let closedContent = closeUnterminatedReasoningTags(userId, fullContent);

    const responseScripts = regexScriptsSvc.getActiveScripts(userId, {
      characterId: lifecycle.targetCharacterId,
      chatId,
      target: "response",
    });
    if (responseScripts.length > 0) {
      closedContent = await regexScriptsSvc.applyRegexScripts(
        closedContent,
        responseScripts,
        "ai_output",
        0,
        macroEnv,
      );
      if (fullReasoning) {
        fullReasoning = await regexScriptsSvc.applyRegexScripts(
          fullReasoning,
          responseScripts,
          "reasoning",
          0,
          macroEnv,
        );
      }
    }

    let messageId: string | undefined;
    if (lifecycle.targetMessageId && lifecycle.targetSwipeIdx != null) {
      const updated = chatsSvc.updateSwipe(
        userId,
        lifecycle.targetMessageId,
        lifecycle.targetSwipeIdx,
        closedContent,
      );
      messageId = updated?.id ?? lifecycle.targetMessageId;
      if (fullReasoning) {
        const existingExtra =
          chatsSvc.getMessage(userId, lifecycle.targetMessageId)?.extra || {};
        chatsSvc.patchMessageExtra(userId, lifecycle.targetMessageId, {
          ...existingExtra,
          reasoning: fullReasoning,
        });
      }
    } else if (lifecycle.stagedMessageId) {
      const existingStagedExtra =
        chatsSvc.getMessage(userId, lifecycle.stagedMessageId)?.extra || {};
      const partialExtra = fullReasoning
        ? { ...existingStagedExtra, reasoning: fullReasoning }
        : existingStagedExtra;
      chatsSvc.updateMessage(userId, lifecycle.stagedMessageId, {
        content: closedContent,
        ...(Object.keys(partialExtra).length > 0
          ? { extra: partialExtra }
          : {}),
      });
      messageId = lifecycle.stagedMessageId;
    } else if (lifecycle.continueMessageId && closedContent) {
      const combined =
        (lifecycle.continueOriginalContent ?? "") +
        (lifecycle.continuePostfix ?? "") +
        closedContent;
      const existingContinueExtra = chatsSvc.getMessage(
        userId,
        lifecycle.continueMessageId,
      )?.extra;
      const continueExtra = fullReasoning
        ? { ...existingContinueExtra, reasoning: fullReasoning }
        : undefined;
      chatsSvc.updateMessage(userId, lifecycle.continueMessageId, {
        content: combined,
        ...(continueExtra ? { extra: continueExtra } : {}),
      });
      messageId = lifecycle.continueMessageId;
    } else if (lifecycle.impersonateDraft) {
      // Impersonate draft: do not persist the partial content as a message.
      // The streamed text is already in the frontend's input box.
    } else if (closedContent) {
      const isImpersonate = lifecycle.generationType === "impersonate";
      const extra: Record<string, any> = {};
      if (isImpersonate && lifecycle.personaId)
        extra.persona_id = lifecycle.personaId;
      if (!isImpersonate && lifecycle.targetCharacterId)
        extra.character_id = lifecycle.targetCharacterId;
      if (fullReasoning) extra.reasoning = fullReasoning;
      const created = chatsSvc.createMessage(
        chatId,
        {
          is_user: isImpersonate,
          name: isImpersonate
            ? lifecycle.personaName || "User"
            : lifecycle.characterName,
          content: closedContent,
          extra: Object.keys(extra).length > 0 ? extra : undefined,
        },
        userId,
      );
      messageId = created.id;
    }

    return { messageId, content: closedContent };
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

  let emittedStopped = false;
  try {
    const inlineMcpTimeoutMs = tools?.length
      ? inlineToolTimeoutMs ?? getCouncilSettings(userId).toolsSettings.timeoutMs
      : 30_000;
    let generationMessages = messages;

    for (let inlineRound = 0; inlineRound < 3; inlineRound++) {
      let pendingToolCalls: ToolCallResult[] | undefined;

      // Non-streaming path: call generate() once, then synthesize a single-chunk stream
      const stream: AsyncGenerator<StreamChunk, void, unknown> = useStreaming
        ? provider.generateStream(apiKey, apiUrl, {
            messages: generationMessages,
            model,
            parameters,
            stream: true,
            tools,
            signal,
          })
        : (async function* () {
            const result = await provider.generate(apiKey, apiUrl, {
              messages: generationMessages,
              model,
              parameters,
              stream: false,
              tools,
              signal,
            });
            yield {
              token: result.content,
              reasoning: result.reasoning,
              finish_reason: result.finish_reason,
              tool_calls: result.tool_calls,
              usage: result.usage,
            };
          })();

      // Drive the iterator manually so each `.next()` can be raced against the
      // abort signal. Providers intentionally don't pass the signal into
      // `fetch()` (a Bun-Windows stream-cancel workaround), which means a stop
      // clicked during the initial fetch wait — before any chunk arrives —
      // would otherwise stall until the upstream LLM responds. Racing at this
      // level unwinds immediately on abort; the in-flight fetch completes
      // silently in the background and the generator's own finally cancels
      // the reader.
      const iter = stream[Symbol.asyncIterator]();
      const maybeYieldDuringStream = createCooperativeYielder(32, signal);
      while (true) {
        let result: IteratorResult<StreamChunk, void>;
        try {
          result = await raceWithSignal(iter.next(), signal);
        } catch (err) {
          // Signal won the race. Tell the generator to clean up (best-effort)
          // and rethrow so the outer catch handles emission.
          try {
            await iter.return?.(undefined);
          } catch {
            /* best-effort */
          }
          throw err;
        }
        if (result.done) break;
        const chunk = result.value;

        if (signal.aborted) {
          const persisted = await persistPartialContent();
          flushPendingStreamSegments();
          pool.stopPool(generationId);
          eventBus.emit(
            EventType.GENERATION_STOPPED,
            { generationId, chatId, content: persisted.content },
            userId,
          );
          emittedStopped = true;
          try {
            await iter.return?.(undefined);
          } catch {
            /* best-effort */
          }
          break;
        }

        // Emit reasoning tokens (provider thinking/extended thinking)
        if (chunk.reasoning) {
          if (!reasoningStartedAt) reasoningStartedAt = Date.now();
          fullReasoning += chunk.reasoning;
          const seq = pool.appendPoolReasoning(generationId, chunk.reasoning);
          queueStreamSegment(chunk.reasoning, seq, "reasoning");
        }

        if (chunk.token) {
          processContentToken(chunk.token);
        }

        if (chunk.tool_calls) {
          pendingToolCalls = chunk.tool_calls;
        }

        // Capture provider usage data (token counts) from the stream
        if (chunk.usage) {
          streamUsage = chunk.usage;
        }

        await maybeYieldDuringStream();

        if (chunk.finish_reason) {
          break;
        }
      }

      if (signal.aborted) {
        break;
      }

      // Reconstruct the full assistant output including any guided CoT
      // reasoning block so the model sees its own <think>...</think> on
      // continuation rounds and doesn't re-enter the planning phase.
      const fullAssistantOutput = fullReasoning
        ? `${cotDelimiters.prefix}${fullReasoning}${cotDelimiters.suffix}\n${fullContent}`
        : fullContent;

      const inlineContextMessages = [
        ...generationMessages,
        ...(fullAssistantOutput
          ? [{ role: "assistant", content: fullAssistantOutput } satisfies LlmMessage]
          : []),
      ];

      const inlineCouncilResults =
        pendingToolCalls?.length && inlineToolDefsByName
          ? await executeInlineCouncilToolCalls(
              userId,
              pendingToolCalls,
              inlineMcpTimeoutMs,
              inlineToolDefsByName,
              inlineMembersByPrefix,
              inlineContextMessages,
            )
          : [];

      if (inlineCouncilResults.length === 0) {
        break;
      }

      generationMessages = [
        ...generationMessages,
        ...(fullAssistantOutput
          ? [{ role: "assistant", content: fullAssistantOutput } satisfies LlmMessage]
          : []),
        {
          role: "system",
          content: formatInlineCouncilToolResults(inlineCouncilResults),
        },
      ];
    }

    // Clean exit after abort — the stream may have returned done:true via
    // readWithAbort without ever re-entering the for-await body, so the
    // in-loop STOPPED emission above never fired. Emit now so the frontend
    // gets its completion signal and can unblock its streaming UI.
    if (signal.aborted && !emittedStopped) {
      const persisted = await persistPartialContent();
      pool.stopPool(generationId);
      eventBus.emit(
        EventType.GENERATION_STOPPED,
        { generationId, chatId, content: persisted.content },
        userId,
      );
      emittedStopped = true;
    }

    if (!signal.aborted) {
      // Flush any remaining CoT detection buffers before saving
      flushCotBuffers();

      // Post-parse: extract any reasoning tags that slipped through streaming
      // detection. Handles edge cases where prefix/suffix split across chunks
      // in ways the streaming state machine didn't catch, and ensures the
      // saved message content is always clean of reasoning tag markup.
      {
        if (cotAutoParse) {
          const extracted = extractDelimitedReasoning(
            fullContent,
            cotDelimiters,
          );
          if (extracted.reasoning) {
            fullContent = extracted.cleaned;
            fullReasoning =
              (fullReasoning ? fullReasoning + "\n" : "") + extracted.reasoning;
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
          fullContent = await regexScriptsSvc.applyRegexScripts(
            fullContent,
            responseScripts,
            "ai_output",
            0,
            macroEnv,
          );
          if (fullReasoning) {
            fullReasoning = await regexScriptsSvc.applyRegexScripts(
              fullReasoning,
              responseScripts,
              "reasoning",
              0,
              macroEnv,
            );
          }
        }
      }

      let messageId: string | undefined;

      if (lifecycle.targetMessageId && lifecycle.targetSwipeIdx != null) {
        // Regenerate: fill in the blank swipe that was created at generation start
        const updated = chatsSvc.updateSwipe(
          userId,
          lifecycle.targetMessageId,
          lifecycle.targetSwipeIdx,
          fullContent,
        );
        messageId = updated?.id ?? lifecycle.targetMessageId;
      } else if (lifecycle.continueMessageId) {
        // Continue: append generated text to existing assistant message,
        // inserting the continuePostfix separator (e.g. newline, double newline)
        const combined =
          (lifecycle.continueOriginalContent ?? "") +
          (lifecycle.continuePostfix ?? "") +
          fullContent;
        const existingExtra = chatsSvc.getMessage(
          userId,
          lifecycle.continueMessageId,
        )?.extra;
        const continueExtra = fullReasoning
          ? { ...existingExtra, reasoning: fullReasoning }
          : undefined;
        const updated = chatsSvc.updateMessage(
          userId,
          lifecycle.continueMessageId,
          {
            content: combined,
            ...(continueExtra ? { extra: continueExtra } : {}),
          },
        );
        messageId = updated?.id ?? lifecycle.continueMessageId;
      } else if (lifecycle.stagedMessageId) {
        // Staged (sidecar council): update the pre-created empty message
        // Merge with existing extra to preserve character_id etc. set during staging
        const existingStagedExtra =
          chatsSvc.getMessage(userId, lifecycle.stagedMessageId)?.extra || {};
        const stagedExtra = fullReasoning
          ? { ...existingStagedExtra, reasoning: fullReasoning }
          : Object.keys(existingStagedExtra).length > 0
            ? existingStagedExtra
            : undefined;
        chatsSvc.updateMessage(userId, lifecycle.stagedMessageId, {
          content: fullContent,
          ...(stagedExtra ? { extra: stagedExtra } : {}),
        });
        messageId = lifecycle.stagedMessageId;
      } else if (lifecycle.impersonateDraft) {
        // Impersonate draft: tokens were streamed to the frontend but we do NOT
        // create a message. The user will edit the text in the input box and
        // send it manually. messageId stays undefined.
      } else {
        // Normal / swipe: create assistant message, impersonate: create user message
        const isImpersonate = lifecycle.generationType === "impersonate";
        const extra: Record<string, any> = {};
        if (isImpersonate && lifecycle.personaId)
          extra.persona_id = lifecycle.personaId;
        if (!isImpersonate && lifecycle.targetCharacterId)
          extra.character_id = lifecycle.targetCharacterId;
        if (fullReasoning) extra.reasoning = fullReasoning;

        const message = chatsSvc.createMessage(
          chatId,
          {
            is_user: isImpersonate,
            name: isImpersonate
              ? lifecycle.personaName || "User"
              : lifecycle.characterName,
            content: fullContent,
            extra: Object.keys(extra).length > 0 ? extra : undefined,
          },
          userId,
        );
        messageId = message.id;
      }

      if ((lifecycle.sourceUserMessageIds?.length ?? 0) > 0) {
        await reconcileChatMessageMacros({
          userId,
          chatId,
          messageIds: lifecycle.sourceUserMessageIds ?? [],
          macroEnvSeed,
          persistVariables: false,
        });
      }

      if (messageId) {
        const savedMessage = chatsSvc.getMessage(userId, messageId);
        let resolvedMessage = savedMessage?.content ?? fullContent;
        if (macroEnv || macroEnvSeed) {
          const assistantEnv = cloneEnv(macroEnv ?? macroEnvSeed!);
          resolvedMessage = await resolveRenderedMessageContent(
            savedMessage?.content ?? fullContent,
            assistantEnv,
          );
          persistMacroVariableState(userId, chatId, assistantEnv);
        }
        if (savedMessage && savedMessage.content !== resolvedMessage) {
          chatsSvc.updateMessage(userId, messageId, { content: resolvedMessage });
        }
        fullContent = resolvedMessage;
      }

      // Compute reasoning duration if content tokens never arrived (reasoning-only response)
      if (reasoningStartedAt && !reasoningDurationMs) {
        reasoningDurationMs = Date.now() - reasoningStartedAt;
      }

      // Persist lightweight metadata needed for immediate message reconciliation
      // before we emit GENERATION_ENDED. Expensive bookkeeping (token counts,
      // breakdown tokenization) is deferred so the frontend can clear its stop
      // button as soon as the message itself is safely stored.
      {
        const immediateExtra: Record<string, any> = {};
        if (fullReasoning) immediateExtra.reasoning = fullReasoning;
        if (streamUsage) immediateExtra.usage = streamUsage;
        if (reasoningDurationMs > 0)
          immediateExtra.reasoningDuration = reasoningDurationMs;
        if (messageId && Object.keys(immediateExtra).length > 0) {
          const existing = chatsSvc.getMessage(userId, messageId)?.extra || {};
          chatsSvc.patchMessageExtra(userId, messageId, {
            ...existing,
            ...immediateExtra,
          });
        }
      }

      flushPendingStreamSegments();
      pool.completePool(generationId, messageId);
      eventBus.emit(
        EventType.GENERATION_ENDED,
        {
          generationId,
          chatId,
          messageId,
          content: fullContent,
          usage: streamUsage,
          generationType: lifecycle.generationType,
          impersonateDraft: lifecycle.impersonateDraft || undefined,
        },
        userId,
      );

      // Non-critical post-processing can be expensive on low-power/mobile
      // hosts (tokenizer startup, full breakdown counting). Run it after the
      // terminal WS event so the UI doesn't sit in a fake "still generating"
      // state after the final token already rendered.
      void (async () => {
        await yieldToEventLoop();

        // ── Generation metrics (tokenCount, TTFT, TPS) ───────────────────
        const finalPoolEntry = pool.getPoolEntry(generationId);
        let resolvedTokenCount: number | undefined;
        const fullOutput = fullReasoning
          ? fullReasoning + fullContent
          : fullContent;
        if (fullOutput.length > 0) {
          try {
            resolvedTokenCount =
              (await tokenizerSvc.countForModel(model, fullOutput)) ??
              undefined;
          } catch {
            resolvedTokenCount = undefined;
          }
        }

        let generationMetrics:
          | {
              ttft?: number;
              tps?: number;
              durationMs: number;
              wasStreaming: boolean;
              model?: string;
              provider?: string;
            }
          | undefined;
        if (finalPoolEntry) {
          const wasStreaming = finalPoolEntry.wasStreaming ?? true;
          const streamStart = finalPoolEntry.streamingStartedAt;
          const now = Date.now();
          const durationMs = streamStart ? now - streamStart : 0;
          let ttft: number | undefined;
          let tps: number | undefined;

          if (wasStreaming && streamStart) {
            if (finalPoolEntry.firstTokenAt) {
              ttft = finalPoolEntry.firstTokenAt - streamStart;
            }
            if (
              finalPoolEntry.firstTokenAt &&
              resolvedTokenCount &&
              resolvedTokenCount > 1
            ) {
              const streamDurationSec =
                (now - finalPoolEntry.firstTokenAt) / 1000;
              if (streamDurationSec > 0) {
                tps =
                  Math.round((resolvedTokenCount / streamDurationSec) * 10) /
                  10;
              }
            }
          }

          generationMetrics = {
            durationMs,
            wasStreaming,
            ...(ttft != null ? { ttft } : {}),
            ...(tps != null ? { tps } : {}),
            ...(lifecycle.model ? { model: lifecycle.model } : {}),
            ...(lifecycle.providerName
              ? { provider: lifecycle.providerName }
              : {}),
          };
        }

        if (messageId && (resolvedTokenCount || generationMetrics)) {
          const existing = chatsSvc.getMessage(userId, messageId)?.extra || {};
          const metricsExtra: Record<string, any> = { ...existing };
          if (resolvedTokenCount) metricsExtra.tokenCount = resolvedTokenCount;
          if (generationMetrics)
            metricsExtra.generationMetrics = generationMetrics;
          chatsSvc.patchMessageExtra(userId, messageId, metricsExtra);
        }

        if (
          lifecycle.breakdown &&
          lifecycle.breakdown.length > 0 &&
          lifecycle.model
        ) {
          try {
            const tokenResult = await tokenizerSvc.countBreakdown(
              lifecycle.model,
              lifecycle.breakdown,
              lifecycle.chatHistoryMessages,
            );
            const breakdownPayload = {
              entries: tokenResult.breakdown.map((entry, index) => ({
                ...entry,
                content: lifecycle.breakdown?.[index]?.content,
              })),
              messages: (lifecycle.messages || []).map((message) => ({
                role: message.role,
                content:
                  typeof message.content === "string"
                    ? message.content
                    : message.content
                        .map((part) => (part.type === "text" ? part.text : ""))
                        .join(""),
              })),
              totalTokens: tokenResult.total_tokens,
              maxContext: lifecycle.maxContext || 0,
              model: lifecycle.model,
              provider: lifecycle.providerName || "",
              presetName: lifecycle.presetName,
              tokenizer_name: tokenResult.tokenizer_name,
            };
            if (messageId) {
              breakdownSvc.storeBreakdown(
                userId,
                messageId,
                chatId,
                breakdownPayload,
              );
            }
          } catch {
            // non-fatal
          }
        }
      })().catch((err) => {
        console.warn("[generate] Deferred post-processing failed:", err);
      });

      // Fire-and-forget expression detection after successful generation
      fireExpressionDetection(userId, chatId, lifecycle).catch(() => {});
    }
  } catch (err: unknown) {
    // If the stream iterator threw because the abort signal fired (rather than
    // the in-loop `signal.aborted` branch catching it first), treat this as a
    // user-initiated stop, not an error. On Bun for Windows the thrown value
    // may be `null` in this case, which is why errorMessage() is used.
    if (signal.aborted) {
      // Skip if the post-loop / in-loop branch already emitted — catches
      // the case where a later .next() race threw AFTER the loop body's
      // STOPPED emission had already fired.
      if (!emittedStopped) {
        // Persist whatever was already streamed — same recovery as the
        // non-abort error path. Without this, cancelling mid-stream wiped the
        // message even though the tokens had already rendered for the user.
        // Yield a macrotask first so the provider's stream teardown finishes
        // before we kick off SQLite writes; on Bun-Windows, interleaving DB
        // work with ReadableStream teardown was a reproducible panic trigger.
        await new Promise((resolve) => setTimeout(resolve, 0));
        let savedContent = fullContent;
        try {
          const persisted = await persistPartialContent();
          savedContent = persisted.content;
        } catch {
          /* best-effort; fall back to in-memory content */
        }
        flushPendingStreamSegments();
        pool.stopPool(generationId);
        eventBus.emit(
          EventType.GENERATION_STOPPED,
          {
            generationId,
            chatId,
            content: savedContent,
          },
          userId,
        );
        emittedStopped = true;
      }
    } else {
      const msg = errorMessage(err);
      // Socket drops, provider 5xx mid-stream, etc. — persist whatever was
      // already streamed so the user keeps the visible content rather than
      // having the streaming bubble wiped on error.
      let savedMessageId: string | undefined;
      let savedContent = fullContent;
      try {
        const persisted = await persistPartialContent();
        savedMessageId = persisted.messageId;
        savedContent = persisted.content;
      } catch {
        /* best-effort; never let save failure shadow the original error */
      }
      flushPendingStreamSegments();
      pool.errorPool(generationId, msg);
      eventBus.emit(
        EventType.GENERATION_ENDED,
        {
          generationId,
          chatId,
          messageId: savedMessageId,
          content: savedContent,
          error: msg,
          generationType: lifecycle.generationType,
        },
        userId,
      );
    }
  } finally {
    flushPendingStreamSegments();
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
  lifecycle: GenerationLifecycle,
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
      .map((m) => ({
        role: m.is_user ? ("user" as const) : ("assistant" as const),
        content: m.content,
      }));

    const result = await detectMultiCharacterExpression(
      {
        userId,
        chatId,
        characterId,
        groups: expressionGroups,
        recentMessages,
      },
      rawGenerate,
    );

    if (result) {
      emitExpressionChanged(
        userId,
        chatId,
        chat,
        characterId,
        result.expression,
        result.imageId,
        result.characterGroup,
      );
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
    const councilLabel = lifecycle.councilNamedResults["expression_data"]
      .trim()
      .toLowerCase();
    const matched = labels.find((l) => l.toLowerCase() === councilLabel);
    if (matched) {
      emitExpressionChanged(
        userId,
        chatId,
        chat,
        characterId,
        matched,
        expressionConfig.mappings[matched],
      );
      return;
    }
  }

  // Standalone auto-detect mode
  const detectionSettings = getExpressionDetectionSettings(userId);
  if (detectionSettings.mode === "off" || detectionSettings.mode === "council")
    return;

  const allMessages = chatsSvc.getMessages(userId, chatId);
  const recentMessages: LlmMessage[] = allMessages
    .slice(-detectionSettings.contextWindow)
    .map((m) => ({
      role: m.is_user ? ("user" as const) : ("assistant" as const),
      content: m.content,
    }));

  const detectedLabel = await detectExpression(
    {
      userId,
      chatId,
      characterId,
      labels,
      recentMessages,
    },
    rawGenerate,
  );

  if (detectedLabel && expressionConfig.mappings[detectedLabel]) {
    emitExpressionChanged(
      userId,
      chatId,
      chat,
      characterId,
      detectedLabel,
      expressionConfig.mappings[detectedLabel],
    );
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
    partial.group_expressions = {
      ...existingGroup,
      [characterId]: { label, imageId },
    };
  }

  chatsSvc.mergeChatMetadata(userId, chatId, partial);
  // Emit to frontend
  eventBus.emit(
    EventType.EXPRESSION_CHANGED,
    {
      chatId,
      characterId,
      label,
      imageId,
      expressionGroup,
    },
    userId,
  );
}

export function stopGeneration(generationId: string): boolean {
  const entry = activeGenerations.get(generationId);
  if (!entry) return false;
  entry.controller.abort();
  // Tear down any fire-and-forget background work for this chat too —
  // the user asked to stop, so cache-warming cortex/databank queries
  // should die with the visible generation.
  abortChatBackground(entry.userId, entry.chatId);
  return true;
}

export function stopUserGenerations(userId: string): void {
  for (const [id, entry] of activeGenerations) {
    if (entry.userId === userId) {
      entry.controller.abort();
    }
  }
  abortUserBackgrounds(userId);
}

export function stopChatGenerations(userId: string, chatId: string): void {
  const chatKey = `${userId}:${chatId}`;
  const genId = activeChatGenerations.get(chatKey);
  if (genId) {
    const entry = activeGenerations.get(genId);
    if (entry) entry.controller.abort();
  }
  abortChatBackground(userId, chatId);
}

export function stopAllGenerations(): void {
  for (const [id, entry] of activeGenerations) {
    entry.controller.abort();
  }
  activeGenerations.clear();
  activeChatGenerations.clear();
  abortAllBackgrounds();
}

/** Returns the active generationId for a chat, if any. */
export function getActiveChatGeneration(
  userId: string,
  chatId: string,
): string | undefined {
  return activeChatGenerations.get(`${userId}:${chatId}`);
}

export function getActiveGenerationCount(): number {
  return activeGenerations.size;
}

// Periodically abort generations that have been running too long (provider hung, broken stream)
const GENERATION_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
let _generationSweepTimer: ReturnType<typeof setInterval> | null = setInterval(
  () => {
    const now = Date.now();
    for (const [id, entry] of activeGenerations) {
      if (now - entry.startedAt > GENERATION_MAX_AGE_MS) {
        console.warn(
          `[generate] Aborting stale generation ${id} (age: ${Math.round((now - entry.startedAt) / 1000)}s)`,
        );
        entry.controller.abort();
      }
    }
  },
  60_000,
);

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
  userId?: string,
): Promise<GenerationResponse> {
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let toolCalls: import("../llm/types").ToolCallResult[] | undefined;
  let usage: GenerationResponse["usage"];

  const source = userId
    ? wrapDelimitedReasoningForUser(userId, stream)
    : stream;
  for await (const chunk of source) {
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

interface PreparedGenerationCall {
  provider: LlmProvider;
  apiKey: string;
  apiUrl: string;
  request: GenerationRequest;
}

async function prepareRawCall(
  userId: string,
  input: RawGenerateInput & { signal?: AbortSignal },
): Promise<PreparedGenerationCall> {
  const { provider, apiKey, apiUrl } = await resolveRawProviderAndKey(
    userId,
    input,
  );
  const parameters: GenerationParameters = { ...(input.parameters || {}) };
  const reasoningConnection = input.connection_id
    ? connectionsSvc.getConnection(userId, input.connection_id)
    : null;
  applyEffectiveReasoningSettings(
    userId,
    reasoningConnection || {},
    provider.name,
    input.model,
    parameters,
  );
  const request: GenerationRequest = {
    messages: input.messages,
    model: input.model,
    parameters,
    tools: input.tools,
    signal: input.signal,
  };
  return { provider, apiKey, apiUrl, request };
}

async function prepareQuietCall(
  userId: string,
  input: QuietGenerateInput,
): Promise<PreparedGenerationCall> {
  const connection = resolveConnection(userId, input.connection_id);
  const { provider, apiKey, apiUrl } = await resolveProviderAndKey(
    userId,
    connection.id,
  );

  // Merge preset parameters with request overrides
  let mergedParams: GenerationParameters = input.parameters || {};
  if (connection.preset_id) {
    const preset = presetsSvc.getPreset(userId, connection.preset_id);
    if (preset) {
      mergedParams = { ...preset.parameters, ...mergedParams };
    }
  }

  applyEffectiveReasoningSettings(
    userId,
    connection,
    provider.name,
    connection.model || undefined,
    mergedParams,
  );

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
  const paramModel =
    typeof (mergedParams as any).model === "string"
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

  return { provider, apiKey, apiUrl, request };
}

export async function rawGenerate(
  userId: string,
  input: RawGenerateInput & { signal?: AbortSignal },
): Promise<GenerationResponse> {
  const { provider, apiKey, apiUrl, request } = await prepareRawCall(
    userId,
    input,
  );

  // Use streaming when tools are present — some providers only emit tool call
  // deltas correctly via the streaming path. Consume the stream internally to
  // produce a complete response.
  if (input.tools && input.tools.length > 0) {
    return consumeStream(
      provider.generateStream(apiKey, apiUrl, { ...request, stream: true }),
      userId,
    );
  }

  return applyDelimitedReasoningParsing(
    userId,
    await provider.generate(apiKey, apiUrl, { ...request, stream: false }),
  );
}

export async function quietGenerate(
  userId: string,
  input: QuietGenerateInput,
): Promise<GenerationResponse> {
  const { provider, apiKey, apiUrl, request } = await prepareQuietCall(
    userId,
    input,
  );

  // Use streaming when tools are present — some providers only emit tool call
  // deltas correctly via the streaming path.
  if (request.tools && request.tools.length > 0) {
    return consumeStream(
      provider.generateStream(apiKey, apiUrl, { ...request, stream: true }),
      userId,
    );
  }

  return applyDelimitedReasoningParsing(
    userId,
    await provider.generate(apiKey, apiUrl, { ...request, stream: false }),
  );
}

/**
 * Streaming variant of {@link rawGenerate}. Returns the raw provider stream
 * iterator with the caller's `AbortSignal` already wired in. Used by
 * Spindle's `request_generation_stream` RPC to pipe chunks back to the
 * extension worker.
 */
export async function rawGenerateStream(
  userId: string,
  input: RawGenerateInput & { signal?: AbortSignal },
): Promise<AsyncGenerator<StreamChunk, void, unknown>> {
  const { provider, apiKey, apiUrl, request } = await prepareRawCall(
    userId,
    input,
  );
  return wrapDelimitedReasoningForUser(
    userId,
    provider.generateStream(apiKey, apiUrl, { ...request, stream: true }),
  );
}

/**
 * Streaming variant of {@link quietGenerate}. Same parameter resolution as
 * `quietGenerate` (preset merge, reasoning injection, connection metadata)
 * but returns the underlying provider stream iterator instead of an
 * aggregated response.
 */
export async function quietGenerateStream(
  userId: string,
  input: QuietGenerateInput,
): Promise<AsyncGenerator<StreamChunk, void, unknown>> {
  const { provider, apiKey, apiUrl, request } = await prepareQuietCall(
    userId,
    input,
  );
  return wrapDelimitedReasoningForUser(
    userId,
    provider.generateStream(apiKey, apiUrl, { ...request, stream: true }),
  );
}

/**
 * Summarize generation — used by the Loom Summary feature.
 * Resolves connection via: explicit connection_id → sidecar settings → default.
 * When using sidecar, applies sidecar model/temperature/maxTokens overrides.
 */
export async function summarizeGenerate(
  userId: string,
  input: QuietGenerateInput,
): Promise<GenerationResponse> {
  const chatId = input.chat_id;
  // One generationId per summary invocation — tracked in summarize-pool so the
  // WS completion/failure events can be correlated by the frontend even when
  // multiple tabs kick off summaries for the same chat.
  const generationId = crypto.randomUUID();

  if (chatId) {
    summarizePool.startSummarizePool({ generationId, userId, chatId });
  }

  try {
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
    const { provider, apiKey, apiUrl } = await resolveProviderAndKey(
      userId,
      connection.id,
    );

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
    if (
      connection.provider === "openrouter" &&
      connection.metadata?.openrouter
    ) {
      mergedParams._openrouter = connection.metadata.openrouter;
    }

    applyEffectiveReasoningSettings(
      userId,
      connection,
      provider.name,
      sidecarModel || connection.model || undefined,
      mergedParams,
    );

    const request: GenerationRequest = {
      messages: input.messages,
      model: sidecarModel || connection.model,
      parameters: mergedParams,
      tools: input.tools,
    };

    // Use streaming when tools are present — some providers only emit tool call
    // deltas correctly via the streaming path.
    const result =
      input.tools && input.tools.length > 0
        ? await consumeStream(
            provider.generateStream(apiKey, apiUrl, {
              ...request,
              stream: true,
            }),
            userId,
          )
        : applyDelimitedReasoningParsing(
            userId,
            await provider.generate(apiKey, apiUrl, {
              ...request,
              stream: false,
            }),
          );

    if (chatId) {
      summarizePool.completeSummarizePool({ generationId, userId, chatId });
    }
    return result;
  } catch (err: any) {
    if (chatId) {
      summarizePool.failSummarizePool({
        generationId,
        userId,
        chatId,
        error: err?.message || "Summary generation failed",
      });
    }
    throw err;
  }
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
          content:
            getTextContent(messages[i - 1]) +
            "\n\n" +
            getTextContent(messages[i]),
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

export async function batchGenerate(
  userId: string,
  input: BatchGenerateInput,
): Promise<BatchResultItem[]> {
  const processOne = async (
    req: RawGenerateInput,
    index: number,
  ): Promise<BatchResultItem> => {
    try {
      const result = await rawGenerate(userId, {
        ...req,
        signal: input.signal,
      });
      return {
        index,
        success: true,
        content: result.content,
        finish_reason: result.finish_reason,
        usage: result.usage,
      };
    } catch (err: unknown) {
      return { index, success: false, error: errorMessage(err) };
    }
  };

  if (input.concurrent) {
    return Promise.all(input.requests.map((req, i) => processOne(req, i)));
  }

  const results: BatchResultItem[] = [];
  for (let i = 0; i < input.requests.length; i++) {
    if (input.signal?.aborted) {
      results.push({
        index: i,
        success: false,
        error: "AbortError: Generation aborted",
      });
      continue;
    }
    results.push(await processOne(input.requests[i], i));
  }
  return results;
}

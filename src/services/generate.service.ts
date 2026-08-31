import {
  acknowledgeAgenticGenerationDispatch,
  abortAcceptedAgenticGeneration,
  startAgenticGeneration,
  requestAgenticGenerationCancellation,
  requestAgenticChatCancellation,
  waitForAgenticGeneration,
  waitForAgenticGenerationAdmission,
  getActiveAgenticGenerationForChat,
  getActiveAgenticGenerationContext,
  stopAgenticUserGenerations,
  stopAllAgenticGenerations,
  getActiveAgenticGenerationCount,
  AgenticGenerationError,
  type AgenticGenerationDependencies,
  type AgenticGenerationInput,
  type AgenticDispatchAcknowledgementState,
  type AgenticTargetSnapshot,
} from "./agentic-generation.service";
import { getTurnExecution, requestTurnCancellation } from "./turn-execution.service";
import { requestAgentRunStop } from "./agent-run-projection.service";
import type { AgentRunStopResponseV2 } from "../types/agent-run-projection";
import { getProvider } from "../llm/registry";
import {
  AgentToolCapabilityError,
  assertAgentToolCapability,
  type LlmProvider,
} from "../llm/provider";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as secretsSvc from "./secrets.service";
import * as connectionsSvc from "./connections.service";
import * as chatsSvc from "./chats.service";
import * as presetsSvc from "./presets.service";
import * as presetProfilesSvc from "./preset-profiles.service";
import * as settingsSvc from "./settings.service";
import {
  assemblePrompt,
  applyCustomBodyParameters,
  applyProviderReasoningOffSwitch,
  injectReasoningParams,
  collectVectorActivatedWorldInfo,
  mergeActivatedWorldInfoEntries,
  buildWorldInfoVectorSourceFingerprint,
  getSourceMessageId,
  isChatHistoryMessage,
  resolveContinuePostfix,
  shouldPreserveDisplayReasoningDelimiters,
  type VectorActivatedEntry,
  type PrecomputedWorldInfoVectorEntries,
  clipToContextBudget,
  resolvePromptBlockPlacements,
  reorderBlocksByPosition,
} from "./prompt-assembly.service";
import { resolveEffectiveRuntime } from "./agent-runtime-decision.service";
import type { EffectiveRuntimeRequestV1 } from "../types/agent-runtime-decision";
import { getPresetAgentConfig } from "./agent-config-portability.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import { getEffectiveCharacterName } from "../types/character";
import { isNoPresetChatMetadata, isTemporaryChatMetadata } from "../types/chat";
import {
  describeContentForDisplay,
  getTextContent,
  type DisplayContentPartSummary,
  type LlmMessage,
  type GenerationParameters,
  type GenerationRequest,
  type GenerationResponse,
  type ProviderTransientCarrier,
  type ResponsesFunctionCallOutput,
  type ResponsesInputMessageItem,
  type ResponsesOutputItem,
  type StreamChunk,
  type GenerationType,
  type ImpersonateMode,
  type AssemblySurfaceV1,
  type AssemblyBreakdownEntry,
  type ActivatedWorldInfoEntry,
  type ToolDefinition,
  type ToolCallResult,
  type LlmThinkingBlock,
  type ContextClipStats,
} from "../llm/types";
import type { LoomPromptInspectionV1 } from "../types/agent-cognition";
import { trimIncompleteTrailingWord } from "../utils/trim-incomplete-word";
import { promptBlockMatchesCharacterTags } from "../utils/prompt-block-character-tags";
import { healFormattingArtifacts } from "../utils/format-healing";
import {
  buildInlineToolContinuation,
  validateInlineToolCallIds,
  type InlineCouncilToolResult,
} from "./inline-tool-continuation";
import {
  applyInlineWebSearchContextSlots,
  formatInlineWebSearchContext,
  INLINE_WEB_SEARCH_MAX_QUERY_CHARS,
  INLINE_WEB_SEARCH_MAX_RESULTS,
  INLINE_WEB_SEARCH_TOOL,
  INLINE_WEB_SEARCH_TOOL_NAME,
  prepareInlineWebSearchMessagesForProvider,
} from "./inline-web-search";
import { getWebSearchSettings } from "./web-search-settings.service";
import type { Message } from "../types/message";
import type { ConnectionProfile } from "../types/connection-profile";
import type { ResolvedConcreteConnectionV1 } from "./connections.service";
import type { Preset, PromptBlock } from "../types/preset";
import type { CustomBody } from "../types/preset";
import type { PresetProfileBinding } from "../types/preset-profile";
import {
  interceptorPipeline,
  type InterceptorBreakdownEntry,
} from "../spindle/interceptor-pipeline";
import { contextHandlerChain } from "../spindle/context-handler";
import {
  executeCouncil,
  appendCouncilDeliberationHistory,
  collectWorldInfoForCouncil,
  formatDeliberation,
  selectCouncilContextMessages,
  type CouncilEnrichment,
  type CouncilExecutionResultWithHistory,
} from "./council/council-execution.service";
import {
  activateWorldInfo,
  type WorldInfoSettings,
} from "./world-info-activation.service";
import type {
  CachedCouncilResult,
  CouncilMember,
  CouncilMemberContext,
  GenerationReasoningOverrideDTO,
  LlmMessageDTO,
} from "lumiverse-spindle-types";
import {
  getCouncilSettings,
  getAvailableTools,
} from "./council/council-settings.service";
import * as councilProfilesSvc from "./council/council-profiles.service";
import * as tokenizerSvc from "./tokenizer.service";
import type { ResolvedTokenCounter } from "./tokenizer.service";
import * as breakdownSvc from "./breakdown.service";
import * as regexScriptsSvc from "./regex-scripts.service";
import * as pool from "./generation-pool.service";
import * as summarizePool from "./summarize-pool.service";
import {
  getSummarizationPromptDefaults,
  buildSummarizationPrompt,
} from "./summarization-prompts.service";
import {
  detectExpression,
  detectMultiCharacterExpression,
  getExpressionDetectionSettings,
  resolveDetectedExpressionLabel,
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
  ProviderProtocolError,
  ProviderResponseTooLargeError,
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
import { applyPromptCaching } from "./caching";
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
  isSafeResponseAssemblyFallbackError,
} from "./prompt-assembly-worker-client";
import { isPromptRegexChatOwned } from "../spindle/prompt-regex-ownership";
import { isRunning as isExtensionRunning } from "../spindle/lifecycle";
import { clampErrorMessage, ConnectionCredentialError, describeProviderError, ProviderRequestError } from "../utils/provider-errors";
import {
  AgentRuntimeFailure,
  asPublicRuntimeCode,
  type AgentProviderDispatchRequest,
  type AgentProviderDispatchResponse,
  AgentRuntimeOwner,
} from "./agent-runtime.service";
import { AgentAccountingFailure, observeOutputTokens, utf8ByteLength } from "./agent-runtime-accounting";
import { AgentLedgerFailure } from "./agent-runtime-ledger";
import type { ToolBatchReservation } from "./agent-runtime-frame";
import type { AgentAdmissionPermit } from "./agent-runtime-admission";
import {
  AgentAssemblyRequiresMainProcessError,
  AgentMultiplayerUnsupportedError,
  preflightAgentIntrinsics,
  type AgentIntrinsicBlockInput,
} from "./agent-intrinsics.service";
import { CORE_AGENT_TOOL_CATALOG } from "./agent-tools.service";
import {
  AgentSealError,
  redactAgentOutputFrames,
  withAgentSealStage,
  type AgentSealRegistry,
  type AgentSealStage,
} from "./agent-seals.service";
import type { AgentUsage } from "../types/agents";
import { persistTerminalAgentActivityRun } from "./agent-activity-runs.service";
import type {
  AgentActivityLifecycle,
  AgentActivitySnapshotV1,
  AgentLedgerReservation,
  AgentPublicErrorCategory,
  AgentPublicErrorCode,
  AgentPublicErrorV1,
  AgentTerminalReason,
} from "../types/agent-runtime";

const RECOGNIZED_AGENT_TOOL_NAMES = new Set<string>([
  ...Object.keys(CORE_AGENT_TOOL_CATALOG),
  "agent_delegate",
]);

const PROVIDER_TRANSIENT_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
/**
 * The carrier is an insertion-ordered transcript. Callers append every
 * post-response item (results and host guidance) in the order it occurred;
 * never regroup items by provider kind.
 */

type ResponsesCarrierItem =
  | ResponsesOutputItem
  | ResponsesFunctionCallOutput
  | ResponsesInputMessageItem;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResponsesOutputItem(value: unknown): value is ResponsesOutputItem {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "message":
      return (
        value.role === "assistant" &&
        typeof value.id === "string" &&
        Array.isArray(value.content)
      );
    case "reasoning":
      return typeof value.id === "string" && Array.isArray(value.summary);
    case "function_call":
      return (
        typeof value.id === "string" &&
        typeof value.call_id === "string" &&
        typeof value.name === "string" &&
        typeof value.arguments === "string"
      );
    default:
      return false;
  }
}

function isResponsesInputMessageItem(
  value: unknown,
): value is ResponsesInputMessageItem {
  return (
    isRecord(value) &&
    value.type === "message" &&
    (value.role === "user" || value.role === "assistant" || value.role === "system") &&
    typeof value.content === "string" &&
    !Object.hasOwn(value, "id")
  );
}

function isResponsesFunctionCallOutput(
  value: unknown,
): value is ResponsesFunctionCallOutput {
  return (
    isRecord(value) &&
    value.type === "function_call_output" &&
    typeof value.call_id === "string" &&
    typeof value.output === "string"
  );
}

function isResponsesCarrierItem(value: unknown): value is ResponsesCarrierItem {
  return (
    isResponsesOutputItem(value) ||
    isResponsesInputMessageItem(value) ||
    isResponsesFunctionCallOutput(value)
  );
}

function isResponsesCarrier(value: unknown): value is ProviderTransientCarrier {
  return (
    isRecord(value) &&
    value.kind === "openai_responses" &&
    Array.isArray(value.items) &&
    value.items.every(isResponsesCarrierItem)
  );
}

function assertResponsesCarrier(
  value: unknown,
): asserts value is ProviderTransientCarrier {
  if (!isResponsesCarrier(value)) {
    throw new ProviderProtocolError(
      "OpenAI Responses continuation carrier is malformed",
    );
  }
}

function assertResponsesProviderCarrier(
  value: unknown,
): asserts value is ProviderTransientCarrier {
  if (
    !isRecord(value) ||
    value.kind !== "openai_responses" ||
    !Array.isArray(value.items) ||
    !value.items.every(isResponsesOutputItem)
  ) {
    throw new ProviderProtocolError(
      "OpenAI Responses provider output carrier is malformed",
    );
  }
}

function mergeProviderTransientCarrier(
  previous: ProviderTransientCarrier | undefined,
  current: ProviderTransientCarrier,
  appendedItems: readonly ResponsesCarrierItem[],
): ProviderTransientCarrier {
  if (previous !== undefined) assertResponsesCarrier(previous);
  assertResponsesProviderCarrier(current);
  if (!appendedItems.every(isResponsesCarrierItem)) {
    throw new ProviderProtocolError(
      "OpenAI Responses continuation item is malformed",
    );
  }
  const merged: ProviderTransientCarrier = Object.freeze({
    kind: "openai_responses",
    items: Object.freeze([
      ...(previous?.items ?? []),
      ...current.items,
      ...appendedItems,
    ]),
  });
  const bytes = Buffer.byteLength(JSON.stringify(merged), "utf8");
  if (bytes > PROVIDER_TRANSIENT_HISTORY_MAX_BYTES) {
    throw new AgentRuntimeFailure("continuation_limit_exceeded");
  }
  return merged;
}
function isUsageOnlyStreamChunk(chunk: StreamChunk): boolean {
  return chunk.usage !== undefined
    && !chunk.finish_reason
    && !chunk.token
    && !chunk.reasoning
    && !(chunk.tool_calls && chunk.tool_calls.length > 0)
    && !chunk.providerTransientCarrier
    && !(chunk.thinking_blocks && chunk.thinking_blocks.length > 0)
    && !(chunk.reasoning_details && chunk.reasoning_details.length > 0);
}
function resolveInlineToolContinuationPolicy(
  hasTools: boolean,
  agentToolsExposed: boolean,
  capabilities: Pick<
    LlmProvider["capabilities"],
    "nativeToolContinuation" | "toolContinuationMode" | "interleavedThinking"
  >,
): {
  structured: boolean;
  legacyResultRole: "system" | "user";
} {
  return {
    structured: hasTools &&
      (agentToolsExposed
        ? capabilities.nativeToolContinuation === true &&
          capabilities.toolContinuationMode === "native"
        : capabilities.interleavedThinking === true),
    legacyResultRole: agentToolsExposed ? "user" : "system",
  };
}


export interface GenerateInput {
  userId: string;
  /** Pre-resolved authenticated account name used when no persona is selected. */
  userName?: string;
  chat_id: string;
  /** Client-minted authority correlating a pending request with id-less Stop. */
  request_authority_id?: string;
  connection_id?: string;
  persona_id?: string;
  persona_addon_states?: Record<string, boolean>;
  preset_id?: string;
  force_preset_id?: boolean;
  message_id?: string;
  /** Exact swipe selected for continue/regenerate/swipe targets. */
  swipe_id?: number;
  messages?: LlmMessage[];
  parameters?: GenerationParameters;
  generation_type?: GenerationType;
  /** Explicit runtime selection. Omitted preserves the existing Response path. */
  mode?: "response" | "agentic";
  /** One-use effective-runtime decision token for Agentic admission. */
  runtime_decision_token?: string;
  /** Monotonic request epoch captured by effective-runtime preflight. */
  request_epoch?: number;
  impersonate_mode?: ImpersonateMode;
  /** For impersonate: free-form text from the user's input box, appended to the impersonation prompt. */
  impersonate_input?: string;
  /** Exact input-bar draft snapshot captured when this generation started. */
  user_input?: string;
  /** For impersonate: stream tokens to the frontend but do NOT create a message. The user edits and sends manually. */
  impersonate_draft?: boolean;
  target_character_id?: string;
  regen_feedback?: string;
  regen_feedback_position?: "system" | "user";
  regen_feedback_format?: string;
  retain_council?: boolean;
  /** Dry-run only: reassemble as if this message were absent from history
   *  (used to reconstruct the prompt that produced an existing assistant turn). */
  exclude_message_id?: string;
  /** Optional abort signal — when fired, cancels an in-flight dry run. */
  signal?: AbortSignal;
  /** Deterministic id for edit-and-send replay; when set, skip minting a new UUID. */
  generationId?: string;
}

/**
 * Resolve the connection used by a chat generation. A chat-scoped binding is
 * authoritative over the caller's active/global connection. If the bound
 * profile was deleted, fall back to the requested/default profile so an old
 * metadata reference cannot make the chat unusable.
 *
 * When no `connection_id` was supplied by the caller — i.e. the generation was
 * triggered server-side (Edit-and-Send outbox dispatch, multiplayer host,
 * spindle sends that forward an `undefined` id) — the fallback is the ACTING
 * connection (`resolveActingConnectionId`: validated `activeProfileId` → the
 * `is_default` profile → any owned profile) rather than `is_default` alone.
 * `is_default` alone is the 401 defect: it is a different piece of state from
 * the `activeProfileId` the UI sends, so the dispatched generation could run on
 * a connection the user never selected. A supplied-but-stale id still throws
 * rather than silently retargeting.
 *
 * `opts.preferActiveConnection` is the `editAndSendAlwaysUseActiveConnection`
 * opt-in, and it is set only for Edit-and-Send dispatches. See below.
 *
 * `opts.authoritativeConnectionId` is the connection an Edit-and-Send request was
 * COMMITTED against, read off `generation_outbox.connection_id`. It is the FIRST
 * rung, ahead of the opt-in and ahead of the chat pin, because the whole point of
 * recording it is that no live state re-read may retarget a request the user
 * already committed. See the rung itself.
 */
function resolveChatGenerationConnection(
  userId: string,
  metadata: Record<string, any> | null | undefined,
  requestedConnectionId?: string,
  opts?: { preferActiveConnection?: boolean; authoritativeConnectionId?: string },
): ConnectionProfile {
  // An empty/whitespace-only id already fell through to the default profile
  // today; normalizing here keeps that outcome while letting the acting
  // fallback below see "no id was supplied".
  const requestedId = requestedConnectionId?.trim() || undefined;

  // Rung 0 — the durably COMMITTED connection. Set only for Edit-and-Send
  // dispatches, and only for rows that actually recorded one.
  //
  // This rung exists because an outbox row's dispatch is not a single event: the
  // same row is dispatched from the POST handler, again from the periodic retry
  // tick after a backoff, and again from startup crash recovery, potentially
  // hours apart. Every rung below reads LIVE state (`activeProfileId`, the
  // opt-in, the chat's `connection_profile_id` pin), so without this rung
  // switching the active profile between those ticks silently retargets a
  // request the user already committed. Ahead of `preferActiveConnection` on
  // purpose: the recorded value ALREADY baked in the opt-in's answer at commit
  // time (see `connections.service.resolveEditAndSendConnectionId`, which
  // mirrors this ladder rung for rung), so consulting the opt-in again could
  // only re-introduce the drift.
  //
  // Returning from here bypasses the `connection_model` metadata override at the
  // bottom of this function, so that override is re-applied inline — but ONLY
  // when the committed connection IS the chat's live pin. That condition is
  // exactly the existing `boundConnection && metadata.connection_model` gate, so
  // a pinned chat keeps its pinned model bit-for-bit. When the committed id came
  // from the active-profile opt-in instead (i.e. it is NOT the pinned profile),
  // the override is dropped, matching the reasoning already documented for the
  // active-profile rung: a pinned model belongs to the pinned profile and is
  // very often not a model the other endpoint serves, so carrying it over would
  // produce a second, subtler failure of exactly the kind this fix removes.
  // Blanket-dropping the override on this rung was the rejected alternative; it
  // silently changed the MODEL of every pinned chat, which is a behaviour change
  // this finding never asked for (and which
  // `edit-and-send-active-connection-optin.integration.test.ts`'s
  // "binding live, activeProfileId deleted" case pins).
  //
  // MISS POLICY: if the recorded id no longer resolves — the profile was deleted
  // between commit and dispatch — FALL THROUGH to the unchanged ladder rather
  // than throwing. A deleted profile is unrecoverable: no amount of retrying
  // brings it back, so throwing would only strand the user's committed edit with
  // no output at all, which is strictly worse than running it on their current
  // selection. This mirrors the precedent already documented on this function
  // for the chat-scoped binding ("If the bound profile was deleted, fall back ...
  // so an old metadata reference cannot make the chat unusable"). The rejected
  // alternative was failing the row terminally; that trades a rare wrong-profile
  // dispatch for a guaranteed lost request.
  const authoritativeId = opts?.authoritativeConnectionId?.trim() || undefined;
  if (authoritativeId) {
    const committed = connectionsSvc.resolveConnection(userId, authoritativeId);
    if (committed) {
      const pinnedId = typeof metadata?.connection_profile_id === "string"
        ? metadata.connection_profile_id.trim()
        : "";
      const committedIsPinned = pinnedId !== "" && pinnedId === committed.id;
      const pinnedModel = committedIsPinned && typeof metadata?.connection_model === "string"
        ? metadata.connection_model.trim()
        : "";
      return pinnedModel ? { ...committed, model: pinnedModel } : committed;
    }
  }

  // The opt-in: the user's STRICT active profile wins over a live chat-scoped
  // binding, for Edit-and-Send only, and only when no explicit id was supplied
  // (so every interactive path stays bit-identical). The binding's
  // `connection_model` override is deliberately NOT carried across: the pinned
  // model belongs to the pinned profile and is very often not a model the
  // active profile's endpoint serves, so carrying it over would produce a
  // second, subtler failure of exactly the kind this fix exists to remove.
  // When the strict rung resolves nothing, control falls through to the
  // unchanged ladder below — the prescribed safe degradation, structural rather
  // than defensive: this branch only ever replaces the FIRST choice.
  if (opts?.preferActiveConnection && !requestedId) {
    const activeId = connectionsSvc.resolveActiveConnectionId(userId);
    if (activeId) {
      const activeConnection = connectionsSvc.resolveConnection(userId, activeId);
      if (activeConnection) return activeConnection;
    }
  }

  const boundId = typeof metadata?.connection_profile_id === "string"
    ? metadata.connection_profile_id.trim()
    : "";
  const boundConnection = boundId
    ? connectionsSvc.resolveConnection(userId, boundId)
    : null;
  // The acting chain (active → is_default → any owned) is evaluated in stages
  // rather than as one `resolveActingConnectionId` call so that the rungs beyond
  // `is_default` are only reached when the earlier ones actually came up empty.
  // `resolveConnection` is the seam every caller and test harness already stubs;
  // `getDefaultConnection` / `listConnections` are not, and eagerly calling them
  // would make every generation start touch the database. The staged form is
  // equivalent to `resolveConnection(userId, resolveActingConnectionId(userId))`
  // rung for rung — `resolveActingConnectionId` remains the single owner of the
  // chain and is what the last stage delegates to.
  const connection = boundConnection
    ?? connectionsSvc.resolveConnection(
      userId,
      requestedId ?? connectionsSvc.resolveActiveConnectionId(userId),
    )
    ?? (requestedId
      ? null
      : connectionsSvc.resolveConnection(userId, connectionsSvc.resolveActingConnectionId(userId)));

  if (!connection) {
    throw new Error("No connection profile found. Configure a default connection or select one for this chat.");
  }

  const modelOverride = boundConnection && typeof metadata?.connection_model === "string"
    ? metadata.connection_model.trim()
    : "";
  return modelOverride ? { ...connection, model: modelOverride } : connection;
}

/**
 * The `editAndSendAlwaysUseActiveConnection` Productivity setting, used on the
 * LEGACY dispatch path — i.e. for outbox rows that recorded no
 * `connection_id`, either because they were committed before
 * `migrations/111_generation_outbox_connection_id.sql` or because resolution
 * came up empty at commit time. Rows that DID record one never reach this read:
 * the recorded value already baked the opt-in's answer in at commit time.
 *
 * The predicate itself now lives in `settings.service`, which owns it for BOTH
 * ends of the flow — `chats.service.editAndSend` (via
 * `connections.service.resolveEditAndSendConnectionId`) at commit time and this
 * module at dispatch time. The rejected alternative was keeping a second copy
 * here: two independent strict-read implementations for one setting is exactly
 * how the commit-time and dispatch-time answers would drift, which is the class
 * of bug this whole change exists to remove. This local alias is retained only
 * so the `__test__` seam below keeps its existing name and existing callers
 * (`connections.service.acting-connection.test.ts`,
 * `edit-and-send-active-connection-optin.property.test.ts`).
 */
const readEditAndSendAlwaysUseActiveConnection = (userId: string): boolean =>
  settingsSvc.readEditAndSendAlwaysUseActiveConnection(userId);

/** Lifecycle context passed from startGeneration → runGeneration */
interface GenerationLifecycle {
  /** User-authored messages that immediately preceded this generation. */
  sourceUserMessageIds?: string[];
  /** For regenerate: update swipe on this message instead of creating new */
  targetMessageId?: string;
  /** For regenerate: index of the blank swipe to fill with generated content */
  targetSwipeIdx?: number;
  /** Index of the swipe being streamed into, surfaced to clients (GENERATION_STARTED /
   *  IN_PROGRESS / status) so they can gate the streaming buffer to that swipe and
   *  let the user navigate other swipes mid-generation. Set for all generation types
   *  (regenerate = blank swipe, normal = 0, continue = current swipe). */
  streamingSwipeId?: number;
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
  /** Explicit assembly surface used for owner-side prompt provenance. */
  assemblySurface?: AssemblySurfaceV1;
  /** Owner-visible Loom omission/provenance captured during assembly. */
  loomPromptInspection?: LoomPromptInspectionV1;

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
  /** Resolved connection display name, used to enrich a provider 401/403 that
   *  came back from a connection which sent no stored credential. */
  connectionName?: string;
  /** Model + provider + preset info for breakdown storage */
  model?: string;
  providerName?: string;
  presetName?: string;
  /** Resolved preset id */
  presetId?: string;
  /** Trim the final word after a directly word-terminated streamed response. */
  trimIncompleteWords?: boolean;
  /** Max context from connection parameters (for breakdown display) */
  maxContext?: number;
  /** Council named results (for expression detection and other post-generation hooks) */
  councilNamedResults?: Record<string, string>;
  /** Context-budget clipping stats (for GENERATION_IN_PROGRESS payload + breakdown). */
  contextClipStats?: import("../llm/types").ContextClipStats;
}
function isAgentSummaryPersistenceTarget(
  lifecycle: Pick<
    GenerationLifecycle,
    | "generationType"
    | "targetMessageId"
    | "targetSwipeIdx"
    | "stagedMessageId"
    | "continueMessageId"
  >,
  messageId: string,
  swipeId: number | undefined,
): swipeId is number {
  if (
    lifecycle.generationType === "impersonate" ||
    typeof swipeId !== "number" ||
    !Number.isSafeInteger(swipeId) ||
    swipeId < 0
  ) {
    return false;
  }

  const existingTargetIds = [
    lifecycle.targetMessageId,
    lifecycle.stagedMessageId,
    lifecycle.continueMessageId,
  ].filter((targetId): targetId is string => targetId !== undefined);
  return (
    existingTargetIds.every((targetId) => targetId === messageId) &&
    (lifecycle.targetSwipeIdx == null ||
      lifecycle.targetSwipeIdx === swipeId)
  );
}


function collectTrailingUserMessageIds(userId: string, chatId: string): string[] {
  return chatsSvc.getTrailingVisibleUserMessageIds(userId, chatId);
}

function injectConnectionMetadataFlags(
  connection: { provider: string; metadata?: Record<string, any> },
  params: GenerationParameters,
  chatId?: string,
): void {
  if (connection.metadata?.use_responses_api) {
    params.use_responses_api = true;
  }

  if (connection.provider === "openrouter") {
    if (connection.metadata?.openrouter) {
      params._openrouter = connection.metadata.openrouter;
    }
    // OpenRouter documents `session_id` as the explicit sticky-routing key.
    // Keep it scoped to a Lumiverse chat and never replace a caller-provided
    // session or cache key. The provider then reuses the same upstream cache
    // across normal turns, swipes, and retries without forcing no-fallback.
    if (chatId && params.session_id === undefined && params.prompt_cache_key === undefined) {
      params.session_id = `lumiverse:${chatId}`;
    }
  }
}

function omitChatHistoryBreakdownEntries<
  T extends { type: string },
>(entries: T[]): T[] {
  return entries.filter((entry) => entry.type !== "chat_history");
}

function sumChatHistoryBreakdownTokens(
  entries: Array<{ type: string; tokens: number }>,
): number {
  return entries.reduce(
    (sum, entry) => sum + (entry.type === "chat_history" ? entry.tokens : 0),
    0,
  );
}

function omitChatHistoryTokenBreakdown(
  tokenCount: DryRunResult["tokenCount"],
): DryRunResult["tokenCount"] {
  if (!tokenCount) return tokenCount;
  return {
    ...tokenCount,
    breakdown: omitChatHistoryBreakdownEntries(tokenCount.breakdown),
  };
}

function normalizeReasoningText(reasoning: unknown): string | undefined {
  return typeof reasoning === "string" && reasoning.trim().length > 0
    ? reasoning
    : undefined;
}

function extractThinkingBlockText(
  blocks: LlmThinkingBlock[] | undefined,
): string | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return undefined;
  const combined = blocks
    .map((block) =>
      block.type === "thinking" && typeof block.thinking === "string"
        ? block.thinking
        : "",
    )
    .filter((text) => text.trim().length > 0)
    .join("\n");
  return combined.trim().length > 0 ? combined : undefined;
}

function extractReasoningDetailsText(
  details: Record<string, unknown>[] | undefined,
): string | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  const combined = details
    .map((detail) => {
      if (!detail || typeof detail !== "object") return "";
      if (typeof detail.text === "string") return detail.text;
      if (typeof detail.summary === "string") return detail.summary;
      return "";
    })
    .filter((text) => text.trim().length > 0)
    .join("\n");
  return combined.trim().length > 0 ? combined : undefined;
}
function validatedGenerationUsage(
  usage: unknown,
): NonNullable<GenerationResponse["usage"]> {
  if (usage === null || typeof usage !== "object") {
    throw new AgentRuntimeFailure("provider_protocol_error");
  }
  const candidate = usage as Record<string, unknown>;
  const promptTokens = candidate.prompt_tokens;
  const completionTokens = candidate.completion_tokens;
  const totalTokens = candidate.total_tokens;
  if (
    typeof promptTokens !== "number" ||
    typeof completionTokens !== "number" ||
    typeof totalTokens !== "number" ||
    !Number.isSafeInteger(promptTokens) ||
    !Number.isSafeInteger(completionTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    promptTokens < 0 ||
    completionTokens < 0 ||
    totalTokens < 0 ||
    promptTokens > Number.MAX_SAFE_INTEGER - completionTokens ||
    totalTokens < promptTokens + completionTokens
  ) {
    throw new AgentRuntimeFailure("provider_protocol_error");
  }
  return usage as NonNullable<GenerationResponse["usage"]>;
}

function addGenerationTokenCount(left: number, right: number): number {
  if (left > Number.MAX_SAFE_INTEGER - right) {
    throw new AgentRuntimeFailure("provider_protocol_error");
  }
  return left + right;
}


function addCheckedGenerationUsage(
  current: GenerationResponse["usage"],
  additional: GenerationResponse["usage"],
): GenerationResponse["usage"] {
  if (additional === undefined) {
    return current === undefined
      ? undefined
      : { ...validatedGenerationUsage(current) };
  }
  const next = validatedGenerationUsage(additional);
  if (current === undefined) return { ...next };
  const accumulated = validatedGenerationUsage(current);
  return {
    prompt_tokens: addGenerationTokenCount(
      accumulated.prompt_tokens,
      next.prompt_tokens,
    ),
    completion_tokens: addGenerationTokenCount(
      accumulated.completion_tokens,
      next.completion_tokens,
    ),
    total_tokens: addGenerationTokenCount(
      accumulated.total_tokens,
      next.total_tokens,
    ),
    ...(next.provider_raw !== undefined
      ? { provider_raw: next.provider_raw }
      : accumulated.provider_raw !== undefined
        ? { provider_raw: accumulated.provider_raw }
        : {}),
  };
}
function addUncheckedGenerationUsage(
  current: GenerationResponse["usage"],
  additional: GenerationResponse["usage"],
): GenerationResponse["usage"] {
  if (!current) return additional ? { ...additional } : undefined;
  if (!additional) return { ...current };
  return {
    prompt_tokens: current.prompt_tokens + additional.prompt_tokens,
    completion_tokens:
      current.completion_tokens + additional.completion_tokens,
    total_tokens: current.total_tokens + additional.total_tokens,
    ...(additional.provider_raw !== undefined
      ? { provider_raw: additional.provider_raw }
      : current.provider_raw !== undefined
        ? { provider_raw: current.provider_raw }
        : {}),
  };
}

function reconcileObservedGenerationUsage(
  usage: GenerationResponse["usage"],
  observedOutputTokens: number,
): NonNullable<GenerationResponse["usage"]> {
  if (
    !Number.isSafeInteger(observedOutputTokens) ||
    observedOutputTokens < 0
  ) {
    throw new AgentRuntimeFailure("provider_protocol_error");
  }
  const validated = usage === undefined
    ? undefined
    : validatedGenerationUsage(usage);
  const promptTokens = validated?.prompt_tokens ?? 0;
  const completionTokens = Math.max(
    validated?.completion_tokens ?? 0,
    observedOutputTokens,
  );
  const minimumTotal = addGenerationTokenCount(
    promptTokens,
    completionTokens,
  );
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: Math.max(validated?.total_tokens ?? 0, minimumTotal),
    ...(validated?.provider_raw !== undefined
      ? { provider_raw: validated.provider_raw }
      : {}),
  };
}

function settleGenerationRoundUsage(
  current: GenerationResponse["usage"],
  round: GenerationResponse["usage"],
  checked: boolean,
): GenerationResponse["usage"] {
  if (round === undefined) return current;
  // The unchecked staging path records the provider's latest usage trailer as
  // the generation usage. Agent-owned rounds use checked accumulation below
  // so each provider round can be reconciled independently.
  return checked ? addCheckedGenerationUsage(current, round) : { ...round };
}

function addAgentUsageToGenerationUsage(
  current: GenerationResponse["usage"],
  usage: AgentUsage | undefined,
): GenerationResponse["usage"] {
  if (!usage) return current;
  if (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.totalTokens === 0
  ) {
    return current;
  }
  return addCheckedGenerationUsage(current, {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
  });
}
function isMainProcessAssemblyRetryError(error: unknown): boolean {
  return (
    isSafeResponseAssemblyFallbackError(error)
    || error instanceof AgentAssemblyRequiresMainProcessError
    || (error !== null &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "AgentAssemblyRequiresMainProcessError")
    || (error instanceof Error && error.message === "Chat not found")
  );
}


function resolveDryRunMessageReasoning(
  message: LlmMessage,
  sourceMessage?: Message,
): string | undefined {
  return (
    normalizeReasoningText(sourceMessage?.extra?.reasoning) ??
    normalizeReasoningText(message.reasoning_content) ??
    extractThinkingBlockText(message.thinking_blocks) ??
    extractReasoningDetailsText(message.reasoning_details)
  );
}

function shouldExtractDisplayReasoningFromContent(message: LlmMessage): boolean {
  return (
    message.role === "assistant" &&
    isChatHistoryMessage(message) &&
    !shouldPreserveDisplayReasoningDelimiters(message)
  );
}

function buildDryRunDisplayMessages(
  messages: LlmMessage[],
  sourceMessagesById?: Map<string, Message>,
  reasoningSettings?: {
    prefix?: string;
    suffix?: string;
    keepInHistory?: number;
  } | null,
): DryRunDisplayMessage[] {
  const delimiters = resolveReasoningDelimiters(reasoningSettings);

  const displayMessages = messages.map((message) => {
    const described = describeContentForDisplay(message.content);
    const extractedReasoning = shouldExtractDisplayReasoningFromContent(message)
      ? extractDelimitedReasoning(described.text, delimiters)
      : { cleaned: described.text, reasoning: "" };
    const sourceMessageId = getSourceMessageId(message);
    const sourceMessage = sourceMessageId
      ? sourceMessagesById?.get(sourceMessageId)
      : undefined;
    const reasoning =
      normalizeReasoningText(extractedReasoning.reasoning) ??
      resolveDryRunMessageReasoning(message, sourceMessage);

    const displayMessage: DryRunDisplayMessage = {
      ...(message as any),
      content: extractedReasoning.cleaned,
    };
    if (described.contentParts.length > 0) {
      displayMessage.contentParts = described.contentParts;
    }

    if (
      reasoning &&
      extractedReasoning.cleaned.trim() !== reasoning.trim()
    ) {
      displayMessage.reasoning = reasoning;
    }

    return displayMessage;
  });

  const keepInHistory = reasoningSettings?.keepInHistory ?? -1;
  if (keepInHistory !== -1) {
    let keptReasoningMessages = 0;
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (!isChatHistoryMessage(messages[i]) || messages[i].role !== "assistant") {
        continue;
      }
      if (!displayMessages[i].reasoning) continue;
      keptReasoningMessages++;
      if (keptReasoningMessages > keepInHistory) {
        delete displayMessages[i].reasoning;
      }
    }
  }

  return displayMessages;
}

export const __test__ = {
  addAgentUsageToGenerationUsage,
  addCheckedGenerationUsage,
  reconcileObservedGenerationUsage,
  settleGenerationRoundUsage,
  buildDryRunDisplayMessages,
  extractReasoningDetailsText,
  extractThinkingBlockText,
  injectConnectionMetadataFlags,
  resolveEffectiveAgentPreset,
  cloneEffectiveAgentPresetResolution,
  assertRoomAgentIntrinsicsBeforeCouncil,
  prepareAgentProviderRequest,
  observeAgentProviderOutput,
  terminalAgentError,
  terminalReasonForError,
  isMainProcessAssemblyRetryError,
  isAgentSummaryPersistenceTarget,
  omitChatHistoryBreakdownEntries,
  omitChatHistoryTokenBreakdown,
  recognizedAgentToolNames: RECOGNIZED_AGENT_TOOL_NAMES,
  resolveInlineToolContinuationPolicy,
  completeInlineToolResults,
  validateInlineToolCallIds,
  mergeProviderTransientCarrier,
  readEditAndSendAlwaysUseActiveConnection,
  resolveChatGenerationConnection,
  resolveDryRunMessageReasoning,
  resolveProviderAndKey,
  validateAgentSealBoundary,
  assertAgentFinalContextFit,
  errorMessage,
  sumChatHistoryBreakdownTokens,
  toAgenticGenerationInput,
  encodeExtensionToolName,
  validateTerminalProviderToolBatch,
};

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
  /** Internal host tool policy, aligned exactly with the provider request contract. */
  toolMode?: GenerationRequest["toolMode"];
  /**
   * Optional per-request reasoning override. When omitted (or `source: "inherit"`),
   * the connection's bound reasoning settings are applied, falling back to
   * the user's global `reasoningSettings`. See `GenerationReasoningOverrideDTO`.
   */
  reasoning?: GenerationReasoningOverrideDTO;
}

export interface QuietGenerateInput {
  messages: LlmMessage[];
  connection_id?: string;
  parameters?: GenerationParameters;
  /** Optional tool/function definitions for inline function calling. */
  tools?: ToolDefinition[];
  /** Internal host policy used by Memory Cortex; never exposed by the REST request DTO. */
  toolMode?: "required";
  /** Optional abort signal — when fired, cancels the in-flight HTTP request. */
  signal?: AbortSignal;
  /**
   * Optional chat id. Currently used by the summarize path to track in-flight
   * jobs in the summarize pool so frontends can recover state on reconnect or
   * chat-switch. Ignored by `quietGenerate`.
   */
  chat_id?: string;
  /**
   * Optional per-request reasoning override. When omitted (or `source: "inherit"`),
   * the connection's bound reasoning settings are applied, falling back to
   * the user's global `reasoningSettings`. See `GenerationReasoningOverrideDTO`.
   */
  reasoning?: GenerationReasoningOverrideDTO;
}

/** Input for the /summarize endpoint — backend fetches messages and builds the prompt. */
export interface SummarizeGenerateInput {
  /** Chat ID to summarize. */
  chat_id: string;
  /** Number of recent messages to include in the prompt. */
  message_context: number;
  /** Previously stored summary text (may be empty). */
  existingSummary?: string;
  /** Active persona / user name. */
  userName: string;
  /** Active character name. */
  characterName: string;
  /** Optional custom system prompt template (falls back to backend default). */
  systemPromptOverride?: string | null;
  /** Optional custom user prompt template (falls back to backend default). */
  userPromptOverride?: string | null;
  /** Connection profile ID for the LLM call. */
  connection_id?: string;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface DryRunResult {
  /** Explicit surface used by this dry-run assembly. */
  assemblySurface: AssemblySurfaceV1;
  /** Typed Loom omission/provenance for owner inspection. */
  loomPromptInspection?: LoomPromptInspectionV1;
  messages: DryRunDisplayMessage[];
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
  chatHistoryTokens?: number;
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
  memoryStats?: import("../llm/types").MemoryStats;
  databankStats?: import("../llm/types").DatabankStats;
  contextClipStats?: import("../llm/types").ContextClipStats;
}

export interface DryRunDisplayMessage
  extends Omit<LlmMessage, "content"> {
  content: string;
  reasoning?: string;
  contentParts?: DisplayContentPartSummary[];
  __chatHistorySource?: boolean;
  __sourceMessageId?: string;
  __sourceIndexInChat?: number;
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
  dryRun?: boolean;
  userId?: string;
  cancelGeneration?: boolean;
  activatedWorldInfo?: ActivatedWorldInfoEntry[];
  __spindleWorldInfoCaptures?: Record<string, ActivatedWorldInfoEntry[]>;
  [key: string]: unknown;
}

class GenerationCancelledByExtensionError extends Error {
  constructor() {
    super("Generation cancelled by extension context handler");
    this.name = "GenerationCancelledByExtension";
  }
}

/** Result of assembling + post-processing the prompt pipeline. */
interface PromptPipelineResult {
  assemblySurface: AssemblySurfaceV1;
  loomPromptInspection?: LoomPromptInspectionV1;
  messages: LlmMessage[];
  parameters: GenerationParameters;
  breakdown?: AssemblyBreakdownEntry[];
  /** Snapshot of chat history messages taken before interceptors/post-processing,
   *  used as the shared tokenization source for both dry-run and generation breakdowns. */
  chatHistoryMessages?: LlmMessage[];
  /** The resolved assistant prefill text. When set, the generate service prepends
   *  this to the LLM response since the model continues after the prefill. */
  assistantPrefill?: string;
  /** The resolved Kimi reasoning prefix, surfaced before streamed reasoning. */
  assistantReasoningPrefill?: string;
  activatedWorldInfo?: ActivatedWorldInfoEntry[];
  worldInfoStats?: DryRunResult["worldInfoStats"];
  memoryStats?: import("../llm/types").MemoryStats;
  databankStats?: import("../llm/types").DatabankStats;
  contextClipStats?: import("../llm/types").ContextClipStats;
  agentRuntimeOwner?: AgentRuntimeOwner;
  deferredWiState?: { chatId: string; partial: Record<string, any> };
  spindleContext: SpindleContext;
  /** True if the {{lumiaCouncilDeliberation}} macro was resolved during assembly. */
  deliberationHandledByMacro?: boolean;
  /** The macro environment built during assembly — used for regex script macro substitution. */
  macroEnv?: import("../macros/types").MacroEnv;
  /** Snapshot of the macro environment before chat-history evaluation mutates it. */
  macroEnvSeed?: import("../macros/types").MacroEnv;
  /** Resolved per-preset setting for streamed response finalization. */
  trimIncompleteWords?: boolean;
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

/** Validates protected results at a named pipeline boundary. */
function validateAgentSealBoundary(
  stage: AgentSealStage,
  seals: Pick<AgentSealRegistry, "validateAfterTransforms">,
  messages: readonly LlmMessage[],
): void {
  withAgentSealStage(stage, () => seals.validateAfterTransforms(messages));
}

function assertAgentFinalContextFit(stats: ContextClipStats): void {
  if (
    stats.budgetInvalid ||
    stats.fixedOverBudget ||
    stats.anchorOverflow
  ) {
    throw new AgentSealError("context_limit_exceeded", "final_context_fit");
  }
}

/**
 * Safely extract a human-readable message from a thrown value.
 * Bun's fetch/stream internals on Windows can reject with `null` when an
 * abort signal fires mid-stream, so `err.message` would throw a TypeError
 * and crash the server. Handles null, undefined, strings, and non-Error
 * objects gracefully.
 */
function errorMessage(err: unknown): string {
  if (err instanceof AgentSealError) {
    console.error("[agents] Agent result integrity failure", {
      reason: err.reasonCode,
      stage: err.stage ?? null,
    });
    return err.message;
  }
  const described = describeProviderError(err, "");
  if (described) return clampErrorMessage(described);
  if (err == null) return "Unknown error";
  if (typeof err === "string") return clampErrorMessage(err);
  if (
    typeof err === "object" &&
    "message" in err &&
    typeof (err as any).message === "string"
  ) {
    return clampErrorMessage((err as any).message);
  }
  try {
    return clampErrorMessage(String(err));
  } catch {
    return "Unknown error";
  }
}

/**
 * The residual keyless case the credential preflight deliberately leaves
 * permissive: a connection with `has_api_key = 0` on a provider that does not
 * declare a key as required sends no `Authorization` header at all (see
 * `OpenAICompatibleProvider.headers`). Legitimate for a local endpoint —
 * misconfiguration for a gateway that wants a key, and indistinguishable up
 * front. When such a call comes back 401/403, name the connection and say that
 * no stored key was sent, so the user gets a remedy instead of the raw provider
 * status line alone. `describeProviderError` has no connection context and is
 * left untouched.
 */
function enrichUnauthenticatedConnectionError(
  message: string,
  err: unknown,
  opts: { apiKey: string; connectionName?: string },
): string {
  if (opts.apiKey) return message;
  if (!(err instanceof ProviderRequestError)) return message;
  if (err.status !== 401 && err.status !== 403) return message;
  const connectionName = opts.connectionName?.trim();
  if (!connectionName) return message;
  return clampErrorMessage(
    `${message} No stored API key was sent for connection "${connectionName}" — add one via the connection settings, or switch this chat to a connection that has one.`,
  );
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

/**
 * Provider function names cannot contain the qualified registration separator
 * (`:`). Encode the complete qualified key instead of attempting a reversible
 * punctuation substitution: valid extension IDs/tool names may themselves
 * contain `__`.
 */
function encodeExtensionToolName(qualifiedName: string): string {
  return `spindle_ext_${Buffer.from(qualifiedName, "utf8").toString("base64url")}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A provider terminal `tool_calls` marker is an atomic contract: an absent,
 * empty, duplicate, or structurally malformed batch is a protocol failure,
 * never a normal text completion.
 */
function validateTerminalProviderToolBatch(
  finishReason: string | undefined,
  toolCalls: unknown,
): ToolCallResult[] | undefined {
  if (finishReason !== "tool_calls") return undefined;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new ProviderProtocolError(
      "Provider returned a tool_calls finish reason without a complete batch",
    );
  }

  const seenIds = new Set<string>();
  for (const rawCall of toolCalls) {
    if (!isPlainRecord(rawCall)) {
      throw new ProviderProtocolError("Provider returned a malformed tool call");
    }
    const name = rawCall.name;
    const callId = rawCall.call_id;
    const args = rawCall.args;
    if (
      typeof name !== "string" ||
      name.trim().length === 0 ||
      typeof callId !== "string" ||
      callId.trim().length === 0 ||
      seenIds.has(callId) ||
      !isPlainRecord(args)
    ) {
      throw new ProviderProtocolError("Provider returned a malformed tool call");
    }
    seenIds.add(callId);
    if (
      rawCall.thought_signature !== undefined &&
      typeof rawCall.thought_signature !== "string"
    ) {
      throw new ProviderProtocolError("Provider returned a malformed tool call");
    }
  }

  return toolCalls as unknown as ToolCallResult[];
}

function unavailableInlineToolResult(
  toolCall: ToolCallResult,
): InlineCouncilToolResult {
  return {
    callId: toolCall.call_id,
    qualifiedName: "unavailable",
    toolName: "unavailable",
    toolDisplayName: "Unavailable tool",
    result: JSON.stringify({
      status: "error",
      errorCode: "invalid_arguments",
      message: "Tool call is unavailable",
    }),
  };
}
function resultLimitExceededResult(
  toolCall: ToolCallResult,
): InlineCouncilToolResult {
  return {
    callId: toolCall.call_id,
    qualifiedName: toolCall.name,
    toolName: toolCall.name,
    toolDisplayName: toolCall.name,
    result: JSON.stringify({
      status: "error",
      errorCode: "limit_exceeded",
      message: "Tool result exceeded its bounded result envelope",
    }),
  };
}

function completeInlineToolResults(
  toolCalls: readonly ToolCallResult[],
  resultsByIndex: readonly (InlineCouncilToolResult | undefined)[],
): InlineCouncilToolResult[] {
  return toolCalls.map(
    (toolCall, index) =>
      resultsByIndex[index] ?? unavailableInlineToolResult(toolCall),
  );
}

function buildInlineToolValidationDefinitions(
  userId: string,
  toolsByName: ReadonlyMap<string, RuntimeCouncilToolDefinition> | undefined,
  membersByPrefix: ReadonlyMap<string, CouncilMember> | undefined,
): Map<string, ToolDefinition> | undefined {
  if (!toolsByName) return undefined;
  const definitions = new Map<string, ToolDefinition>();
  for (const [name, tool] of toolsByName) {
    const parameters = getCouncilToolArgsSchema(userId, tool);
    if (!parameters) continue;
    const definition = {
      name,
      description: tool.description,
      parameters,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    } satisfies ToolDefinition;
    definitions.set(name, definition);
    if (!membersByPrefix) continue;
    for (const [prefix, member] of membersByPrefix) {
      if (member.tools.includes(tool.name)) {
        definitions.set(`${prefix}_${tool.name}`, {
          ...definition,
          name: `${prefix}_${tool.name}`,
        });
      }
    }
  }
  return definitions;
}
async function executeInlineCouncilToolCalls(
  userId: string,
  toolCalls: ToolCallResult[],
  timeoutMs: number,
  toolsByName: Map<string, RuntimeCouncilToolDefinition>,
  membersByPrefix: Map<string, CouncilMember> | undefined,
  contextMessages: LlmMessage[],
  signal: AbortSignal,
  safeNameToQualifiedName?: ReadonlyMap<string, string>,
  allowDirectWebSearch = false,
): Promise<InlineCouncilToolResult[]> {
  const results: InlineCouncilToolResult[] = [];
  let directWebSearchExecuted = false;

  for (const toolCall of toolCalls) {
    const mappedQualifiedName = safeNameToQualifiedName?.get(toolCall.name);
    let tool: RuntimeCouncilToolDefinition | undefined;
    let member: CouncilMember | undefined;
    let resolvedQualifiedName = mappedQualifiedName ?? "";
    let isCouncilCall = false;

    // Mapped provider names are authoritative. Never reverse-map punctuation:
    // an extension identifier or tool name may legitimately contain "__".
    if (mappedQualifiedName) {
      tool = toolsByName.get(toolCall.name);
    } else {
      // Try Council-prefixed tool name first (memberIdPrefix_toolName).
      const parsedName = parseInlineToolCallName(toolCall.name);
      if (parsedName) {
        const { memberIdPrefix, qualifiedName } = parsedName;
        tool = toolsByName.get(qualifiedName);
        if (tool) {
          isCouncilCall = true;
          member = membersByPrefix?.get(memberIdPrefix);
          resolvedQualifiedName = qualifiedName;
        }
      }

      // Fall back to direct lookup for Council/host definitions and legacy
      // extension calls that were not built through the mapped inline path.
      if (!tool) {
        tool = toolsByName.get(toolCall.name);
        resolvedQualifiedName = toolCall.name;
      }
    }

    if (!tool) {
      results.push(unavailableInlineToolResult(toolCall));
      continue;
    }
    // Only an actually resolved Council-prefixed definition requires a member
    // match. A direct extension name can contain underscores and must not be
    // misclassified by the syntactic prefix parser.
    if (isCouncilCall && !member) {
      results.push(unavailableInlineToolResult(toolCall));
      continue;
    }

    const isDirectWebSearch =
      !isCouncilCall &&
      toolCall.name === INLINE_WEB_SEARCH_TOOL_NAME &&
      resolvedQualifiedName === INLINE_WEB_SEARCH_TOOL_NAME;
    if (isDirectWebSearch && (!allowDirectWebSearch || directWebSearchExecuted)) {
      results.push({
        callId: toolCall.call_id,
        qualifiedName: resolvedQualifiedName,
        toolName: tool.name,
        toolDisplayName: tool.displayName,
        result: "Web search can be called only once per generation.",
        isError: true,
        isInlineWebSearch: true,
      });
      continue;
    }

    const directQuery = isDirectWebSearch && typeof toolCall.args?.query === "string"
      ? toolCall.args.query.trim().slice(0, INLINE_WEB_SEARCH_MAX_QUERY_CHARS)
      : undefined;
    if (isDirectWebSearch && (!directQuery || directQuery.length < 2)) {
      results.push({
        callId: toolCall.call_id,
        qualifiedName: resolvedQualifiedName,
        toolName: tool.name,
        toolDisplayName: tool.displayName,
        result: "Web search requires a query of at least two characters.",
        isError: true,
        isInlineWebSearch: true,
      });
      directWebSearchExecuted = true;
      continue;
    }

    const execution = getCouncilToolExecution(userId, tool);
    if (execution === "llm") {
      results.push(unavailableInlineToolResult(toolCall));
      continue;
    }

    let result = "";

    if (execution === "mcp") {
      const mcpMatch = parseMcpToolName(userId, resolvedQualifiedName);
      if (!mcpMatch) {
        results.push(unavailableInlineToolResult(toolCall));
        continue;
      }

      result = await getMcpClientManager().callTool(
        userId,
        mcpMatch.serverId,
        mcpMatch.toolName,
        toolCall.args ?? {},
        timeoutMs,
        signal,
      );
    } else if (execution === "extension") {
      // The host map is the only authority for provider-safe extension names.
      // Never decode "__" back to ":"; both characters are valid user names.
      const extToolReg = getExtensionToolRegistration(resolvedQualifiedName);
      if (!extToolReg) {
        results.push(unavailableInlineToolResult(toolCall));
        continue;
      }

      let memberContext: CouncilMemberContext | undefined;
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
          // getTextContent handles both string and multipart (tool_use/
          // tool_result) message content so structured interleaved-thinking
          // continuations still render a readable context for extension tools.
          return `${prefix}${getTextContent(m)}`;
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
        signal,
      );
    } else if (execution === "host") {
      if (!member && !isDirectWebSearch) {
        results.push(unavailableInlineToolResult(toolCall));
        continue;
      }
      let lumiaItem: ReturnType<typeof packsSvc.getLumiaItem> = null;
      if (member) {
        try {
          lumiaItem = packsSvc.getLumiaItem(userId, member.itemId);
        } catch {
          // Pack/item may have been removed mid-generation.
        }
      }

      try {
        const requestedCount = typeof toolCall.args?.result_count === "number"
          ? toolCall.args.result_count
          : Number(toolCall.args?.result_count);
        const args = isDirectWebSearch
          ? {
              ...(toolCall.args ?? {}),
              query: directQuery,
              result_count: Number.isFinite(requestedCount)
                ? Math.max(1, Math.min(INLINE_WEB_SEARCH_MAX_RESULTS, Math.round(requestedCount)))
                : INLINE_WEB_SEARCH_MAX_RESULTS,
            }
          : toolCall.args ?? {};
        result = await raceWithSignal(
          executeHostCouncilTool({
            userId,
            tool,
            args,
            member,
            memberContext: member ? buildCouncilMemberContext(member, lumiaItem) : undefined,
            contextMessages,
            timeoutMs,
            signal,
          }),
          signal,
        );
      } catch (err) {
        if (signal.aborted) throw signal.reason ?? err;
        if (!isDirectWebSearch) throw err;
        results.push({
          callId: toolCall.call_id,
          qualifiedName: resolvedQualifiedName,
          toolName: tool.name,
          toolDisplayName: tool.displayName,
          result: `Web search failed: ${errorMessage(err)}`,
          isError: true,
          isInlineWebSearch: true,
        });
        directWebSearchExecuted = true;
        continue;
      }
    }

    results.push({
      callId: toolCall.call_id,
      qualifiedName: resolvedQualifiedName!,
      toolName: tool.name,
      toolDisplayName: tool.displayName,
      memberName: member?.itemName,
      // Keep the immediate result compact. The full, untrusted source text is
      // attached exactly once in the continuation using the provider-safe form.
      result: isDirectWebSearch
        ? "Web search completed. Retrieved reference context is available in the following system message."
        : result,
      ...(isDirectWebSearch ? {
        inlineWebSearchContext: result,
        isInlineWebSearch: true,
      } : {}),
    });
    if (isDirectWebSearch) directWebSearchExecuted = true;
  }

  return results;
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
/**
 * Iterator teardown is advisory after cancellation. Some provider generators
 * serialize `return()` behind a pending `next()`, so awaiting it here can hold
 * the terminal projection forever even though the ledger has already closed.
 */
function closeProviderIterator(
  iterator: AsyncIterator<StreamChunk, void> | undefined,
): void {
  try {
    const cleanup = iterator?.return?.(undefined);
    if (cleanup) void Promise.resolve(cleanup).catch(() => {});
  } catch {
    /* best-effort */
  }
}


// ── Pre-token transient retry ────────────────────────────────────────────────
// A momentary provider 429/5xx/529 otherwise fails the whole generation. We
// retry establishing the upstream stream a few times with full-jitter backoff,
// but ONLY before the first chunk is emitted — once tokens flow, mid-stream
// failures propagate unchanged (retrying then would duplicate output).
const GENERATION_MAX_RETRIES = (() => {
  const raw = Number(process.env.LUMIVERSE_GENERATION_MAX_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 3;
})();
const GENERATION_RETRY_BASE_MS = 500;
const GENERATION_RETRY_MAX_MS = 8_000;

// Max inline tool-call rounds within a single generation (model → tools →
// model → …). Interleaved-thinking agents can chain many tool calls, so this
// is tunable; defaults to 3 to preserve historical behaviour.
const INLINE_TOOL_MAX_ROUNDS = (() => {
  const raw = Number(process.env.LUMIVERSE_INLINE_TOOL_MAX_ROUNDS);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 3;
})();

function computeBackoffMs(attempt: number, retryAfterMs?: number): number {
  // Honor a server Retry-After hint when present, clamped to our ceiling.
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, GENERATION_RETRY_MAX_MS);
  }
  // Full jitter: random in [0, min(cap, base * 2^attempt)].
  const ceil = Math.min(GENERATION_RETRY_MAX_MS, GENERATION_RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(Math.random() * ceil);
}

/** Sleep that rejects immediately if the signal aborts (e.g. user hits Stop). */
function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });

  });
}
function terminalErrorCategory(code: AgentPublicErrorCode): AgentPublicErrorCategory {
  if (
    code === "capacity_exceeded" ||
    code.startsWith("host_")
  ) return "capacity";
  if (
    code.endsWith("_limit_exceeded") ||
    code === "activity_event_limit_exceeded" ||
    code === "activity_byte_limit_exceeded"
  ) return "budget";
  if (code === "context_limit_exceeded") return "context";
  if (code === "timeout" || code === "root_wall_clock_limit_exceeded") return "timeout";
  if (code === "cancelled") return "cancelled";
  if (code.startsWith("provider_")) return "provider";
  if (
    code === "invalid_task" ||
    code === "invalid_profile" ||
    code === "invalid_arguments" ||
    code === "batch_rejected" ||
    code === "unknown_tool" ||
    code === "unauthorized" ||
    code === "child_required_failed" ||
    code === "agentic_protocol_failure"
  ) return "validation";
  if (code === "integrity_error") return "integrity";
  return "internal";
}

function publicTerminalCodeForError(
  error: unknown,
): AgentPublicErrorCode | undefined {
  if (error instanceof AgentAccountingFailure) return error.code;
  if (error instanceof AgentLedgerFailure) return error.code;
  if (error instanceof AgentRuntimeFailure) {
    return asPublicRuntimeCode(error.code);
  }
  if (error instanceof AgentSealError) {
    if (
      error.reasonCode === "context_limit_exceeded" ||
      error.reasonCode === "materialized_limit_exceeded"
    ) {
      return error.reasonCode;
    }
    return "integrity_error";
  }
  if (
    error instanceof ProviderProtocolError ||
    error instanceof ProviderResponseTooLargeError
  ) {
    return "provider_protocol_error";
  }
  if (error instanceof ProviderRequestError) return "provider_request_error";
  return undefined;
}
function terminalReasonForError(
  error: unknown,
  owner: AgentRuntimeOwner | undefined,
  agentRuntimeActive = owner !== undefined,
): AgentTerminalReason {
  if (!agentRuntimeActive) return "failed";
  return publicTerminalCodeForError(error) ?? "failed";
}

function createPublicAgentError(
  code: AgentPublicErrorCode,
  failure?: AgentLedgerFailure,
): AgentPublicErrorV1 {
  return {
    version: 1,
    code,
    category: terminalErrorCategory(code),
    ...(failure
      ? {
          budget: {
            id: failure.context.id,
            limit: failure.context.limit,
            observed: failure.context.observed,
          },
        }
      : {}),
    retryable: code === "provider_unavailable" || code === "provider_request_error",
  };
}

function terminalAgentError(
  owner: AgentRuntimeOwner | undefined,
  reason: AgentTerminalReason,
  agentRuntimeActive = owner !== undefined,
  unattachedFailure?: AgentLedgerFailure,
  unattachedError?: AgentPublicErrorV1,
): AgentPublicErrorV1 | undefined {
  if (!agentRuntimeActive) return undefined;
  const failure = owner?.ledger.failure ?? unattachedFailure;
  if (!failure && unattachedError) return unattachedError;
  const failureCode = failure?.code;
  const code: AgentPublicErrorCode | undefined =
    failureCode ??
    (reason === "stopped" ? "cancelled" :
      reason === "cancelled" ? "cancelled" :
        reason === "completed" || reason === "completed_at_tool_budget"
          ? undefined
          : reason === "failed" ? "internal_error" : reason);
  return code ? createPublicAgentError(code, failure) : undefined;
}

/**
 * Only errors with a closed public code are promoted into AgentError. Unknown
 * owner-construction failures still surface through the ordinary generation
 * error path instead of being silently classified here.
 */
function publicAgentErrorForFailure(error: unknown): AgentPublicErrorV1 | undefined {
  const code = publicTerminalCodeForError(error);
  return code
    ? createPublicAgentError(
        code,
        error instanceof AgentLedgerFailure ? error : undefined,
      )
    : undefined;
}

/**
 * One terminal coordinator per generation. Feature-active generations attach
 * their AgentTurnLedger; feature-inactive generations retain the same CAS
 */
class GenerationTerminalCoordinator {
  readonly generationId: string;
  readonly controller: AbortController;
  readonly #userId: string;
  readonly #chatId: string;
  #owner: AgentRuntimeOwner | undefined;
  #agentRuntimeActive = false;
  #unattachedAgentError: AgentPublicErrorV1 | undefined;
  #unattachedAgentFailure: AgentLedgerFailure | undefined;
  #reason: AgentTerminalReason | null = null;
  #eventEmitted = false;
  #pendingProjection: pool.PoolTerminalProjection | undefined;
  #pendingCompletedContent: string | undefined;
  #runLoopProjectionReady = true;
  #activityPersisted = false;
  #persistedActivitySnapshot: AgentActivitySnapshotV1 | undefined;

  constructor(
    generationId: string,
    controller: AbortController,
    userId: string,
    chatId: string,
  ) {
    this.generationId = generationId;
    this.controller = controller;
    this.#userId = userId;
    this.#chatId = chatId;
  }

  get reason(): AgentTerminalReason | null {
    return this.#reason;
  }

  get agentRuntimeActive(): boolean {
    return this.#agentRuntimeActive;
  }

  markAgentRuntimeActive(): void {
    this.#agentRuntimeActive = true;
  }

  recordAgentRuntimeFailure(error: unknown): void {
    if (!this.#agentRuntimeActive || this.#owner) return;
    if (error instanceof AgentLedgerFailure) {
      this.#unattachedAgentFailure ??= error;
      return;
    }
    const normalized = publicAgentErrorForFailure(error);
    if (normalized) this.#unattachedAgentError ??= normalized;
  }

  attachRuntimeOwner(owner: AgentRuntimeOwner): void {
    this.markAgentRuntimeActive();
    this.#owner = owner;
    if (this.#reason !== null) {
      if (owner.ledger.terminal === null) {
        owner.ledger.tryTerminate(this.#reason);
      }
      if (!this.controller.signal.aborted) {
        this.controller.abort(new DOMException(this.#reason, "AbortError"));
      }
      return;
    }
    const ledgerReason = owner.ledger.terminal;
    if (ledgerReason !== null) {
      this.#reason = ledgerReason;
      if (!this.controller.signal.aborted) {
        this.controller.abort(new DOMException(ledgerReason, "AbortError"));
      }
    }
  }

  tryTerminate(reason: AgentTerminalReason): boolean {
    if (this.#reason !== null) return false;

    if (!this.#owner) {
      this.#reason = reason;
      if (!this.controller.signal.aborted) {
        this.controller.abort(new DOMException(reason, "AbortError"));
      }
      return true;
    }

    const ledgerReason = this.#owner.ledger.terminal;
    if (ledgerReason !== null) {
      this.#reason = ledgerReason;
      if (!this.controller.signal.aborted) {
        this.controller.abort(new DOMException(ledgerReason, "AbortError"));
      }
      return true;
    }
    if (!this.#owner.ledger.tryTerminate(reason)) {
      const racedReason = this.#owner.ledger.terminal;
      if (racedReason === null) return false;
      this.#reason = racedReason;
      if (!this.controller.signal.aborted) {
        this.controller.abort(new DOMException(racedReason, "AbortError"));
      }
      return true;
    }

    this.#reason = this.#owner.ledger.terminal ?? reason;
    if (!this.controller.signal.aborted) {
      this.controller.abort(new DOMException(this.#reason, "AbortError"));
    }
    return true;
  }

  markRunLoopStarted(): void {
    this.#runLoopProjectionReady = false;
  }

  markRunLoopReconciled(): void {
    this.#runLoopProjectionReady = true;
    this.#emitPendingProjection();
  }

  #persistActivity(
    status: AgentActivityLifecycle,
    agentError?: AgentPublicErrorV1,
  ): AgentActivitySnapshotV1 | undefined {
    if (!this.#agentRuntimeActive) return undefined;
    if (this.#activityPersisted && this.#persistedActivitySnapshot) {
      return this.#persistedActivitySnapshot;
    }
    const entry = pool.getPoolEntry(this.generationId);
    const snapshot: AgentActivitySnapshotV1 = this.#owner
      ? this.#owner.ledger.activitySnapshot(status, agentError?.code)
      : {
          version: 1,
          rootId: this.generationId,
          nodes: [],
          omittedNodeCount: 0,
          errorCounts: agentError ? { [agentError.code]: 1 } : {},
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            toolCalls: 0,
            childInvocations: 0,
          },
          status,
          ...(agentError ? { terminalErrorCode: agentError.code } : {}),
        };
    this.#persistedActivitySnapshot = snapshot;
    this.#activityPersisted = true;
    persistTerminalAgentActivityRun({
      userId: entry?.userId ?? this.#userId,
      chatId: entry?.chatId ?? this.#chatId,
      generationId: this.generationId,
      targetMessageId: entry?.targetMessageId ?? null,
      targetSwipeId: entry?.targetSwipeId ?? null,
      snapshot,
      status,
    });
    return snapshot;
  }

  claimWithoutPool(
    reason: AgentTerminalReason,
    status: AgentActivityLifecycle = "failed",
  ): boolean {
    if (!this.tryTerminate(reason)) return false;
    this.#persistActivity(
      status,
      terminalAgentError(
        this.#owner,
        this.#reason ?? reason,
        this.#agentRuntimeActive,
        this.#unattachedAgentFailure,
        this.#unattachedAgentError,
      ),
    );
    return true;
  }

  #normalizePoolProjection(
    projection: pool.PoolTerminalProjection,
  ): pool.PoolTerminalProjection {
    const winningReason = this.#reason ?? "failed";
    const isStopped =
      winningReason === "stopped" || winningReason === "cancelled";
    const isCompleted =
      winningReason === "completed" ||
      winningReason === "completed_at_tool_budget";
    if (isStopped) return { status: "stopped" };
    if (isCompleted) {
      return {
        status: "completed",
        ...(projection.messageId !== undefined
          ? { messageId: projection.messageId }
          : {}),
      };
    }
    return {
      status: "error",
      error: projection.error ?? winningReason,
      ...(projection.messageId !== undefined
        ? { messageId: projection.messageId }
        : {}),
    };
  }

  #queuePoolProjection(
    projection: pool.PoolTerminalProjection,
    completedContent?: string,
  ): void {
    const normalized = this.#normalizePoolProjection(projection);
    if (normalized.status === "completed" && completedContent !== undefined) {
      this.#pendingCompletedContent = completedContent;
    }
    const previous = this.#pendingProjection;
    this.#pendingProjection = previous
      ? {
          ...previous,
          ...(normalized.messageId !== undefined
            ? { messageId: normalized.messageId }
            : {}),
          ...(previous.error === undefined && normalized.error !== undefined
            ? { error: normalized.error }
            : {}),
        }
      : normalized;
  }

  #emitPendingProjection(
    allowBeforeRunLoopReconciliation = false,
  ): void {
    if (
      (!this.#runLoopProjectionReady &&
        !allowBeforeRunLoopReconciliation) ||
      !this.#pendingProjection ||
      this.#eventEmitted
    ) {
      return;
    }
    const projection = this.#pendingProjection;
    const completedContent = this.#pendingCompletedContent;
    this.#pendingProjection = undefined;
    this.#pendingCompletedContent = undefined;
    const projected = pool.projectPoolTerminal(
      this.generationId,
      projection,
    );
    if (projected || this.hasTerminalPoolProjection()) {
      this.emitPoolProjection(projection, completedContent);
    }
  }

  poolOwner(): pool.PoolTerminalOwner {
    return {
      tryTerminate: (reason) =>
        this.tryTerminate(
          reason === "completed"
            ? "completed"
            : reason === "stopped"
              ? "stopped"
              : reason === "timeout"
                ? "timeout"
                : "failed",
        ),
      projectTerminal: (projection) => {
        this.#queuePoolProjection(projection);
        this.#emitPendingProjection(!this.#agentRuntimeActive);
        return true;
      },
    };
  }

  claimAndProject(
    reason: AgentTerminalReason,
    projection: pool.PoolTerminalProjection,
    completedContent?: string,
  ): boolean {
    const claimed = this.tryTerminate(reason);
    if (!claimed && this.#reason === null) return false;
    this.#queuePoolProjection(projection, completedContent);
    this.#emitPendingProjection();
    return true;
  }

  hasTerminalPoolProjection(): boolean {
    const entry = pool.getPoolEntry(this.generationId);
    return (
      !entry ||
      entry.status === "completed" ||
      entry.status === "stopped" ||
      entry.status === "error"
    );
  }

  ensurePoolProjection(): boolean {
    if (this.hasTerminalPoolProjection()) return true;
    const winningReason = this.#reason ?? "failed";
    this.claimAndProject(winningReason, {
      status: "error",
      error: winningReason,
    });
    return this.hasTerminalPoolProjection();
  }
  emitPoolProjection(
    projection: pool.PoolTerminalProjection,
    completedContent?: string,
  ): void {
    if (this.#eventEmitted) return;
    this.#eventEmitted = true;
    const winningReason = this.#reason ?? "failed";
    const terminalStatus: AgentActivityLifecycle =
      projection.status === "stopped"
        ? "cancelled"
        : winningReason === "timeout" ||
            winningReason === "root_wall_clock_limit_exceeded"
          ? "timed_out"
          : projection.status === "completed"
            ? "completed"
            : "failed";
    const agentError = terminalAgentError(
      this.#owner,
      winningReason,
      this.#agentRuntimeActive,
      this.#unattachedAgentFailure,
      this.#unattachedAgentError,
    );
    const agentActivity = this.#persistActivity(terminalStatus, agentError);
    const entry = pool.getPoolEntry(this.generationId);
    const content =
      projection.status === "completed" && completedContent !== undefined
        ? completedContent
        : (entry?.content ?? "");
    const chatId = entry?.chatId ?? this.#chatId;
    const userId = entry?.userId ?? this.#userId;
    const target = {
      ...(entry?.requestAuthorityId ? { requestAuthorityId: entry.requestAuthorityId } : {}),
      ...(entry?.targetMessageId ? { targetMessageId: entry.targetMessageId } : {}),
      ...(entry?.targetSwipeId !== undefined
        ? { targetSwipeId: entry.targetSwipeId }
        : {}),
    };
    if (projection.status === "stopped") {
      eventBus.emit(
        EventType.GENERATION_STOPPED,
        {
          generationId: this.generationId,
          chatId,
          content,
          ...target,
          ...(agentActivity ? { agentActivity } : {}),
          ...(agentError ? { agentError } : {}),
        },
        userId,
      );
      return;
    }
    eventBus.emit(
      EventType.GENERATION_ENDED,
      {
        generationId: this.generationId,
        chatId,
        ...(projection.messageId ? { messageId: projection.messageId } : {}),
        content,
        ...target,
        ...(projection.error ? { error: projection.error } : {}),
        ...(agentActivity ? { agentActivity } : {}),
        ...(agentError ? { agentError } : {}),
      },
      userId,
    );
  }
}

// Track active generations for stop support
const activeGenerations = new Map<
  string,
  {
    controller: AbortController;
    terminal: GenerationTerminalCoordinator;
    userId: string;
    chatId: string;
    startedAt: number;
    /** Timestamp of the most recently received content or reasoning token. */
    lastTokenAt: number;
    /** Timestamp of the most recent provider/tool/activity progress. */
    lastActivityAt: number;
    /** Resolves when the generation's streaming continuation finishes
     *  (success, error, or abort). Used by the per-chat lock to wait for
     *  teardown before starting a replacement generation — this prevents
     *  two HTTP operations (the old cancel and the new connect) from
     *  overlapping on Bun's HTTPThread, which has a known null-callback
     *  race on concurrent cancel+start.
     *  Created up-front as a deferred promise so it's always present — even
     *  during the setup phase before the streaming IIFE starts. */
    completion: Promise<void>;
  }

>();

function claimGenerationTerminal(
  generationId: string,
  reason: AgentTerminalReason,
  projection: pool.PoolTerminalProjection,
  completedContent?: string,
): boolean {
  const entry = activeGenerations.get(generationId);
  return (
    entry?.terminal.claimAndProject(reason, projection, completedContent) ??
    false
  );
}

// Per-chat generation lock: prevents concurrent generations (including council) in the same chat.
// Keyed by `${userId}:${chatId}` → generationId. Registered BEFORE council execution so that
// a second request for the same chat will abort the in-flight one (including its council tools).
const activeChatGenerations = new Map<string, string>();
type PendingGenerationRequestAuthority = {
  readonly userId: string;
  readonly chatId: string;
  readonly authorityId: string;
  readonly controller: AbortController;
  mode?: "response" | "agentic";
  sourceAborted: boolean;
  stopRequested: boolean;
  cancellationResult?: Promise<GenerationStopResult>;
  generationId?: string;
};

const pendingGenerationRequestAuthorities = new Map<string, PendingGenerationRequestAuthority>();
const stoppedGenerationRequestAuthorities = new Map<string, Map<string, number>>();
const admittedGenerationRequestAuthorities = new Map<string, string>();
const admittedGenerationRequestAuthorityByGeneration = new Map<string, string>();
type AcknowledgedGenerationRequestAuthorityReceipt = {
  readonly generationId: string;
  terminalExpiresAt: number | null;
};
const acknowledgedGenerationRequestAuthorities = new Map<string, AcknowledgedGenerationRequestAuthorityReceipt>();
const ACKNOWLEDGED_DISPATCH_RETRY_GRACE_MS = 60_000;
let nextAcknowledgedGenerationRequestAuthorityExpiry = Number.POSITIVE_INFINITY;
interface AcknowledgedReceiptCleanupScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
const SYSTEM_ACKNOWLEDGED_RECEIPT_CLEANUP_SCHEDULER: AcknowledgedReceiptCleanupScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
let acknowledgedReceiptCleanupScheduler = SYSTEM_ACKNOWLEDGED_RECEIPT_CLEANUP_SCHEDULER;
let acknowledgedReceiptCleanupHandle: unknown | null = null;
let acknowledgedReceiptCleanupScheduledAt = Number.POSITIVE_INFINITY;
const STOPPED_REQUEST_AUTHORITY_RECEIPT_GRACE_MS = 60_000;
const MAX_STOPPED_REQUEST_AUTHORITY_RECEIPTS_PER_USER = 2_048;
let stoppedReceiptCleanupScheduler: AcknowledgedReceiptCleanupScheduler = SYSTEM_ACKNOWLEDGED_RECEIPT_CLEANUP_SCHEDULER;
let stoppedReceiptCleanupHandle: unknown | null = null;
let stoppedReceiptCleanupScheduledAt = Number.POSITIVE_INFINITY;
let nextStoppedRequestAuthorityExpiry = Number.POSITIVE_INFINITY;
const REQUEST_AUTHORITY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function generationRequestAuthorityKey(userId: string, chatId: string, authorityId: string): string {
  return JSON.stringify([userId, chatId, authorityId]);
}
function generationRequestOwnerKey(userId: string, chatId: string, generationId: string): string {
  return JSON.stringify([userId, chatId, generationId]);
}

export function resolveGenerationRequestAuthority(
  userId: string,
  chatId: string,
  generationId: string,
): string | null {
  if (!userId || !chatId || !generationId) return null;
  for (const reservation of pendingGenerationRequestAuthorities.values()) {
    if (
      reservation.userId === userId
      && reservation.chatId === chatId
      && reservation.generationId === generationId
    ) return reservation.authorityId;
  }
  return admittedGenerationRequestAuthorityByGeneration.get(
    generationRequestOwnerKey(userId, chatId, generationId),
  ) ?? null;
}

function normalizeGenerationRequestAuthorityId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return REQUEST_AUTHORITY_ID_PATTERN.test(normalized) ? normalized : null;
}

function scheduleStoppedGenerationRequestAuthorityCleanup(): void {
  const expiry = nextStoppedRequestAuthorityExpiry;
  if (stoppedReceiptCleanupHandle !== null && stoppedReceiptCleanupScheduledAt === expiry) return;
  if (stoppedReceiptCleanupHandle !== null) {
    stoppedReceiptCleanupScheduler.clearTimeout(stoppedReceiptCleanupHandle);
    stoppedReceiptCleanupHandle = null;
  }
  stoppedReceiptCleanupScheduledAt = expiry;
  if (!Number.isFinite(expiry)) return;
  stoppedReceiptCleanupHandle = stoppedReceiptCleanupScheduler.setTimeout(() => {
    stoppedReceiptCleanupHandle = null;
    stoppedReceiptCleanupScheduledAt = Number.POSITIVE_INFINITY;
    pruneExpiredStoppedGenerationRequestAuthorities(stoppedReceiptCleanupScheduler.now());
  }, Math.max(0, expiry - stoppedReceiptCleanupScheduler.now()));
}

function pruneExpiredStoppedGenerationRequestAuthorities(
  now = stoppedReceiptCleanupScheduler.now(),
): void {
  if (now < nextStoppedRequestAuthorityExpiry) return;
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const [userId, receipts] of stoppedGenerationRequestAuthorities) {
    for (const [key, expiresAt] of receipts) {
      if (expiresAt <= now) receipts.delete(key);
      else nextExpiry = Math.min(nextExpiry, expiresAt);
    }
    if (receipts.size === 0) stoppedGenerationRequestAuthorities.delete(userId);
  }
  nextStoppedRequestAuthorityExpiry = nextExpiry;
  scheduleStoppedGenerationRequestAuthorityCleanup();
}

function rememberStoppedGenerationRequestAuthority(
  userId: string,
  key: string,
  allowOwnerOverflow = false,
  now = stoppedReceiptCleanupScheduler.now(),
): boolean {
  pruneExpiredStoppedGenerationRequestAuthorities(now);
  let receipts = stoppedGenerationRequestAuthorities.get(userId);
  const existing = receipts?.has(key) ?? false;
  if (!existing && !allowOwnerOverflow
    && (receipts?.size ?? 0) >= MAX_STOPPED_REQUEST_AUTHORITY_RECEIPTS_PER_USER) return false;
  if (!receipts) {
    receipts = new Map();
    stoppedGenerationRequestAuthorities.set(userId, receipts);
  }
  const expiresAt = now + STOPPED_REQUEST_AUTHORITY_RECEIPT_GRACE_MS;
  receipts.set(key, expiresAt);
  nextStoppedRequestAuthorityExpiry = Math.min(nextStoppedRequestAuthorityExpiry, expiresAt);
  scheduleStoppedGenerationRequestAuthorityCleanup();
  return true;
}

function hasStoppedGenerationRequestAuthority(
  userId: string,
  key: string,
  now = stoppedReceiptCleanupScheduler.now(),
): boolean {
  pruneExpiredStoppedGenerationRequestAuthorities(now);
  return stoppedGenerationRequestAuthorities.get(userId)?.has(key) ?? false;
}

function clearStoppedGenerationRequestAuthorities(): void {
  if (stoppedReceiptCleanupHandle !== null) {
    stoppedReceiptCleanupScheduler.clearTimeout(stoppedReceiptCleanupHandle);
    stoppedReceiptCleanupHandle = null;
  }
  stoppedGenerationRequestAuthorities.clear();
  nextStoppedRequestAuthorityExpiry = Number.POSITIVE_INFINITY;
  stoppedReceiptCleanupScheduledAt = Number.POSITIVE_INFINITY;
}

function configureStoppedReceiptCleanupScheduler(
  scheduler: AcknowledgedReceiptCleanupScheduler = SYSTEM_ACKNOWLEDGED_RECEIPT_CLEANUP_SCHEDULER,
): void {
  if (stoppedReceiptCleanupHandle !== null) {
    stoppedReceiptCleanupScheduler.clearTimeout(stoppedReceiptCleanupHandle);
    stoppedReceiptCleanupHandle = null;
  }
  stoppedReceiptCleanupScheduler = scheduler;
  stoppedReceiptCleanupScheduledAt = Number.POSITIVE_INFINITY;
  nextStoppedRequestAuthorityExpiry = Number.POSITIVE_INFINITY;
  for (const receipts of stoppedGenerationRequestAuthorities.values()) {
    for (const expiresAt of receipts.values()) {
      nextStoppedRequestAuthorityExpiry = Math.min(nextStoppedRequestAuthorityExpiry, expiresAt);
    }
  }
  scheduleStoppedGenerationRequestAuthorityCleanup();
}

function scheduleAcknowledgedGenerationRequestAuthorityCleanup(): void {
  const expiry = nextAcknowledgedGenerationRequestAuthorityExpiry;
  if (acknowledgedReceiptCleanupHandle !== null && acknowledgedReceiptCleanupScheduledAt === expiry) return;
  if (acknowledgedReceiptCleanupHandle !== null) {
    acknowledgedReceiptCleanupScheduler.clearTimeout(acknowledgedReceiptCleanupHandle);
    acknowledgedReceiptCleanupHandle = null;
  }
  acknowledgedReceiptCleanupScheduledAt = expiry;
  if (!Number.isFinite(expiry)) return;
  acknowledgedReceiptCleanupHandle = acknowledgedReceiptCleanupScheduler.setTimeout(() => {
    acknowledgedReceiptCleanupHandle = null;
    acknowledgedReceiptCleanupScheduledAt = Number.POSITIVE_INFINITY;
    pruneExpiredAcknowledgedGenerationRequestAuthorities(acknowledgedReceiptCleanupScheduler.now());
  }, Math.max(0, expiry - acknowledgedReceiptCleanupScheduler.now()));
}

function pruneExpiredAcknowledgedGenerationRequestAuthorities(
  now = acknowledgedReceiptCleanupScheduler.now(),
): void {
  if (now < nextAcknowledgedGenerationRequestAuthorityExpiry) return;
  let nextExpiry = Number.POSITIVE_INFINITY;
  for (const [key, receipt] of acknowledgedGenerationRequestAuthorities) {
    if (receipt.terminalExpiresAt === null) continue;
    if (receipt.terminalExpiresAt <= now) acknowledgedGenerationRequestAuthorities.delete(key);
    else nextExpiry = Math.min(nextExpiry, receipt.terminalExpiresAt);
  }
  nextAcknowledgedGenerationRequestAuthorityExpiry = nextExpiry;
  scheduleAcknowledgedGenerationRequestAuthorityCleanup();
}

function clearAcknowledgedGenerationRequestAuthorities(): void {
  if (acknowledgedReceiptCleanupHandle !== null) {
    acknowledgedReceiptCleanupScheduler.clearTimeout(acknowledgedReceiptCleanupHandle);
    acknowledgedReceiptCleanupHandle = null;
  }
  acknowledgedGenerationRequestAuthorities.clear();
  nextAcknowledgedGenerationRequestAuthorityExpiry = Number.POSITIVE_INFINITY;
  acknowledgedReceiptCleanupScheduledAt = Number.POSITIVE_INFINITY;
}

function configureAcknowledgedReceiptCleanupScheduler(
  scheduler = SYSTEM_ACKNOWLEDGED_RECEIPT_CLEANUP_SCHEDULER,
): void {
  if (acknowledgedReceiptCleanupHandle !== null) {
    acknowledgedReceiptCleanupScheduler.clearTimeout(acknowledgedReceiptCleanupHandle);
    acknowledgedReceiptCleanupHandle = null;
  }
  acknowledgedReceiptCleanupScheduler = scheduler;
  acknowledgedReceiptCleanupScheduledAt = Number.POSITIVE_INFINITY;
  nextAcknowledgedGenerationRequestAuthorityExpiry = Number.POSITIVE_INFINITY;
  for (const receipt of acknowledgedGenerationRequestAuthorities.values()) {
    if (receipt.terminalExpiresAt !== null) {
      nextAcknowledgedGenerationRequestAuthorityExpiry = Math.min(
        nextAcknowledgedGenerationRequestAuthorityExpiry,
        receipt.terminalExpiresAt,
      );
    }
  }
  scheduleAcknowledgedGenerationRequestAuthorityCleanup();
}

function rememberAcknowledgedGenerationRequestAuthority(
  key: string,
  generationId: string,
  now = acknowledgedReceiptCleanupScheduler.now(),
): void {
  pruneExpiredAcknowledgedGenerationRequestAuthorities(now);
  acknowledgedGenerationRequestAuthorities.set(key, { generationId, terminalExpiresAt: null });
  // This is deliberately a soft cap. Exact live receipts and terminal receipts
  // inside the transport retry grace are protocol state and cannot be evicted.
}

function acknowledgedGenerationRequestAuthorityMatches(
  key: string,
  generationId: string,
  now = acknowledgedReceiptCleanupScheduler.now(),
): boolean {
  pruneExpiredAcknowledgedGenerationRequestAuthorities(now);
  return acknowledgedGenerationRequestAuthorities.get(key)?.generationId === generationId;
}

function markAcknowledgedGenerationRequestAuthorityTerminal(
  key: string,
  generationId: string,
  now = acknowledgedReceiptCleanupScheduler.now(),
): void {
  const receipt = acknowledgedGenerationRequestAuthorities.get(key);
  if (receipt?.generationId === generationId) {
    receipt.terminalExpiresAt = now + ACKNOWLEDGED_DISPATCH_RETRY_GRACE_MS;
    nextAcknowledgedGenerationRequestAuthorityExpiry = Math.min(
      nextAcknowledgedGenerationRequestAuthorityExpiry,
      receipt.terminalExpiresAt,
    );
    scheduleAcknowledgedGenerationRequestAuthorityCleanup();
  }
}

function rememberAdmittedGenerationRequestAuthority(
  key: string,
  userId: string,
  chatId: string,
  authorityId: string,
  generationId: string,
): void {
  if (!getActiveAgenticGenerationContext(userId, generationId)) return;
  const ownerKey = generationRequestOwnerKey(userId, chatId, generationId);
  admittedGenerationRequestAuthorities.set(key, generationId);
  admittedGenerationRequestAuthorityByGeneration.set(ownerKey, authorityId);
  const forgetTerminalOwner = () => {
    if (admittedGenerationRequestAuthorities.get(key) === generationId) {
      admittedGenerationRequestAuthorities.delete(key);
    }
    if (admittedGenerationRequestAuthorityByGeneration.get(ownerKey) === authorityId) {
      admittedGenerationRequestAuthorityByGeneration.delete(ownerKey);
    }
    markAcknowledgedGenerationRequestAuthorityTerminal(key, generationId);
  };
  void waitForAgenticGeneration(generationId).then(forgetTerminalOwner, forgetTerminalOwner);
}

export const __generationRequestAuthorityTesting = Object.freeze({
  retainedOwnerCount: (): number => admittedGenerationRequestAuthorities.size,
  acknowledgedReceiptCount: (): number => acknowledgedGenerationRequestAuthorities.size,
  acknowledgedReceiptRetryGraceMs: ACKNOWLEDGED_DISPATCH_RETRY_GRACE_MS,
  stoppedReceiptGraceMs: STOPPED_REQUEST_AUTHORITY_RECEIPT_GRACE_MS,
  stoppedReceiptCapacityPerUser: MAX_STOPPED_REQUEST_AUTHORITY_RECEIPTS_PER_USER,
  configureStoppedReceiptCleanupScheduler,
  clearStoppedReceipts: clearStoppedGenerationRequestAuthorities,
  stoppedReceiptCount: (userId: string): number => stoppedGenerationRequestAuthorities.get(userId)?.size ?? 0,
  hasStoppedReceipt: (userId: string, chatId: string, authorityId: string): boolean => (
    hasStoppedGenerationRequestAuthority(userId, generationRequestAuthorityKey(userId, chatId, authorityId))
  ),
  retainAdmittedOwner: (
    userId: string,
    chatId: string,
    authorityId: string,
    generationId: string,
  ): void => {
    const normalizedAuthorityId = normalizeGenerationRequestAuthorityId(authorityId);
    if (!normalizedAuthorityId) throw new Error("Invalid request authority ID.");
    admittedGenerationRequestAuthorities.set(
      generationRequestAuthorityKey(userId, chatId, normalizedAuthorityId),
      generationId,
    );
    admittedGenerationRequestAuthorityByGeneration.set(
      generationRequestOwnerKey(userId, chatId, generationId),
      normalizedAuthorityId,
    );
  },
  clearAdmittedOwners: (): void => {
    admittedGenerationRequestAuthorities.clear();
    admittedGenerationRequestAuthorityByGeneration.clear();
  },
  configureAcknowledgedReceiptCleanupScheduler,
  clearAcknowledgedReceipts: clearAcknowledgedGenerationRequestAuthorities,
  hasAcknowledgedReceipt: (
    userId: string,
    chatId: string,
    authorityId: string,
    generationId: string,
  ): boolean => acknowledgedGenerationRequestAuthorityMatches(
    generationRequestAuthorityKey(userId, chatId, authorityId),
    generationId,
  ),
  retainAcknowledgedReceipt: (
    userId: string,
    chatId: string,
    authorityId: string,
    generationId: string,
  ): void => rememberAcknowledgedGenerationRequestAuthority(
    generationRequestAuthorityKey(userId, chatId, authorityId),
    generationId,
  ),
  forgetAcknowledgedReceipt: (userId: string, chatId: string, authorityId: string): void => {
    acknowledgedGenerationRequestAuthorities.delete(generationRequestAuthorityKey(userId, chatId, authorityId));
  },
});

function setGenerationRequestAuthorityMode(
  reservation: PendingGenerationRequestAuthority | undefined,
  mode: "response" | "agentic",
): void {
  if (!reservation) return;
  reservation.mode = mode;
  if (mode === "response" && (reservation.sourceAborted || reservation.stopRequested)) {
    reservation.controller.abort(new DOMException("Generation stopped", "AbortError"));
  }
}

function throwIfGenerationRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Generation stopped", "AbortError");
}
type ChatModeReservation = {
  readonly mode: "response" | "agentic";
  readonly ownerId: string;
  readonly done?: Promise<void>;
};
// Admission is shared by Response and Agentic. A reservation is installed
// synchronously before either mode awaits preflight, so a concurrent request
// cannot enter the other mode between its checks and durable registration.
const chatModeReservations = new Map<string, ChatModeReservation>();

function chatModeKey(userId: string, chatId: string): string {
  return `${userId}:${chatId}`;
}

function releaseChatModeReservation(
  userId: string,
  chatId: string,
  ownerId: string,
): void {
  const key = chatModeKey(userId, chatId);
  if (chatModeReservations.get(key)?.ownerId === ownerId) {
    chatModeReservations.delete(key);
  }
}

async function reserveChatMode(
  userId: string,
  chatId: string,
  mode: "response" | "agentic",
  ownerId: string,
  done?: Promise<void>,
): Promise<void> {
  const key = chatModeKey(userId, chatId);
  const previous = chatModeReservations.get(key);
  chatModeReservations.set(key, { mode, ownerId, ...(done ? { done } : {}) });
  if (!previous || previous.ownerId === ownerId) return;
  if (previous.mode === "agentic") {
    const generationId = getActiveAgenticGenerationForChat(userId, chatId);
    if (generationId) {
      await requestAgenticChatCancellation(userId, chatId);
      await waitForAgenticGeneration(generationId);
    }
  } else {
    const entry = activeGenerations.get(previous.ownerId);
    if (entry) {
      entry.terminal.claimAndProject("stopped", { status: "stopped" });
      await entry.completion;
    }
  }
  if (previous.done) await previous.done;
}

function ownsChatModeReservation(
  userId: string,
  chatId: string,
  ownerId: string,
): boolean {
  return chatModeReservations.get(chatModeKey(userId, chatId))?.ownerId === ownerId;
}

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
    abortCleanup: () => void;
  }
>();

function clearPendingCouncilRetry(generationId: string): boolean {
  const pending = pendingCouncilRetries.get(generationId);
  if (!pending) return false;
  pending.resolve("continue");
  return true;
}

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
  pending.resolve(decision);
  return true;
}

/** Resolve connection profile by ID or fall back to the user's default. */
function resolveConnection(userId: string, connectionId?: string) {
  const connection = connectionsSvc.resolveConnection(userId, connectionId);
  if (!connection) {
    throw new Error("No connection profile found. Create one first.");
  }
  return connection;
}

function resolveActivePresetId(userId: string): string | undefined {
  return presetsSvc.reconcileActiveLoomPreset(userId) ?? undefined;
}

type ReasoningSettingsSnapshot = {
  apiReasoning?: boolean;
  reasoningEffort?: string;
  thinkingDisplay?: string;
  clearThinking?: boolean;
  replayThoughtSignatures?: boolean;
  customBody?: CustomBody;
} | null;

type CouncilResultCache = CachedCouncilResult & {
  fingerprint?: string;
  historicalDeliberationBlock?: string;
  /** Set when the council was active but no member survived their dice roll, so
   *  the run produced no results. Retained so a regen/swipe with retain enabled
   *  reuses the "stayed silent" outcome instead of re-rolling. */
  emptyRoll?: boolean;
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

function excludesLatestUserMessage(toolsSettings: unknown): boolean {
  return (toolsSettings as { excludeLatestUserMessage?: boolean })
    .excludeLatestUserMessage === true;
}

// Hash the council's view of the chat — the (id, content) pairs of the last
// `contextWindow` messages, the same slice council members consume in
// buildContextMessages. Mixed into the cache fingerprint so that editing or
// deleting any in-window message invalidates a stale deliberation block.
function hashCouncilContextMessages(
  messages: Message[],
  contextWindow: number,
  excludeLatestUserMessage: boolean,
): string {
  const window = selectCouncilContextMessages(
    messages,
    contextWindow,
    excludeLatestUserMessage,
  );
  const hasher = new Bun.CryptoHasher("sha256");
  for (const m of window) {
    hasher.update(m.id);
    hasher.update("\0");
    hasher.update(m.content);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

function buildCouncilCacheFingerprint(
  councilSettings: import("lumiverse-spindle-types").CouncilSettings,
  sidecarSettings: import("lumiverse-spindle-types").SidecarConfig,
  contextHash: string,
): string {
  return stableJson({
    version: 2,
    members: councilSettings.members.map((member) => ({
      id: member.id,
      itemId: member.itemId,
      role: member.role,
      chance: member.chance,
      tools: member.tools,
      toolHistoryRetention: (member as any).toolHistoryRetention ?? {},
    })),
    toolsSettings: {
      mode: councilSettings.toolsSettings.mode,
      timeoutMs: councilSettings.toolsSettings.timeoutMs,
      sidecarContextWindow: councilSettings.toolsSettings.sidecarContextWindow,
      excludeLatestUserMessage: excludesLatestUserMessage(councilSettings.toolsSettings),
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
    context: contextHash,
  });
}

function isReusableCouncilCache(
  cached: CouncilResultCache | undefined,
  fingerprint: string,
): boolean {
  if (!cached) return false;
  if (cached.fingerprint !== fingerprint) return false;
  // An empty-roll outcome (council was active but no member survived the dice
  // roll) is a valid result to retain — freezing "the council stayed silent"
  // keeps regens/swipes deterministic instead of re-rolling into a different
  // (or suddenly non-empty) outcome.
  if (cached.emptyRoll) return true;
  if (!cached.results?.length) return false;
  // Non-empty caches only ever store successful results (failures are dropped
  // at write time), so the run is reusable once the fingerprint matches.
  if (cached.results.some((result) => !result.success)) return false;
  return true;
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

/**
 * Resolve a per-request reasoning override down to a `ReasoningSettingsSnapshot`
 * that the existing inject/off-switch helpers can consume. Returns `undefined`
 * to mean "no override — use the inherited settings".
 */
function resolveReasoningOverride(
  override: GenerationReasoningOverrideDTO | undefined,
): ReasoningSettingsSnapshot | undefined {
  if (!override) return undefined;
  const source = override.source ?? "inherit";
  if (source === "inherit") return undefined;
  if (source === "off") {
    return { apiReasoning: false };
  }
  // source === "custom"
  return {
    apiReasoning: override.apiReasoning ?? true,
    reasoningEffort: override.effort ?? "auto",
    thinkingDisplay: override.thinkingDisplay ?? "auto",
  };
}

function applyEffectiveReasoningSettings(
  userId: string,
  connection: { metadata?: Record<string, any> | null },
  providerName: string,
  modelName: string | undefined,
  params: GenerationParameters,
  override?: GenerationReasoningOverrideDTO,
  includeCustomBody = false,
): void {
  const resolvedOverride = resolveReasoningOverride(override);
  const reasoningSettings =
    resolvedOverride !== undefined
      ? resolvedOverride
      : getEffectiveReasoningSettings(userId, connection);

  if (includeCustomBody) {
    applyCustomBodyParameters(params, reasoningSettings?.customBody);
  }

  if (reasoningSettings?.apiReasoning) {
    const effort = reasoningSettings.reasoningEffort || "auto";
    const requiresExplicitOnSwitch =
      providerName === "moonshot" || providerName === "zai";
    if (effort !== "auto" || requiresExplicitOnSwitch) {
      injectReasoningParams(
        params,
        providerName,
        effort,
        modelName,
        reasoningSettings.thinkingDisplay,
        reasoningSettings.clearThinking,
      );
    }
    if (
      reasoningSettings.replayThoughtSignatures === true &&
      (providerName === "google" || providerName === "google_vertex")
    ) {
      params._replay_thought_signatures = true;
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
): Promise<{ provider: LlmProvider; apiKey: string; apiUrl: string; connection: ConnectionProfile }> {
  const connection = connectionsSvc.resolveConnection(userId, connectionId);
  if (!connection) {
    throw new Error(`Connection not found: ${connectionId}`);
  }

  const provider = getProvider(connection.provider);
  if (!provider) {
    throw new Error(`Unknown provider: ${connection.provider}`);
  }

  const secretKeyName = connectionsSvc.connectionSecretKey(connection.id);
  const apiKey = await secretsSvc.getSecret(userId, secretKeyName);
  if (!apiKey && provider.capabilities.apiKeyRequired) {
    throw new Error(
      `No API key found for connection "${connection.name}". Add one via the connection settings.`,
    );
  }
  // Credential preflight. `apiKeyRequired` cannot carry this decision: it is a
  // per-provider constant, and `Custom (OpenAI-compatible)` legitimately serves
  // both a keyless llama.cpp on loopback and a keyed remote gateway. The signal
  // that IS per-connection and already durable is `has_api_key`, which the user
  // sets by storing a key and clears by removing one. Classification on the pair
  // (has_api_key, resolved secret):
  //   any   + non-empty          → authenticated, proceed (unchanged)
  //   false + empty, required    → existing descriptive error above, unchanged
  //   true  + empty/unreadable   → MISCONFIGURED: fail before any outbound call
  //   false + empty, not required→ intentionally keyless, proceed (unchanged)
  // The last row stays permissive on purpose: hard-failing it would break every
  // working keyless local endpoint. The `has_api_key = true` + empty row is
  // unambiguous — the profile asserts a credential exists and it cannot be
  // produced (deleted secret row, failed decrypt, profile duplicated without its
  // secret) — and it is exactly the case that would otherwise reach a provider
  // unauthenticated. Key NAME only; no credential value is read into the
  // message, logged, or persisted.
  if (!apiKey && connection.has_api_key) {
    throw new ConnectionCredentialError({
      connectionId: connection.id,
      connectionName: connection.name,
      provider: provider.displayName,
      secretKeyName,
    });
  }

  return {
    provider,
    apiKey: apiKey || "",
    apiUrl: connectionsSvc.resolveEffectiveApiUrl(connection),
    connection,
  };
}
type EffectiveAgentPresetResolution = {
  preset: Preset | null;
  binding: PresetProfileBinding | null;
};

type EffectiveAgentPresetResolvers = {
  resolveProfile: (
    userId: string,
    fallbackPresetId: string | null,
    chatId: string,
    characterId: string | null,
    options: {
      isGroup?: boolean;
      connectionId?: string | null;
      personaId?: string | null;
    },
  ) => { preset_id: string | null; binding: PresetProfileBinding | null };
  getPreset: (userId: string, presetId: string) => Preset | null;
};

function resolveEffectiveAgentPreset(
  args: {
    userId: string;
    chat: { id: string; metadata?: Record<string, any> | null; character_id?: string | null };
    connection: ConnectionProfile;
    presetId?: string;
    forcePresetId?: boolean;
    targetCharacterId?: string;
    personaId?: string;
  },
  resolvers: EffectiveAgentPresetResolvers = {
    resolveProfile: presetProfilesSvc.resolveProfile,
    getPreset: presetsSvc.getPreset,
  },
): EffectiveAgentPresetResolution {
  const noPreset = isNoPresetChatMetadata(args.chat.metadata);
  const requestedPresetId = noPreset
    ? null
    : args.presetId || args.connection.preset_id || null;
  const resolvedProfile =
    noPreset
      ? { preset_id: null, binding: null }
      : args.forcePresetId && args.presetId
        ? { preset_id: args.presetId, binding: null }
        : resolvers.resolveProfile(
            args.userId,
            requestedPresetId,
            args.chat.id,
            args.targetCharacterId || args.chat.character_id || null,
            {
              isGroup: args.chat.metadata?.group === true,
              connectionId: args.connection.id,
              personaId: args.personaId ?? null,
            },
          );
  return {
    preset: resolvedProfile.preset_id
      ? resolvers.getPreset(args.userId, resolvedProfile.preset_id)
      : null,
    binding: resolvedProfile.binding,
  };
}
function cloneEffectiveAgentPresetResolution(
  resolution: EffectiveAgentPresetResolution,
): EffectiveAgentPresetResolution {
  return {
    preset: resolution.preset ? structuredClone(resolution.preset) : null,
    binding: resolution.binding ? structuredClone(resolution.binding) : null,
  };
}
function assertRoomAgentIntrinsicsBeforeCouncil(args: {
  userId: string;
  chat: {
    id: string;
    metadata?: Record<string, any> | null;
  };
  preset: Preset | null | undefined;
  binding: PresetProfileBinding | null;
  generationType: string;
  impersonateMode?: string;
  targetCharacterId?: string;
}): void {
  if (typeof args.chat.metadata?.multiplayer_room_id !== "string" || !args.preset) {
    return;
  }
  const rawAgentConfig = args.preset.agent_config;
  if (rawAgentConfig === undefined) return;
  const config = presetsSvc.validateAgentConfigForExecution(
    args.userId,
    rawAgentConfig,
  );
  const blocks: PromptBlock[] = (args.preset.prompt_order ?? []).map(
    (block: PromptBlock) => ({ ...block }),
  );
  if (args.binding && blocks.length > 0) {
    presetProfilesSvc.applyProfileToBlocks(blocks, args.binding);
  }
  presetProfilesSvc.normalizeCategoryBlockStates(blocks);
  const effectiveBlocks = resolvePromptBlockPlacements(
    blocks,
    args.preset,
    args.binding?.prompt_variables,
  );
  reorderBlocksByPosition(effectiveBlocks);
  const character = args.targetCharacterId
    ? charactersSvc.getCharacter(args.userId, args.targetCharacterId)
    : null;
  const characterTags = Array.isArray(character?.tags) ? character.tags : [];
  const agentSkipsBlockTraversal =
    args.generationType === "impersonate" &&
    args.impersonateMode === "oneliner";
  const preflightBlocks: AgentIntrinsicBlockInput[] = effectiveBlocks.map(
    (block) => ({
      ...block,
      active:
        !agentSkipsBlockTraversal &&
        block.enabled === true &&
        !(block.marker === "category" && !block.content?.trim()) &&
        !(
          block.injectionTrigger &&
          block.injectionTrigger.length > 0 &&
          !block.injectionTrigger.includes(args.generationType)
        ) &&
        promptBlockMatchesCharacterTags(block.characterTagTrigger, characterTags),
    }),
  );
  const plan = preflightAgentIntrinsics(preflightBlocks, config);
  if (config.agentsEnabled && plan.executableIntrinsics.length > 0) {
    throw new AgentMultiplayerUnsupportedError();
  }
}

function prepareAgentProviderRequest(
  resolved: {
    provider: Pick<LlmProvider, "name">;
    connection: Pick<ConnectionProfile, "model" | "metadata">;
  },
  request: AgentProviderDispatchRequest,
  parameters: GenerationParameters,
): GenerationRequest {
  const cached = applyPromptCaching(
    {
      provider: resolved.provider.name,
      model: resolved.connection.model,
      metadata: resolved.connection.metadata,
    },
    {
      params: parameters,
      messages: request.messages,
      tools: request.tools,
    },
  );
  return {
    messages: cached.messages,
    model: resolved.connection.model,
    parameters: {
      ...cached.params,
      max_tokens: request.maxOutputTokens,
    },
    stream: false,
    tools: cached.tools,
    signal: request.signal,
    toolMode: request.toolMode,
    receiveLimitBytes: request.receiveLimitBytes,
    providerTransientCarrier: request.providerTransientCarrier,
  };
}
type AgentOutputTokenCounterResolver = (
  modelId: string,
) => Promise<ResolvedTokenCounter | null>;

async function observeAgentProviderOutput(
  modelId: string,
  response: GenerationResponse,
  signal: AbortSignal,
  resolveCounter: AgentOutputTokenCounterResolver = tokenizerSvc.resolveStrictCounter,
): Promise<number> {
  let resolved: ResolvedTokenCounter | null;
  try {
    resolved = await raceWithSignal(resolveCounter(modelId), signal);
  } catch {
    // A cancellation may win while strict-tokenizer resolution is still
    // pending. The response itself is already bounded by the provider receive
    // limit, so preserve its accounting evidence synchronously instead of
    // turning tokenizer teardown into a second failure.
    return observeOutputTokens(response);
  }
  if (!resolved) return observeOutputTokens(response);
  try {
    return observeOutputTokens(response, { countTokens: resolved.count });
  } catch (error) {
    if (error instanceof AgentAccountingFailure) throw error;
    return observeOutputTokens(response);
  }
}


async function dispatchAgentProvider(
  userId: string,
  request: AgentProviderDispatchRequest,
): Promise<AgentProviderDispatchResponse> {
  const connection = request.connection;
  if (!connection) throw new AgentRuntimeFailure("provider_unavailable");
  const provider = getProvider(connection.provider);
  if (!provider) throw new AgentRuntimeFailure("provider_unavailable");
  let apiKey = "";
  try {
    apiKey = await secretsSvc.getSecret(
      userId,
      connectionsSvc.connectionSecretKey(connection.concreteId),
    ) || "";
  } catch {
    throw new AgentRuntimeFailure("provider_unavailable");
  }
  if (request.tools?.length) {
    try {
      assertAgentToolCapability(provider);
    } catch (error) {
      if (error instanceof AgentToolCapabilityError) {
        throw new AgentRuntimeFailure(error.code);
      }
      throw error;
    }
  }
  const parameters: GenerationParameters = {
    max_tokens: request.maxOutputTokens,
  };
  const connectionView = { model: connection.model, metadata: {} };
  applyEffectiveReasoningSettings(
    userId,
    connectionView,
    provider.name,
    connection.model || undefined,
    parameters,
    undefined,
    true,
  );
  const providerRequest = prepareAgentProviderRequest(
    { provider, connection: connectionView },
    request,
    parameters,
  );
  try {
    const response = await provider.generate(
      apiKey,
      connection.endpoint,
      providerRequest,
    );
    let observedOutputTokens: number;
    let postResponseErrorCode: AgentPublicErrorCode | undefined;
    if (request.signal.aborted) {
      observedOutputTokens = observeOutputTokens(response);
      postResponseErrorCode = "cancelled";
    } else {
      try {
        observedOutputTokens = await observeAgentProviderOutput(
          connection.model,
          response,
          request.signal,
        );
      } catch (error) {
        observedOutputTokens = observeOutputTokens(response);
        if (error instanceof AgentAccountingFailure) {
          postResponseErrorCode = error.code;
        } else if (request.signal.aborted) {
          postResponseErrorCode = "cancelled";
        } else {
          throw error;
        }
      }
      if (request.signal.aborted) postResponseErrorCode = "cancelled";
    }
    return {
      ...response,
      observedOutputTokens,
      ...(postResponseErrorCode ? { postResponseErrorCode } : {}),
      providerTransientCarrier: response.providerTransientCarrier,
      toolContinuationMode: provider.capabilities.toolContinuationMode,
      supportsToolFinalization: provider.capabilities.supportsToolFinalization,
    };
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof AgentAccountingFailure) throw error;
    if (error instanceof ProviderProtocolError || error instanceof ProviderResponseTooLargeError) {
      throw new AgentRuntimeFailure("provider_protocol_error");
    }
    throw new AgentRuntimeFailure("provider_failed");
  }
}


/**
 * Shared prompt pipeline: build spindle context, assemble prompt, run
 * interceptors, apply post-processing, and merge parameters.
 */
async function runPromptPipeline(opts: {
  userId: string;
  userName?: string;
  generationId: string;
  chatId: string;
  connectionId?: string;
  model?: string;
  presetId?: string;
  forcePresetId?: boolean;
  effectivePresetSnapshot?: EffectiveAgentPresetResolution;
  personaId?: string;
  assemblySurface: AssemblySurfaceV1;
  personaAddonStates?: Record<string, boolean>;
  generationType: string;
  impersonateMode?: ImpersonateMode;
  impersonateInput?: string;
  userInput?: string;
  sourceUserMessageIds?: readonly string[];
  inputMessages?: LlmMessage[];
  inputParameters?: GenerationParameters;
  excludeMessageId?: string;
  rejectedSwipe?: string;
  continueMessageId?: string;
  continuePostfix?: string;
  targetCharacterId?: string;
  councilToolResults?: any[];
  councilNamedResults?: Record<string, string>;
  councilDeliberationBlock?: string;
  councilHistoricalDeliberationBlock?: string;
  precomputedVectorEntries?: PrecomputedWorldInfoVectorEntries;
  regenFeedback?: string;
  regenFeedbackPosition?: "system" | "user";
  regenFeedbackFormat?: string;
  signal?: AbortSignal;
  activityMessageId?: string;
  isDryRun?: boolean;
  onAgentRuntimeOwnerCreated?: (owner: AgentRuntimeOwner) => void;
  onAgentRuntimeRequired?: () => void;
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
    dryRun: opts.isDryRun === true,
    userId: opts.userId,
  };
  if (contextHandlerChain.count > 0) {
    const handled = (await contextHandlerChain.run(
      spindleContext,
      opts.userId,
      opts.signal,
    )) as SpindleContext | undefined;
    if (handled) spindleContext = handled;
    if (spindleContext.cancelGeneration === true) {
      throw new GenerationCancelledByExtensionError();
    }
  }

  // Build messages: use explicit messages if provided, otherwise assemble from preset
  let messages: LlmMessage[];
  let assembledParams: GenerationParameters = {};
  let assemblySurface: AssemblySurfaceV1 = opts.assemblySurface;
  let loomPromptInspection: LoomPromptInspectionV1 | undefined;
  let breakdown: AssemblyBreakdownEntry[] | undefined;
  let interceptorBreakdown: InterceptorBreakdownEntry[] | undefined;
  let assistantPrefill: string | undefined;
  let assistantReasoningPrefill: string | undefined;
  let activatedWorldInfo: ActivatedWorldInfoEntry[] | undefined;
  let spindleWorldInfoCaptures:
    | Record<string, ActivatedWorldInfoEntry[]>
    | undefined;
  let worldInfoStats: DryRunResult["worldInfoStats"] | undefined;
  let memoryStats: import("../llm/types").MemoryStats | undefined;
  let databankStats: import("../llm/types").DatabankStats | undefined;
  let contextClipStats: import("../llm/types").ContextClipStats | undefined;
  let deferredWiState:
    | { chatId: string; partial: Record<string, any> }
    | undefined;
  let agentRuntimeOwner: AgentRuntimeOwner | undefined;
  let macroEnv: import("../macros/types").MacroEnv | undefined;
  let trimIncompleteWords = false;

  let deliberationHandledByMacro = false;

  if (opts.inputMessages) {
    messages = opts.inputMessages;
  } else {
    const assemblyCtx = {
      userId: opts.userId,
      userName: opts.userName,
      generationId: opts.generationId,
      assemblySurface: opts.assemblySurface,
      dryRun: opts.isDryRun === true,
      chatId: opts.chatId,
      connectionId: opts.connectionId,
      presetId: opts.presetId,
      forcePresetId: opts.forcePresetId,
      effectivePresetSnapshot: opts.effectivePresetSnapshot,
      personaId: opts.personaId,
      personaAddonStates: opts.personaAddonStates,
      generationType: opts.generationType as GenerationType,
      impersonateMode: opts.impersonateMode,
      impersonateInput: opts.impersonateInput,
      userInput: opts.userInput,
      sourceUserMessageIds: opts.sourceUserMessageIds,
      continueMessageId: opts.continueMessageId,
      continuePostfix: opts.continuePostfix,
      targetCharacterId: opts.targetCharacterId,
      councilToolResults: opts.councilToolResults,
      councilNamedResults: opts.councilNamedResults,
      councilHistoricalDeliberationBlock: opts.councilHistoricalDeliberationBlock,
      precomputedVectorEntries: opts.precomputedVectorEntries,
      createAgentRuntimeOwner: (
        config: import("../types/agents").AgentConfigV2,
        rootConnection: ResolvedConcreteConnectionV1 | null,
      ) => {
        if (agentRuntimeOwner) return agentRuntimeOwner;
        opts.onAgentRuntimeRequired?.();
        const presetIdForBindings =
          opts.effectivePresetSnapshot?.preset?.id ?? opts.presetId ?? null;
        const normalizedProjection = presetIdForBindings
          ? getPresetAgentConfig(opts.userId, presetIdForBindings)
          : null;
        const frozenSlotConnections = new Map<
          string,
          ResolvedConcreteConnectionV1 | null
        >();
        for (const profile of config.profiles) {
          if (profile.connectionRef.kind !== "slot") continue;
          const slotId = profile.connectionRef.slotId;
          if (frozenSlotConnections.has(slotId)) continue;
          const binding = normalizedProjection?.bindings.find(
            (candidate) => candidate.slotId === slotId,
          );
          const connectionId =
            binding?.state === "ready" ? binding.connectionId : null;
          frozenSlotConnections.set(
            slotId,
            connectionId
              ? connectionsSvc.resolveConcreteConnectionV1(
                  opts.userId,
                  connectionId,
                )
              : null,
          );
        }
        agentRuntimeOwner = new AgentRuntimeOwner({
          generationId: opts.generationId,
          userId: opts.userId,
          config,
          rootConnection,
          resolveConnectionRef: (ref) =>
            ref.kind === "inherit_main"
              ? rootConnection
              : frozenSlotConnections.get(ref.slotId) ?? null,
          signal: opts.signal,
          dispatch: (request) => dispatchAgentProvider(opts.userId, request),
          onActivity: (activity) =>
            eventBus.emit(
              EventType.GENERATION_AGENT_ACTIVITY,
              {
                ...activity,
                ...(opts.activityMessageId
                  ? { messageId: opts.activityMessageId }
                  : {}),
              },
              opts.userId,
            ),
        });
        opts.onAgentRuntimeOwnerCreated?.(agentRuntimeOwner);
        return agentRuntimeOwner;
      },
      regenFeedback: opts.regenFeedback,
      regenFeedbackPosition: opts.regenFeedbackPosition,
      regenFeedbackFormat: opts.regenFeedbackFormat,
      skipPromptRegex: isPromptRegexChatOwned(opts.chatId, isExtensionRunning),
      signal: opts.signal,
    };

    let assemblyResult: Awaited<ReturnType<typeof assemblePrompt>>;

    if (canUsePromptAssemblyWorker()) {
      try {
        assemblyResult = await assemblePromptInWorker(assemblyCtx);
      } catch (err: unknown) {
        const errorName =
          err instanceof Error
            ? err.name
            : err &&
                typeof err === "object" &&
                "name" in err &&
                typeof err.name === "string"
              ? err.name
              : undefined;
        if (opts.signal?.aborted || errorName === "AbortError") throw err;
        if (!isMainProcessAssemblyRetryError(err)) throw err;
        console.warn(
          "[generate] Prompt assembly worker requested main-process retry:",
          err instanceof Error ? err.message : String(err),
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
    assistantReasoningPrefill = assemblyResult.assistantReasoningPrefill;
    activatedWorldInfo = assemblyResult.activatedWorldInfo;
    spindleWorldInfoCaptures = assemblyResult.spindleWorldInfoCaptures;
    worldInfoStats = assemblyResult.worldInfoStats;
    memoryStats = assemblyResult.memoryStats;
    assemblySurface = assemblyResult.assemblySurface;
    loomPromptInspection = assemblyResult.loomPromptInspection;
    databankStats = assemblyResult.databankStats;
    contextClipStats = assemblyResult.contextClipStats;
    deferredWiState = assemblyResult.deferredWiState;
    deliberationHandledByMacro = !!assemblyResult.deliberationHandledByMacro;
    macroEnv = assemblyResult.macroEnv;
    trimIncompleteWords = assemblyResult.trimIncompleteWords === true;
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
  delete spindleContext.__spindleWorldInfoCaptures;
  if (spindleWorldInfoCaptures) {
    spindleContext.__spindleWorldInfoCaptures = spindleWorldInfoCaptures;
  }

  // Run Spindle interceptor pipeline on assembled messages
  // The pipeline uses LlmMessageDTO (string-only content) — at this stage
  // multimodal parts have already been serialised so the cast is safe.
  let interceptorParameters: Record<string, unknown> | undefined;
  const seals = agentRuntimeOwner?.seals;
  const postHandlerValidator =
    seals && seals.size > 0
      ? (
          candidateMessages: LlmMessageDTO[],
        ) =>
          withAgentSealStage("spindle_interceptors", () =>
            seals.adoptAfterInterceptorTransforms(
              candidateMessages as unknown as LlmMessage[],
            ),
          )
      : undefined;
  if (interceptorPipeline.count > 0) {
    const interceptorResult = await interceptorPipeline.run(
      messages as LlmMessageDTO[],
      spindleContext,
      opts.userId,
      opts.signal,
      postHandlerValidator,
    );
    messages = interceptorResult.messages as unknown as LlmMessage[];
    interceptorParameters = interceptorResult.parameters;
    interceptorBreakdown = interceptorResult.breakdown;
  }
  if (seals?.size) {
    validateAgentSealBoundary("spindle_interceptors", seals, messages);
  }


  // Apply promptPostProcessing
  const postProcessing = settingsSvc.getSetting(

    opts.userId,
    "promptPostProcessing",
  );
  if (postProcessing?.value) {
    applyPostProcessing(messages, postProcessing.value);
  }
  if (agentRuntimeOwner?.seals.size) {
    const seals = agentRuntimeOwner.seals;
    validateAgentSealBoundary("prompt_post_processing", seals, messages);
  }

  // Normal assembly applies prompt-target regexes before context clipping.
  // Keep this fallback for raw/explicit message callers that bypass assembly.
  // When an extension owns this chat's prompt-regex it has already applied the
  // rules inline via the interceptor pipeline above; running this fallback too
  // would double-apply (non-idempotent rules compound). Mirror the assembly
  // pass's skip in prompt-assembly.service.ts (applyPromptRegexScriptsBeforeClipping).
  if (opts.inputMessages && !isPromptRegexChatOwned(opts.chatId, isExtensionRunning)) {
    const chatForRegex = chatsSvc.getChat(opts.userId, opts.chatId);
    const characterId = opts.targetCharacterId || chatForRegex?.character_id || undefined;
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
      const hasRepeatBack = regexScriptsSvc.hasRegexMatchAction(
        promptScripts,
        "repeat_back",
      );
      const chatHistoryPosition = hasRepeatBack
        ? new Map<number, number>()
        : null;
      const chIndices: number[] = [];
      for (let i = 0; i < messages.length; i++) {
        if (isChatHistoryMessage(messages[i])) chIndices.push(i);
      }
      for (let pos = 0; pos < chIndices.length; pos++) {
        chatHistoryDepth.set(chIndices[pos], chIndices.length - 1 - pos);
        chatHistoryPosition?.set(chIndices[pos], pos);
      }
      const originalPromptContent = hasRepeatBack
        ? messages.map((message) => getTextContent(message))
        : [];
      const promptRegexOptionsFor = (index: number, message: LlmMessage) => {
        if (!hasRepeatBack) return { source: "prompt_backend" as const };
        const position = chatHistoryPosition!.get(index);
        let previousContent: string | undefined;
        if (position !== undefined && position > 0) {
          for (let previous = position! - 1; previous >= 1; previous--) {
            const previousIndex = chIndices[previous]!;
            if (messages[previousIndex]?.role === message.role) {
              previousContent = originalPromptContent[previousIndex];
              break;
            }
          }
          previousContent ??= originalPromptContent[chIndices[0]!];
        }
        return {
          source: "prompt_backend" as const,
          ...(previousContent !== undefined ? { previousContent } : {}),
        };
      };

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
              undefined,
              promptRegexOptionsFor(i, msg),
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
                      undefined,
                      promptRegexOptionsFor(i, msg),
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
            undefined,
            { source: "prompt_backend" },
          );
        }
      }
    }
    if (agentRuntimeOwner?.seals.size) {
      const seals = agentRuntimeOwner.seals;
      validateAgentSealBoundary("fallback_prompt_regex", seals, messages);
    }
  }

  // Filter out any messages that became entirely empty after interceptors/regex scripts.
  // Many providers and LLM proxies drop requests entirely or hang if they encounter empty messages.
  const hasNonEmptyContent = (msg: LlmMessage) => {
    if (typeof msg.content === "string") {
      return msg.content.trim().length > 0 || (msg.role === "assistant" && msg.partial === true);
    }
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
    opts.model || effectiveConnection.model || undefined,
    parameters,
    undefined,
    !!opts.inputMessages,
  );

  // Presets that do not use {{lumiaCouncilDeliberation}} still receive the
  // Council output before agent seal restoration and the final context fit.
  // Keep this host-authored insertion opaque to later macro/regex passes.
  if (opts.councilDeliberationBlock && !deliberationHandledByMacro) {
    const insertIdx = Math.max(0, messages.length - 4);
    const deliberationContent = [
      opts.councilHistoricalDeliberationBlock,
      opts.councilDeliberationBlock,
    ]
      .filter(Boolean)
      .join("\n\n");
    const deliberationMessage: LlmMessage = {
      role: "system",
      content: deliberationContent,
    };
    if (agentRuntimeOwner?.seals.size) {
      const seals = agentRuntimeOwner.seals;
      withAgentSealStage("council_insertion", () =>
        seals.insertTrustedSystemMessage(
          messages,
          insertIdx,
          deliberationMessage,
        ),
      );
    } else {
      messages.splice(insertIdx, 0, deliberationMessage);
    }
  }

  if (agentRuntimeOwner?.seals.size) {
    const seals = agentRuntimeOwner.seals;
    // Spindle, post-processing, fallback regex, and empty-message filtering
    // are all untrusted prompt transforms. Validate slot identity/order one
    // last time before restoring any child output.
    validateAgentSealBoundary("final_prompt_transforms", seals, messages);
  }

  if (
    agentRuntimeOwner &&
    (agentRuntimeOwner.seals.size > 0 ||
      agentRuntimeOwner.getMainToolDefinitions().length > 0)
  ) {
    const seals = agentRuntimeOwner.seals;
    withAgentSealStage("result_materialization", () =>
      seals.restore(messages),
    );
    let guidanceIndex = 0;
    while (
      guidanceIndex < messages.length &&
      messages[guidanceIndex].role === "system"
    ) {
      guidanceIndex++;
    }
    messages.splice(guidanceIndex, 0, {
      role: "system",
      content: agentRuntimeOwner.seals.guidanceContent,
    });
    const finalClipStats = await clipToContextBudget(
      messages,
      effectiveConnection.model ?? null,
      parameters.max_context_length as number | null | undefined,
      parameters.max_tokens as number | null | undefined,
      opts.signal,
    );
    assertAgentFinalContextFit(finalClipStats);
    contextClipStats = finalClipStats;
    if (breakdown) {
      const chatHistoryEntry = breakdown.find(
        (entry) => entry.type === "chat_history",
      );
      if (chatHistoryEntry) delete chatHistoryEntry.preCountedTokens;
    }
    const finalHistory = messages.filter(isChatHistoryMessage);
    chatHistoryMessages =
      finalHistory.length > 0 ? finalHistory : undefined;
  }
  return {
    assemblySurface,
    loomPromptInspection,
    messages,
    parameters,
    breakdown,
    chatHistoryMessages,
    assistantPrefill,
    assistantReasoningPrefill,
    activatedWorldInfo,
    worldInfoStats,
    memoryStats,
    databankStats,
    contextClipStats,
    deferredWiState,
    agentRuntimeOwner,
    spindleContext,
    deliberationHandledByMacro,
    macroEnv,
    trimIncompleteWords,
  };
}

/** Resolve provider and key for raw generate: supports connection_id, direct api_key, or provider-name lookup. */
async function resolveRawProviderAndKey(
  userId: string,
  input: RawGenerateInput,
): Promise<{ provider: LlmProvider; apiKey: string; apiUrl: string; connection: ConnectionProfile | null }> {
  // If a connection_id is provided, use per-connection key
  if (input.connection_id) {
    return resolveProviderAndKey(userId, input.connection_id);
  }

  // If a direct api_key is provided, use it
  if (input.api_key) {
    const provider = getProvider(input.provider);
    if (!provider) throw new Error(`Unknown provider: ${input.provider}`);
    return { provider, apiKey: input.api_key, apiUrl: input.api_url || "", connection: null };
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
  return { provider, apiKey: "", apiUrl: input.api_url || "", connection: null };
}
function resolveStartGenerationId(input: GenerateInput): string {
  const requested = typeof input.generationId === "string" ? input.generationId.trim() : "";
  return requested || crypto.randomUUID();
}

function reusableStagedSwipeIndex(message: Message): number | undefined {
  if (!Array.isArray(message.swipes) || message.swipes.length === 0) return undefined;
  const lastIdx = message.swipes.length - 1;
  return message.swipes[lastIdx] === "" ? lastIdx : undefined;
}

/**
 * Trusted, out-of-band start options. A second positional argument keeps these
 * values unreachable from the request-body spread used by interactive routes.
 */
export interface StartGenerationOptions {
  origin?: "edit_and_send";
  /** Connection profile committed with the durable Edit-and-Send outbox row. */
  connectionId?: string;
}
function resolveResponseGenerationAdmission(
  input: GenerateInput,
  options?: StartGenerationOptions,
) {
  const chat = chatsSvc.getChat(input.userId, input.chat_id);
  const connection = resolveChatGenerationConnection(
    input.userId,
    chat?.metadata,
    input.connection_id,
    {
      authoritativeConnectionId: options?.origin === "edit_and_send"
        ? options.connectionId
        : undefined,
      preferActiveConnection: options?.origin === "edit_and_send"
        && readEditAndSendAlwaysUseActiveConnection(input.userId),
    },
  );
  return { chat, connection };
}

async function startResponseGeneration(
  input: GenerateInput,
  options?: StartGenerationOptions,
  admitted?: ReturnType<typeof resolveResponseGenerationAdmission>,
): Promise<{ generationId: string; status: string }> {
  throwIfGenerationRequestAborted(input.signal);
  const requestedGenerationId =
    typeof input.generationId === "string" ? input.generationId.trim() : "";
  const generationId = resolveStartGenerationId(input);
  let genType = input.generation_type || "normal";

  if (requestedGenerationId) {
    const existing = activeGenerations.get(generationId);
    if (existing && existing.userId === input.userId && existing.chatId === input.chat_id) {
      return { generationId, status: "streaming" };
    }
    const poolEntry = pool.getPoolEntry(generationId);
    if (poolEntry && poolEntry.userId === input.userId && poolEntry.chatId === input.chat_id) {
      return { generationId, status: "streaming" };
    }
  }

  // Safety fallback: regenerate/continue should only target an assistant
  // message when the latest chat message is assistant-authored.
  // If the latest message is user (common right after send), treat this as
  // normal generation so we create a new assistant reply instead of mutating
  // an older assistant message (e.g. greeting at index 0).
  // Skip this check when an explicit message_id is provided — the frontend
  // already validated the target.
  if (
    (genType === "regenerate" || genType === "swipe" || genType === "continue") &&
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
      existing.terminal.claimAndProject("stopped", {
        status: "stopped",
      });
      // before starting the new one. This serializes the HTTP abort+connect
      // sequence, preventing two fetch operations from overlapping on Bun's
      // HTTPThread which has a known race on concurrent cancel+start. Bounded
      // at 2s so a hung generation can't deadlock regeneration permanently.
      await Promise.race([
        existing.completion,
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    }
    activeGenerations.delete(existingGenId);
    activeChatGenerations.delete(chatKey);
  }

  // Register this generation early (before council) so it can be tracked and aborted.
  // The completion promise is created up-front (deferred) so a replacement
  // generation can always await teardown — even if it arrives during the setup
  // phase before the streaming IIFE has started.
  throwIfGenerationRequestAborted(input.signal);
  const abortController = new AbortController();
  const terminal = new GenerationTerminalCoordinator(
    generationId,
    abortController,
    input.userId,
    input.chat_id,
  );
  let resolveCompletion!: () => void;
  const completion = new Promise<void>((r) => { resolveCompletion = r; });
  const onRequestAbort = () => terminal.claimAndProject("stopped", { status: "stopped" });
  input.signal?.addEventListener("abort", onRequestAbort, { once: true });
  void completion.finally(() => input.signal?.removeEventListener("abort", onRequestAbort));
  const generationStartedAt = Date.now();
  activeGenerations.set(generationId, {
    controller: abortController,
    terminal,
    userId: input.userId,
    chatId: input.chat_id,
    startedAt: generationStartedAt,
    // Until the provider returns its first token, the generation start is the
    // last observed progress. This still protects requests that never begin
    // streaming while allowing long-running streams to continue indefinitely.
    lastTokenAt: generationStartedAt,
    lastActivityAt: generationStartedAt,
    completion,
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
  // Swipes are staged before the slower preflight work below. Keep both the
  // original snapshot and the staged result: the former is the response being
  // replaced, while the latter carries the new swipe index and active state.
  let stagedSwipeOriginal: Message | null = null;
  let stagedSwipe: Message | null = null;
  let stagedSwipeId: number | undefined;

  try {
    // Stage a swipe before cancelling background work, resolving secrets, or
    // validating the preset. This is the user-visible part of the action, and
    // it must not wait behind cache-warming HTTP teardown (which is bounded at
    // two seconds) or any later prompt-assembly preflight.
    if (genType === "regenerate" || genType === "swipe") {
      const target = input.message_id
        ? chatsSvc.getMessage(input.userId, input.message_id)
        : chatsSvc.getLastAssistantMessage(input.userId, input.chat_id);
      if (target && !target.is_user) {
        const reuseIdx = requestedGenerationId ? reusableStagedSwipeIndex(target) : undefined;
        if (reuseIdx != null) {
          const priorIdx = reuseIdx > 0 ? reuseIdx - 1 : reuseIdx;
          stagedSwipeOriginal = {
            ...target,
            swipe_id: priorIdx,
            content: target.swipes[priorIdx] ?? target.content,
          };
          stagedSwipe = { ...target, swipe_id: reuseIdx };
          stagedSwipeId = reuseIdx;
        } else {
          stagedSwipeOriginal = target;
          stagedSwipe = chatsSvc.addSwipe(input.userId, target.id, "");
          stagedSwipeId = stagedSwipe?.swipe_id;
        }
      }
    }

    // Tear down any fire-and-forget background work (cortex cache warming,
    // databank retrieval) left over from prior generations on this chat. The
    // user-visible swipe above is deliberately staged first; only the later
    // provider/prompt work needs to wait for this bounded HTTP teardown.
    await abortChatBackground(input.userId, input.chat_id);
    checkAborted();

    // Loaded before preset resolution: no-preset temp chats bypass the preset
    // requirement entirely (assertUsablePreset would otherwise reject them).
    const { chat, connection } = admitted ?? resolveResponseGenerationAdmission(input, options);
    input.connection_id = connection.id;
    const isNoPresetChat = isNoPresetChatMetadata(chat?.metadata);
    if (isNoPresetChat) {
      input.preset_id = undefined;
      input.force_preset_id = false;
    } else {
      if (!input.preset_id) {
        input.preset_id = resolveActivePresetId(input.userId);
      }
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
    }
    const { provider, apiKey, apiUrl } = await resolveProviderAndKey(
      input.userId,
      connection.id,
    );

    // Resolve the assistant message being modified before choosing a character.
    // Group retries/continues are tied to the message's speaker, not the chat's
    // primary/greeting character.
    const isGroupChat = chat?.metadata?.group === true;
    const groupCharacterIds =
      isGroupChat && Array.isArray(chat?.metadata?.character_ids)
        ? (chat.metadata.character_ids as string[])
        : [];
    let targetAssistantMessage: Message | null = null;
    if (genType === "regenerate" || genType === "swipe") {
      // Reuse the pre-staging snapshot. Re-reading here would see the blank
      // active swipe and lose the original content for rejected-swipe macros.
      targetAssistantMessage = stagedSwipeOriginal ?? (input.message_id
        ? chatsSvc.getMessage(input.userId, input.message_id)
        : chatsSvc.getLastAssistantMessage(input.userId, input.chat_id));
    } else if (genType === "continue") {
      targetAssistantMessage = input.message_id
        ? chatsSvc.getMessage(input.userId, input.message_id)
        : chatsSvc.getLastAssistantMessage(input.userId, input.chat_id);
    }
    if (targetAssistantMessage?.is_user) targetAssistantMessage = null;

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
    const requestedTargetCharId =
      input.target_character_id &&
      isGroupChat &&
      groupCharacterIds.includes(input.target_character_id)
        ? input.target_character_id
        : undefined;
    const messageTargetCharId =
      typeof targetAssistantMessage?.extra?.character_id === "string"
        ? targetAssistantMessage.extra.character_id
        : undefined;
    const inferredGroupTargetCharId =
      isGroupChat &&
      messageTargetCharId &&
      groupCharacterIds.includes(messageTargetCharId)
        ? messageTargetCharId
        : undefined;
    const targetExistingAssistant =
      genType === "regenerate" || genType === "swipe" || genType === "continue";
    const resolvedTargetCharId = targetExistingAssistant
      ? inferredGroupTargetCharId || requestedTargetCharId
      : requestedTargetCharId || inferredGroupTargetCharId;
    const targetCharId = resolvedTargetCharId || chat?.character_id || undefined;
    const pipelineTargetCharId = resolvedTargetCharId;
    if (targetCharId) {
      const character = charactersSvc.getCharacter(input.userId, targetCharId);
      if (character) characterName = getEffectiveCharacterName(character);
    }

    // Temporary chats are persona-less by contract — never fall back to the
    // active/default persona for them.
    const isTemporaryChat = isTemporaryChatMetadata(chat?.metadata);

    // Resolve persona_id from settings if not provided by the frontend, so the
    // persona's attached world book is always included regardless of UI state.
    if (!input.persona_id && !isTemporaryChat) {
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
    let resolvedPersona = isTemporaryChat
      ? null
      : personasSvc.resolvePersonaOrDefault(input.userId, input.persona_id);
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
      connectionName: connection.name,
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
    let rejectedSwipe: string | undefined;
    // Index of the swipe this generation streams into. Sent to the frontend so
    // it can gate the streaming buffer to the correct swipe — letting the user
    // navigate to other (already-saved) swipes mid-generation without smearing
    // live tokens onto them. Distinct from lifecycle.targetSwipeIdx (which also
    // routes the completion write) so we don't perturb normal/continue saving.
    let targetSwipeId: number | undefined;

    if (genType === "regenerate" || genType === "swipe") {
      const targetMsg = targetAssistantMessage;
      if (targetMsg) {
        lifecycle.targetMessageId = targetMsg.id;
        excludeMessageId = targetMsg.id;
        rejectedSwipe = targetMsg.content;
        // Add a blank swipe immediately so the frontend shows cleared content
        // before council/assembly begins (MESSAGE_SWIPED event fires now).
        const withBlank = stagedSwipe ?? chatsSvc.addSwipe(input.userId, targetMsg.id, "");
        lifecycle.targetSwipeIdx = withBlank ? withBlank.swipe_id : 0;
        targetSwipeId = lifecycle.targetSwipeIdx;
        // Clear stale generation metrics from the previous swipe so the pill
        // doesn't display outdated values while the new generation runs.
        // Uses patchMessageExtra to avoid triggering chunk rebuilds / WS events.
        const prevExtra = withBlank?.extra ?? targetMsg.extra;
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
      const lastMsg = targetAssistantMessage;
      if (lastMsg) {
        lifecycle.continueMessageId = lastMsg.id;
        lifecycle.continueOriginalContent = lastMsg.content;
        // Continue appends to the currently-displayed swipe.
        targetSwipeId = lastMsg.swipe_id;
        // Resolve continuePostfix from the preset's completion settings so it can
        // be inserted between original content and generated text when saving.
        const cpPresetId = input.preset_id || connection.preset_id;
        const cpPreset = cpPresetId
          ? presetsSvc.getPreset(input.userId, cpPresetId)
          : null;
        lifecycle.continuePostfix = resolveContinuePostfix(
          lastMsg.content,
          cpPreset?.prompts?.completionSettings?.continuePostfix || "",
        );
      }
    }

    // Stage an empty assistant message early for normal sends so the frontend
    // has a real message ID to attach to the streaming bubble via data-message-id.
    // This eliminates the duplicate ephemeral bubble and renders tokens in-place
    // on the message card, matching the regenerate/swipe UX.
    // Edit-and-send supplies a durable generationId and already owns the branch
    // target — do not pre-create a second placeholder on that path.
    if (genType === "normal" && !requestedGenerationId) {
      const extra: Record<string, any> = {};
      if (targetCharId) extra.character_id = targetCharId;
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
      // A fresh message has a single swipe at index 0.
      targetSwipeId = 0;
    }

    // Carry the streaming swipe index into runGeneration so the GENERATION_IN_PROGRESS
    // emit (different scope) can surface it too.
    lifecycle.streamingSwipeId = targetSwipeId;

    // Register pool entry for recovery — at this point we have all the metadata
    pool.createPoolEntry({
      generationId,
      userId: input.userId,
      chatId: input.chat_id,
      requestAuthorityId: input.request_authority_id,
      generationType: genType,
      characterName,
      characterId: targetCharId,
      model: connection.model,
      provider: connection.provider,
      connectionId: connection.id,
      targetMessageId: lifecycle.targetMessageId,
      targetSwipeId,
    });
    terminal.markRunLoopStarted();
    pool.registerPoolTerminalOwner(generationId, terminal.poolOwner());

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
        requestAuthorityId: input.request_authority_id,
        provider: connection.provider,
        targetMessageId: lifecycle.targetMessageId,
        targetSwipeId,
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
    // with an error payload. The promise is stored on activeGenerations so a
    // replacement generation (regenerate) can await teardown before starting.
    (async () => {
      // Yield to the macro task queue IMMEDIATELY so that the HTTP response
      // (`return { generationId, status: "streaming" }` below) is sent before
      // any assembly work begins.  Without this, JavaScript's async execution
      // model runs everything between here and the first internal `await`
      // synchronously — which can include council settings, all DB prefetch
      // queries, world-info activation, and more — blocking the event loop
      // and delaying the response (and every other request) until that first
      // internal `await` yields.
      await new Promise<void>((r) => setTimeout(r, 0));
      let generationAgentRuntimeOwner: AgentRuntimeOwner | undefined;
      let effectivePresetSnapshot: EffectiveAgentPresetResolution | undefined;
      try {
        if (chat) {
          const effectiveResolution = resolveEffectiveAgentPreset({
            userId: input.userId,
            chat,
            connection,
            presetId: input.preset_id,
            forcePresetId: input.force_preset_id,
            targetCharacterId: targetCharId,
            personaId: resolvedPersona?.id,
          });
          effectivePresetSnapshot = cloneEffectiveAgentPresetResolution(
            effectiveResolution,
          );
          assertRoomAgentIntrinsicsBeforeCouncil({
            userId: input.userId,
            chat,
            preset: effectivePresetSnapshot.preset,
            binding: effectivePresetSnapshot.binding,
            generationType: genType,
            impersonateMode: input.impersonate_mode,
            targetCharacterId: targetCharId,
          });
        }
        // Execute council if enabled (before prompt assembly so it doesn't slow the critical path visibly)
        const resolvedCouncilProfile = councilProfilesSvc.resolveProfile(
          input.userId,
          input.chat_id,
          chat?.character_id ?? null,
          { isGroup: chat?.metadata?.group === true },
        );
        const councilSettings = resolvedCouncilProfile.council_settings;
        let councilResult: CouncilExecutionResultWithHistory | null = null;
        // Hash of the council's view of the chat at fingerprint time. Hoisted
        // so the cache-store site (outside the if/else below) can stamp the
        // same value the cache-check used into the persisted entry.
        let councilContextHash: string | undefined;
        let inlineTools: ToolDefinition[] | undefined;
        let inlineToolDefsByName:
          | Map<string, RuntimeCouncilToolDefinition>
          | undefined;
        let inlineToolSafeNames: Map<string, string> | undefined;
        let inlineMembersByPrefix: Map<string, CouncilMember> | undefined;
        let inlineWebSearchEnabled = false;
        let precomputedVectorEntries: PrecomputedWorldInfoVectorEntries | undefined;

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
            // Load the council's view of the chat now so we can both fingerprint
            // it for the cache check AND reuse the same list for enrichment if
            // we miss. The hash of these messages is mixed into the cache
            // fingerprint so editing or deleting any in-window message
            // invalidates a stale cached deliberation block.
            const fullCharacterId = targetCharId || chat?.character_id;
            const fullCharacter = chat && fullCharacterId
              ? charactersSvc.getCharacter(input.userId, fullCharacterId)
              : null;
            const councilMessages = chatsSvc
              .getMessages(input.userId, input.chat_id)
              .filter(
                (m) => m.id !== excludeMessageId && m.id !== stagedMessageId,
              );
            councilContextHash = hashCouncilContextMessages(
              councilMessages,
              councilSettings.toolsSettings.sidecarContextWindow,
              excludesLatestUserMessage(councilSettings.toolsSettings),
            );

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
              councilContextHash,
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
                ...(cached.historicalDeliberationBlock
                  ? { historicalDeliberationBlock: cached.historicalDeliberationBlock }
                  : {}),
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
              // Guard: normal sends are already staged above. A swipe/regenerate
              // already has a blank target swipe, so do not create a duplicate
              // assistant message here.
              if (
                !stagedMessageId &&
                genType === "normal"
              ) {
                const extra: Record<string, any> = {};
                if (targetCharId) extra.character_id = targetCharId;
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
              // collects world info entries and runs keyword activation
              // synchronously. Without a yield here the event loop is blocked
              // from the setTimeout at the top of the IIFE through all of this
              // sync work until the first real `await` (embedding API call).
              await new Promise<void>((r) => setTimeout(r, 0));
              checkAborted();

              // Pre-compute enrichment for council tools — resolve world info at the
              // top of the generation chain so tools receive proper world book context.
              // councilMessages was already loaded above (with the same
              // staged/excluded filter the council expects) so the fingerprint
              // and the enrichment see an identical view.
              const { entries: wiEntries, worldBookIds: wiBookIds } =
                collectWorldInfoForCouncil(
                  input.userId,
                  fullCharacter,
                  resolvedPersona,
                  input.chat_id,
                );
              const councilWorldInfoSettings =
                (settingsSvc.getSetting(input.userId, "worldInfoSettings")?.value as
                  | Partial<WorldInfoSettings>
                  | undefined) ?? {};
              let councilWiActivated =
                wiEntries.length > 0
                  ? activateWorldInfo({
                      entries: wiEntries,
                      messages: councilMessages,
                      chatTurn: councilMessages.length,
                      wiState: {},
                      settings: councilWorldInfoSettings,
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
                councilWorldInfoSettings,
              );
              councilWiActivated = mergeActivatedWorldInfoEntries(
                councilWiActivated,
                vectorActivated,
                councilWorldInfoSettings,
              ).activatedEntries;

              // Cache for assembly to reuse
              precomputedVectorEntries = Object.freeze({
                sourceFingerprint: buildWorldInfoVectorSourceFingerprint(
                  wiEntries,
                  wiBookIds,
                ),
                entries: Object.freeze(vectorActivated),
              });

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
                    pool.setPoolStatus(generationId, "waiting");
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
                      let pending!: {
                        userId: string;
                        resolve: (decision: "continue" | "retry") => void;
                        timeout: ReturnType<typeof setTimeout>;
                        abortCleanup: () => void;
                      };
                      const finish = (value: "continue" | "retry"): void => {
                        if (pendingCouncilRetries.get(generationId) !== pending) {
                          return;
                        }
                        clearTimeout(pending.timeout);
                        pendingCouncilRetries.delete(generationId);
                        pending.abortCleanup();
                        if (poolEntry) {
                          poolEntry.councilRetryPending = false;
                          delete poolEntry.councilToolsFailure;
                          if (poolEntry.status === "waiting") {
                            pool.setPoolStatus(generationId, "council");
                          }
                        }
                        resolve(value);
                      };
                      const onAbort = (): void => finish("continue");
                      const timeout = setTimeout(() => {
                        console.debug(
                          "[council] Safety cap reached for %s — auto-continuing",
                          generationId,
                        );
                        finish("continue");
                      }, COUNCIL_RETRY_SAFETY_CAP_MS);
                      pending = {
                        userId: input.userId,
                        resolve: finish,
                        timeout,
                        abortCleanup: () =>
                          abortController.signal.removeEventListener(
                            "abort",
                            onAbort,
                          ),
                      };
                      pendingCouncilRetries.set(generationId, pending);
                      abortController.signal.addEventListener(
                        "abort",
                        onAbort,
                        { once: true },
                      );
                      if (abortController.signal.aborted) finish("continue");
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
                        ...(councilResult.historicalDeliberationBlock
                          ? { historicalDeliberationBlock: councilResult.historicalDeliberationBlock }
                          : {}),
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
            if (!inlineToolSafeNames) inlineToolSafeNames = new Map<string, string>();

            for (const extTool of extensionInlineTools) {
              const qualifiedName = toolRegistry.getQualifiedName(extTool);
              const encodedName = encodeExtensionToolName(qualifiedName);
              let safeName = encodedName;
              let collisionIndex = 1;
              while (inlineToolDefsByName.has(safeName)) {
                safeName = `${encodedName}_${collisionIndex}`;
                collisionIndex += 1;
              }

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
              inlineToolSafeNames.set(safeName, qualifiedName);
              inlineTools.push({
                name: safeName,
                description: extTool.description,
                parameters: argsSchema,
              });
            }
          }
        }

        // ── Built-in Inline Web Search (independent of Council) ──────────
        // This is intentionally separate from the preset's Google-native
        // grounding option. It uses the user's configured web-search
        // provider and is only offered when both web search and function
        // calling are explicitly available.
        if (genType !== "impersonate") {
          const presetId = input.preset_id || connection.preset_id;
          const preset = presetId
            ? presetsSvc.getPreset(input.userId, presetId)
            : null;
          const completionSettings = preset?.prompts?.completionSettings;
          const webSearchSettings = await getWebSearchSettings(input.userId);
          const configured = webSearchSettings.enabled && !!webSearchSettings.apiUrl &&
            (webSearchSettings.provider === "searxng" || webSearchSettings.hasApiKey);
          if (configured && webSearchSettings.inlineToolEnabled && completionSettings?.enableFunctionCalling !== false) {
            if (!inlineTools) inlineTools = [];
            if (!inlineToolDefsByName) {
              inlineToolDefsByName = new Map<string, RuntimeCouncilToolDefinition>();
            }
            inlineToolDefsByName.set(INLINE_WEB_SEARCH_TOOL_NAME, {
              name: INLINE_WEB_SEARCH_TOOL_NAME,
              displayName: "Web Search",
              description: INLINE_WEB_SEARCH_TOOL.description,
              category: "context",
              execution: "host",
              argsSchema: INLINE_WEB_SEARCH_TOOL.parameters,
              strict: true,
              inputExamples: INLINE_WEB_SEARCH_TOOL.inputExamples,
            });
            inlineTools.push(INLINE_WEB_SEARCH_TOOL);
            inlineWebSearchEnabled = true;
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

          if (councilResult.totalDurationMs > 0) {
            try {
              appendCouncilDeliberationHistory({
                userId: input.userId,
                chatId: input.chat_id,
                settings: councilSettings,
                results: councilResult.results,
              });
            } catch (err) {
              console.warn(
                "[council] Failed to append deliberation history:",
                err,
              );
            }
          }

          // Persist successful council results for potential reuse on
          // regens/swipes. Only cache freshly executed runs (totalDurationMs > 0
          // distinguishes a live execution from a cache hit, which sets it to 0).
          //
          // Cache the *successful subset* rather than requiring every tool to
          // succeed: failed results are already excluded from the deliberation
          // block (formatDeliberation skips them), so a single flaky tool no
          // longer prevents the whole council from being retained — which would
          // otherwise force a full re-execution on the next regen even with
          // "Retain results for regens" enabled. The failed tools still surface
          // the COUNCIL_TOOLS_FAILED retry prompt on the original run.
          const successfulResults = councilResult.results.filter(
            (result) => result.success,
          );
          if (
            councilResult.totalDurationMs > 0 &&
            successfulResults.length > 0 &&
            councilContextHash !== undefined
          ) {
            const cachedResult: CouncilResultCache = {
              results: successfulResults,
              deliberationBlock: councilResult.deliberationBlock,
              ...(councilResult.historicalDeliberationBlock
                ? { historicalDeliberationBlock: councilResult.historicalDeliberationBlock }
                : {}),
              namedResults: councilNamedResults,
              cachedAt: Date.now(),
              fingerprint: buildCouncilCacheFingerprint(
                councilSettings,
                resolvedCouncilProfile.sidecar_settings,
                councilContextHash,
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
        } else if (
          councilResult === null &&
          councilContextHash !== undefined
        ) {
          // Empty dice roll: the council was active (sidecar mode, tools
          // assigned) but no member survived their `chance` roll, so
          // executeCouncil returned null. Cache that "stayed silent" outcome
          // keyed by the same fingerprint so a retained regen/swipe reuses it
          // instead of silently re-rolling — the most common reason a regen
          // appeared to re-run the council despite Retain being on.
          // councilContextHash is only set on the sidecar execution path, so
          // this never fires for inline-mode or council-disabled generations.
          const emptyRollCache: CouncilResultCache = {
            results: [],
            deliberationBlock: "",
            namedResults: {},
            cachedAt: Date.now(),
            emptyRoll: true,
            fingerprint: buildCouncilCacheFingerprint(
              councilSettings,
              resolvedCouncilProfile.sidecar_settings,
              councilContextHash,
            ),
          };
          try {
            chatsSvc.mergeChatMetadata(input.userId, input.chat_id, {
              last_council_results: emptyRollCache,
            });
          } catch (err) {
            console.warn(
              "[council] Failed to cache empty-roll outcome to chat metadata:",
              err,
            );
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
            userName: input.userName,
            generationId,
            assemblySurface: "RESPONSE",
            chatId: input.chat_id,
            connectionId: input.connection_id,
            model: connection.model,
            presetId: input.preset_id,
            forcePresetId: input.force_preset_id,
            effectivePresetSnapshot,
            personaId: input.persona_id,
            personaAddonStates: input.persona_addon_states,
            generationType: genType,
            impersonateMode:
              genType === "impersonate"
                ? input.impersonate_mode || "prompts"
                : undefined,
            impersonateInput:
              genType === "impersonate" ? input.impersonate_input : undefined,
            userInput: input.user_input,
            sourceUserMessageIds: lifecycle.sourceUserMessageIds,
            inputMessages: input.messages,
            inputParameters: input.parameters,
            excludeMessageId,
            rejectedSwipe,
            continueMessageId: lifecycle.continueMessageId,
            continuePostfix: lifecycle.continuePostfix,
            targetCharacterId: pipelineTargetCharId,
            councilToolResults,
            councilNamedResults,
            councilDeliberationBlock: councilResult?.deliberationBlock,
            councilHistoricalDeliberationBlock:
              councilResult?.historicalDeliberationBlock,
            precomputedVectorEntries,
            regenFeedback: input.regen_feedback,
            regenFeedbackPosition: input.regen_feedback_position,
            regenFeedbackFormat: input.regen_feedback_format,
            signal: abortController.signal,
            activityMessageId: lifecycle.targetMessageId,
            onAgentRuntimeRequired: () => {
              terminal.markAgentRuntimeActive();
            },
            onAgentRuntimeOwnerCreated: (owner) => {
              generationAgentRuntimeOwner = owner;
              terminal.attachRuntimeOwner(owner);
            },
          }),
          abortController.signal,
        );

        let { messages } = pipeline;
        let { parameters: mergedParams } = pipeline;
        const {
          breakdown,
          activatedWorldInfo,
          deliberationHandledByMacro,
        } = pipeline;
        const agentRuntimeOwner = pipeline.agentRuntimeOwner;
        if (agentRuntimeOwner && genType !== "impersonate") {
          const agentToolDefinitions =
            agentRuntimeOwner.getMainToolDefinitions();
          if (agentToolDefinitions.length > 0) {
            const existingNames = new Set(
              (inlineTools ?? []).map((definition) => definition.name),
            );
            if (
              agentToolDefinitions.some((definition) =>
                existingNames.has(definition.name),
              )
            ) {
              throw new Error("Agent tool name conflicts with another tool");
            }
            inlineTools = [
              ...(inlineTools ?? []),
              ...agentToolDefinitions,
            ];
          }
        }

        // A context anchor is a strict guardrail: older history may be clipped,
        // but the marked message and every newer turn must fit together. Abort
        // before the primary provider receives any prompt when that protected
        // tail exceeds the available history budget.
        if (pipeline.contextClipStats?.anchorOverflow) {
          const protectedTokens = pipeline.contextClipStats.protectedHistoryTokens ?? 0;
          const availableTokens = Math.max(
            0,
            pipeline.contextClipStats.remainingHistoryBudget,
          );
          throw new Error(
            `Protected context anchor needs ${protectedTokens.toLocaleString()} tokens, ` +
              `but only ${availableTokens.toLocaleString()} fit after prompt overhead. ` +
              `Increase Context Size or lower Max Response.`,
          );
        }

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


        // Attach assembly metadata to lifecycle
        lifecycle.breakdown = breakdown;
        lifecycle.assemblySurface = pipeline.assemblySurface;
        lifecycle.loomPromptInspection = pipeline.loomPromptInspection;
        lifecycle.chatHistoryMessages = pipeline.chatHistoryMessages;
        lifecycle.messages = messages;
        lifecycle.model = connection.model;
        lifecycle.providerName = provider.name;
        lifecycle.maxContext = mergedParams.max_context_length as
          | number
          | undefined;
        lifecycle.councilNamedResults = councilNamedResults;
        lifecycle.contextClipStats = pipeline.contextClipStats;
        lifecycle.trimIncompleteWords = pipeline.trimIncompleteWords;

        // Strip internal-only keys before they reach the provider
        delete mergedParams.max_context_length;

        injectConnectionMetadataFlags(connection, mergedParams, input.chat_id);

        const cached = applyPromptCaching(
          {
            provider: provider.name,
            model: connection.model,
            metadata: connection.metadata,
          },
          { params: mergedParams, messages, tools: inlineTools },
        );
        mergedParams = cached.params;
        messages = cached.messages;
        inlineTools = cached.tools;

        // Per-swipe seed: a regenerate/swipe excludes the whole target message,
        // so the assembled prompt is byte-identical to the previous swipe. With
        // a user-pinned seed (advancedSettings.seed >= 0) that means a
        // seed-honoring backend returns byte-identical tokens every swipe. Offset
        // the seed by the swipe slot so each swipe is reproducible-but-distinct
        // while the first (normal) generation keeps the exact pinned seed. Modulo
        // the int32 ceiling so a seed pinned near the max can't overflow the
        // range some backends validate (the wrap keeps slots distinct).
        if (
          (genType === "regenerate" || genType === "swipe") &&
          typeof mergedParams.seed === "number" &&
          mergedParams.seed >= 0 &&
          typeof lifecycle.targetSwipeIdx === "number"
        ) {
          const MAX_SEED = 2147483647; // int32 max — widely accepted ceiling
          mergedParams.seed =
            (mergedParams.seed + lifecycle.targetSwipeIdx) % MAX_SEED;
        }

        // Resolve preset name for breakdown display
        const presetId = input.preset_id || connection.preset_id;
        if (presetId) {
          const preset = presetsSvc.getPreset(input.userId, presetId);
          if (preset) {
            lifecycle.presetName = preset.name;
            lifecycle.presetId = presetId;
          }
        }

        // Final abort checkpoint between assembly completion and runGeneration
        // entry. If the user stopped while prompt assembly was winding down,
        // bail out here instead of emitting GENERATION_STARTED (with breakdown)
        // and then tearing the stream down on the first iter.next() race.
        checkAborted();

        await runGeneration(
          generationId,
          provider,
          connection.provider,
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
          inlineToolSafeNames,
          inlineWebSearchEnabled,
          councilSettings.toolsSettings.timeoutMs,
          pipeline.assistantPrefill,
          pipeline.assistantReasoningPrefill,
          pipeline.macroEnv,
          pipeline.macroEnvSeed,
          agentRuntimeOwner,
        );
      } catch (err: unknown) {
        // Clean up tracking maps if setup (council, assembly, etc.) fails or is aborted.
        // Only clear the per-chat mapping if it still points at THIS generation —
        // a newer startGeneration on the same chat may have already taken over the
        // chatKey (see line 590), and wiping it would strand the new generation.

        // Clean up any pending council retry decision and wake its waiter.
        clearPendingCouncilRetry(generationId);

        // User aborts and extension-requested cancels both emit stop events so
        // the frontend resets its streaming state.
        if (abortController.signal.aborted || err instanceof GenerationCancelledByExtensionError) {
          // Clean up staged message if one was created (sidecar council mode)
          if (stagedMessageId) {
            try {
              chatsSvc.deleteMessage(input.userId, stagedMessageId);
            } catch {
              /* best-effort cleanup */
            }
          }
          claimGenerationTerminal(generationId, "stopped", {
            status: "stopped",
          });
          activeGenerations.delete(generationId);
          if (activeChatGenerations.get(chatKey) === generationId) {
            activeChatGenerations.delete(chatKey);
          }
          return;
        }

        if (stagedMessageId) {
          try {
            chatsSvc.deleteMessage(input.userId, stagedMessageId);
          } catch {
            /* best-effort cleanup */
          }
        }

        terminal.recordAgentRuntimeFailure(err);
        abortChatBackground(input.userId, input.chat_id);

        const msg = errorMessage(err);
        claimGenerationTerminal(
          generationId,
          terminalReasonForError(
            err,
            generationAgentRuntimeOwner,
            terminal.agentRuntimeActive,
          ),
          {
            status: "error",
            error: msg,
          },
        );
        activeGenerations.delete(generationId);
        if (activeChatGenerations.get(chatKey) === generationId) {
          activeChatGenerations.delete(chatKey);
        }
      } finally {
        terminal.markRunLoopReconciled();
        try {
          terminal.ensurePoolProjection();
        } catch (error) {
          console.warn(
            "[generate] Failed to reconcile terminal pool state:",
            error,
          );
        }
        const poolSettled = terminal.hasTerminalPoolProjection();
        generationAgentRuntimeOwner?.close();
        if (poolSettled) pool.unregisterPoolTerminalOwner(generationId);
        resolveCompletion();
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
    // A failure before GENERATION_STARTED has no terminal event for the
    // frontend to reconcile. Remove the early blank swipe ourselves, but only
    // when its slot is still the empty value we staged.
    if (stagedSwipeOriginal && stagedSwipeId != null) {
      try {
        const current = chatsSvc.getMessage(input.userId, stagedSwipeOriginal.id);
        if (current?.swipes[stagedSwipeId] === "") {
          chatsSvc.deleteSwipe(input.userId, stagedSwipeOriginal.id, stagedSwipeId);
        }
      } catch {
        /* best-effort cleanup */
      }
    }
    terminal.claimWithoutPool("failed");
    pool.unregisterPoolTerminalOwner(generationId);
    activeGenerations.delete(generationId);
    if (activeChatGenerations.get(chatKey) === generationId) {
      activeChatGenerations.delete(chatKey);
    }
    resolveCompletion();
    throw err;
  }
}
let agenticGenerationDependencies: AgenticGenerationDependencies | undefined;

/** Install concrete decision, snapshot, phase, and commit authorities during startup. */
export function configureAgenticGenerationDependencies(
  dependencies: AgenticGenerationDependencies,
): void {
  agenticGenerationDependencies = dependencies;
}

function toAgenticGenerationInput(input: GenerateInput): AgenticGenerationInput {
  const chat = chatsSvc.getChat(input.userId, input.chat_id);
  const metadata = chat?.metadata as Record<string, unknown> | undefined;
  const generationType = input.generation_type ?? "normal";
  const isGroupChat = metadata?.group === true || metadata?.group === 1;
  const councilProfile = councilProfilesSvc.resolveProfile(
    input.userId,
    input.chat_id,
    chat?.character_id ?? null,
    { isGroup: isGroupChat },
  );
  const councilSettings = councilProfile.council_settings;
  const councilEnabled =
    councilSettings.councilMode === true &&
    councilSettings.members.length > 0;
  const councilToolsEnabled = councilSettings.members.some(
    (member) => member.tools.length > 0,
  );
  return {
    userId: input.userId,
    chatId: input.chat_id,
    ...(input.connection_id ? { connectionId: input.connection_id } : {}),
    ...(input.preset_id ? { presetId: input.preset_id } : {}),
    ...(input.force_preset_id !== undefined ? { forcePresetId: input.force_preset_id } : {}),
    ...(input.persona_id ? { personaId: input.persona_id } : {}),
    ...(input.persona_addon_states ? { personaAddonStates: { ...input.persona_addon_states } } : {}),
    sourceUserMessageIds: chatsSvc.getTrailingVisibleUserMessageIds(input.userId, input.chat_id),
    ...(input.message_id ? { messageId: input.message_id } : {}),
    ...(input.swipe_id !== undefined ? { swipeId: input.swipe_id } : {}),
    ...(input.target_character_id ? { targetCharacterId: input.target_character_id } : {}),
    generationType,
    ...(input.parameters ? { parameters: input.parameters } : {}),
    userInput: input.user_input ?? "",
    ...(input.regen_feedback !== undefined ? { regenFeedback: input.regen_feedback } : {}),
    ...(input.runtime_decision_token !== undefined ? { runtimeDecisionToken: input.runtime_decision_token } : {}),
    requireDispatchAcknowledgement: normalizeGenerationRequestAuthorityId(input.request_authority_id) !== null,
    ...(input.request_epoch !== undefined ? { requestEpoch: input.request_epoch } : {}),
    signal: input.signal,
    isImpersonate: input.generation_type === "impersonate" || input.impersonate_mode !== undefined,
    isGroupChat,
    isMultiplayer: metadata?.multiplayer === true || typeof metadata?.multiplayer_room_id === "string",
    councilEnabled,
    councilToolsEnabled,
  };
}
function toEffectiveRuntimeRequest(input: GenerateInput): EffectiveRuntimeRequestV1 {
  const generationType = input.generation_type ?? "normal";
  const targetGenerationType = generationType === "normal"
    || generationType === "continue"
    || generationType === "regenerate"
    || generationType === "swipe"
    ? generationType
    : "normal";
  return {
    chatId: input.chat_id,
    logicalConnectionId: input.connection_id ?? null,
    presetId: input.preset_id ?? null,
    forcePresetId: input.force_preset_id === true,
    personaId: input.persona_id ?? null,
    targetCharacterId: input.target_character_id ?? null,
    generationType,
    target: {
      generationType: targetGenerationType,
      messageId: input.message_id ?? null,
      swipeId: input.swipe_id ?? null,
      targetCharacterId: input.target_character_id ?? null,
    },
    ...(input.mode !== undefined
      ? {
        transientSelection: {
          mode: input.mode,
          turnFence: input.request_epoch ?? 0,
          authenticated: true as const,
        },
      }
      : {}),
    ...(input.request_epoch !== undefined ? { requestEpoch: input.request_epoch } : {}),
  };
}

async function startReservedGeneration(
  input: GenerateInput,
  mode: "response" | "agentic",
  start: () => Promise<{ generationId: string; status: string; mode?: "response" | "agentic"; responseModeAvailable?: true; phase?: string; errorCode?: string }>,
): Promise<{ generationId: string; status: string; mode?: "response" | "agentic"; responseModeAvailable?: true; phase?: string; errorCode?: string }> {
  throwIfGenerationRequestAborted(input.signal);
  const reservationId = `${mode}:${crypto.randomUUID()}`;
  let finishReservation!: () => void;
  const done = new Promise<void>((resolve) => {
    finishReservation = resolve;
  });
  await reserveChatMode(input.userId, input.chat_id, mode, reservationId, done);
  if (input.signal?.aborted) {
    finishReservation();
    releaseChatModeReservation(input.userId, input.chat_id, reservationId);
    throw new DOMException("Generation stopped", "AbortError");
  }
  if (!ownsChatModeReservation(input.userId, input.chat_id, reservationId)) {
    finishReservation();
    throw new AgenticGenerationError("agentic_chat_busy", "Another generation owns this chat.", { retryable: true });
  }
  try {
    throwIfGenerationRequestAborted(input.signal);
    const result = await start();
    if (!ownsChatModeReservation(input.userId, input.chat_id, reservationId)) {
      if (mode === "agentic") {
        await requestAgenticGenerationCancellation(input.userId, result.generationId);
      } else {
        activeGenerations.get(result.generationId)?.terminal.claimAndProject("stopped", { status: "stopped" });
      }
      finishReservation();
      throw new AgenticGenerationError("agentic_chat_busy", "Another generation owns this chat.", { retryable: true });
    }
    chatModeReservations.set(chatModeKey(input.userId, input.chat_id), {
      mode,
      ownerId: result.generationId,
      done,
    });
    if (mode === "agentic") {
      void waitForAgenticGeneration(result.generationId).finally(() => {
        finishReservation();
        releaseChatModeReservation(input.userId, input.chat_id, result.generationId);
      });
    } else {
      const completion = activeGenerations.get(result.generationId)?.completion;
      if (completion) {
        void completion.finally(() => {
          finishReservation();
          releaseChatModeReservation(input.userId, input.chat_id, result.generationId);
        });
      } else {
        finishReservation();
        releaseChatModeReservation(input.userId, input.chat_id, result.generationId);
      }
    }
    return result;
  } catch (error) {
    finishReservation();
    releaseChatModeReservation(input.userId, input.chat_id, reservationId);
    throw error;
  }
}
function callerDecisionTarget(input: AgenticGenerationInput): AgenticTargetSnapshot {
  const generationType = input.generationType;
  if (
    generationType !== "normal"
    && generationType !== "continue"
    && generationType !== "regenerate"
    && generationType !== "swipe"
  ) {
    throw new AgenticGenerationError(
      "agentic_unsupported_surface",
      "This generation surface is only available in Response mode.",
    );
  }
  return {
    generationType,
    ...(input.messageId ? { messageId: input.messageId } : {}),
    ...(input.swipeId !== undefined ? { swipeId: input.swipeId } : {}),
    ...(input.targetCharacterId ? { targetCharacterId: input.targetCharacterId } : {}),
  };
}

async function consumeCallerRuntimeDecision(input: GenerateInput, token: string): Promise<void> {
  const agenticInput = toAgenticGenerationInput(input);
  const signal = agenticInput.signal ?? new AbortController().signal;
  let target: AgenticTargetSnapshot;
  try {
    target = callerDecisionTarget(agenticInput);
  } catch (error) {
    if (error instanceof AgenticGenerationError && error.code === "agentic_unsupported_surface") {
      const claim = agenticGenerationDependencies?.claimRuntimeToken;
      if (!claim) {
        throw new AgenticGenerationError(
          "agentic_runtime_unavailable",
          "Agentic decision authority is unavailable.",
          { phase: "ASSEMBLE", retryable: true },
        );
      }
      await claim(agenticInput, token, signal);
    }
    throw error;
  }
  const consume = agenticGenerationDependencies?.consumeRuntimeToken;
  if (!consume) {
    throw new AgenticGenerationError(
      "agentic_runtime_unavailable",
      "Agentic decision authority is unavailable.",
      { phase: "ASSEMBLE", retryable: true },
    );
  }
  await consume(agenticInput, target, token, signal);
}


async function startAdmittedAgenticGeneration(
  input: GenerateInput,
  requestAuthority?: PendingGenerationRequestAuthority,
) {
  const started = await startAgenticGeneration(
    toAgenticGenerationInput(input),
    agenticGenerationDependencies,
  );
  if (requestAuthority) {
    requestAuthority.generationId = started.generationId;
    if (requestAuthority.sourceAborted || requestAuthority.stopRequested) {
      await requestAgenticGenerationCancellation(input.userId, started.generationId);
    }
  }
  try {
    await waitForAgenticGenerationAdmission(started.generationId);
  } catch (error) {
    // Admission failures are detached terminal turns. Join their cleanup so a
    // rejected token cannot leave a transient chat owner behind.
    await waitForAgenticGeneration(started.generationId);
    throw error;
  }
  return started;
}

function runtimeDecisionRefreshRequired(message: string): AgenticGenerationError {
  return new AgenticGenerationError(
    "decision_refresh_required",
    message,
    { phase: "ASSEMBLE", retryable: true },
  );
}

/**
 * Common authenticated generation admission. A caller-supplied Agentic token
 * is the sole decision authority for that request; tokenless callers resolve
 * through the runtime decision authority before entering either mode.
 */
async function startGenerationAfterRequestAuthority(
  input: GenerateInput,
  options?: StartGenerationOptions,
  requestAuthority?: PendingGenerationRequestAuthority,
): Promise<{ generationId: string; status: string; mode?: "response" | "agentic"; responseModeAvailable?: true; phase?: string; errorCode?: string }> {
  if (input.mode !== undefined && input.mode !== "response" && input.mode !== "agentic") {
    throw new Error("Unsupported generation mode.");
  }

  if (input.mode === "response") {
    setGenerationRequestAuthorityMode(requestAuthority, "response");
    throwIfGenerationRequestAborted(input.signal);
  }

  const callerRuntimeDecisionToken = input.runtime_decision_token;
  if (callerRuntimeDecisionToken !== undefined && (
    typeof callerRuntimeDecisionToken !== "string"
    || callerRuntimeDecisionToken.length === 0
  )) {
    throw runtimeDecisionRefreshRequired("Agentic runtime decision is no longer valid.");
  }
  if (callerRuntimeDecisionToken !== undefined && input.mode === "response") {
    await consumeCallerRuntimeDecision(input, callerRuntimeDecisionToken);
    throw runtimeDecisionRefreshRequired(
      "The supplied Agentic runtime decision does not match explicit Response mode.",
    );
  }

  const requestedGenerationId =
    typeof input.generationId === "string" ? input.generationId.trim() : "";
  if (requestedGenerationId) {
    const existing = activeGenerations.get(requestedGenerationId);
    if (existing && existing.userId === input.userId && existing.chatId === input.chat_id) {
      if (callerRuntimeDecisionToken !== undefined) {
        await consumeCallerRuntimeDecision(input, callerRuntimeDecisionToken);
      }
      return { generationId: requestedGenerationId, status: "streaming" };
    }
    const poolEntry = pool.getPoolEntry(requestedGenerationId);
    if (poolEntry && poolEntry.userId === input.userId && poolEntry.chatId === input.chat_id) {
      if (callerRuntimeDecisionToken !== undefined) {
        await consumeCallerRuntimeDecision(input, callerRuntimeDecisionToken);
      }
      return { generationId: requestedGenerationId, status: "streaming" };
    }
  }

  if (callerRuntimeDecisionToken !== undefined) {
    const agenticInput: GenerateInput = {
      ...input,
      mode: "agentic",
      runtime_decision_token: callerRuntimeDecisionToken,
    };
    setGenerationRequestAuthorityMode(requestAuthority, "agentic");
    return startReservedGeneration(input, "agentic", () =>
      startAdmittedAgenticGeneration(agenticInput, requestAuthority),
    );
  }

  const decision = await resolveEffectiveRuntime(input.userId, toEffectiveRuntimeRequest(input));
  throwIfGenerationRequestAborted(input.signal);
  if (decision.requestedMode === "agentic" && decision.effectiveMode !== "agentic") {
    const reasons = decision.capabilityReadiness.repairCodes.length > 0
      ? decision.capabilityReadiness.repairCodes.join(", ")
      : "agentic_response_escape";
    throw runtimeDecisionRefreshRequired(
      `Agentic mode is unavailable (${reasons}); choose Response mode explicitly to continue.`,
    );
  }

  const mode = decision.effectiveMode;
  let agenticInput = input;
  if (mode === "agentic") {
    if (!decision.runtimeDecisionToken) {
      throw runtimeDecisionRefreshRequired("Agentic runtime decision is no longer valid.");
    }
    agenticInput = {
      ...input,
      mode: "agentic",
      runtime_decision_token: decision.runtimeDecisionToken,
    };
    setGenerationRequestAuthorityMode(requestAuthority, "agentic");
    return startReservedGeneration(input, "agentic", () =>
      startAdmittedAgenticGeneration(agenticInput, requestAuthority),
    );
  }
  // Resolve and commit the concrete Response connection at admission. Prompt
  // assembly still owns an isolated working copy of every other derived field.
  setGenerationRequestAuthorityMode(requestAuthority, "response");
  const responseAdmission = resolveResponseGenerationAdmission(input, options);
  const responseInput: GenerateInput = {
    ...input,
    connection_id: responseAdmission.connection.id,
  };
  return startReservedGeneration(input, "response", () =>
    startResponseGeneration(responseInput, options, responseAdmission),
  );
}

/**
 * Reserve the client request authority before any asynchronous admission.
 * A correlated id-less Stop can therefore retire this request even before a
 * generation ID or chat-mode owner exists.
 */
export async function startGeneration(
  input: GenerateInput,
  options?: StartGenerationOptions,
): Promise<{ generationId: string; status: string; mode?: "response" | "agentic"; responseModeAvailable?: true; phase?: string; errorCode?: string }> {
  const authorityId = normalizeGenerationRequestAuthorityId(input.request_authority_id);
  if (!authorityId) return startGenerationAfterRequestAuthority(input, options);

  const key = generationRequestAuthorityKey(input.userId, input.chat_id, authorityId);
  if (pendingGenerationRequestAuthorities.has(key) || admittedGenerationRequestAuthorities.has(key)) {
    throw new Error("Generation request authority is already active.");
  }

  const controller = new AbortController();
  const reservation: PendingGenerationRequestAuthority = {
    userId: input.userId,
    chatId: input.chat_id,
    authorityId,
    controller,
    sourceAborted: input.signal?.aborted ?? false,
    stopRequested: hasStoppedGenerationRequestAuthority(input.userId, key),
  };
  let retainSourceAbortUntilTerminal = false;
  const onSourceAbort = () => {
    input.signal?.removeEventListener("abort", onSourceAbort);
    reservation.sourceAborted = true;
    if (reservation.mode === "response") {
      controller.abort(input.signal?.reason ?? new DOMException("Generation stopped", "AbortError"));
    } else if (reservation.mode === "agentic" && reservation.generationId) {
      reservation.cancellationResult = settleAbortedAgenticReservation(reservation);
    }
  };
  if (!input.signal?.aborted) input.signal?.addEventListener("abort", onSourceAbort, { once: true });
  pendingGenerationRequestAuthorities.set(key, reservation);

  try {
    const result = await startGenerationAfterRequestAuthority({ ...input, signal: controller.signal }, options, reservation);
    reservation.generationId = result.generationId;
    rememberAdmittedGenerationRequestAuthority(key, input.userId, input.chat_id, authorityId, result.generationId);
    if (reservation.sourceAborted || reservation.stopRequested || controller.signal.aborted || hasStoppedGenerationRequestAuthority(input.userId, key)) {
      if (reservation.sourceAborted && reservation.mode === "agentic") {
        reservation.cancellationResult ??= settleAbortedAgenticReservation(reservation);
        await reservation.cancellationResult;
      } else {
        await stopGeneration(input.userId, result.generationId, input.chat_id);
      }
      throw new DOMException("Generation stopped", "AbortError");
    }
    if (reservation.mode === "agentic" && input.signal) {
      retainSourceAbortUntilTerminal = true;
      const releaseSourceAbort = () => {
        input.signal?.removeEventListener("abort", onSourceAbort);
      };
      void waitForAgenticGeneration(result.generationId)
        .then(releaseSourceAbort, releaseSourceAbort);
    }
    return result;
  } finally {
    if (!retainSourceAbortUntilTerminal) input.signal?.removeEventListener("abort", onSourceAbort);
    if (pendingGenerationRequestAuthorities.get(key) === reservation) {
      pendingGenerationRequestAuthorities.delete(key);
    }
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
  const callerRuntimeDecisionToken = input.runtime_decision_token;
  if (callerRuntimeDecisionToken !== undefined) {
    await consumeCallerRuntimeDecision(input, callerRuntimeDecisionToken);
  }
  if (input.mode === "agentic") {
    throw new AgenticGenerationError(
      "agentic_unsupported_surface",
      "Agentic dry-run inspection is only available in Response mode.",
    );
  }
  const genType = input.generation_type || "normal";
  const sourceMessages = chatsSvc.getMessages(input.userId, input.chat_id);
  const sourceMessagesById = new Map(
    sourceMessages.map((message) => [message.id, message] as const),
  );
  const dryRunReasoningSettings =
    settingsSvc.getSetting(input.userId, "reasoningSettings")?.value ?? null;

  // No-preset temp chats bypass preset resolution/assertion (same as
  // startGeneration); assembly falls back to raw message mapping.
  const dryRunChat = chatsSvc.getChat(input.userId, input.chat_id);
  const dryRunIsGroupChat = dryRunChat?.metadata?.group === true;
  const dryRunGroupCharacterIds =
    dryRunIsGroupChat && Array.isArray(dryRunChat?.metadata?.character_ids)
      ? (dryRunChat.metadata.character_ids as string[])
      : [];
  const dryRunTargetCharacterId =
    dryRunIsGroupChat &&
    typeof input.target_character_id === "string" &&
    dryRunGroupCharacterIds.includes(input.target_character_id)
      ? input.target_character_id
      : undefined;
  const isNoPresetChat = isNoPresetChatMetadata(dryRunChat?.metadata);
  if (isNoPresetChat) {
    input.preset_id = undefined;
    input.force_preset_id = false;
  } else if (!input.preset_id) {
    input.preset_id = resolveActivePresetId(input.userId);
  }

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

  const connection = resolveChatGenerationConnection(
    input.userId,
    dryRunChat?.metadata,
    input.connection_id,
  );
  input.connection_id = connection.id;
  if (!isNoPresetChat) {
    presetsSvc.assertUsablePreset(
      input.userId,
      input.preset_id,
      connection.preset_id,
    );
  }
  const { provider } = await resolveProviderAndKey(input.userId, connection.id);

  const dryRunContinueTarget =
    genType === "continue"
      ? input.message_id
        ? sourceMessagesById.get(input.message_id) ?? null
        : [...sourceMessages].reverse().find((message) => !message.is_user) ?? null
      : null;
  const dryRunPresetId = input.preset_id || connection.preset_id;
  const dryRunContinueConfiguredPostfix = dryRunPresetId
    ? presetsSvc.getPreset(input.userId, dryRunPresetId)?.prompts
        ?.completionSettings?.continuePostfix || ""
    : "";
  const dryRunContinuePostfix = dryRunContinueTarget
    ? resolveContinuePostfix(
        dryRunContinueTarget.content,
        dryRunContinueConfiguredPostfix,
      )
    : undefined;

  const pipeline = await runPromptPipeline({
    userId: input.userId,
    userName: input.userName,
    generationId: crypto.randomUUID(),
    assemblySurface: "RESPONSE",
    chatId: input.chat_id,
    connectionId: input.connection_id,
    model: connection.model,
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
    userInput: input.user_input,
    inputMessages: input.messages,
    inputParameters: input.parameters,
    excludeMessageId: input.exclude_message_id,
    continueMessageId: dryRunContinueTarget?.id,
    continuePostfix: dryRunContinuePostfix,
    targetCharacterId: dryRunTargetCharacterId,
    signal: input.signal,
    isDryRun: true,
  });

  // Compute token counts for the breakdown
  let tokenCount: DryRunResult["tokenCount"];
  let chatHistoryTokens: number | undefined;
  if (pipeline.breakdown && pipeline.breakdown.length > 0) {
    try {
      tokenCount = await tokenizerSvc.countBreakdown(
        connection.model,
        pipeline.breakdown,
        pipeline.chatHistoryMessages,
      );
      chatHistoryTokens = sumChatHistoryBreakdownTokens(tokenCount.breakdown);
    } catch {
      // non-fatal: skip token count if tokenizer fails
    }
  }

  // Build ground-truth outbound parameters: strip internal-only keys that
  // never reach the provider, and inject defaults the provider would add.
  const outboundParams: Record<string, any> = { ...pipeline.parameters };
  delete outboundParams.max_context_length;
  delete outboundParams._include_usage;
  injectConnectionMetadataFlags(connection, outboundParams);

  // Providers with requiresMaxTokens inject a default when max_tokens is absent
  if (
    provider.capabilities.requiresMaxTokens &&
    outboundParams.max_tokens === undefined
  ) {
    outboundParams.max_tokens =
      provider.capabilities.parameters.max_tokens?.default ?? 4096;
  }

  return {
    assemblySurface: pipeline.assemblySurface,
    loomPromptInspection: pipeline.loomPromptInspection,
    // The dry-run viewer is display-only and assumes string content. Flatten
    // multimodal parts (image/audio/tool) to placeholder-annotated strings so
    // multipart turns don't crash the frontend (TypeError: e.replace is not a
    // function) when a chat message carries an attachment. Emit structured
    // non-text part counts alongside the flattened content so the viewer can
    // badge media-bearing turns without having to re-parse placeholder text.
    // When the source chat message preserved reasoning separately, attach it
    // alongside the flattened content so the viewer can show both. Token
    // counts come from the breakdown above, which is already computed from the
    // real parts.
    messages: buildDryRunDisplayMessages(
      pipeline.messages,
      sourceMessagesById,
      dryRunReasoningSettings,
    ),
    breakdown: omitChatHistoryBreakdownEntries(pipeline.breakdown || []),
    parameters: outboundParams,
    assistantPrefill: pipeline.assistantPrefill,
    model: connection.model,
    provider: provider.name,
    tokenCount: omitChatHistoryTokenBreakdown(tokenCount),
    chatHistoryTokens,
    worldInfoStats: pipeline.worldInfoStats,
    memoryStats: pipeline.memoryStats,
    databankStats: pipeline.databankStats,
    contextClipStats: pipeline.contextClipStats,
  };
}

async function runGeneration(
  generationId: string,
  provider: import("../llm/provider").LlmProvider,
  providerId: string,
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
  inlineToolSafeNames?: ReadonlyMap<string, string>,
  inlineWebSearchEnabled = false,
  inlineToolTimeoutMs?: number,
  assistantPrefill?: string,
  assistantReasoningPrefill?: string,
  macroEnv?: import("../macros/types").MacroEnv,
  macroEnvSeed?: import("../macros/types").MacroEnv,
  agentRuntimeOwner?: AgentRuntimeOwner,
): Promise<void> {
  const effectiveSignal = agentRuntimeOwner
    ? AbortSignal.any([signal, agentRuntimeOwner.ledger.signal])
    : signal;
  // GENERATION_STARTED was already emitted when the pool entry was created
  // (before assembly). Once the provider stream is live, emit a lighter
  // progress event with the resolved breakdown metadata.
  // Pool status transitions to 'streaming' when the first actual token arrives
  // so that reconnecting clients see 'assembling' while waiting for TTFT.
  pool.markStreamingStarted(generationId);

  type PendingStreamSegment = {
    token: string;
    type?: "reasoning";
    // seq is the tokenSeq of the LAST token merged into this segment; startSeq
    // is the FIRST. Retained for Spindle extensions and stale (pre-refresh)
    // clients; the frontend now reconciles via `offset` instead.
    seq: number;
    startSeq: number;
    // Char position of this segment's first token within the cumulative pool
    // buffer for its stream type (content or reasoning). Lets clients dedupe
    // exactly against recovery snapshots (slice off the overlap) and detect
    // gaps (offset ahead of local buffer → re-poll immediately).
    offset: number;
  };

  const streamTopic = `stream:${userId}:${chatId}`;
  const STREAM_EMIT_INTERVAL_MS = 40;
  const STREAM_EMIT_MAX_CHARS = 768;
  let pendingStreamSegments: PendingStreamSegment[] = [];
  let pendingStreamChars = 0;
  let streamFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let lastStreamFlushAt = 0;

  function flushPendingStreamSegments(): void {
    if (streamFlushTimer) {
      clearTimeout(streamFlushTimer);
      streamFlushTimer = null;
    }
    if (pendingStreamSegments.length === 0) return;

    const segments = pendingStreamSegments;
    pendingStreamSegments = [];
    pendingStreamChars = 0;
    lastStreamFlushAt = Date.now();

    for (const segment of segments) {
      eventBus.emit(
        EventType.STREAM_TOKEN_RECEIVED,
        {
          generationId,
          chatId,
          token: segment.token,
          ...(segment.type ? { type: segment.type } : {}),
          seq: segment.seq,
          startSeq: segment.startSeq,
          offset: segment.offset,
        },
        userId,
        { topic: streamTopic },
      );
    }
  }

  function schedulePendingStreamFlush(): void {
    if (streamFlushTimer) return;
    // Leading-edge after idle: if the last flush is older than the emit
    // interval, fire immediately (delay 0) instead of holding the buffer the
    // full interval. Takes ~40ms off TTFT and off every quiet-period
    // resumption (reasoning→content transitions) without raising the steady
    // emit rate.
    const elapsed = Date.now() - lastStreamFlushAt;
    const delay = Math.max(0, STREAM_EMIT_INTERVAL_MS - elapsed);
    streamFlushTimer = setTimeout(() => {
      flushPendingStreamSegments();
    }, delay);
  }

  function queueStreamSegment(token: string, seq: number, offset: number, type?: "reasoning"): void {
    const previous = pendingStreamSegments[pendingStreamSegments.length - 1];
    if (previous && previous.type === type) {
      previous.token += token;
      previous.seq = seq;
    } else {
      pendingStreamSegments.push({ token, seq, startSeq: seq, offset, ...(type ? { type } : {}) });
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
      requestAuthorityId: pool.getPoolEntry(generationId)?.requestAuthorityId,
      model,
      provider: providerId,
      targetMessageId: lifecycle.targetMessageId,
      targetSwipeId: lifecycle.streamingSwipeId,
      characterId: lifecycle.targetCharacterId,
      characterName: lifecycle.characterName,
      contextClipStats: lifecycle.contextClipStats,
    },
    userId,
  );

  let fullContent = "";
  let fullReasoning = "";
  const trimIncompleteWords = lifecycle.trimIncompleteWords === true;
  let responseBehaviorOptions:
    | {
        source: "response_backend";
        previousContent?: string;
      }
    | undefined;
  const getResponseBehaviorOptions = () => {
    if (responseBehaviorOptions) return responseBehaviorOptions;
    const beforeMessageId =
      lifecycle.continueMessageId
      ?? lifecycle.targetMessageId
      ?? lifecycle.stagedMessageId;
    const previousContent = chatsSvc.getPreviousSameRoleContent(
      userId,
      chatId,
      false,
      beforeMessageId,
    );
    responseBehaviorOptions = {
      source: "response_backend",
      ...(previousContent !== undefined ? { previousContent } : {}),
    };
    return responseBehaviorOptions;
  };
  const responseOptionsFor = (scripts: readonly { metadata?: Record<string, any> }[]) =>
    regexScriptsSvc.hasRegexMatchAction(scripts, "repeat_back")
      ? getResponseBehaviorOptions()
      : { source: "response_backend" as const };

  let streamUsage: GenerationResponse["usage"];
  let roundUsage: GenerationResponse["usage"];
  let agentUsageMerged = false;
  const settleRoundUsage = (): void => {
    if (roundUsage === undefined) return;
    const settled = roundUsage;
    roundUsage = undefined;
    streamUsage = settleGenerationRoundUsage(
      streamUsage,
      settled,
      agentRuntimeOwner !== undefined,
    );
  };
  const mergeAgentUsage = (): void => {
    if (agentUsageMerged) return;
    agentUsageMerged = true;
    streamUsage = addAgentUsageToGenerationUsage(
      streamUsage,
      agentRuntimeOwner?.usage,
    );
  };
  const persistAgentSummaryForGeneratedAssistant = (
    messageId: string | undefined,
  ): void => {
    const agentSummary = agentRuntimeOwner?.summary;
    const swipeId = lifecycle.streamingSwipeId;
    if (
      !messageId ||
      !agentSummary ||
      !isAgentSummaryPersistenceTarget(lifecycle, messageId, swipeId)
    ) {
      return;
    }

    const storedMessage = chatsSvc.getMessage(userId, messageId);
    if (
      !storedMessage ||
      storedMessage.chat_id !== chatId ||
      storedMessage.is_user ||
      swipeId >= storedMessage.swipes.length
    ) {
      return;
    }

    chatsSvc.setSwipeScopedExtra(
      userId,
      messageId,
      swipeId,
      { agentActivity: agentSummary },
    );
  };
  let reasoningStartedAt = 0;
  let reasoningDurationMs = 0;
  // Keep the provider-native carrier independently from the text shown in the
  // Reasoning tab. `fullReasoning` also contains parsed CoT, which must never
  // be replayed as API reasoning on a later assistant history turn.
  let nativeReasoningContent = "";
  let nativeThinkingBlocks: LlmThinkingBlock[] | undefined;
  let nativeReasoningDetails: Record<string, unknown>[] | undefined;
  let nativeThoughtSignature: string | undefined;

  const persistedNativeReasoningCarrier = (): Record<string, unknown> | undefined => {
    // Agentic work carriers are frame-private by contract. Only Response
    // history may retain the provider-native replay payload on its target
    // swipe, and never the display-only parsed reasoning text.
    if (agentRuntimeOwner) return undefined;
    if (nativeThinkingBlocks && nativeThinkingBlocks.length > 0) {
      return {
        type: "thinking_blocks",
        blocks: nativeThinkingBlocks.map((block) => ({ ...block })),
      };
    }
    if (nativeReasoningDetails && nativeReasoningDetails.length > 0) {
      return {
        type: "reasoning_details",
        details: nativeReasoningDetails.map((detail) => ({ ...detail })),
      };
    }
    if (nativeThoughtSignature) {
      return {
        type: "gemini_thought_signature",
        signature: nativeThoughtSignature,
      };
    }
    if (nativeReasoningContent.length > 0) {
      return {
        type: "reasoning_content",
        content: nativeReasoningContent,
      };
    }
    return undefined;
  };


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
    const appended = pool.appendPoolContent(generationId, text);
    queueStreamSegment(text, appended.seq, appended.offset);
  }

  function emitReasoningToken(text: string) {
    if (!text) return;
    if (!reasoningStartedAt) reasoningStartedAt = Date.now();
    fullReasoning += text;
    const appended = pool.appendPoolReasoning(generationId, text);
    queueStreamSegment(text, appended.seq, appended.offset, "reasoning");
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
    if (useStreaming && trimIncompleteWords) {
      closedContent = trimIncompleteStreamTail(closedContent);
    }

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
        undefined,
        responseOptionsFor(responseScripts),
      );
      if (fullReasoning) {
        fullReasoning = await regexScriptsSvc.applyRegexScripts(
          fullReasoning,
          responseScripts,
          "reasoning",
          0,
          macroEnv,
          undefined,
          responseOptionsFor(responseScripts),
        );
      }
    }
    closedContent = healFormattingArtifacts(closedContent);
    const nativeCarrier = persistedNativeReasoningCarrier();

    let messageId: string | undefined;
    if (lifecycle.targetMessageId && lifecycle.targetSwipeIdx != null) {
      const updated = chatsSvc.updateSwipe(
        userId,
        lifecycle.targetMessageId,
        lifecycle.targetSwipeIdx,
        closedContent,
      );
      messageId = updated?.id ?? lifecycle.targetMessageId;
      if (fullReasoning || streamUsage || nativeCarrier) {
        // Target the regenerated swipe, not the displayed one (the user may have
        // navigated away mid-stream before stopping).
        chatsSvc.setSwipeScopedExtra(
          userId,
          lifecycle.targetMessageId,
          lifecycle.streamingSwipeId,
          {
            ...(fullReasoning ? { reasoning: fullReasoning } : {}),
            ...(streamUsage ? { usage: streamUsage } : {}),
            ...(nativeCarrier ? { reasoningCarrier: nativeCarrier } : {}),
          },
        );
      }
    } else if (lifecycle.stagedMessageId) {
      if (!closedContent && !fullReasoning && !streamUsage && !nativeCarrier) {
        try {
          chatsSvc.deleteMessage(userId, lifecycle.stagedMessageId);
        } catch {
          /* best-effort cleanup */
        }
        return { content: closedContent };
      }

      const existingStagedExtra =
        chatsSvc.getMessage(userId, lifecycle.stagedMessageId)?.extra || {};
      const partialExtra =
        fullReasoning || streamUsage || nativeCarrier
          ? {
              ...existingStagedExtra,
              ...(fullReasoning ? { reasoning: fullReasoning } : {}),
              ...(streamUsage ? { usage: streamUsage } : {}),
              ...(nativeCarrier ? { reasoningCarrier: nativeCarrier } : {}),
            }
          : existingStagedExtra;
      chatsSvc.updateMessage(userId, lifecycle.stagedMessageId, {
        content: closedContent,
        ...(Object.keys(partialExtra).length > 0
          ? { extra: partialExtra }
          : {}),
        skipCouncilCacheInvalidation: true,
      });
      messageId = lifecycle.stagedMessageId;
    } else if (
      lifecycle.continueMessageId &&
      (closedContent || streamUsage || nativeCarrier)
    ) {
      const combined =
        (lifecycle.continueOriginalContent ?? "") +
        (lifecycle.continuePostfix ?? "") +
        closedContent;
      // Append onto the continued swipe (not the displayed one, in case the user
      // navigated away before stopping).
      chatsSvc.updateMessage(userId, lifecycle.continueMessageId, {
        content: combined,
        contentSwipeId: lifecycle.streamingSwipeId,
        skipCouncilCacheInvalidation: true,
      });
      if (fullReasoning || streamUsage || nativeCarrier) {
        chatsSvc.setSwipeScopedExtra(
          userId,
          lifecycle.continueMessageId,
          lifecycle.streamingSwipeId,
          {
            ...(fullReasoning ? { reasoning: fullReasoning } : {}),
            ...(streamUsage ? { usage: streamUsage } : {}),
            ...(nativeCarrier ? { reasoningCarrier: nativeCarrier } : {}),
          },
        );
      }
      messageId = lifecycle.continueMessageId;
    } else if (lifecycle.impersonateDraft) {
      // Impersonate draft: do not persist the partial content as a message.
      // The streamed text is already in the frontend's input box.
    } else if (closedContent || nativeCarrier) {
      const isImpersonate = lifecycle.generationType === "impersonate";
      const extra: Record<string, any> = {};
      if (isImpersonate && lifecycle.personaId)
        extra.persona_id = lifecycle.personaId;
      if (!isImpersonate && lifecycle.targetCharacterId)
        extra.character_id = lifecycle.targetCharacterId;
      if (fullReasoning) extra.reasoning = fullReasoning;
      if (!isImpersonate && streamUsage) extra.usage = streamUsage;
      if (!isImpersonate && nativeCarrier) extra.reasoningCarrier = nativeCarrier;
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

    persistAgentSummaryForGeneratedAssistant(messageId);
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
  if (assistantReasoningPrefill) {
    emitReasoningToken(assistantReasoningPrefill);
  }
  if (assistantPrefill) {
    processContentToken(assistantPrefill);
  }

  // Prefill is explicitly authored and complete by definition. Only the
  // provider-produced tail is eligible for incomplete-word trimming.
  const assistantPrefillContentLength = fullContent.length;
  const trimIncompleteStreamTail = (content: string): string =>
    content.slice(0, assistantPrefillContentLength) +
    trimIncompleteTrailingWord(content.slice(assistantPrefillContentLength));

  // Determine streaming mode from _streaming parameter (defaults to true)
  const useStreaming = parameters._streaming !== false;
  delete parameters._streaming;

  // Record streaming mode on the pool entry for metrics
  const poolEntry = pool.getPoolEntry(generationId);
  if (poolEntry) poolEntry.wasStreaming = useStreaming;

  let emittedStopped = false;
  let reconcileActiveRoundUsage: (() => Promise<void>) | undefined;
  try {
    const inlineMcpTimeoutMs = tools?.length
      ? inlineToolTimeoutMs ?? getCouncilSettings(userId).toolsSettings.timeoutMs
      : 30_000;
    let generationMessages = messages;

    const agentToolsExposed =
      agentRuntimeOwner?.getMainToolDefinitions().length
        ? true
        : false;
    const ordinaryValidationDefinitions = buildInlineToolValidationDefinitions(
      userId,
      inlineToolDefsByName,
      inlineMembersByPrefix,
    );
    // Council-only rounds retain their legacy compatibility path unless the
    // provider explicitly supports interleaved thinking. Agent-owned tools may
    // additionally use providers that advertise native tool continuation.
    const continuationPolicy = resolveInlineToolContinuationPolicy(
      !!tools?.length,
      agentToolsExposed,
      provider.capabilities,
    );
    if (agentToolsExposed && tools?.length) {
      try {
        assertAgentToolCapability(provider);
      } catch (error) {
        if (error instanceof AgentToolCapabilityError) {
          throw new AgentRuntimeFailure(error.code);
        }
        throw error;
      }
    }
    const maxInlineRounds = agentRuntimeOwner
      ? Number.MAX_SAFE_INTEGER
      : INLINE_TOOL_MAX_ROUNDS;
    let sawToolCalls = false;
    let inlineRound = 0;
    let nextBatchReservation: ToolBatchReservation | null = null;
    let agentBudgetExhausted = false;
    let finalizationMode = false;
    let providerTransientCarrier: ProviderTransientCarrier | undefined;
    let activeProviderRoundStartedAt: number | undefined;
    let activeProviderRoundMode: "ordinary" | "finalization" = "ordinary";
    let inlineWebSearchUsed = false;
    for (; inlineRound < maxInlineRounds; inlineRound++) {
      // fullContent/fullReasoning accumulate across rounds for the final
      // persisted message; capture the start offsets so we can slice out just
      // this round's delta for the continuation we feed back to the provider.
      activeProviderRoundStartedAt = Date.now();
      activeProviderRoundMode = finalizationMode ? "finalization" : "ordinary";
      agentRuntimeOwner?.recordRootProviderRound(
        "queued",
        inlineRound,
        activeProviderRoundMode,
        activeProviderRoundStartedAt,
      );
      const roundContentStart = fullContent.length;
      const roundReasoningStart = fullReasoning.length;
      let pendingProviderTransientCarrier: ProviderTransientCarrier | undefined;
      let pendingToolCalls: ToolCallResult[] | undefined;
      // Provider-native reasoning blocks (Anthropic thinking blocks with
      // signatures) captured this round, replayed on the structured continuation.
      let pendingThinkingBlocks: LlmThinkingBlock[] | undefined;
      // OpenRouter reasoning_details captured this round, replayed likewise.
      let pendingReasoningDetails: Record<string, unknown>[] | undefined;
      let pendingThoughtSignature: string | undefined;
      const observedContentParts: string[] = [];
      const observedReasoningParts: string[] = [];
      let observedFinishReason = "";
      let roundObservationPromise: Promise<void> | undefined;
      let roundTerminalRecorded = false;
      const captureRoundObservation = (chunk: StreamChunk): void => {
        if (!agentRuntimeOwner) return;
        if (chunk.token) observedContentParts.push(chunk.token);
        if (chunk.reasoning) observedReasoningParts.push(chunk.reasoning);
      };
      const reconcileRoundUsage = (): Promise<void> => {
        if (!agentRuntimeOwner) return Promise.resolve();
        if (!roundObservationPromise) {
          roundObservationPromise = (async () => {
            const observedOutputTokens = await observeAgentProviderOutput(
              model,
              {
                content: observedContentParts.join(""),
                ...(observedReasoningParts.length > 0
                  ? { reasoning: observedReasoningParts.join("") }
                  : {}),
                finish_reason: observedFinishReason,
                tool_calls: pendingToolCalls,
                providerTransientCarrier: pendingProviderTransientCarrier,
                thinking_blocks: pendingThinkingBlocks,
                reasoning_details: pendingReasoningDetails,
              },
              effectiveSignal,
            );
            roundUsage = reconcileObservedGenerationUsage(
              roundUsage,
              observedOutputTokens,
            );
          })();
        }
        return roundObservationPromise;
      };
      reconcileActiveRoundUsage = reconcileRoundUsage;
      const recordRootRoundTerminal = async (
        phase: "completed" | "failed" | "cancelled",
        toolCalls = 0,
        errorCode?: AgentPublicErrorCode,
      ): Promise<unknown> => {
        if (!agentRuntimeOwner || roundTerminalRecorded) return undefined;
        let observationError: unknown;
        try {
          await reconcileRoundUsage();
        } catch (error) {
          observationError = error;
        }
        const terminalPhase =
          observationError && phase === "completed" ? "failed" : phase;
        const terminalErrorCode = observationError
          ? publicTerminalCodeForError(observationError) ?? "provider_protocol_error"
          : errorCode;
        agentRuntimeOwner.recordRootProviderRound(
          terminalPhase,
          inlineRound,
          activeProviderRoundMode,
          activeProviderRoundStartedAt ?? Date.now(),
          roundUsage,
          toolCalls,
          terminalErrorCode,
        );
        roundTerminalRecorded = true;
        return observationError;
      };
      const reservedBatch = nextBatchReservation;
      nextBatchReservation = null;
      let logicalRequest: AgentLedgerReservation | null = null;
      if (agentRuntimeOwner && !reservedBatch) {
        logicalRequest = agentRuntimeOwner.ledger.reserve(
          "logical_provider_requests",
          1,
        );
        if (!logicalRequest) {
          const error = new AgentRuntimeFailure(
            agentRuntimeOwner.ledger.failure?.code ??
              "logical_provider_request_limit_exceeded",
          );
          await recordRootRoundTerminal(
            "failed",
            0,
            publicTerminalCodeForError(error) ?? "provider_request_error",
          );
          throw error;
        }
      }

      // Non-streaming path: call generate() once, then synthesize a single-chunk stream.
      // Wrapped in a factory so the pre-token retry below can re-issue a clean request.
      const makeStream = (
        requestTools: ToolDefinition[] | undefined = tools,
      ): AsyncGenerator<StreamChunk, void, unknown> => useStreaming
        ? provider.generateStream(apiKey, apiUrl, {
            messages: prepareInlineWebSearchMessagesForProvider(generationMessages),
            model,
            parameters,
            stream: true,
            tools: requestTools,
            signal: effectiveSignal,
            toolMode: finalizationMode ? "finalization" : (agentRuntimeOwner ? "ordinary" : undefined),
            providerTransientCarrier,
            receiveLimitBytes: agentRuntimeOwner ? 2 * 1024 * 1024 : undefined,
          })
        : (async function* () {
            const result = await provider.generate(apiKey, apiUrl, {
              messages: prepareInlineWebSearchMessagesForProvider(generationMessages),
              model,
              parameters,
              stream: false,
              tools: requestTools,
              signal: effectiveSignal,
              toolMode: finalizationMode ? "finalization" : (agentRuntimeOwner ? "ordinary" : undefined),
              providerTransientCarrier,
              receiveLimitBytes: agentRuntimeOwner ? 2 * 1024 * 1024 : undefined,
            });
            yield {
              token: result.content,
              reasoning: result.reasoning,
              finish_reason: result.finish_reason,
              tool_calls: result.tool_calls,
              providerTransientCarrier: result.providerTransientCarrier,
              thinking_blocks: result.thinking_blocks,
              reasoning_details: result.reasoning_details,
              thought_signature: result.thought_signature,
              usage: result.usage,
            };
          })();

      // Establish the stream and pull its FIRST chunk under a bounded retry.
      // Streaming providers throw transport/HTTP errors on the first `.next()`
      // (before the body reader exists), so a retry here re-issues a clean
      // request and cannot duplicate emitted tokens. Once the first chunk lands
      // we never retry — mid-stream failures fall through to the outer catch.
      let iter!: AsyncIterator<StreamChunk, void>;
      let firstResult!: IteratorResult<StreamChunk, void>;
      let providerPermit: AgentAdmissionPermit | null = null;
      for (let attempt = 0; ; attempt++) {
        let attemptPermit: AgentAdmissionPermit | null = null;
        if (agentRuntimeOwner) {
          if (reservedBatch && attempt === 0) {
            reservedBatch.consumeDispatch();
            attemptPermit = reservedBatch.providerPermit;
          } else {
            const physicalAttempt = agentRuntimeOwner.ledger.reserve(
              "physical_dispatch_attempts",
              1,
            );
            if (!physicalAttempt) {
              logicalRequest?.release();
              reservedBatch?.release();
              const error = new AgentRuntimeFailure(
                agentRuntimeOwner.ledger.failure?.code ??
                  "physical_dispatch_attempt_limit_exceeded",
              );
              await recordRootRoundTerminal(
                effectiveSignal.aborted ? "cancelled" : "failed",
                0,
                publicTerminalCodeForError(error) ?? "provider_request_error",
              );
              throw error;
            }
            attemptPermit = agentRuntimeOwner.ledger.acquireProviderPermit();
            if (!attemptPermit) {
              physicalAttempt.release();
              logicalRequest?.release();
              reservedBatch?.release();
              const error = new AgentRuntimeFailure(
                agentRuntimeOwner.ledger.failure?.code ?? "capacity_exceeded",
              );
              await recordRootRoundTerminal(
                effectiveSignal.aborted ? "cancelled" : "failed",
                0,
                publicTerminalCodeForError(error) ?? "provider_request_error",
              );
              throw error;
            }
            logicalRequest?.consume();
            physicalAttempt.consume();
          }
          if (!attemptPermit) {
            reservedBatch?.release();
            const error = new AgentRuntimeFailure(
              agentRuntimeOwner.ledger.failure?.code ?? "capacity_exceeded",
            );
            await recordRootRoundTerminal(
              effectiveSignal.aborted ? "cancelled" : "failed",
              0,
              publicTerminalCodeForError(error) ?? "provider_request_error",
            );
            throw error;
          }
        }
        let candidate: AsyncIterator<StreamChunk, void> | undefined;
        try {
          agentRuntimeOwner?.recordRootProviderRound(
            "running",
            inlineRound,
            activeProviderRoundMode,
            activeProviderRoundStartedAt ?? Date.now(),
          );
          candidate = makeStream(finalizationMode ? [] : tools)[Symbol.asyncIterator]();
          firstResult = await raceWithSignal(candidate.next(), effectiveSignal);
          iter = candidate;
          providerPermit = attemptPermit;
          break;
        } catch (err) {
          if (attemptPermit && agentRuntimeOwner) {
            if (reservedBatch?.providerPermit === attemptPermit) {
              reservedBatch.releaseDispatch();
            } else {
              agentRuntimeOwner.ledger.releaseOperationPermit(attemptPermit);
            }
          }
          closeProviderIterator(candidate);
          const retryable =
            attempt < GENERATION_MAX_RETRIES &&
            !effectiveSignal.aborted &&
            err instanceof ProviderRequestError &&
            err.retryable;
          if (!retryable) {
            const observationError = await recordRootRoundTerminal(
              effectiveSignal.aborted ? "cancelled" : "failed",
              0,
              effectiveSignal.aborted
                ? "cancelled"
                : publicTerminalCodeForError(err) ?? "provider_request_error",
            );
            if (observationError) throw observationError;
            throw err;
          }
          try {
            await abortableSleep(
              computeBackoffMs(attempt, (err as ProviderRequestError).retryAfterMs),
              effectiveSignal,
            );
          } catch {
            const observationError = await recordRootRoundTerminal(
              "cancelled",
              0,
              "cancelled",
            );
            if (observationError) throw observationError;
            // Aborted during backoff — surface the original provider error.
            throw err;
          }

      }
      }
      // Drive the iterator manually so each `.next()` can be raced against the
      // abort signal. Streaming providers forward aborts only until response
      // headers arrive (so preflight stops cancel the upstream request), then
      // switch to user-space read cancellation to avoid Bun's mid-stream abort
      // crash on Windows.
      try {
        const maybeYieldDuringStream = createCooperativeYielder(32, effectiveSignal);
        let consumedFirst = false;
        while (true) {
        let result: IteratorResult<StreamChunk, void>;
        if (!consumedFirst) {
          // The first chunk was already obtained (and signal-raced) during
          // stream establishment above; process it before resuming the pull.
          consumedFirst = true;
          result = firstResult;
        } else {
          try {
            result = await raceWithSignal(iter.next(), effectiveSignal);
          } catch (err) {
            // Signal won the race. Request generator cleanup without awaiting
            // an implementation whose return is queued behind this pending pull.
            closeProviderIterator(iter);
            const observationError = await recordRootRoundTerminal(
              effectiveSignal.aborted ? "cancelled" : "failed",
              0,
              effectiveSignal.aborted
                ? "cancelled"
                : publicTerminalCodeForError(err) ?? "provider_protocol_error",
            );
            if (observationError) throw observationError;
            throw err;
          }
        }
        if (result.done) {
          if (agentRuntimeOwner) {
            if (effectiveSignal.aborted) {
              const observationError = await recordRootRoundTerminal(
                "cancelled",
                0,
                "cancelled",
              );
              if (observationError) throw observationError;
              break;
            }
            const error = new ProviderProtocolError(
              "Provider stream ended without a terminal chunk",
            );
            const observationError = await recordRootRoundTerminal(
              "failed",
              0,
              "provider_protocol_error",
            );
            if (observationError) throw observationError;
            throw error;
          }
          break;
        }
        const chunk = result.value;
        if (chunk.providerTransientCarrier) {
          assertResponsesProviderCarrier(chunk.providerTransientCarrier);
        }
        captureRoundObservation(chunk);
        if (agentRuntimeOwner && chunk.usage !== undefined) {
          try {
            roundUsage = validatedGenerationUsage(chunk.usage);
          } catch (error) {
            const observationError = await recordRootRoundTerminal(
              "failed",
              pendingToolCalls?.length ?? 0,
              publicTerminalCodeForError(error) ?? "provider_protocol_error",
            );
            if (observationError) throw observationError;
            throw error;
          }
        }

        if (effectiveSignal.aborted) {
          const observationError = await recordRootRoundTerminal(
            "cancelled",
            0,
            "cancelled",
          );
          settleRoundUsage();
          mergeAgentUsage();
          await persistPartialContent();
          flushPendingStreamSegments();
          claimGenerationTerminal(generationId, "stopped", {
            status: "stopped",
          });
          emittedStopped = true;
          closeProviderIterator(iter);
          if (observationError) throw observationError;
          break;
        }

        // The generation watchdog is based on upstream token activity, not
        // total request age. Count reasoning as well as visible content: both
        // are streamed model output and demonstrate the provider is healthy.
        if (chunk.reasoning || chunk.token) {
          const entry = activeGenerations.get(generationId);
          if (entry) entry.lastTokenAt = Date.now();
        }

        if (chunk.reasoning) {
          if (!reasoningStartedAt) reasoningStartedAt = Date.now();
          fullReasoning += chunk.reasoning;
          nativeReasoningContent += chunk.reasoning;
          const appended = pool.appendPoolReasoning(
            generationId,
            chunk.reasoning,
          );
          queueStreamSegment(chunk.reasoning, appended.seq, appended.offset, "reasoning");
        }

        if (chunk.token) {
          processContentToken(chunk.token);
        }

        if (chunk.tool_calls) {
          pendingToolCalls = chunk.tool_calls;
        }
        if (chunk.providerTransientCarrier) {
          pendingProviderTransientCarrier = chunk.providerTransientCarrier;
        }

        if (chunk.thinking_blocks) {
          pendingThinkingBlocks = chunk.thinking_blocks;
          nativeThinkingBlocks = [
            ...(nativeThinkingBlocks ?? []),
            ...chunk.thinking_blocks,
          ];
        }

        if (chunk.reasoning_details) {
          pendingReasoningDetails = chunk.reasoning_details;
          nativeReasoningDetails = [
            ...(nativeReasoningDetails ?? []),
            ...chunk.reasoning_details,
          ];
        }

        if (chunk.thought_signature) {
          pendingThoughtSignature = chunk.thought_signature;
          nativeThoughtSignature = chunk.thought_signature;
        }

        // Feature-inactive generation keeps staging's unchecked provider
        // usage shape; round settlement still accumulates every request.
        if (!agentRuntimeOwner && chunk.usage) {
          roundUsage = chunk.usage;
        }

        await maybeYieldDuringStream();

        if (chunk.finish_reason) {
          observedFinishReason = chunk.finish_reason;
          validateTerminalProviderToolBatch(
            observedFinishReason,
            pendingToolCalls,
          );
          if (!agentRuntimeOwner) {
            closeProviderIterator(iter);
            break;
          }
          try {
            while (true) {
              const trailing = await raceWithSignal(
                iter.next(),
                effectiveSignal,
              );
              if (trailing.done) break;
              captureRoundObservation(trailing.value);
              if (isUsageOnlyStreamChunk(trailing.value)) {
                roundUsage = validatedGenerationUsage(trailing.value.usage);
                continue;
              }
              throw new ProviderProtocolError(
                "Provider stream emitted data after its terminal chunk",
              );
            }
          } catch (error) {
            const observationError = await recordRootRoundTerminal(
              effectiveSignal.aborted ? "cancelled" : "failed",
              pendingToolCalls?.length ?? 0,
              effectiveSignal.aborted
                ? "cancelled"
                : publicTerminalCodeForError(error) ??
                  "provider_protocol_error",
            );
            if (observationError) throw observationError;
            throw error;
          }

          let observationError: unknown;
          try {
            await reconcileRoundUsage();
          } catch (error) {
            observationError = error;
          }
          const completedUsage = roundUsage;
          if (observationError) {
            agentRuntimeOwner.recordRootProviderRound(
              "failed",
              inlineRound,
              activeProviderRoundMode,
              activeProviderRoundStartedAt ?? Date.now(),
              completedUsage,
              pendingToolCalls?.length ?? 0,
              publicTerminalCodeForError(observationError) ??
                "provider_protocol_error",
            );
            roundTerminalRecorded = true;
            throw observationError;
          }
          try {
            settleRoundUsage();
          } catch (error) {
            agentRuntimeOwner.recordRootProviderRound(
              "failed",
              inlineRound,
              activeProviderRoundMode,
              activeProviderRoundStartedAt ?? Date.now(),
              completedUsage,
              pendingToolCalls?.length ?? 0,
              publicTerminalCodeForError(error) ?? "provider_protocol_error",
            );
            roundTerminalRecorded = true;
            throw error;
          }
          agentRuntimeOwner.recordRootProviderRound(
            "completed",
            inlineRound,
            activeProviderRoundMode,
            activeProviderRoundStartedAt ?? Date.now(),
            completedUsage,
            pendingToolCalls?.length ?? 0,
          );
          roundTerminalRecorded = true;
          break;
        }
        }
      } finally {
        if (providerPermit && agentRuntimeOwner) {
          if (reservedBatch?.providerPermit === providerPermit) {
            reservedBatch.releaseDispatch();
          } else {
            agentRuntimeOwner.ledger.releaseOperationPermit(providerPermit);
          }
        }
      }
      const validatedToolCalls = validateTerminalProviderToolBatch(
        observedFinishReason,
        pendingToolCalls,
      );
      const roundToolCalls = validatedToolCalls ?? [];
      // This round's freshly-streamed deltas (not the cross-round accumulation).
      const roundContent = fullContent.slice(roundContentStart);
      const roundReasoning = fullReasoning.slice(roundReasoningStart);

      // Reconstruct the full assistant output including any guided CoT
      // reasoning block so the model sees its own <think>...</think> on
      // continuation rounds and doesn't re-enter the planning phase. This text
      // rendering is used for the legacy continuation and as the context
      // summary handed to extension tools during execution.
      const fullAssistantOutput = fullReasoning
        ? `${cotDelimiters.prefix}${fullReasoning}${cotDelimiters.suffix}\n${fullContent}`
        : fullContent;

      await reconcileActiveRoundUsage?.();
      settleRoundUsage();
      const inlineContextMessages = [
        ...generationMessages,
        ...(fullAssistantOutput
          ? [{ role: "assistant", content: fullAssistantOutput } satisfies LlmMessage]
          : []),
      ];
      if (roundToolCalls.length > 0) sawToolCalls = true;
      validateInlineToolCallIds(roundToolCalls);
      // A complete tool-free provider response is terminal for this frame.
      // AgentRuntimeOwner validates tool batches atomically, and its validator
      // intentionally rejects an empty batch; do not route ordinary completion
      // through that protocol-error path.
      if (roundToolCalls.length === 0) {
        providerTransientCarrier = undefined;
        break;
      }
      if (finalizationMode) {
        // Budget finalization is explicitly tool-disabled. Any returned call
        // is rejected without invoking a host side effect.
        reservedBatch?.release();
        throw new AgentRuntimeFailure("tool_round_limit_exceeded");
      }
      const resultsByIndex: Array<InlineCouncilToolResult | undefined> =
        new Array(roundToolCalls.length);
      if (agentRuntimeOwner) {
        const plan = agentRuntimeOwner.planMainToolBatch(roundToolCalls, {
          ordinaryDefinitions: ordinaryValidationDefinitions,
          messages: generationMessages,
          signal: effectiveSignal,
        });
        if (!plan.reservation) {
          throw new AgentRuntimeFailure(
            plan.failureCode ?? "capacity_exceeded",
          );
        }
        const reservation = plan.reservation;
        const batchRejected = plan.rejected;
        for (let index = 0; index < plan.calls.length; index += 1) {
          const call = plan.calls[index]!;
          try {
            let result: InlineCouncilToolResult;
            if (batchRejected) {
              const semanticError = plan.semanticErrors.get(call.call_id);
              result = agentRuntimeOwner.buildMainToolBatchErrorResult(
                call,
                semanticError?.code ?? "batch_rejected",
              );
            } else {
              result = plan.featureCallIndexes.includes(index)
                ? await agentRuntimeOwner.executePlannedMainToolCall(plan, index)
                : await agentRuntimeOwner.executePlannedOrdinaryToolCall(
                    plan,
                    index,
                    async () => {
                      if (!inlineToolDefsByName) {
                        return unavailableInlineToolResult(call);
                      }
                      const [ordinaryResult] = await executeInlineCouncilToolCalls(
                        userId,
                        [call],
                        inlineMcpTimeoutMs,
                        inlineToolDefsByName,
                        inlineMembersByPrefix,
                        inlineContextMessages,
                        effectiveSignal,
                        inlineToolSafeNames,
                        inlineWebSearchEnabled && !inlineWebSearchUsed,
                      );
                      return ordinaryResult ?? unavailableInlineToolResult(call);
                    },
                  );
            }
            if (
              utf8ByteLength(result.result) > reservation.resultCapacity(index) ||
              !reservation.settleResult(index, utf8ByteLength(result.result))
            ) {
              // The side effect has already settled, so always submit one
              // bounded correlated result rather than failing the generation
              // with an unconsumable envelope.
              result = resultLimitExceededResult(call);
              if (!reservation.settleResult(index, utf8ByteLength(result.result))) {
                throw new AgentRuntimeFailure(
                  agentRuntimeOwner.ledger.failure?.code ?? "result_limit_exceeded",
                );
              }
            }
            resultsByIndex[index] = result;
          } finally {
            reservation.releaseToolPermit(index);
          }
        }
        nextBatchReservation = reservation;
      } else if (inlineToolDefsByName) {
        const ordinaryResults = await executeInlineCouncilToolCalls(
          userId,
          roundToolCalls,
          inlineMcpTimeoutMs,
          inlineToolDefsByName,
          inlineMembersByPrefix,
          inlineContextMessages,
          effectiveSignal,
          inlineToolSafeNames,
          inlineWebSearchEnabled && !inlineWebSearchUsed,
        );
        for (let index = 0; index < ordinaryResults.length; index += 1) {
          resultsByIndex[index] = ordinaryResults[index];
        }
      }
      const inlineCouncilResults = completeInlineToolResults(
        roundToolCalls,
        resultsByIndex,
      );

      if (inlineCouncilResults.length === 0) {
        providerTransientCarrier = undefined;
        break;
      }

      const inlineWebSearchContexts = inlineCouncilResults.flatMap((result) =>
        result.inlineWebSearchContext
          ? [formatInlineWebSearchContext(result.inlineWebSearchContext)]
          : [],
      );
      if (inlineCouncilResults.some((result) => result.isInlineWebSearch)) {
        inlineWebSearchUsed = true;
      }

      // Prefer explicit {{webSearchContext}} slots captured from preset blocks.
      // If none exist, retain the safe end-of-context fallback below.
      const manualPlacement = inlineWebSearchContexts.length > 0
        ? applyInlineWebSearchContextSlots(
            generationMessages,
            inlineWebSearchContexts.join("\n\n"),
          )
        : { messages: generationMessages, placed: false };
      const manuallyPlacedResults = manualPlacement.placed
        ? inlineCouncilResults.map((result) =>
            result.inlineWebSearchContext
              ? {
                  ...result,
                  result: "Web search completed. Retrieved reference context has been placed in the preset's webSearchContext slot.",
                }
              : result,
          )
        : inlineCouncilResults;
      const continuationResults =
        (continuationPolicy.structured || pendingProviderTransientCarrier !== undefined) &&
        !manualPlacement.placed
          ? inlineCouncilResults.map((result) =>
              result.inlineWebSearchContext
                ? {
                    ...result,
                    result: formatInlineWebSearchContext(result.inlineWebSearchContext),
                  }
                : result,
            )
          : manuallyPlacedResults;

      generationMessages = manualPlacement.messages;
      if (pendingProviderTransientCarrier !== undefined) {
        providerTransientCarrier = mergeProviderTransientCarrier(
          providerTransientCarrier,
          pendingProviderTransientCarrier,
          continuationResults.map((result) => ({
            type: "function_call_output" as const,
            call_id: result.callId,
            output: result.result,
          })),
        );
        if (agentRuntimeOwner) {
          const reservation = nextBatchReservation;
          if (
            !reservation ||
            !reservation.settleContinuation(
              utf8ByteLength(JSON.stringify(providerTransientCarrier)),
            )
          ) {
            throw new AgentRuntimeFailure(
              agentRuntimeOwner.ledger.failure?.code ?? "continuation_limit_exceeded",
            );
          }
          agentRuntimeOwner.rootFrame.replaceMessages(generationMessages);
        }
      } else {
        const continuation = buildInlineToolContinuation({
          structured: continuationPolicy.structured,
          legacyResultRole: continuationPolicy.legacyResultRole,
          legacyAssistantOutput: fullAssistantOutput,
          roundContent,
          roundReasoning,
          toolCalls: pendingToolCalls ?? [],
          results: continuationResults,
          thinkingBlocks: pendingThinkingBlocks,
          reasoningDetails: pendingReasoningDetails,
          thoughtSignature: pendingThoughtSignature,
        });
        const fallbackWebSearchMessages =
          !continuationPolicy.structured && !manualPlacement.placed
            ? inlineWebSearchContexts.map(
                (content) => ({ role: "system", content }) satisfies LlmMessage,
              )
            : [];
        const continuationEnvelope = [
          ...continuation,
          ...fallbackWebSearchMessages,
        ];
        generationMessages = [
          ...generationMessages,
          ...continuationEnvelope,
        ];
        if (agentRuntimeOwner) {
          const reservation = nextBatchReservation;
          if (
            !reservation ||
            !reservation.settleContinuation(
              utf8ByteLength(JSON.stringify(continuationEnvelope)),
            )
          ) {
            throw new AgentRuntimeFailure(
              agentRuntimeOwner.ledger.failure?.code ?? "continuation_limit_exceeded",
            );
          }
          agentRuntimeOwner.rootFrame.replaceMessages(generationMessages);
        }
      }
      if (
        agentRuntimeOwner &&
        agentRuntimeOwner.ledger.remaining("aggregate_tool_calls") <= 0
      ) {
        agentBudgetExhausted = true;
        finalizationMode = true;
      }
    }
    const needsFinalization =
      sawToolCalls &&
      !agentRuntimeOwner &&
      inlineRound >= maxInlineRounds;
    if (needsFinalization && !effectiveSignal.aborted) {
        nextBatchReservation?.release();
        nextBatchReservation = null;
      try {
        const finalStream = useStreaming
          ? provider.generateStream(apiKey, apiUrl, {
              messages: generationMessages,
              model,
              parameters,
              stream: true,
              tools: [],
              signal: effectiveSignal,
              toolMode: "finalization",
              providerTransientCarrier,
            })
          : (async function* () {
              const result = await provider.generate(apiKey, apiUrl, {
                messages: generationMessages,
                model,
                parameters,
                stream: false,
                tools: [],
                signal: effectiveSignal,
                toolMode: "finalization",
                providerTransientCarrier,
              });
              yield {
                token: result.content,
                reasoning: result.reasoning,
                finish_reason: result.finish_reason,
                tool_calls: result.tool_calls,
                providerTransientCarrier: result.providerTransientCarrier,
                thinking_blocks: result.thinking_blocks,
                reasoning_details: result.reasoning_details,
                usage: result.usage,
              };
            })();
        let finalToolCalls: ToolCallResult[] | undefined;
        let finalFinishReason: string | undefined;
        for await (const chunk of finalStream) {
          if (effectiveSignal.aborted) break;
          if (chunk.finish_reason) finalFinishReason = chunk.finish_reason;
          if (chunk.reasoning) {
            if (!reasoningStartedAt) reasoningStartedAt = Date.now();
            fullReasoning += chunk.reasoning;
            nativeReasoningContent += chunk.reasoning;
            const appended = pool.appendPoolReasoning(
              generationId,
              chunk.reasoning,
            );
            queueStreamSegment(
              chunk.reasoning,
              appended.seq,
              appended.offset,
              "reasoning",
            );
          }
          if (chunk.token) processContentToken(chunk.token);
          if (chunk.tool_calls) finalToolCalls = chunk.tool_calls;
          if (chunk.usage) roundUsage = chunk.usage;
        }
        settleRoundUsage();
        const validatedFinalToolCalls = validateTerminalProviderToolBatch(
          finalFinishReason,
          finalToolCalls,
        );
        if (
          (validatedFinalToolCalls?.length ?? 0) > 0 ||
          (finalFinishReason !== "tool_calls" &&
            (finalToolCalls?.length ?? 0) > 0)
        ) {
          throw new AgentRuntimeFailure("tool_round_limit_exceeded");
        }
      } finally {
      }
    }
    mergeAgentUsage();

    // Clean exit after abort — the stream may have returned done:true via
    // readWithAbort without ever re-entering the for-await body, so the
    // in-loop STOPPED emission above never fired. Emit now so the frontend
    // gets its completion signal and can unblock its streaming UI.
    if (effectiveSignal.aborted && !emittedStopped) {
      await persistPartialContent();
      claimGenerationTerminal(generationId, "stopped", {
        status: "stopped",
      });
      emittedStopped = true;
    }

    if (!effectiveSignal.aborted) {
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

      if (useStreaming && trimIncompleteWords) {
        fullContent = trimIncompleteStreamTail(fullContent);
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
            undefined,
            responseOptionsFor(responseScripts),
          );
          if (fullReasoning) {
            fullReasoning = await regexScriptsSvc.applyRegexScripts(
              fullReasoning,
              responseScripts,
              "reasoning",
              0,
              macroEnv,
              undefined,
              responseOptionsFor(responseScripts),
            );
          }
        }
      }
      fullContent = healFormattingArtifacts(fullContent);
      const nativeCarrier = persistedNativeReasoningCarrier();

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
        // inserting the continuePostfix separator (e.g. newline, double newline).
        // Target the continued swipe explicitly — the user may have navigated to a
        // different swipe while this streamed. Reasoning is persisted by the shared
        // swipe-scoped extra write below.
        const combined =
          (lifecycle.continueOriginalContent ?? "") +
          (lifecycle.continuePostfix ?? "") +
          fullContent;
        const updated = chatsSvc.updateMessage(
          userId,
          lifecycle.continueMessageId,
          {
            content: combined,
            contentSwipeId: lifecycle.streamingSwipeId,
            skipCouncilCacheInvalidation: true,
          },
        );
        messageId = updated?.id ?? lifecycle.continueMessageId;
      } else if (lifecycle.stagedMessageId) {
        // Staged (sidecar council): update the pre-created empty message
        // Merge with existing extra to preserve character_id etc. set during staging
        const existingStagedExtra =
          chatsSvc.getMessage(userId, lifecycle.stagedMessageId)?.extra || {};
        const stagedExtra =
          fullReasoning || nativeCarrier
            ? {
                ...existingStagedExtra,
                ...(fullReasoning ? { reasoning: fullReasoning } : {}),
                ...(nativeCarrier ? { reasoningCarrier: nativeCarrier } : {}),
              }
            : Object.keys(existingStagedExtra).length > 0
              ? existingStagedExtra
              : undefined;
        chatsSvc.updateMessage(userId, lifecycle.stagedMessageId, {
          content: fullContent,
          ...(stagedExtra ? { extra: stagedExtra } : {}),
          skipCouncilCacheInvalidation: true,
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
        if (nativeCarrier) extra.reasoningCarrier = nativeCarrier;

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
        // The generated content lives on the generation's swipe (streamingSwipeId),
        // which may differ from the displayed swipe_id if the user navigated
        // mid-stream. Read and rewrite that swipe so macro resolution targets the
        // right one (identical to the old path when not navigated, idx === swipe_id).
        const genSwipeId =
          lifecycle.streamingSwipeId != null &&
          savedMessage != null &&
          lifecycle.streamingSwipeId >= 0 &&
          lifecycle.streamingSwipeId < savedMessage.swipes.length
            ? lifecycle.streamingSwipeId
            : null;
        const baseContent =
          genSwipeId != null
            ? savedMessage!.swipes[genSwipeId]
            : (savedMessage?.content ?? fullContent);
        let resolvedMessage = baseContent ?? fullContent;
        if (macroEnv || macroEnvSeed) {
          const assistantEnv = cloneEnv(macroEnv ?? macroEnvSeed!);
          resolvedMessage = await resolveRenderedMessageContent(
            baseContent ?? fullContent,
            assistantEnv,
          );
          persistMacroVariableState(userId, chatId, assistantEnv);
        }
        if (savedMessage && baseContent !== resolvedMessage) {
          chatsSvc.updateMessage(userId, messageId, {
            content: resolvedMessage,
            ...(genSwipeId != null ? { contentSwipeId: genSwipeId } : {}),
          });
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
        if (nativeCarrier) immediateExtra.reasoningCarrier = nativeCarrier;
        if (reasoningDurationMs > 0) {
          immediateExtra.reasoningDuration = reasoningDurationMs;
        }
        if (messageId && Object.keys(immediateExtra).length > 0) {
          // Anchor reasoning/usage to the generated swipe, not the displayed one —
          // the user may have navigated to another swipe while this streamed.
          chatsSvc.setSwipeScopedExtra(
            userId,
            messageId,
            lifecycle.streamingSwipeId,
            immediateExtra,
          );
        }
        persistAgentSummaryForGeneratedAssistant(messageId);
      }

      flushPendingStreamSegments();
      claimGenerationTerminal(
        generationId,
        agentBudgetExhausted ? "completed_at_tool_budget" : "completed",
        {
          status: "completed",
          ...(messageId !== undefined ? { messageId } : {}),
        },
        fullContent,
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
          const metricsExtra: Record<string, any> = {};
          if (resolvedTokenCount) metricsExtra.tokenCount = resolvedTokenCount;
          if (generationMetrics)
            metricsExtra.generationMetrics = generationMetrics;
          // Anchor metrics to the generated swipe, not the displayed one.
          chatsSvc.setSwipeScopedExtra(
            userId,
            messageId,
            lifecycle.streamingSwipeId,
            metricsExtra,
          );
          // GENERATION_ENDED already fired (and no longer carries these — they're
          // computed here, after the terminal event, so the stop button clears
          // immediately). Push a follow-up so the live detail pill / hover tooltip
          // fill in without waiting for a reload. swipeId lets the client gate the
          // patch to the swipe these belong to, in case the user navigated away
          // mid-stream.
          eventBus.emit(
            EventType.GENERATION_METRICS_READY,
            {
              generationId,
              chatId,
              messageId,
              swipeId: lifecycle.streamingSwipeId,
              ...(resolvedTokenCount ? { tokenCount: resolvedTokenCount } : {}),
              ...(generationMetrics ? { generationMetrics } : {}),
            },
            userId,
          );
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
            const entries = tokenResult.breakdown.map((entry, index) => {
              const content = lifecycle.breakdown?.[index]?.content;
              return {
                ...entry,
                content:
                  typeof content === "string"
                    ? redactAgentOutputFrames(content)
                    : content,
              };
            });
            const chatHistoryTokens = sumChatHistoryBreakdownTokens(entries);
            const breakdownPayload = {
              assemblySurface: lifecycle.assemblySurface,
              loomPromptInspection: lifecycle.loomPromptInspection,
              entries: omitChatHistoryBreakdownEntries(entries),
              chatHistoryTokens,
              messages: (lifecycle.messages || []).map((message) => ({
                role: message.role,
                content: redactAgentOutputFrames(
                  typeof message.content === "string"
                    ? message.content
                    : message.content
                        .map((part) =>
                          part.type === "text" ? part.text : "",
                        )
                        .join(""),
                ),
              })),
              totalTokens: tokenResult.total_tokens,
              maxContext: lifecycle.maxContext || 0,
              model: lifecycle.model,
              provider: lifecycle.providerName || "",
              parameters,
              usage: streamUsage,
              presetName: lifecycle.presetName,
              presetId: lifecycle.presetId,
              tokenizer_name: tokenResult.tokenizer_name,
            };
            if (messageId) {
              breakdownSvc.storeBreakdown(
                userId,
                messageId,
                chatId,
                breakdownPayload,
              );
              // Push the breakdown so an opened Prompt Breakdown modal renders
              // from cache instead of re-fetching. GENERATION_ENDED stopped
              // carrying it (deferred, after the terminal event). Drop `messages`
              // — the modal derives chat-history messages from the store or
              // fetches raw on demand, so there's no need to send the largest
              // (duplicated) field over the socket.
              const { messages: _omitMessages, ...breakdownForClient } =
                breakdownPayload;
              eventBus.emit(
                EventType.GENERATION_BREAKDOWN_READY,
                { generationId, chatId, messageId, breakdown: breakdownForClient },
                userId,
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
    let terminalError = err;
    try {
      await reconcileActiveRoundUsage?.();
    } catch (observationError) {
      terminalError = observationError;
    }
    try {
      settleRoundUsage();
    } catch (accountingError) {
      terminalError = accountingError;
    }
    try {
      mergeAgentUsage();
    } catch (accountingError) {
      terminalError = accountingError;
    }
    const coordinatorReason =
      activeGenerations.get(generationId)?.terminal.reason ??
      agentRuntimeOwner?.ledger.terminal ??
      null;
    const isStopAbort =
      coordinatorReason === null ||
      coordinatorReason === "stopped" ||
      coordinatorReason === "cancelled";
    // A root deadline, idle timeout, or typed runtime failure also aborts the
    // stream, but must retain its exact failure projection rather than being
    // misclassified as a user stop.
    if (effectiveSignal.aborted && isStopAbort) {
      // Skip if the post-loop / in-loop branch already emitted — catches
      // the case where a later .next() race threw AFTER the loop body's
      // STOPPED emission had already fired.
      if (!emittedStopped) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          await persistPartialContent();
        } catch {
          /* best-effort; fall back to in-memory content */
        }
        flushPendingStreamSegments();
        claimGenerationTerminal(generationId, "stopped", {
          status: "stopped",
        });
        emittedStopped = true;
      }
    } else if (effectiveSignal.aborted) {
      if (!emittedStopped) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        try {
          await persistPartialContent();
        } catch {
          /* best-effort; fall back to in-memory content */
        }
        flushPendingStreamSegments();
        claimGenerationTerminal(
          generationId,
          coordinatorReason ??
            terminalReasonForError(terminalError, agentRuntimeOwner),
          {
            status: "error",
            error: coordinatorReason ?? "failed",
          },
        );
        emittedStopped = true;
      }
    } else {
      const msg = enrichUnauthenticatedConnectionError(
        errorMessage(terminalError),
        terminalError,
        {
          apiKey,
          connectionName: lifecycle.connectionName,
        },
      );
      abortChatBackground(userId, chatId);
      // Socket drops, provider 5xx mid-stream, etc. — persist whatever was
      // already streamed so the user keeps the visible content rather than
      // having the streaming bubble wiped on error.
      try {
        await persistPartialContent();
      } catch {
        /* best-effort; never let save failure shadow the original error */
      }
      flushPendingStreamSegments();
      claimGenerationTerminal(
        generationId,
        terminalReasonForError(terminalError, agentRuntimeOwner),
        {
          status: "error",
          error: msg,
        },
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
        connectionId: detectionSettings.connectionProfileId,
        modelOverride: detectionSettings.model,
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
    const matched = resolveDetectedExpressionLabel(lifecycle.councilNamedResults["expression_data"], labels);
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
      connectionId: detectionSettings.connectionProfileId,
      modelOverride: detectionSettings.model,
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

export function acknowledgeGenerationDispatch(
  userId: string,
  chatId: string,
  rawGenerationId: unknown,
  rawAuthorityId: unknown,
): AgenticDispatchAcknowledgementState | false {
  if (typeof rawGenerationId !== "string" || rawGenerationId.length === 0) return false;
  const authorityId = normalizeGenerationRequestAuthorityId(rawAuthorityId);
  if (!userId || !chatId || !authorityId) return false;
  const key = generationRequestAuthorityKey(userId, chatId, authorityId);
  if (hasStoppedGenerationRequestAuthority(userId, key)) return false;
  if (acknowledgedGenerationRequestAuthorityMatches(key, rawGenerationId)) {
    return "already_acknowledged";
  }
  if (admittedGenerationRequestAuthorities.get(key) !== rawGenerationId) return false;
  const context = getActiveAgenticGenerationContext(userId, rawGenerationId);
  if (!context || context.chatId !== chatId) return false;
  const acknowledgement = acknowledgeAgenticGenerationDispatch(userId, rawGenerationId);
  if (acknowledgement !== "accepted") return false;
  rememberAcknowledgedGenerationRequestAuthority(key, rawGenerationId);
  return acknowledgement;
}

export async function stopGenerationRequestAuthority(
  userId: string,
  chatId: string,
  rawAuthorityId: unknown,
  expectedGenerationId?: string,
): Promise<GenerationStopResult> {
  const authorityId = normalizeGenerationRequestAuthorityId(rawAuthorityId);
  if (!userId || !chatId || !authorityId) return false;
  const key = generationRequestAuthorityKey(userId, chatId, authorityId);
  const candidate = pendingGenerationRequestAuthorities.get(key);
  const reservation = candidate?.userId === userId && candidate.chatId === chatId ? candidate : undefined;
  const generationId = admittedGenerationRequestAuthorities.get(key);
  const boundGenerationId = reservation?.generationId ?? generationId;
  if (expectedGenerationId && boundGenerationId !== expectedGenerationId) return false;
  const retained = rememberStoppedGenerationRequestAuthority(userId, key, !!reservation || !!generationId);
  if (!retained && !reservation && !generationId) return false;
  if (!reservation) {
    if (!generationId) return true;
    return stopGeneration(userId, generationId, chatId);
  }
  reservation.stopRequested = true;
  if (reservation.mode === "response") {
    reservation.controller.abort(new DOMException("Generation stopped", "AbortError"));
  }
  if (reservation.generationId) {
    const stopped = await stopGeneration(userId, reservation.generationId, chatId);
    if (stopped !== false) return stopped;
  }
  return true;
}
export interface TerminalGenerationStopResult {
  readonly status: "terminal";
  readonly generationId: string;
  readonly run: AgentRunStopResponseV2;
}

export type GenerationStopResult = boolean | "too_late" | TerminalGenerationStopResult;
async function settleAbortedAgenticReservation(
  reservation: PendingGenerationRequestAuthority,
): Promise<GenerationStopResult> {
  const generationId = reservation.generationId;
  if (!generationId) return false;
  let cancellationError: unknown;
  try {
    const stopped = await requestAgenticGenerationCancellation(reservation.userId, generationId);
    if (stopped === true) return true;
    if (stopped === "too_late") return "too_late";
  } catch (error) {
    cancellationError = error;
  }

  const execution = getTurnExecution(generationId, reservation.userId);
  if (execution && execution.chatId === reservation.chatId) {
    try {
      const durable = requestTurnCancellation({
        executionId: execution.id,
        ...(execution.casOwner ? { ownerToken: execution.casOwner } : {}),
        reason: "stopped",
      });
      if (durable.code === "cancelled") {
        abortAcceptedAgenticGeneration(reservation.userId, generationId);
        return true;
      }
      if (durable.code === "too_late" || durable.code === "timed_out") return "too_late";
      if (durable.code === "already_terminal") {
        return durable.execution.state === "CANCELLED" ? true : "too_late";
      }
    } catch (error) {
      cancellationError = error;
    }
  }

  // Both durable cancellation authorities were unavailable. Keep dispatch
  // fenced and force the durable owner itself through terminal convergence.
  reservation.controller.abort(new DOMException("Generation stopped", "AbortError"));
  const terminal = await waitForAgenticGeneration(generationId);
  if (terminal?.status === "cancelled") return true;
  if (terminal?.status === "completed") return "too_late";
  if (cancellationError !== undefined) throw cancellationError;
  return false;
}

function requestDormantAgenticGenerationStop(
  userId: string,
  generationId: string,
  expectedChatId?: string,
): GenerationStopResult {
  try {
    const execution = getTurnExecution(generationId, userId);
    if (
      !execution
      || execution.mode !== "agentic"
      || (expectedChatId !== undefined && execution.chatId !== expectedChatId)
    ) return false;
    const stopped = requestAgentRunStop(userId, execution.chatId, execution.id);
    if (!stopped) return false;
    if (stopped.status === "too_late") return "too_late";
    if (stopped.status === "terminal") return { status: "terminal", generationId: stopped.generationId, run: stopped };
    return true;
  } catch {
    return false;
  }
}
export async function stopGeneration(
  userId: string,
  generationId: string,
  expectedChatId?: string,
): Promise<GenerationStopResult> {
  const agenticContext = getActiveAgenticGenerationContext(userId, generationId);
  const agenticResult = await requestAgenticGenerationCancellation(userId, generationId);
  if (agenticResult !== false) {
    // A legacy Response generation can still exist for the same chat. Settle it
    // in the same Stop instead of leaving its provider stream and persistence
    // running behind an accepted Agentic cancellation.
    let responseStopped = false;
    if (agenticContext) {
      const responseId = activeChatGenerations.get(`${userId}:${agenticContext.chatId}`);
      const raced = responseId ? activeGenerations.get(responseId) : undefined;
      if (raced && raced.userId === userId) {
        responseStopped = raced.terminal.tryTerminate("stopped");
      }
      abortChatBackground(userId, agenticContext.chatId);
    }
    return agenticResult === true || responseStopped ? true : agenticResult;
  }
  const entry = activeGenerations.get(generationId);
  // User scoping: a generationId is unguessable, but never let one user's
  // stop request abort another user's generation.
  if (!entry || entry.userId !== userId) {
    return requestDormantAgenticGenerationStop(userId, generationId, expectedChatId);
  }
  const claimed = entry.terminal.tryTerminate("stopped");
  // The same chat may still own an Agentic turn from a legacy race; its durable
  // owner decides acceptance before this Stop reports a result.
  const agenticChatResult = await requestAgenticChatCancellation(userId, entry.chatId);
  // Tear down any fire-and-forget background work for this chat too —
  // the user asked to stop, so cache-warming cortex/databank queries
  // should die with the visible generation.
  abortChatBackground(entry.userId, entry.chatId);
  if (claimed || agenticChatResult === true) return true;
  return agenticChatResult === "too_late" ? "too_late" : claimed;
}
export async function stopUserGenerations(userId: string): Promise<boolean | "too_late"> {
  // Durable Agentic cancellation must win before any live controller or
  // background work is aborted. The regular Response terminal owner performs
  // its own CAS synchronously below.
  const agenticResult = await stopAgenticUserGenerations(userId);
  let stopped = agenticResult === true;
  for (const entry of activeGenerations.values()) {
    if (entry.userId === userId && entry.terminal.tryTerminate("stopped")) {
      stopped = true;
    }
  }
  abortUserBackgrounds(userId);
  return stopped ? true : agenticResult === "too_late" ? "too_late" : false;
}

export async function stopChatGenerations(
  userId: string,
  chatId: string,
): Promise<GenerationStopResult> {
  const agenticResult = await requestAgenticChatCancellation(userId, chatId);
  if (agenticResult !== false) return agenticResult;
  const chatKey = `${userId}:${chatId}`;
  const genId = activeChatGenerations.get(chatKey);
  let stopped = false;
  if (genId) {
    const entry = activeGenerations.get(genId);
    if (entry) stopped = entry.terminal.tryTerminate("stopped");
  }
  abortChatBackground(userId, chatId);
  if (stopped) return true;
  const dormantPool = pool.getPoolForChat(userId, chatId);
  return dormantPool
    ? requestDormantAgenticGenerationStop(userId, dormantPool.generationId, chatId)
    : false;
}

export async function stopAllGenerations(): Promise<boolean | "too_late"> {
  // Shutdown/global Stop follows the same durable-first ordering as a
  // user-scoped Stop. No Agentic controller is aborted until its execution CAS
  // has accepted cancellation (or reported too_late).
  const agenticResult = await stopAllAgenticGenerations();
  let stopped = agenticResult === true;
  for (const entry of activeGenerations.values()) {
    if (entry.terminal.tryTerminate("stopped")) stopped = true;
  }
  abortAllBackgrounds();
  return stopped ? true : agenticResult === "too_late" ? "too_late" : false;
}

/** Returns the active generationId for a chat, if any. */
export function getActiveChatGeneration(
  userId: string,
  chatId: string,
): string | undefined {
  return activeChatGenerations.get(`${userId}:${chatId}`);
}

export function getActiveGenerationCount(): number {
  return activeGenerations.size + getActiveAgenticGenerationCount();
}

// Abort only stalled generations. A slow model may legitimately stream for
// longer than ten minutes; a provider that has sent no tokens for this long is
// presumed hung or disconnected. Before the first token arrives, registration
// time acts as the initial activity timestamp.
const GENERATION_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const GENERATION_IDLE_SWEEP_INTERVAL_MS = 60_000;

export function sweepInactiveGenerations(now = Date.now()): void {
  for (const [id, entry] of activeGenerations) {
    const idleForMs = now - entry.lastTokenAt;
    if (idleForMs > GENERATION_IDLE_TIMEOUT_MS) {
      console.warn(
        `[generate] Aborting inactive generation ${id} (no tokens for ${Math.round(idleForMs / 1000)}s; age: ${Math.round((now - entry.startedAt) / 1000)}s)`,
      );
      entry.terminal.tryTerminate("timeout");
    }
  }
}

let _generationSweepTimer: ReturnType<typeof setInterval> | null = setInterval(
  sweepInactiveGenerations,
  GENERATION_IDLE_SWEEP_INTERVAL_MS,
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
  let thinkingBlocks: LlmThinkingBlock[] | undefined;
  let reasoningDetails: Record<string, unknown>[] | undefined;
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
    if (chunk.thinking_blocks) thinkingBlocks = chunk.thinking_blocks;
    if (chunk.reasoning_details) reasoningDetails = chunk.reasoning_details;
  }

  return {
    content,
    reasoning: reasoning || undefined,
    finish_reason: finishReason,
    tool_calls: toolCalls,
    thinking_blocks: thinkingBlocks,
    reasoning_details: reasoningDetails,
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
  const { provider, apiKey, apiUrl, connection } = await resolveRawProviderAndKey(
    userId,
    input,
  );
  const parameters: GenerationParameters = { ...(input.parameters || {}) };
  const reasoningConnection = connection;
  applyEffectiveReasoningSettings(
    userId,
    reasoningConnection || {},
    provider.name,
    input.model,
    parameters,
    input.reasoning,
    true,
  );
  if (reasoningConnection) injectConnectionMetadataFlags(reasoningConnection, parameters);

  const cached = applyPromptCaching(
    {
      provider: provider.name,
      model: input.model,
      metadata: reasoningConnection?.metadata,
    },
    { params: parameters, messages: input.messages, tools: input.tools },
  );

  if (input.toolMode === "required") {
      if (!cached.tools || cached.tools.length === 0) {
        throw new Error("Required tool mode needs at least one admitted host tool");
      }
      if (provider.capabilities.requiredToolChoice !== true) {
        throw new Error('Provider "' + provider.name + '" does not support required tool choice');
      }
    }
    const request: GenerationRequest = {
      messages: cached.messages,
      model: input.model,
      parameters: cached.params,
      tools: cached.tools,
      signal: input.signal,
      toolMode: input.toolMode,
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
    input.reasoning,
    true,
  );

  // Allow callers (e.g. Memory Cortex sidecar) to override the model without
  // swapping connection profiles. Strip the key from parameters so it doesn't
  // leak into provider-specific request bodies as an unknown field. Resolved
  // before caching dispatch so model-gated strategies see the actual model
  // that will be sent.
  const paramModel =
    typeof (mergedParams as any).model === "string"
      ? (mergedParams as any).model.trim()
      : "";
  if ("model" in mergedParams) delete (mergedParams as any).model;

  injectConnectionMetadataFlags(connection, mergedParams);

  const resolvedModel = paramModel || connection.model;
  const cached = applyPromptCaching(
    {
      provider: provider.name,
      model: resolvedModel,
      metadata: connection.metadata,
    },
    { params: mergedParams, messages: input.messages, tools: input.tools },
  );

  if (input.toolMode === "required") {
    if (!cached.tools || cached.tools.length === 0) {
      throw new Error("Required tool mode needs at least one admitted host tool");
    }
    if (provider.capabilities.requiredToolChoice !== true) {
      throw new Error('Provider "' + provider.name + '" does not support required tool choice');
    }
  }
  const request: GenerationRequest = {
    messages: cached.messages,
    model: resolvedModel,
    parameters: cached.params,
    tools: cached.tools,
    signal: input.signal,
    toolMode: input.toolMode,
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
 * Accepts raw message data and builds the prompt internally using the shared
 * `buildSummarizationPrompt` function. Resolves connection via: explicit
 * connection_id → sidecar settings → default.
 */
export async function summarizeGenerate(
  userId: string,
  input: SummarizeGenerateInput,
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
    // Fetch messages from the database (last N by message_context)
    const allMessages = chatsSvc.getMessages(userId, chatId);
    const visibleMessages = allMessages.filter((m) => m.extra?.hidden !== true);
    const recentMessages = visibleMessages.slice(-input.message_context);

    if (recentMessages.length === 0) {
      throw new Error('No messages to summarize');
    }

    // Build the prompt using the shared backend function
    const defaults = getSummarizationPromptDefaults();
    const systemPrompt = input.systemPromptOverride && input.systemPromptOverride.trim().length > 0
      ? input.systemPromptOverride
      : defaults.systemPrompt;
    const userPrompt = input.userPromptOverride && input.userPromptOverride.trim().length > 0
      ? input.userPromptOverride
      : defaults.userPrompt;

    const prompt = buildSummarizationPrompt({
      messages: recentMessages,
      previousSummary: input.existingSummary || '',
      userName: input.userName,
      characterName: input.characterName,
      systemPromptTemplate: systemPrompt,
      userPromptTemplate: userPrompt,
    });

    if (!prompt) {
      throw new Error('No messages to summarize');
    }

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
          max_tokens: sidecar.maxTokens ?? 8192,
        };
      }
    }

    const connection = resolveConnection(userId, connectionId);
    const { provider, apiKey, apiUrl } = await resolveProviderAndKey(
      userId,
      connection.id,
    );

    // Merge: preset defaults < sidecar overrides
    let mergedParams: GenerationParameters = {};
    if (connection.preset_id) {
      const preset = presetsSvc.getPreset(userId, connection.preset_id);
      if (preset) {
        mergedParams = { ...preset.parameters };
      }
    }
    mergedParams = { ...mergedParams, ...sidecarParams };
    // Ensure summary generation has enough tokens — presets may cap at 1024
    if ((mergedParams.max_tokens as number) < 4096) {
      mergedParams.max_tokens = 8192;
    }

    injectConnectionMetadataFlags(connection, mergedParams);

    applyEffectiveReasoningSettings(
      userId,
      connection,
      provider.name,
      sidecarModel || connection.model || undefined,
      mergedParams,
      undefined,
      true,
    );

    const resolvedModel = sidecarModel || connection.model;
    const summarizeMessages: LlmMessage[] = [
      { role: 'system', content: prompt.systemPrompt },
      { role: 'user', content: prompt.userPrompt },
    ];
    const cached = applyPromptCaching(
      {
        provider: provider.name,
        model: resolvedModel,
        metadata: connection.metadata,
      },
      { params: mergedParams, messages: summarizeMessages },
    );

    const request: GenerationRequest = {
      messages: cached.messages,
      model: resolvedModel,
      parameters: cached.params,
    };

    const result = applyDelimitedReasoningParsing(
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

// ── Batch Rebuild Summary ────────────────────────────────────────────────

interface RebuildSummaryResult {
  generationId: string;
  totalBatches: number;
  totalMessages: number;
}

interface RebuildBatchContext {
  chatId: string;
  generationId: string;
  userId: string;
  batchSize: number;
  connection: ConnectionProfile;
  provider: LlmProvider;
  apiKey: string;
  apiUrl: string;
  sidecarModel: string | undefined;
  sidecarParams: Record<string, unknown>;
  systemPrompt: string;
  userPrompt: string;
  userName: string;
  characterName: string;
  presetParams: Record<string, unknown>;
}

/**
 * Process a single batch in the rebuild flow.
 */
async function processRebuildBatch(
  ctx: RebuildBatchContext,
  batch: Message[],
  batchIdx: number,
  totalBatches: number,
  messagesProcessed: number,
  currentSummary: string,
): Promise<{ summary: string; messagesProcessed: number; failed: boolean }> {
  const { chatId, generationId, userId, provider, apiKey, apiUrl, sidecarModel, sidecarParams, systemPrompt, userPrompt, userName, characterName, presetParams } = ctx;

  // Build prompt for this batch
  const prompt = buildSummarizationPrompt({
    messages: batch,
    previousSummary: currentSummary,
    userName,
    characterName,
    systemPromptTemplate: systemPrompt,
    userPromptTemplate: userPrompt,
  });

  if (!prompt) {
    // Empty batch, skip (not a failure)
    summarizePool.emitSummarizationProgress({
      chatId,
      generationId,
      batchNumber: batchIdx + 1,
      totalBatches,
      messagesProcessed: messagesProcessed + batch.length,
      userId,
    });
    return { summary: currentSummary, messagesProcessed: messagesProcessed + batch.length, failed: false };
  }

  // Merge parameters
  const mergedParams = { ...presetParams, ...sidecarParams };
  // Ensure summary generation has enough tokens — presets may cap at 1024
  if ((mergedParams.max_tokens as number) < 4096) {
    mergedParams.max_tokens = 8192;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  injectConnectionMetadataFlags(ctx.connection, mergedParams as any);

  console.log(
    `[rebuild] Batch ${batchIdx + 1}/${totalBatches}: model=${sidecarModel || ctx.connection.model}, max_tokens=${mergedParams.max_tokens ?? 'NOT SET'}`,
  );

  const rebuildMessages: LlmMessage[] = [
    { role: 'system' as const, content: prompt.systemPrompt },
    { role: 'user' as const, content: prompt.userPrompt },
  ];
  const cached = applyPromptCaching(
    {
      provider: provider.name,
      model: sidecarModel || ctx.connection.model,
      metadata: ctx.connection.metadata,
    },
    { params: mergedParams as GenerationParameters, messages: rebuildMessages },
  );

  const request = {
    messages: cached.messages,
    model: sidecarModel || ctx.connection.model,
    parameters: cached.params,
    stream: false,
  };

  // Call LLM for this batch
  let result: GenerationResponse;
  try {
    result = applyDelimitedReasoningParsing(
      userId,
      await provider.generate(apiKey, apiUrl, request),
    );
  } catch (err: any) {
    // Retry once on failure
    try {
      await new Promise<void>((r) => setTimeout(r, 500));
      result = applyDelimitedReasoningParsing(
        userId,
        await provider.generate(apiKey, apiUrl, request),
      );
    } catch (retryErr: any) {
      // On retry failure, keep the previous summary unchanged
      console.warn(
        `[rebuild] Batch ${batchIdx + 1}/${totalBatches} failed, keeping previous summary`,
        retryErr?.message,
      );
      summarizePool.emitSummarizationProgress({
        chatId,
        generationId,
        batchNumber: batchIdx + 1,
        totalBatches,
        messagesProcessed: messagesProcessed + batch.length,
        userId,
      });
      return { summary: currentSummary, messagesProcessed: messagesProcessed + batch.length, failed: true };
    }
  }

  const batchSummary = result.content?.trim();
  const newSummary = batchSummary || currentSummary;

  console.log(
    `[rebuild] Batch ${batchIdx + 1}/${totalBatches}: contentLen=${(result.content || '').length}, batchSummaryLen=${(batchSummary || '').length}, newSummaryLen=${newSummary.length}`,
  );

  // Emit progress event
  summarizePool.emitSummarizationProgress({
    chatId,
    generationId,
    batchNumber: batchIdx + 1,
    totalBatches,
    messagesProcessed: messagesProcessed + batch.length,
    userId,
  });

  return { summary: newSummary, messagesProcessed: messagesProcessed + batch.length, failed: false };
}

/**
 * Rebuild a chat summary by processing all messages in sequential batches.
 * Each batch's output feeds into the next as the "previous summary".
 *
 * This function is non-blocking: it resolves connection/settings, registers
 * in the pool, kicks off the batch processing as a fire-and-forget async
 * task, and returns immediately with metadata. The frontend tracks progress
 * via SUMMARIZATION_PROGRESS and SUMMARIZATION_COMPLETED WS events.
 */
export async function rebuildSummary(
  userId: string,
  input: {
    chat_id: string;
    batch_size: number;
    userName: string;
    system_prompt_override?: string | null;
    user_prompt_override?: string | null;
    connection_id?: string;
  },
): Promise<RebuildSummaryResult> {
  const chatId = input.chat_id;
  const generationId = crypto.randomUUID();
  const batchSize = Math.max(1, input.batch_size);

  // Resolve connection
  let connectionId = input.connection_id;
  if (!connectionId) {
    const sidecar = getSidecarSettings(userId);
    if (sidecar.connectionProfileId) {
      connectionId = sidecar.connectionProfileId;
    }
  }
  const connection = resolveConnection(userId, connectionId);
  const { provider, apiKey, apiUrl } = await resolveProviderAndKey(
    userId,
    connection.id,
  );

  // Resolve model and parameters
  let sidecarModel: string | undefined;
  let sidecarParams: Record<string, unknown> = {};
  if (!input.connection_id) {
    const sidecar = getSidecarSettings(userId);
    if (sidecar.model) sidecarModel = sidecar.model;
    sidecarParams = {
      temperature: sidecar.temperature,
      top_p: sidecar.topP,
      max_tokens: sidecar.maxTokens ?? 8192,
    };
  }

  // Get prompt defaults
  const defaults = getSummarizationPromptDefaults();
  const systemPrompt = input.system_prompt_override && input.system_prompt_override.trim().length > 0
    ? input.system_prompt_override
    : defaults.systemPrompt;
  const userPrompt = input.user_prompt_override && input.user_prompt_override.trim().length > 0
    ? input.user_prompt_override
    : defaults.userPrompt;

  // Get chat for character/user names
  const chat = chatsSvc.getChat(userId, chatId);
  const characterId = chat?.character_id;
  const character = characterId ? charactersSvc.getCharacter(userId, characterId) : null;
  const characterName = character?.name || 'Character';
  const userName = input.userName || 'User';

  // Fetch all messages ordered chronologically
  const allMessages = chatsSvc.getMessages(userId, chatId);
  const visibleMessages = allMessages.filter((m) => m.extra?.hidden !== true);

  if (visibleMessages.length === 0) {
    throw new Error('No messages to summarize');
  }

  // Get preset params
  let presetParams: Record<string, unknown> = {};
  if (connection.preset_id) {
    const preset = presetsSvc.getPreset(userId, connection.preset_id);
    if (preset) {
      presetParams = { ...preset.parameters };
    }
  }

  // Slice into batches
  const batches: Message[][] = [];
  for (let i = 0; i < visibleMessages.length; i += batchSize) {
    batches.push(visibleMessages.slice(i, i + batchSize));
  }

  // Return immediately — batch processing runs in background
  // (startRebuildSummary emits SUMMARIZATION_STARTED)
  return { generationId, totalBatches: batches.length, totalMessages: visibleMessages.length };
}

/**
 * Start the background batch processing for a rebuild summary.
 * Called by the route handler after rebuildSummary() returns.
 */
export async function startRebuildSummary(
  userId: string,
  input: {
    chat_id: string;
    batch_size: number;
    userName: string;
    system_prompt_override?: string | null;
    user_prompt_override?: string | null;
    connection_id?: string;
  },
): Promise<void> {
  const chatId = input.chat_id;
  const generationId = crypto.randomUUID();
  const batchSize = Math.max(1, input.batch_size);

  // Resolve connection
  let connectionId = input.connection_id;
  if (!connectionId) {
    const sidecar = getSidecarSettings(userId);
    if (sidecar.connectionProfileId) {
      connectionId = sidecar.connectionProfileId;
    }
  }
  const connection = resolveConnection(userId, connectionId);
  const { provider, apiKey, apiUrl } = await resolveProviderAndKey(
    userId,
    connection.id,
  );

  // Resolve model and parameters
  let sidecarModel: string | undefined;
  let sidecarParams: Record<string, unknown> = {};
  if (!input.connection_id) {
    const sidecar = getSidecarSettings(userId);
    if (sidecar.model) sidecarModel = sidecar.model;
    sidecarParams = {
      temperature: sidecar.temperature,
      top_p: sidecar.topP,
      max_tokens: sidecar.maxTokens ?? 8192,
    };
  }

  // Get prompt defaults
  const defaults = getSummarizationPromptDefaults();
  const systemPrompt = input.system_prompt_override && input.system_prompt_override.trim().length > 0
    ? input.system_prompt_override
    : defaults.systemPrompt;
  const userPrompt = input.user_prompt_override && input.user_prompt_override.trim().length > 0
    ? input.user_prompt_override
    : defaults.userPrompt;

  // Get chat for character/user names
  const chat = chatsSvc.getChat(userId, chatId);
  const characterId = chat?.character_id;
  const character = characterId ? charactersSvc.getCharacter(userId, characterId) : null;
  const characterName = character?.name || 'Character';
  const userName = input.userName || 'User';

  // Fetch all messages
  const allMessages = chatsSvc.getMessages(userId, chatId);
  const visibleMessages = allMessages.filter((m) => m.extra?.hidden !== true);

  if (visibleMessages.length === 0) {
    summarizePool.failSummarizePool({ generationId, userId, chatId, error: 'No messages to summarize' });
    return;
  }

  // Get preset params
  let presetParams: Record<string, unknown> = {};
  if (connection.preset_id) {
    const preset = presetsSvc.getPreset(userId, connection.preset_id);
    if (preset) {
      presetParams = { ...preset.parameters };
    }
  }

  // Slice into batches
  const batches: Message[][] = [];
  for (let i = 0; i < visibleMessages.length; i += batchSize) {
    batches.push(visibleMessages.slice(i, i + batchSize));
  }

  // Register in pool
  if (chatId) {
    summarizePool.startSummarizePool({ generationId, userId, chatId });
  }

  try {
    // Get existing summary
    const existingSummary = (chat?.metadata?.loom_summary as string) || '';
    console.log(
      `[rebuild] Starting rebuild for ${chatId}: existingSummary=${existingSummary ? existingSummary.slice(0, 80) + '…' : '(empty)'}, batches=${batches.length}`,
    );

    let currentSummary = existingSummary;
    let messagesProcessed = 0;
    let hadFailure = false;

    // Process each batch
    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx];
      const result = await processRebuildBatch(
        {
          chatId,
          generationId,
          userId,
          batchSize,
          connection,
          provider,
          apiKey,
          apiUrl,
          sidecarModel,
          sidecarParams,
          systemPrompt,
          userPrompt,
          userName,
          characterName,
          presetParams,
        },
        batch,
        batchIdx,
        batches.length,
        messagesProcessed,
        currentSummary,
      );
      currentSummary = result.summary;
      messagesProcessed = result.messagesProcessed;

      // Track whether this batch failed
      if (result.failed) {
        hadFailure = true;
      }

      console.log(
        `[rebuild] Batch ${batchIdx + 1}/${batches.length} done, summaryLen=${currentSummary.length}, failed=${result.failed}`,
      );

      // Small delay between batches
      if (batchIdx < batches.length - 1) {
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    }

    // Rebuild is atomic: only commit if ALL batches succeeded.
    // If any batch failed, the chain is broken and the result is unreliable.
    const allBatchesSucceeded = !hadFailure;

    if (allBatchesSucceeded) {
      // All batches produced new content — commit the rebuilt summary
      console.log(
        `[rebuild] All ${batches.length} batches succeeded, committing summary (len=${currentSummary.length})`,
      );
      await chatsSvc.mergeChatMetadata(userId, chatId, {
        loom_summary: currentSummary,
        loom_last_summarized_at: {
          messageCount: visibleMessages.length,
          timestamp: Date.now(),
        },
      });
      eventBus.emit(
        EventType.SUMMARIZATION_COMPLETED,
        { chatId, generationId, summaryText: currentSummary },
        userId,
      );
    } else {
      // At least one batch failed — keep existing summary, emit failure
      console.warn(
        `[rebuild] Rebuild aborted: at least one batch failed, keeping existing summary`,
      );
      eventBus.emit(
        EventType.SUMMARIZATION_FAILED,
        { chatId, generationId, error: 'One or more batches failed — rebuild aborted' },
        userId,
      );
    }
  } catch (err: any) {
    summarizePool.failSummarizePool({
      generationId,
      userId,
      chatId,
      error: err?.message || 'Rebuild summary failed',
    });
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

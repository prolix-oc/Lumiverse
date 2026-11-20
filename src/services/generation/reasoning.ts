import {
  describeContentForDisplay,
  type DisplayContentPartSummary,
  type GenerationParameters,
  type GenerationResponse,
  type LlmMessage,
  type LlmThinkingBlock,
  type StreamChunk,
} from "../../llm/types";
import type { CustomBody } from "../../types/preset";
import type { Message } from "../../types/message";
import type { GenerationReasoningOverrideDTO } from "lumiverse-spindle-types";
import {
  closeUnterminatedDelimitedReasoning,
  extractDelimitedReasoning,
  resolveReasoningDelimiters,
  separateDelimitedReasoning,
  wrapDelimitedReasoningStream,
} from "../../utils/reasoning-strip";
import {
  applyCustomBodyParameters,
  applyProviderReasoningOffSwitch,
  getSourceMessageId,
  injectReasoningParams,
  isChatHistoryMessage,
  shouldPreserveDisplayReasoningDelimiters,
} from "../prompt-assembly.service";
import * as settingsSvc from "../settings.service";

type ReasoningSettingsSnapshot = {
  apiReasoning?: boolean;
  reasoningEffort?: string;
  thinkingDisplay?: string;
  clearThinking?: boolean;
  replayThoughtSignatures?: boolean;
  customBody?: CustomBody;
} | null;

export interface DryRunDisplayMessage extends Omit<LlmMessage, "content"> {
  content: string;
  reasoning?: string;
  contentParts?: DisplayContentPartSummary[];
  __chatHistorySource?: boolean;
  __sourceMessageId?: string;
  __sourceIndexInChat?: number;
}

function normalizeReasoningText(reasoning: unknown): string | undefined {
  return typeof reasoning === "string" && reasoning.trim().length > 0
    ? reasoning
    : undefined;
}

export function extractThinkingBlockText(
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

export function extractReasoningDetailsText(
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

export function resolveDryRunMessageReasoning(
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

function shouldExtractDisplayReasoningFromContent(
  message: LlmMessage,
): boolean {
  return (
    message.role === "assistant" &&
    isChatHistoryMessage(message) &&
    !shouldPreserveDisplayReasoningDelimiters(message)
  );
}

export function buildDryRunDisplayMessages(
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
    if (reasoning && extractedReasoning.cleaned.trim() !== reasoning.trim()) {
      displayMessage.reasoning = reasoning;
    }
    return displayMessage;
  });

  const keepInHistory = reasoningSettings?.keepInHistory ?? -1;
  if (keepInHistory === -1) return displayMessages;

  let keptReasoningMessages = 0;
  for (let index = displayMessages.length - 1; index >= 0; index--) {
    if (
      !isChatHistoryMessage(messages[index])
      || messages[index].role !== "assistant"
    ) {
      continue;
    }
    if (!displayMessages[index].reasoning) continue;
    keptReasoningMessages++;
    if (keptReasoningMessages > keepInHistory) {
      delete displayMessages[index].reasoning;
    }
  }
  return displayMessages;
}

export function closeUnterminatedReasoningTags(
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

export function applyDelimitedReasoningParsing(
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

export function wrapDelimitedReasoningForUser(
  userId: string,
  stream: AsyncGenerator<StreamChunk, void, unknown>,
): AsyncGenerator<StreamChunk, void, unknown> {
  const { enabled, delimiters } = getReasoningParseConfig(userId);
  return wrapDelimitedReasoningStream(stream, delimiters, enabled);
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

function resolveReasoningOverride(
  override: GenerationReasoningOverrideDTO | undefined,
): ReasoningSettingsSnapshot | undefined {
  if (!override) return undefined;
  const source = override.source ?? "inherit";
  if (source === "inherit") return undefined;
  if (source === "off") return { apiReasoning: false };
  return {
    apiReasoning: override.apiReasoning ?? true,
    reasoningEffort: override.effort ?? "auto",
    thinkingDisplay: override.thinkingDisplay ?? "auto",
  };
}

export function applyEffectiveReasoningSettings(
  userId: string,
  connection: { metadata?: Record<string, any> | null },
  providerName: string,
  modelName: string | undefined,
  params: GenerationParameters,
  override?: GenerationReasoningOverrideDTO,
  includeCustomBody = false,
): void {
  const resolvedOverride = resolveReasoningOverride(override);
  const reasoningSettings = resolvedOverride !== undefined
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
      reasoningSettings.replayThoughtSignatures === true
      && (providerName === "google" || providerName === "google_vertex")
    ) {
      params._replay_thought_signatures = true;
    }
    return;
  }

  if (reasoningSettings?.apiReasoning === false) {
    applyProviderReasoningOffSwitch(params as any, providerName, modelName);
  }
}

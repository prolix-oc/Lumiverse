import type { LlmMessage, GenerationResponse } from "../llm/types";
import type { GenerationCallOptions } from "../llm/request-observer";
import * as connectionsSvc from "./connections.service";
import * as settingsSvc from "./settings.service";
import { getSidecarSettings } from "./sidecar-settings.service";

type RawGenerateFn = (userId: string, input: {
  provider: string;
  model: string;
  messages: LlmMessage[];
  connection_id: string;
  parameters?: Record<string, unknown>;
}, options?: GenerationCallOptions) => Promise<GenerationResponse>;

interface DetectExpressionInput {
  userId: string;
  chatId: string;
  characterId: string;
  labels: string[];
  recentMessages: LlmMessage[];
  connectionId?: string;
  modelOverride?: string;
  /** Named expression group to evaluate on a multi-character card. */
  characterName?: string;
}

export function buildExpressionSelectionPrompt(labels: string[], characterName?: string): string {
  const target = characterName
    ? ` for ${JSON.stringify(characterName)}`
    : "";
  const characterRule = characterName
    ? `\n- Evaluate ONLY ${JSON.stringify(characterName)}. Other characters may appear in the message; do not use their dialogue, actions, or emotions to choose this sprite.`
    : "";

  return `Select a character sprite image${target}. Read the LAST assistant message and choose the single available label that best matches ${characterName ? `the visible state of ${JSON.stringify(characterName)}` : "the character's visible state"} in that moment.

Rules:
- Base your choice ONLY on the last assistant message, not the overall conversation.${characterRule}
- Treat labels as full sprite states, not just facial emotions. Outfit, pose, action, body position, and facial expression can all matter.
- Prefer the most specific matching label. Only choose a generic "neutral" or "default" state if no specific action/pose/expression label fits.
- Look for cues in dialogue tone, actions, body language, and narration.

Available expressions${characterName ? ` for ${JSON.stringify(characterName)}` : ""}: ${labels.join(", ")}

Reply with ONLY one label from the list above, exactly as written.`;
}

/**
 * Lightweight sidecar call to detect the appropriate character sprite state
 * from the most recent messages. Returns the matched label or null.
 */
export async function detectExpression(input: DetectExpressionInput, generateFn: RawGenerateFn): Promise<string | null> {
  const { userId, labels, recentMessages } = input;
  if (labels.length === 0) return null;

  // Resolve sidecar connection from shared sidecar settings
  const sidecar = getSidecarSettings(userId);

  let connectionId = input.connectionId || sidecar.connectionProfileId;
  let model: string | undefined = input.modelOverride || sidecar.model || undefined;
  let temperature = sidecar.temperature ?? 0.3;
  let maxTokens = Math.min(sidecar.maxTokens ?? 50, 100);

  if (!connectionId) {
    const defaultConn = connectionsSvc.resolveConnection(userId);
    if (!defaultConn) return null;
    connectionId = defaultConn.id;
    model = model || defaultConn.model || undefined;
  }

  const conn = connectionsSvc.resolveConnection(userId, connectionId);
  if (!conn) return null;
  connectionId = conn.id;

  const systemPrompt = buildExpressionSelectionPrompt(labels, input.characterName);

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentMessages.slice(-5),
    {
      role: "user",
      content: input.characterName
        ? `Which expression matches ${JSON.stringify(input.characterName)} in the last message?`
        : "Which expression matches the character in the last message?",
    },
  ];

  const response = await generateFn(userId, {
    provider: conn.provider,
    model: model || conn.model || "",
    messages,
    connection_id: connectionId,
    parameters: {
      temperature,
      max_tokens: maxTokens,
    },
  }, { chatId: input.chatId, origin: { kind: "sidecar", name: "Expression Detection", operation: input.characterName ?? "expression" } });

  return resolveDetectedExpressionLabel(response.content || "", labels);
}

function cleanDetectionResponse(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/```$/i, "")
    .trim()
    .replace(/^[`'"“”‘’]+|[`'"“”‘’]+$/g, "")
    .trim();
}

function normalizeExpressionLabel(value: string): string {
  return cleanDetectionResponse(value)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function mostSpecificLabel(labels: string[]): string | null {
  return labels
    .slice()
    .sort((a, b) => b.length - a.length || a.localeCompare(b))[0] ?? null;
}

export function resolveDetectedExpressionLabel(rawResponse: string, labels: string[]): string | null {
  const cleaned = cleanDetectionResponse(rawResponse);
  if (!cleaned) return null;

  const rawLower = cleaned.toLowerCase();

  // Exact match first.
  const exactMatch = labels.find((l) => l.toLowerCase() === rawLower);
  if (exactMatch) return exactMatch;

  // Normalized exact match handles quotes, code fences, spaces, hyphens, and file extensions.
  const normalizedRaw = normalizeExpressionLabel(cleaned);
  const normalizedExact = labels.find((l) => normalizeExpressionLabel(l) === normalizedRaw);
  if (normalizedExact) return normalizedExact;

  // Fuzzy response contains label: prefer the most specific matching label, not insertion order.
  const containsMatches = labels.filter((l) => rawLower.includes(l.toLowerCase()));
  const containsMatch = mostSpecificLabel(containsMatches);
  if (containsMatch) return containsMatch;

  const normalizedContainsMatches = labels.filter((l) => normalizedRaw.includes(normalizeExpressionLabel(l)));
  const normalizedContainsMatch = mostSpecificLabel(normalizedContainsMatches);
  if (normalizedContainsMatch) return normalizedContainsMatch;

  // Reverse fuzzy handles partial sidecar answers like "name_apron_action".
  // Prefer longer labels so outfit-only partials do not always collapse to the first neutral image.
  const reverseMatches = labels.filter((l) => l.toLowerCase().includes(rawLower));
  const reverseMatch = mostSpecificLabel(reverseMatches);
  if (reverseMatch) return reverseMatch;

  const normalizedReverseMatches = labels.filter((l) => normalizeExpressionLabel(l).includes(normalizedRaw));
  return mostSpecificLabel(normalizedReverseMatches);
}

export interface ExpressionDetectionSettings {
  mode: "auto" | "council" | "off";
  contextWindow: number;
  connectionProfileId?: string;
  model?: string;
}

export function getExpressionDetectionSettings(userId: string): ExpressionDetectionSettings {
  const setting = settingsSvc.getSetting(userId, "expressionDetection");
  if (!setting) return { mode: "auto", contextWindow: 5 };
  const val = setting.value as Partial<ExpressionDetectionSettings>;
  return {
    mode: val.mode ?? "auto",
    contextWindow: val.contextWindow ?? 5,
    connectionProfileId: val.connectionProfileId,
    model: val.model,
  };
}

// ── Multi-character expression detection ─────────────────────────────────────

import type { ExpressionGroups } from "./expressions.service";

interface DetectMultiCharExpressionInput {
  userId: string;
  chatId: string;
  characterId: string;
  groups: ExpressionGroups;
  recentMessages: LlmMessage[];
  connectionId?: string;
  modelOverride?: string;
}

export interface MultiCharExpressionResult {
  /** Which character-specific expression group this result belongs to. */
  characterGroup: string;
  /** The clean expression label (e.g., "Clothed_angry"). */
  expression: string;
  /** Resolved image ID for the expression. */
  imageId: string;
}

/**
 * Two-stage expression detection for multi-character cards:
 *
 * 1. **Character steering** — identify every character whose visible state is
 *    established by the latest response. A multi-character sprite display can
 *    show all of them at once.
 * 2. **Expression detection** — run expression detection independently for
 *    each identified character, scoped to that character's own label set.
 */
export async function detectMultiCharacterExpressions(
  input: DetectMultiCharExpressionInput,
  generateFn: RawGenerateFn,
): Promise<MultiCharExpressionResult[] | null> {
  const { userId, groups, recentMessages } = input;

  // Collect named character groups (exclude "_default" outfit-only bucket)
  const characterNames = Object.keys(groups).filter((n) => n !== "_default");

  // If only a _default group exists, treat its labels as flat single-character
  if (characterNames.length === 0) {
    const defaultGroup = groups["_default"];
    if (!defaultGroup || Object.keys(defaultGroup).length === 0) return null;
    const labels = Object.keys(defaultGroup);
    const detected = await detectExpression({ ...input, labels }, generateFn);
    if (!detected || !defaultGroup[detected]) return null;
    return [{ characterGroup: "_default", expression: detected, imageId: defaultGroup[detected] }];
  }

  // Stage 1: ask for every displayable character, not a single "primary" one.
  // Fall back to explicit name mentions only if the steering call itself fails.
  const llmCharacters = await identifyCharactersLLM(
    userId, characterNames, recentMessages, generateFn, input.connectionId, input.modelOverride,
  );
  const targetCharacters = llmCharacters ?? identifyCharactersHeuristic(recentMessages, characterNames);

  if (targetCharacters.length === 0) return [];

  // Stage 2: each character is evaluated against only their own expression set.
  // One failed character must not suppress valid sprites selected for the rest.
  const detections = await Promise.allSettled(targetCharacters.map(async (targetCharacter) => {
    const groupLabels = groups[targetCharacter];
    if (!groupLabels) return null;
    const labels = Object.keys(groupLabels);
    if (labels.length === 0) return null;

    const detected = await detectExpression(
      { ...input, labels, characterName: targetCharacter },
      generateFn,
    );
    if (!detected || !groupLabels[detected]) return null;

    return {
      characterGroup: targetCharacter,
      expression: detected,
      imageId: groupLabels[detected],
    };
  }));

  const resolved = detections.flatMap((settled) =>
    settled.status === "fulfilled" && settled.value ? [settled.value] : []
  );
  return resolved.length > 0 ? resolved : null;
}

/**
 * Fallback heuristic: retain every group name explicitly mentioned in the last
 * assistant message when the steering model is unavailable.
 */
function identifyCharactersHeuristic(
  recentMessages: LlmMessage[],
  characterNames: string[],
): string[] {
  // Find the last assistant message
  const lastAssistant = [...recentMessages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return [];

  const content = typeof lastAssistant.content === "string" ? lastAssistant.content : "";
  if (!content) return [];

  const contentLower = content.toLowerCase();

  return characterNames.filter((name) => contentLower.includes(name.toLowerCase()));
}

export function buildMultiCharacterSelectionPrompt(characterNames: string[]): string {
  return `You are steering a multi-character sprite display for a roleplay conversation. Read the LAST assistant message and identify EVERY listed character whose current visible state is conveyed: anyone speaking, acting, reacting, or being visibly described.

The display can show multiple character sprites at the same time. Do not reduce the answer to one "primary" character when several characters participate. Each selected character will be evaluated against their own unique expression set in the next step.

Available characters: ${characterNames.map((name) => JSON.stringify(name)).join(", ")}

Rules:
- Use ONLY the last assistant message to decide who is currently displayable.
- Include every matching available character, even when several appear together.
- Do not include a character merely because they appeared earlier in the conversation.
- Never invent or rename a character.

Reply with ONLY a JSON array of names exactly as listed, for example ["Character A", "Character B"]. Reply [] if none are present.`;
}

export function resolveDetectedCharacterNames(rawResponse: string, characterNames: string[]): string[] | null {
  const cleaned = cleanDetectionResponse(rawResponse);
  if (!cleaned) return null;

  let values: unknown;
  try {
    values = JSON.parse(cleaned);
  } catch {
    // Preserve compatibility with small models that still return a bare name.
    values = [cleaned];
  }

  if (!Array.isArray(values)) return null;
  if (values.length === 0) return [];

  const resolved: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = cleanDetectionResponse(value).toLowerCase();
    const match = characterNames.find((name) => name.toLowerCase() === normalized);
    if (match && !resolved.includes(match)) resolved.push(match);
  }
  return resolved.length > 0 ? resolved : null;
}

/**
 * LLM-based multi-character identification. The explicit array contract is
 * deliberately small-model friendly while allowing more than one sprite.
 */
async function identifyCharactersLLM(
  userId: string,
  characterNames: string[],
  recentMessages: LlmMessage[],
  generateFn: RawGenerateFn,
  connectionIdOverride?: string,
  modelOverride?: string,
): Promise<string[] | null> {
  const sidecar = getSidecarSettings(userId);

  let connectionId = connectionIdOverride || sidecar.connectionProfileId;
  let model: string | undefined = modelOverride || sidecar.model || undefined;

  if (!connectionId) {
    const defaultConn = connectionsSvc.resolveConnection(userId);
    if (!defaultConn) return null;
    connectionId = defaultConn.id;
    model = model || defaultConn.model || undefined;
  }

  const conn = connectionsSvc.resolveConnection(userId, connectionId);
  if (!conn) return null;
  connectionId = conn.id;

  const systemPrompt = buildMultiCharacterSelectionPrompt(characterNames);

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentMessages.slice(-3),
    {
      role: "user",
      content: "Which characters should be displayed for the last response? Return every matching name as a JSON array.",
    },
  ];

  try {
    const response = await generateFn(userId, {
      provider: conn.provider,
      model: model || conn.model || "",
      messages,
      connection_id: connectionId,
      parameters: { temperature: 0.1, max_tokens: 150 },
    }, { origin: { kind: "sidecar", name: "Expression Detection", operation: "visible characters" } });

    return resolveDetectedCharacterNames(response.content || "", characterNames);
  } catch {
    // Let the caller fall back to explicit name mentions.
  }

  return null;
}

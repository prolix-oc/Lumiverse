import type { LlmMessage, GenerationResponse } from "../llm/types";
import * as connectionsSvc from "./connections.service";
import * as settingsSvc from "./settings.service";
import { getSidecarSettings } from "./sidecar-settings.service";

type RawGenerateFn = (userId: string, input: {
  provider: string;
  model: string;
  messages: LlmMessage[];
  connection_id: string;
  parameters?: Record<string, unknown>;
}) => Promise<GenerationResponse>;

interface DetectExpressionInput {
  userId: string;
  chatId: string;
  characterId: string;
  labels: string[];
  recentMessages: LlmMessage[];
  connectionId?: string;
  modelOverride?: string;
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
    const defaultConn = connectionsSvc.getDefaultConnection(userId);
    if (!defaultConn) return null;
    connectionId = defaultConn.id;
    model = model || defaultConn.model || undefined;
  }

  const conn = connectionsSvc.getConnection(userId, connectionId);
  if (!conn) return null;

  const systemPrompt = `Select a character sprite image. Read the LAST assistant message and choose the single available label that best matches the character's visible state in that moment.

Rules:
- Base your choice ONLY on the last assistant message, not the overall conversation.
- Treat labels as full sprite states, not just facial emotions. Outfit, pose, action, body position, and facial expression can all matter.
- Prefer the most specific matching label. Only choose a generic "neutral" or "default" state if no specific action/pose/expression label fits.
- Look for cues in dialogue tone, actions, body language, and narration.

Available expressions: ${labels.join(", ")}

Reply with ONLY one label from the list above, exactly as written.`;

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentMessages.slice(-5),
    { role: "user", content: "Which expression matches the character in the last message?" },
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
  });

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
  /** Which character group was identified as the focus. */
  characterGroup: string;
  /** The clean expression label (e.g., "Clothed_angry"). */
  expression: string;
  /** Resolved image ID for the expression. */
  imageId: string;
}

/**
 * Two-stage expression detection for multi-character cards:
 *
 * 1. **Character steering** — identify which character is the focus of the
 *    latest response via heuristic name matching, with LLM fallback.
 * 2. **Expression detection** — run standard expression detection scoped
 *    to the identified character's label set.
 */
export async function detectMultiCharacterExpression(
  input: DetectMultiCharExpressionInput,
  generateFn: RawGenerateFn,
): Promise<MultiCharExpressionResult | null> {
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
    return { characterGroup: "_default", expression: detected, imageId: defaultGroup[detected] };
  }

  // Stage 1: identify which character is the focus of the latest response
  let targetCharacter = identifyCharacterHeuristic(recentMessages, characterNames);

  // LLM fallback when heuristic is inconclusive (no names found in text)
  if (!targetCharacter) {
    targetCharacter = await identifyCharacterLLM(
      userId, characterNames, recentMessages, generateFn, input.connectionId, input.modelOverride,
    );
  }

  if (!targetCharacter || !groups[targetCharacter]) return null;

  // Stage 2: detect expression within the identified character's label set
  const groupLabels = groups[targetCharacter];
  const labels = Object.keys(groupLabels);
  if (labels.length === 0) return null;

  const detected = await detectExpression({ ...input, labels }, generateFn);
  if (!detected || !groupLabels[detected]) return null;

  return { characterGroup: targetCharacter, expression: detected, imageId: groupLabels[detected] };
}

/**
 * Fast heuristic: scan the last assistant message for character name mentions.
 * Returns the character whose name appears latest in the text (closest to the
 * end = most recently acting/speaking), or null if no names are found.
 */
function identifyCharacterHeuristic(
  recentMessages: LlmMessage[],
  characterNames: string[],
): string | null {
  // Find the last assistant message
  const lastAssistant = [...recentMessages].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant) return null;

  const content = typeof lastAssistant.content === "string" ? lastAssistant.content : "";
  if (!content) return null;

  const contentLower = content.toLowerCase();

  let latestPos = -1;
  let latestChar: string | null = null;

  for (const name of characterNames) {
    const pos = contentLower.lastIndexOf(name.toLowerCase());
    if (pos > latestPos) {
      latestPos = pos;
      latestChar = name;
    }
  }

  return latestChar;
}

/**
 * LLM-based character identification fallback. Uses a very short prompt
 * and low max_tokens to minimize cost when the heuristic can't determine
 * which character is the focus.
 */
async function identifyCharacterLLM(
  userId: string,
  characterNames: string[],
  recentMessages: LlmMessage[],
  generateFn: RawGenerateFn,
  connectionIdOverride?: string,
  modelOverride?: string,
): Promise<string | null> {
  const sidecar = getSidecarSettings(userId);

  let connectionId = connectionIdOverride || sidecar.connectionProfileId;
  let model: string | undefined = modelOverride || sidecar.model || undefined;

  if (!connectionId) {
    const defaultConn = connectionsSvc.getDefaultConnection(userId);
    if (!defaultConn) return null;
    connectionId = defaultConn.id;
    model = model || defaultConn.model || undefined;
  }

  const conn = connectionsSvc.getConnection(userId, connectionId);
  if (!conn) return null;

  const systemPrompt = `You are analyzing a roleplay conversation. Identify which character is the primary focus of the most recent response (the one speaking, acting, or being described).

Available characters: ${characterNames.join(", ")}

Respond with ONLY the character's name, exactly as listed above. Nothing else.`;

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentMessages.slice(-3),
    { role: "user", content: "Which character is the primary focus of the last response? Reply with only their name." },
  ];

  try {
    const response = await generateFn(userId, {
      provider: conn.provider,
      model: model || conn.model || "",
      messages,
      connection_id: connectionId,
      parameters: { temperature: 0.1, max_tokens: 30 },
    });

    const raw = (response.content || "").trim();
    if (!raw) return null;

    const rawLower = raw.toLowerCase();

    // Exact match
    const exact = characterNames.find((n) => n.toLowerCase() === rawLower);
    if (exact) return exact;

    // Response contains a character name
    const contains = characterNames.find((n) => rawLower.includes(n.toLowerCase()));
    if (contains) return contains;

    // Character name contains the response (handles partial/shortened names)
    const reverse = characterNames.find((n) => n.toLowerCase().includes(rawLower));
    if (reverse) return reverse;
  } catch {
    // LLM call failed — return null so expression detection is skipped
  }

  return null;
}

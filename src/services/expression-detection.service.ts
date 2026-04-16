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
}

/**
 * Lightweight sidecar call to detect the appropriate character expression
 * from the most recent messages. Returns the matched label or null.
 */
export async function detectExpression(input: DetectExpressionInput, generateFn: RawGenerateFn): Promise<string | null> {
  const { userId, labels, recentMessages } = input;
  if (labels.length === 0) return null;

  // Resolve sidecar connection from shared sidecar settings
  const sidecar = getSidecarSettings(userId);

  let connectionId = input.connectionId || sidecar.connectionProfileId;
  let model: string | undefined = sidecar.model || undefined;
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

  const systemPrompt = `You are a character expression analyst. Based on the recent conversation, determine which facial expression best represents the character's current emotional state.

Available expressions: ${labels.join(", ")}

Respond with ONLY one of the listed expression labels, exactly as written. Nothing else.`;

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...recentMessages.slice(-5),
    { role: "user", content: "Based on the conversation above, which expression label best matches the character's current emotional state? Respond with only the label." },
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

  const raw = (response.content || "").trim().toLowerCase();
  if (!raw) return null;

  // Exact match first
  const exactMatch = labels.find((l) => l.toLowerCase() === raw);
  if (exactMatch) return exactMatch;

  // Fuzzy: check if the response contains a label
  const containsMatch = labels.find((l) => raw.includes(l.toLowerCase()));
  if (containsMatch) return containsMatch;

  // Reverse fuzzy: check if any label contains the response
  const reverseMatch = labels.find((l) => l.toLowerCase().includes(raw));
  if (reverseMatch) return reverseMatch;

  return null;
}

export interface ExpressionDetectionSettings {
  mode: "auto" | "council" | "off";
  contextWindow: number;
}

export function getExpressionDetectionSettings(userId: string): ExpressionDetectionSettings {
  const setting = settingsSvc.getSetting(userId, "expressionDetection");
  if (!setting) return { mode: "auto", contextWindow: 5 };
  const val = setting.value as Partial<ExpressionDetectionSettings>;
  return {
    mode: val.mode ?? "auto",
    contextWindow: val.contextWindow ?? 5,
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
      userId, characterNames, recentMessages, generateFn, input.connectionId,
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
): Promise<string | null> {
  const sidecar = getSidecarSettings(userId);

  let connectionId = connectionIdOverride || sidecar.connectionProfileId;
  let model: string | undefined = sidecar.model || undefined;

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

import type { LlmMessage } from "../llm/types";
import { rawGenerate } from "./generate.service";
import * as connectionsSvc from "./connections.service";
import * as settingsSvc from "./settings.service";
import { getSidecarSettings } from "./sidecar-settings.service";

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
export async function detectExpression(input: DetectExpressionInput): Promise<string | null> {
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

  const response = await rawGenerate(userId, {
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

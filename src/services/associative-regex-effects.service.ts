import type { RegexActionEffect } from "../types/regex-script";
import { applyDisplayRegex } from "./display-regex.service";
import * as chatsSvc from "./chats.service";
import * as regexScriptsSvc from "./regex-scripts.service";

const ACTION_PAYLOAD_RE = /\bdata-lumiverse-regex-action="([^"]+)"/g;
const MAX_RESOLVED_STATE_VALUE_LENGTH = 10_000;

export type ResolveRegexActionEffectsResult =
  | { status: "resolved"; effects: RegexActionEffect[] }
  | { status: "not_found" | "user_source" | "unavailable" };

/**
 * Rebuild a rendered action from the stored assistant message and configured
 * display-regex pipeline. The browser supplies identifiers only; captured
 * state values never cross the trust boundary as claim input.
 */
export async function resolveRegexActionEffects(
  userId: string,
  chatId: string,
  messageId: string,
  scriptId: string,
  actionId: string,
  instanceId: string,
): Promise<ResolveRegexActionEffectsResult> {
  const chat = chatsSvc.getChat(userId, chatId);
  const source = chatsSvc.getMessage(userId, messageId);
  if (!chat || !source || source.chat_id !== chatId) return { status: "not_found" };

  const configuredScript = regexScriptsSvc.getRegexScript(userId, scriptId);
  const configuredAction = configuredScript?.actions.find((action) => action.id === actionId);
  if (!configuredScript || !configuredAction) return { status: "unavailable" };
  const configuredEffects = configuredAction?.effects ?? [];
  if (configuredEffects.length === 0) return { status: "resolved", effects: [] };
  if (source.is_user) return { status: "user_source" };
  if (
    configuredScript.disabled ||
    !configuredScript.target.includes("display") ||
    !configuredScript.placement.includes("ai_output")
  ) return { status: "unavailable" };

  const scripts = regexScriptsSvc.getActiveScripts(userId, {
    ...(chat.character_id ? { characterId: chat.character_id } : {}),
    chatId,
    target: "display",
  });
  if (!scripts.some((script) => script.id === configuredScript.id)) {
    return { status: "unavailable" };
  }

  const visibleMessages = chatsSvc.getMessages(userId, chatId)
    .filter((message) => !message.extra?._loom_inject);
  const messageIndex = visibleMessages.findIndex((message) => message.id === messageId);
  if (messageIndex < 0) return { status: "not_found" };
  const depth = visibleMessages.length - 1 - messageIndex;
  const rendered = await applyDisplayRegex({
    content: source.content,
    scripts,
    context: {
      chat_id: chatId,
      ...(chat.character_id ? { character_id: chat.character_id } : {}),
      is_user: false,
      role: "assistant",
      depth,
      message_id: messageId,
      message_index: messageIndex,
    },
    userId,
    dynamicMacros: { chat_index: String(messageIndex), role: "assistant" },
  });

  ACTION_PAYLOAD_RE.lastIndex = 0;
  for (const match of rendered.result.matchAll(ACTION_PAYLOAD_RE)) {
    try {
      const payload = JSON.parse(decodeURIComponent(match[1])) as {
        id?: unknown;
        scriptId?: unknown;
        instanceId?: unknown;
        effects?: unknown;
      };
      if (
        payload.id !== actionId ||
        payload.scriptId !== scriptId ||
        payload.instanceId !== instanceId ||
        !Array.isArray(payload.effects) ||
        payload.effects.length !== configuredEffects.length
      ) continue;

      const effects: RegexActionEffect[] = [];
      let valid = true;
      for (let index = 0; index < configuredEffects.length; index++) {
        const configured = configuredEffects[index];
        const resolved = payload.effects[index] as Record<string, unknown> | null;
        if (
          !resolved || resolved.type !== configured.type
        ) {
          valid = false;
          break;
        }
        if (configured.type === "set_state") {
          if (
            resolved.key !== configured.key ||
            typeof resolved.value !== "string" ||
            resolved.value.length > MAX_RESOLVED_STATE_VALUE_LENGTH
          ) {
            valid = false;
            break;
          }
          effects.push({ type: "set_state", key: configured.key, value: resolved.value });
        } else if (configured.type === "draft") {
          if (
            resolved.mode !== configured.mode ||
            typeof resolved.content !== "string" ||
            !resolved.content.trim() ||
            resolved.content.length > MAX_RESOLVED_STATE_VALUE_LENGTH
          ) {
            valid = false;
            break;
          }
          effects.push({ type: "draft", mode: configured.mode, content: resolved.content });
        } else {
          effects.push({ type: "fork" });
        }
      }
      if (valid) return { status: "resolved", effects };
    } catch {
      // Ignore malformed or unrelated decorated action attributes.
    }
  }

  return { status: "unavailable" };
}

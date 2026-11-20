import type { RegexActionEffect } from "../types/regex-script";
import { applyDisplayRegex } from "./display-regex.service";
import * as chatsSvc from "./chats.service";
import * as regexScriptsSvc from "./regex-scripts.service";
import { readMessagePresetContext } from "../types/preset-context";
import { regexActionSignature } from "../utils/regex-action-signature";

/** Check the effective source pipeline, including a message's inactive preset. */
export function getMessageDisplayScripts(userId: string, chatId: string, messageId: string) {
  const source = chatsSvc.getMessage(userId, messageId);
  const chat = chatsSvc.getChat(userId, chatId);
  if (!source || source.chat_id !== chatId || !chat) return [];
  const context = readMessagePresetContext(source.extra, source.swipe_id);
  const options = { chatId, ...(chat.character_id ? { characterId: chat.character_id } : {}), target: "display" as const };
  return context ? regexScriptsSvc.getActiveScriptsForPreset(userId, { ...options, presetId: context.preset_id })
    : regexScriptsSvc.getActiveScripts(userId, options);
}

const ACTION_PAYLOAD_RE = /\bdata-lumiverse-regex-action="([^"]+)"/g;
const MAX_RESOLVED_STATE_VALUE_LENGTH = 10_000;

export type ResolveRegexActionEffectsResult =
  | { status: "resolved"; effects: RegexActionEffect[]; instanceAliases: string[]; usageInstanceId?: string }
  | { status: "not_found" | "user_source" | "unavailable" };

/**
 * Rebuild a rendered action from the stored assistant message and configured
 * display-regex pipeline. An optional display signature disambiguates relocated
 * matches; every committed value still comes from the server's own replay.
 */
export async function resolveRegexActionEffects(
  userId: string,
  chatId: string,
  messageId: string,
  scriptId: string,
  actionId: string,
  instanceId: string,
  actionSignature?: string,
): Promise<ResolveRegexActionEffectsResult> {
  const chat = await chatsSvc.getChatAsync(userId, chatId);
  const source = chatsSvc.getMessage(userId, messageId);
  if (!chat || !source || source.chat_id !== chatId) return { status: "not_found" };

  const configuredScript = await regexScriptsSvc.getRegexScriptAsync(userId, scriptId);
  const configuredAction = configuredScript?.actions.find((action) => action.id === actionId);
  if (!configuredScript || !configuredAction) return { status: "unavailable" };
  const configuredEffects = configuredAction?.effects ?? [];
  if (configuredEffects.length > 0 && source.is_user) return { status: "user_source" };
  if (
    !configuredScript.target.includes("display") ||
    !configuredScript.placement.includes(source.is_user ? "user_input" : "ai_output")
  ) return { status: "unavailable" };

  const scripts = getMessageDisplayScripts(userId, chatId, messageId);
  if (!scripts.some((script) => script.id === configuredScript.id)) {
    return { status: "unavailable" };
  }

  const visibleMessages = chatsSvc.getMessages(userId, chatId)
    .filter((message) => !message.extra?._loom_inject);
  const messageIndex = visibleMessages.findIndex((message) => message.id === messageId);
  if (messageIndex < 0) return { status: "not_found" };
  const depth = visibleMessages.length - 1 - messageIndex;
  const presetContext = readMessagePresetContext(source.extra, source.swipe_id) ?? undefined;
  const verificationNonce = crypto.randomUUID();
  const replay = (context = presetContext) => applyDisplayRegex({
    content: source.swipes[source.swipe_id] ?? source.content,
    scripts,
    context: {
      chat_id: chatId,
      ...(chat.character_id ? { character_id: chat.character_id } : {}),
      is_user: source.is_user,
      role: source.is_user ? "user" : "assistant",
      depth,
      message_id: messageId,
      message_index: messageIndex,
    },
    userId,
    presetContext: context,
    actionVerificationNonce: verificationNonce,
    dynamicMacros: { chat_index: String(messageIndex), role: source.is_user ? "user" : "assistant" },
  });

  type Candidate = { instanceId: string; blockIndex: number; signature: string; effects: RegexActionEffect[] };
  const candidatesFrom = (html: string): Candidate[] => {
    const blocks = new Set<string>();
    const candidates: Omit<Candidate, "blockIndex">[] = [];
    for (const match of html.matchAll(new RegExp(ACTION_PAYLOAD_RE))) {
      try {
        const payload = JSON.parse(decodeURIComponent(match[1])) as {
          id?: unknown;
          scriptId?: unknown;
          instanceId?: unknown;
          effects?: unknown;
          type?: unknown;
          content?: unknown;
          title?: unknown;
          subtitle?: unknown;
          verificationNonce?: unknown;
        };
        if (payload.verificationNonce !== verificationNonce || payload.scriptId !== scriptId ||
          typeof payload.instanceId !== "string" || !payload.instanceId.startsWith(`${scriptId}:`)) continue;
        blocks.add(payload.instanceId);
        if (
          payload.id !== actionId ||
          payload.type !== configuredAction.type || typeof payload.content !== "string" ||
          typeof payload.title !== "string" || typeof payload.subtitle !== "string" ||
          (configuredEffects.length > 0 && !Array.isArray(payload.effects)) ||
          (Array.isArray(payload.effects) && payload.effects.length !== configuredEffects.length)
        ) continue;

        const effects: RegexActionEffect[] = [];
        let valid = true;
        for (let index = 0; index < configuredEffects.length; index++) {
          const configured = configuredEffects[index];
          const resolved = (payload.effects as unknown[])[index] as Record<string, unknown> | null;
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
        if (valid) candidates.push({
          instanceId: payload.instanceId,
          signature: regexActionSignature({ type: configuredAction.type, content: payload.content,
            title: payload.title, subtitle: payload.subtitle, effects }),
          effects,
        });
      } catch {
        // Ignore malformed or unrelated decorated action attributes.
      }
    }
    // Match order, rather than HTML order, also handles move_top/move_bottom scripts.
    const orderedBlocks = [...blocks].sort((a, b) => Number(a.slice(scriptId.length + 1).split(":")[0])
      - Number(b.slice(scriptId.length + 1).split(":")[0]));
    return candidates.map(candidate => ({ ...candidate, blockIndex: orderedBlocks.indexOf(candidate.instanceId) }));
  };
  const select = (candidates: Candidate[]) => {
    const matches = candidates.filter(candidate => actionSignature === undefined || candidate.signature === actionSignature);
    const exact = matches.find(candidate => candidate.instanceId === instanceId);
    if (exact) return exact;
    // Older clients cannot describe captured values. Relocate only constant effects
    // for them, and never guess between different source blocks.
    if (actionSignature === undefined && configuredEffects.some(effect =>
      effect.type !== "fork" && /\$|\{\{|<(?:user|char|bot)>/i.test(effect.type === "set_state" ? effect.value : effect.content))) return;
    const distinct = new Map(matches.map(candidate => [candidate.instanceId, candidate]));
    if (distinct.size === 1) return distinct.values().next().value;
  };
  const primary = candidatesFrom((await replay()).result);
  let selected = select(primary);
  if (!selected && presetContext?.variables && actionSignature !== undefined) {
    // Older extension resolvers still use live variables. Keep the source preset's
    // definitions, and require the displayed signature to match this replay too.
    selected = select(candidatesFrom((await replay({ preset_id: presetContext.preset_id })).result));
  }
  if (selected) return {
    status: "resolved", effects: selected.effects,
    usageInstanceId: `${scriptId}:match:${selected.blockIndex}`,
    instanceAliases: [...new Set([
      selected.instanceId,
      ...primary.filter(candidate => candidate.blockIndex === selected.blockIndex).map(candidate => candidate.instanceId),
    ])],
  };
  return { status: "unavailable" };
}

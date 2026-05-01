import { cloneEnv, evaluate, initMacros, registry, type MacroEnv } from "../macros";
import type { Message } from "../types/message";
import { healFormattingArtifacts } from "../utils/format-healing";
import * as chatsSvc from "./chats.service";

const HAS_MACRO_RE = /\{\{|<(?:user|char|bot)>/i;

interface ReconcileChatMessageMacrosInput {
  userId: string;
  chatId: string;
  messageIds: string[];
  macroEnvSeed?: MacroEnv;
  persistVariables?: boolean;
}

interface ResolveRenderedChatMessagesInput {
  messages: Message[];
  messageIds: string[];
  macroEnvSeed?: MacroEnv;
}

export async function resolveRenderedChatMessages(
  input: ResolveRenderedChatMessagesInput,
): Promise<{
  resolvedById: Map<string, string>;
  localVariables?: Record<string, string>;
  globalVariables?: Record<string, string>;
  chatVariables?: Record<string, string>;
}> {
  const targetIds = [...new Set(input.messageIds.filter(Boolean))];
  const resolvedById = new Map<string, string>();
  if (!input.macroEnvSeed || targetIds.length === 0) return { resolvedById };

  const targetSet = new Set(targetIds);
  let lastTargetIdx = -1;
  let shouldReplay = false;
  for (let i = 0; i < input.messages.length; i++) {
    if (!targetSet.has(input.messages[i].id)) continue;
    lastTargetIdx = i;
    if (HAS_MACRO_RE.test(input.messages[i].content)) shouldReplay = true;
  }
  if (lastTargetIdx < 0 || !shouldReplay) return { resolvedById };

  initMacros();
  const env = cloneEnv(input.macroEnvSeed);

  for (let i = 0; i <= lastTargetIdx; i++) {
    const message = input.messages[i];
    if (message.extra?.hidden === true) continue;
    const resolved = HAS_MACRO_RE.test(message.content)
      ? healFormattingArtifacts((await evaluate(message.content, env, registry)).text)
      : message.content;
    if (targetSet.has(message.id)) {
      resolvedById.set(message.id, resolved);
    }
  }

  return {
    resolvedById,
    localVariables: Object.fromEntries(env.variables.local),
    globalVariables: Object.fromEntries(env.variables.global),
    chatVariables: Object.fromEntries(env.variables.chat),
  };
}

export async function resolveRenderedMessageContent(
  content: string,
  env: MacroEnv,
): Promise<string> {
  if (!HAS_MACRO_RE.test(content)) return content;
  initMacros();
  return healFormattingArtifacts((await evaluate(content, env, registry)).text);
}

export function persistMacroVariableState(
  userId: string,
  chatId: string,
  env: MacroEnv,
): void {
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) return;
  const macroVariables = {
    ...((chat.metadata?.macro_variables as Record<string, unknown>) || {}),
    local: Object.fromEntries(env.variables.local),
    global: Object.fromEntries(env.variables.global),
  };
  chatsSvc.mergeChatMetadata(userId, chatId, {
    macro_variables: macroVariables,
    chat_variables: Object.fromEntries(env.variables.chat),
  });
}

export async function reconcileChatMessageMacros(
  input: ReconcileChatMessageMacrosInput,
): Promise<Map<string, string>> {
  const messages = chatsSvc.getMessages(input.userId, input.chatId);
  if (messages.length === 0) return new Map<string, string>();

  const {
    resolvedById,
    localVariables,
    globalVariables,
    chatVariables,
  } = await resolveRenderedChatMessages({
    messages,
    messageIds: input.messageIds,
    macroEnvSeed: input.macroEnvSeed,
  });

  for (const [messageId, resolved] of resolvedById) {
    const existing = chatsSvc.getMessage(input.userId, messageId);
    if (!existing || existing.content === resolved) continue;
    chatsSvc.updateMessage(input.userId, messageId, { content: resolved });
  }

  if (input.persistVariables !== false && localVariables && globalVariables && chatVariables) {
    const chat = chatsSvc.getChat(input.userId, input.chatId);
    const macroVariables = {
      ...((chat?.metadata?.macro_variables as Record<string, unknown>) || {}),
      local: localVariables,
      global: globalVariables,
    };
    chatsSvc.mergeChatMetadata(input.userId, input.chatId, {
      macro_variables: macroVariables,
      chat_variables: chatVariables,
    });
  }

  return resolvedById;
}

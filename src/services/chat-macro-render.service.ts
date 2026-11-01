import { cloneEnv, evaluate, initMacros, registry, type MacroEnv } from "../macros";
import { withJsonBlocksProtected } from "../macros/json-blocks";
import { captureMessageLiterals, shieldMessageLiterals, withMessageLiteralExtra } from "../macros/message-literals";
import type { DisplayMessageSource, Message } from "../types/message";
import { healFormattingArtifacts } from "../utils/format-healing";
import * as chatsSvc from "./chats.service";
import { contentHasMacroHints } from "./vectorization-content.service";
import { createWorldInfoEntriesLoaderForChat, getActivatedWorldInfoEntriesForChat, resolveWorldInfoOutlets } from "./prompt-assembly.service";
import { getPreset } from "./presets.service";
import { applyMessagePresetContext } from "./message-preset-context.service";
import { readMessagePresetContext, type MessagePresetContext } from "../types/preset-context";

const HAS_MACRO_RE = /\{\{|<(?:user|char|bot)>/i;
const OUTLET_MACRO_RE = /\{\{(?:outlet|persona_outlet|personaoutlet)::/i;

/** Request-local read snapshots. Each message still gets independent mutable macro state. */
export function createDisplayRenderContext(userId: string, chatId: string) {
  let seed: MacroEnv | null | undefined;
  const presets = new Map<string, ReturnType<typeof getPreset>>();
  return {
    getEnv: () => {
      if (seed === undefined) seed = chatsSvc.buildMacroEnvForChat(userId, chatId);
      if (!seed) return null;
      const env = cloneEnv(seed);
      env.extra = structuredClone(seed.extra);
      if (seed.character.alternateGreetings) env.character.alternateGreetings = [...seed.character.alternateGreetings];
      return env;
    },
    getPreset: (ownerId: string, id: string) => {
      if (!presets.has(id)) presets.set(id, getPreset(ownerId, id));
      return presets.get(id)!;
    },
    getWorldInfoEntries: createWorldInfoEntriesLoaderForChat(userId, chatId),
  };
}

export type DisplayRenderContext = ReturnType<typeof createDisplayRenderContext>;

/** Share the displayed body with server-side verification of rendered choices. */
export async function resolveDisplayMessageBody(
  userId: string,
  chatId: string,
  content: string,
  message?: DisplayMessageSource,
  swipeIndex = message?.swipe_id ?? 0,
  signal?: AbortSignal,
  presetContextOverride?: MessagePresetContext,
  context?: DisplayRenderContext,
): Promise<string> {
  const source = message?.chat_id === chatId ? message : undefined;
  const presetContext = presetContextOverride ?? readMessagePresetContext(source?.extra, swipeIndex);
  if (source) content = shieldMessageLiterals(content, source);
  if (!contentHasMacroHints(content)) return content;
  const env = context ? context.getEnv() : chatsSvc.buildMacroEnvForChat(userId, chatId);
  if (!env || (presetContext && !applyMessagePresetContext(env, userId, presetContext, context?.getPreset))) return content;
  if (OUTLET_MACRO_RE.test(content)) {
    try {
      const entries = await (context ? context.getWorldInfoEntries() : getActivatedWorldInfoEntriesForChat(userId, chatId));
      await resolveWorldInfoOutlets(entries, env, signal);
    } catch {
      // Leave outlets unresolved; other display macros can still resolve.
    }
  }
  return resolveRenderedMessageContent(content, env, true);
}

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
  literalBracesById: Map<string, number[]>;
  globalVariables?: Record<string, string>;
  chatVariables?: Record<string, string>;
}> {
  const targetIds = [...new Set(input.messageIds.filter(Boolean))];
  const resolvedById = new Map<string, string>();
  const literalBracesById = new Map<string, number[]>();
  if (!input.macroEnvSeed || input.macroEnvSeed.extra.preserveMessageSource || targetIds.length === 0) return { resolvedById, literalBracesById };

  const targetSet = new Set(targetIds);
  let lastTargetIdx = -1;
  let shouldReplay = false;
  for (let i = 0; i < input.messages.length; i++) {
    if (!targetSet.has(input.messages[i].id)) continue;
    lastTargetIdx = i;
    if (HAS_MACRO_RE.test(input.messages[i].content)) shouldReplay = true;
  }
  if (lastTargetIdx < 0 || !shouldReplay) return { resolvedById, literalBracesById };

  initMacros();
  const env = cloneEnv(input.macroEnvSeed);

  for (let i = 0; i <= lastTargetIdx; i++) {
    const message = input.messages[i];
    if (message.extra?.hidden === true) continue;
    const source = shieldMessageLiterals(message.content, message);
    const rendered = HAS_MACRO_RE.test(message.content)
      ? await resolveMessageMacroContent(source, env)
      : captureMessageLiterals(source);
    if (targetSet.has(message.id)) {
      resolvedById.set(message.id, rendered.content);
      literalBracesById.set(message.id, rendered.literalBraces);
    }
  }

  return {
    resolvedById,
    literalBracesById,
    globalVariables: Object.fromEntries(env.variables.global),
    chatVariables: Object.fromEntries(env.variables.chat),
  };
}

export async function resolveRenderedMessageContent(
  content: string,
  env: MacroEnv,
  deferLiteralBraceRestore = false,
): Promise<string> {
  const rendered = await resolveMessageMacroContent(content, env);
  return deferLiteralBraceRestore ? rendered.template : rendered.content;
}

/** Keep literal positions until the caller has persisted the message's provenance. */
export async function resolveMessageMacroContent(content: string, env: MacroEnv) {
  if (env.extra.preserveMessageSource) return { content, template: content, literalBraces: [] as number[] };
  const template = await resolveMessageMacroTemplate(content, env);
  return { ...captureMessageLiterals(template), template };
}

async function resolveMessageMacroTemplate(content: string, env: MacroEnv): Promise<string> {
  if (env.extra.preserveMessageSource || !HAS_MACRO_RE.test(content)) return content;
  initMacros();
  return withJsonBlocksProtected(content, env, async (protectedContent) =>
    healFormattingArtifacts((await evaluate(protectedContent, env, registry, { deferLiteralBraceRestore: true })).text),
  );
}

export function buildPersistedMacroVariables(
  existingMacroVars: Record<string, unknown>,
  incomingGlobal: Record<string, string>,
): Record<string, unknown> {
  const existingGlobal = (existingMacroVars.global as Record<string, string> | undefined) ?? {};
  return {
    ...existingMacroVars,
    global: { ...existingGlobal, ...incomingGlobal },
  };
}

export function persistMacroVariableState(
  userId: string,
  chatId: string,
  env: MacroEnv,
): void {
  const chat = chatsSvc.getChat(userId, chatId);
  if (!chat) return;

  const existingMacroVars = (chat.metadata?.macro_variables as Record<string, unknown> | undefined) ?? {};
  const existingChatVars = (chat.metadata?.chat_variables as Record<string, string> | undefined) ?? {};
  chatsSvc.mergeChatMetadata(userId, chatId, {
    macro_variables: buildPersistedMacroVariables(existingMacroVars, Object.fromEntries(env.variables.global)),
    chat_variables: { ...existingChatVars, ...Object.fromEntries(env.variables.chat) },
  });
}

export async function persistMacroVariableStateAsync(
  userId: string,
  chatId: string,
  env: MacroEnv,
  source?: { messageId: string; stateId: string },
): Promise<void> {
  await mergeMacroVariables(userId, chatId, Object.fromEntries(env.variables.global), Object.fromEntries(env.variables.chat), source);
}

async function mergeMacroVariables(
  userId: string,
  chatId: string,
  globalVariables: Record<string, string>,
  chatVariables: Record<string, string>,
  source?: { messageId: string; stateId: string },
): Promise<void> {
  // Read and merge in the child transaction so concurrent extension keys survive.
  await chatsSvc.mergeChatMetadataAsync(userId, chatId, {
    macro_variables: { global: globalVariables },
    chat_variables: chatVariables,
  }, { mergeObjectPaths: [["macro_variables", "global"], ["chat_variables"]],
    ...(source ? { variableSource: { ...source, values: { global: globalVariables, chat: chatVariables }, replaceScopes: ["global", "chat"] } } : {}),
  });
}

export async function reconcileChatMessageMacros(
  input: ReconcileChatMessageMacrosInput,
): Promise<Map<string, string>> {
  const messages = chatsSvc.getMessages(input.userId, input.chatId);
  if (messages.length === 0) return new Map<string, string>();

  const {
    resolvedById,
    literalBracesById,
    globalVariables,
    chatVariables,
  } = await resolveRenderedChatMessages({
    messages,
    messageIds: input.messageIds,
    macroEnvSeed: input.macroEnvSeed,
  });

  for (const [messageId, resolved] of resolvedById) {
    const existing = chatsSvc.getMessage(input.userId, messageId);
    if (!existing) continue;
    const extra = withMessageLiteralExtra(existing.extra, {
      content: resolved, literalBraces: literalBracesById.get(messageId) ?? [],
    });
    if (existing.content === resolved && JSON.stringify(extra) === JSON.stringify(existing.extra)) continue;
    chatsSvc.updateMessage(input.userId, messageId, { content: resolved, extra });
  }

  if (input.persistVariables !== false && globalVariables && chatVariables) {
    await mergeMacroVariables(input.userId, input.chatId, globalVariables, chatVariables);
  }

  return resolvedById;
}

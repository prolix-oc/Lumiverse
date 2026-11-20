import { buildEnv, initMacros, mergeDynamicMacros, resolveGroupCharacterNames } from "../macros";
import type { MacroEnv } from "../macros";
import { getEffectiveCharacterName, makeAssistantCharacter } from "../types/character";
import type { Chat } from "../types/chat";
import { isTemporaryChatMetadata } from "../types/chat";
import type { RegexPlacement, RegexScript } from "../types/regex-script";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as connectionsSvc from "./connections.service";
import * as personasSvc from "./personas.service";
import { resolvePersonaForChatMacros } from "./persona-addon-states";
import { populateLumiaLoomContext } from "./prompt-assembly.service";
import { applyRegexScripts, hasRegexMatchAction } from "./regex-scripts.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { readPromptActivation } from "../utils/regex-prompt-activation";
import type { MessagePresetContext } from "../types/preset-context";
import { applyMessagePresetContext } from "./message-preset-context.service";
import { createHash } from "node:crypto";
import { preprocessDisplayMessage } from "./display-message-preprocess.service";
import { presetHistoryDependencyValue } from "./preset-history.service";

initMacros();

export interface DisplayRegexContext {
  chat_id?: string;
  character_id?: string;
  persona_id?: string;
  is_user: boolean;
  depth: number;
  message_id?: string;
  message_index?: number;
  role?: "user" | "assistant" | "system";
}

export interface ApplyDisplayRegexInput {
  content: string;
  scripts: RegexScript[];
  context: DisplayRegexContext;
  userId: string;
  resolvedFindPatterns?: Map<string, string>;
  resolvedReplacements?: Map<string, string>;
  dynamicMacros?: Record<string, string>;
  signal?: AbortSignal;
  /** Server-validated context from the stored message, never a client-selected preset. */
  presetContext?: MessagePresetContext;
  preprocessed?: boolean;
  /** Internal verification replay: mark only actions minted by this execution. */
  actionVerificationNonce?: string;
}

function buildEnvFromContext(userId: string, ctx: DisplayRegexContext): MacroEnv | undefined {
  if (ctx.chat_id) {
    const chat = chatsSvc.getChat(userId, ctx.chat_id);
    if (chat) {
      const messages = chatsSvc.getMessages(userId, ctx.chat_id);
      const isGroup = !!chat.metadata?.group;
      const groupCharacterIds =
        isGroup && Array.isArray(chat.metadata?.character_ids)
          ? (chat.metadata.character_ids as string[])
          : [];
      const targetCharacterId =
        isGroup &&
        typeof ctx.character_id === "string" &&
        groupCharacterIds.includes(ctx.character_id)
          ? ctx.character_id
          : undefined;
      const defaultCharacter = chat.character_id
        ? charactersSvc.getCharacter(userId, chat.character_id)
        : makeAssistantCharacter();
      const focusedCharacter = targetCharacterId
        ? charactersSvc.getCharacter(userId, targetCharacterId) ?? defaultCharacter
        : defaultCharacter;
      const character = focusedCharacter;
      if (character) {
        const persona = isTemporaryChatMetadata(chat.metadata)
          ? null
          : resolvePersonaForChatMacros(
              userId,
              personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id),
              chat.metadata,
            );
        const connection = connectionsSvc.resolveConnection(userId);
        const groupCharacterNames = resolveGroupCharacterNames(chat, (cid) => {
          const c = charactersSvc.getCharacter(userId, cid);
          return c ? getEffectiveCharacterName(c) : undefined;
        });
        const env = buildEnv({
          userId,
          character,
          focusedCharacter,
          persona,
          chat,
          messages,
          generationType: "normal",
          connection,
          groupCharacterNames,
          targetCharacterId,
          targetCharacterName: isGroup ? getEffectiveCharacterName(character) : undefined,
        });
        populateLumiaLoomContext(env, userId, chat);
        return env;
      }
    }
  }

  if (ctx.character_id) {
    const character = charactersSvc.getCharacter(userId, ctx.character_id);
    if (character) {
      // No chat context here, so there are no per-chat add-on bindings to apply.
      const persona = resolvePersonaForChatMacros(
        userId,
        personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id),
        null,
      );
      const connection = connectionsSvc.resolveConnection(userId);
      const chat: Chat = {
        id: "",
        character_id: character.id,
        name: "",
        metadata: {},
        created_at: 0,
        updated_at: 0,
      };
      const env = buildEnv({
        character,
        persona,
        chat,
        messages: [],
        generationType: "normal",
        connection,
      });
      populateLumiaLoomContext(env, userId, chat);
      return env;
    }
  }

  const persona = resolvePersonaForChatMacros(
    userId,
    personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id),
    null,
  );
  const connection = connectionsSvc.resolveConnection(userId);
  const chat: Chat = {
    id: "",
    character_id: null,
    name: "",
    metadata: {},
    created_at: 0,
    updated_at: 0,
  };
  return buildEnv({
    character: makeAssistantCharacter(),
    persona,
    chat,
    messages: [],
    generationType: "normal",
    connection,
  });
}

export interface ApplyDisplayRegexResult {
  result: string;
  touchedVars: ReadonlySet<string>;
  cacheable: boolean;
  /** Scripts independently stopped by the backend sandbox watchdog. */
  timedOutScriptIds: ReadonlySet<string>;
}

function getDisplayBehaviorContext(
  userId: string,
  context: DisplayRegexContext,
): { previousContent?: string } {
  if (!context.chat_id) return {};
  const message = context.message_id
    ? chatsSvc.getMessage(userId, context.message_id)
    : undefined;
  const messageIndex = message?.index_in_chat ?? context.message_index;
  if (typeof messageIndex !== "number" || messageIndex <= 0) {
    return {};
  }
  const isUser = context.role
    ? context.role === "user"
    : message?.is_user ?? context.is_user;
  const previousContent = chatsSvc.getPreviousSameRoleContent(
    userId,
    context.chat_id,
    isUser,
    context.message_id,
  );
  return {
    ...(previousContent !== undefined ? { previousContent } : {}),
  };
}

type DisplayVarEnv = MacroEnv | null | undefined;

const DISPLAY_REGEX_CACHE = new Map<string, { result: string; touched: ReadonlyArray<readonly [string, string]> }>();
const DISPLAY_REGEX_CACHE_MAX = 1000;
const presetScriptDigests = new WeakMap<RegexScript[], string>();

function presetScriptDigest(scripts: RegexScript[]): string {
  let digest = presetScriptDigests.get(scripts);
  if (!digest) {
    digest = createHash("sha256").update(JSON.stringify(scripts)).digest("hex");
    presetScriptDigests.set(scripts, digest);
  }
  return digest;
}

function presetRenderDigest(input: ApplyDisplayRegexInput, env: MacroEnv | undefined): string {
  // Prompt defaults and selections live outside the variable maps tracked by the evaluator.
  return createHash("sha256").update(JSON.stringify([
    input.userId, input.context.message_id, input.presetContext,
    env?.extra.presetMetadata, env?.extra.promptVariables,
    env?.extra.promptVariableDefaults, env?.extra.promptVariableSelections,
  ])).digest("hex");
}

function varStateForKey(env: DisplayVarEnv, name: string): string {
  if (!env) return "";
  const context = presetHistoryDependencyValue(env, name);
  if (context !== undefined) return context;
  const v = env.variables;
  const sep = name.indexOf(":");
  if (sep > 0) {
    const scope = name.slice(0, sep);
    const bare = name.slice(sep + 1);
    const map = scope === "local" ? v.local : scope === "chat" ? v.chat : scope === "global" ? v.global : null;
    if (map) return String(map.get(bare) ?? "");
  }
  return `${v.local.get(name) ?? ""}${v.chat.get(name) ?? ""}${v.global.get(name) ?? ""}`;
}

function displayRegexCacheKey(
  chatId: string | undefined,
  content: string,
  placement: RegexPlacement,
  depth: number | undefined,
  scripts: ReadonlyArray<{ id: string; updated_at: number }>,
  dynamicMacros: Record<string, string> | undefined,
  resolvedFind?: ReadonlyMap<string, string>,
  resolvedReplace?: ReadonlyMap<string, string>,
): string {
  const SEP = "\x00";
  let k = (chatId ?? "") + SEP + content + SEP + placement + SEP + (depth ?? "") + SEP;
  for (const s of scripts) k += s.id + ":" + s.updated_at + ";";
  if (dynamicMacros) { k += SEP + "D"; for (const a of Object.keys(dynamicMacros).sort()) k += a + "=" + dynamicMacros[a] + ";"; }
  if (resolvedFind) { k += SEP + "F"; for (const [a, b] of resolvedFind) k += a + "=" + b + ";"; }
  if (resolvedReplace) { k += SEP + "R"; for (const [a, b] of resolvedReplace) k += a + "=" + b + ";"; }
  return k;
}

export function resetDisplayRegexCache(): void {
  DISPLAY_REGEX_CACHE.clear();
}

export function invalidateDisplayRegexCacheForChat(chatId: string): void {
  if (!chatId) { DISPLAY_REGEX_CACHE.clear(); return; }
  const prefix = chatId + "\x00";
  for (const key of DISPLAY_REGEX_CACHE.keys()) {
    if (key.startsWith(prefix)) DISPLAY_REGEX_CACHE.delete(key);
  }
}

for (const __ev of [
  EventType.CHAT_CHANGED, EventType.CHAT_SWITCHED, EventType.CHAT_DELETED,
  EventType.MESSAGE_SENT, EventType.MESSAGE_EDITED, EventType.MESSAGE_DELETED, EventType.MESSAGE_SWIPED,
  EventType.GENERATION_ENDED, EventType.GENERATION_STOPPED,
]) {
  eventBus.on(__ev, (msg) => {
    const p = (msg as { payload?: { chatId?: string; chat_id?: string; chat?: { id?: string } } }).payload;
    const cid = p?.chatId ?? p?.chat_id ?? p?.chat?.id;
    if (cid) invalidateDisplayRegexCacheForChat(cid);
    else DISPLAY_REGEX_CACHE.clear();
  });
}

for (const __ev of [
  EventType.CHARACTER_EDITED, EventType.PERSONA_CHANGED,
  EventType.REGEX_SCRIPT_CHANGED, EventType.REGEX_SCRIPT_DELETED,
]) {
  eventBus.on(__ev, () => { DISPLAY_REGEX_CACHE.clear(); });
}

export async function applyDisplayRegex(input: ApplyDisplayRegexInput): Promise<ApplyDisplayRegexResult> {
  const placement: RegexPlacement = input.context.is_user ? "user_input" : "ai_output";

  let content = input.content;
  const fingerprint = { touchedVars: new Set<string>(), cacheable: true };
  if (!input.preprocessed && input.context.chat_id) {
    const source = input.context.message_id ? chatsSvc.getMessage(input.userId, input.context.message_id) : null;
    const processed = await preprocessDisplayMessage({
      userId: input.userId, chatId: input.context.chat_id, content, message: source ?? undefined,
      messageId: input.context.message_id, messageIndex: input.context.message_index,
      role: input.context.role ?? (input.context.is_user ? "user" : "assistant"),
      presetContext: input.presetContext, signal: input.signal,
    });
    content = processed.content;
    for (const key of processed.touchedVars) fingerprint.touchedVars.add(key);
    if (!processed.cacheable) fingerprint.cacheable = false;
  }

  const env = buildEnvFromContext(input.userId, input.context);
  if (input.presetContext && (!env || !applyMessagePresetContext(env, input.userId, input.presetContext))) {
    return { result: content, touchedVars: new Set(), cacheable: false, timedOutScriptIds: new Set() };
  }
  const dyn: Record<string, string> = { ...(input.dynamicMacros ?? {}) };
  if (env) {
    env.extra.activationPreviewContext = {
      chat_id: input.context.chat_id, character_id: input.context.character_id, persona_id: input.context.persona_id,
    };
    if (input.context.role && dyn.role === undefined) {
      dyn.role = input.context.role;
    }
    const lastMsgId = (env.chat as { lastMessageId?: number } | undefined)?.lastMessageId;
    if (typeof lastMsgId === "number" && typeof input.context.depth === "number") {
      dyn.chat_index = String(lastMsgId - input.context.depth);
    }
    if (Object.keys(dyn).length > 0) {
      mergeDynamicMacros(env, dyn);
    }
  }
  const noCache = !fingerprint.cacheable || !!input.actionVerificationNonce
    || input.scripts.some((script) => script.preset_id && readPromptActivation(script.metadata) && script.find_regex.includes("{{"))
    || (globalThis as { Bun?: { env?: Record<string, string | undefined> } }).Bun?.env?.LUMIVERSE_DISPLAY_REGEX_NO_CACHE === "1";
  const cacheKey = displayRegexCacheKey(input.context.chat_id, content, placement, input.context.depth, input.scripts, dyn, input.resolvedFindPatterns, input.resolvedReplacements)
    // Preset edits can share a one-second updated_at value; retain the exact definition identity.
    + (input.presetContext ? `\x00P${presetScriptDigest(input.scripts)}:${presetRenderDigest(input, env)}` : "");
  if (!noCache) {
    const cached = DISPLAY_REGEX_CACHE.get(cacheKey);
    if (cached && (env ? cached.touched.every(([n, val]) => varStateForKey(env, n) === val) : cached.touched.length === 0)) {
      return {
        result: cached.result,
        touchedVars: new Set([...cached.touched.map(([n]) => n), ...fingerprint.touchedVars]),
        cacheable: true,
        timedOutScriptIds: new Set(),
      };
    }
  }

  const timedOutScriptIds = new Set<string>();
  const hasRepeatBack = hasRegexMatchAction(input.scripts, "repeat_back");
  const behaviorContext = hasRepeatBack
    ? getDisplayBehaviorContext(input.userId, input.context)
    : undefined;
  const result = await applyRegexScripts(
    content,
    input.actionVerificationNonce ? input.scripts.map(script => ({
      ...script,
      actions: script.actions.map(action => ({ ...action, verificationNonce: input.actionVerificationNonce })),
    })) : input.scripts,
    placement,
    input.context.depth,
    env,
    {
      resolvedFindPatterns: input.resolvedFindPatterns,
      resolvedReplacements: input.resolvedReplacements,
    },
    {
      source: "display_backend",
      outFingerprint: fingerprint,
      onPerformanceIssue: (issue) => {
        if (issue.timedOut) timedOutScriptIds.add(issue.scriptId);
      },
      ...(behaviorContext ?? {}),
    },
  );
  if (!noCache && fingerprint.cacheable) {
    DISPLAY_REGEX_CACHE.set(cacheKey, {
      result,
      touched: [...fingerprint.touchedVars].map((n) => [n, varStateForKey(env, n)] as const),
    });
    if (DISPLAY_REGEX_CACHE.size > DISPLAY_REGEX_CACHE_MAX) {
      const first = DISPLAY_REGEX_CACHE.keys().next().value;
      if (first !== undefined) DISPLAY_REGEX_CACHE.delete(first);
    }
  }
  return {
    result,
    touchedVars: fingerprint.touchedVars,
    cacheable: fingerprint.cacheable,
    timedOutScriptIds,
  };
}
